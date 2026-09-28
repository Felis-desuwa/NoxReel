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
 *
 * ── 在线链接（streaming）──
 * 每个人各自从原网站拉流，缓冲由 mpv 自己管：缺数据时它自己停下来等（paused-for-cache），
 * 攒够再接着放。没有分片水位线可看，「卡没卡」只认这个信号。每个成员自己选跟随方式：
 *  - 完全同步（full，默认）：控制者缓冲时全房一起等；每秒核对一次本机和房间时钟差多少，
 *    超过 2 秒就自动跳过去（往前多跳一点提前量，从上一次落地差了多少学来）。两分钟里往前追了四次
 *    还是落后算「同步失败」（网速跟不上），停手一分钟并把差多少秒报给上层。
 *  - 手动同步（manual）：缓冲只卡自己、房间照走；只跟真正的跳转（位置和房间原先的进度对不上），
 *    播放/暂停不动他的进度；差开了只报差多少秒，由用户点「同步到房主」（落地没对上会自动补跳一次）。
 *    他是管理员时按暂停/播放报房间的位置而不是自己的，免得把全房拽到他落后的地方。
 * 房主是参照，没有选择，按完全同步走。
 * 本机播放器打不开链接（tick 带 loadFailed：403、签名过期、解析失败，mpv 留在 idle）时不算「在等数据」，
 * 否则控制者会把全房一直挂在「等待缓冲」；播放器没了（playerGone）同理放掉本机的卡顿。
 * 在线链接没有分片水位线兜底，断流时 mpv 同样报 eof：片长已知且离片尾还远、或者片长未知时不认「放完了」，
 * 改报 stream-cut（由上层提示本人重新连接），不然控制者网络一抖，全房就跳到下一部。
 * 断流时 mpv 同一刻先推 pause、再推 eof，偶尔被拆成两条 tick：在线链接里播放器报的暂停因此先只停本机，
 * 等 STREAM_PAUSE_CONFIRM_MS 没见到断流的迹象才当成本人按的暂停报出去（见 _deferPause）。
 */

