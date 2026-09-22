'use strict';

/**
 * NoxReel 信令服务器。
 *
 * 只做一件事：在房间内转发 SDP / ICE 候选这类连接元数据。
 * 它看不到、也存不下任何视频内容 —— 内容全程只在 peer 之间的 DataChannel 里跑。
 * 这就是「零内容服务器」的含义：轻量元数据可以过服务器，视频字节不行。
 *
 * 地区策略：默认不拦任何人。产品层面的地区限制做到「告知 + 服务条款声明」为止
 * （客户端启动时探测并提示），不做强制阻断 —— 客户端那层改一行代码就能绕过，
 * 而「极简模式」压根不经过这里，硬拦也拦不全，只会误伤正常用户。
 *
 * 但机制保留着：有硬合规要求的部署方可以用 BLOCKED_COUNTRIES 打开强制拦截，
 * 这里是唯一有强制力的执行点（连不上信令就凑不出 SDP 交换，房间建不起来）。
 *
 * 启动：
 *   node signaling-server/server.js
 * 环境变量：
 *   PORT              监听端口，默认 8080
 *   MAXMIND_DB        GeoLite2-Country.mmdb 路径。不配则退化为只信任边缘头部
 *   TRUST_PROXY       =1 时信任 X-Forwarded-For / X-Real-IP / CF-IPCountry（放在反代、CDN/WAF 后面时开）。
 *                     开了以后限流和局域网豁免都按反代转述的客户端地址算，反代必须**追加**写 X-Forwarded-For
 *                     （nginx：proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for）
 *   BLOCKED_COUNTRIES 逗号分隔的 ISO 国家码，默认空 —— 即不拦任何人
 *   ALLOW_UNKNOWN     =0 时查不到地区就拒绝（默认 1，放行）
 *   MAX_ROOM_SIZE     服务端允许的房间人数硬上限，默认 16（范围 2–64）
 *
 * 防滥用上限。数量、速率类填 0 表示不限；大小、时长类没有「不限」，填 0 按默认值。
 * 默认值按「一家人在同一个 NAT 后面开几台设备」和「16 人房间一口气交换 SDP/ICE」
 * 留了余量，正常使用碰不到：
 *   MAX_CONNECTIONS   全服同时在线的连接数，默认 800（含还没完成 WebSocket 升级的）
 *   MAX_CONN_PER_IP   同一 IP 同时在线的连接数，默认 32；IPv6 按 /64 合并计
 *   MAX_ROOMS         全服同时存在的房间数，默认 400
 *   JOINS_PER_MIN     同一 IP 每分钟 join 次数（失败的也算），默认 60；令牌桶，攒满可一口气用完
 *   ROOMS_PER_MIN     同一 IP 每分钟新建房间数，默认 20
 *   MSG_RATE          每条连接每秒补充的消息令牌，默认 50。每条消息 1 个令牌，每满 1 KB 再加 1 个
 *   MSG_BURST         消息令牌桶容量，默认 max(1000, 60 × MAX_ROOM_SIZE)。令牌用光即断开
 *   MAX_MSG_BYTES     单条 WebSocket 消息上限（ws 的 maxPayload），默认 65536
 *   MAX_SIGNAL_BYTES  单条 signal 消息上限，超了不转发，默认 32768
 *   JOIN_TIMEOUT_MS   连上后多久没 join 就断开，默认 10000
 *   HEARTBEAT_MS      心跳间隔，一个间隔内不回 pong 就断开，默认 30000
 *   HTTP_TIMEOUT_MS   HTTP 请求头（含 WebSocket 升级请求）必须在多久内收完，默认 10000
 */

const crypto = require('crypto');
const http = require('http');
const net = require('net');
const { performance } = require('perf_hooks');
const { WebSocketServer } = require('ws');

/** 读整数环境变量：没填用默认值，填错了告警后用默认值，最后夹进 [min, max]。 */
function envInt(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`[signal] 环境变量 ${name}=${raw} 不是数字，按默认值 ${fallback} 处理`);
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * 大小、时长类：0 在这里没有「不限」的意思。夹到下限的话，HEARTBEAT_MS=0 会变成 100 毫秒一次心跳、
 * 把延迟稍高的人全踢掉，MAX_MSG_BYTES=0 会让 SDP 都发不出去 —— 不如当没填。
 */
function envPositive(name, fallback, min) {
  const n = envInt(name, fallback, Number.MIN_SAFE_INTEGER);
  if (n > 0) return Math.max(min, n);
  console.warn(`[signal] 环境变量 ${name} 必须大于 0，按默认值 ${fallback} 处理`);
  return fallback;
}

