'use strict';

/**
 * 退出路径：关掉主窗口之后，这个软件到底有没有真的退出。
 *
 * 这条路以前一条测试都没有，而它一断就是最难看的那种 bug：
 * 覆盖窗（弹幕层）只 hide 不 destroy，用过一次外部播放器之后它就一直活着 ——
 * 于是「所有窗口都关了」永远不会发生，`window-all-closed` 不触发、`before-quit` 不跑，
 * 用户点了关闭按钮，PotPlayer 却还在带着声音放，桥接进程、全局快捷键、会话和缓存全留着。
 *
 * 所以这里测的是行为不是源码文本：拿一个假 electron 加载真的 main.js，
 * 真的去触发主窗口的 closed 事件，再看覆盖窗有没有被销毁、app.quit() 有没有被调、
 * 收尾（cleanup）有没有真的跑完。全程不起 Electron、不起播放器，一声不出。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');

const REPO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-app-exit-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error(`等不到：${label}`);
}

/* ============================== 假 electron ============================== */

const paths = {
  userData: path.join(TMP, 'userData'),
  temp: path.join(TMP, 'systemp'),
  downloads: path.join(TMP, 'downloads'),
};
for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true });

const MAIN_PAGE_URL = pathToFileURL(path.join(REPO, 'src', 'renderer', 'index.html')).href;
const handlers = new Map();
const windows = [];
const appEvents = new Map();
const shortcuts = { registered: [], unregisterAll: 0 };
const quits = [];

let readyResolve;
const ready = new Promise((resolve) => (readyResolve = resolve));

/** 假窗口。主进程挂在它身上的事件（尤其是 closed）要能被这里真的触发一次。 */
class FakeWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.destroyed = false;
    this.visible = false;
    this.webContents = new EventEmitter();
    this.webContents.mainFrame = { url: MAIN_PAGE_URL };
    this.webContents.send = () => {};
    this.webContents.session = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} };
    this.webContents.setWindowOpenHandler = () => {};
    this.webContents.isLoadingMainFrame = () => false;
    windows.push(this);
  }
  setMenuBarVisibility() {}
  setIgnoreMouseEvents() {}
  setFocusable() {}
  loadFile() {}
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return this.visible;
  }
  show() {
    this.visible = true;
  }
  showInactive() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  focus() {}
  /** 真 Electron 的 destroy() 会同步发一条 closed。 */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  }
}

const fakeElectron = {
  app: {
    isPackaged: false,
    getPath: (key) => paths[key],
    setPath: (key, value) => (paths[key] = value),
    getVersion: () => '0.7.0-test',
    enableSandbox() {},
    commandLine: { appendSwitch() {} },
    requestSingleInstanceLock: () => true,
    whenReady: () => ready,
    setAsDefaultProtocolClient() {},
    on(name, fn) {
      const list = appEvents.get(name) || [];
      list.push(fn);
      appEvents.set(name, list);
    },
    /**
     * 真 Electron 的 quit() 会先发一条可拦截的 before-quit。
     * main.js 第一次会拦下来去跑收尾，跑完再调一次 quit —— 那一次才算真退出。
     */
    quit() {
      let prevented = false;
      const event = { preventDefault: () => (prevented = true) };
      for (const fn of appEvents.get('before-quit') || []) fn(event);
      quits.push({ prevented });
    },
  },
  BrowserWindow: Object.assign(FakeWindow, {
    getAllWindows: () => windows.filter((w) => !w.destroyed),
  }),
  ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openExternal: async () => {}, showItemInFolder() {} },
  clipboard: { writeText() {} },
  screen: {
    getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }),
    screenToDipRect: (_win, rect) => rect,
  },
  globalShortcut: {
    register: (accel) => {
      shortcuts.registered.push(accel);
      return true;
    },
    unregister: () => {},
    unregisterAll: () => shortcuts.unregisterAll++,
  },
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

/**
 * 覆盖窗控制器换成带计数的子类。main.js 在加载时就 `new OverlayController()`，
 * 所以这一手必须赶在 require('../src/main/main.js') 之前。
 */
const overlayPath = require.resolve('../src/main/overlay.js');
const realOverlay = require(overlayPath);
const overlayDestroys = [];
class SpyOverlay extends realOverlay.OverlayController {
  destroy() {
    overlayDestroys.push(quits.length);
    return super.destroy();
  }
}
require.cache[overlayPath].exports = { ...realOverlay, OverlayController: SpyOverlay };

const { CacheManager } = require('../src/main/cacheManager');

test.after(() => {
  Module._resolveFilename = originalResolve;
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
});

/* ================================ 退出路径 ================================ */

test('关掉主窗口：销毁覆盖窗、真的退出、收尾一步不落', async () => {
  require('../src/main/main.js');
  readyResolve();
  await waitFor(async () => handlers.has('app:ensureDirs') && windows.length > 0, '主进程接线完成');

  const main = windows[0];
  // 这一场用过外部播放器：覆盖窗建起来了，之后它只是被藏起来，并没有销毁。
  // 真实 Electron 里这就是「所有窗口都关了」永远不会发生的原因。
  const overlayWin = new FakeWindow({ mark: 'overlay-like' });
  overlayWin.visible = true;
  assert.equal(fakeElectron.BrowserWindow.getAllWindows().length, 2);
  overlayWin.hide();
  assert.equal(fakeElectron.BrowserWindow.getAllWindows().length, 2, '藏起来的窗口照样算「还开着」');

  // 缓存的 run 目录：收尾真的跑完了它才会消失
  const runDir = new CacheManager({ rootDir: path.join(paths.temp, 'NoxReel') }).rootDir;
  assert.equal(fs.existsSync(runDir), true, '这一场的缓存根目录应该已经建好了');
  const before = fs.readdirSync(runDir).filter((name) => name.startsWith('run-'));
  assert.equal(before.length, 1, '这一场只该有一个 run 目录');

  assert.ok(main.listenerCount('closed') > 0, '主窗口没挂 closed —— 关掉它之后什么都不会发生');
  main.destroy(); // 用户点了窗口的关闭按钮

  // 覆盖窗必须**在这一步**就销毁，而不是等收尾里那一次：真实 Electron 里
  // 「还活着的第二个窗口」就是 window-all-closed 不触发的原因，退出流程根本走不到收尾。
  // 记的是「销毁发生时 app.quit() 已经被调过几次」，0 表示赶在退出之前。
  assert.deepEqual(overlayDestroys.slice(0, 1), [0], '覆盖窗没在主窗口关掉的当场销毁');
  assert.ok(quits.length > 0, 'app.quit() 没被调用');
  assert.equal(quits[0].prevented, true, '第一次退出应当被 before-quit 拦下来跑收尾');

  // 收尾是异步的（里面有 50ms 的让路和好几段 await），等它落地
  await waitFor(async () => quits.some((q) => !q.prevented), '收尾跑完并真的退出');
  assert.equal(shortcuts.unregisterAll, 1, '全局快捷键没注销：Ctrl+Shift+D 会被一个已经退出的程序占着');
  await waitFor(
    async () => fs.readdirSync(runDir).filter((name) => name.startsWith('run-')).length === 0,
    '这一场的缓存目录被收掉'
  );
});
