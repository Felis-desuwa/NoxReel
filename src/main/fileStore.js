'use strict';

/**
 * 分片文件存储层。
 * seed 会话只读用户源文件；leech 会话写入应用拥有的临时目录。
 */

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { validateMediaHeader } = require('./mediaGuard');

const CHUNK_SIZE = 2 * 1024 * 1024;
const MEMORY_CACHE_LIMIT = 256 * 1024 * 1024;
const FLUSH_THRESHOLD = 64 * 1024 * 1024;
const FLUSH_DELAY_MS = 100;
const MANIFEST_CACHE_LIMIT = 16;
const SPARSE_TIMEOUT_MS = 5000;

const sessions = new Map();
const manifestCache = new Map();
const inFlightReads = new Map();
let cacheManager = null;
let pendingMemoryBytes = 0;
// 正在打开、还没登记进 sessions 的接收会话要占的磁盘空间，见 reservedDiskBytes()
let openingBytes = 0;
let seq = 0;

/**
 * 把接收文件标成稀疏文件用的外部命令。测试里换掉它，模拟 fsutil 卡死、不存在或失败。
 * 用绝对路径，不走 PATH 查找。
 */
const sparseTool = {
  timeoutMs: SPARSE_TIMEOUT_MS,
  command: () => path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'fsutil.exe'),
  args: (filePath) => ['sparse', 'setflag', filePath],
};
// 标不上稀疏的卷（卷根 -> 原因）。FAT32/exFAT 不支持稀疏，失败一次之后这个卷就不再白起进程。
const sparseSkippedVolumes = new Map();

const nextId = (prefix) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
const cloneManifest = (manifest) => ({ ...manifest, hashes: [...manifest.hashes] });
const chunkCacheKey = (sessionId, index) => `${sessionId}\0${index}`;
const asDuplicate = (result) => ({ ...result, duplicate: true });

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

/**
 * 缓存清理方式和长期缓存文件夹（见 mediaLibrary.js）：
 *  - auto（默认）：收的片放本次运行的临时缓存，关会话（换片、退房、移出列表）不删，
 *    收完的登记成临时条目留着复用，关软件时整个运行目录一起清掉；磁盘不够时先删最久没用的。
 *  - manual：收的片直接写进长期保留的缓存文件夹（keptDir，不在运行目录里、也不在系统临时目录里），
 *    收完的登记下来跨重启复用，从不自动删；磁盘不够就报出来，由用户自己去清理。
 * 两种模式下，没收完的片在关会话时都删掉（没有断点续传，留着也用不上）。
 */
let library = null;
let policy = { mode: 'auto', keptDir: null };

function configureLibrary(lib) {
  library = lib;
}

function setPolicy({ mode, keptDir }) {
  policy = {
    mode: mode === 'manual' ? 'manual' : 'auto',
    keptDir: typeof keptDir === 'string' && path.isAbsolute(keptDir) ? path.resolve(keptDir) : null,
  };
}

const pathKey = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

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

/**
 * 算整部片的分片哈希。signal 用于用户在房间里取消加片：每读一片前查一次，
 * 已取消就抛「操作已取消」，文件句柄照常在 finally 里关掉。
 * 命中清单缓存时不读文件、瞬间返回，不看 signal。
 */
