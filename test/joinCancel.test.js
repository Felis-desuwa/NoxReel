'use strict';

// 批次 6：等待页能取消，离开房间有确认。
//
//  1. 一对一邀请加入：准备页从一开始就有「取消」，生成应答链接之后也还在；点了就把这次尝试拆干净（A1-1）；
//  2. 首页开房的整页准备（转封装、算哈希、解析链接）有「取消」：叫停挂着的任务、回首页，不报错（A1-2）；
//  3. 信令加入连上服务器后一直进不了房：超时、房主退避用尽、房主离开，都在准备页给结论、诊断和「重试 / 返回」（A1-4）；
//  4. 「离开房间」在有没收完的接收、或者自己是房主且房里有人时先确认，连点不重入（A1-3）；
//  5. 加入失败的标题是「没能加入房间」（A1-6）；在房间里点开应答链接不再叫人退房（A1-8）；
//  6. 启动检查跑完之前来的深链接先排队（GG2-5）；安全模式对不上时说「改完点加入」（C2-8）。
//
// 照 appHardening 的做法把 app.js 的顶层函数原样抠进 vm 沙箱，周围配假 DOM、假连接、手动拨的假时钟。
// 全程不联网、不起播放器、不出声。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('src/renderer/app.js');
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);

function fnSource(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层函数 ${name}`);
  const end = APP.indexOf('\n}\n', m.index);
  assert.ok(end > m.index, `${name} 的结尾没找到`);
  return APP.slice(m.index, end + 2);
}

function declSource(name) {
  const m = new RegExp(`^(?:const|let) ${name} = [^\\n]*;$`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层声明 ${name}`);
  return m[0];
}

