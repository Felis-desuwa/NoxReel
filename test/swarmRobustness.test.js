'use strict';

/**
 * swarm / peer 的健壮性回归：来源只靠 HAVE 补齐、慢链路上的分段清单、
 * 断线时挂住的发片、未知槽位暂存的内存与淘汰、以及别人给的清单里摘要管不到的字段。
 * 每条都对着一个审查里复现过的真问题，桌面端和安卓端两份共享库都跑。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const { IMPLS } = require('./helpers/impls');

const CHUNK = 1024;
const MB = 1024 * 1024;

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, (t) => fn(dir, t));
}

async function load(dir) {
  const swarmMod = await import(dir + 'swarm.js');
  const protocol = await import(dir + 'protocol.js');
  return { ...swarmMod, protocol };
}

const sha256 = (s) => nodeCrypto.createHash('sha256').update(s).digest('hex');

function makeManifest(tag, chunkCount, { chunkSize = CHUNK, tail = 0, name = `${tag}.mkv`, durationSec } = {}) {
  const hashes = Array.from({ length: chunkCount }, (_, i) => sha256(`${tag}:${i}`));
  const m = {
    fileId: sha256(hashes.join('')).slice(0, 32),
    name,
    size: chunkCount * chunkSize - tail,
    chunkSize,
    chunkCount,
    hashes,
  };
  if (durationSec !== undefined) m.durationSec = durationSec;
  return m;
}

const catalogOf = (slot, m) => ({ slot, fileId: m.fileId, size: m.size, chunkCount: m.chunkCount, chunkSize: m.chunkSize });

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
    chunks: [],
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
    async sendChunk(slot, index, buf) {
      this.chunks.push(`${slot}:${index}`);
    },
    ping() {},
    hello() {},
  };
}

/** sendChunk 由测试手动放行（或者永远不放行，模拟卡在缓冲回落上）。 */
function stuckPeer(peerId) {
  const peer = fakePeer(peerId);
  peer.pending = [];
  peer.sendChunk = (slot, index) =>
    new Promise((resolve, reject) => peer.pending.push({ key: `${slot}:${index}`, resolve, reject }));
  return peer;
}

const ofType = (peer, t) => peer.sent.filter((m) => m.t === t);
const gets = (peer) => ofType(peer, 'manifest-get').map((m) => m.fileId);

const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function track(promise) {
  const state = { done: false, value: undefined, error: undefined };
  promise.then(
    (v) => Object.assign(state, { done: true, value: v }),
    (e) => Object.assign(state, { done: true, error: e })
  );
  return state;
}

/**
 * 读盘立即成功；写盘按会话计数，收满 chunkCounts 里登记的片数就报 complete。
 * 两个 Swarm 共用 globalThis.window，所以按 sessionId 分开记。
 */
function countingStore(chunkCounts = {}) {
  const counts = new Map();
  globalThis.window = {
    sw: {
      store: {
        async readChunk() {
          return new ArrayBuffer(CHUNK);
        },
        async writeChunk(sessionId, index) {
          const seen = counts.get(sessionId) || new Set();
          const duplicate = seen.has(index);
          seen.add(index);
          counts.set(sessionId, seen);
          return {
            ok: true,
            duplicate,
            haveCount: seen.size,
            contiguousBytes: 0,
            complete: seen.size === chunkCounts[sessionId],
          };
        },
      },
    },
  };
}

const frameOf = (slot, index, len = CHUNK) => ({ slot, chunkIndex: index, frameIndex: 0, payload: new Uint8Array(len) });

/* ============ 1. 只靠 HAVE 补齐来源（swarm#0） ============ */

/**
 * 星型里中继边收边转：成员先收到中继的全 0 位图，之后只有一条条 HAVE。
 * 让 canFinish 由假变真的正是某一条 HAVE —— 不报 sources，上层就再也不会去开会话，全房干等。
 */
impl('HAVE 让对方多出一片我缺的就报 sources；重复的、本机已有的、正在收的那部不报', async (dir) => {
  const { Swarm, protocol } = await load(dir);
  countingStore();
  const swarm = new Swarm({ peerId: 'member-b', name: 'B' });
  const relay = swarm.addPeer(fakePeer('relay-a'));
  const m = makeManifest('y', 3);
  swarm.setCatalog([catalogOf(5, m)]);
  const events = [];
  swarm.on('sources', (e) => events.push(e.slot));

  swarm._onCtrl(relay, { t: 'bitfield', s: 5, bits: protocol.packBitfield(new Uint8Array(3)) });
  assert.deepEqual(events, [5]);
  assert.equal(swarm.canFinish(5), false);

  swarm._onCtrl(relay, { t: 'have', s: 5, index: 0 });
  swarm._onCtrl(relay, { t: 'have', s: 5, index: 1 });
  assert.equal(swarm.canFinish(5), false);
  const before = events.length;
  swarm._onCtrl(relay, { t: 'have', s: 5, index: 2 });
  assert.equal(swarm.canFinish(5), true);
  assert.equal(events.length, before + 1, '让 canFinish 变真的那条 HAVE 必须报 sources');

  swarm._onCtrl(relay, { t: 'have', s: 5, index: 2 });
  assert.equal(events.length, before + 1, '重复的 HAVE 不报');

  // 本机已经有的片、正在收的那部：不用上层重算
  const m6 = makeManifest('z', 3);
  swarm.addFile({
    slot: 6,
    manifest: m6,
    sessionId: 's6',
    isSeeder: false,
    state: { bitfield: protocol.packBitfield(Uint8Array.from([1, 0, 0])), haveCount: 1, contiguousBytes: CHUNK },
  });
  swarm._onCtrl(relay, { t: 'bitfield', s: 6, bits: protocol.packBitfield(new Uint8Array(3)) });
  const n6 = events.length;
  swarm._onCtrl(relay, { t: 'have', s: 6, index: 0 });
  assert.equal(events.length, n6, '本机已有的片不报');
  swarm._onCtrl(relay, { t: 'have', s: 6, index: 1 });
  assert.equal(events.length, n6 + 1, '没在收的那部，缺的片有了要报');
  swarm.setActive(6);
  assert.deepEqual(ofType(relay, 'request').map((r) => `${r.s}:${r.index}`), ['6:1']);
  swarm._onCtrl(relay, { t: 'have', s: 6, index: 2 });
  assert.equal(events.length, n6 + 1, '正在收的那部不报');
  swarm._tick();
  assert.deepEqual(
    ofType(relay, 'request').map((r) => `${r.s}:${r.index}`),
    ['6:1', '6:2'],
    '正在收的那部由调度器直接看到新片'
  );
});

