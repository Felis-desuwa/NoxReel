'use strict';

// 共享标记（「标记这一刻」）、表情反应、成员自己加本机字幕
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { IMPLS } = require('./helpers/impls');
const { MpvController, childEnv } = require('../src/main/mpv');
const validate = require('../src/main/security');

const REPO = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(REPO, ...parts), 'utf8').replace(/\r\n/g, '\n');
const APP = read('src', 'renderer', 'app.js');
const APP_ANDROID = read('android', 'app', 'src', 'main', 'assets', 'js', 'app-android.js');
const OSC = read('resources', 'mpv-scripts', 'noxreel-osc.lua');
const CHAT_LUA = read('resources', 'mpv-scripts', 'noxreel-chat.lua');
const MAIN = read('src', 'main', 'main.js');
const MPV_BIN = path.join(REPO, 'vendor', 'bin', 'mpv.exe');
const haveMpv = process.platform === 'win32' && fs.existsSync(MPV_BIN);
const OSC_ABS = path.join(REPO, 'resources', 'mpv-scripts', 'noxreel-osc.lua');

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

const ITEM = 'abcdef12';

/* ------------------------------ 共享库 ------------------------------ */

impl('造标记、表情：列表项 id、位置、表情下标不对的不造；备注去控制字符、截到 60 个字', async (dir) => {
  const M = await import(dir + 'moments.js');
  const mark = M.createMark({ item: ITEM, pos: 83.456, note: '  这里\u202e好笑  ' });
  assert.equal(mark.t, 'mark');
  assert.match(mark.id, /^[0-9a-f]{12}$/);
  assert.equal(mark.pos, 83.5);
  assert.equal(mark.note, '这里好笑');
  assert.equal(M.createMark({ item: 'NOPE', pos: 1 }), null);
  assert.equal(M.createMark({ item: ITEM, pos: -1 }), null);
  assert.equal(M.createMark({ item: ITEM, pos: 90000 }), null);
  assert.equal(Array.from(M.createMark({ item: ITEM, pos: 1, note: '字'.repeat(80) }).note).length, 60);
  assert.equal(M.createReaction(0).e, 0);
  assert.equal(M.createReaction(7).t, 'react');
  assert.equal(M.createReaction(8), null);
  assert.equal(M.createReaction(1.5), null);
  assert.equal(M.REACTIONS.length, 8);
  assert.equal(M.createUnmark('zz'), null);
  assert.equal(M.createUnmark(mark.id).del, mark.id);
});

