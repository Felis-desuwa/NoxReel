'use strict';

// 缓存清理方式（自动 / 手动）、长期缓存文件夹、下载位置、复用收完的片（逐片核对）、手动清理
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { CacheManager } = require('../src/main/cacheManager');
const { MediaLibrary, sanitizeEntries } = require('../src/main/mediaLibrary');
const store = require('../src/main/fileStore');
const settings = require('../src/main/settings');
const { WORK_DIR } = require('../src/main/linkCache');

// fileStore 在片子之外要留的余量（1% 或 256MB 取大）
const SPARE = 256 * 1024 * 1024;

async function tempDir(t, prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

function makeChunks(fill = 0x11) {
  const chunks = [Buffer.alloc(store.CHUNK_SIZE, fill), Buffer.alloc(store.CHUNK_SIZE, fill + 1), Buffer.alloc(1000, fill + 2)];
  chunks[0].writeUInt32BE(0x1a45dfa3, 0); // Matroska/EBML 文件头，过得了 writeChunk 的容器检查
  return chunks;
}

function manifestFor(name, chunks) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const hashes = chunks.map((chunk) => crypto.createHash('sha256').update(chunk).digest('hex'));
  return {
    fileId: crypto.createHash('sha256').update(hashes.join('')).digest('hex').slice(0, 32),
    name,
    size,
    chunkSize: store.CHUNK_SIZE,
    chunkCount: chunks.length,
    hashes,
  };
}

async function receiveAll(state, chunks) {
  for (let i = 0; i < chunks.length; i++) {
    const r = await store.writeChunk(state.sessionId, i, chunks[i]);
    assert.equal(r.ok, true, `第 ${i} 片写不进去`);
  }
  assert.equal(store.state(state.sessionId).complete, true);
}

async function setup(t, { mode = 'auto' } = {}) {
  const root = await tempDir(t, 'noxreel-policy-');
  const cache = new CacheManager({ rootDir: path.join(root, 'cache') });
  await cache.initialize();
  store._testing.reset();
  store.configureCache(cache);
  const library = await new MediaLibrary({ dataDir: path.join(root, 'userdata'), removeOwned: (dir) => cache.removeOwned(dir) }).load();
  store.configureLibrary(library);
  const keptDir = path.join(root, 'kept');
  store.setPolicy({ mode, keptDir });
  t.after(async () => {
    await store.closeAll();
    store._testing.reset();
  });
  return { root, cache, library, keptDir };
}

/* ------------------------------ 配置 ------------------------------ */

test('清理方式默认自动，配置里写别的一律当自动；下载位置不是绝对路径就用默认的', () => {
  assert.equal(settings.resolveCacheMode({}), 'auto');
  assert.equal(settings.resolveCacheMode({ cacheMode: 'manual' }), 'manual');
  assert.equal(settings.resolveCacheMode({ cacheMode: 'MANUAL' }), 'auto');
  const def = path.resolve('/default/NoxReel');
  assert.equal(settings.resolveDownloadDir({}, def), def);
  assert.equal(settings.resolveDownloadDir({ downloadDir: 'relative/dir' }, def), def);
  assert.equal(settings.resolveDownloadDir({ downloadDir: path.resolve('/videos/mine') }, def), path.resolve('/videos/mine'));
});

/* ------------------------------ 自动模式 ------------------------------ */

test('自动模式：收完的片关会话（换片、退房）不删，同一部再开直接复用，核对进度报出来', async (t) => {
  const { library } = await setup(t);
  const chunks = makeChunks();
  const manifest = manifestFor('movie.mkv', chunks);
  const first = await store.openLeech(manifest);
  await receiveAll(first, chunks);
  await store.close(first.sessionId);
  assert.equal(fs.existsSync(first.filePath), true, '关会话不删：只在关软件时随运行目录清掉');
  assert.equal(library.findFile(manifest.fileId)?.persistent, false, '登记成临时条目');

  const events = [];
  const again = await store.openLeech(manifest, { onReuse: (e) => events.push(e) });
  assert.equal(again.filePath, first.filePath, '复用的是同一个文件');
  assert.equal(again.complete, true, '核对全部通过，一片都不用再传');
  assert.equal(again.haveCount, chunks.length);
  assert.deepEqual(events.map((e) => e.stage), ['start', 'done']);
  assert.equal(events.at(-1).matched, chunks.length);
  assert.equal(library.findFile(manifest.fileId), null, '用着的时候不在临时条目里（磁盘不够的清理动不到它）');
  await store.close(again.sessionId);
  assert.equal(library.findFile(manifest.fileId)?.persistent, false, '关了再登记回去');
});