impl('中继收齐时给所有已认证的人补一句 full 位图；没收齐、重复落盘都不发', async (dir) => {
  const { Swarm } = await load(dir);
  countingStore({ 'relay-5': 2 });
  const swarm = new Swarm({ peerId: 'relay-a', name: 'A' });
  const source = swarm.addPeer(fakePeer('source-c'));
  const member = swarm.addPeer(fakePeer('member-b'));
  const stranger = swarm.addPeer(fakePeer('stranger', { authenticated: false }));
  const m = makeManifest('relay', 2);
  swarm.addFile({ slot: 5, manifest: m, sessionId: 'relay-5', isSeeder: false });
  swarm._onCtrl(source, { t: 'bitfield', s: 5, full: true });
  swarm.setActive(5);
  for (const p of [source, member, stranger]) p.sent.length = 0;

  swarm._onFrame(source, frameOf(5, 0));
  await flush();
  assert.deepEqual(member.sent, [{ t: 'have', s: 5, index: 0 }]);

  swarm._onFrame(source, frameOf(5, 1));
  await flush();
  assert.deepEqual(member.sent, [
    { t: 'have', s: 5, index: 0 },
    { t: 'have', s: 5, index: 1 },
    { t: 'bitfield', s: 5, full: true },
  ]);
  assert.deepEqual(ofType(source, 'bitfield'), [{ t: 'bitfield', s: 5, full: true }]);
  assert.deepEqual(stranger.sent, []);

  // 已经收齐之后再落一次同一片（重复）：不再重发
  swarm.files.get(5).assembler.expect(1, CHUNK);
  swarm._onFrame(source, frameOf(5, 1));
  await flush();
  assert.equal(ofType(member, 'bitfield').length, 1);
});

/** 端到端：成员只连着中继，列表不再变动，全程只靠 swarm 自己的事件就要能开始收。 */
impl('极简星型：成员只连着正在收片的中继，中继收齐后成员不靠列表变动也能开始收', async (dir) => {
  const { Swarm } = await load(dir);
  const m = makeManifest('star', 3);
  countingStore({ 'relay-5': m.chunkCount });
  const relay = new Swarm({ peerId: 'relay-a', name: 'A' });
  const member = new Swarm({ peerId: 'member-b', name: 'B' });
  const memberOnRelay = fakePeer('member-b');
  const relayOnMember = fakePeer('relay-a');
  memberOnRelay.send = (x) => {
    member._onCtrl(relayOnMember, JSON.parse(JSON.stringify(x)));
    return true;
  };
  relayOnMember.send = () => true;
  relay.addPeer(memberOnRelay);
  member.addPeer(relayOnMember);
  const source = relay.addPeer(fakePeer('source-c'));

  member.setCatalog([catalogOf(5, m)]);
  // 模拟上层：每次 sources 都重算一次「能不能开始收」
  const verdicts = [];
  member.on('sources', () => verdicts.push(member.canFinish(5)));

  relay.addFile({ slot: 5, manifest: m, sessionId: 'relay-5', isSeeder: false });
  relay._onCtrl(source, { t: 'bitfield', s: 5, full: true });
  relay.setActive(5);
  assert.deepEqual(verdicts, [false]);

  for (let i = 0; i < m.chunkCount; i++) {
    relay._onFrame(source, frameOf(5, i));
    await flush();
  }
  assert.equal(relay.files.get(5).complete, true);
  assert.equal(verdicts.at(-1), true, '中继收齐后成员必须收到一次事件，而且那时已经凑得齐');
  assert.equal(relayOnMember.remote.get(5).full, true);
  relay.destroy();
  member.destroy();
});

/* ============ 2. 慢链路上的分段清单（swarm#1） ============ */

async function manifestRig(dir, n = 3) {
  const { Swarm } = await load(dir);
  countingStore();
  const swarm = new Swarm({ peerId: 'me-local', name: 'me' });
  const peers = Array.from({ length: n }, (_, i) => swarm.addPeer(fakePeer(`peer-${i + 1}`)));
  return { swarm, peers };
}

function partsOf(m, index) {
  return m.hashes.slice(index * 600, (index + 1) * 600);
}

/**
 * 清单大、链路慢时 30 秒传不完是常态（网状房间里片源上行被十几个人平分）。
 * 总时限的话每一轮都在同一处超时、从头再来，永远拿不到；分段还在陆续到就该一直等。
 */
impl('分段清单：超时从最近一段重新算，总耗时远超超时也能拿到；一段都不来才换人', async (dir, t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { swarm, peers } = await manifestRig(dir);
  const [p1, p2] = peers;
  const big = makeManifest('slow', 1300);
  const { hashes, ...meta } = big;
  const other = makeManifest('stall', 1300);
  swarm.setCatalog([catalogOf(1, big), catalogOf(2, other)]);
  const state = track(swarm.requestManifest(big.fileId, { candidates: [p1.peerId, p2.peerId], timeoutMs: 1000 }));

  t.mock.timers.tick(900);
  swarm._onCtrl(p1, { t: 'manifest-start', meta, totalParts: 3 });
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(900);
    swarm._onCtrl(p1, { t: 'manifest-part', fileId: big.fileId, index: i, hashes: partsOf(big, i) });
  }
  for (let i = 0; i < 200 && !state.done; i++) await flush(1);
  assert.equal(state.done, true);
  assert.equal(state.error, undefined);
  assert.deepEqual(state.value.hashes, hashes);
  assert.deepEqual(gets(p2), [], '一直有进展，不该换人');

  // 对照：开了头之后一段都不来，超时照常换人
  const { hashes: _h, ...otherMeta } = other;
  swarm.requestManifest(other.fileId, { candidates: [p1.peerId, p2.peerId], timeoutMs: 1000 }).catch(() => {});
  swarm._onCtrl(p1, { t: 'manifest-start', meta: otherMeta, totalParts: 3 });
  swarm._onCtrl(p1, { t: 'manifest-part', fileId: other.fileId, index: 0, hashes: partsOf(other, 0) });
  t.mock.timers.tick(999);
  assert.deepEqual(gets(p2), []);
  t.mock.timers.tick(1);
  assert.deepEqual(gets(p2), [other.fileId]);
  swarm.destroy();
});

impl('分段清单：一段一段慢慢喂也吊不住请求，总时限按段数封顶', async (dir, t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { swarm, peers } = await manifestRig(dir);
  const [p1, p2] = peers;
  const big = makeManifest('drip', 1300);
  const { hashes, ...meta } = big;
  swarm.setCatalog([catalogOf(1, big)]);
  swarm.requestManifest(big.fileId, { candidates: [p1.peerId, p2.peerId], timeoutMs: 30_000 }).catch(() => {});

  // 总时限 = 30 秒 + 3 段 × 5 秒 = 45 秒
  swarm._onCtrl(p1, { t: 'manifest-start', meta, totalParts: 3 });
  t.mock.timers.tick(29_000);
  swarm._onCtrl(p1, { t: 'manifest-part', fileId: big.fileId, index: 0, hashes: partsOf(big, 0) });
  // 同一轮里重发 START 不能把总时限往后推
  swarm._onCtrl(p1, { t: 'manifest-start', meta, totalParts: 3 });
  t.mock.timers.tick(15_000);
  swarm._onCtrl(p1, { t: 'manifest-part', fileId: big.fileId, index: 1, hashes: partsOf(big, 1) });
  t.mock.timers.tick(999);
  assert.deepEqual(gets(p2), []);
  t.mock.timers.tick(1);
  assert.deepEqual(gets(p2), [big.fileId], '到了总时限就换人');
  assert.equal(swarm._peerState.get(p1.peerId)?.manifestParts.size ?? 0, 0);
  swarm.destroy();
});

