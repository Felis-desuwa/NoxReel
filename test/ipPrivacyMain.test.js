'use strict';

/**
 * IP 隐私（0.7.6）在主进程这一侧的接线：拿一个假 electron 加载真的 main.js 和 preload.js。
 *
 *  1. 主窗口 session 的权限「检查」对 media 返回 false —— 放行的话 Chromium 以为页面有摄像头 /
 *     麦克风权限，就不做 mDNS 混淆，本机局域网 IP 和公网 IPv6 明文进 SDP。
 *  2. Cloudflare TURN 的几个 IPC：参数经 security.js 校验，API Token 只进不出。
 *
 * 全程不起 Electron、不联网（会发请求的路径一条都不走到）、不出声。
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-ip-privacy-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }));

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error(`等不到：${label}`);
}

/* ========================= 假 electron（必须最先装上） ========================= */

const MAIN_PAGE_URL = pathToFileURL(path.join(REPO, 'src', 'renderer', 'index.html')).href;
const paths = {
  userData: path.join(TMP, 'userData'),
  temp: path.join(TMP, 'systemp'),
  downloads: path.join(TMP, 'downloads'),
};
for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true });

const handlers = new Map();
const windows = [];
let exposed = null;
const preloadInvokes = [];
let readyResolve;
const ready = new Promise((resolve) => (readyResolve = resolve));

/** 假 session：把主进程装上去的两个权限处理器原样留下来，测试里亲手调一遍。 */
function fakeSession() {
  return {
    requestHandler: null,
    checkHandler: null,
    setPermissionRequestHandler(fn) {
      this.requestHandler = fn;
    },
    setPermissionCheckHandler(fn) {
      this.checkHandler = fn;
    },
  };
}

class FakeWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.destroyed = false;
    this.webContents = new EventEmitter();
    this.webContents.mainFrame = { url: MAIN_PAGE_URL };
    this.webContents.send = () => {};
    this.webContents.session = fakeSession();
    this.webContents.setWindowOpenHandler = () => {};
    this.webContents.isLoadingMainFrame = () => false;
    windows.push(this);
  }
  setMenuBarVisibility() {}
  loadFile() {}
  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return false;
  }
  show() {}
  focus() {}
}

const fakeElectron = {
  app: {
    isPackaged: false,
    getPath: (key) => paths[key],
    setPath: (key, value) => (paths[key] = value),
    getVersion: () => '0.7.6-test',
    enableSandbox() {},
    commandLine: { appendSwitch() {} },
    requestSingleInstanceLock: () => true,
    whenReady: () => ready,
    setAsDefaultProtocolClient() {},
    on() {},
    quit() {},
  },
  BrowserWindow: Object.assign(FakeWindow, { getAllWindows: () => windows.filter((w) => !w.destroyed) }),
  ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openExternal: async () => {}, showItemInFolder() {} },
  clipboard: { writeText() {} },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
  globalShortcut: { register: () => true, unregister() {}, unregisterAll() {} },
  // 真的 safeStorage 要等 app ready、要系统密钥服务；这里给一个能用的替身
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`ENC:${Buffer.from(text).toString('hex')}`),
    decryptString: (buf) => Buffer.from(Buffer.from(buf).toString().slice(4), 'hex').toString(),
  },
  session: {},
  contextBridge: { exposeInMainWorld: (_name, api) => (exposed = api) },
  ipcRenderer: {
    invoke: async (channel, ...args) => {
      preloadInvokes.push([channel, ...args]);
      return null;
    },
    on() {},
    off() {},
  },
  webUtils: { getPathForFile: () => '' },
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-fake-ip-privacy';
  return originalResolve.call(this, request, ...rest);
};
require.cache['electron-fake-ip-privacy'] = {
  id: 'electron-fake-ip-privacy',
  filename: 'electron-fake-ip-privacy',
  loaded: true,
  exports: fakeElectron,
};
test.after(() => {
  Module._resolveFilename = originalResolve;
});

let booted = false;
async function boot() {
  if (booted) return;
  booted = true;
  require('../src/main/main.js');
  readyResolve();
  await waitFor(() => handlers.has('turn:cfStatus') && windows.length > 0, '主进程接线完成');
}

function invoke(channel, ...args) {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`没有这个处理器：${channel}`);
  const main = windows[0];
  return fn({ sender: main.webContents, senderFrame: main.webContents.mainFrame }, ...args);
}

test.after(async () => {
  await require('../src/main/publicProxy').closeSharedProxy();
});

/* ============================ 一、权限检查 ============================ */

test('lockDownPermissions：请求一律回 false，检查一律 false —— 尤其是 media', () => {
  const { lockDownPermissions } = require('../src/main/permissions');
  const session = fakeSession();
  lockDownPermissions(session);
  assert.equal(typeof session.checkHandler, 'function', '没装检查处理器：Electron 默认放行，host 候选就是明文 IP');
  for (const permission of ['media', 'clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen', 'geolocation']) {
    assert.equal(session.checkHandler({}, permission, 'file:///', { mediaType: 'video' }), false, permission);
  }
  const answers = [];
  session.requestHandler({}, 'media', (ok) => answers.push(ok));
  session.requestHandler({}, 'notifications', (ok) => answers.push(ok));
  assert.deepEqual(answers, [false, false]);
});

test('主窗口的 session 上真的装了检查处理器，对 media 返回 false', async () => {
  await boot();
  const session = windows[0].webContents.session;
  assert.equal(typeof session.checkHandler, 'function');
  assert.equal(session.checkHandler(windows[0].webContents, 'media', MAIN_PAGE_URL, { mediaType: 'audio' }), false);
  assert.equal(session.checkHandler(windows[0].webContents, 'media', MAIN_PAGE_URL, { mediaType: 'video' }), false);
  const answers = [];
  session.requestHandler(windows[0].webContents, 'media', (ok) => answers.push(ok));
  assert.deepEqual(answers, [false]);
});

