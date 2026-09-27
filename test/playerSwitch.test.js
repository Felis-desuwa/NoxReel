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

/** 外部播放器那一类：用户在它里面换了片之后，可以撒手而不关它的窗口。 */
class FakeExternal extends FakePlayer {
  constructor(opts) {
    super(opts);
    this.releases = 0;
    this.paused = [];
    this.osds = [];
    this.banners = [];
  }
  async release() {
    this.releases++;
  }
  async setPause(paused) {
    this.paused.push(paused);
  }
  osd(text) {
    this.osds.push(text);
  }
  setBanner(text) {
    this.banners.push(text);
  }
}

function externalManager() {
  const made = [];
  const events = [];
  const Tracked = class extends FakeExternal {
    constructor(opts) {
      super(opts);
      made.push(this);
    }
  };
  const mgr = new PlayerManager({ send: () => {}, adapters: { ext: Tracked, fake: FakePlayer } });
  mgr.on('gone', (payload) => events.push(payload));
  return { mgr, made, events };
}

test('撒手：current 置空、覆盖窗松开，之后的暂停、横幅、OSD 一条都不再发给他的窗口', async () => {
  const { mgr, made, events } = externalManager();
  const info = await mgr.launch('ext', {});
  const adapter = made[0];
  assert.equal(await mgr.release(info.gen), true);
  assert.equal(adapter.releases, 1);
  assert.equal(adapter.quits, 0, '撒手不是退出：用户正在看的那部片不能被关掉');
  assert.equal(mgr.running, false);
  assert.deepEqual(events.map((e) => e.gen), [info.gen], '覆盖窗和 Ctrl+Shift+D 要跟着松开');
  assert.equal(adapter.listenerCount('tick') + adapter.listenerCount('error') + adapter.listenerCount('window'), 0);

  // 同步引擎每次收敛都会发暂停；全员暂停横幅、缓冲 OSD 也照发 —— 都得落空
  await assert.rejects(mgr.setPause(true), /播放器未启动/);
  mgr.osd('等待 小明 缓冲…', 3000);
  mgr.setBanner('全员暂停中');
  assert.deepEqual(adapter.paused, []);
  assert.deepEqual(adapter.osds, []);
  assert.deepEqual(adapter.banners, []);

  // 之后「重新打开」、换片、退房：开新窗口 / 退当前播放器，都不许去关他那个窗口
  await mgr.quit();
  await mgr.launch('ext', {});
  await mgr.quit();
  assert.equal(adapter.quits, 0, '撒手之后的 quit 还是关掉了他的窗口');
  assert.equal(made[1].quits, 1, '新开的那一个照常归我们管');
});

test('撒手只放那一代：代号对不上（换过播放器了）什么都不动', async () => {
  const { mgr, made } = externalManager();
  const first = await mgr.launch('ext', {});
  await mgr.launch('ext', {});
  assert.equal(await mgr.release(first.gen), false);
  assert.equal(mgr.running, true, '迟到的撒手把刚起来的新播放器放掉了');
  assert.equal(made[1].releases, 0);
  assert.equal(await mgr.release(), true, '不带代号就放当前这一代');
  assert.equal(await mgr.release(), false, '没有播放器时是空操作');
});

test('撒手的收尾（撤掉桥上的跟踪）落地之前，下一代不许起来', async () => {
  const { mgr, made } = externalManager();
  await mgr.launch('ext', {});
  let finish = null;
  made[0].release = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const releasing = mgr.release();
  const next = mgr.launch('ext', {});
  await new Promise((resolve) => setImmediate(resolve));
  // 桥的 untrack 不分窗口：新窗口先 track、旧的后 untrack，就把新窗口的跟踪一并撤掉了
  assert.equal(made.length, 1, '撒手还没收完尾就拉起了下一代');
  finish();
  await releasing;
  await next;
  assert.equal(made.length, 2);
  await mgr.quit();
});

test('没有撒手这一说的播放器（mpv）照常退掉，不留没人管的进程', async () => {
  const { mgr } = manager();
  await mgr.launch('fake', {});
  const adapter = FakePlayer.made[0];
  assert.equal(await mgr.release(), true);
  await mgr.quit();
  assert.equal(adapter.quits, 1);
});

