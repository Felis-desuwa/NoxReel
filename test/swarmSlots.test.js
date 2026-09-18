'use strict';

/**
 * v2（0.7）多文件 swarm。
 *
 * 一个房间一整张播放列表，几部片的传输状态要同时存在：暂停第一部、先传第二部，
 * 回头再接着传第一部。凡是指向某一片的消息都带槽位 s，对方手里有什么也按槽位分开记。
 * 这里的每条测试都对着一条「多文件之后才出现」的不变量：槽位之间不能串、
 * 换片时不能丢已收的、不认识的槽位先暂存、清单只收自己要的、按人记的状态跟着人走。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const { IMPLS } = require('./helpers/impls');

const CHUNK = 1024;
const DC_LIMIT = 64 * 1024;

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, (t) => fn(dir, t));
}

async function load(dir) {
  const swarmMod = await import(dir + 'swarm.js');
  const protocol = await import(dir + 'protocol.js');
  return { ...swarmMod, protocol };
}

const sha256 = (s) => nodeCrypto.createHash('sha256').update(s).digest('hex');

/** 摘要真实可验的清单：fileId = sha256(hashes.join('')) 前 32 位，和主进程一致。 */
function makeManifest(tag, chunkCount, { chunkSize = CHUNK, tail = 0, durationSec = 60 } = {}) {
  const hashes = Array.from({ length: chunkCount }, (_, i) => sha256(`${tag}:${i}`));
  return {
    fileId: sha256(hashes.join('')).slice(0, 32),
    name: `${tag}.mkv`,
    size: chunkCount * chunkSize - tail,
    chunkSize,
    chunkCount,
    hashes,
    durationSec,
  };
}

const catalogOf = (slot, m) => ({
  slot,
  fileId: m.fileId,
  size: m.size,
  chunkCount: m.chunkCount,
  chunkSize: m.chunkSize,
});

function fakePeer(peerId, { authenticated = true, log = null } = {}) {
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
      this.chunks.push({ slot, index, bytes: buf.byteLength });
      if (log) log.push(`${this.peerId}:${slot}:${index}`);
    },
    ping() {},
    hello() {},
  };
}

const ofType = (peer, t) => peer.sent.filter((m) => m.t === t);
const reqKeys = (peer) => ofType(peer, 'request').map((m) => `${m.s}:${m.index}`);
const cancelKeys = (peer) => ofType(peer, 'cancel').map((m) => `${m.s}:${m.index}`).sort();
const gets = (peer) => ofType(peer, 'manifest-get').map((m) => m.fileId);
const sortedKeys = (iterable) => [...iterable].sort();

function hello(peer, extra = {}) {
  return {
    t: 'hello',
    peerId: peer.peerId,
    name: peer.name,
    ver: 2,
    securityMode: 'safe',
    platform: 'desktop',
    ...extra,
  };
}

const frameOf = (slot, index, len = CHUNK) => ({
  slot,
  chunkIndex: index,
  frameIndex: 0,
  payload: new Uint8Array(len),
});

