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
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { randomBytes } = require('crypto');
const { findBin } = require('./findBin');
const { findYtDlp } = require('./linkMedia');

// 我们关心的属性。stream-pos 是字节位置 —— 这个比 time-pos 更适合跟连续水位线比，
// 因为不用靠码率去猜时间和字节的换算。
const OBSERVED = ['time-pos', 'pause', 'duration', 'stream-pos', 'core-idle', 'eof-reached', 'seeking'];

// 覆盖层的虚拟画布。字号按它定，窗口化和全屏下横幅大小才一致。
const OVERLAY_RES_X = 1280;
const OVERLAY_RES_Y = 720;

/** 房间状态横幅固定占这一层，不让调用方随便分配 id。 */
const OVERLAY_ROOM = 1;

/**
 * 弹幕固定占这一层。和横幅分层是必须的：横幅几分钟才换一次文本，弹幕每秒重画 30 次，
 * 挤在同一层上，横幅会被每一帧弹幕覆盖掉。
 */
const OVERLAY_DANMAKU = 2;

/** 一帧最多画几条。同时飞 60 条已经糊成一片，再多只是白烧 CPU 和带宽。 */
const MAX_DANMAKU_ITEMS = 60;

/**
 * 单条弹幕的字数上限，和 lib/chat.js 的 MAX_TEXT 是同一个数（有测试钉住）。
 * 播放器里发回来的文本也按它截断 —— 脚本是我们自己的，但截断这一刀由主进程落。
 */
const MAX_DANMAKU_TEXT = 200;

/**
 * 坐标的兜底范围。长弹幕刚出场时 x 是很大的正数、快走完时是很大的负数
 * （整条还在屏幕左边外面），所以这不是屏幕尺寸，只是挡住畸形值的护栏。
 */
const MAX_OVERLAY_COORD = 100_000;

/** 覆盖层虚拟画布的允许范围，两边都是像素。 */
const MIN_OVERLAY_SIZE = 16;
const MAX_OVERLAY_SIZE = 16_384;

/** 播放器内发弹幕的 Lua 脚本文件名，以及它回传消息时用的 script-message 名字。 */
const CHAT_SCRIPT_FILE = 'noxreel-chat.lua';
const CHAT_MESSAGE_NAME = 'noxreel-chat';

/** mpv JSON IPC 一行的上限。正常的回包和事件都是几百字节，1MB 已经宽松得离谱。 */
const MAX_IPC_LINE = 1024 * 1024;

/**
 * 覆盖层文本的清洗。这一步不是排版，是防注入。
 *
 * 横幅里会拼进别人的昵称，而 ASS 把花括号当样式覆盖块、把反斜杠当转义引导符。
 * 不清掉的话，对方把昵称改成一个覆盖块就能把横幅挪走甚至整条隐形 ——
 * 等于用昵称关掉别人的状态提示。
 *
 * 选择「丢掉」而不是「转义」：ASS 没有通用的字面反斜杠写法，丢掉是唯一守得住的。
 * 昵称里带花括号的情况极少，丢掉不会有人受影响。换行由我们在清洗之后自己插入，
 * 所以 ASS 的换行标记只可能来自我们。
 *
 * 用码点判断而不是正则字符类：反斜杠字面量经过多层工具极易被多转义一层，
 * 这里一个反斜杠都不写，就没有这个风险。92=反斜杠，123/125=花括号。
 */
const ASS_DROP = new Set([92, 123, 125]);

function escapeAss(text) {
  let out = '';
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) {
      out += ' ';
      continue;
    }
    if (ASS_DROP.has(code)) continue;
    out += ch;
  }
  return out;
}

function buildAssEvent(text) {
  const lines = String(text == null ? '' : text).split('\n').map(escapeAss);
  // an8=顶部居中，避开底部的 OSC 控制条；描边跟 --osd-outline-color 保持一致
  return `{\\an8}{\\fs34}{\\bord2}{\\shad0}{\\1c&HFFFFFF&}{\\3c&H000000&}${lines.join('\\N')}`;
}

