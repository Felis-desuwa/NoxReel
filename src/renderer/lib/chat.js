/**
 * 弹幕聊天的规则层（纯函数，桌面和安卓共用）。
 *
 * 这里只管「一条聊天消息能不能算数」，不碰 DOM、不碰网络、不碰时间源 ——
 * 时钟一律由调用方注入，所以两端逐字节一致，也好测。
 *
 * 三条容易踩反的约定：
 *
 * 1. **先去重、再扣令牌。** 网状模式下同一条消息会从两条路径到达（直连一份、房主转发一份），
 *    要是先扣令牌，每个人的有效速率就凭空砍掉一半，人多的房间一说话就全被限速吃掉。
 *    所以 id 命中去重表的直接丢弃，不动令牌桶；只有真正被采纳的消息才记进去重表 ——
 *    这同时挡住了「用海量随机 id 把去重表撑爆」这条路，被限速丢掉的消息不留痕迹。
 *
 * 2. **身份以连接为准。** 只有从房主那条连接来的消息才采信 origin/originName（房主是唯一
 *    的转发者）；别人自称「我是替谁转的」一律按他本人算。这和 syncEngine._originOf 是同一套
 *    规则，改一版客户端也冒充不了别人说话。
 *
 * 3. **ts 不可信。** 它由发送方自己填，只用来排个大概顺序；真正显示的时间由房主收到时决定。
 *
 * 文本清洗和昵称截断都按「码点」算，不按 UTF-16 码元算 —— 否则一个 emoji 会被拦腰截成
 * 两个孤立代理项，画到 canvas 和 ASS 上都是问号。
 */

/** 一条消息最长 200 字（按码点算）。 */
export const MAX_TEXT = 200;
/** 昵称一律截断到 40 字。 */
export const MAX_NAME = 40;
/** 房主保留的历史条数，新人入房时整包发过去。 */
export const HISTORY_LIMIT = 50;
/** 令牌桶：突发 5 条，之后每秒回 1 条。 */
export const BURST_TOKENS = 5;
export const REFILL_PER_SECOND = 1;
/** 去重表的容量和存活时长。只记被采纳的消息，所以这个量级绰绰有余。 */
export const SEEN_LIMIT = 512;
export const SEEN_TTL_MS = 120_000;
/** 令牌桶按 origin 分开记；上限防的是房主转发时塞进海量假 origin。 */
export const MAX_BUCKETS = 64;

/** 消息 id：12 位随机十六进制。 */
export const MSG_ID_RE = /^[0-9a-f]{12}$/;
/** 和 signaling.randomPeerId 的字母表一致（聊天安全版 base64 里有 . 和 -，旧码里还有 _）。 */
const PEER_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

// 制表符、换行这些先当空白处理，剩下的控制字符（含 C1、行分隔符、双向文字覆盖）一律删掉。
// 双向覆盖字符能让「你好」显示成别的顺序，是聊天里最实用的一种伪装。
// 注意 u 标志：没有它 \u{2028} 会被当成「字面量 u{2028}」，把正文里的 u、大括号和数字一起吃掉
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u{2028}\u{2029}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;
// 落单的代理项（没有配对的另一半），画出来是问号，直接删
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** 按码点截断，不会把 emoji 拦腰截断。 */
function sliceCodePoints(text, max) {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join('');
}

/**
 * 聊天正文清洗：去控制字符 → 合并连续空白 → 首尾 trim → 最长 200 字。
 * 清洗后为空就返回空串，由调用方丢弃。
 * @returns {string}
 */
export function sanitizeText(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  let text = raw.replace(CONTROL_RE, '').replace(LONE_SURROGATE_RE, '');
  // \s 里已经含全角空格、不换行空格和 BOM，一并并成一个半角空格
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  text = sliceCodePoints(text, MAX_TEXT);
  // 截断可能正好切在空格上，再 trim 一次
  return text.trim();
}

/** 昵称清洗：同样去控制字符、并空白，截断到 40 字。 */
export function clampName(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  const text = raw.replace(CONTROL_RE, '').replace(LONE_SURROGATE_RE, '').replace(/\s+/g, ' ').trim();
  return sliceCodePoints(text, MAX_NAME).trim();
}

