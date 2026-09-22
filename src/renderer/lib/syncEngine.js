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
 * ── 关于「还能播多久」──
 * 播放器能安全读到的，是**从当前播放位置起连续已收的那一段**（runBytes），
 * 不是从文件头起的水位线（contiguousBytes）。中途加入房间时这两者相差整整一部片；
 * 把它们混为一谈会让晚到的人误判自己在卡，进而把全房拖停一个下载周期。
 * 判断依据是 runBytes，而不是「下载百分比」—— 下了 90% 但播放位置那片缺着，
 * 照样一秒都播不了。文件头（容器索引）另有门槛，见 playlist.isItemReady。
 *
 * ── 冲突处理 ──
 * 无主结构，谁都能发起。用 Lamport 逻辑时钟定序，时钟相同就比 peerId，
 * 保证所有人最终收敛到同一个状态，不会两边互相打架。
 * 别人的 Lamport 领先「经房主确认过的」基准太多的整条不收（房主连接来的除外），免得一条离谱的值
 * 把时钟顶到安全整数的尽头，之后谁的指令都发不出去。
 *
 * ── 权限（房主 / 管理员 / 游客）──
 * 「谁都能发起」只对控制者成立。房主（发起放映的人，peerId === hostId）是角色的
 * 唯一权威：他给每个人分配「管理员」或「游客」，通过 ROLE 消息广播全场。
 *  - 管理员 / 房主：可播放、暂停、跳转，且操作同步给所有人（原有行为）。
 *  - 游客：只能播放/暂停「自己这一路」—— 不广播、不影响他人；不允许跳转。
 * 强制点有两层：① 游客自己的客户端不广播控制指令；② 收到控制指令的一方，
 * 只接受实际 P2P 发送者身份已被房主授权为控制者的指令（纵深防御）。
 * 角色权威只认 hostId：邀请码里带着房主的 peerId，人人都知道该信谁，
 * 冒名顶替的 ROLE 一律不认。缓冲联动同理 —— 游客的缓冲不足只暂停自己，不拖累全员。
 *
 * ── 播放列表（0.7）──
 * seq 是「当前项」的序号，房主每换一次片加 1。SYNC / STALL 都带着它：
 * 比本地旧的丢掉（那是上一部片的指令），比本地新的先按发送者暂存最新一条，
 * 等上层把对应的播放列表应用完（resetMedia 带上新 seq）再重放。
 * 极简模式是星型，成员之间不直连，所以房主会把 SYNC / STALL / READY 转发给其他人，
 * 转发时带上 origin（原发送者）；只有从房主那条连接来的消息才采信 origin。
 *
 * READY 是「我这边对当前项准备好了没有」，自动连播要等全员就绪。它不是控制指令，
 * 游客也发、也被采信。和 STALL 一样带 seq 并按发送者单调编号（readySeq）：
 * 旧 seq 丢、新 seq 暂存，同一发送者编号不大于已采信的丢。换片（resetMedia）清空就绪表，
 * 编号不清。有人掉线时房主替他转发一条 release（ready:false）撤销，收端不看编号；
 * 新人入房时房主在 SYNC 之后补发其他人的就绪状态，每个人都再报一次自己的。
 */

const STALL_THRESHOLD_SECONDS = 5; // 身前不足 5 秒的连续数据 → 喊停
const RESUME_THRESHOLD_SECONDS = 15; // 攒够 15 秒才恢复，滞后量拉开避免反复横跳
const FALLBACK_STALL_BYTES = 4 * 1024 * 1024;
const FALLBACK_RESUME_BYTES = 16 * 1024 * 1024;
const SEEK_TOLERANCE = 0.75; // 差这么多秒以内就不去动播放器了，免得抖
// 从「读到已接收内容的末尾」恢复时往回跳这么多秒。落到断点之前的那个关键帧上，
// 解复用器才会从那里重新开始读；跳到断点本身可能又原地报一次 eof。
const DATA_END_REPLAY_BACK = 0.5;
const SEEK_DETECT_JUMP = 1.5; // 时间线跳变超过这个数，判定是用户拖了进度条
// 命令发出后，给播放器这么久把状态变化推回来，这段时间里的变化都算回声、不算用户操作。
const APPLY_ECHO_MS = 250;
const MAX_NAME = 40;
const MAX_STASH = 64;
// 别人的 Lamport 最多比基准（_anchor）领先这么多。合法指令一次只加 1，一场放映远到不了；
// 不设限的话，一条 MAX_SAFE_INTEGER 就能让之后所有 +1 都不再是安全整数、被全员拒收，降级也救不回来。
const LAMPORT_WINDOW = 2 ** 20;
// 自己发的指令最多比基准领先这么多（窗口的一半，别人一定收得下）。
// 时钟、甚至本机采信的状态被离谱的直连消息顶高了，也不至于从此发出去的每条都被拒。
const LAMPORT_LEAD = LAMPORT_WINDOW / 2;
// READY 不查控制权（游客也得报），房主还会把每一条转发给全场，每一条又会让所有人重画成员表和就绪栏。
// 一个游客反复切换就绪状态就能把全房拖住，所以按发送者限速：超出的状态照记，
// 事件和转发合并到 READY_FLUSH_MS 之后再发一次 —— 最终状态一条都不会丢。
const READY_BURST = 20;
const READY_PER_SEC = 4;
const READY_FLUSH_MS = 500;
// 按发送者记的表的上限。房间最多 16 人，这些数留足了人来人往的余量；
// 超出的只可能是房主转发时塞进来的假 origin。
const MAX_READY_PEERS = 64;
const MAX_SEEN_IDS = 256;
// 房主的角色表最多记这么多人。进过房的游客都会登记一笔、走了也不删，不设上限的话，
// 有人换着身份反复进出就能把表撑大，大到 ROLE 超过单条消息上限发不出去，新人再也拿不到角色表。
// 超了先挤掉最早登记的游客：游客本来就是默认角色，挤掉不改变任何人的权限。
const MAX_ROLE_ENTRIES = 128;
const clampName = (v) => (typeof v === 'string' ? v.slice(0, MAX_NAME) : '');

