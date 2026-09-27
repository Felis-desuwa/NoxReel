'use strict';

// 信令服务器断线自愈在编排层（app.js）的那一半（批次 4）。服务器和 WsSignaling 那一半见 signalingSelfHeal.test.js。
//
//  1. 信令服务器宣布某人离开时直连还开着（房主强退、崩溃、正常退出都是先断信令），之后这条直连一断
//     就是真走了：不再空等重连退避，房主的话直接判「房主已离开」，横幅不会永远停在「正在重连」；
//  2. 重连退避用尽时，最后一轮停在半路的连接摘掉，不留僵尸 Peer；
//  3. 首次加入时服务器把我记成房主 = 房间已经关了（不是冒名），文案说对，不叫人去部署服务器；
//  4. 重连后服务器认的房主和本机对不上（旧版服务器重启），说清楚，人数不跟着改；房主重连时把断线期间改的人数推回去；
//  5. 房主用信令服务器时，把经一对一邀请、房间链接进来的人数报给服务器；切回信令服务器时 S.mode 改回 'server'。
//
// 照 relaySelfHealApp 的做法把顶层函数原样抠进 vm 沙箱，定时器换成手动拨的假时钟。全程不联网、不出声。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('src/renderer/app.js');
const ANDROID = read('android/app/src/main/assets/js/app-android.js');

function fnSource(name, src = APP) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(src);
  assert.ok(m, `没找到顶层函数 ${name}`);
  const end = src.indexOf('\n}\n', m.index);
  assert.ok(end > m.index, `${name} 的结尾没找到`);
  return src.slice(m.index, end + 2);
}

function declSource(name) {
  const m = new RegExp(`^(?:const|let) ${name} = ([^\\n;]*);`, 'm').exec(APP);
  assert.ok(m, `没找到顶层声明 ${name}`);
  return `var ${name} = ${m[1]};`;
}

function stmtSource(anchor, close) {
  const i = APP.indexOf(anchor);
  assert.ok(i !== -1, `app.js 里没找到「${anchor}」`);
  const end = APP.indexOf(close, i);
  assert.ok(end > i, `「${anchor}」的结尾没找到`);
  return APP.slice(i, end + close.length);
}

let clampName = null;
test.before(async () => {
  ({ clampName } = await import(pathToFileURL(path.join(root, 'src/renderer/lib/chat.js')).href));
});

