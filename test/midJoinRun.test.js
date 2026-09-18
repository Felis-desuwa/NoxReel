'use strict';

/**
 * 中途加入（可信房间）：卡顿余量从「从文件头起的连续水位线」改成
 * 「从播放位置起连续可读的字节数」（runBytes）。
 *
 * 旧算法在中途加入时算出的是 `contiguousBytes - P`，也就是一个绝对值接近整部片的负数：
 * 晚到的人一进房就报卡，把全房拖停一个完整的下载周期。runBytes 说的才是
 * 「播放器现在从脚下往后还能安全读多远」—— 这是唯一能拿来判卡顿和判起播的数。
 *
 * 桌面端和安卓端跑同一份共享库，所有引擎用例都对两份各跑一遍。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { IMPLS } = require('./helpers/impls');

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

const MB = 1024 * 1024;
const CHUNK = 2 * MB;
const SIZE = 100 * CHUNK; // 200MB
const DURATION = 200; // 秒 → 码率 1MB/s，stall 线 5MB、恢复线 15MB
const META = { size: SIZE, chunkSize: CHUNK, chunkCount: 100 };

/** 位图：给定若干 [起片, 止片) 区间置 1。 */
function bitmap(ranges) {
  const have = new Uint8Array(META.chunkCount);
  for (const [from, to] of ranges) for (let i = from; i < to; i++) have[i] = 1;
  return have;
}

/** 带假时钟的引擎，媒体信息已喂好（码率 1MB/s）。 */
async function makeEngine(dir, { isSeeder = false } = {}) {
  const { SyncEngine } = await import(dir + 'syncEngine.js');
  const eng = new SyncEngine({ peerId: 'me', name: 'me', isSeeder, hostId: 'host' });
  const clock = { t: 1000 };
  eng.now = () => clock.t;
  const out = [];
  const margins = [];
  const eofs = [];
  const dataEnds = [];
  eng.on('outbound', (m) => out.push(m));
  eng.on('margin', (m) => margins.push(m));
  eng.on('eof', (e) => eofs.push(e));
  eng.on('data-end', (e) => dataEnds.push(e));
  eng.onSeek = () => {};
  eng.onSetPause = () => {};
  eng.setMediaInfo({ duration: DURATION, size: SIZE });
  eng.sizeHint = SIZE;
  eng.started = true;
  return { eng, clock, out, margins, eofs, dataEnds };
}

/* ------------------------------ 1. runEndFrom 本身 ------------------------------ */

impl('runEndFrom：洞里返回原位置，run 里返回这一段的末尾，末片封顶到文件大小', async (dir) => {
  const { runEndFrom } = await import(dir + 'swarm.js');
  const have = bitmap([[0, 4], [50, 60]]); // 片头 8MB + [100MB, 120MB)

  // 落在洞里：一个字节都读不了，返回起算位置本身
  assert.equal(runEndFrom(have, META, 20 * MB), 20 * MB);
  assert.equal(runEndFrom(have, META, 99 * MB), 99 * MB);
  // 落在 run 里：返回这一段连续片的末尾
  assert.equal(runEndFrom(have, META, 0), 8 * MB);
  assert.equal(runEndFrom(have, META, 3 * MB), 8 * MB);
  assert.equal(runEndFrom(have, META, 100 * MB), 120 * MB);
  assert.equal(runEndFrom(have, META, 119 * MB), 120 * MB);
  // 边界：正好落在 run 的第一个字节 / 洞的第一个字节
  assert.equal(runEndFrom(have, META, 8 * MB), 8 * MB, '8MB 起那一片还没到，读不出东西');
  assert.equal(runEndFrom(have, META, 120 * MB), 120 * MB);
  // 越界与封顶
  assert.equal(runEndFrom(have, META, SIZE), SIZE);
  assert.equal(runEndFrom(have, META, SIZE + 999), SIZE);
  assert.equal(runEndFrom(have, META, -5), 8 * MB, '负数按 0 算');
  // 缺参数一律返回 0，不抛
  assert.equal(runEndFrom(null, META, 0), 0);
  assert.equal(runEndFrom(have, null, 0), 0);
});