test('自动模式：没收完的片关会话就删（没有断点续传，留着也用不上）', async (t) => {
  const { library } = await setup(t);
  const chunks = makeChunks();
  const manifest = manifestFor('movie.mkv', chunks);
  const state = await store.openLeech(manifest);
  await store.writeChunk(state.sessionId, 0, chunks[0]);
  await store.close(state.sessionId);
  assert.equal(fs.existsSync(path.dirname(state.filePath)), false);
  assert.equal(library.findFile(manifest.fileId), null);
});

test('discard（扫描发现威胁）：收完了也删，不登记', async (t) => {
  const { library } = await setup(t);
  const chunks = makeChunks();
  const manifest = manifestFor('movie.mkv', chunks);
  const state = await store.openLeech(manifest);
  await receiveAll(state, chunks);
  await store.close(state.sessionId, { discard: true });
  assert.equal(fs.existsSync(path.dirname(state.filePath)), false);
  assert.equal(library.findFile(manifest.fileId), null);
});

test('自动模式：磁盘不够时先删临时条目里最久没用的，删一部查一次', async (t) => {
  const { library } = await setup(t);
  const kept = [];
  for (const [i, name] of ['old.mkv', 'newer.mkv'].entries()) {
    const chunks = makeChunks(0x30 + i * 4);
    const manifest = manifestFor(name, chunks);
    const state = await store.openLeech(manifest);
    await receiveAll(state, chunks);
    await store.close(state.sessionId);
    kept.push({ manifest, filePath: state.filePath });
  }
  // 「old」更久没用
  library.findFile(kept[0].manifest.fileId).entry.lastUsedAt = 1;
  library.findFile(kept[1].manifest.fileId).entry.lastUsedAt = 2;

  // 假装磁盘差一点点（1MB）才放得下：删掉的临时条目按 4MB 腾出来，删一部就够
  const fresh = manifestFor('fresh.mkv', makeChunks(0x50));
  const base = fresh.size + SPARE - 1024 * 1024;
  const freed = () => kept.filter((k) => !fs.existsSync(k.filePath)).length * 4 * 1024 * 1024;
  const realStatfs = fsp.statfs;
  fsp.statfs = async () => ({ bavail: base + freed(), bsize: 1 });
  t.after(() => {
    fsp.statfs = realStatfs;
  });
  const state = await store.openLeech(fresh);
  assert.ok(state.sessionId);
  assert.equal(fs.existsSync(kept[0].filePath), false, '最久没用的先删');
  assert.equal(fs.existsSync(kept[1].filePath), true, '删一部就够了，另一部留着');
  assert.equal(library.temp.size, 1);
});

test('自动模式：全删了也放不下就一条都不删，直接报磁盘不够', async (t) => {
  const { library } = await setup(t);
  const kept = [];
  for (const [i, name] of ['a.mkv', 'b.mkv'].entries()) {
    const chunks = makeChunks(0x60 + i * 4);
    const manifest = manifestFor(name, chunks);
    const state = await store.openLeech(manifest);
    await receiveAll(state, chunks);
    await store.close(state.sessionId);
    kept.push(state.filePath);
  }
  const realStatfs = fsp.statfs;
  // 可用空间是 0：两部临时缓存（各约 4MB）全删了也凑不出 256MB 余量加一部片
  fsp.statfs = async () => ({ bavail: 0, bsize: 1 });
  t.after(() => {
    fsp.statfs = realStatfs;
  });
  await assert.rejects(store.openLeech(manifestFor('big.mkv', makeChunks(0x70))), /磁盘空间不够/);
  assert.equal(library.temp.size, 2, '一条都没删');
  for (const file of kept) assert.equal(fs.existsSync(file), true, `${path.basename(file)} 被白删了`);
});

