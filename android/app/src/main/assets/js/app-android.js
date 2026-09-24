/**
 * 安卓端编排（观众专用）。
 *
 * 复用 PC 端的协议核心（peer/swarm/scheduler/syncEngine/signaling/playlist），
 * 只把「存储」和「播放器」换成原生实现（经 native-shim 的 window.sw / window.swPlayer）。
 * 信令握手规则与 PC 端 connectSignaling 保持一致，才能互相连上。
 *
 * 手机永远是加入者：跟着房主的播放列表走当前那一部，要片、参与全员暂停联动，不做种、不当房主。
 * 房主给了管理员身份的话可以编辑列表（加在线链接、调序、移除、立即播放），操作发给房主执行。
 */

import './native-shim.js';
import { Peer } from './peer.js';
import { Swarm } from './swarm.js';
import { SyncEngine } from './syncEngine.js';
import { WsSignaling, encodeCode, decodeCode, inviteLink, randomPeerId } from './signaling.js';
import { RelaySignaling } from './relaySignaling.js';
import {
  buildIceServers,
  diagnoseCandidates,
  normalizeTurnInput,
  peerIceConfig,
  summarizeCandidates,
  turnMissingCredentials,
} from './ice.js';
import { RelayUsageMeter, cloudflareRelayPairs, onlyCloudflareRelays } from './turnUsage.js';
import { MSG, PROTOCOL_VERSION, normalizePlatform } from './protocol.js';
import { catalogOf, createPlaylist, currentItem, findItem, reorderIds, validateSnapshot } from './playlist.js';
import { ChatGate, ChatSender, parseHistory, trustsRelay } from './chat.js';
import { AREAS, DanmakuEngine, DEFAULT_SETTINGS as DANMAKU_BASE } from './danmaku.js';
import { currentLocale, setLocale, SKIP_ATTR, startI18n, translate as t } from './i18n.js';

startI18n();

const HEAD_READY_BYTES = 8 * 1024 * 1024; // 片头下够才起播（同 PC：全零稀疏文件起播拿不到 moov）
// 起播点不在片头时（中途加入、「回头接着放」），起播点往后还要有这么多连续内容。
// 15 秒是同步引擎的恢复线，2 秒是解复用器预读；安卓再乘 1.5 ——
// SyncPlayer 不输出 streamPos，播放字节位置只能按平均码率折算，VBR 下这份误差直接进判定。
const START_RUN_SECONDS = 15;
const DEMUX_READAHEAD_SECONDS = 2;
const ANDROID_RUN_SLACK = 1.5;
const MIN_START_RUN_BYTES = 4 * 1024 * 1024; // 码率未知时的兜底
// 极简模式下等房主打开应答链接的时限，与桌面端 MANUAL_JOIN_WAIT_TIMEOUT_MS 一致。
// 比房主侧的握手超时宽得多：房主是粘完应答才开始计时，这边应答一生成就在探测了。
const MANUAL_JOIN_WAIT_TIMEOUT_MS = 180_000;
const MANIFEST_RETRY_MS = 5000;
// 清单拿到了、本机却开不了接收会话（多半是存储不够）时，隔这么久用手里的清单再试一次
const RECEIVE_RETRY_MS = 30_000;
// 邀请链接/邀请码的长度上限，和原生 MainActivity.MAX_INVITE_LINK_CHARS 一致。
// 正常的一对一邀请只有一两千字；码是 gzip 压过的，几百 KB 的码解压出来能在页面里撑出上百 MB。
const MAX_INVITE_CHARS = 32 * 1024;
// 「离开并加入」要整页重载，重载前把那条邀请记在这里，重载完接着处理
const PENDING_INVITE_KEY = 'sw.pendingInvite';
// 页面上的日志最多留这么多行（再多就丢最老的）
const LOG_VIEW_LIMIT = 200;
// 加入流程里单独一步（生成应答、连信令）最多等这么久，超时就当失败，放开「正在加入」的闸门
const JOIN_STEP_TIMEOUT_MS = 30_000;
// 房间链接要等房主放行（relaySignaling 自己最多等 30 秒，连中继还要几秒），闸门给宽一点
const RELAY_JOIN_TIMEOUT_MS = 60_000;
// 房主改列表的回音最多等这么久（和桌面端 PLAYLIST_OP_TIMEOUT_MS 一致）
const PLAYLIST_OP_TIMEOUT_MS = 45_000;
const normalizeSecurityMode = (mode) => (mode === 'trusted' ? 'trusted' : 'safe');
const securityModeLabel = (mode) => (normalizeSecurityMode(mode) === 'trusted' ? '可信房间' : '安全模式');

const S = {
  peerId: randomPeerId(),
  name: '',
  hostId: null, // 房主 peerId：极简模式和房间链接从链接里得来；信令模式手里没码，靠首个 ROLE 认定
  swarm: null,
  sync: null,
  signaling: null,
  // 这一场的信令走什么：'relay'（房间链接，公共中继）/ 'ws'（自建信令服务器）/ null（一对一邀请）
  signalTransport: null,
  // 连接设置：TURN 中继、隐藏我的 IP。和桌面端同一组 localStorage 键（见 loadNetSettings）
  net: loadNetSettings(),
  // Cloudflare 的临时 TURN 账号 { urls, username, credential, expiresAt }，原生层生成，这里只缓存。
  // API Token 永远不到页面里来。
  cfTurn: null,
  // 原生层报来的 Cloudflare TURN 状态 { configured, expiresAt, lastError }
  cfTurnState: null,
  // 本月本机统计的用量 { month, usedBytes, limitGB, exceeded, nearLimit }
  cfTurnUsage: null,
  // 发给房主、还在等回音的列表操作：reqId -> 回调
  pendingOps: new Map(),
  // 房主的播放列表（最近一次收到的快照）和当前项
  playlist: createPlaylist(),
  current: null,
  currentSeq: -1,
  // 当前项的接收会话。手机只收当前这一部：{fileId, slot, sessionId, manifest}
  session: null,
  opening: null,
  // 本机开不了接收会话的那一部：{fileId, message, manifest, retryAt}
  receiveError: null,
  manifest: null,
  sourceType: null,
  linkInfo: null,
  nowLink: null,
  approvedSites: new Set(),
  playerStarted: false,
  playerTimer: null,
  // 播放器代号：原生的 load/release 落地前，快照还属于上一代，靠它认出来并丢弃
  playerGen: 0,
  // 「你是中途加入的」这句话每一部只说一次
  midJoinNoted: false,
  // 「中途加入但算不出房间位置」同理，每一部只说一次
  midJoinBlindNoted: false,
  prog: { contiguousBytes: 0, runBytes: 0, runEndBytes: 0, playbackByte: 0, complete: false },
  entered: false,
  // 加入流程正在跑（解码邀请、收集候选、连信令）：这期间再来的邀请一律不收
  joining: false,
  // 信令模式已经进了房（首连成功）。之后信令断线重连期间也还算在房间里
  serverJoined: false,
  // 极简模式上一次还没连上的尝试：{cancel()}，新的一次开始前把它的定时器和监听收掉
  manualAttempt: null,
  securityMode: localStorage.getItem('sw.securityMode') === 'safe' ? 'safe' : 'trusted',
  // 在线链接怎么跟房主：'full' 完全同步（默认），'manual' 手动同步。只存在这台手机上
  linkSync: localStorage.getItem('sw.linkSync') === 'manual' ? 'manual' : 'full',
  // 站点授权对话框正在弹着（同一时间只弹一次）
  askingSite: false,
  // 聊天。gate 管收端（先去重再扣令牌、只认房主转发来的 origin），sender 管发端。
  // history 只有房主用得上，手机永远不是房主，所以这里没有它。
  // names 得自己留一份：peer-gone 时 swarm 的 peers 表已经清空，再也查不出「走的是谁」。
  chat: {
    entries: [],
    gate: new ChatGate(),
    sender: new ChatSender(),
    names: new Map(),
    historyShown: false,
    notice: '',
  },
  // 本机弹幕设置（开关、不透明度、字号、速度、显示区域），存 localStorage，只影响自己。
  // 真正的值在下面弹幕那一节补上：loadDanmakuSettings 要用到那边的 const，这里读会撞上 TDZ。
  danmakuSettings: null,
  // 弹幕层，进页面时装好（见底部的事件绑定）
  danmaku: null,
};

/* ------------------------------ DOM 小工具 ------------------------------ */
const $ = (id) => document.getElementById(id);
function show(node, on) { node.style.display = on ? '' : 'none'; }

/**
 * 建节点。界面文案一律过 t()；用户写的东西（昵称、聊天正文、片名）用 raw ——
 * 既不过 t()，也打上 data-i18n-skip，自动翻译的 MutationObserver 不会再碰它，
 * 否则昵称叫「播放」的人在英文界面里会变成 Play。和桌面端 ui/dom.js 的 make() 同一套约定。
 *
 * 正文一律走 textContent，绝不拼 innerHTML —— 聊天和片名都是别人发来的字符串。
 */
