'use strict';

/**
 * 外部播放器桥（NoxReelPlayerBridge.exe）的 stdio 客户端。
 *
 * PotPlayer 和 MPC-BE 只能靠 Windows 窗口消息遥控，而本软件不引任何原生模块，
 * 于是把 Win32 调用关进一个随包附带的小程序里，这一层负责跟它对话：
 * 每行一条 JSON（NDJSON），请求带自增 id，回包按 id 认领，事件（ready/copydata/win/log）
 * 直接转成 EventEmitter 事件。
 *
 * 三条边界：
 *  1. **只认两个落点**：`resourcesPath/bin` 和仓库 `vendor/bin`。不走 findBin ——
 *     findBin 会查 PATH 和各家包管理器目录，任何人往 PATH 里放一个同名程序就能
 *     顶替掉它，而这个程序被允许对播放器窗口发消息。
 *  2. **请求一律有超时**：桥自己对播放器用的是 SendMessageTimeout，但播放器卡死时
 *     桥的线程池也可能排队，没有超时的话适配器会永远挂在 await 上。
 *  3. **stdin 一关桥就退出**（C# 侧的 ReadLoop 读到 EOF 就 ExitThread），
 *     所以 stop() 只要关掉 stdin 再等进程落地，不用先杀。
 */

const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { spawn: nodeSpawn } = require('child_process');

const BRIDGE_EXE = 'NoxReelPlayerBridge.exe';
/** 找不到桥时给用户看的原因。构建命令要跟 package.json 里的脚本名一致。 */
const BRIDGE_MISSING_MESSAGE = '桥接程序未构建（npm run build:bridge）';
const DEFAULT_TIMEOUT_MS = 3000;
const START_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = 2000;
/** 一行 NDJSON 的上限。桥自己把 JSON 限在 4MB，超过这个数只可能是输出错乱了。 */
const MAX_LINE_BYTES = 4 * 1024 * 1024;

/** 主进程单调时钟（毫秒）。适配器的采样时刻都取自这里，不受系统时间调整影响。 */
const monotonicMs = () => Number(process.hrtime.bigint()) / 1e6;

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * 桥接程序的候选路径，按优先级排列。只有这两处，见文件头第 1 条。
 * @param {{resourcesPath?: string, projectRoot?: string}} [opts]
 */
function bridgeCandidates({ resourcesPath, projectRoot } = {}) {
  const list = [];
  if (resourcesPath) list.push(path.join(resourcesPath, 'bin', BRIDGE_EXE));
  const root = projectRoot || path.join(__dirname, '..', '..', '..');
  list.push(path.join(root, 'vendor', 'bin', BRIDGE_EXE));
  return list.filter((p, i) => list.indexOf(p) === i);
}

