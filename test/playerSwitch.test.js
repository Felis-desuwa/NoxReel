'use strict';

/**
 * P6 接线：可切换播放器。
 *
 * 分三层看：
 *  1. 主进程的 PlayerManager —— 多了 pot/mpc 两个适配器，exe 路径是构造参数、不是启动参数，
 *     窗口与横幅事件只发给主进程自己（覆盖窗），弹幕帧在适配器画不了时落到覆盖窗。
 *  2. 主进程的三条新 IPC（list / select / pickExe）和收尾顺序 —— 用源码断言钉住那几条
 *     一旦松掉就会变成安全问题的约定（白名单、只认登记过的 id、exe 不从渲染进程来）。
 *  3. 渲染进程的选择与即时切换 —— 把 app.js 的顶层函数抠进 vm 沙箱跑真逻辑。
 *
 * 全程不起 Electron、不起播放器、不起桥接程序，一声不出。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const APP = read('src', 'renderer', 'app.js').replace(/\r\n/g, '\n');

const { PlayerManager, ADAPTERS } = require('../src/main/players');

/** vm 沙箱里造的对象来自另一个 realm，原型对不上，deepEqual 会误判：先摊平到本 realm。 */
const plain = (value) => ({ ...value });
const validate = require('../src/main/security');
const settings = require('../src/main/settings');

/* ============================ 一、PlayerManager ============================ */

class FakePlayer extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.kind = 'fake';
    this.caps = { seekPrecision: 4.8, danmaku: 'overlay' };
    this.launched = null;
    this.chatInputs = [];
    this.quits = 0;
    FakePlayer.made.push(this);
  }
  async launch(options) {
    this.launched = options;
    return { bin: this.opts?.exePath || 'fake.exe' };
  }
  deliverChatInput(payload) {
    this.chatInputs.push(payload);
    this.emit('chat-input', { ...payload, kind: this.kind });
  }
  snapshot() {
    return { running: true, position: 12 };
  }
  async quit() {
    this.quits++;
  }
}
FakePlayer.made = [];

/** 自带弹幕层的适配器（mpv 那一路）：帧不该落到覆盖窗。 */
class FakeNative extends FakePlayer {
  constructor(opts) {
    super(opts);
    this.frames = [];
  }
  setDanmakuFrame(frame) {
    this.frames.push(frame);
    return true;
  }
}

function manager({ danmakuSink } = {}) {
  FakePlayer.made.length = 0;
  const sent = [];
  const events = [];
  const mgr = new PlayerManager({
    send: (channel, payload) => sent.push([channel, payload]),
    adapters: { fake: FakePlayer, native: FakeNative },
    danmakuSink,
  });
  for (const name of ['window', 'banner', 'gone']) mgr.on(name, (payload) => events.push([name, payload]));
  return { mgr, sent, events };
}

test('三个播放器都登记在册，渲染进程能报的 id 只有这几个', () => {
  assert.deepEqual(Object.keys(ADAPTERS).sort(), ['mpc', 'mpv', 'pot']);
  const mgr = new PlayerManager({ send: () => {} });
  assert.deepEqual(mgr.kinds.sort(), ['mpc', 'mpv', 'pot']);
  assert.equal(mgr.kind, null, '没开播放器时没有 kind');
});

test('exe 路径是构造参数，不混进启动参数', async () => {
  const { mgr } = manager();
  const info = await mgr.launch('fake', { source: 'C:/a.mkv', startPaused: true, exePath: 'C:/Pot/PotPlayerMini64.exe' });
  const adapter = FakePlayer.made[0];
  assert.equal(adapter.opts.exePath, 'C:/Pot/PotPlayerMini64.exe');
  assert.equal(adapter.launched.exePath, undefined, 'exePath 不该再出现在 launch 的参数里');
  assert.equal(adapter.launched.source, 'C:/a.mkv');
  assert.equal(info.kind, 'fake');
  assert.deepEqual(info.caps, adapter.caps, 'caps 要带回渲染进程：跳转容差按它算');
});

test('窗口与横幅事件只发给主进程自己，不经渲染进程', async () => {
  const { mgr, sent, events } = manager();
  await mgr.launch('fake', {});
  const adapter = FakePlayer.made[0];
  adapter.emit('window', { hwnd: 66, alive: true, foreground: true });
  adapter.emit('banner', { text: '全员暂停中' });
  assert.deepEqual(
    events.map(([name]) => name),
    ['window', 'banner']
  );
  assert.equal(events[0][1].hwnd, 66);
  assert.equal(events[0][1].gen, 1, '带上代号，换播放器之后迟到的那条认得出来');
  assert.equal(events[1][1].text, '全员暂停中');
  assert.ok(
    !sent.some(([channel]) => channel.includes('window') || channel.includes('banner')),
    '这两条不该往渲染进程发：每次挪动窗口多跑两趟 IPC，而渲染进程拿到 hwnd 也无事可做'
  );
});

