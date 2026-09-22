'use strict';

/**
 * 房主的信令连接掉线后必须能回到自己的房间。
 *
 * 曾经的真 bug：HOST_ID_RESERVED 本来是防别人顶着房主的 peerId 接管控场权的，
 * 但服务器分不清「房主本人重连」和「冒名顶替」，房间里只要还有人，房主自己也被挡在外面。
 * 客户端按退避无限重连、每次都被拒，从此再也收不到新人的 peer-join —— 新人进得来房，
 * 却永远等不到房主发起的 offer。
 *
 * 修法是建房时只发给房主一张续期凭据 hostToken，重连时凭它拿回身份。
 * 这组测试起真服务器，守住三件事：房主能回来；没凭据的冒名者回不来；凭据对不上也回不来。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');
const { IMPLS } = require('./helpers/impls');

const SERVER = path.join(__dirname, '..', 'signaling-server', 'server.js');

/** 起一个真信令服务器；端口随机，撞上被占用的就换一个再试。 */
async function startServer(t) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 45000 + Math.floor(Math.random() * 10000);
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: String(port), MAX_ROOM_SIZE: '16', BLOCKED_COUNTRIES: '', NOXREEL_TEST_MUTE: '1' },
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
      return `ws://127.0.0.1:${port}`;
    }
    child.kill();
    if (!stderr.includes('已被占用')) throw new Error(`信令服务器启动失败：${stderr}`);
  }
  throw new Error('连续几个端口都被占用，信令服务器起不来');
}

/** 裸 WebSocket 客户端：从连上那一刻起记下收到的每条消息，等消息时先翻已收到的。 */
async function connect(url) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = new Set();
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
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.on('error', () => {}); // 服务器拒绝后会主动断开，别让迟到的 error 事件变成未处理异常
  return {
    ws,
    inbox,
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
      if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
      return new Promise((resolve) => {
        ws.once('close', resolve);
        ws.close();
      });
    },
  };
}

async function join(url, roomId, peerId, extra = {}) {
  const c = await connect(url);
  c.send({ t: 'join', roomId, peerId, name: peerId, maxMembers: 0, ...extra });
  c.reply = await c.waitFor((m) => m.t === 'joined' || m.t === 'error', `${peerId} 的 join 答复`);
  return c;
}

/** 房主掉线：等到房里的另一个人收到 peer-leave，说明服务器已经把他移出了成员表。 */
async function dropHost(host, witness) {
  await host.close();
  await witness.waitFor((m) => m.t === 'peer-leave' && m.peerId === 'host', '房主的 peer-leave');
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

test('房主信令掉线后凭续期凭据重连成功，重连后照常收到新人的 peer-join', { timeout: 15000 }, async (t) => {
  // 先登记关客户端、再起服务器：after 钩子按登记顺序跑，客户端得赶在服务器被杀之前正常断开
  const clients = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));
  const url = await startServer(t);

  const host = await join(url, 'reconnect-room', 'host', { maxMembers: 4 });
  clients.push(host);
  assert.equal(host.reply.t, 'joined');
  assert.equal(host.reply.hostId, 'host');
  const token = host.reply.hostToken;
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 32, '续期凭据太短，可以被猜出来');

  const guest = await join(url, 'reconnect-room', 'guest');
  clients.push(guest);
  assert.equal(guest.reply.t, 'joined');
  assert.equal(guest.reply.hostId, 'host');
  assert.ok(!('hostToken' in guest.reply), '续期凭据只能回给房主本人');

  await dropHost(host, guest);

  const back = await join(url, 'reconnect-room', 'host', { hostToken: token });
  clients.push(back);
  assert.equal(back.reply.t, 'joined', `房主重连被拒：${back.reply.code}`);
  assert.equal(back.reply.hostId, 'host');
  assert.equal(back.reply.hostToken, token, '重连后凭据不变，下次掉线还能再用');
  assert.deepEqual(back.reply.peers.map((p) => p.peerId), ['guest']);
  await guest.waitFor((m) => m.t === 'peer-join' && m.peerId === 'host', '房主重连的 peer-join');

  // 原始症状：房主重连不上，就再也收不到新人的 peer-join
  const newcomer = await join(url, 'reconnect-room', 'newcomer');
  clients.push(newcomer);
  assert.equal(newcomer.reply.t, 'joined');
  await back.waitFor((m) => m.t === 'peer-join' && m.peerId === 'newcomer', '新人的 peer-join');

  // 回来的仍是服务器认的房主：还能改房间人数
  back.send({ t: 'room-config', maxMembers: 5 });
  assert.equal((await back.waitFor((m) => m.t === 'room-config', 'room-config')).maxMembers, 5);

  // 凭据绝不能出现在发给其他成员的任何消息里
  await guest.waitFor((m) => m.t === 'room-config', '其他成员的 room-config');
  for (const other of [guest, newcomer]) {
    for (const msg of other.inbox) {
      assert.ok(!JSON.stringify(msg).includes(token), `续期凭据泄露给了其他成员：${JSON.stringify(msg)}`);
    }
  }
});

