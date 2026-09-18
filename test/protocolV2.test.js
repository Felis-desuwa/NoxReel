'use strict';

// v2 线缆协议（protocol.js）：12 字节帧头（带文件槽位）、槽位取值范围、大消息分段（PART）。
// 这些是两端互通的地基——帧头错一个字节，分片就会写进另一部片；
// 分段有一段超过 64KB，整条 DataChannel 会被直接关掉。桌面端和安卓端各跑一遍。
const test = require('node:test');
const assert = require('node:assert/strict');
const { IMPLS } = require('./helpers/impls');

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

const load = (dir) => import(dir + 'protocol.js');

const MB = 1024 * 1024;
const SCTP_LIMIT = 64 * 1024;
const utf8Bytes = (s) => new TextEncoder().encode(s).length;
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const wire = (o) => JSON.parse(JSON.stringify(o));

/** 确定性的「随机」字节（xorshift32），不依赖 Math.random。 */
function bytesOf(len, seed = 0x9e3779b9) {
  const out = new Uint8Array(len);
  let x = seed | 0 || 1;
  for (let i = 0; i < len; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/** JSON 正好 n 字节（纯 ASCII）的 playlist 消息。 */
function asciiMessageOfBytes(n) {
  const head = '{"t":"playlist","x":"';
  const tail = '"}';
  const msg = { t: 'playlist', x: 'a'.repeat(n - head.length - tail.length) };
  assert.equal(utf8Bytes(JSON.stringify(msg)), n);
  return msg;
}

/** 一条要切成 3 段的消息，分段测试的基本素材。 */
const threePartMessage = () => ({ t: 'playlist', x: 'a'.repeat(100_000) });

/** 手工拼一段：data 是任意字符串的 UTF-8 → base64。 */
const rawPart = (id, text) => ({ t: 'part', id, i: 0, n: 1, data: b64(text) });

/**
 * 断言 bad 段被拒绝，而且没有留下任何副作用：
 * 并发上限设为 1 并挂着一条正在拼的合法消息——坏段只要被登记了，
 * 要么挤掉这条（换了 id），要么占住它的位置（同 id），最后都拼不回来。
 */
function assertRejectedCleanly(P, bad, label) {
  const asm = new P.PartAssembler({ maxConcurrent: 1 });
  const msg = threePartMessage();
  const parts = P.splitLarge(msg, 'keep').map(wire);
  assert.equal(parts.length, 3);
  assert.equal(asm.push(parts[0]), null);
  assert.equal(asm.push(bad), null, `${label}：本该返回 null`);
  assert.equal(asm.push(parts[1]), null);
  assert.deepEqual(asm.push(parts[2]), msg, `${label}：坏段留下了副作用，合法消息拼不回来`);
}

/* ------------------------------ 常量与消息类型 ------------------------------ */

impl('v2 的版本号、帧头长度和新消息类型的线上字符串', async (dir) => {
  const P = await load(dir);
  assert.equal(P.PROTOCOL_VERSION, 2);
  assert.equal(P.FRAME_HEADER_BYTES, 12);
  assert.equal(P.FRAME_PAYLOAD_BYTES, 60 * 1024);
  assert.equal(P.MAX_SLOT, 0xffffffff);
  // 帧头加长了 4 字节，整帧仍须低于 SCTP 单条上限
  assert.ok(P.FRAME_HEADER_BYTES + P.FRAME_PAYLOAD_BYTES < SCTP_LIMIT);

  // 线上字符串是两端（以及不同版本客户端）之间的约定，改名等于断开互通
  const expected = {
    MANIFEST_GET: 'manifest-get',
    READY: 'ready',
    PLAYLIST: 'playlist',
    PLAYLIST_OP: 'playlist-op',
    PLAYLIST_ACK: 'playlist-ack',
    NOW_LINK: 'now-link',
    CHAT: 'chat',
    CHAT_HISTORY: 'chat-history',
    PART: 'part',
    HELLO: 'hello',
    REQUEST: 'request',
    CANCEL: 'cancel',
    DENY: 'deny',
    HAVE: 'have',
    BITFIELD: 'bitfield',
    SYNC: 'sync',
    STALL: 'stall',
  };
  for (const [key, value] of Object.entries(expected)) assert.equal(P.MSG[key], value, `MSG.${key}`);
  // 链接改由播放列表承载，旧的 MEDIA_LINK 不能再出现
  assert.equal('MEDIA_LINK' in P.MSG, false);
  assert.equal(Object.values(P.MSG).includes('media-link'), false);
  // 分发靠字符串，两个类型撞名会把一种消息当另一种处理
  const values = Object.values(P.MSG);
  assert.equal(new Set(values).size, values.length);

  // 只有这两类会大到需要分段；别的类型拼出来一律丢，免得绕过各自的校验
  assert.deepEqual([...P.PART_INNER_TYPES].sort(), ['chat-history', 'playlist']);
  assert.equal(P.PART_CHARS, 45_000);
  assert.equal(P.PART_MAX_BYTES, MB);
  // 上限段数正好能装下 1MB 的 base64
  assert.equal(P.PART_MAX_COUNT, Math.ceil((Math.ceil(MB / 3) * 4) / P.PART_CHARS));
  assert.equal(P.PART_MAX_COUNT, 32);
});

/* ------------------------------ 帧头 ------------------------------ */

impl('encodeFrames / decodeFrame：12 字节帧头往返，槽位取 0、1、0xffffffff', async (dir) => {
  const P = await load(dir);
  const chunk = bytesOf(2 * MB + 12345);
  for (const [slot, chunkIndex] of [
    [0, 0],
    [1, 7],
    [0xffffffff, 0xffffffff],
  ]) {
    const frames = P.encodeFrames(slot, chunkIndex, chunk.buffer);
    assert.equal(frames.length, P.framesPerChunk(chunk.length));
    assert.equal(frames.length, 35);
    const asm = new P.ChunkAssembler();
    asm.expect(chunkIndex, chunk.length);
    let out = null;
    frames.forEach((frame, f) => {
      assert.ok(frame.length <= P.FRAME_HEADER_BYTES + P.FRAME_PAYLOAD_BYTES);
      const d = P.decodeFrame(frame.buffer);
      assert.ok(d, `第 ${f} 帧解不出来`);
      assert.equal(d.slot, slot);
      assert.equal(d.chunkIndex, chunkIndex);
      assert.equal(d.frameIndex, f);
      const r = asm.push(d.chunkIndex, d.frameIndex, d.payload);
      if (r) out = r;
    });
    const last = frames[frames.length - 1];
    assert.equal(last.length, P.FRAME_HEADER_BYTES + (chunk.length - 34 * P.FRAME_PAYLOAD_BYTES));
    assert.ok(out, `槽位 ${slot} 的分片没拼回来`);
    assert.deepEqual(out, chunk);
  }
});

impl('帧头是大端的「槽位 | 分片下标 | 帧下标」，不同槽位的同号分片帧头不同', async (dir) => {
  const P = await load(dir);
  const [frame] = P.encodeFrames(0x01020304, 0x05060708, Uint8Array.from([0xaa, 0xbb]));
  assert.deepEqual([...frame], [1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0, 0xaa, 0xbb]);
  const frames = P.encodeFrames(9, 0, new Uint8Array(P.FRAME_PAYLOAD_BYTES + 1));
  assert.deepEqual([...frames[1].subarray(0, 12)], [0, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0, 1]);
  // 同一片号在两部片里：帧头必须能区分，否则第二部的分片会被写进第一部
  const a = P.decodeFrame(P.encodeFrames(1, 3, new Uint8Array(4))[0]);
  const b = P.decodeFrame(P.encodeFrames(2, 3, new Uint8Array(4))[0]);
  assert.notEqual(a.slot, b.slot);
});

impl('encodeFrames 接受 ArrayBuffer 和带偏移的视图；空分片也有一帧', async (dir) => {
  const P = await load(dir);
  const whole = bytesOf(1000, 7);
  const view = whole.subarray(100, 300);
  const [f1] = P.encodeFrames(5, 6, view);
  const d1 = P.decodeFrame(f1);
  // 视图只编码自己那一段，不能把底层整个 buffer 发出去
  assert.equal(d1.payload.length, 200);
  assert.deepEqual([...d1.payload], [...view]);

  const [f2] = P.encodeFrames(5, 6, whole.slice(100, 300).buffer);
  assert.deepEqual([...P.decodeFrame(f2).payload], [...view]);

  const empty = P.encodeFrames(1, 2, new ArrayBuffer(0));
  assert.equal(empty.length, 1);
  assert.equal(empty[0].length, P.FRAME_HEADER_BYTES);
  const d = P.decodeFrame(empty[0]);
  assert.deepEqual({ slot: d.slot, chunkIndex: d.chunkIndex, frameIndex: d.frameIndex, len: d.payload.length }, { slot: 1, chunkIndex: 2, frameIndex: 0, len: 0 });

  // 正好一帧装满：不能多出一个空帧
  assert.equal(P.encodeFrames(0, 0, new Uint8Array(P.FRAME_PAYLOAD_BYTES)).length, 1);
  assert.equal(P.encodeFrames(0, 0, new Uint8Array(P.FRAME_PAYLOAD_BYTES + 1)).length, 2);
});

impl('decodeFrame 能解带偏移的视图（Node Buffer、安卓桥接给的切片）', async (dir) => {
  const P = await load(dir);
  const payload = bytesOf(100, 3);
  const [frame] = P.encodeFrames(0xfffffffe, 42, payload);
  const big = new Uint8Array(frame.length + 20);
  big.fill(0xee);
  big.set(frame, 7);
  for (const input of [big.subarray(7, 7 + frame.length), Buffer.from(big.buffer, 7, frame.length), frame, frame.buffer]) {
    const d = P.decodeFrame(input);
    assert.ok(d);
    assert.equal(d.slot, 0xfffffffe);
    assert.equal(d.chunkIndex, 42);
    assert.equal(d.frameIndex, 0);
    assert.deepEqual([...d.payload], [...payload]);
  }
});

impl('decodeFrame：过短、超长、不是二进制的帧一律返回 null', async (dir) => {
  const P = await load(dir);
  const H = P.FRAME_HEADER_BYTES;
  const MAXF = H + P.FRAME_PAYLOAD_BYTES;
  for (const len of [0, 1, 8, 11]) {
    assert.equal(P.decodeFrame(new ArrayBuffer(len)), null, `${len} 字节`);
    assert.equal(P.decodeFrame(new Uint8Array(len)), null, `${len} 字节视图`);
  }
  // 旧版 8 字节帧头的帧（只有头）在 v2 看来也太短
  assert.equal(P.decodeFrame(new Uint8Array(8)), null);
  // 恰好 12 字节是合法的空帧
  assert.equal(P.decodeFrame(new ArrayBuffer(H)).payload.length, 0);
  assert.equal(P.decodeFrame(new ArrayBuffer(MAXF)).payload.length, P.FRAME_PAYLOAD_BYTES);
  // 超长帧：对方不可能按协议发出来，收下会让组装器越界
  assert.equal(P.decodeFrame(new ArrayBuffer(MAXF + 1)), null);
  assert.equal(P.decodeFrame(new Uint8Array(MAXF + 1).subarray(0, MAXF + 1)), null);
  assert.equal(P.decodeFrame(new Uint8Array(2 * MB)), null);
  // 视图本身不超长，底层 buffer 超长没关系
  assert.ok(P.decodeFrame(new Uint8Array(MAXF + 100).subarray(50, 50 + MAXF)));

  for (const bad of ['x'.repeat(20), null, undefined, 42, new Array(20).fill(0), { byteLength: 20 }]) {
    assert.equal(P.decodeFrame(bad), null, `输入 ${Object.prototype.toString.call(bad)}`);
  }
});

impl('isSlot 的边界：0 到 0xffffffff 的整数', async (dir) => {
  const P = await load(dir);
  for (const v of [0, 1, 2, 0xfffffffe, 0xffffffff]) assert.equal(P.isSlot(v), true, `${v}`);
  // 超出 32 位的槽位写进帧头会回绕成别的槽位
  for (const v of [-1, 0x100000000, Number.MAX_SAFE_INTEGER, 1.5, -0.5, NaN, Infinity, -Infinity, '1', '0', null, undefined, true, [], {}, 1n]) {
    assert.equal(P.isSlot(v), false, `${typeof v} ${String(v)}`);
  }
  // -0 在数值上就是 0
  assert.equal(P.isSlot(-0), true);
});

/* ------------------------------ splitLarge ------------------------------ */

impl('splitLarge：全中文大消息每段 JSON 的 UTF-8 字节都低于 64KB，并能原样拼回', async (dir) => {
  const P = await load(dir);
  const items = [];
  for (let i = 0; i < 1900; i++) {
    items.push({ from: `成员${i}`, name: '看片的人', text: '这部片子的配乐真是太好听了😀'.repeat(10) + i, at: 1_700_000_000_000 + i });
  }
  const msg = { t: 'chat-history', items };
  const json = JSON.stringify(msg);
  const bytes = utf8Bytes(json);
  assert.ok(bytes > 512 * 1024 && bytes <= P.PART_MAX_BYTES, `素材 ${bytes} 字节`);

  // 用最长允许的 id，算最坏情况
  const id = 'f'.repeat(32);
  const parts = P.splitLarge(msg, id);
  assert.ok(parts.length > 10);
  parts.forEach((part, i) => {
    assert.equal(part.t, 'part');
    assert.equal(part.id, id);
    assert.equal(part.i, i);
    assert.equal(part.n, parts.length);
    assert.match(part.data, /^[A-Za-z0-9+/=]+$/);
    if (i < parts.length - 1) assert.equal(part.data.length, P.PART_CHARS);
    else assert.ok(part.data.length >= 1 && part.data.length <= P.PART_CHARS);
    const size = utf8Bytes(JSON.stringify(part));
    assert.ok(size < SCTP_LIMIT, `第 ${i} 段 ${size} 字节`);
  });

  // 乱序（偶数段正序、奇数段倒序）经 JSON 往返后拼回
  const order = [...parts.filter((_, i) => i % 2 === 0), ...parts.filter((_, i) => i % 2 === 1).reverse()];
  const asm = new P.PartAssembler();
  const results = order.map((p) => asm.push(wire(p)));
  assert.ok(results.slice(0, -1).every((r) => r === null), '没收齐就不能吐出结果');
  assert.deepEqual(results[results.length - 1], msg);
});

impl('splitLarge：小消息只有一段', async (dir) => {
  const P = await load(dir);
  const msg = { t: 'playlist', state: { rev: 1, name: '一部片' } };
  const parts = P.splitLarge(msg, 'abc');
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0], { t: 'part', id: 'abc', i: 0, n: 1, data: b64(JSON.stringify(msg)) });
  assert.deepEqual(new P.PartAssembler().push(wire(parts[0])), msg);
});

