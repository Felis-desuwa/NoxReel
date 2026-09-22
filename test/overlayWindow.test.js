'use strict';

/**
 * 覆盖窗（P6）：外部播放器身上那一层弹幕。
 *
 * 这一层的四个要害，下面每个都有对应的测试：
 *  1. **几何**：桥接程序报物理像素，Electron 吃 DIP，中间隔着 DPI 缩放。边缘必须对齐，
 *     差一个像素就是播放器边上露一条缝。
 *  2. **层级**：什么时候显示、什么时候压在播放器上面、什么时候升成置顶、什么时候干脆藏起来。
 *     P0 实测隐藏状态下 moveAbove 会把窗口重新显示出来，所以「该隐藏」的分支里一个置层调用都不许有。
 *  3. **通道**：preload 只开两个口子；overlay:submit 必须核对发送方真是覆盖窗。
 *  4. **画笔**：正文只走 canvas 的 fillText；锁屏下 rAF 不限速，得自己限到 60fps。
 *
 * 全程纯 Node：不起 Electron、不起播放器、不起桥接程序。BrowserWindow 和 canvas 上下文都是假的。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const REPO = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

const {
  OverlayController,
  OVERLAY_URL,
  OVERLAY_PRELOAD,
  FRAME_CHANNEL,
  SUBMIT_CHANNEL,
  MAX_CHAT_TEXT,
  rectToBounds,
  toDipBounds,
  decideOverlay,
  mediaSourceId,
  overlayAbovePlayer,
  nativeHandleToNumber,
  sanitizeChatText,
} = require('../src/main/overlay');

const OVERLAY_MODULE = '../src/renderer/overlay/overlay.js';

/* ============================== 几何换算 ============================== */

test('桥接程序的矩形归一：两种形状都认，零面积和坏值一律当作没有几何', () => {
  assert.deepEqual(rectToBounds([100, 50, 400, 250]), { x: 100, y: 50, width: 300, height: 200 });
  assert.deepEqual(rectToBounds({ x: 1, y: 2, width: 3, height: 4 }), { x: 1, y: 2, width: 3, height: 4 });
  // 最小化的窗口客户区会报成 0×0，贴上去就是个看不见的窗口
  assert.equal(rectToBounds([0, 0, 0, 0]), null);
  assert.equal(rectToBounds([100, 50, 90, 250]), null, '右边缘在左边缘左侧');
  assert.equal(rectToBounds([0, 0, Number.NaN, 10]), null);
  assert.equal(rectToBounds([1, 2, 3]), null, '少一条边');
  assert.equal(rectToBounds(null), null);
});

test('物理像素换算成 DIP 时左右两条边各自取整，宽度由取整后的边缘相减', () => {
  const seen = [];
  // 150% 缩放下的典型小数值。x 的小数部分向上进、宽度的小数部分也向上进，
  // 两个各自取整就会把右边缘顶出去一个像素 —— 正好是「播放器右边露一条缝」的那一格。
  const convert = (rect) => {
    seen.push(rect);
    return { x: 42.6, y: 10.2, width: 100.8, height: 50.9 };
  };
  const bounds = toDipBounds([100, 50, 400, 250], convert);

  assert.deepEqual(seen, [{ x: 100, y: 50, width: 300, height: 200 }], '传给 screenToDipRect 的是物理像素矩形');
  // 左 43、右 round(42.6+100.8)=143 → 宽 100。各自取整的话宽度会是 round(100.8)=101。
  assert.deepEqual(bounds, { x: 43, y: 10, width: 100, height: 51 });

  // 换算函数缺席（非 Windows 或者 screen 还没就绪）就原样取整，不能把几何丢掉
  assert.deepEqual(toDipBounds([10, 20, 110, 140], null), { x: 10, y: 20, width: 100, height: 120 });
  // 100% 缩放：一进一出必须完全对齐
  assert.deepEqual(
    toDipBounds([7, 9, 1927, 1089], (r) => r),
    { x: 7, y: 9, width: 1920, height: 1080 }
  );
  // 窗口刚好在这一刻没了，screenToDipRect 抛出来：当作没有几何，不能把整条更新炸掉
  assert.equal(
    toDipBounds([0, 0, 10, 10], () => {
      throw new Error('窗口没了');
    }),
    null
  );
  // 缩放极大时宽度被压到 0：至少留一个像素，否则 setBounds 拿到 0 会抛
  assert.deepEqual(toDipBounds([0, 0, 2, 2], () => ({ x: 0, y: 0, width: 0.2, height: 0.2 })), {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  });
});

/* ============================== 显示与层级的状态机 ============================== */

const playing = (extra = {}) => ({
  hwnd: 12345,
  alive: true,
  minimized: false,
  visible: true,
  cloaked: false,
  foreground: true,
  fullscreenLike: false,
  fse: false,
  client: [0, 0, 1280, 720],
  ...extra,
});

