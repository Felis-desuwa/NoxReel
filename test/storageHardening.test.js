'use strict';

/**
 * 存储层的加固：稀疏文件、同一分片并发写、缓存清理只删自己建的东西、畸形清单、磁盘余量。
 *
 * 这些都是「平时看不出来、一出就很难看」的问题：
 *  - NTFS 上接收文件不是稀疏文件，第一次写文件尾要先把前面整段清零，一部 50GB 的片子卡几十秒；
 *  - 内存缓冲吃满时同一片并发写两次，先到的那次永远不返回，内存计数每次漏 2MB，攒够就再也收不了片；
 *  - 缓存根可以是用户选的任意目录，以前名叫 trash-<十六进制> 的文件夹会被无条件递归删除。
 *
 * 全程不起 GUI、不出声；fsutil 只在 Windows 上跑，用的是系统自带的那个。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const store = require('../src/main/fileStore');
const { CacheManager, TRASH_DIR_RE, dirBytes } = require('../src/main/cacheManager');

const MB = 1024 * 1024;
const GiB = 1024 ** 3;
const CS = store.CHUNK_SIZE;
const onWindows = process.platform === 'win32';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 兜底超时：unref 掉，免得测试早就跑完了进程还要干等这个计时器
const timeoutAfter = (ms) => new Promise((resolve) => setTimeout(resolve, ms, 'timeout').unref());
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// 首片要带 Matroska 文件头，否则过不了媒体类型检查
const HEAD = Buffer.alloc(CS, 1);
HEAD.writeUInt32BE(0x1a45dfa3, 0);
// 其余分片共用这一块内存：fileStore 的内存计数按片照记，实际只占 2MB
const BODY = Buffer.alloc(CS, 2);

async function tempDir(t, prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}));
  return dir;
}

/** 起一个缓存管理器接到 fileStore 上，测试结束时关掉所有会话、收掉 run 目录。 */
async function setupStore(t) {
  const root = await tempDir(t, 'noxreel-storage-');
  const manager = new CacheManager({ rootDir: path.join(root, 'cache') });
  await manager.initialize();
  store.configureCache(manager);
  store._testing.reset();
  t.after(async () => {
    await store.closeAll();
    await manager.cleanupRun();
  });
  return manager;
}

/** 第 0 片的内容是 HEAD，其余每片都是 BODY。 */
function manifestOf(chunkCount, { name = 'movie.mkv', size = chunkCount * CS } = {}) {
  const hashes = Array.from({ length: chunkCount }, (_, i) => (i === 0 ? sha(HEAD) : sha(BODY)));
  return {
    fileId: sha(Buffer.from(hashes.join(''))).slice(0, 32),
    name,
    size,
    chunkSize: CS,
    chunkCount,
    hashes,
  };
}

/* ============================ 稀疏文件 ============================ */

test('NTFS 上接收文件是稀疏的：只写了文件尾一片，磁盘上也只占这一片', { skip: !onWindows && '只在 Windows 上标稀疏' }, async (t) => {
  await setupStore(t);
  const chunkCount = 128; // 256MB：不是稀疏文件的话 truncate 完就整块占满
  const state = await store.openLeech(manifestOf(chunkCount));
  if (store._testing.sparseSkippedVolumes.size) {
    t.skip(`这台机器的临时目录所在卷标不了稀疏：${[...store._testing.sparseSkippedVolumes.values()]}`);
    return;
  }

  const result = await store.writeChunk(state.sessionId, chunkCount - 1, BODY);
  assert.equal(result.ok, true);
  const st = await fsp.stat(state.filePath);
  assert.equal(st.size, chunkCount * CS, '文件大小照旧是整部片');
  assert.ok(st.blocks * 512 < 32 * MB, `只写了文件尾 2MB，磁盘上却占了 ${(st.blocks * 512) / MB}MB —— 文件没标成稀疏`);

  // 没写过的区间读出来是 0，写过的原样读回
  const fh = await fsp.open(state.filePath, 'r');
  try {
    const probe = Buffer.alloc(16);
    await fh.read(probe, 0, 16, 64 * MB);
    assert.deepEqual(probe, Buffer.alloc(16));
  } finally {
    await fh.close();
  }
  assert.deepEqual(await store.readChunk(state.sessionId, chunkCount - 1), BODY);
});

