/**
 * 弹幕排布（纯函数，桌面 mpv 覆盖层、外部播放器的覆盖窗、安卓三处共用）。
 *
 * 只算「这一帧每条弹幕在哪」，不碰画笔：mpv 那边把结果转成带 \pos 的 ASS，
 * 覆盖窗和安卓那边用 canvas / DOM 画。时刻由调用方传进来，所以完全可复算、好测。
 *
 * 为什么要逐帧重算：mpv 的 osd-overlay 覆盖层渲染时间固定为 0，ASS 的 \move 不会动
 * （sub/osd_libass.c），只能每帧重新给一次坐标。既然 mpv 这条路必须逐帧，另外两处
 * 就跟着用同一套排布，三端弹幕的观感才是一样的。
 *
 * 三条不变量：
 *
 * 1. **全场共用一个像素速度**（由屏宽和速度设置算出，与文字长短无关）。
 *    要是按「每条都用一样的时长横穿」，长弹幕就跑得快，必定追尾撞上前面那条。
 *    速度相同时，只要新弹幕进场时前一条已经完全进场，两者就永远不会重叠。
 *
 * 2. **弹道占满时排队，最多 20 条**，再多就丢最老的 —— 实时弹幕的价值在「此刻」，
 *    攒着一分钟前的话挤掉刚说的，还不如丢掉。
 *
 * 3. **顶部留白**：有横幅时留出约 8% 的高度，任何时候都躲开播放器顶部那排窗口控件。
 */

/** 弹道全占满时的排队上限。 */
export const MAX_PENDING = 20;
/** 有横幅时顶部留空的比例。 */
export const BANNER_TOP_RATIO = 0.08;
/** 播放器顶部窗口控件（mpv OSC 的右上角按钮那一排）的高度，任何时候都躲开。 */
export const OSC_TOP_PX = 40;
/** 全屏模式下底部留给字幕和进度条的比例。 */
export const BOTTOM_RESERVE_RATIO = 0.12;
/** 速度 1 时横穿一屏的毫秒数。 */
export const BASE_TRAVEL_MS = 8000;
/** 弹道行高相对字号的倍数。 */
export const TRACK_LINE_RATIO = 1.4;
/** 同一弹道上两条之间至少空出的宽度（相对字号）。 */
export const GAP_RATIO = 0.8;

export const MIN_FONT_PX = 12;
export const MAX_FONT_PX = 96;
export const AREAS = ['half', 'full'];

/** 本地设置的默认值，只影响自己，存在 localStorage 里。 */
export const DEFAULT_SETTINGS = { enabled: true, opacity: 0.85, fontScale: 1, speed: 1, area: 'half' };

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** 这个高度下的默认字号。 */
export function defaultFontSize(height) {
  return clamp(Math.round(num(height, 0) * 0.042), MIN_FONT_PX, MAX_FONT_PX);
}

/**
 * 把用户设置归一化到安全范围。坏值一律退回默认值，不让界面把排布算崩。
 * @returns {{enabled:boolean, opacity:number, fontSize:number, speed:number, area:'half'|'full'}}
 */
export function resolveSettings(raw, { height = 0 } = {}) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const base = defaultFontSize(height);
  const fontSize = Number.isFinite(s.fontSize)
    ? clamp(Math.round(s.fontSize), MIN_FONT_PX, MAX_FONT_PX)
    : clamp(Math.round(base * clamp(num(s.fontScale, 1), 0.5, 2)), MIN_FONT_PX, MAX_FONT_PX);
  return {
    enabled: s.enabled !== false,
    opacity: clamp(num(s.opacity, DEFAULT_SETTINGS.opacity), 0.1, 1),
    fontSize,
    speed: clamp(num(s.speed, DEFAULT_SETTINGS.speed), 0.25, 4),
    area: AREAS.includes(s.area) ? s.area : DEFAULT_SETTINGS.area,
  };
}

/**
 * 弹道布局：顶部留白、可用高度、能放几条弹道。
 * @returns {{top:number, bottom:number, trackHeight:number, trackCount:number}}
 */
