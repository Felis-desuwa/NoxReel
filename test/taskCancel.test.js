'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const fileStore = require('../src/main/fileStore');
const media = require('../src/main/media');
const validate = require('../src/main/security');

/**
 * 0.7 起房间里加片的准备流程（算哈希 / 转封装 / 精简）可以被用户取消，
 * 进度事件也带上 taskId，渲染进程据此分清是哪部片的进度。
 * 这组测试真的去算哈希、真的起子进程再掐掉，另外静态核对 IPC 两端的约定。
 */

const root = path.join(__dirname, '..');
// 源文件可能是 CRLF，统一成 LF 再做静态匹配
const readSource = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const mainSrc = readSource('src/main/main.js');
const preloadSrc = readSource('src/main/preload.js');
const mediaSrc = readSource('src/main/media.js');

const { CHUNK_SIZE } = fileStore;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noxreel-task-cancel-'));
const leftovers = new Set();
let seq = 0;

test.after(() => {
  for (const pid of leftovers) {
    try {
      process.kill(pid);
    } catch {}
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 每个用例一个新文件：清单缓存按「真实路径 + 大小 + 修改时间」记，同一个文件会直接命中
function makeFile(chunks) {
  const file = path.join(tmp, `movie-${++seq}.mp4`);
  const buf = Buffer.alloc(chunks * CHUNK_SIZE + 17, seq);
  fs.writeFileSync(file, buf);
  return file;
}

// 记下 buildManifest 打开过的句柄，检查取消后有没有关掉
async function trackHandles(fn) {
  const original = fsp.open;
  const handles = [];
  fsp.open = async (...args) => {
    const fh = await original(...args);
    const entry = { closed: false };
    const close = fh.close.bind(fh);
    fh.close = async () => {
      entry.closed = true;
      return close();
    };
    handles.push(entry);
    return fh;
  };
  try {
    return await fn(handles);
  } finally {
    fsp.open = original;
  }
}

function handlerBody(src, channel) {
  const start = src.indexOf(`secureHandle('${channel}'`);
  assert.ok(start >= 0, `main.js 应注册 ${channel}`);
  const rest = src.slice(start);
  return rest.slice(0, rest.indexOf('\n});'));
}

function functionBody(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `找不到 ${signature}`);
  const rest = src.slice(start);
  const end = rest.indexOf('\n}\n');
  assert.ok(end > 0, `找不到 ${signature} 的结尾`);
  return rest.slice(0, end + 2);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await delay(25);
  }
  return false;
}

/* ------------------------------- 算哈希取消 ------------------------------- */

test('buildManifest：已取消的 signal 直接拒绝，句柄照样关掉，也不进清单缓存', async () => {
  const file = makeFile(3);
  const controller = new AbortController();
  controller.abort();
  await trackHandles(async (handles) => {
    await assert.rejects(fileStore.buildManifest(file, null, { signal: controller.signal }), /操作已取消/);
    assert.equal(handles.length, 1);
    assert.equal(handles[0].closed, true, '取消后文件句柄必须关掉');
  });

  // 取消的那次没留下半截清单：重算一遍是真算，不是命中缓存
  const progress = [];
  const manifest = await fileStore.buildManifest(file, (p) => progress.push(p));
  assert.equal(manifest.chunkCount, 4);
  assert.ok(progress.every((p) => !p.cached));
  assert.equal(progress.at(-1).done, 4);
});

test('buildManifest：算到一半取消，在下一片之前停下', async () => {
  const file = makeFile(3);
  const controller = new AbortController();
  const progress = [];
  await trackHandles(async (handles) => {
    await assert.rejects(
      fileStore.buildManifest(
        file,
        (p) => {
          progress.push(p);
          controller.abort(); // 第一片算完就取消
        },
        { signal: controller.signal }
      ),
      (error) => error.message === '操作已取消'
    );
    assert.equal(handles.length, 1);
    assert.equal(handles[0].closed, true, '中途取消也必须关掉文件句柄');
  });
  assert.deepEqual(progress, [{ done: 1, total: 4 }], '取消后不应再报进度');
});

test('buildManifest：命中清单缓存的快速路径不看 signal', async () => {
  const file = makeFile(2);
  const fresh = await fileStore.buildManifest(file);
  const controller = new AbortController();
  controller.abort();
  const progress = [];
  const cached = await fileStore.buildManifest(file, (p) => progress.push(p), { signal: controller.signal });
  assert.deepEqual(cached, fresh);
  assert.equal(progress[0].cached, true);
});

test('buildManifest：不带 signal 的老调用照常工作', async () => {
  const file = makeFile(1);
  const manifest = await fileStore.buildManifest(file, undefined);
  assert.equal(manifest.chunkCount, 2);
  assert.equal(manifest.hashes.length, 2);
});

/* ----------------------------- 外部程序取消 ----------------------------- */

// 假 ffmpeg：把自己的 pid 写进 argv[1] 指定的文件，然后很久不返回
const HANG_SCRIPT = "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 600000)";

test('media.run：运行中取消会结束子进程，并以「操作已取消」拒绝', async () => {
  const pidFile = path.join(tmp, `pid-${++seq}.txt`);
  const controller = new AbortController();
  const pending = media.run(process.execPath, ['-e', HANG_SCRIPT, pidFile], { signal: controller.signal });
  // 先挂上处理，免得等 pid 文件期间出现未处理的拒绝
  const outcome = pending.then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error })
  );

  assert.ok(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').length > 0), '子进程应已启动');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  leftovers.add(pid);
  assert.equal(isAlive(pid), true);

  controller.abort();
  const result = await outcome;
  assert.equal(result.ok, false);
  assert.equal(result.error.message, '操作已取消', '取消不应再报「退出码」');
  // run() 等子进程 close 之后才拒绝，这时候进程必须已经没了
  assert.ok(await waitFor(() => !isAlive(pid), 3000), '取消后子进程应已结束');
  leftovers.delete(pid);
});

