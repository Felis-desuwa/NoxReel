'use strict';

// 在线链接的跟随方式：每个成员自己选「完全同步」或「手动同步」，没对上时报差多少秒。
//
//  - 同步引擎（桌面、安卓两份同源，都跑）：缓冲信号、自动对齐、同步失败、手动同步只跟跳转、
//    缓冲被误判成拖进度条的老问题；
//  - 主进程：mpv 多观察一个 paused-for-cache、在线链接攒够 5 秒再放、Ctrl+Shift+S 的整条链路；
//  - app.js：换片时把跟随方式交给引擎、状态带那一行、选择存本机、翻译。
// 全程假时钟、假网络，不启动播放器、不联网、不出声。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { IMPLS } = require('./helpers/impls');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('src', 'renderer', 'app.js');

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

// 引擎在命令发出后留 250ms 认回声（真的 setTimeout），核对差值前要等它关掉
const settle = () => new Promise((r) => setTimeout(r, 300));
const near = (a, b, eps = 0.05) => Math.abs(a - b) <= eps;

/* ------------------------------ 引擎的假网络 ------------------------------ */

/**
 * 一个房间：房主 h1 加若干成员，全连通（房间链接 / 信令服务器的网状）。每台引擎共用一只假时钟，
 * 记下自己发出去的消息、叫播放器做的跳转和暂停，以及差值事件。
 */
async function linkRoom(dir, members, { streaming = true } = {}) {
  const { SyncEngine } = await import(dir + 'syncEngine.js');
  const clock = { t: 10_000 };
  const nodes = new Map();
  const queue = [];
  const roles = members.map((m) => [m.id, m.role || 'guest']);
  const add = (id, mode) => {
    const eng = new SyncEngine({ peerId: id, name: id, isSeeder: true, hostId: 'h1' });
    eng.now = () => clock.t;
    const node = { id, eng, out: [], seeks: [], pauses: [], drift: [], corrections: [], denied: [] };
    eng.onSeek = (p) => node.seeks.push(p);
    eng.onSetPause = (p) => node.pauses.push(p);
    eng.started = true;
    eng.applyRoles(roles, 'h1');
    eng.on('outbound', (m) => {
      node.out.push(m);
      for (const other of nodes.keys()) if (other !== id) queue.push({ from: id, to: other, msg: JSON.parse(JSON.stringify(m)) });
    });
    eng.on('drift', (d) => node.drift.push(d));
    eng.on('drift-correct', (e) => node.corrections.push(e));
    eng.on('denied', (e) => node.denied.push(e));
    node.mode = mode;
    nodes.set(id, node);
    return node;
  };
  add('h1', 'full');
  for (const m of members) add(m.id, m.mode || 'full');
  const flush = () => {
    while (queue.length) {
      const { from, to, msg } = queue.shift();
      nodes.get(to).eng.onCtrl(msg, { peerId: from, name: from });
    }
  };
  for (const node of nodes.values()) {
    node.eng.resetMedia({ seq: 1, isSeeder: true, broadcast: node.id === 'h1' });
    node.eng.setFollow({ streaming, mode: node.mode });
    node.eng.setMediaInfo({ duration: 3600, size: 0 });
  }
  flush();
  const room = {
    clock,
    flush,
    node: (id) => nodes.get(id),
    eng: (id) => nodes.get(id).eng,
    advance(sec) {
      clock.t += sec * 1000;
    },
    /**
     * 喂一条 tick，缺省是「正在播、没缓冲」。引擎会拿它和上一条比，判断用户是不是拖了进度条 ——
     * 真的 mpv 位置是连续推上来的，这里跳着喂就会被当成拖进度条。
     */
    tick(id, fields) {
      const snap = { position: 0, paused: false, eof: false, idle: false, seeking: false, pausedForCache: false, ...fields };
      snap.sampledAt = clock.t;
      nodes.get(id).eng.onMpvTick(snap, { contiguousBytes: 0, runBytes: 0, complete: true });
    },
    /**
     * 直接把播放器摆到某个位置（播放器适配器标明这是命令的效果，引擎只当基线、不判用户操作）。
     * 测差值的用例用它，免得每次挪位置都被当成拖进度条。
     */
    place(id, fields) {
      room.tick(id, { ...fields, cause: 'cmd' });
    },
    /**
     * 房主点播放，房间时钟从 0 起走。每个人的播放器报第一条 tick（引擎会把房间位置补放给新播放器，
     * 那一下跳转不是这里要看的），然后把记录清空。
     */
    async play() {
      nodes.get('h1').eng.userSetPaused(false);
      flush();
      for (const id of nodes.keys()) room.tick(id, { position: 0 });
      flush();
      await settle();
      for (const node of nodes.values()) {
        node.out.length = 0;
        node.seeks.length = 0;
        node.pauses.length = 0;
        node.drift.length = 0;
      }
    },
  };
  return room;
}

const syncs = (node) => node.out.filter((m) => m.t === 'sync');
const stalls = (node) => node.out.filter((m) => m.t === 'stall');

/* ------------------------------ 缓冲不是拖进度条 ------------------------------ */

impl('在线链接缓冲了十秒：缓冲完的那条 tick 不会被当成往回拖进度条（管理员不拽全房，游客不被往前拽）', async (dir) => {
  const r = await linkRoom(dir, [
    { id: 'adm', role: 'admin', mode: 'manual' },
    { id: 'gst', role: 'guest', mode: 'full' },
  ]);
  await r.play();
  r.advance(10);
  for (const id of ['adm', 'gst']) r.tick(id, { position: 10 });
  r.advance(0.2);
  for (const id of ['adm', 'gst']) r.tick(id, { position: 10.2, pausedForCache: true });
  await settle();
  r.advance(10);
  for (const id of ['adm', 'gst']) r.tick(id, { position: 10.2 });
  await settle();
  assert.equal(syncs(r.node('adm')).length, 0, '管理员缓冲完不能广播 SYNC 把全房拽回 10 秒');
  assert.deepEqual(r.node('gst').denied, [], '游客缓冲完不能被判成「拖进度条」');
  assert.deepEqual(r.node('gst').seeks, [], '也不能被拽到「本该在的位置」，缓冲的那段直接跳过去');

  // 反过来，缓冲着的时候真拖了进度条还是认的
  r.advance(1);
  r.tick('adm', { position: 11.2 });
  r.advance(0.5);
  r.tick('adm', { position: 11.7, pausedForCache: true });
  r.advance(3);
  r.tick('adm', { position: 300, pausedForCache: true });
  assert.equal(syncs(r.node('adm')).at(-1)?.position, 300);
});

impl('本地文件也一样：跳转后重新起播（core-idle）那段时间位置停着，不按「在走」外推', async (dir) => {
  const r = await linkRoom(dir, [{ id: 'gst', role: 'guest' }], { streaming: false });
  await r.play();
  r.advance(30);
  r.tick('gst', { position: 30 });
  r.advance(0.1);
  r.tick('gst', { position: 30, idle: true });
  await settle();
  r.advance(4);
  r.tick('gst', { position: 30.1 });
  await settle();
  assert.deepEqual(r.node('gst').denied, []);
  assert.deepEqual(r.node('gst').seeks, []);
});

