'use strict';

// 第二轮修复批次 G1（播放器与同步）：
//  - R3-A 在线链接断流：mpv 同一刻推上来的 pause 和 eof 偶尔落在前后两轮管道读取里，控制者把第一条
//    「暂停了、还没 eof」当成本人按的暂停广播给全房。两道：主进程 MpvController 对 pause→true 的那一批
//    最多多等 PAUSE_TICK_HOLD_MS；引擎在线链接里的暂停等 STREAM_PAUSE_CONFIRM_MS 确认不是断流再报。
//    真人按的暂停照常同步（本地文件不等，在线链接晚一点）。
//  - R3-C 缓冲中关掉播放器：卸载文件那几条 tick 没有 time-pos，快照报 null（不再报 0），
//    引擎不拿它判跳转 —— 否则控制者把全房拽回 0:00。本地文件正常播放时关窗同理。
//  - R1-A 可信房间距起播的「预计还需」算上排在前面的在途字节和播放器启动时间。
// 引擎是桌面 / 安卓共用的两份，都跑。全程不启动播放器、不出声。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { IMPLS } = require('./helpers/impls');

const root = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8').replace(/\r\n/g, '\n');

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = 1024 * 1024;
// 测试里把确认窗口调短，省时间；真实值另有一条用例钉住
const CONFIRM_MS = 40;

/**
 * 一台正在播的引擎。默认是房主、在线链接、完全同步；streaming:false 是本地文件。
 * 播放器已经放到 43 秒（喂过两条在走的 tick），开播那一下的回声窗口也已经关掉。
 */
async function playing(dir, { streaming = true, peerId = 'h1', role = null, isSeeder = true, buf = null } = {}) {
  const { SyncEngine } = await import(dir + 'syncEngine.js');
  const eng = new SyncEngine({ peerId, name: peerId, isSeeder, hostId: 'h1' });
  const clock = { t: 10_000 };
  eng.now = () => clock.t;
  eng.pauseConfirmMs = CONFIRM_MS;
  const rec = { out: [], acts: [], cuts: [], pauses: [], seeks: [], denied: [] };
  eng.onSeek = (p) => rec.seeks.push(p);
  eng.onSetPause = (p) => rec.pauses.push(p);
  eng.started = true;
  if (role) eng.applyRoles([[peerId, role]], 'h1');
  // 房间从 42.5 秒起播，和下面喂的 tick 对得上
  eng.resetMedia({ seq: 1, isSeeder, position: 42.5, broadcast: peerId === 'h1' });
  eng.setFollow({ streaming, mode: 'full' });
  eng.setMediaInfo({ duration: 180, size: streaming ? 0 : 180 * MB });
  eng.userSetPaused(false);
  await wait(300); // 等回声窗口关掉
  eng.on('outbound', (m) => rec.out.push(m));
  eng.on('local-action', (a) => rec.acts.push(a));
  eng.on('stream-cut', (e) => rec.cuts.push(e));
  eng.on('denied', (e) => rec.denied.push(e));
  const buffer = buf || { contiguousBytes: 180 * MB, runBytes: 180 * MB, runEndBytes: 180 * MB, complete: true };
  const tick = (fields) =>
    eng.onMpvTick(
      {
        position: 0,
        paused: false,
        eof: false,
        idle: false,
        seeking: false,
        pausedForCache: false,
        duration: 180,
        sampledAt: clock.t,
        ...fields,
      },
      buffer
    );
  const advance = (ms) => {
    clock.t += ms;
  };
  tick({ position: 42.5 });
  advance(500);
  tick({ position: 43 });
  advance(30);
  return { eng, rec, tick, advance, clock };
}

const syncs = (rec) => rec.out.filter((m) => m.t === 'sync');

/* ------------------------------ R3-A：断流不暂停全房 ------------------------------ */

impl('确认窗口的真实值在 150–250ms 之间（真人按的暂停只晚这么一点）', async (dir) => {
  const { STREAM_PAUSE_CONFIRM_MS, SyncEngine } = await import(dir + 'syncEngine.js');
  assert.ok(STREAM_PAUSE_CONFIRM_MS >= 150 && STREAM_PAUSE_CONFIRM_MS <= 250, String(STREAM_PAUSE_CONFIRM_MS));
  assert.equal(new SyncEngine({ peerId: 'h1', name: 'h1', isSeeder: true, hostId: 'h1' }).pauseConfirmMs, STREAM_PAUSE_CONFIRM_MS);
});