async function buildManifest(filePath, onProgress, { signal } = {}) {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) throw new Error('不是一个文件');
  if (stat.size === 0) throw new Error('文件是空的');

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
      if (signal?.aborted) throw new Error('操作已取消');
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
    // 预分配之后还没真正占到盘上的字节（稀疏文件是整个文件），减去已写入的就是这场接收还要吃掉的空间
    this.unallocatedAtOpen = 0;
    this.writtenBytes = 0;
    // 文件在长期缓存文件夹里（手动模式新收的，或者复用了登记过的持久副本），关会话时不随临时缓存走
    this.persistent = false;
    // 这个文件是这次会话新建的：没收完就删；复用来的不是（里面对得上的分片下次还用得上）
    this.createdFresh = false;
  }

  /** 这场接收还要从磁盘上吃掉多少字节。整块预分配的文件已经占好了，是 0。 */
  get outstandingBytes() {
    return Math.max(0, this.unallocatedAtOpen - this.writtenBytes);
  }

  progress() {
    return { contiguousBytes: this.contiguousBytes, haveCount: this.haveCount, complete: this.complete };
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
    if (duplicate) return duplicate.promise.then(asDuplicate);

    await reservePendingMemory(buffer.length, this);
    if (this.closing || this.closed) throw new Error('会话正在关闭');
    // 上面那个 await 在内存缓冲吃满时要等一整轮落盘，同一片的另一份写入可能已经趁这段时间
    // 登记了、甚至写完了，必须重查。不查的话后到的会在表里覆盖先到的：先到的那次写入
    // 永远不返回，它占的内存计数也永远退不回来，攒够约 128 次这个进程就再也收不了片。
    const raced = this.pendingByIndex.get(index);
    if (raced) return raced.promise.then(asDuplicate);
    if (this.have[index] === 1) return { ok: true, duplicate: true, ...this.progress() };

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
        this.writtenBytes += entry.buffer.length;
        this._advanceContiguous();
        this._releasePending(entry);
        chunkCache.set(this.id, entry.index, entry.buffer);
        entry.resolve({ ok: true, ...this.progress() });
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
    // 只退自己那一份：同一下标上换成了别的 entry，就不能拿它去抵这一份的计数
    if (this.pendingByIndex.get(entry.index) !== entry) return;
    this.pendingByIndex.delete(entry.index);
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
  assertManifestShape(manifest);
  const id = nextId('seed');
  const session = new Session({ id, manifest, filePath, mode: 'seed', ownedDir });
  session.fh = await fsp.open(filePath, 'r');
  session.have.fill(1);
  session.haveCount = manifest.chunkCount;
  session.contiguousIndex = manifest.chunkCount;
  sessions.set(id, session);
  return session.state();
}

/**
 * 接收前先看磁盘放不放得下。
 *
 * 以前有 10GB 上限兜着，磁盘被一部片子塞满的情况很少见；上限去掉以后这就是常态风险。
 * 接收文件是稀疏文件（NTFS 上由 markSparse 标记，ext4 这类天生如此），truncate 照样成功，
 * 不先查就要传到一半才写不进去。留 1% 或 256MB 的余量（取大），别把系统盘刚好塞到 0 字节。
 *
 * reservedBytes 是本进程里其他接收会话还没写进来、但迟早要占的字节（可以传函数，查完余量再算）。
 * 稀疏文件不预先占盘，只看磁盘余量的话，播放列表里每一部单独都放得下，
 * 合起来却能把磁盘塞满。报出来的「只剩」也是扣掉这部分之后的数：界面按它决定要不要清掉已播放的缓存。
 */
async function ensureFreeSpace(dir, bytesNeeded, reservedBytes = 0) {
  let stats;
  try {
    stats = await fsp.statfs(dir);
  } catch {
    return; // 查不到就不拦：宁可让真正的写入错误说话，也不因为探测失败误伤正常接收
  }
  const reserved = Number(typeof reservedBytes === 'function' ? reservedBytes() : reservedBytes) || 0;
  const free = Number(stats.bavail) * Number(stats.bsize) - Math.max(0, reserved);
  const reserve = Math.max(256 * 1024 * 1024, Math.round(bytesNeeded * 0.01));
  if (!Number.isFinite(free) || free >= bytesNeeded + reserve) return;
  const gb = (n) => (n / 1024 ** 3).toFixed(2);
  throw new Error(`磁盘空间不够：这部片子需要 ${gb(bytesNeeded)}GB，缓存所在的磁盘只剩 ${gb(Math.max(0, free))}GB`);
}

/** 本进程里的接收会话还要从磁盘上吃掉多少字节（含正在打开的）。 */
function reservedDiskBytes() {
  let total = openingBytes;
  for (const session of sessions.values()) {
    if (session.mode === 'leech' && !session.closed) total += session.outstandingBytes;
  }
  return total;
}