/** 对方判了超时重新来要：上一轮还卡在 ctrl 缓冲上的那轮分段不能接着发，否则每重试一次就多堵一倍。 */
impl('发清单：对方重新要了，上一轮卡着的分段不再往外发', async (dir) => {
  const { swarm } = await manifestRig(dir, 0);
  const big = makeManifest('resend', 1300);
  swarm.addFile({ slot: 1, manifest: big, sessionId: 's1', isSeeder: true });
  const p = swarm.addPeer(fakePeer('peer-slow'));
  p.ctrl.bufferedAmount = 10 * MB; // 链路慢，ctrl 缓冲一直积着
  p.sent.length = 0;

  swarm._onCtrl(p, { t: 'manifest-get', fileId: big.fileId });
  await flush();
  swarm._peerState.get(p.peerId).served.set(big.fileId, Date.now() - 30_001);
  swarm._onCtrl(p, { t: 'manifest-get', fileId: big.fileId });
  await flush();
  assert.deepEqual(p.sent.map((x) => x.t), ['manifest-start', 'manifest-start']);

  p.ctrl.bufferedAmount = 0;
  await sleep(200);
  assert.deepEqual(
    p.sent.filter((x) => x.t === 'manifest-part').map((x) => x.index),
    [0, 1, 2],
    '只有最新一轮在发'
  );
  swarm.destroy();
});

const randomHashes = (n) => Array.from({ length: n }, () => nodeCrypto.randomBytes(32).toString('hex'));

/**
 * 房主替管理员取他正在加的片：列表里还没有这一项，expect 就是管理员自己提交的条目。
 * 片数由他说了算，按段数放宽总时限的话，报个天文数字再一段段喂，请求能吊上几天、拼装数据一直涨，
 * 房主的列表操作全堵在后面；诚实的大清单走慢链路，也会拖过管理员那头 45 秒的操作超时，
 * 他已经撤片了，房主还把这一项加进列表。所以这条路上总时限仍从发出请求算起。
 */
impl('列表里还没有的片（管理员加片）：片数是对方报的，总时限不按段数放宽，从发出请求算起', async (dir, t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { swarm, peers } = await manifestRig(dir, 1);
  const [admin] = peers;
  const parts = () => swarm._peerState.get(admin.peerId)?.manifestParts.get(fileId)?.received ?? 0;

  // 恶意：分片大小 1、片数 6000 亿，START 与他提交的条目自洽，之后每秒喂一段格式合法的随机哈希
  const claimed = 600_000_000_000;
  const fileId = 'ab'.repeat(16);
  const evil = track(
    swarm.requestManifest(fileId, {
      candidates: [admin.peerId],
      expect: { size: claimed, chunkCount: claimed },
      timeoutMs: 30_000,
    })
  );
  t.mock.timers.tick(10_000);
  swarm._onCtrl(admin, {
    t: 'manifest-start',
    meta: { fileId, name: 'evil.mkv', size: claimed, chunkSize: 1, chunkCount: claimed },
    totalParts: claimed / 600,
  });
  for (let i = 0; i < 19; i++) {
    t.mock.timers.tick(1000);
    swarm._onCtrl(admin, { t: 'manifest-part', fileId, index: i, hashes: randomHashes(600) });
  }
  assert.equal(parts(), 19);
  t.mock.timers.tick(999);
  await flush();
  assert.equal(evil.done, false);
  t.mock.timers.tick(1);
  await flush();
  assert.match(evil.error?.message || '', /没有人能提供这部片的清单/, '发出请求 30 秒就放弃，分段还在来也一样');
  assert.equal(parts(), 0, '拼装数据随之释放');
  swarm._onCtrl(admin, { t: 'manifest-part', fileId, index: 19, hashes: randomHashes(600) });
  assert.equal(parts(), 0);

  // 诚实但慢：每 12 秒一段，要 36 秒才拼得齐。30 秒时就得给出结论，之后到的最后一段不再算数
  const big = makeManifest('admin-add', 1300);
  const { hashes, ...meta } = big;
  const honest = track(
    swarm.requestManifest(big.fileId, {
      candidates: [admin.peerId],
      expect: { size: big.size, chunkCount: big.chunkCount },
      timeoutMs: 30_000,
    })
  );
  swarm._onCtrl(admin, { t: 'manifest-start', meta, totalParts: 3 });
  for (const i of [0, 1]) {
    t.mock.timers.tick(12_000);
    swarm._onCtrl(admin, { t: 'manifest-part', fileId: big.fileId, index: i, hashes: partsOf(big, i) });
  }
  t.mock.timers.tick(6_000);
  await flush();
  assert.match(honest.error?.message || '', /没有人能提供这部片的清单/);
  t.mock.timers.tick(6_000);
  swarm._onCtrl(admin, { t: 'manifest-part', fileId: big.fileId, index: 2, hashes: partsOf(big, 2) });
  await flush();
  assert.equal(swarm._manifestWaiters.size, 0);

  // 对照：同一份清单进了列表之后，片数有条目作保，同样的节奏能拿到
  swarm.setCatalog([catalogOf(1, big)]);
  const listed = track(swarm.requestManifest(big.fileId, { candidates: [admin.peerId], timeoutMs: 30_000 }));
  swarm._onCtrl(admin, { t: 'manifest-start', meta, totalParts: 3 });
  for (const i of [0, 1, 2]) {
    t.mock.timers.tick(12_000);
    swarm._onCtrl(admin, { t: 'manifest-part', fileId: big.fileId, index: i, hashes: partsOf(big, i) });
  }
  for (let i = 0; i < 200 && !listed.done; i++) await flush(1);
  assert.equal(listed.error, undefined);
  assert.deepEqual(listed.value.hashes, hashes);
  swarm.destroy();
});

/**
 * 管理员那头加片失败（例如等房主超时）会撤回清单、关掉做种会话。
 * 这时还在往外发的分段得停下：发完的话房主照样拼得齐，把一部谁都没有的片加进列表。
 */
impl('发清单：本机撤回了这份清单，剩下的分段不再发；清单只是换了挂法（转成本机做种）照常发完', async (dir) => {
  const { swarm } = await manifestRig(dir, 0);
  const big = makeManifest('withdrawn', 1300);
  swarm.offerManifest(big);
  const h = swarm.addPeer(fakePeer('host-h'));
  h.ctrl.bufferedAmount = 10 * MB;
  swarm._onCtrl(h, { t: 'manifest-get', fileId: big.fileId });
  await flush();
  assert.deepEqual(h.sent.map((x) => x.t), ['manifest-start']);
  swarm.withdrawManifest(big.fileId);
  h.ctrl.bufferedAmount = 0;
  await sleep(200);
  assert.deepEqual(ofType(h, 'manifest-part'), [], '撤回之后一段都不能再发');

  // 对照：从「挂出清单」换成「本机做种」，清单还在，照常发完
  swarm.offerManifest(big);
  swarm._peerState.get(h.peerId).served.clear();
  h.sent.length = 0;
  h.ctrl.bufferedAmount = 10 * MB;
  swarm._onCtrl(h, { t: 'manifest-get', fileId: big.fileId });
  await flush();
  swarm.addFile({ slot: 1, manifest: big, sessionId: 's1', isSeeder: true });
  h.ctrl.bufferedAmount = 0;
  await sleep(200);
  assert.deepEqual(
    ofType(h, 'manifest-part').map((x) => x.index),
    [0, 1, 2]
  );
  swarm.destroy();
});

