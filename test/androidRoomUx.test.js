'use strict';

/**
 * 安卓观众端在房间里、加入时的几处体验（批次 13）：
 *  - 进房后大厅的日志区整块看不见：失败和警告要在画面上亮一条提示；
 *  - 在线视频放不了（没直链、地址过期、打不开、断流）时状态栏说实话、给「重试」，房主发来新地址自动换上；
 *  - 没走进房间的加入尝试拆干净，安全模式下拉框放开，昵称按大厅里现在的；
 *  - 连接设置的保存语义：动作按钮立即生效，其余等「保存连接设置」，有没保存的改动时加入前先问；
 *  - 返回键先关对话框和抽屉，在房间里先问再离开；顶栏有「离开」；
 *  - 没起播时状态栏不说「往后能放」；
 *  - 信令服务器加入后把服务器认的房主和人数交给 WsSignaling（重连时当建房提示）。
 *
 * 和 androidFollow / androidHardening 一样，用假 DOM、假 Native 把 app-android.js 整个跑起来；
 * 假播放器只记命令、按命令改自己的快照，不出声也不解码。Kotlin 那一半（返回键、播放器出错上报）
 * 跑不了 JVM，守的是一改就失效的位置（androidNative.test.js 另有快照 JSON 的执行级断言）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const { fakeDocument, textOf } = require('./helpers/androidDom.js');

const root = path.join(__dirname, '..');
const ASSETS = path.join(root, 'android', 'app', 'src', 'main', 'assets', 'js');
const assetUrl = (file) => pathToFileURL(path.join(ASSETS, file)).href;
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const KT = 'android/app/src/main/java/com/syncwatch/app';

const HOST_ID = 'HOSTPEER01';
const CHUNK = 1024 * 1024;
const CJK = /[一-鿿]/;

const realConsoleLog = console.log;
const realPerfNow = performance.now;
const realWebSocket = globalThis.WebSocket;
test.after(() => {
  console.log = realConsoleLog;
  performance.now = realPerfNow;
  Object.defineProperty(globalThis, 'WebSocket', { value: realWebSocket, configurable: true, writable: true });
});

/* ------------------------------ 假 Native ------------------------------ */

/**
 * 对应 NativeBridge.kt + SyncPlayer.kt。load / loadUrl / release 发代号，快照带着同一个号。
 * failCurrent 让当前这个播放器的快照带上出错、放到头这些字段（新建的播放器没有）。
 */
function fakeNative(extra = {}) {
  const calls = [];
  const logs = [];
  let player = null;
  let sessions = 0;
  const now = () => Date.now();
  const position = () => (!player ? 0 : player.paused ? player.base : player.base + (now() - player.at) / 1000);
  const fresh = () => {
    player = { base: 0, at: now(), paused: true, duration: native.mediaDuration || 0, gen: ++native.gen, extra: null };
    return native.gen;
  };
  const native = {
    calls,
    logs,
    gen: 0,
    leaves: 0,
    mediaDuration: 0,
    stateFor: null,
    get player() {
      return player;
    },
    failCurrent(fields) {
      player.extra = fields;
    },
    openLeech(fileId) {
      calls.push(['openLeech', fileId]);
      return `leech-${++sessions}`;
    },
    sessionState(sessionId) {
      return JSON.stringify(native.stateFor?.(sessionId) || { bitfield: '', haveCount: 0, contiguousBytes: 0, complete: false });
    },
    contiguousBytes: () => '0',
    closeSession(sessionId) {
      calls.push(['closeSession', sessionId]);
    },
    readChunk: () => null,
    writeChunk: () => JSON.stringify({ ok: false, reason: 'test' }),
    playerLoad(sessionId) {
      calls.push(['playerLoad', sessionId]);
      return fresh();
    },
    playerLoadUrl(url) {
      calls.push(['playerLoadUrl', url]);
      return fresh();
    },
    // 分开音视频流的网站：一对直链
    playerLoadSplit(videoUrl, videoHeaders, audioUrl, audioHeaders) {
      calls.push(['playerLoadSplit', videoUrl, JSON.parse(videoHeaders), audioUrl, JSON.parse(audioHeaders)]);
      return fresh();
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
      if (!player) return JSON.stringify({ generation: native.gen, position: 0, duration: 0, paused: true, idle: true, eof: false });
      return JSON.stringify({
        generation: player.gen,
        position: position(),
        duration: player.duration,
        paused: player.paused,
        idle: false,
        eof: false,
        ...(player.extra || {}),
      });
    },
    playerRelease() {
      calls.push(['release']);
      player = null;
      return ++native.gen;
    },
    leaveRoom() {
      native.leaves++;
    },
    appVersion: () => '0.7.7',
    setImmersive() {},
    log(msg) {
      logs.push(String(msg));
    },
    ...extra,
  };
  return native;
}

/** 假原生层的 Cloudflare 调用：结果在下一个微任务里经 __noxreelNativeReply 送回（真机上也是异步的）。 */
function cfNative(handlers) {
  const cfCalls = [];
  return fakeNative({
    cfCalls,
    cfCall(id, action, args) {
      cfCalls.push({ action, args: JSON.parse(args) });
      queueMicrotask(() => {
        let reply;
        try {
          reply = { ok: true, value: (handlers[action] || (() => ({})))(JSON.parse(args)) };
        } catch (e) {
          reply = { ok: false, error: e.message };
        }
        globalThis.window.__noxreelNativeReply(id, JSON.stringify(reply));
      });
    },
  });
}

/** 记下发了什么的 WebSocket。readyState 由测试自己摆（1 = 已打开）。 */
class RecordingWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
    RecordingWebSocket.instances.push(this);
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.closed = true;
  }
}
RecordingWebSocket.instances = [];
RecordingWebSocket.OPEN = 1;

/** 最小的 RTCPeerConnection 替身：Peer 构造时只往上面挂回调、关的时候调 close。 */
class FakePC {
  constructor(config = {}) {
    this.config = config;
    this.iceConnectionState = 'new';
    this.connectionState = 'new';
  }
  close() {
    this.closed = true;
  }
  createDataChannel() {
    return { close() {}, readyState: 'connecting' };
  }
  addEventListener() {}
  removeEventListener() {}
}

/* ------------------------------ 共享库挂钩 ------------------------------ */

let hooks = null;
async function installHooks() {
  if (hooks) return hooks;
  console.log = () => {};
  globalThis.window = globalThis.window || {};
  globalThis.RTCPeerConnection = FakePC;
  const { Swarm } = await import(assetUrl('swarm.js'));
  const { SyncEngine } = await import(assetUrl('syncEngine.js'));
  const { Peer } = await import(assetUrl('peer.js'));
  const signaling = await import(assetUrl('signaling.js'));
  const protocol = await import(assetUrl('protocol.js'));
  const i18n = await import(assetUrl('i18n.js'));
  const swarms = [];
  const syncs = [];
  const origStart = Swarm.prototype.start;
  Swarm.prototype.start = function start(...args) {
    swarms.push(this);
    return origStart.apply(this, args);
  };
  const origOn = SyncEngine.prototype.on;
  SyncEngine.prototype.on = function on(...args) {
    if (!syncs.includes(this)) syncs.push(this);
    return origOn.apply(this, args);
  };
  // 生成应答要真的跑 WebRTC：换成由测试决定什么时候给出应答
  const offers = [];
  Peer.prototype.acceptOffer = function acceptOffer(sdp) {
    return new Promise((resolve, reject) => offers.push({ peer: this, sdp, resolve, reject }));
  };
  hooks = { swarms, syncs, offers, signaling, protocol, i18n };
  return hooks;
}

