'use strict';

// 修复批次 15（杂项与运维）：管理员的列表操作在房主断线后立即结算、一对一应答绑定邀请编号、
// 启动时延后扫旧缓存根、启动器按关键包判断依赖、信令服务器连不上时的提示。
//
// app.js 的部分照 p4RoomCleanup / appHardening 的做法：把顶层函数原样抠进 vm 沙箱，配上假对象。
// 全程不启动播放器、不联网、不出声。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');
const { IMPLS } = require('./helpers/impls');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('src/renderer/app.js');
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);

/** app.js 顶层函数的源码：从声明行到下一个顶格的 `}`。 */
function fnSource(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层函数 ${name}`);
  const end = APP.indexOf('\n}\n', m.index);
  assert.ok(end > m.index, `${name} 的结尾没找到`);
  return APP.slice(m.index, end + 2);
}

/** app.js 顶层的单行 const / let 声明。 */
function declSource(name) {
  const m = new RegExp(`^(?:const|let) ${name} = [^\\n]*;$`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层声明 ${name}`);
  return m[0];
}

function sandbox(sources, globals) {
  const ctx = { console, setTimeout, clearTimeout, Promise, Date, Error, Map, Set, JSON, ...globals };
  vm.createContext(ctx);
  vm.runInContext(sources.join('\n\n'), ctx, { filename: 'app.js（节选）' });
  return ctx;
}

async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

// 沙箱里建的对象原型不是这边的，按字段比
const plain = (value) => JSON.parse(JSON.stringify(value));

/* ================= A2-4：房主断线时挂着的列表操作立即结算 ================= */

function opBox({ send = () => true } = {}) {
  const timers = [];
  const S = {
    hostId: 'host',
    sync: { canIControl: () => true },
    swarm: { peers: new Map([['host', { peerId: 'host', authenticated: true, send }]]) },
    pendingOps: new Map(),
  };
  const ctx = sandbox([fnSource('submitPlaylistOp'), fnSource('settlePendingOpsHostLost')], {
    S,
    isRoomHost: () => false,
    randomId: () => `req${timers.length}`,
    MSG: { PLAYLIST_OP: 'playlist-op' },
    PLAYLIST_OP_TIMEOUT_MS: 45_000,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms, cleared: false });
      return timers.length - 1;
    },
    clearTimeout: (id) => {
      if (timers[id]) timers[id].cleared = true;
    },
  });
  return { ctx, S, timers };
}

test('和房主的直连断了：等回执的列表操作当场结束，说「结果以列表为准」，不干等 45 秒', async () => {
  const { ctx, S, timers } = opBox();
  const first = ctx.submitPlaylistOp({ type: 'remove', id: 'a' });
  const second = ctx.submitPlaylistOp({ type: 'playNow', id: 'b' });
  assert.equal(S.pendingOps.size, 2);

  ctx.settlePendingOpsHostLost();
  for (const res of [await first, await second]) {
    assert.deepEqual(plain(res), { ok: false, reason: '和房主的连接断了，结果以列表为准', uncertain: true });
  }
  assert.equal(S.pendingOps.size, 0);
  assert.ok(timers.every((t) => t.cleared), '45 秒的超时没撤掉');
  // 再断一次（重连又失败）：没有挂着的就什么都不做
  ctx.settlePendingOpsHostLost();
});

test('列表操作超时同样是「没等到回执」；消息根本没发出去才是确定的失败', async () => {
  const timeout = opBox();
  const pending = timeout.ctx.submitPlaylistOp({ type: 'remove', id: 'a' });
  timeout.timers[0].fn();
  assert.deepEqual(plain(await pending), { ok: false, reason: '房主没有回应', uncertain: true });

  const unsent = opBox({ send: () => false });
  assert.deepEqual(plain(await unsent.ctx.submitPlaylistOp({ type: 'remove', id: 'a' })), {
    ok: false,
    reason: '和房主的连接断了',
  });
});

