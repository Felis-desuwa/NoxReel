'use strict';

// P4 修复：链接授权钉住询问目标、解析失败要有出口、隔离浏览器抓到的地址、兜底地址的时效，
// 以及自动开播的起点与上膛条件、拖动被退回后的重算、降为游客后的编辑控件。
//
// app.js 是整页的编排脚本，没法整个在 Node 里跑：这里把涉及的顶层函数原样抠出来放进 vm 沙箱，
// 周围配上假 DOM、假主进程接口和真的 playlist / syncEngine，按出事时的先后顺序喂事件。
// 全程不启动播放器、不联网、不出声。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8').replace(/\r\n/g, '\n');
const LIB = path.join(root, 'src/renderer/lib');
const load = (name) => import(pathToFileURL(path.join(LIB, name)).href);

/** app.js 顶层函数的源码：从声明行到下一个顶格的 `}`。 */
function fnSource(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层函数 ${name}`);
  const end = APP.indexOf('\n}\n', m.index);
  assert.ok(end > m.index, `${name} 的结尾没找到`);
  return APP.slice(m.index, end + 2);
}

function sandbox(fns, globals) {
  const ctx = { ...globals };
  vm.createContext(ctx);
  vm.runInContext(fns.map(fnSource).join('\n\n'), ctx, { filename: 'app.js（节选）' });
  return ctx;
}

async function flush(rounds = 6) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

/** app.js 里的数值常量，免得测试和源码各写一份。 */
function appConst(name) {
  const m = new RegExp(`^const ${name} = ([\\d_ *]+);`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到常量 ${name}`);
  return Function(`return (${m[1]});`)();
}
const FALLBACK_CONFIRM_MS = appConst('FALLBACK_CONFIRM_MS');

/** applyOp 的执行上下文：房主自己动手。 */
let idSeq = 0;
const opCtx = () => ({
  actor: 'host',
  actorName: 'host',
  isController: () => true,
  newId: () => 'zz' + String(++idSeq).padStart(6, '0'),
  position: 0,
});
const LINK_INFO_TTL_MS = appConst('LINK_INFO_TTL_MS');

/* ------------------------------ 假 DOM ------------------------------ */

function el() {
  const e = { className: '', textContent: '', value: '', hidden: false, disabled: false, checked: false };
  e.setAttribute = (name, value) => {
    e[name] = String(value);
  };
  e.classList = {
    toggle: (c, on) => {
      if (c === 'hidden') e.hidden = on === undefined ? !e.hidden : !!on;
    },
    add: (c) => {
      if (c === 'hidden') e.hidden = true;
    },
    remove: (c) => {
      if (c === 'hidden') e.hidden = false;
    },
    contains: (c) => (c === 'hidden' ? e.hidden : false),
  };
  return e;
}

function domStub(preset = {}) {
  const map = new Map();
  const $ = (id) => {
    if (!map.has(id)) map.set(id, el());
    return map.get(id);
  };
  for (const [id, v] of Object.entries(preset)) Object.assign($(id), v);
  return { $, map };
}

/* --------------------------- 链接相关的沙箱 --------------------------- */

const LINK_FNS = [
  'siteOf',
  'siteHost',
  'linkKey',
  'siteApproved',
  'cachedLinkInfo',
  'approveLinkSite',
  'skipLinkItem',
  'linkFallback',
  'activateLinkItem',
  'fallbackAsking',
  'linkAsking',
  'askLinkConsent',
  'linkResolveFailed',
  'tryLinkFallback',
  'useLinkInfo',
  'onNowLink',
  'linkNotice',
  'linkWaitText',
  'renderStatus',
  'renderNowKicker',
  'updateStripTone',
  'localReadyNow',
  'refreshNowLink',
];

