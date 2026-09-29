'use strict';

// 同步引擎的正确性（修复批次 5）：
//  - 游客落后于房间时被提升为管理员，第一次播放/暂停不能把全房拽回他的位置（A3-1）；
//  - 播放器（重新）起来时补放的位置按房间时钟算，不把房间卡住的时间也算成在播（A3-2）；
//  - 安全模式下没收完、又不是片源的人不因为自己缓冲不足让全房等（GG3-2）；
//  - 房主替断开的人转发的 release 只撤销经房主这条路径得知的卡顿（A3-6）；
//  - 游客自己缓冲不足时横幅不说「全员暂停」（A3-5，桌面 app.js 的 renderStatus）。
// 引擎用例对桌面和安卓两份共享库各跑一遍。全程假时钟、假网络、假播放器，不出声。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { IMPLS } = require('./helpers/impls');

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;
// 等引擎的回声窗口（APPLY_ECHO_MS = 250）全部关掉，之后的 tick 才会被当成用户操作来比对
const settle = () => sleep(300);

/**
 * 假网络 + 假播放器。outbound 发给所有连着的人，relay 按 app.js 的规则转发（不发回给发送者、不发给原作者）；
 * 消息过一遍 JSON。每台引擎挂一个假播放器：running 为假时引擎看不到 lastTick（播放器还没起来）。
 */
async function makeNet(dir, { hostId = 'h1' } = {}) {
  const { SyncEngine } = await import(dir + 'syncEngine.js');
  const net = { clock: { t: 1000 }, nodes: new Map(), links: new Set(), queue: [] };
  const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  net.linked = (a, b) => net.links.has(key(a, b));
  const peersOf = (id) => [...net.nodes.keys()].filter((p) => p !== id && net.linked(id, p));
  const send = (from, to, msg) => {
    if (net.linked(from, to)) net.queue.push({ from, to, msg: JSON.parse(JSON.stringify(msg)) });
  };
  net.add = (peerId, { roles = [], isSeeder = true, playAfterComplete = false } = {}) => {
    const eng = new SyncEngine({ peerId, name: peerId, isSeeder, hostId, playAfterComplete });
    eng.now = () => net.clock.t;
    const player = { position: 0, paused: true };
    const node = { id: peerId, eng, player, out: [], seeks: [] };
    eng.onSeek = (p) => {
      node.seeks.push(p);
      player.position = p;
    };
    eng.onSetPause = (p) => {
      player.paused = p;
    };
    eng.on('outbound', (m) => {
      node.out.push(m);
      for (const p of peersOf(peerId)) send(peerId, p, m);
    });
    eng.on('relay', ({ msg, except }) => {
      for (const p of peersOf(peerId)) if (p !== except && p !== msg.origin) send(peerId, p, msg);
    });
    eng.applyRoles(roles, hostId);
    eng.started = true;
    net.nodes.set(peerId, node);
    return node;
  };
  net.connect = (a, b) => net.links.add(key(a, b));
  net.connectAll = () => {
    const ids = [...net.nodes.keys()];
    for (const a of ids) for (const b of ids) if (a < b) net.connect(a, b);
  };
  net.flush = () => {
    while (net.queue.length) {
      const { from, to, msg } = net.queue.shift();
      if (net.linked(from, to)) net.nodes.get(to).eng.onCtrl(msg, { peerId: from, name: from });
    }
  };
  /** 断线：在途消息丢掉，两边各自 peerGone。 */
  net.disconnect = (a, b) => {
    net.links.delete(key(a, b));
    net.queue = net.queue.filter((q) => key(q.from, q.to) !== key(a, b));
    net.nodes.get(a).eng.peerGone(b);
    net.nodes.get(b).eng.peerGone(a);
  };
  /** 播放器推一条 tick。不给位置就报假播放器自己的位置。 */
  net.tick = (node, position = node.player.position, paused = node.player.paused) => {
    node.player.position = position;
    node.player.paused = paused;
    node.eng.onMpvTick({ position, paused, duration: 7200, sampledAt: net.clock.t }, { complete: true });
  };
  return net;
}

