'use strict';

/**
 * mpv 的弹幕层与播放器内输入（P5 主进程侧）。
 *
 * 这一路的三个要点，每个都在下面有对应的测试：
 *  1. 正文来自房间里的其他人，却要拼进一条 ASS 交给 mpv —— 转义和上限是安全面；
 *  2. 每秒 30 帧走同一条 socket，必须「宁可丢帧也不排队」，不然暂停命令会被弹幕堵住；
 *  3. Lua 脚本是打包资源，路径、快捷键、旧版 mpv 的降级都得钉住。
 *
 * 全程不启动 mpv：socket 用假的，命令写进数组里看。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  MpvController,
  buildDanmakuAss,
  buildLaunchArgs,
  chatScriptCandidates,
  findChatScript,
  sliceCodePoints,
  OVERLAY_DANMAKU,
  OVERLAY_ROOM,
  MAX_DANMAKU_ITEMS,
  MAX_DANMAKU_TEXT,
  CHAT_MESSAGE_NAME,
  CHAT_SCRIPT_FILE,
} = require('../src/main/mpv');
const { PlayerManager } = require('../src/main/players');
const validate = require('../src/main/security');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

// 反斜杠一个都不直接写：这个仓库里的字面反斜杠被工具多转义过一层不止一次
const BACKSLASH = String.fromCharCode(92);
const NEWLINE = String.fromCharCode(10);

/** 微任务排空：命令回包之后，_danmaku.inFlight 是在 .then 里清的。 */
const flush = async () => {
  await null;
  await null;
};

/**
 * 接了假 socket 的控制器。命令只写进数组，回包由测试自己喂。
 * 命令超时用的是真 setTimeout（5 秒），所以调用方要开 t.mock.timers，
 * 否则测试跑完了进程还要等那些定时器。
 */
function fakeController() {
  const ctl = new MpvController();
  const sent = [];
  const answered = new Set();
  ctl.sock = {
    destroyed: false,
    write(line, cb) {
      sent.push(JSON.parse(line));
      if (cb) cb();
    },
  };
  return {
    ctl,
    sent,
    commands: () => sent.map((m) => m.command),
    /** 把所有还没回包的命令都答应掉。 */
    replyAll() {
      for (const msg of sent) {
        if (answered.has(msg.request_id)) continue;
        answered.add(msg.request_id);
        ctl._onData(JSON.stringify({ request_id: msg.request_id, error: 'success' }) + NEWLINE);
      }
    },
  };
}

const frameOf = (items, extra = {}) => ({ w: 1280, h: 720, items, ...extra });
const oneItem = (extra = {}) => [{ text: '一条弹幕', x: 100, y: 40, ...extra }];

/* ------------------------------ 拼 ASS 与转义 ------------------------------ */

test('别人的弹幕拼不出样式覆盖块，也拼不出第二条事件', () => {
  // 花括号 + 反斜杠 = ASS 的样式覆盖块。留着的话，一条弹幕就能把整屏弹幕挪走或者变透明
  const evil = buildDanmakuAss([{ text: '{' + BACKSLASH + 'an1}挪走', x: 10, y: 20 }]);
  assert.equal(evil.split(NEWLINE).length, 1, '一条弹幕只能是一条 ASS 事件');
  assert.ok(evil.endsWith('an1挪走'), '花括号和反斜杠被丢掉，剩下的是普通文字');

  // 换行是事件之间的分隔符：漏过去就等于凭空多出一条弹幕，位置还由发送者说了算
  const injected = buildDanmakuAss([{ text: '第一句' + NEWLINE + '伪造的第二条', x: 0, y: 0 }]);
  assert.equal(injected.split(NEWLINE).length, 1);
  assert.ok(injected.includes('第一句 伪造的第二条'), '换行换成空格，不是原样保留');

  // 回车同理，而且中文和空格一个字都不能丢
  const cr = buildDanmakuAss([{ text: 'a' + String.fromCharCode(13) + 'b', x: 0, y: 0 }]);
  assert.ok(cr.endsWith('a b'));
  assert.ok(buildDanmakuAss([{ text: '今天的 片子 真好看', x: 0, y: 0 }]).endsWith('今天的 片子 真好看'));
});