const PORT = parseInt(process.env.PORT, 10) || 8080;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ALLOW_UNKNOWN = process.env.ALLOW_UNKNOWN !== '0'; // 默认放行
const BLOCKED = new Set(
  (process.env.BLOCKED_COUNTRIES || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
);

const MAX_ROOM_SIZE = Math.max(2, Math.min(64, parseInt(process.env.MAX_ROOM_SIZE, 10) || 16));
// SDP 撑死几 KB，超过这个数就是有人在乱来
const MAX_MSG_BYTES = envPositive('MAX_MSG_BYTES', 64 * 1024, 4096);
const MAX_SIGNAL_BYTES = envPositive('MAX_SIGNAL_BYTES', 32 * 1024, 4096);
const JOIN_TIMEOUT_MS = envPositive('JOIN_TIMEOUT_MS', 10000, 100);
const HEARTBEAT_MS = envPositive('HEARTBEAT_MS', 30000, 100);
const HTTP_TIMEOUT_MS = envPositive('HTTP_TIMEOUT_MS', 10000, 100);

const MAX_CONNECTIONS = envInt('MAX_CONNECTIONS', 800);
// 一家人几台设备、一场局域网聚会十几台设备，都在同一个公网 IP 后面；
// 再加上断线重连时旧连接要等心跳才清掉，32 足够宽裕。
const MAX_CONN_PER_IP = envInt('MAX_CONN_PER_IP', 32);
const MAX_ROOMS = envInt('MAX_ROOMS', 400);
const JOINS_PER_MIN = envInt('JOINS_PER_MIN', 60);
const ROOMS_PER_MIN = envInt('ROOMS_PER_MIN', 20);

// 消息计价：每条 1 个令牌，每满 1 KB 再加 1 个。只按条数计的话，
// 同样的速率下每条都塞满 64 KB 就是几 MB/s 的 JSON 解析和转发。
function messageCost(bytes) {
  return 1 + Math.floor(bytes / 1024);
}
// 16 人房间里新人一进来，要给另外 15 人各回一份 SDP，再各发一二十条 ICE 候选
// （多网卡、IPv6、TURN 的 UDP/TCP/TLS 各算一条），一口气就是三四百条；
// 全员一起 ICE 重启也是这个量级。桶容量按房间人数上限放大，留两倍以上余量。
const MSG_RATE = envInt('MSG_RATE', 50);
// 桶至少得装得下一条最大的消息，不然那条消息永远发不出去
const MSG_BURST = Math.max(envPositive('MSG_BURST', Math.max(1000, 60 * MAX_ROOM_SIZE), 1), messageCost(MAX_MSG_BYTES));

/* ------------------------------ 出错不崩 ------------------------------ */

// 出错日志限流：能被外部输入触发的异常，不限流就是一条按请求放大的写日志通道
let errWindowStart = 0;
let errLogged = 0;
let errSuppressed = 0;
function logError(where, e) {
  const t = Date.now();
  if (t - errWindowStart >= 60000) {
    if (errSuppressed) console.error(`[signal] 上一分钟另有 ${errSuppressed} 条错误没有打印`);
    errWindowStart = t;
    errLogged = 0;
    errSuppressed = 0;
  }
  if (errLogged++ < 20) console.error(`[signal] ${where} 出错：`, e?.stack || e);
  else errSuppressed++;
}

/**
 * 任何回调里的异常都在这里兜住。异常一旦冒出 ws / http 的事件回调就是 uncaughtException，
 * 整个进程退出、所有房间的信令一起中断 —— 一个包就能打挂服务器。
 */
function guarded(where, fn, onError) {
  try {
    return fn();
  } catch (e) {
    logError(where, e);
    if (onError) {
      try {
        onError(e);
      } catch {}
    }
  }
}

/* ------------------------------ GeoIP 查询 ------------------------------ */

// maxmind 是可选依赖：没装或没配库文件就降级，不让服务器起不来。
let lookup = null;
(async () => {
  if (!BLOCKED.size) return; // 没开拦截就不用查库
  if (!process.env.MAXMIND_DB) {
    console.warn('[geo] 已启用拦截但未配置 MAXMIND_DB，将只依赖边缘头部（CF-IPCountry）判断地区');
    return;
  }
  try {
    const maxmind = require('maxmind');
    lookup = await maxmind.open(process.env.MAXMIND_DB);
    console.log('[geo] MaxMind 库已加载:', process.env.MAXMIND_DB);
  } catch (e) {
    console.error('[geo] MaxMind 加载失败，降级为只用边缘头部:', e.message);
  }
})();

/**
 * 取客户端 IP。
 *
 * X-Forwarded-For 是**追加**的：Cloudflare、nginx 的 $proxy_add_x_forwarded_for
 * 都是把自己看到的对端 IP 接在已有值后面。所以链条里唯一不可伪造的是**最后一段**
 * （由紧挨着我们的那层反代写入），而第一段是客户端自己带来的，随便填。
 * 原来取第一段，等于让任何人自称 127.0.0.1 —— 而局域网豁免会据此直接放行。
 */
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const hops = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1];
    }
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (real) return real;
  }
  return req.socket.remoteAddress || '';
}

