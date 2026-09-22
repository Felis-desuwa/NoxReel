import { Emitter } from './emitter.js';
import { PROTOCOL_VERSION } from './protocol.js';

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
// 粘贴框、深链接交进来的整段文本的上限。码本身最长 MAX_CODE_LENGTH，前后再带点聊天里的话；
// 超过这个量的输入不可能是正常的邀请，直接拒掉，不去跑下面那一串正则。
const MAX_INPUT_LENGTH = 1024 * 1024;
// 解压后的上限。正常的码解开是几 KB 的 JSON（SDP 占大头）；而 gzip 的压缩比能到一千倍，
// 256KB 的码能解出两百多 MB —— 不设上限，一条恶意邀请粘进来就能把界面卡死、内存撑爆。
const MAX_DECODED_BYTES = 1024 * 1024;

function tooLong() {
  const err = new Error('邀请码异常过长');
  err.code = 'TOO_LONG';
  return err;
}

async function gzip(str) {
  const cs = new CompressionStream('gzip');
  const stream = new Blob([new TextEncoder().encode(str)]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 边解边数，超过 MAX_DECODED_BYTES 立刻停下，不把整块解压结果先堆进内存。 */
async function gunzip(bytes) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DECODED_BYTES) {
      reader.cancel().catch(() => {});
      throw tooLong();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(out);
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
  // 旧邀请码没有该字段，必须按安全模式处理，不能静默降级到可信模式。
  return mode === 't' || mode === 'trusted' ? 'trusted' : 'safe';
}

/**
 * 码里末尾追加的协议版本号。0.6 的解码只按下标取前几项，多出来的尾巴会被忽略，
 * 所以旧码没有这一项 —— 缺省就是 1。版本不一致的两端在数据通道上也会被 HELLO 拦下，
 * 这里提前一步，是为了在粘贴码的那一刻就能说清楚「对方是旧版」。
 */
function expandVersion(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : 1;
}

/** SW2 用定长数组代替重复的 JSON 键；房间可切片后，信令短码不再绑定片名。 */
function sdpText(value) {
  return typeof value === 'string' ? value : String(value?.sdp || '');
}

function compactPayload(payload) {
  if (payload?.k === 'room') {
    return ['r', payload.url, payload.room, payload.from, Number(payload.maxMembers) || 0, packSecurityMode(payload.securityMode), PROTOCOL_VERSION];
  }
  if (payload?.k === 'offer') {
    // NR3 不再重复携带 type、昵称和片名；昵称会在加密数据通道的 HELLO 中发送，
    // 视频信息则在握手后发送。SDP 仍完整保留，避免破坏 NAT 打洞。
    return ['o', payload.from, sdpText(payload.sdp), Number(payload.maxMembers) || 0, packSecurityMode(payload.securityMode), PROTOCOL_VERSION];
  }
  if (payload?.k === 'answer') {
    return ['a', payload.from, sdpText(payload.sdp), packSecurityMode(payload.securityMode), PROTOCOL_VERSION];
  }
  if (payload?.k === 'relay') {
    // 房间链接（经公共中继）：房间密钥、房主签名公钥、房主 peerId。中继列表只有房主改过才带。
    const relays = Array.isArray(payload.relays) && payload.relays.length ? payload.relays : 0;
    return ['l', payload.key, payload.hk, payload.from, Number(payload.maxMembers) || 0, packSecurityMode(payload.securityMode), relays, PROTOCOL_VERSION];
  }
  return payload;
}

function expandPayload(value, version = 3) {
  if (!Array.isArray(value)) {
    if (value && ['room', 'offer', 'answer'].includes(value.k)) {
      return { ...value, securityMode: expandSecurityMode(value.securityMode), protocolVersion: 1 };
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
      protocolVersion: expandVersion(value[6]),
    };
  }
  if (value[0] === 'l') {
    return {
      k: 'relay',
      key: String(value[1] || ''),
      hk: String(value[2] || ''),
      from: value[3],
      maxMembers: Number(value[4]) || 0,
      securityMode: expandSecurityMode(value[5]),
      relays: Array.isArray(value[6]) ? value[6].filter((u) => typeof u === 'string').slice(0, 12) : null,
      protocolVersion: expandVersion(value[7]),
    };
  }
  if (value[0] === 'o') {
    if (version >= 3) {
      return {
        k: 'offer', from: value[1], name: '', sdp: { type: 'offer', sdp: value[2] }, file: null,
        maxMembers: Number(value[3]) || 0, securityMode: expandSecurityMode(value[4]),
        protocolVersion: expandVersion(value[5]),
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
      protocolVersion: 1,
    };
  }
  if (value[0] === 'a') {
    if (version >= 3) {
      return {
        k: 'answer', from: value[1], name: '', sdp: { type: 'answer', sdp: value[2] },
        securityMode: expandSecurityMode(value[3]), protocolVersion: expandVersion(value[4]),
      };
    }
    return { k: 'answer', from: value[1], name: value[2], sdp: value[3], securityMode: expandSecurityMode(value[4]), protocolVersion: 1 };
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

/**
 * 发到聊天里的形式：一个 https 跳转页，Discord 这类聊天软件才会把它变成能点的链接
 * （它们不认 noxreel:// 这种自定义协议）。跳转页再把人送回 noxreel://。
 *
 * 邀请放在 # 后面：浏览器从不把 # 后面的内容发给服务器，所以跳转页只是一张静态页，
 * 看不到、也存不下任何握手信息。
 *
 * 末尾的 '/' 是结束符。Discord 生成可点链接时会把结尾的 . , : ; 这类标点切出去，
 * 而 '.' 恰好是码的字母表成员 —— 码尾是 '.' 的时候，点开的链接就少一个字符。
 * （眼下的码碰巧不会以 '.' 结尾：gzip 末尾是原文长度、高位全 0，R 码以 ']' 收尾；
 * 结束符防的是以后任何一种码。）
 */
export const SHARE_BASE = 'https://felis-desuwa.github.io/NoxReel/';

export function shareLink(code, action = 'join') {
  const kind = action === 'answer' ? 'a' : 'j';
  const compact = String(code).trim().replace(/^NR3-/, '');
  return `${SHARE_BASE}#${kind}/${compact}/`;
}

// 正文字符集要同时容得下新旧两套字母表：'.' 是现在用的，'_' 是旧版本发出来的码里的。
// '%' 也放进来，好接住某些客户端会把链接百分号编码一遍的情况。
const BODY_CHARS = '[A-Za-z0-9._%-]';
const LINK_RE = new RegExp(`noxreel://([jaJA])/(${BODY_CHARS}+)`, 'i');
// https 形式不绑死域名：将来跳转页换了地址，旧版本发出去的链接照样能贴进来。
// 只认 https://…#j/… 或 #a/… 这一种形状，正文后面的 '/' 结束符不在字母表里，自然截断。
const WEB_HASH_RE = new RegExp(`#([jaJA])/(${BODY_CHARS}+)`, 'g');
// 网址里不会出现、用来给「http(s):// 到 # 之间那一段」划界的字符（空白在这之前已经剥光了）
const URL_STOP = '#<>"\'`';
const BARE_RE = new RegExp(`(?:NR3|NR2|SW2|SW1)-${BODY_CHARS}+`);

/**
 * 找 https://…#j/正文 这种链接，等价于 /https?:\/\/[^\s#<>"'`]+#([jaJA])\/(正文+)/i。
 *
 * 原来就是写成这条正则的。可输入里的空白已经全部剥掉，一长串「http://http://…」里每个
 * http:// 都会一路扫到末尾找 #、再逐字回溯 —— 平方级，几百 KB 的输入能把界面卡上好几秒。
 * 这里反过来：先找 #j/、#a/，再往回看它前面那一段（到上一个划界字符为止）里有没有
 * http(s)://，每个字符只看一遍。
 */
function findWebLink(text) {
  for (const hit of text.matchAll(WEB_HASH_RE)) {
    let start = hit.index;
    while (start > 0 && !URL_STOP.includes(text[start - 1])) start--;
    if (/https?:\/\/./i.test(text.slice(start, hit.index))) return hit;
  }
  return null;
}

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
  const raw = String(input || '');
  if (raw.length > MAX_INPUT_LENGTH) throw tooLong();
  const cleaned = raw
    .replace(INVISIBLE_RE, '')
    // 邮件/聊天软件的引用前缀。'>' 不在码的字母表里，留着会把折行的码从中间截断。
    .replace(/^[ \t]*>+[ \t]?/gm, '');
  // 空白必须先在**每一段之内**剥掉（对付邮件的 78 列折行），而不是把整段输入
  // 拼成一条长串再搜 —— BARE_RE 是贪婪的、字母数字又都在码的字母表里，
  // 「NR3-xxxx thanks」拼起来之后 thanks 会被整个吞进码体，解不开。
  // 中文闲话不受影响（汉字不在字母表里），所以原来的测试没发现。
  const text = cleaned.replace(/\s+/g, '');
  const segments = cleaned.split(/\s+/).filter(Boolean);

  const link = LINK_RE.exec(text) || findWebLink(text);
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
  if (bare) {
    // 「折行的续段」和「码后面跟的一个英文单词」在结构上一模一样，
    // 都是「码样的一段 + 空白 + 另一段」，纯语法分不开。只能按词形区分：
    // 续段是 gzip 后的均匀随机字节，一段十几个字符全是小写字母的概率约百万分之一；
    // 而 thanks / ok / cheers 这类尾巴恰恰就是那个样子。
    let perSegment = null;
    for (const seg of segments) {
      const hit = BARE_RE.exec(seg);
      if (hit) {
        perSegment = hit[0];
        break;
      }
    }
    if (perSegment && bare[0].length > perSegment.length) {
      const tail = bare[0].slice(perSegment.length);
      if (/^(?:[a-z]{1,16}|[A-Z][a-z]{0,15})$/.test(tail)) return perSegment;
    }
    return bare[0];
  }

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
  } catch (first) {
    if (first?.code === 'TOO_LONG') throw first;
    // '.' 既是字母表成员，也可能是句尾的那个句号 —— 提取的时候分不清。
    // 头一次解不开就把尾部的点削掉再试一次，别为了一个标点让人重新要一份码。
    const stripped = body.replace(/\.+$/, '');
    try {
      if (!stripped || stripped === body) throw new Error('nothing to strip');
      json = await unpack(prefix, stripped);
    } catch (second) {
      if (second?.code === 'TOO_LONG') throw second;
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
    this._joinedOnce = false; // 曾经真的进过房吗。只有进过才值得自动重连
    this._closedByUs = false;
    // 房主续期凭据。服务器只在房主自己的 joined 里发它，重连时带上才能拿回房主身份 ——
    // 不然 HOST_ID_RESERVED 会把掉线重连的房主本人也挡在门外，之后再也收不到 peer-join。
    // 只放在这个实例里：不交给调用方、不进邀请码、不广播。
    this._hostToken = null;
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
        // 退避计数不能在这里清零。WS 握手成功不代表加入成功 —— 「连得上但 join 被拒」
        // （房间满、peerId 被占、地区拦截）每一轮都会把退避重置回 1 秒，
        // 指数退避形同虚设，变成每秒一次的重连风暴。真正加入成功才算数，见 joined 分支。
        this._send({
          t: 'join',
          roomId: this.roomId,
          peerId: this.peerId,
          name: this.name,
          maxMembers: this.maxMembers,
          ...(this._hostToken ? { hostToken: this._hostToken } : {}),
        });
      };

      this.ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        // 服务器是用户自己填的地址：null、数组、数字都可能收到，读 msg.t 之前先挡掉
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;

        if (msg.t === 'joined') {
          this._retry = 0; // 真正进房了，退避才该归零
          this._joinedOnce = true;
          // 每次进房都以服务器这次的答复为准：房间被重建、自己不再是房主时它就没有这一项
          const { hostToken, ...joined } = msg;
          this._hostToken = typeof hostToken === 'string' && hostToken ? hostToken : null;
          if (!settled) {
            settled = true;
            resolve(joined);
          }
          this.emit('joined', joined);
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
        // open 之后、joined 之前被对端正常关闭时，浏览器只触发 close 不触发 error，
        // connect() 返回的 Promise 会永远悬着 —— 调用方停在「正在连接信令服务器…」。
        if (!settled) {
          settled = true;
          reject(new Error(`信令服务器关闭了连接：${this.url}`));
          return; // 首连就没成，别自作主张开始后台重连
        }
        // 只有「曾经真的进过房」才自动重连。原来用 settled 判断，而 reject 路径
        // 也会把它置真，于是首连失败（调用方已经放弃）之后照样进入无限重连，
        // 留下一条谁也不知道的僵尸连接。
        if (!this._closedByUs && this._joinedOnce) this._scheduleReconnect();
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