test('该显示、该置顶、该隐藏：层级决策是个纯函数', () => {
  // 正常窗口：压在播放器上面一层，跟着它的 Z 序走
  assert.deepEqual(decideOverlay(playing()), { visible: true, level: 'above', hwnd: 12345, reason: 'normal' });

  // 弹幕关了 / 播放器没在跑
  assert.deepEqual(decideOverlay(playing(), { enabled: false }).reason, 'disabled');
  assert.equal(decideOverlay(playing(), { enabled: false }).visible, false);

  // 没有窗口可贴
  assert.equal(decideOverlay(null).reason, 'no-window');
  assert.equal(decideOverlay(playing({ alive: false })).reason, 'no-window');
  assert.equal(decideOverlay(playing({ hwnd: 0 })).reason, 'no-window');

  // 看不见的三种：最小化、被 DWM cloak（切到别的虚拟桌面）、窗口自己隐藏了
  assert.equal(decideOverlay(playing({ minimized: true })).visible, false);
  assert.equal(decideOverlay(playing({ minimized: true })).reason, 'minimized');
  assert.equal(decideOverlay(playing({ cloaked: true })).reason, 'cloaked');
  assert.equal(decideOverlay(playing({ visible: false })).reason, 'invisible');

  // 独占全屏：画面显卡直出，任何窗口都压不上去
  assert.deepEqual(decideOverlay(playing({ fse: true, fullscreenLike: true })), {
    visible: false,
    level: null,
    hwnd: null,
    reason: 'exclusive-fullscreen',
  });

  // 全屏且在前台：Z 序里没有「上面一层」可言，只有 screen-saver 这一档压得住
  assert.deepEqual(decideOverlay(playing({ fullscreenLike: true })), {
    visible: true,
    level: 'topmost',
    hwnd: 12345,
    reason: 'fullscreen',
  });
  // 全屏但丢了前台：别人正盖着播放器，此时置顶就是糊在别人脸上，降级回 moveAbove
  assert.deepEqual(decideOverlay(playing({ fullscreenLike: true, foreground: false })), {
    visible: true,
    level: 'above',
    hwnd: 12345,
    reason: 'fullscreen-background',
  });

  // 两个矩形都是空的：没有几何可贴
  assert.equal(decideOverlay(playing({ client: [0, 0, 0, 0], rect: null })).reason, 'empty-rect');
  // 客户区空但窗口矩形还在（刚建好的窗口）：仍然算有几何
  assert.equal(decideOverlay(playing({ client: [0, 0, 0, 0], rect: [0, 0, 100, 80] })).visible, true);
});

test('Z 序核对只要求「覆盖窗在播放器之上的链条里」', () => {
  // 本机的 360tray 会往播放器上方挂小窗，要求「必须紧挨着」会在这台机器上永远判失败
  const chain = [{ hwnd: 777, cls: '360tray' }, { hwnd: 999 }];
  assert.equal(overlayAbovePlayer(chain, 999), true);
  assert.equal(overlayAbovePlayer(chain, 888), false);
  assert.equal(overlayAbovePlayer([], 999), false);
  assert.equal(overlayAbovePlayer(null, 999), false);
  assert.equal(overlayAbovePlayer(chain, 0), false);
  // 句柄从 JSON 回来可能是字符串
  assert.equal(overlayAbovePlayer([{ hwnd: '999' }], 999), true);
});

test('窗口句柄与 moveAbove 的目标 id', () => {
  assert.equal(mediaSourceId(12345), 'window:12345:0');
  const buf64 = Buffer.alloc(8);
  buf64.writeBigUInt64LE(9007199254740n, 0);
  assert.equal(nativeHandleToNumber(buf64), 9007199254740);
  const buf32 = Buffer.alloc(4);
  buf32.writeUInt32LE(4242, 0);
  assert.equal(nativeHandleToNumber(buf32), 4242);
  assert.equal(nativeHandleToNumber(null), 0);
  assert.equal(nativeHandleToNumber(Buffer.alloc(2)), 0);
});

/* ============================== 假 Electron ============================== */

class FakeWebContents {
  constructor(win) {
    this.win = win;
    this.mainFrame = { url: OVERLAY_URL };
    this.listeners = new Map();
    this.sent = [];
    this.openHandler = null;
  }
  on(name, fn) {
    const list = this.listeners.get(name) || [];
    list.push(fn);
    this.listeners.set(name, list);
    return this;
  }
  emit(name, ...args) {
    for (const fn of this.listeners.get(name) || []) fn(...args);
  }
  send(channel, payload) {
    this.sent.push({ channel, payload });
  }
  setWindowOpenHandler(fn) {
    this.openHandler = fn;
  }
}

class FakeWindow {
  constructor(options) {
    this.options = options;
    this.webContents = new FakeWebContents(this);
    this.calls = [];
    this.visible = false;
    this.destroyed = false;
    this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
    this.focusable = options.focusable !== false;
    this.ignoreMouse = null;
    this.loaded = null;
    this.moveAboveThrows = false;
    this.closeListeners = [];
  }
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return this.visible;
  }
  setMenuBarVisibility(flag) {
    this.calls.push(['setMenuBarVisibility', flag]);
  }
  setIgnoreMouseEvents(flag) {
    this.ignoreMouse = flag;
    this.calls.push(['setIgnoreMouseEvents', flag]);
  }
  setBounds(bounds) {
    this.bounds = bounds;
    this.calls.push(['setBounds', bounds]);
  }
  showInactive() {
    this.visible = true;
    this.calls.push(['showInactive']);
  }
  show() {
    this.visible = true;
    this.calls.push(['show']);
  }
  focus() {
    this.calls.push(['focus']);
  }
  hide() {
    this.visible = false;
    this.calls.push(['hide']);
  }
  setFocusable(flag) {
    this.focusable = flag;
    this.calls.push(['setFocusable', flag]);
  }
  setAlwaysOnTop(flag, level) {
    this.calls.push(['setAlwaysOnTop', flag, level]);
  }
  moveAbove(id) {
    this.calls.push(['moveAbove', id]);
    if (this.moveAboveThrows) throw new Error('目标窗口已销毁');
  }
  loadFile(file) {
    this.loaded = file;
    this.calls.push(['loadFile', file]);
  }
  getNativeWindowHandle() {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(this.handle || 999), 0);
    return buf;
  }
  on(name, fn) {
    if (name === 'closed') this.closeListeners.push(fn);
  }
  destroy() {
    this.destroyed = true;
    this.calls.push(['destroy']);
    for (const fn of this.closeListeners) fn();
  }
  names() {
    return this.calls.map((c) => c[0]);
  }
}

/** 150% 缩放的假 screen：换算真的发生过才算数。 */
function fakeElectron() {
  const created = [];
  return {
    created,
    BrowserWindow: class extends FakeWindow {
      constructor(options) {
        super(options);
        created.push(this);
      }
    },
    screen: {
      screenToDipRect: (_win, rect) => ({
        x: rect.x / 1.5,
        y: rect.y / 1.5,
        width: rect.width / 1.5,
        height: rect.height / 1.5,
      }),
    },
  };
}

function makeController(extra = {}) {
  const electron = fakeElectron();
  const focused = [];
  const controller = new OverlayController({ electron, focusPlayer: () => focused.push(Date.now()), ...extra });
  controller.setEnabled(true);
  return { controller, electron, focused, win: () => electron.created[0] };
}

