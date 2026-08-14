'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');

function waitForMessage(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(reject, new Error('等待 WebSocket 消息超时')), timeoutMs);
    const onMessage = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (predicate(msg)) finish(resolve, msg);
    };
    const finish = (fn, value) => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      fn(value);
    };
    ws.on('message', onMessage);
  });
}

async function join(url, peerId, maxMembers) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const result = waitForMessage(ws, (m) => m.t === 'joined' || m.t === 'error');
  ws.send(JSON.stringify({ t: 'join', roomId: 'capacity-test', peerId, name: peerId, maxMembers }));
  return { ws, message: await result };
}

test('房主可设房间人数，满员会拒绝且可实时调高', { timeout: 10000 }, async (t) => {
  const port = 35000 + Math.floor(Math.random() * 10000);
  const serverPath = path.join(__dirname, '..', 'signaling-server', 'server.js');
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(port), MAX_ROOM_SIZE: '16' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('信令服务器启动超时')), 3000);
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes(`监听 :${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => reject(new Error(`信令服务器提前退出：${code}`)));
  });

  const url = `ws://127.0.0.1:${port}`;
  const host = await join(url, 'host', 2);
  t.after(() => host.ws.close());
  assert.equal(host.message.t, 'joined');
  assert.equal(host.message.maxMembers, 2);

  const guest = await join(url, 'guest', 0);
  t.after(() => guest.ws.close());
  assert.equal(guest.message.t, 'joined');

  const rejected = await join(url, 'rejected', 0);
  t.after(() => rejected.ws.close());
  assert.equal(rejected.message.code, 'ROOM_FULL');

  const config = waitForMessage(host.ws, (m) => m.t === 'room-config');
  host.ws.send(JSON.stringify({ t: 'room-config', maxMembers: 3 }));
  assert.equal((await config).maxMembers, 3);

  const admitted = await join(url, 'admitted', 0);
  t.after(() => admitted.ws.close());
  assert.equal(admitted.message.t, 'joined');
  assert.equal(admitted.message.maxMembers, 3);
});
