'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { IMPLS } = require('./helpers/impls');

/**
 * 0.7 把协议升到 v2，邀请码的紧凑数组末尾多了一项协议版本号。
 * 这组测试守两件事：
 *  1. 新码能把「我是 v2」带到对面 —— 粘贴码的那一刻就该说清楚「对方是旧版」，
 *     而不是等数据通道 HELLO 被拒、用户只看到一句莫名其妙的断开；
 *  2. 旧码（没有这一项、或者这一项是垃圾）一律当 v1 —— 绝不能因为缺字段就把
 *     0.6 的对端误认成 v2，否则会放行一条注定在 HELLO 被拦下的连接。
 */

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

/** 照 signaling.js 的 toChatSafeBase64 手工编码：'+' → '-'，'/' → '.'，去掉 '='。 */
function chatSafe(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '.').replace(/=+$/, '');
}

/** 手工拼一条 NR3 码：默认 'R'（未压缩），gzip:true 时走 'G'。 */
function nr3(payload, { gzip = false } = {}) {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  return gzip ? `NR3-G${chatSafe(zlib.gzipSync(json))}` : `NR3-R${chatSafe(json)}`;
}

/** 把 encodeCode 的产物原样拆回 JSON，用来直接看紧凑数组的形状。 */
function rawPayload(code) {
  assert.match(code, /^NR3-[RG]/);
  const bytes = Buffer.from(code.slice(5).replace(/-/g, '+').replace(/\./g, '/'), 'base64');
  const json = code[4] === 'G' ? zlib.gunzipSync(bytes) : bytes;
  return JSON.parse(json.toString('utf8'));
}

const LONG_SDP = `v=0\r\n${'a=candidate:1234567890 1 udp 2122260223 192.168.1.2 50000 typ host\r\n'.repeat(60)}END`;

const ROOM = {
  k: 'room',
  url: 'wss://signal.example.com',
  room: 'AbCd1234',
  from: 'host-peer',
  maxMembers: 6,
  securityMode: 'trusted',
};
const OFFER = { k: 'offer', from: 'host-peer', sdp: { type: 'offer', sdp: LONG_SDP }, maxMembers: 4, securityMode: 'safe' };
const ANSWER = { k: 'answer', from: 'guest-peer', sdp: { type: 'answer', sdp: 'v=0\r\na=setup:active' }, securityMode: 'trusted' };

impl('房间码、邀请码、应答码往返后都带 protocolVersion === 2', async (dir) => {
  const { encodeCode, decodeCode } = await import(dir + 'signaling.js');
  const { PROTOCOL_VERSION } = await import(dir + 'protocol.js');
  assert.equal(PROTOCOL_VERSION, 2, '协议版本变了，这组测试的前提要一起更新');

  const room = await decodeCode(await encodeCode(ROOM));
  assert.equal(room.protocolVersion, 2);
  // 版本号是追加项，不能挤掉原有字段
  assert.equal(room.url, ROOM.url);
  assert.equal(room.room, ROOM.room);
  assert.equal(room.from, ROOM.from);
  assert.equal(room.maxMembers, 6);
  assert.equal(room.securityMode, 'trusted');

  const offer = await decodeCode(await encodeCode(OFFER));
  assert.equal(offer.protocolVersion, 2);
  assert.equal(offer.sdp.sdp, LONG_SDP);
  assert.equal(offer.maxMembers, 4);
  assert.equal(offer.securityMode, 'safe');

  const answer = await decodeCode(await encodeCode(ANSWER));
  assert.equal(answer.protocolVersion, 2);
  assert.equal(answer.from, 'guest-peer');
  assert.equal(answer.sdp.sdp, ANSWER.sdp.sdp);
  assert.equal(answer.securityMode, 'trusted');
});

