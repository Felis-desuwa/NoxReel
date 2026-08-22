'use strict';

/**
 * Electron 主进程。
 *
 * 职责划分：
 *  - 主进程：文件 IO、mpv 进程与管道、FFmpeg、地区校验。凡是需要 Node 能力的都在这。
 *  - 渲染进程：WebRTC（Chromium 自带完整实现，不用接原生库）、调度、同步、UI。
 *
 * 分片数据的流向：
 *  做种方  磁盘 →(IPC)→ 渲染进程 → DataChannel
 *  接收方  DataChannel → 渲染进程 →(IPC)→ 磁盘
 * 2MB 的 Buffer 走 IPC 是结构化克隆，开销可接受，换来的是不用引 node-webrtc。
 */

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const fsp = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');

const store = require('./fileStore');
const media = require('./media');
const linkMedia = require('./linkMedia');
const geo = require('./geo');
const { MpvController, findMpv } = require('./mpv');
const validate = require('./security');
const { CacheManager, cleanupLegacySidecars } = require('./cacheManager');
const malwareScan = require('./malwareScan');
const { validateManifestName } = require('./mediaGuard');

let win = null;
/** @type {MpvController|null} */
let mpv = null;

const LEGACY_DOWNLOAD_DIR = path.join(app.getPath('downloads'), 'NoxReel');
const CACHE_ROOT = path.join(app.getPath('temp'), 'NoxReel');
const cache = new CacheManager({ rootDir: CACHE_ROOT });
const remuxOutputs = new Map();
const approvedSources = new Set();
const MAIN_PAGE = path.join(__dirname, '..', 'renderer', 'index.html');
const MAIN_PAGE_URL = pathToFileURL(MAIN_PAGE).href;

app.enableSandbox();
app.commandLine.appendSwitch('disable-http-cache');
store.configureCache(cache);

function isTrustedSender(event) {
  return Boolean(
    win &&
      !win.isDestroyed() &&
      event.sender === win.webContents &&
      event.senderFrame === win.webContents.mainFrame &&
      event.senderFrame?.url === MAIN_PAGE_URL
  );
}

function secureHandle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedSender(event)) throw new Error('已拒绝不受信任页面的请求');
    return handler(...args);
  });
}

function safeExternalUrl(raw) {
  try {
    return validate.externalUrl(raw);
  } catch {
    return null;
  }
}

const pathKey = (filePath) => path.resolve(filePath).toLowerCase();

async function approveSource(filePath) {
  const target = validate.absolutePath(filePath);
  validateManifestName(path.basename(target));
  const stat = await fsp.stat(target);
  if (!stat.isFile()) throw new Error('选择的路径不是文件');
  const realPath = await fsp.realpath(target);
  approvedSources.add(pathKey(realPath));
  return realPath;
}

async function requireAllowedLocalPath(filePath) {
  const target = validate.absolutePath(filePath);
  if (cache.owns(target)) return target;
  const realPath = await fsp.realpath(target);
  if (!approvedSources.has(pathKey(realPath))) throw new Error('文件未经用户选择，已拒绝访问');
  return realPath;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#0e1116',
    title: 'NoxReel',
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'noxreel-icon.png'),
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: {
            color: '#070c17',
            symbolColor: '#aebbd0',
            height: 48,
          },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(MAIN_PAGE);

  win.webContents.on('will-navigate', (event, url) => {
    if (url !== MAIN_PAGE_URL) event.preventDefault();
  });
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

  // 外链一律走系统浏览器，不在应用里开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    const safeUrl = safeExternalUrl(url);
    if (safeUrl) setImmediate(() => shell.openExternal(safeUrl).catch(() => {}));
    return { action: 'deny' };
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

app.whenReady().then(async () => {
  await cache.initialize();
  await cleanupLegacySidecars(LEGACY_DOWNLOAD_DIR);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let cleanupPromise = null;
let cleanupComplete = false;
let quitRequested = false;
async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    send('app:shutdownRequested');
    await delay(50);
    malwareScan.cancelAll();
    if (mpv) await mpv.quit().catch(() => {});
    mpv = null;
    await store.closeAll().catch(() => {});
    await Promise.all(
      [...remuxOutputs.values()].map((ownedDir) => cache.removeOwned(ownedDir).catch(() => false))
    );
    remuxOutputs.clear();
    await cache.cleanupRun().catch(() => false);
  })();
  return cleanupPromise;
}

app.on('before-quit', (event) => {
  if (cleanupComplete) return;
  event.preventDefault();
  if (quitRequested) return;
  quitRequested = true;
  Promise.race([cleanup(), delay(5000)]).finally(() => {
    cleanupComplete = true;
    app.quit();
  });
});

/* ---------------------------------- 环境 ---------------------------------- */

secureHandle('env:status', async () => {
  const tools = media.toolStatus();
  const linkTools = linkMedia.toolStatus();
  return {
    mpv: findMpv(),
    ffmpeg: tools.ffmpeg,
    ffprobe: tools.ffprobe,
    ytDlp: linkTools.ytDlp,
    cacheDir: CACHE_ROOT,
    platform: process.platform,
    version: app.getVersion(),
    defender: malwareScan.findDefender(),
  };
});

secureHandle('geo:check', async (opts) => {
  const value = opts === undefined ? {} : validate.plainObject(opts, '地区检测参数');
  if (value.force !== undefined && typeof value.force !== 'boolean') throw new TypeError('无效的强制检测参数');
  return geo.check({ force: value.force === true });
});

/* --------------------------------- 文件相关 -------------------------------- */

secureHandle('dialog:pickVideo', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择要一起看的视频',
    properties: ['openFile'],
    filters: [{ name: '视频', extensions: ['mp4', 'm4v', 'mov', 'mkv'] }],
  });
  return r.canceled ? null : approveSource(r.filePaths[0]);
});

