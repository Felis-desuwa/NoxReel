'use strict';

// 房间编排层（app.js）的链接授权、替管理员挂出的清单、片源离开后的续传。
//
// app.js 是整页的编排脚本，没法整个在 Node 里跑。这里把涉及的顶层函数原样抠出来放进 vm 沙箱，
// 周围配上假的主进程接口和真的 playlist / Swarm，按出事时的先后顺序喂事件 ——
// 测的是仓库里真实的函数体。全程不启动任何播放器、不联网、不出声。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { IMPLS } = require('./helpers/impls');

const root = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8').replace(/\r\n/g, '\n');
const LIB = path.join(root, 'src/renderer/lib');
const load = (name) => import(pathToFileURL(path.join(LIB, name)).href);
const loadImpl = (dir, name) => import(pathToFileURL(path.join(__dirname, dir, name)).href);

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

const sha256 = (s) => nodeCrypto.createHash('sha256').update(s).digest('hex');

/** 摘要真实可验的清单：fileId = sha256(hashes.join('')) 前 32 位，和主进程一致。 */
function makeManifest(tag, chunkCount, chunkSize = 1024) {
  const hashes = Array.from({ length: chunkCount }, (_, i) => sha256(`${tag}:${i}`));
  return {
    fileId: sha256(hashes.join('')).slice(0, 32),
    name: `${tag}.mkv`,
    size: chunkCount * chunkSize,
    chunkSize,
    chunkCount,
    hashes,
    durationSec: 60,
  };
}

function fakePeer(peerId, { authenticated = true } = {}) {
  return {
    peerId,
    name: peerId,
    pc: { iceConnectionState: 'connected' },
    authenticated,
    remote: new Map(),
    inflight: new Set(),
    ctrl: { readyState: 'open', bufferedAmount: 0 },
    sent: [],
    send(m) {
      this.sent.push(m);
      return true;
    },
    on() {
      return () => {};
    },
    close() {},
    async sendChunk() {},
    ping() {},
    hello() {},
  };
}

/* ============================ 链接授权 ============================ */

