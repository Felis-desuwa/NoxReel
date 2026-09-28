'use strict';

// 在线链接失败不能拖垮全房（修复批次 2）：
//  - 同步引擎（桌面、安卓两份同源，都跑）：播放器打不开（loadFailed）不算「在等数据」、播放器没了放掉本机卡顿、
//    断流报的 eof 核对位置和片长才算放完；
//  - 主进程 mpv：认出载入失败（end-file / idle-active）和原因代号，YouTube 页面和解析用同一个客户端；
//  - app.js：提示原因、「重试」、重开播放器不沿用过期的签名地址、房主放本地缓存时照样给成员兜底地址、
//    解析失败后手动缓存下完改从本地播；翻译。
// 全程假时钟、假网络，不启动播放器、不联网、不出声。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { IMPLS } = require('./helpers/impls');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('src', 'renderer', 'app.js');
const loadLib = (name) => import(pathToFileURL(path.join(root, 'src', 'renderer', 'lib', name)).href);

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

/* ------------------------------ 同步引擎 ------------------------------ */

/** 房主 h1 和一名完全同步的管理员 m1，互相直连。共用一只假时钟。 */
async function engineRoom(dir, { streaming = true, duration = 3600, member = 'admin' } = {}) {
  const { SyncEngine, MSG } = await Promise.all([import(dir + 'syncEngine.js'), import(dir + 'protocol.js')]).then(
    ([a, b]) => ({ SyncEngine: a.SyncEngine, MSG: b.MSG })
  );
  const clock = { t: 10_000 };
  const nodes = new Map();
  const queue = [];
  const add = (id) => {
    const eng = new SyncEngine({ peerId: id, name: id, isSeeder: true, hostId: 'h1' });
    eng.now = () => clock.t;
    const node = { id, eng, out: [], seeks: [], events: [] };
    eng.onSeek = (p) => node.seeks.push(p);
    eng.onSetPause = () => {};
    eng.started = true;
    eng.applyRoles([['m1', member]], 'h1');
    eng.on('outbound', (m) => {
      node.out.push(m);
      for (const other of nodes.keys()) if (other !== id) queue.push({ from: id, to: other, msg: JSON.parse(JSON.stringify(m)) });
    });
    for (const name of ['eof', 'stream-cut', 'drift-correct']) eng.on(name, (e) => node.events.push([name, e]));
    nodes.set(id, node);
    return node;
  };
  add('h1');
  add('m1');
  const deliver = () => {
    while (queue.length) {
      const { from, to, msg } = queue.shift();
      nodes.get(to).eng.onCtrl(msg, { peerId: from, name: from });
    }
  };
  for (const node of nodes.values()) {
    node.eng.resetMedia({ seq: 1, isSeeder: true, broadcast: node.id === 'h1' });
    node.eng.setFollow({ streaming, mode: 'full' });
    node.eng.setMediaInfo({ duration, size: 0 });
  }
  deliver();
  const room = {
    MSG,
    clock,
    deliver,
    node: (id) => nodes.get(id),
    eng: (id) => nodes.get(id).eng,
    advance(sec) {
      clock.t += sec * 1000;
    },
    tick(id, fields) {
      const snap = { position: 0, paused: false, eof: false, idle: false, seeking: false, pausedForCache: false, ...fields };
      snap.sampledAt = clock.t;
      nodes.get(id).eng.onMpvTick(snap, { contiguousBytes: 0, runBytes: 0, complete: true });
    },
    /** 房主点播放，两人的播放器都从 0 起报一条（当基线），然后清掉记录。 */
    async play() {
      nodes.get('h1').eng.userSetPaused(false);
      deliver();
      for (const id of nodes.keys()) room.tick(id, { position: 0, cause: 'cmd' });
      deliver();
      await new Promise((r) => setTimeout(r, 300)); // 等引擎的回声窗口关掉
      for (const node of nodes.values()) {
        node.out.length = 0;
        node.seeks.length = 0;
        node.events.length = 0;
      }
    },
  };
  return room;
}

const stalls = (node, MSG) => node.out.filter((m) => m.t === MSG.STALL).map((m) => m.stalled);

impl('控制者的 mpv 打不开链接（idle、没暂停）：不再算「在等数据」，全房不陪着挂在「等待缓冲」', async (dir) => {
  const r = await engineRoom(dir);
  await r.play();
  // 刚打开链接、还在起播：core-idle 没暂停，照旧算在等，全房等房主
  r.tick('h1', { position: 0, idle: true });
  r.deliver();
  assert.equal(r.eng('h1').localStalled, true);
  assert.deepEqual([...r.eng('m1').stalledPeers.keys()], ['h1']);
  // 载入失败（403、签名过期、解析失败）：mpv 留在 idle，属性和起播中一模一样，只多一个 loadFailed
  r.tick('h1', { position: 0, idle: true, loadFailed: true, loadError: { reason: 'http', status: 403 } });
  r.deliver();
  assert.equal(r.eng('h1').localStalled, false, '打不开不是在等，放掉本机的卡顿');
  assert.deepEqual(stalls(r.node('h1'), r.MSG), [true, false]);
  assert.equal(r.eng('m1').stalledPeers.size, 0, '别人不再等他');
  // 之后 mpv 还会不断推 idle 的 tick：不会再把卡顿置回来
  r.tick('h1', { position: 0, idle: true, loadFailed: true });
  r.deliver();
  assert.equal(r.eng('h1').localStalled, false);
  assert.deepEqual(stalls(r.node('h1'), r.MSG), [true, false]);
});

