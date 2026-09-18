import { Emitter } from './emitter.js';
import {
  MSG,
  PROTOCOL_VERSION,
  ChunkAssembler,
  PartAssembler,
  splitLarge,
  randomId,
  unpackBitfield,
  unpackBitfieldInto,
  packBitfield,
  chunkLengthAt,
  isSlot,
  BITFIELD_CHUNKS_PER_PART,
} from './protocol.js';
import { Scheduler } from './scheduler.js';

/**
 * 群管理：一堆 Peer + 若干个文件槽位 + 收发分片。
 *
 * 每个 peer 既可能是我的上游也可能是我的下游 —— 一个人刚下到的片，
 * 马上就能转手发给第三个人，不用等他自己下完。这就是分发能扩散开的原因，
 * 也是它跟「一个人当服务器往外发」的区别。
 *
 * ── 多文件（0.7）──
 * 播放列表里的每部片占一个槽位（slot），由房主按 fileId 分配。每个槽位各有一份
 * 清单、位图、调度器和拼装器；对方手里有什么也按槽位分开记。
 *  - 同一时刻只向别人要一个槽位的片（activeSlot，由上层按列表顺序指定）。
 *    换 active 时撤回旧槽位的在途请求，已收的片和会话都留着，回头接着传。
 *  - 发片时正在播放的那部优先（playingSlot）：只要还有人在要当前这部，
 *    后面几部的请求就先排着，别拖慢还没收完当前这部的人。
 *  - 清单不再随握手推送，谁需要谁来要（MANIFEST_GET），收到后校验 fileId 摘要。
 */

const TICK_MS = 250;
const SERVE_CONCURRENCY = 2; // 每个 peer 同时最多给他发 2 片，多了会把 ctrl 通道也拖慢
const MAX_SERVE_QUEUE = 256; // 每个 peer 最多排这么多条请求，再多就直接拒
const PING_MS = 3000;
const MANIFEST_HASHES_PER_PART = 600; // 约 40KB/条，稳稳低于 DataChannel 常见 64KB 单消息上限
const MANIFEST_TIMEOUT_MS = 30_000; // 这么久一段都没收到才算超时，分段还在陆续到就一直等
// 分段清单的总时限：超时之外每段再给这么多时间（约 8KB/s），挡住一段一段慢慢喂、把请求一直吊着的人。
// 只有片数有列表条目作保时才这样放宽，否则总时限就是从发出请求起的一个超时
const MANIFEST_PART_BUDGET_MS = 5_000;
const MANIFEST_RESERVE_MS = 30_000; // 同一个人要同一份清单，30 秒内只回一次
const MAX_MANIFEST_ASSEMBLING = 2; // 每个 peer 同时最多拼两份分段清单
const CTRL_LOW_WATER = 256 * 1024; // 分段发清单时，ctrl 缓冲回落到这以下再发下一段，别堵住卡顿消息
const UNKNOWN_SLOT_MAX = 256; // 每个 peer 最多暂存这么多条「列表里还没有的槽位」的位图/HAVE
const UNKNOWN_SLOT_MAX_CHARS = 2 * 1024 * 1024; // 每个 peer 暂存的位图总字符数上限
const UNKNOWN_SLOT_TTL_MS = 60_000;
// 一段位图 base64 后最长多少字符。不分段的整张位图片数也不超过一段，超过这个长度的一定是坏的
const MAX_BITFIELD_CHARS = Math.ceil(Math.ceil(BITFIELD_CHUNKS_PER_PART / 8) / 3) * 4 + 4;
const MAX_UPLINK_BPS = 125_000_000_000; // 和主进程 security.manifest 的上限一致
const MAX_DURATION_SEC = 86_400;
const SMALL_CTRL_CHARS = 16_000; // 一个字符最多 3 字节，这个长度以内一定塞得进一条消息
// 和 signaling.randomPeerId 的字母表一致：聊天安全版 base64 里有 . 和 -（旧码里还有 _）
const PEER_ID_RE = /^[A-Za-z0-9._-]{6,128}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const FILE_ID_RE = /^[a-f0-9]{32}$/;

const keyOf = (slot, index) => `${slot}:${index}`;

/**
 * 从某个 peer 的请求队列里挑下一条来发。纯函数。
 *
 * 队列里有当前播放那部的请求就先发它；没有、但别人还在要当前这部（或者正在给谁发），
 * 后面几部的请求就先等着 —— 带宽先紧着还没收完当前这部的人。
 * @returns {number} 队列下标，-1 表示现在什么都不发
 */
export function pickServeIndex(queue, prioritySlot, priorityDemand) {
  if (!queue.length) return -1;
  if (prioritySlot === null || prioritySlot === undefined) return 0;
  const i = queue.findIndex((r) => r.slot === prioritySlot);
  if (i !== -1) return i;
  return priorityDemand ? -1 : 0;
}

/**
 * 包含 byte 的那一段连续已有片延伸到哪个字节（绝对位置）。
 *
 * byte 所在的那一片还没到，就返回 byte 本身 —— 从这里一个字节都读不出来。
 * 这是「播放器从当前位置往后能安全读到哪」的唯一算法：中途加入房间时，
 * 从文件头起的水位线（contiguousBytes）和这里算出来的数相差整整一部片，
 * 两者不能互相顶替。桌面端和安卓端必须用同一份实现。
 *
 * @param {Uint8Array} have 本地已有位图
 * @param {{chunkSize:number, chunkCount:number, size:number}} meta 清单里的尺寸信息
 * @param {number} byte 起算的字节位置
 */
export function runEndFrom(have, meta, byte) {
  const size = meta?.size || 0;
  const chunkSize = meta?.chunkSize || 0;
  const chunkCount = meta?.chunkCount || 0;
  if (!have || !size || !chunkSize || !chunkCount) return 0;
  const pos = Math.max(0, Math.min(size, byte || 0));
  if (pos >= size) return size;
  const k = Math.floor(pos / chunkSize);
  if (k >= chunkCount || !have[k]) return pos;
  let i = k;
  while (i < chunkCount && have[i]) i++;
  return Math.min(i * chunkSize, size); // 末片比 chunkSize 小，按片数乘出来会超，封顶到文件大小
}

/** 清单的 fileId 必须等于全部分片哈希拼起来的 SHA-256 前 32 位，和主进程 buildManifest 的算法一致。 */
export async function manifestDigestOk(manifest) {
  const data = new TextEncoder().encode(manifest.hashes.join(''));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const hex = Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  return hex === manifest.fileId;
}

/** 清单的基本形状。只看结构，不看摘要。 */
export function manifestShapeOk(manifest) {
  return (
    !!manifest &&
    typeof manifest === 'object' &&
    typeof manifest.fileId === 'string' &&
    FILE_ID_RE.test(manifest.fileId) &&
    typeof manifest.name === 'string' &&
    manifest.name.length <= 200 &&
    Number.isSafeInteger(manifest.size) &&
    manifest.size > 0 &&
    Number.isSafeInteger(manifest.chunkSize) &&
    manifest.chunkSize > 0 &&
    Number.isSafeInteger(manifest.chunkCount) &&
    manifest.chunkCount >= 1 &&
    manifest.chunkCount === Math.ceil(manifest.size / manifest.chunkSize) &&
    Array.isArray(manifest.hashes) &&
    manifest.hashes.length === manifest.chunkCount &&
    manifest.hashes.every((hash) => typeof hash === 'string' && HASH_RE.test(hash))
  );
}

/**
 * 未知槽位暂存的条目：只留补放用得到的字段，其余一律丢掉。
 * 位图长度超过一段的合法上限的，补放时反正解不出来，直接不收。
 * @returns {object|null}
 */
function stashEntryOf(msg) {
  if (msg.t === MSG.HAVE) return { t: MSG.HAVE, s: msg.s, index: msg.index };
  if (msg.full === true) return { t: MSG.BITFIELD, s: msg.s, full: true };
  if (typeof msg.bits !== 'string' || msg.bits.length > MAX_BITFIELD_CHARS) return null;
  if (msg.offset === undefined) return { t: MSG.BITFIELD, s: msg.s, bits: msg.bits };
  const offset = Number(msg.offset);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % BITFIELD_CHUNKS_PER_PART !== 0) return null;
  return { t: MSG.BITFIELD, s: msg.s, bits: msg.bits, offset };
}

/**
 * 新条目补放时会不会把旧条目的效果整个盖掉。盖掉的旧条目留着只是占地方：
 * 整张位图、full、第一段都会换一张新表；后面的段只覆盖自己那一段。
 */
