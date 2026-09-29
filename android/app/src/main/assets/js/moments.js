/**
 * 共享标记（「标记这一刻」）和表情反应的规则。纯逻辑，桌面和安卓共用一份（改了要一起拷过去）。
 *
 * 线缆上和聊天一个走法（见 chat.js）：发的人发给所有连接，房主收到后再转给所有人、带上 origin；
 * 网状房间里会收到两份，按 id 去重。身份以连接为准，只有房主转来的才采信 origin / originName。
 *
 *  - 标记：{ t: 'mark', id, item: 列表里那一项的 id, pos: 秒, note: 一句话（可以空）, ts }。
 *    挂在列表的那一项上，谁都能标（游客也能），大家的进度条上都看得到；控制者点它就跳过去。
 *    删掉一个标记：{ t: 'mark', id, del: 被删那个的 id }（本人或控制者才算数，由 app 按角色判断）。
 *    房主记着整张表，新人进房时给一份（MSG.MARKS），标记只活在这个房间里，不落盘。
 *  - 表情反应：{ t: 'react', id, e: REACTIONS 里的第几个, ts }。只是飘一下，不留。
 *
 * 限速按「谁说的」（origin）和「哪条连接」各算一份：标记每人突发 3 个、之后每 5 秒一个；
 * 表情突发 8 个、之后每秒 2 个。
 */

import { MSG } from './protocol.js';
import { MSG_ID_RE, SeenIds, TokenBucket, clampName, newMessageId, originOfChat, sanitizeText } from './chat.js';

/** 表情反应。按下标传，各端自己画（mpv 里是单色线条字形，按 REACTION_COLORS 上色）。 */
export const REACTIONS = ['❤️', '😂', '😮', '😭', '👍', '👏', '🔥', '🎉'];
export const REACTION_COLORS = ['#ff5a6e', '#ffd23f', '#ffd23f', '#6fb8ff', '#ffd23f', '#ffd23f', '#ff8a3d', '#c792ff'];

/** 标记的一句话最多几个字。 */
export const MAX_NOTE = 60;
/** 每一部最多记几个标记，多了挤掉最早标的。 */
export const MAX_MARKS_PER_ITEM = 60;
/** 房主给新人的整张表最多几条。 */
export const MAX_MARKS_TOTAL = 300;
/** 位置上限（秒），和播放列表里 resumeAt 的上限一致。 */
export const MAX_POS = 86400;

export const MARK_BURST = 3;
export const MARK_REFILL_PER_SECOND = 0.2;
export const REACT_BURST = 8;
export const REACT_REFILL_PER_SECOND = 2;
const SENDER_BURST = 80;
const SENDER_REFILL_PER_SECOND = 16;
const MAX_BUCKETS = 64;
// 线缆上的备注先按字符数挡一道（清洗之前），再截成 MAX_NOTE 个码点
const MAX_WIRE_NOTE = 512;

const ITEM_ID_RE = /^[a-f0-9]{8,32}$/;
const PEER_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** 备注清洗：和聊天正文一样去控制字符、并空白，再截到 MAX_NOTE 个码点。 */
export function cleanNote(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_WIRE_NOTE) return '';
  const text = sanitizeText(raw);
  const points = Array.from(text);
  return points.length <= MAX_NOTE ? text : points.slice(0, MAX_NOTE).join('').trim();
}

function cleanPos(raw) {
  const pos = Number(raw);
  if (!Number.isFinite(pos) || pos < 0 || pos > MAX_POS) return null;
  return Math.round(pos * 10) / 10;
}

/** 造一个待发的标记。列表项 id、位置不对返回 null。 */
export function createMark({ item, pos, note = '' } = {}) {
  if (typeof item !== 'string' || !ITEM_ID_RE.test(item)) return null;
  const at = cleanPos(pos);
  if (at === null) return null;
  return { t: MSG.MARK, id: newMessageId(), item, pos: at, note: cleanNote(note), ts: Date.now() };
}

/** 删掉一个标记的请求。 */
export function createUnmark(markId) {
  if (typeof markId !== 'string' || !MSG_ID_RE.test(markId)) return null;
  return { t: MSG.MARK, id: newMessageId(), del: markId, ts: Date.now() };
}

