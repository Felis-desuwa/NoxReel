'use strict';

// 实测后的修复批次 F1（播放器与同步）：
//  - E5-A 可信房间边收边播的假 eof：正在接收的文件关掉 mpv 的缓存；stream-pos 越过已收到的内容就不信；
//    eof 要数据连到文件尾、而且位置到了片尾附近才认；解除卡顿的重放先 drop-buffers 再跳回停下的地方；
//  - E1-A 在线链接断流：mpv 同一毫秒先推 pause 再推 eof，属性变化合成一条 tick，控制者不再把「暂停」广播给全房；
//  - E1-C 只有 ffmpeg 拿到 HTTP 错误码（warn 级）时，原因照样认得出；
//  - E5-C 横幅的去重表只记真正发出去的。
// 引擎和调度器是桌面 / 安卓共用的两份，都跑。全程不启动播放器、不出声。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { IMPLS } = require('./helpers/impls');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

const MB = 1024 * 1024;
const CHUNK = 2 * MB;
const COUNT = 60;
const SIZE = COUNT * CHUNK; // 120MB
const DURATION = 120; // 码率 1MB/s：stall 线 5MB、恢复线 15MB
const META = { size: SIZE, chunkSize: CHUNK, chunkCount: COUNT };
// 实测：mp4 撞上数据尽头时 mpv 报的 stream-pos 离文件尾只差 26KB
const FAKE_STREAM_POS = SIZE - 26297;

/** 位图：给定若干 [起片, 止片) 区间置 1。 */
function bitmap(ranges) {
  const have = new Uint8Array(COUNT);
  for (const [from, to] of ranges) for (let i = from; i < to; i++) have[i] = 1;
  return have;
}

async function scheduler(dir) {
  const { Scheduler } = await import(dir + 'scheduler.js');
  return new Scheduler({ manifest: { ...META, durationSec: DURATION } });
}

const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};

/* ------------------------------ 调度器：stream-pos 核对 ------------------------------ */

impl('stream-pos 落在没收到的地方（撞上数据尽头时 mpv 报到文件尾附近）：不信它，按码率折算', async (dir) => {
  const s = await scheduler(dir);
  const have = bitmap([[0, 8]]); // 片头 16MB
  assert.equal(s.streamPosPlausible(FAKE_STREAM_POS, have), false);
  assert.equal(s.positionToByte(10.8, FAKE_STREAM_POS, have), 10.8 * MB);
  // 不给位图就是老调用方式，照旧信它
  assert.equal(s.positionToByte(10.8, FAKE_STREAM_POS), FAKE_STREAM_POS);
});

impl('读穿空洞落进早就收到的文件尾也骗不过：核对范围比文件尾保留区大', async (dir) => {
  const s = await scheduler(dir);
  const have = bitmap([[0, 8], [COUNT - 2, COUNT]]); // 片头 + 文件尾保留区 4MB（MKV 的 Cues）
  assert.equal(s.streamPosPlausible(SIZE, have), false);
  assert.equal(s.streamPosPlausible(SIZE - 1 * MB, have), false);
  assert.equal(s.positionToByte(10.8, SIZE, have), 10.8 * MB);
});

impl('正常播放时 stream-pos 身后都收到了：照旧用真值；收完的文件一律可信', async (dir) => {
  const s = await scheduler(dir);
  const have = bitmap([[0, 20]]);
  assert.equal(s.positionToByte(12, 12.5 * MB, have), 12.5 * MB);
  assert.equal(s.streamPosPlausible(3 * MB, have), true, '刚起播、身后还不到 8MB 的也算');
  assert.equal(s.streamPosPlausible(SIZE, bitmap([[0, COUNT]])), true);
});