/** 按码点截断：按 .length 截会把 emoji 劈成半个代理对，拼进 ASS 就是个乱码方块。 */
function sliceCodePoints(text, max) {
  const chars = Array.from(String(text == null ? '' : text));
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('');
}

function clampNumber(value, lo, hi, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return n < lo ? lo : n > hi ? hi : n;
}

/** 不透明度（0–1）换成 ASS 的 alpha 字节。ASS 里反着来：00 是完全不透明，FF 是全透明。 */
function assAlpha(opacity) {
  const clamped = clampNumber(opacity, 0, 1, 1);
  return Math.round((1 - clamped) * 255).toString(16).toUpperCase().padStart(2, '0');
}

/**
 * 把一帧弹幕拼成一条 osd-overlay 的数据。
 *
 * mpv 把 data 按换行拆成多条 ASS 事件，所以每条弹幕占一行、各自带 \pos。
 * 为什么必须逐帧重拼、而不是用 \move 让 mpv 自己动：覆盖层的渲染时间恒为 0
 * （sub/osd_libass.c），按时间插值的标签在这一层上一动不动。
 *
 * 正文先过 escapeAss：花括号和反斜杠被丢掉、控制字符换成空格。于是别人的弹幕
 * 既拼不出样式覆盖块（能把整屏弹幕挪走或者变透明），也拼不出第二条事件 ——
 * 换行是事件之间的分隔符，只可能由我们插入。
 */
function buildDanmakuAss(items) {
  const lines = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    const text = escapeAss(sliceCodePoints(item.text, MAX_DANMAKU_TEXT));
    if (!text.trim()) continue;
    const x = Math.round(clampNumber(item.x, -MAX_OVERLAY_COORD, MAX_OVERLAY_COORD, 0));
    const y = Math.round(clampNumber(item.y, -MAX_OVERLAY_COORD, MAX_OVERLAY_COORD, 0));
    const fontSize = Math.round(clampNumber(item.fontSize, 8, 200, 28));
    // 自己发的那条描边更粗、换成品牌色，一屏几十条里一眼能认出哪句是自己说的
    const mine = item.outline === true;
    lines.push(
      `{\\an7}{\\pos(${x},${y})}{\\fs${fontSize}}{\\bord${mine ? '2.4' : '1.2'}}{\\shad0}` +
        `{\\1c&HFFFFFF&}{\\3c&H${mine ? 'FF8D4C' : '000000'}&}{\\alpha&H${assAlpha(item.opacity)}&}${text}`
    );
    if (lines.length >= MAX_DANMAKU_ITEMS) break;
  }
  return lines.join('\n');
}

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
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'mpv', 'mpv.exe'),
];

// C:\ 根目录下的文件夹任何本机账户都能建，别人放一个冒名的 mpv.exe 进去，我们就会以当前用户身份
// 运行它。所以这类位置排在所有包管理器落点之后，只在别处都找不到时才用（见 findBin 的 fallbackCandidates）。
const MPV_FALLBACK_CANDIDATES = ['C:\\mpv\\mpv.exe'];

/**
 * 远程源允许 ffmpeg 用到的协议。tcp / tls / httpproxy 是 http(s) 经代理时的底层，crypto 是加密 HLS。
 * 不在里面的（ftp、rtmp、rtsp……）一律打不开 —— 它们不走 HTTP 代理，放行就等于绕过了私网过滤。
 * mpv 的 ytdl_hook 会把 yt-dlp 给的 ftp / rtmp 地址原样交给 ffmpeg（实测会直连局域网）。
 */
const REMOTE_PROTOCOLS = 'http,https,tls,tcp,crypto,httpproxy,data';