impl('splitLarge：按字节限 1MB——正好 1MB 能发，多 1 字节抛错；中文按 3 字节算', async (dir) => {
  const P = await load(dir);
  const exact = asciiMessageOfBytes(P.PART_MAX_BYTES);
  const parts = P.splitLarge(exact, 'edge');
  assert.equal(parts.length, P.PART_MAX_COUNT, '1MB 正好用满段数上限');
  const asm = new P.PartAssembler();
  let out = null;
  for (const p of parts) out = asm.push(wire(p));
  assert.deepEqual(out, exact);

  assert.throws(() => P.splitLarge(asciiMessageOfBytes(P.PART_MAX_BYTES + 1), 'x'), /消息太大/);
  // 字符数只有 35 万，但字节数超了 1MB：必须按字节拦
  const chinese = { t: 'playlist', x: '中'.repeat(Math.ceil(P.PART_MAX_BYTES / 3)) };
  assert.ok(JSON.stringify(chinese).length < P.PART_MAX_BYTES);
  assert.throws(() => P.splitLarge(chinese, 'x'), /消息太大/);
});

/* ------------------------------ PartAssembler ------------------------------ */

impl('PartAssembler：乱序到达也能拼回', async (dir) => {
  const P = await load(dir);
  const msg = threePartMessage();
  const parts = P.splitLarge(msg, 'm1').map(wire);
  assert.equal(parts.length, 3);
  for (const order of [
    [2, 0, 1],
    [1, 2, 0],
    [0, 1, 2],
  ]) {
    const asm = new P.PartAssembler();
    assert.equal(asm.push(parts[order[0]]), null);
    assert.equal(asm.push(parts[order[1]]), null);
    assert.deepEqual(asm.push(parts[order[2]]), msg, `顺序 ${order}`);
  }
});

