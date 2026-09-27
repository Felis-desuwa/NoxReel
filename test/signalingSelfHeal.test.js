'use strict';

/**
 * 信令服务器断线自愈（批次 4）。全部起真服务器（127.0.0.1 随机端口），用 ws 客户端打，不需要 GUI。
 *
 * 守住的几件事：
 * - 服务器重启后房间由先重连上的老成员重建：房主身份、人数上限照旧（建房提示），真房主凭旧凭据
 *   回来认领，冒名的拿不出凭据照样被拒；新人拿邀请码照常进得来。
 * - 同一个 peerId 的新连接先探旧连接：半开的死连接几秒内被顶替（不广播 peer-leave），活着的才报
 *   DUP_PEER；房主凭据续期排在满员前面。
 * - 经一对一邀请、房间链接进来的人服务器看不到，由房主报上来的人数（outside）一并算进满员判定。
 * - WsSignaling 重连时带上建房提示、记下「信令宣布离开」的人、进房前不发信令、撞 DUP_PEER 时短间隔重试。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');
const { WebSocketServer } = require('ws');
const { IMPLS } = require('./helpers/impls');

const SERVER = path.join(__dirname, '..', 'signaling-server', 'server.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const keyOf = (token) => crypto.createHash('sha256').update(token).digest('base64url');

function spawnServer(port, env) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), MAX_ROOM_SIZE: '16', BLOCKED_COUNTRIES: '', TRUST_PROXY: '', NOXREEL_TEST_MUTE: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const ready = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
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
  return { child, ready, stderr: () => stderr };
}

/** 起一个真信令服务器；端口随机，撞上被占用的就换一个。restart() 在同一个端口上重启（模拟部署、崩溃重启）。 */
async function startServer(t, env = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 40000 + Math.floor(Math.random() * 20000);
    let run = spawnServer(port, env);
    if (!(await run.ready)) {
      run.child.kill();
      if (!run.stderr().includes('已被占用')) throw new Error(`信令服务器启动失败：${run.stderr()}`);
      continue;
    }
    const srv = {
      url: `ws://127.0.0.1:${port}`,
      async restart() {
        const exited = new Promise((resolve) => run.child.once('exit', resolve));
        run.child.kill();
        await exited;
        for (let i = 0; i < 20; i++) {
          run = spawnServer(port, env);
          if (await run.ready) return;
          run.child.kill();
          await sleep(100);
        }
        throw new Error(`同一端口上重启失败：${run.stderr()}`);
      },
    };
    t.after(() => run.child.kill());
    return srv;
  }
  throw new Error('连续几个端口都被占用，信令服务器起不来');
}

/** 裸 WebSocket 客户端：从连上那一刻起记下收到的每条消息，等消息时先翻已收到的。 */
async function connect(url, clients) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = new Set();
  let closed = false;
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
  ws.on('close', () => (closed = true));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.on('error', () => {});
  const c = {
    ws,
    inbox,
    isClosed: () => closed,
    send: (obj) => ws.send(JSON.stringify(obj)),
    waitFor(pred, what = '消息', timeoutMs = 3000) {
      const hit = inbox.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = {
          pred,
          resolve: (msg) => {
            clearTimeout(timer);
            resolve(msg);
          },
        };
        const timer = setTimeout(() => {
          waiters.delete(w);
          reject(new Error(`等待${what}超时`));
        }, timeoutMs);
        waiters.add(w);
      });
    },
    close() {
      if (closed) return Promise.resolve();
      return new Promise((resolve) => {
        ws.once('close', resolve);
        ws.terminate();
      });
    },
  };
  clients?.push(c);
  return c;
}