impl('自己发出的跳转晚到的回声不算用户操作；真拖进度条照样认', async (dir) => {
  const r = await linkRoom(dir, [{ id: 'adm', role: 'admin' }]);
  await r.play();
  const adm = r.node('adm');
  r.advance(10);
  r.tick('adm', { position: 10 });
  adm.eng._reconcile({ seekTo: 50, force: true });
  await settle(); // 250ms 的回声窗口已经关了，网络流的位置变化才到
  r.advance(0.5);
  r.tick('adm', { position: 50 });
  assert.equal(syncs(adm).length, 0, '落点是自己刚跳过去的地方，不能当成管理员拖了进度条广播出去');
  r.advance(0.5);
  r.tick('adm', { position: 200 });
  assert.equal(syncs(adm).length, 1, '真拖进度条还得认');
  assert.equal(syncs(adm)[0].position, 200);
});

/* ------------------------------ 谁缓冲让全房等 ------------------------------ */

impl('完全同步的管理员缓冲时全房等他，缓冲够了一起放；手动同步的管理员和游客只卡自己', async (dir) => {
  const r = await linkRoom(dir, [
    { id: 'full', role: 'admin', mode: 'full' },
    { id: 'man', role: 'admin', mode: 'manual' },
    { id: 'gst', role: 'guest', mode: 'full' },
  ]);
  await r.play();
  r.advance(5);
  for (const id of ['full', 'man', 'gst']) r.tick(id, { position: 5 });

  r.tick('man', { position: 5, pausedForCache: true });
  r.tick('gst', { position: 5, pausedForCache: true });
  r.flush();
  assert.equal(stalls(r.node('man')).length, 0, '手动同步：缓冲只卡自己');
  assert.equal(stalls(r.node('gst')).length, 0, '游客：缓冲只卡自己');
  assert.equal(r.eng('gst').localStalled, false, 'mpv 自己会等，用不着再按一次暂停');
  assert.equal(r.eng('h1').effectivePaused, false, '房间照走');

  r.tick('full', { position: 5, pausedForCache: true });
  r.flush();
  assert.deepEqual(stalls(r.node('full')).map((m) => m.stalled), [true]);
  assert.equal(r.eng('h1').effectivePaused, true, '全房等他');
  assert.equal(r.eng('h1').stalledPeers.has('full'), true);

  assert.equal(r.node('full').pauses.includes(true), false, '自己在等数据时不再按暂停：mpv 本来就停着');
  assert.equal(r.eng('full').effectivePaused, false);

  await settle();
  r.advance(6);
  r.tick('full', { position: 5, pausedForCache: false });
  r.flush();
  assert.deepEqual(stalls(r.node('full')).map((m) => m.stalled), [true, false]);
  assert.equal(r.eng('h1').effectivePaused, false, '缓冲够了一起放');
});

impl('房主跳转后重新起播的那几秒也让全房等（seeking、没暂停却 core-idle），好了一起走；暂停着、放到头不算', async (dir) => {
  const r = await linkRoom(dir, [{ id: 'gst', role: 'guest', mode: 'full' }]);
  await r.play();
  const h = r.node('h1');
  r.advance(10);
  r.tick('h1', { position: 10 });
  h.eng.userSeek(300);
  r.flush();
  r.place('h1', { position: 300, seeking: true, idle: true });
  r.flush();
  assert.deepEqual(stalls(h).map((m) => m.stalled), [true], '跳转中：让全房等');
  assert.equal(r.eng('gst').effectivePaused, true);
  const frozen = r.eng('gst').sharedPositionNow();
  r.advance(7); // 网络流跳一次 7 秒
  assert.ok(near(r.eng('gst').sharedPositionNow(), frozen), '房间时钟停着等房主');
  r.place('h1', { position: 300, idle: true }); // 跳完了还在起播
  r.flush();
  assert.equal(stalls(h).length, 1, '没暂停却 core-idle：还在等');
  r.place('h1', { position: 300 });
  r.flush();
  assert.deepEqual(stalls(h).map((m) => m.stalled), [true, false]);
  assert.equal(r.eng('gst').effectivePaused, false);
  assert.ok(near(r.eng('h1').sharedPositionNow(), 300), '房主起播时房间正好在 300 秒，房主不用被往前拽');

  // 暂停着的 core-idle、放到头都不是「在等数据」
  r.place('h1', { position: 300, idle: true, paused: true });
  r.place('h1', { position: 3599, idle: true, eof: true });
  r.flush();
  assert.equal(stalls(h).length, 2);
});

impl('游客跳转、重新起播不让全房等（照样由自动对齐追上）', async (dir) => {
  const r = await linkRoom(dir, [{ id: 'gst', role: 'guest', mode: 'full' }]);
  await r.play();
  r.advance(5);
  r.place('gst', { position: 5, seeking: true, idle: true });
  r.flush();
  assert.equal(stalls(r.node('gst')).length, 0);
  assert.equal(r.eng('h1').effectivePaused, false);
});

impl('房主是参照：选了手动同步也照样按完全同步走，缓冲时全房等他', async (dir) => {
  const r = await linkRoom(dir, [{ id: 'gst', role: 'guest' }]);
  r.eng('h1').setFollow({ mode: 'manual' });
  await r.play();
  r.advance(3);
  r.tick('h1', { position: 3 });
  r.tick('h1', { position: 3, pausedForCache: true });
  r.flush();
  assert.deepEqual(stalls(r.node('h1')).map((m) => m.stalled), [true]);
  assert.equal(r.eng('gst').effectivePaused, true);
});

impl('缓冲让全房等着的时候改成手动同步：当场放开', async (dir) => {
  const r = await linkRoom(dir, [{ id: 'adm', role: 'admin', mode: 'full' }]);
  await r.play();
  r.advance(5);
  r.tick('adm', { position: 5, pausedForCache: true });
  r.flush();
  assert.equal(r.eng('h1').effectivePaused, true);
  r.eng('adm').setFollow({ mode: 'manual' });
  r.flush();
  assert.deepEqual(stalls(r.node('adm')).map((m) => m.stalled), [true, false]);
  assert.equal(r.eng('h1').effectivePaused, false);
});

impl('在线链接没有分片进度：下载进度那条路不能把缓冲中的管理员放开', async (dir) => {
  const r = await linkRoom(dir, [{ id: 'adm', role: 'admin', mode: 'full' }]);
  await r.play();
  r.advance(5);
  r.tick('adm', { position: 5, pausedForCache: true });
  r.eng('adm').onBufferProgress({ contiguousBytes: 0, runBytes: 0, complete: true });
  r.flush();
  assert.deepEqual(stalls(r.node('adm')).map((m) => m.stalled), [true]);
  assert.equal(r.eng('h1').effectivePaused, true);
});

