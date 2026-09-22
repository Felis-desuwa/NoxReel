'use strict';

// 生成邀请链接失败时，界面不能停在「正在收集网络候选地址」上。
// 用户撞上的是 TURN 缺密码 —— RTCPeerConnection 的构造函数直接抛错，而「重新生成邀请链接」
// 那一路没人接住这个错，界面就一直挂着加载文字。这里用同一句 Chromium 报错把整条路径跑一遍。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8').replace(/\r\n/g, '\n');

function fnSource(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层函数 ${name}`);
  const end = APP.indexOf('\n}\n', m.index);
  return APP.slice(m.index, end + 2);
}

const CHROMIUM_ERROR =
  "Failed to construct 'RTCPeerConnection': ICE server parsing failed: TURN server with empty username or password";

function room({ peerThrows = true, previous = null } = {}) {
  const shown = [];
  const logs = [];
  const closed = [];
  const out = { id: 'inv-out' };
  class Peer {
    constructor() {
      if (peerThrows) throw new Error(CHROMIUM_ERROR);
    }
  }
  const S = { roomCapacity: 4, pendingManualPeer: previous, peerId: 'host', name: '房主', roomSecurityMode: 'trusted' };
  const ctx = { S, Peer, console, Promise, crypto: { randomUUID: () => '12345678-aaaa-bbbb-cccc-dddddddddddd' } };
  Object.assign(ctx, {
    $: (id) => (id === 'inv-out' ? out : null),
    make: (tag, opts = {}) => ({ tag, text: opts.text, style: {} }),
    replace: (target, ...nodes) => shown.push(nodes.flat().map((n) => n?.text).join('')),
    connectedPeerCount: () => 0,
    iceServers: () => [],
    log: (text, level) => logs.push([text, level]),
    inviteGen: 0,
  });
  vm.createContext(ctx);
  vm.runInContext([fnSource('inviteViaManual'), fnSource('createManualInvite')].join('\n\n'), ctx);
  if (previous) previous.close = () => closed.push('previous');
  return { ctx, S, shown, logs, closed };
}

test('生成邀请链接时建连接对象就失败：把原因写出来，不挂在加载文字上', async () => {
  const r = room();
  // 「重新生成邀请链接」的按钮是直接 () => inviteViaManual()，没有 catch —— 这里也不许 reject
  await r.ctx.inviteViaManual();
  assert.equal(r.shown[0], '正在收集网络候选地址（几秒钟）…');
  assert.equal(r.shown.at(-1), `没能生成邀请链接：${CHROMIUM_ERROR}`, '最后停在失败原因上，不是加载文字');
  assert.deepEqual(r.logs, [[`生成邀请链接失败：${CHROMIUM_ERROR}`, 'bad']]);
});

test('失败之后手上不留一条作废的邀请，下一次「邀请下一位」才会重新生成', async () => {
  const previous = { peerId: 'pending-old' };
  const r = room({ previous });
  await r.ctx.inviteViaManual();
  assert.equal(r.S.pendingManualPeer, null, '留着的话 openInvite 会以为还有一条能用的链接，不再重新生成');
  assert.ok(r.closed.length >= 1, '上一条照旧作废');
});

test('设置里拦下「开了 TURN 却没填用户名或密码」', () => {
  const save = APP.slice(APP.indexOf("okText: '保存',"), APP.indexOf("localStorage.setItem('sw.name', S.name);"));
  assert.match(
    save,
    /if \(\$\('set-turn-on'\)\.checked && \(!\$\('set-turn-user'\)\.value\.trim\(\) \|\| !\$\('set-turn-pass'\)\.value\.trim\(\)\)\) \{[\s\S]*?return false;/
  );
});

test('以前存下的坏配置：日志里说一声中继没生效（只说一次）', () => {
  const fn = fnSource('iceServers');
  assert.match(fn, /if \(!turnWarned && turnMissingCredentials\(S\.settings\)\) \{\s*turnWarned = true;\s*log\(/);
});

test('失败提示有英文', async () => {
  const { translate } = await import('../src/renderer/lib/i18n.js');
  assert.equal(translate('没能生成邀请链接：boom', 'en'), 'Could not create the invite link: boom');
  assert.equal(translate('生成邀请链接失败：boom', 'en'), 'Failed to create the invite link: boom');
  for (const line of [
    'TURN 中继开着但没填用户名或密码，这次先不走中继、只尝试直连。到设置里补全，或者把中继关掉。',
    'TURN 中继要填用户名和密码（中继服务器靠它们认人）。没有的话把「启用 TURN 中继」的勾去掉。',
  ]) {
    assert.notEqual(translate(line, 'en'), line);
  }
});