impl('收端闸门：身份以连接为准，只有房主转来的采信 origin；去重、回声、限速', async (dir) => {
  const M = await import(dir + 'moments.js');
  let now = 1000;
  const gate = new M.MomentGate({ now: () => now });
  const ctx = { senderId: 'p1', senderName: '小林', hostId: 'h1', selfId: 'me' };
  const mark = M.createMark({ item: ITEM, pos: 10, note: 'hi' });
  // 冒充别人：不是房主发来的，origin 不算数
  const spoof = gate.accept({ ...mark, origin: 'p9', originName: '假的' }, ctx);
  assert.equal(spoof.ok, true);
  assert.equal(spoof.kind, 'mark');
  assert.equal(spoof.value.origin, 'p1');
  assert.equal(spoof.value.name, '小林');
  assert.equal(spoof.value.relayed, false);
  // 同一条从房主那里转来：重复
  assert.equal(gate.accept({ ...mark, origin: 'p1', originName: '小林' }, { ...ctx, senderId: 'h1', senderName: '房主' }).reason, 'duplicate');
  // 房主转来的另一个人的
  const relayed = gate.accept({ ...M.createReaction(2), origin: 'p2', originName: '阿杰' }, { ...ctx, senderId: 'h1' });
  assert.equal(relayed.kind, 'react');
  assert.equal(relayed.value.origin, 'p2');
  assert.equal(relayed.value.relayed, true);
  // 自己的回声
  assert.equal(gate.accept({ ...M.createReaction(0), origin: 'me' }, { ...ctx, senderId: 'h1' }).reason, 'echo');
  // 形状不对
  for (const bad of [{ t: 'react', id: 'x', e: 0 }, { ...M.createReaction(0), e: 9 }, { ...mark, id: M.createReaction(0).id, item: 'NOPE' }, { t: 'chat', id: 'aaaaaaaaaaaa' }]) {
    assert.equal(gate.accept(bad, ctx).reason, 'invalid');
  }
  // 标记：突发 3 个，之后每 5 秒一个
  const p3 = { ...ctx, senderId: 'p3' };
  for (let i = 0; i < M.MARK_BURST; i++) assert.equal(gate.accept(M.createMark({ item: ITEM, pos: i }), p3).ok, true);
  assert.equal(gate.accept(M.createMark({ item: ITEM, pos: 9 }), p3).reason, 'rate');
  now += 5000;
  assert.equal(gate.accept(M.createMark({ item: ITEM, pos: 9 }), p3).ok, true);
  // 表情：突发 8 个
  const p4 = { ...ctx, senderId: 'p4' };
  for (let i = 0; i < M.REACT_BURST; i++) assert.equal(gate.accept(M.createReaction(i % 8), p4).ok, true);
  assert.equal(gate.accept(M.createReaction(0), p4).reason, 'rate');
  // 自己发之前也过自己的令牌桶
  for (let i = 0; i < M.REACT_BURST; i++) assert.equal(gate.allowOwn('react', 'me'), true);
  assert.equal(gate.allowOwn('react', 'me'), false);
  // 删标记
  const unmark = gate.accept(M.createUnmark(mark.id), { ...ctx, senderId: 'p5' });
  assert.equal(unmark.kind, 'unmark');
  assert.equal(unmark.value.target, mark.id);
});

impl('标记表：按列表项分开、按位置排好；满了挤掉最早标的；删、按列表留、快照和收快照', async (dir) => {
  const M = await import(dir + 'moments.js');
  const book = new M.MarkBook({ perItem: 3 });
  const add = (pos, ts, item = ITEM) => {
    const m = { ...M.createMark({ item, pos }), origin: 'p1', name: '小林', ts };
    assert.equal(book.add(m), true);
    return m;
  };
  const a = add(50, 1);
  add(10, 2);
  add(30, 3);
  assert.deepEqual(book.list(ITEM).map((m) => m.pos), [10, 30, 50]);
  add(20, 4);
  assert.deepEqual(book.list(ITEM).map((m) => m.pos), [10, 20, 30], '满了挤掉最早标的（ts 最小的那个）');
  assert.equal(book.get(a.id), null);
  assert.equal(book.add({ ...book.list(ITEM)[0] }), false, '同一个 id 不加两次');
  assert.equal(book.add({ id: 'x' }), false, '结构不对的不收');
  const other = add(5, 5, 'bcdef123');
  assert.equal(book.size, 4);
  assert.equal(book.remove(other.id).pos, 5);
  assert.deepEqual(book.list('bcdef123'), []);
  add(6, 6, 'bcdef123');
  book.retain(new Set([ITEM]));
  assert.equal(book.size, 3, '列表里没有的项，标记也不留');
  const snap = book.snapshot();
  assert.equal(snap.length, 3);
  const fresh = new M.MarkBook();
  assert.equal(fresh.load([...snap, { id: 'bad' }, 'x']), 3);
  assert.deepEqual(fresh.list(ITEM).map((m) => m.pos), [10, 20, 30]);
  assert.equal(M.normalizeMark({ ...snap[0], name: '\u202e小林' }).name, '小林');
});

/* ------------------------------ 协议 ------------------------------ */

impl('协议：标记、表情、整张标记表的线上字符串；整张表可以分段', async (dir) => {
  const P = await import(dir + 'protocol.js');
  assert.equal(P.MSG.MARK, 'mark');
  assert.equal(P.MSG.REACT, 'react');
  assert.equal(P.MSG.MARKS, 'marks');
  assert.ok(P.PART_INNER_TYPES.has('marks'));
});