/** 造一个待发的表情反应。 */
export function createReaction(e) {
  if (!Number.isInteger(e) || e < 0 || e >= REACTIONS.length) return null;
  return { t: MSG.REACT, id: newMessageId(), e, ts: Date.now() };
}

/** 房主给新人的整张表里的一条（或者本机记着的一条）。结构不对返回 null。 */
export function normalizeMark(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.id !== 'string' || !MSG_ID_RE.test(raw.id)) return null;
  if (typeof raw.item !== 'string' || !ITEM_ID_RE.test(raw.item)) return null;
  if (typeof raw.origin !== 'string' || !PEER_ID_RE.test(raw.origin)) return null;
  const pos = cleanPos(raw.pos);
  if (pos === null) return null;
  const ts = Number(raw.ts);
  return {
    id: raw.id,
    item: raw.item,
    pos,
    note: cleanNote(raw.note),
    origin: raw.origin,
    name: clampName(raw.name) || raw.origin,
    ts: Number.isFinite(ts) ? Math.floor(ts) : 0,
  };
}

/**
 * 收端闸门：形状校验 → 采信身份 → 去掉自己的回声 → 按 id 去重 → 扣令牌。
 * 返回给 app 直接用的判定：
 *   {ok: true, kind: 'mark', value: {id, item, pos, note, origin, name, ts, relayed}}
 *   {ok: true, kind: 'unmark', value: {id, target, origin, name, relayed}}
 *   {ok: true, kind: 'react', value: {id, e, origin, name, relayed}}
 *   {ok: false, reason: 'invalid'|'echo'|'duplicate'|'rate'}
 */
export class MomentGate {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.seen = new SeenIds({ now });
    this.senderBuckets = new Map();
    this.markBuckets = new Map();
    this.reactBuckets = new Map();
  }

  _bucket(map, key, capacity, refillPerSecond) {
    let bucket = map.get(key);
    if (bucket) {
      map.delete(key);
      map.set(key, bucket);
      return bucket;
    }
    bucket = new TokenBucket({ capacity, refillPerSecond, now: this.now });
    map.set(key, bucket);
    while (map.size > MAX_BUCKETS) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
    return bucket;
  }

  _parse(m, from) {
    if (m.t === MSG.REACT) {
      if (!Number.isInteger(m.e) || m.e < 0 || m.e >= REACTIONS.length) return null;
      return { kind: 'react', value: { id: m.id, e: m.e } };
    }
    if (m.t !== MSG.MARK) return null;
    if (m.del !== undefined) {
      if (typeof m.del !== 'string' || !MSG_ID_RE.test(m.del)) return null;
      return { kind: 'unmark', value: { id: m.id, target: m.del } };
    }
    if (typeof m.item !== 'string' || !ITEM_ID_RE.test(m.item)) return null;
    const pos = cleanPos(m.pos);
    if (pos === null) return null;
    if (m.note !== undefined && (typeof m.note !== 'string' || m.note.length > MAX_WIRE_NOTE)) return null;
    const ts = Number.isFinite(m.ts) ? Math.floor(m.ts) : this.now();
    return { kind: 'mark', value: { id: m.id, item: m.item, pos, note: cleanNote(m.note || ''), ts, name: from.name } };
  }

  /**
   * @param {object} msg 线缆消息
   * @param {object} ctx {senderId, senderName, hostId, selfId}
   */
  accept(msg, ctx = {}) {
    const t = this.now();
    const m = msg && typeof msg === 'object' && !Array.isArray(msg) ? msg : null;
    if (!m || typeof m.id !== 'string' || !MSG_ID_RE.test(m.id)) return { ok: false, reason: 'invalid' };
    const from = originOfChat(m, ctx);
    if (!from) return { ok: false, reason: 'invalid' };
    const parsed = this._parse(m, from);
    if (!parsed) return { ok: false, reason: 'invalid' };
    // 自己的回声（房主转回来的）：什么都不做
    if (ctx.selfId && from.origin === ctx.selfId) return { ok: false, reason: 'echo' };
    // 先去重再扣令牌：网状房间里一条会从两条路各来一份
    if (this.seen.has(m.id, t)) return { ok: false, reason: 'duplicate' };
    const sender = this._bucket(this.senderBuckets, from.senderId, SENDER_BURST, SENDER_REFILL_PER_SECOND);
    if (!sender.take(t)) return { ok: false, reason: 'rate' };
    const bucket =
      parsed.kind === 'react'
        ? this._bucket(this.reactBuckets, from.origin, REACT_BURST, REACT_REFILL_PER_SECOND)
        : this._bucket(this.markBuckets, from.origin, MARK_BURST, MARK_REFILL_PER_SECOND);
    if (!bucket.take(t)) return { ok: false, reason: 'rate' };
    this.seen.remember(m.id, t);
    return {
      ok: true,
      kind: parsed.kind,
      value: { name: from.name, ...parsed.value, origin: from.origin, relayed: from.relayed },
    };
  }

  /** 自己发出去的也记一笔，房主转回来时认得出。 */
  remember(id) {
    if (typeof id === 'string' && MSG_ID_RE.test(id)) this.seen.remember(id, this.now());
  }

  /**
   * 自己发之前先过一下自己的令牌桶：发得太快的连自己的界面上都不显示（别人那边反正也会丢）。
   * @returns {boolean}
   */
  allowOwn(kind, selfId) {
    const t = this.now();
    const bucket =
      kind === 'react'
        ? this._bucket(this.reactBuckets, selfId, REACT_BURST, REACT_REFILL_PER_SECOND)
        : this._bucket(this.markBuckets, selfId, MARK_BURST, MARK_REFILL_PER_SECOND);
    return bucket.take(t);
  }

  forget(peerId) {
    this.senderBuckets.delete(peerId);
  }
}