/**
 * GET 发出去，对方在 send 里就同步回了 START（测试里的假连接就是这样）：
 * 定时器要是在 send 之后才设，START 续期的那个就被顶掉没人清，到点再换一次人，
 * 把正拼到一半的清单扔掉。结束了的请求再被叫到，也不能去动同一个人给新请求拼的那份。
 */
impl('清单请求：对方在 send 里同步回了 START，续期不被顶掉；结束了的请求再被叫到也不动新一轮的拼装', async (dir, t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { swarm, peers } = await manifestRig(dir, 2);
  const [x, y] = peers;
  const big = makeManifest('sync', 1300);
  const { hashes, ...meta } = big;
  swarm.setCatalog([catalogOf(1, big)]);
  x.send = function (m) {
    this.sent.push(m);
    if (m.t === 'manifest-get') swarm._onCtrl(x, { t: 'manifest-start', meta, totalParts: 3 });
    return true;
  };
  const part = (i) => swarm._onCtrl(x, { t: 'manifest-part', fileId: big.fileId, index: i, hashes: partsOf(big, i) });

  const first = track(swarm.requestManifest(big.fileId, { candidates: [x.peerId, y.peerId], timeoutMs: 1000 }));
  const w1 = swarm._manifestWaiters.get(big.fileId);
  // 每 900ms 一段：从 START 算的 1 秒到了也不能换人
  for (const i of [0, 1, 2]) {
    t.mock.timers.tick(900);
    part(i);
  }
  for (let i = 0; i < 200 && !first.done; i++) await flush(1);
  assert.equal(first.error, undefined);
  assert.deepEqual(first.value.hashes, hashes);
  assert.deepEqual(gets(y), [], '一直有进展，不该换人');
  t.mock.timers.tick(5_000);
  assert.deepEqual(gets(y), [], '拿到之后不能还有定时器去换人');

  // 同一个人又在为新的请求拼这份清单时，旧请求被叫到（比如残留的定时器）
  const second = track(swarm.requestManifest(big.fileId, { candidates: [x.peerId], timeoutMs: 1000 }));
  part(0);
  swarm._askNext(w1);
  part(1);
  part(2);
  for (let i = 0; i < 200 && !second.done; i++) await flush(1);
  assert.equal(second.error, undefined);
  assert.deepEqual(second.value.hashes, hashes);
  swarm.destroy();
});

/* ============ 3. 分段清单的校验与清理（security#3） ============ */

impl('换人时清掉上一个人拼到一半的分段；候选用完时也清', async (dir, t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { swarm, peers } = await manifestRig(dir);
  const [x, h] = peers;
  const big = makeManifest('left', 1300);
  const { hashes, ...meta } = big;
  const parts = (p) => swarm._peerState.get(p.peerId)?.manifestParts.size ?? 0;
  const pending = swarm.requestManifest(big.fileId, { candidates: [x.peerId, h.peerId], timeoutMs: 200 });

  swarm._onCtrl(x, { t: 'manifest-start', meta, totalParts: 3 });
  swarm._onCtrl(x, { t: 'manifest-part', fileId: big.fileId, index: 0, hashes: partsOf(big, 0) });
  assert.equal(parts(x), 1);
  t.mock.timers.tick(200);
  assert.deepEqual(gets(h), [big.fileId]);
  assert.equal(parts(x), 0, '超时换人后，上一个人的半截清单不能留着');

  swarm._onCtrl(h, { t: 'manifest-start', meta, totalParts: 3 });
  swarm._onCtrl(h, { t: 'manifest-part', fileId: big.fileId, index: 0, hashes: partsOf(big, 0) });
  assert.equal(parts(h), 1);
  t.mock.timers.tick(200);
  await assert.rejects(pending, /没有人能提供这部片的清单/);
  assert.equal(parts(h), 0, '候选用完放弃时也要清');
});

impl('START 的片数、大小和列表条目对不上立即换人，不开拼装位；天文数字的分段数不抛错', async (dir, t) => {
  t.mock.method(console, 'warn', () => {});
  const { swarm, peers } = await manifestRig(dir, 3);
  const [x, y, h] = peers;
  const big = makeManifest('huge', 1300);
  const { hashes, ...meta } = big;
  const bad = [];
  swarm.on('manifest-bad', (e) => bad.push(e.from));
  const parts = (p) => swarm._peerState.get(p.peerId)?.manifestParts.size ?? 0;

  const pending = swarm.requestManifest(big.fileId, {
    candidates: [x.peerId, y.peerId, h.peerId],
    expect: { size: big.size, chunkCount: big.chunkCount },
  });
  // 片数和分段数自洽，但比列表条目大得多
  const inflated = { ...meta, chunkCount: 600_000_000, size: 600_000_000 * CHUNK };
  swarm._onCtrl(x, { t: 'manifest-start', meta: inflated, totalParts: 1_000_000 });
  assert.equal(parts(x), 0);
  assert.deepEqual(gets(y), [big.fileId]);
  // 片数对得上、大小对不上
  swarm._onCtrl(y, { t: 'manifest-start', meta: { ...meta, size: big.size + 1 }, totalParts: 3 });
  assert.equal(parts(y), 0);
  assert.deepEqual(gets(h), [big.fileId]);
  assert.deepEqual(bad, [x.peerId, y.peerId]);

  swarm._onCtrl(h, { t: 'manifest-start', meta, totalParts: 3 });
  for (let i = 0; i < 3; i++) {
    swarm._onCtrl(h, { t: 'manifest-part', fileId: big.fileId, index: i, hashes: partsOf(big, i) });
  }
  assert.deepEqual((await pending).hashes, hashes);

  // 没有列表条目可对照时（管理员加片），片数报到 2^53 也不能让 new Array 抛出来
  const lone = makeManifest('lone', 1300);
  const { hashes: _l, ...loneMeta } = lone;
  const edge = Number.MAX_SAFE_INTEGER;
  const rejected = swarm.requestManifest(lone.fileId, { candidates: [x.peerId] });
  assert.doesNotThrow(() =>
    swarm._onCtrl(x, {
      t: 'manifest-start',
      meta: { ...loneMeta, chunkCount: edge, size: edge },
      totalParts: Math.ceil(edge / 600),
    })
  );
  await assert.rejects(rejected, /没有人能提供这部片的清单/);
  assert.equal(parts(x), 0);
});

/**
 * 接收方取清单时（桌面 openLeechFor、安卓 ensureCurrentSession）expect 里只有大小、片数和时长。
 * 列表里有这部片，就连分片大小也按条目核对：同一组哈希换个切法，摘要照样对得上，
 * 但每一片的边界都错了，一片也收不下来。
 */
