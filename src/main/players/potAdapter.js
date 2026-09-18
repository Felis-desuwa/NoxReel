'use strict';

/**
 * PotPlayer 适配器。
 *
 * mpv 那一路是推送式的、跳转精确，这一路三样都没有，每一条都要在这里补上（数字来自 P0 实测）：
 *
 *  1. **只能轮询**：每 200ms 问一批状态/位置/时长，文件名每秒问一次（它走 WM_COPYDATA 回包）。
 *  2. **位置每 500ms 才变一次**：直接上报会一顿一顿的，同步引擎会把它当成跳变。
 *     所以记下「数值跳变的那一刻」，播放中按这个锚点外推，精度约 ±100ms。
 *  3. **跳转落到目标之前的关键帧**（10 秒 GOP 下最远差 4.8 秒）：先跳目标，再发一次
 *     「下一个关键帧」，这样落点变成目标之后的第一个关键帧，然后原地暂停 ——
 *     宁可停在房间前面等大家追上来，也不要悄悄落后半个 GOP。实测偏差平均 -15ms。
 *
 * 另外两件必须记住的事：
 *  - **绝不传音量/静音参数**：`/volume=` 会被 PotPlayer 永久写进注册表，改的是用户自己的播放器。
 *  - **只接手已收完的文件**：P0 实测边下边播时 PotPlayer 会跳走并停止，所以由上层保证。
 */

const { EventEmitter } = require('events');
const { spawn: nodeSpawn } = require('child_process');
const { createWaiterHub, sharedBridge, monotonicMs, normalizeSource, sanitizeArg } = require('./bridge');
const { discoverPlayers } = require('./discover');

/** PotPlayer 的 WM_USER 指令码。只用这几条，音量那两条（0x5008/0x5009）永远不碰。 */
const POT = {
  GET_DURATION: 0x5002,
  GET_POSITION: 0x5004,
  SET_POSITION: 0x5005,
  GET_STATE: 0x5006,
  SET_STATE: 0x5007,
  SEND_COMMAND: 0x5010,
  GET_FILENAME: 0x6020,
  SHOW_OSD: 0x6040,
};
/** 0x5010 的参数：跳到下一个关键帧。关键帧补救就靠它。 */
const POT_CMD_NEXT_KEYFRAME = 0x0327;
/** 0x5006 / 0x5007 的状态值。小于等于 0 一律当「停了」。 */
const POT_STATE = { STOPPED: 0, PAUSED: 1, PLAYING: 2 };
/** UIPI：低完整性进程给高完整性窗口发消息会得到 ERROR_ACCESS_DENIED。 */
const ERROR_ACCESS_DENIED = 5;
/** 跳转落点误差（秒）。P0 实测 10 秒 GOP 下最远 4.8 秒，同步引擎按它放宽跳转容差。 */
const POT_SEEK_PRECISION = 4.8;
/** 位置采样间隔（秒）。外推最多补这么多，轮询断了就让位置停住，不要越推越离谱。 */
const POT_SAMPLE_INTERVAL = 0.75;
/** 停止/换文件前最后位置离片尾多近算放完。 */
const EOF_MARGIN = 2;
/** 时长变化超过这个秒数就是换了文件（同一文件的时长只会在解析完成时精确一次）。 */
const DURATION_EPSILON = 0.5;
/** 跳转落点离目标多近就不必做关键帧补救 —— 跳到 0:00 正好落在关键帧上，补救反而会跳过片头。 */
const KEYFRAME_EPSILON = 0.3;

const DEFAULT_TIMING = {
  pollMs: 200,
  // 连着这么久一条都问不到才算失联。判死是终态（停轮询、上层退回 mpv），
  // 而 PotPlayer 忙起来半秒多不理窗口消息很常见，门槛不能按轮数定。
  unreachableMs: 2000,
  namePollMs: 1000,
  pauseTimeoutMs: 1000,
  seekTimeoutMs: 3000,
  launchTimeoutMs: 20000,
  windowTimeoutMs: 10000,
  quitTimeoutMs: 3000,
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clampText = (text, max) => {
  const chars = [...String(text === undefined || text === null ? '' : text)];
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
};

function playerError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** `/seek=` 要 `时:分:秒`。取整到秒，实测这样已经是精确落点。 */
function formatSeek(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hh = String(Math.floor(total / 3600)).padStart(2, '0');
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function pickHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === name && typeof value === 'string' && value) return value;
  }
  return '';
}