function stashSupersedes(next, old) {
  if (next.s !== old.s) return false;
  if (next.t === MSG.HAVE) return old.t === MSG.HAVE && old.index === next.index;
  if (next.full === true || next.offset === undefined || next.offset === 0) return true;
  if (old.t === MSG.HAVE) return old.index >= next.offset && old.index < next.offset + BITFIELD_CHUNKS_PER_PART;
  return old.offset === next.offset;
}

/**
 * 暂存满了要挤掉的 HAVE，折进同一槽位里最新一张盖得住它的位图再丢。
 * 那张位图一定比它早到（更晚到的会先把它换掉），中间也没有别的条目动过这一片，
 * 所以补放结果和逐条收下完全一样。中继收不齐时对方不会再发 full，
 * 挤掉就再也补不回来，成员会停在这个洞前不向他要。没有位图垫底的只能丢。
 * 位图第一次被折入时解成字节挂在条目上（最多多占位图字数的 3/4），补放时再编回去，
 * 免得每挤一条都把整张重编一遍。
 */
function foldEvictedHave(entries, have) {
  for (let k = entries.length - 1; k >= 0; k--) {
    const entry = entries[k];
    const m = entry.msg;
    if (m.t !== MSG.BITFIELD || m.s !== have.s) continue;
    if (m.full === true) return; // 全有，这一片本来就算在里面
    const bit = have.index - (m.offset ?? 0);
    if (bit < 0 || (m.offset !== undefined && bit >= BITFIELD_CHUNKS_PER_PART)) continue;
    if (entry.bytes === undefined) entry.bytes = decodeBits(m.bits);
    // 超出这张位图字节数的写不进去（类型化数组越界写是空操作），补放时那一片本来也读成 0
    if (entry.bytes) entry.bytes[bit >> 3] |= 0x80 >> (bit & 7);
    return;
  }
}

