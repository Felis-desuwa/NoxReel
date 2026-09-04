'use strict';

/**
 * 「分片正在落盘时不能被重复请求」。
 *
 * 这是一个窗口极窄、但代价极大的竞态：_commitChunk 先把分片从 inflight 摘掉，
 * 再 await 一整个写盘往返（2MB 过 IPC + SHA-256 + 落盘）。这中间它既不在 inflight、
 * have 也还是 0，调度器只能判定它还缺，于是再要一遍。
 *
 * 而 v0.6.5 起「一片落地就立刻补片」，等于把这个窗口撞得更频繁。实测一个
 * 25.9 MB 的文件，发送端总共发出 59.8 MB —— 多出来的那份最后被 fileStore
 * 认出是重复丢掉了，带宽却已经花掉。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CHUNK = 2 * 1024 * 1024;
const CHUNKS = 8;

const manifest = {
  fileId: 'f'.repeat(32),
  name: 'a.mkv',
  size: CHUNKS * CHUNK,
  chunkSize: CHUNK,
  chunkCount: CHUNKS,
  hashes: Array.from({ length: CHUNKS }, (_, i) => String(i).padStart(64, '0')),
  durationSec: 600,
};

/**
 * 装一个可控的 window.sw：writeChunk 挂着不返回，模拟「正在落盘」。
 * @returns {{release:(i:number)=>void, requested:number[], swarm:any}}
 */
async function makeSwarm(modulePath) {
  const pending = new Map();
  const requested = [];

  globalThis.performance = globalThis.performance || { now: () => Date.now() };
  globalThis.window = {
    sw: {
      store: {
        writeChunk: (sessionId, index) =>
          new Promise((resolve) => {
            pending.set(index, () =>
              resolve({ ok: true, duplicate: false, haveCount: 1, contiguousBytes: CHUNK, complete: false })
            );
          }),
      },
    },
  };

  const { Swarm } = await import(modulePath);
  const swarm = new Swarm({ peerId: 'me', name: 'me' });
  swarm.setSession({ manifest, sessionId: 's1', isSeeder: false });

  // 一个总是有货、总是接单的对端
  const peer = {
    peerId: 'up',
    name: 'up',
    ready: true,
    authenticated: true,
    remoteHave: new Uint8Array(CHUNKS).fill(1),
    inflight: new Set(),
    downRate: 10e6,
    rtt: 10,
    ctrl: { readyState: 'open' },
    send: (msg) => {
      if (msg.t === 'request') requested.push(msg.index);
    },
  };
  swarm.peers.set('up', peer);

  return { swarm, peer, requested, release: (i) => pending.get(i)?.() };
}

for (const [label, modulePath] of [
  ['桌面端', '../src/renderer/lib/swarm.js'],
  ['安卓端', '../android/app/src/main/assets/js/swarm.js'],
]) {
  test(`${label}：正在落盘的分片不会被再要一遍`, async () => {
    const { swarm, peer, requested, release } = await makeSwarm(modulePath);

    swarm._tick();
    const first = requested.slice();
    assert.ok(first.length > 0, '第一轮应该派出请求');
    const target = first[0];

    // 这一片收齐了，_commitChunk 会把它从 inflight 摘掉，然后卡在写盘上
    const commit = swarm._commitChunk(peer, target, new Uint8Array(CHUNK));
    await new Promise((r) => setImmediate(r));

    // 写盘还没回来。这时候再调度一轮 —— 老代码会在这里把同一片再要一次。
    requested.length = 0;
    swarm._tick();
    assert.ok(
      !requested.includes(target),
      `分片 ${target} 还在落盘就被重复请求了（这一轮要了 ${requested.join(',')}）`
    );

    release(target);
    await commit;
  });

  test(`${label}：落盘完成后这片进 have，也不会再被要`, async () => {
    const { swarm, peer, requested, release } = await makeSwarm(modulePath);
    swarm._tick();
    const target = requested[0];

    const commit = swarm._commitChunk(peer, target, new Uint8Array(CHUNK));
    await new Promise((r) => setImmediate(r));
    release(target);
    await commit;

    assert.equal(swarm.have[target], 1);
    requested.length = 0;
    swarm._tick();
    assert.ok(!requested.includes(target));
  });

  test(`${label}：落盘期间其余分片照常调度，不是把整轮堵住`, async () => {
    const { swarm, peer, requested, release } = await makeSwarm(modulePath);
    swarm._tick();
    const target = requested[0];

    const commit = swarm._commitChunk(peer, target, new Uint8Array(CHUNK));
    await new Promise((r) => setImmediate(r));

    requested.length = 0;
    swarm._tick();
    assert.ok(requested.length > 0, '腾出来的名额应该拿去要别的片，而不是空转');
    assert.ok(requested.every((i) => i !== target));

    release(target);
    await commit;
  });

  test(`${label}：写盘失败的片会被放回去重新要`, async () => {
    const { swarm, peer, requested } = await makeSwarm(modulePath);
    swarm._tick();
    const target = requested[0];
    const firstRound = requested.length;

    // 让这次写盘直接抛错
    window.sw.store.writeChunk = () => Promise.reject(new Error('磁盘满了'));
    swarm.on('error', () => {});
    await swarm._commitChunk(peer, target, new Uint8Array(CHUNK));
    // _commitChunk 的 finally 里本来就会补一轮，重新排队应该在那一轮就发生了
    swarm._tick();

    assert.ok(
      requested.slice(firstRound).includes(target),
      `落盘失败的片必须能重新排队，否则永远缺一块（后续要了 ${requested.slice(firstRound).join(',')}）`
    );
  });
}

test('换会话时把「正在落盘」的记录一并清掉', async () => {
  const { swarm, peer, release } = await makeSwarm('../src/renderer/lib/swarm.js');
  swarm._tick();
  const commit = swarm._commitChunk(peer, 0, new Uint8Array(CHUNK));
  await new Promise((r) => setImmediate(r));
  assert.equal(swarm._writing.size, 1);

  swarm.clearSession({ notify: false });
  assert.equal(swarm._writing.size, 0, '残留会让新会话里同下标的分片永远不被请求');

  release(0);
  await commit;
});

// 两份 swarm.js 本来就不是逐字节一致（注释和少量实现有出入），所以只钉住这道守卫本身。
test('两端都有「正在落盘」这道守卫', () => {
  for (const f of ['../src/renderer/lib/swarm.js', '../android/app/src/main/assets/js/swarm.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.match(src, /this\._writing\.add\(index\)/, `${f} 少了入队`);
    assert.match(src, /this\._writing\.delete\(index\)/, `${f} 少了出队`);
    assert.match(
      src,
      /inflight: new Set\(\[\.\.\.this\.inflight\.keys\(\), \.\.\.this\._writing\]\)/,
      `${f} 的调度没把正在落盘的片算进去`
    );
  }
});
