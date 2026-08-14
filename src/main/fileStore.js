'use strict';

/**
 * 分片文件存储层。
 *
 * 两种会话：
 *  - seed：本地已有完整文件，按需读出分片发给别人。
 *  - leech：本地没有文件，预分配等大稀疏文件，收到分片后按偏移写入。
 *
 * 「边下边播」的关键是 contiguousBytes（连续水位线）：从文件头开始连续已落盘的
 * 字节数。播放器只能安全读到这里，再往后是空洞（读出来是 0，会花屏/崩解码器）。
 * 同步引擎靠这个水位线和播放位置的差值来决定要不要让全员暂停等人。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB，规格要求 2-4MB
const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024; // 10GB 上限；JS Number 和 Node 文件偏移都可安全表示
const PART_SUFFIX = '.swpart'; // 断点续传的位图边车文件

/** @type {Map<string, Session>} */
const sessions = new Map();

let seq = 0;
const nextId = (p) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/**
 * 扫描整个文件，切分成分片并逐片算 SHA-256，产出清单。
 * 清单是收方的唯一真相来源：知道多大、多少片、每片该是什么哈希。
 */
async function buildManifest(filePath, onProgress) {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) throw new Error('不是一个文件');
  if (stat.size === 0) throw new Error('文件是空的');
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`文件超过 10GB 上限（当前 ${(stat.size / 1024 ** 3).toFixed(2)}GB）`);
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
      if (onProgress && (i % 16 === 0 || i === chunkCount - 1)) {
        onProgress({ done: i + 1, total: chunkCount });
      }
    }
  } finally {
    await fh.close();
  }

  // fileId 由所有分片哈希推导 —— 同样的内容在任何机器上得到同样的 id。
  const fileId = crypto.createHash('sha256').update(hashes.join('')).digest('hex').slice(0, 32);

  return {
    fileId,
    name: path.basename(filePath),
    size: stat.size,
    chunkSize: CHUNK_SIZE,
    chunkCount,
    hashes,
  };
}

function chunkLengthAt(index, size) {
  const offset = index * CHUNK_SIZE;
  return Math.min(CHUNK_SIZE, size - offset);
}

class Session {
  constructor({ id, manifest, filePath, mode }) {
    this.id = id;
    this.manifest = manifest;
    this.filePath = filePath;
    this.mode = mode; // 'seed' | 'leech'
    this.fh = null;
    this.have = new Uint8Array(manifest.chunkCount); // 1 = 已落盘且校验通过
    this.haveCount = 0;
    this.contiguousIndex = 0; // 第一个缺失分片的下标
    this.closed = false;
    this._flushTimer = null;
  }

  get partPath() {
    return this.filePath + PART_SUFFIX;
  }

  /** 从文件头开始连续可安全读取的字节数。 */
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

  /** 位图落盘，用于断点续传。写得很频繁，所以做了防抖。 */
  _scheduleFlush() {
    if (this.mode !== 'leech' || this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._flushNow().catch(() => {});
    }, 1000);
  }

  async _flushNow() {
    if (this.closed || this.mode !== 'leech') return;
    const payload = JSON.stringify({
      fileId: this.manifest.fileId,
      size: this.manifest.size,
      chunkSize: this.manifest.chunkSize,
      chunkCount: this.manifest.chunkCount,
      bits: packBitfield(this.have),
    });
    await fsp.writeFile(this.partPath, payload, 'utf8');
  }
}

/** 把 have 数组压成 base64 位图，2500 片只要 313 字节，够小到能塞进每条控制消息。 */
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
  for (let i = 0; i < chunkCount; i++) {
    have[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  }
  return have;
}

/** 做种：文件已在本地，全部分片标记为已有。 */
async function openSeed(manifest, filePath) {
  const id = nextId('seed');
  const s = new Session({ id, manifest, filePath, mode: 'seed' });
  s.fh = await fsp.open(filePath, 'r');
  s.have.fill(1);
  s.haveCount = manifest.chunkCount;
  s.contiguousIndex = manifest.chunkCount;
  sessions.set(id, s);
  return s.state();
}

/**
 * 接收：预分配等大文件，让播放器可以直接 open 这个路径。
 * 如果目标已存在且边车位图对得上，就接着上次的进度续传。
 */
