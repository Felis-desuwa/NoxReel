'use strict';

/**
 * 中途加入的三道门槛（app.js 编排层）的真行为测试：起播、就绪、跳转。
 *
 * 为什么单开一份：`test/roomFlowFixes.test.js` 里把 `roomPlayheadByte` / `startRunNeeded`
 * 直接打桩成 0（那批用例本来就只测换片时序，房间位置恒为 0），于是 maybeLaunchPlayer /
 * localReadyNow / applySeek 里的中途加入分支在测试里一次都没执行过。这里把它们真跑一遍。
 *
 * 手法和 roomFlowFixes 一样：把 app.js 的顶层函数原样抠进 vm 沙箱，周围配假依赖 ——
 * 测的是仓库里真实的函数体。全程不启动任何播放器，不出声。
 */

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

const MB = 1024 * 1024;
const CHUNK = 2 * MB;
const SIZE = 300 * MB;
const DURATION = 300; // 码率 1MB/s

/** app.js 顶层函数的源码：从声明行到下一个顶格的 `}`。 */
function fnSource(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层函数 ${name}`);
  const end = APP.indexOf('\n}\n', m.index);
  assert.ok(end > m.index, `${name} 的结尾没找到`);
  return APP.slice(m.index, end + 2);
}

/** app.js 顶层常量的值（这几个是门槛的一部分，抄一份就会和源码脱钩）。 */
function constValue(name) {
  const m = new RegExp(`^const ${name} = ([^;]+);`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到常量 ${name}`);
  return vm.runInNewContext(m[1]);
}

const FNS = [
  'mediaBitrate',
  'roomPositionSec',
  'midJoinNow',
  'roomPlayheadByte',
  'startRunNeeded',
  'warnMidJoinBlind',
  'announceMidJoin',
  'maybeLaunchPlayer',
  'localReadyNow',
  'applySeek',
];

/**
 * 沙箱。sync 传真的同步引擎（房间时钟要真走），swarm 用一份按位图算的小假实现 ——
 * runBytes 的算法本身在 midJoinRun.test.js 里对着真 swarm 验过了。
 */
async function makeSandbox({ have, durationSec = DURATION, mode = 'trusted', roomPosition = 0, complete = false } = {}) {
  const { bitrateOf } = await load('stallForecast.js');
  const { isItemReady } = await load('playlist.js');
  const { runEndFrom } = await load('swarm.js');
  const { SyncEngine } = await load('syncEngine.js');

  const manifest = {
    fileId: 'a'.repeat(32),
    name: 'film.mkv',
    size: SIZE,
    chunkSize: CHUNK,
    chunkCount: SIZE / CHUNK,
    durationSec,
  };
  const bits = have || new Uint8Array(SIZE / CHUNK);
  const contiguous = () => {
    let i = 0;
    while (i < bits.length && bits[i]) i++;
    return Math.min(i * CHUNK, SIZE);
  };

  const eng = new SyncEngine({ peerId: 'me', name: 'me', isSeeder: false, hostId: 'host' });
  const clock = { t: 1000 };
  eng.now = () => clock.t;
  eng.onSeek = async () => {};
  eng.onSetPause = async () => {};
  eng.started = true;
  eng.sizeHint = SIZE;
  if (durationSec > 0) eng.setMediaInfo({ duration: durationSec, size: SIZE });
  // 房间已经放到 roomPosition 秒（房主的 SYNC）
  eng.applyRoles([['me', 'admin']], 'host');
  eng.onCtrl(
    { t: 'sync', paused: true, position: roomPosition, lamport: 5, seq: 0 },
    { peerId: 'host', name: '房主' }
  );

  const item = {
    kind: 'file',
    id: 'it-a',
    fileId: manifest.fileId,
    slot: 1,
    name: manifest.name,
    size: SIZE,
    chunkSize: CHUNK,
    chunkCount: manifest.chunkCount,
    durationSec,
  };
  const playbackByte = { value: 0 };
  const progress = () => {
    const pb = Math.max(0, Math.min(SIZE, playbackByte.value));
    const runEnd = runEndFrom(bits, manifest, pb);
    return {
      slot: 1,
      contiguousBytes: contiguous(),
      contiguousRatio: contiguous() / SIZE,
      playbackByte: pb,
      runEndBytes: runEnd,
      runBytes: runEnd - pb,
      complete,
      ratio: bits.reduce((a, b) => a + b, 0) / bits.length,
      downRate: 0,
    };
  };

  const logs = [];
  const launches = [];
  const playerCalls = [];
  const S = {
    manifest,
    current: item,
    currentSeq: 1,
    midJoinNoted: -1,
    midJoinBlindNoted: -1,
    mpvRunning: false,
    isSeeder: false,
    filePath: 'D:/cache/film.mkv',
    sourceType: 'file',
    switchingMedia: false,
    roomSecurityMode: mode,
    mediaSafety: { status: 'waiting-download' },
    blockedFiles: new Set(),
    diskFull: new Set(),
    skippedLinks: new Set(),
    linkInfo: null,
    sessions: new Map([[manifest.fileId, { slot: 1, isSeeder: false, safety: { status: 'waiting-download' } }]]),
    sync: eng,
    swarm: {
      playingSlot: 1,
      files: new Map([[1, { slot: 1, contiguousBytes: contiguous(), complete }]]),
      progress,
      setPlaybackByte: (slot, byte) => {
        playbackByte.value = byte;
      },
    },
  };

  const ctx = {
    S,
    bitrateOf,
    isItemReady,
    HEAD_READY_BYTES: constValue('HEAD_READY_BYTES'),
    START_RUN_SECONDS: constValue('START_RUN_SECONDS'),
    DEMUX_READAHEAD_SECONDS: constValue('DEMUX_READAHEAD_SECONDS'),
    MIN_START_RUN_BYTES: constValue('MIN_START_RUN_BYTES'),
    log: (text, kind) => logs.push([text, kind]),
    t: (s) => s,
    localOptedOut: (it) => it?.kind === 'file' && (S.blockedFiles.has(it.fileId) || S.diskFull.has(it.fileId)),
    siteApproved: () => false,
    currentFileCtx: () => ({
      slot: 1,
      scheduler: { positionToByte: (sec) => (sec / (durationSec || 1)) * SIZE },
    }),
    launchPlayer: async () => {
      launches.push(true);
      S.mpvRunning = true;
    },
    window: {
      sw: {
        player: {
          osd: async () => {},
          setPause: async (p) => {
            playerCalls.push(['pause', p]);
          },
          seek: async (p) => {
            playerCalls.push(['seek', p]);
          },
        },
      },
    },
    setTimeout,
    Promise,
    Math,
    JSON,
  };
  vm.createContext(ctx);
  vm.runInContext(FNS.map(fnSource).join('\n\n'), ctx, { filename: 'app.js（节选）' });
  return { ctx, S, eng, clock, logs, launches, playerCalls, progress, playbackByte, item, manifest };
}

