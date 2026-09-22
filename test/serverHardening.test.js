'use strict';

/**
 * 信令服务器的输入校验与防滥用（0.7.5 审计）。
 *
 * 守住的几件事：
 * - 一条 JSON `null`（或任何不是对象的 JSON）不能把进程打挂；各字段类型不对一律拒掉。
 * - peerId / roomId 传数组、数字不能绕过 DUP_PEER / HOST_ID_RESERVED 顶替别人。
 * - TRUST_PROXY 下，套接字地址是反代自己，不能拿来做局域网豁免。
 * - 连接数、消息速率、join / 建房频率、房间总数、消息大小、心跳、HTTP 慢速连接都有上限，
 *   而默认值不误伤「同一个 NAT 后面十几台设备」和「16 人房间一口气交换 SDP/ICE」。
 *
 * 全部起真服务器（127.0.0.1 随机端口），用 ws 客户端打。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const WebSocket = require('ws');

const SERVER = path.join(__dirname, '..', 'signaling-server', 'server.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 起一个真信令服务器；端口随机，撞上被占用的就换一个再试。 */
async function startServer(t, env = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 40000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        PORT: String(port),
        MAX_ROOM_SIZE: '16',
        BLOCKED_COUNTRIES: '',
        TRUST_PROXY: '',
        NOXREEL_TEST_MUTE: '1',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const ready = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000);
      child.stdout.on('data', (chunk) => {
        if (chunk.toString().includes(`监听 :${port}`)) {
          clearTimeout(timer);
          resolve(true);
        }
      });
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (ready) {
      t.after(() => child.kill());
      return {
        url: `ws://127.0.0.1:${port}`,
        port,
        child,
        alive: () => child.exitCode === null && child.signalCode === null,
        stderr: () => stderr,
      };
    }
    child.kill();
    if (!stderr.includes('已被占用')) throw new Error(`信令服务器启动失败：${stderr}`);
  }
  throw new Error('连续几个端口都被占用，信令服务器起不来');
}

/**
 * 试着连上。连上了返回带收件箱的客户端，被拒了返回 { ok:false, error }。
 * 所有连上的客户端都登记到 clients 里，测试结束统一关掉。
 */
function tryConnect(url, { headers, clients } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    const inbox = [];
    const waiters = new Set();
    let closeInfo = null;
    const closed = new Promise((res) =>
      ws.once('close', (code, reason) => {
        closeInfo = { code, reason: reason.toString() };
        res(closeInfo);
      })
    );
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      inbox.push(msg);
      for (const w of [...waiters]) {
        if (w.pred(msg)) {
          waiters.delete(w);
          w.resolve(msg);
        }
      }
    });
    ws.once('open', () => {
      const c = {
        ok: true,
        ws,
        inbox,
        closed,
        isClosed: () => closeInfo !== null,
        send: (obj) => ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)),
        waitFor(pred, what = '消息', timeoutMs = 3000) {
          const hit = inbox.find(pred);
          if (hit) return Promise.resolve(hit);
          return new Promise((res, rej) => {
            const w = {
              pred,
              resolve: (msg) => {
                clearTimeout(timer);
                res(msg);
              },
            };
            const timer = setTimeout(() => {
              waiters.delete(w);
              rej(new Error(`等待${what}超时`));
            }, timeoutMs);
            waiters.add(w);
          });
        },
        close() {
          if (closeInfo) return Promise.resolve();
          ws.close();
          return Promise.race([closed, sleep(1000).then(() => ws.terminate())]);
        },
      };
      clients?.push(c);
      resolve(c);
    });
    ws.on('error', (error) => {
      if (ws.readyState !== WebSocket.OPEN) resolve({ ok: false, error });
    });
  });
}

async function connect(url, opts) {
  const c = await tryConnect(url, opts);
  if (!c.ok) throw new Error(`连不上信令服务器：${c.error.message}`);
  return c;
}

async function join(url, roomId, peerId, { clients, headers, ...extra } = {}) {
  const c = await connect(url, { clients, headers });
  c.send({ t: 'join', roomId, peerId, name: peerId, maxMembers: 0, ...extra });
  c.reply = await c.waitFor((m) => m.t === 'joined' || m.t === 'error', `${peerId} 的 join 答复`);
  return c;
}