impl('中途加入刚起播：stream-pos 身后是空洞就按码率折算，放出 8MB 之后又用回真值', async (dir) => {
  const s = await scheduler(dir);
  const have = bitmap([[0, 4], [40, 55]]); // 片头 8MB + 从 80MB 起 30MB
  assert.equal(s.positionToByte(80, 80.5 * MB, have), 80 * MB, '和起播前调度用的房间位置是同一个数');
  assert.equal(s.positionToByte(90, 90.3 * MB, have), 90.3 * MB);
});

/* ------------------------------ 同步引擎：数据尽头的 eof ------------------------------ */

/** 带假时钟、假 mpv 回调的引擎。当成管理员（卡顿要广播，好验证 STALL 发了几次）。 */
async function makeEngine(dir) {
  const { SyncEngine } = await import(dir + 'syncEngine.js');
  const { runEndFrom } = await import(dir + 'swarm.js');
  const sched = await scheduler(dir);
  const eng = new SyncEngine({ peerId: 'me', name: 'me', isSeeder: false, hostId: 'host' });
  const clock = { t: 1000 };
  eng.now = () => clock.t;
  const rec = { out: [], eofs: [], dataEnds: [], seeks: [], pauses: [] };
  eng.on('outbound', (m) => rec.out.push(m));
  eng.on('eof', (e) => rec.eofs.push(e));
  eng.on('data-end', (e) => rec.dataEnds.push(e));
  eng.onSeek = (p, opts) => rec.seeks.push([Number(p.toFixed(2)), opts?.dropBuffers === true]);
  eng.onSetPause = (p) => rec.pauses.push(p);
  eng.setMediaInfo({ duration: DURATION, size: SIZE });
  eng.sizeHint = SIZE;
  eng.started = true;
  eng.applyRoles([['me', 'admin']], 'host');
  eng.intendedPaused = false; // 房间在播
  /** 照 app.js 的 handlePlayerTick：播放字节按核对过的 stream-pos 算，runBytes / runEndBytes 出自同一个数。 */
  const buffer = (snap, have, complete = false) => {
    const byte = sched.positionToByte(snap.position, snap.streamPos, have);
    const runEndBytes = runEndFrom(have, META, byte);
    return { contiguousBytes: runEndFrom(have, META, 0), runBytes: runEndBytes - byte, runEndBytes, complete };
  };
  const tick = (fields, have, complete = false) => {
    clock.t += 500; // 拉开到回声窗口之外
    const snap = { paused: false, eof: false, sampledAt: clock.t, duration: DURATION, ...fields };
    eng.onMpvTick(snap, buffer(snap, have, complete));
  };
  const stalls = () => rec.out.filter((m) => m.t === 'stall').map((m) => m.stalled);
  return { eng, clock, rec, tick, buffer, stalls };
}

impl('stream-pos 跳到文件尾骗不过「放完了」：按缓冲不足处理，下载跟上后先 drop-buffers 再跳回停下的地方', async (dir) => {
  const { eng, rec, tick, stalls } = await makeEngine(dir);
  let have = bitmap([[0, 8]]); // 16MB
  tick({ position: 10, streamPos: 10 * MB }, have);
  assert.equal(eng.localStalled, false);
  // mpv 撞上数据尽头：停在最后一帧报 eof，stream-pos 报到了文件尾附近
  tick({ position: 10.8, paused: true, eof: true, streamPos: FAKE_STREAM_POS }, have);
  assert.deepEqual(rec.eofs, [], '60 秒的片放到 10.8 秒就被当成放完、推进到下一部');
  assert.equal(rec.dataEnds.length, 1);
  assert.equal(eng.localStalled, true);

  // 分片跟上了（还没收完）。以前按 stream-pos 算 runBytes 恒为 0，要一直停到收完
  have = bitmap([[0, 30]]);
  const byte = 10.8 * MB;
  eng.onBufferProgress({ contiguousBytes: 60 * MB, runBytes: 60 * MB - byte, complete: false });
  await flush();
  assert.equal(eng.localStalled, false);
  assert.deepEqual(stalls(), [true, false]);
  assert.deepEqual(rec.seeks, [[10.8, true]], '重放要跳回停下的地方，并且先让 mpv 丢掉缓存里的旧数据');
  assert.equal(rec.pauses.at(-1), false, '重放之后接着放');
  assert.deepEqual(rec.eofs, []);
});