test('每条各自带 \\pos，坐标取整，多条之间用换行分开', () => {
  const out = buildDanmakuAss([
    { text: 'a', x: 1.4, y: 2.6 },
    { text: 'b', x: -300.6, y: 80 },
  ]);
  const lines = out.split(NEWLINE);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('{' + BACKSLASH + 'an7}{' + BACKSLASH + 'pos(1,3)}'), lines[0]);
  assert.ok(lines[1].startsWith('{' + BACKSLASH + 'an7}{' + BACKSLASH + 'pos(-301,80)}'), lines[1]);
  // an7 = 左上对齐：排布算出来的 x/y 就是这条弹幕的左上角
  assert.equal(out.includes(BACKSLASH + 'move'), false, '覆盖层的渲染时间恒为 0，\\move 不会动');
});

test('自己发的那条描边不一样，不透明度换成 ASS 的 alpha', () => {
  const mine = buildDanmakuAss([{ text: 'a', x: 0, y: 0, outline: true, opacity: 1 }]);
  const other = buildDanmakuAss([{ text: 'a', x: 0, y: 0, outline: false, opacity: 1 }]);
  assert.ok(mine.includes(BACKSLASH + 'bord2.4') && mine.includes(BACKSLASH + '3c&HFF8D4C&'));
  assert.ok(other.includes(BACKSLASH + 'bord1.2') && other.includes(BACKSLASH + '3c&H000000&'));
  assert.notEqual(mine, other);
  // ASS 的 alpha 是反的：00 不透明、FF 全透明
  assert.ok(buildDanmakuAss([{ text: 'a', x: 0, y: 0, opacity: 1 }]).includes(BACKSLASH + 'alpha&H00&'));
  assert.ok(buildDanmakuAss([{ text: 'a', x: 0, y: 0, opacity: 0.85 }]).includes(BACKSLASH + 'alpha&H26&'));
  // 字号缺省也得有个能看的值，不能拼出 \fsundefined
  assert.equal(buildDanmakuAss([{ text: 'a', x: 0, y: 0 }]).includes('undefined'), false);
  assert.equal(buildDanmakuAss([{ text: 'a', x: 0, y: 0 }]).includes('NaN'), false);
});

test('拼 ASS 这一层自己也卡上限，不指望上游一定校验过', () => {
  const many = Array.from({ length: MAX_DANMAKU_ITEMS + 20 }, (_, i) => ({ text: 'x' + i, x: 0, y: 0 }));
  assert.equal(buildDanmakuAss(many).split(NEWLINE).length, MAX_DANMAKU_ITEMS);
  const long = buildDanmakuAss([{ text: '字'.repeat(MAX_DANMAKU_TEXT + 50), x: 0, y: 0 }]);
  assert.equal(long.slice(long.lastIndexOf('&}') + 2).length, MAX_DANMAKU_TEXT);
  // 空帧、坏输入都拼成空串（上层据此清空覆盖层）
  assert.equal(buildDanmakuAss([]), '');
  assert.equal(buildDanmakuAss(null), '');
  assert.equal(buildDanmakuAss([null, 'x', 7]), '');
  // 清洗之后什么都不剩的，不占一行
  assert.equal(buildDanmakuAss([{ text: '{}', x: 0, y: 0 }, { text: '留下', x: 0, y: 0 }]).split(NEWLINE).length, 1);
});

test('按码点截断，不会把 emoji 劈成半个代理对', () => {
  const cut = sliceCodePoints('🎬'.repeat(250), MAX_DANMAKU_TEXT);
  assert.equal([...cut].length, MAX_DANMAKU_TEXT);
  assert.equal([...cut].every((ch) => ch === '🎬'), true, '劈开代理对会变成乱码方块');
  assert.equal(sliceCodePoints('短', 200), '短');
  assert.equal(sliceCodePoints(null, 200), '');
});

/* -------------------------------- IPC 校验 -------------------------------- */