test('上一代播放器迟到的窗口事件不会拿去贴新播放器', async () => {
  const { mgr, events } = manager();
  await mgr.launch('fake', {});
  const old = FakePlayer.made[0];
  await mgr.launch('fake', {});
  events.length = 0;
  old.emit('window', { hwnd: 1, alive: true });
  old.emit('banner', { text: '旧的' });
  assert.deepEqual(events, [], '旧一代的几何和横幅都不算数');
  // 上面拦住它的是「换代时摘监听器」。代际过滤是第二道，摘漏了也不至于把 bug 放回来 ——
  // 这两道谁都可能在将来被人顺手删掉，所以两道都得钉住。
  const index = read('src', 'main', 'players', 'index.js');
  assert.match(index, /adapter\.on\('window', fromCurrent\(/);
  assert.match(index, /adapter\.on\('banner', fromCurrent\(/);
});

test('播放器没了要告诉覆盖窗：自己退的、被换掉的都算', async () => {
  const { mgr, events } = manager();
  await mgr.launch('fake', {});
  FakePlayer.made[0].emit('exit', { code: 0 });
  assert.deepEqual(events.filter(([name]) => name === 'gone').map(([, p]) => p.gen), [1]);

  await mgr.launch('fake', {});
  events.length = 0;
  await mgr.quit();
  assert.deepEqual(
    events.filter(([name]) => name === 'gone').map(([, p]) => p.gen),
    [2],
    '被换掉的那一代也要松开覆盖窗，否则它会贴在一个已经没了的窗口上'
  );
});

test('用户自己关掉播放器：适配器也要收干净，不能只把 current 置空', async () => {
  const { mgr, sent } = manager();
  await mgr.launch('fake', {});
  const adapter = FakePlayer.made[0];
  adapter.emit('exit', { code: 0 });
  await mgr.quit(); // quit() 会等 stopping 里那条收尾落地

  // 适配器挂在**共用**的桥上（copydata / win / restart 三条监听），而摘监听、untrack、
  // forget 只写在 quit() 里。不走这一遭的话，开一次外部播放器就多三个监听器，
  // 桥里那个 pid 的 allow 和 hwnd 的 WinEventHook 也永远撤不掉。
  assert.equal(adapter.quits, 1, '用户自己关掉的那一个从来没被 quit() 收过尾');
  assert.equal(
    adapter.listenerCount('exit') + adapter.listenerCount('tick') + adapter.listenerCount('error'),
    0,
    '监听器还挂在退出的适配器上'
  );
  assert.equal(mgr.running, false);
  assert.equal(sent.filter(([channel]) => channel === 'player:exit').length, 1, '渲染进程仍然只收到一条 exit');
});

test('连开三次又被用户关掉三次：监听器不许越积越多', async () => {
  const { mgr } = manager();
  for (let round = 0; round < 3; round++) {
    await mgr.launch('fake', {});
    FakePlayer.made.at(-1).emit('exit', { code: 0 });
  }
  await mgr.quit();
  const leaked = FakePlayer.made.filter((a) => a.listenerCount('exit') > 0);
  assert.deepEqual(leaked, [], '每一代都该在退出时被摘干净');
  assert.deepEqual(FakePlayer.made.map((a) => a.quits), [1, 1, 1]);
});

test('运行期的错误带着代号走 —— 渲染进程靠它决定要不要退回 mpv', async () => {
  const { mgr, sent } = manager();
  await mgr.launch('fake', {});
  const adapter = FakePlayer.made[0];
  const detached = new Error('MPC-BE 不再响应遥控');
  detached.code = 'PLAYER_DETACHED';
  adapter.emit('error', detached);
  const [channel, payload] = sent.at(-1);
  assert.equal(channel, 'player:error');
  // Electron 的 IPC 只把 message 带过去，自定义属性到不了对面：代号必须写成字段
  assert.deepEqual(plain(payload), { message: 'MPC-BE 不再响应遥控', code: 'PLAYER_DETACHED', gen: 1, kind: 'fake' });

  // 没有 code 的错误照样发得出去，只是渲染进程只能当一行日志
  adapter.emit('error', new Error('说不清'));
  assert.equal(sent.at(-1)[1].code, '');
  await mgr.quit();
});

test('画不了弹幕的播放器，这一帧落到覆盖窗；自带弹幕层的不落', async () => {
  const overlayFrames = [];
  const { mgr } = manager({ danmakuSink: (frame) => (overlayFrames.push(frame), true) });
  await mgr.launch('fake', {});
  assert.equal(mgr.setDanmakuFrame({ w: 1920, h: 1080, items: [{ text: '哈', x: 1, y: 2 }] }), true);
  assert.equal(overlayFrames.length, 1);
  assert.equal(overlayFrames[0].items[0].text, '哈');

  await mgr.launch('native', {});
  overlayFrames.length = 0;
  assert.equal(mgr.setDanmakuFrame({ w: 1920, h: 1080, items: [] }), true);
  assert.deepEqual(overlayFrames, [], 'mpv 自己画在 osd-overlay 上，不该再画一遍到覆盖窗');
  assert.equal(FakePlayer.made[1].frames.length, 1);
});

test('没有覆盖窗时丢掉这一帧，不报错 —— 渲染进程每秒发 30 次', async () => {
  const { mgr } = manager();
  await mgr.launch('fake', {});
  assert.equal(mgr.setDanmakuFrame({ w: 1920, h: 1080, items: [] }), false);
});

test('代号不对的弹幕帧不画：那是上一部片的一屏字', async () => {
  const overlayFrames = [];
  const { mgr } = manager({ danmakuSink: (frame) => (overlayFrames.push(frame), true) });
  await mgr.launch('fake', {});
  await mgr.launch('fake', {});
  assert.equal(mgr.setDanmakuFrame({ gen: 1, w: 1920, h: 1080, items: [] }), false);
  assert.deepEqual(overlayFrames, []);
});

test('覆盖窗输入条发的弹幕交回适配器转出，和 mpv 共用代际过滤', async () => {
  const { mgr, sent } = manager();
  await mgr.launch('fake', {});
  assert.equal(mgr.deliverChatInput({ text: '在播放器里发的' }), true);
  const chat = sent.filter(([channel]) => channel === 'player:chat-input');
  assert.equal(chat.length, 1);
  assert.deepEqual(
    { text: chat[0][1].text, gen: chat[0][1].gen, kind: chat[0][1].kind },
    { text: '在播放器里发的', gen: 1, kind: 'fake' }
  );
  await mgr.quit();
  assert.equal(mgr.deliverChatInput({ text: '播放器已经没了' }), false);
});

/* ============================ 二、主进程的接线 ============================ */

test('播放器 id 只认登记过的那几个 —— 它会变成 new ADAPTERS[id]()', () => {
  assert.equal(validate.playerId('pot', ['mpv', 'pot', 'mpc']), 'pot');
  for (const bad of ['constructor', '__proto__', 'POT', '', 'node', 'toString']) {
    assert.throws(() => validate.playerId(bad, ['mpv', 'pot', 'mpc']), /播放器/, `${bad} 不该被放行`);
  }
  assert.throws(() => validate.playerId('pot', undefined), /播放器/, '没给登记表就一律拒绝');
});

test('播放器选择存在主进程侧，配置坏了退回 mpv', () => {
  assert.equal(settings.resolvePlayer({ player: 'pot' }), 'pot');
  assert.equal(settings.resolvePlayer({ player: 'vlc' }), 'mpv', '认不出来的一律退回内置的');
  assert.equal(settings.resolvePlayer({}), 'mpv');
  assert.equal(settings.resolvePlayer({ player: '__proto__' }), 'mpv');
});

test('配置里的播放器路径只做形状规整，白名单在真正启动的那一侧把关', () => {
  const got = settings.playerPaths({
    playerPaths: { pot: 'C:\\Pot\\PotPlayerMini64.exe', mpc: 'mpc-be64.exe', vlc: 'C:\\vlc.exe' },
  });
  assert.equal(got.pot, path.resolve('C:\\Pot\\PotPlayerMini64.exe'));
  assert.equal(got.mpc, undefined, '相对路径不收');
  assert.equal(got.vlc, undefined, '不在登记表里的 id 不收');
  assert.deepEqual(settings.playerPaths({}), {});
  assert.deepEqual(settings.playerPaths({ playerPaths: 'x' }), {});
});

test('三条新 IPC 齐了，exe 路径不从渲染进程来', () => {
  const main = read('src', 'main', 'main.js');
  const preload = read('src', 'main', 'preload.js');
  for (const channel of ['player:list', 'player:select', 'player:pickExe']) {
    assert.match(main, new RegExp(`secureHandle\\('${channel}'`), `主进程缺 ${channel}`);
    assert.match(preload, new RegExp(`'${channel}'`), `preload 缺 ${channel}`);
  }
  // 选择和启动都只认登记表
  assert.match(main, /validate\.playerId\(id, players\.kinds\)/);
  assert.match(main, /validate\.playerId\(kind, players\.kinds\)/);
  // 对话框由主进程弹，挑回来的路径还要过白名单并对得上是哪个播放器
  assert.match(main, /dialog\.showOpenDialog\(win, \{\s*\n\s*title: `选择/);
  assert.match(main, /if \(!isAllowedExe\(target\) \|\| kindOfExe\(target\) !== want\)/);
  // 渲染进程递不进来 exe 路径：preload 的 launch 参数里没有这一项
  const launch = preload.slice(preload.indexOf('launch: ('), preload.indexOf('list: ('));
  assert.doesNotMatch(launch, /exePath|filePathExe|exe/i, 'preload 的 launch 不许带 exe 路径');
});

test('外部播放器不传音量和静音 —— 那两样会写进注册表', () => {
  const main = read('src', 'main', 'main.js');
  const start = main.indexOf("secureHandle('player:launch'");
  const body = main.slice(start, main.indexOf('\n});', start));
  // 注释里说的就是「不传 muted」，先把整行注释去掉，免得它自己把断言顶掉
  const external = body
    .slice(body.indexOf("if (want !== 'mpv')"), body.indexOf('// PlayerManager'))
    .replace(/^[ \t]*\/\/.*$/gm, '');
  assert.ok(external.length > 100, '找不到外部播放器那一支');
  assert.doesNotMatch(external, /muted/, '外部播放器那一支不许出现 muted');
  assert.match(body, /muted: TEST_MUTE/, 'mpv 那一支照旧支持测试静音');
});

test('收尾顺序：播放器 → 桥接程序 → 覆盖窗 → 会话', () => {
  const main = read('src', 'main', 'main.js');
  const start = main.indexOf('async function cleanup()');
  assert.ok(start > 0);
  const body = main.slice(start, main.indexOf('\napp.on(', start));
  const order = ['players.quit()', 'closeSharedBridge()', 'overlay.destroy()', 'store.closeAll()'];
  let at = -1;
  for (const step of order) {
    const next = body.indexOf(step, at + 1);
    assert.ok(next > at, `收尾顺序不对：${step} 没有排在前一步之后`);
    at = next;
  }
  // 渲染进程没了那一路同样要把桥和覆盖窗收掉，否则页面一刷新就剩个透明窗口挂在屏幕上
  const reclaim = main.slice(main.indexOf('function reclaimAfterRendererGone()'), start);
  assert.match(reclaim, /closeSharedBridge\(\)/);
  assert.match(reclaim, /overlay\.destroy\(\)/);
});

test('覆盖窗接线：输入条走适配器、提示有代号、播放器没了就松开', () => {
  const main = read('src', 'main', 'main.js');
  assert.match(main, /overlay\.attachIpc\(ipcMain\)/, 'overlay:submit 没挂上，覆盖窗发不出弹幕');
  assert.match(main, /overlay\.on\('chat', \(\{ text \}\) => players\.deliverChatInput\(\{ text \}\)\)/);
  assert.match(main, /overlay\.on\('notice', \(\{ code \}\) => send\('player:notice', \{ code \}\)\)/);
  assert.match(main, /players\.on\('window', \(state\) => \{/);
  assert.match(main, /players\.on\('banner', \(\{ text \}\) => overlay\.frame\(\{ banner: text \}\)\)/);
  assert.match(main, /players\.on\('gone', \(\) => \{/);
  // 快捷键只在播放器位于前台时占着
  assert.match(main, /const CHAT_HOTKEY = 'Control\+Shift\+D'/);
  assert.match(main, /setChatHotkey\(Boolean\(state && state\.alive && state\.foreground\)\)/);
});

/* ============================ 三、渲染进程的切换 ============================ */

/** app.js 顶层函数的源码：从声明行到下一个顶格的 `}`。 */
function fnSource(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层函数 ${name}`);
  const end = APP.indexOf('\n}\n', m.index);
  assert.ok(end > m.index, `${name} 的结尾没找到`);
  return APP.slice(m.index, end + 2);
}

/** 顶层的常量块（箭头函数和表不是 function 声明，抠不出来，只能按锚点切）。 */
function chunk(anchor, close) {
  const i = APP.indexOf(anchor);
  assert.ok(i !== -1, `app.js 里没找到「${anchor}」`);
  const end = APP.indexOf(close, i);
  assert.ok(end > i, `「${anchor}」的结尾没找到`);
  return APP.slice(i, end + close.length);
}

function el() {
  const e = { className: '', textContent: '', value: '', hidden: false, disabled: false, children: [] };
  e.classList = {
    toggle: (c, on) => {
      if (c === 'hidden') e.hidden = on === undefined ? !e.hidden : !!on;
    },
    add: (c) => {
      if (c === 'hidden') e.hidden = true;
    },
    remove: (c) => {
      if (c === 'hidden') e.hidden = false;
    },
  };
  return e;
}

const PLAYER_FNS = [
  'playbackAllowed',
  'launchPlayer',
  'desiredPlayerKind',
  'externalPlaybackReady',
  'linkNeedsHeaders',
  'errCode',
  'errText',
  'reportLaunchFailure',
  'playerErrorText',
  'handlePlayerError',
  'detachFromPlayer',
  'fallbackToMpv',
  'applyPlayerList',
  'switchPlayer',
  'relaunchWithPlayer',
  'updatePlayerSwitchHint',
  'playerActualText',
  'retirePlayer',
  'pickPlayerExe',
];

/**
 * 沙箱里的「正在放映的房间」。播放器接口全是假的，记下每一次调用。
 * mpv、PotPlayer 都不会被真的拉起来。
 */
function playerBox({ choice = 'mpv', list = null, complete = true, sourceType = 'file', launchFails = null } = {}) {
  const calls = [];
  const logs = [];
  const dom = new Map();
  const $ = (id) => {
    if (!dom.has(id)) dom.set(id, el());
    return dom.get(id);
  };
  const S = {
    leaving: false,
    mpvRunning: false,
    switchingMedia: false,
    switchingPlayer: false,
    isSeeder: false,
    filePath: sourceType === 'link' ? 'https://cdn.example/x.mp4' : 'C:/cache/x.mkv',
    sourceType,
    linkInfo: sourceType === 'link' ? { playback: { url: 'https://cdn.example/x.mp4', headers: {} } } : null,
    roomSecurityMode: 'trusted',
    mediaSafety: { status: 'clean' },
    currentSeq: 3,
    playerChoice: choice,
    playerList: list || [
      { id: 'mpv', name: 'mpv', available: true, reason: '' },
      { id: 'pot', name: 'PotPlayer', available: true, reason: '' },
      { id: 'mpc', name: 'MPC-BE', available: true, reason: '' },
    ],
    playerKind: 'mpv',
    playerFallback: '',
    danmaku: { setActive: () => calls.push('danmaku.setActive'), clear: () => calls.push('danmaku.clear') },
    sync: {
      sharedPositionNow: () => 600,
      setPlayerCaps: () => {},
      resyncToShared: () => calls.push('resyncToShared'),
      forgetPlayerState: () => calls.push('forgetPlayerState'),
    },
    playerQuit: Promise.resolve(),
  };
  const player = {
    launch: async (opts) => {
      calls.push(['launch', opts.kind, Math.round(opts.startAt)]);
      if (launchFails && launchFails(opts)) {
        const error = new Error(`Error invoking remote method 'player:launch': Error: [PLAYER_NOT_FOUND] 没找到 PotPlayer`);
        throw error;
      }
      return { gen: calls.length, caps: {} };
    },
    quit: async () => calls.push('quit'),
    snapshot: async () => ({ running: true, paused: false, position: 601.2 }),
    osd: async (text) => calls.push(['osd', text]),
    select: async (id) => {
      calls.push(['select', id]);
      return { players: S.playerList, selected: id };
    },
    pickExe: async (id) => {
      calls.push(['pickExe', id]);
      return { players: S.playerList, selected: S.playerChoice };
    },
  };
  const noop = () => {};
  const ctx = {
    S,
    $,
    console,
    Promise,
    Math,
    Object,
    Boolean,
    String,
    Number,
    setTimeout,
    performance: { now: () => 0 },
    roomEntered: true,
    switchHintSeq: -1,
    lastMpvBanner: '',
    t: (s) => s,
    log: (text, kind) => logs.push([text, kind]),
    replace: (node, text) => {
      node.textContent = String(text ?? '');
      return node;
    },
    currentFileCtx: () => ({ complete }),
    playerGate: {
      epoch: 1,
      gen: null, // 已确认的这一代。运行期错误按它过滤迟到的那一条
      begin() {
        return this.epoch;
      },
      confirm: () => ({}),
      acceptExit: () => false,
      retire: () => calls.push('gate.retire'),
    },
    handlePlayerTick: noop,
    handlePlayerExit: noop,
    showDepsHelp: () => calls.push('showDepsHelp'),
    renderPlayerControls: () => calls.push('renderPlayerControls'),
    refreshMediaUi: () => calls.push('refreshMediaUi'),
    window: { sw: { player } },
  };
  vm.createContext(ctx);
  vm.runInContext(
    [
      chunk('const PLAYER_NAMES = {', "const playerReasonText = (code) => PLAYER_REASONS[code] || '不可用';"),
      chunk('const PLAYER_FATAL_CODES = new Set(', ']);'),
    ]
      .concat(PLAYER_FNS.map(fnSource))
      .join('\n\n'),
    ctx,
    { filename: 'app.js（节选）' }
  );
  return { ctx, S, calls, logs, $ };
}

test('选了 mpv 就用 mpv，选了外部播放器且这一部已收完就用它', async () => {
  const mpv = playerBox({ choice: 'mpv' });
  assert.deepEqual(plain(mpv.ctx.desiredPlayerKind()), { kind: 'mpv', reason: '' });

  const pot = playerBox({ choice: 'pot' });
  assert.deepEqual(plain(pot.ctx.desiredPlayerKind()), { kind: 'pot', reason: '' });
  await pot.ctx.launchPlayer();
  assert.deepEqual(pot.calls[0], ['launch', 'pot', 600]);
  assert.equal(pot.S.playerKind, 'pot');
  assert.deepEqual(pot.logs[0], ['PotPlayer 已启动（先暂停着，等所有人就绪）', 'good']);
});

test('这一部还没收完时照旧交给 mpv，原因说得出来', async () => {
  const box = playerBox({ choice: 'pot', complete: false });
  assert.deepEqual(plain(box.ctx.desiredPlayerKind()), { kind: 'mpv', reason: 'streaming' });
  await box.ctx.launchPlayer();
  assert.deepEqual(box.calls[0], ['launch', 'mpv', 600]);
  assert.equal(box.S.playerFallback, 'streaming');
  assert.equal(box.ctx.playerActualText(), '当前实际使用：mpv（原因：这一部还没收完）');

  // 收完了但还没切：窗口里跑的仍然是 mpv，这一行说的必须是实情而不是「现在起播会用哪个」
  box.ctx.currentFileCtx = () => ({ complete: true });
  assert.deepEqual(plain(box.ctx.desiredPlayerKind()), { kind: 'pot', reason: '' });
  assert.equal(box.ctx.playerActualText(), '当前实际使用：mpv（原因：这一部还没收完）');
});

test('片源和链接不受「还没收完」限制 —— 它们手上就是完整的一路', () => {
  const seeder = playerBox({ choice: 'pot', complete: false });
  seeder.S.isSeeder = true;
  assert.deepEqual(plain(seeder.ctx.desiredPlayerKind()), { kind: 'pot', reason: '' });

  const link = playerBox({ choice: 'pot', complete: false, sourceType: 'link' });
  assert.deepEqual(plain(link.ctx.desiredPlayerKind()), { kind: 'pot', reason: '' });
});

test('MPC-BE 传不了请求头：这种链接退回 mpv，PotPlayer 不受影响', () => {
  const mpc = playerBox({ choice: 'mpc', sourceType: 'link' });
  mpc.S.linkInfo.playback.headers = { referer: 'https://site.example/' };
  assert.deepEqual(plain(mpc.ctx.desiredPlayerKind()), { kind: 'mpv', reason: 'no-headers' });

  const pot = playerBox({ choice: 'pot', sourceType: 'link' });
  pot.S.linkInfo.playback.headers = { referer: 'https://site.example/' };
  assert.deepEqual(plain(pot.ctx.desiredPlayerKind()), { kind: 'pot', reason: '' }, 'PotPlayer 有 /referer=');
});

test('选中的播放器本机没有时退回 mpv，原因用主进程给的代号', () => {
  const box = playerBox({
    choice: 'pot',
    list: [
      { id: 'mpv', name: 'mpv', available: true, reason: '' },
      { id: 'pot', name: 'PotPlayer', available: false, reason: 'bridge-missing' },
    ],
  });
  assert.deepEqual(plain(box.ctx.desiredPlayerKind()), { kind: 'mpv', reason: 'bridge-missing' });
  assert.equal(box.ctx.playerActualText(), '当前实际使用：mpv（原因：桥接程序未构建）');
  // 选中的就是在跑的那个时，这一行不出现
  const same = playerBox({ choice: 'pot' });
  assert.equal(same.ctx.playerActualText(), '');
});

test('即时切换：取快照外推 → 退旧的等它真退 → 以该位置起播 → 重放房间共识', async () => {
  const box = playerBox({ choice: 'mpv' });
  await box.ctx.launchPlayer();
  box.calls.length = 0;
  box.logs.length = 0;

  await box.ctx.switchPlayer('pot');
  // 只看有实质动作的那几步（重画控制条、弹幕启停穿插在中间，顺序上不说明问题）
  const steps = box.calls
    .map((c) => (Array.isArray(c) ? c[0] : c))
    .filter((name) => ['select', 'gate.retire', 'quit', 'forgetPlayerState', 'danmaku.clear', 'launch', 'resyncToShared'].includes(name));
  assert.deepEqual(steps, [
    'select',
    'gate.retire',
    'quit',
    'forgetPlayerState',
    'danmaku.clear',
    'launch',
    'resyncToShared',
  ]);
  // 本机位置（601.2）和房间共识（600）差不到 2 秒：用本机的，房间不该被拽回去
  assert.deepEqual(box.calls.find((c) => c[0] === 'launch'), ['launch', 'pot', 601]);
  assert.equal(box.S.playerKind, 'pot');
});

test('本机位置和房间差得多时以房间为准 —— 那多半是本机掉队了', async () => {
  const box = playerBox({ choice: 'mpv' });
  await box.ctx.launchPlayer();
  box.S.sync.sharedPositionNow = () => 1200;
  box.calls.length = 0;
  await box.ctx.switchPlayer('pot');
  assert.deepEqual(box.calls.find((c) => c[0] === 'launch'), ['launch', 'pot', 1200]);
});

test('新播放器起不来就退回 mpv，并且真的把画面重新放出来', async () => {
  const box = playerBox({ choice: 'mpv', launchFails: (opts) => opts.kind === 'pot' });
  await box.ctx.launchPlayer();
  box.calls.length = 0;
  box.logs.length = 0;

  await box.ctx.switchPlayer('pot');
  const launches = box.calls.filter((c) => c[0] === 'launch');
  assert.deepEqual(launches[0], ['launch', 'pot', 601]);
  assert.deepEqual(launches[1], ['launch', 'mpv', 601], '退回 mpv 之后要接着放，不能把人晾在没画面的房间里');
  assert.equal(box.S.playerChoice, 'mpv');
  assert.ok(
    box.logs.some(([text]) => text === '切换失败，已回到 mpv'),
    '退回 mpv 这件事必须说出来'
  );
  assert.ok(box.logs.some(([text]) => text === '没找到 PotPlayer，可以在控制条里指定它的路径'));
});

test('遥控断了：当场退回 mpv，而不是只在日志里留一行', async () => {
  const box = playerBox({ choice: 'pot' });
  await box.ctx.launchPlayer();
  assert.equal(box.S.playerKind, 'pot');
  box.calls.length = 0;
  box.logs.length = 0;

  // 主进程转来的运行期错误。带着 code —— 渲染进程靠它认出「这一路再也控不回来了」
  await box.ctx.handlePlayerError({ message: 'MPC-BE 不再响应遥控', code: 'PLAYER_DETACHED', kind: 'pot' });

  const steps = box.calls
    .map((c) => (Array.isArray(c) ? c[0] : c))
    .filter((name) => ['select', 'gate.retire', 'quit', 'danmaku.clear', 'launch', 'resyncToShared'].includes(name));
  assert.deepEqual(steps, ['select', 'gate.retire', 'quit', 'danmaku.clear', 'launch', 'resyncToShared']);
  assert.deepEqual(box.calls.find((c) => c[0] === 'launch'), ['launch', 'mpv', 601], '退回 mpv 之后要真的把画面放出来');
  assert.equal(box.S.playerChoice, 'mpv', '选择不改的话，下一次还会去拉那个遥控不了的播放器');
  assert.equal(box.S.playerKind, 'mpv');
  assert.deepEqual(box.logs[0], ['PotPlayer 脱离了遥控，正在退回 mpv', 'bad']);
});

test('另外两种「遥控失效」同样退回 mpv；说不上话的错误只记一行', async () => {
  for (const code of ['PLAYER_ELEVATED', 'PLAYER_UNREACHABLE']) {
    const box = playerBox({ choice: 'pot' });
    await box.ctx.launchPlayer();
    box.calls.length = 0;
    await box.ctx.handlePlayerError({ message: '原始正文', code, kind: 'pot' });
    assert.deepEqual(box.calls.find((c) => c[0] === 'launch'), ['launch', 'mpv', 601], `${code} 没退回 mpv`);
  }

  // 认不出来的代号：正文照样要说出来，但不能凭它把播放器换掉
  const other = playerBox({ choice: 'pot' });
  await other.ctx.launchPlayer();
  other.calls.length = 0;
  other.logs.length = 0;
  await other.ctx.handlePlayerError({ message: '一句没见过的话', code: 'PLAYER_WEIRD', kind: 'pot' });
  assert.deepEqual(other.calls.filter((c) => c[0] === 'launch'), []);
  assert.deepEqual(other.logs, [['播放器 PotPlayer 报错：一句没见过的话', 'bad']]);

  // mpv 自己报的同名错误不该触发「退回 mpv」——那会变成无限重开
  const mpv = playerBox({ choice: 'mpv' });
  await mpv.ctx.launchPlayer();
  mpv.calls.length = 0;
  await mpv.ctx.handlePlayerError({ message: 'x', code: 'PLAYER_UNREACHABLE', kind: 'mpv' });
  assert.deepEqual(mpv.calls.filter((c) => c[0] === 'launch'), []);
});

test('上一代播放器迟到的错误不算数，不会把刚起来的这一代换掉', async () => {
  const box = playerBox({ choice: 'pot' });
  await box.ctx.launchPlayer();
  box.ctx.playerGate.gen = 9; // 现在跑的是第 9 代
  box.calls.length = 0;
  box.logs.length = 0;
  await box.ctx.handlePlayerError({ message: 'x', code: 'PLAYER_DETACHED', kind: 'pot', gen: 8 });
  assert.deepEqual(box.calls, []);
  assert.deepEqual(box.logs, [], '迟到的那条连日志都不该记：它说的是已经没了的那个播放器');
});

test('启动被作废不等于启动失败：换片撞上换播放器时，选择不许被改写', async () => {
  const box = playerBox({ choice: 'mpv' });
  await box.ctx.launchPlayer();
  box.calls.length = 0;
  box.logs.length = 0;
  // 票据作废：换片、拦下威胁、列表推进都会让 launchPlayer 走这条静默的路
  box.ctx.playerGate.confirm = () => null;

  await box.ctx.switchPlayer('pot');

  assert.equal(box.S.playerChoice, 'pot', '被作废的一次启动被当成了「切换失败」');
  assert.deepEqual(
    box.calls.filter((c) => c[0] === 'select'),
    [['select', 'pot']],
    '不该再写一次 select(mpv)：那会把主进程 config.json 里的选择也改掉'
  );
  assert.equal(box.calls.filter((c) => c[0] === 'launch').length, 1, '作废之后不该拿上一部的位置再拉一次 mpv');
  assert.ok(!box.logs.some(([text]) => text === '切换失败，已回到 mpv'), '什么都没失败，不该报失败');
});

test('启动失败按代号分支，不去嗅 message 里有没有「mpv」', () => {
  const box = playerBox();
  const tagged = (code, kind = 'pot') => {
    box.logs.length = 0;
    box.ctx.reportLaunchFailure(
      new Error(`Error invoking remote method 'player:launch': Error: [${code}] 原始报错`),
      kind,
      kind === 'mpv' ? 'mpv' : 'PotPlayer'
    );
    return box.logs.map(([text]) => text);
  };
  // Electron 的前缀里本来就带着通道名，按文字判断的写法在这里必然出错
  assert.equal(box.ctx.errCode(new Error("remote method 'player:launch': Error: [PLAYER_ELEVATED] x")), 'PLAYER_ELEVATED');
  assert.equal(box.ctx.errText(new Error('Error: [PLAYER_GONE] 播放器已退出')), '播放器已退出');
  assert.deepEqual(tagged('PLAYER_NOT_FOUND'), ['没找到 PotPlayer，可以在控制条里指定它的路径']);
  assert.deepEqual(tagged('BRIDGE_MISSING'), ['桥接程序未构建（npm run build:bridge）']);
  assert.deepEqual(tagged('PLAYER_ELEVATED'), ['PotPlayer 以管理员身份运行，NoxReel 遥控不了它']);
  assert.deepEqual(tagged('PLAYER_NO_HEADERS'), ['PotPlayer 打不开需要请求头的链接']);
  assert.deepEqual(tagged('PLAYER_TIMEOUT'), ['启动 PotPlayer 失败：原始报错']);
  // mpv 找不到是另一回事：那是缺件，要把安装指引推出来
  assert.deepEqual(tagged('MPV_NOT_FOUND', 'mpv'), ['没找到 mpv，无法播放。装好 mpv 后点右上角「重新检测」。']);
  assert.ok(box.calls.includes('showDepsHelp'));
});

test('边下边播时收完了，控制条给一键切换，OSD 上每一部只提一次', async () => {
  const box = playerBox({ choice: 'pot', complete: false });
  await box.ctx.launchPlayer();
  box.ctx.updatePlayerSwitchHint();
  assert.equal(box.$('btn-switch-player').hidden, true, '还没收完时不该出现');

  box.ctx.currentFileCtx = () => ({ complete: true });
  box.ctx.updatePlayerSwitchHint();
  const btn = box.$('btn-switch-player');
  assert.equal(btn.hidden, false);
  assert.equal(btn.textContent, '已收完 · 切换到 PotPlayer');
  assert.deepEqual(box.calls.filter((c) => c[0] === 'osd'), [['osd', '已收完 · 切换到 PotPlayer']]);

  // 同一部片再刷新几次，不再重复弹 OSD
  box.ctx.updatePlayerSwitchHint();
  box.ctx.updatePlayerSwitchHint();
  assert.equal(box.calls.filter((c) => c[0] === 'osd').length, 1);

  // 换了一部：重新提一次
  box.S.currentSeq = 4;
  box.ctx.updatePlayerSwitchHint();
  assert.equal(box.calls.filter((c) => c[0] === 'osd').length, 2);
});

test('已经在用外部播放器时不再劝人切换', async () => {
  const box = playerBox({ choice: 'pot' });
  await box.ctx.launchPlayer();
  box.ctx.updatePlayerSwitchHint();
  assert.equal(box.$('btn-switch-player').hidden, true);
});

test('没在放的时候换播放器只记下选择，不去拉播放器', async () => {
  const box = playerBox({ choice: 'mpv' });
  await box.ctx.switchPlayer('pot');
  assert.equal(box.S.playerChoice, 'pot');
  assert.deepEqual(box.calls.filter((c) => c[0] === 'launch'), [], '没在放就不该凭空开一个窗口');
});

test('切换失败时把选择退回去，日志说清楚', async () => {
  // 一、主进程直接拒了这个 id：选择根本没换过去
  const rejected = playerBox({ choice: 'mpv' });
  rejected.ctx.window.sw.player.select = async () => {
    throw new Error("Error invoking remote method 'player:select': Error: 无效的播放器");
  };
  await rejected.ctx.switchPlayer('pot');
  assert.equal(rejected.S.playerChoice, 'mpv');
  assert.ok(rejected.logs.some(([text]) => text.startsWith('切换播放器失败：')));

  // 二、选择已经换过去了，换的途中才出事：必须退回原来那个 ——
  // 否则下拉框上写着 PotPlayer、实际在放的是 mpv，而且下一部还会照着这个错的来
  const midway = playerBox({ choice: 'mpv' });
  await midway.ctx.launchPlayer();
  midway.S.danmaku.clear = () => {
    throw new Error('换播放器途中出事了');
  };
  await midway.ctx.switchPlayer('pot');
  assert.equal(midway.S.playerChoice, 'mpv', '选择停在了一个没生效的播放器上');
  assert.ok(midway.logs.some(([text]) => text.startsWith('切换播放器失败：')));
});

test('指定路径：取消对话框不会被夸奖一句「已指定」', async () => {
  const box = playerBox({
    choice: 'pot',
    list: [
      { id: 'mpv', name: 'mpv', available: true, reason: '' },
      { id: 'pot', name: 'PotPlayer', available: true, reason: '', path: 'C:/Pot/PotPlayerMini64.exe' },
    ],
  });
  // 取消：主进程原样把清单还回来，路径没变
  await box.ctx.pickPlayerExe('pot');
  assert.deepEqual(box.logs, [], '取消了却说成改好了，用户会以为自己换成了别的程序');

  // 真的挑了一个：路径变了才报
  box.ctx.window.sw.player.pickExe = async () => ({
    players: [
      { id: 'mpv', name: 'mpv', available: true, reason: '' },
      { id: 'pot', name: 'PotPlayer', available: true, reason: '', path: 'D:/绿色版/PotPlayerMini64.exe' },
    ],
    selected: 'pot',
  });
  await box.ctx.pickPlayerExe('pot');
  assert.deepEqual(box.logs, [['已指定 PotPlayer 的路径', 'good']]);

  // mpv 随安装包附带，没有「指定路径」这回事
  box.calls.length = 0;
  await box.ctx.pickPlayerExe('mpv');
  assert.deepEqual(box.calls, []);
});
test('控制条上的下拉框和「指定路径…」都接了线', () => {
  const html = read('src', 'renderer', 'index.html');
  assert.match(html, /id="player-slot"/);
  assert.match(html, /id="btn-switch-player"/);
  assert.match(APP, /playerSelect\.addEventListener\('change', \(\) => switchPlayer\(playerSelect\.value\)\)/);
  assert.match(APP, /playerPickBtn\.addEventListener\('click', \(\) => pickPlayerExe\(playerSelect\.value\)\)/);
  // 找不到的那一项在下拉框里要写明原因，mpv 没有「指定路径」这回事
  assert.match(APP, /\$\{p\.name\}（\$\{playerReasonText\(p\.reason\)\}）/);
  assert.match(APP, /playerPickBtn\.classList\.toggle\('hidden', playerSelect\.value === 'mpv'/);
  assert.match(APP, /window\.sw\.player\.onNotice/, '播放器那侧的提示没接线');
});

test('新文案都有英文，播放器名字原样留着', async () => {
  const { translate } = await import('../src/renderer/lib/i18n.js');
  assert.equal(translate('PotPlayer 已启动（先暂停着，等所有人就绪）', 'en'), 'PotPlayer started and is paused while everyone gets ready');
  assert.equal(translate('启动 MPC-BE 失败：桥接程序未构建', 'en'), 'Failed to start MPC-BE: Bridge not built');
  assert.equal(
    translate('没找到 PotPlayer，可以在控制条里指定它的路径', 'en'),
    'PotPlayer was not found. You can set its path from the control bar.'
  );
  assert.equal(
    translate('当前实际使用：mpv（原因：这一部还没收完）', 'en'),
    'Actually using mpv (reason: This video is not fully received yet)'
  );
  assert.equal(translate('已收完 · 切换到 PotPlayer', 'en'), 'Fully received · switch to PotPlayer');
  assert.equal(translate('PotPlayer（未找到）', 'en'), 'PotPlayer (Not found)');
  assert.equal(translate('切换失败，已回到 mpv', 'en'), 'Switching failed, back on mpv');
  // 运行期遥控失效：这一句是拼出来的，前半段自己还要再翻一道
  assert.equal(
    translate('PotPlayer 脱离了遥控，正在退回 mpv', 'en'),
    'PotPlayer is no longer under remote control — falling back to mpv'
  );
  assert.equal(
    translate('MPC-BE 不再应答遥控，正在退回 mpv', 'en'),
    'MPC-BE stopped answering remote control — falling back to mpv'
  );
  assert.equal(
    translate('有人在 PotPlayer 里打开了别的文件，正在退回 mpv', 'en'),
    'Someone opened a different file in PotPlayer — falling back to mpv'
  );
  assert.equal(
    translate('PotPlayer 以管理员身份运行，NoxReel 遥控不了它，正在退回 mpv', 'en'),
    'PotPlayer runs as administrator, so NoxReel cannot control it — falling back to mpv'
  );
  assert.equal(translate('退回 mpv 失败：操作已取消', 'en'), 'Could not fall back to mpv: Cancelled');
  // 主进程适配器报上来的正文：会被「播放器 X 报错：…」按 detail 再翻一道
  assert.equal(translate('播放器 PotPlayer 报错：PotPlayer 没有应答', 'en'), 'Player PotPlayer error: PotPlayer is not answering');
  assert.equal(
    translate('播放器 MPC-BE 报错：MPC-BE 断开了遥控连接', 'en'),
    'Player MPC-BE error: MPC-BE closed the remote-control connection'
  );
  assert.equal(
    translate('播放器 PotPlayer 报错：有人在 PotPlayer 里打开了别的文件，已暂停', 'en'),
    'Player PotPlayer error: Someone opened a different file in PotPlayer, so playback is paused'
  );
  assert.match(
    translate('播放器 MPC-BE 报错：MPC-BE 不再响应遥控（可能是被资源管理器转发启动的）。已退回 mpv', 'en'),
    /^Player MPC-BE error: MPC-BE stopped answering remote control/
  );
  assert.equal(translate('指定路径…', 'en'), 'Set path…');
  assert.equal(translate('已指定 MPC-BE 的路径', 'en'), 'Path set for MPC-BE');
  assert.equal(
    translate('Ctrl+Shift+D 被别的程序占用了，在播放器里发不了弹幕', 'en'),
    'Ctrl+Shift+D is taken by another program, so danmaku cannot be sent from inside the player'
  );
  assert.match(translate('独占全屏下看不到弹幕，切成无边框全屏就能看到', 'en'), /^Danmaku cannot be shown over exclusive fullscreen/);
  assert.match(translate('这会儿弹不出输入条：播放器不在前台，或者正处于独占全屏', 'en'), /^The input bar cannot open right now/);
  // 中文界面下原样返回
  assert.equal(translate('已收完 · 切换到 PotPlayer', 'zh-CN'), '已收完 · 切换到 PotPlayer');
});

/**
 * 用户自己在播放器里打开了别的文件，是他主动的操作 —— 软件不该反过来关掉他刚开的窗口
 * （退回 mpv 会给那个播放器发 WM_CLOSE）。但也不能继续把另一部片的位置当成这一部的 tick
 * 报上去：房主会据此广播 SYNC，把全房拽到一个不相干的位置。所以只撒手，不动窗口。
 */
test('用户在播放器里打开了别的文件：撒手不再同步，但不关他的窗口', async () => {
  const box = playerBox({ choice: 'pot' });
  await box.ctx.launchPlayer();
  box.calls.length = 0;
  box.logs.length = 0;

  await box.ctx.handlePlayerError({ message: '原始正文', code: 'PLAYER_FOREIGN_FILE', kind: 'pot' });

  const names = box.calls.map((c) => (Array.isArray(c) ? c[0] : c));
  assert.deepEqual(names.filter((n) => ['quit', 'launch', 'select'].includes(n)), [], '不关窗口、不换播放器、不改选择');
  assert.ok(names.includes('gate.retire'), '迟到的 tick / exit 要作废，否则还会拿另一部片的位置去同步');
  assert.equal(box.S.mpvRunning, false, '本机不再算「正在播放」');
  assert.equal(box.S.playerChoice, 'pot', '选择不动：用户回头还想用它');
  assert.match(box.logs[0][0], /打开了别的文件/);
  assert.equal(box.logs[0][1], 'warn', '这不是故障，是用户自己的操作');
});