// 实测断流时 mpv 推上来的是 pause、core-idle、eof-reached（同一毫秒），被管道拆开的地方不固定
const SPLITS = [
  ['{pause, core-idle} | {eof}', { paused: true, idle: true }, { paused: true, idle: true, eof: true }],
  ['{pause} | {core-idle, eof}', { paused: true }, { paused: true, idle: true, eof: true }],
  ['{pause} | {paused-for-cache}', { paused: true }, { paused: true, pausedForCache: true }],
  ['{pause} | 打不开（loadFailed，没了位置）', { paused: true, idle: true }, { paused: true, idle: true, loadFailed: true, position: null }],
];

for (const [label, first, second] of SPLITS) {
  impl(`断流拆成两条 tick（${label}）：控制者不广播暂停、不记「你 暂停」，房间照走`, async (dir) => {
    const { eng, rec, tick, advance } = await playing(dir);
    tick({ position: 43.03, ...first });
    await wait(CONFIRM_MS / 3); // 后一半隔了一轮事件循环（甚至几十毫秒）才到
    advance(CONFIRM_MS / 3);
    tick({ position: 43.03, ...second });
    await wait(CONFIRM_MS * 3);
    assert.deepEqual(syncs(rec), [], '房主的断流把全房暂停了');
    assert.deepEqual(rec.acts, []);
    assert.equal(eng.shared.paused, false, '房间照走');
    assert.equal(eng.intendedPaused, false, '本人「想停着」一起撤回：重试之后按房间状态接着放');
    if (second.eof) assert.equal(rec.cuts.length, 1, '断流照旧报 stream-cut，提示本人重试');
  });
}

impl('eof 先到、pause 后到：同样不广播', async (dir) => {
  const { eng, rec, tick } = await playing(dir);
  tick({ position: 43.03, idle: true, eof: true });
  await wait(5);
  tick({ position: 43.03, idle: true, eof: true, paused: true });
  await wait(CONFIRM_MS * 3);
  assert.deepEqual(syncs(rec), []);
  assert.equal(rec.cuts.length, 1);
  assert.equal(eng.intendedPaused, false);
});

impl('游客、手动同步的人断流也一样：不记「你 暂停（只停自己）」，重试后不会停在那儿', async (dir) => {
  const { eng, rec, tick } = await playing(dir, { peerId: 'g1', role: 'guest' });
  tick({ position: 43.03, paused: true, idle: true });
  await wait(5);
  tick({ position: 43.03, paused: true, idle: true, eof: true });
  await wait(CONFIRM_MS * 3);
  assert.deepEqual(rec.acts, []);
  assert.equal(eng.intendedPaused, false);
});

impl('在线链接里真人按暂停：确认窗口过后照常广播，报的是按下那一刻的位置', async (dir) => {
  const { eng, rec, tick } = await playing(dir);
  tick({ position: 43.5, paused: true, idle: true });
  assert.equal(eng.intendedPaused, true, '本机当场停着（界面按钮、核对差值都按「想停着」算）');
  assert.deepEqual(syncs(rec), [], '确认之前不报');
  await wait(CONFIRM_MS * 3);
  const sent = syncs(rec);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].paused, true);
  assert.equal(sent[0].position, 43.5);
  assert.deepEqual(rec.acts, [{ kind: 'pause', position: 43.5, local: false }]);
  assert.equal(eng.shared.paused, true);
});

impl('缓冲中（paused-for-cache）按的暂停：之后缓冲标记还挂着也照常报（不当成断流）', async (dir) => {
  const { eng, rec, tick, advance } = await playing(dir);
  tick({ position: 43.1, pausedForCache: true });
  await wait(300); // 让全房等着的那次对播放器的命令，回声窗口关掉
  advance(2000);
  rec.out.length = 0;
  tick({ position: 43.1, pausedForCache: true, paused: true, idle: true });
  await wait(5);
  tick({ position: 43.1, pausedForCache: true, paused: true, idle: true, streamPos: 1 });
  await wait(CONFIRM_MS * 3);
  const sent = syncs(rec);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].paused, true);
  assert.equal(eng.intendedPaused, true);
});