/* ============================== 窗口选项与页面 ============================== */

test('覆盖窗的窗口选项：透明、无边框、不可聚焦、点击穿透、不节流、sandbox', () => {
  const { controller, win } = makeController();
  controller.update(playing());
  const w = win();
  assert.ok(w, '该显示的时候才建窗口');

  assert.equal(w.options.transparent, true);
  assert.equal(w.options.frame, false);
  assert.equal(w.options.focusable, false, '默认不可聚焦：点播放器进度条不能被这层截胡');
  assert.equal(w.options.skipTaskbar, true);
  assert.equal(w.options.show, false);
  assert.equal(w.options.hasShadow, false);
  assert.equal(w.options.webPreferences.sandbox, true);
  assert.equal(w.options.webPreferences.contextIsolation, true);
  assert.equal(w.options.webPreferences.nodeIntegration, false);
  assert.equal(w.options.webPreferences.backgroundThrottling, false, '覆盖窗常年不在前台，节流会把 rAF 停掉');
  assert.equal(w.options.webPreferences.preload, OVERLAY_PRELOAD);
  assert.deepEqual(w.ignoreMouse, true, 'setIgnoreMouseEvents(true)');
  assert.match(String(w.loaded), /overlay\.html$/);

  // 导航拦截：只许待在覆盖窗这一个页面上
  let prevented = false;
  w.webContents.emit('will-navigate', { preventDefault: () => (prevented = true) }, 'https://example.com/');
  assert.equal(prevented, true);
  prevented = false;
  w.webContents.emit('will-navigate', { preventDefault: () => (prevented = true) }, OVERLAY_URL);
  assert.equal(prevented, false);
  // 开新窗一律拒绝
  assert.deepEqual(w.webContents.openHandler({ url: 'https://example.com/' }), { action: 'deny' });
});

test('覆盖窗页面的 CSP 从严，且正文不经内联脚本样式', () => {
  const html = read('src', 'renderer', 'overlay.html');
  const csp = /content="([^"]*)"/.exec(html);
  assert.ok(csp, '覆盖窗页面必须自带 CSP');
  const policy = csp[1];
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /script-src 'self'/);
  assert.match(policy, /style-src 'self'/);
  assert.match(policy, /connect-src 'none'/, '覆盖窗不需要任何网络连接');
  assert.match(policy, /img-src 'none'/);
  assert.match(policy, /object-src 'none'/);
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
  // 页面里除了那条 module 引用不许有别的脚本，也不许有内联样式块
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)/);
  assert.doesNotMatch(html, /<style/);
  assert.match(html, /<script type="module" src="overlay\/overlay\.js">/);
});

/* ============================== 几何与置层的落地 ============================== */

test('几何经 screenToDipRect 落到窗口上；每次位置变化都跟着走', () => {
  const { controller, win } = makeController();
  controller.update(playing({ client: [150, 300, 1950, 1320] }));
  // 150% 缩放：/1.5 之后是 (100,200) 1200×680
  assert.deepEqual(win().bounds, { x: 100, y: 200, width: 1200, height: 680 });

  controller.update(playing({ client: [0, 0, 1920, 1080] }));
  assert.deepEqual(win().bounds, { x: 0, y: 0, width: 1280, height: 720 });
});

test('默认压在播放器上面一层，全屏且在前台时才升成置顶', () => {
  const { controller, win } = makeController();
  controller.update(playing());
  const w = win();
  assert.ok(w.calls.some((c) => c[0] === 'moveAbove' && c[1] === 'window:12345:0'));
  assert.equal(w.visible, true);
  // 先显示再置层：隐藏状态下 moveAbove 会把窗口显示出来，顺序反了要多闪一下
  assert.ok(w.names().indexOf('showInactive') < w.names().lastIndexOf('moveAbove'));

  w.calls.length = 0;
  controller.update(playing({ fullscreenLike: true }));
  assert.deepEqual(
    w.calls.filter((c) => c[0] === 'setAlwaysOnTop'),
    [['setAlwaysOnTop', true, 'screen-saver']],
    '全屏窗口压着任务栏，只有 screen-saver 这一档盖得住'
  );
  assert.ok(!w.names().includes('moveAbove'), '置顶这一档不该再去 moveAbove');

  // 丢了前台就降级回 moveAbove，并且把置顶摘掉
  w.calls.length = 0;
  controller.update(playing({ fullscreenLike: true, foreground: false }));
  assert.ok(w.calls.some((c) => c[0] === 'setAlwaysOnTop' && c[1] === false));
  assert.ok(w.names().includes('moveAbove'));
});

test('该隐藏的时候藏起来，而且一个置层调用都不许发', () => {
  const { controller, win } = makeController();
  controller.update(playing());
  const w = win();

  for (const hidden of [{ minimized: true }, { cloaked: true }, { visible: false }, { fse: true }]) {
    w.calls.length = 0;
    w.visible = true;
    controller.update(playing(hidden));
    assert.equal(w.visible, false, `${JSON.stringify(hidden)} 时该藏起来`);
    // P0 实测：隐藏状态下调 moveAbove 会把窗口重新显示出来
    assert.ok(!w.names().includes('moveAbove'), `${JSON.stringify(hidden)} 时不许 moveAbove`);
    assert.ok(!w.names().includes('setAlwaysOnTop'), `${JSON.stringify(hidden)} 时不许置顶`);
    assert.ok(!w.names().includes('setBounds'), `${JSON.stringify(hidden)} 时连几何都不用动`);
  }

  // 弹幕关了也一样
  w.calls.length = 0;
  w.visible = true;
  controller.setEnabled(false);
  assert.equal(w.visible, false);
  assert.ok(!w.names().includes('moveAbove'));
});

test('moveAbove 抛异常（目标窗口已销毁）不会把这次更新炸掉', () => {
  const { controller, win } = makeController();
  controller.update(playing());
  win().moveAboveThrows = true;
  assert.doesNotThrow(() => controller.update(playing({ client: [0, 0, 640, 480] })));
});

