'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IMPLS } = require('./helpers/impls');
const fs = require('node:fs');
const path = require('node:path');

function fakePeer(peerId) {
  return {
    peerId,
    name: peerId,
    pc: { iceConnectionState: 'connected' },
    authenticated: false,
    ready: false,
    remoteManifest: null,
    remoteHave: null,
    inflight: new Set(),
    closed: false,
    on() {
      return () => {};
    },
    send() {
      return true;
    },
    close() {
      this.closed = true;
    },
  };
}


function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

/**
 * 信令模式下同一个 peerId 可能再来一次（对方信令重连后，房间里的老成员会收到
 * peer-join 重新发起 offer）。直接覆盖 peers 表的话，旧的 RTCPeerConnection
 * 既没关也还挂着监听器，成了收得到消息却谁也管不着的幽灵。
 */
impl('同一个 peerId 再次接入时旧连接会被摘掉，不留幽灵', async (dir) => {
  const { Swarm } = await import(dir + 'swarm.js');
  const swarm = new Swarm({ peerId: 'me', name: 'me' });

  const first = fakePeer('other');
  swarm.addPeer(first);
  const second = fakePeer('other');
  swarm.addPeer(second);

  assert.equal(first.closed, true, '旧连接必须关掉');
  assert.equal(swarm.peers.get('other'), second);
  assert.equal(swarm.peers.size, 1);
  assert.equal(swarm._serving.get('other'), 0);
  assert.deepEqual(swarm._serveQueue.get('other'), []);
});

impl('重复登记同一个 peer 对象不会把它自己关掉', async (dir) => {
  const { Swarm } = await import(dir + 'swarm.js');
  const swarm = new Swarm({ peerId: 'me', name: 'me' });

  const peer = fakePeer('other');
  swarm.addPeer(peer);
  swarm.addPeer(peer);

  assert.equal(peer.closed, false);
  assert.equal(swarm.peers.get('other'), peer);
});

/**
 * 信令断了不等于人走了：直连不经过服务器。服务重启或网络抖一下，服务器就会广播
 * peer-leave，这时候把健康的 P2P 拆掉，传输会白白中断到对方重连为止。
 */
for (const [label, file] of [
  ['桌面端', ['src', 'renderer', 'app.js']],
  ['安卓端', ['android', 'app', 'src', 'main', 'assets', 'js', 'app-android.js']],
]) test(`${label}：信令 peer-leave 不会拆掉控制通道还开着的直连`, () => {
  const app = fs.readFileSync(path.join(__dirname, '..', ...file), 'utf8');
  const start = app.indexOf("sig.on('peer-leave'");
  assert.ok(start > 0, 'peer-leave 处理必须存在');
  const body = app.slice(start, start + 600);
  assert.match(body, /ctrl\?\.readyState === 'open'/, '直连还活着就不能摘掉');
  assert.doesNotMatch(
    app,
    /sig\.on\('peer-leave', \(\{ peerId \}\) => S\.swarm\.removePeer\(peerId\)\);/,
    '不能无条件 removePeer'
  );
});
