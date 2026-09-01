import { Emitter } from './emitter.js';

/**
 * 两种节点发现方式。
 *
 * 1) 极简模式（manual）：把 SDP 压缩成一段文本，用户自己复制粘贴。零服务器参与。
 *    SDP 原文 3-5KB，gzip 后约 800 字节，base64 后约 1.1KB —— 粘贴条略长但可用。
 *    字母表刻意避开了 markdown 敏感字符，见 toChatSafeBase64()。
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

// 零宽字符和软连字符都不算 \s，剥空白剥不掉它们，会一路混进 base64 正文直到 atob 才炸。
// 网页复制、聊天软件和部分输入法都可能顺手塞进来，所以在最前面单独清一遍。
const INVISIBLE_RE = /[\u00AD\u200B-\u200F\u2060\uFEFF]/g;

/**
 * base64 的第 63、64 个字符用 '-' 和 '.'，而不是 base64url 惯用的 '-' 和 '_'。
 *
 * 因为 Discord 的 markdown 会把 __双下划线__ 渲染成下划线文本，并且**从可复制的文本里
 * 把那两对下划线删掉**；闭合下划线正好落在 '-' 或串尾时，_单下划线_ 的斜体规则也会吃掉两个。
 * 邀请码是均匀随机的 gzip 字节，100% 含 '_'，实测被改坏的比例随码长从 9% 一路升到 75%
 * （常见家用机 15%，装了 WSL/VPN 或开了 IPv6 的机器 30% 以上）。收到的人只会看到一句
 * 「邀请码损坏」，而他复制得一个字符都没错。
 *
 * '-' 和 '.' 是 RFC 3986 unreserved 集合里仅有的、markdown 同时也不敏感的一对：
 * 另外两个 unreserved 字符 '_' 和 '~' 分别被 __下划线__ 和 ~~删除线~~ 占着。
 * 选 unreserved 还有一层好处 —— 任何 URL 规范化都不会把它们百分号编码掉。
 */
function toChatSafeBase64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '.').replace(/=+$/, '');
}

/**
 * 解码时 '_' 和 '.' 一视同仁，都还原成 '/'。
 *
 * 这样旧版本发出来的 base64url 邀请码在新版本上照常能解 —— 两套字母表只差第 64 个字符，
 * 收方同时认这两个即可，不需要给邀请码另起一个版本前缀。NR3 的载荷结构一个字节都没变，
 * 变的只是同一份字节的字符表示，所以这里是把 NR3 的可接受范围放宽，而不是改掉它。
 */
function fromChatSafeBase64(s) {
  const b64 = s.replace(/-/g, '+').replace(/[._]/g, '/');
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
  return mode === 't' || mode === 'trusted' ? 'trusted' : 'safe';
}

/** SW2 用定长数组代替重复的 JSON 键；房间可切片后，信令短码不再绑定片名。 */
function sdpText(value) {
  return typeof value === 'string' ? value : String(value?.sdp || '');
}

function compactPayload(payload) {
  if (payload?.k === 'room') return ['r', payload.url, payload.room, payload.from, Number(payload.maxMembers) || 0, packSecurityMode(payload.securityMode)];
  if (payload?.k === 'offer') return ['o', payload.from, sdpText(payload.sdp), Number(payload.maxMembers) || 0, packSecurityMode(payload.securityMode)];
  if (payload?.k === 'answer') return ['a', payload.from, sdpText(payload.sdp), packSecurityMode(payload.securityMode)];
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
    return { k: 'room', url: value[1], room: value[2], from: value[3], maxMembers: Number(value[4]) || 0, securityMode: expandSecurityMode(value[5]) };
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
    if (version >= 3) return { k: 'answer', from: value[1], name: '', sdp: { type: 'answer', sdp: value[2] }, securityMode: expandSecurityMode(value[3]) };
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
  return CODE_PREFIX + (compressed ? 'G' : 'R') + toChatSafeBase64(compressed ? zipped : raw);
}

export function inviteLink(code, action = 'join') {
  const kind = action === 'answer' ? 'a' : 'j';
  const compact = String(code).trim().replace(/^NR3-/, '');
  return `noxreel://${kind}/${compact}`;
}