/** app.js 里的数值常量，免得测试和源码各写一份。 */
function appConst(name) {
  const m = new RegExp(`^const ${name} = ([\\d_ *]+);`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到常量 ${name}`);
  return Function(`return (${m[1]});`)();
}
const FALLBACK_CONFIRM_MS = appConst('FALLBACK_CONFIRM_MS');

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
  'addLinkItem',
];

function linkRoom({ peerId = 'victim-peer', inspect, renderPlaylist = () => {} } = {}) {
  // 沙箱里的时钟手动拨：询问刚出现时点「允许」不算数，要测这个
  const clock = { now: Date.now() };
  class FakeDate extends Date {
    static now() {
      return clock.now;
    }
  }
  const inspected = [];
  const launched = [];
  const logs = [];
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
    swarm: { peers: new Map() },
  };
  const noop = () => {};
  const ctx = sandbox(LINK_FNS, {
    S,
    URL,
    Date: FakeDate,
    LINK_INFO_TTL_MS: 15 * 60 * 1000,
    FALLBACK_CONFIRM_MS,
    MSG: { NOW_LINK: 'now-link' },
    roomEntered: true,
    log: (text, kind) => logs.push([text, kind]),
    renderStatus: noop,
    renderPlaylist,
    // 真的是 400ms 节流：这里干脆不画，谁要是靠它更新询问，行里就一直是旧的
    renderPlaylistSoon: noop,
    updateLocalReady: noop,
    preResolveNextLink: noop,
    initSwarmAndSync: noop,
    enterRoom: async () => {},
    submitPlaylistOp: async () => ({ ok: true }),
    isRoomHost: () => false,
    onLinkSessionReady: async () => launched.push(S.filePath),
    window: {
      sw: {
        media: {
          inspectLink: (url) => {
            inspected.push(url);
            return inspect ? inspect(url) : Promise.resolve({ url, title: 't', duration: 60, resolvedAt: Date.now() });
          },
        },
      },
    },
  });
  return { ctx, S, inspected, launched, logs, clock };
}

/** 房主发来的快照，经真的 validateSnapshot 过一遍（两端的 playlist.js 都跑）。 */
async function hostSnapshotItem(dir, raw) {
  const { validateSnapshot } = await loadImpl(dir, 'playlist.js');
  const snap = validateSnapshot({
    rev: 7,
    seq: 2,
    nextSlot: 1,
    started: false,
    autoplay: true,
    history: [],
    queue: [{ id: 'aaaaaaaa', kind: 'link', title: '', addedByName: '', sourceId: '', ...raw }],
  });
  assert.ok(snap, '快照应当合法');
  return snap;
}

for (const { name, dir } of IMPLS) {
  test(`${name}列表：房主把 addedBy 写成成员自己，链接也不能免问直接打开`, async () => {
    const snap = await hostSnapshotItem(dir, { url: 'https://evil.example/page', addedBy: 'victim-peer' });
    const item = snap.queue[0];
    // 快照校验只看字母表：伪造的 addedBy 会原样留下，所以编排层不能采信它
    assert.equal(item.addedBy, 'victim-peer');

    const { ctx, S, inspected, launched, clock } = linkRoom({ peerId: 'victim-peer' });
    S.playlist = snap;
    S.current = item;
    S.currentSeq = snap.seq;
    assert.equal(ctx.siteApproved(item), false);
    await ctx.activateLinkItem(item, snap.seq);
    assert.deepEqual(inspected, [], '没允许过的网站不该在本机解析（会加载页面、跑 yt-dlp）');
    assert.deepEqual(launched, []);
    assert.equal(S.linkConsent?.seq, snap.seq, '卡在「需要允许」');
    assert.equal(ctx.linkNotice(item)?.text, '需要允许打开');
    assert.equal(ctx.linkNotice(item)?.site, 'evil.example');
    assert.equal(ctx.linkWaitText(), '这一部要打开 evil.example，需要你先允许');

    // 本人点了允许才去解析、起播（询问刚出现的那一下不算，得先看清楚）
    clock.now += FALLBACK_CONFIRM_MS;
    ctx.approveLinkSite(item);
    await flush();
    assert.deepEqual(inspected, ['https://evil.example/page']);
    assert.deepEqual(launched, ['https://evil.example/page']);
  });
}

test('自己提交过的链接不用再问：按本机记录认，不看快照里的 addedBy，解析缓存过期了也一样', async () => {
  const { ctx, S, inspected, launched } = linkRoom({ peerId: 'me-peer' });
  await ctx.addLinkItem({ url: 'https://video.example/watch?v=1', title: '我的', duration: 60, resolvedAt: Date.now() });
  assert.ok(S.myLinks.has('https://video.example/watch?v=1'));

  // 房主那边规范化后的同一条链接；addedBy 被抹掉也照样认得出是自己加的
  const snap = await hostSnapshotItem(IMPLS[0].dir, { url: 'https://video.example/watch?v=1', addedBy: '' });
  const item = snap.queue[0];
  S.current = item;
  S.currentSeq = snap.seq;
  // 解析结果过了时效，缓存被清掉
  S.links.get('https://video.example/watch?v=1').resolvedAt = Date.now() - 60 * 60 * 1000;
  assert.equal(ctx.siteApproved(item), true);
  assert.equal(ctx.linkNotice(item), null, '自己加的不显示「需要允许」');
  await ctx.activateLinkItem(item, snap.seq);
  assert.deepEqual(inspected, ['https://video.example/watch?v=1']);
  assert.deepEqual(launched, ['https://video.example/watch?v=1']);
  assert.equal(S.linkConsent, null);
});

/* ------------------------ 房主给的兜底播放地址 ------------------------ */

const hostLink = (over = {}) => ({
  id: 'bbbbbbbb',
  kind: 'link',
  url: 'https://www.youtube.com/watch?v=nope',
  title: '不存在的视频',
  durationSec: 0,
  addedBy: 'host-peer',
  ...over,
});

const failingInspect = () => Promise.reject(new Error('视频不存在'));

test('本机解析失败时，房主给的兜底地址在没允许过的网站上：不起播，行内和状态栏问这个网站', async () => {
  const { ctx, S, launched, logs, clock } = linkRoom({ inspect: failingInspect });
  S.approvedSites.add('https://www.youtube.com');
  const item = hostLink();
  S.current = item;
  S.currentSeq = 3;
  S.nowLink = { seq: 3, playback: { url: 'https://tracker.evil/x', headers: { referer: 'https://tracker.evil/' } } };

  await ctx.activateLinkItem(item, 3);
  assert.deepEqual(launched, [], '页面网站允许过，不等于允许连房主填的任何网站');
  assert.equal(S.linkInfo, null);
  assert.equal(S.filePath, null);
  assert.deepEqual(
    { seq: S.fallbackConsent?.seq, origin: S.fallbackConsent?.origin, host: S.fallbackConsent?.host },
    { seq: 3, origin: 'https://tracker.evil', host: 'tracker.evil' }
  );
  assert.equal(S.linkFailedSeq, 3, '之后房主换了地址还能再试');
  assert.ok(logs.some(([t]) => t === '房主提供的临时播放地址来自 https://tracker.evil，在列表或上方点「允许打开」后才会使用'));
  const notice = ctx.linkNotice(item);
  assert.equal(notice.text, '房主给的播放地址需要允许打开');
  assert.equal(notice.site, 'tracker.evil', '行内显示的是播放地址的网站，不是页面的');
  assert.deepEqual(
    Array.from(notice.actions, (a) => a.key),
    ['allow-site', 'skip-link']
  );
  assert.equal(ctx.linkWaitText(), '房主提供的播放地址来自 tracker.evil，需要你先允许');

  // 看清之后点允许：允许的是这个播放地址的网站，然后用它起播
  clock.now += FALLBACK_CONFIRM_MS;
  ctx.approveLinkSite(item);
  await flush();
  assert.ok(S.approvedSites.has('https://tracker.evil'));
  assert.deepEqual(launched, ['https://tracker.evil/x']);
  assert.equal(S.fallbackConsent, null);
  assert.equal(S.linkFailedSeq, null);
});

test('兜底地址所在的网站已经允许过：照旧直接用', async () => {
  const { ctx, S, launched, logs } = linkRoom({ inspect: failingInspect });
  S.approvedSites.add('https://www.youtube.com');
  S.approvedSites.add('https://rr1.googlevideo.com');
  const item = hostLink();
  S.current = item;
  S.currentSeq = 3;
  S.nowLink = { seq: 3, playback: { url: 'https://rr1.googlevideo.com/videoplayback?id=1' } };
  await ctx.activateLinkItem(item, 3);
  assert.deepEqual(launched, ['https://rr1.googlevideo.com/videoplayback?id=1']);
  assert.equal(S.fallbackConsent, null);
  assert.ok(logs.some(([t]) => t === '本机解析失败，改用房主提供的临时播放地址：视频不存在'));
});

test('房主后发来的兜底地址（NOW_LINK）同样要过网站授权', async () => {
  const { ctx, S, launched } = linkRoom({ inspect: failingInspect });
  S.approvedSites.add('https://www.youtube.com');
  const item = hostLink();
  S.current = item;
  S.currentSeq = 4;
  S.playlist = { ...S.playlist, seq: 4 };
  await ctx.activateLinkItem(item, 4);
  assert.equal(S.linkFailedSeq, 4, '房主的地址还没到');
  assert.equal(S.fallbackConsent, null);

  const host = { peerId: 'host-peer' };
  ctx.onNowLink({ seq: 4, playback: { url: 'https://tracker.evil/y' } }, host);
  await flush();
  assert.deepEqual(launched, [], '没允许过的网站不起播');
  assert.equal(S.fallbackConsent?.origin, 'https://tracker.evil');
  assert.equal(ctx.linkNotice(item)?.site, 'tracker.evil');

  // 房主撤回地址：询问作废，行里只剩「跳过」（本机解析失败又没兜底，见 linkResolveFailed）
  ctx.onNowLink({ seq: 4, playback: null }, host);
  await flush();
  assert.equal(S.fallbackConsent, null);
  assert.equal(ctx.linkNotice(item)?.text, '本机无法解析这个链接');
  assert.deepEqual(Array.from(ctx.linkNotice(item).actions, (a) => a.key), ['skip-link']);

  // 换成允许过的网站上的地址：直接用
  ctx.onNowLink({ seq: 4, playback: { url: 'https://www.youtube.com/direct.mp4' } }, host);
  await flush();
  assert.deepEqual(launched, ['https://www.youtube.com/direct.mp4']);
});

test('兜底地址在问的时候本人选了跳过：之后房主再发地址也不起播；改为允许会重新走一遍再问', async () => {
  let fail = true;
  const { ctx, S, launched, inspected } = linkRoom({
    inspect: (url) => (fail ? failingInspect() : Promise.resolve({ url, title: 't', resolvedAt: Date.now() })),
  });
  S.approvedSites.add('https://www.youtube.com');
  const item = hostLink();
  S.current = item;
  S.currentSeq = 5;
  S.playlist = { ...S.playlist, seq: 5 };
  S.nowLink = { seq: 5, playback: { url: 'https://tracker.evil/z' } };
  await ctx.activateLinkItem(item, 5);
  assert.equal(S.fallbackConsent?.origin, 'https://tracker.evil');

  ctx.skipLinkItem(item);
  assert.equal(S.fallbackConsent, null);
  assert.equal(ctx.linkNotice(item)?.text, '你跳过了这一部');
  ctx.onNowLink({ seq: 5, playback: { url: 'https://www.youtube.com/direct.mp4' } }, { peerId: 'host-peer' });
  await flush();
  assert.deepEqual(launched, [], '跳过了的就让播放器闲着');

  // 改为允许：只允许页面网站，从头解析；这次本机解析成功，不再需要兜底
  fail = false;
  ctx.approveLinkSite(item);
  await flush();
  assert.equal(S.approvedSites.has('https://tracker.evil'), false);
  assert.equal(inspected.length, 2);
  assert.deepEqual(launched, ['https://www.youtube.com/watch?v=nope']);
});

/** 行内那一行：只在 renderPlaylist 时照当时的状态重画（和真的面板一样整行重建）。 */
function rowWatcher() {
  const row = { site: null, text: null, actions: null, renders: 0 };
  let read = null;
  return {
    row,
    bind(fn) {
      read = fn;
    },
    render() {
      const notice = read();
      row.site = notice?.site ?? null;
      row.text = notice?.text ?? null;
      row.actions = notice?.actions ? Array.from(notice.actions, (a) => a.key) : null;
      row.renders++;
    },
  };
}

/** 本人点「允许」：返回这次新批准的网站。 */
function clickAllow(ctx, S, item) {
  const before = new Set(S.approvedSites);
  ctx.approveLinkSite(item);
  return [...S.approvedSites].filter((o) => !before.has(o));
}

test('询问期间房主换了兜底地址：行内当场换成新网站；刚换的那一下点「允许」不算，批准的只会是行里显示过一阵的网站', async () => {
  const watch = rowWatcher();
  const { ctx, S, launched, logs, clock } = linkRoom({ inspect: failingInspect, renderPlaylist: () => watch.render() });
  S.approvedSites.add('https://www.youtube.com');
  const item = hostLink();
  watch.bind(() => ctx.linkNotice(item));
  S.current = item;
  S.currentSeq = 6;
  S.playlist = { ...S.playlist, seq: 6 };
  S.nowLink = { seq: 6, playback: { url: 'https://cdn.good.example/v.mp4' } };
  const host = { peerId: 'host-peer' };

  await ctx.activateLinkItem(item, 6);
  assert.equal(watch.row.site, 'cdn.good.example', '询问一出现行内就画出来');
  clock.now += 5000;

  // 房主换地址：行内当场换成新网站（不等节流）
  ctx.onNowLink({ seq: 6, playback: { url: 'https://tracker.evil/x' } }, host);
  await flush();
  assert.equal(S.fallbackConsent?.origin, 'https://tracker.evil');
  assert.equal(watch.row.site, 'tracker.evil', '行里还显示着旧网站时，点下去批准的却是新网站');

  // 本人冲着刚才的 cdn.good.example 点了允许：不算数，提示看清楚
  clock.now += FALLBACK_CONFIRM_MS - 1;
  assert.deepEqual(clickAllow(ctx, S, item), [], '刚换的网站不能被这一下批准');
  await flush();
  assert.deepEqual(launched, []);
  assert.equal(S.fallbackConsent?.origin, 'https://tracker.evil', '询问还在');
  assert.ok(
    logs.some(([t, kind]) => t === '房主给的播放地址刚更新，现在来自 tracker.evil，看清楚再点「允许」' && kind === 'warn')
  );

  // 房主来回切：每换一次都重新计时，切换间隔短于确认时间就一直点不成
  for (const url of ['https://cdn.good.example/v.mp4', 'https://tracker.evil/x', 'https://cdn.good.example/v.mp4']) {
    clock.now += FALLBACK_CONFIRM_MS - 100;
    ctx.onNowLink({ seq: 6, playback: { url } }, host);
    await flush();
    assert.equal(watch.row.site, new URL(url).hostname);
    clock.now += 99;
    assert.deepEqual(clickAllow(ctx, S, item), []);
  }
  await flush();
  assert.deepEqual(launched, []);

  // 停下来、行里稳定显示够了确认时间之后点的，批准的就是行里这个网站
  clock.now += FALLBACK_CONFIRM_MS - 100;
  assert.deepEqual(clickAllow(ctx, S, item), [], '还差 1ms');
  clock.now += 1;
  assert.equal(watch.row.site, 'cdn.good.example');
  assert.deepEqual(clickAllow(ctx, S, item), ['https://cdn.good.example']);
  await flush();
  assert.deepEqual(launched, ['https://cdn.good.example/v.mp4']);
  assert.equal(S.approvedSites.has('https://tracker.evil'), false);
});

test('兜底询问刚冒出来（连点了页面那条的「允许」）：第二下不算，不会顺手批准房主的地址', async () => {
  const { ctx, S, launched, inspected, clock } = linkRoom({ inspect: failingInspect });
  const item = hostLink();
  S.current = item;
  S.currentSeq = 7;
  S.playlist = { ...S.playlist, seq: 7 };
  S.nowLink = { seq: 7, playback: { url: 'https://tracker.evil/dbl' } };
  await ctx.activateLinkItem(item, 7);
  assert.equal(S.linkConsent?.seq, 7, '先问页面的网站');

  // 第一下：允许页面网站 → 本机解析马上失败 → 换成问房主地址的网站
  clock.now += FALLBACK_CONFIRM_MS;
  assert.deepEqual(clickAllow(ctx, S, item), ['https://www.youtube.com']);
  await flush();
  assert.deepEqual(inspected, ['https://www.youtube.com/watch?v=nope']);
  assert.equal(S.fallbackConsent?.origin, 'https://tracker.evil');
  // 第二下紧跟着落在同一个位置的新按钮上
  clock.now += 150;
  assert.deepEqual(clickAllow(ctx, S, item), []);
  await flush();
  assert.deepEqual(launched, []);
});

test('询问作废或改用已允许的网站：行内当场收起「允许」，不留旧按钮', async () => {
  const watch = rowWatcher();
  const { ctx, S, launched } = linkRoom({ inspect: failingInspect, renderPlaylist: () => watch.render() });
  S.approvedSites.add('https://www.youtube.com');
  const item = hostLink();
  watch.bind(() => ctx.linkNotice(item));
  S.current = item;
  S.currentSeq = 8;
  S.playlist = { ...S.playlist, seq: 8 };
  const host = { peerId: 'host-peer' };
  await ctx.activateLinkItem(item, 8);

  ctx.onNowLink({ seq: 8, playback: { url: 'https://tracker.evil/a' } }, host);
  await flush();
  assert.equal(watch.row.site, 'tracker.evil');
  // 房主撤回地址
  ctx.onNowLink({ seq: 8, playback: null }, host);
  await flush();
  assert.deepEqual(watch.row.actions, ['skip-link'], '撤回后行里不该还挂着「允许」');

  ctx.onNowLink({ seq: 8, playback: { url: 'https://tracker.evil/a' } }, host);
  await flush();
  assert.equal(watch.row.site, 'tracker.evil');
  // 房主改发已允许网站上的地址：直接用，行里的询问当场收起
  ctx.onNowLink({ seq: 8, playback: { url: 'https://www.youtube.com/direct.mp4' } }, host);
  await flush();
  assert.deepEqual(launched, ['https://www.youtube.com/direct.mp4']);
  assert.equal(watch.row.text, null, '行里还挂着 tracker.evil 的「允许」，点下去批准的却是页面网站');
});

test('新增的链接授权文案都有英文', async () => {
  const { translate } = await load('i18n.js');
  assert.equal(translate('房主给的播放地址需要允许打开', 'en'), 'The host’s stream URL needs your permission to open');
  assert.equal(
    translate('房主提供的播放地址来自 tracker.evil，需要你先允许', 'en'),
    'The host’s stream URL comes from tracker.evil and needs your permission first'
  );
  assert.equal(
    translate('房主提供的临时播放地址来自 https://tracker.evil，在列表或上方点「允许打开」后才会使用', 'en'),
    'The host’s temporary stream URL comes from https://tracker.evil. It is used only after you choose “Allow” in the playlist or above.'
  );
  assert.equal(
    translate('房主给的播放地址刚更新，现在来自 tracker.evil，看清楚再点「允许」', 'en'),
    'The host’s stream URL just changed and now comes from tracker.evil. Check it before choosing “Allow”.'
  );
  // 网站地址原样保留，不翻译
  assert.match(translate('房主提供的播放地址来自 视频.example，需要你先允许', 'en'), /from 视频\.example and/);
  assert.match(translate('房主给的播放地址刚更新，现在来自 视频.example，看清楚再点「允许」', 'en'), /from 视频\.example\. Check/);
});

/* ===================== 房主替管理员挂出的清单 ===================== */

async function opRoom() {
  const playlistLib = await load('playlist.js');
  const { Swarm } = await load('swarm.js');
  const swarm = new Swarm({ peerId: 'host-peer', name: 'host' });
  const requested = [];
  const manifests = new Map();
  const controllers = new Set(['host-peer', 'admin-peer']);
  const commits = [];
  swarm.requestManifest = async (fileId) => {
    requested.push(fileId);
    if (hooks.onRequest) hooks.onRequest(fileId);
    const m = manifests.get(fileId);
    if (!m) throw new Error('没有人能提供这部片的清单');
    return m;
  };
  const hooks = {};
  const S = {
    peerId: 'host-peer',
    playlist: playlistLib.createPlaylist(),
    sessions: new Map(),
    pendingAdds: new Set(),
    addGrace: new Map(),
    knownManifests: new Map(),
    hostOffered: new Set(),
    diskFull: new Set(),
    swarm,
    sync: {
      isController: (id) => controllers.has(id),
      sharedPositionNow: () => 0,
    },
  };
  let n = 0;
  const ctx = sandbox(['hostApplyOpNow', 'releaseUnreferenced', 'inAddGrace', 'fileItemOf', 'armAutoStart'], {
    S,
    applyOp: playlistLib.applyOp,
    referencedFileIds: playlistLib.referencedFileIds,
    randomId: () => (0x10000000 + n++).toString(16),
    log: () => {},
    startCurrentNow: () => {},
    closeSession: () => Promise.resolve(),
    scheduleTransferUpdate: () => {},
    window: { sw: { store: { validateManifest: async () => true } } },
    // 和真的 commitPlaylist 一样：先广播（这里记下广播那一刻房主挂着哪些清单），再在本机生效
    commitPlaylist: (next) => {
      commits.push({ rev: next.rev, offered: new Set(swarm._offered.keys()) });
      S.playlist = next;
      ctx.releaseUnreferenced();
    },
  });
  const add = (m, actor = 'admin-peer') => {
    manifests.set(m.fileId, m);
    const { hashes, ...item } = m;
    return ctx.hostApplyOpNow({ type: 'add', item: { kind: 'file', ...item } }, { actor, actorName: actor });
  };
  return { ctx, S, swarm, requested, controllers, commits, hooks, add, playlistLib };
}

test('列表满了：管理员加片直接拒，不去要清单，也不挂出清单', async () => {
  const { S, swarm, requested, add, playlistLib } = await opRoom();
  S.playlist = {
    ...playlistLib.createPlaylist(),
    rev: 100,
    seq: 1,
    queue: Array.from({ length: playlistLib.MAX_QUEUE }, (_, i) => ({
      id: (0x20000000 + i).toString(16),
      kind: 'link',
      url: `https://v.example/${i}`,
      title: '',
      durationSec: 0,
      addedBy: 'host-peer',
      addedByName: '',
      sourceId: '',
      sourceGone: false,
      resumeAt: 0,
    })),
  };
  for (let i = 0; i < 5; i++) {
    const res = await add(makeManifest(`flood-${i}`, 4));
    assert.equal(res.ok, false);
    assert.equal(res.reason, `列表最多 ${playlistLib.MAX_QUEUE} 项`);
  }
  assert.deepEqual(requested, [], '一眼就能拒的，不用替他白跑一趟取清单');
  assert.equal(swarm._offered.size, 0, '被拒的清单不能留在房主这里');
  assert.equal(S.knownManifests.size, 0);
  assert.equal(S.playlist.rev, 100);
});

