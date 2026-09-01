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
  const peer = { peerId: 'host', pendingManifest: null, authenticated: true };
  const received = new Promise((resolve) => receiver.once('manifest-offer', resolve));
  for (const msg of messages) receiver._onCtrl(peer, msg);
  const offer = await received;
  assert.equal(offer.manifest.hashes.length, 5120);
  assert.equal(offer.manifest.hashes[5119], manifest.hashes[5119]);
  assert.equal(offer.manifest.roomRevision, 3);
});

test('时长随清单一起送达接收方，分片传输也不会把它丢掉', async () => {
  const { Swarm } = await import('../src/renderer/lib/swarm.js');

  // 大清单会被拆成 MANIFEST_START + 多条 MANIFEST_PART。时长挂在 meta 上，
  // 得确认拆分和重组之后它还在 —— 接收方要靠它在起播前算出所需码率。
  const manifest = {
    fileId: 'e'.repeat(32),
    name: 'long-film.mkv',
    size: 4 * 1024 ** 3,
    chunkSize: 2 * 1024 ** 2,
    chunkCount: 2048,
    hashes: Array.from({ length: 2048 }, (_, i) => i.toString(16).padStart(64, '0')),
    roomRevision: 1,
    durationSec: 8523.209,
  };

  const sender = new Swarm({ peerId: 'host', name: 'host' });
  const messages = [];
  sender._sendManifest({ send: (msg) => messages.push(msg) }, manifest);
  assert.ok(messages.length > 2, '这份清单应该被拆成多条消息');

  const receiver = new Swarm({ peerId: 'guest', name: 'guest' });
  const peer = { peerId: 'host', pendingManifest: null, authenticated: true };
  const received = new Promise((resolve) => receiver.once('manifest-offer', resolve));
  for (const msg of messages) receiver._onCtrl(peer, msg);
  const offer = await received;
  assert.equal(offer.manifest.durationSec, 8523.209);
});

test('调度器起播前用清单里的时长算所需码率，起播后让 mpv 的真值覆盖', async () => {
  const { Scheduler } = await import('../src/renderer/lib/scheduler.js');

  const manifest = { size: 2_400_000_000, chunkSize: 2 * 1024 ** 2, chunkCount: 1145, durationSec: 8523.209 };
  const scheduler = new Scheduler({ manifest });
  // 2.4GB / 8523s ≈ 281 KB/s —— 接收方还没起播就能拿到这个数
  assert.ok(Math.abs(scheduler.bytesPerSecond - 2_400_000_000 / 8523.209) < 1);

  scheduler.setDuration(8000);
  assert.ok(Math.abs(scheduler.bytesPerSecond - 2_400_000_000 / 8000) < 1, 'mpv 报上来的真时长应当覆盖清单值');

  // 老版本房主不带时长，退化成 0，界面据此不显示这条诊断而不是显示一个假数字
  assert.equal(new Scheduler({ manifest: { ...manifest, durationSec: undefined } }).bytesPerSecond, 0);
});

test('清单校验放行合法时长，挡住畸形值', () => {
  const validate = require('../src/main/security');
  const base = {
    fileId: 'a'.repeat(32),
    name: 'film.mkv',
    size: 2 * 1024 ** 2,
    chunkSize: 2 * 1024 ** 2,
    chunkCount: 1,
    hashes: ['b'.repeat(64)],
  };
  assert.equal(validate.manifest({ ...base }).durationSec, undefined);
  assert.equal(validate.manifest({ ...base, durationSec: 8523.209 }).durationSec, 8523.209);
  for (const bad of [-1, '8523', NaN, Infinity, 86_401, null]) {
    assert.throws(() => validate.manifest({ ...base, durationSec: bad }), `应当拒绝 ${String(bad)}`);
  }
});