function sandbox({ fns = [], decls = [], extra = [], globals = {} }) {
  const ctx = { console, clampName, ...globals };
  vm.createContext(ctx);
  vm.runInContext([...decls.map(declSource), ...fns.map((f) => fnSource(f)), ...extra].join('\n\n'), ctx, { filename: 'app.js（节选）' });
  return ctx;
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

const plain = (x) => JSON.parse(JSON.stringify(x));

/* ------------------------------ 信令宣布离开之后 ------------------------------ */

function recoveryBox() {
  const clock = fakeClock();
  const events = [];
  const rebuilds = [];
  const S = {
    peerId: 'me',
    hostId: 'host',
    swarm: {
      peers: new Map(),
      versionRejected: new Set(),
      removePeer(id) {
        events.push(['remove', id]);
        this.peers.delete(id);
      },
    },
  };
  const ctx = sandbox({
    fns: ['scheduleReconnect', 'cancelRecovery', 'peerLinked'],
    decls: ['RECONNECT_BACKOFF_MS', 'HANDSHAKE_TIMEOUT_MS', 'RECOVERY'],
    globals: {
      S,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      log: (text, tone) => events.push(['log', text, tone]),
      connectionAdvice: () => ({ text: '（诊断）', level: 'bad' }),
      hostReallyGone: () => events.push(['hostReallyGone']),
      reconnectPeer: async (peerId) => rebuilds.push(peerId),
    },
  });
  return { ctx, S, clock, events, rebuilds };
}

function wsSig(left = []) {
  return {
    connected: true,
    signals: [],
    signal(to, payload) {
      this.signals.push([to, payload]);
    },
    hasLeft: (id) => left.includes(id),
  };
}

test('信令已宣布离开的人，直连断了不再重连：房主直接判离开，别人也不空等退避', () => {
  const r = recoveryBox();
  const sig = wsSig(['host', 'm1']);
  // 之前已经排过一次的也撤掉
  r.ctx.RECOVERY.set('host', { attempts: 1, timer: null, watch: null });
  r.ctx.scheduleReconnect({ peerId: 'host', name: '房主', initiator: false, closed: false }, sig);
  r.ctx.scheduleReconnect({ peerId: 'm1', name: 'Alice', initiator: true, closed: false }, sig);
  r.clock.advance(120_000);
  assert.deepEqual(r.events, [['hostReallyGone']], '房主强退后横幅该说「房主已离开」，别的什么都不做');
  assert.deepEqual(plain(sig.signals), [], '给不在信令里的人发了 renegotiate');
  assert.deepEqual(r.rebuilds, [], '给不在信令里的人重发了 offer');
  assert.equal(r.ctx.RECOVERY.has('host'), false);
  assert.equal(r.ctx.RECOVERY.has('m1'), false);

  // 信令里还在的人（或者信令回来了）照常退避重连；房间链接的信令没有 hasLeft，照旧
  r.ctx.scheduleReconnect({ peerId: 'm2', name: 'Bob', initiator: true, closed: false }, sig);
  const relay = { connected: true, signals: [], signal(to, p) { this.signals.push([to, p]); } };
  r.ctx.scheduleReconnect({ peerId: 'host', name: '房主', initiator: false, closed: false }, relay);
  r.clock.advance(1500);
  assert.deepEqual(r.rebuilds, ['m2']);
  assert.deepEqual(plain(relay.signals), [['host', { kind: 'renegotiate' }]]);
});

test('重连退避用尽：最后一轮停在半路的连接摘掉（房主先判离开），数据通道还开着的不动', () => {
  const r = recoveryBox();
  const sig = wsSig();
  r.S.swarm.peers.set('host', { peerId: 'host', ctrl: { readyState: 'connecting' } });
  r.ctx.RECOVERY.set('host', { attempts: 3, timer: null, watch: null });
  r.ctx.scheduleReconnect({ peerId: 'host', name: '房主', initiator: false, closed: true }, sig, { retry: true });
  assert.ok(/^和 房主 的直连试了 3 次都没恢复/.test(r.events[0][1]));
  assert.deepEqual(r.events.slice(1), [['hostReallyGone'], ['remove', 'host']], '先判离开再摘：摘的时候不该再说「正在重连」');

  r.events.length = 0;
  r.S.swarm.peers.set('m1', { peerId: 'm1', ctrl: { readyState: 'open' } });
  r.ctx.RECOVERY.set('m1', { attempts: 3, timer: null, watch: null });
  r.ctx.scheduleReconnect({ peerId: 'm1', name: 'Alice', initiator: true, closed: false }, sig);
  assert.ok(!r.events.some(([k]) => k === 'remove'), '数据通道还开着的连接被摘了');
  assert.ok(r.S.swarm.peers.has('m1'));
});

test('安卓端：信令宣布离开的人不空等重连；退避用尽时同样摘掉停在半路的连接', () => {
  const body = fnSource('scheduleReconnect', ANDROID);
  assert.match(body, /if \(sig\.hasLeft\?\.\(peerId\)\) \{\s*cancelRecovery\(peerId\);\s*return;\s*\}/);
  assert.match(body, /const stuck = S\.swarm\.peers\.get\(peerId\);\s*if \(stuck && stuck\.ctrl\?\.readyState !== 'open'\) S\.swarm\.removePeer\(peerId\);/);
});

function hostLinkBox(signaling) {
  const logs = [];
  const handlers = new Map();
  const S = {
    hostId: 'host-1',
    peerId: 'me',
    role: 'guest',
    mode: 'server',
    hostGone: false,
    hostLink: null,
    signaling,
    pendingOps: new Map(),
    swarm: { on: (name, fn) => handlers.set(name, fn), peers: new Map() },
  };
  const ctx = sandbox({
    fns: ['hostReallyGone', 'settlePendingOpsHostLost'],
    extra: [`function wire() {\n${stmtSource("  S.swarm.on('peer-gone', (peerId) => {", '\n  });')}\n}`],
    globals: {
      S,
      roomEntered: true,
      isRoomHost: () => false,
      log: (m) => logs.push(m),
      renderPlaylistSoon: () => {},
      refreshSources: () => {},
      scheduleTransferUpdate: () => {},
      renderReady: () => {},
      maybeAutoStart: () => {},
    },
  });
  ctx.wire();
  return { S, logs, gone: handlers.get('peer-gone') };
}

test('房主的数据通道关了：信令早先宣布过他离开就是真走了，否则只说「正在重连」', () => {
  const left = hostLinkBox({ hasLeft: (id) => id === 'host-1' });
  left.gone('host-1');
  assert.equal(left.S.hostGone, true, '房主强退后横幅一直停在「正在重连」');
  assert.equal(left.S.hostLink, null);
  assert.ok(left.logs.some((m) => String(m).includes('房主已离开')));

  for (const signaling of [{ hasLeft: () => false }, {}, null]) {
    const box = hostLinkBox(signaling);
    box.gone('host-1');
    assert.equal(box.S.hostGone, false, 'ICE 抖一下被说成了房主走了');
    assert.equal(box.S.hostLink, 'reconnecting');
  }
});

/* ------------------------------ 连信令 ------------------------------ */

async function signalRoom({ role = 'guest', peerId = 'me', hostId = 'host1', capacity = 8, joined } = {}) {
  const clock = fakeClock();
  const logs = [];
  const sigs = [];
  class FakeSig {
    constructor(o) {
      emitter(this);
      this.o = o;
      this.connected = true;
      this.closed = false;
      this.maxCalls = [];
      sigs.push(this);
    }
    async connect() {
      return joined;
    }
    signal() {}
    setMaxMembers(n) {
      this.maxCalls.push(n);
    }
    close() {
      this.closed = true;
    }
  }
  const S = {
    peerId,
    name: '我',
    role,
    hostId,
    roomCapacity: capacity,
    settings: { relays: '' },
    swarm: { peers: new Map(), versionRejected: new Set() },
    signaling: null,
  };
  const ctx = sandbox({
    fns: ['connectSignaling', 'directLinkUp', 'peerLinked', 'admitPeer', 'allowRebuild', 'sigLog', 'cancelRecovery', 'customRelays', 'relayList'],
    decls: [
      'MAX_PEER_NAME', 'peerName', 'MAX_LIVE_PEERS', 'REBUILD_BURST', 'REBUILD_REFILL_MS', 'rebuildBudget', 'peerCapWarned',
      'SIG_LOG_WINDOW_MS', 'SIG_LOG_MAX', 'sigLogBudget', 'RECOVERY', 'clampCapacity',
    ],
    globals: {
      S,
      crypto: globalThis.crypto,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      log: (text, tone) => logs.push([text, tone]),
      RelaySignaling: FakeSig,
      WsSignaling: FakeSig,
      DEFAULT_RELAYS: [],
      PROTOCOL_VERSION: 2,
      connectedPeerCount: () => 0,
      renderCapacityStatus: () => {},
      hostReallyGone: () => {},
      removedFromRoom: () => {},
      refreshRoomLink: async () => {},
    },
  });
  return { ctx, S, sigs, logs };
}

test('首次加入时服务器把我记成了房主：房间已经关了，报「房间已经关闭」而不是冒名；照样不进', async () => {
  const r = await signalRoom({ joined: { hostId: 'me', maxMembers: 4 } });
  await assert.rejects(r.ctx.connectSignaling('ws://sig', 'ROOM'), (e) => {
    assert.equal(e.code, 'ROOM_CLOSED');
    assert.equal(e.message, '这个房间已经关闭（房主可能已离开），请让房主重新发邀请');
    return true;
  });
  assert.equal(r.sigs[0].closed, true, '房间已关的那条信令没关掉，之后会被静默重连进去');
  // 成员也把邀请码里的人数和房主交给 WsSignaling（重连时做建房提示）
  assert.equal(r.sigs[0].o.hostId, 'host1');
  assert.equal(r.sigs[0].o.maxMembers, 8);

  // 真的对不上（房主是第三个人）仍按冒名拒
  const other = await signalRoom({ joined: { hostId: 'someone', maxMembers: 4 } });
  await assert.rejects(other.ctx.connectSignaling('ws://sig', 'ROOM'), (e) => e.message === '房主身份与邀请码不一致，已拒绝加入' && !e.code);
  // 房主自己开房不受影响
  const host = await signalRoom({ role: 'host', hostId: 'me', joined: { hostId: 'me', maxMembers: 8 } });
  assert.equal((await host.ctx.connectSignaling('ws://sig', 'ROOM')).hostId, 'me');
});

test('成员重连后服务器认的房主换了人（旧版服务器重启）：说清楚后果，人数不跟着改', async () => {
  const r = await signalRoom({ joined: { hostId: 'host1', maxMembers: 8 } });
  await r.ctx.connectSignaling('ws://sig', 'ROOM');
  const sig = r.sigs[0];
  await sig.emit('joined', { hostId: 'host1', maxMembers: 8 }); // 首次进房（WsSignaling 每次进房都发一次）
  assert.ok(!r.logs.some(([, tone]) => tone === 'bad'));

  await sig.emit('joined', { hostId: 'g1', maxMembers: 4 });
  assert.equal(r.S.roomCapacity, 8, '人数被重建房间的人带成了 4');
  assert.deepEqual(r.logs.at(-1), ['信令服务器重启后认错了房主（它可能还是旧版本）：新人暂时进不来；已经在房里的人不受影响', 'bad']);

  // 对得上就照服务器的人数来（房主断线期间改过）
  await sig.emit('joined', { hostId: 'host1', maxMembers: 10 });
  assert.equal(r.S.roomCapacity, 10);
});

test('房主重连：断线期间改过的人数推回服务器；服务器没认出他是房主时说清楚', async () => {
  const r = await signalRoom({ role: 'host', hostId: 'me', capacity: 8, joined: { hostId: 'me', maxMembers: 8 } });
  await r.ctx.connectSignaling('ws://sig', 'ROOM');
  const sig = r.sigs[0];
  await sig.emit('joined', { hostId: 'me', maxMembers: 8 });
  assert.deepEqual(sig.maxCalls, []);

  r.S.roomCapacity = 10; // 信令断着的时候改的，没发出去
  await sig.emit('joined', { hostId: 'me', maxMembers: 8 });
  assert.deepEqual(sig.maxCalls, [10]);
  assert.equal(r.S.roomCapacity, 10, '房主本机的设置被服务器那边的旧值盖掉了');

  await sig.emit('joined', { hostId: 'g1', maxMembers: 4 });
  assert.equal(r.S.roomCapacity, 10);
  assert.match(r.logs.at(-1)[0], /^信令服务器重启后没认出你是房主/);
});

test('room-config 只在人数真变了时记一行日志（旧版服务器会把没变的上限也广播一遍）', async () => {
  const r = await signalRoom({ joined: { hostId: 'host1', maxMembers: 8 } });
  await r.ctx.connectSignaling('ws://sig', 'ROOM');
  const sig = r.sigs[0];
  await sig.emit('room-config', { maxMembers: 8 });
  assert.ok(!r.logs.some(([t]) => /房间人数上限已设为/.test(t)));
  await sig.emit('room-config', { maxMembers: 6 });
  assert.deepEqual(r.logs.at(-1), ['房间人数上限已设为 6', 'good']);
  assert.equal(r.S.roomCapacity, 6);
});

test('加入信令房间时房间已关：标题「房间已关闭」，不再附「让对方改用极简模式」的部署提示', () => {
  const body = fnSource('joinViaServer');
  const i = body.indexOf("if (e.code === 'ROOM_CLOSED') return prepStop('房间已关闭', e.message);");
  assert.ok(i > 0, '房间已关没有单独的出口');
  assert.ok(i < body.indexOf('如果对方没有部署信令服务器'), '房间已关的出口要排在部署提示前面');
});

/* ------------------------------ 不经服务器进来的人 ------------------------------ */

function outsideBox(over = {}) {
  const calls = [];
  const sig = { setOutside: (n) => calls.push(n) };
  const relay = {};
  const S = {
    role: 'host',
    peerId: 'me',
    hostId: 'me',
    signalTransport: 'ws',
    signaling: sig,
    // 真的 Peer 对象（peerList() 给的是展示用的摘要，没有 via / closed）
    swarm: {
      peers: new Map(
        [
          { peerId: 'ws1', authenticated: true, closed: false, via: sig },
          { peerId: 'manual', authenticated: true, closed: false, via: null },
          { peerId: 'linked', authenticated: true, closed: false, via: relay },
          { peerId: 'pending', authenticated: false, closed: false, via: null },
          { peerId: 'gone', authenticated: true, closed: true, via: null },
        ].map((p) => [p.peerId, p])
      ),
    },
    ...over,
  };
  const ctx = sandbox({ fns: ['outsideSeats', 'syncOutsideSeats'], globals: { S } });
  return { ctx, S, calls };
}

test('房主用信令服务器：经一对一邀请、先前的房间链接进来的人数报给服务器；成员、房间链接模式不报', () => {
  const r = outsideBox();
  assert.equal(r.ctx.outsideSeats(), 2);
  r.ctx.syncOutsideSeats();
  assert.deepEqual(r.calls, [2]);

  for (const over of [{ role: 'guest', hostId: 'h' }, { signalTransport: 'relay' }, { signaling: null }, { signaling: {} }]) {
    const box = outsideBox(over);
    box.ctx.syncOutsideSeats();
    assert.deepEqual(box.calls, [], `不该报：${JSON.stringify(over)}`);
  }
  // 人进出时（握手完成、断开）都报一次
  const init = fnSource('initSwarmAndSync');
  assert.match(init, /S\.swarm\.on\('peer-authenticated', \(\) => syncOutsideSeats\(\)\);/);
  assert.match(init, /S\.swarm\.on\('peer-gone', \(\) => syncOutsideSeats\(\)\);/);
});

test('连接记下是经哪条信令建的：一对一邀请的没有', () => {
  const clock = fakeClock();
  const ctx = sandbox({
    fns: ['wirePeer'],
    decls: ['DISCONNECT_GRACE_MS', 'HANDSHAKE_TIMEOUT_MS'],
    globals: { S: { swarm: { peers: new Map() } }, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, log: () => {} },
  });
  const sig = { signal() {} };
  const viaSig = emitter({ peerId: 'a', name: 'a', initiator: true });
  ctx.wirePeer(viaSig, sig);
  assert.equal(viaSig.via, sig);
  const manual = emitter({ peerId: 'b', name: 'b', initiator: true });
  ctx.wirePeer(manual);
  assert.equal(manual.via, null);
});

test('信令服务器→一对一→信令服务器：复用手上那条信令时 S.mode 也改回 server，并把不经服务器的人数报上去', async () => {
  const synced = [];
  const connects = [];
  const S = {
    signaling: { close() {} },
    signalTransport: 'ws',
    mode: 'manual', // 中间点过「一对一邀请」
    peerId: 'host1',
    name: '房主',
    roomId: 'ROOM1',
    roomSignalUrl: 'ws://sig-a',
    roomCapacity: 4,
    roomSecurityMode: 'trusted',
    settings: { signalUrl: 'ws://sig-a' },
  };
  const els = new Map();
  const ctx = sandbox({
    fns: ['inviteViaServer', 'setFinalInviteStep'],
    globals: {
      S,
      inviteGen: 0,
      $: (id) => {
        if (!els.has(id)) els.set(id, { id, value: '', textContent: '', style: {}, classList: { toggle() {} } });
        return els.get(id);
      },
      make: (tag, o = {}, kids = []) => ({ tag, ...o, kids, style: {} }),
      replace: () => {},
      inviteStep: () => ({}),
      randomRoomId: () => 'NEW',
      connectSignaling: async (...a) => connects.push(a),
      encodeCode: async () => 'NR3-code',
      shareLink: () => 'https://example/#j/code/',
      copyCode: () => {},
      log: () => {},
      inviteMediaInfo: () => null,
      turnFetchNeeded: () => false,
      inviteBlocked: () => false,
      syncOutsideSeats: () => synced.push(S.mode),
    },
  });
  await ctx.inviteViaServer();
  assert.equal(S.mode, 'server', 'S.mode 还停在 manual：诊断写成「极简」，邀请下一位会被一次性链接盖掉');
  assert.deepEqual(connects, [], '手上有信令就不该重连');
  assert.deepEqual(synced, ['server']);
});

/* ------------------------------ 文案 ------------------------------ */

test('新文案都有英文', async () => {
  const { translate } = await import(pathToFileURL(path.join(root, 'src/renderer/lib/i18n.js')).href);
  assert.equal(
    translate('这个房间已经关闭（房主可能已离开），请让房主重新发邀请', 'en'),
    'This room has closed (the host may have left). Ask the host for a new invite.'
  );
  assert.equal(translate('房间已关闭', 'en'), 'The room is closed');
  for (const text of [
    '信令服务器重启后没认出你是房主（它可能还是旧版本）：新人拿邀请码进不来，你也改不了人数；已经在房里的人不受影响。升级信令服务器后重新开房即可恢复',
    '信令服务器重启后认错了房主（它可能还是旧版本）：新人暂时进不来；已经在房里的人不受影响',
  ]) {
    const en = translate(text, 'en');
    assert.notEqual(en, text);
    assert.doesNotMatch(en, /[一-鿿]/);
  }
});