test('Z 序核对：覆盖窗不在播放器之上的链条里就再置一次层', () => {
  const { controller, win } = makeController();
  controller.update(playing());
  const w = win();
  w.handle = 999;

  // 链条里有覆盖窗自己：不用重置
  w.calls.length = 0;
  controller.update(playing({ above: [{ hwnd: 999 }] }));
  assert.equal(w.calls.filter((c) => c[0] === 'moveAbove').length, 1, '正常那一次置层');

  // 链条里只有别人（本机的 360tray）：补一次
  w.calls.length = 0;
  controller.update(playing({ above: [{ hwnd: 777, cls: '360tray' }] }));
  assert.equal(w.calls.filter((c) => c[0] === 'moveAbove').length, 2, '发现掉层了要补置一次');
});

test('独占全屏只提示一次，恢复之后再进去才会再提示', () => {
  const { controller } = makeController();
  const notices = [];
  controller.on('notice', (n) => notices.push(n.code));

  controller.update(playing());
  assert.deepEqual(notices, []);
  controller.update(playing({ fse: true }));
  controller.update(playing({ fse: true, client: [0, 0, 1920, 1080] }));
  assert.deepEqual(notices, ['exclusive-fullscreen'], '连续多次窗口事件只提示一次');

  controller.update(playing());
  controller.update(playing({ fse: true }));
  assert.deepEqual(notices, ['exclusive-fullscreen', 'exclusive-fullscreen']);
});

/* ============================== 帧转发与输入条 ============================== */

test('页面没加载完时，有状态的那几样先存着，加载完补发', () => {
  const { controller, win } = makeController();
  controller.update(playing());
  const w = win();

  assert.equal(controller.frame({ banner: '大家在等缓冲' }), false, '还没 did-finish-load');
  // 横幅之后紧跟着一帧弹幕。只留「最后一帧」的话横幅就被顶掉了，
  // 那一场直到下次横幅变化之前都不会再有人提起它。
  assert.equal(controller.frame({ w: 1920, h: 1080, items: [{ text: '先到的一条', x: 10, y: 10 }] }), false);
  assert.deepEqual(w.webContents.sent, []);

  w.webContents.emit('did-finish-load');
  assert.deepEqual(
    w.webContents.sent,
    [{ channel: FRAME_CHANNEL, payload: { banner: '大家在等缓冲' } }],
    '补发的是横幅这种有状态的；那一帧弹幕不补，补上去也已经是过时的坐标'
  );

  assert.equal(controller.frame({ items: [] }), true);
  assert.equal(w.webContents.sent.length, 2);
});

test('输入条：临时可聚焦、可点击，关掉之后把前台还给播放器', () => {
  const { controller, win, focused } = makeController();
  controller.update(playing());
  const w = win();
  w.webContents.emit('did-finish-load');

  assert.equal(controller.openChat({ prompt: '弹幕：' }), true);
  assert.equal(w.focusable, true);
  assert.equal(w.ignoreMouse, false, '弹出输入条时必须能点');
  assert.ok(w.names().includes('focus'));
  assert.deepEqual(w.webContents.sent.at(-1).payload, { chat: { open: true, prompt: '弹幕：', maxLength: MAX_CHAT_TEXT } });

  controller.closeChat();
  assert.equal(w.focusable, false);
  assert.equal(w.ignoreMouse, true, '关掉之后点击穿透要装回去');
  assert.equal(focused.length, 1, '前台还给播放器');

  // 独占全屏下覆盖窗根本看不见，这时候抢前台等于把播放器踢出全屏
  controller.update(playing({ fse: true }));
  assert.equal(controller.openChat({ prompt: '弹幕：' }), false);
});

test('输入条超时兜底：页面不报回来也要把点击穿透装回去', async () => {
  // 覆盖窗页面崩了、或者 overlay:submit 这条 IPC 断了的时候，没人来关这条输入条 ——
  // 而它开着的这段时间窗口是可点、可聚焦的，整个播放器客户区都被这层透明窗口挡着。
  const { controller, win, focused } = makeController({ chatTimeoutMs: 30 });
  controller.update(playing());
  win().webContents.emit('did-finish-load');

  controller.openChat({ prompt: '弹幕：' });
  assert.equal(win().ignoreMouse, false);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(controller.chatOpen, false, '输入条永远卡在开着的状态');
  assert.equal(win().ignoreMouse, true, '点击穿透没装回去，播放器再也点不动');
  assert.equal(win().focusable, false);
  assert.equal(focused.length, 1, '前台还给播放器');

  // 正常关掉的那一路不该留着定时器：再开一次、按时关掉，之后什么都不该再发生
  controller.openChat({ prompt: '弹幕：' });
  controller.closeChat();
  const sentCount = win().webContents.sent.length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(win().webContents.sent.length, sentCount, '已经关掉的输入条不该被超时再关一次');
});

test('输入条开着时窗口转入隐藏：输入条跟着收掉', () => {
  const { controller, win, focused } = makeController();
  controller.update(playing());
  win().webContents.emit('did-finish-load');
  controller.openChat({ prompt: '弹幕：' });
  controller.update(playing({ minimized: true }));
  assert.equal(controller.chatOpen, false);
  assert.equal(win().focusable, false);
  assert.equal(focused.length, 1);
});

/* ============================== overlay:submit ============================== */

function submitEvent(controller, { url = OVERLAY_URL, sender = null, frame = null } = {}) {
  const contents = controller.win.webContents;
  const senderFrame = frame || contents.mainFrame;
  senderFrame.url = url;
  return { sender: sender || contents, senderFrame };
}

test('overlay:submit 只认覆盖窗自己发来的请求', () => {
  const { controller, win } = makeController();
  controller.update(playing());
  win().webContents.emit('did-finish-load');
  const chats = [];
  controller.on('chat', (c) => chats.push(c.text));

  controller.openChat({ prompt: '弹幕：' });
  assert.deepEqual(controller.handleSubmit(submitEvent(controller), { text: '这段真好看' }), {
    sent: true,
    text: '这段真好看',
  });
  assert.deepEqual(chats, ['这段真好看']);

  // 换个 webContents（主窗口、或者别的什么页面）
  assert.throws(
    () => controller.handleSubmit({ sender: {}, senderFrame: controller.win.webContents.mainFrame }, { text: 'x' }),
    /不受信任/
  );
  // 同一个 webContents，但 URL 不是覆盖窗页面
  assert.throws(() => controller.handleSubmit(submitEvent(controller, { url: 'https://evil.example/' }), { text: 'x' }), /不受信任/);
  // 子框架冒充主框架
  assert.throws(
    () => controller.handleSubmit(submitEvent(controller, { frame: { url: OVERLAY_URL } }), { text: 'x' }),
    /不受信任/
  );
  assert.deepEqual(chats, ['这段真好看'], '被拒的三次一条都没发出去');
});

