'use strict';

/**
 * 播放器管理：同一时刻只有一个播放器，换播放器（或重开）时旧的先彻底退掉。
 *
 * 每次拉起都是新的一代。旧一代迟到的事件一律丢掉 —— 旧进程几百毫秒后才真正退出，
 * 那条迟到的 exit 如果被转发给渲染进程，刚起来的新播放器会被标记成「已关闭」。
 */
const { EventEmitter } = require('events');
const { MpvAdapter } = require('./mpvAdapter');
const { PotAdapter } = require('./potAdapter');
const { MpcAdapter } = require('./mpcAdapter');

const ADAPTERS = {
  mpv: MpvAdapter,
  pot: PotAdapter,
  mpc: MpcAdapter,
};

// 被更新的启动或退出取代。沿用「操作已取消」这句（已有翻译）；换片时渲染进程按 seq 静默忽略。
const superseded = () => new Error('操作已取消');

/**
 * 播放器管理器。
 *
 * 除了转发给渲染进程的那几条（tick / exit / error / chat-input），还往外发两个
 * **只归主进程用**的事件：`window`（播放器窗口几何和前台状态）和 `banner`（横幅正文变了）。
 * 它们的去处是覆盖窗，根本不该经过渲染进程绕一圈 —— 那样每次窗口挪动都要多跑两趟 IPC，
 * 而且渲染进程拿到 hwnd 也没有任何用处。
 */
class PlayerManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {(channel: string, payload: any) => void} opts.send  发给渲染进程
   * @param {Record<string, any>} [opts.adapters]  测试里可以换成假的
   * @param {(frame: any) => boolean} [opts.danmakuSink]  适配器自己画不了弹幕时的去处（覆盖窗）
   */
  constructor({ send, adapters = ADAPTERS, danmakuSink = null }) {
    super();
    this.send = send;
    this.adapters = adapters;
    this.danmakuSink = typeof danmakuSink === 'function' ? danmakuSink : null;
    this.current = null;
    this.generation = 0;
    // 启动号。只有号码仍是最新的那次启动才许拉起播放器：主进程的 player:launch 在
    // 交给这里之前还要做异步校验（realpath / DNS），先发的请求可能后校验完；等旧进程
    // 退出期间也可能又来了新请求。没有这道号，过期的启动会把后来者的 current 覆盖掉，
    // 留下一个谁也管不着、关程序时也不会被关掉的播放器。
    this.epoch = 0;
    // 正在退出的旧播放器。新的一代要等它们全部退干净才拉起。
    this.stopping = new Set();
  }

  get running() {
    return !!this.current;
  }

  /** 当前这一代是哪个播放器（没开就是 null）。切换流程和覆盖窗都要看它。 */
  get kind() {
    return this.current ? this.current.kind : null;
  }

  /** 登记过的播放器 id。渲染进程递上来的 id 必须落在这张表里。 */
  get kinds() {
    return Object.keys(this.adapters);
  }

  /**
   * 领一个启动号。调用方必须在任何 await 之前同步领，号码的先后才等于请求到达的先后。
   * 领号本身就让之前领的号全部作废 —— 渲染进程只会等最新的那次启动。
   */
  reserve() {
    return ++this.epoch;
  }

  async launch(kind, options, ticket = this.reserve()) {
    const Adapter = this.adapters[kind];
    if (!Adapter) throw new Error(`不支持的播放器：${kind}`);
    // 过期的启动连旧播放器都不许碰：此刻的 current 很可能是后来者刚拉起的
    if (ticket !== this.epoch) throw superseded();
    await this._stop();
    // 等旧进程退出期间又来了新的启动或不带 gen 的退出：让位给它
    if (ticket !== this.epoch) throw superseded();

    // exe 路径是构造参数，不是启动参数：适配器要拿它去探测、去记住这一代用的是哪个程序。
    // 它只会由主进程从探测结果或用户在对话框里挑的路径得来，渲染进程递不进来。
    const { exePath = '', ...launchOptions } = options || {};
    const adapter = new Adapter(exePath ? { exePath } : undefined);
    const gen = ++this.generation;
    const current = { adapter, gen, kind };
    this.current = current;

    // 闭包捕获这一代，晚到的事件如果不是它发的就丢掉。和 quit() 里摘监听器是双保险，
    // 免得将来有人在别处忘了摘，又把这个 bug 放回来。
    const fromCurrent = (fn) => (arg) => {
      if (this.current === current) fn(arg);
    };
    adapter.on('tick', fromCurrent((snap) => this.send('player:tick', { ...snap, gen, kind })));
    adapter.on(
      'exit',
      fromCurrent((info) => {
        this.current = null;
        // 用户自己关掉了播放器。这一路也必须把适配器收干净：摘监听器、再走一遍 quit() ——
        // 适配器挂在**共用**的桥上（copydata / win / restart 三条），摘监听器只写在 quit() 里，
        // 不收的话开一次外部播放器就多三个监听器（第四次触发 MaxListenersExceededWarning），
        // 桥里那个 pid 的 allow 和那个 hwnd 的 WinEventHook 也永远撤不掉。
        this._retire(adapter);
        this.send('player:exit', { ...info, gen, kind });
        this.emit('gone', { gen, kind });
      })
    );
    // err.code 必须带着走：Electron 的 IPC 只传 message，渲染进程要靠代号判断
    // 「这是遥控断了，得退回 mpv」还是「只是一句提示」。丢了它就只剩一行日志。
    adapter.on(
      'error',
      fromCurrent((err) => this.send('player:error', { message: err.message, code: err.code || '', gen, kind }))
    );
    // 用户在播放器窗口里直接发的弹幕。走和 tick 一样的代际过滤：上一代播放器退出途中
    // 迟到的一条，不该被当成这一部片的弹幕发出去。
    adapter.on(
      'chat-input',
      fromCurrent((payload) => this.send('player:chat-input', { ...payload, gen, kind }))
    );
    // 下面两条只给主进程自己（覆盖窗）用，不转发给渲染进程。
    adapter.on('window', fromCurrent((state) => this.emit('window', { ...state, gen, kind })));
    adapter.on('banner', fromCurrent(({ text }) => this.emit('banner', { text, gen, kind })));

    try {
      const info = await adapter.launch(launchOptions);
      // 启动途中已被退掉（mpv 恰好在被关之前连上了管道）：这一代已经不受控，不能报成功
      if (current.stopped) throw superseded();
      return { ...info, gen, kind, caps: adapter.caps };
    } catch (error) {
      if (this.current === current) await this._stop();
      throw error;
    }
  }

  /**
   * 退掉当前播放器，等进程真正退出。先摘监听器，旧进程的收尾事件不再转发。
   * 给了 gen 就只退那一代：换片期间晚到的「退掉上一部」不能误伤刚起来的新播放器。
   * 不带 gen 的退出（换片、拦下威胁、关程序）同时作废所有还没拉起来的启动。
   */
  async quit(gen) {
    const targeted = gen !== undefined && gen !== null;
    if (!targeted) this.epoch++;
    else if (!this.current || this.current.gen !== gen) return;
    await this._stop();
  }

  /**
   * 退掉当前这一代（如果有），再等所有正在退出的旧播放器都退干净 ——
   * 别人发起的退出也要等：调用方接下来要么拉起新的，要么删缓存，都得等旧进程放手。
   */
  async _stop() {
    const current = this.current;
    if (current) {
      this.current = null;
      current.stopped = true;
      // 覆盖窗要立刻松开这一代的窗口：下一代可能是 mpv（它自己画弹幕），
      // 也可能根本没有下一代，留着旧几何会让覆盖窗贴在一个已经没了的窗口上。
      this.emit('gone', { gen: current.gen, kind: current.kind });
      this._retire(current.adapter);
    }
    await Promise.all(this.stopping);
  }

  /**
   * 摘掉这个适配器的监听器并让它自己收尾，把「等它退干净」这件事记在 stopping 里。
   *
   * 两条路共用：主动退（_stop）和用户自己关掉播放器（exit 事件）。后者以前只把 current
   * 置空就完了 —— 适配器那一侧的收尾（摘桥监听、untrack、forget）一步都没做。
   */
  _retire(adapter) {
    adapter.removeAllListeners();
    const exited = Promise.resolve()
      .then(() => adapter.quit())
      .catch(() => {});
    this.stopping.add(exited);
    exited.then(() => this.stopping.delete(exited));
    return exited;
  }

  _require() {
    if (!this.current) throw new Error('播放器未启动');
    return this.current.adapter;
  }

  async setPause(paused) {
    return this._require().setPause(paused);
  }

  async seek(seconds) {
    return this._require().seek(seconds);
  }

  /** 提示和横幅是锦上添花，播放器没开时静默忽略。 */
  osd(text, durationMs) {
    if (this.current) return this.current.adapter.osd(text, durationMs);
  }

  setBanner(text) {
    if (this.current) return this.current.adapter.setBanner(text);
  }

  /**
   * 一帧弹幕。带了 gen 就只认那一代 —— 换播放器、重开播放器之后，上一代还在 IPC 路上的
   * 那一帧不能画到新播放器身上：那是属于上一部片的一屏字，而且新播放器可能刚起来还在片头。
   *
   * 适配器没实现（外部播放器画不了覆盖层）就交给 danmakuSink —— 也就是覆盖窗。
   * 两条路都没有就当这一帧被丢掉，不报错：渲染进程每秒发 30 次，这里抛错只会刷屏。
   */
  setDanmakuFrame(frame) {
    const current = this.current;
    if (!current) return false;
    const gen = frame ? frame.gen : undefined;
    if (gen !== undefined && gen !== null && gen !== current.gen) return false;
    if (typeof current.adapter.setDanmakuFrame !== 'function') {
      if (!this.danmakuSink) return false;
      return this.danmakuSink(frame) === true;
    }
    return current.adapter.setDanmakuFrame(frame) === true;
  }

  /**
   * 覆盖窗的输入条发来的一条弹幕。
   *
   * 交给适配器再转出来，而不是直接 send('player:chat-input')：这样它和 mpv 自带输入框
   * 走的是同一条路，PlayerManager 的代际过滤对三个播放器是同一套 —— 上一代播放器
   * 退出途中迟到的一条不会被算成新这一部的弹幕。
   */
  deliverChatInput(payload) {
    const current = this.current;
    if (!current || typeof current.adapter.deliverChatInput !== 'function') return false;
    current.adapter.deliverChatInput(payload);
    return true;
  }

  snapshot() {
    if (!this.current) return { running: false };
    const { adapter, gen, kind } = this.current;
    return { ...adapter.snapshot(), gen, kind };
  }
}

module.exports = { PlayerManager, ADAPTERS };