impl('收完那一刻播放器还停在半路的 eof 上：不报放完，也不进卡顿（收完后没有下载进度来解除），就地重放', async (dir) => {
  const { eng, rec, tick, stalls } = await makeEngine(dir);
  const full = bitmap([[0, COUNT]]);
  tick({ position: 10, streamPos: 10 * MB }, full, true);
  tick({ position: 10.8, paused: true, eof: true, streamPos: FAKE_STREAM_POS }, full, true);
  assert.deepEqual(rec.eofs, []);
  assert.deepEqual(rec.seeks, [[10.8, true]]);
  assert.deepEqual(stalls(), [], '数据都在，不能让全房陪着等');
  assert.equal(eng.localStalled, false);
  await flush();
  // 跳过去接着放，一直放到真片尾
  tick({ position: 11.3, streamPos: 11.3 * MB }, full, true);
  tick({ position: 119.96, paused: true, eof: true, streamPos: SIZE }, full, true);
  assert.equal(rec.eofs.length, 1, '真的放到片尾照常报放完了');
  assert.equal(rec.seeks.length, 1);
});

impl('已经认过放完了：关窗口时 mpv 卸载文件（位置归零、eof 还挂着）那条 tick 不再重放、不进卡顿', async (dir) => {
  const { eng, rec, tick, stalls } = await makeEngine(dir);
  const full = bitmap([[0, COUNT]]);
  tick({ position: 119, streamPos: 119 * MB }, full, true);
  tick({ position: 119.96, paused: true, eof: true, streamPos: SIZE }, full, true);
  assert.equal(rec.eofs.length, 1);
  tick({ position: 0, paused: true, eof: true, streamPos: null }, full, true);
  tick({ position: 0, paused: true, eof: true, streamPos: null }, bitmap([[0, 8]]), false);
  assert.deepEqual(rec.seeks, [], '对着正在退出的播放器重放，只会换来一串管道已断的报错');
  assert.deepEqual(stalls(), []);
  assert.equal(eng.localStalled, false);
  assert.equal(rec.eofs.length, 1);
});

impl('片长写错的片子：放起来又停回同一个地方，就认它是真片尾', async (dir) => {
  const { rec, tick } = await makeEngine(dir);
  const full = bitmap([[0, COUNT]]);
  tick({ position: 49, streamPos: 49 * MB }, full, true);
  tick({ position: 50, paused: true, eof: true, streamPos: 50 * MB }, full, true);
  assert.deepEqual(rec.seeks, [[50, true]]);
  await flush();
  tick({ position: 50.2, streamPos: 50.2 * MB }, full, true); // 放起来了
  tick({ position: 50.3, paused: true, eof: true, streamPos: 50.3 * MB }, full, true); // 又停回来
  assert.equal(rec.eofs.length, 1, '同一个地方放起来又停住，再重放只会原地打转');
  assert.equal(rec.seeks.length, 1);
});

impl('重放之后播放器一直不动：先等（旧 eof 不算数），等不来再重放一次，两次还停着就认片尾', async (dir) => {
  const { rec, tick, clock } = await makeEngine(dir);
  const full = bitmap([[0, COUNT]]);
  tick({ position: 49, streamPos: 49 * MB }, full, true);
  const stuck = { position: 50, paused: true, eof: true, streamPos: 50 * MB };
  tick(stuck, full, true);
  assert.equal(rec.seeks.length, 1);
  tick(stuck, full, true); // 跳转还没落地时的旧 eof
  assert.equal(rec.seeks.length, 1, '旧 eof 不能再触发一次重放');
  assert.deepEqual(rec.eofs, []);
  clock.t += 3000;
  tick(stuck, full, true);
  assert.equal(rec.seeks.length, 2, '等了几秒还停着：再重放一次');
  assert.deepEqual(rec.eofs, []);
  clock.t += 3000;
  tick(stuck, full, true);
  assert.equal(rec.eofs.length, 1, '重放两次还停着就认它是片尾，列表才推得动');
  assert.equal(rec.seeks.length, 2);
});

