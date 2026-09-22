'use strict';

/**
 * 只放行公网目标的本机 HTTP 代理（支持绝对地址转发和 CONNECT 隧道）。
 *
 * 为什么非得有它：主进程只能在交出链接之前校验一次「这个主机是不是公网」，之后的事它管不到 ——
 * mpv 里的 ytdl_hook 会自己再跑一次 yt-dlp，yt-dlp 和 ffmpeg 都会跟随 3xx，HLS 播放列表里
 * 还能写任意子资源地址，再加上校验和真正连接是两次 DNS 解析（重绑定窗口）。
 * 让这些程序的每一个 HTTP(S) 请求都经过这里，并且**在连接那一刻**解析、判定、直接连向判定过的
 * 那个 IP，上面几条就一次全堵住了。
 *
 * 防滥用：
 *  - 只监听 127.0.0.1；
 *  - 每次启动随机生成一对用户名密码，只有带着它（Proxy-Authorization: Basic）的请求才转发，
 *    本机别的程序连上来只会拿到 407；
 *  - 并发连接数有上限，请求头、建连、空闲都有超时。
 */

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { resolvePublic } = require('./ipGuard');

// 逐跳头：只属于「客户端 ↔ 代理」这一段，不能原样转给上游。proxy-authorization 尤其不能 ——
// 那是我们自己的凭据。
const HOP_BY_HOP = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const DEFAULTS = {
  maxConnections: 64,
  headersTimeoutMs: 10_000,
  connectTimeoutMs: 15_000,
  // 暂停时播放器不读数据，连接会一直空着。太短的话每次暂停久一点都得重连一次
  idleTimeoutMs: 5 * 60_000,
};

const CRLF = '\r\n';

function rawResponse(status, reason, extra = []) {
  return [`HTTP/1.1 ${status} ${reason}`, ...extra, 'Content-Length: 0', 'Connection: close', '', ''].join(CRLF);
}

/** 从 rawHeaders 里去掉逐跳头，以及 Connection 里点名的那些。返回同样的扁平数组格式。 */
function stripHopByHop(rawHeaders) {
  const named = new Set();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (String(rawHeaders[i]).toLowerCase() !== 'connection') continue;
    for (const token of String(rawHeaders[i + 1]).split(',')) named.add(token.trim().toLowerCase());
  }
  const out = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = String(rawHeaders[i]).toLowerCase();
    if (HOP_BY_HOP.has(name) || named.has(name)) continue;
    out.push(rawHeaders[i], rawHeaders[i + 1]);
  }
  return out;
}

