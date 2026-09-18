/**
 * 线缆协议。
 *
 * 每个 peer 之间开两条 DataChannel：
 *  - 'ctrl'：JSON 文本，可靠有序。握手、清单、位图、请求、同步指令、播放列表、聊天都走这。
 *  - 'data'：二进制，可靠有序。只跑分片内容。
 * 分开是因为控制消息不能被几十 MB 的分片数据堵在队尾 —— 「全员暂停」这种指令
 * 恰恰是在缓冲吃紧、数据通道最满的时候发出的，堵住就失去意义了。
 *
 * SCTP 单条消息有大小上限（Chromium 上安全值是 64KB），所以 2MB 的分片
 * 要切成帧发。帧头 12 字节：文件槽位 + 分片下标 + 帧下标。
 * 收方靠清单能自己算出每片有几帧，不用额外元数据。
 *
 * ── v2（0.7）──
 * 一个房间可以有一整张播放列表，几部片的传输状态要同时存在：暂停第一部、先传第二部，
 * 回头再接着传第一部。所以凡是指向某一片的消息都带上文件槽位 s（房主在列表里按 fileId
 * 分配的小整数），数据帧头也加了槽位。和 0.6 不互通：HELLO 里的 ver 对不上就断开。
 */

export const PROTOCOL_VERSION = 2;

export const FRAME_HEADER_BYTES = 12;
export const FRAME_PAYLOAD_BYTES = 60 * 1024; // 60KB，留足余量避开 64KB 上限
export const MAX_SLOT = 0xffffffff;

/** 背压水位：缓冲超过 HIGH 就停发，回落到 LOW 再继续。 */
export const BUFFER_HIGH_WATER = 4 * 1024 * 1024;
export const BUFFER_LOW_WATER = 1 * 1024 * 1024;

export const MSG = {
  HELLO: 'hello',
  MANIFEST: 'manifest',
  MANIFEST_START: 'manifest-start',
  MANIFEST_PART: 'manifest-part',
  MANIFEST_GET: 'manifest-get',
  BITFIELD: 'bitfield',
  HAVE: 'have',
  REQUEST: 'request',
  CANCEL: 'cancel',
  DENY: 'deny',
  SYNC: 'sync',
  STALL: 'stall',
  ROLE: 'role',
  READY: 'ready',
  PLAYLIST: 'playlist',
  PLAYLIST_OP: 'playlist-op',
  PLAYLIST_ACK: 'playlist-ack',
  NOW_LINK: 'now-link',
  CHAT: 'chat',
  CHAT_HISTORY: 'chat-history',
  PART: 'part',
  PING: 'ping',
  PONG: 'pong',
};

/** 槽位是 32 位无符号整数。 */
export function isSlot(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_SLOT;
}

export function framesPerChunk(chunkLength) {
  return Math.ceil(chunkLength / FRAME_PAYLOAD_BYTES);
}

export function chunkLengthAt(index, size, chunkSize) {
  return Math.min(chunkSize, size - index * chunkSize);
}

/** 把一个分片切成若干帧。 */
export function encodeFrames(slot, chunkIndex, buffer) {
  // setUint32 遇到超范围的数会静默回绕，发出去就成了别的槽位、别的片
  if (!isSlot(slot) || !isSlot(chunkIndex)) throw new RangeError('槽位或分片下标超出范围');
  const bytes = new Uint8Array(buffer);
  const total = Math.max(1, Math.ceil(bytes.length / FRAME_PAYLOAD_BYTES));
  const out = [];
  for (let f = 0; f < total; f++) {
    const start = f * FRAME_PAYLOAD_BYTES;
    const slice = bytes.subarray(start, Math.min(start + FRAME_PAYLOAD_BYTES, bytes.length));
    const frame = new Uint8Array(FRAME_HEADER_BYTES + slice.length);
    const view = new DataView(frame.buffer);
    view.setUint32(0, slot, false);
    view.setUint32(4, chunkIndex, false);
    view.setUint32(8, f, false);
    frame.set(slice, FRAME_HEADER_BYTES);
    out.push(frame);
  }
  return out;
}

