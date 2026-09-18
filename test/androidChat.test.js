'use strict';

/**
 * 安卓观众端的播放列表面板（只读）、聊天和弹幕（app-android.js + index.html）。
 *
 * 和 androidFollow.test.js 同一套路子：不起 WebView、不起 ExoPlayer，用假 DOM、
 * 假 Native（native-shim 原样加载，只把 Kotlin 桥换成内存里的假实现）和假房主连接，
 * 把 app-android.js 整个跑起来。假播放器只记命令，不出声也不解码。
 *
 * 假 DOM 在 helpers/androidDom.js，和 androidFollow 那份是同一套。
 *
 * 每条测试都重新 import 一份 app-android.js（URL 带不同的查询串），模块内的 S 互不相干；
 * 共享库（swarm / syncEngine / chat / danmaku / i18n / native-shim）只加载一次。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const { fakeDocument, rowsOf } = require('./helpers/androidDom.js');

const ASSETS = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'assets');
const JS = path.join(ASSETS, 'js');
const assetUrl = (file) => pathToFileURL(path.join(JS, file)).href;

const HOST_ID = 'HOSTPEER01';
const CHUNK = 1024 * 1024;

const realConsoleLog = console.log;
const realPerfNow = performance.now;
const realWebSocket = globalThis.WebSocket;
const savedGlobals = ['requestAnimationFrame', 'cancelAnimationFrame'].map((key) => [
  key,
  Object.getOwnPropertyDescriptor(globalThis, key),
]);

test.after(() => {
  console.log = realConsoleLog;
  performance.now = realPerfNow;
  Object.defineProperty(globalThis, 'WebSocket', { value: realWebSocket, configurable: true, writable: true });
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

/* ------------------------------ 假 Native ------------------------------ */

function fakeNative() {
  const calls = [];
  let seq = 0;
  let player = null;
  const now = () => Date.now();
  const position = () => (player ? (player.paused ? player.base : player.base + (now() - player.at) / 1000) : 0);
  const native = {
    calls,
    stateFor: null,
    mediaDuration: 0,
    openLeech(fileId) {
      calls.push(['openLeech', fileId]);
      return `leech-${++seq}`;
    },
    sessionState(sessionId) {
      return JSON.stringify(native.stateFor?.(sessionId) || { bitfield: '', haveCount: 0, contiguousBytes: 0, complete: false });
    },
    contiguousBytes() {
      return '0';
    },
    closeSession(sessionId) {
      calls.push(['closeSession', sessionId]);
    },
    readChunk() {
      return null;
    },
    writeChunk() {
      return JSON.stringify({ ok: false, reason: 'test' });
    },
    playerLoad(sessionId) {
      calls.push(['playerLoad', sessionId]);
      player = { base: 0, at: now(), paused: true, duration: native.mediaDuration };
      return true;
    },
    playerLoadUrl(url) {
      calls.push(['playerLoadUrl', url]);
      player = { base: 0, at: now(), paused: true, duration: native.mediaDuration };
      return true;
    },
    playerSetPause(paused) {
      calls.push(['setPause', paused]);
      if (!player) return;
      player.base = position();
      player.at = now();
      player.paused = !!paused;
    },
    playerSeek(seconds) {
      calls.push(['seek', seconds]);
      if (!player) return;
      player.base = seconds;
      player.at = now();
    },
    playerSnapshot() {
      if (!player) return JSON.stringify({ position: 0, duration: 0, paused: true, idle: true, eof: false });
      return JSON.stringify({ position: position(), duration: player.duration, paused: player.paused, idle: false, eof: false });
    },
    playerRelease() {
      calls.push(['release']);
      player = null;
    },
    log() {},
  };
  return native;
}

class SilentWebSocket {
  constructor(url) {
    this.url = url;
  }
  send() {}
  close() {}
}

/* ------------------------------ 共享库挂钩 ------------------------------ */

let hooks = null;
async function installHooks() {
  if (hooks) return hooks;
  // native-shim 只加载一次，它把 console.log 包了一层（先送 Native.log）。
  // 趁它加载前换成空函数，应用日志就只进假 Native，不刷屏。
  console.log = () => {};
  globalThis.window = globalThis.window || {};
  const { Swarm } = await import(assetUrl('swarm.js'));
  const { SyncEngine } = await import(assetUrl('syncEngine.js'));
  const protocol = await import(assetUrl('protocol.js'));
  const i18n = await import(assetUrl('i18n.js'));
  const swarms = [];
  const syncs = [];
  const origStart = Swarm.prototype.start;
  Swarm.prototype.start = function start(...args) {
    swarms.push(this);
    return origStart.apply(this, args);
  };
  const origOnCtrl = SyncEngine.prototype.onCtrl;
  SyncEngine.prototype.onCtrl = function onCtrl(...args) {
    if (!syncs.includes(this)) syncs.push(this);
    return origOnCtrl.apply(this, args);
  };
  hooks = { swarms, syncs, protocol, i18n };
  return hooks;
}