impl('打不开的播放器报的位置不作数：控制者既不会把「跳到 0」广播出去，界面上按暂停也报房间的位置', async (dir) => {
  const r = await engineRoom(dir);
  await r.play();
  r.advance(50);
  r.tick('h1', { position: 50 });
  r.advance(0.25);
  r.tick('h1', { position: 50.25 });
  r.node('h1').out.length = 0;
  // 播到一半载入失败（位置属性没了，快照里报 0）
  r.advance(0.25);
  r.tick('h1', { position: 0, idle: true, loadFailed: true });
  assert.deepEqual(
    r.node('h1').out.filter((m) => m.t === r.MSG.SYNC),
    [],
    '以前会被当成用户把进度拖回片头，全房跟着回到 0:00'
  );
  assert.equal(r.eng('h1').playerPositionNow(), null);
  r.eng('h1').userSetPaused(true);
  const sync = r.node('h1').out.find((m) => m.t === r.MSG.SYNC);
  assert.ok(sync && Math.abs(sync.position - r.eng('h1').sharedPositionNow()) < 0.01, '报的是房间位置');
  assert.ok(sync.position > 49, `不该报 0：${sync?.position}`);
});

impl('完全同步的成员播放器打不开：自动对齐不去拽它', async (dir) => {
  const r = await engineRoom(dir);
  await r.play();
  r.advance(100);
  for (let i = 0; i < 6; i++) {
    r.tick('m1', { position: 0, paused: true, idle: true, loadFailed: true });
    r.eng('m1').checkDrift();
    r.advance(6);
  }
  assert.deepEqual(r.node('m1').seeks, []);
  assert.deepEqual(r.node('m1').events, []);
});

impl('关掉正在缓冲的播放器：在线链接的本机卡顿随之解除（没有 tick 能再解开它）；文件项照旧', async (dir) => {
  const r = await engineRoom(dir);
  await r.play();
  r.tick('h1', { position: 0, pausedForCache: true });
  r.deliver();
  assert.equal(r.eng('h1').localStalled, true);
  r.eng('h1').playerGone();
  r.deliver();
  assert.equal(r.eng('h1').localStalled, false);
  assert.equal(r.eng('h1').lastTick, null, '顺带忘掉最后一条 tick');
  assert.equal(r.eng('m1').stalledPeers.size, 0);

  // 文件项的卡顿由下载进度驱动，播放器关了照样在收，不能放
  const { SyncEngine } = await import(dir + 'syncEngine.js');
  const eng = new SyncEngine({ peerId: 'h1', name: 'h1', isSeeder: false, hostId: 'h1' });
  eng.started = true;
  eng.onBufferProgress({ contiguousBytes: 0, runBytes: 0, complete: false });
  assert.equal(eng.localStalled, true);
  eng.playerGone();
  assert.equal(eng.localStalled, true);
});

impl('在线链接半路断流报 eof：片长已知、离片尾还远就不认「放完了」，改报一次 stream-cut', async (dir) => {
  const r = await engineRoom(dir, { duration: 3600 });
  await r.play();
  r.advance(1200);
  r.tick('h1', { position: 1200 });
  r.tick('h1', { position: 1200.4, eof: true, paused: true });
  r.tick('h1', { position: 1200.4, eof: true, paused: true });
  assert.deepEqual(r.node('h1').events, [['stream-cut', { position: 1200.4, duration: 3600 }]], '只报一次，不报 eof');
  assert.equal(r.eng('h1').playerPositionNow(), null, '停在断点上的位置不拿去广播');
  // 在播放器里往回拖、又放起来了：之后再断还会再报
  r.tick('h1', { position: 1190, cause: 'cmd' });
  r.tick('h1', { position: 1195, eof: true, paused: true });
  assert.equal(r.node('h1').events.filter(([n]) => n === 'stream-cut').length, 2);
  // 真放到片尾（留了余量）：照常报 eof，由上层推进列表
  r.tick('h1', { position: 3595, cause: 'cmd' });
  r.tick('h1', { position: 3595.5, eof: true, paused: true });
  assert.deepEqual(r.node('h1').events.at(-1), ['eof', { position: 3595.5 }]);
});

impl('在线链接片长未知时不信 eof；播放器报上来的片长也算数', async (dir) => {
  const r = await engineRoom(dir, { duration: 0 });
  await r.play();
  r.tick('h1', { position: 42, eof: true, paused: true });
  assert.deepEqual(r.node('h1').events, [['stream-cut', { position: 42, duration: 0 }]]);

  const r2 = await engineRoom(dir, { duration: 0 });
  await r2.play();
  r2.tick('h1', { position: 58, duration: 60 });
  r2.tick('h1', { position: 59.9, duration: 60, eof: true, paused: true });
  assert.deepEqual(r2.node('h1').events, [['eof', { position: 59.9 }]]);
});

impl('文件项的 eof 不受影响（收全了的片放到片尾照常报放完了）', async (dir) => {
  const r = await engineRoom(dir, { streaming: false, duration: 3600 });
  await r.play();
  r.tick('h1', { position: 3599.5, eof: true, paused: true });
  assert.deepEqual(r.node('h1').events, [['eof', { position: 3599.5 }]]);
  // 收全了的片停在半路（F1：之前读进缓存的零）不是放完了，也不是断流 —— 见 midJoinRun 的数据尽头用例
  const r2 = await engineRoom(dir, { streaming: false, duration: 3600 });
  await r2.play();
  r2.tick('h1', { position: 100, eof: true, paused: true });
  assert.deepEqual(r2.node('h1').events, []);
  assert.deepEqual(r2.node('h1').seeks, [100], '停在半路要就地重放一次');
});

