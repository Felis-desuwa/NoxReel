'use strict';

// 房间链接断线自愈在编排层（app.js / app-android.js）的那一半（批次 3）。
//
// 中继信令恢复时发 reconnected（见 relaySelfHeal.test.js），这里守的是 app 拿它做什么：
//  1. 信令断着时到期的重连不算数（次数退回），恢复后直连不通的人重新排上、次数从头算；
//  2. 发出去的 renegotiate / offer 可能在中继上丢：一轮握手有超时，超时接着退避；
//  3. 两轮重建交叉时，上一轮的 answer 不能套到新连接上（offer 带标记，应答原样带回）；
//  4. 被移出的提示分进房前 / 进房后，进房前的不再叫人「配好 TURN 再试」（本场按 peerId 封禁，
//     同一次运行里再试一定还被拒）；换链接时没跟过来的人、停用房间链接的后果都告诉房主。
//
// 照 appHardening 的做法把顶层函数原样抠进 vm 沙箱，定时器换成手动拨的假时钟。全程不联网、不出声。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const SOURCES = {
  桌面端: read('src/renderer/app.js'),
  安卓端: read('android/app/src/main/assets/js/app-android.js'),
};

function fnSource(src, name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(src);
  assert.ok(m, `没找到顶层函数 ${name}`);
  const end = src.indexOf('\n}\n', m.index);
  assert.ok(end > m.index, `${name} 的结尾没找到`);
  return src.slice(m.index, end + 2);
}

/** 顶层的单行 const / let 声明（行尾可以带注释），搬进沙箱时换成 var，测试才能从沙箱外看到它。 */
function declSource(src, name) {
  const m = new RegExp(`^(?:const|let) ${name} = ([^\\n;]*);`, 'm').exec(src);
  assert.ok(m, `没找到顶层声明 ${name}`);
  return `var ${name} = ${m[1]};`;
}

/** 沙箱里造出来的对象原型不是这边的，比较前先转成普通数据。 */
const plain = (x) => JSON.parse(JSON.stringify(x));

/** 手动拨的假时钟：advance(ms) 按到期先后把定时器跑掉。 */
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

// peerName 用 chat.js 的 clampName 清洗昵称：沙箱里给一份真的（桌面和安卓的 chat.js 逐字相同）
let clampName = null;
test.before(async () => {
  ({ clampName } = await import(pathToFileURL(path.join(root, 'src/renderer/lib/chat.js')).href));
});

function sandbox(src, { fns = [], decls = [], globals = {} }) {
  const ctx = { console, clampName, ...globals };
  vm.createContext(ctx);
  vm.runInContext([...decls.map((d) => declSource(src, d)), ...fns.map((f) => fnSource(src, f))].join('\n\n'), ctx);
  return ctx;
}

async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

/** 最小的事件对象：on / emit。 */
function emitter(obj = {}) {
  const handlers = new Map();
  obj.on = (ev, fn) => {
    if (!handlers.has(ev)) handlers.set(ev, []);
    handlers.get(ev).push(fn);
    return () => {};
  };
  obj.emit = (ev, payload) => Promise.all((handlers.get(ev) || []).map((fn) => fn(payload)));
  return obj;
}

function fakeSig({ connected = true } = {}) {
  return { connected, trickle: false, signals: [], signal(to, payload) { this.signals.push([to, payload]); } };
}

/* ------------------------------ 重连排程 ------------------------------ */

function recoveryBox(label) {
  const src = SOURCES[label];
  const desktop = label === '桌面端';
  const clock = fakeClock();
  const logs = [];
  const rebuilds = [];
  const S = { peerId: 'me', hostId: 'host', swarm: { peers: new Map(), versionRejected: new Set() } };
  const ctx = sandbox(src, {
    fns: ['scheduleReconnect', 'cancelRecovery', 'resumeRecovery', 'directLinkUp', ...(desktop ? ['peerLinked'] : ['peerName'])],
    decls: ['RECONNECT_BACKOFF_MS', 'HANDSHAKE_TIMEOUT_MS', 'RECOVERY', ...(desktop ? ['MAX_PEER_NAME', 'peerName'] : [])],
    globals: {
      S,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      log: (text, tone) => logs.push([text, tone]),
      connectionAdvice: () => ({ text: '（诊断）', level: 'bad' }),
      hostReallyGone: () => logs.push(['hostReallyGone']),
      reconnectPeer: async (peerId) => rebuilds.push(peerId),
    },
  });
  return { ctx, S, clock, logs, rebuilds };
}

