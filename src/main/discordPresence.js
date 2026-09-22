'use strict';

/**
 * Discord 状态显示（Rich Presence）。
 *
 * 连本机 Discord 客户端的 IPC 命名管道 \\.\pipe\discord-ipc-0 … -9，纯 Node，不引依赖。
 * 帧格式：int32LE 操作码 + int32LE 长度 + JSON。先握手（op 0，{v:1, client_id}），
 * 等 Discord 回 READY，之后用 SET_ACTIVITY 设状态。IPC 断开时 Discord 会自己把状态清掉。
 *
 * 几条约束：
 *  - 懒连接：模块加载和构造时都不碰管道、不起定时器（main.js 在测试里会被假的 electron 加载）。
 *  - 没开 Discord 就静默：每隔一段时间重试，只在「确实有状态要显示」时重试。
 *  - 限频：Discord 要求至少间隔 15 秒更新一次，中间的变化合并成最后一次。
 *  - 内容在这里再校验一遍：渲染进程传来的一切都当不可信输入，按钮只放行我们自己的 https 链接。
 */

const net = require('net');

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

const MIN_INTERVAL_MS = 15000;
const RETRY_MS = 20000;
const CONNECT_TIMEOUT_MS = 3000;
// 连上管道之后等 READY 的上限。管道那头不一定是 Discord（本机任何程序都能先占住 discord-ipc-0），
// 握手之后一声不吭的话，这条连接会一直挂着，状态也永远发不出去。
const HANDSHAKE_TIMEOUT_MS = 10000;
// Discord 回的帧都是几 KB 的 JSON（READY 带一点用户信息）。长度字段是对方填的，
// 原来放到 1MB，一个恶意的管道服务端就能让我们每收一个字节都把整块缓冲拷贝一遍。
const MAX_FRAME_BYTES = 64 * 1024;
// 对方狂发 PING 却不读我们回的 PONG 时，写缓冲会一直涨。超过这个数就断开
const MAX_PENDING_WRITE = 256 * 1024;

// 按钮只许指向这两处：房间链接的跳转页、发布页。别的 URL 一律丢掉。
const BUTTON_URL_PREFIXES = ['https://felis-desuwa.github.io/NoxReel/', 'https://github.com/Felis-desuwa/NoxReel/'];

function encodeFrame(op, payload) {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

/**
 * 把字节流切成一帧帧。半帧留着等下一块。
 *
 * 半帧期间只把块攒进列表，凑够一整帧才拼一次：原来每来一块都把已收的全部拼接一遍，
 * 对方把一个大帧一字节一字节地发，拷贝量就是帧长的平方。
 */
class FrameReader {
  constructor({ maxFrame = MAX_FRAME_BYTES } = {}) {
    this.maxFrame = maxFrame;
    this.chunks = [];
    this.length = 0;
  }
  _take(n) {
    const out = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.length);
    const head = out.subarray(0, n);
    const rest = out.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.length = rest.length;
    return head;
  }
  _peekHeader() {
    const first = this.chunks[0];
    if (first.length >= 8) return first;
    return (this.chunks = [Buffer.concat(this.chunks, this.length)])[0];
  }
  push(chunk) {
    if (chunk.length) {
      this.chunks.push(chunk);
      this.length += chunk.length;
    }
    const frames = [];
    while (this.length >= 8) {
      const head = this._peekHeader();
      const op = head.readInt32LE(0);
      const len = head.readInt32LE(4);
      if (len < 0 || len > this.maxFrame) throw new Error('Discord IPC 帧长度不对');
      if (this.length < 8 + len) break;
      const body = this._take(8 + len).subarray(8).toString('utf8');
      let data = null;
      try {
        data = JSON.parse(body);
      } catch {}
      frames.push({ op, data });
    }
    return frames;
  }
}

function pipeCandidates() {
  if (process.platform === 'win32') return Array.from({ length: 10 }, (_, i) => `\\\\.\\pipe\\discord-ipc-${i}`);
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp';
  return Array.from({ length: 10 }, (_, i) => `${base.replace(/\/$/, '')}/discord-ipc-${i}`);
}

// 只收字符串和数字，而且先按 UTF-16 长度截一刀再做别的：渲染进程给个几十 MB 的字符串
// （或者一个 String() 起来就是几十 MB 的大数组），原来会被整个 Array.from 成一个同样长的数组。
const clip = (value, max) => {
  const raw = typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  const s = raw.slice(0, max * 4).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return Array.from(s).slice(0, max).join('');
};

/**
 * 渲染进程给的状态 → Discord 的 activity 对象。不合规的字段直接丢，不报错：
 * 状态显示是锦上添花，不该因为一个字段不对就整个不显示。
 */