impl('压缩（G）和未压缩（R）两条编码路径都带版本号', async (dir) => {
  const { encodeCode, decodeCode } = await import(dir + 'signaling.js');
  // 短房间码不值得压缩，长 SDP 一定会压 —— 两条路径各覆盖一次，别只测到其中一条
  const short = await encodeCode(ROOM);
  const long = await encodeCode(OFFER);
  assert.match(short, /^NR3-R/, '房间码应当走未压缩路径，否则这条没覆盖到 R');
  assert.match(long, /^NR3-G/, '长 SDP 应当走 gzip 路径，否则这条没覆盖到 G');
  assert.equal((await decodeCode(short)).protocolVersion, 2);
  assert.equal((await decodeCode(long)).protocolVersion, 2);
});

impl('版本号追加在紧凑数组的最末尾，原有下标一个都不挪', async (dir) => {
  // 0.6 的解码是按下标取值的：把版本号插在中间，旧客户端会把它读成人数或安全模式。
  // 只有放在末尾，旧客户端才会当作多余的尾巴忽略掉。
  const { encodeCode } = await import(dir + 'signaling.js');
  assert.deepEqual(rawPayload(await encodeCode(ROOM)), ['r', ROOM.url, ROOM.room, ROOM.from, 6, 't', 2]);
  assert.deepEqual(rawPayload(await encodeCode(OFFER)), ['o', 'host-peer', LONG_SDP, 4, 's', 2]);
  assert.deepEqual(rawPayload(await encodeCode(ANSWER)), ['a', 'guest-peer', ANSWER.sdp.sdp, 't', 2]);
});

impl('没有末尾版本号的 NR3 码（0.6 发出的）一律按 v1', async (dir) => {
  const { decodeCode } = await import(dir + 'signaling.js');
  const oldRoom = ['r', ROOM.url, ROOM.room, ROOM.from, 6, 't'];
  const oldOffer = ['o', 'host-peer', 'v=0\r\na=setup:actpass', 4, 's'];
  const oldAnswer = ['a', 'guest-peer', 'v=0\r\na=setup:active', 't'];

  for (const gzip of [false, true]) {
    const room = await decodeCode(nr3(oldRoom, { gzip }));
    assert.equal(room.protocolVersion, 1, `旧房间码（gzip=${gzip}）必须是 v1`);
    // 其余字段照常解出来，旧码不能因为缺版本号就整体作废
    assert.equal(room.room, ROOM.room);
    assert.equal(room.maxMembers, 6);
    assert.equal(room.securityMode, 'trusted');

    const offer = await decodeCode(nr3(oldOffer, { gzip }));
    assert.equal(offer.protocolVersion, 1, `旧邀请码（gzip=${gzip}）必须是 v1`);
    assert.equal(offer.sdp.sdp, 'v=0\r\na=setup:actpass');
    assert.equal(offer.maxMembers, 4);
    assert.equal(offer.securityMode, 'safe');

    const answer = await decodeCode(nr3(oldAnswer, { gzip }));
    assert.equal(answer.protocolVersion, 1, `旧应答码（gzip=${gzip}）必须是 v1`);
    assert.equal(answer.from, 'guest-peer');
    assert.equal(answer.securityMode, 'trusted');
  }
});

impl('末尾版本号是非法值时按 v1 处理，不能被垃圾值抬成新版', async (dir) => {
  const { decodeCode } = await import(dir + 'signaling.js');
  // 0 和负数不是合法版本；非数字的字符串、小数、超出安全整数的数也不是。
  // 拿不准就当旧版 —— 往旧了判最多是多提示一句，往新了判会放行一条必然失败的连接。
  const bad = [0, 'x', -1, 1.5, null, '', 2 ** 53, { v: 2 }];
  for (const v of bad) {
    const label = JSON.stringify(v);
    const room = await decodeCode(nr3(['r', ROOM.url, ROOM.room, ROOM.from, 6, 't', v]));
    assert.equal(room.protocolVersion, 1, `房间码末尾是 ${label} 时应当按 v1`);
    const offer = await decodeCode(nr3(['o', 'host-peer', 'v=0', 4, 's', v]));
    assert.equal(offer.protocolVersion, 1, `邀请码末尾是 ${label} 时应当按 v1`);
    const answer = await decodeCode(nr3(['a', 'guest-peer', 'v=0', 't', v]));
    assert.equal(answer.protocolVersion, 1, `应答码末尾是 ${label} 时应当按 v1`);
  }
});