test('自动模式：淘汰跳过删了也腾不出地方的（硬链接到下载文件夹），删不掉的登记留着', async (t) => {
  const { root, library } = await setup(t);
  const kept = [];
  for (const [i, name] of ['linked.mkv', 'plain.mkv'].entries()) {
    const chunks = makeChunks(0x80 + i * 4);
    const manifest = manifestFor(name, chunks);
    const state = await store.openLeech(manifest);
    await receiveAll(state, chunks);
    await store.close(state.sessionId);
    kept.push({ manifest, filePath: state.filePath });
  }
  // 「linked」最久没用，但它另存到下载文件夹时是硬链接：删了缓存那份一个字节也腾不出来
  library.findFile(kept[0].manifest.fileId).entry.lastUsedAt = 1;
  library.findFile(kept[1].manifest.fileId).entry.lastUsedAt = 2;
  const downloads = path.join(root, 'downloads');
  await fsp.mkdir(downloads);
  await fsp.link(kept[0].filePath, path.join(downloads, 'linked.mkv'));

  assert.equal(await library.evictOldestTemp(), true);
  assert.equal(fs.existsSync(kept[0].filePath), true, '硬链接出去的不删');
  assert.equal(fs.existsSync(kept[1].filePath), false);

  // 剩下那条删不掉（被播放器占着）：不算淘汰成功，登记也不能丢
  const lib2 = await new MediaLibrary({ dataDir: path.join(root, 'data2'), removeOwned: async () => false }).load();
  lib2.addTempFile({ manifest: kept[1].manifest, filePath: kept[0].filePath, ownedDir: path.dirname(kept[0].filePath) });
  await fsp.rm(path.join(downloads, 'linked.mkv'));
  assert.equal(await lib2.evictOldestTemp(), false);
  assert.equal(lib2.temp.size, 1, '删不掉就还登记着');
  const [id] = lib2.temp.keys();
  await assert.rejects(lib2.remove(id), /删不掉/, '手动清理删不掉要报出来，不能说删掉了');
  assert.equal(lib2.temp.size, 1);
});

/* ------------------------------ 手动模式 ------------------------------ */

test('手动模式：收的片写进长期缓存文件夹，收完登记下来，重启后（新的登记表对象）照样复用', async (t) => {
  const { root, keptDir, library } = await setup(t, { mode: 'manual' });
  const chunks = makeChunks();
  const manifest = manifestFor('我的片子.mkv', chunks);
  const state = await store.openLeech(manifest);
  assert.equal(state.persistent, true, '界面据此说「打开长期缓存位置」');
  await receiveAll(state, chunks);
  await store.close(state.sessionId);
  const saved = path.join(keptDir, '我的片子.mkv');
  assert.equal(fs.existsSync(saved), true, '收完用原来的片名存在长期缓存文件夹里，从不自动删');
  assert.equal(library.findFile(manifest.fileId)?.entry.path, saved);
  assert.equal(fs.existsSync(path.dirname(state.filePath)), false, '工作目录收完就撤了');

  // 「重启」：重新读登记表
  const reloaded = await new MediaLibrary({ dataDir: path.join(root, 'userdata') }).load();
  store.configureLibrary(reloaded);
  const found = reloaded.findFile(manifest.fileId);
  assert.equal(found?.persistent, true);
  assert.equal(found.entry.path, saved);
  const again = await store.openLeech(manifest);
  assert.equal(again.filePath, saved);
  assert.equal(again.complete, true);
  assert.equal(again.persistent, true);
  assert.equal(store.isSessionFile(saved), true, '长期缓存文件夹里的文件靠这一条放行播放和扫描');
});

test('手动模式：没收完之前放在工作目录里，关机、崩溃留下的半截文件不会顶着正式片名', async (t) => {
  const { keptDir } = await setup(t, { mode: 'manual' });
  const chunks = makeChunks();
  const state = await store.openLeech(manifestFor('半截.mkv', chunks));
  await store.writeChunk(state.sessionId, 0, chunks[0]);
  assert.equal(path.basename(path.dirname(path.dirname(state.filePath))), WORK_DIR, '接收中的文件在 .noxreel-downloading/<号>/ 下');
  assert.equal(path.dirname(path.dirname(path.dirname(state.filePath))), keptDir);
  assert.deepEqual(fs.readdirSync(keptDir), [WORK_DIR], '长期缓存文件夹根下没有顶着正式片名的半截文件');
  // 「崩溃」：会话没关。下次启动时 linkCache.cleanupLeftovers 按这个子目录名回收（和在线视频的半截文件同一处）
  assert.equal(store.isSessionFile(state.filePath), true);
});

