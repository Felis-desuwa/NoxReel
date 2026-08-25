'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');

/**
 * 极简模式打洞可能一直连不上（对方在严格 NAT 后面，或邀请链接放太久、里面的网络地址
 * 已过期）。「正在打洞」这行字曾经只有 peer-authenticated 一条路能改，失败时没人收尾，
 * 界面就永远停在那里。失败、断开、超时三条路都必须有结局。
 */
test('房主侧的极简握手有失败、断开和超时三条收尾路径', () => {
  assert.match(app, /function watchManualHandshake\(/);
  assert.match(app, /watchManualHandshake\(peer, status\);/);

  const body = app.slice(app.indexOf('function watchManualHandshake('), app.indexOf('async function acceptManualAnswer('));
  assert.match(body, /S\.swarm\.on\('peer-authenticated'/, '连上了要收尾');
  assert.match(body, /peer\.on\('failed'/, '打洞失败要收尾');
  assert.match(body, /peer\.on\('close'/, '握手前断开要收尾');
  assert.match(body, /setTimeout\(/, '一直停在 checking 也要收尾');
  assert.match(body, /MANUAL_HANDSHAKE_TIMEOUT_MS/);
  // 收尾时要把失效连接摘掉并备好新链接，否则用户没有下一步可走。
  assert.match(body, /S\.swarm\.removePeer\(peer\.peerId\)/);
  assert.match(body, /inviteViaManual\(text\)/);
});

test('应答链接重复点开时给出提示而不是抛到无人接住的地方', () => {
  assert.doesNotMatch(app, /throw new Error\('当前没有等待应答的零服务器邀请'\)/);
  assert.match(app, /这条邀请已经用过或已失效/);
});

test('访客侧在房主粘贴前探测失败也能重新生成应答链接', () => {
  const body = app.slice(app.indexOf('async function joinViaManual('), app.indexOf('async function joinViaServer('));
  assert.match(body, /peer\.on\('failed'/, '访客侧同样不能永远停在等待');
  assert.match(body, /重新生成应答链接/);
  assert.match(body, /joinViaManual\(payload\)/, '重试要能用同一份邀请重开一条连接');
  assert.match(body, /S\.swarm\.removePeer\(payload\.from\)/, '重试前要摘掉上一条死连接');
});