/** 一条连接收到 error 之后必须被服务器断开。 */
async function expectRejected(c, code) {
  const err = await c.waitFor((m) => m.t === 'error', `${code} 错误`);
  assert.equal(err.code, code, `期望 ${code}，实际 ${JSON.stringify(err)}`);
  await Promise.race([c.closed, sleep(2000).then(() => assert.fail(`${code} 之后连接没被断开`))]);
  return err;
}

/** 等服务器那边把一个连接的名额还回来：反复试连，直到连上为止。 */
async function connectEventually(url, opts, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const c = await tryConnect(url, opts);
    if (c.ok) return c;
    if (Date.now() > deadline) throw new Error(`名额一直没还回来：${c.error.message}`);
    await sleep(100);
  }
}

/** 等服务器的 stderr 里出现某段话（console.warn 是异步到达的）。 */
async function waitForStderr(srv, text, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!srv.stderr().includes(text)) {
    if (Date.now() > deadline) assert.fail(`服务器没有提示「${text}」：${srv.stderr()}`);
    await sleep(50);
  }
}

/** 原始 TCP 连接，记下被服务器关掉的时刻。 */
function rawSocket(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const started = Date.now();
    socket.closedAfter = new Promise((res) => socket.once('close', () => res(Date.now() - started)));
    socket.on('error', () => {});
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

/* ------------------------------ 非法输入 ------------------------------ */

test('非对象的 JSON（null、数组、数字、字符串、布尔）被拒，进程不崩', { timeout: 20000 }, async (t) => {
  const clients = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));
  const srv = await startServer(t);

  // null 曾经一条就打挂整个进程：JSON.parse 合法返回 null，紧接着读 null.t
  for (const raw of ['null', '[]', '[null]', '[{"t":"join"}]', '1', '"join"', 'true', 'false']) {
    const c = await connect(srv.url, { clients });
    c.send(raw);
    await expectRejected(c, 'BAD_JSON');
    assert.ok(srv.alive(), `发 ${raw} 之后信令服务器退出了：${srv.stderr()}`);
  }

  // 已经进了房的连接发 null 也一样
  const host = await join(srv.url, 'null-room', 'host', { clients, maxMembers: 4 });
  assert.equal(host.reply.t, 'joined');
  const guest = await join(srv.url, 'null-room', 'guest', { clients });
  guest.send('null');
  await expectRejected(guest, 'BAD_JSON');
  await host.waitFor((m) => m.t === 'peer-leave' && m.peerId === 'guest', '被断开者的 peer-leave');
  assert.ok(srv.alive(), srv.stderr());

  const after = await join(srv.url, 'null-room', 'late', { clients });
  assert.equal(after.reply.t, 'joined', '服务器还活着，新人照样能进房');
});

