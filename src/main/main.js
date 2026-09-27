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

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, screen, globalShortcut, safeStorage } = require('electron');
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
const { describeFsError } = require('./fsErrorText');
const settings = require('./settings');
const malwareScan = require('./malwareScan');
const { validateSourceName, SOURCE_EXTENSIONS, SUBTITLE_EXTENSIONS } = require('./mediaGuard');
const subtitles = require('./subtitles');
const { DiscordPresence, sanitizeActivity } = require('./discordPresence');
const { sharedProxy, closeSharedProxy } = require('./publicProxy');
const { lockDownPermissions } = require('./permissions');
const { CloudflareTurn } = require('./cloudflareTurn');
const { MediaLibrary } = require('./mediaLibrary');
const { LinkCache, moveNoOverwrite, removeWorkDir, WORK_DIR: DOWNLOAD_WORK_DIR } = require('./linkCache');
const { DownloadSaver } = require('./downloadSaver');
const { labelProtocolHandler } = require('./protocolName');
const { displayVersion, readBuildNumber } = require('./appVersion');

let win = null;
// 启动时建窗口之前的准备跑完了（不论成败）。这之后还没有主窗口，只可能是建窗口本身出过错
let startupSettled = false;
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
//  - NOXREEL_DISCORD_PIPE：Discord 状态只连这一个管道（测试用的假 Discord），不去碰本机真的 Discord；
//  - NOXREEL_DISCORD_CLIENT_ID：临时换一个 Discord 应用 ID；
//  - NOXREEL_DEV_DOWNLOAD_DIR：默认下载位置（「边下边播」另存的地方）换到这里，不碰真的「视频」文件夹。
const DEV_DISCORD_PIPE = DEV_HOOKS ? process.env.NOXREEL_DISCORD_PIPE || null : null;
// Discord 应用 ID：公开信息，不是密钥（Discord 上显示为「正在观看 NoxReel」的那个应用）。
const DISCORD_CLIENT_ID = (DEV_HOOKS && process.env.NOXREEL_DISCORD_CLIENT_ID) || '1551684816993390722';
// 懒连接：构造时不碰管道、不起定时器，第一次有状态要显示时才去连本机 Discord
const discordPresence = new DiscordPresence({
  clientId: DISCORD_CLIENT_ID,
  pipePath: DEV_DISCORD_PIPE,
  onStatus: (status) => send('discord:status', status),
});

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
// Cloudflare TURN 的凭据和本机月用量。API Token 只在主进程里：加密落盘，从不回传给渲染进程。
// 构造时不碰磁盘也不碰 safeStorage（它要等 app ready），第一次用到时才读。
const cfTurn = new CloudflareTurn({ userDataDir: USER_DATA_DIR, safeStorage });
// 旧根（换过缓存目录留下的，可能在离线的网盘上）不在启动时扫：窗口出来之后在后台收，见 whenReady
let cache = new CacheManager({ rootDir: cacheChoice.root, extraRoots: cacheKnownRoots, deferExtraRoots: true });
// 缓存清理方式（见 fileStore.setPolicy / mediaLibrary.js）和「边下边播」的下载位置。
// 下载位置默认在「视频」文件夹下；拿不到「视频」目录（极少数精简系统、测试里的假 Electron）就放用户数据目录下
function defaultDownloadDir() {
  // 开发期测试钩子：端到端测试别往真的「视频」文件夹里写东西
  if (DEV_HOOKS && process.env.NOXREEL_DEV_DOWNLOAD_DIR) return path.resolve(process.env.NOXREEL_DEV_DOWNLOAD_DIR);
  let base = null;
  try {
    base = app.getPath('videos');
  } catch {
    /* 退回用户数据目录 */
  }
  return path.join(base || USER_DATA_DIR, 'NoxReel');
}
const DEFAULT_DOWNLOAD_DIR = defaultDownloadDir();
let cacheMode = settings.resolveCacheMode(mainConfig);
let downloadDir = settings.resolveDownloadDir(mainConfig, DEFAULT_DOWNLOAD_DIR);

/**
 * 手动清理模式的缓存放哪儿：要跨重启留着，所以不能在运行目录里（下次启动按残留回收），
 * 也不能在系统临时目录里（Windows 的磁盘清理、存储感知会删临时文件）。
 * 用户自己指了缓存位置就放那下面的 kept（缓存根里只回收 run-* 目录，碰不到它）；
 * 用的是默认的系统临时目录（包括开机时指定的盘不在、退回默认的情况），就放本机应用数据目录。
 */
function keptCacheDir() {
  // 模块加载时就要用（store.setPolicy），那时 pathKey 还没定义，这里直接比
  if (path.resolve(cache.rootDir).toLowerCase() !== path.resolve(DEFAULT_CACHE_ROOT).toLowerCase()) {
    return path.join(cache.rootDir, 'kept');
  }
  return path.join(process.env.LOCALAPPDATA || USER_DATA_DIR, 'NoxReel', 'Cache');
}

// 收下来的片子登记在哪儿：复用、手动清理都查它。临时条目的目录交还当前的缓存管理器去删
const mediaLibrary = new MediaLibrary({ dataDir: USER_DATA_DIR, removeOwned: (dir) => cache.removeOwned(dir) });
// 用户在「选择下载位置」对话框里挑过的目录，理由同 approvedCacheDirs
const approvedDownloadDirs = new Set();

