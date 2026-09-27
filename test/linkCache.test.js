'use strict';

// 在线视频下到本机（src/main/linkCache.js）：假 yt-dlp 进程，真文件系统和登记表。
// placement 照主进程的写法：手动缓存下进长期缓存文件夹并登记，边下边播的下载放进下载文件夹、不登记。
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { LinkCache, FORMAT, WORK_DIR, uniquePath } = require('../src/main/linkCache');
const { MediaLibrary } = require('../src/main/mediaLibrary');

async function tempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'noxreel-linkcache-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/**
 * 假 yt-dlp：记下每次的参数；behave(args, child) 决定它干什么。
 * 默认行为：往 --output 指的位置写一个文件，报两行进度，报出文件路径，正常退出。
 */
function fakeSpawn(behave) {
  const calls = [];
  const spawnImpl = (bin, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit('close', null));
    };
    calls.push({ bin, args, child });
    setImmediate(() => behave(args, child, calls.length));
    return child;
  };
  return { spawnImpl, calls };
}

function outputOf(args) {
  return args[args.indexOf('--output') + 1];
}

async function succeed(args, child, { ext = 'mp4', bytes = 1234 } = {}) {
  const file = outputOf(args).replace('%(title).120B', 'Video Title').replace('%(ext)s', ext);
  await fsp.writeFile(file, Buffer.alloc(bytes, 1));
  child.stdout.write(`NRPROG 100 ${bytes} NA\n`);
  child.stdout.write(`NRPROG ${bytes} ${bytes} NA\n`);
  child.stdout.write(`NRFILE ${file}\n`);
  child.stdout.end();
  setImmediate(() => child.emit('close', 0));
}

/** 和主进程 workDirIn 一样：在 dir 下开工作目录，下完挪进 dir（不重名）。 */
async function workDirIn(dir, id, onFinish = async () => {}) {
  const work = path.join(dir, WORK_DIR, id);
  await fsp.mkdir(work, { recursive: true });
  return {
    workDir: work,
    finish: async (file, meta) => {
      const target = await uniquePath(dir, path.basename(file));
      await fsp.rename(file, target);
      await fsp.rm(work, { recursive: true, force: true });
      await onFinish(target, meta);
      return target;
    },
    abort: () => fsp.rm(work, { recursive: true, force: true }),
  };
}

async function setup(t, { behave = succeed, maxParallel = 3, resolve = async () => null, ytDlp = 'yt-dlp.exe' } = {}) {
  const dir = await tempDir(t);
  const keptDir = path.join(dir, 'kept');
  const downloadDir = path.join(dir, 'downloads');
  await fsp.mkdir(keptDir, { recursive: true });
  await fsp.mkdir(downloadDir, { recursive: true });
  const library = await new MediaLibrary({ dataDir: path.join(dir, 'data') }).load();
  const { spawnImpl, calls } = fakeSpawn(behave);
  const cache = new LinkCache({
    findYtDlp: () => ytDlp,
    proxyInfo: async () => ({ url: 'http://u:p@127.0.0.1:5555' }),
    resolve,
    alreadyDone: (url, purpose) => purpose === 'cache' && !!library.findLink(url),
    placement: (job) =>
      job.purpose === 'download'
        ? workDirIn(downloadDir, job.id)
        : workDirIn(keptDir, job.id, (target, meta) =>
            library.addLink({ url: meta.url, title: meta.title, filePath: target, size: meta.size })
          ),
    spawnImpl,
    maxParallel,
  });
  const updates = [];
  cache.on('update', (v) => updates.push(v));
  return { cache, library, keptDir, downloadDir, calls, updates };
}

const until = async (cond, what) => {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`等不到：${what}`);
};

const leftovers = (dir) => {
  const work = path.join(dir, WORK_DIR);
  return fs.existsSync(work) ? fs.readdirSync(work).length : 0;
};

