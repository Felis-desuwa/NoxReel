'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const settings = require('../src/main/settings');
const { CacheManager, TRASH_DIR_RE } = require('../src/main/cacheManager');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

async function tempDir(t, prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}));
  return dir;
}

/* ------------------------- 缓存根目录从哪来 ------------------------- */

/**
 * 缓存原来锁死在系统临时目录。实测这台开发机 %TEMP% 在 C: 只剩 66GB，而另一块盘
 * 空着 6.6TB —— 取消文件大小上限之后，一部 100GB 的片子会被 ensureFreeSpace
 * 一口回绝，尽管机器有的是空间。
 */
test('缓存根目录的优先级：环境变量 > 配置 > 系统临时目录', () => {
  const def = path.join(os.tmpdir(), 'NoxReel');
  assert.deepEqual(settings.resolveCacheRoot({ env: {}, config: {}, defaultRoot: def }), {
    root: def,
    source: 'default',
  });
  assert.deepEqual(
    settings.resolveCacheRoot({ env: {}, config: { cacheRoot: path.resolve('/data/nox') }, defaultRoot: def }),
    { root: path.resolve('/data/nox'), source: 'config' }
  );
  // 环境变量压过配置，方便端到端验证时临时指一个地方
  assert.equal(
    settings.resolveCacheRoot({
      env: { SYNCWATCH_CACHE_DIR: path.resolve('/env/nox') },
      config: { cacheRoot: path.resolve('/data/nox') },
      defaultRoot: def,
    }).source,
    'env'
  );
});

test('相对路径和空值一律忽略，退回默认 —— 坏配置不能拖垮启动', () => {
  const def = path.join(os.tmpdir(), 'NoxReel');
  for (const bad of ['', '   ', 'relative/path', null, undefined, 42]) {
    assert.equal(settings.resolveCacheRoot({ env: {}, config: { cacheRoot: bad }, defaultRoot: def }).root, def);
    assert.equal(settings.resolveCacheRoot({ env: { SYNCWATCH_CACHE_DIR: bad }, config: {}, defaultRoot: def }).root, def);
  }
});

test('读不出来的配置当空配置处理，不抛异常', async (t) => {
  const dir = await tempDir(t, 'noxreel-cfg-');
  assert.deepEqual(settings.read(dir), {}, '文件不存在');
  await fsp.writeFile(path.join(dir, 'config.json'), '{ 这不是 JSON', 'utf8');
  assert.deepEqual(settings.read(dir), {}, '坏掉的 JSON');
  await fsp.writeFile(path.join(dir, 'config.json'), '"不是对象"', 'utf8');
  assert.deepEqual(settings.read(dir), {}, '不是对象');
});

test('写配置是原子的，并能读回来', async (t) => {
  const dir = await tempDir(t, 'noxreel-cfg-');
  await settings.write(dir, { cacheRoot: path.resolve('/data/nox') });
  assert.equal(settings.read(dir).cacheRoot, path.resolve('/data/nox'));
  assert.equal(settings.read(dir).version, settings.VERSION);
  // 不能留下写了一半的临时文件
  const left = await fsp.readdir(dir);
  assert.deepEqual(left, ['config.json']);
});

/**
 * 换过缓存目录之后，旧盘上可能还躺着上次没清干净的几十 GB。不记着它们，
 * 就再也没人回收 —— 而用户根本不知道它们在哪。
 */
test('历史根目录会被记下来，去重且有上限', () => {
  const a = path.resolve('/a');
  const b = path.resolve('/b');
  assert.deepEqual(settings.knownRoots({ knownRoots: [b] }, a), [a, b]);
  assert.deepEqual(settings.knownRoots({ knownRoots: [a, b] }, a), [a, b], '当前的不能重复出现');
  const many = ['/1', '/2', '/3', '/4', '/5', '/6'].map((p) => path.resolve(p));
  assert.equal(settings.knownRoots({ knownRoots: many }, a).length, 5);
  // 相对路径不能混进去，否则会拿它当根目录去扫
  assert.deepEqual(settings.knownRoots({ knownRoots: ['relative'] }, a), [a]);
});

