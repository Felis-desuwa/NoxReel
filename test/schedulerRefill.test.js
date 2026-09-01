'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { IMPLS } = require('./helpers/impls');

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

function manifestOf(chunkCount) {
  return {
    fileId: 'a'.repeat(32),
    name: 'film.mp4',
    size: chunkCount * 2 * 1024 ** 2,
    chunkSize: 2 * 1024 ** 2,
    chunkCount,
    hashes: Array.from({ length: chunkCount }, (_, i) => i.toString(16).padStart(64, '0')),
    durationSec: 600,
  };
}

/** 一个只记账不干活的 peer：手里有全部分片，发出去的控制消息都留档。 */
function servingPeer(peerId, chunkCount) {
  return {
    peerId,
    name: peerId,
    pc: { iceConnectionState: 'connected' },
    ctrl: { readyState: 'open' },
    authenticated: true,
    ready: true,
    remoteManifest: null,
    remoteHave: new Uint8Array(chunkCount).fill(1),
    inflight: new Set(),
    downRate: 0,
    closed: false,
    sent: [],
    on() { return () => {}; },
    send(msg) { this.sent.push(msg); return true; },
    close() { this.closed = true; },
  };
}

/**
 * 这一条防的是一个会把吞吐硬卡在 8 MB/s 的回归。
 *
 * 补片原本只由 250ms 的 setInterval 驱动，而 Chromium 会把不可见窗口的定时器
 * 节流到 1 秒一次 —— 看片的时候 mpv 在前台，NoxReel 窗口恰好就是不可见的。
 * 于是每秒最多补 MAX_INFLIGHT_PER_PEER 片 = 4 × 2MB = 8 MB/s，网络再快也没用。
 * 实测（同机回环、285.8 MB）：只靠定时器 39 秒，改成落地即补 15 秒。
 *
 * 所以这里刻意不启动任何定时器：一片写完就必须立刻发出下一个 REQUEST。
 */
impl('分片落地立刻补请求，不依赖会被节流的定时器', async (dir) => {
  const { Swarm } = await import(dir + 'swarm.js');
  const chunkCount = 64;
  const swarm = new Swarm({ peerId: 'me', name: 'me' });

  const original = globalThis.window;
  globalThis.window = {
    sw: {
      store: {
        writeChunk: async () => ({ ok: true, duplicate: false, haveCount: 1, contiguousBytes: 2 * 1024 ** 2, complete: false }),
      },
    },
  };

  try {
    swarm.setSession({ manifest: manifestOf(chunkCount), sessionId: 's1', isSeeder: false });
    const peer = servingPeer('host', chunkCount);
    swarm.addPeer(peer);

    // 注意：全程没有 swarm.start()，也就没有任何定时器在跑。
    assert.ok(!swarm._timer, '本用例必须在没有定时器的前提下成立');
    peer.sent.length = 0;

    swarm.inflight.set(0, { peerId: 'host', at: 0 });
    peer.inflight.add(0);
    await swarm._commitChunk(peer, 0, new Uint8Array(2 * 1024 ** 2));

    const requests = peer.sent.filter((m) => m.t === 'request');
    assert.ok(requests.length > 0, '一片落地后必须立刻补发 REQUEST，而不是干等下一个 tick');
    assert.ok(
      requests.every((m) => Number.isInteger(m.index) && m.index > 0),
      '补的应当是还没拿到的分片'
    );
  } finally {
    if (original === undefined) delete globalThis.window;
    else globalThis.window = original;
  }
});

impl('校验失败的分片同样立刻补位，不让名额空着', async (dir) => {
  const { Swarm } = await import(dir + 'swarm.js');
  const chunkCount = 64;
  const swarm = new Swarm({ peerId: 'me', name: 'me' });

  const original = globalThis.window;
  globalThis.window = { sw: { store: { writeChunk: async () => ({ ok: false, reason: 'hash-mismatch' }) } } };

  try {
    swarm.setSession({ manifest: manifestOf(chunkCount), sessionId: 's1', isSeeder: false });
    const peer = servingPeer('host', chunkCount);
    swarm.addPeer(peer);
    peer.sent.length = 0;

    swarm.inflight.set(0, { peerId: 'host', at: 0 });
    peer.inflight.add(0);
    await swarm._commitChunk(peer, 0, new Uint8Array(2 * 1024 ** 2));

    assert.ok(
      peer.sent.some((m) => m.t === 'request'),
      '坏片丢弃后名额就空出来了，得马上用掉'
    );
  } finally {
    if (original === undefined) delete globalThis.window;
    else globalThis.window = original;
  }
});

test('两端的补片逻辑都挂在分片落地上，且都留了原因说明', () => {
  for (const { name, dir } of IMPLS) {
    const code = fs.readFileSync(path.resolve(__dirname, dir + 'swarm.js'), 'utf8');
    assert.match(code, /\}\s*finally\s*\{[\s\S]*?this\._tick\(\);/, `${name} 的 _commitChunk 必须在 finally 里补片`);
    assert.match(code, /节流/, `${name} 该说明为什么不能只靠定时器`);
  }
});