impl('runEndFrom：末片不足 chunkSize 时不超过文件大小', async (dir) => {
  const { runEndFrom } = await import(dir + 'swarm.js');
  // 最后一片只有 1MB
  const meta = { size: 99 * CHUNK + MB, chunkSize: CHUNK, chunkCount: 100 };
  const have = new Uint8Array(100).fill(1);
  assert.equal(runEndFrom(have, meta, 0), meta.size, '按片数乘会超出文件，必须封顶');
  assert.equal(runEndFrom(have, meta, meta.size - 1), meta.size);
});

/* ------------------------------ 2~4. 卡顿判据 ------------------------------ */

impl('中途加入：片头 8MB + 播放位置起 20MB 连续 → 不报卡顿', async (dir) => {
  const { runEndFrom } = await import(dir + 'swarm.js');
  const { eng } = await makeEngine(dir);
  const have = bitmap([[0, 4], [50, 60]]);
  const P = 100 * MB;
  const runBytes = runEndFrom(have, META, P) - P;
  assert.equal(runBytes, 20 * MB);

  eng.onMpvTick(
    { position: P / MB, paused: false, streamPos: P, sampledAt: 0 },
    { contiguousBytes: 8 * MB, runBytes, complete: false }
  );
  assert.equal(eng.localStalled, false, '身前有 20 秒的连续内容却报了卡顿');
});

impl('中途加入：播放位置处没数据 → 报卡顿；只靠下载进度也能解除', async (dir) => {
  const { eng, out } = await makeEngine(dir);
  // 管理员才广播卡顿（游客的缓冲不足只暂停自己），这里要连广播一起验
  eng.applyRoles([['me', 'admin'], ['host', 'admin']], 'host');
  const P = 100 * MB;
  eng.onMpvTick(
    { position: P / MB, paused: false, streamPos: P, sampledAt: 0 },
    { contiguousBytes: 8 * MB, runBytes: 0, complete: false }
  );
  assert.equal(eng.localStalled, true);

  // 全员暂停后播放器静止不再推 tick，只剩下载进度这条路能解锁
  eng.onBufferProgress({ contiguousBytes: 8 * MB, runBytes: 10 * MB, complete: false });
  assert.equal(eng.localStalled, true, '10MB 还没过 15MB 的恢复线，滞回区里保持原状');
  eng.onBufferProgress({ contiguousBytes: 8 * MB, runBytes: 16 * MB, complete: false });
  assert.equal(eng.localStalled, false, '攒够 16 秒还解不开 —— 旧算法要等水位线越过 P 才行');

  const stalls = out.filter((m) => m.t === 'stall');
  assert.deepEqual(stalls.map((m) => m.stalled), [true, false]);
});

impl('播放器还没起来时，本机的播放位置是房间位置，不是 0', async (dir) => {
  const { eng, margins } = await makeEngine(dir);
  // 房间已经放到 100 秒（= 100MB），本机还在等片头
  eng.onCtrl({ t: 'sync', paused: false, position: 100, lamport: 5, seq: 0 }, { peerId: 'host', name: '房主' });
  assert.equal(eng.lastTick, null, '这一路必须在播放器起来之前跑');

  // 不传 runBytes：走回退分支，margin = contiguousBytes - 播放位置。
  // 兜底快照写 0 的话这里是 8MB - 0 = 8MB（看起来很健康），实际上一帧都放不了。
  eng.onBufferProgress({ contiguousBytes: 8 * MB, complete: false });
  const last = margins[margins.length - 1];
  assert.ok(Math.abs(last.playbackByte - 100 * MB) < MB, `兜底快照的播放位置是 ${last.playbackByte}`);
  assert.equal(eng.localStalled, true, '房间已经放到 100MB 处，本机手上只有片头，必须报卡顿');
});

/* ------------------------------ 5. eof 守卫 ------------------------------ */

