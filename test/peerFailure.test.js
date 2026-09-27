'use strict';

// 直连断了之后的善后（实测 E2-B / E2-C / E3-B / E3-C）。
//
//  1. 应答方一侧对方整个断网（Electron 43 实测：渲染进程挂起、进程被杀）：ICE 停在 disconnected 不再往下走，
//     connectionState 二十来秒到 failed，SCTP 却还认为通道开着。以前只看 ICE，这条连接永远不算失败 ——
//     不出 peer-gone、聊天里不说「离开了」，成员表里一直显示连着。现在 connectionState 的 failed 也算，
//     两种 failed 谁先到都只报一次；
//  2. ctrl、data 两条通道各报一次关闭，close() 自己再报一次：上层只收一次 close，
//     「X 断开了」不再写两行，swarm 的 peer-gone 也只一次；
//  3. 信令服务器早就宣布他离开、之后直连也断了：scheduleReconnect 不再空等退避，手上那条僵尸连接也摘掉
//     （以前只有退避用尽那一支会摘）。
//
// Peer 用真的（两份共用库都跑），RTCPeerConnection 换成只到状态和数据通道这一层的假货。全程不联网、不出声。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { IMPLS } = require('./helpers/impls');

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

class FakeChannel {
  constructor(label) {
    this.label = label;
    this.readyState = 'open';
    this.bufferedAmount = 0;
  }
  addEventListener() {}
  removeEventListener() {}
  send() {}
  close() {
    this.readyState = 'closed';
  }
}

class FakePeerConnection {
  constructor() {
    this.iceConnectionState = 'connected';
    this.connectionState = 'connected';
    this.iceGatheringState = 'complete';
    this.closedByUs = false;
  }
  createDataChannel(label) {
    return new FakeChannel(label);
  }
  addEventListener() {}
  removeEventListener() {}
  // pc.close() 按规范不再发任何状态事件
  close() {
    this.closedByUs = true;
    this.iceConnectionState = 'closed';
    this.connectionState = 'closed';
  }
  setIce(s) {
    this.iceConnectionState = s;
    this.oniceconnectionstatechange?.();
  }
  setConn(s) {
    this.connectionState = s;
    this.onconnectionstatechange?.();
  }
}

/** 真 Peer：应答方的两条通道经 ondatachannel 送进来，发起方自己建。记下它报出来的事件。 */
async function makePeer(dir, { initiator = false, peerId = 'jia' } = {}) {
  globalThis.RTCPeerConnection = FakePeerConnection;
  const { Peer } = await import(dir + 'peer.js');
  const peer = new Peer({ peerId, name: '甲', initiator, iceServers: [] });
  if (!initiator) {
    peer.pc.ondatachannel({ channel: new FakeChannel('ctrl') });
    peer.pc.ondatachannel({ channel: new FakeChannel('data') });
  }
  const seen = [];
  for (const ev of ['statechange', 'failed', 'close', 'disconnected']) peer.on(ev, (p) => seen.push(p === undefined ? ev : `${ev}:${p}`));
  return { peer, seen };
}

impl('应答方：ICE 停在 disconnected、connectionState 到了 failed，也按直连失败报（statechange 补一条 failed）', async (dir) => {
  const { peer, seen } = await makePeer(dir);
  peer.pc.setIce('disconnected');
  peer.pc.setConn('disconnected');
  assert.deepEqual(seen, ['statechange:disconnected', 'disconnected:disconnected']);
  peer.pc.setConn('failed');
  assert.deepEqual(seen.slice(2), ['statechange:failed', 'failed:failed'], 'connectionState 到 failed 却没当成失败：僵尸连接一直留着');
  // 之后 ICE 自己也走到 failed：不再报第二次
  peer.pc.setIce('failed');
  assert.equal(seen.filter((s) => s === 'failed:failed').length, 1);
  assert.equal(seen.filter((s) => s === 'statechange:failed').length, 1);
  peer.close();
});