/* ------------------------------ 测试数据 ------------------------------ */

const sha256 = (s) => nodeCrypto.createHash('sha256').update(s).digest('hex');

function makeManifest(tag, { chunkCount = 4, durationSec = 1200 } = {}) {
  const hashes = Array.from({ length: chunkCount }, (_, i) => sha256(`${tag}:${i}`));
  return {
    fileId: sha256(hashes.join('')).slice(0, 32),
    name: `${tag}.mp4`,
    size: chunkCount * CHUNK,
    chunkSize: CHUNK,
    chunkCount,
    hashes,
    durationSec,
  };
}

let itemNo = 0;
function fileItem(manifest, slot, extra = {}) {
  itemNo++;
  return {
    id: 'a0b0c0d0' + itemNo.toString(16).padStart(8, '0'),
    kind: 'file',
    slot,
    fileId: manifest.fileId,
    name: manifest.name,
    size: manifest.size,
    chunkSize: manifest.chunkSize,
    chunkCount: manifest.chunkCount,
    durationSec: manifest.durationSec,
    addedBy: HOST_ID,
    ...extra,
  };
}

function linkItem(url, extra = {}) {
  itemNo++;
  return {
    id: 'b0c0d0e0' + itemNo.toString(16).padStart(8, '0'),
    kind: 'link',
    url,
    title: '在线',
    durationSec: 600,
    addedBy: HOST_ID,
    ...extra,
  };
}

function playlistMsg({ rev, seq, queue, history = [], started = true, nextSlot = 10 }) {
  return { t: 'playlist', state: { rev, seq, queue, history, started, autoplay: true, nextSlot } };
}

function fakePeer(peerId, name, { authenticated = true } = {}) {
  return {
    peerId,
    name,
    pc: { iceConnectionState: 'connected' },
    authenticated,
    remote: new Map(),
    inflight: new Set(),
    ctrl: { readyState: 'open', bufferedAmount: 0 },
    sent: [],
    closed: false,
    send(m) {
      this.sent.push(m);
      return true;
    },
    on() {
      return () => {};
    },
    close() {
      this.closed = true;
    },
    async sendChunk() {},
    ping() {},
    hello() {},
  };
}

const ofType = (peer, t) => peer.sent.filter((m) => m.t === t);

let msgNo = 0;
const msgId = () => (0x100000000000 + ++msgNo).toString(16).slice(-12);

async function flush(rounds = 30) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

/* ------------------------------ 启动一台手机 ------------------------------ */

let caseNo = 0;