impl('PartAssembler：重复段忽略，先到的为准；拼完后同 id 重新开始', async (dir) => {
  const P = await load(dir);
  const msg = threePartMessage();
  const parts = P.splitLarge(msg, 'dup').map(wire);
  const asm = new P.PartAssembler();
  assert.equal(asm.push(parts[0]), null);
  // 重复段如果也计数，收到 3 条就会以为齐了，拿着缺一段的数据去解
  assert.equal(asm.push(parts[0]), null);
  assert.equal(asm.push(parts[1]), null);
  // 同下标、内容不同的冒充段：不能覆盖已收下的
  assert.equal(asm.push({ ...parts[1], data: 'A'.repeat(P.PART_CHARS) }), null);
  assert.deepEqual(asm.push(parts[2]), msg);
  // 拼完的 id 从待拼表里移除：之后再来一段是新的一轮，不会凭空再吐一次
  assert.equal(asm.push(parts[0]), null);
  assert.equal(asm.push(parts[2]), null);
});

impl('PartAssembler：非末段长度不对、末段超长都拒绝，且不留副作用', async (dir) => {
  const P = await load(dir);
  const parts = P.splitLarge(threePartMessage(), 'keep').map(wire);
  // 同 id 的短段：如果被收下，真正的第 1 段会被当成重复丢掉
  assertRejectedCleanly(P, { ...parts[1], data: parts[1].data.slice(1) }, '非末段少一个字符');
  assertRejectedCleanly(P, { ...parts[1], data: parts[1].data + 'A' }, '非末段多一个字符');
  assertRejectedCleanly(P, { t: 'part', id: 'other', i: 0, n: 2, data: 'QUFB' }, '别的 id 的短首段');
  assertRejectedCleanly(P, { t: 'part', id: 'other', i: 1, n: 2, data: 'A'.repeat(P.PART_CHARS + 1) }, '末段超长');
  assertRejectedCleanly(P, { t: 'part', id: 'other', i: 0, n: 1, data: 'A'.repeat(P.PART_CHARS + 1) }, '单段超长');
  assertRejectedCleanly(P, { t: 'part', id: 'other', i: 0, n: 1, data: 42 }, 'data 不是字符串');
  assertRejectedCleanly(P, { t: 'part', id: 'other', i: 0, n: 1 }, '缺 data');
});

