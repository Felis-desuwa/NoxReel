import { Emitter } from './emitter.js';
import { schnorr, getSharedSecret } from './third_party/secp256k1.js';

/**
 * 经公共 Nostr 中继交换连接握手的信令（「房间链接」）。
 *
 * 接口与 WsSignaling 一致（connect / signal / setMaxMembers / close，事件 joined / peer-join /
 * signal / peer-leave / room-config / reconnecting / error；另有 reconnected、rekey），
 * app.js 的 connectSignaling 原样复用：
 * 网状建连、断线重协商、房主离开的判定都不用另写一套。视频照旧点对点直传，中继只转握手。
 *
 * 信令服务器替我们做的几件事，在这里全部由房主的签名来做：
 *  - 「发信人是谁」：服务器用自己记录的 from，不信客户端自报。这里每条消息都带 Schnorr 签名，
 *    房主在 welcome 里把 peerId 和签名公钥绑在一起，之后署名 peerId 的消息必须是那把公钥签的。
 *  - 「谁是房主」：房间链接里带着房主的公钥，只有它签的 welcome / reject / leave / room-config 才算数。
 *  - 「限人数、通知进出」：房主是守门人 —— 新人发 hello，房主放行才广播 welcome，满员回 reject。
 *
 * 中继能看到的只有：密文、每次会话临时生成的公钥、时间和大小。话题标签由房间密钥派生，
 * 反推不出密钥；消息内容用房间密钥 AES-GCM 加密。拿到链接的人才解得开 —— 和信令服务器的
 * 房间码同一个信任级别。
 *
 * 换链接（rekey）时新密钥不走房间广播：房主用自己的签名私钥和每个已放行成员登记的公钥
 * 做 ECDH，逐人加密。只拿着旧链接、没被放行的人，就算一直挂在旧话题上也解不出新密钥。
 *
 * 放行不等于占住名额：拿着链接的人可以编一串假身份，只发心跳、从不建直连，把房间占满。
 * 所以房主（app 传了 isLinked 时）盯着每个放行的人和自己的直连：放行后 linkGraceMs 内
 * 一直没连上、或者连上后又连续断开这么久，就移出并记进本场的封禁表；还没连上的待定名额
 * 也有上限（PENDING_MAX），满了新来的先回 BUSY，让他稍后自己重试。
 *
 * 断线自愈：本机中继全断的那段时间里，谁都「没动静」、谁的直连都「连不上」—— 那是自己的问题，
 * 不是别人的。所以全断期间不做静默清理、不做未直连移出；恢复时把这两项计时从头算，再发
 * reconnected（带上信令知道的每个人和该由谁发起），app 据此把断着的直连重新拉起来 ——
 * 中继上都是临时事件（有的中继会在内存里留几分钟，但订阅时不要回放，见 _subscribe），
 * 断着时发出去的 offer / renegotiate 等于丢了，没有别的东西会再补发。
 * 成员恢复时还会重新 hello 一次：还在房里的，房主回一份带名册的 welcome（补上断线期间进来的人）；
 * 已经被移出的，房主回 REMOVED，别停在一个谁都连不上的房间里。
 */

// 实测挑出来的（2026-09-21，32 个候选里连通、收临时事件、2 秒内送达、6KB 事件和连发都不限流的）。
// 同时连全部，每条消息都发给全部，谁先到用谁；挂几个不影响。
export const DEFAULT_RELAYS = [
  'wss://nos.lol',
  'wss://nostr.mom',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
  'wss://relay.nostr.net',
  'wss://bucket.coracle.social',
  'wss://nostr-relay.corb.net',
  'wss://schnorr.me',
];

// 20000–29999 是 Nostr 的临时事件：中继只转发、不落盘（有的会在内存里留约 5 分钟，见 _subscribe）。
export const RELAY_EVENT_KIND = 23473;
// 消息结构的版本。和 P2P 协议版本无关：这一层变了，老客户端只会等不到 welcome。
// 0.7.5 在消息里加了 n（发送计数）和 pk（签名公钥），老客户端不认识这两项、原样忽略，
// 所以版本号不动；收的时候缺这两项的（0.7.4 发来的）照旧处理。
const RELAY_PROTO = 1;

const HELLO_INTERVAL_MS = 3000;
const JOIN_TIMEOUT_MS = 30000;
const CONNECT_TIMEOUT_MS = 8000;
const ALIVE_INTERVAL_MS = 30000;
const SILENT_AFTER_MS = 100000;
// 中继连接要稳稳地连住这么久，退避才从头算。连上就被踢（握手后按 IP 拒绝、反代立刻拆连接）的，
// 在 onopen 里清零的话会变成每秒重连一次、永不停
const RELAY_STABLE_MS = 30000;
// 连着却什么都收不到：本机网络断了，TCP 却要等好几分钟才报关闭（半开）。每 30 秒发一次心跳，
// 正常的中继每次都回 OK、也把事件推回我们自己的订阅；回过话的中继这么久一声不吭，就当它断了
const RELAY_QUIET_MS = 45000;
// 新鲜窗口：发送方时钟可能不准，created_at 与本机相差超过这个范围的事件一律当重放丢掉
const MAX_SKEW_SEC = 600;
// 订阅后等中继回 EOSE（「存着的发完了，后面都是实时的」）最多这么久。实测默认中继 0.1–0.6 秒就回；
// 带 limit:0 时有的中继（nostr-relay.corb.net）压根不回 EOSE，过了这个时间就当它已经是实时的
const EOSE_WAIT_MS = 3000;
// 中继表态之前（回 EOSE，或者等满 eoseWait）送来的 hello / signal，发送时刻比这次订阅早这么多以上的
// 才可能是中继存着的旧事件（见 _earlyOk）。几秒以内的是订阅前后脚发出的：新人连上第一条中继就发 hello，
// 房主和老成员几百毫秒内回 offer，后连上的中继会把它当存货送来 —— 那是刚发出的，得收
const REPLAY_SLACK_MS = 5000;
// 每个中继最多扣着这么多条「看上去比订阅早、等它表态」的事件（见 _hold）
const MAX_HELD_PER_RELAY = 32;
// 去重表按时间淘汰，不按条数：一条事件的 id 一直留到它自己的新鲜窗口过去之后（见 _remember），
// 「已经被忘掉」和「还会被接受」两段时间没有交集，灌多少垃圾都冲不掉。
// 条数上限只是兜底 —— 只有验签、解密都通过又没超限速的事件才会记进来，按限速算正常到不了；
// 真到了宁可丢新事件，也不提前忘掉还在窗口里的。
const SEEN_MAX = 100000;
// 每个发送方的计数窗口：乱序到比最新一条落后这么多的，按重放丢掉
const REPLAY_WINDOW = 1024;
const REPLAY_MASK = (1n << BigInt(REPLAY_WINDOW)) - 1n;
// 计数窗口闲置这么久就可以扔：那个发送方最后一条消息的 created_at 已经出了新鲜窗口
const COUNTER_IDLE_MS = (2 * MAX_SKEW_SEC + 60) * 1000;
const COUNTERS_MAX = 1024;
const BUCKETS_MAX = 4096;

// 中继送来的东西在解密、验签之前先过的几道廉价检查。合法事件里最大的是带完整 SDP 的 signal
// 和满员时的 welcome（名册），加密、base64 之后十几 KB；上限留了好几倍余量。
const MAX_FRAME_CHARS = 128 * 1024;
const MAX_CONTENT_CHARS = 96 * 1024;
const MAX_TAGS = 4;
// 每个中继同时在处理的事件数。处理不过来的直接丢 —— 同一条事件别的中继还会再送一份，
// 而一个中继灌进来的东西不会在内存里无限堆积。
const MAX_INFLIGHT_PER_RELAY = 32;
// 房主没设人数上限（maxMembers 为 0）时的硬上限；成员表、名册都不会超过它
const MAX_MEMBERS = 64;
// 成员这边记的「谁的公钥是什么」最多记这么多
const MAX_BINDINGS = 128;
// 放行后这么久还没和房主连上直连（或者连上后又连续断开这么久），就移出
const LINK_GRACE_MS = 60000;
// 已放行、还没连上直连的待定名额。满了新来的回 BUSY，等前面的人连上或被移出
const PENDING_MAX = 4;
// 本场封禁表（被移出的 peerId 和公钥）的上限：假身份要多少有多少，封禁表不能跟着无限涨
const BANNED_MAX = 512;
// 因为没动静被清掉（没封禁）的成员记下原来的序号：同一把公钥回来重新 hello 时按原序号放行，
// 老成员之间「谁向谁发 offer」的约定不会因为他换了序号而两边都以为该自己发
const DROPPED_MAX = 64;