async function flush(rounds = 30) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

async function until(cond, what, max = 3000) {
  for (let i = 0; i < max; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail(`等不到：${what}`);
}

/* ------------------------------ 页面 ------------------------------ */

let caseNo = 0;

/** 加载一份新的页面（停在大厅）。 */
async function loadPhone(t, { native = fakeNative(), storage = {}, securityMode = 'trusted' } = {}) {
  const h = await installHooks();
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 });
  performance.now = () => Date.now();
  t.after(() => {
    performance.now = realPerfNow;
  });
  const store = new Map([['sw.securityMode', securityMode], ...Object.entries(storage)]);
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  globalThis.window.localStorage = globalThis.localStorage;
  const session = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => (session.has(k) ? session.get(k) : null),
    setItem: (k, v) => session.set(k, String(v)),
    removeItem: (k) => session.delete(k),
  };
  globalThis.document = fakeDocument();
  const reloads = [];
  globalThis.location = { reload: () => reloads.push(Date.now()) };
  globalThis.Native = native;
  Object.defineProperty(globalThis, 'WebSocket', { value: RecordingWebSocket, configurable: true, writable: true });
  const swarmCount = h.swarms.length;
  const offerCount = h.offers.length;
  await import(assetUrl('app-android.js') + `?case=${++caseNo}`);
  const $ = (id) => globalThis.document.getElementById(id);
  return {
    h,
    t,
    native,
    store,
    session,
    reloads,
    $,
    open: (link) => globalThis.window.noxreelOpenInvite(link),
    back: () => globalThis.window.noxreelBack(),
    swarm: () => h.swarms.slice(swarmCount).at(-1),
    offers: () => h.offers.slice(offerCount),
    logged: (text) => native.logs.filter((l) => l.includes(text)).length,
    toasts: () => $('room-toast').children.map((n) => n.textContent),
    confirmOpen: () => $('confirm-ask').classList.contains('on'),
    async advance(ms, step = 50) {
      for (let done = 0; done < ms; done += step) {
        t.mock.timers.tick(Math.min(step, ms - done));
        await flush(4);
      }
    },
    nativeCalls: (name) => native.calls.filter((c) => c[0] === name),
  };
}

/** 某个房主发的一对一邀请链接（noxreel://…）。 */
async function inviteFrom(h, hostId, securityMode = 'trusted') {
  const code = await h.signaling.encodeCode({
    k: 'offer',
    from: hostId,
    sdp: `v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=${hostId}\r\n`,
    securityMode,
  });
  return h.signaling.inviteLink(code, 'join');
}

/** 填服务器地址和房间号点「加入房间」，服务器回 joined。返回那条 WebSocket。 */
async function serverJoin(phone, joined) {
  phone.$('url').value = 'ws://127.0.0.1:9';
  phone.$('room').value = 'room';
  phone.$('join').click();
  const ws = RecordingWebSocket.instances.at(-1);
  ws.readyState = 1;
  ws.onopen();
  ws.onmessage({ data: JSON.stringify({ t: 'joined', peers: [], ...joined }) });
  await flush();
  return ws;
}