test('已经有这部片了：不再要清单', async () => {
  const { S, swarm, requested, add } = await opRoom();
  const m = makeManifest('dup', 4);
  assert.equal((await add(m)).ok, true);
  assert.deepEqual(requested, [m.fileId]);
  const res = await add(m);
  assert.equal(res.ok, false);
  assert.equal(res.reason, '列表里已经有这部片了');
  assert.deepEqual(requested, [m.fileId], '重复的不再去要');
  assert.equal(S.playlist.queue.length, 1);
  assert.ok(swarm._offered.has(m.fileId), '第一份还在列表里，清单照挂');
});

test('要清单期间被降成游客，入列被拒：清单不挂、不记', async () => {
  const { S, swarm, controllers, hooks, add } = await opRoom();
  hooks.onRequest = () => controllers.delete('admin-peer');
  const m = makeManifest('demoted', 4);
  const res = await add(m);
  assert.equal(res.ok, false);
  assert.equal(res.reason, '你没有编辑播放列表的权限');
  assert.equal(swarm._offered.has(m.fileId), false);
  assert.equal(S.knownManifests.has(m.fileId), false);
  assert.equal(S.hostOffered.size, 0);
});

test('入列成功才挂清单（赶在广播之前）；条目移除后撤回，房主没开过会话也一样', async () => {
  const { ctx, S, swarm, commits, add } = await opRoom();
  const x = makeManifest('keep', 4);
  const y = makeManifest('gone', 4);
  assert.equal((await add(x)).ok, true);
  assert.equal((await add(y)).ok, true);
  assert.ok(commits.at(-1).offered.has(y.fileId), '广播列表时清单已经挂好，别人马上来要也拿得到');
  assert.ok(S.knownManifests.has(y.fileId));
  assert.ok(S.hostOffered.has(y.fileId));

  const yItem = S.playlist.queue.find((it) => it.fileId === y.fileId);
  const res = await ctx.hostApplyOpNow({ type: 'remove', id: yItem.id }, { actor: 'host-peer', actorName: 'host' });
  assert.equal(res.ok, true);
  assert.equal(swarm._offered.has(y.fileId), false, '删掉的片不能再回给来要清单的人');
  assert.equal(S.hostOffered.has(y.fileId), false);
  assert.equal(swarm._offered.has(x.fileId), true, '还在列表里的不动');

  // 本机正在加同一部片时先不撤：那份是本机自己挂的，要留给房主来取
  const xItem = S.playlist.queue.find((it) => it.fileId === x.fileId);
  S.pendingAdds.add(x.fileId);
  await ctx.hostApplyOpNow({ type: 'remove', id: xItem.id }, { actor: 'host-peer', actorName: 'host' });
  assert.equal(swarm._offered.has(x.fileId), true);
  S.pendingAdds.delete(x.fileId);
  ctx.releaseUnreferenced();
  assert.equal(swarm._offered.has(x.fileId), false);
});