const flush = async (n = 4) => {
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

/** 读写盘都挂着，由测试手动放行。两端测试共用 globalThis，所以每条测试开头都要重新装。 */
function deferredStore() {
  const reads = [];
  const writes = [];
  globalThis.window = {
    sw: {
      store: {
        readChunk: (sessionId, index) =>
          new Promise((resolve, reject) => reads.push({ sessionId, index, resolve, reject })),
        writeChunk: (sessionId, index, buffer) =>
          new Promise((resolve, reject) => writes.push({ sessionId, index, buffer, resolve, reject })),
      },
    },
  };
  return { reads, writes, readKeys: () => reads.map((r) => `${r.sessionId}:${r.index}`) };
}

/** 读写盘立即成功。haveCount 按会话累加。 */
function instantStore() {
  const writes = [];
  const counts = new Map();
  globalThis.window = {
    sw: {
      store: {
        async readChunk() {
          return new ArrayBuffer(CHUNK);
        },
        async writeChunk(sessionId, index, buffer) {
          writes.push({ sessionId, index, bytes: buffer.byteLength });
          const n = (counts.get(sessionId) || 0) + 1;
          counts.set(sessionId, n);
          return { ok: true, duplicate: false, haveCount: n, contiguousBytes: 0, complete: false };
        },
      },
    },
  };
  return { writes };
}

/** 100 项、每项 200 个汉字片名的播放列表：UTF-8 远超 DataChannel 单条 64KB。 */
function bigPlaylist() {
  const queue = Array.from({ length: 100 }, (_, i) => ({
    id: `item-${i}`,
    kind: 'file',
    slot: i + 1,
    fileId: sha256(`pl:${i}`).slice(0, 32),
    name: '长'.repeat(199) + String.fromCharCode(0x4e00 + i),
    size: 123456789,
    chunkSize: 2097152,
    chunkCount: 59,
    durationSec: 5400,
  }));
  return { t: 'playlist', rev: 7, seq: 3, queue, history: [], started: true, autoplay: true, nextSlot: 101 };
}

/* ======================== 1. 按槽位的位图、暂存与补放 ======================== */

/**
 * 对方的位图按槽位分开记，发的时候也得一个槽位一份：混成一张的话，
 * 收方按哪部片的片数去解都是错的。做完种的只报一句 full，免得几十万片的整张位图白跑。
 */
impl('每个槽位各发一份位图：做种的只报 full，未认证的人什么都收不到', async (dir) => {
  const { Swarm, protocol } = await load(dir);
  instantStore();
  const swarm = new Swarm({ peerId: 'me-local', name: 'me' });
  const peer = swarm.addPeer(fakePeer('peer-aa'));
  const stranger = swarm.addPeer(fakePeer('peer-zz', { authenticated: false }));
  const progress = [];
  swarm.on('progress', (p) => progress.push(p));

  const mA = makeManifest('a', 4);
  const mB = makeManifest('b', 5);
  const haveB = Uint8Array.from([1, 0, 1, 0, 0]);
  const ctxA = swarm.addFile({ slot: 1, manifest: mA, sessionId: 'sA', isSeeder: true });
  swarm.addFile({
    slot: 2,
    manifest: mB,
    sessionId: 'sB',
    isSeeder: false,
    state: { bitfield: protocol.packBitfield(haveB), haveCount: 2, contiguousBytes: CHUNK, complete: false },
  });

  const expected = [
    { t: 'bitfield', s: 1, full: true },
    { t: 'bitfield', s: 2, bits: protocol.packBitfield(haveB) },
  ];
  assert.deepEqual(ofType(peer, 'bitfield'), expected);
  assert.deepEqual(stranger.sent, [], '握手没过的人不能知道我有什么');
  assert.deepEqual(
    progress.map((p) => [p.slot, p.haveCount, p.chunkCount]),
    [
      [1, 4, 4],
      [2, 2, 5],
    ]
  );

  // 同一槽位同一会话重复挂一次：原样返回，不重发位图
  assert.equal(swarm.addFile({ slot: 1, manifest: mA, sessionId: 'sA', isSeeder: true }), ctxA);
  assert.equal(ofType(peer, 'bitfield').length, 2);

  // 后来才通过握手的人，一次补齐全部槽位
  const late = swarm.addPeer(fakePeer('peer-bb', { authenticated: false }));
  swarm._onCtrl(late, hello(late));
  assert.deepEqual(ofType(late, 'bitfield'), expected);

  // 对照：这两条位图在另一端按各自槽位解得回来
  const recv = new Swarm({ peerId: 'peer-aa', name: 'A' });
  const fromMe = recv.addPeer(fakePeer('me-local'));
  recv.setCatalog([catalogOf(1, mA), catalogOf(2, mB)]);
  for (const m of ofType(peer, 'bitfield')) recv._onCtrl(fromMe, m);
  assert.equal(fromMe.remote.get(1).full, true);
  assert.deepEqual([...fromMe.remote.get(1).have], [1, 1, 1, 1]);
  assert.equal(fromMe.remote.get(2).full, false);
  assert.deepEqual([...fromMe.remote.get(2).have], [...haveB]);
});

/**
 * 管理员加片后，房主广播新列表之前，加片的人就可能已经把位图发过来了。
 * 这时本机不知道那个槽位有几片，没法解；直接丢掉的话，位图只在握手时发一次，
 * 这个人就永远不会被当成上游。所以先暂存，列表到了再按原顺序补上。
 */
impl('列表里还没有的槽位：位图和 HAVE 先暂存，setCatalog / addFile 后按原顺序补放', async (dir) => {
  const { Swarm, protocol } = await load(dir);
  instantStore();
  const swarm = new Swarm({ peerId: 'me-local', name: 'me' });
  const peer = swarm.addPeer(fakePeer('peer-aa'));
  const sources = [];
  swarm.on('sources', (e) => sources.push(e.slot));

  const m3 = makeManifest('c', 4);
  const m4 = makeManifest('d', 3);
  swarm._onCtrl(peer, { t: 'bitfield', s: 3, bits: protocol.packBitfield(Uint8Array.from([1, 0, 0, 0])) });
  swarm._onCtrl(peer, { t: 'have', s: 3, index: 2 });
  swarm._onCtrl(peer, { t: 'have', s: 4, index: 1 });
  assert.equal(peer.remote.size, 0);
  assert.equal(swarm._peerState.get('peer-aa').unknown.length, 3);

  swarm.setCatalog([catalogOf(3, m3)]);
  // 先位图后 HAVE：顺序一反，位图会把后来的 HAVE 盖掉
  assert.deepEqual([...peer.remote.get(3).have], [1, 0, 1, 0]);
  assert.ok(sources.includes(3));
  assert.equal(peer.remote.has(4), false);
  assert.deepEqual(
    swarm._peerState.get('peer-aa').unknown.map((e) => e.msg.s),
    [4],
    '仍不认识的槽位继续留着'
  );

  // 本机挂上这部片同样会补放
  swarm.addFile({ slot: 4, manifest: m4, sessionId: 's4', isSeeder: false });
  assert.deepEqual([...peer.remote.get(4).have], [0, 1, 0]);
  assert.equal(swarm._peerState.get('peer-aa').unknown.length, 0);

  // 列表里删掉的槽位，对方那份位图没用了；本机还挂着的不能删
  swarm.setCatalog([]);
  assert.equal(peer.remote.has(3), false);
  assert.equal(peer.remote.has(4), true);
});

/** 暂存是给「马上就会出现在列表里」的槽位用的，不能变成对方随便灌的无底洞。 */
impl('暂存超过 60 秒的丢弃，每人最多暂存 256 条且挤掉最老的', async (dir) => {
  const { Swarm } = await load(dir);
  instantStore();
  const swarm = new Swarm({ peerId: 'me-local', name: 'me' });
  const peer = swarm.addPeer(fakePeer('peer-aa'));
  const m5 = makeManifest('e', 4);

  swarm._onCtrl(peer, { t: 'bitfield', s: 5, full: true });
  swarm._onCtrl(peer, { t: 'have', s: 5, index: 2 });
  const st = swarm._peerState.get('peer-aa');
  st.unknown[0].at -= 61_000;
  swarm.setCatalog([catalogOf(5, m5)]);
  const remote = peer.remote.get(5);
  assert.equal(remote.full, false, '过期的 full 位图不能补放');
  assert.deepEqual([...remote.have], [0, 0, 1, 0]);
  assert.equal(st.unknown.length, 0, '过期的也不再留着');

  // 新消息进来时顺手清掉过期的
  swarm._onCtrl(peer, { t: 'have', s: 6, index: 0 });
  st.unknown[0].at -= 61_000;
  swarm._onCtrl(peer, { t: 'have', s: 6, index: 1 });
  assert.deepEqual(
    st.unknown.map((e) => e.msg.index),
    [1]
  );

  // 上限：换个人，灌 300 条
  const flood = swarm.addPeer(fakePeer('peer-fl'));
  const m7 = makeManifest('g', 300);
  for (let i = 0; i < 300; i++) swarm._onCtrl(flood, { t: 'have', s: 7, index: i });
  assert.equal(swarm._peerState.get('peer-fl').unknown.length, 256);
  swarm.setCatalog([catalogOf(5, m5), catalogOf(7, m7)]);
  const have7 = flood.remote.get(7).have;
  assert.equal(have7.slice(0, 44).some((b) => b === 1), false, '最老的 44 条被挤掉');
  assert.equal(have7.slice(44).every((b) => b === 1), true);
});

/* ======================== 2. activeSlot ======================== */

/**
 * 同一时刻只向别人要一部。换 active 时旧槽位的在途必须撤干净：
 * 不发 CANCEL，对方的发片队列里就一直排着没人要的片；不清 peer.inflight，
 * 这个上游的窗口被旧槽位占满，新槽位一片都分不到。已收的片要留着，回头接着传。
 */
impl('只向 activeSlot 要片；切换时撤回旧槽位在途并发 CANCEL，切回来接着要剩下的', async (dir) => {
  const { Swarm } = await load(dir);
  const { writes } = instantStore();
  const swarm = new Swarm({ peerId: 'me-local', name: 'me' });
  const peer = swarm.addPeer(fakePeer('peer-aa'));
  const m1 = makeManifest('a', 8);
  const m2 = makeManifest('b', 8);
  const ctx1 = swarm.addFile({ slot: 1, manifest: m1, sessionId: 's1', isSeeder: false });
  swarm.addFile({ slot: 2, manifest: m2, sessionId: 's2', isSeeder: false });
  swarm._onCtrl(peer, { t: 'bitfield', s: 1, full: true });
  swarm._onCtrl(peer, { t: 'bitfield', s: 2, full: true });
  assert.deepEqual(reqKeys(peer), [], '没指定 active 之前谁都不要');

  swarm.setActive(1);
  assert.deepEqual(reqKeys(peer), ['1:0', '1:1', '1:2', '1:3']);
  assert.deepEqual(sortedKeys(swarm.inflight.keys()), ['1:0', '1:1', '1:2', '1:3']);
  assert.deepEqual(sortedKeys(peer.inflight), ['1:0', '1:1', '1:2', '1:3']);

  // 第 0 片到货，空出的名额补上第 4 片
  swarm._onFrame(peer, frameOf(1, 0));
  await flush();
  assert.equal(writes.length, 1);
  assert.equal(ctx1.have[0], 1);
  assert.deepEqual(sortedKeys(swarm.inflight.keys()), ['1:1', '1:2', '1:3', '1:4']);

  peer.sent.length = 0;
  swarm.setActive(2);
  assert.deepEqual(cancelKeys(peer), ['1:1', '1:2', '1:3', '1:4']);
  for (const m of ofType(peer, 'cancel')) assert.deepEqual(Object.keys(m).sort(), ['index', 's', 't']);
  assert.deepEqual(reqKeys(peer), ['2:0', '2:1', '2:2', '2:3'], '旧槽位的名额要全部让出来');
  assert.deepEqual(sortedKeys(swarm.inflight.keys()), ['2:0', '2:1', '2:2', '2:3']);
  assert.deepEqual(sortedKeys(peer.inflight), ['2:0', '2:1', '2:2', '2:3']);
  assert.equal(ctx1.have[0], 1, '已收的片留着');
  assert.equal(ctx1.haveCount, 1);
  for (const i of [1, 2, 3, 4]) assert.equal(ctx1.assembler.has(i), false);
  assert.equal(swarm.progress(1).inflight, 0);
  assert.equal(swarm.progress(2).inflight, 4);

  // 撤回之后旧槽位迟到的帧不再收
  swarm._onFrame(peer, frameOf(1, 1));
  await flush();
  assert.equal(writes.length, 1);

  // 设成同一个槽位什么都不做
  peer.sent.length = 0;
  swarm.setActive(2);
  assert.deepEqual(peer.sent, []);

  // 切回去：撤掉槽位 2 的，槽位 1 从缺的接着要，不重复要第 0 片
  swarm.setActive(1);
  assert.deepEqual(cancelKeys(peer), ['2:0', '2:1', '2:2', '2:3']);
  assert.deepEqual(reqKeys(peer), ['1:1', '1:2', '1:3', '1:4']);
  assert.deepEqual(sortedKeys(swarm.inflight.keys()), ['1:1', '1:2', '1:3', '1:4']);
});

/* ======================== 3. REQUEST / DENY ======================== */

/**
 * 三种拒绝的含义不同，收方据此做的事也不同：gone 是整部都没了，
 * 普通 DENY 是这一片没有，busy 只是现在排不下 —— busy 被当成「没有」的话，
 * 对方会把这个上游手里的片从位图里抹掉，再也不找他要。
 */
impl('发片端：未知槽位回 gone，缺片回普通 DENY，队列满回 busy', async (dir) => {
  const { Swarm, protocol } = await load(dir);
  const store = deferredStore();
  const swarm = new Swarm({ peerId: 'me-local', name: 'me' });
  const peer = swarm.addPeer(fakePeer('peer-aa'));
  const m1 = makeManifest('a', 4);
  swarm.addFile({
    slot: 1,
    manifest: m1,
    sessionId: 's1',
    isSeeder: false,
    state: {
      bitfield: protocol.packBitfield(Uint8Array.from([1, 0, 0, 0])),
      haveCount: 1,
      contiguousBytes: CHUNK,
      complete: false,
    },
  });
  const m2 = makeManifest('b', 300);
  swarm.addFile({ slot: 2, manifest: m2, sessionId: 's2', isSeeder: true });
  peer.sent.length = 0;

  swarm._onCtrl(peer, { t: 'request', s: 9, index: 0 });
  swarm._onCtrl(peer, { t: 'request', s: 1, index: 1 });
  assert.deepEqual(peer.sent, [
    { t: 'deny', s: 9, index: 0, gone: true },
    { t: 'deny', s: 1, index: 1 },
  ]);

  // 越界的请求不理
  peer.sent.length = 0;
  swarm._onCtrl(peer, { t: 'request', s: 1, index: 4 });
  assert.deepEqual(peer.sent, []);

  // 有的片照发：并发 2
  swarm._onCtrl(peer, { t: 'request', s: 1, index: 0 });
  swarm._onCtrl(peer, { t: 'request', s: 2, index: 0 });
  assert.deepEqual(store.readKeys(), ['s1:0', 's2:0']);
  // 重复的请求不占位
  swarm._onCtrl(peer, { t: 'request', s: 2, index: 1 });
  swarm._onCtrl(peer, { t: 'request', s: 2, index: 1 });
  assert.equal(swarm._serveQueue.get('peer-aa').length, 1);
  for (let i = 2; i <= 256; i++) swarm._onCtrl(peer, { t: 'request', s: 2, index: i });
  assert.equal(swarm._serveQueue.get('peer-aa').length, 256);
  assert.deepEqual(peer.sent, []);

  swarm._onCtrl(peer, { t: 'request', s: 2, index: 257 });
  assert.deepEqual(peer.sent, [{ t: 'deny', s: 2, index: 257, busy: true }]);
  assert.equal(swarm._serveQueue.get('peer-aa').length, 256);
  assert.equal(store.reads.length, 2);
});

impl('收方：busy 的 DENY 只撤在途不动位图，普通 DENY 清该位，gone 删掉整张', async (dir) => {
  const { Swarm } = await load(dir);
  instantStore();
  const swarm = new Swarm({ peerId: 'me-local', name: 'me' });
  const a = swarm.addPeer(fakePeer('peer-aa'));
  const b = swarm.addPeer(fakePeer('peer-bb'));
  const m1 = makeManifest('a', 8);
  const ctx = swarm.addFile({ slot: 1, manifest: m1, sessionId: 's1', isSeeder: false });
  swarm._onCtrl(a, { t: 'bitfield', s: 1, full: true });
  swarm._onCtrl(b, { t: 'bitfield', s: 1, full: true });
  swarm.setActive(1);

  const idxOf = (p) =>
    [...swarm.inflight.values()].filter((i) => i.peerId === p.peerId).map((i) => i.index);
  const aIdx = idxOf(a);
  const bIdx = idxOf(b);
  assert.ok(aIdx.length >= 4 && bIdx.length >= 1, '两个上游都分到了片');
  const sources = [];
  swarm.on('sources', (e) => sources.push(e.slot));
  const remoteA = a.remote.get(1);

  // busy：只是现在忙
  swarm._onCtrl(a, { t: 'deny', s: 1, index: aIdx[0], busy: true });
  assert.equal(remoteA.have[aIdx[0]], 1);
  assert.equal(remoteA.full, true);
  assert.equal(swarm.inflight.has(`1:${aIdx[0]}`), false);
  assert.equal(a.inflight.has(`1:${aIdx[0]}`), false);
  assert.equal(ctx.assembler.has(aIdx[0]), false);
  assert.equal(swarm.inflight.has(`1:${aIdx[1]}`), true);

  // 普通 DENY：他没有这一片
  swarm._onCtrl(a, { t: 'deny', s: 1, index: aIdx[1] });
  assert.equal(remoteA.have[aIdx[1]], 0);
  assert.equal(remoteA.full, false);
  assert.equal(remoteA.have.filter((x) => x === 1).length, 7);
  assert.equal(swarm.inflight.has(`1:${aIdx[1]}`), false);
  assert.equal(swarm.inflight.has(`1:${aIdx[2]}`), true);

  // 别人的 DENY、别的槽位的 gone 都不能撤 A 的在途
  swarm._onCtrl(b, { t: 'deny', s: 1, index: aIdx[2] });
  swarm._onCtrl(a, { t: 'deny', s: 2, index: 0, gone: true });
  assert.equal(swarm.inflight.has(`1:${aIdx[2]}`), true);
  assert.equal(a.remote.has(1), true);

  // gone：整部都没了
  swarm._onCtrl(a, { t: 'deny', s: 1, index: 0, gone: true });
  assert.equal(a.remote.has(1), false);
  assert.ok(sources.includes(1));
  assert.deepEqual(idxOf(a), []);
  assert.equal([...a.inflight].some((k) => k.startsWith('1:')), false);
  for (const i of aIdx) assert.equal(ctx.assembler.has(i), false);
  assert.deepEqual(idxOf(b), bIdx, 'B 的在途不受影响');
  for (const i of bIdx) assert.equal(ctx.assembler.has(i), true);
});

/* ======================== 4. 数据帧 ======================== */

impl('数据帧：未认证的人、未知槽位、做种槽位的帧一律丢掉', async (dir) => {
  const { Swarm } = await load(dir);
  const store = deferredStore();
  const swarm = new Swarm({ peerId: 'me-local', name: 'me' });
  const peer = swarm.addPeer(fakePeer('peer-aa'));
  const stranger = swarm.addPeer(fakePeer('peer-uu', { authenticated: false }));
  const leechCtx = swarm.addFile({ slot: 1, manifest: makeManifest('l', 4), sessionId: 's1', isSeeder: false });
  const seedCtx = swarm.addFile({ slot: 2, manifest: makeManifest('s', 4), sessionId: 's2', isSeeder: true });
  swarm._onCtrl(peer, { t: 'bitfield', s: 1, full: true });
  swarm.setActive(1);
  assert.equal(leechCtx.assembler.has(0), true);

  seedCtx.assembler.expect(0, CHUNK); // 就算拼装器里挂着期待，做种槽位也不收
  swarm._onFrame(peer, frameOf(2, 0));
  swarm._onFrame(peer, frameOf(9, 0));
  swarm._onFrame(stranger, frameOf(1, 0));
  assert.equal(store.writes.length, 0);
  assert.equal(leechCtx.assembler.has(0), true, '未认证的人的帧不能把这片拼掉');

  swarm._onFrame(peer, frameOf(1, 0));
  assert.deepEqual(
    store.writes.map((w) => [w.sessionId, w.index, w.buffer.byteLength]),
    [['s1', 0, CHUNK]]
  );
});

impl('分片落盘：更新位图，只给已认证的人发 HAVE，收齐报 complete，坏片报 chunk-bad', async (dir, t) => {
  t.mock.method(console, 'warn', () => {});
  const { Swarm } = await load(dir);
  const store = deferredStore();
  const swarm = new Swarm({ peerId: 'me-local', name: 'me' });
  const p = swarm.addPeer(fakePeer('peer-pp'));
  const q = swarm.addPeer(fakePeer('peer-qq'));
  const u = swarm.addPeer(fakePeer('peer-uu', { authenticated: false }));
  const m = makeManifest('w', 2, { tail: 24 });
  const ctx = swarm.addFile({ slot: 4, manifest: m, sessionId: 's4', isSeeder: false });
  swarm._onCtrl(p, { t: 'bitfield', s: 4, full: true });
  swarm.setActive(4);
  assert.deepEqual(reqKeys(p), ['4:0', '4:1']);

  const progress = [];
  const complete = [];
  const bad = [];
  swarm.on('progress', (e) => progress.push(e));
  swarm.on('complete', (e) => complete.push(e));
  swarm.on('chunk-bad', (e) => bad.push(e));
  for (const x of [p, q, u]) x.sent.length = 0;

  // 末片比 chunkSize 短
  swarm._onFrame(p, frameOf(4, 1, CHUNK - 24));
  assert.deepEqual(
    store.writes.map((w) => [w.sessionId, w.index, w.buffer.byteLength]),
    [['s4', 1, CHUNK - 24]]
  );
  assert.equal(ctx.writing.has(1), true, '落盘期间算作已安排');
  assert.equal(swarm.inflight.has('4:1'), false);
  assert.equal(p.inflight.has('4:1'), false);
  // 这片既不在途、have 也还是 0，但调度器不能在写盘的空档里再要一遍
  swarm._tick();
  assert.deepEqual(reqKeys(p), []);

  store.writes[0].resolve({ ok: false, reason: 'hash-mismatch' });
  await flush();
  assert.deepEqual(bad, [{ slot: 4, index: 1, from: 'peer-pp', reason: 'hash-mismatch' }]);
  assert.equal(ctx.have[1], 0);
  assert.equal(ctx.writing.has(1), false);
  assert.deepEqual(ofType(q, 'have'), []);
  assert.deepEqual(reqKeys(p), ['4:1'], '坏片当场重新要');

  swarm._onFrame(p, frameOf(4, 0));
  store.writes[1].resolve({ ok: true, duplicate: false, haveCount: 1, contiguousBytes: CHUNK, complete: false });
  await flush();
  assert.equal(ctx.have[0], 1);
  assert.equal(ctx.haveCount, 1);
  assert.equal(ctx.contiguousBytes, CHUNK);
  for (const x of [p, q]) assert.deepEqual(ofType(x, 'have'), [{ t: 'have', s: 4, index: 0 }]);
  assert.deepEqual(u.sent, []);
  assert.deepEqual([progress.at(-1).slot, progress.at(-1).haveCount], [4, 1]);
  assert.deepEqual(complete, []);

  swarm._onFrame(p, frameOf(4, 1, CHUNK - 24));
  store.writes[2].resolve({ ok: true, duplicate: false, haveCount: 2, contiguousBytes: m.size, complete: true });
  await flush();
  assert.deepEqual(complete, [{ slot: 4, fileId: m.fileId }]);
  assert.equal(ctx.complete, true);
  assert.deepEqual(ofType(q, 'have').map((x) => x.index), [0, 1]);
});

/**
 * 写盘是一整个 IPC 往返。这期间这部片可能被摘掉又以新会话挂回同一个槽位
 * （删缓存重下、换片再换回来）。旧会话的结果如果写进新上下文，本机位图就会说
 * 「我有第 0 片」而新会话的文件里其实是空的 —— 还会把这个假消息 HAVE 给所有人。
 */
impl('落盘期间同槽位换了新会话：旧结果作废，不写进新上下文、不发 HAVE、不报 complete', async (dir) => {
  const { Swarm } = await load(dir);
  const store = deferredStore();
  const swarm = new Swarm({ peerId: 'me-local', name: 'me' });
  const peer = swarm.addPeer(fakePeer('peer-aa'));
  const m = makeManifest('r', 4);
  swarm.addFile({ slot: 1, manifest: m, sessionId: 's-old', isSeeder: false });
  swarm._onCtrl(peer, { t: 'bitfield', s: 1, full: true });
  swarm.setActive(1);
  swarm._onFrame(peer, frameOf(1, 0));
  swarm._onFrame(peer, frameOf(1, 1));
  assert.deepEqual(
    store.writes.map((w) => `${w.sessionId}:${w.index}`),
    ['s-old:0', 's-old:1']
  );

  swarm.removeFile(1);
  const fresh = swarm.addFile({ slot: 1, manifest: m, sessionId: 's-new', isSeeder: false });
  peer.sent.length = 0;
  const events = [];
  for (const name of ['progress', 'complete', 'error', 'chunk-bad']) swarm.on(name, (e) => events.push([name, e]));

  store.writes[0].resolve({ ok: true, duplicate: false, haveCount: 4, contiguousBytes: m.size, complete: true });
  store.writes[1].reject(new Error('会话已关闭'));
  await flush();

  assert.equal(fresh.have[0], 0);
  assert.equal(fresh.haveCount, 0);
  assert.equal(fresh.contiguousBytes, 0);
  assert.equal(fresh.complete, false);
  assert.deepEqual(ofType(peer, 'have'), []);
  assert.deepEqual(events, [], '旧会话的成功、失败都不该冒出来');
  assert.equal(swarm.progress(1).haveCount, 0);

  // 旧会话在途的帧也进不了新会话的拼装器
  swarm._onFrame(peer, frameOf(1, 2));
  assert.equal(store.writes.length, 2);
});

/* ======================== 5. 发片优先级 ======================== */

impl('pickServeIndex：当前播放那部优先，别人还在要当前这部时后面几部先等着', async (dir) => {
  const { pickServeIndex } = await load(dir);
  const q = [
    { slot: 2, index: 0 },
    { slot: 3, index: 1 },
    { slot: 1, index: 5 },
    { slot: 1, index: 6 },
  ];
  assert.equal(pickServeIndex([], 1, false), -1);
  assert.equal(pickServeIndex([], null, false), -1);
  assert.equal(pickServeIndex(q, null, true), 0, '没有正在播放的片就按先来后到');
  assert.equal(pickServeIndex(q, undefined, true), 0);
  assert.equal(pickServeIndex(q, 1, true), 2, '队列里有当前这部就先发它（取最早的那条）');
  assert.equal(pickServeIndex(q, 1, false), 2);
  assert.equal(pickServeIndex(q, 9, true), -1, '别人还在要当前这部，后面几部先等着');
  assert.equal(pickServeIndex(q, 9, false), 0);
  // 槽位 0 是合法槽位，不能被当成「没有」
  assert.equal(pickServeIndex([{ slot: 2, index: 0 }, { slot: 0, index: 0 }], 0, false), 1);
  assert.equal(pickServeIndex([{ slot: 2, index: 0 }], 0, true), -1);
});

async function priorityRig(dir) {
  const { Swarm } = await load(dir);
  const store = deferredStore();
  const swarm = new Swarm({ peerId: 'me-local', name: 'me' });
  swarm.addFile({ slot: 1, manifest: makeManifest('p1', 8), sessionId: 's1', isSeeder: true });
  swarm.addFile({ slot: 2, manifest: makeManifest('p2', 8), sessionId: 's2', isSeeder: true });
  const log = [];
  const a = swarm.addPeer(fakePeer('peer-aa', { log }));
  const b = swarm.addPeer(fakePeer('peer-bb', { log }));
  const req = (p, s, index) => swarm._onCtrl(p, { t: 'request', s, index });
  const buf = () => new ArrayBuffer(CHUNK);
  return { swarm, store, log, a, b, req, buf };
}

/**
 * 带宽先紧着还没收完当前这部的人：A 在追当前这部，B 在预取下一部，
 * B 的请求必须等 A 的发完。反过来，没人要当前这部时不能白等。
 */
impl('发片优先级：别人要当前这部时，后面几部的请求等前者全部发完才开始', async (dir) => {
  const { swarm, store, log, a, b, req, buf } = await priorityRig(dir);
  swarm.setPlaying(1);

  // 没人要当前这部：下一部的请求立刻发
  req(b, 2, 7);
  assert.deepEqual(store.readKeys(), ['s2:7']);
  store.reads[0].resolve(buf());
  await flush();
  assert.deepEqual(log, ['peer-bb:2:7']);

  req(a, 1, 0);
  req(a, 1, 1);
  req(a, 1, 2);
  req(b, 2, 0);
  assert.deepEqual(store.readKeys().slice(1), ['s1:0', 's1:1'], 'B 的请求在等');

  store.reads[1].resolve(buf());
  await flush();
  assert.deepEqual(store.readKeys().slice(1), ['s1:0', 's1:1', 's1:2']);
  store.reads[2].resolve(buf());
  await flush();
  assert.equal(store.readKeys().includes('s2:0'), false, 'A 还有一片在发，B 继续等');
  store.reads[3].resolve(buf());
  await flush();
  assert.deepEqual(store.readKeys().slice(1), ['s1:0', 's1:1', 's1:2', 's2:0']);
  store.reads[4].resolve(buf());
  await flush();
  assert.deepEqual(log, ['peer-bb:2:7', 'peer-aa:1:0', 'peer-aa:1:1', 'peer-aa:1:2', 'peer-bb:2:0']);
  assert.equal(swarm._servingPriority, 0);
});

/** 当前这部的请求被撤掉、或者要它的人走了，排着的后面几部不能继续干等。 */
for (const [label, unblock] of [
  ['A 的请求被 CANCEL 掉', (swarm, a) => swarm._onCtrl(a, { t: 'cancel', s: 1, index: 0 })],
  ['A 离开（removePeer）', (swarm, a) => swarm.removePeer(a.peerId)],
]) {
  impl(`发片优先级：${label}后，等着的下一部请求立刻开始`, async (dir) => {
    const { swarm, store, a, b, req, buf } = await priorityRig(dir);
    // A 先占满两个发片名额（那时还没有正在播放的片）
    req(a, 2, 6);
    req(a, 2, 7);
    assert.deepEqual(store.readKeys(), ['s2:6', 's2:7']);
    swarm.setPlaying(1);
    req(a, 1, 0); // 排在 A 的队列里
    req(b, 2, 0); // 当前这部还有人要，B 等着
    assert.equal(store.reads.length, 2);

    // 撤掉的不是当前这部的请求，B 继续等
    swarm._onCtrl(a, { t: 'cancel', s: 2, index: 0 });
    swarm._onCtrl(b, { t: 'cancel', s: 1, index: 0 });
    assert.equal(store.reads.length, 2);

    unblock(swarm, a);
    assert.deepEqual(store.readKeys(), ['s2:6', 's2:7', 's2:0']);
    assert.deepEqual(swarm._serveQueue.get('peer-aa') || [], []);

    store.reads[2].resolve(buf());
    await flush();
    assert.deepEqual(b.chunks, [{ slot: 2, index: 0, bytes: CHUNK }]);
  });
}

/** 当前这部被摘掉（删缓存、换片），排着的它的请求也得清掉，否则后面几部永远在等一部已经不存在的片。 */
impl('发片优先级：removeFile 摘掉当前这部后，排队的请求一并清掉，等着的下一部立刻开始', async (dir) => {
  const { swarm, store, a, b, req, buf } = await priorityRig(dir);
  req(a, 2, 6);
  req(a, 2, 7);
  swarm.setPlaying(1);
  req(a, 1, 0);
  req(a, 2, 5);
  req(b, 2, 0);
  assert.equal(store.reads.length, 2);

  swarm.removeFile(1);
  assert.deepEqual(swarm._serveQueue.get('peer-aa'), [{ slot: 2, index: 5 }]);
  assert.deepEqual(store.readKeys(), ['s2:6', 's2:7', 's2:0']);
  store.reads[0].resolve(buf());
  await flush();
  assert.deepEqual(store.readKeys(), ['s2:6', 's2:7', 's2:0', 's2:5']);
  assert.equal(b.chunks.length, 0);
});

impl('发片优先级：同一个人的队列里当前这部插到前面', async (dir) => {
  const { swarm, store, log, a, req, buf } = await priorityRig(dir);
  req(a, 2, 6);
  req(a, 2, 7);
  swarm.setPlaying(1);
  req(a, 2, 0);
  req(a, 1, 3);
  store.reads[0].resolve(buf());
  await flush();
  assert.deepEqual(store.readKeys(), ['s2:6', 's2:7', 's1:3']);
  store.reads[1].resolve(buf());
  store.reads[2].resolve(buf());
  await flush();
  assert.deepEqual(store.readKeys(), ['s2:6', 's2:7', 's1:3', 's2:0']);
  store.reads[3].resolve(buf());
  await flush();
  assert.deepEqual(log, ['peer-aa:2:6', 'peer-aa:2:7', 'peer-aa:1:3', 'peer-aa:2:0']);
});

/* ======================== 6. 清单往来 ======================== */

async function manifestRig(dir) {
  const { Swarm } = await load(dir);
  instantStore();
  const swarm = new Swarm({ peerId: 'me-local', name: 'me' });
  const peers = ['peer-p1', 'peer-p2', 'peer-p3'].map((id) => swarm.addPeer(fakePeer(id)));
  return { swarm, peers };
}

impl('manifestShapeOk / manifestDigestOk：形状和摘要各管各的', async (dir) => {
  const { manifestShapeOk, manifestDigestOk } = await load(dir);
  const m = makeManifest('shape', 3, { tail: 10 });
  assert.equal(manifestShapeOk(m), true);
  assert.equal(await manifestDigestOk(m), true);
  const broken = [
    { ...m, fileId: m.fileId.toUpperCase() },
    { ...m, fileId: m.fileId.slice(0, 31) },
    { ...m, name: 'x'.repeat(201) },
    { ...m, size: 0 },
    { ...m, size: 2 ** 53 },
    { ...m, chunkSize: 1.5 },
    { ...m, chunkCount: 4 },
    { ...m, size: m.size + CHUNK }, // 片数对不上 ceil(size/chunkSize)
    { ...m, hashes: m.hashes.slice(1) },
    { ...m, hashes: [m.hashes[0].toUpperCase(), ...m.hashes.slice(1)] },
    { ...m, hashes: 'nope' },
    null,
  ];
  for (const x of broken) assert.equal(manifestShapeOk(x), false, JSON.stringify(x)?.slice(0, 80));
  assert.equal(manifestShapeOk({ ...m, name: 'x'.repeat(200) }), true);
  // 摘要只看哈希：换一个哈希就对不上
  assert.equal(await manifestDigestOk({ ...m, hashes: [sha256('forged'), ...m.hashes.slice(1)] }), false);
  assert.equal(await manifestDigestOk({ ...m, fileId: sha256('other').slice(0, 32) }), false);
});

/** 清单是接收方唯一的真相来源，只能收「我正在向这个人要」的那一份。 */
impl('requestManifest：不请自来的清单一律丢掉，只收正在问的那个人给的', async (dir) => {
  const { swarm, peers } = await manifestRig(dir);
  const [p1, p2] = peers;
  const m = makeManifest('m', 5, { tail: 100 });

  swarm._onCtrl(p1, { t: 'manifest', manifest: m });
  assert.equal(swarm._manifestWaiters.size, 0);

  const promise = swarm.requestManifest(m.fileId, { candidates: [p1.peerId, p2.peerId] });
  const state = track(promise);
  assert.deepEqual(gets(p1), [m.fileId]);
  assert.deepEqual(gets(p2), []);

  // p2 不是正在问的人：整条的、分段开头都不收
  const { hashes, ...meta } = m;
  swarm._onCtrl(p2, { t: 'manifest', manifest: m });
  swarm._onCtrl(p2, { t: 'manifest-start', meta, totalParts: 1 });
  assert.equal(swarm._peerState.get(p2.peerId)?.manifestParts.size ?? 0, 0, '不请自来的分段不能占拼装名额');
  swarm._onCtrl(p2, { t: 'manifest-part', fileId: m.fileId, index: 0, hashes });
  await sleep(20);
  assert.equal(state.done, false);
  assert.equal(swarm._peerState.get(p2.peerId)?.manifestParts.size ?? 0, 0);
  assert.equal(swarm._manifestWaiters.get(m.fileId).current, p1.peerId);

  swarm._onCtrl(p1, { t: 'manifest', manifest: m });
  assert.deepEqual(await promise, m);
  assert.equal(swarm._manifestWaiters.size, 0);
});

impl('requestManifest：对方说没有就立即换下一个，不等超时', async (dir) => {
  const { swarm, peers } = await manifestRig(dir);
  const [p1, p2, p3] = peers;
  const m = makeManifest('miss', 3);
  const promise = swarm.requestManifest(m.fileId, { candidates: [p1.peerId, p2.peerId, p3.peerId] });

  // 不是正在问的人说「没有」，不能让请求跳过 p1
  swarm._onCtrl(p2, { t: 'manifest', fileId: m.fileId, missing: true });
  assert.deepEqual(gets(p2), []);
  assert.equal(swarm._manifestWaiters.get(m.fileId).current, p1.peerId);

  swarm._onCtrl(p1, { t: 'manifest', fileId: m.fileId, missing: true });
  assert.deepEqual(gets(p2), [m.fileId]);
  assert.equal(swarm._manifestWaiters.get(m.fileId).current, p2.peerId);

  swarm._onCtrl(p2, { t: 'manifest', manifest: m });
  assert.deepEqual(await promise, m);
  assert.deepEqual(gets(p3), []);
});

impl('requestManifest：超时换下一个，正在问的人离开也换下一个', async (dir, t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { swarm, peers } = await manifestRig(dir);
  const [p1, p2, p3] = peers;
  const m = makeManifest('slow', 3);
  const promise = swarm.requestManifest(m.fileId, {
    candidates: [p1.peerId, p2.peerId, p3.peerId],
    timeoutMs: 5000,
  });
  const state = track(promise);

  t.mock.timers.tick(4999);
  assert.deepEqual(gets(p2), []);
  t.mock.timers.tick(1);
  assert.deepEqual(gets(p2), [m.fileId]);

  // 超时之后 p1 才回的清单不再算数
  swarm._onCtrl(p1, { t: 'manifest', manifest: m });
  await flush();
  assert.equal(state.done, false);

  swarm.removePeer(p2.peerId);
  assert.deepEqual(gets(p3), [m.fileId]);
  assert.equal(swarm._manifestWaiters.get(m.fileId).current, p3.peerId);

  swarm._onCtrl(p3, { t: 'manifest', manifest: m });
  assert.deepEqual(await promise, m);
  // 成功后计时器已经撤掉：再拨也不会向谁多问一句
  t.mock.timers.tick(10_000);
  assert.deepEqual([gets(p1), gets(p3)], [[m.fileId], [m.fileId]]);
});

impl('requestManifest：摘要不符报 manifest-bad 并换人', async (dir, t) => {
  t.mock.method(console, 'warn', () => {});
  const { swarm, peers } = await manifestRig(dir);
  const [p1, p2] = peers;
  const m = makeManifest('dig', 4);
  const forged = { ...m, hashes: m.hashes.map((h, i) => (i === 2 ? sha256('forged') : h)) };

  const promise = swarm.requestManifest(m.fileId, { candidates: [p1.peerId, p2.peerId] });
  const badSeen = new Promise((r) => swarm.once('manifest-bad', r));
  swarm._onCtrl(p1, { t: 'manifest', manifest: forged });
  // 伪造的清单被收下时 badSeen 永远等不到，和结果赛跑免得测试挂住
  const outcome = await Promise.race([
    badSeen.then((e) => ['bad', e]),
    promise.then((v) => ['accepted', v.hashes[2] === forged.hashes[2] ? 'forged' : 'genuine']),
  ]);
  assert.deepEqual(outcome, ['bad', { fileId: m.fileId, from: p1.peerId }]);
  assert.deepEqual(gets(p2), [m.fileId]);

  swarm._onCtrl(p2, { t: 'manifest', manifest: m });
  assert.deepEqual(await promise, m);
});

/** 列表条目说这部片多大、几片，清单就必须对得上 —— 否则就是拿别的片冒充。 */
impl('requestManifest：和列表条目的大小、片数对不上同样拒收，候选用完就 reject', async (dir, t) => {
  t.mock.method(console, 'warn', () => {});
  const { swarm, peers } = await manifestRig(dir);
  const [p1, p2, p3] = peers;
  const m = makeManifest('exp', 4, { tail: 3 });
  const bad = [];
  swarm.on('manifest-bad', (e) => bad.push(e));

  const wrongSize = swarm.requestManifest(m.fileId, { candidates: [p1.peerId], expect: { size: m.size + 1 } });
  swarm._onCtrl(p1, { t: 'manifest', manifest: m });
  await assert.rejects(wrongSize, /没有人能提供这部片的清单/);

  const wrongCount = swarm.requestManifest(m.fileId, {
    candidates: [p2.peerId],
    expect: { chunkCount: m.chunkCount + 1 },
  });
  swarm._onCtrl(p2, { t: 'manifest', manifest: m });
  await assert.rejects(wrongCount, /没有人能提供这部片的清单/);

  const badShape = swarm.requestManifest(m.fileId, { candidates: [p3.peerId] });
  swarm._onCtrl(p3, { t: 'manifest', manifest: { ...m, name: 'x'.repeat(201) } });
  await assert.rejects(badShape, /没有人能提供这部片的清单/);

  assert.deepEqual(
    bad.map((e) => e.from),
    [p1.peerId, p2.peerId, p3.peerId]
  );

  // 对得上：时长以列表条目为准，原清单不被改动
  const ok = swarm.requestManifest(m.fileId, {
    candidates: [p1.peerId],
    expect: { size: m.size, chunkCount: m.chunkCount, durationSec: 1234 },
  });
  swarm._onCtrl(p1, { t: 'manifest', manifest: m });
  assert.deepEqual(await ok, { ...m, durationSec: 1234 });
  assert.equal(m.durationSec, 60);
  assert.equal(swarm._manifestWaiters.size, 0);
});

impl('requestManifest：无人可问直接 reject，并发请求共用一个 promise，本机有的直接返回', async (dir) => {
  const { swarm, peers } = await manifestRig(dir);
  const [p1, p2] = peers;
  const m = makeManifest('conc', 3);

  await assert.rejects(swarm.requestManifest('XYZ'), /无效的文件标识/);
  await assert.rejects(swarm.requestManifest(m.fileId, { candidates: [] }), /没有人能提供这部片的清单/);
  const stranger = swarm.addPeer(fakePeer('peer-un', { authenticated: false }));
  await assert.rejects(
    swarm.requestManifest(m.fileId, { candidates: ['peer-un', 'nobody-here'] }),
    /没有人能提供这部片的清单/
  );
  assert.deepEqual(gets(stranger), [], '没握手的人不问');
  assert.equal(swarm._manifestWaiters.size, 0);

  const first = swarm.requestManifest(m.fileId, { candidates: [p1.peerId] });
  const second = swarm.requestManifest(m.fileId, { candidates: [p2.peerId, p1.peerId] });
  assert.equal(first, second);
  assert.deepEqual(gets(p1), [m.fileId]);
  assert.deepEqual(gets(p2), [], '只问一个人');
  assert.deepEqual(swarm._manifestWaiters.get(m.fileId).queue, [p2.peerId], '后来的候选排到队尾，正在问的不重复');

  swarm._onCtrl(p1, { t: 'manifest', fileId: m.fileId, missing: true });
  assert.deepEqual(gets(p2), [m.fileId]);
  swarm._onCtrl(p2, { t: 'manifest', manifest: m });
  assert.deepEqual(await first, m);

  // 本机有的：直接返回，不问任何人
  for (const p of peers) p.sent.length = 0;
  swarm.addFile({ slot: 1, manifest: m, sessionId: 's1', isSeeder: true });
  assert.equal(await swarm.requestManifest(m.fileId, { candidates: [p1.peerId] }), m);
  const offered = makeManifest('offer', 2);
  swarm.offerManifest(offered);
  assert.equal(await swarm.requestManifest(offered.fileId, { candidates: [p1.peerId] }), offered);
  assert.deepEqual(gets(p1), []);
});

impl('清单服务端：同一个人 30 秒内只回一次，没进列表的也能取走，撤回后回 missing', async (dir) => {
  const { Swarm } = await load(dir);
  instantStore();
  const swarm = new Swarm({ peerId: 'me-local', name: 'me' });
  const p1 = swarm.addPeer(fakePeer('peer-p1'));
  const p2 = swarm.addPeer(fakePeer('peer-p2'));
  const m = makeManifest('srv', 4);
  swarm.addFile({ slot: 1, manifest: m, sessionId: 's1', isSeeder: true });
  p1.sent.length = 0;
  p2.sent.length = 0;
  const get = (p, fileId) => swarm._onCtrl(p, { t: 'manifest-get', fileId });

  get(p1, m.fileId);
  assert.deepEqual(p1.sent, [{ t: 'manifest', manifest: m }]);
  get(p1, m.fileId);
  assert.equal(p1.sent.length, 1, '30 秒内重复要不再回');
  get(p2, m.fileId);
  assert.deepEqual(p2.sent, [{ t: 'manifest', manifest: m }], '限频按人算');
  swarm._peerState.get('peer-p1').served.set(m.fileId, Date.now() - 30_001);
  get(p1, m.fileId);
  assert.equal(p1.sent.length, 2, '过了 30 秒可以再要');

  // 没有的片：回 missing，而且不限频（对方要靠它立即换人）
  const none = sha256('none').slice(0, 32);
  p1.sent.length = 0;
  get(p1, none);
  get(p1, none);
  assert.deepEqual(p1.sent, [
    { t: 'manifest', fileId: none, missing: true },
    { t: 'manifest', fileId: none, missing: true },
  ]);
  // 不像 fileId 的不理
  get(p1, 'not-a-file-id');
  get(p1, m.fileId.toUpperCase());
  get(p1, 42);
  assert.equal(p1.sent.length, 2);

  // 管理员加的片还没进列表，房主也能来取
  const offered = makeManifest('offer', 3);
  assert.throws(() => swarm.offerManifest({ ...offered, fileId: 'bad' }), /无效的媒体清单/);
  swarm.offerManifest(offered);
  p1.sent.length = 0;
  get(p1, offered.fileId);
  assert.deepEqual(p1.sent, [{ t: 'manifest', manifest: offered }]);
  swarm.withdrawManifest(offered.fileId);
  p2.sent.length = 0;
  get(p2, offered.fileId);
  assert.deepEqual(p2.sent, [{ t: 'manifest', fileId: offered.fileId, missing: true }]);

  // 超过 600 片分段发，每段都在单条上限以内
  const big = makeManifest('big', 1300);
  swarm.addFile({ slot: 3, manifest: big, sessionId: 's3', isSeeder: true });
  const p3 = swarm.addPeer(fakePeer('peer-p3'));
  get(p3, big.fileId);
  await flush();
  const msgs = p3.sent.filter((x) => x.t.startsWith('manifest'));
  assert.equal(msgs[0].t, 'manifest-start');
  assert.equal(msgs[0].totalParts, 3);
  assert.equal('hashes' in msgs[0].meta, false);
  assert.equal(msgs[0].meta.fileId, big.fileId);
  assert.deepEqual(
    msgs.slice(1).map((x) => [x.t, x.fileId, x.index, x.hashes.length]),
    [
      ['manifest-part', big.fileId, 0, 600],
      ['manifest-part', big.fileId, 1, 600],
      ['manifest-part', big.fileId, 2, 100],
    ]
  );
  assert.deepEqual(msgs.slice(1).flatMap((x) => x.hashes), big.hashes);
  for (const x of msgs) assert.ok(Buffer.byteLength(JSON.stringify(x)) < DC_LIMIT);
});

impl('分段清单端到端：发送端切段、接收端拼回并通过摘要校验', async (dir) => {
  const { Swarm } = await load(dir);
  instantStore();
  const server = new Swarm({ peerId: 'server-1', name: 'S' });
  const client = new Swarm({ peerId: 'client-1', name: 'C' });
  const big = makeManifest('wire', 1300, { tail: 7 });
  server.addFile({ slot: 1, manifest: big, sessionId: 's1', isSeeder: true });

  // 两个假连接首尾相接，消息过一遍 JSON，和真通道一样
  const clientOnServer = fakePeer('client-1');
  const serverOnClient = fakePeer('server-1');
  clientOnServer.send = (x) => {
    clientOnServer.sent.push(x);
    client._onCtrl(serverOnClient, JSON.parse(JSON.stringify(x)));
    return true;
  };
  serverOnClient.send = (x) => {
    serverOnClient.sent.push(x);
    server._onCtrl(clientOnServer, JSON.parse(JSON.stringify(x)));
    return true;
  };
  server.addPeer(clientOnServer);
  client.addPeer(serverOnClient);

  const got = await client.requestManifest(big.fileId, {
    candidates: ['server-1'],
    expect: { size: big.size, chunkCount: big.chunkCount, durationSec: 99 },
  });
  assert.deepEqual(got, { ...big, durationSec: 99 });
  assert.equal(clientOnServer.sent.filter((x) => x.t === 'manifest-part').length, 3);
  const st = client._peerState.get('server-1');
  assert.equal(st.manifestParts.size, 0);

  // 同一组分段再来一遍（此时已经没人在要）不会留下拼装状态
  for (const x of clientOnServer.sent) client._onCtrl(serverOnClient, x);
  assert.equal(st.manifestParts.size, 0);
  assert.equal(client._manifestWaiters.size, 0);
});

/* ======================== 7. 大消息 PART ======================== */

impl('PART：认证前不拼，认证后按连接拼装，只放行播放列表和聊天历史', async (dir) => {
  const { Swarm, protocol } = await load(dir);
  instantStore();
  const swarm = new Swarm({ peerId: 'me-local', name: 'me' });
  const a = swarm.addPeer(fakePeer('peer-aa', { authenticated: false }));
  const b = swarm.addPeer(fakePeer('peer-bb'));
  const seen = [];
  swarm.on('ctrl', (e) => seen.push(e));

  const playlist = bigPlaylist();
  const parts = protocol.splitLarge(playlist, 'pl1');
  assert.ok(parts.length >= 2);
  for (const part of parts) swarm._onCtrl(a, part);
  assert.equal(seen.length, 0);
  assert.equal(swarm._peerState.has('peer-aa'), false, '未认证连接不能在本机留下拼装状态');

  swarm._onCtrl(a, hello(a));
  assert.equal(a.authenticated, true);
  // 认证之前收的分段不算数：只补后半截拼不出来
  for (const part of parts.slice(1)) swarm._onCtrl(a, part);
  assert.equal(seen.length, 0);
  // 按连接拼：B 送来的第一段不能和 A 的后半截拼在一起
  swarm._onCtrl(b, parts[0]);
  assert.equal(seen.length, 0);
  swarm._onCtrl(a, parts[0]);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].msg, playlist);
  assert.equal(seen[0].peer, a, '拼好的内层消息算外层这条连接发的');

  const history = { t: 'chat-history', items: [{ from: 'peer-bb', text: '你好'.repeat(10) }] };
  for (const part of protocol.splitLarge(history, 'ch1')) swarm._onCtrl(b, part);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1].msg, history);
  assert.equal(seen[1].peer, b);

  // 白名单以外的内层类型：绕过各自的校验，一律丢
  for (const [inner, id] of [
    [hello(b, { peerId: 'peer-evil' }), 'h1'],
    [{ t: 'bitfield', s: 1, full: true }, 'bf1'],
    [{ t: 'sync', paused: false, position: 0, lamport: 9, seq: 0 }, 'sy1'],
    [{ t: 'part', id: 'x', i: 0, n: 1, data: '' }, 'pp1'],
  ]) {
    for (const part of protocol.splitLarge(inner, id)) swarm._onCtrl(b, part);
  }
  assert.equal(seen.length, 2);
  assert.equal(b.remote.size, 0);
  assert.equal(swarm.peers.get('peer-bb'), b);
});