test('各字段类型不对一律拒掉，乱七八糟的消息一条都打不挂进程', { timeout: 30000 }, async (t) => {
  const clients = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));
  const srv = await startServer(t);

  const badJoins = [
    { roomId: ['r'], peerId: 'p' },
    { roomId: 'r', peerId: ['p'] },
    { roomId: { r: 1 }, peerId: 'p' },
    { roomId: 'r', peerId: 42 },
    { roomId: 7, peerId: 'p' },
    { roomId: 'r', peerId: true },
    { roomId: 'r', peerId: 'p', name: { x: 1 } },
    { roomId: 'r', peerId: 'p', name: ['n'] },
    { roomId: 'r', peerId: 'p', name: 5 },
    { roomId: 'r', peerId: 'p', maxMembers: '5' },
    { roomId: 'r', peerId: 'p', maxMembers: [5] },
    { roomId: 'r', peerId: 'p', maxMembers: { n: 5 } },
    { roomId: 'r', peerId: 'p', maxMembers: true },
  ];
  for (const fields of badJoins) {
    const c = await connect(srv.url, { clients });
    c.send({ t: 'join', ...fields });
    await expectRejected(c, 'BAD_JOIN');
  }
  assert.equal(srv.alive(), true, srv.stderr());

  // 进了房之后再发各种奇形怪状的消息：服务器活着、正常成员照常收发
  const host = await join(srv.url, 'fuzz-room', 'host', { clients, maxMembers: 4 });
  const guest = await join(srv.url, 'fuzz-room', 'guest', { clients });
  const junk = [
    { t: null },
    { t: ['signal'] },
    { t: { t: 'signal' } },
    { t: 'signal' },
    { t: 'signal', to: null, payload: null },
    { t: 'signal', to: ['guest'], payload: { kind: 'x' } },
    { t: 'signal', to: { id: 'guest' }, payload: { kind: 'x' } },
    { t: 'signal', to: 'guest', payload: null },
    { t: 'signal', to: 'guest', payload: [1, 2] },
    { t: 'signal', to: 'guest', payload: 'offer' },
    { t: 'signal', to: 'guest', payload: 1 },
    { t: 'room-config' },
    { t: 'room-config', maxMembers: null },
    { t: 'room-config', maxMembers: '8' },
    { t: 'room-config', maxMembers: [8] },
    { t: 'room-config', maxMembers: { n: 8 } },
    { t: 'ping', extra: [null] },
    { t: '__proto__' },
    { t: 'constructor' },
    { t: 'toString' },
    { t: 'unknown-type', payload: null },
  ];
  for (const msg of junk) host.send(msg);
  host.send({ t: 'signal', to: 'guest', payload: { kind: 'probe' } });
  const sig = await guest.waitFor((m) => m.t === 'signal', '正常信令');
  assert.deepEqual(sig.payload, { kind: 'probe' }, '坏消息一条都不该转发出去');
  assert.equal(guest.inbox.filter((m) => m.t === 'signal').length, 1);
  assert.equal(host.isClosed(), false, '坏的 signal / room-config 只报错，不断开房主');
  assert.ok(host.inbox.some((m) => m.t === 'error' && m.code === 'BAD_SIGNAL'));
  assert.ok(host.inbox.some((m) => m.t === 'error' && m.code === 'BAD_CONFIG'));
  // maxMembers 是字符串 / 数组时不能被 parseInt 悄悄认下
  assert.ok(!guest.inbox.some((m) => m.t === 'room-config'), '非数字的人数上限被当成了数字');
  assert.ok(srv.alive(), srv.stderr());
});

test('peerId / roomId 传数组或数字，绕不过 DUP_PEER 和 HOST_ID_RESERVED', { timeout: 20000 }, async (t) => {
  const clients = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));
  const srv = await startServer(t);

  const host = await join(srv.url, 'hijack-room', 'host', { clients, maxMembers: 8 });
  assert.equal(host.reply.t, 'joined');
  const member = await join(srv.url, 'hijack-room', '42', { clients });
  assert.equal(member.reply.t, 'joined');
  const witness = await join(srv.url, 'hijack-room', 'witness', { clients });
  assert.equal(witness.reply.hostId, 'host');

  // 原来 String(["host"]) === "host" 能过正则，Map.has / === 却拿数组去比，两道检查都被跳过，
  // 写表时又转回 "host"，把真房主那一条覆盖掉。数字 42 顶替 "42" 同理。
  for (const peerId of [['host'], ['42'], 42, ['witness']]) {
    // name 给个正常字符串，确保被拒是因为 peerId 本身
    const attacker = await join(srv.url, 'hijack-room', peerId, { clients, name: 'attacker' });
    assert.equal(attacker.reply.t, 'error', `${JSON.stringify(peerId)} 进房了`);
    assert.equal(attacker.reply.code, 'BAD_JOIN');
  }
  const wrongRoom = await join(srv.url, ['hijack-room'], 'intruder', { clients });
  assert.equal(wrongRoom.reply.code, 'BAD_JOIN');

  // 发给房主 / 成员的信令仍然送到真人手里，没人收到冒名者的 peer-join
  witness.send({ t: 'signal', to: 'host', payload: { kind: 'offer', n: 1 } });
  witness.send({ t: 'signal', to: '42', payload: { kind: 'offer', n: 2 } });
  assert.equal((await host.waitFor((m) => m.t === 'signal', '给房主的信令')).payload.n, 1);
  assert.equal((await member.waitFor((m) => m.t === 'signal', '给成员的信令')).payload.n, 2);
  for (const c of [host, member, witness]) {
    const joins = c.inbox.filter((m) => m.t === 'peer-join').map((m) => m.peerId);
    assert.ok(!joins.includes('host') && joins.filter((id) => id === '42').length <= 1, `冒名者被广播了：${joins}`);
  }
  // 房主还是服务器认的房主
  host.send({ t: 'room-config', maxMembers: 6 });
  assert.equal((await witness.waitFor((m) => m.t === 'room-config', 'room-config')).maxMembers, 6);
});