/* ================== 完整片源离开后，按分片判断来源 ================== */

async function slotSwarm(dir) {
  const { Swarm } = await loadImpl(dir, 'swarm.js');
  const protocol = await loadImpl(dir, 'protocol.js');
  const swarm = new Swarm({ peerId: 'me-peer', name: 'me' });
  const bits = (arr) => protocol.packBitfield(Uint8Array.from(arr));
  const state = (arr) => ({
    bitfield: bits(arr),
    haveCount: arr.filter(Boolean).length,
    contiguousBytes: 0,
    complete: false,
  });
  return { swarm, bits, state };
}

const catalogOf = (slot, m) => ({ slot, fileId: m.fileId, size: m.size, chunkCount: m.chunkCount, chunkSize: m.chunkSize });

for (const { name, dir } of IMPLS) {
  test(`${name} swarm：hasAnyMissing 按片看有没有人能给我缺的片`, async () => {
    const { hasAnyMissing } = await load('transferSources.js');
    const { swarm, bits, state } = await slotSwarm(dir);
    const m = makeManifest('x', 10);
    swarm.setCatalog([catalogOf(1, m)]);
    assert.equal(hasAnyMissing(swarm, 1), false, '没人');
    assert.equal(hasAnyMissing(null, 1), false);

    const a = swarm.addPeer(fakePeer('peer-aa'));
    const u = swarm.addPeer(fakePeer('peer-uu', { authenticated: false }));
    u.remote.set(1, { have: new Uint8Array(10).fill(1), full: true });
    assert.equal(hasAnyMissing(swarm, 1), false, '没握手的人不算');

    // 本机还没挂这一部：谁手里有任何一片都算
    swarm._onCtrl(a, { t: 'bitfield', s: 1, bits: bits([1, 1, 1, 1, 1, 1, 0, 0, 0, 0]) });
    assert.equal(hasAnyMissing(swarm, 1), true);

    swarm.addFile({ slot: 1, manifest: m, sessionId: 's1', isSeeder: false, state: state([1, 1, 1, 0, 0, 0, 0, 0, 0, 0]) });
    assert.equal(swarm.canFinish(1), false, '后四片谁都没有');
    assert.equal(hasAnyMissing(swarm, 1), true, '第 3–5 片 A 有、我没有');

    swarm.addFile({ slot: 1, manifest: m, sessionId: 's1b', isSeeder: false, state: state([1, 1, 1, 1, 1, 1, 0, 0, 0, 0]) });
    assert.equal(hasAnyMissing(swarm, 1), false, 'A 有的我都有了');

    const b = swarm.addPeer(fakePeer('peer-bb'));
    swarm._onCtrl(b, { t: 'bitfield', s: 1, full: true });
    assert.equal(hasAnyMissing(swarm, 1), true, '有完整片源');

    swarm.addFile({ slot: 1, manifest: m, sessionId: 's1c', isSeeder: false, state: { ...state(Array(10).fill(1)), complete: true } });
    assert.equal(hasAnyMissing(swarm, 1), false, '收完了就不用了');
  });
}