/** CONNECT 的目标（authority 形式）：host:port 或 [v6]:port。 */
function parseAuthority(text) {
  const raw = String(text || '');
  if (raw.length > 300) return null;
  const match = /^(?:\[([0-9a-fA-F:.%]+)\]|([^:[\]/\s@]+)):(\d{1,5})$/.exec(raw);
  if (!match) return null;
  const port = Number(match[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: match[1] || match[2], port };
}

class PublicProxy {
  /**
   * @param {object} [opts]
   * @param {(host: string, port: number) => Promise<Array<{address: string, family: number}>>} [opts.resolve]
   *   解析并判定目标。默认 ipGuard.resolvePublic；测试里换成「把某个假域名当公网」的版本。
   */
  constructor({ resolve = resolvePublic, ...limits } = {}) {
    this.resolve = resolve;
    this.limits = { ...DEFAULTS, ...limits };
    this.server = null;
    this._starting = null;
    this.port = 0;
    this.username = crypto.randomBytes(12).toString('hex');
    this.password = crypto.randomBytes(24).toString('hex');
    this._expected = Buffer.from(`Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`);
    this._sockets = new Set();
    // 最近被拦下的目标，诊断和测试用。只留最后几条，别让它自己变成内存泄漏
    this.blocked = [];
  }

  /** 带凭据的代理地址，交给 mpv / yt-dlp 用。没启动时为 null。 */
  get url() {
    return this.port ? `http://${this.username}:${this.password}@127.0.0.1:${this.port}` : null;
  }

  /** 给 Chromium 用：它不认地址里的凭据，要在 login 事件里单独交。 */
  get info() {
    return this.port
      ? { host: '127.0.0.1', port: this.port, username: this.username, password: this.password, url: this.url }
      : null;
  }

  /** 幂等：已经起来就直接返回地址。 */
  start() {
    if (this.port) return Promise.resolve(this.url);
    if (this._starting) return this._starting;
    this._starting = new Promise((resolve, reject) => {
      const server = http.createServer({
        maxHeaderSize: 16 * 1024,
        headersTimeout: this.limits.headersTimeoutMs,
        requestTimeout: 60_000,
        keepAliveTimeout: 5_000,
        // 上面两个超时由一个定时巡检执行，默认 30 秒才巡一次：慢慢发请求头的连接能多占 30 秒名额
        connectionsCheckingInterval: Math.max(250, Math.min(2_000, Math.floor(this.limits.headersTimeoutMs / 2))),
      });
      server.maxConnections = this.limits.maxConnections;
      server.on('connection', (socket) => {
        this._sockets.add(socket);
        socket.on('close', () => this._sockets.delete(socket));
        socket.on('error', () => {});
      });
      server.on('request', (req, res) => {
        this._forward(req, res).catch(() => {
          if (!res.headersSent) this._reply(res, 502, 'Bad Gateway');
          else res.destroy();
        });
      });
      server.on('connect', (req, socket, head) => {
        this._tunnel(req, socket, head).catch(() => socket.destroy());
      });
      // 请求头畸形、或者迟迟发不完（headersTimeout）：回一句就断，不做任何转发。
      // 必须 destroy 而不是 end —— 半关的连接照样占着 maxConnections 的名额
      server.on('clientError', (error, socket) => {
        if (socket.writable && socket.bytesWritten === 0) {
          const timeout = error && error.code === 'ERR_HTTP_REQUEST_TIMEOUT';
          socket.write(timeout ? rawResponse(408, 'Request Timeout') : rawResponse(400, 'Bad Request'));
        }
        socket.destroy();
      });
      server.once('error', (error) => {
        this._starting = null;
        reject(error);
      });
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        this.port = server.address().port;
        this._starting = null;
        resolve(this.url);
      });
    });
    return this._starting;
  }

  close() {
    const server = this.server;
    this.server = null;
    this.port = 0;
    for (const socket of this._sockets) socket.destroy();
    this._sockets.clear();
    if (!server) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  _authorized(req) {
    const got = req.headers['proxy-authorization'];
    if (typeof got !== 'string') return false;
    const given = Buffer.from(got.trim());
    return given.length === this._expected.length && crypto.timingSafeEqual(given, this._expected);
  }

  _noteBlocked(host, port, reason) {
    this.blocked.push({ host: String(host).slice(0, 255), port, reason, at: Date.now() });
    if (this.blocked.length > 20) this.blocked.shift();
  }

  _reply(res, status, reason, headers = {}) {
    try {
      res.writeHead(status, reason, { 'Content-Length': 0, Connection: 'close', ...headers });
      res.end();
    } catch {
      res.destroy();
    }
  }

  /** 判定目标。被拒时返回 null（已经记下原因），调用方回 403。 */
  async _target(host, port) {
    try {
      const list = await this.resolve(host, port);
      if (!Array.isArray(list) || !list.length) throw new Error('没有可用地址');
      return list[0];
    } catch (error) {
      this._noteBlocked(host, port, error.code || error.message || 'blocked');
      return null;
    }
  }

  /** 绝对地址形式的普通 HTTP 请求（GET http://host/path HTTP/1.1）。 */
  async _forward(req, res) {
    if (!this._authorized(req)) {
      return this._reply(res, 407, 'Proxy Authentication Required', {
        'Proxy-Authenticate': 'Basic realm="NoxReel"',
      });
    }
    let target;
    try {
      target = new URL(req.url);
    } catch {
      return this._reply(res, 400, 'Bad Request');
    }
    // https 必须走 CONNECT；源形式（/path）说明对方把我们当成了普通网站
    if (target.protocol !== 'http:' || !target.hostname) return this._reply(res, 400, 'Bad Request');
    const port = Number(target.port || 80);
    const addr = await this._target(target.hostname, port);
    if (!addr) return this._reply(res, 403, 'Forbidden');
    if (res.destroyed || req.destroyed) return;

    // 绝对地址形式的请求，Host 必须按请求地址重写（RFC 7230 §5.4），客户端带来的那个不作数
    const headers = stripHopByHop(req.rawHeaders).filter((value, i, all) => {
      const nameAt = i % 2 === 0 ? i : i - 1;
      return String(all[nameAt]).toLowerCase() !== 'host';
    });
    headers.push('Host', target.host);
    const upstream = http.request({
      host: addr.address,
      family: addr.family,
      port,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
      setHost: false,
      agent: false,
    });
    const idle = this.limits.idleTimeoutMs;
    upstream.setTimeout(idle, () => upstream.destroy(new Error('上游空闲超时')));
    upstream.on('response', (up) => {
      try {
        res.writeHead(up.statusCode, up.statusMessage, stripHopByHop(up.rawHeaders));
      } catch {
        up.destroy();
        return this._reply(res, 502, 'Bad Gateway');
      }
      up.pipe(res);
      up.on('error', () => res.destroy());
    });
    upstream.on('error', () => {
      if (!res.headersSent) this._reply(res, 502, 'Bad Gateway');
      else res.destroy();
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  }

  /** CONNECT host:port —— https 和 wss 都走这条。隧道里是端到端的 TLS，我们只管「连谁」。 */
  async _tunnel(req, client, head) {
    client.on('error', () => {});
    if (!this._authorized(req)) {
      client.end(rawResponse(407, 'Proxy Authentication Required', ['Proxy-Authenticate: Basic realm="NoxReel"']));
      return;
    }
    const authority = parseAuthority(req.url);
    if (!authority) {
      client.end(rawResponse(400, 'Bad Request'));
      return;
    }
    const addr = await this._target(authority.host, authority.port);
    if (!addr) {
      client.end(rawResponse(403, 'Forbidden'));
      return;
    }
    if (client.destroyed) return;

    let established = false;
    const upstream = net.connect({ host: addr.address, family: addr.family, port: authority.port });
    const kill = () => {
      upstream.destroy();
      client.destroy();
    };
    upstream.on('error', () => {
      if (client.writable && !established) client.end(rawResponse(502, 'Bad Gateway'));
      else kill();
    });
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => {
      // 没连上时 client 上还在写 502，别抢在它前面把连接掐掉
      if (established) client.destroy();
    });
    const connectTimer = setTimeout(() => {
      if (established) return;
      upstream.destroy();
      if (client.writable) client.end(rawResponse(504, 'Gateway Timeout'));
    }, this.limits.connectTimeoutMs);
    upstream.once('connect', () => {
      established = true;
      clearTimeout(connectTimer);
      const idle = this.limits.idleTimeoutMs;
      upstream.setTimeout(idle, kill);
      client.setTimeout(idle, kill);
      client.write(`HTTP/1.1 200 Connection Established${CRLF}${CRLF}`);
      if (head && head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
  }
}

let shared = null;

/** 全进程共用一个代理：播放器、yt-dlp、隔离浏览器都连它。 */
function sharedProxy() {
  if (!shared) shared = new PublicProxy();
  return shared;
}

async function closeSharedProxy() {
  if (!shared) return;
  const proxy = shared;
  shared = null;
  await proxy.close().catch(() => {});
}

module.exports = { PublicProxy, sharedProxy, closeSharedProxy, parseAuthority, stripHopByHop, HOP_BY_HOP };
