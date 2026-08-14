/**
 * 线缆协议。
 *
 * 每个 peer 之间开两条 DataChannel：
 *  - 'ctrl'：JSON 文本，可靠有序。握手、清单、位图、请求、同步指令都走这。
 *  - 'data'：二进制，可靠有序。只跑分片内容。
 * 分开是因为控制消息不能被几十 MB 的分片数据堵在队尾 —— 「全员暂停」这种指令
 * 恰恰是在缓冲吃紧、数据通道最满的时候发出的，堵住就失去意义了。
 *
 * SCTP 单条消息有大小上限（Chromium 上安全值是 64KB），所以 2MB 的分片
 * 要切成帧发。帧头 8 字节：分片下标 + 帧下标。
 * 收方靠清单能自己算出每片有几帧，不用额外元数据。
 */

export const PROTOCOL_VERSION = 1;

export const FRAME_HEADER_BYTES = 8;
export const FRAME_PAYLOAD_BYTES = 60 * 1024; // 60KB，留足余量避开 64KB 上限

/** 背压水位：缓冲超过 HIGH 就停发，回落到 LOW 再继续。 */
export const BUFFER_HIGH_WATER = 4 * 1024 * 1024;
export const BUFFER_LOW_WATER = 1 * 1024 * 1024;

export const MSG = {
  HELLO: 'hello',
  MANIFEST: 'manifest',
  MANIFEST_START: 'manifest-start',
  MANIFEST_PART: 'manifest-part',
  BITFIELD: 'bitfield',
  HAVE: 'have',
  REQUEST: 'request',
  CANCEL: 'cancel',
  DENY: 'deny',
  SYNC: 'sync',
  STALL: 'stall',
  ROLE: 'role',
  MEDIA_LINK: 'media-link',
  CHAT: 'chat',
  PING: 'ping',
  PONG: 'pong',
};

export function framesPerChunk(chunkLength) {
  return Math.ceil(chunkLength / FRAME_PAYLOAD_BYTES);
}

export function chunkLengthAt(index, size, chunkSize) {
  return Math.min(chunkSize, size - index * chunkSize);
}

/** 把一个分片切成若干帧。 */
export function encodeFrames(chunkIndex, buffer) {
  const bytes = new Uint8Array(buffer);
  const total = Math.max(1, Math.ceil(bytes.length / FRAME_PAYLOAD_BYTES));
  const out = [];
  for (let f = 0; f < total; f++) {
    const start = f * FRAME_PAYLOAD_BYTES;
    const slice = bytes.subarray(start, Math.min(start + FRAME_PAYLOAD_BYTES, bytes.length));
    const frame = new Uint8Array(FRAME_HEADER_BYTES + slice.length);
    const view = new DataView(frame.buffer);
    view.setUint32(0, chunkIndex, false);
    view.setUint32(4, f, false);
    frame.set(slice, FRAME_HEADER_BYTES);
    out.push(frame);
  }
  return out;
}

export function decodeFrame(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < FRAME_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    chunkIndex: view.getUint32(0, false),
    frameIndex: view.getUint32(4, false),
    payload: bytes.subarray(FRAME_HEADER_BYTES),
  };
}

/** 把分散到达的帧拼回完整分片，齐了就吐出来。 */
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
  const bin = atob(b64);
  const have = new Uint8Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    const byte = bin.charCodeAt(i >> 3) || 0;
    have[i] = (byte >> (7 - (i & 7))) & 1;
  }
  return have;
}

export function packBitfield(have) {
  const bytes = new Uint8Array(Math.ceil(have.length / 8));
  for (let i = 0; i < have.length; i++) {
    if (have[i]) bytes[i >> 3] |= 0x80 >> (i & 7);
  }
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