impl('broadcastLarge：短消息原样发，长消息切成每条都低于 64KB 的 PART，另一端能完整还原', async (dir) => {
  const { Swarm } = await load(dir);
  instantStore();
  const swarm = new Swarm({ peerId: 'me-local', name: 'me' });
  const a = swarm.addPeer(fakePeer('peer-aa'));
  const b = swarm.addPeer(fakePeer('peer-bb'));
  const c = swarm.addPeer(fakePeer('peer-cc', { authenticated: false }));

  const small = { t: 'playlist', rev: 1, queue: [] };
  swarm.broadcastLarge(small, { except: 'peer-bb' });
  assert.deepEqual(a.sent, [small]);
  assert.deepEqual(b.sent, []);
  assert.deepEqual(c.sent, [], '没握手的人不发');

  // 边界：16000 字符以内一定直接发 —— 一个字符最多 3 字节，48KB 仍在上限内
  const pad = JSON.stringify({ t: 'playlist', x: '' }).length;
  const edge = { t: 'playlist', x: '汉'.repeat(16000 - pad) };
  assert.equal(JSON.stringify(edge).length, 16000);
  a.sent.length = 0;
  swarm.broadcastLarge(edge);
  assert.deepEqual(a.sent, [edge]);
  assert.ok(Buffer.byteLength(JSON.stringify(edge)) < DC_LIMIT);
  const over = { t: 'playlist', x: '汉'.repeat(16001 - pad) };
  a.sent.length = 0;
  swarm.broadcastLarge(over);
  assert.ok(a.sent.length >= 1 && a.sent.every((x) => x.t === 'part'));

  const playlist = bigPlaylist();
  assert.ok(Buffer.byteLength(JSON.stringify(playlist)) > DC_LIMIT, '测试数据本身得超过单条上限');
  a.sent.length = 0;
  b.sent.length = 0;
  swarm.broadcastLarge(playlist);
  assert.ok(a.sent.length >= 2);
  for (const x of a.sent) {
    assert.equal(x.t, 'part');
    assert.ok(Buffer.byteLength(JSON.stringify(x)) < DC_LIMIT);
  }
  assert.deepEqual(b.sent, a.sent, '每个人收到同一组分段');
  assert.equal(new Set(a.sent.map((x) => x.id)).size, 1);
  assert.deepEqual(c.sent, []);

  // 另一端还原
  const receiver = new Swarm({ peerId: 'peer-aa', name: 'A' });
  const fromMe = receiver.addPeer(fakePeer('me-local'));
  const seen = [];
  receiver.on('ctrl', (e) => seen.push(e));
  for (const x of a.sent) receiver._onCtrl(fromMe, JSON.parse(JSON.stringify(x)));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].msg, playlist);
  assert.equal(seen[0].peer, fromMe);

  // sendLarge：发不出去就停，并如实返回
  const flaky = fakePeer('peer-dd');
  let calls = 0;
  flaky.send = () => {
    calls++;
    return false;
  };
  assert.equal(swarm.sendLarge(flaky, playlist), false);
  assert.equal(calls, 1);
  a.sent.length = 0;
  assert.equal(swarm.sendLarge(a, small), true);
  assert.deepEqual(a.sent, [small]);
});