/** 房主 h1 开播；g1 是游客（文件模式，两边都有完整文件，播放器都开着）。 */
async function guestBehindRoom(dir) {
  const net = await makeNet(dir);
  const roles = [['g1', 'guest']];
  const h = net.add('h1', { roles });
  const g = net.add('g1', { roles });
  net.connectAll();
  g.eng.resetMedia({ seq: 1 });
  h.eng.resetMedia({ seq: 1, broadcast: true });
  net.flush();
  net.tick(h, 0, true);
  net.tick(g, 0, true);
  await settle();
  h.eng.userSetPaused(false);
  net.flush();
  await settle();
  net.clock.t += 100_000;
  net.tick(h, 100, false);
  net.tick(g, 100, false);
  // 游客在界面上按暂停：只停他自己
  g.eng.userSetPaused(true);
  net.flush();
  await settle();
  net.tick(g, 100, true);
  net.clock.t += 600_000;
  net.tick(h, 700, false);
  return { net, h, g };
}

/* ---------------------------------- A3-1 ---------------------------------- */

impl('A3-1 游客落后于房间时被提升为管理员：先对齐房间，第一次暂停不会把全房拽回他的位置', async (dir) => {
  const { net, h, g } = await guestBehindRoom(dir);
  // 游客自己按播放：从停下的地方接着放（不回到房间位置），此时落后房间 600 秒
  g.eng.userSetPaused(false);
  net.flush();
  await settle();
  net.tick(g, 100, false);
  assert.ok(near(h.eng.sharedPositionNow(), 700));
  assert.ok(near(g.eng.playerPositionNow(), 100));

  g.seeks.length = 0;
  h.eng.setRole('g1', 'admin');
  net.flush();
  assert.equal(g.eng.canIControl(), true);
  assert.equal(g.seeks.length, 1, '升为管理员时没有把播放器对齐到房间');
  assert.ok(near(g.seeks[0], 700), `应跳到房间的 700 秒，实际 ${g.seeks[0]}`);
  assert.equal(g.eng.intendedPaused, false);

  await settle();
  net.tick(g); // 跳转落地（回声）
  net.clock.t += 5000;
  net.tick(g, 705, false);
  net.tick(h, 705, false);
  await settle();
  h.seeks.length = 0;
  g.eng.userSetPaused(true);
  net.flush();
  assert.equal(h.eng.shared.paused, true);
  assert.ok(near(h.eng.shared.position, 705, 1), `全房被拽到了 ${h.eng.shared.position}`);
  assert.ok(h.seeks.every((p) => p > 600), `房主的播放器被拽回去了：${JSON.stringify(h.seeks)}`);
});

impl('A3-1 被提升时还自己暂停着：暂停状态回到房间的，之后按暂停报的是房间的位置', async (dir) => {
  const { net, h, g } = await guestBehindRoom(dir);
  assert.equal(g.eng.intendedPaused, true, '游客自己暂停着');
  assert.equal(h.eng.shared.paused, false, '房间在播');

  h.eng.setRole('g1', 'admin');
  net.flush();
  assert.equal(g.eng.intendedPaused, false, '成为控制者后暂停状态要跟房间一致');
  await settle();
  assert.equal(g.player.paused, false);
  assert.ok(near(g.player.position, 700), `播放器应落在房间的 700 秒，实际 ${g.player.position}`);

  net.tick(g);
  await settle();
  g.eng.userSetPaused(true);
  net.flush();
  assert.ok(near(h.eng.shared.position, 700, 1), `全房被拽到了 ${h.eng.shared.position}`);
});

impl('A3-1 播放器没开着时被提升：不跳转，也不留下待补的位置（起来时本来就从房间位置起播）', async (dir) => {
  const { net, h, g } = await guestBehindRoom(dir);
  g.eng.forgetPlayerState();
  g.seeks.length = 0;
  h.eng.setRole('g1', 'admin');
  net.flush();
  assert.deepEqual(g.seeks, []);
  assert.equal(g.eng.pendingSeek, null);
  assert.equal(g.eng.intendedPaused, false);
});