for (const label of Object.keys(SOURCES)) {
  test(`${label}：信令断着时到期的重连不算数，次数退回去；断多久都不会把次数耗光`, () => {
    const r = recoveryBox(label);
    const sig = fakeSig({ connected: false });
    const peer = { peerId: 'm1', name: 'Alice', initiator: false, closed: false };
    for (let i = 0; i < 6; i++) {
      r.ctx.scheduleReconnect(peer, sig);
      r.clock.advance(20_000);
    }
    assert.deepEqual(plain(sig.signals), [], '信令断着还发了请求');
    assert.equal(r.ctx.RECOVERY.get('m1').attempts, 0, '信令断着时的尝试把次数耗掉了');
    assert.ok(!r.logs.some(([t]) => /都没恢复/.test(t)), '信令断着就宣布放弃了');
    assert.ok(r.logs.some(([t]) => t === '信令还没恢复，暂时没法重连 Alice'));
  });

  test(`${label}：信令恢复后直连不通的人重新排上（次数从头算），连着的不动；发起方重建、应答方请对面重发`, () => {
    const r = recoveryBox(label);
    const sig = fakeSig();
    // 之前已经耗了两次
    r.ctx.RECOVERY.set('m1', { attempts: 2, timer: null, watch: null });
    const healthy = { peerId: 'ok', closed: false, ctrl: { readyState: 'open' }, pc: { iceConnectionState: 'connected' } };
    r.S.swarm.peers.set('ok', healthy);
    assert.equal(r.ctx.resumeRecovery(sig, { peerId: 'ok', name: 'Ok', initiator: true }), false, '直连好好的也去重建');
    assert.equal(r.ctx.resumeRecovery(sig, { peerId: 'm1', name: 'Alice', initiator: false }), true);
    assert.equal(r.ctx.resumeRecovery(sig, { peerId: 'm2', name: 'Bob', initiator: true }), true);
    assert.equal(r.ctx.RECOVERY.get('m1').attempts, 1, '恢复后次数没从头算');
    r.clock.advance(1500);
    assert.deepEqual(plain(sig.signals), [['m1', { kind: 'renegotiate' }]], '应答方该请对面重发 offer');
    assert.deepEqual(r.rebuilds, ['m2'], '发起方该自己重建');
    // 自己、版本不符的人、格式不对的都不理
    r.S.swarm.versionRejected.add('old');
    for (const p of [{ peerId: 'me' }, { peerId: 'old' }, { peerId: 42 }, {}]) assert.equal(r.ctx.resumeRecovery(sig, p), false);
    // 手上还挂着这个人的（断掉的）连接：按它原来的角色来，信令说的不算
    r.S.swarm.peers.set('m3', { peerId: 'm3', name: 'Carol', initiator: true, closed: false, ctrl: { readyState: 'closed' } });
    r.ctx.resumeRecovery(sig, { peerId: 'm3', name: 'Carol', initiator: false });
    r.clock.advance(1500);
    assert.deepEqual(r.rebuilds, ['m2', 'm3']);
  });

  test(`${label}：renegotiate 丢了：一轮握手超时还没连上就接着退避；连上了、或者对面已经发来 offer 就不再催`, () => {
    const r = recoveryBox(label);
    const sig = fakeSig();
    const peer = { peerId: 'host', name: '房主', initiator: false, closed: false };
    r.ctx.scheduleReconnect(peer, sig);
    peer.closed = true; // 旧连接随后被摘掉，不影响下一轮
    r.clock.advance(1500);
    assert.equal(sig.signals.length, 1);
    r.clock.advance(30_000); // 没有下文
    r.clock.advance(4000);
    assert.equal(sig.signals.length, 2, '请求丢了之后没有再催');
    assert.equal(r.ctx.RECOVERY.get('host').attempts, 2);
    // 这次连上了：超时到了也不再催
    r.S.swarm.peers.set('host', { peerId: 'host', closed: false, ctrl: { readyState: 'open' }, pc: { iceConnectionState: 'connected' } });
    r.clock.advance(60_000);
    assert.equal(sig.signals.length, 2);
  });

  test(`${label}：一直没下文，三次之后停手并说明，不会无限重试`, () => {
    const r = recoveryBox(label);
    const sig = fakeSig();
    const peer = { peerId: 'host', name: '房主', initiator: false, closed: true };
    r.ctx.scheduleReconnect(peer, sig, { retry: true });
    r.clock.advance(10 * 60_000);
    assert.equal(sig.signals.length, 3);
    assert.ok(r.logs.some(([t]) => /^和 房主 的直连试了 3 次都没恢复/.test(t)));
  });
}

