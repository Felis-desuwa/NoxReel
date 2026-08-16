'use strict';

/**
 * 分片文件存储层。
 * seed 会话只读用户源文件；leech 会话写入应用拥有的临时目录。
 */

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const CHUNK_SIZE = 2 * 1024 * 1024;
const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024;
const MEMORY_CACHE_LIMIT = 256 * 1024 * 1024;
const FLUSH_THRESHOLD = 64 * 1024 * 1024;
const FLUSH_DELAY_MS = 100;
const MANIFEST_CACHE_LIMIT = 16;

const sessions = new Map();
const manifestCache = new Map();
const inFlightReads = new Map();
let cacheManager = null;
let pendingMemoryBytes = 0;
let seq = 0;

const nextId = (prefix) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
const cloneManifest = (manifest) => ({ ...manifest, hashes: [...manifest.hashes] });
const chunkCacheKey = (sessionId, index) => `${sessionId}\0${index}`;

class ChunkCache {
  constructor(limit) {
    this.limit = limit;
    this.bytes = 0;
    this.entries = new Map();
  }

  get(sessionId, index) {
    const key = chunkCacheKey(sessionId, index);
    const value = this.entries.get(key);
    if (!value) return null;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value.buffer;
  }

  set(sessionId, index, buffer) {
    const key = chunkCacheKey(sessionId, index);
    const old = this.entries.get(key);
    if (old) {
      this.bytes -= old.buffer.length;
      this.entries.delete(key);
    }
    this.entries.set(key, { sessionId, buffer });
    this.bytes += buffer.length;
    this.trimTo(this.limit - pendingMemoryBytes);
  }

  trimTo(targetBytes) {
    const target = Math.max(0, targetBytes);
    while (this.bytes > target && this.entries.size) {
      const [key, value] = this.entries.entries().next().value;
      this.entries.delete(key);
      this.bytes -= value.buffer.length;
    }
  }

  deleteSession(sessionId) {
    for (const [key, value] of this.entries) {
      if (value.sessionId !== sessionId) continue;
      this.entries.delete(key);
      this.bytes -= value.buffer.length;
    }
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
}

const chunkCache = new ChunkCache(MEMORY_CACHE_LIMIT);

function configureCache(manager) {
  if (!manager || typeof manager.createOwnedDir !== 'function' || typeof manager.removeOwned !== 'function') {
    throw new TypeError('无效的缓存管理器');
  }
  cacheManager = manager;
}

async function canonicalFileKey(filePath, stat) {
  const realPath = await fsp.realpath(filePath).catch(() => path.resolve(filePath));
  const normalized = process.platform === 'win32' ? realPath.toLowerCase() : realPath;
  return `${normalized}\0${stat.size}\0${stat.mtimeMs}`;
}

function rememberManifest(key, manifest) {
  manifestCache.delete(key);
  manifestCache.set(key, cloneManifest(manifest));
  while (manifestCache.size > MANIFEST_CACHE_LIMIT) manifestCache.delete(manifestCache.keys().next().value);
}

async function buildManifest(filePath, onProgress) {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) throw new Error('不是一个文件');
  if (stat.size === 0) throw new Error('文件是空的');
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`文件超过 10GB 上限（当前 ${(stat.size / 1024 ** 3).toFixed(2)}GB）`);
  }

  const cacheKey = await canonicalFileKey(filePath, stat);
  const cached = manifestCache.get(cacheKey);
  if (cached) {
    manifestCache.delete(cacheKey);
    manifestCache.set(cacheKey, cached);
    onProgress?.({ done: cached.chunkCount, total: cached.chunkCount, cached: true });
    return cloneManifest(cached);
  }

  const chunkCount = Math.ceil(stat.size / CHUNK_SIZE);
  const hashes = new Array(chunkCount);
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK_SIZE);
    for (let i = 0; i < chunkCount; i++) {
      const len = chunkLengthAt(i, stat.size);
      const { bytesRead } = await fh.read(buf, 0, len, i * CHUNK_SIZE);
      if (bytesRead !== len) throw new Error(`读取分片 ${i} 失败：期望 ${len} 字节，实际 ${bytesRead}`);
      hashes[i] = crypto.createHash('sha256').update(buf.subarray(0, len)).digest('hex');
      if (onProgress && (i % 16 === 0 || i === chunkCount - 1)) onProgress({ done: i + 1, total: chunkCount });
    }
  } finally {
    await fh.close();
  }

  const finalStat = await fsp.stat(filePath);
  if (finalStat.size !== stat.size || finalStat.mtimeMs !== stat.mtimeMs) {
    throw new Error('文件在计算校验值期间发生了变化，请重新选择');
  }

  const fileId = crypto.createHash('sha256').update(hashes.join('')).digest('hex').slice(0, 32);
  const manifest = {
    fileId,
    name: path.basename(filePath),
    size: stat.size,
    chunkSize: CHUNK_SIZE,
    chunkCount,
    hashes,
  };
  rememberManifest(cacheKey, manifest);
  return cloneManifest(manifest);
}