/** 反代有没有转述客户端地址。没转述时 clientIp() 退回的套接字地址只是反代自己。 */
function hasForwardedIp(req) {
  if (!TRUST_PROXY) return false;
  const xff = String(req.headers['x-forwarded-for'] || '');
  return xff.split(',').some((s) => s.trim() !== '') || String(req.headers['x-real-ip'] || '').trim() !== '';
}

// 反代配置不对时，每 IP 上限会把所有人算在反代一个地址头上 —— 表现是「人一多就连不上」，
// 很难从现象猜到原因。各提示一次，不刷屏。
let warnedNoForwardedIp = false;
let warnedUntrustedProxy = false;
function warnIfProxyMisconfigured(req) {
  if (TRUST_PROXY) {
    if (warnedNoForwardedIp || hasForwardedIp(req)) return;
    warnedNoForwardedIp = true;
    console.warn(
      '[signal] TRUST_PROXY=1，但请求里没有 X-Forwarded-For / X-Real-IP：所有连接都会被当成来自反代自己，' +
        '共用同一份每 IP 上限，局域网豁免也不会生效。请让反代追加写 X-Forwarded-For。'
    );
    return;
  }
  if (warnedUntrustedProxy || !req.headers['x-forwarded-for']) return;
  warnedUntrustedProxy = true;
  console.warn(
    '[signal] 请求带着 X-Forwarded-For，看起来前面有反代，但没开 TRUST_PROXY：经反代来的连接都会算在' +
      '反代自己的地址上，共用同一份每 IP 上限。放在反代后面时请设 TRUST_PROXY=1。'
  );
}

/**
 * 限流用的地址键。IPv6 按 /64 合并：一户人家（或一台 VPS）分到的往往是一整段 /64，
 * 按单个地址计的话换个后缀就是「新 IP」，每 IP 上限形同虚设。
 */
