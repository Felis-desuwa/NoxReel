'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const CHUNK = 2 * MB;
const DATACHANNEL_LIMIT = 64 * 1024;

const SWARMS = {
  桌面端: '../src/renderer/lib/swarm.js',
  安卓端: '../android/app/src/main/assets/js/swarm.js',
};

function manifestOf(size, fileId = 'c'.repeat(32)) {
  const chunkCount = Math.ceil(size / CHUNK);
  return {
    fileId,
    name: 'huge.mkv',
    size,
    chunkSize: CHUNK,
    chunkCount,
    hashes: Array.from({ length: chunkCount }, (_, i) => i.toString(16).padStart(64, '0')),
    roomRevision: 1,
  };
}

for (const [label, modulePath] of Object.entries(SWARMS)) {
  /**
   * 以前清单最多拆 32 段（约 37GB），上面还压着 5120 片（10GB）的上限。
   * 40GB 要拆成 35 段 —— 两道上限只要有一道没删干净，这里就收不到 manifest-offer。
   */
  test(`${label}：超过旧 32 段上限的清单也能完整重组`, async () => {
    const { Swarm } = await import(modulePath);
    const manifest = manifestOf(40 * GB);
    const sender = new Swarm({ peerId: 'host00', name: 'host' });
    const messages = [];
    sender._sendManifest({ send: (msg) => messages.push(msg) }, manifest);
    assert.ok(messages.length > 33, `应当拆成 35 段以上，实际 ${messages.length} 条`);
    assert.ok(messages.every((msg) => Buffer.byteLength(JSON.stringify(msg)) < DATACHANNEL_LIMIT));

    const receiver = new Swarm({ peerId: 'guest0', name: 'guest' });
    const peer = { peerId: 'host00', pendingManifest: null, authenticated: true };
    let offer = null;
    receiver.once('manifest-offer', (o) => (offer = o));
    for (const msg of messages) receiver._onCtrl(peer, msg);
    assert.ok(offer, '40GB 的清单应当被接受');
    assert.equal(offer.manifest.hashes.length, manifest.chunkCount);
    assert.equal(offer.manifest.hashes.at(-1), manifest.hashes.at(-1));
  });

  /**
   * 上限去掉之后，「分段数必须等于片数除以每段容量」就是挡住乱报 totalParts 的那道闸：
   * 不然对方报一个天文数字，接收方就会去 new 一个巨大的数组。
   */
  test(`${label}：分段数和片数对不上的清单开头直接忽略`, async () => {
    const { Swarm } = await import(modulePath);
    const receiver = new Swarm({ peerId: 'guest0', name: 'guest' });
    const peer = { peerId: 'host00', pendingManifest: null, authenticated: true };
    const meta = { ...manifestOf(40 * GB), hashes: undefined };
    receiver._onCtrl(peer, { t: 'manifest-start', meta, totalParts: 2 ** 31 });
    assert.equal(peer.pendingManifest, null);
    receiver._onCtrl(peer, { t: 'manifest-start', meta, totalParts: 3 });
    assert.equal(peer.pendingManifest, null);
  });

  /**
   * 位图原来整张一条发。每片 1 bit、base64 再胀 4/3，约 38 万片（约 750GB）就超过
   * DataChannel 单条 64KB 上限，而超限的 send() 会让整条通道断掉。
   * 这里用 50 万片（约 1TB），确认分段后每条都在上限以内，且接收方逐位还原无误。
   */
  test(`${label}：超大文件的分片位图分段发送并逐位还原`, async () => {
    const { Swarm } = await import(modulePath);
    const manifest = manifestOf(1000 * GB);
    const sender = new Swarm({ peerId: 'host00', name: 'host' });
    sender.have = new Uint8Array(manifest.chunkCount);
    // 造一个不规则的图案，边界附近尤其要有 1，防止「整段全 0」让错位的实现也蒙混过关
    for (let i = 0; i < sender.have.length; i++) sender.have[i] = (i * 2654435761) % 7 < 3 ? 1 : 0;
    sender.have[239_999] = 1;
    sender.have[240_000] = 1;
    sender.have[manifest.chunkCount - 1] = 1;

    const messages = [];
    sender._sendBitfield({ send: (msg) => messages.push(msg) });
    assert.ok(messages.length >= 2, '应当分段');
    for (const msg of messages) {
      assert.ok(Buffer.byteLength(JSON.stringify(msg)) < DATACHANNEL_LIMIT, '每段都要低于 64KB');
      assert.equal(typeof msg.offset, 'number');
    }

    const receiver = new Swarm({ peerId: 'guest0', name: 'guest' });
    const peer = { peerId: 'host00', authenticated: true, remoteManifest: manifest, remoteHave: null };
    for (const msg of messages) receiver._onCtrl(peer, msg);
    assert.equal(peer.remoteHave.length, manifest.chunkCount);
    assert.deepEqual(Buffer.from(peer.remoteHave), Buffer.from(sender.have));
  });

  test(`${label}：普通大小的位图还是整张一条发，不带 offset，老版本照常能收`, async () => {
    const { Swarm } = await import(modulePath);
    const sender = new Swarm({ peerId: 'host00', name: 'host' });
    sender.have = new Uint8Array(5120).fill(1);
    const messages = [];
    sender._sendBitfield({ send: (msg) => messages.push(msg) });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].offset, undefined);
  });

  test(`${label}：offset 不落在段边界或越界的位图分段直接忽略`, async () => {
    const { Swarm } = await import(modulePath);
    const manifest = manifestOf(1000 * GB);
    const receiver = new Swarm({ peerId: 'guest0', name: 'guest' });
    const peer = { peerId: 'host00', authenticated: true, remoteManifest: manifest, remoteHave: null };
    receiver._onCtrl(peer, { t: 'bitfield', bits: '/w==', offset: 12345 });
    assert.equal(peer.remoteHave, null);
    receiver._onCtrl(peer, { t: 'bitfield', bits: '/w==', offset: manifest.chunkCount + 240_000 });
    assert.equal(peer.remoteHave, null);
    receiver._onCtrl(peer, { t: 'bitfield', bits: '/w==', offset: -240_000 });
    assert.equal(peer.remoteHave, null);
  });
}

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
