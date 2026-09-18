'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { IMPLS } = require('./helpers/impls');

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

const MB2 = 2 * 1024 ** 2;
const SLOT = 2;

function manifestOf(chunkCount, fileId = 'a'.repeat(32)) {
  return {
    fileId,
    name: 'film.mp4',
    size: chunkCount * MB2,
    chunkSize: MB2,
    chunkCount,
    hashes: Array.from({ length: chunkCount }, (_, i) => i.toString(16).padStart(64, '0')),
    durationSec: 600,
  };
}

/** 一个只记账不干活的 peer：给定槽位的片全都有，发出去的控制消息都留档。 */
function servingPeer(peerId, slots) {
  return {
    peerId,
    name: peerId,
    pc: { iceConnectionState: 'connected' },
    ctrl: { readyState: 'open' },
    authenticated: true,
    ready: true,
    remote: new Map(
      Object.entries(slots).map(([slot, count]) => [Number(slot), { have: new Uint8Array(count).fill(1), full: true }])
    ),
    inflight: new Set(),
    downRate: 0,
    closed: false,
    sent: [],
    on() { return () => {}; },
    send(msg) { this.sent.push(msg); return true; },
    close() { this.closed = true; },
  };
}

/** 换上一个假的 window.sw.store，跑完还原，别影响同进程里的其他用例。 */
async function withStore(store, fn) {
  const original = globalThis.window;
  globalThis.window = { sw: { store } };
  try {
    return await fn();
  } finally {
    if (original === undefined) delete globalThis.window;
    else globalThis.window = original;
  }
}

/**
 * 模拟「第 0 片已经派给这个上游」：在途记录按 v2 的键「槽位:下标」登记，
 * 两边（全局 inflight 和 peer.inflight）都要有，和 _tick 派片时一致。
 */
function markInflight(swarm, peer, slot, index) {
  const key = `${slot}:${index}`;
  swarm.inflight.set(key, { peerId: peer.peerId, at: performance.now(), slot, index });
  peer.inflight.add(key);
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

  await withStore(
    {
      writeChunk: async () => ({ ok: true, duplicate: false, haveCount: 1, contiguousBytes: MB2, complete: false }),
    },
    async () => {
      const ctx = swarm.addFile({ slot: SLOT, manifest: manifestOf(chunkCount), sessionId: 's1', isSeeder: false });
      swarm.setActive(SLOT);
      const peer = servingPeer('host', { [SLOT]: chunkCount });
      swarm.addPeer(peer);

      // 注意：全程没有 swarm.start()，也就没有任何定时器在跑。
      assert.ok(!swarm._timer, '本用例必须在没有定时器的前提下成立');
      peer.sent.length = 0;

      markInflight(swarm, peer, SLOT, 0);
      await swarm._commitChunk(peer, ctx, 0, new Uint8Array(MB2));

      const requests = peer.sent.filter((m) => m.t === 'request');
      assert.ok(requests.length > 0, '一片落地后必须立刻补发 REQUEST，而不是干等下一个 tick');
      assert.ok(
        requests.every((m) => m.s === SLOT && Number.isInteger(m.index) && m.index > 0),
        '补的应当是这部片里还没拿到的分片'
      );
    }
  );
});

impl('校验失败的分片同样立刻补位，不让名额空着', async (dir) => {
  const { Swarm } = await import(dir + 'swarm.js');
  const chunkCount = 64;
  const swarm = new Swarm({ peerId: 'me', name: 'me' });

  await withStore({ writeChunk: async () => ({ ok: false, reason: 'hash-mismatch' }) }, async () => {
    const ctx = swarm.addFile({ slot: SLOT, manifest: manifestOf(chunkCount), sessionId: 's1', isSeeder: false });
    swarm.setActive(SLOT);
    const peer = servingPeer('host', { [SLOT]: chunkCount });
    swarm.addPeer(peer);
    peer.sent.length = 0;

    const bad = [];
    swarm.on('chunk-bad', (e) => bad.push(e));
    const realWarn = console.warn;
    console.warn = () => {}; // 坏片是故意造的，别污染测试输出
    try {
      markInflight(swarm, peer, SLOT, 0);
      await swarm._commitChunk(peer, ctx, 0, new Uint8Array(MB2));
    } finally {
      console.warn = realWarn;
    }

    assert.deepEqual(bad, [{ slot: SLOT, index: 0, from: 'host', reason: 'hash-mismatch' }]);
    assert.equal(ctx.have[0], 0);
    const requests = peer.sent.filter((m) => m.t === 'request');
    assert.ok(requests.length > 0, '坏片丢弃后名额就空出来了，得马上用掉');
    assert.ok(
      requests.some((m) => m.s === SLOT && m.index === 0),
      '坏掉的那片本身也要立刻重新要，它就排在最前面'
    );
  });
});