/** 在 dir 下开一个放半截文件的工作目录；finish 把下好的文件挪进 dir（不重名），abort 删掉工作目录。 */
async function workDirIn(dir, id, onFinish = async () => {}) {
  const work = path.join(dir, DOWNLOAD_WORK_DIR, id);
  await fsp.mkdir(work, { recursive: true });
  return {
    workDir: work,
    finish: async (file, meta) => {
      // 不覆盖：挑好名字和挪过去之间有人抢先建了同名文件，也另起名字
      const target = await moveNoOverwrite(file, dir, path.basename(file));
      // 外层的 .noxreel-downloading 空了一起删，别在下载文件夹里留一个空目录
      await removeWorkDir(work);
      await onFinish(target, meta);
      return target;
    },
    abort: () => fsp.rm(work, { recursive: true, force: true }),
  };
}

// 在线视频下到本机（见 linkCache.js），两种用途：
//  - cache（播放列表里的「开始手动缓存」）：进缓存，跟着清理方式走 —— 自动模式放本次运行的临时缓存、
//    关软件时清；手动模式放长期缓存文件夹。都登记进 mediaLibrary，之后同一个链接直接从本地播。
//  - download（「边下边播」）：另存一份到下载文件夹，是用户自己的文件，不登记、缓存清理不碰。
// 下载和直接下不了时的解析都经本机过滤代理；解析和成员切片时的自动解析共用同一个并发名额
const linkCache = new LinkCache({
  findYtDlp: () => linkMedia.findYtDlp(),
  proxyInfo: () => requireProxyInfo(),
  resolve: (url) =>
    withLinkInspectSlot(async () => {
      const proxy = await requireProxyInfo();
      const info = await linkMedia.inspectLink(url, {
        proxy: proxy.url,
        browserFallback: (target) => browserMediaResolver.resolveInBrowser(target, { proxy }),
      });
      if (info.playback?.url) info.playback.url = await validate.publicHttpUrl(info.playback.url, '播放地址');
      return info;
    }),
  alreadyDone: (url, purpose) => purpose === 'cache' && !!mediaLibrary.findLink(url),
  placement: async (job) => {
    if (job.purpose === 'download') return workDirIn(downloadDir, job.id);
    if (cacheMode === 'manual') {
      return workDirIn(keptCacheDir(), job.id, (target, meta) =>
        mediaLibrary.addLink({ url: meta.url, title: meta.title, filePath: target, size: meta.size })
      );
    }
    // 工作目录归建它的那个缓存管理器管：收拾残局、登记都认它，不认之后换上来的
    const owner = cache;
    const owned = await owner.createOwnedDir('link');
    return {
      workDir: owned,
      finish: async (file, meta) => {
        // 缓存位置在这期间换过（setCacheRoot 本来会拦）：旧运行目录已经不归现在的缓存管，别登记进去
        if (owner !== cache) throw new Error('缓存位置已经换了，这份缓存作废');
        mediaLibrary.addTempLink({ url: meta.url, title: meta.title, filePath: file, size: meta.size, ownedDir: owned });
        return file;
      },
      abort: () => owner.removeOwned(owned),
    };
  },
  childEnv: () => linkMedia.childEnv(),
});
linkCache.on('update', (view) => send('linkCache:update', view));
const remuxOutputs = new Map();
// 转封装／精简正在跑的条数。产物要等任务结束才登记进 remuxOutputs，中间这段时间那张表是空的 ——
// 只看它，换缓存目录就会在 ffmpeg 正往里写的时候把 run 目录端走，转封装白做一场。
let tempJobs = 0;
// 可取消的长任务（算哈希 / 转封装 / 精简）：taskId -> AbortController，见 runTask()
const tasks = new Map();
const approvedSources = new Set();
// 外挂字幕单列一张表：它们只能作为 media:convert 的字幕输入，不能被当成片源去算哈希、开会话
const approvedSubtitles = new Set();
// 用户在「选择缓存目录」对话框里挑过的目录。settings:setCacheRoot 只认这里面的 ——
// 缓存根下的 run-* 目录会被回收，由页面随手给一个路径（甚至 \\某台机器\共享）是不行的。
const approvedCacheDirs = new Set();
const MAIN_PAGE = path.join(__dirname, '..', 'renderer', 'index.html');
const MAIN_PAGE_URL = pathToFileURL(MAIN_PAGE).href;
const DEEP_LINK_SCHEME = 'noxreel:';
let pendingDeepLink = null;

app.enableSandbox();
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
store.configureCache(cache);
store.configureLibrary(mediaLibrary);
store.setPolicy({ mode: cacheMode, keptDir: keptCacheDir() });

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

