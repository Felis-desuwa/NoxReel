'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function manifestFor(fileId, chunkCount) {
  return {
    fileId,
    name: `${fileId}.mkv`,
    size: chunkCount * 2 * 1024 ** 2,
    chunkSize: 2 * 1024 ** 2,
    chunkCount,
    hashes: Array.from({ length: chunkCount }, (_, i) => i.toString(16).padStart(64, '0')),
  };
}

function fakePeer(peerId) {
  return {
    peerId,
    name: peerId,
    pc: { iceConnectionState: 'connected' },
    authenticated: true,
    ready: false,
    remoteManifest: null,
    remoteHave: null,
    pendingManifest: null,
    inflight: new Set(),
    downRate: 0,
    sent: [],
    send(msg) {
      this.sent.push(msg);
      return true;
    },
  };
}

/**
 * 接收方的真实顺序是「先收到清单和位图 → 再异步打开本地会话」。
 * 位图只在对端握手时发一次，如果打开会话的过程把它清掉，调度器就永远筛不出上游，
 * 表现是连上了、清单也有了，却一个字节都收不到（传输面板恒显示 0 B）。
 */
test('位图先于本机会话到达时不会被清掉，调度器仍能选出上游', async () => {
  const { Swarm } = await import('../src/renderer/lib/swarm.js');
  const { packBitfield } = await import('../src/renderer/lib/protocol.js');

  const manifest = manifestFor('a'.repeat(32), 4);
  const receiver = new Swarm({ peerId: 'guest', name: 'guest' });
  const host = fakePeer('host');
  receiver.peers.set(host.peerId, host);

  // 房主握手后连着发清单和位图，两条都在本机 openLeech 返回之前到达。
  receiver._onCtrl(host, { t: 'manifest', manifest });
  receiver._onCtrl(host, { t: 'bitfield', bits: packBitfield(Uint8Array.from([1, 1, 1, 1])) });
  assert.ok(host.remoteHave, '位图应当在没有本机会话时也能解出来');

  // openLeech 返回，本机会话这才建立。
  receiver.setSession({
    manifest,
    sessionId: 'session-1',
    isSeeder: false,
    state: { bitfield: packBitfield(new Uint8Array(4)), haveCount: 0, contiguousBytes: 0 },
  });

  assert.ok(host.remoteHave, '打开本机会话不能清掉对方的位图');
  assert.equal(host.ready, true);

  const plan = receiver.scheduler.plan({
    have: receiver.have,
    playbackByte: 0,
    inflight: new Set(),
    peers: [host],
  });
  assert.ok(plan.length > 0, '调度器必须能把分片分配给房主');
  assert.equal(plan[0].peerId, 'host');
});

test('对方手里换成另一个文件时，旧位图会被判定失效', async () => {
  const { Swarm } = await import('../src/renderer/lib/swarm.js');
  const { packBitfield } = await import('../src/renderer/lib/protocol.js');

  const oldManifest = manifestFor('a'.repeat(32), 4);
  const newManifest = manifestFor('b'.repeat(32), 6);
  const receiver = new Swarm({ peerId: 'guest', name: 'guest' });
  const host = fakePeer('host');
  receiver.peers.set(host.peerId, host);

  receiver._onCtrl(host, { t: 'manifest', manifest: oldManifest });
  receiver._onCtrl(host, { t: 'bitfield', bits: packBitfield(Uint8Array.from([1, 1, 1, 1])) });

  receiver.setSession({
    manifest: newManifest,
    sessionId: 'session-2',
    isSeeder: false,
    state: { bitfield: packBitfield(new Uint8Array(6)), haveCount: 0, contiguousBytes: 0 },
  });

  assert.equal(host.remoteHave, null, '不同文件的位图长度对不上，必须丢弃');
  assert.equal(host.remoteManifest, null);
});

/** 位图属于发送方的文件，尺寸只能按他的清单算。 */
test('本机正播另一个文件时，位图仍按对方的清单解码', async () => {
  const { Swarm } = await import('../src/renderer/lib/swarm.js');
  const { packBitfield } = await import('../src/renderer/lib/protocol.js');

  const mine = manifestFor('c'.repeat(32), 3);
  const theirs = manifestFor('d'.repeat(32), 9);
  const swarm = new Swarm({ peerId: 'me', name: 'me' });
  const other = fakePeer('other');
  swarm.peers.set(other.peerId, other);
  swarm.setSession({ manifest: mine, sessionId: 'session-3', isSeeder: true });

  swarm._onCtrl(other, { t: 'manifest', manifest: theirs });
  swarm._onCtrl(other, { t: 'bitfield', bits: packBitfield(Uint8Array.from([1, 1, 1, 1, 1, 1, 1, 1, 1])) });

  assert.equal(other.remoteHave.length, 9);
});
