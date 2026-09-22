'use strict';

/**
 * 覆盖窗：贴在外部播放器（PotPlayer / MPC-BE）身上的那一层弹幕。
 *
 * 内置 mpv 有 osd-overlay，弹幕直接画进播放器自己的字幕层；外部播放器没有这种口子，
 * 只能另开一个透明、点击穿透的窗口压在它的客户区上。麻烦全在「贴」这个字上：
 *
 *  - **几何**：桥接程序报的是屏幕物理像素，Electron 的窗口坐标是 DIP，中间隔着 DPI 缩放，
 *    必须经 `screen.screenToDipRect` 换算。换算抽成纯函数 `toDipBounds`，好单测。
 *  - **层级**：默认 `moveAbove` 到播放器正上方一层，此后跟着它的 Z 序走；只有「播放器全屏
 *    且在前台」时才升成 always-on-top —— 否则用户切去看别的窗口，弹幕会糊在别人脸上。
 *    P0 实测：**隐藏状态下调 moveAbove 会把窗口重新显示**，所以「该隐藏」的分支里一个置层
 *    调用都不许有；目标窗口已销毁时 moveAbove 还会抛异常，调用一律包 try/catch。
 *  - **看不见的情况**：最小化、被 DWM cloak、独占全屏（`SHQueryUserNotificationState==3`）
 *    这三种下面覆盖窗根本显示不出来，只能藏起来，并让界面告诉用户一声。
 *
 * 安全面：页面在默认 session 里跑（主窗口注册的权限处理器照样生效），sandbox、无 Node、
 * CSP 从严、禁止导航与开新窗；覆盖窗唯一能往回说的话是 `overlay:submit`，
 * 而这条通道必须核对发送方确实是覆盖窗本身、URL 确实是 OVERLAY_URL。
 */

const path = require('path');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');

/** 覆盖窗页面与它专用的 preload。两处都写死在仓库里，不接受外部传入的路径。 */
const OVERLAY_PAGE = path.join(__dirname, '..', 'renderer', 'overlay.html');
const OVERLAY_URL = pathToFileURL(OVERLAY_PAGE).href;
const OVERLAY_PRELOAD = path.join(__dirname, 'overlayPreload.js');

/** 主进程 → 覆盖窗 的唯一一条消息；覆盖窗 → 主进程 的唯一一条通道。 */
const FRAME_CHANNEL = 'overlay:frame';
const SUBMIT_CHANNEL = 'overlay:submit';

/** 弹幕正文上限，和 mpv 那一路（MAX_DANMAKU_TEXT）、chat.js 的 MAX_TEXT 保持一致。 */
const MAX_CHAT_TEXT = 200;
/** 输入条一次提交能收的最大字符数。超过就是有人在拿这条通道灌数据，不截断、直接拒。 */
const MAX_SUBMIT_CHARS = 4096;

/** 需要告诉用户一声的隐藏原因（界面那边经 t() 翻译，主进程只发代号）。 */
const NOTICE_REASONS = new Set(['exclusive-fullscreen']);

/**
 * 输入条最多开着这么久。
 *
 * 输入条一开，覆盖窗就临时变成可点、可聚焦 —— 而关它的唯一途径是覆盖窗里那个页面
 * 报回来一条 overlay:submit（回车、Esc、失焦）。页面崩了或者这条 IPC 断了的话，
 * 这层透明窗口会一直挡在播放器客户区上，用户点什么都点空，只能去关整个软件。
 * 所以再加一道超时：一条弹幕打不了这么久，而代价只是一条没发出去的草稿。
 */
const CHAT_TIMEOUT_MS = 30000;

/** 有状态、页面加载完要补发的字段。弹幕帧不在其列：转瞬即逝，丢了就丢了。 */
const STICKY_KEYS = ['banner', 'settings', 'chat'];

/**
 * 纯弹幕帧（不带上面那几样）两帧之间的最小间隔。渲染进程按每秒 30 帧发，这里放到 60 帧还有富余；
 * 再密就是有人在拿这条路灌覆盖窗 —— 主进程到覆盖窗这一段没有任何背压，发多少它就得处理多少。
 */
const MIN_FRAME_INTERVAL_MS = 15;

