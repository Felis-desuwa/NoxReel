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

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, screen, globalShortcut } = require('electron');
const fsp = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');

// 开发期多开：第二个实例换一个数据目录，才能绕开单实例锁、各用各的配置。
// 必须赶在下面任何 app.getPath() 之前；打包后的版本不认这个变量。
const DEV_USER_DATA = !app.isPackaged ? process.env.NOXREEL_USER_DATA || '' : '';
if (DEV_USER_DATA) {
  if (!path.isAbsolute(DEV_USER_DATA)) throw new Error('NOXREEL_USER_DATA 必须是绝对路径');
  app.setPath('userData', DEV_USER_DATA);
}

const store = require('./fileStore');
const media = require('./media');
const linkMedia = require('./linkMedia');
const browserMediaResolver = require('./browserMediaResolver');
const geo = require('./geo');
const uplink = require('./uplink');
const { findMpv } = require('./mpv');
const { PlayerManager } = require('./players');
const { discoverPlayers, isAllowedExe, kindOfExe } = require('./players/discover');
const { findBridge, sharedBridge, closeSharedBridge, BRIDGE_MISSING_MESSAGE } = require('./players/bridge');
const { OverlayController } = require('./overlay');
const validate = require('./security');
const { CacheManager, cleanupLegacySidecars } = require('./cacheManager');
const settings = require('./settings');
const malwareScan = require('./malwareScan');
const { validateManifestName } = require('./mediaGuard');

let win = null;
// 同一时刻只有一个播放器；换播放器或重开时旧的先彻底退掉，迟到的事件按代丢弃
const players = new PlayerManager({
  send: (channel, payload) => send(channel, payload),
  // 外部播放器没有常驻覆盖层，弹幕画在覆盖窗上。坐标连同渲染进程的虚拟画布尺寸一起送过去，
  // 由覆盖窗按自己的真实客户区缩放 —— 只有它知道播放器现在多大。
  danmakuSink: (frame) => overlay.frame({ items: frame.items || [], w: frame.w, h: frame.h }),
});
// 自动化测试专用：播放器一律静音。打包后的版本不认这个变量。
const TEST_MUTE = !app.isPackaged && process.env.NOXREEL_TEST_MUTE === '1';
// 端到端测试钩子，只在开发期显式打开时生效：
//  - NOXREEL_DEV_PICK：选片对话框依次返回这些条目（用 | 分隔），不弹窗；
//    一个条目里可以用 * 分隔多个路径，给多选对话框用（单选只取第一个）；
//  - NOXREEL_DEV_UPLINK_BPS：上行测速直接返回这个数，不往外网发字节；
//  - 渲染进程据 env:status 的 devHooks 把房间状态挂到 window 上，供 CDP 读取。
const DEV_HOOKS = !app.isPackaged && process.env.NOXREEL_DEV_HOOKS === '1';
const devPicks = DEV_HOOKS && process.env.NOXREEL_DEV_PICK ? process.env.NOXREEL_DEV_PICK.split('|').filter(Boolean) : [];
const DEV_UPLINK_BPS = DEV_HOOKS ? Number(process.env.NOXREEL_DEV_UPLINK_BPS) || 0 : 0;

const LEGACY_DOWNLOAD_DIR = path.join(app.getPath('downloads'), 'NoxReel');
const DEFAULT_CACHE_ROOT = path.join(app.getPath('temp'), 'NoxReel');