async function transferRoom({ mode, queueFirstLink = false } = {}) {
  const playlistLib = await load('playlist.js');
  const { hasAnyMissing } = await load('transferSources.js');
  const { swarm, bits, state } = await slotSwarm(IMPLS[0].dir);
  const x = makeManifest('partial', 10);
  const y = makeManifest('next', 4);
  const fileEntry = (m, slot, id) => ({
    id,
    kind: 'file',
    fileId: m.fileId,
    name: m.name,
    size: m.size,
    chunkSize: m.chunkSize,
    chunkCount: m.chunkCount,
    durationSec: 60,
    slot,
    addedBy: 'src-peer',
    addedByName: '',
    sourceId: 'src-peer',
    sourceGone: true,
    resumeAt: 0,
  });
  const queue = [fileEntry(x, 1, 'aaaa0001'), fileEntry(y, 2, 'aaaa0002')];
  if (queueFirstLink) {
    queue.unshift({ id: 'aaaa0000', kind: 'link', url: 'https://v.example/1', title: '', durationSec: 0, addedBy: '', addedByName: '', sourceId: '', sourceGone: false, resumeAt: 0 });
  }
  const playlist = { ...playlistLib.createPlaylist(), rev: 3, seq: 1, nextSlot: 3, queue };
  swarm.setCatalog(playlistLib.catalogOf(playlist));
  // 本机：X 收了前 3 片，Y 还没开始
  swarm.addFile({ slot: 1, manifest: x, sessionId: 'sx', isSeeder: false, state: state([1, 1, 1, 0, 0, 0, 0, 0, 0, 0]) });
  swarm.addFile({ slot: 2, manifest: y, sessionId: 'sy', isSeeder: false, state: state([0, 0, 0, 0]) });
  // 完整片源已经走了。A 手里有 X 的前 6 片；B 有完整的 Y
  const a = swarm.addPeer(fakePeer('peer-aa'));
  const b = swarm.addPeer(fakePeer('peer-bb'));
  swarm._onCtrl(a, { t: 'bitfield', s: 1, bits: bits([1, 1, 1, 1, 1, 1, 0, 0, 0, 0]) });
  swarm._onCtrl(b, { t: 'bitfield', s: 2, full: true });
  const opened = [];
  const S = {
    playlist,
    roomSecurityMode: mode,
    swarm,
    sessions: new Map([
      [x.fileId, { fileId: x.fileId, slot: 1, isSeeder: false }],
      [y.fileId, { fileId: y.fileId, slot: 2, isSeeder: false }],
    ]),
    blockedFiles: new Set(),
    diskFull: new Set(),
    partialSlot: null,
  };
  const ctx = sandbox(['updateTransfer'], {
    S,
    transferOrder: playlistLib.transferOrder,
    currentItem: playlistLib.currentItem,
    hasAnyMissing,
    openLeechFor: (it) => opened.push(it.fileId),
    renderPlaylistSoon: () => {},
  });
  return { ctx, S, swarm, x, y, state, opened };
}