async function linkRoom({ peerId = 'victim-peer', inspect, isHost = false, paused = true } = {}) {
  const { isItemReady, currentItem } = await load('playlist.js');
  const clock = { now: Date.now() };
  class FakeDate extends Date {
    static now() {
      return clock.now;
    }
  }
  const inspected = [];
  const launched = [];
  const logs = [];
  const banners = [];
  const dom = domStub();
  const S = {
    peerId,
    hostId: 'host-peer',
    current: null,
    currentSeq: 1,
    playlist: { rev: 0, seq: 1, queue: [], history: [], started: false, autoplay: true, nextSlot: 1 },
    links: new Map(),
    myLinks: new Set(),
    approvedSites: new Set(),
    skippedLinks: new Set(),
    resolvingLinks: new Set(),
    linkConsent: null,
    linkFailedSeq: null,
    fallbackConsent: null,
    nowLink: null,
    linkInfo: null,
    filePath: null,
    mpvRunning: false,
    switchingMedia: false,
    sourceType: 'link',
    roomSecurityMode: 'trusted',
    mediaSafety: { status: 'idle' },
    diskFull: new Set(),
    sessions: new Map(),
    swarm: { peers: new Map(), files: new Map() },
    sync: {
      status: () => ({ stalled: false, paused, intendedPaused: paused, position: 0, duration: 0, waitingFor: [] }),
      canIControl: () => true,
    },
  };
  const noop = () => {};
  const ctx = sandbox(LINK_FNS, {
    S,
    URL,
    updatePresence: () => {}, // Discord 状态显示：这里不关心
    Date: FakeDate,
    LINK_INFO_TTL_MS,
    FALLBACK_CONFIRM_MS,
    MSG: { NOW_LINK: 'now-link' },
    roomEntered: true,
    isItemReady,
    currentItem,
    log: (text, kind) => logs.push([text, kind]),
    renderPlaylist: noop,
    renderPlaylistSoon: noop,
    updateLocalReady: noop,
    preResolveNextLink: noop,
    localOptedOut: () => false,
    canEditPlaylist: () => true,
    currentUnavailable: () => false,
    currentSession: () => null,
    scanProgressLabel: () => '扫描中',
    setScanTicker: () => {},
    stallBannerText: () => '卡住了',
    pushMpvBanner: (text) => banners.push(text),
    fmtTime: () => '0:00',
    $: dom.$,
    isRoomHost: () => isHost,
    onLinkSessionReady: async () => launched.push(S.filePath),
    window: {
      sw: {
        media: {
          inspectLink: (url) => {
            inspected.push(url);
            return inspect ? inspect(url) : Promise.resolve({ url, title: 't', duration: 60, resolvedAt: clock.now });
          },
        },
        player: { osd: noop },
      },
    },
  });
  return { ctx, S, dom, inspected, launched, logs, banners, clock };
}

const linkItem = (over = {}) => ({
  id: 'aaaaaaaa',
  kind: 'link',
  url: 'https://good.example/v',
  title: '',
  durationSec: 0,
  addedBy: 'host-peer',
  ...over,
});

/* ======================= links#0 换网址骗授权 ======================= */