impl('连续区尽头报的 eof 不是「放完了」：进卡顿，不推进播放列表', async (dir) => {
  const { eng, eofs, dataEnds } = await makeEngine(dir);
  const P = 100 * MB;
  eng.onMpvTick({ position: 99, paused: false, streamPos: P - MB, sampledAt: 0 }, { contiguousBytes: 8 * MB, runBytes: 5 * MB, complete: false });
  // mpv 读到手上这段连续数据的末尾，keep-open 下停在最后一帧并报 eof（退出码 0）
  eng.onMpvTick(
    { position: 120, paused: true, eof: true, streamPos: 120 * MB, sampledAt: 1000 },
    { contiguousBytes: 8 * MB, runBytes: 0, complete: false }
  );
  assert.equal(eofs.length, 0, '数据断流被当成放完了，会直接跳下一部');
  assert.equal(dataEnds.length, 1, '要说一句「播到已接收内容的末尾」');
  assert.equal(eng.localStalled, true);
  // 重复的 eof tick 不重复刷屏
  eng.onMpvTick(
    { position: 120, paused: true, eof: true, streamPos: 120 * MB, sampledAt: 1200 },
    { contiguousBytes: 8 * MB, runBytes: 0, complete: false }
  );
  assert.equal(dataEnds.length, 1);
});

impl('真的放到片尾（连续数据一路到文件尾）照旧报 eof', async (dir) => {
  const { eng, eofs } = await makeEngine(dir);
  const P = SIZE - 10 * MB;
  eng.onMpvTick(
    { position: 199, paused: true, eof: true, streamPos: P, sampledAt: 1000 },
    { contiguousBytes: 8 * MB, runBytes: 10 * MB, complete: false }
  );
  assert.equal(eofs.length, 1, '手上有一路连到文件尾的数据，这就是真片尾');
});

impl('不传 runBytes 时 eof 守卫整个让开（回退开关）', async (dir) => {
  const { eng, eofs } = await makeEngine(dir);
  eng.onMpvTick({ position: 120, paused: true, eof: true, sampledAt: 1000 }, { contiguousBytes: 8 * MB, complete: false });
  assert.equal(eofs.length, 1, '停传 runBytes 就该退回 0.6 的行为');
});

/* --------------------- 5b. 从「读到已接收内容的末尾」恢复 --------------------- */

/**
 * 一台会回话的假 mpv。
 *  - 暂停属性一变就推回一条 tick（真 mpv 就是这么干的）；
 *  - 停在 eof 上时那条 tick 仍然带 eof=true —— 它不会自己回头去读新落盘的分片；
 *  - 收到 seek 才重新解复用，离开 eof 从新位置继续。
 * 这台假 mpv 是整个用例的关键：没有「属性变化推回 tick」这一条，
 * eof 守卫和 _evaluateStall 打架的那个环就闭合不了。
 */
function fakeMpv(eng, clock, { position = 120 } = {}) {
  const cmds = [];
  const pending = [];
  const state = { position, paused: true, eof: true };
  eng.onSeek = (p) => {
    cmds.push(['seek', Number(p.toFixed(2))]);
    state.position = p;
    state.eof = false;
    pending.push({ ...state });
  };
  eng.onSetPause = (p) => {
    cmds.push(['pause', !!p]);
    if (!!p === state.paused) return;
    state.paused = !!p;
    pending.push({ ...state });
  };
  return {
    cmds,
    state,
    /** 把播放器排着的 tick 都喂回引擎（每轮之间让引擎里的微任务跑完）。 */
    async drain(buffer, rounds = 12) {
      for (let i = 0; i < rounds; i++) {
        for (let r = 0; r < 4; r++) await new Promise((res) => setImmediate(res));
        if (!pending.length) break;
        const snap = pending.shift();
        clock.t += 100;
        eng.onMpvTick({ ...snap, streamPos: snap.position * MB, sampledAt: clock.t }, buffer());
      }
    },
    /** 插一条播放器还没处理完 seek 时推上来的旧 tick（仍停在 eof）。 */
    stale() {
      pending.unshift({ position, paused: state.paused, eof: true });
    },
  };
}

