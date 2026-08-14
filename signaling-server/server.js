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
 *   TRUST_PROXY       =1 时信任 X-Forwarded-For / CF-IPCountry（放在 CDN/WAF 后面时开）
 *   BLOCKED_COUNTRIES 逗号分隔的 ISO 国家码，默认空 —— 即不拦任何人
 *   ALLOW_UNKNOWN     =0 时查不到地区就拒绝（默认 1，放行）
 *   MAX_ROOM_SIZE     服务端允许的房间人数硬上限，默认 16（范围 2–64）
 */

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT, 10) || 8080;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ALLOW_UNKNOWN = process.env.ALLOW_UNKNOWN !== '0'; // 默认放行
const BLOCKED = new Set(
  (process.env.BLOCKED_COUNTRIES || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
);

const MAX_ROOM_SIZE = Math.max(2, Math.min(64, parseInt(process.env.MAX_ROOM_SIZE, 10) || 16));
const MAX_MSG_BYTES = 64 * 1024; // SDP 撑死几 KB，超过这个数就是有人在乱来
const JOIN_TIMEOUT_MS = 10000;

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

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
    const real = req.headers['x-real-ip'];
    if (real) return String(real).trim();
  }
  return req.socket.remoteAddress || '';
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

function isLoopback(req) {
  const ip = clientIp(req).replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.');
}

function gate(req) {
  // 默认不拦任何人。地区策略在产品层面做到「告知 + 声明」为止，
  // 这里只在部署方显式配置了 BLOCKED_COUNTRIES 时才生效。
  if (!BLOCKED.size) return { allowed: true, country: null, reason: '未启用地区限制' };

  // 本机/内网连进来一律放行，否则自己没法调试
  if (isLoopback(req)) return { allowed: true, country: null, reason: 'loopback/LAN' };

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

/* ------------------------------- 房间管理 ------------------------------- */

/** @type {Map<string, {members:Map<string, {ws:WebSocket, name:string}>, hostId:string, maxMembers:number}>} */
const rooms = new Map();

function normalizeCapacity(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(2, Math.min(MAX_ROOM_SIZE, n)) : Math.min(4, MAX_ROOM_SIZE);
}

function roomOf(id, creatorId, requestedCapacity) {
  if (!rooms.has(id)) {
    rooms.set(id, {
      members: new Map(),
      hostId: creatorId,
      maxMembers: normalizeCapacity(requestedCapacity),
    });
  }
  return rooms.get(id);
}

function leave(ws) {
  if (!ws.roomId || !ws.peerId) return;
  const room = rooms.get(ws.roomId);
  if (!room) return;

  room.members.delete(ws.peerId);
  for (const { ws: other } of room.members.values()) {
    sendJson(other, { t: 'peer-leave', peerId: ws.peerId });
  }
  if (room.members.size === 0) rooms.delete(ws.roomId);
  console.log(`[room] ${ws.peerId} 离开 ${ws.roomId}（剩 ${room.members.size} 人）`);
}

function sendJson(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function fail(ws, code, message) {
  sendJson(ws, { t: 'error', code, message });
  setTimeout(() => ws.close(4003, code), 50); // 给客户端一点时间收到再断
}

function report(ws, code, message) {
  sendJson(ws, { t: 'error', code, message });
}

/* -------------------------------- 服务器 -------------------------------- */

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MSG_BYTES });

