'use strict';

/**
 * 用 yt-dlp 把在线视频下到本机。两种用途，同一套下载：
 *  - cache（手动缓存）：播放列表里点「开始手动缓存」。下进缓存，跟着缓存清理方式走
 *    （自动模式放本次运行的临时缓存、关软件时清；手动模式放长期缓存文件夹），
 *    之后同一个链接直接从本地播。
 *  - download（边下边播）：设置里打开「边下边播」后，看的在线视频在后台另下一份到下载文件夹。
 *    那是用户自己的文件，缓存清理不碰。
 * 下到哪儿、下完怎么登记由调用方给的 placement 决定，这里只管下载本身：
 *
 *  - 可以同时下好几部：最多 maxParallel 个一起下，其余排队。
 *  - 每个网络请求都经本机过滤代理（和解析、播放同一道关），私网地址一律连不上。
 *  - 优先选音画合一的格式：不用 ffmpeg 合并，没装 ffmpeg 也能下。
 *  - 直接下网页地址失败（yt-dlp 认不出的网站），就先解析（含隔离浏览器兜底）拿到媒体地址，
 *    带着它要求的请求头再下一次。
 *  - 下在 placement 给的工作目录里，下完才由 finish 挪到位、登记；取消、失败由 abort 收拾，
 *    不会留下半截文件。yt-dlp 报回来的路径必须在工作目录里。
 *  - 取消要结束 yt-dlp 整棵进程树（processTree.js）：yt-dlp.exe 是两层进程，只杀引导进程的话
 *    干活的子进程接着下，还攥着管道和半截文件，工作目录删不掉、名额也不还。
 */

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { killTree } = require('./processTree');
const { MUXED_FORMAT, PARSE_FORMAT } = require('./linkMedia');

const MAX_PARALLEL = 3;
// 长期缓存文件夹、下载文件夹里放半截文件的子目录名（启动时按这个名字清残留）
const WORK_DIR = '.noxreel-downloading';
// 和解析（linkMedia.inspectLink）同一个格式串：优先音画合一，最后那个 /b 不能省（直链 mp4 报不出编码）
const FORMAT = MUXED_FORMAT;
// 本机有 ffmpeg 时，没有音画合一格式的网站（B 站全站、YouTube 的高画质）退到分开的两条流、下完由 yt-dlp
// 调 ffmpeg 合成一个文件（和解析用的是同一串）。合成的容器只要 MP4 / MKV：别的扩展名（webm……）从本地播时不会被核准
const MERGE_FORMAT = PARSE_FORMAT;
const MERGE_CONTAINERS = 'mp4/mkv';
const FORMAT_UNAVAILABLE_RE = /Requested format is not available/i;
const NEEDS_FFMPEG_MESSAGE = '这个网站的音频和视频是分开的两条流，下载后要用 ffmpeg 合成一个文件；装上 ffmpeg 后再试';
// 取消后等 yt-dlp 整棵进程树退出、管道关上最多等这么久；再等不到就不等了，名额先还回去
const CANCEL_GRACE_MS = 10_000;
const PURPOSES = ['cache', 'download'];
const PROGRESS_TAG = 'NRPROG';
const FILE_TAG = 'NRFILE';
const YOUTUBE_HOST_RE = /(^|\.)(?:youtube\.com|youtube-nocookie\.com|youtu\.be)$/i;
// 进度最多每这么久报一次：yt-dlp 每秒能吐几十行进度，全转给界面没有意义
const PROGRESS_EVERY_MS = 500;
// 记着的任务（含下完、失败的）上限：再多就把最早结束的忘掉
const MAX_JOBS = 200;

/** 文件名里不能有的字符换掉，再截短。 */
function safeTitle(title) {
  const cleaned = String(title || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || 'video';
}

/** 不重名的文件名：「片名.mp4」已经有了就用「片名 (2).mp4」。 */
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
 * 把工作目录里做好的文件挪到 dir 下，用不重名的名字，绝不覆盖已有文件。
 * 先硬链接到目标名（目标已存在就 EEXIST，挑下一个名字），成了再删掉原来那个 ——
 * 不能直接 rename：挑好名字和改名之间有人抢先建了同名文件，rename 会把它覆盖掉。
 * 文件系统不支持硬链接（FAT32/exFAT）时才退回 rename。
 * @returns {Promise<string>} 挪到的路径
 */
async function moveNoOverwrite(file, dir, name) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const target = await uniquePath(dir, name);
    try {
      await fsp.link(file, target);
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      await fsp.rename(file, target);
      return target;
    }
    await fsp.rm(file, { force: true }).catch(() => {});
    return target;
  }
  throw new Error('同名文件太多了');
}

