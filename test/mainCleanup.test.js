'use strict';

/**
 * 主进程侧的收尾与闸门。
 *
 * 全程纯 Node：用一个假的 electron 模块加载真的 src/main/main.js，拿到它注册的 IPC 处理器，
 * 再把 media.inspect / media.remux 换成可控的假实现。不起 Electron、不起 mpv、不起 ffmpeg，
 * 一声不出。
 *
 * 覆盖四件事：
 *  1. 「清理残留」不许删别的实例／别的机器正在用的 run 目录（cacheManager）；
 *  2. 转封装进行中不许换缓存目录（换了 ffmpeg 正写着的目录会被端走）；
 *  3. 渲染进程刷新／崩溃后，主进程自己回收转封装产物和没人管的会话；
 *  4. ffprobe 报出的越界时长不跨进程，清单校验本身仍然严格。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const Module = require('module');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-main-cleanup-'));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error(`等不到：${label}`);
}

/* ============================ 假 electron + main.js ============================ */

const handlers = new Map();
const webEvents = new Map();
const paths = {
  userData: path.join(TMP, 'userData'),
  temp: path.join(TMP, 'systemp'),
  downloads: path.join(TMP, 'downloads'),
};
for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true });

const MAIN_PAGE_URL = pathToFileURL(path.join(REPO, 'src', 'renderer', 'index.html')).href;
const webContents = {
  mainFrame: { url: MAIN_PAGE_URL },
  send() {},
  on(name, fn) {
    const list = webEvents.get(name) || [];
    list.push(fn);
    webEvents.set(name, list);
  },
  session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
  setWindowOpenHandler() {},
};

let windowCreated = false;
// 下一次「选择目录」对话框要返回的路径（null 表示用户取消）
let nextDialogPick = null;
let readyResolve;
const ready = new Promise((resolve) => (readyResolve = resolve));

const fakeElectron = {
  app: {
    isPackaged: false,
    getPath: (key) => paths[key],
    setPath: (key, value) => (paths[key] = value),
    getVersion: () => '0.7.0-test',
    enableSandbox() {},
    commandLine: { appendSwitch() {} },
    requestSingleInstanceLock: () => true,
    on() {},
    whenReady: () => ready,
    setAsDefaultProtocolClient() {},
    quit() {},
  },
  BrowserWindow: class {
    constructor() {
      this.webContents = webContents;
      this.events = new Map();
      windowCreated = true;
    }
    static getAllWindows() {
      return [];
    }
    // 主进程往窗口上挂 closed（关掉主窗口就销毁覆盖窗并退出）。这个假窗口不触发它，
    // 只要收下就行 —— 退出路径本身在 appExit.test.js 里单独测。
    on(name, fn) {
      const list = this.events.get(name) || [];
      list.push(fn);
      this.events.set(name, list);
      return this;
    }
    setMenuBarVisibility() {}
    loadFile() {}
    isDestroyed() {
      return false;
    }
  },
  ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
  dialog: {
    showOpenDialog: async () => {
      const picked = nextDialogPick;
      nextDialogPick = null;
      return picked ? { canceled: false, filePaths: [picked] } : { canceled: true, filePaths: [] };
    },
  },
  shell: { openExternal: async () => {}, showItemInFolder() {} },
  clipboard: { writeText() {} },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
  session: {},
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-fake';
  return originalResolve.call(this, request, ...rest);
};
require.cache['electron-fake'] = {
  id: 'electron-fake',
  filename: 'electron-fake',
  loaded: true,
  exports: fakeElectron,
};

const { CacheManager } = require('../src/main/cacheManager');
const media = require('../src/main/media');

let booted = false;
async function boot() {
  if (booted) return;
  booted = true;
  require('../src/main/main.js');
  readyResolve();
  await waitFor(async () => handlers.has('app:ensureDirs') && windowCreated, '主进程接线完成');
}

function invoke(channel, ...args) {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`没有这个处理器：${channel}`);
  return fn({ sender: webContents, senderFrame: webContents.mainFrame }, ...args);
}

/** 触发一次 webContents 事件（真实 Electron 里由 Chromium 发出）。 */
function fire(name, ...args) {
  for (const fn of webEvents.get(name) || []) fn(...args);
}

test.after(() => {
  Module._resolveFilename = originalResolve;
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
});

/* ============================ 清理残留（cacheManager） ============================ */

// 片子放在 createOwnedDir 建的那种子目录里，和真实的 run 目录一样。
// 没有 run.json 的旧目录只能靠这个布局认出是本软件建的，布局对不上就当成用户的东西不碰。
const FILM = path.join('media-0-0123456789', 'film.part');

async function makeRunDir(root, name, marker) {
  const dir = path.join(root, name);
  await fsp.mkdir(path.join(dir, path.dirname(FILM)), { recursive: true });
  await fsp.writeFile(path.join(dir, FILM), 'x'.repeat(4096));
  if (marker) await fsp.writeFile(path.join(dir, 'run.json'), JSON.stringify(marker));
  return dir;
}