impl('列表里有这部片时，调用方没传的分片大小、片数也按条目核对', async (dir, t) => {
  t.mock.method(console, 'warn', () => {});
  const { swarm, peers } = await manifestRig(dir, 3);
  const [x, y, h] = peers;
  const bad = [];
  swarm.on('manifest-bad', (e) => bad.push(e.from));
  const parts = (p) => swarm._peerState.get(p.peerId)?.manifestParts.size ?? 0;

  // 不分段：4 片 × 1024 字节，冒充成每片 1300 字节（片数照样是 4）
  const m = makeManifest('cut', 4);
  swarm.setCatalog([catalogOf(1, m)]);
  const small = swarm.requestManifest(m.fileId, {
    candidates: [x.peerId, h.peerId],
    expect: { size: m.size, chunkCount: m.chunkCount, durationSec: 0 },
  });
  swarm._onCtrl(x, { t: 'manifest', manifest: { ...m, chunkSize: 1300 } });
  await flush();
  assert.deepEqual(bad, [x.peerId]);
  swarm._onCtrl(h, { t: 'manifest', manifest: m });
  assert.equal((await small).chunkSize, CHUNK);

  // 分段：START 就对不上，不开拼装位
  const big = makeManifest('cut-big', 1300);
  const { hashes, ...meta } = big;
  swarm.setCatalog([catalogOf(1, m), catalogOf(2, big)]);
  const segmented = swarm.requestManifest(big.fileId, { candidates: [x.peerId, y.peerId, h.peerId], expect: {} });
  swarm._onCtrl(x, { t: 'manifest-start', meta: { ...meta, chunkSize: CHUNK + 1 }, totalParts: 3 });
  assert.equal(parts(x), 0);
  // 大小、分片大小都对，只把片数报大：列表作保的总时限是按片数放宽的，不能让他借此吊住请求
  swarm._onCtrl(y, { t: 'manifest-start', meta: { ...meta, chunkCount: 600_000_000 }, totalParts: 1_000_000 });
  assert.equal(parts(y), 0);
  assert.deepEqual(bad, [x.peerId, x.peerId, y.peerId]);
  swarm._onCtrl(h, { t: 'manifest-start', meta, totalParts: 3 });
  for (let i = 0; i < 3; i++) {
    swarm._onCtrl(h, { t: 'manifest-part', fileId: big.fileId, index: i, hashes: partsOf(big, i) });
  }
  assert.deepEqual((await segmented).hashes, hashes);

  // 列表条目没记分片大小（旧条目）时不拿它卡人
  swarm.setCatalog([{ ...catalogOf(1, m), chunkSize: 0 }]);
  const legacy = swarm.requestManifest(m.fileId, { candidates: [x.peerId] });
  swarm._onCtrl(x, { t: 'manifest', manifest: m });
  assert.equal((await legacy).fileId, m.fileId);
});

impl('分段的条数或内容不对：当场判这个人给不出清单，丢掉他的拼装数据', async (dir, t) => {
  t.mock.method(console, 'warn', () => {});
  const { swarm, peers } = await manifestRig(dir, 3);
  const [x, y, h] = peers;
  const big = makeManifest('shape', 1300);
  const { hashes, ...meta } = big;
  const bad = [];
  swarm.on('manifest-bad', (e) => bad.push(e.from));
  const parts = (p) => swarm._peerState.get(p.peerId)?.manifestParts.size ?? 0;
  const pending = swarm.requestManifest(big.fileId, { candidates: [x.peerId, y.peerId, h.peerId] });

  // 中间段少一项
  swarm._onCtrl(x, { t: 'manifest-start', meta, totalParts: 3 });
  swarm._onCtrl(x, { t: 'manifest-part', fileId: big.fileId, index: 1, hashes: partsOf(big, 1).slice(1) });
  assert.equal(parts(x), 0);
  assert.deepEqual(gets(y), [big.fileId]);

  // 条数对，但每项是 400 字的垃圾：一段就能塞进约 256KB
  swarm._onCtrl(y, { t: 'manifest-start', meta, totalParts: 3 });
  swarm._onCtrl(y, { t: 'manifest-part', fileId: big.fileId, index: 0, hashes: Array(600).fill('x'.repeat(400)) });
  assert.equal(parts(y), 0);
  assert.deepEqual(gets(h), [big.fileId]);
  assert.deepEqual(bad, [x.peerId, y.peerId]);

  // 末段条数不对同样不收；之后他再发什么都不算
  swarm._onCtrl(h, { t: 'manifest-start', meta, totalParts: 3 });
  swarm._onCtrl(h, { t: 'manifest-part', fileId: big.fileId, index: 0, hashes: partsOf(big, 0) });
  swarm._onCtrl(h, { t: 'manifest-part', fileId: big.fileId, index: 1, hashes: partsOf(big, 1) });
  swarm._onCtrl(h, { t: 'manifest-part', fileId: big.fileId, index: 2, hashes: partsOf(big, 2).slice(0, 50) });
  await assert.rejects(pending, /没有人能提供这部片的清单/);
  assert.equal(parts(h), 0);
  assert.deepEqual(bad, [x.peerId, y.peerId, h.peerId]);

  // 对照：格式都对的分段照常收下
  const ok = swarm.requestManifest(big.fileId, { candidates: [h.peerId] });
  swarm._onCtrl(h, { t: 'manifest-start', meta, totalParts: 3 });
  for (let i = 0; i < 3; i++) {
    swarm._onCtrl(h, { t: 'manifest-part', fileId: big.fileId, index: i, hashes: partsOf(big, i) });
  }
  assert.deepEqual((await ok).hashes, hashes);
});

/* ============ 4. 断线时挂住的发片（swarm#2 / main-invariants#1） ============ */

class FakeChannel extends EventTarget {
  constructor(label) {
    super();
    this.label = label;
    this.readyState = 'open';
    this.bufferedAmount = 0;
    this.binaryType = '';
    this.sentFrames = 0;
    this.sentText = [];
    this.listeners = 0;
  }
  addEventListener(type, fn, opts) {
    this.listeners++;
    super.addEventListener(type, fn, opts);
  }
  removeEventListener(type, fn, opts) {
    this.listeners--;
    super.removeEventListener(type, fn, opts);
  }
  send(data) {
    if (this.readyState !== 'open') throw new Error('InvalidStateError');
    if (typeof data === 'string') this.sentText.push(data);
    else {
      this.sentFrames++;
      this.bufferedAmount += data.byteLength;
    }
  }
  // 按规范：关闭时缓冲不归零，也不会有 bufferedamountlow
  close() {
    this.readyState = 'closed';
  }
}

class FakePeerConnection {
  constructor() {
    this.iceConnectionState = 'connected';
    this.channels = [];
  }
  createDataChannel(label) {
    const ch = new FakeChannel(label);
    this.channels.push(ch);
    return ch;
  }
  addEventListener() {}
  removeEventListener() {}
  // pc.close() 属于突然关闭：通道上什么事件都不发
  close() {
    for (const ch of this.channels) ch.readyState = 'closed';
  }
}

async function realPeer(dir, peerId = 'peer-slow') {
  globalThis.RTCPeerConnection = FakePeerConnection;
  const { Peer } = await import(dir + 'peer.js');
  const peer = new Peer({ peerId, name: peerId, initiator: true, iceServers: [] });
  peer.data.bufferedAmount = 5 * MB; // 高于 4MB 高水位，下一帧就得等
  return peer;
}

impl('Peer.close()：等缓冲回落的 sendChunk 立即结束，不因 pc.close 不发事件而永远挂着', async (dir) => {
  const peer = await realPeer(dir);
  const base = peer.data.listeners;
  const state = track(peer.sendChunk(1, 0, new ArrayBuffer(10)));
  await flush();
  assert.equal(state.done, false, '缓冲超过高水位时要等');
  assert.ok(peer.data.listeners > base);

  peer.close();
  await flush();
  assert.equal(state.done, true, '连接关了，等待必须落定');
  assert.match(String(state.error?.message), /关闭/);
  assert.equal(peer.data.sentFrames, 0);
  assert.equal(peer.data.listeners, base, '监听要摘干净');
});