/** 把主窗口拉到用户眼前：最小化的还原，被挡住的提到前台。 */
function revealMainWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function dispatchDeepLink(raw) {
  const link = normalizeDeepLink(raw);
  if (!link) return;
  pendingDeepLink = link;
  if (win && !win.isDestroyed() && !win.webContents.isLoadingMainFrame()) {
    win.webContents.send('app:deepLink', link);
    pendingDeepLink = null;
  }
  // 页面还在加载时链接先存着（加载完由 app:takeDeepLink 取走），窗口照样要拉到前面
  revealMainWindow();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
else {
  pendingDeepLink = deepLinkFromArgv(process.argv);
  // 已经开着一个 NoxReel 时再双击图标：第二个进程拿不到锁直接退出，这边必须把窗口唤出来 ——
  // 不带深链接也一样，不然用户看到的就是「点了没反应」
  app.on('second-instance', (_event, argv) => {
    // 启动时窗口没建出来：这时再双击图标得把它补出来，不然又是「点了没反应」。
    // 准备工作还没跑完时不抢着建（那边跑完马上就建），正在退出时也不建
    if (!win && startupSettled && !quitRequested) {
      try {
        ensureMainWindow();
      } catch (error) {
        console.error('[main] 补建主窗口失败：', error);
      }
    }
    revealMainWindow();
    dispatchDeepLink(deepLinkFromArgv(argv));
  });
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
  // 房主这边能选的格式比接收方宽：AVI、TS 这些会先在本机封成 MKV，进房的永远是那四种容器
  validateSourceName(path.basename(target));
  const stat = await fsp.stat(target);
  if (!stat.isFile()) throw new Error('选择的路径不是文件');
  const realPath = await fsp.realpath(target);
  approvedSources.add(pathKey(realPath));
  return realPath;
}

async function requireAllowedLocalPath(filePath) {
  const target = validate.absolutePath(filePath);
  if (cache.owns(target)) return target;
  // 手动模式、复用的片在保存位置里：正开着的接收会话的文件是主进程自己建的 / 核对过的
  if (store.isSessionFile(target)) return target;
  const realPath = await fsp.realpath(target);
  if (!approvedSources.has(pathKey(realPath))) throw new Error('文件未经用户选择，已拒绝访问');
  return realPath;
}

/** 批准一个外挂字幕：用户在对话框里选的，或者是主进程自己在片子旁边找到的。 */
async function approveSubtitle(filePath, videoPath = null) {
  const target = validate.absolutePath(filePath, '字幕路径');
  const realPath = await fsp.realpath(target);
  const entry = await subtitles.describeFile(realPath, videoPath);
  approvedSubtitles.add(pathKey(realPath));
  return entry;
}

async function requireApprovedSubtitle(filePath) {
  const realPath = await fsp.realpath(validate.absolutePath(filePath, '字幕路径'));
  if (!approvedSubtitles.has(pathKey(realPath))) throw new Error('字幕未经用户选择，已拒绝访问');
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
  // 权限请求和检查一律拒绝。检查那一道是为了让 Chromium 把 SDP 里的 host 候选换成 mDNS 名字
  // （<uuid>.local），不然邀请码里明文带着本机局域网 IP 和公网 IPv6 —— media 绝不能放行，见 permissions.js
  lockDownPermissions(win.webContents.session);

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
  // Windows 关机、重启、注销时 Electron 不发 before-quit，上面那套收尾一行都不跑。
  // 趁窗口收到 session-end 尽力收一次尾；来不及做完也不要紧 —— 没收完的片、没复制完的另存
  // 都在运行目录或 .noxreel-downloading 工作目录里，下次启动回收，不会顶着正式片名留下来。
  win.on('session-end', () => {
    cleanup().catch(() => {});
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
    // 退房会刷新页面：Discord 上的「正在观看」要跟着撤掉。断开 IPC，Discord 自己就清了
    discordPresence.disconnect();
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
/** 播放器最近一次打开的本地文件（在线链接是 null）。手动清理要据此把正在放的缓存标成「正在用」。 */
let playerSource = null;
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
    // 原因要说人话：盘没插时 Node 的原文是「ENOENT: no such file or directory, mkdir '\\?'」
    cacheFallback = { configured: cache.rootDir, reason: await describeFsError(error, cache.rootDir) };
    cacheChoice = { root: DEFAULT_CACHE_ROOT, source: 'default' };
    // 刚刚用不了的那个根不再当旧根去扫：它多半是离线的网盘，再 opendir 一次又要等一轮网络超时
    const failedRoot = pathKey(cache.rootDir);
    cache = new CacheManager({
      rootDir: DEFAULT_CACHE_ROOT,
      extraRoots: cacheKnownRoots.filter((root) => pathKey(root) !== failedRoot),
      deferExtraRoots: true,
    });
    store.configureCache(cache);
    store.setPolicy({ mode: cacheMode, keptDir: keptCacheDir() });
    return cache.initialize();
  }
}

/** 主窗口还没有（或者已经销毁）就建一个。启动收尾和「再双击一次图标」两条路共用，不会建出两个。 */
function ensureMainWindow() {
  if (win && !win.isDestroyed()) return;
  createWindow();
}

app.whenReady().then(async () => {
  // 建窗口之前的准备，任何一步出错都不能挡住开窗口：以前默认缓存目录也建不出来
  // （%TEMP%\NoxReel 是个同名文件、TEMP 指向不存在的盘、没权限）时整个回调就此中断，
  // 窗口永远不出来，进程却一直占着单实例锁 —— 再双击图标也没反应，只能去任务管理器结束。
  // 缓存用不了时窗口照样出来，页面启动时调 app:ensureDirs 会再试一次、把原因报出来。
  try {
    // 多开的测试实例不去改系统的 noxreel:// 协议关联
    if (!DEV_USER_DATA) {
      try {
        const registered =
          process.defaultApp && process.argv[1]
            ? app.setAsDefaultProtocolClient('noxreel', process.execPath, [path.resolve(process.argv[1])])
            : app.setAsDefaultProtocolClient('noxreel');
        // 源码运行时登记的是 electron.exe，浏览器会问「要打开 Electron 吗？」—— 补上显示名。
        // 不等它：写不上只是弹窗里的名字不对，不耽误开窗口
        if (registered) labelProtocolHandler().catch(() => {});
      } catch (error) {
        console.warn(`[main] 登记 noxreel:// 协议失败：${error?.message || error}`);
      }
    }
    try {
      await ensureCacheReady();
    } catch (error) {
      console.warn(`[main] 缓存目录准备失败：${error?.message || error}`);
    }
    // 登记表（手动模式存的片、手动缓存的在线视频）。读不出来就当空的，不挡启动
    await mediaLibrary.load().catch(() => {});
    // 上次没缓存完就退出留下的工作目录
    await linkCache.cleanupLeftovers([keptCacheDir(), downloadDir]).catch(() => {});
    await cleanupLegacySidecars(LEGACY_DOWNLOAD_DIR).catch(() => {});
  } finally {
    startupSettled = true;
    ensureMainWindow();
  }
  // 换过缓存目录留下的旧根：窗口出来之后在后台收。它可能在离线的网盘上，opendir 要等网络超时
  cache.cleanupExtraRoots().catch(() => {});
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error) => console.error('[main] 启动时建窗口失败：', error));

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
    discordPresence.destroy();
    malwareScan.cancelAll();
    // 还在算哈希的任务也一起停掉，别在退出途中继续读整部片
    for (const controller of tasks.values()) controller.abort();
    // 在线视频的手动缓存和下载：结束 yt-dlp 整棵进程树，没下完的工作目录由它自己删。
    // 等它删完再端运行目录：yt-dlp 还攥着半截文件的话，cleanupRun() 当次删不掉自动模式的缓存
    const linksStopped = linkCache.cancelAll().catch(() => {});
    // 边下边播正在跨盘复制的另存：取消，半截文件连工作目录删掉（不取消的话进程要在后台等复制做完才退，
    // 而且它还读着缓存那份，关会话、删缓存都得等它）
    const savesStopped = downloadSaver.cancelAll().catch(() => {});
    // 转封装／精简的 ffmpeg 也要收，否则它会变成孤儿进程继续满速写盘，
    // 而且持着输出文件的句柄让 cleanupRun() 当次删不掉缓存目录。
    media.cancelAll();
    // 顺序是定死的：外部播放器先退干净（它还攥着缓存文件），再关桥接程序（关了就发不出
    // WM_CLOSE 了），然后销毁覆盖窗，最后才关会话删缓存。
    await players.quit().catch(() => {});
    await closeSharedBridge().catch(() => {});
    await closeSharedProxy();
    overlay.destroy();
    if (globalShortcut) {
      try {
        globalShortcut.unregisterAll();
      } catch {
        /* 还没 ready 就退出 */
      }
    }
    await linksStopped;
    await savesStopped;
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
    // 带上构建号：0.7.7.101（package.json 的 version 只能写三段，见 appVersion.js）
    version: displayVersion(app.getVersion(), readBuildNumber()),
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

const VIDEO_FILTERS = [{ name: '视频', extensions: [...SOURCE_EXTENSIONS].map((ext) => ext.slice(1)) }];
const SUBTITLE_FILTERS = [{ name: '字幕', extensions: [...SUBTITLE_EXTENSIONS].map((ext) => ext.slice(1)) }];

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

secureHandle('dialog:approveDroppedVideo', async (filePath) => {
  // 拖进来的是文件夹时，approveSource 先查名字、报的是「不支持这种视频格式」—— 说法不对，
  // 用户会以为是格式问题。先把文件夹认出来，报错原样交给页面去提示。
  const stat = await fsp.stat(validate.absolutePath(filePath)).catch(() => null);
  if (stat?.isDirectory()) throw new Error('拖进来的是文件夹，请打开它，把里面的视频文件拖进来');
  return approveSource(filePath);
});

// 手动补字幕（名字和片子对不上、或者放在别的文件夹里的）。某一个不合格只跳过它。
secureHandle('dialog:pickSubtitles', async () => {
  let picked;
  if (devPicks.length) picked = takeDevPick();
  else {
    const r = await dialog.showOpenDialog(win, {
      title: '选择外挂字幕',
      properties: ['openFile', 'multiSelections'],
      filters: SUBTITLE_FILTERS,
    });
    if (r.canceled) return [];
    picked = r.filePaths;
  }
  const approved = [];
  for (const filePath of picked.slice(0, subtitles.MAX_SUBTITLES)) {
    try {
      approved.push(await approveSubtitle(filePath));
    } catch {}
  }
  return approved;
});

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
        const { outPath, droppedSubtitles = [], subtitlesUnchecked = false } = await media.remux(source, ownedDir, {
          onProgress: (p) => send('media:remuxProgress', { progress: p, taskId }),
          signal,
        });
        remuxOutputs.set(outPath, ownedDir);
        // MP4 装不下、只能略过的字幕要让房主知道，别让大家开播才发现少了一条
        return { outPath, droppedSubtitles, subtitlesUnchecked };
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
        const { outPath, plan, inputSize, outputSize, droppedSubtitles = [] } = await media.slim(source, ownedDir, {
          keepIndexes: opts.keepIndexes,
          toFlac: opts.toFlac,
          onProgress: (p) => send('media:slimProgress', { progress: p, taskId }),
          signal,
        });
        remuxOutputs.set(outPath, ownedDir);
        return { outPath, plan, inputSize, outputSize, droppedSubtitles };
      } catch (error) {
        await cache.removeOwned(ownedDir).catch(() => {});
        throw error;
      }
    });
  } finally {
    tempJobs--;
  }
});