test('手动模式：长期缓存文件夹里已经有同名文件就另起名字，绝不覆盖用户自己的文件', async (t) => {
  const { keptDir, library } = await setup(t, { mode: 'manual' });
  await fsp.mkdir(keptDir, { recursive: true });
  const mine = path.join(keptDir, 'movie.mkv');
  await fsp.writeFile(mine, '用户自己的东西');
  const chunks = makeChunks();
  const manifest = manifestFor('movie.mkv', chunks);
  const state = await store.openLeech(manifest);
  await receiveAll(state, chunks);
  // 收的过程中用户又放进来一个「movie (2).mkv」：挪过去时也不能覆盖
  await fsp.writeFile(path.join(keptDir, 'movie (2).mkv'), '也是用户的');
  await store.close(state.sessionId);
  assert.equal(library.findFile(manifest.fileId)?.entry.path, path.join(keptDir, 'movie (3).mkv'));
  assert.equal(await fsp.readFile(mine, 'utf8'), '用户自己的东西');
  assert.equal(await fsp.readFile(path.join(keptDir, 'movie (2).mkv'), 'utf8'), '也是用户的');
  // E4-F：收完挪成正式片名之后，长期缓存文件夹里不留一个空的 .noxreel-downloading
  assert.equal(fs.existsSync(path.join(keptDir, WORK_DIR)), false);
});

test('手动模式：没收完的新文件关会话就删；复用来的没收完不删（对得上的片下次还能用）', async (t) => {
  const { library } = await setup(t, { mode: 'manual' });
  const chunks = makeChunks();
  const manifest = manifestFor('movie.mkv', chunks);
  const partial = await store.openLeech(manifest);
  await store.writeChunk(partial.sessionId, 0, chunks[0]);
  await store.close(partial.sessionId);
  assert.equal(fs.existsSync(partial.filePath), false, '新建的、没收完的删掉');
  assert.equal(fs.existsSync(path.dirname(partial.filePath)), false, '工作目录一起删');
  assert.equal(fs.existsSync(path.dirname(path.dirname(partial.filePath))), false, '外层的 .noxreel-downloading 空了也删（E4-F）');

  const first = await store.openLeech(manifest);
  await receiveAll(first, chunks);
  await store.close(first.sessionId);
  const full = { filePath: library.findFile(manifest.fileId).entry.path };
  // 保存的文件中间坏了一片
  const fh = await fsp.open(full.filePath, 'r+');
  await fh.write(Buffer.alloc(16, 0xee), 0, 16, store.CHUNK_SIZE + 10);
  await fh.close();

  const reused = await store.openLeech(manifest);
  assert.equal(reused.filePath, full.filePath);
  assert.equal(reused.complete, false);
  assert.equal(reused.haveCount, chunks.length - 1, '坏掉的那一片不算，其余照用');
  await store.close(reused.sessionId);
  assert.equal(fs.existsSync(full.filePath), true, '复用来的没收完不删');
  assert.ok(library.findFile(manifest.fileId), '登记还在');

  // 补上坏的那一片就完整了
  const again = await store.openLeech(manifest);
  const r = await store.writeChunk(again.sessionId, 1, chunks[1]);
  assert.equal(r.ok, true);
  assert.equal(store.state(again.sessionId).complete, true);
});

test('复用的文件一片都对不上：不用它、登记作废，但不删那个位置上的东西（持久的）', async (t) => {
  const { library } = await setup(t, { mode: 'manual' });
  const chunks = makeChunks();
  const manifest = manifestFor('movie.mkv', chunks);
  const first = await store.openLeech(manifest);
  await receiveAll(first, chunks);
  await store.close(first.sessionId);
  const full = { filePath: library.findFile(manifest.fileId).entry.path };
  // 用户拿一个同样大小的别的文件覆盖了它
  await fsp.writeFile(full.filePath, Buffer.alloc(manifest.size, 0x77));

  const state = await store.openLeech(manifest);
  assert.notEqual(state.filePath, full.filePath, '另起新文件接收');
  assert.equal(state.haveCount, 0);
  assert.equal(fs.existsSync(full.filePath), true, '那是用户现在的文件，不碰');
  assert.equal(library.findFile(manifest.fileId), null, '旧登记作废');
});

/* ------------------------------ 登记表 ------------------------------ */