/* ------------------------------ 握手超时 ------------------------------ */

function wireBox(label) {
  const src = SOURCES[label];
  const clock = fakeClock();
  const logs = [];
  const rebuilds = [];
  const S = { peerId: 'me', hostId: 'host', swarm: { peers: new Map(), versionRejected: new Set() } };
  const ctx = sandbox(src, {
    fns: ['wirePeer', 'scheduleReconnect', 'cancelRecovery', ...(label === '桌面端' ? ['peerLinked'] : [])],
    decls: ['RECONNECT_BACKOFF_MS', 'DISCONNECT_GRACE_MS', 'HANDSHAKE_TIMEOUT_MS', 'RECOVERY'],
    globals: {
      S,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      log: (text, tone) => logs.push([text, tone]),
      connectionAdvice: () => ({ text: '（诊断）', level: 'bad' }),
      hostReallyGone: () => {},
      reconnectPeer: async (peerId) => rebuilds.push(peerId),
    },
  });
  const peerOf = (peerId, initiator) => {
    const p = emitter({ peerId, name: peerId, initiator, closed: false, ctrl: { readyState: 'connecting' }, pc: { iceConnectionState: 'new' } });
    S.swarm.peers.set(peerId, p);
    return p;
  };
  return { ctx, S, clock, logs, rebuilds, peerOf };
}