function appConst(name) {
  const m = new RegExp(`^const ${name} = ([\\d_]+);`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到常量 ${name}`);
  return Number(m[1].replace(/_/g, ''));
}

// peerName 用 chat.js 的 clampName 清洗昵称；Emitter 给假 Swarm 用
let clampName = null;
let Emitter = null;
test.before(async () => {
  ({ clampName } = await load('src/renderer/lib/chat.js'));
  ({ Emitter } = await load('src/renderer/lib/emitter.js'));
});

function sandbox({ fns = [], decls = [], globals = {} }) {
  // settlePendingOpsHostLost：hostReallyGone 顺手结算挂着的列表操作（批次 15），这里的用例不关心
  const ctx = { console, crypto: globalThis.crypto, clampName, settlePendingOpsHostLost: () => {}, ...globals };
  vm.createContext(ctx);
  vm.runInContext([...decls.map(declSource), ...fns.map(fnSource)].join('\n\n'), ctx, { filename: 'app.js（节选）' });
  return ctx;
}

async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

function fakeClock() {
  let now = 0;
  let seq = 0;
  const queue = new Map();
  return {
    setTimeout: (fn, ms = 0) => {
      seq += 1;
      queue.set(seq, { fn, at: now + ms });
      return seq;
    },
    clearTimeout: (h) => queue.delete(h),
    get pending() {
      return queue.size;
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [h, t] of queue) if (t.at <= end && (!next || t.at < next[1].at)) next = [h, t];
        if (!next) break;
        queue.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
  };
}

function fakeStorage(init = {}) {
  const map = new Map(Object.entries(init));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

/** 假 DOM：$ 按 id 给同一个对象；replace 记下每个容器最后一次换成了什么。 */
function fakeDom() {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) {
      els.set(id, {
        id,
        textContent: '',
        value: '',
        disabled: false,
        style: {},
        classList: { add() {}, remove() {}, toggle() {} },
        select() {},
      });
    }
    return els.get(id);
  };
  const replaced = new Map();
  let actionWrites = 0;
  const replace = (target, ...nodes) => {
    const list = nodes.flat(Infinity).filter((n) => n != null && n !== false);
    replaced.set(target, list);
    if (target === 'prep-actions') actionWrites += 1;
    if (target === 'prep-note') $(target).textContent = list.map((n) => (typeof n === 'string' ? n : n.text || '')).join('\n');
  };
  const make = (tag, o = {}, kids = []) => ({ tag, ...o, kids, style: {} });
  return {
    $,
    replace,
    make,
    actions: () => replaced.get('prep-actions') || [],
    button: (text) => (replaced.get('prep-actions') || []).find((b) => b.text === text),
    get actionWrites() {
      return actionWrites;
    },
  };
}

function swarmClass() {
  return class FakeSwarm extends Emitter {
    constructor() {
      super();
      this.peers = new Map();
      this.files = new Map();
      this.destroyed = false;
    }
    addPeer(peer) {
      this.peers.set(peer.peerId, peer);
    }
    removePeer(id) {
      const p = this.peers.get(id);
      if (!p) return;
      this.peers.delete(id);
      p.close?.();
    }
    destroy() {
      this.destroyed = true;
      for (const p of this.peers.values()) p.close?.();
      this.peers.clear();
      this.removeAll();
    }
  };
}

// 开房、加入共用的那一套「尝试」函数（开始、换代、拆残局、准备页的结论和「取消」）
const ATTEMPT_FNS = [
  'beginAttempt',
  'resetAttempt',
  'attemptLive',
  'endAttempt',
  'joiningWith',
  'inviteKey',
  'backHome',
  'prepFail',
  'joinFail',
  'prepStop',
  'hint',
  'cancelJoinButton',
  'storedCapacity',
  'cancelRecovery',
  'inviteFileLine',
  'modeMismatchText',
];
const ATTEMPT_DECLS = ['clampCapacity', 'normalizeSecurityMode', 'MAX_PEER_NAME', 'peerName', 'RECOVERY', 'RENEGOTIATING', 'rebuildBudget', 'isRoomHost'];

function world({ fns = [], decls = [], globals = {}, securityMode = 'trusted' } = {}) {
  const dom = fakeDom();
  const clock = fakeClock();
  const shown = [];
  const logs = [];
  const FakeSwarm = swarmClass();
  const S = {
    peerId: 'me-peer',
    name: '我',
    role: null,
    hostId: null,
    mode: null,
    signalTransport: null,
    swarm: null,
    sync: null,
    signaling: null,
    roomCapacity: 4,
    roomSecurityMode: null,
    pendingManualPeer: null,
    isSeeder: false,
    leaving: false,
    settings: { securityMode, relays: '' },
    sessions: new Map(),
  };
  const ctx = sandbox({
    fns: [...ATTEMPT_FNS, ...fns],
    decls: [...ATTEMPT_DECLS, ...decls],
    globals: {
      S,
      $: dom.$,
      make: dom.make,
      replace: dom.replace,
      show: (v) => shown.push(v),
      setSteps: () => {},
      log: (text, tone) => logs.push([text, tone]),
      fmtBytes: (n) => `${n} B`,
      securityModeLabel: (m) => (m === 'trusted' ? '可信房间' : '安全模式'),
      inviteVersionText: () => '版本不对',
      PROTOCOL_VERSION: 2,
      roomEntered: false,
      joinAttempt: { gen: 0, busy: null, cleanups: [] },
      localStorage: fakeStorage({ 'sw.roomCapacity': '4' }),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      turnFetchNeeded: () => false,
      ensureTurnReady: async () => {},
      relayOnlyBlocked: () => '',
      peerIce: () => ({ iceServers: [], iceTransportPolicy: 'all' }),
      initSwarmAndSync: () => {
        if (S.swarm) return;
        S.swarm = new FakeSwarm();
        S.sync = { removeAll() {} };
      },
      connectionAdvice: (peer) => ({ level: 'bad', text: `诊断了 ${peer.peerId}` }),
      copyDiagnosticsButton: () => ({ tag: 'button', text: '复制诊断信息' }),
      renderPlaylistSoon: () => {},
      ...globals,
    },
  });
  return { ctx, S, dom, clock, shown, logs };
}

/* ------------------------- A1-1：一对一邀请加入的准备页 ------------------------- */

const OFFER = { k: 'offer', from: 'host-A', name: '房主', sdp: { type: 'offer', sdp: 'v=0' }, securityMode: 'trusted', protocolVersion: 2 };

function manualJoin() {
  const peers = [];
  const offer = deferred();
  class FakePeer {
    constructor(o) {
      Object.assign(this, o);
      this.closed = false;
      this.authenticated = false;
      peers.push(this);
    }
    on() {
      return () => {};
    }
    acceptOffer() {
      return offer.promise;
    }
    close() {
      this.closed = true;
    }
  }
  const w = world({
    fns: ['joinViaManual'],
    decls: ['MANUAL_JOIN_WAIT_TIMEOUT_MS'],
    globals: {
      Peer: FakePeer,
      wirePeer: () => {},
      encodeCode: async () => 'NR2-answer',
      shareLink: (code) => `https://example.test/#a/${code}/`,
      copyCode: () => {},
      window: { sw: { clipboard: { writeText: async () => {} } } },
    },
  });
  return { ...w, peers, offer };
}

