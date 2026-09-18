import { MAX_TEXT } from '../lib/chat.js';
import { AREAS, DEFAULT_SETTINGS } from '../lib/danmaku.js';
import { make, patch } from './dom.js';

/**
 * 右栏下半部分的聊天面板，外加控制条上的弹幕开关和它那一小块设置，
 * 以及把 danmaku.js 算出的帧按 30Hz 推给播放器的帧循环。
 *
 * 三样东西放在一个文件里是因为它们共用同一套「弹幕聊天」的约定：
 * 消息进聊天流的同时上弹幕，弹幕设置只影响本机，都不碰网络。
 *
 * 几条不许破坏的约定：
 *  - 昵称和聊天正文是用户输入，一律走 make({raw:true})：既不过 t()，也打上 data-i18n-skip，
 *    否则昵称叫「播放」的人在英文界面里会变成 Play，正文也会被字典改写。
 *  - 系统事件（谁进来了、谁按了暂停）整句由 t() 翻译，昵称靠词条里的正则捕获原样带过去，
 *    所以它那一行不能打跳过标记。
 *  - 行以消息 id 为键复用（见 dom.js 的 patch）：「发送中」改成「已送达」时只换那一小段文字，
 *    不重建整条消息，正在选中的文字不会被吃掉。
 *  - 回车发送只在 !isComposing 时算数，拼音选词时按回车不会误发。
 */

/** 距底多少像素以内算「看着最新的消息」。 */
const BOTTOM_SLACK = 24;

/** 聊天列表最多留多少行（再多就丢最老的）。 */
export const VIEW_LIMIT = 300;

/* ============================== 聊天面板 ============================== */

/**
 * @param {{body: Element, foot: Element, onSend: (text:string)=>boolean, onTitle?: (prefix:string)=>void}} deps
 *   body：滚动的消息区；foot：放输入行和未读提示的那一块（不跟着滚）。
 *   onSend 返回 false 表示这条没被收下（比如超速），输入框里的字就留着。
 *   onTitle 收到的是窗口标题前缀，有未读且窗口没焦点时是 "(3) "，否则是空串。
 */
