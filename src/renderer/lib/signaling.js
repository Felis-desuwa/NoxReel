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

const LEGACY_PREFIX = 'SW1-';
const SW2_PREFIX = 'SW2-';
const NR2_PREFIX = 'NR2-';
const CODE_PREFIX = 'NR3-';
const MAX_CODE_LENGTH = 256 * 1024;

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

function packFile(file) {
  return file ? [String(file.name || ''), Number(file.size) || 0, file.kind === 'link' ? 'l' : 'f'] : 0;
}

function packSecurityMode(mode) {
  return mode === 'trusted' ? 't' : 's';
}

function expandSecurityMode(mode) {
  // 旧邀请码没有该字段，必须按安全模式处理，不能静默降级到可信模式。
  return mode === 't' || mode === 'trusted' ? 'trusted' : 'safe';
}

/** SW2 用定长数组代替重复的 JSON 键；房间可切片后，信令短码不再绑定片名。 */
function sdpText(value) {
  return typeof value === 'string' ? value : String(value?.sdp || '');
}

function compactPayload(payload) {
  if (payload?.k === 'room') {
    return ['r', payload.url, payload.room, payload.from, Number(payload.maxMembers) || 0, packSecurityMode(payload.securityMode)];
  }
  if (payload?.k === 'offer') {
    // NR3 不再重复携带 type、昵称和片名；昵称会在加密数据通道的 HELLO 中发送，
    // 视频信息则在握手后发送。SDP 仍完整保留，避免破坏 NAT 打洞。
    return ['o', payload.from, sdpText(payload.sdp), Number(payload.maxMembers) || 0, packSecurityMode(payload.securityMode)];
  }
  if (payload?.k === 'answer') {
    return ['a', payload.from, sdpText(payload.sdp), packSecurityMode(payload.securityMode)];
  }
  return payload;
}

function expandPayload(value, version = 3) {
  if (!Array.isArray(value)) {
    if (value && ['room', 'offer', 'answer'].includes(value.k)) {
      return { ...value, securityMode: expandSecurityMode(value.securityMode) };
    }
    return value;
  }
  if (value[0] === 'r') {
    return {
      k: 'room',
      url: value[1],
      room: value[2],
      from: value[3],
      maxMembers: Number(value[4]) || 0,
      securityMode: expandSecurityMode(value[5]),
    };
  }
  if (value[0] === 'o') {
    if (version >= 3) {
      return {
        k: 'offer', from: value[1], name: '', sdp: { type: 'offer', sdp: value[2] }, file: null,
        maxMembers: Number(value[3]) || 0, securityMode: expandSecurityMode(value[4]),
      };
    }
    const f = value[4];
    return {
      k: 'offer',
      from: value[1],
      name: value[2],
      sdp: value[3],
      file: Array.isArray(f) ? { name: f[0], size: Number(f[1]) || 0, kind: f[2] === 'l' ? 'link' : 'file' } : null,
      maxMembers: Number(value[5]) || 0,
      securityMode: expandSecurityMode(value[6]),
    };
  }
  if (value[0] === 'a') {
    if (version >= 3) {
      return { k: 'answer', from: value[1], name: '', sdp: { type: 'answer', sdp: value[2] }, securityMode: expandSecurityMode(value[3]) };
    }
    return { k: 'answer', from: value[1], name: value[2], sdp: value[3], securityMode: expandSecurityMode(value[4]) };
  }
  return value;
}

/** 把握手信息打包成一段可粘贴的码；短数据不再强行加 gzip 头。 */
export async function encodeCode(payload) {
  const json = JSON.stringify(compactPayload(payload));
  const raw = new TextEncoder().encode(json);
  const zipped = await gzip(json);
  const compressed = zipped.length < raw.length;
  return CODE_PREFIX + (compressed ? 'G' : 'R') + toBase64Url(compressed ? zipped : raw);
}

export function inviteLink(code, action = 'join') {
  const kind = action === 'answer' ? 'a' : 'j';
  const compact = String(code).trim().replace(/^NR3-/, '');
  return `noxreel://${kind}/${compact}`;
}

export function unwrapInviteInput(input) {
  let value = String(input || '').trim();
  const markdown = value.match(/\((noxreel:\/\/[^)\s]+)\)/i);
  if (markdown) value = markdown[1];
  if (!/^noxreel:\/\//i.test(value)) return value;
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('NoxReel 邀请链接无效'); }
  if (!['j', 'a'].includes(parsed.hostname.toLowerCase())) throw new Error('NoxReel 邀请链接类型无效');
  const body = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!body) throw new Error('NoxReel 邀请链接不完整');
  return /^(?:NR3-|NR2-|SW2-|SW1-)/.test(body) ? body : `${CODE_PREFIX}${body}`;
}

export async function decodeCode(code) {
  const trimmed = unwrapInviteInput(code).replace(/\s+/g, '');
  if (trimmed.length > MAX_CODE_LENGTH) throw new Error('邀请码异常过长');
  const legacy = trimmed.startsWith(LEGACY_PREFIX);
  const sw2 = trimmed.startsWith(SW2_PREFIX);
  const nr2 = trimmed.startsWith(NR2_PREFIX);
  if (!legacy && !sw2 && !nr2 && !trimmed.startsWith(CODE_PREFIX)) throw new Error('这不像是一个 NoxReel 邀请码');
  const prefix = legacy ? LEGACY_PREFIX : sw2 ? SW2_PREFIX : nr2 ? NR2_PREFIX : CODE_PREFIX;
  const body = trimmed.slice(prefix.length);
  let json;
  try {
    if (legacy) json = await gunzip(fromBase64Url(body));
    else {
      const mode = body[0];
      const bytes = fromBase64Url(body.slice(1));
      if (mode === 'G') json = await gunzip(bytes);
      else if (mode === 'R') json = new TextDecoder().decode(bytes);
      else throw new Error('unknown mode');
    }
  } catch {
    throw new Error('邀请码损坏或不完整 —— 复制的时候可能漏了一截');
  }
  try {
    return expandPayload(JSON.parse(json), prefix === CODE_PREFIX ? 3 : 2);
  } catch {
    throw new Error('邀请码内容无法解析');
  }
}

/**
 * WebSocket 信令客户端。
 * 服务器只做房间内的消息转发，看不到也存不下视频内容。
 */
export class WsSignaling extends Emitter {
  constructor({ url, roomId, peerId, name, maxMembers = 0 }) {
    super();
    this.url = url;
    this.roomId = roomId;
    this.peerId = peerId;
    this.name = name;
    this.maxMembers = Number(maxMembers) || 0;
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
        this._send({
          t: 'join',
          roomId: this.roomId,
          peerId: this.peerId,
          name: this.name,
          maxMembers: this.maxMembers,
        });
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

  setMaxMembers(maxMembers) {
    this.maxMembers = Number(maxMembers) || this.maxMembers;
    this._send({ t: 'room-config', maxMembers: this.maxMembers });
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
