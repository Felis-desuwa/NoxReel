'use strict';

// 同步引擎的地基：房间时钟外推、回声窗口计数、tick 的来源与采样时间、跳转容差、片尾。
const test = require('node:test');
const assert = require('node:assert/strict');
const { IMPLS } = require('./helpers/impls');

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带假时钟的引擎。clock.t 以毫秒计，测试里手动拨。 */
async function makeEngine(dir, { role = 'host', peerId, hostId = 'host' } = {}) {
  const { SyncEngine } = await import(dir + 'syncEngine.js');
  const id = peerId || (role === 'host' ? 'host' : 'me');
  const eng = new SyncEngine({ peerId: id, name: id, isSeeder: role === 'host', hostId });
  const clock = { t: 1000 };
  eng.now = () => clock.t;
  const out = [];
  eng.on('outbound', (m) => out.push(m));
  const seeks = [];
  const pauses = [];
  eng.onSeek = (p) => seeks.push(p);
  eng.onSetPause = (p) => pauses.push(p);
  eng.started = true;
  if (role === 'admin') eng.applyRoles([[id, 'admin'], ['admin2', 'admin']], hostId);
  if (role === 'guest') eng.applyRoles([[id, 'guest'], ['admin2', 'admin']], hostId);
  return { eng, clock, out, seeks, pauses };
}

// v2 起 SYNC 必须带 seq（当前播放项序号），缺了当非法丢弃；这里的引擎都停在第 0 项。
const syncMsg = (over) => ({ t: 'sync', paused: false, position: 10, lamport: 5, seq: 0, ...over });
// STALL 还要带按发送者单调递增的 stallSeq，旧编号的会被当成过期消息丢掉。
const stallMsg = (stallSeq, over) => ({ t: 'stall', seq: 0, stallSeq, ...over });

impl('房间连续播了二十分钟，新人拿到的是「现在」的位置', async (dir) => {
  const { eng, clock } = await makeEngine(dir, { role: 'guest' });
  eng.onCtrl(syncMsg({ position: 10 }), { peerId: 'host', name: '房主' });
  clock.t += 1200 * 1000;
  assert.ok(Math.abs(eng.sharedPositionNow() - 1210) < 0.01, `外推结果 ${eng.sharedPositionNow()}`);

  const sent = [];
  eng.greet({ peerId: 'new', send: (m) => sent.push(m) });
  // 发送顺序是契约：ROLE 只有房主发，而且排在 SYNC 前面；游客打招呼时第一条就是 SYNC。
  assert.equal(sent.some((m) => m.t === 'role'), false, '只有房主才发角色表');
  const sync = sent.find((m) => m.t === 'sync');
  assert.equal(sent[0], sync);
  assert.ok(Math.abs(sync.position - 1210) < 0.01, `greet 报的位置是 ${sync.position}，新人会被拉回过去`);
  // 不带 seq 的 SYNC 会被对方当非法丢掉，新人就对不上位置了
  assert.equal(sync.seq, eng.seq);
});

impl('暂停期间房间时钟不走', async (dir) => {
  const { eng, clock } = await makeEngine(dir, { role: 'guest' });
  eng.onCtrl(syncMsg({ paused: true, position: 42 }), { peerId: 'host' });
  clock.t += 600 * 1000;
  assert.equal(eng.sharedPositionNow(), 42);
});

impl('有控制者卡住时房间时钟停走，解除后接着走', async (dir) => {
  const { eng, clock } = await makeEngine(dir, { role: 'guest' });
  eng.onCtrl(syncMsg({ position: 10 }), { peerId: 'host' });
  clock.t += 5000;
  eng.onCtrl(stallMsg(1, { stalled: true, position: 15 }), { peerId: 'admin2', name: 'A' });
  clock.t += 60000;
  assert.ok(Math.abs(eng.sharedPositionNow() - 15) < 0.01, `卡住期间不该往前走：${eng.sharedPositionNow()}`);
  eng.onCtrl(stallMsg(2, { stalled: false, position: 15 }), { peerId: 'admin2', name: 'A' });
  clock.t += 5000;
  assert.ok(Math.abs(eng.sharedPositionNow() - 20) < 0.01, `解除后要接着走：${eng.sharedPositionNow()}`);
});

