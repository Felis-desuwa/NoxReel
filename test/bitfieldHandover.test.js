'use strict';

/**
 * 对方位图的交接（v2 多槽位）。
 *
 * 0.7 起每部片占一个槽位，对方手里有什么按槽位分开记在 peer.remote 里；
 * 位图本身不带片数，解码全靠「这个槽位是几片」—— 本机挂着这部片就按本机清单，
 * 否则按播放列表给的 catalog。两边都还不知道的槽位先暂存，列表或文件到了再补放。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { IMPLS } = require('./helpers/impls');

const MB2 = 2 * 1024 ** 2;

function manifestFor(fileId, chunkCount) {
  return {
    fileId,
    name: `${fileId}.mkv`,
    size: chunkCount * MB2,
    chunkSize: MB2,
    chunkCount,
    hashes: Array.from({ length: chunkCount }, (_, i) => i.toString(16).padStart(64, '0')),
  };
}

/** 播放列表里的一条目录项，只带解位图要用的元数据，不带哈希。 */
function catalogEntry(slot, manifest) {
  return {
    slot,
    fileId: manifest.fileId,
    size: manifest.size,
    chunkCount: manifest.chunkCount,
    chunkSize: manifest.chunkSize,
  };
}

function fakePeer(peerId) {
  return {
    peerId,
    name: peerId,
    pc: { iceConnectionState: 'connected' },
    ctrl: { readyState: 'open' },
    authenticated: true,
    ready: false,
    remote: new Map(),
    inflight: new Set(),
    downRate: 0,
    rtt: 0,
    closed: false,
    sent: [],
    on() {
      return () => {};
    },
    send(msg) {
      this.sent.push(msg);
      return true;
    },
    close() {
      this.closed = true;
    },
  };
}

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

/** 临时把 Date.now 换成可控的钟；暂存区的 60 秒有效期按它算。 */
async function withClock(start, fn) {
  const real = Date.now;
  let now = start;
  Date.now = () => now;
  try {
    return await fn({
      advance(ms) {
        now += ms;
      },
    });
  } finally {
    Date.now = real;
  }
}

const SLOT = 1;

/* ------------------- 位图先到、本机会话后到 ------------------- */

/**
 * 接收方的真实顺序是「先收到列表和位图 → 再异步打开本地会话（openLeech）→ addFile」。
 * 位图只在对端握手或对方挂片时发一次，如果 addFile 把它清掉，调度器就永远筛不出上游，
 * 表现是连上了、列表也有了，却一个字节都收不到（传输面板恒显示 0 B）。
 */
impl('位图先于本机会话到达时不会被清掉，调度器仍能选出上游', async (dir) => {
  const { Swarm } = await import(dir + 'swarm.js');
  const { packBitfield } = await import(dir + 'protocol.js');

  const manifest = manifestFor('a'.repeat(32), 4);
  const receiver = new Swarm({ peerId: 'guest', name: 'guest' });
  const host = fakePeer('host');
  receiver.addPeer(host);

  // 列表先到，位图紧跟着到，都在本机 openLeech 返回之前。
  receiver.setCatalog([catalogEntry(SLOT, manifest)]);
  receiver._onCtrl(host, { t: 'bitfield', s: SLOT, bits: packBitfield(Uint8Array.from([1, 1, 1, 1])) });
  assert.ok(host.remote.get(SLOT), '位图应当在没有本机会话时也能按列表解出来');

  // openLeech 返回，本机这才挂上这部片。
  const ctx = receiver.addFile({
    slot: SLOT,
    manifest,
    sessionId: 'session-1',
    isSeeder: false,
    state: { bitfield: packBitfield(new Uint8Array(4)), haveCount: 0, contiguousBytes: 0 },
  });

  assert.deepEqual([...host.remote.get(SLOT).have], [1, 1, 1, 1], '挂片不能清掉对方的位图');
  assert.equal(host.ready, true);

  const plan = ctx.scheduler.plan({
    have: ctx.have,
    playbackByte: 0,
    inflight: new Set(),
    peers: receiver._peerViews(SLOT),
  });
  assert.ok(plan.length > 0, '调度器必须能把分片分配给房主');
  assert.equal(plan[0].peerId, 'host');

  // 真正指定要这部之后，请求确实发出去了，而且带着槽位。
  host.sent.length = 0;
  receiver.setActive(SLOT);
  const requests = host.sent.filter((m) => m.t === 'request');
  assert.ok(requests.length > 0, '设为活动槽位后必须立刻向房主要片');
  assert.ok(requests.every((m) => m.s === SLOT), '每条 REQUEST 都得带上槽位');
});

/**
 * 更早的情况：列表还没到，位图就到了。这时连片数都不知道，没法解 ——
 * 只能先暂存，等 addFile 带来清单后按原顺序补放。直接丢掉就会重现「永远 0 B」。
 */