impl('老调用方式（不传 runEndBytes）：文件尾那片一到，「stream-pos + runBytes」就到了文件尾，位置不在片尾照样不认放完', async (dir) => {
  const { eng, rec } = await makeEngine(dir);
  // 按 stream-pos 算播放位置时调度器跑去补文件尾，最后一片很快就到：runBytes 从 stream-pos 连到了文件尾
  eng.onMpvTick(
    { position: 10.8, paused: true, eof: true, streamPos: FAKE_STREAM_POS, duration: DURATION, sampledAt: 0 },
    { contiguousBytes: 16 * MB, runBytes: SIZE - FAKE_STREAM_POS, complete: false }
  );
  assert.deepEqual(rec.eofs, [], '管理员这边一收到最后一片就提交 ended，房间只放到 10.8 秒就换下一部');
});

impl('在线链接不走这道守卫：断流照旧报 stream-cut，不跳转、不重放', async (dir) => {
  const { SyncEngine } = await import(dir + 'syncEngine.js');
  const eng = new SyncEngine({ peerId: 'h1', name: 'h1', isSeeder: true, hostId: 'h1' });
  const seeks = [];
  const cuts = [];
  eng.onSeek = (p) => seeks.push(p);
  eng.onSetPause = () => {};
  eng.started = true;
  eng.setFollow({ streaming: true, mode: 'full' });
  eng.setMediaInfo({ duration: 180, size: 0 });
  eng.on('stream-cut', (e) => cuts.push(e));
  eng.onMpvTick({ position: 43, paused: true, eof: true, idle: true }, { contiguousBytes: 0, runBytes: 0, complete: true });
  assert.equal(cuts.length, 1);
  assert.deepEqual(seeks, []);
});

/* ------------------------------ 主进程 mpv ------------------------------ */

const mpvModule = require('../src/main/mpv');
const { MpvController, buildLaunchArgs, cacheArg, isLoadWarnLine, OVERLAY_ROOM } = mpvModule;

test('正在接收的本地文件关掉 mpv 的缓存；收完的文件、在线链接照旧开着', () => {
  assert.equal(cacheArg({ isRemote: false, growing: true }), '--cache=no');
  assert.equal(cacheArg({ isRemote: false, growing: false }), '--cache=yes');
  assert.equal(cacheArg({ isRemote: true, growing: true }), '--cache=yes', '在线链接要靠缓存扛网络抖动');
  const growing = buildLaunchArgs({ ipcPath: 'x', source: 'D:/cache/a.mp4', growing: true });
  assert.ok(growing.includes('--cache=no'));
  assert.ok(!growing.includes('--cache=yes'));
  assert.ok(growing.indexOf('--cache=no') < growing.indexOf('--'), '选项必须在 -- 之前');
  assert.ok(buildLaunchArgs({ ipcPath: 'x', source: 'D:/cache/a.mp4' }).includes('--cache=yes'));
  assert.ok(buildLaunchArgs({ ipcPath: 'x', source: 'https://v.example/a.mp4', growing: true }).includes('--cache=yes'));
});

test('mpv 同一批属性变化合成一条 tick：放到头 / 断流时的 pause 不会先单独报出去', async () => {
  const ctl = new MpvController();
  const ticks = [];
  ctl.on('tick', (s) => ticks.push(s));
  const line = (name, data) => JSON.stringify({ event: 'property-change', name, data }) + '\n';
  ctl._onData(line('time-pos', 43.03) + line('pause', false));
  await flush();
  assert.equal(ticks.length, 1);
  ticks.length = 0;
  // 实测（在线链接断流、keep-open 放到头）：同一毫秒里 pause、core-idle、eof-reached 依次推上来
  ctl._onData(line('pause', true) + line('core-idle', true));
  ctl._onData(line('eof-reached', true)); // 被管道拆成两次读到也合得上
  await flush();
  assert.equal(ticks.length, 1, '一条一发的话，第一条「暂停了、还没 eof」会被当成用户按了暂停');
  assert.equal(ticks[0].paused, true);
  assert.equal(ticks[0].eof, true);
});