function decodeBits(b64) {
  let bin;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function encodeBits(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export class Swarm extends Emitter {
  constructor({ peerId, name, securityMode = 'safe', platform = 'desktop' }) {
    super();
    this.peerId = peerId;
    this.name = name;
    this.securityMode = securityMode === 'trusted' ? 'trusted' : 'safe';
    this.platform = platform === 'android' ? 'android' : 'desktop';
    /** @type {Map<string, import('./peer.js').Peer>} */
    this.peers = new Map();

    /** slot -> 本机这部片的传输上下文 */
    this.files = new Map();
    /** slot -> {fileId, size, chunkCount, chunkSize}，来自播放列表。解对方位图全靠它 */
    this.catalog = new Map();
    this.activeSlot = null;
    this.playingSlot = null;
    /** fileId -> 清单。本机准备好、但列表里还没有槽位的片（管理员加片等房主来取） */
    this._offered = new Map();

    this.inflight = new Map(); // "槽位:下标" -> {peerId, at, slot, index}
    this._serving = new Map(); // peerId -> 正在发的片数
    this._serveQueue = new Map(); // peerId -> Array<{slot, index}>
    // Peer 实例 -> 正在给他发的「当前播放那部」的片数。按连接记：人走了份额当场作废，
    // 不能指望那几次发送一定会落定。
    this._priorityServing = new Map();
    this._replayedSlots = null; // 补放暂存期间攒着的 sources 槽位
    /** peerId -> 其他按人记的状态：分段拼装、清单往来、未知槽位暂存 */
    this._peerState = new Map();
    /** fileId -> 正在向别人要的清单 */
    this._manifestWaiters = new Map();
    /** 本次会话里因为协议版本不符断开过的人，上层据此不再和他建连 */
    this.versionRejected = new Set();

    this._timer = null;
    this._pingTimer = null;
    this._totalReceived = 0;
    this._totalSent = 0;
  }

  /** 正在发的「当前播放那部」的片数。人走时 removePeer 会把他那份整个删掉，这里只剩还连着的人。 */
  get _servingPriority() {
    let n = 0;
    for (const count of this._priorityServing.values()) n += count;
    return n;
  }

  /* --------------------------- 文件与位图 --------------------------- */

  _newFileCtx({ slot, manifest, sessionId, isSeeder, state }) {
    const ctx = {
      slot,
      manifest,
      sessionId,
      isSeeder: !!isSeeder,
      have: new Uint8Array(manifest.chunkCount),
      haveCount: 0,
      contiguousBytes: 0,
      complete: false,
      scheduler: new Scheduler({ manifest }),
      assembler: new ChunkAssembler(),
      writing: new Set(), // 已经收齐、正在落盘的分片。见 _commitChunk() 里的说明
      playbackByte: 0,
    };
    if (ctx.isSeeder) {
      ctx.have.fill(1);
      ctx.haveCount = manifest.chunkCount;
      ctx.contiguousBytes = manifest.size;
      ctx.complete = true;
    } else if (state?.bitfield) {
      ctx.have = unpackBitfield(state.bitfield, manifest.chunkCount);
      ctx.haveCount = state.haveCount || 0;
      ctx.contiguousBytes = state.contiguousBytes || 0;
      ctx.complete = !!state.complete;
    }
    if (manifest.durationSec > 0) ctx.scheduler.setDuration(manifest.durationSec);
    return ctx;
  }

  /**
   * 挂上一部片。做种和接收都走这里；已经连上的人马上会收到这个槽位的位图。
   * 同一个槽位换了会话就先把旧的摘掉。
   */
  addFile({ slot, manifest, sessionId, isSeeder, state }) {
    if (!isSlot(slot)) throw new Error('无效的文件槽位');
    if (!manifestShapeOk(manifest)) throw new Error('无效的媒体清单');
    const existing = this.files.get(slot);
    if (existing) {
      if (existing.sessionId === sessionId && existing.manifest.fileId === manifest.fileId) return existing;
      this.removeFile(slot);
    }
    const ctx = this._newFileCtx({ slot, manifest, sessionId, isSeeder, state });
    this.files.set(slot, ctx);
    this._offered.delete(manifest.fileId);
    for (const p of this.peers.values()) {
      if (p.authenticated) this._sendBitfield(p, ctx);
    }
    this._replayUnknown();
    this.emit('progress', this.progress(slot));
    this._tick();
    return ctx;
  }

  /** 摘掉一部片：撤回在途请求，清掉排队中的发片请求。会话本身由上层去关。 */
  removeFile(slot) {
    const ctx = this.files.get(slot);
    if (!ctx) return;
    this._cancelInflight(slot);
    ctx.assembler.clear();
    ctx.writing.clear();
    this.files.delete(slot);
    for (const q of this._serveQueue.values()) {
      for (let i = q.length - 1; i >= 0; i--) if (q[i].slot === slot) q.splice(i, 1);
    }
    if (this.activeSlot === slot) this.activeSlot = null;
    this._pumpAll();
  }

  /** 本机按 fileId 找片。 */
  fileByFileId(fileId) {
    for (const ctx of this.files.values()) if (ctx.manifest.fileId === fileId) return ctx;
    return null;
  }

  /** 准备好了、还没进列表的片：房主来要清单时能给出去。 */
  offerManifest(manifest) {
    if (!manifestShapeOk(manifest)) throw new Error('无效的媒体清单');
    this._offered.set(manifest.fileId, manifest);
  }

  withdrawManifest(fileId) {
    this._offered.delete(fileId);
  }

  _manifestFor(fileId) {
    return this.fileByFileId(fileId)?.manifest || this._offered.get(fileId) || null;
  }

  /**
   * 播放列表里有哪些槽位。对方的位图要按这里的片数解；列表里没有了的槽位，
   * 对方那份状态也就没用了。
   */
  setCatalog(entries) {
    const next = new Map();
    for (const e of entries || []) {
      if (!isSlot(e?.slot) || !Number.isSafeInteger(e.chunkCount) || e.chunkCount < 1) continue;
      next.set(e.slot, {
        fileId: e.fileId,
        size: e.size,
        chunkCount: e.chunkCount,
        chunkSize: e.chunkSize || 0,
      });
    }
    this.catalog = next;
    for (const p of this.peers.values()) {
      for (const slot of [...p.remote.keys()]) {
        if (!next.has(slot) && !this.files.has(slot)) p.remote.delete(slot);
      }
    }
    this._replayUnknown();
    this.emit('peers', this.peerList());
  }

  _metaOf(slot) {
    const ctx = this.files.get(slot);
    if (ctx) return ctx.manifest;
    return this.catalog.get(slot) || null;
  }

  _chunkCountOf(slot) {
    return this._metaOf(slot)?.chunkCount || 0;
  }

  /** 指定现在向别人要哪一部。换掉时撤回旧槽位的在途请求，已收的留着。 */
  setActive(slot) {
    const next = isSlot(slot) ? slot : null;
    if (next === this.activeSlot) return;
    const prev = this.activeSlot;
    this.activeSlot = next;
    if (prev !== null) this._cancelInflight(prev);
    this._tick();
  }

  /** 正在播放哪一部：发片按它优先。 */
  setPlaying(slot) {
    const next = isSlot(slot) ? slot : null;
    if (next === this.playingSlot) return;
    this.playingSlot = next;
    this._pumpAll();
    this.emit('peers', this.peerList());
  }

  setDuration(slot, d) {
    this.files.get(slot)?.scheduler.setDuration(d);
  }

  setPlaybackByte(slot, byte) {
    const ctx = this.files.get(slot);
    if (ctx) ctx.playbackByte = byte || 0;
  }

  progress(slot = this.playingSlot) {
    const ctx = this.files.get(slot);
    const total = ctx?.manifest.chunkCount || 0;
    let inflight = 0;
    for (const info of this.inflight.values()) if (info.slot === slot) inflight++;
    // 播放位置先封顶到文件大小再算，两个数出自同一次计算，相减不会出现幽灵负值。
    const playbackByte = ctx ? Math.max(0, Math.min(ctx.manifest.size, ctx.playbackByte || 0)) : 0;
    const runEndBytes = ctx ? runEndFrom(ctx.have, ctx.manifest, playbackByte) : 0;
    return {
      slot: isSlot(slot) ? slot : null,
      haveCount: ctx?.haveCount || 0,
      chunkCount: total,
      ratio: total ? ctx.haveCount / total : 0,
      contiguousBytes: ctx?.contiguousBytes || 0,
      contiguousRatio: ctx ? ctx.contiguousBytes / ctx.manifest.size : 0,
      // 从文件头起的水位线只代表「完整度」；从播放位置起的这一段才是播放器现在能读多远。
      playbackByte,
      runEndBytes,
      runBytes: runEndBytes - playbackByte,
      complete: !!ctx?.complete,
      inflight,
      downRate: [...this.peers.values()].reduce((a, p) => a + (p.downRate || 0), 0),
      received: this._totalReceived,
      sent: this._totalSent,
    };
  }

  /** 手里有这部片（至少一片）的已认证成员。 */
  sourcesFor(slot) {
    const out = [];
    for (const p of this.peers.values()) {
      const remote = p.authenticated ? p.remote?.get(slot) : null;
      if (remote && (remote.full || remote.have.some((b) => b === 1))) out.push(p.peerId);
    }
    return out;
  }

  /** 我缺的每一片是不是都有人有。按片算，不是按人算：两个各有一半的人也能凑齐。 */
  canFinish(slot) {
    const count = this._chunkCountOf(slot);
    if (!count) return false;
    const ctx = this.files.get(slot);
    if (ctx?.complete) return true;
    const remotes = [];
    for (const p of this.peers.values()) {
      const remote = p.authenticated ? p.remote?.get(slot) : null;
      if (!remote) continue;
      if (remote.full) return true;
      remotes.push(remote.have);
    }
    if (!remotes.length) return false;
    for (let i = 0; i < count; i++) {
      if (ctx?.have[i] === 1) continue;
      let found = false;
      for (const have of remotes) {
        if (have[i] === 1) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  }

  /* ----------------------------- peer ----------------------------- */

  _stateOf(peer) {
    let st = this._peerState.get(peer.peerId);
    if (!st) {
      st = {
        parts: new PartAssembler(),
        served: new Map(), // fileId -> 上次回清单的时间
        sending: new Map(), // fileId -> 正在发的那一轮分段清单的代号
        manifestParts: new Map(), // fileId -> 分段清单拼装
        unknown: [], // [{msg, at}]
      };
      this._peerState.set(peer.peerId, st);
    }
    return st;
  }

  addPeer(peer) {
    // 同一个 peerId 可能再来一次（对方信令重连后老成员会重新发起 offer）。
    // 直接覆盖的话，旧的 RTCPeerConnection 既没关、监听器也还挂着，
    // 成了收得到消息却谁也管不着的幽灵，还占着一份内存和一条 ICE 连接。
    const previous = this.peers.get(peer.peerId);
    if (previous && previous !== peer) this.removePeer(peer.peerId);

    if (!(peer.remote instanceof Map)) peer.remote = new Map();
    this.peers.set(peer.peerId, peer);
    this._serving.set(peer.peerId, 0);
    this._serveQueue.set(peer.peerId, []);
    this._peerState.delete(peer.peerId);

    peer.on('open', () => {
      // 版本和模式协商是数据通道上的第一步；通过前不发清单、控制消息或媒体数据。
      peer.hello(this.peerId, this.name, this.securityMode, this.platform);
      this.emit('peers', this.peerList());
    });

    peer.on('ctrl', (msg) => this._onCtrl(peer, msg));
    peer.on('frame', (f) => this._onFrame(peer, f));

    // 只摘自己，不摘同名的后来者。旧连接的 close/failed 是异步到达的：对端信令重连后
    // 会重新发 offer，我方按同一个 peerId 换上新 Peer，紧接着旧连接的关闭事件才姗姗来迟
    // —— 按 peerId 无差别删除的话，删掉的正是刚建好的新连接，之后谁也不会再发起协商。
    const forgetSelf = () => {
      if (this.peers.get(peer.peerId) === peer) this.removePeer(peer.peerId);
    };
    peer.on('close', forgetSelf);
    peer.on('failed', forgetSelf);
    peer.on('rtt', () => this.emit('peers', this.peerList()));

    this.emit('peers', this.peerList());
    return peer;
  }

  /**
   * 给 peer 换身份。
   *
   * 极简模式下 A 得先造好 Peer、生成 offer，才可能知道对面是谁 —— 所以先用占位 id，
   * 等应答码回来再换成真的。每个 peer 在这里有好几张按 peerId 索引的表
   * （peers / _serving / _serveQueue / _peerState，外加在途记录和清单请求），
   * 只换其中一张的话，另外几张就永远查不到，发片的第一步就静默返回，
   * 表现是「连上了、清单也收到了，但一个字节都不动」。
   * 目前握手流程靠 HELLO 里的 allowIdentityRename 触发它。
   */
  renamePeer(oldId, newId, name) {
    const p = this.peers.get(oldId);
    if (!p || oldId === newId || !PEER_ID_RE.test(newId)) return false;
    // 绝不能覆盖已有 peer；否则攻击者可以把自己改成房主 ID，接管角色权威。
    if (this.peers.has(newId)) return false;

    this.peers.delete(oldId);
    this._serving.set(newId, this._serving.get(oldId) ?? 0);
    this._serveQueue.set(newId, this._serveQueue.get(oldId) ?? []);
    this._serving.delete(oldId);
    this._serveQueue.delete(oldId);
    if (this._peerState.has(oldId)) {
      this._peerState.set(newId, this._peerState.get(oldId));
      this._peerState.delete(oldId);
    }

    // 在途记录和清单请求也是按 peerId 记的，一并迁过去
    for (const info of this.inflight.values()) {
      if (info.peerId === oldId) info.peerId = newId;
    }
    for (const w of this._manifestWaiters.values()) {
      if (w.current === oldId) w.current = newId;
      w.queue = w.queue.map((id) => (id === oldId ? newId : id));
    }

    p.peerId = newId;
    if (name) p.name = String(name).slice(0, 40);
    this.peers.set(newId, p);

    this.emit('peers', this.peerList());
    return true;
  }

  removePeer(peerId) {
    const p = this.peers.get(peerId);
    if (!p) return;

    // 他欠我的片得放回池子里，不然那些片就永远卡在 inflight 里没人再去要
    for (const [key, info] of this.inflight) {
      if (info.peerId === peerId) {
        this.inflight.delete(key);
        this.files.get(info.slot)?.assembler.drop(info.index);
      }
    }

    this.peers.delete(peerId);
    this._serving.delete(peerId);
    this._serveQueue.delete(peerId);
    this._peerState.delete(peerId);
    // 正在给他发的当前这部作废。那几次发送可能永远落不了定（通道关掉后缓冲不会回落），
    // 份额要是等它们来扣，别人排着的后面几部就一直发不出去
    this._priorityServing.delete(p);
    p.close();

    // 正在向他要清单的，换下一个人
    for (const w of [...this._manifestWaiters.values()]) {
      w.queue = w.queue.filter((id) => id !== peerId);
      if (w.current === peerId) this._askNext(w);
    }

    // 他排着的当前这部的请求没了，别让别人的请求继续干等
    this._pumpAll();

    this.emit('peer-gone', peerId);
    this.emit('peers', this.peerList());
  }

  _sendIntro(peer) {
    if (!peer.authenticated) return;
    for (const ctx of this.files.values()) this._sendBitfield(peer, ctx);
    peer.ready = true;
  }

  /**
   * 收完了的片只报一句「全有」；没收完的，片数不多就整张一条发，超过一段的量才分段，每段带 offset。
   */
  _sendBitfield(peer, ctx) {
    if (ctx.complete) {
      peer.send({ t: MSG.BITFIELD, s: ctx.slot, full: true });
      return;
    }
    const total = ctx.have.length;
    if (total <= BITFIELD_CHUNKS_PER_PART) {
      peer.send({ t: MSG.BITFIELD, s: ctx.slot, bits: packBitfield(ctx.have) });
      return;
    }
    for (let offset = 0; offset < total; offset += BITFIELD_CHUNKS_PER_PART) {
      const end = Math.min(total, offset + BITFIELD_CHUNKS_PER_PART);
      peer.send({ t: MSG.BITFIELD, s: ctx.slot, bits: packBitfield(ctx.have, offset, end), offset });
    }
  }

  _peerInfo(peer) {
    // 一次遍历同时数出「总共有几片」和「从头连续有几片」。后者供进度条显示完整度，
    // 前者随时间的增长是对方从所有来源收片的总速度 —— 两个都是卡顿预判要用的。
    // 只看正在播放的那一部。
    const slot = this.playingSlot;
    const meta = this._metaOf(slot);
    const ctx = this.files.get(slot);
    const remote = peer.remote?.get(slot);
    let remoteCount = 0;
    let remoteLeading = 0;
    if (remote) {
      let gap = false;
      for (let i = 0; i < remote.have.length; i++) {
        if (remote.have[i]) {
          remoteCount++;
          if (!gap) remoteLeading++;
        } else {
          gap = true;
        }
      }
    }
    const size = meta?.size || 0;
    const chunkSize = meta?.chunkSize || 0;
    const chunkCount = meta?.chunkCount || 0;
    const playbackByte = Math.max(0, Math.min(size, ctx?.playbackByte || 0));
    return {
      peerId: peer.peerId,
      name: peer.name,
      platform: peer.platform || 'desktop',
      state: peer.pc.iceConnectionState,
      rtt: peer.rtt ? Math.round(peer.rtt) : null,
      downRate: peer.downRate || 0,
      upRate: peer.upRate || 0,
      bytesReceived: peer.bytesReceived,
      bytesSent: peer.bytesSent,
      authenticated: peer.authenticated === true,
      remoteRatio: chunkCount ? remoteCount / chunkCount : 0,
      // 末片比 chunkSize 小，按片数乘出来会略大于文件，所以封顶到文件大小。
      // remoteHeldBytes 必须一直是「总持有量」：RateMeter 拿它测对端的总收片速度，
      // 换成 run-from 的话，对方回填 [0,P) 时会表现成速度掉到 0。
      remoteHeldBytes: Math.min(size, remoteCount * chunkSize),
      remoteContiguousBytes: Math.min(size, remoteLeading * chunkSize),
      // 预判别人卡不卡本来就该按房间播放位置算，所以用本机的 playbackByte。
      // 和 progress() 一样先封顶到文件大小：越界的播放位置会让 runEndFrom 直接返回 size，
      // 于是每个人都被判成「从这里一路能播到尾」，成员面板全体显示「已收完」。
      remoteRunEndBytes: remote ? runEndFrom(remote.have, meta, playbackByte) : 0,
      inflight: peer.inflight.size,
    };
  }

  peerList() {
    return [...this.peers.values()].map((p) => this._peerInfo(p));
  }

  /* --------------------------- 控制消息 --------------------------- */

  _onCtrl(peer, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (!(peer.remote instanceof Map)) peer.remote = new Map();
    // HELLO 必须是第一条业务消息。未认证连接不能触发任何房间行为。
    if (!peer.authenticated && msg.t !== MSG.HELLO) return;
    switch (msg.t) {
      case MSG.HELLO:
        this._onHello(peer, msg);
        break;

      case MSG.PART: {
        // 大消息在认证之后才拼；拼好的内层消息仍然算这条连接发的。
        const inner = this._stateOf(peer).parts.push(msg);
        if (inner) this.emit('ctrl', { msg: inner, peer });
        break;
      }

      case MSG.MANIFEST_GET:
        this._serveManifest(peer, msg.fileId);
        break;

      case MSG.MANIFEST:
        if (msg.missing === true) this._manifestMissing(peer, msg.fileId);
        else this._acceptManifest(peer, msg.manifest);
        break;

      case MSG.MANIFEST_START:
        this._onManifestStart(peer, msg);
        break;

      case MSG.MANIFEST_PART:
        this._onManifestPart(peer, msg);
        break;

      case MSG.BITFIELD:
        this._onBitfield(peer, msg);
        break;

      case MSG.HAVE:
        this._onHave(peer, msg);
        break;

      case MSG.REQUEST:
        this._enqueueServe(peer, msg.s, msg.index);
        break;

      case MSG.CANCEL: {
        const q = this._serveQueue.get(peer.peerId);
        const i = q ? q.findIndex((r) => r.slot === msg.s && r.index === msg.index) : -1;
        if (i !== -1) {
          q.splice(i, 1);
          // 撤掉的正好是当前这部的最后一条，后面几部排着的请求可以动了
          if (msg.s === this.playingSlot && !this._priorityDemand()) this._pumpAll();
        }
        break;
      }

      case MSG.DENY:
        this._onDeny(peer, msg);
        break;

      default:
        this.emit('ctrl', { msg, peer });
    }
  }

  _onHello(peer, msg) {
    if (peer.authenticated) return;
    // 版本排在最前：0.6 的数据帧头和消息都对不上，模式一致也没法互通。
    if (msg.ver !== PROTOCOL_VERSION) {
      this.versionRejected.add(peer.peerId);
      this.emit('version-mismatch', {
        peer,
        peerId: peer.peerId,
        name: typeof msg.name === 'string' ? msg.name.slice(0, 40) : peer.name,
        localVersion: PROTOCOL_VERSION,
        remoteVersion: Number.isSafeInteger(msg.ver) ? msg.ver : 1,
      });
      this.removePeer(peer.peerId);
      return;
    }

    // HELLO 只用于确认身份，不能覆盖信令层已经绑定的 peerId。
    if (msg.peerId && msg.peerId !== peer.peerId) {
      if (!peer.allowIdentityRename || !this.renamePeer(peer.peerId, msg.peerId, msg.name)) {
        this.emit('identity-mismatch', { expected: peer.peerId, claimed: msg.peerId });
        this.removePeer(peer.peerId);
        return;
      }
      peer.allowIdentityRename = false;
    } else if (msg.name) {
      peer.name = String(msg.name).slice(0, 40);
    }

    // 缺少 securityMode 按安全模式处理。可信房间绝不允许缺省值。
    const remoteMode = msg.securityMode === 'trusted' ? 'trusted' : 'safe';
    if (remoteMode !== this.securityMode) {
      this.emit('mode-mismatch', {
        peerId: peer.peerId,
        localMode: this.securityMode,
        remoteMode,
      });
      this.removePeer(peer.peerId);
      return;
    }

    peer.platform = msg.platform === 'android' ? 'android' : 'desktop';
    peer.authenticated = true;
    this._sendIntro(peer);
    this.emit('peer-authenticated', peer);
    this.emit('peer-open', this._peerInfo(peer));
    this.emit('peers', this.peerList());
  }

  /* ---------------------------- 对方的位图 ---------------------------- */

  /**
   * 暂存按条数和位图字符数双重限额，只存规范化后的最小字段。
   * 超限时先挤最老的 HAVE：位图对方只在握手和加片时各发一次，挤掉就再也补不回来，
   * 这个人从此只剩后来零星的几片。挤掉的 HAVE 先折进它前面的位图，有位图垫底的一片都不少。
   */
  _stashUnknown(peer, msg) {
    const entry = stashEntryOf(msg);
    if (!entry) return;
    const st = this._stateOf(peer);
    const now = Date.now();
    st.unknown = st.unknown.filter((e) => now - e.at < UNKNOWN_SLOT_TTL_MS && !stashSupersedes(entry, e.msg));
    st.unknown.push({ msg: entry, at: now });
    let chars = 0;
    for (const e of st.unknown) chars += e.msg.bits?.length || 0;
    while (st.unknown.length > UNKNOWN_SLOT_MAX || chars > UNKNOWN_SLOT_MAX_CHARS) {
      // 条数超了挤 HAVE；字数超了挤带位图的（HAVE 不占字数，挤了也没用）
      let i =
        st.unknown.length > UNKNOWN_SLOT_MAX
          ? st.unknown.findIndex((e) => e.msg.t === MSG.HAVE)
          : st.unknown.findIndex((e) => e.msg.bits !== undefined);
      if (i === -1) i = 0;
      const [gone] = st.unknown.splice(i, 1);
      chars -= gone.msg.bits?.length || 0;
      if (gone.msg.t === MSG.HAVE) foldEvictedHave(st.unknown, gone.msg);
    }
  }

  /** 列表里刚出现的槽位：把之前暂存的位图 / HAVE 按原顺序补上。 */
  _replayUnknown() {
    const now = Date.now();
    // 补放期间 sources 按槽位攒着，补完每个槽位只报一次：一次补上几百条 HAVE 时，
    // 上层每收到一次都要把 canFinish 整张扫一遍
    const outer = this._replayedSlots;
    const replayed = outer || new Set();
    this._replayedSlots = replayed;
    try {
      for (const [peerId, st] of this._peerState) {
        if (!st.unknown.length) continue;
        const peer = this.peers.get(peerId);
        const pending = st.unknown;
        st.unknown = [];
        for (const entry of pending) {
          if (now - entry.at >= UNKNOWN_SLOT_TTL_MS || !peer) continue;
          if (!this._chunkCountOf(entry.msg.s)) {
            st.unknown.push(entry);
            continue;
          }
          if (entry.msg.t !== MSG.BITFIELD) this._onHave(peer, entry.msg);
          else if (entry.bytes) this._onBitfield(peer, { ...entry.msg, bits: encodeBits(entry.bytes) });
          else this._onBitfield(peer, entry.msg);
        }
      }
    } finally {
      this._replayedSlots = outer;
    }
    if (!outer) for (const slot of replayed) this.emit('sources', { slot });
  }

  /** 谁手里有这部片变了。补放暂存期间先攒着。 */
  _sourcesChanged(slot) {
    if (this._replayedSlots) this._replayedSlots.add(slot);
    else this.emit('sources', { slot });
  }

  _onBitfield(peer, msg) {
    const slot = msg.s;
    if (!isSlot(slot)) return;
    const count = this._chunkCountOf(slot);
    if (!count) {
      this._stashUnknown(peer, msg);
      return;
    }
    if (msg.full === true) {
      peer.remote.set(slot, { have: new Uint8Array(count).fill(1), full: true });
    } else if (msg.offset === undefined) {
      peer.remote.set(slot, { have: unpackBitfield(msg.bits, count), full: false });
    } else {
      // 分段位图：offset 必须落在段边界上，第一段到来时换一张新表。
      const offset = Number(msg.offset);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= count || offset % BITFIELD_CHUNKS_PER_PART !== 0) {
        return;
      }
      let remote = peer.remote.get(slot);
      if (offset === 0 || !remote || remote.have.length !== count) {
        remote = { have: new Uint8Array(count), full: false };
        peer.remote.set(slot, remote);
      }
      remote.full = false;
      const n = Math.min(BITFIELD_CHUNKS_PER_PART, count - offset);
      if (!unpackBitfieldInto(remote.have, msg.bits, offset, n)) return;
    }
    peer.ready = true;
    this._sourcesChanged(slot);
    this.emit('peers', this.peerList());
  }

  _onHave(peer, msg) {
    const slot = msg.s;
    const index = msg.index;
    if (!isSlot(slot) || !Number.isSafeInteger(index) || index < 0) return;
    const count = this._chunkCountOf(slot);
    if (!count) {
      this._stashUnknown(peer, msg);
      return;
    }
    if (index >= count) return;
    let remote = peer.remote.get(slot);
    if (!remote) {
      remote = { have: new Uint8Array(count), full: false };
      peer.remote.set(slot, remote);
      this._sourcesChanged(slot);
    } else if (remote.have[index] !== 1) {
      // 他新多了一片我缺的：「凑不齐」可能刚变成「凑得齐」，上层得重算要不要开始收。
      // 只靠 HAVE 补齐来源是常态（星型里中继边收边转），不发事件的话，
      // 在有人进出或列表变动之前谁也不会再去看一眼 canFinish。
      // 正在收的那部不用喊：调度器每一轮都直接看对方的位图。
      const ctx = this.files.get(slot);
      remote.have[index] = 1;
      if (ctx?.have[index] !== 1 && !(ctx && slot === this.activeSlot)) this._sourcesChanged(slot);
      return;
    }
    remote.have[index] = 1;
  }

  _onDeny(peer, msg) {
    const slot = msg.s;
    const index = msg.index;
    if (!isSlot(slot)) return;
    const remote = peer.remote.get(slot);
    if (msg.gone === true) {
      // 他整部都没有了（换片、删缓存），别再找他要
      if (remote) {
        peer.remote.delete(slot);
        this.emit('sources', { slot });
      }
    } else if (msg.busy !== true && remote && Number.isSafeInteger(index) && index >= 0 && index < remote.have.length) {
      remote.have[index] = 0;
      remote.full = false;
    }
    // 他其实没有这片，撤销在途标记，下一轮换个人要
    for (const [key, info] of this.inflight) {
      if (info.peerId !== peer.peerId || info.slot !== slot) continue;
      if (msg.gone !== true && info.index !== index) continue;
      this.inflight.delete(key);
      peer.inflight.delete(key);
      this.files.get(slot)?.assembler.drop(info.index);
    }
  }

  /* ---------------------------- 清单往来 ---------------------------- */

  _serveManifest(peer, fileId) {
    if (typeof fileId !== 'string' || !FILE_ID_RE.test(fileId)) return;
    const manifest = this._manifestFor(fileId);
    if (!manifest) {
      peer.send({ t: MSG.MANIFEST, fileId, missing: true });
      return;
    }
    const st = this._stateOf(peer);
    const now = Date.now();
    const last = st.served.get(fileId);
    if (last !== undefined && now - last < MANIFEST_RESERVE_MS) return;
    st.served.set(fileId, now);
    if (st.served.size > 64) st.served.delete(st.served.keys().next().value);
    this._sendManifest(peer, manifest).catch((e) => console.warn('[swarm] 发送清单失败：', e.message));
  }

  async _sendManifest(peer, manifest) {
    if (manifest.hashes.length <= MANIFEST_HASHES_PER_PART) {
      peer.send({ t: MSG.MANIFEST, manifest });
      return;
    }
    const { hashes, ...meta } = manifest;
    const totalParts = Math.ceil(hashes.length / MANIFEST_HASHES_PER_PART);
    // 对方重新要了（上一轮卡在慢链路上被他判了超时），上一轮就别再往外发了：
    // 他只认新一轮 START 之后的分段，两轮叠着发只会把本来就慢的 ctrl 通道再堵一倍
    const sending = this._stateOf(peer).sending;
    const round = (sending.get(manifest.fileId) || 0) + 1;
    sending.set(manifest.fileId, round);
    peer.send({ t: MSG.MANIFEST_START, meta, totalParts });
    for (let index = 0; index < totalParts; index++) {
      await this._ctrlDrain(peer);
      if (this.peers.get(peer.peerId) !== peer || sending.get(manifest.fileId) !== round) return;
      // 本机已经撤回了这份清单（管理员加片没成、片子不再供了）：剩下的不再发。
      // 接着发完的话，对方照样拼得齐，会把一部本机已经不供片的片子加进列表
      if (!this._manifestFor(manifest.fileId)) return;
      peer.send({
        t: MSG.MANIFEST_PART,
        fileId: manifest.fileId,
        index,
        hashes: hashes.slice(index * MANIFEST_HASHES_PER_PART, (index + 1) * MANIFEST_HASHES_PER_PART),
      });
    }
  }

  /** ctrl 缓冲积压时等它回落。几百 KB 的清单一口气塞进去，紧跟着的卡顿消息就得排在后面。 */
  _ctrlDrain(peer) {
    const channel = peer.ctrl;
    if (!channel || !(channel.bufferedAmount > CTRL_LOW_WATER)) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (channel.readyState !== 'open' || channel.bufferedAmount <= CTRL_LOW_WATER) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
  }

  /**
   * 向别人要一份清单。按 candidates 的顺序一个个问，谁没有或者超时就换下一个。
   * 拿到后校验形状、摘要，以及和播放列表条目对不对得上（expect）。
   */
  requestManifest(fileId, { candidates = [], expect = {}, timeoutMs = MANIFEST_TIMEOUT_MS } = {}) {
    if (typeof fileId !== 'string' || !FILE_ID_RE.test(fileId)) {
      return Promise.reject(new Error('无效的文件标识'));
    }
    const local = this._manifestFor(fileId);
    if (local) return Promise.resolve(local);
    const existing = this._manifestWaiters.get(fileId);
    if (existing) {
      for (const id of candidates) if (!existing.queue.includes(id) && existing.current !== id) existing.queue.push(id);
      return existing.promise;
    }
    const w = { fileId, expect, timeoutMs, queue: [...new Set(candidates)], current: null, timer: null };
    w.promise = new Promise((resolve, reject) => {
      w.resolve = resolve;
      w.reject = reject;
    });
    this._manifestWaiters.set(fileId, w);
    this._askNext(w);
    return w.promise;
  }

  _askNext(w) {
    clearTimeout(w.timer);
    // 已经结束（拿到、放弃）的请求什么都不再动：同一个人这时可能正给新的请求拼同一份清单
    if (this._manifestWaiters.get(w.fileId) !== w) return;
    // 换人之前把上一个人拼到一半的分段扔掉：之后他再发的段不会再收，留着只是一直占着内存直到他断开
    const prev = w.current;
    w.current = null;
    w.deadline = null;
    if (prev !== null) this._peerState.get(prev)?.manifestParts.delete(w.fileId);
    while (w.queue.length) {
      const id = w.queue.shift();
      const peer = this.peers.get(id);
      if (!peer?.authenticated) continue;
      w.current = id;
      w.askedAt = Date.now();
      // 拼到一半的旧分段作废，免得和这次的混在一起
      this._peerState.get(id)?.manifestParts.delete(w.fileId);
      // 先设定时器再发：对方可能在 send 里同步就回了 START 并续了期，
      // 后设的话续期的那个定时器就被顶掉、没人清，到点还会再来一次换人
      w.timer = setTimeout(() => this._askNext(w), w.timeoutMs);
      peer.send({ t: MSG.MANIFEST_GET, fileId: w.fileId });
      return;
    }
    this._manifestWaiters.delete(w.fileId);
    w.reject(new Error('没有人能提供这部片的清单'));
  }

  /**
   * 分段还在陆续到：超时从这一段重新算。总时限只放宽到「每段几秒」，
   * 免得有人一段一段慢慢喂，把请求一直吊着不让换人。
   */
  _extendManifestWait(w) {
    clearTimeout(w.timer);
    const left = w.deadline - Date.now();
    w.timer = setTimeout(() => this._askNext(w), Math.max(0, Math.min(w.timeoutMs, left)));
  }

  /** 播放列表里这部片的条目。条目是房主取到清单、验过摘要才入列的，片数、大小、分片大小都可信。 */
  _listedEntryOf(fileId) {
    for (const e of this.catalog.values()) if (e.fileId === fileId) return e;
    return null;
  }

  /**
   * 对方报的大小、片数、分片大小得和调用方给的 expect 对上；列表里有这部片的，
   * 调用方没传的几项也照样按条目核对（切法不同的清单摘要一样，但每一片都对不上号）。
   */
  _metaExpected(w, m) {
    const { expect } = w;
    const listed = this._listedEntryOf(w.fileId);
    const agrees = (field, want) => want === undefined || m[field] === want;
    return (
      agrees('size', expect.size) &&
      agrees('chunkCount', expect.chunkCount) &&
      agrees('chunkSize', expect.chunkSize) &&
      (!listed ||
        (agrees('size', listed.size) &&
          agrees('chunkCount', listed.chunkCount) &&
          (!listed.chunkSize || m.chunkSize === listed.chunkSize)))
    );
  }

  /** 这个人给的清单不对：报出来，换下一个人。 */
  _rejectManifestFrom(w, peer) {
    console.warn(`[swarm] ${peer.name} 给的清单没通过校验，换人再要`);
    this.emit('manifest-bad', { fileId: w.fileId, from: peer.peerId });
    this._askNext(w);
  }

  _manifestMissing(peer, fileId) {
    const w = this._manifestWaiters.get(fileId);
    if (w && w.current === peer.peerId) this._askNext(w);
  }

  /** 只收自己正在向这个人要的清单；不请自来的一律丢掉。 */
  _waiterFor(peer, fileId) {
    const w = typeof fileId === 'string' ? this._manifestWaiters.get(fileId) : null;
    return w && w.current === peer.peerId ? w : null;
  }

  _onManifestStart(peer, msg) {
    const meta = msg.meta;
    const w = this._waiterFor(peer, meta?.fileId);
    if (!w) return;
    const totalParts = Number(msg.totalParts);
    if (
      !Number.isInteger(totalParts) ||
      totalParts < 1 ||
      totalParts > 0xffffffff || // 再大 new Array 直接抛错
      !Number.isSafeInteger(meta.chunkCount) ||
      meta.chunkCount < 1 ||
      // 不限制文件多大，但分段数必须正好是片数除以每段容量 —— 挡住对方乱报一个巨大的 totalParts。
      totalParts !== Math.ceil(meta.chunkCount / MANIFEST_HASHES_PER_PART) ||
      // 片数、大小一开头就和列表条目对一下：光看自洽的话，对方把片数一起报大就绕过去了
      !this._metaExpected(w, meta)
    ) {
      this._rejectManifestFrom(w, peer);
      return;
    }
    const st = this._stateOf(peer);
    if (st.manifestParts.size >= MAX_MANIFEST_ASSEMBLING && !st.manifestParts.has(meta.fileId)) {
      st.manifestParts.delete(st.manifestParts.keys().next().value);
    }
    st.manifestParts.set(meta.fileId, { meta, totalParts, parts: new Array(totalParts), received: 0 });
    // 同一轮里重发 START 不能把总时限往后推。
    // 片数有列表条目作保，才按段数放宽总时限：真清单多大，拼装最多就占多少。
    // 列表里还没有这部片（房主替管理员取他正在加的片）时，片数是对方自己报的：
    // 报个天文数字再一段段慢慢喂，请求就能吊上几天、拼装数据一直涨，房主的列表操作也全堵在后面。
    // 这时总时限仍从发出请求算起，房主也总能赶在管理员那头的操作超时之前给出结论。
    if (w.deadline == null) {
      w.deadline = this._listedEntryOf(w.fileId)
        ? Date.now() + w.timeoutMs + totalParts * MANIFEST_PART_BUDGET_MS
        : w.askedAt + w.timeoutMs;
    }
    this._extendManifestWait(w);
  }

  _onManifestPart(peer, msg) {
    const st = this._stateOf(peer);
    const pending = typeof msg.fileId === 'string' ? st.manifestParts.get(msg.fileId) : null;
    const w = pending ? this._waiterFor(peer, msg.fileId) : null;
    const index = Number(msg.index);
    if (!w || !Number.isInteger(index) || index < 0 || index >= pending.totalParts || pending.parts[index]) return;
    // 每段的条数是定死的：除了最后一段都是满的。每一项都得是哈希 ——
    // 不然一段能塞 256KB 的任意字符串，要等全部收齐才发现不对
    const expected =
      index < pending.totalParts - 1
        ? MANIFEST_HASHES_PER_PART
        : pending.meta.chunkCount - MANIFEST_HASHES_PER_PART * (pending.totalParts - 1);
    if (
      !Array.isArray(msg.hashes) ||
      msg.hashes.length !== expected ||
      !msg.hashes.every((hash) => typeof hash === 'string' && HASH_RE.test(hash))
    ) {
      this._rejectManifestFrom(w, peer);
      return;
    }
    pending.parts[index] = msg.hashes;
    pending.received++;
    this._extendManifestWait(w);
    if (pending.received === pending.totalParts) {
      st.manifestParts.delete(msg.fileId);
      this._acceptManifest(peer, { ...pending.meta, hashes: pending.parts.flat() });
    }
  }

  async _acceptManifest(peer, manifest) {
    const w = this._waiterFor(peer, manifest?.fileId);
    if (!w) return;
    const { expect } = w;
    let ok = manifestShapeOk(manifest) && this._metaExpected(w, manifest);
    if (ok) {
      try {
        ok = await manifestDigestOk(manifest);
      } catch {
        ok = false;
      }
    }
    // 校验期间可能已经超时换人，或者请求已经结束
    if (this._manifestWaiters.get(w.fileId) !== w || w.current !== peer.peerId) return;
    if (!ok) {
      this._rejectManifestFrom(w, peer);
      return;
    }
    clearTimeout(w.timer);
    this._manifestWaiters.delete(w.fileId);
    w.resolve(this._trustedManifestOf(manifest, expect));
  }

  /**
   * 摘要只管得住哈希。对方给的清单只取哈希和分片参数（它们已经和摘要、条目对过），
   * 其余字段按白名单重建，能以列表条目为准的就以条目为准（条目是房主校验过、全场一致的）：
   *  - 名字：改个扩展名，分片 0 就永远过不了主进程的文件头检查，水位线停在 0；
   *  - 多带的字段、越界的时长：主进程校验清单直接报错，这部片本场就被拒收了。
   * 主进程 openLeech 仍会完整校验一遍，这里只是不让别人塞进来的东西走到那一步。
   */
  _trustedManifestOf(manifest, expect) {
    const result = {
      fileId: manifest.fileId,
      name: typeof expect.name === 'string' && expect.name ? expect.name : manifest.name,
      size: manifest.size,
      chunkSize: manifest.chunkSize,
      chunkCount: manifest.chunkCount,
      hashes: manifest.hashes,
    };
    // 条目有时长就以条目为准；条目也不知道（0）时才用对方报的，越界的不要
    const durationSec = expect.durationSec > 0 ? expect.durationSec : manifest.durationSec;
    if (Number.isFinite(durationSec) && durationSec > 0 && durationSec <= MAX_DURATION_SEC) {
      result.durationSec = durationSec;
    }
    // 片源上行只是展示用的估计值，条目里没有，范围对才带上
    const uplink = manifest.sourceUplinkBps;
    if (Number.isFinite(uplink) && uplink >= 0 && uplink <= MAX_UPLINK_BPS) result.sourceUplinkBps = uplink;
    return result;
  }

  /* ---------------------------- 大消息 ---------------------------- */

  /** 可能超过单条上限的消息（播放列表、聊天历史）。短的照常发，长的切成 PART。 */
  sendLarge(peer, msg) {
    return this._sendParts(peer, this._partsOf(msg));
  }

  broadcastLarge(msg, { except = null } = {}) {
    const parts = this._partsOf(msg);
    for (const p of this.peers.values()) {
      if (p.authenticated && p.peerId !== except) this._sendParts(p, parts);
    }
  }

  _partsOf(msg) {
    if (JSON.stringify(msg).length <= SMALL_CTRL_CHARS) return [msg];
    return splitLarge(msg, randomId(8));
  }

  _sendParts(peer, parts) {
    for (const part of parts) if (!peer.send(part)) return false;
    return true;
  }

  /* ---------------------------- 发送侧 ---------------------------- */

  _enqueueServe(peer, slot, index) {
    if (!isSlot(slot) || !Number.isSafeInteger(index) || index < 0) return;
    const ctx = this.files.get(slot);
    if (!ctx) {
      peer.send({ t: MSG.DENY, s: slot, index, gone: true });
      return;
    }
    if (index >= ctx.manifest.chunkCount) return;
    const q = this._serveQueue.get(peer.peerId);
    if (!q) return;
    if (ctx.have[index] !== 1) {
      peer.send({ t: MSG.DENY, s: slot, index });
      return;
    }
    // 排满了只是「现在忙」，不是「没有」—— 对方不能因此把这片从我的位图里抹掉
    if (q.length >= MAX_SERVE_QUEUE) {
      peer.send({ t: MSG.DENY, s: slot, index, busy: true });
      return;
    }
    if (q.some((r) => r.slot === slot && r.index === index)) return;
    q.push({ slot, index });
    this._pumpServe(peer);
  }

  /** 有没有人在等当前播放那部的片，或者正在给谁发。 */
  _priorityDemand() {
    if (this.playingSlot === null) return false;
    if (this._servingPriority > 0) return true;
    for (const q of this._serveQueue.values()) {
      if (q.some((r) => r.slot === this.playingSlot)) return true;
    }
    return false;
  }

  _pumpAll() {
    for (const p of this.peers.values()) this._pumpServe(p);
  }

  _pumpServe(peer) {
    const q = this._serveQueue.get(peer.peerId);
    if (!q) return;
    while (q.length && (this._serving.get(peer.peerId) || 0) < SERVE_CONCURRENCY) {
      const i = pickServeIndex(q, this.playingSlot, this._priorityDemand());
      if (i < 0) return;
      const [req] = q.splice(i, 1);
      const priority = req.slot === this.playingSlot;
      if (priority) this._priorityServing.set(peer, (this._priorityServing.get(peer) || 0) + 1);
      this._serving.set(peer.peerId, (this._serving.get(peer.peerId) || 0) + 1);
      this._serveOne(peer, req).finally(() => {
        // 人已经走了的话 removePeer 早把他的份额整个删了，这里什么都不扣
        const left = (this._priorityServing.get(peer) || 0) - 1;
        if (priority && left > 0) this._priorityServing.set(peer, left);
        else if (priority) this._priorityServing.delete(peer);
        // 计数按 peerId 记，但只属于这条连接：同 id 重连后，旧连接迟到的收尾不能扣新连接的名额
        if (this.peers.get(peer.peerId) === peer) {
          this._serving.set(peer.peerId, Math.max(0, (this._serving.get(peer.peerId) || 1) - 1));
          this._pumpServe(peer);
        }
        // 当前这部暂时没人要了，后面几部排着的请求可以动了
        if (priority && !this._priorityDemand()) this._pumpAll();
      });
    }
  }

  async _serveOne(peer, { slot, index }) {
    const ctx = this.files.get(slot);
    if (!ctx) return;
    try {
      const buf = await window.sw.store.readChunk(ctx.sessionId, index);
      if (this.peers.get(peer.peerId) !== peer || this.files.get(slot) !== ctx) return;
      await peer.sendChunk(slot, index, buf);
      this._totalSent += buf.byteLength;
      this.emit('progress', this.progress(slot));
    } catch (e) {
      // 读盘期间这部片被摘掉了，会话已关，读失败是意料之中；人走了，发送途中被放掉也是
      if (this.files.get(slot) !== ctx || this.peers.get(peer.peerId) !== peer) return;
      console.warn(`[swarm] 发送分片 ${slot}:${index} 给 ${peer.name} 失败:`, e.message);
    }
  }

  /* ---------------------------- 接收侧 ---------------------------- */

  _onFrame(peer, { slot, chunkIndex, frameIndex, payload }) {
    if (!peer.authenticated) return;
    const ctx = this.files.get(slot);
    if (!ctx || ctx.isSeeder) return;
    const full = ctx.assembler.push(chunkIndex, frameIndex, payload);
    if (!full) return;
    this._commitChunk(peer, ctx, chunkIndex, full);
  }

  async _commitChunk(peer, ctx, index, bytes) {
    // 一定要按记账里登记的那个 peer 去销账，而不是「送来最后一帧的人」。
    //
    // 这两者会不一致：一片超时被回收后改派给了 B，原来的 A 随后从头重发并抢先
    // 把它凑齐，_commitChunk 收到的 peer 就是 A。此时去删 A.inflight 是空操作，
    // 而 B.inflight 里那个下标再也没人清 —— 全局记录已经删掉，_expireStale 扫不到，
    // DENY 分支也会因为取不到 info 而跳过。每漏一个，B 的在途窗口就永久少一格，
    // 攒够窗口数这个上游就被 plan() 的 usable 过滤器永久剔除：连接全都健康、
    // 成员列表也正常，进度条却停住不动。
    const slot = ctx.slot;
    const key = keyOf(slot, index);
    const owner = this.inflight.get(key);
    this.inflight.delete(key);
    if (owner) this.peers.get(owner.peerId)?.inflight.delete(key);
    peer.inflight.delete(key); // 送达方那边也清一次，两者相同时等价

    // 从「在途」到「已有」中间隔着一整个写盘往返：2MB 过 IPC、算 SHA-256、落盘。
    // 这段时间里这片既不在 inflight 里、have 也还是 0，调度器只能判定它还缺，
    // 于是再去要一遍 —— 而 v0.6.5 起每片落地都会触发一次 _tick，等于把这个窗口
    // 撞得更频繁。实测一个 25.9 MB 的文件，发送端总共发出 59.8 MB（2.3 倍）。
    // 重复的那份最后被 fileStore 认出来丢掉（res.duplicate），带宽却已经花掉了。
    ctx.writing.add(index);

    try {
      const res = await window.sw.store.writeChunk(ctx.sessionId, index, bytes.buffer);
      // 写盘期间这部片被摘掉或换了会话：结果作废，别写进新上下文里
      if (this.files.get(slot) !== ctx) return;

      if (!res.ok) {
        // 校验没过。这片作废重下 —— 这就是渐进式校验的意义：
        // 坏数据当场拦住，不会等到播放的时候才发现花屏。
        console.warn(`[swarm] 分片 ${slot}:${index} 校验失败（${res.reason}），来自 ${peer.name}`);
        this.emit('chunk-bad', { slot, index, from: peer.peerId, reason: res.reason });
        return;
      }

      this._totalReceived += bytes.length;

      if (!res.duplicate) {
        ctx.have[index] = 1;
        ctx.haveCount = res.haveCount;
        ctx.contiguousBytes = res.contiguousBytes;
        // 第 0 片到手，容器就能按内容认了（扩展名不作数）。调度器据此决定要不要
        // 继续给文件尾的索引留位置 —— 认错了安卓会永远卡在 prepare 上。
        if (index === 0) ctx.scheduler.setHeadBytes(bytes);
        const justCompleted = !ctx.complete && !!res.complete;
        ctx.complete = !!res.complete;

        // 告诉所有人我有这片了，他们马上就能来找我要。
        // 收齐时再补一句「全有」：只靠一条条 HAVE 的话，对方那边既不知道我已经是完整片源，
        // 也不一定会因此重算要不要开始收（星型里我可能是他唯一的来源）
        for (const p of this.peers.values()) {
          if (!p.authenticated) continue;
          p.send({ t: MSG.HAVE, s: slot, index });
          if (justCompleted) p.send({ t: MSG.BITFIELD, s: slot, full: true });
        }

        this.emit('progress', this.progress(slot));
        if (justCompleted) this.emit('complete', { slot, fileId: ctx.manifest.fileId });
      }
    } catch (e) {
      if (this.files.get(slot) !== ctx) return; // 会话已关，写失败是意料之中
      console.error(`[swarm] 写入分片 ${slot}:${index} 出错:`, e);
      this.emit('error', e);
    } finally {
      ctx.writing.delete(index);
      // 一片落地就立刻把空出来的名额补上，别干等下一个 tick。
      //
      // 这条不是锦上添花：Chromium 会把不可见窗口的定时器节流到 1 秒一次，
      // 而「正在看片」恰恰就是 NoxReel 窗口不可见的时候 —— 播放器是另一个窗口，
      // 就压在它上面。于是 TICK_MS 的 250ms 变成 1000ms，每秒最多补
      // MAX_INFLIGHT_PER_PEER 片，吞吐被硬卡在 4 × 2MB = 8 MB/s，
      // 网络再快也没用（实测回环链路正好停在 7.7 MB/s）。
      // 数据通道的消息事件不受节流，把补片挂在它上面，定时器退回兜底角色。
      this._tick();
    }
  }

  /* ---------------------------- 调度循环 ---------------------------- */

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), TICK_MS);
    this._pingTimer = setInterval(() => {
      for (const p of this.peers.values()) p.ping();
      this.emit('peers', this.peerList());
    }, PING_MS);
  }

  stop() {
    clearInterval(this._timer);
    clearInterval(this._pingTimer);
    this._timer = this._pingTimer = null;
  }

  /** 调度器看到的 peer：只含这个槽位的位图。scheduler.js 两端共用，不为多文件改它。 */
  _peerViews(slot) {
    const views = [];
    for (const p of this.peers.values()) {
      const remote = p.authenticated ? p.remote?.get(slot) : null;
      if (!remote) continue;
      views.push({
        peerId: p.peerId,
        ready: true,
        remoteHave: remote.have,
        inflight: p.inflight,
        downRate: p.downRate || 0,
        rtt: p.rtt || 0,
      });
    }
    return views;
  }

  _tick() {
    const ctx = this.files.get(this.activeSlot);
    if (!ctx || ctx.complete || ctx.isSeeder) return;

    this._expireStale();

    // 正在落盘的那几片也算「已经安排上了」，否则它们会在写盘的空档里被重复请求。
    const busy = new Set(ctx.writing);
    for (const info of this.inflight.values()) if (info.slot === ctx.slot) busy.add(info.index);

    const assignments = ctx.scheduler.plan({
      have: ctx.have,
      playbackByte: ctx.playbackByte,
      inflight: busy,
      peers: this._peerViews(ctx.slot),
    });

    for (const { peerId, index } of assignments) {
      const peer = this.peers.get(peerId);
      if (!peer || peer.ctrl?.readyState !== 'open') continue;

      const len = chunkLengthAt(index, ctx.manifest.size, ctx.manifest.chunkSize);
      const key = keyOf(ctx.slot, index);
      ctx.assembler.expect(index, len);
      this.inflight.set(key, { peerId, at: performance.now(), slot: ctx.slot, index });
      peer.inflight.add(key);
      peer.send({ t: MSG.REQUEST, s: ctx.slot, index });
    }
  }

  /**
   * 一个请求等多久才算废。
   *
   * 固定 20 秒对跨境链路太长了：丢掉一条 REQUEST，这个槽位就空转 20 秒 ——
   * 四选一的窗口等于凭空少了四分之一吞吐，而且关键窗口里的那一片迟到 20 秒
   * 足够让全员暂停触发一次。按对方的往返延迟和实测速率估「这片本来该多久到」，
   * 再留三倍余量。测不出速率（刚连上、或者对方一直没吐东西）就退回 20 秒。
   */
  _requestTimeout(peer, chunkSize) {
    const rtt = peer?.rtt > 0 ? peer.rtt : 0;
    const rate = peer?.downRate > 0 ? peer.downRate : 0;
    if (!rtt || !rate || !chunkSize) return 20000;
    // 他手上欠我的片是排队发的，最后一片要等前面都发完。
    const queued = Math.max(1, peer.inflight?.size || 1);
    const expected = rtt + ((queued * chunkSize) / rate) * 1000;
    // 上限不能一刀切在 20 秒：窗口放深之后（跨境链路会涨到 12 片），慢链路上
    // expected 本身就可能超过 20 秒，那样队尾那片必然在能到达之前就被判超时，
    // 于是无限重派、永远收不齐。上限至少要给到期望送达时间本身留出余量。
    const ceiling = Math.max(20000, expected * 1.5 + 2000);
    return Math.max(6000, Math.min(ceiling, expected * 3 + 2000));
  }

  /** 要了半天不给的片，超时收回重新分配。对面可能网卡了或者悄悄挂了。 */
  _expireStale() {
    const now = performance.now();
    for (const [key, info] of this.inflight) {
      const peer = this.peers.get(info.peerId);
      const ctx = this.files.get(info.slot);
      if (now - info.at < this._requestTimeout(peer, ctx?.manifest.chunkSize)) continue;
      this.inflight.delete(key);
      ctx?.assembler.drop(info.index);
      if (peer) {
        peer.inflight.delete(key);
        // 告诉他别发了：他那边的队列里还排着这一条，不撤的话会越攒越多
        peer.send({ t: MSG.CANCEL, s: info.slot, index: info.index });
      }
    }
  }

  /** 撤回某个槽位的全部在途请求。 */
  _cancelInflight(slot) {
    const ctx = this.files.get(slot);
    for (const [key, info] of this.inflight) {
      if (info.slot !== slot) continue;
      const peer = this.peers.get(info.peerId);
      peer?.send({ t: MSG.CANCEL, s: slot, index: info.index });
      peer?.inflight.delete(key);
      this.inflight.delete(key);
      ctx?.assembler.drop(info.index);
    }
  }

  destroy() {
    this.stop();
    for (const p of [...this.peers.values()]) p.close();
    this.peers.clear();
    for (const ctx of this.files.values()) {
      ctx.assembler.clear();
      ctx.writing.clear();
    }
    this.files.clear();
    this.inflight.clear();
    this._peerState.clear();
    this._priorityServing.clear();
    for (const w of this._manifestWaiters.values()) {
      clearTimeout(w.timer);
      w.reject(new Error('房间已关闭'));
    }
    this._manifestWaiters.clear();
    this.removeAll();
  }
}
