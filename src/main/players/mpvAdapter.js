'use strict';

/**
 * 内置 mpv 的适配器：把 MpvController 包成统一的播放器接口。
 *
 * mpv 走 JSON IPC，属性变化是推送的、跳转是精确的，所以这一层几乎只是转发。
 * 真正要费心思的是那些只能轮询、跳转落到关键帧上的外部播放器（见同目录其他适配器）。
 */
const { EventEmitter } = require('events');
const { MpvController, findMpv } = require('../mpv');

/** 主进程单调时钟（毫秒）。随 tick 一起发给渲染进程，跳变判定不受 IPC 排队抖动影响。 */
const monotonicMs = () => Number(process.hrtime.bigint()) / 1e6;

class MpvAdapter extends EventEmitter {
  constructor() {
    super();
    this.kind = 'mpv';
    // seekPrecision：跳转落点误差（秒）；streaming：能不能读正在增长的缓存文件
    this.caps = { seekPrecision: 0, streaming: true, banner: true, osd: true, danmaku: 'native' };
    this.ctl = new MpvController();
    this.ctl.on('tick', (snap) => this.emit('tick', { ...snap, sampledAt: monotonicMs() }));
    this.ctl.on('exit', (info) => this.emit('exit', info));
    this.ctl.on('error', (err) => this.emit('error', err));
    // 用户在 mpv 窗口里按 Ctrl+Shift+D 发的弹幕。mpv 自己带输入框，所以这一路是原生的；
    // 外部播放器没有，P6 那两个适配器要靠覆盖窗弹输入条，事件名保持一样。
    this.ctl.on('chat-input', (payload) => this.emit('chat-input', payload));
    // 在线链接手动同步时按 Ctrl+Shift+S「同步到房主」。在线链接只交给 mpv，外部播放器没有这一路。
    this.ctl.on('sync-request', () => this.emit('sync-request', {}));
    // 用户调过的窗口大小（占屏幕的百分比、是否最大化），主进程存进配置，下次开窗用
    this.ctl.on('geometry', (pref) => this.emit('geometry', pref));
    // 自己画的控制条上点的按钮里要 NoxReel 办的事（开关弹幕、换清晰度），见 noxreel-osc.lua
    this.ctl.on('osc-action', (payload) => this.emit('osc-action', payload));
  }

  static find() {
    return findMpv();
  }

  // proxy：主进程那个只放行公网目标的本机过滤代理，见 publicProxy.js / mpv.js 的 networkArgs
  // growing：本地文件还在接收（可信房间边收边播），关掉 mpv 的缓存，见 mpv.js 的 cacheArg
  // maxHeight：在线视频的清晰度上限，见 mpv.js 的 qualityArgs
  // windowPref：上次的窗口大小，见 mpv.js 的 windowArgs
  launch({ source, startPaused = true, startAt = 0, headers = {}, muted = false, chatPrompt = '', proxy = null, growing = false, maxHeight = 0, windowPref = null }) {
    return this.ctl.launch(source, { startPaused, startAt, headers, muted, chatPrompt, proxy, windowPref, maxHeight, growing });
  }

  setPause(paused) {
    return this.ctl.setPause(paused);
  }

  // dropBuffers：先丢掉解复用器缓存再跳，见 MpvController.seek
  seek(seconds, { dropBuffers = false } = {}) {
    return this.ctl.seek(seconds, { dropBuffers: dropBuffers === true });
  }

  // tone：ok / warn / info，控制条画提示条时据此配图标
  osd(text, durationMs, tone) {
    return this.ctl.osd(text, durationMs, tone);
  }

  /** 常驻横幅（全员暂停提示）。空串清掉。控制条在的时候由它画成正中的卡片，见 MpvController.setRoomBanner。 */
  setBanner(text) {
    return this.ctl.setRoomBanner(text);
  }

  /** 控制条要画的房间状态，见 MpvController.setOscState。 */
  setOscState(state) {
    return this.ctl.setOscState(state);
  }

  /**
   * 一帧弹幕。返回 true 表示发出去了，false 表示被丢掉（上一帧还在途、暂停跳转在途、没连上）。
   * mpv 这一路直接画进 osd-overlay 的第 2 层，不经过覆盖窗。
   */
  setDanmakuFrame(frame) {
    return this.ctl.setDanmakuFrame(frame);
  }

  snapshot() {
    return { ...this.ctl.snapshot(), sampledAt: monotonicMs() };
  }

  /** 进程真正退出才返回：删缓存之前必须等它放开文件句柄。 */
  async quit() {
    await this.ctl.quit().catch(() => {});
    await this.ctl.waitForExit(3000);
  }
}

module.exports = { MpvAdapter, monotonicMs };
