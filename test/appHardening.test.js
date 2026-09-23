'use strict';

// 编排层（app.js）的加入流程收尾、并发加入、深链接、信令刷屏和界面重画的几处加固（0.7.5）。
//
// app.js 是整页的编排脚本，没法整个在 Node 里跑。这里照 roomFlowFixes / roomLinkFixes 的做法，
// 把涉及的顶层函数和常量原样抠出来放进 vm 沙箱，周围配上假信令、假连接、假 DOM，
// 同步引擎用真的 —— 测的是仓库里真实的函数体。全程不启动播放器、不联网、不出声。
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

/** app.js 顶层函数的源码：从声明行到下一个顶格的 `}`。 */
function fnSource(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层函数 ${name}`);
  const end = APP.indexOf('\n}\n', m.index);
  assert.ok(end > m.index, `${name} 的结尾没找到`);
  return APP.slice(m.index, end + 2);
}

/** app.js 顶层的单行 const / let 声明，原样搬进沙箱（常量值不在测试里另抄一份）。 */
function declSource(name) {
  const m = new RegExp(`^(?:const|let) ${name} = [^\\n]*;$`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层声明 ${name}`);
  return m[0];
}

function appConst(name) {
  const m = new RegExp(`^const ${name} = ([\\d_ *]+);`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到常量 ${name}`);
  return Function(`return (${m[1]});`)();
}

/**
 * 建连接之前那道 TURN 关口（0.7.6 IP 隐私）的默认替身：来源是「自己填」、没开「隐藏我的 IP」——
 * 不用现取 Cloudflare 账号，也不拦。这几个函数本身的行为在 ipPrivacy.test.js 里测。
 */
const TURN_GATE_OPEN = {
  turnFetchNeeded: () => false,
  ensureTurnReady: async () => {},
  relayOnlyBlocked: () => '',
  inviteBlocked: () => false,
  peerIce: () => ({ iceServers: [], iceTransportPolicy: 'all' }),
  signalPeerIce: () => ({ iceServers: [], iceTransportPolicy: 'all' }),
};

function sandbox({ fns = [], decls = [], globals = {} }) {
  const ctx = { console, inviteGen: 0, ...TURN_GATE_OPEN, ...globals };
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

/** 手动拨的定时器：测合并重画时要能数出排了几个、什么时候跑。 */
function fakeTimers() {
  const queue = new Map();
  let id = 0;
  return {
    setTimeout: (fn, ms) => {
      id += 1;
      queue.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (h) => queue.delete(h),
    get size() {
      return queue.size;
    },
    runAll() {
      for (const [h, t] of [...queue]) {
        queue.delete(h);
        t.fn();
      }
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

function fakeDollar() {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, { id, textContent: '', value: '', style: {}, onclick: null, classList: { add() {}, remove() {}, toggle() {} } });
    return els.get(id);
  };
  return $;
}

/* ------------------------------ 假信令和假连接 ------------------------------ */

function signalingClasses(made) {
  class FakeSig {
    constructor(o, kind) {
      this.o = o;
      this.kind = kind;
      this.handlers = new Map();
      this.closed = false;
      this.connected = true;
      this.signals = [];
      this.pending = deferred();
      made.push(this);
    }
    on(ev, fn) {
      if (!this.handlers.has(ev)) this.handlers.set(ev, []);
      this.handlers.get(ev).push(fn);
      return () => {};
    }
    emit(ev, payload) {
      return Promise.all((this.handlers.get(ev) || []).map((fn) => fn(payload)));
    }
    connect() {
      return this.pending.promise;
    }
    close() {
      this.closed = true;
    }
    signal(to, payload) {
      this.signals.push([to, payload]);
    }
    setMaxMembers() {}
  }
  class FakeRelay extends FakeSig {
    constructor(o) {
      super(o, 'relay');
      this.trickle = false;
    }
  }
  class FakeWs extends FakeSig {
    constructor(o) {
      super(o, 'ws');
    }
  }
  return { FakeRelay, FakeWs };
}

function peerClass(made) {
  return class FakePeer {
    constructor(o) {
      Object.assign(this, o);
      this.closed = false;
      this.authenticated = false;
      this.ctrl = { readyState: 'connecting' };
      made.push(this);
    }
    on() {
      return () => {};
    }
    async createOffer() {
      return { type: 'offer', sdp: 'o' };
    }
    async acceptOffer() {
      return { type: 'answer', sdp: 'a' };
    }
    async acceptAnswer() {}
    async addIceCandidate() {}
    close() {
      this.closed = true;
    }
  };
}

async function swarmClass() {
  const { Emitter } = await load('src/renderer/lib/emitter.js');
  const built = [];
  class FakeSwarm extends Emitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this.securityMode = opts.securityMode;
      this.peers = new Map();
      this.versionRejected = new Set();
      this.files = new Map();
      this.playingSlot = null;
      this.destroyed = false;
      built.push(this);
    }
    start() {}
    addPeer(peer) {
      const prev = this.peers.get(peer.peerId);
      if (prev && prev !== peer) this.removePeer(peer.peerId);
      this.peers.set(peer.peerId, peer);
    }
    removePeer(id) {
      const p = this.peers.get(id);
      if (!p) return;
      this.peers.delete(id);
      p.close();
    }
    peerList() {
      return [...this.peers.values()];
    }
    destroy() {
      this.destroyed = true;
      for (const p of this.peers.values()) p.close();
      this.peers.clear();
      this.removeAll();
    }
  }
  return { FakeSwarm, built };
}

/* ------------------------- 一整套「首页 → 加入 / 开房」 ------------------------- */

const ATTEMPT_FNS = [
  'beginAttempt',
  'resetAttempt',
  'attemptLive',
  'endAttempt',
  'joiningWith',
  'inviteKey',
  'backHome',
  'prepFail',
  'prepStop',
  'hint',
  'cancelJoinButton',
  'storedCapacity',
  'cancelRecovery',
  'initSwarmAndSync',
  'joinViaRelay',
  'joinViaServer',
  'relayJoinError',
  'inviteFileLine',
  'connectSignaling',
  'directLinkUp',
  'admitPeer',
  'allowRebuild',
  'sigLog',
  'customRelays',
  'relayList',
  'startHost',
  'pageReporter',
];
const ATTEMPT_DECLS = [
  'clampCapacity',
  'normalizeSecurityMode',
  'MAX_PEER_NAME',
  'peerName',
  'MAX_LIVE_PEERS',
  'REBUILD_BURST',
  'REBUILD_REFILL_MS',
  'rebuildBudget',
  'peerCapWarned',
  'SIG_LOG_WINDOW_MS',
  'SIG_LOG_MAX',
  'sigLogBudget',
  'RECOVERY',
  'RENEGOTIATING',
];

async function lobby({ securityMode = 'trusted', capacity = '4' } = {}) {
  const { SyncEngine } = await load('src/renderer/lib/syncEngine.js');
  const { FakeSwarm, built } = await swarmClass();
  const sigs = [];
  const { FakeRelay, FakeWs } = signalingClasses(sigs);
  const peers = [];
  const calls = { fail: [], shown: [], closedSessions: [], logs: [] };
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
    roomCapacity: Number(capacity),
    roomSecurityMode: null,
    pendingManualPeer: null,
    isSeeder: false,
    leaving: false,
    settings: { securityMode, relays: '', signalUrl: 'ws://localhost:8080' },
  };
  const $ = fakeDollar();
  const ctx = sandbox({
    fns: ATTEMPT_FNS,
    decls: ATTEMPT_DECLS,
    globals: {
      S,
      $,
      roomEntered: false,
      joinAttempt: { gen: 0, busy: null, cleanups: [] },
      localStorage: fakeStorage({ 'sw.roomCapacity': capacity }),
      make: (tag, o = {}, kids = []) => ({ tag, ...o, kids }),
      replace: () => {},
      show: (view) => calls.shown.push(view),
      setSteps: () => {},
      log: (text, tone) => calls.logs.push([text, tone]),
      fmtBytes: (n) => `${n} B`,
      securityModeLabel: (m) => (m === 'trusted' ? '可信房间' : '安全模式'),
      inviteVersionText: () => '版本不对',
      PROTOCOL_VERSION: 2,
      DEFAULT_RELAYS: ['wss://default.example'],
      Swarm: FakeSwarm,
      SyncEngine,
      RelaySignaling: FakeRelay,
      WsSignaling: FakeWs,
      Peer: peerClass(peers),
      wirePeer: () => {},
      iceServers: () => [],
      connectedPeerCount: () => 0,
      renderCapacityStatus: () => {},
      refreshRoomLink: async () => {},
      hostReallyGone: () => {},
      reconnectPeer: async () => {},
      renderPeersSoon: () => {},
      renderStatus: () => {},
      renderDrift: () => {},
      queueLocalFiles: () => {},
      trackClosing: (p) => p,
      prepareLocalFile: async () => ({ manifest: { fileId: 'f1' }, state: { sessionId: 's1' }, filePath: 'D:/a.mkv' }),
      window: { sw: { player: {}, store: { close: async (id) => calls.closedSessions.push(id) } } },
    },
  });
  // 开房的后半段：真实的 addLocalFile 会先建引擎再提交列表、进房，这里只保留建引擎这一步
  ctx.addLocalFile = async () => ctx.initSwarmAndSync();
  const origFail = ctx.prepFail;
  ctx.prepFail = (msg, extra) => {
    calls.fail.push(msg);
    return origFail(msg, extra);
  };
  return { ctx, S, $, sigs, peers, calls, swarms: built };
}

const LINK_A = { k: 'relay', key: 'K'.repeat(43), hk: 'a'.repeat(64), from: 'host-A', maxMembers: 16, securityMode: 'trusted', relays: null, protocolVersion: 2 };
const LINK_B = { ...LINK_A, key: 'Q'.repeat(43), hk: 'b'.repeat(64), from: 'host-B' };
const offline = () => Object.assign(new Error('找不到房主'), { code: 'HOST_OFFLINE' });

test('加入失败回到首页后自己开房：引擎按自己是房主重建，能控场', async () => {
  const r = await lobby();
  const joining = r.ctx.joinViaRelay(LINK_A);
  const oldSync = r.S.sync;
  const oldSwarm = r.S.swarm;
  assert.equal(oldSync.hostId, 'host-A');
  r.sigs[0].pending.reject(offline());
  await joining;
  assert.equal(r.calls.fail.length, 1, '找不到房主要说出来');

  // 点「返回」，再自己选片开房
  r.ctx.backHome();
  assert.equal(r.S.swarm, null, '没进成房的 Swarm 要拆掉');
  assert.equal(r.S.sync, null);
  assert.equal(r.S.hostId, null);
  assert.equal(r.S.roomCapacity, 4, '加入时按邀请改成 16 的人数上限要退回自己的默认值');
  assert.ok(oldSwarm.destroyed);
  assert.ok(r.sigs[0].closed);

  const result = await r.ctx.startHost('D:/a.mkv');
  assert.equal(result.outcome, 'entered');
  assert.notEqual(r.S.sync, oldSync, '得是新建的同步引擎');
  assert.equal(r.S.sync.hostId, 'me-peer');
  assert.equal(r.S.sync.myRole(), 'host', '房主本人在引擎里不能是游客');
  assert.equal(r.S.sync.canIControl(), true);
});

test('加入失败后不点返回，直接加入另一个房间：角色权威换成新房主', async () => {
  const r = await lobby();
  const first = r.ctx.joinViaRelay(LINK_A);
  r.sigs[0].pending.reject(offline());
  await first;

  const second = r.ctx.joinViaRelay(LINK_B);
  r.sigs[1].pending.resolve({ hostId: 'host-B', maxMembers: 16 });
  await second;
  assert.equal(r.S.sync.hostId, 'host-B', '新房主的 ROLE / SYNC 才不会被当成冒名丢掉');
  assert.equal(r.S.sync.roleOf('host-B'), 'host');
  assert.equal(r.S.signaling, r.sigs[1]);
  assert.equal(r.swarms.length, 2);
  assert.ok(r.swarms[0].destroyed);
});

test('加入失败后改了安全模式再开房：HELLO 用的是新模式', async () => {
  const r = await lobby({ securityMode: 'safe' });
  const joining = r.ctx.joinViaRelay({ ...LINK_A, securityMode: 'safe' });
  r.sigs[0].pending.reject(offline());
  await joining;
  assert.equal(r.S.swarm.securityMode, 'safe');

  r.S.settings.securityMode = 'trusted';
  await r.ctx.startHost('D:/a.mkv');
  assert.equal(r.S.swarm.securityMode, 'trusted', '邀请码写的是可信房间，HELLO 也必须是');
  assert.equal(r.S.roomSecurityMode, 'trusted');
});

test('没进成房的一对一连接和重连定时器随换代一起收掉', async () => {
  const r = await lobby();
  const joining = r.ctx.joinViaRelay(LINK_A);
  // 模拟一对一加入时留在 swarm 里、还在打洞的那条连接，和一个排着的重连
  const stray = { peerId: 'host-A', closed: false, close() { this.closed = true; } };
  r.S.swarm.peers.set('host-A', stray);
  const timers = fakeTimers();
  r.ctx.clearTimeout = timers.clearTimeout;
  vm.runInContext("RECOVERY.set('host-A', { attempts: 1, timer: 7 })", r.ctx);
  let cleaned = 0;
  r.ctx.joinAttempt.cleanups.push(() => cleaned++);
  r.sigs[0].pending.reject(offline());
  await joining;
  r.ctx.backHome();
  assert.ok(stray.closed, '留着它，对方事后打开应答链接就能连进来控场');
  assert.equal(vm.runInContext('RECOVERY.size', r.ctx), 0);
  assert.equal(cleaned, 1, '挂在这次尝试上的定时器要撤掉');
});

test('并发加入：先失败的那次不能关掉后来成功的信令，也不能盖掉界面', async () => {
  const r = await lobby();
  const first = r.ctx.joinViaRelay(LINK_A);
  const second = r.ctx.joinViaRelay(LINK_B);
  const [sigA, sigB] = r.sigs;
  assert.ok(sigA.closed, '开始新的加入之前旧的信令要先关掉');
  sigB.pending.resolve({ hostId: 'host-B' });
  await second;
  const shownBefore = r.calls.shown.length;
  // 旧的那条这时才超时
  sigA.pending.reject(offline());
  await first;
  assert.equal(r.S.signaling, sigB, '后来成功的信令被先失败的那次置空了');
  assert.equal(sigB.closed, false);
  assert.deepEqual(r.calls.fail, [], '过期的失败不能用「找不到房主」盖掉界面');
  assert.equal(r.calls.shown.length, shownBefore);
  assert.equal(r.S.hostId, 'host-B');
});

test('被顶替的信令上迟到的事件一律不认', async () => {
  const r = await lobby();
  const first = r.ctx.joinViaRelay(LINK_A);
  const second = r.ctx.joinViaRelay(LINK_B);
  const [sigA, sigB] = r.sigs;
  sigB.pending.resolve({ hostId: 'host-B' });
  await second;
  // 旧信令关闭前还收到了一条 peer-join 和一条 offer
  await sigA.emit('peer-join', { peerId: 'old-room-member', name: 'X' });
  await sigA.emit('signal', { from: 'old-room-member', name: 'X', payload: { kind: 'offer', sdp: {} } });
  assert.equal(r.S.swarm.peers.size, 0, '上一个房间的人被塞进了这一个房间');
  assert.equal(r.peers.length, 0);
  sigA.pending.reject(offline());
  await first;
});

test('同一条邀请连点两次：不重来一遍', async () => {
  const r = await lobby();
  r.ctx.joinViaRelay(LINK_A);
  r.ctx.joinViaRelay(LINK_A);
  assert.equal(r.sigs.length, 1, '同一条链接点两次，第二次把第一次拆了重连');
  assert.equal(r.sigs[0].closed, false);
});

test('等房主放行时准备页上有「取消」，点了就把这次加入拆干净', async () => {
  const r = await lobby();
  const replaced = [];
  r.ctx.replace = (target, ...nodes) => replaced.push([target, nodes]);
  const joining = r.ctx.joinViaRelay(LINK_A);
  const actions = replaced.find(([target]) => target === 'prep-actions');
  assert.ok(actions, '等房主放行最长半分钟，没有别的出路');
  const cancel = actions[1][0];
  assert.equal(cancel.text, '取消');
  cancel.onclick();
  assert.ok(r.sigs[0].closed);
  assert.equal(r.S.swarm, null);
  r.sigs[0].pending.reject(Object.assign(new Error('已取消'), { code: 'CLOSED' }));
  await joining;
  assert.deepEqual(r.calls.fail, [], '自己点的取消不该再报一次错');
});

test('开房准备到一半被换成了加入：算到一半的任务叫停，开好的会话关掉，不再报错', async () => {
  const r = await lobby();
  const gate = deferred();
  let reporter = null;
  let cancelled = 0;
  r.ctx.prepareLocalFile = async (_path, rep) => {
    reporter = rep;
    rep.onCancel(() => cancelled++);
    return gate.promise;
  };
  const hosting = r.ctx.startHost('D:/big.mkv');
  await flush();
  assert.equal(r.ctx.joinAttempt.busy.kind, 'host');
  assert.equal(reporter.cancelled(), false);
  // 用户在「要放弃正在准备的放映吗？」里点了确定
  r.ctx.resetAttempt();
  assert.equal(cancelled, 1, '正在算的哈希要叫停');
  assert.equal(reporter.cancelled(), true);
  gate.resolve({ manifest: { fileId: 'f9' }, state: { sessionId: 'sess-9' }, filePath: 'D:/big.mkv' });
  const result = await hosting;
  assert.equal(result.outcome, 'superseded');
  assert.deepEqual(r.calls.closedSessions, ['sess-9'], '已经开好的做种会话没人要了，要关掉');
  assert.deepEqual(r.calls.fail, []);
});

test('首页多选时第一部被换代叫停：不接着拿下一部开房，也不报错', async () => {
  const calls = [];
  const ctx = sandbox({
    fns: ['startHostMany'],
    globals: {
      startHost: async (p) => {
        calls.push(p);
        return { outcome: 'superseded' };
      },
      queueLocalFiles: () => calls.push('queue'),
      prepFail: () => calls.push('fail'),
      prepStop: () => calls.push('stop'),
      baseName: (p) => p,
    },
  });
  await ctx.startHostMany(['a', 'b']);
  assert.deepEqual(calls, ['a']);
});

/* ------------------------------ 深链接 ------------------------------ */

function inviteRoom({ inRoom = true, busy = null, hostId = 'host-A' } = {}) {
  const calls = { modals: [], logs: [], joins: [], resets: 0, leaves: 0, decodes: 0, shown: [] };
  const storage = fakeStorage();
  const joinAttempt = { gen: 1, busy, cleanups: [] };
  const ctx = sandbox({
    fns: ['openInviteLink', 'routeInviteLink', 'reportInviteError', 'askSwitchForInvite', 'stashInvite', 'takeStashedInvite', 'joiningWith', 'inviteKey'],
    decls: ['INVITE_LINK_GAP_MS', 'INVITE_STASH_KEY', 'inviteLinks'],
    globals: {
      S: { role: inRoom ? 'guest' : null, hostId, peerId: 'me', pendingManualPeer: null, leaving: false },
      roomEntered: inRoom,
      joinAttempt,
      sessionStorage: storage,
      $: fakeDollar(),
      make: (tag, o = {}) => ({ tag, ...o }),
      show: (v) => calls.shown.push(v),
      log: (text, tone) => calls.logs.push([text, tone]),
      decodeCode: async (raw) => {
        calls.decodes += 1;
        return JSON.parse(raw);
      },
      acceptManualAnswer: async () => {},
      openModal: (options) => {
        calls.modals.push(options);
        return { done: Promise.resolve(true), cancel() {} };
      },
      leaveRoom: async () => {
        calls.leaves += 1;
      },
      resetAttempt: () => {
        calls.resets += 1;
        joinAttempt.busy = null;
        joinAttempt.gen += 1;
      },
      handleJoinInput: async (raw) => {
        calls.joins.push(raw);
      },
      delay: () => Promise.resolve(),
    },
  });
  return { ctx, calls, storage, joinAttempt };
}

const link = (payload) => JSON.stringify(payload);

test('房间里收到别的房间的邀请：先问，不静默拆掉当前房间；刷屏也只弹一个框', async () => {
  const r = inviteRoom();
  for (let i = 0; i < 5; i++) await r.ctx.openInviteLink(link({ ...LINK_B, key: `k${i}` }));
  await flush();
  assert.equal(r.calls.modals.length, 1, '五条链接叠出了五个框');
  assert.equal(r.calls.leaves, 0, '没问就把人拖出了房间');
  assert.equal(r.calls.joins.length, 0);
  const modal = r.calls.modals[0];
  assert.equal(modal.title, '要离开当前房间吗？');
  assert.equal(modal.okText, '离开并加入');

  modal.onOk();
  assert.equal(r.calls.leaves, 1);
  assert.equal(JSON.parse(r.storage.getItem('sw.pendingInvite')).key, 'k4', '刷新之后打开的得是最新那条');
  // 刷新之后取出来就清掉，不会每次启动都再进一次
  assert.equal(JSON.parse(r.ctx.takeStashedInvite()).key, 'k4');
  assert.equal(r.ctx.takeStashedInvite(), null);
});

test('房间里点「留在当前房间」：什么都不动，下一条邀请还会再问', async () => {
  const r = inviteRoom();
  await r.ctx.openInviteLink(link(LINK_B));
  r.calls.modals[0].onCancel();
  assert.equal(r.calls.leaves, 0);
  await r.ctx.openInviteLink(link({ ...LINK_B, key: 'again' }));
  assert.equal(r.calls.modals.length, 2);
});

test('房间里点开的是本房间的链接：说一声就好，不弹框', async () => {
  const r = inviteRoom();
  await r.ctx.openInviteLink(link(LINK_A));
  assert.equal(r.calls.modals.length, 0);
  assert.deepEqual(r.calls.logs.map(([t]) => t), ['你已经在这个房间里了。']);
});

test('加入进行中点开另一条邀请：先干净地取消旧的，再开始新的；同一条不重来', async () => {
  const same = inviteRoom({ inRoom: false, busy: { gen: 1, kind: 'join', key: `relay|host-A|${LINK_A.key}` } });
  await same.ctx.openInviteLink(link(LINK_A));
  assert.equal(same.calls.resets, 0);
  assert.equal(same.calls.joins.length, 0, '同一条邀请点两次，把正在等放行的那次拆了');
  assert.deepEqual(same.calls.shown, ['view-prepare']);

  const other = inviteRoom({ inRoom: false, busy: { gen: 1, kind: 'join', key: `relay|host-A|${LINK_A.key}` } });
  await other.ctx.openInviteLink(link(LINK_B));
  assert.equal(other.calls.resets, 1, '旧的加入没取消就开始了新的');
  assert.deepEqual(other.calls.joins, [link(LINK_B)]);
});

test('开房准备到一半点开邀请：先问；确定之后拆掉准备、接着加入', async () => {
  const r = inviteRoom({ inRoom: false, busy: { gen: 1, kind: 'host', key: '' } });
  await r.ctx.openInviteLink(link(LINK_B));
  assert.equal(r.calls.modals.length, 1);
  assert.equal(r.calls.modals[0].title, '要放弃正在准备的放映吗？');
  assert.equal(r.calls.joins.length, 0);
  r.calls.modals[0].onOk();
  await flush();
  assert.ok(r.calls.resets >= 1);
  assert.deepEqual(r.calls.joins, [link(LINK_B)]);
});

test('深链接洪水：处理期间来的只留最新一条，解码和加入都不跟着翻倍', async () => {
  const r = inviteRoom({ inRoom: false });
  const all = [];
  for (let i = 0; i < 200; i++) all.push(r.ctx.openInviteLink(link({ ...LINK_B, key: `k${i}` })));
  await Promise.all(all);
  await flush();
  assert.ok(r.calls.decodes <= 2, `解了 ${r.calls.decodes} 次`);
  assert.ok(r.calls.joins.length <= 2, `开始了 ${r.calls.joins.length} 次加入`);
  assert.equal(JSON.parse(r.calls.joins[r.calls.joins.length - 1]).key, 'k199', '最后打开的得是最新那条');
});

test('正在退房时来的邀请记下来，刷新后接着开', async () => {
  const r = inviteRoom();
  r.ctx.S.leaving = true;
  await r.ctx.openInviteLink(link(LINK_B));
  assert.equal(r.calls.modals.length, 0);
  assert.equal(JSON.parse(r.storage.getItem('sw.pendingInvite')).from, 'host-B');
  assert.match(APP, /const stashed = takeStashedInvite\(\);\s*const initialLink = \(await window\.sw\.app\.takeDeepLink\(\)\) \|\| stashed;/);
});

/* --------------------------- 信令重连与刷屏 --------------------------- */

async function signalRoom() {
  const { FakeSwarm } = await swarmClass();
  const sigs = [];
  const { FakeRelay, FakeWs } = signalingClasses(sigs);
  const peers = [];
  const logs = [];
  const S = {
    peerId: 'me',
    name: '我',
    role: 'guest',
    hostId: 'host-A',
    roomCapacity: 4,
    settings: { relays: '' },
    swarm: new FakeSwarm({ securityMode: 'trusted' }),
    signaling: null,
  };
  const ctx = sandbox({
    fns: ['connectSignaling', 'directLinkUp', 'admitPeer', 'allowRebuild', 'sigLog', 'cancelRecovery', 'customRelays', 'relayList'],
    decls: ['MAX_PEER_NAME', 'peerName', 'MAX_LIVE_PEERS', 'REBUILD_BURST', 'REBUILD_REFILL_MS', 'rebuildBudget', 'peerCapWarned', 'SIG_LOG_WINDOW_MS', 'SIG_LOG_MAX', 'sigLogBudget', 'RECOVERY', 'clampCapacity'],
    globals: {
      S,
      log: (text, tone) => logs.push([text, tone]),
      Peer: peerClass(peers),
      wirePeer: () => {},
      iceServers: () => [],
      RelaySignaling: FakeRelay,
      WsSignaling: FakeWs,
      DEFAULT_RELAYS: [],
      PROTOCOL_VERSION: 2,
      connectedPeerCount: () => 0,
      renderCapacityStatus: () => {},
      refreshRoomLink: async () => {},
      hostReallyGone: () => {},
      reconnectPeer: async () => {},
    },
  });
  const connecting = ctx.connectSignaling('ws://x', 'room');
  sigs[0].pending.resolve({ hostId: 'host-A' });
  await connecting;
  return { ctx, S, sig: sigs[0], peers, logs };
}

test('成员的信令重连触发 peer-join：直连还通着就留着，不拆掉重建', async () => {
  const r = await signalRoom();
  const healthy = { peerId: 'm1', name: 'Alice', closed: false, ctrl: { readyState: 'open' }, close() { this.closed = true; } };
  r.S.swarm.peers.set('m1', healthy);
  await r.sig.emit('peer-join', { peerId: 'm1', name: 'Alice' });
  assert.equal(r.S.swarm.peers.get('m1'), healthy, '健康的直连被换掉了');
  assert.equal(healthy.closed, false);
  assert.equal(r.peers.length, 0);
  assert.equal(r.sig.signals.length, 0, '不该再发 offer');

  // 数据通道还挂着 open、ICE 却已经掉线（对方整个网络断过一阵）：趁这次 peer-join 马上重建
  const stale = { peerId: 'm2', name: 'Bob', closed: false, ctrl: { readyState: 'open' }, pc: { iceConnectionState: 'disconnected' }, close() { this.closed = true; } };
  r.S.swarm.peers.set('m2', stale);
  await r.sig.emit('peer-join', { peerId: 'm2', name: 'Bob' });
  assert.ok(stale.closed);
  assert.equal(r.peers.length, 1);
  r.peers.length = 0;
  r.sig.signals.length = 0;

  // 直连已经断了的，照旧由老成员重新发起
  healthy.ctrl.readyState = 'closed';
  await r.sig.emit('peer-join', { peerId: 'm1', name: 'Alice' });
  assert.equal(r.peers.length, 1);
  assert.equal(r.S.swarm.peers.get('m1'), r.peers[0]);
  assert.ok(healthy.closed);
  assert.equal(r.sig.signals[0][1].kind, 'offer');
});

test('信令刷 peer-join：同时挂着的连接有上限，只提醒一次', async () => {
  const r = await signalRoom();
  const cap = appConst('MAX_LIVE_PEERS');
  assert.ok(cap >= 16, '上限不能比房间最大人数还小');
  for (let i = 0; i < 500; i++) await r.sig.emit('peer-join', { peerId: `p${i}`, name: `p${i}` });
  assert.equal(r.peers.length, cap);
  assert.equal(r.S.swarm.peers.size, cap);
  assert.equal(r.logs.filter(([t]) => t === '同时连着的人太多了，多出来的连接请求已忽略').length, 1);
});

test('同一个人刷 offer / 重协商：重建按令牌桶限速', async () => {
  const r = await signalRoom();
  let rebuilds = 0;
  r.ctx.reconnectPeer = async () => rebuilds++;
  for (let i = 0; i < 100; i++) await r.sig.emit('signal', { from: 'evil', name: 'evil', payload: { kind: 'offer', sdp: {} } });
  for (let i = 0; i < 100; i++) await r.sig.emit('signal', { from: 'evil', name: 'evil', payload: { kind: 'renegotiate' } });
  assert.equal(r.peers.length + rebuilds, appConst('REBUILD_BURST'), `重建了 ${r.peers.length + rebuilds} 次`);
  // 格式不对的 payload 不能抛成没人接住的拒绝
  await r.sig.emit('signal', { from: 'evil', name: 'evil', payload: null });
});

test('信令推来的日志按种类限流；超长昵称截断', async () => {
  const r = await signalRoom();
  for (let i = 0; i < 1000; i++) await r.sig.emit('error', { message: `坏消息 ${i}` });
  assert.equal(r.logs.length, appConst('SIG_LOG_MAX'));
  await r.sig.emit('peer-join', { peerId: 'long', name: 'W'.repeat(100_000) });
  assert.equal(r.peers[0].name.length, 40);
});

test('列表操作刷屏：游客的不进队，管理员每人排队有上限', async () => {
  const heads = [];
  const acks = [];
  const ctx = sandbox({
    fns: ['onPlaylistOp'],
    decls: ['PLAYLIST_OP_QUEUE_PER_PEER', 'playlistOpQueued'],
    globals: {
      isRoomHost: () => true,
      S: { sync: { isController: (id) => id === 'admin' } },
      MSG: { PLAYLIST_ACK: 'playlist-ack' },
      // 前面有一条管理员加片在等清单：后面来的全排在链上
      hostApplyOp: () => {
        const d = deferred();
        heads.push(d);
        return d.promise;
      },
    },
  });
  const peerOf = (peerId) => ({ peerId, name: peerId, send: (m) => acks.push([peerId, m]) });
  const guest = peerOf('guest');
  for (let i = 0; i < 100; i++) ctx.onPlaylistOp({ reqId: `g${i}`, op: { type: 'remove' } }, guest);
  assert.equal(heads.length, 0, '游客的操作排进了房主的串行链');
  assert.equal(acks.length, 100);
  assert.equal(acks[0][1].reason, '你没有编辑播放列表的权限');

  const admin = peerOf('admin');
  for (let i = 0; i < 100; i++) ctx.onPlaylistOp({ reqId: `a${i}`, op: { type: 'remove' } }, admin);
  const cap = appConst('PLAYLIST_OP_QUEUE_PER_PEER');
  assert.equal(heads.length, cap);
  assert.equal(acks.filter(([id, m]) => id === 'admin' && m.reason === '操作太频繁了，稍后再试').length, 100 - cap);
  // 排着的都处理完了，额度要还回来
  for (const d of heads) d.resolve({ ok: true });
  await flush();
  ctx.onPlaylistOp({ reqId: 'later', op: { type: 'remove' } }, admin);
  assert.equal(heads.length, cap + 1);
});

/* ------------------------- 房间链接的名额：isLinked / REMOVED / BUSY ------------------------- */

async function relayRoom({ role = 'host', inRoom = true } = {}) {
  const { FakeSwarm } = await swarmClass();
  const sigs = [];
  const { FakeRelay, FakeWs } = signalingClasses(sigs);
  const calls = { fail: [], leaves: 0, logs: [] };
  const storage = fakeStorage();
  const S = {
    peerId: role === 'host' ? 'host-A' : 'me',
    name: '我',
    role,
    hostId: 'host-A',
    roomCapacity: 4,
    leaving: false,
    settings: { relays: '' },
    swarm: new FakeSwarm({ securityMode: 'trusted' }),
    signaling: null,
  };
  const ctx = sandbox({
    fns: [
      'connectSignaling', 'directLinkUp', 'peerLinked', 'admitPeer', 'allowRebuild', 'sigLog', 'cancelRecovery',
      'customRelays', 'relayList', 'relayJoinError', 'removedFromRoom', 'stashLobbyNotice', 'takeLobbyNotice',
    ],
    decls: [
      'MAX_PEER_NAME', 'peerName', 'MAX_LIVE_PEERS', 'REBUILD_BURST', 'REBUILD_REFILL_MS', 'rebuildBudget', 'peerCapWarned',
      'SIG_LOG_WINDOW_MS', 'SIG_LOG_MAX', 'sigLogBudget', 'RECOVERY', 'clampCapacity', 'LOBBY_NOTICE_KEY',
    ],
    globals: {
      S,
      roomEntered: inRoom,
      sessionStorage: storage,
      log: (text, tone) => calls.logs.push([text, tone]),
      prepFail: (msg) => calls.fail.push(msg),
      leaveRoom: async () => {
        calls.leaves += 1;
      },
      Peer: peerClass([]),
      wirePeer: () => {},
      iceServers: () => [],
      RelaySignaling: FakeRelay,
      WsSignaling: FakeWs,
      DEFAULT_RELAYS: ['wss://default.example'],
      PROTOCOL_VERSION: 2,
      connectedPeerCount: () => 0,
      renderCapacityStatus: () => {},
      refreshRoomLink: async () => {},
      hostReallyGone: () => {},
      reconnectPeer: async () => {},
    },
  });
  const relay = role === 'host' ? { secret: 'S', isHost: true, hostId: 'host-A' } : { secret: 'S', hostKey: 'a'.repeat(64), hostId: 'host-A' };
  const connecting = ctx.connectSignaling(null, null, relay);
  sigs[0].pending.resolve({ hostId: 'host-A' });
  await connecting;
  return { ctx, S, sig: sigs[0], calls, storage };
}

test('房主建中继信令时交出 isLinked：只看这个人的数据通道，查一下表就回', async () => {
  const host = await relayRoom({ role: 'host' });
  const isLinked = host.sig.o.isLinked;
  assert.equal(typeof isLinked, 'function', '房主没把 isLinked 交给 RelaySignaling，占着名额不建连的人收不回来');
  const peer = (readyState, extra = {}) => ({ closed: false, ctrl: { readyState }, close() {}, ...extra });
  host.S.swarm.peers.set('linked', peer('open'));
  host.S.swarm.peers.set('dialing', peer('connecting'));
  host.S.swarm.peers.set('gone', peer('open', { closed: true }));
  // ICE 抖一下还在自愈：数据通道开着就算连着，别被当成「一直没连上」收回名额
  host.S.swarm.peers.set('blip', peer('open', { pc: { iceConnectionState: 'disconnected' } }));
  assert.equal(isLinked('linked'), true);
  assert.equal(isLinked('dialing'), false);
  assert.equal(isLinked('gone'), false);
  assert.equal(isLinked('nobody'), false);
  assert.equal(isLinked('blip'), true);
  // 房间都拆了还被定时器问到：不能抛
  host.S.swarm = null;
  assert.equal(isLinked('linked'), false);

  const member = await relayRoom({ role: 'guest' });
  assert.equal(member.sig.o.isLinked, undefined, '只有房主一方传');
});

test('加入房间链接失败：REMOVED、BUSY 都说人话', () => {
  const ctx = sandbox({ fns: ['relayJoinError'] });
  assert.equal(
    ctx.relayJoinError({ code: 'REMOVED', message: 'x' }),
    '房主那边一直没能和你直连，你已被移出房间。可以请房主改发一对一邀请，或者双方在设置里配置 TURN 后再试。'
  );
  assert.equal(ctx.relayJoinError({ code: 'BUSY', message: 'x' }), '房间里正有好几个人在连接，稍后再点一次链接试试。');
  // 加入流程里的报错走的就是它
  assert.match(fnSource('joinViaRelay'), /return prepFail\(relayJoinError\(e\)\);/);
});

test('房间里被房主移出：干净地退回大厅，回到首页再说一遍原因', async () => {
  const r = await relayRoom({ role: 'guest', inRoom: true });
  await r.sig.emit('error', Object.assign(new Error('removed'), { code: 'REMOVED' }));
  assert.equal(r.calls.leaves, 1, '被移出了还留在房间里');
  const text = r.ctx.relayJoinError({ code: 'REMOVED' });
  assert.equal(r.storage.getItem('sw.lobbyNotice'), text);
  assert.deepEqual(r.calls.fail, []);
  assert.equal(r.ctx.takeLobbyNotice(), text);
  assert.equal(r.ctx.takeLobbyNotice(), '', '说过一次就清掉');
  // 退房在进行中又来一声：不重复退
  r.S.leaving = true;
  await r.sig.emit('removed');
  assert.equal(r.calls.leaves, 1);
  assert.match(APP, /const notice = takeLobbyNotice\(\);\s*if \(notice\) \$\('join-err'\)\.textContent = notice;/);
});

test('还在打洞时被移出：停在准备页上说清楚，关掉这条信令', async () => {
  const r = await relayRoom({ role: 'guest', inRoom: false });
  await r.sig.emit('removed');
  assert.equal(r.calls.leaves, 0);
  assert.deepEqual(r.calls.fail, [r.ctx.relayJoinError({ code: 'REMOVED' })]);
  assert.ok(r.sig.closed);
  assert.equal(r.S.signaling, null);
  // 普通的信令错误照旧只记日志
  const other = await relayRoom({ role: 'guest', inRoom: true });
  await other.sig.emit('error', new Error('坏了'));
  assert.equal(other.calls.leaves, 0);
  assert.deepEqual(other.calls.logs.map(([t]) => t), ['信令错误：坏了']);
});

/* ------------------------------ 设置里的人数上限 ------------------------------ */

test('房间里在设置改人数上限：只存成新房间的默认值，不动这个房间的实际上限', () => {
  const storage = fakeStorage({ 'sw.roomCapacity': '4' });
  const S = { roomCapacity: 4, role: 'host' };
  const ctx = sandbox({ fns: ['saveCapacitySetting'], decls: ['clampCapacity'], globals: { S, roomEntered: true, localStorage: storage } });
  ctx.saveCapacitySetting('8');
  assert.equal(S.roomCapacity, 4, '绕过了「不能低于当前人数」，信令那边也不知道');
  assert.equal(storage.getItem('sw.roomCapacity'), '8');

  // 正在加入别人的房间时同理：S.roomCapacity 是那个房间的
  const guest = { roomCapacity: 12, role: 'guest' };
  const ctx2 = sandbox({ fns: ['saveCapacitySetting'], decls: ['clampCapacity'], globals: { S: guest, roomEntered: false, localStorage: fakeStorage() } });
  ctx2.saveCapacitySetting('3');
  assert.equal(guest.roomCapacity, 12);

  // 首页：就是下一次开房用的上限
  const home = { roomCapacity: 4, role: null };
  const ctx3 = sandbox({ fns: ['saveCapacitySetting'], decls: ['clampCapacity'], globals: { S: home, roomEntered: false, localStorage: fakeStorage() } });
  ctx3.saveCapacitySetting('99');
  assert.equal(home.roomCapacity, 16);

  const save = APP.slice(APP.indexOf("okText: '保存',"), APP.indexOf('function saveCapacitySetting('));
  assert.match(save, /saveCapacitySetting\(\$\('set-capacity'\)\.value\);/);
  assert.doesNotMatch(save, /S\.roomCapacity = /, '设置保存时不能直接改房间的实时上限');
  assert.match(APP, /id: 'set-capacity',[\s\S]{0,120}props: \{ value: String\(storedCapacity\(\)\) \}/);
});

/* ------------------------------ 邀请码里的服务器 ------------------------------ */

function serverHost() {
  const encoded = [];
  const connects = [];
  const S = {
    signaling: null,
    signalTransport: null,
    mode: null,
    peerId: 'host1',
    name: '房主',
    roomCapacity: 4,
    roomSecurityMode: 'trusted',
    settings: { signalUrl: 'ws://server-a:8080', relays: 'wss://relay-one.example' },
  };
  const ctx = sandbox({
    fns: ['inviteViaServer', 'inviteViaRelay', 'renderRelayInvite', 'customRelays', 'setFinalInviteStep'],
    globals: {
      S,
      $: fakeDollar(),
      make: (tag, o = {}, kids = []) => ({ tag, ...o, kids }),
      replace: () => {},
      inviteStep: () => ({}),
      randomRoomId: () => 'ROOM1',
      connectSignaling: async (url, room, relay) => {
        connects.push([url, room]);
        S.signaling = relay
          ? { secret: relay.secret, publicKey: 'c'.repeat(64), close() {} }
          : { close() {} };
        S.signalTransport = relay ? 'relay' : 'ws';
      },
      encodeCode: async (p) => {
        encoded.push(JSON.parse(JSON.stringify(p)));
        return 'NR3-code';
      },
      shareLink: () => 'https://example/#j/code/',
      copyCode: () => {},
      log: () => {},
      inviteMediaInfo: () => ({ name: 'x', size: 1, kind: 'file' }),
      updatePresence: () => {},
      newRoomSecret: () => 'SECRET',
      inviteViaManual: async () => {},
    },
  });
  return { ctx, S, encoded, connects };
}

test('房间里改了信令服务器地址再生成邀请码：码里还是房间所在的那台服务器', async () => {
  const r = serverHost();
  await r.ctx.inviteViaServer();
  assert.deepEqual(r.connects, [['ws://server-a:8080', 'ROOM1']]);
  assert.equal(r.encoded[0].url, 'ws://server-a:8080');

  r.S.settings.signalUrl = 'ws://server-b:8080';
  await r.ctx.inviteViaServer();
  assert.equal(r.connects.length, 1, '已经连着就不重连');
  assert.equal(r.encoded[1].url, 'ws://server-a:8080', '码里是新地址、房间号却是旧服务器上的');
  assert.equal(r.encoded[1].room, 'ROOM1');
});

test('房间里改了中继列表再换链接：链接里还是房主实际连着的那组中继', async () => {
  const r = serverHost();
  await r.ctx.inviteViaRelay();
  assert.deepEqual(r.encoded[0].relays, ['wss://relay-one.example']);
  r.S.settings.relays = 'wss://relay-two.example';
  await r.ctx.renderRelayInvite(r.ctx.$('inv-out'));
  assert.deepEqual(r.encoded[1].relays, ['wss://relay-one.example'], '加入的人会去另一组中继上找房主');
});

/* ------------------------------ 首页的版本号 ------------------------------ */

test('首页角落显示版本号，取自主进程的 env 状态', async () => {
  const run = async (status) => {
    const $ = fakeDollar();
    const ctx = sandbox({
      fns: ['boot'],
      globals: {
        $,
        S: { env: null },
        window: { sw: { geo: { check: async () => ({}) }, env: { status, ensureDirs: async () => {} } } },
        applyGeoNotice: () => {},
        updateDepsPill: () => {},
        refreshPlayerList: () => {},
        show: () => {},
        log: () => {},
        submitPlaylistOp: () => {},
        // Cloudflare TURN 的启动三件事（状态、备账号、用量计量），这里不关心
        refreshCfTurnState: () => {},
        meterTurnUsage: () => {},
        setInterval: () => 0,
        TURN_METER_MS: 10_000,
      },
    });
    await ctx.boot();
    return $('home-version').textContent;
  };
  assert.equal(await run(async () => ({ version: '0.7.4' })), 'v0.7.4');
  assert.equal(await run(async () => { throw new Error('探测失败'); }), '', '拿不到版本号就不显示，别写个 vundefined');

  const html = read('src/renderer/index.html');
  const home = html.slice(html.indexOf('<section id="view-home"'), html.indexOf('<section id="view-prepare"'));
  assert.match(home, /<p class="home-version" id="home-version" data-i18n-skip><\/p>/);
  assert.match(read('src/renderer/styles.css'), /\.home-version \{/);
  // 主进程那边确实报了 version
  assert.match(read('src/main/main.js'), /version: app\.getVersion\(\)/);
});

/* ------------------------------ 高频重画 ------------------------------ */

test('成员表的重画合并：对端刷 pong 也只画一次', () => {
  const timers = fakeTimers();
  let drawn = 0;
  const ctx = sandbox({
    fns: ['renderPeersSoon'],
    decls: ['PEERS_RENDER_MS', 'peersRenderTimer'],
    globals: { setTimeout: timers.setTimeout, renderPeers: () => drawn++ },
  });
  for (let i = 0; i < 1000; i++) ctx.renderPeersSoon();
  assert.equal(timers.size, 1);
  assert.equal(drawn, 0);
  timers.runAll();
  assert.equal(drawn, 1);
  ctx.renderPeersSoon();
  assert.equal(timers.size, 1, '画完之后还能再排下一次');

  const init = fnSource('initSwarmAndSync');
  assert.match(init, /S\.swarm\.on\('peers', renderPeersSoon\);/);
  const ready = init.slice(init.indexOf("S.sync.on('ready-change'"), init.indexOf("S.sync.on('ready-change'") + 300);
  assert.match(ready, /renderPeersSoon\(\);/);
  assert.doesNotMatch(ready, /renderPeers\(\);/);
  assert.doesNotMatch(init, /\brenderPeers\(\)/, '引擎和 swarm 的事件都要走合并');
});

test('聊天每来一条不全量重画：合并到一次', () => {
  const timers = fakeTimers();
  let renders = 0;
  const S = { chat: { entries: [], notice: '' } };
  const ctx = sandbox({
    fns: ['renderChat', 'pushChatEntry'],
    decls: ['CHAT_RENDER_MS', 'chatRenderTimer'],
    globals: {
      S,
      roomEntered: true,
      VIEW_LIMIT: 300,
      setTimeout: timers.setTimeout,
      ensureChatPanel: () => ({ render: () => renders++ }),
    },
  });
  for (let i = 0; i < 500; i++) ctx.pushChatEntry({ key: `m${i}`, kind: 'msg', text: 'x' });
  assert.equal(renders, 0);
  timers.runAll();
  assert.equal(renders, 1);
  assert.equal(S.chat.entries.length, 300, '列表本身有上限');
});

test('Discord 状态：变化再频繁也按最短间隔发，关掉立刻生效', async () => {
  const { buildActivity, activityKey } = await load('src/renderer/ui/discordPresence.js');
  const timers = fakeTimers();
  const clock = { now: 1_000_000 };
  const sent = [];
  let members = 1;
  const g = {
    roomEntered: true,
    S: { leaving: false, discord: { enabled: true, showTitle: false, showJoin: true } },
    buildActivity,
    activityKey,
    t: (s) => s,
    presenceState: () => ({ title: 'x', paused: true, started: true, members, capacity: 16, partyId: 'p' }),
    setDiscordStatus: () => {},
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    Date: { now: () => clock.now },
    window: {
      sw: {
        discord: {
          setActivity: async (a) => sent.push(a.state),
          clear: async () => sent.push('clear'),
        },
      },
    },
  };
  const ctx = sandbox({ fns: ['updatePresence'], decls: ['presenceKey', 'PRESENCE_MIN_MS', 'presenceSentAt', 'presenceTimer'], globals: g });
  for (let i = 1; i <= 12; i++) {
    members = i;
    ctx.updatePresence();
  }
  assert.equal(sent.length, 1, `人进进出出发了 ${sent.length} 次`);
  assert.equal(timers.size, 1);
  clock.now += appConst('PRESENCE_MIN_MS');
  timers.runAll();
  assert.equal(sent.length, 2);
  assert.match(sent[1], /12\/16/, '间隔结束时发的是最新那份');

  // 退房：不等间隔
  members = 3;
  ctx.updatePresence();
  g.roomEntered = false;
  ctx.roomEntered = false;
  ctx.updatePresence();
  assert.equal(sent[sent.length - 1], 'clear');
});

test('就绪等待名单只列前几位，人数照实说', () => {
  const nodes = [];
  const S = {
    sync: { canIControl: () => true, shared: { paused: true } },
    current: { kind: 'file' },
    playlist: { started: false },
    switchingMedia: false,
    role: 'guest',
  };
  const waiting = Array.from({ length: 50 }, (_, i) => ({ peerId: `p${i}`, name: 'N'.repeat(500) }));
  const $ = fakeDollar();
  const ctx = sandbox({
    fns: ['renderReady'],
    decls: ['READY_NAMES_SHOWN', 'MAX_PEER_NAME', 'peerName'],
    globals: {
      S,
      $,
      roomEntered: true,
      readyWaiting: () => waiting,
      autoStartArmed: () => false,
      connectedPeerCount: () => 50,
      currentLocale: () => 'zh-CN',
      updateStripTone: () => {},
      make: (tag, o = {}) => ({ tag, ...o }),
      rawText: (text) => ({ raw: true, text }),
      replace: (target, ...kids) => nodes.push(...kids),
    },
  });
  ctx.renderReady();
  const names = nodes.filter((n) => n.raw && n.text !== '、' && n.text !== '、…');
  assert.equal(names.length, appConst('READY_NAMES_SHOWN'));
  assert.ok(names.every((n) => n.text.length <= 40));
  assert.equal(nodes[0].text, '等待 50 人准备好：');
  assert.equal(nodes[nodes.length - 1].text, '、…');
});

test('patch 重画时文字没变就不写 DOM', async () => {
  class FakeNode {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.childNodes = [];
      this.parentNode = null;
      this.attrs = new Map();
      this.style = {};
      this.className = '';
      this.writes = 0;
      this._text = '';
    }
    get textContent() {
      return this.childNodes.length ? this.childNodes.map((n) => n.textContent).join('') : this._text;
    }
    set textContent(v) {
      this.writes += 1;
      this.childNodes = [];
      this._text = String(v);
    }
    setAttribute(k, v) {
      this.attrs.set(k, String(v));
    }
    removeAttribute(k) {
      this.attrs.delete(k);
    }
    hasAttribute(k) {
      return this.attrs.has(k);
    }
    insertBefore(node, ref) {
      node.remove();
      const i = ref ? this.childNodes.indexOf(ref) : -1;
      if (i < 0) this.childNodes.push(node);
      else this.childNodes.splice(i, 0, node);
      node.parentNode = this;
    }
    remove() {
      if (!this.parentNode) return;
      this.parentNode.childNodes = this.parentNode.childNodes.filter((n) => n !== this);
      this.parentNode = null;
    }
  }
  const prevDoc = globalThis.document;
  globalThis.document = { createElement: (tag) => new FakeNode(tag), getElementById: () => null };
  try {
    const { patch } = await load('src/renderer/ui/dom.js');
    const parent = new FakeNode('div');
    const specs = () => Array.from({ length: 300 }, (_, i) => ({ key: `m${i}`, tag: 'div', text: `第 ${i} 条`, raw: true }));
    patch(parent, specs());
    const first = parent.childNodes.reduce((n, c) => n + c.writes, 0);
    assert.equal(first, 300);
    patch(parent, specs());
    const second = parent.childNodes.reduce((n, c) => n + c.writes, 0);
    assert.equal(second, 300, '内容没变，重画一次又把 300 行整个写了一遍');
  } finally {
    globalThis.document = prevDoc;
  }
});

test('超长昵称和片名不撑坏布局', () => {
  const css = read('src/renderer/styles.css');
  const rule = (selector) => {
    const i = css.indexOf(`${selector} {`);
    assert.ok(i >= 0, `没找到 ${selector}`);
    return css.slice(i, css.indexOf('}', i));
  };
  for (const selector of ['.log-line > span:last-child', '.chat-system', '.prep-note', '.status-banner', '.ready-text', '.film-meta', '.modal-box']) {
    assert.match(rule(selector), /overflow-wrap: anywhere;/, `${selector} 里一长串不带空格的名字会撑出去`);
  }
  // 邀请码、应答码里的昵称和片名进界面前截断
  assert.match(fnSource('joinViaManual'), /name: peerName\(payload\.name, '发起者'\)/);
  assert.match(fnSource('acceptManualAnswer'), /peer\.name = peerName\(payload\.name, '观众'\);/);
  assert.match(fnSource('inviteFileLine'), /String\(file\.name \|\| ''\)\.slice\(0, 200\)/);
});

/* ------------------------------ 新文案 ------------------------------ */

test('这一轮新增的文案都有英文', async () => {
  const { translate } = await load('src/renderer/lib/i18n.js');
  for (const line of [
    '要离开当前房间吗？',
    '收到了一条新的邀请。加入它要先离开当前房间，你这边的播放和传输都会停下。',
    '离开并加入',
    '要放弃正在准备的放映吗？',
    '收到了一条新的邀请。加入它要先停下正在准备的这部片。',
    '放弃并加入',
    '你已经在这个房间里了。',
    '同时连着的人太多了，多出来的连接请求已忽略',
    '只影响以后新开的房间；这个房间的人数上限请在邀请区调整。',
    '操作太频繁了，稍后再试',
    '房主那边一直没能和你直连，你已被移出房间。可以请房主改发一对一邀请，或者双方在设置里配置 TURN 后再试。',
    '房间里正有好几个人在连接，稍后再点一次链接试试。',
    '取消',
  ]) {
    const en = translate(line, 'en');
    assert.notEqual(en, line, line);
    assert.doesNotMatch(en, /[\u4e00-\u9fff]/, `${line} 的英文里还夹着中文`);
  }
  // 列表操作被拒的原因经「列表没改成：…」这条模板带出来，模板里的原因也得翻
  assert.equal(
    translate('列表没改成：操作太频繁了，稍后再试', 'en'),
    'The playlist was not changed: Too many changes at once; try again in a moment'
  );
  // 这些文案真的出自 app.js，不是只躺在字典里
  for (const line of ['要离开当前房间吗？', '你已经在这个房间里了。', '同时连着的人太多了，多出来的连接请求已忽略']) {
    assert.ok(APP.includes(`'${line}'`), line);
  }
});
