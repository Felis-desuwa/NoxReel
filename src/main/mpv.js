'use strict';

/**
 * mpv JSON IPC 控制器（参考 Syncplay 的做法：不自研播放器，控制外部播放器）。
 *
 * Windows 上 mpv 的 IPC 是命名管道（\\.\pipe\xxx），Linux/macOS 是 unix socket，
 * Node 的 net.connect({path}) 两边都能用同一套代码。
 *
 * 协议：一行一个 JSON，\n 结尾。请求带 request_id，回包用同一个 id 对上。
 * 属性变化通过 observe_property 主动推过来，不用轮询。
 */

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { randomBytes } = require('crypto');
const { findBin } = require('./findBin');
const { findYtDlp } = require('./linkMedia');

// 我们关心的属性。stream-pos 是字节位置 —— 这个比 time-pos 更适合跟连续水位线比，
// 因为不用靠码率去猜时间和字节的换算。
const OBSERVED = ['time-pos', 'pause', 'duration', 'stream-pos', 'core-idle', 'eof-reached', 'seeking'];

// mpv 特有的安装位置。'MPV Player' 是 winget 上 shinchiro.mpv（最主流的包）的落点，
// 它既不进 PATH 也不叫 'mpv'，光靠通用规则找不到。
const MPV_CANDIDATES = [
  ...(process.resourcesPath
    ? [path.join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'mpv.exe' : 'mpv')]
    : []),
  path.join(__dirname, '..', '..', 'vendor', 'bin', process.platform === 'win32' ? 'mpv.exe' : 'mpv'),
  'C:\\Program Files\\MPV Player\\mpv.exe',
  'C:\\Program Files (x86)\\MPV Player\\mpv.exe',
  'C:\\Program Files\\mpv\\mpv.exe',
  'C:\\Program Files (x86)\\mpv\\mpv.exe',
  'C:\\mpv\\mpv.exe',
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'mpv', 'mpv.exe'),
];

/** 返回 mpv 可执行文件路径，找不到返回 null。 */
function findMpv() {
  return findBin('mpv', {
    envVar: 'SYNCWATCH_MPV_PATH',
    candidates: process.platform === 'win32' ? MPV_CANDIDATES : [],
  });
}