test('media.run：signal 已取消就不启动子进程', async () => {
  const marker = path.join(tmp, `marker-${++seq}.txt`);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    media.run(process.execPath, ['-e', "require('fs').writeFileSync(process.argv[1], 'ran')", marker], {
      signal: controller.signal,
    }),
    (error) => error.message === '操作已取消'
  );
  await delay(500);
  assert.equal(fs.existsSync(marker), false, '已取消的任务不应再起进程');
});

test('media.run：不取消时行为不变（成功收输出，失败报退出码）', async () => {
  const controller = new AbortController();
  const ok = await media.run(process.execPath, ['-e', "process.stdout.write('hello')"], { signal: controller.signal });
  assert.equal(ok.stdout, 'hello');
  await assert.rejects(media.run(process.execPath, ['-e', 'process.exit(3)']), /退出码 3/);
  // 跑完之后再 abort 不应抛错，也不影响已经返回的结果
  controller.abort();
});

test('media.remux / slim 把 signal 一路传给 run()', () => {
  const remux = functionBody(mediaSrc, 'async function remux(');
  assert.match(remux, /\{ onProgress, signal \} = \{\}/);
  assert.match(remux, /await run\([\s\S]*signal \}/);
  const slim = functionBody(mediaSrc, 'async function slim(');
  assert.match(slim, /onProgress, signal \} = \{\}/);
  assert.match(slim, /await run\(bin, slimArgs[\s\S]*signal,\s*\}\)/);
});

/* -------------------------------- taskId -------------------------------- */

