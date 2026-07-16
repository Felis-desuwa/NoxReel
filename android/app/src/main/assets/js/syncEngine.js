import { Emitter } from './emitter.js';
import { MSG } from './protocol.js';

/**
 * 同步引擎。管两件事：
 *
 * 1) 播放状态一致：任何人按暂停/播放/拖进度条，全员跟随。
 * 2) 缓冲联动（本产品的核心差异点）：谁的数据没下够，全员停下等他。
 *
 * ── 为什么需要 (2) ──
 * 「Syncplay + 网盘」的组合里，每个人得先各自把文件下完才能开始，
 * 或者谁网慢谁自己卡成幻灯片、然后不断手动对时间。
 * 这里把「缓冲不足」变成一个房间级别的状态：任何一个人的连续水位线快要
 * 追不上他的播放位置了，就广播 stall，所有人一起暂停；等他缓过来，一起恢复。
 *
 * ── 关于「连续水位线」──
 * 播放器只能安全读到 contiguousBytes 为止，再往后是没下到的空洞（读出来是 0）。
 * 所以判断依据是 contiguousBytes - 播放字节位置，而不是「下载百分比」——
 * 下了 90% 但第 2 片缺着，照样一秒都播不了。
 *
 * ── 冲突处理 ──
 * 无主结构，谁都能发起。用 Lamport 逻辑时钟定序，时钟相同就比 peerId，
 * 保证所有人最终收敛到同一个状态，不会两边互相打架。
 */

const STALL_THRESHOLD_SECONDS = 5; // 身前不足 5 秒的连续数据 → 喊停
const RESUME_THRESHOLD_SECONDS = 15; // 攒够 15 秒才恢复，滞后量拉开避免反复横跳
const FALLBACK_STALL_BYTES = 4 * 1024 * 1024;
const FALLBACK_RESUME_BYTES = 16 * 1024 * 1024;
const SEEK_TOLERANCE = 0.75; // 差这么多秒以内就不去动播放器了，免得抖
const SEEK_DETECT_JUMP = 1.5; // 时间线跳变超过这个数，判定是用户拖了进度条

export class SyncEngine extends Emitter {
  constructor({ peerId, name, isSeeder }) {
    super();
    this.peerId = peerId;
    this.name = name;
    this.isSeeder = isSeeder;

    // 房间共识状态
    this.shared = { paused: true, position: 0, lamport: 0, by: peerId };

    // 我方本地状态
    this.localStalled = false;
    this.stalledPeers = new Map(); // peerId -> {name, position, deficitSeconds}
    this.intendedPaused = true; // 撇开 stall，用户真正想要的状态

    this.applying = false; // 正在把远端状态落到 mpv，别把它当成用户操作
    this.lastTick = null;
    this.duration = 0;
    this.bytesPerSecond = 0;
    this.started = false;
  }

  setMediaInfo({ duration, size }) {
    if (duration > 0) {
      this.duration = duration;
      if (size) this.bytesPerSecond = size / duration;
    }
  }

  get stallThresholdBytes() {
    return this.bytesPerSecond ? this.bytesPerSecond * STALL_THRESHOLD_SECONDS : FALLBACK_STALL_BYTES;
  }

  get resumeThresholdBytes() {
    return this.bytesPerSecond ? this.bytesPerSecond * RESUME_THRESHOLD_SECONDS : FALLBACK_RESUME_BYTES;
  }

  /** 有人卡着就必须暂停，跟用户想不想播无关。 */
  get anyoneStalled() {
    return this.localStalled || this.stalledPeers.size > 0;
  }

  get effectivePaused() {
    return this.intendedPaused || this.anyoneStalled;
  }

  _bump() {
    this.shared.lamport++;
    return this.shared.lamport;
  }

  /* -------------------------- 本地播放器事件 -------------------------- */