test('fsutil 卡住也不能拖住接收：超时就退回整块预分配，并记日志', { skip: !onWindows && '只在 Windows 上标稀疏', timeout: 30_000 }, async (t) => {
  await setupStore(t);
  const tool = store._testing.sparseTool;
  const saved = { ...tool };
  let spawned = 0;
  // 拿 node 顶替 fsutil：起来之后一分钟都不退出
  tool.command = () => {
    spawned++;
    return process.execPath;
  };
  tool.args = () => ['-e', 'setTimeout(() => {}, 60000)'];
  tool.timeoutMs = 300;
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    Object.assign(tool, saved);
    console.warn = warn;
  });

  const started = Date.now();
  const state = await store.openLeech(manifestOf(4));
  assert.ok(Date.now() - started < 5000, `开接收会话被 fsutil 拖了 ${Date.now() - started}ms`);
  assert.equal(store._testing.sparseSkippedVolumes.size, 1, '标不上的卷要记下来');
  assert.ok(warnings.some((w) => w.includes('稀疏')), '退回整块预分配时要记一条日志');

  // 退回原来的行为，照样能收
  const result = await store.writeChunk(state.sessionId, 0, HEAD);
  assert.equal(result.ok, true);
  assert.deepEqual(await store.readChunk(state.sessionId, 0), HEAD);

  // 同一个卷不再白起进程
  await store.openLeech(manifestOf(2));
  assert.equal(spawned, 1, '同一个卷失败过一次就不该再试');
});

test('fsutil 不存在时退回整块预分配，不影响接收', { skip: !onWindows && '只在 Windows 上标稀疏' }, async (t) => {
  await setupStore(t);
  const tool = store._testing.sparseTool;
  const saved = { ...tool };
  tool.command = () => path.join(os.tmpdir(), 'noxreel-no-such-dir', 'fsutil.exe');
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => {
    Object.assign(tool, saved);
    console.warn = warn;
  });

  const state = await store.openLeech(manifestOf(2));
  assert.equal(store._testing.sparseSkippedVolumes.size, 1);
  assert.equal((await store.writeChunk(state.sessionId, 1, BODY)).ok, true);
  assert.equal((await fsp.stat(state.filePath)).size, 2 * CS);
});

/* ============================ 同一分片并发写 ============================ */

test('内存缓冲吃满时同一分片并发写两次：两次都返回，内存计数不漏', { timeout: 60_000 }, async (t) => {
  await setupStore(t);
  // 128 片（256MB）就把内存缓冲顶到上限，之后的写入都要先等一轮落盘 —— 两份重复的就卡在那儿
  const chunkCount = 131;
  const state = await store.openLeech(manifestOf(chunkCount));
  const writes = [];
  for (let i = 0; i < chunkCount - 1; i++) writes.push(store.writeChunk(state.sessionId, i, i === 0 ? HEAD : BODY));
  const first = store.writeChunk(state.sessionId, chunkCount - 1, BODY);
  const second = store.writeChunk(state.sessionId, chunkCount - 1, BODY);
  await Promise.all(writes);

  const outcome = await Promise.race([Promise.all([first, second]), timeoutAfter(10_000)]);
  assert.notEqual(outcome, 'timeout', '有一份重复写入永远不返回：它的 entry 在表里被后到的覆盖了');
  assert.equal(outcome.every((r) => r.ok), true);
  assert.equal(outcome.filter((r) => r.duplicate).length, 1, '恰好一份是重复');
  const final = store.state(state.sessionId);
  assert.equal(final.haveCount, chunkCount, '重复的那份不能让已收片数多算一次');
  assert.equal(final.complete, true);

  await store.close(state.sessionId);
  assert.equal(store._testing.stats().pendingMemoryBytes, 0, '关掉会话之后内存计数必须归零');
});

/**
 * 另一种交错：后到的那份还在等别的会话落盘，先到的那份已经登记、写完了。
 * 后到的醒来时表里已经没有这一片，只能靠 have[] 认出它是重复的，否则会再登记一次，
 * 已收片数多算一片 —— 片子还缺一片就被当成收完了。
 *
 * 用「闸门」控制每批分片什么时候真正落盘（按缓冲区认批次），交错顺序完全确定，不靠计时。
 */