test('可信房间：完整片源走了，当前这部还能从别人那里补一段，就接着补，不整部跳过', async () => {
  const { ctx, S, swarm, x, state } = await transferRoom({ mode: 'trusted' });
  assert.equal(swarm.canFinish(1), false);
  ctx.updateTransfer();
  assert.equal(swarm.activeSlot, 1, '当前这部接着向 A 要第 3–5 片');
  assert.equal(S.partialSlot, 1);

  // A 有的都补上了：让给后面收得齐的那部
  swarm.addFile({ slot: 1, manifest: x, sessionId: 'sx2', isSeeder: false, state: state([1, 1, 1, 1, 1, 1, 0, 0, 0, 0]) });
  ctx.updateTransfer();
  assert.equal(swarm.activeSlot, 2);
  assert.equal(S.partialSlot, null);
});

test('放宽只给当前项，只在可信房间：安全模式、后面的片仍按「收得齐」挑', async () => {
  const safe = await transferRoom({ mode: 'safe' });
  safe.ctx.updateTransfer();
  assert.equal(safe.swarm.activeSlot, 2, '安全模式下收不齐的片放不了，先传收得齐的');
  assert.equal(safe.S.partialSlot, null);

  const notCurrent = await transferRoom({ mode: 'trusted', queueFirstLink: true });
  notCurrent.ctx.updateTransfer();
  assert.equal(notCurrent.swarm.activeSlot, 2, 'X 不是当前项：预下载只挑收得齐的');
  assert.equal(notCurrent.S.partialSlot, null);
});

