'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { CacheManager } = require('../src/main/cacheManager');
const store = require('../src/main/fileStore');

async function tempDir(t, prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
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

test('启动只回收已停止实例的缓存目录', async (t) => {
  const root = await tempDir(t, 'noxreel-cache-manager-');
  const stale = path.join(root, 'run-111-old-abcdef');
  const live = path.join(root, 'run-222-old-abcdef');
  const unrelated = path.join(root, 'do-not-delete');
  await Promise.all([fsp.mkdir(stale), fsp.mkdir(live), fsp.mkdir(unrelated)]);

  const manager = new CacheManager({
    rootDir: root,
    pid: 333,
    now: () => 12345,
    isAlive: (pid) => pid === 222,
  });
  await manager.initialize();

  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(live), true);
  assert.equal(fs.existsSync(unrelated), true);
  assert.equal(fs.existsSync(manager.runDir), true);
  await manager.cleanupRun();
  assert.equal(fs.existsSync(manager.runDir), false);
});

test('乱序分片批量写入正确，关闭接收会话后删除完整缓存', async (t) => {
  const root = await tempDir(t, 'noxreel-store-');
  const manager = new CacheManager({ rootDir: path.join(root, 'cache') });
  await manager.initialize();
  store.configureCache(manager);
  store._testing.reset();
  t.after(() => store.closeAll());

  const chunks = [
    Buffer.alloc(store.CHUNK_SIZE, 0x11),
    Buffer.alloc(store.CHUNK_SIZE, 0x22),
    Buffer.alloc(store.CHUNK_SIZE, 0x33),
  ];
  const manifest = manifestFor('movie.mkv', chunks);
  const state = await store.openLeech(manifest);
  const sessionDir = path.dirname(state.filePath);

  const results = await Promise.all([
    store.writeChunk(state.sessionId, 1, chunks[1]),
    store.writeChunk(state.sessionId, 0, chunks[0]),
    store.writeChunk(state.sessionId, 2, chunks[2]),
  ]);
  assert.equal(results.every((result) => result.ok), true);
  assert.equal(store.state(state.sessionId).complete, true);
  assert.deepEqual(await fsp.readFile(state.filePath), Buffer.concat(chunks));
  assert.deepEqual(await store.readChunk(state.sessionId, 1), chunks[1]);
  assert.equal((await fsp.readdir(sessionDir)).some((name) => name.endsWith('.swpart')), false);
  assert.ok(store._testing.stats().totalMemoryBytes <= store.MEMORY_CACHE_LIMIT);

  await Promise.all([store.close(state.sessionId), store.close(state.sessionId)]);
  assert.equal(fs.existsSync(sessionDir), false);

  const incomplete = await store.openLeech(manifest);
  const incompleteDir = path.dirname(incomplete.filePath);
  const pendingWrite = store.writeChunk(incomplete.sessionId, 0, chunks[0]);
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.all([pendingWrite, store.close(incomplete.sessionId)]);
  assert.equal(fs.existsSync(incompleteDir), false);
  await manager.cleanupRun();
});

test('关闭片源时保留原视频，只删除软件拥有的转封装副本', async (t) => {
  const root = await tempDir(t, 'noxreel-source-');
  const manager = new CacheManager({ rootDir: path.join(root, 'cache') });
  await manager.initialize();
  store.configureCache(manager);
  store._testing.reset();

  const source = path.join(root, 'original.mkv');
  const sourceChunk = Buffer.from('original-video');
  await fsp.writeFile(source, sourceChunk);
  const sourceManifest = manifestFor('original.mkv', [sourceChunk]);
  const sourceState = await store.openSeed(sourceManifest, source);
  await store.close(sourceState.sessionId);
  assert.equal(fs.existsSync(source), true);

  const remuxDir = await manager.createOwnedDir('remux');
  const remuxPath = path.join(remuxDir, 'original.faststart.mp4');
  await fsp.writeFile(remuxPath, sourceChunk);
  const remuxState = await store.openSeed(sourceManifest, remuxPath, { ownedDir: remuxDir });
  await store.close(remuxState.sessionId);
  assert.equal(fs.existsSync(remuxDir), false);
  await manager.cleanupRun();
});

test('清单缓存命中未修改文件，并在文件变化后失效', async (t) => {
  const root = await tempDir(t, 'noxreel-manifest-');
  const file = path.join(root, 'clip.mkv');
  await fsp.writeFile(file, 'first-version');
  store._testing.reset();

  const first = await store.buildManifest(file);
  let cacheHit = false;
  const second = await store.buildManifest(file, (progress) => {
    cacheHit ||= progress.cached === true;
  });
  assert.equal(cacheHit, true);
  assert.equal(second.fileId, first.fileId);

  await fsp.writeFile(file, 'second-version-with-another-size');
  const changed = await store.buildManifest(file);
  assert.notEqual(changed.fileId, first.fileId);
});
