'use strict';

/**
 * Cloudflare TURN：拿用户自己的 Cloudflare 账号，现取临时的 TURN 用户名密码。
 *
 * 用户在 Cloudflare 后台 Realtime → TURN Server 新建一个 Key，把 Turn Token ID 和 API Token
 * 填进设置。之后要连接时，主进程拿 API Token 向 Cloudflare 换一组 24 小时有效的 TURN 账号，
 * 渲染进程拿到的只有这组临时账号。
 *
 * 几条不变量（改之前先想清楚）：
 *  - **API Token 只进不出**：保存时先真的调一次生成接口验证，成功才用 safeStorage 加密落盘；
 *    之后只有这个模块读它。不回传给渲染进程，不写日志，报错信息里也不带它。
 *    系统的加密服务不可用（safeStorage.isEncryptionAvailable() 为 false）就拒绝保存 ——
 *    宁可不存，也不明文落盘。
 *  - **端口 53 一律去掉**：Chromium 会拦这个端口，候选收集要干等到超时；一对一邀请和房间链接
 *    不 trickle，整条邀请都跟着卡住。Cloudflare 的响应里恰好带着 53 端口的地址。
 *  - **只认 turn.cloudflare.com**：响应再怎么写，也不许把中继指到别的主机上。
 *  - **本机月用量到了用户设的上限就不再发新账号**（CF_QUOTA）。Cloudflare 自己没有「超量自动停」，
 *    只会发邮件，所以由这里在本机计量：渲染进程按连接的 getStats() 汇报经 Cloudflare 中继的字节数，
 *    这里按 UTC 自然月累加、落盘。
 *
 * 请求函数、时钟、存储路径、safeStorage 都能注入，测试里不碰外网也不碰系统密钥。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const ENDPOINT = 'https://rtc.live.cloudflare.com/v1/turn/keys';
const TTL_SEC = 86400;
// 缓存到「生成时刻 + ttl − 1 小时」：留一小时余量，别拿一组快过期的账号去建一条要连好几个小时的连接
const CACHE_MARGIN_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_CREDENTIAL_LENGTH = 1024;
const TURN_HOST = 'turn.cloudflare.com';
// Chromium 拦下的端口：候选收集会一直等到超时
const BLOCKED_PORTS = new Set([53]);
const CREDENTIAL_FILE = 'cloudflare-turn.json';
const USAGE_FILE = 'cloudflare-turn-usage.json';

const BYTES_PER_GB = 1e9;
const DEFAULT_LIMIT_GB = 900; // 免费额度 1000 GB，留 100 GB 余量（本机统计和账单难免有出入）
const MIN_LIMIT_GB = 1;
const MAX_LIMIT_GB = 1000;
const WARN_RATIO = 0.8;

/** 带代码的错误。Electron 的 IPC 只把 message 带过去，所以代码写进 message 开头。 */
function cfError(code, detail) {
  const error = new Error(`[${code}] ${detail}`);
  error.code = code;
  return error;
}

/** Turn Token ID：只能是字母数字，8–128 位。它会拼进请求路径，字符集必须收得很窄。 */
function isValidKeyId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9]{8,128}$/.test(value);
}

/**
 * API Token：可打印的 ASCII，不含空白，16–512 位。它会写进 Authorization 头，
 * 控制字符和换行进不得；用码点判断，不写正则字符类（这个仓库吃过转义被改写的亏）。
 */
function isValidApiToken(value) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 512) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

/** 用户设的月上限（GB）：1–1000 的整数。 */
function isValidLimitGb(value) {
  return Number.isInteger(value) && value >= MIN_LIMIT_GB && value <= MAX_LIMIT_GB;
}