function el(tag, { className, text, title, raw = false, attrs } = {}, children = []) {
  const node = document.createElement(tag);
  if (raw) node.setAttribute(SKIP_ATTR, '');
  if (className) node.className = className;
  if (text !== undefined) node.textContent = raw ? String(text) : t(String(text));
  if (title !== undefined) node.setAttribute('title', raw ? String(title) : t(String(title)));
  if (attrs) for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

function log(msg, level) {
  const box = $('log');
  const line = document.createElement('div');
  if (level) line.className = 'log-' + level;
  line.textContent = msg;
  box.appendChild(line);
  // 有些日志是别人发的消息触发的（比如非房主发来的列表），不设上限就是一直涨的 DOM。
  // 超出时一次砍掉一截，别每来一行都重排一遍
  if (box.children.length > LOG_VIEW_LIMIT + 50) box.replaceChildren(...[...box.children].slice(-LOG_VIEW_LIMIT));
  box.scrollTop = box.scrollHeight;
  console.log('[app]', msg);
}

/** 给一个 Promise 加时限：到点还没结果就按 message 失败。原来那个 Promise 不受影响。 */
function withTimeout(promise, ms, message) {
  let timer = null;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

// 对端能反复触发的警告：同一句一段时间内只记一次，别让人拿它刷屏（键是固定文案，数量有限）
const noisyLoggedAt = new Map();
function logThrottled(msg, level, windowMs = 10_000) {
  const now = Date.now();
  if (now - (noisyLoggedAt.get(msg) ?? -Infinity) < windowMs) return;
  noisyLoggedAt.set(msg, now);
  log(msg, level);
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  const h = Math.floor(m / 60);
  if (h) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ------------------------------ ICE 配置 ------------------------------ */
// 规则和桌面端一样（lib/ice.js）：只配一台 STUN 时自动补两台兜底 —— 手机换基站、切 Wi-Fi 的
// 频率比桌面高得多，那一台一旦不通就拿不到公网地址；TURN 地址自动展开成 UDP + TCP 两条。
//
// TURN 需要用户自己提供：自己填服务器，或者用自己的 Cloudflare 账号自动生成临时账号。
// 「隐藏我的 IP」（S.net.relayOnly）打开时只经 TURN 中继连接、不带 STUN；
// 这时没有可用中继就不建连接（relayOnlyBlocked / peerIce），绝不悄悄退回直连。

/** 连接设置。键和桌面端完全一样，同一台设备上换端也认得。坏值一律回落到默认，绝不抛。 */
function loadNetSettings() {
  const get = (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  return {
    turnSource: get('sw.turnSource') === 'cloudflare' ? 'cloudflare' : 'manual',
    turnEnabled: get('sw.turnEnabled') !== '0',
    turnUrl: get('sw.turnUrl') || '',
    turnUser: get('sw.turnUser') || '',
    turnPass: get('sw.turnPass') || '',
    relayOnly: get('sw.relayOnly') === '1',
  };
}

function saveNetSettings(next) {
  S.net = { ...S.net, ...next };
  try {
    localStorage.setItem('sw.turnSource', S.net.turnSource);
    localStorage.setItem('sw.turnEnabled', S.net.turnEnabled ? '1' : '0');
    localStorage.setItem('sw.turnUrl', S.net.turnUrl);
    localStorage.setItem('sw.turnUser', S.net.turnUser);
    localStorage.setItem('sw.turnPass', S.net.turnPass);
    localStorage.setItem('sw.relayOnly', S.net.relayOnly ? '1' : '0');
  } catch {
    /* 写不进去就只在这一场生效 */
  }
}

let turnWarned = false;

/** 组 ICE 配置要的全部输入：设置、Cloudflare 的临时账号（本月用量到上限时当它不存在）、此刻的时间。 */
function iceInputs() {
  return { ...S.net, cfTurn: S.cfTurnUsage?.exceeded ? null : S.cfTurn, now: Date.now() };
}

function iceServers() {
  // 开了中继却没填密码：这种中继 buildIceServers 不会交出去，说一声，别让人以为中继在工作
  if (!turnWarned && turnMissingCredentials(S.net)) {
    turnWarned = true;
    log('TURN 中继开着但没填用户名或密码，这次先不走中继、只尝试直连。到连接设置里补全，或者把中继关掉。', 'warn');
  }
  return buildIceServers(iceInputs());
}

const RELAY_ONLY_NO_TURN = '已打开「隐藏我的 IP」，但还没有可用的 TURN 中继：请在连接设置里配好 TURN，或者先关掉这个开关。';

/** Cloudflare TURN 本月用量到了上限时的说法。 */
function cfQuotaText(limitGB = S.cfTurnUsage?.limitGB) {
  return `本月 Cloudflare TURN 用量已到你设的上限（${limitGB || '?'} GB），为免扣费已停用；下个月 1 日自动恢复，或者在连接设置里调高上限`;
}

/**
 * 「隐藏我的 IP」开着、却没有可用的 TURN 中继时，拦下连接的原因；不拦返回空串。
 * 这时绝不能悄悄退回直连 —— 那就等于把 IP 交出去了。
 */
function relayOnlyBlocked() {
  if (!S.net.relayOnly || peerIceConfig(iceInputs())) return '';
  if (S.net.turnSource === 'cloudflare' && S.cfTurnUsage?.exceeded) {
    return `${cfQuotaText()}。「隐藏我的 IP」开着，没有中继就不连接。`;
  }
  return RELAY_ONLY_NO_TURN;
}

/**
 * 建 Peer 用的 { iceServers, iceTransportPolicy }。这个文件里所有 new Peer 都从这里拿。
 * 「隐藏我的 IP」开着时策略是 'relay'（只收集中继候选）；没有可用中继就抛错，不建连接。
 */
function peerIce() {
  if (!S.net.relayOnly) return { iceServers: iceServers(), iceTransportPolicy: 'all' };
  const config = peerIceConfig(iceInputs());
  if (!config) throw new Error(relayOnlyBlocked() || RELAY_ONLY_NO_TURN);
  return config;
}

/** 信令事件里建连接用：被「隐藏我的 IP」拦下时记一条日志、返回 null，调用方不建连接。 */
function signalPeerIce() {
  try {
    return peerIce();
  } catch (error) {
    logThrottled(error.message || String(error), 'bad');
    return null;
  }
}

/** 这一侧是不是配了中继（诊断里「配了中继却没拿到中继候选」要用）。 */
function turnConfigured() {
  return S.net.turnSource === 'cloudflare'
    ? Boolean(S.cfTurn && S.cfTurn.expiresAt > Date.now() && !S.cfTurnUsage?.exceeded)
    : Boolean(S.net.turnEnabled && S.net.turnUrl);
}

/**
 * 自己这边的 SDP 里候选够不够用（一对一邀请的应答是整份 SDP，看得到全部候选）。
 * 只在有问题时说：只走中继却一条中继都没有、配了中继却没拿到中继候选、一个候选都没有。
 */
function adviseLocalCandidates(sdp) {
  const stats = summarizeCandidates(sdp || '');
  const configured = turnConfigured();
  // 「拿到了公网地址，但没有中继兜底」是常态，不在每次加入时都念一遍
  if (!S.net.relayOnly && stats.total && !(configured && !stats.relay)) return;
  const diag = diagnoseCandidates(stats, { turnConfigured: configured, relayOnly: S.net.relayOnly });
  if (diag && diag.level !== 'ok') log(diag.text, diag.level === 'bad' ? 'bad' : 'warn');
}

/* ---------------------------- Cloudflare TURN ---------------------------- */
// 和桌面端同一套：API Token 只在原生层（安卓系统密钥库加密保存），页面只拿 24 小时的临时账号。
// 离过期不到两小时就换一组；取失败后隔一会儿再试，别让每建一条连接都干等十秒。

const CF_REFRESH_BEFORE_MS = 2 * 60 * 60 * 1000;
const CF_RETRY_MS = 30_000;
const CF_MIN_TIMER_MS = 60_000;
let cfTurnFetch = null;
let cfTurnRetryAt = 0;
let cfTurnTimer = null;
let cfQuotaLogged = false;

/** 原生层报错里的代码（CF_NETWORK 这类）。 */
function cfErrorCode(error) {
  const m = /\[(CF_[A-Z_]+)\]/.exec(String(error?.message || error || ''));
  return m ? m[1] : '';
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
  if (S.net.turnSource !== 'cloudflare') return false;
  if (S.cfTurn && S.cfTurn.expiresAt - Date.now() > CF_REFRESH_BEFORE_MS) return false;
  return Boolean(cfTurnFetch) || Date.now() >= cfTurnRetryAt;
}

/** 本月用量到了上限：手上的临时账号作废，新建的连接不再带 Cloudflare TURN。只在日志里说一次。 */
function markCfQuota(limitGB) {
  S.cfTurn = null;
  clearTimeout(cfTurnTimer);
  cfTurnTimer = null;
  S.cfTurnUsage = { ...(S.cfTurnUsage || {}), exceeded: true, ...(limitGB ? { limitGB } : {}) };
  if (!cfQuotaLogged && S.net.turnSource === 'cloudflare') {
    cfQuotaLogged = true;
    log(cfQuotaText(), 'bad');
  }
}

/**
 * 把 Cloudflare 的临时 TURN 账号备好。来源不是 Cloudflare、或者手上的还新鲜时什么都不做。
 * 取不到也不抛错：没开「隐藏我的 IP」就记一条日志、照常直连；开了的话，
 * 紧接着的 relayOnlyBlocked() 会把连接拦下。同时只发一个请求。
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
        if (S.cfTurnUsage?.exceeded) S.cfTurnUsage = { ...S.cfTurnUsage, exceeded: false };
        S.cfTurnState = { ...(S.cfTurnState || {}), configured: true, expiresAt: creds.expiresAt, lastError: null };
        scheduleCfTurnRefresh();
      } catch (error) {
        cfTurnRetryAt = Date.now() + CF_RETRY_MS;
        const code = cfErrorCode(error) || 'CF_NETWORK';
        S.cfTurnState = { ...(S.cfTurnState || {}), lastError: code };
        if (code === 'CF_QUOTA') {
          markCfQuota(Number(/（(\d+) GB）/.exec(String(error?.message || ''))?.[1]) || 0);
        } else if (S.net.relayOnly) {
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
  if (S.net.turnSource !== 'cloudflare' || !S.cfTurn || !(S.cfTurn.expiresAt > Date.now())) return;
  const wait = Math.max(CF_MIN_TIMER_MS, S.cfTurn.expiresAt - CF_REFRESH_BEFORE_MS - Date.now());
  cfTurnTimer = setTimeout(async () => {
    cfTurnTimer = null;
    await ensureTurnReady().catch(() => {});
    scheduleCfTurnRefresh();
  }, wait);
}

/** 用量（原生层报来的）：第一次过 80% 在日志里提醒一次；到上限就停用 Cloudflare TURN。 */
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
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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

/** 连接设置里 Cloudflare 那几行：状态、用量、快到上限的提醒。 */
function renderCfTurnStatus() {
  const status = $('cf-status');
  if (status) status.textContent = cfTurnStatusText();
  const usage = $('cf-usage');
  if (usage) usage.textContent = cfUsageText();
  const warn = $('cf-warn');
  if (warn) {
    const near = Boolean(S.cfTurnUsage?.nearLimit && !S.cfTurnUsage?.exceeded);
    warn.textContent = near ? '本月用量已超过上限的 80%，快到上限了。' : '';
    show(warn, near);
  }
  const limit = $('cf-limit');
  if (limit && S.cfTurnUsage?.limitGB && document.activeElement !== limit) limit.value = String(S.cfTurnUsage.limitGB);
}

/* ------------------------- Cloudflare TURN 用量计量 ------------------------- */
// 每条连接每 10 秒读一次 getStats()，本地候选是 Cloudflare 中继的候选对收发都算，
// 按 RTCPeerConnection 记增量，交给原生层按 UTC 自然月累加。汇报失败的攒着下一轮一起报。
const TURN_METER_MS = 10_000;
const TURN_REPORT_MAX = 64 * 1e9;
const turnMeter = new RelayUsageMeter();
let turnMeterBusy = false;
let turnUsagePending = 0;

async function meterTurnUsage() {
  if (turnMeterBusy || !window.sw.turn) return;
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

setInterval(() => meterTurnUsage(), TURN_METER_MS);

/* ------------------------- 群管理 + 同步引擎 ------------------------- */
function initSwarmAndSync() {
  if (S.swarm) return;
  S.name = ($('name').value.trim() || '观众') .slice(0, 20);
  S.securityMode = normalizeSecurityMode($('security-mode').value);
  localStorage.setItem('sw.securityMode', S.securityMode);
  $('security-mode').disabled = true;

  S.swarm = new Swarm({ peerId: S.peerId, name: S.name, securityMode: S.securityMode, platform: 'android' });
  S.sync = new SyncEngine({
    peerId: S.peerId,
    name: S.name,
    isSeeder: false,
    hostId: S.hostId, // 极简模式=邀请码里的房主 id；信令模式=null，先当游客，等首个 ROLE 认定
  });

  // 同步引擎驱动原生播放器（对应 PC 端驱动 mpv）
  S.sync.onSetPause = (paused) => window.swPlayer.setPause(paused);
  S.sync.onSeek = (sec) => window.swPlayer.seek(sec);

  // 同步引擎要广播的指令 → 发给所有已连 peer 的 ctrl 通道
  S.sync.on('outbound', (msg) => {
    for (const p of S.swarm.peers.values()) {
      if (p.authenticated) p.send(msg);
    }
  });
  S.sync.on('remote-action', ({ kind, by, position }) => {
    log(`${by} ${kind === 'pause' ? '暂停了' : kind === 'play' ? '继续播放' : '跳转了'}`, 'good');
    // 聊天流里只记播放和暂停。同步引擎也只报这两种（跳转是跟着 SYNC 一起到的，
    // 不单独报），label 取不到就不记 —— 将来多出新的动作也不会在聊天流里冒出 undefined。
    const label = { play: '播放', pause: '暂停' }[kind];
    if (label) chatSystem(`${by} ${label} @ ${fmtTime(position)}`);
  });
  S.sync.on('stall-change', renderWaiting);
  S.sync.on('state', renderWaiting);
  // 在线链接：和房主差了多少秒
  S.sync.on('drift', renderDrift);
  S.sync.on('drift-correct', ({ seconds }) => log(`和房主差了 ${Math.abs(seconds).toFixed(1)} 秒，自动对齐`));
  S.sync.on('duration', (d) => {
    if (S.session?.slot != null) S.swarm.setDuration(S.session.slot, d);
  });
  // 房主分配的角色变了 → 更新「我是游客还是管理员」的界面（游客禁用拖动条）
  S.sync.on('roles', renderRole);
  // 游客拖了进度被拦下：把滑块弹回、给个提示
  S.sync.on('denied', ({ action }) => {
    if (action === 'seek') {
      log('你是游客，不能拖动进度', 'warn');
      renderRole();
    }
  });

  // swarm 事件
  S.swarm.on('progress', onProgress);
  S.swarm.on('peers', renderPeers);
  S.swarm.on('peer-gone', (id) => {
    S.sync.peerGone(id);
    S.chat.gate.forget(id);
    const gone = S.chat.names.get(id);
    if (gone) {
      S.chat.names.delete(id);
      chatSystem(`${gone} 离开了房间`);
    }
    renderPeers();
    ensureCurrentSession();
  });
  S.swarm.on('sources', () => ensureCurrentSession());
  S.swarm.on('complete', () => log('全部下载完成', 'good'));
  S.swarm.on('peer-authenticated', (peer) => {
    log(`已和 ${peer.name} 完成${securityModeLabel(S.securityMode)}握手`, 'good');
    S.chat.names.set(peer.peerId, peer.name);
    chatSystem(`${peer.name} 加入了房间`);
    S.sync?.greet(peer);
  });
  S.swarm.on('mode-mismatch', ({ localMode, remoteMode }) => {
    log(`模式不一致：本机是${securityModeLabel(localMode)}，对方是${securityModeLabel(remoteMode)}，已在传输媒体前断开。`, 'bad');
    S.signaling?.close();
  });
  S.swarm.on('version-mismatch', ({ name, remoteVersion }) => {
    log(
      remoteVersion < PROTOCOL_VERSION
        ? `${name} 用的是旧版 NoxReel（0.6.x），和 0.7 不互通，已断开。`
        : `${name} 用的是更新版本的 NoxReel，请先升级手机上的 NoxReel。`,
      'bad'
    );
  });
  S.swarm.on('identity-mismatch', ({ expected }) => {
    log(`已断开身份校验失败的成员：${expected}`, 'bad');
  });
  // 播放列表、链接地址、聊天归这里管；SYNC / STALL 这些同步消息转给同步引擎。
  // 列表操作（PLAYLIST_OP）只由手机发给房主，房主是列表的唯一权威；这里只收房主的回音。
  S.swarm.on('ctrl', ({ msg, peer }) => {
    if (msg.t === MSG.PLAYLIST) onPlaylist(msg, peer);
    else if (msg.t === MSG.PLAYLIST_ACK) onPlaylistAck(msg, peer);
    else if (msg.t === MSG.PLAYLIST_OP) return; // 手机不是房主，别人发来的列表操作一律不认
    else if (msg.t === MSG.NOW_LINK) onNowLink(msg, peer);
    else if (msg.t === MSG.CHAT) onChatMessage(msg, peer);
    else if (msg.t === MSG.CHAT_HISTORY) onChatHistory(msg, peer);
    else S.sync.onCtrl(msg, peer);
  });

  S.swarm.start();
}

function fromHost(peer) {
  const knownHost = S.hostId || S.sync?.hostId;
  return !!knownHost && peer.peerId === knownHost;
}

/* ------------------------- 播放列表 → 当前项 ------------------------- */
function onPlaylist(msg, peer) {
  if (!fromHost(peer)) {
    logThrottled('已忽略非房主发来的播放列表', 'warn');
    return;
  }
  const snap = validateSnapshot(msg.state);
  if (!snap || snap.rev <= S.playlist.rev) return;
  if (!sameItemsKept(S.playlist, snap)) {
    logThrottled('收到的播放列表把已有条目的内容换掉了，已忽略', 'warn');
    return;
  }
  S.playlist = snap;
  S.swarm.setCatalog(catalogOf(snap));
  if (snap.seq !== S.currentSeq) switchCurrent(currentItem(snap));
  else S.current = currentItem(snap);
  renderFilmInfo();
  renderPlaylistPanel();
}

/**
 * 同一个 id 必须还是同一样东西（和桌面端同一条规则）。房主那边把某一项的网址、文件换掉而 id 不变的话，
 * 列表里写着的还是原来那个，点「允许」批准的却是从没见过的网站。改了就整张拒收。
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

function stopPlayback() {
  if (S.playerTimer) clearInterval(S.playerTimer);
  S.playerTimer = null;
  S.playerStarted = false;
  // 播放器这一代退了：弹幕停帧、整场清空（换片、跳转都经这里）
  S.danmaku?.setActive(false);
  // 释放也占一个代号：落地之前来的快照仍属于上一代，认代号就能丢掉
  S.playerGen = window.swPlayer.release();
}

/** 手机只收当前这一部，换片时把上一部的会话关掉（播放器先释放）。 */
function closeSession() {
  const sess = S.session;
  S.session = null;
  if (!sess) return;
  S.swarm.removeFile(sess.slot);
  window.sw.store.close(sess.sessionId);
}

function switchCurrent(item) {
  const seq = S.playlist.seq;
  S.currentSeq = seq;
  S.current = item;
  stopPlayback();
  if (!item || item.kind !== 'file' || item.fileId !== S.session?.fileId) closeSession();
  S.manifest = S.session?.manifest || null;
  S.sourceType = item?.kind || null;
  S.linkInfo = null;
  S.prog =
    item?.kind === 'link'
      ? { contiguousBytes: 0, runBytes: 0, runEndBytes: 0, playbackByte: 0, complete: true }
      : {
          contiguousBytes: 0,
          runBytes: 0,
          runEndBytes: 0,
          playbackByte: 0,
          complete: false,
          chunkCount: item?.chunkCount || 0,
        };
  S.sync.forgetPlayerState();
  S.swarm.setPlaying(item?.kind === 'file' ? item.slot : null);
  S.sync.resetMedia({ isSeeder: item?.kind === 'link', seq, position: item?.resumeAt || 0 });
  // 手机永远不是房主，跟随方式就是本机选的那个
  S.sync.setFollow({ streaming: item?.kind === 'link', mode: S.linkSync });
  if (item) S.sync.setMediaInfo({ duration: item.durationSec || 0, size: item.kind === 'file' ? item.size : 0 });
  // eof 守卫要用它判断「手上有没有一路连到文件尾的数据」
  S.sync.sizeHint = item?.kind === 'file' ? item.size : 0;
  S.midJoinNoted = false;
  S.midJoinBlindNoted = false;
  S.sync.start();
  // 旧播放器的轮询已经停了，没有会话 / 还没拿到地址时再没有别的地方刷新这几栏，
  // 不在这里重画的话会一直显示上一部的「可播 100%」和上一部的时间。
  renderStatus(S.prog);
  renderIdlePlayback(item);
  enterStage();
  renderPlaylistPanel();
  if (!item) {
    log('播放列表已经放完了', 'good');
    renderFilmInfo();
    return;
  }
  chatSystem(`现在放：${itemName(item)}`);
  if (item.kind === 'link') {
    // 站点授权要等人点按钮，这条路变成了异步：谁都不 await 它，得自己兜住异常，
    // 否则一个未处理的 rejection 在 WebView 里连条日志都留不下
    playLink(seq);
    return;
  }
  if (S.session) {
    S.swarm.setActive(S.session.slot);
    onProgress(S.swarm.progress(S.session.slot));
  } else if (S.receiveError?.fileId === item.fileId) {
    // 这一部之前就收不下：不报卡顿（resetMedia 已经清掉了本地卡顿），马上用手里的清单再试一次。
    // 先报卡顿再撤销的话，手机是管理员时全房会平白停一下。
    S.receiveError.retryAt = 0;
    ensureCurrentSession();
  } else {
    // 手上一片都没有，别让别人以为我准备好了
    S.sync.onBufferProgress({ contiguousBytes: 0, runBytes: 0, complete: false });
    ensureCurrentSession();
  }
}

function manifestCandidates(item) {
  const ids = [];
  const push = (id) => {
    if (id && id !== S.peerId && !ids.includes(id) && S.swarm.peers.get(id)?.authenticated) ids.push(id);
  };
  push(item.sourceId);
  push(S.hostId || S.sync?.hostId);
  for (const id of S.swarm.sourcesFor(item.slot)) push(id);
  return ids;
}

let manifestRetryAt = 0;

/** 当前项还没有会话：向有片的人要清单，开接收会话。 */
async function ensureCurrentSession() {
  const item = S.current;
  if (!S.swarm || !item || item.kind !== 'file' || S.session || S.opening === item.fileId) return;
  // 上次清单拿到了却开不了会话：清单还在手上，到点直接重开，不再向人要
  const failed = S.receiveError?.fileId === item.fileId ? S.receiveError : null;
  if (failed) {
    if (Date.now() < failed.retryAt) return;
  } else if (Date.now() < manifestRetryAt || !S.swarm.canFinish(item.slot)) {
    return;
  }
  S.opening = item.fileId;
  try {
    const manifest = failed
      ? failed.manifest
      : await S.swarm.requestManifest(item.fileId, {
        candidates: manifestCandidates(item),
        // 片名以房主的列表为准：供片的人改了清单里的名字（比如换个扩展名）也不认
        expect: { name: item.name, size: item.size, chunkCount: item.chunkCount, durationSec: item.durationSec },
      });
    // 按 fileId 认当前项，不按对象：房主开播、成员进出、往后面加片都会发一份 seq 不变的新快照，
    // 当前项换成了新对象但还是这一部。按对象比会把刚拿到的合法清单丢掉，之后再没人来要它。
    const cur = S.current;
    if (!cur || cur.kind !== 'file' || cur.fileId !== item.fileId || S.session) return;
    let sessionId;
    try {
      sessionId = window.sw.store.openLeech(manifest);
    } catch (e) {
      receiveFailed(cur, manifest, e);
      return;
    }
    // 只作废这一部自己的失败记录：别的片收不下的记录（连同清单）还要留着，
    // 那一部再成为当前项时才能不先报卡顿、直接重试
    if (S.receiveError?.fileId === cur.fileId) S.receiveError = null;
    const state = window.sw.store.sessionState(sessionId);
    S.session = { fileId: cur.fileId, slot: cur.slot, sessionId, manifest };
    S.manifest = manifest;
    S.swarm.addFile({ slot: cur.slot, manifest, sessionId, isSeeder: false, state });
    S.swarm.setActive(cur.slot);
    renderFilmInfo();
    log(`开始接收《${manifest.name}》 · ${fmtBytes(manifest.size)}`, 'good');
    onProgress(S.swarm.progress(cur.slot));
  } catch (e) {
    manifestRetryAt = Date.now() + MANIFEST_RETRY_MS;
    setTimeout(ensureCurrentSession, MANIFEST_RETRY_MS + 50);
    log(`还没拿到《${item.name}》的清单：${e.message}`, 'warn');
  } finally {
    if (S.opening === item.fileId) S.opening = null;
  }
}

/**
 * 当前项本机明确收不下（多半是存储不够）。手上一片都没有，但这不是「在缓冲」——
 * 接着报卡顿的话，手机是管理员时全房会一直停着等它，而之后再没有进度事件能把卡顿解开。
 * 这一部先退出卡顿判定，原因写在状态栏上；清单留着，隔一阵再试，腾出空间后就能接着收。
 */
function receiveFailed(item, manifest, e) {
  const repeated = S.receiveError?.fileId === item.fileId;
  S.receiveError = { fileId: item.fileId, message: e.message, manifest, retryAt: Date.now() + RECEIVE_RETRY_MS };
  S.manifest = manifest;
  S.sync.onBufferProgress({ contiguousBytes: 0, runBytes: 0, complete: true });
  renderFilmInfo();
  renderStatus(S.prog);
  if (!repeated) log('打开接收会话失败：' + e.message, 'bad');
  setTimeout(ensureCurrentSession, RECEIVE_RETRY_MS + 50);
}

/* ----------------------- 网页/直链媒体 ----------------------- */
function safePlaybackFromMessage(msg) {
  const playback = msg && msg.playback;
  if (!playback || typeof playback.url !== 'string' || playback.url.length > 16384) return null;
  try {
    const parsed = new URL(playback.url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  } catch {
    return null;
  }
  const headers = {};
  const allowed = new Set(['accept', 'accept-language', 'origin', 'referer', 'user-agent']);
  if (playback.headers && typeof playback.headers === 'object' && !Array.isArray(playback.headers)) {
    for (const [rawName, rawValue] of Object.entries(playback.headers)) {
      const name = String(rawName).trim().toLowerCase();
      if (!allowed.has(name) || typeof rawValue !== 'string' || !rawValue || rawValue.length > 2048) continue;
      if (/\r|\n/.test(rawValue)) continue;
      headers[name] = rawValue;
    }
  }
  return { url: playback.url, headers };
}

/** 房主解析好的播放地址（手机自己解析不了网页，全靠这一条）。 */
function onNowLink(msg, peer) {
  if (!fromHost(peer)) {
    logThrottled('已忽略非房主发来的视频链接', 'warn');
    return;
  }
  if (!Number.isSafeInteger(msg.seq) || msg.seq < S.playlist.seq) return;
  S.nowLink = { seq: msg.seq, playback: safePlaybackFromMessage(msg) };
  if (msg.seq === S.currentSeq) playLink(msg.seq);
}

/** tryPlayLink 的发射后不管版本：异常只进控制台，不往调用点抛。 */
const playLink = (seq) => tryPlayLink(seq).catch((e) => console.warn('[android] 播放链接出错：', e));

async function tryPlayLink(seq) {
  const item = S.current;
  if (!item || item.kind !== 'link' || S.currentSeq !== seq || S.playerStarted) return;
  S.linkInfo = { title: item.title || '在线视频', duration: item.durationSec || 0, playback: null };
  renderFilmInfo();
  if (S.nowLink?.seq !== seq) return; // 等房主的地址
  const playback = S.nowLink.playback;
  if (!playback) {
    log('房主分享的是网页链接，但没有可供 Android 播放的安全直链', 'bad');
    return;
  }

  // 同一个网站在这个房间里只问一次。用页面里的对话框，不用 window.confirm ——
  // WebView 的原生弹窗会把整个 JS 线程堵住（心跳、收片、同步全停），样式也不归我们管。
  let origin = '';
  try { origin = new URL(playback.url).origin; } catch {}
  if (!S.approvedSites.has(origin)) {
    if (S.askingSite) return; // 已经弹着一个了，别叠第二个
    S.askingSite = true;
    let allowed = false;
    try {
      allowed = await askSite(origin);
    } finally {
      S.askingSite = false;
    }
    if (!allowed) {
      log('你拒绝了房主发送的视频链接', 'warn');
      return;
    }
    S.approvedSites.add(origin);
    // 等人点按钮的这段时间里可能已经换片、或者别的路径已经起播了
    if (S.current !== item || S.currentSeq !== seq || S.playerStarted) return;
  }

  S.linkInfo.playback = playback;
  const started = window.swPlayer.loadUrl(playback.url, playback.headers);
  S.playerGen = started;
  if (!started) {
    log('Android 拒绝或无法打开这个播放地址', 'bad');
    return;
  }
  S.playerStarted = true;
  S.danmaku?.setActive(true);
  renderStatus(S.prog);
  startPlayerTicks();
  log(`正在从原网站播放《${S.linkInfo.title}》`, 'good');
}

/**
 * 按站点授权的对话框。回调换成 Promise，调用点才好在 await 之后重新核对当前项。
 * 正文里的 origin 是房主给的字符串：只走 textContent，整句由 t() 翻译（origin 在词条的正则捕获里）。
 */
let siteAskDone = null;

function askSite(origin) {
  return new Promise((resolve) => {
    const box = $('site-ask');
    $('site-ask-text').textContent = t(`房主请求手机连接 ${origin} 播放在线视频。是否允许？`);
    box.classList.add('on');
    siteAskDone = (ok) => {
      siteAskDone = null;
      box.classList.remove('on');
      resolve(ok);
    };
  });
}

/* --------------------------- 下载进度回调 --------------------------- */
function onProgress(p) {
  if (!S.session || p.slot !== S.session.slot) return;
  // 播放器还没起来时房间时钟照样在往前走：把最新的房间位置喂给调度器，再按它重算一次。
  // 不这么做的话 runBytes 一直按文件头 0 算，中途加入的人会拿一个毫不相干的数去判起播和卡顿。
  let prog = p;
  if (!S.playerStarted && S.manifest) {
    S.swarm.setPlaybackByte(p.slot, roomPlayheadByte());
    prog = S.swarm.progress(p.slot);
  }
  S.prog = prog;
  // 下载侧驱动 stall 重评估（全员暂停后 mpv/播放器静止，只剩这条路能解锁）
  S.sync.onBufferProgress({
    contiguousBytes: prog.contiguousBytes,
    runBytes: prog.runBytes,
    complete: prog.complete,
  });
  announceMidJoin(prog);
  maybeLaunchPlayer(prog);
  renderStatus(prog);
}

/**
 * 房间当前播放到的秒数。播放器起来了就用它报的位置，否则用房间时钟。
 * 「这一部是不是从片头开始放」只能问它 —— 换算成字节的那个数在时长未知时恒为 0，
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

/** 房间当前播放到的字节位置。安卓拿不到 streamPos，只能按平均码率折算。 */
function roomPlayheadByte() {
  const size = S.manifest?.size || 0;
  const duration = S.sync?.duration > 0 ? S.sync.duration : S.manifest?.durationSec || 0;
  if (!(size > 0) || !(duration > 0)) return 0;
  const snap = S.sync?.lastTick;
  const seconds = snap ? snap.position || 0 : S.sync?.sharedPositionNow?.() || 0;
  return Math.max(0, Math.min(size, (seconds / duration) * size));
}

/**
 * 起播点往后至少要有多少连续字节才敢起播。和桌面同一套公式，另乘一个安卓余量：
 * 播放字节位置是按平均码率折算的，VBR 下误差直接进判定，这是已知的精度损失。
 * 起播点靠近片尾时按「到片尾还剩多少」封顶，否则最后十几秒永远等不到起播。
 */
function startRunNeeded(startByte) {
  const size = S.manifest?.size || 0;
  const duration = S.sync?.duration > 0 ? S.sync.duration : S.manifest?.durationSec || 0;
  const bitrate = size > 0 && duration > 0 ? size / duration : 0;
  const need =
    bitrate > 0
      ? (START_RUN_SECONDS + DEMUX_READAHEAD_SECONDS) * bitrate * ANDROID_RUN_SLACK
      : MIN_START_RUN_BYTES;
  const want = Math.max(need, MIN_START_RUN_BYTES);
  if (!(size > 0)) return want;
  return Math.min(want, Math.max(0, size - Math.max(0, startByte)));
}

/** 中途加入：起播点不在片头时说一句，否则用户只看到「片头早就够了却还不播」。 */
function announceMidJoin(p) {
  if (p.complete || S.securityMode !== 'trusted' || S.midJoinNoted) return;
  if (!midJoinNow()) return;
  S.midJoinNoted = true;
  log('你是中途加入的，正在下载房间当前位置附近的内容', 'warn');
}

/**
 * 中途加入，但清单里没有时长 —— 换不出「房间播到第几个字节」，也就判不了
 * 起播点附近有没有数据。这时提前起播等于蒙着眼睛跳进空洞，只能等收完。
 */
function warnMidJoinBlind() {
  if (S.midJoinBlindNoted) return;
  S.midJoinBlindNoted = true;
  log('片源没提供时长，算不出房间播到哪；这一部要完整接收后才能播放', 'warn');
}

function maybeLaunchPlayer(p) {
  if (S.playerStarted || !S.session) return;
  if (S.securityMode === 'safe' && !p.complete) return;
  if (S.securityMode === 'trusted' && p.contiguousBytes < HEAD_READY_BYTES && !p.complete) return;
  // 起播点不在片头：片头够了只说明播放器认得出格式，它落脚的是起播点 ——
  // 那里没有足够的连续数据，一起播 ExoPlayer 就阻塞在 awaitData 上。
  if (S.securityMode === 'trusted' && !p.complete && midJoinNow()) {
    const startByte = roomPlayheadByte();
    // 时长未知时换不出字节位置，判不了起播点附近有没有数据。这一部只能等收完。
    if (!(startByte > 0)) return warnMidJoinBlind();
    if ((p.runBytes || 0) < startRunNeeded(startByte)) return;
  }
  S.playerStarted = true;
  S.danmaku?.setActive(true);
  S.playerGen = window.swPlayer.load(S.session.sessionId);
  log(
    S.securityMode === 'trusted'
      ? '可信房间片头已就绪，开始边接收边播放（风险较高）'
      : '安全模式文件已完整接收并校验，开始播放',
    S.securityMode === 'trusted' ? 'warn' : 'good'
  );
  startPlayerTicks();
}

/* --------------------------- 播放器轮询 --------------------------- */
function startPlayerTicks() {
  if (S.playerTimer) return;
  S.playerTimer = setInterval(() => {
    let snap;
    try { snap = window.swPlayer.snapshot(); } catch (e) { return; }
    // 代号对不上：这条快照是上一部片的（release/load 还没在主线程落地），整条丢弃。
    // 宁可少更新几个 250ms 周期，也不能把旧片的位置当成这一部的用户操作广播出去。
    if (S.playerGen && snap.generation !== S.playerGen) return;
    const slot = S.session?.slot;

    // 首次拿到时长：喂给同步引擎和调度器（前瞻窗口、stall 阈值都要它）
    if (snap.duration > 0 && !S.sync.duration) {
      S.sync.setMediaInfo({ duration: snap.duration, size: S.manifest?.size || 0 });
      if (slot != null) S.swarm.setDuration(slot, snap.duration);
    }

    // 更新本地播放快照 + 触发 stall 评估（播放侧驱动）
    // 这里不走 onMpvTick（手机不去猜用户在播放器里动了什么），它里面「新播放器的第一条 tick」
    // 那段补放也就得在这里做一遍，见下面的 first。
    const first = !S.sync.lastTick;
    S.sync.lastTick = {
      position: snap.position,
      paused: snap.paused,
      // ExoPlayer 缺数据在等（在线链接的「卡没卡」只认这个，见 syncEngine 的 streaming）
      pausedForCache: snap.buffering === true,
      streamPos: null,
      duration: snap.duration,
      at: performance.now(),
    };

    // 播放位置先落到调度器上再取进度，然后才评估卡顿 —— 顺序和桌面端 handlePlayerTick 一致。
    // 反过来的话 runBytes 用的是上一拍位置算出来的那个数，每次跳转都会多出一对
    // STALL true/false，全房跟着抖一下。
    const size = S.manifest?.size || 0;
    if (size > 0 && slot != null) {
      const pb = snap.duration > 0 ? (snap.position / snap.duration) * size : 0;
      S.swarm.setPlaybackByte(slot, pb);
      S.prog = S.swarm.progress(slot);
    }

    // 在线链接没有分片水位：完全同步的管理员缓冲时让全房等，其余只卡自己（和桌面端同一套）
    if (S.sync.streaming) S.sync._evaluateStreamStall(S.sync.lastTick);
    else {
      S.sync._evaluateStall(S.sync.lastTick, {
        contiguousBytes: S.prog.contiguousBytes,
        runBytes: S.prog.runBytes,
        complete: S.sourceType === 'link' || S.prog.complete,
      });
    }

    // 新播放器的第一条 tick：把房间状态补放给它。播放器起来之前收到的 SYNC 只能记着
    // （没有 lastTick 时引擎不下发跳转），新建的 ExoPlayer 又固定停在 0:00、暂停；
    // 不补的话手机会从片头播、或一直停着，管理员再点一下暂停就把全房拉回片头。
    // 目标位置用房间时钟：它只在没暂停、没人卡着时往前走。记下的 pendingSeek 加上墙钟等待时间
    // 会把全房卡着等本机收片的那段也算进去（安全模式下能差出好几分钟）。
    // 原生层的 load / seek / setPause 按先后投递到主线程，这时发出的命令一定落在新播放器上。
    if (first) {
      S.sync.pendingSeek = null;
      Promise.resolve(S.sync.resyncToShared()).catch(() => {});
    }

    renderPlayback(snap);
  }, 250);
}

/* ------------------------------ 信令连接 ------------------------------ */
// 信令这一侧最多同时挂多少条连接（含还在握手的）。房间最多 16 人，留出重连交替的余量；
// 再多只可能是信令那头（服务器、公共中继上拿到链接的人）在刷 peer-join / offer —— 每一条都是一个 RTCPeerConnection。
const MAX_LIVE_PEERS = 24;
// 同一个人的连接按令牌桶限速重建：攒满 REBUILD_BURST 次，之后每 REBUILD_REFILL_MS 回一次。
// 正常的断线重连走退避（最快 1.5 秒一次、三次就停），碰不到这个限。
const REBUILD_BURST = 4;
const REBUILD_REFILL_MS = 5000;
const rebuildBudget = new Map(); // peerId -> {tokens, at}

function allowRebuild(peerId) {
  const now = Date.now();
  const b = rebuildBudget.get(peerId) || { tokens: REBUILD_BURST, at: now };
  b.tokens = Math.min(REBUILD_BURST, b.tokens + (now - b.at) / REBUILD_REFILL_MS);
  b.at = now;
  rebuildBudget.delete(peerId);
  rebuildBudget.set(peerId, b);
  while (rebuildBudget.size > MAX_LIVE_PEERS * 4) rebuildBudget.delete(rebuildBudget.keys().next().value);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/** 信令要我为 peerId 新建（或重建）一条连接时先过这一关：同时挂着的连接有上限，同一个人的重建有速率上限。 */
function admitPeer(peerId, existing) {
  if (!existing && S.swarm.peers.size >= MAX_LIVE_PEERS) {
    logThrottled('同时连着的人太多了，多出来的连接请求已忽略', 'warn');
    return false;
  }
  return allowRebuild(peerId);
}

/** 和这个人的直连还通着：数据通道开着，ICE 也没掉线。这种不必因为信令那头的一次 peer-join 就拆了重建。 */
function directLinkUp(peer) {
  if (!peer || peer.closed || peer.ctrl?.readyState !== 'open') return false;
  const ice = peer.pc?.iceConnectionState;
  return ice !== 'disconnected' && ice !== 'failed' && ice !== 'closed';
}

/** 信令给的昵称：截短、去空白，没有就用 id 开头几位。 */
function peerName(name, peerId) {
  const clean = typeof name === 'string' ? name.trim().slice(0, 40) : '';
  return clean || String(peerId || '').slice(0, 8);
}

/**
 * 连信令。两种传输接口一样：WsSignaling（自建信令服务器）和 RelaySignaling（房间链接，经公共 Nostr 中继）。
 * 传了 relay 就走中继。规则与电脑端一致：房间里的老成员向新来的发起 offer，避免双方同时发 offer 撞车；
 * 建连时的 trickle 跟 sig.trickle 走（中继不 trickle，候选打包进 SDP）。
 */
async function connectSignaling(url, roomId, relay = null) {
  const sig = relay
    ? new RelaySignaling({
        secret: relay.secret,
        hostKey: relay.hostKey,
        hostId: relay.hostId,
        relays: relay.relays,
        peerId: S.peerId,
        name: S.name,
        maxMembers: 0,
        protocolVersion: PROTOCOL_VERSION,
      })
    : new WsSignaling({ url, roomId, peerId: S.peerId, name: S.name });
  S.signalTransport = relay ? 'relay' : 'ws';
  const previous = S.signaling;
  S.signaling = sig;
  // 手上还有一条就先关掉：它的处理器都还挂着，留着它就是第二套连接在往同一个 swarm 里塞人
  if (previous && previous !== sig) previous.close();
  // 被顶替之后，这条连接上迟到的事件一律不认
  const live = () => S.signaling === sig;
  const trickle = sig.trickle !== false;

  sig.on('peer-join', async ({ peerId, name }) => {
    if (!live() || !S.swarm) return;
    // 这次会话里因为版本不符断开过的人，不再和他建连
    if (S.swarm.versionRejected.has(peerId)) return;
    name = peerName(name, peerId);
    const existing = S.swarm.peers.get(peerId);
    // 对方的信令重连之后会被当新人再广播一次 peer-join，可直连不经过信令，多半还好好的：留着
    if (directLinkUp(existing)) return;
    if (!admitPeer(peerId, existing)) return;
    logThrottled(`${name} 加入了房间`, 'good', 2000);
    // 「隐藏我的 IP」开着却没有可用中继：不和他建连接（日志里说一声）
    const ice = signalPeerIce();
    if (!ice) return;
    const peer = new Peer({ peerId, name, initiator: true, ...ice, trickle });
    wirePeer(peer, sig);
    S.swarm.addPeer(peer);
    const offer = await peer.createOffer();
    sig.signal(peerId, { kind: 'offer', sdp: offer });
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
      peer = new Peer({ peerId: from, name: peerName(name, from), initiator: false, ...ice, trickle });
      wirePeer(peer, sig);
      S.swarm.addPeer(peer);
      const answer = await peer.acceptOffer(payload.sdp);
      sig.signal(from, { kind: 'answer', sdp: answer });
      return;
    }
    if (payload.kind === 'renegotiate') {
      // 桌面端 v0.6.6 起的断线重连协议：非 initiator 一侧发这条请求，
      // 由 initiator 重发 offer。手机端不认它的话，凡是「手机当 initiator」的
      // 那条链路断了就永远回不来 —— 桌面之间能自愈，一牵扯到手机就永久卡住。
      cancelRecovery(from);
      // 重协商同样是新建一条连接：陌生 id 发来的、刷屏发来的都得过同一关
      if (!admitPeer(from, peer)) return;
      await reconnectPeer(from, peerName(name, from), sig).catch((e) =>
        log('重连 ' + peerName(name, from) + ' 失败：' + e.message, 'bad')
      );
      return;
    }

    if (!peer || peer.closed) return;
    if (payload.kind === 'answer') {
      // 重协商期间可能收到上一轮的 answer，此时 pc 已是 stable，
      // setRemoteDescription 会抛 InvalidStateError。这条本来就该丢掉。
      await peer.acceptAnswer(payload.sdp).catch((e) => console.warn('[android] 丢弃对不上的应答：', e.message));
    } else if (payload.kind === 'ice') await peer.addIceCandidate(payload.candidate);
  });

  // 信令断了不等于人走了 —— 直连不经过服务器。服务重启或网络抖一下，服务器就会
  // 广播 peer-leave；这时候把健康的 P2P 拆掉，传输会白白中断到对方重连为止，
  // 而下一行的提示还写着「已建立的直连不受影响」。真正离开的人，数据通道自己会关。
  sig.on('peer-leave', ({ peerId }) => {
    if (!live() || !S.swarm) return;
    cancelRecovery(peerId); // 人是真走了，不是链路断了
    const peer = S.swarm.peers.get(peerId);
    if (peer?.ctrl?.readyState === 'open') {
      logThrottled(peer.name + ' 的信令连接断了，但直连还在，传输继续', 'warn');
      return;
    }
    if (peerId === (S.hostId || S.sync?.hostId)) logThrottled('房主离开了房间', 'warn');
    S.swarm.removePeer(peerId);
  });
  sig.on('reconnecting', ({ in: ms }) => {
    if (live()) logThrottled(`信令断开，${Math.round(ms / 1000)} 秒后重连（已建立的直连不受影响）`, 'warn');
  });
  sig.on('error', (e) => {
    if (!live()) return;
    // 房间链接的房主一直没和我直连上，收回了名额
    if (e?.code === 'REMOVED') return removedFromRoom();
    logThrottled('信令错误：' + (e?.message || e), 'bad');
  });

  return sig.connect();
}

/** 房间链接加入失败时，按原因说人话（和电脑端同一套说法）。 */
function relayJoinError(e) {
  if (e?.code === 'HOST_OFFLINE') return '找不到房主：他可能已经离开房间，或者换过房间链接。请让房主重新发一条。';
  if (e?.code === 'RELAY_UNREACHABLE') {
    return '连不上公共中继（所在网络可能拦了它们）。请让房主改发「一对一邀请」，那个不经过任何第三方。';
  }
  if (e?.code === 'REMOVED') {
    return '房主那边一直没能和你直连，你已被移出房间。可以请房主改发一对一邀请，或者双方配置 TURN 后再试。';
  }
  if (e?.code === 'BUSY') return '房间里正有好几个人在连接，稍后再点一次链接试试。';
  return e?.message || String(e);
}

const LOBBY_NOTICE_KEY = 'sw.lobbyNotice';

/**
 * 房间链接的房主把我移出了房间（一直没和我直连上，名额收回了）。
 * 还没进房（正在打洞）就停在大厅把原因说清楚；已经在房间里的，干净地退回大厅 ——
 * 和「离开并加入」一样整页重载（原生会话、缓存一并收掉），原因记下来，回到大厅再说一遍。
 */
function removedFromRoom() {
  const text = relayJoinError({ code: 'REMOVED' });
  if (!S.entered) {
    S.signaling?.close();
    S.signaling = null;
    S.serverJoined = false;
    log(text, 'bad');
    return;
  }
  try {
    sessionStorage.setItem(LOBBY_NOTICE_KEY, text);
  } catch {}
  try {
    S.signaling?.close();
  } catch {}
  window.sw.leaveRoom();
  location.reload();
}

/* --------------------------- 直连断线恢复 --------------------------- */
// 和桌面端同一套节奏。手机换基站、切 Wi-Fi 的频率比桌面高得多，
// 这条链路上没有自动重连，用户只能退房重来。
const RECONNECT_BACKOFF_MS = [1500, 4000, 10000];
const DISCONNECT_GRACE_MS = 6000;
const RECOVERY = new Map(); // peerId -> {attempts, timer}
const RENEGOTIATING = new Map(); // peerId -> 正在跑的重协商 Promise

function cancelRecovery(peerId) {
  const st = RECOVERY.get(peerId);
  if (st?.timer) clearTimeout(st.timer);
  RECOVERY.delete(peerId);
}

function scheduleReconnect(peer, sig) {
  if (!sig || !S.swarm || peer.closed) return;
  const peerId = peer.peerId;
  const st = RECOVERY.get(peerId) || { attempts: 0, timer: null };
  if (st.timer) return;
  if (st.attempts >= RECONNECT_BACKOFF_MS.length) {
    log('和 ' + peer.name + ' 的直连试了 ' + st.attempts + ' 次都没恢复。双方都在严格 NAT 后面时需要 TURN 中继兜底。', 'bad');
    return;
  }
  const wait = RECONNECT_BACKOFF_MS[st.attempts];
  st.attempts += 1;
  const name = peer.name;
  const initiator = peer.initiator;
  log('和 ' + name + ' 的直连断了，' + Math.round(wait / 1000) + ' 秒后自动重连（第 ' + st.attempts + ' 次）', 'warn');

  st.timer = setTimeout(() => {
    st.timer = null;
    if (!sig.connected) {
      log('信令还没恢复，暂时没法重连 ' + name, 'warn');
      return;
    }
    if (initiator) {
      reconnectPeer(peerId, name, sig).catch((e) => log('重连 ' + name + ' 失败：' + e.message, 'bad'));
    } else {
      sig.signal(peerId, { kind: 'renegotiate' });
    }
  }, wait);

  RECOVERY.set(peerId, st);
}

/** 以 initiator 身份重建一条到 peerId 的连接。同一个人同时只允许一次。 */
async function reconnectPeer(peerId, name, sig) {
  if (!S.swarm || !sig?.connected) return;
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
    wirePeer(peer, sig);
    S.swarm.addPeer(peer);
    const offer = await peer.createOffer();
    if (S.swarm.peers.get(peerId) !== peer) return; // 等 ICE 的这几秒里被顶替了
    sig.signal(peerId, { kind: 'offer', sdp: offer });
  })();

  RENEGOTIATING.set(peerId, run);
  try {
    await run;
  } finally {
    RENEGOTIATING.delete(peerId);
  }
}

function wirePeer(peer, sig) {
  if (sig) peer.on('icecandidate', (c) => sig.signal(peer.peerId, { kind: 'ice', candidate: c }));

  let graceTimer = null;
  const clearGrace = () => {
    clearTimeout(graceTimer);
    graceTimer = null;
  };

  peer.on('open', () => {
    clearGrace();
    cancelRecovery(peer.peerId);
    log(`已和 ${peer.name} 建立数据通道，正在校验房间模式…`);
  });
  peer.on('statechange', (s) => {
    if (s === 'connected' || s === 'completed') {
      clearGrace();
      cancelRecovery(peer.peerId); // ICE 自己缓过来了，撤掉排着的重连
      return;
    }
    if (s === 'disconnected' && sig && !graceTimer) {
      // 先给 ICE 一点时间自己恢复，网络抖一下就重建反而更慢。
      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (peer.pc.iceConnectionState === 'disconnected') scheduleReconnect(peer, sig);
      }, DISCONNECT_GRACE_MS);
      return;
    }
    if (s === 'failed') {
      clearGrace();
      log(`和 ${peer.name} 的直连失败了（双方都在严格 NAT 后面时会这样，需要 TURN 中继兜底）`, 'bad');
      if (sig) scheduleReconnect(peer, sig);
    }
  });
}

/* ------------------------------ 极简粘贴 ------------------------------ */

/** 已经进了房间（收到过房主的列表），或者已经和谁握过手。 */
function roomConnected() {
  if (S.entered) return true;
  for (const p of S.swarm?.peers.values() || []) if (p.authenticated) return true;
  return false;
}

/**
 * 在房间里（含已经用信令服务器进了某个房间、人还没来）。这时再按一条邀请走加入流程，
 * 会拿同一个房主 id 新建连接顶掉手上那条活的（swarm.addPeer 遇到同 id 先拆旧的），
 * 或者把 S.hostId 换成陌生人，真房主之后发来的列表、链接全被当成「非房主」丢掉。
 */
function roomBusy() {
  return S.serverJoined || roomConnected();
}

/**
 * 深链接和「生成应答链接」按钮都从这里进。已经在房间里：不动手上的连接，先问要不要离开；
 * 上一条还在处理：这条不收（深链接谁都能发，连着来几十条也只处理一条）。
 */
function openInvite(raw) {
  const text = String(raw || '').trim();
  if (!text) return;
  if (text.length > MAX_INVITE_CHARS) {
    log('邀请链接异常过长，已忽略', 'bad');
    return;
  }
  if (S.joining) {
    log('上一条邀请还在处理，请稍候再试', 'warn');
    return;
  }
  if (roomBusy()) {
    askLeaveForInvite(text);
    return;
  }
  $('tab-manual').click();
  $('host-code').value = text;
  joinManual(text);
}

/**
 * 按房主的邀请加入：房间链接直接进房，一对一邀请生成应答。
 * 同一时间只跑一个，进了房间就不再跑（见 openInvite）。
 */
async function joinManual(hostCode) {
  // 调用方已经挡过一遍，这里再守一道，别让任何入口绕过去
  if (S.joining) {
    log('上一条邀请还在处理，请稍候再试', 'warn');
    return;
  }
  if (roomBusy()) {
    log('你已经在房间里了。要加入新的房间，请先离开当前房间。', 'warn');
    return;
  }
  S.joining = true;
  let relay = false;
  try {
    let payload;
    try {
      payload = await decodeCode(hostCode);
    } catch (e) {
      log('邀请码无效：' + e.message, 'bad');
      return;
    }
    relay = payload.k === 'relay';
    if (relay) {
      // 要等房主放行（最长半分钟）再加连中继的时间，闸门给宽一点
      await withTimeout(joinRelayNow(payload), RELAY_JOIN_TIMEOUT_MS, '等房主放行超时');
    } else {
      // 候选收集自己有 8 秒上限，这里再兜一层：哪一步卡死了，闸门也得放开，不然之后的邀请全被挡在外面
      await withTimeout(joinManualNow(payload), JOIN_STEP_TIMEOUT_MS, '生成应答链接超时');
    }
  } catch (e) {
    if (relay) {
      // 等放行超时的话信令还挂着：收掉，别让它之后又把人塞进来
      S.signaling?.close();
      S.signaling = null;
      S.serverJoined = false;
    }
    log((relay ? '加入房间失败：' : '生成应答链接失败：') + e.message, 'bad');
  } finally {
    S.joining = false;
  }
}

/** 按安全模式和协议版本核对一条邀请，对不上就说清楚、返回 false。 */
function inviteUsable(payload) {
  if (normalizeSecurityMode(payload.securityMode) !== S.securityMode) {
    log(`房间使用${securityModeLabel(payload.securityMode)}，本机设置是${securityModeLabel(S.securityMode)}。请切换为相同模式后重试。`, 'bad');
    return false;
  }
  if (payload.protocolVersion !== PROTOCOL_VERSION) {
    log(
      payload.protocolVersion < PROTOCOL_VERSION
        ? '这个邀请来自旧版 NoxReel（0.6.x），和 0.7 不互通。请让房主升级到 0.7 后重新发邀请。'
        : '这个邀请来自更新版本的 NoxReel，请先升级手机上的 NoxReel。',
      'bad'
    );
    return false;
  }
  return true;
}

/**
 * 「隐藏我的 IP」开着却没有可用中继：说清楚、返回 true，调用方不建连接 —— 更不能悄悄退回直连。
 *
 * 调用方在它前面先 `if (turnFetchNeeded()) await ensureTurnReady()`：只在真要现取 Cloudflare 账号时才 await，
 * 其余路径的同步时序不变（和电脑端同一条规则）。
 */
function relayBlockedStop() {
  const blocked = relayOnlyBlocked();
  if (!blocked) return false;
  log(blocked, 'bad');
  return true;
}

/**
 * 房间链接（经公共 Nostr 中继）加入。房主放行（签名的 welcome）才算进房，房主身份由链接里的签名公钥担保；
 * 之后房间里的老成员向我发 offer，和信令服务器模式同一套建连。
 */
async function joinRelayNow(payload) {
  if (!inviteUsable(payload)) return;
  if (!payload.key || !/^[0-9a-f]{64}$/.test(String(payload.hk || '')) || !payload.from) {
    log('这个房间链接不完整，请让房主重新复制一次。', 'bad');
    return;
  }
  // 房主放行之后马上就要打洞：TURN 得先备好，「隐藏我的 IP」没有中继就不进
  if (turnFetchNeeded()) await ensureTurnReady();
  if (relayBlockedStop()) return;
  // 上一次没连上的尝试（一对一的占位连接、上一条中继信令）先收干净
  S.manualAttempt?.cancel();
  S.manualAttempt = null;
  if (S.swarm) for (const p of [...S.swarm.peers.values()]) if (!p.authenticated) S.swarm.removePeer(p.peerId);
  S.hostId = payload.from; // 链接里带着房主身份（和它的签名公钥），认它做角色权威
  if (S.sync) S.sync.hostId = payload.from;
  initSwarmAndSync();
  log('正在通过公共中继找房主，等房主放行…', 'warn');
  try {
    await connectSignaling(null, null, {
      secret: payload.key,
      hostKey: payload.hk,
      hostId: payload.from,
      relays: payload.relays,
    });
  } catch (e) {
    S.signaling?.close();
    S.signaling = null;
    log('加入房间失败：' + relayJoinError(e), 'bad');
    return;
  }
  S.serverJoined = true;
  log('房主已放行，正在和房间里的人打洞…', 'good');
}

async function joinManualNow(payload) {
  if (payload.k !== 'offer' || !payload.sdp) {
    log('这不是一个房主邀请码', 'bad');
    return;
  }
  if (!inviteUsable(payload)) return;
  // 应答里要带上中继候选：TURN 得先备好，「隐藏我的 IP」没有中继就不生成应答
  if (turnFetchNeeded()) await ensureTurnReady();
  if (relayBlockedStop()) return;
  // 上一次还没连上的尝试作废：定时器、监听和那条等不到应答的连接都收掉。
  // 不收的话，换了房主之后旧房主要是又点开了旧应答，连上来的是一个「非房主」。
  // 能走到这里说明还没有任何人连上（roomBusy 挡着），摘掉的只可能是这种残骸。
  S.manualAttempt?.cancel();
  S.manualAttempt = null;
  // 上一次用房间链接试过、没进成：那条中继信令也收掉
  if (S.signaling) {
    S.signaling.close();
    S.signaling = null;
    S.signalTransport = null;
  }
  if (S.swarm) for (const p of [...S.swarm.peers.values()]) if (!p.authenticated) S.swarm.removePeer(p.peerId);
  S.hostId = payload.from; // 邀请码带着房主身份，认它做角色权威
  // 同步引擎可能是上一次尝试时建的：房主身份跟着换（这时还没人连上，换它不影响谁）
  if (S.sync) S.sync.hostId = payload.from;
  initSwarmAndSync();

  const peer = new Peer({
    peerId: payload.from,
    name: payload.name || '房主',
    initiator: false,
    ...peerIce(),
    trickle: false, // 手动模式等候选集齐，SDP 自包含
  });
  wirePeer(peer, null);
  S.swarm.addPeer(peer);

  // 打不通时得有个结局。这边以前生成完应答链接就再没有任何反馈，房主那边早已超时
  // 放弃，手机上却还停在「发回给房主后对方点开即可」，用户不知道该等还是该重来。
  //
  // 光挂 failed 不够：对方的 NAT 如果连出口 IP 都随目标变（云上的多出口 NAT 网关
  // 就是这样），ICE 会一直停在 checking 永远不进 failed。所以再加一条定时兜底。
  // 时限给得宽，因为房主可能过好几分钟才粘贴，这边分不清「还没粘」和「粘了没打通」。
  let joinSettled = false;
  let joinWaitTimer = null;
  const finishJoin = (text) => {
    if (joinSettled || peer.authenticated || S.entered) return;
    if (S.swarm?.peers?.get(payload.from) !== peer) return; // 已经被新一轮顶替的旧连接
    joinSettled = true;
    clearTimeout(joinWaitTimer);
    log(text, 'bad');
  };
  peer.on('failed', () =>
    finishJoin('和房主的直连没建立起来。重新粘一次房主的邀请码生成新的应答链接；双方都在严格 NAT 后面时需要各自配同一个 TURN 中继。')
  );
  joinWaitTimer = setTimeout(
    () =>
      finishJoin('等了几分钟还是没连上房主。应答链接已经发回去的话多半是打洞没成功，双方都要配同一个 TURN 中继；房主还没打开的话，就重新粘一次邀请码生成新的应答链接。'),
    MANUAL_JOIN_WAIT_TIMEOUT_MS
  );
  const offAuthenticated = S.swarm.on('peer-authenticated', (authenticatedPeer) => {
    if (authenticatedPeer !== peer) return;
    joinSettled = true;
    clearTimeout(joinWaitTimer);
  });
  // 每重粘一次邀请码就多一个监听和一个三分钟的定时器：下一次开始前由它收掉
  const attempt = {
    cancel() {
      joinSettled = true;
      clearTimeout(joinWaitTimer);
      offAuthenticated();
    },
  };
  S.manualAttempt = attempt;

  log('正在生成应答链接，收集网络候选中…（几秒）', 'warn');
  const answer = await peer.acceptOffer(payload.sdp);
  const code = await encodeCode({
    k: 'answer', from: S.peerId, name: S.name, sdp: answer, securityMode: S.securityMode,
  });
  // 这一轮超时被放弃、后面又开了新的一轮：迟到的旧应答别把新的那条盖掉
  if (S.manualAttempt !== attempt) return;
  // 应答是整份 SDP：只走中继却一条中继候选都没有、配了中继却没拿到，这时就说，别等连不上才猜
  adviseLocalCandidates(answer);

  $('answer-out').value = inviteLink(code, 'answer');
  show($('answer-wrap'), true);
  if (payload.file) log(`房主的片子：${payload.file.name} · ${fmtBytes(payload.file.size)}`);
  log('应答链接已生成，发回给房主后对方点开即可', 'good');
}

/* ------------------------------ 界面渲染 ------------------------------ */
function enterStage() {
  if (S.entered) return;
  S.entered = true;
  show($('lobby'), false);
  $('stage').style.display = 'block';
  renderRole();
  renderPlaylistPanel();
  renderChat();
}

function renderFilmInfo() {
  const mode = securityModeLabel(S.securityMode);
  if (S.sourceType === 'link' && S.linkInfo) {
    $('film').textContent = `${S.linkInfo.title} · ${mode} · 在线`;
  } else if (S.manifest) {
    $('film').textContent = `${S.manifest.name} · ${mode}`;
  } else if (S.current?.kind === 'file') {
    $('film').textContent = `${S.current.name} · ${mode} · 正在获取清单…`;
  } else if (!S.current && S.playlist.rev > 0) {
    $('film').textContent = `播放列表是空的 · ${mode}`;
  }
}

const ROLE_LABEL = { host: '房主', admin: '管理员', guest: '游客' };

/** 成员面板上的设备标记。系统名是专有名词，不翻译；老版本电脑端只报得出「电脑」。 */
const PLATFORM_LABEL = { windows: 'Windows', mac: 'macOS', linux: 'Linux', android: 'Android', desktop: '电脑' };

/** 连上了、握过手的人。和「N 人在线」数的是同一拨。 */
function connectedPeers() {
  return S.swarm
    ? S.swarm.peerList().filter((p) => p.authenticated && (p.state === 'connected' || p.state === 'completed'))
    : [];
}

/**
 * 成员面板：自己 + 连上的每个人，各自用什么设备、什么角色。房主排最前。
 * 昵称是别人起的（raw，不翻译）；设备是对端在握手里自己报的，只拿来显示。
 */
function renderMembers() {
  const body = $('members-body');
  if (!body) return;
  const roleOf = (peerId) => {
    const role = S.sync?.roleOf(peerId) || 'guest';
    return ROLE_LABEL[role] ? role : 'guest';
  };
  const row = (name, platform, role, self) => {
    const key = normalizePlatform(platform);
    return el('div', { className: 'mb-row' }, [
      el('span', { className: 'mb-name', raw: true, text: name }),
      self ? el('span', { className: 'mb-role', text: '（你）' }) : null,
      el('span', { className: `mb-os ${key}`, text: PLATFORM_LABEL[key] }),
      el('span', { className: 'mb-role', text: ROLE_LABEL[role] }),
    ]);
  };
  const others = connectedPeers()
    .map((p) => ({ p, role: roleOf(p.peerId) }))
    .sort((a, b) => (a.role === 'host' ? -1 : b.role === 'host' ? 1 : 0));
  body.replaceChildren(
    row(S.name || '', 'android', S.sync?.myRole() || 'guest', true),
    ...others.map(({ p, role }) => row(p.name || '', p.platform, role, false))
  );
}

/** 反映房主分给我的角色：游客禁用进度条、给出说明；管理员/房主放开控制。 */
function renderRole() {
  if (!S.sync) return;
  const canControl = S.sync.canIControl();
  const seek = $('seek');
  if (seek) {
    seek.disabled = !canControl;
    seek.style.opacity = canControl ? '' : '0.4';
  }
  const hint = $('role-hint');
  if (hint) {
    hint.textContent = canControl
      ? `身份：${ROLE_LABEL[S.sync.myRole()]} · 可以控制播放、编辑列表`
      : '身份：游客 · 播放/暂停仅对自己生效，不能拖动进度';
  }
  // 升降管理员会改变能不能编辑列表，成员面板上的角色也跟着变
  renderPlaylistPanel();
  renderMembers();
}

/* ---------------------------- 播放列表面板 ---------------------------- */

const itemName = (item) => (item ? (item.kind === 'link' ? item.title || item.url : item.name) || '' : '');

const PLAYLIST_TAG = { now: '正在播放', next: '待播', done: '已播放' };

/**
 * 手机上能不能改列表：房主给了管理员身份才行。手机永远不是房主，改列表是把操作发给房主，
 * 由房主那台机器执行、再把新列表广播出来（房主是列表的唯一权威）。
 */
function canEditPlaylist() {
  return Boolean(S.sync?.canIControl()) && S.sync.myRole() !== 'host';
}

// 点开了操作按钮的那一行（一次只展开一行，手机屏幕放不下每行一排按钮）
let playlistExpanded = '';

/**
 * 播放列表：队列第一项就是当前项，后面是待播，已播放区排在最后。
 * 管理员点一行展开操作按钮（和电脑端行菜单同一套：立即播放、跳过、上移、下移、移除、再放一次）；
 * 顶上可以加在线链接、开关自动连播。游客只能看。
 */
function renderPlaylistPanel() {
  const body = $('playlist-body');
  if (!body) return;
  const canEdit = canEditPlaylist();
  show($('playlist-edit'), canEdit);
  $('playlist-note').textContent = canEdit
    ? '你是管理员：点一行可以调整；改动由房主那边执行'
    : '只有房主和管理员能改列表';
  const auto = $('pl-autoplay');
  if (auto) auto.checked = S.playlist.autoplay !== false;
  const queue = S.playlist.queue || [];
  const history = S.playlist.history || [];
  if (!queue.length && !history.length) {
    body.replaceChildren(
      el('p', { className: 'panel-empty', text: canEdit ? '列表还是空的，在上面加一个在线链接。' : '列表还是空的，等房主加片。' })
    );
    return;
  }
  const rows = queue.map((item, i) => playlistRow(item, i === 0 ? 'now' : 'next', canEdit ? queueActions(i, queue.length) : []));
  for (const item of history) rows.push(playlistRow(item, 'done', canEdit ? HISTORY_ACTIONS : []));
  body.replaceChildren(...rows);
}

/** 队列里第 index 项能做的事（和电脑端 queueMenu 一致）。 */
function queueActions(index, length) {
  const out = [index > 0 ? ['play-now', '立即播放'] : ['skip', '跳过这一部']];
  if (index > 0) out.push(['move-up', '上移']);
  if (index < length - 1) out.push(['move-down', '下移']);
  out.push(['remove', '移除']);
  return out;
}

const HISTORY_ACTIONS = [
  ['requeue', '再放一次'],
  ['play-now', '立即播放'],
  ['remove', '从已播放中移除'],
];

function playlistRow(item, kind, actions) {
  const name = itemName(item);
  const line = el('div', { className: 'pl-line' }, [
    el('span', { className: 'pl-tag', text: PLAYLIST_TAG[kind] }),
    // 片名是别人起的：raw，既不翻译也不拼 innerHTML
    el('span', { className: 'pl-name', raw: true, text: name, title: name }),
  ]);
  const row = el('div', { className: `pl-row ${kind}${actions.length ? ' editable' : ''}` }, [line]);
  if (!actions.length) return row;
  line.addEventListener('click', () => {
    playlistExpanded = playlistExpanded === item.id ? '' : item.id;
    renderPlaylistPanel();
  });
  if (playlistExpanded === item.id) {
    row.appendChild(
      el(
        'div',
        { className: 'pl-actions' },
        actions.map(([key, label]) => {
          const button = el('button', { className: key === 'remove' ? 'danger' : '', text: label });
          button.addEventListener('click', () => onPlaylistAction(key, item.id));
          return button;
        })
      )
    );
  }
  return row;
}

/** 列表操作发给房主，等他的回音。和电脑端管理员同一条路（PLAYLIST_OP → PLAYLIST_ACK）。 */
function submitPlaylistOp(op) {
  if (!canEditPlaylist()) return Promise.resolve({ ok: false, reason: '你没有编辑播放列表的权限' });
  const hostId = S.hostId || S.sync?.hostId;
  const host = hostId ? S.swarm?.peers.get(hostId) : null;
  if (!host?.authenticated) return Promise.resolve({ ok: false, reason: '和房主的连接断了' });
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const reqId = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
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

/** 房主对列表操作的回音。只认房主那条连接。 */
function onPlaylistAck(msg, peer) {
  if (!fromHost(peer) || typeof msg.reqId !== 'string') return;
  S.pendingOps.get(msg.reqId)?.({
    ok: msg.ok === true,
    reason: typeof msg.reason === 'string' ? msg.reason.slice(0, 200) : '',
    id: typeof msg.id === 'string' ? msg.id.slice(0, 32) : '',
  });
}

async function runPlaylistOp(op) {
  const res = await submitPlaylistOp(op);
  if (!res.ok && res.reason !== 'needs-confirm') log(`列表没改成：${res.reason || '未知原因'}`, 'warn');
  return res;
}

async function onPlaylistAction(key, id) {
  if (!canEditPlaylist()) return;
  const found = findItem(S.playlist, id);
  if (!found) return;
  const { item, index, where } = found;
  const { queue } = S.playlist;
  playlistExpanded = '';
  renderPlaylistPanel();
  switch (key) {
    // 点「立即播放」是明说要换，不再二次确认（和电脑端行菜单一样）
    case 'play-now':
      await runPlaylistOp({ type: 'playNow', id });
      return;
    case 'skip':
      // 按钮点下去之前当前项可能已经换了，别跳错
      if (where === 'queue' && index === 0) await runPlaylistOp({ type: 'ended', seq: S.playlist.seq });
      return;
    case 'move-up':
      if (where === 'queue' && index > 0) await movePlaylistItem(id, queue[index - 1].id);
      return;
    case 'move-down':
      if (where === 'queue' && index < queue.length - 1) await movePlaylistItem(id, queue[index + 2]?.id ?? null);
      return;
    case 'remove':
      if (where === 'queue' && index === 0 && S.playlist.started) {
        const ok = await confirmAsk('移除正在播放的这一部？', item, '会直接换到下一部。', '移除');
        if (!ok) return;
      }
      await runPlaylistOp({ type: 'remove', id });
      return;
    case 'requeue':
      await runPlaylistOp({ type: 'requeue', id });
      return;
    default:
  }
}

/**
 * 调顺序。开播之后换掉当前项必须先确认（和电脑端拖动排序同一条规则）：
 * 确认后走「立即播放」，原来那部退到第二位、记下播到哪，回头从那儿接着放。
 */
async function movePlaylistItem(id, beforeId) {
  const ids = reorderIds(
    S.playlist.queue.map((it) => it.id),
    id,
    beforeId
  );
  if (!ids) return;
  const cur = currentItem(S.playlist);
  if (S.playlist.started && ids[0] !== cur.id) {
    await switchByMove(ids, cur);
    return;
  }
  const res = await runPlaylistOp({ type: 'move', id, beforeId });
  // 房主那边已经开播了，我这份列表刚跟上：按最新的顺序重算一遍再问
  if (res.reason !== 'needs-confirm') return;
  const fresh = reorderIds(
    S.playlist.queue.map((it) => it.id),
    id,
    beforeId
  );
  if (fresh) await switchByMove(fresh, currentItem(S.playlist));
}

async function switchByMove(ids, cur) {
  const target = S.playlist.queue.find((it) => it.id === ids[0]);
  if (!target || !cur || target.id === cur.id) return;
  const at = S.sync?.sharedPositionNow() || 0;
  const ok = await confirmAsk(
    '切换正在播放的片子？',
    target,
    at >= 1 ? `正在放的这部排到下一位，回头从 ${fmtTime(at)} 接着放。` : '正在放的这部排到下一位。',
    '切换'
  );
  if (!ok) return;
  const res = await runPlaylistOp({ type: 'playNow', id: target.id });
  if (!res.ok) return;
  // 是把正在放的那部往下挪：切过去之后再把它挪到要去的位置
  const pos = ids.indexOf(cur.id);
  if (pos > 1) {
    const beforeId = ids.slice(pos + 1).find((x) => S.playlist.queue.some((it) => it.id === x)) ?? null;
    await runPlaylistOp({ type: 'move', id: cur.id, beforeId });
  }
}

/** 加一个在线链接。手机解析不了网页，只交地址；轮到它时由房主那边解析，每个人在自己那边允许一次这个网站。 */
async function addLinkFromPhone() {
  const input = $('pl-link');
  const raw = input.value.trim();
  if (!raw) return;
  let url = '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') url = parsed.href;
  } catch {}
  if (!url || url.length > 2048) {
    log('只能加 http:// 或 https:// 开头的视频链接', 'warn');
    return;
  }
  const button = $('pl-add');
  button.disabled = true;
  try {
    const res = await runPlaylistOp({ type: 'add', item: { kind: 'link', url, title: '', durationSec: 0 } });
    if (res.ok) {
      input.value = '';
      log('链接已加进列表', 'good');
    }
  } finally {
    button.disabled = false;
  }
}

/**
 * 页面里的确认框（不用 window.confirm：WebView 的原生弹窗会把整个 JS 线程堵住）。
 * 片名只走 textContent、打 raw；其余整句过 t()。
 */
let confirmDone = null;

function confirmAsk(title, item, note, okText) {
  confirmDone?.(false);
  return new Promise((resolve) => {
    $('confirm-title').textContent = t(title);
    const name = $('confirm-name');
    name.textContent = itemName(item);
    $('confirm-note').textContent = t(note);
    $('confirm-ok').textContent = t(okText);
    $('confirm-ask').classList.add('on');
    confirmDone = (ok) => {
      confirmDone = null;
      $('confirm-ask').classList.remove('on');
      resolve(ok);
    };
  });
}

/* ------------------------------ 抽屉 ------------------------------ */

const SHEETS = [
  { sheet: 'playlist-sheet', button: 'btn-playlist' },
  { sheet: 'chat-sheet', button: 'btn-chat' },
  { sheet: 'danmaku-sheet', button: 'btn-danmaku' },
  { sheet: 'members-sheet', button: 'peers' },
];
let openSheet = '';

/** 一次只开一个：手机屏幕就这么大，两个抽屉叠一起谁也看不清。 */
function setSheet(id) {
  openSheet = id;
  for (const spec of SHEETS) {
    const on = spec.sheet === id;
    $(spec.sheet).classList.toggle('on', on);
    $(spec.button).classList.toggle('on', on);
  }
  if (id === 'chat-sheet') {
    chatUnread = 0;
    renderChatUnread();
    scrollChatToBottom();
  }
}

const toggleSheet = (id) => setSheet(openSheet === id ? '' : id);

/* ------------------------------ 聊天 ------------------------------ */

/** 聊天列表最多留多少行（再多就丢最老的）。 */
const CHAT_VIEW_LIMIT = 300;

const chatRows = new Map(); // key -> {node, stateNode}
let chatUnread = 0;
let chatSysNo = 0;
let chatNoticeTimer = null;

const stateLabel = (state) => (state === 'sending' ? '发送中' : '已送达');

/** 距底多少像素以内算「看着最新的消息」。 */
const CHAT_BOTTOM_SLACK = 24;

const chatAtBottom = () => {
  const body = $('chat-body');
  return !body || body.scrollHeight - body.scrollTop - body.clientHeight <= CHAT_BOTTOM_SLACK;
};

function scrollChatToBottom() {
  const body = $('chat-body');
  if (body) body.scrollTop = body.scrollHeight;
}

function renderChatUnread() {
  const badge = $('chat-unread');
  if (!badge) return;
  badge.textContent = chatUnread > 0 ? String(chatUnread) : '';
  badge.classList.toggle('on', chatUnread > 0);
}

/** 一行聊天。按 key 复用节点：「发送中」改成「已送达」时只换那一小段文字。 */
function chatRow(entry) {
  const cached = chatRows.get(entry.key);
  if (cached) {
    if (cached.stateNode) {
      const label = entry.state ? t(stateLabel(entry.state)) : '';
      if (cached.stateNode.textContent !== label) cached.stateNode.textContent = label;
    }
    return cached.node;
  }
  let node;
  let stateNode = null;
  if (entry.kind === 'system') {
    // 系统事件整句交给 t()，昵称和片名靠词条里的正则捕获原样带过去，所以这一行不打跳过标记
    node = el('div', { className: 'chat-system', text: entry.text });
  } else if (entry.kind === 'divider') {
    node = el('div', { className: 'chat-divider', text: entry.text });
  } else {
    stateNode = el('span', { className: 'chat-state', text: entry.state ? stateLabel(entry.state) : '' });
    node = el('div', { className: `chat-msg${entry.self ? ' self' : ''}` }, [
      el('span', { className: 'chat-name', raw: true, text: entry.name, title: entry.name }),
      el('span', { className: 'chat-text', raw: true, text: entry.text }),
      stateNode,
    ]);
  }
  chatRows.set(entry.key, { node, stateNode });
  return node;
}

function renderChat() {
  const body = $('chat-body');
  if (!body) return;
  // 先看重画之前在不在底：重画之后 scrollHeight 就变了。
  // 人往上翻着看旧消息时别把他拽回底下，新消息来了也一样。
  const stick = chatAtBottom();
  const entries = S.chat.entries;
  if (!entries.length) {
    chatRows.clear();
    body.replaceChildren(el('p', { className: 'panel-empty', text: '还没有消息' }));
  } else {
    const keys = new Set(entries.map((e) => e.key));
    for (const key of [...chatRows.keys()]) if (!keys.has(key)) chatRows.delete(key);
    body.replaceChildren(...entries.map(chatRow));
  }
  const notice = $('chat-notice');
  if (notice) {
    notice.textContent = S.chat.notice ? t(S.chat.notice) : '';
    notice.classList.toggle('off', !S.chat.notice);
  }
  if (stick) scrollChatToBottom();
}

function pushChatEntry(entry) {
  const list = S.chat.entries;
  // 同一个 key 绝不能进两次：行按 key 复用，重复的会把同一个节点插两遍。
  // 去重表有 TTL，同 id 的消息隔久了会「复活」，房主补发的历史也可能和直连那份撞上。
  if (entry.key && list.some((e) => e.key === entry.key)) return;
  list.push(entry);
  if (list.length > CHAT_VIEW_LIMIT) {
    for (const old of list.splice(0, list.length - CHAT_VIEW_LIMIT)) chatRows.delete(old.key);
  }
  // 抽屉没开着时在按钮上挂个数字，别抢用户正在看的画面
  if (entry.kind === 'msg' && !entry.self && !entry.quiet && openSheet !== 'chat-sheet') {
    chatUnread += 1;
    renderChatUnread();
  }
  renderChat();
}

/** 系统事件（谁进来了、谁走了、换片、谁按了暂停）在聊天流里显示成灰色一行，日志照常保留。 */
function chatSystem(text) {
  if (!S.entered) return;
  pushChatEntry({ key: `sys:${++chatSysNo}`, kind: 'system', text });
}

/** 输入框上面那一行提示（目前只有超速）。 */
function chatNotice(text) {
  S.chat.notice = text || '';
  renderChat();
  clearTimeout(chatNoticeTimer);
  if (text) chatNoticeTimer = setTimeout(() => chatNotice(''), 5000);
}

/** 现在能发聊天的连接。 */
const chatPeers = () => [...(S.swarm?.peers.values() || [])].filter((p) => p.authenticated);

/**
 * 发一条聊天。手机永远不是房主，所以自己这条先记「发送中」，
 * 等房主把同 id 的副本转回来（gate 认出是回声）才改成「已送达」。
 * @returns {boolean} 有没有被收下；没收下时输入框里的字留着，别让人重打一遍
 */
function sendChat(rawInput) {
  if (!S.swarm) return false;
  const res = S.chat.sender.submit(rawInput);
  if (!res.ok) {
    if (res.reason !== 'rate') return false;
    chatNotice(`发得太快了（${res.retryAfterSec} 秒后再试）`);
    return false;
  }
  const { id, text, ts } = res.message;
  // 自己的 id 先记一笔：房主把它转回来时认得出是回声，不会显示两遍
  S.chat.gate.remember(id);
  pushChatEntry({ key: id, kind: 'msg', name: S.name, text, self: true, state: 'sending' });
  showDanmaku({ id, text, self: true });
  const wire = { t: MSG.CHAT, id, text, ts };
  for (const p of chatPeers()) p.send(wire);
  return true;
}

/** 收到别人的聊天。身份以连接为准；只有房主转发来的才采信 origin。 */
function onChatMessage(msg, peer) {
  const res = S.chat.gate.accept(msg, {
    senderId: peer.peerId,
    senderName: peer.name,
    hostId: S.hostId || S.sync?.hostId,
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
  // 手机不是房主，不做转发中枢
}

/** 自己那条被房主转回来了：「发送中」改成「已送达」。 */
function markChatDelivered(id) {
  const entry = S.chat.entries.find((e) => e.key === id && e.self);
  if (!entry || entry.state === 'sent') return;
  entry.state = 'sent';
  renderChat();
}

/** 入房时房主发来的最近 50 条。只进聊天列表、不上弹幕，末尾加一条分隔线，而且只收一次。 */
function onChatHistory(msg, peer) {
  // 历史只认房主那条连接：别人发来的一概不看
  if (!trustsRelay(peer.peerId, S.hostId || S.sync?.hostId) || S.chat.historyShown) return;
  S.chat.historyShown = true;
  const items = parseHistory(msg.items);
  if (!items.length) return;
  // 已经在列表里的（直连先到、房主的历史后到）跳过，否则同一个 key 会出现两行
  const seen = new Set(S.chat.entries.map((e) => e.key));
  const old = items
    .filter((it) => !seen.has(it.id))
    .map((it) => ({
      key: it.id,
      kind: 'msg',
      name: it.name,
      text: it.text,
      self: it.origin === S.peerId,
      quiet: true, // 补上来的旧消息不算未读
    }));
  S.chat.entries.unshift(...old, { key: 'history', kind: 'divider', text: '你加入前的消息' });
  // 记下这些 id：房主随后又转发同一条时不会再显示一遍
  for (const it of items) S.chat.gate.remember(it.id);
  renderChat();
}

/* ------------------------------ 弹幕 ------------------------------ */

const DANMAKU_KEY = 'sw.danmaku';
// 手机屏幕小：默认字号比桌面小一档。横屏时画面高度只有几百像素，按桌面那档算只排得下三四条弹道。
const DANMAKU_DEFAULTS = { ...DANMAKU_BASE, fontScale: 0.8 };
// 和 lib/danmaku.js 的 resolveSettings 保持同一个范围：滑块拖得比它宽的话，超出去那一段没反应
const OPACITY_RANGE = [0.1, 1];
const FONT_SCALE_RANGE = [0.5, 2];
const SPEED_RANGE = [0.25, 4];

function clampNumber(value, [min, max], fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** localStorage 里存的就是 DANMAKU_DEFAULTS 那个形状。坏值一律回落到默认，绝不抛。 */
function loadDanmakuSettings() {
  const out = { ...DANMAKU_DEFAULTS };
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(DANMAKU_KEY) || 'null');
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  out.opacity = clampNumber(raw.opacity, OPACITY_RANGE, out.opacity);
  out.fontScale = clampNumber(raw.fontScale, FONT_SCALE_RANGE, out.fontScale);
  out.speed = clampNumber(raw.speed, SPEED_RANGE, out.speed);
  if (AREAS.includes(raw.area)) out.area = raw.area;
  return out;
}

function saveDanmakuSettings(settings) {
  const value = {
    enabled: settings.enabled !== false,
    opacity: clampNumber(settings.opacity, OPACITY_RANGE, DANMAKU_DEFAULTS.opacity),
    fontScale: clampNumber(settings.fontScale, FONT_SCALE_RANGE, DANMAKU_DEFAULTS.fontScale),
    speed: clampNumber(settings.speed, SPEED_RANGE, DANMAKU_DEFAULTS.speed),
    area: AREAS.includes(settings.area) ? settings.area : DANMAKU_DEFAULTS.area,
  };
  try {
    localStorage.setItem(DANMAKU_KEY, JSON.stringify(value));
  } catch {
    /* 隐私模式下写不进去就算了，这一场仍然按内存里的设置走 */
  }
  return value;
}

S.danmakuSettings = loadDanmakuSettings();

const nowMs = () => performance.now();
const raf = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(() => fn(nowMs()), 33));
const caf = (h) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(h) : clearTimeout(h));

/**
 * 弹幕层：#stage 里一层 pointer-events:none 的 DOM，用 danmaku.js 的 planFrame 排布、rAF 绘制。
 *
 *  - 只在「弹幕开着 + 播放器这一代在跑」时转。播放器没在跑就一帧都不画 ——
 *    画面上根本没有视频，飘一屏字纯属耗电。
 *  - 场上空了（也没有排队等弹道的）就摘掉节点、停掉 rAF；下一条弹幕会把它叫醒。
 *  - 每条弹幕一个节点，按 id 复用，逐帧只改 transform；进出场时才动 DOM 结构。
 *  - 正文是用户输入：只走 textContent，并打 data-i18n-skip，绝不拼 innerHTML、绝不翻译。
 */
function createDanmakuLayer({ layer, engine }) {
  const nodes = new Map(); // id -> 节点
  let handle = null;
  let enabled = true;
  let active = false;
  let lastIds = '';

  const running = () => enabled && active;

  function clearNodes() {
    if (!nodes.size && !lastIds) return;
    nodes.clear();
    lastIds = '';
    layer.replaceChildren();
  }

  function paint(frame) {
    const next = [];
    const fresh = new Map();
    for (const d of frame) {
      const node = nodes.get(d.id) || el('span', { className: 'dm', raw: true, text: d.text });
      node.className = d.outline ? 'dm self' : 'dm'; // 自己发的加描边，一眼认出来
      node.style.fontSize = `${d.fontSize}px`;
      node.style.opacity = String(d.opacity);
      node.style.transform = `translate3d(${d.x}px, ${d.y}px, 0)`;
      fresh.set(d.id, node);
      next.push(node);
    }
    nodes.clear();
    for (const [id, node] of fresh) nodes.set(id, node);
    // 只有进出场才重排子节点：逐帧 replaceChildren 会把同一批节点摘下来再插回去，白白抖一遍布局
    const ids = frame.map((d) => d.id).join(',');
    if (ids !== lastIds) {
      lastIds = ids;
      layer.replaceChildren(...next);
    }
  }

  function tick() {
    handle = null;
    if (!running()) {
      clearNodes();
      return;
    }
    engine.resize(layer.clientWidth || 0, layer.clientHeight || 0);
    const frame = engine.frame(nowMs());
    paint(frame);
    // 场上还有东西、或者还有人排着队等弹道，就接着转；都空了停表
    if (frame.length || engine.pendingCount > 0) handle = raf(tick);
    else clearNodes();
  }

  function wake() {
    if (handle !== null || !running()) return;
    handle = raf(tick);
  }

  function stopTimer() {
    if (handle === null) return;
    caf(handle);
    handle = null;
  }

  function shutdown() {
    stopTimer();
    engine.clear();
    clearNodes();
  }

  return {
    push(msg) {
      if (!running()) return;
      engine.push(msg);
      wake();
    },
    /** 本地开关。 */
    setEnabled(flag) {
      enabled = flag !== false;
      if (running()) wake();
      else shutdown();
    },
    /** 播放器这一代起来了 / 退了。 */
    setActive(flag) {
      active = flag === true;
      if (running()) wake();
      else shutdown();
    },
    setSettings(settings) {
      engine.setSettings(settings);
    },
    /** 换片、跳转、切换播放器：整场清空。 */
    clear: shutdown,
    isRunning: () => handle !== null,
  };
}

const showDanmaku = (msg) => S.danmaku?.push(msg);

/** 把设置落到界面控件上。 */
function renderDanmakuControls() {
  const s = S.danmakuSettings;
  $('dm-enabled').checked = s.enabled !== false;
  $('dm-opacity').value = String(s.opacity);
  $('dm-font').value = String(s.fontScale);
  $('dm-speed').value = String(s.speed);
  $('dm-area').value = AREAS.includes(s.area) ? s.area : DANMAKU_DEFAULTS.area;
  $('btn-danmaku').classList.toggle('dm-off', s.enabled === false);
}

/** 改一项设置：立刻存盘、立刻生效，只影响本机。 */
function updateDanmakuSettings(patch) {
  S.danmakuSettings = saveDanmakuSettings({ ...S.danmakuSettings, ...patch });
  S.danmaku.setSettings(S.danmakuSettings);
  S.danmaku.setEnabled(S.danmakuSettings.enabled !== false);
  renderDanmakuControls();
}

function renderStatus(p) {
  if (!S.current) {
    $('status').textContent = '';
    $('buf').firstElementChild.style.width = '0%';
    return;
  }
  if (S.sourceType === 'link') {
    $('status').textContent = '视频直链 · 从原网站播放 · 房间同步中';
    $('buf').firstElementChild.style.width = '100%';
    return;
  }
  if (!S.session && S.receiveError?.fileId === S.current.fileId) {
    $('status').textContent = `没法接收这一部：${S.receiveError.message}`;
    $('buf').firstElementChild.style.width = '0%';
    return;
  }
  const pct = Math.round((p.contiguousRatio || 0) * 100);
  const rate = fmtBytes(p.downRate || 0) + '/s';
  $('status').textContent = `可播 ${pct}% · 已有 ${p.haveCount || 0}/${p.chunkCount || 0} 片 · ↓${rate}`;
  $('buf').firstElementChild.style.width = pct + '%';
}

function renderPeers() {
  const n = connectedPeers().length;
  $('peers').textContent = n ? `${n} 人在线` : '等待连接…';
  renderMembers();
}

let seeking = false;
$('seek').addEventListener('input', () => { seeking = true; });
$('seek').addEventListener('change', () => {
  const dur = S.sync?.duration || 0;
  if (dur > 0) S.sync.userSeek((Number($('seek').value) / 1000) * dur);
  seeking = false;
});

/** 换片后播放器还没起来：时间和进度条按房间位置显示，别留着上一部的值。 */
function renderIdlePlayback(item) {
  const dur = item?.durationSec || 0;
  const pos = item ? S.sync.sharedPositionNow() : 0;
  $('time').textContent = `${fmtTime(pos)} / ${fmtTime(dur)}`;
  if (!seeking) $('seek').value = dur > 0 ? Math.round((pos / dur) * 1000) : 0;
}

function renderPlayback(snap) {
  const dur = snap.duration || S.sync?.duration || 0;
  $('time').textContent = `${fmtTime(snap.position)} / ${fmtTime(dur)}`;
  if (!seeking && dur > 0) $('seek').value = Math.round((snap.position / dur) * 1000);
  const paused = S.sync ? S.sync.effectivePaused : snap.paused;
  $('pp').textContent = paused ? '▶' : '⏸';
}

function renderWaiting() {
  if (!S.sync) return;
  const st = S.sync.status();
  const w = $('waiting');
  if (st.stalled && st.waitingFor.length) {
    w.textContent = '⏳ 等待缓冲：' + st.waitingFor.join('、');
    show(w, true);
  } else {
    show(w, false);
  }
  $('pp').textContent = st.paused ? '▶' : '⏸';
}

/* ------------------------ 在线链接的跟随方式 ------------------------ */

/** 「你比房主慢 12 秒」。seconds 是本机减房间，负数是落后。 */
function driftText(seconds) {
  const n = Math.abs(Math.round(seconds));
  return `你比房主${seconds < 0 ? '慢' : '快'} ${n} 秒`;
}

// 上一次画出来的样子。每秒都会调到这里，没变就不碰 DOM —— 否则自动翻译每秒都要把中文再换一遍
let driftKey = null;

/** 顶栏的同步方式按钮（只在在线链接出现），和差开时那一条「你比房主慢 12 秒 · 同步到房主」。 */
function renderDrift() {
  const link = S.sourceType === 'link';
  const d = S.sync?.driftStatus();
  const shown = link && !!S.playerTimer && !!d && d.streaming && d.state !== 'ok';
  const key = `${link}|${S.linkSync}|${shown ? `${d.state}|${d.seconds}` : ''}`;
  if (key === driftKey) return;
  driftKey = key;
  show($('btn-follow'), link);
  $('btn-follow').textContent = S.linkSync === 'manual' ? '手动同步' : '完全同步';
  show($('drift'), shown);
  if (!shown) return;
  $('drift-kind').textContent = d.state === 'failed' ? '自动同步没跟上' : '手动同步';
  $('drift-text').textContent = driftText(d.seconds);
}

$('btn-follow').addEventListener('click', () => {
  S.linkSync = S.linkSync === 'manual' ? 'full' : 'manual';
  localStorage.setItem('sw.linkSync', S.linkSync);
  S.sync?.setFollow({ mode: S.linkSync });
  log(
    S.linkSync === 'manual'
      ? '改成手动同步：缓冲慢了不再把你拽走，和房主差开时提示差多少秒'
      : '改成完全同步：一直跟房主对齐，差开了自动跳过去'
  );
  renderDrift();
});

$('drift-sync').addEventListener('click', () => {
  if (S.sourceType === 'link' && S.sync?.syncToRoom()) log('已同步到房主的进度', 'good');
});

// 每秒核对一次和房主差多少（播放器静止时位置不变，差距在变大只能靠这个看出来），顺手刷新那一条
setInterval(() => {
  if (S.sync && S.sourceType === 'link' && S.playerTimer) S.sync.checkDrift();
  renderDrift();
}, 1000);

/* ------------------------------ 事件绑定 ------------------------------ */
$('pp').addEventListener('click', () => {
  if (!S.sync) return;
  S.sync.userSetPaused(!S.sync.intendedPaused);
});

$('tab-server').addEventListener('click', () => {
  $('tab-server').classList.add('on'); $('tab-manual').classList.remove('on');
  $('panel-server').classList.add('on'); $('panel-manual').classList.remove('on');
});
$('tab-manual').addEventListener('click', () => {
  $('tab-manual').classList.add('on'); $('tab-server').classList.remove('on');
  $('panel-manual').classList.add('on'); $('panel-server').classList.remove('on');
});

$('join').addEventListener('click', async () => {
  const url = $('url').value.trim();
  const room = $('room').value.trim();
  if (!url || !room) { log('请填写信令地址和房间号', 'bad'); return; }
  // 连着点两下会建两条信令、用同一个身份进同一个房间；和人连上之后再点就是把自己挤掉
  if (S.joining) { log('正在加入房间，请稍候', 'warn'); return; }
  if (roomConnected()) { log('你已经在房间里了。要加入新的房间，请先离开当前房间。', 'warn'); return; }
  S.joining = true;
  // 进了房间别人就会来连我：TURN 得在连信令之前备好，「隐藏我的 IP」没有中继就不进
  if (turnFetchNeeded()) await ensureTurnReady().catch(() => {});
  if (relayBlockedStop()) {
    S.joining = false;
    return;
  }
  initSwarmAndSync();
  log(`正在连接 ${url} …`);
  try {
    // 还没和任何人连上时允许换个房间号重进（或者上一次压根没连上）：
    // 旧信令和它牵出来、还没连上的连接先收掉，别叠两条信令
    S.signaling?.close();
    S.signaling = null;
    S.serverJoined = false;
    for (const p of [...S.swarm.peers.values()]) if (!p.authenticated) S.swarm.removePeer(p.peerId);
    // 连上了却一直不回「已进房」的服务器会让这一步永远挂着，「正在加入」的闸门也就再没人放开
    await withTimeout(connectSignaling(url, room), JOIN_STEP_TIMEOUT_MS, '信令服务器一直没有回应');
    S.serverJoined = true;
    log('已进入房间，等待房主供片…', 'good');
  } catch (e) {
    S.signaling?.close();
    S.signaling = null;
    log('连接失败：' + e.message, 'bad');
  } finally {
    S.joining = false;
  }
});

$('gen-answer').addEventListener('click', () => {
  const code = $('host-code').value.trim();
  if (!code) { log('请先粘贴房主的邀请码', 'bad'); return; }
  openInvite(code);
});
$('copy-answer').addEventListener('click', () => {
  $('answer-out').select();
  try { document.execCommand('copy'); } catch (e) {}
  navigator.clipboard?.writeText($('answer-out').value).catch(() => {});
  log('应答链接已复制', 'good');
});

$('btn-playlist').addEventListener('click', () => toggleSheet('playlist-sheet'));
$('btn-chat').addEventListener('click', () => toggleSheet('chat-sheet'));
$('btn-danmaku').addEventListener('click', () => toggleSheet('danmaku-sheet'));
for (const id of ['playlist-close', 'chat-close', 'danmaku-close', 'members-close']) $(id).addEventListener('click', () => setSheet(''));
$('peers').addEventListener('click', () => toggleSheet('members-sheet'));

$('chat-send').addEventListener('click', submitChat);
$('chat-input').addEventListener('keydown', (e) => {
  // isComposing：拼音、日文这些输入法选词时的回车是「确认候选」，不是发送
  if (e.key !== 'Enter' || e.isComposing) return;
  if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return; // 留给换行
  e.preventDefault?.();
  submitChat();
});

function submitChat() {
  const input = $('chat-input');
  const text = input.value;
  if (!text.trim()) return;
  if (!sendChat(text)) return; // 没被收下（超速）：字留着，别让人重打一遍
  input.value = '';
}

$('site-allow').addEventListener('click', () => siteAskDone?.(true));
$('site-deny').addEventListener('click', () => siteAskDone?.(false));

// 列表编辑（管理员）
$('pl-add').addEventListener('click', () => addLinkFromPhone());
$('pl-link').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  e.preventDefault?.();
  addLinkFromPhone();
});
$('pl-autoplay').addEventListener('change', () => {
  runPlaylistOp({ type: 'setAutoplay', on: !!$('pl-autoplay').checked }).then(renderPlaylistPanel);
});
$('confirm-ok').addEventListener('click', () => confirmDone?.(true));
$('confirm-cancel').addEventListener('click', () => confirmDone?.(false));