impl('A3-1 在线链接手动同步的人被提升：和房间差着是他自己留的，不去动他', async (dir) => {
  const { net, h, g } = await guestBehindRoom(dir);
  g.eng.setFollow({ streaming: true, mode: 'manual' });
  g.seeks.length = 0;
  h.eng.setRole('g1', 'admin');
  net.flush();
  assert.deepEqual(g.seeks, [], '手动同步的人被拽走了');
  assert.equal(g.eng.intendedPaused, true);
});

/* ---------------------------------- A3-2 ---------------------------------- */

impl('A3-2 播放器没起来时收到播放指令，之后别的控制者卡了一分钟：起来后落在房间此刻的位置', async (dir) => {
  const net = await makeNet(dir);
  const roles = [['a1', 'admin'], ['g1', 'guest']];
  const h = net.add('h1', { roles });
  const a = net.add('a1', { roles, isSeeder: false });
  const g = net.add('g1', { roles, isSeeder: false });
  net.connectAll();
  for (const n of [a, g]) n.eng.resetMedia({ seq: 1 });
  h.eng.resetMedia({ seq: 1, broadcast: true });
  net.flush();
  h.eng.userSetPaused(false);
  net.flush();
  assert.equal(g.eng.pendingSeek, 0, '播放器还没起来，位置先记着');

  net.clock.t += 10_000;
  a.eng.onBufferProgress({ contiguousBytes: 0, runBytes: 0, complete: false }); // 管理员卡住，全房停
  net.flush();
  net.clock.t += 60_000;
  a.eng.onBufferProgress({ contiguousBytes: 1e12, runBytes: 1e12, complete: false }); // 攒够了
  net.flush();
  net.clock.t += 5000;
  const room = h.eng.sharedPositionNow();
  assert.ok(near(room, 15), `房间应在 15 秒，实际 ${room}`);

  // launchPlayer：先 resyncToShared（这时还没有 tick），再由第一条 tick 落地
  await g.eng.resyncToShared();
  net.tick(g, 0, true);
  await sleep(10);
  assert.ok(g.seeks.length >= 1);
  assert.ok(near(g.seeks.at(-1), 15), `应落在房间的 15 秒，实际 ${g.seeks.at(-1)}（卡住的 60 秒被算成在播了）`);
});

impl('A3-2 可信房间中途加入的管理员自己缓冲不足让全房等：攒够后起来不跳到房间前面', async (dir) => {
  const net = await makeNet(dir);
  const roles = [['a1', 'admin']];
  const h = net.add('h1', { roles });
  const a = net.add('a1', { roles, isSeeder: false });
  net.connectAll();
  a.eng.resetMedia({ seq: 1 });
  h.eng.resetMedia({ seq: 1, position: 600, broadcast: true });
  net.flush();
  h.eng.userSetPaused(false);
  net.flush();

  // 中途加入：从房间位置起一片都没有，当场卡住（房间时钟跟着停）
  a.eng.onBufferProgress({ contiguousBytes: 8e6, runBytes: 0, complete: false });
  net.flush();
  assert.equal(h.eng.roomStalled, true);
  net.clock.t += 45_000;
  a.eng.onBufferProgress({ contiguousBytes: 8e6, runBytes: 1e12, complete: false });
  net.flush();
  net.clock.t += 2000;
  const room = h.eng.sharedPositionNow();
  assert.ok(near(room, 602), `房间应在 602 秒，实际 ${room}`);

  await a.eng.resyncToShared();
  net.clock.t += 500;
  net.tick(a, 600, true); // 播放器按 startAt 起在 600，第一条 tick
  await sleep(10);
  const landed = a.seeks.at(-1) ?? a.player.position;
  assert.ok(near(landed, h.eng.sharedPositionNow(), 0.6), `管理员落在 ${landed}，房间在 ${h.eng.sharedPositionNow()}`);
  assert.ok(landed < 610, `跳到了房间前面：${landed}（把自己让全房等的 45 秒也算进去了）`);
});

impl('A3-2 等待期间没人卡：照旧补上房间播过的那段', async (dir) => {
  const net = await makeNet(dir);
  const roles = [['g1', 'guest']];
  const h = net.add('h1', { roles });
  const g = net.add('g1', { roles, isSeeder: false });
  net.connectAll();
  g.eng.resetMedia({ seq: 1 });
  h.eng.resetMedia({ seq: 1, broadcast: true });
  net.flush();
  h.eng.userSetPaused(false);
  net.flush();
  net.clock.t += 20_000;
  await g.eng.resyncToShared();
  net.tick(g, 0, true);
  await sleep(10);
  assert.ok(near(g.seeks.at(-1), 20), `应补到 20 秒，实际 ${g.seeks.at(-1)}`);
});