impl('PartAssembler：段数、下标越界的段拒绝，且不留副作用', async (dir) => {
  const P = await load(dir);
  const full = 'A'.repeat(P.PART_CHARS);
  // 段数上限防的是「宣称 10 万段、慢慢发」把内存吃光
  assertRejectedCleanly(P, { t: 'part', id: 'big', i: 0, n: P.PART_MAX_COUNT + 1, data: full }, 'n 超过上限');
  assertRejectedCleanly(P, { t: 'part', id: 'big', i: 0, n: 1e9, data: full }, 'n 极大');
  assertRejectedCleanly(P, { t: 'part', id: 'big', i: 0, n: 0, data: '' }, 'n 为 0');
  assertRejectedCleanly(P, { t: 'part', id: 'big', i: 0, n: 1.5, data: 'QQ==' }, 'n 是小数');
  assertRejectedCleanly(P, { t: 'part', id: 'big', i: 0, n: '2', data: full }, 'n 是字符串');
  assertRejectedCleanly(P, { t: 'part', id: 'big', i: 2, n: 2, data: 'QQ==' }, 'i 等于 n');
  assertRejectedCleanly(P, { t: 'part', id: 'big', i: -1, n: 2, data: full }, 'i 为负');
  assertRejectedCleanly(P, { t: 'part', id: 'big', i: 0.5, n: 2, data: full }, 'i 是小数');
  // 同 id、段数不一致：不能混进正在拼的那条
  assertRejectedCleanly(P, { t: 'part', id: 'keep', i: 1, n: 4, data: full }, '同 id 段数不一致');

  // n 正好等于上限是合法的（1MB 就要用满）：会被登记，因此会挤掉并发上限为 1 时的另一条
  const asm = new P.PartAssembler({ maxConcurrent: 1 });
  const msg = threePartMessage();
  const parts = P.splitLarge(msg, 'keep').map(wire);
  asm.push(parts[0]);
  assert.equal(asm.push({ t: 'part', id: 'max', i: 0, n: P.PART_MAX_COUNT, data: full }), null);
  asm.push(parts[1]);
  assert.equal(asm.push(parts[2]), null, '上限内的段应当被登记');
});