// Discord 状态显示。内容在主进程再校验一遍（sanitizeActivity）：按钮只放行我们自己的 https 链接。
secureHandle('discord:setActivity', async (payload) => {
  const activity = sanitizeActivity(validate.plainObject(payload, 'Discord 状态'));
  if (activity) discordPresence.setActivity(activity);
  return discordPresence.status;
});

secureHandle('discord:clear', async () => {
  discordPresence.clear();
  return discordPresence.status;
});

secureHandle('discord:status', async () => discordPresence.status);

/* ------------------------------ Cloudflare TURN ------------------------------ */

// 一次汇报的增量上限：渲染进程每 10 秒报一次，10 Gbps 跑满也到不了这个数
const MAX_TURN_USAGE_REPORT = 64 * 1e9;
// 渲染进程在离过期不到 12 小时时要一组新的（缓存本身能管 23 小时）；给大了等于允许它每次都绕过缓存去刷 Cloudflare
const MAX_TURN_MIN_VALID_MS = 13 * 60 * 60 * 1000;

// API Token 只进不出：这几个处理器没有一个把它交回去，报错里也不带它（见 cloudflareTurn.js）
secureHandle('turn:cfSave', async (payload) => {
  const { keyId, apiToken } = validate.plainObject(payload, 'Cloudflare 凭据');
  return cfTurn.save({ keyId: validate.cfKeyId(keyId), apiToken: validate.cfApiToken(apiToken) });
});