/* ---------------------------------- GG3-2 --------------------------------- */

impl('GG3-2 安全模式下没收完的房主（不是片源）：缓冲不足不喊停，「仍然开始」之后房间照常走', async (dir) => {
  const net = await makeNet(dir);
  const roles = [['a1', 'admin']];
  // 管理员 a1 加的片，他是片源；房主 h1 还在收，收完、扫描过才会开播放器
  const h = net.add('h1', { roles, isSeeder: false, playAfterComplete: true });
  const a = net.add('a1', { roles, isSeeder: true, playAfterComplete: true });
  net.connectAll();
  a.eng.resetMedia({ seq: 1, isSeeder: true });
  h.eng.resetMedia({ seq: 1, isSeeder: false, broadcast: true });
  net.flush();
  const margins = [];
  h.eng.on('margin', (m) => margins.push(m));
  h.eng.onBufferProgress({ contiguousBytes: 0, runBytes: 0, complete: false });
  net.flush();
  assert.equal(h.eng.localStalled, false, '收完才播的人不该因为自己缓冲不足卡住');
  assert.equal(h.out.filter((m) => m.t === 'stall').length, 0, '广播了 STALL，全房被他拖停');
  assert.equal(margins.length, 1, '余量照样报给界面');

  a.eng.userSetPaused(false); // 仍然开始
  net.flush();
  assert.equal(a.eng.effectivePaused, false);
  assert.equal(h.eng.effectivePaused, false);
  net.clock.t += 30_000;
  assert.ok(near(a.eng.sharedPositionNow(), 30), `房间时钟应在走：${a.eng.sharedPositionNow()}`);
  // 收得比码率慢也不会一走一停
  h.eng.onBufferProgress({ contiguousBytes: 1e6, runBytes: 0, complete: false });
  net.flush();
  assert.equal(a.eng.stalledPeers.size, 0);
});

impl('GG3-2 收完才播的人照样听别人的卡顿；在线链接的缓冲也照常让全房等', async (dir) => {
  const net = await makeNet(dir);
  const roles = [['a1', 'admin']];
  const h = net.add('h1', { roles });
  const a = net.add('a1', { roles, isSeeder: false, playAfterComplete: true });
  net.connectAll();
  a.eng.resetMedia({ seq: 1 });
  h.eng.resetMedia({ seq: 1, broadcast: true });
  net.flush();
  h.eng.userSetPaused(false);
  net.flush();

  // 别人（这里是房主）报的卡顿照听
  a.eng.onCtrl({ t: 'stall', stalled: true, peerId: 'h1', seq: 1, stallSeq: 1, position: 0 }, { peerId: 'h1', name: 'h1' });
  assert.equal(a.eng.stalledPeers.has('h1'), true);
  assert.equal(a.eng.effectivePaused, true);
  a.eng.onCtrl({ t: 'stall', stalled: false, peerId: 'h1', seq: 1, stallSeq: 2, position: 0 }, { peerId: 'h1', name: 'h1' });

  // 安卓的播放轮询直接调 _evaluateStall：同样不喊停
  a.eng._evaluateStall({ position: 0, paused: false }, { contiguousBytes: 0, runBytes: 0, complete: false });
  assert.equal(a.eng.localStalled, false);

  // 在线链接没有「收完才播」这回事：完全同步的控制者缓冲时照常让全房等
  a.eng.setFollow({ streaming: true, mode: 'full' });
  a.eng.onMpvTick({ position: 5, paused: false, pausedForCache: true, duration: 100 }, { complete: true });
  net.flush();
  assert.equal(a.eng.localStalled, true);
  assert.equal(h.eng.stalledPeers.has('a1'), true, '在线链接的缓冲被一起豁免了');
});