/** UTC 自然月，形如 2026-09。 */
function monthKey(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * 拆一条 turn: / turns: 地址。认不出返回 null。
 * 只认 `turn:主机[:端口][?transport=udp|tcp]` 这一种写法 —— 这里只处理 Cloudflare 给的地址，
 * 多余的写法一律当成认不出来。
 */
function parseTurnUrl(url) {
  if (typeof url !== 'string' || url.length > 256) return null;
  const m = /^(turns?):([A-Za-z0-9.-]+)(?::(\d{1,5}))?(\?transport=(?:udp|tcp))?$/i.exec(url);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const port = m[3] === undefined ? (scheme === 'turns' ? 5349 : 3478) : Number(m[3]);
  if (!(port >= 1 && port <= 65535)) return null;
  return { scheme, host: m[2].toLowerCase(), port };
}

/** 能交给浏览器的 Cloudflare 中继地址：主机必须是 turn.cloudflare.com，端口不能是 53。 */
function isUsableTurnUrl(url) {
  const parsed = parseTurnUrl(url);
  return Boolean(parsed && parsed.host === TURN_HOST && !BLOCKED_PORTS.has(parsed.port));
}

/**
 * 从生成接口的响应里挑出那条 TURN。
 *
 * 新接口（generate-ice-servers）给的是数组，一条 STUN 一条 TURN；老接口给的是单个对象。
 * 两种都认。STUN 那条没有用户名密码，地址也过不了 isUsableTurnUrl，自然被跳过。
 */
function pickTurnServer(body) {
  let servers = body && typeof body === 'object' ? body.iceServers : null;
  if (servers && !Array.isArray(servers) && typeof servers === 'object') servers = [servers];
  if (!Array.isArray(servers) || servers.length > 16) throw cfError('CF_BAD_RESPONSE', '响应里没有 iceServers');
  for (const server of servers) {
    if (!server || typeof server !== 'object') continue;
    const raw = Array.isArray(server.urls) ? server.urls : [server.urls];
    if (raw.length > 32) continue;
    const urls = [];
    for (const url of raw) if (isUsableTurnUrl(url) && !urls.includes(url)) urls.push(url);
    if (!urls.length) continue;
    const { username, credential } = server;
    if (typeof username !== 'string' || !username || username.length > MAX_CREDENTIAL_LENGTH) {
      throw cfError('CF_BAD_RESPONSE', 'TURN 用户名不合格');
    }
    if (typeof credential !== 'string' || !credential || credential.length > MAX_CREDENTIAL_LENGTH) {
      throw cfError('CF_BAD_RESPONSE', 'TURN 密码不合格');
    }
    return { urls, username, credential };
  }
  throw cfError('CF_BAD_RESPONSE', '响应里没有可用的 TURN 地址');
}

/** 读响应体，按字节封顶。Content-Length 报得太大就不读了。 */
async function readLimited(res, maxBytes) {
  const declared = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
  if (declared > maxBytes) throw cfError('CF_BAD_RESPONSE', '响应体过大');
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = typeof res.text === 'function' ? await res.text() : '';
    if (Buffer.byteLength(text) > maxBytes) throw cfError('CF_BAD_RESPONSE', '响应体过大');
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      throw cfError('CF_BAD_RESPONSE', '响应体过大');
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 先写临时文件再改名：写一半断电也不会留下半截 JSON。 */
async function writeAtomic(target, text) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temporary, target);
}

class CloudflareTurn {
  /**
   * @param {object} opts
   * @param {string} [opts.userDataDir]  两个文件默认放这里
   * @param {string} [opts.storePath]    加密后的凭据文件
   * @param {string} [opts.usagePath]    本机月用量和上限
   * @param {object} [opts.safeStorage]  Electron 的 safeStorage（或同形状的替身）
   * @param {Function} [opts.fetch]      发请求用的 fetch
   * @param {Function} [opts.now]        时钟（毫秒）
   * @param {string} [opts.endpoint]     生成接口的前缀（测试里指到本机假服务器）
   * @param {number} [opts.timeoutMs]
   */
  constructor({
    userDataDir = '',
    storePath = path.join(userDataDir, CREDENTIAL_FILE),
    usagePath = path.join(userDataDir, USAGE_FILE),
    safeStorage = null,
    fetch = (...args) => globalThis.fetch(...args),
    now = () => Date.now(),
    endpoint = ENDPOINT,
    timeoutMs = REQUEST_TIMEOUT_MS,
  } = {}) {
    this.storePath = storePath;
    this.usagePath = usagePath;
    this.safeStorage = safeStorage;
    this.fetch = fetch;
    this.now = now;
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.lastError = null;
    this._cache = null; // { urls, username, credential, expiresAt }
    this._inflight = null;
    // 换代：保存了新凭据或清除之后，在途请求的结果不再写进缓存
    this._gen = 0;
    this._usage = null; // 懒加载，见 _loadUsage()
    this._usageWrite = Promise.resolve();
  }

  /* ------------------------------- 凭据 ------------------------------- */

  _encryptionAvailable() {
    try {
      return Boolean(this.safeStorage && this.safeStorage.isEncryptionAvailable());
    } catch {
      return false;
    }
  }