/** 12 位随机十六进制 id。一律走 crypto.getRandomValues，不许退回不安全的伪随机数。 */
export function newMessageId() {
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 造一条待发消息。文本清洗后为空返回 null。
 * @returns {{id:string, text:string, ts:number}|null}
 */
export function createMessage(rawText, opts = {}) {
  const text = sanitizeText(rawText);
  if (!text) return null;
  const id = typeof opts.id === 'string' && MSG_ID_RE.test(opts.id) ? opts.id : newMessageId();
  const ts = Number.isFinite(opts.ts) ? Math.floor(opts.ts) : Date.now();
  return { id, text, ts };
}

/* ------------------------------ 令牌桶 ------------------------------ */

/**
 * 令牌桶。突发 capacity 条，之后每秒回 refillPerSecond 条。
 * 时钟由外部注入（推荐单调时钟），墙上时间往回跳时只当作「没有时间流逝」，不会把桶灌满。
 */
export class TokenBucket {
  constructor({ capacity = BURST_TOKENS, refillPerSecond = REFILL_PER_SECOND, now = () => Date.now() } = {}) {
    this.capacity = capacity > 0 ? capacity : 1;
    this.refillPerSecond = refillPerSecond > 0 ? refillPerSecond : 1;
    this.now = now;
    this.tokens = this.capacity;
    this.at = now();
  }

  _refill(t) {
    const elapsed = t > this.at ? t - this.at : 0;
    this.at = t;
    if (elapsed) this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.refillPerSecond);
  }

  /** 够就扣一个并返回 true。 */
  take(t = this.now()) {
    this._refill(t);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** 还要等多少毫秒才能再发一条；现在就能发返回 0。 */
  retryAfterMs(t = this.now()) {
    this._refill(t);
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000);
  }

  reset(t = this.now()) {
    this.tokens = this.capacity;
    this.at = t;
  }
}

/* ------------------------------ 去重 ------------------------------ */

/** 按 id 去重，容量和存活时长都有上限（Map 自带插入序，最老的先挤掉）。 */
export class SeenIds {
  constructor({ limit = SEEN_LIMIT, ttlMs = SEEN_TTL_MS, now = () => Date.now() } = {}) {
    this.limit = limit;
    this.ttlMs = ttlMs;
    this.now = now;
    this.ids = new Map(); // id -> 记下的时刻
  }

  has(id, t = this.now()) {
    const at = this.ids.get(id);
    if (at === undefined) return false;
    if (t - at > this.ttlMs) {
      this.ids.delete(id);
      return false;
    }
    return true;
  }

  remember(id, t = this.now()) {
    this.ids.delete(id);
    this.ids.set(id, t);
    while (this.ids.size > this.limit) {
      const oldest = this.ids.keys().next();
      if (oldest.done) break;
      this.ids.delete(oldest.value);
    }
  }

  get size() {
    return this.ids.size;
  }

  clear() {
    this.ids.clear();
  }
}

/* ------------------------------ 身份 ------------------------------ */

/**
 * 这条聊天到底算谁说的。
 * 只有从房主那条连接来的消息才采信 origin/originName；其他人自称转发一律按他本人算。
 * @returns {{senderId:string, relayed:boolean, origin:string, name:string}|null}
 */
export function originOfChat(msg, { senderId, senderName, hostId } = {}) {
  if (typeof senderId !== 'string' || !senderId) return null;
  const m = msg && typeof msg === 'object' ? msg : {};
  const relayed =
    !!hostId && senderId === hostId && typeof m.origin === 'string' && m.origin !== '' && m.origin !== senderId;
  const origin = relayed ? m.origin : senderId;
  if (!PEER_ID_RE.test(origin)) return null;
  const rawName = relayed ? m.originName : m.name || senderName;
  return { senderId, relayed, origin, name: clampName(rawName) || origin };
}