impl('本地文件不看 mpv 的缓冲信号：那一路照旧按分片水位判断', async (dir) => {
  const r = await linkRoom(dir, [{ id: 'adm', role: 'admin' }], { streaming: false });
  await r.play();
  r.advance(5);
  r.tick('adm', { position: 5, pausedForCache: true });
  r.flush();
  assert.equal(stalls(r.node('adm')).length, 0);
});

/* ------------------------------ 完全同步：自动对齐 ------------------------------ */

/** 连着核对两次（中间隔一秒），差值才算数 */
function checkTwice(r, id, position) {
  const g = r.node(id);
  if (position !== undefined) r.place(id, { position: position(g.eng) });
  g.eng.checkDrift();
  r.advance(1);
  if (position !== undefined) r.place(id, { position: position(g.eng) });
  g.eng.checkDrift();
}

impl('完全同步：落后超过 2 秒、连着两次核对都这样，才自动跳到房间的位置', async (dir) => {
  const r = await linkRoom(dir, [{ id: 'gst', role: 'guest', mode: 'full' }]);
  await r.play();
  const g = r.node('gst');
  r.advance(20);
  r.place('gst', { position: 15 }); // 房间在 20
  g.eng.checkDrift();
  assert.deepEqual(g.seeks, [], '一次读数不算数');
  r.advance(1);
  g.eng.checkDrift();
  assert.equal(g.seeks.length, 1);
  assert.ok(near(g.seeks[0], 21), `跳到房间此刻的位置，实际 ${g.seeks[0]}`);
  assert.equal(g.corrections.length, 1);
  assert.ok(near(g.corrections[0].seconds, -5));
  assert.equal(g.eng.driftStatus().state, 'ok', '自动对齐这一下不用打扰用户');

  // 跳过去还没落地（播放器还落后着）：5 秒内不再跳第二次
  await settle();
  for (let i = 0; i < 3; i++) {
    r.advance(1);
    r.place('gst', { position: g.eng.sharedPositionNow() - 5 });
    g.eng.checkDrift();
  }
  assert.equal(g.seeks.length, 1, '刚跳过就再跳，网络流会一直在重新缓冲');
  r.advance(3);
  checkTwice(r, 'gst', (e) => e.sharedPositionNow() - 5);
  assert.equal(g.seeks.length, 2, '冷却过了照样再对');
});

impl('完全同步：差 2 秒以内不动；跳过去落地慢了多少，下次就往前多跳多少（封顶 10 秒）', async (dir) => {
  const r = await linkRoom(dir, [{ id: 'gst', role: 'guest', mode: 'full' }]);
  await r.play();
  const g = r.node('gst');
  r.advance(20);
  checkTwice(r, 'gst', (e) => e.sharedPositionNow() - 1.5);
  assert.deepEqual(g.seeks, [], '1.5 秒不值得跳：网络流跳一下要重新缓冲');

  checkTwice(r, 'gst', (e) => e.sharedPositionNow() - 10);
  assert.equal(g.seeks.length, 1);
  const target = g.seeks[0];
  assert.ok(near(target, g.eng.sharedPositionNow()), '第一次还没学到提前量');
  await settle();
  // 跳过去重新缓冲花了 1.5 秒：落地时房间已经往前走了 1.5 秒
  r.advance(1.5);
  r.place('gst', { position: target });
  g.eng.checkDrift();
  assert.ok(near(g.eng._seekLead, 1.5), `学到的提前量 ${g.eng._seekLead}`);

  // 之后又落下了：这次往前多跳 1.5 秒
  r.advance(10);
  checkTwice(r, 'gst', (e) => e.sharedPositionNow() - 6);
  assert.equal(g.seeks.length, 2);
  const room = g.eng.sharedPositionNow();
  assert.ok(near(g.seeks[1], room + 1.5), `目标 ${g.seeks[1]}，房间 ${room}`);

  // 提前量封顶：落地时又慢了 30 秒（多半是卡住了，但也只学到 10 秒）
  await settle();
  r.advance(2);
  r.place('gst', { position: g.eng.sharedPositionNow() - 30 });
  g.eng.checkDrift();
  assert.equal(g.eng._seekLead, 10);
});

impl('完全同步：跳过去之后 20 秒都没核对上的不拿来学提前量；房间暂停着跳的也不学', async (dir) => {
  const r = await linkRoom(dir, [{ id: 'gst', role: 'guest', mode: 'full' }]);
  await r.play();
  const g = r.node('gst');
  r.advance(20);
  checkTwice(r, 'gst', (e) => e.sharedPositionNow() - 10);
  assert.equal(g.seeks.length, 1);
  await settle();
  r.advance(21);
  r.place('gst', { position: g.eng.sharedPositionNow() - 3 });
  g.eng.checkDrift();
  assert.equal(g.eng._seekLead, 0);

  r.eng('h1').userSetPaused(true);
  r.flush();
  r.place('gst', { position: g.eng.sharedPositionNow(), paused: true }); // 播放器照做了
  await settle();
  r.place('gst', { position: g.eng.sharedPositionNow() - 10, paused: true });
  g.eng._seekLead = 2; // 之前学到过提前量
  r.advance(10);
  checkTwice(r, 'gst');
  assert.equal(g.seeks.length, 3, '房间暂停着也对齐（收到暂停时对过一次，这里又对一次）');
  assert.ok(near(g.seeks.at(-1), g.eng.sharedPositionNow()), '暂停着不加提前量');
  await settle();
  r.advance(2);
  r.place('gst', { position: g.eng.sharedPositionNow() - 3, paused: true });
  g.eng.checkDrift();
  assert.equal(g.eng._seekLead, 2, '房间没在走，落地慢不慢说明不了跳转花了多久');
});

impl('完全同步：两分钟里往前追了四次还是落后，报「同步失败」和差多少秒，停手一分钟再试', async (dir) => {
  const r = await linkRoom(dir, [{ id: 'gst', role: 'guest', mode: 'full' }]);
  await r.play();
  const g = r.node('gst');
  // 播放器一直落后房间 8 秒，跳过去也没用（网速跟不上）。每轮 6 秒
  const round = async () => {
    checkTwice(r, 'gst', (e) => e.sharedPositionNow() - 8);
    await settle();
    r.advance(5);
  };
  r.advance(30);
  for (let i = 0; i < 4; i++) await round();
  assert.equal(g.seeks.length, 4);
  assert.equal(g.eng.driftStatus().state, 'ok');

  await round();
  assert.equal(g.seeks.length, 4, '第五次不跳了');
  assert.deepEqual({ ...g.eng.driftStatus() }, { state: 'failed', seconds: -8, mode: 'full', streaming: true });
  assert.equal(g.drift.at(-1).state, 'failed');

  for (let i = 0; i < 9; i++) await round(); // 54 秒：还在停手期
  assert.equal(g.seeks.length, 4);
  assert.equal(g.eng.driftStatus().state, 'failed', '差值照样报着');

  await round(); // 满一分钟
  assert.equal(g.seeks.length, 5, '停手期过了再试');

  // 对上了就不再报失败
  await settle();
  r.place('gst', { position: g.eng.sharedPositionNow() });
  g.eng.checkDrift();
  assert.equal(g.eng.driftStatus().state, 'ok');
});