impl('GG3-2 可信房间（不是收完才播）：没收完的控制者照常参与全员暂停', async (dir) => {
  const net = await makeNet(dir);
  const roles = [['a1', 'admin']];
  const h = net.add('h1', { roles });
  const a = net.add('a1', { roles, isSeeder: false });
  net.connectAll();
  a.eng.resetMedia({ seq: 1 });
  h.eng.resetMedia({ seq: 1, broadcast: true });
  net.flush();
  a.eng.onBufferProgress({ contiguousBytes: 0, runBytes: 0, complete: false });
  net.flush();
  assert.equal(a.eng.localStalled, true);
  assert.equal(h.eng.stalledPeers.has('a1'), true);
});

/* ---------------------------------- A3-6 ---------------------------------- */

impl('A3-6 网状下只有房主和他之间断了：房主转来的 release 不撤销我经直连知道的卡顿', async (dir) => {
  const net = await makeNet(dir);
  const roles = [['x1', 'admin'], ['y1', 'guest']];
  const h = net.add('h1', { roles });
  const x = net.add('x1', { roles, isSeeder: false });
  const y = net.add('y1', { roles });
  net.connectAll();
  for (const n of [x, y]) n.eng.resetMedia({ seq: 1 });
  h.eng.resetMedia({ seq: 1, broadcast: true });
  net.flush();
  h.eng.userSetPaused(false);
  net.flush();
  x.eng.onBufferProgress({ contiguousBytes: 0, runBytes: 0, complete: false });
  net.flush();
  assert.deepEqual([...y.eng.stalledPeers.get('x1').via].sort(), ['h1', 'x1']);

  net.disconnect('h1', 'x1');
  net.flush();
  assert.equal(x.eng.localStalled, true, 'x1 还卡着');
  assert.equal(y.eng.stalledPeers.has('x1'), true, 'y1 被房主的 release 骗得不等 x1 了');
  assert.deepEqual([...y.eng.stalledPeers.get('x1').via], ['x1']);
  assert.equal(y.eng.effectivePaused, true);

  // x1 缓过来了，直连告诉 y1
  x.eng.onBufferProgress({ contiguousBytes: 1e12, runBytes: 1e12, complete: false });
  net.flush();
  assert.equal(y.eng.stalledPeers.has('x1'), false);
  assert.equal(y.eng.effectivePaused, false);
});

impl('A3-6 星型下（成员之间不直连）房主的 release 照旧撤销', async (dir) => {
  const net = await makeNet(dir);
  const roles = [['x1', 'admin'], ['y1', 'guest']];
  const h = net.add('h1', { roles });
  const x = net.add('x1', { roles, isSeeder: false });
  const y = net.add('y1', { roles });
  net.connect('h1', 'x1');
  net.connect('h1', 'y1');
  for (const n of [x, y]) n.eng.resetMedia({ seq: 1 });
  h.eng.resetMedia({ seq: 1, broadcast: true });
  net.flush();
  h.eng.userSetPaused(false);
  net.flush();
  x.eng.onBufferProgress({ contiguousBytes: 0, runBytes: 0, complete: false });
  net.flush();
  assert.deepEqual([...y.eng.stalledPeers.get('x1').via], ['h1']);
  net.disconnect('h1', 'x1');
  net.flush();
  assert.equal(y.eng.stalledPeers.has('x1'), false);
  assert.equal(y.eng.effectivePaused, false);
});

/* ------------------------- A3-5：桌面横幅（app.js） ------------------------- */

const root = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8').replace(/\r\n/g, '\n');