/** 这条连接是不是房主（CHAT_HISTORY、PLAYLIST 这类只认房主的消息用它把门）。 */
export function trustsRelay(senderId, hostId) {
  return typeof senderId === 'string' && !!senderId && !!hostId && senderId === hostId;
}

/* ------------------------------ 收端闸门 ------------------------------ */

/**
 * 收端的完整流水线：形状校验 → 采信身份 → 去掉自己的回声 → 按 id 去重 → 扣令牌 → 清洗正文。
 *
 * 返回值是给界面直接用的判定结果，没有任何用户可见文案 ——
 * reason 是机器码，文案由 app 层经 t() 生成（'rate' 带 retryAfterMs）。
 */
export class ChatGate {
  constructor({
    now = () => Date.now(),
    capacity = BURST_TOKENS,
    refillPerSecond = REFILL_PER_SECOND,
    seenLimit = SEEN_LIMIT,
    seenTtlMs = SEEN_TTL_MS,
    maxBuckets = MAX_BUCKETS,
  } = {}) {
    this.now = now;
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.maxBuckets = maxBuckets;
    this.seen = new SeenIds({ limit: seenLimit, ttlMs: seenTtlMs, now });
    this.buckets = new Map(); // origin -> TokenBucket
  }

  _bucket(origin) {
    let bucket = this.buckets.get(origin);
    if (bucket) {
      // 命中就挪到队尾，挤人时挤掉最久没说话的
      this.buckets.delete(origin);
      this.buckets.set(origin, bucket);
      return bucket;
    }
    bucket = new TokenBucket({ capacity: this.capacity, refillPerSecond: this.refillPerSecond, now: this.now });
    this.buckets.set(origin, bucket);
    while (this.buckets.size > this.maxBuckets) {
      const oldest = this.buckets.keys().next();
      if (oldest.done) break;
      this.buckets.delete(oldest.value);
    }
    return bucket;
  }

  /**
   * @param {object} msg 线缆消息 {id, text, ts, origin?, originName?, name?}
   * @param {object} ctx {senderId, senderName, hostId, selfId}
   * @returns {{ok:true, message:{id,text,ts,origin,name,relayed}}
   *          |{ok:false, reason:'invalid'|'echo'|'duplicate'|'rate'|'empty', retryAfterMs?:number}}
   */
  accept(msg, ctx = {}) {
    const t = this.now();
    const m = msg && typeof msg === 'object' && !Array.isArray(msg) ? msg : null;
    if (!m || typeof m.id !== 'string' || !MSG_ID_RE.test(m.id) || typeof m.text !== 'string') {
      return { ok: false, reason: 'invalid' };
    }
    const from = originOfChat(m, ctx);
    if (!from) return { ok: false, reason: 'invalid' };

    // 自己的回声：房主把消息转回来了，用来把「发送中」改成「已送达」。不占令牌、不进列表。
    if (ctx.selfId && from.origin === ctx.selfId) return { ok: false, reason: 'echo', id: m.id, origin: from.origin };

    // 先去重，再扣令牌 —— 顺序反过来会让网状模式下的有效速率减半
    if (this.seen.has(m.id, t)) return { ok: false, reason: 'duplicate', id: m.id, origin: from.origin };

    const bucket = this._bucket(from.origin);
    if (!bucket.take(t)) {
      return { ok: false, reason: 'rate', origin: from.origin, retryAfterMs: bucket.retryAfterMs(t) };
    }

    const text = sanitizeText(m.text);
    if (!text) return { ok: false, reason: 'empty', origin: from.origin };

    this.seen.remember(m.id, t);
    const ts = Number.isFinite(m.ts) ? Math.floor(m.ts) : t;
    return {
      ok: true,
      message: { id: m.id, text, ts, origin: from.origin, name: from.name, relayed: from.relayed },
    };
  }

  /** 自己发出去的消息也记一笔，免得房主转回来时又当成新消息显示一遍。 */
  remember(id, t = this.now()) {
    if (typeof id === 'string' && MSG_ID_RE.test(id)) this.seen.remember(id, t);
  }

