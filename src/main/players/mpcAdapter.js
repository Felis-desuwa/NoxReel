'use strict';

/**
 * MPC-BE 适配器。
 *
 * 比 PotPlayer 好伺候得多（P0 实测）：跳转精确到帧，状态、跳转、播完都会主动推过来，
 * `/open` 打开即暂停，关闭约 200ms。所以这里没有任何「补救」，只有三件正事：
 *
 *  1. **接住推送**：`/slave <hwnd>` 让它把 CMD_* 通知发到桥的消息窗口，
 *     再由桥的 copydata 事件转进来（PLAYMODE / NOTIFYSEEK / NOTIFYENDOFSTREAM / NOWPLAYING）。
 *  2. **每 250ms 主动问一次位置**：推送里没有「一直在走的位置」，只有跳转那一下。
 *  3. **脱管检测**：资源管理器转发命令行时会把 hMasterWnd 清掉，这时它照常播，
 *     但再也不理我们。连着约 1.8 秒问位置一个回包都没有才认定脱管，提示用户并退回 mpv ——
 *     一个遥控不了的播放器比没有播放器更糟：房间以为它在同步。
 *
 * 两条硬约束：
 *  - **绝不传音量参数**：`/volume 0` 会被永久写进注册表，改的是用户自己的播放器。
 *  - **链接需要请求头时直接拒绝**：MPC-BE 没有传请求头的命令行开关，
 *     硬播只会 403，不如当场退回 mpv 说清楚原因。
 */

const { EventEmitter } = require('events');
const { spawn: nodeSpawn } = require('child_process');
const { createWaiterHub, sharedBridge, monotonicMs, normalizeSource } = require('./bridge');
const { discoverPlayers } = require('./discover');

/** MPC 的 WM_COPYDATA 命令码。0x5000xxxx 是它发给我们的，0xA000xxxx 是我们发给它的。 */
const MPC = {
  CONNECT: 0x50000000,
  PLAYMODE: 0x50000002,
  NOWPLAYING: 0x50000003,
  CURRENTPOSITION: 0x50000007,
  NOTIFYSEEK: 0x50000008,
  NOTIFYENDOFSTREAM: 0x50000009,
  DISCONNECT: 0x5000000b,

  PLAY: 0xa0000004,
  PAUSE: 0xa0000005,
  SETPOSITION: 0xa0002000,
  GETCURRENTPOSITION: 0xa0003004,
  GETNOWPLAYING: 0xa0003002,
  CLOSEAPP: 0xa0004006,
  OSDSHOWMESSAGE: 0xa0005000,
};
/** MPC_PLAYSTATE。注意 0 是「播放」，不是「停止」。 */
const MPC_PLAYSTATE = { PLAY: 0, PAUSE: 1, STOP: 2, UNUSED: 3 };
/** OSD 位置：左上角。 */
const MPC_OSD_POS = 1;
/** OSD 文本上限。结构体里是 WCHAR[128]，末尾那个必须留给 NUL。 */
const MPC_OSD_MAX = 127;
/** 跳转精确到帧，几乎没有落点误差。 */
const MPC_SEEK_PRECISION = 0;
/** 位置采样间隔（秒）。外推最多补这么多。 */
const MPC_SAMPLE_INTERVAL = 0.4;
/**
 * 连着这么久问位置一个回包都没有才算脱管。
 *
 * 判据只能按时间算：脱管是终态（提示用户、退回 mpv、当前这个窗口再也不用了），
 * 而大文件跳转、换音轨、madVR 初始化都能让 MPC-BE 半秒多顾不上回包。
 * 按次数算（原来是 2 次 × 250ms = 500ms）等于让一次正常的卡顿把播放器判死。
 */
const MPC_DETACH_MS = 1800;