impl('撞到连续区尽头后补齐分片：只发一对 STALL，并且让播放器重新解复用', async (dir) => {
  const { eng, clock, out } = await makeEngine(dir);
  eng.applyRoles([['me', 'admin'], ['host', 'admin']], 'host');
  eng.intendedPaused = false; // 房间在播
  const mpv = fakeMpv(eng, clock);
  let runBytes = 1 * MB;
  const buffer = () => ({ contiguousBytes: 8 * MB, runBytes, complete: false });

  eng.onMpvTick({ position: 119, paused: false, eof: false, streamPos: 119 * MB, sampledAt: clock.t }, buffer());
  mpv.state.paused = false;
  // 撞上连续区尽头
  runBytes = 0;
  clock.t += 100;
  eng.onMpvTick({ position: 120, paused: false, eof: true, streamPos: 120 * MB, sampledAt: clock.t }, buffer());
  assert.equal(eng.localStalled, true);
  await mpv.drain(buffer);

  // 分片补齐，越过 15 秒的恢复线。全员暂停后播放器静止，只剩下载进度这条路能解锁
  runBytes = 20 * MB;
  eng.onBufferProgress(buffer());
  await mpv.drain(buffer);

  const stalls = out.filter((m) => m.t === 'stall').map((m) => m.stalled);
  assert.deepEqual(
    stalls,
    [true, false],
    `STALL 来回抖了：${JSON.stringify(stalls)}。守卫和 _evaluateStall 互相打架，全房按 IPC 的速度反复暂停/播放`
  );
  const seeks = mpv.cmds.filter((c) => c[0] === 'seek');
  assert.equal(seeks.length, 1, '光放开暂停没用：mpv 停在 eof 上不会回头去读新落盘的分片');
  assert.ok(seeks[0][1] < 120 && seeks[0][1] >= 119, `重放要落在断点之前的关键帧上，实际跳到 ${seeks[0][1]}`);
  assert.equal(eng.localStalled, false);
  assert.equal(mpv.state.eof, false, '播放器还停在 eof 上，这一部再也播不下去了');
  assert.deepEqual(mpv.cmds.at(-1), ['pause', false], '重放之后要恢复播放');
});

impl('重放的跳转不能被 seekTolerance 挡掉 —— 目标就在当前位置附近', async (dir) => {
  const { eng, clock } = await makeEngine(dir);
  const mpv = fakeMpv(eng, clock);
  let runBytes = 0;
  const buffer = () => ({ contiguousBytes: 8 * MB, runBytes, complete: false });
  eng.onMpvTick({ position: 120, paused: false, eof: true, streamPos: 120 * MB, sampledAt: clock.t }, buffer());
  assert.equal(eng.localStalled, true);
  // 容差比重放的回跳量大得多：按偏差判断这一跳一定被挡掉
  assert.ok(eng.seekTolerance >= 0.75);
  runBytes = 20 * MB;
  eng.onBufferProgress(buffer());
  await mpv.drain(buffer);
  assert.equal(mpv.cmds.filter((c) => c[0] === 'seek').length, 1);
});

impl('重放还没落地时播放器推上来的旧 eof tick 不会把卡顿立刻置回去', async (dir) => {
  const { eng, clock, out } = await makeEngine(dir);
  eng.applyRoles([['me', 'admin'], ['host', 'admin']], 'host');
  eng.intendedPaused = false;
  const mpv = fakeMpv(eng, clock);
  let runBytes = 0;
  const buffer = () => ({ contiguousBytes: 8 * MB, runBytes, complete: false });
  eng.onMpvTick({ position: 120, paused: false, eof: true, streamPos: 120 * MB, sampledAt: clock.t }, buffer());
  await mpv.drain(buffer);

  runBytes = 20 * MB;
  eng.onBufferProgress(buffer());
  mpv.stale(); // seek 还在路上，mpv 先把「我还在 eof」推了上来
  await mpv.drain(buffer);

  const stalls = out.filter((m) => m.t === 'stall').map((m) => m.stalled);
  assert.deepEqual(stalls, [true, false], `跳转途中的旧 tick 又把卡顿置回去了：${JSON.stringify(stalls)}`);
  assert.equal(eng.localStalled, false);
});

impl('播放器赖在 eof 上不动时，卡顿状态保持不变，不来回广播', async (dir) => {
  const { eng, clock, out } = await makeEngine(dir);
  eng.applyRoles([['me', 'admin'], ['host', 'admin']], 'host');
  eng.intendedPaused = false;
  // 这台假 mpv 收到 seek 也不动（重放没生效：命令丢了、或者它就是读不出来）
  eng.onSeek = () => {};
  eng.onSetPause = () => {};

  let runBytes = 0;
  const tick = () => {
    clock.t += 500; // 拉开到重放窗口之外，让每一条 eof tick 都真的参与判断
    eng.onMpvTick(
      { position: 120, paused: true, eof: true, streamPos: 120 * MB, sampledAt: clock.t },
      { contiguousBytes: 8 * MB, runBytes, complete: false }
    );
  };
  tick();
  assert.equal(eng.localStalled, true);

  // 分片补齐了，可是播放器还赖在 eof 上。守卫要是排在 _evaluateStall 后面，
  // 就成了「前一句解除、后一句置上」，每条 tick 发一对 STALL，全房反复暂停/播放。
  runBytes = 20 * MB;
  for (let i = 0; i < 4; i++) tick();

  const stalls = out.filter((m) => m.t === 'stall').map((m) => m.stalled);
  assert.deepEqual(stalls, [true], `STALL 来回抖了：${JSON.stringify(stalls)}`);
  assert.equal(eng.localStalled, true, '播放器还停在数据尽头，这时候放开只会让所有人干看着一张静止画面');
});