export function computeLayout({ width = 0, height = 0, fontSize = 24, area = 'half', banner = false } = {}) {
  const h = Math.max(0, num(height, 0));
  // 顶部：横幅要 8%，窗口控件要 OSC_TOP_PX，两者取大的那个。
  // 往上取整是有意的：留白不足一个整像素时，下面 y 的四舍五入会把第一条弹幕挪回留白里，
  // 正好压住横幅最底下那一行像素 —— 8% 是「至少留这么多」，不是「大约这么多」。
  const top = Math.ceil(Math.max(banner ? h * BANNER_TOP_RATIO : 0, Math.min(OSC_TOP_PX, h * 0.25)));
  const bottom = area === 'full' ? h * (1 - BOTTOM_RESERVE_RATIO) : h * 0.5;
  const trackHeight = Math.max(1, fontSize * TRACK_LINE_RATIO);
  const usable = Math.max(0, bottom - top);
  let trackCount = Math.floor(usable / trackHeight);
  // 高度勉强够写一行字就至少给一条弹道，否则小窗口下弹幕永远只排队不出场
  if (trackCount < 1 && usable >= fontSize) trackCount = 1;
  return { top, bottom, trackHeight, trackCount, width: Math.max(0, num(width, 0)) };
}

/** 宽字符（CJK、全角、emoji）占一个字宽，其余按 0.55 估。 */
function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/**
 * 不依赖 canvas 的宽度估算（mpv 那条路根本没有 canvas）。
 * 覆盖窗可以把 ctx.measureText 包一层传进来换更准的值。
 */
export function measureTextWidth(text, fontSize) {
  let units = 0;
  for (const ch of String(text || '')) units += isWide(ch.codePointAt(0)) ? 1 : 0.55;
  return units * fontSize;
}

/** 全场共用的像素速度（px/ms）。 */
export function pxPerMs(width, speed) {
  return (Math.max(0, num(width, 0)) / BASE_TRAVEL_MS) * clamp(num(speed, 1), 0.25, 4);
}

/** 某条弹幕在 now 时刻的左边缘 x。从右边缘进场，一路向左。 */
function xAt(item, now, speed, width) {
  return width - (now - item.startMs) * speed;
}

/**
 * 算一帧。输入输出都是普通对象，不改动传进来的数组。
 *
 * @param {object} input
 * @param {number} input.width 画布宽
 * @param {number} input.height 画布高
 * @param {number} input.now 当前时刻（毫秒，单调时钟）
 * @param {Array} input.flying 在飞的弹幕（上一帧的返回值）
 * @param {Array} input.pending 排队中的弹幕（上一帧的返回值）
 * @param {Array} input.incoming 这一帧新到的消息 [{id, text, self}]
 * @param {object} input.settings 本地设置（不透明度/字号/速度/显示区域）
 * @param {boolean} input.banner 现在有没有常驻横幅
 * @param {Function} [input.measure] 宽度测量，默认用内置估算
 * @returns {{flying:Array, pending:Array, frame:Array, layout:object, settings:object, dropped:number}}
 */
export function planFrame(input = {}) {
  const { width = 0, height = 0, now = 0, banner = false, measure = measureTextWidth } = input;
  const settings = resolveSettings(input.settings, { height });
  const layout = computeLayout({ width, height, fontSize: settings.fontSize, area: settings.area, banner });
  const speed = pxPerMs(width, settings.speed);
  const gap = settings.fontSize * GAP_RATIO;
  const w = layout.width;

  const incoming = Array.isArray(input.incoming) ? input.incoming : [];
  const prevFlying = Array.isArray(input.flying) ? input.flying : [];
  const prevPending = Array.isArray(input.pending) ? input.pending : [];

  // 关掉弹幕就整场清空，不留半截在屏幕上；窗口小到放不下一条弹道时先攒着，等放大了再出场
  if (!settings.enabled) {
    return { flying: [], pending: [], frame: [], layout, settings, dropped: 0 };
  }
  if (layout.trackCount < 1 || w <= 0 || speed <= 0) {
    const kept = capPending(prevPending.concat(normalizeAll(incoming, prevFlying, prevPending)), MAX_PENDING);
    return { flying: [], pending: kept.list, frame: [], layout, settings, dropped: kept.dropped };
  }

  // 1. 还在屏幕上的留下；字号变了就重新量一次宽度；弹道数缩小后越界的直接下场
  const flying = [];
  for (const it of prevFlying) {
    if (it.track >= layout.trackCount) continue;
    const item = it.fontSize === settings.fontSize ? it : { ...it, fontSize: settings.fontSize, width: measure(it.text, settings.fontSize) };
    if (xAt(item, now, speed, w) + item.width <= 0) continue;
    flying.push(item);
  }

  // 2. 新消息进队列，队列满了丢最老的
  const queued = capPending(prevPending.concat(normalizeAll(incoming, flying, prevPending)), MAX_PENDING);
  const pending = queued.list;

  // 3. 能出场的出场：每条弹道每帧最多放一条，从最上面的空弹道开始
  const lastOnTrack = new Map();
  for (const it of flying) {
    const prev = lastOnTrack.get(it.track);
    if (!prev || it.startMs > prev.startMs) lastOnTrack.set(it.track, it);
  }
  for (let track = 0; track < layout.trackCount && pending.length; track++) {
    const last = lastOnTrack.get(track);
    // 前一条必须已经完全进场，并且留出间隔 —— 全场速度相同，所以此后永远不会追上
    if (last && xAt(last, now, speed, w) + last.width > w - gap) continue;
    const next = pending.shift();
    const item = {
      id: next.id,
      text: next.text,
      self: next.self,
      track,
      startMs: now,
      fontSize: settings.fontSize,
      width: measure(next.text, settings.fontSize),
    };
    flying.push(item);
    lastOnTrack.set(track, item);
  }

  // 4. 输出位置。x 取整，mpv 的 \pos 用不上小数
  const frame = flying.map((it) => ({
    id: it.id,
    text: it.text,
    x: Math.round(xAt(it, now, speed, w)),
    y: Math.round(layout.top + it.track * layout.trackHeight),
    width: it.width,
    fontSize: it.fontSize,
    opacity: settings.opacity,
    outline: it.self === true, // 自己发的加描边，一眼认出来
    track: it.track,
  }));

  return { flying, pending, frame, layout, settings, dropped: queued.dropped };
}