/**
 * 和网络有关的启动参数。
 *
 * 远程源：
 *  - --http-proxy 让 ffmpeg 的每个 http(s) 请求（含跳转、HLS 分段）都经过本机过滤代理；
 *  - ytdl_hook **不会**把 --http-proxy 转给 yt-dlp（mpv v0.41 实测：不加这一条时 yt-dlp 直连内网），
 *    要经 ytdl-raw-options 单独给它一个 --proxy；
 *  - 协议白名单堵住不走 HTTP 代理的那些协议。
 * 本地文件：
 *  - --access-references=no：收到的「片子」可以是改了扩展名的 m3u / pls / EDL / HLS 播放列表，
 *    mpv 会照着里面的地址去连（实测连 ftp:// 都会发起 TCP 连接）。正常的 MKV / MP4 不受影响；
 *  - 代理照样挂上（有的话），多一道兜底。
 */
function networkArgs({ isRemote, proxy }) {
  const args = [];
  if (proxy) args.push(`--http-proxy=${proxy}`);
  if (!isRemote) {
    args.push('--access-references=no');
    return args;
  }
  if (proxy) args.push(`--ytdl-raw-options-append=proxy=${proxy}`);
  args.push(
    `--stream-lavf-o-append=protocol_whitelist=${REMOTE_PROTOCOLS}`,
    `--demuxer-lavf-o-append=protocol_whitelist=${REMOTE_PROTOCOLS}`
  );
  return args;
}

/**
 * 子进程的环境：去掉 no_proxy。ffmpeg 会读它，命中的主机直接绕过 --http-proxy ——
 * 用户环境里一句 no_proxy=* 就能让整道私网过滤失效。
 */
function childEnv(base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'no_proxy') delete env[key];
  }
  return env;
}

function buildLaunchArgs({
  ipcPath,
  source,
  startPaused = true,
  startAt = 0,
  muted = false,
  ytDlp = null,
  headers = {},
  chatScript = null,
  chatPrompt = '',
  proxy = null,
} = {}) {
  const isRemote = /^https?:\/\//i.test(source);
  return [
    '--no-config',
    `--input-ipc-server=${ipcPath}`,
    '--idle=yes',
    '--force-window=yes',
    '--keep-open=yes',
    '--cache=yes',
    '--cache-on-disk=no',
    '--osd-level=1',
    '--osd-on-seek=msg-bar',
    '--osd-font=Segoe UI',
    '--osd-font-size=28',
    '--osd-color=#FFFFFFFF',
    '--osd-outline-color=#B0000000',
    '--osd-back-color=#66070C17',
    '--osd-bar-marker-style=line',
    '--background-color=#030711',
    '--cursor-autohide=700',
    '--input-default-bindings=yes',
    '--osc=yes',
    '--script-opt=osc-layout=bottombar',
    '--script-opt=osc-seekbarstyle=bar',
    '--script-opt=osc-hidetimeout=900',
    '--script-opt=osc-fadeduration=180',
    '--script-opt=osc-fadein=yes',
    '--script-opt=osc-boxalpha=72',
    '--script-opt=osc-barmargin=8',
    '--script-opt=osc-scalewindowed=1.12',
    '--script-opt=osc-scalefullscreen=1.12',
    '--script-opt=osc-seekrangestyle=line',
    '--script-opt=osc-seekrangealpha=92',
    '--script-opt=osc-background_color=#070C17',
    '--script-opt=osc-timecode_color=#E6EDF3',
    '--script-opt=osc-title_color=#E6EDF3',
    '--script-opt=osc-buttons_color=#E6EDF3',
    '--script-opt=osc-top_buttons_color=#AEBBD0',
    '--script-opt=osc-held_element_color=#4C8DFF',
    '--script-opt=osc-time_pos_color=#4C8DFF',
    '--script-opt=osc-windowcontrols=yes',
    '--script-opt=osc-windowcontrols_alignment=right',
    '--script-opt=osc-windowcontrols_title=NoxReel · ${media-title}',
    '--script-opt=osc-title=NoxReel · ${media-title}',
    '--autofit=960x540',
    '--autofit-larger=92%x88%',
    `--pause=${startPaused ? 'yes' : 'no'}`,
    // 换播放器、重开播放器时直接从房间当前位置起，省得先从片头解码一段再跳
    ...(startAt > 0 ? [`--start=${Number(startAt).toFixed(3)}`] : []),
    // 只有开发期的自动化测试会要静音
    ...(muted ? ['--mute=yes'] : []),
    '--title=NoxReel · ${media-title}',
    ...(process.platform === 'win32'
      ? ['--border=no', '--window-corners=round', '--backdrop-type=mica']
      : []),
    ...(!isRemote ? ['--load-scripts=no', '--ytdl=no'] : []),
    ...(isRemote ? ['--load-scripts=no', '--ytdl=yes', '--script-opt=ytdl_hook-try_ytdl_first=yes'] : []),
    ...(ytDlp ? [`--script-opt=ytdl_hook-ytdl_path=${ytDlp}`] : []),
    ...(isRemote
      ? Object.entries(headers).map(([name, value]) => `--http-header-fields-append=${name}: ${value}`)
      : []),
    ...networkArgs({ isRemote, proxy }),
    // 播放器内发弹幕的脚本。只许这一条，而且必须是绝对路径：--load-scripts=no 仍然在，
    // 用户配置目录里的脚本一个都不会被加载，能进来的只有我们自己这一个文件。
    ...(chatScript && path.isAbsolute(chatScript)
      ? [`--script=${chatScript}`, ...(chatPrompt ? [`--script-opt=noxreel_chat-prompt=${chatPrompt}`] : [])]
      : []),
    '--',
    source,
  ];
}