impl('断流的那条合成 tick 到了控制者手里：不广播暂停，只报 stream-cut（重试后按房间状态接着放）', async (dir) => {
  const { SyncEngine } = await import(dir + 'syncEngine.js');
  const eng = new SyncEngine({ peerId: 'h1', name: 'h1', isSeeder: true, hostId: 'h1' });
  const clock = { t: 10_000 };
  eng.now = () => clock.t;
  eng.onSeek = () => {};
  eng.onSetPause = () => {};
  eng.started = true;
  eng.resetMedia({ seq: 1, isSeeder: true, broadcast: true });
  eng.setFollow({ streaming: true, mode: 'full' });
  eng.setMediaInfo({ duration: 180, size: 0 });
  eng.userSetPaused(false);
  await new Promise((r) => setTimeout(r, 300)); // 等回声窗口关掉
  const out = [];
  const cuts = [];
  eng.on('outbound', (m) => out.push(m));
  eng.on('stream-cut', (e) => cuts.push(e));
  const buf = { contiguousBytes: 0, runBytes: 0, complete: true };
  eng.onMpvTick({ position: 42.5, paused: false, eof: false, idle: false, sampledAt: 0 }, buf);
  clock.t += 500;
  eng.onMpvTick({ position: 43, paused: false, eof: false, idle: false, sampledAt: 500 }, buf);
  clock.t += 30;
  eng.onMpvTick({ position: 43.03, paused: true, eof: true, idle: true, sampledAt: 530 }, buf);
  assert.deepEqual(out.filter((m) => m.t === 'sync'), [], '房主的断流不能把全房暂停');
  assert.equal(cuts.length, 1);
  assert.equal(eng.shared.paused, false, '房间照走，重试之后播放器按房间状态接着放');
  assert.equal(eng.intendedPaused, false);
});

/** 接了假 socket 的控制器，命令只记下来，回包由测试喂（同 danmakuOverlay.test.js）。 */
function fakeController({ fail = false } = {}) {
  const ctl = new MpvController();
  const sent = [];
  ctl.sock = {
    destroyed: false,
    write(line, cb) {
      sent.push(JSON.parse(line));
      if (cb) cb(fail ? new Error('管道断了') : undefined);
    },
  };
  const reply = () => {
    for (const msg of sent.splice(0)) ctl._onData(JSON.stringify({ request_id: msg.request_id, error: 'success' }) + '\n');
  };
  return { ctl, sent, reply };
}

test('数据尽头的重放：先 drop-buffers 再跳；平常的跳转不带它', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ctl, sent, reply } = fakeController();
  const done = ctl.seek(10.8, { dropBuffers: true });
  assert.deepEqual(sent.map((m) => m.command), [['drop-buffers']]);
  reply();
  await flush();
  assert.deepEqual(sent.map((m) => m.command), [['seek', 10.8, 'absolute', 'exact']], '跳转要排在 drop-buffers 回包之后');
  reply();
  await done;

  ctl.seek(20);
  assert.deepEqual(sent.map((m) => m.command), [['seek', 20, 'absolute', 'exact']]);
  reply();
});

test('没有 drop-buffers 的老 mpv：那条命令失败了照样跳', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ctl, sent } = fakeController();
  const done = ctl.seek(5, { dropBuffers: true });
  const [drop] = sent.splice(0);
  ctl._onData(JSON.stringify({ request_id: drop.request_id, error: 'invalid parameter' }) + '\n');
  await flush();
  assert.deepEqual(sent.map((m) => m.command), [['seek', 5, 'absolute', 'exact']]);
  ctl._onData(JSON.stringify({ request_id: sent[0].request_id, error: 'success' }) + '\n');
  await done;
});

