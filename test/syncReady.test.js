'use strict';

// 同步引擎的就绪（READY）契约：播放列表自动连播要等全员准备好。
// 规则和卡顿（STALL）同构：带 seq、按发送者单调编号、房主转发、掉线由房主撤销、
// 新人入房时补发。任何一条松动，表现都是：自动连播永远等不齐，或者没等齐就往下放。
const test = require('node:test');
const assert = require('node:assert/strict');
const { IMPLS } = require('./helpers/impls');

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

/**
 * 带假时钟和事件记录的引擎。
 * admins / guests 直接灌进角色表（等同于收到了房主的 ROLE）；给了 seq 就先按列表重置到那一部。
 */
async function makeEngine(dir, { peerId = 'me', hostId = 'host', admins = [], guests = [], seq } = {}) {
  const { SyncEngine } = await import(dir + 'syncEngine.js');
  const eng = new SyncEngine({ peerId, name: peerId, isSeeder: peerId === hostId, hostId });
  const clock = { t: 1000 };
  eng.now = () => clock.t;
  const rec = { outbound: [], relay: [], readies: [] };
  eng.on('outbound', (m) => rec.outbound.push(m));
  eng.on('relay', (e) => rec.relay.push(e));
  eng.on('ready-change', (e) => rec.readies.push(e));
  eng.onSeek = () => {};
  eng.onSetPause = () => {};
  eng.started = true;
  eng.applyRoles([...admins.map((id) => [id, 'admin']), ...guests.map((id) => [id, 'guest'])], hostId);
  if (seq !== undefined) eng.resetMedia({ seq });
  const clear = () => {
    for (const list of Object.values(rec)) list.length = 0;
  };
  clear();
  return { eng, clock, clear, ...rec };
}

/** P2P 连接上的对端：peerId 由通道担保，引擎只认这个。 */
const P = (peerId, name = peerId) => ({ peerId, name });

/** greet 用的对端：记下发给他的每一条消息（ctrl 通道有序，顺序就是契约）。 */
function greetPeer(peerId) {
  return {
    peerId,
    name: peerId,
    sent: [],
    send(m) {
      this.sent.push(m);
      return true;
    },
  };
}

const ready = (over) => ({ t: 'ready', ready: true, seq: 0, readySeq: 1, ...over });
const sync = (over) => ({ t: 'sync', paused: false, position: 10, lamport: 5, seq: 0, ...over });
const stall = (over) => ({ t: 'stall', stalled: true, position: 0, deficitSeconds: 0, seq: 0, stallSeq: 1, ...over });

/** 就绪表转成普通对象，方便整体比较。 */
const table = (eng) => Object.fromEntries([...eng.readyPeers].map(([id, v]) => [id, { ...v }]));

/* ------------------------------ 1. 本机就绪 ------------------------------ */

impl('setLocalReady 只在变化时发，游客也发，带当前 seq 和递增的 readySeq', async (dir) => {
  const { eng, outbound, readies, clear } = await makeEngine(dir, { peerId: 'me', guests: ['me'], seq: 2 });
  assert.equal(eng.canIControl(), false, '前提：本机是游客');
  assert.equal(eng.localReady, null, '这一部还没报过');

  // 换片后的第一次一定要发，哪怕是「没准备好」：别人得知道房间里还有人在等
  assert.equal(eng.setLocalReady(false), true);
  assert.deepEqual(outbound, [{ t: 'ready', seq: 2, ready: false, peerId: 'me', name: 'me', readySeq: 1 }]);
  assert.deepEqual(readies, [{ who: 'me', name: 'me', ready: false, self: true }]);
  clear();

  assert.equal(eng.setLocalReady(false), false, '没变化不该发');
  assert.equal(outbound.length, 0);
  assert.equal(readies.length, 0);

  assert.equal(eng.setLocalReady(true), true);
  assert.equal(eng.localReady, true);
  assert.deepEqual(outbound, [{ t: 'ready', seq: 2, ready: true, peerId: 'me', name: 'me', readySeq: 2 }]);
  assert.deepEqual(readies, [{ who: 'me', name: 'me', ready: true, self: true }]);

  // 真值也按布尔处理：已经是 true，再报一次 1 不算变化
  assert.equal(eng.setLocalReady(1), false);
  assert.equal(outbound.length, 1);

  assert.equal(eng.setLocalReady(0), true);
  assert.equal(eng.localReady, false);
  assert.equal(outbound.length, 2);
  assert.equal(outbound[1].ready, false, '要转成布尔，不能把 0 原样发出去');
  assert.equal(outbound[1].readySeq, 3);
  assert.equal(outbound[1].seq, 2);
  assert.deepEqual(readies[1], { who: 'me', name: 'me', ready: false, self: true });

  eng.setLocalReady('yes');
  assert.equal(outbound[2].ready, true);
  assert.equal(outbound[2].readySeq, 4);
  assert.deepEqual(eng.readySnapshot(), { self: true, peers: [] });
  // 就绪不是控制指令，不能顺带动房间状态
  assert.equal(outbound.filter((m) => m.t !== 'ready').length, 0);
});