/* ------------------------------ 连接设置 ------------------------------ */

/** 把 S.net 落到大厅那几个控件上。Cloudflare 的 API Token 输入框从不预填。 */
function renderNetSettings() {
  const cf = S.net.turnSource === 'cloudflare';
  $('turn-source-manual').checked = !cf;
  $('turn-source-cf').checked = cf;
  show($('turn-manual'), !cf);
  show($('turn-cf'), cf);
  $('turn-on').checked = S.net.turnEnabled;
  $('turn-url').value = S.net.turnUrl;
  $('turn-user').value = S.net.turnUser;
  $('turn-pass').value = S.net.turnPass;
  $('relay-only').checked = S.net.relayOnly;
  renderCfTurnStatus();
}

function netError(text) {
  const box = $('net-err');
  box.textContent = text ? t(text) : '';
  show(box, !!text);
}

/** 「保存连接设置」：和电脑端设置页同一套校验，写错了当场说，别让人以为中继在工作。 */
function saveNetFromForm() {
  const turnSource = $('turn-source-cf').checked ? 'cloudflare' : 'manual';
  const turnRaw = $('turn-url').value.trim();
  const turnCheck = normalizeTurnInput(turnRaw);
  const turnEnabled = !!$('turn-on').checked;
  const turnUser = $('turn-user').value.trim();
  const turnPass = $('turn-pass').value.trim();
  // 手动那套字段只在来源是「自己填」时才生效，也只在那时才查
  if (turnSource === 'manual') {
    if (turnCheck.invalid.length) {
      return netError(`这些 TURN 地址认不出来：${turnCheck.invalid.join('、')}。地址要形如 turn:example.com:3478`);
    }
    // 53 端口会被浏览器内核拦下，留着它只会让候选收集干等到超时
    if (turnCheck.blocked.length) {
      return netError(`这些 TURN 地址用的是 53 端口，浏览器会拦下这个端口：${turnCheck.blocked.join('、')}。换一个端口，常见的是 3478 或 443`);
    }
    if (turnEnabled && !turnRaw) {
      return netError('勾了启用 TURN 中继，但地址是空的 —— 这样等于没配。填一个地址，或者把勾去掉。');
    }
    if (turnEnabled && (!turnUser || !turnPass)) {
      return netError('TURN 中继要填用户名和密码（中继服务器靠它们认人）。没有的话把「启用 TURN 中继」的勾去掉。');
    }
  }
  // Cloudflare 凭据只能经「验证并保存」进原生层；填了没保存就点这里，得说一声
  if ($('cf-key').value.trim() || $('cf-token').value.trim()) {
    return netError('Cloudflare 凭据还没保存：先点「验证并保存」，或者把这两个框清空。');
  }
  netError('');
  // 漏了 turn: 前缀是最常见的写法错误，意思很清楚，直接补上
  const turnUrl = turnCheck.fixed.length ? turnCheck.urls.join(' ') : turnRaw;
  const sourceChanged = turnSource !== S.net.turnSource;
  saveNetSettings({ turnSource, turnEnabled, turnUrl, turnUser, turnPass, relayOnly: !!$('relay-only').checked });
  turnWarned = false;
  renderNetSettings();
  if (sourceChanged) {
    S.cfTurn = null;
    cfTurnRetryAt = 0;
    if (turnSource === 'cloudflare') refreshCfTurnState();
  }
  log('连接设置已保存（只影响之后新建的连接）', 'good');
}

