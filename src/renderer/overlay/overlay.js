/**
 * 覆盖窗的画笔。
 *
 * 这一页压在外部播放器（PotPlayer / MPC-BE）的客户区上，只干三件事：画弹幕、画常驻横幅、
 * 在按了 Ctrl+Shift+D 之后弹一条输入条。
 *
 * 三个不能含糊的地方：
 *
 * 1. **正文一个字也不进 DOM**。房间里别人发来的文字全部用 canvas 的 fillText 画。
 *    这一层窗口是透明、置顶、点击穿透的，任何把外来文本变成节点的写法都不值得冒险。
 *
 * 2. **自己限帧到 60fps**。P0 实测：锁屏（显示器关着）时 rAF 不再跟着显示器刷新率走，
 *    一秒能回调几百上千次。不自己拦一道，无人值守的机器上这一页会一直烧着一个核。
 *
 * 3. **排布用的是共用的 danmaku.js**。mpv 那条路、安卓那条路和这里算的是同一套弹道，
 *    三端弹幕的观感才一样。这里比另外两处多一件事：canvas 有 measureText，
 *    能把「这行字到底多宽」量准，不用估。
 */

import { DanmakuEngine, measureTextWidth } from '../lib/danmaku.js';

/** 限帧上限。P0 实测锁屏下 rAF 不限速，这道闸必须自己来。 */
export const MAX_FPS = 60;
export const MIN_FRAME_MS = 1000 / MAX_FPS;
/** 一帧最多画多少条、每条最多几个字。和主进程 mpv 那一路的上限一致。 */
export const MAX_ITEMS = 60;
export const MAX_TEXT = 200;

export const FONT_FAMILY = "'Microsoft YaHei', 'Segoe UI', 'PingFang SC', system-ui, sans-serif";
export const COLOR_TEXT = '#ffffff';
export const COLOR_OUTLINE = '#000000';
/** 自己发的那条描边换成品牌色，一屏几十条里一眼认得出。和 mpv 那一路的 &HFF8D4C& 同色。 */
export const COLOR_SELF = '#4c8dff';
export const COLOR_BANNER_TEXT = '#e6edf3';
export const COLOR_BANNER_BG = 'rgba(14, 17, 22, 0.72)';
export const BANNER_TOP_PX = 10;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** 按码点截断：按 .length 截会把 emoji 劈成半个代理对，画出来是个方块。 */
function sliceCodePoints(text, max) {
  const chars = Array.from(String(text == null ? '' : text));
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('');
}

/**
 * 这一帧画不画。
 *
 * rAF 的间隔本来就有抖动（60Hz 上常是 16.6±0.7ms），卡死在 16.667 上会规律地隔一帧漏一帧，
 * 看着就是弹幕一顿一顿的。放半毫秒的余量，正常刷新率下一帧不漏，不限速时照样按 60 拦住。
 */
export function shouldPaint(now, last, minMs = MIN_FRAME_MS) {
  if (!Number.isFinite(now)) return false;
  if (!Number.isFinite(last)) return true;
  return now - last >= minMs - 0.5;
}