/** 新消息归一化：正文必须是非空字符串，已经在飞或已排队的 id 不再重复放。 */
function normalizeAll(incoming, flying, pending) {
  const out = [];
  const known = new Set();
  for (const it of flying) known.add(it.id);
  for (const it of pending) known.add(it.id);
  for (const raw of incoming) {
    if (!raw || typeof raw !== 'object') continue;
    const text = typeof raw.text === 'string' ? raw.text : '';
    const id = typeof raw.id === 'string' && raw.id ? raw.id : '';
    if (!text || !id || known.has(id)) continue;
    known.add(id);
    out.push({ id, text, self: raw.self === true });
  }
  return out;
}

function capPending(list, max) {
  if (list.length <= max) return { list, dropped: 0 };
  const dropped = list.length - max;
  return { list: list.slice(dropped), dropped };
}

/**
 * 有状态的薄包装：把 flying/pending 存起来，调用方只管 push 和 frame。
 * 真正的逻辑全在 planFrame 里，这里不做判断。
 */
export class DanmakuEngine {
  constructor({ width = 0, height = 0, settings = null, banner = false, measure = measureTextWidth } = {}) {
    this.width = width;
    this.height = height;
    this.settings = settings;
    this.banner = banner;
    this.measure = measure;
    this.flying = [];
    this.pending = [];
    this._incoming = [];
    this.dropped = 0;
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
  }

  setSettings(settings) {
    this.settings = settings;
  }

  setBanner(flag) {
    this.banner = flag === true;
  }

  /**
   * 排进下一帧。msg: {id, text, self}
   * 帧循环停着的时候（播放器正忙着跳转、窗口被节流）新消息会一直攒在这里。排队上限本来就是
   * MAX_PENDING 条、出场时只留最新的，所以这里也只留最新的这么多条，别让刷屏把内存越攒越大。
   */
  push(msg) {
    this._incoming.push(msg);
    if (this._incoming.length > MAX_PENDING) {
      const over = this._incoming.length - MAX_PENDING;
      this._incoming.splice(0, over);
      this.dropped += over;
    }
  }

  /** @returns {Array} 这一帧每条弹幕的位置 */
  frame(now) {
    const incoming = this._incoming;
    this._incoming = [];
    const out = planFrame({
      width: this.width,
      height: this.height,
      now,
      flying: this.flying,
      pending: this.pending,
      incoming,
      settings: this.settings,
      banner: this.banner,
      measure: this.measure,
    });
    this.flying = out.flying;
    this.pending = out.pending;
    this.dropped += out.dropped;
    this.layout = out.layout;
    return out.frame;
  }

  /** 换片、跳转、切换播放器时整场清空。 */
  clear() {
    this.flying = [];
    this.pending = [];
    this._incoming = [];
  }

  get pendingCount() {
    return this.pending.length + this._incoming.length;
  }

  get flyingCount() {
    return this.flying.length;
  }
}