impl('游客自己缓冲不足只停自己，房间时钟照走', async (dir) => {
  const { eng, clock } = await makeEngine(dir, { role: 'guest' });
  eng.onCtrl(syncMsg({ position: 10 }), { peerId: 'host' });
  eng.bytesPerSecond = 1000;
  eng._evaluateStall({ position: 10, paused: false }, { contiguousBytes: 10000, complete: false });
  assert.equal(eng.localStalled, true);
  clock.t += 30000;
  assert.ok(Math.abs(eng.sharedPositionNow() - 40) < 0.01, `游客卡住不该拖住房间时钟：${eng.sharedPositionNow()}`);
});

impl('片长已知时房间时钟不会超过片尾', async (dir) => {
  const { eng, clock } = await makeEngine(dir, { role: 'guest' });
  eng.setMediaInfo({ duration: 100, size: 1000 });
  eng.onCtrl(syncMsg({ position: 90 }), { peerId: 'host' });
  clock.t += 60000;
  assert.equal(eng.sharedPositionNow(), 100);
});

impl('播放器重新起来时按房间时钟补位', async (dir) => {
  const { eng, clock, seeks } = await makeEngine(dir, { role: 'guest' });
  eng.lastTick = { position: 300, paused: false, at: clock.t };
  eng.onCtrl(syncMsg({ position: 300 }), { peerId: 'host' });
  eng.forgetPlayerState();
  clock.t += 90 * 1000;
  eng.lastTick = { position: 0, paused: true, at: clock.t };
  seeks.length = 0;
  await eng.resyncToShared();
  assert.equal(seeks.length, 1);
  assert.ok(Math.abs(seeks[0] - 390) < 0.01, `重开后应跳到 390，实际 ${seeks[0]}`);
});

impl('播放器没起来时记下的位置，起来前房间一直在播的话要补上这段时间', async (dir) => {
  const { eng, clock, seeks } = await makeEngine(dir, { role: 'guest' });
  eng.lastTick = null;
  eng.onCtrl(syncMsg({ position: 930 }), { peerId: 'host' });
  assert.equal(eng.pendingSeek, 930);
  clock.t += 20000;
  eng.lastTick = { position: 0, paused: true, at: clock.t };
  await eng.resyncToShared();
  assert.ok(Math.abs(seeks.at(-1) - 950) < 0.01, `应补到 950，实际 ${seeks.at(-1)}`);
});

impl('房主关掉播放器后在界面上点播放，不会把全房拉回片头', async (dir) => {
  const { eng, clock, out } = await makeEngine(dir, { role: 'host' });
  // 共识停在 500 秒，播放器已经关掉
  eng.shared = { paused: true, position: 500, lamport: 50, by: 'host' };
  eng._syncClock(500);
  eng.lastTick = null;
  clock.t += 1000;
  out.length = 0;
  eng.userSetPaused(false);
  const sync = out.find((m) => m.t === 'sync');
  assert.equal(sync.position, 500, `报了 ${sync.position}`);
});

impl('几次同步交叠时，先结束的那次不会提前关掉回声窗口', async (dir) => {
  const { eng, out } = await makeEngine(dir, { role: 'admin', hostId: 'host' });
  eng.lastTick = { position: 100, paused: false, at: eng.now(), sampledAt: 0 };
  // 慢吞吞的播放器：第一条暂停命令 1.2 秒后才返回，之后的都很快
  let calls = 0;
  eng.onSetPause = () => new Promise((r) => setTimeout(r, calls++ === 0 ? 1200 : 0));

  eng.onCtrl(syncMsg({ paused: true, position: 100, lamport: 9 }), { peerId: 'host' });
  await sleep(50);
  // 期间来了一次与此无关的收敛（有人卡住又马上恢复）
  eng.onCtrl(stallMsg(1, { stalled: true, position: 1 }), { peerId: 'admin2' });
  eng.onCtrl(stallMsg(2, { stalled: false, position: 1 }), { peerId: 'admin2' });
  await sleep(500); // 这时候那两次的窗口都结束了，但第一次还在等播放器
  assert.equal(eng.applying, true, '窗口被提前关掉了');

  out.length = 0;
  // 播放器的暂停回声在这时才到
  eng.onMpvTick({ position: 100, paused: true, sampledAt: 600 }, { contiguousBytes: 0, complete: true });
  assert.equal(out.filter((m) => m.t === 'sync').length, 0, '回声被当成用户暂停广播出去了');
  await sleep(1100);
});