// 限速，令牌桶：[容量, 每秒补充]。验签是这一层最贵的一步（纯 JS 的椭圆曲线运算，一次一毫秒多，
// 跑在渲染进程主线程上），所以验签前按「哪个中继送来的、自称是谁」分开记账：
// 一个中继伪造得再多，也只耗掉它自己那一份，别的中继送来的真消息照常验。
const LIMITS = {
  verifyHost: [120, 20], // 每个中继、自称房主的：有人进房时一次会来十几条 welcome
  verifyMember: [30, 3], // 每个中继、每个已登记成员
  verifyStranger: [30, 3], // 每个中继、没登记过的公钥（只有房主会去验：hello）
  verifyStrangerAll: [60, 6], // 没登记过的公钥，所有中继合计
  sender: [30, 1], // 每个成员验签通过之后的消息（房主不限）：正常一分钟也就几条
  reject: [10, 0.5], // 房主回绝的总速率：回绝也要签名、发到所有中继，不能被一串 hello 带着狂发
};

/* ------------------------------ 编码小工具 ------------------------------ */

const enc = new TextEncoder();
const dec = new TextDecoder();
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function fromHex(hex) {
  const s = String(hex || '');
  if (!/^(?:[0-9a-f]{2})+$/i.test(s)) throw new Error('bad hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// 与 signaling.js 的码同一套「聊天安全」字母表：- 和 . 代替 + 和 /，不带 =
function toB64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '.').replace(/=+$/, '');
}

function fromB64(s) {
  const b64 = String(s || '').replace(/-/g, '+').replace(/[._]/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 新的房间密钥（32 字节，编码后 43 个字符）。它就是房间链接里「谁拿到谁能进」的那部分。 */
export function newRoomSecret() {
  return toB64(crypto.getRandomValues(new Uint8Array(32)));
}

/** 由房间密钥派生：中继过滤用的话题标签（反推不出密钥），和加密用的 AES-GCM 密钥。 */
export async function deriveRoom(secret) {
  const raw = fromB64(secret);
  if (raw.length !== 32) throw new Error('房间密钥格式不对');
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const salt = enc.encode('noxreel-relay-v1');
  const topicBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('topic') },
    base,
    128
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('aes') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  return { topic: toHex(new Uint8Array(topicBits)), key };
}

/**
 * 房主和某个成员之间的一把对称密钥：一方的签名私钥 × 另一方的签名公钥做 secp256k1 ECDH。
 *
 * Nostr 的公钥是 x-only（BIP340），y 的正负号在公钥里已经丢了。这里一律按偶数 y 补全，
 * 只取共享点的 x 坐标：补错了符号，乘出来的是原点的相反数，x 坐标一样 —— 两边算出同一个值。
 * 再经 HKDF 绑定到旧话题和成员 peerId，同一对密钥在别的场合算出来的不能拿来互用。
 */
export async function pairKey(secretKey, peerPubkeyHex, topic, peerId) {
  if (!HEX64.test(String(peerPubkeyHex || ''))) throw new Error('bad pubkey');
  const point = getSharedSecret(secretKey, fromHex(`02${peerPubkeyHex}`), true);
  const base = await crypto.subtle.importKey('raw', point.slice(1), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('noxreel-relay-rekey-v1'), info: enc.encode(`${topic}|${peerId}`) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return toB64(out);
}

async function open(key, content) {
  try {
    const bytes = fromB64(content);
    if (bytes.length < 13) return null;
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12));
    const obj = JSON.parse(dec.decode(pt));
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null; // 别的房间的、被改过的、或者根本不是我们的事件
  }
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/** 生成一次会话用的签名密钥。私钥只在内存里，关掉就没了 —— 房间本来也就活到房主离开。 */
export function newSigningKey() {
  const { secretKey, publicKey } = schnorr.keygen();
  return { secretKey, publicKey: toHex(publicKey) };
}

/** 按 NIP-01 拼一条签好名的事件。 */
export async function signEvent({ secretKey, publicKey }, { kind, tags, content, createdAt }) {
  const created_at = createdAt ?? Math.floor(Date.now() / 1000);
  const id = await sha256(enc.encode(JSON.stringify([0, publicKey, created_at, kind, tags, content])));
  const sig = await schnorr.signAsync(id, secretKey);
  return { id: toHex(id), pubkey: publicKey, created_at, kind, tags, content, sig: toHex(sig) };
}

/** 事件 id 与内容一致、签名对得上公钥。中继本该验，但中继不受我们控制，自己再验一遍。 */
export async function verifyEvent(ev) {
  try {
    if (!ev || typeof ev !== 'object') return false;
    if (!HEX64.test(ev.pubkey) || !HEX64.test(ev.id) || !HEX128.test(ev.sig)) return false;
    const id = await sha256(enc.encode(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content])));
    if (toHex(id) !== ev.id) return false;
    return await schnorr.verifyAsync(fromHex(ev.sig), id, fromHex(ev.pubkey));
  } catch {
    return false;
  }
}

/** 结构上像不像我们的事件。全是廉价检查，中继发来什么怪东西都不会在这里抛。 */
function wellFormed(ev) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return false;
  if (ev.kind !== RELAY_EVENT_KIND || !Number.isSafeInteger(ev.created_at)) return false;
  if (typeof ev.id !== 'string' || !HEX64.test(ev.id)) return false;
  if (typeof ev.pubkey !== 'string' || !HEX64.test(ev.pubkey)) return false;
  if (typeof ev.sig !== 'string' || !HEX128.test(ev.sig)) return false;
  if (typeof ev.content !== 'string' || ev.content.length > MAX_CONTENT_CHARS) return false;
  if (!Array.isArray(ev.tags) || ev.tags.length > MAX_TAGS) return false;
  return ev.tags.every((t) => Array.isArray(t) && t.length <= 4 && t.every((x) => typeof x === 'string' && x.length <= 256));
}

const safeName = (v) => String(v || '').slice(0, 40);
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
// 只有房主签的才算数的几种消息
const HOST_ONLY = new Set(['welcome', 'reject', 'leave', 'room-config', 'rekey']);

function relayError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/* ------------------------------ 信令本体 ------------------------------ */