/* ------------------------------ 地区拦截 ------------------------------ */

test('TRUST_PROXY 下局域网豁免只认反代转述的地址，套接字地址（反代自己）不算', { timeout: 30000 }, async (t) => {
  const clients = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));
  const srv = await startServer(t, { BLOCKED_COUNTRIES: 'CN', TRUST_PROXY: '1', ALLOW_UNKNOWN: '0' });

  const verdict = async (headers, peerId) => {
    const c = await join(srv.url, 'geo-room', peerId, { clients, headers });
    return c.reply.t === 'joined' ? 'allowed' : c.reply.code;
  };

  // 同机 nginx 后面，所有连接的 TCP 对端都是 127.0.0.1。原来这里一律按「本机」放行
  assert.equal(await verdict({}, 'no-header'), 'REGION_BLOCKED', '反代没转述地址时拿反代自己的地址豁免了');
  assert.equal(await verdict({ 'x-forwarded-for': '203.0.113.9', 'cf-ipcountry': 'CN' }, 'cn'), 'REGION_BLOCKED');
  // 客户端自己塞的第一段不算数，只认反代追加的最后一段
  assert.equal(await verdict({ 'x-forwarded-for': '127.0.0.1, 203.0.113.9' }, 'forged'), 'REGION_BLOCKED');
  assert.equal(await verdict({ 'x-forwarded-for': '10.evil' }, 'not-an-ip'), 'REGION_BLOCKED');
  assert.equal(await verdict({ 'x-forwarded-for': '203.0.113.9', 'cf-ipcountry': 'US' }, 'us'), 'allowed');
  // 真从内网经反代连进来的，照样豁免
  assert.equal(await verdict({ 'x-forwarded-for': '192.168.1.20' }, 'lan'), 'allowed');
  assert.equal(await verdict({ 'x-real-ip': '10.0.0.5' }, 'lan-real-ip'), 'allowed');
  assert.ok(srv.alive(), srv.stderr());
  // 反代没转述地址是部署配置问题，得在日志里说出来，不然只会表现成「人一多就连不上」
  await waitForStderr(srv, '请求里没有 X-Forwarded-For');
});

test('不在反代后面时，本机豁免照旧只看套接字地址，请求头怎么写都不影响', { timeout: 15000 }, async (t) => {
  const clients = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));
  const srv = await startServer(t, { BLOCKED_COUNTRIES: 'CN', ALLOW_UNKNOWN: '0' });

  const c = await join(srv.url, 'direct-room', 'local', {
    clients,
    headers: { 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9', 'cf-ipcountry': 'CN' },
  });
  assert.equal(c.reply.t, 'joined', `本机直连被拦了：${JSON.stringify(c.reply)}`);
  // 带着 X-Forwarded-For 却没开 TRUST_PROXY，多半是反代后面忘了配，提示一次
  await waitForStderr(srv, '没开 TRUST_PROXY');
});