// 缓存根目录在这里就要定下来 —— CacheManager 拿它建 run 目录，而这时候渲染进程
// 连启动都还没启动，localStorage 读不到。所以只有这一个键放在主进程侧的配置里。
const USER_DATA_DIR = app.getPath('userData');
const mainConfig = settings.read(USER_DATA_DIR);
let cacheChoice = settings.resolveCacheRoot({ config: mainConfig, defaultRoot: DEFAULT_CACHE_ROOT });
// 缓存目录换过之后，旧盘上可能还躺着没清干净的东西。不记着就再也没人回收了。
let cacheKnownRoots = settings.knownRoots(mainConfig, cacheChoice.root);
let cacheFallback = null; // 配置的目录用不了时记下原因，转给界面说明
// 选中的播放器和用户自己指定的 exe 路径。和缓存根目录一样放主进程侧：拉起播放器的是主进程，
// 而「哪个 exe 可以被启动」是一道授权，不能交给页面保管。
let playerChoice = settings.resolvePlayer(mainConfig);
let playerPaths = settings.playerPaths(mainConfig);
let cache = new CacheManager({ rootDir: cacheChoice.root, extraRoots: cacheKnownRoots });
const remuxOutputs = new Map();
// 转封装／精简正在跑的条数。产物要等任务结束才登记进 remuxOutputs，中间这段时间那张表是空的 ——
// 只看它，换缓存目录就会在 ffmpeg 正往里写的时候把 run 目录端走，转封装白做一场。
let tempJobs = 0;
// 可取消的长任务（算哈希 / 转封装 / 精简）：taskId -> AbortController，见 runTask()
const tasks = new Map();
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
  // 右栏放下了播放列表和聊天，默认开大一点；小屏上不超过工作区
  const area = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.max(900, Math.min(1280, area.width)),
    height: Math.max(640, Math.min(820, area.height)),
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
      // 播放器全屏时本窗口常年在后台。节流会把 250ms 的定时器拖到 1 秒以上：
      // 同步引擎的回声窗口、传输调度、弹幕刷新都跟着变慢。
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(MAIN_PAGE);

  win.webContents.on('will-navigate', (event, url) => {
    if (url !== MAIN_PAGE_URL) event.preventDefault();
  });

  // 页面重新加载（离开房间、换语言、启动失败后重试）或者渲染进程崩掉之后，它手里的
  // 会话 id、任务 id、临时产物路径就全部作废了 —— media:releaseTemp、store:close
  // 这些收尾的 IPC 再也不会发出来。主进程不自己收，几十 GB 的转封装产物要留到退出软件，
  // 期间「换缓存目录」还会一直被「还有临时文件没回收」挡住。
  win.webContents.on('did-start-navigation', (...args) => {
    const nav = navigationInfo(args);
    if (!nav.isMainFrame || nav.isSameDocument) return;
    // 首次加载不算刷新：那时什么都还没有，收也是白收，但别把正常启动写成一次回收。
    if (!rendererLoaded) {
      rendererLoaded = true;
      return;
    }
    reclaimAfterRendererGone();
  });
  win.webContents.on('render-process-gone', () => reclaimAfterRendererGone());
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

  // 主窗口是这个软件唯一的界面，它一关就该退出。
  // 这一句不能省，也不能指望 window-all-closed 兜底：覆盖窗（弹幕层）只 hide 不 destroy，
  // 用过一次外部播放器之后它就一直活着，「所有窗口都关了」这件事永远不会发生 ——
  // 于是 before-quit 里那一套收尾一行都不跑：PotPlayer 继续带着声音放、桥接程序不退、
  // 全局快捷键不注销、会话不关、这一场的缓存也不删。
  win.on('closed', () => {
    win = null;
    overlay.destroy();
    app.quit();
  });

  // 外链一律走系统浏览器，不在应用里开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    const safeUrl = safeExternalUrl(url);
    if (safeUrl) setImmediate(() => shell.openExternal(safeUrl).catch(() => {}));
    return { action: 'deny' };
  });
}

/**
 * did-start-navigation 的参数形状归一。
 *
 * Electron 27 起第一个参数是带 isMainFrame / isSameDocument 的 details 对象，
 * 老形状是 (event, url, isInPlace, isMainFrame)。两种都认，免得跟着大版本改。
 */
function navigationInfo(args) {
  const details = args[0];
  if (details && typeof details === 'object' && 'isMainFrame' in details) return details;
  return { isSameDocument: Boolean(args[2]), isMainFrame: Boolean(args[3]) };
}

let rendererLoaded = false;
let reclaiming = null;