test('提交的正文：空串是「取消」，控制字符换成空格，超长直接拒', () => {
  const { controller, win, focused } = makeController();
  controller.update(playing());
  win().webContents.emit('did-finish-load');
  const chats = [];
  controller.on('chat', (c) => chats.push(c.text));

  controller.openChat({ prompt: '弹幕：' });
  // Esc 取消：关输入条、把前台还回去，但不发言
  assert.deepEqual(controller.handleSubmit(submitEvent(controller), { text: '' }), { sent: false });
  assert.deepEqual(chats, []);
  assert.equal(focused.length, 1);
  assert.equal(win().ignoreMouse, true);

  // 每一次提交都对应一次按快捷键弹出的输入条（提交之后输入条就关了）
  const submit = (payload) => {
    controller.openChat({ prompt: '弹幕：' });
    return controller.handleSubmit(submitEvent(controller), payload);
  };
  // 换行是弹幕帧里的分隔符，不能由正文带进来
  assert.equal(submit({ text: ' 前\n后\t ' }).text, '前 后');
  // 截断按码点：不能把 emoji 劈成半个代理对
  const long = '好'.repeat(MAX_CHAT_TEXT + 50);
  assert.equal(Array.from(submit({ text: long }).text).length, MAX_CHAT_TEXT);
  // 一次灌几万字：不是截断，是拒
  assert.throws(() => submit({ text: 'a'.repeat(9000) }), /无效/);
  assert.throws(() => submit({ text: { evil: true } }), /无效/);
});

test('正文清洗是纯函数，单独也能用', () => {
  assert.deepEqual(sanitizeChatText('  好  看  '), { ok: true, text: '好 看' });
  assert.deepEqual(sanitizeChatText(''), { ok: true, text: '' });
  assert.deepEqual(sanitizeChatText(null), { ok: true, text: '' });
  assert.deepEqual(sanitizeChatText(42), { ok: false, reason: 'type' });
  assert.deepEqual(sanitizeChatText('a'.repeat(5000)), { ok: false, reason: 'length' });
  assert.equal(sanitizeChatText(`行${String.fromCharCode(0x2028)}分隔`).text, '行 分隔');
});

test('attachIpc 把 overlay:submit 挂上去，channel 名字不许改', () => {
  const { controller } = makeController();
  const handlers = new Map();
  controller.attachIpc({ handle: (channel, fn) => handlers.set(channel, fn) });
  assert.deepEqual([...handlers.keys()], [SUBMIT_CHANNEL]);
  assert.equal(SUBMIT_CHANNEL, 'overlay:submit');
  assert.equal(FRAME_CHANNEL, 'overlay:frame');
  // 没建窗口的时候被调用也不能放行
  assert.throws(() => handlers.get(SUBMIT_CHANNEL)({ sender: {} }, { text: 'x' }), /不受信任/);
});

/* ============================== preload 只开两个口子 ============================== */

test('覆盖窗的 preload 恰好暴露 onFrame 和 submitChat 两个接口', () => {
  const exposed = new Map();
  const ipc = { on: [], off: [], invoke: [] };
  const fake = {
    contextBridge: { exposeInMainWorld: (key, value) => exposed.set(key, value) },
    ipcRenderer: {
      on: (...a) => ipc.on.push(a),
      off: (...a) => ipc.off.push(a),
      invoke: (...a) => {
        ipc.invoke.push(a);
        return Promise.resolve({ sent: true });
      },
    },
  };
  const original = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'electron') return 'electron-fake-overlay';
    return original.call(this, request, ...rest);
  };
  require.cache['electron-fake-overlay'] = {
    id: 'electron-fake-overlay',
    filename: 'electron-fake-overlay',
    loaded: true,
    exports: fake,
  };
  try {
    delete require.cache[require.resolve('../src/main/overlayPreload.js')];
    require('../src/main/overlayPreload.js');
  } finally {
    Module._resolveFilename = original;
  }

  assert.deepEqual([...exposed.keys()], ['noxOverlay']);
  const api = exposed.get('noxOverlay');
  assert.deepEqual(Object.keys(api).sort(), ['onFrame', 'submitChat']);
  assert.equal(typeof api.onFrame, 'function');
  assert.equal(typeof api.submitChat, 'function');

  // onFrame 只挂 overlay:frame，并且退得掉
  const seen = [];
  const dispose = api.onFrame((p) => seen.push(p));
  assert.equal(ipc.on[0][0], FRAME_CHANNEL);
  ipc.on[0][1]({}, { banner: '在等缓冲' });
  assert.deepEqual(seen, [{ banner: '在等缓冲' }]);
  dispose();
  assert.equal(ipc.off[0][0], FRAME_CHANNEL);

  api.submitChat('这段真好看');
  assert.deepEqual(ipc.invoke[0], [SUBMIT_CHANNEL, { text: '这段真好看' }]);

  // preload 里不许有第二条通道
  const src = read('src', 'main', 'overlayPreload.js');
  const channels = new Set((src.match(/'overlay:[a-zA-Z]+'/g) || []).map((s) => s.slice(1, -1)));
  assert.deepEqual([...channels].sort(), ['overlay:frame', 'overlay:submit']);
  assert.doesNotMatch(src, /webUtils|clipboard|shell|require\('fs'\)/);
});

/* ============================== 画笔 ============================== */