/**
 * 播放器内发弹幕的 Lua 脚本在哪。打包时它单独放在 resources/mpv-scripts 下 ——
 * 塞进 asar 里 mpv 根本读不到，asar 只有 Electron 自己认。
 *
 * 和 media.js 的 toolCandidates 一样把参数摊开，才测得到打包后的那条分支：
 * 开发机上 process.resourcesPath 是 undefined，直接断言只能测到一半。
 */
function chatScriptCandidates({ resourcesPath = process.resourcesPath, dirname = __dirname } = {}) {
  return [
    ...(resourcesPath ? [path.join(resourcesPath, 'mpv-scripts', CHAT_SCRIPT_FILE)] : []),
    path.join(dirname, '..', '..', 'resources', 'mpv-scripts', CHAT_SCRIPT_FILE),
  ];
}

/** 找不到就返回 null：脚本缺了只是播放器里发不了弹幕，房间窗口里的输入框照常能用。 */
function findChatScript(opts) {
  for (const candidate of chatScriptCandidates(opts)) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

/** 返回 mpv 可执行文件路径，找不到返回 null。 */
function findMpv() {
  return findBin('mpv', {
    envVar: 'SYNCWATCH_MPV_PATH',
    candidates: process.platform === 'win32' ? MPV_CANDIDATES : [],
    fallbackCandidates: process.platform === 'win32' ? MPV_FALLBACK_CANDIDATES : [],
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
    this._skipLine = false;
    this.props = Object.create(null);
    this.running = false;
    // 每个覆盖层上一次发过去的文本，用来去重，见 setOverlay
    this._overlays = new Map();
    // 弹幕层的状态。弹幕帧不进 _overlays 那张去重表：那张表按「文本没变就不发」去重，
    // 而弹幕每帧的坐标都不一样，进去只会白占内存，还会把横幅的去重搅乱。
    this._danmaku = { inFlight: false, visible: false };
    // pause/seek 在途的条数。这两条是用户等着看结果的命令，不能让 30Hz 的弹幕帧排在前面。
    this._cmdHold = 0;
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
  async launch(filePath, { startPaused = true, startAt = 0, muted = false, headers = {}, chatPrompt = '', proxy = null } = {}) {
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
    const args = buildLaunchArgs({
      ipcPath,
      source: filePath,
      startPaused,
      startAt,
      muted,
      ytDlp,
      headers,
      chatScript: findChatScript(),
      chatPrompt,
      proxy,
    });

    this.proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false, env: childEnv() });
    this.running = true;
    // 新进程身上没有任何覆盖层，缓存必须跟着清零，否则重开播放器后
    // setOverlay 会以为「文本没变」而不再发送，横幅再也不出现。
    this.forgetOverlays();
    this._resetDanmaku();

    let stderr = '';
    this.proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 8192) stderr = stderr.slice(-4096);
    });
    this.proc.on('exit', (code) => {
      this.running = false;
      this.forgetOverlays();
      this._resetDanmaku();
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
    this.buf = '';
    this._skipLine = false;
    this.sock.setEncoding('utf8');
    this.sock.on('data', (d) => this._onData(d));
    this.sock.on('close', () => this._failAllPending(new Error('mpv IPC 连接已关闭')));
    this.sock.on('error', (e) => this.emit('error', e));
  }

  _onData(data) {
    // 一行都没凑齐就已经超过上限：丢掉这一行剩下的部分，直到下一个换行。
    // 我们要的回包和事件都是几百字节；不设限的话，一行没有尽头的输出会让缓冲一直涨到内存耗尽。
    if (this._skipLine) {
      const nl = data.indexOf('\n');
      if (nl === -1) return;
      this._skipLine = false;
      data = data.slice(nl + 1);
    }
    this.buf += data;
    let idx;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line || line.length > MAX_IPC_LINE) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this._dispatch(msg);
    }
    if (this.buf.length > MAX_IPC_LINE) {
      this.buf = '';
      this._skipLine = true;
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

    // 播放器里按快捷键发的弹幕。脚本是我们自己的，但文本仍按聊天上限截断了才往外转：
    // 这一刀落在主进程，渲染进程那边的清洗是第二道，不是唯一一道。
    if (
      msg.event === 'client-message' &&
      Array.isArray(msg.args) &&
      msg.args[0] === CHAT_MESSAGE_NAME &&
      typeof msg.args[1] === 'string'
    ) {
      const text = sliceCodePoints(msg.args[1], MAX_DANMAKU_TEXT);
      if (text) this.emit('chat-input', { text });
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

  /**
   * 命令在途期间挂起弹幕帧。返回的仍是原来那个 promise，调用方照常能收到失败。
   *
   * 为什么要挂：暂停和跳转是用户等着看结果的，而弹幕每秒 30 帧 —— 排在它们前面的
   * 每一帧都是实打实的延迟。丢几帧弹幕没人看得出来，晚半秒暂停是所有人都看得出来的。
   */
  _hold(promise) {
    this._cmdHold++;
    const done = () => {
      this._cmdHold--;
    };
    promise.then(done, done);
    return promise;
  }

  setPause(paused) {
    return this._hold(this.command(['set_property', 'pause', !!paused]));
  }

  seek(seconds) {
    return this._hold(this.command(['seek', seconds, 'absolute', 'exact']));
  }

  getProperty(name) {
    return this.command(['get_property', name]);
  }

  /** 在 mpv 画面上打一行字，用来告诉用户「在等谁」。转瞬即逝，用于对某个动作的即时回应。 */
  osd(text, durationMs = 2000) {
    return this.command(['show-text', text, durationMs]).catch(() => {});
  }

  /**
   * 常驻覆盖层。和 show-text 是两条独立通道 —— 这一点正是选它的理由：
   * 进度条（--osd-on-seek=msg-bar）、音量提示、以及我们自己那些一次性提示全都走
   * show-text，用一条要挂好几分钟的横幅去挤那个槽位，用户一调音量横幅就没了。
   *
   * 全员暂停时房间信息只能靠这条路送到用户眼前：mpv 是独立窗口，全屏之后
   * Electron 那边的横幅、成员列表、日志他一个都看不见。
   */
  setOverlay(id, text) {
    const next = String(text || '');
    // renderStatus 每个 tick 都会调一次，文本没变就别发 —— 否则高负载下
    // 这条 socket 上每秒十几个命令，会和 pause/seek 抢队列。
    if (this._overlays.get(id) === next) return Promise.resolve();
    this._overlays.set(id, next);
    if (!next) return this.command(['osd-overlay', id, 'none', '']).catch(() => {});
    return this.command([
      'osd-overlay',
      id,
      'ass-events',
      buildAssEvent(next),
      OVERLAY_RES_X,
      OVERLAY_RES_Y,
      0,
    ]).catch(() => {});
  }

  /** 新起的 mpv 身上没有任何覆盖层，缓存必须跟着清，否则重开播放器后横幅再也不会重发。 */
  forgetOverlays() {
    this._overlays.clear();
  }

  /**
   * 画一帧弹幕。返回 true 表示真发出去了，false 表示这一帧被丢掉。
   *
   * 三道闸，一律「宁可丢帧也不排队」：同一时间只有一帧在途；pause/seek 在途时不发；
   * 没连上播放器时不发。弹幕是此刻的画面，攒一帧到几百毫秒后再画没有任何意义，
   * 反而会把这条 socket 上的控制命令挤到后面去。
   */
  setDanmakuFrame(frame) {
    const data = buildDanmakuAss(frame && frame.items);
    // 这一帧一条都没有：把上一帧留在画面上的字清掉
    if (!data) return this.clearDanmaku();
    if (!this.sock || this.sock.destroyed) return false;
    if (this._danmaku.inFlight || this._cmdHold > 0) return false;
    const width = Math.round(clampNumber(frame.w, MIN_OVERLAY_SIZE, MAX_OVERLAY_SIZE, OVERLAY_RES_X));
    const height = Math.round(clampNumber(frame.h, MIN_OVERLAY_SIZE, MAX_OVERLAY_SIZE, OVERLAY_RES_Y));
    this._danmaku.visible = true;
    this._danmaku.inFlight = true;
    const done = () => {
      this._danmaku.inFlight = false;
    };
    this.command(['osd-overlay', OVERLAY_DANMAKU, 'ass-events', data, width, height, 0]).then(done, done);
    return true;
  }

  /**
   * 清掉弹幕层。这一条不受「同一时间只有一帧在途」约束 —— 它是状态变化，不是画面刷新：
   * 用户刚关掉弹幕，正好撞上一帧在途就被丢掉的话，最后那一屏字会一直挂在画面上。
   * socket 上的写入是有序的，所以它一定排在那一帧之后被 mpv 执行。
   */
  clearDanmaku() {
    if (!this._danmaku.visible) return false;
    this._danmaku.visible = false;
    if (!this.sock || this.sock.destroyed) return false;
    this.command(['osd-overlay', OVERLAY_DANMAKU, 'none', '']).catch(() => {});
    return true;
  }

  /** 新进程身上没有任何覆盖层，弹幕层这边的状态也要跟着清零。 */
  _resetDanmaku() {
    this._danmaku.inFlight = false;
    this._danmaku.visible = false;
    this._cmdHold = 0;
  }

  /**
   * 等进程真正退出。quit() 只等 IPC 回包，进程落地要晚几百毫秒 ——
   * 这期间文件句柄还开着，删缓存会失败。超时就强杀。
   */
  waitForExit(timeoutMs = 3000) {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {}
        resolve(false);
      }, timeoutMs);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
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

module.exports = {
  MpvController,
  findMpv,
  findChatScript,
  chatScriptCandidates,
  OBSERVED,
  buildLaunchArgs,
  buildAssEvent,
  buildDanmakuAss,
  escapeAss,
  sliceCodePoints,
  OVERLAY_ROOM,
  OVERLAY_DANMAKU,
  MAX_DANMAKU_ITEMS,
  MAX_DANMAKU_TEXT,
  MAX_OVERLAY_COORD,
  MIN_OVERLAY_SIZE,
  MAX_OVERLAY_SIZE,
  CHAT_SCRIPT_FILE,
  CHAT_MESSAGE_NAME,
  MAX_IPC_LINE,
  REMOTE_PROTOCOLS,
  networkArgs,
  childEnv,
};