test('登记表：手改坏的条目一律扔掉', () => {
  const ok = { id: 'a'.repeat(16), kind: 'file', name: 'x', path: path.resolve('/v/x.mkv'), size: 10, fileId: 'b'.repeat(32) };
  const out = sanitizeEntries([
    ok,
    { ...ok }, // 重复 id
    { ...ok, id: 'c'.repeat(16), path: 'relative.mkv' },
    { ...ok, id: 'd'.repeat(16), size: -1 },
    { ...ok, id: 'e'.repeat(16), kind: 'exe' },
    { ...ok, id: 'f'.repeat(16), fileId: '../x' },
    { id: '1'.repeat(16), kind: 'link', name: 'l', path: path.resolve('/v/l.mp4'), size: 5, url: 'javascript:alert(1)' },
    { id: '2'.repeat(16), kind: 'link', name: 'l', path: path.resolve('/v/l.mp4'), size: 5, url: 'https://example.org/v' },
    null,
    'x',
  ]);
  assert.deepEqual(
    out.map((e) => e.id),
    ['a'.repeat(16), '2'.repeat(16)]
  );
  assert.deepEqual(sanitizeEntries({ not: 'array' }), []);
});

test('手动清理：只删登记过、大小还对得上的文件；大小变了只摘登记，不碰文件', async (t) => {
  const dir = await tempDir(t, 'noxreel-lib-');
  const library = await new MediaLibrary({ dataDir: path.join(dir, 'data') }).load();
  const a = path.join(dir, 'a.mkv');
  const b = path.join(dir, 'b.mkv');
  await fsp.writeFile(a, Buffer.alloc(100));
  await fsp.writeFile(b, Buffer.alloc(100));
  const idA = await library.addFile({ manifest: { fileId: '1'.repeat(32), name: 'a.mkv', size: 100 }, filePath: a });
  const idB = await library.addLink({ url: 'https://example.org/v', title: '在线', filePath: b, size: 100 });
  assert.equal(library.findLink('https://example.org/v')?.id, idB);
  // b 被换成了别的东西（大小变了）
  await fsp.writeFile(b, Buffer.alloc(50));

  assert.equal((await library.list()).length, 2);
  await library.remove(idA);
  await library.remove(idB);
  assert.equal(fs.existsSync(a), false);
  assert.equal(fs.existsSync(b), true, '大小对不上说明已经不是我们存的那个');
  assert.deepEqual(await library.list(), []);

  // 登记表落盘了
  const reloaded = await new MediaLibrary({ dataDir: path.join(dir, 'data') }).load();
  assert.deepEqual(await reloaded.list(), []);
});

test('手动清理列清单时，文件已经不在的条目顺手摘掉', async (t) => {
  const dir = await tempDir(t, 'noxreel-lib-');
  const library = await new MediaLibrary({ dataDir: path.join(dir, 'data') }).load();
  const a = path.join(dir, 'a.mkv');
  await fsp.writeFile(a, Buffer.alloc(10));
  await library.addFile({ manifest: { fileId: '1'.repeat(32), name: 'a.mkv', size: 10 }, filePath: a });
  await fsp.rm(a);
  assert.deepEqual(await library.list(), []);
  assert.equal(library.findFile('1'.repeat(32)), null);
});

/* ------------------------------ 盘不在（移动硬盘没插） ------------------------------ */

test('登记的文件在不在：文件没了但目录还在才算没了；目录都不在（Windows 上盘也不在）判断不了', async (t) => {
  const { locateFile } = require('../src/main/mediaLibrary');
  const dir = await tempDir(t, 'noxreel-locate-');
  const file = path.join(dir, 'a.mkv');
  await fsp.writeFile(file, 'x');
  assert.equal((await locateFile(file)).status, 'ok');
  await fsp.rm(file);
  assert.equal((await locateFile(file)).status, 'gone', '目录在、文件 ENOENT：确实没了');
  // 整个文件夹被删了：Windows 上看那个盘还在不在（在就是被删了）；POSIX 分不清挂载点没挂上，宁可当判断不了
  const inMissingDir = path.join(dir, 'kept', 'b.mkv');
  assert.equal((await locateFile(inMissingDir)).status, process.platform === 'win32' ? 'gone' : 'unavailable');
});