export class RelaySignaling extends Emitter {
  /**
   * @param {object} o
   * @param {string} o.secret      房间密钥（链接里带的）
   * @param {string} o.hostId      房主的 peerId（链接里的 from；房主自己传自己的）
   * @param {string} [o.hostKey]   房主的签名公钥（链接里的 hk）；房主自己不传，用自己生成的
   * @param {boolean} [o.isHost]
   * @param {string} o.peerId
   * @param {string} o.name
   * @param {number} [o.maxMembers]
   * @param {string[]} [o.relays]
   * @param {number} [o.protocolVersion]  P2P 协议版本，房主据此拒绝不兼容的新人
   * @param {() => number} [o.occupied]   房主眼中房间里现在有几个人（含自己）；判满员用
   * @param {(peerId: string) => boolean} [o.isLinked]  房主和这个人的直连现在是否连着。只有房主用；
   *        不传就不做「迟迟连不上就移出」和待定名额限制，行为和以前一样
   * @param {number} [o.pendingMax]  已放行、还没连上的待定名额上限（默认 PENDING_MAX，也可放在 timing 里）
   * @param {typeof WebSocket} [o.WebSocketImpl]  测试注入
   * @param {object} [o.timing]  测试注入：把各种等待时间调短（含 linkGraceMs、pendingMax）
   */
  constructor(o) {
    super();
    this.secret = o.secret;
    this.hostId = o.hostId;
    this.isHost = Boolean(o.isHost);
    this.peerId = o.peerId;
    this.name = safeName(o.name);
    this.maxMembers = Number(o.maxMembers) || 0;
    this.relays = (o.relays && o.relays.length ? o.relays : DEFAULT_RELAYS).slice(0, 12);
    this.protocolVersion = o.protocolVersion ?? 0;
    this._occupied = o.occupied || null;
    this._isLinked = typeof o.isLinked === 'function' ? o.isLinked : null;
    this._WS = o.WebSocketImpl || globalThis.WebSocket;
    this._t = {
      hello: HELLO_INTERVAL_MS,
      join: JOIN_TIMEOUT_MS,
      connect: CONNECT_TIMEOUT_MS,
      alive: ALIVE_INTERVAL_MS,
      silent: SILENT_AFTER_MS,
      sweep: 20000,
      linkGraceMs: LINK_GRACE_MS,
      pendingMax: PENDING_MAX,
      relayStable: RELAY_STABLE_MS,
      relayQuiet: RELAY_QUIET_MS,
      eoseWait: EOSE_WAIT_MS,
      replaySlack: REPLAY_SLACK_MS,
      ...(o.timing || {}),
    };
    this._pendingMax = Math.max(1, Math.floor(Number(o.pendingMax ?? this._t.pendingMax)) || PENDING_MAX);
    // 系统的「网络恢复」事件（online）从哪儿听：页面里是 window，测试可以注入；Node 里没有就不听
    this._netEvents = o.netEvents || (typeof globalThis.addEventListener === 'function' ? globalThis : null);
    this._onOnline = () => this._retryNow();
    this.key = newSigningKey();
    this.publicKey = this.key.publicKey;
    this.hostKey = this.isHost ? this.publicKey : o.hostKey;
    // 不 trickle：候选打包进 SDP，每对人只交换一次 offer 和 answer。
    // 中继上的消息可能乱序、重复、从几个中继各来一份 —— 「候选比 offer 先到被丢」、
    // 一大串候选事件撞上中继限流，这两类问题这样就都不存在了。
    this.trickle = false;
    this.connected = false;

    // url -> { ws, retry, timer, open, openedAt, rxAt, heard, sub, subAt, eose, held, heldTimer }：rxAt 是最后收到
    // 任何东西的时刻，heard 表示这条连接回应过我们自己发的东西（见 RELAY_QUIET_MS）；sub / subAt / eose 是当前这次
    // 订阅的 id、发出的时刻、中继回没回过 EOSE（见 _subscribe）；held 是等这个中继表态的事件（见 _hold）
    this._sockets = new Map();
    this._subSeq = 0;
    this._downSince = 0; // 中继全断的时刻（全断时才非零）
    this._closedByUs = false;
    this._room = null; // { topic, key }
    this._seen = new Map(); // 事件 id -> 本机时间过了这一刻才可以忘掉它（毫秒）
    this._seenPrunedAt = 0;
    this._chains = new Map(); // 事件 id -> 这个 id 正在排队处理的最后一份
    this._inflight = new Map(); // 中继 url -> 正在处理的事件数
    this._counters = new Map(); // 发送方公钥 -> { top, mask, at }：防重放的计数窗口
    this._buckets = new Map(); // 限速的令牌桶
    this._sent = 0; // 我发出去的消息计数
    this._joined = false;
    this._mySeq = this.isHost ? 0 : null;
    this._bindings = new Map(); // peerId -> { pubkey, name, seq, lastSeen }
    this._announced = new Set(); // 已经发过 peer-join 的 peerId
    // 房主：peerId -> { pubkey, name, seq, lastSeen, welcomedAt, linkedEver, unlinkedSince }
    this._members = new Map();
    this._banned = new Map(); // 房主：本场被移出的 'p:peerId' / 'k:公钥'
    this._dropped = new Map(); // 房主：peerId -> { pubkey, seq }，没动静被清掉（没封禁）的成员
    this._busySeen = false; // 新人：这次进房有没有被房主回过 BUSY
    this._removedOnce = false;
    this._nextSeq = 1;
    this._timers = [];
    this._pendingJoin = null; // { resolve, reject, timer }
  }

  /* ---------- 对外接口 ---------- */

  async connect() {
    this._room = await deriveRoom(this.secret);
    if (!this.isHost && !HEX64.test(String(this.hostKey || ''))) {
      throw relayError('房间链接里的房主公钥不对', 'BAD_LINK');
    }
    this._netEvents?.addEventListener('online', this._onOnline);
    await this._openRelays();

    this._every(this._t.alive, () => this._send({ t: 'alive' }));
    this._every(this._t.sweep, () => {
      this._checkRelays();
      this._sweepSilent();
      this._prune();
    });
    if (this.isHost && this._isLinked) {
      this._every(Math.max(10, Math.min(this._t.sweep, this._t.linkGraceMs / 4)), () => this._checkLinks());
    }

    if (this.isHost) {
      this._joined = true;
      const joined = { hostId: this.peerId, maxMembers: this.maxMembers, peers: [] };
      this.emit('joined', joined);
      return joined;
    }

    // 新人：反复发 hello，直到房主的 welcome 到了。welcome 丢了也没事，房主收到重复的
    // hello 会原样再发一次。
    return new Promise((resolve, reject) => {
      const done = (fn, v) => {
        clearInterval(hello);
        clearTimeout(timer);
        this._pendingJoin = null;
        fn(v);
      };
      this._busySeen = false;
      const hello = setInterval(() => this._sayHello(), this._t.hello);
      // 一直被 BUSY 挡着（房主在线，只是待定名额满了）和房主根本不在，要能分得清
      const timer = setTimeout(
        () =>
          done(
            reject,
            this._busySeen
              ? relayError('房主这边正在连接的人太多，暂时进不来，请稍后再试', 'BUSY')
              : relayError('房主不在线，或者这个房间链接已经失效', 'HOST_OFFLINE')
          ),
        this._t.join
      );
      this._pendingJoin = { resolve: (v) => done(resolve, v), reject: (e) => done(reject, e) };
      this._sayHello();
    });
  }

  signal(to, payload) {
    this._send({ t: 'signal', to, payload });
  }

  setMaxMembers(maxMembers) {
    this.maxMembers = Number(maxMembers) || this.maxMembers;
    if (this.isHost) this._send({ t: 'room-config', maxMembers: this.maxMembers });
  }

  /**
   * 换一条房间链接（房主）：新密钥只交给已经放行、最近还有动静的成员，然后大家一起搬过去。
   * 老链接从此没人应答，拿着它的人只会等到「链接已失效」。已经建好的直连不受影响。
   *
   * 新密钥不能放进房间广播：广播用的是旧房间密钥，拿着旧链接、一直挂在旧话题上的人
   * 都解得开，「旧的作废」对他们就不成立。所以每个成员单独一份，用房主签名私钥和该成员
   * 在 hello 里登记的公钥做 ECDH 派生的密钥加密（见 pairKey）。已经被静默清理掉的成员不在名单里；
   * app 传了 isLinked 时，从没和房主连上过直连的也不给 —— 放行了但一直没连上的，可能正是来占位的假身份。
   * 连上过、这会儿正断着在重连的（还在 linkGraceMs 宽限期里）照给：他只是恰好在重协商，
   * 不给的话他被留在旧话题上，房主再也听不到他的重连请求，宽限期一过就被当成连不上移出。
   *
   * 0.7.4 的成员不认这种逐人加密的格式，收到后留在旧话题上：已经建好的直连不受影响，
   * 只是换链接之后进来的人和他们之间不会再经中继建连。
   *
   * 返回 { left }：已放行、却因为从没连上过而没拿到新密钥的人（昵称），好让房主知道谁没跟过来。
   */
  async rekey(newSecret) {
    if (!this.isHost) throw new Error('只有房主能换房间链接');
    const next = await deriveRoom(newSecret); // 格式不对就在这里抛，别先把旧话题上的人送走
    const topic = this._room?.topic;
    const now = Date.now();
    const cutoff = now - this._t.silent;
    const keys = [];
    const left = [];
    this._refreshLinks(now);
    if (topic) {
      for (const [peerId, m] of this._members) {
        if (m.lastSeen < cutoff) continue;
        if (this._isLinked && !this._linkedNow(peerId)) {
          if (!m.linkedEver) {
            left.push(m.name || peerId);
            continue;
          }
          if (m.unlinkedSince && now - m.unlinkedSince >= this._t.linkGraceMs) continue; // 马上要被移出的
        }
        try {
          keys.push([peerId, await seal(await pairKey(this.key.secretKey, m.pubkey, topic, peerId), { s: newSecret })]);
        } catch {
          // 公钥不在曲线上之类（验过签的不会发生）：这个人拿不到新密钥，别的人照常
        }
      }
    }
    await this._send({ t: 'rekey', keys });
    await this._moveTo(newSecret, next);
    this.emit('rekey', { secret: newSecret });
    return { left };
  }