/** 位图：给定若干 [起片, 止片) 区间置 1。 */
function bitmap(ranges) {
  const have = new Uint8Array(SIZE / CHUNK);
  for (const [from, to] of ranges) for (let i = from; i < to; i++) have[i] = 1;
  return have;
}

/* ------------------------- 房间位置与起播门槛本身 ------------------------- */

test('roomPlayheadByte 按文件大小封顶 —— 时长探测偏小时不能算出文件以外的位置', async () => {
  // 清单里的时长只有真实值的一半（探测偏小），码率随之偏大一倍
  const { ctx, S, eng, clock } = await makeSandbox({
    durationSec: 150,
    roomPosition: 0,
    have: bitmap([[0, 4]]),
  });
  // 播放器报的是真实时间轴上的 200 秒，按偏大的码率折算出 400MB —— 文件只有 300MB。
  // （stream-pos 拿不到时才走这条折算路：安卓、PotPlayer 都没有 stream-pos。）
  eng.onMpvTick(
    { position: 200, paused: true, eof: false, streamPos: 0, sampledAt: clock.t },
    { contiguousBytes: 8 * MB, runBytes: 0, complete: false }
  );
  assert.equal(ctx.roomPlayheadByte(), SIZE, '超出文件大小的位置必须封顶');
  // 封不住的话「到片尾还剩多少」是负数、取 0，起播门槛恒满足 —— 门槛等于没有
  assert.equal(ctx.startRunNeeded(S.manifest.size, ctx.roomPlayheadByte()), 0);
  assert.ok(ctx.startRunNeeded(S.manifest.size, SIZE - 30 * MB) > 0);
});

test('越界的播放位置不会让成员面板把所有人都显示成「已收完」', async () => {
  const { runEndFrom } = await load('swarm.js');
  const meta = { size: SIZE, chunkSize: CHUNK, chunkCount: SIZE / CHUNK };
  const poor = bitmap([[0, 4]]); // 对方只有片头
  // runEndFrom 对「越过文件尾」的位置一律返回 size —— 谁传进来一个越界的位置，
  // 谁就会看到「每个人都能一路播到尾」。所以调用方必须先封顶。
  assert.equal(runEndFrom(poor, meta, SIZE + 10 * MB), SIZE);
  assert.equal(runEndFrom(poor, meta, 100 * MB), 100 * MB, '封顶之后才看得出他其实一个字节都供不了');
});

