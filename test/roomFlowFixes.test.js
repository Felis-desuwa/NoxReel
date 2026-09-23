'use strict';

// 房间编排层（app.js）的几处换片 / 交接 / 收尾时序。
//
// app.js 是整页的编排脚本，没法整个在 Node 里跑。这里把涉及的顶层函数原样抠出来，
// 放进 vm 沙箱，周围配上假播放器、假存储和真的 SyncEngine / PlayerGate / playlist，
// 按出事时的先后顺序喂事件 —— 测的是仓库里真实的函数体，不是照抄的副本。
// 全程不启动任何播放器，不出声。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8').replace(/\r\n/g, '\n');
const LIB = path.join(root, 'src/renderer/lib');
const load = (name) => import(pathToFileURL(path.join(LIB, name)).href);

/** app.js 顶层函数的源码：从声明行到下一个顶格的 `}`（prettier 排版下顶层函数都这样收尾）。 */
function fnSource(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层函数 ${name}`);
  const end = APP.indexOf('\n}\n', m.index);
  assert.ok(end > m.index, `${name} 的结尾没找到`);
  return APP.slice(m.index, end + 2);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

/** 让微任务和 setImmediate 排着的活都跑完。 */
async function flush(rounds = 5) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

function fakeEl() {
  const classes = new Set();
  return {
    disabled: false,
    textContent: '',
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => (on ?? !classes.has(c) ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
  };
}

/** 假播放器：launch / quit 可以挂起，由测试决定什么时候回包。代号在调用时分配。 */
function fakePlayer(timeline) {
  const p = {
    gen: 0,
    launches: [],
    quits: [],
    holdLaunch: false,
    holdQuit: false,
    launch(opts) {
      const gen = ++p.gen;
      timeline.push(['launch', opts.filePath, gen]);
      const d = deferred();
      p.launches.push({ opts, gen, d, reply: () => d.resolve({ gen, caps: {} }) });
      if (!p.holdLaunch) d.resolve({ gen, caps: {} });
      return d.promise;
    },
    quit(gen) {
      timeline.push(['quit', gen ?? null]);
      const d = deferred();
      d.promise.then(() => timeline.push(['quit-done', gen ?? null]));
      p.quits.push({ gen, d });
      if (!p.holdQuit) d.resolve();
      return d.promise;
    },
    osd: () => Promise.resolve(),
  };
  return p;
}

function fakeStore(timeline) {
  const s = {
    closes: [],
    opens: [],
    openImpl: null,
    scans: [],
    cancels: [],
    closeDelayMs: {}, // 会话 id -> 主进程关它要多久（删缓存遇到占用会重试一阵）
    close(id) {
      timeline.push(['close', id]);
      s.closes.push(id);
      const ms = s.closeDelayMs[id] || 0;
      const done = ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
      return done.then(() => {
        timeline.push(['close-done', id]);
        return true;
      });
    },
    openLeech(manifest) {
      timeline.push(['openLeech', manifest.fileId]);
      s.opens.push(manifest);
      return s.openImpl ? s.openImpl(manifest) : Promise.resolve({ sessionId: 'leech-new', filePath: 'C:/cache/new.mkv' });
    },
    scanReceivedMedia(sessionId) {
      const d = deferred();
      s.scans.push({ sessionId, d });
      return d.promise;
    },
    cancelScan(sessionId) {
      s.cancels.push(sessionId);
      return Promise.resolve(true);
    },
  };
  return s;
}

const fileItem = (fileId, over = {}) => ({
  kind: 'file',
  id: `it-${fileId}`,
  fileId,
  name: `${fileId}.mkv`,
  size: 2e9,
  chunkSize: 2 * 1024 * 1024,
  chunkCount: 954,
  durationSec: 7200,
  slot: 1,
  ...over,
});

/**
 * 沙箱里的「房间」。fns 是要从 app.js 里抠出来的真函数，stubs 覆盖其余依赖。
 * 默认 stub 都是空操作；需要观察的在测试里单独给。
 */
async function makeRoom({ fns, stubs = {}, sync } = {}) {
  const { PlayerGate } = await load('playerGate.js');
  const playlistLib = await load('playlist.js');
  const timeline = [];
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, fakeEl());
    return els.get(id);
  };
  const player = fakePlayer(timeline);
  const store = fakeStore(timeline);
  const logs = [];
  const S = {
    peerId: 'me',
    hostId: 'host',
    current: null,
    currentSeq: 1,
    playlist: { ...playlistLib.createPlaylist(), seq: 1 },
    sessions: new Map(),
    pendingAdds: new Set(),
    opening: new Set(),
    manifestRetryAt: new Map(),
    knownManifests: new Map(),
    blockedFiles: new Set(),
    diskFull: new Set(),
    closing: new Set(),
    leechOpens: new Set(),
    leaving: false,
    playerQuit: Promise.resolve(),
    mpvRunning: false,
    switchingMedia: false,
    syncStarted: true,
    mediaSafety: { sessionId: null, status: 'idle' },
    roomSecurityMode: 'safe',
    manifest: null,
    sessionId: null,
    filePath: null,
    isSeeder: false,
    sourceType: null,
    linkInfo: null,
    prepJobs: [],
    prepRuns: new Set(),
    skippedLinks: new Set(),
    sync,
    swarm: {
      files: new Map(),
      playingSlot: 1,
      durations: [],
      removed: [],
      progress: (slot) => ({
        slot: slot ?? null,
        contiguousBytes: 0,
        runBytes: 0,
        runEndBytes: 0,
        playbackByte: 0,
        complete: false,
      }),
      setPlaybackByte() {},
      setPlaying() {},
      setDuration(slot, d) {
        this.durations.push([slot, d]);
      },
      removeFile(slot) {
        this.removed.push(slot);
        this.files.delete(slot);
      },
      withdrawManifest() {},
      offerManifest() {},
      destroy() {},
      requestManifest: () => Promise.reject(new Error('测试里不该去要清单')),
    },
  };
  const noop = () => {};
  const ctx = {
    S,
    playerGate: new PlayerGate(),
    lastMpvBanner: '',
    roomEntered: true,
    scanningSession: null,
    $,
    t: (s) => s,
    log: (text, kind) => logs.push([text, kind]),
    fmtBytes: (b) => `${b} B`,
    MANIFEST_RETRY_MS: 5000,
    PREP_DRAIN_MS: 50,
    DRAIN_ROUNDS: 10,
    MSG: { DENY: 'deny' },
    delay: (ms) => new Promise((r) => setTimeout(r, ms)),
    HEAD_READY_BYTES: 8 * 1024 * 1024,
    // 中途加入相关：这几个用例都从片头起播，房间位置恒为 0，门槛整条让开。
    // 真正走这几条分支（起播、就绪、跳转）的用例在 test/midJoinGate.test.js。
    roomPlayheadByte: () => 0,
    midJoinNow: () => false,
    startRunNeeded: () => 0,
    announceMidJoin: noop,
    warnMidJoinBlind: noop,
    referencedFileIds: playlistLib.referencedFileIds,
    isItemReady: playlistLib.isItemReady,
    window: { sw: { player, store } },
    location: { reload: () => timeline.push(['reload']) },
    setTimeout,
    // 默认的空 stub
    renderFilmInfo: noop,
    renderStatus: noop,
    renderProgress: noop,
    refreshMediaUi: noop,
    renderPlaylistSoon: noop,
    renderReady: noop,
    updateLocalReady: noop,
    maybeAutoStart: noop,
    setScanTicker: noop,
    announceGone: noop,
    pumpScans: noop,
    showDepsHelp: noop,
    desiredPlayerKind: () => ({ kind: 'mpv', reason: '' }),
    playerName: () => 'mpv',
    renderPlayerControls: noop,
    updatePlayerSwitchHint: noop,
    reportLaunchFailure: (error) => logs.push([`启动 mpv 失败：${error?.message || error}`, 'bad']),
    scheduleTransferUpdate: noop,
    attachLocalFiles: noop,
    initSwarmAndSync: noop,
    enterRoom: async () => {},
    releaseUnreferenced: noop,
    isRoomHost: () => true,
    linkFollowMode: () => 'full',
    siteApproved: () => false,
    cancelPrepJob: noop,
    manifestCandidates: () => [],
    activateLinkItem: async () => {},
    ...stubs,
  };
  vm.createContext(ctx);
  vm.runInContext(fns.map(fnSource).join('\n\n'), ctx, { filename: 'app.js（节选）' });
  return { ctx, S, timeline, player, store, logs, $ };
}

/** 真的同步引擎（桌面端那份），假时钟，播放器命令吞掉。 */
async function engine({ peerId = 'host', hostId = 'host', admins = [], isSeeder = false } = {}) {
  const { SyncEngine } = await load('syncEngine.js');
  const eng = new SyncEngine({ peerId, name: peerId, isSeeder, hostId });
  const clock = { t: 1000 };
  eng.now = () => clock.t;
  eng.onSeek = async () => {};
  eng.onSetPause = async () => {};
  eng.applyRoles(admins.map((id) => [id, 'admin']), hostId);
  eng.started = true;
  return { eng, clock };
}

function seederSession(item, filePath, sessionId) {
  return {
    fileId: item.fileId,
    slot: item.slot,
    manifest: { fileId: item.fileId, name: item.name, size: item.size, chunkCount: item.chunkCount },
    sessionId,
    filePath,
    isSeeder: true,
    state: { sessionId },
    safety: { sessionId, status: 'trusted-local' },
  };
}

function leechSession(item, filePath, sessionId, status = 'waiting-download') {
  return { ...seederSession(item, filePath, sessionId), isSeeder: false, safety: { sessionId, status } };
}

/* ----------------------------- 播放器代号闸门 ----------------------------- */

test('PlayerGate：认下代号后只收这一代；退掉之后旧代的事件和在途启动全部作废', async () => {
  const { PlayerGate } = await load('playerGate.js');
  const gate = new PlayerGate();
  let ticket = gate.begin();
  // 回包之前就到的这一代 tick：先记下，不处理
  assert.equal(gate.acceptTick({ gen: 1, duration: 60 }), false);
  const early = gate.confirm(1, ticket);
  assert.deepEqual(early.tick, { gen: 1, duration: 60 }, '回包前先到的 tick 要补上，片长只推这一次');
  assert.equal(gate.acceptTick({ gen: 1 }), true);
  assert.equal(gate.acceptTick({ gen: 0 }), false);
  assert.equal(gate.acceptTick({ position: 3 }), false, '不带代号的一律不认');

  // 换片：旧一代迟到的 tick / exit 全丢
  gate.retire();
  assert.equal(gate.acceptTick({ gen: 1, eof: true }), false);
  assert.equal(gate.acceptExit({ gen: 1 }), false);

  // 启动期间又被叫退：回包凭票据认出自己作废
  ticket = gate.begin();
  gate.retire();
  assert.equal(gate.confirm(2, ticket), null);
  assert.equal(gate.acceptTick({ gen: 2 }), false);

  // 新一代起来后，旧一代先记下的事件不会被当成新一代的补上
  ticket = gate.begin();
  gate.acceptTick({ gen: 2, eof: true });
  gate.acceptExit({ gen: 2 });
  assert.deepEqual(gate.confirm(3, ticket), { tick: null, exit: null });
  assert.equal(gate.acceptExit({ gen: 2 }), false);
  assert.equal(gate.acceptExit({ gen: 3 }), true, '当前这一代真退出了要认');
  assert.equal(gate.gen, null);
  assert.equal(gate.acceptTick({ gen: 3 }), false);

  // 记下的事件有上限
  for (let g = 10; g < 30; g++) gate.acceptTick({ gen: g });
  assert.ok(gate.early.size <= 4);
});

const SWITCH_FNS = [
  'onPlayerTick',
  'onPlayerExit',
  'handlePlayerTick',
  'handlePlayerExit',
  'retirePlayer',
  'launchPlayer',
  'switchCurrent',
  'currentSession',
  'currentFileCtx',
  'syncCurrentMirrors',
  'playbackAllowed',
];

/** 房主本机做种放 A，播到头；列表推进到 B。 */
async function playingRoom() {
  const { eng } = await engine({ isSeeder: true });
  const room = await makeRoom({ fns: SWITCH_FNS, sync: eng, stubs: { onFileItemCurrent: () => {} } });
  const { ctx, S } = room;
  const a = fileItem('A', { slot: 1, durationSec: 600 });
  const b = fileItem('B', { slot: 2, durationSec: 7200 });
  S.sessions.set('A', seederSession(a, 'D:/A.mkv', 'sa'));
  S.sessions.set('B', seederSession(b, 'D:/B.mkv', 'sb'));
  S.swarm.files.set(1, { slot: 1, complete: true, contiguousBytes: a.size });
  S.swarm.files.set(2, { slot: 2, complete: true, contiguousBytes: b.size });
  S.current = a;
  S.currentSeq = 1;
  S.playlist.seq = 1;
  eng.resetMedia({ isSeeder: true, seq: 1 });
  ctx.syncCurrentMirrors();
  const ended = [];
  eng.on('eof', () => ended.push(S.currentSeq));
  return { ...room, eng, a, b, ended };
}

test('换片后旧播放器迟到的 eof tick 不会以新 seq 再报一次放完（下一部不被跳过）', async () => {
  const { ctx, S, eng, b, ended, player } = await playingRoom();
  await ctx.launchPlayer();
  assert.equal(ctx.playerGate.gen, 1);
  ctx.onPlayerTick({ gen: 1, position: 590, paused: false, eof: false, duration: 600, streamPos: 1e8 });
  ctx.onPlayerTick({ gen: 1, position: 600, paused: false, eof: true, duration: 600, streamPos: 1.9e9 });
  assert.deepEqual(ended, [1]);

  // 房主处理 eof → 列表推进 → 换到 B。主进程还没处理到 quit。
  player.holdQuit = true;
  S.playlist.seq = 2;
  const switching = ctx.switchCurrent(b);
  // 主进程在 quit 之前已经发出的两条 tick（音轨尾巴的 time-pos，带着 eof=true）
  ctx.onPlayerTick({ gen: 1, position: 600.05, paused: false, eof: true, duration: 600, streamPos: 1.9e9 });
  ctx.onPlayerTick({ gen: 1, position: 600.1, paused: true, eof: true, duration: 600, streamPos: 1.9e9 });
  assert.deepEqual(ended, [1], '迟到的 eof 以新 seq 又报了一次放完：下一部会被整部跳过');
  assert.equal(eng.lastTick, null, '旧片的 tick 留在了新片的 lastTick 里');
  assert.equal(eng.duration, 7200, '旧片的片长覆盖了新片的');
  assert.deepEqual(S.swarm.durations.filter(([slot]) => slot === 2), [], '旧片的片长写进了新片的调度器');

  player.quits.forEach((q) => q.d.resolve());
  await switching;
  assert.equal(S.switchingMedia, false);
});

test('新播放器回包之前先到的 tick 会补上，片长不丢', async () => {
  const { ctx, eng, player } = await playingRoom();
  player.holdLaunch = true;
  const launching = ctx.launchPlayer();
  // mpv 暂停时片长只推这一次，偏偏赶在回包前面到了
  ctx.onPlayerTick({ gen: 1, position: 0, paused: true, eof: false, duration: 777, streamPos: 0 });
  assert.equal(eng.lastTick, null, '代号还没确认，不该先处理');
  player.launches[0].reply();
  await launching;
  assert.equal(eng.lastTick?.gen, 1);
  assert.equal(eng.duration, 777);
  assert.equal(ctx.S.mpvRunning, true);
});

test('启动期间换了片：上一部那个播放器的 tick、exit 都不算数，也不会误退新播放器', async () => {
  const { ctx, S, eng, b, player } = await playingRoom();
  player.holdLaunch = true;
  const first = ctx.launchPlayer(); // 给 A 拉起播放器，主进程还没回包

  S.playlist.seq = 2;
  await ctx.switchCurrent(b); // quit 立刻回包（主进程那时还没有当前播放器）
  assert.equal(S.switchingMedia, false);

  const second = ctx.launchPlayer(); // 给 B 拉起
  // 主进程先把 A 的播放器拉起来了：它的 tick 在 switchingMedia 已经清掉之后才到
  ctx.onPlayerTick({ gen: 1, position: 42, paused: false, eof: false, duration: 600, streamPos: 5e7 });
  player.launches[0].reply();
  await first;
  const quitOld = player.quits.at(-1);
  assert.equal(quitOld.gen, 1, '作废的那一代要按代号退掉');
  player.launches[1].reply();
  await second;
  assert.equal(ctx.playerGate.gen, 2);
  assert.equal(eng.lastTick, null, '上一部播放器的 tick 被当成了新播放器的');
  assert.notEqual(eng.duration, 600);

  // 上一部播放器迟到的 exit 不能把新播放器打成已关闭
  ctx.onPlayerExit({ gen: 1, code: 0 });
  assert.equal(S.mpvRunning, true);
  // 新播放器自己的 tick 照收，真退出也照认
  ctx.onPlayerTick({ gen: 2, position: 1, paused: true, eof: false, duration: 7200, streamPos: 0 });
  assert.equal(eng.lastTick?.gen, 2);
  ctx.onPlayerExit({ gen: 2, code: 0 });
  assert.equal(S.mpvRunning, false);
  assert.equal(eng.lastTick, null);
});

/* ------------------------ 接收中的当前项改成本地做种 ------------------------ */

const HANDOVER_FNS = [
  'addLocalFile',
  'trackPending',
  'trackClosing',
  'retirePlayer',
  'newSession',
  'currentSession',
  'syncCurrentMirrors',
  'onCurrentSessionReady',
  'launchPlayer',
  'playbackAllowed',
  'maybeLaunchPlayer',
  'fileItemOf',
  'openLeechFor',
  'evictableSessions',
  'evictionVictim',
  'parseFreeBytes',
  'handlePlayerTick',
  'handlePlayerExit',
];

async function handoverRoom(mode) {
  const { eng } = await engine({ peerId: 'me', hostId: 'host', admins: ['me'] });
  let room;
  const x = fileItem('X', { slot: 1 });
  const stubs = {
    submitPlaylistOp: async () => ({ ok: true }),
    // 同 onPlaylistChanged：会话挂到槽位上，swarm.addFile 当场发出 progress，seq 没变
    onPlaylistChanged: () => {
      const { S, ctx } = room;
      const sess = S.sessions.get('X');
      if (sess.slot !== x.slot) {
        sess.slot = x.slot;
        S.swarm.files.set(x.slot, { slot: x.slot, complete: true, contiguousBytes: x.size });
        const p = { slot: x.slot, contiguousBytes: x.size, complete: true };
        S.sync.onBufferProgress(p);
        ctx.maybeLaunchPlayer(p);
      }
      S.current = { ...x };
    },
  };
  room = await makeRoom({ fns: HANDOVER_FNS, sync: eng, stubs });
  const { ctx, S } = room;
  S.roomSecurityMode = mode;
  S.playlist.queue = [x];
  S.playlist.seq = 1;
  S.currentSeq = 1;
  S.current = x;
  S.knownManifests.set('X', { fileId: 'X', name: x.name, size: x.size, chunkCount: x.chunkCount });
  S.swarm.progress = (slot) => ({ slot, contiguousBytes: x.size, complete: true });
  eng.resetMedia({ seq: 1 });
  return { ...room, eng, x };
}

const manifestX = (x) => ({ fileId: 'X', name: x.name, size: x.size, chunkSize: x.chunkSize, chunkCount: x.chunkCount });

test('可信房间边下边播时改成本地做种：先退播放器等它退完再删缓存，然后用本地文件重新起播', async () => {
  const { ctx, S, eng, x, player, timeline } = await handoverRoom('trusted');
  const leech = leechSession(x, 'C:/cache/run/x.mkv', 'leech-1', 'trusted-streaming');
  S.sessions.set('X', leech);
  S.swarm.files.set(1, { slot: 1, complete: false, contiguousBytes: 3e8 });
  ctx.syncCurrentMirrors();
  await ctx.launchPlayer();
  assert.equal(S.mpvRunning, true);
  eng.onMpvTick({ gen: 1, position: 100, paused: false, streamPos: 2e8 }, { contiguousBytes: 3e8, complete: false });

  player.holdQuit = true;
  const adding = ctx.addLocalFile({ manifest: manifestX(x), state: { sessionId: 'seed-2' }, filePath: 'D:/films/x.mkv' });
  await flush();
  assert.equal(S.mpvRunning, false, '改做种前没退掉正读着接收缓存的播放器');
  assert.ok(!timeline.some(([k, id]) => k === 'close' && id === 'leech-1'), '播放器还没退完就删了缓存');
  assert.equal(S.filePath, null, '等待期间镜像还指着要删的缓存');
  // 等待期间 updateTransfer 触发：不能趁机再开一个接收会话
  await ctx.openLeechFor(x);
  assert.equal(openCount(timeline), 0, '改做种期间又开了一个接收会话');

  player.quits.forEach((q) => q.d.resolve());
  await adding;
  const order = timeline.map(([k, id]) => `${k}:${id}`);
  assert.ok(order.indexOf('quit-done:null') < order.indexOf('close:leech-1'), `顺序不对：${order.join(' → ')}`);
  assert.equal(S.sessionId, 'seed-2');
  assert.equal(S.filePath, 'D:/films/x.mkv');
  assert.equal(S.isSeeder, true);
  assert.equal(eng.isSeeder, true, '同步引擎还把本机当接收方');
  assert.equal(S.mediaSafety.status, 'trusted-local');
  const launched = timeline.filter(([k]) => k === 'launch').map(([, file]) => file);
  assert.deepEqual(launched, ['C:/cache/run/x.mkv', 'D:/films/x.mkv'], '要用本地源文件重新起播，不能再用已删的缓存路径');
  assert.equal(S.mpvRunning, true);
  assert.equal(eng.localStalled, false);
});

function openCount(timeline) {
  return timeline.filter(([k]) => k === 'openLeech').length;
}

test('安全模式还没收完时改成本地做种：本地有完整文件就直接能放，不再卡在「正在完整接收」', async () => {
  const { ctx, S, eng, x, timeline } = await handoverRoom('safe');
  S.sessions.set('X', leechSession(x, 'C:/cache/run/x.mkv', 'leech-1', 'waiting-download'));
  S.swarm.files.set(1, { slot: 1, complete: false, contiguousBytes: 1e6 });
  ctx.syncCurrentMirrors();
  eng.onBufferProgress({ contiguousBytes: 1e6, complete: false });
  assert.equal(eng.localStalled, true);

  await ctx.addLocalFile({ manifest: manifestX(x), state: { sessionId: 'seed-2' }, filePath: 'D:/films/x.mkv' });
  assert.equal(ctx.playbackAllowed(), true, '本地有完整文件却不让放');
  assert.equal(S.mediaSafety.status, 'trusted-local');
  const launched = timeline.filter(([k]) => k === 'launch').map(([, file]) => file);
  assert.deepEqual(launched, ['D:/films/x.mkv']);
  assert.equal(eng.localStalled, false);
  assert.ok(timeline.some(([k, id]) => k === 'close' && id === 'leech-1'));
});

/* ------------------------- 当前项本机收不下时的卡顿 ------------------------- */

const OPTOUT_FNS = [
  'onFileItemCurrent',
  'localOptedOut',
  'skipCurrentLocally',
  'openLeechFor',
  'evictableSessions',
  'evictionVictim',
  'parseFreeBytes',
  'localReadyNow',
  'updateLocalReady',
  'evictableSession',
  'closeSession',
  'trackPending',
  'trackClosing',
  'newSession',
  'renderFilmInfo',
];

/** 管理员 A 和房主 H 两台引擎，A 的出站消息直接送进 H。 */
async function optOutRoom() {
  const { eng: a } = await engine({ peerId: 'A', hostId: 'H', admins: ['A'] });
  const { eng: h } = await engine({ peerId: 'H', hostId: 'H', admins: ['A'], isSeeder: true });
  a.on('outbound', (msg) => h.onCtrl(msg, { peerId: 'A', name: 'A' }));
  a.resetMedia({ seq: 3 });
  h.resetMedia({ seq: 3, isSeeder: true });
  const room = await makeRoom({ fns: OPTOUT_FNS, sync: a, stubs: { onCurrentSessionReady: () => {} } });
  const x = fileItem('X', { slot: 3 });
  const { S } = room;
  S.peerId = 'A';
  S.playlist.queue = [x];
  S.playlist.seq = 3;
  S.currentSeq = 3;
  S.current = x;
  S.sourceType = 'file';
  S.knownManifests.set('X', { fileId: 'X', name: x.name, size: x.size, chunkCount: x.chunkCount });
  $meta(room);
  return { ...room, a, h, x };
}

function $meta(room) {
  room.meta = room.$('room-meta');
}

test('当前项本机磁盘放不下：不按 0 字节喊停，全房不用一直等我', async () => {
  const { ctx, S, a, h, x, meta } = await optOutRoom();
  S.diskFull.add('X');
  ctx.onFileItemCurrent(x);
  assert.equal(a.localStalled, false, '本机收不下的片还在参与卡顿判断');
  assert.equal(h.roomStalled, false, '全房在等一个永远收不下这部片的人');
  assert.equal(a.localReady, true, '收不下的人也算准备好了，不挡自动开播');
  assert.match(meta.textContent, /本机磁盘放不下，这一部跳过/);

  // 被拒收过的片同理
  S.diskFull.clear();
  S.blockedFiles.add('X');
  a.resetMedia({ seq: 3 });
  ctx.onFileItemCurrent(x);
  assert.equal(a.localStalled, false);
  assert.equal(h.roomStalled, false);

  // 能收的片照旧参与：手上一片都没有，就得让别人等
  S.blockedFiles.clear();
  a.resetMedia({ seq: 3 });
  ctx.onFileItemCurrent(x);
  assert.equal(a.localStalled, true);
  assert.equal(h.roomStalled, true);
});

for (const [label, message, set] of [
  ['磁盘空间不够', "Error invoking remote method 'store:openLeech': Error: 磁盘空间不够：这部片子需要 2.0GB，缓存所在的磁盘只剩 1.0GB", 'diskFull'],
  ['清单被拒', "Error invoking remote method 'store:openLeech': TypeError: 无效的清单", 'blockedFiles'],
]) {
  test(`已经按 0 字节喊了停，随后开接收会话失败（${label}）：放掉本机的卡顿`, async () => {
    const { ctx, S, a, h, x, store } = await optOutRoom();
    ctx.onFileItemCurrent(x);
    assert.equal(h.roomStalled, true);
    store.openImpl = () => Promise.reject(new Error(message));
    await ctx.openLeechFor(x);
    assert.ok(S[set].has('X'));
    assert.equal(a.localStalled, false, '收不下的当前项把全房永久卡住了');
    assert.equal(h.roomStalled, false);
    assert.equal(a.localReady, true);
    assert.equal(S.sessions.size, 0);
  });
}

test('卡顿解除文案有英文', async () => {
  const { translate } = await load('i18n.js');
  assert.equal(
    translate('本机磁盘放不下这一部，已跳过，不影响其他人', 'en'),
    "This video doesn't fit on this computer's disk. Skipped here without holding up anyone else"
  );
  assert.equal(
    translate('2.0 GB · 安全模式 · 扫描后播放 · 本机磁盘放不下，这一部跳过', 'en'),
    "2.0 GB · Safe mode · Play after scanning · Doesn't fit on this computer's disk; skipped here"
  );
  // 原有两种状态不受影响
  assert.equal(
    translate('2.0 GB · 可信房间 · 边下边播 · 正在获取清单…', 'en'),
    '2.0 GB · Trusted room · Progressive playback · Fetching the manifest…'
  );
  assert.equal(
    translate('2.0 GB · 安全模式 · 扫描后播放 · 这部片已被拒绝接收', 'en'),
    '2.0 GB · Safe mode · Play after scanning · This video was refused'
  );
  // 横幅真的会显示这句
  assert.match(fnSource('renderStatus'), /本机磁盘放不下这一部，已跳过，不影响其他人/);
});

/* ----------------------------- 扫出威胁时的播放器 ----------------------------- */

const BLOCK_FNS = [
  'blockScannedSession',
  'destroyBlockedSession',
  'retirePlayer',
  'trackPending',
  'trackClosing',
  'currentSession',
  'playbackAllowed',
  'onPlayerExit',
  'handlePlayerExit',
];

async function blockRoom() {
  const { eng } = await engine({ peerId: 'me', hostId: 'host' });
  const room = await makeRoom({ fns: BLOCK_FNS, sync: eng });
  const { ctx, S } = room;
  const x = fileItem('X', { slot: 1 });
  const sess = leechSession(x, 'C:/cache/run/x.mkv', 'leech-1', 'scanning');
  S.roomSecurityMode = 'trusted';
  S.sessions.set('X', sess);
  S.current = x;
  S.sessionId = 'leech-1';
  S.filePath = sess.filePath;
  S.mediaSafety = sess.safety;
  S.mpvRunning = true;
  ctx.playerGate.confirm(1, ctx.playerGate.begin());
  eng.onMpvTick({ gen: 1, position: 50, paused: false, streamPos: 1e8 }, { contiguousBytes: x.size, complete: true });
  return { ...room, eng, sess };
}

test('扫出威胁退掉正在边下边播的播放器：播放器状态当场复位，等它退完才删缓存', async () => {
  const { ctx, S, eng, sess, player, timeline, $ } = await blockRoom();
  player.holdQuit = true;
  const blocking = ctx.blockScannedSession(sess, '发现威胁');
  assert.equal(S.mpvRunning, false, '播放器已经退了，界面还当它开着');
  assert.equal(eng.lastTick, null, '旧 tick 还在，时间显示会一直往前推');
  assert.equal(ctx.playerGate.gen, null);
  assert.equal($('btn-playpause').disabled, true);
  assert.equal(ctx.playbackAllowed(), false, 'blocked 之后不能被重新拉起');
  await flush();
  assert.ok(!timeline.some(([k]) => k === 'close'), '播放器还没放开文件就删缓存');
  // 退出时主进程已经摘了监听器；就算有迟到的 exit 也不该再处理一遍
  ctx.onPlayerExit({ gen: 1, code: 0 });
  assert.equal($('btn-reopen').classList.contains('hidden'), true, '被主动退掉的播放器不该露出「重新打开」');

  player.quits.forEach((q) => q.d.resolve());
  await blocking;
  const order = timeline.map(([k, id]) => `${k}:${id}`);
  assert.ok(order.indexOf('quit-done:null') < order.indexOf('close:leech-1'), order.join(' → '));
  assert.equal(S.filePath, null);
  assert.ok(S.blockedFiles.has('X'));
  await S.playerQuit;
});

test('扫出威胁后等播放器退出期间换了片：不去清新一部的镜像', async () => {
  const { ctx, S, sess, player } = await blockRoom();
  player.holdQuit = true;
  const blocking = ctx.blockScannedSession(sess, '发现威胁');
  // 等待期间列表换到了下一部
  S.currentSeq = 2;
  S.current = fileItem('Y', { slot: 2 });
  S.sessionId = 'seed-y';
  S.filePath = 'D:/y.mkv';
  S.manifest = { fileId: 'Y' };
  player.quits.forEach((q) => q.d.resolve());
  await blocking;
  assert.equal(S.filePath, 'D:/y.mkv');
  assert.equal(S.sessionId, 'seed-y');
  assert.deepEqual(S.manifest, { fileId: 'Y' });
});

/* ----------------------------- 离开房间的收尾 ----------------------------- */

const LEAVE_FNS = [
  'leaveRoom',
  'retirePlayer',
  'closeSession',
  'trackPending',
  'trackClosing',
  'openLeechFor',
  'evictableSessions',
  'evictionVictim',
  'parseFreeBytes',
  'newSession',
  'evictableSession',
  'localOptedOut',
  'skipCurrentLocally',
];

test('离开房间：等换片时还没退完的播放器、正在关的会话、在途打开的会话，都收完尾才刷新页面', async () => {
  const room = await makeRoom({ fns: LEAVE_FNS, sync: (await engine()).eng });
  const { ctx, S, player, store, timeline } = room;
  const a = fileItem('A', { slot: 1 });
  const b = fileItem('B', { slot: 2 });
  const c = fileItem('C', { slot: 3 });
  S.playlist.queue = [a, c];
  S.sessions.set('A', leechSession(a, 'C:/cache/a.mkv', 'sa'));
  S.knownManifests.set('C', { fileId: 'C', name: c.name, size: c.size, chunkCount: c.chunkCount });

  // 房主删掉了正在放的 B：换片发出 quit（旧 mpv 要几百毫秒才退完），B 的会话被摘掉、等着关
  player.holdQuit = true;
  ctx.retirePlayer();
  const closingB = ctx.closeSession(leechSession(b, 'C:/cache/b.mkv', 'sb'));
  // 同时 C 的接收会话正在打开
  const open = deferred();
  store.openImpl = () => open.promise;
  const opening = ctx.openLeechFor(c);
  await flush();
  assert.equal(S.leechOpens.size, 1);

  // 点「离开」：这次 quit 主进程立刻回包（它已经没有当前播放器了）
  player.holdQuit = false;
  const leaving = ctx.leaveRoom();
  await flush();
  assert.ok(!timeline.some(([k]) => k === 'reload'), '旧播放器还没退完、B 还没关就刷新了页面');

  timeline.push(['old-mpv-exited']);
  player.quits[0].d.resolve(); // 旧 mpv 终于退了
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(timeline.some(([k, id]) => k === 'close-done' && id === 'sb'), 'B 早该关完了');
  assert.ok(!timeline.some(([k]) => k === 'reload'), 'C 的打开请求还在途就刷新了页面');
  open.resolve({ sessionId: 'sc', filePath: 'C:/cache/c.mkv' });
  await leaving;
  await closingB;
  await opening;

  const order = timeline.map(([k, id]) => `${k}:${id}`);
  const reloadAt = order.indexOf('reload:undefined');
  assert.ok(reloadAt > 0, order.join(' → '));
  for (const id of ['sa', 'sb', 'sc']) {
    const at = order.indexOf(`close-done:${id}`);
    assert.ok(at >= 0 && at < reloadAt, `会话 ${id} 没在刷新前关完：${order.join(' → ')}`);
  }
  assert.ok(order.indexOf('old-mpv-exited:undefined') < order.indexOf('close:sb'), '旧播放器退完之前就删了 B 的缓存');
  assert.equal(S.sessions.has('C'), false, '离开途中打开的会话不该再登记');
});

test('离开房间：主进程还在关的会话（删缓存要重试一阵）关完了才刷新页面', async () => {
  const room = await makeRoom({ fns: LEAVE_FNS, sync: (await engine()).eng });
  const { ctx, store, timeline } = room;
  // 已经从 S.sessions 摘掉、关闭请求已经发出去的会话；主进程删缓存遇到占用要重试一阵。
  // 不等它关完就刷新，回到首页马上改缓存目录会因为「还有会话开着」被拒
  store.closeDelayMs.sb = 40;
  const closingB = ctx.closeSession(leechSession(fileItem('B'), 'C:/cache/b.mkv', 'sb'));
  await flush();
  assert.ok(timeline.some(([k, id]) => k === 'close' && id === 'sb'));
  await ctx.leaveRoom();
  await closingB;
  const order = timeline.map(([k, id]) => `${k}:${id}`);
  assert.ok(order.indexOf('close-done:sb') < order.indexOf('reload:undefined'), order.join(' → '));
});

test('换片途中离开房间：旧播放器还攥着文件时，不去关仍被引用的会话', async () => {
  const room = await makeRoom({ fns: LEAVE_FNS, sync: (await engine()).eng });
  const { ctx, S, player, timeline } = room;
  const a = fileItem('A', { slot: 1 });
  S.playlist.history = [a];
  S.sessions.set('A', leechSession(a, 'C:/cache/a.mkv', 'sa')); // 刚放完，还在已播放区里
  player.holdQuit = true;
  ctx.retirePlayer(); // 换片发出的 quit，旧 mpv 正读着 A 的缓存
  player.holdQuit = false;
  const leaving = ctx.leaveRoom();
  await flush();
  assert.ok(!timeline.some(([k]) => k === 'close'), '旧播放器还没退完就去删它正读着的缓存');
  timeline.push(['old-mpv-exited']);
  player.quits[0].d.resolve();
  await leaving;
  const order = timeline.map(([k, id]) => `${k}:${id}`);
  assert.ok(order.indexOf('old-mpv-exited:undefined') < order.indexOf('close:sa'), order.join(' → '));
  assert.ok(order.indexOf('close:sa') < order.indexOf('reload:undefined'), order.join(' → '));
});

/* ------------------- 换片叫停扫描后又换回来（P4 已修，防回归） ------------------- */

test('给当前项让路被叫停的扫描，这部片又成了当前项时自动重扫，不记成「扫描已停止」', async () => {
  const policy = await load('scanPolicy.js');
  const room = await makeRoom({
    fns: ['pumpScans', 'verifyReceivedMedia', 'applyScanResult', 'currentSession'],
    sync: (await engine()).eng,
    stubs: {
      needsScan: policy.needsScan,
      pickScanTarget: policy.pickScanTarget,
      shouldPreempt: policy.shouldPreempt,
      decideScanOutcome: policy.decideScanOutcome,
      blockScannedSession: async () => {},
      launchPlayer: async () => {},
      updateLocalReady: () => {},
    },
  });
  const { ctx, S, store } = room;
  const a = fileItem('A', { slot: 1 });
  const b = fileItem('B', { slot: 2 });
  const sa = leechSession(a, 'C:/cache/a.mkv', 'sa');
  const sb = leechSession(b, 'C:/cache/b.mkv', 'sb');
  S.sessions.set('A', sa);
  S.sessions.set('B', sb);
  S.swarm.files.set(1, { complete: true });
  S.swarm.files.set(2, { complete: true });

  S.playlist.queue = [a, b];
  S.current = a;
  ctx.pumpScans();
  assert.deepEqual(store.scans.map((s) => s.sessionId), ['sa']);

  // 换到 B：B 收完了要先扫，A 让路
  S.playlist.queue = [b, a];
  S.current = b;
  ctx.pumpScans();
  assert.deepEqual(store.cancels, ['sa']);
  // 叫停的结果回来之前又换回 A
  S.playlist.queue = [a, b];
  S.current = a;
  ctx.pumpScans();

  store.scans[0].d.resolve({ ok: false, status: 'cancelled', message: '扫描已取消' });
  await flush();
  assert.notEqual(sa.safety.status, 'scan-stopped', '换片叫停的扫描被当成了用户手动停止');
  assert.deepEqual(store.scans.map((s) => s.sessionId), ['sa', 'sa'], 'A 又是当前项了，应当接着扫');
  store.scans[1].d.resolve({ ok: true, status: 'clean' });
  await flush();
  assert.equal(sa.safety.status, 'clean');
});