  /**
   * 房主把某人移出并封禁（本场有效）：广播签名的 leave（reason: 'unlinked'），从已放行名单里删掉，
   * 之后他再发 hello 只会收到 REMOVED。和「迟迟连不上直连」的自动移出走同一条路；以后做手动踢人用。
   * 返回他原本是否在已放行名单里。
   */
  kick(peerId) {
    if (!this.isHost) throw new Error('只有房主能移出成员');
    const id = String(peerId || '');
    if (!ID_RE.test(id) || id === this.peerId) return false;
    return this._removeMember(id);
  }

  /** 房主眼中已放行、还活着的成员数（不含房主）。 */
  get admittedCount() {
    return this._members.size;
  }

  close() {
    if (this._closedByUs) return;
    this._netEvents?.removeEventListener('online', this._onOnline);
    // 先尽量说一声再走；发不出去也无所谓，房主 100 秒收不到心跳也会认定离开
    this._send({ t: 'bye' }).finally(() => {
      this._closedByUs = true;
      for (const t of this._timers) clearInterval(t);
      this._timers = [];
      for (const s of this._sockets.values()) {
        clearTimeout(s.timer);
        this._dropHeld(s);
        try {
          s.ws?.close();
        } catch {}
      }
      this._sockets.clear();
      this.connected = false;
    });
    this._pendingJoin?.reject(relayError('已取消', 'CLOSED'));
  }

  /* ---------- 中继连接 ---------- */