async function join(url, roomId, peerId, { clients, timeoutMs = 3000, ...extra } = {}) {
  const c = await connect(url, clients);
  c.send({ t: 'join', roomId, peerId, name: peerId, maxMembers: 0, ...extra });
  c.reply = await c.waitFor((m) => m.t === 'joined' || m.t === 'error', `${peerId} 的 join 答复`, timeoutMs);
  return c;
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`等待${what}超时`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/* ------------------------------ 服务器重启 ------------------------------ */

test('服务器重启后老成员先重连：按建房提示登记真房主和原人数，房主凭旧凭据认领，冒名的进不来，新人照常进', { timeout: 30000 }, async (t) => {
  const clients = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));
  const srv = await startServer(t);

  const host = await join(srv.url, 'movie', 'host', { clients, maxMembers: 8 });
  const token = host.reply.hostToken;
  assert.equal(typeof token, 'string');
  const guests = ['g1', 'g2', 'g3', 'g4', 'g5'];
  let hostKey = null;
  for (const id of guests) {
    const g = await join(srv.url, 'movie', id, { clients, maxMembers: 8 });
    assert.equal(g.reply.t, 'joined');
    assert.ok(!('hostToken' in g.reply), '续期凭据只能回给房主本人');
    assert.equal(g.reply.hostKey, keyOf(token), '其他成员拿到的是凭据的摘要');
    hostKey = g.reply.hostKey;
  }

  await srv.restart();

  // 原来的症状：g1 先连上就成了房主、人数钉成 4，g5 起撞 ROOM_FULL
  const rejoined = [];
  for (const id of guests) {
    const g = await join(srv.url, 'movie', id, { clients, maxMembers: 8, hostHint: 'host', hostKey });
    assert.equal(g.reply.t, 'joined', `${id} 重连被拒：${g.reply.code}`);
    assert.equal(g.reply.hostId, 'host', '服务器把先重连上的成员当成了房主');
    assert.equal(g.reply.maxMembers, 8, '人数上限掉回了默认值');
    assert.ok(!('hostToken' in g.reply), '重建房间的成员拿到了房主凭据');
    rejoined.push(g);
  }

  // 顶着房主 id 来的：不带凭据、凭据是别的都不行
  for (const extra of [{}, { hostToken: crypto.randomBytes(24).toString('base64url') }, { hostToken: hostKey }]) {
    const imposter = await join(srv.url, 'movie', 'host', { clients, maxMembers: 2, ...extra });
    assert.equal(imposter.reply.t, 'error');
    assert.equal(imposter.reply.code, 'HOST_ID_RESERVED');
  }

  const back = await join(srv.url, 'movie', 'host', { clients, maxMembers: 8, hostToken: token });
  assert.equal(back.reply.t, 'joined', `房主认领被拒：${back.reply.code}`);
  assert.equal(back.reply.hostId, 'host');
  assert.equal(back.reply.hostToken, token, '凭据沿用旧的：老成员手里的摘要还对得上，再重启一次照样能认领');
  assert.deepEqual(back.reply.peers.map((p) => p.peerId).sort(), guests);

  // 老成员收到房主回来的 peer-join，带着摘要；凭据本身谁也没收到
  const witness = rejoined[2];
  const hostJoin = await witness.waitFor((m) => m.t === 'peer-join' && m.peerId === 'host', '房主回来的 peer-join');
  assert.equal(hostJoin.hostKey, hostKey);

  // 房主照样能改人数
  back.send({ t: 'room-config', maxMembers: 9 });
  assert.equal((await witness.waitFor((m) => m.t === 'room-config', 'room-config')).maxMembers, 9);

  // 新人拿邀请码（首次加入不带提示）照常进得来，服务器认的房主和邀请码一致
  const newcomer = await join(srv.url, 'movie', 'newcomer', { clients, maxMembers: 8 });
  assert.equal(newcomer.reply.t, 'joined');
  assert.equal(newcomer.reply.hostId, 'host');

  for (const c of clients) {
    if (c === host || c === back) continue;
    for (const msg of c.inbox) assert.ok(!JSON.stringify(msg).includes(token), `续期凭据泄露了：${JSON.stringify(msg)}`);
  }
});