impl('完全同步：跳过头了往回对不算「跟不上」（缓存里的数据跳过去几乎不花时间，提前量会偏大）', async (dir) => {
  const r = await linkRoom(dir, [{ id: 'gst', role: 'guest', mode: 'full' }]);
  await r.play();
  const g = r.node('gst');
  r.advance(30);
  for (let i = 0; i < 8; i++) {
    checkTwice(r, 'gst', (e) => e.sharedPositionNow() + 6);
    await settle();
    r.advance(5);
  }
  assert.equal(g.seeks.length, 8, '每次都往回对');
  assert.equal(g.eng.driftStatus().state, 'ok', '从来不报同步失败');
});

impl('手动同步：点了「同步到房主」落地还差着，自动补跳一次（用刚学到的提前量）；只补一次', async (dir) => {
  const r = await linkRoom(dir, [{ id: 'gst', role: 'guest', mode: 'manual' }]);
  await r.play();
  const g = r.node('gst');
  r.advance(40);
  r.place('gst', { position: 20 });
  assert.equal(g.eng.syncToRoom(), true);
  assert.equal(g.seeks.length, 1);
  await settle();
  // 这个网站跳一次要 7 秒：落地时房间已经往前走了 7 秒
  r.advance(7);
  checkTwice(r, 'gst', (e) => e.sharedPositionNow() - 7);
  assert.equal(g.seeks.length, 2, '自动补跳');
  assert.ok(near(g.eng._seekLead, 7, 1.1), `学到的提前量 ${g.eng._seekLead}`);
  assert.ok(near(g.seeks[1], g.eng.sharedPositionNow() + g.eng._seekLead), '补跳带上提前量');
  assert.equal(g.eng.driftStatus().state, 'ok', '补跳这一下不用打扰用户');

  // 补跳之后还差着：不再自己跳，照常提示
  await settle();
  r.advance(7);
  checkTwice(r, 'gst', (e) => e.sharedPositionNow() - 5);
  assert.equal(g.seeks.length, 2);
  assert.equal(g.eng.driftStatus().state, 'out');

  // 落地很快（数据在缓存里）但还差着：补跳也要等冷却，别刚落地就连着再跳
  const quick = await linkRoom(dir, [{ id: 'gst', role: 'guest', mode: 'manual' }]);
  await quick.play();
  const q = quick.node('gst');
  quick.advance(40);
  quick.place('gst', { position: 30 });
  q.eng.syncToRoom();
  await settle();
  checkTwice(quick, 'gst', (e) => e.sharedPositionNow() - 3);
  checkTwice(quick, 'gst', (e) => e.sharedPositionNow() - 3);
  assert.equal(q.seeks.length, 1, '落地才 2 秒，还在冷却');
  assert.equal(q.eng.driftStatus().state, 'ok', '补跳还排着，先不提示');
  quick.advance(3);
  checkTwice(quick, 'gst', (e) => e.sharedPositionNow() - 3);
  assert.equal(q.seeks.length, 2, '冷却过了补跳');

  // 太久以前点的也不算：自己慢慢落下的只提示
  const late = await linkRoom(dir, [{ id: 'gst', role: 'guest', mode: 'manual' }]);
  await late.play();
  late.advance(40);
  late.place('gst', { position: 40 });
  late.eng('gst').syncToRoom();
  await settle();
  late.advance(40);
  checkTwice(late, 'gst', (e) => e.sharedPositionNow() - 5);
  assert.equal(late.node('gst').seeks.length, 1);
  assert.equal(late.eng('gst').driftStatus().state, 'out');
});

impl('游客自己按了暂停（只停自己）：这是有意分开，不报差值也不拽他', async (dir) => {
  const r = await linkRoom(dir, [{ id: 'gst', role: 'guest', mode: 'full' }]);
  await r.play();
  const g = r.node('gst');
  g.eng.userSetPaused(true);
  r.place('gst', { position: 0, paused: true }); // 播放器照做了（不然引擎会重发暂停，核对一直被回声窗口挡着）
  await settle();
  r.advance(30);
  r.place('gst', { position: 5, paused: true });
  for (let i = 0; i < 3; i++) {
    g.eng.checkDrift();
    r.advance(1);
  }
  assert.deepEqual(g.seeks, []);
  assert.equal(g.eng.driftStatus().state, 'ok');
});

impl('本地文件、播放器正在跳转或缓冲时：不核对', async (dir) => {
  const file = await linkRoom(dir, [{ id: 'gst', role: 'guest' }], { streaming: false });
  await file.play();
  file.advance(30);
  checkTwice(file, 'gst', () => 1);
  file.advance(1);
  checkTwice(file, 'gst', () => 1);
  assert.deepEqual(file.node('gst').seeks, []);
  assert.deepEqual(file.node('gst').drift.filter((d) => d.state !== 'ok'), []);

  const r = await linkRoom(dir, [{ id: 'gst', role: 'guest', mode: 'manual' }]);
  await r.play();
  r.advance(30);
  for (const busy of [{ seeking: true }, { pausedForCache: true }, { idle: true }]) {
    r.place('gst', { position: 1, ...busy });
    r.eng('gst').checkDrift();
    r.advance(1);
    r.eng('gst').checkDrift();
  }
  assert.equal(r.eng('gst').driftStatus().state, 'ok');
});

/* ------------------------------ 手动同步 ------------------------------ */

impl('手动同步：落后了只报差多少秒，不动播放器；点「同步到房主」才跳过去', async (dir) => {
  const r = await linkRoom(dir, [{ id: 'gst', role: 'guest', mode: 'manual' }]);
  await r.play();
  const g = r.node('gst');
  r.advance(40);
  checkTwice(r, 'gst', (e) => e.sharedPositionNow() - 12);
  assert.deepEqual(g.seeks, []);
  assert.deepEqual({ ...g.eng.driftStatus() }, { state: 'out', seconds: -12, mode: 'manual', streaming: true });

  // 滞回：回到 2 秒以内还算没对上（数字照更新），1 秒以内才算对上
  r.place('gst', { position: g.eng.sharedPositionNow() - 1.6 });
  g.eng.checkDrift();
  assert.deepEqual({ ...g.eng.driftStatus() }, { state: 'out', seconds: -2, mode: 'manual', streaming: true });
  r.place('gst', { position: g.eng.sharedPositionNow() - 0.5 });
  g.eng.checkDrift();
  assert.equal(g.eng.driftStatus().state, 'ok');

  checkTwice(r, 'gst', (e) => e.sharedPositionNow() + 4);
  assert.deepEqual({ ...g.eng.driftStatus() }, { state: 'out', seconds: 4, mode: 'manual', streaming: true }, '跑到前面也报');

  assert.equal(g.eng.syncToRoom(), true);
  assert.equal(g.seeks.length, 1);
  assert.ok(near(g.seeks[0], g.eng.sharedPositionNow()));
  assert.equal(g.eng.driftStatus().state, 'ok');
});