async function openLeech(manifest, destDir) {
  const id = nextId('leech');
  await fsp.mkdir(destDir, { recursive: true });
  const filePath = path.join(destDir, safeName(manifest.name));
  const s = new Session({ id, manifest, filePath, mode: 'leech' });

  const resumed = await tryResume(s);

  s.fh = await fsp.open(filePath, resumed ? 'r+' : 'w+');
  if (!resumed) {
    // 预分配到最终大小。NTFS 上后续按偏移写入即可，中间是空洞。
    await s.fh.truncate(manifest.size);
  }

  sessions.set(id, s);
  return { ...s.state(), resumed };
}

/** 尝试读取边车位图恢复进度；任何不匹配都当作从头开始，宁可重下也不能给出坏数据。 */
async function tryResume(s) {
  try {
    const raw = await fsp.readFile(s.partPath, 'utf8');
    const saved = JSON.parse(raw);
    if (
      saved.fileId !== s.manifest.fileId ||
      saved.chunkCount !== s.manifest.chunkCount ||
      saved.size !== s.manifest.size
    ) {
      return false;
    }
    const stat = await fsp.stat(s.filePath).catch(() => null);
    if (!stat || stat.size !== s.manifest.size) return false;

    s.have = unpackBitfield(saved.bits, s.manifest.chunkCount);
    s.haveCount = s.have.reduce((a, b) => a + b, 0);
    s._advanceContiguous();
    return true;
  } catch {
    return false;
  }
}

function safeName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 200) || 'video.mkv';
}

function get(sessionId) {
  const s = sessions.get(sessionId);
  if (!s || s.closed) throw new Error(`会话不存在：${sessionId}`);
  return s;
}

/** 读一片发给对端。 */
async function readChunk(sessionId, index) {
  const s = get(sessionId);
  if (index < 0 || index >= s.manifest.chunkCount) throw new Error(`分片下标越界：${index}`);
  if (s.have[index] !== 1) throw new Error(`本地没有分片 ${index}`);
  const len = chunkLengthAt(index, s.manifest.size);
  const buf = Buffer.allocUnsafe(len);
  const { bytesRead } = await s.fh.read(buf, 0, len, index * s.manifest.chunkSize);
  if (bytesRead !== len) throw new Error(`读取分片 ${index} 短读`);
  return buf;
}

/**
 * 写入收到的分片。先校验哈希再落盘 —— 这就是「渐进式校验」：
 * 每片独立验证，不用等整个文件下完，坏片当场丢弃重下。
 */
async function writeChunk(sessionId, index, data) {
  const s = get(sessionId);
  if (index < 0 || index >= s.manifest.chunkCount) throw new Error(`分片下标越界：${index}`);

  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const expectedLen = chunkLengthAt(index, s.manifest.size);
  if (buf.length !== expectedLen) {
    return { ok: false, reason: 'length', expected: expectedLen, actual: buf.length };
  }

  const digest = crypto.createHash('sha256').update(buf).digest('hex');
  if (digest !== s.manifest.hashes[index]) {
    return { ok: false, reason: 'hash' };
  }

  if (s.have[index] === 1) {
    return { ok: true, duplicate: true, contiguousBytes: s.contiguousBytes, haveCount: s.haveCount };
  }

  await s.fh.write(buf, 0, buf.length, index * s.manifest.chunkSize);
  s.have[index] = 1;
  s.haveCount++;
  s._advanceContiguous();
  s._scheduleFlush();

  if (s.complete) {
    await s._flushNow().catch(() => {});
    await fsp.unlink(s.partPath).catch(() => {}); // 下完了就不需要边车了
  }

  return {
    ok: true,
    contiguousBytes: s.contiguousBytes,
    haveCount: s.haveCount,
    complete: s.complete,
  };
}

function state(sessionId) {
  return get(sessionId).state();
}

async function close(sessionId) {
  const s = sessions.get(sessionId);
  if (!s || s.closed) return;

  // 顺序要紧：_flushNow 会拒绝为已关闭的会话写盘（挡住防抖定时器的迟到回调），
  // 所以最后这次位图落盘必须赶在标记 closed 之前，否则断点续传永远拿不到进度。
  if (s._flushTimer) clearTimeout(s._flushTimer);
  if (s.mode === 'leech' && !s.complete) await s._flushNow().catch(() => {});

  s.closed = true;
  if (s.fh) await s.fh.close().catch(() => {});
  sessions.delete(sessionId);
}

async function closeAll() {
  await Promise.all([...sessions.keys()].map(close));
}

module.exports = {
  CHUNK_SIZE,
  MAX_FILE_SIZE,
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
};