test('重建时替房主留着席位；房主回来按他的人数改上限并告诉全房；老成员不知道摘要时先到先得', { timeout: 15000 }, async (t) => {
  const clients = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));
  const srv = await startServer(t);

  // 老成员重建，人数 2：房主不在也替他留一席，第二个人进不来
  const a = await join(srv.url, 'seat', 'a', { clients, maxMembers: 2, hostHint: 'host' });
  assert.equal(a.reply.t, 'joined');
  assert.equal(a.reply.hostId, 'host');
  const b = await join(srv.url, 'seat', 'b', { clients, maxMembers: 2, hostHint: 'host' });
  assert.equal(b.reply.code, 'ROOM_FULL', '房主的席位被补位的人占了');

  // 房主回来（这个房间的老成员不知道摘要：先到先得），按他的设置把上限改成 5
  const token = crypto.randomBytes(24).toString('base64url');
  const host = await join(srv.url, 'seat', 'host', { clients, maxMembers: 5, hostToken: token });
  assert.equal(host.reply.t, 'joined', `房主回不来：${host.reply.code}`);
  assert.equal(host.reply.hostToken, token);
  assert.equal(host.reply.maxMembers, 5);
  assert.equal((await a.waitFor((m) => m.t === 'room-config', '上限变化')).maxMembers, 5);
  assert.equal((await a.waitFor((m) => m.t === 'peer-join', '房主的 peer-join')).hostKey, keyOf(token));

  // 认领之后再有人顶着房主 id 来，就得拿得出这张凭据了
  await host.close();
  await a.waitFor((m) => m.t === 'peer-leave' && m.peerId === 'host', '房主的 peer-leave');
  const imposter = await join(srv.url, 'seat', 'host', { clients, hostToken: crypto.randomBytes(24).toString('base64url') });
  assert.equal(imposter.reply.code, 'HOST_ID_RESERVED');
  const again = await join(srv.url, 'seat', 'host', { clients, hostToken: token });
  assert.equal(again.reply.t, 'joined');
});

test('建房提示只在房间不存在、而且提示的不是自己时才用；类型不对的提示当没带', { timeout: 15000 }, async (t) => {
  const clients = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));
  const srv = await startServer(t);

  // 房间已经在了：提示不改任何东西
  const host = await join(srv.url, 'r1', 'host', { clients, maxMembers: 3 });
  const g = await join(srv.url, 'r1', 'g', { clients, maxMembers: 9, hostHint: 'someone-else' });
  assert.equal(g.reply.hostId, 'host');
  assert.equal(g.reply.maxMembers, 3);
  assert.ok(host.reply.hostToken);

  // 提示的就是自己：照常当房主建房，拿到凭据
  const self = await join(srv.url, 'r2', 'me', { clients, maxMembers: 4, hostHint: 'me' });
  assert.equal(self.reply.hostId, 'me');
  assert.equal(typeof self.reply.hostToken, 'string');

  // 类型、格式不对的提示当没带：建房的人就是房主（老客户端的行为）
  for (const [room, extra] of [
    ['r3', { hostHint: ['host'] }],
    ['r4', { hostHint: 42 }],
    ['r5', { hostHint: 'bad id!' }],
    ['r6', { hostHint: 'x'.repeat(200) }],
  ]) {
    const c = await join(srv.url, room, 'first', { clients, ...extra });
    assert.equal(c.reply.t, 'joined', `${JSON.stringify(extra)} 把 join 弄挂了`);
    assert.equal(c.reply.hostId, 'first');
  }
  // 摘要格式不对：提示照用，摘要当没有
  const d = await join(srv.url, 'r7', 'guest', { clients, hostHint: 'host', hostKey: 'short' });
  assert.equal(d.reply.hostId, 'host');
  assert.ok(!('hostKey' in d.reply));
});

/* ------------------------------ 同一身份的旧连接 ------------------------------ */