/* ======================== 8. HELLO ======================== */

/**
 * 0.6 的帧头和消息都对不上，模式一致也没法互通。版本检查必须排在模式检查前面：
 * 否则老客户端缺 securityMode 被按 safe 处理，报出来的是「安全模式不一致」，
 * 用户会去改设置而不是去升级。
 */
impl('HELLO：协议版本不符先于安全模式检查，断开并记下；缺 ver 按 1 算', async (dir) => {
  const { Swarm } = await load(dir);
  instantStore();
  const swarm = new Swarm({ peerId: 'me-local', name: 'me', securityMode: 'trusted' });
  const events = { version: [], mode: [], auth: [], gone: [] };
  swarm.on('version-mismatch', (e) => events.version.push(e));
  swarm.on('mode-mismatch', (e) => events.mode.push(e));
  swarm.on('peer-authenticated', (e) => events.auth.push(e));
  swarm.on('peer-gone', (e) => events.gone.push(e));

  for (const [id, extra, remoteVersion] of [
    ['peer-v1', {}, 1],
    ['peer-v3', { ver: 3 }, 3],
    ['peer-vs', { ver: '2' }, 1],
  ]) {
    for (const k of Object.keys(events)) events[k].length = 0;
    const peer = swarm.addPeer(fakePeer(id, { authenticated: false }));
    const msg = { t: 'hello', peerId: id, name: '老版本客户端', platform: 'android', ...extra };
    swarm._onCtrl(peer, msg);

    assert.equal(events.version.length, 1, id);
    const { peer: evPeer, ...rest } = events.version[0];
    assert.equal(evPeer, peer);
    assert.deepEqual(rest, { peerId: id, name: '老版本客户端', localVersion: 2, remoteVersion });
    assert.deepEqual(events.mode, [], '版本不对时不该再报模式不一致');
    assert.deepEqual(events.auth, []);
    assert.deepEqual(events.gone, [id]);
    assert.equal(swarm.peers.has(id), false);
    assert.equal(peer.closed, true);
    assert.notEqual(peer.authenticated, true);
    assert.equal(peer.platform, undefined);
    assert.ok(swarm.versionRejected.has(id));
  }
});