impl('手动同步：房主暂停、播放不动他的进度；房主真跳转了照跟', async (dir) => {
  const r = await linkRoom(dir, [{ id: 'gst', role: 'guest', mode: 'manual' }]);
  await r.play();
  const g = r.node('gst');
  r.advance(40);
  r.place('h1', { position: 40 });
  r.place('gst', { position: 28 });

  r.eng('h1').userSetPaused(true);
  r.flush();
  await settle();
  r.place('h1', { position: 40, paused: true });
  r.place('gst', { position: 28, paused: true });
  r.advance(3);
  r.eng('h1').userSetPaused(false);
  r.flush();
  await settle();
  assert.deepEqual(g.seeks, [], '按一下暂停不该顺手替他对齐');
  assert.deepEqual(g.pauses.slice(-2), [true, false], '暂停和播放照跟');

  r.eng('h1').userSeek(300);
  r.flush();
  assert.deepEqual(g.seeks, [300], '跳转照跟，否则房主跳到下一段他还留在原地');
});

impl('完全同步的成员收到房主暂停时照旧对齐位置', async (dir) => {
  const r = await linkRoom(dir, [{ id: 'gst', role: 'guest', mode: 'full' }]);
  await r.play();
  r.advance(40);
  r.place('h1', { position: 40 });
  r.place('gst', { position: 28 });
  r.eng('h1').userSetPaused(true);
  r.flush();
  assert.equal(r.node('gst').seeks.length, 1);
  assert.ok(near(r.node('gst').seeks[0], 40));
});

impl('手动同步的管理员按暂停：报房间的位置，不把全房拽回他落后的地方；拖进度条照样报自己的', async (dir) => {
  const r = await linkRoom(dir, [
    { id: 'adm', role: 'admin', mode: 'manual' },
    { id: 'gst', role: 'guest', mode: 'full' },
  ]);
  await r.play();
  r.advance(40);
  r.place('adm', { position: 25 });
  r.place('gst', { position: 40 });
  r.advance(0.2);
  r.tick('adm', { position: 25.2, paused: true }); // 在 mpv 里按了空格
  r.flush();
  const sent = syncs(r.node('adm'));
  assert.equal(sent.length, 1);
  assert.ok(near(sent[0].position, 40.2), `报出去的位置 ${sent[0].position}`);
  assert.deepEqual(r.node('gst').seeks, [], '别人不被拽回 25 秒');

  await settle();
  r.advance(1);
  r.tick('adm', { position: 400, paused: true }); // 拖进度条
  r.flush();
  assert.equal(syncs(r.node('adm')).at(-1).position, 400);
  assert.deepEqual(r.node('gst').seeks, [400]);

  // 界面上点播放也一样
  await settle();
  r.place('adm', { position: 380, paused: true });
  r.eng('adm').userSetPaused(false);
  assert.equal(syncs(r.node('adm')).at(-1).position, 400);
});

impl('「同步到房主」把自己单独按的暂停也一并对回房间；本地文件不适用', async (dir) => {
  const r = await linkRoom(dir, [{ id: 'gst', role: 'guest', mode: 'manual' }]);
  await r.play();
  const g = r.node('gst');
  g.eng.userSetPaused(true);
  await settle();
  r.advance(20);
  r.place('gst', { position: 3, paused: true });
  assert.equal(g.eng.syncToRoom(), true);
  assert.equal(g.eng.intendedPaused, false);
  await settle();
  assert.equal(g.pauses.at(-1), false);
  assert.ok(near(g.seeks.at(-1), 20));

  const file = await linkRoom(dir, [{ id: 'gst', role: 'guest' }], { streaming: false });
  file.place('gst', { position: 1 });
  assert.equal(file.eng('gst').syncToRoom(), false);
});

impl('换片时差值和提前量都清掉，跟随方式留给上层重新设', async (dir) => {
  const r = await linkRoom(dir, [{ id: 'gst', role: 'guest', mode: 'manual' }]);
  await r.play();
  const g = r.node('gst');
  r.advance(40);
  checkTwice(r, 'gst', () => 20);
  g.eng._seekLead = 3;
  assert.equal(g.eng.driftStatus().state, 'out');
  g.eng.resetMedia({ seq: 2, isSeeder: true });
  assert.equal(g.eng.driftStatus().state, 'ok');
  assert.equal(g.eng._seekLead, 0);
  assert.equal(g.eng.followMode, 'manual');
});

/* ------------------------------ 主进程：mpv ------------------------------ */

test('mpv 多观察 paused-for-cache，快照里带 pausedForCache', () => {
  const { MpvController, OBSERVED } = require('../src/main/mpv');
  assert.ok(OBSERVED.includes('paused-for-cache'));
  const ctl = new MpvController();
  assert.equal(ctl.snapshot().pausedForCache, false);
  ctl._onData(JSON.stringify({ event: 'property-change', name: 'paused-for-cache', data: true }) + '\n');
  assert.equal(ctl.snapshot().pausedForCache, true);
});

test('在线链接缓冲时攒够 5 秒才接着放；本地文件不加这一项', () => {
  const { buildLaunchArgs, REMOTE_CACHE_PAUSE_WAIT } = require('../src/main/mpv');
  assert.equal(REMOTE_CACHE_PAUSE_WAIT, 5);
  const remote = buildLaunchArgs({ ipcPath: 'x', source: 'https://v.example/a.mp4' });
  assert.ok(remote.includes('--cache-pause-wait=5'));
  assert.ok(remote.indexOf('--cache-pause-wait=5') < remote.indexOf('--'), '选项必须在 -- 之前');
  const local = buildLaunchArgs({ ipcPath: 'x', source: 'D:/a.mkv' });
  assert.ok(!local.some((a) => a.startsWith('--cache-pause-wait')));
});

test('mpv 里按 Ctrl+Shift+S：client-message 变成 sync-request，别的消息不认', () => {
  const { MpvController, SYNC_MESSAGE_NAME } = require('../src/main/mpv');
  assert.equal(SYNC_MESSAGE_NAME, 'noxreel-sync');
  const ctl = new MpvController();
  const got = [];
  ctl.on('sync-request', (p) => got.push(p));
  const feed = (args) => ctl._onData(JSON.stringify({ event: 'client-message', args }) + '\n');
  feed([SYNC_MESSAGE_NAME]);
  feed(['noxreel-chat', '弹幕']);
  feed(['some-other-script']);
  feed(null);
  assert.deepEqual(got, [{}]);
});

