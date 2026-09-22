'use strict';

/**
 * P2P 层防恶意对端（swarm 组）。
 *
 * 攻击者一律按「已通过 HELLO 握手的恶意成员」算，游客也行 —— 房间链接和信令模式是网状拓扑，
 * 任何被放进房的人都和其他每个人直接有 data / ctrl 两条通道。
 *  1. 数据帧只收这一片登记上游发来的：别人抢先塞进来的垃圾帧不参与拼片、不算速率。
 *  2. 请求超时有硬上限，往返时延和速率都钳住；超时的上游冷却、进观察期，不会每轮都被当成「最快」。
 *  3. 坏片记在真正发片的上游名下：这一片先找别人要，同一片反复坏就退避，不同的坏片攒够了拉黑。
 *  4. DoS：控制消息洪水与超大 JSON、帧头越界、PING/PONG 伪造、位图洪水、反复白要分片、
 *     聊天刷屏、弹幕积压、就绪状态刷屏、按 peerId 记的表无限增长。
 * 共享库的用例桌面端和安卓端各跑一遍。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const { IMPLS } = require('./helpers/impls');

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, (t) => fn(dir, t));
}

async function load(dir) {
  const swarmMod = await import(dir + 'swarm.js');
  const protocol = await import(dir + 'protocol.js');
  const scheduler = await import(dir + 'scheduler.js');
  return { ...swarmMod, protocol, scheduler };
}

const MB = 1024 * 1024;
const FRAME = 60 * 1024;
const CS = 2 * FRAME + 100; // 一片三帧，最后一帧短
const SLOT = 1;

const sha256 = (s) => nodeCrypto.createHash('sha256').update(s).digest('hex');
const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeManifest(tag, chunkCount, chunkSize = CS, extra = {}) {
  const hashes = Array.from({ length: chunkCount }, (_, i) => sha256(`${tag}:${i}`));
  return {
    fileId: sha256(hashes.join('')).slice(0, 32),
    name: `${tag}.mkv`,
    size: chunkCount * chunkSize,
    chunkSize,
    chunkCount,
    hashes,
    ...extra,
  };
}

/** 第 i 片的「正确内容」：每个字节都是 fillOf(i)。写盘时按它判校验过没过，等价于主进程的 SHA-256。 */
const fillOf = (i) => (i % 250) + 1;

function contentStore() {
  const writes = [];
  globalThis.window = {
    sw: {
      store: {
        async readChunk() {
          return new ArrayBuffer(16);
        },
        async writeChunk(sessionId, index, buffer) {
          const bytes = new Uint8Array(buffer);
          const ok = bytes.length > 0 && bytes.every((b) => b === fillOf(index));
          writes.push({ sessionId, index, ok });
          if (!ok) return { ok: false, reason: 'hash' };
          return { ok: true, duplicate: false, haveCount: 1, contiguousBytes: 0, complete: false };
        },
      },
    },
  };
  return writes;
}

function fakePeer(peerId, { authenticated = true, downRate = 0, rtt = 0 } = {}) {
  return {
    peerId,
    name: peerId,
    pc: { iceConnectionState: 'connected' },
    authenticated,
    remote: new Map(),
    inflight: new Set(),
    ctrl: { readyState: 'open', bufferedAmount: 0 },
    downRate,
    rtt,
    sent: [],
    chunks: [],
    charged: [],
    closed: false,
    send(m) {
      this.sent.push(m);
      return true;
    },
    chargeCtrl(bytes) {
      this.charged.push(bytes);
      return true;
    },
    on() {
      return () => {};
    },
    close() {
      this.closed = true;
    },
    async sendChunk(slot, index) {
      this.chunks.push(`${slot}:${index}`);
    },
    ping() {},
    hello() {},
  };
}

const ofType = (peer, t) => peer.sent.filter((m) => m.t === t);
const reqIdx = (peer) => ofType(peer, 'request').map((m) => m.index);
const cancelIdx = (peer) => ofType(peer, 'cancel').map((m) => m.index);

/** 把一片按线上格式切帧再解回来，得到 _onFrame 收到的那种对象。 */
function framesOf(protocol, slot, index, length, fill) {
  return protocol.encodeFrames(slot, index, new Uint8Array(length).fill(fill)).map((f) => protocol.decodeFrame(f));
}

/** 由某人把第 index 片完整送一遍（fill 不对就是垃圾）。返回每一帧是否被收下。 */
function deliver(swarm, protocol, peer, index, { fill = fillOf(index), length = CS, slot = SLOT } = {}) {
  return framesOf(protocol, slot, index, length, fill).map((f) => {
    swarm._onFrame(peer, f);
    return f.accepted === true;
  });
}

/** 把某人名下的在途请求都拨老，下一轮 _tick 就会判它们超时。 */
function ageInflight(swarm, peerId, ms = 10 * 60_000) {
  for (const info of swarm.inflight.values()) if (info.peerId === peerId) info.at -= ms;
}

/* ---------------- 真实 Peer + 假的 RTCPeerConnection（只到数据通道这一层） ---------------- */

class FakeChannel extends EventTarget {
  constructor(label) {
    super();
    this.label = label;
    this.readyState = 'open';
    this.bufferedAmount = 0;
    this.sentText = [];
  }
  send(data) {
    if (typeof data === 'string') this.sentText.push(data);
  }
  close() {
    this.readyState = 'closed';
  }
}