test('一对一邀请加入：还在收集候选时就有「取消」，顺带清掉上一次结论页留下的按钮', async () => {
  const w = manualJoin();
  // 上一次停在别的邀请的结论页：「重新生成应答链接」的闭包里攥着旧邀请
  w.ctx.replace('prep-actions', { tag: 'button', text: '重新生成应答链接' }, { tag: 'button', text: '返回' });
  const joining = w.ctx.joinViaManual(OFFER);
  assert.deepEqual(
    w.dom.actions().map((b) => b.text),
    ['取消'],
    '收集候选那几秒里残留的「重新生成应答链接」误点会把这一次拆掉、改连旧邀请'
  );

  const writes = w.dom.actionWrites;
  w.dom.button('取消').onclick();
  assert.equal(w.shown.at(-1), 'view-home');
  assert.equal(w.S.swarm, null, '没进成房的 Swarm 要拆掉');
  assert.ok(w.peers[0].closed, '占位的直连要关掉，否则房主事后打开应答链接照样能连进来');
  assert.equal(w.clock.pending, 0, '三分钟兜底定时器要随换代撤掉');
  assert.equal(w.S.hostId, null);

  // 取消之后候选才收集完：界面归首页，这条应答不再往外交
  w.offer.resolve({ type: 'answer', sdp: 'a' });
  await joining;
  assert.equal(w.dom.actionWrites, writes, '过期的尝试又改了准备页');
  assert.equal(w.shown.at(-1), 'view-home');
});

test('一对一邀请加入：生成应答链接之后「取消」还在，点了不用干等三分钟', async () => {
  const w = manualJoin();
  const joining = w.ctx.joinViaManual(OFFER);
  w.offer.resolve({ type: 'answer', sdp: 'a' });
  await joining;
  const texts = w.dom.actions().map((b) => b.text);
  assert.ok(texts.includes('复制应答链接'), `应答链接没画出来：${texts.join('、')}`);
  assert.ok(texts.includes('取消'), '生成应答后准备页上没有任何离开入口');
  assert.equal(w.clock.pending, 1, '兜底定时器挂着');

  w.dom.button('取消').onclick();
  assert.equal(w.shown.at(-1), 'view-home');
  assert.equal(w.ctx.joinAttempt.busy, null);
  assert.equal(w.clock.pending, 0);
  // 过了三分钟：兜底不能再跳出来改界面
  const title = w.dom.$('prep-title').textContent;
  w.clock.advance(appConst('MANUAL_JOIN_WAIT_TIMEOUT_MS'));
  assert.equal(w.dom.$('prep-title').textContent, title);
});

/* ------------------------- A1-2：首页开房的整页准备 ------------------------- */

function hostPrep({ prepare, addLocalFile } = {}) {
  const closed = [];
  const w = world({
    fns: ['pageReporter', 'startHost'],
    globals: {
      prepareLocalFile: prepare,
      addLocalFile: addLocalFile || (async () => {}),
      trackClosing: (p) => p,
      queueLocalFiles: () => {},
      window: { sw: { store: { close: async (id) => closed.push(id) } } },
    },
  });
  return { ...w, closed };
}

test('首页开房：转封装、算哈希期间一直有「取消」，点了叫停挂着的任务、回首页，不报错', async () => {
  const gate = deferred();
  const stopped = [];
  let reporter = null;
  const w = hostPrep({
    prepare: async (_path, rep) => {
      reporter = rep;
      rep.onCancel(() => stopped.push('tasks.cancel'));
      await gate.promise;
      // 真的 prepareLocalFile 被叫停后收拾干净、返回 null
      return rep.cancelled() ? null : { manifest: { fileId: 'f1' }, state: { sessionId: 's1' }, filePath: 'D:/big.mkv' };
    },
  });
  const hosting = w.ctx.startHost('D:/big.mkv');
  await flush();
  const cancel = w.dom.button('取消');
  assert.ok(cancel, '大文件的哈希要算好几分钟，准备页上得有「取消」');

  cancel.onclick();
  assert.deepEqual(stopped, ['tasks.cancel'], '正在跑的哈希 / 转封装要叫停');
  assert.equal(reporter.cancelled(), true);
  assert.equal(w.shown.at(-1), 'view-home');
  assert.equal(w.S.role, null, '按开房写下的房主身份要拆掉');
  assert.equal(w.ctx.joinAttempt.busy, null, '安全模式的设置要解锁');

  gate.resolve();
  const result = await hosting;
  assert.equal(result.outcome, 'superseded');
  assert.equal(w.shown.at(-1), 'view-home', '取消之后界面又被准备页抢回去了');
  assert.notEqual(w.dom.$('prep-title').textContent, '没法用这个文件', '自己点的取消不该报错');
});

test('首页开房：准备完进入建房那一步就收起「取消」，别拆出半个房间', async () => {
  let actionsAtAdd = null;
  const w = hostPrep({
    prepare: async () => ({ manifest: { fileId: 'f1' }, state: { sessionId: 's1' }, filePath: 'D:/a.mkv' }),
    addLocalFile: async () => {
      actionsAtAdd = w.dom.actions().map((b) => b.text);
    },
  });
  const result = await w.ctx.startHost('D:/a.mkv');
  assert.equal(result.outcome, 'entered');
  assert.deepEqual(actionsAtAdd, [], '建房时还留着「取消」');
});

function linkPrep() {
  const inspect = deferred();
  const added = [];
  const w = world({
    fns: ['startHostLink'],
    globals: {
      window: { sw: { media: { inspectLink: () => inspect.promise } } },
      addLinkItem: async (info) => {
        added.push({ info, actions: w.dom.actions().map((b) => b.text) });
      },
    },
  });
  return { ...w, inspect, added };
}

