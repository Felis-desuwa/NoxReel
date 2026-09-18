'use strict';

// 房间界面的骨架：固定高度、右栏播放列表 + 聊天、成员/邀请/传输/日志页签。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function rendererScripts() {
  const files = ['src/renderer/app.js'];
  const uiDir = path.join(root, 'src/renderer/ui');
  if (fs.existsSync(uiDir)) {
    for (const name of fs.readdirSync(uiDir)) if (name.endsWith('.js')) files.push(`src/renderer/ui/${name}`);
  }
  return files;
}

/**
 * app.js 顶层有一长串 $('xxx').onclick = …。页面上删掉或改名一个元素，模块在加载时就抛错，
 * 整个界面停在启动转圈 —— 而且没有任何报错能看见。所以这里把「用到的 id」和「页面上有的 id」对一遍。
 */
test('脚本里用到的元素 id 都在页面上（或由脚本自己创建）', () => {
  const html = read('src/renderer/index.html');
  const present = new Set([...html.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]));
  const created = new Set();
  const used = new Map();
  for (const f of rendererScripts()) {
    const src = read(f);
    for (const m of src.matchAll(/\bid: '([\w-]+)'/g)) created.add(m[1]);
    for (const m of src.matchAll(/\$\('([\w-]+)'\)/g)) used.set(m[1], f);
    for (const m of src.matchAll(/getElementById\('([\w-]+)'\)/g)) used.set(m[1], f);
  }
  assert.ok(used.size > 40, `只找到 ${used.size} 个 id，正则可能失效了`);
  const missing = [...used].filter(([id]) => !present.has(id) && !created.has(id));
  assert.deepEqual(missing, [], `这些 id 页面上没有：${missing.map(([id, f]) => `${id}（${f}）`).join('、')}`);
});

test('页签和面板一一对应，邀请页签默认隐藏（只给房主）', () => {
  const html = read('src/renderer/index.html');
  const tabs = [...html.matchAll(/id="tab-([\w-]+)"[^>]*data-tab="([\w-]+)"/g)];
  assert.deepEqual(tabs.map((m) => m[1]).sort(), ['invite', 'log', 'peers', 'transfer']);
  for (const [, id, dataTab] of tabs) {
    assert.equal(id, dataTab);
    assert.match(html, new RegExp(`id="panel-${id}"`), `缺少 panel-${id}`);
  }
  assert.match(html, /class="room-tab hidden" id="tab-invite"/);
  // 成员面板里装着成员列表，日志面板里装着事件日志 —— log() 和 renderPeers() 都按这两个 id 找
  assert.match(html, /id="panel-peers"[\s\S]*?id="peer-list"/);
  assert.match(html, /id="panel-log"[\s\S]*?id="event-log"/);
  // 老的「增加 / 切换视频」块已经换成列表上的加片按钮
  assert.doesNotMatch(html, /media-switch-block|btn-switch-file|btn-switch-link/);
  for (const id of ['playlist-panel', 'playlist-body', 'playlist-actions', 'btn-add-file', 'btn-add-link', 'chat-panel', 'chat-body']) {
    assert.match(html, new RegExp(`id="${id}"`), `缺少 ${id}`);
  }
});