export function createChatPanel({ body, foot, onSend, onTitle } = {}) {
  const unreadBtn = make('button', { className: 'chat-unread hidden', attrs: { type: 'button' } });
  const notice = make('div', { className: 'chat-notice hidden' });
  const input = make('textarea', {
    className: 'chat-input',
    attrs: {
      rows: '1',
      spellcheck: 'false',
      maxlength: String(MAX_TEXT * 2),
      placeholder: '说点什么…',
      'aria-label': '聊天输入框',
    },
  });
  const sendBtn = make('button', { className: 'primary tiny chat-send', text: '发送', attrs: { type: 'button' } });
  const row = make('div', { className: 'chat-input-row' }, [input, sendBtn]);
  foot.replaceChildren(unreadBtn, notice, row);

  let keys = new Set();
  let unread = 0;
  let focused = true;
  let prefix = '';

  const atBottom = () => body.scrollHeight - body.scrollTop - body.clientHeight <= BOTTOM_SLACK;
  const toBottom = () => {
    body.scrollTop = body.scrollHeight;
  };

  /* ------------------------------ 绘制 ------------------------------ */

  function specOf(entry) {
    if (entry.kind === 'system') {
      // 整句翻译：昵称和片名在词条的正则捕获里，不会被改写
      return { key: `s:${entry.key}`, tag: 'div', className: 'chat-system', text: entry.text };
    }
    if (entry.kind === 'divider') {
      return { key: `d:${entry.key}`, tag: 'div', className: 'chat-divider', children: [{ key: 't', text: entry.text }] };
    }
    return {
      key: `m:${entry.key}`,
      tag: 'div',
      className: `chat-msg${entry.self ? ' self' : ''}`,
      children: [
        { key: 'name', raw: true, className: 'chat-name', text: entry.name, attrs: { title: entry.name } },
        { key: 'text', raw: true, className: 'chat-text', text: entry.text },
        entry.state ? { key: 'state', className: `chat-state ${entry.state}`, text: stateLabel(entry.state) } : null,
      ],
    };
  }

  function stateLabel(state) {
    return state === 'sending' ? '发送中' : '已送达';
  }

  function render(view = {}) {
    const entries = view.entries || [];
    // 先看画之前在不在底：patch 之后 scrollHeight 就变了
    const stick = atBottom();
    patch(body, entries.length ? entries.map(specOf) : [{ key: 'empty', tag: 'p', className: 'panel-empty', text: view.emptyText || '还没有消息' }]);

    let fresh = 0;
    for (const entry of entries) {
      // 自己发的不算未读；历史（quiet）是补上来的旧消息，也不算
      if (entry.kind === 'msg' && !entry.self && !entry.quiet && !keys.has(entry.key)) fresh += 1;
    }
    keys = new Set(entries.map((e) => e.key));

    if (stick) toBottom();
    if (stick && focused) unread = 0;
    else unread += fresh;

    notice.classList.toggle('hidden', !view.notice);
    patch(notice, view.notice ? [{ key: 'text', text: view.notice }] : []);
    refreshUnread();
  }

  function refreshUnread() {
    const show = unread > 0 && !atBottom();
    unreadBtn.classList.toggle('hidden', !show);
    patch(unreadBtn, show ? [{ key: 'text', text: `↓ ${unread} 条新消息` }] : []);
    // 标题里的 (N) 只在窗口没焦点时出现 —— 人正看着还给标题挂角标纯属噪音
    const next = !focused && unread > 0 ? `(${unread}) ` : '';
    if (next === prefix) return;
    prefix = next;
    onTitle?.(prefix);
  }

  /* ------------------------------ 交互 ------------------------------ */

  function submit() {
    const text = input.value;
    if (!text.trim()) return;
    if (onSend?.(text) === false) return; // 没被收下（超速）：字留着，别让人重打一遍
    input.value = '';
  }

  input.addEventListener('keydown', (e) => {
    // isComposing：拼音、日文这些输入法选词时的回车是「确认候选」，不是发送
    if (e.key !== 'Enter' || e.isComposing) return;
    // Shift / Ctrl + 回车留给换行
    if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    submit();
  });
  sendBtn.addEventListener('click', submit);

  unreadBtn.addEventListener('click', () => {
    toBottom();
    if (focused) unread = 0;
    refreshUnread();
  });

  body.addEventListener(
    'scroll',
    () => {
      if (focused && atBottom()) unread = 0;
      refreshUnread();
    },
    { passive: true }
  );

  return {
    render,
    /** 窗口拿到 / 丢掉焦点。回到窗口且看着最新消息时，未读清零。 */
    setFocused(flag) {
      focused = flag !== false;
      if (focused && atBottom()) unread = 0;
      refreshUnread();
    },
    focusInput: () => input.focus(),
    unreadCount: () => unread,
  };
}

/* ============================== 弹幕帧循环 ============================== */

/** 每秒帧数。用 setInterval 不用 rAF：主窗口最小化时 rAF 直接停，弹幕会整片卡住。 */
export const DANMAKU_FPS = 30;

/**
 * 交给主进程的虚拟画布。mpv 那条路把它当作 ASS 的 res_x / res_y，
 * 和播放器窗口的真实像素无关，所以固定成 1080p，换窗口大小也不用重排。
 */
export const DANMAKU_CANVAS = { width: 1920, height: 1080 };

/**
 * 把 danmaku.js 的 DanmakuEngine 按帧推给播放器。
 *
 *  - 只在「弹幕开着 + 播放器在跑 + 场上有弹幕」时开表，空了就擦干净覆盖层并停表，
 *    省得没人说话时还每秒 30 次 IPC。
 *  - pause / seek 在途时停发帧：那阵子播放器忙着 settle，插队的覆盖层命令会拖慢它。
 *  - 同一时间只有一帧在途，多余的丢掉（宁可掉帧也不排队）；但「清空」不能丢，
 *    丢了覆盖层上会永远留着最后一帧。
 */