/** @returns {string|null} 桥接程序绝对路径，没构建时返回 null。 */
function findBridge({ resourcesPath = process.resourcesPath, projectRoot, exists = isFile } = {}) {
  for (const candidate of bridgeCandidates({ resourcesPath, projectRoot })) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

function bridgeMissingError() {
  const error = new Error(BRIDGE_MISSING_MESSAGE);
  error.code = 'BRIDGE_MISSING';
  return error;
}

function invalidArg(label) {
  const error = new Error(`${label}不合法`);
  error.code = 'PLAYER_BAD_ARG';
  return error;
}

/** 逐码位判控制字符。不写成正则：这个仓库里的字面控制字符/反斜杠被工具多转义过不止一次。 */
function hasControlChar(text) {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * 命令行参数消毒。外部播放器的参数是拼在命令行上的：
 *  - 双引号会把我们加的引号闭合掉，后半截就变成另外的开关；
 *  - 前导 `/` 或 `-` 会被当成开关本身（`/volume=0` 这种恰恰是我们绝不能发的）；
 *  - 控制字符在某些播放器里会截断参数。
 * 三者一律拒绝，不做「转义后放行」—— 这里没有任何一个合法用例需要它们。
 */
function sanitizeArg(value, label = '播放器参数') {
  const text = String(value === undefined || value === null ? '' : value);
  if (!text) throw invalidArg(label);
  if (text.includes('"')) throw invalidArg(label);
  if (/^[/-]/.test(text)) throw invalidArg(label);
  if (hasControlChar(text)) throw invalidArg(label);
  return text;
}

/**
 * 片源规范化。链接统一走 `new URL().href`（大小写、默认端口、百分号编码都会被拉齐），
 * 只认 http/https，且不许带用户名密码 —— 那会把凭据写进命令行，任务管理器里人人可见。
 */
function normalizeSource(source) {
  const raw = String(source === undefined || source === null ? '' : source).trim();
  if (!raw) throw invalidArg('片源');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw invalidArg('媒体链接');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw invalidArg('媒体链接');
    return sanitizeArg(url.href, '媒体链接');
  }
  return sanitizeArg(raw, '媒体路径');
}

/**
 * 「等某个条件连续成立几次」的小机构，两个外部播放器的 settle 判据都是这个形状。
 *
 * 为什么非得「连续几次」：状态和位置不是同一时刻取回来的，单次读到目标值可能只是错位；
 * PotPlayer 启动后还会把我们发的暂停覆盖掉，所以 each 每轮补发一次。
 *
 * @param {{name?: string}} [opts] name 只出现在超时文案里
 */
function createWaiterHub({ name = '播放器' } = {}) {
  const waiters = new Set();
  return {
    get size() {
      return waiters.size;
    },
    /** 来了一份新采样（轮询结果或播放器推送）。 */
    notify(sample) {
      for (const waiter of [...waiters]) waiter.onSample(sample);
    },
    /** 出事了（进程退出、窗口没了、被提权挡住）：所有等待一起失败。 */
    fail(error) {
      for (const waiter of [...waiters]) waiter.onFail(error);
    },
    /**
     * @param {(sample: object) => boolean} predicate
     * @param {{times?: number, timeoutMs?: number, each?: Function, label?: string, soft?: boolean}} [opts]
     *   soft 为真时超时不抛错、返回 null —— 命令类的「上限」就是这么表达的：
     *   等不到也要让调用方继续走下去，下一条 tick 会带着真实状态回来。
     */
    waitFor(predicate, { times = 1, timeoutMs = 1000, each = null, label = '', soft = false } = {}) {
      return new Promise((resolve, reject) => {
        let hits = 0;
        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          waiters.delete(waiter);
          clearTimeout(timer);
          if (error) reject(error);
          else resolve(value);
        };
        const waiter = {
          onSample: (sample) => {
            if (each) {
              try {
                each();
              } catch {
                /* 补发失败下一轮再补 */
              }
            }
            if (predicate(sample)) {
              hits += 1;
              if (hits >= times) finish(null, sample);
            } else {
              hits = 0;
            }
          },
          onFail: (error) => finish(error),
        };
        const timer = setTimeout(() => {
          if (soft) return finish(null, null);
          const error = new Error(`等 ${name}${label ? ` ${label}` : ''} 超时`);
          error.code = 'PLAYER_TIMEOUT';
          finish(error);
        }, timeoutMs);
        if (timer.unref) timer.unref();
        waiters.add(waiter);
      });
    },
  };
}