/* ------------------------------ 主进程 ------------------------------ */

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
  const actions = [];
  ctl.on('osc-action', (a) => actions.push(a));
  const message = (...args) => ctl._onData(JSON.stringify({ event: 'client-message', args }) + '\n');
  return { ctl, sent, actions, message };
}

test('mpv 报上来的：表情（只认 0–7）、加载本机字幕、K 标记（位置和一句话都卡住）', () => {
  const { actions, message } = fakeController();
  message('noxreel-osc', 'react', '3');
  message('noxreel-osc', 'react', '8');
  message('noxreel-osc', 'react', '1.5');
  message('noxreel-osc', 'load-sub');
  message('noxreel-mark', '83.50', '这里好笑');
  message('noxreel-mark', '', '');
  message('noxreel-mark', '-5', '字'.repeat(90));
  assert.deepEqual(actions, [
    { action: 'react', value: 3 },
    { action: 'load-sub' },
    { action: 'mark', position: 83.5, note: '这里好笑' },
    { action: 'mark', position: null, note: '' },
    { action: 'mark', position: null, note: '字'.repeat(60) },
  ]);
});

test('飘表情：控制条就绪时推给脚本（JSON），退回自带控制条时用一行提示；加本机字幕是 sub-add + select', async () => {
  const { ctl, sent } = fakeController();
  ctl.oscReady = true;
  ctl.showReaction(1, '小林');
  ctl.showReaction(9, '越界');
  ctl.oscReady = false;
  ctl.showReaction(0, '阿杰');
  ctl.addSubtitle('D:\\字幕\\a.srt').catch(() => {});
  const cmds = sent.map((m) => m.command);
  assert.deepEqual(cmds[0], ['script-message-to', 'noxreel_osc', 'noxreel-react', JSON.stringify({ e: 1, name: '小林' })]);
  assert.deepEqual(cmds[1], ['show-text', '❤ 阿杰', 1500, 0]);
  assert.deepEqual(cmds[2], ['sub-add', 'D:\\字幕\\a.srt', 'select']);
  assert.equal(cmds.length, 3, '越界的表情不发');
});

test('控制条状态里的共享标记：最多 40 个，每个「谁：一句话」120 字以内；多了、形状不对整份拒绝', () => {
  const ok = validate.oscState({ title: 't', marks: [{ t: 30, n: '小林：这里好笑' }] });
  assert.deepEqual(ok.marks, [{ t: 30, n: '小林：这里好笑' }]);
  assert.throws(() => validate.oscState({ marks: Array.from({ length: 41 }, () => ({ t: 1, n: '' })) }));
  assert.throws(() => validate.oscState({ marks: [{ t: -1, n: '' }] }));
  assert.throws(() => validate.oscState({ marks: [{ t: 1, n: 'x'.repeat(121) }] }));
  assert.throws(() => validate.oscState({ marks: 'x' }));
  assert.match(APP, /const OSC_MAX_MARKS = 40;/, '渲染进程截短用同一个数');
  assert.match(read('src', 'main', 'security.js'), /const OSC_MAX_MARKS = 40;/);
});

