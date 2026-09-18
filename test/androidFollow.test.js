'use strict';

/**
 * 安卓观众端跟着房主播放列表走当前项（app-android.js）的行为测试。
 *
 * 不起 WebView、不起 ExoPlayer：用假 DOM、假 Native（native-shim 原样加载，只把
 * Kotlin 桥换成内存里的假实现）和假房主连接，把 app-android.js 整个跑起来。
 * 假播放器只记命令、按命令改自己的快照，不出声也不解码。
 *
 * 每条测试都重新 import 一份 app-android.js（URL 带不同的查询串），模块内的 S 互不相干；
 * 共享库（swarm / syncEngine / native-shim）只加载一次，所以 window 始终是同一个对象，
 * 每条测试只换掉 document 和 Native。
 *
 * 假 DOM 在 helpers/androidDom.js，和 androidChat.test.js 那份是同一套。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const { fakeDocument } = require('./helpers/androidDom.js');

const ASSETS = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'js');
const assetUrl = (file) => pathToFileURL(path.join(ASSETS, file)).href;

const HOST_ID = 'HOSTPEER01';
const CHUNK = 1024 * 1024;

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
 * 对应 NativeBridge.kt + SyncPlayer.kt。播放器的命令直接生效（真机上是按先后投递到主线程），
 * 新建的播放器固定停在 0:00、暂停（SyncPlayer.replacePlayer）。
 */