/* ------------------------------ 2. 远端就绪与 seq ------------------------------ */

impl('远端 READY 同 seq 生效，游客的也算；畸形消息丢弃且不占编号', async (dir) => {
  const { eng, readies, relay } = await makeEngine(dir, { admins: ['adm'], guests: ['gst'], seq: 2 });
  const bad = [
    ready({ seq: 2, readySeq: 9, ready: 'yes' }),
    ready({ seq: 2, readySeq: 9, ready: 1 }),
    (({ readySeq: _a, ...m }) => m)(ready({ seq: 2 })),
    (({ seq: _b, ...m }) => m)(ready({ readySeq: 9 })),
    ready({ seq: 2, readySeq: -1 }),
    ready({ seq: 2, readySeq: 1.5 }),
    ready({ seq: 2, readySeq: '9' }),
    ready({ seq: -1, readySeq: 9 }),
    ready({ seq: '2', readySeq: 9 }),
    ready({ seq: 2.5, readySeq: 9 }),
  ];
  for (const m of bad) assert.equal(eng.onCtrl(m, P('gst')), true, 'READY 由引擎处理（哪怕是丢弃）');
  eng.onCtrl(ready({ seq: 2, readySeq: 9 }), {}); // 没有连接身份
  assert.equal(eng.readyPeers.size, 0);
  assert.equal(readies.length, 0);

  // 编号 0 合法（房主替人补发时没见过编号就用 0）；前面编号更大的非法消息没把它挡住
  assert.equal(eng.onCtrl(ready({ seq: 2, readySeq: 0, name: '游客甲' }), P('gst')), true);
  assert.deepEqual(table(eng), { gst: { name: '游客甲', ready: true } });
  assert.deepEqual(readies, [{ who: 'gst', name: '游客甲', ready: true, self: false }]);

  // 没带 name 时用连接上的名字
  eng.onCtrl(ready({ seq: 2, readySeq: 1, ready: false }), P('adm', '管理员乙'));
  assert.deepEqual(table(eng), {
    gst: { name: '游客甲', ready: true },
    adm: { name: '管理员乙', ready: false },
  });
  assert.deepEqual(eng.readySnapshot(), {
    self: false,
    peers: [
      { peerId: 'gst', name: '游客甲', ready: true },
      { peerId: 'adm', name: '管理员乙', ready: false },
    ],
  });
  assert.equal(relay.length, 0, '非房主不转发');
});

impl('上一部的 READY 丢弃，也不占编号', async (dir) => {
  const { eng, readies } = await makeEngine(dir, { seq: 2 });
  eng.onCtrl(ready({ seq: 1, readySeq: 10 }), P('gst'));
  assert.equal(eng.readyPeers.size, 0, '上一部的就绪不能算在这一部头上');
  assert.equal(readies.length, 0);
  assert.equal(eng._stash.size, 0, '旧 seq 不该暂存');

  eng.onCtrl(ready({ seq: 2, readySeq: 5 }), P('gst'));
  assert.deepEqual(table(eng), { gst: { name: 'gst', ready: true } }, '被丢弃的旧消息把编号占到了 10');
});

