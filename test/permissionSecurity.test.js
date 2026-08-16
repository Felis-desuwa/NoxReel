'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('控制权限绑定实际 P2P 发送者，消息字段不能冒充房主', async () => {
  const { SyncEngine } = await import('../src/renderer/lib/syncEngine.js');
  const { MSG } = await import('../src/renderer/lib/protocol.js');
  const sync = new SyncEngine({ peerId: 'self-peer', name: 'self', isSeeder: false, hostId: 'host-peer' });
  sync.started = true;
  sync.roles.set('guest-peer', 'guest');

  sync.onCtrl(
    { t: MSG.SYNC, paused: false, position: 120, lamport: 10, by: 'host-peer', name: '伪造房主' },
    { peerId: 'guest-peer', name: 'guest' }
  );
  assert.equal(sync.shared.lamport, 0);
  assert.equal(sync.intendedPaused, true);

  sync.onCtrl(
    { t: MSG.STALL, stalled: true, peerId: 'host-peer', position: 0, deficitSeconds: 0 },
    { peerId: 'guest-peer', name: 'guest' }
  );
  assert.equal(sync.stalledPeers.size, 0);

  sync.onCtrl(
    { t: MSG.SYNC, paused: false, position: 12, lamport: 11, by: 'someone-else' },
    { peerId: 'host-peer', name: 'host' }
  );
  assert.equal(sync.shared.by, 'host-peer');
  assert.equal(sync.shared.position, 12);
});

test('HELLO 不能覆盖已有房主身份', async () => {
  const { Swarm } = await import('../src/renderer/lib/swarm.js');
  const { MSG } = await import('../src/renderer/lib/protocol.js');
  const swarm = new Swarm({ peerId: 'self-peer', name: 'self' });
  let closed = false;
  const host = {
    peerId: 'host-peer', name: 'host', pc: { iceConnectionState: 'connected' }, inflight: new Set(),
    bytesReceived: 0, bytesSent: 0,
  };
  const guest = {
    peerId: 'guest-peer', name: 'guest', allowIdentityRename: false,
    pc: { iceConnectionState: 'connected' }, inflight: new Set(), bytesReceived: 0, bytesSent: 0,
    close: () => { closed = true; },
  };
  swarm.peers.set(host.peerId, host);
  swarm.peers.set(guest.peerId, guest);
  swarm._serving.set(guest.peerId, 0);
  swarm._serveQueue.set(guest.peerId, []);

  swarm._onCtrl(guest, { t: MSG.HELLO, peerId: 'host-peer', name: 'fake-host' });
  assert.equal(closed, true);
  assert.equal(swarm.peers.get('host-peer'), host);
  assert.equal(swarm.peers.has('guest-peer'), false);
});

test('安全模式与可信房间不匹配时在媒体清单发送前断开', async () => {
  const { Swarm } = await import('../src/renderer/lib/swarm.js');
  const { MSG } = await import('../src/renderer/lib/protocol.js');
  const swarm = new Swarm({ peerId: 'self-peer', name: 'self', securityMode: 'safe' });
  let closed = false;
  let mismatch = null;
  const peer = {
    peerId: 'guest-peer', name: 'guest', authenticated: false, allowIdentityRename: false,
    pc: { iceConnectionState: 'connected' }, inflight: new Set(), bytesReceived: 0, bytesSent: 0,
    send: () => { throw new Error('模式确认前不应发送清单'); },
    close: () => { closed = true; },
  };
  swarm.peers.set(peer.peerId, peer);
  swarm._serving.set(peer.peerId, 0);
  swarm._serveQueue.set(peer.peerId, []);
  swarm.manifest = { fileId: 'x', hashes: [] };
  swarm.on('mode-mismatch', (value) => { mismatch = value; });

  swarm._onCtrl(peer, { t: MSG.HELLO, peerId: peer.peerId, securityMode: 'trusted' });
  assert.equal(closed, true);
  assert.equal(peer.authenticated, false);
  assert.deepEqual(mismatch, {
    peerId: 'guest-peer', localMode: 'safe', remoteMode: 'trusted',
  });
});

test('双方模式一致后才认证连接并放行业务消息', async () => {
  const { Swarm } = await import('../src/renderer/lib/swarm.js');
  const { MSG } = await import('../src/renderer/lib/protocol.js');
  const swarm = new Swarm({ peerId: 'self-peer', name: 'self', securityMode: 'trusted' });
  let authenticated = null;
  const peer = {
    peerId: 'guest-peer', name: 'guest', authenticated: false, allowIdentityRename: false,
    pc: { iceConnectionState: 'connected' }, inflight: new Set(), bytesReceived: 0, bytesSent: 0,
  };
  swarm.peers.set(peer.peerId, peer);
  swarm.on('peer-authenticated', (value) => { authenticated = value; });

  swarm._onCtrl(peer, { t: MSG.HELLO, peerId: peer.peerId, securityMode: 'trusted' });
  assert.equal(peer.authenticated, true);
  assert.equal(authenticated, peer);
});

test('畸形位图和超大数据帧不会进入分片组装器', async () => {
  const { decodeFrame, unpackBitfield, FRAME_HEADER_BYTES, FRAME_PAYLOAD_BYTES } = await import('../src/renderer/lib/protocol.js');
  assert.deepEqual([...unpackBitfield('%%%not-base64%%%', 16)], new Array(16).fill(0));
  assert.equal(decodeFrame(new Uint8Array(FRAME_HEADER_BYTES + FRAME_PAYLOAD_BYTES + 1)), null);
  assert.equal(decodeFrame('not-binary'), null);
});