function hostLinkBox() {
  const settled = [];
  const handlers = new Map();
  const S = {
    hostId: 'host-1',
    peerId: 'me',
    role: 'guest',
    mode: 'server',
    hostGone: false,
    hostLink: null,
    pendingOps: new Map([['r1', (res) => settled.push(res)]]),
    swarm: { on: (name, fn) => handlers.set(name, fn), peers: new Map() },
  };
  const i = APP.indexOf("  S.swarm.on('peer-gone', (peerId) => {");
  assert.ok(i !== -1, '没找到 peer-gone 的处理器');
  const handler = APP.slice(i, APP.indexOf('\n  });', i) + '\n  });'.length);
  const ctx = sandbox([fnSource('hostReallyGone'), fnSource('settlePendingOpsHostLost'), `function wire() {\n${handler}\n}`], {
    S,
    roomEntered: true,
    isRoomHost: () => false,
    log: () => {},
    renderPlaylistSoon: () => {},
    refreshSources: () => {},
    scheduleTransferUpdate: () => {},
    renderReady: () => {},
    maybeAutoStart: () => {},
  });
  ctx.wire();
  return { ctx, S, settled, gone: handlers.get('peer-gone') };
}

test('peer-gone 命中房主（哪怕只是在重连）就结算挂着的列表操作；别人断线不动', () => {
  const other = hostLinkBox();
  other.gone('someone-else');
  assert.equal(other.settled.length, 0, '别的成员断线不该结算发给房主的操作');

  const box = hostLinkBox();
  box.gone('host-1');
  assert.equal(box.S.hostLink, 'reconnecting', '只是在重连');
  assert.equal(box.settled.length, 1);
  assert.equal(box.settled[0].uncertain, true);
  assert.equal(box.settled[0].reason, '和房主的连接断了，结果以列表为准');
});

test('确认房主走了（hostReallyGone）也结算', () => {
  const box = hostLinkBox();
  box.ctx.hostReallyGone();
  assert.equal(box.S.hostGone, true);
  assert.equal(box.settled.length, 1);
});

test('没等到回执的准备行写「没等到房主确认」，不说成房主不接受', () => {
  const logs = [];
  const ctx = sandbox([fnSource('failPrepJob'), fnSource('removePrepJob'), fnSource('playlistOpError')], {
    S: { prepJobs: [] },
    roomEntered: true,
    isRoomHost: () => false,
    log: (m) => logs.push(m),
    renderPlaylist: () => {},
  });
  const lost = { state: 'submitting', cancelled: false, cancelHooks: [], name: 'a.mkv' };
  ctx.failPrepJob(lost, ctx.playlistOpError({ ok: false, reason: '和房主的连接断了，结果以列表为准', uncertain: true }));
  assert.equal(lost.text, '没等到房主确认');
  assert.equal(lost.detail, '和房主的连接断了，结果以列表为准');
  assert.equal(logs.at(-1), '《a.mkv》没等到房主确认：和房主的连接断了，结果以列表为准');

  // 房主明确拒绝的，照旧
  const refused = { state: 'submitting', cancelled: false, cancelHooks: [], name: 'b.mkv' };
  ctx.failPrepJob(refused, ctx.playlistOpError({ ok: false, reason: '列表里已经有这个链接了' }));
  assert.equal(refused.text, '房主没有接受');
  assert.equal(logs.at(-1), '《b.mkv》没加进列表：列表里已经有这个链接了');
});

test('移除、立即播放这类操作没等到回执时，日志不说「列表没改成」', async () => {
  const logs = [];
  let next = null;
  const ctx = sandbox([fnSource('runPlaylistOp')], {
    submitPlaylistOp: async () => next,
    log: (m) => logs.push(m),
  });
  next = { ok: false, reason: '和房主的连接断了，结果以列表为准', uncertain: true };
  await ctx.runPlaylistOp({ type: 'remove' });
  next = { ok: false, reason: '列表里没有这一项' };
  await ctx.runPlaylistOp({ type: 'remove' });
  next = { ok: false, reason: 'needs-confirm' };
  await ctx.runPlaylistOp({ type: 'move' });
  assert.deepEqual(logs, ['没等到房主确认：和房主的连接断了，结果以列表为准', '列表没改成：列表里没有这一项']);
});