test('弹幕帧的条数、字数、坐标越界一律拒收', () => {
  assert.ok(validate.danmakuFrame(frameOf(oneItem({ fontSize: 30, opacity: 0.8, outline: true }))));
  assert.ok(validate.danmakuFrame(frameOf([])), '空帧是合法的：它表示清空');

  const bad = (frame) => assert.throws(() => validate.danmakuFrame(frame), /无效/);
  // 条数：60 条是上限，61 条拒收
  assert.ok(validate.danmakuFrame(frameOf(Array.from({ length: MAX_DANMAKU_ITEMS }, () => oneItem()[0]))));
  bad(frameOf(Array.from({ length: MAX_DANMAKU_ITEMS + 1 }, () => oneItem()[0])));
  // 字数按码点算：200 个汉字可以，201 个不行
  assert.ok(validate.danmakuFrame(frameOf(oneItem({ text: '字'.repeat(MAX_DANMAKU_TEXT) }))));
  bad(frameOf(oneItem({ text: '字'.repeat(MAX_DANMAKU_TEXT + 1) })));
  bad(frameOf(oneItem({ text: '🎬'.repeat(MAX_DANMAKU_TEXT + 1) })));
  bad(frameOf(oneItem({ text: '' })));
  bad(frameOf(oneItem({ text: 123 })));
  // 坐标：类型、范围
  bad(frameOf(oneItem({ x: '100' })));
  bad(frameOf(oneItem({ x: Number.NaN })));
  bad(frameOf(oneItem({ x: Infinity })));
  bad(frameOf(oneItem({ y: -1 })));
  bad(frameOf(oneItem({ y: 721 })), 'y 必须落在画布高度里');
  assert.ok(validate.danmakuFrame(frameOf(oneItem({ x: -5000 }))), '长弹幕快走完时 x 是大负数');
  // 画布尺寸
  bad({ w: 0, h: 720, items: [] });
  bad({ w: 1280, h: 99999, items: [] });
  bad({ w: 1280, items: [] });
  bad({ w: 1280, h: 720 });
  bad({ w: 1280, h: 720, items: 'x' });
  bad(null);
  // 其余字段的类型
  bad(frameOf(oneItem({ opacity: 2 })));
  bad(frameOf(oneItem({ fontSize: 0 })));
  bad(frameOf(oneItem({ outline: 'yes' })));
  bad(frameOf([null]));
  // 播放器代号
  assert.ok(validate.danmakuFrame(frameOf([], { gen: 3 })));
  bad(frameOf([], { gen: 0 }));
  bad(frameOf([], { gen: 1.5 }));
});

test('播放器内输入框的提示语不能劈开命令行参数', () => {
  assert.equal(validate.scriptOptValue('弹幕：'), '弹幕：');
  assert.equal(validate.scriptOptValue('Danmaku:'), 'Danmaku:');
  // 逗号是 script-opts 的分隔符，一个逗号就能再塞一个选项进去
  assert.throws(() => validate.scriptOptValue('a,b'), /无效/);
  assert.throws(() => validate.scriptOptValue('a' + NEWLINE + 'b'), /无效/);
  assert.throws(() => validate.scriptOptValue('a' + String.fromCharCode(0) + 'b'), /无效/);
  assert.throws(() => validate.scriptOptValue('长'.repeat(41)), /无效/);
  assert.throws(() => validate.scriptOptValue(''), /无效/);
  assert.throws(() => validate.scriptOptValue(7), /无效/);
});

/* ------------------------------ 发送节制与代际 ----------------------------- */

test('同一时间只有一帧在途，宁可丢帧也不排队', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ctl, commands, replyAll } = fakeController();

  assert.equal(ctl.setDanmakuFrame(frameOf(oneItem())), true);
  assert.equal(commands().length, 1);
  // 上一帧还没回包：这一帧直接丢掉，不进队列
  assert.equal(ctl.setDanmakuFrame(frameOf(oneItem({ x: 90 }))), false);
  assert.equal(ctl.setDanmakuFrame(frameOf(oneItem({ x: 80 }))), false);
  assert.equal(commands().length, 1, '丢帧就是真丢掉，不是攒着回头补发');

  replyAll();
  await flush();
  assert.equal(ctl.setDanmakuFrame(frameOf(oneItem({ x: 70 }))), true);
  assert.equal(commands().length, 2);
  const cmd = commands()[1];
  assert.equal(cmd[0], 'osd-overlay');
  assert.equal(cmd[1], OVERLAY_DANMAKU);
  assert.equal(cmd[2], 'ass-events');
  assert.equal(cmd[4], 1280, '虚拟画布的宽高原样交给 mpv，弹幕才和排布算出来的位置对得上');
  assert.equal(cmd[5], 720);
  assert.notEqual(OVERLAY_DANMAKU, OVERLAY_ROOM, '弹幕和横幅必须分层，否则互相覆盖');
});