export function createDanmakuPump({
  engine,
  send,
  now = () => Date.now(),
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (handle) => clearInterval(handle),
  fps = DANMAKU_FPS,
} = {}) {
  const interval = Math.max(1, Math.round(1000 / fps));
  let timer = null;
  let enabled = true;
  let active = false; // 播放器这一代在跑
  let busy = false; // pause / seek 在途
  let inFlight = false;
  let pendingClear = false;
  let painted = false; // 覆盖层上还有东西
  let dropped = 0;

  const running = () => enabled && active;

  function post(items) {
    inFlight = true;
    painted = items.length > 0;
    // send 同步抛的话（IPC 通道没了之类），下面的 finally 就没机会把 inFlight 放回去，
    // 帧循环会永久停在「上一帧还在途」上，所以这里自己兜一层。
    let sent;
    try {
      sent = send({ w: engine.width, h: engine.height, items });
    } catch {
      inFlight = false;
      return;
    }
    Promise.resolve(sent)
      .catch(() => {})
      .finally(() => {
        inFlight = false;
        if (!pendingClear) return;
        pendingClear = false;
        post([]);
      });
  }

  function flush(items) {
    if (inFlight) {
      if (items.length) dropped += 1;
      else pendingClear = true;
      return;
    }
    post(items);
  }

  function clearOverlay() {
    if (painted || pendingClear) flush([]);
  }

  function stopTimer() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function tick() {
    if (!running()) {
      stopTimer();
      return;
    }
    if (busy) return;
    const frame = engine.frame(now());
    if (frame.length) {
      // 字号和不透明度必须一起交出去：排布是按它们算的行高和弹道，
      // 丢掉的话主进程只能用兜底值，两个滑块等于没接线，弹道间距也和实际字号对不上。
      flush(
        frame.map((d) => ({
          text: d.text,
          x: d.x,
          y: d.y,
          outline: !!d.outline,
          ...(d.fontSize > 0 ? { fontSize: d.fontSize } : {}),
          ...(typeof d.opacity === 'number' ? { opacity: d.opacity } : {}),
        }))
      );
      return;
    }
    // 场上空了：擦干净覆盖层再停表，下一条弹幕会把表重新叫起来。
    // 还有排队等弹道的就先留着表，不然它们永远出不来。
    if (engine.pendingCount > 0) return;
    stopTimer();
    clearOverlay();
  }

  function wake() {
    if (timer !== null || !running()) return;
    timer = setTimer(tick, interval);
    tick(); // 立刻画第一帧，别让第一条弹幕等一个周期
  }

  function shutdown() {
    stopTimer();
    engine.clear();
    clearOverlay();
  }

  return {
    push(msg) {
      if (!running()) return;
      engine.push(msg);
      wake();
    },
    /** 弹幕开关（本地设置）。 */
    setEnabled(flag) {
      enabled = flag !== false;
      if (running()) wake();
      else shutdown();
    },
    /** 播放器这一代起来了 / 退了。 */
    setActive(flag) {
      active = flag === true;
      if (running()) wake();
      else shutdown();
    },
    /** pause / seek 在途。 */
    setBusy(flag) {
      busy = flag === true;
      if (busy) return;
      // 表还在转就立刻补一帧：停发期间弹幕位置已经变了，等下一个周期看着像卡了一下
      if (timer === null) wake();
      else tick();
    },
    setBanner(flag) {
      engine.setBanner(flag);
    },
    setSettings(settings) {
      engine.setSettings(settings);
    },
    /** 换片、跳转、切换播放器：整场清空。 */
    clear() {
      stopTimer();
      engine.clear();
      clearOverlay();
    },
    isRunning: () => timer !== null,
    stats: () => ({ dropped, painted }),
  };
}

/* ============================== 本地弹幕设置 ============================== */

export const DANMAKU_KEY = 'sw.danmaku';

const OPACITY_RANGE = [0.1, 1];
// 和 lib/danmaku.js 的 resolveSettings 保持同一个范围：滑块拖得比它宽的话，超出去那一段没反应
const FONT_SCALE_RANGE = [0.5, 2];
const SPEED_RANGE = [0.25, 4];