test('盘不在时启动（列清单）不摘登记：标成暂不可用、删不了；盘插回来照常复用', async (t) => {
  const dir = await tempDir(t, 'noxreel-lib-');
  const file = path.join(dir, 'a.mkv');
  await fsp.writeFile(file, Buffer.alloc(10));
  let plugged = false;
  const locate = async (p) => (plugged ? require('../src/main/mediaLibrary').locateFile(p) : { status: 'unavailable' });
  const library = await new MediaLibrary({ dataDir: path.join(dir, 'data'), locate }).load();
  const id = await library.addFile({ manifest: { fileId: '1'.repeat(32), name: 'a.mkv', size: 10 }, filePath: file });

  const listed = await library.list();
  assert.equal(listed.length, 1, '盘不在也不能摘');
  assert.equal(listed[0].available, false);
  await assert.rejects(library.remove(id), /访问不了/, '盘不在时删不了：摘了登记，盘插回来就成了没人管的孤儿');
  // 登记表落盘的内容也还在（下次启动照样认得）
  const reloaded = await new MediaLibrary({ dataDir: path.join(dir, 'data'), locate }).load();
  assert.equal((await reloaded.list()).length, 1);

  plugged = true;
  const again = await reloaded.list();
  assert.equal(again[0].available, true);
  assert.ok(reloaded.findFile('1'.repeat(32)));
});

test('复用时盘不在：这次照常新收，登记留着', async (t) => {
  const { root } = await setup(t, { mode: 'manual' });
  const chunks = makeChunks();
  const manifest = manifestFor('movie.mkv', chunks);
  const first = await store.openLeech(manifest);
  await receiveAll(first, chunks);
  await store.close(first.sessionId);

  let plugged = false;
  const { locateFile } = require('../src/main/mediaLibrary');
  const library = await new MediaLibrary({
    dataDir: path.join(root, 'userdata'),
    locate: async (p) => (plugged ? locateFile(p) : { status: 'unavailable' }),
  }).load();
  store.configureLibrary(library);
  const saved = library.findFile(manifest.fileId).entry.path;
  const fresh = await store.openLeech(manifest);
  assert.notEqual(fresh.filePath, saved, '盘不在：另起新文件接收');
  assert.ok(library.findFile(manifest.fileId), '登记没摘');
  await store.close(fresh.sessionId);

  plugged = true;
  const reused = await store.openLeech(manifest);
  assert.equal(reused.filePath, saved, '盘插回来照常复用');
  assert.equal(reused.complete, true);
});

test('缓存位置写不进去（盘拔了、没权限）报成「缓存位置用不了」，和不安全的清单分开', async (t) => {
  const { root } = await setup(t, { mode: 'manual' });
  // 长期缓存文件夹指到一个文件底下：建目录必然失败
  const blocker = path.join(root, 'not-a-dir');
  await fsp.writeFile(blocker, 'x');
  store.setPolicy({ mode: 'manual', keptDir: path.join(blocker, 'kept') });
  await assert.rejects(store.openLeech(manifestFor('movie.mkv', makeChunks())), (error) => {
    assert.match(error.message, /^缓存位置用不了：/);
    assert.ok(error.code, '带着原来的错误码');
    return true;
  });
  // 清单本身不对仍然照旧报
  await assert.rejects(store.openLeech({ ...manifestFor('movie.mkv', makeChunks()), chunkSize: 1 }), /无效的媒体清单/);
});

test('长期缓存文件夹所在的盘不在：原因说成「所在的盘 X: 不在」，不是 Node 的 ENOENT 原文（E4-B）', { skip: process.platform !== 'win32' }, async (t) => {
  const letter = [...'ZYXWVUTSRQPONMLKJIHG'].find((l) => !fs.existsSync(`${l}:\\`));
  if (!letter) return t.skip('这台机器上找不到空着的盘符');
  await setup(t, { mode: 'manual' });
  store.setPolicy({ mode: 'manual', keptDir: `${letter}:\\NoxReel\\kept` });
  await assert.rejects(store.openLeech(manifestFor('movie.mkv', makeChunks())), (error) => {
    assert.equal(error.message, `缓存位置用不了：所在的盘 ${letter}: 不在，可能是移动硬盘没插、网络盘没连上或者盘符变了`);
    assert.equal(error.code, 'ENOENT', '错误码照旧带着');
    return true;
  });
});

/* ------------------------------ 复用：先开会话，后台核对 ------------------------------ */

function bigChunks(count, fill) {
  const chunks = [];
  for (let i = 0; i < count; i++) chunks.push(Buffer.alloc(store.CHUNK_SIZE, (fill + i) & 0xff));
  chunks[0].writeUInt32BE(0x1a45dfa3, 0);
  return chunks;
}