impl('换片会清掉「读到末尾」的状态，下一部不会莫名其妙先跳一下', async (dir) => {
  const { eng, clock } = await makeEngine(dir);
  const mpv = fakeMpv(eng, clock);
  eng.onMpvTick({ position: 120, paused: false, eof: true, streamPos: 120 * MB, sampledAt: clock.t }, { contiguousBytes: 8 * MB, runBytes: 0, complete: false });
  assert.equal(eng.localStalled, true);

  eng.resetMedia({ seq: 1 });
  eng.setMediaInfo({ duration: DURATION, size: SIZE });
  eng.sizeHint = SIZE;
  eng.started = true;
  mpv.cmds.length = 0;
  // 新的一部从片头起播，余量充足
  eng.onMpvTick({ position: 0, paused: true, eof: false, streamPos: 0, sampledAt: clock.t }, { contiguousBytes: 30 * MB, runBytes: 30 * MB, complete: false });
  assert.equal(eng.localStalled, false);
  assert.deepEqual(mpv.cmds.filter((c) => c[0] === 'seek'), [], '上一部的重放不能带到下一部');
});

/* ------------------------------ 6. 跳转后立即重算 ------------------------------ */

impl('跳到没收到的位置：同一轮就进卡顿，不等下一条 tick', async (dir) => {
  const { eng } = await makeEngine(dir);
  eng.onMpvTick({ position: 100, paused: false, streamPos: 100 * MB, sampledAt: 0 }, { contiguousBytes: 8 * MB, runBytes: 20 * MB, complete: false });
  assert.equal(eng.localStalled, false);

  eng._evaluateStallNow(30, { contiguousBytes: 8 * MB, runBytes: 0, complete: false });
  assert.equal(eng.localStalled, true, '跳进空洞后要当场暂停，等下一条 tick 已经读到洞里了');

  // 合成快照不能污染 lastTick（它是「播放器真实状态」的唯一来源）
  assert.equal(eng.lastTick.position, 100);
});

/* ------------------------------ 7. 做种与已完成 ------------------------------ */

impl('做种方和已收完的人不受 runBytes 影响', async (dir) => {
  const seeder = await makeEngine(dir, { isSeeder: true });
  seeder.eng.onMpvTick({ position: 100, paused: false, sampledAt: 0 }, { contiguousBytes: 0, runBytes: 0, complete: false });
  assert.equal(seeder.eng.localStalled, false, '做种方永远不会卡在缓冲上');

  const done = await makeEngine(dir);
  done.eng.onMpvTick({ position: 100, paused: false, sampledAt: 0 }, { contiguousBytes: SIZE, runBytes: 0, complete: true });
  assert.equal(done.eng.localStalled, false);
});

/* ------------------------------ 14~15. swarm 的 progress / peerInfo ------------------------------ */

const manifestOf = () => ({
  fileId: 'a'.repeat(32),
  name: 'film.mkv',
  size: SIZE,
  chunkSize: CHUNK,
  chunkCount: META.chunkCount,
  hashes: Array.from({ length: META.chunkCount }, (_, i) => i.toString(16).padStart(64, '0')),
  durationSec: DURATION,
});

async function makeSwarm(dir, have) {
  const { Swarm } = await import(dir + 'swarm.js');
  const swarm = new Swarm({ peerId: 'me', name: 'me' });
  swarm.addFile({ slot: 0, manifest: manifestOf(), sessionId: 's1', isSeeder: false });
  const ctx = swarm.files.get(0);
  ctx.have.set(have);
  ctx.haveCount = have.reduce((a, b) => a + b, 0);
  swarm.setPlaying(0);
  return { swarm, ctx };
}