test('validate.taskId：可选，给了就只收 6–32 位小写字母数字', () => {
  assert.equal(validate.taskId(undefined), null);
  assert.equal(validate.taskId(null), null);
  for (const ok of ['abc123', 'a1b2c3d4e5f60718', 'z'.repeat(32), '0123456789abcdef0123456789abcdef']) {
    assert.equal(validate.taskId(ok), ok);
  }
  for (const bad of ['', 'abc12', 'ABC123', 'abc-123', 'abc 123', 'a'.repeat(33), 123456, {}, ['abc123'], '../abc1']) {
    assert.throws(() => validate.taskId(bad), TypeError, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('runTask：同一 taskId 不能并行，结束后（含失败）从表里删掉', async () => {
  const src = functionBody(mainSrc, 'async function runTask(');
  const tasks = new Map();
  // eslint-disable-next-line no-new-func
  const runTask = new Function('tasks', `${src}\nreturn runTask;`)(tasks);

  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let seen = null;
  const first = runTask('task01', async (signal) => {
    seen = signal;
    await gate;
    return 'done';
  });
  // 登记是同步的：发起后立刻取消也能找到
  assert.equal(tasks.has('task01'), true);
  assert.ok(seen instanceof AbortSignal);
  await assert.rejects(runTask('task01', async () => 'again'), /同一任务已在进行中/);
  assert.equal(tasks.has('task01'), true, '被拒的重复调用不能把正在跑的那个登记删掉');
  release();
  assert.equal(await first, 'done');
  assert.equal(tasks.size, 0);

  await assert.rejects(
    runTask('task02', async () => {
      throw new Error('boom');
    }),
    /boom/
  );
  assert.equal(tasks.size, 0);

  // 没有 taskId 的老调用：不登记，signal 为 undefined
  assert.equal(await runTask(null, async (signal) => signal), undefined);
  assert.equal(tasks.size, 0);
});

/* ------------------------------ IPC 静态约定 ------------------------------ */

test('main.js：dialog:pickVideos 多选、逐个批准、取消返回空数组', () => {
  const body = handlerBody(mainSrc, 'dialog:pickVideos');
  assert.match(body, /properties: \['openFile', 'multiSelections'\]/);
  assert.match(body, /filters: VIDEO_FILTERS/);
  assert.match(body, /r\.canceled \? \[\] : approveSources\(r\.filePaths\)/);
  assert.match(body, /devPicks\.length\) return approveSources\(takeDevPick\(\)\)/);
  // 与单选用同一套过滤器
  assert.match(handlerBody(mainSrc, 'dialog:pickVideo'), /filters: VIDEO_FILTERS/);
  // 房主能选的格式只来自 mediaGuard 那一张表（AVI、TS 这些会先封成 MKV），不在这里另写一份
  assert.match(mainSrc, /const VIDEO_FILTERS = \[\{ name: '视频', extensions: \[\.\.\.SOURCE_EXTENSIONS\]\.map\(/);

  // 逐个 approveSource，单个出错只跳过它
  const approve = functionBody(mainSrc, 'async function approveSources(');
  assert.match(approve, /for \(const filePath of filePaths\)/);
  assert.match(approve, /try \{\s*const realPath = await approveSource\(filePath\)/);
  assert.match(approve, /\} catch \{\}/);
});

test('main.js：开发钩子条目按 * 拆分，单选只取第一个', () => {
  const take = functionBody(mainSrc, 'function takeDevPick(');
  assert.match(take, /devPicks\.shift\(\)\.split\('\*'\)/);
  assert.match(handlerBody(mainSrc, 'dialog:pickVideo'), /approveSource\(takeDevPick\(\)\[0\]\)/);
});

test('main.js：task:cancel 校验后找到就 abort 返回 true，找不到返回 false', () => {
  assert.match(mainSrc, /const tasks = new Map\(\)/);
  const body = handlerBody(mainSrc, 'task:cancel');
  assert.match(body, /validate\.taskId\(taskId\)/);
  assert.match(body, /tasks\.get\(id\)/);
  assert.match(body, /if \(!controller\) return false/);
  assert.match(body, /controller\.abort\(\);\s*return true/);
  const run = functionBody(mainSrc, 'async function runTask(');
  assert.match(run, /tasks\.has\(taskId\)\) throw/);
  assert.match(run, /finally \{\s*tasks\.delete\(taskId\)/);
});

test('main.js：三个长任务都接 taskId、传 signal、进度带 taskId', () => {
  const build = handlerBody(mainSrc, 'store:buildManifest');
  assert.match(build, /taskPayload\(payload/);
  assert.match(build, /runTask\(taskId/);
  assert.match(build, /send\('store:hashProgress', \{ \.\.\.p, taskId \}\)/);
  assert.match(build, /\{ signal \}/);

  const remux = handlerBody(mainSrc, 'media:remux');
  assert.match(remux, /taskPayload\(payload/);
  assert.match(remux, /runTask\(taskId/);
  assert.match(remux, /send\('media:remuxProgress', \{ progress: p, taskId \}\)/);
  assert.match(remux, /signal,/);
  assert.match(remux, /cache\.removeOwned\(ownedDir\)/, '取消或失败时必须删掉已建的目录');

  const slim = handlerBody(mainSrc, 'media:slim');
  assert.match(slim, /validate\.taskId\(rawTaskId\)/);
  assert.match(slim, /runTask\(taskId/);
  assert.match(slim, /send\('media:slimProgress', \{ progress: p, taskId \}\)/);
  assert.match(slim, /signal,/);

  // 两种参数形态：字符串是老调用，对象要校验 taskId
  const payload = functionBody(mainSrc, 'function taskPayload(');
  assert.match(payload, /typeof payload === 'string'\) return \{ filePath: payload, taskId: null \}/);
  assert.match(payload, /validate\.plainObject\(payload/);
  assert.match(payload, /validate\.taskId\(taskId\)/);
});

test('preload：暴露 pickVideos、tasks.cancel，长任务转发 taskId', () => {
  assert.match(preloadSrc, /pickVideos: \(\) => ipcRenderer\.invoke\('dialog:pickVideos'\)/);
  assert.match(preloadSrc, /tasks: \{\s*cancel: \(taskId\) => ipcRenderer\.invoke\('task:cancel', taskId\)/);
  assert.match(
    preloadSrc,
    /buildManifest: \(filePath, taskId\) =>\s*ipcRenderer\.invoke\('store:buildManifest', taskId \? \{ filePath, taskId \} : filePath\)/
  );
  assert.match(
    preloadSrc,
    /remux: \(filePath, taskId\) => ipcRenderer\.invoke\('media:remux', taskId \? \{ filePath, taskId \} : filePath\)/
  );
  assert.match(preloadSrc, /slim: \(filePath, \{ keepIndexes = null, toFlac = null, taskId = null \} = \{\}\)/);
  assert.match(preloadSrc, /'media:slim', \{ filePath, keepIndexes, toFlac, \.\.\.\(taskId \? \{ taskId \} : \{\}\) \}/);
});