// 正文字符集要同时容得下新旧两套字母表：'.' 是现在用的，'_' 是旧版本发出来的码里的。
// '%' 也放进来，好接住某些客户端会把链接百分号编码一遍的情况。
const BODY_CHARS = '[A-Za-z0-9._%-]';
const LINK_RE = new RegExp(`noxreel://([jaJA])/(${BODY_CHARS}+)`, 'i');
const BARE_RE = new RegExp(`(?:NR3|NR2|SW2|SW1)-${BODY_CHARS}+`);

/**
 * 从一段文本里把邀请码找出来。
 *
 * 以前这里是「整条输入必须正好是一个码」的锚定判断，于是聊天里最自然的那些贴法全军覆没：
 * 反引号包起来的行内代码、Discord 抑制预览用的 <链接>、中文引号书名号、
 * 「邀请码：」这样的前缀、句尾的句号、邮件回复的 '> ' 引用前缀 —— 一律报
 * 「这不像是一个 NoxReel 邀请码」。更糟的是只在尾部多一个字符时前缀检查能过，
 * 错误会落到后面变成「复制的时候可能漏了一截」，把方向说反：明明是多了东西。
 *
 * 现在改成「搜」而不是「比」。顺序上先剥不可见字符、再剥全部空白（邮件按 78 列折行的码
 * 靠这一步救回来），最后才在剩下的文本里找码。
 */
export function unwrapInviteInput(input) {
  const text = String(input || '')
    .replace(INVISIBLE_RE, '')
    .replace(/\s+/g, '');

  const link = LINK_RE.exec(text);
  if (link) {
    let body = link[2];
    if (body.includes('%')) {
      // 百分号解码失败不该把原生的英文 URIError 甩到中文界面上，解不动就按原样用。
      try {
        body = decodeURIComponent(body);
      } catch {
        body = body.replace(/%/g, '');
      }
    }
    if (!body) throw new Error('NoxReel 邀请链接不完整');
    return /^(?:NR3-|NR2-|SW2-|SW1-)/.test(body) ? body : `${CODE_PREFIX}${body}`;
  }

  const bare = BARE_RE.exec(text);
  if (bare) return bare[0];

  // 找不到就把清洗过的整串交回去，让 decodeCode 给出原来那句「这不像是一个 NoxReel 邀请码」。
  return text;
}

async function unpack(prefix, body) {
  if (prefix === LEGACY_PREFIX) return gunzip(fromChatSafeBase64(body));
  const mode = body[0];
  const bytes = fromChatSafeBase64(body.slice(1));
  if (mode === 'G') return gunzip(bytes);
  if (mode === 'R') return new TextDecoder().decode(bytes);
  throw new Error('unknown mode');
}

export async function decodeCode(code) {
  const trimmed = unwrapInviteInput(code);
  if (trimmed.length > MAX_CODE_LENGTH) throw new Error('邀请码异常过长');
  const legacy = trimmed.startsWith(LEGACY_PREFIX);
  const sw2 = trimmed.startsWith(SW2_PREFIX);
  const nr2 = trimmed.startsWith(NR2_PREFIX);
  if (!legacy && !sw2 && !nr2 && !trimmed.startsWith(CODE_PREFIX)) throw new Error('这不像是一个 NoxReel 邀请码');
  const prefix = legacy ? LEGACY_PREFIX : sw2 ? SW2_PREFIX : nr2 ? NR2_PREFIX : CODE_PREFIX;
  const body = trimmed.slice(prefix.length);

  let json;
  try {
    json = await unpack(prefix, body);
  } catch {
    // '.' 既是字母表成员，也可能是句尾的那个句号 —— 提取的时候分不清。
    // 头一次解不开就把尾部的点削掉再试一次，别为了一个标点让人重新要一份码。
    const stripped = body.replace(/\.+$/, '');
    try {
      if (!stripped || stripped === body) throw new Error('nothing to strip');
      json = await unpack(prefix, stripped);
    } catch {
      throw new Error(
        '邀请码损坏或不完整 —— 可能是复制时漏了一截，也可能是被聊天软件的格式化改掉了字符；把码放进反引号里再发一次通常能解决'
      );
    }
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
  return toChatSafeBase64(bytes);
}

export function randomPeerId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return toChatSafeBase64(bytes);
}