test('同一分片的另一份已经写完时才醒来：认得出是重复，已收片数不多算', { timeout: 60_000 }, async (t) => {
  const manager = await setupStore(t);
  const BODY_S = Buffer.alloc(CS, 0x5c); // 本场的分片
  const BODY_A = Buffer.alloc(CS, 0xa1); // 旁边那场接收的第一批
  const BODY_B = Buffer.alloc(CS, 0xb2); // 旁边那场接收的第二批
  const gates = new Map([[BODY_S, gate()], [BODY_A, gate()], [BODY_B, gate()]]);
  function gate() {
    let open;
    const opened = new Promise((resolve) => {
      open = resolve;
    });
    return { opened, open };
  }

  // 让写盘按批次停在闸门前
  const probe = await fsp.open(path.join(manager.runDir, 'run.json'), 'r');
  const proto = Object.getPrototypeOf(probe);
  await probe.close();
  const realWritev = proto.writev;
  proto.writev = async function (buffers, position) {
    for (const [key, g] of gates) if (buffers.includes(key)) await g.opened;
    return realWritev.call(this, buffers, position);
  };
  t.after(() => {
    proto.writev = realWritev;
  });

  // 本场：第 1–100 片是 BODY_S，最后一片（130）会被写两次
  const mine = manifestOf(131);
  mine.hashes = mine.hashes.map((h, i) => (i === 0 ? h : sha(BODY_S)));
  const other = manifestOf(57);
  other.hashes = other.hashes.map((h, i) => (i === 0 ? h : sha(i <= 28 ? BODY_A : BODY_B)));
  const s = await store.openLeech(mine);
  const o = await store.openLeech(other);
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const pending = () => store._testing.stats().pendingMemoryBytes;

  // 旁边那场先占 56MB、本场再占 200MB：内存缓冲正好满
  const all = [];
  for (let i = 1; i <= 28; i++) all.push(store.writeChunk(o.sessionId, i, BODY_A));
  for (let i = 1; i <= 100; i++) all.push(store.writeChunk(s.sessionId, i, BODY_S));
  await tick();
  assert.equal(pending(), store.MEMORY_CACHE_LIMIT);

  // 先到的那份：缓冲满了，先等旁边那场落盘
  const first = store.writeChunk(s.sessionId, 130, BODY_S);
  gates.get(BODY_A).open();
  while (pending() > 200 * MB) await sleep(10);
  await tick(); // 先到的那份已经等完旁边那场，改等本场落盘

  // 旁边那场又来了一批，把缓冲重新占满；后到的那份只能去等它
  for (let i = 29; i <= 56; i++) all.push(store.writeChunk(o.sessionId, i, BODY_B));
  await tick();
  const second = store.writeChunk(s.sessionId, 130, BODY_S);

  // 本场放行：先到的那份登记、落盘，第 130 片已经在盘上
  gates.get(BODY_S).open();
  const firstResult = await first;
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.duplicate, undefined);

  // 旁边那场放行：后到的那份这才醒来
  gates.get(BODY_B).open();
  const secondResult = await Promise.race([second, timeoutAfter(10_000)]);
  assert.notEqual(secondResult, 'timeout');
  assert.equal(secondResult.duplicate, true, '表里已经没有这一片了，要靠 have[] 认出它是重复的');
  await Promise.all(all);
  assert.equal(store.state(s.sessionId).haveCount, 101, '同一片不能算两次');
  assert.equal(store.state(s.sessionId).complete, false, '还缺着片，不能算收完');
});

/* ============================ 畸形清单与越界写入 ============================ */