for (const label of Object.keys(SOURCES)) {
  test(`${label}：offer / answer 丢了，连接停在半路：发起方 30 秒后重发，应答方多等一会儿再请对面重发`, () => {
    const r = wireBox(label);
    const sig = fakeSig();
    const out = r.peerOf('m1', true);
    r.ctx.wirePeer(out, sig);
    const back = r.peerOf('host', false);
    r.ctx.wirePeer(back, sig);
    r.clock.advance(30_000 + 1500);
    assert.deepEqual(r.rebuilds, ['m1'], '发起方停在半路没有重发');
    assert.deepEqual(plain(sig.signals), [], '应答方和发起方同时重来了');
    r.clock.advance(15_000 + 1500);
    assert.deepEqual(plain(sig.signals), [['host', { kind: 'renegotiate' }]]);
    assert.ok(r.logs.some(([t]) => t === '和 m1 的连接迟迟没建起来，重新协商'));
  });

  test(`${label}：按时连上、被顶替、被关掉的连接不触发握手超时；一对一（没有信令）的不设`, async () => {
    const r = wireBox(label);
    const sig = fakeSig();
    const opened = r.peerOf('a', true);
    r.ctx.wirePeer(opened, sig);
    opened.ctrl.readyState = 'open';
    await opened.emit('open');
    const replaced = r.peerOf('b', true);
    r.ctx.wirePeer(replaced, sig);
    r.S.swarm.peers.set('b', { peerId: 'b' });
    const closed = r.peerOf('c', true);
    r.ctx.wirePeer(closed, sig);
    closed.closed = true;
    await closed.emit('close');
    const manual = r.peerOf('d', true);
    r.ctx.wirePeer(manual, null);
    r.clock.advance(120_000);
    assert.deepEqual(r.rebuilds, []);
  });

  // G2（R2-B）：对方整个断网时，应答方这边 connectionState 走到 failed。那条连接之前是通的，
  // 拿本机候选下结论（「STUN 没告诉本机公网地址……请换 STUN」）只会把人往错的方向支
  test(`${label}：连通过的直连失败了：说对方可能断网或关掉了，不给 STUN / NAT 诊断；从没连通过的照旧诊断`, async () => {
    const r = wireBox(label);
    const sig = fakeSig();
    const failLog = (name) => r.logs.filter(([t]) => t.startsWith(`和 ${name} 的直连失败了`));

    const opened = r.peerOf('m1', false);
    r.ctx.wirePeer(opened, sig);
    opened.ctrl.readyState = 'open';
    await opened.emit('open');
    await opened.emit('statechange', 'failed');
    assert.deepEqual(failLog('m1'), [['和 m1 的直连失败了。之前是连通的，多半是对方断网或关掉了 NoxReel，正在等他回来。', 'warn']]);

    // ICE 连上过、数据通道还没来得及开的也算连通过
    const iced = r.peerOf('m2', true);
    r.ctx.wirePeer(iced, sig);
    await iced.emit('statechange', 'connected');
    await iced.emit('statechange', 'disconnected');
    await iced.emit('statechange', 'failed');
    assert.equal(failLog('m2').length, 1);
    assert.match(failLog('m2')[0][0], /之前是连通的/);

    const never = r.peerOf('m3', true);
    r.ctx.wirePeer(never, sig);
    await never.emit('statechange', 'failed');
    assert.equal(failLog('m3').length, 1);
    assert.doesNotMatch(failLog('m3')[0][0], /之前是连通的/);
    assert.equal(failLog('m3')[0][1], 'bad');
    if (label === '桌面端') assert.equal(failLog('m3')[0][0], '和 m3 的直连失败了。（诊断）');
    else assert.match(failLog('m3')[0][0], /严格 NAT/);
    // 两种失败都照常排上重连
    r.clock.advance(1500);
    assert.deepEqual(r.rebuilds.sort(), ['m2', 'm3']);
    assert.deepEqual(plain(sig.signals), [['m1', { kind: 'renegotiate' }]]);
  });

  // H1（N6）：G2 只改了「直连失败了」那一行。对方冻结 100 秒时退避约 78 秒用尽，那一行照旧拿本机候选说
  // 「STUN 服务器没能告诉本机公网地址……」；退避里新建的连接自己从没通过，失败时也一样被误诊
  test(`${label}：连通过的人失联到退避用尽，也说对方可能断网或关掉了；退避里新建的连接失败同样不给诊断；从没连通过的照旧诊断`, async () => {
    const r = wireBox(label);
    r.S.swarm.removePeer = (id) => r.S.swarm.peers.delete(id);
    const sig = fakeSig();
    const lines = (name, re) => r.logs.filter(([t]) => t.startsWith(`和 ${name} 的直连`) && re.test(t));

    const opened = r.peerOf('m1', false);
    r.ctx.wirePeer(opened, sig);
    opened.ctrl.readyState = 'open';
    await opened.emit('open');
    opened.ctrl.readyState = 'closed';
    await opened.emit('statechange', 'failed');
    // 退避第一轮：对面重发 offer 建的那条也没打通（它自己从没连通过）
    r.clock.advance(1500);
    const rebuilt = r.peerOf('m1', false);
    r.ctx.wirePeer(rebuilt, sig);
    await rebuilt.emit('statechange', 'failed');
    const failed = lines('m1', /直连失败了/);
    assert.equal(failed.length, 2);
    for (const line of failed) {
      assert.deepEqual(line, ['和 m1 的直连失败了。之前是连通的，多半是对方断网或关掉了 NoxReel，正在等他回来。', 'warn']);
    }
    r.clock.advance(10 * 60_000);
    assert.deepEqual(lines('m1', /都没恢复/), [['和 m1 的直连试了 3 次都没恢复。之前是连通的，多半是对方断网或关掉了 NoxReel。', 'bad']]);

    const never = r.peerOf('m3', false);
    r.ctx.wirePeer(never, sig);
    await never.emit('statechange', 'failed');
    r.clock.advance(10 * 60_000);
    const gaveUp = lines('m3', /都没恢复/);
    assert.equal(gaveUp.length, 1);
    assert.doesNotMatch(gaveUp[0][0], /之前是连通的/);
    if (label === '桌面端') assert.equal(gaveUp[0][0], '和 m3 的直连试了 3 次都没恢复。（诊断）');
    else assert.equal(gaveUp[0][0], '和 m3 的直连试了 3 次都没恢复。双方都在严格 NAT 后面时需要 TURN 中继兜底。');
  });
}