test('房主掉线期间，别人顶着房主的 peerId 来 join 仍被拒', { timeout: 15000 }, async (t) => {
  const clients = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));
  const url = await startServer(t);

  const host = await join(url, 'imposter-room', 'host', { maxMembers: 4 });
  clients.push(host);
  const token = host.reply.hostToken;
  const guest = await join(url, 'imposter-room', 'guest');
  clients.push(guest);
  await dropHost(host, guest);

  // 不带凭据，或者塞各种不是字符串的东西，都不能蒙混过去
  for (const extra of [{}, { hostToken: '' }, { hostToken: null }, { hostToken: 0 }, { hostToken: [token] }, { hostToken: { token } }]) {
    const imposter = await join(url, 'imposter-room', 'host', extra);
    clients.push(imposter);
    assert.equal(imposter.reply.t, 'error', `冒名者进房了：${JSON.stringify(extra)}`);
    assert.equal(imposter.reply.code, 'HOST_ID_RESERVED');
  }
  assert.ok(
    !guest.inbox.some((m) => m.t === 'peer-join' && m.peerId === 'host'),
    '被拒的冒名者不该被广播成房主回来了'
  );

  // 被拒的尝试不会把位置占掉，房主本人照样回得来
  const back = await join(url, 'imposter-room', 'host', { hostToken: token });
  clients.push(back);
  assert.equal(back.reply.t, 'joined');
});

test('续期凭据对不上也被拒：别的房间的凭据、改了一个字符或多一截的凭据都不行', { timeout: 15000 }, async (t) => {
  const clients = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));
  const url = await startServer(t);

  // 另一个房间的房主拿到的凭据，在这个房间里不能用（房主 peerId 也故意取成一样的）
  const other = await join(url, 'room-a', 'host', { maxMembers: 4 });
  clients.push(other);
  const foreignToken = other.reply.hostToken;

  const host = await join(url, 'room-b', 'host', { maxMembers: 4 });
  clients.push(host);
  const token = host.reply.hostToken;
  assert.notEqual(token, foreignToken, '每个房间的凭据都得是独立随机生成的');
  const guest = await join(url, 'room-b', 'guest');
  clients.push(guest);
  await dropHost(host, guest);

  const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
  for (const wrong of [foreignToken, flipped, token + 'x', token.slice(0, -1)]) {
    const attempt = await join(url, 'room-b', 'host', { hostToken: wrong });
    clients.push(attempt);
    assert.equal(attempt.reply.t, 'error', `错误的凭据被放行了：${wrong}`);
    assert.equal(attempt.reply.code, 'HOST_ID_RESERVED');
  }

  const back = await join(url, 'room-b', 'host', { hostToken: token });
  clients.push(back);
  assert.equal(back.reply.t, 'joined');
});

test('房主掉线期间替他留着名额：补位的新人撞 ROOM_FULL，房主照样回得来', { timeout: 15000 }, async (t) => {
  const clients = [];
  t.after(() => Promise.all(clients.map((c) => c.close())));
  const url = await startServer(t);

  const host = await join(url, 'seat-room', 'host', { maxMembers: 2 });
  clients.push(host);
  const token = host.reply.hostToken;
  const guest = await join(url, 'seat-room', 'guest');
  clients.push(guest);
  await dropHost(host, guest);

  const filler = await join(url, 'seat-room', 'filler');
  clients.push(filler);
  assert.equal(filler.reply.t, 'error');
  assert.equal(filler.reply.code, 'ROOM_FULL');

  const back = await join(url, 'seat-room', 'host', { hostToken: token });
  clients.push(back);
  assert.equal(back.reply.t, 'joined', `房主的名额被占了：${back.reply.code}`);
});

for (const { name, dir } of IMPLS) {
  test(`${name}：WsSignaling 掉线后自动重连带上续期凭据，之后照常收到 peer-join`, { timeout: 15000 }, async (t) => {
    const { WsSignaling } = await import(dir + 'signaling.js');
    const clients = [];
    let sig = null;
    t.after(() => {
      sig?.close();
      return Promise.all(clients.map((c) => c.close()));
    });
    const url = await startServer(t);
    sig = new WsSignaling({ url, roomId: 'client-room', peerId: 'host', name: 'Host', maxMembers: 4 });

    const joined = await sig.connect();
    assert.equal(joined.hostId, 'host');
    assert.ok(!('hostToken' in joined), '续期凭据留在 WsSignaling 里，不交给调用方');

    const guest = await join(url, 'client-room', 'guest');
    clients.push(guest);

    const rejoined = new Promise((resolve, reject) => {
      sig.once('joined', resolve);
      sig.once('error', (e) => reject(new Error(`重连被拒：${e.code} ${e.message}`)));
    });
    // 模拟网络抖动：不是调用方主动 close()，WsSignaling 会按退避自己重连
    sig.ws.close();
    await guest.waitFor((m) => m.t === 'peer-leave' && m.peerId === 'host', '房主的 peer-leave');
    const again = await withTimeout(rejoined, 5000, '房主重连');
    assert.equal(again.hostId, 'host');
    assert.ok(!('hostToken' in again));

    const peerJoin = new Promise((resolve) => sig.once('peer-join', resolve));
    const newcomer = await join(url, 'client-room', 'newcomer');
    clients.push(newcomer);
    assert.equal(newcomer.reply.t, 'joined');
    assert.equal((await withTimeout(peerJoin, 3000, '新人的 peer-join')).peerId, 'newcomer');
  });
}
