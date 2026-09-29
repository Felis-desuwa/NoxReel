'use strict';

// NoxReel 自己画的 mpv 控制条（resources/mpv-scripts/noxreel-osc.lua）和它两头的接线
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const {
  MpvController,
  buildLaunchArgs,
  oscScriptCandidates,
  findOscScript,
  oscFont,
  OSC_CLIENT_NAME,
  OSC_STATUS_PROP,
  OVERLAY_ROOM,
  childEnv,
} = require('../src/main/mpv');
const vm = require('node:vm');
const validate = require('../src/main/security');

const REPO = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(REPO, ...parts), 'utf8').replace(/\r\n/g, '\n');
const OSC_ABS = path.join(REPO, 'resources', 'mpv-scripts', 'noxreel-osc.lua');

function fakeController() {
  const ctl = new MpvController();
  const sent = [];
  ctl.sock = {
    destroyed: false,
    write(line, cb) {
      sent.push(JSON.parse(line));
      if (cb) cb();
    },
  };
  const commands = () => sent.map((m) => m.command);
  const fromOsc = (...args) => ctl._onData(JSON.stringify({ event: 'client-message', args: ['noxreel-osc', ...args] }) + '\n');
  return { ctl, sent, commands, fromOsc };
}

test('启动参数：找得到控制条脚本就关掉自带的、带上脚本和字体；自带的配色参数照旧带着（退回时用）', () => {
  const own = buildLaunchArgs({ ipcPath: 'x', source: 'D:/a.mkv', oscScript: OSC_ABS });
  assert.ok(own.includes('--osc=no'));
  assert.ok(!own.includes('--osc=yes'));
  assert.ok(own.includes(`--script=${OSC_ABS}`));
  assert.ok(own.includes(`--script-opt=noxreel_osc-font=${oscFont()}`));
  assert.ok(own.includes('--script-opt=osc-layout=bottombar'), '退回自带控制条时还是这套样子');
  assert.ok(own.indexOf(`--script=${OSC_ABS}`) < own.indexOf('--'));

  // 相对路径不认（--load-scripts=no 还在，能进来的只有我们自己的绝对路径）；没有脚本就是自带的
  for (const oscScript of [null, 'noxreel-osc.lua']) {
    const stock = buildLaunchArgs({ ipcPath: 'x', source: 'D:/a.mkv', oscScript });
    assert.ok(stock.includes('--osc=yes'));
    assert.ok(!stock.some((a) => a.includes('noxreel-osc')));
  }
  assert.equal(oscFont('win32'), 'Microsoft YaHei UI');
  assert.equal(oscFont('darwin'), 'PingFang SC');
});

test('脚本随安装包发出去，开发时和打包后都找得到', () => {
  const pkg = JSON.parse(read('package.json'));
  const entry = pkg.build.extraResources.find((r) => r.from === 'resources/mpv-scripts');
  assert.ok(entry.filter.includes('noxreel-osc.lua'));
  assert.deepEqual(oscScriptCandidates({ resourcesPath: 'R:/res', dirname: 'D:/app/src/main' }), [
    path.join('R:/res', 'mpv-scripts', 'noxreel-osc.lua'),
    path.join('D:/app/src/main', '..', '..', 'resources', 'mpv-scripts', 'noxreel-osc.lua'),
  ]);
  assert.equal(findOscScript({ resourcesPath: null }), OSC_ABS);
  assert.match(read('src', 'main', 'mpv.js'), /oscScript: findOscScript\(\),/);
});

test('控制条报 ready 之前：提示走 show-text、横幅画在覆盖层上、状态先攒着', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ctl, commands } = fakeController();
  ctl.osd('已同步到房主的进度', 2000, 'ok');
  ctl.setRoomBanner('全员暂停中 —— 在等 小林 把缓冲攒够');
  ctl.setOscState({ title: '雨夜来信' });
  const cmds = commands();
  assert.deepEqual(cmds[0], ['show-text', '已同步到房主的进度', 2000, 0], '级别 0：控制条关了自带 OSD 文字时照样显示');
  assert.equal(cmds[1][0], 'osd-overlay');
  assert.equal(cmds[1][1], OVERLAY_ROOM);
  assert.equal(cmds.length, 2, '状态没发：脚本还没起来');
});