/* ------------------------- 跨机器的误删风险 ------------------------- */

/**
 * 缓存目录可以指到网盘之后，PID 判活就变得危险：A 机留下 run-4242，
 * B 机启动时本地恰好有个活着的 4242，这个目录永远不回收；反过来 A 机正在用的目录
 * 会被 B 机判成死进程直接删掉 —— 那是人家正在接收的片子。
 */
test('别的机器建的目录不按 PID 判活，只按年龄回收', async (t) => {
  const dir = await tempDir(t, 'noxreel-crossmachine-');
  const fresh = path.join(dir, 'run-4242-old-abcdef');
  const ancient = path.join(dir, 'run-4243-old-abcdef');
  await fsp.mkdir(fresh);
  await fsp.mkdir(ancient);
  const now = 1_000_000_000_000;
  await fsp.writeFile(path.join(fresh, 'run.json'), JSON.stringify({ host: '别人的机器', pid: 4242, startedAt: now - 1000 }));
  await fsp.writeFile(
    path.join(ancient, 'run.json'),
    JSON.stringify({ host: '别人的机器', pid: 4243, startedAt: now - 48 * 3600 * 1000 })
  );

  const manager = new CacheManager({
    rootDir: dir,
    pid: 4242, // 本机恰好有同一个 PID —— 原来的逻辑会把 fresh 当成自己的旧残留删掉
    now: () => now,
    isAlive: () => false,
    hostname: () => '我的机器',
  });
  await manager.initialize();

  assert.equal(fs.existsSync(fresh), true, '别的机器刚建的目录不能删 —— 那可能是正在接收的片子');
  assert.equal(fs.existsSync(ancient), false, '两天前的就可以收了');
});

test('本机的目录仍然按 PID 判活，老行为不变', async (t) => {
  const dir = await tempDir(t, 'noxreel-samehost-');
  const stale = path.join(dir, 'run-111-old-abcdef');
  const live = path.join(dir, 'run-222-old-abcdef');
  const mine = path.join(dir, 'do-not-delete');
  await Promise.all([fsp.mkdir(stale), fsp.mkdir(live), fsp.mkdir(mine)]);
  for (const [d, pid] of [[stale, 111], [live, 222]]) {
    await fsp.writeFile(path.join(d, 'run.json'), JSON.stringify({ host: '我的机器', pid, startedAt: 1 }));
  }

  const manager = new CacheManager({
    rootDir: dir,
    pid: 333,
    now: () => 12345,
    isAlive: (pid) => pid === 222,
    hostname: () => '我的机器',
  });
  await manager.initialize();

  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(live), true);
  // 让用户指定任意目录，最大的顾虑就是「会不会把我的东西删了」—— 不叫 run-/trash- 的一律不碰
  assert.equal(fs.existsSync(mine), true, '不是本软件建的目录一个都不能动');
});

/* ------------------------- 退出清理与残留 ------------------------- */

/**
 * 退出清理只有 5 秒预算，几十 GB 根本删不完。改名是 O(1) 的：改完这个目录立刻
 * 就不再是「当前会话」，超时残留下来的也是一个明明白白标成垃圾的目录。
 */
test('退出时先改名再删，删不完也留下明确的垃圾标记', async (t) => {
  const dir = await tempDir(t, 'noxreel-trash-');
  const manager = new CacheManager({ rootDir: dir, pid: 1, now: () => 1, hostname: () => 'h' });
  await manager.initialize();
  const owned = await manager.createOwnedDir('media');
  await fsp.writeFile(path.join(owned, 'big.bin'), 'x'.repeat(1024));

  assert.equal(await manager.cleanupRun(), true);
  assert.equal(fs.existsSync(manager.runDir), false);
  assert.equal(fs.existsSync(owned), false);
  // 删干净之后根目录下不该留下任何 run-/trash- 目录
  const left = await fsp.readdir(dir);
  assert.deepEqual(left.filter((n) => /^(run|trash)-/.test(n)), []);
});

