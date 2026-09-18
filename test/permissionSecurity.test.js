'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { IMPLS } = require('./helpers/impls');

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

/** 形状和摘要都合法的清单：fileId = 全部分片哈希拼起来的 SHA-256 前 32 位。 */
function manifestFor(tag, chunkCount) {
  const hashes = Array.from({ length: chunkCount }, (_, i) => `${tag}${i}`.padStart(64, '0'));
  return {
    fileId: crypto.createHash('sha256').update(hashes.join('')).digest('hex').slice(0, 32),
    name: `${tag}.mkv`,
    size: chunkCount * 2 * 1024 ** 2,
    chunkSize: 2 * 1024 ** 2,
    chunkCount,
    hashes,
  };
}

function fakePeer(peerId, extra = {}) {
  return {
    peerId, name: peerId, authenticated: false, allowIdentityRename: false,
    pc: { iceConnectionState: 'connected' }, inflight: new Set(), bytesReceived: 0, bytesSent: 0,
    ...extra,
  };
}

/** 测试里不走 addPeer（它要真的事件源），手动登记按人索引的几张表。 */
function register(swarm, peer) {
  swarm.peers.set(peer.peerId, peer);
  swarm._serving.set(peer.peerId, 0);
  swarm._serveQueue.set(peer.peerId, []);
}

/**
 * 权限只认承载消息的那条 P2P 连接。v2 的 SYNC / STALL 必须带 seq（STALL 还要 stallSeq），
 * 这里的伪造消息一律把这些字段带齐 —— 否则它们会因为字段不全被丢掉，根本走不到权限那一关，
 * 测试就成了空跑。
 */
impl('控制权限绑定实际 P2P 发送者，消息字段不能冒充房主', async (dir) => {
  const { SyncEngine } = await import(dir + 'syncEngine.js');
  const { MSG } = await import(dir + 'protocol.js');
  const sync = new SyncEngine({ peerId: 'self-peer', name: 'self', isSeeder: false, hostId: 'host-peer' });
  sync.started = true;
  sync.roles.set('guest-peer', 'guest');
  sync.roles.set('admin-peer', 'admin');
  const guest = { peerId: 'guest-peer', name: 'guest' };
  const host = { peerId: 'host-peer', name: 'host' };

  // by 字段写成房主也没用
  sync.onCtrl(
    { t: MSG.SYNC, paused: false, position: 120, lamport: 10, by: 'host-peer', name: '伪造房主', seq: 0 },
    guest
  );
  // origin 只有从房主那条连接来时才采信；游客自称「替房主转发」照样按游客本人算
  sync.onCtrl(
    { t: MSG.SYNC, paused: false, position: 120, lamport: 10, origin: 'host-peer', originName: '房主', seq: 0 },
    guest
  );
  assert.equal(sync.shared.lamport, 0);
  assert.equal(sync.intendedPaused, true);
  // 被拒的消息也不能推高本机 Lamport，否则游客灌一个超大时钟就能让之后的合法指令全被当成旧的
  assert.equal(sync.clock, 0);

  sync.onCtrl(
    { t: MSG.STALL, stalled: true, peerId: 'host-peer', position: 0, deficitSeconds: 0, seq: 0, stallSeq: 1 },
    guest
  );
  sync.onCtrl(
    { t: MSG.STALL, stalled: true, origin: 'admin-peer', originName: '管理员', position: 0, seq: 0, stallSeq: 2 },
    guest
  );
  assert.equal(sync.stalledPeers.size, 0);

  // 房主转发的管理员卡顿要采信；游客冒充房主「替他解除」不行
  sync.onCtrl(
    { t: MSG.STALL, stalled: true, origin: 'admin-peer', originName: '管理员', position: 0, seq: 0, stallSeq: 1 },
    host
  );
  assert.equal(sync.stalledPeers.has('admin-peer'), true);
  sync.onCtrl(
    { t: MSG.STALL, stalled: false, release: true, origin: 'admin-peer', seq: 0, stallSeq: 9 },
    guest
  );
  assert.equal(sync.stalledPeers.has('admin-peer'), true, '只有房主连接来的 release 才能替别人解除卡顿');

  sync.onCtrl(
    { t: MSG.SYNC, paused: false, position: 12, lamport: 11, by: 'someone-else', seq: 0 },
    host
  );
  assert.equal(sync.shared.by, 'host-peer');
  assert.equal(sync.shared.position, 12);
});

impl('HELLO 不能覆盖已有房主身份', async (dir) => {
  const { Swarm } = await import(dir + 'swarm.js');
  const { MSG, PROTOCOL_VERSION } = await import(dir + 'protocol.js');
  const swarm = new Swarm({ peerId: 'self-peer', name: 'self' });
  let closed = false;
  let identity = null;
  const host = fakePeer('host-peer', { authenticated: true });
  const guest = fakePeer('guest-peer', { close: () => { closed = true; } });
  register(swarm, host);
  register(swarm, guest);
  swarm.on('identity-mismatch', (v) => { identity = v; });

  // 带上当前协议版本：不带的话会先被版本关拦下，这条就测不到身份那一关了
  swarm._onCtrl(guest, { t: MSG.HELLO, peerId: 'host-peer', name: 'fake-host', ver: PROTOCOL_VERSION });
  assert.deepEqual(identity, { expected: 'guest-peer', claimed: 'host-peer' });
  assert.equal(swarm.versionRejected.has('guest-peer'), false);
  assert.equal(closed, true);
  assert.equal(swarm.peers.get('host-peer'), host);
  assert.equal(swarm.peers.has('guest-peer'), false);
});