/** 记下每一次画笔调用，连同当时的颜色和字体。 */
function fakeContext() {
  const calls = [];
  const ctx = {
    calls,
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: '',
    textAlign: '',
    textBaseline: '',
    globalAlpha: 1,
    setTransform: (...a) => calls.push(['setTransform', ...a]),
    clearRect: (...a) => calls.push(['clearRect', ...a]),
    fillRect: (...a) => calls.push(['fillRect', ...a]),
    measureText: (text) => ({ width: Array.from(String(text)).length * 12 }),
    fillText: (text, x, y) => calls.push(['fillText', text, x, y, ctx.fillStyle, ctx.font, ctx.globalAlpha]),
    strokeText: (text, x, y) => calls.push(['strokeText', text, x, y, ctx.strokeStyle, ctx.lineWidth]),
  };
  return ctx;
}

function fakeCanvasEnv({ width = 1280, height = 720, dpr = 1 } = {}) {
  const ctx = fakeContext();
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  const frames = [];
  const bar = { classList: { list: new Set(['hidden']), add: (c) => bar.classList.list.add(c), remove: (c) => bar.classList.list.delete(c) } };
  // 输入条开着时才出现的挡板：点在输入条以外的那一下就落在它身上
  const shield = {
    listeners: new Map(),
    classList: { list: new Set(['hidden']), add: (c) => shield.classList.list.add(c), remove: (c) => shield.classList.list.delete(c) },
    addEventListener(name, fn) {
      this.listeners.set(name, fn);
    },
    removeEventListener(name) {
      this.listeners.delete(name);
    },
  };
  const input = {
    value: '',
    placeholder: '',
    maxLength: 0,
    focused: false,
    listeners: new Map(),
    addEventListener(name, fn) {
      this.listeners.set(name, fn);
    },
    removeEventListener(name) {
      this.listeners.delete(name);
    },
    focus() {
      this.focused = true;
    },
    blur() {
      const was = this.focused;
      this.focused = false;
      // 真浏览器里 blur() 会同步派发 blur 事件。少了这一下，「关输入条时不能把自己
      // 的失焦处理再触发一遍」这条就测不到了。
      if (was && this.listeners.has('blur')) this.listeners.get('blur')({});
    },
  };
  const submitted = [];
  const bridge = {
    onFrame: (cb) => {
      frames.push(cb);
      return () => frames.splice(frames.indexOf(cb), 1);
    },
    submitChat: (text) => {
      submitted.push(text);
      return Promise.resolve({ sent: true });
    },
  };
  // 假 rAF：排了几帧、跑哪一帧、撤哪一帧都由测试说了算
  const queue = new Map();
  let nextId = 1;
  const raf = {
    pending: () => queue.size,
    run(ts) {
      const entry = [...queue.entries()][0];
      if (!entry) throw new Error('没有排着的帧');
      queue.delete(entry[0]);
      entry[1](ts);
    },
  };
  return {
    ctx,
    canvas,
    bar,
    shield,
    input,
    bridge,
    submitted,
    raf,
    texts: () => calls(ctx, 'fillText'),
    opts: {
      canvas,
      bar,
      input,
      shield,
      bridge,
      requestFrame: (fn) => {
        const id = nextId++;
        queue.set(id, fn);
        return id;
      },
      cancelFrame: (id) => queue.delete(id),
      viewport: () => ({ width, height, dpr }),
    },
  };
}

const calls = (ctx, name) => ctx.calls.filter((c) => c[0] === name);

test('弹幕正文只经 canvas 的 fillText 画出来，自己发的那条描边换成品牌色', async () => {
  const { createOverlay, COLOR_SELF, COLOR_OUTLINE, COLOR_TEXT } = await import(OVERLAY_MODULE);
  const env = fakeCanvasEnv();
  const overlay = createOverlay(env.opts);

  overlay.applyFrame({
    w: 1280,
    h: 720,
    items: [
      { text: '这段真好看', x: 400, y: 120, fontSize: 32, opacity: 0.85, outline: false },
      { text: '同意', x: 900, y: 168, fontSize: 32, opacity: 0.85, outline: true },
    ],
  });
  assert.equal(overlay.paint(1000), true);

  const painted = calls(env.ctx, 'fillText');
  assert.deepEqual(
    painted.map((c) => [c[1], c[2], c[3]]),
    [
      ['这段真好看', 400, 120],
      ['同意', 900, 168],
    ],
    '坐标原样落到 fillText 上'
  );
  assert.equal(painted[0][4], COLOR_TEXT, '正文永远是白的');
  assert.equal(painted[0][6], 0.85, '不透明度设置真的接上了');

  const stroked = calls(env.ctx, 'strokeText');
  assert.equal(stroked[0][4], COLOR_OUTLINE, '别人的弹幕黑描边');
  assert.equal(stroked[1][4], COLOR_SELF, '自己发的那条用品牌色描边');
  assert.ok(stroked[1][5] > stroked[0][5], '自己那条描得更粗');

  // 每一帧都先擦干净，不然上一帧的字会拖成一片
  assert.equal(calls(env.ctx, 'clearRect').length, 1);
  assert.deepEqual(env.ctx.calls.find((c) => c[0] === 'clearRect'), ['clearRect', 0, 0, 1280, 720]);
});

test('画布按 DPR 放大，绘制坐标仍然用 CSS 像素', async () => {
  const { createOverlay } = await import(OVERLAY_MODULE);
  const env = fakeCanvasEnv({ width: 1280, height: 720, dpr: 1.5 });
  const overlay = createOverlay(env.opts);
  overlay.applyFrame({ w: 1280, h: 720, items: [{ text: '喂', x: 10, y: 20, fontSize: 30 }] });
  overlay.paint(1000);

  assert.equal(env.canvas.width, 1920);
  assert.equal(env.canvas.height, 1080);
  assert.deepEqual(env.ctx.calls.find((c) => c[0] === 'setTransform'), ['setTransform', 1.5, 0, 0, 1.5, 0, 0]);
  assert.deepEqual(calls(env.ctx, 'fillText')[0].slice(1, 4), ['喂', 10, 20]);
});

