'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// 缓存根可以是用户选的任意目录（D:\、D:\Downloads），名字对得上只是第一关 —— 名字谁都能起。
// 真正决定「这是不是我们建的」的是 run.json 标记或目录布局，见 CacheManager._classify()。
const RUN_DIR_RE = /^run-(\d+)-[a-z0-9]+-[a-f0-9]+$/;
// 退出来不及删干净的目录先改名成这个，下次启动回收。改名对几十 GB 也是瞬间完成。
// 只认 cleanupRun 起的名字：randomBytes(6)，恰好 12 位小写十六进制。trash-2024、Trash-1 这类不算。
const TRASH_DIR_RE = /^trash-[a-f0-9]{12}$/;
// createOwnedDir 建的子目录：<种类>-<36 进制序号>-<10 位十六进制>
const OWNED_DIR_RE = /^[a-z0-9_-]{1,32}-[a-z0-9]+-[a-f0-9]{10}$/i;
const RETRY_DELAYS_MS = [0, 100, 300, 1000];
const RUN_MARKER = 'run.json';
const MARKER_APP = 'noxreel';
// 我们写的 run.json 不到 200 字节，读到比这大的就不是我们的
const MAX_MARKER_BYTES = 4096;
// 没有标记的旧目录最多看这么多项。我们的 run 目录里只有寥寥几个子目录，多到这个数就不是我们的
const MAX_LAYOUT_ENTRIES = 256;
// 统计占用时最多数这么多项，免得有人往缓存目录里塞了海量小文件时一次统计没完没了
const MAX_SCAN_ENTRIES = 100_000;
// 别的机器留下的目录只能按年龄回收 —— PID 在另一台机器上毫无意义
const FOREIGN_RUN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function removeWithRetry(target, delays = RETRY_DELAYS_MS) {
  let lastError = null;
  for (const waitMs of delays) {
    if (waitMs) await delay(waitMs);
    try {
      await fsp.rm(target, { recursive: true, force: true, maxRetries: 0 });
      return true;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError?.code !== 'ENOENT') return false;
  return true;
}

/** run.json 是不是本软件写的：新版带 app 字段；0.7.0–0.7.4 写的恰好只有 host、pid、startedAt 三项。 */
function markerIsOurs(marker) {
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return false;
  if (marker.app === MARKER_APP) return true;
  const keys = Object.keys(marker).sort().join(',');
  return (
    keys === 'host,pid,startedAt' &&
    typeof marker.host === 'string' &&
    Number.isInteger(marker.pid) &&
    Number.isFinite(marker.startedAt)
  );
}

/**
 * 读目录里的 run.json。没有这个文件返回 null；有但不是我们写的（读不出、太大、格式不对）返回 false。
 * 后一种绝不能当成「没有标记」处理 —— 那是用户自己的 run.json，这个目录就不是我们的。
 */
async function readMarker(dir) {
  let fh;
  try {
    fh = await fsp.open(path.join(dir, RUN_MARKER), 'r');
  } catch (error) {
    return error?.code === 'ENOENT' ? null : false;
  }
  try {
    const buf = Buffer.alloc(MAX_MARKER_BYTES + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead > MAX_MARKER_BYTES) return false;
    const marker = JSON.parse(buf.subarray(0, bytesRead).toString('utf8'));
    return markerIsOurs(marker) ? marker : false;
  } catch {
    return false;
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * 没有 run.json 时按布局认：0.7 以前的版本不写标记，删到一半的目录标记也可能已经没了。
 * 里面只能有 createOwnedDir 建的那种子目录（空目录也算）；有一项对不上就是用户的东西。
 */
async function layoutLooksOwned(dir) {
  let count = 0;
  try {
    for await (const entry of await fsp.opendir(dir)) {
      if (++count > MAX_LAYOUT_ENTRIES) return false;
      if (!entry.isDirectory() || !OWNED_DIR_RE.test(entry.name)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 根目录下名字像我们的目录。用 opendir 分批读：根目录可能是用户选的 D:\ 这种大目录，
 * 不必把几十万项一次性读进内存，只留名字对得上的。
 */
async function candidateNames(root) {
  const names = [];
  try {
    for await (const entry of await fsp.opendir(root)) {
      if (!entry.isDirectory()) continue;
      if (TRASH_DIR_RE.test(entry.name) || RUN_DIR_RE.test(entry.name)) names.push(entry.name);
    }
  } catch {
    // 根目录不在（没插的移动硬盘）或读到一半出错：能认出多少算多少
  }
  return names;
}

class CacheManager {
  constructor({
    rootDir,
    pid = process.pid,
    now = Date.now,
    isAlive = processIsAlive,
    hostname = os.hostname,
    extraRoots = [],
  } = {}) {
    if (!rootDir || !path.isAbsolute(rootDir)) throw new TypeError('缓存根目录必须是绝对路径');
    this.rootDir = path.resolve(rootDir);
    this.pid = pid;
    this.now = now;
    this.isAlive = isAlive;
    this.hostname = hostname;
    // 换过缓存目录之后旧盘上可能还有残留。不扫它们，那几十 GB 就再也没人回收了。
    this.extraRoots = extraRoots
      .map((r) => String(r || '').trim())
      .filter((r) => r && path.isAbsolute(r))
      .map((r) => path.resolve(r))
      .filter((r) => r !== this.rootDir);
    const stamp = now().toString(36);
    const token = crypto.randomBytes(6).toString('hex');
    this.runDir = path.join(this.rootDir, `run-${pid}-${stamp}-${token}`);
    this.initialized = false;
    this.sequence = 0;
  }

  async initialize() {
    if (this.initialized) return this.runDir;
    await fsp.mkdir(this.rootDir, { recursive: true });
    await this.cleanupStaleRuns();
    await fsp.mkdir(this.runDir, { recursive: true });
    // 标记这个目录是谁建的。缓存放在网盘上时，光看 PID 会把别的机器正在用的
    // 目录判成死进程直接删掉 —— 那可是人家正在接收的片子。
    // app 字段是「这是本软件的目录」的凭据：缓存根可以是用户的任意目录，回收前必须核对它。
    await fsp
      .writeFile(
        path.join(this.runDir, RUN_MARKER),
        JSON.stringify({ app: MARKER_APP, host: this.hostname(), pid: this.pid, startedAt: this.now() }),
        'utf8'
      )
      .catch(() => {});
    this.initialized = true;
    return this.runDir;
  }

  /** 这个 run 目录能不能回收。分不清就返回 false —— 误删正在接收的片子代价太大。 */
  _isStale(marker, ownerPid) {
    if (marker && marker.host && marker.host !== this.hostname()) {
      // 别的机器建的。PID 在这儿说明不了任何事，只能看年龄。
      const age = this.now() - (Number(marker.startedAt) || 0);
      return age > FOREIGN_RUN_MAX_AGE_MS;
    }
    // 没有标记的是老版本留下的，按同机处理，也就是原来的行为。
    // 与当前 PID 相同但不是当前运行目录，只可能是 PID 被系统复用后的旧残留。
    return ownerPid === this.pid || !this.isAlive(ownerPid);
  }

  /**
   * 根目录下的一项归哪类：'mine'（本次运行的目录）、'stale'（可以回收的残留），
   * 其余一律 null —— 不是我们建的，或者还有人在用。
   *
   * 名字对得上之后还要证明是我们建的：有 run.json 就得是我们写的格式，没有就看布局。
   * 以前 trash- 只凭名字就无条件递归删除，用户把缓存目录选成 D:\，
   * 里面恰好有个 trash-2024 文件夹，就连同内容一起没了，还不进回收站。
   */
  async _classify(root, name) {
    const dir = path.join(root, name);
    if (dir === this.runDir) return 'mine';
    const isTrash = TRASH_DIR_RE.test(name);
    const runMatch = isTrash ? null : RUN_DIR_RE.exec(name);
    if (!isTrash && !runMatch) return null;
    const marker = await readMarker(dir);
    if (marker === false) return null;
    if (marker === null && !(await layoutLooksOwned(dir))) return null;
    // 改名成 trash- 的是已经退出的实例亲手标好的垃圾，不看 PID 也不看主机
    if (isTrash) return 'stale';
    return this._isStale(marker, Number(runMatch[1])) ? 'stale' : null;
  }

  async cleanupStaleRuns() {
    for (const root of [this.rootDir, ...this.extraRoots]) {
      const names = await candidateNames(root);
      await Promise.all(
        names.map(async (name) => {
          if ((await this._classify(root, name)) === 'stale') await removeWithRetry(path.join(root, name));
        })
      );
    }
  }

  /**
   * 缓存占了多少。设置页要显示，用户才知道该不该清。
   * 只统计本软件自己的目录，别的东西一个字节都不数 —— 缓存根可能是用户指定的目录。
   * 别的实例（或别的机器）正在用的 run 目录既清不掉、也不该算成「残留」：
   * 界面会把它说成「上次退出没清掉」，诱着用户去点那个会删掉人家片子的按钮。
   */
  async usage() {
    const out = { root: this.rootDir, runBytes: 0, staleBytes: 0, staleRuns: 0 };
    for (const root of [this.rootDir, ...this.extraRoots]) {
      for (const name of await candidateNames(root)) {
        const kind = await this._classify(root, name);
        if (!kind) continue;
        const bytes = await dirBytes(path.join(root, name));
        if (kind === 'mine') out.runBytes += bytes;
        else {
          out.staleBytes += bytes;
          out.staleRuns++;
        }
      }
    }
    return out;
  }

  /**
   * 清掉能回收的残留目录。当前会话的文件一个都不动。
   *
   * 判据跟启动时的自动回收共用 _classify：trash- 是明确标好的垃圾，确认是我们的就收；
   * run- 目录还要先确认可回收。缓存根放在网盘上、或者开发期两个实例共用 %TEMP%\NoxReel 时，
   * 别人正在接收的片子也顶着 run- 的名字 —— 界面上那个「清理残留」按钮一点，
   * Windows 上照样删得掉（文件是带 FILE_SHARE_DELETE 打开的），人家这一场就没了。
   */
  async purgeStale() {
    let removed = 0;
    for (const root of [this.rootDir, ...this.extraRoots]) {
      for (const name of await candidateNames(root)) {
        if ((await this._classify(root, name)) !== 'stale') continue;
        if (await removeWithRetry(path.join(root, name))) removed++;
      }
    }
    return removed;
  }

  async createOwnedDir(kind = 'media') {
    await this.initialize();
    const safeKind = String(kind).replace(/[^a-z0-9_-]/gi, '-').slice(0, 32) || 'media';
    const token = crypto.randomBytes(5).toString('hex');
    const dir = path.join(this.runDir, `${safeKind}-${(this.sequence++).toString(36)}-${token}`);
    await fsp.mkdir(dir, { recursive: true });
    return dir;
  }

  owns(target) {
    return Boolean(target && isInside(this.runDir, target));
  }

  async removeOwned(target) {
    if (!this.owns(target)) throw new Error('拒绝删除缓存根目录之外的路径');
    return removeWithRetry(target);
  }

  /**
   * 退出时收尾。
   *
   * 先改名再删，而不是直接删：退出清理只有几秒预算（main.js 里是 Promise.race
   * 加一个固定超时），几十 GB 根本删不完。改名对多大的目录都是瞬间完成的，
   * 改完之后这堆字节就顶着 trash- 的名字，run.json 标记跟着一起过去，下次启动
   * cleanupStaleRuns 核对过标记就回收 —— 不看 PID、不看主机。于是超时残留下来的是一个
   * 明明白白标成垃圾的目录，而不是一份看起来还在用、要靠 PID 判活才敢动的缓存。
   *
   * 注意 owns() 不受影响：它是纯路径字符串比较，不看磁盘。这里不需要它变 ——
   * 走到这一步进程本来就要退出了。
   */
  async cleanupRun() {
    if (!this.initialized) return true;
    const trash = path.join(this.rootDir, `trash-${crypto.randomBytes(6).toString('hex')}`);
    let target = this.runDir;
    try {
      await fsp.rename(this.runDir, trash);
      target = trash;
      this.initialized = false;
    } catch {
      // Windows 上还有句柄没放开就会改名失败。退回原来的直接删。
    }
    const removed = await removeWithRetry(target);
    if (removed) this.initialized = false;
    return removed;
  }
}

/**
 * 递归统计目录占用。只用在已确认是我们的目录上，正常只有个位数文件。
 * 最多数 maxEntries 项：有人往里塞了海量小文件时宁可少算，也不让一次统计没完没了。
 */
async function dirBytes(dir, { maxEntries = MAX_SCAN_ENTRIES } = {}) {
  let total = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    try {
      for await (const entry of await fsp.opendir(current)) {
        if (++seen > maxEntries) return total;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        // 接收文件是稀疏文件（NTFS 上见 fileStore.markSparse），要按真正占用的块数算，
        // 不然一个刚开始接收的 50GB 文件会让「缓存占用」从第一秒起就显示 50GB，而磁盘其实没少多少。
        const st = await fsp.stat(full).catch(() => null);
        if (st) total += typeof st.blocks === 'number' && st.blocks >= 0 ? st.blocks * 512 : st.size;
      }
    } catch {
      // 读不了的子目录跳过，能数多少数多少
    }
  }
  return total;
}

async function cleanupLegacySidecars(legacyDir) {
  if (!legacyDir || !path.isAbsolute(legacyDir)) return;
  const stack = [legacyDir];
  while (stack.length) {
    const dir = stack.pop();
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.swpart')) await fsp.unlink(entryPath).catch(() => {});
    }
  }
}

module.exports = {
  CacheManager,
  cleanupLegacySidecars,
  isInside,
  dirBytes,
  processIsAlive,
  removeWithRetry,
  RUN_DIR_RE,
  TRASH_DIR_RE,
};