/* ------------------------------ 主进程：mpv ------------------------------ */

function mpvFeed() {
  const { MpvController } = require('../src/main/mpv');
  const ctl = new MpvController();
  const ticks = [];
  ctl.on('tick', (s) => ticks.push(s));
  const feed = (msg) => ctl._onData(JSON.stringify(msg) + '\n');
  return { ctl, ticks, feed };
}

test('mpv 载入失败：end-file(error) 带上错误日志认出原因，快照一直带 loadFailed，直到重新开始载入', () => {
  const { OBSERVED } = require('../src/main/mpv');
  assert.ok(OBSERVED.includes('idle-active'));
  const { ctl, ticks, feed } = mpvFeed();
  assert.equal(ctl.snapshot().loadFailed, false);
  assert.equal(ctl.snapshot().loadError, null);
  feed({ event: 'start-file', playlist_entry_id: 1 });
  feed({ event: 'log-message', prefix: 'ffmpeg', level: 'warn', text: 'https: 不相干的警告\n' });
  feed({ event: 'log-message', prefix: 'ffmpeg', level: 'error', text: 'https: HTTP error 403 Forbidden\n' });
  feed({ event: 'end-file', reason: 'error', playlist_entry_id: 1, file_error: 'loading failed' });
  assert.equal(ctl.snapshot().loadFailed, true);
  assert.deepEqual(ctl.snapshot().loadError, { reason: 'http', status: 403 });
  assert.equal(ticks.at(-1).loadFailed, true, '失败要推一条 tick 出去，渲染进程才知道');
  // 随后 mpv 进空闲：状态不变
  feed({ event: 'property-change', id: 9, name: 'idle-active', data: true });
  assert.deepEqual(ctl.snapshot().loadError, { reason: 'http', status: 403 });
  // 重新载入（拖进来别的片子之类）：之前的失败作废
  feed({ event: 'start-file', playlist_entry_id: 2 });
  assert.equal(ctl.snapshot().loadFailed, false);
  assert.equal(ticks.at(-1).loadFailed, false);
});

test('mpv 载入过又回到空闲（end-file 没收到）：同样认作打不开', () => {
  const { ctl, feed } = mpvFeed();
  feed({ event: 'start-file', playlist_entry_id: 1 });
  feed({ event: 'property-change', id: 9, name: 'idle-active', data: false });
  assert.equal(ctl.snapshot().loadFailed, false);
  feed({ event: 'property-change', id: 9, name: 'idle-active', data: true });
  assert.equal(ctl.snapshot().loadFailed, true);
  assert.equal(ctl.snapshot().loadError.reason, 'unknown');
});

test('mpv 一连上就是空闲、没见过 start-file：等一会儿还是这样才认（启动时等脚本那一下也报空闲）', async () => {
  const { ctl, ticks, feed } = mpvFeed();
  ctl.running = true;
  ctl.idleConfirmMs = 20;
  feed({ event: 'property-change', id: 9, name: 'idle-active', data: true });
  assert.equal(ctl.snapshot().loadFailed, false, '先不下结论');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(ctl.snapshot().loadFailed, true, '在我们连上管道之前就失败了：只剩这个信号');
  assert.equal(ticks.at(-1).loadFailed, true);

  // 启动那一下的空闲：接着就开始载入，不算失败
  const b = mpvFeed();
  b.ctl.running = true;
  b.ctl.idleConfirmMs = 20;
  b.feed({ event: 'property-change', id: 9, name: 'idle-active', data: true });
  b.feed({ event: 'start-file', playlist_entry_id: 1 });
  b.feed({ event: 'property-change', id: 9, name: 'idle-active', data: false });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(b.ctl.snapshot().loadFailed, false);

  // 退掉播放器时计时器一并收掉
  const c = mpvFeed();
  c.ctl.running = true;
  c.ctl.idleConfirmMs = 20;
  c.feed({ event: 'property-change', id: 9, name: 'idle-active', data: true });
  c.ctl.running = false;
  await c.ctl.quit();
  assert.equal(c.ctl._idleTimer, null);
});

test('mpv 连上管道后要错误日志；错误日志只留最近几行、每行截短', () => {
  const src = read('src', 'main', 'mpv.js');
  // warn 级：ffmpeg 自己拿到的 HTTP 错误码是 warn（F1 / E1-C），收到的其余 warn 不留
  assert.match(src, /this\.command\(\['request_log_messages', 'warn'\]\)/);
  const { ctl, feed } = mpvFeed();
  for (let i = 0; i < 20; i++) feed({ event: 'log-message', prefix: 'ffmpeg', level: 'error', text: `第 ${i} 行 ${'x'.repeat(500)}` });
  assert.ok(ctl._errorLogs.length <= 8);
  assert.ok(ctl._errorLogs.every((l) => l.length <= 300));
  assert.match(ctl._errorLogs.at(-1), /^ffmpeg: 第 19 行/);
});

test('载入失败的原因代号：HTTP 状态码、yt-dlp 解析失败、网络、格式、其它', () => {
  const { classifyLoadFailure } = require('../src/main/mpv');
  assert.deepEqual(classifyLoadFailure({ logs: ['ffmpeg: https: HTTP error 404 Not Found'] }), { reason: 'http', status: 404 });
  assert.deepEqual(
    classifyLoadFailure({ logs: ['ytdl_hook: ERROR: [generic] Unable to download webpage: HTTP Error 403: Forbidden'] }),
    { reason: 'http', status: 403 }
  );
  assert.deepEqual(
    classifyLoadFailure({ logs: ['ytdl_hook: ERROR: [youtube] abc: Video unavailable', 'ytdl_hook: youtube-dl failed: unexpected error'] }),
    { reason: 'resolve', status: null }
  );
  assert.deepEqual(classifyLoadFailure({ logs: ['ffmpeg: tcp: Connection timed out'] }), { reason: 'network', status: null });
  assert.deepEqual(classifyLoadFailure({ fileError: 'unrecognized file format', logs: [] }), { reason: 'format', status: null });
  assert.deepEqual(classifyLoadFailure({ logs: ['ffmpeg: HTTP error 999 什么鬼'] }), { reason: 'unknown', status: null });
  assert.deepEqual(classifyLoadFailure(), { reason: 'unknown', status: null });
});