test('畸形清单在分配任何东西之前就被拒绝', async (t) => {
  const manager = await setupStore(t);
  const good = manifestOf(2);
  const cases = [
    ['负数大小', { size: -1 }],
    ['NaN 大小', { size: Number.NaN }],
    ['超过安全整数的大小', { size: 2 ** 60 }],
    ['分片大小不是 2MB', { chunkSize: 1024 * 1024 }],
    ['分片数和大小对不上', { chunkCount: 3, hashes: [...good.hashes, good.hashes[1]] }],
    ['负数分片数', { chunkCount: -1 }],
    ['哈希个数和分片数对不上', { hashes: [good.hashes[0]] }],
    ['没有文件名', { name: undefined }],
  ];
  for (const [label, patch] of cases) {
    await assert.rejects(store.openLeech({ ...good, ...patch }), /无效的媒体清单/, label);
  }
  await assert.rejects(store.openLeech(null), /无效的媒体清单/);
  await assert.rejects(store.openSeed({ ...good, size: -1 }, __filename), /无效的媒体清单/);
  assert.equal(store._testing.stats().sessionCount, 0);
  // 一个媒体目录都没建、也没留下
  assert.deepEqual(await fsp.readdir(manager.runDir), ['run.json']);
});

test('非整数的分片下标一律当越界', async (t) => {
  await setupStore(t);
  const state = await store.openLeech(manifestOf(2));
  for (const index of [Number.NaN, 0.5, Infinity]) {
    await assert.rejects(store.writeChunk(state.sessionId, index, BODY), /分片下标越界/, `写 ${index}`);
    await assert.rejects(store.readChunk(state.sessionId, index), /分片下标越界/, `读 ${index}`);
  }
});

/* ============================ 磁盘余量 ============================ */

test('稀疏文件不预先占盘：再开一场接收时要把前一场还没写的部分算进去', async (t) => {
  await setupStore(t);
  // 假装磁盘只剩 1GiB。稀疏文件真正落盘的只有写过的那几片，测试不会真的吃掉这么多空间
  const realStatfs = fsp.statfs;
  fsp.statfs = async () => ({ bavail: GiB / 4096, bsize: 4096 });
  t.after(() => {
    fsp.statfs = realStatfs;
  });

  const size = 600 * MB;
  const first = await store.openLeech(manifestOf(size / CS));
  if (store._testing.reservedDiskBytes() === 0) {
    t.skip('这台机器上接收文件是整块预分配的，磁盘余量本身就已经扣掉了');
    return;
  }
  assert.equal(store._testing.reservedDiskBytes(), size, '整部片都还没写，全部算作要占的空间');

  // 单看磁盘余量（1GiB）放得下 600MB，但前一场还要再吃 600MB
  await assert.rejects(store.openLeech(manifestOf(size / CS)), (error) => {
    assert.match(error.message, /^磁盘空间不够：这部片子需要 0\.59GB，缓存所在的磁盘只剩 0\.41GB$/);
    return true;
  });
  assert.equal(store._testing.stats().openingBytes, 0, '打开失败之后不能留下占位');
  assert.equal(store._testing.stats().sessionCount, 1);

  // 写进来的部分已经真的占了盘，不再重复预留
  await store.writeChunk(first.sessionId, 1, BODY);
  assert.equal(store._testing.reservedDiskBytes(), size - CS);

  // 前一场关掉，空间就还回来了
  await store.close(first.sessionId);
  assert.equal(store._testing.reservedDiskBytes(), 0);
  const second = await store.openLeech(manifestOf(size / CS));
  assert.ok(second.sessionId);
});

/** 拿到 FileHandle 的原型，好在测试里临时换掉 truncate / writev。 */
async function fileHandleProto(t, dir) {
  const probe = await fsp.open(path.join(dir, 'run.json'), 'r');
  const proto = Object.getPrototypeOf(probe);
  await probe.close();
  const saved = { truncate: proto.truncate, writev: proto.writev };
  t.after(() => Object.assign(proto, saved));
  return { proto, saved };
}

test('开接收会话半路失败：文件句柄关掉、媒体目录删掉、空间预留退回', async (t) => {
  const manager = await setupStore(t);
  const { proto } = await fileHandleProto(t, manager.runDir);
  let victim = null;
  proto.truncate = async function () {
    victim = this;
    throw Object.assign(new Error('ENOSPC: no space left on device, ftruncate'), { code: 'ENOSPC' });
  };

  await assert.rejects(store.openLeech(manifestOf(4)), /ENOSPC/);
  assert.ok(victim, '应当走到了 truncate');
  assert.equal(victim.fd, -1, '失败之后文件句柄必须关掉，不然每失败一次漏一个');
  assert.deepEqual(await fsp.readdir(manager.runDir), ['run.json'], '建了一半的媒体目录要删掉');
  assert.equal(store._testing.stats().openingBytes, 0);
  assert.equal(store._testing.reservedDiskBytes(), 0);
  assert.equal(store._testing.stats().sessionCount, 0);
});