impl('PartAssembler：id 必须是 1 到 32 个字符的字符串', async (dir) => {
  const P = await load(dir);
  const text = JSON.stringify({ t: 'playlist', v: 1 });
  for (const id of ['a'.repeat(33), '', 123, null, undefined, ['abc'], { id: 'abc' }]) {
    assertRejectedCleanly(P, { ...rawPart('x', text), id }, `id=${JSON.stringify(id)}`);
  }
  const asm = new P.PartAssembler();
  assert.deepEqual(asm.push(rawPart('a'.repeat(32), text)), { t: 'playlist', v: 1 });
  assert.deepEqual(asm.push(rawPart('a', text)), { t: 'playlist', v: 1 });
  // 非法输入本身不能让它抛异常
  for (const bad of [null, undefined, 'part', 42, []]) assert.equal(asm.push(bad), null);
});

impl('PartAssembler：超过并发上限时挤掉最老的那条', async (dir) => {
  const P = await load(dir);
  const clock = { t: 0 };
  const asm = new P.PartAssembler({ maxConcurrent: 2, now: () => clock.t });
  const msgs = {};
  const parts = {};
  for (const id of ['A', 'B', 'C']) {
    msgs[id] = { t: 'playlist', id, x: id.repeat(100_000) };
    parts[id] = P.splitLarge(msgs[id], id).map(wire);
  }
  assert.equal(asm.push(parts.A[0]), null);
  clock.t = 1;
  assert.equal(asm.push(parts.B[0]), null);
  clock.t = 2;
  // 第三条进来，最老的 A 被挤掉
  assert.equal(asm.push(parts.C[0]), null);
  assert.equal(asm.push(parts.B[1]), null);
  assert.deepEqual(asm.push(parts.B[2]), msgs.B);
  assert.equal(asm.push(parts.C[1]), null);
  assert.deepEqual(asm.push(parts.C[2]), msgs.C);
  // A 的首段已经丢了，后两段到齐也拼不出来
  assert.equal(asm.push(parts.A[1]), null);
  assert.equal(asm.push(parts.A[2]), null);

  // 默认上限 4：第 5 条挤掉第 1 条
  const asm4 = new P.PartAssembler({ now: () => clock.t });
  const five = ['p', 'q', 'r', 's', 'u'].map((id) => {
    const m = { t: 'chat-history', id, x: id.repeat(100_000) };
    return { m, parts: P.splitLarge(m, id).map(wire) };
  });
  for (const { parts: ps } of five) {
    clock.t += 1;
    assert.equal(asm4.push(ps[0]), null);
  }
  for (const { m, parts: ps } of five.slice(1)) {
    asm4.push(ps[1]);
    assert.deepEqual(asm4.push(ps[2]), m);
  }
  asm4.push(five[0].parts[1]);
  assert.equal(asm4.push(five[0].parts[2]), null);
});