test('主进程给的是别的虚拟画布尺寸时，坐标按比例缩放', async () => {
  const { createOverlay } = await import(OVERLAY_MODULE);
  const env = fakeCanvasEnv({ width: 960, height: 540 });
  const overlay = createOverlay(env.opts);
  // 渲染进程那条 30Hz 帧循环按 1920×1080 的虚拟画布算坐标
  overlay.applyFrame({ w: 1920, h: 1080, items: [{ text: '半个身位', x: 800, y: 200, fontSize: 40 }] });
  overlay.paint(1000);
  assert.deepEqual(calls(env.ctx, 'fillText')[0].slice(1, 4), ['半个身位', 400, 100]);
});

test('限帧：锁屏下 rAF 不限速，这一页自己拦到 60fps', async () => {
  const { createOverlay, shouldPaint, MIN_FRAME_MS } = await import(OVERLAY_MODULE);
  assert.equal(shouldPaint(1000, Number.NaN), true, '第一帧总要画');
  assert.equal(shouldPaint(1000, 1000), false);
  assert.equal(shouldPaint(1016.6, 1000), true, 'rAF 的间隔本来就抖，卡死在 16.667 上会规律漏帧');
  assert.equal(shouldPaint(1005, 1000), false);

  const env = fakeCanvasEnv();
  const overlay = createOverlay(env.opts);
  overlay.applyFrame({ w: 1280, h: 720, items: [{ text: '一直在飞', x: 100, y: 100, fontSize: 30 }] });

  // 一秒里回调 240 次（锁屏下实测就是这种量级），限帧之后只该画 60 来次
  let drawn = 0;
  for (let i = 0; i < 240; i++) if (overlay.paint(2000 + i * (1000 / 240))) drawn += 1;
  assert.ok(drawn >= 58 && drawn <= 62, `限到 60fps，实际画了 ${drawn} 帧`);
  assert.equal(calls(env.ctx, 'fillText').length, drawn, '被限掉的帧一次画笔都没用');
});

test('常驻横幅画在顶部，正文同样只走 fillText', async () => {
  const { createOverlay, COLOR_BANNER_TEXT } = await import(OVERLAY_MODULE);
  const env = fakeCanvasEnv();
  const overlay = createOverlay(env.opts);

  overlay.applyFrame({ banner: '大家在等缓冲' });
  overlay.paint(1000);
  const banner = calls(env.ctx, 'fillText').find((c) => c[1] === '大家在等缓冲');
  assert.ok(banner, '横幅要画出来');
  assert.equal(banner[4], COLOR_BANNER_TEXT);
  assert.equal(banner[2], 640, '居中');
  assert.ok(calls(env.ctx, 'fillRect').length >= 1, '底下垫一块板子，亮画面上也读得清');

  // 空串清掉横幅
  env.ctx.calls.length = 0;
  overlay.applyFrame({ banner: '' });
  overlay.paint(1100);
  assert.equal(calls(env.ctx, 'fillText').length, 0);
});

test('弹幕排布用的是共用的 danmaku.js：给消息也能自己排', async () => {
  const { createOverlay } = await import(OVERLAY_MODULE);
  const env = fakeCanvasEnv();
  const overlay = createOverlay(env.opts);

  overlay.applyFrame({ messages: [{ id: 'a1', text: '自己排', self: false }] });
  overlay.paint(1000);
  const first = calls(env.ctx, 'fillText').find((c) => c[1] === '自己排');
  assert.ok(first, '引擎排出来的第一帧');
  assert.equal(first[2], 1280, '从右边缘进场');

  // 过一会儿要往左走
  overlay.paint(2000);
  const later = calls(env.ctx, 'fillText').filter((c) => c[1] === '自己排').at(-1);
  assert.ok(later[2] < 1280, '弹幕得动起来');

  // 换片 / 切播放器：整场清空
  overlay.applyFrame({ clear: true });
  env.ctx.calls.length = 0;
  overlay.paint(3000);
  assert.equal(calls(env.ctx, 'fillText').length, 0);
});

test('条数、字数、坏值都有上限，坐标坏了不画', async () => {
  const { normalizeItems, MAX_ITEMS, MAX_TEXT } = await import(OVERLAY_MODULE);
  const many = Array.from({ length: MAX_ITEMS + 20 }, (_, i) => ({ text: `第${i}条`, x: i, y: i }));
  assert.equal(normalizeItems(many).length, MAX_ITEMS);
  const long = normalizeItems([{ text: '好'.repeat(MAX_TEXT + 40), x: 0, y: 0 }]);
  assert.equal(Array.from(long[0].text).length, MAX_TEXT);
  assert.deepEqual(normalizeItems([{ text: '   ' }, null, { text: '' }, 'x']), [], '空正文一律丢掉');
  const bad = normalizeItems([{ text: '坏坐标', x: Number.NaN, y: undefined, fontSize: Number.POSITIVE_INFINITY }]);
  assert.deepEqual([bad[0].x, bad[0].y, bad[0].fontSize], [0, 0, 28], '坏值退回默认值，不让 NaN 进画笔');
  assert.deepEqual(normalizeItems(null), []);
});

