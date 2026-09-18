'use strict';

/**
 * 「分片正在落盘时不能被重复请求」。
 *
 * 这是一个窗口极窄、但代价极大的竞态：_commitChunk 先把分片从 inflight 摘掉，
 * 再 await 一整个写盘往返（2MB 过 IPC + SHA-256 + 落盘）。这中间它既不在 inflight、
 * have 也还是 0，调度器只能判定它还缺，于是再要一遍。
 *
 * 而 v0.6.5 起「一片落地就立刻补片」，等于把这个窗口撞得更频繁。实测一个
 * 25.9 MB 的文件，发送端总共发出 59.8 MB —— 多出来的那份最后被 fileStore
 * 认出是重复丢掉了，带宽却已经花掉。
 *
 * v2（0.7）起每个槽位各有一份「正在落盘」记录（ctx.writing），在途记录的键是 "槽位:下标"。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { IMPLS } = require('./helpers/impls');

const CHUNK = 2 * 1024 * 1024;
const CHUNKS = 8;
const SLOT = 3;

const manifest = {
  fileId: 'f'.repeat(32),
  name: 'a.mkv',
  size: CHUNKS * CHUNK,
  chunkSize: CHUNK,
  chunkCount: CHUNKS,
  hashes: Array.from({ length: CHUNKS }, (_, i) => String(i).padStart(64, '0')),
  durationSec: 600,
};

const keyOf = (slot, index) => `${slot}:${index}`;
const nextTurn = () => new Promise((r) => setImmediate(r));

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

function upstream(peerId, requested) {
  const peer = {
    peerId,
    name: peerId,
    pc: { iceConnectionState: 'connected' },
    ready: true,
    authenticated: true,
    remote: new Map([[SLOT, { have: new Uint8Array(CHUNKS).fill(1), full: true }]]),
    inflight: new Set(),
    downRate: 10e6,
    rtt: 10,
    ctrl: { readyState: 'open' },
    sent: [],
    on: () => () => {},
    close() {},
    send(msg) {
      peer.sent.push(msg);
      if (requested && msg.t === 'request') requested.push(msg.index);
      return true;
    },
  };
  return peer;
}

/**
 * 装一个可控的 window.sw：writeChunk 挂着不返回，模拟「正在落盘」。
 * 一个总是有货、总是接单的上游；本机挂着槽位 SLOT 的接收会话并设为活动槽位。
 */
async function makeSwarm(dir) {
  const pending = new Map();
  const requested = [];

  globalThis.window = {
    sw: {
      store: {
        writeChunk: (sessionId, index) =>
          new Promise((resolve, reject) => {
            pending.set(index, {
              ok: () => resolve({ ok: true, duplicate: false, haveCount: 1, contiguousBytes: CHUNK, complete: false }),
              fail: (e) => reject(e),
            });
          }),
      },
    },
  };

  const { Swarm } = await import(dir + 'swarm.js');
  const swarm = new Swarm({ peerId: 'me', name: 'me' });
  const ctx = swarm.addFile({ slot: SLOT, manifest, sessionId: 's1', isSeeder: false });
  swarm.setActive(SLOT);

  const peer = upstream('up', requested);
  swarm.addPeer(peer);

  return {
    swarm,
    ctx,
    peer,
    requested,
    release: (i) => pending.get(i)?.ok(),
    fail: (i, e) => pending.get(i)?.fail(e),
  };
}

/* ------------------- 正在落盘的片不重复请求 ------------------- */