  /**
   * 保存凭据：先校验格式，再真的调一次生成接口，成功才加密落盘。
   * 返回 status()，里面没有 Token。
   */
  async save({ keyId, apiToken } = {}) {
    if (!isValidKeyId(keyId)) throw cfError('CF_INVALID_INPUT', 'Turn Token ID 格式不对');
    if (!isValidApiToken(apiToken)) throw cfError('CF_INVALID_INPUT', 'API Token 格式不对');
    if (!this._encryptionAvailable()) {
      throw cfError('CF_NO_ENCRYPTION', '本机的加密服务不可用，不能安全地保存 API Token，所以没有保存');
    }
    const startedAt = this.now();
    const creds = await this._generate({ keyId, apiToken });
    const secret = this.safeStorage.encryptString(JSON.stringify({ keyId, apiToken }));
    await writeAtomic(this.storePath, JSON.stringify({ version: 1, secret: Buffer.from(secret).toString('base64') }));
    this._gen += 1;
    this._inflight = null;
    this._cache = { ...creds, expiresAt: startedAt + TTL_SEC * 1000 - CACHE_MARGIN_MS };
    this.lastError = null;
    return this.status();
  }

  /** 读出保存的凭据。没有、坏了、解不开都算「没配置」。 */
  async _readSecret() {
    let raw;
    try {
      raw = await fsp.readFile(this.storePath, 'utf8');
    } catch (error) {
      throw cfError('CF_NOT_CONFIGURED', error && error.code === 'ENOENT' ? '还没保存 Cloudflare 凭据' : '凭据文件读不出来');
    }
    if (!this._encryptionAvailable()) throw cfError('CF_NOT_CONFIGURED', '本机的加密服务不可用，解不开保存的凭据');
    try {
      const data = JSON.parse(raw);
      const plain = this.safeStorage.decryptString(Buffer.from(String(data.secret || ''), 'base64'));
      const parsed = JSON.parse(plain);
      if (isValidKeyId(parsed.keyId) && isValidApiToken(parsed.apiToken)) return parsed;
    } catch {
      /* 落到下面 */
    }
    throw cfError('CF_NOT_CONFIGURED', '保存的凭据解不开，请重新保存');
  }