test('可信房间：当前这部本机还没开会话、只有别人手里的一部分，也去开会话接收', async () => {
  const { ctx, S, x, opened } = await transferRoom({ mode: 'trusted' });
  S.sessions.delete(x.fileId);
  S.swarm.removeFile(1);
  ctx.updateTransfer();
  assert.deepEqual(opened, [x.fileId]);
  assert.equal(S.swarm.activeSlot, null, '会话开好之前不指定传输目标');
});

test('当前这部在补一段时，收到新片就重算传输目标（补完了及时让出去）', async () => {
  const handlers = new Map();
  class FakeEmitter {
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(fn);
      return () => {};
    }
  }
  const scheduled = [];
  const S = {
    peerId: 'me-peer',
    name: 'me',
    hostId: 'host-peer',
    roomSecurityMode: 'trusted',
    settings: { securityMode: 'trusted' },
    partialSlot: 1,
  };
  const ctx = sandbox(['initSwarmAndSync'], {
    S,
    Swarm: class extends FakeEmitter {
      constructor() {
        super();
        this.playingSlot = 1;
        this.peers = new Map();
      }
      start() {}
    },
    SyncEngine: class extends FakeEmitter {
      onBufferProgress() {}
    },
    window: { sw: { player: {} } },
    scheduleTransferUpdate: () => scheduled.push(true),
    renderPlaylistSoon: () => {},
    renderStatus: () => {},
    renderPeers: () => {},
    renderPeersSoon: () => {},
    maybeLaunchPlayer: () => {},
    renderProgress: () => {},
    updateLocalReady: () => {},
  });
  ctx.initSwarmAndSync();
  const progress = handlers.get('progress');
  assert.equal(progress?.length, 1);
  progress[0]({ slot: 2, contiguousBytes: 0, complete: false });
  assert.equal(scheduled.length, 0, '别的片的进度不管');
  progress[0]({ slot: 1, contiguousBytes: 0, complete: false });
  assert.equal(scheduled.length, 1);
  S.partialSlot = null;
  progress[0]({ slot: 1, contiguousBytes: 0, complete: false });
  assert.equal(scheduled.length, 1, '正常传输时不为每片进度重算');
});