test('房主只换同一 id 的网址：整张快照拒收（正常操作不会动 kind/url/fileId）', async () => {
  const { validateSnapshot, applyOp } = await load('playlist.js');
  const { sameItemsKept } = sandbox(['sameItemsKept'], {});
  const base = validateSnapshot({
    rev: 7,
    seq: 2,
    nextSlot: 1,
    started: false,
    autoplay: true,
    history: [],
    queue: [
      { id: 'aaaaaaaa', kind: 'link', url: 'https://good.example/v', title: '', addedBy: '', addedByName: '' },
      { id: 'bbbbbbbb', kind: 'link', url: 'https://other.example/v', title: '', addedBy: '', addedByName: '' },
    ],
  });
  assert.ok(base);
  const swapped = validateSnapshot({
    ...base,
    rev: 8,
    queue: [{ ...base.queue[0], url: 'https://evil.example/x' }, base.queue[1]],
  });
  assert.ok(swapped, '格式校验本身拦不住（它只看单张快照）');
  assert.equal(sameItemsKept(base, swapped), false);

  // 正常的增删改排序都不该被误伤
  const ctxOp = opCtx();
  for (const op of [
    { type: 'move', id: 'bbbbbbbb', beforeId: 'aaaaaaaa' },
    { type: 'ended', seq: base.seq },
    { type: 'remove', id: 'bbbbbbbb' },
    { type: 'setAutoplay', on: false },
  ]) {
    const res = applyOp(base, op, ctxOp);
    assert.ok(res.ok, `${op.type} 应当成功`);
    assert.equal(sameItemsKept(base, res.state), true, `${op.type} 不该被当成换内容`);
  }

  // 真正的入口：换了内容的快照整张不收，本机列表原封不动
  const logs = [];
  const changed = [];
  const S = { hostId: 'host-peer', playlist: base, pendingOps: new Map() };
  const ctx = sandbox(['onPlaylistMessage', 'sameItemsKept'], {
    S,
    validateSnapshot,
    isRoomHost: () => false,
    log: (t, k) => logs.push([t, k]),
    onPlaylistChanged: () => changed.push(S.playlist.rev),
  });
  ctx.onPlaylistMessage({ state: swapped }, { peerId: 'host-peer' });
  assert.equal(S.playlist.rev, 7, '换了内容的快照不该被采纳');
  assert.deepEqual(changed, []);
  assert.ok(logs.some(([t]) => t === '收到的播放列表把已有条目的内容换掉了，已忽略'));

  // 正常的新快照照收
  const normal = validateSnapshot({ ...base, rev: 8 });
  ctx.onPlaylistMessage({ state: normal }, { peerId: 'host-peer' });
  assert.equal(S.playlist.rev, 8);
  assert.deepEqual(changed, [8]);
});