/**
 * 这个房间里的标记，按列表项分开记。每一项按位置排好；超过 MAX_MARKS_PER_ITEM 挤掉最早标的。
 */
export class MarkBook {
  constructor({ perItem = MAX_MARKS_PER_ITEM } = {}) {
    this.perItem = perItem;
    this.byItem = new Map(); // item -> [mark]
    this.byId = new Map(); // id -> mark
  }

  /** @returns {boolean} 真加上了（重复的、结构不对的不算） */
  add(raw) {
    const mark = normalizeMark(raw);
    if (!mark || this.byId.has(mark.id)) return false;
    const list = this.byItem.get(mark.item) || [];
    list.push(mark);
    this.byId.set(mark.id, mark);
    while (list.length > this.perItem) {
      let oldest = 0;
      for (let i = 1; i < list.length; i++) if (list[i].ts < list[oldest].ts) oldest = i;
      const [gone] = list.splice(oldest, 1);
      this.byId.delete(gone.id);
    }
    list.sort((a, b) => a.pos - b.pos || a.ts - b.ts);
    this.byItem.set(mark.item, list);
    return this.byId.has(mark.id);
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  /** @returns {object|null} 删掉的那个 */
  remove(id) {
    const mark = this.byId.get(id);
    if (!mark) return null;
    this.byId.delete(id);
    const list = (this.byItem.get(mark.item) || []).filter((m) => m.id !== id);
    if (list.length) this.byItem.set(mark.item, list);
    else this.byItem.delete(mark.item);
    return mark;
  }

  list(item) {
    return (this.byItem.get(item) || []).slice();
  }

  /** 列表里已经没有的项（被移出列表、挤出了已播放区），它的标记也不留。 */
  retain(itemIds) {
    for (const item of [...this.byItem.keys()]) {
      if (itemIds.has(item)) continue;
      for (const mark of this.byItem.get(item)) this.byId.delete(mark.id);
      this.byItem.delete(item);
    }
  }

  /** 给新人的整张表：最近标的优先，最多 limit 条。 */
  snapshot(limit = MAX_MARKS_TOTAL) {
    return [...this.byId.values()]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit)
      .map(({ id, item, pos, note, origin, name, ts }) => ({ id, item, pos, note, origin, name, ts }));
  }

  /** 收下房主给的整张表（合并进来）。@returns {number} 加上了几条 */
  load(items) {
    if (!Array.isArray(items)) return 0;
    let added = 0;
    for (const raw of items.slice(0, MAX_MARKS_TOTAL)) if (this.add(raw)) added++;
    return added;
  }

  clear() {
    this.byItem.clear();
    this.byId.clear();
  }

  get size() {
    return this.byId.size;
  }
}