test('连通过的直连失败了：两端的英文都有，昵称原样保留', async () => {
  const cjk = /[㐀-鿿]/;
  const line = '和 张三 的直连失败了。之前是连通的，多半是对方断网或关掉了 NoxReel，正在等他回来。';
  for (const file of ['src/renderer/lib/i18n.js', 'android/app/src/main/assets/js/i18n.js']) {
    const { translate } = await import(pathToFileURL(path.join(root, file)).href);
    const en = translate(line, 'en');
    assert.equal(
      en,
      'Direct connection to 张三 failed. It was working before, so the other side has most likely lost their network or closed NoxReel. Waiting for them to come back.',
      file
    );
    assert.equal(translate(line, 'zh-CN'), line);
  }
  // 安卓端从没连通过的那句以前就没有英文，顺手补上
  const android = await import(pathToFileURL(path.join(root, 'android/app/src/main/assets/js/i18n.js')).href);
  const nat = android.translate('和 Bob 的直连失败了（双方都在严格 NAT 后面时会这样，需要 TURN 中继兜底）', 'en');
  assert.doesNotMatch(nat, cjk);
  assert.match(nat, /^Direct connection to Bob failed \(/);
});

test('H1（N6）：退避用尽那一行两端都有英文，后半句递归翻，昵称原样保留', async () => {
  const cjk = /[㐀-鿿]/;
  const linked = '和 张三 的直连试了 3 次都没恢复。之前是连通的，多半是对方断网或关掉了 NoxReel。';
  const expected =
    'The direct connection to 张三 did not recover after 3 attempts. It was working before, so the other side has most likely lost their network or closed NoxReel.';
  for (const file of ['src/renderer/lib/i18n.js', 'android/app/src/main/assets/js/i18n.js']) {
    const { translate } = await import(pathToFileURL(path.join(root, file)).href);
    assert.equal(translate(linked, 'en'), expected, file);
    assert.equal(translate(linked, 'zh-CN'), linked);
  }
  // 安卓端从没连通过的那句（以前整行都没有英文）
  const android = await import(pathToFileURL(path.join(root, 'android/app/src/main/assets/js/i18n.js')).href);
  const nat = android.translate('和 Bob 的直连试了 3 次都没恢复。双方都在严格 NAT 后面时需要 TURN 中继兜底。', 'en');
  assert.doesNotMatch(nat.replace('Bob', ''), cjk);
  assert.equal(nat, 'The direct connection to Bob did not recover after 3 attempts. When both sides are behind strict NAT, a TURN relay is needed as a fallback.');
});

test('退避中每一轮「N 秒后自动重连」那一行两端都有英文，昵称原样保留', async () => {
  const line = '和 张三 的直连断了，4 秒后自动重连（第 2 次）';
  const expected = 'Lost the direct connection to 张三. Reconnecting automatically in 4 seconds (attempt 2).';
  for (const file of ['src/renderer/lib/i18n.js', 'android/app/src/main/assets/js/i18n.js']) {
    const { translate } = await import(pathToFileURL(path.join(root, file)).href);
    assert.equal(translate(line, 'en'), expected, file);
    assert.equal(translate(line, 'zh-CN'), line);
  }
});

/* ------------------------- offer 标记与 reconnected（桌面端） ------------------------- */

async function signalRoom() {
  const src = SOURCES['桌面端'];
  const clock = fakeClock();
  const logs = [];
  const rebuilds = [];
  const peers = [];
  const answers = [];
  const sigs = [];
  class FakeSig {
    constructor(o) {
      emitter(this);
      this.o = o;
      this.connected = true;
      this.trickle = false;
      this.signals = [];
      sigs.push(this);
    }
    async connect() {
      return { hostId: 'me' }; // 这个房间的房主就是本机
    }
    signal(to, payload) {
      this.signals.push([to, payload]);
    }
    close() {}
  }
  class FakePeer {
    constructor(o) {
      emitter(this);
      Object.assign(this, o);
      this.closed = false;
      this.ctrl = { readyState: 'connecting' };
      this.pc = { iceConnectionState: 'new' };
      peers.push(this);
    }
    async createOffer() {
      return { type: 'offer', sdp: 'o' };
    }
    async acceptOffer() {
      return { type: 'answer', sdp: 'a' };
    }
    async acceptAnswer(sdp) {
      answers.push([this, sdp]);
    }
    close() {
      this.closed = true;
    }
  }
  const swarm = {
    peers: new Map(),
    versionRejected: new Set(),
    addPeer(p) {
      this.peers.set(p.peerId, p);
    },
    removePeer(id) {
      this.peers.get(id)?.close();
      this.peers.delete(id);
    },
  };
  const S = { peerId: 'me', name: '我', role: 'host', hostId: 'me', roomCapacity: 8, settings: { relays: '' }, swarm, signaling: null };
  const ctx = sandbox(src, {
    fns: [
      'connectSignaling', 'directLinkUp', 'peerLinked', 'admitPeer', 'allowRebuild', 'sigLog', 'cancelRecovery', 'customRelays', 'relayList',
      'resumeRecovery', 'scheduleReconnect',
    ],
    decls: [
      'MAX_PEER_NAME', 'peerName', 'MAX_LIVE_PEERS', 'REBUILD_BURST', 'REBUILD_REFILL_MS', 'rebuildBudget', 'peerCapWarned',
      'SIG_LOG_WINDOW_MS', 'SIG_LOG_MAX', 'sigLogBudget', 'RECOVERY', 'clampCapacity', 'RECONNECT_BACKOFF_MS', 'HANDSHAKE_TIMEOUT_MS',
    ],
    globals: {
      S,
      crypto: globalThis.crypto,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      log: (text, tone) => logs.push([text, tone]),
      Peer: FakePeer,
      wirePeer: () => {},
      RelaySignaling: FakeSig,
      WsSignaling: FakeSig,
      DEFAULT_RELAYS: [],
      PROTOCOL_VERSION: 2,
      connectedPeerCount: () => 0,
      renderCapacityStatus: () => {},
      refreshRoomLink: async () => {},
      hostReallyGone: () => {},
      removedFromRoom: () => {},
      reconnectPeer: async (peerId) => rebuilds.push(peerId),
      connectionAdvice: () => ({ text: '', level: 'bad' }),
      signalPeerIce: () => ({ iceServers: [], iceTransportPolicy: 'all' }),
    },
  });
  await ctx.connectSignaling(null, null, { secret: 'S', isHost: true, hostId: 'me' });
  return { ctx, S, sig: sigs[0], clock, logs, rebuilds, peers, answers };
}

test('桌面端：offer 带标记，应答原样带回；标记对不上的 answer（上一轮的）不往新连接上套，老版本不带标记的照收', async () => {
  const r = await signalRoom();
  await r.sig.emit('peer-join', { peerId: 'm1', name: 'Alice' });
  const [to, offer] = r.sig.signals[0];
  assert.equal(to, 'm1');
  assert.equal(offer.kind, 'offer');
  assert.ok(typeof offer.tag === 'string' && offer.tag.length >= 4, '发出去的 offer 没带标记');
  const mine = r.S.swarm.peers.get('m1');
  assert.equal(mine.offerTag, offer.tag);

  await r.sig.emit('signal', { from: 'm1', name: 'Alice', payload: { kind: 'answer', sdp: 'stale', tag: 'someoldtag' } });
  assert.deepEqual(r.answers, [], '上一轮的 answer 被套到了新连接上');
  await r.sig.emit('signal', { from: 'm1', name: 'Alice', payload: { kind: 'answer', sdp: 'right', tag: offer.tag } });
  await r.sig.emit('signal', { from: 'm1', name: 'Alice', payload: { kind: 'answer', sdp: 'legacy' } });
  assert.deepEqual(r.answers.map(([, sdp]) => sdp), ['right', 'legacy']);

  // 应答方：offer 带了标记就原样带回，没带就不带
  await r.sig.emit('signal', { from: 'm2', name: 'Bob', payload: { kind: 'offer', sdp: 'o', tag: 'abc123' } });
  await r.sig.emit('signal', { from: 'm3', name: 'Carol', payload: { kind: 'offer', sdp: 'o' } });
  const answersOut = r.sig.signals.filter(([, p]) => p.kind === 'answer');
  assert.deepEqual(answersOut.map(([id, p]) => [id, p.tag]), [['m2', 'abc123'], ['m3', undefined]]);
  assert.ok(!('tag' in answersOut[1][1]), '老版本的 offer 不该收到带标记的应答');
});

test('桌面端：对面发来 offer（他已经在重建）：撤掉我这边排着的 renegotiate，次数不退', async () => {
  const r = await signalRoom();
  const old = { peerId: 'm1', name: 'Alice', initiator: false, closed: false };
  r.ctx.scheduleReconnect(old, r.sig);
  await r.sig.emit('signal', { from: 'm1', name: 'Alice', payload: { kind: 'offer', sdp: 'o', tag: 't' } });
  r.clock.advance(60_000);
  assert.ok(!r.sig.signals.some(([, p]) => p.kind === 'renegotiate'), '对面已经发来 offer，我这边还在催');
  assert.equal(r.ctx.RECOVERY.get('m1').attempts, 1, '次数被清零了：一对连不通的人会没完没了地互相重试');
});

test('桌面端：中继信令恢复（reconnected）：直连不通的人重新排上，通着的不动', async () => {
  const r = await signalRoom();
  r.S.swarm.peers.set('ok', { peerId: 'ok', closed: false, ctrl: { readyState: 'open' }, pc: { iceConnectionState: 'connected' }, close() {} });
  await r.sig.emit('reconnected', {
    downMs: 90_000,
    peers: [
      { peerId: 'ok', name: 'Ok', initiator: true },
      { peerId: 'm1', name: 'Alice', initiator: true },
      { peerId: 'm2', name: 'Bob', initiator: false },
    ],
  });
  r.clock.advance(1500);
  assert.deepEqual(r.rebuilds, ['m1']);
  assert.deepEqual(plain(r.sig.signals), [['m2', { kind: 'renegotiate' }]]);
  assert.ok(r.logs.some(([t]) => t === '信令已恢复'));
  // 格式不对的事件不抛
  await r.sig.emit('reconnected', {});
  await r.sig.emit('reconnected', { peers: 'x' });
});

test('安卓端：offer 标记、应答带回、reconnected 的接线和桌面端一致', () => {
  const src = SOURCES['安卓端'];
  const connect = fnSource(src, 'connectSignaling');
  assert.match(connect, /peer\.offerTag = crypto\.getRandomValues\([^\n]*\n[\s\S]*?sig\.signal\(peerId, \{ kind: 'offer', sdp: offer, tag: peer\.offerTag \}\)/);
  assert.match(connect, /sig\.signal\(from, \{ kind: 'answer', sdp: answer, \.\.\.tag \}\)/);
  assert.match(connect, /if \(peer\.offerTag && typeof payload\.tag === 'string' && payload\.tag !== peer\.offerTag\) return;/);
  assert.match(connect, /sig\.on\('reconnected', [\s\S]*?resumeRecovery\(sig, p\)/);
  const offerPath = connect.slice(connect.indexOf("payload.kind === 'offer'"), connect.indexOf("payload.kind === 'renegotiate'"));
  assert.match(offerPath, /cancelRecovery\(from, \{ keepCount: true \}\);/, '收到 offer 没撤掉自己排着的 renegotiate');
  assert.match(fnSource(src, 'reconnectPeer'), /tag: peer\.offerTag/);
});

/* ------------------------------ 被移出的提示 ------------------------------ */

for (const label of Object.keys(SOURCES)) {
  test(`${label}：被移出分进房前 / 进房后说：进房前的不叫人「配好 TURN 再试」（这次运行里再点一定还被拒）`, () => {
    const ctx = sandbox(SOURCES[label], { fns: ['relayJoinError'] });
    const before = ctx.relayJoinError({ code: 'REMOVED' });
    const after = ctx.relayJoinError({ code: 'REMOVED', entered: true });
    assert.match(before, /重启 NoxReel/);
    assert.doesNotMatch(before, /后再试/);
    assert.match(after, /重新点一次房间链接/);
    assert.notEqual(before, after);
    const removed = fnSource(SOURCES[label], 'removedFromRoom');
    assert.match(removed, /relayJoinError\(\{ code: 'REMOVED', entered: (roomEntered|S\.entered) \}\)/);
  });
}

/* ------------------------- 换链接、停用房间链接时告诉房主 ------------------------- */

function inviteBox({ rekeyResult, admitted = 0 } = {}) {
  const src = SOURCES['桌面端'];
  const calls = [];
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, value: '', onclick: null, textContent: '' });
    return els.get(id);
  };
  const relay = {
    secret: 'OLD',
    publicKey: 'b'.repeat(64),
    admittedCount: admitted,
    closed: false,
    async rekey(secret) {
      this.secret = secret;
      return rekeyResult;
    },
    close() {
      this.closed = true;
    },
  };
  const S = {
    signaling: relay, signalTransport: 'relay', mode: 'server', peerId: 'host1', name: '房主', roomCapacity: 6,
    roomSecurityMode: 'safe', settings: { relays: '', signalUrl: 'ws://sig.example:8080' },
  };
  const ctx = sandbox(src, {
    fns: ['renderRelayInvite', 'inviteViaServer', 'setFinalInviteStep'],
    globals: {
      S,
      inviteGen: 0,
      $: el,
      make: (tag, o = {}, kids = []) => ({ tag, ...o, kids, style: {} }),
      replace: () => {},
      inviteStep: (no, title) => ({ text: title }),
      log: (text, kind) => calls.push([text, kind]),
      copyCode: () => {},
      updatePresence: () => {},
      newRoomSecret: () => 'NEW',
      randomRoomId: () => 'ROOM1',
      inviteMediaInfo: () => null,
      encodeCode: async () => 'NR3-Xcode',
      shareLink: (code) => `https://x.example/#j/${code.slice(4)}/`,
      turnFetchNeeded: () => false,
      inviteBlocked: () => false,
      connectSignaling: async () => ({ hostId: 'host1' }),
      syncOutsideSeats: () => {},
    },
  });
  return { ctx, S, calls, el, relay };
}