test('startRunNeeded：按码率算，靠近片尾时按「到片尾还剩多少」封顶', async () => {
  const { ctx } = await makeSandbox({ have: bitmap([[0, 4]]) });
  const need = ctx.startRunNeeded(SIZE, 0);
  assert.equal(need, (15 + 2) * MB, '恢复线 15 秒 + 解复用预读 2 秒，码率 1MB/s');
  assert.equal(ctx.startRunNeeded(SIZE, SIZE - 3 * MB), 3 * MB, '片尾只剩 3MB 就只要 3MB');
  assert.equal(ctx.startRunNeeded(SIZE, SIZE), 0);
});

/* ----------------------------- 起播（maybeLaunchPlayer） ----------------------------- */

test('中途加入：片头够了但起播点附近没数据，不起播', async () => {
  // 片头 8MB 有了，房间放到 100 秒（100MB 处）那里是空洞
  const { ctx, S, launches, progress } = await makeSandbox({
    have: bitmap([[0, 4]]),
    roomPosition: 100,
  });
  S.swarm.setPlaybackByte(1, ctx.roomPlayheadByte());
  ctx.maybeLaunchPlayer(progress());
  assert.equal(launches.length, 0, '起播点落在空洞上就起播，一上来就撞连续区尽头');
  assert.equal(S.mediaSafety.status, 'waiting-download');
});

test('中途加入：起播点往后攒够 15 秒余量才起播', async () => {
  const { ctx, S, launches, progress } = await makeSandbox({
    // 片头 8MB + [100MB, 116MB)：从 100MB 起只有 16MB，差一点点
    have: bitmap([[0, 4], [50, 58]]),
    roomPosition: 100,
  });
  S.swarm.setPlaybackByte(1, ctx.roomPlayheadByte());
  assert.equal(progress().runBytes, 16 * MB);
  ctx.maybeLaunchPlayer(progress());
  assert.equal(launches.length, 0, '16MB 还不到 17MB 的门槛');

  // 再补一片就够了
  const { ctx: ctx2, S: S2, launches: l2, progress: p2 } = await makeSandbox({
    have: bitmap([[0, 4], [50, 60]]),
    roomPosition: 100,
  });
  S2.swarm.setPlaybackByte(1, ctx2.roomPlayheadByte());
  assert.equal(p2().runBytes, 20 * MB);
  ctx2.maybeLaunchPlayer(p2());
  assert.equal(l2.length, 1, '门槛到了就该起播');
  assert.equal(S2.mediaSafety.status, 'trusted-streaming');
});

test('从片头一起开始放的房间不受中途加入门槛影响（片头够了就播）', async () => {
  const { ctx, launches, progress } = await makeSandbox({ have: bitmap([[0, 4]]), roomPosition: 0 });
  ctx.maybeLaunchPlayer(progress());
  assert.equal(launches.length, 1, '房间还在片头，8MB 门槛照旧');
});

test('中途加入但清单里没有时长：不提前起播，并且说明原因', async () => {
  // 房主没装 ffmpeg → 清单里没有 durationSec → 码率为 0 → 房间位置换不出字节数。
  // 只看「字节位置 > 0」的话这一整套门槛会静默失效：片头够了就起播，
  // 起播后再跳到房间位置，正好落在空洞里。
  const { ctx, S, launches, logs, progress } = await makeSandbox({
    have: bitmap([[0, 4]]),
    durationSec: 0,
    roomPosition: 100,
  });
  assert.equal(ctx.mediaBitrate(), 0);
  assert.equal(ctx.roomPlayheadByte(), 0, '码率未知时折算不出字节位置');
  assert.equal(ctx.midJoinNow(), true, '但房间确实已经放到 100 秒了');

  ctx.maybeLaunchPlayer(progress());
  assert.equal(launches.length, 0, '算不出房间播到哪就起播，等于蒙眼跳进空洞');
  assert.ok(
    logs.some(([text]) => /片源没提供时长/.test(text)),
    `要告诉用户为什么一直不播，实际日志：${JSON.stringify(logs)}`
  );
  // 同一部只说一次
  ctx.maybeLaunchPlayer(progress());
  assert.equal(logs.filter(([text]) => /片源没提供时长/.test(text)).length, 1);

  // 整部收完就没有空洞可撞了，照常起播
  S.swarm.files.get(1).complete = true;
  ctx.maybeLaunchPlayer({ ...progress(), complete: true });
  assert.equal(launches.length, 1);
});

