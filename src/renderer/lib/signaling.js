import { Emitter } from './emitter.js';

/**
 * 两种节点发现方式。
 *
 * 1) 极简模式（manual）：把 SDP 压缩成一段文本，用户自己复制粘贴。零服务器参与。
 *    SDP 原文 3-5KB，gzip 后约 800 字节，base64url 后约 1.1KB —— 粘贴条略长但可用。
 *
 * 2) 信令服务器（ws）：只转发连接元数据（SDP/ICE），不接触任何视频内容。
 *
 * 两者都不落地视频内容，符合「只接受零内容服务器」的原则。
 */

const CODE_PREFIX = 'SW1-';

async function gzip(str) {
  const cs = new CompressionStream('gzip');
  const stream = new Blob([new TextEncoder().encode(str)]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes) {
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

function toBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** 把握手信息打包成一段可粘贴的码。 */
export async function encodeCode(payload) {
  return CODE_PREFIX + toBase64Url(await gzip(JSON.stringify(payload)));
}

export async function decodeCode(code) {
  const trimmed = String(code).trim().replace(/\s+/g, '');
  if (!trimmed.startsWith(CODE_PREFIX)) throw new Error('这不像是一个 SyncWatch 邀请码');
  const body = trimmed.slice(CODE_PREFIX.length);
  let json;
  try {
    json = await gunzip(fromBase64Url(body));
  } catch {
    throw new Error('邀请码损坏或不完整 —— 复制的时候可能漏了一截');
  }
  try {
    return JSON.parse(json);
  } catch {
    throw new Error('邀请码内容无法解析');
  }
}

/**
 * WebSocket 信令客户端。
 * 服务器只做房间内的消息转发，看不到也存不下视频内容。
 */
export class WsSignaling extends Emitter {
  constructor({ url, roomId, peerId, name }) {
    super();
    this.url = url;
    this.roomId = roomId;
    this.peerId = peerId;
    this.name = name;
    this.ws = null;
    this.connected = false;
    this._retry = 0;
    this._closedByUs = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        this.ws = new WebSocket(this.url);
      } catch (e) {
        return reject(new Error(`信令地址无效：${e.message}`));
      }

      this.ws.onopen = () => {
        this.connected = true;
        this._retry = 0;
        this._send({ t: 'join', roomId: this.roomId, peerId: this.peerId, name: this.name });
      };

      this.ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }

        if (msg.t === 'joined') {
          if (!settled) {
            settled = true;
            resolve(msg);
          }
          this.emit('joined', msg);
          return;
        }
        if (msg.t === 'error') {
          const err = new Error(msg.message || '信令服务器拒绝了连接');
          err.code = msg.code;
          if (!settled) {
            settled = true;
            reject(err);
          }
          this.emit('error', err);
          return;
        }
        this.emit(msg.t, msg);
      };

      this.ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error(`连不上信令服务器：${this.url}`));
        }
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.emit('disconnected');
        if (!this._closedByUs && settled) this._scheduleReconnect();
      };
    });
  }

  /** 信令断了不该拆掉已经建好的 P2P 连接 —— 那些是直连，不经过服务器。 */
  _scheduleReconnect() {
    const delay = Math.min(30000, 1000 * 2 ** this._retry++);
    this.emit('reconnecting', { in: delay });
    setTimeout(() => {
      if (!this._closedByUs) this.connect().catch(() => {});
    }, delay);
  }

  _send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  signal(to, payload) {
    this._send({ t: 'signal', to, from: this.peerId, payload });
  }

  close() {
    this._closedByUs = true;
    this.ws?.close();
  }
}

export function randomRoomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return toBase64Url(bytes);
}

export function randomPeerId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return toBase64Url(bytes);
}