/** 「验证并保存」：Token 交给原生层验证、加密保存；成功后输入框清空，只显示「已保存」。 */
async function saveCfTurnCredentials() {
  const keyInput = $('cf-key');
  const tokenInput = $('cf-token');
  const result = $('cf-result');
  const keyId = keyInput.value.trim();
  const apiToken = tokenInput.value.trim();
  if (!keyId || !apiToken) {
    result.textContent = t('Turn Token ID 和 API Token 都要填。');
    return;
  }
  const button = $('cf-save');
  button.disabled = true;
  result.textContent = t('正在向 Cloudflare 验证…');
  try {
    const state = await window.sw.turn.cfSave(keyId, apiToken);
    keyInput.value = '';
    tokenInput.value = '';
    // 换了凭据：手上那组临时账号作废，下次连接前现取
    S.cfTurn = null;
    cfTurnRetryAt = 0;
    applyCfTurnState(state);
    result.textContent = t('已保存');
    if (S.net.turnSource === 'cloudflare') ensureTurnReady().catch(() => {});
  } catch (error) {
    result.textContent = t(`没保存：${cfErrorText(cfErrorCode(error))}`);
  } finally {
    button.disabled = false;
  }
}

async function clearCfTurnCredentials() {
  const result = $('cf-result');
  try {
    applyCfTurnState(await window.sw.turn.cfClear());
    S.cfTurn = null;
    clearTimeout(cfTurnTimer);
    cfTurnTimer = null;
    result.textContent = t('已清除');
  } catch (error) {
    result.textContent = t(`没清除：${cfErrorText(cfErrorCode(error))}`);
  }
}