test('本地加片没等到回执时同样留宽限期，别急着撤掉会话和清单', () => {
  const body = fnSource('addLocalFile');
  assert.match(body, /if \(res\.uncertain\) \{\s*S\.addGrace\.set\(fileId/);
  assert.doesNotMatch(body, /res\.reason === '房主没有回应'/, '按文案判断，换个说法就失效');
  assert.match(fnSource('addLinkItem'), /throw playlistOpError\(res\)/);
});

test('房主回执按 peerId 取眼下的连接：处理期间直连重连成了新的一条，回执不丢在旧连接上', async () => {
  const acks = [];
  const oldPeer = { peerId: 'admin', name: 'A', send: (m) => acks.push(['old', m]) };
  const newPeer = { peerId: 'admin', name: 'A', send: (m) => acks.push(['new', m]) };
  const S = { sync: { isController: () => true }, swarm: { peers: new Map([['admin', oldPeer]]) } };
  let finish = null;
  const ctx = sandbox([declSource('PLAYLIST_OP_QUEUE_PER_PEER'), declSource('playlistOpQueued'), fnSource('onPlaylistOp')], {
    S,
    isRoomHost: () => true,
    MSG: { PLAYLIST_ACK: 'playlist-ack' },
    hostApplyOp: () => new Promise((resolve) => (finish = resolve)),
  });
  ctx.onPlaylistOp({ reqId: 'r1', op: { type: 'add' } }, oldPeer);
  S.swarm.peers.set('admin', newPeer); // 前面排着一条在等清单，这期间直连重连了
  finish({ ok: true, id: 'item-1' });
  await flush();
  assert.deepEqual(
    acks.map(([via, m]) => [via, m.reqId, m.ok]),
    [['new', 'r1', true]]
  );
});

test('信令加入失败：服务器回了原因（带 code）就只说原因，只有没拿到回复时才提「改用极简模式」', () => {
  // 房间满、限流、身份冲突时服务器是通的，叫人去改用极简模式是误导（GG4-3 的客户端那一半）
  const body = fnSource('joinViaServer');
  assert.match(body, /e\.code\s*\n?\s*\?\s*e\.message\s*\n?\s*:\s*`\$\{e\.message\}\\n\\n如果对方没有部署信令服务器/);
  assert.doesNotMatch(body, /e\.code === 'REGION_BLOCKED'\s*\n?\s*\?/);
});

test('新文案都有英文', async () => {
  const { translate } = await load('src/renderer/lib/i18n.js');
  assert.equal(
    translate('和房主的连接断了，结果以列表为准', 'en'),
    'The connection to the host was lost; check the playlist to see whether it went through'
  );
  assert.equal(translate('没等到房主确认', 'en'), 'No confirmation from the host');
  assert.equal(
    translate('没等到房主确认：房主没有回应', 'en'),
    'No confirmation from the host: The host did not respond'
  );
  assert.equal(
    translate('《a.mkv》没等到房主确认：和房主的连接断了，结果以列表为准', 'en'),
    '“a.mkv”: no confirmation from the host: The connection to the host was lost; check the playlist to see whether it went through'
  );
  assert.equal(
    translate('这是上一条邀请的应答，和眼下这条邀请对不上，已忽略；当前的邀请链接照常有效。请让对方用当前这条邀请链接重新生成应答。', 'en'),
    'This answer belongs to an earlier invite and does not match the current one, so it was ignored; the current invite link still works. Ask the other person to generate a new answer from the current invite link.'
  );
  const android = await load('android/app/src/main/assets/js/i18n.js');
  for (const tr of [translate, android.translate]) {
    assert.equal(
      tr('连不上信令服务器：ws://192.168.1.2:8080（服务器没开、满载，或者网络不通）', 'en'),
      'Cannot connect to signaling server: ws://192.168.1.2:8080 (the server is down or full, or the network is unreachable)'
    );
  }
  // 安卓把它接在「连接失败：」后面
  assert.equal(
    android.translate('连接失败：连不上信令服务器：ws://a:1（服务器没开、满载，或者网络不通）', 'en'),
    'Connection failed: Cannot connect to signaling server: ws://a:1 (the server is down or full, or the network is unreachable)'
  );
});

/* ================= B2-4：一对一应答码绑定邀请编号 ================= */

/** 把 encodeCode 的产物原样拆回 JSON，直接看紧凑数组的形状。 */
function rawPayload(code) {
  assert.match(code, /^NR3-[RG]/);
  const bytes = Buffer.from(code.slice(5).replace(/-/g, '+').replace(/\./g, '/'), 'base64');
  const json = code[4] === 'G' ? zlib.gunzipSync(bytes) : bytes;
  return JSON.parse(json.toString('utf8'));
}

function nr3(payload) {
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return `NR3-R${b64.replace(/\+/g, '-').replace(/\//g, '.').replace(/=+$/, '')}`;
}

const OFFER = { k: 'offer', from: 'host-peer', sdp: { type: 'offer', sdp: 'v=0\r\na=setup:actpass' }, maxMembers: 4, securityMode: 'safe' };
const ANSWER = { k: 'answer', from: 'guest-peer', sdp: { type: 'answer', sdp: 'v=0\r\na=setup:active' }, securityMode: 'safe' };

for (const { name, dir } of IMPLS) {
  test(`${name}：邀请编号跟在版本号后面，原有下标一个不挪；来回一趟原样带回`, async () => {
    const { encodeCode, decodeCode } = await import(dir + 'signaling.js');
    const offerCode = await encodeCode({ ...OFFER, invite: 'a1b2c3d4e5f6' });
    assert.deepEqual(rawPayload(offerCode), ['o', 'host-peer', OFFER.sdp.sdp, 4, 's', 2, 'a1b2c3d4e5f6']);
    const offer = await decodeCode(offerCode);
    assert.equal(offer.invite, 'a1b2c3d4e5f6');
    assert.equal(offer.protocolVersion, 2, '旧版本按下标取版本号：编号不能挤掉它');
    assert.equal(offer.securityMode, 'safe');

    const answerCode = await encodeCode({ ...ANSWER, invite: offer.invite });
    assert.deepEqual(rawPayload(answerCode), ['a', 'guest-peer', ANSWER.sdp.sdp, 's', 2, 'a1b2c3d4e5f6']);
    const answer = await decodeCode(answerCode);
    assert.equal(answer.invite, 'a1b2c3d4e5f6');
    assert.equal(answer.protocolVersion, 2);
  });

  test(`${name}：没有编号的码一个字节不多；旧码、乱填的编号一律当没有`, async () => {
    const { encodeCode, decodeCode } = await import(dir + 'signaling.js');
    assert.deepEqual(rawPayload(await encodeCode(ANSWER)), ['a', 'guest-peer', ANSWER.sdp.sdp, 's', 2]);
    assert.deepEqual(rawPayload(await encodeCode({ ...ANSWER, invite: '' })), ['a', 'guest-peer', ANSWER.sdp.sdp, 's', 2]);
    // 太长、带空白、不是字符串：不写进码里
    for (const invite of ['x'.repeat(33), 'a b', 42, { id: 1 }]) {
      assert.deepEqual(rawPayload(await encodeCode({ ...ANSWER, invite })), ['a', 'guest-peer', ANSWER.sdp.sdp, 's', 2]);
    }
    assert.equal((await decodeCode(await encodeCode(ANSWER))).invite, '');
    assert.equal((await decodeCode(nr3(['a', 'guest-peer', 'v=0', 's', 2, 'x'.repeat(200)]))).invite, '');
    assert.equal((await decodeCode(nr3(['a', 'guest-peer', 'v=0', 's', 2, ['nested']]))).invite, '');
    assert.equal((await decodeCode(nr3(['o', 'host-peer', 'v=0', 4, 's', 2]))).invite, '');
  });
}

function answerBox({ inviteId = 'cur001', visible = true } = {}) {
  // 邀请卡收起（hidden 类）、成员页签没开时节点还在文档里，只是没有布局框
  const status = { isConnected: true, textContent: '', getClientRects: () => (visible ? [{}] : []) };
  const calls = [];
  const peer = {
    peerId: 'pending-abc',
    manualInviteId: inviteId,
    acceptAnswer: async () => calls.push('acceptAnswer'),
  };
  const S = {
    pendingManualPeer: peer,
    peerId: 'host-peer',
    hostId: 'host-peer',
    roomSecurityMode: 'safe',
    swarm: {
      peers: new Map(),
      addPeer: (p) => calls.push(`addPeer:${p.peerId}`),
      removePeer: (id) => calls.push(`removePeer:${id}`),
    },
  };
  return { status, calls, peer, S };
}

async function acceptWith(box, answer, { roomEntered = true, raw = null } = {}) {
  const { encodeCode, decodeCode } = await load('src/renderer/lib/signaling.js');
  box.joinErr = { textContent: '' };
  const ctx = sandbox([fnSource('acceptManualAnswer'), fnSource('reportManualAnswer'), fnSource('inviteStatusVisible')], {
    S: box.S,
    $: (id) => (id === 'inv-status' ? box.status : id === 'join-err' ? box.joinErr : { textContent: '' }),
    decodeCode,
    PROTOCOL_VERSION: 2,
    normalizeSecurityMode: (m) => (m === 'trusted' ? 'trusted' : 'safe'),
    securityModeLabel: (m) => m,
    peerName: (n, fallback) => n || fallback,
    wirePeer: () => {},
    watchManualHandshake: () => box.calls.push('watch'),
    show: () => {},
    roomEntered,
    log: (m, kind) => box.calls.push(`log:${kind}:${m}`),
  });
  await ctx.acceptManualAnswer(raw ?? (await encodeCode(answer)));
}

const STALE_ANSWER = '这是上一条邀请的应答，和眼下这条邀请对不上，已忽略；当前的邀请链接照常有效。请让对方用当前这条邀请链接重新生成应答。';
const USED_INVITE = '这条邀请已经用过或已失效，请用当前这条邀请链接重新走一遍。';

test('上一条邀请的应答对不上号：直接拒掉，手上这条邀请原封不动', async () => {
  const box = answerBox();
  await acceptWith(box, { ...ANSWER, invite: 'old001' });
  assert.equal(box.status.textContent, STALE_ANSWER);
  assert.equal(box.S.pendingManualPeer, box.peer, '当前邀请被消耗了');
  // 人在房间里：卡片上写一份，日志里也记一份
  assert.deepEqual(box.calls, [`log:bad:${STALE_ANSWER}`], '对不上号的应答被套到了当前这条连接上');
});

test('E3-A：邀请卡收起时点开一条用过的应答链接，「已经用过或已失效」落进房间日志，不写进看不见的卡片', async () => {
  const box = answerBox({ visible: false });
  box.S.pendingManualPeer = null;
  await acceptWith(box, null, { raw: 'NR3-用过的应答' });
  assert.equal(box.status.textContent, '', '写进了收起的邀请卡');
  assert.deepEqual(box.calls, [`log:warn:${USED_INVITE}`]);
  assert.equal(box.joinErr.textContent, '');
});

test('E3-A：邀请卡收起后贴上一条对不上号的应答，原因也落进房间日志', async () => {
  const box = answerBox({ visible: false });
  await acceptWith(box, { ...ANSWER, invite: 'old001' });
  assert.equal(box.status.textContent, '');
  assert.deepEqual(box.calls, [`log:bad:${STALE_ANSWER}`]);
});

test('E3-A：还没进房、卡片也看不见时写在加入框下面；卡片看得见就写在卡片上', async () => {
  const hidden = answerBox({ visible: false });
  hidden.S.pendingManualPeer = null;
  await acceptWith(hidden, null, { raw: 'NR3-x', roomEntered: false });
  assert.equal(hidden.joinErr.textContent, USED_INVITE);
  assert.deepEqual(hidden.calls, []);

  const shown = answerBox({ visible: true });
  shown.S.pendingManualPeer = null;
  await acceptWith(shown, null, { raw: 'NR3-x', roomEntered: false });
  assert.equal(shown.status.textContent, USED_INVITE);
  assert.equal(shown.joinErr.textContent, '');
  assert.deepEqual(shown.calls, []);
});

test('E3-A：邀请卡看不看得见按布局框判断，不只看在不在文档里', () => {
  const ctx = sandbox([fnSource('inviteStatusVisible')], {});
  assert.equal(ctx.inviteStatusVisible(null), false);
  assert.equal(ctx.inviteStatusVisible({ isConnected: false, getClientRects: () => [{}] }), false, '游离节点');
  assert.equal(ctx.inviteStatusVisible({ isConnected: true, getClientRects: () => [] }), false, '在文档里但被 display:none 藏着');
  assert.equal(ctx.inviteStatusVisible({ isConnected: true, getClientRects: () => [{}] }), true);
});

test('对得上号的应答、旧版本（没有编号）的应答照常接', async () => {
  for (const invite of ['cur001', undefined]) {
    const box = answerBox();
    await acceptWith(box, { ...ANSWER, invite });
    assert.equal(box.S.pendingManualPeer, null);
    assert.deepEqual(box.calls, ['addPeer:guest-peer', 'watch', 'acceptAnswer']);
    assert.equal(box.status.textContent, '正在打洞并校验房间模式…');
  }
});

test('生成邀请时每条换一个编号写进邀请码；加入方原样写回应答码', async () => {
  const payloads = [];
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, { id, style: {}, textContent: '', value: '' });
    return els.get(id);
  };
  class Peer {
    constructor(opts) {
      Object.assign(this, opts);
    }
    async createOffer() {
      return { type: 'offer', sdp: 'v=0' };
    }
    close() {}
  }
  let n = 0;
  const S = { pendingManualPeer: null, peerId: 'host-peer', name: '房主', roomCapacity: 4, roomSecurityMode: 'safe' };
  const ctx = sandbox([fnSource('createManualInvite')], {
    S,
    Peer,
    crypto: { randomUUID: () => '12345678-aaaa-bbbb-cccc-dddddddddddd' },
    peerIce: () => ({ iceServers: [], iceTransportPolicy: 'all' }),
    randomId: () => `inv00${++n}`,
    encodeCode: async (p) => {
      payloads.push(p);
      return 'NR3-Rxx';
    },
    shareLink: () => 'https://example.invalid/#j/xx/',
    inviteMediaInfo: () => null,
    inviteGen: 0,
    $,
    make: (tag, opts = {}) => ({ tag, ...opts, style: {} }),
    replace: () => {},
    inviteStep: () => ({}),
    copyCode: () => {},
    acceptManualAnswer: () => {},
    setFinalInviteStep: () => {},
  });
  await ctx.createManualInvite({}, '', 0);
  const first = S.pendingManualPeer;
  await ctx.createManualInvite({}, '', 0);
  assert.equal(payloads[0].invite, 'inv001');
  assert.equal(payloads[1].invite, 'inv002');
  assert.equal(first.manualInviteId, 'inv001');
  assert.equal(S.pendingManualPeer.manualInviteId, 'inv002', '重新生成之后得换编号，旧应答才认得出来');

  // 加入方：应答码里原样带上邀请里的编号（joinViaManual 太大，这里只看它交给 encodeCode 的那一段）
  const join = fnSource('joinViaManual');
  assert.match(join, /k: 'answer',[\s\S]{0,300}invite: payload\.invite,/);
});

test('房间里点开一条应答链接：房主说「用过或已失效」，成员说「应该由发起方打开」，不再叫人先退房', async () => {
  // 房主那一支交给 acceptManualAnswer：手上没有待应答的邀请时，它说的就是「已经用过或已失效」，
  // 编号对不上也由它说「这是上一条邀请的应答」，不在这里另写一套判断
  for (const [role, expected] of [
    ['host', 'accept'],
    ['guest', '这是一个应答链接，应该由发起方打开。'],
  ]) {
    const logs = [];
    const ctx = sandbox([fnSource('routeInviteLink')], {
      S: { role, pendingManualPeer: null, leaving: false, hostId: 'h' },
      roomEntered: true,
      decodeCode: async () => ({ k: 'answer', from: 'guest-peer' }),
      acceptManualAnswer: async () => logs.push('accept'),
      log: (m) => logs.push(m),
      reportInviteError: (e) => logs.push(`error:${e.message}`),
    });
    assert.equal(await ctx.routeInviteLink('NR3-Rxx'), false);
    assert.deepEqual(logs, [expected]);
  }
});

/* ================= GG2-4：旧缓存根不挡开窗口 ================= */

test('deferExtraRoots：initialize 只收当前根，旧根上的残留留给 cleanupExtraRoots 在后台收', async (t) => {
  const { CacheManager } = require('../src/main/cacheManager');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'noxreel-defer-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const oldRoot = path.join(tmp, 'old');
  const newRoot = path.join(tmp, 'new');
  const leftover = path.join(oldRoot, 'trash-aaaaaaaaaaaa');
  const localLeftover = path.join(newRoot, 'trash-bbbbbbbbbbbb');
  await fsp.mkdir(leftover, { recursive: true });
  await fsp.mkdir(localLeftover, { recursive: true });

  const manager = new CacheManager({
    rootDir: newRoot,
    extraRoots: [oldRoot],
    deferExtraRoots: true,
    pid: 1,
    now: () => 1,
    hostname: () => 'h',
  });
  await manager.initialize();
  assert.equal(fs.existsSync(localLeftover), false, '当前根上的残留照旧启动时就收');
  assert.equal(fs.existsSync(leftover), true, '旧根不该在启动路上扫（它可能在离线的网盘上）');
  await manager.cleanupExtraRoots();
  assert.equal(fs.existsSync(leftover), false, '窗口出来之后要把旧根上的残留收掉');
});

test('main.js：建窗口放在 finally 里；配置的根用不了、退回默认时不再把它当旧根去扫', () => {
  const main = read('src/main/main.js');
  const ready = main.slice(main.indexOf('app.whenReady().then('));
  assert.match(ready, /\} finally \{\s*startupSettled = true;\s*ensureMainWindow\(\);\s*\}/);
  assert.match(ready, /try \{\s*await ensureCacheReady\(\);\s*\} catch/);
  assert.match(ready, /cache\.cleanupExtraRoots\(\)\.catch\(\(\) => \{\}\);/);
  const fn = main.slice(main.indexOf('async function ensureCacheReady('), main.indexOf('app.whenReady()'));
  assert.match(fn, /extraRoots: cacheKnownRoots\.filter\(\(root\) => pathKey\(root\) !== failedRoot\)/);
  assert.match(main, /new CacheManager\(\{ rootDir: cacheChoice\.root, extraRoots: cacheKnownRoots, deferExtraRoots: true \}\)/);
});

/* ================= X-1：缓存占用给稀疏文件的块数兜底 ================= */

test('dirBytes：块数和「已经写进去的字节数」取大的；没传兜底就照旧按块数', async (t) => {
  const { dirBytes } = require('../src/main/cacheManager');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'noxreel-dirbytes-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const small = path.join(dir, 'small.bin');
  const other = path.join(dir, 'other.bin');
  await fsp.writeFile(small, 'x');
  await fsp.writeFile(other, Buffer.alloc(8192, 1));
  const plainBytes = await dirBytes(dir);
  // 块数还没跟上（脏页没写回）的接收文件：按写进去的算
  const floored = await dirBytes(dir, { writtenBytesOf: (p) => (p === small ? 1024 * 1024 : 0) });
  const smallOnDisk = (await fsp.stat(small)).blocks * 512;
  assert.equal(floored, plainBytes - smallOnDisk + 1024 * 1024);
  // 兜底比块数小：照旧按块数（8KB 的文件至少占 8KB 的块；1 字节的小文件在 NTFS 上住在 MFT 里，块数是 0，别拿它比）
  assert.ok((await fsp.stat(other)).blocks * 512 >= 8192);
  assert.equal(await dirBytes(dir, { writtenBytesOf: (p) => (p === other ? 100 : 0) }), plainBytes);
});

test('缓存占用：正在接收的片按写进去的算，没写的空洞一个字节都不算', async (t) => {
  const store = require('../src/main/fileStore');
  const { CacheManager } = require('../src/main/cacheManager');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'noxreel-usage15-'));
  const manager = new CacheManager({ rootDir: path.join(tmp, 'cache') });
  await manager.initialize();
  store.configureCache(manager);
  store._testing.reset();
  t.after(async () => {
    await store.closeAll();
    await manager.cleanupRun();
    await fsp.rm(tmp, { recursive: true, force: true });
  });
  const CS = store.CHUNK_SIZE;
  const crypto = require('node:crypto');
  const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
  const head = Buffer.alloc(CS, 1);
  head.writeUInt32BE(0x1a45dfa3, 0); // 首片要带 Matroska 文件头
  const body = Buffer.alloc(CS, 2);
  const chunkCount = 64;
  const hashes = Array.from({ length: chunkCount }, (_, i) => (i === 0 ? sha(head) : sha(body)));
  const manifest = {
    fileId: sha(Buffer.from(hashes.join(''))).slice(0, 32),
    name: 'movie.mkv',
    size: chunkCount * CS,
    chunkSize: CS,
    chunkCount,
    hashes,
  };
  const state = await store.openLeech(manifest);
  await store.writeChunk(state.sessionId, 0, head);
  await store.writeChunk(state.sessionId, 1, body);
  await store.writeChunk(state.sessionId, chunkCount - 1, body);
  assert.equal(store.writtenBytesOf(state.filePath), 3 * CS);
  assert.equal(store.writtenBytesOf(path.join(tmp, 'nope.mkv')), 0);
  assert.equal(store.writtenBytesOf('relative/movie.mkv'), 0);

  const usage = await manager.usage({ writtenBytesOf: store.writtenBytesOf });
  assert.ok(usage.runBytes >= 3 * CS, `刚写进去的片没算上：${usage.runBytes}`);
  const sparse = (await fsp.stat(state.filePath)).blocks * 512 < manifest.size;
  if (sparse) assert.ok(usage.runBytes < 8 * CS, `没写的空洞也算进去了：${usage.runBytes}`);

  // 会话关了就不再兜底（没收完的新文件本来就删了）
  await store.close(state.sessionId);
  assert.equal(store.writtenBytesOf(state.filePath), 0);
});

/* ================= GG2-7：启动器按关键包判断依赖 ================= */

test('启动器：按关键包判断依赖装全了没有，信令启动器查 npm 的退出码；死代码分支去掉；仍是 UTF-8 带 BOM', () => {
  for (const name of ['launch.ps1', 'launch-signal.ps1']) {
    const bytes = fs.readFileSync(path.join(root, 'scripts', name));
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${name} 丢了 BOM，Windows PowerShell 5.1 会按 ANSI 读`);
  }
  const signal = read('scripts/launch-signal.ps1');
  assert.match(signal, /node_modules\\ws\\package\.json/);
  assert.match(signal, /& npm install --no-audit --no-fund\s*\n\s*if \(\$LASTEXITCODE -ne 0 -or -not \(Test-Path \$wsPackage\)\) \{[\s\S]*?exit 1/);
  assert.doesNotMatch(signal, /Test-Path \(Join-Path \$root 'node_modules'\)\)/, '只看目录在不在：残缺的 node_modules 会让它永远跳过安装');

  const client = read('scripts/launch.ps1');
  assert.match(client, /node_modules\\electron\\package\.json/);
  assert.doesNotMatch(client, /Test-Path \(Join-Path \$root 'node_modules'\)\)/);
  // electron.exe 是 GUI 程序，PowerShell 不等它退出：这之后的 $LASTEXITCODE 不是它的
  const after = client.slice(client.indexOf('& $electronExe . @args'));
  assert.doesNotMatch(after, /\$LASTEXITCODE/);
});
