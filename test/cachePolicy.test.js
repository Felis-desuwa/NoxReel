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

  // 假装磁盘只剩一点：临时条目删到只剩一条时才放得下
  const realStatfs = fsp.statfs;
  fsp.statfs = async () => ({ bavail: library.temp.size <= 1 ? 1e12 : 0, bsize: 1 });
  t.after(() => {
    fsp.statfs = realStatfs;
  });
  const fresh = manifestFor('fresh.mkv', makeChunks(0x50));
  const state = await store.openLeech(fresh);
  assert.ok(state.sessionId);
  assert.equal(fs.existsSync(kept[0].filePath), false, '最久没用的先删');
  assert.equal(fs.existsSync(kept[1].filePath), true, '删一部就够了，另一部留着');
});

/* ------------------------------ 手动模式 ------------------------------ */

test('手动模式：收的片直接写进长期缓存文件夹，收完登记下来，重启后（新的登记表对象）照样复用', async (t) => {
  const { root, keptDir } = await setup(t, { mode: 'manual' });
  const chunks = makeChunks();
  const manifest = manifestFor('我的片子.mkv', chunks);
  const state = await store.openLeech(manifest);
  assert.equal(state.filePath, path.join(keptDir, '我的片子.mkv'), '用原来的片名存在长期缓存文件夹里');
  await receiveAll(state, chunks);
  await store.close(state.sessionId);
  assert.equal(fs.existsSync(state.filePath), true, '从不自动删');

  // 「重启」：重新读登记表
  const reloaded = await new MediaLibrary({ dataDir: path.join(root, 'userdata') }).load();
  store.configureLibrary(reloaded);
  const found = reloaded.findFile(manifest.fileId);
  assert.equal(found?.persistent, true);
  assert.equal(found.entry.path, state.filePath);
  const again = await store.openLeech(manifest);
  assert.equal(again.filePath, state.filePath);
  assert.equal(again.complete, true);
  assert.equal(store.isSessionFile(state.filePath), true, '长期缓存文件夹里的文件靠这一条放行播放和扫描');
});

test('手动模式：长期缓存文件夹里已经有同名文件就另起名字，绝不覆盖用户自己的文件', async (t) => {
  const { keptDir } = await setup(t, { mode: 'manual' });
  await fsp.mkdir(keptDir, { recursive: true });
  const mine = path.join(keptDir, 'movie.mkv');
  await fsp.writeFile(mine, '用户自己的东西');
  const chunks = makeChunks();
  const state = await store.openLeech(manifestFor('movie.mkv', chunks));
  assert.equal(state.filePath, path.join(keptDir, 'movie (2).mkv'));
  assert.equal(await fsp.readFile(mine, 'utf8'), '用户自己的东西');
});

test('手动模式：没收完的新文件关会话就删；复用来的没收完不删（对得上的片下次还能用）', async (t) => {
  const { library } = await setup(t, { mode: 'manual' });
  const chunks = makeChunks();
  const manifest = manifestFor('movie.mkv', chunks);
  const partial = await store.openLeech(manifest);
  await store.writeChunk(partial.sessionId, 0, chunks[0]);
  await store.close(partial.sessionId);
  assert.equal(fs.existsSync(partial.filePath), false, '新建的、没收完的删掉');

  const full = await store.openLeech(manifest);
  await receiveAll(full, chunks);
  await store.close(full.sessionId);
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
  const full = await store.openLeech(manifest);
  await receiveAll(full, chunks);
  await store.close(full.sessionId);
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
  ];
  for (const [zh, want] of cases) assert.equal(en(zh), want, zh);
  for (const zh of ['缓存清理', '长期缓存文件夹', '长期缓存', '下载位置', '管理缓存文件', '删除所选', '边下边播', '边看边另存一份到下载位置', '临时缓存', '正在用']) {
    assert.notEqual(en(zh), zh, `${zh} 没有英文`);
  }
});