function fakeNative({ openLeech } = {}) {
  const calls = [];
  const logs = [];
  let seq = 0;
  // 播放器：null 表示没有（没加载或已释放）
  let player = null;
  const now = () => Date.now();
  const position = () => {
    if (!player) return 0;
    return player.paused ? player.base : player.base + (now() - player.at) / 1000;
  };
  const native = {
    calls,
    logs,
    snapshots: 0,
    // 开会话时返回的续传状态；null 表示一片都没有
    stateFor: null,
    get player() {
      return player;
    },
    playerPosition: position,
    openLeech(fileId, name, size, chunkSize, chunkCount, hashesJson) {
      calls.push(['openLeech', fileId]);
      const custom = openLeech?.({ fileId, name, size: Number(size), chunkSize, chunkCount, hashes: JSON.parse(hashesJson) });
      if (custom !== undefined) return custom;
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
    // 原生的 load / loadUrl / release 都返回这次换片的代号（0 = 失败），快照里带着同一个号：
    // JS 靠它认出「这条读数还是上一部片的」。假 Native 也必须发号，否则过滤器会把一切都丢掉。
    playerLoad(sessionId) {
      calls.push(['playerLoad', sessionId]);
      player = { base: 0, at: now(), paused: true, duration: native.mediaDuration || 0, gen: ++native.gen };
      return native.gen;
    },
    playerLoadUrl(url) {
      calls.push(['playerLoadUrl', url]);
      player = { base: 0, at: now(), paused: true, duration: native.mediaDuration || 0, gen: ++native.gen };
      return native.gen;
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
      native.snapshots++;
      if (!player) return JSON.stringify({ generation: native.gen, position: 0, duration: 0, paused: true, idle: true, eof: false });
      return JSON.stringify({
        generation: native.stale ? player.gen - 1 : player.gen,
        position: position(),
        duration: player.duration,
        paused: player.paused,
        idle: false,
        eof: false,
      });
    },
    playerRelease() {
      calls.push(['release']);
      player = null;
      return ++native.gen;
    },
    /** 让接下来的快照报一个过期的代号（模拟 release/load 还没在主线程落地）。 */
    staleGeneration(on = true) {
      native.stale = on;
    },
    gen: 0,
    stale: false,
    log(msg) {
      logs.push(msg);
    },
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
  const { Swarm, manifestDigestOk } = await import(assetUrl('swarm.js'));
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
  hooks = { swarms, syncs, protocol, i18n, manifestDigestOk };
  return hooks;
}

/* ------------------------------ 测试数据 ------------------------------ */

const sha256 = (s) => nodeCrypto.createHash('sha256').update(s).digest('hex');

function makeManifest(tag, { chunkCount = 12, durationSec = 1200 } = {}) {
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

const ofType = (peer, t) => peer.sent.filter((m) => m.t === t);

async function flush(rounds = 30) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

async function until(cond, what, max = 2000) {
  for (let i = 0; i < max; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail(`等不到：${what}`);
}

/* ------------------------------ 启动一台手机 ------------------------------ */

let caseNo = 0;

/**
 * 以信令模式进房（假 WebSocket 永远连不上，不影响直连），挂上一条已认证的房主连接，
 * 再由房主发 ROLE 认定身份。返回操作这台手机需要的一切。
 */
async function bootPhone(t, { securityMode = 'trusted', role = 'guest', native = fakeNative() } = {}) {
  const h = await installHooks();
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 });
  performance.now = () => Date.now();
  t.after(() => {
    performance.now = realPerfNow;
  });

  const store = new Map([['sw.securityMode', securityMode]]);
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  globalThis.window.localStorage = globalThis.localStorage;
  globalThis.document = fakeDocument();
  globalThis.location = { reload() {} };
  globalThis.Native = native;
  Object.defineProperty(globalThis, 'WebSocket', { value: SilentWebSocket, configurable: true, writable: true });

  const swarmCount = h.swarms.length;
  await import(assetUrl('app-android.js') + `?case=${++caseNo}`);
  const $ = (id) => globalThis.document.getElementById(id);
  // 站点授权改成页面里的对话框：弹一次记一条正文，测试自己点允许/拒绝
  const asks = [];
  const askBox = $('site-ask');
  const origAdd = askBox.classList.add;
  askBox.classList.add = (...names) => {
    origAdd(...names);
    if (names.includes('on')) asks.push($('site-ask-text').textContent);
  };
  $('url').value = 'ws://127.0.0.1:9';
  $('room').value = 'room';
  $('join').click();
  await flush(2);
  assert.equal(h.swarms.length, swarmCount + 1, '进房后应当建好 swarm');
  const swarm = h.swarms.at(-1);
  assert.equal(swarm.securityMode, securityMode);

  const host = fakeHostPeer();
  swarm.addPeer(host);
  const syncCount = h.syncs.length;
  const roles = role === 'guest' ? [[swarm.peerId, 'guest']] : [[swarm.peerId, 'admin']];
  swarm._onCtrl(host, { t: 'role', hostId: HOST_ID, roles });
  assert.equal(h.syncs.length, syncCount + 1);
  const sync = h.syncs.at(-1);
  assert.equal(sync.hostId, HOST_ID);

  let lamport = 0;
  const phone = {
    h,
    t,
    $,
    swarm,
    sync,
    host,
    native,
    asks,
    /** 对话框弹着就点一下（true=允许）；没弹就什么都不做。 */
    answerSite(ok) {
      if (!askBox.classList.contains('on')) return false;
      $(ok ? 'site-allow' : 'site-deny').click();
      return true;
    },
    siteAsking: () => askBox.classList.contains('on'),
    get peerId() {
      return swarm.peerId;
    },
    send(msg) {
      swarm._onCtrl(host, msg);
    },
    hostSync({ paused, position, seq }) {
      swarm._onCtrl(host, { t: 'sync', paused, position, lamport: ++lamport + 100, by: HOST_ID, name: '房主', seq });
    },
    async deliverManifest(manifest) {
      swarm._onCtrl(host, { t: 'manifest', manifest });
      await flush(60);
    },
    async advance(ms, step = 50) {
      for (let done = 0; done < ms; done += step) {
        t.mock.timers.tick(Math.min(step, ms - done));
        await flush(4);
      }
    },
    outboundStalls() {
      return ofType(host, 'stall').map((m) => m.stalled);
    },
    manifestGets(fileId) {
      return ofType(host, 'manifest-get').filter((m) => m.fileId === fileId).length;
    },
    nativeCalls(name) {
      return native.calls.filter((c) => c[0] === name);
    },
  };
  return phone;
}

function fullState(protocol, manifest) {
  const have = new Uint8Array(manifest.chunkCount).fill(1);
  return {
    bitfield: protocol.packBitfield(have),
    haveCount: manifest.chunkCount,
    contiguousBytes: manifest.size,
    complete: true,
  };
}

/* ======================== android#0：清单往返期间列表换了一版 ======================== */

test('安卓端：要清单期间房主发来 seq 不变的新快照，拿到清单后照样开会话', async (t) => {
  const phone = await bootPhone(t);
  const a = makeManifest('A');
  const item = fileItem(a, 1);
  phone.send(playlistMsg({ rev: 1, seq: 1, queue: [item], started: false }));
  phone.send({ t: 'bitfield', s: 1, full: true });
  await flush();
  assert.equal(phone.manifestGets(a.fileId), 1, '当前项没有会话时要向房主要清单');

  // 房主按了播放（markStarted）：rev 加一、seq 不变，当前项换成了一个新对象
  phone.send(playlistMsg({ rev: 2, seq: 1, queue: [{ ...item }], started: true }));
  await flush();

  await phone.deliverManifest(a);
  await until(() => phone.nativeCalls('openLeech').length > 0, '清单到了应当开接收会话');
  assert.equal(phone.nativeCalls('openLeech').length, 1);
  assert.doesNotMatch(phone.$('film').textContent, /正在获取清单/, '片名一栏不能停在「正在获取清单…」');
  assert.match(phone.$('film').textContent, /^A\.mp4 · /);
  assert.equal(phone.swarm.files.get(1)?.manifest.fileId, a.fileId, '会话要挂进当前项的槽位');
});

test('安卓端：清单回来时当前项已经换成别的片，这份清单不拿来开会话', async (t) => {
  const phone = await bootPhone(t);
  const a = makeManifest('A2');
  const b = makeManifest('B2');
  const itemA = fileItem(a, 1);
  const itemB = fileItem(b, 2);
  phone.send(playlistMsg({ rev: 1, seq: 1, queue: [itemA, itemB], started: false }));
  phone.send({ t: 'bitfield', s: 1, full: true });
  await flush();
  assert.equal(phone.manifestGets(a.fileId), 1);

  phone.send(playlistMsg({ rev: 2, seq: 2, queue: [itemB], history: [itemA] }));
  await flush();
  await phone.deliverManifest(a);
  await phone.advance(200);
  assert.equal(phone.nativeCalls('openLeech').length, 0, '已经不是当前项的片不开会话');
  assert.equal(phone.swarm.files.size, 0);
});

/* ======================== android#1：新播放器补放房间状态 ======================== */

test('安卓端：播放器起来后补放房间位置，管理员手机不会把全房拉回片头', async (t) => {
  const phone = await bootPhone(t, { securityMode: 'safe', role: 'admin' });
  const a = makeManifest('R1', { durationSec: 1200 });
  phone.native.mediaDuration = 1200;
  const item = fileItem(a, 1, { resumeAt: 600 });
  // 安全模式：清单一到就是完整文件（上一轮已经收完），马上起播
  const native = phone.native;
  native.stateFor = () => fullState(phone.h.protocol, a);

  phone.send(playlistMsg({ rev: 1, seq: 1, queue: [item] }));
  // 房主早已开播：房间在 600 秒处播放。手机这时还没有播放器，只能记下来
  phone.hostSync({ paused: false, position: 600, seq: 1 });
  phone.send({ t: 'bitfield', s: 1, full: true });
  await flush();
  assert.equal(phone.nativeCalls('playerLoad').length, 0);
  await phone.advance(2000);
  await phone.deliverManifest(a);
  await until(() => phone.nativeCalls('playerLoad').length === 1, '完整文件应当马上起播');
  native.stateFor = null;

  await phone.advance(1000);
  const seeks = phone.nativeCalls('seek').map((c) => c[1]);
  assert.ok(seeks.length >= 1, `新播放器要跳到房间位置，实际命令：${JSON.stringify(native.calls)}`);
  const target = seeks.at(-1);
  assert.ok(target >= 600 && target < 610, `跳转目标应在房间当前位置附近，实际 ${target}`);
  assert.equal(native.player.paused, false, '房间在播，新播放器也要播起来');
  const room = phone.sync.sharedPositionNow();
  assert.ok(Math.abs(native.playerPosition() - room) < 1.5, `播放器 ${native.playerPosition()} 应跟上房间 ${room}`);

  // 管理员在手机上点一下暂停再点播放：广播出去的位置必须是房间位置，而不是片头
  const before = ofType(phone.host, 'sync').length;
  phone.$('pp').click();
  await phone.advance(300);
  phone.$('pp').click();
  await phone.advance(300);
  const sent = ofType(phone.host, 'sync').slice(before);
  assert.equal(sent.length, 2);
  for (const m of sent) assert.ok(m.position >= 600, `广播位置 ${m.position} 不能把全房拉回片头`);
});

test('安卓端：解除卡顿的播放命令先于加载送达时，新播放器照样按房间状态播起来', async (t) => {
  const phone = await bootPhone(t, { securityMode: 'trusted' });
  const url = 'https://cdn.example.org/v.m3u8';
  const item = linkItem('https://video.example.org/watch?v=1');
  phone.send(playlistMsg({ rev: 1, seq: 1, queue: [item] }));
  phone.hostSync({ paused: false, position: 42, seq: 1 });
  await flush();
  // 此时还没有播放器：播放命令落空
  assert.equal(phone.native.player, null);
  await phone.advance(1000);

  phone.send({ t: 'now-link', seq: 1, playback: { url, headers: {} } });
  await flush();
  phone.answerSite(true);
  await flush();
  assert.equal(phone.nativeCalls('playerLoadUrl').length, 1);
  await phone.advance(1000);
  assert.equal(phone.native.player.paused, false, '房间在播，链接播放器不能停在暂停');
  assert.ok(phone.native.playerPosition() >= 42, `链接播放器要跳到房间位置，实际 ${phone.native.playerPosition()}`);
});

/* ======================== android#2：换片时刷新状态栏 ======================== */

test('安卓端：换到还没有会话的片时，状态栏、缓冲条和时间不再显示上一部的', async (t) => {
  const phone = await bootPhone(t, { securityMode: 'trusted' });
  const a = makeManifest('S1', { durationSec: 1200 });
  const b = makeManifest('S2', { durationSec: 3600 });
  phone.native.mediaDuration = 1200;
  const itemA = fileItem(a, 1);
  const itemB = fileItem(b, 2);
  phone.native.stateFor = () => fullState(phone.h.protocol, a);
  phone.send(playlistMsg({ rev: 1, seq: 1, queue: [itemA, itemB] }));
  phone.hostSync({ paused: false, position: 0, seq: 1 });
  phone.send({ t: 'bitfield', s: 1, full: true });
  await flush();
  await phone.deliverManifest(a);
  await until(() => phone.nativeCalls('playerLoad').length === 1, '上一部起播');
  await phone.advance(1500);
  assert.match(phone.$('status').textContent, /^可播 100% /);
  assert.equal(phone.$('buf').firstElementChild.style.width, '100%');
  assert.notEqual(phone.$('time').textContent, '0:00 / 0:00');

  // 房主切到下一部，这部还没有人向手机报位图，暂时要不了清单
  phone.native.stateFor = null;
  phone.send(playlistMsg({ rev: 2, seq: 2, queue: [itemB], history: [itemA] }));
  await flush();
  assert.equal(phone.$('buf').firstElementChild.style.width, '0%', '缓冲条要清零');
  assert.match(phone.$('status').textContent, /^可播 0% · 已有 0\/12 片/);
  assert.equal(phone.$('time').textContent, '0:00 / 1:00:00', '时间要按新片显示');
  assert.equal(Number(phone.$('seek').value), 0, '进度条要回到开头');

  // 切到链接项：状态栏改成链接的说明
  const link = linkItem('https://video.example.org/watch?v=2');
  phone.send(playlistMsg({ rev: 3, seq: 3, queue: [link], history: [itemB, itemA] }));
  await flush();
  assert.match(phone.$('status').textContent, /^视频直链/);

  // 列表放完了：不再显示任何一部的进度
  phone.send(playlistMsg({ rev: 4, seq: 4, queue: [], history: [link, itemB, itemA], started: false }));
  await flush();
  assert.equal(phone.$('status').textContent, '');
  assert.equal(phone.$('buf').firstElementChild.style.width, '0%');
});

/* ================= app-flow#2 同类：本机收不下当前项时不能一直卡着全房 ================= */

test('安卓端：管理员手机存储不够开不了会话时退出卡顿，腾出空间后自动接着收', async (t) => {
  const full = '!磁盘空间不够：这部片子需要 48.20GB，手机只剩 12.03GB';
  let diskFull = true;
  const native = fakeNative({ openLeech: () => (diskFull ? full : undefined) });
  const phone = await bootPhone(t, { securityMode: 'trusted', role: 'admin', native });
  const a = makeManifest('D1');
  const item = fileItem(a, 1);
  phone.send(playlistMsg({ rev: 1, seq: 1, queue: [item] }));
  phone.send({ t: 'bitfield', s: 1, full: true });
  await flush();
  assert.deepEqual(phone.outboundStalls(), [true], '手上一片都没有，先报卡顿');

  await phone.deliverManifest(a);
  await until(() => phone.nativeCalls('openLeech').length === 1, '尝试开会话');
  await flush();
  assert.deepEqual(phone.outboundStalls(), [true, false], '明确收不下时要撤销卡顿，别让全房一直等');
  assert.equal(phone.sync.localStalled, false);
  assert.equal(phone.$('status').textContent, '没法接收这一部：磁盘空间不够：这部片子需要 48.20GB，手机只剩 12.03GB');
  assert.equal(phone.$('buf').firstElementChild.style.width, '0%');
  assert.match(phone.$('film').textContent, /^D1\.mp4 · 可信房间$/, '清单已经拿到，不再显示「正在获取清单…」');
  const failLogs = native.logs.filter((l) => l.includes('打开接收会话失败'));
  assert.equal(failLogs.length, 1);

  // 其他成员进出触发的重试不会反复刷日志、也不会再报卡顿
  phone.send({ t: 'bitfield', s: 1, full: true });
  await flush();
  assert.deepEqual(phone.outboundStalls(), [true, false]);

  // 还是不够：隔一阵再试一次，不再向房主要清单，也不重复刷日志
  await phone.advance(31_000, 500);
  assert.equal(phone.nativeCalls('openLeech').length, 2);
  assert.equal(phone.manifestGets(a.fileId), 1, '清单已经在手上，重试不再要');
  assert.equal(native.logs.filter((l) => l.includes('打开接收会话失败')).length, 1);
  assert.deepEqual(phone.outboundStalls(), [true, false]);

  // 用户腾出了空间：下一次重试就开出会话，照常参与卡顿判断
  diskFull = false;
  await phone.advance(31_000, 500);
  assert.equal(phone.nativeCalls('openLeech').length, 3);
  assert.equal(phone.swarm.files.get(1)?.manifest.fileId, a.fileId);
  assert.match(phone.$('status').textContent, /^可播 0% /);
  assert.deepEqual(phone.outboundStalls(), [true, false, true], '开出会话后缓冲不足照常报卡顿');
  assert.equal(phone.manifestGets(a.fileId), 1);
});

test('安卓端：收不下的片换走再换回来，不先报卡顿再撤销', async (t) => {
  const native = fakeNative({ openLeech: () => '!磁盘空间不够：这部片子需要 48.20GB，手机只剩 12.03GB' });
  const phone = await bootPhone(t, { securityMode: 'trusted', role: 'admin', native });
  const a = makeManifest('D2');
  const b = makeManifest('D3');
  const itemA = fileItem(a, 1);
  const itemB = fileItem(b, 2);
  phone.send(playlistMsg({ rev: 1, seq: 1, queue: [itemA, itemB] }));
  phone.send({ t: 'bitfield', s: 1, full: true });
  await flush();
  await phone.deliverManifest(a);
  await until(() => phone.nativeCalls('openLeech').length === 1, '尝试开会话');
  await flush();
  assert.deepEqual(phone.outboundStalls(), [true, false]);

  // 换到 B（B 暂时没人有，只报卡顿），再用 playNow 换回 A
  phone.send(playlistMsg({ rev: 2, seq: 2, queue: [itemB, itemA] }));
  await flush();
  assert.deepEqual(phone.outboundStalls(), [true, false, true]);
  phone.send(playlistMsg({ rev: 3, seq: 3, queue: [itemA, itemB] }));
  await flush();
  // resetMedia 已经清掉了本地卡顿；A 已知收不下，立即用手里的清单再试一次，不再报卡顿
  assert.equal(phone.nativeCalls('openLeech').length, 2, '换回来要马上再试一次');
  assert.equal(phone.sync.localStalled, false);
  assert.deepEqual(ofType(phone.host, 'stall').filter((m) => m.seq === 3), []);
  assert.match(phone.$('status').textContent, /^没法接收这一部：/);
});

test('安卓端：另一部片开出会话不会抹掉这一部收不下的记录，换回来照样不先报卡顿', async (t) => {
  const full = '!磁盘空间不够：这部片子需要 48.20GB，手机只剩 12.03GB';
  const a = makeManifest('D4');
  const b = makeManifest('D5', { chunkCount: 4 });
  let aFull = true;
  const native = fakeNative({ openLeech: ({ fileId }) => (fileId === a.fileId && aFull ? full : undefined) });
  const phone = await bootPhone(t, { securityMode: 'trusted', role: 'admin', native });
  const itemA = fileItem(a, 1);
  const itemB = fileItem(b, 2);
  const leechOf = (m) => phone.nativeCalls('openLeech').filter((c) => c[1] === m.fileId).length;
  const failLogs = () => native.logs.filter((l) => l.includes('打开接收会话失败')).length;
  phone.send(playlistMsg({ rev: 1, seq: 1, queue: [itemA, itemB] }));
  phone.send({ t: 'bitfield', s: 1, full: true });
  phone.send({ t: 'bitfield', s: 2, full: true });
  await flush();
  await phone.deliverManifest(a);
  await until(() => leechOf(a) === 1, 'A 尝试开会话');
  await flush();
  assert.deepEqual(phone.outboundStalls(), [true, false]);

  // 房主换到小文件 B，B 顺利开出会话
  phone.send(playlistMsg({ rev: 2, seq: 2, queue: [itemB, itemA] }));
  await flush();
  assert.equal(phone.manifestGets(b.fileId), 1);
  await phone.deliverManifest(b);
  await until(() => leechOf(b) === 1, 'B 开会话');
  await flush();
  assert.equal(phone.swarm.files.get(2)?.manifest.fileId, b.fileId);

  // 再换回 A：A 收不下的记录还在，马上用手里的清单再试，不先报卡顿，也不再向房主要清单
  // （房主 30 秒内不重复回同一份清单，再要的话全房要跟着停半分钟以上）
  phone.send(playlistMsg({ rev: 3, seq: 3, queue: [itemA, itemB] }));
  await flush();
  assert.equal(leechOf(a), 2, '换回来要马上再试一次');
  assert.equal(phone.manifestGets(a.fileId), 1, '清单还在手上，不用再要');
  assert.equal(phone.sync.localStalled, false);
  assert.deepEqual(ofType(phone.host, 'stall').filter((m) => m.seq === 3), []);
  assert.match(phone.$('status').textContent, /^没法接收这一部：磁盘空间不够/);
  assert.equal(failLogs(), 1, '同一部的同一个失败不重复刷日志');

  // 腾出空间后 A 开出会话，A 自己的失败记录随之作废：之后再收不下算新的失败，要重新提示
  aFull = false;
  await phone.advance(31_000, 500);
  assert.equal(leechOf(a), 3);
  assert.equal(phone.swarm.files.get(1)?.manifest.fileId, a.fileId);
  aFull = true;
  phone.send(playlistMsg({ rev: 4, seq: 4, queue: [itemB, itemA] }));
  await flush();
  phone.send(playlistMsg({ rev: 5, seq: 5, queue: [itemA, itemB] }));
  await flush();
  assert.equal(phone.manifestGets(a.fileId), 2, '失败记录作废后按常规重新要清单');
  await phone.deliverManifest(a);
  await until(() => leechOf(a) === 4, 'A 再次尝试开会话');
  await flush();
  assert.equal(failLogs(), 2);
  assert.equal(phone.sync.localStalled, false);
});

/* ================= security#0 / #1 同类：链接授权按实际连接的站点 ================= */

test('安卓端：链接项的授权按房主给的播放地址来源询问，不看快照里的 addedBy', async (t) => {
  const phone = await bootPhone(t);
  // 恶意房主把 addedBy 写成手机自己的 id，播放地址指向一个从没问过的站点
  const item = linkItem('https://www.youtube.com/watch?v=x', { addedBy: phone.peerId });
  phone.send(playlistMsg({ rev: 1, seq: 1, queue: [item] }));
  phone.send({ t: 'now-link', seq: 1, playback: { url: 'https://tracker.evil.example/x', headers: {} } });
  await flush();
  assert.ok(phone.siteAsking(), '必须先问');
  assert.match(phone.asks[0], /https:\/\/tracker\.evil\.example/);
  phone.answerSite(false);
  await flush();
  assert.equal(phone.nativeCalls('playerLoadUrl').length, 0, '拒绝后不能连接');

  // 允许过的是 youtube 的网站本身；房主换一条同站链接、兜底地址却在别处，照样要问
  phone.send(playlistMsg({ rev: 2, seq: 2, queue: [linkItem('https://www.youtube.com/watch?v=y')] }));
  phone.send({ t: 'now-link', seq: 2, playback: { url: 'https://www.youtube.com/v.m3u8', headers: {} } });
  await flush();
  assert.ok(phone.siteAsking());
  phone.answerSite(true);
  await flush();
  assert.equal(phone.asks.length, 2);
  assert.equal(phone.nativeCalls('playerLoadUrl').length, 1);
  phone.send(playlistMsg({ rev: 3, seq: 3, queue: [linkItem('https://www.youtube.com/watch?v=z')] }));
  phone.send({ t: 'now-link', seq: 3, playback: { url: 'https://other.example.net/z.mp4', headers: {} } });
  await flush();
  assert.ok(phone.siteAsking(), '换了来源就要重新问');
  assert.equal(phone.asks.length, 3);
  assert.match(phone.asks[2], /https:\/\/other\.example\.net/);
  phone.answerSite(false);
  await flush();
  assert.equal(phone.nativeCalls('playerLoadUrl').length, 1, '拒绝的地址不能加载');
});

/* ================= app-flow#0 同类：换片后旧播放器的轮询不再进来 ================= */

test('安卓端：换片时先停掉旧播放器的轮询，新片的状态不会被旧快照改写', async (t) => {
  const phone = await bootPhone(t, { securityMode: 'trusted' });
  const a = makeManifest('P1', { durationSec: 1200 });
  const b = makeManifest('P2', { durationSec: 3600 });
  phone.native.mediaDuration = 1200;
  phone.native.stateFor = () => fullState(phone.h.protocol, a);
  const itemA = fileItem(a, 1);
  const itemB = fileItem(b, 2);
  phone.send(playlistMsg({ rev: 1, seq: 1, queue: [itemA, itemB] }));
  phone.hostSync({ paused: false, position: 0, seq: 1 });
  phone.send({ t: 'bitfield', s: 1, full: true });
  await flush();
  await phone.deliverManifest(a);
  await until(() => phone.nativeCalls('playerLoad').length === 1, '上一部起播');
  await phone.advance(1000);
  assert.ok(phone.native.snapshots > 0);

  phone.native.stateFor = null;
  phone.send(playlistMsg({ rev: 2, seq: 2, queue: [itemB], history: [itemA] }));
  await flush();
  const releasedAt = phone.native.calls.findIndex((c) => c[0] === 'release');
  assert.ok(releasedAt >= 0, '换片要释放旧播放器');
  const polled = phone.native.snapshots;
  await phone.advance(2000);
  assert.equal(phone.native.snapshots, polled, '旧播放器的轮询必须停掉');
  assert.equal(phone.sync.lastTick, null, '新片还没有播放器，不能留着旧 tick');
  assert.equal(phone.sync.duration, 3600, '时长不能被旧片覆盖');
});

/* ============ 中途加入：卡顿判据必须用这一拍的播放位置算出来的 runBytes ============ */

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
    complete: false,
  };
}