async function bootPhone(t, { securityMode = 'trusted', role = 'guest', name = '小明', storage = {} } = {}) {
  const h = await installHooks();
  // 每条测试都从简体中文起步：startI18n 在英文下会去建 MutationObserver，假 DOM 没有它
  h.i18n.setLocale('zh-CN');
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 });
  performance.now = () => Date.now();
  t.after(() => {
    performance.now = realPerfNow;
    h.i18n.setLocale('zh-CN');
  });

  const store = new Map([['sw.securityMode', securityMode], ...Object.entries(storage)]);
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.window.localStorage = globalThis.localStorage;
  globalThis.document = fakeDocument();
  globalThis.location = { reload() {} };
  globalThis.Native = fakeNative();
  Object.defineProperty(globalThis, 'WebSocket', { value: SilentWebSocket, configurable: true, writable: true });

  // 假 rAF：排着队等测试手动步进，弹幕帧循环转没转一眼看得见
  let rafSeq = 0;
  let rafCalls = 0;
  let rafCancels = 0;
  const rafQueue = new Map();
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    value: (fn) => {
      rafCalls++;
      const id = ++rafSeq;
      rafQueue.set(id, fn);
      return id;
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    value: (id) => {
      rafCancels++;
      rafQueue.delete(id);
    },
    configurable: true,
    writable: true,
  });

  const swarmCount = h.swarms.length;
  await import(assetUrl('app-android.js') + `?case=${++caseNo}`);
  const $ = (id) => globalThis.document.getElementById(id);
  // 弹幕层的尺寸：真机上由布局给，这里手动摆一个横屏大小
  $('danmaku').clientWidth = 800;
  $('danmaku').clientHeight = 400;
  $('name').value = name;
  $('url').value = 'ws://127.0.0.1:9';
  $('room').value = 'room';
  $('join').click();
  await flush(2);
  assert.equal(h.swarms.length, swarmCount + 1, '进房后应当建好 swarm');
  const swarm = h.swarms.at(-1);

  const host = fakePeer(HOST_ID, '房主');
  swarm.addPeer(host);
  const syncCount = h.syncs.length;
  const roles = role === 'guest' ? [[swarm.peerId, 'guest']] : [[swarm.peerId, role]];
  swarm._onCtrl(host, { t: 'role', hostId: HOST_ID, roles });
  assert.equal(h.syncs.length, syncCount + 1);
  const sync = h.syncs.at(-1);

  let lamport = 0;
  const phone = {
    h,
    $,
    swarm,
    sync,
    host,
    store,
    name,
    get peerId() {
      return swarm.peerId;
    },
    send(msg) {
      swarm._onCtrl(host, msg);
    },
    sendFrom(peer, msg) {
      swarm._onCtrl(peer, msg);
    },
    /** 新来一位并完成握手（走真的 HELLO，好让 peer-authenticated 事件真的发出来）。 */
    join(peerId, peerName) {
      const peer = fakePeer(peerId, peerName, { authenticated: false });
      swarm.addPeer(peer);
      swarm._onCtrl(peer, {
        t: 'hello',
        ver: h.protocol.PROTOCOL_VERSION,
        peerId,
        name: peerName,
        securityMode,
        platform: 'desktop',
      });
      return peer;
    },
    hostSync({ paused, position, seq }) {
      swarm._onCtrl(host, { t: 'sync', paused, position, lamport: ++lamport + 100, by: HOST_ID, name: '房主', seq });
    },
    /** 某条连接发来一条聊天（默认是房主那条）。origin/originName 用来试转发。 */
    chat({ id = msgId(), text, ts = Date.now(), origin, originName, peer = host }) {
      const msg = { t: 'chat', id, text, ts };
      if (origin) msg.origin = origin;
      if (originName) msg.originName = originName;
      swarm._onCtrl(peer, msg);
      return id;
    },
    type(text) {
      $('chat-input').value = text;
    },
    chatRows: () => rowsOf($('chat-body')),
    chatTexts: () => rowsOf($('chat-body')).map((r) => r.text),
    playlistRows: () => rowsOf($('playlist-body')),
    danmakuNodes: () => $('danmaku').children,
    outboundChats: () => ofType(host, 'chat'),
    rafStats: () => ({ calls: rafCalls, cancels: rafCancels, queued: rafQueue.size }),
    /** 步进 n 个动画帧（每帧推进 ms 毫秒）。 */
    async frames(n = 1, ms = 16) {
      for (let i = 0; i < n; i++) {
        t.mock.timers.tick(ms);
        const first = rafQueue.entries().next();
        if (first.done) return i;
        const [id, fn] = first.value;
        rafQueue.delete(id);
        fn(Date.now());
        await flush(2);
      }
      return n;
    },
    async advance(ms, step = 50) {
      for (let done = 0; done < ms; done += step) {
        t.mock.timers.tick(Math.min(step, ms - done));
        await flush(4);
      }
    },
    nativeCalls: (kind) => globalThis.Native.calls.filter((c) => c[0] === kind),
  };
  return phone;
}

/** 让手机进到播放层：给一条链接并批准站点，播放器就跑起来了。 */
async function startLink(phone, { seq = 1, rev = 1, url = 'https://video.example.org/a.m3u8' } = {}) {
  phone.send(playlistMsg({ rev, seq, queue: [linkItem(url)] }));
  await flush();
  phone.send({ t: 'now-link', seq, playback: { url, headers: {} } });
  await flush();
  phone.$('site-allow').click();
  await flush();
}

/* ======================== 一、播放列表面板只读 ======================== */

test('安卓端：播放列表面板只读，没有任何编辑入口', async (t) => {
  const phone = await bootPhone(t);
  const a = makeManifest('A');
  const b = makeManifest('B');
  const c = makeManifest('C');
  phone.send(
    playlistMsg({ rev: 1, seq: 2, queue: [fileItem(a, 1), fileItem(b, 2)], history: [fileItem(c, 3)] })
  );
  await flush();

  const rows = phone.playlistRows();
  assert.deepEqual(
    rows.map((r) => r.text),
    ['正在播放A.mp4', '待播B.mp4', '已播放C.mp4']
  );
  assert.deepEqual(
    rows.map((r) => r.className),
    ['pl-row now', 'pl-row next', 'pl-row done']
  );
  // 片名是用户输入：必须打跳过标记，不能被自动翻译改写
  const nameCell = phone.$('playlist-body').children[0].children[1];
  assert.equal(nameCell.getAttribute('data-i18n-skip'), '');
  assert.equal(nameCell.getAttribute('title'), 'A.mp4');

  // 手机收到列表操作也不会应用：这条路根本不存在
  phone.send({ t: 'playlist-op', op: { type: 'remove', id: rows[1] }, rev: 2 });
  await flush();
  assert.deepEqual(
    phone.playlistRows().map((r) => r.text),
    ['正在播放A.mp4', '待播B.mp4', '已播放C.mp4'],
    '列表操作不该改变手机上的列表'
  );
  assert.equal(phone.host.sent.filter((m) => String(m.t).startsWith('playlist')).length, 0, '手机不发任何列表消息');
});

