'use strict';

/**
 * 自适应在途窗口与「谁最快送到」的派片规则。
 *
 * 这两件事都只在跨境／高延迟链路上才显形，局域网上完全看不出来 —— 所以必须
 * 有测试盯着「局域网行为一点没变」，否则很容易为了照顾远端把近端搞坏。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CHUNK = 2 * 1024 * 1024;
const load = () => import('../src/renderer/lib/scheduler.js');
const loadAndroid = () => import('../android/app/src/main/assets/js/scheduler.js');

const manifest = (chunkCount = 200) => ({
  size: chunkCount * CHUNK,
  chunkSize: CHUNK,
  chunkCount,
  durationSec: 3600,
});

const peer = (id, opts = {}) => ({
  peerId: id,
  ready: true,
  remoteHave: new Uint8Array(opts.chunkCount || 200).fill(1),
  inflight: new Set(opts.inflight || []),
  downRate: opts.downRate || 0,
  rtt: opts.rtt || 0,
});

/* --------------------------- 窗口大小本身 --------------------------- */

test('局域网（RTT 1ms）窗口保持 4 —— 老行为一点没变', async () => {
  const { inflightWindow, MAX_INFLIGHT_PER_PEER } = await load();
  assert.equal(inflightWindow({ rtt: 1, downRate: 50e6, chunkSize: CHUNK }), MAX_INFLIGHT_PER_PEER);
  assert.equal(inflightWindow({ rtt: 0.5, downRate: 200e6, chunkSize: CHUNK }), MAX_INFLIGHT_PER_PEER);
});

test('测不出 RTT 时退回固定窗口，不乱猜', async () => {
  const { inflightWindow, MAX_INFLIGHT_PER_PEER } = await load();
  assert.equal(inflightWindow({}), MAX_INFLIGHT_PER_PEER);
  assert.equal(inflightWindow({ rtt: 0, downRate: 99e6, chunkSize: CHUNK }), MAX_INFLIGHT_PER_PEER);
});

test('刚连上还没测出速率时，按 RTT 给一个起步深度', async () => {
  const { inflightWindow } = await load();
  // 跨境常见的 60~90ms：起步就该比局域网深，不然第一段传输白白慢在等窗口长起来
  assert.ok(inflightWindow({ rtt: 60, downRate: 0, chunkSize: CHUNK }) > 4);
  assert.ok(
    inflightWindow({ rtt: 150, downRate: 0, chunkSize: CHUNK }) >
      inflightWindow({ rtt: 60, downRate: 0, chunkSize: CHUNK }),
    '延迟越高起步越深'
  );
});

test('窗口有上限，不会为了吞吐把整条链路灌满', async () => {
  const { inflightWindow, MAX_INFLIGHT_CEILING } = await load();
  assert.equal(inflightWindow({ rtt: 2000, downRate: 1e9, chunkSize: CHUNK }), MAX_INFLIGHT_CEILING);
});

test('窗口会跟着实测速率往上长，不会自锁在低位', async () => {
  const { inflightWindow, MAX_INFLIGHT_PER_PEER } = await load();
  // 自锁的样子是：窗口小 → 速率低 → 按速率算出的窗口还是小。
  // 这里模拟一条 60ms / 400MB/s 的链路，看窗口能不能自己爬上去。
  const rtt = 60;
  const capacity = 400e6;
  let w = MAX_INFLIGHT_PER_PEER;
  const seen = [w];
  for (let i = 0; i < 10; i++) {
    const rate = (w * CHUNK) / (rtt / 1000 + CHUNK / capacity);
    w = inflightWindow({ rtt, downRate: rate, chunkSize: CHUNK });
    seen.push(w);
  }
  assert.ok(w > MAX_INFLIGHT_PER_PEER, `窗口卡在 ${w} 没长起来：${seen.join('→')}`);
});

test('建模：同一条 60ms 链路上，自适应窗口把吞吐拉高一倍以上', async () => {
  const { inflightWindow, MAX_INFLIGHT_PER_PEER } = await load();
  // 这是对「请求-送达」循环的建模，不是真实 WebRTC 实测：
  // 每个槽位一轮的耗时 = 一个往返 + 传一片的时间，吞吐 = 窗口 × 片大小 ÷ 该耗时。
  const rtt = 60;
  const capacity = 400e6;
  const throughput = (w) => (w * CHUNK) / (rtt / 1000 + CHUNK / capacity);

  const before = throughput(MAX_INFLIGHT_PER_PEER);
  let w = MAX_INFLIGHT_PER_PEER;
  for (let i = 0; i < 10; i++) w = inflightWindow({ rtt, downRate: throughput(w), chunkSize: CHUNK });
  const after = throughput(w);

  assert.ok(after / before >= 2, `只提升到 ${(after / before).toFixed(2)} 倍`);
  assert.ok(after <= capacity * 1.01, '不该算出超过链路容量的吞吐');
});