test('粘贴链接开房：解析期间有「取消」；取消之后解析才回来，不建房、不报错', async () => {
  const w = linkPrep();
  const hosting = w.ctx.startHostLink('https://example.test/watch?v=1');
  const cancel = w.dom.button('取消');
  assert.ok(cancel, '解析最长要等一分钟，没有出路');
  cancel.onclick();
  assert.equal(w.shown.at(-1), 'view-home');
  w.inspect.resolve({ url: 'https://example.test/watch?v=1', title: 'x' });
  await hosting;
  assert.deepEqual(w.added, [], '取消了还是建了房');
  assert.equal(w.dom.$('prep-title').textContent, '正在解析视频链接', '过期的尝试又改了准备页');
});

test('粘贴链接开房：解析完进入建房那一步就收起「取消」', async () => {
  const w = linkPrep();
  const hosting = w.ctx.startHostLink('https://example.test/watch?v=1');
  w.inspect.resolve({ url: 'https://example.test/watch?v=1', title: 'x' });
  await hosting;
  assert.equal(w.added.length, 1);
  assert.deepEqual(w.added[0].actions, []);
});

/* ------------------------- A1-4：信令加入卡在打洞上 ------------------------- */

const ROOM = { k: 'room', url: 'ws://x', room: 'R1', from: 'host-A', securityMode: 'trusted', protocolVersion: 2 };
const WAIT_MS = appConst('SERVER_JOIN_WAIT_TIMEOUT_MS');

function serverJoin({ connect } = {}) {
  const connects = [];
  const w = world({
    fns: ['joinViaServer', 'watchServerJoin', 'serverJoinStuck', 'hostReallyGone'],
    decls: ['SERVER_JOIN_WAIT_TIMEOUT_MS'],
    globals: {
      connectSignaling: async (...args) => {
        connects.push(args);
        if (connect) return connect(...args);
        return { hostId: 'host-A' };
      },
    },
  });
  return { ...w, connects };
}

test('信令加入：连上服务器后两分钟还没进房，准备页给结论、诊断和「重试 / 返回」', async () => {
  const w = serverJoin();
  await w.ctx.joinViaServer(ROOM);
  assert.equal(w.dom.$('prep-note').textContent, '已进入房间，正在和其他成员打洞…');
  // 和房主的那条连接还停在 checking（永远不进 failed）
  w.S.swarm.peers.set('host-A', { peerId: 'host-A', pc: {}, close() {} });

  w.clock.advance(WAIT_MS - 1);
  assert.equal(w.dom.$('prep-note').textContent, '已进入房间，正在和其他成员打洞…', '还没到时限就下了结论');
  w.clock.advance(1);
  assert.equal(w.dom.$('prep-title').textContent, '还没能连上房主');
  assert.match(w.dom.$('prep-note').textContent, /TURN/, '要告诉用户下一步能做什么');
  assert.match(w.dom.$('prep-note').textContent, /诊断：诊断了 host-A/, '候选诊断要画在准备页上，不是只进看不见的日志');
  assert.deepEqual(
    w.dom.actions().map((b) => b.text),
    ['重试', '返回', '复制诊断信息']
  );
  assert.equal(w.ctx.joinAttempt.busy, null, '有了结论：之后再点开的邀请直接接手');
  assert.equal(w.S.swarm.destroyed, false, '结论不拆连接：退避还在跑，晚一点连上照样进房');
});

test('信令加入：还没连上房主他就走了，马上说清楚，不必等兜底', async () => {
  const w = serverJoin();
  await w.ctx.joinViaServer(ROOM);
  // 信令服务器的 peer-leave、或者 hasLeft 之后直连也断了，都经 hostReallyGone('left') 过来
  w.ctx.hostReallyGone('left', { peerId: 'host-A', pc: {} });
  assert.equal(w.dom.$('prep-title').textContent, '房主离开了房间');
  assert.doesNotMatch(w.dom.$('prep-note').textContent, /诊断/, '房主走了不是网络问题，别给打洞诊断');
  assert.equal(w.S.hostGone, false, '还没进房，没有「房主已离开」横幅可改');
  // 兜底定时器随后到期：已经给过结论，不再覆盖
  w.clock.advance(WAIT_MS);
  assert.equal(w.dom.$('prep-title').textContent, '房主离开了房间');
});