test('安卓端：app-android.js 里没有列表编辑那一套，界面上也只有一个关闭按钮', async () => {
  const src = fs.readFileSync(path.join(JS, 'app-android.js'), 'utf8');
  // 注释里提到这些词是说明「故意没有」，扫描只看代码
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['PLAYLIST_OP', 'playlist-op', 'applyOp', 'reorderIds', 'markStarted', 'PLAYLIST_ACK']) {
    assert.ok(!code.includes(forbidden), `手机端不该出现 ${forbidden}`);
  }
  // 聊天正文、昵称、片名都是别人给的字符串：只能走 textContent
  assert.ok(!code.includes('innerHTML'), '不许拼 innerHTML');
  // 站点授权改用页面里的对话框，不再用会堵住整个 JS 线程的原生弹窗
  assert.ok(!code.includes('confirm('), '不该再用 window.confirm');
  assert.ok(code.includes('askSite'), '要有按站点授权的对话框');

  const html = fs.readFileSync(path.join(ASSETS, 'index.html'), 'utf8');
  const sheet = html.slice(html.indexOf('<div id="playlist-sheet"'), html.indexOf('<div id="chat-sheet"'));
  assert.ok(sheet.length > 100, '找不到播放列表面板');
  assert.match(sheet, /手机端暂不支持编辑列表/);
  const buttons = sheet.match(/<button[^>]*>/g) || [];
  assert.equal(buttons.length, 1, '只读面板里只能有关闭按钮');
  assert.match(buttons[0], /id="playlist-close"/);
  assert.equal((sheet.match(/<input|<textarea|<select/g) || []).length, 0, '只读面板里不能有输入控件');
  // 弹幕层必须不吃触摸，否则整块画面都点不动
  assert.match(html, /#danmaku \{[^}]*pointer-events:none/);
});

test('安卓端：本机被设成管理员时，说清楚能控制播放但不能编辑列表', async (t) => {
  const phone = await bootPhone(t, { role: 'admin' });
  phone.send(playlistMsg({ rev: 1, seq: 1, queue: [linkItem('https://video.example.org/x.m3u8')] }));
  await flush();
  assert.equal(phone.$('role-hint').textContent, '身份：管理员 · 可以控制播放，但手机端不能编辑列表');
  assert.equal(phone.$('seek').disabled, false);
});

test('安卓端：游客还是老样子——只影响自己、不能拖进度', async (t) => {
  const phone = await bootPhone(t, { role: 'guest' });
  phone.send(playlistMsg({ rev: 1, seq: 1, queue: [linkItem('https://video.example.org/x.m3u8')] }));
  await flush();
  assert.equal(phone.$('role-hint').textContent, '身份：游客 · 播放/暂停仅对自己生效，不能拖动进度');
  assert.equal(phone.$('seek').disabled, true);
});

/* ======================== 二、聊天收发 ======================== */