impl('progress 的 runBytes 跟着 setPlaybackByte 走', async (dir) => {
  const { swarm } = await makeSwarm(dir, bitmap([[0, 4], [50, 60]]));

  let p = swarm.progress(0);
  assert.equal(p.playbackByte, 0);
  assert.equal(p.runEndBytes, 8 * MB);
  assert.equal(p.runBytes, 8 * MB, '从片头起播时 runBytes 就是片头那一段');
  assert.equal(p.contiguousBytes, 0, 'contiguousBytes 由落盘结果推进，这里没走落盘，保持 0');

  swarm.setPlaybackByte(0, 100 * MB);
  p = swarm.progress(0);
  assert.equal(p.playbackByte, 100 * MB);
  assert.equal(p.runEndBytes, 120 * MB);
  assert.equal(p.runBytes, 20 * MB);

  // 播放位置落在洞里：一个字节都读不了，而不是负数
  swarm.setPlaybackByte(0, 30 * MB);
  p = swarm.progress(0);
  assert.equal(p.runBytes, 0);

  // 播放位置越过文件尾也不会算出负数
  swarm.setPlaybackByte(0, SIZE + 10 * MB);
  p = swarm.progress(0);
  assert.equal(p.playbackByte, SIZE);
  assert.equal(p.runBytes, 0);
});

impl('做种方的 runBytes 恒为「到文件尾还剩多少」', async (dir) => {
  const { Swarm } = await import(dir + 'swarm.js');
  const swarm = new Swarm({ peerId: 'me', name: 'me' });
  swarm.addFile({ slot: 0, manifest: manifestOf(), sessionId: 's1', isSeeder: true });
  swarm.setPlaying(0);
  swarm.setPlaybackByte(0, 60 * MB);
  const p = swarm.progress(0);
  assert.equal(p.complete, true);
  assert.equal(p.runEndBytes, SIZE);
  assert.equal(p.runBytes, SIZE - 60 * MB);
});

impl('第 0 片落地后，调度器按内容认出容器（改了名字也认得出）', async (dir) => {
  const { Swarm } = await import(dir + 'swarm.js');
  const prevWindow = globalThis.window;
  globalThis.window = {
    sw: {
      store: {
        writeChunk: async () => ({ ok: true, duplicate: false, haveCount: 1, contiguousBytes: CHUNK, complete: false }),
      },
    },
  };
  try {
    const swarm = new Swarm({ peerId: 'me', name: 'me' });
    // 名字叫 .mp4，内容其实是 MKV。只认扩展名的话尾部索引就不预留了 ——
    // 安卓的 MatroskaExtractor 在 prepare 阶段要 seek 到文件尾读 Cues，读不到永远转圈。
    const ctx = swarm.addFile({
      slot: 0,
      manifest: { ...manifestOf(), name: '其实是mkv.mp4' },
      sessionId: 's1',
      isSeeder: false,
    });
    assert.equal(ctx.scheduler.needsTailIndex(), true, '还没看到第 0 片，保守预留');

    const head = new Uint8Array(CHUNK);
    head.set([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x82, 0x88], 0); // EBML 魔数
    const peer = { peerId: 'up', name: 'up', inflight: new Set(), send: () => true, authenticated: true };
    await swarm._commitChunk(peer, ctx, 0, head);
    assert.equal(ctx.scheduler.headContainer, 'matroska');
    assert.equal(ctx.scheduler.needsTailIndex(), true);
  } finally {
    globalThis.window = prevWindow;
  }
});

impl('_peerInfo 的 remoteRunEndBytes 按房间位置算，remoteHeldBytes 仍是总持有量', async (dir) => {
  const { swarm } = await makeSwarm(dir, bitmap([[0, 4]]));
  swarm.setPlaybackByte(0, 100 * MB);

  const remoteHave = bitmap([[0, 4], [50, 60]]); // 片头 4 片 + [100MB,120MB) 共 14 片
  const peer = {
    peerId: 'other',
    name: 'other',
    platform: 'desktop',
    pc: { iceConnectionState: 'connected' },
    rtt: 0,
    downRate: 0,
    upRate: 0,
    bytesReceived: 0,
    bytesSent: 0,
    authenticated: true,
    inflight: new Set(),
    remote: new Map([[0, { have: remoteHave, full: false }]]),
  };

  const info = swarm._peerInfo(peer);
  assert.equal(info.remoteRunEndBytes, 120 * MB, '对方从房间位置起能连续播到 120MB');
  assert.equal(info.remoteHeldBytes, 14 * CHUNK, 'RateMeter 靠它测总收片速度，不能换成 run-from');
  assert.equal(info.remoteContiguousBytes, 8 * MB, '进度条要的完整度不变');

  // 对方在房间位置处没有数据
  const poor = { ...peer, remote: new Map([[0, { have: bitmap([[0, 4]]), full: false }]]) };
  assert.equal(swarm._peerInfo(poor).remoteRunEndBytes, 100 * MB, '洞里返回房间位置本身 = 一个字节都供不了');
});