test('YouTube 页面交给 mpv 时，ytdl_hook 和解析、缓存用同一个客户端（android_vr）；别的网站和本地文件不加', () => {
  const { buildLaunchArgs, YOUTUBE_EXTRACTOR_ARGS } = require('../src/main/mpv');
  assert.equal(YOUTUBE_EXTRACTOR_ARGS, 'youtube:player_client=android_vr');
  const flag = '--ytdl-raw-options-append=extractor-args=youtube:player_client=android_vr';
  for (const source of ['https://www.youtube.com/watch?v=abc', 'https://youtu.be/abc', 'https://m.youtube.com/watch?v=x']) {
    const args = buildLaunchArgs({ ipcPath: 'x', source });
    assert.ok(args.includes(flag), source);
    assert.ok(args.indexOf(flag) < args.indexOf('--'), '选项必须在 -- 之前');
  }
  for (const source of ['https://notyoutube.com/watch?v=abc', 'https://cdn.example/v.mp4', 'D:/片子.mkv']) {
    assert.ok(!buildLaunchArgs({ ipcPath: 'x', source }).some((a) => a.includes('extractor-args')), source);
  }
  // linkCache 和 inspectLink 用的是同一个值，三处别再分叉
  assert.match(read('src', 'main', 'linkCache.js'), /'youtube:player_client=android_vr'/);
  assert.match(read('src', 'main', 'linkMedia.js'), /'youtube:player_client=android_vr'/);
});

/* ------------------------------ app.js ------------------------------ */

/** app.js 顶层函数的源码：从声明行到下一个顶格的 `}`。 */
function fnSource(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层函数 ${name}`);
  const end = APP.indexOf('\n}\n', m.index);
  assert.ok(end > m.index, `${name} 的结尾没找到`);
  return APP.slice(m.index, end + 2);
}

function appConst(name) {
  const m = new RegExp(`^const ${name} = ([\\d_ *]+);`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到常量 ${name}`);
  return Function(`return (${m[1]});`)();
}
const LINK_INFO_TTL_MS = appConst('LINK_INFO_TTL_MS');
const FALLBACK_CONFIRM_MS = appConst('FALLBACK_CONFIRM_MS');

function el() {
  const e = { textContent: '', className: '', hidden: false, disabled: false };
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
  e.setAttribute = () => {};
  return e;
}

const LINK_FNS = [
  'siteOf',
  'siteHost',
  'linkKey',
  'siteApproved',
  'cachedLinkInfo',
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
  'linkPlayFailed',
  'linkLoadErrorText',
  'noteLinkPlayback',
  'onLinkStreamCut',
  'retryCurrentLink',
  'retryLinkNow',
  'reopenPlayer',
  'useCachedLink',
  'refreshNowLink',
  'onLinkCacheUpdate',
  'playCachedCurrentNow',
  'linkCacheOf',
  'linkDownloadOf',
  'renderStatus',
];