impl('Peer：对端关掉 data 通道或通道出错时等待结束；缓冲回落时照常接着发', async (dir) => {
  for (const event of ['close', 'error']) {
    const peer = await realPeer(dir);
    const base = peer.data.listeners;
    const state = track(peer.sendChunk(1, 0, new ArrayBuffer(10)));
    await flush();
    assert.equal(state.done, false);
    peer.data.readyState = 'closed';
    peer.data.dispatchEvent(new Event(event));
    await flush();
    assert.equal(state.done, true, `${event} 事件后等待必须落定`);
    assert.ok(state.error, `${event} 事件后这片没发出去，要报错`);
    assert.equal(peer.data.listeners, base);
  }

  const peer = await realPeer(dir);
  const base = peer.data.listeners;
  const state = track(peer.sendChunk(1, 0, new ArrayBuffer(10)));
  await flush();
  peer.data.bufferedAmount = 0;
  peer.data.dispatchEvent(new Event('bufferedamountlow'));
  await flush();
  assert.equal(state.done, true);
  assert.equal(state.error, undefined);
  assert.equal(peer.data.sentFrames, 1);
  assert.equal(peer.data.listeners, base);
  peer.close();
});

/**
 * 「当前这部优先」的份额按连接记。人走了就当场作废：挂住的发送不一定会落定，
 * 等它来扣的话，别人排着的后面几部就永远发不出去（按列表预传对这个片源彻底失效）。
 */
impl('removePeer：正在给他发的当前这部当场作废，别人排着的后面几部立刻开始；旧连接迟到的收尾不扣新连接的份额', async (dir) => {
  const { Swarm } = await load(dir);
  countingStore();
  const swarm = new Swarm({ peerId: 'host', name: 'host' });
  swarm.addFile({ slot: 1, manifest: makeManifest('now', 8), sessionId: 's1', isSeeder: true });
  swarm.addFile({ slot: 2, manifest: makeManifest('next', 8), sessionId: 's2', isSeeder: true });
  swarm.setPlaying(1);
  const x = swarm.addPeer(stuckPeer('peer-xx'));
  const y = swarm.addPeer(fakePeer('peer-yy'));
  const req = (p, s, index) => swarm._onCtrl(p, { t: 'request', s, index });

  req(x, 1, 0);
  await flush();
  assert.deepEqual(x.pending.map((e) => e.key), ['1:0']);
  assert.equal(swarm._servingPriority, 1);
  req(y, 2, 0);
  await flush();
  assert.deepEqual(y.chunks, [], '当前这部还在发，后面几部先等着');

  // X 掉线：那次发送永远不落定
  swarm.removePeer(x.peerId);
  assert.equal(swarm._servingPriority, 0);
  assert.equal(swarm._priorityServing.has(x), false, '不能一直攥着已经关掉的连接');
  await flush();
  assert.deepEqual(y.chunks, ['2:0']);

  // 同一个人重连，新连接又在收当前这部
  const x2 = swarm.addPeer(stuckPeer('peer-xx'));
  req(x2, 1, 1);
  await flush();
  assert.equal(swarm._servingPriority, 1);
  x.pending[0].resolve(); // 旧连接的发送这时才落定
  await flush();
  assert.equal(swarm._servingPriority, 1, '旧连接的收尾不能扣新连接的份额');
  req(y, 2, 1);
  await flush();
  assert.deepEqual(y.chunks, ['2:0'], '新连接还在收当前这部，Y 继续等');

  x2.pending[0].resolve();
  await flush();
  assert.equal(swarm._servingPriority, 0);
  assert.deepEqual(y.chunks, ['2:0', '2:1']);
});

/** 端到端：真实 Peer 卡在缓冲回落上时对方掉线，发片端要能恢复。 */
impl('真实 Peer 卡在缓冲上时对方掉线：发送落定，后面几部照常发给别人', async (dir, t) => {
  t.mock.method(console, 'warn', () => {});
  const { Swarm } = await load(dir);
  countingStore();
  const swarm = new Swarm({ peerId: 'host', name: 'host' });
  swarm.addFile({ slot: 1, manifest: makeManifest('now', 8), sessionId: 's1', isSeeder: true });
  swarm.addFile({ slot: 2, manifest: makeManifest('next', 8), sessionId: 's2', isSeeder: true });
  swarm.setPlaying(1);
  const slow = await realPeer(dir, 'peer-slow');
  slow.authenticated = true;
  swarm.addPeer(slow);
  const other = swarm.addPeer(fakePeer('peer-yy'));

  swarm._onCtrl(slow, { t: 'request', s: 1, index: 0 });
  swarm._onCtrl(other, { t: 'request', s: 2, index: 0 });
  await flush();
  assert.equal(slow.data.sentFrames, 0);
  assert.deepEqual(other.chunks, []);

  // 对端断开：ICE failed → removePeer → Peer.close() → pc.close()，通道上不会再有任何事件
  slow.pc.iceConnectionState = 'failed';
  swarm.removePeer(slow.peerId);
  await flush();
  assert.equal(swarm._servingPriority, 0);
  assert.deepEqual(other.chunks, ['2:0']);
  assert.equal(swarm._serving.has('peer-slow'), false);
});

/* ============ 5. 未知槽位暂存（swarm#3 / security#4） ============ */

/**
 * 列表还没到时，中继那边位图之后紧跟着一串 HAVE。按条数先进先出会把最老的位图挤掉，
 * 而位图对方只发一次 —— 这个人从此只剩后来零星的几片。
 */
impl('暂存被 HAVE 灌满时先挤 HAVE，位图留着；挤掉的 HAVE 折进位图，列表到了之后一片不少', async (dir) => {
  const { Swarm, protocol } = await load(dir);
  countingStore();
  const swarm = new Swarm({ peerId: 'member-d', name: 'D' });
  const c = swarm.addPeer(fakePeer('relay-c'));
  const m = makeManifest('flood', 1200);
  const bits = new Uint8Array(1200);
  bits.fill(1, 0, 600);
  swarm._onCtrl(c, { t: 'bitfield', s: 3, bits: protocol.packBitfield(bits) });
  for (let i = 600; i < 900; i++) swarm._onCtrl(c, { t: 'have', s: 3, index: i });
  const st = swarm._peerState.get('relay-c');
  assert.equal(st.unknown.length, 256);
  assert.equal(st.unknown[0].msg.t, 'bitfield');

  // 补放几百条 HAVE 时，sources 每个槽位只报一次（上层每次都要把 canFinish 整张扫一遍）
  const events = [];
  swarm.on('sources', (e) => events.push(e.slot));
  swarm.setCatalog([catalogOf(3, m)]);
  assert.deepEqual(events, [3]);
  const have = c.remote.get(3).have;
  assert.equal(have.slice(0, 600).every((b) => b === 1), true, '位图里的 600 片都得在');
  // 挤掉的 45 条 HAVE 折进了位图：中继收不齐时他不会再发 full，丢了就再也补不回来
  assert.equal(have.slice(600, 900).every((b) => b === 1), true, '挤掉的 HAVE 也都还在');
  assert.equal(have.reduce((a, b) => a + b, 0), 900);
  assert.equal(st.unknown.length, 0);
});