test('主进程：表情先校验再交给播放器；本机字幕只从文件对话框来，老编码先转成 UTF-8，交给 mpv', () => {
  assert.match(MAIN, /secureHandle\('player:reaction'/);
  assert.match(MAIN, /validate\.integer\(e, '表情', \{ min: 0, max: 7 \}\)/);
  const sub = MAIN.slice(MAIN.indexOf("secureHandle('player:loadLocalSubtitle'"), MAIN.indexOf("secureHandle('player:loadLocalSubtitle'") + 2600);
  assert.match(sub, /dialog\.showOpenDialog\(/);
  assert.match(sub, /filters: SUBTITLE_FILTERS/);
  assert.match(sub, /owner\.setAlwaysOnTop\(true\)/, '对话框别被全屏的播放器挡住');
  assert.match(sub, /owner\.setAlwaysOnTop\(false\)/);
  assert.match(sub, /subtitles\.describeFile\(realPath, null\)/, '扩展名、大小照样查');
  assert.match(sub, /subtitles\.decodeSubtitle\(/);
  assert.match(sub, /if \(!\/\^utf-\/\.test\(decoded\.encoding\)\)/);
  assert.match(sub, /await players\.addSubtitle\(loadPath\)/);
  const preload = read('src', 'main', 'preload.js');
  assert.match(preload, /loadLocalSubtitle: \(\) => ipcRenderer\.invoke\('player:loadLocalSubtitle'\)/, '页面递不进路径');
  assert.match(preload, /reaction: \(e, name\) => ipcRenderer\.invoke\('player:reaction', \{ e, name \}\)/);
});

/* ------------------------------ 控制条脚本 ------------------------------ */

test('控制条脚本：1–8 发表情（不在房间里不发）、表情按钮和菜单、字幕菜单里「加载本机字幕…」先退出全屏', () => {
  assert.match(OSC, /local REACTIONS = \{ '❤', '😂', '😮', '😭', '👍', '👏', '🔥', '🎉' \}/);
  assert.match(OSC, /if room\.danmaku ~= nil then send_reaction\(d - 1\) end/);
  assert.match(OSC, /mp\.commandv\('script-message', MESSAGE, 'react', tostring\(e\)\)/);
  assert.match(OSC, /rbutton\('react', 40,/);
  assert.match(OSC, /react = function\(\) toggle_menu\('react'\) end,/);
  assert.match(OSC, /if media\.fullscreen then mp\.set_property_bool\('fullscreen', false\) end\n\s+mp\.commandv\('script-message', MESSAGE, 'load-sub'\)/);
  assert.match(OSC, /rbutton\('subs', 40, \{ tip = sub_tracks > 0 and L\('subs'\) or L\('noSubs'\), key = 'C' \}\)/, '没有字幕也能点');
  // 点进度条上的标记：控制者跳过去，游客只提示
  assert.match(OSC, /elseif h\.id == 'mark' then\n\s+-- [^\n]+\n\s+if can_seek\(\) then mp\.commandv\('seek', string\.format\('%\.3f', h\.t\), 'absolute\+exact'\) else guest_toast\(\) end/);
  assert.match(OSC, /mp\.register_script_message\('noxreel-react'/);
  // 聊天脚本：k 直接标、K 先写一句（位置取按下那一刻的）
  assert.match(CHAT_LUA, /mp\.add_key_binding\('k', MARK_MESSAGE_NAME \.\. '-now'/);
  assert.match(CHAT_LUA, /mp\.add_key_binding\('K', MARK_MESSAGE_NAME \.\. '-note', function\(\)\n\s+local pos = mark_pos\(\)/);
});

const DRIVER = String.raw`
local mp = require 'mp'
local utils = require 'mp.utils'
local out = mp.get_opt('driver-out')
mp.register_event('file-loaded', function()
  mp.add_timeout(0.3, function()
    mp.commandv('script-message-to', 'noxreel_osc', 'noxreel-state', utils.format_json({
      title = '标记测试', canSeek = true, danmaku = true,
      marks = { { t = 30, n = '小林：这里好笑' }, { t = 300, n = '阿杰' } },
    }))
    mp.commandv('script-message-to', 'noxreel_osc', 'noxreel-react', utils.format_json({ e = 0, name = '小林' }))
    mp.commandv('mouse', 640, 650)
    mp.add_timeout(0.6, function()
      local v = mp.get_property_native('user-data/noxreel_osc/ass') or {}
      local f = io.open(out, 'wb')
      f:write(utils.format_json({ data = v.data or '' }))
      f:close()
      mp.command('quit')
    end)
  end)
end)
`;

test('真 mpv（无窗口、无声音）：进度条上画出标记（黄色菱形），表情从右边飘起来、下面写着谁', { skip: !haveMpv && '没有 vendor/bin/mpv.exe' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noxreel-moments-'));
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
    const { data } = JSON.parse(fs.readFileSync(out, 'utf8'));
    // 标记的颜色 E3B341 在 ASS 里是 BGR：41B3E3，每个标记一个菱形
    assert.ok((data.match(/1c&H41B3E3&/g) || []).length >= 2, '两个标记都画出来了');
    assert.match(data, /❤/, '表情飘起来了');
    assert.match(data, /小林/, '下面写着谁发的');
    assert.match(data, /1c&H6E5AFF&[^}]*\}❤/, '爱心按它的颜色上色');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('真 mpv：成员自己加的本机字幕经管道 sub-add 进去，并切过去', { skip: !haveMpv && '没有 vendor/bin/mpv.exe' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noxreel-subadd-'));
  const srt = path.join(dir, '我的字幕.srt');
  fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:05,000\n你好\n');
  const pipe = `\\\\.\\pipe\\noxreel-subadd-test-${process.pid}-${Date.now()}`;
  const child = spawn(
    MPV_BIN,
    ['--no-config', '--vo=null', '--ao=null', '--mute=yes', '--pause=yes', '--load-scripts=no', `--input-ipc-server=${pipe}`, 'av://lavfi:color=c=gray:s=320x180:d=60:r=5'],
    { stdio: 'ignore', windowsHide: true, env: childEnv() }
  );
  const killer = setTimeout(() => child.kill(), 20_000);
  const ctl = new MpvController();
  try {
    ctl.running = true;
    ctl.proc = child;
    await ctl._connectWithRetry(pipe);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !((await ctl.getProperty('duration').catch(() => 0)) > 0)) await new Promise((r) => setTimeout(r, 100));
    await ctl.addSubtitle(srt);
    const tracks = await ctl.getProperty('track-list');
    const sub = tracks.find((t) => t.type === 'sub');
    assert.ok(sub, '字幕轨加上了');
    assert.equal(sub.external, true);
    assert.equal(sub.selected, true, '加上就切过去');
  } finally {
    await ctl.quit().catch(() => {});
    await ctl.waitForExit(3000);
    clearTimeout(killer);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------ 电脑端接线 ------------------------------ */

test('电脑端接线：标记、表情和聊天一个走法（发给所有连接、房主再转一遍）；删标记只认本人和控制者；新人拿到整张表', () => {
  assert.match(APP, /case MSG\.MARK:\n\s+case MSG\.REACT:\n\s+onMomentMessage\(msg, peer\);/);
  assert.match(APP, /case MSG\.MARKS:\n\s+onMarksSnapshot\(msg, peer\);/);
  const onMoment = APP.slice(APP.indexOf('function onMomentMessage('), APP.indexOf('function onMarksSnapshot('));
  assert.match(onMoment, /if \(canRemoveMark\(mark, v\.origin\)\)/);
  assert.match(onMoment, /if \(!isRoomHost\(\) \|\| v\.relayed \|\| !relay\) return;/, '房主只转直接收到的、而且算数的');
  assert.match(onMoment, /for \(const p of chatPeers\(\[peer\.peerId\]\)\) p\.send\(\{ \.\.\.wire, origin: v\.origin, originName: v\.name \}\);/);
  assert.match(APP, /function canRemoveMark\(mark, actor\) \{\n\s+return !!mark && \(mark\.origin === actor \|\| !!S\.sync\?\.isController\?\.\(actor\)\);/);
  assert.match(APP, /if \(!trustsRelay\(peer\.peerId, S\.hostId\) \|\| !Array\.isArray\(msg\.items\)\) return;/, '整张表只认房主');
  assert.match(APP, /if \(S\.moments\.book\.size\) S\.swarm\.sendLarge\(peer, \{ t: MSG\.MARKS, items: S\.moments\.book\.snapshot\(\) \}\);/);
  // mpv 报上来的
  assert.match(APP, /else if \(action === 'react'\) sendReaction\(payload\.value\);/);
  assert.match(APP, /else if \(action === 'mark'\) sendMark\(\{ position: payload\.position, note: payload\.note \|\| '' \}\);/);
  assert.match(APP, /if \(action === 'load-sub'\) \{\n\s+loadLocalSubtitle\(\);/);
  // 进度条上的标记：点一下（控制者）跳过去、右键删，不让外面的进度条再跳一次
  assert.match(APP, /\$\('buf-marks'\)\.onclick = \(e\) => \{[\s\S]*?e\.stopPropagation\(\);[\s\S]*?S\.sync\.userSeek\(mark\.pos\);/);
  assert.match(APP, /marks: oscMarks\(\),/);
});

test('安卓端：收标记和表情（不转发）、底栏一排表情和「标记」、进度条上画标记', () => {
  assert.match(APP_ANDROID, /else if \(msg\.t === MSG\.MARK \|\| msg\.t === MSG\.REACT\) onMomentMessage\(msg, peer\);/);
  assert.match(APP_ANDROID, /else if \(msg\.t === MSG\.MARKS\) onMarksSnapshot\(msg, peer\);/);
  assert.match(APP_ANDROID, /if \(!fromHost\(peer\) \|\| !Array\.isArray\(msg\.items\)\) return;/);
  assert.match(APP_ANDROID, /\$\('btn-react'\)\.onclick = \(\) => pop\.classList\.toggle\('on'\);/);
  const html = read('android', 'app', 'src', 'main', 'assets', 'index.html');
  assert.match(html, /<div id="seek-marks"><\/div>/);
  assert.match(html, /<div id="react-float" aria-hidden="true"><\/div>/);
});

test('新文案都有英文（电脑端、安卓端）', async () => {
  const { translate } = await import(pathToFileURL(path.join(REPO, 'src', 'renderer', 'lib', 'i18n.js')).href);
  for (const zh of [
    '标记', '点一下跳到这里', '右键删掉', '标记得太快了，过几秒再标', '写一句（可以不写）', '比如：这里好笑',
    '大家的进度条上都看得到这个标记，房主和管理员点一下就能跳过来。', '加载本机字幕…', '发表情', '标记这一刻', '标记这一刻并写一句',
    '标记这一刻：大家的进度条上都看得到，可以写一句（播放器里按 K，Shift+K 先写一句）',
  ]) {
    assert.doesNotMatch(translate(zh, 'en'), /[一-鿿]/, zh);
  }
  assert.equal(translate('你标记了 1:23', 'en'), 'You marked 1:23');
  assert.equal(translate('你标记了 1:23：这里好笑', 'en'), 'You marked 1:23: 这里好笑');
  assert.equal(translate('小林标记了 12:34：开始了', 'en'), '小林 marked 12:34: 开始了');
  assert.equal(translate('已标记 1:23', 'en'), 'Marked 1:23');
  assert.equal(translate('删掉了 1:23 的标记', 'en'), 'Deleted the mark at 1:23');
  assert.equal(translate('字幕用不了：字幕文件大小不对', 'en'), 'Cannot use this subtitle: The subtitle file size is not valid');
  assert.equal(translate('已加载本机字幕：a.srt（只影响你自己）', 'en'), 'Loaded subtitle file a.srt (only for you)');
  const android = await import(pathToFileURL(path.join(REPO, 'android', 'app', 'src', 'main', 'assets', 'js', 'i18n.js')).href);
  assert.equal(android.translate('小林标记了 12:34', 'en'), '小林 marked 12:34');
  assert.equal(android.translate('你标记了 1:23', 'en'), 'You marked 1:23');
  assert.doesNotMatch(android.translate('标记得太快了，过几秒再标', 'en'), /[一-鿿]/);
});