test('信令加入：房主那一路退避用尽，给「直连没建立起来」和那条连接的诊断', async () => {
  const w = serverJoin();
  await w.ctx.joinViaServer(ROOM);
  const real = { peerId: 'host-A', pc: {}, close() {} };
  w.S.swarm.peers.set('host-A', real);
  // 信令恢复时补排的重连只带着 { peerId, name }：拿它诊断会说成「一个候选都没收集到」
  w.ctx.hostReallyGone('unreachable', { peerId: 'stub', name: '房主' });
  assert.equal(w.dom.$('prep-title').textContent, '直连没建立起来');
  assert.match(w.dom.$('prep-note').textContent, /诊断：诊断了 host-A/);

  // 连接已经被摘掉、手上只有个空壳：干脆不给诊断
  const w2 = serverJoin();
  await w2.ctx.joinViaServer(ROOM);
  w2.ctx.hostReallyGone('unreachable', { peerId: 'host-A', name: '房主' });
  assert.equal(w2.dom.$('prep-title').textContent, '直连没建立起来');
  assert.doesNotMatch(w2.dom.$('prep-note').textContent, /诊断/);
});

test('信令加入：进了房、点了取消之后，兜底和「房主走了」都不再改准备页', async () => {
  const entered = serverJoin();
  await entered.ctx.joinViaServer(ROOM);
  entered.ctx.roomEntered = true;
  entered.ctx.joinAttempt.busy = null; // enterRoom 做的
  entered.clock.advance(WAIT_MS);
  assert.notEqual(entered.dom.$('prep-title').textContent, '还没能连上房主');
  // 进房之后房主走了：照旧挂横幅
  entered.S.role = 'guest';
  entered.ctx.hostReallyGone('left');
  assert.equal(entered.S.hostGone, true);

  const cancelled = serverJoin();
  await cancelled.ctx.joinViaServer(ROOM);
  cancelled.dom.button('取消').onclick();
  assert.equal(cancelled.clock.pending, 0, '兜底定时器要随换代撤掉');
  const title = cancelled.dom.$('prep-title').textContent;
  cancelled.ctx.hostReallyGone('left');
  assert.equal(cancelled.dom.$('prep-title').textContent, title, '取消之后又被「房主离开」拉回准备页');
  assert.equal(cancelled.shown.at(-1), 'view-home');
});

test('信令加入：结论页点「重试」先拆掉这一次，再用同一份邀请重新加入', async () => {
  const w = serverJoin();
  await w.ctx.joinViaServer(ROOM);
  const firstSwarm = w.S.swarm;
  w.clock.advance(WAIT_MS);
  w.dom.button('重试').onclick();
  await flush();
  assert.ok(firstSwarm.destroyed, '上一次的残局没拆');
  assert.equal(w.connects.length, 2, '重试没有重新连信令');
  assert.deepEqual(w.shown.slice(-2), ['view-home', 'view-prepare']);
  assert.equal(w.S.hostId, 'host-A');
  assert.equal(w.clock.pending, 1, '新的一次重新挂上兜底');
});

test('信令加入：连信令失败的标题是「没能加入房间」，房间已关单独说', async () => {
  const w = serverJoin({
    connect: async () => {
      throw new Error('连不上信令服务器');
    },
  });
  await w.ctx.joinViaServer(ROOM);
  assert.equal(w.dom.$('prep-title').textContent, '没能加入房间');
  assert.equal(w.clock.pending, 0, '没连上信令就不该挂兜底');
});

test('退避用尽 / 信令早说过他离开：scheduleReconnect 把原因和那条连接交给 hostReallyGone', () => {
  const got = [];
  const clock = fakeClock();
  const S = { peerId: 'me', role: 'guest', hostId: 'host-A', swarm: { peers: new Map(), removePeer: () => {} } };
  const ctx = sandbox({
    fns: ['scheduleReconnect', 'cancelRecovery', 'hostReallyGone', 'peerLinked'],
    decls: ['RECONNECT_BACKOFF_MS', 'HANDSHAKE_TIMEOUT_MS', 'RECOVERY', 'isRoomHost'],
    globals: {
      S,
      roomEntered: false,
      joinAttempt: { busy: { onHostGone: (why, peer) => got.push([why, peer.peerId]) } },
      log: () => {},
      connectionAdvice: () => ({ text: '' }),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    },
  });
  const peer = { peerId: 'host-A', name: '房主', initiator: false, closed: false };
  ctx.scheduleReconnect(peer, { hasLeft: (id) => id === 'host-A', connected: true });
  assert.deepEqual(got, [['left', 'host-A']]);

  vm.runInContext("RECOVERY.set('host-A', { attempts: RECONNECT_BACKOFF_MS.length, timer: null, watch: null })", ctx);
  ctx.scheduleReconnect(peer, { hasLeft: () => false, connected: true });
  assert.deepEqual(got.at(-1), ['unreachable', 'host-A']);

  // 信令服务器的 peer-leave 也带上原因
  assert.match(fnSource('connectSignaling'), /if \(peerId === S\.hostId\) hostReallyGone\('left', peer\);/);
});

/* ------------------------- A1-3：离开房间的确认 ------------------------- */