secureHandle('turn:cfClear', async () => cfTurn.clear());

secureHandle('turn:cfStatus', async () => cfTurn.status());

secureHandle('turn:cfCredentials', async (opts) => {
  const value = opts === undefined || opts === null ? {} : validate.plainObject(opts, 'TURN 参数');
  const minValidMs =
    value.minValidMs === undefined ? 0 : validate.integer(value.minValidMs, 'TURN 参数', { min: 0, max: MAX_TURN_MIN_VALID_MS });
  return cfTurn.credentials({ minValidMs });
});

// 经 Cloudflare 中继的字节数（增量），按 UTC 自然月累加、落盘；返回本月用量
secureHandle('turn:cfReportUsage', async (bytes) =>
  cfTurn.addUsage(validate.integer(bytes, 'TURN 用量', { min: 0, max: MAX_TURN_USAGE_REPORT }))
);

secureHandle('turn:cfSetLimit', async (limitGB) =>
  cfTurn.setLimit(validate.integer(limitGB, 'TURN 用量上限', { min: 1, max: 1000 }))
);

// 片子旁边的外挂字幕。片子本身必须已经批准过；找到的字幕顺手批准，
// 之后 media:convert 才肯读它们 —— 渲染进程自己拼一个路径塞进来是不行的。
secureHandle('media:findSubtitles', async (filePath) => {
  const source = await requireAllowedLocalPath(filePath);
  const found = await subtitles.findSubtitles(source);
  const approved = [];
  for (const entry of found) {
    try {
      approved.push(await approveSubtitle(entry.path, source));
    } catch {}
  }
  return approved;
});