impl('HELLO：版本对了才看安全模式；通过后记下平台（非 android 一律 desktop）并补发全部槽位位图', async (dir) => {
  const { Swarm } = await load(dir);
  instantStore();
  const swarm = new Swarm({ peerId: 'me-local', name: 'me' });
  const m1 = makeManifest('h1', 3);
  swarm.addFile({ slot: 1, manifest: m1, sessionId: 's1', isSeeder: true });
  swarm.addFile({ slot: 2, manifest: makeManifest('h2', 3), sessionId: 's2', isSeeder: false });
  const events = { version: [], mode: [], auth: [] };
  swarm.on('version-mismatch', (e) => events.version.push(e));
  swarm.on('mode-mismatch', (e) => events.mode.push(e));
  swarm.on('peer-authenticated', (e) => events.auth.push(e));

  const trusted = swarm.addPeer(fakePeer('peer-tr', { authenticated: false }));
  swarm._onCtrl(trusted, hello(trusted, { securityMode: 'trusted' }));
  assert.deepEqual(events.mode, [{ peerId: 'peer-tr', localMode: 'safe', remoteMode: 'trusted' }]);
  assert.deepEqual(events.version, []);
  assert.equal(swarm.versionRejected.has('peer-tr'), false, '模式不一致不算版本问题');
  assert.equal(swarm.peers.has('peer-tr'), false);

  for (const [id, platform, expected] of [
    ['peer-an', 'android', 'android'],
    ['peer-io', 'ios', 'desktop'],
    ['peer-np', undefined, 'desktop'],
    ['peer-AN', 'ANDROID', 'desktop'],
  ]) {
    const p = swarm.addPeer(fakePeer(id, { authenticated: false }));
    // 认证之前的业务消息一律不理
    swarm._onCtrl(p, { t: 'request', s: 1, index: 0 });
    swarm._onCtrl(p, { t: 'manifest-get', fileId: m1.fileId });
    swarm._onCtrl(p, { t: 'bitfield', s: 1, full: true });
    assert.deepEqual(p.sent, []);
    assert.equal(p.remote.size, 0);

    swarm._onCtrl(p, hello(p, { platform }));
    assert.equal(p.authenticated, true);
    assert.equal(p.platform, expected);
    assert.deepEqual(ofType(p, 'bitfield').map((x) => x.s), [1, 2]);
    assert.equal(swarm.peerList().find((x) => x.peerId === id).platform, expected);
    assert.equal(events.auth.at(-1), p);
  }

  // 重复的 HELLO 不理
  const p = swarm.peers.get('peer-an');
  swarm._onCtrl(p, hello(p, { platform: 'desktop' }));
  assert.equal(p.platform, 'android');
  assert.equal(ofType(p, 'bitfield').length, 2);
  assert.equal(events.version.length, 0);
});