test('横幅去重表只记真正发出去的：管道还没连上时推的那条，连上后同样的文本照发', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctl = new MpvController();
  await ctl.setOverlay(OVERLAY_ROOM, '在等小明');
  assert.equal(ctl._overlays.has(OVERLAY_ROOM), false, '没发出去就记下了，之后文本不变就再也不会重发');
  const sent = [];
  ctl.sock = {
    destroyed: false,
    write(line, cb) {
      sent.push(JSON.parse(line));
      if (cb) cb();
    },
  };
  ctl.setOverlay(OVERLAY_ROOM, '在等小明');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].command[0], 'osd-overlay');
  ctl.setOverlay(OVERLAY_ROOM, '在等小明');
  assert.equal(sent.length, 1, '发出去之后照旧去重');
});

test('横幅命令没发成（管道断了）：从去重表里摘掉，下一次同样的文本照发', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ctl, sent } = fakeController({ fail: true });
  await ctl.setOverlay(OVERLAY_ROOM, '在等小明');
  assert.equal(sent.length, 1);
  assert.equal(ctl._overlays.has(OVERLAY_ROOM), false);
  ctl.sock.write = (line, cb) => {
    sent.push(JSON.parse(line));
    if (cb) cb();
  };
  ctl.setOverlay(OVERLAY_ROOM, '在等小明');
  assert.equal(sent.length, 2);
});

test('只有 ffmpeg 拿到 HTTP 错误码（warn 级）时，打不开的原因照样认得出；别的 warn 不留', () => {
  assert.equal(isLoadWarnLine('ffmpeg', 'https: HTTP error 403 Forbidden\n'), true);
  assert.equal(isLoadWarnLine('ffmpeg/demuxer', 'http: HTTP error 404 Not Found'), true);
  assert.equal(isLoadWarnLine('ffmpeg', 'https: 不相干的警告'), false);
  assert.equal(isLoadWarnLine('cplayer', 'HTTP error 403'), false, '只认 ffmpeg 那一行');

  const ctl = new MpvController();
  const feed = (msg) => ctl._onData(JSON.stringify(msg) + '\n');
  feed({ event: 'start-file', playlist_entry_id: 1 });
  feed({ event: 'log-message', prefix: 'ffmpeg', level: 'warn', text: 'Audio device underrun\n' });
  feed({ event: 'log-message', prefix: 'ffmpeg', level: 'warn', text: 'https: HTTP error 403 Forbidden\n' });
  assert.equal(ctl._errorLogs.length, 1);
  feed({ event: 'end-file', reason: 'error', playlist_entry_id: 1, file_error: 'loading failed' });
  assert.deepEqual(ctl.snapshot().loadError, { reason: 'http', status: 403 });
});

/* ------------------------------ 主进程：谁算「正在接收」 ------------------------------ */

test('isReceivingFile：没收完的接收文件才算；收完的、别的路径都不算', async (t) => {
  const store = require('../src/main/fileStore');
  const { CacheManager } = require('../src/main/cacheManager');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'noxreel-f1-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const cache = new CacheManager({ rootDir: path.join(dir, 'cache') });
  await cache.initialize();
  store._testing.reset();
  store.configureCache(cache);
  store.setPolicy({ mode: 'auto', keptDir: path.join(dir, 'kept') });
  t.after(async () => {
    await store.closeAll();
    store._testing.reset();
  });
  const chunks = [Buffer.alloc(store.CHUNK_SIZE, 0x11), Buffer.alloc(1000, 0x12)];
  chunks[0].writeUInt32BE(0x1a45dfa3, 0); // EBML 文件头，过得了容器检查
  const hashes = chunks.map((c) => crypto.createHash('sha256').update(c).digest('hex'));
  const manifest = {
    fileId: crypto.createHash('sha256').update(hashes.join('')).digest('hex').slice(0, 32),
    name: 'a.mkv',
    size: store.CHUNK_SIZE + 1000,
    chunkSize: store.CHUNK_SIZE,
    chunkCount: 2,
    hashes,
  };
  const state = await store.openLeech(manifest);
  assert.equal(store.isReceivingFile(state.filePath), true);
  await store.writeChunk(state.sessionId, 0, chunks[0]);
  assert.equal(store.isReceivingFile(state.filePath), true, '收了一半照样是边收边播的文件');
  await store.writeChunk(state.sessionId, 1, chunks[1]);
  assert.equal(store.isReceivingFile(state.filePath), false, '收完了就没有零可读，缓存照开');
  assert.equal(store.isSessionFile(state.filePath), true);
  assert.equal(store.isReceivingFile(path.join(dir, 'other.mkv')), false);
  assert.equal(store.isReceivingFile('relative.mkv'), false);
});