// 封成 MKV（AVI、TS 这类进房前必须走；带外挂字幕时也走这里），可顺带无损精简。
// 产物和转封装／精简走同一套生命周期：登记进 remuxOutputs。
secureHandle('media:convert', async (payload) => {
  const { filePath, keepIndexes, toFlac, subtitles: subtitleList, taskId: rawTaskId } = validate.plainObject(
    payload,
    '转换参数'
  );
  const opts = validate.slimOptions({ keepIndexes, toFlac });
  const taskId = validate.taskId(rawTaskId);
  if (subtitleList != null && (!Array.isArray(subtitleList) || subtitleList.length > subtitles.MAX_SUBTITLES)) {
    throw new Error('无效的字幕列表');
  }
  tempJobs++;
  try {
    return await runTask(taskId, async (signal) => {
      const source = await requireAllowedLocalPath(filePath);
      const subtitlePaths = [];
      for (const item of subtitleList || []) subtitlePaths.push(await requireApprovedSubtitle(item));
      const ownedDir = await cache.createOwnedDir('convert');
      try {
        const result = await media.convert(source, ownedDir, {
          keepIndexes: opts.keepIndexes,
          toFlac: opts.toFlac,
          subtitles: subtitlePaths,
          onProgress: (p) => send('media:convertProgress', { progress: p, taskId }),
          signal,
        });
        remuxOutputs.set(result.outPath, ownedDir);
        return result;
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

/**
 * 本机过滤代理（见 publicProxy.js）。mpv、yt-dlp、隔离浏览器的每个请求都经它按「连接那一刻」
 * 解析出的 IP 判定，私网一律拦下 —— publicHttpUrl 只能查第一跳，跳转、HLS 分段、DNS 重绑定都管不到。
 * 起不来就返回 null，由调用方决定是拒绝（远程源）还是照常（本地文件另有 --access-references=no）。
 */
async function publicProxyInfo() {
  const proxy = sharedProxy();
  try {
    await proxy.start();
    return proxy.info;
  } catch {
    return null;
  }
}

async function requireProxyInfo() {
  const info = await publicProxyInfo();
  if (!info) throw new Error('本机网络过滤代理启动失败，为防访问内网已拒绝打开在线链接');
  return info;
}

/**
 * 链接解析的并发上限。每次解析都要起 yt-dlp（最长两轮各 60 秒），失败了还要开一个隐藏的浏览器窗口
 * 跑 35 秒；而解析是房主切换当前项时每个成员自动触发的 —— 不设上限的话，有人连着切片子就能让
 * 成员机器上同时挂着几十个 yt-dlp 和隐藏窗口。超出的排队，队也排满了就直接拒。
 */
const LINK_INSPECT_CONCURRENCY = 2;
const LINK_INSPECT_QUEUE = 6;
let linkInspectRunning = 0;
const linkInspectWaiting = [];

async function withLinkInspectSlot(work) {
  if (linkInspectRunning >= LINK_INSPECT_CONCURRENCY) {
    if (linkInspectWaiting.length >= LINK_INSPECT_QUEUE) throw new Error('正在解析的链接太多，稍后再试');
    await new Promise((resolve) => linkInspectWaiting.push(resolve));
  } else {
    linkInspectRunning++;
  }
  try {
    return await work();
  } finally {
    // 名额直接交给排队的下一个（计数不变）；没人排队才真的归还
    const next = linkInspectWaiting.shift();
    if (next) next();
    else linkInspectRunning--;
  }
}

secureHandle('media:inspectLink', async (url) => {
  const safeUrl = await validate.publicHttpUrl(url, '视频链接');
  const result = await withLinkInspectSlot(async () => {
    const proxy = await requireProxyInfo();
    return linkMedia.inspectLink(safeUrl, {
      proxy: proxy.url,
      browserFallback: (target) => browserMediaResolver.resolveInBrowser(target, { proxy }),
    });
  });
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

// 本机有这部片收完的副本就复用：逐片核对要一阵子，进度推给界面（开始、每半秒、结束各一条）
secureHandle('store:openLeech', async (manifest) =>
  store.openLeech(validate.manifest(manifest), { onReuse: (progress) => send('store:reuse', progress) })
);

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
  if (!cache.owns(filePath) && !store.isSessionFile(filePath)) throw new Error('拒绝扫描不属于当前会话的文件');
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

// options.discard：扫描发现威胁时，不管收没收完、在临时缓存还是保存位置，一律删掉
secureHandle('store:close', async (sessionId, options) => {
  const id = validate.sessionId(sessionId);
  const { discard = false } = options === undefined ? {} : validate.plainObject(options, '关闭参数');
  if (typeof discard !== 'boolean') throw new TypeError('无效的关闭参数');
  // 扫描进程还攥着文件的话，删缓存会失败 —— 先停掉它、等它退出
  await malwareScan.cancel(id).catch(() => {});
  if (discard) {
    // 可信房间里没扫完就另存过的，事后扫出威胁：下载文件夹里那份一起删
    const fileId = (() => {
      try {
        return store.state(id).fileId;
      } catch {
        return null;
      }
    })();
    if (fileId) await downloadSaver.discard(`file:${fileId}`).catch(() => {});
  }
  return store.close(id, { discard });
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
  // 先卡类型再跑正则：正则会把任意对象 String() 一遍，一个巨大的数组就能白白吃掉一大块内存
  validate.string(filePath, '文件路径', { max: 32_768 });
  const remote = /^https?:\/\//i.test(filePath);
  // 外部播放器没有按次指定代理的参数，会跟着跳转去连内网；远程源只交给经过滤代理的 mpv
  if (remote && want !== 'mpv') throw new Error('在线链接只能用 mpv 播放');
  const source = remote ? await validate.publicHttpUrl(filePath, '媒体链接') : await requireAllowedLocalPath(filePath);
  const safeHeaders = /^https?:\/\//i.test(source) ? validate.mediaHeaders(headers) : {};
  // mpv 的网络请求全部经过滤代理。远程源没有代理就不开；本地文件另有 --access-references=no 兜底，
  // 代理起不来也照常播放
  const proxy = want === 'mpv' ? (remote ? await requireProxyInfo() : await publicProxyInfo()) : null;
  if (typeof startPaused !== 'boolean') throw new TypeError('无效的暂停参数');
  const start = validate.finiteNumber(startAt, '起播位置', { min: 0, max: 10 ** 9 });
  // 播放器内那个弹幕输入框的提示语。主进程不做 i18n，文案由渲染进程按界面语言生成，
  // 这里只把它交给 mpv 的 --script-opt。空串就用 Lua 脚本自带的默认值。
  const prompt = chatPrompt === '' ? '' : validate.scriptOptValue(chatPrompt, '弹幕输入提示');
  playerChatPrompt = prompt;
  playerSource = remote ? null : source;
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
    return await players.launch('mpv', { source, startPaused, startAt: start, headers: safeHeaders, muted: TEST_MUTE, chatPrompt: prompt, proxy: proxy && proxy.url }, ticket);
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

// 撒手：用户在外部播放器里自己开了别的片。不再给那个窗口发任何指令、横幅、OSD，
// 覆盖窗和快捷键也松开（gone），但不关它 —— 见 PlayerManager.release。
secureHandle('player:release', async (gen) => {
  await players.release(gen === undefined || gen === null ? undefined : validate.integer(gen, '播放器代号', { min: 1 }));
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
  let runDir;
  try {
    runDir = await ensureCacheReady();
  } catch (error) {
    // 连系统临时目录也建不出来（%TEMP%\NoxReel 是个同名文件、没权限）：把原因换成人话再交给页面
    throw new Error(await describeFsError(error, cache.rootDir));
  }
  return { cacheDir: cache.rootDir, runDir, fallback: cacheFallback };
});

// 正在接收的片按已经写进去的字节数兜底：Windows 上稀疏文件的块数要等脏页写回才跟上（见 cacheManager.dirBytes）
secureHandle('cache:usage', async () => cache.usage({ writtenBytesOf: store.writtenBytesOf }));

secureHandle('cache:purge', async () => ({ removed: await cache.purgeStale() }));

secureHandle('dialog:pickCacheDir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择缓存目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
  const picked = validate.absolutePath(r.filePaths[0], '缓存目录');
  approvedCacheDirs.add(pathKey(picked));
  return picked;
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
  // 同一个道理：自动模式下「开始手动缓存」的在线视频，yt-dlp 正往运行目录里写（退房不取消，见 reclaimAfterRendererGone）。
  // 换目录会把运行目录连同它的工作目录一起端走。手动模式的写在长期缓存文件夹、边下边播的写在下载文件夹，不拦
  if (linkCache.hasActive('cache', (workDir) => cache.owns(workDir))) {
    throw new Error('在线视频还在缓存，完成或取消后再换缓存目录');
  }
  const target = validate.absolutePath(dir, '缓存目录');
  // 只认用户刚在对话框里挑的目录（或者默认目录）：页面自己拼的路径不行，理由同 approvedSources
  const key = pathKey(target);
  if (!approvedCacheDirs.has(key) && key !== pathKey(DEFAULT_CACHE_ROOT)) {
    throw new Error('缓存目录未经用户选择，已拒绝');
  }
  // 先试着真的写一下。指到一个只读目录或者没插的盘上，得当场知道。
  await fsp.mkdir(target, { recursive: true });
  const probe = path.join(target, `.noxreel-write-test-${process.pid}`);
  await fsp.writeFile(probe, 'ok');
  await fsp.rm(probe, { force: true });

  await cache.cleanupRun().catch(() => {});
  // 旧运行目录连同里面收完的片一起清掉了，临时登记跟着作废
  mediaLibrary.dropTemp();
  cacheKnownRoots = settings.knownRoots({ knownRoots: cacheKnownRoots }, target);
  await settings.write(USER_DATA_DIR, { cacheRoot: target, knownRoots: cacheKnownRoots });
  cacheChoice = { root: target, source: 'config' };
  cacheFallback = null;
  cache = new CacheManager({ rootDir: target, extraRoots: cacheKnownRoots });
  store.configureCache(cache);
  // 长期缓存文件夹跟着缓存位置走；已经存下的片留在原处，登记表里照样找得到
  store.setPolicy({ mode: cacheMode, keptDir: keptCacheDir() });
  await cache.initialize();
  // fallback 已经清掉了：界面照抄，「这次用不了，已临时用回系统临时目录」的提示跟着撤
  return { cacheDir: cache.rootDir, fallback: cacheFallback };
});

/* ------------------------------ 清理方式、下载位置、手动清理 ------------------------------ */

const cachePolicyView = () => ({ mode: cacheMode, keptDir: keptCacheDir(), downloadDir, defaultDownloadDir: DEFAULT_DOWNLOAD_DIR });

secureHandle('cache:policy', async () => cachePolicyView());

/** 清理方式：auto（关软件时清）/ manual（从不自动清，放长期缓存文件夹）。只影响之后开始接收、缓存的片。 */
secureHandle('cache:setMode', async (mode) => {
  if (mode !== 'auto' && mode !== 'manual') throw new TypeError('无效的清理方式');
  await settings.write(USER_DATA_DIR, { cacheMode: mode });
  cacheMode = mode;
  store.setPolicy({ mode: cacheMode, keptDir: keptCacheDir() });
  return cachePolicyView();
});

secureHandle('dialog:pickDownloadDir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择下载位置',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
  const picked = validate.absolutePath(r.filePaths[0], '下载位置');
  approvedDownloadDirs.add(pathKey(picked));
  return picked;
});

/** 换下载位置：只认对话框里挑过的（或默认的）；先试着写一下，指到只读目录、没插的盘上得当场知道。 */
secureHandle('download:setDir', async (payload) => {
  const { dir } = validate.plainObject(payload, '下载位置参数');
  const target = validate.absolutePath(dir, '下载位置');
  const key = pathKey(target);
  if (!approvedDownloadDirs.has(key) && key !== pathKey(DEFAULT_DOWNLOAD_DIR)) throw new Error('下载位置未经用户选择，已拒绝');
  await fsp.mkdir(target, { recursive: true });
  const probe = path.join(target, `.noxreel-write-test-${process.pid}`);
  await fsp.writeFile(probe, 'ok');
  await fsp.rm(probe, { force: true });
  await settings.write(USER_DATA_DIR, { downloadDir: target });
  downloadDir = target;
  return cachePolicyView();
});

/* ------------------------------ 边下边播：另存一份到下载文件夹 ------------------------------ */

// 另存到下载文件夹（见 downloadSaver.js）：同盘硬链接、否则复制，不覆盖，这次运行里存过的不再存
const downloadSaver = new DownloadSaver({ dir: () => downloadDir });

/**
 * P2P 收完的片另存一份。只收完整、校验过的接收会话（scanTarget 把关）；扫描要不要先过由界面决定
 * （扫出威胁的不存）。
 */
secureHandle('download:saveSession', async (sessionId) => {
  const id = validate.sessionId(sessionId);
  const source = await store.scanTarget(id);
  const { fileId } = store.state(id);
  return downloadSaver.save(`file:${fileId}`, source);
});

/**
 * 在线视频另存一份：缓存里已经有的直接放一份过去，没有的在后台另下一份
 * （进度走 linkCache:update，purpose=download）。
 */
secureHandle('download:saveLink', async (payload) => {
  const { url, title = '' } = validate.plainObject(payload, '下载参数');
  const safeUrl = await validate.publicHttpUrl(url, '视频链接');
  if (typeof title !== 'string') throw new TypeError('无效的标题');
  const key = `link:${safeUrl}`;
  const done = (saved) => ({ url: safeUrl, purpose: 'download', title, state: 'done', ...saved });
  const existing = await downloadSaver.existing(key);
  if (existing) return done({ path: existing, fresh: false });
  const cached = mediaLibrary.findLink(safeUrl);
  if (cached) {
    try {
      return done(await downloadSaver.save(key, cached.path));
    } catch {
      /* 缓存那份拿不到：照常另下一份 */
    }
  }
  return linkCache.start({ url: safeUrl, title: title.slice(0, 300), purpose: 'download' });
});

linkCache.on('update', (view) => {
  if (view.purpose === 'download' && view.state === 'done') downloadSaver.remember(`link:${view.url}`, view.path);
});

/* ------------------------------ 在线视频的手动缓存 ------------------------------ */

/** 所有下载任务（手动缓存和边下边播，在下、排队、下完、失败）加上登记表里早就缓存好的链接。 */
secureHandle('linkCache:list', async () => {
  const views = linkCache.status();
  const seen = new Set(views.filter((v) => v.purpose === 'cache').map((v) => v.url));
  for (const entry of await mediaLibrary.list()) {
    if (entry.kind !== 'link' || seen.has(entry.url)) continue;
    views.push({
      url: entry.url,
      purpose: 'cache',
      title: entry.name,
      state: 'done',
      downloaded: entry.size,
      total: entry.size,
      path: '',
      error: '',
    });
  }
  return views;
});

secureHandle('linkCache:start', async (payload) => {
  const { url, title = '' } = validate.plainObject(payload, '缓存参数');
  const safeUrl = await validate.publicHttpUrl(url, '视频链接');
  if (typeof title !== 'string') throw new TypeError('无效的标题');
  return linkCache.start({ url: safeUrl, title: title.slice(0, 300), purpose: 'cache' });
});

secureHandle('linkCache:cancel', async (payload) => {
  const { url, purpose = 'cache' } = validate.plainObject(payload, '取消参数');
  if (purpose !== 'cache' && purpose !== 'download') throw new TypeError('无效的下载用途');
  return linkCache.cancel(validate.string(url, '视频链接', { max: 16_384 }), purpose);
});

/**
 * 缓存好的本地文件：交给播放器之前由主进程核准（approvedSources）。文件确实没了、大小不对就摘掉登记；
 * 所在的盘这会儿访问不了（移动硬盘没插）就只是这次不用它，登记留着。
 * @returns {Promise<{path: string, title: string}|null>}
 */
secureHandle('linkCache:localPath', async (url) => {
  const key = validate.string(url, '视频链接', { max: 16_384 });
  const entry = mediaLibrary.findLink(key);
  if (!entry) return null;
  const where = await mediaLibrary.probe(entry.path).catch(() => ({ status: 'unavailable' }));
  if (where.status === 'unavailable') return null;
  if (where.status !== 'ok' || !where.stat.isFile() || where.stat.size !== entry.size) {
    await mediaLibrary.forgetPath(entry.path).catch(() => {});
    return null;
  }
  // 扩展名不在能播的格式里（yt-dlp 偶尔下出冷门格式）：不核准，界面照旧在线播
  let realPath;
  try {
    realPath = await approveSource(entry.path);
  } catch {
    return null;
  }
  mediaLibrary.touch(entry.id).catch(() => {});
  return { path: realPath, title: entry.name };
});

/**
 * 这个缓存文件现在有没有人在用：开着的接收会话的文件，或者播放器正打开着的本地文件
 * （缓存好的在线视频从本地播时没有会话，只有播放器攥着它）。
 */
async function cacheFileInUse(filePath) {
  if (store.isSessionFile(filePath)) return true;
  if (!players.running || !playerSource) return false;
  // 播放器拿到的是 realpath 过的路径，登记表里记的是当初的路径：两边都归一了再比
  const real = await fsp.realpath(filePath).catch(() => filePath);
  return pathKey(real) === pathKey(playerSource) || pathKey(filePath) === pathKey(playerSource);
}

/** 手动清理列的清单：登记过的片子（临时的、保存位置里的、手动缓存的在线视频），标出哪些正在用、哪些所在的盘不在。 */
secureHandle('cache:listFiles', async () => {
  const entries = await mediaLibrary.list();
  return Promise.all(entries.map(async (e) => ({ ...e, inUse: await cacheFileInUse(e.path) })));
});

/** 删勾选的那几条。正在用的不删；删不掉的（被别的程序占着、所在的盘不在）报回去。 */
secureHandle('cache:deleteFiles', async (ids) => {
  if (!Array.isArray(ids) || ids.length > 5000) throw new TypeError('无效的删除列表');
  const entries = await mediaLibrary.list();
  const byId = new Map(entries.map((e) => [e.id, e]));
  const result = { removed: 0, skipped: 0, failed: 0 };
  for (const raw of ids) {
    const entry = typeof raw === 'string' ? byId.get(raw) : null;
    if (!entry) continue;
    if (await cacheFileInUse(entry.path)) {
      result.skipped++;
      continue;
    }
    try {
      await mediaLibrary.remove(entry.id);
      result.removed++;
    } catch {
      result.failed++;
    }
  }
  return result;
});

secureHandle('clipboard:writeText', async (text) => {
  // 只收字符串（空值当空串）：String() 一个巨大的数组或对象本身就要吃掉一大块内存
  const value = text === undefined || text === null ? '' : typeof text === 'number' ? String(text) : text;
  clipboard.writeText(validate.string(value, '剪贴板文本', { max: 2 * 1024 * 1024, allowEmpty: true }));
});