test('报了 ready：补发攒着的状态、擦掉覆盖层上的横幅；之后提示画成提示条、横幅不再画、状态没变不重发', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ctl, commands, fromOsc } = fakeController();
  const actions = [];
  ctl.on('osc-action', (a) => actions.push(a));
  ctl.setRoomBanner('在等小林');
  ctl.setOscState({ title: '雨夜来信' });
  fromOsc('ready');
  assert.equal(ctl.oscReady, true);
  assert.deepEqual(actions, [{ action: 'ready' }]);
  const after = commands().slice(1);
  assert.deepEqual(after[0], ['osd-overlay', OVERLAY_ROOM, 'none', '']);
  assert.deepEqual(after[1], ['script-message-to', OSC_CLIENT_NAME, 'noxreel-state', JSON.stringify({ title: '雨夜来信' })]);

  const before = commands().length;
  ctl.setOscState({ title: '雨夜来信' });
  ctl.setRoomBanner('在等阿杰');
  assert.equal(commands().length, before, '同样的状态不重发，横幅由控制条的卡片代替');

  ctl.osd('未经本机扫描 · 请自行确认片源', 4000, 'warn');
  ctl.osd('普通的一句', 2000, 'bogus');
  assert.deepEqual(commands().slice(-2), [
    ['script-message-to', OSC_CLIENT_NAME, 'noxreel-toast', '未经本机扫描 · 请自行确认片源', '4000', 'warn'],
    ['script-message-to', OSC_CLIENT_NAME, 'noxreel-toast', '普通的一句', '2000', 'info'],
  ]);
});

test('控制条的状态也从属性报上来（管道连上之前那一声广播收不到）：不进 tick，重复的 ready 只认一次', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const { ctl, commands } = fakeController();
  const actions = [];
  let ticks = 0;
  ctl.on('osc-action', (a) => actions.push(a));
  ctl.on('tick', () => ticks++);
  ctl.setOscState({ title: 'x' });
  ctl._subscribe();
  assert.ok(commands().some((c) => c[0] === 'observe_property' && c[2] === OSC_STATUS_PROP), '连上就订阅这个属性');
  const prop = (data) => ctl._onData(JSON.stringify({ event: 'property-change', name: OSC_STATUS_PROP, data }) + '\n');
  prop(null);
  assert.equal(ctl.oscReady, false, '脚本还没写的时候推来的是空值');
  prop('ready');
  assert.equal(ctl.oscReady, true);
  ctl._onData(JSON.stringify({ event: 'client-message', args: ['noxreel-osc', 'ready'] }) + '\n');
  assert.deepEqual(actions, [{ action: 'ready' }], '属性和广播都报了 ready，只认一次');
  assert.equal(commands().filter((c) => c[2] === 'noxreel-state').length, 1, '状态只补发一次');
  t.mock.timers.runAll();
  assert.equal(ticks, 0, '控制条状态不算播放器 tick');
  prop('fallback');
  prop('fallback');
  assert.equal(ctl.oscReady, false);
  assert.deepEqual(actions.at(-1), { action: 'fallback' });
  assert.equal(actions.filter((a) => a.action === 'fallback').length, 1);
});

test('控制条退回自带的：横幅补画回覆盖层，提示改回 show-text', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ctl, commands, fromOsc } = fakeController();
  fromOsc('ready');
  ctl.setRoomBanner('在等小林');
  fromOsc('fallback');
  assert.equal(ctl.oscReady, false);
  const overlay = commands().find((c) => c[0] === 'osd-overlay');
  assert.equal(overlay[1], OVERLAY_ROOM);
  assert.match(overlay[3], /在等小林/);
  ctl.osd('一句', 1000);
  assert.deepEqual(commands().at(-1), ['show-text', '一句', 1000, 0]);
});

test('控制条上点的按钮：只认弹幕开关和清晰度（0 或 144–4320 的整数），别的不往外转', () => {
  const { ctl, fromOsc } = fakeController();
  const actions = [];
  ctl.on('osc-action', (a) => actions.push(a));
  fromOsc('danmaku');
  fromOsc('quality', '720');
  fromOsc('quality', '0');
  fromOsc('quality', '99999');
  fromOsc('quality', '7.5');
  fromOsc('quality', 'abc');
  fromOsc('rm -rf');
  assert.deepEqual(actions, [{ action: 'danmaku' }, { action: 'quality', value: 720 }, { action: 'quality', value: 0 }]);
});