/**
 * 删掉一个任务的工作目录（<dir>/.noxreel-downloading/<号>/），外层的 .noxreel-downloading 空了就一起删。
 * 不删的话每下完、复制完一次，下载文件夹和长期缓存文件夹里就留一个空的 .noxreel-downloading
 * （Windows 上不带点号隐藏），要等下次启动才清。外层用 rmdir：别的任务还在里面放着半截文件时删不掉，正好不动。
 */
async function removeWorkDir(work) {
  await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  const parent = path.dirname(work);
  if (path.basename(parent) === WORK_DIR) await fsp.rmdir(parent).catch(() => {});
}

/**
 * 在 dir 下开一个放半截文件的工作目录（placement 用）：finish 把下好的文件挪进 dir（不重名）再登记，
 * abort 删掉工作目录。两条收尾都经 removeWorkDir —— 只删 <号> 那一层的话，取消、退出之后
 * 下载文件夹和长期缓存文件夹里照样留一个空的 .noxreel-downloading。
 * 放在这里而不是主进程里，测试用的就是同一份，不会再跟主进程那份走岔。
 */
async function workDirIn(dir, id, onFinish = async () => {}) {
  const work = path.join(dir, WORK_DIR, id);
  await fsp.mkdir(work, { recursive: true });
  return {
    workDir: work,
    finish: async (file, meta) => {
      // 不覆盖：挑好名字和挪过去之间有人抢先建了同名文件，也另起名字
      const target = await moveNoOverwrite(file, dir, path.basename(file));
      await removeWorkDir(work);
      await onFinish(target, meta);
      return target;
    },
    abort: () => removeWorkDir(work),
  };
}