function leaveBox({ role = 'guest', hostId = 'host-A', mode = 'server', connected = 0, sessions = [] } = {}) {
  const dom = fakeDom();
  const modals = [];
  const calls = { leaves: 0 };
  const progress = new Map();
  const S = {
    role,
    peerId: 'me',
    hostId,
    mode,
    leaving: false,
    sessions: new Map(),
    swarm: { files: new Map(), progress: (slot) => progress.get(slot) },
  };
  for (const s of sessions) {
    S.sessions.set(s.fileId, {
      isSeeder: !!s.isSeeder,
      slot: s.slot ?? null,
      manifest: { name: s.name, chunkCount: s.total },
      state: { haveCount: s.stateHave ?? 0, complete: !!s.stateComplete },
    });
    if (s.slot != null) {
      S.swarm.files.set(s.slot, {});
      progress.set(s.slot, { haveCount: s.have, complete: s.have === s.total });
    }
  }
  const ctx = sandbox({
    fns: ['leaveRoomLosses', 'confirmLeaveRoom'],
    decls: ['isRoomHost', 'pct', 'leaveAsk'],
    globals: {
      S,
      $: dom.$,
      make: dom.make,
      connectedPeerCount: () => connected,
      openModal: (options) => {
        const entry = { options, cancel: () => options.onCancel?.() };
        modals.push(entry);
        return entry;
      },
      leaveRoom: () => {
        calls.leaves += 1;
        S.leaving = true;
      },
    },
  });
  const bodyText = (entry) => entry.options.body().map((n) => n.text);
  return { ctx, S, dom, modals, calls, bodyText };
}

test('离开房间：什么都不会丢（收完了、在做种、一片都还没收到、房里没别人）就直接走', () => {
  const r = leaveBox({
    sessions: [
      { fileId: 'a', name: '收完的', slot: 0, have: 10, total: 10 },
      { fileId: 'b', name: '自己的', slot: 1, have: 10, total: 10, isSeeder: true },
      { fileId: 'c', name: '刚开始', slot: 2, have: 0, total: 10 },
    ],
  });
  r.ctx.confirmLeaveRoom();
  assert.equal(r.modals.length, 0);
  assert.equal(r.calls.leaves, 1);
  // 已经在退房：再点一下不重入
  r.ctx.confirmLeaveRoom();
  assert.equal(r.calls.leaves, 1);

  const host = leaveBox({ role: 'host', hostId: 'me', connected: 0 });
  host.ctx.confirmLeaveRoom();
  assert.equal(host.modals.length, 0, '房主一个人时离开不丢什么');
  assert.equal(host.calls.leaves, 1);
});

test('离开房间：有没收完的接收时先确认，列出片名和进度，说清楚没有断点续传', () => {
  const r = leaveBox({
    sessions: [
      { fileId: 'a', name: '大片', slot: 0, have: 60, total: 100 },
      // 还没挂进 swarm（列表还没分配槽位）的，按主进程报的 state 算
      { fileId: 'b', name: '第二部', stateHave: 5, total: 50 },
    ],
  });
  r.ctx.confirmLeaveRoom();
  assert.equal(r.calls.leaves, 0, '没问就把没收完的片丢了');
  assert.equal(r.modals.length, 1);
  const modal = r.modals[0];
  assert.equal(modal.options.title, '要离开房间吗？');
  assert.equal(modal.options.okText, '离开房间');
  const lines = modal.options.body();
  const text = lines.map((n) => n.text);
  assert.ok(text.includes('《大片》 60%'));
  assert.ok(text.includes('《第二部》 10%'));
  // 片名是房主那边来的：原样显示，不参与翻译
  assert.ok(lines.filter((n) => /^《/.test(n.text)).every((n) => n.raw === true));
  assert.ok(text.some((t) => /没有断点续传/.test(t)));

  // 连点：弹着的时候再点不叠第二个框
  r.ctx.confirmLeaveRoom();
  assert.equal(r.modals.length, 1);

  assert.equal(modal.options.onOk(), true);
  assert.equal(r.calls.leaves, 1);
  assert.equal(r.dom.$('btn-leave').disabled, true, '确认之后按钮要禁用，别让人连点');
});

test('离开房间：点「取消」什么都不动，之后还能再问', () => {
  const r = leaveBox({ sessions: [{ fileId: 'a', name: '大片', slot: 0, have: 1, total: 100 }] });
  r.ctx.confirmLeaveRoom();
  r.modals[0].cancel();
  assert.equal(r.calls.leaves, 0);
  r.ctx.confirmLeaveRoom();
  assert.equal(r.modals.length, 2);
});