impl('下一部的 READY 先暂存，resetMedia 到该 seq 后在清空之后重放；同一人只留编号最大的', async (dir) => {
  const { eng, readies, clear } = await makeEngine(dir, { seq: 2 });
  eng.onCtrl(ready({ seq: 2, readySeq: 1, ready: true }), P('a'));
  eng.onCtrl(ready({ seq: 2, readySeq: 1, ready: true }), P('c'));
  clear();

  // a 的三条乱序到达：2、3、1。留下的必须是 3 号，而不是最先到或最后到的
  eng.onCtrl(ready({ seq: 3, readySeq: 2, ready: false }), P('a'));
  eng.onCtrl(ready({ seq: 3, readySeq: 3, ready: true, name: '甲' }), P('a'));
  eng.onCtrl(ready({ seq: 3, readySeq: 1, ready: false }), P('a'));
  eng.onCtrl(ready({ seq: 3, readySeq: 4, ready: true }), P('b'));
  eng.onCtrl(ready({ seq: 4, readySeq: 9, ready: true }), P('d'));
  assert.equal(readies.length, 0, '下一部的就绪不能提前生效');
  assert.deepEqual(table(eng), { a: { name: 'a', ready: true }, c: { name: 'c', ready: true } });

  eng.resetMedia({ seq: 3 });
  // 先报 reset，再报重放出来的；c 没报这一部，不能残留在表里
  assert.deepEqual(readies[0], { reset: true });
  assert.deepEqual(readies.slice(1).map((e) => [e.who, e.ready]).sort(), [
    ['a', true],
    ['b', true],
  ]);
  assert.deepEqual(table(eng), { a: { name: '甲', ready: true }, b: { name: 'b', ready: true } });
  assert.equal(eng._stash.size, 1, 'seq 4 的要留着');

  // 重放时记下了编号：a 的 2 号再来一次也不能盖掉 3 号
  eng.onCtrl(ready({ seq: 3, readySeq: 2, ready: false }), P('a'));
  assert.equal(eng.readyPeers.get('a').ready, true);

  eng.resetMedia({ seq: 4 });
  assert.deepEqual(table(eng), { d: { name: 'd', ready: true } });
  assert.equal(eng._stash.size, 0);
});

impl('同一发送者的 READY 只采信编号更大的：旧的晚到、编号相同都不行', async (dir) => {
  const { eng, readies } = await makeEngine(dir, { guests: ['gst'] });
  // 房主转发的 2 号「好了」先到，直连的 1 号「没好」晚到
  eng.onCtrl(ready({ readySeq: 2, ready: true, origin: 'gst', originName: '甲' }), P('host'));
  eng.onCtrl(ready({ readySeq: 1, ready: false }), P('gst'));
  assert.equal(eng.readyPeers.get('gst').ready, true, '旧的「没好」盖掉了新的「好了」');
  eng.onCtrl(ready({ readySeq: 2, ready: false }), P('gst'));
  assert.equal(eng.readyPeers.get('gst').ready, true, '编号相同的不该采信');
  assert.equal(readies.length, 1);
  eng.onCtrl(ready({ readySeq: 3, ready: false }), P('gst'));
  assert.equal(eng.readyPeers.get('gst').ready, false);
  assert.equal(readies.length, 2);
  assert.deepEqual(readies[1], { who: 'gst', name: 'gst', ready: false, self: false });
});

/* ------------------------------ 3. 转发与身份 ------------------------------ */

impl('房主采信后转发，带上 origin 和 originName，跳过发送者；游客的也转发', async (dir) => {
  const h = await makeEngine(dir, { peerId: 'host', admins: ['adm'], guests: ['gst'], seq: 1 });
  const m = ready({ seq: 1, readySeq: 1, peerId: 'gst', name: '游客甲' });
  h.eng.onCtrl(m, P('gst'));
  assert.deepEqual(h.relay, [{ msg: { ...m, origin: 'gst', originName: '游客甲' }, except: 'gst' }]);

  // 重复的、上一部的、下一部的（暂存中）都不转发
  h.eng.onCtrl(m, P('gst'));
  h.eng.onCtrl(ready({ seq: 0, readySeq: 5 }), P('gst'));
  h.eng.onCtrl(ready({ seq: 2, readySeq: 6 }), P('gst'));
  assert.equal(h.relay.length, 1);

  // 成员自填的 origin 被连接身份覆盖，名字截断到 40
  h.eng.onCtrl(ready({ seq: 1, readySeq: 1, name: 'y'.repeat(100), origin: 'gst', originName: '冒名' }), P('adm'));
  assert.equal(h.relay.length, 2);
  assert.equal(h.relay[1].msg.origin, 'adm');
  assert.equal(h.relay[1].msg.originName, 'y'.repeat(40));
  assert.equal(h.relay[1].except, 'adm');
  assert.deepEqual(h.eng.readyPeers.get('adm'), { name: 'y'.repeat(40), ready: true });
  assert.equal(h.eng.readyPeers.get('gst').name, '游客甲', '冒名的消息不能动到 gst 的记录');

  // 收端（星型下的其他成员）按原发送者记
  const n = await makeEngine(dir, { peerId: 'nw', admins: ['adm'], guests: ['gst'], seq: 1 });
  n.eng.onCtrl(h.relay[0].msg, P('host', '房主'));
  assert.deepEqual(table(n.eng), { gst: { name: '游客甲', ready: true } });
  assert.deepEqual(n.readies, [{ who: 'gst', name: '游客甲', ready: true, self: false }]);
  assert.equal(n.relay.length, 0, '非房主不转发');
});

