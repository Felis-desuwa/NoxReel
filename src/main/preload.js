'use strict';

/**
 * 渲染进程与主进程之间的唯一通道。
 * contextIsolation 开着，渲染进程拿不到 Node —— 它只能用这里明确暴露的这些方法。
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.off(channel, h);
};

contextBridge.exposeInMainWorld('sw', {
  clipboard: {
    writeText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  },
  env: {
    status: () => ipcRenderer.invoke('env:status'),
    ensureDirs: () => ipcRenderer.invoke('app:ensureDirs'),
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  },

  geo: {
    check: (opts) => ipcRenderer.invoke('geo:check', opts),
  },

  net: {
    estimateUplink: (opts) => ipcRenderer.invoke('net:estimateUplink', opts),
  },

  cache: {
    usage: () => ipcRenderer.invoke('cache:usage'),
    purge: () => ipcRenderer.invoke('cache:purge'),
    setRoot: (dir) => ipcRenderer.invoke('settings:setCacheRoot', { dir }),
  },
  dialog: {
    pickVideo: () => ipcRenderer.invoke('dialog:pickVideo'),
    pickVideos: () => ipcRenderer.invoke('dialog:pickVideos'),
    pickCacheDir: () => ipcRenderer.invoke('dialog:pickCacheDir'),
    approveDroppedVideo: (filePath) => ipcRenderer.invoke('dialog:approveDroppedVideo', filePath),
  },

  media: {
    inspect: (filePath) => ipcRenderer.invoke('media:inspect', filePath),
    inspectLink: (url) => ipcRenderer.invoke('media:inspectLink', url),
    remux: (filePath, taskId) => ipcRenderer.invoke('media:remux', taskId ? { filePath, taskId } : filePath),
    slim: (filePath, { keepIndexes = null, toFlac = null, taskId = null } = {}) =>
      ipcRenderer.invoke('media:slim', { filePath, keepIndexes, toFlac, ...(taskId ? { taskId } : {}) }),
    releaseTemp: (filePath) => ipcRenderer.invoke('media:releaseTemp', filePath),
    onRemuxProgress: on('media:remuxProgress'),
    onSlimProgress: on('media:slimProgress'),
  },

  store: {
    buildManifest: (filePath, taskId) =>
      ipcRenderer.invoke('store:buildManifest', taskId ? { filePath, taskId } : filePath),
    onHashProgress: on('store:hashProgress'),
    openSeed: (manifest, filePath) => ipcRenderer.invoke('store:openSeed', { manifest, filePath }),
    openLeech: (manifest) => ipcRenderer.invoke('store:openLeech', manifest),
    validateManifest: (manifest) => ipcRenderer.invoke('store:validateManifest', manifest),
    readChunk: (sessionId, index) => ipcRenderer.invoke('store:readChunk', { sessionId, index }),
    writeChunk: (sessionId, index, data) => ipcRenderer.invoke('store:writeChunk', { sessionId, index, data }),
    state: (sessionId) => ipcRenderer.invoke('store:state', sessionId),
    scanReceivedMedia: (sessionId) => ipcRenderer.invoke('store:scanReceivedMedia', sessionId),
    cancelScan: (sessionId) => ipcRenderer.invoke('store:cancelScan', sessionId),
    close: (sessionId) => ipcRenderer.invoke('store:close', sessionId),
    reveal: (filePath) => ipcRenderer.invoke('store:reveal', filePath),
  },

  // 长任务（算哈希 / 转封装 / 精简）的取消。taskId 由调用方生成，
  // 进度事件的负载里会带回同一个 taskId。
  tasks: {
    cancel: (taskId) => ipcRenderer.invoke('task:cancel', taskId),
  },

  player: {
    // chatPrompt 是播放器内弹幕输入框的提示语：主进程不做翻译，由渲染进程按界面语言传下来。
    // kind 是播放器 id（mpv / pot / mpc），主进程只认它登记过的那几个；
    // exe 路径永远不从这里走 —— 那是一道授权，只能由主进程自己的对话框收。
    launch: ({ filePath, startPaused = true, headers = {}, startAt = 0, chatPrompt = '', kind = 'mpv' }) =>
      ipcRenderer.invoke('player:launch', { filePath, startPaused, headers, startAt, chatPrompt, kind }),
    // 有哪些播放器、能不能用、不能用是为什么（原因只有代号，文字在渲染进程这边生成）
    list: () => ipcRenderer.invoke('player:list'),
    select: (id) => ipcRenderer.invoke('player:select', id),
    // 主进程弹对话框让用户挑 exe，挑完仍要过白名单。返回的是刷新后的播放器列表。
    pickExe: (id) => ipcRenderer.invoke('player:pickExe', id),
    setPause: (paused) => ipcRenderer.invoke('player:setPause', paused),
    seek: (seconds) => ipcRenderer.invoke('player:seek', seconds),
    osd: (text, duration = 2000) => ipcRenderer.invoke('player:osd', { text, duration }),
    overlay: (text) => ipcRenderer.invoke('player:overlay', { text }),
    // 一帧弹幕 {w, h, gen?, items:[{text, x, y, fontSize?, opacity?, outline?}]}。
    // resolve 成 true 表示真画出去了，false 表示这一帧被丢掉（上一帧在途、暂停跳转在途、
    // 播放器没开或者代际不对）。调用方每秒发 30 次，reject 一定要接住。
    setDanmakuFrame: (frame) => ipcRenderer.invoke('player:setDanmakuFrame', frame),
    snapshot: () => ipcRenderer.invoke('player:snapshot'),
    quit: (gen) => ipcRenderer.invoke('player:quit', gen),
    onTick: on('player:tick'),
    onExit: on('player:exit'),
    onError: on('player:error'),
    // 用户在播放器窗口里直接发的弹幕：{ text, gen, kind }。文本已按聊天上限截断，
    // 但清洗、限速、去重仍然要走 lib/chat.js —— 这里只是多了一个入口，不是一条特权通道。
    onChatInput: on('player:chat-input'),
    // 播放器侧的提示：{ code }，目前有 exclusive-fullscreen（独占全屏看不到弹幕）、
    // hotkey-taken（快捷键被别的程序占了）、chat-unavailable（这会儿弹不出输入条）
    onNotice: on('player:notice'),
  },

  app: {
    onShutdownRequested: on('app:shutdownRequested'),
    onDeepLink: on('app:deepLink'),
    takeDeepLink: () => ipcRenderer.invoke('app:takeDeepLink'),
  },

  // 拖拽进来的 File 对象在 Electron 里拿不到 .path 了（安全策略变更），
  // 得走 webUtils 这个官方替代品。
  pathForFile: async (file) => {
    try {
      const filePath = webUtils.getPathForFile(file);
      return filePath ? ipcRenderer.invoke('dialog:approveDroppedVideo', filePath) : null;
    } catch {
      return null;
    }
  },
});
