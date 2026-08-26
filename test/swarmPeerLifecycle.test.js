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

/** 带事件派发的假 peer —— 上面那个 on() 是空壳，测不了关闭事件的时序。 */
function eventfulPeer(peerId) {
  const peer = fakePeer(peerId);
  const handlers = new Map();
  peer.on = (event, fn) => {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event).push(fn);
    return () => {};
  };
  peer.emit = (event, ...args) => {
    for (const fn of handlers.get(event) || []) fn(...args);
  };
  return peer;
}

/**
 * 对端信令重连后会重新发 offer，我方按同一个 peerId 换上新 Peer；旧连接的 close
 * 事件是异步到达的，等它轮到时新连接已经建好了。按 peerId 无差别删除的话，删掉的
 * 正是刚建好的那条 —— 之后谁也不会再发起协商，传输永久停在原地。
 */
impl('旧连接迟到的 close 不会把顶替它的新连接摘掉', async (dir) => {
  const { Swarm } = await import(dir + 'swarm.js');
  const swarm = new Swarm({ peerId: 'me', name: 'me' });

  const stale = eventfulPeer('other');
  swarm.addPeer(stale);
  const fresh = eventfulPeer('other');
  swarm.addPeer(fresh);

  stale.emit('close'); // 旧连接的关闭事件姗姗来迟

  assert.equal(swarm.peers.get('other'), fresh, '新连接必须留在表里');
  assert.equal(swarm.peers.size, 1);
});

impl('peer 自己关闭时仍会从 swarm 摘掉', async (dir) => {
  const { Swarm } = await import(dir + 'swarm.js');
  const swarm = new Swarm({ peerId: 'me', name: 'me' });

  const peer = eventfulPeer('other');
  swarm.addPeer(peer);
  peer.emit('close');

  assert.equal(swarm.peers.has('other'), false);
});

impl('failed 也遵守同样的身份守卫', async (dir) => {
  const { Swarm } = await import(dir + 'swarm.js');
  const swarm = new Swarm({ peerId: 'me', name: 'me' });

  const stale = eventfulPeer('other');
  swarm.addPeer(stale);
  const fresh = eventfulPeer('other');
  swarm.addPeer(fresh);
  stale.emit('failed');

  assert.equal(swarm.peers.get('other'), fresh);
});

/**
 * 收到 offer 等于对方已经另起了一条连接。复用手上那个同 id 的残骸去
 * setRemoteDescription，ICE 会在一条废掉的 pc 上重来一遍，双方都以为在协商。
 */
for (const [label, file] of [
  ['桌面端', ['src', 'renderer', 'app.js']],
  ['安卓端', ['android', 'app', 'src', 'main', 'assets', 'js', 'app-android.js']],
]) test(`${label}：收到 offer 时不复用已有的同 id 连接`, () => {
  const app = fs.readFileSync(path.join(__dirname, '..', ...file), 'utf8');
  const start = app.indexOf("if (payload.kind === 'offer')");
  assert.ok(start > 0, 'offer 分支必须存在');
  const body = app.slice(start, start + 1200);
  assert.match(body, /if \(peer\) S\.swarm\.removePeer\(from\);/, 'offer 到达时必须先摘掉旧连接');
  assert.doesNotMatch(body, /if \(!peer\) \{\s*\r?\n\s*peer = new Peer/, '不能只在没有 peer 时才新建');
  assert.match(app.slice(start, start + 1600), /if \(!peer \|\| peer\.closed\) return;/, '已关闭的连接不能再喂 answer/ice');
});