function fakeHostPeer() {
  return {
    peerId: HOST_ID,
    name: '房主',
    pc: { iceConnectionState: 'connected' },
    authenticated: true,
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

/** 进了房间的手机：信令服务器进房，挂上一条已认证的房主连接，房主发 ROLE 认定身份。 */
async function roomPhone(t, { role = 'guest', securityMode = 'trusted', native = fakeNative() } = {}) {
  const phone = await loadPhone(t, { native, securityMode });
  await serverJoin(phone, { hostId: HOST_ID });
  const swarm = phone.swarm();
  const host = fakeHostPeer();
  swarm.addPeer(host);
  swarm._onCtrl(host, { t: 'role', hostId: HOST_ID, roles: [[swarm.peerId, role]] });
  const sync = phone.h.syncs.at(-1);
  assert.equal(sync.hostId, HOST_ID);
  let lamport = 0;
  return Object.assign(phone, {
    swarm,
    sync,
    host,
    send: (msg) => swarm._onCtrl(host, msg),
    hostSync({ paused, position, seq }) {
      swarm._onCtrl(host, { t: 'sync', paused, position, lamport: ++lamport + 100, by: HOST_ID, name: '房主', seq });
    },
    async deliverManifest(manifest) {
      swarm._onCtrl(host, { t: 'manifest', manifest });
      await flush(60);
    },
    answerSite(ok) {
      if (!phone.$('site-ask').classList.contains('on')) return false;
      phone.$(ok ? 'site-allow' : 'site-deny').click();
      return true;
    },
    issueShown: () => phone.$('play-issue').style.display !== 'none',
    retryShown: () => phone.$('play-retry').style.display !== 'none',
  });
}

/* ------------------------------ 测试数据 ------------------------------ */

const sha256 = (s) => nodeCrypto.createHash('sha256').update(s).digest('hex');

function makeManifest(tag, { chunkCount = 60, durationSec = 60 } = {}) {
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
function fileItem(manifest, slot) {
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
  };
}

function linkItem(url, extra = {}) {
  itemNo++;
  return { id: 'b0c0d0e0' + itemNo.toString(16).padStart(8, '0'), kind: 'link', url, title: '在线', durationSec: 600, addedBy: HOST_ID, ...extra };
}

function playlistMsg({ rev, seq, queue, history = [], started = true }) {
  return { t: 'playlist', state: { rev, seq, queue, history, started, autoplay: true, nextSlot: 10 } };
}

/** 位图：给定若干 [起片, 止片) 区间置 1，其余为洞。 */
function partialState(protocol, manifest, ranges) {
  const have = new Uint8Array(manifest.chunkCount);
  for (const [from, to] of ranges) for (let i = from; i < to; i++) have[i] = 1;
  let lead = 0;
  while (lead < have.length && have[lead]) lead++;
  return {
    bitfield: protocol.packBitfield(have),
    haveCount: have.reduce((a, b) => a + b, 0),
    contiguousBytes: Math.min(lead * manifest.chunkSize, manifest.size),
    complete: have.every(Boolean),
  };
}

const PAGE = 'https://video.example.org/watch?v=1';
const CDN = 'https://cdn.example.org';

/** 链接项起播：列表、房主的地址、允许网站。 */
async function startLink(phone, { seq = 1, url = `${CDN}/a.m3u8`, resolvedAt } = {}) {
  phone.send(playlistMsg({ rev: seq, seq, queue: [linkItem(PAGE)] }));
  await flush();
  phone.send({ t: 'now-link', seq, playback: { url, headers: {} }, ...(resolvedAt ? { resolvedAt } : {}) });
  await flush();
  phone.answerSite(true);
  await flush();
}

/* ======================= D1-1：房间里看得见的反馈 ======================= */

test('进房后警告和失败在画面上亮一条提示：列表操作被拒、链接不对、改名为空都看得见；几秒后自己消失', async (t) => {
  const phone = await roomPhone(t, { role: 'admin' });
  // 大厅里（还没收到列表）的警告只进日志，不弹
  assert.deepEqual(phone.toasts(), []);
  phone.send(playlistMsg({ rev: 1, seq: 0, queue: [], started: false }));
  await flush();
  assert.equal(phone.$('lobby').style.display, 'none', '收到列表就进房');

  // 输入了不是 http 的地址：输入框留着，画面上说一声
  phone.$('pl-link').value = 'ftp://example.org/a.mp4';
  phone.$('pl-add').click();
  await flush();
  assert.deepEqual(phone.toasts(), ['只能加 http:// 或 https:// 开头的视频链接']);
  assert.equal(phone.$('pl-link').value, 'ftp://example.org/a.mp4');

  // 房主拒了：原因说出来
  phone.$('pl-link').value = 'https://video.example.org/watch?v=9';
  phone.$('pl-add').click();
  await flush();
  const op = phone.host.sent.filter((m) => m.t === 'playlist-op').at(-1);
  assert.ok(op, '列表操作要发给房主');
  phone.send({ t: 'playlist-ack', reqId: op.reqId, ok: false, reason: '列表里已经有这个链接了' });
  await flush();
  assert.ok(phone.toasts().includes('列表没改成：列表里已经有这个链接了'), JSON.stringify(phone.toasts()));

  // 成功了也有回音（用户刚点的按钮）
  phone.$('pl-add').click();
  await flush();
  const op2 = phone.host.sent.filter((m) => m.t === 'playlist-op').at(-1);
  phone.send({ t: 'playlist-ack', reqId: op2.reqId, ok: true });
  await flush();
  assert.ok(phone.toasts().includes('链接已加进列表'));
  assert.ok(phone.toasts().length <= 3, '最多同时亮三条');

  // 几秒后自己消失（失败的亮得久一点）
  await phone.advance(9000, 500);
  assert.deepEqual(phone.toasts(), []);

  // 成员面板里改名清空了点保存：编辑行留着，画面上说为什么没改成；同一句连说两次只亮一条
  phone.$('peers').click();
  const rename = phone.$('members-body').children[0].children.find((n) => n.className === 'mb-rename');
  rename.click();
  const [input, save] = phone.$('members-body').children[0].children;
  input.value = '   ';
  save.click();
  save.click();
  assert.deepEqual(phone.toasts(), ['昵称不能为空']);
  assert.equal(phone.$('members-body').children[0].className, 'mb-row mb-edit', '编辑行不关，让人接着改');
});

/* ================ D1-5：在线视频放不了时说实话、能重试、能换新地址 ================ */

test('在线链接：地址没到、没有直链时状态栏不说「房间同步中」；没有直链的那一条不给「重试」', async (t) => {
  const phone = await roomPhone(t);
  phone.send(playlistMsg({ rev: 1, seq: 1, queue: [linkItem(PAGE)] }));
  await flush();
  assert.equal(phone.$('status').textContent, '在线视频 · 等房主发来播放地址…');
  assert.equal(phone.$('buf').firstElementChild.style.width, '0%');

  phone.send({ t: 'now-link', seq: 1, playback: null });
  await flush();
  assert.equal(phone.$('status').textContent, '在线视频 · 没有可供 Android 播放的直链');
  assert.ok(phone.issueShown(), '顶栏下面那一条要说清楚');
  assert.equal(phone.$('play-issue-text').textContent, '房主分享的是网页链接，但没有可供 Android 播放的安全直链');
  assert.equal(phone.retryShown(), false, '重试也变不出直链');

  // 房主后来补了直链：自动接着放
  phone.send({ t: 'now-link', seq: 1, playback: { url: `${CDN}/a.m3u8`, headers: {} } });
  await flush();
  assert.equal(phone.$('status').textContent, '在线视频 · 等你允许连接这个网站');
  phone.answerSite(true);
  await flush();
  assert.equal(phone.nativeCalls('playerLoadUrl').length, 1);
  assert.equal(phone.$('status').textContent, '视频直链 · 从原网站播放 · 房间同步中');
  assert.equal(phone.issueShown(), false);
  // 快照的 idle / eof / loadFailed 交给同步引擎（checkDrift、卡顿判定都看它们）
  await phone.advance(500);
  assert.equal(phone.sync.lastTick.eof, false);
  assert.equal(phone.sync.lastTick.idle, false);
  assert.equal(phone.sync.lastTick.loadFailed, false);
});

test('在线链接打不开：播放器退掉、状态栏说实话、放掉让全房等的卡顿；同一条地址不自动重开，新地址自动换上', async (t) => {
  const phone = await roomPhone(t, { role: 'admin' });
  await startLink(phone);
  assert.equal(phone.nativeCalls('playerLoadUrl').length, 1);
  // 完全同步的管理员在缓冲：全房等他
  phone.native.failCurrent({ buffering: true });
  await phone.advance(500);
  assert.equal(phone.sync.localStalled, true);

  // 网站 403（签名过期）：ExoPlayer 回到 IDLE，快照带 loadFailed
  const released = phone.nativeCalls('release').length;
  phone.native.failCurrent({ loadFailed: true, loadReason: 'http', loadStatus: 403, idle: true });
  await phone.advance(500);
  assert.equal(phone.nativeCalls('release').length, released + 1, '坏掉的播放器要退掉');
  assert.equal(phone.native.player, null);
  assert.equal(phone.sync.localStalled, false, '打不开的播放器永远等不来，不能让全房陪着等');
  assert.equal(phone.sync.lastTick, null);
  assert.equal(phone.$('status').textContent, '在线视频 · 手机上打不开');
  assert.ok(phone.issueShown());
  assert.equal(phone.$('play-issue-text').textContent, '播放器打不开这个在线视频：网站拒绝了播放请求（HTTP 403），播放地址可能已经过期');
  assert.ok(phone.retryShown());
  assert.equal(phone.logged('播放器打不开这个在线视频'), 1);

  // 房主补发同一条地址：不自动再开一遍坏地址
  phone.send({ t: 'now-link', seq: 1, playback: { url: `${CDN}/a.m3u8`, headers: {} } });
  await flush();
  assert.equal(phone.nativeCalls('playerLoadUrl').length, 1);

  // 房主重新解析、发来新地址：直接换上（同一个网站不用再问）
  phone.send({ t: 'now-link', seq: 1, playback: { url: `${CDN}/b.m3u8?sig=new`, headers: {} } });
  await flush();
  assert.deepEqual(phone.nativeCalls('playerLoadUrl').map((c) => c[1]), [`${CDN}/a.m3u8`, `${CDN}/b.m3u8?sig=new`]);
  assert.equal(phone.issueShown(), false);
  assert.equal(phone.$('status').textContent, '视频直链 · 从原网站播放 · 房间同步中');
});

test('在线链接打不开后点「重试」：用手上的地址再开一次，新播放器按房间位置补放', async (t) => {
  const phone = await roomPhone(t);
  await startLink(phone);
  phone.hostSync({ paused: false, position: 42, seq: 1 });
  phone.native.failCurrent({ loadFailed: true, loadReason: 'network', idle: true });
  await phone.advance(500);
  assert.equal(phone.$('play-issue-text').textContent, '播放器打不开这个在线视频：连不上视频网站（超时或网络中断）');

  phone.$('play-retry').click();
  await flush();
  assert.equal(phone.nativeCalls('playerLoadUrl').length, 2, '重试要重新开一次');
  assert.equal(phone.issueShown(), false);
  await phone.advance(1000);
  const seeks = phone.nativeCalls('seek').map((c) => c[1]);
  assert.ok(seeks.at(-1) >= 42, `新播放器要跳到房间位置，实际 ${JSON.stringify(seeks)}`);
});

const OLD = () => Date.now() - 60 * 60 * 1000;

test('晚进房拿到过期的地址不起播，等房主重新解析的那条（同一个 seq）再放', async (t) => {
  const phone = await roomPhone(t);
  phone.send(playlistMsg({ rev: 1, seq: 1, queue: [linkItem(PAGE)] }));
  await flush();
  // 房主 greet 时原样补发的旧地址：一个小时前解析的
  phone.send({ t: 'now-link', seq: 1, playback: { url: `${CDN}/old.m3u8`, headers: {} }, resolvedAt: OLD() });
  await flush();
  assert.equal(phone.$('site-ask').classList.contains('on'), false, '过期的地址不值得问');
  assert.equal(phone.nativeCalls('playerLoadUrl').length, 0);
  assert.equal(phone.$('status').textContent, '在线视频 · 播放地址已过期，等房主发新的');
  assert.ok(phone.retryShown());

  // 房主紧接着重新解析、同一个 seq 再发一条新的
  phone.send({ t: 'now-link', seq: 1, playback: { url: `${CDN}/new.m3u8`, headers: {} }, resolvedAt: Date.now() });
  await flush();
  phone.answerSite(true);
  await flush();
  assert.deepEqual(phone.nativeCalls('playerLoadUrl').map((c) => c[1]), [`${CDN}/new.m3u8`]);
  assert.equal(phone.issueShown(), false);
});

test('过期的地址：房主那边没能重新解析时，本人点「重试」照样试一试那一条；填个未来的解析时间也不算新鲜', async (t) => {
  const phone = await roomPhone(t);
  phone.send(playlistMsg({ rev: 1, seq: 1, queue: [linkItem(PAGE)] }));
  phone.send({ t: 'now-link', seq: 1, playback: { url: `${CDN}/old.m3u8`, headers: {} }, resolvedAt: OLD() });
  await flush();
  phone.$('play-retry').click();
  await flush();
  phone.answerSite(true);
  await flush();
  assert.deepEqual(phone.nativeCalls('playerLoadUrl').map((c) => c[1]), [`${CDN}/old.m3u8`]);

  // 解析时间只能往前不能往后：房主报个一天以后，照样按「刚解析」算，过了 15 分钟一样过期
  phone.send(playlistMsg({ rev: 2, seq: 2, queue: [linkItem(PAGE)] }));
  phone.send({ t: 'now-link', seq: 2, playback: { url: `${CDN}/future.m3u8`, headers: {} }, resolvedAt: Date.now() + 86_400_000 });
  await phone.advance(16 * 60 * 1000, 60_000);
  phone.send(playlistMsg({ rev: 3, seq: 3, queue: [linkItem(PAGE)] }));
  phone.send({ t: 'now-link', seq: 3, playback: { url: `${CDN}/c.m3u8`, headers: {} }, resolvedAt: Date.now() + 86_400_000 });
  await flush();
  assert.equal(phone.nativeCalls('playerLoadUrl').at(-1)[1], `${CDN}/c.m3u8`, '未来时间被压成现在，新鲜的照常起播');
});

test('还在问「允许这个网站吗」时房主补发了新地址、列表也换了一版：允许之后用新地址，不用 await 之前取出来的', async (t) => {
  const phone = await roomPhone(t);
  const item = linkItem(PAGE);
  phone.send(playlistMsg({ rev: 1, seq: 1, queue: [item] }));
  phone.send({ t: 'now-link', seq: 1, playback: { url: `${CDN}/a.m3u8?sig=1`, headers: {} } });
  await flush();
  assert.ok(phone.$('site-ask').classList.contains('on'));
  phone.send({ t: 'now-link', seq: 1, playback: { url: `${CDN}/a.m3u8?sig=2`, headers: {} } });
  // 房主开播、成员进出都会发 seq 不变的新快照：当前项换成了新对象，但还是这一部
  phone.send(playlistMsg({ rev: 2, seq: 1, queue: [{ ...item }] }));
  await flush();
  phone.answerSite(true);
  await flush();
  assert.deepEqual(phone.nativeCalls('playerLoadUrl').map((c) => c[1]), [`${CDN}/a.m3u8?sig=2`]);
});

test('拒绝了网站：房主补发地址不再追着问；按返回键关掉对话框也算拒绝；「重试」再问一次', async (t) => {
  const phone = await roomPhone(t);
  phone.send(playlistMsg({ rev: 1, seq: 1, queue: [linkItem(PAGE)] }));
  phone.send({ t: 'now-link', seq: 1, playback: { url: `${CDN}/a.m3u8`, headers: {} } });
  await flush();
  assert.equal(phone.back(), true, '对话框开着：返回键先关它');
  await flush();
  assert.equal(phone.$('site-ask').classList.contains('on'), false);
  assert.equal(phone.$('status').textContent, '在线视频 · 你拒绝了这个网站');
  assert.ok(phone.retryShown());

  phone.send({ t: 'now-link', seq: 1, playback: { url: `${CDN}/b.m3u8`, headers: {} } });
  await flush();
  assert.equal(phone.$('site-ask').classList.contains('on'), false, '拒绝过的不追着问');

  phone.$('play-retry').click();
  await flush();
  assert.ok(phone.$('site-ask').classList.contains('on'), '重试要再问一次');
  phone.answerSite(true);
  await flush();
  assert.deepEqual(phone.nativeCalls('playerLoadUrl').map((c) => c[1]), [`${CDN}/b.m3u8`]);
});

test('在线视频断在半路（不是放完了）：经同步引擎报 stream-cut，提示本人、给「重试」；离开 eof 就算好了', async (t) => {
  const phone = await roomPhone(t, { role: 'admin' });
  phone.native.mediaDuration = 600;
  await startLink(phone);
  const cuts = [];
  phone.sync.on('stream-cut', (e) => cuts.push(e));
  await phone.advance(500);
  const released = phone.nativeCalls('release').length; // 换片时释放过一次

  // 片长 10 分钟，停在 1:40 的 eof 上：断流
  phone.native.playerSeek(100);
  phone.native.failCurrent({ eof: true, paused: true });
  await phone.advance(500);
  assert.equal(cuts.length, 1, '只报一次');
  assert.equal(cuts[0].position, 100);
  assert.equal(phone.sync.playerPositionNow(), null, '断流停住的位置不是房间的进度，管理员按暂停不能拿它广播');
  assert.equal(phone.$('status').textContent, '在线视频 · 断流了');
  assert.equal(phone.$('play-issue-text').textContent, '在线视频在 1:40 断了（全片 10:00），不是放完了：点「重试」重新连接');
  assert.ok(phone.retryShown());
  assert.equal(phone.nativeCalls('release').length, released, '断流不退播放器（房主一跳说不定就好了）');

  // 房主一跳，播放器离开 eof：提示收掉
  phone.native.failCurrent(null);
  await phone.advance(500);
  assert.equal(phone.issueShown(), false);
  assert.equal(phone.$('status').textContent, '视频直链 · 从原网站播放 · 房间同步中');

  // 又断了，这次点「重试」：旧播放器退掉，重新打开
  phone.native.failCurrent({ eof: true, paused: true });
  await phone.advance(500);
  assert.equal(cuts.length, 2);
  phone.$('play-retry').click();
  await flush();
  assert.equal(phone.nativeCalls('release').length, released + 1, '重试先退掉停在半路的旧播放器');
  assert.equal(phone.nativeCalls('playerLoadUrl').length, 2);
  assert.equal(phone.issueShown(), false);
});

test('断流时房主发来新地址：直接换上重开；真放完了（到片尾）不报断流', async (t) => {
  const phone = await roomPhone(t);
  phone.native.mediaDuration = 600;
  await startLink(phone);
  await phone.advance(500);
  phone.native.playerSeek(100);
  phone.native.failCurrent({ eof: true, paused: true });
  await phone.advance(500);
  phone.send({ t: 'now-link', seq: 1, playback: { url: `${CDN}/b.m3u8`, headers: {} } });
  await flush();
  assert.deepEqual(phone.nativeCalls('playerLoadUrl').map((c) => c[1]), [`${CDN}/a.m3u8`, `${CDN}/b.m3u8`]);

  await phone.advance(500);
  phone.native.playerSeek(599);
  phone.native.failCurrent({ eof: true, paused: true });
  await phone.advance(500);
  assert.equal(phone.issueShown(), false, '到片尾的 eof 是真放完了');
});

test('本地文件解不了码：说一声，不给「重试」（重载同一个文件也救不回来），也不退播放器', async (t) => {
  const phone = await roomPhone(t, { securityMode: 'safe' });
  const a = makeManifest('F1');
  phone.native.mediaDuration = 60;
  phone.native.stateFor = () => partialState(phone.h.protocol, a, [[0, 60]]);
  phone.send(playlistMsg({ rev: 1, seq: 1, queue: [fileItem(a, 1)] }));
  phone.send({ t: 'bitfield', s: 1, full: true });
  await flush();
  await phone.deliverManifest(a);
  await until(() => phone.nativeCalls('playerLoad').length === 1, '完整文件起播');
  const released = phone.nativeCalls('release').length;
  phone.native.failCurrent({ loadFailed: true, loadReason: 'format', idle: true });
  await phone.advance(1000);
  assert.equal(phone.$('play-issue-text').textContent, '手机上的播放器放不了这一部：手机上的播放器认不出这个视频的格式');
  assert.equal(phone.retryShown(), false);
  assert.equal(phone.$('status').textContent, '手机上的播放器放不了这一部');
  assert.equal(phone.nativeCalls('release').length, released, '退了也会马上按收完的文件再起播一次，一样放不了');
  assert.equal(phone.logged('手机上的播放器放不了这一部'), 1, '每一拍都来的快照只说一次');
});

/* ================= D1-8：没起播时状态栏不说「往后能放」 ================= */

test('安全模式没收完：状态栏说「完整接收后才播，还剩 X」，不说「往后能放」', async (t) => {
  const phone = await roomPhone(t, { securityMode: 'safe' });
  const a = makeManifest('S1');
  phone.native.stateFor = () => partialState(phone.h.protocol, a, [[0, 30]]);
  phone.send(playlistMsg({ rev: 1, seq: 1, queue: [fileItem(a, 1)] }));
  phone.send({ t: 'bitfield', s: 1, full: true });
  await flush();
  await phone.deliverManifest(a);
  await until(() => phone.nativeCalls('openLeech').length === 1, '开会话');
  await flush();
  const status = phone.$('status').textContent;
  assert.match(status, /^已收 50% · 安全模式 · 完整接收后才播，还剩 30\.0 MB · ↓/);
  assert.doesNotMatch(status, /往后能放/);
  assert.equal(phone.nativeCalls('playerLoad').length, 0);
});

test('可信房间起播前：说还差多少（片头 / 起播点附近），片源没时长的中途加入说要收完才播', async (t) => {
  const phone = await roomPhone(t);
  // 从片头放，片头 8MB 还没到
  const a = makeManifest('T1');
  phone.native.stateFor = () => partialState(phone.h.protocol, a, [[20, 60]]);
  phone.send(playlistMsg({ rev: 1, seq: 1, queue: [fileItem(a, 1)] }));
  phone.hostSync({ paused: true, position: 0, seq: 1 });
  phone.send({ t: 'bitfield', s: 1, full: true });
  await flush();
  await phone.deliverManifest(a);
  await until(() => phone.nativeCalls('openLeech').length === 1, 'A 开会话');
  await flush();
  assert.match(phone.$('status').textContent, /^已收 66% · 距起播还差 8\.0 MB · ↓/);

  // 中途加入：片头够了，房间在 25 秒（25MB）处，那里往后一片都没有
  const b = makeManifest('T2');
  phone.native.stateFor = () => partialState(phone.h.protocol, b, [[0, 8], [40, 60]]);
  phone.send(playlistMsg({ rev: 2, seq: 2, queue: [fileItem(b, 2)] }));
  phone.hostSync({ paused: true, position: 25, seq: 2 });
  phone.send({ t: 'bitfield', s: 2, full: true });
  await flush();
  await phone.deliverManifest(b);
  await until(() => phone.nativeCalls('openLeech').length === 2, 'B 开会话');
  await flush();
  // (15 + 2) 秒 × 1MB/s × 1.5 = 25.5MB
  assert.match(phone.$('status').textContent, /^已收 46% · 距起播还差（当前位置附近） 25\.5 MB · ↓/);

  // 中途加入、片源没时长：算不出房间播到哪，只能等收完
  const c = makeManifest('T3', { durationSec: 0 });
  phone.native.stateFor = () => partialState(phone.h.protocol, c, [[0, 8], [40, 60]]);
  phone.send(playlistMsg({ rev: 3, seq: 3, queue: [fileItem(c, 3)] }));
  phone.hostSync({ paused: true, position: 25, seq: 3 });
  phone.send({ t: 'bitfield', s: 3, full: true });
  await flush();
  await phone.deliverManifest(c);
  await until(() => phone.nativeCalls('openLeech').length === 3, 'C 开会话');
  await flush();
  assert.match(phone.$('status').textContent, /^已收 46% · 片源没提供时长 · 完整接收后才播，还剩 32\.0 MB · ↓/);
  assert.equal(phone.nativeCalls('playerLoad').length, 0);
});

/* =============== D1-2：没走进房间的尝试拆干净，安全模式放开 =============== */

test('信令加入失败（房间号没人开）：安全模式下拉框放开；切了模式、改了昵称再加入，用的是新的', async (t) => {
  const phone = await loadPhone(t);
  // 服务器没说房主是谁：这次加入作废
  const first = await serverJoin(phone, {});
  assert.equal(phone.logged('连接失败：信令服务器没有告诉我们谁是房主'), 1);
  assert.equal(first.closed, true);
  assert.equal(phone.$('security-mode').disabled, false, '失败之后还锁着，提示「请切换为相同模式」却切不了');

  phone.$('security-mode').value = 'safe';
  phone.$('security-mode').dispatch('change');
  phone.$('name').value = '新名字';
  await serverJoin(phone, { hostId: 'HOSTSRV1' });
  const swarm = phone.swarm();
  assert.equal(swarm.securityMode, 'safe', '第二次加入还用着第一次的安全模式');
  assert.equal(swarm.name, '新名字', '大厅里改的昵称被忽略了');
  assert.equal(phone.$('security-mode').disabled, true, '进了房间就锁上');
  assert.equal(phone.h.syncs.at(-1).hostId, 'HOSTSRV1');
});

test('一对一应答没人粘时换一条模式不同的邀请：下拉框放开，切过去再点就能加入', async (t) => {
  const phone = await loadPhone(t);
  phone.open(await inviteFrom(phone.h, 'HOSTAAAA'));
  await until(() => phone.offers().length === 1, '生成应答');
  const first = phone.offers()[0];
  first.resolve('v=0 answer');
  await until(() => phone.$('answer-wrap').style.display === '', '应答链接生成');
  assert.equal(phone.$('security-mode').disabled, true);

  const safeInvite = await inviteFrom(phone.h, 'HOSTBBBB', 'safe');
  phone.open(safeInvite);
  await until(() => phone.logged('房间使用安全模式，本机设置是可信房间') === 1, '说模式不一致');
  assert.equal(phone.$('security-mode').disabled, false, '提示切换模式，下拉框却是灰的');
  assert.equal(first.peer.closed, true, '上一轮等不到应答的连接收掉');
  assert.equal(phone.$('answer-wrap').style.display, 'none', '作废的应答链接别留着让人发出去');

  phone.$('security-mode').value = 'safe';
  phone.$('security-mode').dispatch('change');
  phone.open(safeInvite);
  await until(() => phone.offers().length === 2, '切过去再点就能生成应答');
  assert.equal(phone.swarm().securityMode, 'safe');
});

test('一对一应答等了三分钟没连上：这一轮拆干净（应答收起、下拉框放开）', async (t) => {
  const phone = await loadPhone(t);
  phone.open(await inviteFrom(phone.h, 'HOSTAAAA'));
  await until(() => phone.offers().length === 1, '生成应答');
  const first = phone.offers()[0];
  first.resolve('v=0 answer');
  await until(() => phone.$('answer-wrap').style.display === '', '应答链接生成');
  await phone.advance(181_000, 5000);
  assert.equal(phone.logged('等了几分钟还是没连上房主'), 1);
  assert.equal(first.peer.closed, true);
  assert.equal(phone.$('answer-wrap').style.display, 'none');
  assert.equal(phone.$('security-mode').disabled, false);
});

test('信令进了房、握手时模式对不上：这次尝试拆掉，不再算「在房间里」，下拉框放开', async (t) => {
  const phone = await loadPhone(t);
  const ws = await serverJoin(phone, { hostId: 'HOSTSRV1' });
  assert.equal(phone.logged('已进入房间'), 1);
  phone.swarm().emit('mode-mismatch', { localMode: 'trusted', remoteMode: 'safe' });
  await phone.advance(50);
  assert.equal(ws.closed, true);
  assert.equal(phone.$('security-mode').disabled, false);
  // 不再算在房间里：点邀请不先问要不要离开
  phone.open(await inviteFrom(phone.h, 'HOSTAAAA'));
  await until(() => phone.offers().length === 1, '直接按新邀请加入');
  assert.equal(phone.$('invite-ask').classList.contains('on'), false);
});

/* ============ 一对一应答写回邀请编号（批次 15 的 B2-4，安卓这一侧） ============ */

test('一对一应答把房主邀请的编号原样写回，房主据此拒掉上一条邀请的迟到应答', async (t) => {
  const phone = await loadPhone(t);
  const { encodeCode, decodeCode, inviteLink } = phone.h.signaling;
  const code = await encodeCode({
    k: 'offer',
    from: 'HOSTAAAA',
    sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=HOSTAAAA\r\n',
    securityMode: 'trusted',
    invite: 'inv-42',
  });
  const offer = await decodeCode(code);
  phone.open(inviteLink(code, 'join'));
  await until(() => phone.offers().length === 1, '生成应答');
  phone.offers()[0].resolve('v=0 answer');
  await until(() => !!phone.$('answer-out').value, '应答链接生成');
  const answer = await decodeCode(phone.$('answer-out').value);
  assert.equal(answer.k, 'answer');
  // 共用的 signaling.js 认得编号时两边都是 inv-42；老版本的库两边都没有（照旧）
  assert.equal(answer.invite, offer.invite, '房主那条邀请的编号没写回应答');
  const app = read('android/app/src/main/assets/js/app-android.js');
  assert.match(app, /k: 'answer', from: S\.peerId,[\s\S]{0,300}invite: payload\.invite,/);
});

/* ============ WsSignaling：服务器认的房主和人数留作重连时的建房提示 ============ */

test('信令服务器模式：进房后把服务器认的房主和房间人数交给 WsSignaling，服务器重启后重连时当建房提示', async (t) => {
  const phone = await loadPhone(t);
  // 首次 joined 里带着房主凭据的摘要：手机建 WsSignaling 时还不知道房主是谁，也得记下，第一次重连就带上
  const ws = await serverJoin(phone, { hostId: 'HOSTSRV1', maxMembers: 6, hostKey: 'k'.repeat(43) });
  const firstJoin = ws.sent.find((m) => m.t === 'join');
  assert.equal(firstJoin.hostHint, undefined, '首次加入不带提示（房间不在就是关了）');

  ws.onclose(); // 服务器重启
  await phone.advance(1500);
  const again = RecordingWebSocket.instances.at(-1);
  assert.notEqual(again, ws, '要自动重连');
  again.readyState = 1;
  again.onopen();
  const join = again.sent.find((m) => m.t === 'join');
  assert.equal(join.hostHint, 'HOSTSRV1', '重连时不带房主提示，房间会由先重连上的人重建、他成了房主');
  assert.equal(join.hostKey, 'k'.repeat(43), '第一次重连的提示不带摘要：服务器没法核对回来认领的是不是真房主');
  assert.equal(join.maxMembers, 6);
});

/* ============ D1-3：连接设置的保存语义 ============ */

test('「验证并保存」立即生效：表单上选的是 Cloudflare 时顺带存下 TURN 来源；别的改动照旧等「保存连接设置」', async (t) => {
  const native = cfNative({
    status: () => ({ configured: false, expiresAt: null, lastError: null }),
    save: () => ({ configured: true, expiresAt: Date.now() + 23 * 3600e3, lastError: null }),
    credentials: () => ({ urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c', expiresAt: Date.now() + 23 * 3600e3 }),
  });
  const phone = await loadPhone(t, { native });
  phone.$('turn-source-manual').checked = false;
  phone.$('turn-source-cf').checked = true;
  phone.$('turn-source-cf').dispatch('change');
  phone.$('relay-only').checked = true; // 没点「保存连接设置」
  phone.$('cf-key').value = 'abcdef1234';
  phone.$('cf-token').value = 't'.repeat(40);
  phone.$('cf-save').click();
  await flush();
  assert.equal(phone.store.get('sw.turnSource'), 'cloudflare', '看到「已保存」去加入，却根本不用 Cloudflare TURN');
  assert.equal(phone.$('cf-result').textContent, '已保存，之后新建的连接改用 Cloudflare TURN');
  assert.notEqual(phone.store.get('sw.relayOnly'), '1', '「隐藏我的 IP」照旧等「保存连接设置」');
  assert.equal(phone.$('relay-only').checked, true, '表单上没保存的改动不能被重画掉');
  assert.ok(native.cfCalls.some((c) => c.action === 'credentials'), '来源改成 Cloudflare 之后预取一组临时账号');
});

test('有没保存的连接设置就去加入：先问；取消不加入，「保存并加入」按表单保存后再加入（勾了隐藏 IP 就只走中继）', async (t) => {
  const phone = await loadPhone(t);
  phone.$('turn-on').checked = true;
  phone.$('turn-url').value = 'turn:turn.example.org:3478';
  phone.$('turn-user').value = 'u';
  phone.$('turn-pass').value = 'p';
  phone.$('relay-only').checked = true;
  const link = await inviteFrom(phone.h, 'HOSTAAAA');

  phone.open(link);
  await flush();
  assert.ok(phone.confirmOpen(), '有没保存的改动要先问');
  assert.equal(phone.$('confirm-title').textContent, '连接设置还没保存');
  assert.equal(phone.offers().length, 0);
  phone.$('confirm-cancel').click();
  await flush();
  assert.equal(phone.offers().length, 0, '取消就不加入');
  assert.equal(phone.logged('没有加入：连接设置有没保存的改动'), 1);

  phone.open(link);
  await flush();
  phone.$('confirm-ok').click();
  await until(() => phone.offers().length === 1, '保存后接着加入');
  assert.equal(phone.store.get('sw.relayOnly'), '1');
  assert.equal(phone.offers()[0].peer.iceTransportPolicy, 'relay', '勾着「隐藏我的 IP」却照常直连');
});

test('信令服务器加入同样先问；表单写错了保存不成就不加入，把连接设置展开', async (t) => {
  const phone = await loadPhone(t);
  const before = RecordingWebSocket.instances.length;
  phone.$('relay-only').checked = true;
  phone.$('turn-on').checked = true;
  phone.$('turn-url').value = 'https://not-a-turn.example';
  phone.$('url').value = 'ws://127.0.0.1:9';
  phone.$('room').value = 'room';
  phone.$('join').click();
  await flush();
  assert.ok(phone.confirmOpen());
  phone.$('confirm-ok').click();
  await flush();
  assert.equal(RecordingWebSocket.instances.length, before, '保存失败不能照旧加入');
  assert.equal(phone.$('net-settings').open, true);
  assert.match(phone.$('net-err').textContent, /这些 TURN 地址认不出来/);

  phone.$('turn-url').value = 'turn:turn.example.org:3478';
  phone.$('turn-user').value = 'u';
  phone.$('turn-pass').value = 'p';
  phone.$('join').click();
  await flush();
  phone.$('confirm-ok').click();
  await flush();
  assert.equal(RecordingWebSocket.instances.length, before + 1);
  // 保存过了：再点不再问
  assert.equal(phone.confirmOpen(), false);
});

/* ============ D1-4：返回键和「离开」 ============ */

test('返回键：先关抽屉；在房间里先问「要离开房间吗？」，取消什么都不动；顶栏「离开」确认后收掉原生会话、整页重载', async (t) => {
  const phone = await roomPhone(t);
  phone.send(playlistMsg({ rev: 1, seq: 0, queue: [], started: false }));
  await flush();

  phone.$('btn-chat').click();
  assert.ok(phone.$('chat-sheet').classList.contains('on'));
  assert.equal(phone.back(), true);
  assert.equal(phone.$('chat-sheet').classList.contains('on'), false, '开着抽屉按返回：先关抽屉');
  assert.equal(phone.confirmOpen(), false);

  assert.equal(phone.back(), true, '在房间里按返回不能直接退');
  assert.ok(phone.confirmOpen());
  assert.equal(phone.$('confirm-title').textContent, '要离开房间吗？');
  assert.equal(phone.$('confirm-ok').textContent, '离开房间');
  assert.equal(phone.back(), true, '确认框开着：返回键就是取消');
  await flush();
  assert.equal(phone.confirmOpen(), false);
  assert.equal(phone.native.leaves, 0);
  assert.equal(phone.reloads.length, 0);

  phone.$('btn-leave').click();
  assert.ok(phone.confirmOpen());
  phone.$('confirm-ok').click();
  await flush();
  assert.equal(phone.native.leaves, 1, '没让原生收掉播放器和接收缓存');
  assert.equal(phone.reloads.length, 1, '离开要整页重载回大厅');
  assert.equal(phone.session.has('sw.pendingInvite'), false, '只离开，不自动加入什么');
});

test('返回键：大厅里什么都没有就交给系统；信令进了房（还没人连上）也先问', async (t) => {
  const phone = await loadPhone(t);
  assert.equal(phone.back(), false, '大厅里交给系统（退出或退到后台）');
  await serverJoin(phone, { hostId: 'HOSTSRV1' });
  assert.equal(phone.back(), true);
  assert.ok(phone.confirmOpen());
});

test('原生层：返回键先问页面（window.noxreelBack），页面不接才走系统默认；不再只看 canGoBack', () => {
  const activity = read(`${KT}/MainActivity.kt`);
  assert.doesNotMatch(activity, /override fun onBackPressed\(\)/, '旧的 onBackPressed 还在：返回键不经过页面');
  assert.doesNotMatch(activity, /web\.canGoBack\(\)/);
  assert.match(activity, /import androidx\.activity\.OnBackPressedCallback/);
  assert.match(activity, /onBackPressedDispatcher\.addCallback\(this, object : OnBackPressedCallback\(true\)/);
  assert.match(activity, /PAGE_BACK_JS =\s*"\(function\(\)\{try\{return window\.noxreelBack\?\.\(\)===true\}catch\(e\)\{return false\}\}\)\(\)"/);
  const ask = activity.slice(activity.indexOf('private fun askPageToHandleBack('), activity.indexOf('private fun systemBack('));
  assert.match(ask, /if \(webGone \|\| !::web\.isInitialized \|\| !pageReady\) return systemBack\(callback\)/, 'WebView 没了、页面没加载好时要直接走系统默认');
  assert.match(ask, /web\.evaluateJavascript\(PAGE_BACK_JS\) \{ result ->\s*if \(result != "true"/);
  const sys = activity.slice(activity.indexOf('private fun systemBack('));
  assert.match(sys, /callback\.isEnabled = false\s*onBackPressedDispatcher\.onBackPressed\(\)\s*callback\.isEnabled = true/);
  const html = read('android/app/src/main/assets/index.html');
  assert.match(html, /<button id="btn-leave">离开<\/button>/);
});

/* ------------------------------ 文案 ------------------------------ */

test('新文案都有英文，带参数的几句翻得对', async () => {
  const { translate } = await import(assetUrl('i18n.js'));
  const html = read('android/app/src/main/assets/index.html');
  for (const zh of [
    '在线视频 · 等房主发来播放地址…',
    '在线视频 · 等你允许连接这个网站',
    '在线视频 · 正在打开…',
    '在线视频 · 没有可供 Android 播放的直链',
    '在线视频 · 你拒绝了这个网站',
    '在线视频 · 播放地址已过期，等房主发新的',
    '在线视频 · 手机打不开这个地址',
    '在线视频 · 手机上打不开',
    '在线视频 · 断流了',
    '手机上的播放器放不了这一部',
    '房主给的播放地址已经放了很久，多半过期了，正在等房主发新的；也可以点「重试」直接试这一条',
    '在线视频停住了，但片长未知，分不清是放完了还是断流了：没放完就点「重试」重新连接',
    '重试',
    '离开',
    '要离开房间吗？',
    '离开房间',
    '会断开和房间里所有人的连接，这台手机上收到的缓存也会删掉。',
    '连接设置还没保存',
    '连接设置里的改动（TURN、隐藏我的 IP）还没保存，不保存的话这次按上次保存的设置连接。',
    '保存并加入',
    '没有加入：连接设置有没保存的改动。点「保存连接设置」，或者把改动改回去再加入',
    '连接设置没保存成功，没有加入：看连接设置里的提示',
    '已保存，之后新建的连接改用 Cloudflare TURN',
    '这两个按钮点了立即生效，不用再点下面的「保存连接设置」；验证通过时 TURN 来源一并改成 Cloudflare。',
    '「保存上限」点了立即生效。',
    'TURN 来源、自己填的中继、隐藏我的 IP 改完要点「保存连接设置」才生效；有没保存的改动时，加入房间前会先问你。',
    '播放器打不开这个在线视频：原因不明',
    '播放器打不开这个在线视频：播放地址指向内网或本机，已拦下',
    '手机上的播放器放不了这一部：手机上的播放器认不出这个视频的格式',
    '播放器打不开这个在线视频：网站返回了错误',
  ]) {
    const en = translate(zh, 'en');
    assert.notEqual(en, zh, `没有英文：${zh}`);
    assert.doesNotMatch(en, CJK, `英文里还有中文：${zh} → ${en}`);
  }
  // 词条和页面上写的对得上（改了一边忘了另一边，英文界面就漏翻）
  for (const zh of ['这两个按钮点了立即生效', '「保存上限」点了立即生效。', '改完要点「保存连接设置」才生效']) {
    assert.ok(html.includes(zh), `index.html 里没有：${zh}`);
  }
  assert.equal(
    translate('播放器打不开这个在线视频：网站拒绝了播放请求（HTTP 403），播放地址可能已经过期', 'en'),
    'The player cannot open this online video: The website refused the playback request (HTTP 403); the stream URL may have expired'
  );
  assert.equal(
    translate('播放器打不开这个在线视频：网站返回了错误（HTTP 500）', 'en'),
    'The player cannot open this online video: The website returned an error (HTTP 500)'
  );
  assert.equal(
    translate('在线视频在 1:40 断了（全片 1:02:03），不是放完了：点「重试」重新连接', 'en'),
    'The online video cut out at 1:40 (length 1:02:03); it did not finish. Tap “Retry” to reconnect'
  );
  assert.equal(translate('重新连接《在线》…', 'en'), 'Reconnecting “在线”…');
  assert.equal(
    translate('已收 50% · 安全模式 · 完整接收后才播，还剩 30.0 MB · ↓1.0 MB/s', 'en'),
    'Received 50% · Safe mode · plays only after full receipt, 30.0 MB left · ↓1.0 MB/s'
  );
  assert.equal(
    translate('已收 46% · 片源没提供时长 · 完整接收后才播，还剩 32.0 MB · ↓0 B/s', 'en'),
    'Received 46% · No duration from the source · plays only after full receipt, 32.0 MB left · ↓0 B/s'
  );
  assert.equal(
    translate('已收 46% · 距起播还差（当前位置附近） 25.5 MB · ↓0 B/s', 'en'),
    'Received 46% · 25.5 MB left before playback starts (around the current position) · ↓0 B/s'
  );
  assert.equal(translate('已收 66% · 距起播还差 8.0 MB · ↓0 B/s', 'en'), 'Received 66% · 8.0 MB left before playback starts · ↓0 B/s');
});

/* ================ 分开音视频流的网站（B 站）：房主给一对直链，手机合成一路播 ================ */

test('在线链接只给分开的音视频流：房主给的一对直链交给原生层合成一路播，两条不同主机各问一次', async (t) => {
  const phone = await roomPhone(t);
  phone.send(playlistMsg({ rev: 1, seq: 1, queue: [linkItem(PAGE)] }));
  await flush();
  const video = { url: `${CDN}/v.m4s?sig=1`, headers: { referer: 'https://video.example.org/', 'x-evil': 'no' } };
  const audio = { url: 'https://audio.example.org/a.m4s?sig=1', headers: { referer: 'https://video.example.org/' } };
  phone.send({ t: 'now-link', seq: 1, playback: null, split: { video, audio }, resolvedAt: Date.now() });
  await flush();
  assert.equal(phone.$('status').textContent, '在线视频 · 等你允许连接这个网站');
  phone.answerSite(true);
  await flush();
  // 音频在另一台主机上：再问一次
  assert.equal(phone.nativeCalls('playerLoadSplit').length, 0);
  phone.answerSite(true);
  await flush();
  const calls = phone.nativeCalls('playerLoadSplit');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['playerLoadSplit', video.url, { referer: 'https://video.example.org/' }, audio.url, { referer: 'https://video.example.org/' }], '请求头只留那五种');
  assert.equal(phone.nativeCalls('playerLoadUrl').length, 0);
  assert.equal(phone.issueShown(), false);

});

test('一对直链里有一条不像样（不是 http(s)）：整对不要，照旧说没有直链', async (t) => {
  const video = { url: `${CDN}/v.m4s?sig=1`, headers: {} };
  const phone2 = await roomPhone(t);
  phone2.send(playlistMsg({ rev: 1, seq: 1, queue: [linkItem(PAGE)] }));
  await flush();
  phone2.send({ t: 'now-link', seq: 1, playback: null, split: { video, audio: { url: 'file:///etc/passwd' } } });
  await flush();
  assert.equal(phone2.$('play-issue-text').textContent, '房主分享的是网页链接，但没有可供 Android 播放的安全直链');
});