async function saveCfLimit() {
  const limit = Number($('cf-limit').value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    netError('Cloudflare TURN 每月上限要填 1 到 1000 之间的整数（GB）。');
    return;
  }
  netError('');
  try {
    applyCfUsage(await window.sw.turn.cfSetLimit(limit));
    log(`Cloudflare TURN 每月上限已设为 ${limit} GB`, 'good');
  } catch (error) {
    netError(`没保存上限：${cfErrorText(cfErrorCode(error))}`);
  }
}

for (const id of ['turn-source-manual', 'turn-source-cf']) {
  $(id).addEventListener('change', () => {
    const cf = $('turn-source-cf').checked;
    show($('turn-manual'), !cf);
    show($('turn-cf'), cf);
    if (cf) refreshCfTurnState();
  });
}
$('net-save').addEventListener('click', saveNetFromForm);
$('cf-save').addEventListener('click', () => saveCfTurnCredentials());
$('cf-clear').addEventListener('click', () => clearCfTurnCredentials());
$('cf-limit-save').addEventListener('click', () => saveCfLimit());
renderNetSettings();
if (S.net.turnSource === 'cloudflare') refreshCfTurnState();

// 弹幕层：装在 #stage 上，随播放器这一代启停
S.danmaku = createDanmakuLayer({
  layer: $('danmaku'),
  engine: new DanmakuEngine({ settings: S.danmakuSettings }),
});
S.danmaku.setEnabled(S.danmakuSettings.enabled !== false);
$('dm-enabled').addEventListener('change', () => updateDanmakuSettings({ enabled: !!$('dm-enabled').checked }));
$('dm-opacity').addEventListener('input', () =>
  updateDanmakuSettings({ opacity: clampNumber($('dm-opacity').value, OPACITY_RANGE, S.danmakuSettings.opacity) })
);
$('dm-font').addEventListener('input', () =>
  updateDanmakuSettings({ fontScale: clampNumber($('dm-font').value, FONT_SCALE_RANGE, S.danmakuSettings.fontScale) })
);
$('dm-speed').addEventListener('input', () =>
  updateDanmakuSettings({ speed: clampNumber($('dm-speed').value, SPEED_RANGE, S.danmakuSettings.speed) })
);
$('dm-area').addEventListener('change', () =>
  updateDanmakuSettings({ area: AREAS.includes($('dm-area').value) ? $('dm-area').value : S.danmakuSettings.area })
);
renderDanmakuControls();

