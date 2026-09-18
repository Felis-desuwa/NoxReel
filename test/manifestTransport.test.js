'use strict';

/**
 * v2 的清单是「谁需要谁来要」：接收方按播放列表里的 fileId 发 MANIFEST_GET，
 * 手里有这部片的人才回清单（大清单分段），拿到后要校验形状、和列表条目对得上、
 * 以及 fileId 就是全部分片哈希的摘要。
 *
 * 这里不再直接戳 _sendManifest 的返回值，而是让两个真实 Swarm 实例对接：
 * 消息先过一遍 JSON（和数据通道上一样，两边不共享对象引用），按发送顺序异步投递。
 * 单测里同步投递会制造真实环境里不存在的重入，反而掩盖或伪造时序问题。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { IMPLS } = require('./helpers/impls');

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const CHUNK = 2 * MB;
const DATACHANNEL_LIMIT = 64 * 1024;
const SEND_REFUSE_BYTES = 60 * 1024; // 和 peer.js 的 MAX_CTRL_BYTES 一致：超过它 send() 拒发

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

/** fileId 的算法和主进程 buildManifest 一致：全部分片哈希拼起来做 SHA-256，取前 32 位。 */
function fileIdOf(hashes) {
  return crypto.createHash('sha256').update(hashes.join('')).digest('hex').slice(0, 32);
}

/** 一份内容自洽的清单。salt 不同，哈希就不同，fileId 也就不同。 */
function manifestOf(size, { salt = 'a', name = 'film.mkv', durationSec } = {}) {
  const chunkCount = Math.ceil(size / CHUNK);
  const hashes = Array.from({ length: chunkCount }, (_, i) =>
    crypto.createHash('sha256').update(`${salt}:${i}`).digest('hex')
  );
  const manifest = { fileId: fileIdOf(hashes), name, size, chunkSize: CHUNK, chunkCount, hashes };
  if (durationSec !== undefined) manifest.durationSec = durationSec;
  return manifest;
}

/**
 * 假的 Peer：只实现 Swarm 用得到的那几样。send() 记下线上字节数，
 * 超过 60KB 像真 Peer 一样拒发；否则序列化后排队交给对面那一端的 'ctrl' 监听器。
 */
function fakePeer(peerId, name, protocolVersion) {
  const handlers = new Map();
  const peer = {
    peerId,
    name,
    authenticated: false,
    remote: new Map(),
    inflight: new Set(),
    pc: { iceConnectionState: 'connected' },
    ctrl: { readyState: 'open', bufferedAmount: 0 },
    downRate: 0,
    upRate: 0,
    rtt: null,
    closed: false,
    muted: false, // true 时消息照记但不投递，模拟「对方收到了却一直不回」
    wire: [], // [{msg, bytes}]：这一端发出去的全部控制消息
    other: null,
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
      return () => handlers.get(event).delete(fn);
    },
    fire(event, payload) {
      for (const fn of [...(handlers.get(event) || [])]) fn(payload);
    },
    send(msg) {
      if (peer.closed) return false;
      const text = JSON.stringify(msg);
      const bytes = Buffer.byteLength(text);
      peer.wire.push({ msg, bytes });
      if (bytes > SEND_REFUSE_BYTES) return false;
      if (!peer.muted) queueMicrotask(() => peer.other.fire('ctrl', JSON.parse(text)));
      return true;
    },
    hello(selfId, selfName, securityMode = 'safe', platform = 'desktop') {
      peer.send({ t: 'hello', peerId: selfId, name: selfName, ver: protocolVersion, securityMode, platform });
    },
    ping() {},
    close() {
      peer.closed = true;
    },
  };
  return peer;
}

/** 让 a、b 两个 Swarm 互相连上并走完 HELLO。返回双方手里对方的句柄。 */
async function connect(a, b, protocolVersion) {
  const aToB = fakePeer(b.peerId, b.name, protocolVersion);
  const bToA = fakePeer(a.peerId, a.name, protocolVersion);
  aToB.other = bToA;
  bToA.other = aToB;
  a.addPeer(aToB);
  b.addPeer(bToA);
  aToB.fire('open');
  bToA.fire('open');
  await flush();
  assert.equal(aToB.authenticated, true, '握手应当完成');
  assert.equal(bToA.authenticated, true, '握手应当完成');
  return { aToB, bToA };
}