test('被地区拦截的连接在关掉前发超长帧，进程不崩', { timeout: 15000 }, async (t) => {
  const clients = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));
  const srv = await startServer(t, { BLOCKED_COUNTRIES: 'CN', TRUST_PROXY: '1' });
  const headers = { 'x-forwarded-for': '203.0.113.9', 'cf-ipcountry': 'CN' };

  // 原来拦截分支在挂 error 监听之前就返回了：超过 maxPayload 的帧让 ws 发出一个没人接的
  // 'error'，直接变成 uncaughtException
  for (let i = 0; i < 3; i++) {
    const c = await connect(srv.url, { clients, headers });
    c.send('x'.repeat(70 * 1024));
    await c.closed;
  }
  await sleep(200);
  assert.ok(srv.alive(), `信令服务器退出了：${srv.stderr()}`);
  const ok = await join(srv.url, 'after-blocked', 'us', { clients, headers: { 'x-forwarded-for': '198.51.100.7' } });
  assert.equal(ok.reply.t, 'joined');
});

/* ------------------------------ 连接数 ------------------------------ */

test('同一 IP 同时连接数有上限，没升级的空 TCP 连接也算；断开后名额还回来', { timeout: 20000 }, async (t) => {
  const clients = [];
  const sockets = [];
  t.after(() => {
    for (const s of sockets) s.destroy();
    return Promise.all(clients.map((c) => c.close()));
  });
  const srv = await startServer(t, { MAX_CONN_PER_IP: '3' });

  const a = await connect(srv.url, { clients });
  const b = await connect(srv.url, { clients });
  const c = await connect(srv.url, { clients });
  const fourth = await tryConnect(srv.url, { clients });
  assert.equal(fourth.ok, false, '第 4 条连接不该连上');

  await a.close();
  const again = await connectEventually(srv.url, { clients });
  assert.equal(again.ok, true);

  // 空 TCP 连接（慢速连接占坑）也占名额
  await Promise.all([b.close(), c.close(), again.close()]);
  await sleep(200);
  for (let i = 0; i < 3; i++) sockets.push(await rawSocket(srv.port));
  await sleep(100);
  const blocked = await tryConnect(srv.url, { clients });
  assert.equal(blocked.ok, false, '空 TCP 连接没被计进每 IP 上限');
  sockets.pop().destroy();
  assert.equal((await connectEventually(srv.url, { clients })).ok, true);
});

test('TRUST_PROXY 时每 IP 上限按反代转述的地址算，IPv6 按 /64 合并', { timeout: 20000 }, async (t) => {
  const clients = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));
  const srv = await startServer(t, { TRUST_PROXY: '1', MAX_CONN_PER_IP: '2' });
  const via = (ip) => ({ clients, headers: { 'x-forwarded-for': ip } });

  assert.equal((await tryConnect(srv.url, via('198.51.100.1'))).ok, true);
  assert.equal((await tryConnect(srv.url, via('198.51.100.1'))).ok, true);
  const third = await tryConnect(srv.url, via('198.51.100.1'));
  assert.equal(third.ok, false);
  assert.match(third.error.message, /429/);
  // 同一个反代后面的别的客户端不受牵连 —— 原来这些连接全算在 127.0.0.1 头上
  assert.equal((await tryConnect(srv.url, via('198.51.100.2'))).ok, true);

  // 同一个 /64 里换个后缀不算新 IP
  assert.equal((await tryConnect(srv.url, via('2001:db8::1'))).ok, true);
  assert.equal((await tryConnect(srv.url, via('2001:0db8:0000:0000:1::2'))).ok, true);
  assert.equal((await tryConnect(srv.url, via('2001:db8::abcd:3'))).ok, false);
  assert.equal((await tryConnect(srv.url, via('2001:db8:0:1::1'))).ok, true, '别的 /64 应该单独计数');
});

test('全服同时连接数有上限', { timeout: 15000 }, async (t) => {
  const clients = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));
  const srv = await startServer(t, { MAX_CONNECTIONS: '3', MAX_CONN_PER_IP: '0' });

  for (let i = 0; i < 3; i++) await connect(srv.url, { clients });
  assert.equal((await tryConnect(srv.url, { clients })).ok, false, '超过全服上限的连接被放进来了');
  await clients[0].close();
  assert.equal((await connectEventually(srv.url, { clients })).ok, true);
  assert.ok(srv.alive(), srv.stderr());
});

/* ------------------------------ 速率与大小 ------------------------------ */