impl('PartAssembler：超时未拼齐的丢弃（注入时钟）', async (dir) => {
  const P = await load(dir);
  const msg = threePartMessage();
  const parts = P.splitLarge(msg, 'slow').map(wire);

  // 正好 30 秒还不算超时
  const clock = { t: 1000 };
  const asm = new P.PartAssembler({ now: () => clock.t });
  asm.push(parts[0]);
  asm.push(parts[1]);
  clock.t += 30_000;
  assert.deepEqual(asm.push(parts[2]), msg);

  // 超过 30 秒：前面收的段作废，后到的段开始新的一轮
  const clock2 = { t: 1000 };
  const asm2 = new P.PartAssembler({ now: () => clock2.t });
  asm2.push(parts[0]);
  asm2.push(parts[1]);
  clock2.t += 30_001;
  assert.equal(asm2.push(parts[2]), null);
  // 过期后重新发齐仍能拼回
  assert.equal(asm2.push(parts[0]), null);
  assert.deepEqual(asm2.push(parts[1]), msg);

  // 计时从这条消息的第一段开始算，中途陆续到段不续期
  const clock3 = { t: 0 };
  const asm3 = new P.PartAssembler({ timeoutMs: 1000, now: () => clock3.t });
  asm3.push(parts[0]);
  clock3.t = 900;
  asm3.push(parts[1]);
  clock3.t = 1001;
  assert.equal(asm3.push(parts[2]), null);
});

