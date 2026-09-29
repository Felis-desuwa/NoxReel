'use strict';

// 片名、房间名（房主 / 管理员右键改，记在列表快照里全房一致）和 Discord 上显示片名还是房间名
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8').replace(/\r\n/g, '\n');
const APP = read('src', 'renderer', 'app.js');

function fnSource(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层函数 ${name}`);
  const end = APP.indexOf('\n}\n', m.index);
  return APP.slice(m.index, end + 2);
}

function sandbox(fns, globals) {
  const ctx = { ...globals };
  vm.createContext(ctx);
  vm.runInContext(fns.map(fnSource).join('\n\n'), ctx, { filename: 'app.js（节选）' });
  return ctx;
}

test('房间叫什么：起过名用起的名；没起时是「房主昵称的放映厅」（自己当房主用自己的昵称）', () => {
  const S = { playlist: { roomName: '' }, name: '菲利斯', hostId: 'h' };
  let host = true;
  const ctx = sandbox(['roomLabel'], {
    S,
    isRoomHost: () => host,
    roomDisplayNames: () => new Map([['h', '小明']]),
    t: (s) => s,
  });
  assert.equal(ctx.roomLabel(), '菲利斯的放映厅');
  host = false;
  assert.equal(ctx.roomLabel(), '小明的放映厅');
  S.hostId = 'gone';
  assert.equal(ctx.roomLabel(), 'NoxReel', '房主还不在成员表里');
  S.playlist.roomName = '周五电影夜';
  assert.equal(ctx.roomLabel(), '周五电影夜');
});

test('正在放的这一部叫什么：改过名的优先；链接用解析出的标题，本地片用清单里的文件名', () => {
  const S = { current: { kind: 'link', title: '列表里的', label: '' }, sourceType: 'link', linkInfo: { title: '解析出的' } };
  const ctx = sandbox(['currentTitle'], { S });
  assert.equal(ctx.currentTitle(), '解析出的');
  S.current.label = '第一集';
  assert.equal(ctx.currentTitle(), '第一集');
  Object.assign(S, { current: { kind: 'file', name: 'a.mkv', label: '' }, sourceType: 'file', manifest: null, linkInfo: null });
  assert.equal(ctx.currentTitle(), 'a.mkv');
  S.manifest = { name: 'a.mkv' };
  S.current.label = '预告';
  assert.equal(ctx.currentTitle(), '预告');
});

test('改片名：对话框里填原名等于改回原名（发空串）；失败了留在对话框里；不能编辑列表的人打不开', async () => {
  const ops = [];
  let modal = null;
  let canEdit = true;
  let result = { ok: true };
  const item = { id: 'aaaaaaaa', kind: 'link', url: 'https://x.example/v', title: '原标题', label: '' };
  const ctx = sandbox(['openNameModal', 'openItemRename'], {
    S: { playlist: { queue: [item], history: [] } },
    findItem: (pl, id) => (id === item.id ? { item, where: 'queue', index: 0 } : null),
    canEditPlaylist: () => canEdit,
    originalName: (it) => it.title || it.url,
    MAX_LABEL: 100,
    make: (tag, o = {}) => ({ tag, ...o, value: o.props?.value }),
    field: (...a) => a,
    hint: (...a) => a,
    openModal: (o) => (modal = o),
    setTimeout: () => {},
    runPlaylistOp: async (op) => {
      ops.push(op);
      return result;
    },
  });
  ctx.openItemRename(item.id);
  assert.equal(modal.title, '改片名');
  const input = modal.body[0][1];
  assert.equal(input.value, '原标题', '没改过名时框里是原名');
  assert.equal(input.attrs.maxlength, 100);
  input.value = '  第一集 ';
  assert.equal(await modal.onOk(), true);
  input.value = '原标题';
  await modal.onOk();
  assert.deepEqual(JSON.parse(JSON.stringify(ops)), [
    { type: 'rename', id: item.id, label: '第一集' },
    { type: 'rename', id: item.id, label: '' },
  ]);
  result = { ok: false, reason: '你没有编辑播放列表的权限' };
  assert.equal(await modal.onOk(), false, '没改成：留在对话框里（原因由 runPlaylistOp 记进日志）');

  modal = null;
  canEdit = false;
  ctx.openItemRename(item.id);
  assert.equal(modal, null);
});

test('房间名：房主改了记在本机，下次开房接着用；清空 = 不起名', async () => {
  let modal = null;
  const stored = {};
  const ops = [];
  const logs = [];
  const ctx = sandbox(['openNameModal', 'openRoomRename', 'applyRoomName'], {
    S: { playlist: { roomName: '' } },
    log: (text, tone) => logs.push([text, tone]),
    roomEntered: true,
    canEditPlaylist: () => true,
    isRoomHost: () => true,
    roomLabel: () => '菲利斯的放映厅',
    MAX_ROOM_NAME: 40,
    make: (tag, o = {}) => ({ tag, ...o, value: o.props?.value }),
    field: (...a) => a,
    hint: (...a) => a,
    openModal: (o) => (modal = o),
    setTimeout: () => {},
    localStorage: { setItem: (k, v) => (stored[k] = v) },
    runPlaylistOp: async (op) => (ops.push(op), { ok: true }),
  });
  ctx.openRoomRename();
  const input = modal.body[0][1];
  assert.equal(input.attrs.placeholder, '菲利斯的放映厅', '没起名时提示默认叫什么');
  input.value = '周五电影夜';
  assert.equal(await modal.onOk(), true);
  assert.deepEqual(JSON.parse(JSON.stringify(ops)), [{ type: 'setRoomName', name: '周五电影夜' }]);
  assert.equal(stored['sw.roomName'], '周五电影夜');
  assert.deepEqual(logs.at(-1), ['房间名改成「周五电影夜」', 'good']);
  // 邀请区那一栏（房主看得到的地方）走同一个函数；清空 = 不起名
  assert.equal(await ctx.applyRoomName(''), true);
  assert.deepEqual(JSON.parse(JSON.stringify(ops.at(-1))), { type: 'setRoomName', name: '' });
  assert.deepEqual(logs.at(-1), ['房间名清掉了', 'good']);
  assert.match(fnSource('renderInvite'), /id: 'room-name-input'[\s\S]*?\$\('room-name-apply'\)\.onclick = \(\) => applyRoomName\(\$\('room-name-input'\)\.value\.trim\(\)\);/);
  assert.match(fnSource('enterRoom'), /if \(isRoomHost\(\) && !S\.playlist\.roomName\) \{\n\s+S\.playlist = \{ \.\.\.S\.playlist, roomName: cleanRoomName\(localStorage\.getItem\('sw\.roomName'\)\) \};/);
});

test('行菜单：能编辑列表的人有「重命名…」，游客没有；右键片名、房间标签、列表里的一行都能打开', () => {
  const src = (name) => fnSource(name);
  assert.match(src('queueMenu'), /menu\.push\(\{ key: 'rename', label: '重命名…' \}\);/);
  assert.match(src('historyMenu'), /menu\.push\(\{ key: 'rename', label: '重命名…' \}\);/);
  assert.ok(src('queueMenu').indexOf("key: 'rename'") < src('queueMenu').indexOf('return [...menu, ...localMenu(item)]'));
  assert.match(src('onPlaylistAction'), /if \(!canEditPlaylist\(\)\) return;[\s\S]*case 'rename':\n\s+openItemRename\(id\);/, '改名在权限检查之后');
  assert.match(APP, /\$\('room-file'\)\.addEventListener\('contextmenu', \(e\) => \{\n\s+if \(!S\.current \|\| !canEditPlaylist\(\)\) return;\n\s+e\.preventDefault\(\);\n\s+openItemRename\(S\.current\.id\);/);
  assert.match(APP, /\$\('pill-room'\)\.addEventListener\('contextmenu', \(e\) => \{\n\s+if \(!roomEntered \|\| !canEditPlaylist\(\)\) return;\n\s+e\.preventDefault\(\);\n\s+openRoomRename\(\);/);
  assert.match(APP, /\$\('pill-room'\)\.addEventListener\('click', \(\) => \{\n\s+if \(roomEntered && canEditPlaylist\(\)\) openRoomRename\(\);/, '左键点也行');
  const panel = read('src', 'renderer', 'ui', 'playlistPanel.js');
  assert.match(panel, /body\.addEventListener\('contextmenu', \(e\) => \{[\s\S]*?openMenu\(id, moreButtonOf\(id\), \{ x: e\.clientX, y: e\.clientY \}\);/);
});

test('顶栏房间标签：起了名就在前面单独一段（不翻译），后面的状态照旧整句；快照变了跟着重画', () => {
  let replaced = null;
  const classes = new Set();
  const pill = { classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } };
  const input = { value: '旧的', placeholder: '' };
  const S = { roomSecurityMode: 'trusted', roomCapacity: 6, playlist: { roomName: '周五电影夜' } };
  let canEdit = true;
  const ctx = sandbox(['renderRoomPill'], {
    S,
    $: (id) => (id === 'room-name-input' ? input : pill),
    document: { activeElement: null },
    roomLabel: () => '菲利斯的放映厅',
    connectedPeerCount: () => 0,
    canEditPlaylist: () => canEdit,
    t: (s) => s,
    make: (tag, o = {}) => ({ tag, ...o }),
    replace: (node, ...kids) => (replaced = kids.flat().filter((k) => k != null)), // 和 dom.js 的 replace 一样丢掉 null
  });
  ctx.renderRoomPill();
  assert.deepEqual(
    JSON.parse(JSON.stringify(replaced)),
    [
      { tag: 'span', raw: true, className: 'pill-room-name', text: '周五电影夜' },
      { tag: 'span', text: '等人加入 · 可信房间 · 1 / 6 人' },
      { tag: 'span', className: 'pill-edit', text: '✎', attrs: { 'aria-hidden': 'true' } },
    ]
  );
  assert.equal(pill.title, '点击给房间起名');
  assert.equal(classes.has('editable'), true);
  assert.equal(input.value, '周五电影夜', '邀请区那一栏跟着快照走');
  canEdit = false;
  S.playlist.roomName = '';
  ctx.renderRoomPill();
  assert.deepEqual(JSON.parse(JSON.stringify(replaced)), [{ tag: 'span', text: '等人加入 · 可信房间 · 1 / 6 人' }], '游客：没有笔、点不了');
  assert.equal(pill.title, '');
  assert.equal(classes.has('editable'), false);
  input.value = '正在输入';
  ctx.document.activeElement = input;
  S.playlist.roomName = '别人改的';
  ctx.renderRoomPill();
  assert.equal(input.value, '正在输入', '正在输入时不去覆盖');
  assert.match(fnSource('onPlaylistChanged'), /renderRoomPill\(\);/);
});

test('片名旁边的 Discord 切换按钮：状态显示开着才出现；点一下在片名和房间名之间切，存本机、马上更新', () => {
  const saved = [];
  let presence = 0;
  const btn = { dataset: {}, classes: new Set(['hidden']), classList: null };
  btn.classList = { toggle: (c, on) => (on ? btn.classes.add(c) : btn.classes.delete(c)) };
  let text = '';
  const S = { discord: { enabled: false, show: 'title', showJoin: true } };
  const ctx = sandbox(['renderDiscordShowToggle', 'toggleDiscordShow'], {
    S,
    roomEntered: true,
    window: { sw: { discord: {} } },
    $: () => btn,
    t: (s) => s,
    replace: (node, s) => (text = s),
    savePresenceSettings: (s) => saved.push({ ...s }),
    updatePresence: () => presence++,
  });
  ctx.renderDiscordShowToggle();
  assert.equal(btn.classes.has('hidden'), true, '状态显示关着：不摆');
  S.discord.enabled = true;
  ctx.renderDiscordShowToggle();
  assert.equal(btn.classes.has('hidden'), false);
  assert.equal(text, 'Discord：显示片名');
  ctx.toggleDiscordShow();
  assert.equal(S.discord.show, 'room');
  assert.equal(text, 'Discord：显示房间名');
  ctx.toggleDiscordShow();
  assert.equal(S.discord.show, 'title');
  assert.deepEqual(saved.map((s) => s.show), ['room', 'title']);
  assert.equal(presence, 2);
  S.discord = { ...S.discord, show: 'none' };
  ctx.renderDiscordShowToggle();
  assert.equal(text, 'Discord：不写名字');
  ctx.toggleDiscordShow();
  assert.equal(S.discord.show, 'title', '从设置里选过「不写名字」的，点一下回到片名');
  assert.match(fnSource('updatePresence'), /^function updatePresence\(\) \{\n\s+renderDiscordShowToggle\(\);/);
  assert.match(fnSource('presenceState'), /title: currentTitle\(\),\n\s+roomName: roomLabel\(\),/);
});