impl('正在落盘的分片不会被再要一遍', async (dir) => {
  const { swarm, ctx, peer, requested, release } = await makeSwarm(dir);

  swarm._tick();
  const first = requested.slice();
  assert.ok(first.length > 0, '第一轮应该派出请求');
  assert.ok(peer.sent.filter((m) => m.t === 'request').every((m) => m.s === SLOT), 'REQUEST 必须带槽位');
  const target = first[0];

  // 这一片收齐了，_commitChunk 会把它从 inflight 摘掉，然后卡在写盘上
  const commit = swarm._commitChunk(peer, ctx, target, new Uint8Array(CHUNK));
  await nextTurn();
  assert.ok(!swarm.inflight.has(keyOf(SLOT, target)));
  assert.ok(ctx.writing.has(target), '收齐后应当登记为「正在落盘」');

  // 写盘还没回来。这时候再调度一轮 —— 老代码会在这里把同一片再要一次。
  requested.length = 0;
  swarm._tick();
  assert.ok(
    !requested.includes(target),
    `分片 ${target} 还在落盘就被重复请求了（这一轮要了 ${requested.join(',')}）`
  );

  release(target);
  await commit;
  assert.equal(ctx.writing.size, 0);
});

impl('落盘完成后这片进 have，也不会再被要', async (dir) => {
  const { swarm, ctx, peer, requested, release } = await makeSwarm(dir);
  swarm._tick();
  const target = requested[0];

  const commit = swarm._commitChunk(peer, ctx, target, new Uint8Array(CHUNK));
  await nextTurn();
  release(target);
  await commit;

  assert.equal(ctx.have[target], 1);
  assert.ok(
    peer.sent.some((m) => m.t === 'have' && m.s === SLOT && m.index === target),
    '落盘后要向大家广播 HAVE，而且带槽位'
  );
  requested.length = 0;
  swarm._tick();
  assert.ok(!requested.includes(target));
});

impl('落盘期间其余分片照常调度，不是把整轮堵住', async (dir) => {
  const { swarm, ctx, peer, requested, release } = await makeSwarm(dir);
  swarm._tick();
  const target = requested[0];

  const commit = swarm._commitChunk(peer, ctx, target, new Uint8Array(CHUNK));
  await nextTurn();

  requested.length = 0;
  swarm._tick();
  assert.ok(requested.length > 0, '腾出来的名额应该拿去要别的片，而不是空转');
  assert.ok(requested.every((i) => i !== target));

  release(target);
  await commit;
});

impl('写盘失败的片会被放回去重新要', async (dir) => {
  const { swarm, ctx, peer, requested } = await makeSwarm(dir);
  swarm._tick();
  const target = requested[0];
  const firstRound = requested.length;

  // 让这次写盘直接抛错
  window.sw.store.writeChunk = () => Promise.reject(new Error('磁盘满了'));
  const errors = [];
  swarm.on('error', (e) => errors.push(e));
  const realError = console.error;
  console.error = () => {}; // 这条错误是故意造的，别污染测试输出
  try {
    await swarm._commitChunk(peer, ctx, target, new Uint8Array(CHUNK));
  } finally {
    console.error = realError;
  }
  assert.equal(errors.length, 1, '会话还在时写盘失败要报出来');
  assert.equal(ctx.writing.has(target), false, '失败的片不能一直挂在「正在落盘」里');
  // _commitChunk 的 finally 里本来就会补一轮，重新排队应该在那一轮就发生了
  swarm._tick();

  assert.ok(
    requested.slice(firstRound).includes(target),
    `落盘失败的片必须能重新排队，否则永远缺一块（后续要了 ${requested.slice(firstRound).join(',')}）`
  );
});

/* ------------------- 摘片 / 换会话 ------------------- */

/**
 * 单槽时代叫「换会话时把正在落盘的记录一并清掉」。v2 里对应两件事：
 *  - removeFile 清掉这个槽位的 writing（以及在途请求），残留会让同槽位新会话里
 *    同下标的分片永远不被请求；
 *  - 写盘 await 回来时这个槽位已经换了上下文（files.get(slot) !== ctx），结果作废 ——
 *    否则旧会话里落的片会被记进新会话的 have，还对外宣称「我有」，新会话里那片其实是空洞。
 */