/* ------------------------------ 接线 ------------------------------ */

test('接线：主进程自己认「正在接收」、跳转带 dropBuffers 一路传到 mpv；app 用核对过的播放位置', () => {
  const main = read('src', 'main', 'main.js');
  assert.match(main, /const growing = !remote && store\.isReceivingFile\(source\);/);
  assert.match(main, /players\.launch\('mpv', \{[^}]*growing \}/);
  assert.match(main, /secureHandle\('player:seek', async \(seconds, opts\) => \{/);
  assert.match(main, /players\.seek\(validate\.finiteNumber\(seconds, '播放位置', \{ min: 0, max: 10 \*\* 9 \}\), \{ dropBuffers \}\)/);
  assert.match(read('src', 'main', 'preload.js'), /seek: \(seconds, opts\) => ipcRenderer\.invoke\('player:seek', seconds, \{ dropBuffers: opts\?\.dropBuffers === true \}\)/);
  assert.match(read('src', 'main', 'players', 'index.js'), /async seek\(seconds, opts = \{\}\) \{\n\s*return this\._require\(\)\.seek\(seconds, opts\);/);
  const adapter = read('src', 'main', 'players', 'mpvAdapter.js');
  assert.match(adapter, /this\.ctl\.launch\(source, \{ [^}]*growing \}\)/);
  assert.match(adapter, /this\.ctl\.seek\(seconds, \{ dropBuffers: dropBuffers === true \}\)/);

  const app = read('src', 'renderer', 'app.js');
  const tickFn = app.slice(app.indexOf('function handlePlayerTick('), app.indexOf('function onPlayerExit('));
  // G1：说不出位置（position 为 null）的 tick 不动调度器的播放位置
  assert.match(tickFn, /if \(ctx\?\.scheduler && Number\.isFinite\(snap\.position\)\) \{/);
  assert.match(tickFn, /positionToByte\(snap\.position, snap\.streamPos, ctx\.have\)/);
  assert.match(tickFn, /runEndBytes: prog \? prog\.runEndBytes : undefined,/);
  assert.match(app, /S\.sync\.onSeek = \(pos, opts\) => whilePlayerBusy\(applySeek\(pos, opts\)\);/);
  assert.match(app, /window\.sw\.player\.seek\(pos, dropBuffers \? \{ dropBuffers: true \} : undefined\)/);
  const playhead = app.slice(app.indexOf('function roomPlayheadByte('), app.indexOf('function startRunNeeded('));
  assert.match(playhead, /ctx\.scheduler\.streamPosPlausible\(snap\.streamPos, ctx\.have\)/);
  // E5-C：启动期间推过去的横幅可能没送到，认下这一代之后清掉渲染端的去重缓存
  const launch = app.slice(app.indexOf('async function launchPlayer('), app.indexOf('function fallsBackToMpv('));
  assert.ok(launch.indexOf("lastMpvBanner = '';", launch.indexOf('playerGate.confirm(')) > 0, '认下这一代之后要清掉横幅去重缓存');
});