test('渲染进程没用到要过权限检查的能力（剪贴板走 IPC），一律拒绝不会误伤功能', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'third_party') walk(full);
      } else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(path.join(REPO, 'src', 'renderer'));
  const banned = /navigator\.clipboard|new Notification|Notification\.requestPermission|requestFullscreen|getUserMedia|getDisplayMedia|navigator\.permissions|navigator\.geolocation|enumerateDevices/;
  const hits = files.filter((f) => banned.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(REPO, f));
  assert.deepEqual(hits, [], '渲染进程用了要过权限检查的能力：要么改走 IPC，要么在 permissions.js 里单独放行那一项（media 不行）');
});

/* ======================== 三、Cloudflare TURN 的 IPC ======================== */

test('turn:cfSave 参数先过 security.js：格式不对当场拒，报错不带值，什么都不存', async () => {
  await boot();
  const token = 'bad token with spaces!!';
  await assert.rejects(invoke('turn:cfSave', { keyId: 'abcdefgh12', apiToken: token }), (e) => e.message === '无效的 API Token');
  await assert.rejects(invoke('turn:cfSave', { keyId: '../../etc', apiToken: 'x'.repeat(20) }), /无效的 Turn Token ID/);
  await assert.rejects(invoke('turn:cfSave', 'not-an-object'), /无效的 Cloudflare 凭据/);
  assert.equal(fs.existsSync(path.join(paths.userData, 'cloudflare-turn.json')), false);
});

test('turn:cfStatus 只有状态和用量，没有 Token 也没有 Turn Token ID', async () => {
  await boot();
  const status = await invoke('turn:cfStatus');
  assert.deepEqual(Object.keys(status).sort(), ['configured', 'expiresAt', 'lastError', 'usage']);
  assert.equal(status.configured, false);
  assert.equal(status.usage.limitGB, 900);
});

test('turn:cfCredentials：没配置就带着代码报错（IPC 只带 message，代码写在开头）；参数有上限', async () => {
  await boot();
  await assert.rejects(invoke('turn:cfCredentials'), /^Error: \[CF_NOT_CONFIGURED\]/);
  await assert.rejects(invoke('turn:cfCredentials', { minValidMs: 2 * 60 * 60 * 1000 }), /\[CF_NOT_CONFIGURED\]/);
  await assert.rejects(invoke('turn:cfCredentials', { minValidMs: 24 * 60 * 60 * 1000 }), /无效的 TURN 参数/, '给太大等于每次都绕过缓存去刷 Cloudflare');
  await assert.rejects(invoke('turn:cfCredentials', { minValidMs: -1 }), /无效的 TURN 参数/);
  await assert.rejects(invoke('turn:cfCredentials', [1]), /无效的 TURN 参数/);
});

test('turn:cfReportUsage / turn:cfSetLimit：校验参数，用量按月累加、上限 1–1000', async () => {
  await boot();
  for (const bad of [-1, 1.5, 65e9, '100', null]) await assert.rejects(invoke('turn:cfReportUsage', bad), /无效的 TURN 用量/, String(bad));
  const first = await invoke('turn:cfReportUsage', 1_000_000);
  const second = await invoke('turn:cfReportUsage', 2_000_000);
  assert.equal(second.usedBytes - first.usedBytes, 2_000_000);
  for (const bad of [0, 1001, 2.5, '10']) await assert.rejects(invoke('turn:cfSetLimit', bad), /无效的 TURN 用量上限/, String(bad));
  const set = await invoke('turn:cfSetLimit', 123);
  assert.equal(set.limitGB, 123);
  assert.equal((await invoke('turn:cfStatus')).usage.limitGB, 123);
  const saved = JSON.parse(fs.readFileSync(path.join(paths.userData, 'cloudflare-turn-usage.json'), 'utf8'));
  assert.equal(saved.limitGB, 123);
});

test('Cloudflare TURN 的处理器同样只认主窗口', async () => {
  await boot();
  const fn = handlers.get('turn:cfStatus');
  await assert.rejects(fn({ sender: {}, senderFrame: { url: 'https://evil.example/' } }), /不受信任/);
});

test('preload：window.sw.turn 只有「交进去」和「要临时账号」，没有读回 Token 的路', async () => {
  require('../src/main/preload.js');
  assert.ok(exposed && exposed.turn, 'preload 没暴露 window.sw.turn');
  assert.deepEqual(Object.keys(exposed.turn).sort(), ['cfClear', 'cfCredentials', 'cfReportUsage', 'cfSave', 'cfSetLimit', 'cfStatus']);
  await exposed.turn.cfSave('abcdefgh12', 'x'.repeat(20));
  assert.deepEqual(preloadInvokes.at(-1), ['turn:cfSave', { keyId: 'abcdefgh12', apiToken: 'x'.repeat(20) }]);
  await exposed.turn.cfCredentials({ minValidMs: 5 });
  assert.deepEqual(preloadInvokes.at(-1), ['turn:cfCredentials', { minValidMs: 5 }]);
  await exposed.turn.cfReportUsage(42);
  assert.deepEqual(preloadInvokes.at(-1), ['turn:cfReportUsage', 42]);
  await exposed.turn.cfSetLimit(900);
  assert.deepEqual(preloadInvokes.at(-1), ['turn:cfSetLimit', 900]);
});