/**
 * 在 NTFS 上把接收文件标成稀疏文件。返回是否标上了。
 *
 * 不标的话 truncate 在 NTFS 上只是 SetEndOfFile：空间整块预留，「有效数据长度」（VDL）停在 0。
 * 之后第一次写到 VDL 后面，NTFS 要先同步把中间整段清零才返回。调度器一上来就要文件尾 4MB
 * （MKV 的 Cues），可信房间中途加入又是从位置 P 开始写，一部 50GB 的片子这一下就得写 50GB 的零
 * （本机 SSD 上 2GB 就要 0.7 秒，机械硬盘上是几分钟），这期间落盘被占住，后面的分片全排在它后面。
 * 稀疏文件没有这回事，没写过的区间读出来照样是 0。
 *
 * 不引原生模块，只能借系统自带的 fsutil（非管理员也能对自己建的文件用）。只在 Windows 上做；
 * FAT32/exFAT 不支持稀疏，fsutil 会失败，记下这个卷以后不再试。标不上、超时都退回原来的整块预分配，
 * 只是慢，不影响正确性。必须在 truncate 之前做：空间已经整块分出去了再标就晚了。
 */
async function markSparse(filePath) {
  if (process.platform !== 'win32') return false;
  const volume = path.parse(path.resolve(filePath)).root.toLowerCase();
  if (sparseSkippedVolumes.has(volume)) return false;
  const result = await runSparseTool(filePath);
  if (result.ok) return true;
  sparseSkippedVolumes.set(volume, result.reason);
  console.warn(`[fileStore] 没能把接收文件标成稀疏文件（${result.reason}），${volume} 上退回整块预分配`);
  return false;
}

function runSparseTool(filePath) {
  const timeoutMs = sparseTool.timeoutMs;
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // execFile 自己的 timeout 负责杀进程；这个计时器兜底，进程杀不掉、回调迟迟不来也不能卡住接收
    timer = setTimeout(() => finish({ ok: false, reason: `超过 ${timeoutMs}ms 没有返回` }), timeoutMs);
    try {
      execFile(
        sparseTool.command(),
        sparseTool.args(filePath),
        { windowsHide: true, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 },
        (error) => {
          if (!error) return finish({ ok: true });
          if (error.killed) return finish({ ok: false, reason: `超过 ${timeoutMs}ms 没有返回` });
          finish({ ok: false, reason: typeof error.code === 'number' ? `退出码 ${error.code}` : error.code || error.message });
        }
      );
    } catch (error) {
      finish({ ok: false, reason: error.message });
    }
  });
}

/** 预分配之后还没真正占到盘上的字节数。读不出占用块数时按「已经整块占好」算，也就是原来的假设。 */
async function unallocatedBytes(fh, size) {
  const st = await fh.stat().catch(() => null);
  if (!st || typeof st.blocks !== 'number' || !(st.blocks >= 0)) return 0;
  return Math.max(0, size - st.blocks * 512);
}

/**
 * 清单的形状在 IPC 入口（security.manifest）已经严格校验过，这里是纵深防御：
 * 预分配和位图的大小都直接来自这几个数，负数、NaN、对不上的分片数会让 truncate 和
 * new Uint8Array 走进异常分支，chunkSize 和 CHUNK_SIZE 不一致则偏移全错。
 */
function assertManifestShape(manifest) {
  const ok =
    manifest !== null &&
    typeof manifest === 'object' &&
    Number.isSafeInteger(manifest.size) &&
    manifest.size > 0 &&
    manifest.chunkSize === CHUNK_SIZE &&
    Number.isSafeInteger(manifest.chunkCount) &&
    manifest.chunkCount === Math.ceil(manifest.size / CHUNK_SIZE) &&
    Array.isArray(manifest.hashes) &&
    manifest.hashes.length === manifest.chunkCount &&
    typeof manifest.name === 'string';
  if (!ok) throw new TypeError('无效的媒体清单');
}