impl('窗口结束后播放器状态仍不对，先重发一次，再不行就报出来而不是广播', async (dir) => {
  const { eng, out, pauses } = await makeEngine(dir, { role: 'host' });
  const diverged = [];
  eng.on('diverged', (e) => diverged.push(e));
  eng.lastTick = { position: 5, paused: true, at: eng.now() };
  eng.intendedPaused = false; // 房间要播，播放器却一直停着
  pauses.length = 0;
  await eng._reconcile();
  await sleep(700);
  assert.ok(pauses.length >= 2, `应当重发一次，实际发了 ${pauses.length} 次`);
  assert.equal(diverged.length >= 1, true, '重发后仍不一致要报出来');
  assert.equal(out.filter((m) => m.t === 'sync').length, 0, '不能把播放器的异常状态当成用户操作广播');
});

impl('适配器标明是命令效果的 tick 不算用户操作', async (dir) => {
  const { eng, out } = await makeEngine(dir, { role: 'host' });
  eng.lastTick = { position: 10, paused: false, at: eng.now(), sampledAt: 0 };
  eng.onMpvTick({ position: 40, paused: true, cause: 'cmd', sampledAt: 100 }, { contiguousBytes: 0, complete: true });
  assert.equal(out.length, 0);
  // 之后的普通 tick 以它为基线，不会被当成跳变
  eng.onMpvTick({ position: 40, paused: true, sampledAt: 400 }, { contiguousBytes: 0, complete: true });
  assert.equal(out.length, 0);
});

impl('跳变判定用主进程采样时间，不被 IPC 排队抖动误导', async (dir) => {
  const { eng, clock, out } = await makeEngine(dir, { role: 'host' });
  eng.onMpvTick({ position: 10, paused: false, sampledAt: 50000 }, { contiguousBytes: 0, complete: true });
  clock.t += 3000; // 渲染进程三秒后才收到下一条
  eng.onMpvTick({ position: 11, paused: false, sampledAt: 51000 }, { contiguousBytes: 0, complete: true });
  assert.equal(out.filter((m) => m.t === 'sync').length, 0, '采样间隔 1 秒、位置走了 1 秒，不是跳转');

  clock.t += 100;
  eng.onMpvTick({ position: 30, paused: false, sampledAt: 51100 }, { contiguousBytes: 0, complete: true });
  assert.equal(out.filter((m) => m.t === 'sync').length, 1, '真跳转要能识别');
});

impl('放到片尾自己停下不当成用户暂停，片尾事件只报一次', async (dir) => {
  const { eng, out } = await makeEngine(dir, { role: 'host' });
  const eofs = [];
  eng.on('eof', (e) => eofs.push(e));
  eng.onMpvTick({ position: 99, paused: false, sampledAt: 0 }, { contiguousBytes: 0, complete: true });
  eng.onMpvTick({ position: 100, paused: true, eof: true, sampledAt: 1000 }, { contiguousBytes: 0, complete: true });
  eng.onMpvTick({ position: 100, paused: true, eof: true, sampledAt: 1200 }, { contiguousBytes: 0, complete: true });
  assert.equal(out.filter((m) => m.t === 'sync').length, 0, '片尾停下被广播成了暂停');
  assert.equal(eofs.length, 1);
});

impl('跳转精度差的播放器，容差跟着放宽', async (dir) => {
  const { eng, seeks } = await makeEngine(dir, { role: 'guest' });
  eng.lastTick = { position: 100, paused: true, at: eng.now() };
  eng.setPlayerCaps({ seekPrecision: 1.2 });
  assert.ok(Math.abs(eng.seekTolerance - 1.7) < 1e-9);
  eng.onCtrl(syncMsg({ paused: false, position: 101.5 }), { peerId: 'host' });
  await sleep(10);
  assert.deepEqual(seeks, [], '偏差在容差内不该再拽一次');
  eng.setPlayerCaps({});
  assert.equal(eng.seekTolerance, 0.75);
});