test('旧连接半开（不回 pong）：同一 peerId 的新连接几秒内顶替它，房里的人不会收到 peer-leave', { timeout: 20000 }, async (t) => {
  const clients = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));
  const srv = await startServer(t);

  const host = await join(srv.url, 'dup', 'host', { clients, maxMembers: 4 });
  const member = await join(srv.url, 'dup', 'm', { clients });
  await host.waitFor((m) => m.t === 'peer-join' && m.peerId === 'm', 'm 的 peer-join');
  member.ws._socket.pause(); // 不再读套接字：收不到 ping，也就不会回 pong —— 等同 TCP 半开

  const started = Date.now();
  const back = await connect(srv.url, clients);
  back.send({ t: 'join', roomId: 'dup', peerId: 'm', name: 'm', maxMembers: 4 });
  // 探测期间发来的信令不能把这条新连接判死
  back.send({ t: 'signal', to: 'host', payload: { kind: 'ice', early: true } });
  back.reply = await back.waitFor((m) => m.t === 'joined' || m.t === 'error', '顶替的答复', 8000);
  assert.equal(back.reply.t, 'joined', `新连接没能顶替：${back.reply.code}`);
  assert.ok(Date.now() - started < 6000, '顶替要等到心跳才发生');
  assert.deepEqual(back.reply.peers.map((p) => p.peerId), ['host']);
  assert.equal(back.isClosed(), false);

  await host.waitFor((m) => m.t === 'peer-join' && m.peerId === 'm' && host.inbox.filter((x) => x.t === 'peer-join').length === 2, '顶替后的 peer-join');
  await sleep(300);
  assert.ok(!host.inbox.some((m) => m.t === 'peer-leave'), '同一个人换了条连接，不该广播 peer-leave');

  // 顶替之后信令送到新连接上
  host.send({ t: 'signal', to: 'm', payload: { kind: 'offer', n: 1 } });
  assert.equal((await back.waitFor((m) => m.t === 'signal', '给 m 的信令')).payload.n, 1);
  member.ws.terminate();
});

test('旧连接还活着：新连接很快报 DUP_PEER，原来那条不受影响', { timeout: 15000 }, async (t) => {
  const clients = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));
  const srv = await startServer(t);

  const host = await join(srv.url, 'alive', 'host', { clients, maxMembers: 4 });
  const member = await join(srv.url, 'alive', 'm', { clients });
  const started = Date.now();
  const dup = await join(srv.url, 'alive', 'm', { clients });
  assert.equal(dup.reply.t, 'error');
  assert.equal(dup.reply.code, 'DUP_PEER');
  assert.ok(Date.now() - started < 2000, '活着的旧连接回 pong 就该马上有结论');

  host.send({ t: 'signal', to: 'm', payload: { kind: 'offer', n: 2 } });
  assert.equal((await member.waitFor((m) => m.t === 'signal', '给原连接的信令')).payload.n, 2);
  assert.equal(member.isClosed(), false);
});

test('房间满员时房主凭凭据顶替自己半开的旧连接：续期排在满员前面，不报 ROOM_FULL', { timeout: 20000 }, async (t) => {
  const clients = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));
  const srv = await startServer(t);

  const host = await join(srv.url, 'full', 'host', { clients, maxMembers: 2 });
  const token = host.reply.hostToken;
  const guest = await join(srv.url, 'full', 'guest', { clients });
  assert.equal(guest.reply.t, 'joined');
  host.ws._socket.pause();

  // 没凭据的冒名者：不用探，直接拒
  const imposter = await join(srv.url, 'full', 'host', { clients });
  assert.equal(imposter.reply.code, 'HOST_ID_RESERVED');

  const back = await join(srv.url, 'full', 'host', { clients, hostToken: token, timeoutMs: 8000 });
  assert.equal(back.reply.t, 'joined', `房主被挡在外面：${back.reply.code}`);
  assert.equal(back.reply.hostToken, token);
  back.send({ t: 'room-config', maxMembers: 3 });
  assert.equal((await guest.waitFor((m) => m.t === 'room-config', 'room-config')).maxMembers, 3);
  host.ws.terminate();
});