test('房主给晚到的成员补发兜底地址时，顺手检查它是不是该重新解析了', () => {
  const src = fnSource('initSwarmAndSync');
  const m = /if \(S\.nowLink\?\.seq === S\.playlist\.seq\) peer\.send\([^\n]*\n\s*refreshNowLink\(\);/.exec(src);
  assert.ok(m, 'greet 里补发 NOW_LINK 之后要调 refreshNowLink()，否则晚到的人永远只拿得到那条老地址');
});

test('快照换了网址却没被拦下时：点「允许」批准的仍是问过的那个网站，这一下不算数', async () => {
  const { ctx, S, launched, logs, clock } = await linkRoom();
  const good = linkItem();
  S.current = good;
  S.currentSeq = 1;
  await ctx.activateLinkItem(good, 1);
  assert.equal(ctx.linkWaitText(), '这一部要打开 good.example，需要你先允许');
  assert.deepEqual(
    { id: S.linkConsent.id, origin: S.linkConsent.origin, host: S.linkConsent.host },
    { id: 'aaaaaaaa', origin: 'https://good.example', host: 'good.example' }
  );

  // 房主把同一 id 的网址换成 evil（rev+1、seq 不变），此刻横幅上写的还是 good
  const evil = linkItem({ url: 'https://evil.example/x' });
  S.current = evil;
  clock.now += 10 * FALLBACK_CONFIRM_MS;
  ctx.approveLinkSite(evil);
  await flush();
  assert.deepEqual([...S.approvedSites], [], '批准的必须是问过的那个网站');
  assert.deepEqual(launched, []);
  assert.ok(logs.some(([t]) => t === '这一部的网址刚换成 evil.example，看清楚再点「允许」'));
  // 这次询问按新网址重新登记、重新计时
  assert.equal(S.linkConsent.origin, 'https://evil.example');
  assert.equal(S.linkConsent.at, clock.now);
  assert.equal(ctx.linkWaitText(), '这一部要打开 evil.example，需要你先允许');

  // 看清楚之后再点才算数
  clock.now += FALLBACK_CONFIRM_MS;
  ctx.approveLinkSite(evil);
  await flush();
  assert.deepEqual([...S.approvedSites], ['https://evil.example']);
});

/* ================== links#1 询问刚出现点了不算 ================== */

test('网页链接的询问刚出现就点「允许」不算数，和房主兜底地址同一道门槛', async () => {
  const { ctx, S, launched, logs, inspected } = await linkRoom();
  const item = linkItem();
  S.current = item;
  S.currentSeq = 1;
  await ctx.activateLinkItem(item, 1);

  ctx.approveLinkSite(item); // 时钟没走，等于询问出现的同一毫秒
  await flush();
  assert.deepEqual([...S.approvedSites], []);
  assert.deepEqual(inspected, [], '没批准就不该去解析');
  assert.deepEqual(launched, []);
  assert.ok(logs.some(([t]) => t === '这个询问刚出现，要打开的是 good.example，看清楚再点「允许」'));
  assert.equal(S.linkConsent.seq, 1, '询问还在，按钮不该消失');
});

/* ========= links#2 / ready-autoplay#1 / panel-ui#1 解析失败要有出口 ========= */

async function failedRoom() {
  const r = await linkRoom({ inspect: () => Promise.reject(new Error('地区限制')) });
  const item = linkItem({ url: 'https://ok.example/v' });
  r.S.approvedSites.add('https://ok.example');
  r.S.current = item;
  r.S.currentSeq = 4;
  await r.ctx.activateLinkItem(item, 4);
  return { ...r, item };
}

test('本机解析失败、房主又没给兜底地址：状态栏说清楚，本人有「先跳过」的出口', async () => {
  const { ctx, S, dom, item } = await failedRoom();
  assert.equal(S.linkFailedSeq, 4);
  assert.equal(ctx.linkResolveFailed(), true);
  assert.equal(ctx.linkWaitText(), '这个视频链接在你的电脑上无法解析，可以先跳过这一部');

  const notice = ctx.linkNotice(item);
  assert.equal(notice.text, '本机无法解析这个链接');
  assert.deepEqual(Array.from(notice.actions, (a) => a.key), ['skip-link'], '网站早就允许过了，这里不该再问「允许」');

  ctx.renderStatus();
  assert.equal(dom.$('btn-skip-link').hidden, false, '状态栏要给出「这一部我先跳过」');
  assert.equal(dom.$('btn-allow-link').hidden, true);
  assert.equal(dom.$('status-banner').textContent, '这个视频链接在你的电脑上无法解析，可以先跳过这一部');

  // 卡住自动连播的正是「本人永远不就绪」；跳过之后就不挡别人了
  assert.equal(ctx.localReadyNow(), false);
  ctx.skipLinkItem(item);
  assert.equal(ctx.localReadyNow(), true);
});

/* ================== links#4 房间在播时的横幅 ================== */

test('房间已经在播、本机还卡在授权：横幅说的是在等哪个网站，不是「播放中」', async () => {
  const { ctx, S, dom } = await linkRoom({ paused: false });
  const item = linkItem();
  S.current = item;
  S.currentSeq = 1;
  await ctx.activateLinkItem(item, 1);
  ctx.renderStatus();
  assert.equal(dom.$('status-banner').textContent, '这一部要打开 good.example，需要你先允许');
  assert.equal(dom.$('btn-allow-link').hidden, false);

  // 本机播放器起来之后照常显示房间状态
  S.mpvRunning = true;
  ctx.renderStatus();
  assert.equal(dom.$('status-banner').textContent, '播放中，所有人同步');
});

/* ============ links#3 隔离浏览器抓到的地址才是能放的地址 ============ */

test('隔离浏览器解析成功：交给播放器的是抓到的媒体地址，不是网页地址', async () => {
  const { ctx, S, launched } = await linkRoom();
  const item = linkItem({ url: 'https://site.example/watch/1' });
  S.approvedSites.add('https://site.example');
  S.current = item;
  S.currentSeq = 2;
  const info = {
    url: 'https://site.example/watch/1',
    title: 'x',
    duration: 10,
    extractor: 'isolated-browser',
    direct: false,
    playback: { url: 'https://cdn-a.example.net/hls/master.m3u8', headers: { referer: 'https://site.example/' } },
    resolvedAt: Date.now(),
  };
  await ctx.useLinkInfo(item, info, 2);
  assert.equal(S.filePath, 'https://cdn-a.example.net/hls/master.m3u8');
  assert.deepEqual(launched, ['https://cdn-a.example.net/hls/master.m3u8']);
  assert.equal(S.linkInfo.url, 'https://site.example/watch/1', 'S.linkInfo.url 还是页面地址（siteOf 要用它）');

  // yt-dlp 正常解析出来的那条路不变：页面地址交给 mpv 的 ytdl_hook 现解析
  const r2 = await linkRoom();
  r2.S.approvedSites.add('https://site.example');
  r2.S.current = item;
  r2.S.currentSeq = 2;
  await r2.ctx.useLinkInfo(item, { ...info, extractor: 'youtube' }, 2);
  assert.equal(r2.S.filePath, 'https://site.example/watch/1');
});

/* ================== links#6 兜底地址的时效 ================== */

test('房主的兜底地址带上解析时间：过期的不再拿去播，房主会重新解析一份发出来', async () => {
  const { ctx, S, clock, launched, logs } = await linkRoom({ inspect: () => Promise.reject(new Error('没装 yt-dlp')) });
  const item = linkItem({ url: 'https://ok.example/v' });
  S.approvedSites.add('https://ok.example');
  S.approvedSites.add('https://cdn.example');
  S.current = item;
  S.currentSeq = 5;

  // 房主一小时前解析出来的地址，greet 时原样补发给晚到的我
  ctx.onNowLink({ seq: 5, playback: { url: 'https://cdn.example/a.m3u8' }, resolvedAt: clock.now - 60 * 60 * 1000 }, {
    peerId: 'host-peer',
  });
  assert.equal(S.nowLink.resolvedAt, clock.now - 60 * 60 * 1000, '解析时间用消息里的，不是收到的时刻');
  assert.equal(ctx.linkFallback(item, 5), null, '过期的签名地址当作没有');

  await ctx.activateLinkItem(item, 5);
  assert.deepEqual(launched, [], '过期地址不该交给播放器');
  assert.equal(ctx.linkResolveFailed(), true, '落到「解析不了，可以先跳过」，而不是静默失败');

  // 房主重发一条刚解析好的，照常能用
  ctx.onNowLink({ seq: 5, playback: { url: 'https://cdn.example/b.m3u8' }, resolvedAt: clock.now }, {
    peerId: 'host-peer',
  });
  await flush();
  assert.deepEqual(launched, ['https://cdn.example/b.m3u8']);
  assert.ok(logs.length);
});

test('房主填了未来时间也不能让过期地址一直算新鲜', async () => {
  const { ctx, S, clock } = await linkRoom();
  const item = linkItem({ url: 'https://ok.example/v' });
  S.current = item;
  S.currentSeq = 5;
  ctx.onNowLink({ seq: 5, playback: { url: 'https://cdn.example/a.m3u8' }, resolvedAt: clock.now + 10 * LINK_INFO_TTL_MS }, {
    peerId: 'host-peer',
  });
  assert.equal(S.nowLink.resolvedAt, clock.now);
  clock.now += LINK_INFO_TTL_MS + 1;
  assert.equal(ctx.linkFallback(item, 5), null);
});

test('房主：兜底地址放久了，来新成员时重新解析一份广播出去', async () => {
  const { ctx, S, clock } = await linkRoom({ isHost: true });
  const item = linkItem({ url: 'https://ok.example/v' });
  S.approvedSites.add('https://ok.example');
  S.playlist = { ...S.playlist, seq: 6, queue: [item] };
  S.current = item;
  S.currentSeq = 6;
  const peer = { authenticated: true, sent: [], send(m) { this.sent.push(m); } };
  S.swarm.peers.set('late', peer);

  S.nowLink = { seq: 6, playback: { url: 'https://cdn.example/old.m3u8' }, resolvedAt: clock.now - 60 * 60 * 1000 };
  ctx.refreshNowLink();
  ctx.refreshNowLink(); // 同时来两个人也只跑一次
  await flush();
  assert.equal(S.nowLink.resolvedAt, clock.now);
  assert.equal(peer.sent.length, 1);
  assert.equal(peer.sent[0].t, 'now-link');
  assert.equal(peer.sent[0].resolvedAt, clock.now);

  // 还新鲜的就别白跑一遍 yt-dlp
  peer.sent.length = 0;
  ctx.refreshNowLink();
  await flush();
  assert.deepEqual(peer.sent, []);
});

/* ============== ready-autoplay#0 自动开播的起点 ============== */

const AUTO_FNS = ['armAutoStart', 'autoStartArmed', 'maybeAutoStart', 'startCurrentNow'];

function autoRoom({ isHost = true, waiting = [], sync } = {}) {
  const logs = [];
  const dom = domStub();
  const S = {
    playlist: { rev: 1, seq: 2, queue: [{ id: 'q1' }], history: [], started: false, autoplay: true, nextSlot: 1 },
    current: { id: 'q1', kind: 'file' },
    currentSeq: 2,
    switchingMedia: false,
    autoStartSeq: null,
    autoStartReason: null,
    sync,
  };
  const ctx = sandbox(AUTO_FNS, {
    S,
    $: dom.$,
    isRoomHost: () => isHost,
    readyWaiting: () => waiting,
    log: (t, k) => logs.push([t, k]),
    renderStatus: () => {},
    renderReady: () => {},
  });
  return { ctx, S, logs };
}

test('自动开播按房间共识的位置广播，不按还没载入完的播放器报的 0', async () => {
  const { SyncEngine } = await load('syncEngine.js');
  const { MSG } = await load('protocol.js');
  const eng = new SyncEngine({ peerId: 'host', name: 'host', isSeeder: true, hostId: 'host' });
  const clock = { t: 10_000 };
  eng.now = () => clock.t;
  eng.onSeek = () => {};
  eng.onSetPause = () => {};
  eng.started = true;
  const outbound = [];
  eng.on('outbound', (m) => outbound.push(m));
  // 上一部被 playNow 切走时记下 754 秒，现在换回来接着放
  eng.resetMedia({ isSeeder: true, seq: 2, position: 754, broadcast: true });
  assert.equal(outbound.at(-1).position, 754);
  // mpv 刚连上 IPC，time-pos 还没有：snapshot() 报 position 0
  eng.onMpvTick({ position: 0, paused: true, eof: false, gen: 1 }, { contiguousBytes: 0, complete: true });
  assert.equal(eng.playerPositionNow(), 0, '这条 tick 确实会被记成 0（问题的来源）');

  const { ctx, S } = autoRoom({ sync: eng });
  outbound.length = 0;
  ctx.startCurrentNow();
  const sync = outbound.filter((m) => m.t === MSG.SYNC).at(-1);
  assert.ok(sync, '应当广播一条 SYNC');
  assert.equal(sync.paused, false);
  assert.equal(sync.position, 754, '续播的这一部不该被拉回片头');
  assert.equal(S.autoStartSeq, null);
  assert.equal(S.autoStartReason, null);
});

/* ============== ready-autoplay#3 / #4 上膛条件 ============== */

async function armCase(before, op) {
  const { applyOp } = await load('playlist.js');
  const ctxOp = opCtx();
  const res = applyOp(before, op, ctxOp);
  assert.ok(res.ok, `${op.type} 应当成功：${res.reason || ''}`);
  return res.state;
}

function snap(over = {}) {
  return {
    rev: 1,
    seq: 1,
    nextSlot: 1,
    started: false,
    autoplay: true,
    history: [],
    queue: [
      { id: 'aaaaaaaa', kind: 'link', url: 'https://a.example/', title: 'A', addedBy: '', addedByName: '', durationSec: 0 },
      { id: 'bbbbbbbb', kind: 'link', url: 'https://b.example/', title: 'B', addedBy: '', addedByName: '', durationSec: 0 },
      { id: 'cccccccc', kind: 'link', url: 'https://c.example/', title: 'C', addedBy: '', addedByName: '', durationSec: 0 },
    ],
    ...over,
  };
}

test('上膛按「这一场是不是正在连播」算：没开播的首部跳过/移除都不上膛', async () => {
  const { ctx, S } = autoRoom({});
  for (const op of [{ type: 'ended', seq: 1 }, { type: 'remove', id: 'aaaaaaaa' }]) {
    const before = snap();
    S.autoStartSeq = null;
    S.autoStartReason = null;
    const after = await armCase(before, op);
    ctx.armAutoStart(op, before, after);
    assert.equal(S.autoStartSeq, null, `开房后第一部还没开播，${op.type} 不该让第二部自动开播`);
  }
});

test('上膛：等人期间把已上膛的那部换掉，连播不断', async () => {
  const { ctx, S } = autoRoom({});
  const before = snap({ seq: 5, started: false });
  for (const op of [{ type: 'remove', id: 'aaaaaaaa' }, { type: 'move', id: 'cccccccc', beforeId: 'aaaaaaaa' }]) {
    S.autoStartSeq = before.seq; // A 已上膛，正在等人就绪
    S.autoStartReason = 'auto';
    const after = await armCase(before, op);
    ctx.armAutoStart(op, before, after);
    assert.equal(S.autoStartSeq, after.seq, `${op.type} 不该把膛卸掉`);
    assert.equal(S.autoStartReason, 'auto');
  }
});

test('等人期间关掉自动连播：已上膛的那部不再自动开播；「立即播放」不受影响', async () => {
  const started = [];
  const { SyncEngine } = await load('syncEngine.js');
  const eng = new SyncEngine({ peerId: 'host', name: 'host', isSeeder: true, hostId: 'host' });
  eng.onSeek = () => {};
  eng.onSetPause = () => {};
  eng.started = true;
  eng.on('outbound', (m) => started.push(m));

  const { ctx, S, logs } = autoRoom({ sync: eng });
  const before = snap({ seq: 5, started: true });
  const after = await armCase(before, { type: 'ended', seq: 5 });
  S.playlist = after;
  S.currentSeq = after.seq;
  ctx.armAutoStart({ type: 'ended', seq: 5 }, before, after);
  assert.equal(S.autoStartSeq, after.seq);
  assert.equal(ctx.autoStartArmed(), true);

  // 房主/管理员取消勾选：seq 不变，不会重新上膛，但这一部不该再自动开播
  S.playlist = await armCase(after, { type: 'setAutoplay', on: false });
  assert.equal(S.playlist.seq, after.seq, 'setAutoplay 不换 seq');
  assert.equal(ctx.autoStartArmed(), false);
  ctx.maybeAutoStart();
  assert.deepEqual(logs, [], '自动连播已经关了，不该自动开播');

  // 「立即播放」是明说要放，自动连播关着也照放
  const played = await armCase(S.playlist, { type: 'playNow', id: 'cccccccc' });
  ctx.armAutoStart({ type: 'playNow', id: 'cccccccc' }, S.playlist, played);
  S.playlist = played;
  S.currentSeq = played.seq;
  assert.equal(S.autoStartReason, 'playNow');
  assert.equal(ctx.autoStartArmed(), true);
  ctx.maybeAutoStart();
  assert.ok(logs.some(([t]) => t === '所有人都准备好了，自动开始播放'));
});

/* ============== panel-ui#5 拖动被退回后按最新顺序重算 ============== */

test('房主回 needs-confirm：按刚收到的最新顺序重算，问的是用户真正拖的那一部', async () => {
  const { reorderIds, currentItem } = await load('playlist.js');
  const asked = [];
  const ops = [];
  const base = { rev: 9, seq: 3, autoplay: true, nextSlot: 1, history: [] };
  const S = {
    // 松手那一刻本机快照是 [A,B,C]、还没开播
    playlist: { ...base, started: false, queue: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] },
  };
  const ctx = sandbox(['movePlaylistItem', 'switchByDrag'], {
    S,
    reorderIds,
    currentItem,
    canEditPlaylist: () => true,
    renderPlaylist: () => {},
    confirmSwitch: async (target, cur) => {
      asked.push([target.id, cur.id]);
      return false; // 只看问的是哪一部，不真切
    },
    runPlaylistOp: async (op) => {
      ops.push(op);
      if (op.type !== 'move') return { ok: true };
      // ctrl 通道有序：房主的广播先于 ack 到达，S.playlist 已经换成别人改过、并且开播了的 [B,A,C]
      S.playlist = { ...base, rev: 10, started: true, queue: [{ id: 'B' }, { id: 'A' }, { id: 'C' }] };
      return { ok: false, reason: 'needs-confirm' };
    },
  });

  // 用户把 C 拖到 B 前面。按松手时的旧顺序算出来的是 [A,C,B]，排头是用户根本没拖的 A
  await ctx.movePlaylistItem('C', 'B');
  assert.deepEqual(
    ops.map((o) => `${o.type}:${o.id}:${o.beforeId}`),
    ['move:C:B']
  );
  assert.deepEqual(asked, [['C', 'B']], '要问的是用户拖上去的 C，而不是旧顺序里排头的 A');
});