function sanitizeActivity(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const activity = { type: 3 }; // Watching：Discord 上显示「正在观看 NoxReel」
  const details = clip(raw.details, 128);
  const state = clip(raw.state, 128);
  // Discord 要求这两个字段至少 2 个字符
  if (Array.from(details).length >= 2) activity.details = details;
  if (Array.from(state).length >= 2) activity.state = state;

  const start = Number(raw.startMs);
  const end = Number(raw.endMs);
  const sane = (n) => Number.isSafeInteger(n) && n > 1e12 && n < 1e14;
  if (sane(start)) {
    activity.timestamps = { start };
    if (sane(end) && end > start) activity.timestamps.end = end;
  }

  const size = Array.isArray(raw.partySize) && raw.partySize.length === 2 ? raw.partySize.map(Number) : null;
  const partyId = clip(raw.partyId, 64);
  if (partyId && size && size.length === 2 && size.every((n) => Number.isSafeInteger(n) && n >= 1 && n <= 64) && size[0] <= size[1]) {
    activity.party = { id: partyId, size };
  }

  activity.assets = { large_image: 'noxreel', large_text: clip(raw.largeText || 'NoxReel', 128) || 'NoxReel' };

  const buttons = [];
  for (const b of Array.isArray(raw.buttons) ? raw.buttons.slice(0, 2) : []) {
    const label = clip(b?.label, 32);
    const url = typeof b?.url === 'string' ? b.url : '';
    if (!label || url.length > 512 || /\s/.test(url)) continue;
    if (!BUTTON_URL_PREFIXES.some((p) => url.startsWith(p))) continue;
    buttons.push({ label, url });
  }
  if (buttons.length) activity.buttons = buttons;
  return activity;
}