function clampNumber(value, [min, max], fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** localStorage 里存的就是 DEFAULT_SETTINGS 那个形状。坏值一律回落到默认，绝不抛。 */
export function loadDanmakuSettings(storage = globalThis.localStorage) {
  const out = { ...DEFAULT_SETTINGS };
  let raw = null;
  try {
    raw = JSON.parse(storage?.getItem(DANMAKU_KEY) || 'null');
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  out.opacity = clampNumber(raw.opacity, OPACITY_RANGE, out.opacity);
  out.fontScale = clampNumber(raw.fontScale, FONT_SCALE_RANGE, out.fontScale);
  out.speed = clampNumber(raw.speed, SPEED_RANGE, out.speed);
  if (AREAS.includes(raw.area)) out.area = raw.area;
  return out;
}

export function saveDanmakuSettings(settings, storage = globalThis.localStorage) {
  const value = {
    enabled: settings.enabled !== false,
    opacity: clampNumber(settings.opacity, OPACITY_RANGE, DEFAULT_SETTINGS.opacity),
    fontScale: clampNumber(settings.fontScale, FONT_SCALE_RANGE, DEFAULT_SETTINGS.fontScale),
    speed: clampNumber(settings.speed, SPEED_RANGE, DEFAULT_SETTINGS.speed),
    area: AREAS.includes(settings.area) ? settings.area : DEFAULT_SETTINGS.area,
  };
  try {
    storage?.setItem(DANMAKU_KEY, JSON.stringify(value));
  } catch {
    /* 隐私模式下写不进去就算了，这一场仍然按内存里的设置走 */
  }
  return value;
}

/* ============================== 控制条上的弹幕开关 ============================== */

const SLIDERS = [
  { key: 'opacity', label: '不透明度', range: OPACITY_RANGE, step: 0.05 },
  { key: 'fontScale', label: '字号', range: FONT_SCALE_RANGE, step: 0.1 },
  { key: 'speed', label: '速度', range: SPEED_RANGE, step: 0.25 },
];

/**
 * 控制条上的「弹幕 ◉ ⚙」。设置只影响本机，改完立刻回调，由 app 层存进 localStorage。
 * @param {{slot: Element, settings: object, onChange: (next:object)=>void}} deps
 */
export function createDanmakuControls({ slot, settings, onChange } = {}) {
  let current = { ...DEFAULT_SETTINGS, ...(settings || {}) };

  const toggle = make('input', { className: 'dm-check', attrs: { type: 'checkbox' } });
  const label = make('label', { className: 'dm-toggle' }, [toggle, make('span', { text: '弹幕' })]);
  const gear = make('button', {
    className: 'ghost tiny dm-gear',
    text: '⚙',
    attrs: { type: 'button', title: '弹幕设置', 'aria-label': '弹幕设置', 'aria-expanded': 'false' },
  });
  const panel = make('div', { className: 'dm-panel hidden' });
  slot.replaceChildren(label, gear, panel);

  const controls = new Map();
  for (const spec of SLIDERS) {
    const field = make('input', {
      className: 'dm-range',
      attrs: {
        type: 'range',
        min: String(spec.range[0]),
        max: String(spec.range[1]),
        step: String(spec.step),
        'aria-label': spec.label,
      },
    });
    field.addEventListener('input', () => emit({ [spec.key]: clampNumber(field.value, spec.range, current[spec.key]) }));
    controls.set(spec.key, field);
    panel.append(make('div', { className: 'dm-row' }, [make('span', { className: 'dm-label', text: spec.label }), field]));
  }

  const area = make(
    'select',
    { className: 'dm-area', attrs: { 'aria-label': '显示区域' } },
    AREAS.map((value) => make('option', { text: value === 'half' ? '上半屏' : '全屏', attrs: { value } }))
  );
  area.addEventListener('change', () => emit({ area: AREAS.includes(area.value) ? area.value : current.area }));
  panel.append(make('div', { className: 'dm-row' }, [make('span', { className: 'dm-label', text: '显示区域' }), area]));

  toggle.addEventListener('change', () => emit({ enabled: !!toggle.checked }));
  gear.addEventListener('click', () => setOpen(panel.classList.contains('hidden')));

  function setOpen(open) {
    panel.classList.toggle('hidden', !open);
    gear.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function emit(patchObj) {
    current = { ...current, ...patchObj };
    render(current);
    onChange?.({ ...current });
  }

  function render(next) {
    current = { ...current, ...(next || {}) };
    toggle.checked = current.enabled !== false;
    for (const spec of SLIDERS) controls.get(spec.key).value = String(current[spec.key]);
    area.value = AREAS.includes(current.area) ? current.area : DEFAULT_SETTINGS.area;
    slot.classList.toggle('dm-off', current.enabled === false);
  }

  render(current);
  return { render, close: () => setOpen(false), isOpen: () => !panel.classList.contains('hidden') };
}