impl('收端只对房主连接采信 origin：普通成员自称转发按他本人算', async (dir) => {
  const { eng, readies } = await makeEngine(dir, { admins: ['adm'], guests: ['gst'], seq: 1 });
  eng.onCtrl(ready({ seq: 1, readySeq: 1, origin: 'adm', originName: '甲' }), P('gst', '乙'));
  assert.deepEqual(table(eng), { gst: { name: '乙', ready: true } }, '冒充别人的就绪被记到了别人名下');
  assert.equal(readies[0].who, 'gst');

  // 房主转发的：记在原发送者名下；没给 originName 时退回原发送者的 id
  eng.onCtrl(ready({ seq: 1, readySeq: 1, ready: false, origin: 'adm', originName: '甲' }), P('host', '房主'));
  eng.onCtrl(ready({ seq: 1, readySeq: 1, origin: 'x' }), P('host', '房主'));
  assert.deepEqual(eng.readyPeers.get('adm'), { name: '甲', ready: false });
  assert.deepEqual(eng.readyPeers.get('x'), { name: 'x', ready: true });

  // origin 为空串或等于房主自己：就是房主本人的
  eng.onCtrl(ready({ seq: 1, readySeq: 1, origin: '', name: '房主' }), P('host'));
  assert.deepEqual(eng.readyPeers.get('host'), { name: '房主', ready: true });
  eng.onCtrl(ready({ seq: 1, readySeq: 2, ready: false, origin: 'host' }), P('host', '房主'));
  assert.equal(eng.readyPeers.get('host').ready, false);

  // 转发回来的自己的消息丢弃
  const before = readies.length;
  eng.onCtrl(ready({ seq: 1, readySeq: 7, origin: 'me', originName: '我' }), P('host'));
  eng.onCtrl(ready({ seq: 1, readySeq: 8 }), P('me'));
  assert.equal(eng.readyPeers.has('me'), false);
  assert.equal(readies.length, before);
});

/* ------------------------------ 4. 有人掉线 ------------------------------ */

impl('房主 peerGone 替掉线的人广播 release，收端删除；编号相同也认', async (dir) => {
  const h = await makeEngine(dir, { peerId: 'host', guests: ['gst', 'me'], seq: 1 });
  const m = await makeEngine(dir, { peerId: 'me', guests: ['gst', 'me'], seq: 1 });
  h.eng.onCtrl(ready({ seq: 1, readySeq: 3, name: '甲' }), P('gst', '甲'));
  m.eng.onCtrl(h.relay.at(-1).msg, P('host'));
  assert.deepEqual(table(m.eng), { gst: { name: '甲', ready: true } });

  h.clear();
  h.eng.peerGone('gst');
  assert.equal(h.eng.readyPeers.size, 0);
  assert.deepEqual(h.relay, [
    {
      msg: { t: 'ready', ready: false, release: true, origin: 'gst', originName: '甲', seq: 1, readySeq: 3 },
      except: null,
    },
  ]);
  assert.deepEqual(h.readies, [{ who: 'gst', ready: false, gone: true, self: false }]);
  assert.equal(h.outbound.length, 0, 'release 走 relay（发给所有人），不走 outbound');

  m.clear();
  m.eng.onCtrl(h.relay[0].msg, P('host'));
  assert.equal(m.eng.readyPeers.size, 0, '那个人不会再发更新的编号了，release 不能按编号拦');
  assert.deepEqual(m.readies, [{ who: 'gst', name: '甲', ready: false, gone: true, self: false }]);

  // 已经不在表里：什么都不发生
  m.eng.onCtrl(h.relay[0].msg, P('host'));
  assert.equal(m.readies.length, 1);

  // 掉线的人重连后用新编号报上来，照样认
  m.eng.onCtrl(ready({ seq: 1, readySeq: 4 }), P('gst'));
  assert.equal(m.eng.readyPeers.get('gst').ready, true);
});