test('长按 → 的 2 倍速：主进程转出开始 / 松手（带位置）/ 换片收尾；渲染进程松手时由控制者把全房带过来', () => {
  const { ctl, fromOsc } = fakeController();
  const actions = [];
  ctl.on('osc-action', (a) => actions.push(a));
  fromOsc('speed-hold', 'start');
  fromOsc('speed-hold', 'end', '1234.500');
  fromOsc('speed-hold', 'end', '');
  fromOsc('speed-hold', 'end', '-3');
  fromOsc('speed-hold', 'cancel');
  fromOsc('speed-hold', 'bogus');
  assert.deepEqual(actions, [
    { action: 'speed-hold', value: 'start' },
    { action: 'speed-hold', value: 'end', position: 1234.5 },
    { action: 'speed-hold', value: 'end', position: null },
    { action: 'speed-hold', value: 'end', position: null },
    { action: 'speed-hold', value: 'cancel' },
  ]);
  const app = read('src', 'renderer', 'app.js');
  assert.match(app, /S\.speedHold = payload\.value === 'start';\n\s+if \(payload\.value === 'end' && roomEntered && Number\.isFinite\(payload\.position\) && S\.sync\?\.canIControl\(\)\) \{\n\s+S\.sync\.userSeek\(payload\.position\);/);
  // 快进中不做在线视频的自动对齐，不然两秒后就被拽回去
  assert.match(app, /\|\| S\.speedHold\) return;\n\s+S\.sync\.checkDrift\(\);/);
  // 发弹幕的 D 在聊天脚本里，和 Ctrl+Shift+D 同一个输入框
  const chat = read('resources', 'mpv-scripts', 'noxreel-chat.lua');
  assert.match(chat, /local BINDING_KEYS = \{ 'Ctrl\+Shift\+d', 'Ctrl\+Shift\+D', 'Ctrl\+D', 'd' \}/);
  // 退回自带控制条时我们改过的键位全摘掉，mpv 自带的原样回来
  const lua = read('resources', 'mpv-scripts', 'noxreel-osc.lua');
  assert.match(lua, /for _, name in ipairs\(bound_keys\) do pcall\(mp\.remove_key_binding, name\) end/);
  assert.match(lua, /local function bind\(key, name, fn, flags\)\n\s+bound_keys\[#bound_keys \+ 1\] = name/);
});

test('新起的播放器：控制条回到「还没 ready」，状态要重推', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ctl, fromOsc, commands } = fakeController();
  fromOsc('ready');
  ctl.setOscState({ title: 'a' });
  ctl._resetOsc();
  assert.equal(ctl.oscReady, false);
  const n = commands().length;
  ctl.setOscState({ title: 'a' });
  assert.equal(commands().length, n, '还没 ready 不发');
  fromOsc('ready');
  assert.deepEqual(commands().at(-1), ['script-message-to', OSC_CLIENT_NAME, 'noxreel-state', JSON.stringify({ title: 'a' })]);
  assert.match(read('src', 'main', 'mpv.js'), /this\._resetDanmaku\(\);\n\s+\/\/ 新进程里的控制条还没报「画得出来」，状态也得重新推给它\n\s+this\._resetOsc\(\);/);
});

const GOOD_STATE = {
  title: '雨夜来信',
  subtitle: '周五放映厅 · 第 3 / 5 部',
  chip: { tone: 'sync', text: '同步中 · 4 人在看' },
  ranges: [
    [0, 0.61],
    [0.66, 0.74],
  ],
  danmaku: true,
  canSeek: true,
  stall: { title: '等待 小林 缓冲', sub: '全员暂停中', progress: 0.41, left: '已缓冲 6.2 / 15 秒', right: '约 12 秒后继续', note: '不用操作' },
  drift: { text: '你比房主慢 38 秒', button: '同步到房主', key: 'Ctrl+Shift+S' },
  host: { pos: 2330.5, playing: true },
  quality: { current: 1080, label: '1080P', options: [{ h: 0, label: '最高（自动）' }, { h: 1080, label: '1080P' }] },
  labels: { play: '播放', host: '房主' },
};

test('状态校验：认得的字段原样留下，多出来的扔掉', () => {
  const out = validate.oscState({ ...GOOD_STATE, evil: '{\\an7}', chip: { ...GOOD_STATE.chip, extra: 1 } });
  assert.deepEqual(out, GOOD_STATE);
  assert.deepEqual(validate.oscState({}), { title: undefined, subtitle: undefined, canSeek: true });
  assert.equal(validate.oscState({ canSeek: false }).canSeek, false);
});

test('状态校验：形状不对、量太大的一律拒', () => {
  const bad = [
    null,
    [],
    { chip: { tone: 'evil', text: 'x' } },
    { chip: { tone: 'sync', text: 'x'.repeat(121) } },
    { title: 'x'.repeat(301) },
    { ranges: Array.from({ length: 65 }, () => [0, 1]) },
    { ranges: [[0.5, 0.2]] },
    { ranges: [[0, 2]] },
    { ranges: [[0]] },
    { danmaku: 'yes' },
    { stall: { title: 'x', progress: 2 } },
    { stall: { sub: '没有标题' } },
    { host: { pos: 10, playing: 'yes' } },
    { host: { pos: -1, playing: true } },
    { quality: { current: 1080, options: [] } },
    { quality: { current: 99999, options: [{ h: 1080, label: '1080P' }] } },
    { quality: { current: 1080, options: Array.from({ length: 17 }, () => ({ h: 720, label: '720P' })) } },
    { labels: { 'bad key': 'x' } },
    { labels: { play: 'x'.repeat(81) } },
    { labels: Object.fromEntries(Array.from({ length: 97 }, (_, i) => [`k${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`, 'x'])) },
  ];
  for (const value of bad) assert.throws(() => validate.oscState(value), TypeError, JSON.stringify(value)?.slice(0, 80));
});