test('安卓端：发出去的消息先是「发送中」，房主转回来才算已送达', async (t) => {
  const phone = await bootPhone(t);
  await startLink(phone);
  phone.$('btn-chat').click();

  phone.type('大家好');
  phone.$('chat-send').click();
  await flush();

  const sent = phone.outboundChats();
  assert.equal(sent.length, 1, '要发给房主');
  assert.equal(sent[0].text, '大家好');
  assert.match(sent[0].id, /^[0-9a-f]{12}$/);
  assert.equal(sent[0].origin, undefined, '手机不是房主，不许自称转发者');
  assert.equal(phone.$('chat-input').value, '', '发出去了就清空输入框');

  let rows = phone.chatRows().filter((r) => r.className.startsWith('chat-msg'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, '小明大家好发送中');

  // 房主把同一条转回来：这是送达回执，不是新消息
  phone.chat({ id: sent[0].id, text: '大家好', origin: phone.peerId, originName: '小明' });
  await flush();
  rows = phone.chatRows().filter((r) => r.className.startsWith('chat-msg'));
  assert.equal(rows.length, 1, '回声不能再显示一行');
  assert.equal(rows[0].text, '小明大家好已送达');
});

test('安卓端：聊天限速——突发 5 条后提示发得太快，输入框里的字留着', async (t) => {
  const phone = await bootPhone(t);
  await startLink(phone);
  for (let i = 0; i < 5; i++) {
    phone.type(`第 ${i} 条`);
    phone.$('chat-send').click();
    await flush(2);
  }
  assert.equal(phone.outboundChats().length, 5);

  phone.type('第 5 条');
  phone.$('chat-send').click();
  await flush(2);
  assert.equal(phone.outboundChats().length, 5, '超额的不发出去');
  assert.equal(phone.$('chat-input').value, '第 5 条', '没被收下时字要留着');
  assert.match(phone.$('chat-notice').textContent, /^发得太快了（\d+ 秒后再试）$/);
  assert.equal(phone.$('chat-notice').classList.contains('off'), false);

  // 令牌回得来：过一秒又能发
  await phone.advance(1200);
  phone.$('chat-send').click();
  await flush(2);
  assert.equal(phone.outboundChats().length, 6);
});

test('安卓端：回车发送只在 !isComposing 时算数（拼音选词不误发）', async (t) => {
  const phone = await bootPhone(t);
  await startLink(phone);
  const input = phone.$('chat-input');

  input.value = '拼音中';
  input.dispatch('keydown', { key: 'Enter', isComposing: true, preventDefault() {} });
  await flush(2);
  assert.equal(phone.outboundChats().length, 0, '选词时的回车不是发送');
  assert.equal(input.value, '拼音中');

  input.dispatch('keydown', { key: 'Enter', isComposing: false, preventDefault() {} });
  await flush(2);
  assert.equal(phone.outboundChats().length, 1);
  assert.equal(phone.outboundChats()[0].text, '拼音中');

  // Shift+回车留给换行
  input.value = '换行';
  input.dispatch('keydown', { key: 'Enter', shiftKey: true, preventDefault() {} });
  await flush(2);
  assert.equal(phone.outboundChats().length, 1);
});

test('安卓端：收端先去重再扣令牌，只认房主转发来的 origin', async (t) => {
  const phone = await bootPhone(t);
  await startLink(phone);
  const other = phone.join('PEERB', '阿里');

  // 同一条从两条路径到（直连一份、房主转发一份）：只显示一行，也只吃一个令牌
  const id = msgId();
  phone.chat({ id, text: '同一条', peer: other });
  phone.chat({ id, text: '同一条', origin: 'PEERB', originName: '阿里' });
  await flush();
  let msgs = phone.chatRows().filter((r) => r.className.startsWith('chat-msg'));
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, '阿里同一条');

  // 非房主自称替别人转发：一律按他本人算
  phone.chat({ id: msgId(), text: '我是房主', origin: HOST_ID, originName: '房主', peer: other });
  await flush();
  msgs = phone.chatRows().filter((r) => r.className.startsWith('chat-msg'));
  assert.equal(msgs.at(-1).text, '阿里我是房主', '冒充转发不算数');

  // 刷屏的被令牌桶吃掉：突发 5 条，第 6 条就进不来了
  const before = phone.chatRows().filter((r) => r.className.startsWith('chat-msg')).length;
  for (let i = 0; i < 10; i++) phone.chat({ id: msgId(), text: `刷 ${i}`, peer: other });
  await flush();
  const after = phone.chatRows().filter((r) => r.className.startsWith('chat-msg')).length;
  assert.ok(after - before <= 5, `收端也要限速，实际收下 ${after - before} 条`);
  assert.ok(after - before >= 3, '限速不该把正常发言全吃掉');
});

test('安卓端：聊天历史只收一次，前面补一条分隔线，而且不上弹幕', async (t) => {
  const phone = await bootPhone(t);
  await startLink(phone);
  const older = msgId();
  const newer = msgId();

  phone.send({
    t: 'chat-history',
    items: [
      { id: older, text: '你来之前说的第一句', from: 'PEERB', name: '阿里', at: 1 },
      { id: newer, text: '第二句', from: 'PEERB', name: '阿里', at: 2 },
    ],
  });
  await flush();

  const texts = phone.chatTexts();
  assert.deepEqual(texts.slice(0, 3), ['阿里你来之前说的第一句', '阿里第二句', '你加入前的消息']);
  assert.equal(phone.chatRows()[2].className, 'chat-divider');
  // 历史只进列表、不上弹幕
  assert.equal(phone.danmakuNodes().length, 0);
  assert.equal(phone.rafStats().calls, 1, '只有起播时叫醒过一次，历史不该再叫帧循环');

  // 第二包历史一律不收
  phone.send({ t: 'chat-history', items: [{ id: msgId(), text: '又来一包', from: 'PEERB', name: '阿里', at: 3 }] });
  await flush();
  assert.ok(!phone.chatTexts().some((s) => s.includes('又来一包')), '历史只收一次');
  assert.equal(phone.chatTexts().filter((s) => s === '你加入前的消息').length, 1);

  // 房主随后又把历史里那条转发过来：认得出是旧的，不再显示一遍
  phone.chat({ id: older, text: '你来之前说的第一句', origin: 'PEERB', originName: '阿里' });
  await flush();
  assert.equal(phone.chatTexts().filter((s) => s === '阿里你来之前说的第一句').length, 1);
});

test('安卓端：非房主发来的聊天历史一概不看', async (t) => {
  const phone = await bootPhone(t);
  await startLink(phone);
  const other = phone.join('PEERB', '阿里');
  phone.sendFrom(other, {
    t: 'chat-history',
    items: [{ id: msgId(), text: '伪造的历史', from: 'PEERB', name: '阿里', at: 1 }],
  });
  await flush();
  assert.ok(!phone.chatTexts().some((s) => s.includes('伪造的历史')));

  // 挡掉冒牌货之后，房主那份照样收得下
  phone.send({ t: 'chat-history', items: [{ id: msgId(), text: '真历史', from: 'PEERB', name: '阿里', at: 1 }] });
  await flush();
  assert.ok(phone.chatTexts().some((s) => s.includes('真历史')));
});