const STALL_THRESHOLD_SECONDS = 5; // 身前不足 5 秒的连续数据 → 喊停
const RESUME_THRESHOLD_SECONDS = 15; // 攒够 15 秒才恢复，滞后量拉开避免反复横跳
const FALLBACK_STALL_BYTES = 4 * 1024 * 1024;
const FALLBACK_RESUME_BYTES = 16 * 1024 * 1024;
const SEEK_TOLERANCE = 0.75; // 差这么多秒以内就不去动播放器了，免得抖
// 本地文件报 eof 时，位置离片长还差这么多秒以上就不算放完了（播放器停在了已接收内容的尽头，
// 或者停在它之前读进缓存的零上）。留余量是因为容器写的片长和播放器最后一帧的位置常差零点几秒，
// PotPlayer 报放完时位置本来就可能差 2 秒（potAdapter 的 EOF_MARGIN）。
const DATA_EOF_SLACK_SECONDS = 5;
// 数据都在、播放器却停在半路时会直接重放（见 onMpvTick 的 eof 守卫）。停在离上次重放这么近的地方
// 算「同一个地方」：放起来之后又停回这里、或者同一个地方已经重放了 DATA_EOF_REPLAY_MAX 次，
// 就认它是真片尾（容器写的片长不准），不再重放 —— 否则会一直原地重放下去。
// 重放之后播放器一直没动过的，等 DATA_EOF_REPLAY_WAIT_MS 再重放（先到的多半是跳转落地之前的旧 eof）。
const DATA_EOF_REPLAY_SAME_SECONDS = 1;
const DATA_EOF_REPLAY_MAX = 2;
const DATA_EOF_REPLAY_WAIT_MS = 3000;
const SEEK_DETECT_JUMP = 1.5; // 时间线跳变超过这个数，判定是用户拖了进度条
// 命令发出后，给播放器这么久把状态变化推回来，这段时间里的变化都算回声、不算用户操作。
const APPLY_ECHO_MS = 250;
// 自己发出的跳转，落点在这么多毫秒内推回来都认作回声。网络流跳转要重新连接，
// 位置变化可能晚于上面那个窗口才到 —— 被当成用户拖进度条的话，控制者会把这个落点广播给全房。
const SEEK_ECHO_MS = 3000;
// 在线链接：播放器报「暂停了」之后等这么久，才当成本人按的暂停广播出去（见 _deferPause）。
// 断流时 mpv 同一刻先推 pause、再推 eof，偶尔被拆成前后两条 tick：当场广播的话，控制者网络一断
// 全房就被暂停，重试之后还得有人再按播放。这段时间里来了断流的迹象（eof、paused-for-cache、打不开）
// 就作废；真人按的暂停只晚这么一点同步出去。本地文件不等。
const STREAM_PAUSE_CONFIRM_MS = 200;
// 在线链接：和房间差超过 DRIFT_OUT 秒算「没对上」，回到 DRIFT_BACK 秒以内才算重新对上（滞回）。
const DRIFT_OUT_SECONDS = 2;
const DRIFT_BACK_SECONDS = 1;
// 连着这么多次核对都超出才算数：刚跳转完、刚缓冲完的读数常常还没稳住。
const DRIFT_CONFIRM_CHECKS = 2;
// 完全同步：自动对齐一次之后至少隔这么久才会再对（跳过去要重新缓冲）。
const DRIFT_CORRECT_COOLDOWN_MS = 5000;
// 一段时间里往前追了这么多次还是落后，算同步失败（网速跟不上）：停手一阵子，把差多少秒报出去。
// 只数往前追的：跳过头了再往回对一下（缓存里的数据跳过去几乎不花时间，提前量会偏大）不是网速的问题。
const DRIFT_FAIL_WINDOW_MS = 120_000;
const DRIFT_FAIL_COUNT = 4;
const DRIFT_FAIL_BACKOFF_MS = 60_000;
// 网络流跳过去要重新请求、重新缓冲，落地时房间已经往前走了一截（实测 archive.org 要 7 秒）。
// 自动对齐时往前多跳一点，这个提前量从上一次落地差了多少学来，封顶这么多秒。
// 跳过去这么久还没核对上的不拿来学（多半卡住了）。
const DRIFT_LEAD_MAX_SECONDS = 10;
const DRIFT_LEAD_PROBE_MS = 20_000;
// 手动同步点了「同步到房主」之后这么久之内，落地还没对上就自动再补跳一次（用刚学到的提前量）——
// 第一次跳还不知道这个网站跳转要花多久，一次点不到位。只补一次，之后还差就照常提示。
const DRIFT_CHASE_MS = 30_000;
// 在线链接报 eof 时，位置离片长还差这么多秒以上就不算放完了（断流、签名过期、分片连续失败）。
// 片尾最后几秒断的，推进到下一部也无妨；留余量是因为网站给的片长和实际能放到的位置常差一两秒。
const STREAM_EOF_SLACK_SECONDS = 10;
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
// 「没准备好」可以顺带说一句为什么，只认这几种 —— 都是房主从成员的位图上看不出来的：
// 收完了却还不能放，卡在安全扫描上（正在扫、扫描器用不了、没扫完）。旧版不认这个字段，照旧只看 ready。
const READY_WHY = ['scanning', 'scan-unavailable', 'scan-incomplete'];
const readyWhyOf = (ready, why) => (ready === false && READY_WHY.includes(why) ? why : null);
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
  constructor({ peerId, name, isSeeder, hostId, playAfterComplete = false }) {
    super();
    this.peerId = peerId;
    this.name = name;
    this.isSeeder = isSeeder;
    // 本机要把片子收完（安全模式还要扫描通过）才打开播放器。没收完时他根本不在看，
    // 缓冲不足轮不到让房间等他：不因为自己缓冲不足喊停（别人报的卡顿照样听）。
    // 开播前等不等他由上层的就绪门槛管。
    this.playAfterComplete = !!playAfterComplete;

    // 权限。hostId 是「谁是房主」的锚点：房主自己传自身 peerId；加入者从邀请码 / 房间链接拿到
    // 房主的 peerId，安卓直接填信令服务器地址和房间号进来的，拿服务器 joined 里的 hostId。
    // 都不知道时传 null —— 此时自己算游客（默认最保守），等第一条 ROLE 认定并钉死房主身份。
    // **不要**默认成 peerId，否则不知情的加入者会把自己错当成房主，短暂拿到控场权。
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
    // 就绪状态：自己的，和别人的（peerId -> {name, ready, why}）；编号规则同卡顿
    // null = 这一部还没报过。换片后的第一次一定要发，哪怕是「没准备好」——
    // 星型拓扑下管理员只能从房主转来的 READY 里知道房间里还有谁在等。
    this.localReady = null;
    this.localReadyWhy = null; // 没准备好的原因（READY_WHY 之一），准备好了恒为 null
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
    this.pendingSeekOffset = 0; // 它和当时房间时钟差多少秒（有意偏离房间时才不是 0）
    this.seekTolerance = SEEK_TOLERANCE;
    this.eofReported = false;
    this._dataEndReported = false;
    // 当前这次卡顿是不是「播放器读到了已接收内容的末尾」造成的。解除这种卡顿要额外重放一次。
    this._dataEndStall = false;
    // 重放跳转发出的时刻。播放器还没跳过去的这段时间里报的 eof 说的是旧状态。
    this._replayAt = 0;
    // 最近一次重放 {position, count, at, left}：在哪儿、同一个地方重放了几次、什么时候、之后播放器离开过 eof 没有。
    // 同一个地方重放过还停在那儿，就不再重放（见 DATA_EOF_REPLAY_SAME_SECONDS）
    this._eofReplay = null;
    this.duration = 0;
    this.bytesPerSecond = 0;
    this.started = false;
    // 最近一次自己发给播放器的跳转 {position, at}，用来认出迟到的回声（见 SEEK_ECHO_MS）
    this._lastSeekCmd = null;
    // 在线链接里本人刚按的暂停，确认不是断流之前先不报出去（见 _deferPause）
    this._pendingPause = null;
    this.pauseConfirmMs = STREAM_PAUSE_CONFIRM_MS;

    // 在线链接（见类注释）：当前项是不是各自从原网站拉流，以及本机选的跟随方式
    this.streaming = false;
    this.followMode = 'full';
    this._seekLead = 0;
    this._resetDrift();
    // 在线链接的播放器停在一个不是片尾的 eof 上（断流），已经报过 stream-cut。离开 eof 才清掉
    this._streamCut = false;
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
    this.pendingSeekOffset = 0;
    this.eofReported = false;
    this._dataEndReported = false;
    this._dataEndStall = false;
    this._replayAt = 0;
    this._eofReplay = null;
    this._lastSeekCmd = null;
    this._streamCut = false;
    this._dropPendingPause();
    // 跳转提前量是按这一部的网站学的，换一部从头学。跟随方式不动，由上层按新的当前项重新设
    this._seekLead = 0;
    this._resetDrift();
    this.localStalled = false;
    this.stalledPeers.clear();
    // 就绪是针对某一部的，换片后谁都得重新报。编号不清：它按发送者全局单调。
    this.localReady = null;
    this.localReadyWhy = null;
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
    // 在线链接自己在等数据时不用再按暂停：mpv 本来就停着在等，而且按了暂停之后 core-idle 恒为真，
    // 就分不清「还在起播」和「已经好了」—— 放开、再卡、再放开，全房跟着一走一停。
    const ownStall = this.localStalled && !this.streaming;
    return this.intendedPaused || ownStall || this.stalledPeers.size > 0;
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

  /**
   * 本机播放器此刻的位置（秒），按最后一条 tick 外推；播放器没起来时返回 null。
   * 打不开（loadFailed）、在线链接断在半路（_streamCut）的播放器报的位置不是房间的进度 ——
   * 控制者这时在界面上按暂停，拿它广播会把全房拽回片头或断流的地方，所以同样当作没有。
   * 说不出位置的播放器（还没载入完、正在卸载，tick 的位置是 null）也一样。
   */
  playerPositionNow() {
    const t = this.lastTick;
    if (!t || t.loadFailed === true || this._streamCut || !Number.isFinite(t.position)) return null;
    const base = t.position;
    if (!this._advancing(t)) return base;
    return base + Math.max(0, this.now() - t.at) / 1000;
  }

  /**
   * 这条 tick 时播放器是不是在往前走。暂停、放到头、缓冲（在线链接缺数据时 mpv 自己停下来等，
   * pause 仍然是 no）、跳转后重新起播（core-idle）时位置都停着。
   */
  _advancing(t) {
    return !t.paused && !t.eof && !t.idle && !t.pausedForCache;
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

  /* ------------------------------ 昵称 ------------------------------ */

  /** 自己改了昵称：之后发出去的 SYNC / STALL / READY 都带新名字。 */
  setName(name) {
    const clean = clampName(name).trim();
    if (!clean) return;
    if (this.shared.by === this.peerId) this.shared.byName = clean;
    this.name = clean;
  }

  /** 别人改了昵称：就绪表、卡顿表里记着的名字跟着换，「等待缓冲：xxx」不再显示旧名字。 */
  noteRename(peerId, name) {
    const clean = clampName(name).trim();
    if (!clean) return;
    const ready = this.readyPeers.get(peerId);
    if (ready) ready.name = clean;
    const stalled = this.stalledPeers.get(peerId);
    if (stalled) stalled.name = clean;
    if (this.shared.by === peerId) this.shared.byName = clean;
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
    const promoted = !wasController && this.canIControl();
    // 当游客时卡住只停自己、没有广播；刚被提升为控制者还卡着，就得补报一声。
    // 否则全房照常播放不等他，他本机的房间时钟却因为自己卡着停住，两边从此错开。
    if (promoted && this.localStalled) {
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
    if (promoted && !this._manual()) {
      // 游客自己按的暂停、自己缓冲不足停下，恢复时都是从停下的地方接着放，不回到房间的位置 ——
      // 他可能早就落后房间一大截，或者还自己暂停着。刚成为控制者，第一次按暂停/播放报的就是这个位置，
      // 全房会被拽回去。所以先对齐房间：位置跳到房间时钟，暂停状态也回到房间的。
      // 手动同步的人按暂停/播放报的是房间位置（见 _actionPosition），和房间差着是他自己留的，不动。
      // 播放器没开着就不用跳：它起来时本来就从房间此刻的位置起播（见 resyncToShared）。
      this.intendedPaused = this.shared.paused;
      this._reconcile(this.lastTick ? { seekTo: this.sharedPositionNow() } : {});
    } else if (changed) {
      this._reconcile();
    }
  }

  /* -------------------------- 本地播放器事件 -------------------------- */

  /**
   * mpv 每次属性变化都会调到这里。
   * 这里要分辨出「用户自己动的」和「我们刚才设进去的」，只有前者才需要广播。
   */
  onMpvTick(snap, { contiguousBytes, runBytes, runEndBytes, complete }) {
    const prev = this.lastTick;
    this.lastTick = { ...snap, at: this.now() };

    // 在线链接里刚按下、还没报出去的暂停：这一条带出了断流的迹象，或者又放起来了，就作废（见 _deferPause）。
    // 必须排在 eof 那几道分支前面 —— 断流的那条 tick 走到那里就返回了。
    if (this._pendingPause) this._checkPendingPause(snap);

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
    // 所以两条都成立才认放完：手上真有一路连到文件尾的数据，而且播放位置真到了片尾附近。
    // 只看前一条会被 stream-pos 骗过：mp4 撞上数据尽头时 mpv 把 stream-pos 报成差几十 KB
    // 就到文件尾（mpv v0.41 实测），「播放字节 + runBytes」随之到了文件尾 —— 管理员的 60 秒短片
    // 放到 10.8 秒，一收完就被当成放完、推进到下一部。runEndBytes 由上层按核对过的播放位置算
    // （见 scheduler.positionToByte），比这里自己拿 stream-pos 推算可靠。
    // runBytes 没传（回退到旧调用方式）时这道守卫整个让开，行为与 0.6 一致；
    // 在线链接不走这里（没有分片，断流另由下面的 stream-cut 处理）。
    //
    // 这道守卫必须排在 _evaluateStall **前面**。反过来的话两者会互相打架：余量刚补够的
    // 那一刻 _evaluateStall 先解除卡顿、守卫紧接着又置回来，而解除/置上各自都会去改
    // 播放器的暂停状态，mpv 每改一次又推回一条 eof tick —— 于是每条 tick 发一对 STALL，
    // 全房按 IPC 的速度反复暂停/播放，撞到尽头的人自己还是一帧都播不下去。
    // 这一部已经认过放完了（eofReported）：之后的 eof tick 还是停在片尾那个状态（关窗口时 mpv 卸载文件，
    // 位置会先归零、eof 还挂着），不再重新判，免得对着一个正在退出的播放器重放。离开 eof 就清掉，见下面。
    const guarded = typeof runBytes === 'number' && !this.streaming && !this.eofReported;
    const dataToEnd =
      complete ||
      !(this.sizeHint > 0) ||
      (typeof runEndBytes === 'number' ? runEndBytes : this._playbackByte(snap) + runBytes) >= this.sizeHint;
    if (snap.eof && guarded && !(dataToEnd && this._fileEndPlausible(snap))) {
      // 重放跳转刚发出去、播放器还没跳过去：这段时间里报的 eof 说的是跳转之前的状态。
      // 照单收下会把刚解除的卡顿立刻又置回来，平白多发一对 STALL，全房跟着抖一下。
      if (this._replayAt && this.now() - this._replayAt < APPLY_ECHO_MS) return;
      if (!dataToEnd) {
        // 数据还没到：按缓冲不足处理。只说一次：mpv 停在最后一帧之后会一直把 eof 推上来。
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
      // 数据一路到文件尾都在（多半已经收完了），播放器却停在半路：收完之前撞上的尽头、
      // 或者之前读进缓存的零。收完了就不会再有下载进度来解除卡顿，所以不进卡顿，直接重放一次。
      const replay = this._eofReplay;
      const here = !!replay && Math.abs((snap.position || 0) - replay.position) <= DATA_EOF_REPLAY_SAME_SECONDS;
      if (!here) {
        this._replayDataEnd(snap.position);
        return;
      }
      if (!replay.left && replay.count < DATA_EOF_REPLAY_MAX) {
        // 重放之后播放器还没动过：多半是跳转落地之前的旧 eof，等一会儿；等不来再重放一次
        if (this.now() - replay.at >= DATA_EOF_REPLAY_WAIT_MS) this._replayDataEnd(snap.position);
        return;
      }
      // 放起来之后又停回同一个地方，或者重放了两次还停在这儿：认它是真片尾（容器写的片长不准），
      // 往下照常报 eof。不设这个上限的话，片长写错的片子会在片尾原地重放下去，列表永远推不动。
    }
    this._dataEndReported = false;
    // 走到这里说明播放器已经不在「数据断流」的状态上了（要么没报 eof，要么是真片尾），
    // 之后再解除卡顿不需要强制重放，重放窗口也就此关掉。
    this._dataEndStall = false;
    this._replayAt = 0;
    if (this._eofReplay && !snap.eof) this._eofReplay.left = true;

    if (this.streaming) this._evaluateStreamStall(snap);
    else this._evaluateStall(snap, { contiguousBytes, runBytes, complete });

    // 播放器打不开这个片子（留在 idle，位置属性没了、报 0）：之后的位置跳变、暂停变化都不是用户的操作，
    // 照常比对的话，控制者会把「跳到 0」广播给全房。
    if (snap.loadFailed === true) return;

    // 放到头了。mpv 开着 keep-open，会自己停在最后一帧 —— 这不是用户按了暂停，
    // 不能广播出去把还差半秒的人也停住。只报一次，由上层决定要不要推进列表。
    if (snap.eof) {
      if (this.streaming && !this._streamEndPlausible(snap)) {
        // 在线链接断在半路：报给上层提示本人重新连接，不当成放完了（见类注释）
        if (!this._streamCut && this.started) {
          this._streamCut = true;
          this.emit('stream-cut', { position: snap.position || 0, duration: this._streamDuration(snap) });
        }
        return;
      }
      if (!this.eofReported && this.started) {
        this.eofReported = true;
        this.emit('eof', { position: snap.position });
      }
      return;
    }
    this.eofReported = false;
    this._streamCut = false;

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
        // 在线链接自己在等数据时本来就不按暂停（见 effectivePaused），也就谈不上「被强制停着」：
        // 缓冲中按了暂停、又按播放，或者按了播放那条 tick 还 core-idle（还没真正走起来），
        // 都会被判成在等数据 —— 拿它拒掉的话，本人按的播放被压回暂停。
        const forced = (this.localStalled && !this.streaming) || this.stalledPeers.size > 0;
        if (forced && !snap.paused) {
          this.emit('denied', { action: 'play' });
          this._reconcile();
          return;
        }
        const prevIntended = this.intendedPaused;
        this.intendedPaused = snap.paused;
        if (snap.paused && this.streaming) {
          // 在线链接的暂停先停着、晚一点再报：可能是断流，紧跟着的 eof 被拆到了下一条 tick 里
          this._deferPause(snap, prevIntended);
        } else {
          // 游客的播放/暂停只作用于自己这一路，不广播、不动共识状态。
          if (this.canIControl()) this._broadcastSync(this._actionPosition(this._tickPosition(snap)));
          this.emit('local-action', {
            kind: snap.paused ? 'pause' : 'play',
            position: this._tickPosition(snap),
            local: !this.canIControl(),
          });
        }
      }
    }

    // 用户拖了进度条？mpv 没有独立的 seek 事件，只能看时间线有没有不连续跳变。
    // 播放器说不出位置（没有 time-pos：还没载入完，或者正在卸载 —— 关窗口时 mpv 先卸载文件再退出）、
    // 片长没了（卸载）的 tick 不参与：拿它和上一条比，控制者会把「跳到 0」广播给全房。
    // 缓冲中关窗尤其躲不开 —— 上一条停着不外推，0 和它一比就是往回拖了一大截。
    const unloaded = !Number.isFinite(snap.position) || (prev?.duration > 0 && !(snap.duration > 0));
    if (prev && !unloaded && Number.isFinite(prev.position)) {
      // 有主进程的采样时间就用它：渲染进程收到 tick 的时刻会被 IPC 排队抖动拉开，
      // 这点抖动会直接算进 1.5 秒的跳变阈值里。
      const elapsed =
        typeof snap.sampledAt === 'number' && typeof prev.sampledAt === 'number'
          ? (snap.sampledAt - prev.sampledAt) / 1000
          : (this.lastTick.at - prev.at) / 1000;
      // 上一条 tick 时位置停着（暂停、缓冲、跳转后重新起播）就不能按「在走」外推：
      // 在线链接缓冲了十秒，缓冲完的第一条 tick 会比预期落后十秒，被当成用户往回拖了进度条 ——
      // 控制者会把全房拽回他缓冲的地方，游客会被往前拽、缓冲的那段直接跳过去。
      const expected = this._advancing(prev) ? prev.position + elapsed : prev.position;
      const cmd = this._lastSeekCmd;
      const echo =
        !!cmd && this.now() - cmd.at < SEEK_ECHO_MS && Math.abs(snap.position - cmd.position) <= this.seekTolerance;
      if (!echo && Math.abs(snap.position - expected) > SEEK_DETECT_JUMP) {
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
    // 在线链接没有分片进度，卡没卡只看播放器报的缓冲（_evaluateStreamStall）
    if (!this.started || this.streaming) return;
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

    // 收完才播的人（安全模式）没收完时播放器根本没开，缓冲再少也不是「快要卡了」：
    // 让全房等他攒够 15 秒毫无意义，「仍然开始」也会被他的卡顿抵消掉。只是不自己喊停，别人的卡顿照样听。
    if (this.playAfterComplete) {
      if (this.localStalled) this._setLocalStall(false, marginSeconds ?? 0, snap.position);
      return;
    }

    // 滞回：低于 stall 线才喊停，高于 resume 线才松口。中间地带保持原状。
    if (!this.localStalled && margin < this.stallThresholdBytes) {
      this._setLocalStall(true, marginSeconds ?? 0, snap.position);
    } else if (this.localStalled && margin > this.resumeThresholdBytes) {
      this._setLocalStall(false, marginSeconds ?? 0, snap.position);
    }
  }

  /**
   * 在线链接的卡顿：缓冲交给 mpv 自己管（缺数据时它自己停下来等），这里只决定要不要让全房一起等。
   * 完全同步的控制者缓冲时全房等他；游客和手动同步的人只卡自己，房间照走 ——
   * 他们落下的那段，完全同步的游客由核对差值自动跳过去，手动同步的人自己决定。
   */
  _evaluateStreamStall(snap) {
    if (!this.started) return;
    // 「在等数据」不只是 paused-for-cache：跳转之后重新请求、重新起播那几秒（seeking，
    // 或者没暂停却 core-idle，比如刚打开链接）位置同样不动。房主跳到 5:00，网络流要好几秒才起播，
    // 这段不让房间等的话，房间时钟跑在房主前面，房主反倒要被自动对齐往前拽、跳过自己没看到的内容。
    // 打不开（loadFailed）的播放器同样没暂停、core-idle，但它不是在等 —— 永远等不来，全房不能陪着挂着。
    const waiting =
      snap.loadFailed !== true &&
      (snap.pausedForCache === true || (!snap.eof && (snap.seeking === true || (snap.idle === true && !snap.paused))));
    const holdRoom = !this._manual() && this.canIControl() && waiting;
    if (holdRoom !== this.localStalled) this._setLocalStall(holdRoom, 0, snap.position || 0);
  }

  /** 在线链接的片长：播放器报的优先，其次是解析时拿到的。0 表示不知道。 */
  _streamDuration(snap) {
    return snap.duration > 0 ? snap.duration : this.duration > 0 ? this.duration : 0;
  }

  /** 在线链接报的 eof 像不像真放完了：片长已知、位置到了片尾附近才算。片长未知（直播之类）一律不信。 */
  _streamEndPlausible(snap) {
    const duration = this._streamDuration(snap);
    return duration > 0 && (snap.position || 0) >= duration - STREAM_EOF_SLACK_SECONDS;
  }

  /** 本地文件报的 eof 位置像不像片尾：片长已知时要到片尾附近才算，片长未知时只能信它。 */
  _fileEndPlausible(snap) {
    const duration = snap.duration > 0 ? snap.duration : this.duration;
    return !(duration > 0) || (snap.position || 0) >= duration - DATA_EOF_SLACK_SECONDS;
  }

  _playbackByte(snap) {
    if (typeof snap.streamPos === 'number' && snap.streamPos > 0) return snap.streamPos;
    if (this.bytesPerSecond) return snap.position * this.bytesPerSecond;
    return 0;
  }

  /**
   * 让停在已接收内容尽头的播放器重新读一遍：跳回它停下的地方，并且先丢掉它缓存里的旧数据（reload）。
   *
   * mpv 停在 eof 那一帧上，只收到 setPause(false) 是不会回头去读新落盘的分片的 ——
   * 它一动不动，下一条 eof tick 又把卡顿置回来，两边来回抖。而 _reconcile({seekTo})
   * 按偏差判断（drift <= seekTolerance 就不动播放器），目标恰恰就是当前位置，一定被挡掉，所以要 force。
   * 光跳转也不够：缓存开着时（收完才打开的文件）mpv 跳回去照样停在 eof，先 drop-buffers 再跳才会
   * 从磁盘重新读（mpv v0.41 实测）。跳回停下的地方本身就行，不用往回多退 —— 能不能接着放取决于
   * 旧数据丢没丢，不取决于落在哪个关键帧上；多退的那一截只会让本机和房间差开。
   */
  _replayDataEnd(position) {
    const at = Math.max(0, position || 0);
    const prev = this._eofReplay;
    const same = !!prev && Math.abs(at - prev.position) <= DATA_EOF_REPLAY_SAME_SECONDS;
    this._eofReplay = { position: at, count: same ? prev.count + 1 : 1, at: this.now(), left: false };
    this._replayAt = this.now();
    this._reconcile({ seekTo: at, force: true, reload: true });
  }

  _setLocalStall(stalled, deficitSeconds, position = 0) {
    if (this.localStalled === stalled) return;
    this.localStalled = stalled;
    // 播放器说不出位置（tick 的位置是 null）时报房间时钟：STALL 里的位置不是个数的话收端整条不认
    if (!Number.isFinite(position)) position = this.sharedPositionNow();
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
    // 从「读到已接收内容的末尾」里恢复，必须让播放器重新读一遍（见 _replayDataEnd）。
    if (!stalled && this._dataEndStall) {
      this._dataEndStall = false;
      this._replayDataEnd(Number.isFinite(this.lastTick?.position) ? this.lastTick.position : position);
      return;
    }
    // 在线链接自己在等数据不改本机播放器该停该放（见 effectivePaused），不去动它：动了反倒会把本人
    // 刚在 mpv 里按的播放压回去 —— 那条 tick 常常还 core-idle，同一拍里先被判成在等数据，
    // 这一下 _reconcile 又开出回声窗口，本人的操作被整条当成回声吞掉（静音 mpv 实测 6 次里 1 次）。
    if (this.streaming) {
      this.emit('state', this.status());
      return;
    }
    this._reconcile();
  }

  _broadcastSync(position) {
    // 这一条带着此刻的暂停状态出去，还没确认的那下暂停（如果有）不用再单独报
    this._dropPendingPause();
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

  /**
   * 在线链接里播放器报「暂停了」：本机先按本人的意思停着，广播和「你 暂停」那一行等 pauseConfirmMs 再发。
   *
   * 断流时 mpv 同一刻先推 pause、再推 eof，偶尔被拆成两条 tick（主进程那边合批也有等不到的时候）——
   * 第一条看上去就是本人按了暂停，当场广播的话控制者网络一断全房就停住，重试之后房间还停着。
   * 等的这段时间里来了断流的迹象就作废，连本人「想停着」一起撤回（见 _checkPendingPause）；
   * 真人按的暂停晚这么一点同步出去。游客、手动同步的人也一样等：他们的暂停虽然只停自己，
   * 断流被当成暂停的话，重试之后播放器照样停着不动。
   */
  _deferPause(snap, prevIntended) {
    this._dropPendingPause();
    const at = this._tickPosition(snap);
    const pending = {
      seq: this.seq,
      prevIntended,
      // 位置按按下那一刻取：等的这段时间里房间还在走
      position: this._actionPosition(at),
      at,
      // 按下时本来就在缓冲：之后 paused-for-cache 还挂着不说明什么，不能拿它把真人的暂停作废
      buffering: snap.pausedForCache === true,
      timer: null,
    };
    pending.timer = setTimeout(() => this._confirmPause(pending), this.pauseConfirmMs);
    this._pendingPause = pending;
  }

  /**
   * 这一条 tick 说明刚才那下暂停不是本人按的（放到断流处、开始等数据、打不开），或者他又放起来了：作废。
   * paused-for-cache 只认暂停之后新冒出来的：在缓冲时按的暂停，它本来就挂着。
   */
  _checkPendingPause(snap) {
    const pending = this._pendingPause;
    const cacheWait = snap.pausedForCache === true && !pending.buffering;
    if (snap.eof || cacheWait || snap.loadFailed === true || !snap.paused) {
      this._dropPendingPause({ restore: true });
    }
  }

  _confirmPause(pending) {
    if (this._pendingPause !== pending) return;
    this._pendingPause = null;
    // 换了片、播放器没了，或者这期间房间 / 界面按钮已经把状态改回「播放」：这下暂停不再算数
    if (!this.started || pending.seq !== this.seq || !this.lastTick || !this.intendedPaused) return;
    if (this.canIControl()) this._broadcastSync(pending.position);
    this.emit('local-action', { kind: 'pause', position: pending.at, local: !this.canIControl() });
  }

  /**
   * 放弃还没报出去的暂停。restore：把本人「想停着」的意思一起撤回 —— 那下暂停是断流造成的，
   * 房间照走，重试之后播放器按房间状态接着放。
   */
  _dropPendingPause({ restore = false } = {}) {
    const pending = this._pendingPause;
    if (!pending) return;
    this._pendingPause = null;
    clearTimeout(pending.timer);
    if (restore) this.intendedPaused = pending.prevIntended;
  }

  /** 这条 tick 报的位置。播放器说不出位置（还没载入完、正在卸载）时报的是 null，这里改用房间时钟。 */
  _tickPosition(snap) {
    return Number.isFinite(snap?.position) ? snap.position : this.sharedPositionNow();
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
   *  - 已知房主（从邀请码 / 房间链接拿到，安卓信令模式用服务器 joined 里的 hostId，或此前已认过）：
   *    只认这个 peer 发来的表。
   *  - 尚不知道房主（兜底，现有的加入入口都拿得到房主身份）：首认为准 ——
   *    认「自称房主、且确实以该身份发消息」的第一个人，之后钉死，不再改。
   *    发送方 peerId 由 P2P 通道本身担保，冒不了别人的身份；但房里的恶意成员只要抢在真房主前面
   *    发一条就能钉住自己，所以有可信来源时一定要先把 hostId 设好。
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
    // 手动同步的人只跟真正的跳转，要拿「这条指令之前房间播到哪」来比，所以在改时钟之前取
    const seekTo = this._followTarget(msg.position, this.sharedPositionNow());
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
      this._reconcile(following && seekTo !== null ? { seekTo } : {});
      return true;
    }
    // 房间刚被别人改了：本机还没报出去的那下暂停排在它前面，不再单独报（本人的状态随房间走）
    this._dropPendingPause();
    this.intendedPaused = msg.paused;
    this._relay(msg, { ...from, origin: author, name: byName });
    this.emit('remote-action', {
      kind: msg.paused ? 'pause' : 'play',
      by: from.name,
      position: msg.position,
    });
    if (!msg.paused) this.emit('playing', { seq: this.seq });
    this._reconcile(seekTo === null ? {} : { seekTo });
    return true;
  }

  /**
   * 收到房间的同步指令时要把播放器拽到哪（null = 不动进度，只跟暂停/播放）。
   * 手动同步的人和房间差着几秒是他自己留着的，别人按一下暂停不该顺手替他对齐；
   * 真正的跳转（指令的位置和房间原先的进度对不上）照跟，否则房主跳到下一段他还留在原地。
   */
  _followTarget(position, roomBefore) {
    if (!this._manual()) return position;
    return Math.abs(position - roomBefore) > SEEK_DETECT_JUMP ? position : null;
  }

  /** 本机现在是不是「在线链接 + 手动同步」。房主是参照，没有手动同步这回事。 */
  _manual() {
    return this.streaming && this.followMode === 'manual' && this.myRole() !== 'host';
  }

  /**
   * 控制者按暂停/播放时报给全房的位置。手动同步的人报房间的位置：他可能正落后十几秒，
   * 报自己的会把全房拽回他那里。拖进度条是真的要跳，不走这里。
   */
  _actionPosition(position) {
    return this._manual() ? this.sharedPositionNow() : position;
  }

  _onRemoteStall(msg, fromPeer) {
    const from = this._originOf(msg, fromPeer);
    if (!from || from.origin === this.peerId || typeof msg.stalled !== 'boolean') return true;
    const id = from.origin;

    // 房主替已经和他断开的成员撤销卡顿。不看编号：那个人不会再经房主发消息了。
    // 撤销的只是「经房主这条路径」得知的那份：网状下我和他本人可能还直连着、他也还卡着 ——
    // 断的只是他和房主那一条。直连还在就留着，等他本人说好了（或者那条也断了，见 peerGone）。
    if (from.relayed && msg.release === true) {
      const entry = this.stalledPeers.get(id);
      if (msg.stalled !== false || !entry) return true;
      entry.via.delete(from.senderId);
      if (entry.via.size > 0) return true;
      this.stalledPeers.delete(id);
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

    // 没报原因（旧版，或者就是还在收）的条目不带这个字段
    const why = readyWhyOf(msg.ready, msg.why);
    this.readyPeers.set(id, { name: from.name, ready: msg.ready, ...(why ? { why } : {}) });
    // 转发清洗过的原因：原样转出去的话，谁都能借房主的嘴给全场塞一段任意内容
    const { why: _why, ...rest } = msg;
    const clean = why ? { ...rest, why } : rest;
    if (!this._takeReadyToken(id)) {
      // 超速：状态已经记下，事件和转发攒着，合并到一起晚一点发
      this._readyDeferred.set(id, { msg: clean, from });
      if (!this._readyTimer) this._readyTimer = setTimeout(() => this._flushReady(), READY_FLUSH_MS);
      return true;
    }
    this._readyDeferred.delete(id); // 这一条就是最新的，攒着的那条作废
    this._relay(clean, from);
    this.emit('ready-change', { who: id, name: from.name, ready: msg.ready, ...(why ? { why } : {}), self: false });
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
      this.emit('ready-change', {
        who: id,
        name: entry.name,
        ready: entry.ready,
        ...(entry.why ? { why: entry.why } : {}),
        self: false,
      });
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
  async _reconcile({ seekTo, force = false, reload = false } = {}) {
    if (!this.started) return;

    const targetPaused = this.effectivePaused;
    this._applyBegin();
    try {
      if (typeof seekTo === 'number' && this.lastTick) {
        // 按外推后的位置比：只在变化时才推 tick 的播放器（PotPlayer 每 0.5 秒才变一次），
        // 拿最后一条 tick 的原值比，播放中会平白多出几百毫秒的「偏差」。
        const drift = Math.abs(this.playerPositionNow() - seekTo);
        // force：这一跳的目的不是对时间，是逼播放器重新读一遍（它停在数据尽头不会自己
        // 去读新落盘的分片）。目标就在当前位置附近，按偏差判断必然被挡掉。
        // reload：跳之前先让播放器丢掉缓存里的旧数据（见 _replayDataEnd）
        if (force || drift > this.seekTolerance) await this.emit_seek(seekTo, reload ? { dropBuffers: true } : null);
      } else if (typeof seekTo === 'number') {
        // 播放器还没起来（lastTick 为空）。以前这里直接放弃，而 shared.position
        // 之后再没有任何路径会补下发 —— 观众的 mpv 是在收到房间位置之后才启动的，
        // 于是必然从 0:00 开始播，和房间里其他人差着半部片子。
        // 记下来，等 resyncToShared() 在播放器起来后重放。
        // 记成「和房间时钟差多少」，不记墙钟时刻：房间时钟只在没暂停、没人卡着时往前走，
        // 按墙钟外推会把这期间全房停着等人缓冲的时间也算成在播，播放器起来后跳到房间前面。
        // 同步指令的目标就是房间时钟刚定下的起点，差值是 0。
        this.pendingSeek = seekTo;
        this.pendingSeekOffset = seekTo - this.sharedPositionNow();
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
    // 目标就是房间此刻的位置：记下之后房间播了多久、停了多久，房间时钟都已经算好了。
    // 记下的位置和房间有意差着一点的，把那点差值带上。
    const offset = typeof this.pendingSeek === 'number' ? this.pendingSeekOffset : 0;
    const target = Math.max(0, this.sharedPositionNow() + offset);
    this.pendingSeek = null;
    this.pendingSeekOffset = 0;
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
    this._streamCut = false;
    // 播放器没了，刚才那下没确认的暂停分不清是不是本人按的：撤回，本机随房间走
    this._dropPendingPause({ restore: true });
  }

  /**
   * 播放器没了（用户关掉窗口、崩溃，或者上层撒手不管了）。除了忘掉它最后的状态，在线链接还要放掉
   * 本机的卡顿：它只靠 tick 解除（在线链接没有下载进度那条路），播放器没了就再也没有 tick ——
   * 控制者关掉一个正在缓冲或打不开的播放器，全房就会一直「等待 X 缓冲」。重新打开之后照常重新判定。
   */
  playerGone() {
    this.forgetPlayerState();
    if (this.streaming && this.localStalled) this._setLocalStall(false, 0, this.sharedPositionNow());
  }

  // 实际的 mpv 调用由 app.js 注入，引擎本身不直接碰 IPC
  async emit_pause(paused) {
    if (this.onSetPause) await this.onSetPause(paused);
  }

  // opts.dropBuffers：先丢掉播放器缓存里的旧数据再跳（只在数据尽头的重放里带，只有 mpv 认）
  async emit_seek(position, opts = null) {
    this._lastSeekCmd = { position, at: this.now() };
    if (this.onSeek) await (opts ? this.onSeek(position, opts) : this.onSeek(position));
  }

  /* ---------------------------- 对外接口 ---------------------------- */

  start() {
    this.started = true;
    this._reconcile();
  }

  /** 用户点了 UI 上的播放/暂停（不是在 mpv 窗口里点的）。 */
  userSetPaused(paused) {
    // 界面上按的这一下比播放器里那下还没报出去的暂停新
    this._dropPendingPause();
    this.intendedPaused = paused;
    // 游客：只暂停/播放自己这一路，不广播、不动共识。
    // 播放器没开着（比如刚关掉）时按的是界面上的按钮，这时报 0 会把全房拉回片头 —— 用房间时钟。
    if (this.canIControl()) {
      this._broadcastSync(this._actionPosition(this.playerPositionNow() ?? this.sharedPositionNow()));
    }
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

  /* ------------------------ 在线链接的跟随方式 ------------------------ */

  /**
   * 当前项是不是在线链接，以及本机选的跟随方式（'full' 完全同步 / 'manual' 手动同步）。
   * 上层在换片之后、用户改了选择时调用。
   */
  setFollow({ streaming = this.streaming, mode = this.followMode } = {}) {
    const nextStreaming = !!streaming;
    const nextMode = mode === 'manual' ? 'manual' : 'full';
    if (nextStreaming === this.streaming && nextMode === this.followMode) return;
    this.streaming = nextStreaming;
    this.followMode = nextMode;
    this._resetDrift();
    // 改成手动同步时自己正让全房等着：放开，手动同步的人缓冲只卡自己
    if (this.streaming && this.lastTick) this._evaluateStreamStall(this.lastTick);
    this.emit('drift', this.driftStatus());
  }

  /** 供 UI：{state: 'ok'|'out'|'failed', seconds（本机减房间，负数是落后）, mode, streaming} */
  driftStatus() {
    return {
      state: this._drift.state,
      seconds: this._drift.seconds,
      mode: this.followMode,
      streaming: this.streaming,
    };
  }

  /**
   * 核对本机和房间差多少秒。由上层每秒调一次 —— 播放器静止时不推 tick，光靠 tick 看不出差距在变大。
   * 房间的进度就是房间时钟（房主和管理员的指令定下的，房主自己也跟着它走）。
   */
  checkDrift() {
    if (!this.streaming || !this.started) return;
    const t = this.lastTick;
    // 正在跳转、缓冲、重新起播，或者放到头了：此刻的位置说明不了什么，维持上一次的判断。
    // 打不开的播放器也不去拽它（跳转发给一个 idle 的 mpv 什么都不会发生）；说不出位置的（还没载入完、正在卸载）同理
    if (!t || t.seeking || t.pausedForCache || t.eof || t.loadFailed || (t.idle && !t.paused) || this.applying) return;
    if (!Number.isFinite(t.position)) return;
    // 自己按了暂停、只停自己（游客）：这是有意和房间分开，不算没对上
    if (this.intendedPaused !== this.shared.paused) {
      this._driftOver = 0;
      this._setDrift('ok', 0);
      return;
    }
    const room = this.sharedPositionNow();
    // 房间时钟到片尾就封顶了，再往后的差值没有意义
    if (this.duration > 0 && room >= this.duration - DRIFT_OUT_SECONDS) return;
    const drift = this.playerPositionNow() - room;
    const now = this.now();

    // 上一次自动对齐落地之后的第一次核对：还差多少就是这个网站跳转要花的时间，下次多跳这么多
    const probe = this._leadProbe;
    if (probe && now - probe.at >= 1000) {
      this._leadProbe = null;
      if (probe.running && this._clockRunning() && now - probe.at < DRIFT_LEAD_PROBE_MS) {
        this._seekLead = Math.min(DRIFT_LEAD_MAX_SECONDS, Math.max(0, this._seekLead - drift));
      }
    }

    const off = Math.abs(drift);
    if (off <= DRIFT_BACK_SECONDS) {
      this._driftOver = 0;
      this._setDrift('ok', 0);
      return;
    }
    if (off <= DRIFT_OUT_SECONDS) {
      // 滞回区：维持原来的判断，只更新数字
      this._driftOver = 0;
      if (this._drift.state !== 'ok') this._setDrift(this._drift.state, drift);
      return;
    }
    if (++this._driftOver < DRIFT_CONFIRM_CHECKS) return;
    if (this._manual()) {
      // 刚点过「同步到房主」、落地还没对上：用刚学到的提前量补跳一次，一次点到位
      if (this._chase > 0 && now - this._correctAt < DRIFT_CHASE_MS) {
        if (now - this._correctAt < DRIFT_CORRECT_COOLDOWN_MS) return;
        this._chase--;
        this._correctToRoom();
        return;
      }
      this._chase = 0;
      this._setDrift('out', drift);
      return;
    }

    // 完全同步：自动跳到房间的位置。往前追了好几次还是落后，就停手一阵子，把差多少秒报出去
    if (this._drift.state === 'failed') {
      this._setDrift('failed', drift);
      if (now - this._failedAt < DRIFT_FAIL_BACKOFF_MS) return;
    }
    if (now - this._correctAt < DRIFT_CORRECT_COOLDOWN_MS) return;
    if (drift < 0) {
      this._corrections = this._corrections.filter((at) => now - at < DRIFT_FAIL_WINDOW_MS);
      if (this._corrections.length >= DRIFT_FAIL_COUNT) {
        this._corrections = [];
        this._failedAt = now;
        this._setDrift('failed', drift);
        return;
      }
      this._corrections.push(now);
    }
    this.emit('drift-correct', { seconds: drift });
    this._correctToRoom();
  }

  /**
   * 用户点了「同步到房主」（或在播放器里按了快捷键）：立刻跳到房间的位置，
   * 自己单独按过的暂停也一并回到房间的状态。两种跟随方式都能用。
   */
  syncToRoom() {
    if (!this.streaming || !this.started || !this.lastTick) return false;
    this._dropPendingPause();
    this.intendedPaused = this.shared.paused;
    this._corrections = [];
    this._failedAt = 0;
    this._setDrift('ok', 0);
    this._correctToRoom();
    this._chase = 1;
    return true;
  }

  _correctToRoom() {
    const running = this._clockRunning();
    let target = this.sharedPositionNow() + (running ? this._seekLead : 0);
    if (this.duration > 0) target = Math.min(target, this.duration);
    this._correctAt = this.now();
    this._driftOver = 0;
    this._leadProbe = { at: this._correctAt, running };
    this._reconcile({ seekTo: target, force: true });
  }

  _resetDrift() {
    this._drift = { state: 'ok', seconds: 0 };
    this._driftOver = 0;
    this._corrections = [];
    this._correctAt = 0;
    this._failedAt = 0;
    this._leadProbe = null;
    this._chase = 0;
  }

  /** 差值按整秒报，没变就不发事件（每秒核对一次，别每次都让界面重画）。 */
  _setDrift(state, seconds) {
    const rounded = state === 'ok' ? 0 : Math.round(seconds);
    if (state === this._drift.state && rounded === this._drift.seconds) return;
    this._drift = { state, seconds: rounded };
    this.emit('drift', this.driftStatus());
  }

  /**
   * 本机对当前项准备好了没有（由上层判断：文件到位、扫描通过、播放器能起来……）。
   * why 是没准备好的原因（READY_WHY 之一，别的一律不带）。
   * 只在变化时广播（原因变了也算），返回是否真的变了。游客也发：就绪不是控制指令。
   */
  setLocalReady(ready, why = null) {
    const next = !!ready;
    const reason = readyWhyOf(next, why);
    if (next === this.localReady && reason === this.localReadyWhy) return false;
    this.localReady = next;
    this.localReadyWhy = reason;
    this.emit('outbound', {
      t: MSG.READY,
      seq: this.seq,
      ready: next,
      ...(reason ? { why: reason } : {}),
      peerId: this.peerId,
      name: this.name,
      readySeq: ++this._readySeqOut,
    });
    this.emit('ready-change', {
      who: this.peerId,
      name: this.name,
      ready: next,
      ...(reason ? { why: reason } : {}),
      self: true,
    });
    return true;
  }

  /** 供上层判断「是不是全员就绪」：自己的，加上已知的每个人的（没准备好的带上原因，有的话）。 */
  readySnapshot() {
    return {
      self: this.localReady === true,
      peers: [...this.readyPeers].map(([peerId, v]) => ({
        peerId,
        name: v.name,
        ready: v.ready,
        ...(v.why ? { why: v.why } : {}),
      })),
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
          ...(entry.why ? { why: entry.why } : {}),
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
      ...(this.localReady === false && this.localReadyWhy ? { why: this.localReadyWhy } : {}),
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
  SEEK_ECHO_MS,
  STREAM_PAUSE_CONFIRM_MS,
  DRIFT_OUT_SECONDS,
  DRIFT_BACK_SECONDS,
  DRIFT_CORRECT_COOLDOWN_MS,
  DRIFT_FAIL_COUNT,
  DRIFT_FAIL_WINDOW_MS,
  DRIFT_FAIL_BACKOFF_MS,
  DRIFT_LEAD_MAX_SECONDS,
  DRIFT_CHASE_MS,
  STREAM_EOF_SLACK_SECONDS,
  MAX_NAME,
  LAMPORT_WINDOW,
  LAMPORT_LEAD,
};