/**
 * 命令行。文件名在前、开关在后，这是 PotPlayer 官方文档的顺序。
 * 这里一个音量相关的参数都不许出现，见文件头。
 */
function buildPotArgs({ source, startAt = 0, headers = {} } = {}) {
  const args = [normalizeSource(source)];
  args.push('/new');
  const start = Number(startAt) || 0;
  if (start >= 1) args.push(`/seek=${formatSeek(start)}`);
  const referer = pickHeader(headers, 'referer');
  if (referer) args.push(`/referer=${sanitizeArg(referer, '请求头 Referer')}`);
  const agent = pickHeader(headers, 'user-agent');
  if (agent) args.push(`/user_agent=${sanitizeArg(agent, '请求头 User-Agent')}`);
  return args;
}

class PotAdapter extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {object} [opts.bridge]   桥接客户端（测试里换成假的）
   * @param {Function} [opts.spawn]  child_process.spawn 的替身
   * @param {string} [opts.exePath]  指定 PotPlayer 路径，不给就自己探测
   * @param {object} [opts.timing]   各段超时，测试里调小
   */
  constructor({ bridge, spawn = nodeSpawn, exePath = '', timing = {} } = {}) {
    super();
    this.kind = 'pot';
    // banner/danmaku 都交给覆盖窗：PotPlayer 没有常驻覆盖层，OSD 是一闪而过的。
    this.caps = {
      seekPrecision: POT_SEEK_PRECISION,
      streaming: false,
      banner: 'overlay',
      osd: true,
      danmaku: 'overlay',
      // 跳转落点只会在目标之后（关键帧补救的结果），上层据此「原地暂停等房间追上」。
      keyframeAhead: true,
    };
    this.bridge = bridge || null;
    this.spawn = spawn;
    this.exePath = exePath || '';
    this.timing = { ...DEFAULT_TIMING, ...timing };

    this.proc = null;
    this.pid = 0;
    this.hwnd = 0;
    this.exited = false;
    this.lastError = null;

    this._quiet = true; // launch 稳定之前不发 tick
    this._closing = false;
    this._cmdDepth = 0;
    this._hub = createWaiterHub({ name: 'PotPlayer' });
    this._loopTimer = null;
    this._looping = false; // 轮询该不该继续。定时器已触发时 clearTimeout 拦不住，只能靠这个标记
    this._nameTimer = null;
    this._anchor = null; // {ms, at} 位置数值跳变的那一刻
    this._rawMs = 0;
    this._durationMs = 0;
    this._state = -1;
    this._fileName = '';
    this._lastPosition = 0;
    this._lastDuration = 0;
    this._eof = false;
    this._foreign = false;
    this._banner = '';
    this._failures = 0;
    this._failingSince = 0; // 连续失联是从哪一刻开始的（判死按时间算，不按次数）
    this._onCopyData = (msg) => this._handleCopyData(msg);
    this._onWinEvent = (msg) => this._handleWinEvent(msg);
    this._onBridgeRestart = () => this._reregister();
  }

  /** @returns {Promise<string|null>} 本机 PotPlayer 的可执行文件路径。 */
  static async find() {
    const found = await discoverPlayers();
    return found.pot.path;
  }

  /* ------------------------------- 启动 ------------------------------- */

  async launch({ source, startPaused = true, startAt = 0, headers = {} } = {}) {
    if (this.proc) throw playerError('PotPlayer 已在运行', 'PLAYER_BUSY');
    const exe = this.exePath || (await PotAdapter.find());
    if (!exe) throw playerError('没找到 PotPlayer。请先安装，或在设置里指定它的路径', 'PLAYER_NOT_FOUND');
    this.exePath = exe;

    const args = buildPotArgs({ source, startAt, headers });
    const bridge = await this._bridge();
    this._quiet = true;
    this._cmdDepth++;
    try {
      const proc = this.spawn(exe, args, { stdio: 'ignore', windowsHide: false });
      this.proc = proc;
      this.pid = proc.pid;
      proc.on('exit', (code) => this._onProcExit(code));
      proc.on('error', (error) => this._fail(error));

      await bridge.call('allow', { pid: this.pid });
      this.hwnd = await this._findWindow();
      await bridge.call('track', { hwnd: this.hwnd });
      this._startLoop();

      // 先等它认出文件：没有时长就谈不上位置，也判断不了换没换文件。
      await this._waitFor((s) => s.state > POT_STATE.STOPPED && s.durationMs > 0, {
        timeoutMs: this.timing.launchTimeoutMs,
        label: '打开文件',
      });

      // P0：带 /seek= 启动之后，单发一次暂停会被它自己的启动流程覆盖掉。
      // 所以每轮都补发，连着 3 次读到暂停才算稳。
      await this._waitFor((s) => s.paused, {
        times: 3,
        timeoutMs: this.timing.launchTimeoutMs,
        label: '暂停',
        each: () => this._send(POT.SET_STATE, POT_STATE.PAUSED).catch(() => {}),
      });

      const want = Math.max(0, Number(startAt) || 0);
      if (Math.abs(this.position() - want) > 1) await this._seekTo(want);
      if (!startPaused) await this._setPauseInternal(false);

      this._quiet = false;
      // 启动期间的文件名回报都没算数，马上问一次，拿它当「换没换文件」的基准
      this._askFileName();
      this._emitTick();
      return { bin: exe, filePath: source, pid: this.pid, hwnd: this.hwnd, args };
    } catch (error) {
      this._stopLoop();
      throw error;
    } finally {
      this._cmdDepth--;
    }
  }

  async _bridge() {
    if (!this.bridge) this.bridge = sharedBridge();
    await this.bridge.start();
    this.bridge.on('copydata', this._onCopyData);
    this.bridge.on('win', this._onWinEvent);
    this.bridge.on('restart', this._onBridgeRestart);
    return this.bridge;
  }

  /** 桥意外退出又被拉起来了：allow/track 都随旧进程没了，补登记一遍。 */
  async _reregister() {
    if (this._closing || !this.pid || !this.hwnd) return;
    try {
      await this.bridge.call('allow', { pid: this.pid });
      await this.bridge.call('track', { hwnd: this.hwnd });
    } catch {
      /* 补不回来就让轮询的失败计数去判死 */
    }
  }

  /** 桥推来的窗口几何/层级变化，原样转给上层 —— 覆盖窗要靠它贴住播放器。 */
  _handleWinEvent(msg) {
    if (!msg || this._closing) return;
    if (this.hwnd && Number(msg.hwnd) !== this.hwnd) return;
    this.emit('window', msg);
  }

  /** 窗口不是立刻就有的：进程起来到主窗口出现之间有几百毫秒。 */
  async _findWindow() {
    const deadline = monotonicMs() + this.timing.windowTimeoutMs;
    let lastError = null;
    while (monotonicMs() < deadline) {
      if (this.exited) throw playerError('PotPlayer 启动后立刻退出了（可能是它的单实例设置把文件交给了别的窗口）', 'PLAYER_GONE');
      try {
        const hwnd = await this.bridge.call('findWindow', { pid: this.pid, classes: [] });
        if (hwnd) return Number(hwnd);
      } catch (error) {
        lastError = error;
      }
      await delay(120);
    }
    throw playerError(`没等到 PotPlayer 的窗口${lastError ? `：${lastError.message}` : ''}`, 'PLAYER_NO_WINDOW');
  }

  /* ------------------------------- 轮询 ------------------------------- */

  _startLoop() {
    if (this._looping || this._closing) return;
    this._looping = true;
    const step = async () => {
      this._loopTimer = null;
      if (this._closing || !this._looping) return;
      try {
        await this._poll();
      } catch {
        // 轮询这一轮出了意外也要把下一轮排上：循环一断，播放器就此静止，
        // 而上层只会看到「位置不动了」，根本查不到是这里没了。
      }
      // _looping 这道判断不能省：_poll() 里判死（提权、彻底失联）走的 _fail() → _stopLoop()
      // 是在这个 await 里面发生的，那时候 _loopTimer 已经是 null（本轮的定时器早触发过了），
      // clearTimeout 清了个寂寞 —— 少了这道判断，判死之后轮询照跑，一秒好几批桥接调用。
      if (this._closing || !this._looping) return;
      this._loopTimer = setTimeout(step, this.timing.pollMs);
      if (this._loopTimer.unref) this._loopTimer.unref();
    };
    this._loopTimer = setTimeout(step, 0);
    if (this._loopTimer.unref) this._loopTimer.unref();
    this._nameTimer = setInterval(() => this._askFileName(), this.timing.namePollMs);
    if (this._nameTimer.unref) this._nameTimer.unref();
    this._askFileName();
  }

  _stopLoop() {
    this._looping = false;
    if (this._loopTimer) clearTimeout(this._loopTimer);
    if (this._nameTimer) clearInterval(this._nameTimer);
    this._loopTimer = null;
    this._nameTimer = null;
  }

  async _poll() {
    if (!this.hwnd || this._closing) return;
    let results;
    try {
      results = await this.bridge.call(
        'pot',
        { hwnd: this.hwnd, timeout: 300, calls: [[POT.GET_STATE], [POT.GET_POSITION], [POT.GET_DURATION]] },
        { timeoutMs: 1500 }
      );
    } catch (error) {
      this._onPollFailure(error);
      return;
    }
    if (!Array.isArray(results) || results.length < 3) {
      this._onPollFailure(playerError('PotPlayer 返回了看不懂的结果', 'PLAYER_PROTOCOL'));
      return;
    }
    const denied = results.filter((r) => r && r.err === ERROR_ACCESS_DENIED).length;
    if (denied === results.length) {
      this._fail(
        playerError('PotPlayer 以管理员身份运行，系统不允许遥控它。请用普通权限重开，或改回 mpv', 'PLAYER_ELEVATED')
      );
      return;
    }
    if (results.some((r) => r && r.err !== undefined)) {
      this._onPollFailure(playerError('PotPlayer 没有应答', 'PLAYER_UNREACHABLE'));
      return;
    }
    this._failures = 0;
    this._failingSince = 0;
    this._apply({
      state: Number(results[0].v),
      positionMs: Math.max(0, Number(results[1].v)),
      durationMs: Math.max(0, Number(results[2].v)),
      at: monotonicMs(),
    });
  }

  /**
   * 一轮轮询没拿到结果。
   *
   * 判据按**时间**算，不按次数：PotPlayer 在大文件跳转、换音轨、切换渲染器时
   * 有几百毫秒不处理窗口消息是常事，而「判死」是终态 —— 轮询就此停掉、上层退回 mpv。
   * 按次数算的话 3 × 200ms = 600ms 就够踢掉一个完全健康的播放器。
   * 次数那道条件仍留着：pollMs 被调得很小时，不能只凭一两次失败就开始计时判死。
   */
  _onPollFailure(error) {
    this._failures++;
    if (!this._failingSince) this._failingSince = monotonicMs();
    if (this._failures >= 3 && monotonicMs() - this._failingSince >= this.timing.unreachableMs) this._fail(error);
  }

  _askFileName() {
    if (!this.hwnd || this._closing) return;
    this.bridge.call('potString', { hwnd: this.hwnd, code: POT.GET_FILENAME }, { timeoutMs: 1500 }).catch(() => {});
  }

  /** PotPlayer 的字符串回包。只认我们自己那个窗口/进程发来的，别的窗口一律不信。 */
  _handleCopyData(msg) {
    if (!msg || this._closing) return;
    const fromOurs = Number(msg.pid) === this.pid || Number(msg.from) === this.hwnd;
    if (!fromOurs) return;
    // 只认文件名查询的回包，别的字符串消息不是「当前文件名」
    if (Number(msg.code) !== POT.GET_FILENAME) return;
    const text = String(msg.text || '');
    if (!text) return;
    // 还在启动时的回报一律不比：PotPlayer 刚起来会先报一次它**上次**放过的文件，加载好我们的片子
    // 之后才换成这一部。以前拿这两次一比就判成「有人在 PotPlayer 里打开了别的文件」，界面随即放开它，
    // 启动流程收尾时又把它当成作废的一代关掉 —— 看上去就是 PotPlayer 放了两秒就崩了。
    // 基准取启动完成后的第一次回报（launch 末尾会马上问一次）。
    if (this._quiet) return;
    if (this._fileName && text !== this._fileName) this._onFileSwitched();
    this._fileName = text;
  }

  /* ------------------------------ 状态推进 ------------------------------ */

  _apply(sample) {
    const { state, positionMs, durationMs, at } = sample;
    const playing = state === POT_STATE.PLAYING;
    const stopped = state <= POT_STATE.STOPPED;

    // 判断顺序：先看换没换文件，再决定发不发 tick（换了的话这条位置属于另一部片）。
    if (!stopped && durationMs > 0 && this._durationMs > 0 && Math.abs(durationMs - this._durationMs) > DURATION_EPSILON * 1000) {
      this._onFileSwitched();
    }

    if (positionMs !== this._rawMs || this._anchor === null) this._anchor = { ms: positionMs, at };
    this._rawMs = positionMs;
    if (durationMs > 0) this._durationMs = durationMs;
    const wasRunningState = this._state > POT_STATE.STOPPED;
    this._state = state;

    const full = {
      ...sample,
      paused: !playing,
      state,
      rawMs: positionMs,
      durationMs: this._durationMs,
      stopped,
    };
    this._notify(full);

    if (stopped) {
      // 停止时不广播：位置已经归零，发出去只会把全房间拖回片头。
      // 唯一的例外是「刚刚放完」—— 那是要上报的一件事。
      if (wasRunningState) this._judgeStop();
      return;
    }
    // 又放起来了：上一次的 eof 已经翻篇，再挂着会让上层以为这一部也放完了。
    if (playing && this._eof) this._eof = false;
    this._lastPosition = positionMs / 1000;
    this._lastDuration = this._durationMs / 1000;
    this._emitTick();
  }

  /** 停止前最后一次位置贴着片尾，就是放完了；否则是用户自己按了停止。 */
  _judgeStop() {
    if (this._lastDuration > 0 && this._lastPosition >= this._lastDuration - EOF_MARGIN) {
      this._eof = true;
      this._emitTick({ force: true });
    }
  }

  /**
   * 换文件：可能是放完了自动跳下一个，也可能是用户在 PotPlayer 里自己开了别的片。
   * 前者上报 eof 交给播放列表推进，后者只暂停并提示 —— 绝不能让它推着房间往下走。
   */
  _onFileSwitched() {
    if (this._lastDuration > 0 && this._lastPosition >= this._lastDuration - EOF_MARGIN) {
      this._eof = true;
      this._emitTick({ force: true });
    } else if (!this._foreign) {
      this._foreign = true;
      this._send(POT.SET_STATE, POT_STATE.PAUSED).catch(() => {});
      this.emit('error', playerError('有人在 PotPlayer 里打开了别的文件，已暂停', 'PLAYER_FOREIGN_FILE'));
    }
    this._durationMs = 0;
    this._anchor = null;
    this._lastPosition = 0;
    this._lastDuration = 0;
  }

  /* ------------------------------ 等待条件 ------------------------------ */

  _notify(sample) {
    this._hub.notify(sample);
  }

  _failWaiters(error) {
    this._hub.fail(error);
  }

  /**
   * 见 bridge.js 的 createWaiterHub：连续 times 次成立才算稳。
   *
   * 已经判死时不必再等（不会有新采样了），但**soft 的等待要照 soft 的规矩收场**：
   * soft 的意思就是「等不到也让调用方继续往下走」。这里直接 reject 的话，
   * `_seekTo` 里紧跟在 settle 之后的那段关键帧补救会被整段跳过 ——
   * 落点退回目标之前的关键帧（10 秒 GOP 下差 4.8 秒），而上层对 seek 的失败是
   * 静默吞掉的，这个落后再也没人纠正。
   */
  _waitFor(predicate, options = {}) {
    if (this.lastError) return options.soft ? Promise.resolve(null) : Promise.reject(this.lastError);
    return this._hub.waitFor(predicate, options);
  }

  /* ------------------------------ 对外方法 ------------------------------ */

  async _send(code, value = 0, { timeoutMs = 1500 } = {}) {
    if (!this.hwnd) throw playerError('PotPlayer 还没准备好', 'PLAYER_NOT_READY');
    const results = await this.bridge.call(
      'pot',
      { hwnd: this.hwnd, timeout: 400, calls: [[code, value]] },
      { timeoutMs }
    );
    const first = Array.isArray(results) ? results[0] : null;
    if (first && first.err !== undefined) {
      if (first.err === ERROR_ACCESS_DENIED) {
        throw playerError('PotPlayer 以管理员身份运行，系统不允许遥控它。请用普通权限重开，或改回 mpv', 'PLAYER_ELEVATED');
      }
      throw playerError(`PotPlayer 拒绝了指令（${first.err}）`, 'PLAYER_UNREACHABLE');
    }
    return first ? first.v : 0;
  }

  setPause(paused) {
    return this._runCommand(() => this._setPauseInternal(paused));
  }

  async _setPauseInternal(paused) {
    const want = !!paused;
    await this._send(POT.SET_STATE, want ? POT_STATE.PAUSED : POT_STATE.PLAYING);
    const settled = await this._waitFor((s) => s.paused === want, {
      times: 2,
      timeoutMs: this.timing.pauseTimeoutMs,
      label: want ? '暂停' : '播放',
      soft: true,
    });
    return { settled: settled !== null, paused: want, position: this.position() };
  }

  seek(seconds) {
    return this._runCommand(() => this._seekTo(seconds));
  }

  /**
   * 跳转 + 关键帧补救。
   *
   * PotPlayer 的 0x5005 总是落到目标之前的那个关键帧，10 秒 GOP 下最远差 4.8 秒。
   * 补救办法是紧接着发一次「下一个关键帧」，落点就变成目标之后的第一个关键帧，
   * 然后原地暂停，等房间追上来再播（这一步由上层的同步引擎做）。
   *
   * 落点已经贴着目标时（比如跳到 0:00，本来就在关键帧上）不补救 —— 那一下会白白跳过一个 GOP。
   */
  async _seekTo(seconds) {
    const target = Math.max(0, Number(seconds) || 0);
    const deadline = monotonicMs() + this.timing.seekTimeoutMs;
    const left = () => Math.max(50, deadline - monotonicMs());
    const before = this._rawMs;

    await this._send(POT.SET_POSITION, Math.round(target * 1000));

    // 「离开旧值，且连续两次与播放速率自洽」：暂停时位置不该动，播放时只该按时间往前走。
    let previous = null;
    await this._waitFor(
      (s) => {
        if (s.rawMs === before) return false;
        const last = previous;
        previous = s;
        if (!last) return false;
        const moved = s.rawMs - last.rawMs;
        const expected = s.paused ? 0 : s.at - last.at;
        return Math.abs(moved - expected) <= 700;
      },
      { times: 2, timeoutMs: left(), label: '跳转', soft: true }
    );

    const landed = this._rawMs / 1000;
    // 已经判死的话轮询停了，_rawMs 停在跳转之前的那个数上 —— 拿它判断「落到哪儿了」
    // 只会得出错的结论（往回跳时它比目标大，看着像落点够靠前，其实照样落在目标之前的关键帧）。
    // 位置不明时一律补救：这一路的约定就是宁可停在房间前面等大家追上来。
    // 跳到片头那一下除外 —— 0:00 本来就在关键帧上，补一下反而跳过一个 GOP 的片头。
    const blind = this.lastError !== null && target > KEYFRAME_EPSILON;
    let keyframe = false;
    if (blind || landed < target - KEYFRAME_EPSILON) {
      await this._send(POT.SEND_COMMAND, POT_CMD_NEXT_KEYFRAME);
      await this._send(POT.SET_STATE, POT_STATE.PAUSED);
      await this._waitFor((s) => s.paused && s.rawMs / 1000 >= target - KEYFRAME_EPSILON, {
        times: 2,
        timeoutMs: left(),
        label: '关键帧补救',
        soft: true,
      });
      keyframe = true;
    }
    return { position: this.position(), target, keyframe, paused: keyframe || this._state !== POT_STATE.PLAYING };
  }

  /** 命令在途期间的 tick 一律标 cause:'cmd'，同步引擎只拿它更新基线，不做判定。 */
  async _runCommand(fn) {
    this._cmdDepth++;
    try {
      return await fn();
    } finally {
      this._cmdDepth--;
    }
  }

  /** 一闪而过的提示。PotPlayer 的 OSD 不能设时长，durationMs 只是接口对齐。 */
  osd(text, durationMs = 2000) {
    const body = clampText(text, 200);
    if (!body || !this.hwnd || this._closing) return Promise.resolve(false);
    void durationMs;
    return this.bridge
      .call('potSetString', { hwnd: this.hwnd, code: POT.SHOW_OSD, text: body }, { timeoutMs: 1500 })
      .then(() => true)
      .catch(() => false);
  }

  /**
   * 常驻横幅。PotPlayer 没有常驻覆盖层，真正画横幅的是覆盖窗，
   * 这里只负责把变化广播出去，顺带用 OSD 闪一下（覆盖窗被独占全屏挡住时还剩这一条路）。
   */
  setBanner(text) {
    const body = clampText(text, 200);
    if (body === this._banner) return false;
    this._banner = body;
    this.emit('banner', { text: body });
    if (body) this.osd(body);
    return true;
  }

  /**
   * 用户在覆盖窗的输入条里发的弹幕。外部播放器没有自己的输入框，
   * 这一路由主进程从覆盖窗转进来，再走和 mpv 一样的 chat-input 事件出去 ——
   * 这样 PlayerManager 的代际过滤对三个播放器是同一套。
   */
  deliverChatInput(payload) {
    this.emit('chat-input', { ...payload, kind: this.kind });
  }

  /* ------------------------------ 快照与退出 ------------------------------ */

  /** 外推后的播放位置。见文件头第 2 条。 */
  position() {
    if (!this._anchor) return 0;
    let seconds = this._anchor.ms / 1000;
    if (this._state === POT_STATE.PLAYING) {
      const elapsed = Math.max(0, (monotonicMs() - this._anchor.at) / 1000);
      seconds += Math.min(elapsed, POT_SAMPLE_INTERVAL);
    }
    const duration = this._durationMs / 1000;
    if (duration > 0) seconds = Math.min(seconds, duration);
    return seconds;
  }

  snapshot() {
    return {
      running: !!this.proc && !this.exited,
      position: this.position(),
      paused: this._state !== POT_STATE.PLAYING,
      duration: this._durationMs / 1000,
      streamPos: null, // PotPlayer 报不了读到文件哪个字节，卡顿预判那一路只能按时间折算
      idle: this._state <= POT_STATE.STOPPED,
      eof: this._eof,
      seeking: false,
      cause: this._cmdDepth > 0 ? 'cmd' : 'user',
      sampledAt: monotonicMs(),
    };
  }

  _emitTick({ force = false } = {}) {
    if (this._quiet && !force) return;
    this.emit('tick', this.snapshot());
  }

  _onProcExit(code) {
    this.exited = true;
    this._stopLoop();
    this._failWaiters(playerError('PotPlayer 已退出', 'PLAYER_GONE'));
    if (this._closing) return;
    this.emit('exit', { code, stderr: '' });
  }

  _fail(error) {
    if (this._closing || this.lastError) return;
    this.lastError = error;
    this._stopLoop();
    this._failWaiters(error);
    this.emit('error', error);
  }

  /** 进程真正退出才返回：删缓存之前必须等它放开文件句柄。 */
  async quit() {
    this._closing = true;
    this._stopLoop();
    this._failWaiters(playerError('PotPlayer 正在退出', 'PLAYER_CLOSING'));
    if (this.bridge) {
      this.bridge.off('copydata', this._onCopyData);
      this.bridge.off('win', this._onWinEvent);
      this.bridge.off('restart', this._onBridgeRestart);
      if (this.hwnd) {
        await this.bridge.call('close', { hwnd: this.hwnd }, { timeoutMs: 1500 }).catch(() => {});
      }
    }
    const done = await this._waitForExit(this.timing.quitTimeoutMs);
    if (this.bridge) {
      await this.bridge.call('untrack', {}, { timeoutMs: 1500 }).catch(() => {});
      if (this.pid) await this.bridge.call('forget', { pid: this.pid }, { timeoutMs: 1500 }).catch(() => {});
    }
    return done;
  }

  /**
   * 等进程落地。两个条件都要满足：子进程退了、窗口也没了 ——
   * PotPlayer64.exe 会再拉起 Mini 版然后自己先退，只看子进程会以为已经关干净了。
   */
  async _waitForExit(timeoutMs) {
    const deadline = monotonicMs() + timeoutMs;
    while (monotonicMs() < deadline) {
      const procDead = !this.proc || this.exited || this.proc.exitCode !== null || this.proc.signalCode !== null;
      let windowDead = true;
      if (this.hwnd && this.bridge) {
        try {
          const state = await this.bridge.call('winState', { hwnd: this.hwnd }, { timeoutMs: 1000 });
          windowDead = !state || !state.alive;
        } catch {
          windowDead = true;
        }
      }
      if (procDead && windowDead) return true;
      await delay(100);
    }
    try {
      if (this.proc) this.proc.kill();
    } catch {
      /* 已经没了 */
    }
    return false;
  }
}

module.exports = {
  EOF_MARGIN,
  KEYFRAME_EPSILON,
  POT,
  POT_CMD_NEXT_KEYFRAME,
  POT_SEEK_PRECISION,
  POT_STATE,
  PotAdapter,
  buildPotArgs,
  formatSeek,
};