test('消息速率超限即断开，大消息按字节多扣令牌', { timeout: 15000 }, async (t) => {
  const clients = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));
  const srv = await startServer(t, { MSG_RATE: '10', MSG_BURST: '20', MAX_MSG_BYTES: '8192' });

  const flood = await join(srv.url, 'rate-room', 'flood', { clients, maxMembers: 4 });
  for (let i = 0; i < 60; i++) flood.send({ t: 'ping' });
  await expectRejected(flood, 'RATE_LIMITED');
  assert.ok(flood.inbox.filter((m) => m.t === 'pong').length <= 21, '超限之后还在回 pong');

  // 每条 7 KB 的信令每条扣 7 个令牌：第三条就超了
  const host = await join(srv.url, 'rate-room-2', 'host', { clients, maxMembers: 4 });
  const guest = await join(srv.url, 'rate-room-2', 'guest', { clients });
  for (let i = 0; i < 3; i++) guest.send({ t: 'signal', to: 'host', payload: { kind: 'ice', pad: 'x'.repeat(7000) } });
  await expectRejected(guest, 'RATE_LIMITED');
  assert.ok(host.inbox.filter((m) => m.t === 'signal').length <= 2);
});

test('单条消息和单条 signal 的大小上限', { timeout: 15000 }, async (t) => {
  const clients = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));
  const srv = await startServer(t, { MAX_MSG_BYTES: '16384', MAX_SIGNAL_BYTES: '4096' });

  const host = await join(srv.url, 'size-room', 'host', { clients, maxMembers: 4 });
  const guest = await join(srv.url, 'size-room', 'guest', { clients });

  // 超过 MAX_SIGNAL_BYTES：报错、不转发、连接保留
  guest.send({ t: 'signal', to: 'host', payload: { kind: 'offer', sdp: 'x'.repeat(5000) } });
  assert.equal((await guest.waitFor((m) => m.t === 'error', 'SIGNAL_TOO_LARGE')).code, 'SIGNAL_TOO_LARGE');
  guest.send({ t: 'signal', to: 'host', payload: { kind: 'offer', sdp: 'v=0' } });
  assert.equal((await host.waitFor((m) => m.t === 'signal', '正常信令')).payload.sdp, 'v=0');
  assert.equal(host.inbox.filter((m) => m.t === 'signal').length, 1, '超大的信令被转发了');

  // 超过 MAX_MSG_BYTES（ws 的 maxPayload）：连接直接断，1009
  guest.send('x'.repeat(20000));
  const { code } = await guest.closed;
  assert.equal(code, 1009);
  await host.waitFor((m) => m.t === 'peer-leave' && m.peerId === 'guest', 'peer-leave');
  assert.ok(srv.alive(), srv.stderr());
});

test('大小、时长类填 0 不是「不限」也不是夹到下限，而是按默认值', { timeout: 15000 }, async (t) => {
  const clients = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));
  const srv = await startServer(t, { MAX_MSG_BYTES: '0', MAX_SIGNAL_BYTES: '0', HEARTBEAT_MS: '0', HTTP_TIMEOUT_MS: '0' });

  const host = await join(srv.url, 'zero-room', 'host', { clients, maxMembers: 4 });
  const guest = await join(srv.url, 'zero-room', 'guest', { clients });
  // 夹到下限的话这条 10 KB 的 SDP 就发不出去了（默认上限 32 KB）
  guest.send({ t: 'signal', to: 'host', payload: { kind: 'offer', sdp: 'x'.repeat(10000) } });
  assert.equal((await host.waitFor((m) => m.t === 'signal', '10 KB 的信令')).payload.sdp.length, 10000);
  assert.equal(guest.isClosed(), false);
  await waitForStderr(srv, '必须大于 0');
});