test('房间固定高度、各块自己滚动；控制条用弹性占位而不是每个按钮 margin-left:auto', () => {
  const css = read('src/renderer/styles.css');
  assert.match(css, /#view-room\.active \{\s*display: flex;\s*overflow: hidden;/);
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\) minmax\(360px, 42%\);/);
  assert.match(css, /\.tab-panel \{[^}]*overflow-y: auto;/);
  assert.match(css, /\.playlist-body,\s*\.chat-body \{[^}]*overflow-y: auto;/);
  assert.doesNotMatch(css, /\.controls \.ghost \{\s*margin-left: auto;/);
  assert.match(css, /\.controls-spacer \{\s*flex: 1;/);
  assert.doesNotMatch(css, /#media-switch-block/);
});

test('房主进空房间先看到邀请页，用户动过页签后不再自动切；有人进来只点角标', () => {
  const app = read('src/renderer/app.js');
  const enter = app.slice(app.indexOf('async function enterRoom()'), app.indexOf('function selectRoomTab('));
  assert.match(enter, /\$\('tab-invite'\)\.classList\.toggle\('hidden', S\.role !== 'host'\)/);
  assert.match(enter, /S\.role === 'host' && connectedPeerCount\(\) === 0 && !tabTouched\) selectRoomTab\('invite'\)/);
  const select = app.slice(app.indexOf('function selectRoomTab('), app.indexOf('function notePeersChanged('));
  assert.match(select, /if \(byUser\) tabTouched = true;/);
  assert.match(select, /if \(name === 'log'\) \$\('event-log'\)\.scrollTop = \$\('event-log'\)\.scrollHeight;/);
  const peers = app.slice(app.indexOf('function renderPeers('), app.indexOf("$('peer-list').addEventListener"));
  assert.match(peers, /notePeersChanged\(\)/);
  // 页签的点击是用户操作
  assert.match(app, /selectRoomTab\(tab\.dataset\.tab, \{ byUser: true \}\)/);
});

test('加片入口跟着权限走：房主和管理员可见，游客看不到', () => {
  const app = read('src/renderer/app.js');
  assert.match(app, /const canEditPlaylist = \(\) => !!S\.sync\?\.canIControl\(\);/);
  assert.match(app, /\$\('playlist-actions'\)\.classList\.toggle\('hidden', !canEditPlaylist\(\)\)/);
  const roles = app.slice(app.indexOf("S.sync.on('roles'"), app.indexOf("S.sync.on('denied'"));
  assert.match(roles, /renderPlaylist\(\)/, '升降管理员后加片入口要跟着变');
  // 输入法选词时的回车不能当成提交
  assert.match(app, /if \(e\.key === 'Enter' && !e\.isComposing\) submitRoomLink\(\);/);
});

test('房间页上的中文静态文案都有英文', async () => {
  const { translate } = await import('../src/renderer/lib/i18n.js');
  const html = read('src/renderer/index.html');
  const room = html.slice(html.indexOf('<section id="view-room"'), html.indexOf('<!-- 设置 -->'));
  const texts = [...room.matchAll(/>([^<>]*[一-鿿][^<>]*)</g)].map((m) => m[1].trim()).filter(Boolean);
  assert.ok(texts.length > 10, `只找到 ${texts.length} 条文案`);
  const untranslated = texts.filter((text) => translate(text, 'en') === text);
  assert.deepEqual(untranslated, []);
  // 换片入口删掉以后，它的词条也不能留着
  for (const dead of ['增加 / 切换视频', '选择本地视频', '切换到视频链接', '成员保持连接，房主换片后会自动同步到全房。']) {
    assert.equal(translate(dead, 'en'), dead, `死翻译没删：${dead}`);
  }
  for (const line of [
    '还没有人加入。去「邀请」页签生成邀请链接。',
    '还没有其他成员。',
    '列表还是空的，点右上角加一部。',
    '列表还是空的，等房主加片。',
    '还没有消息',
    '正在播放',
  ]) {
    assert.notEqual(translate(line, 'en'), line, `缺英文：${line}`);
  }
});

test('默认窗口开大一点，但不超过工作区；最小尺寸不变', () => {
  const main = read('src/main/main.js');
  const fn = main.slice(main.indexOf('function createWindow()'), main.indexOf('function send('));
  assert.match(fn, /screen\.getPrimaryDisplay\(\)\.workAreaSize/);
  assert.match(fn, /width: Math\.max\(900, Math\.min\(1280, area\.width\)\)/);
  assert.match(fn, /height: Math\.max\(640, Math\.min\(820, area\.height\)\)/);
  assert.match(fn, /minWidth: 900,\s*minHeight: 640,/);
});

test('片子信息里的房间模式也翻成英文，不在英文句子里夹一段中文', async () => {
  const { translate } = await import('../src/renderer/lib/i18n.js');
  assert.equal(
    translate('4.3 MB · 3 片 × 2.0 MB · 可信房间 · 边下边播 · 你是片源', 'en'),
    '4.3 MB · 3 chunks × 2.0 MB · Trusted room · Progressive playback · You are the source'
  );
  assert.equal(
    translate('视频链接 · youtube · 1:00 · 安全模式 · 扫描后播放 · 每位成员从原网站播放', 'en'),
    'Video link · youtube · 1:00 · Safe mode · Play after scanning · Each member streams from the original site'
  );
});

/**
 * 手机加入的人要在成员列表上标出来：他跟得上列表、能聊天看弹幕，但编辑不了列表 ——
 * 房主知道这一点才不会干等他去调顺序。platform 从 HELLO 一路传到 swarm.peerList()，
 * 这里钉的是「渲染层真的用了它」，以及标记是独立元素（昵称是用户输入，不能把标记拼进去）。
 */
test('成员列表把手机加入的人标出来，标记不拼进昵称里', async () => {
  const app = read('src/renderer/app.js');
  const peers = app.slice(app.indexOf('function renderPeers('), app.indexOf("$('peer-list').addEventListener"));
  assert.match(peers, /peer\.platform === 'android'/, '要按 platform 判断，不是猜昵称');
  assert.match(peers, /className: 'peer-platform', text: '（手机）'/);
  const nameLine = peers.split('\n').find((line) => line.includes('className: `peer-name'));
  assert.ok(nameLine, '找不到昵称那一行');
  assert.doesNotMatch(nameLine, /手机/, '标记要单独一个元素，不能拼进 raw 的昵称里');

  // 中英都要有；昵称本身照旧不翻译
  const { translate } = await import('../src/renderer/lib/i18n.js');
  assert.equal(translate('（手机）', 'en'), ' (phone)');

  // 数据这一路是真的：swarm 把 HELLO 带来的 platform 暴露给了渲染层
  const swarm = read('src/renderer/lib/swarm.js');
  assert.match(swarm, /platform: peer\.platform \|\| 'desktop'/);
  assert.match(swarm, /peer\.platform = msg\.platform === 'android' \? 'android' : 'desktop'/);

  // 样式存在，否则标记会和昵称一样粗
  assert.match(read('src/renderer/styles.css'), /\.peer-platform \{/);
});
