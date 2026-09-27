'use strict';

/**
 * 启动路径：建窗口之前的准备出了岔子，窗口也得出来。
 *
 * 以前 whenReady 的回调里串行 await 缓存准备，默认缓存目录也建不出来（%TEMP%\NoxReel 是个同名文件、
 * TEMP 指向不存在的盘、没权限）时回调就此中断：窗口永远不出来，进程却一直占着单实例锁 ——
 * 再双击图标，second-instance 里 win 是 null，什么都不做，只能去任务管理器结束。
 *
 * 这里拿一个假 electron 加载真的 main.js：把默认缓存根换成一个同名文件，再让第一次建窗口抛错，
 * 看窗口有没有照样去建、再双击一次图标能不能补出来、页面调 app:ensureDirs 时能不能拿到原因。
 * 全程不起 Electron、不起播放器，一声不出。
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-main-startup-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error(`等不到：${label}`);
}

const paths = {
  userData: path.join(TMP, 'userData'),
  temp: path.join(TMP, 'systemp'),
  downloads: path.join(TMP, 'downloads'),
  videos: path.join(TMP, 'videos'),
};
for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true });
// 默认缓存根（%TEMP%\NoxReel）被一个同名文件占着：mkdir 报 EEXIST
fs.writeFileSync(path.join(paths.temp, 'NoxReel'), 'not a directory');
// 手动模式的长期缓存文件夹在 LOCALAPPDATA 下：别碰这台机器上真的那个
const savedLocalAppData = process.env.LOCALAPPDATA;
process.env.LOCALAPPDATA = path.join(TMP, 'localappdata');

const MAIN_PAGE_URL = pathToFileURL(path.join(REPO, 'src', 'renderer', 'index.html')).href;
const handlers = new Map();
const windows = [];
const appEvents = new Map();
let windowAttempts = 0;
let failNextWindow = true; // 第一次建窗口抛错：模拟「窗口没建出来」

let readyResolve;
const ready = new Promise((resolve) => (readyResolve = resolve));

class FakeWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    if (options.title === 'NoxReel') {
      windowAttempts++;
      if (failNextWindow) {
        failNextWindow = false;
        throw new Error('模拟：建主窗口失败');
      }
    }
    this.options = options;
    this.destroyed = false;
    this.visible = false;
    this.calls = [];
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
  isMinimized() {
    return false;
  }
  isVisible() {
    return this.visible;
  }
  restore() {}
  show() {
    this.visible = true;
    this.calls.push('show');
  }
  showInactive() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  focus() {
    this.calls.push('focus');
  }
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
    setAsDefaultProtocolClient: () => false,
    on(name, fn) {
      const list = appEvents.get(name) || [];
      list.push(fn);
      appEvents.set(name, list);
    },
    quit() {},
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
  globalShortcut: { register: () => true, unregister: () => {}, unregisterAll: () => {} },
  session: {},
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-fake';
  return originalResolve.call(this, request, ...rest);
};
require.cache['electron-fake'] = { id: 'electron-fake', filename: 'electron-fake', loaded: true, exports: fakeElectron };

// 主进程在这条路上会 console.warn / console.error 几句（缓存目录建不出来、建窗口失败）：收起来，别刷测试输出
const printed = [];
const originalWarn = console.warn;
const originalError = console.error;

test.after(() => {
  Module._resolveFilename = originalResolve;
  console.warn = originalWarn;
  console.error = originalError;
  if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = savedLocalAppData;
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
});

test('默认缓存目录建不出来、第一次建窗口又失败：照样去建窗口，再双击一次图标能补出来，页面能拿到原因', async () => {
  console.warn = (...args) => printed.push(args.join(' '));
  console.error = (...args) => printed.push(args.join(' '));
  require('../src/main/main.js');
  readyResolve();

  // 缓存准备失败没有挡住建窗口：试过了（这一次是被我们弄失败的）
  await waitFor(() => windowAttempts === 1, '缓存准备失败之后仍去建窗口');
  assert.equal(windows.length, 0);
  assert.ok(printed.some((line) => line.includes('缓存目录准备失败')), `没说缓存目录的问题：${printed.join(' | ')}`);
  assert.ok(printed.some((line) => line.includes('启动时建窗口失败')), `建窗口的错误没接住：${printed.join(' | ')}`);

  // 用户再双击一次图标：第二个进程拿不到锁退出，这边得把窗口补出来
  const second = appEvents.get('second-instance') || [];
  assert.ok(second.length > 0, '没挂 second-instance');
  for (const fn of second) fn({}, ['C:\\Program Files\\NoxReel\\NoxReel.exe'], process.cwd());
  assert.equal(windowAttempts, 2);
  assert.equal(windows.length, 1, '再双击一次也没把窗口补出来');
  assert.deepEqual(windows[0].calls, ['show', 'focus'], '补出来的窗口要拉到前台');

  // 再来一次不会建出第二个窗口
  for (const fn of second) fn({}, ['C:\\Program Files\\NoxReel\\NoxReel.exe'], process.cwd());
  assert.equal(windows.length, 1);

  // 页面启动时调 app:ensureDirs：再试一次，失败的原因交给界面去说
  const main = windows[0];
  const ensureDirs = handlers.get('app:ensureDirs');
  await assert.rejects(ensureDirs({ sender: main.webContents, senderFrame: main.webContents.mainFrame }), /EEXIST|ENOTDIR|exist/i);
});