/** 按插入顺序封顶的 Map.set：超了挤掉最早的。 */
function setCapped(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

export class SyncEngine extends Emitter {
  constructor({ peerId, name, isSeeder, hostId }) {
    super();
    this.peerId = peerId;
    this.name = name;
    this.isSeeder = isSeeder;

    // 权限。hostId 是「谁是房主」的锚点：房主自己传自身 peerId；加入者从邀请码拿到房主的
    // peerId。都不知道时（安卓信令模式直接填房间号进来，手里没邀请码）传 null —— 此时
    // 自己算游客（默认最保守），等第一条 ROLE 认定并钉死房主身份。**不要**默认成 peerId，
    // 否则不知情的加入者会把自己错当成房主，短暂拿到控场权。
    // roles 显式记录每一个已知 peer 的角色（peerId -> 'admin'|'guest'），房主不入表。
    // 「显式记录游客」是必要的：角色表尚未同步的陌生人和游客都没有控场权，
    // 只有房主或明确授予的管理员可以发出全房控制指令。
    this.hostId = hostId || null;
    this.roles = new Map();

    // 时钟可注入，测试里用假时钟
    this.now = () => performance.now();

    // 房间共识状态。lamport 是这份状态的时间戳；clock 是本机见过的最大 Lamport，发新指令从它往上加。
    this.shared = { paused: true, position: 0, lamport: 0, by: peerId, byName: name || '' };
    this.clock = 0;
    // Lamport 窗口和自己发指令时封顶的基准：经房主那条连接得知的最大值，加上自己发出过的
    // （房主自己则是他采信过的）。不能用 clock / shared.lamport —— 网状下别人只直连发给我、
    // 被我采信的指令不会被转发，拿它当基准，我之后发的指令房主和其他人就收不下了。
    this._anchor = 0;
    // 直接给我发过同步消息的人。这几类消息只发给已经认下这条连接的人，所以他之后的广播我都收得到。
    this._direct = new Set();
    // 当前项的序号，来自播放列表
    this.seq = 0;
    // seq 比本地新的消息：key -> {msg, fromPeer}，等列表跟上再重放
    this._stash = new Map();
    // 卡顿消息按发送者单调编号：自己发出去的，和每个发送者最后采信的
    this._stallSeqOut = 0;
    this._stallSeen = new Map();
    // 就绪状态：自己的，和别人的（peerId -> {name, ready}）；编号规则同卡顿
    // null = 这一部还没报过。换片后的第一次一定要发，哪怕是「没准备好」——
    // 星型拓扑下管理员只能从房主转来的 READY 里知道房间里还有谁在等。
    this.localReady = null;
    this.readyPeers = new Map();
    this._readySeqOut = 0;
    this._readySeen = new Map();
    // READY 按发送者限速（见 READY_BURST）：令牌桶，和超速时攒着等合并发出的最新一条
    this._readyBuckets = new Map(); // origin -> {tokens, at}
    this._readyDeferred = new Map(); // origin -> {msg, from}
    this._readyTimer = null;
    // 房间时钟。shared.position 只是「最后一次有人操作时」的位置，房间一直在播的话它早就过时了 ——
    // 新人入房、重开播放器、换播放器都要的是「现在」房间播到哪。这里记下起点，按需外推。
    this._clock = { base: 0, at: 0, running: false };

    // 我方本地状态
    this.localStalled = false;
    // peerId -> {name, position, deficitSeconds, via}。via 是从哪几条连接得知他在卡的
    // （直连记他本人，房主转发的记房主）：那几条连接都断了，这条记录就没人能更新了。
    this.stalledPeers = new Map();
    this.intendedPaused = true; // 撇开 stall，用户真正想要的状态

    // 正在把远端状态落到播放器，别把回声当成用户操作。用计数而不是布尔量：
    // 几次 _reconcile 交叠时，先结束的那次不能把后一次的窗口提前关掉。
    this._applyDepth = 0;
    this._divergeRetries = 0;
    this.lastTick = null;
    this.pendingSeek = null; // 播放器还没起来时收到的房间位置，起来后补放
    this.pendingSeekAt = 0;
    this.seekTolerance = SEEK_TOLERANCE;
    this.eofReported = false;
    this._dataEndReported = false;
    // 当前这次卡顿是不是「播放器读到了已接收内容的末尾」造成的。解除这种卡顿要额外重放一次。
    this._dataEndStall = false;
    // 重放跳转发出的时刻。播放器还没跳过去的这段时间里报的 eof 说的是旧状态。
    this._replayAt = 0;
    this.duration = 0;
    this.bytesPerSecond = 0;
    this.started = false;
  }

  get applying() {
    return this._applyDepth > 0;
  }

  /**
   * 播放器的跳转精度。落点有误差的播放器，容差要比误差大，
   * 否则每条同步指令都会把它再拽一次。
   */
  setPlayerCaps({ seekPrecision = 0 } = {}) {
    const precision = Number(seekPrecision);
    this.seekTolerance = Math.max(SEEK_TOLERANCE, (Number.isFinite(precision) ? precision : 0) + 0.5);
  }

  setMediaInfo({ duration, size }) {
    if (duration > 0) {
      this.duration = duration;
      if (size) this.bytesPerSecond = size / duration;
    }
  }

  /**
   * 房间不散、只换影片：清空时间轴与缓冲共识，角色和 Peer 身份继续保留。
   *
   * seq 是新当前项的序号；position 是这一部从哪开始（回头接着放时是 resumeAt）。
   * 只有房主广播初始状态（broadcast）。其他控制者因为 seq 变化而重置时既不广播、
   * 也不推进 Lamport —— 否则本地时钟静默领先房主，房主换片后的第一条 SYNC
   * 会和它撞平，平局按 peerId 比大小时约一半人会判「自己更新」而把房主的指令丢掉。
   */
  resetMedia({ isSeeder = this.isSeeder, seq = this.seq, position = 0, broadcast = false } = {}) {
    this.isSeeder = !!isSeeder;
    if (Number.isSafeInteger(seq) && seq >= 0) this.seq = seq;
    const start = Number.isFinite(position) && position > 0 ? position : 0;
    this.duration = 0;
    this.bytesPerSecond = 0;
    this.sizeHint = 0;
    this.lastTick = null;
    this.pendingSeek = null;
    this.eofReported = false;
    this._dataEndReported = false;
    this._dataEndStall = false;
    this._replayAt = 0;
    this.localStalled = false;
    this.stalledPeers.clear();
    // 就绪是针对某一部的，换片后谁都得重新报。编号不清：它按发送者全局单调。
    this.localReady = null;
    this.readyPeers.clear();
    this._readyDeferred.clear(); // 攒着的是上一部的
    this.intendedPaused = true;
    const willBroadcast = broadcast && this.canIControl();
    // 不广播的一方把这份状态的时间戳置成 -1：这一部的任何一条合法 SYNC 都比它新。
    this.shared = { paused: true, position: start, lamport: -1, by: '', byName: '' };
    this._syncClock(start);
    if (willBroadcast) this._broadcastSync(start);
    this.emit('state', this.status());
    this.emit('ready-change', { reset: true });
    // 必须排在清空之后：暂存的下一部 READY 要落在新表里
    this._replayStash();
  }

  /* ---------------------------- 序号与暂存 ---------------------------- */

  _observe(lamport) {
    if (Number.isSafeInteger(lamport) && lamport > this.clock) this.clock = lamport;
  }

  _raiseAnchor(lamport) {
    if (Number.isSafeInteger(lamport) && lamport > this._anchor) this._anchor = lamport;
  }

  _stashMsg(key, msg, fromPeer) {
    const prev = this._stash.get(key);
    if (prev) {
      let later;
      if (msg.t === MSG.STALL) later = msg.stallSeq > prev.msg.stallSeq;
      else if (msg.t === MSG.READY) later = msg.readySeq > prev.msg.readySeq;
      else later = msg.lamport > prev.msg.lamport;
      const newer = msg.seq > prev.msg.seq || (msg.seq === prev.msg.seq && later);
      if (!newer) return;
    } else if (this._stash.size >= MAX_STASH) {
      this._stash.delete(this._stash.keys().next().value);
    }
    this._stash.set(key, { msg, fromPeer });
  }

  _replayStash() {
    for (const [key, entry] of [...this._stash]) {
      if (entry.msg.seq > this.seq) continue;
      this._stash.delete(key);
      if (entry.msg.seq === this.seq) this.onCtrl(entry.msg, entry.fromPeer);
    }
  }

  /**
   * 这条消息到底是谁发的。房主转发的消息带着 origin，只有真从房主那条连接来的才采信；
   * 其他人自称转发一律按他本人算。
   */
  _originOf(msg, fromPeer) {
    const senderId = fromPeer?.peerId;
    if (!senderId) return null;
    const relayed =
      !!this.hostId &&
      senderId === this.hostId &&
      typeof msg.origin === 'string' &&
      msg.origin !== '' &&
      msg.origin !== senderId;
    const origin = relayed ? msg.origin : senderId;
    return {
      senderId,
      relayed,
      origin,
      name: clampName(relayed ? msg.originName : msg.name || fromPeer?.name) || origin,
    };
  }

  /**
   * 房主把采信的控制消息转给其他人（星型拓扑下成员之间收不到彼此的消息）。
   * from.origin 是记在谁名下：快照转出去时是快照里的原作者，不一定是发来的人。
   */
  _relay(msg, from) {
    if (this.myRole() !== 'host') return;
    // 快照标记只对发给我的那条连接有意义；带着转出去，收端会把它当成房主的快照
    const { snapshot: _snapshot, ...rest } = msg;
    this.emit('relay', {
      msg: { ...rest, origin: from.origin, originName: from.name },
      except: from.senderId,
    });
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

  /**
   * 房间层面有没有被卡住。和 anyoneStalled 的区别：游客自己缓冲不足只停他自己，
   * 房间时钟照走。
   */
  get roomStalled() {
    return this.stalledPeers.size > 0 || (this.localStalled && this.canIControl());
  }

  /* ---------------------------- 房间时钟 ---------------------------- */

  _clockRunning() {
    return !this.shared.paused && !this.roomStalled;
  }

  /**
   * 房间此刻播到哪（秒）。只在「没暂停、没人卡着」的区间往前走，默认不超过片长。
   * clamp 为 false 时不封顶：房主据此判断这一部是不是已经放完了（超过片长一段）。
   */
  sharedPositionNow(clamp = true) {
    const c = this._clock;
    let pos = c.base + (c.running ? Math.max(0, this.now() - c.at) / 1000 : 0);
    if (clamp && this.duration > 0) pos = Math.min(pos, this.duration);
    return Math.max(0, pos);
  }

  /**
   * 状态变了就重定起点。先用旧的「走不走」把位置续到现在，再换成新的「走不走」——
   * 所以必须在改完暂停 / 卡顿状态之后调用。给了 base 就以它为新起点（收到或发出 SYNC 时）。
   */
  _syncClock(base) {
    const pos = typeof base === 'number' ? base : this.sharedPositionNow();
    this._clock = { base: pos, at: this.now(), running: this._clockRunning() };
  }

  /** 本机播放器此刻的位置（秒），按最后一条 tick 外推；播放器没起来时返回 null。 */
  playerPositionNow() {
    const t = this.lastTick;
    if (!t) return null;
    const base = t.position || 0;
    if (t.paused || t.eof) return base;
    return base + Math.max(0, this.now() - t.at) / 1000;
  }

  /**
   * 下一条指令的 Lamport。合法流量里 clock / shared.lamport 只比基准多一点点；多出一大截的部分
   * 只可能来自离谱的直连消息（没采信的，或只有我采信、房主没见过的），这时按 LAMPORT_LEAD 封顶
   * （时钟随之降回来），否则别人按窗口会把我之后的每条都拒掉。
   */
  _bump() {
    this.clock = Math.min(
      Math.max(this.clock, this.shared.lamport) + 1,
      this._anchor + LAMPORT_LEAD,
      Number.MAX_SAFE_INTEGER
    );
    this._raiseAnchor(this.clock);
    return this.clock;
  }

  /* ------------------------------ 权限 ------------------------------ */

  /** 某个 peer 的角色：房主 / 管理员 / 游客。未显式分配的都是游客。 */
  roleOf(peerId) {
    if (this.hostId && peerId === this.hostId) return 'host';
    return this.roles.get(peerId) || 'guest';
  }

  /** 控制者 = 房主或管理员，能左右全场；游客只能管自己。 */
  isController(peerId) {
    const r = this.roleOf(peerId);
    return r === 'host' || r === 'admin';
  }

  /** 我自己现在有没有控场权。 */
  canIControl() {
    return this.isController(this.peerId);
  }

  /** 我自己的角色。 */
  myRole() {
    return this.roleOf(this.peerId);
  }

  /** 供 UI 展示：[{peerId, role}]，含房主自己。 */
  roleSnapshot() {
    const out = this.hostId ? [{ peerId: this.hostId, role: 'host' }] : [];
    for (const [id, role] of this.roles) if (id !== this.hostId) out.push({ peerId: id, role });
    return out;
  }

  /**
   * 房主调用：peer 首次出现时登记为游客（默认角色）并广播，让全场都知道有这么个游客。
   * 不广播的话，别人只把他当「陌生人」放行他的控制指令，纵深防御就漏了。
   */
  hostEnsureKnown(peerId) {
    if (this.myRole() !== 'host' || peerId === this.hostId || this.roles.has(peerId)) return;
    this.roles.set(peerId, 'guest');
    if (this.roles.size > MAX_ROLE_ENTRIES) {
      for (const [id, role] of this.roles) {
        if (this.roles.size <= MAX_ROLE_ENTRIES) break;
        if (role === 'guest' && id !== peerId) this.roles.delete(id);
      }
    }
    this._broadcastRoles();
    this.emit('roles', this.roleSnapshot());
  }

  /**
   * 房主调用：把某人设为管理员或游客，落库并广播。别人调用无效。
   * 降级为游客时，若他此刻正卡在缓冲里拖着全员，得把他从 stall 名单里摘掉。
   */
  setRole(peerId, role) {
    if (this.myRole() !== 'host' || peerId === this.hostId) return;
    this.roles.set(peerId, role === 'admin' ? 'admin' : 'guest');
    const released = !this.isController(peerId) && this.stalledPeers.delete(peerId);
    this._syncClock();
    if (released) this._reconcile();
    this._broadcastRoles();
    this.emit('roles', this.roleSnapshot());
  }

  _broadcastRoles() {
    this.emit('outbound', {
      t: MSG.ROLE,
      hostId: this.hostId,
      roles: [...this.roles.entries()],
    });
  }

  /** 收到房主的角色表（onCtrl 里已校验来自 hostId 才会进来）。 */
  applyRoles(entries, hostId) {
    const wasController = this.canIControl();
    if (hostId) this.hostId = hostId;
    this.roles = new Map(
      (Array.isArray(entries) ? entries : []).filter(
        (entry) => Array.isArray(entry) && typeof entry[0] === 'string' && ['admin', 'guest'].includes(entry[1])
      )
    );
    // 已被降级为游客的人不再拖累全员，从 stall 名单里清掉
    let changed = false;
    for (const id of [...this.stalledPeers.keys()]) {
      if (!this.isController(id)) {
        this.stalledPeers.delete(id);
        changed = true;
      }
    }
    // 当游客时卡住只停自己、没有广播；刚被提升为控制者还卡着，就得补报一声。
    // 否则全房照常播放不等他，他本机的房间时钟却因为自己卡着停住，两边从此错开。
    if (!wasController && this.canIControl() && this.localStalled) {
      this.emit('outbound', {
        t: MSG.STALL,
        stalled: true,
        peerId: this.peerId,
        name: this.name,
        position: this.lastTick?.position || 0,
        deficitSeconds: 0,
        seq: this.seq,
        stallSeq: ++this._stallSeqOut,
      });
    }
    this._syncClock();
    this.emit('roles', this.roleSnapshot());
    if (changed) this._reconcile();
  }

  /* -------------------------- 本地播放器事件 -------------------------- */

  /**
   * mpv 每次属性变化都会调到这里。
   * 这里要分辨出「用户自己动的」和「我们刚才设进去的」，只有前者才需要广播。
   */
  onMpvTick(snap, { contiguousBytes, runBytes, complete }) {
    const prev = this.lastTick;
    this.lastTick = { ...snap, at: this.now() };

    // 新播放器的第一条 tick。launchPlayer 里的 resyncToShared 常常赶在它前面，
    // 那时还没有 lastTick，目标位置只能先记进 pendingSeek —— 没人再来消费它的话，
    // 新播放器就一直停在片头。
    if (!prev && this.started && typeof this.pendingSeek === 'number') {
      Promise.resolve(this.resyncToShared()).catch(() => {});
    }

    if (snap.duration && !this.duration) {
      this.setMediaInfo({ duration: snap.duration, size: this.sizeHint });
      this.emit('duration', snap.duration);
    }

    // 数据断在连续区尽头，不是片子放完了。
    //
    // mpv 读到手上这一段连续数据的末尾时不会「卡住等」，它报的是 EOF（keep-open 下
    // 停在最后一帧、退出码 0）。当成放完会直接跳下一部，中途加入的人一起播就跳片。
    // 所以先确认手上真有一路连到文件尾的数据，没有就按缓冲不足处理。
    // runBytes 没传（回退到旧调用方式）时这道守卫整个让开，行为与 0.6 一致。
    //
    // 这道守卫必须排在 _evaluateStall **前面**。反过来的话两者会互相打架：余量刚补够的
    // 那一刻 _evaluateStall 先解除卡顿、守卫紧接着又置回来，而解除/置上各自都会去改
    // 播放器的暂停状态，mpv 每改一次又推回一条 eof tick —— 于是每条 tick 发一对 STALL，
    // 全房按 IPC 的速度反复暂停/播放，撞到尽头的人自己还是一帧都播不下去。
    const tailReady =
      complete ||
      typeof runBytes !== 'number' ||
      !(this.sizeHint > 0) ||
      this._playbackByte(snap) + runBytes >= this.sizeHint;
    if (snap.eof && !tailReady) {
      // 重放跳转刚发出去、播放器还没跳过去：这段时间里报的 eof 说的是跳转之前的状态。
      // 照单收下会把刚解除的卡顿立刻又置回来，平白多发一对 STALL，全房跟着抖一下。
      if (this._replayAt && this.now() - this._replayAt < APPLY_ECHO_MS) return;
      // 只说一次：mpv 停在最后一帧之后会一直把 eof 推上来。
      if (!this._dataEndReported) {
        this._dataEndReported = true;
        this.emit('data-end', { position: snap.position });
      }
      // 记下「这次卡顿是读到已接收内容的末尾造成的」：解除时光放开暂停没用，
      // 播放器停在 eof 上不会回头去读新落盘的分片，必须让它重新解复用一次。
      this._dataEndStall = true;
      this._setLocalStall(true, 0, snap.position);
      // 这一条 tick 到此为止：播放器已经停在尽头，此刻就算余量够了也解不开
      // （解开也不会自己往下读）。恢复只能由下载进度那条路驱动 —— 见 _setLocalStall 里的重放。
      return;
    }
    this._dataEndReported = false;
    // 走到这里说明播放器已经不在「数据断流」的状态上了（要么没报 eof，要么是真片尾），
    // 之后再解除卡顿不需要强制重放，重放窗口也就此关掉。
    this._dataEndStall = false;
    this._replayAt = 0;

    this._evaluateStall(snap, { contiguousBytes, runBytes, complete });

    // 放到头了。mpv 开着 keep-open，会自己停在最后一帧 —— 这不是用户按了暂停，
    // 不能广播出去把还差半秒的人也停住。只报一次，由上层决定要不要推进列表。
    if (snap.eof) {
      if (!this.eofReported && this.started) {
        this.eofReported = true;
        this.emit('eof', { position: snap.position });
      }
      return;
    }
    this.eofReported = false;

    // cause === 'cmd'：播放器适配器明确说这是我们命令的效果（还没稳定下来），只当基线。
    if (this.applying || !this.started || snap.cause === 'cmd') return;

    // 用户按了暂停/播放？
    if (prev && snap.paused !== prev.paused) {
      const shouldBePaused = this.effectivePaused;
      if (snap.paused !== shouldBePaused) {
        // 缓冲不够时的暂停不是「用户的意图」，是系统强制的 —— 这时候用户在 mpv
        // 窗口里按空格，不该被当成「他想改变房间状态」，而要把暂停压回去。
        // 原来只更新 intendedPaused 就完事，于是全员暂停期间自己按一下空格，
        // 本机就一路播下去、播到没数据为止，而且没有任何人会来纠正。
        const forced = this.localStalled || this.stalledPeers.size > 0;
        if (forced && !snap.paused) {
          this.emit('denied', { action: 'play' });
          this._reconcile();
          return;
        }
        this.intendedPaused = snap.paused;
        // 游客的播放/暂停只作用于自己这一路，不广播、不动共识状态。
        if (this.canIControl()) this._broadcastSync(snap.position);
        this.emit('local-action', {
          kind: snap.paused ? 'pause' : 'play',
          position: snap.position,
          local: !this.canIControl(),
        });
      }
    }

    // 用户拖了进度条？mpv 没有独立的 seek 事件，只能看时间线有没有不连续跳变。
    if (prev && typeof snap.position === 'number' && typeof prev.position === 'number') {
      // 有主进程的采样时间就用它：渲染进程收到 tick 的时刻会被 IPC 排队抖动拉开，
      // 这点抖动会直接算进 1.5 秒的跳变阈值里。
      const elapsed =
        typeof snap.sampledAt === 'number' && typeof prev.sampledAt === 'number'
          ? (snap.sampledAt - prev.sampledAt) / 1000
          : (this.lastTick.at - prev.at) / 1000;
      const expected = prev.paused ? prev.position : prev.position + elapsed;
      if (Math.abs(snap.position - expected) > SEEK_DETECT_JUMP) {
        if (this.canIControl()) {
          this._broadcastSync(snap.position);
          this.emit('local-action', { kind: 'seek', position: snap.position });
        } else {
          // 游客不允许跳转：把进度拉回原处。
          this.emit('denied', { action: 'seek' });
          this._applyBegin();
          Promise.resolve(this.emit_seek(expected))
            .catch(() => {})
            .finally(() => this._applyEnd());
        }
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
  onBufferProgress({ contiguousBytes, runBytes, complete }) {
    if (!this.started) return;
    // 播放器可能还没起来（正在等片头下够）。这段时间同样要参与 stall 计算，
    // 否则别人会以为我们准备好了，自己先播起来。此时我们的「播放位置」是房间位置，
    // 不是 0 —— 中途加入时这两者差着整整一部片，写 0 会让整条链都错。
    this._evaluateStall(
      this.lastTick ?? { position: this.sharedPositionNow(), paused: true, streamPos: null },
      { contiguousBytes, runBytes, complete }
    );
  }

  /**
   * 立刻按给定位置重算一次卡顿，不等下一条 tick。
   *
   * 跳转到还没收到的区域时要当场判定，等下一条 tick 已经晚了 —— 那时播放器
   * 已经在读空洞，一帧花屏加几秒跳变都发生完了。
   */
  _evaluateStallNow(positionSeconds, buffer = {}) {
    const base = this.lastTick || { paused: true };
    this._evaluateStall(
      { ...base, position: positionSeconds || 0, streamPos: null, eof: false },
      buffer
    );
  }

  /** 算一下「我身前还有多少秒的连续数据」，据此进入/退出 stall。 */
  _evaluateStall(snap, { contiguousBytes, runBytes, complete }) {
    // 做种方和已下完的人永远不会卡在缓冲上
    if (this.isSeeder || complete) {
      if (this.localStalled) this._setLocalStall(false, 0);
      return;
    }

    const playbackByte = this._playbackByte(snap);
    // runBytes 是「从播放位置起还能连续读多少字节」，由 swarm 按同一个播放位置算好后传进来。
    // 传长度而不是绝对位置：两个数出自同一次计算，不会因为两边的播放位置差半秒而相减出幽灵负值。
    // 老调用方没传时退回旧算法（只有从片头起播才与它等价），回退只需要停止传参。
    const margin = typeof runBytes === 'number' ? runBytes : contiguousBytes - playbackByte;
    const marginSeconds = this.bytesPerSecond ? margin / this.bytesPerSecond : null;

    this.emit('margin', { bytes: margin, seconds: marginSeconds, contiguousBytes, runBytes, playbackByte });

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
    // 游客的缓冲不足只暂停自己，不广播、不拖累全员（他本就是「自己看自己的」）。
    if (this.canIControl()) {
      this.emit('outbound', {
        t: MSG.STALL,
        stalled,
        peerId: this.peerId,
        name: this.name,
        position,
        deficitSeconds,
        seq: this.seq,
        stallSeq: ++this._stallSeqOut,
      });
    }
    this._syncClock();
    this.emit('stall-change', { who: this.peerId, name: this.name, stalled, self: true });
    // 从「读到已接收内容的末尾」里恢复，必须让播放器重新解复用一次。
    //
    // mpv 停在 eof 那一帧上，只收到 setPause(false) 是不会回头去读新落盘的分片的 ——
    // 它一动不动，下一条 eof tick 又把卡顿置回来，两边来回抖。而 _reconcile({seekTo})
    // 按偏差判断（drift <= seekTolerance 就不动播放器），目标恰恰就是当前位置，一定被挡掉。
    // 所以这里走一条显式的重放路径：往回跳一点点，让解复用器从前一个关键帧重新开始。
    if (!stalled && this._dataEndStall) {
      this._dataEndStall = false;
      this._replayAt = this.now();
      const at = this.lastTick?.position ?? position ?? 0;
      this._reconcile({ seekTo: Math.max(0, at - DATA_END_REPLAY_BACK), force: true });
      return;
    }
    this._reconcile();
  }

  _broadcastSync(position) {
    this.shared = {
      paused: this.intendedPaused,
      position,
      lamport: this._bump(),
      by: this.peerId,
      byName: this.name,
    };
    this._syncClock(position);
    this.emit('outbound', {
      t: MSG.SYNC,
      paused: this.intendedPaused,
      position,
      lamport: this.shared.lamport,
      by: this.peerId,
      name: this.name,
      seq: this.seq,
    });
    if (!this.intendedPaused) this.emit('playing', { seq: this.seq });
  }

  /* ---------------------------- 远端消息 ---------------------------- */

  onCtrl(msg, fromPeer) {
    const ours = msg.t === MSG.SYNC || msg.t === MSG.STALL || msg.t === MSG.ROLE || msg.t === MSG.READY;
    if (ours && fromPeer?.peerId) this._direct.add(fromPeer.peerId);
    if (msg.t === MSG.SYNC) return this._onRemoteSync(msg, fromPeer);
    if (msg.t === MSG.STALL) return this._onRemoteStall(msg, fromPeer);
    if (msg.t === MSG.ROLE) return this._onRole(msg, fromPeer);
    if (msg.t === MSG.READY) return this._onRemoteReady(msg, fromPeer);
    return false;
  }

  /**
   * 角色表只认房主。冒名的 ROLE 一律丢弃。
   *
   * 「谁是房主」的锚点很关键，不能让消息自己说了算 —— 否则任何人把 hostId 填成自己
   * 就能篡夺角色权威。分两种情况：
   *  - 已知房主（PC 端从邀请码拿到，或此前已认过）：只认这个 peer 发来的表。
   *  - 尚不知道房主（安卓信令模式直接填房间号进来，手里没有邀请码）：首认为准 ——
   *    认「自称房主、且确实以该身份发消息」的第一个人，之后钉死，不再改。
   *    发送方 peerId 由 P2P 通道本身担保，冒不了别人的身份。
   */
  _onRole(msg, fromPeer) {
    const from = fromPeer?.peerId;
    if (!from) return true;
    // 我自己就是房主：角色表只由我发出，别人发来的一概不认。这一条必须排在最前面 ——
    // 房主的 hostId 恰好等于自身 peerId，会落进下面「尚不知道房主」的分支，
    // 任何成员只要把 hostId 填成自己发一条 ROLE，就能把房主挤下去、夺走角色权威。
    if (this.hostId && this.hostId === this.peerId) return true;
    const known = !!this.hostId;
    if (known ? from !== this.hostId : from !== msg.hostId) return true;
    this.applyRoles(msg.roles, msg.hostId);
    return true;
  }

  _onRemoteSync(msg, fromPeer) {
    // 权限只认承载这条消息的 P2P 连接（以及房主转发时注明的原发送者），绝不信可伪造的 by 字段。
    const from = this._originOf(msg, fromPeer);
    if (!from || from.origin === this.peerId || !this.isController(from.origin)) return true;
    if (
      typeof msg.paused !== 'boolean' ||
      !Number.isFinite(msg.position) ||
      msg.position < 0 ||
      !Number.isSafeInteger(msg.lamport) ||
      msg.lamport < 0 ||
      !Number.isSafeInteger(msg.seq) ||
      msg.seq < 0
    ) return true;
    // 房主那条连接来的（他自己的，或他采信后转发的）不设上限：房主是权威，
    // 转发前已经按他自己的时钟查过；新人时钟从 0 起，也得收得下房主报的现状。
    const fromHost = !!this.hostId && from.senderId === this.hostId;
    if (!fromHost && msg.lamport > this._anchor + LAMPORT_WINDOW) return true;
    this._observe(msg.lamport);
    if (fromHost) this._raiseAnchor(msg.lamport);

    // 上一部片的指令丢掉；下一部片的先记着，等列表跟上
    if (msg.seq < this.seq) return true;
    if (msg.seq > this.seq) {
      this._stashMsg(`sync:${from.origin}`, msg, fromPeer);
      return true;
    }

    // 快照（greet 发的「房间现在的样子」）不是新操作，by 是对方记着的原作者（可能正是我自己）。
    // 照抄它，各方对「这是谁的哪一次操作」的记录才一致，平局才裁决得一样。
    const snapshot = msg.snapshot === true;
    const author = snapshot && typeof msg.by === 'string' && msg.by !== '' ? msg.by : from.origin;
    // 别人快照里的作者已经不是控制者：那是房主拒收过的、或降级那一刻在途的指令，不能借重连复活
    if (snapshot && !fromHost && !this.isController(author)) return true;

    // Lamport 定序：时钟大的赢。
    // 现状的作者已经不是控制者（刚被降级，他在途的指令被一部分人采信了）时，房主连接来的一律算新的 ——
    // 那是房主采信的现状，房主拒收了的那条，他的时钟没见过，之后的指令可能比它小。
    //
    // Lamport 一样时：
    //  - 同一次操作（作者相同）：网状下从直连和房主转发两条路到达，第二条是重复的；
    //    快照则可能是断线期间有人卡过、两边外推出的位置不同 —— 只认房主的，拿来校正位置。
    //  - 两次不同的操作：已被降级的作者输，其余比 peerId。房主收到我的指令（或快照）时按同一规则裁决，
    //    两边才不会各认各的。
    const orphaned = !this.isController(this.shared.by);
    let newer;
    let correction = false;
    if (msg.lamport !== this.shared.lamport) {
      newer = msg.lamport > this.shared.lamport || (fromHost && orphaned);
    } else if (author === this.shared.by) {
      newer = correction = fromHost && snapshot;
    } else {
      const authorOrphaned = !this.isController(author);
      newer =
        (orphaned && (fromHost || !authorOrphaned)) ||
        (!orphaned && !authorOrphaned && author > this.shared.by);
    }
    if (!newer) return true;
    if (this.myRole() === 'host') this._raiseAnchor(msg.lamport);

    let byName = from.name;
    if (author !== from.origin) {
      byName = author === this.peerId ? this.name : author === this.shared.by ? this.shared.byName : author;
    }
    this.shared = {
      paused: msg.paused,
      position: msg.position,
      lamport: msg.lamport,
      by: author,
      byName,
    };
    this._syncClock(msg.position);
    if (correction) {
      // 只是校正房间时钟，不是谁刚操作了。游客自己的暂停/播放不广播，本来就可以和房间不同 ——
      // 不去改它；和房间不一致时也不拽他的进度。
      const following = this.intendedPaused === msg.paused;
      if (!msg.paused) this.emit('playing', { seq: this.seq });
      this._reconcile(following ? { seekTo: msg.position } : {});
      return true;
    }
    this.intendedPaused = msg.paused;
    this._relay(msg, { ...from, origin: author, name: byName });
    this.emit('remote-action', {
      kind: msg.paused ? 'pause' : 'play',
      by: from.name,
      position: msg.position,
    });
    if (!msg.paused) this.emit('playing', { seq: this.seq });
    this._reconcile({ seekTo: msg.position });
    return true;
  }

  _onRemoteStall(msg, fromPeer) {
    const from = this._originOf(msg, fromPeer);
    if (!from || from.origin === this.peerId || typeof msg.stalled !== 'boolean') return true;
    const id = from.origin;

    // 房主替已经断开的成员撤销卡顿。不看编号：那个人不会再发消息了。
    if (from.relayed && msg.release === true) {
      if (msg.stalled !== false || !this.stalledPeers.delete(id)) return true;
      this._syncClock();
      this.emit('stall-change', { who: id, name: from.name, stalled: false, self: false });
      this._reconcile();
      return true;
    }

    if (!this.isController(id)) return true;
    if (msg.position !== undefined && (!Number.isFinite(msg.position) || msg.position < 0)) return true;
    if (msg.deficitSeconds !== undefined && !Number.isFinite(msg.deficitSeconds)) return true;
    if (!Number.isSafeInteger(msg.seq) || msg.seq < 0 || !Number.isSafeInteger(msg.stallSeq) || msg.stallSeq < 0) {
      return true;
    }
    if (msg.seq < this.seq) return true;
    if (msg.seq > this.seq) {
      this._stashMsg(`stall:${id}`, msg, fromPeer);
      return true;
    }
    // 同一个人的卡顿消息只采信更新的那条：两条路径到达的先后不定，旧的「卡住」不能盖掉新的「好了」
    // 能告诉我他好了的路径：这条消息来的那条；和他本人有直连的话也算上 —— 他直连发来的那份
    // 可能因为当时角色表还没到被拒了，可他缓过来时照样会直接告诉我。
    const via = [from.relayed ? from.senderId : id];
    if (this._direct.has(id)) via.push(id);
    const seen = this._stallSeen.get(id) ?? -1;
    if (msg.stallSeq <= seen) {
      // 同一条从另一条路径又到了一次：记下这条路径，断掉其中一条时还知道他在卡
      const entry = msg.stalled && msg.stallSeq === seen ? this.stalledPeers.get(id) : null;
      if (entry) for (const v of via) entry.via.add(v);
      return true;
    }
    this._stallSeen.set(id, msg.stallSeq);

    if (msg.stalled) {
      const prev = this.stalledPeers.get(id);
      this.stalledPeers.set(id, {
        name: from.name,
        position: msg.position,
        deficitSeconds: msg.deficitSeconds,
        via: new Set([...(prev?.via || []), ...via]),
      });
    } else {
      this.stalledPeers.delete(id);
    }
    this._syncClock();
    this._relay(msg, from);

    this.emit('stall-change', {
      who: id,
      name: from.name,
      stalled: msg.stalled,
      self: false,
    });
    this._reconcile();
    return true;
  }

  /**
   * 别人报来的就绪状态。不查控制权：游客也得准备好，自动连播才能往下走。
   * 编号、seq 与转发的规则都和卡顿一样。
   */
  _onRemoteReady(msg, fromPeer) {
    const from = this._originOf(msg, fromPeer);
    if (!from || from.origin === this.peerId || typeof msg.ready !== 'boolean') return true;
    const id = from.origin;

    // 房主替已经断开的成员撤销就绪。不看编号：那个人不会再发消息了。
    if (from.relayed && msg.release === true) {
      if (msg.ready !== false || !this.readyPeers.delete(id)) return true;
      this.emit('ready-change', { who: id, name: from.name, ready: false, gone: true, self: false });
      return true;
    }

    if (!Number.isSafeInteger(msg.seq) || msg.seq < 0 || !Number.isSafeInteger(msg.readySeq) || msg.readySeq < 0) {
      return true;
    }
    if (msg.seq < this.seq) return true;
    if (msg.seq > this.seq) {
      this._stashMsg(`ready:${id}`, msg, fromPeer);
      return true;
    }
    // 两条路径到达的先后不定，旧的「没好」不能盖掉新的「好了」
    if (msg.readySeq <= (this._readySeen.get(id) ?? -1)) return true;
    // 表满了不再收新人（只可能是房主转发时塞进来的一堆假 origin）
    if (!this.readyPeers.has(id) && this.readyPeers.size >= MAX_READY_PEERS) return true;
    setCapped(this._readySeen, id, msg.readySeq, MAX_SEEN_IDS);

    this.readyPeers.set(id, { name: from.name, ready: msg.ready });
    if (!this._takeReadyToken(id)) {
      // 超速：状态已经记下，事件和转发攒着，合并到一起晚一点发
      this._readyDeferred.set(id, { msg, from });
      if (!this._readyTimer) this._readyTimer = setTimeout(() => this._flushReady(), READY_FLUSH_MS);
      return true;
    }
    this._readyDeferred.delete(id); // 这一条就是最新的，攒着的那条作废
    this._relay(msg, from);
    this.emit('ready-change', { who: id, name: from.name, ready: msg.ready, self: false });
    return true;
  }

  _takeReadyToken(id) {
    const now = this.now();
    let b = this._readyBuckets.get(id);
    if (!b) b = { tokens: READY_BURST, at: now };
    else if (now > b.at) b.tokens = Math.min(READY_BURST, b.tokens + ((now - b.at) / 1000) * READY_PER_SEC);
    b.at = now;
    setCapped(this._readyBuckets, id, b, MAX_READY_PEERS);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** 把超速时攒着的就绪状态合并发出去：每个人只发最新的那一条。 */
  _flushReady() {
    this._readyTimer = null;
    const pending = [...this._readyDeferred];
    this._readyDeferred.clear();
    for (const [id, { msg, from }] of pending) {
      const entry = this.readyPeers.get(id);
      // 期间换了片，或者人已经走了（peerGone 已经替他撤销过）
      if (msg.seq !== this.seq || !entry) continue;
      this._relay(msg, from);
      this.emit('ready-change', { who: id, name: entry.name, ready: entry.ready, self: false });
    }
  }

  peerGone(peerId) {
    this._direct.delete(peerId);
    this._readyDeferred.delete(peerId);
    for (const key of [...this._stash.keys()]) {
      if (key.endsWith(`:${peerId}`)) this._stash.delete(key);
    }
    const host = this.myRole() === 'host';
    let dropped = false;
    for (const [id, entry] of [...this.stalledPeers]) {
      // 经这条连接得知的卡顿，从此没人能告诉我它解除了（经房主转发来的，房主一断就是这样）。
      // 还有别的连接能更新的就留着：比如和他的直连断了，房主那边还在转发。
      entry.via.delete(peerId);
      if (entry.via.size > 0) continue;
      this.stalledPeers.delete(id);
      dropped = true;
      // 星型拓扑下其他人收不到这个人断开的消息，得由房主替他说一声「不卡了」
      if (host && id === peerId) {
        this.emit('relay', {
          msg: {
            t: MSG.STALL,
            stalled: false,
            release: true,
            origin: peerId,
            originName: clampName(entry.name) || peerId,
            seq: this.seq,
            stallSeq: this._stallSeen.get(peerId) ?? 0,
          },
          except: null,
        });
      }
      // 编号也一并忘掉：他若还在卡，重连后房主补发的还是这个编号，不能被当成重复丢掉
      this._stallSeen.delete(id);
    }
    if (dropped) {
      this._syncClock();
      this._reconcile();
    }
    const ready = this.readyPeers.get(peerId);
    if (ready) {
      this.readyPeers.delete(peerId);
      // 同理替他撤销就绪，否则其他人会一直以为他还在、还准备好了
      if (host) {
        this.emit('relay', {
          msg: {
            t: MSG.READY,
            ready: false,
            release: true,
            origin: peerId,
            originName: clampName(ready.name) || peerId,
            seq: this.seq,
            readySeq: this._readySeen.get(peerId) ?? 0,
          },
          except: null,
        });
      }
      this.emit('ready-change', { who: peerId, ready: false, gone: true, self: false });
    }
  }

  /* ---------------------------- 状态收敛 ---------------------------- */

  /**
   * 把「应该是什么样」落到 mpv 上。所有状态变化最后都汇到这里，
   * 单一出口好过散落各处各自调 mpv。
   */
  async _reconcile({ seekTo, force = false } = {}) {
    if (!this.started) return;

    const targetPaused = this.effectivePaused;
    this._applyBegin();
    try {
      if (typeof seekTo === 'number' && this.lastTick) {
        // 按外推后的位置比：只在变化时才推 tick 的播放器（PotPlayer 每 0.5 秒才变一次），
        // 拿最后一条 tick 的原值比，播放中会平白多出几百毫秒的「偏差」。
        const drift = Math.abs(this.playerPositionNow() - seekTo);
        // force：这一跳的目的不是对时间，是逼播放器重新解复用（它停在数据尽头不会自己
        // 去读新落盘的分片）。目标就在当前位置附近，按偏差判断必然被挡掉。
        if (force || drift > this.seekTolerance) await this.emit_seek(seekTo);
      } else if (typeof seekTo === 'number') {
        // 播放器还没起来（lastTick 为空）。以前这里直接放弃，而 shared.position
        // 之后再没有任何路径会补下发 —— 观众的 mpv 是在收到房间位置之后才启动的，
        // 于是必然从 0:00 开始播，和房间里其他人差着半部片子。
        // 记下来，等 resyncToShared() 在播放器起来后重放。
        this.pendingSeek = seekTo;
        this.pendingSeekAt = this.now();
      }
      await this.emit_pause(targetPaused);
    } finally {
      this._applyEnd();
    }

    this.emit('state', this.status());
  }

  _applyBegin() {
    this._applyDepth++;
  }

  /** 给播放器一点时间把属性变化推回来，窗口全部关掉后核对一次实际状态。 */
  _applyEnd() {
    setTimeout(() => {
      this._applyDepth = Math.max(0, this._applyDepth - 1);
      if (this._applyDepth === 0) this._checkDivergence();
    }, APPLY_ECHO_MS);
  }

  /**
   * 窗口里的变化都被当成回声吞掉了，这里补一次核对：播放器实际的暂停状态和该有的不一样，
   * 要么是命令没生效，要么是用户恰好在这时按了一下。先重发一次；还不一致就报出来，
   * 不去猜是用户操作 —— 猜错了会把一个坏掉的播放器的状态广播给全房。
   */
  _checkDivergence() {
    const t = this.lastTick;
    if (!this.started || !t || t.eof || t.paused === this.effectivePaused) {
      this._divergeRetries = 0;
      return;
    }
    if (this._divergeRetries++ < 1) this._reconcile();
    else this.emit('diverged', { playerPaused: !!t.paused, wantPaused: this.effectivePaused });
  }

  /**
   * 播放器（重新）起来之后，把房间共识状态重放给它。
   *
   * mpv 没启动时 setPause/seek 在主进程直接抛「mpv 未启动」，注入的回调又把异常
   * 全吞了，所以这段时间收到的 SYNC 等于没收。新进程从 0:00 起，必须补这一次。
   */
  async resyncToShared() {
    if (!this.started) return;
    let target;
    if (typeof this.pendingSeek === 'number') {
      // 记下来之后房间一直在播的话，要把这段时间补上
      const waited = this._clockRunning() ? Math.max(0, this.now() - this.pendingSeekAt) / 1000 : 0;
      target = this.pendingSeek + waited;
    } else {
      target = this.sharedPositionNow();
    }
    this.pendingSeek = null;
    if (!(target >= 0)) return;
    await this._reconcile({ seekTo: target });
  }

  /**
   * 播放器退出了，忘掉它最后的状态。
   *
   * 留着的话，下一个 mpv 的第一条 tick（position=0、paused=true）会和旧 tick 一比，
   * 被判成「用户拖了进度条 / 按了暂停」—— 房主据此广播 SYNC(0)，全房被拉回片头。
   */
  forgetPlayerState() {
    this.lastTick = null;
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
    // 游客：只暂停/播放自己这一路，不广播、不动共识。
    // 播放器没开着（比如刚关掉）时按的是界面上的按钮，这时报 0 会把全房拉回片头 —— 用房间时钟。
    if (this.canIControl()) this._broadcastSync(this.playerPositionNow() ?? this.sharedPositionNow());
    this._reconcile();
  }

  userSeek(position) {
    // 游客不允许跳转。UI 那层已经拦了，这里再兜一道底。
    if (!this.canIControl()) {
      this.emit('denied', { action: 'seek' });
      return;
    }
    this._broadcastSync(position);
    this._reconcile({ seekTo: position });
  }

  /**
   * 本机对当前项准备好了没有（由上层判断：文件到位、扫描通过、播放器能起来……）。
   * 只在变化时广播，返回是否真的变了。游客也发：就绪不是控制指令。
   */
  setLocalReady(ready) {
    const next = !!ready;
    if (next === this.localReady) return false;
    this.localReady = next;
    this.emit('outbound', {
      t: MSG.READY,
      seq: this.seq,
      ready: next,
      peerId: this.peerId,
      name: this.name,
      readySeq: ++this._readySeqOut,
    });
    this.emit('ready-change', { who: this.peerId, name: this.name, ready: next, self: true });
    return true;
  }

  /** 供上层判断「是不是全员就绪」：自己的，加上已知的每个人的。 */
  readySnapshot() {
    return {
      self: this.localReady === true,
      peers: [...this.readyPeers].map(([peerId, v]) => ({ peerId, name: v.name, ready: v.ready })),
    };
  }

  /**
   * 新 peer 接进来，得先告诉他现在房间是什么状态。
   *
   * 发送顺序是契约（ctrl 通道有序）：ROLE → 播放列表和聊天历史（beforeSync，由上层发）
   * → SYNC → 正在卡着的人 → 就绪状态（房主补发的其他人的，最后是自己的）。
   * 对方先知道当前是第几部，SYNC 才不会被当成下一部的消息暂存起来。
   */
  greet(peer, { beforeSync } = {}) {
    const host = this.myRole() === 'host';
    // 房主：先把权威角色表发给新人，他才知道该信谁、自己是什么身份。
    if (host) {
      this.hostEnsureKnown(peer.peerId);
      peer.send({ t: MSG.ROLE, hostId: this.hostId, roles: [...this.roles.entries()] });
    }
    beforeSync?.();
    // 位置要报「现在」的：shared.position 是最后一次有人操作时的位置，
    // 房间连续播了二十分钟没人碰的话，新人会被拉回二十分钟前。
    //
    // 这份状态是别的控制者定下的，就把原作者一并告诉新人（origin 只有从房主连接来的才被采信）。
    // 否则新人会把它记在房主名下，之后遇到同 Lamport 的并发指令，平局按 peerId 比较时
    // 新人和房主比的不是同一个人，两边裁决不一样，新人就此和全房分叉。
    // 作者是新人自己（重连）或已经不是控制者时不带：前者会被当成回声丢掉，后者整条会被拒。
    //
    // snapshot 标明这是现状而不是新操作：收端按 by 认作者，同一次操作只认房主的来校正位置（见 _onRemoteSync）。
    const author = this.shared.by;
    const withAuthor =
      host && !!author && author !== this.peerId && author !== peer.peerId && this.isController(author);
    peer.send({
      t: MSG.SYNC,
      paused: this.shared.paused,
      position: this.sharedPositionNow(),
      lamport: Math.max(0, this.shared.lamport),
      by: author || this.peerId,
      name: this.name,
      seq: this.seq,
      snapshot: true,
      ...(withAuthor ? { origin: author, originName: clampName(this.shared.byName) || author } : {}),
    });
    // 房主替其他正卡着的人补发：星型拓扑下新人收不到他们的消息
    if (host) {
      for (const [id, entry] of this.stalledPeers) {
        if (id === peer.peerId) continue;
        peer.send({
          t: MSG.STALL,
          stalled: true,
          origin: id,
          originName: clampName(entry.name),
          position: entry.position || 0,
          deficitSeconds: entry.deficitSeconds || 0,
          seq: this.seq,
          stallSeq: this._stallSeen.get(id) ?? 0,
        });
      }
    }
    if (this.localStalled && this.canIControl()) {
      // 用新编号：对方可能在断线前已经见过我上一条的编号
      peer.send({
        t: MSG.STALL,
        stalled: true,
        peerId: this.peerId,
        name: this.name,
        position: this.lastTick?.position || 0,
        seq: this.seq,
        stallSeq: ++this._stallSeqOut,
      });
    }
    // 就绪状态同样要在 SYNC 之后：对方先对上 seq，才不会把它们当成下一部的暂存。
    // 房主替其他人补发，编号沿用见过的；未就绪的也发，新人才知道还在等谁。
    if (host) {
      for (const [id, entry] of this.readyPeers) {
        if (id === peer.peerId) continue;
        peer.send({
          t: MSG.READY,
          seq: this.seq,
          ready: entry.ready,
          origin: id,
          originName: clampName(entry.name),
          readySeq: this._readySeen.get(id) ?? 0,
        });
      }
    }
    // 自己的一定发，用新编号：对方可能在断线前已经见过上一条的编号
    peer.send({
      t: MSG.READY,
      seq: this.seq,
      ready: this.localReady === true,
      peerId: this.peerId,
      name: this.name,
      readySeq: ++this._readySeqOut,
    });
  }

  status() {
    const waiting = [...this.stalledPeers.values()].map((v) => v.name);
    if (this.localStalled) waiting.unshift('你'); // 由 app.js 的 t() 统一翻译
    return {
      paused: this.effectivePaused,
      intendedPaused: this.intendedPaused,
      position: this.playerPositionNow() ?? this.sharedPositionNow(),
      duration: this.duration,
      stalled: this.anyoneStalled,
      waitingFor: waiting,
      lamport: this.shared.lamport,
    };
  }
}

export {
  STALL_THRESHOLD_SECONDS,
  RESUME_THRESHOLD_SECONDS,
  SEEK_TOLERANCE,
  APPLY_ECHO_MS,
  MAX_NAME,
  LAMPORT_WINDOW,
  LAMPORT_LEAD,
};