impl('PartAssembler：内层类型不在白名单时返回 null', async (dir) => {
  const P = await load(dir);
  const asm = new P.PartAssembler();
  // 同步、握手、清单这些消息各有自己的校验路径，不能借分段绕过去
  for (const t of ['sync', 'stall', 'hello', 'role', 'manifest', 'part', 'playlist-op', 'chat', 'PLAYLIST', '', undefined, 42]) {
    const parts = P.splitLarge({ t, x: 'y' }, 'k').map(wire);
    assert.equal(asm.push(parts[0]), null, `t=${String(t)}`);
  }
  assert.deepEqual(asm.push(wire(P.splitLarge({ t: 'playlist', a: 1 }, 'k')[0])), { t: 'playlist', a: 1 });
  assert.deepEqual(asm.push(wire(P.splitLarge({ t: 'chat-history', a: [] }, 'k')[0])), { t: 'chat-history', a: [] });
});

impl('PartAssembler：base64 解出非法 UTF-8 时返回 null，不做替换字符容错', async (dir) => {
  const P = await load(dir);
  const asm = new P.PartAssembler();
  const enc = (bytes) => ({ t: 'part', id: 'u', i: 0, n: 1, data: Buffer.from(bytes).toString('base64') });
  const head = [...Buffer.from('{"t":"playlist","x":"')];
  const tail = [...Buffer.from('"}')];
  // 对照组：合法的多字节字符照常解出
  assert.deepEqual(asm.push(enc([...head, ...Buffer.from('é中😀'), ...tail])), { t: 'playlist', x: 'é中😀' });
  // 非法字节如果被宽松地替换成 U+FFFD，这条仍是合法的 playlist，会被悄悄收下
  for (const [label, bad] of [
    ['0xFF', [0xff]],
    ['截断的三字节序列', [0xe4, 0xb8]],
    ['过长编码', [0xc0, 0xaf]],
    ['UTF-8 编码的代理项', [0xed, 0xa0, 0x80]],
    ['孤立的续字节', [0x80]],
  ]) {
    assert.equal(asm.push(enc([...head, ...bad, ...tail])), null, label);
  }
  // base64 本身不合法
  for (const data of ['!!!!', 'a', 'ab=c', '....']) {
    assert.equal(asm.push({ t: 'part', id: 'u', i: 0, n: 1, data }), null, `data=${data}`);
  }
});