test('缓存一个链接：经过滤代理、选音画合一的格式，下完挪到位并登记，工作目录删掉', async (t) => {
  const { cache, library, keptDir, calls, updates } = await setup(t);
  const url = 'https://video.example.org/watch?v=1';
  cache.start({ url, title: '' });
  await until(() => cache.status()[0]?.state === 'done', '下完');

  const { args } = calls[0];
  assert.equal(args[args.indexOf('--proxy') + 1], 'http://u:p@127.0.0.1:5555', '每个请求都经本机过滤代理');
  assert.equal(args[args.indexOf('--format') + 1], FORMAT, '音画合一，不用 ffmpeg 合并');
  assert.deepEqual(args.slice(-2), ['--', url], '链接放在 -- 后面，不会被当成参数');
  assert.ok(args.includes('--no-playlist'));

  const entry = library.findLink(url);
  assert.ok(entry, '登记进长期缓存');
  assert.equal(path.dirname(entry.path), keptDir);
  assert.equal(path.basename(entry.path), 'Video Title.mp4');
  assert.equal(entry.size, 1234);
  assert.equal(leftovers(keptDir), 0, '工作目录清掉了');
  assert.deepEqual([...new Set(updates.map((u) => u.state))], ['queued', 'downloading', 'done']);
  assert.ok(updates.every((u) => u.purpose === 'cache'));
  assert.equal(cache.status()[0].path, entry.path);
});

test('已经缓存过的链接不再下；同一个链接在下的时候再点不会开第二个', async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { cache, calls } = await setup(t, {
    behave: async (args, child) => {
      await gate;
      await succeed(args, child);
    },
  });
  const url = 'https://video.example.org/v';
  cache.start({ url });
  cache.start({ url });
  await until(() => calls.length === 1, '开始下');
  await flush();
  assert.equal(calls.length, 1, '同一个链接只下一份');
  release();
  await until(() => cache.status()[0]?.state === 'done', '下完');
  const again = cache.start({ url });
  assert.equal(again.state, 'done');
  assert.equal(calls.length, 1, '登记过的不再下');
});

test('边下边播的下载和手动缓存互不相干：同一个链接各下各的，下载不登记进缓存、缓存过了也照样能下载', async (t) => {
  const { cache, library, keptDir, downloadDir, calls } = await setup(t);
  const url = 'https://video.example.org/both';
  cache.start({ url, title: '片子' });
  await until(() => cache.status()[0]?.state === 'done', '缓存下完');
  const view = cache.start({ url, title: '片子', purpose: 'download' });
  assert.equal(view.purpose, 'download');
  assert.notEqual(view.state, 'done', '缓存过了不等于下载过了');
  await until(() => cache.status().find((v) => v.purpose === 'download')?.state === 'done', '下载下完');
  assert.equal(calls.length, 2);
  const download = cache.status().find((v) => v.purpose === 'download');
  assert.equal(path.dirname(download.path), downloadDir, '下载放进下载文件夹');
  assert.equal(path.basename(download.path), '片子.mp4');
  assert.equal(path.dirname(library.findLink(url).path), keptDir, '登记表里还是缓存那份');
  assert.equal(leftovers(downloadDir), 0);
  assert.throws(() => cache.start({ url, purpose: 'other' }), /无效的下载用途/);
});

test('可以同时下好几部，但最多 maxParallel 个一起下，其余排队（缓存和下载共用名额）', async (t) => {
  const releases = [];
  const { cache, calls } = await setup(t, {
    maxParallel: 2,
    behave: (args, child) => {
      releases.push(() => succeed(args, child));
    },
  });
  cache.start({ url: 'https://video.example.org/1', title: '片1' });
  cache.start({ url: 'https://video.example.org/2', title: '片2', purpose: 'download' });
  cache.start({ url: 'https://video.example.org/3', title: '片3' });
  await until(() => calls.length === 2, '两个一起下');
  await flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(cache.status().map((v) => v.state), ['downloading', 'downloading', 'queued']);
  releases[0]();
  await until(() => calls.length === 3, '第三个轮到');
  releases[1]();
  releases[2]();
  await until(() => cache.status().every((v) => v.state === 'done'), '都下完');
});