/**
 * 模式协商通过之前什么都不能发：v2 握手后第一批发出去的是各槽位的位图，
 * 清单要等对方认证后用 MANIFEST_GET 来取。未认证连接发来的取清单 / 要片请求也一概不理。
 */
impl('安全模式与可信房间不匹配时在媒体清单发送前断开', async (dir) => {
  const { Swarm } = await import(dir + 'swarm.js');
  const { MSG, PROTOCOL_VERSION } = await import(dir + 'protocol.js');
  const swarm = new Swarm({ peerId: 'self-peer', name: 'self', securityMode: 'safe' });
  let closed = false;
  let mismatch = null;
  const peer = fakePeer('guest-peer', {
    send: () => { throw new Error('模式确认前不应发送任何东西'); },
    close: () => { closed = true; },
  });
  register(swarm, peer);
  const manifest = manifestFor('a', 2);
  swarm.addFile({ slot: 1, manifest, sessionId: 's1', isSeeder: true });
  swarm.on('mode-mismatch', (value) => { mismatch = value; });

  swarm._onCtrl(peer, { t: MSG.MANIFEST_GET, fileId: manifest.fileId });
  swarm._onCtrl(peer, { t: MSG.REQUEST, s: 1, index: 0 });
  swarm._onCtrl(peer, { t: MSG.REQUEST, s: 9, index: 0 });
  assert.deepEqual(swarm._serveQueue.get('guest-peer'), []);

  swarm._onCtrl(peer, { t: MSG.HELLO, peerId: peer.peerId, securityMode: 'trusted', ver: PROTOCOL_VERSION });
  assert.equal(closed, true);
  assert.equal(peer.authenticated, false);
  assert.equal(swarm.peers.has('guest-peer'), false);
  assert.deepEqual(mismatch, {
    peerId: 'guest-peer', localMode: 'safe', remoteMode: 'trusted',
  });
});

impl('双方模式一致后才认证连接并放行业务消息', async (dir) => {
  const { Swarm } = await import(dir + 'swarm.js');
  const { MSG, PROTOCOL_VERSION, packBitfield } = await import(dir + 'protocol.js');
  const swarm = new Swarm({ peerId: 'self-peer', name: 'self', securityMode: 'trusted' });
  let authenticated = null;
  const ctrl = [];
  const sent = [];
  const peer = fakePeer('guest-peer', {
    send: (m) => { sent.push(m); return true; },
    close: () => { throw new Error('模式一致不该断开'); },
  });
  register(swarm, peer);
  swarm.on('peer-authenticated', (value) => { authenticated = value; });
  swarm.on('ctrl', (e) => ctrl.push(e.msg.t));

  const seeded = manifestFor('b', 2);
  const partial = manifestFor('c', 3);
  swarm.addFile({ slot: 1, manifest: seeded, sessionId: 's1', isSeeder: true });
  swarm.addFile({
    slot: 2,
    manifest: partial,
    sessionId: 's2',
    isSeeder: false,
    state: { bitfield: packBitfield(Uint8Array.from([1, 0, 1])), haveCount: 2, contiguousBytes: partial.chunkSize },
  });

  // 认证前：取清单、要片、未知类型的业务消息都不理，也不回任何东西
  swarm._onCtrl(peer, { t: MSG.MANIFEST_GET, fileId: seeded.fileId });
  swarm._onCtrl(peer, { t: MSG.REQUEST, s: 9, index: 0 });
  swarm._onCtrl(peer, { t: MSG.CHAT, text: 'hi' });
  assert.deepEqual(sent, []);
  assert.deepEqual(ctrl, []);
  assert.equal(authenticated, null);

  swarm._onCtrl(peer, { t: MSG.HELLO, peerId: peer.peerId, securityMode: 'trusted', ver: PROTOCOL_VERSION });
  assert.equal(peer.authenticated, true);
  assert.equal(authenticated, peer);
  // 认证后先发各槽位的位图：收完的只报「全有」，没收完的整张发；清单不再随握手推送
  assert.deepEqual(sent, [
    { t: MSG.BITFIELD, s: 1, full: true },
    { t: MSG.BITFIELD, s: 2, bits: packBitfield(Uint8Array.from([1, 0, 1])) },
  ]);

  // 之后业务消息才放行
  sent.length = 0;
  swarm._onCtrl(peer, { t: MSG.MANIFEST_GET, fileId: seeded.fileId });
  swarm._onCtrl(peer, { t: MSG.REQUEST, s: 9, index: 0 });
  swarm._onCtrl(peer, { t: MSG.CHAT, text: 'hi' });
  assert.deepEqual(sent, [
    { t: MSG.MANIFEST, manifest: seeded },
    { t: MSG.DENY, s: 9, index: 0, gone: true },
  ]);
  assert.deepEqual(ctrl, [MSG.CHAT]);
});

test('畸形位图和超大数据帧不会进入分片组装器', async () => {
  const { decodeFrame, unpackBitfield, FRAME_HEADER_BYTES, FRAME_PAYLOAD_BYTES } = await import('../src/renderer/lib/protocol.js');
  assert.deepEqual([...unpackBitfield('%%%not-base64%%%', 16)], new Array(16).fill(0));
  assert.equal(decodeFrame(new Uint8Array(FRAME_HEADER_BYTES + FRAME_PAYLOAD_BYTES + 1)), null);
  assert.equal(decodeFrame('not-binary'), null);
});
