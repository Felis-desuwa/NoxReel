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

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');

const store = require('./fileStore');
const media = require('./media');
const geo = require('./geo');
const { MpvController, findMpv } = require('./mpv');

let win = null;
/** @type {MpvController|null} */
let mpv = null;

const DOWNLOAD_DIR = path.join(app.getPath('downloads'), 'SyncWatch');
const WORK_DIR = path.join(os.tmpdir(), 'syncwatch');

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#0e1116',
    title: 'SyncWatch',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 外链一律走系统浏览器，不在应用里开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
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

ipcMain.handle('env:status', async () => {
  const tools = media.toolStatus();
  return {
    mpv: findMpv(),
    ffmpeg: tools.ffmpeg,
    ffprobe: tools.ffprobe,
    downloadDir: DOWNLOAD_DIR,
    platform: process.platform,
    version: app.getVersion(),
  };
});

ipcMain.handle('geo:check', async (_e, opts) => geo.check(opts || {}));

/* --------------------------------- 文件相关 -------------------------------- */

ipcMain.handle('dialog:pickVideo', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择要一起看的视频',
    properties: ['openFile'],
    filters: [{ name: '视频', extensions: ['mp4', 'mkv'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('media:inspect', async (_e, filePath) => media.inspect(filePath));

ipcMain.handle('media:remux', async (_e, filePath) => {
  const { outPath } = await media.remux(filePath, WORK_DIR, {
    onProgress: (p) => send('media:remuxProgress', { progress: p }),
  });
  return { outPath };
});

ipcMain.handle('store:buildManifest', async (_e, filePath) => {
  return store.buildManifest(filePath, (p) => send('store:hashProgress', p));
});

ipcMain.handle('store:openSeed', async (_e, { manifest, filePath }) => store.openSeed(manifest, filePath));

ipcMain.handle('store:openLeech', async (_e, { manifest, destDir }) =>
  store.openLeech(manifest, destDir || DOWNLOAD_DIR)
);

ipcMain.handle('store:readChunk', async (_e, { sessionId, index }) => {
  const buf = await store.readChunk(sessionId, index);
  // 转成 ArrayBuffer 交给渲染进程，避免 Buffer 被序列化成 {type:'Buffer',data:[...]}
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

ipcMain.handle('store:writeChunk', async (_e, { sessionId, index, data }) =>
  store.writeChunk(sessionId, index, Buffer.from(data))
);

ipcMain.handle('store:state', async (_e, sessionId) => store.state(sessionId));

ipcMain.handle('store:close', async (_e, sessionId) => store.close(sessionId));

ipcMain.handle('store:reveal', async (_e, filePath) => {
  shell.showItemInFolder(filePath);
});

/* ---------------------------------- mpv ---------------------------------- */

ipcMain.handle('mpv:launch', async (_e, { filePath, startPaused }) => {
  if (mpv) await mpv.quit().catch(() => {});
  mpv = new MpvController();

  mpv.on('tick', (snap) => send('mpv:tick', snap));
  mpv.on('exit', (info) => send('mpv:exit', info));
  mpv.on('error', (err) => send('mpv:error', { message: err.message }));

  return mpv.launch(filePath, { startPaused });
});

ipcMain.handle('mpv:setPause', async (_e, paused) => {
  if (!mpv) throw new Error('mpv 未启动');
  return mpv.setPause(paused);
});

ipcMain.handle('mpv:seek', async (_e, seconds) => {
  if (!mpv) throw new Error('mpv 未启动');
  return mpv.seek(seconds);
});

ipcMain.handle('mpv:osd', async (_e, { text, duration }) => {
  if (!mpv) return;
  return mpv.osd(text, duration);
});

ipcMain.handle('mpv:snapshot', async () => (mpv ? mpv.snapshot() : { running: false }));

ipcMain.handle('mpv:quit', async () => {
  if (mpv) await mpv.quit();
  mpv = null;
});

/* --------------------------------- 杂项 ---------------------------------- */

ipcMain.handle('app:openExternal', async (_e, url) => {
  if (/^https?:\/\//.test(url)) await shell.openExternal(url);
});

ipcMain.handle('app:ensureDirs', async () => {
  await fsp.mkdir(DOWNLOAD_DIR, { recursive: true });
  await fsp.mkdir(WORK_DIR, { recursive: true });
  return { downloadDir: DOWNLOAD_DIR, workDir: WORK_DIR };
});