/* ----------------------------- 派片规则 ----------------------------- */

test('最急的那几片交给快的 peer，不再和慢的轮流分', async () => {
  const { Scheduler } = await load();
  const s = new Scheduler({ manifest: manifest() });
  const fast = peer('fast', { downRate: 20e6, rtt: 20 });
  const slow = peer('slow', { downRate: 2e6, rtt: 20 });

  const plan = s.plan({
    have: new Uint8Array(200),
    playbackByte: 0,
    inflight: new Set(),
    peers: [fast, slow],
  });

  // 两人的窗口都会被填满（慢的那 2 MB/s 也是带宽，没道理浪费），
  // 变的是「谁先拿到队头」：老规则按欠片数轮流分，队头第 1、3、5 片会落到
  // 慢的手里，整个关键窗口被拖到他的速度上。新规则按「多久能送到」排。
  const head = plan.slice(0, fast.remoteHave.length && 4);
  assert.ok(
    head.every((a) => a.peerId === 'fast'),
    `队头 4 片派成了 ${head.map((a) => a.peerId).join(',')}`
  );
  assert.equal(plan[0].index, 0, '最急的一片应该是队头');
  assert.ok(
    plan.some((a) => a.peerId === 'slow'),
    '慢的也该分到活，不能因为慢就闲着'
  );
});

test('两人速度一样时不会把片全堆给其中一个', async () => {
  const { Scheduler } = await load();
  const s = new Scheduler({ manifest: manifest() });
  const a = peer('a', { downRate: 10e6, rtt: 20 });
  const b = peer('b', { downRate: 10e6, rtt: 20 });
  const plan = s.plan({ have: new Uint8Array(200), playbackByte: 0, inflight: new Set(), peers: [a, b] });
  const na = plan.filter((x) => x.peerId === 'a').length;
  const nb = plan.filter((x) => x.peerId === 'b').length;
  assert.equal(na, nb, `速度相同却分成了 ${na}:${nb}`);
});

test('还没测出速率的新 peer 会被立刻试一试，不会饿死', async () => {
  const { Scheduler } = await load();
  const s = new Scheduler({ manifest: manifest() });
  const known = peer('known', { downRate: 10e6, rtt: 20 });
  const fresh = peer('fresh', { downRate: 0, rtt: 20 });

  const plan = s.plan({
    have: new Uint8Array(200),
    playbackByte: 0,
    inflight: new Set(),
    peers: [known, fresh],
  });
  assert.ok(
    plan.some((a) => a.peerId === 'fresh'),
    '给 0 速率的新上游一片都不分，它就永远测不出速率'
  );
});

test('只有一个 peer 有某一片时不会漏掉它', async () => {
  const { Scheduler } = await load();
  const s = new Scheduler({ manifest: manifest(10) });
  const rich = peer('rich', { downRate: 1e6, rtt: 10, chunkCount: 10 });
  const poor = peer('poor', { downRate: 50e6, rtt: 10, chunkCount: 10 });
  poor.remoteHave = new Uint8Array(10); // 什么都没有

  const plan = s.plan({ have: new Uint8Array(10), playbackByte: 0, inflight: new Set(), peers: [rich, poor] });
  assert.ok(plan.length > 0);
  assert.ok(plan.every((a) => a.peerId === 'rich'));
});

test('已经欠满的 peer 不再接新片', async () => {
  const { Scheduler } = await load();
  const s = new Scheduler({ manifest: manifest(), maxInflightPerPeer: 4 });
  const busy = peer('busy', { downRate: 10e6, rtt: 5, inflight: [0, 1, 2, 3] });
  const plan = s.plan({ have: new Uint8Array(200), playbackByte: 0, inflight: new Set([0, 1, 2, 3]), peers: [busy] });
  assert.equal(plan.length, 0);
});

test('显式指定窗口时钉死不自适应 —— 排障和测试要的确定性', async () => {
  const { Scheduler } = await load();
  const s = new Scheduler({ manifest: manifest(), maxInflightPerPeer: 2 });
  const p = peer('p', { downRate: 400e6, rtt: 300 }); // 自适应会给很大的窗口
  const plan = s.plan({ have: new Uint8Array(200), playbackByte: 0, inflight: new Set(), peers: [p] });
  assert.equal(plan.length, 2);
});