test('暂停和跳转在途时不发弹幕帧', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ctl, commands, replyAll } = fakeController();

  const paused = ctl.setPause(true);
  assert.equal(ctl.setDanmakuFrame(frameOf(oneItem())), false, '暂停在途时弹幕要让路');
  assert.equal(commands().length, 1, '只写出了那条 set_property');
  replyAll();
  await paused;
  assert.equal(ctl.setDanmakuFrame(frameOf(oneItem())), true);

  replyAll();
  await flush();
  const seeking = ctl.seek(120);
  assert.equal(ctl.setDanmakuFrame(frameOf(oneItem())), false, '跳转在途时同样让路');
  replyAll();
  await seeking;
  assert.equal(ctl.setDanmakuFrame(frameOf(oneItem())), true);

  // 失败的命令也要把闸放开，否则一次超时之后弹幕再也不出现
  replyAll();
  await flush();
  const failing = ctl.setPause(false);
  ctl._failAllPending(new Error('断了'));
  await failing.then(
    () => {},
    () => {}
  );
  assert.equal(ctl.setDanmakuFrame(frameOf(oneItem())), true, '命令失败后弹幕要恢复');
});

test('没有弹幕时清空覆盖层，而且只清一次', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ctl, commands, replyAll } = fakeController();

  assert.equal(ctl.setDanmakuFrame(frameOf([])), false, '本来就是空的，不用发命令');
  assert.equal(commands().length, 0);

  ctl.setDanmakuFrame(frameOf(oneItem()));
  replyAll();
  await flush();
  assert.equal(ctl.setDanmakuFrame(frameOf([])), true);
  assert.deepEqual(commands()[1], ['osd-overlay', OVERLAY_DANMAKU, 'none', '']);
  assert.equal(ctl.setDanmakuFrame(frameOf([])), false, '已经清过了就别每帧都发一条 none');
  assert.equal(commands().length, 2);
});

test('清空不受「一帧在途」约束 —— 关掉弹幕时最后一屏字不能留在画面上', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ctl, commands } = fakeController();
  ctl.setDanmakuFrame(frameOf(oneItem()));
  // 上一帧还在途（用户正好这时候关掉了弹幕）：清空照样发得出去
  assert.equal(ctl.setDanmakuFrame(frameOf([])), true);
  assert.deepEqual(commands()[1], ['osd-overlay', OVERLAY_DANMAKU, 'none', '']);
});

test('弹幕帧不进横幅那张去重表', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ctl, commands, replyAll } = fakeController();
  ctl.setDanmakuFrame(frameOf(oneItem()));
  assert.equal(ctl._overlays.size, 0, '每帧坐标都不一样，进去只会白占内存');
  replyAll();
  await flush();

  // 同一份文本连发两帧也要真发两次：坐标变了，去重会让弹幕卡住不动
  ctl.setDanmakuFrame(frameOf(oneItem()));
  replyAll();
  await flush();
  ctl.setDanmakuFrame(frameOf(oneItem()));
  assert.equal(commands().filter((c) => c[1] === OVERLAY_DANMAKU).length, 3);

  // 横幅那条路照旧去重
  ctl.setOverlay(OVERLAY_ROOM, '在等小明');
  ctl.setOverlay(OVERLAY_ROOM, '在等小明');
  assert.equal(commands().filter((c) => c[1] === OVERLAY_ROOM).length, 1);
});

test('没连上播放器时弹幕帧直接丢掉，不抛错', () => {
  const ctl = new MpvController();
  assert.equal(ctl.setDanmakuFrame(frameOf(oneItem())), false);
  assert.equal(ctl.clearDanmaku(), false);
});