async function receivedCopy(t, count = 12) {
  const env = await setup(t);
  const chunks = bigChunks(count, 0x21);
  const manifest = manifestFor('long.mkv', chunks);
  const first = await store.openLeech(manifest);
  await receiveAll(first, chunks);
  await store.close(first.sessionId);
  return { ...env, chunks, manifest, filePath: first.filePath };
}

function waitForStage(events, stage) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const hit = events.find((e) => e.stage === stage);
      if (hit) return resolve(hit);
      if (Date.now() - started > 10_000) return reject(new Error(`等不到 ${stage}`));
      setTimeout(poll, 10);
    };
    poll();
  });
}

test('复用：抽查完片头片尾就开出会话，其余的在后台核对，进度带着 sessionId 和最新 state', async (t) => {
  const { chunks, manifest } = await receivedCopy(t);
  const events = [];
  const state = await store.openLeech(manifest, { onReuse: (e) => events.push(e) });
  assert.equal(state.haveCount, 6, '先只有文件头 4 片 + 文件尾 2 片');
  assert.equal(state.complete, false);
  assert.equal(store._testing.stats().sessionCount, 1, '会话已经登记：关会话、退房够得着它');
  // 对端这时送来一片还没核对到的：照常收，核对时不会记两遍
  const r = await store.writeChunk(state.sessionId, 7, chunks[7]);
  assert.equal(r.ok, true);

  const done = await waitForStage(events, 'done');
  assert.equal(done.sessionId, state.sessionId);
  assert.equal(done.matched, chunks.length - 1, '对端送来的那一片不核对（在落盘就跳过），不算核对上的');
  // E4-A：这一片单独记成「对端先送到的」，界面据此仍说「核对通过」，不说成有一片对不上
  assert.equal(done.fromPeer, 1);
  assert.equal(done.matched + done.fromPeer, done.total);
  // done 带的 state 可能还没算上正在落盘的那一片 —— 界面那边是按写入回包记的，两边并起来就齐了
  assert.ok(done.state.haveCount >= chunks.length - 1);
  const final = store.state(state.sessionId);
  assert.equal(final.haveCount, chunks.length, '一片不多一片不少');
  assert.equal(final.complete, true);
  assert.equal(final.contiguousBytes, manifest.size);
});

test('复用：后台核对随关会话停下；没核完的临时副本登记回去，文件还在', async (t) => {
  const { manifest, library, filePath } = await receivedCopy(t, 40);
  const events = [];
  const state = await store.openLeech(manifest, { onReuse: (e) => events.push(e) });
  assert.equal(state.complete, false);
  assert.equal(library.findFile(manifest.fileId), null, '用着的时候不在临时条目里');
  await store.close(state.sessionId);
  const doneAfterClose = events.filter((e) => e.stage === 'done').length;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(events.filter((e) => e.stage === 'done').length, doneAfterClose, '关了之后不再报');
  assert.equal(doneAfterClose, 0, '没核完就停了');
  assert.equal(fs.existsSync(filePath), true, '没核完的副本不删');
  assert.equal(library.findFile(manifest.fileId)?.entry.path, filePath, '登记回去，下次照样核对着用');

  // closeAll（退出、页面刷新后的兜底回收）也够得着正在核对的会话
  const again = await store.openLeech(manifest);
  assert.equal(again.complete, false);
  await store.closeAll();
  assert.equal(store._testing.stats().sessionCount, 0);
  assert.ok(library.findFile(manifest.fileId));
});

test('复用：片头片尾抽查一片都对不上就不用这个副本，不等整部核对完', async (t) => {
  const { manifest, library, filePath } = await receivedCopy(t, 12);
  // 头 4 片、尾 2 片全坏了（中间的还是好的也不再看）
  const fh = await fsp.open(filePath, 'r+');
  for (const i of [0, 1, 2, 3, 10, 11]) await fh.write(Buffer.alloc(16, 0xee), 0, 16, i * store.CHUNK_SIZE + 5);
  await fh.close();
  const events = [];
  const state = await store.openLeech(manifest, { onReuse: (e) => events.push(e) });
  assert.notEqual(state.filePath, filePath, '另起新文件接收');
  assert.equal(state.haveCount, 0);
  assert.deepEqual(events.map((e) => e.stage), ['start', 'done']);
  assert.equal(events.at(-1).matched, 0);
  assert.equal(library.findFile(manifest.fileId), null, '临时条目作废');
});