/* ============================== 纯函数 ============================== */

/**
 * 桥接程序报的矩形（`[left, top, right, bottom]`，也接受 `{x,y,width,height}`）归一成
 * Electron 的 bounds 形状。尺寸为零或数值不合法时返回 null —— 这种矩形贴上去就是个
 * 看不见的窗口，不如当作「这一帧没有几何信息」。
 */
function rectToBounds(rect) {
  if (!rect) return null;
  let x;
  let y;
  let width;
  let height;
  if (Array.isArray(rect)) {
    if (rect.length < 4) return null;
    const [left, top, right, bottom] = rect.map(Number);
    x = left;
    y = top;
    width = right - left;
    height = bottom - top;
  } else if (typeof rect === 'object') {
    x = Number(rect.x);
    y = Number(rect.y);
    width = Number(rect.width);
    height = Number(rect.height);
  } else {
    return null;
  }
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/**
 * 物理像素 → DIP。`convert` 就是 `(rect) => screen.screenToDipRect(null, rect)`，
 * 由调用方注入，所以这一步不用起 Electron 也能测。
 *
 * 取整的写法是有讲究的：x 和 width 各自四舍五入，右边缘会比播放器的右边缘差一个像素
 * （0.5 + 0.5 两次进位）。所以先把左右两条边各自取整，宽度由取整后的边缘相减得出，
 * 边缘对齐，缩放比例再怪也不会露出一条缝。
 */
function toDipBounds(rect, convert) {
  const raw = rectToBounds(rect);
  if (!raw) return null;
  let dip = raw;
  if (typeof convert === 'function') {
    try {
      dip = rectToBounds(convert(raw));
    } catch {
      return null;
    }
    if (!dip) return null;
  }
  const left = Math.round(dip.x);
  const top = Math.round(dip.y);
  const right = Math.round(dip.x + dip.width);
  const bottom = Math.round(dip.y + dip.height);
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/**
 * 该不该显示、显示的话压在哪一层。整个覆盖窗的行为都由这个纯函数决定，
 * BrowserWindow 那边只负责照着执行。
 *
 * @param {object|null} state 桥接程序的 win 事件：{hwnd, alive, minimized, visible, cloaked,
 *   foreground, fullscreenLike, fse, client, rect}
 * @param {{enabled?: boolean}} opts enabled=false 表示弹幕关了或播放器没在跑
 * @returns {{visible:boolean, level:('above'|'topmost'|null), hwnd:(number|null), reason:string}}
 */
function decideOverlay(state, { enabled = true } = {}) {
  const hide = (reason) => ({ visible: false, level: null, hwnd: null, reason });
  if (enabled === false) return hide('disabled');
  if (!state || typeof state !== 'object') return hide('no-window');
  const hwnd = Number(state.hwnd);
  if (!Number.isFinite(hwnd) || hwnd === 0) return hide('no-window');
  if (state.alive === false) return hide('no-window');
  if (state.minimized === true) return hide('minimized');
  // DWM cloak：窗口还「在」，但被合成器藏了（切到别的虚拟桌面、UWP 挂起）。
  if (state.cloaked === true) return hide('cloaked');
  if (state.visible === false) return hide('invisible');
  // 独占全屏：画面由显卡直出，任何窗口都压不上去。只能藏起来并提示用户。
  if (state.fse === true) return hide('exclusive-fullscreen');
  if (!rectToBounds(state.client) && !rectToBounds(state.rect)) return hide('empty-rect');

  // 全屏在前台：Z 序里没有「播放器上面一层」可言（它已经压着任务栏了），
  // 只有 screen-saver 这一档能盖住全屏窗口。
  if (state.fullscreenLike === true && state.foreground === true) {
    return { visible: true, level: 'topmost', hwnd, reason: 'fullscreen' };
  }
  // 全屏但丢了前台：别的窗口正盖着播放器，此时还 always-on-top 就是糊在别人脸上。
  // 降级回 moveAbove —— 覆盖窗跟着播放器一起沉到那个窗口下面，用户看不见，也不碍事。
  if (state.fullscreenLike === true) {
    return { visible: true, level: 'above', hwnd, reason: 'fullscreen-background' };
  }
  return { visible: true, level: 'above', hwnd, reason: 'normal' };
}

/** 两次决定等价吗（不看 reason，只看真正会落到窗口上的三件事）。 */
function sameDecision(a, b) {
  if (!a || !b) return false;
  return a.visible === b.visible && a.level === b.level && a.hwnd === b.hwnd;
}

/** Electron 的 moveAbove 只认这种形状的窗口 id。 */
function mediaSourceId(hwnd) {
  return `window:${Number(hwnd)}:0`;
}

/**
 * 覆盖窗是不是真的压在播放器上面。
 *
 * `above` 是桥接程序顺着 GW_HWNDPREV 取的「紧贴在播放器上面的几个可见窗口」。
 * 不要求覆盖窗就是紧挨着的那一个 —— 本机的 360tray 会往播放器上方挂小窗，
 * 要求「必须是第一个」会在这台机器上永远判失败。在链条里就算过。
 */
function overlayAbovePlayer(above, overlayHwnd) {
  const target = Number(overlayHwnd);
  if (!Number.isFinite(target) || target === 0) return false;
  if (!Array.isArray(above)) return false;
  return above.some((w) => w && Number(w.hwnd) === target);
}

/** getNativeWindowHandle() 给的是 Buffer，32 位和 64 位宽度不同。 */
function nativeHandleToNumber(buffer) {
  if (!buffer || typeof buffer.length !== 'number' || buffer.length < 4) return 0;
  try {
    return buffer.length >= 8 ? Number(buffer.readBigUInt64LE(0)) : buffer.readUInt32LE(0);
  } catch {
    return 0;
  }
}

/**
 * 控制字符（含 U+2028 / U+2029 两个行分隔符）换成空格。
 * 换行是弹幕帧和 ASS 事件里的分隔符，不能由正文带进来。
 */
function scrubControl(text) {
  let out = '';
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    out += cp < 0x20 || cp === 0x7f || cp === 0x2028 || cp === 0x2029 ? ' ' : ch;
  }
  return out;
}

/** 按码点截断：按 .length 截会把 emoji 劈成半个代理对。 */
function sliceCodePoints(text, max) {
  const chars = Array.from(String(text == null ? '' : text));
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('');
}

/**
 * 输入条提交上来的正文。
 *
 * 只做「这条 IPC 能不能收」这一层：类型、长度、控制字符。真正的清洗、限速、去重仍然在
 * 渲染进程的 chat.js 里做 —— 覆盖窗只是多了一个入口，不是一条绕过校验的特权通道。
 *
 * 空串是约定的「关掉输入条、什么也不发」：preload 只暴露两个接口，取消也只能从这里回来。
 *
 * @returns {{ok:true, text:string}|{ok:false, reason:string}}
 */
function sanitizeChatText(raw) {
  if (raw === null || raw === undefined) return { ok: true, text: '' };
  if (typeof raw !== 'string') return { ok: false, reason: 'type' };
  if (raw.length > MAX_SUBMIT_CHARS) return { ok: false, reason: 'length' };
  // 控制字符换成空格，再合并空白：换行是弹幕帧里的分隔符，不能由正文带进来
  const cleaned = scrubControl(raw).replace(/\s+/g, ' ').trim();
  return { ok: true, text: sliceCodePoints(cleaned, MAX_CHAT_TEXT) };
}

/* ============================== 覆盖窗 ============================== */

/**
 * 覆盖窗的创建、几何、层级、显示隐藏，以及输入条那一条回程通道。
 *
 * 事件：
 *  - `notice {code}`  该告诉用户一声的情况（目前只有独占全屏）。文案由渲染进程经 t() 生成。
 *  - `chat {text}`    用户在播放器上按 Ctrl+Shift+D 发的一条弹幕，交给主渲染进程走 chat.js。
 *  - `chat-closed`    输入条关了（发完或按了 Esc），前台该还给播放器了。
 */
class OverlayController extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} [opts.electron]  测试里换成假的
   * @param {() => void} [opts.focusPlayer]  输入条关掉之后把前台还给播放器（由桥接程序执行）
   */
  constructor({ electron = null, focusPlayer = null, chatTimeoutMs = CHAT_TIMEOUT_MS, now = () => Date.now() } = {}) {
    super();
    this._now = now;
    this._lastFrameAt = -Infinity;
    this.electron = electron || require('electron');
    this.focusPlayer = typeof focusPlayer === 'function' ? focusPlayer : null;
    this.win = null;
    this.ready = false;
    this.enabled = false;
    this.state = null;
    this.decision = decideOverlay(null, { enabled: false });
    this.chatOpen = false;
    this.chatTimeoutMs = Number(chatTimeoutMs) > 0 ? Number(chatTimeoutMs) : CHAT_TIMEOUT_MS;
    this._chatTimer = null;
    this._sticky = {};
    this._noticed = null;
  }

  /** 弹幕开关 / 外部播放器在不在跑。关掉就藏窗口，但不销毁（下一首还要用）。 */
  setEnabled(flag) {
    const next = flag !== false;
    if (this.enabled === next) return;
    this.enabled = next;
    this._apply();
  }

  /** 桥接程序推来的一次窗口状态。 */
  update(state) {
    this.state = state && typeof state === 'object' ? state : null;
    this._apply();
    this._recheckStacking();
  }

  /** 播放器没了：藏窗口、忘掉几何，下一次 update 从头来。 */
  detach() {
    this.state = null;
    this.chatOpen = false;
    this._clearChatTimeout();
    this._noticed = null;
    this._apply();
  }

  /**
   * 一帧数据（弹幕、横幅、输入条指令）转给覆盖窗。
   * 覆盖窗还没建好或页面还没加载完时先存着，加载完补发 —— 横幅和输入条是有状态的，
   * 丢了就会一直错下去；弹幕本来就是每秒 30 帧，丢几帧无所谓。
   */
  frame(payload) {
    if (!payload || typeof payload !== 'object') return false;
    // 有状态的那几样单独记着：只留「最后一帧」是不够的，横幅后面紧跟着一帧弹幕，
    // 横幅就被顶掉了 —— 那一场直到下次横幅变化之前都不会再有人提起它。
    let sticky = false;
    for (const key of STICKY_KEYS) {
      if (payload[key] === undefined) continue;
      this._sticky[key] = payload[key];
      sticky = true;
    }
    if (!this.win || this.win.isDestroyed()) return false;
    if (!this.ready) return false;
    // 纯弹幕帧限频（见 MIN_FRAME_INTERVAL_MS）。有状态的帧不受限：丢了会一直错下去
    if (!sticky) {
      const now = this._now();
      if (now - this._lastFrameAt < MIN_FRAME_INTERVAL_MS) return false;
      this._lastFrameAt = now;
    }
    this.win.webContents.send(FRAME_CHANNEL, payload);
    return true;
  }

  /**
   * 弹出输入条：覆盖窗临时变成可聚焦、可点击，抢一次前台。
   * 独占全屏下覆盖窗根本看不见，这时候抢前台等于把播放器踢出全屏，所以直接不弹。
   *
   * @returns {boolean} 弹出来了没有
   */
  openChat({ prompt = '', maxLength = MAX_CHAT_TEXT } = {}) {
    if (!this.decision.visible || !this.win || this.win.isDestroyed()) return false;
    this.chatOpen = true;
    try {
      this.win.setIgnoreMouseEvents(false);
      this.win.setFocusable(true);
      this.win.show();
      this.win.focus();
    } catch {
      /* 窗口刚好在这一刻没了 */
    }
    this.frame({ chat: { open: true, prompt: String(prompt || ''), maxLength } });
    this._armChatTimeout();
    return true;
  }

  /** 页面再也不报回来时的兜底：到点自己把点击穿透装回去。 */
  _armChatTimeout() {
    this._clearChatTimeout();
    this._chatTimer = setTimeout(() => {
      this._chatTimer = null;
      if (this.chatOpen) this.closeChat();
    }, this.chatTimeoutMs);
    if (this._chatTimer.unref) this._chatTimer.unref();
  }

  _clearChatTimeout() {
    if (!this._chatTimer) return;
    clearTimeout(this._chatTimer);
    this._chatTimer = null;
  }

  /** 关掉输入条，把「点击穿透 + 不可聚焦」装回去，前台还给播放器。 */
  closeChat({ notify = true } = {}) {
    const wasOpen = this.chatOpen;
    this.chatOpen = false;
    this._clearChatTimeout();
    if (this.win && !this.win.isDestroyed()) {
      try {
        this.win.setFocusable(false);
        this.win.setIgnoreMouseEvents(true);
      } catch {
        /* 同上 */
      }
      if (notify) this.frame({ chat: { open: false } });
    }
    if (!wasOpen) return;
    if (this.focusPlayer) {
      try {
        this.focusPlayer();
      } catch {
        /* 桥接程序已经关了 */
      }
    }
    this.emit('chat-closed');
  }

  /**
   * `overlay:submit` 的处理器。发送方必须是覆盖窗本身：
   * 同一个 webContents、同一个主框架、URL 就是 OVERLAY_URL。
   * 三条缺一不可 —— 只比 URL 的话，任何一个把自己导航到这个 file:// 页面的
   * webContents 都能往房间里发言。
   */
  handleSubmit(event, payload) {
    if (!this._isOverlaySender(event)) throw new Error('已拒绝不受信任页面的请求');
    // 只在输入条开着的时候收：一次按键（Ctrl+Shift+D）换一条弹幕。输入条关着还在往回发的，
    // 只能是覆盖窗页面出了问题（它渲染的是房间里别人发的弹幕），不能让它替用户在房间里连发。
    if (!this.chatOpen) return { sent: false };
    const raw = payload && typeof payload === 'object' ? payload.text : payload;
    const result = sanitizeChatText(raw);
    if (!result.ok) {
      this.closeChat();
      throw new Error('无效的弹幕');
    }
    this.closeChat();
    if (!result.text) return { sent: false };
    this.emit('chat', { text: result.text });
    return { sent: true, text: result.text };
  }

  /** 把 overlay:submit 挂到 ipcMain 上。主进程接线就这一句。 */
  attachIpc(ipcMain) {
    ipcMain.handle(SUBMIT_CHANNEL, (event, payload) => this.handleSubmit(event, payload));
    return this;
  }

  /** 覆盖窗的窗口句柄（数字），用来核对 Z 序。 */
  nativeHandle() {
    if (!this.win || this.win.isDestroyed()) return 0;
    try {
      return nativeHandleToNumber(this.win.getNativeWindowHandle());
    } catch {
      return 0;
    }
  }

  /** 关程序 / 换播放器：销毁窗口。 */
  destroy() {
    this.chatOpen = false;
    this._clearChatTimeout();
    this.ready = false;
    this._sticky = {};
    const win = this.win;
    this.win = null;
    if (win && !win.isDestroyed()) {
      try {
        win.destroy();
      } catch {
        /* 已经在关了 */
      }
    }
  }

  /* ------------------------------ 内部 ------------------------------ */

  _isOverlaySender(event) {
    const win = this.win;
    if (!win || win.isDestroyed() || !event) return false;
    const contents = win.webContents;
    return Boolean(
      event.sender === contents &&
        event.senderFrame === contents.mainFrame &&
        event.senderFrame &&
        event.senderFrame.url === OVERLAY_URL
    );
  }

  _apply() {
    const next = decideOverlay(this.state, { enabled: this.enabled });
    const changed = !sameDecision(this.decision, next);
    this.decision = next;
    this._notice(next.reason);

    if (!next.visible) {
      // 「该隐藏」的分支里一个置层调用都不许有：moveAbove 会把隐藏的窗口重新显示出来（P0 实测）
      if (this.chatOpen) this.closeChat({ notify: false });
      if (this.win && !this.win.isDestroyed() && this.win.isVisible()) {
        try {
          this.win.hide();
        } catch {
          /* 窗口正在销毁 */
        }
      }
      return;
    }

    const win = this._ensureWindow();
    if (!win) return;
    const bounds = toDipBounds(this.state.client || this.state.rect, this._toDip);
    if (bounds) {
      try {
        win.setBounds(bounds);
      } catch {
        /* 窗口正在销毁 */
      }
    }
    // 先显示再置层：隐藏状态下调 moveAbove 会把窗口显示出来，顺序反了就多一次闪烁
    if (!win.isVisible()) {
      try {
        win.showInactive();
      } catch {
        /* 同上 */
      }
    }
    this._applyLevel(next, changed);
  }

  _applyLevel(decision, changed) {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    try {
      if (decision.level === 'topmost') {
        // 全屏窗口压着任务栏，只有 screen-saver 这一档能盖得住
        win.setAlwaysOnTop(true, 'screen-saver');
        return;
      }
      if (changed) win.setAlwaysOnTop(false);
      // 目标窗口刚好在这一刻销毁时 moveAbove 会抛（P0 实测）
      win.moveAbove(mediaSourceId(decision.hwnd));
    } catch {
      /* 播放器窗口没了：下一次 update 会判成 no-window 然后藏起来 */
    }
  }

  /** Z 序核对：覆盖窗不在播放器上面的链条里就再置一次层。 */
  _recheckStacking() {
    const decision = this.decision;
    if (!decision.visible || decision.level !== 'above') return;
    if (!this.state || !Array.isArray(this.state.above)) return;
    const self = this.nativeHandle();
    if (!self) return;
    if (overlayAbovePlayer(this.state.above, self)) return;
    this._applyLevel(decision, false);
  }

  _notice(reason) {
    if (!NOTICE_REASONS.has(reason)) {
      this._noticed = null;
      return;
    }
    if (this._noticed === reason) return;
    this._noticed = reason;
    this.emit('notice', { code: reason });
  }

  get _toDip() {
    const screen = this.electron.screen;
    if (!screen || typeof screen.screenToDipRect !== 'function') return null;
    return (rect) => screen.screenToDipRect(null, rect);
  }

  _ensureWindow() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const { BrowserWindow } = this.electron;
    const bounds = toDipBounds(this.state && (this.state.client || this.state.rect), this._toDip) || {
      x: 0,
      y: 0,
      width: 640,
      height: 360,
    };
    const win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      // 透明窗口在 Windows 上仍会收到一次背景填充，给足 0 alpha 才不会糊一层黑
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      // 不可聚焦：点播放器的进度条不能被这层窗口截胡（弹输入条时临时改成 true）
      focusable: false,
      acceptFirstMouse: false,
      title: 'NoxReel 弹幕层',
      webPreferences: {
        preload: OVERLAY_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // 覆盖窗常年不在前台。节流会把 rAF 停掉，弹幕整片卡死
        backgroundThrottling: false,
        // 默认 session：主窗口注册的权限处理器（一律拒绝）对它照样生效
      },
    });
    this.win = win;
    this.ready = false;
    try {
      win.setMenuBarVisibility(false);
      // 点击穿透：鼠标事件全交给下面的播放器
      win.setIgnoreMouseEvents(true);
    } catch {
      /* 某些平台没有这些方法 */
    }

    // 覆盖窗只许待在这一个页面上
    win.webContents.on('will-navigate', (event, url) => {
      if (url !== OVERLAY_URL) event.preventDefault();
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('did-finish-load', () => {
      this.ready = true;
      // 加载完补发有状态的那几样（横幅、弹幕设置、输入条），丢了会一直错下去；
      // 这期间的弹幕帧不补 —— 每秒 30 帧，补上去的也已经是过时的坐标
      if (Object.keys(this._sticky).length) this.frame({ ...this._sticky });
    });
    win.on('closed', () => {
      if (this.win === win) {
        this.win = null;
        this.ready = false;
      }
    });
    win.loadFile(OVERLAY_PAGE);
    return win;
  }
}

module.exports = {
  OverlayController,
  OVERLAY_PAGE,
  OVERLAY_URL,
  OVERLAY_PRELOAD,
  FRAME_CHANNEL,
  SUBMIT_CHANNEL,
  MAX_CHAT_TEXT,
  MAX_SUBMIT_CHARS,
  CHAT_TIMEOUT_MS,
  MIN_FRAME_INTERVAL_MS,
  rectToBounds,
  toDipBounds,
  decideOverlay,
  sameDecision,
  mediaSourceId,
  overlayAbovePlayer,
  nativeHandleToNumber,
  sanitizeChatText,
};