impl('release 只认房主连接，只能撤销、不能置为就绪，对不在表里的人无效', async (dir) => {
  const { eng, readies, clear } = await makeEngine(dir, { guests: ['gst', 'g2'], seq: 1 });
  eng.onCtrl(ready({ seq: 1, readySeq: 4, origin: 'gst', originName: '甲' }), P('host'));
  clear();
  const release = { t: 'ready', ready: false, release: true, origin: 'gst', originName: '甲', seq: 1, readySeq: 4 };

  // 普通成员转来的 release：按他本人的普通就绪消息处理
  eng.onCtrl({ ...release, readySeq: 1 }, P('g2'));
  assert.equal(eng.readyPeers.get('gst').ready, true, '普通成员替别人撤销了就绪');
  assert.deepEqual(eng.readyPeers.get('g2'), { name: 'g2', ready: false });
  assert.equal(readies.filter((e) => e.gone).length, 0);

  // 本人直连的 release 不享受「不看编号」：编号没变大就不认
  eng.onCtrl({ t: 'ready', ready: false, release: true, seq: 1, readySeq: 4 }, P('gst'));
  assert.equal(eng.readyPeers.get('gst').ready, true, '直连的 release 绕过了编号检查');

  // ready:true 的 release 整条不认：既不删人，也不能把人加进表
  eng.onCtrl({ ...release, ready: true }, P('host'));
  eng.onCtrl({ ...release, ready: true, origin: 'x' }, P('host'));
  assert.equal(eng.readyPeers.get('gst').ready, true);
  assert.equal(eng.readyPeers.has('x'), false);

  // 表里没有的人：什么都不发生，也不占他的编号
  const before = readies.length;
  eng.onCtrl({ ...release, origin: 'y', readySeq: 50 }, P('host'));
  assert.equal(readies.length, before);
  assert.equal(eng.readyPeers.has('y'), false);
  eng.onCtrl(ready({ seq: 1, readySeq: 1 }), P('y'));
  assert.equal(eng.readyPeers.get('y').ready, true);
});

impl('非房主 peerGone 只清本地不转发；表里没有的人掉线不发 release；暂存一并清掉', async (dir) => {
  const m = await makeEngine(dir, { guests: ['gst'], seq: 1 });
  m.eng.onCtrl(ready({ seq: 1, readySeq: 1 }), P('gst'));
  m.clear();
  m.eng.peerGone('gst');
  assert.equal(m.eng.readyPeers.size, 0);
  assert.equal(m.relay.length, 0);
  assert.deepEqual(m.readies, [{ who: 'gst', ready: false, gone: true, self: false }]);

  const h = await makeEngine(dir, { peerId: 'host', admins: ['adm'], seq: 1 });
  h.eng.onCtrl(ready({ seq: 2, readySeq: 1 }), P('adm')); // 只在暂存里
  h.eng.onCtrl(ready({ seq: 2, readySeq: 1 }), P('adm2'));
  h.eng.peerGone('adm');
  h.eng.peerGone('stranger');
  assert.equal(h.relay.length, 0);
  assert.equal(h.readies.length, 0);
  h.eng.resetMedia({ seq: 2 });
  assert.deepEqual([...h.eng.readyPeers.keys()], ['adm2'], '已经离开的人的就绪不能在换片后冒出来');
});

impl('掉线的人同时卡着又报过就绪：两件事都处理，各发一条 release', async (dir) => {
  const h = await makeEngine(dir, { peerId: 'host', admins: ['adm'], seq: 1 });
  h.eng.onCtrl(stall({ seq: 1, stallSeq: 2, name: '甲' }), P('adm'));
  h.eng.onCtrl(ready({ seq: 1, readySeq: 5, ready: false, name: '甲' }), P('adm'));
  h.clear();
  h.eng.peerGone('adm');
  assert.equal(h.eng.stalledPeers.size, 0);
  assert.equal(h.eng.readyPeers.size, 0);
  assert.deepEqual(
    h.relay.map((e) => [e.msg.t, e.msg.release, e.msg.origin, e.msg.stallSeq ?? e.msg.readySeq]),
    [
      ['stall', true, 'adm', 2],
      ['ready', true, 'adm', 5],
    ]
  );
  assert.equal(h.relay[1].msg.ready, false);
  assert.equal(h.relay[1].msg.originName, '甲');
});

