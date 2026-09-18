'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { IMPLS } = require('./helpers/impls');

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const CHUNK = 2 * MB;
const DATACHANNEL_LIMIT = 64 * 1024;
const SEND_REFUSE_BYTES = 60 * 1024; // 和 peer.js 的 MAX_CTRL_BYTES 一致：超过它 send() 拒发
const BITFIELD_PART = 240_000; // protocol.js 的 BITFIELD_CHUNKS_PER_PART

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

/**
 * 内容自洽的清单：fileId 按主进程的算法由分片哈希推导。
 * 哈希用便宜的十六进制序号（格式合法即可），salt 不同则 fileId 不同。
 * 50 万片的清单造一次要几十 MB，按参数缓存，两份实现共用。
 */
const manifestCache = new Map();
function manifestOf(size, salt = 0) {
  const key = `${size}:${salt}`;
  if (manifestCache.has(key)) return manifestCache.get(key);
  const chunkCount = Math.ceil(size / CHUNK);
  const base = salt * 2 ** 40;
  const hashes = Array.from({ length: chunkCount }, (_, i) => (base + i).toString(16).padStart(64, '0'));
  const fileId = crypto.createHash('sha256').update(hashes.join('')).digest('hex').slice(0, 32);
  const manifest = { fileId, name: 'huge.mkv', size, chunkSize: CHUNK, chunkCount, hashes };
  manifestCache.set(key, manifest);
  return manifest;
}

const catalogEntry = (slot, m) => ({ slot, fileId: m.fileId, size: m.size, chunkCount: m.chunkCount, chunkSize: m.chunkSize });

/** 不规则的位图图案，段边界两侧尤其要有 1，防止「整段全 0」让错位的实现也蒙混过关。 */
function patternOf(count) {
  const have = new Uint8Array(count);
  for (let i = 0; i < count; i++) have[i] = (i * 2654435761) % 7 < 3 ? 1 : 0;
  for (const i of [0, BITFIELD_PART - 1, BITFIELD_PART, 2 * BITFIELD_PART - 1, 2 * BITFIELD_PART, count - 1]) {
    if (i >= 0 && i < count) have[i] = 1;
  }
  return have;
}

/** 假的 Peer：send() 记下线上字节数、超 60KB 拒发，否则过一遍 JSON 后按顺序异步交给对面。 */
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
    wire: [],
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

