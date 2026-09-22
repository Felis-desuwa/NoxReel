'use strict';

// WsSignaling 连的是用户自己填的信令服务器地址：对面发来 null、数组、数字时
// 不能在读 msg.t 那一下抛 TypeError（事件处理器里的异常会让这次进房永远等不到结果）。

const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const { IMPLS } = require('./helpers/impls');

for (const { name, dir } of IMPLS) {
  test(`${name}：信令服务器发来 null / 数组 / 数字时照常进房`, { timeout: 10000 }, async (t) => {
    const { WsSignaling } = await import(dir + 'signaling.js');
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((resolve) => wss.once('listening', resolve));
    t.after(() => {
      for (const c of wss.clients) c.terminate();
      return new Promise((resolve) => wss.close(resolve));
    });
    wss.on('connection', (ws) => {
      ws.once('message', () => {
        for (const junk of ['null', '[]', '42', '"x"']) ws.send(junk);
        ws.send(JSON.stringify({ t: 'joined', peerId: 'me', peers: [], hostId: 'me', maxMembers: 4 }));
      });
    });

    const errors = [];
    const onError = (e) => errors.push(e);
    process.on('uncaughtException', onError);
    t.after(() => process.off('uncaughtException', onError));

    const sig = new WsSignaling({ url: `ws://127.0.0.1:${wss.address().port}`, roomId: 'room', peerId: 'me', name: 'Me', maxMembers: 4 });
    t.after(() => sig.close());
    const joined = await sig.connect();
    assert.equal(joined.hostId, 'me');
    assert.deepEqual(errors, []);
  });
}