/* ------------------------------ 不经服务器进来的人 ------------------------------ */

test('房主报上来的「不经服务器进房的人数」算进满员判定；只报人数不广播；只认房主、只认数字', { timeout: 15000 }, async (t) => {
  const clients = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));
  const srv = await startServer(t);

  const host = await join(srv.url, 'mixed', 'host', { clients, maxMembers: 4 });
  // 先一对一拉进来两个人
  host.send({ t: 'room-config', maxMembers: 4, outside: 2 });
  await sleep(200); // 只报人数、上限没变的服务器不回话：等它处理完
  const g1 = await join(srv.url, 'mixed', 'g1', { clients });
  assert.equal(g1.reply.t, 'joined');
  const g2 = await join(srv.url, 'mixed', 'g2', { clients });
  assert.equal(g2.reply.code, 'ROOM_FULL', '房主 + 一对一的两人 + g1 已经 4 人，服务器还在放人');

  // 一对一的走了一个
  host.send({ t: 'room-config', maxMembers: 4, outside: 1 });
  await sleep(200);
  const g3 = await join(srv.url, 'mixed', 'g3', { clients });
  assert.equal(g3.reply.t, 'joined');
  assert.ok(!g1.inbox.some((m) => m.t === 'room-config'), '上限没变，不该给全房广播 room-config');

  // 格式不对、不是房主报的，一律不认
  host.send({ t: 'room-config', maxMembers: 4, outside: '0' });
  assert.equal((await host.waitFor((m) => m.t === 'error' && m.code === 'BAD_CONFIG', 'BAD_CONFIG')).code, 'BAD_CONFIG');
  g1.send({ t: 'room-config', maxMembers: 4, outside: 0 });
  assert.equal((await g1.waitFor((m) => m.t === 'error', 'NOT_HOST')).code, 'NOT_HOST');
  await sleep(100);
  const g4 = await join(srv.url, 'mixed', 'g4', { clients });
  assert.equal(g4.reply.code, 'ROOM_FULL', '游客改掉了房主报的人数');

  // 老客户端的 room-config（不带 outside）照旧广播
  host.send({ t: 'room-config', maxMembers: 5 });
  assert.equal((await g1.waitFor((m) => m.t === 'room-config', 'room-config')).maxMembers, 5);
});

test('房主重连时随 join 带上「不经服务器进房的人数」；成员带的不算', { timeout: 15000 }, async (t) => {
  const clients = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));
  const srv = await startServer(t);

  const host = await join(srv.url, 'rejoin', 'host', { clients, maxMembers: 3, outside: 1 });
  const g1 = await join(srv.url, 'rejoin', 'g1', { clients, outside: 0 });
  assert.equal(g1.reply.t, 'joined');
  const g2 = await join(srv.url, 'rejoin', 'g2', { clients });
  assert.equal(g2.reply.code, 'ROOM_FULL');

  await host.close();
  await g1.waitFor((m) => m.t === 'peer-leave', '房主的 peer-leave');
  const back = await join(srv.url, 'rejoin', 'host', { clients, hostToken: host.reply.hostToken, outside: 0 });
  assert.equal(back.reply.t, 'joined');
  const g3 = await join(srv.url, 'rejoin', 'g3', { clients });
  assert.equal(g3.reply.t, 'joined');
});

/* ------------------------------ WsSignaling ------------------------------ */