impl('在线链接里在 mpv 按播放：第一条 tick 还 core-idle（被判成在等数据），也不能当成「缓冲中按播放」拒掉', async (dir) => {
  const { eng, rec, tick, advance } = await playing(dir);
  tick({ position: 43.5, paused: true, idle: true });
  await wait(300);
  advance(2000);
  rec.out.length = 0;
  tick({ position: 43.5, paused: false, idle: true }); // 播放器还没真正走起来
  assert.deepEqual(rec.denied, [], '本人按的播放被压回了暂停');
  const sent = syncs(rec);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].paused, false);
  assert.equal(eng.intendedPaused, false);
  // 缓冲中按了暂停、还在缓冲就又按播放：同样收下（以前自己的缓冲被当成「被强制停着」，每次都拒）
  const buffering = await playing(dir);
  buffering.tick({ position: 43.1, pausedForCache: true });
  buffering.tick({ position: 43.1, pausedForCache: true, paused: true, idle: true });
  await wait(300);
  buffering.advance(2000);
  buffering.rec.out.length = 0;
  buffering.tick({ position: 43.1, pausedForCache: true, paused: false, idle: true });
  assert.deepEqual(buffering.rec.denied, []);
  assert.deepEqual(syncs(buffering.rec).map((m) => m.paused), [false]);
  // 别人卡着的时候照旧拒（全房在等他）
  const other = await playing(dir);
  other.eng.applyRoles([['a9', 'admin']], 'h1');
  other.eng.onCtrl({ t: 'stall', stalled: true, peerId: 'a9', name: 'a9', position: 43, seq: 1, stallSeq: 2 }, { peerId: 'a9', name: 'a9' });
  assert.equal(other.eng.stalledPeers.size, 1);
  other.tick({ position: 43.03, paused: true, idle: true }); // 引擎让播放器停下的回声
  await wait(300);
  other.advance(2000);
  other.tick({ position: 43.03, paused: false, idle: true });
  assert.deepEqual(other.rec.denied, [{ action: 'play' }]);
});

impl('在线链接里游客按暂停：确认过后只停自己（不广播）', async (dir) => {
  const { eng, rec, tick } = await playing(dir, { peerId: 'g1', role: 'guest' });
  tick({ position: 43.5, paused: true, idle: true });
  await wait(CONFIRM_MS * 3);
  assert.deepEqual(syncs(rec), []);
  assert.deepEqual(rec.acts, [{ kind: 'pause', position: 43.5, local: true }]);
  assert.equal(eng.intendedPaused, true);
});

impl('本地文件真人按暂停：不等，当场广播', async (dir) => {
  const { rec, tick } = await playing(dir, { streaming: false });
  tick({ position: 43.5, paused: true, idle: true });
  const sent = syncs(rec);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].paused, true);
  assert.equal(sent[0].position, 43.5);
  assert.deepEqual(rec.acts, [{ kind: 'pause', position: 43.5, local: false }]);
});

impl('按了暂停又马上放起来（确认之前）：什么都不报，房间照走', async (dir) => {
  const { eng, rec, tick, advance } = await playing(dir);
  tick({ position: 43.5, paused: true, idle: true });
  await wait(5);
  advance(5);
  tick({ position: 43.5, paused: false });
  await wait(CONFIRM_MS * 3);
  assert.deepEqual(syncs(rec), [], '房间从没停过，不用再报一条「播放」');
  assert.deepEqual(rec.acts, []);
  assert.deepEqual(rec.denied, []);
  assert.equal(eng.intendedPaused, false);
});

impl('确认期间界面上又按了暂停 / 跳转：只报后来的那一下，不重复', async (dir) => {
  const a = await playing(dir);
  a.tick({ position: 43.5, paused: true, idle: true });
  a.eng.userSetPaused(true);
  await wait(CONFIRM_MS * 3);
  assert.equal(syncs(a.rec).length, 1);
  assert.equal(syncs(a.rec)[0].paused, true);

  const b = await playing(dir);
  b.tick({ position: 43.5, paused: true, idle: true });
  b.eng.userSeek(90);
  await wait(CONFIRM_MS * 3);
  assert.deepEqual(
    syncs(b.rec).map((m) => [m.paused, m.position]),
    [[true, 90]],
    '跳转那一条带着暂停出去就够了'
  );
});