test('「清理残留」不碰别的实例或别的机器正在用的 run 目录', async () => {
  const root = path.join(TMP, 'shared-cache');
  await fsp.mkdir(root, { recursive: true });

  // 别的机器刚建的（PID 在这儿说明不了任何事，只能看年龄）
  const foreign = await makeRunDir(root, 'run-4242-old-abcdef', {
    host: '别人的机器',
    pid: 4242,
    startedAt: Date.now(),
  });
  // 本机另一个还活着的实例
  const live = await makeRunDir(root, 'run-4243-old-abcdef', {
    host: '本机',
    pid: 4243,
    startedAt: Date.now(),
  });
  // 真正的残留：本机、进程早没了
  const dead = await makeRunDir(root, 'run-4244-old-abcdef', {
    host: '本机',
    pid: 4244,
    startedAt: 1,
  });
  // 上次退出改好名的垃圾，无条件收
  const trash = await makeRunDir(root, 'trash-abcdef012345', null);

  const manager = new CacheManager({
    rootDir: root,
    pid: 1,
    now: Date.now,
    hostname: () => '本机',
    isAlive: (pid) => pid === 4243,
  });
  await manager.initialize();
  assert.equal(fs.existsSync(foreign), true, '启动清理本来就放过别的机器的目录');
  assert.equal(fs.existsSync(live), true, '启动清理本来就放过活着的实例');
  assert.equal(fs.existsSync(dead), false, '死进程留下的该收');

  // 界面上「上次退出没清掉」的数字：只能数真正能回收的
  const usage = await manager.usage();
  assert.equal(usage.staleRuns, 0, '活着的目录不能被说成残留，否则用户会去点那个按钮');
  assert.equal(usage.staleBytes, 0);

  // 手动清理和启动清理必须是同一套判据
  assert.equal(await manager.purgeStale(), 0, '没有可回收的就一个都不该删');
  assert.equal(fs.existsSync(foreign), true, '别的机器正在接收的片子不能删');
  assert.equal(fs.existsSync(live), true, '另一个实例正在接收的片子不能删');
  assert.equal(fs.existsSync(path.join(live, FILM)), true);
  assert.equal(fs.existsSync(trash), false, 'trash- 是明确标好的垃圾，启动时就该收掉');
});

test('「清理残留」照常收掉真正的残留', async () => {
  const root = path.join(TMP, 'stale-cache');
  await fsp.mkdir(root, { recursive: true });
  const manager = new CacheManager({
    rootDir: root,
    pid: 1,
    now: Date.now,
    hostname: () => '本机',
    isAlive: () => false,
  });
  await manager.initialize();
  const owned = await manager.createOwnedDir('media');
  await fsp.writeFile(path.join(owned, 'b.bin'), 'y'.repeat(8192));

  // 启动之后才出现的残留：死掉的本机实例 + 别的机器留下超过 24 小时的
  const dead = await makeRunDir(root, 'run-999-old-abcdef', { host: '本机', pid: 999, startedAt: 1 });
  const oldForeign = await makeRunDir(root, 'run-998-old-abcdef', {
    host: '别人的机器',
    pid: 998,
    startedAt: Date.now() - 48 * 60 * 60 * 1000,
  });
  const noMarker = await makeRunDir(root, 'run-997-old-abcdef', null);

  const usage = await manager.usage();
  assert.equal(usage.staleRuns, 3);
  assert.ok(usage.staleBytes > 0);
  assert.ok(usage.runBytes > 0, '本次会话的字节数照常算');

  assert.equal(await manager.purgeStale(), 3);
  for (const dir of [dead, oldForeign, noMarker]) assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.existsSync(owned), true, '当前会话的文件一个都不能动');
});

/* ============================ 越界时长 ============================ */

test('ffprobe 报出的越界时长不跨进程，清单校验仍然严格', async () => {
  await boot();
  const film = path.join(TMP, '长录像.mkv');
  await fsp.writeFile(film, Buffer.alloc(64 * 1024, 7));
  const approved = await invoke('dialog:approveDroppedVideo', film);

  const original = media.inspect;
  let reported = 0;
  media.inspect = async () => ({
    action: 'ok',
    ext: '.mkv',
    size: 64 * 1024,
    probe: { duration: reported, bitrate: 1_000_000, streams: [] },
    slim: null,
  });
  try {
    reported = 7200;
    assert.equal((await invoke('media:inspect', approved)).probe.duration, 7200, '正常时长原样带过去');

    reported = 86400;
    assert.equal((await invoke('media:inspect', approved)).probe.duration, 86400, '正好 24 小时还算数');

    // 25 小时的直播录像，或者时间戳写坏被报成十几万秒的 MKV
    reported = 90061.5;
    assert.equal(
      (await invoke('media:inspect', approved)).probe.duration,
      0,
      '越界就当没探到 —— 渲染进程据此不会把它写进清单'
    );

    reported = -1;
    assert.equal((await invoke('media:inspect', approved)).probe.duration, 0, '负数同样丢掉');
  } finally {
    media.inspect = original;
  }

  // 协议这一侧不放宽：越界的清单照样拒收，异常值进不了房间
  const manifest = await invoke('store:buildManifest', { filePath: approved, taskId: null });
  await assert.rejects(
    invoke('store:openSeed', { manifest: { ...manifest, durationSec: 90061.5 }, filePath: approved }),
    /媒体时长/
  );
  const state = await invoke('store:openSeed', { manifest: { ...manifest, durationSec: 7200 }, filePath: approved });
  assert.ok(state.sessionId);
  await invoke('store:close', state.sessionId);
});