  /** 调一次生成接口。所有网络层的失败都归成 CF_NETWORK，Token 不进任何一条报错。 */
  async _generate({ keyId, apiToken }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let res;
      try {
        res = await this.fetch(`${this.endpoint}/${keyId}/credentials/generate-ice-servers`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: TTL_SEC }),
          signal: controller.signal,
          // 不跟随跳转：带着 Authorization 头被引到别处去不是我们想要的
          redirect: 'error',
        });
      } catch {
        throw cfError('CF_NETWORK', controller.signal.aborted ? '请求超时' : '连不上 Cloudflare');
      }
      const status = Number(res.status);
      if (status === 401 || status === 403) {
        res.body?.cancel?.().catch?.(() => {});
        throw cfError('CF_UNAUTHORIZED', `HTTP ${status}`);
      }
      if (!(status >= 200 && status < 300)) {
        res.body?.cancel?.().catch?.(() => {});
        throw cfError('CF_BAD_RESPONSE', `HTTP ${status}`);
      }
      let text;
      try {
        text = await readLimited(res, MAX_RESPONSE_BYTES);
      } catch (error) {
        if (error && error.code === 'CF_BAD_RESPONSE') throw error;
        throw cfError('CF_NETWORK', controller.signal.aborted ? '请求超时' : '响应没收完');
      }
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw cfError('CF_BAD_RESPONSE', '响应不是 JSON');
      }
      return pickTurnServer(body);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 一组能用的临时 TURN 账号 { urls, username, credential, expiresAt }。
   *
   * 缓存期内直接复用，同时只发一个请求。minValidMs：缓存剩下的时间不到这么多就重新生成 ——
   * 渲染进程在离过期不到两小时时拿它换一组新的。
   * 本月用量到了上限就直接抛 CF_QUOTA，连缓存都不给。
   */
  async credentials({ minValidMs = 0 } = {}) {
    const usage = this.usage();
    if (usage.exceeded) {
      this.lastError = 'CF_QUOTA';
      throw cfError('CF_QUOTA', `本月用量已到上限（${usage.limitGB} GB）`);
    }
    if (this._cache && this._cache.expiresAt - this.now() > minValidMs) return { ...this._cache, urls: [...this._cache.urls] };
    if (!this._inflight) {
      const gen = this._gen;
      const run = (async () => {
        try {
          const secret = await this._readSecret();
          const startedAt = this.now();
          const creds = await this._generate(secret);
          const entry = { ...creds, expiresAt: startedAt + TTL_SEC * 1000 - CACHE_MARGIN_MS };
          if (gen === this._gen) {
            this._cache = entry;
            this.lastError = null;
          }
          return entry;
        } catch (error) {
          if (gen === this._gen) this.lastError = (error && error.code) || 'CF_NETWORK';
          throw error && error.code ? error : cfError('CF_NETWORK', '请求失败');
        } finally {
          if (this._inflight === run) this._inflight = null;
        }
      })();
      this._inflight = run;
    }
    const entry = await this._inflight;
    return { ...entry, urls: [...entry.urls] };
  }

  /** 删掉凭据文件、清缓存。本机月用量不动：它记的是这个月实际用掉的流量。 */
  async clear() {
    this._gen += 1;
    this._cache = null;
    this._inflight = null;
    this.lastError = null;
    await fsp.rm(this.storePath, { force: true });
    return this.status();
  }

  /** 设置页要的状态。没有 Token，也没有 Turn Token ID。 */
  status() {
    let configured = false;
    try {
      configured = fs.existsSync(this.storePath);
    } catch {
      configured = false;
    }
    return {
      configured,
      expiresAt: this._cache ? this._cache.expiresAt : null,
      lastError: this.lastError,
      usage: this.usage(),
    };
  }

  /* ------------------------------ 月用量 ------------------------------ */

  /** 懒加载用量文件。读不出来就从零开始，上限用默认值。 */
  _loadUsage() {
    if (this._usage) return this._usage;
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(this.usagePath, 'utf8')) || {};
    } catch {
      data = {};
    }
    const usedBytes = Number(data.usedBytes);
    this._usage = {
      month: typeof data.month === 'string' ? data.month : monthKey(this.now()),
      usedBytes: Number.isSafeInteger(usedBytes) && usedBytes >= 0 ? usedBytes : 0,
      limitGB: isValidLimitGb(data.limitGB) ? data.limitGB : DEFAULT_LIMIT_GB,
      warned: data.warned === true,
    };
    return this._usage;
  }

  /** 跨月清零（UTC）。上限是用户的设置，不跟着清。 */
  _rollover() {
    const usage = this._loadUsage();
    const current = monthKey(this.now());
    if (usage.month !== current) {
      usage.month = current;
      usage.usedBytes = 0;
      usage.warned = false;
    }
    return usage;
  }

  _persistUsage() {
    const snapshot = JSON.stringify({ version: 1, ...this._usage });
    const write = this._usageWrite.then(() => writeAtomic(this.usagePath, snapshot));
    // 写失败不能把后面的写也拖死；这一次的错误照样交给调用方
    this._usageWrite = write.catch(() => {});
    return write;
  }

  /** 本月用量：{ month, usedBytes, limitGB, limitBytes, exceeded, nearLimit }。 */
  usage() {
    const usage = this._rollover();
    const limitBytes = usage.limitGB * BYTES_PER_GB;
    return {
      month: usage.month,
      usedBytes: usage.usedBytes,
      limitGB: usage.limitGB,
      limitBytes,
      exceeded: usage.usedBytes >= limitBytes,
      nearLimit: usage.usedBytes >= limitBytes * WARN_RATIO,
    };
  }

  /**
   * 记一笔增量（字节）。返回最新的 usage()，第一次越过 80% 的那一笔额外带 crossedWarn: true ——
   * 每个月只带一次，渲染进程据此在日志里提醒一次。
   */
  async addUsage(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('无效的 TURN 用量');
    const usage = this._rollover();
    usage.usedBytes = Math.min(Number.MAX_SAFE_INTEGER, usage.usedBytes + bytes);
    let crossedWarn = false;
    if (!usage.warned && usage.usedBytes >= usage.limitGB * BYTES_PER_GB * WARN_RATIO) {
      usage.warned = true;
      crossedWarn = true;
    }
    await this._persistUsage();
    return { ...this.usage(), crossedWarn };
  }

  /** 改月上限（GB，1–1000）。调高到 80% 以下时，80% 的提醒下次还会再来一次。 */
  async setLimit(limitGB) {
    if (!isValidLimitGb(limitGB)) throw new TypeError('无效的 TURN 用量上限');
    const usage = this._rollover();
    usage.limitGB = limitGB;
    if (usage.usedBytes < limitGB * BYTES_PER_GB * WARN_RATIO) usage.warned = false;
    await this._persistUsage();
    return this.usage();
  }
}

module.exports = {
  CloudflareTurn,
  isValidKeyId,
  isValidApiToken,
  isValidLimitGb,
  isUsableTurnUrl,
  parseTurnUrl,
  pickTurnServer,
  monthKey,
  cfError,
  TTL_SEC,
  CACHE_MARGIN_MS,
  REQUEST_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  BYTES_PER_GB,
  DEFAULT_LIMIT_GB,
  MIN_LIMIT_GB,
  MAX_LIMIT_GB,
  TURN_HOST,
};