/**
 * 开一个接收会话。先看本机有没有这部片收完的副本（登记表里，按 fileId 认）：有就逐片核对，
 * 对得上的片直接算已收；一片都对不上才新建文件。
 * @param {object} manifest
 * @param {{onReuse?: (e: object) => void}} [opts] onReuse：核对进度（大片子要核对一阵子，界面得说一声）
 */
async function openLeech(manifest, { onReuse = null } = {}) {
  if (!cacheManager) throw new Error('缓存目录尚未初始化');
  assertManifestShape(manifest);
  const reused = await tryReuse(manifest, onReuse);
  if (reused) return reused.state();

  const id = nextId('leech');
  const manual = policy.mode === 'manual' && !!policy.keptDir;
  let ownedDir = null;
  let filePath = null;
  let created = false;
  let session = null;
  let counted = false;
  try {
    if (manual) {
      await fsp.mkdir(policy.keptDir, { recursive: true });
      // 手动模式从不自动删东西：放不下就直接报，让用户自己去清理
      await ensureFreeSpace(policy.keptDir, manifest.size, reservedDiskBytes);
      filePath = await uniquePath(policy.keptDir, safeName(manifest.name));
    } else {
      ownedDir = await cacheManager.createOwnedDir('media');
      filePath = path.join(ownedDir, safeName(manifest.name));
      // 先查余量再按分片数分配位图：放不下的清单连这点内存都不该花
      await ensureFreeSpaceWithEviction(ownedDir, manifest.size);
    }
    openingBytes += manifest.size;
    counted = true;
    session = new Session({ id, manifest, filePath, mode: 'leech', ownedDir });
    session.persistent = manual;
    // 长期缓存文件夹可能是用户自己指的：只新建、绝不覆盖已有的同名文件（uniquePath 挑好了名字，wx 再兜一次并发）
    session.fh = await fsp.open(filePath, manual ? 'wx+' : 'w+');
    created = true;
    session.createdFresh = true;
    await markSparse(filePath);
    await session.fh.truncate(manifest.size);
    session.unallocatedAtOpen = await unallocatedBytes(session.fh, manifest.size);
    sessions.set(id, session);
    return session.state();
  } catch (error) {
    await session?.fh?.close().catch(() => {});
    if (ownedDir) await cacheManager.removeOwned(ownedDir).catch(() => {});
    else if (created && filePath) await fsp.unlink(filePath).catch(() => {});
    throw error;
  } finally {
    if (counted) openingBytes -= manifest.size;
  }
}

/** 自动模式：放不下时先删临时缓存里最久没用的收完的片，删一部查一次，直到放得下或没得删。 */
async function ensureFreeSpaceWithEviction(dir, bytesNeeded) {
  for (;;) {
    try {
      return await ensureFreeSpace(dir, bytesNeeded, reservedDiskBytes);
    } catch (error) {
      if (!library || !/磁盘空间不够/.test(String(error.message)) || !(await library.evictOldestTemp())) throw error;
    }
  }
}

/** 不重名的文件名：「片名.mkv」已经有了就用「片名 (2).mkv」。 */
async function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const candidate = path.join(dir, n === 1 ? name : `${base} (${n})${ext}`);
    try {
      await fsp.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error('同名文件太多了');
}

/**
 * 本机有这部片收完的副本（临时缓存或长期缓存文件夹里）就接过来：逐片核对哈希，对得上的算已收。
 * 一片都对不上（被改过、被换掉了）就不用它。
 * @returns {Promise<Session|null>}
 */