/* ------------------------------ 5. 新人入房 ------------------------------ */

impl('房主 greet：ROLE → 列表 → SYNC → 卡顿 → 其他人的 READY → 自己的 READY', async (dir) => {
  const h = await makeEngine(dir, { peerId: 'host', admins: ['adm'], guests: ['gst', 'nw'], seq: 1 });
  h.eng.setLocalReady(true);
  h.eng.onCtrl(stall({ seq: 1, stallSeq: 1, name: '甲' }), P('adm'));
  h.eng.onCtrl(ready({ seq: 1, readySeq: 4, name: '甲' }), P('adm'));
  h.eng.onCtrl(ready({ seq: 1, readySeq: 2, ready: false, name: '乙' }), P('gst'));
  // nw 断线前报过就绪，旧连接还没清理就重连了
  h.eng.onCtrl(ready({ seq: 1, readySeq: 7, name: '新' }), P('nw'));

  const peer = greetPeer('nw');
  h.eng.greet(peer, { beforeSync: () => peer.sent.push({ t: 'playlist' }) });
  assert.deepEqual(
    peer.sent.map((m) => m.t),
    ['role', 'playlist', 'sync', 'stall', 'ready', 'ready', 'ready']
  );
  const readiesSent = peer.sent.filter((m) => m.t === 'ready');
  assert.deepEqual(readiesSent.slice(0, 2), [
    { t: 'ready', seq: 1, ready: true, origin: 'adm', originName: '甲', readySeq: 4 },
    { t: 'ready', seq: 1, ready: false, origin: 'gst', originName: '乙', readySeq: 2 },
  ]);
  assert.equal(readiesSent.some((m) => m.origin === 'nw'), false, '把新人自己的就绪发回给他了');
  assert.deepEqual(readiesSent[2], { t: 'ready', seq: 1, ready: true, peerId: 'host', name: 'host', readySeq: 2 });

  // 每次 greet 自己的都用新编号：对方断线前可能已经见过上一条
  const again = greetPeer('nw');
  h.eng.greet(again);
  assert.equal(again.sent.at(-1).readySeq, 3);

  // 新人按序收下：列表先应用，就绪表随即齐全
  const n = await makeEngine(dir, { peerId: 'nw', hostId: 'host' });
  n.eng.resetMedia({ seq: 1 });
  for (const m of peer.sent) if (m.t !== 'playlist') n.eng.onCtrl(m, P('host'));
  assert.deepEqual(table(n.eng), {
    adm: { name: '甲', ready: true },
    gst: { name: '乙', ready: false },
    host: { name: 'host', ready: true },
  });
});

impl('新人先收到 READY 再收到列表：暂存，列表应用后全部生效（按原发送者分开存）', async (dir) => {
  const h = await makeEngine(dir, { peerId: 'host', guests: ['gst', 'g2'], seq: 3 });
  h.eng.onCtrl(ready({ seq: 3, readySeq: 1 }), P('gst'));
  h.eng.onCtrl(ready({ seq: 3, readySeq: 1, ready: false }), P('g2'));
  const peer = greetPeer('nw');
  h.eng.greet(peer, { beforeSync: () => peer.sent.push({ t: 'playlist', seq: 3 }) });

  const n = await makeEngine(dir, { peerId: 'nw', hostId: 'host' });
  for (const m of peer.sent) if (m.t !== 'playlist') n.eng.onCtrl(m, P('host'));
  assert.equal(n.eng.readyPeers.size, 0, 'seq=3 的就绪不能记在 seq=0 上');
  n.eng.resetMedia({ seq: 3 });
  assert.deepEqual(table(n.eng), {
    gst: { name: 'gst', ready: true },
    g2: { name: 'g2', ready: false },
    host: { name: 'host', ready: false },
  });
});