impl('确认期间收到别人的指令：那下暂停不再单独报，本人随房间走', async (dir) => {
  const { eng, rec, tick } = await playing(dir, { peerId: 'a1', role: 'admin' });
  tick({ position: 43.5, paused: true, idle: true });
  // 房主这时按了跳转（房间还在播）
  eng.onCtrl({ t: 'sync', paused: false, position: 60, lamport: eng.shared.lamport + 1, seq: 1 }, { peerId: 'h1', name: 'h1' });
  await wait(CONFIRM_MS * 3);
  assert.deepEqual(syncs(rec), []);
  assert.equal(eng.intendedPaused, false);
});

impl('确认期间播放器没了：撤回，不报', async (dir) => {
  const { eng, rec, tick } = await playing(dir);
  tick({ position: 43.5, paused: true, idle: true });
  eng.playerGone();
  await wait(CONFIRM_MS * 3);
  assert.deepEqual(syncs(rec), []);
  assert.deepEqual(rec.acts, []);
  assert.equal(eng.intendedPaused, false);
});

impl('确认期间换了片：那下暂停作废', async (dir) => {
  const { rec, eng, tick } = await playing(dir);
  tick({ position: 43.5, paused: true, idle: true });
  eng.resetMedia({ seq: 2, isSeeder: true, broadcast: false });
  await wait(CONFIRM_MS * 3);
  assert.deepEqual(syncs(rec), []);
  assert.deepEqual(rec.acts, []);
});

/* ------------------------------ R3-C：关窗不把全房拽回 0:00 ------------------------------ */

impl('缓冲中（paused-for-cache）关掉播放器：卸载那几条 tick 不广播跳转，全房不被拽回 0:00', async (dir) => {
  const { eng, rec, tick, advance } = await playing(dir);
  tick({ position: 43.2, pausedForCache: true });
  await wait(300);
  advance(3000);
  // 静音 mpv 实测（fix/G1/close-stall）：time-pos 没了、片长先在后归零，paused-for-cache 可能还挂着
  tick({ position: null, idle: true, pausedForCache: true });
  tick({ position: null, idle: true, duration: 0 });
  await wait(CONFIRM_MS * 3);
  assert.deepEqual(syncs(rec), [], '控制者把「跳到 0」广播给了全房');
  assert.deepEqual(rec.acts, []);
  assert.equal(eng.playerPositionNow(), null, '说不出位置的播放器不算有位置');
});

impl('本地文件正常播放时关掉播放器：同样不广播跳转', async (dir) => {
  const { rec, tick, advance } = await playing(dir, { streaming: false });
  advance(200);
  tick({ position: 43.23 });
  advance(30);
  tick({ position: null, idle: true });
  tick({ position: null, idle: true, duration: 0 });
  assert.deepEqual(syncs(rec), []);
  assert.deepEqual(rec.acts, []);
});

impl('还报 0 的老快照：片长跟着归零的那条也不算跳转', async (dir) => {
  const { rec, tick, advance } = await playing(dir, { streaming: false });
  advance(200);
  tick({ position: 0, idle: true, duration: 0 });
  assert.deepEqual(syncs(rec), []);
});

impl('卸载之后（或还没载入完）在界面上按暂停：报房间时钟的位置，不报 0', async (dir) => {
  const { eng, rec, tick } = await playing(dir);
  tick({ position: null, idle: true });
  const room = eng.sharedPositionNow();
  assert.ok(room > 40, `房间时钟 ${room}`);
  eng.userSetPaused(true);
  const sent = syncs(rec).at(-1);
  assert.equal(sent.paused, true);
  assert.ok(Math.abs(sent.position - room) < 0.01, `报出去的位置 ${sent.position}`);
});

impl('重新载入后第一条有位置的 tick 不和卸载那条比（不当成跳转）', async (dir) => {
  const { rec, tick, advance } = await playing(dir, { streaming: false });
  tick({ position: null, idle: true, duration: 0 });
  advance(500);
  tick({ position: 120, duration: 180 });
  assert.deepEqual(syncs(rec), []);
});