/* ======================== 9. 人走了、换了身份 ======================== */

impl('removePeer 清掉这个人的全部状态，正在向他要的清单换人；同 id 重连后没有旧状态残留', async (dir) => {
  const { Swarm, protocol } = await load(dir);
  const store = deferredStore();
  const swarm = new Swarm({ peerId: 'me-local', name: 'me' });
  const p = swarm.addPeer(fakePeer('peer-pp'));
  const q = swarm.addPeer(fakePeer('peer-qq'));
  const leechM = makeManifest('l', 8);
  const seedM = makeManifest('s', 4);
  const x = makeManifest('x', 3);
  const leechCtx = swarm.addFile({ slot: 1, manifest: leechM, sessionId: 's1', isSeeder: false });
  swarm.addFile({ slot: 2, manifest: seedM, sessionId: 's2', isSeeder: true });

  // 我向他要片
  swarm._onCtrl(p, { t: 'bitfield', s: 1, full: true });
  swarm.setActive(1);
  const pIdx = [...swarm.inflight.values()].filter((i) => i.peerId === 'peer-pp').map((i) => i.index);
  assert.equal(pIdx.length, 4);
  // 他向我要片
  for (const index of [0, 1, 2]) swarm._onCtrl(p, { t: 'request', s: 2, index });
  assert.equal(swarm._serving.get('peer-pp'), 2);
  assert.equal(swarm._serveQueue.get('peer-pp').length, 1);
  // 他发了半截播放列表、要过清单、发过列表外槽位的 HAVE
  const parts = protocol.splitLarge(bigPlaylist(), 'half');
  swarm._onCtrl(p, parts[0]);
  swarm._onCtrl(p, { t: 'manifest-get', fileId: seedM.fileId });
  swarm._onCtrl(p, { t: 'have', s: 42, index: 1 });
  const st = swarm._peerState.get('peer-pp');
  assert.equal(st.parts.pending.size, 1);
  assert.ok(st.served.has(seedM.fileId));
  assert.equal(st.unknown.length, 1);
  // 我在向他要清单
  const pending = swarm.requestManifest(x.fileId, { candidates: ['peer-pp', 'peer-qq'] });
  assert.equal(swarm._manifestWaiters.get(x.fileId).current, 'peer-pp');

  const gone = [];
  swarm.on('peer-gone', (id) => gone.push(id));
  swarm.removePeer('peer-pp');
  assert.deepEqual(gone, ['peer-pp']);
  assert.equal(p.closed, true);
  for (const map of [swarm.peers, swarm._serving, swarm._serveQueue, swarm._peerState]) {
    assert.equal(map.has('peer-pp'), false);
  }
  assert.equal([...swarm.inflight.values()].some((i) => i.peerId === 'peer-pp'), false);
  for (const i of pIdx) assert.equal(leechCtx.assembler.has(i), false, '他欠的片放回池子');
  assert.deepEqual(gets(q), [x.fileId]);
  assert.equal(swarm._manifestWaiters.get(x.fileId).current, 'peer-qq');

  // 同一个 id 重连
  const p2 = swarm.addPeer(fakePeer('peer-pp', { authenticated: false }));
  swarm._onCtrl(p2, hello(p2));
  assert.equal(swarm._serving.get('peer-pp'), 0);
  assert.deepEqual(swarm._serveQueue.get('peer-pp'), []);
  const seen = [];
  swarm.on('ctrl', (e) => seen.push(e));
  for (const part of parts.slice(1)) swarm._onCtrl(p2, part);
  assert.equal(seen.length, 0, '旧连接拼到一半的分段不能和新连接的拼在一起');
  p2.sent.length = 0;
  swarm._onCtrl(p2, { t: 'manifest-get', fileId: seedM.fileId });
  assert.deepEqual(ofType(p2, 'manifest'), [{ t: 'manifest', manifest: seedM }], '回清单的限频跟着旧连接走了');
  swarm.setCatalog([catalogOf(42, makeManifest('c42', 4))]);
  assert.equal(p2.remote.has(42), false, '旧连接暂存的 HAVE 不能补放到新连接上');
  assert.equal(store.writes.length, 0);

  swarm._onCtrl(q, { t: 'manifest', manifest: x });
  assert.deepEqual(await pending, x);
});