/** app.js 顶层函数的源码：从声明行到下一个顶格的 `}`。 */
function fnSource(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层函数 ${name}`);
  const end = APP.indexOf('\n}\n', m.index);
  return APP.slice(m.index, end + 2);
}

function fakeDollar() {
  const els = new Map();
  return (id) => {
    if (!els.has(id)) {
      const cls = new Set();
      els.set(id, {
        id,
        className: '',
        textContent: '',
        classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) },
        setAttribute() {},
      });
    }
    return els.get(id);
  };
}

async function statusRoom({ role, safe = false }) {
  const lib = pathToFileURL(path.join(root, 'src/renderer/lib/')).href;
  const { SyncEngine } = await import(lib + 'syncEngine.js');
  const { worstWaitSeconds } = await import(lib + 'stallForecast.js');
  const roles = [['me', role], ['a1', 'admin']];
  const eng = new SyncEngine({ peerId: 'me', name: 'me', isSeeder: false, hostId: 'h1', playAfterComplete: safe });
  eng.now = () => 1000;
  eng.applyRoles(roles, 'h1');
  eng.started = true;
  eng.onSeek = () => {};
  eng.onSetPause = () => {};
  const banners = [];
  const S = {
    sync: eng,
    current: { kind: 'file' },
    mediaSafety: { status: safe ? 'waiting-download' : 'trusted-streaming' },
    mpvRunning: !safe,
    isSeeder: false,
    filePath: 'C:/cache/film.mkv',
    switchingMedia: false,
    skippedLinks: new Set(),
    diskFull: new Set(),
    sourceType: 'file',
    roomSecurityMode: safe ? 'safe' : 'trusted',
  };
  const noop = () => {};
  const $ = fakeDollar();
  const ctx = {
    S,
    $,
    worstWaitSeconds,
    fmtTime: (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`,
    // 自己还要 5 分钟攒够恢复线；A 还要 1 分半
    myResumeLead: () => ({ waitSec: 300 }),
    lastForecasts: new Map([['a1', { resume: { waitSec: 90 } }]]),
    roomDisplayNames: () => new Map([['a1', 'A']]),
    pushMpvBanner: (text) => banners.push(text),
    linkResolveFailed: () => false,
    linkPlayFailed: () => false,
    linkAsking: () => false,
    fallbackAsking: () => false,
    driftShown: () => false,
    currentUnavailable: () => false,
    currentSession: () => ({}),
    setScanTicker: noop,
    renderNowKicker: noop,
    renderDrift: noop,
    updateStripTone: noop,
    updatePresence: noop,
    scheduleOscState: noop,
  };
  vm.createContext(ctx);
  vm.runInContext(
    ['renderStatus', 'stallWaitSeconds', 'stallBannerText', 'selfStallBannerText', 'stallWaitingNames', 'playbackAllowed']
      .map(fnSource)
      .join('\n\n'),
    ctx,
    { filename: 'app.js（节选）' }
  );
  const banner = () => $('status-banner').textContent;
  return { ctx, eng, banner, banners };
}

const stallSelf = (eng) =>
  eng._evaluateStall({ position: 10, paused: false }, { contiguousBytes: 0, runBytes: 0, complete: false });

test('A3-5 游客自己缓冲不足（房间照常播放）：横幅和 mpv 叠加层不说「全员暂停」', async () => {
  const { ctx, eng, banner, banners } = await statusRoom({ role: 'guest' });
  stallSelf(eng);
  assert.equal(eng.localStalled, true);
  assert.equal(eng.roomStalled, false);
  ctx.renderStatus();
  assert.equal(banner(), '缓冲不足，只暂停你自己，房间照常播放 —— 约 5:00 后继续');
  assert.equal(banners.at(-1), banner(), 'mpv 画面上的横幅要同一句');
  assert.doesNotMatch(banner(), /全员暂停/);
});

test('A3-5 游客自己卡着、同时有管理员在卡：名单和预计时长只算让房间停下的人', async () => {
  const { ctx, eng, banner } = await statusRoom({ role: 'guest' });
  stallSelf(eng);
  eng.onCtrl({ t: 'stall', stalled: true, peerId: 'a1', seq: 0, stallSeq: 1, position: 10 }, { peerId: 'a1', name: 'A' });
  assert.equal(eng.roomStalled, true);
  ctx.renderStatus();
  assert.equal(banner(), '全员暂停中 —— 在等 A 把缓冲攒够，约 1:30', '游客自己不该出现在「在等」的名单里');
});

test('A3-5 控制者自己缓冲不足：照旧是全员暂停、在等「你」', async () => {
  const { ctx, eng, banner } = await statusRoom({ role: 'admin' });
  stallSelf(eng);
  assert.equal(eng.roomStalled, true);
  ctx.renderStatus();
  assert.equal(banner(), '全员暂停中 —— 在等 你 把缓冲攒够，约 5:00');
});