impl('摘掉这部片时清掉「正在落盘」的记录，迟到的写盘结果作废', async (dir) => {
  const { swarm, ctx, peer, requested, release } = await makeSwarm(dir);
  swarm._tick();
  const target = requested[0];

  const commit = swarm._commitChunk(peer, ctx, target, new Uint8Array(CHUNK));
  await nextTurn();
  assert.equal(ctx.writing.size, 1);

  peer.sent.length = 0;
  swarm.removeFile(SLOT);
  assert.equal(ctx.writing.size, 0, '残留会让新会话里同下标的分片永远不被请求');
  assert.equal(swarm.files.has(SLOT), false);
  assert.equal(swarm.activeSlot, null, '摘掉的槽位不能还是活动槽位');
  assert.equal(swarm.inflight.size, 0, '这部片的在途请求要一并撤回');
  assert.equal(peer.inflight.size, 0);
  assert.ok(
    peer.sent.some((m) => m.t === 'cancel' && m.s === SLOT),
    '撤回的请求要通知上游别再发了'
  );

  // 同一个槽位挂上新会话，重新开始要片
  const fresh = swarm.addFile({ slot: SLOT, manifest, sessionId: 's2', isSeeder: false });
  swarm.setActive(SLOT);
  assert.ok(
    peer.sent.some((m) => m.t === 'request' && m.s === SLOT && m.index === target),
    '新会话里同下标的分片必须能被重新请求'
  );

  const events = [];
  swarm.on('progress', (p) => events.push(['progress', p]));
  swarm.on('complete', (p) => events.push(['complete', p]));
  peer.sent.length = 0;

  release(target);
  await commit;

  assert.equal(fresh.have[target], 0, '旧会话的写盘结果不能记进新会话');
  assert.equal(fresh.haveCount, 0);
  assert.equal(ctx.have[target], 0, '已经摘掉的旧上下文也不该再被更新');
  assert.ok(!peer.sent.some((m) => m.t === 'have'), '作废的片不能对外宣称已有');
  assert.deepEqual(events, []);
});

impl('同一槽位直接换会话（addFile 覆盖）同样清掉旧的落盘记录', async (dir) => {
  const { swarm, ctx, peer, requested, release } = await makeSwarm(dir);
  swarm._tick();
  const target = requested[0];

  const commit = swarm._commitChunk(peer, ctx, target, new Uint8Array(CHUNK));
  await nextTurn();

  const fresh = swarm.addFile({ slot: SLOT, manifest, sessionId: 's2', isSeeder: false });
  assert.notEqual(fresh, ctx, '会话不同必须换一份新上下文');
  assert.equal(ctx.writing.size, 0);
  assert.equal(fresh.writing.size, 0);

  release(target);
  await commit;
  assert.equal(fresh.have[target], 0);
});

impl('摘片之后写盘才失败，不当成错误上报', async (dir) => {
  const { swarm, ctx, peer, requested, fail } = await makeSwarm(dir);
  swarm._tick();
  const target = requested[0];

  const errors = [];
  swarm.on('error', (e) => errors.push(e));
  const commit = swarm._commitChunk(peer, ctx, target, new Uint8Array(CHUNK));
  await nextTurn();

  swarm.removeFile(SLOT);
  // 会话已由上层关掉，这时写盘报错是意料之中
  fail(target, new Error('会话已关闭'));
  await commit;
  assert.deepEqual(errors, []);
});

/**
 * 换活动槽位（先传列表里的下一部）只撤回旧槽位的在途请求；已经收齐、正在落盘的片
 * 照常入账 —— 会话还在，回头接着传这部的时候这片就不用再要。
 */