export function decodeFrame(data) {
  if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return null;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < FRAME_HEADER_BYTES || bytes.length > FRAME_HEADER_BYTES + FRAME_PAYLOAD_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    slot: view.getUint32(0, false),
    chunkIndex: view.getUint32(4, false),
    frameIndex: view.getUint32(8, false),
    payload: bytes.subarray(FRAME_HEADER_BYTES),
  };
}

/** 把分散到达的帧拼回完整分片，齐了就吐出来。每个文件槽位各用一个。 */
export class ChunkAssembler {
  constructor() {
    this.pending = new Map(); // chunkIndex -> {frames:[], got, need, length, bytes}
  }

  expect(chunkIndex, chunkLength) {
    if (this.pending.has(chunkIndex)) return;
    this.pending.set(chunkIndex, {
      frames: new Array(framesPerChunk(chunkLength)),
      got: 0,
      need: framesPerChunk(chunkLength),
      length: chunkLength,
      bytes: 0,
    });
  }

  /** @returns {Uint8Array|null} 分片齐了返回完整内容，否则 null。 */
  push(chunkIndex, frameIndex, payload) {
    const st = this.pending.get(chunkIndex);
    if (!st) return null;
    if (frameIndex >= st.need || st.frames[frameIndex]) return null; // 越界或重复帧
    const expected = Math.min(FRAME_PAYLOAD_BYTES, st.length - frameIndex * FRAME_PAYLOAD_BYTES);
    if (payload.length !== expected) return null;

    st.frames[frameIndex] = payload;
    st.got++;
    st.bytes += payload.length;
    if (st.got < st.need) return null;

    const full = new Uint8Array(st.length);
    let off = 0;
    for (const f of st.frames) {
      full.set(f, off);
      off += f.length;
    }
    this.pending.delete(chunkIndex);
    return off === st.length ? full : null;
  }

  drop(chunkIndex) {
    this.pending.delete(chunkIndex);
  }

  has(chunkIndex) {
    return this.pending.has(chunkIndex);
  }

  clear() {
    this.pending.clear();
  }
}

export function unpackBitfield(b64, chunkCount) {
  const have = new Uint8Array(chunkCount);
  const maxEncodedLength = Math.ceil(Math.ceil(chunkCount / 8) / 3) * 4 + 4;
  if (typeof b64 !== 'string' || b64.length > maxEncodedLength) return have;
  let bin;
  try {
    bin = atob(b64);
  } catch {
    return have;
  }
  for (let i = 0; i < chunkCount; i++) {
    const byte = bin.charCodeAt(i >> 3) || 0;
    have[i] = (byte >> (7 - (i & 7))) & 1;
  }
  return have;
}

/**
 * 单条位图消息最多带多少片。
 *
 * 位图原来整张一条发，片数一多就会撞上 DataChannel 单条消息 64KB 的上限：
 * 每片 1 bit、base64 再胀 4/3，大约 38 万片（约 750GB）就超了，而超限的 send()
 * 会让整条通道断掉，表现成「连着连着突然掉线」，看不出和文件大小有关。
 * 30000 字节 base64 后约 40KB，和清单分段是同一个量级。
 */
export const BITFIELD_CHUNKS_PER_PART = 240_000;