  /**
   * mpv 每次属性变化都会调到这里。
   * 这里要分辨出「用户自己动的」和「我们刚才设进去的」，只有前者才需要广播。
   */
  onMpvTick(snap, { contiguousBytes, complete }) {
    const prev = this.lastTick;
    this.lastTick = { ...snap, at: performance.now() };

    if (snap.duration && !this.duration) {
      this.setMediaInfo({ duration: snap.duration, size: this.sizeHint });
      this.emit('duration', snap.duration);
    }

    this._evaluateStall(snap, { contiguousBytes, complete });

    if (this.applying || !this.started) return;

    // 用户按了暂停/播放？
    if (prev && snap.paused !== prev.paused) {
      const shouldBePaused = this.effectivePaused;
      if (snap.paused !== shouldBePaused) {
        this.intendedPaused = snap.paused;
        this._broadcastSync(snap.position);
        this.emit('local-action', { kind: snap.paused ? 'pause' : 'play', position: snap.position });
      }
    }

    // 用户拖了进度条？mpv 没有独立的 seek 事件，只能看时间线有没有不连续跳变。
    if (prev && typeof snap.position === 'number' && typeof prev.position === 'number') {
      const elapsed = (this.lastTick.at - prev.at) / 1000;
      const expected = prev.paused ? prev.position : prev.position + elapsed;
      if (Math.abs(snap.position - expected) > SEEK_DETECT_JUMP) {
        this._broadcastSync(snap.position);
        this.emit('local-action', { kind: 'seek', position: snap.position });
      }
    }
  }

  /**
   * 缓冲水位变化时重新评估 stall。由 swarm 的进度事件驱动。
   *
   * 这个入口是必须的，不能只靠 onMpvTick 驱动评估：stall 一旦触发，全员暂停，
   * mpv 静止后就不再推送任何属性变化，tick 随之断流 —— 评估逻辑再也跑不到，
   * stall 永远解不开，死锁。而「缓冲攒够了」这件事本来也只有下载侧知道，
   * 本来就该由它来触发重新评估。
   */
  onBufferProgress({ contiguousBytes, complete }) {
    if (!this.started) return;
    // 播放器可能还没起来（正在等片头下够）。这段时间同样要参与 stall 计算，
    // 否则别人会以为我们准备好了，自己先播起来。此时播放位置就是 0。
    this._evaluateStall(this.lastTick ?? { position: 0, paused: true, streamPos: null }, {
      contiguousBytes,
      complete,
    });
  }

  /** 算一下「我身前还有多少秒的连续数据」，据此进入/退出 stall。 */
  _evaluateStall(snap, { contiguousBytes, complete }) {
    // 做种方和已下完的人永远不会卡在缓冲上
    if (this.isSeeder || complete) {
      if (this.localStalled) this._setLocalStall(false, 0);
      return;
    }

    const playbackByte = this._playbackByte(snap);
    const margin = contiguousBytes - playbackByte;
    const marginSeconds = this.bytesPerSecond ? margin / this.bytesPerSecond : null;

    this.emit('margin', { bytes: margin, seconds: marginSeconds, contiguousBytes, playbackByte });

    // 滞回：低于 stall 线才喊停，高于 resume 线才松口。中间地带保持原状。
    if (!this.localStalled && margin < this.stallThresholdBytes) {
      this._setLocalStall(true, marginSeconds ?? 0, snap.position);
    } else if (this.localStalled && margin > this.resumeThresholdBytes) {
      this._setLocalStall(false, marginSeconds ?? 0, snap.position);
    }
  }

  _playbackByte(snap) {
    if (typeof snap.streamPos === 'number' && snap.streamPos > 0) return snap.streamPos;
    if (this.bytesPerSecond) return snap.position * this.bytesPerSecond;
    return 0;
  }

  _setLocalStall(stalled, deficitSeconds, position = 0) {
    if (this.localStalled === stalled) return;
    this.localStalled = stalled;
    this.emit('outbound', {
      t: MSG.STALL,
      stalled,
      peerId: this.peerId,
      name: this.name,
      position,
      deficitSeconds,
    });
    this.emit('stall-change', { who: this.peerId, name: this.name, stalled, self: true });
    this._reconcile();
  }

  _broadcastSync(position) {
    this.shared = {
      paused: this.intendedPaused,
      position,
      lamport: this._bump(),
      by: this.peerId,
    };
    this.emit('outbound', {
      t: MSG.SYNC,
      paused: this.intendedPaused,
      position,
      lamport: this.shared.lamport,
      by: this.peerId,
      name: this.name,
    });
  }

  /* ---------------------------- 远端消息 ---------------------------- */

