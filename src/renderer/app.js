import { Peer } from './lib/peer.js';
import { Swarm } from './lib/swarm.js';
import { SyncEngine } from './lib/syncEngine.js';
import { MSG, PROTOCOL_VERSION, randomId } from './lib/protocol.js';
import { encodeCode, decodeCode, inviteLink, WsSignaling, randomRoomId, randomPeerId } from './lib/signaling.js';
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
import { ChatGate, ChatHistory, ChatSender, parseHistory, trustsRelay } from './lib/chat.js';
import { DanmakuEngine } from './lib/danmaku.js';
import { $, make, rawText, replace } from './ui/dom.js';
import { createPlaylistPanel } from './ui/playlistPanel.js';
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
  summarizeCandidates,
} from './lib/ice.js';
import {
  bitrateOf,
  bufferLead,
  forecastStall,
  hostPrecheck,
  viewersSupported,
  worstWaitSeconds,
  RateMeter,
} from './lib/stallForecast.js';

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
// 起播点不在片头时（中途加入、「回头接着放」），起播点往后还要有这么多连续内容。
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
  chat: {
    entries: [],
    gate: new ChatGate(),
    sender: new ChatSender(),
    history: new ChatHistory(),
    names: new Map(),
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
  settings: {
    language: currentLocale(),
    securityMode: localStorage.getItem('sw.securityMode') === 'safe' ? 'safe' : 'trusted',
    signalUrl: localStorage.getItem('sw.signalUrl') || 'ws://localhost:8080',
    stun: localStorage.getItem('sw.stun') || 'stun:stun.l.google.com:19302',
    turnUrl: localStorage.getItem('sw.turnUrl') || '',
    turnUser: localStorage.getItem('sw.turnUser') || '',
    turnPass: localStorage.getItem('sw.turnPass') || '',
    turnEnabled: localStorage.getItem('sw.turnEnabled') !== '0',
  },
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
 * TURN 依旧需要用户自己填服务器 —— 中继要花真金白银的带宽，我们不代运营。
 */
function iceServers() {
  return buildIceServers(S.settings);
}

/** 本机这次收集到的候选够不够用，连不上时用来给一句能照着做的话。 */
function connectionAdvice(peer) {
  const turnConfigured = Boolean(S.settings.turnEnabled && S.settings.turnUrl);
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
    `连接方式=${S.mode === 'manual' ? '极简（零服务器）' : '信令服务器'} 安全模式=${S.roomSecurityMode || S.settings.securityMode}`,
    `TURN=${S.settings.turnEnabled ? (S.settings.turnUrl ? '已配置' : '勾了但地址为空') : '未启用'}`,
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
    // 开发期端到端测试钩子（主进程只在未打包且显式打开时才报 devHooks）
    if (S.env.devHooks === true) window.__noxreel = { S, submitPlaylistOp };
  } catch (error) {
    log(`运行环境检查失败：${error.message || error}`, 'bad');
    S.env = {};
  }
  try {
    await window.sw.env.ensureDirs();
  } catch (error) {
    log(`缓存目录准备失败：${error.message || error}`, 'bad');
  }

  updateDepsPill();
  // 播放器清单要查注册表，慢一点无所谓：不拦启动，回来了再把下拉框重画一次
  refreshPlayerList();
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
  if (normalizeSecurityMode(S.settings.securityMode) === 'safe' && S.env.defenderRunning === false) {
    missing.push('Defender');
  }

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
      dependency('mpv —— 播放器（必需）', S.env.mpv, '未找到。装好后重启本软件即可。'),
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
        S.env.defenderRunning ? S.env.defender : null,
        S.env.defenderRunning === false
          ? '装着但没在运行，多半是被第三方杀毒软件接管了。安全模式下收到的文件会因此一律拒播；可以重新启用 Defender，或改用可信房间（风险自负）。'
          : '未找到。安全模式需要它才能放行收到的文件；可信房间不受影响。'
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
  const paths = await approvedDropPaths(e.dataTransfer.files);
  if (!paths.length) return alert(t('拿不到这个文件的路径，请改用点击选择。'));
  startHostMany(paths);
});