test('换了一代播放器，上一代路上的弹幕帧不许画到新播放器上', async () => {
  const made = [];
  class FakeAdapter extends EventEmitter {
    constructor() {
      super();
      this.caps = {};
      this.frames = [];
      made.push(this);
    }
    async launch() {
      return { bin: 'fake' };
    }
    setDanmakuFrame(frame) {
      this.frames.push(frame);
      return true;
    }
    snapshot() {
      return { running: true };
    }
    async quit() {}
  }
  const sent = [];
  const mgr = new PlayerManager({ send: (ch, p) => sent.push([ch, p]), adapters: { fake: FakeAdapter } });

  const first = await mgr.launch('fake', {});
  const second = await mgr.launch('fake', {});
  assert.notEqual(first.gen, second.gen);
  assert.equal(mgr.setDanmakuFrame(frameOf(oneItem(), { gen: first.gen })), false, '上一代的帧要丢掉');
  assert.equal(made[0].frames.length, 0);
  assert.equal(mgr.setDanmakuFrame(frameOf(oneItem(), { gen: second.gen })), true);
  assert.equal(made[1].frames.length, 1);
  // 不带代号就画给当前这一代
  assert.equal(mgr.setDanmakuFrame(frameOf(oneItem())), true);
  assert.equal(made[1].frames.length, 2);

  // 播放器关掉之后照样不抛错，只是丢帧
  await mgr.quit();
  assert.equal(mgr.setDanmakuFrame(frameOf(oneItem())), false);

  // 适配器不支持弹幕（P6 的外部播放器靠覆盖窗画）也当丢帧处理
  class NoDanmaku extends FakeAdapter {}
  NoDanmaku.prototype.setDanmakuFrame = undefined;
  const mgr2 = new PlayerManager({ send: () => {}, adapters: { fake: NoDanmaku } });
  await mgr2.launch('fake', {});
  assert.equal(mgr2.setDanmakuFrame(frameOf(oneItem())), false);
});

test('重开播放器时弹幕层的状态跟着清零', () => {
  const src = read('src', 'main', 'mpv.js');
  // 拉起和退出两处都要清：新进程身上没有覆盖层，visible 不清零就再也不会重画
  assert.equal(src.split('this._resetDanmaku();').length - 1, 2, '拉起和退出各一处');
  const launch = src.slice(src.indexOf('this.proc = spawn('), src.indexOf('await this._connectWithRetry'));
  assert.match(launch, /this\.forgetOverlays\(\);\s*[\r\n]+\s*this\._resetDanmaku\(\);/);
  const exit = src.slice(src.indexOf("this.proc.on('exit'"), src.indexOf("this.proc.on('error'"));
  assert.match(exit, /this\.forgetOverlays\(\);\s*[\r\n]+\s*this\._resetDanmaku\(\);/);
});

/* ---------------------------- 播放器内发弹幕 ---------------------------- */

test('mpv 里按快捷键发的弹幕经 client-message 上来，并按聊天上限截断', () => {
  const ctl = new MpvController();
  const got = [];
  ctl.on('chat-input', (p) => got.push(p));
  const feed = (args) => ctl._onData(JSON.stringify({ event: 'client-message', args }) + NEWLINE);

  feed([CHAT_MESSAGE_NAME, '这片子好看']);
  assert.deepEqual(got, [{ text: '这片子好看' }]);

  feed([CHAT_MESSAGE_NAME, '字'.repeat(MAX_DANMAKU_TEXT + 80)]);
  assert.equal([...got[1].text].length, MAX_DANMAKU_TEXT, '截断这一刀由主进程落，不能只指望脚本');

  feed([CHAT_MESSAGE_NAME, '🎬'.repeat(MAX_DANMAKU_TEXT + 10)]);
  assert.equal([...got[2].text].every((ch) => ch === '🎬'), true);

  // 别的脚本发的消息、畸形参数一律不认
  feed(['some-other-script', '别人的消息']);
  feed([CHAT_MESSAGE_NAME]);
  feed([CHAT_MESSAGE_NAME, { text: 'x' }]);
  feed([CHAT_MESSAGE_NAME, '']);
  feed(null);
  assert.equal(got.length, 3);
});

test('播放器内发的弹幕按代际转给渲染进程', async () => {
  const made = [];
  class FakeAdapter extends EventEmitter {
    constructor() {
      super();
      this.caps = {};
      made.push(this);
    }
    async launch() {
      return { bin: 'fake' };
    }
    async quit() {}
  }
  const sent = [];
  const mgr = new PlayerManager({ send: (ch, p) => sent.push([ch, p]), adapters: { fake: FakeAdapter } });
  const info = await mgr.launch('fake', {});
  made[0].emit('chat-input', { text: '哈哈' });
  assert.deepEqual(sent.at(-1), ['player:chat-input', { text: '哈哈', gen: info.gen, kind: 'fake' }]);

  // 上一代退出途中迟到的一条不能再转发：那是上一部片的弹幕
  await mgr.launch('fake', {});
  sent.length = 0;
  made[0].emit('chat-input', { text: '迟到的' });
  assert.deepEqual(sent, []);
});