test('桌面端：换链接时还在连接中、没拿到新链接的人，告诉房主是谁', async () => {
  const r = inviteBox({ rekeyResult: { left: ['小明', 'Bob'] } });
  await r.ctx.renderRelayInvite({});
  await r.el('inv-rekey').onclick();
  assert.deepEqual(r.calls, [
    ['房间链接换好了，旧链接已作废（已经在房里的人不受影响）', 'good'],
    ['还在连接中的 小明、Bob 没跟着换过来，要进房请把新链接发给他们', 'warn'],
  ]);
  const quiet = inviteBox({ rekeyResult: { left: [] } });
  await quiet.ctx.renderRelayInvite({});
  await quiet.el('inv-rekey').onclick();
  assert.equal(quiet.calls.length, 1);
  // 老的 rekey 什么都不返回也照常
  const legacy = inviteBox({ rekeyResult: undefined });
  await legacy.ctx.renderRelayInvite({});
  await legacy.el('inv-rekey').onclick();
  assert.equal(legacy.calls.length, 1);
});

test('桌面端：房间里改用信令服务器：经房间链接进来的人以后断线没法自动重连，要说出来；没人经链接进来就不说', async () => {
  const r = inviteBox({ admitted: 3 });
  await r.ctx.inviteViaServer();
  assert.ok(r.relay.closed);
  assert.ok(r.calls.some(([t, k]) => t === '已停用房间链接：经它进来的 3 人之后和你断开的话没法自动重连，要重新发邀请' && k === 'warn'));
  const none = inviteBox({ admitted: 0 });
  await none.ctx.inviteViaServer();
  assert.ok(!none.calls.some(([t]) => /已停用房间链接/.test(t)));
});