async function flush() {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** 两个 Swarm 互连并走完 HELLO。toGuest 是 host 手里的句柄，toHost 是 guest 手里的。 */
async function connect(host, guest, protocolVersion) {
  const toGuest = fakePeer(guest.peerId, guest.name, protocolVersion);
  const toHost = fakePeer(host.peerId, host.name, protocolVersion);
  toGuest.other = toHost;
  toHost.other = toGuest;
  host.addPeer(toGuest);
  guest.addPeer(toHost);
  toGuest.fire('open');
  toHost.fire('open');
  await flush();
  assert.ok(toGuest.authenticated && toHost.authenticated, '握手应当完成');
  return { toGuest, toHost };
}

async function setup(dir) {
  const { Swarm } = await import(dir + 'swarm.js');
  const { PROTOCOL_VERSION, packBitfield } = await import(dir + 'protocol.js');
  const host = new Swarm({ peerId: 'host00', name: 'host' });
  const guest = new Swarm({ peerId: 'guest0', name: 'guest' });
  const done = () => {
    host.destroy();
    guest.destroy();
  };
  return { host, guest, packBitfield, connect: () => connect(host, guest, PROTOCOL_VERSION), done };
}

const bitfieldsOn = (peer) => peer.wire.filter((w) => w.msg.t === 'bitfield');

/**
 * 以前清单最多拆 32 段（约 37GB），上面还压着 5120 片（10GB）的上限。
 * 40GB 要拆成 35 段 —— 两道上限只要有一道没删干净，这里就拿不到清单。
 */
impl('超过旧 32 段上限的清单也能完整重组', async (dir) => {
  const { host, guest, connect, done } = await setup(dir);
  const manifest = manifestOf(40 * GB);
  host.addFile({ slot: 1, manifest, sessionId: 'host-1', isSeeder: true });
  const { toGuest } = await connect();

  const got = await guest.requestManifest(manifest.fileId, {
    candidates: ['host00'],
    expect: { size: manifest.size, chunkCount: manifest.chunkCount },
  });

  const types = toGuest.wire.map((w) => w.msg.t);
  assert.equal(types.filter((t) => t === 'manifest-start').length, 1);
  assert.equal(types.filter((t) => t === 'manifest-part').length, 35, '20480 片按每段 600 应拆成 35 段');
  assert.ok(toGuest.wire.every((w) => w.bytes < DATACHANNEL_LIMIT), '每条都要低于 64KB');
  assert.equal(got.hashes.length, manifest.chunkCount);
  assert.deepEqual(got.hashes, manifest.hashes);
  done();
});

/**
 * 上限去掉之后，「分段数必须等于片数除以每段容量」就是挡住乱报 totalParts 的那道闸：
 * 不然对方报一个天文数字，接收方就会去 new 一个巨大的数组。
 */
impl('分段数和片数对不上的清单开头直接忽略，并当作这个人给不出清单', async (dir) => {
  const { guest, connect, done } = await setup(dir);
  const { hashes, ...meta } = manifestOf(40 * GB);
  assert.equal(hashes.length, 20480);
  const { toHost } = await connect();
  // 请求照发，但房主那边不回：分段开头由测试直接塞给接收方
  toHost.muted = true;
  const parts = () => guest._peerState.get('host00')?.manifestParts;

  for (const totalParts of [2 ** 31, 3]) {
    const pending = guest.requestManifest(meta.fileId, { candidates: ['host00'] });
    guest._onCtrl(toHost, { t: 'manifest-start', meta, totalParts });
    await assert.rejects(pending, /没有人能提供这部片的清单/, `totalParts=${totalParts} 应当被拒`);
    assert.equal(parts()?.has(meta.fileId) ?? false, false, `totalParts=${totalParts} 不该开出拼装位`);
  }

  // 对照：分段数对得上的开头会被接住，说明上面是被那道闸拦下的
  const pending = guest.requestManifest(meta.fileId, { candidates: ['host00'] });
  pending.catch(() => {});
  guest._onCtrl(toHost, { t: 'manifest-start', meta, totalParts: 35 });
  assert.equal(parts().get(meta.fileId).parts.length, 35);
  done();
});

/**
 * 位图原来整张一条发。每片 1 bit、base64 再胀 4/3，约 38 万片（约 750GB）就超过
 * DataChannel 单条 64KB 上限，而超限的 send() 会让整条通道断掉。
 * 这里用 51.2 万片（约 1TB），确认挂上文件时分段发出、每条都在上限以内，且接收方逐位还原无误。
 */
impl('超大文件的分片位图分段发送并逐位还原', async (dir) => {
  const { host, guest, packBitfield, connect, done } = await setup(dir);
  const manifest = manifestOf(1000 * GB);
  const have = patternOf(manifest.chunkCount);
  const { toGuest, toHost } = await connect();
  // 解对方位图要知道片数，片数来自播放列表
  guest.setCatalog([catalogEntry(3, manifest)]);

  host.addFile({
    slot: 3,
    manifest,
    sessionId: 'host-3',
    isSeeder: false,
    state: { bitfield: packBitfield(have), haveCount: have.reduce((a, b) => a + b, 0), contiguousBytes: CHUNK, complete: false },
  });
  await flush();

  const sent = bitfieldsOn(toGuest);
  assert.deepEqual(
    sent.map((w) => w.msg.offset),
    [0, BITFIELD_PART, 2 * BITFIELD_PART],
    '51.2 万片应当按 24 万一段分成三段，每段带 offset'
  );
  for (const { msg, bytes } of sent) {
    assert.equal(msg.s, 3);
    assert.equal(msg.full, undefined);
    assert.ok(bytes < DATACHANNEL_LIMIT, `offset=${msg.offset} 这段有 ${bytes} 字节，超过了 64KB`);
  }

  const remote = toHost.remote.get(3);
  assert.ok(remote, '接收方应当记下房主这个槽位的位图');
  assert.equal(remote.full, false);
  assert.equal(remote.have.length, manifest.chunkCount);
  assert.ok(Buffer.from(remote.have).equals(Buffer.from(have)), '分段位图必须逐位还原');
  assert.deepEqual(guest.sourcesFor(3), ['host00']);
  done();
});

/**
 * 接收方的真实顺序常常是「对方的位图先到，播放列表后到」：握手时对方就把手里所有槽位的位图发过来了。
 * 这时片数未知解不了，得先暂存，列表一到按原顺序补放 —— 分段位图的第一段会新建整张表，顺序乱了就错。
 */
impl('槽位还没进播放列表时，握手送来的分段位图先暂存，列表到了再逐位还原', async (dir) => {
  const { host, guest, packBitfield, connect, done } = await setup(dir);
  const manifest = manifestOf(1000 * GB);
  const have = patternOf(manifest.chunkCount);
  host.addFile({
    slot: 5,
    manifest,
    sessionId: 'host-5',
    isSeeder: false,
    state: { bitfield: packBitfield(have), haveCount: 1, contiguousBytes: CHUNK, complete: false },
  });

  const { toGuest, toHost } = await connect();
  assert.equal(bitfieldsOn(toGuest).length, 3, '握手时就应当把已有槽位的位图分段发过来');
  assert.equal(toHost.remote.has(5), false, '片数未知时不能瞎解');

  guest.setCatalog([catalogEntry(5, manifest)]);
  const remote = toHost.remote.get(5);
  assert.ok(remote, '列表到了之后暂存的位图应当补放');
  assert.ok(Buffer.from(remote.have).equals(Buffer.from(have)));
  done();
});

impl('普通大小的位图整张一条发、不带 offset；收完的片只报一句「全有」', async (dir) => {
  const { host, guest, packBitfield, connect, done } = await setup(dir);
  const partial = manifestOf(10 * GB, 1);
  const whole = manifestOf(10 * GB, 2);
  const have = patternOf(partial.chunkCount);
  const { toGuest, toHost } = await connect();
  guest.setCatalog([catalogEntry(1, partial), catalogEntry(2, whole)]);

  host.addFile({
    slot: 1,
    manifest: partial,
    sessionId: 'host-1',
    isSeeder: false,
    state: { bitfield: packBitfield(have), haveCount: 1, contiguousBytes: CHUNK, complete: false },
  });
  host.addFile({ slot: 2, manifest: whole, sessionId: 'host-2', isSeeder: true });
  await flush();

  const sent = bitfieldsOn(toGuest).map((w) => w.msg);
  assert.equal(sent.length, 2, '每个槽位各一条');
  assert.equal(sent[0].s, 1);
  assert.equal(typeof sent[0].bits, 'string');
  assert.equal('offset' in sent[0], false, '没超过一段的量就不该分段');
  assert.deepEqual(sent[1], { t: 'bitfield', s: 2, full: true });

  assert.ok(Buffer.from(toHost.remote.get(1).have).equals(Buffer.from(have)));
  assert.equal(toHost.remote.get(1).full, false);
  const full = toHost.remote.get(2);
  assert.equal(full.full, true);
  assert.equal(full.have.length, whole.chunkCount);
  assert.ok(full.have.every((b) => b === 1));
  assert.equal(guest.canFinish(2), true);
  done();
});

impl('offset 不落在段边界或越界的位图分段直接忽略', async (dir) => {
  const { guest, connect, done } = await setup(dir);
  const manifest = manifestOf(1000 * GB);
  const { toHost } = await connect();
  guest.setCatalog([catalogEntry(3, manifest)]);

  for (const offset of [12345, manifest.chunkCount + BITFIELD_PART, -BITFIELD_PART, 1.5, '240000x']) {
    guest._onCtrl(toHost, { t: 'bitfield', s: 3, bits: '/w==', offset });
    assert.equal(toHost.remote.has(3), false, `offset=${offset} 应当被忽略`);
  }

  // 对照：落在段边界上的分段照收
  guest._onCtrl(toHost, { t: 'bitfield', s: 3, bits: '/w==', offset: BITFIELD_PART });
  const remote = toHost.remote.get(3);
  assert.ok(remote);
  assert.deepEqual([...remote.have.subarray(BITFIELD_PART, BITFIELD_PART + 9)], [1, 1, 1, 1, 1, 1, 1, 1, 0]);
  done();
});

test('主进程不再按大小拒绝文件', () => {
  const media = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'media.js'), 'utf8');
  const store = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'fileStore.js'), 'utf8');
  assert.doesNotMatch(media, /10GB 上限|10 \* 1024 \*\* 3/);
  assert.doesNotMatch(store, /MAX_FILE_SIZE|10GB 上限（当前/);
});