// 默认昵称
$('name').value = '观众' + Math.floor(Math.random() * 90 + 10);
$('security-mode').value = S.securityMode;
$('security-mode').addEventListener('change', () => {
  S.securityMode = normalizeSecurityMode($('security-mode').value);
  localStorage.setItem('sw.securityMode', S.securityMode);
});
$('language').value = currentLocale();
$('language').addEventListener('change', () => {
  setLocale($('language').value);
  location.reload();
});
log('准备就绪。默认使用零服务器邀请链接，也可以切换到信令服务器。');

// 大厅标题旁的小字版本号（安装包的 versionName），反馈问题时一眼能看出是哪一版
const appVersion = String(window.sw.appVersion?.() || '');
if (/^[0-9A-Za-z.+-]{1,32}$/.test(appVersion)) $('app-version').textContent = `v${appVersion}`;

/* ------------------------- 已在房间里又来一条邀请 ------------------------- */
// 连着来好几条只留最后一条，对话框也只弹一个
let pendingInvite = '';

function askLeaveForInvite(link) {
  pendingInvite = link;
  $('invite-ask').classList.add('on');
}

function closeInviteAsk() {
  pendingInvite = '';
  $('invite-ask').classList.remove('on');
}

/**
 * 离开当前房间，再处理这条邀请。和桌面端退房一样整页重载：原生那边先收掉播放器和
 * 接收缓存（只重载页面的话它们没人管），邀请记在 sessionStorage 里，重载完接着处理。
 */