impl('PartAssembler：拼出来不是对象（数组、字符串、null、数字、非 JSON）时返回 null', async (dir) => {
  const P = await load(dir);
  const asm = new P.PartAssembler();
  for (const text of ['["playlist"]', '[{"t":"playlist"}]', '"playlist"', 'null', '42', 'true', 'playlist', '{"t":"playlist"', '']) {
    assert.equal(asm.push(rawPart('v', text)), null, `内容 ${JSON.stringify(text)}`);
  }
});

impl('PartAssembler：每段都合规但总字节超过 1MB 的一律丢弃', async (dir) => {
  const P = await load(dir);
  // 32 段 × 45000 字符解出来是 1,080,000 字节，比 1MB 多——段数上限本身拦不住它
  const n = P.PART_MAX_COUNT;
  const totalBytes = (n * P.PART_CHARS * 3) / 4;
  assert.ok(totalBytes > P.PART_MAX_BYTES);
  const head = '{"t":"playlist","x":"';
  const text = head + 'a'.repeat(totalBytes - head.length - 2) + '"}';
  const data = b64(text);
  assert.equal(data.length, n * P.PART_CHARS);
  const asm = new P.PartAssembler();
  let out;
  for (let i = 0; i < n; i++) {
    out = asm.push({ t: 'part', id: 'huge', i, n, data: data.slice(i * P.PART_CHARS, (i + 1) * P.PART_CHARS) });
  }
  assert.equal(out, null);
});

impl('PartAssembler.clear() 丢掉所有拼了一半的消息', async (dir) => {
  const P = await load(dir);
  const msg = threePartMessage();
  const parts = P.splitLarge(msg, 'c').map(wire);
  const asm = new P.PartAssembler();
  asm.push(parts[0]);
  asm.clear();
  assert.equal(asm.push(parts[1]), null);
  assert.equal(asm.push(parts[2]), null);
  assert.deepEqual(asm.push(parts[0]), msg);
});

/* ------------------------------ randomId ------------------------------ */

impl('randomId：十六进制，长度是字节数的两倍，默认 6 字节', async (dir) => {
  const P = await load(dir);
  for (let k = 0; k < 50; k++) {
    assert.match(P.randomId(), /^[0-9a-f]{12}$/);
    assert.match(P.randomId(8), /^[0-9a-f]{16}$/);
  }
  assert.equal(P.randomId(1).length, 2);
  assert.equal(P.randomId(16).length, 32);
  assert.equal(P.randomId(0), '');

  // 分段 id 上限 32 字符：randomId(16) 刚好能用，swarm 用的 randomId(8) 更没问题
  const msg = { t: 'playlist', v: 2 };
  for (const bytes of [8, 16]) {
    const asm = new P.PartAssembler();
    assert.deepEqual(asm.push(wire(P.splitLarge(msg, P.randomId(bytes))[0])), msg, `randomId(${bytes})`);
  }
  assert.equal(new P.PartAssembler().push(wire(P.splitLarge(msg, P.randomId(17))[0])), null);

  // 播放列表条目 id 要求 8–32 位小写十六进制：默认长度必须满足，否则快照整张被拒
  const { validateSnapshot } = await import(dir + 'playlist.js');
  const snap = {
    rev: 1,
    seq: 1,
    nextSlot: 1,
    started: false,
    autoplay: true,
    history: [],
    queue: [{ id: P.randomId(), kind: 'link', url: 'https://example.com/', title: '' }],
  };
  assert.ok(validateSnapshot(snap));
});

impl('帧头只放得下 32 位：槽位或分片下标超出范围时直接拒绝，不静默回绕', async (dir) => {
  const P = await load(dir);
  const buf = new Uint8Array(10);
  for (const [slot, index] of [
    [2 ** 32, 0],
    [-1, 0],
    [1.5, 0],
    [0, 2 ** 32],
    [0, -1],
    ['1', 0],
  ]) {
    assert.throws(() => P.encodeFrames(slot, index, buf), RangeError, `slot=${slot} index=${index}`);
  }
  const [frame] = P.encodeFrames(0xffffffff, 0xffffffff, buf);
  const f = P.decodeFrame(frame);
  assert.equal(f.slot, 0xffffffff);
  assert.equal(f.chunkIndex, 0xffffffff);
});