impl('比本机更新的版本号原样保留，界面才说得出「对方版本更新」', async (dir) => {
  const { decodeCode } = await import(dir + 'signaling.js');
  // 把未来的 v3 也压成 1，会把「请你升级」说反成「请对方升级」
  assert.equal((await decodeCode(nr3(['r', ROOM.url, ROOM.room, ROOM.from, 6, 's', 3]))).protocolVersion, 3);
  assert.equal((await decodeCode(nr3(['o', 'host-peer', 'v=0', 4, 's', 3]))).protocolVersion, 3);
  assert.equal((await decodeCode(nr3(['a', 'guest-peer', 'v=0', 's', 3]))).protocolVersion, 3);
});

impl('旧的对象式载荷（非数组）一律是 v1', async (dir) => {
  const { decodeCode } = await import(dir + 'signaling.js');
  // 对象式载荷只有最早的 SW1 会发。它里头就算写了 protocolVersion 也不作数：
  // v2 客户端从来不发对象式载荷，出现这种组合只能是旧码或伪造的码。
  for (const payload of [
    { k: 'room', url: ROOM.url, room: ROOM.room, from: ROOM.from },
    { k: 'offer', from: 'host-peer', name: '房主', sdp: { type: 'offer', sdp: 'v=0' } },
    { k: 'answer', from: 'guest-peer', name: '观众', sdp: { type: 'answer', sdp: 'v=0' }, protocolVersion: 2 },
  ]) {
    const viaNr3 = await decodeCode(nr3(payload));
    assert.equal(viaNr3.protocolVersion, 1, `NR3 里的对象式 ${payload.k} 必须是 v1`);
    assert.equal(viaNr3.securityMode, 'safe', '旧载荷缺模式字段只能按安全模式');

    const sw1 = `SW1-${zlib.gzipSync(JSON.stringify(payload)).toString('base64url')}`;
    const viaSw1 = await decodeCode(sw1);
    assert.equal(viaSw1.protocolVersion, 1, `SW1 的 ${payload.k} 必须是 v1`);
    assert.equal(viaSw1.from, payload.from);
  }
});

impl('NR2 / SW2 的旧数组码同样是 v1', async (dir) => {
  const { decodeCode } = await import(dir + 'signaling.js');
  const b64url = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  // NR2 的邀请码布局是 [o, from, name, sdp, file, maxMembers, mode]，和 NR3 的下标完全不同。
  // 哪怕尾巴上多挂一个 2，也不能按 NR3 的规则读成 v2。
  const nr2Offer = ['o', 'host', '房主', { type: 'offer', sdp: 'v=0' }, 0, 4, 's', 2];
  assert.equal((await decodeCode(`NR2-R${b64url(nr2Offer)}`)).protocolVersion, 1);
  const nr2Answer = ['a', 'guest', '观众', { type: 'answer', sdp: 'v=0' }, 't', 2];
  assert.equal((await decodeCode(`NR2-R${b64url(nr2Answer)}`)).protocolVersion, 1);
  const sw2Room = ['r', ROOM.url, 'room-id', 'host-peer', 4];
  assert.equal((await decodeCode(`SW2-R${b64url(sw2Room)}`)).protocolVersion, 1);
});

test('桌面端编的码安卓端解得出 v2，反过来也一样', async () => {
  const [desktop, android] = await Promise.all(IMPLS.map(({ dir }) => import(dir + 'signaling.js')));
  for (const payload of [ROOM, OFFER, ANSWER]) {
    assert.equal((await android.decodeCode(await desktop.encodeCode(payload))).protocolVersion, 2);
    assert.equal((await desktop.decodeCode(await android.encodeCode(payload))).protocolVersion, 2);
  }
});

impl('码里的版本号必须是数字：字符串和数组形式的 2 一律按旧版处理', async (dir) => {
  const { decodeCode } = await import(dir + 'signaling.js');
  for (const v of ['2', [2], true]) {
    const payload = await decodeCode(nr3(['a', 'guest-peer', 'v=0', 't', v]));
    assert.equal(payload.protocolVersion, 1, `末尾是 ${JSON.stringify(v)}`);
  }
});