impl('ICE 先报 failed、connectionState 随后也报：上层只收一次 failed；ICE 的其余状态照旧转发', async (dir) => {
  const { peer, seen } = await makePeer(dir, { initiator: true });
  peer.pc.setIce('checking');
  peer.pc.setIce('failed');
  peer.pc.setConn('failed');
  assert.deepEqual(seen, ['statechange:checking', 'statechange:failed', 'failed:failed']);
  peer.close();
});

impl('应答方对方断网：connectionState 到 failed 之后 swarm 摘掉这条连接，peer-gone 只发一次（好让「离开了」的 10 秒计时开始）', async (dir) => {
  const { Swarm } = await import(dir + 'swarm.js');
  const swarm = new Swarm({ peerId: 'yi', name: '乙' });
  const gone = [];
  swarm.on('peer-gone', (id) => gone.push(id));
  const { peer, seen } = await makePeer(dir);
  swarm.addPeer(peer);
  peer.pc.setIce('disconnected');
  assert.deepEqual(gone, [], 'ICE 刚 disconnected 就摘了：抖一下就断');
  peer.pc.setConn('failed');
  assert.deepEqual(gone, ['jia']);
  assert.equal(swarm.peers.has('jia'), false);
  assert.equal(peer.closed, true);
  assert.equal(peer.pc.closedByUs, true, 'RTCPeerConnection 没关');
  assert.equal(seen.filter((s) => s === 'close').length, 1);
  // 通道随后报关闭、ICE 随后报 failed：都不再多出一次
  peer.ctrl.onclose();
  peer.data.onclose();
  peer.pc.setIce('failed');
  assert.deepEqual(gone, ['jia']);
  assert.equal(seen.filter((s) => s === 'close').length, 1);
});

impl('对方关掉连接：ctrl、data 两条通道各报一次关闭，之后 close() 又来一次 —— 上层只收一次 close', async (dir) => {
  const { peer, seen } = await makePeer(dir, { initiator: true });
  peer.ctrl.readyState = 'closed';
  peer.ctrl.onclose();
  peer.data.readyState = 'closed';
  peer.data.onclose();
  assert.deepEqual(seen, ['close'], '两条通道各报了一次：「X 断开了」写两行、sync.peerGone 调两次');
  peer.close();
  assert.deepEqual(seen, ['close']);
  assert.equal(peer.closed, true);
});

impl('进了 swarm 的连接被对方关掉：「断开了」和 peer-gone 各一次', async (dir) => {
  const { Swarm } = await import(dir + 'swarm.js');
  const swarm = new Swarm({ peerId: 'yi', name: '乙' });
  const gone = [];
  swarm.on('peer-gone', (id) => gone.push(id));
  // app 的 wirePeer 在 addPeer 之前挂 close：这里同样先挂
  const { peer, seen } = await makePeer(dir, { initiator: true });
  swarm.addPeer(peer);
  peer.ctrl.onclose();
  peer.data.onclose();
  assert.deepEqual(seen, ['close']);
  assert.deepEqual(gone, ['jia']);
});

impl('自己主动 close()：照样报一次 close（app 靠它收尾握手定时器）', async (dir) => {
  const { peer, seen } = await makePeer(dir, { initiator: true });
  peer.close();
  peer.close();
  assert.deepEqual(seen, ['close']);
});

/* ------------------- 3. 信令早已宣布离开：scheduleReconnect 摘掉僵尸连接 ------------------- */

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

function declSource(src, name) {
  const m = new RegExp(`^(?:const|let) ${name} = ([^\\n;]*);`, 'm').exec(src);
  assert.ok(m, `没找到顶层声明 ${name}`);
  return `var ${name} = ${m[1]};`;
}