test('安全模式不受中途加入门槛影响：收完并扫描通过才播', async () => {
  const { ctx, S, launches, progress } = await makeSandbox({
    have: bitmap([[0, 150]]),
    roomPosition: 100,
    mode: 'safe',
    complete: true,
  });
  S.mediaSafety.status = 'clean';
  ctx.maybeLaunchPlayer(progress());
  assert.equal(launches.length, 1);
});

/* ----------------------------- 就绪（localReadyNow） ----------------------------- */

test('localReadyNow 走的是同一套判据：起播点附近没数据就不算准备好', async () => {
  const { ctx, S, progress } = await makeSandbox({ have: bitmap([[0, 4]]), roomPosition: 100 });
  S.swarm.setPlaybackByte(1, ctx.roomPlayheadByte());
  assert.equal(ctx.localReadyNow(), false, '只看片头会让全员就绪之后立刻全员卡死');

  const full = await makeSandbox({ have: bitmap([[0, 4], [50, 60]]), roomPosition: 100 });
  full.S.swarm.setPlaybackByte(1, full.ctx.roomPlayheadByte());
  assert.equal(full.progress().runBytes, 20 * MB);
  assert.equal(full.ctx.localReadyNow(), true);
});

test('localReadyNow：清单里没有时长时，中途加入的人等收完才算准备好', async () => {
  const { ctx, S } = await makeSandbox({ have: bitmap([[0, 4]]), durationSec: 0, roomPosition: 100 });
  assert.equal(ctx.localReadyNow(), false);
  S.swarm.files.get(1).complete = true;
  assert.equal(ctx.localReadyNow(), true, '收完了就没有空洞可撞');
});

test('localReadyNow：房间还在片头时，没有时长也照旧只看片头', async () => {
  const { ctx } = await makeSandbox({ have: bitmap([[0, 4]]), durationSec: 0, roomPosition: 0 });
  assert.equal(ctx.localReadyNow(), true);
});

/* ----------------------------- 跳转（applySeek） ----------------------------- */

test('跳到还没收到的位置：先暂停再跳，并且当场重算卡顿', async () => {
  const { ctx, eng, playerCalls, logs } = await makeSandbox({
    have: bitmap([[0, 4], [50, 60]]),
    roomPosition: 100,
  });
  await ctx.applySeek(30); // 30 秒 = 30MB 处，空洞
  assert.deepEqual(playerCalls[0], ['pause', true], '不先暂停的话 mpv 会在空洞上花掉一帧再跳几秒');
  assert.deepEqual(playerCalls[1], ['seek', 30]);
  assert.ok(logs.some(([text]) => /跳转到的位置还没收到/.test(text)));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(eng.localStalled, true, '等下一条 tick 已经晚了，那时播放器早读到洞里了');
});

test('跳到已经收到的位置：不多按一次暂停', async () => {
  const { ctx, eng, playerCalls } = await makeSandbox({
    have: bitmap([[0, 4], [50, 60]]),
    roomPosition: 100,
  });
  await ctx.applySeek(105); // 105 秒 = 105MB，落在 [100MB,120MB) 里
  assert.deepEqual(playerCalls, [['seek', 105]]);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(eng.localStalled, false);
});

/* ------------------------------ 中途加入的提示 ------------------------------ */

test('中途加入说一句，从片头起播的房间不说', async () => {
  const mid = await makeSandbox({ have: bitmap([[0, 4]]), roomPosition: 100 });
  mid.ctx.announceMidJoin(mid.S.sessions.get(mid.manifest.fileId), mid.progress());
  assert.ok(mid.logs.some(([text]) => /你是中途加入的/.test(text)));
  // MKV 的索引常在文件尾，调度器会先去取，这件事也要说
  assert.ok(mid.logs.some(([text]) => /正在优先获取索引/.test(text)));

  const head = await makeSandbox({ have: bitmap([[0, 4]]), roomPosition: 0 });
  head.ctx.announceMidJoin(head.S.sessions.get(head.manifest.fileId), head.progress());
  assert.deepEqual(head.logs, []);
});

test('清单里没有时长也认得出「中途加入」这件事', async () => {
  const { ctx, S, logs, progress, manifest } = await makeSandbox({
    have: bitmap([[0, 4]]),
    durationSec: 0,
    roomPosition: 100,
  });
  ctx.announceMidJoin(S.sessions.get(manifest.fileId), progress());
  assert.ok(
    logs.some(([text]) => /你是中途加入的/.test(text)),
    '按字节位置判断的话这里恒为 0，用户只会看到「片头早就够了却还不播」'
  );
});