test('撒手接了线：player:release 带代号校验，preload 暴露了它，渲染进程撒手时调用', () => {
  const main = read('src', 'main', 'main.js');
  const preload = read('src', 'main', 'preload.js');
  assert.match(main, /secureHandle\('player:release', async \(gen\) => \{\r?\n\s*await players\.release\(gen === undefined \|\| gen === null \? undefined : validate\.integer\(gen, '播放器代号', \{ min: 1 \}\)\);/);
  assert.match(preload, /release: \(gen\) => ipcRenderer\.invoke\('player:release', gen\)/);
  assert.match(fnSource('detachFromPlayer'), /window\.sw\.player\.release\(gen\)/);
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
  'errCode',
  'errText',
  'reportLaunchFailure',
  'fallsBackToMpv',
  'launchMpvInstead',
  'maybeLaunchPlayer',
  'handlePlayerExit',
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
    relaunchingPlayer: false,
    noAutoLaunchSeq: null,
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
    release: async (gen) => calls.push(['release', gen]),
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
      // 和真的闸门一样：回包认下这一代，退播放器时作废（换播放器要靠它分清「已经起来了」和「还在起」）
      confirm(gen) {
        this.gen = Number.isInteger(gen) ? gen : null;
        return {};
      },
      acceptExit: () => false,
      retire() {
        this.gen = null;
        this.epoch++;
        calls.push('gate.retire');
      },
    },
    handlePlayerTick: noop,
    renderStatus: noop,
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

test('片源不受「还没收完」限制 —— 它手上就是完整的一路', () => {
  const seeder = playerBox({ choice: 'pot', complete: false });
  seeder.S.isSeeder = true;
  assert.deepEqual(plain(seeder.ctx.desiredPlayerKind()), { kind: 'pot', reason: '' });
});

test('在线链接一律交给 mpv：外部播放器不走过滤代理，会跟着跳转去连内网', () => {
  for (const choice of ['pot', 'mpc']) {
    const link = playerBox({ choice, sourceType: 'link' });
    assert.deepEqual(plain(link.ctx.desiredPlayerKind()), { kind: 'mpv', reason: 'link' }, choice);
  }
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  assert.match(main, /if \(remote && want !== 'mpv'\) throw new Error\('在线链接只能用 mpv 播放'\);/, '主进程也得拒');
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

test('在线链接只用 mpv：选了 PotPlayer 也不冒「已收完 · 切换到 PotPlayer」', async () => {
  const box = playerBox({ choice: 'pot', sourceType: 'link' });
  await box.ctx.launchPlayer();
  assert.equal(box.S.playerKind, 'mpv', '在线链接照旧交给 mpv');
  box.ctx.updatePlayerSwitchHint();
  assert.equal(box.$('btn-switch-player').hidden, true, '点了也换不过去，不该出现');
  assert.deepEqual(box.calls.filter((c) => c[0] === 'osd'), []);
  assert.equal(box.ctx.externalPlaybackReady(), false);
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
    translate('播放器 MPC-BE 报错：MPC-BE 不再响应遥控。已退回 mpv', 'en'),
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

/**
 * 实测 E7-C：MPC-BE 被资源管理器转交了别的文件，/slave 被清掉、什么都不再推。
 * 适配器按「被用户拿走」报 PLAYER_FOREIGN_FILE（不是 PLAYER_DETACHED），这里要走撒手：
 * 以前走的是退回 mpv —— 桥给那个正显示着他那部片的窗口发 WM_CLOSE。
 */
test('MPC-BE 被资源管理器拿走（PLAYER_FOREIGN_FILE）：撒手，不退回 mpv、不关他的窗口', async () => {
  const box = playerBox({ choice: 'mpc' });
  await box.ctx.launchPlayer();
  const gen = box.ctx.playerGate.gen;
  box.calls.length = 0;
  box.logs.length = 0;

  await box.ctx.handlePlayerError({
    message: 'MPC-BE 被交给了别的文件（比如在资源管理器里双击了视频），不再听遥控',
    code: 'PLAYER_FOREIGN_FILE',
    kind: 'mpc',
    gen,
  });
  const names = box.calls.map((c) => (Array.isArray(c) ? c[0] : c));
  assert.deepEqual(names.filter((n) => ['quit', 'launch', 'select'].includes(n)), [], '不关窗口、不退回 mpv、不改选择');
  assert.deepEqual(box.calls.filter((c) => c[0] === 'release'), [['release', gen]]);
  assert.equal(box.S.playerChoice, 'mpc');
  assert.equal(box.logs[0][1], 'warn');

  // 适配器报上来的正文都有英文（只有代号认不出来时才会原样摆出来）
  const { translate } = await import('../src/renderer/lib/i18n.js');
  for (const text of [
    '播放器 MPC-BE 报错：MPC-BE 被交给了别的文件（比如在资源管理器里双击了视频），不再听遥控',
    '播放器 MPC-BE 报错：MPC-BE 不再响应遥控。已退回 mpv',
  ]) {
    assert.doesNotMatch(translate(text, 'en'), /[一-鿿]/, `英文界面上还剩中文：${text}`);
  }
});

/* ======================= 四、播放器生命周期（批次 7） ======================= */

/**
 * A5-1：撒手只在渲染进程生效的话，主进程的 current 还指着他的窗口 —— 房间的播放/暂停、
 * 全员暂停横幅、缓冲 OSD 照样打过去，之后重开、换片、退房还会给它发 WM_CLOSE。
 * 渲染进程这一侧要做的是：带着那一代的代号叫主进程撒手，而且之后不再自动给这一部开新窗口。
 */
test('撒手时叫主进程一起放掉那一代（带代号），关会话要等它；同一部不再自动拉起', async () => {
  const box = playerBox({ choice: 'pot' });
  box.S.roomSecurityMode = 'safe';
  box.S.swarm = { playingSlot: 0 };
  await box.ctx.launchPlayer();
  const gen = box.ctx.playerGate.gen;
  assert.ok(Number.isInteger(gen));
  box.calls.length = 0;

  await box.ctx.handlePlayerError({ message: '原始正文', code: 'PLAYER_FOREIGN_FILE', kind: 'pot', gen });
  assert.deepEqual(box.calls.filter((c) => c[0] === 'release'), [['release', gen]], '主进程那一侧没撒手，指令还会打到他的片上');
  assert.ok(!box.calls.includes('quit'), '撒手不是退出：他的窗口不能被关掉');
  await box.S.playerQuit; // 关会话、删缓存前等的那一串里要有这一次撒手

  // 本机在给别人供片：每发出一片来一条 progress。不能给这一部再拉一个新窗口
  box.ctx.maybeLaunchPlayer({ slot: 0, complete: true });
  await Promise.resolve();
  assert.deepEqual(box.calls.filter((c) => c[0] === 'launch'), [], '撒手之后又自动开了一个新窗口');
  assert.equal(box.$('btn-reopen').hidden, false, '要不要回来由他决定：「重新打开」得在');
});

/**
 * A5-2：安全模式、网状拓扑、本机还在给别人供当前这部。swarm 每发完一片就 emit('progress')，
 * maybeLaunchPlayer 的安全模式分支条件一直成立 —— 用户关一次，下一片发出去就又弹出来。
 */
test('安全模式下用户关掉播放器：供片的 progress 不再把它拉起来；「重新打开」、换片照常', async () => {
  const box = playerBox({ choice: 'mpv' });
  box.S.roomSecurityMode = 'safe';
  box.S.swarm = { playingSlot: 0 };
  const launches = () => box.calls.filter((c) => c[0] === 'launch').length;
  const served = { slot: 0, complete: true, contiguousBytes: 1, runBytes: 1 };
  await box.ctx.launchPlayer();
  assert.equal(launches(), 1);

  box.ctx.handlePlayerExit({ code: 0 });
  assert.equal(box.S.mpvRunning, false);
  for (let i = 0; i < 5; i++) box.ctx.maybeLaunchPlayer(served);
  await Promise.resolve();
  assert.equal(launches(), 1, '关一次弹一次：用户没法「留在房间里但先不看」');
  assert.ok(box.logs.some(([text]) => /可在房间里重新打开/.test(text)));

  // 用户自己点「重新打开」：照常起来，记号随之作废
  assert.equal(await box.ctx.launchPlayer(), true);
  assert.equal(launches(), 2);
  assert.equal(box.S.noAutoLaunchSeq, null);

  // 再关一次，照样挡住
  box.ctx.handlePlayerExit({ code: 0 });
  box.ctx.maybeLaunchPlayer(served);
  await Promise.resolve();
  assert.equal(launches(), 2);

  // 换到下一部（seq 变了）：自动起播照旧
  box.S.currentSeq = 4;
  box.ctx.maybeLaunchPlayer(served);
  await Promise.resolve();
  assert.equal(launches(), 3, '下一部不该被上一部的「关掉了」挡住');
});

/** 扫描通过那一刻的起播：用户在这一部上关掉过播放器、或正在换播放器时都不抢。 */
function scanBox({ dismissed = false, relaunching = false } = {}) {
  const calls = [];
  const logs = [];
  const session = { fileId: 'f1', sessionId: 's1', slot: 0, manifest: { name: 'a.mkv' }, safety: { status: 'scanning' } };
  const S = {
    leaving: false,
    sessions: new Map([['f1', session]]),
    roomSecurityMode: 'trusted',
    mpvRunning: false,
    currentSeq: 5,
    noAutoLaunchSeq: dismissed ? 5 : null,
    relaunchingPlayer: relaunching,
  };
  const ctx = {
    S,
    t: (s) => s,
    log: (text, kind) => logs.push([text, kind]),
    decideScanOutcome: () => ({ destroy: false, status: 'clean' }),
    blockScannedSession: async () => {},
    maybeSaveDownload: () => {},
    currentSession: () => session,
    launchPlayer: async () => calls.push('launch'),
    renderStatus: () => {},
    window: { sw: { player: { osd: async () => {} } } },
  };
  vm.createContext(ctx);
  vm.runInContext(fnSource('applyScanResult'), ctx, { filename: 'app.js（节选）' });
  return { ctx, calls, logs, session };
}

test('可信房间边下边播时用户关掉了播放器：扫描通过不再替他拉起来，日志不说「正在打开播放器」', async () => {
  const closed = scanBox({ dismissed: true });
  await closed.ctx.applyScanResult(closed.session, { ok: true, status: 'clean' }, 'trusted-streaming');
  assert.deepEqual(closed.calls, [], '用户关掉的那一部被扫描通过又弹了出来');
  assert.equal(closed.logs[0][0], '完整文件安全扫描通过；缓存在关软件时清掉');

  const switching = scanBox({ relaunching: true });
  await switching.ctx.applyScanResult(switching.session, { ok: true, status: 'clean' }, 'trusted-streaming');
  assert.deepEqual(switching.calls, [], '换播放器途中抢先起了一个');

  // 反面：没关过、也没在换，扫描通过照常打开
  const normal = scanBox();
  await normal.ctx.applyScanResult(normal.session, { ok: true, status: 'clean' }, 'waiting-download');
  assert.deepEqual(normal.calls, ['launch']);
  assert.equal(normal.logs[0][0], '安全扫描通过，正在打开播放器；缓存在关软件时清掉');
});

test('换片途中旧播放器退出不算「用户关掉了这一部」', async () => {
  const box = playerBox({ choice: 'mpv' });
  box.S.roomSecurityMode = 'safe';
  box.S.swarm = { playingSlot: 0 };
  await box.ctx.launchPlayer();
  box.S.switchingMedia = true;
  box.ctx.handlePlayerExit({ code: 0 });
  box.S.switchingMedia = false;
  assert.equal(box.S.noAutoLaunchSeq, null);
});

test('起播失败的这一部不再被供片的 progress 反复重拉，「重新打开」仍可重试', async () => {
  const box = playerBox({ choice: 'mpv', launchFails: () => true });
  box.S.roomSecurityMode = 'safe';
  box.S.swarm = { playingSlot: 0 };
  box.ctx.maybeLaunchPlayer({ slot: 0, complete: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(box.calls.filter((c) => c[0] === 'launch').length, 1);
  assert.equal(box.S.mpvRunning, false);
  for (let i = 0; i < 5; i++) box.ctx.maybeLaunchPlayer({ slot: 0, complete: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(box.calls.filter((c) => c[0] === 'launch').length, 1, '每发出一片就重拉一次、报一遍错');
  assert.equal(box.$('btn-reopen').hidden, false);
  // 用户手动重试不受这道门影响
  await box.ctx.launchPlayer();
  assert.equal(box.calls.filter((c) => c[0] === 'launch').length, 2);
});

/**
 * A5-3：选择变了，但这一部实际仍得用 mpv（在线链接、边下边播还没收完、选的那个没找到、
 * 或者本来就因为这些在跑 mpv 又切回 mpv）。白白重开一次 mpv：窗口黑一下、弹幕清空、退出全屏，
 * 在线链接还要重新解析、重新缓冲，控制者重开期间全房跟着等。
 */
test('换播放器但实际仍得用 mpv：不重启正在跑的 mpv，只把「当前实际使用」的原因换成新的', async () => {
  const restarts = (box) =>
    box.calls.filter((c) => c === 'gate.retire' || c === 'quit' || (Array.isArray(c) && c[0] === 'launch')).length;

  // 情形 A：在线链接，选 PotPlayer
  const link = playerBox({ choice: 'mpv', sourceType: 'link' });
  await link.ctx.launchPlayer();
  link.calls.length = 0;
  await link.ctx.switchPlayer('pot');
  assert.equal(restarts(link), 0, '在线链接只用 mpv，换了选择也还是这个 mpv');
  assert.equal(link.S.playerChoice, 'pot', '选择照样记下');
  assert.equal(link.S.playerKind, 'mpv');
  assert.equal(link.ctx.playerActualText(), '当前实际使用：mpv（原因：在线链接只用 mpv 播放）');
  // 情形 D：本来就因为回退原因在跑 mpv，又切回 mpv
  await link.ctx.switchPlayer('mpv');
  assert.equal(restarts(link), 0);
  assert.equal(link.S.playerFallback, '', '原因也要跟着换，不然那行字还挂着旧原因');
  assert.equal(link.ctx.playerActualText(), '');

  // 情形 B：边下边播还没收完，在两个外部播放器之间来回切
  const streaming = playerBox({ choice: 'mpv', complete: false });
  await streaming.ctx.launchPlayer();
  streaming.calls.length = 0;
  await streaming.ctx.switchPlayer('mpc');
  await streaming.ctx.switchPlayer('pot');
  assert.equal(restarts(streaming), 0);
  assert.equal(streaming.ctx.playerActualText(), '当前实际使用：mpv（原因：这一部还没收完）');

  // 情形 C：选了下拉框里标着「（未找到）」的那一项
  const missing = playerBox({
    choice: 'mpv',
    list: [
      { id: 'mpv', name: 'mpv', available: true, reason: '' },
      { id: 'pot', name: 'PotPlayer', available: false, reason: 'not-found' },
    ],
  });
  await missing.ctx.launchPlayer();
  missing.calls.length = 0;
  await missing.ctx.switchPlayer('pot');
  assert.equal(restarts(missing), 0);
  assert.equal(missing.ctx.playerActualText(), '当前实际使用：mpv（原因：未找到）');
});

test('启动还在途（代号没确认）时换播放器照旧重来：那一次用的是旧选择', async () => {
  const box = playerBox({ choice: 'mpv', sourceType: 'link' });
  box.S.mpvRunning = true; // 占着位，回包还没到
  await box.ctx.switchPlayer('pot');
  assert.ok(box.calls.includes('gate.retire'));
  assert.deepEqual(box.calls.filter((c) => c[0] === 'launch'), [['launch', 'mpv', 601]]);
});

/** 旧播放器的 quit 挂起，直到测试放行 —— 用来卡在「旧的已退、新的还没起」那段窗口里。 */
function holdQuit(box) {
  const pending = [];
  box.ctx.window.sw.player.quit = () => {
    box.calls.push('quit');
    return new Promise((resolve) => pending.push(resolve));
  };
  return {
    get waiting() {
      return pending.length > 0;
    },
    release: () => pending.splice(0).forEach((resolve) => resolve()),
  };
}

/**
 * A5-4：安全模式 + 供片时换播放器。relaunchWithPlayer 等旧进程退出的那几秒里 S.mpvRunning 是 false，
 * 这时来一条供片 progress，maybeLaunchPlayer 就抢先拉起一个；relaunchWithPlayer 自己那次撞上
 * S.mpvRunning 返回 false，被当成「新播放器起不来」—— 选择被改写成 mpv，日志报一次并没有发生的失败。
 */
test('换播放器途中别处来的起播请求让位，这次切换不会被挤成「失败」', async () => {
  const box = playerBox({ choice: 'mpv' });
  box.S.roomSecurityMode = 'safe';
  box.S.swarm = { playingSlot: 0 };
  await box.ctx.launchPlayer();
  box.calls.length = 0;
  box.logs.length = 0;
  const held = holdQuit(box);

  const switching = box.ctx.switchPlayer('pot');
  while (!held.waiting) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(box.S.mpvRunning, false, '旧的已经退了、新的还没起');
  // 供片的 progress、扫描通过这类起播请求正好在这时到了
  box.ctx.maybeLaunchPlayer({ slot: 0, complete: true });
  assert.equal(await box.ctx.launchPlayer(), 'superseded', '让位要报「作废」，不能报成失败');
  assert.deepEqual(box.calls.filter((c) => c[0] === 'launch'), [], '别处抢先起了一个');

  held.release();
  await switching;
  assert.deepEqual(box.calls.filter((c) => c[0] === 'launch'), [['launch', 'pot', 601]]);
  assert.equal(box.S.playerChoice, 'pot', '选择被悄悄改写成了 mpv');
  assert.equal(box.S.playerKind, 'pot');
  assert.deepEqual(box.calls.filter((c) => c[0] === 'select'), [['select', 'pot']]);
  assert.ok(!box.logs.some(([text]) => text === '切换失败，已回到 mpv'), '报了一次并没有发生的失败');
  assert.equal(box.S.relaunchingPlayer, false, '切换结束要把独占放掉');
});

test('换播放器途中换了片：独占让出来，新的一部照常起播，这次切换不报失败', async () => {
  const box = playerBox({ choice: 'mpv' });
  await box.ctx.launchPlayer();
  box.calls.length = 0;
  box.logs.length = 0;
  const held = holdQuit(box);

  const switching = box.ctx.switchPlayer('pot');
  while (!held.waiting) await new Promise((resolve) => setImmediate(resolve));
  // 换片：switchCurrent 先退播放器，再给新的一部起播
  box.ctx.retirePlayer();
  box.S.currentSeq = 4;
  const next = box.ctx.launchPlayer();
  held.release();
  assert.equal(await next, true, '新的一部被换播放器的独占挡住了');
  await switching;
  assert.equal(box.calls.filter((c) => c[0] === 'launch').length, 1, '被作废的切换不该再起一个');
  assert.ok(!box.logs.some(([text]) => text === '切换失败，已回到 mpv'));
  assert.equal(box.S.playerChoice, 'pot');
});

/**
 * A5-5：外部播放器第一次起播就起不来（不是运行中切换）。以前只报一句，下一部、扫描通过、
 * 「重新打开」都照着选择再去拉它，每次都要等它超时，人一直晾在没有画面的房间里。
 */
test('外部播放器首次起播失败：本次改用 mpv，选择也改回 mpv，原因说出来', async () => {
  for (const code of ['PLAYER_NO_WINDOW', 'PLAYER_ELEVATED', 'PLAYER_DETACHED', 'PLAYER_TIMEOUT']) {
    const box = playerBox({ choice: 'pot' });
    box.ctx.window.sw.player.launch = async (opts) => {
      box.calls.push(['launch', opts.kind, Math.round(opts.startAt)]);
      if (opts.kind === 'pot') throw new Error(`Error invoking remote method 'player:launch': Error: [${code}] 起不来`);
      return { gen: box.calls.length, caps: {} };
    };
    assert.equal(await box.ctx.launchPlayer(), true, `${code}：本次没有退回 mpv`);
    assert.deepEqual(
      box.calls.filter((c) => c[0] === 'launch'),
      [
        ['launch', 'pot', 600],
        ['launch', 'mpv', 600],
      ],
      code
    );
    assert.equal(box.S.playerKind, 'mpv');
    assert.equal(box.S.playerChoice, 'mpv', `${code}：选择不改的话，下一部还会去拉那个起不来的播放器`);
    assert.deepEqual(box.calls.filter((c) => c[0] === 'select'), [['select', 'mpv']]);
    assert.ok(box.logs.some(([text]) => text === '已改用 mpv 播放，播放器选择也改回了 mpv'), code);
    assert.equal(box.S.noAutoLaunchSeq, null, '最后起来了，就不算这一部起不来');
  }
});

test('PotPlayer 单实例把片子交给了已开着的窗口（PLAYER_GONE）：不自动再拉 mpv，提示里给下一步', async () => {
  const box = playerBox({ choice: 'pot' });
  box.S.roomSecurityMode = 'safe';
  box.S.swarm = { playingSlot: 0 };
  box.ctx.window.sw.player.launch = async (opts) => {
    box.calls.push(['launch', opts.kind, Math.round(opts.startAt)]);
    throw new Error(
      "Error invoking remote method 'player:launch': Error: [PLAYER_GONE] PotPlayer 启动后立刻退出了（可能是它的单实例设置把文件交给了别的窗口）"
    );
  };
  assert.equal(await box.ctx.launchPlayer(), false);
  assert.deepEqual(box.calls.filter((c) => c[0] === 'launch'), [['launch', 'pot', 600]], '他那边已经有画面了，再拉一个 mpv 就是两个窗口一起出声');
  assert.equal(box.S.playerChoice, 'pot');
  assert.match(box.logs.at(-1)[0], /^PotPlayer 启动后立刻退出了.*在控制条里改用 mpv$/);
  // 供片的 progress 不许一遍遍重拉 —— 每一次都会把片子再塞给他那个窗口
  box.ctx.maybeLaunchPlayer({ slot: 0, complete: true });
  await Promise.resolve();
  assert.equal(box.calls.filter((c) => c[0] === 'launch').length, 1);
});

test('mpv 自己起不来不会「退回 mpv」', async () => {
  const box = playerBox({ choice: 'mpv', launchFails: () => true });
  assert.equal(await box.ctx.launchPlayer(), false);
  assert.equal(box.calls.filter((c) => c[0] === 'launch').length, 1);
  assert.deepEqual(box.calls.filter((c) => c[0] === 'select'), []);
});

test('运行中切换失败仍由 relaunchWithPlayer 自己退回 mpv，不会退两遍', async () => {
  const box = playerBox({ choice: 'mpv', launchFails: (opts) => opts.kind === 'pot' });
  await box.ctx.launchPlayer();
  box.calls.length = 0;
  box.logs.length = 0;
  await box.ctx.switchPlayer('pot');
  assert.deepEqual(
    box.calls.filter((c) => c[0] === 'launch'),
    [
      ['launch', 'pot', 601],
      ['launch', 'mpv', 601],
    ]
  );
  assert.deepEqual(box.calls.filter((c) => c[0] === 'select'), [['select', 'pot'], ['select', 'mpv']]);
  assert.ok(!box.logs.some(([text]) => text === '已改用 mpv 播放，播放器选择也改回了 mpv'), '切换那一路有自己的说法');
});

test('批次 7 的新文案都有英文，播放器名字原样留着', async () => {
  const { translate } = await import('../src/renderer/lib/i18n.js');
  assert.equal(
    translate('已改用 mpv 播放，播放器选择也改回了 mpv', 'en'),
    'Playing in mpv instead; the player choice was switched back to mpv'
  );
  const gone = translate(
    'PotPlayer 启动后立刻退出了，片子多半被它的单实例设置交给了已开着的窗口，那个窗口不跟房间同步。关掉它再点「重新打开播放器」，或在控制条里改用 mpv',
    'en'
  );
  assert.match(gone, /^PotPlayer exited right after starting\./);
  assert.match(gone, /“Reopen player”/);
  assert.doesNotMatch(gone, /[一-鿿]/, '英文界面上还剩中文');
  // 拼出来的那一句（reportLaunchFailure）和字典里的是同一句
  const box = playerBox();
  box.ctx.reportLaunchFailure(new Error('Error: [PLAYER_GONE] x'), 'pot', 'MPC-BE');
  assert.doesNotMatch(translate(box.logs.at(-1)[0], 'en'), /[一-鿿]/);
});