/**
 * 信令重连时同一个 peerId 换上新连接，旧连接手上还有读到一半的片。
 * 旧的那份发片收尾按 peerId 去扣计数，扣到的是新连接的 —— 新连接的并发上限就被打穿了，
 * 而 SERVE_CONCURRENCY 本来就是为了不把对方的 ctrl 通道拖慢才设的。
 */
impl('同 id 重连后，旧连接迟到的发片收尾不能扣掉新连接的并发计数', async (dir) => {
  const { Swarm } = await load(dir);
  const store = deferredStore();
  const swarm = new Swarm({ peerId: 'me-local', name: 'me' });
  swarm.addFile({ slot: 1, manifest: makeManifest('rc', 8), sessionId: 's1', isSeeder: true });
  const old = swarm.addPeer(fakePeer('peer-pp'));
  swarm._onCtrl(old, { t: 'request', s: 1, index: 0 });
  swarm._onCtrl(old, { t: 'request', s: 1, index: 1 });
  assert.equal(store.reads.length, 2);

  const fresh = swarm.addPeer(fakePeer('peer-pp'));
  assert.equal(old.closed, true);
  for (const index of [2, 3, 4]) swarm._onCtrl(fresh, { t: 'request', s: 1, index });
  assert.deepEqual(store.readKeys(), ['s1:0', 's1:1', 's1:2', 's1:3']);
  assert.equal(swarm._serving.get('peer-pp'), 2);

  store.reads[0].resolve(new ArrayBuffer(CHUNK));
  store.reads[1].resolve(new ArrayBuffer(CHUNK));
  await flush();
  assert.deepEqual(old.chunks, [], '摘掉的连接不再发片');

  swarm._onCtrl(fresh, { t: 'request', s: 1, index: 5 });
  assert.deepEqual(
    store.readKeys().slice(2),
    ['s1:2', 's1:3'],
    '新连接手上仍有 2 片在发，第 4、5 片必须排队 —— 同时给一个人发的片不能超过 2 片'
  );
  assert.equal(swarm._serving.get('peer-pp'), 2);
  assert.deepEqual(swarm._serveQueue.get('peer-pp'), [
    { slot: 1, index: 4 },
    { slot: 1, index: 5 },
  ]);
});

