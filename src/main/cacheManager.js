'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const RUN_DIR_RE = /^run-(\d+)-[a-z0-9]+-[a-f0-9]+$/i;
// 退出来不及删干净的目录先改名成这个，下次启动无条件回收。改名对几十 GB 也是瞬间完成。
const TRASH_DIR_RE = /^trash-[a-f0-9]+$/i;
const RETRY_DELAYS_MS = [0, 100, 300, 1000];
const RUN_MARKER = 'run.json';
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
    await fsp
      .writeFile(
        path.join(this.runDir, RUN_MARKER),
        JSON.stringify({ host: this.hostname(), pid: this.pid, startedAt: this.now() }),
        'utf8'
      )
      .catch(() => {});
    this.initialized = true;
    return this.runDir;
  }

  /** 这个 run 目录能不能回收。分不清就返回 false —— 误删正在接收的片子代价太大。 */
  async _isStale(dir, ownerPid) {
    let marker = null;
    try {
      marker = JSON.parse(await fsp.readFile(path.join(dir, RUN_MARKER), 'utf8'));
    } catch {
      // 没有标记：要么是老版本留下的，要么建到一半就挂了。按同机处理，也就是原来的行为。
    }
    if (marker && marker.host && marker.host !== this.hostname()) {
      // 别的机器建的。PID 在这儿说明不了任何事，只能看年龄。
      const age = this.now() - (Number(marker.startedAt) || 0);
      return age > FOREIGN_RUN_MAX_AGE_MS;
    }
    // 与当前 PID 相同但不是当前运行目录，只可能是 PID 被系统复用后的旧残留。
    return ownerPid === this.pid || !this.isAlive(ownerPid);
  }

  async cleanupStaleRuns() {
    for (const root of [this.rootDir, ...this.extraRoots]) {
      const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
      await Promise.all(
        entries.map(async (entry) => {
          if (!entry.isDirectory()) return;
          const candidate = path.join(root, entry.name);
          if (candidate === this.runDir) return;
          // 上次退出来不及删完的，已经明确标成垃圾了，无条件收掉
          if (TRASH_DIR_RE.test(entry.name)) {
            await removeWithRetry(candidate);
            return;
          }
          const match = RUN_DIR_RE.exec(entry.name);
          if (!match) return;
          if (await this._isStale(candidate, Number(match[1]))) await removeWithRetry(candidate);
        })
      );
    }
  }

  /**
   * 缓存占了多少。设置页要显示，用户才知道该不该清。
   * 只统计本软件自己的目录，别的东西一个字节都不数 —— 缓存根可能是用户指定的目录。
   */
  async usage() {
    const out = { root: this.rootDir, runBytes: 0, staleBytes: 0, staleRuns: 0 };
    for (const root of [this.rootDir, ...this.extraRoots]) {
      const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(root, entry.name);
        const mine = dir === this.runDir;
        const runMatch = RUN_DIR_RE.exec(entry.name);
        if (!mine && !runMatch && !TRASH_DIR_RE.test(entry.name)) continue;
        // 别的实例（或别的机器）正在用的 run 目录既清不掉、也不该算成「残留」：
        // 界面会把它说成「上次退出没清掉」，诱着用户去点那个会删掉人家片子的按钮。
        if (!mine && runMatch && !(await this._isStale(dir, Number(runMatch[1])))) continue;
        const bytes = await dirBytes(dir);
        if (mine) out.runBytes += bytes;
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
   * 判据跟启动时的自动回收共用 _isStale：trash- 是明确标好的垃圾，无条件收；
   * run- 目录要先确认可回收。缓存根放在网盘上、或者开发期两个实例共用 %TEMP%\NoxReel 时，
   * 别人正在接收的片子也顶着 run- 的名字 —— 界面上那个「清理残留」按钮一点，
   * Windows 上照样删得掉（文件是带 FILE_SHARE_DELETE 打开的），人家这一场就没了。
   */
  async purgeStale() {
    let removed = 0;
    for (const root of [this.rootDir, ...this.extraRoots]) {
      const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(root, entry.name);
        if (dir === this.runDir) continue;
        const runMatch = RUN_DIR_RE.exec(entry.name);
        if (!runMatch && !TRASH_DIR_RE.test(entry.name)) continue;
        if (runMatch && !(await this._isStale(dir, Number(runMatch[1])))) continue;
        if (await removeWithRetry(dir)) removed++;
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
   * 改完之后这堆字节就顶着 trash- 的名字，下次启动 cleanupStaleRuns 无条件回收 ——
   * 不看 PID、不看主机。于是超时残留下来的是一个明明白白标成垃圾的目录，
   * 而不是一份看起来还在用、要靠 PID 判活才敢动的缓存。
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

/** 递归统计目录占用。缓存里其实只有个位数文件，不用担心遍历成本。 */
async function dirBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        // 稀疏文件要按真正占用的块数算，不然一个预分配好的 50GB 空文件
        // 会让「缓存占用」从第一秒起就显示 50GB，而磁盘其实没少多少。
        const st = await fsp.stat(full).catch(() => null);
        if (st) total += typeof st.blocks === 'number' && st.blocks >= 0 ? st.blocks * 512 : st.size;
      }
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