impl('列表还没到时先到的位图和 HAVE 会暂存，挂片后按原顺序补放', async (dir) => {
  const { Swarm } = await import(dir + 'swarm.js');
  const { packBitfield } = await import(dir + 'protocol.js');

  const manifest = manifestFor('a'.repeat(32), 4);
  const receiver = new Swarm({ peerId: 'guest', name: 'guest' });
  const host = fakePeer('host');
  receiver.addPeer(host);

  // 先整张位图（前两片），再补一条 HAVE（第 4 片）。
  // 补放顺序要是颠倒，后到的整张位图就会把 HAVE 盖掉。
  receiver._onCtrl(host, { t: 'bitfield', s: SLOT, bits: packBitfield(Uint8Array.from([1, 1, 0, 0])) });
  receiver._onCtrl(host, { t: 'have', s: SLOT, index: 3 });
  assert.equal(host.remote.has(SLOT), false, '片数未知时不能瞎猜着解码');

  receiver.addFile({ slot: SLOT, manifest, sessionId: 'session-1', isSeeder: false });
  assert.deepEqual([...host.remote.get(SLOT).have], [1, 1, 0, 1], '暂存的消息必须按到达顺序补放');

  host.sent.length = 0;
  receiver.setActive(SLOT);
  const asked = host.sent.filter((m) => m.t === 'request').map((m) => m.index);
  assert.deepEqual(asked.sort((a, b) => a - b), [0, 1, 3], '只向他要他真有的片');
});

impl('暂存的位图在列表到达（setCatalog）时同样补放，不必等本机挂片', async (dir) => {
  const { Swarm } = await import(dir + 'swarm.js');

  const manifest = manifestFor('a'.repeat(32), 4);
  const swarm = new Swarm({ peerId: 'guest', name: 'guest' });
  const host = fakePeer('host');
  swarm.addPeer(host);

  swarm._onCtrl(host, { t: 'bitfield', s: SLOT, full: true });
  assert.deepEqual(swarm.sourcesFor(SLOT), []);

  // 「谁手里有这部」要在本机开会话之前就能回答 —— 选片、等人都靠它。
  swarm.setCatalog([catalogEntry(SLOT, manifest)]);
  assert.deepEqual(swarm.sourcesFor(SLOT), ['host']);
  assert.equal(swarm.canFinish(SLOT), true);
  assert.equal(host.remote.get(SLOT).have.length, 4);
});

/** 暂存区是给「列表稍晚一步」兜底的，不是无限缓冲：过期的不补，超量的挤掉最老的。 */
impl('暂存区超过 60 秒的消息不再补放，每人最多留 256 条', async (dir) => {
  const { Swarm } = await import(dir + 'swarm.js');

  await withClock(1_000_000, async (clock) => {
    const swarm = new Swarm({ peerId: 'guest', name: 'guest' });
    const host = fakePeer('host');
    swarm.addPeer(host);

    // 过期：60 秒前的位图作废
    swarm._onCtrl(host, { t: 'bitfield', s: 7, full: true });
    clock.advance(60_000);
    swarm.setCatalog([catalogEntry(7, manifestFor('b'.repeat(32), 4))]);
    assert.equal(host.remote.has(7), false, '过期的暂存消息不能补放');

    // 超量：257 条 HAVE，最早那条被挤掉
    for (let i = 0; i <= 256; i++) swarm._onCtrl(host, { t: 'have', s: 8, index: i });
    swarm.setCatalog([catalogEntry(8, manifestFor('c'.repeat(32), 300))]);
    const have = host.remote.get(8).have;
    assert.equal(have[0], 0, '超出上限时应当丢最老的那条');
    assert.equal(have[1], 1);
    assert.equal(have[256], 1);
    assert.equal(have.reduce((a, b) => a + b, 0), 256);
  });
});

/* ------------------- 槽位离开列表：对方那份状态失效 ------------------- */

/**
 * 单槽时代的「对方换了片，旧位图作废」在 v2 里没有直接对应物：槽位由房主按 fileId
 * 分配、一一对应，同一个槽位不会变成另一部片。会失效的是「这个槽位不在列表里了」——
 * 那时对方那份位图既没人用、也不该再被当成「他有片」报给上层，所以 setCatalog 要把它删掉。
 * （对方自己删了片走的是 DENY gone，见 chunkDuplicate.test.js。）
 */
impl('槽位从列表里移除后，对方在该槽位的位图随之失效', async (dir) => {
  const { Swarm } = await import(dir + 'swarm.js');
  const { packBitfield } = await import(dir + 'protocol.js');

  const oldFilm = manifestFor('a'.repeat(32), 4);
  const newFilm = manifestFor('b'.repeat(32), 6);
  const receiver = new Swarm({ peerId: 'guest', name: 'guest' });
  const host = fakePeer('host');
  receiver.addPeer(host);

  receiver.setCatalog([catalogEntry(1, oldFilm), catalogEntry(2, newFilm)]);
  receiver._onCtrl(host, { t: 'bitfield', s: 1, bits: packBitfield(Uint8Array.from([1, 1, 1, 1])) });
  receiver._onCtrl(host, { t: 'bitfield', s: 2, full: true });
  assert.deepEqual(receiver.sourcesFor(1), ['host']);

  // 房主把第一部从列表里删了
  receiver.setCatalog([catalogEntry(2, newFilm)]);

  assert.equal(host.remote.has(1), false, '列表里没有的槽位，对方那份位图必须丢弃');
  assert.deepEqual(receiver.sourcesFor(1), []);
  assert.equal(receiver.canFinish(1), false, '不在列表里的槽位谈不上能不能收齐');
  assert.equal(host.remote.get(2).have.length, 6, '还在列表里的槽位不受影响');
  assert.deepEqual(receiver.sourcesFor(2), ['host']);

  // 之后再来的该槽位消息也不会凭空复活它，只进暂存区
  receiver._onCtrl(host, { t: 'have', s: 1, index: 0 });
  assert.equal(host.remote.has(1), false);
});