impl('换活动槽位时旧槽位正在落盘的片照常入账', async (dir) => {
  const { swarm, ctx, peer, requested, release } = await makeSwarm(dir);
  swarm._tick();
  const target = requested[0];

  const commit = swarm._commitChunk(peer, ctx, target, new Uint8Array(CHUNK));
  await nextTurn();

  const other = { ...manifest, fileId: 'e'.repeat(32) };
  swarm.addFile({ slot: SLOT + 1, manifest: other, sessionId: 's-next', isSeeder: false });
  peer.sent.length = 0;
  swarm.setActive(SLOT + 1);

  const cancelled = peer.sent.filter((m) => m.t === 'cancel').map((m) => m.s);
  assert.ok(cancelled.length > 0 && cancelled.every((s) => s === SLOT), '只撤回旧槽位的请求');
  assert.ok(![...swarm.inflight.values()].some((info) => info.slot === SLOT));

  release(target);
  await commit;
  assert.equal(ctx.have[target], 1, '会话没关，收齐的片不能白丢');
  assert.equal(swarm.files.get(SLOT), ctx);
});

// 两份 swarm.js 由 sharedLibParity 保证一致，这里只钉住这道守卫本身。
test('两端都有「正在落盘」这道守卫', () => {
  for (const { name, dir } of IMPLS) {
    const src = fs.readFileSync(path.resolve(__dirname, dir + 'swarm.js'), 'utf8');
    assert.match(src, /ctx\.writing\.add\(index\)/, `${name} 少了入队`);
    assert.match(src, /ctx\.writing\.delete\(index\)/, `${name} 少了出队`);
    assert.match(src, /const busy = new Set\(ctx\.writing\)/, `${name} 的调度没把正在落盘的片算进去`);
    assert.match(src, /inflight: busy/, `${name} 的调度没把「在途 + 落盘」交给调度器`);
    assert.match(src, /ctx\.writing\.clear\(\)/, `${name} 摘片时没清落盘记录`);
    assert.match(src, /this\.files\.get\(slot\) !== ctx\) return/, `${name} 写盘回来后没检查上下文是否已换`);
  }
});

/* ------------------- 在途名额必须按登记的请求者销账 ------------------- */

impl('分片由「非派发方」送达时，派发方的在途名额也要销掉', async (dir) => {
  const { swarm, ctx, peer, requested, release } = await makeSwarm(dir);
  swarm._tick();
  const target = requested[0];
  const key = keyOf(SLOT, target);

  // 模拟「超时改派」：这片现在登记在 B 名下，而帧却是 A 送来的
  const other = upstream('other');
  other.downRate = 5e6;
  swarm.addPeer(other);
  other.inflight.add(key);
  swarm.inflight.set(key, { peerId: 'other', at: performance.now(), slot: SLOT, index: target });

  const commit = swarm._commitChunk(peer, ctx, target, new Uint8Array(CHUNK));
  await nextTurn();
  release(target);
  await commit;

  assert.ok(
    !other.inflight.has(key),
    `登记方的在途名额没被销掉，剩下 ${[...other.inflight].join(',')} —— 攒够窗口数这个上游就再也不会被派片`
  );
});

impl('正常情况下（送达方就是派发方）行为不变', async (dir) => {
  const { swarm, ctx, peer, requested, release } = await makeSwarm(dir);
  swarm._tick();
  const target = requested[0];
  const key = keyOf(SLOT, target);
  assert.ok(peer.inflight.has(key), '在途记录的键是「槽位:下标」');

  const commit = swarm._commitChunk(peer, ctx, target, new Uint8Array(CHUNK));
  await nextTurn();
  release(target);
  await commit;

  assert.ok(!peer.inflight.has(key));
});

/**
 * 同一个下标在不同槽位是两片不同的数据。销账只能销「这个槽位的这一片」，
 * 否则第二部的同号请求被误删，那一片就再也没人要、也没人超时回收。
 */