function leaveRoomAndOpen(link) {
  try {
    sessionStorage.setItem(PENDING_INVITE_KEY, link);
  } catch {
    /* 存不进去就只离开，不自动加入：用户再点一次链接即可 */
  }
  try {
    S.signaling?.close();
  } catch {}
  window.sw.leaveRoom();
  location.reload();
}

$('invite-stay').addEventListener('click', () => {
  closeInviteAsk();
  log('已留在当前房间，新收到的邀请没有处理', 'warn');
});
$('invite-leave').addEventListener('click', () => {
  const link = pendingInvite;
  closeInviteAsk();
  if (link) leaveRoomAndOpen(link);
});

// 原生收到 noxreel:// 深链接后调这里（MainActivity.deliverInviteLink）
window.noxreelOpenInvite = (link) => openInvite(link);

// 被房间链接的房主移出、整页重载之前记下的原因：回到大厅再说一遍，只说一次
try {
  const notice = sessionStorage.getItem(LOBBY_NOTICE_KEY);
  sessionStorage.removeItem(LOBBY_NOTICE_KEY);
  if (notice) log(notice, 'bad');
} catch {}

// 「离开并加入」整页重载前留下的那条邀请：重载完接着处理，只处理这一次
let resumedInvite = '';
try {
  resumedInvite = sessionStorage.getItem(PENDING_INVITE_KEY) || '';
  sessionStorage.removeItem(PENDING_INVITE_KEY);
} catch {
  resumedInvite = '';
}
if (resumedInvite) openInvite(resumedInvite);