test('写盘时磁盘满了：这批写入报错、内存计数退回，腾出空间后照样能收', async (t) => {
  const manager = await setupStore(t);
  const state = await store.openLeech(manifestOf(4));
  const { proto, saved } = await fileHandleProto(t, manager.runDir);
  let full = true;
  proto.writev = async function (...args) {
    if (full) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    return saved.writev.apply(this, args);
  };

  await assert.rejects(store.writeChunk(state.sessionId, 1, BODY), /ENOSPC/);
  assert.equal(store._testing.stats().pendingMemoryBytes, 0, '写失败的分片占的内存计数要退回');
  assert.equal(store.state(state.sessionId).haveCount, 0, '没写进去的不能记成已收');

  full = false;
  const result = await store.writeChunk(state.sessionId, 1, BODY);
  assert.equal(result.ok, true);
  assert.equal(result.haveCount, 1);
});

/* ============================ 缓存清理只删自己的东西 ============================ */

/** 用户自己的文件夹：名字碰巧像我们的，里面是他的东西。 */
async function userFolder(root, name, files = { '照片.jpg': 'jpeg' }) {
  const dir = path.join(root, name);
  await fsp.mkdir(dir, { recursive: true });
  for (const [file, body] of Object.entries(files)) await fsp.writeFile(path.join(dir, file), body);
  return dir;
}

/** 本软件留下的目录：createOwnedDir 那种子目录里放着片子，可选一个 run.json。 */
async function ourLeftover(root, name, marker) {
  const dir = path.join(root, name);
  await fsp.mkdir(path.join(dir, 'media-0-0123456789'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'media-0-0123456789', 'movie.mkv'), 'x'.repeat(4096));
  if (marker) await fsp.writeFile(path.join(dir, 'run.json'), JSON.stringify(marker));
  return dir;
}

test('名字像 trash-/run- 的用户文件夹一个都不删，也不算进残留', async (t) => {
  const root = await tempDir(t, 'noxreel-userdirs-');
  const userDirs = [
    await userFolder(root, 'trash-2024'),
    await userFolder(root, 'Trash-1'),
    await userFolder(root, 'TRASH-ABC'),
    // 名字和我们起的一模一样（12 位小写十六进制），里面却是用户的文件
    await userFolder(root, 'trash-abcdef012345'),
    // 带了个 run.json，但不是我们写的格式
    await userFolder(root, 'trash-abcdef012346', { 'run.json': JSON.stringify({ project: '我的项目' }), 'a.txt': 'a' }),
    await userFolder(root, 'trash-abcdef012347', { 'run.json': '不是 JSON' }),
    // run- 目录：名字对得上、PID 也早就不在了，但里面是用户的文件
    await userFolder(root, 'run-4242-abc-abcdef012345'),
    await userFolder(root, 'run-4243-abc-abcdef012345', { 'run.json': JSON.stringify({ host: 'h', pid: 4243 }) }),
    // 布局像我们的，却夹着一个用户文件
    await userFolder(root, 'run-4244-abc-abcdef012345', { 'notes.txt': 'n' }),
  ];
  // 空文件夹：只凭布局认不出主人，名字不是我们起的就不能碰
  const emptyDirs = [await userFolder(root, 'trash-2025', {}), await userFolder(root, 'RUN-4245-ABC-ABCDEF012345', {})];
  await fsp.mkdir(path.join(userDirs[userDirs.length - 1], 'media-0-0123456789'));

  const manager = new CacheManager({
    rootDir: root,
    pid: 1,
    now: () => Date.now(),
    isAlive: () => false,
    hostname: () => 'h',
  });
  await manager.initialize();
  const usage = await manager.usage();
  assert.equal(usage.staleRuns, 0, '用户的文件夹不能被说成「上次退出没清掉」');
  assert.equal(await manager.purgeStale(), 0);
  // 换过缓存目录之后旧根目录每次启动都会被扫一遍，这条路也不能删
  const later = new CacheManager({
    rootDir: await tempDir(t, 'noxreel-newroot-'),
    extraRoots: [root],
    pid: 2,
    isAlive: () => false,
    hostname: () => 'h',
  });
  await later.initialize();

  for (const dir of emptyDirs) assert.equal(fs.existsSync(dir), true, `${path.basename(dir)} 被删了`);
  for (const dir of userDirs) {
    assert.equal(fs.existsSync(dir), true, `${path.basename(dir)} 被删了`);
    assert.ok((await fsp.readdir(dir)).length > 0, `${path.basename(dir)} 里的东西被删了`);
  }
});