test('关键窗口仍然优先 —— 自适应没把播放位置优先调度冲掉', async () => {
  const { Scheduler } = await load();
  const s = new Scheduler({ manifest: manifest() });
  s.setDuration(3600);
  const p = peer('p', { downRate: 10e6, rtt: 60 });
  const have = new Uint8Array(200);
  const playbackByte = 100 * CHUNK;

  const plan = s.plan({ have, playbackByte, inflight: new Set(), peers: [p] });
  assert.ok(plan.length > 0);
  for (const a of plan) {
    assert.ok(a.index >= 100, `派了播放位置之前的第 ${a.index} 片，回拖片不该排在前面`);
  }
});

test('没有可用 peer 时返回空，不抛异常', async () => {
  const { Scheduler } = await load();
  const s = new Scheduler({ manifest: manifest() });
  assert.deepEqual(s.plan({ have: new Uint8Array(200), playbackByte: 0, inflight: new Set(), peers: [] }), []);
});

/* --------------------------- 两端保持一致 --------------------------- */

test('Android 端的调度器与桌面端逐字节一致', () => {
  const a = fs.readFileSync(path.join(__dirname, '../src/renderer/lib/scheduler.js'), 'utf8');
  const b = fs.readFileSync(path.join(__dirname, '../android/app/src/main/assets/js/scheduler.js'), 'utf8');
  assert.equal(a.replace(/\r\n/g, '\n'), b.replace(/\r\n/g, '\n'));
});

test('Android 端也拿得到同样的窗口值', async () => {
  const desktop = await load();
  const android = await loadAndroid();
  for (const rtt of [0, 1, 60, 150, 2000]) {
    assert.equal(
      android.inflightWindow({ rtt, downRate: 50e6, chunkSize: CHUNK }),
      desktop.inflightWindow({ rtt, downRate: 50e6, chunkSize: CHUNK }),
      `RTT ${rtt} 时两端窗口不一致`
    );
  }
});

/* --------------------------- 请求超时自适应 --------------------------- */

test('测不出 RTT／速率时，请求超时退回 20 秒', async () => {
  const { Swarm } = await import('../src/renderer/lib/swarm.js');
  const s = new Swarm({ peerId: 'me', name: 'me' });
  s.manifest = manifest();
  assert.equal(s._requestTimeout(undefined), 20000);
  assert.equal(s._requestTimeout({ rtt: 30, downRate: 0 }), 20000);
});

test('快链路上超时收紧，丢一条请求不用干等 20 秒', async () => {
  const { Swarm } = await import('../src/renderer/lib/swarm.js');
  const s = new Swarm({ peerId: 'me', name: 'me' });
  s.manifest = manifest();
  const t = s._requestTimeout({ rtt: 30, downRate: 20e6, inflight: new Set([1]) });
  assert.ok(t < 20000, `快链路上还是 ${t}ms`);
  assert.ok(t >= 6000, '也不能收得太狠，抖动一下就误判成超时');
});

test('慢链路上超时不会收得比原来还短', async () => {
  const { Swarm } = await import('../src/renderer/lib/swarm.js');
  const s = new Swarm({ peerId: 'me', name: 'me' });
  s.manifest = manifest();
  const t = s._requestTimeout({ rtt: 200, downRate: 200e3, inflight: new Set([1, 2, 3, 4]) });
  assert.equal(t, 20000, '一片要传十几秒的链路，超时必须留满');
});

test('欠得越多，允许等的时间越长 —— 排队是正常的，不是超时', async () => {
  const { Swarm } = await import('../src/renderer/lib/swarm.js');
  const s = new Swarm({ peerId: 'me', name: 'me' });
  s.manifest = manifest();
  // 挑一条会真的算出中间值的链路：快链路上两者都会撞到 6 秒下限，看不出差别。
  const one = s._requestTimeout({ rtt: 100, downRate: 2e6, inflight: new Set([1]) });
  const many = s._requestTimeout({ rtt: 100, downRate: 2e6, inflight: new Set([1, 2, 3]) });
  assert.ok(many > one, `欠 3 片 (${many}ms) 反而比欠 1 片 (${one}ms) 更早判超时`);
});

test('再快的链路也留 6 秒下限 —— 抢跑重派会把已经在路上的分片整片作废', async () => {
  const { Swarm } = await import('../src/renderer/lib/swarm.js');
  const s = new Swarm({ peerId: 'me', name: 'me' });
  s.manifest = manifest();
  assert.equal(s._requestTimeout({ rtt: 1, downRate: 200e6, inflight: new Set([1]) }), 6000);
});
