'use strict';

// 边下边播的另存（src/main/downloadSaver.js）：真文件系统
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DownloadSaver, copyFileCancelable } = require('../src/main/downloadSaver');
const { WORK_DIR, moveNoOverwrite } = require('../src/main/linkCache');

async function setup(t, deps = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'noxreel-download-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const cacheFile = path.join(root, 'cache', 'run-1', '片子.mkv');
  await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
  await fsp.writeFile(cacheFile, Buffer.alloc(4096, 7));
  let dir = path.join(root, 'downloads');
  // 余量默认按「够用」算：别让测试机上的真实剩余空间影响结果
  const saver = new DownloadSaver({ dir: () => dir, statfs: async () => ({ bavail: 1e15, bsize: 1 }), ...deps });
  return { root, cacheFile, saver, setDir: (d) => (dir = d), dir: () => dir };
}

test('同一个盘上用硬链接：不多占空间，缓存那份删了这份还在', async (t) => {
  const { cacheFile, saver, dir } = await setup(t);
  const r = await saver.save('file:abc', cacheFile);
  assert.equal(r.fresh, true);
  assert.equal(r.path, path.join(dir(), '片子.mkv'), '下载文件夹不存在就建出来，用原来的片名');
  assert.equal(fs.statSync(r.path).nlink, 2, '是硬链接，不是复制');
  await fsp.rm(cacheFile);
  assert.equal(fs.readFileSync(r.path).length, 4096, '关软件清掉缓存，下载的那份不受影响');
});

const crossDevice = async () => {
  throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
};

test('硬链接不行（跨盘、文件系统不支持）就复制：先写进工作目录，复制完才挪成正式片名，绝不覆盖已有文件', async (t) => {
  const targets = [];
  let env;
  env = await setup(t, {
    link: async (src, dest) => {
      // 工作目录挪到正式名时用的是真的硬链接（同一个盘）；缓存那份到下载文件夹这一步假装跨盘
      if (src === env.cacheFile) return crossDevice();
      return fsp.link(src, dest);
    },
    copy: async (src, dest, opts) => {
      targets.push(dest);
      assert.ok(opts.signal, '复制要能取消');
      // 复制途中：下载文件夹根下还没有正式片名的文件（进程这时被强杀，留下的只是工作目录）
      assert.equal(fs.existsSync(path.join(env.dir(), '片子 (2).mkv')), false);
      return fsp.copyFile(src, dest);
    },
  });
  const { cacheFile, saver, dir } = env;
  await fsp.mkdir(dir(), { recursive: true });
  await fsp.writeFile(path.join(dir(), '片子.mkv'), '用户自己的');
  const r = await saver.save('file:abc', cacheFile);
  assert.equal(r.path, path.join(dir(), '片子 (2).mkv'), '同名的另起名字');
  assert.equal(fs.readFileSync(path.join(dir(), '片子.mkv'), 'utf8'), '用户自己的');
  assert.equal(fs.readFileSync(r.path).length, 4096);
  assert.equal(path.basename(path.dirname(path.dirname(targets[0]))), WORK_DIR, '复制写的是 .noxreel-downloading/<号>/ 里的临时文件');
  assert.equal(fs.existsSync(path.dirname(targets[0])), false, '工作目录用完就删');
  assert.equal(saver.busy, false);
});

test('复制中途出错：不留半截文件，也不占着正式片名', async (t) => {
  let partial = null;
  const { cacheFile, saver, dir } = await setup(t, {
    link: crossDevice,
    copy: async (src, dest) => {
      partial = dest;
      await fsp.writeFile(dest, Buffer.alloc(100));
      throw Object.assign(new Error('写满了'), { code: 'ENOSPC' });
    },
  });
  await assert.rejects(saver.save('file:abc', cacheFile), /写满了/);
  assert.equal(fs.existsSync(partial), false);
  assert.equal(fs.existsSync(path.dirname(partial)), false);
  assert.deepEqual(fs.readdirSync(dir()).filter((n) => n !== WORK_DIR), [], '下载文件夹里没有坏文件');
  assert.equal(await saver.existing('file:abc'), null, '没存上就不记');
});

test('复制前先查下载位置的余量：放不下直接报，不去把系统盘写满', async (t) => {
  let copied = false;
  const { cacheFile, saver } = await setup(t, {
    link: crossDevice,
    copy: async () => {
      copied = true;
    },
    statfs: async () => ({ bavail: 1024, bsize: 1 }),
  });
  await assert.rejects(saver.save('file:abc', cacheFile), /下载位置的磁盘空间不够/);
  assert.equal(copied, false);
});