test('旧版本留下的缓存照样回收：0.7.x 的标记、没有标记的老布局、删到一半的垃圾', async (t) => {
  const root = await tempDir(t, 'noxreel-legacy-');
  // 0.7.0–0.7.4 退出时改名成的垃圾：run.json 只有 host/pid/startedAt，还是别的机器的
  const legacyTrash = await ourLeftover(root, 'trash-0123456789ab', { host: '别的机器', pid: 7, startedAt: 1 });
  // 删到一半：标记已经没了，只剩片子所在的子目录
  const halfDeleted = await ourLeftover(root, 'trash-0123456789ac', null);
  // 0.7 以前的 run 目录：没有标记，进程早没了
  const oldRun = await ourLeftover(root, 'run-4321-kx0abc-0123456789ab', null);
  // 0.7.x 的 run 目录：本机、进程早没了
  const deadRun = await ourLeftover(root, 'run-4322-kx0abc-0123456789ab', { host: 'h', pid: 4322, startedAt: 1 });
  // 本机另一个还活着的实例：不能动
  const liveRun = await ourLeftover(root, 'run-4323-kx0abc-0123456789ab', { app: 'noxreel', host: 'h', pid: 4323, startedAt: 1 });

  const manager = new CacheManager({
    rootDir: root,
    pid: 1,
    now: () => Date.now(),
    isAlive: (pid) => pid === 4323,
    hostname: () => 'h',
  });
  await manager.initialize();
  for (const dir of [legacyTrash, halfDeleted, oldRun, deadRun]) {
    assert.equal(fs.existsSync(dir), false, `${path.basename(dir)} 该回收`);
  }
  assert.equal(fs.existsSync(liveRun), true, '活着的实例正在用的目录不能删');
});

test('新建的 run 目录带本软件的标记，删不掉留下的垃圾下次启动照样认得出来', async (t) => {
  const root = await tempDir(t, 'noxreel-marker-');
  const first = new CacheManager({ rootDir: root, pid: 1, hostname: () => '甲机' });
  await first.initialize();
  const marker = JSON.parse(await fsp.readFile(path.join(first.runDir, 'run.json'), 'utf8'));
  assert.equal(marker.app, 'noxreel');
  const owned = await first.createOwnedDir('media');
  await fsp.writeFile(path.join(owned, 'movie.mkv'), 'x'.repeat(1024));

  // 退出时删不动（文件还被占着），只留下改好名的垃圾
  const original = fsp.rm;
  fsp.rm = async () => {
    throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
  };
  try {
    await first.cleanupRun();
  } finally {
    fsp.rm = original;
  }
  const trash = (await fsp.readdir(root)).filter((name) => TRASH_DIR_RE.test(name));
  assert.equal(trash.length, 1);

  // 下次启动：别的机器、判活说还活着，都不影响回收
  const second = new CacheManager({ rootDir: root, pid: 2, isAlive: () => true, hostname: () => '乙机' });
  await second.initialize();
  assert.equal(fs.existsSync(path.join(root, trash[0])), false);
  await second.cleanupRun();
});

test('统计占用有上限：目录里塞了海量文件也不会一直数下去', async (t) => {
  const dir = await tempDir(t, 'noxreel-dirbytes-');
  await Promise.all(Array.from({ length: 40 }, (_, i) => fsp.writeFile(path.join(dir, `f${i}`), 'x'.repeat(8192))));
  const all = await dirBytes(dir);
  const capped = await dirBytes(dir, { maxEntries: 10 });
  assert.ok(all > 0);
  assert.ok(capped < all, '超过上限之后应当停下来，不再往下数');
});
