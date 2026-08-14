'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('10GB 清单拆分后每条控制消息低于 64KB 并可完整重组', async () => {
  const { Swarm } = await import('../src/renderer/lib/swarm.js');
  const manifest = {
    fileId: 'f'.repeat(32),
    name: 'ten-gigabyte.mkv',
    size: 10 * 1024 ** 3,
    chunkSize: 2 * 1024 ** 2,
    chunkCount: 5120,
    hashes: Array.from({ length: 5120 }, (_, i) => i.toString(16).padStart(64, '0')),
    roomRevision: 3,
  };

  const sender = new Swarm({ peerId: 'host', name: 'host' });
  const messages = [];
  sender._sendManifest({ send: (msg) => messages.push(msg) }, manifest);
  assert.ok(messages.length > 2);
  assert.ok(messages.every((msg) => Buffer.byteLength(JSON.stringify(msg)) < 64 * 1024));

  const receiver = new Swarm({ peerId: 'guest', name: 'guest' });
  const peer = { peerId: 'host', pendingManifest: null };
  const received = new Promise((resolve) => receiver.once('manifest-offer', resolve));
  for (const msg of messages) receiver._onCtrl(peer, msg);
  const offer = await received;
  assert.equal(offer.manifest.hashes.length, 5120);
  assert.equal(offer.manifest.hashes[5119], manifest.hashes[5119]);
  assert.equal(offer.manifest.roomRevision, 3);
});