test('GG3-2 安全模式下还在收的管理员：房间在播时横幅说本机在收，不说「播放中」也不说「全员暂停」', async () => {
  const { ctx, eng, banner, banners } = await statusRoom({ role: 'admin', safe: true });
  eng.onCtrl({ t: 'sync', paused: false, position: 0, lamport: 1, seq: 0 }, { peerId: 'h1', name: 'h1' });
  eng.onBufferProgress({ contiguousBytes: 0, runBytes: 0, complete: false });
  assert.equal(eng.anyoneStalled, false);
  ctx.renderStatus();
  assert.equal(banner(), '正在完整接收并校验媒体，完成后会进行安全扫描…');
  assert.equal(banners.at(-1), '');
});

/* ------------------------------- 接线与文案 ------------------------------- */

test('GG3-2 桌面端按房间模式给同步引擎开「收完才播」', () => {
  const init = fnSource('initSwarmAndSync');
  const built = [];
  const noop = () => {};
  class FakeEmitter {
    on() {
      return noop;
    }
  }
  const run = (S) => {
    const ctx = {
      S,
      myPlatform: () => 'windows',
      Swarm: class extends FakeEmitter {
        constructor() {
          super();
          this.peers = new Map();
        }
        start() {}
      },
      SyncEngine: class extends FakeEmitter {
        constructor(opts) {
          super();
          built.push(opts);
        }
      },
      window: { sw: { player: {} } },
      // 挂事件时按名字引用的处理函数：这里只看构造参数
      scheduleTransferUpdate: noop,
      renderPlaylistSoon: noop,
      renderStatus: noop,
      renderDrift: noop,
      scheduleOscState: noop,
      renderPeers: noop,
      renderPeersSoon: noop,
      maybeLaunchPlayer: noop,
      renderProgress: noop,
      updateLocalReady: noop,
    };
    vm.createContext(ctx);
    vm.runInContext(init, ctx);
    ctx.initSwarmAndSync();
    return built.at(-1);
  };
  const base = { peerId: 'me', name: 'me', hostId: 'h1', isSeeder: false };
  assert.equal(run({ ...base, roomSecurityMode: 'safe', settings: { securityMode: 'trusted' } }).playAfterComplete, true);
  assert.equal(run({ ...base, roomSecurityMode: 'trusted', settings: { securityMode: 'safe' } }).playAfterComplete, false);
  // 还没定房间模式时和 Swarm 一样退回设置里的；认不出的一律按安全模式
  assert.equal(run({ ...base, roomSecurityMode: null, settings: { securityMode: 'trusted' } }).playAfterComplete, false);
  assert.equal(run({ ...base, roomSecurityMode: null, settings: {} }).playAfterComplete, true);
});

test('GG3-2 安卓端安全模式同样开「收完才播」', () => {
  const src = fs.readFileSync(path.join(root, 'android/app/src/main/assets/js/app-android.js'), 'utf8');
  const init = src.slice(src.indexOf('function initSwarmAndSync('), src.indexOf("S.sync.onSetPause"));
  assert.match(init, /playAfterComplete: S\.securityMode === 'safe'/);
});

test('新文案有英文：游客自己缓冲不足的横幅、安卓信令模式认不出房主', async () => {
  const { translate } = await import('../src/renderer/lib/i18n.js');
  assert.equal(
    translate('缓冲不足，只暂停你自己，房间照常播放', 'en'),
    'Buffer low — only your playback is paused; the room keeps playing'
  );
  assert.equal(
    translate('缓冲不足，只暂停你自己，房间照常播放 —— 约 1:30 后继续', 'en'),
    'Buffer low — only your playback is paused; the room keeps playing. Resuming in about 1:30'
  );
  const android = await import('../android/app/src/main/assets/js/i18n.js');
  assert.equal(
    android.translate('连接失败：这个房间号还没有人开房：可能填错了，或者房主还没开房、已经离开', 'en'),
    'Connection failed: Nobody has opened a room with this number: it may be mistyped, or the host has not opened it yet or has already left'
  );
  assert.equal(
    android.translate('连接失败：信令服务器没有告诉我们谁是房主，已拒绝加入', 'en'),
    'Connection failed: The signaling server did not say who the host is; join refused'
  );
});