/* ============================ 换缓存目录的闸门 ============================ */

test('转封装进行中不许换缓存目录', async () => {
  await boot();
  await invoke('app:ensureDirs');
  const film = path.join(TMP, '片子.mp4');
  await fsp.writeFile(film, Buffer.alloc(32 * 1024, 3));
  const approved = await invoke('dialog:approveDroppedVideo', film);

  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const original = media.remux;
  let outPath = null;
  media.remux = async (_source, outDir) => {
    outPath = path.join(outDir, '片子.faststart.mp4');
    // 假装 ffmpeg 正在往里写：句柄开着，目录被端走就全完了
    await fsp.writeFile(outPath, Buffer.alloc(1024, 4));
    await gate;
    return { outPath };
  };
  try {
    const running = invoke('media:remux', { filePath: approved, taskId: 'abcdef12' });
    await waitFor(async () => outPath && fs.existsSync(outPath), '转封装开始写产物');

    await assert.rejects(
      invoke('settings:setCacheRoot', { dir: path.join(TMP, 'newcache') }),
      /正在转封装或精简/,
      '产物还没登记进 remuxOutputs，这道闸只能靠进行中的计数'
    );
    assert.equal(fs.existsSync(outPath), true, '旧缓存目录不能在转封装途中被端走');

    release();
    const done = await running;
    assert.equal(fs.existsSync(done.outPath), true, '转封装照常完成');

    // 产物登记之后照旧由这条闸挡着，直到被回收
    await assert.rejects(invoke('settings:setCacheRoot', { dir: path.join(TMP, 'newcache') }), /临时文件/);
    assert.equal(await invoke('media:releaseTemp', done.outPath), true);
    assert.equal(fs.existsSync(done.outPath), false, '回收之后产物连目录一起没了');
  } finally {
    media.remux = original;
  }
});

/* ============================ 渲染进程刷新后的兜底回收 ============================ */

test('渲染进程刷新后主进程自己收干净转封装产物和没人管的会话', async () => {
  await boot();
  await invoke('app:ensureDirs');
  const film = path.join(TMP, '要放的片子.mp4');
  await fsp.writeFile(film, Buffer.alloc(32 * 1024, 5));
  const approved = await invoke('dialog:approveDroppedVideo', film);

  // 一份没人回收的转封装产物
  const original = media.remux;
  media.remux = async (_source, outDir) => {
    const out = path.join(outDir, '要放的片子.faststart.mp4');
    await fsp.writeFile(out, Buffer.alloc(2048, 6));
    return { outPath: out };
  };
  let outPath;
  try {
    ({ outPath } = await invoke('media:remux', { filePath: approved, taskId: 'abcdef34' }));
  } finally {
    media.remux = original;
  }
  // 再加一个开着的做种会话（离开房间时 store:close 恰好没发出去的那种）
  const manifest = await invoke('store:buildManifest', { filePath: approved, taskId: null });
  const state = await invoke('store:openSeed', { manifest, filePath: approved });
  assert.ok(state.sessionId);

  await assert.rejects(
    invoke('settings:setCacheRoot', { dir: path.join(TMP, 'after-reload') }),
    /正在放映/,
    '有会话开着，换缓存目录本来就该被拒'
  );

  // 首次加载不算刷新，别误伤正常启动
  fire('did-start-navigation', { url: MAIN_PAGE_URL, isMainFrame: true, isSameDocument: false });
  await sleep(50);
  assert.equal(fs.existsSync(outPath), true, '首次加载不该回收任何东西');

  // 子框架、同文档跳转（#锚点）都不是「页面重来」
  fire('did-start-navigation', { url: MAIN_PAGE_URL, isMainFrame: false, isSameDocument: false });
  fire('did-start-navigation', { url: `${MAIN_PAGE_URL}#x`, isMainFrame: true, isSameDocument: true });
  await sleep(50);
  assert.equal(fs.existsSync(outPath), true, '子框架和锚点跳转不该触发回收');

  // 真正的刷新（这里用 Electron 27 之前的老参数形状，两种形状都得认）
  fire('did-start-navigation', {}, MAIN_PAGE_URL, false, true);
  await waitFor(async () => !fs.existsSync(outPath), '转封装产物被回收');

  // 会话也收掉了：这正是「退了房还换不了缓存目录」的那条链子
  // 换缓存目录只认用户在对话框里挑的目录
  nextDialogPick = path.join(TMP, 'after-reload');
  assert.equal(await invoke('dialog:pickCacheDir'), path.join(TMP, 'after-reload'));
  const moved = await invoke('settings:setCacheRoot', { dir: path.join(TMP, 'after-reload') });
  assert.equal(moved.cacheDir, path.join(TMP, 'after-reload'));
});