test('取消：按用途取消；在下的杀掉 yt-dlp、工作目录删掉、不登记；在排队的直接出队', async (t) => {
  const { cache, library, keptDir, downloadDir, calls, updates } = await setup(t, {
    maxParallel: 1,
    behave: async (args, child) => {
      await fsp.writeFile(outputOf(args).replace('%(title).120B', 'x').replace('%(ext)s', 'mp4.part'), 'half');
      child.stdout.write('NRPROG 10 100 NA\n');
    },
  });
  cache.start({ url: 'https://video.example.org/a' });
  cache.start({ url: 'https://video.example.org/b', purpose: 'download' });
  await until(() => calls.length === 1, '第一个开始下');
  await flush();
  assert.equal(cache.cancel('https://video.example.org/b'), false, '用途不对取消不到');
  assert.equal(cache.cancel('https://video.example.org/b', 'download'), true);
  assert.equal(cache.cancel('https://video.example.org/a'), true);
  // 在下的那个：收尾（杀进程、删工作目录）做完才会报出「已取消」
  await until(() => updates.some((u) => u.url === 'https://video.example.org/a' && u.state === 'canceled'), '收尾完');
  assert.ok(cache.status().every((v) => v.state === 'canceled'));
  assert.equal(calls[0].child.killed, true);
  assert.equal(calls.length, 1, '排队的那个根本没开始');
  assert.equal(library.findLink('https://video.example.org/a'), null);
  assert.equal(leftovers(keptDir), 0, '半截文件不留下');
  assert.equal(leftovers(downloadDir), 0);
  assert.equal(cache.cancel('https://video.example.org/a'), false, '取消过的再取消没有用');
});

test('网页直接下不了：先解析拿到媒体地址，带着请求头再下一次', async (t) => {
  const { cache, library, calls } = await setup(t, {
    behave: async (args, child, n) => {
      if (n === 1) {
        child.stderr.write('ERROR: Unsupported URL\n');
        child.stdout.end();
        setImmediate(() => child.emit('close', 1));
        return;
      }
      await succeed(args, child);
    },
    resolve: async () => ({
      title: '隔离浏览器里的视频',
      playback: { url: 'https://cdn.example.org/v.mp4', headers: { Referer: 'https://video.example.org/' } },
    }),
  });
  cache.start({ url: 'https://video.example.org/page' });
  await until(() => cache.status()[0]?.state === 'done', '下完');
  const second = calls[1].args;
  assert.deepEqual(second.slice(-2), ['--', 'https://cdn.example.org/v.mp4']);
  assert.equal(second[second.indexOf('--add-header') + 1], 'Referer:https://video.example.org/');
  assert.match(outputOf(second), /隔离浏览器里的视频\.%\(ext\)s$/, '直链兜底时用解析出来的标题当文件名');
  assert.ok(library.findLink('https://video.example.org/page'), '登记的是列表里那个网页地址');
});

test('失败说清楚原因；yt-dlp 报回来的路径跑出工作目录的一律不认', async (t) => {
  const { cache, library, keptDir } = await setup(t, {
    behave: (args, child) => {
      child.stdout.write(`NRFILE ${path.join(os.tmpdir(), 'elsewhere.mp4')}\n`);
      child.stdout.end();
      setImmediate(() => child.emit('close', 0));
    },
  });
  cache.start({ url: 'https://video.example.org/x' });
  await until(() => cache.status()[0]?.state === 'failed', '失败');
  assert.match(cache.status()[0].error, /下载失败/);
  assert.equal(library.findLink('https://video.example.org/x'), null);
  assert.equal(leftovers(keptDir), 0, '失败了也由 abort 收拾工作目录');

  const none = await setup(t, { ytDlp: null });
  none.cache.start({ url: 'https://video.example.org/y' });
  await until(() => none.cache.status()[0]?.state === 'failed', '失败');
  assert.match(none.cache.status()[0].error, /没找到 yt-dlp/);
});

