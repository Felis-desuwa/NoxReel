import { Emitter } from './emitter.js';
import { schnorr } from './third_party/secp256k1.js';

/**
 * 经公共 Nostr 中继交换连接握手的信令（「房间链接」）。
 *
 * 接口与 WsSignaling 一致（connect / signal / setMaxMembers / close，事件 joined / peer-join /
 * signal / peer-leave / room-config / reconnecting / error），app.js 的 connectSignaling 原样复用：
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

// 20000–29999 是 Nostr 的临时事件：中继只转发、不落盘。
export const RELAY_EVENT_KIND = 23473;
// 消息结构的版本。和 P2P 协议版本无关：这一层变了，老客户端只会等不到 welcome。
const RELAY_PROTO = 1;

const HELLO_INTERVAL_MS = 3000;
const JOIN_TIMEOUT_MS = 30000;
const CONNECT_TIMEOUT_MS = 8000;
const ALIVE_INTERVAL_MS = 30000;
const SILENT_AFTER_MS = 100000;
// 发送方时钟可能不准；超出这个范围的事件一律当重放丢掉
const MAX_SKEW_SEC = 600;
const SEEN_LIMIT = 4096;

/* ------------------------------ 编码小工具 ------------------------------ */

const enc = new TextEncoder();
const dec = new TextDecoder();

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
    if (!/^[0-9a-f]{64}$/.test(ev.pubkey) || !/^[0-9a-f]{64}$/.test(ev.id) || !/^[0-9a-f]{128}$/.test(ev.sig)) return false;
    const id = await sha256(enc.encode(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content])));
    if (toHex(id) !== ev.id) return false;
    return await schnorr.verifyAsync(fromHex(ev.sig), id, fromHex(ev.pubkey));
  } catch {
    return false;
  }
}