impl('非房主 greet 只发 SYNC（卡着的控制者加 STALL）和自己的 READY，未就绪也发', async (dir) => {
  const g = await makeEngine(dir, { peerId: 'gst', guests: ['gst', 'g2'], seq: 1 });
  g.eng.onCtrl(ready({ seq: 1, readySeq: 1 }), P('g2'));
  const gp = greetPeer('x');
  g.eng.greet(gp);
  assert.deepEqual(gp.sent.map((m) => m.t), ['sync', 'ready'], '非房主不替别人补发');
  assert.deepEqual(gp.sent[1], { t: 'ready', seq: 1, ready: false, peerId: 'gst', name: 'gst', readySeq: 1 });

  const a = await makeEngine(dir, { peerId: 'adm', admins: ['adm'], seq: 1 });
  a.eng.onBufferProgress({ contiguousBytes: 0, complete: false });
  assert.equal(a.eng.localStalled, true);
  a.eng.setLocalReady(true);
  const ap = greetPeer('x');
  a.eng.greet(ap);
  assert.deepEqual(ap.sent.map((m) => m.t), ['sync', 'stall', 'ready']);
  assert.equal(ap.sent[2].ready, true);
  assert.equal(ap.sent[2].readySeq, 2);

  // 对端断线前见过 1 号，重连后照样认新的这条
  const m = await makeEngine(dir, { peerId: 'me', admins: ['adm'], seq: 1 });
  m.eng.onCtrl(a.outbound.find((x) => x.t === 'ready'), P('adm'));
  m.eng.peerGone('adm');
  for (const x of ap.sent) m.eng.onCtrl(x, P('adm'));
  assert.deepEqual(table(m.eng), { adm: { name: 'adm', ready: true } });
});

/* ------------------------------ 6. 换片 ------------------------------ */

impl('resetMedia 清空就绪表和本机就绪并发 reset 事件，编号不清', async (dir) => {
  const { eng, outbound, readies, clear } = await makeEngine(dir, { guests: ['a'], seq: 1 });
  eng.setLocalReady(true);
  eng.onCtrl(ready({ seq: 1, readySeq: 5 }), P('a'));
  clear();

  eng.resetMedia({ seq: 2 });
  assert.equal(eng.readyPeers.size, 0);
  assert.equal(eng.localReady, null, '换片后回到「还没报过」');
  assert.deepEqual(readies, [{ reset: true }]);
  assert.equal(outbound.length, 0, '换片时静默复位，不发 READY');
  assert.deepEqual(eng.readySnapshot(), { self: false, peers: [] });

  // 本机编号接着往上走；换片后第一次报「没准备好」也要发
  assert.equal(eng.setLocalReady(false), true);
  assert.equal(eng.setLocalReady(false), false);
  eng.setLocalReady(true);
  assert.deepEqual(outbound, [
    { t: 'ready', seq: 2, ready: false, peerId: 'me', name: 'me', readySeq: 2 },
    { t: 'ready', seq: 2, ready: true, peerId: 'me', name: 'me', readySeq: 3 },
  ]);

  // 见过的编号也还记着：同一发送者编号全局单调，不大于 5 的一律是旧的
  eng.onCtrl(ready({ seq: 2, readySeq: 5 }), P('a'));
  assert.equal(eng.readyPeers.size, 0);
  eng.onCtrl(ready({ seq: 2, readySeq: 6, ready: false }), P('a'));
  assert.deepEqual(table(eng), { a: { name: 'a', ready: false } });
});

/* ------------------------------ 7. 不封顶的房间位置 ------------------------------ */

impl('sharedPositionNow(false) 超过片长不封顶，默认封顶', async (dir) => {
  const { eng, clock } = await makeEngine(dir, { seq: 0 });
  eng.setMediaInfo({ duration: 100, size: 1000 });
  eng.onCtrl(sync({ position: 90, paused: false }), P('host'));
  clock.t += 60000;
  assert.equal(eng.sharedPositionNow(), 100);
  assert.equal(eng.sharedPositionNow(true), 100);
  assert.ok(Math.abs(eng.sharedPositionNow(false) - 150) < 0.01, `不封顶应为 150，实际 ${eng.sharedPositionNow(false)}`);

  // 暂停后照样不走
  eng.onCtrl(sync({ position: 130, paused: true, lamport: 6 }), P('host'));
  clock.t += 60000;
  assert.equal(eng.sharedPositionNow(false), 130);
  assert.equal(eng.sharedPositionNow(), 100);

  // 不封顶也不能是负数
  eng.duration = 0;
  eng._clock = { base: -5, at: clock.t, running: false };
  assert.equal(eng.sharedPositionNow(false), 0);
});