test('中文片名：强制 UTF-8 输出；报回来的路径被控制台编码弄乱了，就在工作目录里找唯一的成品', async (t) => {
  const { cache, downloadDir, calls } = await setup(t, {
    behave: async (args, child) => {
      const real = outputOf(args).replace('%(ext)s', 'mp4');
      await fsp.writeFile(real, Buffer.alloc(10, 1));
      await fsp.writeFile(`${real}.part-Frag3`, 'x'); // 残留的分段也不算成品
      await fsp.rm(`${real}.part-Frag3`);
      // Windows 上按 GBK 打印、按 UTF-8 读回来的样子
      child.stdout.write(`NRFILE ${path.join(path.dirname(real), '��Ƭ��.mp4')}\n`);
      child.stdout.end();
      setImmediate(() => child.emit('close', 0));
    },
  });
  cache.start({ url: 'https://video.example.org/zh', title: '样片二', purpose: 'download' });
  await until(() => ['done', 'failed'].includes(cache.status()[0]?.state), '下完');
  const view = cache.status()[0];
  assert.equal(view.state, 'done', view.error);
  assert.equal(view.path, path.join(downloadDir, '样片二.mp4'));
  const { args } = calls[0];
  assert.equal(args[args.indexOf('--encoding') + 1], 'utf-8');
});

test('启动时清掉上次没下完留下的工作目录（只认自己那个目录名，几个目录都清）', async (t) => {
  const { cache, keptDir, downloadDir } = await setup(t);
  for (const dir of [keptDir, downloadDir]) {
    await fsp.mkdir(path.join(dir, WORK_DIR, 'old'), { recursive: true });
    await fsp.writeFile(path.join(dir, WORK_DIR, 'old', 'half.part'), 'x');
    await fsp.writeFile(path.join(dir, 'mine.mp4'), '用户的');
  }
  await cache.cleanupLeftovers([keptDir, downloadDir, null]);
  for (const dir of [keptDir, downloadDir]) {
    assert.equal(fs.existsSync(path.join(dir, WORK_DIR)), false);
    assert.equal(fs.existsSync(path.join(dir, 'mine.mp4')), true);
  }
});

test('手动缓存和边下边播下载的文案都有英文', async () => {
  const { pathToFileURL } = require('node:url');
  const { translate } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/lib/i18n.js')).href);
  const en = (s) => translate(s, 'en');
  assert.equal(en('缓存中 42%'), 'Caching 42%');
  assert.equal(en('下载中 42%'), 'Downloading 42%');
  assert.equal(en('开始缓存《片子》'), 'Started caching “片子”');
  assert.equal(en('《片子》缓存好了，之后从本地播'), '“片子” is cached and will play from disk from now on');
  assert.equal(en('《片子》已存到下载位置'), '“片子” saved to the download folder');
  assert.equal(en('《片子》下载失败：网断了'), 'Could not download “片子”: 网断了');
  assert.equal(en('《片子》存不到下载位置：磁盘满了'), 'Could not save “片子” to the download folder: 磁盘满了');
  assert.equal(en('已取消下载《片子》'), 'Canceled downloading “片子”');
  assert.equal(en('下载位置已改到 D:\\影片'), 'Download folder changed to D:\\影片');
  for (const zh of [
    '开始手动缓存',
    '取消缓存',
    '取消下载',
    '已缓存 · 从本地播',
    '已存到下载位置',
    '缓存排队中',
    '下载排队中',
    '缓存失败',
    '下载失败',
    '没找到 yt-dlp，下载不了网页视频',
  ]) {
    assert.notEqual(en(zh), zh, zh);
  }
});