function reconnectBox(label) {
  const src = SOURCES[label];
  const events = [];
  const timers = [];
  const S = {
    peerId: 'me',
    hostId: 'host',
    swarm: {
      peers: new Map(),
      removePeer(id) {
        events.push(['remove', id]);
        this.peers.delete(id);
      },
    },
  };
  const ctx = { console, S };
  Object.assign(ctx, {
    setTimeout: (fn, ms) => timers.push(ms),
    clearTimeout: () => {},
    log: (text) => events.push(['log', text]),
    connectionAdvice: () => ({ text: '' }),
    hostReallyGone: (why) => events.push(['hostReallyGone', why]),
    reconnectPeer: async () => events.push(['rebuild']),
  });
  vm.createContext(ctx);
  const fns = ['scheduleReconnect', 'cancelRecovery', 'directLinkUp', ...(label === '桌面端' ? ['peerLinked'] : [])];
  const decls = ['RECONNECT_BACKOFF_MS', 'HANDSHAKE_TIMEOUT_MS', 'RECOVERY'];
  vm.runInContext([...decls.map((d) => declSource(src, d)), ...fns.map((f) => fnSource(src, f))].join('\n\n'), ctx);
  return { ctx, S, events, timers };
}

const wsSig = (left) => ({ connected: true, signals: [], signal(to, p) { this.signals.push([to, p]); }, hasLeft: (id) => left.includes(id) });

for (const label of Object.keys(SOURCES)) {
  test(`${label}：信令服务器早就宣布他离开，现在直连也断了（ICE disconnected、ctrl 还 open）：不再空等重连，手上那条僵尸连接摘掉`, () => {
    const r = reconnectBox(label);
    // 房主被强退：SCTP 还认为通道开着，ICE 已经 disconnected
    const zombie = { peerId: 'host', name: '房主', initiator: false, closed: false, ctrl: { readyState: 'open' }, pc: { iceConnectionState: 'disconnected' } };
    r.S.swarm.peers.set('host', zombie);
    const sig = wsSig(['host', 'm1']);
    r.ctx.scheduleReconnect(zombie, sig);
    assert.ok(r.events.some(([k, id]) => k === 'remove' && id === 'host'), '僵尸连接还留在 swarm 里');
    assert.deepEqual(sig.signals, [], '给不在信令里的人发了 renegotiate');
    assert.deepEqual(r.timers, [], '还在排退避');
    if (label === '桌面端') assert.deepEqual(r.events.at(-1), ['hostReallyGone', 'left'], '房主判离开要在摘掉之后（摘的时候横幅别再说「正在重连」）');

    // 别人一样：摘掉
    const m1 = { peerId: 'm1', name: 'Alice', initiator: true, closed: false, ctrl: { readyState: 'open' }, pc: { iceConnectionState: 'failed' } };
    r.S.swarm.peers.set('m1', m1);
    r.ctx.scheduleReconnect(m1, sig);
    assert.equal(r.S.swarm.peers.has('m1'), false);
  });

  test(`${label}：信令说离开了、手上的直连却是好的（ICE 通着、通道开着）：不动它；信令里还在的照常排重连`, () => {
    const r = reconnectBox(label);
    const healthy = { peerId: 'm2', name: 'Bob', initiator: true, closed: false, ctrl: { readyState: 'open' }, pc: { iceConnectionState: 'connected' } };
    r.S.swarm.peers.set('m2', healthy);
    // 调用方传进来的是旧连接对象，swarm 里已经换成新的好连接
    r.ctx.scheduleReconnect({ peerId: 'm2', name: 'Bob', initiator: true, closed: true }, wsSig(['m2']), { retry: true });
    assert.ok(!r.events.some(([k]) => k === 'remove'), '好好的连接被摘了');
    assert.equal(r.S.swarm.peers.get('m2'), healthy);

    const stuck = { peerId: 'm3', name: 'Carol', initiator: true, closed: false, ctrl: { readyState: 'open' }, pc: { iceConnectionState: 'disconnected' } };
    r.S.swarm.peers.set('m3', stuck);
    r.ctx.scheduleReconnect(stuck, wsSig([]));
    assert.ok(!r.events.some(([k]) => k === 'remove'), '信令里还在的人不该直接摘掉');
    assert.deepEqual(r.timers, [1500], '信令里还在的人照常退避重连');
  });
}