class DiscordPresence {
  /**
   * @param {object} o
   * @param {string} o.clientId           Discord 应用 ID（公开信息，不是密钥）；空串表示没配置，整个功能不工作
   * @param {string} [o.pipePath]         只连这一个管道（开发期测试用）
   * @param {(status: string) => void} [o.onStatus]  idle / connecting / ready / unavailable / unconfigured
   */
  constructor({
    clientId,
    pipePath = null,
    onStatus = () => {},
    minIntervalMs = MIN_INTERVAL_MS,
    retryMs = RETRY_MS,
    handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
  } = {}) {
    this.clientId = String(clientId || '');
    this.pipePath = pipePath;
    this.onStatus = onStatus;
    this.minIntervalMs = minIntervalMs;
    this.retryMs = retryMs;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.status = this.clientId ? 'idle' : 'unconfigured';
    this.socket = null;
    this.ready = false;
    // target：现在应该显示的（对象）或应该清掉（null）；lastSent：这条连接上实际发过的。
    // 两者分开记，Discord 重启、连接重建之后才知道要把 target 补发一遍。
    this.target = null;
    this.lastSentAt = 0;
    this.lastSent = undefined;
    this.flushTimer = null;
    this.retryTimer = null;
    this.connecting = null;
    this.destroyed = false;
    this.nonce = 0;
  }

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    try {
      this.onStatus(status);
    } catch {}
  }

  /** 要显示的状态（已校验过的 activity 对象）。 */
  setActivity(activity) {
    if (this.destroyed || !this.clientId) return;
    this.target = activity;
    this._kick();
  }

  /** 清掉状态但保留连接（比如用户在设置里关掉了）。 */
  clear() {
    if (this.destroyed) return;
    this.target = null;
    if (!this.socket) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      return;
    }
    this._kick();
  }

  /**
   * 断开。IPC 一断 Discord 自己就把状态清了，所以退房、退出时直接断，不用等限频。
   * 之后还可以再 setActivity（重新连）—— 页面刷新后进下一个房间就是这种情况。
   */
  disconnect() {
    clearTimeout(this.flushTimer);
    clearTimeout(this.retryTimer);
    this.flushTimer = null;
    this.retryTimer = null;
    this.target = null;
    this.lastSent = undefined;
    const sock = this.socket;
    this.socket = null;
    this.ready = false;
    if (sock) {
      try {
        sock.end(encodeFrame(OP_CLOSE, {}));
      } catch {}
      sock.destroy();
    }
    if (this.clientId) this._setStatus('idle');
  }

  destroy() {
    this.disconnect();
    this.destroyed = true;
  }

  _kick() {
    if (this.ready) return this._scheduleFlush();
    // 已经连上、正在等 READY：什么都不用做，READY 一到就会按最新的 target 发。
    // 原来这里会再开一条连接，旧连接没人关、它的 READY 还会借新连接把状态发出去（串线）。
    if (this.socket) return;
    if (!this.connecting && !this.retryTimer) this._connect();
  }

  _scheduleFlush() {
    if (this.flushTimer) return;
    const wait = Math.max(0, this.lastSentAt + this.minIntervalMs - Date.now());
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this._flush();
    }, wait);
  }

  _flush() {
    if (!this.ready) return;
    // 新连接上 lastSent 是 undefined：target 是 null 时也不必专门发一条「清空」
    if (JSON.stringify(this.target) === JSON.stringify(this.lastSent ?? null)) return;
    const args = { pid: process.pid };
    if (this.target) args.activity = this.target;
    this._write(OP_FRAME, { cmd: 'SET_ACTIVITY', args, nonce: String(++this.nonce) });
    this.lastSent = this.target;
    this.lastSentAt = Date.now();
  }

  _write(op, payload, sock = this.socket) {
    if (!sock || sock.destroyed) return;
    // 对方不读我们写的东西（比如狂发 PING 却不收 PONG）：别让写缓冲无限涨，断掉这条连接
    if (sock.writableLength > MAX_PENDING_WRITE) {
      sock.destroy();
      return;
    }
    try {
      sock.write(encodeFrame(op, payload));
    } catch {}
  }

  _connect() {
    this._setStatus('connecting');
    this.connecting = (async () => {
      const paths = this.pipePath ? [this.pipePath] : pipeCandidates();
      for (const p of paths) {
        if (this.destroyed || !this.target) break;
        const sock = await this._tryPipe(p);
        if (sock) {
          // 连的这一会儿里状态被撤了（关掉了开关、退了房）：不用这条连接了
          if (this.destroyed || !this.target) {
            sock.destroy();
            break;
          }
          this._adopt(sock);
          return;
        }
      }
      if (this.destroyed || !this.target) return this._setStatus('idle');
      this._unavailable();
    })().finally(() => {
      this.connecting = null;
    });
  }

  _tryPipe(p) {
    return new Promise((resolve) => {
      const sock = net.connect(p);
      const timer = setTimeout(() => {
        sock.destroy();
        resolve(null);
      }, CONNECT_TIMEOUT_MS);
      sock.once('connect', () => {
        clearTimeout(timer);
        resolve(sock);
      });
      sock.once('error', () => {
        clearTimeout(timer);
        sock.destroy();
        resolve(null);
      });
    });
  }

  _adopt(sock) {
    this.socket = sock;
    const reader = new FrameReader();
    // 握手之后迟迟等不到 READY：当成连不上，断开后按老规矩过一阵再试
    const handshakeTimer = setTimeout(() => {
      if (this.socket === sock && !this.ready) sock.destroy();
    }, this.handshakeTimeoutMs);
    if (handshakeTimer.unref) handshakeTimer.unref();
    sock.on('data', (chunk) => {
      // 不是当前这条连接的数据一概不认：它的 READY / CLOSE 不能拿去动当前连接的状态
      if (this.socket !== sock) {
        sock.destroy();
        return;
      }
      let frames;
      try {
        frames = reader.push(chunk);
      } catch {
        sock.destroy();
        return;
      }
      for (const f of frames) {
        if (this.socket !== sock) break;
        this._onFrame(f, sock);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      clearTimeout(handshakeTimer);
      if (this.socket !== sock) return;
      this.socket = null;
      this.ready = false;
      this.lastSent = undefined;
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      // Discord 关了或者重启了：还有要显示的状态就过一阵再连
      if (!this.destroyed && this.target) this._scheduleRetry();
      else this._setStatus('idle');
    });
    this._write(OP_HANDSHAKE, { v: 1, client_id: this.clientId }, sock);
  }

  /** 一帧只作用于收到它的那条连接（sock），不去碰 this.socket 指向的别的连接。 */
  _onFrame({ op, data }, sock = this.socket) {
    if (!sock || sock !== this.socket) return;
    if (op === OP_PING) return this._write(OP_PONG, data || {}, sock);
    if (op === OP_CLOSE) return sock.destroy();
    if (op !== OP_FRAME || !data) return;
    if (data.cmd === 'DISPATCH' && data.evt === 'READY') {
      if (this.ready) return;
      this.ready = true;
      this._setStatus('ready');
      this._scheduleFlush();
      return;
    }
    if (data.evt === 'ERROR' && !this.ready) {
      // 应用 ID 不对之类：再连也没用，别循环
      this._setStatus('unavailable');
      sock.destroy();
    }
  }

  _unavailable() {
    this._setStatus('unavailable');
    if (!this.destroyed && this.target) this._scheduleRetry();
  }

  _scheduleRetry() {
    clearTimeout(this.retryTimer);
    this._setStatus('unavailable');
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.destroyed && this.target) this._connect();
    }, this.retryMs);
  }
}

module.exports = {
  DiscordPresence,
  sanitizeActivity,
  encodeFrame,
  FrameReader,
  pipeCandidates,
  BUTTON_URL_PREFIXES,
  MAX_FRAME_BYTES,
  MAX_PENDING_WRITE,
  OP_PING,
  OP_HANDSHAKE,
  OP_FRAME,
  OP_CLOSE,
};