/** 拖进来的文件逐个换成主进程批准过的路径，拿不到路径的跳过。 */
async function approvedDropPaths(fileList) {
  const paths = [];
  for (const file of [...(fileList || [])]) {
    let path = null;
    try {
      path = await window.sw.pathForFile(file);
    } catch {
      path = null;
    }
    if (path) paths.push(path);
  }
  return paths;
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
function pageReporter(filePath) {
  const steps = [
    { label: '检查格式与兼容性', state: '' },
    { label: '优化传输体积（按需）', state: '' },
    { label: '计算分片校验值', state: '' },
    { label: '创建房间', state: '' },
  ];
  $('prep-title').textContent = '正在准备文件';
  $('prep-file').textContent = filePath;
  $('prep-bar').style.width = '0%';
  replace('prep-actions');
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
    finish: () => stage(steps.length),
    cancelled: () => false,
    onCancel: () => {},
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
 * 准备一部本地片：检查格式 →（按需）精简或转封装 → 卡顿预判 → 算分片校验值 → 开做种会话。
 *
 * 用户中途取消（选方案时点了取消、看完预判决定不传、行内点了取消）返回 null，
 * 这时产生的临时文件和会话都已经收拾干净；出错直接抛。
 *
 * @returns {Promise<{manifest, state, filePath}|null>}
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
    if (cancelled()) return null;

    // 上行测速和后面的精简、转封装并行跑，等到要下结论时它多半已经测完了。
    // 只有可信房间才会边下边播、才存在「中途卡顿」；安全模式成员收完才播，就不往外测。
    const uplinkPromise = S.roomSecurityMode === 'trusted' ? uplinkForPrecheck() : null;
    let finalSize = info.size;
    let slimmed = false;

    // 两种情况需要拿主意：非转封装不可，或者还有可无损省下的体积。
    // 都不沾边就别拿一个只有一个选项的弹窗去烦人。
    const needsRemux = info.action === 'remux';
    const canSlim = info.slim?.available === true;

    if (needsRemux || canSlim) {
      reporter.stage(1);
      reporter.note(info.reason);

      if (!S.env.ffmpeg && needsRemux) {
        throw new Error('这个 MP4 需要转封装才能边下边播，但没找到 ffmpeg。装上 ffmpeg 后重试，或者换一个 MKV 文件。');
      }

      // 没有 ffmpeg 时「本来还能再省一点」不该拦住放映，照原样走就是了。
      const choice = S.env.ffmpeg ? await choosePrepPlan(info, { needsRemux, canSlim, reporter }) : { plan: 'as-is' };
      if (!choice || cancelled()) return null;

      if (choice.plan !== 'as-is') {
        const slimming = choice.plan === 'slim';
        slimmed = slimming;
        const reencoding = slimming && choice.toFlac?.length > 0;
        reporter.title(slimming ? '正在无损精简' : '正在转封装');
        // 转码是分钟级、丢轨是秒级，这两件事的等待体感差一个数量级，得先说清楚。
        if (reencoding) {
          reporter.note('正在把未压缩的 PCM 音轨转成 FLAC（无损）。这一步要重新编码音频，长片可能要几分钟。');
        }
        const onProgress = ({ progress, taskId: owner }) => {
          if (owner === taskId) reporter.progress(progress);
        };
        const off = slimming
          ? window.sw.media.onSlimProgress(onProgress)
          : window.sw.media.onRemuxProgress(onProgress);
        try {
          const result = slimming
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
          reporter.note(slimming ? `已精简到：${result.outPath}${saved}` : `已转封装到：${result.outPath}`);
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
        canSlimMore: canSlim && !slimmed && Boolean(S.env.ffmpeg),
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
    return { manifest, state, filePath, sourcePath };
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
    failed.push({ name: baseName(path), message: result.message });
  }
  if (failed.length > 1) {
    const others = failed.slice(0, -1).map((f) => f.name).join('、');
    prepFail(failed[failed.length - 1].message, `这些也没能用：${others}`);
  }
}

/** @returns {Promise<{outcome: 'entered'|'cancelled'|'failed', message?: string}>} */
async function startHost(filePath) {
  // 房间里加片不占整页，进度画在列表行内
  if (roomEntered) {
    queueLocalFiles([filePath]);
    return { outcome: 'entered' };
  }
  S.role = 'host';
  S.hostId = S.peerId; // 房主就是自己，角色权威在我这
  S.roomSecurityMode = normalizeSecurityMode(S.settings.securityMode);

  show('view-prepare');
  const reporter = pageReporter(filePath);
  try {
    const prepared = await prepareLocalFile(filePath, reporter);
    if (!prepared) {
      backHome();
      return { outcome: 'cancelled' };
    }
    reporter.finish();
    // 会话从这里起交给 addLocalFile 管：它失败时自己收尾
    await addLocalFile(prepared);
    return { outcome: 'entered' };
  } catch (e) {
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

  if (!roomEntered) {
    S.role = 'host';
    S.hostId = S.peerId;
    S.roomSecurityMode = normalizeSecurityMode(S.settings.securityMode);
  }

  show('view-prepare');
  $('prep-title').textContent = '正在解析视频链接';
  $('prep-file').textContent = url;
  $('prep-bar').style.width = '35%';
  $('prep-note').textContent = '只读取媒体信息，不下载视频。每位参与者会直接从原始网站播放。';
  replace('prep-actions');
  setSteps([
    { label: '验证链接', state: 'done' },
    { label: '解析视频信息', state: 'active' },
    { label: '创建同步房间', state: '' },
  ]);

  try {
    const linkInfo = await window.sw.media.inspectLink(url);
    $('prep-bar').style.width = '85%';
    setSteps([
      { label: '验证链接', state: 'done' },
      { label: '解析视频信息', state: 'done' },
      { label: '创建同步房间', state: 'active' },
    ]);
    await addLinkItem(linkInfo);
  } catch (e) {
    console.error(e);
    prepFail(e.message || String(e));
  }
}

/* ---------------------------- 播放列表与当前项 ---------------------------- */

const isRoomHost = () => S.role === 'host' && S.hostId === S.peerId;
const PLAYLIST_OP_TIMEOUT_MS = 45_000;
const MANIFEST_RETRY_MS = 5000;
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
async function addLocalFile({ manifest, state, filePath, sourcePath = null }) {
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
        // （最长 30 秒），排队就能把这 45 秒耗光。这时立刻撤掉会话和清单，万一房主随后
        // 拼齐入列，列表里就留下一个谁都供不了的条目。先留一段宽限期，等列表快照说了算。
        if (res.reason === '房主没有回应') {
          S.addGrace.set(fileId, Date.now() + ADD_GRACE_MS);
          setTimeout(() => {
            if (!inAddGrace(fileId)) releaseUnreferenced();
          }, ADD_GRACE_MS + 50);
        }
        throw new Error(res.reason || '没能加进播放列表');
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
    if (!res.ok) throw new Error(res.reason || '没能加进播放列表');
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
  job.text = blamedHost ? (isRoomHost() ? '没加进列表' : '房主没有接受') : '没法用这个文件';
  job.detail = String(error?.message || error || '');
  log(`《${job.name}》没加进列表：${job.detail}`, 'warn');
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
  const paths = await approvedDropPaths(files);
  if (!paths.length) {
    log('拿不到拖进来的文件的路径，请改用「+ 本地视频」选择', 'warn');
    return;
  }
  queueLocalFiles(paths);
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
      resolve({ ok: false, reason: '房主没有回应' });
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

function onPlaylistOp(msg, peer) {
  if (!isRoomHost() || typeof msg.reqId !== 'string' || !msg.reqId || msg.reqId.length > 32) return;
  hostApplyOp(msg.op, { actor: peer.peerId, actorName: peer.name })
    .catch((error) => ({ ok: false, reason: error.message || String(error) }))
    .then((res) => {
      peer.send({
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
  // 却要按整片大小预分配（NTFS 上是实打实的占盘）。清单在路上时这一部被跳过或放完，
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
          const victim = stillWanted() ? evictionVictim(manifest.size, free, freeBefore) : null;
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
          if (stillWanted() && evictableSessions().length) {
            log('清掉已播放的缓存也放不下这一部，缓存先都留着', 'warn');
          }
          log(`没法接收《${item.name}》：${diskFull[0]}`, 'bad');
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
 * @returns {Promise<{plan:'slim'|'remux'|'as-is', keepIndexes:number[]|null, toFlac:number[]|null}|null>}
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

function choosePrepPlan(info, { needsRemux, canSlim, reporter }) {
  const slim = info.slim || {};
  const streams = info.probe?.streams || [];
  const audioTracks = streams.filter((s) => s.codecType === 'audio');
  // 门槛由主进程定（省不到这个数就不值得让用户等重编码），别在这边另写一个。
  const minFlacSaving = typeof slim.minFlacSaving === 'number' ? slim.minFlacSaving : 0.08;
  // 精简的输出容器跟着输入走：MKV 进 MKV 出，其余一律出 MP4（顺带加 +faststart）。
  const toMkv = String(info.ext || '').toLowerCase() === '.mkv';
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
    const keepIndexes = streams.map((s) => s.index).filter((i) => !dropped.has(i));
    const chosen = audioTracks.find((a) => a.index === keepAudioIndex);
    // flacRatio 是主进程对每条轨单独实测出来的（只有未压缩的 PCM 轨才有），
    // 换一条轨就得看那条自己的数字，不能沿用默认轨的结论。
    //
    // 容器这一条也必须判：FLAC-in-MP4 的播放器支持面太窄（安卓的 ExoPlayer 尤其），
    // 主进程的 canTranscodeToFlac 第一道判据就是它。这边漏掉的话，
    // MP4/MOV 源也会被提议转 FLAC，而产物是不可逆的。
    const flacOk = Boolean(
      toMkv && chosen && typeof chosen.flacRatio === 'number' && chosen.flacRatio <= 1 - minFlacSaving
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
    let picked = canSlim ? 'slim' : needsRemux ? 'remux' : 'as-is';
    let current = recompute();

    const modal = openModal({
      title: '这一场要传哪个版本',
      body: () => {
        const options = [];
        if (canSlim) {
          options.push(
            make('option', { attrs: { value: 'slim' }, props: { selected: true }, text: '无损精简（推荐）' })
          );
        }
        options.push(
          needsRemux
            ? make('option', {
                attrs: { value: 'remux' },
                props: { selected: !canSlim },
                text: '仅转封装（保留全部轨道）',
              })
            : make('option', { attrs: { value: 'as-is' }, props: { selected: !canSlim }, text: '原样传输' })
        );

        const select = make('select', { id: 'prep-plan' }, options);
        select.value = picked;

        const detail = make('div', { id: 'prep-plan-detail' });

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
        if (needsRemux) parts.push(make('p', { className: 'fine', text: info.reason }));
        parts.push(field('这一场传哪个版本', select));
        parts.push(detail);
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
        resolve(
          picked === 'slim'
            ? { plan: 'slim', keepIndexes: current.keepIndexes, toFlac: current.toFlac }
            : { plan: picked, keepIndexes: null, toFlac: null }
        );
        return true;
      },
      onCancel: () => resolve(null),
    });
    reporter?.onCancel(() => modal.cancel());
  });
}

function prepFail(msg, extra = '') {
  prepStop('没法用这个文件', msg, extra);
}

/** 准备页上的一条结论：标题 + 说明 +（可选）补一行没处理完的文件，只留「返回」。 */
function prepStop(title, msg, extra = '') {
  show('view-prepare');
  $('prep-title').textContent = title;
  $('prep-note').textContent = msg;
  $('prep-bar').style.width = '0%';
  const back = make('button', { id: 'prep-back', className: 'ghost', text: '返回' });
  back.onclick = backHome;
  replace('prep-actions', ...(extra ? [hint(extra), back] : [back]));
}

function backHome() {
  show(roomEntered ? 'view-room' : 'view-home');
}

/* ------------------------------ 加入放映 ------------------------------ */

async function handleJoinInput(rawInput) {
  const raw = String(rawInput || '').trim();
  $('join-err').textContent = '';
  if (!raw) return;

  try {
    const payload = await decodeCode(raw);

    if (payload.k === 'room') return joinViaServer(payload);
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

/** 极简模式：收到 offer，产出 answer 让对方粘回去。 */
async function joinViaManual(payload) {
  const inviteMode = normalizeSecurityMode(payload.securityMode);
  if (inviteMode !== normalizeSecurityMode(S.settings.securityMode)) {
    $('join-err').textContent = `房间使用${securityModeLabel(inviteMode)}，你的本机设置是${securityModeLabel(S.settings.securityMode)}。请先在设置中切换为相同模式，再重新粘贴邀请码。`;
    return;
  }
  if (payload.protocolVersion !== PROTOCOL_VERSION) {
    $('join-err').textContent = inviteVersionText(payload.protocolVersion);
    return;
  }
  S.role = 'guest';
  S.hostId = payload.from; // 邀请码里带着房主身份，认它做角色权威
  S.mode = 'manual';
  S.isSeeder = false;
  S.roomSecurityMode = inviteMode;
  S.roomCapacity = clampCapacity(payload.maxMembers || S.roomCapacity);

  show('view-prepare');
  $('prep-title').textContent = '正在建立点对点连接';
  $('prep-file').textContent = payload.file ? `${payload.file.name} · ${fmtBytes(payload.file.size)}` : '';
  $('prep-note').textContent = '正在收集网络候选地址，通常需要几秒钟…';
  setSteps([
    { label: '解析邀请码', state: 'done' },
    { label: '生成应答链接', state: 'active' },
    { label: '等待房主打开应答链接', state: '' },
  ]);
  $('prep-bar').style.width = '40%';

  initSwarmAndSync();

  // 重试时同一个房主 id 会再来一次，先把上一条死连接摘掉，别让它占着成员表。
  S.swarm.removePeer(payload.from);

  const peer = new Peer({
    peerId: payload.from,
    name: payload.name || '发起者',
    initiator: false,
    iceServers: iceServers(),
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
    if (joinSettled || peer.authenticated || roomEntered) return;
    // 用户点过「重新生成应答链接」的话，swarm 里已经换成新连接了，旧的定时器不能盖掉新界面。
    if (S.swarm?.peers?.get(payload.from) !== peer) return;
    joinSettled = true;
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
    retry.onclick = () => joinViaManual(payload).catch((error) => prepFail(error.message || String(error)));
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
  offJoinAuthenticated = S.swarm.on('peer-authenticated', (authenticatedPeer) => {
    if (authenticatedPeer !== peer) return;
    joinSettled = true;
    clearTimeout(joinWaitTimer);
    offJoinAuthenticated();
  });

  const answer = await peer.acceptOffer(payload.sdp);
  const code = await encodeCode({
    k: 'answer',
    from: S.peerId,
    name: S.name,
    sdp: answer,
    securityMode: S.roomSecurityMode,
  });
  const answerLink = inviteLink(code, 'answer');

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
  replace('prep-actions', answerAnchor, copyAnswer, answerArea);
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
    $('join-err').textContent = `房间使用${securityModeLabel(inviteMode)}，你的本机设置是${securityModeLabel(S.settings.securityMode)}。请先在设置中切换为相同模式，再重新粘贴邀请码。`;
    return;
  }
  if (payload.protocolVersion !== PROTOCOL_VERSION) {
    $('join-err').textContent = inviteVersionText(payload.protocolVersion);
    return;
  }
  S.role = 'guest';
  S.hostId = payload.from; // 邀请码里带着房主身份，认它做角色权威
  S.mode = 'server';
  S.isSeeder = false;
  S.roomSecurityMode = inviteMode;
  S.roomCapacity = clampCapacity(payload.maxMembers || S.roomCapacity);

  show('view-prepare');
  $('prep-title').textContent = '正在连接信令服务器';
  $('prep-file').textContent = payload.file ? `${payload.file.name} · ${fmtBytes(payload.file.size)}` : '';
  setSteps([
    { label: '解析邀请码', state: 'done' },
    { label: '连接信令服务器', state: 'active' },
    { label: '建立点对点连接', state: '' },
  ]);
  $('prep-bar').style.width = '35%';

  initSwarmAndSync();

  try {
    await connectSignaling(payload.url, payload.room);
    setSteps([
      { label: '解析邀请码', state: 'done' },
      { label: '连接信令服务器', state: 'done' },
      { label: '建立点对点连接', state: 'active' },
    ]);
    $('prep-bar').style.width = '70%';
    $('prep-note').textContent = '已进入房间，正在和其他成员打洞…';
  } catch (e) {
    // 不关的话这条连接会一直按退避重连下去（WsSignaling 的 onclose 只看
    // _closedByUs），而 hostId 校验只在首次 connect() 的返回值上做过一次 ——
    // 重连成功后没人再校验，用户可能被静默拖进一个他已经放弃的房间。
    S.signaling?.close();
    S.signaling = null;
    return prepFail(
      e.code === 'REGION_BLOCKED'
        ? e.message
        : `${e.message}\n\n如果对方没有部署信令服务器，让他改用「极简模式」生成邀请码 —— 那个不需要服务器。`
    );
  }
}

/* ------------------------------ 信令连接 ------------------------------ */

async function connectSignaling(url, roomId) {
  const sig = new WsSignaling({
    url,
    roomId,
    peerId: S.peerId,
    name: S.name,
    maxMembers: S.role === 'host' ? S.roomCapacity : 0,
  });
  // 这里就赋值是为了让事件处理器能拿到它；但连接失败时必须置回 null，
  // 否则 inviteViaServer 的 if (!S.signaling) 守卫会短路跳过重连，
  // 而 S.roomId 只在连接成功后才写 —— 结果是拿一个 undefined 的房间号去编码，
  // 发出去一条根本没人能加入的坏邀请码。
  S.signaling = sig;

  // 规则：房间里的老成员向新来的发起 offer。这样不会两边同时发 offer 撞车。
  sig.on('peer-join', async ({ peerId, name }) => {
    // 这次会话里因为版本不符断开过的人，不再和他建连
    if (S.swarm.versionRejected.has(peerId)) return;
    log(`${name} 加入了房间`, 'good');
    const peer = new Peer({ peerId, name, initiator: true, iceServers: iceServers(), trickle: true });
    wirePeer(peer, sig);
    S.swarm.addPeer(peer);
    const offer = await peer.createOffer();
    sig.signal(peerId, { kind: 'offer', sdp: offer });
  });

  sig.on('signal', async ({ from, name, payload }) => {
    let peer = S.swarm.peers.get(from);

    if (S.swarm.versionRejected.has(from)) return;

    if (payload.kind === 'offer') {
      // 收到 offer 就等于对方那边已经另起了一条连接 —— 本产品没有重协商场景，老成员只在
      // 新人进房时发一次 offer。此时手上那个同 id 的 Peer 必然是上一轮的残骸：它的
      // 数据通道可能刚被对端 abort，close 事件还堵在事件队列里没轮到。拿它去
      // setRemoteDescription，ICE 会在一条已经废掉的 pc 上重来一遍，双方都以为在协商，
      // 实际再也连不上 —— 表现就是信令一抖，传输永久停在原地。
      if (peer) S.swarm.removePeer(from);
      peer = new Peer({ peerId: from, name, initiator: false, iceServers: iceServers(), trickle: true });
      wirePeer(peer, sig);
      S.swarm.addPeer(peer);
      const answer = await peer.acceptOffer(payload.sdp);
      sig.signal(from, { kind: 'answer', sdp: answer });
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
      await reconnectPeer(from, name, sig).catch((e) =>
        log(`重连 ${name || from} 失败：${e.message}`, 'bad')
      );
      return;
    }

    if (!peer || peer.closed) return;
    if (payload.kind === 'answer') {
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
    cancelRecovery(peerId); // 人是真走了，不是链路断了，别再去重连
    const peer = S.swarm.peers.get(peerId);
    if (peer?.ctrl?.readyState === 'open') {
      log(`${peer.name} 的信令连接断了，但直连还在，传输继续`, 'warn');
      return;
    }
    if (peerId === S.hostId) hostReallyGone();
    S.swarm.removePeer(peerId);
  });
  sig.on('joined', ({ maxMembers }) => {
    if (maxMembers) S.roomCapacity = clampCapacity(maxMembers);
    renderCapacityStatus();
  });
  sig.on('room-config', ({ maxMembers }) => {
    S.roomCapacity = clampCapacity(maxMembers);
    renderCapacityStatus();
    log(`房间人数上限已设为 ${S.roomCapacity}`, 'good');
  });
  sig.on('reconnecting', ({ in: ms }) => log(`信令断开，${Math.round(ms / 1000)} 秒后重连（已建立的直连不受影响）`, 'warn'));
  sig.on('error', (e) => log(`信令错误：${e.message}`, 'bad'));

  const joined = await sig.connect();
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
/** peerId -> {attempts, timer} */
const RECOVERY = new Map();
/** peerId -> 正在跑的重协商 Promise。同一个人同时只允许一次。 */
const RENEGOTIATING = new Map();

function cancelRecovery(peerId) {
  const st = RECOVERY.get(peerId);
  if (st?.timer) clearTimeout(st.timer);
  RECOVERY.delete(peerId);
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
/** 确认房主真的走了：信令说他离开了，或者重连退避已经用尽。 */
function hostReallyGone() {
  if (isRoomHost() || !roomEntered || S.hostGone) return;
  S.hostGone = true;
  S.hostLink = null;
  log('房主已离开，列表暂停更新；已经连上的成员之间照常传输', 'warn');
  renderPlaylistSoon();
}

function scheduleReconnect(peer, sig) {
  if (!sig || !S.swarm || peer.closed) return;
  const peerId = peer.peerId;
  const st = RECOVERY.get(peerId) || { attempts: 0, timer: null };
  if (st.timer) return; // 已经排上了

  if (st.attempts >= RECONNECT_BACKOFF_MS.length) {
    const advice = connectionAdvice(peer);
    log(`和 ${peer.name} 的直连试了 ${st.attempts} 次都没恢复。${advice.text}`, 'bad');
    // 退避用尽才承认失联：在这之前列表横幅只说「正在重连」，别把 ICE 抖一下说成房主走了
    if (peerId === S.hostId) hostReallyGone();
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
      // 信令也断着，重连的消息发不出去。信令自己会退避重连，等它回来这条
      // 连接会由对面的 peer-join / renegotiate 重新拉起来。
      log(`信令还没恢复，暂时没法重连 ${name}`, 'warn');
      return;
    }
    if (initiator) {
      reconnectPeer(peerId, name, sig).catch((e) => log(`重连 ${name} 失败：${e.message}`, 'bad'));
    } else {
      sig.signal(peerId, { kind: 'renegotiate' });
    }
  }, wait);

  RECOVERY.set(peerId, st);
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
    if (S.swarm.peers.has(peerId)) S.swarm.removePeer(peerId);
    const peer = new Peer({
      peerId,
      name: name || peerId,
      initiator: true,
      iceServers: iceServers(),
      trickle: true,
    });
    wirePeer(peer, sig);
    S.swarm.addPeer(peer);
    const offer = await peer.createOffer();
    // 走到这里可能已经过了几秒（要等 ICE 收集）。期间这条 peer 可能被顶替或摘掉，
    // 那就别再把这份过期的 offer 发出去。
    if (S.swarm.peers.get(peerId) !== peer) return;
    sig.signal(peerId, { kind: 'offer', sdp: offer });
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
  if (sig) peer.on('icecandidate', (c) => sig.signal(peer.peerId, { kind: 'ice', candidate: c }));

  let graceTimer = null;
  const clearGrace = () => {
    clearTimeout(graceTimer);
    graceTimer = null;
  };

  peer.on('open', () => {
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
  S.approvedSites.add(origin);
  S.skippedLinks.delete(item.id);
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
    resolvedAt: Date.now(),
  };
}

/** 当前项是链接：每个人在自己的电脑上解析，房主把自己解析到的地址也发一份做兜底。 */
async function activateLinkItem(item, seq) {
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
  });
  S.sync = new SyncEngine({
    peerId: S.peerId,
    name: S.name,
    isSeeder: S.isSeeder,
    hostId: S.hostId, // 房主=自身 peerId；加入者=邀请码里的房主 id。两条路都已提前设好
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

  // 就绪变化：刷新等待名单；房主看看是不是该自动开播了
  S.sync.on('ready-change', () => {
    renderReady();
    maybeAutoStart();
  });

  S.swarm.on('peer-authenticated', async (peer) => {
    log(`已和 ${peer.name} 完成${securityModeLabel(S.roomSecurityMode)}握手`, 'good');
    S.chat.names.set(peer.peerId, peer.name);
    S.chat?.note(`${peer.name} 加入了房间`);
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
    refreshSources();
    scheduleTransferUpdate();
    if (S.role === 'guest' && !roomEntered) await enterRoom();
  });

  S.swarm.on('peer-gone', (peerId) => {
    S.chat?.gate.forget(peerId);
    const gone = S.chat?.names.get(peerId);
    if (gone) {
      S.chat.names.delete(peerId);
      S.chat.note(`${gone} 离开了房间`);
    }
    if (peerId === S.hostId && !isRoomHost() && roomEntered && !S.hostGone) {
      if (S.mode === 'manual') {
        // 极简模式没有信令、也没有重连的路子：直连断了就是这一场结束了
        S.hostGone = true;
        log('房主已离开，这个房间结束了', 'warn');
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

  S.sync.on('stall-change', ({ name, stalled, self }) => {
    const who = self ? t('你') : name;
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

  // 角色变化：重画成员列表（含标签/切换按钮）、更新我自己的身份提示。
  S.sync.on('roles', () => {
    renderPeers();
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
  S.swarm.on('peers', renderPeers);
  S.swarm.on('identity-mismatch', ({ expected }) => {
    log(`已断开身份校验失败的成员：${expected}`, 'bad');
  });
  S.swarm.on('mode-mismatch', ({ peerId, localMode, remoteMode }) => {
    const message = `${peerId} 的模式是${securityModeLabel(remoteMode)}，本房间是${securityModeLabel(localMode)}，已在传输媒体前断开。`;
    log(message, 'bad');
    if (!roomEntered && S.role === 'guest') {
      S.signaling?.close();
      prepFail(`${message}\n请双方分别在设置里选择相同模式后重试。`);
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
      prepFail(message);
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
  $('tab-invite').classList.toggle('hidden', S.role !== 'host');
  // 房主进了空房间，先把邀请页摆出来；用户动过页签之后就不再替他切
  if (S.role === 'host' && connectedPeerCount() === 0 && !tabTouched) selectRoomTab('invite');
  // 当前项在进房前就可能已经切好了（房主自己的片）；观众要等列表和清单到了，
  // 由 onPlaylistChanged → switchCurrent 那一路接着走。
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

function renderChat() {
  if (!roomEntered) return;
  ensureChatPanel().render({ entries: S.chat.entries, notice: S.chat.notice });
}

function pushChatEntry(entry) {
  const list = S.chat.entries;
  // 同一个 key 绝不能进两次：面板按 key 复用元素，重复的会当场抛错，而且这两条一直留在列表里，
  // 之后每一次重绘都再抛一次，聊天面板从此永久坏掉。去重表有 TTL，同 id 的消息隔久了会「复活」，
  // 网状模式下直连那份和房主补发的历史也可能撞上，所以这一层必须自己兜住。
  if (entry.key && list.some((e) => e.key === entry.key)) return;
  list.push(entry);
  if (list.length > VIEW_LIMIT) list.splice(0, list.length - VIEW_LIMIT);
  renderChat();
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
  pushChatEntry({ key: id, kind: 'msg', name: S.name, text, self: true, state: host ? 'sent' : 'sending' });
  showDanmaku({ id, text, self: true });
  if (host) S.chat.history.add({ id, text, origin: S.peerId, name: S.name, ts });
  const wire = host ? { t: MSG.CHAT, id, text, ts, origin: S.peerId, originName: S.name } : { t: MSG.CHAT, id, text, ts };
  for (const p of chatPeers()) p.send(wire);
  return true;
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
    return;
  }
  const m = res.message;
  pushChatEntry({ key: m.id, kind: 'msg', name: m.name, text: m.text, self: false });
  showDanmaku({ id: m.id, text: m.text, self: false });
  if (!isRoomHost()) return;
  // 房主是转发中枢：留进历史，再转给所有人 —— 包括发送者本人。
  // 转回去的这一份就是送达回执（他那边按 id 认出是自己的回声，只把「发送中」改成「已送达」，不会显示两遍）；
  // 不转回去的话，两个人的房间里发送者会永远停在「发送中」。
  S.chat.history.add(m);
  const wire = { t: MSG.CHAT, id: m.id, text: m.text, ts: m.ts, origin: m.origin, originName: m.name };
  for (const p of chatPeers()) p.send(wire);
}

/** 自己那条被房主转回来了：「发送中」改成「已送达」。 */
function markChatDelivered(id) {
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
  return { text: S.current?.id === item.id && S.linkInfo ? '各自从原网站播放' : '在线视频', tone: '' };
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
  // 本机解析失败、房主也没有能用的兜底地址：网站早就允许过了，这里只给「跳过」
  if (S.current?.id === item.id && linkResolveFailed()) {
    return { text: '本机无法解析这个链接', tone: 'bad', actions: [{ key: 'skip-link', label: '跳过' }] };
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
  if (sess?.filePath) menu.push({ key: 'reveal', label: sess.isSeeder ? '打开源文件位置' : '打开临时缓存位置' });
  if (item.kind === 'link') menu.push({ key: 'copy-link', label: '复制链接' });
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
  if (!res.ok && res.reason !== 'needs-confirm') log(`列表没改成：${res.reason || '未知原因'}`, 'warn');
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
      consented: siteApproved(item),
      resolved: !!S.linkInfo,
    });
  }
  // 本机收不下这一部：和卡顿判定一样不参与（见 localOptedOut）
  if (localOptedOut(item)) return true;
  const sess = S.sessions.get(item.fileId);
  const ctx = sess && sess.slot === item.slot ? S.swarm?.files.get(item.slot) : null;
  const prog = ctx ? S.swarm.progress(item.slot) : null;
  const startByte = roomPlayheadByte();
  return isItemReady(item, {
    isSeeder: !!sess?.isSeeder,
    mode: S.roomSecurityMode,
    contiguousBytes: ctx?.contiguousBytes || 0,
    // 起播点不在片头时（中途加入、或「回头接着放」），片头够了还不算准备好。
    // midJoin 单独给：码率未知时 startByte 恒为 0，只看它会让这道门槛静默失效。
    midJoin: midJoinNow(),
    startByte,
    runBytes: prog?.runBytes || 0,
    runNeeded: startRunNeeded(item.size || 0, startByte),
    complete: !!ctx?.complete,
    scanStatus: sess?.safety.status,
  });
}

/** 就绪状态变了才会发出去（同步引擎里去重），所以进度事件里随手调也不贵。 */
function updateLocalReady() {
  if (!S.sync) return;
  S.sync.setLocalReady(localReadyNow());
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
  const members = new Map();
  if (!isRoomHost()) for (const p of snap.peers) members.set(p.peerId, { peerId: p.peerId, name: p.name });
  for (const p of S.swarm.peers.values()) {
    if (p.authenticated) members.set(p.peerId, { peerId: p.peerId, name: p.name });
  }
  const out = waitingFor([...members.values()], ready);
  if (!snap.self) out.unshift({ peerId: S.peerId, name: '', self: true });
  return out;
}

/** 这一部还没开播时，列出谁还没准备好；房主和管理员可以不等了。 */
function renderReady() {
  const row = $('ready-row');
  const visible =
    roomEntered && !!S.sync && !!S.current && !S.playlist.started && !S.switchingMedia && S.sync.shared.paused;
  row.classList.toggle('hidden', !visible);
  if (!visible) return;
  const waiting = readyWaiting();
  const canControl = S.sync.canIControl();
  row.classList.toggle('all', !waiting.length);
  if (!waiting.length) {
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
    waiting.forEach((w, i) => {
      if (i) names.push(rawText(sep));
      names.push(w.self ? make('span', { text: '你' }) : rawText(w.name || w.peerId));
    });
    replace('ready-text', make('span', { text: `等待 ${waiting.length} 人准备好：` }), ...names);
  }
  $('btn-force-start').classList.toggle('hidden', !canControl || !waiting.length);
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
  $('btn-reveal').textContent = S.isSeeder ? '打开源文件位置' : '打开临时缓存位置';
  $('buffer').classList.toggle('link-mode', S.sourceType === 'link');
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
  if (S.roomSecurityMode === 'trusted') {
    if (S.mediaSafety.status === 'trusted-streaming') return;
    const readyBytes = Math.min(HEAD_READY_BYTES, S.manifest?.size || HEAD_READY_BYTES);
    if (p.contiguousBytes < readyBytes || S.mediaSafety.status !== 'waiting-download') return;
    // 起播点不在片头（中途加入、或「回头接着放」）：片头够了只说明播放器认得出格式，
    // 它落脚的是起播点 —— 那里没有足够的连续数据，一起播就撞上连续区尽头。
    if (midJoinNow() && !p.complete) {
      const startByte = roomPlayheadByte();
      // 码率未知（片源没装 ffmpeg，清单里就没有时长）时换不出字节位置，
      // 判不了起播点附近有没有数据。这一部只能等收完再播。
      if (!(startByte > 0)) return warnMidJoinBlind();
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
  if (outcome.destroy) {
    await blockScannedSession(session, result.message || '安全扫描未通过');
    return;
  }
  safety.status = outcome.status;
  const name = session.manifest.name;
  if (currentSession() !== session) {
    // 不是正在放的那部：记一笔，轮到它时直接用这个结果
    if (outcome.status === 'clean') log(`《${name}》安全扫描通过`, 'good');
    else log(`《${name}》没有扫完：${result.message || '安全扫描没能完成'}`, 'warn');
    return;
  }

  if (outcome.status === 'clean') {
    log(
      S.mpvRunning
        ? '完整文件安全扫描通过；退出房间后会自动删除缓存'
        : '安全扫描通过，正在打开播放器；退出房间后会自动删除缓存',
      'good'
    );
    if (!S.mpvRunning) await launchPlayer();
    window.sw.player.osd(t('安全扫描通过 · 缓存退出后自动清理'), 2500);
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
    log(`${reason}。安全模式必须扫过才放行；你可以启用 Microsoft Defender，或改用可信房间（风险自负）。`, 'bad');
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
  await trackClosing(window.sw.store.close(session.sessionId).catch(() => {}));
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
 * @param {{startAt?: number|null}} [opts] startAt 给「即时换播放器」用：那一路要接着
 *   旧播放器停下的地方放，而不是回到房间共识位置（两者可能差着一次刚做的跳转）。
 * @returns {Promise<boolean|'superseded'>} true 表示这一代真的起来了；false 是真失败；
 *   `'superseded'` 是「这次启动已经作废」（换片、拦下威胁、列表推进、正在离开房间）——
 *   调用方绝不能把它当成失败去做补救，见 relaunchWithPlayer。
 */
async function launchPlayer({ startAt = null } = {}) {
  // 离开房间的收尾里还有好几段 await（关会话、删缓存），扫描通过、做种交接完成都可能在这期间
  // 回来把播放器拉起来 —— 页面一刷新它就成了没人管的窗口，还占着刚要删的缓存。
  if (S.leaving) return 'superseded';
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
    S.mpvRunning = false; // 占位撤回，否则再也不会重试
    $('btn-reopen')?.classList.remove('hidden');
    reportLaunchFailure(e, want.kind, name);
    return false;
  }
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
  'no-headers': '这个链接要带请求头',
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
  if (!externalPlaybackReady()) return { kind: 'mpv', reason: 'streaming' };
  // MPC-BE 没有传请求头的命令行参数，这种链接只能交回 mpv
  if (want === 'mpc' && linkNeedsHeaders()) return { kind: 'mpv', reason: 'no-headers' };
  return { kind: want, reason: '' };
}

/** 当前这一部是不是「完整的一个文件」—— 外部播放器只接手这种。 */
function externalPlaybackReady() {
  if (S.sourceType === 'link') return true; // 链接不经过接收缓存，没有正在增长这回事
  if (S.isSeeder) return true; // 片源手里本来就是整部片
  return !!currentFileCtx()?.complete;
}

function linkNeedsHeaders() {
  if (S.sourceType !== 'link') return false;
  const headers = S.filePath === S.linkInfo?.playback?.url ? S.linkInfo?.playback?.headers : null;
  return !!headers && Object.keys(headers).length > 0;
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
    if (S.mpvRunning) await relaunchWithPlayer();
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
  await retirePlayer();
  // 上一个播放器屏幕上的弹幕不该飞到新窗口里
  S.danmaku?.clear();
  const launched = await launchPlayer({ startAt });
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
    return (await launchPlayer({ startAt })) === true;
  }
  return false;
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
    detachFromPlayer();
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
 */
function detachFromPlayer() {
  playerGate.retire(); // 迟到的 tick / exit / error 一律作废，不必等进程退出
  S.mpvRunning = false;
  lastMpvBanner = '';
  S.danmaku?.setActive(false);
  S.sync?.forgetPlayerState?.();
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
    return;
  }

  const capacityInput = make('input', {
    id: 'room-capacity',
    attrs: { type: 'number', min: 2, max: 16 },
    props: { value: String(S.roomCapacity) },
  });
  replace(
    box,
    make('p', {
      className: 'fine',
      text: S.roomSecurityMode === 'trusted'
        ? '当前：可信房间（边下边播，风险较高）。加入者也必须在本机选择可信房间。'
        : '当前：安全模式。成员完整接收并扫描通过后才播放。',
    }),
    make('div', { className: 'capacity-row' }, [
      make('label', { text: '房间人数上限', attrs: { for: 'room-capacity' } }),
      capacityInput,
      make('button', { className: 'ghost', id: 'capacity-apply', text: '应用' }),
    ]),
    make('p', { className: 'fine', id: 'capacity-status' }),
    make('button', { className: 'primary', id: 'inv-manual', text: '生成零服务器邀请链接' }),
    make('button', { className: 'ghost', id: 'inv-server', text: '改用信令服务器' }),
    make('p', {
      id: 'inv-hint',
      text: '默认使用零服务器直连。双方直接点开邀请／应答链接即可，不再手动粘贴长码；跨网络仍需交换一次应答。',
    }),
    make('div', { id: 'inv-out' })
  );

  $('inv-server').onclick = inviteViaServer;
  // 包一层再调：直接当处理器挂上去的话，第一个实参就是 PointerEvent，
  // 会被当成 notice 原样渲染成「[object PointerEvent]」贴在邀请区顶上。
  $('inv-manual').onclick = () => inviteViaManual();
  $('capacity-apply').onclick = applyRoomCapacity;
  renderCapacityStatus();
  // 默认直接生成零服务器邀请，用户进入房间后不必再选择连接方式。
  inviteViaManual().catch((error) => {
    replace('inv-out', make('p', { text: error.message || String(error) }));
  });
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

async function inviteViaServer() {
  const out = $('inv-out');
  replace(out, make('p', { text: '正在连接信令服务器…' }));

  try {
    if (!S.signaling) {
      S.mode = 'server';
      const room = randomRoomId();
      try {
        await connectSignaling(S.settings.signalUrl, room);
      } catch (e) {
        S.signaling?.close();
        S.signaling = null;
        throw e;
      }
      S.roomId = room;
    }

    const code = await encodeCode({
      k: 'room',
      url: S.settings.signalUrl,
      room: S.roomId,
      from: S.peerId,
      name: S.name,
      file: inviteMediaInfo(),
      maxMembers: S.roomCapacity,
      securityMode: S.roomSecurityMode,
    });

    replace(
      out,
      make('textarea', { id: 'inv-code', attrs: { readonly: '', rows: 4 } }),
      make('button', { className: 'primary', id: 'inv-copy', text: '复制邀请码' }),
      make('p', { text: `完整短码共 ${code.length} 字符，可重复使用。房间会一直开着直到你离开。` })
    );
    $('inv-code').value = code;
    $('inv-copy').onclick = () => copyCode(code, $('inv-copy'));
    log(`房间已开：${S.roomId}`, 'good');
  } catch (e) {
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
  replace(out, make('p', { text: '正在收集网络候选地址（几秒钟）…' }));

  S.pendingManualPeer?.close();

  const peer = new Peer({
    peerId: `pending-${crypto.randomUUID().replaceAll('-', '').slice(0, 6)}`,
    name: '待加入',
    initiator: true,
    iceServers: iceServers(),
    trickle: false,
  });
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
  });
  const link = inviteLink(code, 'join');

  // 上一轮打洞失败时把原因带过来，别让用户对着一个「又生成了一条链接」发懵。
  // replace() 不过滤 null，所以空的时候给一个空数组，flat 之后自然消失。
  const noticeNode = notice ? make('p', { id: 'inv-notice', text: notice }) : [];
  if (notice) noticeNode.style.color = 'var(--warn)';

  replace(
    out,
    noticeNode,
    make('a', { id: 'inv-link', className: 'invite-link', text: 'NoxReel 一键加入链接' }),
    make('button', { className: 'primary', id: 'inv-copy', text: '复制邀请链接' }),
    make('p', { text: `已生成可点击的邀请链接；压缩握手数据 ${code.length} 字符。在对方真正连上前，不会计入成员列表。` }),
    make('p', {
      className: 'fine',
      text: '链接里带着这台电脑当前的网络地址，放久了会失效 —— 尽量在几分钟内让对方点开。过期了重新生成一条即可。',
    }),
    make('p', {}, [make('b', { text: '第 2 步：' }), '对方发回应答链接后直接点开，或粘贴到这里：']),
    make('textarea', {
      id: 'inv-answer',
      attrs: { rows: 3, placeholder: '点开对方发回的 NoxReel 应答链接，或粘贴 NR3-…' },
    }),
    make('button', { className: 'ghost', id: 'inv-accept', text: '完成连接' }),
    make('p', { id: 'inv-status' })
  );
  $('inv-link').href = link;
  $('inv-link').onclick = (event) => { event.preventDefault(); copyCode(link, $('inv-copy'), '复制邀请链接'); };
  $('inv-copy').onclick = () => copyCode(link, $('inv-copy'), '复制邀请链接');

  $('inv-accept').onclick = () => acceptManualAnswer($('inv-answer').value);
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
    peer.name = payload.name || '观众';
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

function renderProgress(p) {
  if (!p) return;

  if (S.sourceType === 'link') {
    $('buf-have').style.width = '100%';
    $('buf-safe').style.width = '100%';
    const snap = S.sync?.lastTick;
    const playRatio = snap && S.sync.duration ? Math.min(1, (snap.position || 0) / S.sync.duration) : 0;
    $('buf-head').style.left = `${(playRatio * 100).toFixed(2)}%`;
    replace(
      'buffer-stats',
      stat('来源', '原始视频网站'),
      stat('同步', '播放 / 暂停 / 跳转'),
      stat('缓冲', '由各自的 mpv 管理')
    );
    replace(
      'transfer-stats',
      kv('视频传输', '原网站 → 每位成员'),
      kv('房间消息', 'P2P 加密直连'),
      kv('连接数', S.swarm.peers.size),
      kv('模式', S.mode === 'manual' ? '极简（零服务器）' : '信令服务器')
    );
    return;
  }

  if (!S.manifest) return;

  $('buf-have').style.width = `${(p.ratio * 100).toFixed(2)}%`;
  $('buf-safe').style.width = `${(p.contiguousRatio * 100).toFixed(2)}%`;

  const snap = S.sync?.lastTick;
  const playRatio =
    snap && S.sync.duration ? Math.min(1, (snap.position || 0) / S.sync.duration) : 0;
  $('buf-head').style.left = `${(playRatio * 100).toFixed(2)}%`;

  drawChunkMap();

  replace(
    'buffer-stats',
    stat('已接收', `${(p.ratio * 100).toFixed(1)}%（${p.haveCount}/${p.chunkCount} 片）`),
    stat('从当前位置可连续播放', fmtBytes(p.runBytes || 0)),
    stat('在途', `${p.inflight} 片`),
    stat('速度', fmtRate(p.downRate))
  );

  renderTransferVerdict(p);

  replace(
    'transfer-stats',
    kv('已收', fmtBytes(p.received)),
    kv('已发', fmtBytes(p.sent)),
    kv('下行', fmtRate(p.downRate)),
    kv('连接数', S.swarm.peers.size),
    kv('模式', S.mode === 'manual' ? '极简（零服务器）' : '信令服务器')
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
    if (!S.mpvRunning) {
      const startByte = roomPlayheadByte();
      if (midJoinNow() && !(startByte > 0)) {
        // 中途加入却算不出房间播到第几个字节（清单里没有时长）：这一部只能等收完，
        // 再报「距起播还差 0」就是在骗人。见 warnMidJoinBlind()。
        const remaining = Math.max(0, Math.round((1 - p.ratio) * S.manifest.size));
        parts.push(stat('片源没提供时长 · 完整接收后才播，还剩', fmtBytes(remaining)));
        if (rate > 0) parts.push(stat('预计还需', fmtTime(remaining / rate)));
      } else {
        // 中途加入时片头早就够了，还差的是起播点附近那一段 —— 只报片头会一直显示「还差 0」。
        const headLeft = Math.max(0, Math.min(HEAD_READY_BYTES, S.manifest.size) - p.contiguousBytes);
        const runLeft =
          startByte > 0 ? Math.max(0, startRunNeeded(S.manifest.size, startByte) - (p.runBytes || 0)) : 0;
        const left = Math.max(headLeft, runLeft);
        parts.push(stat(runLeft > headLeft ? '距起播还差（当前位置附近）' : '距起播还差', fmtBytes(left)));
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
    const forecast = forecastStall({
      size: S.manifest.size,
      bitrate: need,
      rate,
      contiguous: p.runEndBytes,
      playhead: roomPlayheadByte(),
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
  ctx.fillStyle = 'rgba(63, 185, 80, 0.28)';

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
    let forecast;
    if (!size || S.sourceType === 'link') forecast = { level: 'unknown' };
    else if (sourceId && info.peerId === sourceId && !S.isSeeder) forecast = { level: 'source' };
    else if ((info.remoteRunEndBytes || 0) >= size) forecast = { level: 'done' };
    else if (rate === null) forecast = { level: 'measuring' };
    else forecast = forecastStall({ size, bitrate, rate, contiguous: info.remoteRunEndBytes || 0, playhead });
    // 会卡的人才算「先等多久就不卡了」——不卡的人这个数恒为 0，算了也没东西可说。
    const lead =
      forecast.level === 'stall'
        ? bufferLead({ size, bitrate, rate, contiguous: info.remoteRunEndBytes || 0, playhead })
        : null;
    next.set(info.peerId, { ...forecast, rate, held, lead });
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
  if (f.level === 'measuring') return '正在测速…';
  if (f.level === 'unknown') return mediaBitrate() > 0 ? '' : '码率未知，没法预判';
  if (S.roomSecurityMode !== 'trusted') {
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
 * 自己这一路的预缓冲估计。传输面板和 mpv 横幅共用这一个数，
 * 免得同一件事在两个地方给出不一样的说法。
 */
function myBufferLead() {
  if (S.isSeeder || S.sourceType === 'link' || !S.manifest) return null;
  const p = S.swarm?.progress();
  if (!p || p.complete) return null;
  const bitrate = mediaBitrate();
  const rate = p.downRate || 0;
  if (!(bitrate > 0) || !(rate > 0)) return null;
  return bufferLead({
    size: S.manifest.size,
    bitrate,
    rate,
    contiguous: p.runEndBytes,
    playhead: roomPlayheadByte(),
  });
}

/**
 * 全员暂停还要等多久。
 *
 * 取所有卡住的人里最久的那个 —— 房间要等最慢的那个攒够才恢复。任何一个人算不出来
 * 就整个返回 null：宁可不给数，也别给一个偏乐观的数让人白等。
 *
 * 这里按 peerId 取预判，而不是用 status().waitingFor —— 那个返回的是名字，
 * 和 lastForecasts 的键对不上。
 */
function stallWaitSeconds() {
  if (!S.sync) return null;
  const leads = [];
  if (S.sync.localStalled) leads.push(myBufferLead());
  for (const peerId of S.sync.stalledPeers.keys()) leads.push(lastForecasts.get(peerId)?.lead);
  return worstWaitSeconds(leads);
}

function stallBannerText(waitingFor) {
  const who = waitingFor.join('、');
  const wait = stallWaitSeconds();
  return wait
    ? `全员暂停中 —— 在等 ${who} 把缓冲攒够，约 ${fmtTime(wait)}`
    : `全员暂停中 —— 在等 ${who} 把缓冲攒够`;
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

function renderPeers(list) {
  list = list || S.swarm?.peerList() || [];
  list = list.filter((p) => p.state === 'connected' || p.state === 'completed');
  if (list.length > Number($('peer-count').textContent || 0)) notePeersChanged();
  $('peer-count').textContent = list.length;
  renderCapacityStatus();
  const forecasts = updatePeerForecasts(list);
  renderHostVerdict(list);

  if (!list.length) {
    const empty = make('p', {
      className: 'fine',
      text: S.role === 'host' ? '还没有人加入。去「邀请」页签生成邀请链接。' : '还没有其他成员。',
    });
    empty.style.padding = '4px';
    replace('peer-list', empty);
    return;
  }

  const iAmHost = S.sync?.myRole() === 'host';
  replace(
    'peer-list',
    list.map((peer) => {
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
          : make('span', { className: `role-badge ${role}`, text: ROLE_LABEL[role] });

      let mediaProgress;
      if (S.sourceType === 'link') {
        mediaProgress = [
          make('div', {
            className: 'peer-sub',
            text: `延迟 ${peer.rtt != null ? `${peer.rtt}ms` : '—'} · P2P 媒体速度 —（各自读取原网站）`,
          }),
        ];
      } else {
        const ratio = Math.max(0, Math.min(1, Number(peer.remoteRatio) || 0));
        const barValue = make('div');
        barValue.style.width = `${(ratio * 100).toFixed(1)}%`;
        const forecast = forecasts.get(peer.peerId);
        const forecastText = forecastLabel(forecast);
        // 安全模式下不存在「会卡」，不上红黄色，免得把「要等」看成「出故障」。
        const tone = S.roomSecurityMode === 'trusted' ? forecast?.level || '' : '';
        mediaProgress = [
          make('div', { className: 'peer-bar' }, [barValue]),
          make('div', {
            className: 'peer-sub',
            text: `持有 ${(ratio * 100).toFixed(0)}% · 延迟 ${peer.rtt != null ? `${peer.rtt}ms` : '—'} · 收片 ${fmtMbps(forecast?.rate)}`,
          }),
          ...(forecastText ? [make('div', { className: `peer-forecast ${tone}`, text: forecastText })] : []),
        ];
      }

      return make('div', { className: 'peer' }, [
        make('div', { className: 'peer-top' }, [
          make('span', { raw: true, className: `peer-name ${stalled ? 'stalled' : ''}`, text: peer.name }),
          // 手机加入的人标一下：他跟得上列表、能聊天看弹幕，但编辑不了列表，
          // 房主知道这一点才不会等他去调顺序。昵称是用户输入，标记单独一个元素，别拼进去。
          ...(peer.platform === 'android' ? [make('span', { className: 'peer-platform', text: '（手机）' })] : []),
          make('span', { className: 'dot connected' }),
        ]),
        make('div', { className: 'peer-role' }, [roleControl]),
        ...mediaProgress,
      ]);
    })
  );
}

// 房主点「设为管理员/游客」—— 事件委托，省得每次重画都重新接线。
$('peer-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.role-toggle');
  if (!btn || S.sync?.myRole() !== 'host') return;
  S.sync.setRole(btn.dataset.peer, btn.dataset.next);
});

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
  if (linkResolveFailed()) return '这个视频链接在你的电脑上无法解析，可以先跳过这一部';
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
  // 房间在播不等于本机播放器起来了：还在等授权、或者解析失败的时候，横幅得说清在等什么
  const linkWaiting = cur?.kind === 'link' && !S.mpvRunning && (asking || failed);

  if (st.stalled) {
    banner.className = 'status-banner waiting';
    banner.textContent = stallBannerText(st.waitingFor);
  } else if (!st.paused && !linkWaiting) {
    banner.className = 'status-banner playing';
    banner.textContent = guest ? '播放中（你在独立观看，操作不影响他人）' : '播放中，所有人同步';
  } else {
    banner.className = 'status-banner';
    banner.textContent = S.mpvRunning
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
  $('btn-skip-link').classList.toggle('hidden', !(asking || failed) || skipped);
  $('btn-skip-current').classList.toggle('hidden', !(S.sync.canIControl() && currentUnavailable()));

  // 全屏看片时上面这块横幅整个看不见 —— mpv 是独立窗口。把同一句话推到 mpv 画面上。
  pushMpvBanner(st.stalled ? banner.textContent : '');

  $('btn-playpause').textContent = st.intendedPaused ? '播放' : '暂停';
  $('time-display').textContent = `${fmtTime(st.position)} / ${fmtTime(st.duration)}`;
}

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
  S.sync?.forgetPlayerState?.();
  $('btn-playpause').disabled = true;
  if (!S.switchingMedia && S.filePath) {
    $('btn-reopen')?.classList.remove('hidden');
    log(`播放器已关闭（code ${code}），可在房间里重新打开`, 'warn');
  }
  renderStatus();
}

window.sw.player.onError((payload) => handlePlayerError(payload || {}));

/* ------------------------------- 控件 ------------------------------- */

$('btn-playpause').onclick = () => {
  if (!S.sync) return;
  S.sync.userSetPaused(!S.sync.intendedPaused);
  renderStatus();
};

$('btn-reopen').onclick = () => launchPlayer();

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

$('btn-leave').onclick = leaveRoom;

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

/**
 * 设置里的缓存这一块。
 *
 * 取消文件大小上限之后这件事才真正要紧：缓存原来锁死在系统临时目录，于是系统盘
 * 剩 60GB 的机器收不了一部 100GB 的片子，哪怕另一块盘上空着好几 TB。
 * 而且缓存占了多少、能不能清，以前界面上一个字都没有 —— `env:status` 早就把
 * cacheDir 返回了，渲染层从来没读过它。
 */
function cacheField() {
  const pathLine = make('code', { text: S.env?.cacheDir || '（未知）' });
  const usageLine = make('span', { text: '正在统计…' });
  const changeButton = make('button', { className: 'ghost tiny', text: '换个位置' });
  const purgeButton = make('button', { className: 'ghost tiny', text: '清理残留' });
  const errorLine = make('div', { className: 'field-error hidden' });
  const locked = roomEntered || !!S.swarm;

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
    const dir = await window.sw.dialog.pickCacheDir();
    if (!dir) return;
    try {
      const r = await window.sw.cache.setRoot(dir);
      pathLine.textContent = r.cacheDir;
      S.env.cacheDir = r.cacheDir;
      log(`缓存目录已改到 ${r.cacheDir}`, 'good');
      refresh();
    } catch (error) {
      errorLine.textContent = t(`换不了：${error.message || error}`);
      errorLine.classList.remove('hidden');
    }
  };

  purgeButton.onclick = async () => {
    try {
      const { removed } = await window.sw.cache.purge();
      log(`清掉了 ${removed} 处残留缓存`, 'good');
      refresh();
    } catch (error) {
      errorLine.textContent = t(`清不掉：${error.message || error}`);
      errorLine.classList.remove('hidden');
    }
  };

  return field(
    '缓存位置',
    make('div', { className: 'cmd-row' }, [pathLine, changeButton, purgeButton]),
    usageLine,
    errorLine,
    hint(
      locked ? '放映进行中不能换位置，退出房间后可改。' : '接收到的片子放在这里，退房或关闭软件时自动删除。',
      '换到空间大的盘上，才收得下大文件。',
      // 让用户指定任意目录，最大的顾虑就是「会不会把我原来的东西删了」
      '清理只认本软件自己建的目录，同目录下你自己的文件一个都不会动。',
      ...(S.env?.cacheFallback
        ? [
            make('br'),
            `你配置的 ${S.env.cacheFallback.configured} 这次用不了（${S.env.cacheFallback.reason}），已临时用回系统临时目录。`,
          ]
        : [])
    )
  );
}

$('btn-settings').onclick = () => {
  openModal({
    title: '设置',
    body: () => {
      const modeLocked = roomEntered || !!S.swarm;
      const languageLocked = roomEntered || S.role !== null;
      const nameLocked = roomEntered || !!S.swarm;
      const turnPassword = make('input', {
        id: 'set-turn-pass',
        attrs: { type: 'text', placeholder: '密码' },
        props: { value: S.settings.turnPass },
      });
      turnPassword.style.marginTop = '6px';
      return [
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
            props: { value: S.name, disabled: nameLocked },
          }),
          // S.name 在 initSwarmAndSync 时就被拷进 Swarm 和 SyncEngine 了，HELLO 也早发完。
          // 房间里改名只会改本地这一份，对别人一个字都不生效 —— 与其让人以为改成了，
          // 不如像语言和安全模式那样明确锁住。真要支持改名得加一条协议消息，
          // 还要同步 swarm 的三张表和 syncEngine 里各处名字副本，是另一件事。
          nameLocked ? hint('房间进行中不能改名，退出后可改。') : []
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
              ? '房间进行中不能切换。退出后可更改。'
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
          '新房间默认人数上限（2–16）',
          make('input', {
            id: 'set-capacity',
            attrs: { type: 'number', min: 2, max: 16 },
            props: { value: String(S.roomCapacity) },
          }),
          hint('进入房间后，房主也可以在邀请区实时调整。')
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
        make('div', { className: 'field' }, [
          make('label', { className: 'check' }, [
            make('input', {
              id: 'set-turn-on',
              attrs: { type: 'checkbox' },
              props: { checked: S.settings.turnEnabled },
            }),
            '启用 TURN 中继兜底',
          ]),
          hint(
            '双方都在严格 NAT（CGNAT、卫星网络）后面时，打洞会失败，这时数据要经过中继转发。',
            '中继会看到加密后的流量并产生带宽成本，所以需要你自己提供服务器 —— 我们不代运营。'
          ),
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
          turnPassword
        ),
        make('div', { id: 'set-turn-err', className: 'field-error hidden' }),
        cacheField(),
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
    onOk: () => {
      // TURN 地址写错了要当场说。以前这里只 trim()，而 ice.js 对认不出的地址是
      // 静默丢弃 —— 用户会看到「启用 TURN 中继」勾得好好的，实际一条中继都没有，
      // 到连不上那一刻也没人告诉他为什么。
      const turnRaw = $('set-turn-url').value.trim();
      const turnCheck = normalizeTurnInput(turnRaw);
      const errorBox = $('set-turn-err');
      if (turnCheck.invalid.length) {
        errorBox.textContent = t(`这些 TURN 地址认不出来：${turnCheck.invalid.join('、')}。地址要形如 turn:example.com:3478`);
        errorBox.classList.remove('hidden');
        return false;
      }
      if ($('set-turn-on').checked && !turnRaw) {
        errorBox.textContent = t('勾了启用 TURN 中继，但地址是空的 —— 这样等于没配。填一个地址，或者把勾去掉。');
        errorBox.classList.remove('hidden');
        return false;
      }
      errorBox.classList.add('hidden');
      // 漏了 turn: 前缀是最常见的写法错误，意思很清楚，直接补上
      if (turnCheck.fixed.length) $('set-turn-url').value = turnCheck.urls.join(' ');
      const languageLocked = roomEntered || S.role !== null;
      const nextLanguage = languageLocked ? S.settings.language : $('set-language').value;
      const languageChanged = nextLanguage !== S.settings.language;
      if (!languageLocked) {
        S.settings.language = setLocale(nextLanguage);
      }
      if (!roomEntered && !S.swarm) S.name = $('set-name').value.trim().slice(0, 40) || S.name;
      if (!roomEntered && !S.swarm) {
        S.settings.securityMode = normalizeSecurityMode($('set-security-mode').value);
        if (S.role === 'host') S.roomSecurityMode = S.settings.securityMode;
      }
      S.settings.signalUrl = $('set-signal').value.trim();
      S.roomCapacity = clampCapacity($('set-capacity').value);
      S.settings.stun = $('set-stun').value.trim();
      S.settings.turnEnabled = $('set-turn-on').checked;
      S.settings.turnUrl = $('set-turn-url').value.trim();
      S.settings.turnUser = $('set-turn-user').value.trim();
      S.settings.turnPass = $('set-turn-pass').value.trim();

      localStorage.setItem('sw.name', S.name);
      localStorage.setItem('sw.securityMode', S.settings.securityMode);
      localStorage.setItem('sw.signalUrl', S.settings.signalUrl);
      localStorage.setItem('sw.roomCapacity', String(S.roomCapacity));
      localStorage.setItem('sw.stun', S.settings.stun);
      localStorage.setItem('sw.turnEnabled', S.settings.turnEnabled ? '1' : '0');
      localStorage.setItem('sw.turnUrl', S.settings.turnUrl);
      localStorage.setItem('sw.turnUser', S.settings.turnUser);
      localStorage.setItem('sw.turnPass', S.settings.turnPass);
      // 切到安全模式时依赖胶囊要重算 —— Defender 没在跑这件事只在安全模式下算缺件。
      updateDepsPill();
      if (languageChanged) setTimeout(() => location.reload(), 0);
      return true;
    },
  });
};

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

async function openInviteLink(raw) {
  if (!raw) return;
  try {
    const payload = await decodeCode(raw);
    if (payload.k === 'answer' && S.role === 'host' && S.pendingManualPeer) {
      await acceptManualAnswer(raw);
      return;
    }
    if (roomEntered) {
      log('请先退出当前房间，再打开新的邀请链接。', 'warn');
      return;
    }
    $('join-code').value = raw;
    show('view-home');
    await handleJoinInput(raw);
  } catch (error) {
    if (roomEntered) log(error.message || String(error), 'bad');
    else $('join-err').textContent = error.message || String(error);
  }
}

window.sw.app.onDeepLink(openInviteLink);

boot()
  .then(async () => {
    const initialLink = await window.sw.app.takeDeepLink();
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