test('Lua 脚本注册 Ctrl+Shift+S 三种写法，放在 mp.input 探测前面（旧版 mpv 也能用）', () => {
  const { SYNC_MESSAGE_NAME } = require('../src/main/mpv');
  const lua = read('resources', 'mpv-scripts', 'noxreel-chat.lua');
  const keys = lua.slice(lua.indexOf('SYNC_KEYS = {'), lua.indexOf('}', lua.indexOf('SYNC_KEYS = {')));
  for (const key of ["'Ctrl+Shift+s'", "'Ctrl+Shift+S'", "'Ctrl+S'"]) assert.ok(keys.includes(key), '少注册了一种写法：' + key);
  assert.ok(!keys.includes("'Ctrl+s'"), 'Ctrl+s（小写）是 mpv 默认的窗口截图，别抢');
  assert.ok(lua.includes(`SYNC_MESSAGE_NAME = '${SYNC_MESSAGE_NAME}'`), '脚本和主进程约的是同一个消息名');
  assert.ok(lua.includes("mp.commandv('script-message', SYNC_MESSAGE_NAME)"));
  const bindAt = lua.indexOf('mp.add_key_binding(key, SYNC_MESSAGE_NAME');
  assert.ok(bindAt > 0);
  assert.ok(bindAt < lua.indexOf('if not ok or type(input)'), '要在版本探测之前注册，否则旧版 mpv 上没有这个键');
});

test('sync-request 从 mpv 适配器经播放器管理器按代际转给渲染进程，preload 暴露 onSyncRequest', async () => {
  const { MpvAdapter } = require('../src/main/players/mpvAdapter');
  const adapter = new MpvAdapter();
  const got = [];
  adapter.on('sync-request', (p) => got.push(p));
  adapter.ctl.emit('sync-request', {});
  assert.deepEqual(got, [{}]);

  const { PlayerManager } = require('../src/main/players');
  const made = [];
  class FakeAdapter extends EventEmitter {
    constructor() {
      super();
      this.caps = {};
      made.push(this);
    }
    async launch() {
      return { bin: 'fake' };
    }
    async quit() {}
  }
  const sent = [];
  const mgr = new PlayerManager({ send: (ch, p) => sent.push([ch, p]), adapters: { fake: FakeAdapter } });
  const info = await mgr.launch('fake', {});
  made[0].emit('sync-request', {});
  assert.deepEqual(sent.at(-1), ['player:sync-request', { gen: info.gen, kind: 'fake' }]);
  await mgr.launch('fake', {});
  sent.length = 0;
  made[0].emit('sync-request', {});
  assert.deepEqual(sent, [], '上一代播放器迟到的一下不算数');

  // 换代时旧适配器的监听器会被摘掉，行为上测不出少了 fromCurrent —— 和弹幕那条一样钉住写法
  assert.match(read('src', 'main', 'players', 'index.js'), /adapter\.on\(\s*'sync-request',\s*fromCurrent\(/);
  const preload = read('src', 'main', 'preload.js');
  assert.match(preload, /onSyncRequest: on\('player:sync-request'\)/);
});

/* ------------------------------ app.js ------------------------------ */

function fnSource(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层函数 ${name}`);
  const end = APP.indexOf('\n}\n', m.index);
  return APP.slice(m.index, end + 2);
}

function declSource(name) {
  const m = new RegExp(`^(?:let|const) ${name} = [^\\n]+;$`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层声明 ${name}`);
  return m[0];
}

function el(id) {
  const classes = new Set();
  return {
    id,
    textContent: '',
    value: '',
    classes,
    classList: {
      toggle(c, on) {
        const want = on === undefined ? !classes.has(c) : !!on;
        if (want) classes.add(c);
        else classes.delete(c);
        return want;
      },
      contains: (c) => classes.has(c),
    },
  };
}

function driftUi({ drift, host = false, mpvRunning = true, sourceType = 'link', linkSync = 'manual' } = {}) {
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, el(id));
    return nodes.get(id);
  };
  const rows = [];
  const osd = [];
  const S = {
    sourceType,
    mpvRunning,
    settings: { linkSync },
    sync: { driftStatus: () => ({ ...drift }) },
  };
  const sources = [
    ...['driftKey', 'driftOsdState', 'driftOsdAt', 'DRIFT_OSD_REPEAT_MS'].map(declSource),
    ...['renderDrift', 'renderSyncModeControl', 'driftShown', 'driftRefName', 'driftText', 'linkFollowMode'].map(fnSource),
  ];
  const ctx = { S, $, roomEntered: true, Date };
  Object.assign(ctx, {
    isRoomHost: () => host,
    updateStripTone: () => {},
    t: (s) => `«${s}»`,
    make: (tag, o = {}) => ({ tag, ...o }),
    replace: (node, ...kids) => rows.push({ node: node.id, kids: kids.map((k) => k.text) }),
    window: { sw: { player: { osd: (text, ms) => (osd.push([text, ms]), Promise.resolve()) } } },
  });
  vm.createContext(ctx);
  vm.runInContext(sources.join('\n\n'), ctx, { filename: 'app.js（节选）' });
  return { ctx, $, S, rows, osd };
}

test('状态带：手动同步没对上时一行「你比房主慢 12 秒」+「同步到房主」，mpv 画面上说一声（过 t()）', () => {
  const ui = driftUi({ drift: { state: 'out', seconds: -12, mode: 'manual', streaming: true } });
  ui.ctx.renderDrift();
  assert.equal(ui.$('drift-row').classes.has('hidden'), false);
  assert.equal(ui.$('btn-sync-now').classes.has('hidden'), false);
  assert.equal(ui.$('btn-sync-now').textContent, '同步到房主');
  assert.deepEqual(ui.rows.at(-1), { node: 'drift-row', kids: ['手动同步', '你比房主慢 12 秒'] });
  assert.deepEqual(ui.osd, [['«你比房主慢 12 秒» · «按 Ctrl+Shift+S 同步»', 4000]]);

  ui.ctx.renderDrift();
  assert.equal(ui.rows.length, 1, '没变就不碰 DOM（renderStatus 每个 tick 都会调）');
  assert.equal(ui.osd.length, 1);

  assert.equal(ui.ctx.driftText(3), '你比房主快 3 秒');
});

test('状态带：同步失败时说「自动同步没跟上」，建议改成手动同步；房主跟的是房间进度', () => {
  const ui = driftUi({ drift: { state: 'failed', seconds: -9, mode: 'full', streaming: true } });
  ui.ctx.renderDrift();
  assert.deepEqual(ui.rows.at(-1).kids, ['自动同步没跟上', '你比房主慢 9 秒', '网速跟不上的话，可以把同步方式改成「手动同步」']);

  const host = driftUi({ host: true, drift: { state: 'failed', seconds: 4, mode: 'full', streaming: true } });
  host.ctx.renderDrift();
  assert.deepEqual(host.rows.at(-1).kids, ['自动同步没跟上', '你比房间进度快 4 秒'], '房主没得选，不建议他改方式');
  assert.equal(host.$('btn-sync-now').textContent, '同步到房间进度');
  assert.equal(host.$('sync-mode-box').classes.has('hidden'), true, '房主看不到同步方式');
});