/* ======================== 三、系统事件 ======================== */

test('安卓端：进出房、换片、谁按了暂停都显示在聊天流里', async (t) => {
  const phone = await bootPhone(t);
  await startLink(phone);
  const systems = () => phone.chatRows().filter((r) => r.className === 'chat-system').map((r) => r.text);

  assert.deepEqual(systems(), ['现在放：在线'], '进房时的第一条就是换片');

  phone.join('PEERB', '阿里');
  await flush();
  assert.ok(systems().includes('阿里 加入了房间'));

  phone.swarm.removePeer('PEERB');
  await flush();
  assert.ok(systems().includes('阿里 离开了房间'));

  // 房主按了暂停 / 播放：聊天流里各记一行，时间点也带上
  phone.hostSync({ paused: true, position: 83, seq: 1 });
  await flush();
  assert.ok(
    systems().some((s) => /^房主 暂停 @ 1:23$/.test(s)),
    `实际的系统事件：${JSON.stringify(systems())}`
  );
  phone.hostSync({ paused: false, position: 83, seq: 1 });
  await flush();
  assert.ok(systems().some((s) => /^房主 播放 @ 1:23$/.test(s)));

  // 换到下一部
  phone.send(playlistMsg({ rev: 2, seq: 2, queue: [linkItem('https://video.example.org/b.m3u8', { title: '第二部' })] }));
  await flush();
  assert.ok(systems().includes('现在放：第二部'));
});

/* ======================== 四、弹幕 ======================== */

test('安卓端：播放器没在跑时弹幕一帧都不画', async (t) => {
  const phone = await bootPhone(t);
  phone.send(playlistMsg({ rev: 1, seq: 1, queue: [linkItem('https://video.example.org/a.m3u8')] }));
  await flush();
  assert.equal(phone.nativeCalls('playerLoadUrl').length, 0, '还没批准站点，播放器不该起来');

  phone.chat({ text: '播放器还没起来' });
  await flush();
  assert.equal(phone.rafStats().calls, 0, '播放器没在跑就不该排帧');
  assert.equal(phone.danmakuNodes().length, 0);
  // 消息本身照样进聊天流
  assert.ok(phone.chatTexts().some((s) => s.includes('播放器还没起来')));

  // 播放器起来之后，没在跑那会儿说的话也不该补飘出来 —— 弹幕的价值在「此刻」
  phone.send({ t: 'now-link', seq: 1, playback: { url: 'https://video.example.org/a.m3u8', headers: {} } });
  await flush();
  phone.$('site-allow').click();
  await flush();
  assert.equal(phone.nativeCalls('playerLoadUrl').length, 1);
  await phone.frames(3);
  assert.equal(phone.danmakuNodes().length, 0, '起播前说的话不该攒着补飘');

  phone.chat({ text: '现在说的' });
  await flush();
  await phone.frames(1);
  assert.deepEqual(
    phone.danmakuNodes().map((n) => n.textContent),
    ['现在说的']
  );
});

test('安卓端：播放器跑起来后弹幕才转，换片时停帧并清场', async (t) => {
  const phone = await bootPhone(t);
  await startLink(phone);
  assert.equal(phone.nativeCalls('playerLoadUrl').length, 1);
  await phone.frames(2);
  assert.equal(phone.danmakuNodes().length, 0, '没人说话时不该有节点');

  phone.chat({ text: '来了来了' });
  await flush();
  await phone.frames(1);
  const nodes = phone.danmakuNodes();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].textContent, '来了来了');
  assert.equal(nodes[0].getAttribute('data-i18n-skip'), '', '弹幕正文是用户输入，绝不能被翻译');
  assert.equal(nodes[0].className, 'dm');
  assert.match(nodes[0].style.transform, /^translate3d\(-?\d+px, \d+px, 0\)$/);

  // 自己发的加描边
  phone.type('我说的');
  phone.$('chat-send').click();
  await flush();
  await phone.frames(1);
  assert.ok(
    phone.danmakuNodes().some((n) => n.className === 'dm self' && n.textContent === '我说的'),
    '自己发的弹幕要加描边'
  );

  // 一路飘到左边出屏就该下场（速度 800/8000=0.1 px/ms，两条都飘完要好几秒）
  await phone.frames(120, 100);
  assert.equal(phone.danmakuNodes().length, 0, '飘完了就该清干净');
  assert.equal(phone.rafStats().queued, 0, '场上空了要停表，不能空转');

  // 换片：停帧、清场
  phone.chat({ text: '还在飘' });
  await flush();
  await phone.frames(1);
  assert.equal(phone.danmakuNodes().length, 1);
  const cancelsBefore = phone.rafStats().cancels;
  phone.send(playlistMsg({ rev: 2, seq: 2, queue: [linkItem('https://video.example.org/b.m3u8')] }));
  await flush();
  assert.equal(phone.danmakuNodes().length, 0, '换片要整场清空');
  assert.ok(phone.rafStats().cancels > cancelsBefore, '换片要把排着的帧撤掉');
  assert.equal(phone.rafStats().queued, 0);
});

