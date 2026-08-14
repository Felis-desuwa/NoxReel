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
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const { pathToFileURL } = require('url');

const store = require('./fileStore');
const media = require('./media');
const linkMedia = require('./linkMedia');
const geo = require('./geo');
const { MpvController, findMpv } = require('./mpv');
const validate = require('./security');

let win = null;
/** @type {MpvController|null} */
let mpv = null;

const DOWNLOAD_DIR = path.join(app.getPath('downloads'), 'NoxReel');
const WORK_DIR = path.join(os.tmpdir(), 'noxreel');
const MAIN_PAGE = path.join(__dirname, '..', 'renderer', 'index.html');
const MAIN_PAGE_URL = pathToFileURL(MAIN_PAGE).href;

app.enableSandbox();

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

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  await cleanup();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', cleanup);

let cleanedUp = false;
async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  if (mpv) await mpv.quit().catch(() => {});
  await store.closeAll().catch(() => {});
}

/* ---------------------------------- 环境 ---------------------------------- */

secureHandle('env:status', async () => {
  const tools = media.toolStatus();
  const linkTools = linkMedia.toolStatus();
  return {
    mpv: findMpv(),
    ffmpeg: tools.ffmpeg,
    ffprobe: tools.ffprobe,
    ytDlp: linkTools.ytDlp,
    downloadDir: DOWNLOAD_DIR,
    platform: process.platform,
    version: app.getVersion(),
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
    filters: [{ name: '视频', extensions: ['mp4', 'mkv'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

secureHandle('media:inspect', async (filePath) => media.inspect(validate.absolutePath(filePath)));

secureHandle('media:remux', async (filePath) => {
  const { outPath } = await media.remux(validate.absolutePath(filePath), WORK_DIR, {
    onProgress: (p) => send('media:remuxProgress', { progress: p }),
  });
  return { outPath };
});

secureHandle('media:inspectLink', async (url) => linkMedia.inspectLink(validate.httpUrl(url, '视频链接')));

secureHandle('store:buildManifest', async (filePath) => {
  return store.buildManifest(validate.absolutePath(filePath), (p) => send('store:hashProgress', p));
});

secureHandle('store:openSeed', async (payload) => {
  const { manifest, filePath } = validate.plainObject(payload, '做种参数');
  return store.openSeed(validate.manifest(manifest), validate.absolutePath(filePath));
});

secureHandle('store:openLeech', async (payload) => {
  const { manifest, destDir } = validate.plainObject(payload, '接收参数');
  const outputDir = destDir == null ? DOWNLOAD_DIR : validate.absolutePath(destDir, '下载目录');
  return store.openLeech(validate.manifest(manifest), outputDir);
});

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

secureHandle('store:close', async (sessionId) => store.close(validate.sessionId(sessionId)));

secureHandle('store:reveal', async (filePath) => {
  shell.showItemInFolder(validate.absolutePath(filePath));
});

/* ---------------------------------- mpv ---------------------------------- */

secureHandle('mpv:launch', async (payload) => {
  const { filePath, startPaused } = validate.plainObject(payload, '播放器启动参数');
  const source = /^https?:\/\//i.test(filePath)
    ? validate.httpUrl(filePath, '媒体链接')
    : validate.absolutePath(filePath, '媒体路径');
  if (typeof startPaused !== 'boolean') throw new TypeError('无效的暂停参数');
  if (mpv) await mpv.quit().catch(() => {});
  mpv = new MpvController();

  mpv.on('tick', (snap) => send('mpv:tick', snap));
  mpv.on('exit', (info) => send('mpv:exit', info));
  mpv.on('error', (err) => send('mpv:error', { message: err.message }));

  return mpv.launch(source, { startPaused });
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
  await fsp.mkdir(DOWNLOAD_DIR, { recursive: true });
  await fsp.mkdir(WORK_DIR, { recursive: true });
  return { downloadDir: DOWNLOAD_DIR, workDir: WORK_DIR };
});

secureHandle('clipboard:writeText', async (text) => {
  clipboard.writeText(validate.string(String(text ?? ''), '剪贴板文本', { max: 2 * 1024 * 1024, allowEmpty: true }));
});