  onCtrl(msg, fromPeer) {
    if (msg.t === MSG.SYNC) return this._onRemoteSync(msg);
    if (msg.t === MSG.STALL) return this._onRemoteStall(msg, fromPeer);
    return false;
  }

  _onRemoteSync(msg) {
    // Lamport 定序：时钟大的赢；一样大就比 peerId，保证各方判断一致。
    const newer =
      msg.lamport > this.shared.lamport ||
      (msg.lamport === this.shared.lamport && msg.by > this.shared.by);
    if (!newer) return true;

    this.shared = { paused: msg.paused, position: msg.position, lamport: msg.lamport, by: msg.by };
    this.intendedPaused = msg.paused;
    this.emit('remote-action', {
      kind: msg.paused ? 'pause' : 'play',
      by: msg.name || msg.by,
      position: msg.position,
    });
    this._reconcile({ seekTo: msg.position });
    return true;
  }

  _onRemoteStall(msg, fromPeer) {
    const id = msg.peerId || fromPeer?.peerId;
    if (!id) return true;

    if (msg.stalled) {
      this.stalledPeers.set(id, {
        name: msg.name || fromPeer?.name || id,
        position: msg.position,
        deficitSeconds: msg.deficitSeconds,
      });
    } else {
      this.stalledPeers.delete(id);
    }

    this.emit('stall-change', {
      who: id,
      name: msg.name || fromPeer?.name || id,
      stalled: msg.stalled,
      self: false,
    });
    this._reconcile();
    return true;
  }

  peerGone(peerId) {
    if (this.stalledPeers.delete(peerId)) this._reconcile();
  }

  /* ---------------------------- 状态收敛 ---------------------------- */

  /**
   * 把「应该是什么样」落到 mpv 上。所有状态变化最后都汇到这里，
   * 单一出口好过散落各处各自调 mpv。
   */
  async _reconcile({ seekTo } = {}) {
    if (!this.started) return;

    const targetPaused = this.effectivePaused;
    this.applying = true;
    try {
      if (typeof seekTo === 'number' && this.lastTick) {
        const drift = Math.abs((this.lastTick.position || 0) - seekTo);
        if (drift > SEEK_TOLERANCE) await this.emit_seek(seekTo);
      }
      await this.emit_pause(targetPaused);
    } finally {
      // 给 mpv 一点时间把属性变化推回来，别让这些回声被当成用户操作
      setTimeout(() => {
        this.applying = false;
      }, 250);
    }

    this.emit('state', this.status());
  }

  // 实际的 mpv 调用由 app.js 注入，引擎本身不直接碰 IPC
  async emit_pause(paused) {
    if (this.onSetPause) await this.onSetPause(paused);
  }

  async emit_seek(position) {
    if (this.onSeek) await this.onSeek(position);
  }

  /* ---------------------------- 对外接口 ---------------------------- */

  start() {
    this.started = true;
    this._reconcile();
  }

  /** 用户点了 UI 上的播放/暂停（不是在 mpv 窗口里点的）。 */
  userSetPaused(paused) {
    this.intendedPaused = paused;
    const pos = this.lastTick?.position || 0;
    this._broadcastSync(pos);
    this._reconcile();
  }

  userSeek(position) {
    this._broadcastSync(position);
    this._reconcile({ seekTo: position });
  }

  /** 新 peer 接进来，得先告诉他现在房间是什么状态。 */
  greet(peer) {
    peer.send({
      t: MSG.SYNC,
      paused: this.shared.paused,
      position: this.shared.position,
      lamport: this.shared.lamport,
      by: this.shared.by,
      name: this.name,
    });
    if (this.localStalled) {
      peer.send({
        t: MSG.STALL,
        stalled: true,
        peerId: this.peerId,
        name: this.name,
        position: this.lastTick?.position || 0,
      });
    }
  }

  status() {
    const waiting = [...this.stalledPeers.values()].map((v) => v.name);
    if (this.localStalled) waiting.unshift('你');
    return {
      paused: this.effectivePaused,
      intendedPaused: this.intendedPaused,
      position: this.lastTick?.position || 0,
      duration: this.duration,
      stalled: this.anyoneStalled,
      waitingFor: waiting,
      lamport: this.shared.lamport,
    };
  }
}

export { STALL_THRESHOLD_SECONDS, RESUME_THRESHOLD_SECONDS };