function chunkLengthAt(index, size) {
  const offset = index * CHUNK_SIZE;
  return Math.min(CHUNK_SIZE, size - offset);
}

async function writevFully(fh, buffers, position) {
  let views = buffers;
  let offset = position;
  while (views.length) {
    const { bytesWritten } = await fh.writev(views, offset);
    if (!bytesWritten) throw new Error('合并写入没有取得进展');
    offset += bytesWritten;
    let consumed = bytesWritten;
    let first = 0;
    while (first < views.length && consumed >= views[first].length) {
      consumed -= views[first].length;
      first++;
    }
    views = views.slice(first);
    if (consumed && views.length) views[0] = views[0].subarray(consumed);
  }
}

async function reservePendingMemory(bytes, session) {
  chunkCache.trimTo(MEMORY_CACHE_LIMIT - pendingMemoryBytes - bytes);
  if (pendingMemoryBytes + bytes <= MEMORY_CACHE_LIMIT) return;

  await Promise.all(
    [...sessions.values()]
      .filter((candidate) => candidate !== session && candidate.mode === 'leech')
      .map((candidate) => candidate.flushAll().catch(() => {}))
  );
  await session.flushAll();
  chunkCache.trimTo(MEMORY_CACHE_LIMIT - pendingMemoryBytes - bytes);
  if (pendingMemoryBytes + bytes > MEMORY_CACHE_LIMIT) throw new Error('分片内存缓冲已达到上限');
}

class Session {
  constructor({ id, manifest, filePath, mode, ownedDir = null }) {
    this.id = id;
    this.manifest = manifest;
    this.filePath = filePath;
    this.mode = mode;
    this.ownedDir = ownedDir;
    this.fh = null;
    this.have = new Uint8Array(manifest.chunkCount);
    this.haveCount = 0;
    this.contiguousIndex = 0;
    this.closed = false;
    this.closing = false;
    this.closePromise = null;
    this.pendingByIndex = new Map();
    this.pendingBytes = 0;
    this.flushTimer = null;
    this.flushPromise = null;
  }

  get contiguousBytes() {
    if (this.contiguousIndex >= this.manifest.chunkCount) return this.manifest.size;
    return this.contiguousIndex * this.manifest.chunkSize;
  }

  get complete() {
    return this.haveCount === this.manifest.chunkCount;
  }

  _advanceContiguous() {
    while (this.contiguousIndex < this.manifest.chunkCount && this.have[this.contiguousIndex] === 1) {
      this.contiguousIndex++;
    }
  }

  state() {
    return {
      sessionId: this.id,
      mode: this.mode,
      filePath: this.filePath,
      fileId: this.manifest.fileId,
      size: this.manifest.size,
      chunkSize: this.manifest.chunkSize,
      chunkCount: this.manifest.chunkCount,
      haveCount: this.haveCount,
      contiguousBytes: this.contiguousBytes,
      complete: this.complete,
      bitfield: packBitfield(this.have),
    };
  }