class FakePeerConnection {
  constructor() {
    this.iceConnectionState = 'connected';
  }
  createDataChannel(label) {
    return new FakeChannel(label);
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

async function realPeer(dir, peerId = 'peer-real') {
  globalThis.RTCPeerConnection = FakePeerConnection;
  const { Peer } = await import(dir + 'peer.js');
  const peer = new Peer({ peerId, name: peerId, initiator: true, iceServers: [] });
  const ctrlIn = (msg) => peer.ctrl.onmessage({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  const sentOf = (t) => peer.ctrl.sentText.map((s) => JSON.parse(s)).filter((m) => m.t === t);
  return { peer, ctrlIn, sentOf };
}

/* ======================= 1. 数据帧只收登记上游的 ======================= */

impl('数据帧只收这一片登记上游发来的：别人抢先塞进来的垃圾帧不参与拼片', async (dir) => {
  const { Swarm, protocol } = await load(dir);
  const writes = contentStore();
  const swarm = new Swarm({ peerId: 'victim-v', name: 'V' });
  const honest = swarm.addPeer(fakePeer('honest-h'));
  const evil = swarm.addPeer(fakePeer('evil-ee'));
  const m = makeManifest('inj', 8);
  const ctx = swarm.addFile({ slot: SLOT, manifest: m, sessionId: 's1', isSeeder: false });
  swarm._onCtrl(honest, { t: 'bitfield', s: SLOT, full: true });
  swarm.setActive(SLOT);
  assert.ok(reqIdx(honest).includes(0), '第 0 片向诚实的上游要');
  assert.equal(swarm.inflight.get(`${SLOT}:0`).peerId, 'honest-h');

  // 恶意成员从 HAVE 猜到我缺第 0 片，抢在诚实上游前面把每一帧（包括最后一帧）都塞一遍
  assert.deepEqual(deliver(swarm, protocol, evil, 0, { fill: 0xee }), [false, false, false]);
  assert.equal(writes.length, 0, '垃圾帧不能把这一片拼掉');

  assert.deepEqual(deliver(swarm, protocol, honest, 0), [true, true, true]);
  await flush();
  assert.deepEqual(
    writes.map((w) => [w.index, w.ok]),
    [[0, true]],
    '拼出来的必须是诚实上游的数据'
  );
  assert.equal(ctx.have[0], 1);
});

impl('帧头乱填、不请自来的帧一律丢掉：不拼片、不占拼装器、不算速率', async (dir) => {
  const { Swarm, protocol } = await load(dir);
  const writes = contentStore();
  const swarm = new Swarm({ peerId: 'victim-v', name: 'V' });
  const up = swarm.addPeer(fakePeer('upstream-u'));
  const m = makeManifest('hdr', 8);
  const ctx = swarm.addFile({ slot: SLOT, manifest: m, sessionId: 's1', isSeeder: false });
  swarm._onCtrl(up, { t: 'bitfield', s: SLOT, full: true });
  swarm.setActive(SLOT);
  const payload = new Uint8Array(FRAME).fill(fillOf(0));
  const bogus = [
    { slot: 0xffffffff, chunkIndex: 0, frameIndex: 0, payload },
    { slot: SLOT, chunkIndex: 0xffffffff, frameIndex: 0, payload },
    { slot: SLOT, chunkIndex: 0, frameIndex: 0xffffffff, payload },
    { slot: SLOT, chunkIndex: 0, frameIndex: 3, payload },
    { slot: SLOT, chunkIndex: 0, frameIndex: 0, payload: new Uint8Array(FRAME - 1) }, // 长度不对
    { slot: SLOT, chunkIndex: 7, frameIndex: 0, payload }, // 没向他要的片
  ];
  for (const f of bogus) {
    swarm._onFrame(up, f);
    assert.notEqual(f.accepted, true, JSON.stringify({ ...f, payload: f.payload.length }));
  }
  assert.equal(ctx.assembler.has(7), false, '没要的片不能在拼装器里占位置');
  // 同一帧重复送：第二次不算
  const [first] = framesOf(protocol, SLOT, 0, CS, fillOf(0));
  swarm._onFrame(up, first);
  assert.equal(first.accepted, true);
  const [again] = framesOf(protocol, SLOT, 0, CS, fillOf(0));
  swarm._onFrame(up, again);
  assert.notEqual(again.accepted, true);
  await flush();
  assert.equal(writes.length, 0);
});

impl('超时改派之后，前一个上游迟到的帧不再收', async (dir) => {
  const { Swarm, protocol } = await load(dir);
  const writes = contentStore();
  const swarm = new Swarm({ peerId: 'victim-v', name: 'V' });
  const slow = swarm.addPeer(fakePeer('slow-ss'));
  const good = swarm.addPeer(fakePeer('good-gg'));
  const m = makeManifest('late', 16);
  swarm.addFile({ slot: SLOT, manifest: m, sessionId: 's1', isSeeder: false });
  swarm._onCtrl(slow, { t: 'bitfield', s: SLOT, full: true });
  swarm.setActive(SLOT);
  assert.deepEqual(reqIdx(slow), [0, 1, 2, 3]);
  swarm._onCtrl(good, { t: 'bitfield', s: SLOT, full: true });

  ageInflight(swarm, 'slow-ss');
  swarm._tick();
  assert.equal(swarm.inflight.get(`${SLOT}:0`).peerId, 'good-gg', '超时的片改派给别人');

  assert.deepEqual(deliver(swarm, protocol, slow, 0), [false, false, false], '前任迟到的帧不收');
  assert.deepEqual(deliver(swarm, protocol, good, 0), [true, true, true]);
  await flush();
  assert.deepEqual(writes.map((w) => w.index), [0]);
});

impl('Peer 只把被 swarm 收下的帧计入速率：12 字节的空帧、不请自来的帧都不算', async (dir) => {
  const protocol = await import(dir + 'protocol.js');
  const { peer } = await realPeer(dir);
  const [empty] = protocol.encodeFrames(SLOT, 0, new Uint8Array(0));
  assert.equal(empty.byteLength, 12);
  for (let i = 0; i < 200; i++) peer.data.onmessage({ data: empty.buffer });
  assert.equal(peer.bytesReceived, 0, '空帧把速率撑成正数，请求超时就会被拉得很长');

  peer.on('frame', (f) => {
    if (f.chunkIndex === 5) f.accepted = true;
  });
  peer.data.onmessage({ data: protocol.encodeFrames(SLOT, 4, new Uint8Array(100))[0].buffer });
  assert.equal(peer.bytesReceived, 0);
  peer.data.onmessage({ data: protocol.encodeFrames(SLOT, 5, new Uint8Array(100))[0].buffer });
  assert.equal(peer.bytesReceived, 112);
  peer.close();
});

/* ======================= 2. 请求超时 ======================= */

impl('请求超时有硬上限：离谱的往返时延、零星几帧撑出来的小速率都拉不长', async (dir) => {
  const { Swarm } = await load(dir);
  const s = new Swarm({ peerId: 'me-local', name: 'me' });
  const deep = new Set(Array.from({ length: 12 }, (_, i) => i));
  const CH = 2 * MB;
  for (const peer of [
    { rtt: 1e13, downRate: 20e6, inflight: deep },
    { rtt: 30_000, downRate: 2000, inflight: deep },
    { rtt: 500, downRate: 1500, inflight: deep },
    { rtt: 1e9, downRate: 1e-9, inflight: deep },
  ]) {
    const t = s._requestTimeout(peer, CH);
    assert.ok(t >= 6000 && t <= 120_000, `${JSON.stringify({ ...peer, inflight: 12 })} 算出 ${t}ms`);
  }
  assert.equal(s._requestTimeout({ rtt: 50, downRate: 4, inflight: deep }, CH), 20_000, '每秒几个字节按测不出处理');
  // 正常的慢链路（64KB/s、窗口 1 片）照旧给足期望送达时间
  const expected = 300 + (CH / 64e3) * 1000;
  const t = s._requestTimeout({ rtt: 300, downRate: 64e3, inflight: new Set([1]) }, CH);
  assert.ok(t > expected && t <= 120_000, `慢链路 ${t}ms，期望送达 ${Math.round(expected)}ms`);
});

impl('PONG 只认自己发出去的 PING 的回声：伪造的 ts 改不了往返时延', async (dir) => {
  const { peer, ctrlIn } = await realPeer(dir);
  const rtts = [];
  peer.on('rtt', (v) => rtts.push(v));
  ctrlIn({ t: 'pong', ts: -1e13 });
  ctrlIn({ t: 'pong', ts: performance.now() - 5 });
  ctrlIn({ t: 'pong', ts: 'x' });
  assert.equal(peer.rtt, null);
  assert.deepEqual(rtts, []);

  peer.ping();
  const { ts } = JSON.parse(peer.ctrl.sentText.at(-1));
  ctrlIn({ t: 'pong', ts });
  assert.equal(rtts.length, 1);
  assert.ok(peer.rtt >= 0 && peer.rtt < 5000);
  ctrlIn({ t: 'pong', ts }); // 同一条回声再来：已经销账
  assert.equal(rtts.length, 1);
  peer.close();
});

impl('PING 只回数字 ts，而且按正常节奏限速：拿 PING 灌不出成倍的 PONG', async (dir) => {
  const { peer, ctrlIn, sentOf } = await realPeer(dir);
  ctrlIn({ t: 'ping', ts: 'x'.repeat(30_000) });
  ctrlIn({ t: 'ping', ts: { big: true } });
  assert.equal(sentOf('pong').length, 0);
  for (let i = 0; i < 500; i++) ctrlIn({ t: 'ping', ts: i });
  const pongs = sentOf('pong').length;
  assert.ok(pongs >= 1 && pongs <= 6, `回了 ${pongs} 条 PONG`);
  peer.close();
});

impl('超时的上游进入冷却：只有他时照样要但一次只欠一片；有别人可用时先不找他；送来好片后恢复', async (dir) => {
  const { Swarm, protocol } = await load(dir);
  contentStore();
  const swarm = new Swarm({ peerId: 'victim-v', name: 'V' });
  const slow = swarm.addPeer(fakePeer('slow-ss'));
  const m = makeManifest('cool', 16);
  swarm.addFile({ slot: SLOT, manifest: m, sessionId: 's1', isSeeder: false });
  swarm._onCtrl(slow, { t: 'bitfield', s: SLOT, full: true });
  swarm.setActive(SLOT);
  assert.deepEqual(reqIdx(slow), [0, 1, 2, 3]);

  // 他收了请求一直不发。只有他一个来源：超时后照样向他要，但只要一片
  slow.sent.length = 0;
  ageInflight(swarm, 'slow-ss');
  swarm._tick();
  assert.deepEqual(cancelIdx(slow).sort(), [0, 1, 2, 3]);
  assert.deepEqual(reqIdx(slow), [0], '观察期一次只欠一片');
  const rep = swarm._rep.get('slow-ss');
  assert.equal(rep.timeouts, 1, '同一次卡住的几片只算一次超时');

  // 来了一个正常的上游：冷却期内不再找他
  const good = swarm.addPeer(fakePeer('good-gg'));
  swarm._onCtrl(good, { t: 'bitfield', s: SLOT, full: true });
  slow.sent.length = 0;
  swarm._tick();
  assert.deepEqual(reqIdx(slow), []);
  assert.deepEqual(reqIdx(good), [1, 2, 3, 4]);
  assert.equal(swarm._peerViews(SLOT).some((v) => v.peerId === 'slow-ss'), false);

  // 冷却过了还在观察期；他把欠着的那片送来了就恢复正常
  rep.coolUntil = 0;
  assert.equal(swarm._peerViews(SLOT).find((v) => v.peerId === 'slow-ss').probation, true);
  deliver(swarm, protocol, slow, 0);
  await flush();
  assert.equal(rep.timeouts, 0);
  assert.equal(swarm._peerViews(SLOT).find((v) => v.peerId === 'slow-ss').probation, undefined);
});

impl('调度：观察期的上游排在后面，关键窗口里别人有的片不给他，只拿窗口外或只有他有的片', async (dir) => {
  const { scheduler } = await load(dir);
  const chunkSize = 2 * MB;
  // 64 片、30 秒约 8 片：关键 = 文件头 4 片 ∪ 播放窗口 ∪ 文件尾 2 片
  const manifest = { chunkCount: 64, chunkSize, size: 64 * chunkSize, durationSec: 240 };
  const s = new scheduler.Scheduler({ manifest });
  const { critical } = s.priorityList(new Uint8Array(64), 0, new Set());
  const crit = new Set(critical);
  const view = (peerId, extra = {}) => ({
    peerId,
    ready: true,
    remoteHave: new Uint8Array(64).fill(1),
    inflight: new Set(),
    downRate: 10e6,
    rtt: 20,
    ...extra,
  });
  const good = view('good', { inflight: new Set(['x1', 'x2']) });
  const prob = view('prob', { probation: true, downRate: 50e6 });
  const plan = s.plan({ have: new Uint8Array(64), playbackByte: 0, inflight: new Set(), peers: [good, prob] });
  const probPicks = plan.filter((a) => a.peerId === 'prob').map((a) => a.index);
  assert.equal(probPicks.length, 1, '观察期一次只欠一片');
  assert.equal(crit.has(probPicks[0]), false, `关键片 ${probPicks[0]} 交给了观察期的人`);

  // 关键窗口里只有他有的那一片照样给他
  const good2 = view('good', { inflight: new Set(['x1', 'x2']) });
  good2.remoteHave[0] = 0;
  const plan2 = s.plan({ have: new Uint8Array(64), playbackByte: 0, inflight: new Set(), peers: [good2, prob] });
  assert.deepEqual(plan2.filter((a) => a.peerId === 'prob').map((a) => a.index), [0]);
});

impl('慢上游的在途窗口按速率收窄：欠的片不超过他一分钟送得完的量', async (dir) => {
  const { scheduler } = await load(dir);
  const chunkSize = 2 * MB;
  const s = new scheduler.Scheduler({ manifest: { chunkCount: 100, chunkSize, size: 100 * chunkSize } });
  assert.equal(s.windowFor({ downRate: 20e3, rtt: 300 }), 1);
  assert.equal(s.windowFor({ downRate: 200e3, rtt: 300 }), Math.floor((200e3 * 60) / chunkSize));
  assert.equal(s.windowFor({ downRate: 50e6, rtt: 300 }), scheduler.MAX_INFLIGHT_CEILING, '快链路不受影响');
  assert.equal(s.windowFor({ downRate: 0, rtt: 300 }), scheduler.MAX_INFLIGHT_CEILING, '测不出速率时照旧按延迟起步');
  assert.equal(s.windowFor({ downRate: 50e6, rtt: 300, probation: true }), 1);
});

/* ======================= 3. 坏片惩罚 ======================= */

impl('坏片记在登记的上游名下；这一片有别人能给时不再找他', async (dir, t) => {
  t.mock.method(console, 'warn', () => {});
  const { Swarm, protocol } = await load(dir);
  const writes = contentStore();
  const swarm = new Swarm({ peerId: 'victim-v', name: 'V' });
  // 恶意上游报得很快：没有这条的话，调度器按速率会把这一片接着派给他
  const evil = swarm.addPeer(fakePeer('evil-ee', { downRate: 50e6 }));
  const good = swarm.addPeer(fakePeer('good-gg', { downRate: 100e3 }));
  const m = makeManifest('bad', 16);
  swarm.addFile({ slot: SLOT, manifest: m, sessionId: 's1', isSeeder: false });
  swarm._onCtrl(evil, { t: 'bitfield', s: SLOT, full: true });
  swarm.setActive(SLOT);
  assert.deepEqual(reqIdx(evil), [0, 1, 2, 3]);
  swarm._onCtrl(good, { t: 'bitfield', s: SLOT, full: true });
  const bad = [];
  swarm.on('chunk-bad', (e) => bad.push(e));

  evil.sent.length = 0;
  deliver(swarm, protocol, evil, 0, { fill: 0xee });
  await flush();
  assert.deepEqual(bad.map((e) => [e.index, e.from]), [[0, 'evil-ee']]);
  assert.equal(swarm.inflight.get(`${SLOT}:0`)?.peerId, 'good-gg', '坏掉的那片改向别人要');
  assert.equal(reqIdx(evil).includes(0), false);
  assert.equal(writes.at(-1).ok, false);
});

impl('不同的坏片攒够 4 片就不再向他要：在途撤回、报 peer-banned，断线重连也不洗白', async (dir, t) => {
  t.mock.method(console, 'warn', () => {});
  const { Swarm, protocol } = await load(dir);
  contentStore();
  const swarm = new Swarm({ peerId: 'victim-v', name: 'V' });
  const evil = swarm.addPeer(fakePeer('evil-ee', { downRate: 50e6 }));
  const m = makeManifest('ban', 32);
  swarm.addFile({ slot: SLOT, manifest: m, sessionId: 's1', isSeeder: false });
  swarm._onCtrl(evil, { t: 'bitfield', s: SLOT, full: true });
  swarm.setActive(SLOT);
  const banned = [];
  swarm.on('peer-banned', (e) => banned.push(e));

  const first = reqIdx(evil).slice(0, 4);
  for (const i of first) {
    deliver(swarm, protocol, evil, i, { fill: 0xee });
    await flush();
  }
  assert.equal(banned.length, 1);
  assert.equal(banned[0].peerId, 'evil-ee');
  assert.equal(banned[0].disconnected, false, '连接留着：他可能是房主，同步、聊天照常');
  assert.equal(evil.inflight.size, 0, '在途全部撤回');
  assert.equal([...swarm.inflight.values()].some((i) => i.peerId === 'evil-ee'), false);
  assert.equal(swarm.peerList().find((p) => p.peerId === 'evil-ee').banned, true);

  evil.sent.length = 0;
  swarm._tick();
  assert.deepEqual(reqIdx(evil), []);

  // 同一个身份换条连接回来
  const again = swarm.addPeer(fakePeer('evil-ee', { downRate: 50e6 }));
  swarm._onCtrl(again, { t: 'bitfield', s: SLOT, full: true });
  swarm._tick();
  assert.deepEqual(reqIdx(again), []);
});

impl('诚实的唯一上游偶发坏一片：当场重要；同一片反复坏只退避这一片，不拉黑；好片攒够了旧账抵消', async (dir, t) => {
  t.mock.method(console, 'warn', () => {});
  const { Swarm, protocol } = await load(dir);
  contentStore();
  const swarm = new Swarm({ peerId: 'victim-v', name: 'V' });
  const host = swarm.addPeer(fakePeer('host-hh'));
  const m = makeManifest('once', 64);
  swarm.addFile({ slot: SLOT, manifest: m, sessionId: 's1', isSeeder: false });
  swarm._onCtrl(host, { t: 'bitfield', s: SLOT, full: true });
  swarm.setActive(SLOT);
  const banned = [];
  swarm.on('peer-banned', (e) => banned.push(e));

  host.sent.length = 0;
  deliver(swarm, protocol, host, 0, { fill: 0xee });
  await flush();
  assert.ok(reqIdx(host).includes(0), '只有他有：偶发损坏当场重要');

  host.sent.length = 0;
  deliver(swarm, protocol, host, 0, { fill: 0xee }); // 同一片又坏了（他磁盘上那一片坏了）
  await flush();
  assert.equal(reqIdx(host).includes(0), false, '同一片连着坏：退避一段时间再要');
  assert.ok(reqIdx(host).length > 0, '别的片照常向他要');
  const rep = swarm._rep.get('host-hh');
  assert.equal(rep.bad.size, 1);
  assert.equal(rep.banned, false);
  assert.deepEqual(banned, []);

  // 退避过了再要
  rep.bad.get(`${SLOT}:0`).until = 0;
  host.sent.length = 0;
  swarm._tick();
  deliver(swarm, protocol, host, 1);
  await flush();
  assert.ok(reqIdx(host).includes(0));

  // 之后他一直送好片：攒够 32 片，那一笔坏账抵消
  for (let round = 0; round < 40 && rep.bad.size; round++) {
    const owed = [...swarm.inflight.values()].filter((i) => i.peerId === 'host-hh' && i.index !== 0);
    if (!owed.length) break;
    for (const info of owed) deliver(swarm, protocol, host, info.index);
    await flush();
  }
  assert.equal(rep.bad.size, 0);
});

impl('已经不向他要了还在持续灌帧：灌够了断开', async (dir, t) => {
  t.mock.method(console, 'warn', () => {});
  const { Swarm } = await load(dir);
  contentStore();
  const swarm = new Swarm({ peerId: 'victim-v', name: 'V' });
  const evil = swarm.addPeer(fakePeer('evil-ee'));
  swarm.addFile({ slot: SLOT, manifest: makeManifest('flood', 8), sessionId: 's1', isSeeder: false });
  const events = [];
  swarm.on('peer-banned', (e) => events.push(e));
  const payload = new Uint8Array(FRAME);

  // 没被拉黑的人不请自来的帧只是丢掉（诚实的上游超时撤回时也会有一点）
  for (let i = 0; i < 400; i++) swarm._onFrame(evil, { slot: SLOT, chunkIndex: 5, frameIndex: 0, payload });
  assert.equal(evil.closed, false);

  for (let i = 0; i < 4; i++) swarm._noteBad('evil-ee', SLOT, i);
  assert.equal(events.length, 1);
  for (let i = 0; i < 400 && !evil.closed; i++) {
    swarm._onFrame(evil, { slot: SLOT, chunkIndex: 5, frameIndex: 0, payload });
  }
  assert.equal(evil.closed, true);
  assert.equal(swarm.peers.has('evil-ee'), false);
  assert.equal(events.at(-1).disconnected, true);
});

/* ======================= 4. DoS ======================= */

impl('控制消息：超长的不解析直接丢；按连接限速，灌多了只丢超出的部分', async (dir) => {
  const { peer, ctrlIn } = await realPeer(dir);
  const got = [];
  peer.on('ctrl', (m) => got.push(m));
  const noisy = console.warn;
  console.warn = () => {};
  try {
    ctrlIn({ t: 'chat', text: 'x'.repeat(70 * 1024) });
    assert.equal(got.length, 0, '超过单条上限的只可能是专门喂来的大 JSON');
    ctrlIn({ t: 'chat', text: 'x'.repeat(50 * 1024) });
    assert.equal(got.length, 1, '合法大小的照常收');

    const small = JSON.stringify({ t: 'have', s: 1, index: 1 });
    for (let i = 0; i < 10_000; i++) ctrlIn(small);
    assert.ok(got.length > 3000 && got.length <= 4300, `小消息收下了 ${got.length} 条`);
    assert.ok(peer.ctrlDropped > 5000);
  } finally {
    console.warn = noisy;
    peer.close();
  }
});

impl('控制消息按字节限速；正在向他要清单时，清单分段不占预算（大文件的哈希表几十 MB 是正常的）', async (dir) => {
  const noisy = console.warn;
  console.warn = () => {};
  try {
    const big = JSON.stringify({ t: 'playlist', junk: 'x'.repeat(60 * 1000) });
    const part = JSON.stringify({ t: 'manifest-part', fileId: 'a'.repeat(32), index: 0, hashes: ['a'.repeat(60 * 1000)] });
    for (const bulk of [false, true]) {
      const { peer, ctrlIn } = await realPeer(dir);
      const got = [];
      peer.on('ctrl', (m) => got.push(m));
      peer.bulkManifest = bulk;
      for (let i = 0; i < 1000; i++) ctrlIn(part);
      if (bulk) assert.equal(got.length, 1000);
      else assert.ok(got.length < 800, `没在要清单时照样限速，收下了 ${got.length} 条`);
      const before = got.length;
      for (let i = 0; i < 1000; i++) ctrlIn(big);
      assert.ok(got.length - before < 800, `大消息收下了 ${got.length - before} 条`);
      peer.close();
    }
  } finally {
    console.warn = noisy;
  }
});

impl('swarm 只在正向这个人要清单时放行他的清单分段；不请自来的分段补记预算', async (dir) => {
  const { Swarm } = await load(dir);
  contentStore();
  const swarm = new Swarm({ peerId: 'victim-v', name: 'V' });
  const a = swarm.addPeer(fakePeer('peer-aa'));
  const b = swarm.addPeer(fakePeer('peer-bb'));
  const m = makeManifest('mf', 1300);
  swarm._onCtrl(a, { t: 'manifest-part', fileId: m.fileId, index: 0, hashes: m.hashes.slice(0, 600) });
  assert.deepEqual(a.charged, [64 * 1024]);

  const pending = swarm.requestManifest(m.fileId, { candidates: ['peer-aa', 'peer-bb'] });
  pending.catch(() => {});
  assert.equal(a.bulkManifest, true);
  assert.notEqual(b.bulkManifest, true);
  swarm._onCtrl(a, { t: 'manifest', fileId: m.fileId, missing: true }); // 他没有，换 B
  assert.equal(a.bulkManifest, false);
  assert.equal(b.bulkManifest, true);
  swarm.destroy();
});

impl('已知槽位的位图按人限速；成员表刷新合并成一次', async (dir) => {
  const { Swarm, protocol } = await load(dir);
  contentStore();
  const swarm = new Swarm({ peerId: 'victim-v', name: 'V' });
  const evil = swarm.addPeer(fakePeer('evil-ee'));
  const m = makeManifest('bf', 8);
  swarm.setCatalog([{ slot: 2, fileId: m.fileId, size: m.size, chunkCount: m.chunkCount, chunkSize: m.chunkSize }]);
  const sources = [];
  const peers = [];
  swarm.on('sources', () => sources.push(1));
  swarm.on('peers', () => peers.push(1));
  const bits = protocol.packBitfield(new Uint8Array(8).fill(1));
  for (let i = 0; i < 3000; i++) swarm._onCtrl(evil, { t: 'bitfield', s: 2, bits });
  assert.ok(sources.length >= 200 && sources.length <= 300, `处理了 ${sources.length} 条位图`);
  assert.equal(peers.length, 0, '成员表刷新不能一条位图一次');
  await sleep(300);
  assert.equal(peers.length, 1);
  assert.equal(evil.remote.get(2).have[7], 1, '限速之前的那些照常生效');
  swarm.destroy();
});

impl('同一条连接上每部片最多发两遍全片：反复白要的请求回「忙」', async (dir) => {
  const { Swarm } = await load(dir);
  contentStore();
  const swarm = new Swarm({ peerId: 'seeder-s', name: 'S' });
  const evil = swarm.addPeer(fakePeer('evil-ee'));
  const m = makeManifest('serve', 4);
  swarm.addFile({ slot: SLOT, manifest: m, sessionId: 's1', isSeeder: true });
  for (let i = 0; i < 120; i++) {
    swarm._onCtrl(evil, { t: 'request', s: SLOT, index: i % 4 });
    await flush(3);
  }
  const budget = m.chunkCount * 2 + 64;
  assert.equal(evil.chunks.length, budget);
  assert.equal(ofType(evil, 'deny').filter((d) => d.busy === true).length, 120 - budget);

  // 新连接（同一个人重连）重新计
  const again = swarm.addPeer(fakePeer('evil-ee'));
  swarm._onCtrl(again, { t: 'request', s: SLOT, index: 0 });
  await flush(3);
  assert.equal(again.chunks.length, 1);
});

impl('同一条连接上同一份清单十分钟内最多给 4 次：一条 MANIFEST_GET 换不走无数遍几十 MB 的清单', async (dir) => {
  const { Swarm } = await load(dir);
  contentStore();
  const swarm = new Swarm({ peerId: 'seeder-s', name: 'S' });
  const evil = swarm.addPeer(fakePeer('evil-ee'));
  const m = makeManifest('mget', 8);
  swarm.addFile({ slot: SLOT, manifest: m, sessionId: 's1', isSeeder: true });
  const st = () => swarm._peerState.get('evil-ee');
  for (let i = 0; i < 20; i++) {
    swarm._onCtrl(evil, { t: 'manifest-get', fileId: m.fileId });
    st().served.set(m.fileId, Date.now() - 30_001); // 每次都当作隔了 30 秒
  }
  assert.equal(ofType(evil, 'manifest').length, 4);

  // 过了统计窗口可以再要
  st().manifestServes.get(m.fileId).since -= 11 * 60_000;
  swarm._onCtrl(evil, { t: 'manifest-get', fileId: m.fileId });
  assert.equal(ofType(evil, 'manifest').length, 5);
});

impl('协议版本不符的人按 peerId 记，表有上限', async (dir) => {
  const { Swarm } = await load(dir);
  const swarm = new Swarm({ peerId: 'victim-v', name: 'V' });
  for (let i = 0; i < 400; i++) {
    const p = swarm.addPeer(fakePeer(`old-${String(i).padStart(4, '0')}`, { authenticated: false }));
    swarm._onCtrl(p, { t: 'hello', peerId: p.peerId, ver: 1 });
  }
  assert.ok(swarm.versionRejected.size <= 256);
  assert.equal(swarm.versionRejected.has('old-0399'), true, '最近的留着');
});

/* ------------------------------ 聊天与弹幕 ------------------------------ */

impl('聊天：线上原文超长直接判无效；房主换着 origin 刷屏也有总量上限，正常转发不受影响', async (dir) => {
  const chat = await import(dir + 'chat.js');
  const clock = { t: 1000 };
  const gate = new chat.ChatGate({ now: () => clock.t });
  let n = 0;
  const id = () => (++n).toString(16).padStart(12, '0');
  const ctx = (senderId) => ({ senderId, hostId: 'host-hh', selfId: 'me-mm' });

  assert.equal(gate.accept({ id: id(), text: 'x'.repeat(5000) }, ctx('guest-g')).reason, 'invalid');
  assert.equal(gate.accept({ id: id(), text: '你好' }, ctx('guest-g')).ok, true);

  // 正常：房主替 15 个人各转发一小阵（每人突发 5 条）
  let ok = 0;
  for (let u = 0; u < 15; u++) {
    for (let k = 0; k < 5; k++) ok += gate.accept({ id: id(), text: 'hi', origin: `user-${u}` }, ctx('host-hh')).ok ? 1 : 0;
  }
  assert.equal(ok, 75);

  // 恶意房主：每条换一个 origin，每只桶都是满的
  clock.t += 60_000;
  ok = 0;
  for (let i = 0; i < 1000; i++) {
    ok += gate.accept({ id: id(), text: 'spam', origin: `fake-${i}` }, ctx('host-hh')).ok ? 1 : 0;
  }
  assert.ok(ok <= chat.SENDER_BURST_TOKENS, `一口气收下了 ${ok} 条`);
  assert.ok(gate.buckets.size <= chat.MAX_BUCKETS && gate.senderBuckets.size <= chat.MAX_BUCKETS);
});

impl('聊天：昵称先截短再清洗，几十 KB 的昵称结果和截断到 40 字一致', async (dir) => {
  const chat = await import(dir + 'chat.js');
  const long = `  小明‮${'名'.repeat(100_000)}`;
  assert.equal(chat.clampName(long), `小明${'名'.repeat(38)}`);
  assert.equal(chat.clampName('  普通 昵称 '), '普通 昵称');

  // 昵称在限速之前就要清洗：逐条把几十 KB 的昵称整段清洗一遍，刷屏就能把渲染进程拖住
  const gate = new chat.ChatGate();
  const huge = '名'.repeat(60_000);
  const start = performance.now();
  for (let i = 0; i < 2000; i++) {
    gate.accept({ id: (i + 1).toString(16).padStart(12, '0'), text: 'hi', name: huge }, { senderId: 'guest-g', hostId: 'host-h' });
  }
  const spent = performance.now() - start;
  assert.ok(spent < 400, `2000 条带超长昵称的消息花了 ${Math.round(spent)}ms`);
});

impl('弹幕：帧循环停着时新消息只留最新的 MAX_PENDING 条', async (dir) => {
  const { DanmakuEngine, MAX_PENDING } = await import(dir + 'danmaku.js');
  const engine = new DanmakuEngine({ width: 1920, height: 1080 });
  for (let i = 0; i < 5000; i++) engine.push({ id: `m${i}`, text: `第${i}条` });
  assert.ok(engine.pendingCount <= MAX_PENDING, `攒了 ${engine.pendingCount} 条`);
  assert.equal(engine.dropped, 5000 - MAX_PENDING);
  const frame = engine.frame(0);
  const shown = new Set([...frame.map((d) => d.id), ...engine.pending.map((d) => d.id)]);
  assert.equal(shown.has('m4999'), true, '留下的是最新的');
  assert.equal(shown.has('m0'), false);
});

/* ------------------------------ 同步引擎 ------------------------------ */

async function makeEngine(dir, { peerId = 'me', hostId = 'host', admins = [], guests = [], seq = 1 } = {}) {
  const { SyncEngine } = await import(dir + 'syncEngine.js');
  const eng = new SyncEngine({ peerId, name: peerId, isSeeder: peerId === hostId, hostId });
  const clock = { t: 1000 };
  eng.now = () => clock.t;
  const rec = { outbound: [], relay: [], readies: [] };
  eng.on('outbound', (m) => rec.outbound.push(m));
  eng.on('relay', (e) => rec.relay.push(e));
  eng.on('ready-change', (e) => rec.readies.push(e));
  eng.onSeek = () => {};
  eng.onSetPause = () => {};
  eng.started = true;
  eng.applyRoles([...admins.map((id) => [id, 'admin']), ...guests.map((id) => [id, 'guest'])], hostId);
  eng.resetMedia({ seq });
  for (const list of Object.values(rec)) list.length = 0;
  return { eng, clock, ...rec };
}

const P = (peerId, name = peerId) => ({ peerId, name });

impl('游客反复切换就绪：事件和房主的转发按人限速，最终状态一条不丢', async (dir) => {
  const { eng, readies, relay } = await makeEngine(dir, { peerId: 'host', guests: ['gst'] });
  for (let i = 1; i <= 300; i++) eng.onCtrl({ t: 'ready', seq: 1, ready: i % 2 === 0, readySeq: i }, P('gst'));
  assert.ok(readies.length <= 20, `发了 ${readies.length} 次 ready-change`);
  assert.ok(relay.length <= 20, `转发了 ${relay.length} 条`);
  assert.equal(eng.readyPeers.get('gst').ready, true, '状态照记，是最后一条');

  await sleep(600);
  assert.equal(readies.at(-1).ready, true);
  assert.equal(readies.at(-1).who, 'gst');
  assert.equal(relay.at(-1).msg.readySeq, 300, '合并后转发的是最新的那一条');
  assert.ok(readies.length <= 21);
});

impl('房主转发来的就绪状态按 origin 记，表有上限', async (dir) => {
  const { eng } = await makeEngine(dir, { peerId: 'me' });
  for (let i = 0; i < 1000; i++) {
    eng.onCtrl({ t: 'ready', seq: 1, ready: true, readySeq: 1, origin: `fake-${i}` }, P('host'));
  }
  assert.ok(eng.readyPeers.size <= 64, `记了 ${eng.readyPeers.size} 人`);
  assert.ok(eng._readySeen.size <= 256);
  assert.ok(eng._readyBuckets.size <= 64);
});

impl('房主的角色表有上限：换着身份反复进出撑不爆 ROLE，管理员留着', async (dir) => {
  const { eng, outbound } = await makeEngine(dir, { peerId: 'host' });
  eng.setRole('adm-1', 'admin');
  for (let i = 0; i < 1000; i++) eng.hostEnsureKnown(`drifter-${'x'.repeat(100)}-${i}`);
  assert.ok(eng.roles.size <= 128, `角色表有 ${eng.roles.size} 项`);
  assert.equal(eng.roleOf('adm-1'), 'admin');
  assert.equal(eng.roles.has(`drifter-${'x'.repeat(100)}-999`), true, '刚进来的人登记着');
  const role = outbound.filter((m) => m.t === 'role').at(-1);
  assert.ok(Buffer.byteLength(JSON.stringify(role)) < 60 * 1024, 'ROLE 必须塞得进一条消息');
});

impl('游客和陌生人的 SYNC / STALL 不生效，自称替别人转发也不行', async (dir) => {
  const { eng, relay } = await makeEngine(dir, { peerId: 'me', admins: ['adm'], guests: ['gst'] });
  const before = { ...eng.shared };
  for (const from of ['gst', 'stranger']) {
    eng.onCtrl({ t: 'sync', paused: false, position: 99, lamport: 50, seq: 1, origin: 'adm' }, P(from));
    eng.onCtrl({ t: 'stall', stalled: true, position: 0, seq: 1, stallSeq: 9, origin: 'adm' }, P(from));
  }
  assert.deepEqual(eng.shared, before);
  assert.equal(eng.stalledPeers.size, 0);
  assert.deepEqual(relay, []);
});