secureHandle('dialog:approveDroppedVideo', async (filePath) => approveSource(filePath));

secureHandle('media:inspect', async (filePath) => media.inspect(await requireAllowedLocalPath(filePath)));

secureHandle('media:remux', async (filePath) => {
  const ownedDir = await cache.createOwnedDir('remux');
  try {
    const { outPath } = await media.remux(await requireAllowedLocalPath(filePath), ownedDir, {
      onProgress: (p) => send('media:remuxProgress', { progress: p }),
    });
    remuxOutputs.set(outPath, ownedDir);
    return { outPath };
  } catch (error) {
    await cache.removeOwned(ownedDir).catch(() => {});
    throw error;
  }
});

secureHandle('media:releaseTemp', async (filePath) => {
  const target = validate.absolutePath(filePath, '临时媒体路径');
  const ownedDir = remuxOutputs.get(target);
  if (!ownedDir) return false;
  remuxOutputs.delete(target);
  return cache.removeOwned(ownedDir);
});

secureHandle('media:inspectLink', async (url) => linkMedia.inspectLink(await validate.publicHttpUrl(url, '视频链接')));

secureHandle('store:buildManifest', async (filePath) => {
  return store.buildManifest(await requireAllowedLocalPath(filePath), (p) => send('store:hashProgress', p));
});

secureHandle('store:openSeed', async (payload) => {
  const { manifest, filePath } = validate.plainObject(payload, '做种参数');
  const sourcePath = await requireAllowedLocalPath(filePath);
  const ownedDir = remuxOutputs.get(sourcePath) || null;
  const state = await store.openSeed(validate.manifest(manifest), sourcePath, { ownedDir });
  if (ownedDir) remuxOutputs.delete(sourcePath);
  return state;
});

secureHandle('store:openLeech', async (manifest) => store.openLeech(validate.manifest(manifest)));

secureHandle('store:readChunk', async (payload) => {
  const { sessionId, index } = validate.plainObject(payload, '读取分片参数');
  const buf = await store.readChunk(validate.sessionId(sessionId), validate.integer(index, '分片下标', { min: 0 }));
  // 转成 ArrayBuffer 交给渲染进程，避免 Buffer 被序列化成 {type:'Buffer',data:[...]}
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

secureHandle('store:writeChunk', async (payload) => {
  const { sessionId, index, data } = validate.plainObject(payload, '写入分片参数');
  return store.writeChunk(
    validate.sessionId(sessionId),
    validate.integer(index, '分片下标', { min: 0 }),
    Buffer.from(validate.binary(data))
  );
});

secureHandle('store:state', async (sessionId) => store.state(validate.sessionId(sessionId)));

secureHandle('store:scanReceivedMedia', async (sessionId) => {
  const filePath = await store.scanTarget(validate.sessionId(sessionId));
  if (!cache.owns(filePath)) throw new Error('拒绝扫描不属于当前会话的文件');
  return malwareScan.scanFile(filePath);
});

secureHandle('store:close', async (sessionId) => store.close(validate.sessionId(sessionId)));

secureHandle('store:reveal', async (filePath) => {
  shell.showItemInFolder(await requireAllowedLocalPath(filePath));
});

/* ---------------------------------- mpv ---------------------------------- */

secureHandle('mpv:launch', async (payload) => {
  const { filePath, startPaused, headers } = validate.plainObject(payload, '播放器启动参数');
  const source = /^https?:\/\//i.test(filePath)
    ? await validate.publicHttpUrl(filePath, '媒体链接')
    : await requireAllowedLocalPath(filePath);
  const safeHeaders = /^https?:\/\//i.test(source) ? validate.mediaHeaders(headers) : {};
  if (typeof startPaused !== 'boolean') throw new TypeError('无效的暂停参数');
  if (mpv) await mpv.quit().catch(() => {});
  mpv = new MpvController();

  mpv.on('tick', (snap) => send('mpv:tick', snap));
  mpv.on('exit', (info) => send('mpv:exit', info));
  mpv.on('error', (err) => send('mpv:error', { message: err.message }));

  return mpv.launch(source, { startPaused, headers: safeHeaders });
});

secureHandle('mpv:setPause', async (paused) => {
  if (typeof paused !== 'boolean') throw new TypeError('无效的暂停参数');
  if (!mpv) throw new Error('mpv 未启动');
  return mpv.setPause(paused);
});

secureHandle('mpv:seek', async (seconds) => {
  if (!mpv) throw new Error('mpv 未启动');
  return mpv.seek(validate.finiteNumber(seconds, '播放位置', { min: 0, max: 10 ** 9 }));
});

secureHandle('mpv:osd', async (payload) => {
  const { text, duration } = validate.plainObject(payload, '播放器提示参数');
  if (!mpv) return;
  return mpv.osd(
    validate.string(text, '提示文本', { max: 1000, allowEmpty: true }),
    validate.integer(duration, '提示时长', { min: 0, max: 60_000 })
  );
});

secureHandle('mpv:snapshot', async () => (mpv ? mpv.snapshot() : { running: false }));

secureHandle('mpv:quit', async () => {
  if (mpv) await mpv.quit();
  mpv = null;
});

/* --------------------------------- 杂项 ---------------------------------- */

secureHandle('app:openExternal', async (url) => {
  await shell.openExternal(validate.externalUrl(url));
});

secureHandle('app:ensureDirs', async () => {
  const runDir = await cache.initialize();
  return { cacheDir: CACHE_ROOT, runDir };
});

secureHandle('clipboard:writeText', async (text) => {
  clipboard.writeText(validate.string(String(text ?? ''), '剪贴板文本', { max: 2 * 1024 * 1024, allowEmpty: true }));
});