class BridgeClient extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.exePath]    直接指定桥接程序路径（测试里用假的）
   * @param {Function} [opts.spawn]    child_process.spawn 的替身
   * @param {Function} [opts.find]     查找桥接程序的替身
   * @param {number} [opts.timeoutMs]  单条请求的默认超时
   * @param {number} [opts.maxRestarts] 桥意外退出后最多自动重启几次
   */
  constructor({ exePath, spawn = nodeSpawn, find = findBridge, timeoutMs = DEFAULT_TIMEOUT_MS, maxRestarts = 3 } = {}) {
    super();
    this.exePath = exePath || null;
    this.spawn = spawn;
    this.find = find;
    this.timeoutMs = timeoutMs;
    this.maxRestarts = maxRestarts;
    this.proc = null;
    this.ready = null; // ready 事件的内容：{version, hwnd, pid}
    this.restarts = 0;
    this.stopped = false;
    // 起来过一次之后，再起就是「重启」：适配器要靠 restart 事件重新 allow / track。
    this._everReady = false;
    this._starting = null;
    this._nextId = 1;
    this._pending = new Map();
    this._buffer = '';
    this._stderr = '';
  }

  get running() {
    return !!this.proc && this.ready !== null;
  }

  /** 桥自己那个消息窗口的 hwnd。MPC-BE 的 `/slave` 要把它写在命令行上。 */
  get hwnd() {
    return this.ready ? this.ready.hwnd : null;
  }

  /**
   * 启动（幂等）。已经起来了就直接返回；正在起就等同一个 promise ——
   * 两个适配器共用一个桥，切换播放器时两边会同时调到这里。
   */
  start() {
    if (this.running) return Promise.resolve(this.ready);
    if (this._starting) return this._starting;
    this.stopped = false;
    this._starting = this._start().finally(() => {
      this._starting = null;
    });
    return this._starting;
  }

  async _start() {
    const exe = this.exePath || this.find();
    if (!exe) throw bridgeMissingError();
    this.exePath = exe;

    const child = this.spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = child;
    this._buffer = '';
    this._stderr = '';
    this.ready = null;

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this._onData(chunk));
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        this._stderr = (this._stderr + chunk).slice(-2000);
      });
    }
    child.on('error', (error) => this._onExit(null, error));
    child.on('exit', (code) => this._onExit(code, null));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        this._kill();
        reject(new Error('桥接程序启动超时'));
      }, START_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        this.off('ready', onReady);
        this.off('exit', onExit);
      };
      const onReady = (info) => {
        cleanup();
        resolve(info);
      };
      const onExit = () => {
        cleanup();
        reject(new Error(`桥接程序启动失败：${this._stderr.trim() || '进程已退出'}`));
      };
      this.once('ready', onReady);
      this.once('exit', onExit);
    });
  }

  _onData(chunk) {
    this._buffer += chunk;
    if (this._buffer.length > MAX_LINE_BYTES) this._buffer = '';
    let index = this._buffer.indexOf('\n');
    while (index >= 0) {
      const line = this._buffer.slice(0, index).trim();
      this._buffer = this._buffer.slice(index + 1);
      if (line) this._onLine(line);
      index = this._buffer.indexOf('\n');
    }
  }

  _onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 桥偶尔会被别的库往 stdout 里塞东西，忽略不认识的行就是了
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.ev) {
      if (msg.ev === 'ready') {
        this.ready = { version: String(msg.version || ''), hwnd: Number(msg.hwnd) || 0, pid: Number(msg.pid) || 0 };
        this._everReady = true;
        this.emit('ready', this.ready);
        return;
      }
      this.emit(msg.ev, msg);
      return;
    }
    const pending = this._pending.get(msg.id);
    if (!pending) return;
    this._pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(new Error(String(msg.error || '桥接程序返回失败')));
  }

  _onExit(code, error) {
    const wasRunning = !!this.proc;
    this.proc = null;
    this.ready = null;
    const reason = error ? error.message : `桥接程序已退出（${code}）`;
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    this._pending.clear();
    if (!wasRunning) return;
    // 不是我们主动关的，就算一次意外退出。重启次数用完之后 call() 直接拒绝，
    // 免得一个一启动就崩的桥被无限拉起。
    if (!this.stopped) this.restarts++;
    this.emit('exit', { code, error: error ? error.message : null });
  }

  _kill() {
    const proc = this.proc;
    if (!proc) return;
    try {
      proc.kill();
    } catch {
      /* 已经没了 */
    }
  }

  /**
   * 发一条指令。桥没起来（或上次意外退出了）就先起 ——
   * 自动重启有次数上限：桥要是一启动就崩，无限重启只会把日志刷爆。
   */
  async call(cmd, payload = {}, { timeoutMs = this.timeoutMs } = {}) {
    if (this.stopped) throw new Error('桥接程序已关闭');
    if (!this.running) {
      if (this.restarts >= this.maxRestarts) throw new Error('桥接程序反复退出，已停止重试');
      // 之前起来过，说明这次是重启：allow / track 这些登记都随旧进程没了，
      // 适配器要靠 restart 事件重新登记一遍。
      const reborn = this._everReady;
      const info = await this.start();
      if (reborn) this.emit('restart', info);
    }
    const id = this._nextId++;
    const line = `${JSON.stringify({ ...payload, id, cmd })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`桥接程序无响应：${cmd}`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(line);
      } catch (error) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  /** 关掉桥：关 stdin 让它自己退，超时才杀。之后 call() 一律拒绝。 */
  async stop() {
    this.stopped = true;
    const proc = this.proc;
    if (!proc) return true;
    const exited = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._kill();
        resolve(false);
      }, STOP_TIMEOUT_MS);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    try {
      proc.stdin.end();
    } catch {
      this._kill();
    }
    return exited;
  }
}

/* --------------------------- 全进程共用的一个桥 --------------------------- */

let shared = null;

/**
 * 两个外部播放器适配器共用同一个桥进程：它一个人就能管所有窗口，
 * 而每多起一个进程就多一处要在退出时收拾的东西。
 */
function sharedBridge(options) {
  if (!shared || shared.stopped) shared = new BridgeClient(options);
  return shared;
}

async function closeSharedBridge() {
  if (!shared) return;
  const client = shared;
  shared = null;
  await client.stop().catch(() => {});
}

module.exports = {
  BRIDGE_EXE,
  BRIDGE_MISSING_MESSAGE,
  BridgeClient,
  bridgeCandidates,
  bridgeMissingError,
  closeSharedBridge,
  createWaiterHub,
  findBridge,
  monotonicMs,
  normalizeSource,
  sanitizeArg,
  sharedBridge,
};