wss.on('connection', (ws, req) => {
  const verdict = gate(req);
  if (!verdict.allowed) {
    console.log(`[geo] 拒绝 ${clientIp(req)}（${verdict.country || '未知'}）：${verdict.reason}`);
    return fail(ws, 'REGION_BLOCKED', verdict.reason);
  }

  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  // 连上不 join 的连接不留着占资源
  const joinTimer = setTimeout(() => {
    if (!ws.roomId) fail(ws, 'JOIN_TIMEOUT', '连接后未加入任何房间');
  }, JOIN_TIMEOUT_MS);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return fail(ws, 'BAD_JSON', '消息不是合法 JSON');
    }

    if (msg.t === 'join') {
      if (ws.roomId) return fail(ws, 'ALREADY_JOINED', '这个连接已经在房间里了');
      if (!msg.roomId || !msg.peerId) return fail(ws, 'BAD_JOIN', 'join 需要 roomId 和 peerId');

      const room = roomOf(String(msg.roomId), String(msg.peerId), msg.maxMembers);
      if (room.members.size >= room.maxMembers) return fail(ws, 'ROOM_FULL', `房间已满（上限 ${room.maxMembers} 人）`);
      if (room.members.has(msg.peerId)) return fail(ws, 'DUP_PEER', 'peerId 已被占用');

      clearTimeout(joinTimer);
      ws.roomId = String(msg.roomId);
      ws.peerId = String(msg.peerId);
      ws.name = String(msg.name || msg.peerId).slice(0, 40);

      // 先把现有成员告诉新人，再通知老成员 —— 顺序反了新人会漏掉自己
      const existing = [...room.members.entries()].map(([peerId, v]) => ({ peerId, name: v.name }));
      room.members.set(ws.peerId, { ws, name: ws.name });

      sendJson(ws, {
        t: 'joined',
        roomId: ws.roomId,
        peerId: ws.peerId,
        peers: existing,
        country: verdict.country,
        hostId: room.hostId,
        maxMembers: room.maxMembers,
      });
      for (const [peerId, v] of room.members) {
        if (peerId !== ws.peerId) sendJson(v.ws, { t: 'peer-join', peerId: ws.peerId, name: ws.name });
      }

      console.log(`[room] ${ws.peerId}(${ws.name}) 加入 ${ws.roomId}（${room.members.size}/${room.maxMembers} 人）`);
      return;
    }

    if (msg.t === 'room-config') {
      if (!ws.roomId) return report(ws, 'NOT_JOINED', '还没加入房间');
      const room = rooms.get(ws.roomId);
      if (!room || room.hostId !== ws.peerId) return report(ws, 'NOT_HOST', '只有房主能修改房间人数');
      const next = normalizeCapacity(msg.maxMembers);
      if (next < room.members.size) {
        return report(ws, 'CAPACITY_TOO_SMALL', `当前已有 ${room.members.size} 人，人数上限不能设得更小`);
      }
      room.maxMembers = next;
      for (const { ws: member } of room.members.values()) {
        sendJson(member, { t: 'room-config', maxMembers: next });
      }
      console.log(`[room] ${ws.roomId} 人数上限改为 ${next}`);
      return;
    }

    if (msg.t === 'signal') {
      if (!ws.roomId) return fail(ws, 'NOT_JOINED', '还没加入房间');
      const room = rooms.get(ws.roomId);
      const target = room?.members.get(String(msg.to));
      if (!target) return; // 人已经走了，静默丢弃

      // 只转发，不看内容。from 用服务端记录的值，不信客户端自报。
      sendJson(target.ws, { t: 'signal', from: ws.peerId, name: ws.name, payload: msg.payload });
      return;
    }

    if (msg.t === 'ping') return sendJson(ws, { t: 'pong' });
  });

  ws.on('close', () => {
    clearTimeout(joinTimer);
    leave(ws);
  });
  ws.on('error', () => {
    clearTimeout(joinTimer);
    leave(ws);
  });
});

// 定期清理死连接：TCP 半开的情况下 close 事件不会来，房间里会留幽灵成员
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      leave(ws);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

// 端口被占是最常见的启动失败，别拿一坨堆栈糊用户脸上。
// 注意 http server 和 WebSocketServer 两边都要挂 —— ws 会把底层 server 的错误
// 在自己身上重新 emit 一遍，漏掉任何一个都会变成 unhandled 'error' 直接崩。
function onFatal(e) {
  if (e.code === 'EADDRINUSE') {
    console.error(`[signal] 端口 ${PORT} 已被占用。换一个端口再试：PORT=8081 npm run signal`);
  } else if (e.code === 'EACCES') {
    console.error(`[signal] 没有权限监听端口 ${PORT}（1024 以下的端口通常需要管理员权限）`);
  } else {
    console.error('[signal] 启动失败:', e.message);
  }
  process.exit(1);
}
server.on('error', onFatal);
wss.on('error', onFatal);

server.listen(PORT, () => {
  console.log(`[signal] 监听 :${PORT}`);
  if (BLOCKED.size) {
    console.log(`[signal] 拦截地区：${[...BLOCKED].join(', ')}`);
    console.log(`[signal] 地区未知时：${ALLOW_UNKNOWN ? '放行' : '拒绝'}`);
    console.log(`[signal] 信任代理头部：${TRUST_PROXY ? '是' : '否'}`);
  } else {
    console.log('[signal] 地区限制：未启用（设置 BLOCKED_COUNTRIES 可开启强制拦截）');
  }
});

function shutdown() {
  console.log('\n[signal] 正在关闭…');
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, 'server shutdown');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