async function linkBox({ isHost = false, inspect, localPath = null, paused = false } = {}) {
  const { currentItem } = await loadLib('playlist.js');
  const clock = { now: Date.now() };
  class FakeDate extends Date {
    static now() {
      return clock.now;
    }
  }
  const calls = [];
  const logs = [];
  const sent = [];
  const inspected = [];
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, el());
    return nodes.get(id);
  };
  const S = {
    peerId: isHost ? 'host-peer' : 'me',
    hostId: 'host-peer',
    current: null,
    currentSeq: 3,
    playlist: { rev: 1, seq: 3, queue: [], history: [], started: true, autoplay: true, nextSlot: 1 },
    links: new Map(),
    myLinks: new Set(),
    approvedSites: new Set(['https://video.example']),
    skippedLinks: new Set(),
    resolvingLinks: new Set(),
    linkConsent: null,
    fallbackConsent: null,
    linkFailedSeq: null,
    linkPlayFailed: null,
    nowLink: null,
    linkInfo: null,
    filePath: null,
    sourceType: 'link',
    mpvRunning: false,
    switchingMedia: false,
    linkCaches: new Map(),
    linkDownloads: new Map(),
    playerQuit: Promise.resolve(),
    mediaSafety: { status: 'idle' },
    swarm: { peers: new Map([['p', { authenticated: true, send: (m) => sent.push(m) }]]) },
    sync: {
      status: () => ({ stalled: false, paused, intendedPaused: paused, position: 0, duration: 0, waitingFor: [] }),
      canIControl: () => true,
      playerGone: () => calls.push('playerGone'),
    },
  };
  const noop = () => {};
  const ctx = {
    S,
    URL,
    Date: FakeDate,
    LINK_INFO_TTL_MS,
    FALLBACK_CONFIRM_MS,
    MSG: { NOW_LINK: 'now-link' },
    $,
    currentItem,
    log: (text, tone) => logs.push([text, tone]),
    fmtTime: (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`,
    isRoomHost: () => isHost,
    renderPlaylist: noop,
    renderPlaylistSoon: noop,
    updateLocalReady: noop,
    preResolveNextLink: noop,
    linkCacheBusy: (c) => c?.state === 'queued' || c?.state === 'downloading',
    onLinkSessionReady: async () => calls.push(['launch', S.filePath]),
    launchPlayer: async () => calls.push(['reopen', S.filePath]),
    retirePlayer: () => {
      calls.push('retire');
      S.mpvRunning = false;
    },
    // renderStatus 周边：这里不关心
    stallBannerText: () => '有人卡着',
    driftShown: () => false,
    driftRefName: () => '房主',
    canEditPlaylist: () => true,
    currentUnavailable: () => false,
    currentSession: () => null,
    scanProgressLabel: () => '',
    playbackAllowed: () => true,
    setScanTicker: noop,
    pushMpvBanner: noop,
    renderNowKicker: noop,
    renderDrift: noop,
    updateStripTone: noop,
    updatePresence: noop,
    window: {
      sw: {
        media: {
          inspectLink: (url) => {
            inspected.push(url);
            return inspect ? inspect(url) : Promise.resolve({ url, title: 't', duration: 60, extractor: 'generic', resolvedAt: clock.now });
          },
        },
        linkCache: { localPath: async () => localPath },
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(LINK_FNS.map(fnSource).join('\n\n'), ctx, { filename: 'app.js（节选）' });
  return { ctx, S, calls, logs, sent, inspected, clock, $ };
}

const linkItem = (over = {}) => ({ id: 'aaaaaaaa', kind: 'link', url: 'https://video.example/watch/1', title: '海边', ...over });

test('播放器打不开在线视频：说明原因（只报一次），行内和状态栏给「重试」和「跳过」', async () => {
  const { ctx, S, logs, $ } = await linkBox();
  const item = linkItem();
  S.current = item;
  S.linkInfo = { url: item.url, extractor: 'generic', resolvedAt: Date.now() };
  S.filePath = item.url;
  S.mpvRunning = true;
  ctx.noteLinkPlayback({ position: 0, idle: true, loadFailed: true, loadError: { reason: 'http', status: 403 } });
  ctx.noteLinkPlayback({ position: 0, idle: true, loadFailed: true, loadError: { reason: 'http', status: 403 } });
  assert.deepEqual(
    logs.filter(([t]) => t.startsWith('播放器打不开')),
    [['播放器打不开这个在线视频：网站拒绝了播放请求（HTTP 403），播放地址可能已经过期', 'bad']]
  );
  assert.equal(ctx.linkPlayFailed(), true);
  const notice = ctx.linkNotice(item);
  assert.equal(notice.text, '播放器打不开这个链接');
  assert.deepEqual(Array.from(notice.actions, (a) => a.key), ['retry-link', 'skip-link']);

  // 房间照常在播，横幅不能说「播放中，所有人同步」
  ctx.renderStatus();
  assert.equal($('status-banner').textContent, '播放器打不开这个在线视频，可以重试，也可以先跳过这一部');
  assert.equal($('btn-retry-link').hidden, false);
  assert.equal($('btn-skip-link').hidden, false);

  // 跳过了就不再提示
  S.skippedLinks.add(item.id);
  assert.equal(ctx.linkPlayFailed(), false);
  ctx.renderStatus();
  assert.equal($('btn-retry-link').hidden, true);
  // 换了一部：提示跟着作废
  S.skippedLinks.clear();
  S.currentSeq = 4;
  assert.equal(ctx.linkPlayFailed(), false);
});

// R3-D：跳过之后 linkPlayFailed() 为假，打不开的播放器又一直带着 loadFailed 推 tick（房主每次卡顿状态变化、
// 引擎动一下播放器就是一条），以前每一条都再记一行。按 seq 只记一次。
test('跳过之后打不开的播放器还在推 tick：这一部只记一次；换一部再打不开照样说', async () => {
  const { ctx, S, logs } = await linkBox();
  const item = linkItem();
  S.current = item;
  S.linkInfo = { url: item.url, extractor: 'generic', resolvedAt: Date.now() };
  S.filePath = item.url;
  S.mpvRunning = true;
  const failed = { position: null, idle: true, loadFailed: true, loadError: { reason: 'http', status: 403 } };
  const lines = () => logs.filter(([t]) => t.startsWith('播放器打不开')).length;
  ctx.noteLinkPlayback(failed);
  assert.equal(lines(), 1);
  S.skippedLinks.add(item.id);
  for (let i = 0; i < 5; i++) ctx.noteLinkPlayback(failed);
  assert.equal(lines(), 1, '跳过之后每条 tick 都再记一行');

  // 先跳过、之后才打不开：记一次，之后不再记
  S.currentSeq = 4;
  S.current = linkItem({ id: 'bbbbbbbb' });
  S.skippedLinks.add('bbbbbbbb');
  for (let i = 0; i < 5; i++) ctx.noteLinkPlayback(failed);
  assert.equal(lines(), 2);

  // 换了一部（seq 变了）又打不开：新的一部照样说
  S.currentSeq = 5;
  S.current = linkItem({ id: 'cccccccc' });
  ctx.noteLinkPlayback(failed);
  ctx.noteLinkPlayback(failed);
  assert.equal(lines(), 3);
});

test('原因文案：各种代号都有一句人话', async () => {
  const { ctx } = await linkBox();
  const text = (e) => ctx.linkLoadErrorText(e);
  assert.equal(text({ reason: 'http', status: 401 }), '网站拒绝了播放请求（HTTP 401），播放地址可能已经过期');
  assert.equal(text({ reason: 'http', status: 404 }), '网站返回了错误（HTTP 404）');
  assert.equal(text({ reason: 'http' }), '网站返回了错误');
  assert.equal(text({ reason: 'resolve' }), 'yt-dlp 没能从网页里解析出视频');
  assert.equal(text({ reason: 'network' }), '连不上视频网站（超时或网络中断）');
  assert.equal(text({ reason: 'format' }), '播放器认不出这个视频的格式');
  assert.equal(text(null), '原因不明');
});

test('在线视频半路断了：提示本人重新连接；又放起来了提示收掉', async () => {
  const { ctx, S, logs, $ } = await linkBox();
  const item = linkItem();
  S.current = item;
  S.linkInfo = { url: item.url, extractor: 'generic', resolvedAt: Date.now() };
  S.mpvRunning = true;
  ctx.onLinkStreamCut({ position: 1200, duration: 5400 });
  assert.deepEqual(logs.at(-1), ['在线视频在 20:00 断了（全片 90:00），不是放完了：点「重试」重新连接', 'warn']);
  assert.equal(ctx.linkNotice(item).text, '在线视频断了');
  ctx.renderStatus();
  assert.equal($('status-banner').textContent, '在线视频断了，点「重试」重新连接，也可以先跳过这一部');
  ctx.noteLinkPlayback({ position: 1190, eof: false });
  assert.equal(ctx.linkPlayFailed(), false);

  ctx.onLinkStreamCut({ position: 42, duration: 0 });
  assert.deepEqual(logs.at(-1), [
    '在线视频停住了，但片长未知，分不清是放完了还是断流了：没放完就点「重试」重新连接',
    'warn',
  ]);
});

test('「重试」：旧播放器先退、解析结果不沿用，重新解析后从房间位置起播', async () => {
  const { ctx, S, calls, inspected } = await linkBox();
  const item = linkItem();
  S.current = item;
  S.links.set(ctx.linkKey(item.url), { url: item.url, extractor: 'generic', resolvedAt: Date.now() });
  S.linkInfo = { url: item.url, extractor: 'generic', resolvedAt: Date.now() };
  S.filePath = item.url;
  S.mpvRunning = true;
  S.linkPlayFailed = { seq: 3, kind: 'load' };
  await ctx.retryCurrentLink();
  assert.deepEqual(calls.slice(0, 2), ['retire', 'playerGone']);
  assert.deepEqual(inspected, [item.url], '解析结果不沿用（签名地址可能正是出问题的那个）');
  assert.deepEqual(calls.at(-1), ['launch', item.url]);
  assert.equal(S.linkPlayFailed, null);
});

test('连点两下「重试」只重来一遍（行内按钮按节流重画，第二下还点得到）', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { ctx, S, calls, inspected } = await linkBox({
    inspect: (url) => gate.then(() => ({ url, title: 't', resolvedAt: Date.now() })),
  });
  const item = linkItem();
  S.current = item;
  S.linkInfo = { url: item.url, extractor: 'generic', resolvedAt: Date.now() };
  S.filePath = item.url;
  S.linkPlayFailed = { seq: 3, kind: 'load' };
  const first = ctx.retryCurrentLink();
  const second = ctx.retryCurrentLink();
  await flush();
  assert.equal(inspected.length, 1);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(calls.filter((c) => Array.isArray(c) && c[0] === 'launch').length, 1);
  assert.equal(S.linkRetrying, null, '做完了放开，之后还能再重试');
});

test('本机解析失败后点「重试」：重新解析，这次成功就起播', async () => {
  let fail = true;
  const { ctx, S, calls, inspected } = await linkBox({
    inspect: (url) => (fail ? Promise.reject(new Error('超时')) : Promise.resolve({ url, title: 't', resolvedAt: Date.now() })),
  });
  const item = linkItem();
  S.current = item;
  await ctx.activateLinkItem(item, 3);
  assert.equal(ctx.linkResolveFailed(), true);
  fail = false;
  await ctx.retryCurrentLink();
  assert.equal(inspected.length, 2);
  assert.deepEqual(calls.at(-1), ['launch', item.url]);
  assert.equal(ctx.linkResolveFailed(), false);
});

test('「重新打开播放器」：隔离浏览器抓到的地址放久了就重新解析；普通 yt-dlp 那一路照旧打开', async () => {
  const box = await linkBox();
  const item = linkItem();
  box.S.current = item;
  box.S.linkInfo = { url: item.url, extractor: 'isolated-browser', resolvedAt: box.clock.now - LINK_INFO_TTL_MS - 1 };
  box.S.filePath = 'https://cdn.example/signed.m3u8?sig=old';
  await box.ctx.reopenPlayer();
  assert.deepEqual(box.inspected, [item.url]);
  assert.deepEqual(box.calls.at(-1), ['launch', item.url]);

  // 还新鲜：照旧打开
  const fresh = await linkBox();
  fresh.S.current = item;
  fresh.S.linkInfo = { url: item.url, extractor: 'isolated-browser', resolvedAt: fresh.clock.now };
  fresh.S.filePath = 'https://cdn.example/signed.m3u8';
  await fresh.ctx.reopenPlayer();
  assert.deepEqual(fresh.inspected, []);
  assert.deepEqual(fresh.calls, [['reopen', 'https://cdn.example/signed.m3u8']]);

  // 普通 yt-dlp：交给播放器的是网页地址，mpv 重开时自己会重新解析
  const ytdl = await linkBox();
  ytdl.S.current = item;
  ytdl.S.linkInfo = { url: item.url, extractor: 'youtube', resolvedAt: ytdl.clock.now - 3 * LINK_INFO_TTL_MS };
  ytdl.S.filePath = item.url;
  await ytdl.ctx.reopenPlayer();
  assert.deepEqual(ytdl.inspected, []);
  assert.deepEqual(ytdl.calls, [['reopen', item.url]]);

  // 上一次就没放起来：重新来一遍
  const failed = await linkBox();
  failed.S.current = item;
  failed.S.linkInfo = { url: item.url, extractor: 'youtube', resolvedAt: failed.clock.now };
  failed.S.filePath = item.url;
  failed.S.linkPlayFailed = { seq: 3, kind: 'cut' };
  await failed.ctx.reopenPlayer();
  assert.deepEqual(failed.inspected, [item.url]);
});

test('房主给的地址：重开时房主那边已经有更新的就换上；打不开时房主发来新的也自动换上', async () => {
  const { ctx, S, calls, inspected, clock } = await linkBox({ inspect: () => Promise.reject(new Error('地区限制')) });
  const item = linkItem();
  S.current = item;
  S.approvedSites.add('https://cdn.example');
  const host = { peerId: 'host-peer' };
  // 本机解析失败，用上房主一小时前给的地址（签名多半过期了）
  ctx.onNowLink({ seq: 3, playback: { url: 'https://cdn.example/a.m3u8' }, resolvedAt: clock.now - 60 * 1000 }, host);
  await ctx.activateLinkItem(item, 3);
  assert.equal(S.linkInfo.extractor, 'host-resolved');
  assert.equal(S.linkInfo.resolvedAt, clock.now - 60 * 1000, '记房主解析的时间');
  assert.deepEqual(calls.at(-1), ['launch', 'https://cdn.example/a.m3u8']);

  // 放了很久：房主没更新过，还用手上这条试试
  clock.now += LINK_INFO_TTL_MS;
  await ctx.reopenPlayer();
  assert.deepEqual(calls.at(-1), ['reopen', 'https://cdn.example/a.m3u8']);

  // 房主刷新了地址：正在放的不动（不中途换源）……
  S.mpvRunning = true;
  const before = calls.length;
  ctx.onNowLink({ seq: 3, playback: { url: 'https://cdn.example/b.m3u8' }, resolvedAt: clock.now }, host);
  await flush();
  assert.equal(calls.length, before);
  // ……播放器打不开时收到新地址：直接换上，不再先把本机解析重跑一遍
  S.linkPlayFailed = { seq: 3, kind: 'load' };
  const inspectedBefore = inspected.length;
  ctx.onNowLink({ seq: 3, playback: { url: 'https://cdn.example/c.m3u8' }, resolvedAt: clock.now }, host);
  await flush();
  assert.deepEqual(calls.at(-1), ['launch', 'https://cdn.example/c.m3u8']);
  assert.equal(inspected.length, inspectedBefore);

  // 关掉播放器、签名放久了，房主那边已经换过：重开用新的
  S.mpvRunning = false;
  clock.now += LINK_INFO_TTL_MS + 1;
  ctx.onNowLink({ seq: 3, playback: { url: 'https://cdn.example/d.m3u8' }, resolvedAt: clock.now }, host);
  await ctx.reopenPlayer();
  await flush();
  assert.deepEqual(calls.at(-1), ['launch', 'https://cdn.example/d.m3u8']);
});

test('房主放本地缓存：提前解析过的地址照样发给成员；没有就在后台解析一份补发', async () => {
  const pre = await linkBox({ isHost: true, localPath: { path: 'D:/缓存/海边.mp4', title: '海边' } });
  const item = linkItem();
  pre.S.current = item;
  pre.S.playlist.queue = [item];
  pre.S.links.set(pre.ctx.linkKey(item.url), {
    url: item.url,
    playback: { url: 'https://cdn.example/pre.mp4' },
    resolvedAt: pre.clock.now,
  });
  await pre.ctx.useCachedLink(item, { path: 'D:/缓存/海边.mp4', title: '海边' }, 3);
  assert.equal(pre.S.filePath, 'D:/缓存/海边.mp4', '房主自己照旧从本地播');
  assert.deepEqual(pre.sent.at(-1).playback, { url: 'https://cdn.example/pre.mp4' });
  assert.deepEqual(pre.inspected, []);

  const late = await linkBox({ isHost: true });
  late.S.current = item;
  late.S.playlist.queue = [item];
  await late.ctx.useCachedLink(item, { path: 'D:/缓存/海边.mp4', title: '海边' }, 3);
  assert.equal(late.sent[0].playback, null, '先发一条让大家知道开始了');
  assert.equal(late.sent[0].resolvedAt, 0);
  await flush();
  assert.deepEqual(late.inspected, [item.url], '后台解析一份');
  assert.equal(late.sent.length, 2);
  assert.equal(late.sent[1].seq, 3);
  assert.ok(late.sent[1].resolvedAt > 0);
});

test('当前这部本机解析失败（或正等着允许网站），手动缓存下完了：直接改从本地播', async () => {
  const box = await linkBox({ inspect: () => Promise.reject(new Error('限流')), localPath: { path: 'D:/缓存/海边.mp4', title: '海边' } });
  const item = linkItem();
  box.S.current = item;
  await box.ctx.activateLinkItem(item, 3);
  assert.equal(box.ctx.linkResolveFailed(), true);
  box.ctx.onLinkCacheUpdate({ url: item.url, purpose: 'cache', title: '海边', state: 'downloading', downloaded: 1, total: 2 });
  await flush();
  assert.equal(box.S.linkInfo, null);
  box.ctx.onLinkCacheUpdate({ url: item.url, purpose: 'cache', title: '海边', state: 'done', downloaded: 2, total: 2 });
  await flush();
  assert.equal(box.S.linkInfo?.local, true);
  assert.deepEqual(box.calls.at(-1), ['launch', 'D:/缓存/海边.mp4']);

  // 还在等本人允许网站：从本地放不连网站，不用再问
  const asking = await linkBox({ localPath: { path: 'D:/缓存/海边.mp4', title: '海边' } });
  const other = linkItem({ url: 'https://unknown.example/v' });
  asking.S.current = other;
  await asking.ctx.activateLinkItem(other, 3);
  assert.equal(asking.ctx.linkAsking(), true);
  asking.ctx.onLinkCacheUpdate({ url: other.url, purpose: 'cache', title: '', state: 'done' });
  await flush();
  assert.deepEqual(asking.calls.at(-1), ['launch', 'D:/缓存/海边.mp4']);
  assert.equal(asking.S.linkConsent, null);
  assert.deepEqual(asking.inspected, [], '没去连网站');

  // 正在在线放的不中途换源；边下边播的下载下完也不算
  const playing = await linkBox({ localPath: { path: 'D:/缓存/海边.mp4', title: '海边' } });
  playing.S.current = item;
  await playing.ctx.activateLinkItem(item, 3);
  const n = playing.calls.length;
  playing.ctx.onLinkCacheUpdate({ url: item.url, purpose: 'cache', title: '', state: 'done' });
  playing.ctx.onLinkCacheUpdate({ url: item.url, purpose: 'download', title: '', state: 'done' });
  await flush();
  assert.equal(playing.calls.length, n);
  assert.equal(playing.S.linkInfo.local, undefined);
});

test('接线：tick 交给 noteLinkPlayback，stream-cut 有人听，播放器退出放掉卡顿，「重新打开」和「重试」按钮', () => {
  assert.match(fnSource('handlePlayerTick'), /if \(S\.sourceType === 'link'\) noteLinkPlayback\(snap\);/);
  assert.match(fnSource('initSwarmAndSync'), /S\.sync\.on\('stream-cut', \(e\) => onLinkStreamCut\(e\)\);/);
  assert.match(fnSource('handlePlayerExit'), /S\.sync\?\.playerGone\?\.\(\);/);
  assert.match(fnSource('detachFromPlayer'), /S\.sync\?\.playerGone\?\.\(\);/);
  assert.match(APP, /\$\('btn-reopen'\)\.onclick = \(\) => reopenPlayer\(\);/);
  assert.match(APP, /\$\('btn-retry-link'\)\.onclick = /);
  assert.match(fnSource('onPlaylistAction'), /case 'retry-link':/);
  const html = read('src', 'renderer', 'index.html');
  assert.match(html, /id="btn-retry-link">重试</);
});

test('新文案都有英文（含动态模板）', async () => {
  const { translate } = await loadLib('i18n.js');
  const cases = [
    ['重试', 'Retry'],
    ['本机没能解析这个链接', 'This link could not be resolved on your computer'],
    [
      '这个视频链接在你的电脑上没能解析出来，可以重试，也可以先跳过这一部',
      'This video link could not be resolved on your computer. You can retry or skip this one for now.',
    ],
    ['播放器打不开这个链接', 'The player cannot open this link'],
    ['在线视频断了', 'The online video was cut off'],
    [
      '播放器打不开这个在线视频，可以重试，也可以先跳过这一部',
      'The player cannot open this online video. You can retry or skip this one for now.',
    ],
    [
      '在线视频断了，点「重试」重新连接，也可以先跳过这一部',
      'The online video was cut off. Select “Retry” to reconnect, or skip this one for now.',
    ],
    [
      '在线视频停住了，但片长未知，分不清是放完了还是断流了：没放完就点「重试」重新连接',
      'The online video stopped, but its length is unknown, so it is unclear whether it finished or was cut off. If it did not finish, select “Retry” to reconnect.',
    ],
    [
      '播放器打不开这个在线视频：网站拒绝了播放请求（HTTP 403），播放地址可能已经过期',
      'The player cannot open this online video: The website refused playback (HTTP 403); the stream URL may have expired',
    ],
    ['播放器打不开这个在线视频：网站返回了错误（HTTP 404）', 'The player cannot open this online video: The website returned an error (HTTP 404)'],
    ['播放器打不开这个在线视频：网站返回了错误', 'The player cannot open this online video: The website returned an error'],
    ['播放器打不开这个在线视频：yt-dlp 没能从网页里解析出视频', 'The player cannot open this online video: yt-dlp could not extract a video from the page'],
    [
      '播放器打不开这个在线视频：连不上视频网站（超时或网络中断）',
      'The player cannot open this online video: Could not reach the video website (timed out or the network dropped)',
    ],
    ['播放器打不开这个在线视频：播放器认不出这个视频的格式', 'The player cannot open this online video: The player does not recognize this video format'],
    ['播放器打不开这个在线视频：原因不明', 'The player cannot open this online video: Unknown reason'],
    [
      '在线视频在 20:00 断了（全片 1:30:00），不是放完了：点「重试」重新连接',
      'The online video was cut off at 20:00 (full length 1:30:00); it did not finish. Select “Retry” to reconnect.',
    ],
    ['重新连接《海边》…', 'Reconnecting “海边”…'],
    ['《海边》缓存好了，改从本地播', '“海边” is cached; playing it from disk now'],
  ];
  for (const [zh, en] of cases) {
    assert.equal(translate(zh, 'en'), en, zh);
  }
  // 片名原样保留，哪怕恰好是一个有翻译的词
  assert.equal(translate('重新连接《重试》…', 'en'), 'Reconnecting “重试”…');
});