impl('renamePeer 迁移按人记的状态、在途记录和清单请求', async (dir) => {
  const { Swarm, protocol } = await load(dir);
  instantStore();
  const swarm = new Swarm({ peerId: 'me-local', name: 'me' });
  const temp = swarm.addPeer(fakePeer('pending-01'));
  const q = swarm.addPeer(fakePeer('peer-qq'));
  swarm.addFile({ slot: 1, manifest: makeManifest('rn', 8), sessionId: 's1', isSeeder: false });
  swarm._onCtrl(temp, { t: 'bitfield', s: 1, full: true });
  swarm.setActive(1);
  assert.equal(swarm.inflight.size, 4);

  const parts = protocol.splitLarge(bigPlaylist(), 'rn1');
  swarm._onCtrl(temp, parts[0]);
  const stateBefore = swarm._peerState.get('pending-01');
  const queueBefore = swarm._serveQueue.get('pending-01');
  const x = makeManifest('x', 3);
  const y = makeManifest('y', 3);
  const px = swarm.requestManifest(x.fileId, { candidates: ['pending-01'] });
  const py = swarm.requestManifest(y.fileId, { candidates: ['peer-qq', 'pending-01'] });

  assert.equal(swarm.renamePeer('pending-01', 'peer-qq'), false, '不能改成已在场的人');
  assert.equal(swarm.renamePeer('pending-01', 'bad id!'), false);
  assert.equal(swarm.renamePeer('pending-01', 'real-peer-01', '真名'), true);

  assert.equal(swarm.peers.get('real-peer-01'), temp);
  assert.equal(temp.peerId, 'real-peer-01');
  assert.equal(temp.name, '真名');
  for (const map of [swarm.peers, swarm._serving, swarm._serveQueue, swarm._peerState]) {
    assert.equal(map.has('pending-01'), false);
  }
  assert.equal(swarm._peerState.get('real-peer-01'), stateBefore);
  assert.equal(swarm._serveQueue.get('real-peer-01'), queueBefore);
  assert.equal(swarm._serving.get('real-peer-01'), 0);
  assert.deepEqual(
    [...swarm.inflight.values()].map((i) => i.peerId),
    ['real-peer-01', 'real-peer-01', 'real-peer-01', 'real-peer-01']
  );
  assert.equal(swarm._manifestWaiters.get(x.fileId).current, 'real-peer-01');
  assert.deepEqual(swarm._manifestWaiters.get(y.fileId).queue, ['real-peer-01']);

  // 旧身份下拼了一半的分段接着拼
  const seen = [];
  swarm.on('ctrl', (e) => seen.push(e));
  for (const part of parts.slice(1)) swarm._onCtrl(temp, part);
  assert.equal(seen.length, 1);

  // 改名后的人给的清单照收；q 没有 y 时轮到他
  swarm._onCtrl(temp, { t: 'manifest', manifest: x });
  assert.deepEqual(await px, x);
  swarm._onCtrl(q, { t: 'manifest', fileId: y.fileId, missing: true });
  assert.deepEqual(gets(temp), [x.fileId, y.fileId]);
  swarm._onCtrl(temp, { t: 'manifest', manifest: y });
  assert.deepEqual(await py, y);

  // 他的 DENY 仍能撤掉记在他名下的在途
  const { index } = [...swarm.inflight.values()][0];
  swarm._onCtrl(temp, { t: 'deny', s: 1, index });
  assert.equal(swarm.inflight.has(`1:${index}`), false);
  assert.equal(temp.inflight.has(`1:${index}`), false);
});

/* ======================== 10. 在途超时 ======================== */

impl('_expireStale：超时的在途收回并给对方发 CANCEL；超时按各槽位自己的分片大小算', async (dir) => {
  const { Swarm } = await load(dir);
  instantStore();
  const swarm = new Swarm({ peerId: 'me-local', name: 'me' });
  const p = swarm.addPeer(fakePeer('peer-pp'));
  const ctx = swarm.addFile({ slot: 1, manifest: makeManifest('ex', 8), sessionId: 's1', isSeeder: false });
  swarm._onCtrl(p, { t: 'bitfield', s: 1, full: true });
  swarm.setActive(1);
  const [key0, info0] = [...swarm.inflight][0];
  info0.at = performance.now() - 20_001; // 测不出速率时固定 20 秒
  p.sent.length = 0;

  swarm._expireStale();
  assert.deepEqual(p.sent, [{ t: 'cancel', s: 1, index: info0.index }]);
  assert.equal(swarm.inflight.has(key0), false);
  assert.equal(p.inflight.has(key0), false);
  assert.equal(ctx.assembler.has(info0.index), false);
  assert.equal(swarm.inflight.size, 3);
  swarm._expireStale();
  assert.equal(p.sent.length, 1, '没超时的不动');

  // 同一个人、同样的等待时长：2 片在途、RTT 100ms、1KB/s。
  // 2KB 分片预计 4.1 秒到，超时 14.3 秒；4KB 分片预计 8.1 秒到，超时 20 秒。
  const slowPeer = swarm.addPeer(fakePeer('peer-rt'));
  slowPeer.rtt = 100;
  slowPeer.downRate = 1024;
  swarm.addFile({ slot: 5, manifest: makeManifest('sm', 4, { chunkSize: 2048 }), sessionId: 's5', isSeeder: false });
  swarm.addFile({ slot: 6, manifest: makeManifest('lg', 4, { chunkSize: 4096 }), sessionId: 's6', isSeeder: false });
  const at = performance.now() - 15_000;
  swarm.inflight.set('6:0', { peerId: 'peer-rt', at, slot: 6, index: 0 });
  slowPeer.inflight.add('6:0');
  swarm.inflight.set('5:0', { peerId: 'peer-rt', at, slot: 5, index: 0 });
  slowPeer.inflight.add('5:0');
  slowPeer.sent.length = 0; // 挂片时发给他的位图不算

  swarm._expireStale();
  assert.deepEqual(slowPeer.sent, [{ t: 'cancel', s: 5, index: 0 }]);
  assert.equal(swarm.inflight.has('6:0'), true);
  assert.equal(swarm._requestTimeout(slowPeer, undefined), 20000);
});

/* ======================== 11. 能不能收齐 ======================== */

/** 按片算，不按人算：两个各有一半的人也能凑齐。没握手的人手里的片不算数。 */
impl('sourcesFor / canFinish：按片凑齐，未认证的人不算', async (dir) => {
  const { Swarm, protocol } = await load(dir);
  instantStore();
  const swarm = new Swarm({ peerId: 'me-local', name: 'me' });
  const m = makeManifest('f', 6);
  swarm.addFile({ slot: 1, manifest: m, sessionId: 's1', isSeeder: false });
  const a = swarm.addPeer(fakePeer('peer-aa'));
  const b = swarm.addPeer(fakePeer('peer-bb'));
  const c = swarm.addPeer(fakePeer('peer-cc'));
  const u = swarm.addPeer(fakePeer('peer-uu', { authenticated: false }));
  const bits = (arr) => protocol.packBitfield(Uint8Array.from(arr));

  assert.equal(swarm.canFinish(1), false, '没人有');
  assert.deepEqual(swarm.sourcesFor(1), []);

  swarm._onCtrl(a, { t: 'bitfield', s: 1, bits: bits([1, 1, 1, 0, 0, 0]) });
  swarm._onCtrl(c, { t: 'bitfield', s: 1, bits: bits([0, 0, 0, 0, 0, 0]) });
  u.remote.set(1, { have: new Uint8Array(6).fill(1), full: true });
  assert.equal(swarm.canFinish(1), false, '未认证的人手里的片不算');
  assert.deepEqual(swarm.sourcesFor(1), ['peer-aa'], '一片都没有的人不算来源');

  swarm._onCtrl(b, { t: 'bitfield', s: 1, bits: bits([0, 0, 0, 1, 1, 0]) });
  assert.equal(swarm.canFinish(1), false, '第 5 片谁都没有');
  assert.deepEqual(swarm.sourcesFor(1).sort(), ['peer-aa', 'peer-bb']);
  swarm._onCtrl(b, { t: 'have', s: 1, index: 5 });
  assert.equal(swarm.canFinish(1), true, '两个各有一半的人能凑齐');

  swarm._onCtrl(b, { t: 'deny', s: 1, index: 5 });
  assert.equal(swarm.canFinish(1), false);
  // 本机已有的片不需要别人有（换了会话重挂）
  swarm.addFile({
    slot: 1,
    manifest: m,
    sessionId: 's1b',
    isSeeder: false,
    state: { bitfield: bits([0, 0, 0, 0, 0, 1]), haveCount: 1, contiguousBytes: 0, complete: false },
  });
  assert.equal(swarm.canFinish(1), true);

  // 本机没挂、只在列表里的槽位按列表的片数算
  const m2 = makeManifest('g', 3);
  assert.equal(swarm.canFinish(2), false, '不认识的槽位');
  swarm.setCatalog([catalogOf(1, m), catalogOf(2, m2), catalogOf(4, makeManifest('h', 2))]);
  swarm._onCtrl(a, { t: 'have', s: 2, index: 0 });
  swarm._onCtrl(b, { t: 'have', s: 2, index: 1 });
  assert.equal(swarm.canFinish(2), false);
  swarm._onCtrl(c, { t: 'have', s: 2, index: 2 });
  assert.equal(swarm.canFinish(2), true);
  assert.deepEqual(swarm.sourcesFor(2).sort(), ['peer-aa', 'peer-bb', 'peer-cc']);

  // 只有未认证的人有整部：不算；握手通过后才算
  u.remote.set(4, { have: new Uint8Array(2).fill(1), full: true });
  assert.equal(swarm.canFinish(4), false);
  assert.deepEqual(swarm.sourcesFor(4), []);
  u.authenticated = true;
  assert.equal(swarm.canFinish(4), true);
  assert.deepEqual(swarm.sourcesFor(4), ['peer-uu']);

  // 本机已经收齐：谁都不需要
  swarm.addFile({ slot: 7, manifest: makeManifest('done', 2), sessionId: 's7', isSeeder: true });
  assert.equal(swarm.canFinish(7), true);
});