  _scheduleFlush() {
    if (this.flushTimer || this.closing) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this._startFlush().catch(() => {});
    }, FLUSH_DELAY_MS);
  }

  async queueWrite(index, buffer) {
    const duplicate = this.pendingByIndex.get(index);
    if (duplicate) return duplicate.promise.then((result) => ({ ...result, duplicate: true }));

    await reservePendingMemory(buffer.length, this);
    if (this.closing || this.closed) throw new Error('会话正在关闭');

    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry = { index, buffer, status: 'queued', promise, resolve, reject };
    this.pendingByIndex.set(index, entry);
    this.pendingBytes += buffer.length;
    pendingMemoryBytes += buffer.length;
    chunkCache.trimTo(MEMORY_CACHE_LIMIT - pendingMemoryBytes);

    if (this.pendingBytes >= FLUSH_THRESHOLD) this._startFlush().catch(() => {});
    else this._scheduleFlush();
    return promise;
  }

  _startFlush() {
    if (this.flushPromise) return this.flushPromise;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;

    const entries = [...this.pendingByIndex.values()].filter((entry) => entry.status === 'queued');
    if (!entries.length) return Promise.resolve();
    for (const entry of entries) entry.status = 'flushing';

    this.flushPromise = this._flushEntries(entries).finally(() => {
      this.flushPromise = null;
      const queuedBytes = [...this.pendingByIndex.values()]
        .filter((entry) => entry.status === 'queued')
        .reduce((sum, entry) => sum + entry.buffer.length, 0);
      if (queuedBytes >= FLUSH_THRESHOLD || this.closing) this._startFlush().catch(() => {});
      else if (queuedBytes) this._scheduleFlush();
    });
    return this.flushPromise;
  }

  async _flushEntries(entries) {
    const sorted = [...entries].sort((a, b) => a.index - b.index);
    const groups = [];
    for (const entry of sorted) {
      const previous = groups[groups.length - 1];
      if (previous && entry.index === previous.lastIndex + 1) {
        previous.entries.push(entry);
        previous.lastIndex = entry.index;
      } else {
        groups.push({ firstIndex: entry.index, lastIndex: entry.index, entries: [entry] });
      }
    }

    try {
      for (const group of groups) {
        await writevFully(
          this.fh,
          group.entries.map((entry) => entry.buffer),
          group.firstIndex * this.manifest.chunkSize
        );
      }

      for (const entry of sorted) {
        this.have[entry.index] = 1;
        this.haveCount++;
        this._advanceContiguous();
        this._releasePending(entry);
        chunkCache.set(this.id, entry.index, entry.buffer);
        entry.resolve({
          ok: true,
          contiguousBytes: this.contiguousBytes,
          haveCount: this.haveCount,
          complete: this.complete,
        });
      }
    } catch (error) {
      for (const entry of entries) {
        this._releasePending(entry);
        entry.reject(error);
      }
      throw error;
    }
  }

  _releasePending(entry) {
    if (!this.pendingByIndex.delete(entry.index)) return;
    this.pendingBytes -= entry.buffer.length;
    pendingMemoryBytes -= entry.buffer.length;
  }

  async flushAll() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    while (this.pendingByIndex.size) {
      if (this.flushPromise) await this.flushPromise;
      else await this._startFlush();
    }
  }
}

function packBitfield(have) {
  const bytes = new Uint8Array(Math.ceil(have.length / 8));
  for (let i = 0; i < have.length; i++) {
    if (have[i] === 1) bytes[i >> 3] |= 0x80 >> (i & 7);
  }
  return Buffer.from(bytes).toString('base64');
}

function unpackBitfield(b64, chunkCount) {
  const bytes = Buffer.from(b64, 'base64');
  const have = new Uint8Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) have[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  return have;
}

async function openSeed(manifest, filePath, { ownedDir = null } = {}) {
  if (ownedDir && (!cacheManager || !cacheManager.owns(ownedDir) || !cacheManager.owns(filePath))) {
    throw new Error('临时片源不属于当前运行实例');
  }
  const id = nextId('seed');
  const session = new Session({ id, manifest, filePath, mode: 'seed', ownedDir });
  session.fh = await fsp.open(filePath, 'r');
  session.have.fill(1);
  session.haveCount = manifest.chunkCount;
  session.contiguousIndex = manifest.chunkCount;
  sessions.set(id, session);
  return session.state();
}

async function openLeech(manifest) {
  if (!cacheManager) throw new Error('缓存目录尚未初始化');
  const id = nextId('leech');
  const ownedDir = await cacheManager.createOwnedDir('media');
  const filePath = path.join(ownedDir, safeName(manifest.name));
  const session = new Session({ id, manifest, filePath, mode: 'leech', ownedDir });
  try {
    session.fh = await fsp.open(filePath, 'w+');
    await session.fh.truncate(manifest.size);
    sessions.set(id, session);
    return session.state();
  } catch (error) {
    await session.fh?.close().catch(() => {});
    await cacheManager.removeOwned(ownedDir).catch(() => {});
    throw error;
  }
}