test('Lua 脚本注册 Ctrl+Shift+D，旧版 mpv 上静默不生效', () => {
  const lua = read('resources', 'mpv-scripts', CHAT_SCRIPT_FILE);
  // Ctrl+Enter 被 PotPlayer 和 MPC-BE 占了，三个播放器统一成 Ctrl+Shift+D
  assert.match(lua, /Ctrl\+Shift\+d/i);
  assert.doesNotMatch(lua, /Ctrl\+Enter'/i, '别把被占用的键位又绑回来');
  assert.match(lua, /mp\.add_key_binding\(/);
  // 同一个组合键在 mpv 里可能报成三种写法，三种都要注册，否则按了没反应
  const keys = lua.slice(lua.indexOf('BINDING_KEYS = {'), lua.indexOf('}', lua.indexOf('BINDING_KEYS = {')));
  for (const key of ["'Ctrl+Shift+d'", "'Ctrl+Shift+D'", "'Ctrl+D'"]) {
    assert.ok(keys.includes(key), '少注册了一种写法：' + key);
  }
  // 发送走 script-message，名字两端必须一致
  assert.ok(lua.includes("mp.commandv('script-message', MESSAGE_NAME"));
  assert.ok(lua.includes("MESSAGE_NAME = '" + CHAT_MESSAGE_NAME + "'"), '脚本和主进程约的是同一个消息名');
  // 0.38 以下没有 mp.input：探测失败就直接 return，一个按键都不注册
  assert.ok(lua.includes("pcall(require, 'mp.input')"));
  const guardAt = lua.indexOf('if not ok or type(input)');
  assert.ok(guardAt > 0, '没有版本探测');
  // 「同步到房主」那个键不需要 mp.input，特意注册在探测前面（见下一条测试）；弹幕键必须在探测之后
  assert.ok(guardAt < lua.indexOf('mp.add_key_binding(key, MESSAGE_NAME'), '探测必须在注册弹幕按键之前');
  assert.match(lua.slice(guardAt, lua.indexOf('\n', lua.indexOf('end', guardAt))), /return/);
  // 字数上限和聊天那边同一个数
  assert.ok(lua.includes('MAX_TEXT = ' + MAX_DANMAKU_TEXT));
});

test('主进程和 lib/chat.js 对「一条弹幕最长多少」是同一个数', async () => {
  const chat = await import('../src/renderer/lib/chat.js');
  assert.equal(MAX_DANMAKU_TEXT, chat.MAX_TEXT, '两边对不上，要么白截一刀、要么把合法消息截没了');
});

/* ---------------------------- 脚本路径与启动参数 ---------------------------- */

test('Lua 脚本先找打包资源目录，再找源码树', () => {
  const packed = chatScriptCandidates({
    resourcesPath: 'C:\\App\\resources',
    dirname: 'C:\\App\\resources\\app\\src\\main',
  });
  assert.equal(packed[0], path.join('C:\\App\\resources', 'mpv-scripts', CHAT_SCRIPT_FILE));
  assert.equal(packed.length, 2);

  // 开发机上 process.resourcesPath 是 undefined，不能凭空造出一条 undefined 路径
  const dev = chatScriptCandidates({ resourcesPath: undefined, dirname: 'H:\\dev\\noxreel\\src\\main' });
  assert.equal(dev.length, 1);
  assert.equal(dev[0], path.join('H:\\dev\\noxreel', 'resources', 'mpv-scripts', CHAT_SCRIPT_FILE));
  assert.ok(!dev.some((p) => p.includes('undefined')));

  // 仓库里这一份真的找得到
  assert.equal(findChatScript(), path.join(root, 'resources', 'mpv-scripts', CHAT_SCRIPT_FILE));
  assert.equal(findChatScript({ resourcesPath: undefined, dirname: 'C:\\nowhere\\src\\main' }), null);
});

test('--script= 只有这一条绝对路径，--load-scripts=no 还在', () => {
  const base = { ipcPath: 'p', source: 'C:/x.mkv' };
  const abs = 'C:\\App\\resources\\mpv-scripts\\' + CHAT_SCRIPT_FILE;
  const scriptArgs = (args) => args.filter((a) => a.startsWith('--script='));

  const args = buildLaunchArgs({ ...base, chatScript: abs });
  assert.deepEqual(scriptArgs(args), ['--script=' + abs]);
  assert.ok(args.includes('--load-scripts=no'), '用户配置目录里的脚本一个都不许自动加载');
  assert.ok(args.indexOf('--script=' + abs) < args.indexOf('--'), '参数要排在 -- 前面');
  assert.equal(args.at(-1), 'C:/x.mkv');

  // 在线链接那条分支也一样
  const remote = buildLaunchArgs({ ...base, source: 'https://example.com/a.mp4', chatScript: abs });
  assert.deepEqual(scriptArgs(remote), ['--script=' + abs]);
  assert.ok(remote.includes('--load-scripts=no'));

  // 没找到脚本、或者拿到的不是绝对路径：一条都不加
  assert.deepEqual(scriptArgs(buildLaunchArgs(base)), []);
  assert.deepEqual(scriptArgs(buildLaunchArgs({ ...base, chatScript: null })), []);
  assert.deepEqual(scriptArgs(buildLaunchArgs({ ...base, chatScript: CHAT_SCRIPT_FILE })), []);
  assert.deepEqual(scriptArgs(buildLaunchArgs({ ...base, chatScript: '../../evil.lua' })), []);
});

test('输入框的提示语按界面语言从渲染进程传下来', () => {
  const base = { ipcPath: 'p', source: 'C:/x.mkv' };
  const abs = 'C:\\App\\mpv-scripts\\' + CHAT_SCRIPT_FILE;
  const opt = (args) => args.filter((a) => a.startsWith('--script-opt=noxreel_chat-'));

  assert.deepEqual(opt(buildLaunchArgs({ ...base, chatScript: abs, chatPrompt: 'Danmaku:' })), [
    '--script-opt=noxreel_chat-prompt=Danmaku:',
  ]);
  // 没给就用脚本自带的默认值，不塞一条空的进去
  assert.deepEqual(opt(buildLaunchArgs({ ...base, chatScript: abs })), []);
  // 脚本都没加载，提示语更没有意义
  assert.deepEqual(opt(buildLaunchArgs({ ...base, chatPrompt: 'Danmaku:' })), []);
});

/* -------------------------------- 接线检查 -------------------------------- */

test('弹幕帧的 IPC 校验在主进程，渲染进程只递数据', () => {
  const main = read('src', 'main', 'main.js');
  const preload = read('src', 'main', 'preload.js');
  assert.match(main, /secureHandle\('player:setDanmakuFrame'/);
  assert.match(main, /players\.setDanmakuFrame\(validate\.danmakuFrame\(frame\)\)/, '这条通道必须过校验');
  assert.match(preload, /'player:setDanmakuFrame'/);
  assert.match(preload, /onChatInput: on\('player:chat-input'\)/);
  // 层 id 由主进程定，和横幅一样不从渲染进程来
  assert.doesNotMatch(main, /OVERLAY_DANMAKU/);
  assert.doesNotMatch(preload, /osd-overlay/);

  // 启动时的提示语要过校验才进命令行
  assert.match(main, /validate\.scriptOptValue\(chatPrompt/);
  assert.match(main, /chatPrompt: prompt/);
});

test('mpv 适配器把弹幕帧和播放器内输入接到控制器上', () => {
  const { MpvAdapter } = require('../src/main/players/mpvAdapter');
  const adapter = new MpvAdapter();
  const got = [];
  adapter.on('chat-input', (payload) => got.push(payload));
  adapter.ctl.emit('chat-input', { text: '在播放器里发的' });
  assert.deepEqual(got, [{ text: '在播放器里发的' }], '控制器收到的弹幕没往上传');

  let seen = null;
  adapter.ctl.setDanmakuFrame = (frame) => {
    seen = frame;
    return true;
  };
  assert.equal(adapter.setDanmakuFrame(frameOf(oneItem())), true);
  assert.equal(seen.items.length, 1);
  assert.equal(adapter.caps.danmaku, 'native', 'mpv 自己就能画，不用覆盖窗');
});

test('适配器一层只做转发，播放器种类的差别不漏到主进程', () => {
  const adapter = read('src', 'main', 'players', 'mpvAdapter.js');
  const manager = read('src', 'main', 'players', 'index.js');
  assert.match(adapter, /setDanmakuFrame\(frame\)\s*\{\s*[\r\n]+\s*return this\.ctl\.setDanmakuFrame\(frame\);/);
  assert.match(adapter, /this\.ctl\.on\('chat-input'/);
  assert.match(manager, /adapter\.on\(\s*[\r\n]+\s*'chat-input',\s*[\r\n]+\s*fromCurrent\(/);
  assert.match(manager, /setDanmakuFrame\(frame\)/);
});