/**
 * 以前有 10GB 上限兜着，磁盘被一部片子塞满很少见；上限去掉以后这是常态风险。
 * 放不下时要在开会话之前就说清楚，而不是在 NTFS 上抛一个 ENOSPC、或者在 ext4 上传到一半才写不进去。
 */
test('接收前检查磁盘余量：放不下时给出人话，放得下时不拦', async () => {
  const { ensureFreeSpace } = require('../src/main/fileStore.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noxreel-space-'));
  try {
    await assert.doesNotReject(ensureFreeSpace(dir, MB));
    await assert.rejects(ensureFreeSpace(dir, Number.MAX_SAFE_INTEGER), (error) => {
      assert.match(error.message, /^磁盘空间不够：这部片子需要 [\d.]+GB，缓存所在的磁盘只剩 [\d.]+GB$/);
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('磁盘余量查不到时不拦，让真正的写入错误说话', async () => {
  const { ensureFreeSpace } = require('../src/main/fileStore.js');
  await assert.doesNotReject(ensureFreeSpace(path.join(os.tmpdir(), 'noxreel-does-not-exist', 'x'), 10 * GB));
});

test('安卓端开接收会话失败时把原因带回 JS，而不是一句 openLeech 失败', () => {
  const root = path.join(__dirname, '..', 'android', 'app', 'src', 'main');
  const bridge = fs.readFileSync(path.join(root, 'java', 'com', 'syncwatch', 'app', 'NativeBridge.kt'), 'utf8');
  const shim = fs.readFileSync(path.join(root, 'assets', 'js', 'native-shim.js'), 'utf8');
  const store = fs.readFileSync(path.join(root, 'java', 'com', 'syncwatch', 'app', 'Store.kt'), 'utf8');
  assert.match(bridge, /"!" \+ \(e\.message \?: "openLeech 失败"\)/);
  assert.match(shim, /id\.startsWith\('!'\)/);
  assert.match(store, /usableSpace/);
  assert.match(store, /磁盘空间不够：这部片子需要 %\.2fGB，手机只剩 %\.2fGB/);
});