/** 路径是不是在 dir 里面（yt-dlp 报回来的文件路径不能跑到工作目录外面去）。 */
function inside(dir, target) {
  const rel = path.relative(dir, target);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const jobKey = (purpose, url) => `${purpose}\n${url}`;

/**
 * 下好的成品在哪儿。优先用 yt-dlp 报回来的路径；那个路径在工作目录里却找不到文件 ——
 * Windows 上 yt-dlp 往管道里打印时按控制台代码页编码，中文片名会被弄乱（实测「样片二」变成乱码）——
 * 就在工作目录里找唯一的成品。报回来的路径跑出了工作目录则一律不认，也不替它兜底。
 */
async function finalFile(workDir, reported) {
  if (reported) {
    const resolved = path.resolve(reported);
    if (!inside(workDir, resolved)) return null;
    try {
      if ((await fsp.stat(resolved)).isFile()) return resolved;
    } catch {
      /* 路径被编码弄乱了：下面按目录找 */
    }
  }
  const entries = await fsp.readdir(workDir, { withFileTypes: true }).catch(() => []);
  const done = entries.filter((e) => e.isFile() && !/\.(part|ytdl|tmp)$/i.test(e.name) && !/\.part-Frag\d+$/i.test(e.name));
  return done.length === 1 ? path.join(workDir, done[0].name) : null;
}

class LinkCache extends EventEmitter {
  /**
   * @param {object} deps
   * @param {() => string|null} deps.findYtDlp
   * @param {() => Promise<{url: string}>} deps.proxyInfo  本机过滤代理（起不来就抛，不许绕过去直连）
   * @param {(url: string) => Promise<object>} deps.resolve  解析网页（linkMedia.inspectLink + 隔离浏览器兜底）
   * @param {(job: object) => Promise<{workDir: string, finish: Function, abort: Function}>} deps.placement
   *   下到哪儿：workDir 是放半截文件的目录；finish(file, meta) 挪到位并登记，返回最终路径；abort() 收拾残局
   * @param {(url: string, purpose: string) => boolean} [deps.alreadyDone]  已经有了就不再下（手动缓存查登记表）
   * @param {() => object} [deps.childEnv]  子进程环境（去掉 no_proxy）
   * @param {() => string|null} [deps.findFfmpeg]  有它才下得了只给分开音视频流的网站（见 MERGE_FORMAT）
   */
  constructor({
    findYtDlp,
    proxyInfo,
    resolve,
    placement,
    alreadyDone = () => false,
    childEnv = () => process.env,
    findFfmpeg = () => null,
    spawnImpl = spawn,
    killTreeImpl = killTree,
    cancelGraceMs = CANCEL_GRACE_MS,
    maxParallel = MAX_PARALLEL,
    progressEveryMs = PROGRESS_EVERY_MS,
  }) {
    super();
    this.findYtDlp = findYtDlp;
    this.proxyInfo = proxyInfo;
    this.resolve = resolve;
    this.placement = placement;
    this.alreadyDone = alreadyDone;
    this.childEnv = childEnv;
    this.findFfmpeg = findFfmpeg;
    this.spawnImpl = spawnImpl;
    this.killTree = killTreeImpl;
    this.cancelGraceMs = cancelGraceMs;
    this.maxParallel = maxParallel;
    this.progressEveryMs = progressEveryMs;
    this.jobs = new Map(); // jobKey -> job
    this.running = 0;
  }

  /**
   * 上次没下完就退出留下的半截文件（只认我们自己那个子目录名）。启动时清一次。
   * keep：登记着的没收完的片（断点续传，见 mediaLibrary）所在的工作目录，留着下次接着收。
   */
  async cleanupLeftovers(dirs, { keep = [] } = {}) {
    const key = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
    const kept = new Set(keep.map(key));
    for (const dir of dirs) {
      if (!dir) continue;
      const root = path.join(dir, WORK_DIR);
      if (![...kept].some((k) => key(path.dirname(k)) === key(root))) {
        await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      const names = await fsp.readdir(root).catch(() => []);
      for (const name of names) {
        const child = path.join(root, name);
        if (!kept.has(key(child))) await fsp.rm(child, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  view(job) {
    return {
      url: job.url,
      purpose: job.purpose,
      title: job.title,
      state: job.state,
      downloaded: job.downloaded,
      total: job.total,
      path: job.finalPath || '',
      error: job.error || '',
    };
  }

  status() {
    return [...this.jobs.values()].map((job) => this.view(job));
  }

  /**
   * 有没有这种用途、正在下、工作目录满足 inDir 的任务。在下却还没定下工作目录的（placement 正在建）也算 ——
   * 马上就要建在当前的位置上。排队的不算：轮到时才 placement，那时用的是换过之后的位置。
   */
  hasActive(purpose, inDir = () => true) {
    for (const job of this.jobs.values()) {
      if (job.purpose !== purpose || job.state !== 'downloading') continue;
      if (!job.workDir || inDir(job.workDir)) return true;
    }
    return false;
  }

  _emit(job) {
    this.emit('update', this.view(job));
  }

  /** 开始一个下载。同一个链接同一种用途在下 / 在排队的直接返回它；已经有了的不再下。 */
  /** maxHeight：清晰度上限（按短边，0 = 不限），见 _args 里的 -S res:N。 */
  start({ url, title = '', purpose = 'cache', maxHeight = 0 }) {
    if (!PURPOSES.includes(purpose)) throw new TypeError('无效的下载用途');
    const key = jobKey(purpose, url);
    const current = this.jobs.get(key);
    if (current && (current.state === 'queued' || current.state === 'downloading')) return this.view(current);
    if (this.alreadyDone(url, purpose)) {
      return this.view({ url, purpose, title, state: 'done', downloaded: 0, total: 0, error: '' });
    }
    const job = {
      id: crypto.randomBytes(6).toString('hex'),
      url,
      purpose,
      title: String(title || '').slice(0, 300),
      maxHeight: Number.isSafeInteger(maxHeight) && maxHeight > 0 ? maxHeight : 0,
      state: 'queued',
      downloaded: 0,
      total: 0,
      error: '',
      finalPath: '',
      stop: null, // yt-dlp 在跑时由 _download 挂上：结束它（取消用）
      settled: null, // 开始下之后：整个任务收完尾（含 abort）才 resolve
      lastEmit: 0,
    };
    this.jobs.delete(key);
    this.jobs.set(key, job);
    this._trim();
    this._emit(job);
    this._pump();
    return this.view(job);
  }

  /**
   * 取消（在下的结束 yt-dlp 整棵进程树，半截文件随后删掉；在排队的直接出队）。
   * 还在建工作目录、解析网页的，轮到起 yt-dlp 时看到已取消就不起了。
   */
  cancel(url, purpose = 'cache') {
    const job = this.jobs.get(jobKey(purpose, url));
    if (!job || (job.state !== 'queued' && job.state !== 'downloading')) return false;
    const wasQueued = job.state === 'queued';
    job.state = 'canceled';
    job.stop?.();
    if (wasQueued) this._emit(job);
    return true;
  }

  /** 全部取消。返回的 Promise 等在下的那几个收完尾（yt-dlp 退干净、工作目录删掉）；从不 reject。 */
  cancelAll() {
    const settling = [];
    for (const job of this.jobs.values()) {
      if (this.cancel(job.url, job.purpose) && job.settled) settling.push(job.settled);
    }
    return Promise.all(settling).then(() => {});
  }

  _trim() {
    if (this.jobs.size <= MAX_JOBS) return;
    for (const [key, job] of this.jobs) {
      if (this.jobs.size <= MAX_JOBS) break;
      if (job.state !== 'queued' && job.state !== 'downloading') this.jobs.delete(key);
    }
  }

  _pump() {
    while (this.running < this.maxParallel) {
      const next = [...this.jobs.values()].find((job) => job.state === 'queued');
      if (!next) return;
      this.running++;
      next.state = 'downloading';
      this._emit(next);
      next.settled = this._run(next)
        .then(() => {
          next.state = 'done';
        })
        .catch((error) => {
          if (next.state !== 'canceled') {
            next.state = 'failed';
            next.error = String(error?.message || error).slice(0, 500);
          }
        })
        .finally(() => {
          this.running--;
          this._emit(next);
          this._pump();
        });
    }
  }

  async _run(job) {
    const ytDlp = this.findYtDlp();
    if (!ytDlp) throw new Error('没找到 yt-dlp，下载不了网页视频');
    job.ffmpeg = this.findFfmpeg() || null;
    const proxy = await this.proxyInfo();
    const place = await this.placement(job);
    job.workDir = place.workDir;
    let finished = false;
    try {
      let file;
      try {
        file = await this._download(ytDlp, job, job.url, [], proxy);
      } catch (first) {
        if (job.state === 'canceled') throw first;
        // 网页直接下不了（yt-dlp 认不出的网站）：先解析拿到媒体地址，再带着请求头下一次
        const info = await this.resolve(job.url).catch(() => null);
        if (job.state === 'canceled' || !info?.playback?.url) throw first;
        if (!job.title && info.title) job.title = String(info.title).slice(0, 300);
        const headers = Object.entries(info.playback.headers || {}).flatMap(([k, v]) => ['--add-header', `${k}:${v}`]);
        file = await this._download(ytDlp, job, info.playback.url, headers, proxy);
      }
      if (job.state === 'canceled') throw new Error('已取消');
      const stat = await fsp.stat(file);
      job.downloaded = stat.size;
      job.total = stat.size;
      job.finalPath = await place.finish(file, { url: job.url, title: job.title, size: stat.size });
      finished = true;
    } finally {
      if (!finished) await Promise.resolve(place.abort()).catch(() => {});
    }
  }

  _args(job, url, extra, proxy) {
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      /* 解析不了的地址 yt-dlp 自己会报错 */
    }
    // 标题已知就用它当文件名（直链兜底时 yt-dlp 拿到的「标题」往往只是个 video）；模板里的 % 要写成 %%
    const name = job.title ? `${safeTitle(job.title).replace(/%/g, '%%')}.%(ext)s` : '%(title).120B.%(ext)s';
    return [
      '--ignore-config',
      '--no-playlist',
      '--no-cache-dir',
      '--no-warnings',
      '--newline',
      // 打印出来的路径按 UTF-8 编码（不写的话 Windows 上按控制台代码页，中文片名会乱）
      '--encoding',
      'utf-8',
      '--no-mtime',
      '--socket-timeout',
      '20',
      // 本机过滤代理：每个请求、每一跳跳转都在连接那一刻按解析出的 IP 判定，私网一律拒绝
      '--proxy',
      proxy.url,
      // 有 ffmpeg 才允许退到分开的两条流（见 MERGE_FORMAT）；合并只在本机做，不联网
      ...(job.ffmpeg
        ? ['--format', MERGE_FORMAT, '--ffmpeg-location', job.ffmpeg, '--merge-output-format', MERGE_CONTAINERS]
        : ['--format', FORMAT]),
      // 清晰度上限：不超过 N 的最高一档，一档都没有才用最低的（和播放器那一路同一个写法，见 mpv.js 的 qualityArgs）
      ...(job.maxHeight ? ['--format-sort', `res:${job.maxHeight}`] : []),
      '--output',
      path.join(job.workDir, name),
      // 下面的 --print 隐含 --quiet，而 quiet 连进度也不报（实测一行 NRPROG 都没有，界面一直 0%）：显式要进度
      '--progress',
      '--progress-template',
      // 最后一项是正在下的那条流：分开的音视频是先后两条，各自从 0 报起（见 _download 里的累加）
      `download:${PROGRESS_TAG} %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(info.format_id)s`,
      '--print',
      `after_move:${FILE_TAG} %(filepath)s`,
      ...(YOUTUBE_HOST_RE.test(host) ? ['--extractor-args', 'youtube:player_client=android_vr'] : []),
      ...extra,
      '--',
      url,
    ];
  }

  _download(ytDlp, job, url, extra, proxy) {
    return new Promise((resolve, reject) => {
      // 建工作目录的时候就被取消了（那时还没有 yt-dlp 可杀）：不再起它，否则它会把整部片下完才被丢掉
      if (job.state === 'canceled') {
        reject(new Error('已取消'));
        return;
      }
      let child;
      try {
        child = this.spawnImpl(ytDlp, this._args(job, url, extra, proxy), {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          env: { ...this.childEnv(), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        });
      } catch (error) {
        reject(error);
        return;
      }
      let settled = false;
      let graceTimer = null;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(graceTimer);
        job.stop = null;
        fn(value);
      };
      // 取消：结束整棵进程树。树都退了管道才关、'close' 才来，这时 abort 才删得掉半截文件。
      // 万一还有漏网的子孙攥着管道，等 cancelGraceMs 就不等了：名额先还回去，删不掉的留给下次启动清
      job.stop = () => {
        job.stop = null;
        this.killTree(child);
        graceTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          settle(reject, new Error('已取消'));
        }, this.cancelGraceMs);
        graceTimer.unref?.();
      };
      let file = null;
      let stderr = '';
      const progress = { stream: null, base: 0, done: 0, total: 0 };
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        // 取消之后进程树退干净之前还会漏几行进度：不再报，「已取消」要等收完尾（工作目录删掉）才报
        if (job.state === 'canceled') return;
        if (line.startsWith(`${PROGRESS_TAG} `)) {
          const [doneRaw, totalRaw, estimateRaw, stream = ''] = line.slice(PROGRESS_TAG.length + 1).split(' ');
          const [done, total, estimate] = [doneRaw, totalRaw, estimateRaw].map(Number);
          const whole = Number.isFinite(total) && total > 0 ? total : Number.isFinite(estimate) && estimate > 0 ? estimate : 0;
          // 分开的音视频先后下两条，各自从 0 报起：换了一条就把上一条的大小垫在底下，进度条不会掉回 0
          if (stream !== progress.stream) {
            if (progress.stream !== null) progress.base += progress.total || progress.done;
            progress.stream = stream;
            progress.done = 0;
            progress.total = 0;
          }
          if (Number.isFinite(done)) progress.done = done;
          if (whole) progress.total = Math.round(whole);
          job.downloaded = progress.base + progress.done;
          if (progress.total) job.total = progress.base + progress.total;
          const now = Date.now();
          if (now - job.lastEmit >= this.progressEveryMs) {
            job.lastEmit = now;
            this._emit(job);
          }
        } else if (line.startsWith(`${FILE_TAG} `)) {
          file = line.slice(FILE_TAG.length + 1).trim();
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > 16_384) stderr = stderr.slice(-8_192);
      });
      child.on('error', (error) => settle(reject, error));
      child.on('close', (code) => {
        if (job.state === 'canceled') return settle(reject, new Error('已取消'));
        job.stop = null;
        const failed = () => {
          // 网站只有分开的音视频流、本机又没有 ffmpeg 合并：说人话，别把 yt-dlp 那句英文原样甩给人
          if (!job.ffmpeg && FORMAT_UNAVAILABLE_RE.test(stderr)) return settle(reject, new Error(NEEDS_FFMPEG_MESSAGE));
          const detail = stderr.trim().split(/\r?\n/).slice(-2).join(' ');
          settle(reject, new Error(`下载失败${detail ? `：${detail}` : ''}`));
        };
        if (code !== 0) return failed();
        finalFile(job.workDir, file).then((found) => (found ? settle(resolve, found) : failed()), failed);
      });
    });
  }
}

module.exports = {
  LinkCache,
  safeTitle,
  uniquePath,
  moveNoOverwrite,
  removeWorkDir,
  workDirIn,
  WORK_DIR,
  FORMAT,
  MERGE_FORMAT,
  NEEDS_FFMPEG_MESSAGE,
  MAX_PARALLEL,
  PURPOSES,
};