test('安卓端：跳进空洞的第一条 tick 就报卡顿，不是等下一拍（runBytes 不能用上一拍的位置算）', async (t) => {
  // 60MB / 60 秒 = 1MB/s：stall 线 5MB、恢复线 15MB
  const phone = await bootPhone(t, { securityMode: 'trusted', role: 'admin' });
  const a = makeManifest('MJ1', { chunkCount: 60, durationSec: 60 });
  phone.native.mediaDuration = 60;
  const item = fileItem(a, 1);
  // 片头 8MB（起播门槛）+ [20MB, 60MB)；中间 [8MB, 20MB) 是洞
  phone.native.stateFor = () => partialState(phone.h.protocol, a, [[0, 8], [20, 60]]);

  phone.send(playlistMsg({ rev: 1, seq: 1, queue: [item] }));
  // 房间已经放到 25 秒（= 25MB 处，那里有数据）。暂停着，房间时钟不走，好逐拍观察
  phone.hostSync({ paused: true, position: 25, seq: 1 });
  phone.send({ t: 'bitfield', s: 1, full: true });
  await flush();
  await phone.deliverManifest(a);
  await until(() => phone.nativeCalls('playerLoad').length === 1, '中途加入应当起播');
  await phone.advance(1500);
  assert.ok(phone.native.playerPosition() >= 24, `播放器要跳到房间位置，实际 ${phone.native.playerPosition()}`);
  assert.equal(phone.sync.localStalled, false, '25MB 处往后还有 35MB 连续，不该卡');

  const margins = [];
  phone.sync.on('margin', (m) => margins.push(m));
  const before = phone.outboundStalls().length;

  // 房主拖回 10 秒 —— 那是 [8MB,20MB) 的洞，一个字节都读不了
  phone.hostSync({ paused: true, position: 10, seq: 1 });
  await flush();
  await phone.advance(250); // 恰好一拍

  const MB = 1024 * 1024;
  const last = margins.at(-1);
  assert.ok(last, '这一拍要评估一次卡顿');
  assert.equal(Math.round(last.playbackByte / MB), 10, '播放位置按这一拍的 10 秒算');
  assert.equal(
    last.runBytes,
    0,
    `runBytes 还是上一拍（25 秒处）算出来的 ${last.runBytes}：位置和余量不是同一拍的数`
  );
  assert.equal(phone.sync.localStalled, true, '跳进空洞要当拍就报卡顿，晚一拍全房就多抖一下');
  assert.deepEqual(phone.outboundStalls().slice(before), [true]);
});