test('输入条：回车发送、拼音选词时的回车不算、Esc 发空串当取消', async () => {
  const { createOverlay } = await import(OVERLAY_MODULE);
  const env = fakeCanvasEnv();
  const overlay = createOverlay(env.opts);
  assert.equal(env.bridge.onFrame.length, 1, '接线时就订上帧');

  overlay.applyFrame({ chat: { open: true, prompt: '弹幕：', maxLength: 200 } });
  assert.equal(env.bar.classList.list.has('hidden'), false);
  assert.equal(env.input.placeholder, '弹幕：', '提示语由主进程按界面语言传下来');
  assert.equal(env.input.maxLength, 200);
  assert.equal(env.input.focused, true);

  // 拼音选词时的回车不是发送
  env.input.value = '这段';
  env.input.listeners.get('keydown')({ key: 'Enter', isComposing: true, preventDefault() {} });
  assert.deepEqual(env.submitted, []);
  assert.equal(env.bar.classList.list.has('hidden'), false, '输入条还开着');

  env.input.value = '这段真好看';
  env.input.listeners.get('keydown')({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(env.submitted, ['这段真好看']);
  assert.equal(env.bar.classList.list.has('hidden'), true);
  assert.equal(env.input.value, '');
  assert.equal(env.input.focused, false);

  // Esc：发空串，主进程据此把前台还给播放器
  overlay.applyFrame({ chat: { open: true, prompt: '弹幕：' } });
  env.input.value = '算了';
  env.input.listeners.get('keydown')({ key: 'Escape', preventDefault() {} });
  assert.deepEqual(env.submitted, ['这段真好看', '']);
  assert.equal(env.bar.classList.list.has('hidden'), true);

  // 主进程主动关
  overlay.applyFrame({ chat: { open: true } });
  overlay.applyFrame({ chat: { open: false } });
  assert.equal(env.bar.classList.list.has('hidden'), true);
  assert.deepEqual(env.submitted, ['这段真好看', ''], '主进程关的这次不该发东西');
});

test('输入条：失焦当取消 —— 覆盖窗不能一直挡着播放器', async () => {
  const { createOverlay } = await import(OVERLAY_MODULE);
  const env = fakeCanvasEnv();
  const overlay = createOverlay(env.opts);

  overlay.applyFrame({ chat: { open: true, prompt: '弹幕：' } });
  assert.equal(env.shield.classList.list.has('hidden'), false, '输入条开着时挡板要跟着出来');

  // 用户改主意去点别的窗口：输入条失焦。不接这一下的话，输入条留在屏幕上、
  // 覆盖窗还是「可点、可聚焦」的那副样子，播放器的进度条从此点不动
  env.input.value = '打了一半';
  env.input.listeners.get('blur')({});
  assert.deepEqual(env.submitted, [''], '空串是约定的「关掉输入条、什么也不发」');
  assert.equal(env.bar.classList.list.has('hidden'), true);
  assert.equal(env.shield.classList.list.has('hidden'), true);

  // 回车发送的那一路自己会调 input.blur()，不能因此再补发一条「取消」
  env.submitted.length = 0;
  overlay.applyFrame({ chat: { open: true } });
  env.input.value = '这段真好看';
  env.input.listeners.get('keydown')({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(env.submitted, ['这段真好看'], '自己关自己不该再报一次取消');

  // 输入条本来就没开着时的失焦：一句话都不该发
  env.submitted.length = 0;
  env.input.focused = true;
  env.input.listeners.get('blur')({});
  assert.deepEqual(env.submitted, []);
});

test('输入条：点在它以外的地方就关掉，别让用户只能按 Esc', async () => {
  const { createOverlay } = await import(OVERLAY_MODULE);
  const env = fakeCanvasEnv();
  const overlay = createOverlay(env.opts);

  overlay.applyFrame({ chat: { open: true, prompt: '弹幕：' } });
  // 弹输入条时窗口临时摘掉了点击穿透，这一层压着播放器的整个客户区。
  // 用户去点进度条会点在挡板上 —— 那一下必须把输入条关掉，第二下才点得到播放器
  env.shield.listeners.get('mousedown')({ preventDefault() {} });
  assert.deepEqual(env.submitted, ['']);
  assert.equal(env.bar.classList.list.has('hidden'), true);
  assert.equal(env.shield.classList.list.has('hidden'), true);

  // 关掉之后再点，不该重复发
  env.submitted.length = 0;
  env.shield.listeners.get('mousedown')({ preventDefault() {} });
  assert.deepEqual(env.submitted, []);
});

test('整页默认点击穿透，只有输入条那一块能点', () => {
  const css = read('src', 'renderer', 'overlay', 'overlay.css');
  const html = read('src', 'renderer', 'overlay.html');
  // 窗口那一侧弹输入条时会摘掉 setIgnoreMouseEvents(true)，页面这一侧必须把可点区域
  // 收窄到输入条 —— 否则那段时间整张透明画布都在挡着播放器
  const root = css.slice(css.indexOf('html,'), css.indexOf('#overlay-canvas'));
  assert.match(root, /pointer-events:\s*none/);
  assert.match(css.slice(css.indexOf('#overlay-bar {')), /pointer-events:\s*auto/);
  assert.match(html, /id="overlay-shield"/);
});

test('场上空了当场擦干净画布并停表，再来弹幕自己醒', async () => {
  const { createOverlay } = await import(OVERLAY_MODULE);
  const env = fakeCanvasEnv();
  const overlay = createOverlay(env.opts);
  assert.equal(env.raf.pending(), 0, '没东西可画就不开表');

  overlay.applyFrame({ w: 1280, h: 720, items: [{ text: '一直在飞', x: 100, y: 100, fontSize: 30 }] });
  assert.equal(env.raf.pending(), 1, '有东西画就开表');
  env.raf.run(1000);
  assert.equal(env.raf.pending(), 1, '还有东西画，表接着转');

  // 主进程发来空的一帧（最后一条弹幕飞出屏，或者换片了）：
  // 必须当场再画一帧把画布擦干净，不能只是「不再排下一帧」—— 那样最后一屏字会一直留在播放器上
  env.ctx.calls.length = 0;
  overlay.applyFrame({ items: [] });
  assert.equal(calls(env.ctx, 'clearRect').length, 1, '空帧要当场擦干净');
  assert.equal(calls(env.ctx, 'fillText').length, 0);
  assert.equal(env.raf.pending(), 0, '擦完就停表');

  overlay.applyFrame({ messages: [{ id: 'a1', text: '醒一下' }] });
  assert.equal(env.raf.pending(), 1, '再来弹幕表自己醒');
});

test('通道没了也不能把画面搞崩', async () => {
  const { createOverlay } = await import(OVERLAY_MODULE);
  const env = fakeCanvasEnv();
  const overlay = createOverlay({
    ...env.opts,
    bridge: {
      onFrame: env.bridge.onFrame,
      submitChat: () => {
        throw new Error('通道没了');
      },
    },
  });
  overlay.applyFrame({ chat: { open: true, prompt: '弹幕：' } });
  env.input.value = '发不出去';
  assert.doesNotThrow(() => env.input.listeners.get('keydown')({ key: 'Enter', preventDefault() {} }));
  assert.equal(env.bar.classList.list.has('hidden'), true, '输入条照样收掉');
});