class MpvController extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.sock = null;
    this.reqId = 1;
    this.pending = new Map();
    this.buf = '';
    this.props = Object.create(null);
    this.running = false;
  }

  _ipcPath() {
    const token = randomBytes(16).toString('hex');
    return process.platform === 'win32'
      ? `\\\\.\\pipe\\noxreel-${token}`
      : path.join(os.tmpdir(), `noxreel-${token}.sock`);
  }

  /**
   * 启动 mpv 并接管它。
   * 关键参数说明：
   *  --keep-open=yes    播完不退出，否则窗口一关我们就断联
   *  --idle=yes         没片时也保持进程
   *  --cache=yes        让 mpv 自己也缓冲一层
   *  --pause=yes        先暂停，等同步引擎决定什么时候放
   */
  async launch(filePath, { startPaused = true } = {}) {
    if (this.running) await this.quit();

    const bin = findMpv();
    if (!bin) {
      const err = new Error('没找到 mpv。请安装后重试（winget install mpv 或 scoop install mpv），或设置环境变量 SYNCWATCH_MPV_PATH 指向 mpv.exe');
      err.code = 'MPV_NOT_FOUND';
      throw err;
    }

    const ipcPath = this._ipcPath();
    const isRemote = /^https?:\/\//i.test(filePath);
    const ytDlp = isRemote ? findYtDlp() : null;
    const args = [
      `--input-ipc-server=${ipcPath}`,
      '--idle=yes',
      '--force-window=yes',
      '--keep-open=yes',
      '--cache=yes',
      '--osd-level=1',
      `--pause=${startPaused ? 'yes' : 'no'}`,
      '--title=NoxReel',
      ...(isRemote ? ['--ytdl=yes', '--script-opts-append=ytdl_hook-try_ytdl_first=yes'] : []),
      ...(ytDlp ? [`--script-opts-append=ytdl_hook-ytdl_path=${ytDlp}`] : []),
      '--',
      filePath,
    ];

    this.proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false });
    this.running = true;

    let stderr = '';
    this.proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 8192) stderr = stderr.slice(-4096);
    });
    this.proc.on('exit', (code) => {
      this.running = false;
      this._failAllPending(new Error('mpv 已退出'));
      this.emit('exit', { code, stderr: stderr.slice(-1000) });
    });
    this.proc.on('error', (e) => {
      this.running = false;
      this.emit('error', e);
    });

    await this._connectWithRetry(ipcPath);

    for (let i = 0; i < OBSERVED.length; i++) {
      this.command(['observe_property', i + 1, OBSERVED[i]]).catch(() => {});
    }

    this.emit('launched', { bin, filePath });
    return { bin, filePath };
  }

  /** mpv 起来到管道可用之间有个时间差，得重试。 */
  async _connectWithRetry(ipcPath, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
      if (!this.running) throw new Error('mpv 在建立 IPC 连接前就退出了');
      try {
        this.sock = await this._connectOnce(ipcPath);
        this._wireSocket();
        return;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 120));
      }
    }
    throw new Error(`连接 mpv IPC 超时：${lastErr && lastErr.message}`);
  }

  _connectOnce(ipcPath) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ path: ipcPath });
      const onErr = (e) => {
        sock.destroy();
        reject(e);
      };
      sock.once('error', onErr);
      sock.once('connect', () => {
        sock.off('error', onErr);
        resolve(sock);
      });
    });
  }

  _wireSocket() {
    this.sock.setEncoding('utf8');
    this.sock.on('data', (d) => this._onData(d));
    this.sock.on('close', () => this._failAllPending(new Error('mpv IPC 连接已关闭')));
    this.sock.on('error', (e) => this.emit('error', e));
  }

  _onData(data) {
    this.buf += data;
    let idx;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (msg.request_id !== undefined && this.pending.has(msg.request_id)) {
      const { resolve, reject } = this.pending.get(msg.request_id);
      this.pending.delete(msg.request_id);
      if (msg.error && msg.error !== 'success') reject(new Error(`mpv: ${msg.error}`));
      else resolve(msg.data);
      return;
    }

    if (msg.event === 'property-change') {
      this.props[msg.name] = msg.data;
      this.emit('property', { name: msg.name, value: msg.data });
      this.emit('tick', this.snapshot());
      return;
    }

    if (msg.event) this.emit('mpv-event', msg);
  }

  _failAllPending(err) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  /** 当前播放状态快照，同步引擎和 UI 都读这个。 */
  snapshot() {
    return {
      running: this.running,
      position: typeof this.props['time-pos'] === 'number' ? this.props['time-pos'] : 0,
      paused: this.props['pause'] !== false,
      duration: typeof this.props['duration'] === 'number' ? this.props['duration'] : 0,
      streamPos: typeof this.props['stream-pos'] === 'number' ? this.props['stream-pos'] : null,
      idle: this.props['core-idle'] === true,
      eof: this.props['eof-reached'] === true,
      seeking: this.props['seeking'] === true,
    };
  }

  command(cmd) {
    if (!this.sock || this.sock.destroyed) return Promise.reject(new Error('mpv 未连接'));
    const request_id = this.reqId++;
    const line = JSON.stringify({ command: cmd, request_id }) + '\n';
    return new Promise((resolve, reject) => {
      this.pending.set(request_id, { resolve, reject });
      this.sock.write(line, (err) => {
        if (err) {
          this.pending.delete(request_id);
          reject(err);
        }
      });
      setTimeout(() => {
        if (this.pending.has(request_id)) {
          this.pending.delete(request_id);
          reject(new Error(`mpv 命令超时：${JSON.stringify(cmd)}`));
        }
      }, 5000);
    });
  }

  setPause(paused) {
    return this.command(['set_property', 'pause', !!paused]);
  }

  seek(seconds) {
    return this.command(['seek', seconds, 'absolute', 'exact']);
  }

  getProperty(name) {
    return this.command(['get_property', name]);
  }

  /** 在 mpv 画面上打一行字，用来告诉用户「在等谁」。 */
  osd(text, durationMs = 2000) {
    return this.command(['show-text', text, durationMs]).catch(() => {});
  }

  async quit() {
    if (!this.running) return;
    try {
      await this.command(['quit']);
    } catch {
      if (this.proc) this.proc.kill();
    }
    this.running = false;
    if (this.sock) this.sock.destroy();
    this.sock = null;
  }
}

module.exports = { MpvController, findMpv, OBSERVED };