test('状态带：对上了、播放器没开、不是在线链接时都不显示；同步方式只在在线链接出现', () => {
  for (const opts of [
    { drift: { state: 'ok', seconds: 0, streaming: true } },
    { drift: { state: 'out', seconds: -5, streaming: true }, mpvRunning: false },
    { drift: { state: 'out', seconds: -5, streaming: true }, sourceType: 'file' },
  ]) {
    const ui = driftUi(opts);
    ui.ctx.renderDrift();
    assert.equal(ui.$('drift-row').classes.has('hidden'), true, JSON.stringify(opts));
    assert.equal(ui.$('btn-sync-now').classes.has('hidden'), true);
    assert.deepEqual(ui.osd, []);
    assert.equal(ui.$('sync-mode-box').classes.has('hidden'), opts.sourceType === 'file');
  }
  const ui = driftUi({ drift: { state: 'ok', seconds: 0, streaming: true }, linkSync: 'manual' });
  ui.ctx.renderDrift();
  assert.equal(ui.$('sync-mode').value, 'manual');
});

test('改同步方式：存进本机、交给引擎；房主永远是完全同步', () => {
  const store = new Map();
  const follow = [];
  const logs = [];
  const S = { settings: { linkSync: 'full' }, sync: { setFollow: (o) => follow.push(o) }, swarm: null };
  let host = false;
  const ctx = {
    S,
    localStorage: { setItem: (k, v) => store.set(k, v) },
    isRoomHost: () => host,
    log: (text) => logs.push(text),
    renderStatus: () => {},
    renderProgress: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(['setLinkSyncMode', 'linkFollowMode'].map(fnSource).join('\n\n'), ctx);
  ctx.setLinkSyncMode('manual');
  assert.equal(S.settings.linkSync, 'manual');
  assert.equal(store.get('sw.linkSync'), 'manual');
  assert.deepEqual(JSON.parse(JSON.stringify(follow)), [{ mode: 'manual' }]);
  assert.match(logs[0], /手动同步/);
  ctx.setLinkSyncMode('manual');
  assert.equal(follow.length, 1, '没变不重复设');
  ctx.setLinkSyncMode('<script>');
  assert.equal(S.settings.linkSync, 'full', '认不出的值一律当完全同步');

  S.settings.linkSync = 'manual';
  host = true;
  assert.equal(ctx.linkFollowMode(), 'full');

  // 启动时从本机读：只认 manual，其余都是完全同步
  assert.match(APP, /linkSync: localStorage\.getItem\('sw\.linkSync'\) === 'manual' \? 'manual' : 'full'/);
});

test('换片后把「是不是在线链接」和跟随方式交给引擎；每秒核对只在在线链接且播放器开着时跑', () => {
  const at = APP.indexOf('S.sync.resetMedia({');
  const after = APP.slice(at, at + 400);
  assert.match(after, /S\.sync\.setFollow\(\{ streaming: item\?\.kind === 'link', mode: linkFollowMode\(\) \}\)/);

  const calls = [];
  const S = { sync: { checkDrift: () => calls.push(1) }, sourceType: 'link', mpvRunning: true, switchingMedia: false };
  const ctx = { S };
  vm.createContext(ctx);
  vm.runInContext(fnSource('driftTick'), ctx);
  ctx.driftTick();
  S.mpvRunning = false;
  ctx.driftTick();
  S.mpvRunning = true;
  S.sourceType = 'file';
  ctx.driftTick();
  assert.equal(calls.length, 1);
  assert.match(APP, /setInterval\(driftTick, 1000\)/);
});

test('「同步到房主」按钮和 Ctrl+Shift+S 走同一个入口，只对在线链接生效', () => {
  const logs = [];
  const osd = [];
  let synced = 0;
  const S = { sourceType: 'link', sync: { syncToRoom: () => (synced++, true) } };
  const ctx = {
    S,
    roomEntered: true,
    isRoomHost: () => false,
    log: (text) => logs.push(text),
    t: (s) => `«${s}»`,
    window: { sw: { player: { osd: (text) => (osd.push(text), Promise.resolve()) } } },
  };
  vm.createContext(ctx);
  vm.runInContext(fnSource('syncToHost'), ctx);
  ctx.syncToHost();
  assert.equal(synced, 1);
  assert.deepEqual(logs, ['已同步到房主的进度']);
  assert.deepEqual(osd, ['«已同步到房主的进度»']);
  S.sourceType = 'file';
  ctx.syncToHost();
  assert.equal(synced, 1);

  assert.match(APP, /\$\('btn-sync-now'\)\.onclick = syncToHost;/);
  // 差值变了要连横幅一起换（「播放中，但你和房主没对上」），只画那一行的话横幅要等下一次 tick
  assert.match(APP, /S\.sync\.on\('drift', renderStatus\);/);
  assert.match(APP, /banner\.className = driftShown\(\) \? 'status-banner waiting' : 'status-banner playing';/, '没对上时横幅用提醒的黄色');
  assert.match(APP, /window\.sw\.player\.onSyncRequest\?\.\(\(\) => syncToHost\(\)\)/);
  assert.match(APP, /\$\('sync-mode'\)\.onchange = \(\) => setLinkSyncMode\(\$\('sync-mode'\)\.value\)/);
});

test('房间页有同步方式下拉框、差值那一行和「同步到房主」按钮', () => {
  const html = read('src', 'renderer', 'index.html');
  assert.match(html, /id="sync-mode-box"/);
  assert.match(html, /<option value="full">完全同步<\/option>/);
  assert.match(html, /<option value="manual">手动同步<\/option>/);
  assert.match(html, /class="drift-row hidden" id="drift-row"/);
  assert.match(html, /id="btn-sync-now">同步到房主</);
});

test('新文案都有英文，差多少秒的动态模板也翻得对', async () => {
  const { translate } = await import(pathToFileURL(path.join(root, 'src', 'renderer', 'lib', 'i18n.js')).href);
  const html = read('src', 'renderer', 'index.html');
  const tip = /id="sync-mode-box"\s+title="([^"]+)"/.exec(html)[1];
  for (const zh of [
    tip,
    '同步',
    '同步方式',
    '完全同步',
    '手动同步',
    '同步到房主',
    '同步到房间进度',
    '自动同步没跟上',
    '网速跟不上的话，可以把同步方式改成「手动同步」',
    '按 Ctrl+Shift+S 同步',
    '播放中，但你和房主没对上',
    '播放中，但你和房间进度没对上',
    '已同步到房主的进度',
    '已同步到房间进度',
    '改成手动同步：缓冲慢了不再把你拽走，和房主差开时提示差多少秒',
    '改成完全同步：一直跟房主对齐，差开了自动跳过去',
    '大家以你的进度为准',
    '手动同步，差开了只提示',
    '完全同步，差开了自动对齐',
    '你缓冲时全员等你',
    '各自的 mpv 管，只卡自己',
  ]) {
    const en = translate(zh, 'en');
    assert.notEqual(en, zh, `没有英文：${zh}`);
    assert.doesNotMatch(en, /[\u4e00-\u9fff]/, `英文里还有中文：${zh} → ${en}`);
  }
  assert.equal(translate('你比房主慢 12 秒', 'en'), 'You are 12 seconds behind the host');
  assert.equal(translate('你比房主快 1 秒', 'en'), 'You are 1 second ahead of the host');
  assert.equal(translate('你比房间进度慢 3 秒', 'en'), 'You are 3 seconds behind the room');
  assert.equal(translate('和房主差了 5.0 秒，自动对齐', 'en'), '5.0 seconds off from the host; realigned automatically');
  assert.equal(translate('和房间进度差了 2.5 秒，自动对齐', 'en'), '2.5 seconds off from the room; realigned automatically');
});