  _openRelays() {
    return new Promise((resolve, reject) => {
      let settled = false;
      let failed = 0;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(relayError('连不上任何公共中继', 'RELAY_UNREACHABLE'));
      }, this._t.connect);
      for (const url of this.relays) {
        this._openRelay(url, {
          onOpen: () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          },
          onFail: () => {
            failed++;
            if (!settled && failed >= this.relays.length) {
              settled = true;
              clearTimeout(timer);
              reject(relayError('连不上任何公共中继', 'RELAY_UNREACHABLE'));
            }
          },
        });
      }
    });
  }

  _openRelay(url, first = null) {
    if (this._closedByUs) return;
    const slot = this._sockets.get(url) || { ws: null, retry: 0, timer: null, open: false, openedAt: 0, rxAt: 0, heard: false, sub: '', subAt: 0, eose: false, held: null, heldTimer: null };
    this._sockets.set(url, slot);
    let ws;
    try {
      ws = new this._WS(url);
    } catch {
      first?.onFail();
      return this._retryRelay(url);
    }
    slot.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      slot.open = true;
      // 退避不在这里清零：连稳了才清（见 _relayClosed）
      slot.openedAt = slot.rxAt = Date.now();
      slot.heard = false;
      this.connected = true;
      this._subscribe(slot);
      first?.onOpen();
      first = null;
      if (this._downSince) this._recovered();
    };
    ws.onmessage = (m) => {
      slot.rxAt = Date.now();
      this._onRelayMessage(url, m.data);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (!opened) first?.onFail();
      first = null;
      if (slot.ws === ws) this._relayClosed(url, slot);
    };
  }

  /** 一条中继断了：记账、判断是不是全断了，然后按退避重连。 */
  _relayClosed(url, slot) {
    if (this._closedByUs) return;
    // 稳稳连住过一阵才断的，退避从头算；连上就断的接着累加
    if (slot.open && Date.now() - slot.openedAt >= this._t.relayStable) slot.retry = 0;
    slot.open = false;
    slot.ws = null;
    // 还没表态就断了：扣着的分不清是存货还是实时的，按存货扔掉（真的那份别的中继会送）
    this._dropHeld(slot);
    const anyOpen = [...this._sockets.values()].some((s) => s.open);
    if (!anyOpen && this.connected) {
      this.connected = false;
      this._downSince = Date.now();
      this.emit('disconnected');
      this.emit('reconnecting', { in: this._backoff(slot.retry) });
    }
    this._retryRelay(url);
  }

  /**
   * 半开的连接自己关掉：回应过我们的中继（heard）超过 relayQuiet 一声不吭，多半是本机网络已经断了、
   * TCP 还没报错。不关的话 connected 一直是 true，「全断期间暂停计时」和恢复后的补救都不会发生。
   * 从没回应过的中继（不回 OK、也不回推）不在此列，免得把一个只是不爱说话的中继反复踢掉。
   */
  _checkRelays(now = Date.now()) {
    for (const [url, s] of this._sockets) {
      if (!s.open || !s.heard || now - s.rxAt <= this._t.relayQuiet) continue;
      const ws = s.ws;
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = null;
        try {
          ws.close();
        } catch {}
      }
      // 不等 onclose：对着一条死连接，浏览器的关闭握手要等很久才报
      this._relayClosed(url, s);
    }
  }

  /**
   * 中继从全断里恢复。全断那段时间里别人「没动静」「没连上直连」都怪不到他们头上：
   * 静默清理和未直连移出的计时从现在重新算。然后告诉 app 该把谁的直连重新拉起来。
   */
  _recovered() {
    const now = Date.now();
    const downMs = now - this._downSince;
    this._downSince = 0;
    if (this.isHost) {
      for (const m of this._members.values()) {
        m.lastSeen = now;
        if (m.unlinkedSince) m.unlinkedSince = now;
      }
    } else {
      for (const b of this._bindings.values()) b.lastSeen = now;
      if (this._hostSeen) this._hostSeen = now;
      // 断线期间可能错过了房主移出我的 leave、后来进房的人的 welcome：重新打个招呼。
      // 还在房里的，房主回一份带名册的 welcome；已经被移出的，房主回 REMOVED
      if (this._joined) this._sayHello();
    }
    this.emit('reconnected', { downMs, peers: this._recoverPeers() });
  }

  /** 信令知道的每个人，和这条直连该由谁发起（房主向所有人发；成员之间序号小的向序号大的发）。 */
  _recoverPeers() {
    if (this.isHost) return [...this._members].map(([peerId, m]) => ({ peerId, name: m.name, initiator: true }));
    if (!this._joined) return [];
    const out = [{ peerId: this.hostId, name: this._hostName || '', initiator: false }];
    for (const [peerId, b] of this._bindings) {
      out.push({ peerId, name: b.name, initiator: this._mySeq != null && b.seq > this._mySeq });
    }
    return out;
  }

  _backoff(retry) {
    return Math.min(30000, 1000 * 2 ** retry);
  }

  /**
   * 系统报网络恢复（online）：断着的中继别再等退避。全断期间退避一路涨到 30 秒，
   * 等它慢慢轮到的话，房主那边给我的宽限期可能已经过了。连着的、正在连的不动。
   */
  _retryNow() {
    if (this._closedByUs) return;
    for (const [url, s] of this._sockets) {
      if (s.open || s.ws) continue;
      clearTimeout(s.timer);
      s.timer = null;
      this._openRelay(url);
    }
  }

  _retryRelay(url) {
    if (this._closedByUs) return;
    const slot = this._sockets.get(url);
    if (!slot) return;
    clearTimeout(slot.timer);
    slot.timer = setTimeout(() => this._openRelay(url), this._backoff(slot.retry++));
  }

  /**
   * 订阅本房间的话题。since 和本地的新鲜窗口一样宽：中继对实时推送也按整条过滤器（含 since）匹配，
   * 窄了的话发送方时钟比我慢几十秒，他的消息就被中继挡在外面。
   *
   * 临时事件不等于中继不存：实测 8 个默认中继里有 5 个（strfry 默认）把临时事件在内存里留约 5 分钟，
   * 新订阅一来就在 EOSE 之前全部回放。房主断网恢复时收到回放的旧 hello，会把早已放弃的人放行成待定成员，
   * 60 秒后又按「一直没连上直连」封禁他 —— 他再点链接永远进不来。所以带 limit: 0（「存着的一条都不要」），
   * 只收订阅之后的实时推送。不理 limit 的中继（实测 bucket.coracle.social，照样回放十几秒内的）还有一道保险：
   * EOSE 之前送来的 hello / signal 按发送时刻挑出真正的回放（见 _earlyOk）。别的重放照旧由去重表和发送计数挡。
   */
  _subscribe(slot) {
    if (!this._room || !slot.ws) return;
    slot.sub = `nr${++this._subSeq}`;
    slot.subAt = Date.now();
    slot.eose = false;
    this._dropHeld(slot); // 上一次订阅扣着的：那次订阅已经作废（换话题、重连）
    const filter = { kinds: [RELAY_EVENT_KIND], '#x': [this._room.topic], since: Math.floor(Date.now() / 1000) - MAX_SKEW_SEC, limit: 0 };
    try {
      slot.ws.send(JSON.stringify(['REQ', slot.sub, filter]));
    } catch {}
  }

  /** 这个中继送来的现在算不算实时推送：回过 EOSE，或者订阅之后等了 eoseWait 还没回（有的中继带 limit:0 不回 EOSE）。 */
  _live(url) {
    const slot = this._sockets.get(url);
    return Boolean(slot?.sub) && (slot.eose || Date.now() - slot.subAt >= this._t.eoseWait);
  }

  /**
   * 中继表态之前（回 EOSE，或者订阅后等满 eoseWait）送来的 hello / signal 现在能不能处理。
   * 这时分不清它是实时推送，还是中继存着的旧事件（不理 limit:0 的中继，见 _subscribe）：
   * 旧 hello 会放行一个早就不等了的人，旧 offer 会拆掉活连接。不能处理的不验签、不记去重表 ——
   * 同一条要是从别的中继实时送来，照常收。
   *
   *  - 陌生人的 hello 一律不理、等他下一条：没进房之前他每隔 hello 周期重发一次，丢一条最多晚几秒。
   *    按发送时刻挡不住：房主刚上线时回放的旧 hello 实测最近的只早一两秒，发它的人可能刚刚放弃；
   *    何况 hello 里的发送时刻是他自己的钟，钟快了几十秒的人，几十秒前就放弃了的 hello 看上去也是新的。
   *  - 其余的看发送时刻 ts：它在密文里、签名覆盖着，收件人验得了；中继没有房间密钥，改不了也造不出。
   *    不早于这次订阅前 replaySlack 的照收 —— 刚发出的 offer 不能丢：新人最先连上的中继带 limit:0
   *    从不回 EOSE（它送来的全是实时的），后连上的中继会把几十毫秒前的 offer 当存货送来。
   *  - 更早的先扣下等这个中继表态（见 _hold）：回了 EOSE，说明是存货，扔掉；等满 eoseWait 都不回，
   *    那是实时推送、只是发送方的钟比我慢，照常处理。
   * 这一步排在验签前面：判「收」的接下来照样验签（ts 被动过就验不过）；判「不收」的只作废这一份副本，
   * 不记去重表 —— 中继在这里动手脚，只能让它自己送的那份不算数，挡不住别的中继送来的真事件。
   */
  _earlyOk(url, early, ev, room, body, cls) {
    if (body.t === 'hello' && cls === 'stranger') return false;
    const slot = this._sockets.get(url);
    if (!slot?.subAt) return false;
    if (body.ts >= slot.subAt - this._t.replaySlack) return true;
    this._hold(url, early, ev, room);
    return false;
  }

  /**
   * 扣下一条看上去比订阅早的事件，等这个中继表态：回了 EOSE、连接断了、订阅换了，都扔掉；
   * 订阅后等满 eoseWait 还没回 EOSE，就按实时推送重新排队处理。
   * 扣着的不占处理名额、不挡同一条事件别的副本（真的那份从别的中继实时送来照常收）。
   */
  _hold(url, sub, ev, room) {
    const slot = this._sockets.get(url);
    if (!slot || !sub || slot.sub !== sub || slot.eose || !slot.open) return;
    slot.held ||= [];
    if (slot.held.length >= MAX_HELD_PER_RELAY) return;
    slot.held.push([ev, room]);
    if (slot.heldTimer) return;
    slot.heldTimer = setTimeout(() => {
      const held = slot.held || [];
      slot.held = null;
      slot.heldTimer = null;
      if (this._closedByUs || slot.sub !== sub || slot.eose) return;
      for (const [e, r] of held) if (this._room === r && !this._seen.has(e.id)) this._enqueue(url, e, r, null);
    }, Math.max(0, slot.subAt + this._t.eoseWait - Date.now()));
  }

  _dropHeld(slot) {
    clearTimeout(slot.heldTimer);
    slot.heldTimer = null;
    slot.held = null;
  }

  async _moveTo(secret, derived = null) {
    // 先派生、后改状态：新密钥格式不对时整个搬家作废，别留下「secret 是新的、话题还是旧的」
    const room = derived || (await deriveRoom(secret));
    this.secret = secret;
    this._room = room;
    for (const s of this._sockets.values()) {
      if (!s.open) continue;
      try {
        s.ws.send(JSON.stringify(['CLOSE', s.sub]));
      } catch {}
      this._subscribe(s);
    }
  }

  /* ---------- 发 ---------- */

  async _send(body) {
    if (!this._room || this._closedByUs) return;
    const room = this._room;
    // n：我这次会话的发送计数，收方按它挡重放；pk：签这条事件的公钥，收方核对它，
    // 别人把这段密文另签一份冒充成自己的（比如抢先把新人的 hello 占为己有）就对不上了
    const content = await seal(room.key, {
      ...body,
      v: RELAY_PROTO,
      from: this.peerId,
      name: this.name,
      ts: Date.now(),
      n: ++this._sent,
      pk: this.key.publicKey,
    });
    const ev = await signEvent(this.key, { kind: RELAY_EVENT_KIND, tags: [['x', room.topic]], content });
    this._remember(ev.id, ev.created_at); // 自己发的从中继绕回来时直接丢
    const frame = JSON.stringify(['EVENT', ev]);
    for (const s of this._sockets.values()) {
      if (!s.open) continue;
      try {
        s.ws.send(frame);
      } catch {}
    }
  }

  _sayHello() {
    this._send({ t: 'hello', ver: this.protocolVersion });
  }

  /* ---------- 收 ---------- */

  /**
   * 登记一条已接受的事件。它的 id 一直留到本机时间过了 created_at + 新鲜窗口：在那之前重放会
   * 撞上这张表，在那之后重放会被新鲜窗口挡掉，中间没有空当。返回 false 表示已经登记过。
   */
  _remember(id, createdAt) {
    if (this._seen.has(id)) return false;
    if (this._seen.size >= SEEN_MAX) {
      if (Date.now() - this._seenPrunedAt >= 1000) this._pruneSeen();
      if (this._seen.size >= SEEN_MAX) return false;
    }
    this._seen.set(id, (createdAt + MAX_SKEW_SEC + 1) * 1000);
    return true;
  }

  _pruneSeen() {
    const now = Date.now();
    this._seenPrunedAt = now;
    for (const [id, until] of this._seen) if (until <= now) this._seen.delete(id);
  }

  /** 定期清理：过期的去重记录、闲置的计数窗口和令牌桶。 */
  _prune() {
    const now = Date.now();
    this._pruneSeen();
    for (const [pubkey, w] of this._counters) if (w.at < now - COUNTER_IDLE_MS) this._counters.delete(pubkey);
    this._pruneBuckets(now);
  }

  _pruneBuckets(now = Date.now()) {
    // 桶已经补满的等于没有记录，删掉不影响限速
    for (const [key, b] of this._buckets) {
      if (b.tokens + ((now - b.at) / 1000) * b.rate >= b.burst) this._buckets.delete(key);
    }
  }

  /** 从令牌桶里取一个。取不到就说明这一类来得太快了。 */
  _take(key, [burst, rate]) {
    const now = Date.now();
    let b = this._buckets.get(key);
    if (!b) {
      if (this._buckets.size >= BUCKETS_MAX) {
        this._pruneBuckets(now);
        if (this._buckets.size >= BUCKETS_MAX) return false;
      }
      b = { tokens: burst, at: now, burst, rate };
      this._buckets.set(key, b);
    } else {
      b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * rate);
      b.at = now;
    }
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /**
   * 每个发送方（按签名公钥）一个滑动窗口：计数见过的、或者比窗口还旧的，一律按重放丢掉。
   * 去重表按事件 id 挡原样重放；这一层不依赖那张表，表出了任何意外也还有它兜着。
   * 0.7.4 发的消息不带计数，只靠去重表。
   */
  _counterFresh(pubkey, n) {
    if (n === undefined) return true;
    if (!Number.isSafeInteger(n) || n < 1) return false;
    let w = this._counters.get(pubkey);
    if (w) {
      this._counters.delete(pubkey); // 重新插到末尾：满了先淘汰最久没说话的，不是房主和老成员
    } else {
      if (this._counters.size >= COUNTERS_MAX) this._counters.delete(this._counters.keys().next().value);
      w = { top: 0, mask: 0n, at: 0 };
    }
    this._counters.set(pubkey, w);
    w.at = Date.now();
    if (n > w.top) {
      const shift = n - w.top;
      w.mask = shift >= REPLAY_WINDOW ? 1n : ((w.mask << BigInt(shift)) | 1n) & REPLAY_MASK;
      w.top = n;
      return true;
    }
    const back = w.top - n;
    if (back >= REPLAY_WINDOW) return false;
    const bit = 1n << BigInt(back);
    if (w.mask & bit) return false;
    w.mask |= bit;
    return true;
  }

  _onRelayMessage(url, data) {
    // 先做不花钱的检查：大小、结构、种类、话题、时间。解密和验签都排在后面，
    // 中继（或者只知道话题标签的局外人）灌进来的垃圾大部分在这里就丢了。
    if (typeof data !== 'string' || data.length > MAX_FRAME_CHARS) return;
    const room = this._room;
    if (!room || this._closedByUs) return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!Array.isArray(msg)) return;
    // 这个中继回应过我们自己发的东西（OK，或者把我们的事件推了回来）：之后长时间一声不吭就是连接死了
    if (msg[0] === 'OK' || msg[2]?.pubkey === this.publicKey) {
      const slot = this._sockets.get(url);
      if (slot) slot.heard = true;
    }
    if (msg[0] === 'EOSE') {
      // 只认当前这次订阅的：换话题（rekey）之前那次订阅迟到的 EOSE 不算
      const slot = this._sockets.get(url);
      if (slot?.sub && msg[1] === slot.sub) {
        slot.eose = true;
        // 回了 EOSE：它在这之前送来的只能按存货算（不理 limit:0 的中继就是这样把旧事件送来的），扣着的扔掉
        this._dropHeld(slot);
      }
      return;
    }
    if (msg[0] !== 'EVENT') return;
    const ev = msg[2];
    if (!wellFormed(ev) || !ev.tags.some((t) => t[0] === 'x' && t[1] === room.topic)) return;
    if (Math.abs(Math.floor(Date.now() / 1000) - ev.created_at) > MAX_SKEW_SEC) return;
    // 同一条事件会从好几个中继各来一份：已经接受过的 id 直接丢
    if (ev.pubkey === this.publicKey || this._seen.has(ev.id)) return;
    // 收到的这一刻算不算实时：排队、解密要花时间，等轮到它时 EOSE 可能已经到了
    return this._enqueue(url, ev, room, this._live(url) ? null : this._sockets.get(url)?.sub ?? '');
  }

  /**
   * 排队处理一份事件。early：这份是在中继表态之前收到的，记下当时那次订阅的 id（见 _earlyOk）；实时推送为 null。
   *
   * 同一个 id 的几份排队处理：前一份被接受了，后面的直接丢；前一份是假的（签名或内容被改过），
   * 才轮到下一份。先按 id 登记、再验签的话，恶意中继抢先送一份改过签名的，
   * 各家诚实中继送来的真事件就全被当成重复丢掉了。
   */
  _enqueue(url, ev, room, early) {
    const busy = this._inflight.get(url) || 0;
    if (busy >= MAX_INFLIGHT_PER_RELAY) return;
    this._inflight.set(url, busy + 1);
    const prev = this._chains.get(ev.id);
    const run = (prev || Promise.resolve()).then(() => this._process(url, ev, room, early)).catch(() => {});
    this._chains.set(ev.id, run);
    return run.finally(() => {
      this._inflight.set(url, Math.max(0, (this._inflight.get(url) || 0) - 1));
      if (this._chains.get(ev.id) === run) this._chains.delete(ev.id);
    });
  }

  async _process(url, ev, room, early = null) {
    if (this._room !== room || this._seen.has(ev.id)) return;
    // 解密比验签便宜得多，而且没有房间密钥的人造不出能解开的密文：局外人的垃圾在这一步就停了
    const body = await open(room.key, ev.content);
    if (!body || body.v !== RELAY_PROTO || !ID_RE.test(String(body.from || ''))) return;
    if (!Number.isFinite(body.ts) || Math.abs(Date.now() - body.ts) > MAX_SKEW_SEC * 1000) return;
    // 密文里写着签它的公钥（0.7.4 的没有这一项）：别人照抄密文、自己另签一份的，对不上
    if (body.pk !== undefined && body.pk !== ev.pubkey) return;
    const cls = this._classify(body, ev.pubkey);
    if (!cls) return;
    // 中继表态之前送来的进房请求和握手：先挑出真正的回放（见 _earlyOk）
    if (early !== null && (body.t === 'hello' || body.t === 'signal') && !this._earlyOk(url, early, ev, room, body, cls)) return;
    const limit = cls === 'host' ? LIMITS.verifyHost : cls === 'stranger' ? LIMITS.verifyStranger : LIMITS.verifyMember;
    if (!this._take(`v|${url}|${cls}`, limit)) return;
    if (cls === 'stranger' && !this._take('v|*', LIMITS.verifyStrangerAll)) return;
    if (!(await verifyEvent(ev))) return; // 验不过的不登记：真的那份还要靠它进来
    // 以下是同步的一段：同一个 id 的副本在 _onRelayMessage 里排了队，不会同时走到这里
    if (this._room !== room || this._seen.has(ev.id)) return;
    if (cls !== 'host' && cls !== 'stranger' && !this._take(`s|${cls}`, LIMITS.sender)) return;
    if (!this._remember(ev.id, ev.created_at)) return;
    if (!this._counterFresh(ev.pubkey, body.n)) return;
    this._handle(body, ev.pubkey);
  }

  /**
   * 验签之前先看这条消息跟我有没有关系、自称是谁 —— 只凭解密出来的内容和事件上写的公钥，
   * 这时都还没验证。返回限速记账用的类别：'host'、成员的公钥、或者 'stranger'（没登记过的公钥）；
   * null 表示跟我无关，直接丢，省下验签。冒名的消息在这里最多被记到它冒充的那一类上，
   * 而记账按中继分开，伪造的那个中继只耗掉它自己的份额。
   */
  _classify(body, pubkey) {
    const { t, from } = body;
    if (t === 'hello') {
      if (!this.isHost) return null;
      return this._members.get(from)?.pubkey === pubkey ? pubkey : 'stranger';
    }
    if (HOST_ONLY.has(t)) {
      if (this.isHost || from !== this.hostId || pubkey !== this.hostKey) return null;
      if (t === 'reject' && body.to !== this.peerId) return null;
      return 'host';
    }
    if (t !== 'signal' && t !== 'bye' && t !== 'alive') return null;
    if (t === 'signal' && body.to !== this.peerId) return null;
    if (!this._signedBy(from, pubkey)) return null;
    return from === this.hostId ? 'host' : pubkey;
  }

  /** 这条消息是不是它自称的那个人签的。房主的公钥来自链接；其他人的来自房主签发的 welcome。 */
  _signedBy(peerId, pubkey) {
    if (peerId === this.hostId) return pubkey === this.hostKey;
    const b = this.isHost ? this._members.get(peerId) : this._bindings.get(peerId);
    return Boolean(b) && b.pubkey === pubkey;
  }

  _touch(peerId) {
    const b = this.isHost ? this._members.get(peerId) : this._bindings.get(peerId);
    if (b) b.lastSeen = Date.now();
    if (peerId === this.hostId) {
      this._hostSeen = Date.now();
      this._hostGoneSent = false; // 房主又有动静了：以后再静默，还要再报一次
    }
  }

  _handle(body, pubkey) {
    const { t, from } = body;
    const fromHost = from === this.hostId && pubkey === this.hostKey;

    if (t === 'hello') {
      if (this.isHost) this._onHello(body, pubkey);
      return;
    }
    if (HOST_ONLY.has(t)) {
      if (!fromHost || this.isHost) return; // 只认房主签的；房主自己不处理这些
      this._touch(this.hostId);
      if (t === 'welcome') this._onWelcome(body);
      else if (t === 'reject') this._onReject(body);
      else if (t === 'leave') this._onLeave(String(body.peerId || ''), body.reason);
      else if (t === 'room-config') {
        this.maxMembers = Number(body.maxMembers) || this.maxMembers;
        this.emit('room-config', { maxMembers: this.maxMembers });
      } else if (t === 'rekey') this._onRekey(body).catch(() => {});
      return;
    }
    // 下面这些都必须是「自称的人」本人签的
    if (!this._signedBy(from, pubkey)) return;
    this._touch(from);
    if (t === 'signal') {
      if (body.to !== this.peerId || !body.payload || typeof body.payload !== 'object') return;
      const name = from === this.hostId ? this._hostName || body.name : this._nameOf(from, body.name);
      this.emit('signal', { from, name: safeName(name), payload: body.payload });
    } else if (t === 'bye') {
      if (this.isHost) this._dropMember(from);
      else this._onLeave(from);
    }
    // alive 只用来刷新 lastSeen，上面 _touch 已经做了
  }

  _nameOf(peerId, fallback) {
    const b = this.isHost ? this._members.get(peerId) : this._bindings.get(peerId);
    return b?.name || fallback;
  }

  /* ---------- 房主：守门 ---------- */

  _onHello(body, pubkey) {
    const peerId = String(body.from);
    const name = safeName(body.name);
    const reject = (code, message) => {
      // 回绝也要签名、发到每个中继：一串不同 peerId 的 hello 不能带着房主狂发，
      // 否则房主自己先被中继限流，房里的正常消息也跟着发不出去
      if (!this._take('reject', LIMITS.reject)) return;
      return this._send({ t: 'reject', to: peerId, key: pubkey, code, message });
    };
    // 到期还没连上的先移出、腾出名额（没传 isLinked 时什么也不做）
    this._checkLinks();
    if (peerId === this.peerId) return reject('HOST_ID_RESERVED', '这个身份是房主的');
    if (this.protocolVersion && body.ver !== this.protocolVersion) {
      return reject('VERSION', '双方 NoxReel 版本不一致，请都升级到最新版');
    }
    if (this._isBanned(peerId, pubkey)) return reject('REMOVED', '你已经被移出这个房间，本场放映不能再加入');
    const existing = this._members.get(peerId);
    if (existing) {
      // 同一个人重发 hello（上一条 welcome 丢了）：原样再发一次，不占新位置。
      // 新人每隔一个 hello 周期才发一次，比这更密的重发不理
      if (existing.pubkey === pubkey) {
        existing.lastSeen = Date.now();
        if (Date.now() - (existing.welcomedAt || 0) < this._t.hello / 2) return;
        return this._sendWelcome(peerId, existing);
      }
      return reject('DUP_PEER', '这个身份已经在房间里了');
    }
    const limit = Math.min(this.maxMembers || MAX_MEMBERS, MAX_MEMBERS);
    // occupied() 只数得到已经连上直连的人；放行了还没连上的也占着名额，要加上
    const linkedCount = this._occupied ? Number(this._occupied()) || 0 : 0;
    const occupied = Math.max(1 + this._members.size, linkedCount + this._unlinkedCount());
    if (occupied >= limit) {
      return reject('ROOM_FULL', `房间已满（上限 ${limit} 人）`);
    }
    if (this._isLinked && this._pendingCount() >= this._pendingMax) {
      // 0.7.5 的新人不显示这句、自己接着重试；0.7.4 的会把它当成失败原因直接显示
      return reject('BUSY', '房主这边还有人在连接，请稍后再试');
    }
    const now = Date.now();
    // 因为没动静被清掉、又拿同一把公钥回来的（他那边中继断过一阵）：按原来的序号放行
    const back = this._dropped.get(peerId);
    this._dropped.delete(peerId);
    const seq = back && back.pubkey === pubkey ? back.seq : this._nextSeq++;
    const member = { pubkey, name, seq, lastSeen: now, welcomedAt: 0, linkedEver: false, unlinkedSince: now };
    this._members.set(peerId, member);
    this._sendWelcome(peerId, member);
    // 房主是房里的老成员，和信令服务器下一样由它向新人发 offer
    this.emit('peer-join', { peerId, name });
  }

  _sendWelcome(peerId, m) {
    m.welcomedAt = Date.now();
    // 名册必须随 welcome 一起给新人：中继上的都是临时事件、不落盘，新人永远收不到老成员
    // 当初那条 welcome，也就不知道他们的签名公钥 —— 老成员发来的 offer 会被当成冒名丢掉。
    const roster = [];
    for (const [id, other] of this._members) {
      if (id !== peerId) roster.push({ peerId: id, pubkey: other.pubkey, name: other.name, seq: other.seq });
    }
    return this._send({
      t: 'welcome',
      seq: m.seq,
      peerId,
      pubkey: m.pubkey,
      memberName: m.name,
      maxMembers: this.maxMembers,
      hostName: this.name,
      roster,
    });
  }

  _dropMember(peerId) {
    const m = this._members.get(peerId);
    if (!m) return;
    this._members.delete(peerId);
    this._dropped.delete(peerId);
    this._dropped.set(peerId, { pubkey: m.pubkey, seq: m.seq });
    while (this._dropped.size > DROPPED_MAX) this._dropped.delete(this._dropped.keys().next().value);
    this._send({ t: 'leave', peerId });
    this.emit('peer-leave', { peerId });
  }

  /** app 说房主和他的直连现在连着没有。app 那边出错就当连着 —— 别因为我们自己的毛病把人踢出去。 */
  _linkedNow(peerId) {
    try {
      return Boolean(this._isLinked(peerId));
    } catch {
      return true;
    }
  }

  /** 刷新每个已放行成员的直连状态：连上过没有、从什么时候起一直断着。 */
  _refreshLinks(now = Date.now()) {
    if (!this._isLinked) return;
    for (const [peerId, m] of this._members) {
      if (this._linkedNow(peerId)) {
        m.linkedEver = true;
        m.unlinkedSince = 0;
      } else if (!m.unlinkedSince) {
        m.unlinkedSince = now;
      }
    }
  }

  /**
   * 放行后一直没连上、或连上后又连续断开超过 linkGraceMs 的，移出并封禁。
   * 本机中继全断时不判：那会儿谁的直连断了都重连不上（重连请求发不出去），怪不到他们头上；
   * 恢复时计时从头算（见 _recovered）。
   */
  _checkLinks() {
    if (!this.isHost || !this._isLinked) return;
    this._checkRelays();
    if (!this.connected) return;
    const now = Date.now();
    this._refreshLinks(now);
    for (const [peerId, m] of this._members) {
      if (m.unlinkedSince && now - m.unlinkedSince >= this._t.linkGraceMs) this._removeMember(peerId);
    }
  }

  /** 放行了、此刻没连着直连的人数：occupied() 数不到他们，判满员时要另外加上。 */
  _unlinkedCount() {
    if (!this._isLinked) return 0;
    this._refreshLinks();
    let n = 0;
    for (const m of this._members.values()) if (m.unlinkedSince) n++;
    return n;
  }

  /** 待定名额：放行了、还一次都没连上过的人数。 */
  _pendingCount() {
    this._refreshLinks();
    let n = 0;
    for (const m of this._members.values()) if (!m.linkedEver) n++;
    return n;
  }

  /** 移出并封禁：广播签名的 leave（reason: 'unlinked'），被点名的那一方收到后自己退出。 */
  _removeMember(peerId) {
    const m = this._members.get(peerId);
    this._ban(peerId, m?.pubkey);
    if (!m) return false;
    this._members.delete(peerId);
    this._send({ t: 'leave', peerId, reason: 'unlinked' });
    this.emit('peer-leave', { peerId });
    return true;
  }

  _ban(peerId, pubkey) {
    for (const key of [`p:${peerId}`, pubkey ? `k:${pubkey}` : null]) {
      if (!key) continue;
      this._banned.delete(key); // 重新插到末尾：满了先忘最早封的
      this._banned.set(key, true);
    }
    while (this._banned.size > BANNED_MAX) this._banned.delete(this._banned.keys().next().value);
  }

  _isBanned(peerId, pubkey) {
    return this._banned.has(`p:${peerId}`) || this._banned.has(`k:${pubkey}`);
  }

  _sweepSilent() {
    // 本机中继全断时谁都「没动静」：那是我这边听不见，不是他们走了。恢复时计时从头算（见 _recovered）
    if (!this.connected) return;
    const cutoff = Date.now() - this._t.silent;
    if (this.isHost) {
      for (const [peerId, m] of this._members) if (m.lastSeen < cutoff) this._dropMember(peerId);
      return;
    }
    // 别的成员一直没动静：房主那边也会按同样的心跳判他离开、发 leave。这里只把记录删掉，
    // 免得那条 leave 丢了的时候，记下的公钥越攒越多
    for (const [peerId, b] of this._bindings) {
      if (b.lastSeen < cutoff) {
        this._bindings.delete(peerId);
        this._announced.delete(peerId);
      }
    }
    // 成员这边只盯房主：房主一直没动静就当他走了（直连还在的话 app 那边会忽略这条）
    if (this._joined && this._hostSeen && this._hostSeen < cutoff && !this._hostGoneSent) {
      this._hostGoneSent = true;
      this.emit('peer-leave', { peerId: this.hostId });
    }
  }

  /* ---------- 成员：进房 ---------- */

  _onWelcome(body) {
    const peerId = String(body.peerId || '');
    const seq = Number(body.seq);
    if (!ID_RE.test(peerId) || !Number.isSafeInteger(seq) || seq < 1 || !HEX64.test(String(body.pubkey))) return;
    if (body.hostName) this._hostName = safeName(body.hostName);
    if (Number(body.maxMembers)) this.maxMembers = Number(body.maxMembers);

    if (peerId === this.peerId) {
      if (body.pubkey !== this.publicKey) return; // 别人顶着我的 id？不是给我的
      this._hostGoneSent = false;
      // 名册里是比我早进房的人：记下他们的公钥好认他们的 offer，但不发 peer-join —— 由他们向我发起
      const added = [];
      for (const r of Array.isArray(body.roster) ? body.roster.slice(0, MAX_MEMBERS) : []) {
        const id = String(r?.peerId || '');
        const rseq = Number(r?.seq);
        if (!ID_RE.test(id) || id === this.peerId || !HEX64.test(String(r?.pubkey)) || !Number.isSafeInteger(rseq)) continue;
        if (this._bindings.has(id) || this._bindings.size >= MAX_BINDINGS) continue;
        const binding = { pubkey: r.pubkey, name: safeName(r.name), seq: rseq, lastSeen: Date.now() };
        this._bindings.set(id, binding);
        added.push([id, binding]);
      }
      if (this._joined) {
        // 进房之后又收到给我的 welcome（中继恢复后重新 hello 的回复）：名册里多出来的是我断线期间
        // 进房的人，他们的 welcome 我没收到。序号比我大的由我向他发起，跟平时一样
        for (const [id, b] of added) this._maybeAnnounce(id, b);
        return;
      }
      this._joined = true;
      this._mySeq = seq;
      const joined = { hostId: this.hostId, maxMembers: this.maxMembers, peers: [] };
      this.emit('joined', joined);
      this._pendingJoin?.resolve(joined);
      // 在我之前到、但序号比我大的 welcome（中继乱序）：现在补发 peer-join
      for (const [id, b] of this._bindings) this._maybeAnnounce(id, b);
      return;
    }
    const prev = this._bindings.get(peerId);
    if (prev && prev.pubkey === body.pubkey && prev.seq === seq) return; // 重复的 welcome
    if (!prev && this._bindings.size >= MAX_BINDINGS) return;
    const binding = { pubkey: body.pubkey, name: safeName(body.memberName), seq, lastSeen: Date.now() };
    if (prev && (prev.pubkey !== body.pubkey || prev.seq !== seq)) this._announced.delete(peerId); // 走了又回来
    this._bindings.set(peerId, binding);
    this._maybeAnnounce(peerId, binding);
  }

  /**
   * 谁发 offer 按房主给的序号定：序号比我大的是后来的人，由我这个老成员向他发 offer
   * （信令服务器下也是这条规则）。两人同时进房也不会互相发 offer 撞车 ——
   * 撞车的话双方都会把对方刚建的连接当残骸拆掉。
   */
  _maybeAnnounce(peerId, b) {
    if (!this._joined || this._mySeq == null || b.seq <= this._mySeq || this._announced.has(peerId)) return;
    this._announced.add(peerId);
    this.emit('peer-join', { peerId, name: b.name });
  }

  _onReject(body) {
    if (body.to !== this.peerId || body.key !== this.publicKey) return;
    const code = String(body.code || 'REJECTED').slice(0, 40);
    // 进房之后也认 REMOVED：断线期间被房主移出、错过了那条 leave，恢复后重新 hello 才知道。
    // 别的回绝对已经进房的人没有意义（多半是中继乱序送来的旧回绝）
    if (this._joined && code !== 'REMOVED') return;
    // 房主那边待定的人满了：不算失败，照常每隔一个 hello 周期重发，直到进房超时
    if (code === 'BUSY') {
      this._busySeen = true;
      return;
    }
    if (code === 'REMOVED') return this._removed('你已经被移出这个房间，本场放映不能再加入');
    const message = String(body.message || '房主拒绝了加入').slice(0, 200);
    this._pendingJoin?.reject(relayError(message, code));
  }

  /** 被房主移出：报一个 code 为 REMOVED 的错误，然后关掉，不再重试。 */
  _removed(message) {
    if (this._removedOnce || this._closedByUs) return;
    this._removedOnce = true;
    const err = relayError(message, 'REMOVED');
    this._pendingJoin?.reject(err);
    this.emit('error', err);
    this.close();
  }

  /** 房主换了房间链接：从名单里找到给我的那一份，用 ECDH 派生的密钥解开，然后搬过去。 */
  async _onRekey(body) {
    const room = this._room;
    let secret = null;
    if (Array.isArray(body.keys)) {
      const mine = body.keys
        .slice(0, MAX_MEMBERS)
        .find((k) => Array.isArray(k) && k[0] === this.peerId && typeof k[1] === 'string' && k[1].length <= 1024);
      if (!mine || !room) return; // 名单里没有我：没被放行，或者已经被当成离开了
      const box = await open(await pairKey(this.key.secretKey, this.hostKey, room.topic, this.peerId), mine[1]);
      secret = typeof box?.s === 'string' ? box.s : null;
    } else if (typeof body.secret === 'string') {
      // 0.7.4 的房主把新密钥直接放在房间广播里。照旧跟过去，免得和老版本房主失联
      secret = body.secret;
    }
    if (!secret || this._room !== room) return;
    await this._moveTo(secret);
    this.emit('rekey', { secret });
  }

  _onLeave(peerId, reason) {
    if (!peerId) return;
    if (peerId === this.peerId && reason === 'unlinked') return this._removed('你被移出了房间：一直没能和房主建立直连');
    this._bindings.delete(peerId);
    this._announced.delete(peerId);
    this.emit('peer-leave', { peerId });
  }

  /* ---------- 杂项 ---------- */

  _every(ms, fn) {
    const t = setInterval(() => {
      if (!this._closedByUs) fn();
    }, ms);
    this._timers.push(t);
  }
}
