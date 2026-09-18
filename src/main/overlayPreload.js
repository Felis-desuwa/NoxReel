'use strict';

/**
 * 覆盖窗专用的 preload。
 *
 * 覆盖窗上画的是房间里别人发来的文字，它能做的事越少越好：只有「收一帧」和「发一条」
 * 两个接口，一个进、一个出，没有文件、没有剪贴板、没有第二条通道。
 *
 * submitChat('') 是约定的「关掉输入条、什么也不发」—— 只有两个接口，取消也只能从这里回来。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('noxOverlay', {
  /** 一帧数据：{items?, messages?, banner?, settings?, clear?, chat?}。返回退订函数。 */
  onFrame: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('overlay:frame', handler);
    return () => ipcRenderer.off('overlay:frame', handler);
  },
  /** 用户在输入条里按回车发的一条弹幕。空串表示取消。 */
  submitChat: (text) => ipcRenderer.invoke('overlay:submit', { text }),
});