for (const { name, dir } of IMPLS) {
  test(`${name}：WsSignaling 重连时带上建房提示：服务器重启后成员先连上，房主照样认领回来`, { timeout: 30000 }, async (t) => {
    const { WsSignaling } = await import(dir + 'signaling.js');
    const clients = [];
    let sig = null;
    t.after(() => {
      sig?.close();
      return Promise.all(clients.map((c) => c.close()));
    });
    const srv = await startServer(t);

    const host = await join(srv.url, 'client-room', 'host', { clients, maxMembers: 8 });
    const token = host.reply.hostToken;
    sig = new WsSignaling({ url: srv.url, roomId: 'client-room', peerId: 'g', name: 'G', maxMembers: 8, hostId: 'host' });
    const first = await sig.connect();
    assert.equal(first.hostId, 'host');
    assert.ok(!('hostKey' in first), '摘要留在 WsSignaling 里，不交给调用方');
    assert.equal(sig.connected, true);

    const rejoined = new Promise((resolve) => sig.once('joined', resolve));
    await srv.restart();
    const again = await withTimeout(rejoined, 10000, '成员重连');
    assert.equal(again.hostId, 'host', '重建房间的成员被当成了房主');
    assert.equal(again.maxMembers, 8);
    assert.ok(!('hostToken' in again) && !('hostKey' in again));

    // 摘要跟着提示交上去了：别的凭据认领不了，房主的旧凭据可以
    const imposter = await join(srv.url, 'client-room', 'host', { clients, hostToken: crypto.randomBytes(24).toString('base64url') });
    assert.equal(imposter.reply.code, 'HOST_ID_RESERVED');
    const hostBack = new Promise((resolve) => sig.once('peer-join', resolve));
    const back = await join(srv.url, 'client-room', 'host', { clients, maxMembers: 8, hostToken: token });
    assert.equal(back.reply.t, 'joined');
    assert.equal(back.reply.hostToken, token);
    const pj = await withTimeout(hostBack, 3000, '房主的 peer-join');
    assert.equal(pj.peerId, 'host');
    assert.ok(!('hostKey' in pj));

    // 房主走了：信令宣布离开的人记下来；回来了就撤掉
    assert.equal(sig.hasLeft('host'), false);
    const left = new Promise((resolve) => sig.once('peer-leave', resolve));
    await back.close();
    await withTimeout(left, 3000, '房主的 peer-leave');
    assert.equal(sig.hasLeft('host'), true);
    const returned = new Promise((resolve) => sig.once('peer-join', resolve));
    const back2 = await join(srv.url, 'client-room', 'host', { clients, hostToken: token });
    assert.equal(back2.reply.t, 'joined');
    await withTimeout(returned, 3000, '房主再回来的 peer-join');
    assert.equal(sig.hasLeft('host'), false);
  });

  test(`${name}：WsSignaling 首次加入不带建房提示（房间不在就是关了），重连才带；进房前不发信令`, { timeout: 10000 }, async (t) => {
    const { WsSignaling } = await import(dir + 'signaling.js');
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((resolve) => wss.once('listening', resolve));
    const joins = [];
    const signals = [];
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.t === 'signal') return signals.push(msg);
        if (msg.t !== 'join') return;
        joins.push(msg);
        const peers = joins.length === 1 ? [{ peerId: 'host', name: 'H' }] : [];
        ws.send(JSON.stringify({ t: 'joined', peerId: 'g', peers, hostId: 'host', maxMembers: 6, hostKey: 'k'.repeat(43) }));
        if (joins.length === 1) {
          ws.send(JSON.stringify({ t: 'room-config', maxMembers: 7 }));
          // 出了毛病的服务器推一大堆 peer-leave：记着的人数有上限，最近的留着
          for (let i = 0; i < 100; i++) ws.send(JSON.stringify({ t: 'peer-leave', peerId: `x${i}` }));
          setTimeout(() => ws.terminate(), 50); // 网络抖一下
        }
      });
    });
    let sig = null;
    t.after(() => {
      sig?.close();
      for (const c of wss.clients) c.terminate();
      return new Promise((resolve) => wss.close(resolve));
    });

    sig = new WsSignaling({ url: `ws://127.0.0.1:${wss.address().port}`, roomId: 'room', peerId: 'g', name: 'G', maxMembers: 4, hostId: 'host' });
    sig.signal('host', { kind: 'ice' }); // 还没连上：不发
    const rejoined = new Promise((resolve) => sig.on('joined', () => joins.length === 2 && resolve()));
    await sig.connect();
    await withTimeout(rejoined, 5000, '重连');

    assert.ok(!('hostHint' in joins[0]) && !('hostKey' in joins[0]), '首次加入不该带建房提示');
    assert.equal(joins[0].maxMembers, 4);
    assert.equal(joins[1].hostHint, 'host');
    assert.equal(joins[1].hostKey, 'k'.repeat(43), '重连时没把服务器给的摘要交回去');
    assert.equal(joins[1].maxMembers, 7, '重连时的人数提示没跟着 room-config 更新');
    assert.equal(sig.hasLeft('x99'), true);
    assert.equal(sig.hasLeft('x0'), false, '记「离开」的表没有上限');
    assert.ok(sig._left.size <= 64);
    sig.signal('host', { kind: 'ice', n: 1 });
    await sleep(100);
    assert.deepEqual(signals.map((m) => m.payload.n), [1], '进房前的信令发出去了');
  });

  test(`${name}：WsSignaling 撞 DUP_PEER（自己的旧连接还挂着）时按固定的短间隔重试，有上限；平时照旧指数退避`, (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    return import(dir + 'signaling.js').then(({ WsSignaling }) => {
      const sig = new WsSignaling({ url: 'ws://127.0.0.1:9', roomId: 'r', peerId: 'p', name: 'P' });
      sig._closedByUs = true; // 只看排的间隔，不真去连
      const delays = [];
      sig.on('reconnecting', ({ in: ms }) => delays.push(ms));
      sig._scheduleReconnect();
      sig._scheduleReconnect();
      sig._dupStreak = 1;
      sig._scheduleReconnect();
      sig._scheduleReconnect();
      sig._dupStreak = 99;
      sig._scheduleReconnect();
      assert.deepEqual(delays, [1000, 2000, 5000, 5000, 4000]);
      t.mock.timers.reset();
    });
  });

  test(`${name}：WsSignaling 进房前不发信令、不改人数；房主报人数只在变了、进了房、知道上限时才发`, () =>
    import(dir + 'signaling.js').then(({ WsSignaling }) => {
      const sig = new WsSignaling({ url: 'ws://x', roomId: 'r', peerId: 'p', name: 'P', maxMembers: 4, hostId: 'p' });
      const sent = [];
      // 套接字开着、join 还没被接受（服务器正在探旧连接的死活）：这时发的信令服务器不认
      sig.ws = { readyState: WebSocket.OPEN, send: (d) => sent.push(JSON.parse(d)) };
      sig.signal('q', { kind: 'ice' });
      sig.setMaxMembers(6);
      sig.setOutside(2); // 记下，重连时随 join 带
      assert.deepEqual(sent, []);
      assert.equal(sig.maxMembers, 6);
      assert.equal(sig.outside, 2);

      sig.connected = true;
      sig.signal('q', { kind: 'ice' });
      sig.setOutside(2);
      sig.setOutside(3);
      sig.setOutside(-1);
      assert.deepEqual(sent, [
        { t: 'signal', to: 'q', from: 'p', payload: { kind: 'ice' } },
        { t: 'room-config', maxMembers: 6, outside: 3 },
        { t: 'room-config', maxMembers: 6, outside: 0 },
      ]);
      // 不知道上限（0）时不发：服务器会把 0 当成「用默认值」，把房间人数改掉
      const blind = new WsSignaling({ url: 'ws://x', roomId: 'r', peerId: 'p', name: 'P' });
      const out = [];
      blind.ws = { readyState: WebSocket.OPEN, send: (d) => out.push(d) };
      blind.connected = true;
      blind.setOutside(1);
      assert.deepEqual(out, []);
    }));
}

test('WsSignaling 两份逐字相同', () => {
  const fs = require('node:fs');
  const [a, b] = IMPLS.map(({ dir }) => fs.readFileSync(path.join(__dirname, dir, 'signaling.js'), 'utf8').replace(/\r\n/g, '\n'));
  assert.equal(a, b);
});