async function tryReuse(manifest, onReuse) {
  if (!library) return null;
  const found = library.findFile(manifest.fileId);
  if (!found) return null;
  const { entry, persistent } = found;
  // 同一个文件已经有会话在用（不会发生：渲染进程一部片只开一个会话），不去抢
  if ([...sessions.values()].some((s) => !s.closed && pathKey(s.filePath) === pathKey(entry.path))) return null;
  let fh = null;
  try {
    const stat = await fsp.stat(entry.path);
    if (!stat.isFile() || stat.size !== manifest.size) throw new Error('大小对不上');
    fh = await fsp.open(entry.path, 'r+');
  } catch {
    await fh?.close().catch(() => {});
    // 文件没了、被换成别的了：登记作废（持久的只摘登记，不碰那个位置上现在的东西）
    if (persistent) await library.forgetPath(entry.path).catch(() => {});
    else if (library.takeTemp(entry.id)?.ownedDir) await cacheManager.removeOwned(entry.ownedDir).catch(() => {});
    return null;
  }
  // 临时条目交给会话：用着的时候磁盘不够的清理不会把它删掉；会话关的时候再登记回去
  if (!persistent) library.takeTemp(entry.id);
  const session = new Session({
    id: nextId('leech'),
    manifest,
    filePath: entry.path,
    mode: 'leech',
    ownedDir: persistent ? null : entry.ownedDir,
  });
  session.persistent = persistent;
  session.fh = fh;
  const matched = await verifyExisting(session, onReuse).catch(() => 0);
  if (!matched) {
    await fh.close().catch(() => {});
    if (persistent) await library.forgetPath(entry.path).catch(() => {});
    else if (entry.ownedDir) await cacheManager.removeOwned(entry.ownedDir).catch(() => {});
    return null;
  }
  sessions.set(session.id, session);
  if (persistent) library.touch(entry.id).catch(() => {});
  return session;
}

/**
 * 逐片读、逐片算 SHA-256，和清单对。哈希走 WebCrypto（线程池里算），几十 GB 的片子核对期间
 * 主进程照样能响应别的请求。第 0 片还要过一遍容器头检查 —— 和收片时 writeChunk 同一道关。
 * @returns {Promise<number>} 对上的片数
 */
async function verifyExisting(session, onReuse) {
  const { manifest } = session;
  const total = manifest.chunkCount;
  const buf = Buffer.allocUnsafe(manifest.chunkSize);
  const report = (stage, extra = {}) => {
    try {
      onReuse?.({ stage, fileId: manifest.fileId, name: manifest.name, total, ...extra });
    } catch {
      /* 报进度失败不影响核对 */
    }
  };
  report('start', { done: 0 });
  let lastReport = Date.now();
  for (let i = 0; i < total; i++) {
    if (session.closing) break;
    if (Date.now() - lastReport >= 500) {
      lastReport = Date.now();
      report('progress', { done: i });
    }
    const len = chunkLengthAt(i, manifest.size);
    const { bytesRead } = await session.fh.read(buf, 0, len, i * manifest.chunkSize);
    if (bytesRead !== len) continue;
    const chunk = buf.subarray(0, len);
    const digest = Buffer.from(await crypto.webcrypto.subtle.digest('SHA-256', chunk)).toString('hex');
    if (digest !== manifest.hashes[i]) continue;
    if (i === 0 && !validateMediaHeader(manifest.name, chunk).ok) continue;
    session.have[i] = 1;
    session.haveCount++;
  }
  session._advanceContiguous();
  // 复用的文件早就整个在盘上了，不会再吃新的空间
  session.unallocatedAtOpen = 0;
  report('done', { done: total, matched: session.haveCount });
  return session.haveCount;
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
  if (!Number.isInteger(index) || index < 0 || index >= session.manifest.chunkCount) throw new Error(`分片下标越界：${index}`);
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
  if (!Number.isInteger(index) || index < 0 || index >= session.manifest.chunkCount) throw new Error(`分片下标越界：${index}`);

  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const expectedLen = chunkLengthAt(index, session.manifest.size);
  if (buf.length !== expectedLen) return { ok: false, reason: 'length', expected: expectedLen, actual: buf.length };
  if (index === 0) {
    const header = validateMediaHeader(session.manifest.name, buf);
    if (!header.ok) return { ok: false, reason: 'media-type', detail: header.reason };
  }
  const digest = crypto.createHash('sha256').update(buf).digest('hex');
  if (digest !== session.manifest.hashes[index]) return { ok: false, reason: 'hash' };
  if (session.have[index] === 1) return { ok: true, duplicate: true, ...session.progress() };
  return session.queueWrite(index, buf);
}