/* ------------------------------ 安卓端 ------------------------------ */

const ANDROID = path.join('android', 'app', 'src', 'main');
const APP_ANDROID = read(ANDROID, 'assets', 'js', 'app-android.js');

test('安卓：ExoPlayer 的 STATE_BUFFERING 报成 buffering，暂停着也照算', () => {
  const kt = read(ANDROID, 'java', 'com', 'syncwatch', 'app', 'SyncPlayer.kt');
  assert.match(kt, /\.put\("buffering", s\.state == Player\.STATE_BUFFERING\)/);
  assert.doesNotMatch(kt, /"buffering", s\.playWhenReady/, '引擎让全房等时会把它暂停，只看「让它播时在缓冲」就会当场放开、一走一停');
});

test('安卓：换片后交出跟随方式，快照的 buffering 当 paused-for-cache，在线链接走 streaming 那条卡顿判断', () => {
  const at = APP_ANDROID.indexOf('S.sync.resetMedia({');
  assert.match(APP_ANDROID.slice(at, at + 300), /S\.sync\.setFollow\(\{ streaming: item\?\.kind === 'link', mode: S\.linkSync \}\)/);
  assert.match(APP_ANDROID, /pausedForCache: snap\.buffering === true,/);
  assert.match(APP_ANDROID, /if \(S\.sync\.streaming\) S\.sync\._evaluateStreamStall\(S\.sync\.lastTick\);\s*else \{\s*S\.sync\._evaluateStall\(/);
  assert.match(APP_ANDROID, /linkSync: localStorage\.getItem\('sw\.linkSync'\) === 'manual' \? 'manual' : 'full'/);
  assert.match(APP_ANDROID, /S\.sync\.on\('drift', renderDrift\)/);
  assert.match(APP_ANDROID, /if \(S\.sync && S\.sourceType === 'link' && S\.playerTimer\) S\.sync\.checkDrift\(\);/);
});

function androidFn(name) {
  const m = new RegExp(`^function ${name}\\(`, 'm').exec(APP_ANDROID);
  assert.ok(m, `app-android.js 里没找到 ${name}`);
  return APP_ANDROID.slice(m.index, APP_ANDROID.indexOf('\n}\n', m.index) + 2);
}

test('安卓：顶栏按钮只在在线链接出现，差开时那一条带「同步到房主」，没变不碰 DOM', () => {
  const nodes = new Map();
  let writes = 0;
  const $ = (id) => {
    if (!nodes.has(id)) {
      const node = { style: { display: 'none' } };
      let text = '';
      Object.defineProperty(node, 'textContent', {
        get: () => text,
        set: (v) => {
          writes++;
          text = v;
        },
      });
      nodes.set(id, node);
    }
    return nodes.get(id);
  };
  let drift = { state: 'out', seconds: -7, streaming: true };
  const S = { sourceType: 'link', playerTimer: 1, linkSync: 'manual', sync: { driftStatus: () => drift } };
  const ctx = { S, $, show: (node, on) => (node.style.display = on ? '' : 'none') };
  vm.createContext(ctx);
  vm.runInContext(['let driftKey = null;', androidFn('driftText'), androidFn('renderDrift')].join('\n\n'), ctx);
  ctx.renderDrift();
  assert.equal($('btn-follow').style.display, '');
  assert.equal($('btn-follow').textContent, '手动同步');
  assert.equal($('drift').style.display, '');
  assert.equal($('drift-kind').textContent, '手动同步');
  assert.equal($('drift-text').textContent, '你比房主慢 7 秒');
  const before = writes;
  ctx.renderDrift();
  assert.equal(writes, before, '每秒都会调到，没变就不碰 DOM（否则自动翻译每秒重来一遍）');

  drift = { state: 'failed', seconds: -9, streaming: true };
  ctx.renderDrift();
  assert.equal($('drift-kind').textContent, '自动同步没跟上');
  assert.equal($('drift-text').textContent, '你比房主慢 9 秒');

  S.sourceType = 'file';
  ctx.renderDrift();
  assert.equal($('btn-follow').style.display, 'none');
  assert.equal($('drift').style.display, 'none');
});

test('安卓：切换方式存本机、交给引擎；「同步到房主」只对在线链接', () => {
  assert.match(APP_ANDROID, /localStorage\.setItem\('sw\.linkSync', S\.linkSync\);\s*S\.sync\?\.setFollow\(\{ mode: S\.linkSync \}\);/);
  assert.match(APP_ANDROID, /if \(S\.sourceType === 'link' && S\.sync\?\.syncToRoom\(\)\) log\('已同步到房主的进度', 'good'\);/);
  const html = read(ANDROID, 'assets', 'index.html');
  assert.match(html, /<button id="btn-follow" style="display:none"/);
  assert.match(html, /<div id="drift" style="display:none">/);
  assert.match(html, /<button id="drift-sync">同步到房主<\/button>/);
});

test('安卓：新文案都有英文，差多少秒的模板也翻得对', async () => {
  const { translate } = await import(pathToFileURL(path.join(root, ANDROID, 'assets', 'js', 'i18n.js')).href);
  const html = read(ANDROID, 'assets', 'index.html');
  const tip = /id="btn-follow" style="display:none" title="([^"]+)"/.exec(html)[1];
  for (const zh of [
    tip,
    '完全同步',
    '手动同步',
    '同步到房主',
    '自动同步没跟上',
    '已同步到房主的进度',
    '改成手动同步：缓冲慢了不再把你拽走，和房主差开时提示差多少秒',
    '改成完全同步：一直跟房主对齐，差开了自动跳过去',
  ]) {
    const en = translate(zh, 'en');
    assert.notEqual(en, zh, `没有英文：${zh}`);
    assert.doesNotMatch(en, /[一-鿿]/, `英文里还有中文：${zh} → ${en}`);
  }
  assert.equal(translate('你比房主慢 7 秒', 'en'), 'You are 7 seconds behind the host');
  assert.equal(translate('你比房主快 1 秒', 'en'), 'You are 1 second ahead of the host');
  assert.equal(translate('和房主差了 3.0 秒，自动对齐', 'en'), '3.0 seconds off from the host; realigned automatically');
});
