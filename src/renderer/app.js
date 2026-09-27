import { Peer } from './lib/peer.js';
import { Swarm } from './lib/swarm.js';
import { SyncEngine } from './lib/syncEngine.js';
import { MSG, PROTOCOL_VERSION, normalizePlatform, platformOfOs, randomId } from './lib/protocol.js';
import { encodeCode, decodeCode, shareLink, WsSignaling, randomRoomId, randomPeerId } from './lib/signaling.js';
import { RelaySignaling, DEFAULT_RELAYS, newRoomSecret } from './lib/relaySignaling.js';
import { currentLocale, setLocale, startI18n, translate as t } from './lib/i18n.js';
import {
  applyOp,
  catalogOf,
  createPlaylist,
  currentItem,
  findItem,
  isItemReady,
  markSources,
  markStarted,
  referencedFileIds,
  reorderIds,
  transferOrder,
  validateSnapshot,
  waitingFor,
} from './lib/playlist.js';
import { SCAN_RESUMABLE, decideScanOutcome, needsScan, pickScanTarget, shouldPreempt } from './lib/scanPolicy.js';
import { PlayerGate } from './lib/playerGate.js';
import { hasAnyMissing } from './lib/transferSources.js';
import { BURST_TOKENS, ChatGate, ChatHistory, ChatSender, clampName, numberDuplicateNames, parseHistory, trustsRelay } from './lib/chat.js';
import { DanmakuEngine } from './lib/danmaku.js';
import { $, make, rawText, replace } from './ui/dom.js';
import { createPlaylistPanel } from './ui/playlistPanel.js';
import { buildActivity, activityKey, loadPresenceSettings, savePresenceSettings } from './ui/discordPresence.js';
import {
  DANMAKU_CANVAS,
  VIEW_LIMIT,
  createChatPanel,
  createDanmakuControls,
  createDanmakuPump,
  loadDanmakuSettings,
  saveDanmakuSettings,
} from './ui/chatPanel.js';
import {
  adviseConnection,
  buildIceServers,
  detectSymmetricNat,
  normalizeTurnInput,
  parseSdpCandidates,
  peerIceConfig,
  relayServer,
  summarizeCandidates,
  turnMissingCredentials,
} from './lib/ice.js';
import { RelayUsageMeter, cloudflareRelayPairs, onlyCloudflareRelays } from './lib/turnUsage.js';
import {
  bitrateOf,
  bufferLead,
  forecastStall,
  hostPrecheck,
  resumeLead,
  viewersSupported,
  worstWaitSeconds,
  RateMeter,
} from './lib/stallForecast.js';
import { unpackBitfield } from './lib/protocol.js';

startI18n();

/**
 * UI 与编排层。把存储、传输、调度、同步、播放器串起来。
 *
 * 两条连接路径：
 *  - manual（极简模式）：复制粘贴 SDP，零服务器。星型拓扑 —— 每个人都只连发起者。
 *  - server（信令模式）：走 WebSocket 信令，全互联网状拓扑，谁都能给谁供片。
 */

const randomInt = (min, max) => {
  const value = crypto.getRandomValues(new Uint32Array(1))[0];
  return min + (value % (max - min + 1));
};
const HEAD_READY_BYTES = 8 * 1024 * 1024;
// 可信房间的就绪门槛：起播点往后还要有这么多连续内容（从片头起播时起播点就是 0）。
// 和同步引擎的恢复线取同一个数：起播那一刻就低于恢复线的话，第一帧还没画出来就该暂停了。
const START_RUN_SECONDS = 15;
// 解复用器的预读。实测 mpv 的 demuxer-cache-time 常年领先 time-pos 约 1.7 秒，
// 余量盖不住它，播放头还没到连续区尽头，解复用器就先读到那里并报 EOF。
const DEMUX_READAHEAD_SECONDS = 2;
const MIN_START_RUN_BYTES = 4 * 1024 * 1024; // 码率未知时的兜底
const normalizeSecurityMode = (mode) => (mode === 'trusted' ? 'trusted' : 'safe');
const securityModeLabel = (mode) => t(normalizeSecurityMode(mode) === 'trusted' ? '可信房间' : '安全模式');

function field(label, ...children) {
  return make('div', { className: 'field' }, [make('label', { text: label }), ...children]);
}

function hint(...children) {
  return make('p', { className: 'hint' }, children);
}

const S = {
  peerId: randomPeerId(),
  name: (localStorage.getItem('sw.name') || t(`观众-${randomInt(100, 999)}`)).slice(0, 40),
  mode: null, // 'manual' | 'server'
  // 有信令时走哪种传输：'ws' 自建信令服务器，'relay' 房间链接（公共 Nostr 中继）
  signalTransport: null,
  roomLink: null, // 房间链接模式下那条 https 链接（房主生成的；观众进房后按同样内容重建）
  // 房主这场实际连着的信令服务器地址和公共中继（null = 内置那组）。设置里的这两项房间进行中也能改，
  // 编邀请码、换链接时必须用这里记下的，不能现读设置
  roomSignalUrl: null,
  roomRelays: null,
  discord: loadPresenceSettings(), // Discord 状态显示的本机设置，默认关
  discordStatus: 'idle',
  role: null, // 'host' | 'guest'（发起 or 加入，跟权限角色是两回事）
  hostId: null, // 房主的 peerId —— 角色权威只认它，从邀请码得来
  env: null,
  geo: null,
  swarm: null,
  sync: null,
  signaling: null,
  manifest: null,
  sourceType: null, // 'file' | 'link'
  linkInfo: null,
  syncStarted: false,
  sessionId: null,
  filePath: null,
  isSeeder: false,
  mpvRunning: false,
  switchingMedia: false,
  mediaSafety: { sessionId: null, status: 'idle' },
  // 播放列表。房主手里的是权威版本，其他人手里的是最近一次收到的快照。
  playlist: createPlaylist(),
  // 当前项（queue[0]）和它的序号。上面的 manifest / sessionId / filePath / isSeeder /
  // sourceType / linkInfo / mediaSafety 都是「当前项」的镜像，见 syncCurrentMirrors()。
  current: null,
  currentSeq: -1,
  // 「你是中途加入的」这句话每一部只说一次，记的是说过的那一部的 seq
  midJoinNoted: -1,
  // 「中途加入但算不出房间位置」同理，每一部只说一次
  midJoinBlindNoted: -1,
  // 本机的媒体会话，按 fileId 记
  sessions: new Map(),
  // 正在加进列表、还没被列表引用的片（这期间不能被当成没人要的会话关掉）
  pendingAdds: new Set(),
  // 正在开接收会话的 fileId；清单要不到时下次重试的时间；校验过的清单
  opening: new Set(),
  manifestRetryAt: new Map(),
  knownManifests: new Map(),
  // 扫描确认有威胁、已经销毁的片，这个房间里不再接收；磁盘放不下的片
  blockedFiles: new Set(),
  diskFull: new Set(),
  // 本机解析过的链接（按规范化后的地址）；房主给的临时播放地址 {seq, playback}
  links: new Map(),
  nowLink: null,
  linkFailedSeq: null,
  // 当前这部链接解析成功了，本机播放器却放不了：{seq, kind: 'load'（打不开）| 'cut'（半路断了）, ...}。
  // 本机不再挡着全房（见 syncEngine 的 loadFailed / stream-cut），行内和状态栏给「重试」
  linkPlayFailed: null,
  // 正在「重试」的那一部的 seq（见 retryCurrentLink）
  linkRetrying: null,
  // 本房间里已经允许过的网站，同一个站点只问一次
  approvedSites: new Set(),
  // 本机自己提交过的链接（规范化后的地址）。只有这些不用再问 —— 快照里的 addedBy 是房主写的，不能拿来免问
  myLinks: new Set(),
  // 当前项本机解析失败、房主给的临时播放地址来自没允许过的网站，正等本人点头：{seq, origin, host}
  fallbackConsent: null,
  // 房主替管理员挂出来的清单（fileId）。条目不在列表里了就撤回，别一直占着内存、还回给来要的人
  hostOffered: new Set(),
  // 可信房间里当前这部收不齐、只是还能从别人那里补一段时的槽位（补完了要及时让给后面的片）
  partialSlot: null,
  // 发给房主、还没回音的列表操作：reqId -> 回调
  pendingOps: new Map(),
  // 上一个播放器的退出过程。关会话前要等它，不然文件还被占着删不掉。
  playerQuit: Promise.resolve(),
  // 正在收尾的会话（关文件、删缓存）和在途的接收会话打开请求。离开房间要等它们做完再刷新页面。
  closing: new Set(),
  leechOpens: new Set(),
  // 正在离开房间：在途打开的接收会话一律直接关掉
  leaving: false,
  // 房间里正在准备的本地片（行内进度）和正在解析的链接
  prepJobs: [],
  // 正在跑的准备任务：离开房间时要等它们收尾，转封装产物的回收在任务的后半截
  prepRuns: new Set(),
  // 加片等房主回音超时之后的宽限期 fileId -> 到期时间戳：房主可能只是排队还没处理到
  addGrace: new Map(),
  // 本机跳过的链接项（item id）：跳过也算准备好，不挡别人
  skippedLinks: new Set(),
  // 当前项是没允许过的网站、正等本人点「允许 / 跳过」时，记下问的是哪一部、哪个网站：
  // {seq, id, origin, host, at}。只记 seq 的话，房主不换 seq、只把同一 id 的网址换掉，
  // 屏幕上还写着旧网站，点下去批准的却是新网站
  linkConsent: null,
  // 正在提前解析的下一部链接
  resolvingLinks: new Set(),
  // 房主：这一部是自动连播或「立即播放」换上来的，大家都准备好就自动开播
  autoStartSeq: null,
  // 上膛的原因：'playNow' 是明说要放（自动连播关着也照放），'auto' 跟着自动连播开关走
  autoStartReason: null,
  // 房主已经离开（信令模式下成员之间还连着，列表暂停更新）
  hostGone: false,
  // 和房主的直连断了但还在重连：人没走，别说成「房主已离开」
  hostLink: null,
  roomCapacity: Math.max(2, Math.min(16, Number(localStorage.getItem('sw.roomCapacity')) || 4)),
  roomSecurityMode: null,
  pendingManualPeer: null,
  // 房主选片时测得的上行带宽 { bytesPerSec, measuredAt }，房主面板用它算「最多能流畅供几个人」。
  uplinkEstimate: null,
  // 聊天。gate 管收端（先去重再扣令牌、只认房主转发来的 origin），sender 管发端
  // （房间输入框和播放器里的输入条共用一把令牌桶），history 只有房主用得上。
  // names 得自己留一份：peer-gone 时 swarm 的 peers 表已经清空，再也查不出「走的是谁」。
  // leaving 是还没说出口的「X 离开了房间」（见 noteLeaveLater），acks 是自己发的消息等房主回执的定时器。
  chat: {
    entries: [],
    gate: new ChatGate(),
    sender: new ChatSender(),
    history: new ChatHistory(),
    names: new Map(),
    leaving: new Map(),
    acks: new Map(),
    historyShown: false,
    notice: '',
    /**
     * 往聊天流里记一行系统事件。入口挂在 S 上，而不是让各处直接去够模块作用域里的 chatSystem：
     * 换片、进出房、谁按了暂停这几个路口散在整个文件里，从 S 出发才能把「聊天相关的一切」找齐。
     */
    note: (text) => chatSystem(text),
  },
  // 本机弹幕设置（开关、不透明度、字号、速度、显示区域），存 localStorage，只影响自己
  danmakuSettings: loadDanmakuSettings(),
  // 30Hz 帧循环，进房之后才有；同样挂在 S 上，换片和退播放器那几处才够得着
  danmaku: null,
  // 播放器。playerChoice 是用户选的（主进程配置里那份的镜像），playerKind 是这一代
  // 实际在跑的那个 —— 两者不一致时 playerFallback 记着代号原因（还没收完、没找到…），
  // 控制条上要把「当前实际使用」说出来，否则用户只会以为选择没生效。
  playerChoice: 'mpv',
  playerList: [],
  playerKind: 'mpv',
  playerFallback: '',
  switchingPlayer: false,
  // relaunchWithPlayer 正在「退旧的 → 起新的」：这段时间 S.mpvRunning 是 false，
  // 别的起播请求（供片的 progress、扫描通过…）一律让位，否则会抢先拉起一个，把这次切换挤成「失败」。
  // 期间换了片、拦下威胁、改做种都会再退一次播放器（retirePlayer），独占随之作废，轮到它们起播
  relaunchingPlayer: false,
  // 这一部（记的是 seq）不再自动拉起播放器：用户自己关掉了它、在外部播放器里换了别的片让我们撒了手、
  // 或者这一部起播失败了。供片时每发出一片都会走一遍 maybeLaunchPlayer，不挡的话关一次弹一次。
  // 用户点「重新打开」（起播成功）、换到下一部（seq 变了）、会话重新就绪时作废。
  noAutoLaunchSeq: null,
  settings: {
    language: currentLocale(),
    securityMode: localStorage.getItem('sw.securityMode') === 'safe' ? 'safe' : 'trusted',
    signalUrl: localStorage.getItem('sw.signalUrl') || 'ws://localhost:8080',
    // 房间链接用的公共中继；空串表示用内置那一组（lib/relaySignaling.js 的 DEFAULT_RELAYS）
    relays: localStorage.getItem('sw.relays') || '',
    stun: localStorage.getItem('sw.stun') || 'stun:stun.l.google.com:19302',
    turnUrl: localStorage.getItem('sw.turnUrl') || '',
    turnUser: localStorage.getItem('sw.turnUser') || '',
    turnPass: localStorage.getItem('sw.turnPass') || '',
    turnEnabled: localStorage.getItem('sw.turnEnabled') !== '0',
    // TURN 从哪来：'manual' 自己填（上面那几项），'cloudflare' 用自己的 Cloudflare 账号自动生成
    turnSource: localStorage.getItem('sw.turnSource') === 'cloudflare' ? 'cloudflare' : 'manual',
    // 隐藏我的 IP：只经 TURN 中继连接。默认关
    relayOnly: localStorage.getItem('sw.relayOnly') === '1',
    // 在线链接怎么跟房主：'full' 完全同步（默认），'manual' 手动同步。每个成员自己选，只存在本机
    linkSync: localStorage.getItem('sw.linkSync') === 'manual' ? 'manual' : 'full',
    // 边下边播：放到的每一部另存一份到下载位置（和缓存是两回事）。默认关，只存在本机
    downloadWhileWatching: localStorage.getItem('sw.downloadWhileWatching') === '1',
  },
  // 缓存清理方式和下载位置 { mode: 'auto'|'manual', keptDir, downloadDir }，主进程说了算（见 cache:policy）
  cachePolicy: null,
  // 在线视频的手动缓存：linkKey(url) -> { url, purpose: 'cache', title, state: queued|downloading|done|failed|canceled, downloaded, total, error }
  linkCaches: new Map(),
  // 边下边播的在线视频下载，结构同上（purpose: 'download'）
  linkDownloads: new Map(),
  // 边下边播要另存、还没存上的 P2P 片（fileId）；收完并扫描过关时存（见 maybeSaveDownload）
  downloadWanted: new Set(),
  downloadSaving: new Set(),
  // Cloudflare 的临时 TURN 账号 { urls, username, credential, expiresAt }，主进程生成，这里只缓存。
  // API Token 永远不到渲染进程来。
  cfTurn: null,
  // 主进程报来的 Cloudflare TURN 状态 { configured, expiresAt, lastError }（设置页显示用）
  cfTurnState: null,
  // 本月本机统计的用量 { month, usedBytes, limitGB, exceeded, nearLimit }
  cfTurnUsage: null,
};

// 只收当前这一代播放器的事件，见 lib/playerGate.js
const playerGate = new PlayerGate();

/* ------------------------------- 工具函数 ------------------------------- */

const fmtBytes = (b) => {
  if (!b || b < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};

const fmtRate = (bps) => (bps > 0 ? `${fmtBytes(bps)}/s` : '—');
/**
 * 字节/秒 → Mbps。码率、带宽、速度三个数要摆在一起比，必须同一个单位；
 * 视频码率和宽带套餐都习惯按 Mbps 说，就统一成 Mbps。
 */
const fmtMbps = (bytesPerSec) => {
  if (!(bytesPerSec > 0)) return '—';
  const mbps = (bytesPerSec * 8) / 1e6;
  return `${mbps >= 10 ? mbps.toFixed(0) : mbps >= 1 ? mbps.toFixed(1) : mbps.toFixed(2)} Mbps`;
};
const clampCapacity = (value) => Math.max(2, Math.min(16, Number.parseInt(value, 10) || 4));
/** 设置里存的「新房间默认人数上限」。房间里的实时上限是 S.roomCapacity，两者不是一回事。 */
function storedCapacity() {
  return Math.max(2, Math.min(16, Number(localStorage.getItem('sw.roomCapacity')) || 4));
}
// 昵称的长度上限，和 swarm / 信令服务器截断的一样。邀请码、应答码、第三方信令服务器
// 带来的昵称都没经过它们，一条几百 KB 的深链接能把一个「名字」撑满整页。
// 清洗和握手、改名走同一个 clampName：只截断的话，双向覆盖字符、换行照样能进日志和成员表
const MAX_PEER_NAME = 40;
const peerName = (name, fallback = '') => clampName(name) || String(fallback ?? '').slice(0, MAX_PEER_NAME);

function connectedPeerCount() {
  return (S.swarm?.peerList() || []).filter(
    (p) => p.authenticated && (p.state === 'connected' || p.state === 'completed')
  ).length;
}

async function copyCode(code, button, idleLabel = '复制邀请码') {
  try {
    await Promise.resolve(window.sw.clipboard.writeText(code));
    button.textContent = `已复制完整 ${code.length} 字符 ✓`;
    setTimeout(() => (button.textContent = idleLabel), 1800);
  } catch (e) {
    button.textContent = '复制失败，请手动全选';
    log(`复制邀请码失败：${e.message || e}`, 'bad');
  }
}

const fmtTime = (s) => {
  if (!s || !isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
};

function show(viewId) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  $(viewId).classList.add('active');
  $('topbar').classList.toggle('hidden', viewId === 'view-boot');
}

function log(text, kind = '') {
  const el = $('event-log');
  if (!el) return;
  const line = document.createElement('div');
  line.className = `log-line ${kind}`;
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  line.append(make('span', { className: 'log-time', text: t }), make('span', { text }));
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  while (el.children.length > 300) el.removeChild(el.firstChild);
}

/**
 * ICE 配置。细节都在 lib/ice.js：
 *  - 只填一台 STUN 时自动补两台兜底。一台服务器不通就完全拿不到公网地址，
 *    跨 NAT 必然失败，而用户看到的只是「连不上」。填多台就完全按用户写的来。
 *  - TURN 地址自动展开成 UDP + TCP 两条。酒店和公司网络常常只放行 TCP，
 *    那里只声明 UDP 的中继等于没配。
 *
 * TURN 依旧需要用户自己提供 —— 自己填服务器，或者用自己的 Cloudflare 账号自动生成临时账号。
 * 中继要花真金白银的带宽，我们不代运营。
 *
 * 「隐藏我的 IP」（S.settings.relayOnly）打开时只经 TURN 中继连接、不带 STUN。
 * 这时没有可用中继就不建连接（relayOnlyBlocked / peerIce），绝不悄悄退回直连。
 */
let turnWarned = false;

/** 组 ICE 配置要的全部输入：设置、Cloudflare 的临时账号（本月用量到上限时当它不存在）、此刻的时间。 */
function iceInputs() {
  return { ...S.settings, cfTurn: S.cfTurnUsage?.exceeded ? null : S.cfTurn, now: Date.now() };
}

function iceServers() {
  // 以前存下的设置可能就是「开了中继、没填密码」：这种中继 buildIceServers 不会交出去，
  // 在日志里说一声，别让人以为中继在工作
  if (!turnWarned && turnMissingCredentials(S.settings)) {
    turnWarned = true;
    log('TURN 中继开着但没填用户名或密码，这次先不走中继、只尝试直连。到设置里补全，或者把中继关掉。', 'warn');
  }
  return buildIceServers(iceInputs());
}

const RELAY_ONLY_NO_TURN = '已打开「隐藏我的 IP」，但还没有可用的 TURN 中继：请在设置里配好 TURN，或者先关掉这个开关。';

/** Cloudflare TURN 本月用量到了上限时的说法。 */
function cfQuotaText(limitGB = S.cfTurnUsage?.limitGB) {
  return `本月 Cloudflare TURN 用量已到你设的上限（${limitGB || '?'} GB），为免扣费已停用；下个月 1 日自动恢复，或者在设置里调高上限`;
}

/**
 * 「隐藏我的 IP」开着、却没有可用的 TURN 中继时，拦下连接的原因；不拦返回空串。
 * 这时绝不能悄悄退回直连 —— 那就等于把 IP 交出去了。
 */
function relayOnlyBlocked() {
  if (!S.settings.relayOnly || peerIceConfig(iceInputs())) return '';
  if (S.settings.turnSource === 'cloudflare' && S.cfTurnUsage?.exceeded) {
    return `${cfQuotaText()}。「隐藏我的 IP」开着，没有中继就不连接。`;
  }
  return RELAY_ONLY_NO_TURN;
}

/**
 * 建 Peer 用的 { iceServers, iceTransportPolicy }。app.js 里所有 new Peer 都从这里拿。
 * 「隐藏我的 IP」开着时策略是 'relay'（只收集中继候选）；没有可用中继就抛错，不建连接。
 */
function peerIce() {
  if (!S.settings.relayOnly) return { iceServers: iceServers(), iceTransportPolicy: 'all' };
  const config = peerIceConfig(iceInputs());
  if (!config) throw new Error(relayOnlyBlocked() || RELAY_ONLY_NO_TURN);
  return config;
}

/** 信令事件里建连接用：被「隐藏我的 IP」拦下时记一条日志、返回 null，调用方不建连接。 */
function signalPeerIce() {
  try {
    return peerIce();
  } catch (error) {
    sigLog('relay-only', error.message || String(error), 'bad');
    return null;
  }
}

/* ---------------------------- Cloudflare TURN ---------------------------- */

// 临时账号离过期不到两小时就换一组新的（主进程那边的缓存本来就提前一小时算过期）
const CF_REFRESH_BEFORE_MS = 2 * 60 * 60 * 1000;
// 取账号失败后这么久之内不再去取：网络不通时别让每建一条连接都干等十秒
const CF_RETRY_MS = 30_000;
const CF_MIN_TIMER_MS = 60_000;
let cfTurnFetch = null;
let cfTurnRetryAt = 0;
let cfTurnTimer = null;
let cfQuotaLogged = false;

/** 主进程报错里的代码（CF_NETWORK 这类）。参数校验的「无效的 xxx」也归成格式不对。 */
function cfErrorCode(error) {
  const text = String(error?.message || error || '');
  const m = /\[(CF_[A-Z_]+)\]/.exec(text);
  if (m) return m[1];
  return /无效的/.test(text) ? 'CF_INVALID_INPUT' : '';
}

const CF_ERROR_TEXT = {
  CF_UNAUTHORIZED: '未授权：Cloudflare 不认这组 Turn Token ID 和 API Token',
  CF_NETWORK: '网络不通：连不上 Cloudflare',
  CF_BAD_RESPONSE: 'Cloudflare 的回应看不懂',
  CF_NOT_CONFIGURED: '还没保存 Cloudflare 凭据',
  CF_NO_ENCRYPTION: '本机的加密服务不可用，不能安全地保存 API Token',
  CF_INVALID_INPUT: 'Turn Token ID 或 API Token 的格式不对',
};

function cfErrorText(code) {
  if (code === 'CF_QUOTA') return cfQuotaText();
  return CF_ERROR_TEXT[code] || '出错了';
}

/** 来源是 Cloudflare、手上的临时账号没有或离过期不到两小时：建连接之前得先去取一组。 */
function turnFetchNeeded() {
  if (S.settings.turnSource !== 'cloudflare') return false;
  if (S.cfTurn && S.cfTurn.expiresAt - Date.now() > CF_REFRESH_BEFORE_MS) return false;
  return Boolean(cfTurnFetch) || Date.now() >= cfTurnRetryAt;
}

/** 本月用量到了上限：手上的临时账号作废，新建的连接不再带 Cloudflare TURN。只在日志里说一次。 */
function markCfQuota(limitGB) {
  S.cfTurn = null;
  clearTimeout(cfTurnTimer);
  cfTurnTimer = null;
  S.cfTurnUsage = { ...(S.cfTurnUsage || {}), exceeded: true, ...(limitGB ? { limitGB } : {}) };
  if (!cfQuotaLogged && S.settings.turnSource === 'cloudflare') {
    cfQuotaLogged = true;
    log(cfQuotaText(), 'bad');
  }
}

/**
 * 把 Cloudflare 的临时 TURN 账号备好。来源不是 Cloudflare、或者手上的还新鲜时什么都不做。
 * 每次开房、邀请、加入真正建连接之前都要先过这一步（见各处的 turnFetchNeeded 判断）。
 *
 * 取不到也不抛错：没开「隐藏我的 IP」就记一条日志、照常直连（TURN 本来就是兜底）；
 * 开了的话，紧接着的 relayOnlyBlocked() 会把连接拦下。同时只发一个请求。
 */
async function ensureTurnReady() {
  if (!turnFetchNeeded()) return;
  if (!cfTurnFetch) {
    cfTurnFetch = (async () => {
      try {
        const creds = await window.sw.turn.cfCredentials({ minValidMs: CF_REFRESH_BEFORE_MS });
        S.cfTurn = {
          urls: [...creds.urls],
          username: creds.username,
          credential: creds.credential,
          expiresAt: creds.expiresAt,
        };
        cfTurnRetryAt = 0;
        cfQuotaLogged = false;
        // 主进程肯发账号，说明这个月没到上限（跨了月、或者上限调高了）
        if (S.cfTurnUsage?.exceeded) S.cfTurnUsage = { ...S.cfTurnUsage, exceeded: false };
        S.cfTurnState = { ...(S.cfTurnState || {}), configured: true, expiresAt: creds.expiresAt, lastError: null };
        scheduleCfTurnRefresh();
      } catch (error) {
        cfTurnRetryAt = Date.now() + CF_RETRY_MS;
        const code = cfErrorCode(error) || 'CF_NETWORK';
        S.cfTurnState = { ...(S.cfTurnState || {}), lastError: code };
        if (code === 'CF_QUOTA') {
          markCfQuota(Number(/（(\d+) GB）/.exec(String(error?.message || ''))?.[1]) || 0);
        } else if (S.settings.relayOnly) {
          log(`Cloudflare TURN 账号没拿到：${cfErrorText(code)}`, 'bad');
        } else {
          log(`Cloudflare TURN 账号没拿到（${cfErrorText(code)}），这次先不走中继、只尝试直连`, 'warn');
        }
      } finally {
        cfTurnFetch = null;
        renderCfTurnStatus();
      }
    })();
  }
  await cfTurnFetch;
}

/** 离过期不到两小时时自己换一组，不等下一次建连接。 */
function scheduleCfTurnRefresh() {
  clearTimeout(cfTurnTimer);
  cfTurnTimer = null;
  if (S.settings.turnSource !== 'cloudflare' || !S.cfTurn || !(S.cfTurn.expiresAt > Date.now())) return;
  const wait = Math.max(CF_MIN_TIMER_MS, S.cfTurn.expiresAt - CF_REFRESH_BEFORE_MS - Date.now());
  cfTurnTimer = setTimeout(async () => {
    cfTurnTimer = null;
    await ensureTurnReady().catch(() => {});
    scheduleCfTurnRefresh();
  }, wait);
}

/** 用量（主进程报来的）：第一次过 80% 在日志里提醒一次；到上限就停用 Cloudflare TURN。 */
function applyCfUsage(usage) {
  if (!usage || typeof usage !== 'object') return;
  const wasExceeded = Boolean(S.cfTurnUsage?.exceeded);
  S.cfTurnUsage = usage;
  if (usage.crossedWarn) {
    log(`本月 Cloudflare TURN 用量已超过你设的上限的 80%（${fmtGB(usage.usedBytes)} / ${usage.limitGB} GB）`, 'warn');
  }
  if (usage.exceeded && !wasExceeded) markCfQuota(usage.limitGB);
  if (!usage.exceeded && wasExceeded) cfQuotaLogged = false;
  renderCfTurnStatus();
}

function applyCfTurnState(state) {
  if (!state || typeof state !== 'object') return;
  S.cfTurnState = { configured: Boolean(state.configured), expiresAt: state.expiresAt || null, lastError: state.lastError || null };
  if (state.usage) applyCfUsage(state.usage);
  renderCfTurnStatus();
}

async function refreshCfTurnState() {
  try {
    applyCfTurnState(await window.sw.turn.cfStatus());
  } catch (error) {
    console.warn('[turn] 取 Cloudflare TURN 状态失败', error);
  }
}

/** 字节 → GB（十进制，和 Cloudflare 的计费单位一致）。 */
function fmtGB(bytes) {
  const gb = (Number(bytes) || 0) / 1e9;
  return gb.toFixed(gb < 10 ? 2 : 1);
}

function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

function cfTurnStatusText() {
  const state = S.cfTurnState;
  if (!state) return '';
  if (!state.configured) return 'Cloudflare TURN：还没配置';
  if (S.cfTurnUsage?.exceeded) return `Cloudflare TURN：${cfQuotaText()}`;
  if (state.lastError) return `Cloudflare TURN：${cfErrorText(state.lastError)}`;
  const expiresAt = S.cfTurn?.expiresAt || state.expiresAt;
  if (expiresAt > Date.now()) return `Cloudflare TURN：已配置，账号有效至 ${fmtClock(expiresAt)}`;
  return 'Cloudflare TURN：已配置';
}

function cfUsageText() {
  const usage = S.cfTurnUsage;
  if (!usage) return '';
  return `本月已用 ${fmtGB(usage.usedBytes)} GB / ${usage.limitGB} GB`;
}

/** 设置页开着时，把 Cloudflare TURN 的状态和用量刷到那几行上。 */
function renderCfTurnStatus() {
  const status = $('set-cf-status');
  if (status) status.textContent = cfTurnStatusText();
  const usage = $('set-cf-usage');
  if (usage) usage.textContent = cfUsageText();
  const warn = $('set-cf-warn');
  if (warn) {
    const near = Boolean(S.cfTurnUsage?.nearLimit && !S.cfTurnUsage?.exceeded);
    warn.textContent = near ? t('本月用量已超过上限的 80%，快到上限了。') : '';
    warn.classList.toggle('hidden', !near);
  }
}

/* ------------------------- Cloudflare TURN 用量计量 ------------------------- */

// 每条连接每 10 秒读一次 getStats()。连接关掉之前最后不到 10 秒的流量读不到（关了的连接不给统计），
// 本机统计因此会略少算一点 —— 默认上限 900 GB 留出的余量就是给这类出入的。
const TURN_METER_MS = 10_000;
// 一次最多报这么多（和主进程的校验上限一致），攒多了分几次报
const TURN_REPORT_MAX = 64 * 1e9;
const turnMeter = new RelayUsageMeter();
let turnMeterBusy = false;
let turnUsagePending = 0;

/**
 * 数一遍各条连接经 Cloudflare 中继的字节（增量），汇报给主进程按月累加。
 * 汇报失败的先攒着，下一轮一起报。
 */
async function meterTurnUsage() {
  if (turnMeterBusy) return;
  turnMeterBusy = true;
  try {
    for (const peer of [...(S.swarm?.peers?.values() || [])]) {
      const pc = peer?.pc;
      if (!pc || peer.closed || typeof pc.getStats !== 'function') continue;
      let report;
      try {
        report = await pc.getStats();
      } catch {
        continue;
      }
      let assumeCloudflare = false;
      try {
        assumeCloudflare = onlyCloudflareRelays(pc.getConfiguration?.()?.iceServers);
      } catch {}
      turnUsagePending += turnMeter.take(pc, cloudflareRelayPairs(report, { assumeCloudflare }));
    }
    if (turnUsagePending > 0) {
      const bytes = Math.min(turnUsagePending, TURN_REPORT_MAX);
      const usage = await window.sw.turn.cfReportUsage(bytes);
      turnUsagePending -= bytes;
      applyCfUsage(usage);
    }
  } catch (error) {
    console.warn('[turn] Cloudflare TURN 用量汇报失败，下一轮再报', error);
  } finally {
    turnMeterBusy = false;
  }
}

/** 本机这次收集到的候选够不够用，连不上时用来给一句能照着做的话。 */
function connectionAdvice(peer) {
  // Cloudflare 来源看这条连接建的时候带没带上中继；自己填的照旧看设置（勾了、填了地址就算）
  const turnConfigured =
    S.settings.turnSource === 'cloudflare'
      ? Boolean(peer?._expectRelay)
      : Boolean(S.settings.turnEnabled && S.settings.turnUrl);
  let stats = peer?.localCandidateStats || summarizeCandidates(peer?.pc?.localDescription?.sdp || '');

  // 信令模式（trickle）下候选是单独发出去的，本地描述里一条都没有 ——
  // 照着它下结论会一口咬定「一个候选都没收集到」，把用户支到查防火墙上去。
  // 这种情况改用连接过程中实际记下来的候选类型。
  if (!stats.total && peer?.candidateTypes?.size) {
    stats = { host: 0, srflx: 0, prflx: 0, relay: 0, mdns: 0, total: peer.candidateTypes.size };
    for (const type of peer.candidateTypes) if (type in stats) stats[type] = 1;
  }

  // 本机自己的候选。极简模式能从 SDP 里解析，信令模式 SDP 里没有候选行，
  // 得用连接过程中一条条攒下来的那份。
  const candidates = peer?.localCandidates?.length
    ? peer.localCandidates
    : parseSdpCandidates(peer?.pc?.localDescription?.sdp || '');
  // 判断逻辑在 ice.js 的 adviseConnection 里，这里只负责把输入凑齐。
  return adviseConnection({
    stats,
    candidates,
    candidateErrors: peer?.candidateErrors || [],
    turnConfigured,
    // 只走中继的连接本来就没有 host / srflx：一条中继都没有时要说 TURN 的问题，不是防火墙
    relayOnly: peer?.iceTransportPolicy === 'relay',
  });
}

/**
 * 收集一份能贴进 issue 的诊断信息。
 *
 * README 要求报问题时附上系统版本、连接方式、媒体格式和复现步骤 —— 而在此之前
 * 应用里一样都拿不到：日志只在内存里、退房就 reload 清空，主进程不写日志文件，
 * 菜单栏是关的所以也打不开 DevTools。用户能做的只有手打描述加截图。
 *
 * 只收环境和连接状态，不含文件路径和片名 —— 那些是用户的私事，不该被一键复制
 * 到别人的 issue 里去。
 */
function collectDiagnostics() {
  const env = S.env || {};
  const peers = (S.swarm?.peerList() || []).map(
    (p) => `${p.state}${p.authenticated ? ' 已认证' : ''} rtt=${p.rtt ?? '—'}`
  );
  const errors = [];
  for (const peer of S.swarm?.peers?.values() || []) {
    for (const e of peer.candidateErrors || []) errors.push(`${e.url} code=${e.errorCode} ${e.errorText}`);
  }
  const candidates = [...(S.swarm?.peers?.values() || [])].flatMap((p) => p.localCandidates || []);
  const symmetric = detectSymmetricNat(candidates);
  const lines = [
    `NoxReel ${env.version || '未知版本'} · ${env.platform || '未知平台'}`,
    `mpv=${env.mpv ? '有' : '无'} ffmpeg=${env.ffmpeg ? '有' : '无'} ffprobe=${env.ffprobe ? '有' : '无'} yt-dlp=${env.ytDlp ? '有' : '无'}`,
    `Defender=${env.defender ? '有' : '无'} 运行中=${env.defenderRunning === null ? '未知' : env.defenderRunning ? '是' : '否'}`,
    `连接方式=${connectionModeLabel()} 安全模式=${S.roomSecurityMode || S.settings.securityMode}`,
    `TURN=${S.settings.turnEnabled ? (S.settings.turnUrl ? '已配置' : '勾了但地址为空') : '未启用'}`,
    // 只记来源和状态，凭据一个字都不进诊断信息
    `TURN来源=${S.settings.turnSource === 'cloudflare' ? `Cloudflare（${S.cfTurn && S.cfTurn.expiresAt > Date.now() ? '有临时账号' : '没有临时账号'}${S.cfTurnUsage?.exceeded ? '，本月已到上限' : ''}）` : '自己填'} 隐藏IP=${S.settings.relayOnly ? '开' : '关'}`,
    `候选类型=${[...new Set(candidates.map((c) => c.type))].join(',') || '无'}`,
    `对称NAT判定=${symmetric ? symmetric.kind : '未检出'}`,
    `成员=${peers.length ? peers.join(' | ') : '无'}`,
    ...(errors.length ? ['ICE 候选错误:', ...errors.map((e) => `  ${e}`)] : []),
    '--- 最近日志 ---',
    ...[...($('event-log')?.children || [])].slice(-80).map((n) => n.textContent),
  ];
  return lines.join('\n');
}

/** 「复制诊断信息」按钮。准备页和房间页都用得上，所以做成一个工厂。 */
function copyDiagnosticsButton() {
  const button = make('button', { className: 'ghost', text: '复制诊断信息' });
  button.onclick = async () => {
    try {
      await Promise.resolve(window.sw.clipboard.writeText(collectDiagnostics()));
      button.textContent = t('已复制 ✓');
    } catch {
      button.textContent = t('复制失败');
    }
    setTimeout(() => (button.textContent = t('复制诊断信息')), 1800);
  };
  return button;
}

/* -------------------------------- 启动 -------------------------------- */

async function boot() {
  $('boot-status').textContent = '正在检查运行环境…';

  // 地区探测只用于告知，不阻止任何人使用，所以不必卡住启动流程。
  // 这里的 catch 不能省：探测失败是个未处理拒绝，而它跟能不能用软件毫无关系。
  window.sw.geo.check().then(applyGeoNotice).catch(() => {});

  // 环境探测失败不该是致命的。以前这里一抛就永远停在启动转圈页 ——
  // 而探测的结论只是「哪些外部程序缺了」，全当成缺件继续走，用户至少进得去。
  try {
    S.env = await window.sw.env.status();
    // 缓存清理方式和下载位置：手动模式下磁盘满了不自动删，得先知道是哪种
    S.cachePolicy = (await Promise.resolve(window.sw.cache?.policy?.()).catch(() => null)) || null;
    // 在线视频的手动缓存和边下边播的下载：哪些下好了、哪些还在下（播放列表的行和菜单要用）
    const views = (await Promise.resolve(window.sw.linkCache?.list?.()).catch(() => null)) || [];
    for (const view of views) (view.purpose === 'download' ? S.linkDownloads : S.linkCaches).set(linkKey(view.url), view);
    // 开发期端到端测试钩子（主进程只在未打包且显式打开时才报 devHooks）
    if (S.env.devHooks === true) window.__noxreel = { S, submitPlaylistOp };
  } catch (error) {
    log(`运行环境检查失败：${error.message || error}`, 'bad');
    S.env = {};
  }
  // 首页角落的版本号（主进程的 app.getVersion()）。报问题时先问的就是它，别让人去翻设置
  const version = $('home-version');
  if (version) version.textContent = S.env?.version ? `v${S.env.version}` : '';
  try {
    await window.sw.env.ensureDirs();
  } catch (error) {
    log(`缓存目录准备失败：${error.message || error}`, 'bad');
  }

  updateDepsPill();
  // 播放器清单要查注册表，慢一点无所谓：不拦启动，回来了再把下拉框重画一次
  refreshPlayerList();
  // Cloudflare TURN：状态和本月用量（设置页要显示），来源选的是它就顺手把临时账号备好。都不拦启动
  refreshCfTurnState();
  ensureTurnReady().catch(() => {});
  setInterval(() => meterTurnUsage(), TURN_METER_MS);
  show('view-home');
}

/**
 * 地区策略：告知 + 服务条款声明，仅此而已。
 * 探测到不在设计范围内就把话说清楚（打洞大概率失败、需要自备 TURN、
 * 这些问题不在支持范围内），然后让用户自己决定。
 */
function applyGeoNotice(geo) {
  S.geo = geo;

  const pill = $('pill-geo');
  if (geo.determined) {
    pill.textContent = `地区 ${geo.country}`;
    pill.className = geo.inScope ? 'pill ok' : 'pill warn';
  } else {
    pill.textContent = '地区未知';
    pill.className = 'pill';
  }

  if (geo.inScope || !geo.notice) return;

  pill.title = t(geo.notice);
  $('geo-notice-text').textContent = t(geo.notice);
  $('geo-notice').classList.remove('hidden');
}

// 关闭按钮无条件接线：告知条是提示性质的，必须随时能划走
$('geo-notice-x').onclick = () => $('geo-notice').classList.add('hidden');

/** 安全模式下 Windows 上的扫描器用不了：没装（找不到 MpCmdRun.exe），或者装着但没在跑。 */
function defenderMissing() {
  if (normalizeSecurityMode(S.settings.securityMode) !== 'safe' || S.env.platform !== 'win32') return false;
  return !S.env.defender || S.env.defenderRunning === false;
}

/** 依赖帮助框里 Defender 那一行：按「本平台没有」「装着没在跑」「没找到」分别给下一步。 */
function defenderHelpText() {
  if (S.env.platform && S.env.platform !== 'win32') {
    return '本平台没有可用的扫描器：安全模式收到的文件没法扫描，会一律拒播。要边下边播，得房主开可信房间、你也在设置里选可信房间，双方一致才连得上。';
  }
  if (S.env.defenderRunning === false) {
    return '装着但没在运行，多半是被第三方杀毒软件接管了。安全模式下收到的文件会因此一律拒播；可以重新启用 Defender，或改用可信房间（风险自负）—— 可信房间要房主开、你也在设置里选可信房间，双方一致才连得上。';
  }
  return '未找到。安全模式需要它才能放行收到的文件，没有它收到的文件会一律拒播；可信房间不受影响（要房主开可信房间、你也在设置里选可信房间）。';
}

function updateDepsPill() {
  const pill = $('pill-deps');
  const missing = [];
  if (!S.env.mpv) missing.push('mpv');
  if (!S.env.ffmpeg) missing.push('ffmpeg');
  // ffprobe 单独算一件：没有它读不到时长和每轨码率，后果是卡顿预判和无损精简
  // 静默失效（probeStreams 的失败被吞掉了）。它跟 ffmpeg 是两个可执行文件，
  // 装了一个不代表另一个也在。
  if (!S.env.ffprobe) missing.push('ffprobe');
  if (!S.env.ytDlp) missing.push('yt-dlp');
  // 安全模式对用户的全部承诺就是「扫过才放行」。Defender 没在跑的话（最常见的原因
  // 是被第三方杀毒软件接管），这个模式下收到的每份文件都会被拒播 —— 这话得在开传
  // 之前说，而不是等人守着传完一整部片再报错。
  // 整个没有 Defender（精简版系统、没装这个功能的 Server）也一样，所以扫描器找不到也算缺件。
  // 只在 Windows 上这么算：别的平台本来就没有 Defender，报「缺少 Defender」、叫人去启用它是空话
  // （帮助框里另有说明）。装着但问不出在不在跑（defenderRunning 为 null）的按未知处理，不报。
  if (defenderMissing()) missing.push('Defender');

  if (!missing.length) {
    pill.textContent = '依赖就绪';
    pill.className = 'pill ok';
    pill.onclick = null;
  } else {
    pill.textContent = `缺少 ${missing.join(' / ')}`;
    pill.className = 'pill warn';
    pill.onclick = showDepsHelp;
  }
}

/**
 * 一条能一键复制的命令。
 *
 * 以前这里是纯 `<code>` 文本，用户得自己照着抄一长串包名到终端里 ——
 * 而邀请码那边早就有现成的复制按钮了，两处待遇不该差这么多。
 */
function copyableCommand(command) {
  const button = make('button', { className: 'ghost tiny', text: '复制' });
  button.onclick = async () => {
    try {
      await Promise.resolve(window.sw.clipboard.writeText(command));
      button.textContent = t('已复制 ✓');
    } catch {
      button.textContent = t('复制失败');
    }
    setTimeout(() => (button.textContent = t('复制')), 1800);
  };
  return make('span', { className: 'cmd-row' }, [make('code', { text: command }), button]);
}

function showDepsHelp() {
  const dependency = (label, found, missing) =>
    field(
      label,
      found ? hint('已找到：', make('code', { text: found })) : hint(missing)
    );

  openModal({
    title: '缺少外部依赖',
    body: () => [
      make('p', {
        className: 'fine',
        text: 'NoxReel 不自研播放器、编解码器和网站解析器，靠这些成熟组件干活：',
      }),
      // 外部程序每次现找、不缓存（findBin），装好后点「重新检测」就行，用不着重启
      dependency('mpv —— 播放器（必需）', S.env.mpv, '未找到。装好后点下面的「重新检测」就行，不用重启本软件。'),
      dependency('ffmpeg —— 转封装与无损精简（按需）', S.env.ffmpeg, '未找到。转封装和无损精简都需要它。'),
      dependency(
        'ffprobe —— 读取媒体信息（按需）',
        S.env.ffprobe,
        '未找到。它和 ffmpeg 是两个程序。没有它读不到时长和每轨码率，卡顿预判和无损精简都会失效。'
      ),
      dependency(
        'yt-dlp —— 视频网页解析（按需）',
        S.env.ytDlp,
        '未找到。MP4/HLS 直链仍可播放，视频网站页面链接不可用。'
      ),
      dependency(
        'Microsoft Defender —— 安全模式的扫描器',
        S.env.defenderRunning !== false ? S.env.defender : null,
        defenderHelpText()
      ),
      field(
        '安装方式（任选其一）',
        hint(
          copyableCommand('winget install shinchiro.mpv Gyan.FFmpeg yt-dlp.yt-dlp'),
          make('br'),
          copyableCommand('scoop install mpv ffmpeg yt-dlp'),
          make('br'),
          '或者手动下载后，把可执行文件路径写进环境变量',
          make('code', { text: 'SYNCWATCH_MPV_PATH' }),
          ' / ',
          make('code', { text: 'SYNCWATCH_FFMPEG_PATH' }),
          ' / ',
          make('code', { text: 'SYNCWATCH_YTDLP_PATH' }),
          '。'
        )
      ),
    ],
    okText: '重新检测',
    onOk: async () => {
      S.env = await window.sw.env.status();
      updateDepsPill();
      return true;
    },
  });
}

/* ------------------------------ 发起放映 ------------------------------ */

const dz = $('dropzone');
dz.addEventListener('click', async () => {
  showDropFailures([]);
  const paths = await window.sw.dialog.pickVideos();
  if (paths?.length) startHostMany(paths);
});

$('btn-link').addEventListener('click', () => startHostLink($('video-link').value));
$('video-link').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startHostLink(e.currentTarget.value);
});
dz.addEventListener('dragover', (e) => {
  e.preventDefault();
  dz.classList.add('over');
});
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', async (e) => {
  e.preventDefault();
  dz.classList.remove('over');
  if (!e.dataTransfer.files.length) return;
  const { paths, failures } = await approvedDropPaths(e.dataTransfer.files);
  // 用不了的留在首页卡片上说清楚（别用 alert：会响提示音）。一起拖进来的其余文件照常开房，
  // 跳过了哪几个另记进日志，进房后也看得到。
  showDropFailures(failures);
  if (!paths.length) return;
  for (const failure of failures) log(dropFailureLine(failure), 'warn');
  startHostMany(paths);
});

/**
 * 拖进来的文件逐个换成主进程批准过的路径。用不了的不再一声不吭地跳过：
 * 连同原因记进 failures —— 格式不支持、拖进来的是文件夹、文件不见了，各有各的出路，
 * 一律说成「拿不到路径」会让人去换一种选择方式，而点击选择的对话框本来就不收这些。
 *
 * @returns {Promise<{paths: string[], failures: {name: string, reason: string}[]}>}
 */
async function approvedDropPaths(fileList) {
  const paths = [];
  const failures = [];
  for (const file of [...(fileList || [])]) {
    const name = String(file?.name || '');
    try {
      const path = await window.sw.pathForFile(file);
      if (path) paths.push(path);
      else failures.push({ name, reason: '拿不到这个文件的路径，请改用选择文件的方式添加' });
    } catch (error) {
      failures.push({ name, reason: dropFailureReason(error, name) });
    }
  }
  return { paths, failures };
}

/**
 * 拖进来的文件为什么用不了，换成一句看得懂、指得出路的话。
 * 主进程的报错会被 Electron 套上「Error invoking remote method …」前缀，只取我们自己那句。
 */
function dropFailureReason(error, name) {
  const message = String(error?.message || error || '')
    .replace(/^Error invoking remote method '[^']*': /, '')
    .replace(/^[A-Za-z]*Error: /, '');
  if (message.includes('不支持这种视频格式')) {
    const ext = (/\.[^.\\/]+$/.exec(name)?.[0] || '').toLowerCase();
    // RM/RMVB 是有意不收的：ffmpeg 的 Matroska 封装器不认 RealVideo，只能重新编码
    if (ext === '.rm' || ext === '.rmvb') return 'RM/RMVB 只能重新编码、没法无损封成 MKV，不支持';
    return `不支持这种视频格式：${ext || '(无扩展名)'}`;
  }
  if (message.includes('ENOENT')) return '找不到这个文件，可能已被移动或删除';
  if (/EACCES|EPERM/.test(message)) return '没有权限读取这个文件';
  if (message.includes('无效的媒体文件名')) return '文件名太长或带有不支持的字符，改个名再试';
  return message || '拿不到这个文件的路径，请改用选择文件的方式添加';
}

const dropFailureLine = ({ name, reason }) => `没加上《${name}》：${reason}`;

// 首页卡片上最多列几条，拖进来一大把不支持的文件时别把卡片撑满
const DROP_FAILURES_SHOWN = 5;

function showDropFailures(failures) {
  const box = $('drop-err');
  if (!box) return;
  const lines = failures.slice(0, DROP_FAILURES_SHOWN).map((f) => make('div', { text: dropFailureLine(f) }));
  if (failures.length > DROP_FAILURES_SHOWN) {
    lines.push(make('div', { text: `还有 ${failures.length - DROP_FAILURES_SHOWN} 个也没加上` }));
  }
  box.replaceChildren(...lines);
}

// 别让拖到窗口别处的文件把整个页面替换掉
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

function setSteps(steps) {
  replace(
    'prep-steps',
    steps.map((step) =>
      make('div', { className: `step ${step.state}` }, [
        make('span', {
          className: 'step-mark',
          text: step.state === 'done' ? '✓' : step.state === 'active' ? '▸' : '·',
        }),
        make('span', { text: step.label }),
      ])
    )
  );
}

/**
 * 首页开房时的整页进度。
 *
 * 准备流程（prepareLocalFile）只和 reporter 打交道，进度画在哪由 reporter 决定：
 * 这里画在整页的准备视图上；房间里加片画在列表行内（见 jobReporter）。
 */
function pageReporter(filePath, gen) {
  const steps = [
    { label: '检查格式与兼容性', state: '' },
    { label: '优化传输体积（按需）', state: '' },
    { label: '计算分片校验值', state: '' },
    { label: '创建房间', state: '' },
  ];
  $('prep-title').textContent = '正在准备文件';
  $('prep-file').textContent = filePath;
  $('prep-bar').style.width = '0%';
  // 大文件的转封装、算哈希要好几分钟：一直留着「取消」（回首页，这次尝试整个拆掉 ——
  // 换代让 cancelled() 变真，挂在这次尝试收尾上的哈希、转封装任务一起叫停）
  replace('prep-actions', ...(gen === undefined ? [] : [cancelJoinButton()]));
  $('prep-note').textContent = '';
  const stage = (index) => {
    steps.forEach((step, i) => {
      step.state = i < index ? 'done' : i === index ? 'active' : '';
    });
    setSteps(steps);
  };
  stage(0);
  return {
    label: '',
    stage,
    title: (text) => {
      $('prep-title').textContent = text;
    },
    note: (text) => {
      $('prep-note').textContent = text;
    },
    progress: (ratio) => {
      $('prep-bar').style.width = `${(Math.max(0, Math.min(1, ratio)) * 100).toFixed(1)}%`;
    },
    finish: () => {
      stage(steps.length);
      // 做种会话已经开好、交给 addLocalFile 去建房了，这一步很快：这时再拆，会留下半个房间
      replace('prep-actions');
    },
    // 换了一次尝试就算取消（点了准备页上的「取消」，或者确认改去加入别人的邀请）：
    // 正在算的哈希、转封装和弹着的选择框都挂在这次尝试的收尾上
    cancelled: () => gen !== undefined && !attemptLive(gen),
    onCancel: (fn) => {
      if (gen === undefined) return;
      if (attemptLive(gen)) joinAttempt.cleanups.push(fn);
      else fn(); // 已经过期了才来登记：当场收掉，别挂到下一次尝试身上
    },
  };
}

/** 半小时内测过的上行才算数：带宽会变，太旧的数不如不给。 */
function uplinkFresh() {
  return S.uplinkEstimate?.bytesPerSec > 0 && Date.now() - S.uplinkEstimate.measuredAt < UPLINK_FRESH_MS;
}

/**
 * 本机正在给别人供片。做种会话算，「已经收到的片正在往外转发」也算 ——
 * 极简模式下房主替管理员转片时一个 isSeeder 都没有，漏算它就会在满速上传时重新测上行，
 * 测出来的数偏低，还要挤占成员正在收的带宽。
 */
function seedingToOthers() {
  if (!(connectedPeerCount() > 0)) return false;
  if ([...S.sessions.values()].some((sess) => sess.isSeeder)) return true;
  // 转发：接收会话的 isSeeder 是 false，但手里已有的分片照样在往外发。
  // 取一个明显高于控制消息的阈值，免得偶然的一点点流量把测速永久挡死。
  return (S.swarm?.peerList?.() || []).some((p) => p.upRate > UPLINK_BUSY_BPS);
}

/**
 * 卡顿预判要用的上行带宽。房间里加片时，半小时内测过就直接用；
 * 正在给别人供片时绝不重测 —— 测出来的数不准，还会挤占大家的带宽。
 */
function uplinkForPrecheck() {
  if (uplinkFresh()) return Promise.resolve({ ok: true, ...S.uplinkEstimate });
  if (seedingToOthers()) return Promise.resolve({ ok: false, reason: '正在给成员供片，这时测不准上行' });
  return window.sw.net.estimateUplink().catch((error) => ({ ok: false, reason: error.message || String(error) }));
}

/**
 * ffmpeg 能不能用。启动时记下的「没有」不作数，重新问一次主进程再下结论 ——
 * 用户多半是看了「装上 ffmpeg 后重试」才去装的，软件没关；主进程每次都会重新扫描各家落点，
 * 渲染进程这份启动时的旧结论却会把重试原样拦下，外挂字幕也会被静默跳过。
 */
async function ffmpegReady() {
  if (S.env?.ffmpeg) return true;
  try {
    S.env = await window.sw.env.status();
    updateDepsPill();
  } catch {}
  return Boolean(S.env?.ffmpeg);
}

// 安全模式下 moov 在文件尾的 MP4：原样传就行，转封装只是可选项
const SAFE_MOOV_NOTE =
  '这个文件的索引（moov）在文件末尾。安全模式下大家都是收完、扫描过才播，索引在哪不影响观看，可以原样传；转封装只是把索引挪到文件头，要多花一些时间和一份临时空间。';

/**
 * 准备一部本地片：检查格式 →（按需）精简或转封装 → 卡顿预判 → 算分片校验值 → 开做种会话。
 *
 * 用户中途取消（选方案时点了取消、看完预判决定不传、行内点了取消）返回 null，
 * 这时产生的临时文件和会话都已经收拾干净；出错直接抛。
 *
 * @returns {Promise<{manifest, state, filePath, sourcePath, moovAtEnd}|null>}
 */
async function prepareLocalFile(filePath, reporter) {
  // filePath 会被转封装/精简的产物覆盖，源文件路径单独留一份：判重时要用它
  const sourcePath = filePath;
  let temporaryPath = null;
  let preparedSessionId = null;
  // 算哈希、转封装、精简都是分钟级的，带上任务号才能中途叫停、分得清进度是谁的
  const taskId = randomId(8);
  const cancelled = () => reporter.cancelled() === true;
  const release = async () => {
    // 包进 trackClosing：离开房间时 leaveRoom 会等它。不然页面一刷新这条回收就发不出去了，
    // 整部片大小的转封装产物要一直留到应用退出。
    if (temporaryPath) await trackClosing(window.sw.media.releaseTemp(temporaryPath).catch(() => {}));
    temporaryPath = null;
    return null;
  };
  reporter.onCancel(() => window.sw.tasks.cancel(taskId).catch(() => {}));
  // 行内任务的文案从这里才开始动：inspect 要探测码率、试压 PCM 轨，能跑十几秒，
  // 这段时间不报「正在检查格式」的话，正在跑的行和还在排队的行一模一样。
  reporter.stage(0);

  try {
    // 1. 兼容性检查
    const info = await window.sw.media.inspect(filePath);
    if (info.action === 'reject') throw new Error(info.reason);
    // AVI、TS 这类不直接进房，先在本机无损封成 MKV —— 接收方永远只见到 MP4/MKV 那几种容器
    const mustConvert = info.action === 'convert';
    // moov 索引在文件尾的 MP4 只有可信房间非转封装不可：那里要边下边播，读不到索引一帧都放不了。
    // 安全模式下大家收完、扫描过才播，索引在哪都一样，原样传就行，转封装只是一个可选项。
    // 准备期间房间模式是锁住的（见 securityModeLocked），进列表前 addLocalFile 还会按最终模式再核一次。
    const moovAtEnd = info.action === 'remux';
    const needsRemux = moovAtEnd && S.roomSecurityMode === 'trusted';
    const optionalRemux = moovAtEnd && !needsRemux;
    const canSlim = info.slim?.available === true;
    if (cancelled()) return null;

    // 外挂字幕随片走的办法是封进 MKV，所以同样要 ffmpeg。
    const sidecars = await window.sw.media.findSubtitles(filePath).catch(() => []);
    if (cancelled()) return null;
    // 用得上 ffmpeg 时，启动时记下的「没有」不作数，重新问一次（见 ffmpegReady）
    const ffmpeg =
      mustConvert || moovAtEnd || canSlim || sidecars.length > 0 ? await ffmpegReady() : Boolean(S.env?.ffmpeg);
    if (cancelled()) return null;
    if (mustConvert && !ffmpeg) {
      throw new Error(`${info.label} 要先无损封成 MKV 才能传，这一步需要 ffmpeg，但没找到。装上 ffmpeg 后重试。`);
    }

    // 没有 ffmpeg 就封不了外挂字幕，照原样传，说一声就好 —— 为了字幕拦下整场放映不值得。
    if (sidecars.length && !ffmpeg) {
      const text = `片子旁边有 ${sidecars.length} 个外挂字幕，但封进片子需要 ffmpeg，这次先不带字幕。`;
      reporter.note(text);
      log(text, 'warn');
    }
    if (cancelled()) return null;

    // 上行测速和后面的精简、转封装并行跑，等到要下结论时它多半已经测完了。
    // 只有可信房间才会边下边播、才存在「中途卡顿」；安全模式成员收完才播，就不往外测。
    const uplinkPromise = S.roomSecurityMode === 'trusted' ? uplinkForPrecheck() : null;
    let finalSize = info.size;
    let slimmed = false;

    // 几种情况需要拿主意：非转封装不可、可以选择转封装、还有可无损省下的体积、旁边有字幕。
    // 都不沾边就别拿一个只有一个选项的弹窗去烦人。
    const offerSubtitles = ffmpeg && sidecars.length > 0;

    if (needsRemux || optionalRemux || mustConvert || canSlim || offerSubtitles) {
      reporter.stage(1);
      reporter.note(optionalRemux ? SAFE_MOOV_NOTE : info.reason);

      if (!ffmpeg && needsRemux) {
        throw new Error('这个 MP4 需要转封装才能边下边播，但没找到 ffmpeg。装上 ffmpeg 后重试，或者换一个 MKV 文件。');
      }

      // 没有 ffmpeg 时「本来还能再省一点」「可以挪一下索引」都不该拦住放映，照原样走就是了。
      const choice = ffmpeg
        ? await choosePrepPlan(info, { needsRemux, optionalRemux, mustConvert, canSlim, subtitles: sidecars, reporter })
        : { plan: 'as-is' };
      if (!choice || cancelled()) return null;

      const subtitlePaths = choice.subtitles || [];
      // 封成 MKV：格式本身要求，或者要带外挂字幕（MP4 装不下 ASS）。精简可以在同一遍里做掉。
      const converting = mustConvert || subtitlePaths.length > 0;
      if (converting || choice.plan !== 'as-is') {
        const slimming = choice.plan === 'slim';
        slimmed = slimming;
        const reencoding = slimming && choice.toFlac?.length > 0;
        reporter.title(
          converting
            ? subtitlePaths.length
              ? '正在把字幕封进片子'
              : '正在封成 MKV'
            : slimming
              ? '正在无损精简'
              : '正在转封装'
        );
        // 转码是分钟级、丢轨是秒级，这两件事的等待体感差一个数量级，得先说清楚。
        if (reencoding) {
          reporter.note('正在把未压缩的 PCM 音轨转成 FLAC（无损）。这一步要重新编码音频，长片可能要几分钟。');
        }
        const onProgress = ({ progress, taskId: owner }) => {
          if (owner === taskId) reporter.progress(progress);
        };
        const off = converting
          ? window.sw.media.onConvertProgress(onProgress)
          : slimming
            ? window.sw.media.onSlimProgress(onProgress)
            : window.sw.media.onRemuxProgress(onProgress);
        try {
          const result = converting
            ? await window.sw.media.convert(filePath, {
                keepIndexes: slimming ? choice.keepIndexes : null,
                toFlac: slimming ? choice.toFlac : null,
                subtitles: subtitlePaths,
                taskId,
              })
            : slimming
              ? await window.sw.media.slim(filePath, {
                  keepIndexes: choice.keepIndexes,
                  toFlac: choice.toFlac,
                  taskId,
                })
              : await window.sw.media.remux(filePath, taskId);
          filePath = result.outPath;
          temporaryPath = result.outPath;
          if (result.outputSize > 0) finalSize = result.outputSize;
          const saved =
            result.inputSize > 0 && result.outputSize > 0
              ? `，体积 ${fmtBytes(result.inputSize)} → ${fmtBytes(result.outputSize)}`
              : '';
          reporter.note(
            converting
              ? `已封成 MKV：${result.outPath}${saved}`
              : slimming
                ? `已精简到：${result.outPath}${saved}`
                : `已转封装到：${result.outPath}`
          );
          if (result.subtitles > 0) log(`已把 ${result.subtitles} 条外挂字幕封进片子`, 'good');
          // 片子里原有的字幕（图文电视、ARIB、608 这类）产物的容器装不下，只能略过 —— 得让人知道少了什么
          const toMkv = converting || String(result.outPath || '').toLowerCase().endsWith('.mkv');
          const container = toMkv ? 'MKV' : 'MP4';
          if (result.droppedSubtitles?.length) {
            log(
              `片子里有 ${result.droppedSubtitles.length} 条字幕 ${container} 装不下，已略过（${result.droppedSubtitles.join('、')}）`,
              'warn'
            );
          }
          if (result.subtitlesUnchecked) {
            log('读不出这个片子的轨道信息（可能没装 ffprobe），片子里的字幕放不进 MP4，这次没带上', 'warn');
          }
        } finally {
          off();
        }
      }
    }
    if (cancelled()) return release();

    // 卡顿预判放在算哈希之前：大文件的哈希要算好几分钟，决定不传了的话别让人白等。
    if (uplinkPromise) {
      reporter.stage(1);
      const proceed = await confirmStreamability({
        size: finalSize,
        duration: info.probe?.duration,
        uplinkPromise,
        // 只有这个片子确实能精简、而这次没选时，「改选无损精简」才是一条真建议。
        canSlimMore: canSlim && !slimmed && ffmpeg,
        reporter,
      });
      if (!proceed) {
        if (temporaryPath) await window.sw.media.releaseTemp(temporaryPath).catch(() => {});
        return null;
      }
      if (cancelled()) return release();
    }

    // 2. 分片 + 哈希
    reporter.stage(2);
    reporter.title('正在计算分片校验值');
    reporter.note(
      '每个分片单独算一次 SHA-256。对方收到一片就能立刻验一片，不用等整个文件下完 —— 这就是「渐进式校验」。'
    );
    reporter.progress(0);
    const offHash = window.sw.store.onHashProgress(({ done, total, taskId: owner }) => {
      if (owner === taskId) reporter.progress(done / total);
    });
    let manifest;
    try {
      manifest = await window.sw.store.buildManifest(filePath, taskId);
    } finally {
      offHash();
    }
    if (cancelled()) return release();

    // 3. 开做种会话
    reporter.stage(3);
    // 时长跟着清单一起过去 —— 接收方靠它在还没起播时就能算出「这个片子需要多少
    // 码率」，进而判断当前速度追不追得上。转封装和精简都不改时长，用原始探测值即可。
    manifest = {
      ...manifest,
      ...(info.probe?.duration > 0 ? { durationSec: info.probe.duration } : {}),
      // 片源的上行也跟着过去，成员面板据此显示「片源上行」，知道自己分到的速度上限在哪。
      ...(uplinkFresh() ? { sourceUplinkBps: Math.round(S.uplinkEstimate.bytesPerSec) } : {}),
    };
    // 记进 leechOpens：离开房间时先等这次开会话落地再关会话，免得刷新后主进程留一个没人关的会话
    const state = await trackPending(S.leechOpens, window.sw.store.openSeed(manifest, filePath));
    preparedSessionId = state.sessionId;
    // 临时文件从这里起归会话所有，关会话时一起清掉
    temporaryPath = null;
    if (cancelled()) {
      await trackClosing(window.sw.store.close(state.sessionId).catch(() => {}));
      return null;
    }
    // 原样传出去的还是那个索引在文件尾的 MP4（安全模式下没选转封装）：addLocalFile 按最终模式再核一次
    return { manifest, state, filePath, sourcePath, moovAtEnd: moovAtEnd && filePath === sourcePath };
  } catch (error) {
    if (preparedSessionId) await window.sw.store.close(preparedSessionId).catch(() => {});
    else await release();
    // 被叫停的任务以「操作已取消」结束，那是用户自己的决定，不算出错
    if (cancelled()) return null;
    throw error;
  }
}

/**
 * 首页一次选了好几部：第一部照原样开房，其余的进房后在列表里挨个准备。
 *
 * 第一部没能开成房时，剩下的选择不能就这么消失：出错就换下一部接着试（失败的名字一起报出来），
 * 用户自己点了取消就整批停下 —— 那是「这一场不传了」的意思，别替他拿下一部去开房。
 */
async function startHostMany(paths) {
  const rest = [...paths].filter(Boolean);
  const failed = [];
  while (rest.length) {
    const path = rest.shift();
    const result = await startHost(path);
    if (result.outcome === 'entered') {
      if (rest.length) queueLocalFiles(rest);
      return;
    }
    if (result.outcome === 'cancelled') {
      if (rest.length) prepStop('已取消', '这一部没有加入放映。', `还有 ${rest.length} 部没有加入，要用它们开房请重新选择。`);
      return;
    }
    // 准备到一半被换成了别的尝试（用户确认改去加入一条邀请）：界面已经是那边的了，一个字都别动
    if (result.outcome === 'superseded') return;
    failed.push({ name: baseName(path), message: result.message });
  }
  if (failed.length > 1) {
    const others = failed.slice(0, -1).map((f) => f.name).join('、');
    prepFail(failed[failed.length - 1].message, `这些也没能用：${others}`);
  }
}

/** @returns {Promise<{outcome: 'entered'|'cancelled'|'failed'|'superseded', message?: string}>} */
async function startHost(filePath) {
  // 房间里加片不占整页，进度画在列表行内
  if (roomEntered) {
    queueLocalFiles([filePath]);
    return { outcome: 'entered' };
  }
  // 上一次没进成房的加入留下的 Swarm / SyncEngine 在这里拆掉，否则房主本人在引擎里是游客
  const gen = beginAttempt('host');
  S.role = 'host';
  S.hostId = S.peerId; // 房主就是自己，角色权威在我这
  S.roomSecurityMode = normalizeSecurityMode(S.settings.securityMode);

  show('view-prepare');
  const reporter = pageReporter(filePath, gen);
  try {
    const prepared = await prepareLocalFile(filePath, reporter);
    if (!attemptLive(gen)) {
      // 已经换成了别的尝试：刚开好的做种会话没人要了
      if (prepared) await trackClosing(window.sw.store.close(prepared.state.sessionId).catch(() => {}));
      return { outcome: 'superseded' };
    }
    if (!prepared) {
      backHome();
      return { outcome: 'cancelled' };
    }
    reporter.finish();
    // 会话从这里起交给 addLocalFile 管：它失败时自己收尾
    await addLocalFile(prepared);
    return { outcome: 'entered' };
  } catch (e) {
    if (!attemptLive(gen)) return { outcome: 'superseded' };
    console.error(e);
    const message = e.message || String(e);
    prepFail(message);
    return { outcome: 'failed', message };
  }
}

async function startHostLink(rawUrl) {
  const url = String(rawUrl || '').trim();
  $('link-err').textContent = '';
  if (!url) return;

  let gen = joinAttempt.gen;
  if (!roomEntered) {
    gen = beginAttempt('host');
    S.role = 'host';
    S.hostId = S.peerId;
    S.roomSecurityMode = normalizeSecurityMode(S.settings.securityMode);
  }

  show('view-prepare');
  $('prep-title').textContent = '正在解析视频链接';
  $('prep-file').textContent = url;
  $('prep-bar').style.width = '35%';
  $('prep-note').textContent = '只读取媒体信息，不下载视频。每位参与者会直接从原始网站播放。';
  // 解析最长要等一分钟：给个「取消」（回首页，这次尝试整个拆掉；解析回来一看代次过期就什么都不动）
  replace('prep-actions', ...(roomEntered ? [] : [cancelJoinButton()]));
  setSteps([
    { label: '验证链接', state: 'done' },
    { label: '解析视频信息', state: 'active' },
    { label: '创建同步房间', state: '' },
  ]);

  try {
    const linkInfo = await window.sw.media.inspectLink(url);
    if (!attemptLive(gen)) return;
    // 接下来建房很快，这时再拆会留下半个房间
    replace('prep-actions');
    $('prep-bar').style.width = '85%';
    setSteps([
      { label: '验证链接', state: 'done' },
      { label: '解析视频信息', state: 'done' },
      { label: '创建同步房间', state: 'active' },
    ]);
    await addLinkItem(linkInfo);
  } catch (e) {
    if (!attemptLive(gen)) return;
    console.error(e);
    prepFail(e.message || String(e));
  }
}

/* ---------------------------- 播放列表与当前项 ---------------------------- */

const isRoomHost = () => S.role === 'host' && S.hostId === S.peerId;
const PLAYLIST_OP_TIMEOUT_MS = 45_000;
const MANIFEST_RETRY_MS = 5000;
// 缓存位置用不了（盘拔了）时隔多久再试一次
const CACHE_IO_RETRY_MS = 30_000;
// 加片等房主回音超时之后的宽限期：房主那边的列表操作是一条串行链，排队就可能耗光 45 秒，
// 他其实还在处理。这段时间里先别撤会话和清单，免得留下一个谁都供不了的条目。
const ADD_GRACE_MS = 60_000;
// 离开房间时给准备任务收尾的时间上限：等不到就先走，别让「退出房间」看起来卡住
const PREP_DRAIN_MS = 3000;
// 排空在途会话请求的轮数上限：正常一两轮就空了，加个上限免得极端情况下退不出去
const DRAIN_ROUNDS = 10;
// 上行超过这个速度就认定「正在给别人供片」，这时重测上行既不准又抢带宽
const UPLINK_BUSY_BPS = 64 * 1024;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function linkKey(url) {
  try {
    return new URL(url).href;
  } catch {
    return String(url || '');
  }
}

function newSession({ manifest, state, filePath, sourcePath = null, isSeeder }) {
  return {
    fileId: manifest.fileId,
    slot: null, // 列表分配槽位之后才挂进 swarm
    manifest,
    sessionId: state.sessionId,
    filePath,
    // 做种时的源文件路径：同一个文件再加一次时要靠它拦住（精简产物的字节不一定一样，
    // fileId 会变，按 fileId 的去重拦不住）
    sourcePath,
    isSeeder: !!isSeeder,
    // 接收的文件在长期缓存文件夹里（手动模式收的、复用了登记过的持久副本）：「打开…位置」按它说
    persistent: !isSeeder && !!state.persistent,
    state,
    safety: { sessionId: state.sessionId, status: isSeeder ? 'trusted-local' : 'waiting-download' },
  };
}

function currentSession() {
  return S.current?.kind === 'file' ? S.sessions.get(S.current.fileId) || null : null;
}

/** 当前项在 swarm 里的传输上下文。 */
function currentFileCtx() {
  const sess = currentSession();
  return sess && sess.slot !== null ? S.swarm?.files.get(sess.slot) || null : null;
}

/**
 * 把「当前项」抄到老代码认的那几个字段上（manifest / sessionId / filePath / isSeeder /
 * sourceType / linkInfo / mediaSafety）。mediaSafety 直接引用会话自己的那份，
 * 扫描结果记在会话身上，回头轮到它时不用重扫。
 */
function syncCurrentMirrors() {
  const item = S.current;
  S.manifest = null;
  S.sessionId = null;
  S.filePath = null;
  S.linkInfo = null;
  S.isSeeder = false;
  S.sourceType = item?.kind || null;
  if (!item) {
    S.mediaSafety = { sessionId: null, status: 'idle' };
    return;
  }
  if (item.kind === 'link') {
    // 链接由每台电脑直接读取，不需要 P2P 分片
    S.isSeeder = true;
    S.mediaSafety = { sessionId: null, status: 'idle' };
    return;
  }
  const sess = S.sessions.get(item.fileId);
  if (!sess) {
    S.mediaSafety = { sessionId: null, status: S.blockedFiles.has(item.fileId) ? 'blocked' : 'idle' };
    return;
  }
  S.manifest = sess.manifest;
  S.sessionId = sess.sessionId;
  S.filePath = sess.filePath;
  S.isSeeder = sess.isSeeder;
  S.mediaSafety = sess.safety;
}

function fileItemOf(manifest) {
  return {
    kind: 'file',
    fileId: manifest.fileId,
    name: manifest.name,
    size: manifest.size,
    chunkSize: manifest.chunkSize,
    chunkCount: manifest.chunkCount,
    durationSec: manifest.durationSec || 0,
  };
}

/**
 * 本机准备好的片加进列表。会话先登记（槽位要等列表分配），再提交 add；列表不收就把会话关掉。
 */
async function addLocalFile({ manifest, state, filePath, sourcePath = null, moovAtEnd = false }) {
  // 索引在文件尾的 MP4 只有安全模式能原样传。准备期间模式本该锁着，这里在建 Swarm 之前
  // 按最终的房间模式再核一次：真变成了可信房间，就别把一部边下边播起不来的片子放进列表。
  if (moovAtEnd && S.roomSecurityMode === 'trusted') {
    await trackClosing(window.sw.store.close(state.sessionId).catch(() => {}));
    throw new Error('这个 MP4 的索引在文件末尾，可信房间要边下边播，得先转封装。请重新选择这个文件。');
  }
  initSwarmAndSync();
  const { fileId } = manifest;
  const existing = S.sessions.get(fileId);
  // 先登记成「正在加」：下面关旧会话的 await 期间 fileId 不在 S.sessions 里，
  // 别让 openLeechFor 趁机再开一个接收会话（随后被覆盖，主进程里留下没人关的会话）。
  S.pendingAdds.add(fileId);
  try {
    if (existing?.isSeeder) {
      // 同一部片已经在做种了，新开的这份用不上
      await trackClosing(window.sw.store.close(state.sessionId).catch(() => {}));
    } else {
      if (existing) {
        // 正在从别人那里收这部片，本地有完整文件就直接改成做种。
        // 播放器可能正读着这份接收缓存：先退它、等它真正退出，再关会话删缓存，
        // 否则缓存删不掉，播放器还会接着读一个再也不会写入的稀疏文件。
        const wasCurrent = currentSession() === existing;
        S.sessions.delete(fileId);
        if (existing.slot !== null) S.swarm.removeFile(existing.slot);
        if (wasCurrent) {
          retirePlayer();
          // 镜像先放开旧会话：已关的会话、要删的缓存路径不能再拿去起播
          syncCurrentMirrors();
          $('btn-playpause').disabled = true;
          $('btn-reopen')?.classList.add('hidden');
        }
        await S.playerQuit;
        await trackClosing(window.sw.store.close(existing.sessionId).catch(() => {}));
      }
      S.sessions.set(fileId, newSession({ manifest, state, filePath, sourcePath, isSeeder: true }));
      S.blockedFiles.delete(fileId);
      S.diskFull.delete(fileId);
      S.swarm.offerManifest(manifest);
    }

    const listed = S.playlist.queue.some((it) => it.kind === 'file' && it.fileId === fileId);
    if (!listed) {
      const res = await submitPlaylistOp({ type: 'add', item: fileItemOf(manifest) });
      if (!res.ok) {
        // 房主没回音不等于他拒绝了：他那边的列表操作串行排队，前面有人加片要先取清单
        // （最长 30 秒），排队就能把这 45 秒耗光；直连断了也一样，请求可能已经在他那边执行了。
        // 这时立刻撤掉会话和清单，万一房主随后拼齐入列，列表里就留下一个谁都供不了的条目。
        // 先留一段宽限期，等列表快照说了算。
        if (res.uncertain) {
          S.addGrace.set(fileId, Date.now() + ADD_GRACE_MS);
          setTimeout(() => {
            if (!inAddGrace(fileId)) releaseUnreferenced();
          }, ADD_GRACE_MS + 50);
        }
        throw playlistOpError(res);
      }
    } else {
      // 列表里本来就有：会话换过了，重新挂到它的槽位上
      onPlaylistChanged();
      // 换成做种的正是当前项（seq 没变，onPlaylistChanged 不会换片）：按新会话重新就绪 ——
      // 镜像、片源身份、卡顿和就绪都重算，并用本地源文件起播
      const sess = S.sessions.get(fileId);
      if (sess && sess.slot !== null && currentSession() === sess && S.playlist.seq === S.currentSeq && !S.switchingMedia) {
        onCurrentSessionReady(sess);
      }
    }
  } finally {
    S.pendingAdds.delete(fileId);
    releaseUnreferenced();
  }
  if (!roomEntered) await enterRoom();
}

async function addLinkItem(linkInfo) {
  initSwarmAndSync();
  const key = linkKey(linkInfo.url);
  S.links.set(key, { ...linkInfo, resolvedAt: linkInfo.resolvedAt || Date.now() });
  S.myLinks.add(key);
  const listed = S.playlist.queue.some((it) => it.kind === 'link' && it.url === key);
  if (!listed) {
    const res = await submitPlaylistOp({
      type: 'add',
      item: { kind: 'link', url: key, title: linkInfo.title || '', durationSec: linkInfo.duration || 0 },
    });
    if (!res.ok) throw playlistOpError(res);
  }
  if (!roomEntered) await enterRoom();
}

/* ------------------------------ 房间里加片 ------------------------------ */

let playlistRenderTimer = null;

/** 进度事件很密，列表重绘合并一下。 */
function renderPlaylistSoon() {
  if (playlistRenderTimer || !roomEntered) return;
  playlistRenderTimer = setTimeout(() => {
    playlistRenderTimer = null;
    renderPlaylist();
  }, 400);
}

const baseName = (p) => String(p || '').split(/[\\/]/).pop() || String(p || '');

function newPrepJob(fields) {
  return {
    key: randomId(6),
    state: 'queued', // queued → running → submitting →（完成后移除）/ failed
    text: '排队准备中',
    detail: '',
    tone: '',
    ratio: null,
    cancelled: false,
    cancelHooks: [],
    ...fields,
  };
}

/**
 * 房间里选了本地片：排进行内准备队列，一部一部来 ——
 * 算哈希很吃盘，选方案的弹窗也得一个一个问。
 */
function queueLocalFiles(paths) {
  if (!canEditPlaylist()) return;
  for (const path of paths) {
    // 同一个源文件加两次没有意义，而且拦不住：精简产物的字节不一定一样（MKV 的 SegmentUID
    // 每次都新生成），fileId 会不同，按 fileId 的去重放行，列表里就会出现两条同一部片，
    // 全员还要把它整个再收一遍。
    if (localPathAlreadyHere(path)) {
      log(`《${baseName(path)}》已经在列表里了，跳过`, 'warn');
      continue;
    }
    S.prepJobs.push(newPrepJob({ kind: 'file', path, name: baseName(path) }));
  }
  renderPlaylist();
  pumpPrepJobs();
}

/** 这个源文件是不是已经在准备队列里、或者已经开着做种会话。 */
function localPathAlreadyHere(path) {
  if (S.prepJobs.some((job) => job.kind === 'file' && job.state !== 'failed' && job.path === path)) return true;
  return [...S.sessions.values()].some((sess) => sess.isSeeder && sess.sourcePath === path);
}

let prepRunning = false;

async function pumpPrepJobs() {
  if (prepRunning) return;
  prepRunning = true;
  try {
    for (;;) {
      const job = S.prepJobs.find((j) => j.kind === 'file' && j.state === 'queued');
      if (!job) break;
      job.state = 'running';
      // 登记起来：离开房间时先等它收尾，转封装产物的回收、刚开的会话都在任务的后半截
      await trackPending(S.prepRuns, runPrepJob(job));
    }
  } finally {
    prepRunning = false;
  }
}

const PREP_STAGE_TEXT = ['正在检查格式', '正在优化传输体积', '正在计算分片校验值', '正在加入列表'];

/** 行内进度：只留阶段和进度条，长说明不往列表里塞。 */
function jobReporter(job) {
  return {
    label: job.name,
    stage: (index) => {
      job.text = PREP_STAGE_TEXT[index] || job.text;
      job.ratio = null;
      renderPlaylistSoon();
    },
    title: (text) => {
      job.text = text;
      renderPlaylistSoon();
    },
    note: () => {},
    progress: (ratio) => {
      job.ratio = ratio;
      renderPlaylistSoon();
    },
    cancelled: () => job.cancelled,
    // cancelPrepJob 用 splice 取走并清空钩子，之后注册的钩子再也不会被调用 ——
    // 已经取消了就当场执行，别让晚注册的收尾（比如关掉刚弹出来的弹窗）变成哑弹
    onCancel: (fn) => {
      if (job.cancelled) fn();
      else job.cancelHooks.push(fn);
    },
  };
}

async function runPrepJob(job) {
  try {
    const prepared = await prepareLocalFile(job.path, jobReporter(job));
    if (!prepared) {
      removePrepJob(job);
      return;
    }
    job.name = prepared.manifest.name;
    job.ratio = null;
    job.state = 'submitting';
    job.text = isRoomHost() ? '正在加入列表' : '等待房主确认';
    renderPlaylist();
    await addLocalFile(prepared);
    removePrepJob(job);
  } catch (error) {
    failPrepJob(job, error);
  }
}

function failPrepJob(job, error) {
  if (job.cancelled) {
    removePrepJob(job);
    return;
  }
  // 还没交给房主就失败的（格式不支持、没装 ffmpeg、算哈希出错、链接解析失败），
  // 别写成「房主没有接受」—— 房主根本没收到这个请求
  const blamedHost = job.state === 'submitting';
  job.state = 'failed';
  job.tone = 'bad';
  job.ratio = null;
  job.detail = String(error?.message || error || '');
  if (blamedHost && error?.uncertain) {
    // 请求交出去了、回执没等到（超时或直连断了）：房主那边可能已经加上了，别说成他不接受
    job.text = '没等到房主确认';
    log(`《${job.name}》没等到房主确认：${job.detail}`, 'warn');
  } else {
    job.text = blamedHost ? (isRoomHost() ? '没加进列表' : '房主没有接受') : '没法用这个文件';
    log(`《${job.name}》没加进列表：${job.detail}`, 'warn');
  }
  renderPlaylist();
}

function removePrepJob(job) {
  const i = S.prepJobs.indexOf(job);
  if (i !== -1) S.prepJobs.splice(i, 1);
  if (roomEntered) renderPlaylist();
}

function cancelPrepJob(job) {
  // 已经交给房主的就等回音，撤不回来
  if (job.state === 'submitting' || job.state === 'failed') return;
  job.cancelled = true;
  for (const fn of job.cancelHooks.splice(0)) fn();
  if (job.state === 'queued') {
    removePrepJob(job);
    return;
  }
  job.text = '正在取消';
  job.ratio = null;
  renderPlaylist();
}

/** 降成游客：还没交出去的准备一律撤掉。 */
function dropPrepJobsAfterDemotion() {
  const pending = S.prepJobs.filter((j) => j.state === 'queued' || j.state === 'running');
  if (!pending.length) return;
  log('你已不是管理员，还没加进列表的片撤回了', 'warn');
  for (const job of pending) cancelPrepJob(job);
}

/** 房间里加链接：解析也放在行内，不占整页。 */
async function addRoomLink(url) {
  if (!canEditPlaylist()) return;
  const job = newPrepJob({ kind: 'link', name: url, state: 'running', text: '正在解析视频链接' });
  S.prepJobs.push(job);
  renderPlaylist();
  try {
    const info = await window.sw.media.inspectLink(url);
    if (job.cancelled) {
      removePrepJob(job);
      return;
    }
    job.name = info.title || url;
    job.state = 'submitting';
    job.text = isRoomHost() ? '正在加入列表' : '等待房主确认';
    renderPlaylist();
    await addLinkItem(info);
    removePrepJob(job);
  } catch (error) {
    failPrepJob(job, error);
  }
}

function prepJobView(job) {
  let actions = [{ key: 'job-cancel', label: '取消' }];
  if (job.state === 'failed') actions = [{ key: 'job-dismiss', label: '知道了' }];
  else if (job.state === 'submitting' || job.cancelled) actions = [];
  return { key: job.key, name: job.name, text: job.text, detail: job.detail, tone: job.tone, ratio: job.ratio, actions };
}

/** 从资源管理器拖进列表的文件。 */
async function addDroppedFiles(files) {
  if (!canEditPlaylist()) return;
  const { paths, failures } = await approvedDropPaths(files);
  // 每个没加上的都说清楚为什么：一起拖进来的其余文件照常排队
  for (const failure of failures) log(dropFailureLine(failure), 'warn');
  if (paths.length) queueLocalFiles(paths);
}

/** 列表操作：房主直接执行，其他控制者发给房主等回音。 */
function submitPlaylistOp(op) {
  if (!S.sync?.canIControl()) return Promise.resolve({ ok: false, reason: '你没有编辑播放列表的权限' });
  if (isRoomHost()) return hostApplyOp(op, { actor: S.peerId, actorName: S.name });
  const host = S.hostId ? S.swarm?.peers.get(S.hostId) : null;
  if (!host?.authenticated) return Promise.resolve({ ok: false, reason: '和房主的连接断了' });
  const reqId = randomId(8);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      S.pendingOps.delete(reqId);
      // uncertain：请求已经交给房主了，只是没等到回执 —— 他那边可能已经改了，结果以列表为准
      resolve({ ok: false, reason: '房主没有回应', uncertain: true });
    }, PLAYLIST_OP_TIMEOUT_MS);
    S.pendingOps.set(reqId, (result) => {
      clearTimeout(timer);
      S.pendingOps.delete(reqId);
      resolve(result);
    });
    if (!host.send({ t: MSG.PLAYLIST_OP, reqId, op })) {
      S.pendingOps.get(reqId)?.({ ok: false, reason: '和房主的连接断了' });
    }
  });
}

/**
 * 和房主的直连断了（正在重连，或者他真的走了）：还在等回执的列表操作当场结束。
 * 回执走的是那条旧连接，断了就再也送不回来 —— 不结算的话要干等 45 秒超时，
 * 准备行这期间连个取消按钮都没有。请求可能已经在房主那边执行了，所以不说「没改成」。
 */
function settlePendingOpsHostLost() {
  for (const settle of [...S.pendingOps.values()]) {
    settle({ ok: false, reason: '和房主的连接断了，结果以列表为准', uncertain: true });
  }
}

/** 列表操作没成功时抛给准备行的错误。uncertain 跟着带过去：没等到回执和房主明确拒绝，说法不一样。 */
function playlistOpError(res) {
  const error = new Error(res.reason || '没能加进播放列表');
  if (res.uncertain) error.uncertain = true;
  return error;
}

// 房主这边的列表操作一个接一个执行：管理员加片要先异步取清单，不能和别的操作交错。
let playlistOpChain = Promise.resolve();

function hostApplyOp(op, actor) {
  const run = playlistOpChain.then(() => hostApplyOpNow(op, actor));
  playlistOpChain = run.catch(() => {});
  return run;
}

async function hostApplyOpNow(op, { actor, actorName }) {
  if (!S.swarm || !S.sync) return { ok: false, reason: '房间已关闭' };
  if (!op || typeof op !== 'object') return { ok: false, reason: '无效的操作' };
  // 先查一遍权限，免得替没权限的人白跑一趟取清单；applyOp 里还会再查
  if (!S.sync.isController(actor)) return { ok: false, reason: '你没有编辑播放列表的权限' };
  const opCtx = () => ({
    actor,
    actorName,
    isController: (id) => S.sync.isController(id),
    newId: () => randomId(8),
    position: S.sync.sharedPositionNow(),
  });
  let manifest = null;
  if (op.type === 'add' && op.item?.kind === 'file' && actor !== S.peerId) {
    // 管理员加的本地片：先向他要清单，过一遍主进程校验，对得上才入列。
    const item = op.item;
    // 列表满了、已经有这部片了：不落地先预演一遍，过不了就不去要清单。
    // 列表操作在这条串行链上一个接一个执行，预演和下面的真执行之间列表不会变长。
    const precheck = applyOp(S.playlist, { type: 'add', sourceId: actor, item }, { ...opCtx(), newId: () => '00000000' });
    if (!precheck.ok) return precheck;
    try {
      manifest = await S.swarm.requestManifest(item.fileId, {
        candidates: [actor],
        expect: { name: item.name, size: item.size, chunkCount: item.chunkCount },
      });
      await window.sw.store.validateManifest(manifest);
    } catch (error) {
      return { ok: false, reason: `没拿到这部片的清单：${error.message || error}` };
    }
    op = {
      type: 'add',
      sourceId: actor,
      item: { ...fileItemOf(manifest), durationSec: Number(item.durationSec) || manifest.durationSec || 0 },
    };
  }
  const before = S.playlist;
  const res = applyOp(before, op, opCtx());
  if (res.ok && !res.unchanged) {
    if (manifest) {
      // 真入列了才记下、挂出清单（被拒的不留）。校验过的清单房主自己也挂出来 ——
      // 极简模式下其他成员只连得到房主。要赶在广播列表之前挂，别人收到列表马上就会来要。
      S.knownManifests.set(manifest.fileId, manifest);
      if (!S.swarm.fileByFileId(manifest.fileId)) {
        S.swarm.offerManifest(manifest);
        S.hostOffered.add(manifest.fileId);
      }
    }
    commitPlaylist(res.state);
    if (res.state.seq !== before.seq) armAutoStart(op, before, res.state);
  }
  if (res.ok && res.effects?.includes('start') && res.state.seq === S.playlist.seq) startCurrentNow();
  if (res.effects?.includes('finished')) log('列表已播完', 'good');
  return res;
}

/**
 * 换上来的这一部要不要在大家都准备好之后自动开播：
 *  - 放完自动接下一部（自动连播开着时）；
 *  - 「立即播放」是明说要放；
 *  - 正在放的那部被移除，等同于放完。
 * 开房后的第一部、开播前调整顺序换上来的，都等人手动开始。
 */
function armAutoStart(op, before, after) {
  // 「这一场是不是正在连播」：正在放，或者已经上膛在等大家就绪。只看 before.started 的话，
  // 放完 A、B 上膛等人期间把 B 移除或把别的片拖到首位会白白卸膛；而开房后第一部还没开播就
  // 「跳过这一部」，反倒会把第二部上膛。
  const live = before.started || S.autoStartSeq === before.seq;
  const arm =
    op.type === 'playNow' ||
    (live && after.autoplay && (op.type === 'ended' || op.type === 'remove' || op.type === 'move'));
  S.autoStartSeq = arm && after.queue.length ? after.seq : null;
  S.autoStartReason = S.autoStartSeq === null ? null : op.type === 'playNow' ? 'playNow' : 'auto';
}

/** 房主改完列表：先广播，再在本机生效（本机生效时会发这一部的初始 SYNC，顺序不能反）。 */
function commitPlaylist(next) {
  S.playlist = next;
  S.swarm.broadcastLarge({ t: MSG.PLAYLIST, state: next });
  onPlaylistChanged();
}

/** 房主按在线情况刷新「来源已离开」。只有房主知道添加者还在不在。 */
function refreshSources() {
  if (!isRoomHost() || !S.swarm) return;
  const online = (id) => id === S.peerId || S.swarm.peers.get(id)?.authenticated === true;
  const next = markSources(S.playlist, online);
  if (next !== S.playlist) commitPlaylist(next);
}

function onPlaylistMessage(msg, peer) {
  // 列表只认房主那条连接发来的
  if (isRoomHost() || !S.hostId || peer.peerId !== S.hostId) return;
  const snap = validateSnapshot(msg.state);
  if (!snap) {
    log('收到一份格式不对的播放列表，已忽略', 'warn');
    return;
  }
  if (snap.rev <= S.playlist.rev) return;
  if (!sameItemsKept(S.playlist, snap)) {
    log('收到的播放列表把已有条目的内容换掉了，已忽略', 'warn');
    return;
  }
  S.playlist = snap;
  onPlaylistChanged();
}

// 房主这边每人最多排着几条列表操作。操作链是串行的，前面有一条在等清单（最长 30 秒）时，
// 后面来的全堆在链上 —— 一直刷的人能把它排到内存耗尽。
const PLAYLIST_OP_QUEUE_PER_PEER = 8;
const playlistOpQueued = new Map();

function onPlaylistOp(msg, peer) {
  if (!isRoomHost() || typeof msg.reqId !== 'string' || !msg.reqId || msg.reqId.length > 32) return;
  const refuse = (reason) => peer.send({ t: MSG.PLAYLIST_ACK, reqId: msg.reqId, ok: false, reason, id: '' });
  // 没权限的不进队：队里还会再查一遍，但排队这件事本身就能被游客拿来刷
  if (!S.sync?.isController(peer.peerId)) return refuse('你没有编辑播放列表的权限');
  const queued = playlistOpQueued.get(peer.peerId) || 0;
  if (queued >= PLAYLIST_OP_QUEUE_PER_PEER) return refuse('操作太频繁了，稍后再试');
  playlistOpQueued.set(peer.peerId, queued + 1);
  hostApplyOp(msg.op, { actor: peer.peerId, actorName: peer.name })
    .catch((error) => ({ ok: false, reason: error.message || String(error) }))
    .then((res) => {
      const left = (playlistOpQueued.get(peer.peerId) || 1) - 1;
      if (left > 0) playlistOpQueued.set(peer.peerId, left);
      else playlistOpQueued.delete(peer.peerId);
      // 按 peerId 取他眼下的连接回执：排在前面的加片要等清单，这期间直连可能已经重连成一条新的，
      // 发到收请求时那条旧连接上就丢了
      const to = S.swarm?.peers.get(peer.peerId) || peer;
      to.send({
        t: MSG.PLAYLIST_ACK,
        reqId: msg.reqId,
        ok: res.ok === true,
        reason: res.ok ? '' : String(res.reason || '').slice(0, 200),
        id: typeof res.id === 'string' ? res.id : '',
      });
    });
}

function onPlaylistAck(msg, peer) {
  if (peer.peerId !== S.hostId || typeof msg.reqId !== 'string') return;
  S.pendingOps.get(msg.reqId)?.({
    ok: msg.ok === true,
    reason: typeof msg.reason === 'string' ? msg.reason.slice(0, 200) : '',
    id: typeof msg.id === 'string' ? msg.id.slice(0, 32) : '',
  });
}

/**
 * 同一个 id 必须还是同一样东西。房主把某一项的网址、文件换掉而 id 不变的话，
 * 行里、横幅上写着的还是原来那个，本人点「允许」批准的却是从没见过的网站。
 * 正常的增删改排序都不会动这三个字段，改了就整张拒收（和「少一项的列表比没有列表更糟」同策略）。
 */
function sameItemsKept(before, after) {
  const was = new Map();
  for (const it of [...before.queue, ...before.history]) was.set(it.id, it);
  for (const it of [...after.queue, ...after.history]) {
    const old = was.get(it.id);
    if (!old) continue;
    if (old.kind !== it.kind || old.url !== it.url || old.fileId !== it.fileId) return false;
  }
  return true;
}

/** 列表变了之后的统一收口：槽位登记、当前项切换、传输顺序、释放不再引用的会话。 */
function onPlaylistChanged() {
  if (!S.swarm || !S.sync) return;
  S.swarm.setCatalog(catalogOf(S.playlist));
  attachLocalFiles();
  const cur = currentItem(S.playlist);
  if (S.playlist.seq !== S.currentSeq) {
    switchCurrent(cur).catch((error) => log(`切换到下一部失败：${error.message || error}`, 'bad'));
  } else {
    S.current = cur;
    // 同一 seq 下当前项的内容被换掉（网址变了）：正在问的那次授权作废，按新网址重新问
    if (cur?.kind === 'link' && linkAsking() && S.linkConsent.origin !== siteOf(cur.url)) {
      askLinkConsent(cur, S.currentSeq);
    }
  }
  updateTransfer();
  releaseUnreferenced();
  preResolveNextLink();
  pumpScans();
  if (roomEntered) {
    renderFilmInfo();
    renderPlaylist();
    // 当前项的内容变了，横幅也得跟着变；不然它能一直停在上一份快照写的网站上
    renderStatus();
  }
}

/** 本机已有会话、列表里刚分到槽位的片，挂进 swarm。 */
function attachLocalFiles() {
  for (const it of catalogOf(S.playlist)) {
    const sess = S.sessions.get(it.fileId);
    if (!sess || sess.slot === it.slot) continue;
    if (sess.slot !== null) S.swarm.removeFile(sess.slot);
    sess.slot = it.slot;
    S.swarm.addFile({
      slot: it.slot,
      manifest: sess.manifest,
      sessionId: sess.sessionId,
      isSeeder: sess.isSeeder,
      state: sess.state,
    });
  }
}

/**
 * 换当前项。旧播放器先退（等进程真正退出），同步引擎换到新的 seq；
 * 房主顺带广播这一部的初始状态（从 resumeAt 开始，暂停着）。
 */
async function switchCurrent(item) {
  const seq = S.playlist.seq;
  // 刚放过的那部记个时间：磁盘不够时先清最久没放的
  const previous = currentSession();
  if (previous) previous.lastPlayedAt = Date.now();
  S.currentSeq = seq;
  S.current = item;
  S.switchingMedia = true;
  $('btn-playpause').disabled = true;
  $('btn-reopen')?.classList.add('hidden');
  // 正在扫的旧片接着在后台扫；新一部要扫时由 pumpScans 叫它让路
  setScanTicker(false);
  S.linkConsent = null;
  S.fallbackConsent = null;
  // 旧播放器在主进程处理到 quit 之前发出的 tick 还会陆续到达，一律按代号丢掉
  const quitting = retirePlayer();
  // 上一部的弹幕不能飞到下一部去
  S.danmaku?.clear();
  syncCurrentMirrors();
  S.swarm.setPlaying(item?.kind === 'file' ? item.slot : null);
  S.sync.resetMedia({
    isSeeder: S.isSeeder,
    seq,
    position: item?.resumeAt || 0,
    broadcast: isRoomHost(),
  });
  S.sync.setFollow({ streaming: item?.kind === 'link', mode: linkFollowMode() });
  if (item) S.sync.setMediaInfo({ duration: item.durationSec || 0, size: item.kind === 'file' ? item.size : 0 });
  S.sync.sizeHint = item?.kind === 'file' ? item.size : 0;
  if (roomEntered) {
    refreshMediaUi();
    renderStatus();
  }
  await quitting;
  if (S.currentSeq !== seq) return;
  S.switchingMedia = false;
  const now = currentSession();
  if (now) now.lastPlayedAt = Date.now();
  updateLocalReady();
  pumpScans();
  if (!item) {
    if (roomEntered) log('播放列表已经放完了', 'good');
    return;
  }
  if (roomEntered) {
    const playing = `现在放：${item.kind === 'link' ? item.title || item.url : item.name}`;
    log(playing, 'good');
    S.chat?.note(playing);
  }
  wantDownload(item);
  if (item.kind === 'link') await activateLinkItem(item, seq);
  else onFileItemCurrent(item);
}

function onFileItemCurrent(item) {
  const sess = S.sessions.get(item.fileId);
  renderFilmInfo();
  if (sess) {
    onCurrentSessionReady(sess);
    return;
  }
  // 本机注定收不下这一部（拒收过、磁盘放不下）：不会有会话，也就不会有进度事件来解除卡顿，
  // 拿 0 字节去参与卡顿判断会让全房一直等我。本机退出这一部的卡顿判定。
  if (localOptedOut(item)) {
    skipCurrentLocally();
    return;
  }
  // 还没有本机会话：updateTransfer 会去要清单、开会话，开好后回到 onCurrentSessionReady。
  // 这段时间也要参与卡顿判断 —— 手上一片都没有，别让别人以为我准备好了。
  if (S.syncStarted) S.sync.onBufferProgress({ contiguousBytes: 0, runBytes: 0, complete: false });
}

/**
 * 本机收不下这一部：扫描或清单被拒收过，或者磁盘放不下。这一部本机不参与就绪和卡顿，不挡别人。
 * 腾出空间后（diskFull 清空）重新开出会话，onCurrentSessionReady 会按真实进度重新参与。
 */
function localOptedOut(item) {
  return item?.kind === 'file' && (S.blockedFiles.has(item.fileId) || S.diskFull.has(item.fileId));
}

/** 当前项本机收不下：按「已收完」报一次，放掉本机的卡顿（控制者会广播解除），界面说明原因。 */
function skipCurrentLocally() {
  if (S.syncStarted) S.sync.onBufferProgress({ contiguousBytes: 0, runBytes: 0, complete: true });
  updateLocalReady();
  if (roomEntered) {
    renderFilmInfo();
    renderStatus();
  }
}

/** 当前项的会话就绪：同步引擎开工（哪怕播放器还没起，也要参与 stall 计算）。 */
function onCurrentSessionReady(sess) {
  if (S.leaving) return; // 离开房间途中还有半截交接在跑，别再把同步和播放器拉起来
  // 重新就绪（改做种、重新开出会话）：之前记下的「这一部别自动拉起」作废，按新会话重新判断
  S.noAutoLaunchSeq = null;
  syncCurrentMirrors();
  S.sync.isSeeder = sess.isSeeder;
  renderFilmInfo();
  refreshMediaUi();
  if (!S.syncStarted) {
    S.syncStarted = true;
    S.sync.start();
  }
  // 必须先把房间播放位置告诉调度器，再取进度：runBytes 是「从播放位置起」的长度，
  // 不先置位的话第一拍还瞄着文件头 0，中途加入的人会拿一个毫不相干的数去判起播和卡顿。
  S.swarm.setPlaybackByte(sess.slot, roomPlayheadByte());
  const p = S.swarm.progress(sess.slot);
  S.sync.onBufferProgress({ contiguousBytes: p.contiguousBytes, runBytes: p.runBytes, complete: p.complete });
  announceMidJoin(sess, p);
  renderProgress(p);
  // 片源本地就有完整文件；之前已经收完、扫过的片也不用再等
  if (sess.isSeeder || playbackAllowed()) launchPlayer();
  else maybeLaunchPlayer(p);
  if (!sess.isSeeder && p.complete) verifyReceivedMedia();
  updateLocalReady();
}

let transferTimer = null;

/** 列表、来源、完成状态变化后重算传输顺序。事件密集时合并成一次。 */
function scheduleTransferUpdate() {
  if (transferTimer) return;
  transferTimer = setTimeout(() => {
    transferTimer = null;
    updateTransfer();
  }, 100);
}

/** 谁可能有这部片的清单：添加者、房主、手里有分片的人，最后是其他所有人。 */
function manifestCandidates(item) {
  const ids = [];
  const push = (id) => {
    if (id && id !== S.peerId && !ids.includes(id) && S.swarm.peers.get(id)?.authenticated) ids.push(id);
  };
  push(item.sourceId);
  push(S.hostId);
  for (const id of S.swarm.sourcesFor(item.slot)) push(id);
  for (const p of S.swarm.peers.values()) push(p.peerId);
  return ids;
}

/**
 * 传输严格按列表顺序：排在最前、本机还没收完、有人能供、磁盘放得下的那一部。
 * 换了目标时，swarm 会撤回旧目标的在途请求，已收的留着，回头接着传。
 */
function updateTransfer() {
  if (!S.swarm) return;
  const currentId = currentItem(S.playlist)?.id;
  let partial = null;
  const order = transferOrder(S.playlist, {
    isComplete: (it) => {
      const sess = S.sessions.get(it.fileId);
      return !!sess && (sess.isSeeder || S.swarm.files.get(it.slot)?.complete === true);
    },
    hasSource: (it) => {
      if (S.swarm.canFinish(it.slot)) return true;
      // 完整片源走了、谁手里都只剩一部分：可信房间边下边播，当前这部只要还有人有我缺的片就接着补，
      // 多补一段就能多看一段。后面各部的预下载仍然只挑收得齐的。
      if (S.roomSecurityMode !== 'trusted' || it.id !== currentId || !hasAnyMissing(S.swarm, it.slot)) return false;
      partial = it.slot;
      return true;
    },
    diskBlocked: (it) => S.blockedFiles.has(it.fileId) || S.diskFull.has(it.fileId),
  });
  const next = order[0] || null;
  S.partialSlot = next && next.slot === partial ? partial : null;
  if (next && !S.sessions.has(next.fileId)) openLeechFor(next);
  const ready = !!next && S.sessions.get(next.fileId)?.slot === next.slot;
  S.swarm.setActive(ready ? next.slot : null);
  renderPlaylistSoon();
}

async function openLeechFor(item) {
  const { fileId } = item;
  if (S.opening.has(fileId) || (S.manifestRetryAt.get(fileId) || 0) > Date.now()) return;
  S.opening.add(fileId);
  // 正在离开房间、或者本机正把这部片换成本地做种（pendingAdds）时，都不该再开接收会话
  // 只认队列：已播放区的片不再参与传输调度，为它开的会话一个分片都不会收，
  // 却要占一个文件句柄、还要按整片大小预留磁盘余量。清单在路上时这一部被跳过或放完，
  // 就会留下这么一个幽灵会话。
  const stillWanted = () =>
    !!S.swarm &&
    !S.leaving &&
    S.playlist.queue.some((it) => it.kind === 'file' && it.fileId === fileId) &&
    !S.sessions.has(fileId) &&
    !S.pendingAdds.has(fileId);
  try {
    const manifest =
      S.knownManifests.get(fileId) ||
      (await S.swarm.requestManifest(fileId, {
        candidates: manifestCandidates(item),
        // 片名以房主的列表为准：供片的人改了清单里的名字（比如换个扩展名）也不认
        expect: { name: item.name, size: item.size, chunkCount: item.chunkCount, durationSec: item.durationSec },
      }));
    S.knownManifests.set(fileId, manifest);
    if (!stillWanted()) return;
    let opened = null;
    // 上一次淘汰之前的可用空间：淘汰完一部却一点没变大，说明缓存文件删不掉（被别的程序占着），
    // 再删下去只会把已播放的缓存清光而一个字节都腾不出来
    let freeBefore = null;
    while (!opened) {
      try {
        opened = await trackPending(S.leechOpens, window.sw.store.openLeech(manifest));
      } catch (error) {
        const message = String(error.message || error);
        // 磁盘放不下和清单不安全是两回事，混成一句会让人去怀疑片子有问题。
        // Electron 会给主进程抛的错套一层「Error invoking remote method…」前缀，只取我们自己那句。
        const diskFull = message.match(/磁盘空间不够：[^\n]*/);
        if (diskFull) {
          // 先腾地方：已播放区里最久没放的那部的缓存（队列里还要的不动），腾完再试。
          // 但要先算「全清掉够不够」—— 不够就一部也不删，删了照样收不下，白丢已播放的缓存。
          const free = parseFreeBytes(message);
          // 手动清理模式从不自动删东西：放不下就停下来，让用户自己去清
          const manualCache = S.cachePolicy?.mode === 'manual';
          const victim = stillWanted() && !manualCache ? evictionVictim(manifest.size, free, freeBefore) : null;
          freeBefore = free;
          if (victim) {
            log(`磁盘空间不够，先清掉已播放的《${victim.manifest.name}》的缓存`, 'warn');
            S.sessions.delete(victim.fileId);
            await closeSession(victim);
            renderPlaylistSoon();
            // 删缓存要花一会儿，这期间可能已经点了离开房间、或者这一部换成了本地做种
            if (!stillWanted()) return;
            continue;
          }
          S.diskFull.add(fileId);
          if (manualCache) {
            log('手动清理模式不会自动删缓存：去「设置 → 管理缓存文件」里腾点地方', 'warn');
          } else if (stillWanted() && evictableSessions().length) {
            log('清掉已播放的缓存也放不下这一部，缓存先都留着', 'warn');
          }
          log(`没法接收《${item.name}》：${diskFull[0]}`, 'bad');
        } else if (/缓存位置用不了：/.test(message)) {
          // 缓存所在的盘拔了、没权限：不是片子的问题，不记成拒收、也不说成清单不安全。
          // 过一会儿再试（盘可能插回来了）；这段时间本机先不参与这一部（下面 skipCurrentLocally），别让全房等我
          S.manifestRetryAt.set(fileId, Date.now() + CACHE_IO_RETRY_MS);
          setTimeout(scheduleTransferUpdate, CACHE_IO_RETRY_MS + 50);
          log(`没法接收《${item.name}》：${message.match(/缓存位置用不了：[^\n]*/)[0]}`, 'bad');
        } else {
          S.blockedFiles.add(fileId);
          log(`已拒绝不安全的媒体清单：${message}`, 'bad');
        }
        // 收不下的正是当前项：onFileItemCurrent 可能已经按 0 字节喊了停，这里放掉
        if (S.current?.kind === 'file' && S.current.fileId === fileId && S.sync) skipCurrentLocally();
        return;
      }
    }
    if (!stillWanted()) {
      await trackClosing(window.sw.store.close(opened.sessionId).catch(() => {}));
      return;
    }
    const sess = newSession({ manifest, state: opened, filePath: opened.filePath, isSeeder: false });
    S.sessions.set(fileId, sess);
    attachLocalFiles();
    log(`开始接收：${manifest.name}（${fmtBytes(manifest.size)}，${manifest.chunkCount} 片）`, 'good');
    if (S.current?.kind === 'file' && S.current.fileId === fileId) onCurrentSessionReady(sess);
  } catch (error) {
    if (!S.swarm) return;
    S.manifestRetryAt.set(fileId, Date.now() + MANIFEST_RETRY_MS);
    setTimeout(scheduleTransferUpdate, MANIFEST_RETRY_MS + 50);
    log(`还没拿到《${item.name}》的清单：${error.message || error}`, 'warn');
  } finally {
    S.opening.delete(fileId);
    scheduleTransferUpdate();
  }
}

/** 队列和已播放区都不再引用的会话，关掉。 */
function releaseUnreferenced() {
  const refs = referencedFileIds(S.playlist);
  for (const [fileId, sess] of [...S.sessions]) {
    if (refs.has(fileId) || S.pendingAdds.has(fileId) || inAddGrace(fileId)) continue;
    S.sessions.delete(fileId);
    closeSession(sess).then(() => {
      // 腾出了空间，之前放不下的那几部再试一次
      if (!S.diskFull.size) return;
      S.diskFull.clear();
      scheduleTransferUpdate();
    });
  }
  for (const fileId of [...S.knownManifests.keys()]) {
    if (!refs.has(fileId)) S.knownManifests.delete(fileId);
  }
  // 房主替管理员挂出的清单：条目没了就撤回（开过会话的，closeSession 已经撤过，再撤一次无妨）。
  // 本机正在加同一部片的先不动，它自己挂的清单要留着给房主来取。
  for (const fileId of [...S.hostOffered]) {
    if (refs.has(fileId) || S.pendingAdds.has(fileId) || inAddGrace(fileId)) continue;
    S.hostOffered.delete(fileId);
    if (!S.sessions.has(fileId)) S.swarm?.withdrawManifest(fileId);
  }
}

/**
 * 腾出了空间（在「管理缓存文件」里删了文件、清掉了残留）：之前放不下、被跳过的那几部再试一次。
 * 还是放不下 openLeechFor 会再把它记回 diskFull，不会来回打转。
 */
function retryDiskFull() {
  if (!S.diskFull.size) return;
  S.diskFull.clear();
  scheduleTransferUpdate();
}

/**
 * 磁盘不够时先清谁：已播放区里最久没放的那部接收缓存。
 * 队列里还要的、正在加的、自己的片源文件（清了也腾不出地方）都不动。
 */
function evictableSessions() {
  const queued = new Set(S.playlist.queue.filter((it) => it.kind === 'file').map((it) => it.fileId));
  return [...S.sessions.values()]
    .filter((sess) => !sess.isSeeder && !queued.has(sess.fileId) && !S.pendingAdds.has(sess.fileId))
    .sort((a, b) => (a.lastPlayedAt || 0) - (b.lastPlayedAt || 0));
}

function evictableSession() {
  return evictableSessions()[0] || null;
}

/** 从主进程那句「磁盘空间不够：…只剩 X GB」里读回可用空间（字节）；读不出来返回 null。 */
function parseFreeBytes(message) {
  const m = /只剩\s*([\d.]+)\s*GB/.exec(String(message || ''));
  if (!m) return null;
  const gb = Number(m[1]);
  return Number.isFinite(gb) ? Math.round(gb * 1024 ** 3) : null;
}

/**
 * 磁盘不够时挑一部淘汰 —— 清得够才动手。
 *
 * 原来是「失败一次删一部再试」的贪心循环：可用 10GB、已播放区三份各 2GB、要收 80GB 的片，
 * 三份缓存会被逐个删光，那一部照样收不下，净亏三部片的缓存（再看要重传）。
 * 所以先算 可用 + 所有可淘汰缓存 够不够，不够就一部也不删。
 */
function evictionVictim(needed, free, freeBefore) {
  const victims = evictableSessions();
  if (!victims.length) return null;
  if (free === null) return victims[0]; // 读不出余量：退回「删一部试一次」的老办法
  if (freeBefore !== null && free <= freeBefore) return null; // 上一部删了等于没删，别再往下清
  const reserve = Math.max(256 * 1024 * 1024, Math.round(needed * 0.01));
  const total = victims.reduce((sum, sess) => sum + (sess.manifest?.size || 0), 0);
  if (free + total < needed + reserve) return null;
  return victims[0];
}

/** 加片超时后的宽限期：房主可能还在排队处理，先别把会话和清单撤掉。 */
function inAddGrace(fileId) {
  const until = S.addGrace.get(fileId);
  if (!until) return false;
  if (until > Date.now()) return true;
  S.addGrace.delete(fileId);
  return false;
}

/**
 * 本机不再有这个槽位的片了，告诉所有人。
 *
 * 收完整部时会广播 full:true，对端此后一直把我当完整片源。淘汰已播放区的缓存、
 * 扫出威胁销毁缓存时槽位还在列表里，光 removeFile 一条消息都不发：别人点「再放一次」
 * 就会为一部谁都供不了的片开会话，磁盘紧时还会先淘汰他自己的缓存。
 */
function announceGone(slot) {
  if (slot === null || slot === undefined || !S.swarm) return;
  for (const peer of S.swarm.peers.values()) {
    if (peer.authenticated) peer.send({ t: MSG.DENY, s: slot, index: 0, gone: true });
  }
}

function closeSession(sess) {
  announceGone(sess.slot);
  if (sess.slot !== null) S.swarm?.removeFile(sess.slot);
  S.swarm?.withdrawManifest(sess.fileId);
  return trackClosing(
    (async () => {
      // 播放器可能还开着这个文件：等它退出再删缓存，不然删不掉
      await S.playerQuit;
      await window.sw.store.close(sess.sessionId).catch(() => {});
    })()
  );
}

/** 把一个在途操作记进集合，结束后自动摘掉。 */
function trackPending(set, promise) {
  set.add(promise);
  promise.then(
    () => set.delete(promise),
    () => set.delete(promise)
  );
  return promise;
}

/**
 * 正在收尾的会话。已经从 S.sessions 摘掉、还没关完的会话只有这里记着：
 * 离开房间时不等它们，页面一刷新，没发出去的 store.close 就永远发不出去了，
 * 主进程里的会话和整部片的缓存要留到应用退出。
 */
function trackClosing(promise) {
  return trackPending(S.closing, promise);
}

/**
 * 退掉当前播放器，不等它退完（要等就 await 返回值，关会话前 await S.playerQuit）。
 * PlayerManager.quit 会先摘监听器，这一代不会再有 exit 回来，播放器状态只能在这里自己复位；
 * 之前每一代的迟到事件、在途的启动也一并作废。
 */
function retirePlayer() {
  playerGate.retire();
  // 换播放器途中又被别处退了一次（换片、拦下威胁、改做种）：那次切换的启动随之作废，独占让出来
  S.relaunchingPlayer = false;
  const quitting = window.sw.player.quit().catch(() => {});
  // 上一次退出可能还没落地（主进程已经没有当前播放器，这一次 quit 会立刻返回）：连它一起等
  S.playerQuit = Promise.all([S.playerQuit, quitting]).then(() => {});
  S.mpvRunning = false;
  lastMpvBanner = '';
  S.danmaku?.setActive(false);
  S.sync?.forgetPlayerState?.();
  return quitting;
}

/**
 * 选这一场到底传哪个版本的文件。
 *
 * 想少传字节，无损的路只有一条：把这一场用不上的轨丢掉（多余音轨、图形字幕）。
 * 视频码流本身压不动 —— H.264/H.265 的输出熵接近满，再套一层通用压缩是零收益，
 * 所以传输过程里不做任何额外压缩，这个面板里也只给无损选项。
 */
/** 一条轨在选择面板里怎么显示：语言、标题、编码、声道、码率，有什么写什么。 */
function trackLabel(s) {
  const bits = [];
  if (s.language) bits.push(s.language.toUpperCase());
  if (s.title) bits.push(s.title);
  bits.push(s.codecName || '?');
  if (s.channels) bits.push(`${s.channels}ch`);
  if (s.bitRate) bits.push(`${Math.round(s.bitRate / 1000)} kbps${s.bitRateEstimated ? '≈' : ''}`);
  return bits.join(' · ');
}

/**
 * 「这一场要传哪个版本」。
 *
 * 三件事在这里定下来：用哪种处理方式、留哪条音轨、要不要把未压缩的 PCM 转成 FLAC。
 * 音轨必须能选而不是自动挑默认轨 —— 一部日语番剧的 default 轨常常是英配，
 * 自动挑的结果就是把大家真正要听的那条丢了，而这一步是不可逆的。
 *
 * 第四件事是外挂字幕：勾上哪几条就封哪几条进 MKV。
 *
 * @returns {Promise<{plan:'slim'|'remux'|'convert'|'as-is', keepIndexes:number[]|null, toFlac:number[]|null, subtitles:string[]}|null>}
 */
const UPLINK_FRESH_MS = 30 * 60 * 1000;

/**
 * 选片时的卡顿预判：房主上行按房间人数平分之后，每人分到的速度够不够这个码率。
 *
 * 会卡或余量很薄就弹窗问一句，由房主决定要不要继续。测不出上行、或者不知道时长
 * （没装 ffmpeg 就探测不到）时不拦，如实记一条日志 —— 预判是帮房主拿主意，不是替他拿。
 *
 * 人数按房间人数上限算而不是按当前在线人数：开房时一个人都还没进来，而上限就是
 * 房主自己许诺能容纳的人数。上限设大了，这里就该提醒他。
 *
 * @returns {Promise<boolean>} 是否继续
 */
async function confirmStreamability({ size, duration, uplinkPromise, canSlimMore = false, reporter }) {
  const bitrate = bitrateOf(size, duration);
  if (!(bitrate > 0)) {
    log('不知道这个片子的时长（需要 ffmpeg 才能探测），没法预判成员会不会卡。', 'warn');
    return true;
  }

  reporter.title('正在评估上行带宽');
  reporter.note(
    '往最近的 Cloudflare 测速节点传一小段随机数据，估算你的上行能同时供几个人流畅边下边播。只发随机字节，不涉及片子内容。'
  );
  // 主进程那边单次请求 8 秒超时、总预算 12 秒，最坏要二十秒才放弃。开房不该为一个
  // 辅助判断卡这么久，这边再兜一道 15 秒。
  const measured = await Promise.race([
    uplinkPromise,
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: '测速超过 15 秒' }), 15_000)),
  ]);
  // 这十几秒里可能已经点了行内「取消」：就地收手。否则一个已经取消的任务会弹出全屏弹窗，
  // 把排在后面的弹窗一起挡住，而它自己的关闭钩子是在弹窗之后才注册的。
  if (reporter.cancelled?.() === true) return false;
  if (!measured?.ok) {
    log(`上行带宽没测出来，跳过卡顿预判：${measured?.reason || '未知原因'}`, 'warn');
    return true;
  }
  S.uplinkEstimate = { bytesPerSec: measured.bytesPerSec, measuredAt: measured.measuredAt };

  // 管理员加的片：极简模式是星型，他只供房主一个人，再由房主转给其他人；
  // 信令模式下他直接供房间里的其他人。人数上限只有房主能改，这条建议也不给他。
  const asAdmin = roomEntered && !isRoomHost();
  let viewers = Math.max(1, S.roomCapacity - 1);
  if (asAdmin) viewers = S.mode === 'manual' ? 1 : Math.max(1, connectedPeerCount());
  const verdict = hostPrecheck({ uplink: measured.bytesPerSec, bitrate, viewers });
  if (verdict.level === 'ok' || verdict.level === 'unknown') return true;

  // 建议只列真能做的：片子没有可精简的轨就别让人回去找「无损精简」；
  // 房间已经开着时安全模式改不了（两边必须一致），人数上限也是在邀请区改而不是设置里。
  const advice = [];
  if (canSlimMore) advice.push('取消后重新选这个文件，改选「无损精简」，能降低一些码率');
  if (!asAdmin) advice.push(roomEntered ? '在邀请区调小房间人数上限' : '在设置里调小新房间的默认人数上限');
  if (!roomEntered) advice.push('改用安全模式开房：成员收完再播，不会中途卡顿，只是要等');
  advice.push('也可以直接继续：成员缓冲不够时会自动暂停，攒够了再接着播');

  return new Promise((resolve) => {
    const modal = openModal({
      title: verdict.level === 'stall' ? '这个片子可能会让成员卡顿' : '上行带宽余量很薄',
      body: () => [
        reporter.label ? make('p', { raw: true, className: 'modal-name', text: reporter.label }) : null,
        field('文件码率', hint(fmtMbps(bitrate))),
        field('片长', hint(fmtTime(duration))),
        field('你的上行带宽（预估）', hint(fmtMbps(measured.bytesPerSec))),
        field(
          '每人分到的上行',
          hint(
            !asAdmin
              ? `${fmtMbps(verdict.perViewer)}（人数上限 ${S.roomCapacity} 人，除你之外 ${viewers} 人同时接收）`
              : S.mode === 'manual'
              ? `${fmtMbps(verdict.perViewer)}（极简模式下你只供房主一人，再由房主转给其他人）`
              : `${fmtMbps(verdict.perViewer)}（房间里另外 ${viewers} 人同时接收）`
          )
        ),
        field(
          '结论',
          hint(
            verdict.supported > 0
              ? `按这个码率，你的上行最多能同时供 ${verdict.supported} 人流畅边下边播。`
              : '按这个码率，你的上行连一个人都供不上流畅边下边播。'
          )
        ),
        field('可以怎么办', ...advice.map((line) => hint(line))),
      ],
      okText: '仍然继续',
      onOk: () => {
        resolve(true);
        return true;
      },
      onCancel: () => resolve(false),
    });
    reporter.onCancel(() => modal.cancel());
  });
}

// 精简时能随片走的轨道类型：音视频、字幕和 MKV 的字体附件。数据轨不在其列。
const KEEPABLE_TRACK_TYPES = new Set(['video', 'audio', 'subtitle', 'attachment']);

function choosePrepPlan(info, { needsRemux, optionalRemux = false, mustConvert = false, canSlim, subtitles = [], reporter }) {
  const slim = info.slim || {};
  const streams = info.probe?.streams || [];
  const audioTracks = streams.filter((s) => s.codecType === 'audio');
  // 门槛由主进程定（省不到这个数就不值得让用户等重编码），别在这边另写一个。
  const minFlacSaving = typeof slim.minFlacSaving === 'number' ? slim.minFlacSaving : 0.08;
  // 外挂字幕：默认全勾。勾上任何一条，产物就得是 MKV（MP4 装不下 ASS）。
  const subs = subtitles.map((s) => ({ ...s, checked: true }));
  const converting = () => mustConvert || subs.some((s) => s.checked);
  // 输出容器：MKV 进 MKV 出；要封成 MKV 的（AVI 这类、或带外挂字幕）出 MKV；
  // 其余出 MP4（顺带加 +faststart）。字幕勾选会改变它，所以是个函数。
  const toMkv = () => String(info.ext || '').toLowerCase() === '.mkv' || converting();
  // 不精简时那一项叫什么：封 MKV 时是「保留全部轨道」，否则是转封装或原样传。
  // 安全模式下 moov 在文件尾的 MP4 两样都给：默认原样传，转封装是可选的（optionalRemux）。
  const baseValue = () => (converting() ? 'convert' : needsRemux ? 'remux' : 'as-is');
  const baseValues = () => (!converting() && optionalRemux ? ['as-is', 'remux'] : [baseValue()]);
  let keepAudioIndex = slim.keepAudioIndex;

  // 换了要保留的音轨，丢掉的那批和能不能转 FLAC 都得跟着重算。
  const recompute = () => {
    // 没有可精简的东西时（比如只是需要转封装），一条轨都不该丢。
    // 少了这道判断，keepAudioIndex 会是 null，下面那个循环就把音轨全加进丢弃集了。
    if (!slim.available) {
      return { keepIndexes: null, toFlac: [], dropped: new Set(), saved: 0, complete: true, flacSaved: 0, chosen: null };
    }
    const dropped = new Set(slim.drop || []);
    for (const a of audioTracks) {
      if (a.index === keepAudioIndex) dropped.delete(a.index);
      else dropped.add(a.index);
    }
    // 数据轨（相机、剪辑软件导出的 MOV 常带 tmcd 时间码轨）哪种产物都放不进去，带上 ffmpeg 就整个失败 ——
    // 这里不列它，主进程按产物容器还会再筛一遍（封面、MP4 装不下的字幕）
    const keepIndexes = streams
      .filter((s) => KEEPABLE_TRACK_TYPES.has(s.codecType) && !dropped.has(s.index))
      .map((s) => s.index);
    const chosen = audioTracks.find((a) => a.index === keepAudioIndex);
    // flacRatio 是主进程对每条轨单独实测出来的（只有未压缩的 PCM 轨才有），
    // 换一条轨就得看那条自己的数字，不能沿用默认轨的结论。
    //
    // 容器这一条也必须判：FLAC-in-MP4 的播放器支持面太窄（安卓的 ExoPlayer 尤其），
    // 主进程的 canTranscodeToFlac 第一道判据就是它。这边漏掉的话，
    // MP4/MOV 源也会被提议转 FLAC，而产物是不可逆的。
    const flacOk = Boolean(
      toMkv() && chosen && typeof chosen.flacRatio === 'number' && chosen.flacRatio <= 1 - minFlacSaving
    );
    const toFlac = flacOk ? [chosen.index] : [];
    let saved = 0;
    let complete = true;
    for (const s of streams) {
      if (!dropped.has(s.index)) continue;
      if (!s.bitRate || !info.probe?.duration) {
        complete = false;
        continue;
      }
      saved += Math.round((s.bitRate / 8) * info.probe.duration);
    }
    let flacSaved = 0;
    if (flacOk && info.probe?.duration) {
      const bps =
        chosen.bitRate ||
        (chosen.sampleRate && chosen.channels && chosen.bitsPerRawSample
          ? chosen.sampleRate * chosen.channels * chosen.bitsPerRawSample
          : 0);
      if (bps) flacSaved = Math.round((bps / 8) * info.probe.duration * (1 - chosen.flacRatio));
    }
    return { keepIndexes, toFlac, dropped, saved, complete, flacSaved, chosen };
  };

  return new Promise((resolve) => {
    let picked = canSlim ? 'slim' : baseValue();
    let current = recompute();

    const modal = openModal({
      title: '这一场要传哪个版本',
      body: () => {
        const baseText = { convert: '保留全部轨道', remux: '仅转封装（保留全部轨道）', 'as-is': '原样传输' };
        // 勾掉或勾上字幕会改变「不精简」那一项是什么，选项要跟着重建
        const buildOptions = () => [
          ...(canSlim ? [make('option', { attrs: { value: 'slim' }, text: '无损精简（推荐）' })] : []),
          ...baseValues().map((value) => make('option', { attrs: { value }, text: baseText[value] })),
        ];
        const select = make('select', { id: 'prep-plan' }, buildOptions());
        select.value = picked;

        const detail = make('div', { id: 'prep-plan-detail' });

        // 外挂字幕：自动找到的默认全勾，也可以手动再加。排在最前的勾选项默认显示。
        const subsBox = make('div', { id: 'prep-subs', className: 'prep-subs' });
        const subsNote = make('div');
        const langName = (s) =>
          s.language === 'chi'
            ? s.rank === 0
              ? '简体中文'
              : s.rank === 2
                ? '繁体中文'
                : '中文'
            : { eng: '英文', jpn: '日文', kor: '韩文' }[s.language] || null;
        const renderSubs = () => {
          subsBox.replaceChildren();
          for (const s of subs) {
            const box = make('input', { attrs: { type: 'checkbox' }, props: { checked: s.checked } });
            box.onchange = () => {
              s.checked = box.checked;
              subsChanged();
            };
            const meta = [langName(s) ? t(langName(s)) : null, fmtBytes(s.size)].filter(Boolean).join(' · ');
            subsBox.appendChild(
              make('label', { className: 'check prep-sub' }, [
                box,
                make('span', { raw: true, className: 'prep-sub-name', text: s.name }),
                make('span', { raw: true, className: 'prep-sub-meta', text: meta }),
              ])
            );
          }
          if (!subs.length) subsBox.appendChild(hint('片子旁边没找到外挂字幕。'));
          const add = make('button', { className: 'ghost', attrs: { type: 'button' }, text: '添加字幕文件…' });
          add.onclick = async () => {
            const picks = await window.sw.dialog.pickSubtitles().catch(() => []);
            for (const p of picks) if (!subs.some((s) => s.path === p.path)) subs.push({ ...p, checked: true });
            subsChanged();
          };
          subsBox.appendChild(add);

          subsNote.replaceChildren(
            hint('勾上的字幕会封进片子一起传（只换容器、不重新编码），每个人在播放器里都能切换；第一条勾上的默认显示。')
          );
          if (!mustConvert && subs.some((s) => s.checked) && String(info.ext || '').toLowerCase() !== '.mkv') {
            subsNote.appendChild(hint('要带外挂字幕，产物会是 MKV —— MP4 装不下 ASS 字幕。'));
          }
        };
        const subsChanged = () => {
          if (picked !== 'slim' && !baseValues().includes(picked)) picked = baseValue();
          select.replaceChildren(...buildOptions());
          select.value = picked;
          current = recompute();
          renderSubs();
          renderDetail();
        };

        const renderDetail = () => {
          detail.replaceChildren();
          if (picked !== 'slim') return;

          // 每一段各自过一次翻译再拼 —— 拼完再翻的话，字典里得为每种轨道组合都写一条，
          // 那是不可能穷举的。
          const dropAudio = audioTracks.filter((a) => current.dropped.has(a.index)).length;
          const dropSubs = streams.filter(
            (s) => s.codecType === 'subtitle' && current.dropped.has(s.index)
          ).length;
          const droppedText = [
            dropAudio > 0 ? t(`${dropAudio} 条多余音轨`) : null,
            dropSubs > 0 ? t(`${dropSubs} 条图形字幕`) : null,
          ]
            .filter(Boolean)
            .join(currentLocale() === 'en' ? ', ' : '、');

          if (audioTracks.length > 1) {
            const audioSelect = make(
              'select',
              { id: 'prep-audio' },
              audioTracks.map((a) =>
                make('option', { attrs: { value: String(a.index) }, text: trackLabel(a) })
              )
            );
            audioSelect.value = String(keepAudioIndex);
            audioSelect.onchange = () => {
              keepAudioIndex = Number(audioSelect.value);
              current = recompute();
              renderDetail();
            };
            detail.appendChild(
              field(
                `保留哪条音轨（共 ${audioTracks.length} 条）`,
                audioSelect,
                hint('其余音轨会被丢掉。这一步不可逆，选错了得重新准备一次文件。')
              )
            );
          }

          if (droppedText) {
            detail.appendChild(
              field(
                '无损精简会做什么',
                hint(
                  '丢掉 ',
                  make('b', { props: { textContent: droppedText } }),
                  '，保留下来的轨',
                  make('b', { text: '原样搬运、不重新编码' }),
                  '，画质音质都不变，几秒到几十秒完成。'
                ),
                hint(
                  current.saved > 0
                    ? `${t(current.complete ? '预计省下' : '预计至少省下')} ${fmtBytes(current.saved)}`
                    : '这个文件没有可靠的每轨码率，省下多少估不出来'
                )
              )
            );
          }

          if (current.toFlac.length) {
            const pct = Math.round((1 - current.chosen.flacRatio) * 100);
            detail.appendChild(
              field(
                '还会把这条音轨压一遍（无损）',
                hint(
                  '这条轨是',
                  make('b', { text: '未压缩的 PCM' }),
                  '，转成 FLAC 是数学无损的 —— 解码出来的采样逐字节相同。已经拿这个文件实测过：能压掉',
                  make('b', { props: { textContent: `${pct}%` } }),
                  t(`，约 ${fmtBytes(current.flacSaved)}。`)
                ),
                hint('这一步要重新编码音频，比单纯丢轨慢，长片可能要几分钟。')
              )
            );
          }
        };

        select.onchange = () => {
          picked = select.value;
          renderDetail();
        };

        const parts = [];
        // 房间里几部片排着准备时，得说清楚这是在问哪一部
        if (reporter?.label) parts.push(make('p', { raw: true, className: 'modal-name', text: reporter.label }));
        if (needsRemux || mustConvert) parts.push(make('p', { className: 'fine', text: info.reason }));
        else if (optionalRemux) parts.push(make('p', { className: 'fine', text: SAFE_MOOV_NOTE }));
        parts.push(field('这一场传哪个版本', select));
        parts.push(detail);
        parts.push(field('外挂字幕', subsBox, subsNote));
        renderSubs();
        parts.push(
          field(
            '不会做的事',
            hint(
              '不降码率、不降分辨率。视频码流已经是编码器的输出，再套一层通用压缩是零收益，所以传输过程中不做任何额外压缩。'
            )
          )
        );
        parts.push(field('产物', hint('生成一个新文件放进临时缓存，原文件不动，退房时自动清理。')));
        renderDetail();
        return parts;
      },
      okText: '按这个方案继续',
      onOk: () => {
        const chosenSubs = subs.filter((s) => s.checked).map((s) => s.path);
        resolve(
          picked === 'slim'
            ? { plan: 'slim', keepIndexes: current.keepIndexes, toFlac: current.toFlac, subtitles: chosenSubs }
            : { plan: picked, keepIndexes: null, toFlac: null, subtitles: chosenSubs }
        );
        return true;
      },
      onCancel: () => resolve(null),
    });
    reporter?.onCancel(() => modal.cancel());
  });
}

/** 开房准备文件时的失败。加入流程的失败走 joinFail —— 标题别说成文件的问题。 */
function prepFail(msg, extra = '') {
  prepStop('没法用这个文件', msg, extra);
}

/** 加入流程的失败（找不到房主、连不上信令或中继、被移出、模式或版本对不上）。 */
function joinFail(msg, extra = '') {
  prepStop('没能加入房间', msg, extra);
}

/** 准备页上的一条结论：标题 + 说明 +（可选）补一行没处理完的文件，只留「返回」。 */
function prepStop(title, msg, extra = '') {
  // 这次尝试有了结论：之后再点开的邀请直接接手，不用再问「要不要放弃」
  endAttempt();
  show('view-prepare');
  $('prep-title').textContent = title;
  $('prep-note').textContent = msg;
  $('prep-bar').style.width = '0%';
  const back = make('button', { id: 'prep-back', className: 'ghost', text: '返回' });
  back.onclick = backHome;
  replace('prep-actions', ...(extra ? [hint(extra), back] : [back]));
}

function backHome() {
  // 没进成房就回首页：这次尝试的残局（信令、Swarm、SyncEngine、按邀请写下的房主身份）整个拆掉，
  // 下一次开房或加入从干净的状态开始
  if (!roomEntered) resetAttempt();
  show(roomEntered ? 'view-room' : 'view-home');
}

/* ---------------------------- 开房与加入的代次 ---------------------------- */

/*
 * 从首页发起的每一次开房或加入都是一次「尝试」，带一个代次号。
 *
 * 没进成房（找不到房主、超时、被拒、点了返回）时页面不会刷新，而 Swarm、SyncEngine、信令
 * 都是按那一次建的：SyncEngine 的 hostId 是那次的房主，Swarm 的安全模式是那次的设置。
 * 留着它们，之后自己开房会在引擎里变成游客（播放不广播、列表改不了），加入别的房间会把
 * 新房主的 ROLE / SYNC 全当成冒名丢掉，改过安全模式再开房则人人握手失败。
 * 所以每次新尝试开始前、以及没进成房回到首页时，把上一次的残局整个拆掉重来。
 *
 * 连信令、等房主放行、算哈希都跨好几个 await，期间可能已经换了一次尝试：过期的那次回来后
 * 拿自己的代次一比，对不上就什么都不动 —— 尤其不能去关当前那条信令，或者拿它的报错盖掉当前界面。
 */
const joinAttempt = {
  gen: 0,
  // 正在进行、还没有结论的那次：{ gen, kind: 'host' | 'join', key }。失败、取消、进房后置 null。
  // 信令加入连上服务器后还挂着 onHostGone(why, peer)：还没进房时房主走了或者连不上，由它给结论（见 watchServerJoin）
  busy: null,
  // 这次尝试挂着的收尾（定时器、正在跑的任务、弹着的选择框），换代时一并执行
  cleanups: [],
};

function attemptLive(gen) {
  return gen === joinAttempt.gen;
}

/** 开始一次新的开房或加入：先拆掉上一次没进成房的残局，再发一个新代次。 */
function beginAttempt(kind, key = '') {
  resetAttempt();
  joinAttempt.busy = { gen: joinAttempt.gen, kind, key };
  return joinAttempt.gen;
}

/** 当前这次尝试有了结论（失败或取消）。残局留到返回首页或下一次尝试时再拆。 */
function endAttempt() {
  joinAttempt.busy = null;
}

/** 同一条邀请的加入正在进行：双击、深链接又来一次，都不重来一遍。 */
function joiningWith(key) {
  return !!key && joinAttempt.busy?.kind === 'join' && joinAttempt.busy.key === key;
}

/** 认「是不是同一条邀请」用的键：同一个房间、同一位房主、同一份 offer。 */
function inviteKey(payload) {
  if (payload?.k === 'relay') return `relay|${payload.from}|${payload.key}`;
  if (payload?.k === 'room') return `room|${payload.url}|${payload.room}|${payload.from}`;
  if (payload?.k === 'offer') return `offer|${payload.from}|${JSON.stringify(payload.sdp ?? '')}`;
  return '';
}

/**
 * 拆掉一次没进成房的尝试留下的一切：信令、Swarm（连同里面还在打洞的 Peer）、SyncEngine、
 * 重连定时器、一对一邀请的占位连接，以及按那次邀请写下的房间字段。
 * 进了房就不拆 —— 退房走 leaveRoom，它会刷新页面。
 */
function resetAttempt() {
  if (roomEntered || S.leaving) return;
  joinAttempt.gen += 1;
  joinAttempt.busy = null;
  for (const fn of joinAttempt.cleanups.splice(0)) {
    try {
      fn();
    } catch {}
  }
  const sig = S.signaling;
  S.signaling = null;
  sig?.close();
  for (const peerId of [...RECOVERY.keys()]) cancelRecovery(peerId);
  RENEGOTIATING.clear();
  rebuildBudget.clear();
  S.pendingManualPeer?.close?.();
  S.pendingManualPeer = null;
  // 先摘监听再拆：destroy 会逐个关 Peer，那些关闭事件不能再落到界面和下一次尝试的状态上
  const { swarm, sync } = S;
  S.swarm = null;
  S.sync = null;
  sync?.removeAll();
  swarm?.removeAll();
  swarm?.destroy();
  S.role = null;
  S.hostId = null;
  S.mode = null;
  S.signalTransport = null;
  S.roomLink = null;
  S.relayInvite = null;
  S.roomId = null;
  S.roomSignalUrl = null;
  S.roomRelays = null;
  S.roomSecurityMode = null;
  S.isSeeder = false;
  S.hostGone = false;
  S.hostLink = null;
  // 加入时按邀请改过的人数上限，退回自己设的默认值
  S.roomCapacity = storedCapacity();
}

/** 准备页上那一行片名。片名来自邀请码，照样截一刀。 */
function inviteFileLine(file) {
  return file ? `${String(file.name || '').slice(0, 200)} · ${fmtBytes(file.size)}` : '';
}

/**
 * 准备页上的「取消」：不等了，回首页（这次尝试整个拆掉）。加入时等房主放行、打洞、等房主打开应答链接，
 * 开房时转封装、算哈希、解析链接，都靠它离开 —— 挂在这次尝试上的定时器和任务由 resetAttempt 一并收掉。
 */
function cancelJoinButton() {
  const cancel = make('button', { className: 'ghost', text: '取消' });
  cancel.onclick = backHome;
  return cancel;
}

/* ------------------------------ 加入放映 ------------------------------ */

async function handleJoinInput(rawInput) {
  const raw = String(rawInput || '').trim();
  $('join-err').textContent = '';
  if (!raw) return;

  try {
    const payload = await decodeCode(raw);

    if (payload.k === 'room') return joinViaServer(payload);
    if (payload.k === 'relay') return joinViaRelay(payload);
    if (payload.k === 'offer') return joinViaManual(payload);
    if (payload.k === 'answer') {
      if (S.role === 'host' && S.pendingManualPeer) return acceptManualAnswer(raw);
      $('join-err').textContent = '这是一个应答链接，应该由发起方打开。';
      return;
    }
    $('join-err').textContent = '无法识别的邀请码类型。';
  } catch (e) {
    $('join-err').textContent = e.message;
  }
}

$('btn-join').onclick = () => handleJoinInput($('join-code').value);

/** 邀请码末尾带着协议版本号，粘贴那一刻就能说清楚是哪一边旧。 */
function inviteVersionText(remote) {
  return remote < PROTOCOL_VERSION
    ? '这个邀请来自旧版 NoxReel（0.6.x），和 0.7 不互通。请让房主升级到 0.7 后重新发邀请。'
    : '这个邀请来自更新版本的 NoxReel，和本机不互通。请先升级本机的 NoxReel。';
}

/**
 * 邀请的安全模式和本机设置对不上时写在加入框下面的话。邀请已经在加入框里了（粘贴的、点开的深链接都是），
 * 改完设置点「加入」就行，不用回聊天软件再点一次链接。
 */
function modeMismatchText(inviteMode) {
  return `房间使用${securityModeLabel(inviteMode)}，你的本机设置是${securityModeLabel(S.settings.securityMode)}。请在设置里切换为相同模式，再点「加入」重试。`;
}

/** 极简模式：收到 offer，产出 answer 让对方粘回去。 */
async function joinViaManual(payload) {
  const inviteMode = normalizeSecurityMode(payload.securityMode);
  if (inviteMode !== normalizeSecurityMode(S.settings.securityMode)) {
    $('join-err').textContent = modeMismatchText(inviteMode);
    return;
  }
  if (payload.protocolVersion !== PROTOCOL_VERSION) {
    $('join-err').textContent = inviteVersionText(payload.protocolVersion);
    return;
  }
  const key = inviteKey(payload);
  if (joiningWith(key)) {
    show('view-prepare');
    return;
  }
  const gen = beginAttempt('join', key);
  S.role = 'guest';
  S.hostId = payload.from; // 邀请码里带着房主身份，认它做角色权威
  S.mode = 'manual';
  S.isSeeder = false;
  S.roomSecurityMode = inviteMode;
  S.roomCapacity = clampCapacity(payload.maxMembers || S.roomCapacity);

  show('view-prepare');
  // 从一开始就能取消：房主可能好几分钟才打开应答链接，最长要等 MANUAL_JOIN_WAIT_TIMEOUT_MS。
  // 顺带清掉上一次留下的按钮 —— 上一次结论页的「重新生成应答链接」攥着旧邀请，误点会把这一次拆掉、改连旧的
  replace('prep-actions', cancelJoinButton());
  $('prep-title').textContent = '正在建立点对点连接';
  $('prep-file').textContent = inviteFileLine(payload.file);
  $('prep-note').textContent = '正在收集网络候选地址，通常需要几秒钟…';
  setSteps([
    { label: '解析邀请码', state: 'done' },
    { label: '生成应答链接', state: 'active' },
    { label: '等待房主打开应答链接', state: '' },
  ]);
  $('prep-bar').style.width = '40%';

  // Cloudflare 的临时 TURN 账号可能要现取；取的这会儿可能已经换了一次尝试
  if (turnFetchNeeded()) {
    await ensureTurnReady();
    if (!attemptLive(gen)) return;
  }
  // 「隐藏我的 IP」开着却没有可用中继：不建连接，更不能悄悄退回直连
  const turnBlocked = relayOnlyBlocked();
  if (turnBlocked) return prepStop('还不能连接', turnBlocked);

  initSwarmAndSync();

  // 重试时同一个房主 id 会再来一次，先把上一条死连接摘掉，别让它占着成员表。
  S.swarm.removePeer(payload.from);

  const peer = new Peer({
    peerId: payload.from,
    name: peerName(payload.name, '发起者'),
    initiator: false,
    ...peerIce(),
    trickle: false, // 手动模式必须等候选集齐，SDP 得是自包含的
  });
  wirePeer(peer);
  S.swarm.addPeer(peer);

  // 应答生成之后本机就开始探测对方的候选地址了，而房主可能过好几分钟才粘贴。
  // 探测先失败的话，这条连接就废了 —— 房主那边再粘贴也连不上，界面却一直停在
  // 「等待房主打开应答链接」。所以失败要说出来，并且允许用同一份邀请重开一条。
  //
  // 只挂 'failed' 不够：对方的 NAT 如果连出口 IP 都随目标变（云上的多出口 NAT
  // 网关就是这样），ICE 会一直停在 checking 永远不进 failed，这条 handler 就永远
  // 不触发。实测房主端按 MANUAL_HANDSHAKE_TIMEOUT_MS 五十秒就给出了结论并备好新
  // 邀请链接，加入方这边十二分钟仍然停在「等待房主打开应答链接」，一个字都没有。
  // 所以再补一条定时兜底，和 'failed' 共用同一套收尾。
  let joinSettled = false;
  let joinWaitTimer = null;
  let offJoinAuthenticated = () => {};

  const finishJoin = (title, note) => {
    if (joinSettled || peer.authenticated || roomEntered || !attemptLive(gen)) return;
    // 用户点过「重新生成应答链接」的话，swarm 里已经换成新连接了，旧的定时器不能盖掉新界面。
    if (S.swarm?.peers?.get(payload.from) !== peer) return;
    joinSettled = true;
    endAttempt();
    clearTimeout(joinWaitTimer);
    offJoinAuthenticated();
    $('prep-title').textContent = title;
    // 硬编码的「可能 A 也可能 B」只是穷举，而候选诊断往往能直接说出是哪一个。
    // 以前诊断只写进 #event-log —— 那个节点在房间视图里，而这时候用户停在准备页，
    // 等于写进了一个他看不见的地方。
    const advice = connectionAdvice(peer);
    $('prep-note').textContent = advice?.text ? `${note}\n\n诊断：${advice.text}` : note;
    $('prep-bar').style.width = '0%';
    const retry = make('button', { className: 'primary', text: '重新生成应答链接' });
    retry.onclick = () => joinViaManual(payload).catch((error) => joinFail(error.message || String(error)));
    const back = make('button', { className: 'ghost', text: '返回' });
    back.onclick = backHome;
    replace('prep-actions', retry, back, copyDiagnosticsButton());
  };

  peer.on('failed', () =>
    finishJoin(
      '直连没建立起来',
      '和房主的直连探测失败了：可能是房主那边的邀请链接放太久、网络地址已经过期，也可能双方都在严格 NAT 后面。重新生成一条应答链接发回给房主再试一次；还是不行就双方在设置里配同一个 TURN 中继。'
    )
  );

  joinWaitTimer = setTimeout(
    () =>
      finishJoin(
        '还没能连上房主',
        '等了几分钟还是没连上。如果你已经把应答链接发回给房主了，那多半是打洞没成功：双方都在严格 NAT 后面时，需要各自在设置里配同一个 TURN 中继。如果房主还没打开你的应答链接，就重新生成一条再发一次 —— 链接放太久，里面的网络地址会过期。'
      ),
    MANUAL_JOIN_WAIT_TIMEOUT_MS
  );
  // 换了一次尝试就撤掉：留着它，三分钟里一直攥着这条已经拆掉的连接
  joinAttempt.cleanups.push(() => clearTimeout(joinWaitTimer));
  offJoinAuthenticated = S.swarm.on('peer-authenticated', (authenticatedPeer) => {
    if (authenticatedPeer !== peer) return;
    joinSettled = true;
    clearTimeout(joinWaitTimer);
    offJoinAuthenticated();
  });

  let code;
  try {
    const answer = await peer.acceptOffer(payload.sdp);
    code = await encodeCode({
      k: 'answer',
      from: S.peerId,
      name: S.name,
      sdp: answer,
      securityMode: S.roomSecurityMode,
      // 邀请的编号原样带回去：房主据此认出这是哪一条邀请的应答
      invite: payload.invite,
    });
  } catch (error) {
    // 以前这里的异常落到没人接住的地方，准备页永远停在「正在收集网络候选地址」
    if (attemptLive(gen)) joinFail(error.message || String(error));
    return;
  }
  // 收集候选要几秒，这期间可能已经换了一次尝试：界面归那边，这条应答不再往外交
  if (!attemptLive(gen)) return;
  // 发出去的是 https 跳转页：Discord 这类聊天软件只会把 https 变成能点的链接
  const answerLink = shareLink(code, 'answer');

  setSteps([
    { label: '解析邀请码', state: 'done' },
    { label: '生成应答链接', state: 'done' },
    { label: '等待房主打开应答链接', state: 'active' },
  ]);
  $('prep-bar').style.width = '75%';
  $('prep-title').textContent = '把应答链接发回给发起者';
  replace(
    'prep-note',
    make('b', { text: '还差最后一步：' }),
    '应答链接已经自动复制。把它发回给对方，对方点开即可完成连接；不需要再手动复制粘贴长码。零服务器的 WebRTC 仍必须交换一次应答。'
  );
  const answerArea = make('textarea', {
    id: 'answer-code',
    attrs: { readonly: '', rows: 4 },
  });
  answerArea.style.width = '100%';
  const answerAnchor = make('a', { id: 'answer-link', className: 'invite-link', text: 'NoxReel 应答链接' });
  answerAnchor.href = answerLink;
  answerAnchor.onclick = (event) => { event.preventDefault(); copyCode(answerLink, $('copy-answer'), '复制应答链接'); };
  const copyAnswer = make('button', { id: 'copy-answer', className: 'primary', text: '复制应答链接' });
  // 「取消」一直留着：发错了人、房主已经下线，不必干等到兜底定时器给结论
  replace('prep-actions', answerAnchor, copyAnswer, cancelJoinButton(), answerArea);
  $('answer-code').value = answerLink;
  $('answer-code').select();
  $('copy-answer').onclick = () => copyCode(answerLink, $('copy-answer'), '复制应答链接');
  window.sw.clipboard.writeText(answerLink).catch(() => {});

  // 只有双方 HELLO 中的房间模式也一致，swarm 才会真正放行并进入房间。
}

/** 信令模式：连服务器，进房间，等对方发 offer 过来。 */
async function joinViaServer(payload) {
  const inviteMode = normalizeSecurityMode(payload.securityMode);
  if (inviteMode !== normalizeSecurityMode(S.settings.securityMode)) {
    $('join-err').textContent = modeMismatchText(inviteMode);
    return;
  }
  if (payload.protocolVersion !== PROTOCOL_VERSION) {
    $('join-err').textContent = inviteVersionText(payload.protocolVersion);
    return;
  }
  const key = inviteKey(payload);
  if (joiningWith(key)) {
    show('view-prepare');
    return;
  }
  const gen = beginAttempt('join', key);
  S.role = 'guest';
  S.hostId = payload.from; // 邀请码里带着房主身份，认它做角色权威
  S.mode = 'server';
  S.isSeeder = false;
  S.roomSecurityMode = inviteMode;
  S.roomCapacity = clampCapacity(payload.maxMembers || S.roomCapacity);

  show('view-prepare');
  $('prep-title').textContent = '正在连接信令服务器';
  $('prep-file').textContent = inviteFileLine(payload.file);
  setSteps([
    { label: '解析邀请码', state: 'done' },
    { label: '连接信令服务器', state: 'active' },
    { label: '建立点对点连接', state: '' },
  ]);
  $('prep-bar').style.width = '35%';
  replace('prep-actions', cancelJoinButton());

  // 进了房间别人就会来连我：TURN 得在连信令之前备好，「隐藏我的 IP」没有中继就不进
  if (turnFetchNeeded()) {
    await ensureTurnReady();
    if (!attemptLive(gen)) return;
  }
  const turnBlocked = relayOnlyBlocked();
  if (turnBlocked) return prepStop('还不能连接', turnBlocked);

  initSwarmAndSync();

  try {
    await connectSignaling(payload.url, payload.room);
    if (!attemptLive(gen)) return;
    setSteps([
      { label: '解析邀请码', state: 'done' },
      { label: '连接信令服务器', state: 'done' },
      { label: '建立点对点连接', state: 'active' },
    ]);
    $('prep-bar').style.width = '70%';
    $('prep-note').textContent = '已进入房间，正在和其他成员打洞…';
    watchServerJoin(payload, gen);
  } catch (e) {
    // 已经换了一次尝试：这条信令在换代时就关掉了，眼下的 S.signaling 是后来那次的，碰不得
    if (!attemptLive(gen)) return;
    // 不关的话这条连接会一直按退避重连下去（WsSignaling 的 onclose 只看
    // _closedByUs），而 hostId 校验只在首次 connect() 的返回值上做过一次 ——
    // 重连成功后没人再校验，用户可能被静默拖进一个他已经放弃的房间。
    S.signaling?.close();
    S.signaling = null;
    // 房间已经关了：服务器是好的，别再叫人去折腾部署
    if (e.code === 'ROOM_CLOSED') return prepStop('房间已关闭', e.message);
    // 服务器明确回了原因（房间满、限流、地区拦截、身份冲突……）就只说原因：服务器是通的，
    // 叫人改用极简模式是误导。只有压根没拿到回复（没有 code）时才可能是对方没部署服务器
    return joinFail(
      e.code
        ? e.message
        : `${e.message}\n\n如果对方没有部署信令服务器，让他改用「极简模式」生成邀请码 —— 那个不需要服务器。`
    );
  }
}

// 信令加入连上服务器之后，最多等这么久还没进房就给个结论。退避重连走完三轮前 ICE 可能一直停在 checking、
// 永远不进 failed，那样就只能靠它；两分钟足够正常的打洞，比一对一邀请短 —— 这里不用等人转发链接
const SERVER_JOIN_WAIT_TIMEOUT_MS = 120_000;

/**
 * 信令加入连上了服务器，却可能一直进不了房：和房主打洞打不通（严格 NAT、没配 TURN），或者还没连上房主他就走了。
 * 三条路谁先到谁给结论：房主那一路退避用尽、房主离开（都经 hostReallyGone 转过来）、兜底定时器。
 * 结论只画在准备页上，不拆连接 —— 退避重连还在跑，晚一点连上照样进房；点「返回」「重试」才整个拆掉重来。
 */
function watchServerJoin(payload, gen) {
  const busy = joinAttempt.busy;
  if (!busy || busy.gen !== gen) return;
  let timer = null;
  const conclude = (why, peer = null) => {
    // 进了房、换了一次尝试、已经给过结论（endAttempt 把 busy 清掉了）：都不再动界面
    if (roomEntered || !attemptLive(gen) || joinAttempt.busy !== busy) return;
    clearTimeout(timer);
    // 诊断要一条真连接（有 pc、攒过候选）：信令恢复时补排的重连只带着 { peerId, name }，拿它诊断会说成「一个候选都没收集到」
    const host = [S.swarm?.peers.get(S.hostId), peer].find((p) => p?.pc) || null;
    if (why === 'left') {
      serverJoinStuck(
        payload,
        '房主离开了房间',
        '还没和房主连上，信令服务器就说他离开了。他只是掉线的话，回来后会自动接着连；否则请让房主重新发一条邀请。',
        null
      );
    } else if (why === 'unreachable') {
      serverJoinStuck(
        payload,
        '直连没建立起来',
        '和房主的直连试了几次都没打通，多半是双方都在严格 NAT 后面。双方在设置里配同一个 TURN 中继后，再点「重试」。',
        host
      );
    } else {
      serverJoinStuck(
        payload,
        '还没能连上房主',
        '等了两分钟还是没和房间里的人连上。多半是打洞没成功：双方都在严格 NAT 后面时，需要各自在设置里配同一个 TURN 中继。也可能是房主那边的网络断了。',
        host
      );
    }
  };
  // 挂在这次尝试上：结论、进房、换代之后 busy 都会换掉，hostReallyGone 就不会再找到它
  busy.onHostGone = conclude;
  timer = setTimeout(() => conclude('timeout'), SERVER_JOIN_WAIT_TIMEOUT_MS);
  joinAttempt.cleanups.push(() => clearTimeout(timer));
}

/** 信令加入卡住时准备页上的结论：原因 + 候选诊断 +「重试 / 返回 / 复制诊断信息」。 */
function serverJoinStuck(payload, title, note, peer) {
  endAttempt();
  show('view-prepare');
  $('prep-title').textContent = title;
  // 诊断单独一行：拼进同一段文字的话，英文界面按整句翻不出来
  const advice = peer ? connectionAdvice(peer) : null;
  replace('prep-note', make('div', { text: note }), advice?.text ? make('div', { text: `诊断：${advice.text}` }) : null);
  $('prep-bar').style.width = '0%';
  const retry = make('button', { className: 'primary', text: '重试' });
  retry.onclick = () => {
    // 先回首页把这次的残局拆掉：设置里改过安全模式的话，报错写在首页的加入框下面，得让人看得见
    backHome();
    joinViaServer(payload).catch((error) => joinFail(error.message || String(error)));
  };
  const back = make('button', { className: 'ghost', text: '返回' });
  back.onclick = backHome;
  replace('prep-actions', retry, back, copyDiagnosticsButton());
}

/**
 * 房间链接（经公共中继）加入。和 joinViaServer 同一套前置检查，区别只在信令走公共中继：
 * 房主放行（签名的 welcome）才算进房，房主身份由链接里的签名公钥担保。
 */
async function joinViaRelay(payload) {
  const inviteMode = normalizeSecurityMode(payload.securityMode);
  if (inviteMode !== normalizeSecurityMode(S.settings.securityMode)) {
    $('join-err').textContent = modeMismatchText(inviteMode);
    return;
  }
  if (payload.protocolVersion !== PROTOCOL_VERSION) {
    $('join-err').textContent = inviteVersionText(payload.protocolVersion);
    return;
  }
  if (!payload.key || !/^[0-9a-f]{64}$/.test(String(payload.hk || '')) || !payload.from) {
    $('join-err').textContent = '这个房间链接不完整，请让房主重新复制一次。';
    return;
  }
  const key = inviteKey(payload);
  if (joiningWith(key)) {
    show('view-prepare');
    return;
  }
  const gen = beginAttempt('join', key);
  S.role = 'guest';
  S.hostId = payload.from; // 链接里带着房主身份（和它的签名公钥），认它做角色权威
  S.mode = 'server';
  S.isSeeder = false;
  S.roomSecurityMode = inviteMode;
  S.roomCapacity = clampCapacity(payload.maxMembers || S.roomCapacity);

  show('view-prepare');
  $('prep-title').textContent = '正在通过公共中继找房主';
  $('prep-file').textContent = '';
  setSteps([
    { label: '解析房间链接', state: 'done' },
    { label: '等房主放行', state: 'active' },
    { label: '建立点对点连接', state: '' },
  ]);
  $('prep-bar').style.width = '35%';
  replace('prep-actions', cancelJoinButton());

  // 房主放行之后马上就要打洞：TURN 得先备好，「隐藏我的 IP」没有中继就不进
  if (turnFetchNeeded()) {
    await ensureTurnReady();
    if (!attemptLive(gen)) return;
  }
  const turnBlocked = relayOnlyBlocked();
  if (turnBlocked) return prepStop('还不能连接', turnBlocked);

  initSwarmAndSync();

  try {
    await connectSignaling(null, null, {
      secret: payload.key,
      hostKey: payload.hk,
      hostId: payload.from,
      relays: payload.relays,
    });
    if (!attemptLive(gen)) return;
    setSteps([
      { label: '解析房间链接', state: 'done' },
      { label: '等房主放行', state: 'done' },
      { label: '建立点对点连接', state: 'active' },
    ]);
    $('prep-bar').style.width = '70%';
    $('prep-note').textContent = '房主已放行，正在和房间里的人打洞…';
    // 观众也记下这条房间链接：开了 Discord 状态显示时，「加入放映」按钮用的就是它
    S.relayInvite = {
      k: 'relay',
      key: payload.key,
      hk: payload.hk,
      from: payload.from,
      maxMembers: payload.maxMembers,
      securityMode: payload.securityMode,
      relays: payload.relays,
    };
    await refreshRoomLink();
  } catch (e) {
    // 先失败的那次（等放行超时、被换代时关掉）不能把后来那次连上的信令关了
    if (!attemptLive(gen)) return;
    S.signaling?.close();
    S.signaling = null;
    return joinFail(relayJoinError(e));
  }
}

/** 观众手上的房间链接按最新的房间密钥重建（房主换过链接之后旧的就进不来了）。 */
async function refreshRoomLink() {
  if (!S.relayInvite) return;
  S.roomLink = shareLink(await encodeCode(S.relayInvite), 'join');
  updatePresence();
}

/**
 * 房间链接加入失败时，按原因说人话。
 * 被移出（REMOVED）分两种：进房前（打洞一直没成）和进房后（直连断开太久）。房主按 peerId 和公钥
 * 封禁本场，而 peerId 要到重新加载页面才换 —— 进房前被移出的，这次运行里再点链接一定还是被拒，
 * 配 TURN 也没用，所以不能叫他「配好再试」；进房后被移出的会退房重载、换了身份，重新点链接就能回来。
 */
function relayJoinError(e) {
  if (e?.code === 'HOST_OFFLINE') {
    return '找不到房主：他可能已经离开房间，或者换过房间链接。请让房主重新发一条。';
  }
  if (e?.code === 'RELAY_UNREACHABLE') {
    return '连不上公共中继（所在网络可能拦了它们）。请让房主改发「一对一邀请」，那个不经过任何第三方。';
  }
  if (e?.code === 'REMOVED') {
    if (e.entered) return '你和房主的直连断开太久，已被移出房间。重新点一次房间链接就能回来。';
    return '房主那边一直没能和你直连，你已被移出这一场。重启 NoxReel 后再点链接，或者请房主改发一对一邀请；双方配好 TURN 更容易连上。';
  }
  if (e?.code === 'BUSY') {
    return '房间里正有好几个人在连接，稍后再点一次链接试试。';
  }
  return e?.message || String(e);
}

/**
 * 房间链接的房主把我移出了房间（一直没和我直连上，或者连上后又断开太久，名额收回了）。
 * 还没进房（正在打洞）就停在准备页上把原因说清楚；已经在房间里的，干净地退回大厅 ——
 * 走 leaveRoom 收尾、刷新页面，原因先记下来，回到首页再说一遍。
 */
function removedFromRoom() {
  const text = relayJoinError({ code: 'REMOVED', entered: roomEntered });
  if (!roomEntered) {
    S.signaling?.close();
    S.signaling = null;
    joinFail(text);
    return;
  }
  if (S.leaving) return;
  log(text, 'bad');
  stashLobbyNotice(text);
  leaveRoom();
}

const LOBBY_NOTICE_KEY = 'sw.lobbyNotice';

function stashLobbyNotice(text) {
  try {
    sessionStorage.setItem(LOBBY_NOTICE_KEY, String(text));
  } catch {}
}

function takeLobbyNotice() {
  try {
    const text = sessionStorage.getItem(LOBBY_NOTICE_KEY);
    sessionStorage.removeItem(LOBBY_NOTICE_KEY);
    return text || '';
  } catch {
    return '';
  }
}

/** 诊断和日志里怎么称呼这一场的连接方式。 */
function connectionModeLabel() {
  if (S.mode === 'manual') return '极简（零服务器）';
  return S.signalTransport === 'relay' ? '房间链接（公共中继）' : '信令服务器';
}

/** 用户在设置里自己填的中继（每行一个 wss:// 地址）；没填返回 null。房主填了会写进房间链接。 */
function customRelays() {
  const list = String(S.settings.relays || '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => /^wss:\/\/[^\s/]+/i.test(s));
  return list.length ? [...new Set(list)].slice(0, 12) : null;
}

function relayList() {
  return customRelays() || DEFAULT_RELAYS;
}

/* ------------------------------ 信令连接 ------------------------------ */

// 信令这一侧最多同时挂多少条连接（含还在握手的）。房间最多 16 人，留出重连交替的余量；
// 再多只可能是信令服务器（或拿到房间号的人）在刷 peer-join / offer —— 每一条都是一个 RTCPeerConnection。
const MAX_LIVE_PEERS = 24;
// 同一个人的连接按令牌桶限速重建：攒满 REBUILD_BURST 次，之后每 REBUILD_REFILL_MS 回一次。
// 正常的断线重连走退避（最快 1.5 秒一次、三次就停），碰不到这个限。
const REBUILD_BURST = 4;
const REBUILD_REFILL_MS = 5000;
/** peerId -> {tokens, at} */
const rebuildBudget = new Map();
let peerCapWarned = false;

function allowRebuild(peerId) {
  const now = Date.now();
  const b = rebuildBudget.get(peerId) || { tokens: REBUILD_BURST, at: now };
  b.tokens = Math.min(REBUILD_BURST, b.tokens + (now - b.at) / REBUILD_REFILL_MS);
  b.at = now;
  rebuildBudget.delete(peerId);
  rebuildBudget.set(peerId, b);
  // 表本身也不能被刷大：只记最近的这些人
  while (rebuildBudget.size > MAX_LIVE_PEERS * 4) rebuildBudget.delete(rebuildBudget.keys().next().value);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/**
 * 信令要我为 peerId 新建（或重建）一条连接时先过这一关：同时挂着的连接有上限，
 * 同一个人的重建有速率上限。出了毛病或者恶意的信令服务器能每秒推上千条 peer-join / offer。
 */
function admitPeer(peerId, existing) {
  if (!existing && S.swarm.peers.size >= MAX_LIVE_PEERS) {
    if (!peerCapWarned) {
      peerCapWarned = true;
      log('同时连着的人太多了，多出来的连接请求已忽略', 'warn');
    }
    return false;
  }
  return allowRebuild(peerId);
}

/**
 * 本机和这个人的 P2P 直连是不是已经连上（数据通道能用）。中继信令的房主定时拿它问一遍，
 * 所以只查一下表：ICE 抖一下不算断，免得把正在自愈的人当成「一直没连上」收回名额。
 */
function peerLinked(peerId) {
  const peer = S.swarm?.peers.get(peerId);
  return !!peer && !peer.closed && peer.ctrl?.readyState === 'open';
}

/**
 * 和这个人的直连还通着：数据通道开着，ICE 也没掉线。对方网络整个断过一阵的话，
 * 信令回来时 ICE 多半已经是 disconnected，那种就该趁 peer-join 马上重建，不必等退避。
 */
function directLinkUp(peer) {
  if (!peer || peer.closed || peer.ctrl?.readyState !== 'open') return false;
  const ice = peer.pc?.iceConnectionState;
  return ice !== 'disconnected' && ice !== 'failed' && ice !== 'closed';
}

/**
 * 房间里不经这条信令进来的人（一对一邀请、先前的房间链接）。信令服务器只数经它进房的人，
 * 房主不报的话房间会超员 —— 房间链接那边用 occupied 把直连算进去了，这里是同一件事。
 * 握过手、还没关的都算：ICE 抖一下时名额照样占着，不然服务器会趁这几秒多放一个人进来。
 */
function outsideSeats(sig = S.signaling) {
  let n = 0;
  for (const p of S.swarm?.peers.values() || []) if (p.authenticated && !p.closed && p.via !== sig) n += 1;
  return n;
}

function syncOutsideSeats() {
  const sig = S.signaling;
  if (S.role !== 'host' || S.hostId !== S.peerId || S.signalTransport !== 'ws' || !sig?.setOutside) return;
  sig.setOutside(outsideSeats(sig));
}

// 信令那头推来的日志按种类限流：出了毛病的服务器能每秒推上万条，每一条都要让日志面板重排一次
const SIG_LOG_WINDOW_MS = 10_000;
const SIG_LOG_MAX = 20;
const sigLogBudget = new Map();

function sigLog(kind, text, tone = '') {
  const now = Date.now();
  let b = sigLogBudget.get(kind);
  if (!b || now - b.at >= SIG_LOG_WINDOW_MS) {
    b = { at: now, n: 0 };
    sigLogBudget.set(kind, b);
  }
  if (b.n >= SIG_LOG_MAX) return;
  b.n += 1;
  log(text, tone);
}

/**
 * 连信令。两种传输接口一样：WsSignaling（自建信令服务器）和 RelaySignaling（房间链接，
 * 经公共 Nostr 中继）。传了 relay 就走中继，下面的建连、重协商、房主离开判定全部共用。
 * S.mode 两种都是 'server'（好几处判断靠它区分「极简」和「有信令」），传输另记在 S.signalTransport。
 */
async function connectSignaling(url, roomId, relay = null) {
  const maxMembers = S.role === 'host' ? S.roomCapacity : 0;
  const sig = relay
    ? new RelaySignaling({
        ...relay,
        hostId: relay.hostId ?? S.hostId,
        peerId: S.peerId,
        name: S.name,
        maxMembers,
        relays: relay.relays || relayList(),
        protocolVersion: PROTOCOL_VERSION,
        // 满员判定把一对一邀请进来的人也算上（他们不经中继，中继那边看不到）
        occupied: () => connectedPeerCount() + 1,
        // 房主拿它收回一直没和我连上的名额：持链接的人光发 hello 不建连，就能把房间占满
        ...(relay.isHost ? { isLinked: peerLinked } : {}),
      })
    : // 成员也带上房间人数和房主：服务器重启过的话，重连时拿它们做建房提示（见 WsSignaling）
      new WsSignaling({ url, roomId, peerId: S.peerId, name: S.name, maxMembers: S.roomCapacity, hostId: S.hostId });
  S.signalTransport = relay ? 'relay' : 'ws';
  // 这里就赋值是为了让事件处理器能拿到它；但连接失败时必须置回 null，
  // 否则 inviteViaServer 的 if (!S.signaling) 守卫会短路跳过重连，
  // 而 S.roomId 只在连接成功后才写 —— 结果是拿一个 undefined 的房间号去编码，
  // 发出去一条根本没人能加入的坏邀请码。
  const previous = S.signaling;
  S.signaling = sig;
  // 手上还有一条就先关掉：它的处理器都还挂着，留着它就是第二套连接在往同一个 swarm 里塞人
  if (previous && previous !== sig) previous.close();
  // 被顶替（换了一次加入、换了传输）之后，这条连接上迟到的事件一律不认 ——
  // 关闭是异步的，关之前收到的 peer-join / offer 会把上一个房间的人塞进这一个房间
  const live = () => S.signaling === sig;

  // 规则：房间里的老成员向新来的发起 offer。这样不会两边同时发 offer 撞车。
  sig.on('peer-join', async ({ peerId, name }) => {
    if (!live() || !S.swarm) return;
    // 这次会话里因为版本不符断开过的人，不再和他建连
    if (S.swarm.versionRejected.has(peerId)) return;
    name = peerName(name, peerId);
    const existing = S.swarm.peers.get(peerId);
    // 对方的信令重连（服务器重启、网络抖一下）之后，服务器会把他当新人再广播一次 peer-join，
    // 可直连不经过信令，多半还好好的。这时拆掉重建，在途分片全部作废、传输白白中断，缓冲紧的人
    // 还可能把全房拖停 —— 和下面 peer-leave 那段要避免的是同一件事。直连还通着就留着它。
    if (directLinkUp(existing)) return;
    if (!admitPeer(peerId, existing)) return;
    sigLog('join', `${name} 加入了房间`, 'good');
    // 「隐藏我的 IP」开着却没有可用中继：不和他建连接（日志里说一声）
    const ice = signalPeerIce();
    if (!ice) return;
    // 中继信令不 trickle（候选打包进 SDP）；信令服务器照旧边收集边发
    const peer = new Peer({ peerId, name, initiator: true, ...ice, trickle: sig.trickle !== false });
    // offerTag：这份 offer 的应答要原样带回这个标记（老版本的 offer 不带，应答也就不带）。
    // 两轮重建交叉时（我按超时重发了 offer，对面同时发来 renegotiate 又逼我建了一轮），
    // 上一轮的 answer 可能比这一轮的先到 —— 套到新连接上 ICE 凭据对不上，这条连接就废了，
    // 真正对应的 answer 后到时又因为已经 stable 被丢掉。建好就记上：收集候选的那几秒里旧 answer 也可能到
    peer.offerTag = crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
    wirePeer(peer, sig);
    S.swarm.addPeer(peer);
    const offer = await peer.createOffer();
    sig.signal(peerId, { kind: 'offer', sdp: offer, tag: peer.offerTag });
  });

  sig.on('signal', async ({ from, name, payload }) => {
    if (!live() || !S.swarm || !payload || typeof payload !== 'object') return;
    let peer = S.swarm.peers.get(from);

    if (S.swarm.versionRejected.has(from)) return;

    if (payload.kind === 'offer') {
      // 收到 offer 就等于对方那边已经另起了一条连接 —— 本产品没有重协商场景，老成员只在
      // 新人进房时发一次 offer。此时手上那个同 id 的 Peer 必然是上一轮的残骸：它的
      // 数据通道可能刚被对端 abort，close 事件还堵在事件队列里没轮到。拿它去
      // setRemoteDescription，ICE 会在一条已经废掉的 pc 上重来一遍，双方都以为在协商，
      // 实际再也连不上 —— 表现就是信令一抖，传输永久停在原地。
      if (!admitPeer(from, peer)) return;
      const ice = signalPeerIce();
      if (!ice) return;
      if (peer) S.swarm.removePeer(from);
      // 对面已经在重建：撤掉我排着的 renegotiate（次数不退，见 cancelRecovery）
      cancelRecovery(from, { keepCount: true });
      peer = new Peer({ peerId: from, name: peerName(name, from), initiator: false, ...ice, trickle: sig.trickle !== false });
      wirePeer(peer, sig);
      S.swarm.addPeer(peer);
      const answer = await peer.acceptOffer(payload.sdp);
      const tag = typeof payload.tag === 'string' ? { tag: payload.tag.slice(0, 16) } : {};
      sig.signal(from, { kind: 'answer', sdp: answer, ...tag });
      return;
    }

    if (payload.kind === 'renegotiate') {
      // 对面的直连断了，而按「老成员向新来的发起 offer」的约定该由我发 offer。
      // 两边同时发会撞车，所以断线的一方只发这条请求过来。
      //
      // 先撤掉自己这边排着的退避定时器：对面已经明确要求重协商了，
      // 我这边再自发一次就是两份 offer。reconnectPeer 里的 RENEGOTIATING 是
      // 第二道保险，这里是第一道 —— 少一次没必要的连接重建。
      cancelRecovery(from);
      // 重协商同样是新建一条连接：陌生 id 发来的、刷屏发来的都得过同一关
      if (!admitPeer(from, peer)) return;
      await reconnectPeer(from, peerName(name, from), sig).catch((e) =>
        log(`重连 ${name || from} 失败：${e.message}`, 'bad')
      );
      return;
    }

    if (!peer || peer.closed) return;
    if (payload.kind === 'answer') {
      // 标记对不上的是上一轮 offer 的应答（见 peer-join 里 offerTag 的说明），老版本不带标记照旧收
      if (peer.offerTag && typeof payload.tag === 'string' && payload.tag !== peer.offerTag) return;
      // 重协商期间可能收到上一轮的 answer。此时 pc 已经是 stable，
      // setRemoteDescription 会抛 InvalidStateError —— 不接住就是一个
      // 未处理的 Promise 拒绝，而这条 answer 本来就该丢掉。
      await peer.acceptAnswer(payload.sdp).catch((e) => {
        console.warn('[app] 丢弃对不上的应答：', e.message);
      });
    } else if (payload.kind === 'ice') await peer.addIceCandidate(payload.candidate);
  });

  // 信令断了不等于人走了 —— 直连不经过服务器。服务重启或网络抖一下，服务器就会
  // 广播 peer-leave；这时候把健康的 P2P 拆掉，传输会白白中断到对方重连为止
  // （重连退避最长 30 秒），而界面上还写着「已建立的直连不受影响」。
  // 真正离开的人，数据通道自己会关，ICE 也会走到 failed，那两条路都会摘掉他。
  sig.on('peer-leave', ({ peerId }) => {
    if (!live() || !S.swarm) return;
    cancelRecovery(peerId); // 人是真走了，不是链路断了，别再去重连
    const peer = S.swarm.peers.get(peerId);
    if (peer?.ctrl?.readyState === 'open') {
      sigLog('leave', `${peer.name} 的信令连接断了，但直连还在，传输继续`, 'warn');
      return;
    }
    if (peerId === S.hostId) hostReallyGone('left', peer);
    S.swarm.removePeer(peerId);
  });
  let joinedBefore = false;
  sig.on('joined', ({ hostId, maxMembers } = {}) => {
    if (!live()) return;
    const again = joinedBefore;
    joinedBefore = true;
    // 服务器认的房主和本机认的对不上：旧版信令服务器重启后，房间由先重连上的人重建，他成了服务器眼里的房主。
    // 首次加入对不上的由 connect() 之后的检查拒掉；重连时说清楚后果，人数也别跟着这个房间改
    if (hostId && S.hostId && hostId !== S.hostId) {
      if (again) {
        sigLog(
          'host-mismatch',
          S.hostId === S.peerId
            ? '信令服务器重启后没认出你是房主（它可能还是旧版本）：新人拿邀请码进不来，你也改不了人数；已经在房里的人不受影响。升级信令服务器后重新开房即可恢复'
            : '信令服务器重启后认错了房主（它可能还是旧版本）：新人暂时进不来；已经在房里的人不受影响',
          'bad'
        );
      }
      return;
    }
    if (again && S.role === 'host' && S.hostId === S.peerId && maxMembers !== S.roomCapacity) {
      // 房主重新进房：断着的时候改过人数（或者房间被重建过），以本机的设置为准推回去
      sig.setMaxMembers(S.roomCapacity);
    } else if (maxMembers) {
      S.roomCapacity = clampCapacity(maxMembers);
    }
    renderCapacityStatus();
  });
  sig.on('room-config', ({ maxMembers }) => {
    if (!live()) return;
    const before = S.roomCapacity;
    S.roomCapacity = clampCapacity(maxMembers);
    renderCapacityStatus();
    // 房主只是报了一下不经服务器进来的人数时，旧版服务器也会把没变的上限广播一遍：没变就不刷日志
    if (S.roomCapacity !== before) sigLog('config', `房间人数上限已设为 ${S.roomCapacity}`, 'good');
  });
  // 房主换了房间链接：观众手上那条（Discord 状态里的「加入放映」）跟着换
  sig.on('rekey', ({ secret }) => {
    if (!live() || S.role === 'host' || !S.relayInvite) return;
    S.relayInvite = { ...S.relayInvite, key: secret };
    refreshRoomLink().catch(() => {});
  });
  sig.on('reconnecting', ({ in: ms }) => {
    if (live()) sigLog('reconnecting', `信令断开，${Math.round(ms / 1000)} 秒后重连（已建立的直连不受影响）`, 'warn');
  });
  // 中继信令从全断里恢复（房间链接）。中继上都是临时事件：断着的这段时间里双方发的 offer /
  // renegotiate 都丢了，服务器也不会像信令服务器那样替谁重发 peer-join —— 信令给出它知道的
  // 每个人和该由谁发起，直连不通的重新排上
  sig.on('reconnected', ({ peers } = {}) => {
    if (!live() || !S.swarm) return;
    sigLog('reconnected', '信令已恢复', 'good');
    for (const p of Array.isArray(peers) ? peers.slice(0, MAX_LIVE_PEERS) : []) resumeRecovery(sig, p);
  });
  sig.on('error', (e) => {
    if (!live()) return;
    if (e?.code === 'REMOVED') return removedFromRoom();
    sigLog('error', `信令错误：${e?.message}`, 'bad');
  });
  // 中继信令也可能单独报一声「被移出」，和上面带 REMOVED 的 error 走同一条路
  sig.on('removed', () => {
    if (live()) removedFromRoom();
  });

  const joined = await sig.connect();
  if (!relay && S.hostId && S.hostId !== S.peerId && joined?.hostId === S.peerId) {
    // 服务器上已经没有这个房间了（人走光被删，或者服务器重启过），它按「第一个进来的人」把我记成了
    // 新房间的房主。不是冒名，是房间关了：照样不进，但把原因说对
    sig.close();
    const err = new Error('这个房间已经关闭（房主可能已离开），请让房主重新发邀请');
    err.code = 'ROOM_CLOSED';
    throw err;
  }
  if (!joined?.hostId || (S.hostId && joined.hostId !== S.hostId)) {
    sig.close();
    throw new Error('房主身份与邀请码不一致，已拒绝加入');
  }
  return joined;
}

/* ---------------------------- 直连断线恢复 ---------------------------- */

// 退避节奏。三次都失败就不再自动重试了 —— 再试下去只是把「连不上」这件事
// 拖得更久，不如把诊断结论摆出来让人去配 TURN。
const RECONNECT_BACKOFF_MS = [1500, 4000, 10000];
// disconnected 不等于完了：ICE 自己有可能几秒内恢复。这段时间内先不动。
const DISCONNECT_GRACE_MS = 6000;
// 一轮握手（offer → answer → 数据通道打开）最多等这么久。中继上的 offer / answer / renegotiate
// 都是临时事件，丢了就丢了：新建的连接会一直停在半路，既不 connected 也不 failed，
// 没有这道兜底就再也不会有下一次重连。不 trickle 时两边各要收集几秒候选，留足余量
const HANDSHAKE_TIMEOUT_MS = 30_000;
/** peerId -> {attempts, timer, watch} */
const RECOVERY = new Map();
/** peerId -> 正在跑的重协商 Promise。同一个人同时只允许一次。 */
const RENEGOTIATING = new Map();

/**
 * 撤掉排着的重连。keepCount：只撤定时器、次数留着 —— 对面发来 offer（他已经在重建）时用：
 * 两边要是互相把对方的次数清零，一对根本连不通的人会没完没了地重试下去。
 */
function cancelRecovery(peerId, { keepCount = false } = {}) {
  const st = RECOVERY.get(peerId);
  if (st?.timer) clearTimeout(st.timer);
  if (st?.watch) clearTimeout(st.watch);
  if (keepCount && st) st.timer = st.watch = null;
  else RECOVERY.delete(peerId);
}

/**
 * 直连断了之后自动重来。
 *
 * 跨境链路上这不是锦上添花：NAT 映射老化、Wi-Fi 漫游、运营商重新拨号，都会让
 * 一条已经建好的连接走到 failed。以前走到这一步就彻底完了 —— 界面只留一句
 * 「直连失败了」，两个人得退房重走一遍邀请流程，片子也白下了一半。
 *
 * 恢复手段是重新协商一条新连接，而不是 restartIce()：收到 offer 的一方本来
 * 就会把同 id 的旧 Peer 整个换掉（见 sig.on('signal') 里那段注释），沿用这条
 * 路径等于复用一条已经验证过的重建流程，不用再为重协商单开一套状态机。
 *
 * 只有 initiator 一侧主动重发 offer；另一侧发一条 renegotiate 请求过去，
 * 免得两边同时发 offer 撞车。极简模式没有信令通道，重连无从谈起，原样保持
 * 「重新生成一条应答链接」的手工路径。
 */
/**
 * 确认房主真的走了：信令说他离开了（why = 'left'），或者重连退避已经用尽（'unreachable'）。
 * 还没进房（信令加入正在打洞）时没有横幅可改：交给准备页上等着的那次加入给结论（见 watchServerJoin）。
 */
function hostReallyGone(why = 'unreachable', peer = null) {
  if (isRoomHost()) return;
  if (!roomEntered) {
    joinAttempt.busy?.onHostGone?.(why, peer);
    return;
  }
  if (S.hostGone) return;
  S.hostGone = true;
  S.hostLink = null;
  settlePendingOpsHostLost();
  log('房主已离开，列表暂停更新；已经连上的成员之间照常传输', 'warn');
  renderPlaylistSoon();
}

/**
 * retry：上一轮发出去的请求没有下文（renegotiate 丢了），或者信令刚恢复要补一轮 ——
 * 这时 peer 可能是已经摘掉的旧连接、甚至只是 { peerId, name, initiator }，照样排。
 */
function scheduleReconnect(peer, sig, { retry = false } = {}) {
  if (!sig || !S.swarm || (peer.closed && !retry)) return;
  const peerId = peer.peerId;
  // 信令服务器早先宣布过他离开（那时直连还开着，没摘），现在直连也断了：他不在信令里，
  // 重协商的消息投不到，退避多少次都是空等 —— 直接按离开处理。他回来的话服务器会重新广播 peer-join。
  // 房主强退、崩溃、正常退出都是这个顺序：先断信令，数据通道后关
  if (sig.hasLeft?.(peerId)) {
    cancelRecovery(peerId);
    if (peerId === S.hostId) hostReallyGone('left', peer);
    return;
  }
  const st = RECOVERY.get(peerId) || { attempts: 0, timer: null, watch: null };
  if (st.timer) return; // 已经排上了
  clearTimeout(st.watch);
  st.watch = null;

  if (st.attempts >= RECONNECT_BACKOFF_MS.length) {
    const advice = connectionAdvice(peer);
    log(`和 ${peer.name} 的直连试了 ${st.attempts} 次都没恢复。${advice.text}`, 'bad');
    // 退避用尽才承认失联：在这之前列表横幅只说「正在重连」，别把 ICE 抖一下说成房主走了
    if (peerId === S.hostId) hostReallyGone('unreachable', peer);
    // 最后一轮新建的连接还停在半路（对面一直没应答）：摘掉，别让它一直占着名额和一条 RTCPeerConnection
    const stuck = S.swarm.peers.get(peerId);
    if (stuck && stuck.ctrl?.readyState !== 'open') S.swarm.removePeer(peerId);
    return;
  }

  const wait = RECONNECT_BACKOFF_MS[st.attempts];
  st.attempts += 1;
  const name = peer.name;
  const initiator = peer.initiator;
  log(`和 ${name} 的直连断了，${Math.round(wait / 1000)} 秒后自动重连（第 ${st.attempts} 次）`, 'warn');

  st.timer = setTimeout(() => {
    st.timer = null;
    if (!sig.connected) {
      // 信令也断着，重连的消息发不出去：这一次不算数，次数退回去。信令自己会退避重连，
      // 回来之后由 reconnected（房间链接）或服务器重发的 peer-join（信令服务器）把这条重新拉起来
      st.attempts = Math.max(0, st.attempts - 1);
      log(`信令还没恢复，暂时没法重连 ${name}`, 'warn');
      return;
    }
    if (initiator) {
      reconnectPeer(peerId, name, sig).catch((e) => log(`重连 ${name} 失败：${e.message}`, 'bad'));
    } else {
      sig.signal(peerId, { kind: 'renegotiate' });
      // 这条请求也可能丢：过一阵还没连上、对面也没发 offer 过来（发来了会撤掉这个定时器），
      // 就当这一轮失败，接着退避
      st.watch = setTimeout(() => {
        st.watch = null;
        if (RECOVERY.get(peerId) !== st || peerLinked(peerId)) return;
        scheduleReconnect(peer, sig, { retry: true });
      }, HANDSHAKE_TIMEOUT_MS);
    }
  }, wait);

  RECOVERY.set(peerId, st);
}

/**
 * 信令从全断里恢复（中继信令的 reconnected）：断着的这段时间里双方的重连请求都丢了，
 * 没有别的东西会再把直连拉起来。直连不通的人重新排上，次数从头算 —— 信令断着时的那几次不算数。
 */
function resumeRecovery(sig, { peerId, name, initiator } = {}) {
  if (!S.swarm || typeof peerId !== 'string' || !peerId || peerId === S.peerId) return false;
  if (S.swarm.versionRejected?.has(peerId)) return false;
  const peer = S.swarm.peers.get(peerId);
  if (directLinkUp(peer)) return false;
  cancelRecovery(peerId);
  // 手上还有这个人的连接就按它原来的角色来（两边对「谁发 offer」的认识一致）；没有了才用信令给的
  scheduleReconnect(peer || { peerId, name: peerName(name, peerId), initiator: initiator === true }, sig, { retry: true });
  return true;
}

/** 以 initiator 身份重建一条到 peerId 的连接，并把新的 offer 发过去。 */
async function reconnectPeer(peerId, name, sig) {
  if (!S.swarm || !sig?.connected) return;

  // 同一个 peerId 同时只能有一次重协商在跑。
  //
  // 断链是对称的：initiator 侧自己的退避定时器会发 offer，而非 initiator 侧
  // 会发一条 renegotiate 请求过来 —— 两者几乎同时到达，于是 initiator 连发两份
  // offer，各自建了一个 RTCPeerConnection。对面按第一份回的 answer 会被套到
  // 第二个 pc 上（ufrag 对不上，STUN 绑定请求全被丢弃，这条连接必死），
  // 第二份 answer 又撞上 InvalidStateError 变成未处理的 Promise 拒绝。
  // 原来的注释只防住了「两边同时发 offer」，没防住「同一侧发两次」。
  if (RENEGOTIATING.has(peerId)) return RENEGOTIATING.get(peerId);

  const run = (async () => {
    // 先拿 ICE 参数：「隐藏我的 IP」没有可用中继时在这里就抛出去（调用方记日志），旧连接也不拆
    const ice = peerIce();
    if (S.swarm.peers.has(peerId)) S.swarm.removePeer(peerId);
    const peer = new Peer({
      peerId,
      name: name || peerId,
      initiator: true,
      ...ice,
      trickle: sig.trickle !== false,
    });
    // 应答要带回的标记，见 connectSignaling 的 peer-join 里 offerTag 的说明
    peer.offerTag = crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
    wirePeer(peer, sig);
    S.swarm.addPeer(peer);
    const offer = await peer.createOffer();
    // 走到这里可能已经过了几秒（要等 ICE 收集）。期间这条 peer 可能被顶替或摘掉，
    // 那就别再把这份过期的 offer 发出去。
    if (S.swarm.peers.get(peerId) !== peer) return;
    sig.signal(peerId, { kind: 'offer', sdp: offer, tag: peer.offerTag });
  })();

  RENEGOTIATING.set(peerId, run);
  try {
    await run;
  } finally {
    RENEGOTIATING.delete(peerId);
  }
}

/* ------------------------------ peer 接线 ------------------------------ */

function wirePeer(peer, sig) {
  // 经哪条信令建的连接（一对一邀请的没有）：信令服务器判满时只数经它进房的人，见 outsideSeats
  peer.via = sig || null;
  if (sig) peer.on('icecandidate', (c) => sig.signal(peer.peerId, { kind: 'ice', candidate: c }));

  let graceTimer = null;
  const clearGrace = () => {
    clearTimeout(graceTimer);
    graceTimer = null;
  };

  // 握手兜底：offer 或 answer 在中继上丢了，这条连接就停在半路（没有远端描述，ICE 永远是 new），
  // 既不会 connected 也不会 failed。到时还没打开数据通道就按失败处理，接着退避重连。
  // 应答的一方多等一会儿：发起方的先到、由它重发 offer，两边不必同时重来
  const handshakeTimer = sig
    ? setTimeout(
        () => {
          if (peer.closed || S.swarm?.peers.get(peer.peerId) !== peer || peer.ctrl?.readyState === 'open') return;
          log(`和 ${peer.name} 的连接迟迟没建起来，重新协商`, 'warn');
          scheduleReconnect(peer, sig);
        },
        peer.initiator ? HANDSHAKE_TIMEOUT_MS : HANDSHAKE_TIMEOUT_MS * 1.5
      )
    : null;

  peer.on('open', () => {
    clearTimeout(handshakeTimer);
    clearGrace();
    cancelRecovery(peer.peerId); // 连上了，退避计数归零
    log(`已和 ${peer.name} 建立数据通道，正在校验房间模式…`);
  });
  peer.on('statechange', (s) => {
    if (s === 'connected' || s === 'completed') {
      clearGrace();
      // ICE 自己缓过来了，把已经排上的重连撤掉。
      // cancelRecovery 原来只在 'open'（数据通道首次打开）和 peer-leave 时调，
      // 而 ICE 自愈不会再触发 open —— 于是 grace 到期排上的定时器照常执行，
      // 把一条刚刚恢复好的连接又拆掉重建一遍。
      cancelRecovery(peer.peerId);
      return;
    }
    if (s === 'disconnected' && sig && !graceTimer) {
      // 先给 ICE 一点时间自己缓过来。网络抖一下就重建连接反而更慢。
      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (peer.pc.iceConnectionState === 'disconnected') scheduleReconnect(peer, sig);
      }, DISCONNECT_GRACE_MS);
      return;
    }
    if (s === 'failed') {
      clearGrace();
      const advice = connectionAdvice(peer);
      log(`和 ${peer.name} 的直连失败了。${advice.text}`, advice.level === 'ok' ? 'warn' : 'bad');
      if (sig) scheduleReconnect(peer, sig);
    }
  });
  peer.on('close', () => {
    clearTimeout(handshakeTimer);
    log(`${peer.name} 断开了`, 'warn');
    S.sync?.peerGone(peer.peerId);
  });
  // 控制消息统一由 swarm 转交（它负责认证、拼装分段），见 onRoomCtrl
}

function siteOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function siteHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * 这个链接能不能直接打开：本机自己提交过的不用问；其他的，这个房间里允许过这个网站才行。
 * 「是不是自己加的」只看本机记下的 S.myLinks —— 快照里的 addedBy 由房主填写，房主改个字段就能冒充。
 */
function siteApproved(item) {
  return S.myLinks.has(linkKey(item.url)) || S.approvedSites.has(siteOf(item.url));
}

// 解析出来的播放地址有时效，放久了的不再拿来用
const LINK_INFO_TTL_MS = 15 * 60 * 1000;
// 对房主临时播放地址的询问刚出现或刚换了网站时，这么久之内点的「允许」不算数（人得先看清是哪个网站）
const FALLBACK_CONFIRM_MS = 1000;

function cachedLinkInfo(url) {
  const key = linkKey(url);
  const info = S.links.get(key);
  if (!info) return null;
  if (Date.now() - (info.resolvedAt || 0) > LINK_INFO_TTL_MS) {
    S.links.delete(key);
    return null;
  }
  return info;
}

/**
 * 允许打开某个网站（同一个房间里每个网站只问一次）。
 *
 * 不弹窗打断：收到列表时，别人加的链接在行内标「需要允许」，当前项正卡在这一步时状态栏也给按钮。
 * 点了允许，卡着的当前项接着往下走；之前跳过的这一项也恢复。
 * 当前项正等着允许房主给的临时播放地址时，行内和状态栏显示的是那个地址的网站，这次允许的也是它。
 * 这个询问刚出现或刚换了网站时点的不算：这一下多半是冲着之前的按钮点的（连点，或房主掐着点换地址），
 * 批准的会是本人没看清的网站。
 */
function approveLinkSite(item) {
  const cur = S.current;
  const ask = cur?.kind === 'link' && cur.id === item.id && fallbackAsking() ? S.fallbackConsent : null;
  if (ask && !(Date.now() - ask.at >= FALLBACK_CONFIRM_MS)) {
    log(`房主给的播放地址刚更新，现在来自 ${ask.host}，看清楚再点「允许」`, 'warn');
    return;
  }
  // 当前项自己的网址这一路同样按「问过的那个网站」批准：房主不换 seq、只把同一 id 的网址换掉时，
  // 对不上就作废这次询问、按新网址重新问，这一下不算数。
  const pinned = !ask && cur?.kind === 'link' && linkAsking() && S.linkConsent.id === item.id ? S.linkConsent : null;
  if (pinned) {
    if (pinned.origin !== siteOf(cur.url)) {
      askLinkConsent(cur, S.currentSeq);
      log(`这一部的网址刚换成 ${siteHost(cur.url)}，看清楚再点「允许」`, 'warn');
      renderStatus();
      renderPlaylist();
      return;
    }
    if (!(Date.now() - pinned.at >= FALLBACK_CONFIRM_MS)) {
      log(`这个询问刚出现，要打开的是 ${pinned.host}，看清楚再点「允许」`, 'warn');
      return;
    }
  }
  const origin = ask ? ask.origin : pinned ? pinned.origin : siteOf(item.url);
  if (!origin) return;
  // 边下边播：当前这一部原先是因为没点头才没另存的，点头之后补一次（原本就能存的不重复要）
  const couldSave = linkDownloadConsented(cur);
  S.approvedSites.add(origin);
  S.skippedLinks.delete(item.id);
  if (!couldSave && linkDownloadConsented(cur)) wantDownload(cur);
  if (ask) {
    S.fallbackConsent = null;
    if (!S.linkInfo) tryLinkFallback(cur, S.currentSeq).catch((error) => log(error.message || String(error), 'bad'));
  } else if (cur?.kind === 'link' && siteOf(cur.url) === origin && !S.linkInfo && !S.skippedLinks.has(cur.id)) {
    S.linkConsent = null;
    activateLinkItem(cur, S.currentSeq).catch((error) => log(error.message || String(error), 'bad'));
  }
  preResolveNextLink();
  renderPlaylist();
  renderStatus();
  updateLocalReady();
}

/** 这一部我先不看：播放器保持空闲，也算准备好了，不挡别人。 */
function skipLinkItem(item) {
  S.skippedLinks.add(item.id);
  // 跳过的不算「你放到的」：边下边播已经在下的这一部也停掉（轮到它时就已经发出去了）
  cancelLinkDownload(item);
  if (S.current?.id === item.id) {
    S.linkConsent = null;
    // 改为允许时从头再走一遍，到时候再问房主地址的网站
    S.fallbackConsent = null;
    log('这一部你先跳过了，播放器保持空闲，不影响其他人', 'warn');
  }
  renderPlaylist();
  renderStatus();
  updateLocalReady();
}

/**
 * 房主：兜底地址放久了就重新解析一份发出去。晚到的成员拿到的是一小时前的签名地址，
 * 自己又解析不了（Android 根本不解析）时就没得放了。同一条链接同时只跑一次。
 */
function refreshNowLink() {
  if (!isRoomHost() || !S.nowLink || S.nowLink.seq !== S.playlist.seq) return;
  if (Date.now() - (S.nowLink.resolvedAt || 0) <= LINK_INFO_TTL_MS) return;
  const item = currentItem(S.playlist);
  if (item?.kind !== 'link') return;
  const seq = S.playlist.seq;
  const key = linkKey(item.url);
  if (S.resolvingLinks.has(key)) return;
  S.resolvingLinks.add(key);
  window.sw.media
    .inspectLink(item.url)
    .then((info) => {
      const resolvedAt = info.resolvedAt || Date.now();
      S.links.set(key, { ...info, resolvedAt });
      if (!isRoomHost() || S.playlist.seq !== seq) return;
      S.nowLink = { seq, playback: info.playback || null, resolvedAt };
      for (const p of S.swarm.peers.values()) {
        if (p.authenticated) p.send({ t: MSG.NOW_LINK, ...S.nowLink });
      }
    })
    .catch(() => {})
    .finally(() => S.resolvingLinks.delete(key));
}

/** 下一部是链接的话提前解析好，轮到它时不用再等。只解析已经允许过的网站。 */
function preResolveNextLink() {
  const next = S.playlist.queue[1];
  if (next?.kind !== 'link' || !siteApproved(next) || S.skippedLinks.has(next.id)) return;
  const key = linkKey(next.url);
  if (cachedLinkInfo(next.url) || S.resolvingLinks.has(key)) return;
  S.resolvingLinks.add(key);
  window.sw.media
    .inspectLink(next.url)
    .then((info) => S.links.set(key, { ...info, resolvedAt: info.resolvedAt || Date.now() }))
    .catch(() => {})
    .finally(() => S.resolvingLinks.delete(key));
}

/**
 * 页面解析会受地区、站点限流和 yt-dlp 版本影响。房主可以附带一条短时效、
 * 已去除 Cookie/Authorization 的播放地址作为兼容兜底，尤其供 Android 使用。
 */
function linkFallback(item, seq) {
  const now = S.nowLink?.seq === seq ? S.nowLink : null;
  const playback = now?.playback || null;
  const playbackUrl = typeof playback?.url === 'string' ? playback.url : '';
  if (!/^https?:\/\//i.test(playbackUrl)) return null;
  // 签名地址有时效。房主 greet 时会把一小时前那条原样补发给晚到的成员，拿去播只会失败 ——
  // 当作没有更好：本人看到的是「解析不了，可以先跳过」，房主那边也会重新解析一份发过来。
  if (Number.isFinite(now.resolvedAt) && Date.now() - now.resolvedAt > LINK_INFO_TTL_MS) return null;
  return {
    url: playbackUrl,
    title: item.title || '在线视频',
    duration: item.durationSec || 0,
    extractor: 'host-resolved',
    direct: true,
    playback,
    // 记房主解析出它的时间，不是本机拿到它的时间：重开播放器时据此判断这条签名地址是不是放久了
    resolvedAt: Number.isFinite(now.resolvedAt) ? now.resolvedAt : Date.now(),
  };
}

/** 当前项是链接：每个人在自己的电脑上解析，房主把自己解析到的地址也发一份做兜底。 */
async function activateLinkItem(item, seq) {
  const cache = linkCacheOf(item);
  if (!S.skippedLinks.has(item.id) && cache?.state === 'done') {
    // 手动缓存好了：直接从本地播
    const local = await window.sw.linkCache.localPath(item.url).catch(() => null);
    if (S.currentSeq !== seq) return;
    if (local) {
      await useCachedLink(item, local, seq);
      return;
    }
    // 文件没了（手动删了、被挪走了）：登记已经摘掉，退回在线看
    S.linkCaches.delete(linkKey(item.url));
    renderPlaylistSoon();
  }
  // 跳过了的就让播放器闲着；别人加的、没允许过的网站，等本人点头（不弹窗，见 approveLinkSite）
  if (S.skippedLinks.has(item.id) || !siteApproved(item)) {
    if (S.currentSeq !== seq) return;
    if (!S.skippedLinks.has(item.id)) {
      askLinkConsent(item, seq);
      log(`这一部来自 ${siteOf(item.url)}，在列表或上方点「允许打开」后才会播放`, 'warn');
    }
    renderStatus();
    updateLocalReady();
    return;
  }
  let info = cachedLinkInfo(item.url);
  if (!info) {
    try {
      info = await window.sw.media.inspectLink(item.url);
      S.links.set(linkKey(item.url), { ...info, resolvedAt: info.resolvedAt || Date.now() });
    } catch (error) {
      if (S.currentSeq !== seq) return;
      // 房主的兜底地址可能还在路上，到了会再试一次（见 onNowLink）
      S.linkFailedSeq = seq;
      const detail = error.message || error;
      if (!linkFallback(item, seq)) {
        log(`这个视频链接在你的电脑上无法解析：${detail}`, 'bad');
        // 不能停在「正在解析」：本人看不出出了什么事，也没法跳过，房主的等待名单会一直挂着他
        renderStatus();
        renderPlaylist();
        updateLocalReady();
        return;
      }
      await tryLinkFallback(item, seq, detail);
      return;
    }
  }
  if (S.currentSeq !== seq) return;
  await useLinkInfo(item, info, seq);
}

/** 当前这一部正等着本人允许房主给的临时播放地址。 */
function fallbackAsking() {
  return !!S.fallbackConsent && S.fallbackConsent.seq === S.currentSeq;
}

/** 当前这一部正等着本人允许打开它自己的网址（不是房主给的兜底地址）。 */
function linkAsking() {
  return !!S.linkConsent && S.linkConsent.seq === S.currentSeq;
}

/**
 * 记下这次问的是哪一部的哪个网站。换了片、换了条目或换了网址都算一次新的询问，重新计时
 * （和 tryLinkFallback 对兜底地址的做法一致）：点「允许」时批准的必须是行里、横幅上写着的那个。
 */
function askLinkConsent(item, seq) {
  const origin = siteOf(item.url);
  const asked = S.linkConsent;
  if (asked?.seq === seq && asked.id === item.id && asked.origin === origin) return;
  S.linkConsent = { seq, id: item.id, origin, host: siteHost(item.url), at: Date.now() };
}

/**
 * 当前这部链接在本机解析失败，房主也没有能用的兜底地址：网站本来就允许过，
 * 再问「允许」没有意义，但本人得有个「先跳过」的出口，否则自动连播一直等他。
 */
function linkResolveFailed() {
  const item = S.current;
  return (
    item?.kind === 'link' &&
    !S.linkInfo &&
    S.linkFailedSeq === S.currentSeq &&
    !S.skippedLinks.has(item.id) &&
    !fallbackAsking() &&
    !linkAsking()
  );
}

/** 当前这部链接解析成功了、本机播放器却放不了（打不开，或者半路断了）。跳过了的不算。 */
function linkPlayFailed() {
  const f = S.linkPlayFailed;
  const item = S.current;
  return !!f && f.seq === S.currentSeq && item?.kind === 'link' && !S.skippedLinks.has(item.id);
}

/** 播放器打不开在线视频的原因。主进程只给代号和 HTTP 状态码（日志原文来自网站），文字在这边生成、翻译。 */
function linkLoadErrorText(error) {
  const status = Number.isInteger(error?.status) ? error.status : 0;
  switch (error?.reason) {
    case 'http':
      if (status === 401 || status === 403) return `网站拒绝了播放请求（HTTP ${status}），播放地址可能已经过期`;
      return status ? `网站返回了错误（HTTP ${status}）` : '网站返回了错误';
    case 'resolve':
      return 'yt-dlp 没能从网页里解析出视频';
    case 'network':
      return '连不上视频网站（超时或网络中断）';
    case 'format':
      return '播放器认不出这个视频的格式';
    default:
      return '原因不明';
  }
}

/**
 * 在线链接的每条 tick：播放器打不开（loadFailed）就记下来、说明原因。同步引擎那边已经不再把它算作
 * 「在等数据」，本机不会再挡着全房；这里负责让本人知道出了什么事，并给「重试」。
 * 又放起来了（在播放器里往回拖、重新载入）就把之前的提示收掉。
 */
function noteLinkPlayback(snap) {
  const failed = linkPlayFailed() ? S.linkPlayFailed : null;
  if (snap.loadFailed) {
    if (failed?.kind === 'load') return;
    S.linkPlayFailed = { seq: S.currentSeq, kind: 'load', error: snap.loadError || null };
    log(`播放器打不开这个在线视频：${linkLoadErrorText(snap.loadError)}`, 'bad');
    renderPlaylistSoon();
    return;
  }
  if (failed && !snap.eof) {
    S.linkPlayFailed = null;
    renderPlaylistSoon();
  }
}

/**
 * 同步引擎认定在线视频是半路断了、不是放完了（见 syncEngine 的 stream-cut）：不推进列表，
 * 提示本人重新连接。片长未知时分不清是断了还是真放完了，两种都说。
 */
function onLinkStreamCut({ position = 0, duration = 0 } = {}) {
  if (S.sourceType !== 'link' || !S.current || S.switchingMedia) return;
  S.linkPlayFailed = { seq: S.currentSeq, kind: 'cut', position, duration };
  log(
    duration > 0
      ? `在线视频在 ${fmtTime(position)} 断了（全片 ${fmtTime(duration)}），不是放完了：点「重试」重新连接`
      : '在线视频停住了，但片长未知，分不清是放完了还是断流了：没放完就点「重试」重新连接',
    'warn'
  );
  renderPlaylistSoon();
  renderStatus();
}

/**
 * 当前这部链接重新来一遍：本机解析失败（可能只是超时、限流）、播放器打不开、半路断了，
 * 或者重开播放器时签名地址已经过期。旧播放器先退，解析结果不再沿用（签名地址可能正是出问题的那个），
 * 重新走 activateLinkItem —— 从房间当前的位置起播。
 * 本机早就解析失败、用的是房主给的地址时，房主手里有新鲜的就直接换上，不再先把本机解析重跑一遍。
 */
async function retryCurrentLink() {
  const item = S.current;
  if (item?.kind !== 'link' || S.switchingMedia || S.skippedLinks.has(item.id)) return;
  const seq = S.currentSeq;
  // 行内的按钮按节流重画，连点两下会重来两遍（两份解析、两次起播）
  if (S.linkRetrying === seq) return;
  S.linkRetrying = seq;
  try {
    await retryLinkNow(item, seq);
  } finally {
    if (S.linkRetrying === seq) S.linkRetrying = null;
  }
}

async function retryLinkNow(item, seq) {
  const hostResolved = S.linkInfo?.extractor === 'host-resolved';
  S.linkPlayFailed = null;
  S.linkFailedSeq = null;
  S.links.delete(linkKey(item.url));
  S.linkInfo = null;
  S.filePath = null;
  if (S.mpvRunning) {
    retirePlayer();
    $('btn-playpause').disabled = true;
    // 旧播放器退掉之前别起新的；它在等数据时让全房等着的卡顿也一并放掉
    S.sync?.playerGone?.();
    await S.playerQuit;
    if (S.currentSeq !== seq || S.current !== item) return;
  }
  $('btn-reopen')?.classList.add('hidden');
  log(`重新连接《${item.title || siteHost(item.url)}》…`);
  renderStatus();
  renderPlaylistSoon();
  updateLocalReady();
  if (hostResolved && linkFallback(item, seq)) {
    S.linkFailedSeq = seq;
    await tryLinkFallback(item, seq);
    return;
  }
  await activateLinkItem(item, seq);
}

/**
 * 「重新打开播放器」。在线链接这几种情况不能照旧把原来的地址交给播放器：
 *  - 上一次就没放起来（打不开、半路断了）：重新解析一遍（retryCurrentLink）；
 *  - 隔离浏览器抓到的媒体地址放久了（签名多半过期）：本机重新解析；
 *  - 房主给的地址放久了、房主那边已经有更新的：换成新的。没有更新的就还用手上这条试试，打不开会提示重试。
 * 普通 yt-dlp 解析的那一路交给播放器的是网页地址，mpv 重开时自己会重新解析，照旧打开。
 */
function reopenPlayer() {
  const item = S.current;
  if (S.sourceType === 'link' && item?.kind === 'link' && !S.mpvRunning && !S.switchingMedia) {
    if (linkPlayFailed()) return retryCurrentLink();
    const info = S.linkInfo;
    const stale = !!info && !info.local && Date.now() - (info.resolvedAt || 0) > LINK_INFO_TTL_MS;
    if (stale && info.extractor === 'isolated-browser') return retryCurrentLink();
    if (stale && info.extractor === 'host-resolved') {
      const fresh = linkFallback(item, S.currentSeq);
      if (fresh && fresh.url !== S.filePath) return retryCurrentLink();
    }
  }
  return launchPlayer();
}

/**
 * 本机解析失败时改用房主给的临时播放地址。播放器会直接连这个地址，它常常和页面不在同一个网站 ——
 * 允许过页面所在的网站，不等于允许连房主填的任何网站。所以按地址自己的网站再问一次
 * （和页面链接一样在行内问，不弹窗），没允许过就先不用。用上了返回 true。
 * 询问一有变化，行内当场重绘（不走 renderPlaylistSoon 的节流）：点「允许」时按当时的询问批准，
 * 行里显示的必须就是它，否则房主换个地址，本人点下去批准的就是没看到过的网站。
 */
async function tryLinkFallback(item, seq, detail = '') {
  if (S.currentSeq !== seq || S.linkInfo || S.skippedLinks.has(item.id)) return false;
  const info = linkFallback(item, seq);
  const origin = info ? siteOf(info.url) : '';
  if (!origin) {
    // 房主撤回了地址（或给的地址不成样子）：之前的询问作废
    if (S.fallbackConsent?.seq === seq) {
      S.fallbackConsent = null;
      renderStatus();
      renderPlaylist();
    }
    return false;
  }
  if (!S.approvedSites.has(origin)) {
    const asked = S.fallbackConsent;
    if (asked?.seq !== seq || asked.origin !== origin) {
      // 换了网站就是一次新的询问，重新计时（见 approveLinkSite）
      S.fallbackConsent = { seq, origin, host: siteHost(info.url), at: Date.now() };
      if (detail) log(`这个视频链接在你的电脑上无法解析：${detail}`, 'warn');
      log(`房主提供的临时播放地址来自 ${origin}，在列表或上方点「允许打开」后才会使用`, 'warn');
      renderPlaylist();
    }
    renderStatus();
    updateLocalReady();
    return false;
  }
  S.linkFailedSeq = null;
  const wasAsking = fallbackAsking();
  S.fallbackConsent = null;
  if (wasAsking) {
    renderStatus();
    renderPlaylist();
  }
  log(detail ? `本机解析失败，改用房主提供的临时播放地址：${detail}` : '改用房主提供的临时播放地址', 'warn');
  await useLinkInfo(item, info, seq);
  return true;
}

async function useLinkInfo(item, info, seq) {
  S.linkInfo = { ...info, title: item.title || info.title, duration: item.durationSec || info.duration || 0 };
  // 隔离浏览器是 yt-dlp 两次都解析不了才走的，info.url 还是那个网页地址 —— 把它交给 mpv
  // 只会让 ytdl_hook 用更弱的参数再失败一次。要放的是浏览器里抓到的那条媒体地址
  // （launchPlayer 认出它才会带上 Referer / User-Agent）。这个地址是本人已允许的那个页面
  // 在本机自己发出的请求，和 yt-dlp 正常解析后直接连 CDN 是同一性质，不再单独问一次。
  const captured = info.extractor === 'isolated-browser' ? info.playback?.url : '';
  S.filePath = /^https?:\/\//i.test(captured || '') ? captured : S.linkInfo.url;
  if (isRoomHost()) {
    // 解析时间要跟着发：晚到的成员据此判断这条签名地址是不是已经过期（见 linkFallback）
    S.nowLink = { seq, playback: info.playback || null, resolvedAt: info.resolvedAt || Date.now() };
    for (const p of S.swarm.peers.values()) {
      if (p.authenticated) p.send({ t: MSG.NOW_LINK, ...S.nowLink });
    }
  }
  updateLocalReady();
  await onLinkSessionReady();
}

function onNowLink(msg, peer) {
  if (isRoomHost() || peer.peerId !== S.hostId) return;
  if (!Number.isSafeInteger(msg.seq) || msg.seq < S.playlist.seq) return;
  const playback = msg.playback && typeof msg.playback === 'object' && !Array.isArray(msg.playback) ? msg.playback : null;
  // 解析时间只能往前不能往后：填个未来时间就能让过期的地址一直算新鲜。没填的按刚解析出来算（旧客户端）
  const resolvedAt = Number.isSafeInteger(msg.resolvedAt) ? Math.min(msg.resolvedAt, Date.now()) : Date.now();
  S.nowLink = { seq: msg.seq, playback, resolvedAt };
  // 用着房主给的地址、播放器却打不开（多半是签名过期了），房主刚发来一条新的：直接换上。
  // 在正常播放的不动（不中途换源），新地址留着给「重新打开播放器」用（见 reopenPlayer）
  if (S.currentSeq === msg.seq && S.current?.kind === 'link' && S.linkInfo?.extractor === 'host-resolved' && linkPlayFailed()) {
    const fresh = linkFallback(S.current, msg.seq);
    if (fresh && fresh.url !== S.filePath) {
      retryCurrentLink().catch((error) => log(error.message || String(error), 'bad'));
      return;
    }
  }
  // 本机解析失败、正等着房主给地址的，现在补上（地址所在的网站没允许过的，先在行内问）
  if (S.linkFailedSeq !== msg.seq || S.currentSeq !== msg.seq || S.current?.kind !== 'link' || S.linkInfo) return;
  tryLinkFallback(S.current, msg.seq).catch((error) => log(error.message || String(error), 'bad'));
}

/* ------------------------------ swarm/同步 ----------------------------- */

function initSwarmAndSync() {
  if (S.swarm) return;

  S.swarm = new Swarm({
    peerId: S.peerId,
    name: S.name,
    securityMode: S.roomSecurityMode || S.settings.securityMode,
    // HELLO 里报给别人：成员表上显示你用什么设备（Windows / macOS / Linux）
    platform: myPlatform(),
  });
  S.sync = new SyncEngine({
    peerId: S.peerId,
    name: S.name,
    isSeeder: S.isSeeder,
    hostId: S.hostId, // 房主=自身 peerId；加入者=邀请码里的房主 id。两条路都已提前设好
    // 安全模式收完、扫描通过才开播放器（见 playbackAllowed）：没收完的人不因为自己缓冲不足让全房等。
    // 模式和 Swarm 取同一个，不是 trusted 的一律按安全模式算（同 normalizeSecurityMode）
    playAfterComplete: (S.roomSecurityMode || S.settings.securityMode) !== 'trusted',
  });

  S.sync.onSetPause = (p) => whilePlayerBusy(window.sw.player.setPause(p).catch(() => {}));
  S.sync.onSeek = (pos) => whilePlayerBusy(applySeek(pos));
  S.sync.on('data-end', () => log('播放到已接收内容的末尾，等后续分片', 'warn'));

  // 同步引擎要发的消息，广播给所有 peer
  S.sync.on('outbound', (msg) => {
    for (const p of S.swarm.peers.values()) {
      if (p.authenticated) p.send(msg);
    }
  });

  // 房主替成员转发：极简模式是星型，成员之间收不到彼此的控制消息。
  // 不发回给发送者本人，也不发给消息的原作者。
  S.sync.on('relay', ({ msg, except }) => {
    for (const p of S.swarm.peers.values()) {
      if (p.authenticated && p.peerId !== except && p.peerId !== msg.origin) p.send(msg);
    }
  });

  // 这一部真正开播了：记进列表，之后往当前项上面拖要先确认
  S.sync.on('playing', ({ seq }) => {
    if (!isRoomHost()) return;
    const next = markStarted(S.playlist, seq);
    if (next !== S.playlist) commitPlaylist(next);
  });

  // 放到头了：控制者报给列表，由房主推进
  S.sync.on('eof', () => {
    if (!S.sync.canIControl() || !S.current) return;
    submitPlaylistOp({ type: 'ended', seq: S.currentSeq });
  });
  // 在线视频半路断了（引擎核对过位置和片长，不是放完了）：不推进列表，提示本人重新连接
  S.sync.on('stream-cut', (e) => onLinkStreamCut(e));

  // 就绪变化：刷新等待名单；房主看看是不是该自动开播了
  S.sync.on('ready-change', () => {
    // 成员表上每人的「未就绪 / 已就绪」要和状态带的等待名单一起换
    renderPeersSoon();
    renderReady();
    maybeAutoStart();
  });

  S.swarm.on('peer-authenticated', async (peer) => {
    log(`已和 ${peer.name} 完成${securityModeLabel(S.roomSecurityMode)}握手`, 'good');
    S.chat.names.set(peer.peerId, peer.name);
    // 刚断开、「离开了」还没说出口就连回来的，进出两句都不说
    if (!noteRejoin(peer.peerId, peer.name)) S.chat?.note(`${peer.name} 加入了房间`);
    S.sync?.greet(peer, {
      // 顺序是契约：角色表 → 播放列表（和链接的兜底地址）→ 同步状态
      beforeSync: () => {
        if (!isRoomHost()) return;
        S.swarm.sendLarge(peer, { t: MSG.PLAYLIST, state: S.playlist });
        if (S.nowLink?.seq === S.playlist.seq) peer.send({ t: MSG.NOW_LINK, ...S.nowLink });
        refreshNowLink();
        // 顺序是契约：角色表 → 播放列表（和链接兜底地址）→ 聊天历史 → 同步状态
        S.swarm.sendLarge(peer, { t: MSG.CHAT_HISTORY, items: S.chat.history.snapshot() });
      },
    });
    if (peer.peerId === S.hostId && (S.hostGone || S.hostLink)) {
      S.hostGone = false;
      S.hostLink = null;
      renderPlaylistSoon();
    }
    // 房主（重新）连上了：自己还没等到回执的聊天补发给他
    if (peer.peerId === S.hostId && !isRoomHost()) resendPendingChats(peer);
    refreshSources();
    scheduleTransferUpdate();
    if (S.role === 'guest' && !roomEntered) await enterRoom();
  });

  S.swarm.on('peer-gone', (peerId) => {
    S.chat?.gate.forget(peerId);
    const gone = S.chat?.names.get(peerId);
    if (gone) {
      S.chat.names.delete(peerId);
      // 直连断了会自动重连：「离开了」先压几秒，这期间连回来就不说
      noteLeaveLater(peerId, gone);
    }
    // 和房主的这条连接没了（不管是在重连还是他真走了）：等它回执的列表操作不必再等
    if (peerId === S.hostId && !isRoomHost()) settlePendingOpsHostLost();
    if (peerId === S.hostId && !isRoomHost() && roomEntered && !S.hostGone) {
      if (S.mode === 'manual') {
        // 极简模式没有信令、也没有重连的路子：直连断了就是这一场结束了
        S.hostGone = true;
        log('房主已离开，这个房间结束了', 'warn');
      } else if (S.signaling?.hasLeft?.(peerId)) {
        // 信令服务器早就宣布他离开了，数据通道现在也关了（强退、崩溃、正常退出都是先断信令）：
        // 不是链路抖动，没有什么可重连的
        hostReallyGone();
      } else {
        // 信令模式下 peer-gone 还可能来自 ICE failed 或房主发来的重协商 —— 那时正在重连，
        // 人没走。真的离开由信令的 peer-leave 或重连退避用尽来认定（见 hostReallyGone）。
        S.hostLink = 'reconnecting';
      }
    }
    refreshSources();
    scheduleTransferUpdate();
    renderPlaylistSoon();
    renderReady();
    maybeAutoStart();
  });
  // 谁手里有哪部片变了，传输目标可能要换
  S.swarm.on('sources', () => {
    scheduleTransferUpdate();
    renderPlaylistSoon();
  });
  S.swarm.on('ctrl', ({ msg, peer }) => onRoomCtrl(msg, peer));
  // 房主用信令服务器时，经一对一邀请、房间链接进来的人服务器看不到：有人进出就把这个数报上去
  S.swarm.on('peer-authenticated', () => syncOutsideSeats());
  S.swarm.on('peer-gone', () => syncOutsideSeats());

  S.sync.on('stall-change', ({ who: peerId, name, stalled, self }) => {
    // 名字按成员表同一套显示名：两个「小明」时得分得清是哪一个在卡
    const who = self ? t('你') : roomDisplayNames().get(peerId) || name;
    // 游客的缓冲不足只暂停自己，别喊「全员暂停」误导人。
    const guestSelf = self && !S.sync.canIControl();
    if (stalled) {
      log(
        guestSelf ? '你的缓冲不够，先暂停你自己（不影响他人）' : `${who}的缓冲跟不上了，全员暂停等待`,
        'warn'
      );
      // OSD 文本走 IPC 交给 mpv 渲染，不进 DOM —— 自动翻译的 MutationObserver
      // 碰不到它，必须在这里显式过一遍 t()。字典里本来就为这几条写了英文，
      // 只是调用点漏了，那些词条一直是死的。
      window.sw.player.osd(guestSelf ? t('缓冲不足，暂停你自己…') : t(`等待 ${who} 缓冲…`), 3000);
    } else {
      log(`${who}缓冲够了`, 'good');
    }
  });

  S.sync.on('remote-action', ({ kind, by, position }) => {
    const label = { play: '播放', pause: '暂停', seek: '跳转' }[kind] || kind;
    log(`${by} ${label} @ ${fmtTime(position)}`);
    // 聊天流里只记播放和暂停：每一次跳转都刷一行太吵，日志里照样查得到
    if (kind === 'play' || kind === 'pause') S.chat?.note(`${by} ${label} @ ${fmtTime(position)}`);
  });

  // 以前只记别人的操作，自己的不记 —— 于是日志里看得见「Alice 暂停」，
  // 却看不见紧接着自己按的那一下，回头对着日志根本复原不出当时发生了什么。
  S.sync.on('local-action', ({ kind, position }) => {
    const label = { play: '播放', pause: '暂停', seek: '跳转' }[kind] || kind;
    log(
      S.sync.canIControl() ? `你 ${label} @ ${fmtTime(position)}` : `你 ${label} @ ${fmtTime(position)}（只影响你自己）`
    );
  });

  S.sync.on('state', renderStatus);
  S.sync.on('margin', renderStatus);
  // 在线链接：本机和房主差了多少秒。横幅（「播放中，但你和房主没对上」）和差值那一行要一起换，
  // 所以走整个 renderStatus（它会调 renderDrift），不能只画那一行
  S.sync.on('drift', renderStatus);
  S.sync.on('drift-correct', ({ seconds }) => {
    log(`和${driftRefName()}差了 ${Math.abs(seconds).toFixed(1)} 秒，自动对齐`);
  });

  // 角色变化：重画成员列表（含标签/切换按钮）、更新我自己的身份提示。
  S.sync.on('roles', () => {
    renderPeersSoon();
    renderMyRole();
    // 升降管理员会改变能不能编辑列表
    if (!roomEntered) return;
    if (!canEditPlaylist()) dropPrepJobsAfterDemotion();
    renderPlaylist();
  });

  // 游客试图跳转被拦下的反馈。
  S.sync.on('denied', ({ action }) => {
    if (action === 'seek') {
      log('你是游客，不能跳转进度', 'warn');
      window.sw.player.osd(t('游客不能跳转进度'), 2000);
      return;
    }
    if (action === 'play') {
      // 全员暂停期间在 mpv 里按空格，引擎会把暂停压回去。以前这里没有分支，
      // 画面弹回暂停却一个字都不给 —— 用户只会觉得播放器坏了。
      // 连按会连发，节流一下，别把 IPC 打满。
      const now = Date.now();
      if (now - lastPlayDeniedAt < 1500) return;
      lastPlayDeniedAt = now;
      const wait = stallWaitSeconds();
      window.sw.player.osd(
        t(wait ? `缓冲还不够，约 ${fmtTime(wait)} 后自动继续` : '缓冲还不够，攒够了会自动继续'),
        2500
      );
    }
  });

  S.swarm.on('manifest-bad', ({ from }) => {
    log(`${S.swarm.peers.get(from)?.name || from} 给的媒体清单没通过校验，已换人再要`, 'warn');
  });
  S.swarm.on('chunk-bad', ({ index, reason }) => {
    log(`分片 ${index} 校验未通过（${reason}），已丢弃重下`, 'warn');
  });
  // 上游信誉：多次送坏片的人不再向他要片；拉黑后还在灌帧的直接断开
  S.swarm.on('peer-banned', ({ name, disconnected }) => {
    log(
      disconnected
        ? `${name} 被停止供片后仍在持续发送数据，已断开连接`
        : `${name} 送来的分片多次校验失败，已停止向他要片`,
      'warn'
    );
  });
  // 分片写盘失败（多半是磁盘满了）。swarm 会重新要这一片；不说一声的话，
  // 用户只看到进度停住、流量却一直在走。节流：同一个原因每片都会再报一次。
  let lastWriteErrorAt = 0;
  S.swarm.on('error', (e) => {
    const now = Date.now();
    if (now - lastWriteErrorAt < 10_000) return;
    lastWriteErrorAt = now;
    const detail = e?.message || String(e);
    log(`写入接收缓存失败：${detail}`, 'bad');
    // 看片时 NoxReel 窗口多半压在播放器下面，日志没人看：在播放器画面上也提一句
    if (S.mpvRunning) window.sw.player.osd(t('写入接收缓存失败，磁盘可能已满'), 4000);
  });
  // 接收进度是 stall 评估的第二个驱动源。全员暂停后 mpv 不再发 tick，
  // 只剩这条路能把「缓冲攒够了」告诉同步引擎。只看正在播放的那一部。
  S.swarm.on('progress', (p) => {
    renderPlaylistSoon();
    // 当前这部只是在补别人手里有的那一段：补完了要重算，把传输让给后面收得齐的片
    if (p.slot !== null && p.slot === S.partialSlot) scheduleTransferUpdate();
    if (p.slot === null || p.slot !== S.swarm.playingSlot) return;
    // runBytes 是按 ctx.playbackByte 算的，而那个位置由本轮末尾的 renderProgress
    // 推给调度器（播放器没起来时用的是房间位置）。所以这里的 runBytes 最多落后一片，
    // 房间时钟往前走的那点距离下一片就跟上了。
    S.sync.onBufferProgress({ contiguousBytes: p.contiguousBytes, runBytes: p.runBytes, complete: p.complete });
    maybeLaunchPlayer(p);
    renderProgress(p);
    updateLocalReady();
  });
  // 每个 pong、每次握手都会发 peers：照单全收的话对端刷 pong 就能让整张成员表每秒重建上千次
  S.swarm.on('peers', renderPeersSoon);
  // 有人在房间里改了昵称：聊天里说一声，就绪 / 卡顿表里的名字跟着换，成员表和聊天按新名字重画
  S.swarm.on('peer-renamed', ({ peerId, name, oldName }) => {
    S.sync?.noteRename(peerId, name);
    // 离开时的「X 离开了房间」也得用新名字
    if (S.chat.names.has(peerId)) S.chat.names.set(peerId, name);
    chatSystem(`${oldName || peerId} 改名为 ${name}`);
    renderPeersSoon();
    renderChat();
  });
  S.swarm.on('identity-mismatch', ({ expected }) => {
    log(`已断开身份校验失败的成员：${expected}`, 'bad');
  });
  S.swarm.on('mode-mismatch', ({ peerId, localMode, remoteMode }) => {
    const message = `${peerId} 的模式是${securityModeLabel(remoteMode)}，本房间是${securityModeLabel(localMode)}，已在传输媒体前断开。`;
    log(message, 'bad');
    if (!roomEntered && S.role === 'guest') {
      S.signaling?.close();
      joinFail(`${message}\n请双方分别在设置里选择相同模式后重试。`);
    }
  });
  // 0.7 和 0.6 的线缆格式不互通。说清楚是哪一边旧，别让人以为是网络问题。
  S.swarm.on('version-mismatch', ({ peer, name, remoteVersion }) => {
    const message =
      remoteVersion < PROTOCOL_VERSION
        ? `${name} 用的是旧版 NoxReel（0.6.x），和 0.7 不互通，已断开。请让对方升级到 0.7 再加入。`
        : `${name} 用的是更新版本的 NoxReel，和本机不互通，已断开。请先升级本机的 NoxReel。`;
    peer.versionMessage = message;
    log(message, 'bad');
    if (!roomEntered && S.role === 'guest') {
      S.signaling?.close();
      joinFail(message);
    }
  });
  S.swarm.on('complete', ({ fileId }) => {
    scheduleTransferUpdate();
    renderPlaylistSoon();
    if (S.current?.kind === 'file' && S.current.fileId === fileId) {
      log('文件已全部接收并校验，正在执行本机安全扫描…');
      updateLocalReady();
      // 可信房间边下边播那一段是 mpv 顶着的，收完之后外部播放器才接得了手
      updatePlayerSwitchHint();
    } else {
      // 收完的时候条目可能已经被挪进已播放区或移除了：查得到名字才记，别把「下一部」当片名拼进模板
      const item = [...S.playlist.queue, ...S.playlist.history].find(
        (it) => it.kind === 'file' && it.fileId === fileId
      );
      if (item) log(`《${item.name}》已全部接收`, 'good');
    }
    // 收完的片挨个扫，当前项优先
    pumpScans();
  });

  S.swarm.start();
}

/** 房间里的控制消息。swarm 已经拼好了分段、确认过发送者身份。 */
function onRoomCtrl(msg, peer) {
  if (!peer.authenticated || !msg) return;
  switch (msg.t) {
    case MSG.PLAYLIST:
      onPlaylistMessage(msg, peer);
      break;
    case MSG.PLAYLIST_OP:
      onPlaylistOp(msg, peer);
      break;
    case MSG.PLAYLIST_ACK:
      onPlaylistAck(msg, peer);
      break;
    case MSG.NOW_LINK:
      onNowLink(msg, peer);
      break;
    case MSG.CHAT:
      onChatMessage(msg, peer);
      break;
    case MSG.CHAT_HISTORY:
      onChatHistory(msg, peer);
      break;
    default:
      S.sync?.onCtrl(msg, peer);
  }
}

/* ------------------------------- 进入房间 ------------------------------ */

let roomEntered = false;

async function enterRoom() {
  if (roomEntered) return;
  roomEntered = true;
  // 这次尝试成功了：之后再来的邀请按「已在房间里」处理，挂着的收尾也用不上了
  joinAttempt.busy = null;
  joinAttempt.cleanups.length = 0;

  initSwarmAndSync();

  show('view-room');

  refreshMediaUi();
  renderMyRole();
  renderInvite();
  renderPeers([]);
  renderPlaylist();
  renderReady();
  renderChat();
  ensureDanmakuControls();
  renderPlayerControls();
  // 顶栏：离开房间和房间药丸进房后一直在。
  // 邀请只有成员页一个入口：空房间时成员页就是邀请流程，有人进来后收成一行「邀请下一位」。
  // 顶栏原来还有一个「邀请」，和「邀请下一位」是同一个动作，重复了，去掉。
  $('btn-leave').classList.remove('hidden');
  $('pill-room').classList.remove('hidden');
  renderRoomPill();
  renderInviteArea();
  startRateTicker();
  updatePresence();
  // 当前项在进房前就可能已经切好了（房主自己的片）；观众要等列表和清单到了，
  // 由 onPlaylistChanged → switchCurrent 那一路接着走。
}

/* ------------------------------ Discord 状态 ------------------------------ */

// 上一次交给主进程的内容的比对键。'off' 表示没在显示（初始就是这个，进房前不会平白发一条清空）
let presenceKey = 'off';
// 两次交给主进程之间至少隔这么久。每个播放器 tick、每次成员表重画都会来问一遍；
// 人进进出出、进度卡在 10 秒粗化的边界上来回跳时，键会接连变化，不限的话每一下都是一次 IPC。
const PRESENCE_MIN_MS = 5000;
let presenceSentAt = 0;
let presenceTimer = null;

/** 现在该在 Discord 上显示什么；没变就什么也不发。主进程那边另有 15 秒限频。 */
function updatePresence() {
  if (!window.sw?.discord) return;
  const inRoom = roomEntered && !S.leaving;
  const activity = inRoom ? buildActivity(presenceState(), S.discord, t) : null;
  const key = activityKey(activity);
  if (key === presenceKey) return;
  // 关掉（退房、关开关）立刻生效，那是隐私上的要求；其余的变化合并到间隔结束时发最新的那份
  const wait = activity ? presenceSentAt + PRESENCE_MIN_MS - Date.now() : 0;
  if (wait > 0) {
    presenceTimer ||= setTimeout(() => {
      presenceTimer = null;
      updatePresence();
    }, wait);
    return;
  }
  clearTimeout(presenceTimer);
  presenceTimer = null;
  presenceKey = key;
  presenceSentAt = Date.now();
  const call = activity ? window.sw.discord.setActivity(activity) : window.sw.discord.clear();
  call.then(setDiscordStatus, () => {});
}

function presenceState() {
  const st = S.sync?.status?.() || {};
  S.presenceParty ||= randomPeerId(); // 这个房间的随机标识，不含任何能拿来进房的东西
  return {
    title: S.sourceType === 'link' ? S.linkInfo?.title || S.current?.title : S.manifest?.name || S.current?.name,
    // 看的是全房的状态，不是游客自己那一路的暂停
    paused: S.sync?.shared?.paused !== false,
    started: S.playlist?.started === true,
    position: S.sync?.sharedPositionNow?.(),
    duration: st.duration || S.current?.durationSec,
    members: connectedPeerCount() + 1,
    capacity: S.roomCapacity,
    roomLink: S.signalTransport === 'relay' ? S.roomLink : null,
    partyId: S.presenceParty,
  };
}

const DISCORD_STATUS_TEXT = {
  unconfigured: '这个版本没有配置 Discord 应用，状态显示用不了',
  ready: '已连上 Discord',
  connecting: '正在连接 Discord…',
  unavailable: '没检测到 Discord 客户端（开着 Discord 时会自动连上）',
};

function discordStatusText() {
  const text = DISCORD_STATUS_TEXT[S.discordStatus];
  if (text) return text;
  return S.discord.enabled ? '进入房间后会显示' : '没有打开';
}

function setDiscordStatus(status) {
  if (typeof status !== 'string') return;
  S.discordStatus = status;
  const el = $('set-discord-status');
  if (el) el.textContent = discordStatusText();
}

/* ------------------------------ 房间页签 ------------------------------ */

let tabTouched = false;

function selectRoomTab(name, { byUser = false } = {}) {
  const tab = document.getElementById(`tab-${name}`);
  if (!tab || tab.classList.contains('hidden')) return;
  if (byUser) tabTouched = true;
  for (const el of document.querySelectorAll('.room-tab')) {
    const on = el === tab;
    el.classList.toggle('on', on);
    el.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  for (const panel of document.querySelectorAll('.tab-panel')) {
    panel.classList.toggle('on', panel.id === `panel-${name}`);
  }
  if (name === 'peers') $('peers-dot').classList.add('hidden');
  if (name === 'log') $('event-log').scrollTop = $('event-log').scrollHeight;
}

/** 有人进来时，成员页签没开着就点个角标，不抢焦点。 */
function notePeersChanged() {
  if (!$('tab-peers').classList.contains('on')) $('peers-dot').classList.remove('hidden');
}

const canEditPlaylist = () => !!S.sync?.canIControl();

/* ------------------------------ 聊天与弹幕 ------------------------------ */

let chatPanel = null;

function ensureChatPanel() {
  if (chatPanel) return chatPanel;
  chatPanel = createChatPanel({
    body: $('chat-body'),
    foot: $('chat-foot'),
    onSend: (text) => sendChat(text),
    // 窗口没焦点时标题前挂 (N)，回到窗口且看着最新消息就清掉
    onTitle: (prefix) => {
      document.title = `${prefix}NoxReel`;
    },
  });
  window.addEventListener('focus', () => chatPanel.setFocused(true));
  window.addEventListener('blur', () => chatPanel.setFocused(false));
  return chatPanel;
}

// 聊天、系统事件每来一条都要把最多 VIEW_LIMIT 行整个过一遍：合并到一帧里画一次
const CHAT_RENDER_MS = 50;
let chatRenderTimer = null;

function renderChat() {
  if (!roomEntered || chatRenderTimer) return;
  chatRenderTimer = setTimeout(() => {
    chatRenderTimer = null;
    if (!roomEntered) return;
    // 发言人还在房里的，按成员表同一套显示名（重名编号、改过名的用新名字）；走了的就用当时的名字
    const names = roomDisplayNames();
    const entries = S.chat.entries.map((e) => (e.from && names.has(e.from) ? { ...e, name: names.get(e.from) } : e));
    ensureChatPanel().render({ entries, notice: S.chat.notice });
  }, CHAT_RENDER_MS);
}

/** @returns {boolean} 真的加进去了（同一个 key 已经在列表里就不加） */
function pushChatEntry(entry) {
  const list = S.chat.entries;
  // 同一个 key 绝不能进两次：面板按 key 复用元素，重复的会当场抛错，而且这两条一直留在列表里，
  // 之后每一次重绘都再抛一次，聊天面板从此永久坏掉。去重表有 TTL，同 id 的消息隔久了会「复活」，
  // 网状模式下直连那份和房主补发的历史也可能撞上，所以这一层必须自己兜住。
  if (entry.key && list.some((e) => e.key === entry.key)) return false;
  list.push(entry);
  if (list.length > VIEW_LIMIT) list.splice(0, list.length - VIEW_LIMIT);
  renderChat();
  return true;
}

// 直连断了到重连握手完成，通常就几秒（退避 1.5 秒起，再加上 ICE 收集和握手）
const LEAVE_NOTE_DELAY_MS = 10_000;

/**
 * 有人断开了：「X 离开了房间」先压 LEAVE_NOTE_DELAY_MS 再说。直连断了会自动重连（见 scheduleReconnect），
 * 立刻说的话网络一抖，聊天里就是一对「离开了」「加入了」，大家以为有人掉线又进来了。
 * 这期间同一个人重新握手成功（noteRejoin）就撤掉；真走了，晚几秒照样说。
 */
function noteLeaveLater(peerId, name) {
  clearTimeout(S.chat.leaving.get(peerId)?.timer);
  const timer = setTimeout(() => {
    if (S.chat.leaving.get(peerId)?.timer !== timer) return;
    S.chat.leaving.delete(peerId);
    S.chat.note(`${name} 离开了房间`);
  }, LEAVE_NOTE_DELAY_MS);
  S.chat.leaving.set(peerId, { name, timer });
}

/**
 * 有人完成握手：他要是刚断开、「离开了」还没说出口，这就是连回来了 —— 进出都不说，
 * 断开期间改了名的补一句改名。
 * @returns {boolean} 是不是连回来的
 */
function noteRejoin(peerId, name) {
  const away = S.chat.leaving.get(peerId);
  if (!away) return false;
  clearTimeout(away.timer);
  S.chat.leaving.delete(peerId);
  if (away.name !== name) S.chat.note(`${away.name} 改名为 ${name}`);
  return true;
}

/**
 * 系统事件（谁进来了、谁走了、换片、谁按了暂停）在聊天流里显示成灰色一行，事件日志照常保留。
 * 整句交给 t() 翻译，昵称和片名靠词条里的正则捕获原样带过去 —— 所以这一行不打跳过标记。
 */
function chatSystem(text) {
  if (!roomEntered) return;
  pushChatEntry({ key: `sys:${randomId(8)}`, kind: 'system', text });
}

let chatNoticeTimer = null;

/** 输入框下面那一行提示（目前只有超速）。 */
function chatNotice(text) {
  S.chat.notice = text || '';
  renderChat();
  clearTimeout(chatNoticeTimer);
  if (text) chatNoticeTimer = setTimeout(() => chatNotice(''), 5000);
}

/** 现在能发聊天的连接（可以排除掉几个人）。 */
function chatPeers(skip = []) {
  const except = new Set(skip.filter(Boolean));
  return [...(S.swarm?.peers.values() || [])].filter((p) => p.authenticated && !except.has(p.peerId));
}

/**
 * 发一条聊天。房间输入框和 mpv 里的输入条走同一条路、同一把令牌桶 —— 换个入口绕不过限速。
 * @returns {boolean} 有没有被收下；没收下时输入框里的字留着，别让人重打一遍
 */
function sendChat(rawInput, { fromPlayer = false } = {}) {
  const res = S.chat.sender.submit(rawInput);
  if (!res.ok) {
    if (res.reason !== 'rate') return false;
    const tooFast = `发得太快了（${res.retryAfterSec} 秒后再试）`;
    chatNotice(tooFast);
    // 在播放器里发的，人根本看不见房间窗口，这句得送到 OSD 上
    if (fromPlayer) window.sw.player.osd(t(tooFast), 2500);
    return false;
  }
  const { id, text, ts } = res.message;
  // 自己的 id 先记一笔：房主把它转回来时认得出是回声，不会显示两遍
  S.chat.gate.remember(id);
  const host = isRoomHost();
  // 房主本人就是转发中枢，没有「等谁转回来」这回事，直接算已送达
  pushChatEntry({ key: id, kind: 'msg', from: S.peerId, name: S.name, text, ts, self: true, state: host ? 'sent' : 'sending' });
  showDanmaku({ id, text, self: true });
  if (host) S.chat.history.add({ id, text, origin: S.peerId, name: S.name, ts });
  const wire = host ? { t: MSG.CHAT, id, text, ts, origin: S.peerId, originName: S.name } : { t: MSG.CHAT, id, text, ts };
  for (const p of chatPeers()) p.send(wire);
  if (!host) {
    armChatAck(id);
    // 房主不在：「发送中」后面是什么情况得说清楚，别让人对着一直不变的状态干等
    if (S.hostId && !chatPeers().some((p) => p.peerId === S.hostId)) {
      const away = S.hostGone ? '房主已离开，这条消息房主收不到了' : '和房主的连接断了，连回来后补发这条消息';
      chatNotice(away);
      if (fromPlayer) window.sw.player.osd(t(away), 2500);
    }
  }
  return true;
}

// 自己发的消息等房主回执（他转回来的那一份）最多等这么久，过了还没有就标「未送达」
const CHAT_ACK_TIMEOUT_MS = 10_000;

/** 自己发的一条开始等回执：到点还是「发送中」就改成「未送达」。 */
function armChatAck(id) {
  clearTimeout(S.chat.acks.get(id));
  const timer = setTimeout(() => {
    if (S.chat.acks.get(id) !== timer) return;
    S.chat.acks.delete(id);
    const entry = S.chat.entries.find((e) => e.key === id && e.self);
    if (!entry || entry.state !== 'sending') return;
    entry.state = 'failed';
    renderChat();
  }, CHAT_ACK_TIMEOUT_MS);
  S.chat.acks.set(id, timer);
}

/**
 * 和房主（重新）连上了：自己还没等到回执的（「发送中」「未送达」）补发给他，id 不变 ——
 * 房主按 id 去重，收过的不会再显示一遍、只回一份回执；没收过的照常进历史、转给大家。
 * 房主对每个人限速（突发 BURST_TOKENS 条），一口气补多了也是被丢，所以只补最近这几条，更早的算「未送达」。
 */
function resendPendingChats(host) {
  const pending = S.chat.entries.filter(
    (e) => e.kind === 'msg' && e.self && (e.state === 'sending' || e.state === 'failed')
  );
  if (!pending.length) return;
  const resend = pending.slice(-BURST_TOKENS);
  for (const entry of pending) {
    if (resend.includes(entry)) continue;
    clearTimeout(S.chat.acks.get(entry.key));
    S.chat.acks.delete(entry.key);
    entry.state = 'failed';
  }
  for (const entry of resend) {
    entry.state = 'sending';
    host.send({ t: MSG.CHAT, id: entry.key, text: entry.text, ts: entry.ts });
    armChatAck(entry.key);
  }
  renderChat();
}

/** 收到别人的聊天。身份以连接为准；只有房主转发来的才采信 origin。 */
function onChatMessage(msg, peer) {
  const res = S.chat.gate.accept(msg, {
    senderId: peer.peerId,
    senderName: peer.name,
    hostId: S.hostId,
    selfId: S.peerId,
  });
  if (!res.ok) {
    // 房主把我自己那条转回来了：这是送达回执，不是新消息
    if (res.reason === 'echo') markChatDelivered(res.id);
    // 发言人补发了一条我收过的：他没等到回执（转回去的那一份多半丢在断掉的旧连接上），只给他再回一份
    else if (res.reason === 'duplicate' && isRoomHost()) {
      const item = S.chat.history.list().find((it) => it.id === res.id && it.origin === peer.peerId);
      if (item) peer.send({ t: MSG.CHAT, id: item.id, text: item.text, ts: item.ts, origin: item.origin, originName: item.name });
    }
    return;
  }
  const m = res.message;
  // 列表里已经有了（补发来的旧消息，去重表早过期了）就不再上弹幕、不再进历史
  const added = pushChatEntry({ key: m.id, kind: 'msg', from: m.origin, name: m.name, text: m.text, self: false });
  if (added) showDanmaku({ id: m.id, text: m.text, self: false });
  if (!isRoomHost()) return;
  // 房主是转发中枢：留进历史，再转给所有人 —— 包括发送者本人。
  // 转回去的这一份就是送达回执（他那边按 id 认出是自己的回声，只把「发送中」改成「已送达」，不会显示两遍）；
  // 不转回去的话，两个人的房间里发送者会永远停在「发送中」。
  if (added) S.chat.history.add(m);
  const wire = { t: MSG.CHAT, id: m.id, text: m.text, ts: m.ts, origin: m.origin, originName: m.name };
  for (const p of chatPeers()) p.send(wire);
}

/** 自己那条被房主转回来了：「发送中」「未送达」改成「已送达」。 */
function markChatDelivered(id) {
  clearTimeout(S.chat.acks.get(id));
  S.chat.acks.delete(id);
  const entry = S.chat.entries.find((e) => e.key === id && e.self);
  if (!entry || entry.state === 'sent') return;
  entry.state = 'sent';
  renderChat();
}

/** 入房时房主发来的最近 50 条。只进聊天列表、不上弹幕，末尾加一条分隔线。 */
function onChatHistory(msg, peer) {
  // 历史只认房主那条连接：别人发来的一概不看
  if (!trustsRelay(peer.peerId, S.hostId) || S.chat.historyShown) return;
  S.chat.historyShown = true;
  const items = parseHistory(msg.items);
  if (!items.length) return;
  const old = items.map((it) => ({
    key: it.id,
    kind: 'msg',
    from: it.origin,
    name: it.name,
    text: it.text,
    self: it.origin === S.peerId,
    quiet: true, // 补上来的旧消息不算未读
  }));
  // 已经在列表里的（直连先到、房主的历史后到）跳过，否则同一层会出现两条同 key
  const seen = new Set(S.chat.entries.map((e) => e.key));
  const fresh = old.filter((e) => !seen.has(e.key));
  S.chat.entries.unshift(...fresh, { key: 'history', kind: 'divider', text: '你加入前的消息' });
  // 记下这些 id：房主随后又转发同一条时不会再显示一遍
  for (const it of items) S.chat.gate.remember(it.id);
  renderChat();
}

// 弹道排布三端共用 danmaku.js。这里的宽高是交给主进程的虚拟画布（ASS 的 res_x / res_y），
// 和播放器窗口的真实像素无关，所以固定成 1080p。
const danmakuEngine = new DanmakuEngine({
  width: DANMAKU_CANVAS.width,
  height: DANMAKU_CANVAS.height,
  settings: S.danmakuSettings,
});

// 每秒 30 帧推给播放器。mpv 的覆盖层渲染时间固定为 0、\move 不会动，只能逐帧重画。
S.danmaku = createDanmakuPump({
  engine: danmakuEngine,
  send: (frame) => Promise.resolve(window.sw.player.setDanmakuFrame?.(frame)),
});
S.danmaku.setEnabled(S.danmakuSettings.enabled !== false);

function showDanmaku(msg) {
  S.danmaku.push(msg);
}

let danmakuControls = null;

function ensureDanmakuControls() {
  if (danmakuControls) return danmakuControls;
  danmakuControls = createDanmakuControls({
    slot: $('danmaku-slot'),
    settings: S.danmakuSettings,
    onChange: (next) => {
      S.danmakuSettings = next;
      saveDanmakuSettings(next);
      S.danmaku.setSettings(next);
      S.danmaku.setEnabled(next.enabled !== false);
    },
  });
  return danmakuControls;
}

/**
 * pause / seek 在途时停发弹幕帧：那阵子播放器忙着 settle，插队的覆盖层命令只会拖慢它。
 * 用计数不用布尔 —— 暂停和跳转会叠在一起，先回来的那个不能把还在跑的那个也一起解了。
 */
let playerBusy = 0;

function whilePlayerBusy(work) {
  playerBusy += 1;
  S.danmaku.setBusy(true);
  return Promise.resolve(work).finally(() => {
    playerBusy = Math.max(0, playerBusy - 1);
    if (playerBusy === 0) S.danmaku.setBusy(false);
  });
}

// 在播放器里按 Ctrl+Shift+D 输入并提交的那一条，和房间输入框走同一条路、同一把令牌桶。
// 主进程给的是 {text, gen, kind}，不是裸字符串 —— 当成字符串的话清洗完是空的，整条路静默失效。
window.sw.player.onChatInput?.((payload) => {
  if (roomEntered) sendChat(payload?.text, { fromPlayer: true });
});

/* ------------------------------ 播放列表表格 ------------------------------ */

let playlistPanel = null;

function ensurePlaylistPanel() {
  if (!playlistPanel) {
    const report = (error) => log(error?.message || String(error), 'bad');
    playlistPanel = createPlaylistPanel({
      body: $('playlist-body'),
      onAction: (key, id) => onPlaylistAction(key, id).catch(report),
      onMove: (id, beforeId) => movePlaylistItem(id, beforeId).catch(report),
      onDropFiles: (files) => addDroppedFiles(files).catch(report),
    });
  }
  return playlistPanel;
}

/**
 * 「能不能编辑列表」的控件一起收口：#add-link-row 在 #playlist-actions 外面，
 * 只藏后者的话，展开着的「+ 链接」输入行会留在被降为游客的人屏幕上，敲回车毫无反应。
 */
function syncPlaylistEditUi() {
  $('playlist-actions').classList.toggle('hidden', !canEditPlaylist());
  if (canEditPlaylist()) return;
  $('add-link-row').classList.add('hidden');
  $('room-video-link').value = '';
}

/** 右栏的播放列表。 */
function renderPlaylist() {
  if (playlistRenderTimer) {
    clearTimeout(playlistRenderTimer);
    playlistRenderTimer = null;
  }
  if (!roomEntered) return;
  const { queue } = S.playlist;
  $('playlist-count').textContent = queue.length ? String(queue.length) : '';
  syncPlaylistEditUi();
  $('pl-autoplay').checked = S.playlist.autoplay;
  $('pl-autoplay').disabled = !canEditPlaylist();
  ensurePlaylistPanel().render(playlistView());
  renderReady();
}

const itemName = (item) => (item.kind === 'link' ? item.title || item.url : item.name);
const pct = (ratio) => `${Math.floor(Math.max(0, Math.min(1, ratio || 0)) * 100)}%`;

/** 第二行：谁加的 · 时长 · 大小（链接是网站）。昵称和网站原样显示，不翻译。 */
function itemMeta(item) {
  const parts = [];
  if (item.addedByName) parts.push({ label: '添加者：', raw: item.addedByName });
  if (item.durationSec > 0) parts.push(fmtTime(item.durationSec));
  if (item.kind === 'file') parts.push({ text: fmtBytes(item.size), className: 'pl-size' });
  else parts.push({ raw: siteHost(item.url), className: 'pl-size' });
  return parts;
}

/** 收完之后那一栏说扫描到哪了。 */
function scanStateView(status) {
  switch (status) {
    case 'scanning':
      return { text: '已收完 · 扫描中', tone: 'warn' };
    case 'clean':
      return { text: '已收完 · 扫描通过', tone: 'good' };
    case 'unscanned':
      return { text: '已收完 · 未经扫描', tone: 'warn' };
    case 'scan-timeout':
    case 'scan-stopped':
      return { text: '已收完 · 没扫完', tone: 'warn' };
    default:
      return S.roomSecurityMode === 'trusted'
        ? { text: '已收完', tone: 'good' }
        : { text: '已收完 · 等待扫描', tone: '' };
  }
}

/**
 * 「传输」一栏。和播放状态分开说，免得「传输已暂停」被当成「播放暂停了」：
 * 传输严格按列表顺序，同一时刻只向别人要一部，其余的停在原处、进度留着。
 */
function fileTransferView(item) {
  if (S.blockedFiles.has(item.fileId)) return { text: '已拒绝接收', tone: 'bad' };
  const sess = S.sessions.get(item.fileId);
  if (sess?.isSeeder) return { text: item.sourceId === S.peerId ? '你是片源' : '本机有完整文件', tone: 'good' };
  if (S.diskFull.has(item.fileId)) return { text: '磁盘空间不够', tone: 'bad' };
  const ctx = sess && sess.slot === item.slot ? S.swarm?.files.get(item.slot) : null;
  if (ctx?.complete) return scanStateView(sess.safety.status);
  const gone = item.sourceGone ? '片源已离开' : '暂时没人能提供';
  if (!ctx) {
    if (S.opening.has(item.fileId)) return { text: '正在获取清单', tone: '' };
    if (S.swarm && !S.swarm.canFinish(item.slot)) return { text: gone, tone: 'warn' };
    return { text: '排队中', tone: '' };
  }
  const p = S.swarm.progress(item.slot);
  const ratio = p.ratio;
  if (S.swarm.activeSlot === item.slot) {
    if (p.downRate > 0) return { text: `传输中 ${pct(ratio)}`, tone: '', ratio };
    // 片源先顾着还在收当前这部的人，后面的片要等一等
    if (item.slot !== S.swarm.playingSlot) return { text: '排队中（等大家先收完当前这部）', tone: '', ratio };
    return { text: `等待片源 ${pct(ratio)}`, tone: '', ratio };
  }
  if (!S.swarm.canFinish(item.slot)) return { text: `${gone} ${pct(ratio)}`, tone: 'warn', ratio };
  return ratio > 0 ? { text: `传输已暂停 ${pct(ratio)}`, tone: '', ratio } : { text: '排队中', tone: '' };
}

function linkTransferView(item) {
  const cache = linkCacheOf(item);
  const download = linkDownloadOf(item);
  const busyView = (job, label) => {
    if (job.state === 'queued') return { text: `${label}排队中`, tone: '' };
    const ratio = job.total > 0 ? Math.min(1, job.downloaded / job.total) : 0;
    return { text: `${label}中 ${linkCachePct(job)}`, tone: '', ratio };
  };
  // 在下的先说（有进度条），然后是下好了的，最后才是失败
  if (linkCacheBusy(cache)) return busyView(cache, '缓存');
  if (linkCacheBusy(download)) return busyView(download, '下载');
  if (cache?.state === 'done') return { text: '已缓存 · 从本地播', tone: 'good' };
  if (download?.state === 'done') return { text: '已存到下载位置', tone: 'good' };
  if (cache?.state === 'failed') return { text: '缓存失败', tone: 'bad' };
  if (download?.state === 'failed') return { text: '下载失败', tone: 'bad' };
  return { text: S.current?.id === item.id && S.linkInfo ? '各自从原网站播放' : '在线视频', tone: '' };
}

/* ---------------------------- 在线视频的手动缓存 ---------------------------- */
// 列表里的在线视频可以「开始手动缓存」：主进程用 yt-dlp 下到缓存里（见 linkCache.js，跟着缓存清理方式走），
// 下好了之后同一个链接直接从本地播。可以同时缓存好几部。正在放的那一部不中途换源，下次轮到时才从本地播。
// 边下边播的下载走同一个下载器（purpose=download），进度也从这里报上来，但放在 S.linkDownloads 里。

function linkCacheOf(item) {
  return item?.kind === 'link' ? S.linkCaches.get(linkKey(item.url)) || null : null;
}

function linkDownloadOf(item) {
  return item?.kind === 'link' ? S.linkDownloads.get(linkKey(item.url)) || null : null;
}

const linkCacheBusy = (cache) => cache?.state === 'queued' || cache?.state === 'downloading';

function linkCachePct(cache) {
  return cache?.total > 0 ? pct(Math.min(1, cache.downloaded / cache.total)) : fmtBytes(cache?.downloaded || 0);
}

/** 主进程报来一次缓存 / 下载进度或结果。缓存好的这一部下次轮到时从本地播（正在放的不中途换源）。 */
function onLinkCacheUpdate(view) {
  if (!view || typeof view.url !== 'string') return;
  const download = view.purpose === 'download';
  const table = download ? S.linkDownloads : S.linkCaches;
  const key = linkKey(view.url);
  const before = table.get(key);
  table.set(key, view);
  if (before?.state !== view.state) {
    const title = view.title || siteHost(view.url);
    if (download) {
      if (view.state === 'done') log(`《${title}》已存到下载位置`, 'good');
      else if (view.state === 'failed') log(`《${title}》下载失败：${view.error || '原因不明'}`, 'bad');
    } else if (view.state === 'done') log(`《${title}》缓存好了，之后从本地播`, 'good');
    else if (view.state === 'failed') log(`《${title}》缓存失败：${view.error || '原因不明'}`, 'bad');
  }
  renderPlaylistSoon();
  if (!download && view.state === 'done' && before?.state !== 'done') playCachedCurrentNow(key);
}

/**
 * 当前这一部本机还没放起来（解析失败、正等着本人允许网站或房主给的地址），手动缓存恰好下完了：
 * 直接改从本地播，不用再「跳过 → 改为允许」绕一圈。从本地放不连网站，所以不必等允许。
 * 已经在放的、还在解析的不动：正在放的不中途换源，解析那一路回来会照常起播。
 */
function playCachedCurrentNow(key) {
  const cur = S.current;
  if (cur?.kind !== 'link' || linkKey(cur.url) !== key || S.linkInfo || S.switchingMedia) return;
  if (S.skippedLinks.has(cur.id)) return;
  if (S.linkFailedSeq !== S.currentSeq && !linkAsking() && !fallbackAsking()) return;
  S.linkConsent = null;
  S.fallbackConsent = null;
  log(`《${cur.title || siteHost(cur.url)}》缓存好了，改从本地播`, 'good');
  activateLinkItem(cur, S.currentSeq).catch((error) => log(error.message || String(error), 'bad'));
}

window.sw.linkCache?.onUpdate?.(onLinkCacheUpdate);

async function startLinkCache(item) {
  try {
    const view = await window.sw.linkCache.start(item.url, item.title || '');
    onLinkCacheUpdate(view);
    if (view.state !== 'done') log(`开始缓存《${item.title || siteHost(item.url)}》`, 'good');
  } catch (error) {
    log(`缓存不了：${error.message || error}`, 'bad');
  }
}

/* ---------------------------- 边下边播：看的片另存一份 ---------------------------- */
// 设置里打开「边下边播」后，放到的每一部都另存一份到下载位置（见主进程 download:*）。
// 和缓存是两回事：存下来的是用户自己的文件，缓存清理不碰；也不改变什么时候开始播。
// 只存本人放到的片（列表里没轮到的不存）：
//  - P2P 的片收完、扫描过关才存 —— 安全模式要扫过，可信房间只要没扫出威胁（它本来就不等扫描就播）；
//  - 在线视频缓存过的直接放一份过去，没缓存的在后台另下一份，和在线播放同时进行。

/** 这个扫描状态下能不能另存。扫出威胁的缓存当场就删了，不会走到这里。 */
function downloadAllowed(status) {
  if (status === 'clean') return true;
  return S.roomSecurityMode === 'trusted' && (status === 'unscanned' || SCAN_RESUMABLE.includes(status));
}

/** 这一部轮到本机放了：记下要另存，能存就存。 */
function wantDownload(item) {
  if (!S.settings.downloadWhileWatching || !item) return;
  if (item.kind === 'link') {
    saveLinkDownload(item);
    return;
  }
  if (!item.fileId) return;
  S.downloadWanted.add(item.fileId);
  maybeSaveDownload(S.sessions.get(item.fileId));
}

/**
 * 在线视频能不能另存：和播放一样要本人点过头 —— 网站允许过（或是自己加的），而且这一部没被本人跳过。
 * 下载会让本机去连这个网站（yt-dlp，直接下失败还会开隔离浏览器），没允许过就去连，等于绕开了网站授权；
 * 跳过的那一部也不算「你放到的」。没点头之前不记什么「待存」：允许之后由 approveLinkSite 补一次。
 */
function linkDownloadConsented(item) {
  return item?.kind === 'link' && siteApproved(item) && !S.skippedLinks.has(item.id);
}

async function saveLinkDownload(item) {
  if (!linkDownloadConsented(item)) return;
  const current = linkDownloadOf(item);
  if (linkCacheBusy(current) || current?.state === 'done') return;
  try {
    const view = await window.sw.download.saveLink(item.url, item.title || '');
    onLinkCacheUpdate(view);
    // 请求还在路上时本人点了「跳过」：那时还没有任务可取消，这里补上
    if (!linkDownloadConsented(item) && linkCacheBusy(view)) cancelLinkDownload(item);
  } catch (error) {
    log(`存不到下载位置：${error.message || error}`, 'bad');
  }
}

/** 取消这一部正在下（或排队）的另存任务。已经存好的文件不动。 */
function cancelLinkDownload(item) {
  const job = linkDownloadOf(item);
  if (!linkCacheBusy(job)) return;
  // 主进程按它核准过的网址记任务，拿它报上来的那个去取消
  window.sw.linkCache.cancel(job.url || item.url, 'download').catch(() => {});
}

/** P2P 的片：要另存的、收完了、扫描状态允许，就交给主进程放一份到下载位置（同盘硬链接，否则复制）。 */
async function maybeSaveDownload(session) {
  if (!session || session.isSeeder || !S.settings.downloadWhileWatching) return;
  const { fileId } = session;
  if (!S.downloadWanted.has(fileId) || S.downloadSaving.has(fileId)) return;
  if (!downloadAllowed(session.safety?.status)) return;
  S.downloadSaving.add(fileId);
  // 缓存和下载位置不在同一个盘上时要整部复制，几十 GB 得好几分钟：开始时就说一声
  log(`正在把《${session.manifest.name}》另存到下载位置…`);
  try {
    const r = await window.sw.download.saveSession(session.sessionId);
    if (r?.fresh) log(`《${session.manifest.name}》已存到下载位置`, 'good');
  } catch (error) {
    log(`《${session.manifest.name}》存不到下载位置：${error.message || error}`, 'bad');
  } finally {
    // 存上了或者存不了都不再自动重试（每个进度事件都重试一遍只会刷屏）；重新放这一部时再试
    S.downloadWanted.delete(fileId);
    S.downloadSaving.delete(fileId);
  }
}

/** 缓存好的这一部：直接交给播放器，不再去网站解析（缓存是本人点的，网站也不用再问）。 */
async function useCachedLink(item, local, seq) {
  S.linkInfo = {
    url: item.url,
    title: item.title || local.title,
    duration: item.durationSec || 0,
    extractor: 'cache',
    playback: null,
    resolvedAt: Date.now(),
    local: true,
  };
  S.filePath = local.path;
  if (isRoomHost()) {
    // 房主自己放本地缓存，用不上播放地址；成员却要靠它兜底 —— 安卓完全只认房主给的地址，
    // 本机解析失败的电脑端也要用。提前解析过的（preResolveNextLink）直接发；没有就先发一条空的
    // （好让大家知道这一部开始了），解析时间记 0，refreshNowLink 看到就会在后台解析一份补发过去。
    // 缓存是本人点的，已经连过这个网站，再解析一次不用另问。
    const pre = cachedLinkInfo(item.url);
    S.nowLink = pre?.playback
      ? { seq, playback: pre.playback, resolvedAt: pre.resolvedAt || Date.now() }
      : { seq, playback: null, resolvedAt: 0 };
    for (const p of S.swarm.peers.values()) {
      if (p.authenticated) p.send({ t: MSG.NOW_LINK, ...S.nowLink });
    }
    if (!S.nowLink.playback) refreshNowLink();
  }
  updateLocalReady();
  await onLinkSessionReady();
}

/** 别人加的链接：没允许过的网站在行内问一句，跳过的给个改主意的机会。 */
function linkNotice(item) {
  if (S.skippedLinks.has(item.id)) {
    return { text: '你跳过了这一部', tone: 'muted', actions: [{ key: 'allow-site', label: '改为允许' }] };
  }
  // 当前这部本机解析失败，房主给的临时播放地址在没允许过的网站上（自己加的链接也要问）
  if (S.current?.id === item.id && fallbackAsking()) {
    return {
      text: '房主给的播放地址需要允许打开',
      site: S.fallbackConsent.host,
      tone: 'warn',
      actions: [
        { key: 'allow-site', label: '允许' },
        { key: 'skip-link', label: '跳过' },
      ],
    };
  }
  // 本机解析失败、房主也没有能用的兜底地址：网站早就允许过了，不再问「允许」。
  // 失败可能只是暂时的（超时、限流），先给「重试」，再给「跳过」
  if (S.current?.id === item.id && linkResolveFailed()) {
    return {
      text: '本机没能解析这个链接',
      tone: 'bad',
      actions: [
        { key: 'retry-link', label: '重试' },
        { key: 'skip-link', label: '跳过' },
      ],
    };
  }
  // 解析成功了，本机播放器却放不了（打不开、半路断了）
  if (S.current?.id === item.id && linkPlayFailed()) {
    return {
      text: S.linkPlayFailed.kind === 'cut' ? '在线视频断了' : '播放器打不开这个链接',
      tone: 'bad',
      actions: [
        { key: 'retry-link', label: '重试' },
        { key: 'skip-link', label: '跳过' },
      ],
    };
  }
  if (siteApproved(item)) return null;
  return {
    text: '需要允许打开',
    site: siteHost(item.url),
    tone: 'warn',
    actions: [
      { key: 'allow-site', label: '允许' },
      { key: 'skip-link', label: '跳过' },
    ],
  };
}

/** 行菜单里和本机有关的几项，谁都能用。 */
function localMenu(item) {
  const menu = [];
  const sess = item.kind === 'file' ? S.sessions.get(item.fileId) : null;
  if (sess?.filePath) {
    // 按文件真正在哪儿说：手动模式收的、复用了持久副本的在长期缓存文件夹里，不是退房就删的临时文件
    const label = sess.isSeeder ? '打开源文件位置' : sess.persistent ? '打开长期缓存位置' : '打开临时缓存位置';
    menu.push({ key: 'reveal', label });
  }
  if (item.kind === 'link') {
    const cache = linkCacheOf(item);
    if (linkCacheBusy(cache)) menu.push({ key: 'cancel-cache', label: '取消缓存' });
    else if (cache?.state !== 'done') menu.push({ key: 'start-cache', label: '开始手动缓存' });
    if (linkCacheBusy(linkDownloadOf(item))) menu.push({ key: 'cancel-download', label: '取消下载' });
    menu.push({ key: 'copy-link', label: '复制链接' });
  }
  return menu;
}

function queueMenu(item, index, canEdit) {
  const menu = [];
  if (canEdit) {
    const last = S.playlist.queue.length - 1;
    menu.push(index > 0 ? { key: 'play-now', label: '立即播放' } : { key: 'skip', label: '跳过这一部' });
    if (index > 0) menu.push({ key: 'move-up', label: '上移' });
    if (index < last) menu.push({ key: 'move-down', label: '下移' });
    menu.push({ key: 'remove', label: '移除', danger: true });
  }
  return [...menu, ...localMenu(item)];
}

function historyMenu(item, canEdit) {
  const menu = [];
  if (canEdit) {
    // 缓存已经清掉的，再放一次要重新传
    const cached = item.kind === 'link' || S.sessions.has(item.fileId);
    menu.push({ key: 'requeue', label: cached ? '再放一次' : '再放一次（需重新传输）' });
    menu.push({ key: 'play-now', label: '立即播放' });
    menu.push({ key: 'remove', label: '从已播放中移除', danger: true });
  }
  return [...menu, ...localMenu(item)];
}

function playlistView() {
  const canEdit = canEditPlaylist();
  const { queue, history, started } = S.playlist;
  return {
    canEdit,
    banner: S.hostGone
      ? '房主已离开，列表暂停更新'
      : S.hostLink === 'reconnecting'
      ? '和房主的连接断了，正在重连；列表暂停更新'
      : '',
    emptyText: canEdit ? '列表还是空的，点右上角加一部。' : '列表还是空的，等房主加片。',
    rows: queue.map((item, i) => ({
      id: item.id,
      index: i + 1,
      name: itemName(item),
      meta: itemMeta(item),
      current: i === 0,
      next: i === 1,
      locked: i === 0 && started && canEdit && queue.length > 1,
      lockTitle: '已开播：把别的片拖到它上面会先问你要不要切过去',
      transfer: item.kind === 'file' ? fileTransferView(item) : linkTransferView(item),
      notice: item.kind === 'link' ? linkNotice(item) : null,
      menu: queueMenu(item, i, canEdit),
    })),
    pending: S.prepJobs.map(prepJobView),
    history: history.map((item) => ({
      id: item.id,
      name: itemName(item),
      meta: itemMeta(item),
      menu: historyMenu(item, canEdit),
    })),
  };
}

async function runPlaylistOp(op) {
  const res = await submitPlaylistOp(op);
  if (res.ok || res.reason === 'needs-confirm') return res;
  // 没等到回执的，房主那边可能已经改了：别说成「没改成」
  if (res.uncertain) log(`没等到房主确认：${res.reason || '未知原因'}`, 'warn');
  else log(`列表没改成：${res.reason || '未知原因'}`, 'warn');
  return res;
}

async function onPlaylistAction(key, id) {
  const job = S.prepJobs.find((j) => j.key === id);
  if (job) {
    if (key === 'job-cancel') cancelPrepJob(job);
    else if (key === 'job-dismiss') removePrepJob(job);
    return;
  }
  const found = findItem(S.playlist, id);
  if (!found) return;
  const { item, index, where } = found;
  // 只和本机有关的，谁都能做
  switch (key) {
    case 'allow-site':
      if (item.kind === 'link') approveLinkSite(item);
      return;
    case 'skip-link':
      if (item.kind === 'link') skipLinkItem(item);
      return;
    case 'retry-link':
      // 行菜单打开之后当前项可能已经换了：只重试正在放的这一部
      if (item.kind === 'link' && S.current?.id === item.id) await retryCurrentLink();
      return;
    case 'reveal': {
      const sess = item.kind === 'file' ? S.sessions.get(item.fileId) : null;
      if (sess?.filePath) window.sw.store.reveal(sess.filePath);
      return;
    }
    case 'copy-link':
      if (item.kind !== 'link') return;
      await window.sw.clipboard.writeText(item.url);
      log('链接已复制', 'good');
      return;
    case 'start-cache':
      if (item.kind === 'link') await startLinkCache(item);
      return;
    case 'cancel-cache':
      if (item.kind !== 'link') return;
      await window.sw.linkCache.cancel(item.url, 'cache').catch(() => {});
      log(`已取消缓存《${item.title || siteHost(item.url)}》`, 'warn');
      return;
    case 'cancel-download':
      if (item.kind !== 'link') return;
      await window.sw.linkCache.cancel(item.url, 'download').catch(() => {});
      log(`已取消下载《${item.title || siteHost(item.url)}》`, 'warn');
      return;
    default:
  }
  if (!canEditPlaylist()) return;
  const { queue } = S.playlist;
  switch (key) {
    // 菜单里点「立即播放」是明说要换，不再二次确认
    case 'play-now':
      await runPlaylistOp({ type: 'playNow', id });
      return;
    case 'skip':
      // 菜单打开之后当前项可能已经换了，别跳错
      if (where === 'queue' && index === 0) await runPlaylistOp({ type: 'ended', seq: S.playlist.seq });
      return;
    case 'move-up':
      if (where === 'queue' && index > 0) await movePlaylistItem(id, queue[index - 1].id);
      return;
    case 'move-down':
      if (where === 'queue' && index < queue.length - 1) await movePlaylistItem(id, queue[index + 2]?.id ?? null);
      return;
    case 'remove':
      if (where === 'queue' && index === 0 && S.playlist.started && !(await confirmRemoveCurrent(item))) return;
      await runPlaylistOp({ type: 'remove', id });
      return;
    case 'requeue':
      await runPlaylistOp({ type: 'requeue', id });
      return;
    default:
  }
}

/**
 * 拖动排序。开播之后换掉当前项必须先确认：确认后走「立即播放」，
 * 原来那部退到第二位、记下播到哪，回头从那儿接着放。
 */
async function movePlaylistItem(id, beforeId) {
  if (!canEditPlaylist()) return;
  const { queue } = S.playlist;
  const ids = reorderIds(
    queue.map((it) => it.id),
    id,
    beforeId
  );
  if (!ids) return;
  const cur = queue[0];
  if (S.playlist.started && ids[0] !== cur.id) {
    await switchByDrag(ids, cur);
    return;
  }
  const res = await runPlaylistOp({ type: 'move', id, beforeId });
  // 房主那边已经开播了，我这份列表刚跟上：按最新的顺序重算一遍再问，
  // 否则用的是松手那一刻的旧顺序，问的可能是用户根本没拖的那一部
  if (res.reason !== 'needs-confirm') return;
  const freshIds = reorderIds(
    S.playlist.queue.map((it) => it.id),
    id,
    beforeId
  );
  if (!freshIds) {
    renderPlaylist();
    return;
  }
  await switchByDrag(freshIds, currentItem(S.playlist));
}

async function switchByDrag(ids, cur) {
  const target = S.playlist.queue.find((it) => it.id === ids[0]);
  if (!target || !cur || target.id === cur.id) return;
  if (!(await confirmSwitch(target, cur))) {
    renderPlaylist();
    return;
  }
  const res = await runPlaylistOp({ type: 'playNow', id: target.id });
  if (!res.ok) return;
  // 用户是把正在放的那部往下拖：切过去之后再把它挪到拖到的位置
  const at = ids.indexOf(cur.id);
  if (at > 1) {
    const beforeId = ids.slice(at + 1).find((x) => S.playlist.queue.some((it) => it.id === x)) ?? null;
    await runPlaylistOp({ type: 'move', id: cur.id, beforeId });
  }
}

function confirmSwitch(target, cur) {
  const at = S.sync?.sharedPositionNow() || 0;
  return openModal({
    title: '切换正在播放的片子？',
    body: [
      field('切到', make('p', { raw: true, className: 'modal-name', text: itemName(target) })),
      field('正在放', make('p', { raw: true, className: 'modal-name', text: itemName(cur) })),
      hint(at >= 1 ? `正在放的这部排到下一位，回头从 ${fmtTime(at)} 接着放。` : '正在放的这部排到下一位。'),
    ],
    okText: '切换',
  }).done;
}

function confirmRemoveCurrent(item) {
  return openModal({
    title: '移除正在播放的这一部？',
    body: [make('p', { raw: true, className: 'modal-name', text: itemName(item) }), hint('会直接换到下一部。')],
    okText: '移除',
  }).done;
}

/* ------------------------------ 就绪与自动开播 ------------------------------ */

/** 我对当前这一部准备好没有。自己跳过的、被拒收的、磁盘放不下的也算好了，不挡别人。 */
function localReadyNow() {
  const item = S.current;
  if (!item || S.switchingMedia) return false;
  if (item.kind === 'link') {
    return isItemReady(item, {
      skipped: S.skippedLinks.has(item.id),
      // 缓存好了的从本地播，不用再问网站
      consented: siteApproved(item) || linkCacheOf(item)?.state === 'done',
      resolved: !!S.linkInfo,
    });
  }
  // 本机收不下这一部：和卡顿判定一样不参与（见 localOptedOut）
  if (localOptedOut(item)) return true;
  const sess = S.sessions.get(item.fileId);
  const ctx = sess && sess.slot === item.slot ? S.swarm?.files.get(item.slot) : null;
  const prog = ctx ? S.swarm.progress(item.slot) : null;
  // midJoin 单独给：码率未知时 startByte 恒为 0，只看它会让这道门槛静默失效。
  const midJoin = midJoinNow();
  // 房间还在片头时起播点就是文件头 0，从它起的连续数据就是从文件头起的那段。
  // 不能用 roomPlayheadByte()：播放器一起来，第一条 tick 就带着 stream-pos（解复用器
  // 已经读到的位置，暂停在 0 秒时也常有几 MB），拿它当起播点的话，同一个人对同一个起播点
  // 的结论会随「播放器报没报过 tick」翻转 —— 先报就绪又撤回，自动连播开不开播看竞态。
  const startByte = midJoin ? roomPlayheadByte() : 0;
  return isItemReady(item, {
    isSeeder: !!sess?.isSeeder,
    mode: S.roomSecurityMode,
    contiguousBytes: ctx?.contiguousBytes || 0,
    // 片头够了只说明播放器认得出格式，还得从起播点起够放 15 秒（中途加入、「回头接着放」
    // 时起播点在片中，swarm 的 runBytes 已经按房间位置起算）
    midJoin,
    startByte,
    runBytes: midJoin ? prog?.runBytes || 0 : ctx?.contiguousBytes || 0,
    runNeeded: startRunNeeded(item.size || 0, startByte),
    // 起播点在片中时，MKV 的索引（常在文件尾）也得先到
    tailReady: midJoin ? tailIndexMissing(ctx) === 0 : true,
    complete: !!ctx?.complete,
    scanStatus: sess?.safety.status,
  });
}

/**
 * 文件尾的索引（MKV 的 Cues 常写在文件尾）还差多少字节，0 = 到齐了或者用不着。
 * 调度器按内容认出是 faststart MP4（索引在文件头）才不预留文件尾，这里用同一个判据：
 * 认不出来就按「要」算。起播点在片中时缺了它，mpv 得从片头扫着建索引才定位得到起播点，
 * 而 [片头, 起播点) 是空洞。
 */
function tailIndexMissing(ctx) {
  const sch = ctx?.scheduler;
  if (!sch || ctx.complete || !sch.needsTailIndex() || !(sch.tailReserveBytes > 0)) return 0;
  const { size, chunkSize, chunkCount } = ctx.manifest;
  let missing = 0;
  for (let i = sch.byteToChunk(size - Math.min(sch.tailReserveBytes, size)); i < chunkCount; i++) {
    if (!ctx.have[i]) missing += Math.min(chunkSize, size - i * chunkSize);
  }
  return missing;
}

/**
 * 我没准备好的原因里，房主从我的位图上看不出来的那几种：收完了却卡在安全扫描上。
 * 随就绪消息报过去，房主的就绪名单和成员表才说得清在等什么 —— 否则只看得到「已收完」，
 * 不知道这个人本机的扫描器用不了（Defender 被第三方杀毒软件接管），每一部都得手动「仍然开始」。
 */
function localNotReadyWhy() {
  const item = S.current;
  if (item?.kind !== 'file' || S.roomSecurityMode === 'trusted' || localOptedOut(item)) return null;
  const sess = S.sessions.get(item.fileId);
  if (!sess || sess.isSeeder || sess.slot !== item.slot || !S.swarm?.files.get(item.slot)?.complete) return null;
  const status = sess.safety.status;
  if (status === 'scan-timeout') return sess.safety.unavailable ? 'scan-unavailable' : 'scan-incomplete';
  if (status === 'scan-stopped') return 'scan-incomplete';
  // 收完了还没出结论：正在扫，或者排在别的片后面等扫
  if (status !== 'clean' && status !== 'blocked') return 'scanning';
  return null;
}

/** 就绪消息里的原因，给人看的说法。 */
const READY_WHY_LABEL = { scanning: '在做安全扫描', 'scan-unavailable': '扫描器不可用', 'scan-incomplete': '安全扫描没做完' };

/** 就绪状态变了才会发出去（同步引擎里去重），所以进度事件里随手调也不贵。 */
function updateLocalReady() {
  if (!S.sync) return;
  const ready = localReadyNow();
  S.sync.setLocalReady(ready, ready ? null : localNotReadyWhy());
  renderReady();
  maybeAutoStart();
}

/**
 * 还没准备好的人。房主按自己连着的成员算；其他人只连着房主（星型），
 * 房间里还有谁只能从房主转来的就绪消息里知道。
 */
function readyWaiting() {
  if (!S.sync || !S.swarm || !S.current) return [];
  const snap = S.sync.readySnapshot();
  const ready = new Map(snap.peers.map((p) => [p.peerId, p.ready]));
  const why = new Map(snap.peers.map((p) => [p.peerId, p.why]));
  const members = new Map();
  if (!isRoomHost()) for (const p of snap.peers) members.set(p.peerId, { peerId: p.peerId, name: p.name });
  for (const p of S.swarm.peers.values()) {
    if (p.authenticated) members.set(p.peerId, { peerId: p.peerId, name: p.name });
  }
  // 没准备好的原因（对方报了的话）：房主据此知道是在等下载，还是卡在他本机的安全扫描上
  const out = waitingFor([...members.values()], ready).map((m) => ({ ...m, why: why.get(m.peerId) || null }));
  if (!snap.self) out.unshift({ peerId: S.peerId, name: '', self: true });
  return out;
}

const READY_NAMES_SHOWN = 6;

/** 这一部还没开播时，列出谁还没准备好；房主和管理员可以不等了。 */
function renderReady() {
  const row = $('ready-row');
  const visible =
    roomEntered && !!S.sync && !!S.current && !S.playlist.started && !S.switchingMedia && S.sync.shared.paused;
  row.classList.toggle('hidden', !visible);
  if (!visible) {
    // 「仍然开始」挪到了状态带的按钮区，不再跟着这一行一起藏起来，得自己收
    $('btn-force-start').classList.add('hidden');
    updateStripTone();
    return;
  }
  const waiting = readyWaiting();
  const canControl = S.sync.canIControl();
  row.classList.toggle('all', !waiting.length);
  // 房主一个人进了空房间：「所有人都准备好了」虽然不假，但这时候该做的是去拉人
  const alone = S.role === 'host' && connectedPeerCount() === 0;
  row.classList.toggle('alone', alone);
  if (alone) {
    replace('ready-text', make('span', { text: '还没有人加入：照下面的步骤把朋友拉进来，也可以自己先放' }));
  } else if (!waiting.length) {
    const armed = autoStartArmed();
    replace(
      'ready-text',
      make('span', {
        text: armed
          ? '所有人都准备好了，马上开始'
          : canControl
          ? '所有人都准备好了，点「播放」开始'
          : '所有人都准备好了，等房主或管理员开始',
      })
    );
  } else {
    const sep = currentLocale() === 'en' ? ', ' : '、';
    const names = [];
    // 名字按成员表同一套显示名（重名编号），两个「小明」时分得清是哪一个没准备好；
    // 不在表里的（星型房间里经房主转来的别人）用他报的名字
    const shown = roomDisplayNames();
    // 人数照实说，名字只列前几位：就绪名单来自对端的消息，列全了一行能撑满整个状态带
    waiting.slice(0, READY_NAMES_SHOWN).forEach((w, i) => {
      if (i) names.push(rawText(sep));
      names.push(w.self ? make('span', { text: '你' }) : rawText(shown.get(w.peerId) || peerName(w.name, w.peerId)));
      // 卡在安全扫描上的人说一句原因（昵称原样，原因单独一个元素走翻译）
      if (READY_WHY_LABEL[w.why]) names.push(make('span', { text: `（${READY_WHY_LABEL[w.why]}）` }));
    });
    if (waiting.length > READY_NAMES_SHOWN) names.push(rawText(`${sep}…`));
    replace('ready-text', make('span', { text: `等待 ${waiting.length} 人准备好：` }), ...names);
  }
  $('btn-force-start').classList.toggle('hidden', !canControl || !waiting.length);
  updateStripTone();
}

/** 开始放当前这一部（「仍然开始」，或者大家都准备好了）。 */
function startCurrentNow() {
  if (!S.sync?.canIControl() || !S.current) return;
  S.autoStartSeq = null;
  S.autoStartReason = null;
  // 这一部还没开播：起点按房间共识算（换片时已按 resumeAt 定好），不看本机播放器报的位置 ——
  // mpv 刚起来、片子还没载入时报的是 0，照它广播会把续播的这一部全房拉回片头。
  if (!S.playlist.started) S.sync.forgetPlayerState();
  S.sync.userSetPaused(false);
  renderStatus();
  renderReady();
}

/** 换上来的这一部已经上膛，就等大家就绪。等人期间关掉自动连播就该失效（「立即播放」是明说要放，不受影响）。 */
function autoStartArmed() {
  return isRoomHost() && S.autoStartSeq === S.playlist.seq && (S.autoStartReason === 'playNow' || S.playlist.autoplay);
}

/** 房主：自动连播换上来的这一部，等所有人都准备好就开播。 */
function maybeAutoStart() {
  if (!isRoomHost() || !S.sync || !S.current || S.switchingMedia) return;
  if (!autoStartArmed() || S.playlist.started || !S.sync.shared.paused) return;
  if (readyWaiting().length) return;
  log('所有人都准备好了，自动开始播放', 'good');
  startCurrentNow();
}

/** 当前这部的片源走了，手上又没收完：这一部暂时放不了。 */
function currentUnavailable() {
  const item = S.current;
  if (item?.kind !== 'file' || !item.sourceGone || S.isSeeder || !S.swarm) return false;
  if (currentFileCtx()?.complete) return false;
  return !S.swarm.canFinish(item.slot);
}

/** 我在给别人供当前这部：自己是片源，或者房主已经收完、在替片源转发。 */
function servingCurrent() {
  return S.isSeeder || (isRoomHost() && S.sourceType === 'file' && !!currentFileCtx()?.complete);
}

function refreshMediaUi() {
  renderFilmInfo();
  renderProgress(S.swarm?.progress());
  $('btn-reveal').classList.toggle('hidden', S.sourceType !== 'file' || !S.filePath);
  $('btn-reveal').textContent = S.isSeeder
    ? '打开源文件位置'
    : currentSession()?.persistent
    ? '打开长期缓存位置'
    : '打开临时缓存位置';
  // 按钮只画一个文件夹图标，文字放到悬停提示里
  $('btn-reveal').title = t($('btn-reveal').textContent);
  $('buffer').classList.toggle('link-mode', S.sourceType === 'link');
  renderSyncModeControl();
  syncPlaylistEditUi();
  // 换了一部：这一部收没收完、是不是链接，都可能让「能不能用外部播放器」翻面
  updatePlayerSwitchHint();
  $('btn-reopen')?.classList.toggle('hidden', S.mpvRunning || !S.filePath || !playbackAllowed());
}

/**
 * 渲染片名和元信息。
 *
 * 这个不能塞进 enterRoom：观众是先建立连接进房、之后才收到清单的，
 * 而 enterRoom 有个只跑一次的守卫。放在里面的话，观众进房时 manifest 还是 null，
 * 等清单到了又被守卫挡回去，结果房间头部永远是空的。
 */
function renderFilmInfo() {
  const mode = S.roomSecurityMode === 'trusted' ? '可信房间 · 边下边播' : '安全模式 · 扫描后播放';
  if (S.sourceType === 'link') {
    const info = S.linkInfo;
    // 片名是用户内容，标题栏不走自动翻译；兜底文案自己翻
    $('room-file').textContent = info?.title || S.current?.title || t('在线视频');
    if (!info) {
      $('room-meta').textContent = `视频链接 · 正在解析… · ${mode}`;
      return;
    }
    const duration = info.duration ? ` · ${fmtTime(info.duration)}` : '';
    $('room-meta').textContent = `视频链接 · ${info.extractor || 'direct'}${duration} · ${mode} · 每位成员从原网站播放`;
    return;
  }
  if (!S.manifest) {
    if (S.current?.kind === 'file') {
      // 列表已经告诉我放哪部了，清单还在路上
      $('room-file').textContent = S.current.name;
      $('room-meta').textContent = S.blockedFiles.has(S.current.fileId)
        ? `${fmtBytes(S.current.size)} · ${mode} · 这部片已被拒绝接收`
        : S.diskFull.has(S.current.fileId)
        ? `${fmtBytes(S.current.size)} · ${mode} · 本机磁盘放不下，这一部跳过`
        : `${fmtBytes(S.current.size)} · ${mode} · 正在获取清单…`;
    } else if (!S.current && S.playlist.rev > 0) {
      $('room-file').textContent = t('播放列表是空的');
      $('room-meta').textContent = mode;
    }
    return;
  }
  $('room-file').textContent = S.manifest.name;
  $('room-meta').textContent = `${fmtBytes(S.manifest.size)} · ${S.manifest.chunkCount} 片 × ${fmtBytes(
    S.manifest.chunkSize
  )} · ${mode} · ${S.isSeeder ? '你是片源' : '接收中'}`;
}

async function onLinkSessionReady() {
  if (!S.linkInfo) return;
  renderFilmInfo();
  refreshMediaUi();
  if (!S.syncStarted) {
    S.syncStarted = true;
    S.sync.start();
  }
  if (S.linkInfo.duration) S.sync.setMediaInfo({ duration: S.linkInfo.duration, size: 0 });
  await launchPlayer();
  renderProgress(S.swarm.progress());
}

/** 接收方：安全模式扫描后播放；可信房间达到片头水位即播放，完整后仍补做扫描。 */
function maybeLaunchPlayer(p) {
  if (S.mpvRunning || S.isSeeder || !S.filePath || !p || p.slot !== S.swarm?.playingSlot) return;
  // 用户在这一部上关掉了播放器（或起不来）：供片的 progress 不许再把它拉起来，等他点「重新打开」。
  // 换播放器的途中也不抢：那一次启动归 relaunchWithPlayer。
  if ((Number.isInteger(S.noAutoLaunchSeq) && S.noAutoLaunchSeq === S.currentSeq) || S.relaunchingPlayer) return;
  if (S.roomSecurityMode === 'trusted') {
    if (S.mediaSafety.status === 'trusted-streaming') return;
    const readyBytes = Math.min(HEAD_READY_BYTES, S.manifest?.size || HEAD_READY_BYTES);
    if (p.contiguousBytes < readyBytes || S.mediaSafety.status !== 'waiting-download') return;
    // 起播点不在片头（中途加入、或「回头接着放」）：片头够了只说明播放器认得出格式，
    // 它落脚的是起播点 —— 那里没有足够的连续数据，一起播就撞上连续区尽头。
    // 从片头起播（房间还在 0 秒）时片头够了就先把播放器打开，停在第一帧等房间开播；
    // 房间什么时候开播由就绪门槛（localReadyNow：还要从片头起够放 15 秒）决定。
    if (midJoinNow() && !p.complete) {
      const startByte = roomPlayheadByte();
      // 码率未知（片源没装 ffmpeg，清单里就没有时长）时换不出字节位置，
      // 判不了起播点附近有没有数据。这一部只能等收完再播。
      if (!(startByte > 0)) return warnMidJoinBlind();
      // MKV 的索引常在文件尾：网状房间里几个上游并行时，起播点附近那段可能比尾片先到齐
      if (tailIndexMissing(S.swarm.files.get(p.slot)) > 0) return;
      if ((p.runBytes || 0) < startRunNeeded(S.manifest?.size || 0, startByte)) return;
    }
    S.mediaSafety.status = 'trusted-streaming';
    log('可信房间已达到片头缓冲，正在边接收边播放；完整接收后仍会执行安全扫描。', 'warn');
    launchPlayer().then(() => window.sw.player.osd(t('可信房间 · 边下边播风险较高'), 3500));
    return;
  }
  if (p.complete && S.mediaSafety.status === 'clean') launchPlayer();
}

/**
 * 扫描期间的横幅文案。
 *
 * 大文件的扫描要几十分钟，而原来这里是一句一动不动的「正在进行安全扫描…」——
 * 看不出是在推进还是已经卡死。把已用时间和上限一起摆出来，等待才有个头。
 * 上限要等主进程把结果回来才知道（它按文件大小算），所以先只报已用时间。
 */
function scanProgressLabel() {
  const started = S.mediaSafety.scanStartedAt;
  if (!started) return '文件已接收，正在进行安全扫描…';
  return `文件已接收，正在进行安全扫描… 已用 ${fmtTime((Date.now() - started) / 1000)}`;
}

// 安全模式下扫描期间 mpv 根本没起来，没有 tick 来驱动重绘 —— 已用时间要自己走。
let scanTicker = null;
function setScanTicker(on) {
  if (on && !scanTicker) scanTicker = setInterval(renderStatus, 1000);
  else if (!on && scanTicker) {
    clearInterval(scanTicker);
    scanTicker = null;
  }
}

// 正在扫的会话。一次只扫一部：大文件的扫描很吃盘，几部一起扫谁都快不了。
let scanningSession = null;

/**
 * 列表里收完了、还没扫的片挨个扫。当前项永远排第一：它收完时，
 * 正在扫的别的片先让路（叫停后退回原状态，稍后重新排队）。
 */
function pumpScans() {
  if (!S.swarm || S.leaving) return;
  const candidates = [];
  S.playlist.queue.forEach((item, order) => {
    if (item.kind !== 'file') return;
    const sess = S.sessions.get(item.fileId);
    if (!sess || sess.slot !== item.slot) return;
    candidates.push({
      key: item.fileId,
      sess,
      order,
      current: S.current?.kind === 'file' && S.current.fileId === item.fileId,
      status: sess.safety.status,
      complete: S.swarm.files.get(sess.slot)?.complete === true,
      isSeeder: sess.isSeeder,
    });
  });
  const target = pickScanTarget(candidates);
  if (!target) return;
  if (scanningSession) {
    const running = { key: scanningSession.fileId, current: currentSession() === scanningSession };
    if (shouldPreempt(running, target) && !scanningSession.preempted) {
      scanningSession.preempted = true;
      log(`先扫正在放的这部，《${scanningSession.manifest.name}》稍后接着扫`);
      window.sw.store.cancelScan(scanningSession.sessionId).catch(() => {});
    }
    return;
  }
  verifyReceivedMedia({ session: target.sess });
}

/**
 * 扫描一部已经收完的片（默认是当前项）。force 是「重新扫描」按钮，只放行没扫完的两种，绕不过 blocked。
 */
async function verifyReceivedMedia({ force = false, session = currentSession() } = {}) {
  if (!session || session.isSeeder || S.sessions.get(session.fileId) !== session) return;
  const safety = session.safety;
  // 扫过的、确认扫不了的（unscanned）不再自动重扫：没必要每来一个进度事件就再启一遍 MpCmdRun。
  // 没扫完的（scan-timeout / scan-stopped）要等用户点「重新扫描」，否则每个进度事件都会
  // 自动重启一次几十分钟的扫描。
  if (!needsScan(safety.status, { force })) return;
  if (scanningSession) {
    // 扫描器被占着：重新扫描的请求先排上，轮到时由 pumpScans 叫起来
    if (force) safety.status = S.roomSecurityMode === 'trusted' ? 'trusted-streaming' : 'waiting-download';
    pumpScans();
    return;
  }
  scanningSession = session;
  session.preempted = false;
  const before = safety.status === 'trusted-streaming' ? 'trusted-streaming' : 'waiting-download';
  safety.status = 'scanning';
  safety.scanStartedAt = Date.now();
  safety.timeoutMs = 0;
  if (currentSession() === session) {
    setScanTicker(true);
    renderStatus();
    // 重新扫描时，就绪消息里的原因从「扫描器不可用 / 没扫完」换回「在做安全扫描」
    updateLocalReady();
  }
  renderPlaylistSoon();
  let result;
  try {
    result = await window.sw.store.scanReceivedMedia(session.sessionId);
  } catch (error) {
    result = { ok: false, status: 'error', message: error.message || String(error) };
  } finally {
    scanningSession = null;
    setScanTicker(false);
  }
  try {
    await applyScanResult(session, result, before);
  } finally {
    renderPlaylistSoon();
    updateLocalReady();
    pumpScans();
  }
}

/**
 * 扫描结果落到会话上，怎么处置由 scanPolicy 决定：只有 blocked 销毁缓存，其余一律保留文件。
 * 给当前项让路而被叫停的，不算「扫描已停止」，退回原状态等下次。
 */
async function applyScanResult(session, result, before) {
  if (S.leaving) return; // 正在离开房间：缓存马上要删，别再按扫描结果拉起播放器
  if (S.sessions.get(session.fileId) !== session) return; // 会话已经关了
  const safety = session.safety;
  if (session.preempted && result.status === 'cancelled') {
    session.preempted = false;
    safety.status = before;
    return;
  }
  session.preempted = false;
  const outcome = decideScanOutcome(result, S.roomSecurityMode);
  safety.timeoutMs = result.timeoutMs || 0;
  // 安全模式下「扫描器没跑起来」和「没扫完」记成同一个状态（都能重新扫描），
  // 就绪消息却要分开报：前者多半是 Defender 被第三方杀毒软件接管，重扫几遍都一样
  safety.unavailable = result.status === 'unavailable';
  if (outcome.destroy) {
    await blockScannedSession(session, result.message || '安全扫描未通过');
    return;
  }
  safety.status = outcome.status;
  maybeSaveDownload(session);
  const name = session.manifest.name;
  if (currentSession() !== session) {
    // 不是正在放的那部：记一笔，轮到它时直接用这个结果
    if (outcome.status === 'clean') log(`《${name}》安全扫描通过`, 'good');
    else log(`《${name}》没有扫完：${result.message || '安全扫描没能完成'}`, 'warn');
    return;
  }

  if (outcome.status === 'clean') {
    // 缓存什么时候清按文件真正在哪儿说：退房从来不删 —— 临时缓存关软件时清，长期缓存文件夹里的从不自动删
    const kept = !!session.persistent;
    // 用户在这一部上关掉过播放器（可信房间边下边播时）就不再替他拉起来；
    // 正在换播放器时那一次启动归 relaunchWithPlayer，这里不抢
    const dismissed = Number.isInteger(S.noAutoLaunchSeq) && S.noAutoLaunchSeq === S.currentSeq;
    const open = !S.mpvRunning && !dismissed && !S.relaunchingPlayer;
    log(
      !open
        ? kept
          ? '完整文件安全扫描通过；这部片存在长期缓存文件夹里，可在设置里清理'
          : '完整文件安全扫描通过；缓存在关软件时清掉'
        : kept
        ? '安全扫描通过，正在打开播放器；这部片存在长期缓存文件夹里，可在设置里清理'
        : '安全扫描通过，正在打开播放器；缓存在关软件时清掉',
      'good'
    );
    if (open) await launchPlayer();
    window.sw.player.osd(t(kept ? '安全扫描通过 · 已存进长期缓存文件夹' : '安全扫描通过 · 缓存关软件时清掉'), 2500);
    return;
  }

  // 扫描器没跑起来，而这是可信房间：这一场本来就是不等扫描就播的，只警告，不打断。
  if (outcome.status === 'unscanned') {
    log(`${result.message}。可信房间不因此中断播放，但这份文件始终没有经过本机扫描 —— 请自行确认片源可信。`, 'warn');
    window.sw.player.osd(t('未经本机扫描 · 请自行确认片源'), 4000);
    renderStatus();
    return;
  }

  // 没扫完（超时、被叫停、安全模式下扫描器不可用、扫描器出错）：文件已经逐片校验过，
  // 删掉它既不提升安全性，又得重下一遍。安全模式照旧拒播，但文件留着，可以重新扫描。
  const stopped = outcome.status === 'scan-stopped';
  const reason = result.message || '安全扫描没能完成';
  if (S.roomSecurityMode === 'trusted') {
    log(`${reason}。可信房间不因此中断播放，但这份文件没有扫完 —— 可以点「重新扫描」再来一遍。`, 'warn');
    window.sw.player.osd(t(stopped ? '扫描已停止 · 文件仍在' : '扫描没做完 · 文件仍在'), 4000);
  } else if (result.status === 'unavailable') {
    // 这一种有明确的下一步：Defender 被第三方杀软接管停用是最常见的诱因。
    // 房间模式由房主定、双方必须一致 —— 游客只改本机设置的话，下次连这个房间都进不来，得说全
    log(
      `${reason}。安全模式必须扫过才放行；你可以启用 Microsoft Defender，或改用可信房间（风险自负）—— 可信房间要房主开、每个人也在设置里选可信房间，双方一致才连得上。`,
      'bad'
    );
  } else {
    log(`${reason}。安全模式必须扫过才放行，先不打开播放器；文件还在，可以点「重新扫描」再来一遍。`, 'warn');
  }
  renderStatus();
}

/** 扫出威胁：正在放它就先退出播放器，再销毁缓存，这个房间里不再接收它。 */
async function blockScannedSession(session, message) {
  const current = currentSession() === session;
  const seq = S.currentSeq;
  session.safety.status = 'blocked';
  log(`已阻止打开接收文件：${message}`, 'bad');
  if (current) {
    // PlayerManager.quit 会先摘监听器，不会有 player:exit 回来：播放器状态只能在这里同步复位，
    // 不然界面一直当它开着（暂停时横幅报「已暂停」、进度条照样能点、时间按旧 tick 往前走）。
    // status 已经是 blocked，playbackAllowed() 不会放行，不怕被重新拉起。
    retirePlayer();
    $('btn-playpause').disabled = true;
    $('btn-reopen')?.classList.add('hidden');
  }
  // 等播放器真正放开文件再删缓存
  await S.playerQuit;
  await destroyBlockedSession(session);
  // 等待期间换了片：别动新一部的镜像
  if (!current || S.currentSeq !== seq) return;
  S.sessionId = null;
  S.filePath = null;
  S.manifest = null;
  renderFilmInfo();
  renderStatus();
}

/** 扫出威胁的片：销毁缓存，这个房间里不再接收它。 */
async function destroyBlockedSession(session, message = '') {
  S.blockedFiles.add(session.fileId);
  session.safety.status = 'blocked';
  if (S.sessions.get(session.fileId) === session) S.sessions.delete(session.fileId);
  if (message) log(`已阻止接收文件：${message}`, 'bad');
  announceGone(session.slot);
  if (session.slot !== null) S.swarm?.removeFile(session.slot);
  // discard：发现威胁的文件不留着复用，不管在临时缓存还是长期缓存文件夹都删掉
  await trackClosing(window.sw.store.close(session.sessionId, { discard: true }).catch(() => {}));
  scheduleTransferUpdate();
}

/**
 * 现在这个文件允不允许交给播放器。
 *
 * 这道门槛以前只长在各个调用方身上（onSessionReady / maybeLaunchPlayer /
 * verifyReceivedMedia），而「重新打开播放器」按钮直接绑的是 launchPlayer ——
 * 于是接收方一建好会话（S.filePath 立刻就有值）按钮就露出来了，点一下就把
 * 还没收完、更没扫过的稀疏缓存交给 mpv，安全模式的全部承诺当场作废。
 * 门槛必须长在函数里，调用方漏判也拦得住。
 */
function playbackAllowed() {
  if (S.isSeeder) return true; // 片源本地就有完整文件
  if (S.sourceType === 'link') return true; // 链接模式不经过接收缓存
  if (S.roomSecurityMode === 'trusted') {
    // 可信房间：达到片头水位或已扫描完成都算放行。
    // scan-timeout / scan-stopped 和 unscanned 是同一种处境 —— 文件没扫过。这一场
    // 本来就是没扫过播过来的，没扫完并没有带来任何新信息，所以「重新打开播放器」
    // 也该照样能点，否则等于说「边看可以，看完反而不许看了」。
    // scanning 也放行：可信房间本来就是不等扫描就播的，换回一部正在补扫的片不该被挡住。
    return ['trusted-streaming', 'clean', 'unscanned', 'scan-timeout', 'scan-stopped', 'scanning'].includes(
      S.mediaSafety.status
    );
  }
  // 安全模式：只有完整接收且扫描通过才行。没扫完一律不放行 —— 这个模式的全部承诺
  // 就是「扫过才放行」，但拒播不等于要把文件删掉，见 verifyReceivedMedia。
  return S.mediaSafety.status === 'clean';
}

/**
 * 拉起播放器。
 *
 * @param {{startAt?: number|null, relaunch?: boolean}} [opts] startAt 给「即时换播放器」用：那一路要接着
 *   旧播放器停下的地方放，而不是回到房间共识位置（两者可能差着一次刚做的跳转）。
 *   relaunch 只有 relaunchWithPlayer 自己传：换播放器途中只放行它这一次启动，失败了也由它自己退回 mpv。
 * @returns {Promise<boolean|'superseded'>} true 表示这一代真的起来了；false 是真失败；
 *   `'superseded'` 是「这次启动已经作废」（换片、拦下威胁、列表推进、正在离开房间、
 *   正在换播放器）—— 调用方绝不能把它当成失败去做补救，见 relaunchWithPlayer。
 */
async function launchPlayer({ startAt = null, relaunch = false } = {}) {
  // 离开房间的收尾里还有好几段 await（关会话、删缓存），扫描通过、做种交接完成都可能在这期间
  // 回来把播放器拉起来 —— 页面一刷新它就成了没人管的窗口，还占着刚要删的缓存。
  if (S.leaving) return 'superseded';
  // 换播放器途中（旧的已退、新的还没起来，S.mpvRunning 是 false）别人来起播：让位。
  // 抢先起来的那个会占住 S.mpvRunning，relaunchWithPlayer 自己那次就被挤成 false，
  // 被当成「新播放器起不来」—— 选择被改写成 mpv，日志报一次并没有发生的失败。
  // 让位不丢东西：relaunchWithPlayer 自己会起一个，起不来也会把「重新打开」露出来。
  if (!relaunch && S.relaunchingPlayer) return 'superseded';
  if (S.mpvRunning || !S.filePath) return false;
  if (!playbackAllowed()) {
    log(
      S.roomSecurityMode === 'trusted'
        ? '还没收到足够的片头，再等一会儿就能开播。'
        : '安全模式下要等文件完整接收并通过本机安全扫描后才能播放。',
      'warn'
    );
    return false;
  }
  const seq = S.currentSeq;
  // 用哪个播放器由这一部的处境决定：选了外部播放器但这一部还没收完，照旧交给 mpv
  const want = desiredPlayerKind();
  const name = playerName(want.kind);
  // 票据：启动期间播放器被叫退（换片、拦截、改做种）时，回包凭它认出自己已经作废
  const ticket = playerGate.begin();
  S.mpvRunning = true; // 先占位，防止 progress 事件密集时重复拉起
  lastMpvBanner = ''; // 新进程身上没有覆盖层，去重缓存要跟着清零
  let info = null;
  try {
    info = await window.sw.player.launch({
      filePath: S.filePath,
      startPaused: true,
      kind: want.kind,
      // 直接从房间此刻的位置起播，省得新进程先从片头解码一段再被拽过去
      startAt: startAt === null ? S.sync?.sharedPositionNow?.() || 0 : Math.max(0, startAt),
      headers:
        S.sourceType === 'link' && S.filePath === S.linkInfo?.playback?.url
          ? S.linkInfo.playback.headers || {}
          : {},
      // 播放器里按快捷键发弹幕时那个输入框的提示语。主进程不做翻译，按界面语言在这儿定。
      chatPrompt: t('弹幕：'),
    });
    // 认下这一代之后只收它的 tick / exit。seq 变了或票据作废，就不登记这一代
    const early = seq === S.currentSeq ? playerGate.confirm(info?.gen, ticket) : null;
    if (!early) {
      // 启动期间换了片（或播放器被叫退）：这个播放器已经作废，只退它自己，别误伤新一部的。
      // 这里报的是「作废」不是「失败」—— 换播放器那一路要靠这个区分，
      // 否则换片恰好撞上切换时，会被当成「新播放器起不来」，把选择改写成 mpv 并用上一部的位置起播。
      window.sw.player.quit(info?.gen).catch(() => {});
      return 'superseded';
    }
    S.playerKind = want.kind;
    S.playerFallback = want.reason;
    // 这一部又有播放器了（多半是用户点了「重新打开」）：之前「别自动拉起」的记号作废。
    // 必须排在下面补处理 early.exit 之前 —— 刚起来就退出的，还得重新记上
    if (S.noAutoLaunchSeq === seq) S.noAutoLaunchSeq = null;
    S.sync?.setPlayerCaps?.(info?.caps || {});
    $('btn-playpause').disabled = false;
    $('btn-reopen')?.classList.add('hidden');
    log(`${name} 已启动（先暂停着，等所有人就绪）`, 'good');
    renderPlayerControls();
    S.danmaku?.setActive(true);
    // 新进程从 0:00 起。播放器没起来时收到的 SYNC 全被「播放器未启动」吞掉了，
    // 这里必须把房间共识位置重放一遍，否则接收方和重开播放器的人都会
    // 独自停在片头，而房间里其他人早就播到中间了。
    S.sync?.resyncToShared?.();
    // 这一代在回包之前就推过来的事件（先记下了），现在补上
    if (early.tick) handlePlayerTick(early.tick);
    if (early.exit && playerGate.acceptExit(early.exit)) handlePlayerExit(early.exit);
    return true;
  } catch (e) {
    // 换片（或播放器被叫退）时旧的启动被打断是预期内的，不报错，也不算失败
    if (seq !== S.currentSeq || ticket !== playerGate.epoch) return 'superseded';
    S.mpvRunning = false; // 占位撤回，否则连「重新打开」也起不来
    $('btn-reopen')?.classList.remove('hidden');
    reportLaunchFailure(e, want.kind, name);
    // 外部播放器起不来：本次改用 mpv。换播放器那一路（relaunch）自己会退回 mpv，这里不抢着做
    if (!relaunch && fallsBackToMpv(want.kind, e)) return launchMpvInstead(startAt);
    // 起不来的这一部不再自动重试：供片的 progress 每来一条都会走 maybeLaunchPlayer，
    // 不挡的话每发出一片就重拉一次、报一遍错（单实例的 PotPlayer 还会把片子一遍遍塞给用户开着的窗口）
    S.noAutoLaunchSeq = seq;
    return false;
  }
}

/**
 * 外部播放器起播失败时，本次要不要改用 mpv。PLAYER_GONE 除外：那多半是 PotPlayer 的单实例设置
 * 把片子交给了用户已经开着的窗口 —— 他那边有画面，只是没接上同步，再拉一个 mpv 就是两个窗口一起出声。
 * 这种只在提示里给下一步（见 reportLaunchFailure）。
 */
function fallsBackToMpv(kind, error) {
  return kind !== 'mpv' && errCode(error) !== 'PLAYER_GONE';
}

/**
 * 外部播放器第一次起播就起不来（不是运行中切换）：本次改用 mpv，选择也改回 mpv ——
 * 和运行中切换失败、遥控断了那两路一样。不改的话扫描通过、下一部、「重新打开」都会照着选择
 * 再去拉它，每次都要等它超时、再报一遍同样的错，人一直晾在没有画面的房间里。
 *
 * 调用方刚把 S.mpvRunning 撤回，这里同步地改选择、再起一次（中间没有 await），
 * 别的起播请求插不进来；主进程那份配置的写入不用等。
 */
function launchMpvInstead(startAt) {
  S.playerChoice = 'mpv';
  Promise.resolve(window.sw.player.select('mpv'))
    .then(applyPlayerList)
    .catch(() => {});
  log('已改用 mpv 播放，播放器选择也改回了 mpv', 'warn');
  return launchPlayer({ startAt });
}

/* ------------------------------ 可切换播放器 ------------------------------ */

/** 名字兜底表。主进程的清单还没到（启动最初那一下）时也得能把下拉框画出来。 */
const PLAYER_NAMES = { mpv: 'mpv', pot: 'PotPlayer', mpc: 'MPC-BE' };
/** 不可用的原因：主进程只给代号，文字在这边生成，翻译也只在这边做。 */
const PLAYER_REASONS = {
  'not-found': '未找到',
  'bridge-missing': '桥接程序未构建',
  'windows-only': '只支持 Windows',
  streaming: '这一部还没收完',
  link: '在线链接只用 mpv 播放',
};
/** 换播放器时，本机位置和房间共识差多少以内算「本机更准」。 */
const PLAYER_SWITCH_TOLERANCE = 2;

const playerName = (id) => S.playerList.find((p) => p.id === id)?.name || PLAYER_NAMES[id] || String(id || '');
const playerReasonText = (code) => PLAYER_REASONS[code] || '不可用';

/**
 * 播放器错误的代号。
 *
 * 主进程把 err.code 写在 message 开头 —— Electron 的 IPC 传不了自定义属性，而且还会
 * 自己套一层「Error invoking remote method …」。所以既不能直接读 e.code，
 * 也不能回去嗅 message 里有没有「mpv」字样（有三个播放器之后那个判断必然出错，
 * 何况前缀里本来就带着通道名）。
 */
function errCode(error) {
  if (error && typeof error.code === 'string' && error.code) return error.code;
  const found = /\[([A-Z][A-Z_]*)\]/.exec(error?.message || '');
  return found ? found[1] : '';
}

/** 去掉代号前缀之后的正文，给「启动 X 失败：…」那一句用。 */
function errText(error) {
  const text = String(error?.message || error || '');
  const at = text.indexOf('] ');
  return at >= 0 ? text.slice(at + 2) : text;
}

/** 启动失败按代号分支。每个代号一句话，说清下一步该做什么，而不是把原始报错甩给用户。 */
function reportLaunchFailure(error, kind, name) {
  const code = errCode(error);
  if (kind === 'mpv' && (code === 'MPV_NOT_FOUND' || code === 'PLAYER_NOT_FOUND')) {
    log('没找到 mpv，无法播放。装好 mpv 后点右上角「重新检测」。', 'bad');
    showDepsHelp();
    return;
  }
  if (code === 'PLAYER_NOT_FOUND') return log(`没找到 ${name}，可以在控制条里指定它的路径`, 'bad');
  if (code === 'BRIDGE_MISSING') return log('桥接程序未构建（npm run build:bridge）', 'bad');
  if (code === 'PLAYER_ELEVATED') return log(`${name} 以管理员身份运行，NoxReel 遥控不了它`, 'bad');
  if (code === 'PLAYER_NO_HEADERS') return log(`${name} 打不开需要请求头的链接`, 'bad');
  if (code === 'PLAYER_DETACHED') return log(`${name} 脱离了遥控，请关掉它再重开`, 'bad');
  // 这一种不自动退回 mpv（见 fallsBackToMpv），下一步得说给用户听
  if (code === 'PLAYER_GONE' && kind !== 'mpv') {
    return log(
      `${name} 启动后立刻退出了，片子多半被它的单实例设置交给了已开着的窗口，那个窗口不跟房间同步。关掉它再点「重新打开播放器」，或在控制条里改用 mpv`,
      'bad'
    );
  }
  log(`启动 ${name} 失败：${errText(error)}`, 'bad');
}

/**
 * 这一部该用哪个播放器；不是选中的那个时，代号说明为什么。
 *
 * 外部播放器只接手已经收完的文件：P0 实测 PotPlayer 打开正在增长的文件会跳走并停止，
 * MPC-BE 的 mkv 直接卡死在片头边界。可信房间边下边播那一段照旧交给 mpv，收完之后
 * 控制条上会出现一键切换 —— 但不在播放中途自动换，黑一下再换个窗口比等着更难受。
 */
function desiredPlayerKind() {
  const want = S.playerChoice || 'mpv';
  if (want === 'mpv') return { kind: 'mpv', reason: '' };
  const entry = S.playerList.find((p) => p.id === want);
  if (!entry || !entry.available) return { kind: 'mpv', reason: entry?.reason || 'not-found' };
  // 在线链接只交给 mpv：mpv 的每一次网络请求都经本机过滤代理，跟随跳转、HLS 分片、
  // yt-dlp 解析出的地址都在连接那一刻查是不是内网。外部播放器没有按次指定代理的参数，
  // 会照着跳转去连局域网设备。主进程那边也会拒掉外部播放器打开远程源。
  if (S.sourceType === 'link') return { kind: 'mpv', reason: 'link' };
  if (!externalPlaybackReady()) return { kind: 'mpv', reason: 'streaming' };
  return { kind: want, reason: '' };
}

/** 当前这一部是不是「完整的一个文件」—— 外部播放器只接手这种。 */
function externalPlaybackReady() {
  // 在线链接只交给 mpv（见 desiredPlayerKind）。这里说「好了」的话，控制条会冒出
  // 「已收完 · 切换到 PotPlayer」，点了也换不过去
  if (S.sourceType === 'link') return false;
  if (S.isSeeder) return true; // 片源手里本来就是整部片
  return !!currentFileCtx()?.complete;
}

/** 问主进程要一份播放器清单（含不可用原因）。失败就当只有 mpv，不拦启动。 */
async function refreshPlayerList() {
  try {
    applyPlayerList(await window.sw.player.list?.());
  } catch {
    /* 探测失败：下拉框照样在，重开软件或改完路径再试 */
  }
}

function applyPlayerList(info) {
  if (!info) return;
  if (Array.isArray(info.players)) S.playerList = info.players;
  if (typeof info.selected === 'string') S.playerChoice = info.selected;
  renderPlayerControls();
}

let playerSelect = null;
let playerPickBtn = null;
let playerActual = null;

/** 控制条上的播放器下拉框 + 「指定路径…」+ 「当前实际使用：…」。 */
function renderPlayerControls() {
  const slot = $('player-slot');
  if (!slot) return;
  if (!playerSelect) {
    playerSelect = make('select', { className: 'player-pick', attrs: { 'aria-label': '播放器' } });
    playerSelect.addEventListener('change', () => switchPlayer(playerSelect.value));
    playerPickBtn = make('button', {
      className: 'ghost tiny player-pick-exe',
      text: '指定路径…',
      attrs: { type: 'button' },
    });
    playerPickBtn.addEventListener('click', () => pickPlayerExe(playerSelect.value));
    playerActual = make('span', { className: 'player-actual fine' });
    slot.replaceChildren(playerSelect, playerPickBtn, playerActual);
  }
  const list = S.playerList.length ? S.playerList : [{ id: 'mpv', name: 'mpv', available: true, reason: '' }];
  replace(
    playerSelect,
    list.map((p) =>
      make('option', {
        text: p.available ? p.name : `${p.name}（${playerReasonText(p.reason)}）`,
        attrs: { value: p.id },
      })
    )
  );
  playerSelect.value = S.playerChoice;
  playerSelect.disabled = S.switchingPlayer;
  // mpv 随安装包附带，没有「指定路径」这回事；不是 Windows 的话外部播放器压根没有
  const picked = list.find((p) => p.id === playerSelect.value);
  playerPickBtn.classList.toggle('hidden', playerSelect.value === 'mpv' || picked?.reason === 'windows-only');
  replace(playerActual, playerActualText());
  updatePlayerSwitchHint();
}

/**
 * 「当前实际使用：mpv（原因：这一部还没收完）」。
 *
 * 播放器已经在跑就说它此刻的实情（S.playerKind / S.playerFallback 是拉起它时定下的），
 * 而不是「现在重新起播会用哪个」—— 这一部收完之后，条件变了但窗口还是那个 mpv，
 * 照新条件说成「在用 PotPlayer」就是在骗人。没在跑时说的才是下一次起播的打算。
 * 选中的就是在跑的那个时不显示 —— 一行永远在的废话只会让人不再看它。
 */
function playerActualText() {
  const now = S.mpvRunning ? { kind: S.playerKind, reason: S.playerFallback } : desiredPlayerKind();
  if (now.kind === S.playerChoice) return '';
  return `当前实际使用：${playerName(now.kind)}（原因：${playerReasonText(now.reason)}）`;
}

// 「已收完 · 切换到 X」的 OSD 每一部只提一次，记的是提过的那一部的 seq
let switchHintSeq = -1;

/**
 * 可信房间边下边播那一段只能用 mpv。收完之后不自动换，在控制条上放一个按钮，
 * 顺手在 OSD 上提一次 —— 全屏看片时房间窗口整个看不见，控制条上的按钮等于不存在。
 */
function updatePlayerSwitchHint() {
  const btn = $('btn-switch-player');
  if (!btn) return;
  const entry = S.playerList.find((p) => p.id === S.playerChoice);
  const ready = Boolean(
    roomEntered &&
      S.mpvRunning &&
      !S.switchingPlayer &&
      !S.switchingMedia &&
      S.playerChoice !== 'mpv' &&
      entry?.available &&
      S.playerKind === 'mpv' &&
      externalPlaybackReady()
  );
  btn.classList.toggle('hidden', !ready);
  if (!ready) return;
  replace(btn, `已收完 · 切换到 ${entry.name}`);
  if (switchHintSeq === S.currentSeq) return;
  switchHintSeq = S.currentSeq;
  Promise.resolve(window.sw.player.osd(t(`已收完 · 切换到 ${entry.name}`), 4000)).catch(() => {});
}

/** 用户在下拉框里换了播放器。没在放的时候只记下选择，下一部自然就用它了。 */
async function switchPlayer(id) {
  if (S.switchingPlayer || !id || id === S.playerChoice) return;
  const previous = S.playerChoice;
  S.switchingPlayer = true;
  renderPlayerControls();
  try {
    applyPlayerList(await window.sw.player.select(id));
    if (S.mpvRunning) {
      // 新的选择不改变这一部实际用哪个（在线链接、边下边播还没收完、选的那个没找到，
      // 或者本来就因为这些原因在跑 mpv 又切回 mpv）：只记下选择，把「当前实际使用」那行的原因换成新的。
      // 白白重开一次 mpv 会黑一下、弹幕清空、退出全屏；在线链接还要重新解析、重新缓冲，
      // 控制者重开期间全房跟着等。启动还在途（代号没确认）时照旧重来：那一次用的是旧选择。
      const next = desiredPlayerKind();
      if (playerGate.gen !== null && next.kind === S.playerKind) S.playerFallback = next.reason;
      else await relaunchWithPlayer();
    }
  } catch (e) {
    S.playerChoice = previous;
    log(`切换播放器失败：${errText(e)}`, 'bad');
  } finally {
    S.switchingPlayer = false;
    renderPlayerControls();
  }
}

/**
 * 即时换播放器：不重启、不换片，把当前这一部原位交给另一个播放器。
 *
 * 位置从哪儿来：先取旧播放器的快照并按这一趟 IPC 的往返时间外推，和房间共识位置
 * 差不到 2 秒就用本机的（本机才知道用户刚刚拖到哪儿），差得多就以房间为准 ——
 * 那多半是本机这一路已经掉队了，再照着它起播等于把整个房间拽回去。
 */
async function relaunchWithPlayer() {
  const before = performance.now();
  const snap = await Promise.resolve(window.sw.player.snapshot()).catch(() => null);
  const elapsed = Math.min(1, Math.max(0, (performance.now() - before) / 1000));
  const local = Math.max(0, (snap?.position || 0) + (snap?.running && !snap?.paused ? elapsed : 0));
  const shared = S.sync?.sharedPositionNow?.() || 0;
  const startAt = Math.abs(local - shared) < PLAYER_SWITCH_TOLERANCE ? local : shared;
  // 旧播放器必须真的退干净再拉新的：两个窗口同时开着，声音会叠在一起
  const quitting = retirePlayer();
  // 从退旧的到起新的（含起不来时退回 mpv 那一次），起播归这里独占，别的起播请求让位（见 launchPlayer）。
  // 必须排在 retirePlayer 之后：它会把这个标记清掉 —— 期间换了片、拦下威胁、改做种都会再退一次
  // 播放器，这里那次启动随之作废，那时候就该轮到它们起播，否则新的一部永远没人拉起来
  S.relaunchingPlayer = true;
  try {
    await quitting;
    // 等旧的退出期间被别处又退了一次（换片、拦下威胁、改做种）：这次切换作废，起播轮到它们。
    // 照旧往下起的话，撞上它们刚占住的 S.mpvRunning 会被当成「新播放器起不来」
    if (!S.relaunchingPlayer) return false;
    // 上一个播放器屏幕上的弹幕不该飞到新窗口里
    S.danmaku?.clear();
    const launched = await launchPlayer({ startAt, relaunch: true });
    if (launched === true) return true;
    // 这次启动是被作废的（换片、拦下威胁、列表推进、正在离开房间），不是起不来：
    // 后面那一套补救全是错的 —— 会把主进程里的播放器选择写成 mpv、报一句「切换失败」，
    // 再拿上一部的位置去拉 mpv，正好盖掉刚换上的那一部。
    if (launched === 'superseded') return false;
    // 新播放器起不来：退回 mpv，别把人卡在一个没有画面的房间里
    if (S.playerChoice !== 'mpv') {
      await Promise.resolve(window.sw.player.select('mpv')).then(applyPlayerList).catch(() => {});
      S.playerChoice = 'mpv';
      log('切换失败，已回到 mpv', 'bad');
      if (!S.relaunchingPlayer) return false; // 同上：等的时候被换片之类作废了
      return (await launchPlayer({ startAt, relaunch: true })) === true;
    }
    return false;
  } finally {
    S.relaunchingPlayer = false;
  }
}

/**
 * 运行期的播放器错误（不是启动失败那一路）。
 *
 * 遥控一旦断了，这一路就再也控不回来：主进程仍以为播放器在跑、进度条还能拖，
 * 但命令全进黑洞，同步引擎的最后一条 tick 也就此冻住 —— 房间里其他人以为他在正常跟播。
 * 所以这几个代号必须当场退回 mpv，而不是只在日志里留一行
 * （MPC-BE 那条错误正文本身就写着「已退回 mpv」，不接这一步的话那句话是假的）。
 */
const PLAYER_FATAL_CODES = new Set(['PLAYER_ELEVATED', 'PLAYER_DETACHED', 'PLAYER_UNREACHABLE']);

/** 每个代号一句人话。说不出来的（代号是新的、或者干脆没有）才把原始正文摆出来。 */
function playerErrorText(code, name, message) {
  if (code === 'PLAYER_ELEVATED') return `${name} 以管理员身份运行，NoxReel 遥控不了它`;
  if (code === 'PLAYER_DETACHED') return `${name} 脱离了遥控`;
  if (code === 'PLAYER_UNREACHABLE') return `${name} 不再应答遥控`;
  if (code === 'PLAYER_FOREIGN_FILE') return `你在 ${name} 里打开了别的文件，这边已经不跟着它同步了`;
  return `播放器 ${name} 报错：${message}`;
}

function handlePlayerError({ message = '', code = '', kind = '', gen } = {}) {
  // 上一代播放器退出途中迟到的那条错误，不能算到刚起来的这一代头上
  if (Number.isInteger(gen) && playerGate.gen !== null && gen !== playerGate.gen) return null;
  const name = playerName(kind || S.playerKind);
  const text = playerErrorText(code, name, message);
  const external = (kind || S.playerKind) !== 'mpv';
  // 用户自己在播放器里开了别的片：那是他主动的操作，不该反过来把他的窗口关掉（退回 mpv 会发
  // WM_CLOSE）。但也不能继续把另一部片的位置当成这一部的 tick 报上去 —— 房主会据此广播 SYNC。
  // 所以只是撒手：不再跟着它同步，界面给一句话和「重新打开」的入口，要不要回来由他决定。
  if (code === 'PLAYER_FOREIGN_FILE' && external) {
    log(text, 'warn');
    detachFromPlayer(Number.isInteger(gen) ? gen : playerGate.gen);
    return null;
  }
  const fatal = PLAYER_FATAL_CODES.has(code) && external;
  log(fatal ? `${text}，正在退回 mpv` : text, 'bad');
  return fatal ? fallbackToMpv() : null;
}

/**
 * 撒手：这个播放器不再算我们的，但不去动它的窗口。
 *
 * 用在「用户自己在播放器里打开了别的文件」这一种：再往同步引擎喂它的 tick，
 * 报的就是另一部片的位置。停掉本机这一路，界面上留「重新打开」让用户自己决定回不回来。
 *
 * 主进程那一侧必须一起撒手（player:release）：只在这边停的话，PlayerManager 仍把它当当前播放器，
 * 同步引擎每次收敛发的播放/暂停、全员暂停横幅、缓冲 OSD 照样打到他自己开的那部片上，
 * 覆盖窗和快捷键也还跟着它；之后「重新打开」、换片、退房还会给这个窗口发 WM_CLOSE。
 * release 只放那一代（gen），不关窗口；已经显示在覆盖窗上的横幅随「播放器没了」一起清掉。
 */
function detachFromPlayer(gen = playerGate.gen) {
  playerGate.retire(); // 迟到的 tick / exit / error 一律作废，不必等进程退出
  const releasing = Promise.resolve(window.sw.player.release(gen)).catch(() => {});
  // 下一代要等桥上的登记撤干净（主进程那边也会等），关会话、删缓存照旧等它
  S.playerQuit = Promise.all([S.playerQuit, releasing]).then(() => {});
  S.mpvRunning = false;
  lastMpvBanner = '';
  S.danmaku?.setActive(false);
  S.sync?.playerGone?.();
  // 他在自己的窗口里看别的片：供片的 progress 不许再给这一部拉起一个新窗口，等他点「重新打开」
  S.noAutoLaunchSeq = S.currentSeq;
  $('btn-reopen')?.classList.remove('hidden');
  refreshMediaUi();
}

/**
 * 当前这一部原位交给 mpv，并把选择也改回 mpv。
 *
 * 不改选择的话，relaunchWithPlayer 会照着还没变的选择再拉一次那个遥控不了的播放器，
 * 白白让用户多看一次窗口闪烁。
 */
async function fallbackToMpv() {
  if (S.switchingPlayer || S.leaving || !S.mpvRunning) return false;
  S.switchingPlayer = true;
  renderPlayerControls();
  try {
    if (S.playerChoice !== 'mpv') {
      await Promise.resolve(window.sw.player.select('mpv')).then(applyPlayerList).catch(() => {});
      S.playerChoice = 'mpv';
    }
    return await relaunchWithPlayer();
  } catch (e) {
    log(`退回 mpv 失败：${errText(e)}`, 'bad');
    return false;
  } finally {
    S.switchingPlayer = false;
    renderPlayerControls();
  }
}

/** 让主进程弹对话框挑 exe。路径从头到尾不经过渲染进程，挑回来的还要过白名单。 */
async function pickPlayerExe(id) {
  if (!id || id === 'mpv') return;
  // 取消对话框时主进程原样把清单还回来。只有路径真的变了才报「已指定」——
  // 否则本来就探测到的那一个，点一下取消也会被夸奖一句，用户会以为自己改成功了。
  const before = S.playerList.find((p) => p.id === id)?.path || '';
  try {
    applyPlayerList(await window.sw.player.pickExe(id));
    const entry = S.playerList.find((p) => p.id === id);
    if (entry?.path && entry.path !== before) log(`已指定 ${entry.name} 的路径`, 'good');
  } catch (e) {
    log(`指定播放器路径失败：${errText(e)}`, 'bad');
  }
}

// 播放器那一侧的提示。每种只说一次 —— 快捷键被占、独占全屏这类处境不会自己变好，
// 每按一次就刷一行只会把日志淹掉。
const playerNoticed = new Set();
const PLAYER_NOTICES = {
  'exclusive-fullscreen': '独占全屏下看不到弹幕，切成无边框全屏就能看到',
  'hotkey-taken': 'Ctrl+Shift+D 被别的程序占用了，在播放器里发不了弹幕',
  'chat-unavailable': '这会儿弹不出输入条：播放器不在前台，或者正处于独占全屏',
};
window.sw.player.onNotice?.(({ code }) => {
  const text = PLAYER_NOTICES[code];
  if (!text || playerNoticed.has(code)) return;
  playerNoticed.add(code);
  log(text, 'warn');
});

/* ------------------------------- 邀请区 ------------------------------- */

function inviteMediaInfo() {
  if (S.sourceType === 'link' && S.linkInfo) {
    return { name: S.linkInfo.title || '在线视频', size: 0, kind: 'link' };
  }
  return { name: S.manifest?.name || '视频', size: S.manifest?.size || 0, kind: 'file' };
}

async function renderInvite() {
  const box = $('invite-body');

  if (S.role !== 'host') {
    replace(box, make('p', { text: '你是通过邀请加入的。要拉更多人进来，让发起者再生成一个邀请码。' }));
    renderInviteArea();
    return;
  }

  const capacityInput = make('input', {
    id: 'room-capacity',
    attrs: { type: 'number', min: 2, max: 16 },
    props: { value: String(S.roomCapacity) },
  });
  // 邀请链接和应答框在上面（inv-out，按步骤排），人数上限、连接方式这些少动的设置收在底下一行
  replace(
    box,
    make('div', { id: 'inv-out' }),
    make('div', { className: 'invite-settings' }, [
      make('span', {
        className: 'fine',
        text: S.roomSecurityMode === 'trusted'
          ? '当前：可信房间（边下边播，风险较高）。加入者也必须在本机选择可信房间。'
          : '当前：安全模式。成员完整接收并扫描通过后才播放。',
      }),
      make('div', { className: 'capacity-row' }, [
        make('label', { text: '房间人数上限', attrs: { for: 'room-capacity' } }),
        capacityInput,
        make('button', { className: 'ghost tiny', id: 'capacity-apply', text: '应用' }),
      ]),
      make('span', { className: 'fine', id: 'capacity-status' }),
      make('button', { className: 'ghost tiny', id: 'inv-relay', text: '房间链接（谁点谁进）' }),
      make('button', { className: 'ghost tiny', id: 'inv-manual', text: '一对一邀请（不经过第三方）' }),
      make('button', { className: 'ghost tiny', id: 'inv-server', text: '改用信令服务器' }),
    ])
  );

  $('inv-relay').onclick = () => inviteViaRelay();
  $('inv-server').onclick = inviteViaServer;
  // 包一层再调：直接当处理器挂上去的话，第一个实参就是 PointerEvent，
  // 会被当成 notice 原样渲染成「[object PointerEvent]」贴在邀请区顶上。
  $('inv-manual').onclick = () => inviteViaManual();
  $('capacity-apply').onclick = applyRoomCapacity;
  renderCapacityStatus();
  renderInviteArea();
  // 默认给房间链接：一条链接发到群里谁点谁进。连不上公共中继时它自己会退回一对一邀请。
  inviteViaRelay().catch((error) => {
    replace('inv-out', make('p', { text: error.message || String(error) }));
  });
}

/** 邀请区的一步：圆圈序号 + 标题 + 一句说明 + 一行控件。 */
function inviteStep(no, title, hint, controls) {
  return make('div', { className: `invite-step${no === 1 ? ' first' : ''}` }, [
    make('span', { className: 'step-no', text: String(no) }),
    make('div', { className: 'step-main' }, [
      make('div', { className: 'step-title', text: title }),
      ...(hint ? [make('div', { className: 'step-hint', text: hint })] : []),
      make('div', { className: 'step-row' }, controls),
    ]),
  ]);
}

/*
 * 邀请区在成员页里，不再单独占一个页签：
 * - 房主、房间里还没别人：整页就是邀请流程（三步）。
 * - 房主、已经有人：成员表底下常驻一行「还能再来 N 人 · 邀请下一位」，点开才展开邀请卡片。
 *   极简模式一条链接只能进一个人，所以每点一次都现生成一条；信令模式的码多人可用，直接展开就行。
 * - 观众：一句「让发起者再生成一个邀请码」。
 */
let inviteOpen = false;
/**
 * 邀请卡的代次。进房后默认先连公共中继（一两秒），这期间房主点了「一对一」或「信令服务器」，
 * 晚到的中继结果不许盖掉新的邀请卡，失败时也不许去关人家新建的连接。每种邀请方式开头领一个号，
 * 每次 await 之后对一下。
 */
let inviteGen = 0;
// 被「隐藏我的 IP」拦下的那张邀请卡：{ retry, gen }，见 inviteBlocked / retryBlockedInvite
let blockedInvite = null;

function renderInviteArea() {
  const card = $('invite-card');
  if (!card) return;
  const host = S.role === 'host';
  const others = connectedPeerCount();
  const left = Math.max(0, S.roomCapacity - others - 1);
  const lone = host && others === 0;
  const open = host && (lone || inviteOpen);
  card.classList.toggle('hidden', host && !open);
  card.classList.toggle('lone', lone);
  card.classList.toggle('guest', !host);
  $('invite-title').textContent = lone ? '把朋友拉进房间' : '邀请下一位';
  $('btn-invite-close').classList.toggle('hidden', !host || lone);
  $('invite-next').classList.toggle('hidden', !host || open || left === 0);
  $('invite-left').textContent = `还能再来 ${left} 人`;
  // 大家都走了又剩房主一个人：屏幕上那条链接早已用掉，给下一位现生成一条
  if (lone && roomEntered && !S.leaving && S.mode !== 'server' && !S.pendingManualPeer && $('inv-link')) {
    inviteViaManual().catch((error) => replace('inv-out', make('p', { text: error.message || String(error) })));
  }
}

function openInvite() {
  if (S.role !== 'host') return;
  selectRoomTab('peers', { byUser: true });
  inviteOpen = true;
  renderInviteArea();
  // 极简模式的邀请链接一条只能进一个人：上一条用掉之后 pendingManualPeer 会清空，给下一位现生成一条
  if (S.mode !== 'server' && !S.pendingManualPeer) {
    inviteViaManual().catch((error) => replace('inv-out', make('p', { text: error.message || String(error) })));
  }
  $('invite-card').scrollIntoView?.({ block: 'nearest' });
}

function closeInvite() {
  inviteOpen = false;
  renderInviteArea();
}

/** 顶栏上的房间药丸：连接状态 · 房间模式 · 人数（含自己）/ 上限。 */
function renderRoomPill(others = connectedPeerCount()) {
  const pill = $('pill-room');
  if (!pill) return;
  const mode = S.roomSecurityMode === 'trusted' ? '可信房间' : '安全模式';
  pill.textContent = `${others ? '已连接' : '等人加入'} · ${mode} · ${others + 1} / ${S.roomCapacity} 人`;
  pill.classList.toggle('waiting', !others);
}

function renderCapacityStatus() {
  const input = $('room-capacity');
  const status = $('capacity-status');
  if (input) input.value = String(S.roomCapacity);
  if (status) status.textContent = `当前 ${connectedPeerCount() + 1} / ${S.roomCapacity} 人（包含房主）`;
}

function applyRoomCapacity() {
  const next = clampCapacity($('room-capacity')?.value);
  const current = connectedPeerCount() + 1;
  if (next < current) {
    $('capacity-status').textContent = `当前已有 ${current} 人，人数上限不能低于当前人数。`;
    return;
  }
  S.roomCapacity = next;
  localStorage.setItem('sw.roomCapacity', String(next));
  S.signaling?.setMaxMembers(next);
  renderCapacityStatus();
}

/**
 * 「隐藏我的 IP」开着却没有可用中继：这次邀请不发，原因画在邀请卡上（也记进日志）。
 * 拦下了返回 true。retry 是「按同一种邀请方式再来一次」：设置里补好 TURN 之后由 retryBlockedInvite 调。
 */
function inviteBlocked(out, retry = null) {
  const blocked = relayOnlyBlocked();
  if (!blocked) return false;
  const line = make('p', { text: blocked });
  line.style.color = 'var(--danger)';
  replace(out, line);
  log(blocked, 'bad');
  blockedInvite = retry ? { retry, gen: inviteGen } : null;
  return true;
}

/**
 * 邀请卡被「隐藏我的 IP」拦下之后，在设置里补好了 TURN（保存设置、Cloudflare「验证并保存」、后台取到了账号）：
 * 按原来的邀请方式自动重来一次，不用房主自己猜该点哪个按钮。
 * 房主已经点了别的邀请方式（代次变了）就作废；中继还是没有、也没有账号可取的话不动它，免得日志里重复刷同一句。
 */
function retryBlockedInvite() {
  const pending = blockedInvite;
  if (!pending) return;
  if (pending.gen !== inviteGen || !roomEntered || S.role !== 'host' || S.leaving) {
    blockedInvite = null;
    return;
  }
  if (relayOnlyBlocked() && !turnFetchNeeded()) return;
  blockedInvite = null;
  Promise.resolve()
    .then(pending.retry)
    .catch((error) => replace('inv-out', make('p', { text: error?.message || String(error) })));
}

/**
 * 房间链接（默认的邀请方式）：一条链接谁点都能进，直到坐满。经公共 Nostr 中继交换握手，
 * 不需要自建服务器；视频照旧点对点直传。连不上任何中继时退回一对一邀请，这场照样能开。
 */
async function inviteViaRelay() {
  const out = $('inv-out');
  if (!out) return;
  const gen = ++inviteGen;
  replace(out, make('p', { text: '正在连接公共中继…' }));
  // 有人点了链接就要打洞：TURN 先备好。取账号那会儿房主可能已经改点了别的邀请方式
  if (turnFetchNeeded()) {
    await ensureTurnReady();
    if (gen !== inviteGen) return;
  }
  // 被「隐藏我的 IP」拦下就停在这里，也不退回一对一邀请 —— 那一样是建连接
  if (inviteBlocked(out, () => inviteViaRelay())) return;
  try {
    if (!S.signaling || S.signalTransport !== 'relay') {
      // 从信令服务器切过来：老的那条先关掉（已经建好的直连不受影响）
      S.signaling?.close();
      S.signaling = null;
      S.mode = 'server';
      // 这条连接用的中继（connectSignaling 里按同一份设置取）。设置房间进行中也能改，
      // 之后换链接、重画邀请时写进链接的必须还是这一组，否则加入的人去别的中继上找不到房主
      S.roomRelays = customRelays();
      // connectSignaling 在第一个 await 之前就把新连接挂到 S.signaling 上：先记下是哪一条，
      // 失败时只收拾自己这条 —— 连接中途房主改点了「信令服务器」，S.signaling 已经是人家的了
      const pending = connectSignaling(null, null, { secret: newRoomSecret(), isHost: true, hostId: S.peerId });
      const mine = S.signaling;
      try {
        await pending;
      } catch (e) {
        if (S.signaling === mine) {
          S.signaling?.close();
          S.signaling = null;
          S.signalTransport = null;
        }
        throw e;
      }
    }
    // 连中继那一两秒里房主改点了「一对一」：晚到的房间链接不许盖掉人家刚生成的邀请
    if (gen !== inviteGen) return;
    S.mode = 'server';
    await renderRelayInvite(out);
  } catch (e) {
    // 已经换了别的邀请方式：这次失败与它无关，别退回一对一去盖掉它
    if (gen !== inviteGen) return;
    const reason = e?.message || String(e);
    log(`连不上公共中继（${reason}），改用一对一邀请`, 'warn');
    return inviteViaManual(`连不上公共中继（${reason}），先用一对一邀请：一条链接只给一个人。`);
  }
}

async function renderRelayInvite(out) {
  const sig = S.signaling;
  const code = await encodeCode({
    k: 'relay',
    key: sig.secret,
    hk: sig.publicKey,
    from: S.peerId,
    maxMembers: S.roomCapacity,
    securityMode: S.roomSecurityMode,
    relays: S.roomRelays ?? null,
  });
  const link = shareLink(code, 'join');
  S.roomLink = link;
  replace(
    out,
    inviteStep(1, '复制房间链接，发到群里', '谁点开都能进，直到坐满人数上限；你离开房间后链接就失效了。', [
      make('textarea', { id: 'inv-code', attrs: { readonly: '', rows: 2 } }),
      make('button', { className: 'primary', id: 'inv-copy', text: '复制房间链接' }),
    ]),
    make('div', { className: 'relay-extra' }, [
      make('p', {
        className: 'fine',
        text: '经公共中继交换连接信息（加密），视频仍在你们之间直传。中继能看到连接者的 IP，看不到内容和片名。',
      }),
      make('button', { className: 'ghost tiny', id: 'inv-rekey', text: '换一条链接（旧的作废）' }),
    ])
  );
  // 房间链接只有一步，底下那步「人到齐后按播放」就是第 2 步
  setFinalInviteStep(2, '还有人要来？同一条链接接着发就行，不用重新生成。');
  $('inv-code').value = link;
  $('inv-copy').onclick = () => copyCode(link, $('inv-copy'), '复制房间链接');
  $('inv-rekey').onclick = async () => {
    const gen = inviteGen;
    try {
      const { left = [] } = (await S.signaling.rekey(newRoomSecret())) || {};
      if (gen !== inviteGen) return;
      await renderRelayInvite(out);
      log('房间链接换好了，旧链接已作废（已经在房里的人不受影响）', 'good');
      // 放行了、还一次都没和我连上的人拿不到新链接（可能是来占位的假身份），留在旧链接上进不来了
      if (left.length) log(`还在连接中的 ${left.join('、')} 没跟着换过来，要进房请把新链接发给他们`, 'warn');
    } catch (e) {
      log(`换链接失败：${e.message}`, 'bad');
    }
  };
  updatePresence();
}

async function inviteViaServer() {
  const out = $('inv-out');
  const gen = ++inviteGen;
  replace(out, make('p', { text: '正在连接信令服务器…' }));
  if (turnFetchNeeded()) {
    await ensureTurnReady();
    if (gen !== inviteGen) return;
  }
  if (inviteBlocked(out, () => inviteViaServer())) return;

  try {
    // 手上那条若是房间链接（公共中继）的，先关掉：S.roomId 只有信令服务器才有，
    // 复用它会拿一个 undefined 房间号编出一条谁也进不来的邀请码
    if (S.signaling && S.signalTransport !== 'ws') {
      // 经房间链接进来的人和我之间只有这条中继信令：关掉之后，他们的直连一旦断了就没法自动重连
      const viaLink = S.signalTransport === 'relay' ? Number(S.signaling.admittedCount) || 0 : 0;
      S.signaling.close();
      S.signaling = null;
      if (viaLink) log(`已停用房间链接：经它进来的 ${viaLink} 人之后和你断开的话没法自动重连，要重新发邀请`, 'warn');
    }
    if (!S.signaling) {
      S.mode = 'server';
      const room = randomRoomId();
      const url = S.settings.signalUrl;
      const pending = connectSignaling(url, room);
      const mine = S.signaling;
      try {
        await pending;
      } catch (e) {
        if (S.signaling === mine) {
          S.signaling?.close();
          S.signaling = null;
        }
        throw e;
      }
      if (gen !== inviteGen) return;
      S.roomId = room;
      // 房间号只在这台服务器上有效。设置里的地址房间进行中也能改，编码时不能再去读它
      S.roomSignalUrl = url;
    }
    // 复用手上那条信令时也得改回来：中间点过「一对一」的话 S.mode 还停在 'manual'，诊断会写成
    // 「极简（零服务器）」，「邀请下一位」还会按极简模式现生成一次性链接盖掉这个多人可用的邀请码
    S.mode = 'server';
    // 先前经一对一邀请、房间链接进来的人，服务器看不到：报上去，让它判满时算上
    syncOutsideSeats();

    const code = await encodeCode({
      k: 'room',
      url: S.roomSignalUrl,
      room: S.roomId,
      from: S.peerId,
      name: S.name,
      file: inviteMediaInfo(),
      maxMembers: S.roomCapacity,
      securityMode: S.roomSecurityMode,
    });
    if (gen !== inviteGen) return;

    // 信令模式的邀请码谁都能用、用几次都行：只有一步，「邀请下一位」时也不用重新生成
    replace(
      out,
      inviteStep(1, '复制邀请码，发给要来的人', '这个码多人可用、可重复使用；房间会一直开着直到你离开。', [
        make('textarea', { id: 'inv-code', attrs: { readonly: '', rows: 2 } }),
        make('button', { className: 'primary', id: 'inv-copy', text: '复制邀请码' }),
      ])
    );
    setFinalInviteStep(2, '还有人要来？这个邀请码接着发就行，不用重新生成。');
    // 发 https 跳转页形式：贴进 Discord 就是一条能点的链接，点开由 NoxReel 接住
    const link = shareLink(code, 'join');
    $('inv-code').value = link;
    $('inv-copy').onclick = () => copyCode(link, $('inv-copy'));
    log(`房间已开：${S.roomId}`, 'good');
  } catch (e) {
    if (gen !== inviteGen) return;
    const error = make('p', { text: e.message });
    error.style.color = 'var(--danger)';
    replace(
      out,
      error,
      make('p', {}, [
        '信令服务器没跑起来的话，可以在本机执行',
        make('code', { text: 'npm run signal' }),
        '，或者直接用下面的极简模式。',
      ])
    );
  }
}

/**
 * 极简模式邀请。一次只能拉一个人 —— 每个人都要单独走一遍 offer/answer。
 * 而且大家都只连到发起者（星型），彼此之间不互连。
 */
async function inviteViaManual(notice = '') {
  // 只有字符串才是提示语。挡住误当事件处理器挂上去的情况，别把对象渲染进界面。
  if (typeof notice !== 'string') notice = '';
  if (connectedPeerCount() + 1 >= S.roomCapacity) {
    const full = make('p', { text: `房间已满（${S.roomCapacity} 人）。请先调高人数上限。` });
    full.style.color = 'var(--danger)';
    replace('inv-out', full);
    return;
  }
  S.mode = 'manual';
  const out = $('inv-out');
  const gen = ++inviteGen;
  replace(out, make('p', { text: '正在收集网络候选地址（几秒钟）…' }));
  if (turnFetchNeeded()) {
    await ensureTurnReady();
    if (gen !== inviteGen) return;
  }
  if (inviteBlocked(out, () => inviteViaManual(notice))) {
    // 手上那条旧链接也作废：对方这时再发回应答，建起来的就是一条直连
    S.pendingManualPeer?.close?.();
    S.pendingManualPeer = null;
    return;
  }
  try {
    await createManualInvite(out, notice, gen);
  } catch (error) {
    if (gen !== inviteGen) return;
    // 生成失败不能停在「正在收集网络候选地址」上：把原因写出来，底下「重新生成邀请链接」随时能再点。
    // 上一条在 createManualInvite 开头就作废了，这一条又没生成出来 —— 手上没有能用的邀请。
    S.pendingManualPeer?.close?.();
    S.pendingManualPeer = null;
    const reason = error?.message || String(error);
    const failed = make('p', { text: `没能生成邀请链接：${reason}` });
    failed.style.color = 'var(--danger)';
    replace(out, failed);
    log(`生成邀请链接失败：${reason}`, 'bad');
  }
}

/** 极简模式邀请链接的实际生成：作废上一条、新建待加入的连接、收集候选、画出两步。 */
async function createManualInvite(out, notice, gen = inviteGen) {
  S.pendingManualPeer?.close();

  const peer = new Peer({
    peerId: `pending-${crypto.randomUUID().replaceAll('-', '').slice(0, 6)}`,
    name: '待加入',
    initiator: true,
    ...peerIce(),
    trickle: false,
  });
  // 这条邀请的编号，加入方原样写进应答码。房主重新生成过邀请、或者点开一条用过的旧应答时，
  // 应答对不上号就直接拒掉 —— 不然它会被套到眼下这条（可能已经发给别人的）邀请上，把它白白废掉
  peer.manualInviteId = randomId(6);
  S.pendingManualPeer = peer;

  const offer = await peer.createOffer();
  const code = await encodeCode({
    k: 'offer',
    from: S.peerId,
    name: S.name,
    sdp: offer,
    file: inviteMediaInfo(),
    maxMembers: S.roomCapacity,
    securityMode: S.roomSecurityMode,
    invite: peer.manualInviteId,
  });
  const link = shareLink(code, 'join');
  // 收集候选那几秒里房主改点了别的邀请方式：这条作废，别盖掉人家的邀请卡
  if (gen !== inviteGen) {
    if (S.pendingManualPeer === peer) S.pendingManualPeer = null;
    peer.close();
    return;
  }

  // 上一轮打洞失败时把原因带过来，别让用户对着一个「又生成了一条链接」发懵。
  // replace() 不过滤 null，所以空的时候给一个空数组，flat 之后自然消失。
  const noticeNode = notice ? make('p', { id: 'inv-notice', text: notice }) : [];
  if (notice) noticeNode.style.color = 'var(--warn)';

  // 一条链接只能进一个人，而且带着本机当前的网络地址，放久了会失效 —— 这两件事写在第一步上，
  // 省得房主把同一条链接发给两个人，或者隔半小时才发出去。
  replace(
    out,
    noticeNode,
    inviteStep(1, '复制邀请链接，发给其中一位', '一条链接只给一个人用，几分钟内有效；过期了重新生成一条即可', [
      make('a', { id: 'inv-link', className: 'invite-link', text: 'NoxReel 一键加入链接' }),
      make('button', { className: 'primary', id: 'inv-copy', text: '复制邀请链接' }),
    ]),
    inviteStep(2, '对方发回应答链接后，直接点开或粘贴到这里', '', [
      make('textarea', {
        id: 'inv-answer',
        attrs: { rows: 2, placeholder: '点开对方发回的 NoxReel 应答链接，或粘贴到这里' },
      }),
      make('button', { className: 'ghost', id: 'inv-accept', text: '完成连接' }),
    ]),
    make('p', { className: 'fine', id: 'inv-status' })
  );
  $('inv-link').href = link;
  $('inv-link').onclick = (event) => { event.preventDefault(); copyCode(link, $('inv-copy'), '复制邀请链接'); };
  $('inv-copy').onclick = () => copyCode(link, $('inv-copy'), '复制邀请链接');

  $('inv-accept').onclick = () => acceptManualAnswer($('inv-answer').value);
  setFinalInviteStep(3, '还有人要来？这位连上后，成员表底下会出现「邀请下一位」。');
}

/** 邀请卡最底下那步「人到齐后按播放」的序号和说明：一对一邀请是第 3 步，房间链接、信令码只有一步在前面。 */
function setFinalInviteStep(no, hintText) {
  const step = $('invite-step3');
  const num = step?.querySelector?.('.step-no');
  const hintEl = step?.querySelector?.('.step-hint');
  if (num) num.textContent = String(no);
  if (hintEl) hintEl.textContent = hintText;
}

const MANUAL_HANDSHAKE_TIMEOUT_MS = 45_000;

/**
 * 加入方等房主打开应答链接的时限，比房主那条长得多。
 *
 * 房主是在粘完应答之后才开始计时的，那时双方都拿到了对方的 SDP，45 秒足够打洞。
 * 加入方没有这个时刻可用：应答链接生成之后它就在探测了，而房主可能过好几分钟才
 * 粘贴。也就是说加入方分不清「房主还没粘」和「粘了但没打通」，时限只能给足人去
 * 转发链接的时间，文案也不能把话说死，两种可能都要说给用户。
 */
const MANUAL_JOIN_WAIT_TIMEOUT_MS = 180_000;

/**
 * 盯住极简模式的最后一步，给它一个结局。
 *
 * 打洞可能一直连不上：对方在严格 NAT 后面，或者邀请链接放太久 —— 里面的候选地址
 * 对应的 NAT 映射早就过期了。这两种情况 ICE 都会长时间停在 checking，而「正在打洞」
 * 这行字以前只有 peer-authenticated 一条路能改，失败时没有任何人来收尾，
 * 界面就永远停在那里。这里补上失败和超时两条路，并顺手备好新的邀请链接。
 */
function watchManualHandshake(peer, status) {
  let settled = false;

  const finish = (rawText, { retry = false } = {}) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    offAuthenticated();
    offFailed();
    offClosed();
    // 候选诊断往往能把「对方可能在严格 NAT 后面」换成一句确定的结论。
    // 只在失败路径上加，连上时那句「已连上 ✓」不该跟一堆诊断。
    const advice = retry ? connectionAdvice(peer) : null;
    const text = advice?.text ? `${rawText}\n诊断：${advice.text}` : rawText;
    if (!retry) {
      if (status?.isConnected) status.textContent = text;
      // 连上了：这条链接已经用掉，邀请卡片收起来，换成成员表底下一行「邀请下一位」
      if (peer.authenticated) {
        inviteOpen = false;
        renderInviteArea();
      }
      return;
    }
    // 失效的连接留在 swarm 里只会占着成员位；清掉再生成一条新链接，
    // 原因写在新链接上方，用户可以立刻重发。
    S.swarm.removePeer(peer.peerId);
    log(text, 'warn');
    inviteViaManual(text).catch((error) => {
      if (status?.isConnected) status.textContent = error.message || String(error);
    });
  };

  const timer = setTimeout(
    () =>
      finish(
        '打洞一直没成功：对方可能在严格 NAT 后面，也可能是邀请链接放太久、里面的网络地址已经过期。已经给你备好一条新的邀请链接，重发一次试试；还是不行就在设置里配一个 TURN 中继。',
        { retry: true }
      ),
    MANUAL_HANDSHAKE_TIMEOUT_MS
  );

  const offAuthenticated = S.swarm.on('peer-authenticated', (authenticatedPeer) => {
    if (authenticatedPeer !== peer) return;
    finish(`${peer.name} 已连上 ✓`);
  });
  const offFailed = peer.on('failed', () =>
    finish('直连没建立起来。已经给你备好一条新的邀请链接，重发一次试试；双方都在严格 NAT 后面时需要在设置里配 TURN 中继。', {
      retry: true,
    })
  );
  const offClosed = peer.on('close', () => {
    if (peer.authenticated) return; // 已经进过房间的人断开，走成员列表那套，不是握手失败
    // 版本不符：换一条邀请链接也连不上，只把原因说清楚
    if (peer.versionMessage) {
      finish(peer.versionMessage);
      return;
    }
    finish('连接在握手完成前就断了。已经给你备好一条新的邀请链接，重发一次试试。', { retry: true });
  });
}

async function acceptManualAnswer(rawInput) {
  const raw = String(rawInput || '').trim();
  if (!raw) return;
  const status = $('inv-status');
  const peer = S.pendingManualPeer;
  if (!peer) {
    // 应答链接被点开两次，或者这条邀请已经作废（超时后重新生成过）。
    // 以前这里直接 throw，落在没人接住的地方，界面上什么都不会发生。
    const message = '这条邀请已经用过或已失效，请用当前这条邀请链接重新走一遍。';
    if (status?.isConnected) status.textContent = message;
    else if (roomEntered) log(message, 'warn');
    else $('join-err').textContent = message;
    return;
  }
  let registered = false;
  try {
    const payload = await decodeCode(raw);
    if (payload.k !== 'answer') throw new Error('这不是应答码');
    if (payload.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        payload.protocolVersion < PROTOCOL_VERSION
          ? '对方是旧版 NoxReel（0.6.x），和 0.7 不互通。请让他升级到 0.7 再加入。'
          : '对方用的是更新版本的 NoxReel，和本机不互通。请先升级本机的 NoxReel。'
      );
    }
    // 应答对应的是之前那条邀请（手动重新生成过，或者点开了一条用过的旧应答）：
    // 套到眼下这条上必然连不上，还会把它废掉，连带作废已经发给别人的邀请。
    // 旧版本发来的应答没有编号，照旧收
    if (payload.invite && payload.invite !== peer.manualInviteId) {
      throw new Error('这是上一条邀请的应答，和眼下这条邀请对不上，已忽略；当前的邀请链接照常有效。请让对方用当前这条邀请链接重新生成应答。');
    }
    if (normalizeSecurityMode(payload.securityMode) !== normalizeSecurityMode(S.roomSecurityMode)) {
      throw new Error(
        `对方选择的是${securityModeLabel(payload.securityMode)}，本房间是${securityModeLabel(S.roomSecurityMode)}。双方需分别选择相同模式。`
      );
    }
    // 应答码里的 from 是对面自称的身份，不能照单全收。
    // syncEngine 的全部权限判断都以 peerId 为准，被邀请者只要把 from 填成房主的
    // peerId，就会在房主这台机器上被判成 role='host'，直接拿走控场权。
    const claimed = String(payload.from || '');
    if (!/^[A-Za-z0-9._-]{6,128}$/.test(claimed)) throw new Error('应答码里的身份标识不合法');
    if (claimed === S.peerId) throw new Error('应答码里的身份和你自己相同，已拒绝');
    if (S.hostId && claimed === S.hostId) throw new Error('应答码冒用了房主的身份，已拒绝');
    if (S.swarm?.peers?.has(claimed)) throw new Error('这个身份已经在房间里了，已拒绝');
    peer.peerId = claimed;
    peer.name = peerName(payload.name, '观众');
    wirePeer(peer);
    S.swarm.addPeer(peer);
    registered = true;
    S.pendingManualPeer = null;
    watchManualHandshake(peer, status);
    await peer.acceptAnswer(payload.sdp);
    if (status?.isConnected) status.textContent = '正在打洞并校验房间模式…';
    show('view-room');
  } catch (error) {
    if (registered) S.swarm.removePeer(peer.peerId);
    // 登记之后再出错的话，看门狗已经把邀请区重画了，原来那个状态节点是游离的，
    // 写进去谁也看不见 —— 这种情况把原因落到房间日志里。
    const message = error.message || String(error);
    if (status?.isConnected) status.textContent = message;
    else if (roomEntered) log(message, 'bad');
    else $('join-err').textContent = message;
  }
}

/* ------------------------------- 渲染 ------------------------------- */

function stat(label, value) {
  return make('span', {}, [make('b', { text: label }), ` ${value}`]);
}

function kv(label, value) {
  return make('div', { className: 'kv-row' }, [make('span', { text: label }), make('span', { text: value })]);
}

/** 进度条下面的图例：色块 + 带数值的一句话。 */
function legendItem(kind, text) {
  return make('span', { className: `legend-item ${kind}` }, [make('i'), make('span', { text })]);
}

function renderProgress(p) {
  if (!p) return;

  if (S.sourceType === 'link') {
    $('buf-have').style.width = '100%';
    // 起点也要归零：从本地片子换过来时它还停在上一部的播放位置，起点加上 100% 宽就伸出边框了
    $('buf-safe').style.left = '0%';
    $('buf-safe').style.width = '100%';
    const snap = S.sync?.lastTick;
    const playRatio = snap && S.sync.duration ? Math.min(1, (snap.position || 0) / S.sync.duration) : 0;
    $('buf-head').style.left = `${(playRatio * 100).toFixed(2)}%`;
    const manual = linkFollowMode() === 'manual';
    replace(
      'buffer-stats',
      stat('来源', '原始视频网站'),
      stat('同步', isRoomHost() ? '大家以你的进度为准' : manual ? '手动同步，差开了只提示' : '完全同步，差开了自动对齐'),
      // 完全同步的控制者缓冲时全房等他；游客和手动同步的人只卡自己
      stat('缓冲', !manual && S.sync?.canIControl() ? '你缓冲时全员等你' : '各自的 mpv 管，只卡自己')
    );
    replace(
      'transfer-stats',
      kv('视频传输', '原网站 → 每位成员'),
      kv('房间消息', 'P2P 加密直连'),
      kv('连接数', S.swarm.peers.size),
      kv('模式', connectionModeLabel())
    );
    return;
  }

  if (!S.manifest) return;

  $('buf-have').style.width = `${(p.ratio * 100).toFixed(2)}%`;
  // 绿色画的是「从播放位置起不用等的那一段」（runBytes），不是从文件头起的完整度 ——
  // 中途加入的人文件头往后是一大段空洞，按完整度画的话绿色永远贴在最左边，和他的处境对不上。
  const size = S.manifest.size || 1;
  const runStart = Math.max(0, Math.min(size, p.playbackByte ?? 0));
  const runBytes = Math.max(0, Math.min(size - runStart, p.runBytes ?? p.contiguousBytes ?? 0));
  $('buf-safe').style.left = `${((runStart / size) * 100).toFixed(2)}%`;
  $('buf-safe').style.width = `${((runBytes / size) * 100).toFixed(2)}%`;

  const snap = S.sync?.lastTick;
  const playRatio =
    snap && S.sync.duration ? Math.min(1, (snap.position || 0) / S.sync.duration) : 0;
  $('buf-head').style.left = `${(playRatio * 100).toFixed(2)}%`;

  drawChunkMap();

  // 图例直接带上数：三种颜色各代表多少，不用读的人自己去猜
  const bitrate = currentFileCtx()?.scheduler.bytesPerSecond || 0;
  const position = S.sync?.status().position || 0;
  replace(
    'buffer-stats',
    legendItem('play', position > 0 ? `播放到 ${fmtTime(position)}` : '还没开始'),
    legendItem(
      'safe',
      p.complete
        ? '整部都在本机，不用等'
        : bitrate > 0
        ? `不用等还能放 ${fmtTime(runBytes / bitrate)}`
        : `从当前位置可连续播放 ${fmtBytes(runBytes)}`
    ),
    legendItem('have', `已收到 ${(p.ratio * 100).toFixed(1)}%（${p.haveCount}/${p.chunkCount} 片）`)
  );

  renderTransferVerdict(p);

  replace(
    'transfer-stats',
    kv('已收', fmtBytes(p.received)),
    kv('已发', fmtBytes(p.sent)),
    kv('下行', fmtRate(p.downRate)),
    kv('在途', `${p.inflight} 片`),
    kv('连接数', S.swarm.peers.size),
    kv('模式', connectionModeLabel())
  );

  // 播放位置告诉调度器，它据此决定先下哪些片。播放器还没起来时用房间位置 ——
  // 中途加入的人正是在这段时间里要把带宽花在 P 附近，而不是从文件头顺着下。
  const ctx = currentFileCtx();
  if (ctx?.scheduler) {
    const byte = snap
      ? ctx.scheduler.positionToByte(snap.position || 0, snap.streamPos) || 0
      : roomPlayheadByte();
    S.swarm.setPlaybackByte(ctx.slot, byte);
  }
}

/**
 * 传输诊断：把「这个片子需要多少码率」和「实际收多快」摆在一起。
 *
 * 文件码率 = 文件大小 ÷ 时长，也就是 scheduler.bytesPerSecond —— 直接复用它，
 * 不重写第二遍同一个公式。起播后 mpv 报真时长，起播前用清单里房主带来的 durationSec。
 * 追不上就早点说，别让人对着一个反复卡住的进度条猜原因。
 *
 * 码率、当前速度、房主上行三个数一律用 Mbps，放在一起才比得出结论。
 * 「会不会卡」看的不只是速度够不够：已经缓冲了大半部片子的人，速度掉到码率以下
 * 也不会卡 —— forecastStall 会把这种情况区分出来。
 */
function renderTransferVerdict(p) {
  const node = $('buf-verdict');
  if (!node) return;
  if (servingCurrent()) {
    renderHostVerdict();
    return;
  }
  node.className = 'buffer-verdict';

  if (p.complete || !S.manifest || S.sourceType === 'link') {
    node.classList.add('hidden');
    return;
  }

  const need = currentFileCtx()?.scheduler.bytesPerSecond || 0;
  const rate = p.downRate || 0;
  const parts = [];

  if (S.roomSecurityMode === 'trusted') {
    // 还没起播：播放器没起来；或者从片头起播、播放器已经停在第一帧，房间还在等我够上就绪门槛
    const awaitingStart = !S.mpvRunning || (!S.playlist?.started && S.sync?.localReady === false);
    if (awaitingStart) {
      // 和就绪门槛（localReadyNow）同一个起播点：房间还在片头时就是文件头 0
      const midJoin = midJoinNow();
      const startByte = midJoin ? roomPlayheadByte() : 0;
      if (midJoin && !(startByte > 0)) {
        // 中途加入却算不出房间播到第几个字节（清单里没有时长）：这一部只能等收完，
        // 再报「距起播还差 0」就是在骗人。见 warnMidJoinBlind()。
        const remaining = Math.max(0, Math.round((1 - p.ratio) * S.manifest.size));
        parts.push(stat('片源没提供时长 · 完整接收后才播，还剩', fmtBytes(remaining)));
        if (rate > 0) parts.push(stat('预计还需', fmtTime(remaining / rate)));
      } else {
        // 片头 8MB 之外还要从起播点起够放 15 秒。中途加入时片头早就够了，还差的是起播点附近
        // 那一段 —— 只报片头会一直显示「还差 0」；从片头起播时两段是同一段，取大的那个。
        const headLeft = Math.max(0, Math.min(HEAD_READY_BYTES, S.manifest.size) - p.contiguousBytes);
        const run = midJoin ? p.runBytes || 0 : p.contiguousBytes || 0;
        const runLeft = Math.max(0, startRunNeeded(S.manifest.size, startByte) - run);
        // 起播点在片中时文件尾的索引也在门槛里，缺着的话别报「还差 0」
        const left = Math.max(headLeft, runLeft) + (midJoin ? tailIndexMissing(currentFileCtx()) : 0);
        parts.push(stat(midJoin && runLeft > headLeft ? '距起播还差（当前位置附近）' : '距起播还差', fmtBytes(left)));
        if (rate > 0) parts.push(stat('预计还需', fmtTime(left / rate)));
      }
    }
  } else {
    // 安全模式要等整片收完再扫描，这件事得说在前面，不然只会觉得「怎么一直不播」。
    const remaining = Math.max(0, Math.round((1 - p.ratio) * S.manifest.size));
    parts.push(stat('安全模式 · 完整接收后才播，还剩', fmtBytes(remaining)));
    if (rate > 0) parts.push(stat('预计还需', fmtTime(remaining / rate)));
  }

  parts.push(stat('文件码率', need > 0 ? fmtMbps(need) : '未知'));
  parts.push(stat('当前速度', fmtMbps(rate)));
  if (S.manifest.sourceUplinkBps > 0) parts.push(stat('片源上行（预估）', fmtMbps(S.manifest.sourceUplinkBps)));

  // 安全模式收完才播，不存在中途卡顿，上面的「还剩 / 预计还需」就是全部要说的。
  if (need > 0 && rate > 0 && S.roomSecurityMode === 'trusted') {
    // 播放位置往后还缺的各段：第一个空洞后面已经收齐的那段不算要等的（中途加入后往回拖时常见）
    const holes = S.swarm.missingAhead(p.slot);
    const forecast = forecastStall({
      size: S.manifest.size,
      bitrate: need,
      rate,
      contiguous: p.runEndBytes,
      playhead: roomPlayheadByte(),
      holes,
    });
    if (forecast.level === 'stall') {
      node.classList.add('bad');
      parts.push(make('span', { text: '当前速度追不上这个码率，边下边播会反复卡住；建议房主改用无损精简后的文件' }));
      if (forecast.stallInSec >= 1) parts.push(stat('还能流畅播', fmtTime(forecast.stallInSec)));
      // 「会卡」只说了坏消息。真正能拿来做决定的是「先等多久就不卡了」——
      // 等这一会儿，之后整部片子一次也不用再等。
      const lead = bufferLead({
        size: S.manifest.size,
        bitrate: need,
        rate,
        contiguous: p.runEndBytes,
        playhead: roomPlayheadByte(),
        holes,
      });
      if (lead && lead.waitSec > 0 && Number.isFinite(lead.waitSec)) {
        parts.push(
          make('span', {
            text: `再缓冲 ${fmtTime(lead.waitSec)} 可一路看完，届时手上有 ${fmtTime(lead.bufferSec)} 的画面`,
          })
        );
      }
    } else if (forecast.level === 'thin') {
      node.classList.add('warn');
      parts.push(
        make('span', {
          text: forecast.finishSec != null ? '速度低于码率，但缓冲够撑到收完' : '余量很薄，网络一抖就会卡',
        })
      );
    } else if (forecast.level === 'ok') {
      parts.push(make('span', { text: '速度充足，可稳定边下边播' }));
    }
  }

  if (!parts.length) {
    node.classList.add('hidden');
    return;
  }
  replace(node, ...parts);
}

/** 画分片位图。空洞在这里一眼可见 —— 「下了 90% 却播不了」就是这么来的。 */
function drawChunkMap() {
  const cv = $('buf-map');
  const have = currentFileCtx()?.have;
  if (!cv || !have) return;

  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (!w || !h) return;
  if (cv.width !== w) cv.width = w;
  if (cv.height !== h) cv.height = h;

  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  // 深蓝：已经收到的分片。断开的地方就是还没收到的
  ctx.fillStyle = '#2d5a80';

  const n = have.length;
  const scale = w / n;
  let runStart = -1;

  // 连续段合并成一条画，比一片一格快得多（10GB 有 5120 片）
  for (let i = 0; i <= n; i++) {
    const on = i < n && have[i] === 1;
    if (on && runStart === -1) runStart = i;
    else if (!on && runStart !== -1) {
      ctx.fillRect(runStart * scale, 0, Math.max(1, (i - runStart) * scale), h);
      runStart = -1;
    }
  }
}

const ROLE_LABEL = { host: '房主', admin: '管理员', guest: '游客' };

/** 成员表上的设备标记。系统名是专有名词，不翻译；老版本电脑端只报得出「电脑」。 */
const PLATFORM_LABEL = { windows: 'Windows', mac: 'macOS', linux: 'Linux', android: 'Android', desktop: '电脑' };

/** 本机在 HELLO 里报的平台。主进程的 env 还没到时只能笼统报「电脑」。 */
const myPlatform = () => platformOfOs(S.env?.platform);

/**
 * 房间里每个人的显示名：重名的临时编号（「小明 #2」），只影响显示，不改谁存着的昵称。
 * 算的是自己 + 握过手的直连成员，成员表列的就是这一拨；聊天、就绪名单、卡顿提示都按 id 查同一张表，
 * 所以那里的「小明 #2」和成员表里的是同一个人。星型房间里经房主转来的其他观众不是直连成员、不在表里，
 * 这几处都退回他自己报的名字（不编号）。
 */
function roomDisplayNames() {
  const members = [{ id: S.peerId, name: S.name || '' }];
  for (const p of S.swarm?.peers.values() || []) {
    if (p.authenticated) members.push({ id: p.peerId, name: p.name || '' });
  }
  return numberDuplicateNames(members);
}

/**
 * 改自己的昵称：存在这台电脑上（下次打开还是它），进了房的话告诉连着的人。
 * @returns {boolean} 名字能用（清洗后非空）
 */
function applyMyName(raw) {
  const name = clampName(raw);
  if (!name) return false;
  const changed = name !== S.name;
  S.name = name;
  try {
    localStorage.setItem('sw.name', name);
  } catch {
    /* 存不进去就只在这一次生效 */
  }
  if (!changed) return true;
  S.swarm?.setName(name);
  S.sync?.setName(name);
  if (roomEntered) {
    log(`你改名为 ${name}`, 'good');
    renderPeersSoon();
    renderChat();
  }
  return true;
}

/** 成员表里自己那一行的「改名」。 */
function openRenameModal() {
  const input = make('input', { attrs: { type: 'text', maxlength: 40 }, props: { value: S.name } });
  const error = make('div', { className: 'field-error hidden', text: '昵称不能为空' });
  openModal({
    title: '改昵称',
    body: [
      field('你的昵称', input),
      error,
      hint('只保存在这台电脑上。房间里有人同名时，名字后面会临时加上编号。'),
    ],
    okText: '保存',
    onOk: () => {
      if (applyMyName(input.value)) return true;
      error.classList.remove('hidden');
      return false;
    },
  });
  setTimeout(() => input.focus?.(), 0);
}

/** 成员名后面那个设备标记。平台是对端自己报的，只拿来显示；标记单独一个元素，不拼进昵称。 */
function platformChip(platform) {
  const key = normalizePlatform(platform);
  return make('span', { className: `peer-os ${key}`, text: PLATFORM_LABEL[key] });
}

/* ------------------------------ 卡顿预判 ------------------------------ */

// 每个成员一个速度计，按「对方已有字节」随时间的增长算他从所有来源收片的总速度。
const intakeMeters = new Map();
// 最近一轮算出的每人预判。房主面板汇总时直接用，免得同一轮把速度计采样两遍。
let lastForecasts = new Map();

/** 当前片子的码率（字节/秒）。起播后用 mpv 报的真时长，之前用清单里房主带来的。 */
function mediaBitrate() {
  if (!S.manifest || S.sourceType === 'link') return 0;
  const duration = S.sync?.duration > 0 ? S.sync.duration : S.manifest.durationSec;
  return bitrateOf(S.manifest.size, duration);
}

/**
 * 房间当前播放到的秒数。播放器起来了就用它报的位置，否则用房间时钟。
 * 「这一部是不是从片头开始放」只能问它 —— 换算成字节的那个数在码率未知时恒为 0，
 * 拿它当判据会让整套中途加入的门槛静默失效（房主没装 ffmpeg 时清单里就没有时长）。
 */
function roomPositionSec() {
  const snap = S.sync?.lastTick;
  if (snap) return Math.max(0, snap.position || 0);
  return Math.max(0, S.sync?.sharedPositionNow?.() || 0);
}

/** 起播点不在片头（中途加入，或「回头接着放」从 resumeAt 起）。 */
function midJoinNow() {
  return roomPositionSec() > 0;
}

/**
 * 房间当前播放到的字节位置。mpv 的 stream-pos 最准；拿不到时按码率从时间折算。
 *
 * 播放器还没起来时不能返回 0：中途加入的人正是在这段时间里要按房间位置 P 去调度、
 * 判起播和判卡顿，返回 0 会让他一路去补文件头，并且以为自己「余量充足」。
 * 码率未知（清单里没有时长）时折算不出来，返回 0 —— 调用方必须另外用 midJoinNow()
 * 判断「是不是中途加入」，别把这里的 0 当成「从片头起播」。
 *
 * 必须按文件大小封顶：时长探测偏小时 position × 码率会超过文件大小，
 * startRunNeeded 的封顶项随之变成 0（门槛恒满足），成员面板里每个人也都显示成「已收完」。
 */
function roomPlayheadByte() {
  const size = S.manifest?.size || 0;
  const snap = S.sync?.lastTick;
  let byte;
  if (!snap) byte = (S.sync?.sharedPositionNow?.() || 0) * mediaBitrate();
  else if (snap.streamPos > 0) byte = snap.streamPos;
  else byte = (snap.position || 0) * mediaBitrate();
  byte = Math.max(0, byte || 0);
  return size > 0 ? Math.min(size, byte) : byte;
}

/**
 * 起播点往后至少要有多少连续字节才敢起播。
 *
 * = 恢复线（15 秒）× 码率 + 解复用器的预读余量。实测 mpv 的 demuxer-cache-time
 * 常年领先 time-pos 约 1.7 秒，余量盖不住它就会撞上连续区尽头、被当成「这一部放完了」。
 * 起播点靠近片尾时按「到片尾还剩多少」封顶，否则最后十几秒永远等不到起播。
 */
function startRunNeeded(size = 0, startByte = 0) {
  const bitrate = mediaBitrate();
  const need =
    bitrate > 0 ? (START_RUN_SECONDS + DEMUX_READAHEAD_SECONDS) * bitrate : MIN_START_RUN_BYTES;
  const want = Math.max(need, MIN_START_RUN_BYTES);
  if (!(size > 0)) return want;
  return Math.min(want, Math.max(0, size - Math.max(0, startByte)));
}

/**
 * 中途加入：起播点不在片头时说一句，否则用户只看到「片头早就够了却还不播」。
 * MKV 的索引常在文件尾，调度器会先去取它，这件事也一并说明。
 */
function announceMidJoin(sess, p) {
  if (sess.isSeeder || p.complete || S.roomSecurityMode !== 'trusted') return;
  if (!midJoinNow() || S.midJoinNoted === S.currentSeq) return;
  S.midJoinNoted = S.currentSeq;
  log('你是中途加入的，正在下载房间当前位置附近的内容', 'warn');
  if (/\.mkv$/i.test(S.manifest?.name || '')) log('正在优先获取索引（MKV 的索引常在文件尾）');
}

/**
 * 中途加入，但清单里没有时长 —— 换不出「房间播到第几个字节」，也就判不了
 * 起播点附近有没有数据。这时提前起播等于蒙着眼睛跳进空洞，只能等收完。
 * 每一部只说一次，否则每条进度事件都会刷一行。
 */
function warnMidJoinBlind() {
  if (S.midJoinBlindNoted === S.currentSeq) return;
  S.midJoinBlindNoted = S.currentSeq;
  log('片源没提供时长，算不出房间播到哪；这一部要完整接收后才能播放', 'warn');
}

/**
 * 把同步引擎要的跳转落到播放器上。
 *
 * 跳到还没收到的位置时先暂停再跳：mpv 在空洞上会花掉一帧，再把时间轴跳到洞后的
 * 下一个关键帧（实测跳过约 4.8 秒），那个跳变又会被当成「用户拖了进度条」广播出去。
 * 跳完立刻重算一次卡顿，不等下一条 tick —— 等到那时播放器已经在读空洞了。
 * 重算放进宏任务：_reconcile 在 seek 之后还要按跳转前算好的状态发一次暂停命令，
 * 抢在它前面置 stall 的话，那条旧命令会把我们刚按下的暂停又放开。
 */
function applySeek(pos) {
  const ctx = currentFileCtx();
  let buffer = null;
  if (ctx?.scheduler && S.sourceType !== 'link') {
    const byte = ctx.scheduler.positionToByte(pos || 0, null) || 0;
    S.swarm.setPlaybackByte(ctx.slot, byte);
    const prog = S.swarm.progress(ctx.slot);
    buffer = { contiguousBytes: prog.contiguousBytes, runBytes: prog.runBytes, complete: prog.complete };
    if (!prog.complete && !(prog.runBytes > 0)) {
      window.sw.player.setPause(true).catch(() => {});
      log('跳转到的位置还没收到，已暂停等缓冲', 'warn');
    }
  }
  return Promise.resolve(window.sw.player.seek(pos))
    .catch(() => {})
    .finally(() => {
      if (buffer) setTimeout(() => S.sync?._evaluateStallNow(pos, buffer), 0);
    });
}

function updatePeerForecasts(list) {
  const now = Date.now();
  const size = S.manifest?.size || 0;
  const bitrate = mediaBitrate();
  const playhead = roomPlayheadByte();
  const trusted = S.roomSecurityMode === 'trusted';
  // 片源是加这部片的人，不一定是房主
  const sourceId = S.current?.kind === 'file' ? S.current.sourceId : '';
  const next = new Map();
  for (const info of list) {
    let meter = intakeMeters.get(info.peerId);
    if (!meter) {
      meter = new RateMeter();
      intakeMeters.set(info.peerId, meter);
    }
    meter.sample(now, info.remoteHeldBytes || 0);
    const rate = meter.rate;
    const held = info.remoteHeldBytes || 0;
    // 按房间播放位置往后他还缺的各段逐段算：空洞后面他已经收齐的不算要等的
    const shape = {
      size,
      bitrate,
      rate,
      contiguous: info.remoteRunEndBytes || 0,
      playhead,
      holes: info.remoteMissingAhead ?? undefined,
    };
    let forecast;
    if (!size || S.sourceType === 'link') forecast = { level: 'unknown' };
    else if (sourceId && info.peerId === sourceId && !S.isSeeder) forecast = { level: 'source' };
    // 「已收完」只认整部都在手上。只看从播放位置到文件尾的话，中途加入、回头接着放的人
    // [0, P) 还缺着也会被报成「已收完」—— 安全模式下他其实还没收完、更没扫描，根本放不了
    else if (held >= size) forecast = { level: 'done' };
    // 从播放位置往后都收齐了、[0, P) 还在补：可信房间里不会卡，但不能说成「已收完」
    else if (trusted && (info.remoteRunEndBytes || 0) >= size) forecast = { level: 'ahead' };
    else if (rate === null) forecast = { level: 'measuring' };
    // 安全模式收完才播，不存在中途卡顿，只算还要多久（见 forecastLabel）
    else if (!trusted) forecast = { level: 'receiving' };
    else forecast = forecastStall(shape);
    // 会卡的人才算「先等多久就不卡了」——不卡的人这个数恒为 0，算了也没东西可说。
    const lead = forecast.level === 'stall' ? bufferLead(shape) : null;
    // 他在全员暂停里还要多久才攒够（同步引擎的恢复线）。和上面那个不是一回事，
    // 卡住的人预判等级不一定是 stall（比如余量很薄的人网络抖了一下）。
    const resume =
      trusted && rate !== null && forecast.level !== 'done' && forecast.level !== 'source'
        ? resumeLead({ ...shape, resumeBytes: S.sync?.resumeThresholdBytes || 0 })
        : null;
    next.set(info.peerId, { ...forecast, rate, held, lead, resume });
  }
  for (const id of intakeMeters.keys()) if (!next.has(id)) intakeMeters.delete(id);
  lastForecasts = next;
  return next;
}

/** 预判给人看的那一句。安全模式收完才播，不存在中途卡顿，说的是还要等多久。 */
function forecastLabel(f) {
  if (!f) return '';
  if (f.level === 'source') return '片源';
  if (f.level === 'done') return '已收完，不会卡';
  // 可信房间：播放位置往后都齐了，播放器不会卡；[0, P) 还在补，所以不说「已收完」
  if (f.level === 'ahead') return '前方已收齐，不会卡';
  if (f.level === 'measuring') return '正在测速…';
  if (f.level === 'unknown') return mediaBitrate() > 0 ? '' : '码率未知，没法预判';
  if (S.roomSecurityMode !== 'trusted') {
    // 按整部还缺多少算：从播放位置往后收齐了也得等 [0, P) 收完、扫描通过才放得了
    const remaining = Math.max(0, (S.manifest?.size || 0) - (f.held || 0));
    return f.rate > 0 ? `收完才播 · 预计还需 ${fmtTime(remaining / f.rate)}` : '收完才播';
  }
  if (f.level === 'ok') return '流畅';
  if (f.level === 'thin') return f.finishSec != null ? '速度低于码率，但缓冲够撑到收完' : '余量很薄，网络一抖就会卡';
  const base = f.stallInSec >= 1 ? `按现在的速度约 ${fmtTime(f.stallInSec)} 后会卡` : '已经跟不上码率，会卡';
  // 房主看的是整屋人。知道「这个人再缓冲多久就不卡了」，才好决定要不要让大家一起等一会儿。
  const wait = f.lead?.waitSec;
  return wait > 0 && Number.isFinite(wait) ? `${base} · 再缓冲 ${fmtTime(wait)} 可看完` : base;
}

/**
 * 自己这一路还要多久攒够恢复线（同步引擎据此解除卡顿）。横幅和 mpv 里的
 * 「约 T 后继续」用它；「再缓冲多久可一路看完」是另一件事，见 renderTransferVerdict。
 */
function myResumeLead() {
  if (S.isSeeder || S.sourceType === 'link' || !S.manifest) return null;
  const p = S.swarm?.progress();
  if (!p || p.complete) return null;
  const rate = p.downRate || 0;
  if (!(rate > 0)) return null;
  return resumeLead({
    size: S.manifest.size,
    rate,
    contiguous: p.runEndBytes,
    // 和 runEndBytes 出自同一个播放位置（swarm 的 playbackByte）
    playhead: p.playbackByte,
    holes: S.swarm.missingAhead(p.slot),
    resumeBytes: S.sync?.resumeThresholdBytes || 0,
  });
}

/**
 * 全员暂停还要等多久：卡住的人各自攒够恢复线（15 秒 × 码率）要多久。
 *
 * 不是「再缓冲多久可一路看完」—— 速度低于码率时那个数常常是十几分钟，引擎却在余量
 * 过了恢复线就松口，十几秒后房间就走了（之后多半会再卡）。拿那个数当「约 T 后继续」，
 * 恰好在最需要说准的时候说错。
 *
 * 取所有卡住的人里最久的那个 —— 房间要等最慢的那个攒够才恢复。任何一个人算不出来
 * 就整个返回 null：宁可不给数，也别给一个偏乐观的数让人白等。
 *
 * 这里按 peerId 取预判，而不是用 status().waitingFor —— 那个返回的是名字，
 * 和 lastForecasts 的键对不上。
 *
 * room 为真时只算让房间停下的人：游客自己缓冲不足只停他自己，房间不等他。
 */
function stallWaitSeconds({ room = false } = {}) {
  if (!S.sync) return null;
  const leads = [];
  if (S.sync.localStalled && (!room || S.sync.canIControl())) leads.push(myResumeLead());
  for (const peerId of S.sync.stalledPeers.keys()) leads.push(lastForecasts.get(peerId)?.resume);
  return worstWaitSeconds(leads);
}

function stallBannerText(waitingFor) {
  const who = waitingFor.join('、');
  const wait = stallWaitSeconds({ room: true });
  return wait
    ? `全员暂停中 —— 在等 ${who} 把缓冲攒够，约 ${fmtTime(wait)}`
    : `全员暂停中 —— 在等 ${who} 把缓冲攒够`;
}

/** 只有本机游客在卡（房间照常播放）时的横幅：别说成「全员暂停」，让人以为自己拖停了全房。 */
function selfStallBannerText() {
  const wait = stallWaitSeconds();
  return wait
    ? `缓冲不足，只暂停你自己，房间照常播放 —— 约 ${fmtTime(wait)} 后继续`
    : '缓冲不足，只暂停你自己，房间照常播放';
}

/**
 * 全员暂停在等谁。和 status().waitingFor 基本是同一批人、同一个顺序，但名字按成员表同一套显示名（重名编号），
 * 两个「小明」时分得清是哪一个在卡；不在表里的（星型房间里经房主转来的别人）用他报的名字。
 * 游客自己卡着不列进去：他的卡顿只停他自己，房间不是在等他（status() 里仍然有他）。
 */
function stallWaitingNames() {
  const shown = roomDisplayNames();
  const out = [...S.sync.stalledPeers].map(([peerId, v]) => shown.get(peerId) || v.name);
  if (S.sync.localStalled && S.sync.canIControl()) out.unshift('你'); // 和 status() 一样，由 t() 统一翻译
  return out;
}

// 上一次推给 mpv 的横幅。主进程那边也会去重，这里再挡一层是因为 renderStatus
// 每个 tick 都跑一遍，没必要为同一句话发一趟 IPC。
let lastMpvBanner = '';
// 「缓冲还不够」的提示节流，见 denied 的 play 分支
let lastPlayDeniedAt = 0;
function pushMpvBanner(text) {
  const next = text || '';
  if (next === lastMpvBanner) return;
  lastMpvBanner = next;
  S.danmaku?.setBanner(!!next);
  // 覆盖层不走 DOM，自动翻译的 MutationObserver 碰不到它，必须显式过一遍 t()。
  // 发完就不管：在 tick 处理器里 await 会让同一条 mpv socket 上的 pause/seek 乱序。
  window.sw.player.overlay(next ? t(next) : '').catch(() => {});
}

/**
 * 房主面板：文件码率、上行带宽、当前上传，以及按码率算出的「最多能流畅供几个人」
 * 和「现在有几个人会卡」。成员面板只看得到自己，能对全房拿主意的只有房主。
 */
function renderHostVerdict(list = S.swarm?.peerList() || []) {
  const node = $('buf-verdict');
  if (!node || !servingCurrent()) return;
  node.className = 'buffer-verdict';
  if (!S.manifest || S.sourceType === 'link') {
    node.classList.add('hidden');
    return;
  }

  const bitrate = mediaBitrate();
  const uplink = S.uplinkEstimate?.bytesPerSec || 0;
  const uploading = list.reduce((sum, p) => sum + (p.upRate || 0), 0);
  const parts = [
    stat('文件码率', bitrate > 0 ? fmtMbps(bitrate) : '未知'),
    stat('上行带宽（预估）', uplink > 0 ? fmtMbps(uplink) : '未测'),
    stat('当前上传', fmtMbps(uploading)),
  ];

  if (S.roomSecurityMode !== 'trusted') {
    parts.push(make('span', { text: '安全模式：成员收完才播，不会中途卡顿' }));
  } else {
    const supported = viewersSupported(uplink, bitrate);
    if (supported !== null) parts.push(stat('按码率最多流畅供', `${supported} 人`));
    let stalling = 0;
    let thin = 0;
    let receiving = 0;
    for (const p of list) {
      const f = lastForecasts.get(p.peerId);
      if (!f || f.level === 'done' || f.level === 'source' || f.level === 'unknown') continue;
      receiving++;
      if (f.level === 'stall') stalling++;
      else if (f.level === 'thin' && f.finishSec == null) thin++;
    }
    if (stalling) {
      node.classList.add('bad');
      parts.push(make('span', { text: `${stalling} 人按现在的速度会卡` }));
    } else if (thin) {
      node.classList.add('warn');
      parts.push(make('span', { text: `${thin} 人余量很薄` }));
    } else if (receiving) {
      parts.push(make('span', { text: '在收的成员都跟得上' }));
    }
  }
  replace(node, ...parts);
}

const AVATAR_HUES = ['#7fb2ff', '#e3a857', '#6fd08c', '#f08a6c', '#c49bff', '#5fd4d4'];

/** 头像：昵称的第一个字，颜色按 peerId 算，同一个人每次重画颜色不变。 */
function avatarOf(key, name) {
  let h = 0;
  for (const ch of String(key || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const el = make('span', {
    raw: true,
    className: 'avatar',
    text: [...String(name || '?')][0] || '?',
    attrs: { 'aria-hidden': 'true' },
  });
  el.style.background = AVATAR_HUES[h % AVATAR_HUES.length];
  return el;
}

/** 这一部还没开播时谁还没准备好 —— 成员表据此标「未就绪」。已经开播了返回 null。 */
function notReadyIds() {
  const pending =
    roomEntered && !!S.sync && !!S.current && !S.playlist.started && !S.switchingMedia && S.sync.shared.paused;
  if (!pending) return null;
  return new Set(readyWaiting().map((w) => (w.self ? S.peerId : w.peerId)));
}

/** 本机速率：下行 = 从所有人那里收的合计，上行 = 发给所有人的合计（字节/秒）。 */
function myRates(list = S.swarm?.peerList() || []) {
  let down = 0;
  let up = 0;
  for (const p of list) {
    down += p.downRate || 0;
    up += p.upRate || 0;
  }
  return { down, up };
}

/** 成员表里「你」这一行：等不等得起，你自己也是其中一个。 */
function selfPeerRow(waiting, names = roomDisplayNames()) {
  const role = S.sync?.myRole() || (S.role === 'host' ? 'host' : 'guest');
  const p = S.swarm?.progress();
  const serving = servingCurrent();
  const { down, up } = myRates();
  let state = '—';
  let tone = '';
  if (S.sourceType === 'link') state = '各自从原网站播放';
  else if (serving) state = '片源';
  else if (p?.complete) state = '已收完';
  else if (S.manifest) state = `已收 ${Math.round((p?.ratio || 0) * 100)}%`;
  if (waiting) {
    const ready = !waiting.has(S.peerId);
    state = ready ? '已就绪' : `未就绪 · ${state}`;
    tone = ready ? 'ok' : 'wait';
  }
  const speed = serving ? (up > 0 ? `↑ ${fmtMbps(up)}` : '供片中') : down > 0 ? `↓ ${fmtMbps(down)}` : '—';
  return make('div', { className: 'peer self', attrs: { role: 'row' } }, [
    make('div', { className: 'peer-who', attrs: { role: 'cell' } }, [
      avatarOf(S.peerId, S.name),
      // 显示名：和别人重名时临时带编号（只是显示，存着的昵称不变）
      make('span', { raw: true, className: 'peer-name', text: names.get(S.peerId) || S.name || '' }),
      platformChip(S.swarm?.platform || myPlatform()),
      make('span', { className: 'peer-platform', text: '（你）' }),
    ]),
    make('div', { attrs: { role: 'cell' } }, [
      make('span', { className: `role-badge ${role}`, text: ROLE_LABEL[role] || '' }),
    ]),
    make('div', { className: 'peer-state', attrs: { role: 'cell' } }, [
      make('div', { className: tone ? `peer-forecast ${tone}` : 'peer-forecast', text: state }),
    ]),
    make('div', { className: speed === '供片中' || speed === '—' ? 'peer-speed idle' : 'peer-speed', attrs: { role: 'cell' }, text: speed }),
    make('div', { className: 'peer-act', attrs: { role: 'cell' } }, [make('button', { className: 'peer-rename', text: '改名' })]),
  ]);
}

function renderPeers(list) {
  list = list || S.swarm?.peerList() || [];
  list = list.filter((p) => p.state === 'connected' || p.state === 'completed');
  // 页签上的人数算上自己，和成员表的行数对得上
  if (list.length + 1 > Number($('peer-count').textContent || 0)) notePeersChanged();
  $('peer-count').textContent = list.length + 1;
  updatePresence();
  renderCapacityStatus();
  renderRoomPill(list.length);
  renderInviteArea();
  // 空房间和有人之间切换时，状态带那句「还没有人加入」要跟着换
  renderReady();
  const forecasts = updatePeerForecasts(list);
  renderHostVerdict(list);

  if (!list.length) {
    // 房主这边，空房间的成员页就是邀请流程（renderInviteArea）；观众这边说一句就好
    replace('peer-list', S.role === 'host' ? [] : make('p', { className: 'peer-empty', text: '还没有其他成员。' }));
    return;
  }

  const iAmHost = S.sync?.myRole() === 'host';
  const waiting = notReadyIds();
  // 没准备好的人报来的原因（卡在安全扫描上）。预判只看得到位图，这种人在它眼里就是「已收完」
  const readyWhy = new Map(waiting ? S.sync.readySnapshot().peers.map((p) => [p.peerId, p.why]) : []);
  const bitrate = S.sourceType === 'link' ? 0 : mediaBitrate();
  const names = roomDisplayNames();
  // 有人进出、改名，重名编号可能跟着变：聊天里的名字要和成员表对得上
  const nameKey = [...names].join('\n');
  if (nameKey !== lastDisplayNames) {
    lastDisplayNames = nameKey;
    renderChat();
  }
  replace('peer-list', [
    make('div', { className: 'peer-head', attrs: { role: 'row' } }, [
      make('span', { text: '成员' }),
      make('span', { text: '角色' }),
      make('span', { text: waiting ? '准备情况' : '状态' }),
      make('span', { text: '实时速率' }),
      make('span'),
    ]),
    selfPeerRow(waiting, names),
    ...list.map((peer) => {
      const stalled = S.sync?.stalledPeers.has(peer.peerId);
      const candidateRole = S.sync?.roleOf(peer.peerId) || 'guest';
      const role = ROLE_LABEL[candidateRole] ? candidateRole : 'guest';
      const roleControl =
        iAmHost && role !== 'host'
          ? make('button', {
              className: 'role-toggle',
              text: role === 'admin' ? '设为游客' : '设为管理员',
              attrs: { 'data-peer': peer.peerId, 'data-next': role === 'admin' ? 'guest' : 'admin' },
            })
          : null;

      let stateNodes;
      let speed = '—';
      let speedTone = 'idle';
      if (S.sourceType === 'link') {
        stateNodes = [
          make('div', { className: 'peer-forecast', text: '各自从原网站播放' }),
          make('div', { className: 'peer-sub', text: `延迟 ${peer.rtt != null ? `${peer.rtt}ms` : '—'}` }),
        ];
      } else {
        const ratio = Math.max(0, Math.min(1, Number(peer.remoteRatio) || 0));
        const forecast = forecasts.get(peer.peerId);
        const forecastText = forecastLabel(forecast);
        // 安全模式下不存在「会卡」，不上红黄色，免得把「要等」看成「出故障」。
        const tone = S.roomSecurityMode === 'trusted' ? forecast?.level || '' : '';
        const waitText = READY_WHY_LABEL[readyWhy.get(peer.peerId)] || forecastText;
        const main = waiting?.has(peer.peerId)
          ? make('div', { className: 'peer-forecast wait', text: waitText ? `未就绪 · ${waitText}` : '未就绪' })
          : waiting
          ? make('div', { className: 'peer-forecast ok', text: '已就绪' })
          : forecastText
          ? make('div', { className: `peer-forecast ${tone}`, text: forecastText })
          : make('div', { className: 'peer-forecast', text: `持有 ${(ratio * 100).toFixed(0)}%` });
        stateNodes = [
          main,
          make('div', {
            className: 'peer-sub',
            text: `持有 ${(ratio * 100).toFixed(0)}% · 延迟 ${peer.rtt != null ? `${peer.rtt}ms` : '—'}`,
          }),
        ];
        // 接收速率由对方位图随时间的增长算出（信令模式下他能从好几个人那里收，本机发的只是一份）
        const rate = forecast?.rate || 0;
        if (forecast?.level === 'source') speed = '供片中';
        else if (forecast?.level !== 'done' && rate > 0) {
          speed = `↓ ${fmtMbps(rate)}`;
          speedTone = bitrate > 0 && rate < bitrate ? 'slow' : '';
        }
      }

      return make('div', { className: 'peer', attrs: { role: 'row' } }, [
        make('div', { className: 'peer-who', attrs: { role: 'cell' } }, [
          avatarOf(peer.peerId, peer.name),
          make('span', { raw: true, className: `peer-name ${stalled ? 'stalled' : ''}`, text: names.get(peer.peerId) || peer.name }),
          // 每个人用什么设备加入的（Windows / Android …）。昵称是用户输入，标记单独一个元素，别拼进去
          platformChip(peer.platform),
        ]),
        make('div', { attrs: { role: 'cell' } }, [
          make('span', { className: `role-badge ${role}`, text: ROLE_LABEL[role] }),
        ]),
        make('div', { className: 'peer-state', attrs: { role: 'cell' } }, stateNodes),
        make('div', { className: speedTone ? `peer-speed ${speedTone}` : 'peer-speed', attrs: { role: 'cell' }, text: speed }),
        make('div', { className: 'peer-act', attrs: { role: 'cell' } }, roleControl ? [roleControl] : []),
      ]);
    }),
  ]);
}

// 成员表的重画合并到最多每 PEERS_RENDER_MS 一次。swarm 每个 pong、每次握手都发 peers，
// 就绪和角色变化也来，每一次都是整张表重建外加邀请区、状态带、Discord 状态一起算一遍 ——
// 对端刷 pong 或者房主刷就绪消息，就能让界面卡死。进房那一刻的第一次仍然直接画（enterRoom）。
const PEERS_RENDER_MS = 150;
let peersRenderTimer = null;
// 上一次成员表用的显示名（重名编号）。变了才让聊天重画一遍
let lastDisplayNames = '';

function renderPeersSoon() {
  if (peersRenderTimer) return;
  peersRenderTimer = setTimeout(() => {
    peersRenderTimer = null;
    renderPeers();
  }, PEERS_RENDER_MS);
}

// 房主点「设为管理员/游客」—— 事件委托，省得每次重画都重新接线。
$('peer-list').addEventListener('click', (e) => {
  // 自己那一行的「改名」
  if (e.target.closest('.peer-rename')) return openRenameModal();
  const btn = e.target.closest('.role-toggle');
  if (!btn || S.sync?.myRole() !== 'host') return;
  S.sync.setRole(btn.dataset.peer, btn.dataset.next);
});

/* ------------------------------ 实时速率 ------------------------------ */

// 下行 = 本机从所有人那里收的合计，上行 = 发给所有人的合计。每秒取一个点，折线画最近 30 秒。
const RATE_POINTS = 30;
const rateHistory = { down: [], up: [] };
let rateTimer = null;

function startRateTicker() {
  if (rateTimer) return;
  rateTimer = setInterval(renderRates, 1000);
  renderRates();
}

const mbpsNumber = (bytesPerSec) => ((Math.max(0, bytesPerSec || 0) * 8) / 1e6).toFixed(1);

function renderRates() {
  if (!roomEntered || !S.swarm) return;
  const list = S.swarm.peerList() || [];
  const { down, up } = myRates(list);
  for (const [key, value] of [
    ['down', down],
    ['up', up],
  ]) {
    const history = rateHistory[key];
    history.push(value);
    if (history.length > RATE_POINTS) history.shift();
  }
  $('rate-down').textContent = mbpsNumber(down);
  $('rate-up').textContent = mbpsNumber(up);
  // 两条折线用同一个纵轴，上行和下行谁大谁小一眼能比
  const peak = Math.max(1, ...rateHistory.down, ...rateHistory.up);
  drawSpark($('spark-down'), rateHistory.down, peak, '#3fb950');
  drawSpark($('spark-up'), rateHistory.up, peak, '#4c8dff');
  const bitrate = S.sourceType === 'link' || !S.manifest ? 0 : mediaBitrate();
  $('rate-bitrate').textContent = bitrate > 0 ? `片子码率 ${fmtMbps(bitrate)}` : '';
  const verdict = rateVerdict(down, bitrate, list);
  const node = $('rate-verdict');
  node.className = verdict.tone ? `rate-verdict ${verdict.tone}` : 'rate-verdict';
  node.textContent = verdict.text;
}

/** 速率那一行最右边的一句结论。只说这台电脑自己的情况，全房的汇总在房主面板和成员表里。 */
function rateVerdict(down, bitrate, list) {
  if (!S.current) return { text: '', tone: '' };
  if (S.sourceType === 'link') return { text: '各自从原网站读取，不走 P2P', tone: '' };
  if (servingCurrent()) {
    const connected = list.filter((p) => p.authenticated).length;
    const feeding = list.filter((p) => p.authenticated && (p.upRate || 0) > 0).length;
    if (!connected) return { text: '还没人连上，没有流量', tone: '' };
    return feeding ? { text: `正在给 ${feeding} 人供片`, tone: '' } : { text: '现在没人在收', tone: '' };
  }
  if (S.swarm?.progress().complete) return { text: '这一部已经收完', tone: 'ok' };
  // 安全模式收完才播，速度只决定等多久，不存在「会卡」
  if (S.roomSecurityMode !== 'trusted') return { text: '安全模式：收完才播', tone: '' };
  if (!(bitrate > 0)) return { text: '', tone: '' };
  if (!(down > 0)) return { text: '还没开始收', tone: '' };
  const times = down / bitrate;
  if (times >= 1.2) return { text: `下行是码率的 ${times.toFixed(1)} 倍，够用`, tone: 'ok' };
  if (times >= 1) return { text: '下行刚好够码率，余量很薄', tone: 'warn' };
  return { text: '下行比码率低，边下边播可能会卡', tone: 'bad' };
}

function drawSpark(canvas, data, peak, color) {
  const ctx = canvas?.getContext?.('2d');
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  if (data.length < 2) return;
  // 靠右对齐：最新的点永远在最右边，刚进房、点还不满 30 个时从右往左长
  const offset = RATE_POINTS - data.length;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  data.forEach((value, i) => {
    const x = ((i + offset) / (RATE_POINTS - 1)) * (w - 1);
    const y = h - 1.5 - (value / peak) * (h - 3);
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  });
  ctx.stroke();
}

/** 更新「我是谁」的身份提示：房主/管理员可控场，游客只能管自己、不能跳转。 */
function renderMyRole() {
  const badge = $('my-role');
  const hint = $('role-hint');
  if (!badge || !S.sync) return;

  const role = S.sync.myRole();
  badge.textContent = ROLE_LABEL[role];
  badge.className = `role-badge ${role}`;

  const canControl = S.sync.canIControl();
  $('buffer').classList.toggle('locked', !canControl);
  if (hint) {
    hint.textContent = canControl
      ? ''
      : '你是游客：播放/暂停只对你自己生效，不影响其他人，也不能拖动进度条。';
    hint.classList.toggle('hidden', canControl);
  }
}

/** 当前项是链接、播放器还没起来时，状态栏说在等什么。 */
function linkWaitText() {
  const item = S.current;
  if (item && S.skippedLinks.has(item.id)) return '你跳过了这一部，播放器保持空闲（不影响其他人）';
  if (item && fallbackAsking()) return `房主提供的播放地址来自 ${S.fallbackConsent.host}，需要你先允许`;
  // 网站名取自登记下来的那次询问，不按此刻的 url 现算：现算的话房主换了网址，横幅会跟着变成新网站
  if (item && linkAsking()) return `这一部要打开 ${S.linkConsent.host}，需要你先允许`;
  if (linkResolveFailed()) return '这个视频链接在你的电脑上没能解析出来，可以重试，也可以先跳过这一部';
  if (linkPlayFailed()) {
    return S.linkPlayFailed.kind === 'cut'
      ? '在线视频断了，点「重试」重新连接，也可以先跳过这一部'
      : '播放器打不开这个在线视频，可以重试，也可以先跳过这一部';
  }
  return '正在解析并连接原始视频…';
}

function renderStatus() {
  if (!S.sync) return;
  const st = S.sync.status();
  const banner = $('status-banner');

  const guest = !S.sync.canIControl();
  const cur = S.current;
  const skipped = cur?.kind === 'link' && S.skippedLinks.has(cur.id);
  const failed = linkResolveFailed();
  const asking = cur?.kind === 'link' && !S.linkInfo && (skipped || linkAsking() || fallbackAsking());
  // 播放器开着也可能放不了（打不开、半路断了）：这时房间照走，横幅得说本机出了什么事
  const playFailed = linkPlayFailed();
  // 房间在播不等于本机播放器起来了：还在等授权、或者解析失败的时候，横幅得说清在等什么
  const linkWaiting = cur?.kind === 'link' && ((!S.mpvRunning && (asking || failed)) || playFailed);
  // 安全模式收完才播：房间在播、本机还在收（播放器没开，也还不许开）的人不参与卡顿，
  // 横幅不能说「播放中」，要走到最后说他在等什么
  const receivingOnly = !st.paused && cur?.kind === 'file' && !S.mpvRunning && !playbackAllowed();

  if (st.stalled) {
    banner.className = 'status-banner waiting';
    // 有人卡着不一定是全员暂停：游客自己缓冲不足只停他自己，房间照常播放（roomStalled 为假）
    banner.textContent = S.sync.roomStalled ? stallBannerText(stallWaitingNames()) : selfStallBannerText();
  } else if (!st.paused && !linkWaiting && !receivingOnly) {
    // 在播但本机和房主没对上：用提醒的黄色，别亮「一切正常」的绿
    banner.className = driftShown() ? 'status-banner waiting' : 'status-banner playing';
    banner.textContent = driftShown()
      ? `播放中，但你和${driftRefName()}没对上`
      : guest
      ? '播放中（你在独立观看，操作不影响他人）'
      : '播放中，所有人同步';
  } else {
    banner.className = 'status-banner';
    banner.textContent = playFailed
      ? linkWaitText()
      : S.mpvRunning
      ? '已暂停'
      : !S.current
      ? canEditPlaylist()
        ? '播放列表是空的，加一部就能开始'
        : '播放列表是空的，等房主加片'
      : S.sourceType === 'link'
      ? linkWaitText()
      : currentUnavailable()
      ? '这一部的片源已经离开，暂时没人能提供'
      : S.current.kind === 'file' && !currentSession() && S.diskFull.has(S.current.fileId)
      ? '本机磁盘放不下这一部，已跳过，不影响其他人'
      : S.mediaSafety.status === 'scanning'
      ? scanProgressLabel()
      : S.mediaSafety.status === 'blocked'
      ? '安全扫描未通过，已阻止播放并清理缓存'
      : S.mediaSafety.status === 'unscanned'
      ? '文件已完整接收，但本机扫描器不可用 —— 这份文件没有经过扫描'
      : S.mediaSafety.status === 'scan-timeout' || S.mediaSafety.status === 'scan-stopped'
      ? '文件已完整接收但没有扫完 —— 文件还在，可以重新扫描'
      : // 这一部本机已经能播（房主手里就有、或者已经收够 / 扫过），只是播放器没开着（被关掉、没起来）。
      // 不单列的话会落到下面「正在接收」那两句 —— 房主看到「正在接收片头」完全摸不着头脑
      S.filePath && !S.switchingMedia && playbackAllowed()
      ? '播放器没开着，点「重新打开播放器」接着看'
      : S.roomSecurityMode === 'trusted'
      ? '可信房间：正在接收片头，达到约 8 MB 后将边下边播…'
      : '正在完整接收并校验媒体，完成后会进行安全扫描…';
  }

  const scanning = S.mediaSafety.status === 'scanning';
  // 后台已经在扫的那部变成当前项时，开始扫描的那一刻没人开计时器（那时它还不是当前项），
  // 横幅上的「已用 X:XX」会一直停在切过来的瞬间。横幅在显示它，就一定要有计时器。
  setScanTicker(scanning && !S.mpvRunning);
  const unfinished = S.mediaSafety.status === 'scan-timeout' || S.mediaSafety.status === 'scan-stopped';
  $('btn-cancel-scan')?.classList.toggle('hidden', !scanning);
  $('btn-rescan')?.classList.toggle('hidden', !unfinished);
  $('btn-allow-link').classList.toggle('hidden', !asking);
  $('btn-retry-link').classList.toggle('hidden', !(failed || playFailed));
  $('btn-skip-link').classList.toggle('hidden', !(asking || failed || playFailed) || skipped);
  $('btn-skip-current').classList.toggle('hidden', !(S.sync.canIControl() && currentUnavailable()));

  // 全屏看片时上面这块横幅整个看不见 —— mpv 是独立窗口。把同一句话推到 mpv 画面上。
  pushMpvBanner(st.stalled ? banner.textContent : '');

  $('btn-playpause').textContent = st.intendedPaused ? '播放' : '暂停';
  // 按钮上只画图标（文字留给读屏和翻译），画哪一个看这个属性
  $('btn-playpause').setAttribute?.('data-state', st.intendedPaused ? 'play' : 'pause');
  $('time-display').textContent = `${fmtTime(st.position)} / ${fmtTime(st.duration)}`;
  renderNowKicker(st);
  // 播放器开了、关了都会走到这里：差值那一行跟着显隐（它自己比对，没变就不动 DOM）
  renderDrift();
  updateStripTone();
  // 每个播放器 tick 都会跑到这里：updatePresence 自己比对，没变就不发
  updatePresence();
}

/** 片名上面那一行：「正在播放 / 即将开始 / 已暂停」+「第 2 / 4 部」（已播放的也算进去）。 */
function renderNowKicker(st) {
  const badge = $('now-badge');
  if (!badge) return;
  const cur = S.current;
  const played = S.playlist?.history?.length || 0;
  const total = played + (S.playlist?.queue?.length || 0);
  $('now-pos').textContent = cur && total ? `第 ${played + 1} / ${total} 部` : '';
  let text = '';
  let kind = '';
  if (cur && st) {
    if (!st.paused) text = '正在播放';
    else if (!S.playlist?.started) {
      text = '即将开始';
      kind = 'wait';
    } else text = '已暂停';
  }
  badge.textContent = text;
  badge.className = `now-badge${kind ? ` ${kind}` : ''}${text ? '' : ' hidden'}`;
}

/** 状态带的颜色跟着情况走：同步在播 = 绿，有人卡住 / 有人没准备好 = 黄，扫出威胁 = 红，其余 = 蓝。 */
function updateStripTone() {
  const strip = $('status-strip');
  if (!strip) return;
  const banner = $('status-banner');
  const ready = $('ready-row');
  let tone = 'info';
  if (banner?.classList.contains('playing')) tone = 'ok';
  else if (banner?.classList.contains('waiting')) tone = 'warn';
  if (ready && !ready.classList.contains('hidden')) {
    tone = ready.classList.contains('alone') ? 'info' : ready.classList.contains('all') ? 'ok' : 'warn';
  }
  // 在播，但本机和房主没对上：不能亮「一切正常」的绿
  if (tone === 'ok' && driftShown()) tone = 'warn';
  if (S.mediaSafety?.status === 'blocked') tone = 'bad';
  strip.setAttribute('data-tone', tone);
}

/* ---------------------------- 在线链接的跟随方式 ---------------------------- */

/** 本机实际用的跟随方式。房主是参照，没得选，按完全同步走；其他人按自己在本机选的。 */
function linkFollowMode() {
  return isRoomHost() ? 'full' : S.settings.linkSync;
}

/** 差值是跟谁比的。房主自己跟的是房间时钟（管理员的操作也会改它）。 */
function driftRefName() {
  return isRoomHost() ? '房间进度' : '房主';
}

/** 「你比房主慢 12 秒」。seconds 是本机减房间，负数是落后。 */
function driftText(seconds) {
  const n = Math.abs(Math.round(seconds));
  return `你比${driftRefName()}${seconds < 0 ? '慢' : '快'} ${n} 秒`;
}

/** 这一刻要不要把「没对上」摆出来：在线链接、播放器开着、引擎报了没对上或同步失败。 */
function driftShown() {
  const d = S.sync?.driftStatus();
  return !!d && d.streaming && d.state !== 'ok' && S.sourceType === 'link' && !!S.mpvRunning;
}

// 上一次画出来的样子（没变就不碰 DOM：renderStatus 每个 tick 都会调到这里）。null = 还没画过
let driftKey = null;
// 在 mpv 画面上提醒过的状态和时刻：刚差开时说一声，之后差值变了也最多每分钟再说一次
let driftOsdState = 'ok';
let driftOsdAt = 0;
const DRIFT_OSD_REPEAT_MS = 60_000;

/** 状态带里那一行「你比房主慢 12 秒」+「同步到房主」按钮，以及控制条上的同步方式。 */
function renderDrift() {
  renderSyncModeControl();
  const row = $('drift-row');
  const btn = $('btn-sync-now');
  if (!row || !btn) return;
  const shown = driftShown();
  const d = S.sync?.driftStatus();
  const key = shown ? `${d.state}|${d.seconds}|${isRoomHost()}` : '';
  if (key === driftKey) return;
  driftKey = key;
  row.classList.toggle('hidden', !shown);
  btn.classList.toggle('hidden', !shown);
  updateStripTone();
  if (!shown) {
    driftOsdState = 'ok';
    return;
  }
  const failed = d.state === 'failed';
  replace(
    row,
    make('b', { text: failed ? '自动同步没跟上' : '手动同步' }),
    make('span', { text: driftText(d.seconds) }),
    ...(failed && !isRoomHost()
      ? [make('span', { className: 'fine', text: '网速跟不上的话，可以把同步方式改成「手动同步」' })]
      : [])
  );
  btn.textContent = isRoomHost() ? '同步到房间进度' : '同步到房主';
  // mpv 是独立窗口，全屏看片时房间窗口整个看不见。OSD 不进 DOM，得自己过一遍 t()
  const now = Date.now();
  if (d.state !== driftOsdState || now - driftOsdAt >= DRIFT_OSD_REPEAT_MS) {
    driftOsdState = d.state;
    driftOsdAt = now;
    window.sw.player.osd(`${t(driftText(d.seconds))} · ${t('按 Ctrl+Shift+S 同步')}`, 4000).catch(() => {});
  }
}

/** 控制条上的「同步 [完全同步 / 手动同步]」：只在当前项是在线链接、而且自己不是房主时出现。 */
function renderSyncModeControl() {
  const box = $('sync-mode-box');
  if (!box) return;
  box.classList.toggle('hidden', !(roomEntered && S.sourceType === 'link' && !isRoomHost()));
  const select = $('sync-mode');
  if (select && select.value !== S.settings.linkSync) select.value = S.settings.linkSync;
}

function setLinkSyncMode(value) {
  const mode = value === 'manual' ? 'manual' : 'full';
  if (mode === S.settings.linkSync) return;
  S.settings.linkSync = mode;
  localStorage.setItem('sw.linkSync', mode);
  S.sync?.setFollow({ mode: linkFollowMode() });
  log(
    mode === 'manual'
      ? '改成手动同步：缓冲慢了不再把你拽走，和房主差开时提示差多少秒'
      : '改成完全同步：一直跟房主对齐，差开了自动跳过去'
  );
  renderStatus();
  renderProgress(S.swarm?.progress());
}

/** 「同步到房主」按钮和 mpv 里的 Ctrl+Shift+S。 */
function syncToHost() {
  if (!roomEntered || S.sourceType !== 'link' || !S.sync?.syncToRoom()) return;
  const text = isRoomHost() ? '已同步到房间进度' : '已同步到房主的进度';
  log(text, 'good');
  window.sw.player.osd(t(text), 2000).catch(() => {});
}

$('sync-mode').onchange = () => setLinkSyncMode($('sync-mode').value);
$('btn-sync-now').onclick = syncToHost;
window.sw.player.onSyncRequest?.(() => syncToHost());

// 在线链接：每秒核对一次和房主差多少。播放器静止时不推 tick，差距在变大只能靠这个看出来
function driftTick() {
  if (!S.sync || S.sourceType !== 'link' || !S.mpvRunning || S.switchingMedia) return;
  S.sync.checkDrift();
}
setInterval(driftTick, 1000);

/* ------------------------------ 播放器事件 ----------------------------- */

// 只处理当前这一代播放器的事件。主进程要处理到 player:quit 才摘旧播放器的监听器，
// 换片时它在那之前发出的 tick 会排在换片逻辑之后到达：照单全收的话，迟到的 eof 会以
// 新 seq 再报一次放完（下一部被整部跳过），旧片的片长、字节位置会写进新片的调度和卡顿判断。
function onPlayerTick(snap) {
  if (!playerGate.acceptTick(snap)) return;
  handlePlayerTick(snap);
}

window.sw.player.onTick(onPlayerTick);

function handlePlayerTick(snap) {
  if (!S.sync || !S.swarm) return;
  // 卡顿判断只看正在播放的那一部
  const ctx = currentFileCtx();

  if (snap.duration) {
    if (ctx) S.swarm.setDuration(ctx.slot, snap.duration);
    S.sync.setMediaInfo({ duration: snap.duration, size: S.sourceType === 'link' ? 0 : S.manifest?.size });
  }

  // 播放位置先落到调度器上再取进度：runBytes 是「从播放位置起」的长度，
  // 拿上一拍的位置算出来的那个数配不上这一拍的 snap。
  if (ctx?.scheduler) {
    const byte = ctx.scheduler.positionToByte(snap.position || 0, snap.streamPos) || 0;
    S.swarm.setPlaybackByte(ctx.slot, byte);
  }
  const prog = ctx ? S.swarm.progress(ctx.slot) : null;

  S.sync.onMpvTick(snap, {
    contiguousBytes: ctx?.contiguousBytes || 0,
    runBytes: prog?.runBytes || 0,
    complete: S.sourceType === 'link' || !!ctx?.complete,
  });
  if (S.sourceType === 'link') noteLinkPlayback(snap);

  renderProgress(S.swarm.progress());
  renderStatus();
}

// 换片期间旧进程的 exit 常常晚到几百毫秒 —— 这段时间新播放器可能已经起来了，
// 照单全收会把 S.mpvRunning 永久打回 false：进度条拖不动、状态栏一直报错、
// 「重新打开」按钮常驻。只认当前这一代的 exit（S.switchingMedia 挡不住启动期间换片那一路）。
function onPlayerExit(info) {
  if (!playerGate.acceptExit(info)) return;
  handlePlayerExit(info);
}

window.sw.player.onExit(onPlayerExit);

/** 当前这一代播放器退出了（用户关窗、崩溃）。换片、拦截时主动退掉的不会走到这里。 */
function handlePlayerExit({ code }) {
  S.mpvRunning = false;
  lastMpvBanner = '';
  S.danmaku?.setActive(false);
  // 必须把上一条 tick 忘掉。留着的话，重开播放器后新 mpv 的第一条 tick
  // （position=0、paused=true）会被 syncEngine 当成「用户拖了进度条 / 按了暂停」，
  // 房主据此广播 SYNC(0)，整个房间被拉回片头并暂停。
  // playerGone 顺带放掉在线链接的本机卡顿：播放器没了，不会再有 tick 来解开它
  S.sync?.playerGone?.();
  $('btn-playpause').disabled = true;
  if (!S.switchingMedia && S.filePath) {
    // 用户自己关掉的（或崩了）：这一部不再自动拉起。安全模式下本机还在给别人供片的话，
    // 每发出一片都会走一遍 maybeLaunchPlayer —— 不记下来就是关一次弹一次，和下面这句提示对不上
    S.noAutoLaunchSeq = S.currentSeq;
    $('btn-reopen')?.classList.remove('hidden');
    log(`播放器已关闭（code ${code}），可在房间里重新打开`, 'warn');
  }
  renderStatus();
}

window.sw.player.onError((payload) => handlePlayerError(payload || {}));

/**
 * 复用本机副本时，主进程先抽查片头片尾就把会话开出来，其余的在后台逐片核对（见 fileStore.tryReuse），
 * 每半秒报一次最新的 state。核对上的片并进传输层：进度、起播门槛、卡顿判断马上用得上，
 * 也告诉对端我有了；调度器不再去向别人要这些片。对端送来的片照常收（主进程不会记两遍）。
 */
function mergeVerifiedChunks(e) {
  if (!e?.sessionId || typeof e.state?.bitfield !== 'string') return;
  const sess = [...S.sessions.values()].find((s) => s.sessionId === e.sessionId);
  if (!sess || sess.isSeeder) return;
  // 还没挂进 swarm 的，挂的时候用这份（attachLocalFiles 按 sess.state 建传输上下文）
  sess.state = e.state;
  const ctx = sess.slot !== null ? S.swarm?.files.get(sess.slot) : null;
  if (!ctx || ctx.sessionId !== e.sessionId) return;
  const total = ctx.manifest.chunkCount;
  const have = unpackBitfield(e.state.bitfield, total);
  let added = 0;
  for (let i = 0; i < total; i++) {
    if (have[i] === 1 && ctx.have[i] !== 1) {
      ctx.have[i] = 1;
      added++;
    }
  }
  if (!added) return;
  // 两边的位图都只记落了盘、验过哈希的片，并起来仍是主进程那份的子集：按并集重算计数和水位线
  let count = 0;
  let lead = -1;
  for (let i = 0; i < total; i++) {
    if (ctx.have[i] === 1) count++;
    else if (lead < 0) lead = i;
  }
  const justCompleted = !ctx.complete && count === total;
  ctx.haveCount = count;
  ctx.contiguousBytes = lead < 0 ? ctx.manifest.size : lead * ctx.manifest.chunkSize;
  ctx.complete = count === total;
  // 位图整张重发（大文件分段），不逐片发 HAVE：核对一秒能过几百片，逐片发会撞上对端的控制消息预算
  for (const peer of S.swarm.peers.values()) if (peer.authenticated) S.swarm._sendBitfield(peer, ctx);
  S.swarm.emit('progress', S.swarm.progress(ctx.slot));
  if (justCompleted) S.swarm.emit('complete', { slot: ctx.slot, fileId: ctx.manifest.fileId });
}

// 本机有这部片收完的副本（这次运行里收过、或者手动模式存在长期缓存文件夹里）：抽查对得上就先开会话，
// 其余的在后台核对，核对上的片就不用再传。大片子要核对一阵子，日志里说一声
window.sw.store.onReuse?.((e) => {
  if (!e || typeof e.name !== 'string') return;
  mergeVerifiedChunks(e);
  if (e.stage === 'start') log(`本机已有《${e.name}》，正在核对…`);
  else if (e.stage === 'done') {
    if (e.matched === e.total) log(`本机已有的《${e.name}》核对通过，不用再传`, 'good');
    else if (e.matched > 0) log(`本机的《${e.name}》有 ${e.matched}/${e.total} 片对得上，其余照常接收`, 'warn');
    else log(`本机的《${e.name}》和这一部对不上，重新接收`, 'warn');
  }
});

/* ------------------------------- 控件 ------------------------------- */

$('btn-playpause').onclick = () => {
  if (!S.sync) return;
  S.sync.userSetPaused(!S.sync.intendedPaused);
  renderStatus();
};

$('btn-reopen').onclick = () => reopenPlayer();

// 「已收完 · 切换到 X」：可信房间边下边播那一段过去之后的一键切换
$('btn-switch-player').onclick = () => {
  if (S.switchingPlayer || !S.mpvRunning) return;
  S.switchingPlayer = true;
  renderPlayerControls();
  relaunchWithPlayer().finally(() => {
    S.switchingPlayer = false;
    renderPlayerControls();
  });
};

$('btn-rescan').onclick = () => {
  if (!SCAN_RESUMABLE.includes(S.mediaSafety.status)) return;
  verifyReceivedMedia({ force: true });
};

$('btn-cancel-scan').onclick = () => {
  if (S.mediaSafety.status !== 'scanning') return;
  window.sw.store.cancelScan(S.sessionId).catch(() => {});
};

// 播放列表：加本地片 / 加链接（房主和管理员）
$('btn-add-file').onclick = async () => {
  if (!canEditPlaylist()) return;
  const paths = await window.sw.dialog.pickVideos();
  if (paths?.length) queueLocalFiles(paths);
};

$('btn-add-link').onclick = () => {
  if (!canEditPlaylist()) return;
  const row = $('add-link-row');
  row.classList.toggle('hidden');
  if (!row.classList.contains('hidden')) $('room-video-link').focus();
};

function submitRoomLink() {
  const url = $('room-video-link').value.trim();
  if (!url || !canEditPlaylist()) return;
  $('room-video-link').value = '';
  $('add-link-row').classList.add('hidden');
  addRoomLink(url);
}

$('btn-add-link-go').onclick = submitRoomLink;

// 「+ 添加」点开一个小菜单：本地视频 / 视频链接。选了一项、点到别处或按 Esc 都收起
function setAddMenu(open) {
  $('add-menu').classList.toggle('hidden', !open);
  $('btn-add').setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) $('btn-add-file').focus();
}
$('btn-add').onclick = (e) => {
  e.stopPropagation();
  setAddMenu($('add-menu').classList.contains('hidden'));
};
$('add-menu').addEventListener('click', () => setAddMenu(false));
$('add-menu').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  setAddMenu(false);
  $('btn-add').focus();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest?.('#playlist-actions')) setAddMenu(false);
});
$('room-video-link').addEventListener('keydown', (e) => {
  // 拼音选词时按回车不算提交
  if (e.key === 'Enter' && !e.isComposing) submitRoomLink();
});

// 房间页签（事件委托）
document.querySelector('.room-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.room-tab');
  if (tab) selectRoomTab(tab.dataset.tab, { byUser: true });
});

$('pl-autoplay').onchange = (e) => {
  const box = e.currentTarget;
  if (!canEditPlaylist()) {
    box.checked = S.playlist.autoplay;
    return;
  }
  runPlaylistOp({ type: 'setAutoplay', on: box.checked }).then(renderPlaylist);
};

$('btn-force-start').onclick = () => startCurrentNow();

$('btn-allow-link').onclick = () => {
  if (S.current?.kind === 'link') approveLinkSite(S.current);
};

$('btn-skip-link').onclick = () => {
  if (S.current?.kind === 'link') skipLinkItem(S.current);
};

$('btn-retry-link').onclick = () => {
  if (S.current?.kind === 'link') retryCurrentLink();
};

$('btn-skip-current').onclick = () => {
  if (!S.sync?.canIControl() || !S.current) return;
  runPlaylistOp({ type: 'ended', seq: S.playlist.seq });
};

// 房主兜底推进：自己的播放器没开着时（关掉了、崩了），按房间时钟判断这一部放完没有。
// 时长未知就不兜底，只靠控制者的播放器报「放完了」。
let fallbackSeq = -1;
function hostFallbackTick() {
  if (!isRoomHost() || !S.sync?.started || !S.current || S.switchingMedia || S.mpvRunning || S.leaving) return;
  if (!S.playlist.started || S.sync.shared.paused || S.sync.roomStalled) return;
  const duration = S.sync.duration;
  if (!(duration > 0) || fallbackSeq === S.playlist.seq) return;
  if (S.sync.sharedPositionNow(false) < duration + 1) return;
  fallbackSeq = S.playlist.seq;
  submitPlaylistOp({ type: 'ended', seq: S.playlist.seq });
}
setInterval(hostFallbackTick, 1000);

$('btn-reveal').onclick = () => {
  if (S.filePath) window.sw.store.reveal(S.filePath);
};

async function leaveRoom() {
  S.leaving = true;
  // 还在算哈希、转封装的准备任务一并叫停，别让主进程白忙
  for (const job of [...S.prepJobs]) cancelPrepJob(job);
  // 取消只是发出一声招呼：主进程要读完手上这一片才知道，而转封装产物的回收、刚开的做种会话
  // 都在任务的后半截。等它们收尾 —— 带上限，submitting 的任务还在等房主回音，不能无限等。
  await Promise.race([Promise.allSettled([...S.prepRuns]), delay(PREP_DRAIN_MS)]);
  S.signaling?.close();
  S.swarm?.destroy();
  // 换片时发出的退出可能还没落地（主进程已经没有当前播放器，这一次 quit 会立刻返回）：
  // S.playerQuit 连它一起等，播放器放开文件之后才能删缓存
  retirePlayer();
  await S.playerQuit;
  // 在途的打开请求、已经从 S.sessions 摘掉但还没关完的会话，都等它们做完。
  // 页面一刷新，没发出去的 store.close 就永远发不出去了，主进程里的会话和缓存要留到应用退出。
  // 一次性快照盖不住等待期间新冒出来的请求（关完旧缓存又去开新会话、取消之后才发出的回收），
  // 所以反复排空；加个轮数上限，免得极端情况下退不出去。
  for (let i = 0; i < DRAIN_ROUNDS && (S.leechOpens.size || S.closing.size); i++) {
    await Promise.allSettled([...S.leechOpens, ...S.closing]);
  }
  // 收尾期间还是可能有别的路径抢跑起了播放器（在途的 launch 回包）：再退一次，
  // 而且要赶在删缓存之前，不然缓存被它占着删不掉。
  retirePlayer();
  await S.playerQuit;
  for (const sess of S.sessions.values()) await window.sw.store.close(sess.sessionId).catch(() => {});
  location.reload();
}

/**
 * 离开会丢掉什么，一条一行；什么都不丢时是空的。
 * 两件事值得问一句：还有没收完的接收（离开会关会话，没收完的新文件删掉，没有断点续传），
 * 以及自己是房主而房里还有人（一对一邀请都连在房主身上，房主一走这一场就散了）。
 */
function leaveRoomLosses() {
  const lines = [];
  const unfinished = [];
  for (const sess of S.sessions.values()) {
    if (sess.isSeeder) continue;
    const prog = sess.slot !== null && S.swarm?.files.get(sess.slot) ? S.swarm.progress(sess.slot) : null;
    const have = prog ? prog.haveCount : sess.state?.haveCount || 0;
    const complete = prog ? prog.complete : !!sess.state?.complete;
    const total = sess.manifest?.chunkCount || 0;
    // 一片都还没收到的，离开也不丢什么
    if (complete || !(have > 0) || !total) continue;
    unfinished.push({ name: sess.manifest.name, ratio: have / total });
  }
  if (unfinished.length) {
    lines.push(make('p', { text: '这几部片还没收完：' }));
    // 片名是房主那边来的，原样显示、不参与翻译
    for (const f of unfinished) lines.push(make('p', { raw: true, text: `《${f.name}》 ${pct(f.ratio)}` }));
    lines.push(make('p', { text: '离开后接收就停了。没有断点续传：没收完的片一般不会保留，下次进房要重新下载。' }));
  }
  const others = connectedPeerCount();
  if (isRoomHost() && others > 0) {
    lines.push(make('p', { text: `你是房主，房间里还有 ${others} 个人。` }));
    lines.push(
      make('p', {
        text:
          S.mode === 'manual'
            ? '他们都是经一对一邀请连到你这里的：你一走，所有人一起断开，这一场就结束了。'
            : '你一走这一场就没有房主了：播放列表停止更新，经一对一邀请进来的人会直接断开。',
      })
    );
  }
  return lines;
}

let leaveAsk = null;

/** 顶栏「离开房间」：会丢东西时先问一句（确认框说清楚丢什么），不丢就直接走。连点不会重入。 */
function confirmLeaveRoom() {
  if (S.leaving || leaveAsk) return;
  const lines = leaveRoomLosses();
  if (!lines.length) {
    leaveRoom();
    return;
  }
  const ask = openModal({
    title: '要离开房间吗？',
    body: () => lines,
    okText: '离开房间',
    onOk: () => {
      leaveAsk = null;
      $('btn-leave').disabled = true;
      leaveRoom();
      return true;
    },
    onCancel: () => {
      if (leaveAsk === ask) leaveAsk = null;
    },
  });
  leaveAsk = ask;
}

$('btn-leave').onclick = confirmLeaveRoom;
$('btn-invite-next').onclick = openInvite;
$('btn-invite-close').onclick = closeInvite;

// 点进度条 seek —— 会同步给所有人。游客不允许跳转。
$('buffer').onclick = (e) => {
  if (!S.sync?.duration || !S.mpvRunning) return;
  if (!S.sync.canIControl()) {
    log('你是游客，不能跳转进度', 'warn');
    return;
  }
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  S.sync.userSeek(ratio * S.sync.duration);
};

/* ------------------------------- 设置 ------------------------------- */

/*
 * 设置弹窗的保存语义：字段一律点底部「保存」才生效，点「取消」全部丢掉。
 * 例外只有本身就是动作的按钮 —— 换缓存位置、换下载位置、清理残留、删除所选、Cloudflare 的「验证并保存」
 * 和「清除」：点了当场生效，旁边标着「立即生效」（instantTag）。这些撤不回，所以这一次打开设置里做过哪些
 * 记在 settingsApplied 里，点「取消」时告诉用户（noticeSettingsApplied），别让人以为「取消 = 什么都没改」。
 */
let settingsApplied = null;
// 「隐藏我的 IP」开着却还没有能用的中继：第一次点保存先提醒，再点一次才存（见 onOk）
let relayOnlyWarned = false;
// 两步确认的按钮（Cloudflare 的「清除」、缓存的「删除所选」）第一次点完多久之内再点才算数
const CONFIRM_WINDOW_MS = 5000;

function noteSettingsApplied(what) {
  settingsApplied?.add(what);
}

/** 动作按钮旁边的「立即生效」小标签。 */
function instantTag() {
  return make('span', {
    className: 'instant-tag',
    text: '立即生效',
    attrs: { title: '点了当场生效，不用点「保存」，点「取消」也撤不回' },
  });
}

/** 点了「取消」，而这次打开设置时有动作已经当场生效：说清楚是哪些。 */
function noticeSettingsApplied(applied) {
  if (!applied?.size) return;
  openModal({
    title: '这些改动已经生效',
    body: () => [
      make('p', { className: 'fine', text: '下面这些是点了当场生效的，「取消」撤不回；其余没保存的改动已经丢掉了。' }),
      make('ul', { className: 'settings-applied' }, [...applied].map((what) => make('li', { text: what }))),
    ],
    okText: '知道了',
  });
}

/** 设置里各栏自己的报错框。 */
function settingsErrorBox(id) {
  return make('div', { id, className: 'field-error settings-err hidden' });
}

/** 上一次点保存留下的报错先都收起来，别跟这一次的一起挂着。 */
function clearSettingsErrors() {
  for (const box of document.querySelectorAll('#modal-body .settings-err')) box.classList.add('hidden');
}

/**
 * 设置保存不了：报错写在出错那一栏底下，滚过去，把光标放进出错的输入框。
 * 设置是个长弹窗，「保存」在最底下 —— 报错写在看不见的地方，用户看到的只是「点保存没反应」。
 */
function settingsFail(errorId, text, focusId = '') {
  clearSettingsErrors();
  const box = $(errorId);
  if (!box) return;
  box.textContent = t(text);
  box.classList.remove('hidden');
  box.scrollIntoView?.({ block: 'nearest' });
  if (focusId) $(focusId)?.focus?.();
}

/**
 * 公共中继地址：wss://主机[:端口][/路径]，主机得是正经的域名或 IP。
 * 以前只看是不是 wss:// 开头，「wss://a.com,wss://b.com」整串也能存下来（主机解析成 a.com,wss），
 * 变成一条连不上的中继写进房间链接。
 */
function isRelayUrl(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.protocol !== 'wss:' || url.username || url.password) return false;
  const host = url.hostname;
  if (/^\[[0-9a-f:.]+\]$/i.test(host)) return true;
  return /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(host);
}

/**
 * 按设置页上此刻填的（还没保存的）内容，「隐藏我的 IP」有没有中继可用。
 * Cloudflare 的临时账号是建连前现取的：凭据存好了就当之后能取到；只有本月用量到了上限、这次也没调高时才算没有。
 */
function relayReadyFor(turn, cfLimit) {
  if (turn.turnSource === 'cloudflare') {
    const usage = S.cfTurnUsage;
    const overLimit = Boolean(usage?.exceeded) && (Number(usage.usedBytes) || 0) >= cfLimit * 1e9;
    return Boolean(S.cfTurnState?.configured) && !overLimit;
  }
  return Boolean(relayServer(turn));
}

/**
 * 设置里的缓存这一块。
 *
 * 取消文件大小上限之后这件事才真正要紧：缓存原来锁死在系统临时目录，于是系统盘
 * 剩 60GB 的机器收不了一部 100GB 的片子，哪怕另一块盘上空着好几 TB。
 * 而且缓存占了多少、能不能清，以前界面上一个字都没有 —— `env:status` 早就把
 * cacheDir 返回了，渲染层从来没读过它。
 */
/**
 * 设置里的「边下边播」「下载位置」两栏：看的片另存一份（见主进程 download:*）。
 * 开关随「保存」生效；下载位置的「换个位置」是个动作按钮，和缓存位置的一样点了立即生效。
 */
function downloadFields() {
  const errorLine = make('div', { className: 'field-error hidden' });
  const dirPath = make('code', { text: S.cachePolicy?.downloadDir || '（未知）' });
  const dirButton = make('button', { className: 'ghost tiny action', text: '换个位置' });
  dirButton.onclick = async () => {
    errorLine.classList.add('hidden');
    const dir = await window.sw.dialog.pickDownloadDir();
    if (!dir) return;
    try {
      S.cachePolicy = await window.sw.download.setDir(dir);
      dirPath.textContent = S.cachePolicy.downloadDir;
      noteSettingsApplied('换了下载位置');
      log(`下载位置已改到 ${S.cachePolicy.downloadDir}`, 'good');
    } catch (error) {
      errorLine.textContent = t(`换不了：${error.message || error}`);
      errorLine.classList.remove('hidden');
    }
  };
  return [
    field(
      '边下边播',
      make('label', { className: 'check' }, [
        make('input', { id: 'set-download', attrs: { type: 'checkbox' }, props: { checked: !!S.settings.downloadWhileWatching } }),
        make('span', { text: '边看边另存一份到下载位置' }),
      ]),
      hint(
        '开着时，你放到的每一部都另存一份：P2P 的片收完并通过扫描后存（可信房间没扫出威胁就存），在线视频在后台另下一份，缓存过的直接复制。',
        '存下来的是你自己的文件，缓存清理不会碰它；这个开关也不改变什么时候开始播。'
      )
    ),
    field('下载位置', make('div', { className: 'cmd-row' }, [dirPath, dirButton, instantTag()]), errorLine),
  ];
}

// 设置弹窗里「管理缓存文件」那张表的刷新函数（cachePolicyFields 建表时挂上），「换个位置」换完要调它
let refreshCacheFileList = null;

/**
 * 设置里的「缓存清理」「长期缓存文件夹」「管理缓存文件」三栏（见主进程 fileStore.setPolicy / mediaLibrary.js）。
 * 缓存清理方式是个普通字段，随底部「保存」生效（见设置的 onOk）；「删除所选」是动作按钮，点了立即生效。
 * 文件列表直接嵌在设置里 —— 设置本身是弹窗，弹窗里再开弹窗要排队到设置关了才出来。
 */
function cachePolicyFields() {
  const policy = S.cachePolicy || { mode: 'auto', keptDir: '' };
  const errorLine = make('div', { className: 'field-error hidden' });
  const showError = (text) => {
    errorLine.textContent = t(text);
    errorLine.classList.remove('hidden');
  };

  const modeSelect = make('select', { id: 'set-cache-mode' }, [
    make('option', { attrs: { value: 'auto' }, text: '自动：关软件时清掉' }),
    make('option', { attrs: { value: 'manual' }, text: '手动：从不自动清，放进长期缓存文件夹' }),
  ]);
  modeSelect.value = policy.mode;

  const keptPath = make('code', { id: 'set-kept-dir', text: policy.keptDir || '（未知）' });

  // 手动清理：登记过的片子一条一行，勾选后删。删掉的找不回来，所以要点两次：第一次只把按钮换成「确认删除」
  const summary = make('span', { text: '正在统计…' });
  const deleteButton = make('button', { className: 'ghost tiny action danger', text: '删除所选', props: { disabled: true } });
  let deleteArmed = false;
  let deleteTimer = null;
  const disarmDelete = () => {
    deleteArmed = false;
    clearTimeout(deleteTimer);
    deleteButton.textContent = t('删除所选');
  };
  const listBox = make('div', { className: 'cache-files' });
  const checked = () => [...listBox.querySelectorAll('input[type="checkbox"]')].filter((box) => box.checked);
  const fileRow = (file) => {
    // 所在的盘这会儿不在（移动硬盘没插）：登记留着，但删不了 —— 等盘插回来再删
    const unavailable = file.available === false;
    const box = make('input', {
      attrs: { type: 'checkbox', 'data-id': file.id },
      props: { disabled: !!file.inUse || unavailable },
    });
    box.onchange = () => {
      deleteButton.disabled = checked().length === 0;
      // 勾选变了，上一次的「确认删除」就不算数了
      disarmDelete();
    };
    return make('label', { className: 'cache-file' }, [
      box,
      make('span', { raw: true, className: 'cache-file-name', text: file.name, attrs: { title: file.path } }),
      make('span', { className: 'cache-file-meta', text: file.kind === 'link' ? '在线视频' : 'P2P' }),
      make('span', { className: 'cache-file-meta', text: file.persistent ? '长期缓存' : '临时缓存' }),
      make('span', { className: 'cache-file-meta', text: fmtBytes(file.size) }),
      file.inUse ? make('span', { className: 'cache-file-meta busy', text: '正在用' }) : null,
      unavailable ? make('span', { className: 'cache-file-meta busy', text: '暂不可用（所在的盘不在）' }) : null,
    ]);
  };
  const refreshList = async () => {
    let files;
    try {
      files = await window.sw.cache.listFiles();
    } catch (error) {
      summary.textContent = t(`统计不出来：${error.message || error}`);
      return;
    }
    const total = files.reduce((sum, file) => sum + (file.size || 0), 0);
    summary.textContent = files.length ? t(`共 ${files.length} 个，${fmtBytes(total)}`) : t('还没有缓存文件');
    replace(listBox, ...files.map(fileRow));
    deleteButton.disabled = true;
    disarmDelete();
  };
  deleteButton.onclick = async () => {
    const ids = checked().map((box) => box.getAttribute('data-id'));
    if (!ids.length) return;
    if (!deleteArmed) {
      deleteArmed = true;
      deleteButton.textContent = t(`确认删除 ${ids.length} 个`);
      deleteTimer = setTimeout(disarmDelete, CONFIRM_WINDOW_MS);
      return;
    }
    disarmDelete();
    errorLine.classList.add('hidden');
    deleteButton.disabled = true;
    try {
      const r = await window.sw.cache.deleteFiles(ids);
      if (r.removed > 0) noteSettingsApplied('删了缓存文件');
      log(`删掉了 ${r.removed} 个缓存文件`, 'good');
      if (r.skipped) log(`${r.skipped} 个正在用，没删`, 'warn');
      if (r.failed) showError(`${r.failed} 个删不掉（可能被别的程序占着）`);
      // 磁盘满时软件自己提示的就是「来这里腾地方」：腾出来了，之前放不下的那几部再试一次
      if (r.removed > 0) retryDiskFull();
    } catch (error) {
      showError(`删不掉：${error.message || error}`);
    }
    refreshList();
  };
  // 同一个弹窗里「换个位置」会清掉本次运行的临时缓存：换完要跟着刷新这张表
  refreshCacheFileList = refreshList;
  refreshList();

  return [
    field(
      '缓存清理',
      modeSelect,
      settingsErrorBox('set-cache-mode-err'),
      hint(
        '自动：收到的片先放在上面的缓存位置，换片、退房都不删，这次运行里再放同一部直接用，关软件时清掉；磁盘不够时先删最久没用的。',
        '手动：收到的片放进长期缓存文件夹，从不自动删，以后再放同一部直接用；磁盘满了会停下来提示你来这里清理。',
        '只影响之后开始接收的片。'
      )
    ),
    field(
      '长期缓存文件夹',
      keptPath,
      hint('手动清理模式下收的片和手动缓存的在线视频放在这里（自动模式下手动缓存的在线视频放在临时缓存里）。它跟着上面的缓存位置走；缓存位置是默认的系统临时目录时，放在本机应用数据目录里，免得被系统的磁盘清理删掉。')
    ),
    field(
      '管理缓存文件',
      make('div', { className: 'cmd-row' }, [summary, deleteButton, instantTag()]),
      listBox,
      errorLine,
      hint('只列出本软件存下的片子，删的也只是这些；正在用的删不了。')
    ),
  ];
}

function cacheField() {
  const pathLine = make('code', { text: S.env?.cacheDir || '（未知）' });
  const usageLine = make('span', { text: '正在统计…' });
  const changeButton = make('button', { className: 'ghost tiny action', text: '换个位置' });
  const purgeButton = make('button', { className: 'ghost tiny action', text: '清理残留' });
  const errorLine = make('div', { className: 'field-error hidden' });
  // 换位置前的确认：本次运行的临时缓存会被立刻清掉（设置本身是弹窗，弹窗里不能再开确认框，就在这一栏里问）
  const confirmLine = make('div', { className: 'field-error hidden' });
  const locked = roomEntered || !!S.swarm;
  let confirmed = false;
  // 「你配置的 X 这次用不了」：换到能用的位置之后就撤掉
  const fallbackLine = S.env?.cacheFallback
    ? make('span', {}, [
        make('br'),
        `你配置的 ${S.env.cacheFallback.configured} 这次用不了（${S.env.cacheFallback.reason}），已临时用回系统临时目录。`,
      ])
    : null;

  /** 本次运行里自动缓存的片（临时条目）有几个、多大：换位置会把它们清掉。读不出来当没有。 */
  const tempCaches = async () => {
    const files = await Promise.resolve(window.sw.cache.listFiles?.()).catch(() => null);
    const temp = (files || []).filter((file) => !file.persistent);
    return { count: temp.length, bytes: temp.reduce((sum, file) => sum + (file.size || 0), 0) };
  };

  const refresh = async () => {
    try {
      const u = await window.sw.cache.usage();
      usageLine.textContent = t(
        u.staleRuns > 0
          ? `本次会话 ${fmtBytes(u.runBytes)} · 上次退出没清掉 ${fmtBytes(u.staleBytes)}`
          : `本次会话 ${fmtBytes(u.runBytes)}`
      );
      purgeButton.classList.toggle('hidden', u.staleRuns === 0);
    } catch (error) {
      usageLine.textContent = t(`统计不出来：${error.message || error}`);
    }
  };
  refresh();

  changeButton.disabled = locked;
  changeButton.onclick = async () => {
    errorLine.classList.add('hidden');
    if (!confirmed) {
      const temp = await tempCaches();
      if (temp.count) {
        // 先说清楚会丢什么，再点一次才真换
        confirmed = true;
        confirmLine.textContent = t(
          `换位置会立刻清掉本次运行里缓存的 ${temp.count} 个文件（${fmtBytes(temp.bytes)}），再放要重新接收。确定要换就再点一次「换个位置」。`
        );
        confirmLine.classList.remove('hidden');
        return;
      }
    }
    confirmed = false;
    confirmLine.classList.add('hidden');
    const dir = await window.sw.dialog.pickCacheDir();
    if (!dir) return;
    try {
      const r = await window.sw.cache.setRoot(dir);
      pathLine.textContent = r.cacheDir;
      S.env.cacheDir = r.cacheDir;
      // 主进程换位置时已经把「配置的目录这次用不了」清掉了，这里照抄，提示跟着撤
      S.env.cacheFallback = r.fallback || null;
      if (!S.env.cacheFallback) fallbackLine?.remove();
      noteSettingsApplied('换了缓存位置');
      log(`缓存目录已改到 ${r.cacheDir}`, 'good');
      refresh();
      // 旧运行目录连同临时缓存一起清掉了：「管理缓存文件」那张表跟着刷新
      refreshCacheFileList?.();
      // 长期缓存文件夹跟着缓存位置走
      const policy = await Promise.resolve(window.sw.cache.policy?.()).catch(() => null);
      if (policy) {
        S.cachePolicy = policy;
        const kept = $('set-kept-dir');
        if (kept) kept.textContent = policy.keptDir;
      }
    } catch (error) {
      errorLine.textContent = t(`换不了：${error.message || error}`);
      errorLine.classList.remove('hidden');
    }
  };

  purgeButton.onclick = async () => {
    try {
      const { removed } = await window.sw.cache.purge();
      if (removed > 0) noteSettingsApplied('清理了残留缓存');
      log(`清掉了 ${removed} 处残留缓存`, 'good');
      refresh();
      // 腾出了空间：之前放不下的那几部再试一次
      if (removed > 0) retryDiskFull();
    } catch (error) {
      errorLine.textContent = t(`清不掉：${error.message || error}`);
      errorLine.classList.remove('hidden');
    }
  };

  return field(
    '缓存位置',
    make('div', { className: 'cmd-row' }, [pathLine, changeButton, purgeButton, instantTag()]),
    usageLine,
    confirmLine,
    errorLine,
    hint(
      locked ? '放映进行中不能换位置，退出房间后可改。' : '自动清理模式下，接收到的片子放在这里，关软件时清掉。',
      '换到空间大的盘上，才收得下大文件。',
      '换位置会立刻清掉本次运行里自动缓存的片，长期缓存文件夹里的不动。',
      // 让用户指定任意目录，最大的顾虑就是「会不会把我原来的东西删了」
      '清理只认本软件自己建的目录，同目录下你自己的文件一个都不会动。',
      ...(fallbackLine ? [fallbackLine] : [])
    )
  );
}

/**
 * 设置里 TURN 那一段：来源（自己填 / Cloudflare 自动生成）、两种来源各自的字段、「隐藏我的 IP」。
 *
 * Cloudflare 的 API Token 只进不出：输入框从不预填，「验证并保存」成功后当场清空，
 * 之后界面上只显示状态（已配置、临时账号有效到几点、出了什么错）和本月用量。
 */
function turnSettingsFields() {
  const cf = S.settings.turnSource === 'cloudflare';
  // 密码默认遮住：放映时常开着屏幕共享，设置一开就把中继密码亮给所有人看了。要核对就点「显示」
  const turnPassword = make('input', {
    id: 'set-turn-pass',
    attrs: { type: 'password', placeholder: '密码', autocomplete: 'new-password', spellcheck: 'false' },
    props: { value: S.settings.turnPass },
  });
  const passToggle = make('button', { className: 'ghost tiny', text: '显示', attrs: { type: 'button' } });
  passToggle.onclick = () => {
    const reveal = turnPassword.type === 'password';
    turnPassword.type = reveal ? 'text' : 'password';
    passToggle.textContent = t(reveal ? '隐藏' : '显示');
  };
  const passRow = make('div', { className: 'pass-row' }, [turnPassword, passToggle]);

  const manualGroup = make('div', { id: 'set-turn-manual', className: cf ? 'hidden' : '' }, [
    make('div', { className: 'field' }, [
      make('label', { className: 'check' }, [
        make('input', {
          id: 'set-turn-on',
          attrs: { type: 'checkbox' },
          props: { checked: S.settings.turnEnabled },
        }),
        '启用 TURN 中继兜底',
      ]),
    ]),
    field(
      'TURN 地址',
      make('input', {
        id: 'set-turn-url',
        attrs: { type: 'text', placeholder: 'turn:example.com:3478' },
        props: { value: S.settings.turnUrl },
      }),
      hint('会自动同时尝试 UDP 和 TCP —— 酒店、公司和校园网经常只放行 TCP。')
    ),
    field(
      'TURN 用户名 / 密码',
      make('input', {
        id: 'set-turn-user',
        attrs: { type: 'text', placeholder: '用户名' },
        props: { value: S.settings.turnUser },
      }),
      passRow
    ),
    // 手填那几栏的报错就写在这一组底下
    settingsErrorBox('set-turn-err'),
  ]);

  const cfResult = make('p', { id: 'set-cf-result', className: 'fine' });
  const cfSave = make('button', { id: 'set-cf-save', className: 'ghost action', text: '验证并保存' });
  cfSave.onclick = () => saveCfTurnCredentials(cfSave, cfResult);
  // 「清除」删掉本机加密保存的 Token，撤不回：危险样式、和「验证并保存」拉开，点两次才真删（见 clearCfTurnCredentials）
  const cfClear = make('button', { id: 'set-cf-clear', className: 'ghost action danger', text: '清除' });
  cfClear.onclick = () => clearCfTurnCredentials(cfClear, cfResult);
  const cfWarn = make('p', { id: 'set-cf-warn', className: 'fine hidden' });
  cfWarn.style.color = 'var(--warn)';
  const cfGroup = make('div', { id: 'set-turn-cf', className: cf ? '' : 'hidden' }, [
    field(
      'Turn Token ID',
      make('input', { id: 'set-cf-key', attrs: { type: 'text', autocomplete: 'off', spellcheck: 'false' } })
    ),
    field(
      'API Token',
      // 只进不出：从不预填，保存成功就清空
      make('input', { id: 'set-cf-token', attrs: { type: 'password', autocomplete: 'new-password', spellcheck: 'false' } }),
      hint(
        '在 Cloudflare 后台 Realtime → TURN Server 新建一个 Key，把 Turn Token ID 和 API Token 填进来，点「验证并保存」。',
        'API Token 加密保存在本机，只有 NoxReel 的主进程拿它向 Cloudflare 换 24 小时有效的临时账号，界面上不会再显示。'
      )
    ),
    make('div', { className: 'cf-actions' }, [cfSave, instantTag(), cfClear]),
    cfResult,
    make('p', { id: 'set-cf-status', className: 'fine', text: cfTurnStatusText() }),
    field(
      'Cloudflare TURN 月用量上限',
      make('label', { className: 'check' }, [
        '每月最多用',
        make('input', {
          id: 'set-cf-limit',
          attrs: { type: 'number', min: 1, max: 1000, step: 1 },
          props: { value: String(S.cfTurnUsage?.limitGB || 900) },
          style: { width: '6em' },
        }),
        'GB（本机统计）',
      ]),
      make('p', { id: 'set-cf-usage', className: 'fine', text: cfUsageText() }),
      cfWarn,
      hint(
        '到上限就不再用 Cloudflare TURN（为免扣费），下个月 1 日（UTC）自动恢复；已经连着的不会被断开。',
        '这是本机统计，和 Cloudflare 账单可能有出入；建议另外在 Cloudflare 后台 Manage Account → Billing → Billable Usage 建一个 Budget alert 做兜底。'
      )
    ),
    // Cloudflare 这一组的报错（凭据填了没保存、月上限写错）
    settingsErrorBox('set-cf-err'),
  ]);

  const pickSource = () => {
    const useCf = $('set-turn-source-cf').checked;
    manualGroup.classList.toggle('hidden', useCf);
    cfGroup.classList.toggle('hidden', !useCf);
    // 换了来源：藏起来那一组的报错跟着收起，「没有中继」的提醒也按新来源重新判断
    clearSettingsErrors();
    relayOnlyWarned = false;
  };
  const sourceRadio = (value, checked) => ({
    attrs: { type: 'radio', name: 'set-turn-source', value },
    props: { checked, onchange: pickSource },
  });

  return [
    field(
      'TURN 中继',
      hint(
        '双方都在严格 NAT（CGNAT、卫星网络）后面时，打洞会失败，这时数据要经过中继转发。',
        '中继会看到加密后的流量并产生带宽成本，所以需要你自己提供服务器 —— 我们不代运营。'
      ),
      make('p', { className: 'fine sub-title', text: 'TURN 来源' }),
      make('label', { className: 'check' }, [
        make('input', { id: 'set-turn-source-manual', ...sourceRadio('manual', !cf) }),
        '自己填',
      ]),
      make('label', { className: 'check' }, [
        make('input', { id: 'set-turn-source-cf', ...sourceRadio('cloudflare', cf) }),
        'Cloudflare 自动生成',
      ])
    ),
    manualGroup,
    cfGroup,
    make('div', { className: 'field' }, [
      make('label', { className: 'check' }, [
        make('input', {
          id: 'set-relay-only',
          attrs: { type: 'checkbox' },
          props: {
            checked: S.settings.relayOnly,
            // 开关动过了：「没有中继」的提醒按新状态重新判断
            onchange: () => {
              relayOnlyWarned = false;
              clearSettingsErrors();
            },
          },
        }),
        '隐藏我的 IP（只经 TURN 中继连接）',
      ]),
      hint(
        '打开后，房间里的人只能看到 TURN 服务器的地址，看不到你的 IP。',
        '需要先配好 TURN（自己填，或用 Cloudflare 自动生成）；TURN 用不了时会连不上，不会退回直连。只影响之后新建的连接。'
      ),
      settingsErrorBox('set-relay-only-err'),
    ]),
  ];
}

/**
 * 「验证并保存」：Token 交给主进程验证、加密保存；成功后输入框清空，只显示「已保存」。
 *
 * 这是个动作按钮，点了当场生效：表单上选的来源是 Cloudflare 的话，来源也一并存下。以前只存凭据、
 * 显示「已保存」，来源要等底部「保存」—— 用户以为配好了、点了取消，Cloudflare TURN 就一直没被用上。
 */
async function saveCfTurnCredentials(button, result) {
  const keyInput = $('set-cf-key');
  const tokenInput = $('set-cf-token');
  const keyId = keyInput.value.trim();
  const apiToken = tokenInput.value.trim();
  if (!keyId || !apiToken) {
    result.textContent = t('Turn Token ID 和 API Token 都要填。');
    return;
  }
  button.disabled = true;
  result.textContent = t('正在向 Cloudflare 验证…');
  try {
    const state = await window.sw.turn.cfSave(keyId, apiToken);
    keyInput.value = '';
    tokenInput.value = '';
    // 换了凭据：手上那组临时账号作废，下次连接前现取（主进程验证时已经顺手缓存了一组）
    S.cfTurn = null;
    cfTurnRetryAt = 0;
    applyCfTurnState(state);
    noteSettingsApplied('保存了 Cloudflare 凭据');
    const switched = Boolean($('set-turn-source-cf')?.checked) && S.settings.turnSource !== 'cloudflare';
    if (switched) {
      S.settings.turnSource = 'cloudflare';
      localStorage.setItem('sw.turnSource', S.settings.turnSource);
      noteSettingsApplied('TURN 来源改成了「Cloudflare 自动生成」');
    }
    result.textContent = t(switched ? '已保存，TURN 来源已改成 Cloudflare 自动生成' : '已保存');
    if (S.settings.turnSource === 'cloudflare') {
      scheduleCfTurnRefresh();
      ensureTurnReady().catch(() => {});
      // 邀请卡之前因为没有中继被拦下的：账号在取了，按原来的方式重来一次
      retryBlockedInvite();
    }
  } catch (error) {
    result.textContent = t(`没保存：${cfErrorText(cfErrorCode(error))}`);
  } finally {
    button.disabled = false;
  }
}

// 「清除」点第一次之后，到这个时刻之前再点一次才真删
let cfClearArmedUntil = 0;

/**
 * 「清除」：删掉本机加密保存的 Cloudflare 凭据，立即生效、撤不回。
 * Token 只在 Cloudflare 新建 Key 时显示一次，没另外留底的话就得去后台新建一个 Key，所以要点两次：
 * 第一次只把后果说清楚、按钮换成「确认清除」，几秒内再点才真删。还没存过凭据时没什么可删的，不用确认。
 */
async function clearCfTurnCredentials(button, result) {
  if (S.cfTurnState?.configured && Date.now() >= cfClearArmedUntil) {
    const armedUntil = Date.now() + CONFIRM_WINDOW_MS;
    cfClearArmedUntil = armedUntil;
    button.textContent = t('确认清除');
    const cfSource = $('set-turn-source-cf')?.checked ?? S.settings.turnSource === 'cloudflare';
    const relayOnly = $('set-relay-only')?.checked ?? S.settings.relayOnly;
    const warning = t(
      '再点一次「确认清除」才会删掉本机保存的 Cloudflare 凭据。之后要重新填 API Token 才能再用 —— Cloudflare 只在新建 Key 时显示一次 Token，没另外留底的话得去后台新建一个 Key。'
    );
    result.textContent =
      cfSource && relayOnly ? `${warning} ${t('「隐藏我的 IP」开着：清除之后新建的连接会被拦下，已经连着的不受影响。')}` : warning;
    setTimeout(() => {
      if (cfClearArmedUntil !== armedUntil) return;
      cfClearArmedUntil = 0;
      button.textContent = t('清除');
      result.textContent = '';
    }, CONFIRM_WINDOW_MS);
    return;
  }
  cfClearArmedUntil = 0;
  button.textContent = t('清除');
  const had = Boolean(S.cfTurnState?.configured);
  try {
    const state = await window.sw.turn.cfClear();
    S.cfTurn = null;
    scheduleCfTurnRefresh();
    applyCfTurnState(state);
    if (had) noteSettingsApplied('清除了 Cloudflare 凭据');
    result.textContent = t('已清除');
  } catch (error) {
    result.textContent = t(`没清掉：${error.message || error}`);
  }
}

/**
 * 房间安全模式现在能不能改。进了房、建了 Swarm 自然不行；房主从选片到进房这段也不行 ——
 * 准备片子时按开房那一刻的模式做的决定（安全模式下 moov 在文件尾的 MP4 可以原样传、
 * 可信房间才测上行），模式中途一改，这些决定就对不上了。
 */
function securityModeLocked() {
  return roomEntered || !!S.swarm || S.role === 'host';
}

$('btn-settings').onclick = () => {
  openModal({
    title: '设置',
    body: () => {
      const modeLocked = securityModeLocked();
      const languageLocked = roomEntered || S.role !== null;
      // 这一次打开设置：当场生效的动作从头记，「没有中继」的提醒也重新来
      settingsApplied = new Set();
      relayOnlyWarned = false;
      // 设置页开着时顺手把 Cloudflare TURN 的状态和本月用量刷一遍
      refreshCfTurnState();
      // Discord 的两个子选项跟着总开关：总开关关着时勾了也不起作用，就别让它能勾
      // （偏好照样保留、照样保存，打开总开关时生效）
      const discordOn = make('input', { id: 'set-discord-on', attrs: { type: 'checkbox' }, props: { checked: S.discord.enabled } });
      const discordTitle = make('input', {
        id: 'set-discord-title',
        attrs: { type: 'checkbox' },
        props: { checked: S.discord.showTitle, disabled: !S.discord.enabled },
      });
      const discordJoin = make('input', {
        id: 'set-discord-join',
        attrs: { type: 'checkbox' },
        props: { checked: S.discord.showJoin, disabled: !S.discord.enabled },
      });
      discordOn.onchange = () => {
        discordTitle.disabled = !discordOn.checked;
        discordJoin.disabled = !discordOn.checked;
      };
      return [
        // 保存语义说在最前面：字段等「保存」，动作按钮当场生效
        make('p', {
          className: 'fine settings-note',
          text: '改动点底部「保存」才生效；标着「立即生效」的按钮除外，点了当场生效，「取消」也撤不回。',
        }),
        field(
          '界面语言',
          make(
            'select',
            { id: 'set-language', props: { disabled: languageLocked } },
            [
              make('option', {
                attrs: { value: 'zh-CN' },
                props: { selected: S.settings.language !== 'en' },
                text: '中文（简体）',
              }),
              make('option', {
                attrs: { value: 'en' },
                props: { selected: S.settings.language === 'en' },
                text: 'English',
              }),
            ]
          ),
          hint(
            languageLocked
              ? '切换语言会重新载入首页；房间进行中不可切换。'
              : '切换语言会重新载入首页；房间进行中不可切换。'
          )
        ),
        field(
          '你的昵称',
          make('input', {
            id: 'set-name',
            attrs: { type: 'text', maxlength: 40 },
            props: { value: S.name },
          }),
          // 房间里也能改：applyMyName 会经 NAME 消息告诉连着的人，并同步 Swarm、SyncEngine 里的名字
          hint('只保存在这台电脑上。房间里有人同名时，名字后面会临时加上编号。')
        ),
        field(
          '房间安全模式',
          make(
            'select',
            {
              id: 'set-security-mode',
              props: { disabled: modeLocked },
            },
            [
              make('option', {
                attrs: { value: 'safe' },
                props: { selected: S.settings.securityMode !== 'trusted' },
                text: '安全模式（完整接收后播放）',
              }),
              make('option', {
                attrs: { value: 'trusted' },
                props: { selected: S.settings.securityMode === 'trusted' },
                text: '可信房间（默认，边下边播）',
              }),
            ]
          ),
          hint(
            modeLocked
              ? roomEntered || S.swarm
                ? '房间进行中不能切换。退出后可更改。'
                : '正在准备开房，这时不能切换。回到首页后可更改。'
              : '房主和每位加入者必须分别选择相同模式才能握手。安全模式完整接收并扫描后播放；可信房间约 8 MB 片头就绪后边下边播。'
          )
        ),
        field(
          '信令服务器',
          make('input', {
            id: 'set-signal',
            attrs: { type: 'text' },
            props: { value: S.settings.signalUrl },
          }),
          hint('只转发连接地址，不接触视频内容。自己跑一个：', make('code', { text: 'npm run signal' }))
        ),
        field(
          '公共中继（房间链接用）',
          make('textarea', {
            id: 'set-relays',
            attrs: { rows: 2, placeholder: DEFAULT_RELAYS.slice(0, 3).join('\n') + '\n…' },
            props: { value: S.settings.relays },
          }),
          settingsErrorBox('set-relays-err'),
          hint(
            '房间链接经这些公共 Nostr 中继交换加密后的连接信息，视频不经过它们。',
            '留空用内置的一组；想换就每行写一个 wss:// 地址，你当房主时这份列表会写进房间链接。'
          )
        ),
        make('div', { className: 'field' }, [
          make('label', { text: 'Discord 状态' }),
          make('label', { className: 'check' }, [discordOn, '在 Discord 上显示我在放映']),
          make('label', { className: 'check sub-check' }, [discordTitle, '显示片名']),
          make('label', { className: 'check sub-check' }, [discordJoin, '显示「加入放映」按钮（用房间链接时）']),
          hint(
            '你所有的 Discord 好友都能在你的资料上看到，点「加入放映」就能进房。',
            '需要电脑上开着 Discord 客户端，网页版不行。'
          ),
          make('p', { className: 'fine', id: 'set-discord-status', text: discordStatusText() }),
        ]),
        field(
          '新房间默认人数上限（2–16）',
          make('input', {
            id: 'set-capacity',
            attrs: { type: 'number', min: 2, max: 16 },
            props: { value: String(storedCapacity()) },
          }),
          hint(
            roomEntered || S.role === 'guest'
              ? '只影响以后新开的房间；这个房间的人数上限请在邀请区调整。'
              : '进入房间后，房主也可以在邀请区实时调整。'
          )
        ),
        field(
          'STUN 服务器',
          make('input', {
            id: 'set-stun',
            attrs: { type: 'text' },
            props: { value: S.settings.stun },
          }),
          hint(
            '用来发现自己的公网地址，不传数据。',
            '留一条地址时会自动再挂两台备用服务器兜底；想自己管这个列表就用逗号或空格分隔多写几条，那样只用你写的。'
          )
        ),
        ...turnSettingsFields(),
        ...downloadFields(),
        cacheField(),
        ...cachePolicyFields(),
        field(
          '遇到问题时',
          copyDiagnosticsButton(),
          hint(
            `当前版本 ${S.env?.version || '未知'}`,
            '。诊断信息里只有运行环境和连接状态，不含文件路径和片名。'
          )
        ),
      ];
    },
    okText: '保存',
    onOk: async () => {
      // 报错一律写在出错那一栏底下，并滚过去、聚焦出错的输入框（settingsFail）
      clearSettingsErrors();
      // TURN 地址写错了要当场说。以前这里只 trim()，而 ice.js 对认不出的地址是
      // 静默丢弃 —— 用户会看到「启用 TURN 中继」勾得好好的，实际一条中继都没有，
      // 到连不上那一刻也没人告诉他为什么。
      const turnRaw = $('set-turn-url').value.trim();
      const turnCheck = normalizeTurnInput(turnRaw);
      const turnSource = $('set-turn-source-cf').checked ? 'cloudflare' : 'manual';
      // 这次没动过 TURN 那几栏：「勾着但没填地址」是新装时的默认状态（等于没配），
      // 为此拦下别的设置（昵称、边下边播……）的保存就说不过去了。动过才查缺地址、缺凭据
      const turnTouched =
        $('set-turn-on').checked !== S.settings.turnEnabled ||
        turnRaw !== (S.settings.turnUrl || '') ||
        $('set-turn-user').value.trim() !== (S.settings.turnUser || '') ||
        $('set-turn-pass').value.trim() !== (S.settings.turnPass || '');
      // 手动那套字段只在来源是「自己填」时才生效，也只在那时才查
      if (turnSource === 'manual') {
        if (turnCheck.invalid.length) {
          settingsFail('set-turn-err', `这些 TURN 地址认不出来：${turnCheck.invalid.join('、')}。地址要形如 turn:example.com:3478`, 'set-turn-url');
          return false;
        }
        // 53 端口会被浏览器拦下，留着它只会让候选收集干等到超时
        if (turnCheck.blocked.length) {
          settingsFail(
            'set-turn-err',
            `这些 TURN 地址用的是 53 端口，浏览器会拦下这个端口：${turnCheck.blocked.join('、')}。换一个端口，常见的是 3478 或 443`,
            'set-turn-url'
          );
          return false;
        }
        if (turnTouched && $('set-turn-on').checked && !turnRaw) {
          settingsFail('set-turn-err', '勾了启用 TURN 中继，但地址是空的 —— 这样等于没配。填一个地址，或者把勾去掉。', 'set-turn-url');
          return false;
        }
        // 缺用户名或密码的中继，浏览器会连整个连接对象一起拒掉（邀请、加入全都失败），得当场拦下
        if (turnTouched && $('set-turn-on').checked && (!$('set-turn-user').value.trim() || !$('set-turn-pass').value.trim())) {
          settingsFail(
            'set-turn-err',
            'TURN 中继要填用户名和密码（中继服务器靠它们认人）。没有的话把「启用 TURN 中继」的勾去掉。',
            $('set-turn-user').value.trim() ? 'set-turn-pass' : 'set-turn-user'
          );
          return false;
        }
      }
      // Cloudflare 那一组同理，只在来源是它时才查：来源是「自己填」时那一组藏着，报错指过去用户也看不见、改不了。
      // 月上限也只在这时才提交（见下面的 cfSetLimit）
      const cfLimit = Number($('set-cf-limit').value);
      if (turnSource === 'cloudflare') {
        // Cloudflare 凭据只能经「验证并保存」按钮进主进程；填了没保存就点确定，得说一声，别让人以为存上了
        if ($('set-cf-key').value.trim() || $('set-cf-token').value.trim()) {
          settingsFail(
            'set-cf-err',
            'Cloudflare 凭据还没保存：先点「验证并保存」，或者把这两个框清空。',
            $('set-cf-key').value.trim() ? 'set-cf-key' : 'set-cf-token'
          );
          return false;
        }
        if (!Number.isInteger(cfLimit) || cfLimit < 1 || cfLimit > 1000) {
          settingsFail('set-cf-err', 'Cloudflare TURN 每月上限要填 1 到 1000 之间的整数（GB）。', 'set-cf-limit');
          return false;
        }
      }
      // 中继地址逐条用 URL 解析：照 STUN 那栏的习惯用逗号隔开的也认，拆开存成一行一个
      const relayLines = $('set-relays').value.split(/[\s,，、]+/).filter(Boolean);
      const badRelays = relayLines.filter((line) => !isRelayUrl(line));
      if (badRelays.length) {
        settingsFail('set-relays-err', `这些中继地址认不出来：${badRelays.join('、')}。地址要形如 wss://relay.example.com`, 'set-relays');
        return false;
      }
      // 打开「隐藏我的 IP」、改了 TURN 却还没有能用的中继：之后新建的连接会一律被拦下。
      // 保存前先说一声（再点一次「保存」照存），别等到开完房、进了房间才在邀请卡上看到红字
      const relayOnly = $('set-relay-only').checked;
      const nextTurn = {
        turnSource,
        turnEnabled: $('set-turn-on').checked,
        turnUrl: turnCheck.urls.join(' '),
        turnUser: $('set-turn-user').value.trim(),
        turnPass: $('set-turn-pass').value.trim(),
      };
      const relayOnlyNews = !S.settings.relayOnly || turnSource !== S.settings.turnSource || turnTouched;
      if (relayOnly && relayOnlyNews && !relayOnlyWarned && !relayReadyFor(nextTurn, cfLimit)) {
        relayOnlyWarned = true;
        settingsFail(
          'set-relay-only-err',
          '现在还没有能用的 TURN 中继：「隐藏我的 IP」打开之后，新建的连接会一律被拦下，直到配好 TURN。确定这样保存就再点一次「保存」。',
          'set-relay-only'
        );
        return false;
      }
      // 缓存清理方式：主进程说了算，改不成就停在这里（别的设置也先不存），报错写在下拉框底下
      const cacheMode = $('set-cache-mode')?.value;
      if (cacheMode && cacheMode !== (S.cachePolicy?.mode || 'auto')) {
        try {
          S.cachePolicy = await window.sw.cache.setMode(cacheMode);
        } catch (error) {
          settingsFail('set-cache-mode-err', `改不了：${error.message || error}`, 'set-cache-mode');
          return false;
        }
        log(
          S.cachePolicy.mode === 'manual'
            ? '缓存改成手动清理：之后收的片放进长期缓存文件夹，不再自动删'
            : '缓存改成自动清理：之后收的片关软件时清掉',
          'good'
        );
      }
      // 漏了 turn: 前缀是最常见的写法错误，意思很清楚，直接补上
      if (turnCheck.fixed.length) $('set-turn-url').value = turnCheck.urls.join(' ');
      const languageLocked = roomEntered || S.role !== null;
      const nextLanguage = languageLocked ? S.settings.language : $('set-language').value;
      const languageChanged = nextLanguage !== S.settings.language;
      if (!languageLocked) {
        S.settings.language = setLocale(nextLanguage);
      }
      // 昵称清空了就保留原来的；房间里改的会告诉连着的人（见 applyMyName）
      applyMyName($('set-name').value);
      // 锁着的时候（进了房、建了 Swarm、正在准备开房）一律不改：房主准备片子时按的是开房那一刻的模式，
      // 中途改了会让「安全模式下原样传的 moov 在尾 MP4」混进可信房间
      if (!securityModeLocked()) {
        S.settings.securityMode = normalizeSecurityMode($('set-security-mode').value);
      }
      S.settings.signalUrl = $('set-signal').value.trim();
      S.settings.relays = relayLines.join('\n');
      saveCapacitySetting($('set-capacity').value);
      S.settings.stun = $('set-stun').value.trim();
      const downloadWasOn = S.settings.downloadWhileWatching;
      S.settings.downloadWhileWatching = $('set-download').checked;
      localStorage.setItem('sw.downloadWhileWatching', S.settings.downloadWhileWatching ? '1' : '0');
      // 放到一半才打开的：正在放的这一部也算「看了」，一样存
      if (!downloadWasOn && S.settings.downloadWhileWatching && roomEntered) wantDownload(S.current);
      S.settings.turnEnabled = $('set-turn-on').checked;
      S.settings.turnUrl = $('set-turn-url').value.trim();
      S.settings.turnUser = $('set-turn-user').value.trim();
      S.settings.turnPass = $('set-turn-pass').value.trim();

      localStorage.setItem('sw.name', S.name);
      localStorage.setItem('sw.securityMode', S.settings.securityMode);
      localStorage.setItem('sw.signalUrl', S.settings.signalUrl);
      localStorage.setItem('sw.relays', S.settings.relays);
      S.discord = {
        enabled: $('set-discord-on').checked,
        showTitle: $('set-discord-title').checked,
        showJoin: $('set-discord-join').checked,
      };
      savePresenceSettings(S.discord);
      updatePresence();
      localStorage.setItem('sw.stun', S.settings.stun);
      localStorage.setItem('sw.turnEnabled', S.settings.turnEnabled ? '1' : '0');
      localStorage.setItem('sw.turnUrl', S.settings.turnUrl);
      localStorage.setItem('sw.turnUser', S.settings.turnUser);
      localStorage.setItem('sw.turnPass', S.settings.turnPass);
      // TURN 来源和「隐藏我的 IP」。Cloudflare 的 API Token 不在这里 —— 它只存在主进程里
      const sourceChanged = turnSource !== S.settings.turnSource;
      S.settings.turnSource = turnSource;
      S.settings.relayOnly = $('set-relay-only').checked;
      localStorage.setItem('sw.turnSource', S.settings.turnSource);
      localStorage.setItem('sw.relayOnly', S.settings.relayOnly ? '1' : '0');
      if (sourceChanged) {
        scheduleCfTurnRefresh();
        cfTurnRetryAt = 0;
        ensureTurnReady().catch(() => {});
      }
      if (turnSource === 'cloudflare' && cfLimit !== S.cfTurnUsage?.limitGB) {
        window.sw.turn
          .cfSetLimit(cfLimit)
          .then(applyCfUsage)
          .catch((error) => log(`Cloudflare TURN 月上限没改成：${error.message || error}`, 'bad'));
      }
      // 邀请卡之前因为没有中继被拦下的：TURN 或开关改了，按原来的邀请方式重来一次
      retryBlockedInvite();
      // 切到安全模式时依赖胶囊要重算 —— Defender 用不了这件事只在安全模式下算缺件。
      updateDepsPill();
      settingsApplied = null;
      if (languageChanged) setTimeout(() => location.reload(), 0);
      return true;
    },
    // 点了「取消」：字段的改动都丢掉；已经当场生效的动作撤不回，说清楚是哪些
    onCancel: () => {
      const applied = settingsApplied;
      settingsApplied = null;
      noticeSettingsApplied(applied);
    },
  });
};

/**
 * 设置里的「新房间默认人数上限」。
 *
 * 房间里（和正在加入别人的房间时）S.roomCapacity 就是这个房间实际的上限：顶栏、邀请区的余量、
 * 一对一邀请判满员、写进链接的 maxMembers 都读它，而真正拦人的是信令那边的 maxMembers。
 * 在这里改它会绕过 applyRoomCapacity 的「不能低于当前人数」，信令也不知道，
 * 界面上的上限和实际放人的上限从此对不上。所以那时只存成以后开房的默认值。
 */
function saveCapacitySetting(raw) {
  const value = clampCapacity(raw);
  localStorage.setItem('sw.roomCapacity', String(value));
  if (!roomEntered && S.role !== 'guest') S.roomCapacity = value;
}

/*
 * 弹窗一次只显示一个，后来的排队。房间里加片时，几部片各自的「传哪个版本」「会不会卡」
 * 可能前后脚冒出来，直接覆盖的话，被顶掉的那个的 Promise 永远等不到结果，准备流程就卡死了。
 */
const modalQueue = [];
let modalCurrent = null;

/**
 * @returns {{done: Promise<boolean>, cancel: () => void}}
 *   done 在这个弹窗关掉时兑现（确定为 true，取消为 false）；
 *   cancel() 撤掉还在排队或正在显示的弹窗，走它自己的 onCancel。
 */
function openModal(options) {
  let resolveDone;
  const entry = {
    options,
    closed: false,
    done: new Promise((resolve) => {
      resolveDone = resolve;
    }),
  };
  entry.resolve = resolveDone;
  entry.cancel = () => finishModal(entry, false);
  modalQueue.push(entry);
  if (!modalCurrent) showNextModal();
  return entry;
}

function showNextModal() {
  modalCurrent = modalQueue.shift() || null;
  if (!modalCurrent) {
    $('modal').classList.add('hidden');
    return;
  }
  const { title, body, okText = '确定' } = modalCurrent.options;
  $('modal-title').textContent = title;
  const content = typeof body === 'function' ? body() : body;
  replace('modal-body', ...(Array.isArray(content) ? content : [content]));
  $('modal-ok').textContent = okText;
  // 上一次点击留下的焦点会让紧接着的 Enter / 空格直接确认下一个弹窗
  $('modal-ok').blur?.();
  $('modal').classList.remove('hidden');
}

function finishModal(entry, ok) {
  if (entry.closed) return;
  entry.closed = true;
  if (!ok) entry.options.onCancel?.();
  entry.resolve(ok);
  if (modalCurrent === entry) {
    showNextModal();
    return;
  }
  const i = modalQueue.indexOf(entry);
  if (i !== -1) modalQueue.splice(i, 1);
}

// 弹窗是排队显示的：第一次点击在微任务里就把下一个弹窗换进了同一套 DOM，双击的第二下
// 会落在新弹窗的按钮上，把用户根本没看过的选项按默认确认掉（比如替他选了「无损精简」）。
$('modal-ok').onclick = async (e) => {
  if (e?.detail > 1) return;
  const entry = modalCurrent;
  if (!entry) return;
  const r = entry.options.onOk ? await entry.options.onOk() : true;
  if (r !== false) finishModal(entry, true);
};
$('modal-cancel').onclick = (e) => {
  if (e?.detail > 1) return;
  if (modalCurrent) finishModal(modalCurrent, false);
};

window.addEventListener('resize', drawChunkMap);
window.addEventListener('beforeunload', () => {
  S.signaling?.close();
  S.swarm?.destroy();
});

window.sw.app.onShutdownRequested(() => {
  S.signaling?.close();
  S.swarm?.destroy();
});

/*
 * 深链接（在浏览器、Discord 里点开的邀请）。
 *
 * 一次只处理一条，处理期间再来的只留最新那条；开始一次加入之后至少隔 INVITE_LINK_GAP_MS 才接下一条。
 * 网页能不停地拉起 noxreel:// 链接，每一条都去连一遍信令、弹一个框的话，界面就被它拖死了。
 */
const INVITE_LINK_GAP_MS = 1500;
const INVITE_STASH_KEY = 'sw.pendingInvite';
const inviteLinks = { pending: null, running: false, confirm: null };

async function openInviteLink(raw) {
  if (!raw) return;
  inviteLinks.pending = String(raw);
  if (inviteLinks.running) return;
  inviteLinks.running = true;
  try {
    while (inviteLinks.pending) {
      const next = inviteLinks.pending;
      inviteLinks.pending = null;
      const started = await routeInviteLink(next);
      if (started && inviteLinks.pending) await delay(INVITE_LINK_GAP_MS);
    }
  } finally {
    inviteLinks.running = false;
  }
}

/** 一条深链接该怎么处理。开始了一次加入时返回 true。 */
async function routeInviteLink(raw) {
  try {
    const payload = await decodeCode(raw);
    if (payload.k === 'answer' && S.role === 'host' && S.pendingManualPeer) {
      await acceptManualAnswer(raw);
      return false;
    }
    if (S.leaving) {
      // 正在退房，页面马上刷新：记下来，刷新之后接着打开
      stashInvite(raw);
      return false;
    }
    if (roomEntered) {
      if (payload.k === 'answer') {
        // 应答链接和「换一个房间」无关，别叫人退房（房主照做就把整场散了）。等着它的房主上面已经接走了；
        // 走到这里的是房主又点了一次用过的（交给 acceptManualAnswer 说「已经用过或已失效」），
        // 或者观众点开了自己复制的那条
        if (S.role === 'host') await acceptManualAnswer(raw);
        else log('这是一个应答链接，应该由发起方打开。', 'warn');
      } else if (payload.from && payload.from === S.hostId) {
        log('你已经在这个房间里了。', 'warn');
      } else {
        // 不能静默拆掉正在进行的房间：问一句，由用户决定
        askSwitchForInvite(raw, 'room');
      }
      return false;
    }
    if (joinAttempt.busy?.kind === 'host') {
      askSwitchForInvite(raw, 'host');
      return false;
    }
    if (payload.k === 'room' || payload.k === 'relay' || payload.k === 'offer') {
      if (joiningWith(inviteKey(payload))) {
        show('view-prepare');
        return false;
      }
      // 换了一条邀请：正在进行的加入先干净地取消（信令、连接、房主身份一并拆掉），再开始这一条
      resetAttempt();
    } else if (joinAttempt.busy) {
      // 应答链接（多半是自己复制完顺手点了一下）之类：正在加入的话别打断它
      return false;
    }
    $('join-code').value = raw;
    show('view-home');
    // 不等它连完：等房主放行最长要半分钟，这期间再来的邀请得能把它换掉
    handleJoinInput(raw).catch(reportInviteError);
    return true;
  } catch (error) {
    reportInviteError(error);
    return false;
  }
}

function reportInviteError(error) {
  const message = error?.message || String(error);
  if (roomEntered) log(message, 'bad');
  else $('join-err').textContent = message;
}

/**
 * 房间里（或者首页开房正准备到一半）又点开了一条邀请：问一句要不要丢下手上这个。
 * 同时只问一次，问着的时候再来的只换成最新那条，不叠第二个框。
 */
function askSwitchForInvite(raw, kind) {
  if (inviteLinks.confirm) {
    inviteLinks.confirm.raw = raw;
    return;
  }
  const ask = { raw };
  inviteLinks.confirm = ask;
  const inRoom = kind === 'room';
  openModal({
    title: inRoom ? '要离开当前房间吗？' : '要放弃正在准备的放映吗？',
    body: () => [
      make('p', {
        text: inRoom
          ? '收到了一条新的邀请。加入它要先离开当前房间，你这边的播放和传输都会停下。'
          : '收到了一条新的邀请。加入它要先停下正在准备的这部片。',
      }),
    ],
    okText: inRoom ? '离开并加入' : '放弃并加入',
    onOk: () => {
      inviteLinks.confirm = null;
      const now = roomEntered ? 'room' : joinAttempt.busy?.kind === 'host' ? 'host' : null;
      // 框在那儿等着的时候情况变了（准备完进了房、准备失败了）：按现在的情况重新走一遍
      if (now !== kind) {
        openInviteLink(ask.raw);
        return true;
      }
      if (inRoom) {
        // 退房会刷新页面，邀请先记下来，刷新之后接着打开
        stashInvite(ask.raw);
        leaveRoom();
        return true;
      }
      // 正在准备的放映：拆掉这次尝试（算到一半的哈希、弹着的选择框一起收掉），再照常打开邀请
      resetAttempt();
      openInviteLink(ask.raw);
      return true;
    },
    onCancel: () => {
      if (inviteLinks.confirm === ask) inviteLinks.confirm = null;
    },
  });
}

function stashInvite(raw) {
  try {
    sessionStorage.setItem(INVITE_STASH_KEY, String(raw));
  } catch {}
}

function takeStashedInvite() {
  try {
    const raw = sessionStorage.getItem(INVITE_STASH_KEY);
    sessionStorage.removeItem(INVITE_STASH_KEY);
    return raw || null;
  } catch {
    return null;
  }
}

/*
 * 启动检查（boot）跑完之前经 second-instance 送来的深链接先存着，只留最新一条。
 * 页面一加载完主进程就直接派发深链接了，而 boot 还在等 Defender 状态、缓存目录这几步：
 * 这时就开始加入的话，boot 结尾那一下 show('view-home') 会把准备页盖掉 ——
 * 一对一邀请的应答链接就在那一页上，用户看不到，也就不知道要发回给房主。
 */
const bootLinks = { ready: false, latest: null };

function onDeepLinkArrived(raw) {
  if (!raw) return;
  if (bootLinks.ready) {
    openInviteLink(raw);
    return;
  }
  bootLinks.latest = String(raw);
}

/** boot 跑完：交出该打开的那条（最新优先：启动期间又点开的 > 冷启动带来的 > 退房前记下的），之后来的直接打开。 */
function releaseBootLinks(cold, stashed) {
  const link = bootLinks.latest || cold || stashed || null;
  bootLinks.ready = true;
  bootLinks.latest = null;
  return link;
}

window.sw.app.onDeepLink(onDeepLinkArrived);

window.sw.discord?.onStatus?.(setDiscordStatus);
window.sw.discord?.status?.().then(setDiscordStatus, () => {});

boot()
  .then(async () => {
    // 被房主移出房间、退回大厅时记下的原因：刷新之后在首页再说一遍
    const notice = takeLobbyNotice();
    if (notice) $('join-err').textContent = notice;
    // 退房去加入新邀请时记下的那条：刷新之后接着打开（这时又来了新的深链接就以新的为准）
    const stashed = takeStashedInvite();
    const initialLink = releaseBootLinks(await window.sw.app.takeDeepLink(), stashed);
    if (initialLink) await openInviteLink(initialLink);
  })
  // 最后一道兜底。以前这里只有 then，启动阶段任何一个没接住的错误都会让用户
  // 永远停在转圈的启动页上 —— 没有报错、没有重试，看起来就是软件坏了。
  .catch((error) => {
    const status = $('boot-status');
    if (status) {
      replace(status, make('div', { text: `启动失败：${error?.message || error}` }), make(
        'button',
        { className: 'ghost', text: '重试', props: { onclick: () => location.reload() } }
      ));
    }
  });