impl('销账只动本槽位的在途记录，别的槽位同下标的请求不受影响', async (dir) => {
  const { swarm, ctx, peer, requested, release } = await makeSwarm(dir);
  swarm._tick();
  const target = requested[0];
  const foreign = keyOf(SLOT + 1, target);
  swarm.inflight.set(foreign, { peerId: 'up', at: performance.now(), slot: SLOT + 1, index: target });
  peer.inflight.add(foreign);

  const commit = swarm._commitChunk(peer, ctx, target, new Uint8Array(CHUNK));
  await nextTurn();
  release(target);
  await commit;

  assert.ok(swarm.inflight.has(foreign));
  assert.ok(peer.inflight.has(foreign));
});

/* ------------------- 对端不再有这部片 ------------------- */

/**
 * 单槽时代是「对端换了片，就别再拿他的旧位图向他要」。v2 里槽位和 fileId 一一对应，
 * 对方「换片」表现为他把这部删了：他会对我们的请求回 DENY gone。
 * 收到后必须把他在这个槽位的位图整张删掉、撤回他名下这部片的全部在途 ——
 * 再向他要只会一直被拒，白占在途名额。
 */
impl('对端回 DENY gone 之后，不再拿他的旧位图向他要片', async (dir) => {
  const { swarm, peer, requested } = await makeSwarm(dir);
  swarm._tick();
  assert.ok(swarm.inflight.size > 0, '他有片时该正常派片');

  swarm._onCtrl(peer, { t: 'deny', s: SLOT, index: requested[0], gone: true });

  assert.equal(peer.remote.has(SLOT), false, '整部都没了，位图要删掉');
  assert.equal(swarm.inflight.size, 0, 'gone 撤回的是他名下这部片的全部在途，不只是被拒的那一片');
  assert.equal(peer.inflight.size, 0);
  assert.deepEqual(swarm.sourcesFor(SLOT), []);

  requested.length = 0;
  swarm._tick();
  assert.deepEqual(requested, [], '对方手里已经没有这部片，再向他要片只会白占在途名额');
});

impl('DENY gone 只撤回发送者自己的在途，别的上游照常', async (dir) => {
  const { swarm, peer, requested } = await makeSwarm(dir);
  const other = upstream('other');
  swarm.addPeer(other);
  swarm._tick();
  const owners = new Set([...swarm.inflight.values()].map((info) => info.peerId));
  assert.deepEqual([...owners].sort(), ['other', 'up'], '两个上游都应当分到片');

  swarm._onCtrl(peer, { t: 'deny', s: SLOT, index: requested[0], gone: true });

  assert.ok(swarm.inflight.size > 0);
  assert.ok([...swarm.inflight.values()].every((info) => info.peerId === 'other'));
  assert.ok(other.remote.has(SLOT));
  assert.deepEqual(swarm.sourcesFor(SLOT), ['other']);
});

/**
 * 普通 DENY 是「这一片我没有」：只抹掉这一位；busy 只是「现在排满了」，
 * 不能因此把这片从他的位图里抹掉，否则一次拥塞就永久少一个来源。
 */
impl('普通 DENY 只抹掉那一片，busy 不抹', async (dir) => {
  const { swarm, peer, requested } = await makeSwarm(dir);
  swarm._tick();
  const [a, b] = requested;

  swarm._onCtrl(peer, { t: 'deny', s: SLOT, index: a });
  swarm._onCtrl(peer, { t: 'deny', s: SLOT, index: b, busy: true });

  const remote = peer.remote.get(SLOT);
  assert.equal(remote.have[a], 0);
  assert.equal(remote.full, false);
  assert.equal(remote.have[b], 1, 'busy 不代表他没有');
  assert.ok(!swarm.inflight.has(keyOf(SLOT, a)));
  assert.ok(!swarm.inflight.has(keyOf(SLOT, b)));

  requested.length = 0;
  swarm._tick();
  assert.ok(!requested.includes(a), '他说没有的片不能再向他要');
  assert.ok(requested.includes(b), '只是忙的片，下一轮可以再要');
});
