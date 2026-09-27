'use strict';

// 边下边播的另存（src/main/downloadSaver.js）：真文件系统
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DownloadSaver } = require('../src/main/downloadSaver');

async function setup(t, deps = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'noxreel-download-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const cacheFile = path.join(root, 'cache', 'run-1', '片子.mkv');
  await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
  await fsp.writeFile(cacheFile, Buffer.alloc(4096, 7));
  let dir = path.join(root, 'downloads');
  const saver = new DownloadSaver({ dir: () => dir, ...deps });
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

test('硬链接不行（跨盘、文件系统不支持）就复制；复制也绝不覆盖已有文件', async (t) => {
  const copies = [];
  const { cacheFile, saver, dir } = await setup(t, {
    link: async () => {
      throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
    },
    copy: async (src, dest, mode) => {
      copies.push(mode);
      return fsp.copyFile(src, dest, mode);
    },
  });
  await fsp.mkdir(dir(), { recursive: true });
  await fsp.writeFile(path.join(dir(), '片子.mkv'), '用户自己的');
  const r = await saver.save('file:abc', cacheFile);
  assert.equal(r.path, path.join(dir(), '片子 (2).mkv'), '同名的另起名字');
  assert.equal(fs.readFileSync(path.join(dir(), '片子.mkv'), 'utf8'), '用户自己的');
  assert.equal(fs.statSync(r.path).nlink, 1);
  assert.deepEqual(copies, [fs.constants.COPYFILE_EXCL], '复制时带 EXCL：抢先出现的同名文件宁可失败也不覆盖');
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