test('离开房间：房主而房里还有人时先确认，按连接方式说清楚谁会断', () => {
  const star = leaveBox({ role: 'host', hostId: 'me', mode: 'manual', connected: 2 });
  star.ctx.confirmLeaveRoom();
  assert.equal(star.calls.leaves, 0);
  const text = star.bodyText(star.modals[0]);
  assert.ok(text.includes('你是房主，房间里还有 2 个人。'));
  assert.ok(text.some((t) => /所有人一起断开/.test(t)), '一对一邀请是星型：房主一走全房都断');

  const mesh = leaveBox({ role: 'host', hostId: 'me', mode: 'server', connected: 1 });
  mesh.ctx.confirmLeaveRoom();
  assert.ok(mesh.bodyText(mesh.modals[0]).some((t) => /没有房主了/.test(t)));

  // 管理员 / 游客离开不会散场：房里有人也不问
  const guest = leaveBox({ role: 'guest', connected: 3 });
  guest.ctx.confirmLeaveRoom();
  assert.equal(guest.modals.length, 0);
  assert.equal(guest.calls.leaves, 1);
});

test('顶栏「离开房间」接的是带确认的入口；leaveRoom 里的清理顺序不动', () => {
  assert.match(APP, /\$\('btn-leave'\)\.onclick = confirmLeaveRoom;/);
  assert.doesNotMatch(APP, /\$\('btn-leave'\)\.onclick = leaveRoom;/);
});

/* ------------------------- A1-6：加入失败的标题 ------------------------- */