/* ============== panel-ui#7 降为游客后收起「+ 链接」 ============== */

test('被降为游客：展开着的「+ 链接」输入行跟着收起并清空', () => {
  const dom = domStub();
  let canEdit = true;
  const ctx = sandbox(['syncPlaylistEditUi'], { $: dom.$, canEditPlaylist: () => canEdit });

  ctx.syncPlaylistEditUi();
  assert.equal(dom.$('playlist-actions').hidden, false);
  // 管理员点开了「+ 链接」，还输了半截
  dom.$('add-link-row').hidden = false;
  dom.$('room-video-link').value = 'https://half.example/';

  canEdit = false;
  ctx.syncPlaylistEditUi();
  assert.equal(dom.$('playlist-actions').hidden, true);
  assert.equal(dom.$('add-link-row').hidden, true, '点了没反应的输入行不该留在屏幕上');
  assert.equal(dom.$('room-video-link').value, '');
});

/* ============== panel-ui#6 漏翻的文案 ============== */

test('新增文案都有英文：列表上限、解析失败、看清楚再点「允许」', async () => {
  const { translate } = await load('i18n.js');
  const cases = [
    ['列表最多 100 项', 'The playlist can hold at most 100 items'],
    ['列表没改成：列表最多 100 项', 'The playlist was not changed: The playlist can hold at most 100 items'],
    ['《film.mp4》没加进列表：列表最多 100 项', '“film.mp4” was not added to the playlist: The playlist can hold at most 100 items'],
    ['本机无法解析这个链接', 'This link cannot be resolved on your computer'],
    [
      '这个视频链接在你的电脑上无法解析，可以先跳过这一部',
      'This video link cannot be resolved on your computer. You can skip this one for now.',
    ],
    [
      '这一部的网址刚换成 evil.example，看清楚再点「允许」',
      'This item’s address just changed to evil.example. Check it before choosing “Allow”.',
    ],
    [
      '这个询问刚出现，要打开的是 good.example，看清楚再点「允许」',
      'This prompt just appeared and opens good.example. Check it before choosing “Allow”.',
    ],
    ['收到的播放列表把已有条目的内容换掉了，已忽略', 'Ignored a playlist that replaced the contents of existing items'],
  ];
  for (const [zh, en] of cases) {
    assert.equal(translate(zh, 'en'), en);
    assert.ok(!/[一-鿿]/.test(translate(zh, 'en')), `${zh} 的英文里还留着中文`);
  }
});

test('playlist.js 里每条拒绝原因都翻得出英文', async () => {
  const { translate } = await load('i18n.js');
  const src = fs.readFileSync(path.join(LIB, 'playlist.js'), 'utf8');
  const reasons = new Set();
  for (const m of src.matchAll(/fail\(state, `([^`]+)`\)/g)) reasons.add(m[1]);
  for (const m of src.matchAll(/fail\(state, '([^']+)'\)/g)) reasons.add(m[1]);
  assert.ok(reasons.size >= 5, '没抓到 fail() 的原因文案');
  for (const raw of reasons) {
    const zh = raw.replace(/\$\{MAX_QUEUE\}/g, '100').replace(/\$\{[^}]+\}/g, 'X');
    if (!/[一-鿿]/.test(zh)) continue;
    assert.ok(!/[一-鿿]/.test(translate(zh, 'en')), `漏翻：${zh}`);
  }
});