/** 等排队中的消息投递完（微任务 + 一轮宏任务）。 */
async function flush() {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function load(dir) {
  const { Swarm } = await import(dir + 'swarm.js');
  const { PROTOCOL_VERSION } = await import(dir + 'protocol.js');
  return { Swarm, PROTOCOL_VERSION };
}

const typesOf = (peer) => peer.wire.map((w) => w.msg.t);

/**
 * 10GB = 5120 片，一条 JSON 装不下全部哈希（约 34 万字符）。
 * 必须拆成 START + 若干 PART，每条都要低于 DataChannel 单条 64KB 的上限，
 * 否则 send() 会让整条通道断掉，表现成莫名掉线。
 */
impl('10GB 清单按需索取：每条控制消息低于 64KB，接收方完整重组并通过摘要校验', async (dir) => {
  const { Swarm, PROTOCOL_VERSION } = await load(dir);
  const manifest = manifestOf(10 * GB, { name: 'ten-gigabyte.mkv' });
  assert.equal(manifest.chunkCount, 5120);

  const host = new Swarm({ peerId: 'host00', name: 'host' });
  const guest = new Swarm({ peerId: 'guest0', name: 'guest' });
  host.addFile({ slot: 1, manifest, sessionId: 'host-session', isSeeder: true });
  const { aToB: toGuest, bToA: toHost } = await connect(host, guest, PROTOCOL_VERSION);

  // 清单不再随握手推送：握手阶段房主只报「我是谁」和「我有哪些片」。
  assert.deepEqual(typesOf(toGuest), ['hello', 'bitfield']);

  const got = await guest.requestManifest(manifest.fileId, {
    candidates: ['host00'],
    expect: { size: manifest.size, chunkCount: manifest.chunkCount },
  });

  assert.deepEqual(typesOf(toHost), ['hello', 'manifest-get']);
  const served = typesOf(toGuest).slice(2);
  assert.deepEqual(served, ['manifest-start', ...Array(9).fill('manifest-part')], '5120 片按每段 600 应拆成 9 段');
  for (const { msg, bytes } of [...toGuest.wire, ...toHost.wire]) {
    assert.ok(bytes < DATACHANNEL_LIMIT, `${msg.t} 有 ${bytes} 字节，超过了 64KB`);
  }

  assert.equal(got.fileId, manifest.fileId);
  assert.equal(got.name, 'ten-gigabyte.mkv');
  assert.equal(got.size, manifest.size);
  assert.equal(got.chunkCount, 5120);
  assert.deepEqual(got.hashes, manifest.hashes, '分段必须按下标拼回，顺序错一段整部片都校验不过');
  assert.equal(guest._manifestWaiters.size, 0, '拿到清单后请求记录要清掉');

  host.destroy();
  guest.destroy();
});

/**
 * 时长是接收方起播前算所需码率的依据。v2 里它以播放列表条目为准：
 * 列表是房主校验过、全场一致的，而清单来自任意一个供片人。
 */
impl('时长以播放列表条目（expect.durationSec）为准，没给时保留清单里的值', async (dir) => {
  const { Swarm, PROTOCOL_VERSION } = await load(dir);
  const listed = manifestOf(4 * GB, { salt: 'listed', durationSec: 8523.209 });
  const plain = manifestOf(4 * GB, { salt: 'plain', durationSec: 7200.5 });
  assert.ok(listed.chunkCount > 600, '要走分段路径，确认 meta 上的字段拆分重组后还在');

  const host = new Swarm({ peerId: 'host00', name: 'host' });
  const guest = new Swarm({ peerId: 'guest0', name: 'guest' });
  host.addFile({ slot: 1, manifest: listed, sessionId: 'host-1', isSeeder: true });
  host.addFile({ slot: 2, manifest: plain, sessionId: 'host-2', isSeeder: true });
  await connect(host, guest, PROTOCOL_VERSION);

  const overridden = await guest.requestManifest(listed.fileId, {
    candidates: ['host00'],
    expect: { size: listed.size, chunkCount: listed.chunkCount, durationSec: 8520 },
  });
  assert.equal(overridden.durationSec, 8520, '列表条目的时长应当覆盖清单里的值');

  const kept = await guest.requestManifest(plain.fileId, {
    candidates: ['host00'],
    expect: { size: plain.size, chunkCount: plain.chunkCount, durationSec: 0 },
  });
  assert.equal(kept.durationSec, 7200.5, '列表没有时长（0）时不能把清单里的值抹掉');

  host.destroy();
  guest.destroy();
});

/**
 * 摘要校验是「清单被改过」的唯一防线：拿别人的 fileId 配上自己的哈希，
 * 缓存和进度就会记到别的片子头上。校验不过要换下一个人，而不是整个失败。
 */
impl('摘要对不上的清单拒收，并换下一个候选人去要', async (dir) => {
  const { Swarm, PROTOCOL_VERSION } = await load(dir);
  const honest = manifestOf(3 * GB, { salt: 'honest' });
  const forged = { ...honest, hashes: honest.hashes.map((h, i) => (i === 1000 ? 'f'.repeat(64) : h)) };

  const evil = new Swarm({ peerId: 'evil00', name: 'evil' });
  const good = new Swarm({ peerId: 'good00', name: 'good' });
  const guest = new Swarm({ peerId: 'guest0', name: 'guest' });
  evil.addFile({ slot: 1, manifest: forged, sessionId: 'evil-1', isSeeder: true });
  good.addFile({ slot: 1, manifest: honest, sessionId: 'good-1', isSeeder: true });
  const { bToA: guestToEvil } = await connect(evil, guest, PROTOCOL_VERSION);
  const { bToA: guestToGood } = await connect(good, guest, PROTOCOL_VERSION);

  const bad = [];
  guest.on('manifest-bad', (e) => bad.push(e));
  const got = await guest.requestManifest(honest.fileId, {
    candidates: ['evil00', 'good00'],
    expect: { size: honest.size, chunkCount: honest.chunkCount },
  });

  assert.deepEqual(bad, [{ fileId: honest.fileId, from: 'evil00' }]);
  assert.ok(typesOf(guestToEvil).includes('manifest-get'));
  assert.ok(typesOf(guestToGood).includes('manifest-get'), '先问的人给了假清单，应当接着问下一个');
  assert.deepEqual(got.hashes, honest.hashes);

  for (const s of [evil, good, guest]) s.destroy();
});

/** 播放列表条目说这部片多大、几片，清单就必须是这个数 —— 摘要自洽也不行。 */
impl('大小和播放列表条目对不上的清单拒收；候选人用完就报错', async (dir) => {
  const { Swarm, PROTOCOL_VERSION } = await load(dir);
  const manifest = manifestOf(64 * MB, { salt: 'small' });

  const host = new Swarm({ peerId: 'host00', name: 'host' });
  const guest = new Swarm({ peerId: 'guest0', name: 'guest' });
  host.addFile({ slot: 1, manifest, sessionId: 'host-1', isSeeder: true });
  await connect(host, guest, PROTOCOL_VERSION);

  const bad = [];
  guest.on('manifest-bad', (e) => bad.push(e));
  await assert.rejects(
    guest.requestManifest(manifest.fileId, {
      candidates: ['host00'],
      expect: { size: manifest.size + 1, chunkCount: manifest.chunkCount },
    }),
    /没有人能提供这部片的清单/
  );
  assert.deepEqual(bad, [{ fileId: manifest.fileId, from: 'host00' }]);
  assert.equal(guest._manifestWaiters.size, 0);

  host.destroy();
  guest.destroy();
});

impl('谁都没有这份清单时按顺序问完每个人再报错', async (dir) => {
  const { Swarm, PROTOCOL_VERSION } = await load(dir);
  const a = new Swarm({ peerId: 'peer-a', name: 'a' });
  const b = new Swarm({ peerId: 'peer-b', name: 'b' });
  const guest = new Swarm({ peerId: 'guest0', name: 'guest' });
  const { aToB: aToGuest, bToA: guestToA } = await connect(a, guest, PROTOCOL_VERSION);
  const { aToB: bToGuest, bToA: guestToB } = await connect(b, guest, PROTOCOL_VERSION);

  const fileId = manifestOf(8 * MB, { salt: 'nobody' }).fileId;
  await assert.rejects(
    guest.requestManifest(fileId, { candidates: ['peer-a', 'not-connected', 'peer-b'] }),
    /没有人能提供这部片的清单/
  );
  assert.deepEqual(guestToA.wire.at(-1).msg, { t: 'manifest-get', fileId });
  assert.deepEqual(guestToB.wire.at(-1).msg, { t: 'manifest-get', fileId });
  assert.deepEqual(aToGuest.wire.at(-1).msg, { t: 'manifest', fileId, missing: true });
  assert.deepEqual(bToGuest.wire.at(-1).msg, { t: 'manifest', fileId, missing: true });

  for (const s of [a, b, guest]) s.destroy();
});

/**
 * 只收「我正在向这个人要」的清单。否则任何成员都能往别人那里塞一份清单，
 * 或者在我向房主要的时候抢答一份假的。
 */
impl('不请自来的清单、以及不是向他要的人抢答的清单一律丢弃', async (dir) => {
  const { Swarm, PROTOCOL_VERSION } = await load(dir);
  const big = manifestOf(3 * GB, { salt: 'big' });
  const small = manifestOf(10 * MB, { salt: 'small' });

  const host = new Swarm({ peerId: 'host00', name: 'host' });
  const other = new Swarm({ peerId: 'other0', name: 'other' });
  const guest = new Swarm({ peerId: 'guest0', name: 'guest' });
  const { aToB: hostToGuest, bToA: guestToHost } = await connect(host, guest, PROTOCOL_VERSION);
  const { aToB: otherToGuest } = await connect(other, guest, PROTOCOL_VERSION);

  // 没人问就推过来：分段的和整条的都不认
  await host._sendManifest(hostToGuest, big);
  await host._sendManifest(hostToGuest, small);
  await flush();
  assert.equal(guest._peerState.get('host00')?.manifestParts.size ?? 0, 0, '不请自来的分段不该占着拼装位');

  // 向房主要，但房主那边迟迟不回；另一个人抢着塞一份（内容还是真的）也不收
  guestToHost.muted = true;
  const pending = guest.requestManifest(small.fileId, { candidates: ['host00'] });
  let settled = false;
  pending.then(
    () => (settled = true),
    () => (settled = true)
  );
  await other._sendManifest(otherToGuest, small);
  await flush();
  assert.equal(settled, false, '不是向他要的，给了也不能算数');
  assert.equal(guest._manifestWaiters.get(small.fileId)?.current, 'host00');

  // 房主终于回了，这才算数
  guestToHost.muted = false;
  await host._sendManifest(hostToGuest, small);
  const got = await pending;
  assert.deepEqual(got.hashes, small.hashes);

  for (const s of [host, other, guest]) s.destroy();
});

/**
 * 几百 KB 的清单一口气塞进 ctrl，紧跟着的「全员暂停」就得排在后面。
 * 所以分段之间要等 ctrl 缓冲回落，缓冲一直满着就一段都不该再发。
 */
impl('ctrl 缓冲积压时清单分段暂停发送，回落后再接着发完', async (dir) => {
  const { Swarm, PROTOCOL_VERSION } = await load(dir);
  const manifest = manifestOf(4 * GB, { salt: 'drain' });

  const host = new Swarm({ peerId: 'host00', name: 'host' });
  const guest = new Swarm({ peerId: 'guest0', name: 'guest' });
  host.addFile({ slot: 1, manifest, sessionId: 'host-1', isSeeder: true });
  const { aToB: toGuest } = await connect(host, guest, PROTOCOL_VERSION);

  toGuest.ctrl.bufferedAmount = 4 * MB;
  const pending = guest.requestManifest(manifest.fileId, { candidates: ['host00'] });
  await new Promise((resolve) => setTimeout(resolve, 120));
  const partsWhileFull = typesOf(toGuest).filter((t) => t === 'manifest-part').length;
  assert.ok(typesOf(toGuest).includes('manifest-start'));
  assert.equal(partsWhileFull, 0, '缓冲满着的时候不该继续往里塞分段');

  toGuest.ctrl.bufferedAmount = 0;
  const got = await pending;
  assert.deepEqual(got.hashes, manifest.hashes);

  host.destroy();
  guest.destroy();
});

test('调度器起播前用清单里的时长算所需码率，起播后让 mpv 的真值覆盖', async () => {
  const { Scheduler } = await import('../src/renderer/lib/scheduler.js');

  const manifest = { size: 2_400_000_000, chunkSize: 2 * 1024 ** 2, chunkCount: 1145, durationSec: 8523.209 };
  const scheduler = new Scheduler({ manifest });
  // 2.4GB / 8523s ≈ 281 KB/s —— 接收方还没起播就能拿到这个数
  assert.ok(Math.abs(scheduler.bytesPerSecond - 2_400_000_000 / 8523.209) < 1);

  scheduler.setDuration(8000);
  assert.ok(Math.abs(scheduler.bytesPerSecond - 2_400_000_000 / 8000) < 1, 'mpv 报上来的真时长应当覆盖清单值');

  // 老版本房主不带时长，退化成 0，界面据此不显示这条诊断而不是显示一个假数字
  assert.equal(new Scheduler({ manifest: { ...manifest, durationSec: undefined } }).bytesPerSecond, 0);
});

test('清单校验放行合法时长，挡住畸形值', () => {
  const validate = require('../src/main/security');
  // 主进程现在要求 fileId 就是分片哈希的摘要，所以这里的 fileId 得真算出来
  const hashes = ['b'.repeat(64)];
  const base = {
    fileId: fileIdOf(hashes),
    name: 'film.mkv',
    size: 2 * 1024 ** 2,
    chunkSize: 2 * 1024 ** 2,
    chunkCount: 1,
    hashes,
  };
  assert.equal(validate.manifest({ ...base }).durationSec, undefined);
  assert.equal(validate.manifest({ ...base, durationSec: 8523.209 }).durationSec, 8523.209);
  for (const bad of [-1, '8523', NaN, Infinity, 86_401, null]) {
    assert.throws(() => validate.manifest({ ...base, durationSec: bad }), `应当拒绝 ${String(bad)}`);
  }
});