test('接线：主进程校验后交给播放器；PlayerManager 只转当前这一代的按钮；preload 暴露两头', () => {
  const main = read('src', 'main', 'main.js');
  assert.match(main, /secureHandle\('player:oscState', async \(state\) => players\.setOscState\(validate\.oscState\(state\)\)\);/);
  assert.match(main, /tone === 'ok' \|\| tone === 'warn' \? tone : 'info'/);
  const players = read('src', 'main', 'players', 'index.js');
  assert.match(players, /'osc-action',\n\s+fromCurrent\(\(payload\) => this\.send\('player:osc-action', \{ \.\.\.payload, gen, kind \}\)\)/);
  assert.match(players, /typeof adapter\.setOscState === 'function'/);
  const adapter = read('src', 'main', 'players', 'mpvAdapter.js');
  assert.match(adapter, /this\.ctl\.on\('osc-action', \(payload\) => this\.emit\('osc-action', payload\)\);/);
  const preload = read('src', 'main', 'preload.js');
  assert.match(preload, /oscState: \(state\) => ipcRenderer\.invoke\('player:oscState', state\),/);
  assert.match(preload, /onOscAction: on\('player:osc-action'\),/);
  assert.match(preload, /osd: \(text, duration = 2000, tone = 'info'\) => ipcRenderer\.invoke\('player:osd', \{ text, duration, tone \}\),/);
});

test('渲染进程：每次 renderStatus 都推（攒一小会儿、没变不发）；按钮回来的弹幕开关、清晰度走和房间窗口同一条路', () => {
  const app = read('src', 'renderer', 'app.js');
  assert.match(app, /updatePresence\(\);\n\s+\/\/ mpv 控制条上的房间状态同理：攒一小会儿、没变就不发\n\s+scheduleOscState\(\);\n\}/);
  assert.match(app, /if \(action === 'danmaku'\) setDanmakuEnabled\(S\.danmakuSettings\.enabled === false\);\n(\s+\/\/[^\n]*\n)?\s+else if \(action === 'quality' && !S\.switchingPlayer\) setLinkQuality\(payload\.value\);/);
  // 新播放器、退掉的播放器：去重缓存和 ready 一起清
  assert.ok(app.split('forgetMpvOsc();').length - 1 >= 4);
  // 控制条顶上常驻差开提示，一分钟一次的那句就不发了
  assert.match(app, /if \(!mpvOscReady\) window\.sw\.player\.osd\(/);
});