test('会话 state 带 persistent：自动模式新收的是 false', async (t) => {
  await setup(t);
  const state = await store.openLeech(manifestFor('movie.mkv', makeChunks()));
  assert.equal(state.persistent, false);
});

test('缓存清理、复用、边下边播的新文案都有英文', async () => {
  const { pathToFileURL } = require('node:url');
  const { translate } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/lib/i18n.js')).href);
  const en = (s) => translate(s, 'en');
  const cases = [
    ['共 3 个，12.5 GB', '3 file(s), 12.5 GB in total'],
    ['删掉了 2 个缓存文件', 'Deleted 2 cached file(s)'],
    ['1 个正在用，没删', '1 in use, not deleted'],
    ['下载位置已改到 D:影片', 'Download folder changed to D:影片'],
    ['本机已有《片子.mkv》，正在核对…', 'Already have “片子.mkv” on this computer, checking it…'],
    ['本机已有的《片子.mkv》核对通过，不用再传', '“片子.mkv” on this computer checks out; no need to transfer it again'],
    ['本机的《片子.mkv》有 10/12 片对得上，其余照常接收', '10/12 chunks of “片子.mkv” on this computer match; receiving the rest as usual'],
    ['本机的《片子.mkv》和这一部对不上，重新接收', '“片子.mkv” on this computer does not match this video; receiving it again'],
    [
      '没法接收《片子.mkv》：缓存位置用不了：ENOENT: no such file or directory',
      'Cannot receive “片子.mkv”: the cache location is unavailable: ENOENT: no such file or directory',
    ],
    [
      '换位置会立刻清掉本次运行里缓存的 3 个文件（12.5 GB），再放要重新接收。确定要换就再点一次「换个位置」。',
      'Changing the location immediately clears 3 file(s) cached during this session (12.5 GB); playing them again means receiving them again. Select “Change location” again to go ahead.',
    ],
    ['正在把《片子.mkv》另存到下载位置…', 'Saving a copy of “片子.mkv” to the download folder…'],
  ];
  for (const [zh, want] of cases) assert.equal(en(zh), want, zh);
  for (const zh of [
    '缓存清理',
    '长期缓存文件夹',
    '长期缓存',
    '下载位置',
    '管理缓存文件',
    '删除所选',
    '边下边播',
    '边看边另存一份到下载位置',
    '临时缓存',
    '正在用',
    '暂不可用（所在的盘不在）',
    '打开长期缓存位置',
    '换位置会立刻清掉本次运行里自动缓存的片，长期缓存文件夹里的不动。',
    '在线视频还在缓存，完成或取消后再换缓存目录',
    '完整文件安全扫描通过；缓存在关软件时清掉',
    '完整文件安全扫描通过；这部片存在长期缓存文件夹里，可在设置里清理',
    '安全扫描通过，正在打开播放器；缓存在关软件时清掉',
    '安全扫描通过，正在打开播放器；这部片存在长期缓存文件夹里，可在设置里清理',
    '安全扫描通过 · 缓存关软件时清掉',
    '安全扫描通过 · 已存进长期缓存文件夹',
    '手动清理模式下收的片和手动缓存的在线视频放在这里（自动模式下手动缓存的在线视频放在临时缓存里）。它跟着上面的缓存位置走；缓存位置是默认的系统临时目录时，放在本机应用数据目录里，免得被系统的磁盘清理删掉。',
  ]) {
    assert.notEqual(en(zh), zh, `${zh} 没有英文`);
  }
});

test('界面：扫描通过的提示按文件在哪儿说，不再说「退出房间后删除」；删了文件、清了残留就重试放不下的片', () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  assert.doesNotMatch(app, /退出房间后会自动删除缓存|缓存退出后自动清理/);
  assert.match(app, /const kept = !!session\.persistent;/);
  assert.match(app, /if \(r\.removed > 0\) retryDiskFull\(\);/, '「删除所选」删掉了东西就重试');
  assert.match(app, /if \(removed > 0\) retryDiskFull\(\);/, '「清理残留」清掉了东西就重试');
  assert.match(app, /S\.env\.cacheFallback = r\.fallback \|\| null;/, '换位置后撤掉「这次用不了」的提示');
  assert.match(app, /refreshCacheFileList\?\.\(\);/, '换位置后刷新缓存文件列表');
  assert.match(app, /\/缓存位置用不了：\/\.test\(message\)/, '缓存位置用不了不记成拒收');
});