const DEFAULT_TIMING = {
  pollMs: 250,
  detachMs: MPC_DETACH_MS,
  pauseTimeoutMs: 1000,
  seekTimeoutMs: 3000,
  seekSettleMs: 300,
  launchTimeoutMs: 20000,
  connectTimeoutMs: 8000,
  quitTimeoutMs: 3000,
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function playerError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clampOsd(text) {
  const chars = [...String(text === undefined || text === null ? '' : text)];
  return chars.length > MPC_OSD_MAX ? chars.slice(0, MPC_OSD_MAX).join('') : chars.join('');
}

/**
 * 命令行。文件名在前、开关在后。
 *  /new    本机 MultipleInstances=1，不加它会把片子塞给已经开着的那个窗口
 *  /open   打开但不播，等同步引擎决定什么时候开始
 *  /slave  把通知发回给桥的消息窗口
 *  /start  起播位置（毫秒）
 * 一个音量参数都没有，见文件头。
 */
function buildMpcArgs({ source, startAt = 0, slaveHwnd = 0, headers = {} } = {}) {
  if (headers && typeof headers === 'object' && Object.keys(headers).length) {
    throw playerError('这个链接需要额外的请求头，MPC-BE 传不了。已退回 mpv 播放', 'PLAYER_NO_HEADERS');
  }
  const args = [normalizeSource(source), '/new', '/open'];
  const hwnd = Number(slaveHwnd) || 0;
  if (hwnd) args.push('/slave', String(hwnd));
  const start = Math.max(0, Math.round((Number(startAt) || 0) * 1000));
  if (start > 0) args.push('/start', String(start));
  return args;
}

class MpcAdapter extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {object} [opts.bridge]  桥接客户端（测试里换成假的）
   * @param {Function} [opts.spawn] child_process.spawn 的替身
   * @param {string} [opts.exePath] 指定 MPC-BE 路径，不给就自己探测
   * @param {object} [opts.timing]  各段超时，测试里调小
   */
  constructor({ bridge, spawn = nodeSpawn, exePath = '', timing = {} } = {}) {
    super();
    this.kind = 'mpc';
    this.caps = {
      seekPrecision: MPC_SEEK_PRECISION,
      streaming: false, // P0：增长中的 mkv 会卡死在片头边界，只接手已收完的文件
      banner: 'overlay',
      osd: true,
      danmaku: 'overlay',
      keyframeAhead: false,
    };
    this.bridge = bridge || null;
    this.spawn = spawn;
    this.exePath = exePath || '';
    this.timing = { ...DEFAULT_TIMING, ...timing };

    this.proc = null;
    this.pid = 0;
    this.hwnd = 0;
    this.exited = false;
    this.lastError = null;

    this._quiet = true;
    this._closing = false;
    this._cmdDepth = 0;
    this._hub = createWaiterHub({ name: 'MPC-BE' });
    this._loopTimer = null;
    this._anchor = null; // {seconds, at}
    this._position = 0;
    this._duration = 0;
    this._playState = MPC_PLAYSTATE.PAUSE;
    this._playStateAt = 0;
    this._fileName = '';
    this._eof = false;
    this._banner = '';
    this._looping = false; // 轮询该不该继续。定时器已触发时 clearTimeout 拦不住，只能靠这个标记
    this._awaiting = false; // 有一条 GETCURRENTPOSITION 还没等到回包
    this._awaitingSince = 0; // 那一条是什么时候发出去的（脱管判据按时间算）
    this._seekSeq = 0;
    this._onCopyData = (msg) => this._handleCopyData(msg);
    this._onWinEvent = (msg) => this._handleWinEvent(msg);
    this._onBridgeRestart = () => this._reregister();
  }

  /** @returns {Promise<string|null>} 本机 MPC-BE 的可执行文件路径。 */
  static async find() {
    const found = await discoverPlayers();
    return found.mpc.path;
  }

  /* ------------------------------- 启动 ------------------------------- */

  async launch({ source, startPaused = true, startAt = 0, headers = {} } = {}) {
    if (this.proc) throw playerError('MPC-BE 已在运行', 'PLAYER_BUSY');
    const exe = this.exePath || (await MpcAdapter.find());
    if (!exe) throw playerError('没找到 MPC-BE。请先安装，或在设置里指定它的路径', 'PLAYER_NOT_FOUND');
    this.exePath = exe;

    const bridge = await this._bridge();
    const args = buildMpcArgs({ source, startAt, slaveHwnd: bridge.hwnd, headers });
    this._quiet = true;
    this._cmdDepth++;
    try {
      const proc = this.spawn(exe, args, { stdio: 'ignore', windowsHide: false });
      this.proc = proc;
      this.pid = proc.pid;
      proc.on('exit', (code) => this._onProcExit(code));
      proc.on('error', (error) => this._fail(error));

      await bridge.call('allow', { pid: this.pid });
      this.hwnd = await this._awaitConnect();
      await bridge.call('track', { hwnd: this.hwnd });
      this._startLoop();
      this._ask(MPC.GETNOWPLAYING);

      // /open 即暂停。等它真的报回来一次位置、且确实是暂停着的。
      await this._waitFor((s) => s.ready && s.paused, {
        timeoutMs: this.timing.launchTimeoutMs,
        label: '就位',
      });
      // /start 偶尔不生效（比如文件还在解析），这时自己补一跳，别把「起点不对」留给同步引擎去发现。
      const want = Math.max(0, Number(startAt) || 0);
      if (Math.abs(this.position() - want) > 1) await this._seekTo(want);
      if (!startPaused) await this._setPauseInternal(false);

      this._quiet = false;
      this._emitTick();
      return { bin: exe, filePath: source, pid: this.pid, hwnd: this.hwnd, args };
    } catch (error) {
      this._stopLoop();
      throw error;
    } finally {
      this._cmdDepth--;
    }
  }

  async _bridge() {
    if (!this.bridge) this.bridge = sharedBridge();
    await this.bridge.start();
    this.bridge.on('copydata', this._onCopyData);
    this.bridge.on('win', this._onWinEvent);
    this.bridge.on('restart', this._onBridgeRestart);
    return this.bridge;
  }

  async _reregister() {
    if (this._closing || !this.pid || !this.hwnd) return;
    try {
      await this.bridge.call('allow', { pid: this.pid });
      await this.bridge.call('track', { hwnd: this.hwnd });
    } catch {
      /* 补不回来就让脱管检测去判死 */
    }
  }

  /**
   * 等 CMD_CONNECT。它带回来的就是 MPC 主窗口的 hwnd，比枚举窗口可靠得多；
   * 迟迟不来就退一步枚举一次（有的版本在某些设置下不发 CONNECT，但遥控照常能用）。
   */
  async _awaitConnect() {
    const deadline = monotonicMs() + this.timing.connectTimeoutMs;
    const half = monotonicMs() + this.timing.connectTimeoutMs / 2;
    while (monotonicMs() < deadline) {
      if (this.hwnd) return this.hwnd;
      if (this.exited) throw playerError('MPC-BE 启动后立刻退出了（可能是被已开着的窗口接管了）', 'PLAYER_GONE');
      if (monotonicMs() > half) {
        try {
          const hwnd = await this.bridge.call('findWindow', { pid: this.pid, classes: [] });
          if (hwnd) return Number(hwnd);
        } catch {
          /* 再等等 */
        }
      }
      await delay(100);
    }
    throw playerError('没等到 MPC-BE 的窗口', 'PLAYER_NO_WINDOW');
  }

  /* ------------------------------ 推送与轮询 ------------------------------ */

  _startLoop() {
    if (this._looping || this._closing) return;
    this._looping = true;
    const step = () => {
      this._loopTimer = null;
      if (this._closing || !this._looping) return;
      this._pollPosition();
      // _pollPosition() 判死时走 _fail() → _stopLoop()，而此刻 _loopTimer 还是 null
      // （本轮定时器早触发过了），clearTimeout 拦不住下一轮。只能在排下一轮之前自己看一眼。
      if (this._closing || !this._looping) return;
      this._loopTimer = setTimeout(step, this.timing.pollMs);
      if (this._loopTimer.unref) this._loopTimer.unref();
    };
    step();
  }

  _stopLoop() {
    this._looping = false;
    if (this._loopTimer) clearTimeout(this._loopTimer);
    this._loopTimer = null;
  }

  /**
   * 主动问位置。回包是异步的（走 copydata），所以这里只记「从哪一刻起就没回包了」——
   * 连着 detachMs 那么久一个回包都没有才是脱管：它还在播，但 hMasterWnd 被清掉了，
   * 我们的指令全进了黑洞。每轮照旧再问一次，任何一条回包都算它还在。
   */
  _pollPosition() {
    if (!this.hwnd || this._closing) return;
    if (this._awaiting && monotonicMs() - this._awaitingSince >= this.timing.detachMs) {
      this._fail(playerError('MPC-BE 不再响应遥控（可能是被资源管理器转发启动的）。已退回 mpv', 'PLAYER_DETACHED'));
      return;
    }
    if (!this._awaiting) {
      this._awaiting = true;
      this._awaitingSince = monotonicMs();
    }
    this._ask(MPC.GETCURRENTPOSITION);
  }

  _ask(code, arg = '') {
    if (!this.hwnd || this._closing) return Promise.resolve(false);
    return this.bridge
      .call('mpc', { hwnd: this.hwnd, code, arg: String(arg) }, { timeoutMs: 1500 })
      .then(() => true)
      .catch(() => false);
  }

  _handleWinEvent(msg) {
    if (!msg || this._closing) return;
    if (this.hwnd && Number(msg.hwnd) !== this.hwnd) return;
    this.emit('window', msg);
  }

  /** 桥转来的 WM_COPYDATA。只认我们这个播放器进程发的。 */
  _handleCopyData(msg) {
    if (!msg || this._closing) return;
    const code = Number(msg.code);
    const text = String(msg.text || '');
    if (code === MPC.CONNECT) {
      const hwnd = Number(text.trim());
      // CONNECT 是唯一一条「还不知道 hwnd」时就要收的消息，只能靠发送方 PID 认人。
      if (Number(msg.pid) === this.pid && hwnd) this.hwnd = hwnd;
      return;
    }
    const fromOurs = Number(msg.pid) === this.pid || Number(msg.from) === this.hwnd;
    if (!fromOurs) return;

    switch (code) {
      case MPC.CURRENTPOSITION:
        this._awaiting = false;
        this._awaitingSince = 0;
        this._applyPosition(parseFloat(text));
        break;
      case MPC.NOTIFYSEEK:
        this._awaiting = false;
        this._awaitingSince = 0;
        this._applyPosition(parseFloat(text));
        this._seekSeq += 1;
        break;
      case MPC.PLAYMODE:
        this._applyPlayState(parseInt(text, 10));
        break;
      case MPC.NOWPLAYING:
        this._applyNowPlaying(text);
        break;
      case MPC.NOTIFYENDOFSTREAM:
        this._eof = true;
        this._notify(this._sample());
        this._emitTick({ force: true });
        break;
      case MPC.DISCONNECT:
        this._fail(playerError('MPC-BE 断开了遥控连接', 'PLAYER_DETACHED'));
        break;
      default:
        break;
    }
  }

  _applyPosition(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    if (this._duration > 0 && seconds > this._duration + 5) return; // 明显不是秒的值，丢掉
    this._position = seconds;
    this._anchor = { seconds, at: monotonicMs() };
    this._notify(this._sample());
    this._emitTick();
  }

  _applyPlayState(value) {
    if (!Number.isFinite(value)) return;
    if (value === this._playState) return;
    this._playState = value;
    this._playStateAt = monotonicMs();
    if (value === MPC_PLAYSTATE.PLAY) this._eof = false;
    this._notify(this._sample());
    this._emitTick();
  }

  /** CMD_NOWPLAYING 的正文是 `标题|作者|描述|文件名|时长`。时长是秒。 */
  _applyNowPlaying(text) {
    const parts = text.split('|');
    if (parts.length < 5) return;
    const name = parts[3];
    const duration = parseFloat(parts[4]);
    if (Number.isFinite(duration) && duration > 0) this._duration = duration;
    // 启动途中只记下来、不比较：还没稳下来时报的可能是它上一次放的文件（PotPlayer 就是这样）。
    // MPC-BE 的 NOWPLAYING 是推送、打开文件时只来一次，所以这里照样记录，不然启动完就没有基准了。
    if (!this._quiet && this._fileName && name && name !== this._fileName) this._onFileSwitched();
    if (name) this._fileName = name;
    this._notify(this._sample());
  }

  /**
   * 用户在 MPC-BE 里自己开了别的片：暂停并提示，不推进播放列表。
   * 放完那一路走 NOTIFYENDOFSTREAM，不经过这里。
   */
  _onFileSwitched() {
    this._ask(MPC.PAUSE);
    this._duration = 0;
    this._anchor = null;
    this.emit('error', playerError('有人在 MPC-BE 里打开了别的文件，已暂停', 'PLAYER_FOREIGN_FILE'));
  }

  _sample() {
    return {
      ready: this._anchor !== null, // 至少收到过一次位置回包
      position: this.position(),
      playState: this._playState,
      paused: this._playState !== MPC_PLAYSTATE.PLAY,
      duration: this._duration,
      seekSeq: this._seekSeq,
      stateAt: this._playStateAt,
      at: monotonicMs(),
    };
  }

  _notify(sample) {
    this._hub.notify(sample);
  }

  _failWaiters(error) {
    this._hub.fail(error);
  }

  /**
   * 已经判死时不必再等（不会有新采样了），但 soft 的等待要照 soft 的规矩收场 ——
   * soft 就是「等不到也让调用方继续往下走」，直接 reject 会把跳转、暂停后面的收尾整段跳过。
   * 和 potAdapter 里那一处同源，改一边必须改另一边。
   */
  _waitFor(predicate, options = {}) {
    if (this.lastError) return options.soft ? Promise.resolve(null) : Promise.reject(this.lastError);
    return this._hub.waitFor(predicate, options);
  }

  /* ------------------------------ 对外方法 ------------------------------ */

  setPause(paused) {
    return this._runCommand(() => this._setPauseInternal(paused));
  }

  async _setPauseInternal(paused) {
    const want = !!paused;
    await this._ask(want ? MPC.PAUSE : MPC.PLAY);
    const settled = await this._waitFor((s) => s.paused === want, {
      timeoutMs: this.timing.pauseTimeoutMs,
      label: want ? '暂停' : '播放',
      soft: true,
    });
    return { settled: settled !== null, paused: want, position: this.position() };
  }

  seek(seconds) {
    return this._runCommand(() => this._seekTo(seconds));
  }

  /**
   * 跳转。MPC-BE 的落点是精确的，不需要关键帧补救。
   * settle 判据：收到 NOTIFYSEEK，且播放状态稳定 300ms ——
   * CMD_SETPOSITION 内部是「先暂停、再跳、再恢复」，状态会抖一下，不等它稳就会把中间态当成用户操作。
   */
  async _seekTo(seconds) {
    const target = Math.max(0, Number(seconds) || 0);
    const deadline = monotonicMs() + this.timing.seekTimeoutMs;
    const before = this._seekSeq;
    await this._ask(MPC.SETPOSITION, String(target));
    const settled = await this._waitFor(
      (s) => s.seekSeq !== before && monotonicMs() - s.stateAt >= this.timing.seekSettleMs,
      { timeoutMs: Math.max(50, deadline - monotonicMs()), label: '跳转', soft: true }
    );
    return { position: this.position(), target, keyframe: false, settled: settled !== null };
  }

  async _runCommand(fn) {
    this._cmdDepth++;
    try {
      return await fn();
    } finally {
      this._cmdDepth--;
    }
  }

  /** 一闪而过的提示。结构体由桥负责清零，这里只保证不超过 127 字。 */
  osd(text, durationMs = 2000) {
    const body = clampOsd(text);
    if (!body || !this.hwnd || this._closing) return Promise.resolve(false);
    const ms = Math.max(500, Math.min(10000, Math.round(Number(durationMs) || 2000)));
    return this.bridge
      .call('mpcOsd', { hwnd: this.hwnd, pos: MPC_OSD_POS, ms, text: body }, { timeoutMs: 1500 })
      .then(() => true)
      .catch(() => false);
  }

  /** 常驻横幅由覆盖窗画；这里只广播变化，顺带用 OSD 闪一下。 */
  setBanner(text) {
    const body = clampOsd(text);
    if (body === this._banner) return false;
    this._banner = body;
    this.emit('banner', { text: body });
    if (body) this.osd(body, 4000);
    return true;
  }

  /** 覆盖窗输入条发来的弹幕，走和 mpv 一样的事件出去。 */
  deliverChatInput(payload) {
    this.emit('chat-input', { ...payload, kind: this.kind });
  }

  /* ------------------------------ 快照与退出 ------------------------------ */

  position() {
    if (!this._anchor) return this._position;
    let seconds = this._anchor.seconds;
    if (this._playState === MPC_PLAYSTATE.PLAY) {
      const elapsed = Math.max(0, (monotonicMs() - this._anchor.at) / 1000);
      seconds += Math.min(elapsed, MPC_SAMPLE_INTERVAL);
    }
    if (this._duration > 0) seconds = Math.min(seconds, this._duration);
    return seconds;
  }

  snapshot() {
    return {
      running: !!this.proc && !this.exited,
      position: this.position(),
      paused: this._playState !== MPC_PLAYSTATE.PLAY,
      duration: this._duration,
      streamPos: null, // 报不了读到文件哪个字节，卡顿预判那一路按时间折算
      idle: this._playState === MPC_PLAYSTATE.STOP,
      eof: this._eof,
      seeking: false,
      cause: this._cmdDepth > 0 ? 'cmd' : 'user',
      sampledAt: monotonicMs(),
    };
  }

  _emitTick({ force = false } = {}) {
    if (this._quiet && !force) return;
    this.emit('tick', this.snapshot());
  }

  _onProcExit(code) {
    this.exited = true;
    this._stopLoop();
    this._failWaiters(playerError('MPC-BE 已退出', 'PLAYER_GONE'));
    if (this._closing) return;
    this.emit('exit', { code, stderr: '' });
  }

  _fail(error) {
    if (this._closing || this.lastError) return;
    this.lastError = error;
    this._stopLoop();
    this._failWaiters(error);
    this.emit('error', error);
  }

  async quit() {
    this._closing = true;
    this._stopLoop();
    this._failWaiters(playerError('MPC-BE 正在退出', 'PLAYER_CLOSING'));
    if (this.bridge) {
      this.bridge.off('copydata', this._onCopyData);
      this.bridge.off('win', this._onWinEvent);
      this.bridge.off('restart', this._onBridgeRestart);
      if (this.hwnd) {
        await this.bridge.call('close', { hwnd: this.hwnd }, { timeoutMs: 1500 }).catch(() => {});
      }
    }
    const done = await this._waitForExit(this.timing.quitTimeoutMs);
    if (this.bridge) {
      await this.bridge.call('untrack', {}, { timeoutMs: 1500 }).catch(() => {});
      if (this.pid) await this.bridge.call('forget', { pid: this.pid }, { timeoutMs: 1500 }).catch(() => {});
    }
    return done;
  }

  async _waitForExit(timeoutMs) {
    const deadline = monotonicMs() + timeoutMs;
    while (monotonicMs() < deadline) {
      const procDead = !this.proc || this.exited || this.proc.exitCode !== null || this.proc.signalCode !== null;
      let windowDead = true;
      if (this.hwnd && this.bridge) {
        try {
          const state = await this.bridge.call('winState', { hwnd: this.hwnd }, { timeoutMs: 1000 });
          windowDead = !state || !state.alive;
        } catch {
          windowDead = true;
        }
      }
      if (procDead && windowDead) return true;
      await delay(100);
    }
    try {
      if (this.proc) this.proc.kill();
    } catch {
      /* 已经没了 */
    }
    return false;
  }
}

module.exports = {
  MPC,
  MPC_DETACH_MS,
  MPC_OSD_MAX,
  MPC_PLAYSTATE,
  MPC_SEEK_PRECISION,
  MpcAdapter,
  buildMpcArgs,
};