/**
 * 多槽位下补片只补「活动槽位」。落地的那片可能属于刚被换下去的旧槽位
 * （换 active 时它已经收齐、正在落盘）—— 这时补的必须是新的活动槽位，
 * 不能因为「刚落地的是旧槽位」就又去向别人要旧槽位的片，那等于没换。
 */
impl('非活动槽位的片落地后，补的是活动槽位的片', async (dir) => {
  const { Swarm } = await import(dir + 'swarm.js');
  const chunkCount = 16;
  const swarm = new Swarm({ peerId: 'me', name: 'me' });

  let releaseWrite;
  await withStore(
    {
      writeChunk: () =>
        new Promise((resolve) => {
          releaseWrite = () =>
            resolve({ ok: true, duplicate: false, haveCount: 1, contiguousBytes: MB2, complete: false });
        }),
    },
    async () => {
      const oldCtx = swarm.addFile({ slot: SLOT, manifest: manifestOf(chunkCount), sessionId: 's1', isSeeder: false });
      swarm.addFile({
        slot: SLOT + 1,
        manifest: manifestOf(chunkCount, 'b'.repeat(32)),
        sessionId: 's2',
        isSeeder: false,
      });
      const peer = servingPeer('host', { [SLOT]: chunkCount, [SLOT + 1]: chunkCount });
      swarm.addPeer(peer);
      swarm.setActive(SLOT);
      const first = peer.sent.find((m) => m.t === 'request');
      assert.equal(first.s, SLOT);

      // 旧槽位的第一片收齐、正在落盘，这时上层把活动槽位换成下一部
      const commit = swarm._commitChunk(peer, oldCtx, first.index, new Uint8Array(MB2));
      swarm.setActive(SLOT + 1);
      assert.ok(
        [...swarm.inflight.values()].every((info) => info.slot === SLOT + 1),
        '换活动槽位后，在途请求只能属于新槽位'
      );

      // 旧片从在途摘下时腾出的名额，已经在换槽位那一轮被新槽位用掉了。
      // 让新槽位的一片被对方以「忙」拒掉，再空出一格，看落地那一轮拿它去要谁。
      const busyOne = [...swarm.inflight.values()][0];
      swarm._onCtrl(peer, { t: 'deny', s: busyOne.slot, index: busyOne.index, busy: true });

      peer.sent.length = 0;
      releaseWrite();
      await commit;

      assert.equal(oldCtx.have[first.index], 1, '旧槽位会话还在，收齐的片照常入账');
      const requests = peer.sent.filter((m) => m.t === 'request');
      assert.ok(requests.length > 0, '旧片落地腾出的名额要立刻补上');
      assert.ok(
        requests.every((m) => m.s === SLOT + 1),
        `补片必须只针对活动槽位（实际要了 ${requests.map((m) => `${m.s}:${m.index}`).join(',')}）`
      );
    }
  );
});

impl('没有活动槽位（或活动槽位已收齐）时，落地不会凭空发请求', async (dir) => {
  const { Swarm } = await import(dir + 'swarm.js');
  const chunkCount = 8;
  const swarm = new Swarm({ peerId: 'me', name: 'me' });

  await withStore(
    {
      writeChunk: async () => ({ ok: true, duplicate: false, haveCount: 1, contiguousBytes: MB2, complete: false }),
    },
    async () => {
      const ctx = swarm.addFile({ slot: SLOT, manifest: manifestOf(chunkCount), sessionId: 's1', isSeeder: false });
      const peer = servingPeer('host', { [SLOT]: chunkCount });
      swarm.addPeer(peer);
      assert.equal(swarm.activeSlot, null);
      peer.sent.length = 0;

      await swarm._commitChunk(peer, ctx, 0, new Uint8Array(MB2));
      assert.ok(!peer.sent.some((m) => m.t === 'request'), '上层还没指定要哪部，不能自作主张');
      assert.ok(peer.sent.some((m) => m.t === 'have' && m.s === SLOT && m.index === 0));
    }
  );
});

test('两端的补片逻辑都挂在分片落地上，且都留了原因说明', () => {
  for (const { name, dir } of IMPLS) {
    const code = fs.readFileSync(path.resolve(__dirname, dir + 'swarm.js'), 'utf8');
    const start = code.indexOf('async _commitChunk(');
    assert.ok(start > 0, `${name} 找不到 _commitChunk`);
    const body = code.slice(start, code.indexOf('\n  }\n', start));
    assert.match(body, /\}\s*finally\s*\{[\s\S]*?this\._tick\(\);/, `${name} 的 _commitChunk 必须在 finally 里补片`);
    assert.match(body, /节流/, `${name} 该说明为什么不能只靠定时器`);
  }
});