/* ======================== 五、弹幕的本地设置 ======================== */

test('安卓端：弹幕设置存 localStorage，改完立刻生效', async (t) => {
  const phone = await bootPhone(t);
  await startLink(phone);

  // 手机默认字号比桌面小一档
  assert.equal(phone.$('dm-font').value, '0.8');
  assert.equal(phone.$('dm-enabled').checked, true);
  assert.equal(phone.$('dm-area').value, 'half');

  phone.$('dm-opacity').value = '0.4';
  phone.$('dm-opacity').dispatch('input');
  phone.$('dm-area').value = 'full';
  phone.$('dm-area').dispatch('change');
  await flush(2);
  const saved = JSON.parse(phone.store.get('sw.danmaku'));
  assert.equal(saved.opacity, 0.4);
  assert.equal(saved.area, 'full');
  assert.equal(saved.fontScale, 0.8);

  // 超出范围的滑块值按范围夹住，不会把排布算崩
  phone.$('dm-speed').value = '99';
  phone.$('dm-speed').dispatch('input');
  await flush(2);
  assert.equal(JSON.parse(phone.store.get('sw.danmaku')).speed, 4);

  // 关掉弹幕：聊天照收，但一个节点都不画
  phone.$('dm-enabled').checked = false;
  phone.$('dm-enabled').dispatch('change');
  await flush(2);
  assert.equal(JSON.parse(phone.store.get('sw.danmaku')).enabled, false);
  assert.equal(phone.$('btn-danmaku').classList.contains('dm-off'), true);
  phone.chat({ text: '关掉之后' });
  await flush();
  await phone.frames(2);
  assert.equal(phone.danmakuNodes().length, 0, '关掉弹幕后不该再画');
  assert.ok(phone.chatTexts().some((s) => s.includes('关掉之后')), '聊天流照旧');

  // 再打开就恢复
  phone.$('dm-enabled').checked = true;
  phone.$('dm-enabled').dispatch('change');
  await flush(2);
  phone.chat({ text: '又开了' });
  await flush();
  await phone.frames(1);
  assert.equal(phone.danmakuNodes().length, 1);
});

test('安卓端：localStorage 里的坏设置一律回落到默认，不会抛', async (t) => {
  const phone = await bootPhone(t, {
    storage: { 'sw.danmaku': '{"opacity":"abc","area":"银河系","speed":99,"fontScale":-5,"enabled":"yes"}' },
  });
  assert.equal(phone.$('dm-opacity').value, '0.85');
  assert.equal(phone.$('dm-area').value, 'half');
  assert.equal(phone.$('dm-speed').value, '4');
  assert.equal(phone.$('dm-font').value, '0.5');
  assert.equal(phone.$('dm-enabled').checked, true);
});

test('安卓端：localStorage 里存着一段不是 JSON 的东西，也只当作没设置过', async (t) => {
  const phone = await bootPhone(t, { storage: { 'sw.danmaku': '{ 不是 JSON' } });
  assert.equal(phone.$('dm-font').value, '0.8');
  assert.equal(phone.$('dm-enabled').checked, true);
});

/* ======================== 六、抽屉与未读 ======================== */

test('安卓端：三个抽屉一次只开一个，聊天没开着时按钮上挂未读数', async (t) => {
  const phone = await bootPhone(t);
  await startLink(phone);
  const on = (id) => phone.$(id).classList.contains('on');

  phone.$('btn-playlist').click();
  assert.ok(on('playlist-sheet') && on('btn-playlist'));
  phone.$('btn-chat').click();
  assert.ok(on('chat-sheet') && !on('playlist-sheet'), '开一个就关掉另一个');
  phone.$('chat-close').click();
  assert.ok(!on('chat-sheet') && !on('btn-chat'));

  // 聊天没开着：按钮上挂未读数
  phone.chat({ text: '有人说话' });
  phone.chat({ text: '又有人说话' });
  await flush();
  assert.equal(phone.$('chat-unread').textContent, '2');
  assert.ok(phone.$('chat-unread').classList.contains('on'));

  phone.$('btn-chat').click();
  assert.equal(phone.$('chat-unread').textContent, '');
  assert.ok(!phone.$('chat-unread').classList.contains('on'));

  // 开着的时候来的消息不算未读；自己发的也不算
  phone.chat({ text: '开着时来的' });
  phone.type('我说的');
  phone.$('chat-send').click();
  await flush();
  assert.equal(phone.$('chat-unread').textContent, '');
});