impl('暂存只留补放要用的字段；超长的位图不收；同一槽位的整张位图只留最新；按字数封顶', async (dir) => {
  const { Swarm, protocol } = await load(dir);
  countingStore();
  const swarm = new Swarm({ peerId: 'victim', name: 'V' });
  const evil = swarm.addPeer(fakePeer('evil-e'));
  const st = () => swarm._peerState.get('evil-e');
  const chars = () => st().unknown.reduce((a, e) => a + (e.msg.bits?.length || 0), 0);

  // 远超一段合法长度的位图：补放时本来就解不出来，暂存时直接不收
  for (let i = 0; i < 300; i++) swarm._onCtrl(evil, { t: 'bitfield', s: 999, bits: 'A'.repeat(250_000) });
  assert.equal(st()?.unknown.length ?? 0, 0);
  for (const bogus of [{ bits: 42 }, { bits: ['A'] }, { bits: 'AAAA', offset: 123 }, { bits: 'AAAA', offset: -240000 }]) {
    swarm._onCtrl(evil, { t: 'bitfield', s: 998, ...bogus });
  }
  assert.equal(st()?.unknown.length ?? 0, 0);

  // 合法长度，但夹带大字段：只留 t/s/bits
  const legit = 'A'.repeat(40_000);
  swarm._onCtrl(evil, { t: 'bitfield', s: 997, bits: legit, junk: 'x'.repeat(100_000), nested: [[], {}] });
  swarm._onCtrl(evil, { t: 'have', s: 996, index: 3, junk: 'y'.repeat(100_000) });
  swarm._onCtrl(evil, { t: 'bitfield', s: 995, full: true, bits: legit, junk: 1 });
  swarm._onCtrl(evil, { t: 'bitfield', s: 994, bits: 'AAAA', offset: '240000' });
  assert.deepEqual(
    st().unknown.map((e) => e.msg),
    [
      { t: 'bitfield', s: 997, bits: legit },
      { t: 'have', s: 996, index: 3 },
      { t: 'bitfield', s: 995, full: true },
      { t: 'bitfield', s: 994, bits: 'AAAA', offset: 240000 },
    ]
  );

  // 同一槽位反复发整张位图：只留最新一条，连同它之前的 HAVE 一起换掉
  swarm._onCtrl(evil, { t: 'have', s: 997, index: 1 });
  for (let i = 0; i < 300; i++) swarm._onCtrl(evil, { t: 'bitfield', s: 997, bits: `${'B'.repeat(39_996)}${String(i).padStart(4, '0')}` });
  const of997 = st().unknown.filter((e) => e.msg.s === 997);
  assert.equal(of997.length, 1);
  assert.equal(of997[0].msg.bits.endsWith('0299'), true);

  // 换 300 个槽位各发一张：总字数封顶，留下的是最新的
  for (let s = 0; s < 300; s++) swarm._onCtrl(evil, { t: 'bitfield', s: 10_000 + s, bits: legit });
  assert.ok(chars() <= 2 * MB, `暂存了 ${chars()} 字`);
  assert.ok(chars() > 2 * MB - 40_004);
  assert.equal(st().unknown.at(-1).msg.s, 10_299);
  assert.ok(st().unknown.length <= 256);
});

/**
 * 分段位图：同一段只留最新的；新的第一段会整张重来，之前的段和 HAVE 都没用了。
 * 暂存再怎么压缩，补放出来的结果都必须和「当时就认识这个槽位、逐条收下」完全一致。
 */
impl('分段位图的暂存：同一段只留最新，第一段整套换掉；补放结果和直接收到的一致', async (dir) => {
  const { Swarm, protocol } = await load(dir);
  countingStore();
  const PART = protocol.BITFIELD_CHUNKS_PER_PART;
  const count = PART * 2 + 1000;
  const m = makeManifest('seg', 1);
  const entry = { slot: 7, fileId: m.fileId, size: count * 2 * MB, chunkCount: count, chunkSize: 2 * MB };

  const pattern = (seed) => {
    const have = new Uint8Array(count);
    for (let i = 0; i < count; i++) have[i] = (i * 7 + seed) % 5 === 0 ? 1 : 0;
    return have;
  };
  const seg = (have, index) => {
    const offset = index * PART;
    return { t: 'bitfield', s: 7, offset, bits: protocol.packBitfield(have, offset, Math.min(count, offset + PART)) };
  };
  const v1 = pattern(1);
  const v2 = pattern(2);
  const v3 = pattern(3);
  const sequence = [
    seg(v1, 0),
    seg(v1, 1),
    { t: 'have', s: 7, index: 6 },
    { t: 'have', s: 7, index: PART + 2 },
    seg(v2, 1),
    { t: 'have', s: 7, index: PART * 2 + 3 },
    seg(v2, 0),
    seg(v3, 1),
    seg(v3, 2),
    { t: 'have', s: 7, index: 9 },
    { t: 'have', s: 7, index: PART + 4 },
    seg(v3, 1),
  ];

  const stashed = new Swarm({ peerId: 'late', name: 'late' });
  const p = stashed.addPeer(fakePeer('peer-seg'));
  for (const msg of sequence) stashed._onCtrl(p, msg);
  const kept = stashed._peerState.get('peer-seg').unknown.map((e) =>
    e.msg.t === 'have' ? `have:${e.msg.index}` : `seg:${e.msg.offset}`
  );
  assert.deepEqual(kept, ['seg:0', `seg:${PART * 2}`, 'have:9', `seg:${PART}`]);

  const direct = new Swarm({ peerId: 'early', name: 'early' });
  const q = direct.addPeer(fakePeer('peer-seg'));
  direct.setCatalog([entry]);
  for (const msg of sequence) direct._onCtrl(q, msg);

  stashed.setCatalog([entry]);
  assert.deepEqual(p.remote.get(7).have, q.remote.get(7).have);
});

/**
 * 暂存满了挤掉的 HAVE 折进它前面最新一张盖得住它的位图。补放结果必须和逐条收下完全一致：
 * 分段位图的各段、整张位图后面又来了一段、full、超出位图字节数和超出片数的下标都算上。
 */