function ipKey(ip) {
  let s = String(ip || '').trim().toLowerCase();
  if (s.startsWith('::ffff:') && net.isIPv4(s.slice(7))) return s.slice(7);
  if (net.isIPv4(s)) return s;
  s = s.split('%')[0]; // 链路本地地址的 zone id
  if (!net.isIPv6(s)) return s.slice(0, 64); // 反代转述了个认不出的东西（比如带端口），原样当键
  const [head, tail = null] = s.split('::');
  const groups = (part) => (part ? part.split(':') : []);
  // 嵌在末尾的 IPv4 占两组。它落在后 64 位里，只影响「::」要补几组零
  const width = (arr) => arr.reduce((n, g) => n + (g.includes('.') ? 2 : 1), 0);
  const h = groups(head);
  const t = tail === null ? [] : groups(tail);
  const full = tail === null ? h : [...h, ...Array(Math.max(0, 8 - width(h) - width(t))).fill('0'), ...t];
  return `${full.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

/** @returns {{country: string|null, source: string}} */
function countryOf(req) {
  // CDN/WAF 已经判过了就直接用，最快也最准
  if (TRUST_PROXY) {
    const cf = req.headers['cf-ipcountry'];
    if (cf && cf !== 'XX') return { country: String(cf).toUpperCase(), source: 'cf-header' };
  }

  if (lookup) {
    const ip = clientIp(req).replace(/^::ffff:/, '');
    try {
      const r = lookup.get(ip);
      const c = r?.country?.iso_code || r?.registered_country?.iso_code || null;
      if (c) return { country: String(c).toUpperCase(), source: 'maxmind' };
    } catch {}
  }

  return { country: null, source: 'unknown' };
}

/** 本机／局域网地址。只认真正的 IP 字面量，免得「10.evil」这种字符串也算内网。 */
function isPrivateAddress(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '');
  if (s === '::1') return true;
  if (!net.isIPv4(s)) return false;
  return s === '127.0.0.1' || s.startsWith('192.168.') || s.startsWith('10.');
}

/**
 * 直连时的本机／局域网豁免。
 *
 * 这里刻意**不用** clientIp()：不在反代后面时请求头全是客户端自己写的，
 * 一旦掺进任何请求头，攻击者自称内网地址就能直接跳过地区拦截。
 * 反代后面则反过来 —— 见 isExempt()。
 */
function isLoopback(req) {
  return isPrivateAddress(req.socket.remoteAddress);
}

/**
 * 地区拦截的豁免判据。
 *
 * 放在反代后面（TRUST_PROXY）时，所有连接的 TCP 对端都是反代自己 —— 同机 nginx / Caddy
 * 就是 127.0.0.1，k8s ingress 多半是 10.x。原来照样按套接字地址豁免，等于对所有人放行，
 * BLOCKED_COUNTRIES 静默失效，日志里连一条拒绝记录都没有。
 * 这时只认反代转述的客户端地址（和限流、查地区用的是同一个）；反代没转述就不豁免。
 */
function isExempt(req) {
  if (TRUST_PROXY) return hasForwardedIp(req) && isPrivateAddress(clientIp(req));
  return isLoopback(req);
}

function gate(req) {
  // 默认不拦任何人。地区策略在产品层面做到「告知 + 声明」为止，
  // 这里只在部署方显式配置了 BLOCKED_COUNTRIES 时才生效。
  if (!BLOCKED.size) return { allowed: true, country: null, reason: '未启用地区限制' };

  // 本机/内网连进来一律放行，否则自己没法调试
  if (isExempt(req)) return { allowed: true, country: null, reason: 'loopback/LAN' };

  const { country, source } = countryOf(req);

  if (!country) {
    return {
      allowed: ALLOW_UNKNOWN,
      country: null,
      reason: ALLOW_UNKNOWN ? '地区未知，按配置放行' : '无法确定来源地区',
      source,
    };
  }
  if (BLOCKED.has(country)) {
    return { allowed: false, country, reason: `本服务不面向 ${country} 地区`, source };
  }
  return { allowed: true, country, reason: 'ok', source };
}

/* ------------------------------- 限流 ------------------------------- */

const now = () => performance.now(); // 单调时钟：系统时间被往回调时，令牌桶不会倒扣

function refill(bucket, capacity, perSec) {
  const t = now();
  bucket.tokens = Math.min(capacity, bucket.tokens + (Math.max(0, t - bucket.at) / 1000) * perSec);
  bucket.at = t;
}

function takeTokens(bucket, capacity, perSec, cost = 1) {
  refill(bucket, capacity, perSec);
  if (bucket.tokens < cost) return false;
  bucket.tokens -= cost;
  return true;
}

/** 按来源 IP 计的令牌桶：每分钟 perMin 次，攒满了可以一口气用完。perMin 为 0 表示不限。 */
function ipLimiter(perMin) {
  const buckets = new Map();
  return {
    take(key) {
      if (!perMin) return true;
      let b = buckets.get(key);
      if (!b) {
        b = { tokens: perMin, at: now() };
        buckets.set(key, b);
      }
      return takeTokens(b, perMin, perMin / 60);
    },
    // 回满的桶和没有桶是一回事，删掉，表的大小就只跟最近一两分钟来过的 IP 数有关
    sweep() {
      for (const [key, b] of buckets) {
        refill(b, perMin, perMin / 60);
        if (b.tokens >= perMin) buckets.delete(key);
      }
    },
  };
}

const joinLimiter = ipLimiter(JOINS_PER_MIN);
const roomLimiter = ipLimiter(ROOMS_PER_MIN);

/** 每个 IP 当前占着的连接数。连接一断（socket 'close'）就还回去，只会还一次。 */
const connsByIp = new Map();
function acquireConnSlot(key, socket) {
  if (!MAX_CONN_PER_IP) return true;
  const n = connsByIp.get(key) || 0;
  if (n >= MAX_CONN_PER_IP) return false;
  connsByIp.set(key, n + 1);
  socket.once('close', () => {
    const left = (connsByIp.get(key) || 1) - 1;
    if (left > 0) connsByIp.set(key, left);
    else connsByIp.delete(key);
  });
  return true;
}

/* ------------------------------- 房间管理 ------------------------------- */

/** @type {Map<string, {members:Map<string, {ws:WebSocket, name:string}>, hostId:string, hostToken:string, maxMembers:number}>} */
const rooms = new Map();
// 和客户端 randomPeerId / randomRoomId 的字母表对齐（chat-safe base64 用了 '-' 和 '.'）。
// 只限上界和字符集：要防的是「超长标识符被存进房间表并按人数广播出去」这种
// 内存放大，以及奇怪字符混进日志。下界没有意义，短 id 是合法的。
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 房间容量。
 *
 * 0 的语义是「我没有意见，用默认值」—— 非房主的客户端 join 时发的正是 maxMembers: 0。
 * 原来 Math.max(2, …) 把它压成 2，于是只要房间碰巧是由游客先建起来的
 * （房主还没连上、或断线后房间被重建），容量就被永久钉死在 2 人，
 * 后面所有人都会撞上 ROOM_FULL，而房主根本不知道发生了什么。
 */
function normalizeCapacity(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return Math.min(4, MAX_ROOM_SIZE);
  return Math.max(2, Math.min(MAX_ROOM_SIZE, n));
}

/**
 * 房间是内存态的，空了即删，所以 hostId 只能认「第一个加入的人」——
 * 房主断线后房间被重建时，这个答案就是错的。服务端没有能绑定房主身份的凭据，
 * 真正的锚点在客户端：加入者拿邀请码里的 hostId 和 joined.hostId 比对，
 * 对不上就拒绝进房（见 app.js 的「房主身份与邀请码不一致」）。
 * 这里再加一道 HOST_ID_RESERVED，房间存续期间不许别人顶替房主的 peerId。
 *
 * 但 peerId 是公开的（joined.peers 会发给全房），光凭它分不清「房主本人断线重连」
 * 和「别人顶着房主的 id 来接管」。所以建房时再发一张只有房主拿得到的续期凭据
 * hostToken：只随房主自己的 joined 回去，不广播、不进邀请码。房主重连时带上它，
 * 对得上才放行，对不上仍是 HOST_ID_RESERVED。
 */
function roomOf(id, creatorId, requestedCapacity) {
  if (!rooms.has(id)) {
    rooms.set(id, {
      members: new Map(),
      hostId: creatorId,
      hostToken: crypto.randomBytes(24).toString('base64url'),
      maxMembers: normalizeCapacity(requestedCapacity),
    });
  }
  return rooms.get(id);
}

/** 恒定时间比较，不让逐字节的比较耗时泄露凭据前缀。 */
function hostTokenMatches(room, token) {
  if (typeof token !== 'string' || !token) return false;
  const expected = Buffer.from(room.hostToken);
  const given = Buffer.from(token);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function leave(ws) {
  if (!ws.roomId || !ws.peerId) return;
  const room = rooms.get(ws.roomId);
  // 只删自己那一条。心跳清理和随后的 close 事件会各调一次：第二次不能再广播一遍 peer-leave，
  // 更不能在同一个 peerId 已经换新连接回来之后，把新连接那一条也删掉。
  if (!room || room.members.get(ws.peerId)?.ws !== ws) return;

  room.members.delete(ws.peerId);
  for (const { ws: other } of room.members.values()) {
    sendJson(other, { t: 'peer-leave', peerId: ws.peerId });
  }
  if (room.members.size === 0) rooms.delete(ws.roomId);
  console.log(`[room] ${ws.peerId} 离开 ${ws.roomId}（剩 ${room.members.size} 人）`);
}

// 一条连接允许积压多少待发字节。ws 的 maxPayload 只限单条消息大小，不限条数，
// 而 Node 的 socket 写缓冲是无界增长的 —— 一个收得慢（或干脆不收）的客户端，
// 配上一个猛发的同伴，就能把服务器的堆写爆。
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

function sendJson(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    // 这条连接已经堵死了，再往里灌只会耗内存。直接断开，客户端会自己重连。
    try {
      ws.close(4008, 'SLOW_CONSUMER');
    } catch {}
    return;
  }
  ws.send(JSON.stringify(obj));
}

function fail(ws, code, message) {
  // 判了死刑的连接不再处理任何消息：否则关掉前的 50 ms 里还能接着 join、接着刷
  if (ws.closing) return;
  ws.closing = true;
  clearTimeout(ws.joinTimer);
  sendJson(ws, { t: 'error', code, message });
  setTimeout(() => {
    try {
      ws.close(4003, code); // 给客户端一点时间收到再断
    } catch {}
  }, 50);
}

function report(ws, code, message) {
  sendJson(ws, { t: 'error', code, message });
}

/* ------------------------------- 消息处理 ------------------------------- */

function handleJoin(ws, msg, verdict) {
  if (ws.roomId) return fail(ws, 'ALREADY_JOINED', '这个连接已经在房间里了');
  // 每次 join 都会向全房广播 peer-join，房里每个人随即新建一条 RTCPeerConnection 发 offer ——
  // 反复进进出出就能把一个房间拖垮。按来源 IP 限次数，被拒的尝试也算。
  if (!joinLimiter.take(ws.ipKey)) return fail(ws, 'JOIN_RATE_LIMITED', '加入房间太频繁，请稍后再试');
  if (!msg.roomId || !msg.peerId) return fail(ws, 'BAD_JOIN', 'join 需要 roomId 和 peerId');

  // 先校验类型再使用，之后只用校验过的这两个变量。原来拿 String(x) 过正则、
  // 却拿原值去查重和比房主：peerId 传 ["<房主 id>"]，正则看到的是字符串，
  // Map.has 和 === 看到的是数组，DUP_PEER、HOST_ID_RESERVED 两道都被绕过，
  // 写表时又转回字符串，把真房主那一条覆盖掉 —— 谁拿到房间码都能顶替房主。
  const { roomId, peerId } = msg;
  // name 一直是截断的，roomId / peerId 却完全不限长 —— 它们会被存进房间表
  // 并广播给全房，等于一个按人数放大的内存写入口。
  if (typeof roomId !== 'string' || typeof peerId !== 'string' || !ID_RE.test(roomId) || !ID_RE.test(peerId)) {
    return fail(ws, 'BAD_JOIN', 'roomId 和 peerId 只能是 1-128 位的字母、数字、点、横线或下划线');
  }
  if (msg.name != null && typeof msg.name !== 'string') return fail(ws, 'BAD_JOIN', 'name 必须是字符串');
  if (msg.maxMembers != null && !Number.isFinite(msg.maxMembers)) {
    return fail(ws, 'BAD_JOIN', 'maxMembers 必须是数字');
  }
  // 续期凭据不是字符串就当没带：冒名者照样撞 HOST_ID_RESERVED
  const hostToken = typeof msg.hostToken === 'string' ? msg.hostToken : null;

  if (!rooms.has(roomId)) {
    if (MAX_ROOMS && rooms.size >= MAX_ROOMS) return fail(ws, 'SERVER_FULL', '服务器的房间数已满，请稍后再试');
    if (!roomLimiter.take(ws.ipKey)) return fail(ws, 'ROOM_RATE_LIMITED', '创建房间太频繁，请稍后再试');
  }
  const room = roomOf(roomId, peerId, msg.maxMembers);
  const claimsHost = peerId === room.hostId;
  // 房主掉线期间替他留着一个名额：否则他重连的那几秒里补进来一个人，
  // 房主就会一直撞 ROOM_FULL，直到有人主动离开。
  const hostSeat = claimsHost || room.members.has(room.hostId) ? 0 : 1;
  if (room.members.size + hostSeat >= room.maxMembers) {
    return fail(ws, 'ROOM_FULL', `房间已满（上限 ${room.maxMembers} 人）`);
  }
  if (room.members.has(peerId)) return fail(ws, 'DUP_PEER', 'peerId 已被占用');
  // 房主的 peerId 会随 joined.peers 广播给全房，而客户端把「peerId === hostId」
  // 当成房主身份的唯一凭据。房主的信令连接一掉线，房内任何人都能顶着他的
  // peerId 重新 join，接管全场控制权。房间还在、位置空着，也不能让别人补位 ——
  // 只有拿得出续期凭据的房主本人能回来。
  if (claimsHost && room.members.size > 0 && !hostTokenMatches(room, hostToken)) {
    return fail(ws, 'HOST_ID_RESERVED', '这个身份是房主的，房间存续期间不能被顶替');
  }

  clearTimeout(ws.joinTimer);
  ws.roomId = roomId;
  ws.peerId = peerId;
  ws.name = (msg.name || peerId).slice(0, 40);

  // 先把现有成员告诉新人，再通知老成员 —— 顺序反了新人会漏掉自己
  const existing = [...room.members.entries()].map(([id, v]) => ({ peerId: id, name: v.name }));
  room.members.set(peerId, { ws, name: ws.name });

  sendJson(ws, {
    t: 'joined',
    roomId,
    peerId,
    peers: existing,
    country: verdict.country,
    hostId: room.hostId,
    maxMembers: room.maxMembers,
    // 续期凭据只回给房主本人；别人拿到它就能在房主掉线时冒名重连
    ...(peerId === room.hostId ? { hostToken: room.hostToken } : {}),
  });
  for (const [id, v] of room.members) {
    if (id !== peerId) sendJson(v.ws, { t: 'peer-join', peerId, name: ws.name });
  }

  console.log(`[room] ${peerId}(${ws.name}) 加入 ${roomId}（${room.members.size}/${room.maxMembers} 人）`);
}

function handleRoomConfig(ws, msg) {
  if (!ws.roomId) return report(ws, 'NOT_JOINED', '还没加入房间');
  const room = rooms.get(ws.roomId);
  if (!room || room.hostId !== ws.peerId) return report(ws, 'NOT_HOST', '只有房主能修改房间人数');
  if (!Number.isFinite(msg.maxMembers)) return report(ws, 'BAD_CONFIG', 'maxMembers 必须是数字');
  const next = normalizeCapacity(msg.maxMembers);
  if (next < room.members.size) {
    return report(ws, 'CAPACITY_TOO_SMALL', `当前已有 ${room.members.size} 人，人数上限不能设得更小`);
  }
  room.maxMembers = next;
  for (const { ws: member } of room.members.values()) {
    sendJson(member, { t: 'room-config', maxMembers: next });
  }
  console.log(`[room] ${ws.roomId} 人数上限改为 ${next}`);
}

function handleSignal(ws, msg, bytes) {
  if (!ws.roomId) return fail(ws, 'NOT_JOINED', '还没加入房间');
  // SDP 连同全部候选也就几 KB；再大就是拿服务器当免费中转，不转发
  if (bytes > MAX_SIGNAL_BYTES) {
    return report(ws, 'SIGNAL_TOO_LARGE', `信令消息太大（上限 ${MAX_SIGNAL_BYTES} 字节）`);
  }
  // 只转发，不看内容 —— 但至少得是个对象：客户端收到后直接读 payload.kind，
  // 转过去一个 null 就是在对面的渲染进程里抛异常。
  if (typeof msg.to !== 'string' || !isPlainObject(msg.payload)) {
    return report(ws, 'BAD_SIGNAL', 'signal 需要字符串 to 和对象 payload');
  }
  const target = rooms.get(ws.roomId)?.members.get(msg.to);
  if (!target) return; // 人已经走了，静默丢弃

  // from 用服务端记录的值，不信客户端自报。
  sendJson(target.ws, { t: 'signal', from: ws.peerId, name: ws.name, payload: msg.payload });
}

function handleMessage(ws, raw, verdict) {
  const bytes = raw.length;
  if (MSG_RATE && !takeTokens(ws.msgBucket, MSG_BURST, MSG_RATE, messageCost(bytes))) {
    return fail(ws, 'RATE_LIMITED', '消息发得太快，连接已断开');
  }

  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return fail(ws, 'BAD_JSON', '消息不是合法 JSON');
  }
  // JSON.parse('null') 是合法的。原来接着就读 msg.t，抛出的 TypeError 冒出 ws 的回调，
  // 一条四个字节的消息就能把整个进程打挂。
  if (!isPlainObject(msg)) return fail(ws, 'BAD_JSON', '消息必须是 JSON 对象');

  switch (msg.t) {
    case 'join':
      return handleJoin(ws, msg, verdict);
    case 'room-config':
      return handleRoomConfig(ws, msg);
    case 'signal':
      return handleSignal(ws, msg, bytes);
    case 'ping':
      return sendJson(ws, { t: 'pong' });
    default:
      return; // 不认识的类型不理，留给以后的客户端
  }
}

/* -------------------------------- 服务器 -------------------------------- */

const server = http.createServer(
  {
    // 慢速连接占坑：只发半截请求头，或者一个字节一个字节地挤。WebSocket 的升级请求
    // 也是普通 HTTP 请求，这两个超时一样管得到；升级完成后连接就不归 HTTP 层管了。
    headersTimeout: HTTP_TIMEOUT_MS,
    requestTimeout: HTTP_TIMEOUT_MS,
    // 上面两个超时靠定时巡检发现，默认 30 秒巡一次，会让它们多拖半分钟
    connectionsCheckingInterval: Math.min(1000, HTTP_TIMEOUT_MS),
  },
  (req, res) =>
    guarded(
      'http',
      () => {
        if (req.url === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
        }
        res.writeHead(404).end();
      },
      () => res.destroy()
    )
);
// 连上之后一个字节都不发的空连接：请求头超时从第一个字节才开始算，得靠套接字空闲超时清掉。
// 升级成 WebSocket 时 ws 会把它清零，长连接不受影响（死连接归心跳管）。
server.timeout = HTTP_TIMEOUT_MS;
// 全服连接数上限在 TCP 层卡：超了 Node 直接关掉新连接，连 HTTP 解析都不做。
// 顺带也挡住文件句柄被耗光（Linux 默认 ulimit -n 是 1024）。
if (MAX_CONNECTIONS) server.maxConnections = MAX_CONNECTIONS;

// 不在反代后面时，TCP 对端就是客户端本人：在这一层按 IP 计数，还没升级的空连接也算进去。
// 反代后面这里看到的全是反代自己的地址，改到 'upgrade' 里按转述的地址计。
server.on('connection', (socket) =>
  guarded(
    'connection',
    () => {
      if (TRUST_PROXY) return;
      if (!acquireConnSlot(ipKey(socket.remoteAddress), socket)) socket.destroy();
    },
    () => socket.destroy()
  )
);

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_BYTES });

function rejectUpgrade(socket, status, text) {
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

server.on('upgrade', (req, socket, head) => {
  // 升级请求一到，HTTP 层就把自己挂在套接字上的 error 监听摘掉了；
  // 在 ws 接手之前（或者这里直接拒掉时）对端一个 RST 就是没人接的 'error'，进程直接退出。
  socket.on('error', () => {});
  guarded(
    'upgrade',
    () => {
      warnIfProxyMisconfigured(req);
      const key = ipKey(clientIp(req));
      if (TRUST_PROXY && !acquireConnSlot(key, socket)) return rejectUpgrade(socket, 429, 'Too Many Requests');
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.ipKey = key;
        wss.emit('connection', ws, req);
      });
    },
    () => socket.destroy()
  );
});

wss.on('connection', (ws, req) => {
  // 先挂 error：ws 在没有 error 监听的时候直接抛出。原来被地区拦截的连接不挂监听就返回，
  // 它在被关掉之前的 50 ms 里发一个超长帧，就能把整个进程带崩。
  ws.on('error', () => guarded('ws error', () => leave(ws)));
  ws.on('close', () =>
    guarded('ws close', () => {
      clearTimeout(ws.joinTimer);
      leave(ws);
    })
  );
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  guarded(
    'ws connection',
    () => {
      const verdict = gate(req);
      if (!verdict.allowed) {
        console.log(`[geo] 拒绝 ${clientIp(req)}（${verdict.country || '未知'}）：${verdict.reason}`);
        return fail(ws, 'REGION_BLOCKED', verdict.reason);
      }

      ws.msgBucket = { tokens: MSG_BURST, at: now() };
      // 连上不 join 的连接不留着占资源
      ws.joinTimer = setTimeout(() => {
        if (!ws.roomId) fail(ws, 'JOIN_TIMEOUT', '连接后未加入任何房间');
      }, JOIN_TIMEOUT_MS);

      ws.on('message', (raw) => {
        if (ws.closing) return;
        guarded(
          'message',
          () => handleMessage(ws, raw, verdict),
          () => fail(ws, 'INTERNAL_ERROR', '服务器处理这条消息时出错')
        );
      });
    },
    () => ws.terminate()
  );
});

// 定期清理死连接：TCP 半开的情况下 close 事件不会来，房间里会留幽灵成员
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    guarded('heartbeat', () => {
      if (!ws.isAlive) {
        leave(ws);
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }
}, HEARTBEAT_MS);

// 按 IP 计的限流表定期清掉回满的桶，不然每个来过的 IP 都会永远占一格内存
const sweeper = setInterval(() => {
  joinLimiter.sweep();
  roomLimiter.sweep();
}, 60000);

wss.on('close', () => {
  clearInterval(heartbeat);
  clearInterval(sweeper);
});

// 端口被占是最常见的启动失败，别拿一坨堆栈糊用户脸上。
// 但只有启动阶段的错误才值得退出：已经在服务时 http server 报的 'error' 是 accept 失败
// （文件句柄被占满之类），那是暂时的 —— 这时退出，等于替攻击者把服务关了。
let listening = false;
function onServerError(e) {
  if (listening) return logError('server', e);
  if (e.code === 'EADDRINUSE') {
    console.error(`[signal] 端口 ${PORT} 已被占用。换一个端口再试：PORT=8081 npm run signal`);
  } else if (e.code === 'EACCES') {
    console.error(`[signal] 没有权限监听端口 ${PORT}（1024 以下的端口通常需要管理员权限）`);
  } else {
    console.error('[signal] 启动失败:', e.message);
  }
  process.exit(1);
}
server.on('error', onServerError);
// noServer 模式下 ws 不再转发底层 server 的错误；留个监听以防万一，别让它变成 unhandled 'error'
wss.on('error', (e) => logError('wss', e));

server.listen(PORT, () => {
  listening = true;
  console.log(`[signal] 监听 :${PORT}`);
  if (BLOCKED.size) {
    console.log(`[signal] 拦截地区：${[...BLOCKED].join(', ')}`);
    console.log(`[signal] 地区未知时：${ALLOW_UNKNOWN ? '放行' : '拒绝'}`);
    console.log(`[signal] 信任代理头部：${TRUST_PROXY ? '是' : '否'}`);
  } else {
    console.log('[signal] 地区限制：未启用（设置 BLOCKED_COUNTRIES 可开启强制拦截）');
  }
  const limit = (n) => (n ? String(n) : '不限');
  console.log(
    `[signal] 上限：连接 ${limit(MAX_CONNECTIONS)}，每 IP ${limit(MAX_CONN_PER_IP)}，房间 ${limit(MAX_ROOMS)}，` +
      `每 IP 每分钟 join ${limit(JOINS_PER_MIN)} 次、建房 ${limit(ROOMS_PER_MIN)} 次`
  );
});

function shutdown() {
  console.log('\n[signal] 正在关闭…');
  clearInterval(heartbeat);
  clearInterval(sweeper);
  for (const ws of wss.clients) ws.close(1001, 'server shutdown');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