/**
 * 删得慢也不要紧，这正是先改名的意义：改名瞬间完成，剩下的慢慢删；
 * 删不完残留下来的也顶着 trash- 的名字，下次启动无条件回收。
 */
test('删不动时也要先把名字改成垃圾标记', async (t) => {
  const dir = await tempDir(t, 'noxreel-trash3-');
  const manager = new CacheManager({ rootDir: dir, pid: 1, now: () => 1, hostname: () => 'h' });
  await manager.initialize();
  const runDir = manager.runDir;
  // 让删除动作永远失败，只留下改名的效果
  const original = fsp.rm;
  const fsPromises = require('node:fs/promises');
  fsPromises.rm = async () => {
    throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
  };
  t.after(() => {
    fsPromises.rm = original;
  });

  await manager.cleanupRun();
  fsPromises.rm = original;

  assert.equal(fs.existsSync(runDir), false, '原来那个 run- 目录必须先消失');
  const left = (await fsp.readdir(dir)).filter((n) => TRASH_DIR_RE.test(n));
  assert.equal(left.length, 1, '删不掉也要变成一个标好的垃圾目录');
});

test('标成垃圾的目录下次启动无条件回收，不看 PID 也不看主机', async (t) => {
  const dir = await tempDir(t, 'noxreel-trash2-');
  const trash = path.join(dir, 'trash-abcdef123456');
  await fsp.mkdir(trash);
  await fsp.writeFile(path.join(trash, 'x'), 'y');
  assert.ok(TRASH_DIR_RE.test('trash-abcdef123456'));

  const manager = new CacheManager({
    rootDir: dir,
    pid: 1,
    now: () => 1,
    isAlive: () => true, // 就算判活说「还活着」也照收不误
    hostname: () => 'h',
  });
  await manager.initialize();
  assert.equal(fs.existsSync(trash), false);
});

test('旧盘上的残留也扫得到 —— 换过目录就不能只看新根', async (t) => {
  const oldRoot = await tempDir(t, 'noxreel-old-');
  const newRoot = await tempDir(t, 'noxreel-new-');
  const leftover = path.join(oldRoot, 'trash-aaaaaaaaaaaa');
  await fsp.mkdir(leftover);

  const manager = new CacheManager({
    rootDir: newRoot,
    extraRoots: [oldRoot],
    pid: 1,
    now: () => 1,
    hostname: () => 'h',
  });
  await manager.initialize();
  assert.equal(fs.existsSync(leftover), false, '旧根目录上的残留也要收');
});

/* ------------------------- 占用统计与清理 ------------------------- */

test('占用统计区分「本次会话」和「上次剩下的」', async (t) => {
  const dir = await tempDir(t, 'noxreel-usage-');
  const manager = new CacheManager({
    rootDir: dir,
    pid: 1,
    now: () => Date.now(),
    hostname: () => 'h',
    isAlive: () => false,
  });
  await manager.initialize();
  const owned = await manager.createOwnedDir('media');
  await fsp.writeFile(path.join(owned, 'b.bin'), 'y'.repeat(8192));

  // 启动清理之后才冒出来的残留（本机、进程已经没了）。占用统计和「清理残留」跟启动清理
  // 用的是同一套判据，所以夹具必须是真能回收的那种：别的机器刚建的目录现在不再算残留。
  const stale = path.join(dir, 'run-999-old-abcdef');
  await fsp.mkdir(stale);
  await fsp.writeFile(path.join(stale, 'a.bin'), 'x'.repeat(4096));
  await fsp.writeFile(path.join(stale, 'run.json'), JSON.stringify({ host: 'h', pid: 999, startedAt: Date.now() }));

  const u = await manager.usage();
  assert.equal(u.root, path.resolve(dir));
  assert.ok(u.runBytes > 0, '本次会话应当算出字节数');
  assert.equal(u.staleRuns, 1);
  assert.ok(u.staleBytes > 0);

  // 清理只动不属于本次运行的
  assert.equal(await manager.purgeStale(), 1);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(owned), true, '当前会话的文件一个都不能动');
});

/**
 * 让用户把缓存指到任意目录（比如 D:\视频），最大的顾虑就是「会不会把我原来的东西删了」。
 * 界面上是这么承诺的，这条测试就是那句承诺的靠山。
 */