  /** removePeer 时清掉按 peerId 记的状态。 */
  forget(peerId) {
    this.buckets.delete(peerId);
  }

  clear() {
    this.buckets.clear();
    this.seen.clear();
  }
}

/* ------------------------------ 发端 ------------------------------ */

/**
 * 发端：同一把令牌桶管房间输入框、播放器里的输入条和覆盖窗，免得换个入口就能绕过限速。
 * 超额时返回还要等多久，由 app 层生成「发得太快了（N 秒后再试）」。
 */
export class ChatSender {
  constructor({
    now = () => Date.now(),
    wallClock = () => Date.now(),
    capacity = BURST_TOKENS,
    refillPerSecond = REFILL_PER_SECOND,
  } = {}) {
    this.now = now;
    this.wallClock = wallClock;
    this.bucket = new TokenBucket({ capacity, refillPerSecond, now });
  }

  /**
   * @returns {{ok:true, message:{id,text,ts}}
   *          |{ok:false, reason:'empty'|'rate', retryAfterMs?:number, retryAfterSec?:number}}
   */
  submit(rawText) {
    const text = sanitizeText(rawText);
    if (!text) return { ok: false, reason: 'empty' };
    const t = this.now();
    if (!this.bucket.take(t)) {
      const retryAfterMs = this.bucket.retryAfterMs(t);
      return { ok: false, reason: 'rate', retryAfterMs, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    return { ok: true, message: createMessage(text, { ts: this.wallClock() }) };
  }

  /** 现在还要等多久才能发（给输入框的倒计时用）。 */
  retryAfterMs() {
    return this.bucket.retryAfterMs(this.now());
  }

  reset() {
    this.bucket.reset(this.now());
  }
}

/* ------------------------------ 历史 ------------------------------ */

/**
 * 房主保留的最近 HISTORY_LIMIT 条。新人入房时整包发过去（走 PART 分段信封）。
 * 历史只进聊天列表、不上弹幕，由调用方在渲染时区分。
 */
export class ChatHistory {
  constructor({ limit = HISTORY_LIMIT } = {}) {
    this.limit = limit > 0 ? limit : HISTORY_LIMIT;
    this.items = [];
  }

  /**
   * @param {object} entry {id, text, origin, name, ts}
   * @returns {object|null} 归一化后的条目；不合法返回 null
   */
  add(entry) {
    const item = normalizeHistoryItem(entry);
    if (!item) return null;
    this.items.push(item);
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
    return item;
  }

  list() {
    return this.items.map((it) => ({ ...it }));
  }

  /** CHAT_HISTORY 的线缆载荷：字段名压到最短，100 条 200 字中文也远在 PART 上限内。 */
  snapshot() {
    return this.items.map((it) => ({ id: it.id, text: it.text, from: it.origin, name: it.name, at: it.ts }));
  }

  clear() {
    this.items = [];
  }
}

function normalizeHistoryItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' && MSG_ID_RE.test(raw.id) ? raw.id : null;
  const origin = raw.origin !== undefined ? raw.origin : raw.from;
  const text = sanitizeText(raw.text);
  if (!id || !text || typeof origin !== 'string' || !PEER_ID_RE.test(origin)) return null;
  const rawTs = raw.ts !== undefined ? raw.ts : raw.at;
  return {
    id,
    text,
    origin,
    name: clampName(raw.name) || origin,
    ts: Number.isFinite(rawTs) ? Math.floor(rawTs) : 0,
  };
}

/**
 * 收端解析 CHAT_HISTORY：逐条校验，按 id 去重，只留最近 limit 条。
 * 调用方必须先确认这条消息来自房主连接（trustsRelay）。
 * @returns {Array<{id,text,origin,name,ts}>}
 */
export function parseHistory(items, { limit = HISTORY_LIMIT } = {}) {
  if (!Array.isArray(items)) return [];
  const out = [];
  const seen = new Set();
  // 超长的包只留末尾 limit 条，前面的整包丢掉，不用逐条清洗一万次
  for (const raw of items.slice(-limit)) {
    const item = normalizeHistoryItem(raw);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}