test('安卓端：往上翻着看旧消息时，新消息不会把人拽回底下', async (t) => {
  const phone = await bootPhone(t);
  await startLink(phone);
  phone.$('btn-chat').click();
  const body = phone.$('chat-body');
  body.clientHeight = 100;
  body.scrollHeight = 500;

  body.scrollTop = 0; // 正往上翻
  phone.chat({ text: '新消息' });
  await flush();
  assert.equal(body.scrollTop, 0, '别把正在看旧消息的人拽回底下');

  body.scrollTop = 490; // 又回到底下了
  phone.chat({ text: '再一条' });
  await flush();
  assert.equal(body.scrollTop, 500, '看着最新消息时要跟着往下滚');
});

/* ======================== 七、文案：中英与 raw 不翻译 ======================== */

test('安卓端：界面文案跟着语言走，聊天正文和昵称原样保留', async (t) => {
  const phone = await bootPhone(t);
  await startLink(phone);
  // 昵称和正文故意取词条表里有的词：不跳过就一定会被翻掉
  phone.chat({ id: msgId(), text: '安全模式', origin: 'PEERB', originName: '可信房间' });
  await flush();
  assert.ok(phone.chatTexts().includes('可信房间安全模式'));

  phone.h.i18n.setLocale('en');
  phone.type('界面语言');
  phone.$('chat-send').click();
  await flush();

  const texts = phone.chatTexts();
  // 已经画好的旧行按 key 复用，不会重画；新行按当前语言画
  assert.ok(texts.includes('小明界面语言Sending…'), `实际：${JSON.stringify(texts)}`);
  const row = phone.$('chat-body').children.at(-1);
  assert.equal(row.children[0].textContent, '小明', '昵称原样');
  assert.equal(row.children[0].getAttribute('data-i18n-skip'), '');
  assert.equal(row.children[1].textContent, '界面语言', '正文原样');
  assert.equal(row.children[1].getAttribute('data-i18n-skip'), '');
  assert.equal(row.children[2].textContent, 'Sending…', '我们自己的文案要翻');

  // 系统事件整句翻译，昵称靠捕获原样带过去
  phone.join('PEERB', '安全模式');
  await flush();
  const systems = phone.chatRows().filter((r) => r.className === 'chat-system').map((r) => r.text);
  assert.ok(systems.includes('安全模式 joined the room'), `实际：${JSON.stringify(systems)}`);

  // 只读列表：标签翻，片名不翻
  phone.send(playlistMsg({ rev: 2, seq: 2, queue: [linkItem('https://video.example.org/b.m3u8', { title: '可信房间' })] }));
  await flush();
  const rows = phone.playlistRows();
  assert.equal(rows[0].text, 'Now playing可信房间');
  assert.equal(phone.$('playlist-body').children[0].children[1].getAttribute('data-i18n-skip'), '');
});

/* ======================== 八、链接项：按站点授权 ======================== */

test('安卓端：链接按站点授权——拒绝就不连，同一站点只问一次', async (t) => {
  const phone = await bootPhone(t);
  phone.send(playlistMsg({ rev: 1, seq: 1, queue: [linkItem('https://video.example.org/watch')] }));
  await flush();
  phone.send({ t: 'now-link', seq: 1, playback: { url: 'https://tracker.evil.example/x.m3u8', headers: {} } });
  await flush();

  assert.ok(phone.$('site-ask').classList.contains('on'), '必须先问');
  assert.match(phone.$('site-ask-text').textContent, /https:\/\/tracker\.evil\.example/);
  phone.$('site-deny').click();
  await flush();
  assert.equal(phone.nativeCalls('playerLoadUrl').length, 0, '拒绝后不能连接');
  assert.ok(!phone.$('site-ask').classList.contains('on'), '点完就收起来');

  // 换一部，同一站点批准一次
  phone.send(playlistMsg({ rev: 2, seq: 2, queue: [linkItem('https://video.example.org/w2')] }));
  await flush();
  phone.send({ t: 'now-link', seq: 2, playback: { url: 'https://media.example.net/a.m3u8', headers: {} } });
  await flush();
  assert.ok(phone.$('site-ask').classList.contains('on'));
  phone.$('site-allow').click();
  await flush();
  assert.equal(phone.nativeCalls('playerLoadUrl').length, 1);

  // 同一站点的下一部不再问
  phone.send(playlistMsg({ rev: 3, seq: 3, queue: [linkItem('https://video.example.org/w3')] }));
  await flush();
  phone.send({ t: 'now-link', seq: 3, playback: { url: 'https://media.example.net/b.m3u8', headers: {} } });
  await flush();
  assert.ok(!phone.$('site-ask').classList.contains('on'), '批准过的站点不再问');
  assert.equal(phone.nativeCalls('playerLoadUrl').length, 2);
});