/** 一帧弹幕的归一化：条数、字数、坐标全部设上限，坏值直接丢。 */
export function normalizeItems(items, { scale = 1, maxItems = MAX_ITEMS } = {}) {
  if (!Array.isArray(items)) return [];
  const out = [];
  const factor = num(scale, 1) > 0 ? num(scale, 1) : 1;
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const text = sliceCodePoints(raw.text, MAX_TEXT);
    if (!text.trim()) continue;
    out.push({
      text,
      x: num(raw.x, 0) * factor,
      y: num(raw.y, 0) * factor,
      fontSize: clamp(num(raw.fontSize, 28) * factor, 8, 200),
      opacity: clamp(num(raw.opacity, 1), 0.05, 1),
      outline: raw.outline === true,
    });
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * 画一条弹幕：先描边再填白。描边是必需的 —— 亮画面上纯白字直接糊没了。
 */
export function drawItem(ctx, item, { fontFamily = FONT_FAMILY } = {}) {
  const fontSize = item.fontSize;
  ctx.font = `${Math.round(fontSize)}px ${fontFamily}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = item.opacity;
  ctx.lineWidth = Math.max(2, fontSize * (item.outline ? 0.11 : 0.07));
  ctx.strokeStyle = item.outline ? COLOR_SELF : COLOR_OUTLINE;
  ctx.strokeText(item.text, item.x, item.y);
  ctx.fillStyle = COLOR_TEXT;
  ctx.fillText(item.text, item.x, item.y);
  ctx.globalAlpha = 1;
}

/**
 * 常驻横幅（全员暂停那条提示）。居中画在顶部，底下垫一块半透明的板子，
 * 亮画面上也读得清。弹道那边留了 8% 的顶部空白，正好让开这块。
 */
export function drawBanner(ctx, text, { width = 0, fontSize = 22, fontFamily = FONT_FAMILY } = {}) {
  const line = sliceCodePoints(text, MAX_TEXT);
  if (!line.trim() || width <= 0) return false;
  const size = clamp(num(fontSize, 22), 12, 64);
  ctx.font = `${Math.round(size)}px ${fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.globalAlpha = 1;
  const measured = ctx.measureText(line);
  const textWidth = measured && Number.isFinite(measured.width) ? measured.width : measureTextWidth(line, size);
  const boxWidth = Math.min(width - 16, textWidth + 32);
  const boxHeight = Math.round(size * 1.7);
  ctx.fillStyle = COLOR_BANNER_BG;
  ctx.fillRect(Math.round(width / 2 - boxWidth / 2), BANNER_TOP_PX, Math.round(boxWidth), boxHeight);
  ctx.fillStyle = COLOR_BANNER_TEXT;
  ctx.fillText(line, Math.round(width / 2), BANNER_TOP_PX + Math.round(size * 0.35));
  return true;
}

/**
 * 覆盖窗的运行时。DOM、时钟、rAF、通道全部由外面传进来，所以整段逻辑在 Node 里也能跑。
 *
 * @param {object} opts
 * @param {object} opts.canvas 画布元素
 * @param {object} [opts.bar] 输入条外壳（靠 class 显示/隐藏）
 * @param {object} [opts.input] 输入条里的 input
 * @param {object} [opts.shield] 输入条开着时铺满整页的挡板，点它就是「点空了」
 * @param {object} [opts.bridge] preload 暴露的 {onFrame, submitChat}
 * @param {Function} opts.requestFrame rAF
 * @param {Function} [opts.cancelFrame] cancelAnimationFrame
 * @param {Function} [opts.now] 单调时钟
 * @param {Function} [opts.viewport] () => {width, height, dpr}，CSS 像素
 */
export function createOverlay({
  canvas,
  bar = null,
  input = null,
  shield = null,
  bridge = null,
  requestFrame,
  cancelFrame = null,
  now = null,
  viewport = null,
  minFrameMs = MIN_FRAME_MS,
} = {}) {
  const ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  const clock = typeof now === 'function' ? now : () => Date.now();
  const readViewport =
    typeof viewport === 'function'
      ? viewport
      : () => ({ width: num(canvas && canvas.clientWidth, 0), height: num(canvas && canvas.clientHeight, 0), dpr: 1 });

  // canvas 有 measureText，能把宽度量准；量不到（画布还没尺寸）就退回共用的估算
  const measure = (text, fontSize) => {
    if (!ctx) return measureTextWidth(text, fontSize);
    try {
      ctx.font = `${Math.round(fontSize)}px ${FONT_FAMILY}`;
      const m = ctx.measureText(String(text));
      if (m && Number.isFinite(m.width) && m.width > 0) return m.width;
    } catch {
      /* 上下文丢了（窗口正在销毁） */
    }
    return measureTextWidth(text, fontSize);
  };

  const engine = new DanmakuEngine({ measure });
  const size = { width: 0, height: 0, dpr: 1 };
  let banner = '';
  let given = []; // 主进程直接给的一帧（已排布好的坐标），来自渲染进程的 30Hz 帧循环
  let givenCanvas = null; // 那一帧是按哪个虚拟画布算的
  let handle = null;
  let lastPaint = NaN;
  let painted = 0;
  let skipped = 0;
  let disposeBridge = null;
  // 输入条现在开着没有。closeBar() 自己会调 input.blur()，没有这个标记，
  // 失焦处理会被自己触发一遍，再报一条多余的「取消」回去。
  let barOpen = false;

  function syncSize() {
    const v = readViewport() || {};
    const width = Math.max(0, Math.round(num(v.width, 0)));
    const height = Math.max(0, Math.round(num(v.height, 0)));
    const dpr = clamp(num(v.dpr, 1), 0.5, 4);
    if (size.width === width && size.height === height && size.dpr === dpr) return;
    size.width = width;
    size.height = height;
    size.dpr = dpr;
    if (canvas) {
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
    }
    engine.resize(width, height);
  }

  function hasContent() {
    return Boolean(banner) || given.length > 0 || engine.flyingCount > 0 || engine.pendingCount > 0;
  }

  /** 画一帧。返回 true 表示真画了，false 表示被限帧挡掉。 */
  function paint(timestamp) {
    const ts = Number.isFinite(timestamp) ? timestamp : clock();
    if (!shouldPaint(ts, lastPaint, minFrameMs)) {
      skipped += 1;
      return false;
    }
    lastPaint = ts;
    syncSize();
    if (!ctx) return false;
    if (typeof ctx.setTransform === 'function') ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    if (banner) drawBanner(ctx, banner, { width: size.width, fontSize: Math.max(16, Math.round(size.height * 0.03)) });
    // 两条来路：主进程直接给坐标（渲染进程算好的那一帧），或者自己用共用引擎排
    const scale = givenCanvas && givenCanvas.width > 0 ? size.width / givenCanvas.width : 1;
    const items = given.length ? normalizeItems(given, { scale }) : normalizeItems(engine.frame(ts));
    for (const item of items) drawItem(ctx, item);
    painted += 1;
    return true;
  }

  function loop(timestamp) {
    handle = null;
    paint(timestamp);
    if (hasContent()) schedule();
  }

  function schedule() {
    if (handle !== null || typeof requestFrame !== 'function') return;
    handle = requestFrame(loop);
  }

  function stop() {
    if (handle === null) return;
    if (typeof cancelFrame === 'function') cancelFrame(handle);
    handle = null;
  }

  /* ------------------------------ 输入条 ------------------------------ */

  function openBar({ prompt = '', maxLength = MAX_TEXT } = {}) {
    if (!bar || !input) return false;
    input.value = '';
    // 提示语由主进程按界面语言传下来：这一页自己不带任何用户可见的文案
    input.placeholder = String(prompt || '');
    const cap = Math.round(clamp(num(maxLength, MAX_TEXT), 1, MAX_TEXT));
    input.maxLength = cap;
    if (bar.classList) bar.classList.remove('hidden');
    // 挡板跟着出来：这段时间窗口是可点的，点在输入条以外要能把它关掉
    if (shield && shield.classList) shield.classList.remove('hidden');
    barOpen = true;
    if (typeof input.focus === 'function') input.focus();
    return true;
  }

  function closeBar() {
    if (!bar || !input) return;
    barOpen = false;
    if (bar.classList) bar.classList.add('hidden');
    if (shield && shield.classList) shield.classList.add('hidden');
    input.value = '';
    if (typeof input.blur === 'function') input.blur();
  }

  /**
   * 放弃这一条：关掉输入条，并把空串报给主进程。
   *
   * 空串是约定的「关掉输入条、什么也不发」—— 主进程据此把点击穿透和不可聚焦装回去，
   * 再把前台还给播放器。不报的话，这层窗口会一直挡在播放器客户区上。
   */
  function cancelBar() {
    if (!barOpen) return;
    closeBar();
    send('');
  }

  function send(text) {
    if (!bridge || typeof bridge.submitChat !== 'function') return;
    try {
      const result = bridge.submitChat(text);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      /* 通道没了：这一条就算了，界面里的聊天框始终还在 */
    }
  }

  function onKeyDown(event) {
    if (!event) return;
    if (event.key === 'Enter') {
      // 拼音选词时的回车不是发送
      if (event.isComposing === true) return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      const text = input ? input.value : '';
      closeBar();
      send(text);
      return;
    }
    if (event.key === 'Escape') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      cancelBar();
    }
  }

  /**
   * 输入条失焦：当作放弃这一条。
   *
   * 不接这一下的话，用户切去点别的窗口之后输入条还留在屏幕上，
   * 而覆盖窗还是「可点、可聚焦」的那副样子 —— 播放器的进度条从此点不动，
   * 只有回来按一下 Esc 才能解开。
   */
  function onBlur() {
    cancelBar();
  }

  /** 点在输入条以外：同样是放弃。挡板就是为这一下存在的。 */
  function onShieldDown(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    cancelBar();
  }

  if (input && typeof input.addEventListener === 'function') {
    input.addEventListener('keydown', onKeyDown);
    input.addEventListener('blur', onBlur);
  }
  if (shield && typeof shield.addEventListener === 'function') shield.addEventListener('mousedown', onShieldDown);

  /* ------------------------------ 收帧 ------------------------------ */

  /**
   * 一帧数据。字段全是可选的，给了才动：
   *  - clear    换片 / 切播放器：整场清空
   *  - settings 本地弹幕设置（不透明度、字号、速度、显示区域）
   *  - banner   常驻横幅正文，空串清掉
   *  - messages 新到的弹幕 [{id, text, self}]，交给共用引擎排布
   *  - items    已经排好坐标的一帧（渲染进程的 30Hz 帧循环算的），连同它的虚拟画布 w/h
   *  - chat     输入条：{open, prompt, maxLength}
   */
  function applyFrame(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.clear === true) {
      engine.clear();
      given = [];
      givenCanvas = null;
    }
    if (payload.settings !== undefined) engine.setSettings(payload.settings);
    if (payload.banner !== undefined) {
      banner = sliceCodePoints(payload.banner, MAX_TEXT).trim();
      engine.setBanner(Boolean(banner));
    }
    if (Array.isArray(payload.messages)) {
      for (const msg of payload.messages) engine.push(msg);
      given = [];
      givenCanvas = null;
    }
    if (Array.isArray(payload.items)) {
      given = payload.items;
      givenCanvas = {
        width: num(payload.w, 0) > 0 ? num(payload.w, 0) : size.width,
        height: num(payload.h, 0) > 0 ? num(payload.h, 0) : size.height,
      };
    }
    if (payload.chat && typeof payload.chat === 'object') {
      if (payload.chat.open === true) openBar(payload.chat);
      else closeBar();
    }
    if (hasContent()) schedule();
    else {
      // 场上空了：再画一帧把画布擦干净，然后停表
      stop();
      lastPaint = NaN;
      paint(clock());
    }
  }

  if (bridge && typeof bridge.onFrame === 'function') disposeBridge = bridge.onFrame(applyFrame);

  syncSize();

  return {
    applyFrame,
    paint,
    schedule,
    stop,
    openBar,
    closeBar,
    cancelBar,
    onKeyDown,
    onBlur,
    engine,
    stats: () => ({ painted, skipped, banner, flying: engine.flyingCount, pending: engine.pendingCount, ...size }),
    destroy() {
      stop();
      engine.clear();
      if (typeof disposeBridge === 'function') disposeBridge();
      if (input && typeof input.removeEventListener === 'function') {
        input.removeEventListener('keydown', onKeyDown);
        input.removeEventListener('blur', onBlur);
      }
      if (shield && typeof shield.removeEventListener === 'function') shield.removeEventListener('mousedown', onShieldDown);
    },
  };
}

/** 把页面上的那几个元素接起来。 */
export function mount(doc, view) {
  const canvas = doc.getElementById('overlay-canvas');
  if (!canvas) return null;
  return createOverlay({
    canvas,
    bar: doc.getElementById('overlay-bar'),
    input: doc.getElementById('overlay-input'),
    shield: doc.getElementById('overlay-shield'),
    bridge: view.noxOverlay,
    requestFrame: (fn) => view.requestAnimationFrame(fn),
    cancelFrame: (id) => view.cancelAnimationFrame(id),
    now: () => (view.performance ? view.performance.now() : Date.now()),
    viewport: () => ({
      width: view.innerWidth,
      height: view.innerHeight,
      dpr: view.devicePixelRatio || 1,
    }),
  });
}

// 真正在覆盖窗里跑的时候才接线；在 Node 里被测试 import 时这一段不执行。
if (typeof window !== 'undefined' && typeof document !== 'undefined' && window.noxOverlay) {
  mount(document, window);
}