test('清理绝不碰同目录下用户自己的文件', async (t) => {
  const dir = await tempDir(t, 'noxreel-mine-');
  const myFolder = path.join(dir, '我的收藏');
  const myFile = path.join(dir, '重要.mkv');
  const stale = path.join(dir, 'run-999-old-abcdef');
  await fsp.mkdir(myFolder);
  await fsp.writeFile(path.join(myFolder, '片子.mkv'), 'x');
  await fsp.writeFile(myFile, 'x');
  await fsp.mkdir(stale);
  await fsp.writeFile(path.join(stale, 'run.json'), JSON.stringify({ host: 'h', pid: 999, startedAt: 1 }));

  const manager = new CacheManager({
    rootDir: dir,
    pid: 1,
    now: () => 1,
    isAlive: () => false,
    hostname: () => 'h',
  });
  // 启动时的自动回收：该收的收掉，用户的东西一个不动
  await manager.initialize();
  assert.equal(fs.existsSync(stale), false, '死进程留下的 run- 目录该收');
  assert.equal(fs.existsSync(myFolder), true, '用户自己的目录不能动');
  assert.equal(fs.existsSync(path.join(myFolder, '片子.mkv')), true);
  assert.equal(fs.existsSync(myFile), true, '用户自己的文件不能动');

  // 手动「清理残留」这条路同样只认自己建的目录
  const another = path.join(dir, 'run-888-old-abcdef');
  await fsp.mkdir(another);
  assert.equal(await manager.purgeStale(), 1, '只该清掉那一个 run- 目录');
  assert.equal(fs.existsSync(another), false);
  assert.equal(fs.existsSync(myFolder), true);
  assert.equal(fs.existsSync(myFile), true);

  // 占用统计同样只数自己的，不把用户的片子算进「缓存占用」吓唬人
  const orphan = path.join(dir, 'run-777-old-abcdef');
  await fsp.mkdir(orphan);
  await fsp.writeFile(path.join(orphan, 'x.bin'), 'z'.repeat(2048));
  const u = await manager.usage();
  assert.equal(u.staleRuns, 1, '只有那个 run- 目录算数，用户的目录不算');
});

/* ------------------------- 接线 ------------------------- */

test('换目录这道闸长在主进程里，不只靠界面把按钮禁掉', () => {
  const main = read('src', 'main', 'main.js');
  assert.match(main, /if \(store\.hasOpenSessions\(\)\) throw new Error\('正在放映时不能换缓存目录/);
  assert.match(main, /if \(remuxOutputs\.size\) throw new Error/);
  // 入参要过绝对路径校验
  assert.match(main, /validate\.absolutePath\(dir, '缓存目录'\)/);
  // 真的写一下再认，指到只读目录或没插的盘上要当场知道
  assert.match(main, /noxreel-write-test/);
});

test('配置的目录用不了时退回默认，而不是卡在启动页', () => {
  const main = read('src', 'main', 'main.js');
  const fn = main.slice(main.indexOf('async function ensureCacheReady('), main.indexOf('app.whenReady()'));
  assert.ok(fn.length > 200, `切出来的函数太短（${fn.length} 字符）`);
  assert.match(fn, /if \(cache\.rootDir === DEFAULT_CACHE_ROOT\) throw error;/);
  assert.match(fn, /cacheFallback = \{ configured: cache\.rootDir, reason:/);
  assert.match(fn, /store\.configureCache\(cache\);/, '换了 CacheManager 就得重新挂给 fileStore');
});

test('cacheDir 不再是死字段，界面真的读它', () => {
  const app = read('src', 'renderer', 'app.js');
  assert.match(app, /S\.env\?\.cacheDir/);
  assert.match(app, /window\.sw\.cache\.usage\(\)/);
  assert.match(app, /window\.sw\.cache\.purge\(\)/);
  assert.match(app, /window\.sw\.cache\.setRoot\(dir\)/);
  // 放映进行中要禁掉
  assert.match(app, /changeButton\.disabled = locked;/);
});
