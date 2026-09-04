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
const browserMediaResolver = require('./browserMediaResolver');
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
const DEEP_LINK_SCHEME = 'noxreel:';
let pendingDeepLink = null;

app.enableSandbox();
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
store.configureCache(cache);

function normalizeDeepLink(raw) {
  if (typeof raw !== 'string' || raw.length > 256 * 1024 || !raw.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}//`)) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== DEEP_LINK_SCHEME || !['j', 'a'].includes(parsed.hostname.toLowerCase()) || !parsed.pathname.slice(1)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function deepLinkFromArgv(argv) {
  for (const arg of argv || []) {
    const link = normalizeDeepLink(arg);
    if (link) return link;
  }
  return null;
}

function dispatchDeepLink(raw) {
  const link = normalizeDeepLink(raw);
  if (!link) return;
  pendingDeepLink = link;
  if (win && !win.isDestroyed() && !win.webContents.isLoadingMainFrame()) {
    win.webContents.send('app:deepLink', link);
    pendingDeepLink = null;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
else {
  pendingDeepLink = deepLinkFromArgv(process.argv);
  app.on('second-instance', (_event, argv) => dispatchDeepLink(deepLinkFromArgv(argv)));
  app.on('open-url', (event, url) => {
    event.preventDefault();
    dispatchDeepLink(url);
  });
}

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
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient('noxreel', process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient('noxreel');
  }
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
    // 转封装／精简的 ffmpeg 也要收，否则它会变成孤儿进程继续满速写盘，
    // 而且持着输出文件的句柄让 cleanupRun() 当次删不掉缓存目录。
    media.cancelAll();
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
    // 光有 MpCmdRun.exe 不代表它能扫 —— 被第三方杀软接管停用时文件照样在。
    // true/false/null（问不出来），安全模式靠它提前把话说清楚。
    defenderRunning: await malwareScan.isDefenderRunning().catch(() => null),
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

// 精简产物和转封装产物走同一套生命周期：写进 remuxOutputs，之后由 media:releaseTemp
// 回收，或者被 store:openSeed 接管成会话自有目录。别再开第二张表。
secureHandle('media:slim', async (payload) => {
  const { filePath, keepIndexes, toFlac } = validate.plainObject(payload, '精简参数');
  const source = await requireAllowedLocalPath(filePath);
  const opts = validate.slimOptions({ keepIndexes, toFlac });
  const ownedDir = await cache.createOwnedDir('slim');
  try {
    const { outPath, plan, inputSize, outputSize } = await media.slim(source, ownedDir, {
      keepIndexes: opts.keepIndexes,
      toFlac: opts.toFlac,
      onProgress: (p) => send('media:slimProgress', { progress: p }),
    });
    remuxOutputs.set(outPath, ownedDir);
    return { outPath, plan, inputSize, outputSize };
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

secureHandle('media:inspectLink', async (url) => {
  const safeUrl = await validate.publicHttpUrl(url, '视频链接');
  const result = await linkMedia.inspectLink(safeUrl, { browserFallback: browserMediaResolver.resolveInBrowser });
  if (result.playback?.url) {
    result.playback.url = await validate.publicHttpUrl(result.playback.url, '播放地址');
    result.playback.headers = validate.mediaHeaders(result.playback.headers);
  }
  return result;
});

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
  // 先摘监听器再退，否则旧进程几百毫秒后才真的 exit（quit() 只等命令回包，
  // 不等进程落地），那条迟到的 exit 会被转发给渲染进程，把刚起来的新播放器
  // 标记成「已关闭」—— S.mpvRunning 永久停在 false，进度条拖不动、状态栏一直报错。
  if (mpv) {
    mpv.removeAllListeners();
    await mpv.quit().catch(() => {});
  }
  mpv = new MpvController();

  // 闭包捕获当前这个控制器，晚到的事件如果不是它发的就丢掉 —— 双保险，
  // 免得将来有人在别处忘了 removeAllListeners 又把这个 bug 放回来。
  const controller = mpv;
  const fromCurrent = (fn) => (arg) => {
    if (mpv === controller) fn(arg);
  };
  mpv.on('tick', fromCurrent((snap) => send('mpv:tick', snap)));
  mpv.on('exit', fromCurrent((info) => send('mpv:exit', info)));
  mpv.on('error', fromCurrent((err) => send('mpv:error', { message: err.message })));

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

secureHandle('app:takeDeepLink', async () => {
  const link = pendingDeepLink;
  pendingDeepLink = null;
  return link;
});

secureHandle('app:ensureDirs', async () => {
  const runDir = await cache.initialize();
  return { cacheDir: CACHE_ROOT, runDir };
});

secureHandle('clipboard:writeText', async (text) => {
  clipboard.writeText(validate.string(String(text ?? ''), '剪贴板文本', { max: 2 * 1024 * 1024, allowEmpty: true }));
});
