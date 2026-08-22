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

  dialog: {
    pickVideo: () => ipcRenderer.invoke('dialog:pickVideo'),
    approveDroppedVideo: (filePath) => ipcRenderer.invoke('dialog:approveDroppedVideo', filePath),
  },

  media: {
    inspect: (filePath) => ipcRenderer.invoke('media:inspect', filePath),
    inspectLink: (url) => ipcRenderer.invoke('media:inspectLink', url),
    remux: (filePath) => ipcRenderer.invoke('media:remux', filePath),
    releaseTemp: (filePath) => ipcRenderer.invoke('media:releaseTemp', filePath),
    onRemuxProgress: on('media:remuxProgress'),
  },

  store: {
    buildManifest: (filePath) => ipcRenderer.invoke('store:buildManifest', filePath),
    onHashProgress: on('store:hashProgress'),
    openSeed: (manifest, filePath) => ipcRenderer.invoke('store:openSeed', { manifest, filePath }),
    openLeech: (manifest) => ipcRenderer.invoke('store:openLeech', manifest),
    readChunk: (sessionId, index) => ipcRenderer.invoke('store:readChunk', { sessionId, index }),
    writeChunk: (sessionId, index, data) => ipcRenderer.invoke('store:writeChunk', { sessionId, index, data }),
    state: (sessionId) => ipcRenderer.invoke('store:state', sessionId),
    scanReceivedMedia: (sessionId) => ipcRenderer.invoke('store:scanReceivedMedia', sessionId),
    close: (sessionId) => ipcRenderer.invoke('store:close', sessionId),
    reveal: (filePath) => ipcRenderer.invoke('store:reveal', filePath),
  },

  mpv: {
    launch: (filePath, startPaused = true, headers = {}) =>
      ipcRenderer.invoke('mpv:launch', { filePath, startPaused, headers }),
    setPause: (paused) => ipcRenderer.invoke('mpv:setPause', paused),
    seek: (seconds) => ipcRenderer.invoke('mpv:seek', seconds),
    osd: (text, duration = 2000) => ipcRenderer.invoke('mpv:osd', { text, duration }),
    snapshot: () => ipcRenderer.invoke('mpv:snapshot'),
    quit: () => ipcRenderer.invoke('mpv:quit'),
    onTick: on('mpv:tick'),
    onExit: on('mpv:exit'),
    onError: on('mpv:error'),
  },

  app: {
    onShutdownRequested: on('app:shutdownRequested'),
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