impl('暂存挤掉的 HAVE 折进前面的位图：分段、整张、full 都和逐条收下一致，条数照样封顶', async (dir) => {
  const { Swarm, protocol } = await load(dir);
  countingStore();
  const PART = protocol.BITFIELD_CHUNKS_PER_PART;
  const segCount = PART + 1000;
  const seg6Count = PART * 2 + 1000;
  const entries = [
    { slot: 6, fileId: 'a'.repeat(32), size: seg6Count * MB, chunkCount: seg6Count, chunkSize: MB },
    { slot: 7, fileId: 'b'.repeat(32), size: segCount * MB, chunkCount: segCount, chunkSize: MB },
    { slot: 8, fileId: 'c'.repeat(32), size: 50 * MB, chunkCount: 50, chunkSize: MB },
    { slot: 9, fileId: 'd'.repeat(32), size: 2000 * MB, chunkCount: 2000, chunkSize: MB },
  ];
  const pattern = (count, seed) => {
    const have = new Uint8Array(count);
    for (let i = 0; i < count; i++) have[i] = (i * 7 + seed) % 5 === 0 ? 1 : 0;
    return have;
  };
  const v6 = pattern(seg6Count, 1);
  const v7 = pattern(segCount, 2);
  const v9 = pattern(2000, 3);
  const bf = (s, have, start, end, offset) => ({ t: 'bitfield', s, bits: protocol.packBitfield(have, start, end), offset });
  const sequence = [
    // 第三段先到、第二段后到：第三段的 HAVE 不能错折进更新的第二段
    bf(6, v6, 0, PART, 0),
    bf(6, v6, PART * 2, seg6Count, PART * 2),
    bf(6, v6, PART, PART * 2, PART),
    // 整张（只有一段那么长）后面又来了一段：那一段的 HAVE 得折进这一段，不能折进更早的整张
    { t: 'bitfield', s: 7, bits: protocol.packBitfield(v7, 0, PART) },
    bf(7, v7, PART, segCount, PART),
    { t: 'bitfield', s: 8, full: true },
    { t: 'bitfield', s: 9, bits: protocol.packBitfield(v9) },
  ];
  for (let i = 0; i < 120; i++) {
    sequence.push({ t: 'have', s: 6, index: 5 * i + 2 });
    sequence.push({ t: 'have', s: 6, index: PART + 3 * i + 1 });
    sequence.push({ t: 'have', s: 6, index: PART * 2 + 5 * i + 3 });
    sequence.push({ t: 'have', s: 7, index: 11 * i + 3 });
    sequence.push({ t: 'have', s: 7, index: PART + 7 * i + 2 });
    sequence.push({ t: 'have', s: 8, index: i % 50 });
    sequence.push({ t: 'have', s: 9, index: 13 * i + 4 });
  }
  // 超出片数的、超出整张位图字节数的：逐条收下时本来就不算
  sequence.push({ t: 'have', s: 9, index: 1999 });
  sequence.push({ t: 'have', s: 9, index: 5000 });
  sequence.push({ t: 'have', s: 7, index: segCount + 5 });
  for (let i = 0; i < 40; i++) sequence.push({ t: 'have', s: 6, index: 4 * i + 7 });

  const stashed = new Swarm({ peerId: 'late', name: 'late' });
  const p = stashed.addPeer(fakePeer('peer-fold'));
  for (const msg of sequence) stashed._onCtrl(p, msg);
  const st = stashed._peerState.get('peer-fold');
  assert.equal(st.unknown.length, 256);
  assert.equal(st.unknown.filter((e) => e.msg.t === 'bitfield').length, 7, '位图一张都没挤掉');
  assert.ok(st.unknown.some((e) => e.bytes), '确实有 HAVE 被挤掉并折进了位图');

  const direct = new Swarm({ peerId: 'early', name: 'early' });
  const q = direct.addPeer(fakePeer('peer-fold'));
  direct.setCatalog(entries);
  for (const msg of sequence) direct._onCtrl(q, msg);

  stashed.setCatalog(entries);
  assert.equal(st.unknown.length, 0);
  for (const { slot } of entries) {
    assert.deepEqual(p.remote.get(slot).have, q.remote.get(slot).have, `槽位 ${slot}`);
    assert.equal(p.remote.get(slot).full, q.remote.get(slot).full);
  }
  // 折进去的片确实补回来了（不是两边都丢）
  assert.equal(q.remote.get(6).have[2], 1);
  assert.equal(q.remote.get(6).have[PART * 2 + 3], 1);
  assert.equal(q.remote.get(7).have[PART + 2], 1);
  assert.equal(q.remote.get(9).have[4], 1);
});

/* ============ 6. 取回的清单：摘要管不到的字段（main-invariants#5） ============ */

impl('取回的清单按白名单重建：名字以列表条目为准，多带的字段、越界的时长都不要', async (dir, t) => {
  t.mock.method(console, 'warn', () => {});
  const { swarm, peers } = await manifestRig(dir, 1);
  const [x] = peers;
  const m = makeManifest('film', 4, { name: 'film.mkv' });
  const tampered = {
    ...m,
    name: 'film.mp4',
    uplinkBps: 123,
    roomRevision: 5,
    junk: { deep: 'x'.repeat(1000) },
    durationSec: 1e9,
    sourceUplinkBps: 5e6,
  };

  const first = swarm.requestManifest(m.fileId, {
    candidates: [x.peerId],
    expect: { size: m.size, chunkCount: m.chunkCount, chunkSize: m.chunkSize, name: 'film.mkv', durationSec: 0 },
  });
  swarm._onCtrl(x, { t: 'manifest', manifest: tampered });
  assert.deepEqual(await first, { ...m, name: 'film.mkv', sourceUplinkBps: 5e6 });

  // 条目没给名字时只能用对方的；多带的字段照样丢，时长以条目为准
  const second = swarm.requestManifest(m.fileId, { candidates: [x.peerId], expect: { durationSec: 120 } });
  swarm._onCtrl(x, { t: 'manifest', manifest: { ...tampered, sourceUplinkBps: 1e12 } });
  assert.deepEqual(await second, { ...m, name: 'film.mp4', durationSec: 120 });

  for (const uplink of [-1, '5', Infinity, null]) {
    const got = swarm.requestManifest(m.fileId, { candidates: [x.peerId] });
    swarm._onCtrl(x, { t: 'manifest', manifest: { ...m, durationSec: 60, sourceUplinkBps: uplink } });
    assert.deepEqual(await got, { ...m, durationSec: 60 });
  }

  // 分片大小和条目对不上：拿别的切法冒充，拒收
  const bad = [];
  swarm.on('manifest-bad', (e) => bad.push(e.from));
  const wrongChunk = swarm.requestManifest(m.fileId, { candidates: [x.peerId], expect: { chunkSize: m.chunkSize * 2 } });
  swarm._onCtrl(x, { t: 'manifest', manifest: m });
  await assert.rejects(wrongChunk, /没有人能提供这部片的清单/);
  assert.deepEqual(bad, [x.peerId]);
});

/** 主进程 openLeech 仍然完整校验清单：swarm 这层只是不让别人塞进来的字段走到那一步。 */
impl('第二道防线：重建后的清单能过主进程 security.manifest，原样的篡改清单过不了', async (dir) => {
  const validate = require('../src/main/security');
  const { CHUNK_SIZE } = require('../src/main/fileStore');
  const { swarm, peers } = await manifestRig(dir, 1);
  const [x] = peers;
  const m = makeManifest('guard', 3, { chunkSize: CHUNK_SIZE, tail: 100, name: 'guard.mkv', durationSec: 90 });
  const tampered = { ...m, name: 'guard.exe', uplinkBps: 1, durationSec: 1e9 };
  assert.throws(() => validate.manifest(tampered));
  assert.throws(() => validate.manifest({ ...m, uplinkBps: 1 }));

  const got = swarm.requestManifest(m.fileId, {
    candidates: [x.peerId],
    expect: { size: m.size, chunkCount: m.chunkCount, name: 'guard.mkv', durationSec: 90 },
  });
  swarm._onCtrl(x, { t: 'manifest', manifest: tampered });
  const result = await got;
  assert.doesNotThrow(() => validate.manifest(result));
  assert.deepEqual(result, m);

  // 名字本身就不合法时，swarm 不替主进程做决定，主进程照样拦下
  const noName = swarm.requestManifest(m.fileId, { candidates: [x.peerId] });
  swarm._onCtrl(x, { t: 'manifest', manifest: tampered });
  const unnamed = await noName;
  assert.equal(unnamed.name, 'guard.exe');
  assert.throws(() => validate.manifest(unnamed), /只允许接收/);
});