test('退出软件时取消正在复制的另存，半截文件连工作目录删掉', async (t) => {
  let started;
  const running = new Promise((resolve) => (started = resolve));
  let partial = null;
  const { cacheFile, saver, dir } = await setup(t, {
    link: crossDevice,
    copy: (src, dest, { signal }) =>
      new Promise((resolve, reject) => {
        partial = dest;
        fs.writeFileSync(dest, Buffer.alloc(100));
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        started();
      }),
  });
  const saving = saver.save('file:abc', cacheFile);
  await running;
  assert.equal(saver.busy, true);
  await saver.cancelAll();
  await assert.rejects(saving, /aborted/);
  assert.equal(fs.existsSync(partial), false);
  assert.equal(fs.existsSync(path.dirname(partial)), false);
  assert.deepEqual(fs.readdirSync(dir()).filter((n) => n !== WORK_DIR), []);
  assert.equal(saver.busy, false);
});

test('默认的复制（能取消的流式复制）逐字节一致，目标已存在就失败', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'noxreel-copy-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const src = path.join(root, 'src.bin');
  const data = Buffer.alloc(9 * 1024 * 1024 + 17);
  for (let i = 0; i < data.length; i += 4096) data[i] = i & 0xff;
  await fsp.writeFile(src, data);
  const dest = path.join(root, 'dest.bin');
  await copyFileCancelable(src, dest);
  assert.ok(fs.readFileSync(dest).equals(data));
  await assert.rejects(copyFileCancelable(src, dest), /EEXIST/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(copyFileCancelable(src, path.join(root, 'x.bin'), { signal: controller.signal }));
});

test('这次运行里存过的不再存第二份；那份被用户删了才重新存', async (t) => {
  const { cacheFile, saver } = await setup(t);
  const first = await saver.save('file:abc', cacheFile);
  const again = await saver.save('file:abc', cacheFile);
  assert.deepEqual(again, { path: first.path, fresh: false });
  assert.equal(await saver.existing('file:abc'), first.path);
  await fsp.rm(first.path);
  assert.equal(await saver.existing('file:abc'), null);
  const third = await saver.save('file:abc', cacheFile);
  assert.equal(third.fresh, true);
});

test('下载位置换了：之后存的放进新位置；后台下好的在线视频记一笔，不再另存', async (t) => {
  const { root, cacheFile, saver, setDir } = await setup(t);
  const other = path.join(root, 'D盘', '影片');
  setDir(other);
  const r = await saver.save('file:abc', cacheFile, 'ignored/../名字.mkv');
  assert.equal(r.path, path.join(other, '名字.mkv'), '只取文件名，不许借名字跑出下载文件夹');

  const downloaded = path.join(other, '在线.mp4');
  await fsp.writeFile(downloaded, 'x');
  saver.remember('link:https://v.example/1', downloaded);
  assert.equal(await saver.existing('link:https://v.example/1'), downloaded);
});

test('事后扫出威胁：这次运行里放进去的那份一起删，别的不碰', async (t) => {
  const { cacheFile, saver, dir } = await setup(t);
  const r = await saver.save('file:abc', cacheFile);
  const mine = path.join(dir(), '别的.mkv');
  await fsp.writeFile(mine, '用户的');
  assert.equal(await saver.discard('file:abc'), true);
  assert.equal(fs.existsSync(r.path), false);
  assert.equal(fs.existsSync(mine), true);
  assert.equal(await saver.discard('file:abc'), false, '没存过的什么都不删');
  assert.equal(await saver.discard('file:nope'), false);
});

test('从工作目录挪成正式片名：同名的另起名字，绝不覆盖；挪完原来那个就没了', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'noxreel-move-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const work = path.join(root, WORK_DIR, 'abc');
  await fsp.mkdir(work, { recursive: true });
  const made = path.join(work, '片子.mkv');
  await fsp.writeFile(made, '新的');
  await fsp.writeFile(path.join(root, '片子.mkv'), '用户的');
  const target = await moveNoOverwrite(made, root, '片子.mkv');
  assert.equal(target, path.join(root, '片子 (2).mkv'));
  assert.equal(fs.readFileSync(target, 'utf8'), '新的');
  assert.equal(fs.readFileSync(path.join(root, '片子.mkv'), 'utf8'), '用户的');
  assert.equal(fs.existsSync(made), false);
});