test('默认上限不误伤：同一个 NAT 后面 16 台设备进同一个房间，一口气互换 SDP/ICE', { timeout: 60000 }, async (t) => {
  const clients = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));
  const srv = await startServer(t); // 全用默认值

  const N = 16;
  const CANDIDATES = 40; // 多网卡 + IPv6 + TURN 的 UDP/TCP/TLS，每条 RTCPeerConnection 几十条候选
  const members = [];
  for (let i = 0; i < N; i++) {
    const c = await join(srv.url, 'lan-party', `p${i}`, { clients, maxMembers: 16 });
    assert.equal(c.reply.t, 'joined', `第 ${i + 1} 个人进不来：${JSON.stringify(c.reply)}`);
    members.push(c);
  }

  const sdp = `v=0\r\n${'a=candidate:1 1 udp 2122260223 192.168.1.2 54321 typ host generation 0\r\n'.repeat(50)}`;
  const candidate = {
    candidate: 'candidate:842163049 1 udp 1677729535 203.0.113.9 61234 typ srflx raddr 0.0.0.0 rport 0 generation 0 ufrag abcd network-cost 999',
    sdpMid: '0',
    sdpMLineIndex: 0,
    usernameFragment: 'abcd',
  };
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      members[i].send({ t: 'signal', to: `p${j}`, from: `p${i}`, payload: { kind: 'offer', sdp: { type: 'offer', sdp } } });
      for (let k = 0; k < CANDIDATES; k++) {
        members[i].send({ t: 'signal', to: `p${j}`, from: `p${i}`, payload: { kind: 'ice', candidate } });
      }
    }
  }

  const expected = (N - 1) * (CANDIDATES + 1);
  await Promise.all(
    members.map((c, i) =>
      c.waitFor(() => c.inbox.filter((m) => m.t === 'signal').length >= expected, `p${i} 收齐信令`, 30000)
    )
  );
  for (const [i, c] of members.entries()) {
    assert.equal(c.inbox.filter((m) => m.t === 'signal').length, expected, `p${i} 收到的信令条数不对`);
    assert.ok(!c.inbox.some((m) => m.t === 'error'), `p${i} 被报错：${JSON.stringify(c.inbox.find((m) => m.t === 'error'))}`);
    assert.equal(c.isClosed(), false, `p${i} 被断开了`);
  }
});

/* ------------------------------ join / 建房频率与房间数 ------------------------------ */

test('同一 IP 的 join 次数有上限，被拒的尝试也算', { timeout: 15000 }, async (t) => {
  const clients = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));
  const srv = await startServer(t, { JOINS_PER_MIN: '3' });

  const host = await join(srv.url, 'churn-room', 'host', { clients, maxMembers: 8 });
  assert.equal(host.reply.t, 'joined');
  const bad = await join(srv.url, 'churn-room', 'host', { clients }); // DUP / HOST_ID_RESERVED
  assert.equal(bad.reply.t, 'error');
  const second = await join(srv.url, 'churn-room', 'second', { clients });
  assert.equal(second.reply.t, 'joined');
  const fourth = await join(srv.url, 'churn-room', 'third', { clients });
  assert.equal(fourth.reply.code, 'JOIN_RATE_LIMITED');
  assert.ok(!host.inbox.some((m) => m.t === 'peer-join' && m.peerId === 'third'), '被限流的人不该被广播');
});

test('同一 IP 的建房次数有上限，加入已有房间不受影响', { timeout: 15000 }, async (t) => {
  const clients = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));
  const srv = await startServer(t, { ROOMS_PER_MIN: '2' });

  assert.equal((await join(srv.url, 'room-a', 'a', { clients, maxMembers: 4 })).reply.t, 'joined');
  assert.equal((await join(srv.url, 'room-b', 'b', { clients, maxMembers: 4 })).reply.t, 'joined');
  assert.equal((await join(srv.url, 'room-c', 'c', { clients, maxMembers: 4 })).reply.code, 'ROOM_RATE_LIMITED');
  assert.equal((await join(srv.url, 'room-a', 'a2', { clients })).reply.t, 'joined');
});