function safeName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 200) || 'video.mkv';
}

function get(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || session.closed || session.closing) throw new Error(`会话不存在：${sessionId}`);
  return session;
}

async function readChunk(sessionId, index) {
  const session = get(sessionId);
  if (index < 0 || index >= session.manifest.chunkCount) throw new Error(`分片下标越界：${index}`);
  if (session.have[index] !== 1) throw new Error(`本地没有分片 ${index}`);
  const cached = chunkCache.get(sessionId, index);
  if (cached) return cached;

  const key = chunkCacheKey(sessionId, index);
  const existing = inFlightReads.get(key);
  if (existing) return existing.promise;

  const promise = (async () => {
    const len = chunkLengthAt(index, session.manifest.size);
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await session.fh.read(buf, 0, len, index * session.manifest.chunkSize);
    if (bytesRead !== len) throw new Error(`读取分片 ${index} 短读`);
    chunkCache.set(sessionId, index, buf);
    return buf;
  })().finally(() => inFlightReads.delete(key));
  inFlightReads.set(key, { sessionId, promise });
  return promise;
}

async function writeChunk(sessionId, index, data) {
  const session = get(sessionId);
  if (session.mode !== 'leech') throw new Error('不能向只读片源写入分片');
  if (index < 0 || index >= session.manifest.chunkCount) throw new Error(`分片下标越界：${index}`);

  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const expectedLen = chunkLengthAt(index, session.manifest.size);
  if (buf.length !== expectedLen) return { ok: false, reason: 'length', expected: expectedLen, actual: buf.length };
  const digest = crypto.createHash('sha256').update(buf).digest('hex');
  if (digest !== session.manifest.hashes[index]) return { ok: false, reason: 'hash' };
  if (session.have[index] === 1) {
    return {
      ok: true,
      duplicate: true,
      contiguousBytes: session.contiguousBytes,
      haveCount: session.haveCount,
      complete: session.complete,
    };
  }
  return session.queueWrite(index, buf);
}

function state(sessionId) {
  return get(sessionId).state();
}

async function close(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || session.closed) return;
  if (session.closePromise) return session.closePromise;

  session.closing = true;
  session.closePromise = (async () => {
    if (session.flushTimer) clearTimeout(session.flushTimer);
    session.flushTimer = null;
    if (session.mode === 'leech') await session.flushAll().catch(() => {});
    await Promise.allSettled(
      [...inFlightReads.values()]
        .filter((entry) => entry.sessionId === sessionId)
        .map((entry) => entry.promise)
    );
    session.closed = true;
    await session.fh?.close().catch(() => {});
    chunkCache.deleteSession(sessionId);
    sessions.delete(sessionId);
    if (session.ownedDir && cacheManager) await cacheManager.removeOwned(session.ownedDir).catch(() => {});
  })();
  return session.closePromise;
}

async function closeAll() {
  await Promise.all([...sessions.keys()].map(close));
}

function testingStats() {
  return {
    chunkCacheBytes: chunkCache.bytes,
    pendingMemoryBytes,
    totalMemoryBytes: chunkCache.bytes + pendingMemoryBytes,
    manifestCacheEntries: manifestCache.size,
    inFlightReads: inFlightReads.size,
    sessionCount: sessions.size,
  };
}

function resetForTests() {
  manifestCache.clear();
  chunkCache.clear();
  inFlightReads.clear();
  pendingMemoryBytes = 0;
}

module.exports = {
  CHUNK_SIZE,
  MAX_FILE_SIZE,
  MEMORY_CACHE_LIMIT,
  FLUSH_THRESHOLD,
  FLUSH_DELAY_MS,
  configureCache,
  buildManifest,
  openSeed,
  openLeech,
  readChunk,
  writeChunk,
  state,
  close,
  closeAll,
  packBitfield,
  unpackBitfield,
  chunkLengthAt,
  _testing: { stats: testingStats, reset: resetForTests },
};