impl('说不出位置时报出去的 STALL 位置也是个数（收端对不是数的位置整条不认）', async (dir) => {
  const { eng, rec, tick } = await playing(dir, {
    streaming: false,
    peerId: 'a1',
    role: 'admin',
    isSeeder: false,
    buf: { contiguousBytes: 8 * MB, runBytes: 0, runEndBytes: 8 * MB, complete: false },
  });
  // 开播那两条 tick 已经因为余量不足喊过停了：先放开再看说不出位置的那一条
  eng.localStalled = false;
  rec.out.length = 0;
  tick({ position: null, idle: true });
  const stall = rec.out.find((m) => m.t === 'stall');
  assert.ok(stall, '余量不足应当喊停');
  assert.ok(Number.isFinite(stall.position), `STALL 的位置 ${stall.position}`);
});

/* ------------------------------ 主进程 mpv ------------------------------ */

const { MpvController } = require('../src/main/mpv');
const line = (name, data) => JSON.stringify({ event: 'property-change', name, ...(data === undefined ? {} : { data }) }) + '\n';
const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};

function controller(holdMs = 60) {
  const ctl = new MpvController();
  ctl.pauseTickHoldMs = holdMs;
  const ticks = [];
  ctl.on('tick', (s) => ticks.push(s));
  return { ctl, ticks };
}

test('pause 和 eof 落在前后两轮事件循环里：等一小会儿，合成一条「停在 eof 上」', async () => {
  const { ctl, ticks } = controller();
  ctl._onData(line('time-pos', 43) + line('pause', false));
  await flush();
  ticks.length = 0;
  // 同一次读取里 time-pos 排在 pause 前面也照样等
  ctl._onData(line('time-pos', 43.03) + line('pause', true) + line('core-idle', true));
  await wait(15);
  assert.equal(ticks.length, 0, '「暂停了、还没 eof」先单独发出去了');
  ctl._onData(line('eof-reached', true));
  await flush();
  assert.equal(ticks.length, 1, 'eof 到了就马上发，不等满');
  assert.equal(ticks[0].paused, true);
  assert.equal(ticks[0].eof, true);
  await wait(80);
  assert.equal(ticks.length, 1);
});

test('真人按暂停（没有 eof 跟上来）：最多晚 pauseTickHoldMs 发出，只发一条', async () => {
  const { ctl, ticks } = controller(40);
  ctl._onData(line('pause', true) + line('core-idle', true));
  await flush();
  assert.equal(ticks.length, 0);
  ctl._onData(line('time-pos', 43.04)); // 等的期间来的变化跟着一起发，不往后续
  await wait(80);
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].paused, true);
  assert.equal(ticks[0].eof, false);
  assert.equal(ticks[0].position, 43.04);
});

test('已经停在 eof 上再报暂停、或者按了暂停又马上放开：不等', async () => {
  const a = controller();
  a.ctl._onData(line('eof-reached', true));
  await flush();
  a.ticks.length = 0;
  a.ctl._onData(line('pause', true));
  await flush();
  assert.equal(a.ticks.length, 1);

  const b = controller();
  b.ctl._onData(line('pause', true));
  await wait(5);
  b.ctl._onData(line('pause', false));
  await flush();
  assert.equal(b.ticks.length, 1);
  assert.equal(b.ticks[0].paused, false);
  await wait(80);
  assert.equal(b.ticks.length, 1);
});

test('默认等 50ms：够盖住管道拆开的那一下，真人按暂停也察觉不到', () => {
  const ctl = new MpvController();
  assert.ok(ctl.pauseTickHoldMs > 0 && ctl.pauseTickHoldMs <= 60, String(ctl.pauseTickHoldMs));
});

test('快照：没有 time-pos（还没载入完、卸载时属性没了）报 null，不报 0', () => {
  const ctl = new MpvController();
  assert.equal(ctl.snapshot().position, null);
  ctl._onData(line('time-pos', 12.5));
  assert.equal(ctl.snapshot().position, 12.5);
  ctl._onData(line('time-pos')); // mpv 卸载文件时推上来的就是不带 data 的一条
  assert.equal(ctl.snapshot().position, null);
});

/* ------------------------------ app.js ------------------------------ */