/** 渲染进程的引用整体作废时收尾。做的事和退出时的 cleanup() 一样，顺序也一样。 */
function reclaimAfterRendererGone() {
  if (reclaiming) return reclaiming;
  reclaiming = (async () => {
    for (const controller of tasks.values()) controller.abort();
    malwareScan.cancelAll();
    media.cancelAll();
    // 播放器也得退：页面没了就没人能再控制它，让它自己接着放（还带声音）说不过去。
    await players.quit().catch(() => {});
    await closeSharedBridge().catch(() => {});
    overlay.destroy();
    await store.closeAll().catch(() => {});
    await Promise.all(
      [...remuxOutputs.values()].map((ownedDir) => cache.removeOwned(ownedDir).catch(() => false))
    );
    remuxOutputs.clear();
  })().finally(() => {
    reclaiming = null;
  });
  return reclaiming;
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* ---------------------------- 外部播放器接线 ---------------------------- */

/**
 * 覆盖窗。外部播放器是独立进程，画不了弹幕也挂不住常驻横幅，这扇透明窗口贴在它上面代劳。
 * 只有外部播放器在跑时才有内容：mpv 自己有 osd-overlay，走不到这里。
 */
const overlay = new OverlayController({ focusPlayer: () => focusExternalPlayer() });
overlay.attachIpc(ipcMain);

/** 桥接程序最近一次推来的播放器窗口状态。抢回前台、核对 Z 序都要它的 hwnd。 */
let playerWindow = null;
/** 播放器内那个输入条的提示语，由渲染进程随启动参数给（主进程不做 i18n）。 */
let playerChatPrompt = '';
/** 弹幕快捷键。Ctrl+Enter 被 PotPlayer 和 MPC-BE 都占了（P0 实测），统一改成这个。 */
const CHAT_HOTKEY = 'Control+Shift+D';
let hotkeyOn = false;
let hotkeyWarned = false;

// 窗口状态直接进覆盖窗，不绕渲染进程一圈：每次挪动都多跑两趟 IPC 不说，
// 渲染进程拿到 hwnd 也无事可做。
players.on('window', (state) => {
  playerWindow = state;
  overlay.update(state);
  // 全局快捷键只在播放器位于前台时占着，别人在别的程序里按 Ctrl+Shift+D 不该被我们吃掉
  setChatHotkey(Boolean(state && state.alive && state.foreground));
});
players.on('banner', ({ text }) => overlay.frame({ banner: text }));
players.on('gone', () => {
  setChatHotkey(false);
  playerWindow = null;
  overlay.setEnabled(false);
  overlay.frame({ clear: true, banner: '' });
  overlay.detach();
});
// 覆盖窗输入条里发的弹幕：交回适配器转出来，和 mpv 自带输入框共用一条路（含代际过滤）
overlay.on('chat', ({ text }) => players.deliverChatInput({ text }));
overlay.on('notice', ({ code }) => send('player:notice', { code }));
overlay.on('chat-closed', () => setChatHotkey(Boolean(playerWindow && playerWindow.foreground)));

/** 输入条关掉之后把前台还给播放器 —— 不还的话用户得自己点一下才能接着按空格。 */
function focusExternalPlayer() {
  const hwnd = playerWindow && playerWindow.alive ? playerWindow.hwnd : 0;
  if (!hwnd) return;
  sharedBridge()
    .call('foreground', { hwnd }, { timeoutMs: 1000 })
    .catch(() => {});
}

/** 注册／注销弹幕快捷键。注册失败（被别的程序占了）只提示一次，不反复刷屏。 */
function setChatHotkey(want) {
  if (!globalShortcut || want === hotkeyOn) return;
  try {
    if (!want) {
      globalShortcut.unregister(CHAT_HOTKEY);
      hotkeyOn = false;
      return;
    }
    hotkeyOn = globalShortcut.register(CHAT_HOTKEY, () => openPlayerChat());
    if (!hotkeyOn && !hotkeyWarned) {
      hotkeyWarned = true;
      send('player:notice', { code: 'hotkey-taken' });
    }
  } catch {
    hotkeyOn = false;
  }
}

/** 弹出覆盖窗的输入条。独占全屏下覆盖窗根本看不见，这时候不弹，只告诉用户一声。 */
function openPlayerChat() {
  if (overlay.openChat({ prompt: playerChatPrompt })) return;
  send('player:notice', { code: 'chat-unavailable' });
}

const PLAYER_NAMES = { mpv: 'mpv', pot: 'PotPlayer', mpc: 'MPC-BE' };

/**
 * 每个播放器现在能不能用，不能用是为什么。
 *
 * 原因只给代号，文字由渲染进程按界面语言生成 —— 主进程一个字的界面文案都不该有。
 * 代号：windows-only（外部播放器只在 Windows 上有）、not-found（本机没装／路径不对）、
 * bridge-missing（桥接程序没构建，遥控无从谈起）。
 */
async function listPlayers() {
  const bridgePath = findBridge();
  const found = await discoverPlayers({ overrides: playerPaths });
  const mpvPath = findMpv();
  const list = [
    {
      id: 'mpv',
      name: PLAYER_NAMES.mpv,
      path: mpvPath || null,
      source: mpvPath ? 'bundled' : 'none',
      available: Boolean(mpvPath),
      reason: mpvPath ? '' : 'not-found',
    },
  ];
  for (const id of ['pot', 'mpc']) {
    const info = found[id] || { name: PLAYER_NAMES[id], path: null, source: 'none' };
    let reason = '';
    if (process.platform !== 'win32') reason = 'windows-only';
    else if (!info.path) reason = 'not-found';
    else if (!bridgePath) reason = 'bridge-missing';
    list.push({
      id,
      name: info.name || PLAYER_NAMES[id],
      path: info.path || null,
      source: info.source || 'none',
      available: !reason,
      reason,
    });
  }
  return { players: list, selected: playerChoice, bridge: Boolean(bridgePath), bridgeHint: BRIDGE_MISSING_MESSAGE };
}

/**
 * 把播放器错误的代号写进 message 的开头。
 *
 * Electron 的 IPC 只把 message 带给渲染进程，自定义属性（err.code）到不了对面 ——
 * 不带着走的话，渲染进程只能回去嗅 message 里有没有「mpv」这种字样，而那个判断
 * 在有三个播放器之后必然出错（Electron 还会给所有 invoke 错误加一层前缀）。
 */
function withPlayerCode(error) {
  if (!error || !error.code) return error;
  const text = String(error.message || '');
  if (text.startsWith('[')) return error;
  const tagged = new Error(`[${error.code}] ${text}`);
  tagged.code = error.code;
  return tagged;
}

/** 这一代外部播放器用哪个 exe。找不到就交空串，由适配器抛带 code 的 PLAYER_NOT_FOUND。 */
async function externalPlayerExe(kind) {
  const found = await discoverPlayers({ overrides: playerPaths });
  return (found[kind] && found[kind].path) || '';
}

/**
 * 把缓存目录准备好，用不了就退回系统临时目录。
 *
 * 用户指定的目录可能是移动硬盘、可能是网盘，开机时不一定在。这种情况绝不能让
 * 软件卡死在启动页上 —— 退回默认目录照常能用，只是这一场的缓存不在他想要的盘上，
 * 把原因记下来交给界面说明就够了。
 */
async function ensureCacheReady() {
  try {
    return await cache.initialize();
  } catch (error) {
    if (cache.rootDir === DEFAULT_CACHE_ROOT) throw error;
    cacheFallback = { configured: cache.rootDir, reason: error.message || String(error) };
    cacheChoice = { root: DEFAULT_CACHE_ROOT, source: 'default' };
    cache = new CacheManager({ rootDir: DEFAULT_CACHE_ROOT, extraRoots: cacheKnownRoots });
    store.configureCache(cache);
    return cache.initialize();
  }
}

app.whenReady().then(async () => {
  // 多开的测试实例不去改系统的 noxreel:// 协议关联
  if (!DEV_USER_DATA) {
    if (process.defaultApp && process.argv[1]) {
      app.setAsDefaultProtocolClient('noxreel', process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient('noxreel');
    }
  }
  await ensureCacheReady();
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
    // 还在算哈希的任务也一起停掉，别在退出途中继续读整部片
    for (const controller of tasks.values()) controller.abort();
    // 转封装／精简的 ffmpeg 也要收，否则它会变成孤儿进程继续满速写盘，
    // 而且持着输出文件的句柄让 cleanupRun() 当次删不掉缓存目录。
    media.cancelAll();
    // 顺序是定死的：外部播放器先退干净（它还攥着缓存文件），再关桥接程序（关了就发不出
    // WM_CLOSE 了），然后销毁覆盖窗，最后才关会话删缓存。
    await players.quit().catch(() => {});
    await closeSharedBridge().catch(() => {});
    overlay.destroy();
    if (globalShortcut) {
      try {
        globalShortcut.unregisterAll();
      } catch {
        /* 还没 ready 就退出 */
      }
    }
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
    cacheDir: cache.rootDir,
    cacheSource: cacheChoice.source,
    cacheFallback,
    platform: process.platform,
    version: app.getVersion(),
    defender: malwareScan.findDefender(),
    // 光有 MpCmdRun.exe 不代表它能扫 —— 被第三方杀软接管停用时文件照样在。
    // true/false/null（问不出来），安全模式靠它提前把话说清楚。
    defenderRunning: await malwareScan.isDefenderRunning().catch(() => null),
    devHooks: DEV_HOOKS,
  };
});

secureHandle('geo:check', async (opts) => {
  const value = opts === undefined ? {} : validate.plainObject(opts, '地区检测参数');
  if (value.force !== undefined && typeof value.force !== 'boolean') throw new TypeError('无效的强制检测参数');
  return geo.check({ force: value.force === true });
});

// 房主选片时预估上行带宽，用来判断「这个码率会不会让成员卡」。只发随机字节，结果缓存 10 分钟。
secureHandle('net:estimateUplink', async (opts) => {
  const value = opts === undefined ? {} : validate.plainObject(opts, '测速参数');
  if (value.force !== undefined && typeof value.force !== 'boolean') throw new TypeError('无效的强制测速参数');
  if (DEV_UPLINK_BPS > 0) return { ok: true, bytesPerSec: DEV_UPLINK_BPS, measuredAt: Date.now(), cached: false };
  return uplink.estimate({ force: value.force === true });
});

/* --------------------------------- 文件相关 -------------------------------- */

const VIDEO_FILTERS = [{ name: '视频', extensions: ['mp4', 'm4v', 'mov', 'mkv'] }];

/** 取出一个开发钩子条目，按 * 拆成路径列表。 */
function takeDevPick() {
  return devPicks.shift().split('*').filter(Boolean);
}

/**
 * 多选时逐个批准：某一个不合格（名字不安全、不是文件、读不到……）只跳过它，
 * 不连累整批。经符号链接指到同一个文件的只留一份。
 */
async function approveSources(filePaths) {
  const approved = [];
  const seen = new Set();
  for (const filePath of filePaths) {
    try {
      const realPath = await approveSource(filePath);
      if (seen.has(pathKey(realPath))) continue;
      seen.add(pathKey(realPath));
      approved.push(realPath);
    } catch {}
  }
  return approved;
}

secureHandle('dialog:pickVideo', async () => {
  if (devPicks.length) return approveSource(takeDevPick()[0]);
  const r = await dialog.showOpenDialog(win, {
    title: '选择要一起看的视频',
    properties: ['openFile'],
    filters: VIDEO_FILTERS,
  });
  return r.canceled ? null : approveSource(r.filePaths[0]);
});

// 播放列表一次加好几部片。取消返回空数组，渲染进程不必区分 null。
secureHandle('dialog:pickVideos', async () => {
  if (devPicks.length) return approveSources(takeDevPick());
  const r = await dialog.showOpenDialog(win, {
    title: '选择要一起看的视频',
    properties: ['openFile', 'multiSelections'],
    filters: VIDEO_FILTERS,
  });
  return r.canceled ? [] : approveSources(r.filePaths);
});

secureHandle('dialog:approveDroppedVideo', async (filePath) => approveSource(filePath));

/**
 * 长任务的参数兼容两种形态：老调用直接传路径字符串，新调用传 { filePath, taskId }。
 * 路径在这里不校验，交给任务体里的 requireAllowedLocalPath。
 */
function taskPayload(payload, label) {
  if (typeof payload === 'string') return { filePath: payload, taskId: null };
  const { filePath, taskId } = validate.plainObject(payload, label);
  return { filePath, taskId: validate.taskId(taskId) };
}

/**
 * 跑一个可取消的长任务。登记必须在 handler 的第一个 await 之前同步完成 ——
 * 渲染进程发起任务后紧接着点「取消」，task:cancel 要能找到它。
 * 没带 taskId 的老调用照常跑，只是取消不了。
 */
async function runTask(taskId, work) {
  if (!taskId) return work(undefined);
  if (tasks.has(taskId)) throw new Error('同一任务已在进行中');
  const controller = new AbortController();
  tasks.set(taskId, controller);
  try {
    return await work(controller.signal);
  } finally {
    tasks.delete(taskId);
  }
}

secureHandle('task:cancel', async (taskId) => {
  const id = validate.taskId(taskId);
  const controller = id ? tasks.get(id) : null;
  if (!controller) return false;
  controller.abort();
  return true;
});

/**
 * ffprobe 偶尔会报出离谱的时长：超过 24 小时的录像，或者时间戳写坏的 MKV。
 * 渲染进程会把它原样写进清单的 durationSec，而清单校验的上限就是 24 小时 ——
 * 于是这部片在算完整部哈希之后才被 store:openSeed 拒掉，怎么重试都进不了房间。
 * 时长只是诊断字段（缺了只是起播前算不出码率，接收端本来就按 0 降级），
 * 越界就当没探到，别让它进协议。清单校验那一侧保持原样：对端发来的照样严格拒收。
 */
function withUsableDuration(info) {
  const seconds = info?.probe?.duration;
  if (typeof seconds !== 'number') return info;
  if (Number.isFinite(seconds) && seconds >= 0 && seconds <= validate.MAX_DURATION_SEC) return info;
  return { ...info, probe: { ...info.probe, duration: 0 } };
}

secureHandle('media:inspect', async (filePath) =>
  withUsableDuration(await media.inspect(await requireAllowedLocalPath(filePath)))
);

secureHandle('media:remux', async (payload) => {
  const { filePath, taskId } = taskPayload(payload, '转封装参数');
  tempJobs++;
  try {
    return await runTask(taskId, async (signal) => {
      const source = await requireAllowedLocalPath(filePath);
      const ownedDir = await cache.createOwnedDir('remux');
      try {
        const { outPath } = await media.remux(source, ownedDir, {
          onProgress: (p) => send('media:remuxProgress', { progress: p, taskId }),
          signal,
        });
        remuxOutputs.set(outPath, ownedDir);
        return { outPath };
      } catch (error) {
        // 取消也走这里：ffmpeg 已经退出，半截产物连目录一起删
        await cache.removeOwned(ownedDir).catch(() => {});
        throw error;
      }
    });
  } finally {
    tempJobs--;
  }
});

// 精简产物和转封装产物走同一套生命周期：写进 remuxOutputs，之后由 media:releaseTemp
// 回收，或者被 store:openSeed 接管成会话自有目录。别再开第二张表。
secureHandle('media:slim', async (payload) => {
  const { filePath, keepIndexes, toFlac, taskId: rawTaskId } = validate.plainObject(payload, '精简参数');
  const opts = validate.slimOptions({ keepIndexes, toFlac });
  const taskId = validate.taskId(rawTaskId);
  tempJobs++;
  try {
    return await runTask(taskId, async (signal) => {
      const source = await requireAllowedLocalPath(filePath);
      const ownedDir = await cache.createOwnedDir('slim');
      try {
        const { outPath, plan, inputSize, outputSize } = await media.slim(source, ownedDir, {
          keepIndexes: opts.keepIndexes,
          toFlac: opts.toFlac,
          onProgress: (p) => send('media:slimProgress', { progress: p, taskId }),
          signal,
        });
        remuxOutputs.set(outPath, ownedDir);
        return { outPath, plan, inputSize, outputSize };
      } catch (error) {
        await cache.removeOwned(ownedDir).catch(() => {});
        throw error;
      }
    });
  } finally {
    tempJobs--;
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

secureHandle('store:buildManifest', async (payload) => {
  const { filePath, taskId } = taskPayload(payload, '校验参数');
  return runTask(taskId, async (signal) =>
    store.buildManifest(
      await requireAllowedLocalPath(filePath),
      (p) => send('store:hashProgress', { ...p, taskId }),
      { signal }
    )
  );
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

// 只校验不开会话：房主收下管理员的片之前先过一遍，别让坏清单进列表。
secureHandle('store:validateManifest', async (manifest) => {
  validate.manifest(manifest);
  return true;
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

secureHandle('store:scanReceivedMedia', async (sessionId) => {
  const id = validate.sessionId(sessionId);
  const filePath = await store.scanTarget(id);
  if (!cache.owns(filePath)) throw new Error('拒绝扫描不属于当前会话的文件');
  // 超时按文件大小放缩，几十 GB 的片子不该套用 10GB 时代的那个固定 15 分钟。
  return malwareScan.scanFile(filePath, { size: store.state(id).size, tag: id });
});

// 不带会话 id 就停掉全部（用户点「停止扫描」）；带了就只停那一个（换片、关会话）。
secureHandle('store:cancelScan', async (sessionId) => {
  if (sessionId === undefined || sessionId === null) {
    malwareScan.cancelAll();
    return true;
  }
  return malwareScan.cancel(validate.sessionId(sessionId));
});

secureHandle('store:close', async (sessionId) => {
  const id = validate.sessionId(sessionId);
  // 扫描进程还攥着文件的话，删缓存会失败 —— 先停掉它、等它退出
  await malwareScan.cancel(id).catch(() => {});
  return store.close(id);
});

secureHandle('store:reveal', async (filePath) => {
  shell.showItemInFolder(await requireAllowedLocalPath(filePath));
});

/* --------------------------------- 播放器 --------------------------------- */

secureHandle('player:launch', async (payload) => {
  // 必须在第一个 await 之前当场领号：下面的校验要等 realpath / DNS，先发的请求可能后校验完。
  // 号码按请求到达的先后排，过期的启动由 PlayerManager 拒掉，不会覆盖后来者拉起的播放器。
  const ticket = players.reserve();
  const { filePath, startPaused, headers, startAt = 0, chatPrompt = '', kind = 'mpv' } = validate.plainObject(payload, '播放器启动参数');
  // 只认登记过的 id：这个字符串最终会变成 new ADAPTERS[kind]()
  const want = validate.playerId(kind, players.kinds);
  const source = /^https?:\/\//i.test(filePath)
    ? await validate.publicHttpUrl(filePath, '媒体链接')
    : await requireAllowedLocalPath(filePath);
  const safeHeaders = /^https?:\/\//i.test(source) ? validate.mediaHeaders(headers) : {};
  if (typeof startPaused !== 'boolean') throw new TypeError('无效的暂停参数');
  const start = validate.finiteNumber(startAt, '起播位置', { min: 0, max: 10 ** 9 });
  // 播放器内那个弹幕输入框的提示语。主进程不做 i18n，文案由渲染进程按界面语言生成，
  // 这里只把它交给 mpv 的 --script-opt。空串就用 Lua 脚本自带的默认值。
  const prompt = chatPrompt === '' ? '' : validate.scriptOptValue(chatPrompt, '弹幕输入提示');
  playerChatPrompt = prompt;
  try {
    if (want !== 'mpv') {
      // 外部播放器：exe 只能由主进程从探测结果或用户在对话框里挑的路径里取，渲染进程碰不到它。
      // 这一路**不传 muted** —— PotPlayer 和 MPC-BE 的音量、静音都会写进注册表，
      // 代我们改了就再也回不来（P0 实测），测试静音只能由跑测试的人自己负责。
      const exePath = await externalPlayerExe(want);
      const info = await players.launch(want, { source, startPaused, startAt: start, headers: safeHeaders, chatPrompt: prompt, exePath }, ticket);
      overlay.setEnabled(true);
      return info;
    }
    // PlayerManager 会先摘掉旧播放器的监听器、等它退干净，再拉起新的。
    return await players.launch('mpv', { source, startPaused, startAt: start, headers: safeHeaders, muted: TEST_MUTE, chatPrompt: prompt }, ticket);
  } catch (error) {
    throw withPlayerCode(error);
  }
});

secureHandle('player:setPause', async (paused) => {
  if (typeof paused !== 'boolean') throw new TypeError('无效的暂停参数');
  return players.setPause(paused);
});

secureHandle('player:seek', async (seconds) => {
  return players.seek(validate.finiteNumber(seconds, '播放位置', { min: 0, max: 10 ** 9 }));
});

secureHandle('player:osd', async (payload) => {
  const { text, duration } = validate.plainObject(payload, '播放器提示参数');
  return players.osd(
    validate.string(text, '提示文本', { max: 1000, allowEmpty: true }),
    validate.integer(duration, '提示时长', { min: 0, max: 60_000 })
  );
});

// 常驻横幅。全屏看片时 Electron 窗口整个看不见，这是把房间状态送到用户眼前的唯一通道。
// 层 id 不让渲染进程自己定，由各播放器适配器固定占房间状态那一层。
secureHandle('player:overlay', async (payload) => {
  const { text } = validate.plainObject(payload, '覆盖层参数');
  return players.setBanner(validate.string(text, '覆盖层文本', { max: 400, allowEmpty: true }));
});

// 一帧弹幕。每秒 30 帧，所以这条路上不许有任何等待：校验是纯本地判断，主进程也不排队 ——
// 上一帧还在途就直接丢掉这一帧（返回 false）。宁可丢帧，也不能让弹幕把暂停命令堵在后面。
secureHandle('player:setDanmakuFrame', async (frame) => players.setDanmakuFrame(validate.danmakuFrame(frame)));

secureHandle('player:snapshot', async () => players.snapshot());

secureHandle('player:quit', async (gen) => {
  await players.quit(gen === undefined || gen === null ? undefined : validate.integer(gen, '播放器代号', { min: 1 }));
});

secureHandle('player:list', async () => listPlayers());

// 选哪个播放器。存进主进程侧的配置：下次开软件、下一部片都照这个来。
secureHandle('player:select', async (id) => {
  playerChoice = validate.playerId(id, players.kinds);
  await settings.write(USER_DATA_DIR, { player: playerChoice });
  return listPlayers();
});

/**
 * 用户自己指定播放器的 exe。
 *
 * 对话框由主进程弹、路径由主进程收，渲染进程从头到尾碰不到这个字符串 ——
 * 否则「让用户挑一个 exe」就等于「渲染进程可以指定要启动哪个程序」。
 * 挑回来的还要过白名单：文件名必须是登记在册的那几个，而且得对得上是哪个播放器。
 */
secureHandle('player:pickExe', async (id) => {
  const want = validate.playerId(id, players.kinds);
  if (want === 'mpv') throw new Error('mpv 随安装包附带，不用指定路径');
  const picked = await dialog.showOpenDialog(win, {
    title: `选择 ${PLAYER_NAMES[want] || want} 的可执行文件`,
    properties: ['openFile'],
    filters: [{ name: PLAYER_NAMES[want] || want, extensions: ['exe'] }],
  });
  if (picked.canceled || !picked.filePaths || !picked.filePaths[0]) return listPlayers();
  const target = validate.absolutePath(picked.filePaths[0], '播放器路径');
  if (!isAllowedExe(target) || kindOfExe(target) !== want) throw new Error('这不是受支持的播放器程序');
  playerPaths = { ...playerPaths, [want]: target };
  await settings.write(USER_DATA_DIR, { playerPaths });
  return listPlayers();
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
  const runDir = await ensureCacheReady();
  return { cacheDir: cache.rootDir, runDir, fallback: cacheFallback };
});

secureHandle('cache:usage', async () => cache.usage());

secureHandle('cache:purge', async () => ({ removed: await cache.purgeStale() }));

secureHandle('dialog:pickCacheDir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择缓存目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

/**
 * 换缓存目录。
 *
 * 有会话在跑时一律拒绝，而且这道闸必须长在主进程里，不能只靠界面把按钮禁掉：
 * cache.owns() 是一道授权检查（store:readChunk、扫描、reveal 全靠它），
 * 中途换掉 runDir，当前会话的文件立刻变成「不属于本实例」，读片和扫描会
 * 一起报一个看起来像安全问题的错。
 */
secureHandle('settings:setCacheRoot', async (payload) => {
  const { dir } = validate.plainObject(payload, '缓存目录参数');
  if (store.hasOpenSessions()) throw new Error('正在放映时不能换缓存目录，退出房间后再改');
  if (tempJobs) throw new Error('正在转封装或精简，完成后再换缓存目录');
  if (remuxOutputs.size) throw new Error('还有临时文件没回收，退出房间后再改');
  const target = validate.absolutePath(dir, '缓存目录');
  // 先试着真的写一下。指到一个只读目录或者没插的盘上，得当场知道。
  await fsp.mkdir(target, { recursive: true });
  const probe = path.join(target, `.noxreel-write-test-${process.pid}`);
  await fsp.writeFile(probe, 'ok');
  await fsp.rm(probe, { force: true });

  await cache.cleanupRun().catch(() => {});
  cacheKnownRoots = settings.knownRoots({ knownRoots: cacheKnownRoots }, target);
  await settings.write(USER_DATA_DIR, { cacheRoot: target, knownRoots: cacheKnownRoots });
  cacheChoice = { root: target, source: 'config' };
  cacheFallback = null;
  cache = new CacheManager({ rootDir: target, extraRoots: cacheKnownRoots });
  store.configureCache(cache);
  await cache.initialize();
  return { cacheDir: cache.rootDir };
});

secureHandle('clipboard:writeText', async (text) => {
  clipboard.writeText(validate.string(String(text ?? ''), '剪贴板文本', { max: 2 * 1024 * 1024, allowEmpty: true }));
});