/* ------------------------------ 12. 起播门槛 ------------------------------ */

impl('isItemReady：起播点不在片头时，光有片头不算准备好', async (dir) => {
  const P = await import(dir + 'playlist.js');
  const item = { kind: 'file', size: SIZE };
  const base = { mode: 'trusted', contiguousBytes: 8 * MB };

  // 从片头起播：和旧版一样只看片头
  assert.equal(P.isItemReady(item, base), true);
  assert.equal(P.isItemReady(item, { ...base, startByte: 0 }), true);
  assert.equal(P.isItemReady(item, { ...base, contiguousBytes: 8 * MB - 1 }), false);

  // 中途加入 / 回头接着放：还要求起播点往后有足够的连续数据
  const mid = { ...base, startByte: 100 * MB, runNeeded: 17 * MB };
  assert.equal(P.isItemReady(item, { ...mid, runBytes: 0 }), false);
  assert.equal(P.isItemReady(item, { ...mid, runBytes: 17 * MB - 1 }), false);
  assert.equal(P.isItemReady(item, { ...mid, runBytes: 17 * MB }), true);
  // 片头仍然是硬条件：起播点够了也不能少了容器索引
  assert.equal(P.isItemReady(item, { ...mid, contiguousBytes: 1 * MB, runBytes: 40 * MB }), false);
  // runNeeded 缺省（调用方还没接上）时退回只看片头，不会把人卡死在就绪上
  assert.equal(P.isItemReady(item, { ...base, startByte: 100 * MB, runBytes: 0 }), true);

  // 安全模式和片源不受影响
  assert.equal(P.isItemReady(item, { ...mid, mode: 'safe', complete: true, scanStatus: 'clean' }), true);
  assert.equal(P.isItemReady(item, { ...mid, isSeeder: true }), true);
});

impl('isItemReady：中途加入但算不出字节位置（码率未知）时，等收完才算准备好', async (dir) => {
  const P = await import(dir + 'playlist.js');
  const item = { kind: 'file', size: SIZE };
  // 房主没装 ffmpeg → 清单里没有时长 → 码率为 0 → 起播点的字节位置恒为 0。
  // 只看 startByte 的话这里会判成「从片头起播」，整套中途加入的门槛静默失效。
  const blind = { mode: 'trusted', contiguousBytes: 8 * MB, midJoin: true, startByte: 0, runBytes: 8 * MB };
  assert.equal(P.isItemReady(item, blind), false, '判不了起播点附近有没有数据时不能说自己准备好了');
  assert.equal(P.isItemReady(item, { ...blind, runBytes: SIZE }), false, 'runBytes 是从文件头算的，说明不了起播点');
  assert.equal(P.isItemReady(item, { ...blind, complete: true }), true, '整部收完就没有空洞可撞了');

  // 房间还在片头（谁都没开始放）：midJoin 为假，照旧只看片头
  assert.equal(P.isItemReady(item, { ...blind, midJoin: false }), true);
  // 字节位置算得出来时走原来那条路
  assert.equal(
    P.isItemReady(item, { ...blind, startByte: 100 * MB, runBytes: 17 * MB, runNeeded: 17 * MB }),
    true
  );
  assert.equal(
    P.isItemReady(item, { ...blind, startByte: 100 * MB, runBytes: 1 * MB, runNeeded: 17 * MB }),
    false
  );
  // 片源和安全模式不受影响
  assert.equal(P.isItemReady(item, { ...blind, isSeeder: true }), true);
  assert.equal(P.isItemReady(item, { ...blind, mode: 'safe', complete: true, scanStatus: 'clean' }), true);
});