async function scanTarget(sessionId) {
  const session = get(sessionId);
  if (session.mode !== 'leech' || !session.complete) throw new Error('接收文件尚未完整校验');
  await session.flushAll();
  return session.filePath;
}

/**
 * 还有没有开着的会话。换缓存目录时要拦 —— cache.owns() 是一道授权检查，
 * 中途换掉 runDir 会让当前会话的文件立刻变成「不属于本实例」。
 */
function hasOpenSessions() {
  return sessions.size > 0;
}

/**
 * 这个路径是不是某个开着的接收会话的文件。手动模式和复用的文件在长期缓存文件夹里，
 * 不归临时缓存（cache.owns）管 —— 播放、扫描、打开所在位置要靠这一条放行。
 */
function isSessionFile(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return false;
  const key = pathKey(filePath);
  for (const session of sessions.values()) {
    if (session.mode === 'leech' && !session.closed && pathKey(session.filePath) === key) return true;
  }
  return false;
}

function state(sessionId) {
  return get(sessionId).state();
}

/**
 * 关会话。文件怎么处理看清理方式（见 setPolicy 上面的说明）：
 *  - 收完的：自动模式登记成临时条目留着复用（关软件时随运行目录清掉），手动模式登记进长期缓存；
 *  - 没收完的、新建的：删掉；复用来的持久副本不删（对得上的分片下次还用得上）；
 *  - discard（扫描发现威胁）：不管收没收完、在哪儿，一律删掉、摘登记。
 * @param {string} sessionId
 * @param {{discard?: boolean}} [opts]
 */
async function close(sessionId, { discard = false } = {}) {
  const session = sessions.get(sessionId);
  if (!session || session.closed) return;
  if (discard) session.discard = true;
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
    await settleFile(session);
  })();
  return session.closePromise;
}

/** 会话关了以后它的文件去哪儿。 */
async function settleFile(session) {
  if (session.mode !== 'leech') {
    // 做种的是用户自己的文件，不碰；接手的转封装副本在软件自己的目录里，照旧删掉
    if (session.ownedDir && cacheManager) await cacheManager.removeOwned(session.ownedDir).catch(() => {});
    return;
  }
  const keep = session.complete && !session.discard;
  if (session.persistent) {
    if (keep) {
      await library?.addFile({ manifest: session.manifest, filePath: session.filePath }).catch(() => {});
    } else if (session.discard || session.createdFresh) {
      await fsp.unlink(session.filePath).catch(() => {});
      await library?.forgetPath(session.filePath).catch(() => {});
    }
    return;
  }
  if (!session.ownedDir || !cacheManager) return;
  if (keep && library) library.addTempFile({ manifest: session.manifest, filePath: session.filePath, ownedDir: session.ownedDir });
  else await cacheManager.removeOwned(session.ownedDir).catch(() => {});
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
    openingBytes,
  };
}

function resetForTests() {
  manifestCache.clear();
  chunkCache.clear();
  inFlightReads.clear();
  sparseSkippedVolumes.clear();
  pendingMemoryBytes = 0;
  library = null;
  policy = { mode: 'auto', keptDir: null };
}

module.exports = {
  CHUNK_SIZE,
  ensureFreeSpace,
  MEMORY_CACHE_LIMIT,
  FLUSH_THRESHOLD,
  FLUSH_DELAY_MS,
  configureCache,
  buildManifest,
  configureLibrary,
  setPolicy,
  openSeed,
  openLeech,
  readChunk,
  writeChunk,
  state,
  hasOpenSessions,
  isSessionFile,
  scanTarget,
  close,
  closeAll,
  packBitfield,
  unpackBitfield,
  chunkLengthAt,
  _testing: {
    stats: testingStats,
    reset: resetForTests,
    sparseTool,
    sparseSkippedVolumes,
    markSparse,
    reservedDiskBytes,
  },
};