/* ------------------------------ 新文案 ------------------------------ */

test('新文案两端都有英文，昵称原样保留', async () => {
  const desktop = await import(pathToFileURL(path.join(root, 'src/renderer/lib/i18n.js')).href);
  const android = await import(pathToFileURL(path.join(root, 'android/app/src/main/assets/js/i18n.js')).href);
  const cjk = /[一-鿿]/;
  const shared = [
    '房主那边一直没能和你直连，你已被移出这一场。重启 NoxReel 后再点链接，或者请房主改发一对一邀请；双方配好 TURN 更容易连上。',
    '你和房主的直连断开太久，已被移出房间。重新点一次房间链接就能回来。',
    '信令已恢复',
  ];
  for (const { translate } of [desktop, android]) {
    for (const zh of shared) assert.doesNotMatch(translate(zh, 'en'), cjk, zh);
    assert.equal(
      translate('和 Alice 的连接迟迟没建起来，重新协商', 'en'),
      'The connection to Alice is taking too long to come up; negotiating again'
    );
  }
  const t = (zh) => desktop.translate(zh, 'en');
  assert.equal(
    t('还在连接中的 小明、Bob 没跟着换过来，要进房请把新链接发给他们'),
    'Still connecting and did not move to the new link: 小明, Bob. Send them the new link if they should join'
  );
  assert.equal(
    t('已停用房间链接：经它进来的 1 人之后和你断开的话没法自动重连，要重新发邀请'),
    'Room link turned off: if the person who joined through it loses their connection to you, they can’t reconnect automatically and will need a new invite'
  );
  assert.equal(
    t('已停用房间链接：经它进来的 3 人之后和你断开的话没法自动重连，要重新发邀请'),
    'Room link turned off: if the 3 people who joined through it lose their connection to you, they can’t reconnect automatically and will need a new invite'
  );
  // 这些文案真的出自两端的代码
  for (const [label, src] of Object.entries(SOURCES)) {
    for (const line of ['信令已恢复', '你和房主的直连断开太久，已被移出房间。重新点一次房间链接就能回来。']) {
      assert.ok(src.includes(line), `${label} 里没有：${line}`);
    }
    assert.ok(src.includes('的连接迟迟没建起来，重新协商'), label);
  }
});