/* ------------------------------ 翻译 ------------------------------ */

test('安卓端：新增的状态文案有英文', async () => {
  const { translate } = await import(assetUrl('i18n.js'));
  assert.equal(
    translate('没法接收这一部：磁盘空间不够：这部片子需要 48.20GB，手机只剩 12.03GB', 'en'),
    'Cannot receive this video: Not enough storage: this video needs 48.20 GB, but the phone has only 12.03 GB free'
  );
  assert.equal(translate('没法接收这一部：boom', 'en'), 'Cannot receive this video: boom');
});

/* ==================== 播放器代号：换片瞬间的旧快照要丢掉 ==================== */

/**
 * 原生的 playerLoad / playerRelease 只是把活投递到主线程，同步返回时播放器还没换完。
 * 于是换片后手机取到的第一条快照很可能还是上一部片的读数（比如位置 5 分钟、正在播）——
 * 把它当成这一部的用户操作，管理员手机会把全房拉到 5 分钟。原生因此给每次换片发一个代号、
 * 快照里带着它；JS 认代号，对不上就整条丢弃。
 */
test('安卓端：代号对不上的快照一律丢掉，不会拿上一部的位置广播跳转', async (t) => {
  const phone = await bootPhone(t, { securityMode: 'safe', role: 'admin' });
  const a = makeManifest('G1', { durationSec: 1200 });
  phone.native.mediaDuration = 1200;
  const native = phone.native;
  native.stateFor = () => fullState(phone.h.protocol, a);

  phone.send(playlistMsg({ rev: 1, seq: 1, queue: [fileItem(a, 1)] }));
  phone.hostSync({ paused: false, position: 0, seq: 1 });
  phone.send({ t: 'bitfield', s: 1, full: true });
  await flush();
  await phone.advance(2000);
  await phone.deliverManifest(a);
  await until(() => phone.nativeCalls('playerLoad').length === 1, '完整文件应当马上起播');
  native.stateFor = null;
  await phone.advance(1000);

  // 播放器那头「跳」到 300 秒，但这条快照带的是上一代的代号（release/load 还没在主线程落地）
  native.staleGeneration(true);
  native.playerSeek(300);
  await phone.advance(1500);
  assert.ok(
    Math.abs((phone.sync.lastTick?.position ?? 0) - 300) > 5,
    `带旧代号的快照不该被喂进同步引擎，实际 ${phone.sync.lastTick?.position}`
  );

  // 代号对上之后，同一条读数照常生效 —— 证明上面挡住的是代号，不是别的
  native.staleGeneration(false);
  await phone.advance(1500);
  assert.ok(
    Math.abs((phone.sync.lastTick?.position ?? 0) - 300) < 5,
    `代号对上之后这条读数应当照常生效，实际 ${phone.sync.lastTick?.position}`
  );
});