test('渲染进程推之前先按主进程的上限截短：等好几个长昵称的人时卡片标题超长，也不会让整路状态被拒', () => {
  const app = read('src', 'renderer', 'app.js');
  const fn = (name) => {
    const at = app.indexOf(`function ${name}(`);
    const open = app.indexOf('{', app.indexOf(')', at));
    let depth = 0;
    for (let i = open; i < app.length; i++) {
      if (app[i] === '{') depth++;
      else if (app[i] === '}' && --depth === 0) return app.slice(at, i + 1);
    }
    throw new Error(name);
  };
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext([fn('clipText'), fn('clipOscState')].join('\n'), ctx);
  const long = (n) => '长昵称😀'.repeat(n);
  const state = ctx.clipOscState({
    title: long(200),
    subtitle: long(200),
    chip: { tone: 'wait', text: long(60) },
    stall: { title: `等待 ${long(80)} 缓冲`, sub: long(90), left: long(40), right: long(40), note: long(90), progress: 0.5 },
    drift: { text: long(60), button: long(20), key: 'Ctrl+Shift+S' },
    quality: { current: 0, label: long(20), options: [{ h: 0, label: long(20) }] },
    labels: { play: long(50) },
    canSeek: true,
  });
  assert.doesNotThrow(() => validate.oscState(JSON.parse(JSON.stringify(state))));
  assert.ok(state.stall.title.endsWith('…'));
  assert.ok(!/[\uD800-\uDBFF]…$/.test(state.title), 'emoji 不被劈成半个');
  assert.equal(ctx.clipText('短的', 10), '短的');
  // 接线：状态经它截过才推
  assert.match(app, /return clipOscState\(\{\n\s+title: currentTitle\(\),/);
});

test('按钮报上来的动作只认当前这一代；正在换播放器时点清晰度不收', () => {
  const app = read('src', 'renderer', 'app.js');
  assert.match(app, /if \(playerGate\.gen !== null && Number\.isInteger\(payload\?\.gen\) && payload\.gen !== playerGate\.gen\) return;/);
  assert.match(app, /else if \(action === 'quality' && !S\.switchingPlayer\) setLinkQuality\(payload\.value\);/);
  // 房间窗口里开关弹幕，控制条上的按钮跟着变；全员暂停时不再叠一条和卡片一样的提示
  assert.match(app, /S\.danmaku\.setEnabled\(next\.enabled !== false\);\n\s+\/\/ mpv 控制条上的「弹」按钮跟着变[^\n]*\n\s+scheduleOscState\(\);/);
  assert.match(app, /if \(!mpvOscReady\) window\.sw\.player\.osd\(guestSelf \?/);
});

test('「已收到」的分段：按位图连成段、超了就合并最窄的缝、末片按文件大小封顶', async () => {
  const { haveRanges, MAX_OSC_RANGES } = await import(pathToFileURL(path.join(REPO, 'src', 'renderer', 'lib', 'oscState.js')).href);
  const meta = { size: 950, chunkSize: 100, chunkCount: 10 };
  assert.deepEqual(haveRanges([1, 1, 0, 1, 1, 1, 0, 0, 1, 1], meta), [
    [0, 0.2105],
    [0.3158, 0.6316],
    [0.8421, 1],
  ]);
  assert.deepEqual(haveRanges([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], meta), []);
  assert.deepEqual(haveRanges(null, meta), []);
  // 缝宽 1 的和缝宽 3 的：只能留 2 段时先合并窄的那条
  const have = [1, 0, 1, 0, 0, 0, 1, 1, 1, 1];
  assert.deepEqual(haveRanges(have, meta, 2), [
    [0, 0.3158],
    [0.6316, 1],
  ]);
  // 一片隔一片：缝一样宽，合完还超就把尾巴并成一段，段数一定不超
  const many = Array.from({ length: 1000 }, (_, i) => (i % 2 === 0 ? 1 : 0));
  const out = haveRanges(many, { size: 100_000, chunkSize: 100, chunkCount: 1000 });
  assert.ok(out.length <= MAX_OSC_RANGES);
  assert.equal(out[0][0], 0);
  assert.equal(out.at(-1)[1], 0.999);
});

test('新文案都有英文（控制条的按钮、房间状态、等待卡片）', async () => {
  const { translate } = await import(pathToFileURL(path.join(REPO, 'src', 'renderer', 'lib', 'i18n.js')).href);
  const app = read('src', 'renderer', 'app.js');
  const block = app.slice(app.indexOf('const OSC_LABEL_TEXT = {'), app.indexOf('let oscLabelsCache'));
  const labels = [...block.matchAll(/: '([^']+)',/g)].map((m) => m[1]);
  assert.ok(labels.length >= 25);
  const statics = [
    ...labels,
    '同步中', '等人缓冲', '缓冲中', '没对上', '独立观看', '房间', '最高（自动）', '在线视频',
    '全员暂停中，缓冲够了就一起继续', '不用操作，缓冲够了会自动开始', '缓冲不足，只暂停你自己', '房间照常播放', '缓冲够了会自动接着放',
  ];
  for (const zh of statics) assert.doesNotMatch(translate(zh, 'en'), /[一-鿿]/, zh);
  assert.equal(translate('4 人在看', 'en'), '4 watching');
  assert.equal(translate('等待 小林、你 缓冲', 'en'), 'Waiting for 小林, you to buffer');
  assert.equal(translate('已缓冲 6.2 / 15 秒', 'en'), 'Buffered 6.2 / 15 s');
  assert.equal(translate('约 0:12 后继续', 'en'), 'Resuming in about 0:12');
});

test('Lua 脚本：拼进 ASS 的字先丢掉花括号和反斜杠；认 NoxReel 推来的状态和提示；画不出来退回自带控制条', () => {
  const lua = read('resources', 'mpv-scripts', 'noxreel-osc.lua');
  assert.match(lua, /s = s:gsub\('\[\\\\\{\}\]', ''\)/, '和主进程 escapeAss 同一个做法：丢掉，不转义');
  assert.match(lua, /mp\.register_script_message\('noxreel-state', guard\(apply_state\)\)/);
  assert.match(lua, /mp\.register_script_message\('noxreel-toast'/);
  assert.match(lua, /mp\.commandv\('script-message', MESSAGE, 'ready'\)/);
  // 主进程连上管道比脚本加载晚约 100ms：ready / fallback 同时写进属性
  assert.match(lua, /local STATUS_PROP = 'user-data\/noxreel_osc\/status'/);
  assert.match(lua, /mp\.set_property_native\(STATUS_PROP, 'ready'\)\nmp\.commandv\('script-message', MESSAGE, 'ready'\)/);
  assert.match(lua, /pcall\(mp\.set_property_native, STATUS_PROP, 'fallback'\)/);
  assert.match(lua, /pcall\(mp\.set_property_bool, 'osc', true\)/);
  // 退回时把强制的 ESC 摘掉（不然全屏里 ESC 退不出来），定时器都登记在 timers 里一起停
  assert.match(lua, /for _, name in ipairs\(bound_keys\) do pcall\(mp\.remove_key_binding, name\) end\n\s+if overlay then/);
  assert.match(lua, /local bound_keys = \{ 'nx-menu-esc',/);
  assert.match(lua, /timers\.busy = mp\.add_periodic_timer/);
  assert.match(lua, /timers\.fade = mp\.add_periodic_timer/);
  // 菜单不截掉，放不下滚着看
  assert.doesNotMatch(lua, /while #m\.items > 12/);
  assert.match(lua, /options\.read_options\(opts, 'noxreel_osc'\)/, 'script-opts 的前缀和主进程给的一致');
  // 拖进度条只在松手时跳一次（房间里每一次跳转都要同步给所有人）
  assert.match(lua, /if d\.kind == 'seek' and media\.duration > 0 and can_seek\(\) then\n\s+mp\.commandv\('seek'/);
});

const MPV_BIN = path.join(REPO, 'vendor', 'bin', 'mpv.exe');
const haveMpv = process.platform === 'win32' && fs.existsSync(MPV_BIN);

/**
 * 真实的握手：脚本在 mpv 起来几毫秒时就报了 ready，主进程约 100ms 后才连上管道（MpvController._connectWithRetry
 * 每 120ms 试一次）。以前只靠那一声广播，真机上 28 次全丢，房间状态一条都推不进控制条。
 * 这里故意等 600ms 再连，确认连上之后照样认得出控制条已经就绪、状态推得过去。
 */
test('真 mpv：管道连上得晚（脚本早就报过 ready 了）照样握上手，状态推得过去', { skip: !haveMpv && '没有 vendor/bin/mpv.exe' }, async () => {
  const pipe = `\\\\.\\pipe\\noxreel-osc-test-${process.pid}-${Date.now()}`;
  const child = spawn(
    MPV_BIN,
    ['--no-config', '--vo=null', '--ao=null', '--mute=yes', '--idle=yes', '--osc=no', '--load-scripts=no', `--input-ipc-server=${pipe}`, `--script=${OSC_ABS}`],
    { stdio: 'ignore', windowsHide: true, env: childEnv() }
  );
  const killer = setTimeout(() => child.kill(), 20_000);
  const ctl = new MpvController();
  try {
    await new Promise((r) => setTimeout(r, 600));
    ctl.running = true;
    ctl.proc = child;
    await ctl._connectWithRetry(pipe);
    ctl._subscribe();
    const deadline = Date.now() + 5000;
    while (!ctl.oscReady && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(ctl.oscReady, true, '连上之后认出控制条已经就绪');
    await ctl.setOscState({ title: '握手测试' });
    assert.equal(ctl._oscSent, JSON.stringify({ title: '握手测试' }), '状态推出去了');
    await ctl.osd('提示条', 1000, 'ok');
  } finally {
    await ctl.quit().catch(() => {});
    await ctl.waitForExit(3000);
    clearTimeout(killer);
  }
});

const DRIVER = String.raw`
local mp = require 'mp'
local utils = require 'mp.utils'
local out = mp.get_opt('driver-out')
local ready = false
mp.register_script_message('noxreel-osc', function(what) if what == 'ready' then ready = true end end)
mp.register_event('file-loaded', function()
  mp.add_timeout(0.3, function()
    mp.commandv('script-message-to', 'noxreel_osc', 'noxreel-state', utils.format_json({
      title = '测试片名{\\an7}', chip = { tone = 'wait', text = '等人缓冲 · 3 人在看' },
      stall = { title = '等待 小林 缓冲', progress = 0.5 }, canSeek = true, danmaku = true,
    }))
    mp.commandv('mouse', 640, 650)
    mp.add_timeout(0.5, function()
      local v = mp.get_property_native('user-data/noxreel_osc/ass') or {}
      local f = io.open(out, 'wb')
      f:write(utils.format_json({ ready = ready, w = v.w, h = v.h, data = v.data or '', osd_level = mp.get_property_number('osd-level'), osc = mp.get_property_native('osc') }))
      f:close()
      mp.command('quit')
    end)
  end)
end)
`;

test('真 mpv（无窗口、无声音）：脚本载入、报 ready、按推来的状态画出面板和等待卡片，片名里的 ASS 标签被丢掉', { skip: !haveMpv && '没有 vendor/bin/mpv.exe' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noxreel-osc-'));
  try {
    const driver = path.join(dir, 'driver.lua');
    const out = path.join(dir, 'out.json');
    fs.writeFileSync(driver, DRIVER);
    const args = [
      '--no-config', '--vo=null', '--ao=null', '--mute=yes', '--idle=no', '--osc=no', '--load-scripts=no', '--pause=yes',
      `--script=${OSC_ABS}`, `--script=${driver}`,
      `--script-opts=noxreel_osc-debug=yes,noxreel_osc-debug_size=1280x720,driver-out=${out}`,
      'av://lavfi:color=c=gray:s=320x180:d=600:r=5',
    ];
    const code = await new Promise((resolve) => {
      const child = spawn(MPV_BIN, args, { stdio: 'ignore', windowsHide: true, env: childEnv() });
      const timer = setTimeout(() => child.kill(), 30_000);
      child.on('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    assert.equal(code, 0);
    const res = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(res.ready, true, '脚本报了 ready');
    assert.equal(res.osc, false, '没有退回自带控制条');
    assert.equal(res.osd_level, 0, '自带的 OSD 文字关掉了，音量和跳转由控制条画');
    assert.deepEqual([res.w, res.h], [1280, 720]);
    assert.match(res.data, /测试片名an7/, '片名画出来了，花括号和反斜杠被丢掉');
    assert.doesNotMatch(res.data, /测试片名\{/);
    assert.match(res.data, /等待 小林 缓冲/);
    assert.match(res.data, /等人缓冲 · 3 人在看/);
    assert.match(res.data, /\\p3\}m /, '面板是画出来的');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


// 快捷键：点一下 → 前进 5 秒、按住 → 2 倍速松手恢复、Enter 全屏、↑↓ 音量、[ ] 1–8 Home 不起作用、? 一览、游客不能快进
const KEYS_DRIVER = String.raw`
local mp = require 'mp'
local utils = require 'mp.utils'
local out = mp.get_opt('keys-out') or 'keys.json'
local R = { msgs = {} }

mp.register_script_message('noxreel-osc', function(...)
  R.msgs[#R.msgs + 1] = table.concat({ ... }, ' ')
end)

local function num(p) return mp.get_property_number(p) end
local function ass() return (mp.get_property_native('user-data/noxreel_osc/ass') or {}).data or '' end

local steps = {}
local function step(delay, fn) steps[#steps + 1] = { delay, fn } end
local function run(i)
  local s = steps[i]
  if not s then
    local f = io.open(out, 'wb')
    f:write(utils.format_json(R))
    f:close()
    mp.command('quit')
    return
  end
  mp.add_timeout(s[1], function()
    s[2]()
    run(i + 1)
  end)
end

step(0.3, function()
  mp.commandv('script-message-to', 'noxreel_osc', 'noxreel-state', utils.format_json({ title = 't', canSeek = true, danmaku = true }))
  R.t0 = num('time-pos')
  mp.commandv('keydown', 'RIGHT')
end)
step(0.1, function() mp.commandv('keyup', 'RIGHT') end)
step(0.5, function()
  R.tap_delta = num('time-pos') - R.t0
  R.tap_speed = num('speed')
  mp.commandv('keydown', 'RIGHT')
end)
step(0.8, function() R.hold_speed = num('speed') end)
step(0.3, function() mp.commandv('keyup', 'RIGHT') end)
step(0.3, function()
  R.after_hold_speed = num('speed')
  mp.commandv('keypress', 'ENTER')
end)
step(0.2, function()
  R.fs1 = mp.get_property_native('fullscreen')
  mp.commandv('keypress', 'ENTER')
end)
step(0.2, function()
  R.fs2 = mp.get_property_native('fullscreen')
  R.vol0 = num('volume')
  mp.commandv('keypress', 'UP')
end)
step(0.2, function()
  R.vol_up = num('volume')
  mp.commandv('keypress', 'DOWN')
  mp.commandv('keypress', 'DOWN')
end)
step(0.2, function()
  R.vol_down = num('volume')
  mp.commandv('keypress', ']')
  mp.commandv('keypress', '[')
  mp.commandv('keypress', '1')
  mp.commandv('keypress', '4')
end)
step(0.3, function()
  R.speed_after_brackets = num('speed')
  R.contrast = num('contrast')
  R.brightness = num('brightness')
  R.speed_toast = ass():find('不能改倍速', 1, true) ~= nil
  R.t_home0 = num('time-pos')
  mp.commandv('keypress', 'HOME')
end)
step(0.4, function()
  R.home_delta = num('time-pos') - R.t_home0
  mp.commandv('keypress', '?')
end)
step(0.3, function()
  R.help_open = ass():find('2 倍速快进，松开恢复', 1, true) ~= nil
  mp.commandv('keypress', 'ESC')
end)
step(0.3, function()
  R.help_closed = ass():find('2 倍速快进，松开恢复', 1, true) == nil
  R.fs_after_esc = mp.get_property_native('fullscreen')
  mp.commandv('keypress', 'c')
end)
step(0.3, function()
  -- 没有字幕也打开菜单：里面有「加载本机字幕…」
  R.load_sub_item = ass():find('加载本机字幕…', 1, true) ~= nil
  mp.commandv('keypress', 'ESC')
end)
step(0.3, function()
  R.menu_closed = ass():find('加载本机字幕…', 1, true) == nil
  mp.commandv('keypress', 'b')
end)
step(0.3, function()
  R.danmaku_toast = ass():find('弹幕已关闭', 1, true) ~= nil
  mp.commandv('script-message-to', 'noxreel_osc', 'noxreel-state', utils.format_json({ title = 't', canSeek = false }))
end)
step(0.3, function()
  R.g0 = num('time-pos')
  mp.commandv('keypress', 'LEFT')
  mp.commandv('keydown', 'RIGHT')
end)
step(0.8, function()
  R.guest_speed = num('speed')
  mp.commandv('keyup', 'RIGHT')
end)
step(0.3, function()
  R.guest_delta = num('time-pos') - R.g0
  R.guest_toast = ass():find('游客不能跳转进度', 1, true) ~= nil
end)

mp.register_event('file-loaded', function()
  mp.set_property_bool('pause', false)
  run(1)
end)
`;

test('真 mpv：快捷键（点按 / 长按 →、Enter、↑↓、被去掉的键、? 一览、C / B、游客）', { skip: !haveMpv && '没有 vendor/bin/mpv.exe' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noxreel-osc-keys-'));
  try {
    const driver = path.join(dir, 'keys.lua');
    const out = path.join(dir, 'keys.json');
    fs.writeFileSync(driver, KEYS_DRIVER);
    const args = [
      '--no-config', '--vo=null', '--ao=null', '--mute=yes', '--idle=no', '--osc=no', '--load-scripts=no', '--pause=yes', '--start=10',
      `--script=${OSC_ABS}`, `--script=${driver}`,
      `--script-opts=noxreel_osc-debug=yes,noxreel_osc-debug_size=1280x720,keys-out=${out}`,
      'av://lavfi:color=c=gray:s=160x90:r=5:d=600',
    ];
    const code = await new Promise((resolve) => {
      const child = spawn(MPV_BIN, args, { stdio: 'ignore', windowsHide: true, env: childEnv() });
      const timer = setTimeout(() => child.kill(), 40_000);
      child.on('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    assert.equal(code, 0);
    const r = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.ok(r.tap_delta > 4.5 && r.tap_delta < 7, '点一下 → 前进 5 秒：' + r.tap_delta);
    assert.equal(r.tap_speed, 1);
    assert.equal(r.hold_speed, 2, '按住 → 变 2 倍速');
    assert.equal(r.after_hold_speed, 1, '松手恢复');
    assert.ok(r.msgs.includes('speed-hold start'));
    assert.ok(r.msgs.some((m) => /^speed-hold end \d+\.\d{3}$/.test(m)), '松手时报出停在哪：' + r.msgs.join(' | '));
    assert.equal(r.fs1, true, 'Enter 全屏');
    assert.equal(r.fs2, false, '再按 Enter 退出');
    assert.equal(r.vol_up, r.vol0 + 5);
    assert.equal(r.vol_down, r.vol0 - 5);
    assert.equal(r.speed_after_brackets, 1, '[ ] 不改倍速');
    assert.equal(r.speed_toast, true, '改倍速的键给一句说明');
    assert.equal(r.contrast, 0, '1–8 不再悄悄调画面');
    assert.equal(r.brightness, 0);
    assert.ok(r.home_delta > -1, 'Home 不再把全房拽回片头');
    assert.equal(r.help_open, true, '? 打开快捷键一览');
    assert.equal(r.help_closed, true, 'Esc 关掉一览');
    assert.equal(r.fs_after_esc, false, '关一览的 Esc 没有顺带切全屏');
    assert.equal(r.load_sub_item, true, '没有字幕时按 C 也打开菜单，能加载本机字幕');
    assert.equal(r.menu_closed, true, 'Esc 关掉菜单');
    // 1–8 在房间里是发表情（第几个，0 起）
    assert.ok(r.msgs.includes('react 0'), r.msgs.join(' | '));
    assert.ok(r.msgs.includes('react 3'));
    assert.equal(r.danmaku_toast, true, 'B 开关弹幕并提示');
    assert.ok(r.msgs.includes('danmaku'));
    assert.ok(r.guest_delta >= 0 && r.guest_delta < 2, '游客按 ← 不跳：' + r.guest_delta);
    assert.equal(r.guest_speed, 1, '游客按住 → 不快进');
    assert.equal(r.guest_toast, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