/** 打包 [start, end) 这一段位图；不传范围就是整张。 */
export function packBitfield(have, start = 0, end = have.length) {
  const count = Math.max(0, end - start);
  const bytes = new Uint8Array(Math.ceil(count / 8));
  for (let i = 0; i < count; i++) {
    if (have[start + i]) bytes[i >> 3] |= 0x80 >> (i & 7);
  }
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** 把一段位图解到 target 的 offset 处，最多写 count 片。格式不对就什么都不写。 */
export function unpackBitfieldInto(target, b64, offset, count) {
  const maxEncodedLength = Math.ceil(Math.ceil(count / 8) / 3) * 4 + 4;
  if (typeof b64 !== 'string' || b64.length > maxEncodedLength) return false;
  let bin;
  try {
    bin = atob(b64);
  } catch {
    return false;
  }
  for (let i = 0; i < count && offset + i < target.length; i++) {
    const byte = bin.charCodeAt(i >> 3) || 0;
    target[offset + i] = (byte >> (7 - (i & 7))) & 1;
  }
  return true;
}

/* -------------------------- 大消息分段（PART） -------------------------- */

/**
 * 播放列表、聊天历史这类消息可能超过 64KB（100 项 × 200 字的中文片名就够了），
 * 超限的 send() 会让整条通道断掉。所以先转 UTF-8、再 base64（纯 ASCII，膨胀率可预期），
 * 按固定字符数切片；每段外面再包一层 JSON，也远低于 64KB。
 * 上限按字节算，不按字符算 —— 一个汉字是 3 个字节。
 */
export const PART_CHARS = 45_000;
export const PART_MAX_BYTES = 1024 * 1024;
export const PART_MAX_COUNT = Math.ceil(Math.ceil(PART_MAX_BYTES / 3) * 4 / PART_CHARS);
/** 拼出来之后允许派发的内层消息。其余类型一律丢弃，免得绕过各自的校验。 */
export const PART_INNER_TYPES = new Set([MSG.PLAYLIST, MSG.CHAT_HISTORY]);

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 把一条消息切成若干 PART。超过上限直接抛错，由调用方决定怎么办。 */
export function splitLarge(message, id) {
  const bytes = new TextEncoder().encode(JSON.stringify(message));
  if (bytes.length > PART_MAX_BYTES) throw new Error('消息太大，无法分段发送');
  const b64 = bytesToBase64(bytes);
  const n = Math.max(1, Math.ceil(b64.length / PART_CHARS));
  const parts = [];
  for (let i = 0; i < n; i++) {
    parts.push({ t: MSG.PART, id, i, n, data: b64.slice(i * PART_CHARS, (i + 1) * PART_CHARS) });
  }
  return parts;
}

/** 按 id 收集分段，齐了就还原成内层消息。每个连接各用一个。 */
export class PartAssembler {
  constructor({ maxConcurrent = 4, timeoutMs = 30_000, now = () => Date.now() } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.pending = new Map(); // id -> {n, parts, got, at}
  }

  /** @returns {object|null} 拼齐且通过校验时返回内层消息 */
  push(part) {
    const { id, i, n, data } = part || {};
    if (typeof id !== 'string' || !id || id.length > 32) return null;
    if (!Number.isInteger(n) || n < 1 || n > PART_MAX_COUNT) return null;
    if (!Number.isInteger(i) || i < 0 || i >= n) return null;
    if (typeof data !== 'string' || data.length > PART_CHARS || (i < n - 1 && data.length !== PART_CHARS)) return null;

    this._expire();
    let entry = this.pending.get(id);
    if (!entry) {
      // 并发上限：挤掉最老的那条。列表快照每次变化都会整条重发，丢一条旧的不要紧。
      if (this.pending.size >= this.maxConcurrent) {
        let oldest = null;
        for (const [key, value] of this.pending) if (!oldest || value.at < oldest[1].at) oldest = [key, value];
        if (oldest) this.pending.delete(oldest[0]);
      }
      entry = { n, parts: new Array(n), got: 0, at: this.now() };
      this.pending.set(id, entry);
    }
    if (entry.n !== n || entry.parts[i] !== undefined) return null;
    entry.parts[i] = data;
    entry.got++;
    if (entry.got < n) return null;

    this.pending.delete(id);
    let inner;
    try {
      const bytes = base64ToBytes(entry.parts.join(''));
      if (bytes.length > PART_MAX_BYTES) return null;
      inner = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      return null;
    }
    if (!inner || typeof inner !== 'object' || Array.isArray(inner) || !PART_INNER_TYPES.has(inner.t)) return null;
    return inner;
  }

  _expire() {
    const now = this.now();
    for (const [id, entry] of this.pending) if (now - entry.at > this.timeoutMs) this.pending.delete(id);
  }

  clear() {
    this.pending.clear();
  }
}

/** 随机消息 id（十六进制）。 */
export function randomId(bytes = 6) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