test('全服房间数有上限；房间散了名额还回来', { timeout: 15000 }, async (t) => {
  const clients = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));
  const srv = await startServer(t, { MAX_ROOMS: '2' });

  const a = await join(srv.url, 'room-a', 'a', { clients, maxMembers: 4 });
  assert.equal(a.reply.t, 'joined');
  assert.equal((await join(srv.url, 'room-b', 'b', { clients, maxMembers: 4 })).reply.t, 'joined');
  assert.equal((await join(srv.url, 'room-c', 'c', { clients, maxMembers: 4 })).reply.code, 'SERVER_FULL');
  // 满了照样能进已有的房间
  assert.equal((await join(srv.url, 'room-b', 'b2', { clients })).reply.t, 'joined');

  await a.close();
  const deadline = Date.now() + 3000;
  let reply;
  do {
    await sleep(100);
    reply = (await join(srv.url, 'room-c', `c${Date.now()}`, { clients, maxMembers: 4 })).reply;
  } while (reply.t !== 'joined' && Date.now() < deadline);
  assert.equal(reply.t, 'joined', `房间散了之后还是建不了新房：${reply.code}`);
});

/* ------------------------------ 心跳与超时 ------------------------------ */

test('心跳清掉不回 pong 的死连接，peer-leave 只广播一次；正常连接不受影响', { timeout: 15000 }, async (t) => {
  const clients = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));
  const srv = await startServer(t, { HEARTBEAT_MS: '200' });

  const host = await join(srv.url, 'hb-room', 'host', { clients, maxMembers: 4 });
  const witness = await join(srv.url, 'hb-room', 'witness', { clients });
  const zombie = await join(srv.url, 'hb-room', 'zombie', { clients });
  // 客户端不再读套接字：收不到 ping，也就不会回 pong —— 等同 TCP 半开
  zombie.ws._socket.pause();

  await witness.waitFor((m) => m.t === 'peer-leave' && m.peerId === 'zombie', '死连接的 peer-leave', 3000);
  await sleep(600); // 被 terminate 之后还会来一次 close 事件
  const leaves = witness.inbox.filter((m) => m.t === 'peer-leave' && m.peerId === 'zombie');
  assert.equal(leaves.length, 1, `peer-leave 广播了 ${leaves.length} 次`);

  // 会回 pong 的连接活过了好几个心跳周期
  host.send({ t: 'signal', to: 'witness', payload: { kind: 'still-here' } });
  assert.equal((await witness.waitFor((m) => m.t === 'signal', '心跳之后的信令')).payload.kind, 'still-here');
  assert.equal(host.isClosed() || witness.isClosed(), false);
  zombie.ws.terminate();
});

test('HTTP 慢速连接会被超时断开，已经升级的 WebSocket 长连接不受影响', { timeout: 20000 }, async (t) => {
  const clients = [];
  const sockets = [];
  const timers = [];
  t.after(() => {
    for (const timer of timers) clearInterval(timer);
    for (const s of sockets) s.destroy();
    return Promise.all(clients.map((c) => c.close()));
  });
  const srv = await startServer(t, { HTTP_TIMEOUT_MS: '1000' });

  const member = await join(srv.url, 'slow-room', 'member', { clients, maxMembers: 4 });
  assert.equal(member.reply.t, 'joined');

  // 连上一个字节都不发
  const idle = await rawSocket(srv.port);
  sockets.push(idle);
  // 请求头一点一点地挤，每次都赶在空闲超时之前 —— 只有请求头超时管得到
  const trickle = await rawSocket(srv.port);
  sockets.push(trickle);
  trickle.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n');
  timers.push(setInterval(() => trickle.writable && trickle.write('X-Slow: a\r\n'), 200));

  const limit = (p, what) => Promise.race([p, sleep(6000).then(() => assert.fail(`${what}一直没被断开`))]);
  const [idleMs, trickleMs] = await Promise.all([limit(idle.closedAfter, '空连接'), limit(trickle.closedAfter, '慢速请求头')]);
  assert.ok(idleMs < 4000 && trickleMs < 4000, `断得太慢：空连接 ${idleMs}ms，慢速请求头 ${trickleMs}ms`);

  // 早就过了 HTTP 超时，已经进房的长连接还在
  assert.equal(member.isClosed(), false, 'HTTP 超时误杀了已经升级的 WebSocket');
  member.send({ t: 'ping' });
  await member.waitFor((m) => m.t === 'pong', 'pong');
});