const safeName = (v) => String(v || '').slice(0, 40);
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

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
   * @param {typeof WebSocket} [o.WebSocketImpl]  测试注入
   * @param {object} [o.timing]  测试注入：把各种等待时间调短
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
    this._WS = o.WebSocketImpl || globalThis.WebSocket;
    this._t = {
      hello: HELLO_INTERVAL_MS,
      join: JOIN_TIMEOUT_MS,
      connect: CONNECT_TIMEOUT_MS,
      alive: ALIVE_INTERVAL_MS,
      silent: SILENT_AFTER_MS,
      sweep: 20000,
      ...(o.timing || {}),
    };
    this.key = newSigningKey();
    this.publicKey = this.key.publicKey;
    this.hostKey = this.isHost ? this.publicKey : o.hostKey;
    // 不 trickle：候选打包进 SDP，每对人只交换一次 offer 和 answer。
    // 中继上的消息可能乱序、重复、从几个中继各来一份 —— 「候选比 offer 先到被丢」、
    // 一大串候选事件撞上中继限流，这两类问题这样就都不存在了。
    this.trickle = false;
    this.connected = false;

    this._sockets = new Map(); // url -> { ws, retry, timer, open }
    this._closedByUs = false;
    this._room = null; // { topic, key }
    this._seen = new Set();
    this._seenOrder = [];
    this._joined = false;
    this._mySeq = this.isHost ? 0 : null;
    this._bindings = new Map(); // peerId -> { pubkey, name, seq, lastSeen }
    this._announced = new Set(); // 已经发过 peer-join 的 peerId
    this._members = new Map(); // 房主：peerId -> { pubkey, name, seq, lastSeen }
    this._nextSeq = 1;
    this._timers = [];
    this._pendingJoin = null; // { resolve, reject, timer }
  }

  /* ---------- 对外接口 ---------- */

  async connect() {
    this._room = await deriveRoom(this.secret);
    if (!this.isHost && !/^[0-9a-f]{64}$/.test(String(this.hostKey || ''))) {
      throw relayError('房间链接里的房主公钥不对', 'BAD_LINK');
    }
    await this._openRelays();

    this._every(this._t.alive, () => this._send({ t: 'alive' }));
    this._every(this._t.sweep, () => this._sweepSilent());

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
      const hello = setInterval(() => this._sayHello(), this._t.hello);
      const timer = setTimeout(
        () => done(reject, relayError('房主不在线，或者这个房间链接已经失效', 'HOST_OFFLINE')),
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
   * 换一条房间链接（房主）：新密钥先在老话题上告诉已经在房里的人，然后大家一起搬过去。
   * 老链接从此没人应答，拿着它的人只会等到「链接已失效」。已经建好的直连不受影响。
   */
  async rekey(newSecret) {
    if (!this.isHost) throw new Error('只有房主能换房间链接');
    await this._send({ t: 'rekey', secret: newSecret });
    await this._moveTo(newSecret);
    this.emit('rekey', { secret: newSecret });
  }

  /** 房主眼中已放行、还活着的成员数（不含房主）。 */
  get admittedCount() {
    return this._members.size;
  }

  close() {
    if (this._closedByUs) return;
    // 先尽量说一声再走；发不出去也无所谓，房主 100 秒收不到心跳也会认定离开
    this._send({ t: 'bye' }).finally(() => {
      this._closedByUs = true;
      for (const t of this._timers) clearInterval(t);
      this._timers = [];
      for (const s of this._sockets.values()) {
        clearTimeout(s.timer);
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
    const slot = this._sockets.get(url) || { ws: null, retry: 0, timer: null, open: false };
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
      slot.retry = 0;
      this.connected = true;
      this._subscribe(ws);
      first?.onOpen();
      first = null;
    };
    ws.onmessage = (m) => this._onRelayMessage(url, m.data);
    ws.onerror = () => {};
    ws.onclose = () => {
      slot.open = false;
      if (!opened) first?.onFail();
      first = null;
      const anyOpen = [...this._sockets.values()].some((s) => s.open);
      if (!anyOpen && this.connected) {
        this.connected = false;
        this.emit('disconnected');
        this.emit('reconnecting', { in: this._backoff(slot.retry) });
      }
      this._retryRelay(url);
    };
  }

  _backoff(retry) {
    return Math.min(30000, 1000 * 2 ** retry);
  }

  _retryRelay(url) {
    if (this._closedByUs) return;
    const slot = this._sockets.get(url);
    if (!slot) return;
    clearTimeout(slot.timer);
    slot.timer = setTimeout(() => this._openRelay(url), this._backoff(slot.retry++));
  }

  _subscribe(ws) {
    if (!this._room) return;
    const filter = { kinds: [RELAY_EVENT_KIND], '#x': [this._room.topic], since: Math.floor(Date.now() / 1000) - 30 };
    try {
      ws.send(JSON.stringify(['REQ', 'nr', filter]));
    } catch {}
  }

  async _moveTo(secret) {
    this.secret = secret;
    this._room = await deriveRoom(secret);
    for (const s of this._sockets.values()) {
      if (!s.open) continue;
      try {
        s.ws.send(JSON.stringify(['CLOSE', 'nr']));
      } catch {}
      this._subscribe(s.ws);
    }
  }

  /* ---------- 发 ---------- */

  async _send(body) {
    if (!this._room || this._closedByUs) return;
    const room = this._room;
    const content = await seal(room.key, { ...body, v: RELAY_PROTO, from: this.peerId, name: this.name, ts: Date.now() });
    const ev = await signEvent(this.key, { kind: RELAY_EVENT_KIND, tags: [['x', room.topic]], content });
    this._remember(ev.id); // 自己发的从中继绕回来时直接丢
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

  _remember(id) {
    if (this._seen.has(id)) return false;
    this._seen.add(id);
    this._seenOrder.push(id);
    if (this._seenOrder.length > SEEN_LIMIT) this._seen.delete(this._seenOrder.shift());
    return true;
  }

  async _onRelayMessage(_url, data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!Array.isArray(msg) || msg[0] !== 'EVENT') return;
    const ev = msg[2];
    if (!ev || ev.kind !== RELAY_EVENT_KIND || typeof ev.id !== 'string') return;
    const room = this._room;
    if (!room || !Array.isArray(ev.tags) || !ev.tags.some((t) => t[0] === 'x' && t[1] === room.topic)) return;
    // 同一条事件会从好几个中继各来一份：按 id 只处理一次（也挡住原样重放）
    if (!this._remember(ev.id)) return;
    const now = Math.floor(Date.now() / 1000);
    if (typeof ev.created_at !== 'number' || Math.abs(now - ev.created_at) > MAX_SKEW_SEC) return;
    if (!(await verifyEvent(ev))) return;
    if (ev.pubkey === this.publicKey) return;
    const body = await open(room.key, ev.content);
    if (!body || body.v !== RELAY_PROTO || !ID_RE.test(String(body.from || ''))) return;
    if (typeof body.ts !== 'number' || Math.abs(Date.now() - body.ts) > MAX_SKEW_SEC * 1000) return;
    this._handle(body, ev.pubkey);
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
    if (peerId === this.hostId) this._hostSeen = Date.now();
  }

  _handle(body, pubkey) {
    const { t, from } = body;
    const fromHost = from === this.hostId && pubkey === this.hostKey;

    if (t === 'hello') {
      if (this.isHost) this._onHello(body, pubkey);
      return;
    }
    if (t === 'welcome' || t === 'reject' || t === 'leave' || t === 'room-config' || t === 'rekey') {
      if (!fromHost || this.isHost) return; // 只认房主签的；房主自己不处理这些
      this._touch(this.hostId);
      if (t === 'welcome') this._onWelcome(body);
      else if (t === 'reject') this._onReject(body);
      else if (t === 'leave') this._onLeave(String(body.peerId || ''));
      else if (t === 'room-config') {
        this.maxMembers = Number(body.maxMembers) || this.maxMembers;
        this.emit('room-config', { maxMembers: this.maxMembers });
      } else if (t === 'rekey' && typeof body.secret === 'string') {
        this._moveTo(body.secret).then(() => this.emit('rekey', { secret: body.secret }), () => {});
      }
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
    const reject = (code, message) => this._send({ t: 'reject', to: peerId, key: pubkey, code, message });
    if (peerId === this.peerId) return reject('HOST_ID_RESERVED', '这个身份是房主的');
    if (this.protocolVersion && body.ver !== this.protocolVersion) {
      return reject('VERSION', '双方 NoxReel 版本不一致，请都升级到最新版');
    }
    const existing = this._members.get(peerId);
    if (existing) {
      // 同一个人重发 hello（上一条 welcome 丢了）：原样再发一次，不占新位置
      if (existing.pubkey === pubkey) {
        existing.lastSeen = Date.now();
        return this._sendWelcome(peerId, existing);
      }
      return reject('DUP_PEER', '这个身份已经在房间里了');
    }
    const occupied = Math.max(1 + this._members.size, this._occupied ? Number(this._occupied()) || 0 : 0);
    if (this.maxMembers && occupied >= this.maxMembers) {
      return reject('ROOM_FULL', `房间已满（上限 ${this.maxMembers} 人）`);
    }
    const member = { pubkey, name, seq: this._nextSeq++, lastSeen: Date.now() };
    this._members.set(peerId, member);
    this._sendWelcome(peerId, member);
    // 房主是房里的老成员，和信令服务器下一样由它向新人发 offer
    this.emit('peer-join', { peerId, name });
  }

  _sendWelcome(peerId, m) {
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
    if (!this._members.delete(peerId)) return;
    this._send({ t: 'leave', peerId });
    this.emit('peer-leave', { peerId });
  }

  _sweepSilent() {
    const cutoff = Date.now() - this._t.silent;
    if (this.isHost) {
      for (const [peerId, m] of this._members) if (m.lastSeen < cutoff) this._dropMember(peerId);
      return;
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
    if (!ID_RE.test(peerId) || !Number.isSafeInteger(seq) || seq < 1 || !/^[0-9a-f]{64}$/.test(String(body.pubkey))) return;
    if (body.hostName) this._hostName = safeName(body.hostName);
    if (Number(body.maxMembers)) this.maxMembers = Number(body.maxMembers);

    if (peerId === this.peerId) {
      if (body.pubkey !== this.publicKey) return; // 别人顶着我的 id？不是给我的
      this._hostGoneSent = false;
      // 名册里是比我早进房的人：记下他们的公钥好认他们的 offer，但不发 peer-join —— 由他们向我发起
      for (const r of Array.isArray(body.roster) ? body.roster.slice(0, 64) : []) {
        const id = String(r?.peerId || '');
        const rseq = Number(r?.seq);
        if (!ID_RE.test(id) || id === this.peerId || !/^[0-9a-f]{64}$/.test(String(r?.pubkey)) || !Number.isSafeInteger(rseq)) continue;
        if (!this._bindings.has(id)) this._bindings.set(id, { pubkey: r.pubkey, name: safeName(r.name), seq: rseq, lastSeen: Date.now() });
      }
      if (this._joined) return;
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
    if (body.to !== this.peerId || body.key !== this.publicKey || this._joined) return;
    this._pendingJoin?.reject(relayError(String(body.message || '房主拒绝了加入'), String(body.code || 'REJECTED')));
  }

  _onLeave(peerId) {
    if (!peerId) return;
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
