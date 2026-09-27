'use strict';

/**
 * 边下边播：把看的片另存一份到下载文件夹。
 *
 * 和缓存是两回事 —— 存下来的是用户自己的文件，缓存清理不碰，登记表里也不记。
 *  - 同一个盘上用硬链接：不多占空间，缓存那份被清掉也不影响这份；硬链接本身是原子的，
 *    目标名已经有了就失败，不会覆盖。
 *  - 跨盘（EXDEV）、文件系统不支持硬链接时才复制。复制先写进下载文件夹下的工作目录
 *    （.noxreel-downloading/<号>/，启动时回收残留），复制完再挪成正式片名：进程被强杀、断电、
 *    关机时打断，下载文件夹里不会留下一个名字正常、后半截全是零的坏文件。
 *    复制前先查下载位置的余量；复制能取消，退出软件时取消并删掉半截文件（见 cancelAll）。
 *  - 绝不覆盖下载文件夹里已有的文件：同名就另起「片名 (2).mkv」。
 *  - 这次运行里存过的（按 key：P2P 是 fileId，在线视频是链接）不再存第二份；
 *    用户把存下来的那份删了、挪走了，才重新存。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { uniquePath, moveNoOverwrite, removeWorkDir, WORK_DIR } = require('./linkCache');

// 复制时一次读写这么多：几十 GB 跨盘复制，块太小全耗在系统调用上
const COPY_CHUNK = 4 * 1024 * 1024;

/**
 * 复制一个文件，能中途取消（signal）。目标已存在就失败，绝不覆盖。
 * 不用 fs.copyFile：它在线程池里一口气做完，取消不了 —— 退出软件时进程要在后台等它复制完才退。
 */
async function copyFileCancelable(source, target, { signal } = {}) {
  await pipeline(
    fs.createReadStream(source, { highWaterMark: COPY_CHUNK }),
    fs.createWriteStream(target, { flags: 'wx', highWaterMark: COPY_CHUNK }),
    { signal }
  );
}

/** 下载位置放不放得下：留 1% 或 256MB 的余量（取大），别把系统盘刚好塞满。查不到就不拦。 */
async function ensureRoom(dir, bytes, statfs) {
  let stats;
  try {
    stats = await statfs(dir);
  } catch {
    return;
  }
  const free = Number(stats.bavail) * Number(stats.bsize);
  const spare = Math.max(256 * 1024 * 1024, Math.round(bytes * 0.01));
  if (!Number.isFinite(free) || free >= bytes + spare) return;
  const gb = (n) => (n / 1024 ** 3).toFixed(2);
  throw new Error(`下载位置的磁盘空间不够：需要 ${gb(bytes)}GB，只剩 ${gb(Math.max(0, free))}GB`);
}

class DownloadSaver {
  /**
   * @param {object} deps
   * @param {() => string} deps.dir  当前的下载位置（设置里随时能换）
   * @param {Function} [deps.link]  测试注入：fs.promises.link
   * @param {Function} [deps.copy]  测试注入：(source, target, {signal}) => Promise
   * @param {Function} [deps.statfs]  测试注入：fs.promises.statfs
   */
  constructor({ dir, link = fsp.link, copy = copyFileCancelable, statfs = fsp.statfs }) {
    this.dir = dir;
    this.link = link;
    this.copy = copy;
    this.statfs = statfs;
    this.saved = new Map(); // key -> 下载文件夹里的路径
    this.copying = new Map(); // 工作目录号 -> { controller, settled }
  }

  /** 这次运行里存过、而且那份还在的，返回它的路径。 */
  async existing(key) {
    const saved = this.saved.get(key);
    if (!saved) return null;
    try {
      await fsp.access(saved);
      return saved;
    } catch {
      this.saved.delete(key);
      return null;
    }
  }

  /** 别处下好的（在线视频的后台下载）记一笔，之后同一个链接不再另下。 */
  remember(key, filePath) {
    if (key && filePath) this.saved.set(key, filePath);
  }

  /**
   * 事后扫出威胁（可信房间里没扫完就存了，后来点「重新扫描」扫出了东西）：这一份也删掉。
   * 只删这次运行里我们自己放进去的那个路径。
   */
  async discard(key) {
    const saved = this.saved.get(key);
    if (!saved) return false;
    this.saved.delete(key);
    await fsp.rm(saved, { force: true });
    return true;
  }

  /**
   * 放一份 source 到下载文件夹。
   * @returns {Promise<{path: string, fresh: boolean}>} fresh=false 表示早就存过了
   */
  async save(key, source, name = path.basename(source)) {
    const existing = await this.existing(key);
    if (existing) return { path: existing, fresh: false };
    const dir = this.dir();
    await fsp.mkdir(dir, { recursive: true });
    const base = path.basename(name);
    let target;
    try {
      // 硬链接到正式名：原子的，目标已经有了就 EEXIST（这时走下面的复制，另挑名字）
      target = await uniquePath(dir, base);
      await this.link(source, target);
    } catch {
      target = await this._copy(source, dir, base);
    }
    this.saved.set(key, target);
    return { path: target, fresh: true };
  }

  /** 复制到工作目录，复制完挪成正式片名（不覆盖）。失败、取消都连工作目录删掉。 */
  async _copy(source, dir, name) {
    const { size } = await fsp.stat(source);
    await ensureRoom(dir, size, this.statfs);
    const id = crypto.randomBytes(6).toString('hex');
    const work = path.join(dir, WORK_DIR, id);
    const controller = new AbortController();
    const job = { controller, settled: null };
    this.copying.set(id, job);
    const run = (async () => {
      try {
        await fsp.mkdir(work, { recursive: true });
        const partial = path.join(work, name);
        await this.copy(source, partial, { signal: controller.signal });
        if (controller.signal.aborted) throw new Error('已取消');
        return await moveNoOverwrite(partial, dir, name);
      } finally {
        // 外层的 .noxreel-downloading 空了一起删，别在下载文件夹里留一个空目录
        await removeWorkDir(work);
        this.copying.delete(id);
      }
    })();
    job.settled = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  /** 有没有正在复制的另存。 */
  get busy() {
    return this.copying.size > 0;
  }

  /** 退出软件时：正在复制的一律取消，等半截文件连工作目录删干净。 */
  async cancelAll() {
    const jobs = [...this.copying.values()];
    for (const job of jobs) job.controller.abort();
    await Promise.all(jobs.map((job) => job.settled));
  }
}

module.exports = { DownloadSaver, copyFileCancelable };