/**
 * 本机还挂着这个槽位时（例如本机刚 addFile、列表还没同步回来），槽位和 fileId 的对应
 * 由本机清单保证，对方的位图仍然描述同一部片，不能因为 catalog 暂时没有就删掉 ——
 * 否则这段空档里收到的位图全丢，又是「连上了却不动」。
 */
impl('本机仍挂着的槽位即使暂时不在列表里，对方的位图也保留', async (dir) => {
  const { Swarm } = await import(dir + 'swarm.js');

  const film = manifestFor('a'.repeat(32), 4);
  const swarm = new Swarm({ peerId: 'guest', name: 'guest' });
  const host = fakePeer('host');
  swarm.addPeer(host);
  swarm.addFile({ slot: SLOT, manifest: film, sessionId: 'session-1', isSeeder: false });

  swarm._onCtrl(host, { t: 'bitfield', s: SLOT, full: true });
  swarm.setCatalog([]);

  assert.ok(host.remote.get(SLOT), '本机清单还在，位图仍然有效');
  assert.deepEqual(swarm.sourcesFor(SLOT), ['host']);
});

/* ------------------- 按谁的片数解码 ------------------- */

/**
 * 位图属于某个槽位，尺寸只能按那个槽位的片数算，跟本机正在播哪部无关。
 * 单槽时代的 bug 是拿本机清单去解别人的位图，长度对不上就整张作废。
 */
impl('本机正播另一部片时，位图仍按该槽位自己的片数解码', async (dir) => {
  const { Swarm } = await import(dir + 'swarm.js');
  const { packBitfield } = await import(dir + 'protocol.js');

  const mine = manifestFor('c'.repeat(32), 3);
  const theirs = manifestFor('d'.repeat(32), 9);
  const swarm = new Swarm({ peerId: 'me', name: 'me' });
  const other = fakePeer('other');
  swarm.addPeer(other);
  swarm.addFile({ slot: 1, manifest: mine, sessionId: 'session-3', isSeeder: true });
  swarm.setPlaying(1);
  swarm.setCatalog([catalogEntry(1, mine), catalogEntry(2, theirs)]);

  swarm._onCtrl(other, { t: 'bitfield', s: 2, bits: packBitfield(new Uint8Array(9).fill(1)) });
  assert.equal(other.remote.get(2).have.length, 9);
  assert.equal(other.remote.get(2).have.reduce((a, b) => a + b, 0), 9);
  assert.equal(other.remote.has(1), false, '别的槽位的位图不能写进本机这部片');

  // HAVE 的越界检查同样按各自槽位：第 9 片对槽位 2 合法，对 3 片的槽位 1 不合法
  swarm._onCtrl(other, { t: 'bitfield', s: 1, bits: packBitfield(new Uint8Array(3)) });
  swarm._onCtrl(other, { t: 'have', s: 1, index: 5 });
  assert.equal(other.remote.get(1).have.length, 3);
  assert.equal(other.remote.get(1).have.reduce((a, b) => a + b, 0), 0, '越界的 HAVE 必须忽略');

  swarm._onCtrl(other, { t: 'bitfield', s: 2, full: true });
  assert.equal(other.remote.get(2).full, true);
  assert.equal(other.remote.get(2).have.length, 9, '「全有」也要按该槽位的片数展开');
});

/** 本机清单和列表目录同时存在时以本机清单为准：它是校验过哈希的那一份。 */
impl('同一槽位本机已挂片时，位图按本机清单的片数解', async (dir) => {
  const { Swarm } = await import(dir + 'swarm.js');

  const film = manifestFor('e'.repeat(32), 5);
  const swarm = new Swarm({ peerId: 'me', name: 'me' });
  const other = fakePeer('other');
  swarm.addPeer(other);
  // 目录项故意报错片数，模拟列表和本机清单短暂不一致
  swarm.setCatalog([{ ...catalogEntry(SLOT, film), chunkCount: 2 }]);
  swarm.addFile({ slot: SLOT, manifest: film, sessionId: 'session-4', isSeeder: false });

  swarm._onCtrl(other, { t: 'bitfield', s: SLOT, full: true });
  assert.equal(other.remote.get(SLOT).have.length, 5);
});
