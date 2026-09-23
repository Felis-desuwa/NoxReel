'use strict';

/**
 * 内置 mpv 的适配器：把 MpvController 包成统一的播放器接口。
 *
 * mpv 走 JSON IPC，属性变化是推送的、跳转是精确的，所以这一层几乎只是转发。
 * 真正要费心思的是那些只能轮询、跳转落到关键帧上的外部播放器（见同目录其他适配器）。
 */
const { EventEmitter } = require('events');
const { MpvController, findMpv, OVERLAY_ROOM } = require('../mpv');

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
  }

  static find() {
    return findMpv();
  }

  // proxy：主进程那个只放行公网目标的本机过滤代理，见 publicProxy.js / mpv.js 的 networkArgs
  launch({ source, startPaused = true, startAt = 0, headers = {}, muted = false, chatPrompt = '', proxy = null }) {
    return this.ctl.launch(source, { startPaused, startAt, headers, muted, chatPrompt, proxy });
  }

  setPause(paused) {
    return this.ctl.setPause(paused);
  }

  seek(seconds) {
    return this.ctl.seek(seconds);
  }

  osd(text, durationMs) {
    return this.ctl.osd(text, durationMs);
  }

  /** 常驻横幅（全员暂停提示）。空串清掉。 */
  setBanner(text) {
    return this.ctl.setOverlay(OVERLAY_ROOM, text);
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