function fnSource(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层函数 ${name}`);
  const end = APP.indexOf('\n}\n', m.index);
  return APP.slice(m.index, end + 2);
}

test('房间播放位置：播放器说不出位置（position 为 null）时和没起来一样看房间时钟', () => {
  const S = {
    manifest: { size: 1e9 },
    sync: { lastTick: { position: null, streamPos: null }, sharedPositionNow: () => 100 },
  };
  const ctx = { S, mediaBitrate: () => 1e6, currentFileCtx: () => null };
  vm.createContext(ctx);
  vm.runInContext(['roomPositionSec', 'roomPlayheadByte'].map(fnSource).join('\n\n'), ctx);
  assert.equal(ctx.roomPositionSec(), 100);
  assert.equal(ctx.roomPlayheadByte(), 100e6);
  S.sync.lastTick = { position: 30, streamPos: null };
  assert.equal(ctx.roomPositionSec(), 30);
  assert.equal(ctx.roomPlayheadByte(), 30e6);
});

/** 「预计还需」那几行（常量和两个函数）放在一个沙箱里跑。 */
function etaBox({ inflight = [], have, mpvRunning = false, tailReserveBytes = 0 }) {
  const CHUNK = 2 * MB;
  const size = 200 * MB;
  const S = {
    manifest: { size },
    mpvRunning,
    swarm: { inflight: new Map(inflight.map((x) => [`1:${x.index}`, { slot: 1, peerId: 'p', ...x }])) },
  };
  const fileCtx = {
    slot: 1,
    have,
    manifest: { size, chunkSize: CHUNK, chunkCount: 100 },
    scheduler: { tailReserveBytes },
  };
  const ctx = { S, HEAD_READY_BYTES: 8 * MB, currentFileCtx: () => fileCtx };
  vm.createContext(ctx);
  const from = APP.indexOf('const PLAYER_START_SECONDS');
  const to = APP.indexOf('function drawChunkMap(');
  assert.ok(from > 0 && to > from);
  vm.runInContext(APP.slice(from, to), ctx);
  return ctx;
}
const haveFirst = (n) => Uint8Array.from({ length: 100 }, (_, i) => (i < n ? 1 : 0));

test('预计还需：排在前面的在途片和播放器启动时间都算上（实测写 0:05、17 秒后才起播）', () => {
  // 从片头起播，门槛要 [0, 17MB)；手上有片头 8MB，还差 9MB（第 4–8 片），一片都还没要到
  // 在路上的是门槛外的 5 片（10MB），要先送完
  const box = etaBox({
    have: haveFirst(4),
    inflight: [20, 21, 22, 23, 24].map((index) => ({ index, at: 1000 })),
  });
  const eta = box.startEtaSeconds({ left: 9 * MB, rate: 1 * MB, midJoin: false, startByte: 0, runNeeded: 17 * MB, tailMissing: 0 });
  assert.equal(eta, 9 + 10 + 2);
});

test('预计还需：门槛里的片先要了、排在前面，门槛外后要的不算；播放器已经开着不加启动时间', () => {
  const box = etaBox({
    have: haveFirst(4),
    mpvRunning: true,
    inflight: [
      ...[4, 5, 6, 7, 8].map((index) => ({ index, at: 1000 })),
      ...[20, 21].map((index) => ({ index, at: 2000 })),
    ],
  });
  const eta = box.startEtaSeconds({ left: 9 * MB, rate: 1 * MB, midJoin: false, startByte: 0, runNeeded: 17 * MB, tailMissing: 0 });
  assert.equal(eta, 9);
  // 门槛外的有一片比门槛里最晚要的那片还早要：它排在前面，要算
  const earlier = etaBox({
    have: haveFirst(4),
    mpvRunning: true,
    inflight: [...[4, 5, 6, 7, 8].map((index) => ({ index, at: 1000 })), { index: 30, at: 500 }],
  });
  assert.equal(
    earlier.startEtaSeconds({ left: 9 * MB, rate: 1 * MB, midJoin: false, startByte: 0, runNeeded: 17 * MB, tailMissing: 0 }),
    11
  );
});

test('预计还需：中途加入时文件尾的索引也在门槛里，在路上的尾片不算「排在前面」', () => {
  const have = haveFirst(4);
  for (let i = 50; i < 58; i++) have[i] = 1; // 起播点 100MB 起已有 16MB
  const box = etaBox({
    have,
    mpvRunning: true,
    tailReserveBytes: 4 * MB,
    inflight: [98, 99, 58].map((index) => ({ index, at: 1000 })),
  });
  const eta = box.startEtaSeconds({ left: 4 * MB, rate: 1 * MB, midJoin: true, startByte: 100 * MB, runNeeded: 17 * MB, tailMissing: 4 * MB });
  assert.equal(eta, 4, '尾片和起播点附近的片都是门槛要的');
});