test('加入失败的标题是「没能加入房间」，「没法用这个文件」只留给开房准备文件', () => {
  const w = world();
  w.ctx.joinFail('找不到房主');
  assert.equal(w.dom.$('prep-title').textContent, '没能加入房间');
  assert.equal(w.dom.$('prep-note').textContent, '找不到房主');
  w.ctx.prepFail('这个格式不支持');
  assert.equal(w.dom.$('prep-title').textContent, '没法用这个文件');

  for (const name of ['joinViaManual', 'joinViaServer', 'joinViaRelay', 'removedFromRoom', 'watchServerJoin', 'serverJoinStuck']) {
    assert.doesNotMatch(fnSource(name), /prepFail\(/, `${name} 还在用「没法用这个文件」当标题`);
  }
  // 加入者在准备页上遇到的模式不符、版本不符
  const init = fnSource('initSwarmAndSync');
  const mode = init.slice(init.indexOf("S.swarm.on('mode-mismatch'"), init.indexOf("S.swarm.on('version-mismatch'"));
  assert.match(mode, /joinFail\(/);
  const version = init.slice(init.indexOf("S.swarm.on('version-mismatch'"), init.indexOf("S.swarm.on('complete'"));
  assert.match(version, /joinFail\(message\)/);
  // 开房那一路照旧
  assert.match(fnSource('startHost'), /prepFail\(message\)/);
});

/* ------------------------- A1-8：房间里点开应答链接 ------------------------- */

function inviteInRoom(role) {
  const calls = { answers: [], logs: [], modals: 0, leaves: 0 };
  const ctx = sandbox({
    fns: ['openInviteLink', 'routeInviteLink', 'reportInviteError', 'joiningWith', 'inviteKey'],
    decls: ['INVITE_LINK_GAP_MS', 'inviteLinks'],
    globals: {
      S: { role, hostId: role === 'host' ? 'me' : 'host-A', peerId: 'me', pendingManualPeer: null, leaving: false },
      roomEntered: true,
      joinAttempt: { gen: 1, busy: null, cleanups: [] },
      $: fakeDom().$,
      log: (text, tone) => calls.logs.push([text, tone]),
      decodeCode: async (raw) => JSON.parse(raw),
      acceptManualAnswer: async (raw) => calls.answers.push(raw),
      askSwitchForInvite: () => (calls.modals += 1),
      leaveRoom: async () => (calls.leaves += 1),
      delay: () => Promise.resolve(),
    },
  });
  return { ctx, calls };
}

const ANSWER = JSON.stringify({ k: 'answer', from: 'guest-1', sdp: { type: 'answer', sdp: 'v=0' }, securityMode: 'trusted', protocolVersion: 2 });

test('房主在房间里又点了一次用过的应答链接：交给 acceptManualAnswer 说「已用过」，不叫人退房', async () => {
  const r = inviteInRoom('host');
  await r.ctx.openInviteLink(ANSWER);
  assert.deepEqual(r.calls.answers, [ANSWER]);
  assert.ok(!r.calls.logs.some(([t]) => /退出当前房间/.test(t)), '房主照做就把整场散了');
  assert.equal(r.calls.modals + r.calls.leaves, 0);
});

test('观众在房间里点开自己复制的应答链接：说这该由发起方打开', async () => {
  const r = inviteInRoom('guest');
  await r.ctx.openInviteLink(ANSWER);
  assert.deepEqual(r.calls.answers, []);
  assert.deepEqual(r.calls.logs, [['这是一个应答链接，应该由发起方打开。', 'warn']]);
});

/* ------------------------- GG2-5：启动检查期间的深链接 ------------------------- */

test('启动检查跑完之前来的深链接先存着（只留最新一条），跑完再打开；之后来的直接打开', () => {
  const opened = [];
  const box = () =>
    sandbox({
      fns: ['onDeepLinkArrived', 'releaseBootLinks'],
      decls: ['bootLinks'],
      globals: { openInviteLink: (raw) => opened.push(raw) },
    });
  const ctx = box();
  ctx.onDeepLinkArrived('noxreel://j/first');
  ctx.onDeepLinkArrived('noxreel://j/second');
  ctx.onDeepLinkArrived('');
  assert.deepEqual(opened, [], '启动页背后就开始加入了，随后被 show(view-home) 盖掉');
  // 最新优先：启动期间点开的 > 冷启动带来的 > 退房前记下的
  assert.equal(ctx.releaseBootLinks('noxreel://j/cold', 'noxreel://j/stashed'), 'noxreel://j/second');
  ctx.onDeepLinkArrived('noxreel://j/later');
  assert.deepEqual(opened, ['noxreel://j/later']);

  const cold = box();
  assert.equal(cold.releaseBootLinks('noxreel://j/cold', 'noxreel://j/stashed'), 'noxreel://j/cold');
  const stashed = box();
  assert.equal(stashed.releaseBootLinks(null, 'noxreel://j/stashed'), 'noxreel://j/stashed');
  const none = box();
  assert.equal(none.releaseBootLinks(null, null), null);

  assert.match(APP, /window\.sw\.app\.onDeepLink\(onDeepLinkArrived\);/);
  assert.doesNotMatch(APP, /onDeepLink\(openInviteLink\)/);
});

/* ------------------------- C2-8：安全模式对不上 ------------------------- */

test('安全模式对不上：三种加入都说「改完点加入重试」，不叫人回去重新打开链接', async () => {
  const w = world({ securityMode: 'trusted' });
  assert.equal(
    w.ctx.modeMismatchText('safe'),
    '房间使用安全模式，你的本机设置是可信房间。请在设置里切换为相同模式，再点「加入」重试。'
  );
  for (const name of ['joinViaManual', 'joinViaServer', 'joinViaRelay']) {
    assert.match(fnSource(name), /\$\('join-err'\)\.textContent = modeMismatchText\(inviteMode\);/, name);
  }
  assert.doesNotMatch(APP, /再重新打开房间链接|再重新粘贴邀请码/);

  // 真走一遍：不开始尝试、不建连接
  const server = serverJoin();
  server.S.settings.securityMode = 'safe';
  await server.ctx.joinViaServer(ROOM);
  assert.match(server.dom.$('join-err').textContent, /再点「加入」重试。$/);
  assert.equal(server.connects.length, 0);
  assert.equal(server.ctx.joinAttempt.busy, null);
});

/* ------------------------------ 英文界面 ------------------------------ */

test('这一批的新文案都有英文', async () => {
  const { translate } = await load('src/renderer/lib/i18n.js');
  const en = (s) => translate(s, 'en');
  const fixed = [
    '没能加入房间',
    '房主离开了房间',
    '还没和房主连上，信令服务器就说他离开了。他只是掉线的话，回来后会自动接着连；否则请让房主重新发一条邀请。',
    '和房主的直连试了几次都没打通，多半是双方都在严格 NAT 后面。双方在设置里配同一个 TURN 中继后，再点「重试」。',
    '等了两分钟还是没和房间里的人连上。多半是打洞没成功：双方都在严格 NAT 后面时，需要各自在设置里配同一个 TURN 中继。也可能是房主那边的网络断了。',
    '要离开房间吗？',
    '这几部片还没收完：',
    '离开后接收就停了。没有断点续传：没收完的片一般不会保留，下次进房要重新下载。',
    '他们都是经一对一邀请连到你这里的：你一走，所有人一起断开，这一场就结束了。',
    '你一走这一场就没有房主了：播放列表停止更新，经一对一邀请进来的人会直接断开。',
  ];
  for (const line of fixed) assert.notEqual(en(line), line, `没有英文：${line}`);
  assert.equal(en('没能加入房间'), 'Could not join the room');
  assert.equal(en('你是房主，房间里还有 1 个人。'), 'You are the host, and 1 other person is in the room.');
  assert.equal(en('你是房主，房间里还有 3 个人。'), 'You are the host, and 3 other people are in the room.');
  assert.equal(
    en('房间使用Safe mode，你的本机设置是Trusted room。请在设置里切换为相同模式，再点「加入」重试。'),
    'The room uses Safe mode, while your local setting is Trusted room. Switch to the same mode in Settings, then select “Join” to try again.'
  );
  // 诊断单独一行，照已有的「诊断：」模板翻
  assert.match(en('诊断：本机一个网络候选地址都没收集到 —— 通常是网络被完全隔离，或者防火墙拦掉了 NoxReel。'), /^Diagnosis: /);
  // 用到的现成按钮和标题
  for (const line of ['取消', '重试', '返回', '离开房间', '直连没建立起来', '还没能连上房主']) assert.notEqual(en(line), line);
});
