'use strict';

// 同步引擎 v2（0.7 播放列表）的 seq / stallSeq / 房主转发契约。
// 这些规则决定了「换片那一刻」和「星型拓扑」下全房能不能收敛到同一个状态，
// 任何一条松动，表现都是：有人停在上一部、有人被拉回片头、或者全员永远暂停。
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
  const rec = { outbound: [], relay: [], remote: [], playing: [], stalls: [] };
  eng.on('outbound', (m) => rec.outbound.push(m));
  eng.on('relay', (e) => rec.relay.push(e));
  eng.on('remote-action', (e) => rec.remote.push(e));
  eng.on('playing', (e) => rec.playing.push(e));
  eng.on('stall-change', (e) => rec.stalls.push(e));
  eng.onSeek = () => {};
  eng.onSetPause = () => {};
  eng.started = true;
  eng.applyRoles([...admins.map((id) => [id, 'admin']), ...guests.map((id) => [id, 'guest'])], hostId);
  if (seq !== undefined) eng.resetMedia({ seq });
  for (const list of Object.values(rec)) list.length = 0;
  return { eng, clock, ...rec };
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

const sync = (over) => ({ t: 'sync', paused: false, position: 10, lamport: 5, seq: 0, ...over });
const stall = (over) => ({ t: 'stall', stalled: true, position: 0, deficitSeconds: 0, seq: 0, stallSeq: 1, ...over });

const near = (a, b) => Math.abs(a - b) < 0.01;

/* ------------------------------ 1. 旧 seq 与时钟 ------------------------------ */

impl('seq 比本地旧的 SYNC 丢掉，但时钟照样推高，之后发的指令排在它后面', async (dir) => {
  const { eng, remote, outbound } = await makeEngine(dir, { admins: ['me', 'adm'], seq: 5 });
  eng.onCtrl(sync({ seq: 4, lamport: 100, position: 50 }), P('host'));
  // 上一部片的指令不能作用在这一部上
  assert.equal(eng.shared.position, 0);
  assert.equal(eng.shared.lamport, -1);
  assert.equal(eng.intendedPaused, true);
  assert.equal(remote.length, 0);
  // 但 Lamport 必须记下：别人已经见过 100，我下一条要是比它小，会在他那里被判成旧的
  assert.equal(eng.clock, 100);
  eng.userSeek(3);
  const out = outbound.filter((m) => m.t === 'sync');
  assert.equal(out.length, 1);
  assert.equal(out[0].lamport, 101);
  assert.equal(out[0].seq, 5);
});

impl('非控制者或不合法的 SYNC 不推高时钟，也不生效', async (dir) => {
  const { eng, remote } = await makeEngine(dir, { admins: ['adm'], guests: ['gst'], seq: 5 });
  eng.onCtrl(sync({ seq: 5, lamport: 7 }), P('adm'));
  assert.equal(eng.clock, 7);
  assert.equal(remote.length, 1);
  const before = { ...eng.shared };

  // 游客、陌生人、借房主之口冒充游客的都不算数。时钟要是被他们推高，
  // 一个游客就能把全房的 Lamport 顶到 MAX_SAFE_INTEGER 附近，之后谁都发不出更新的指令。
  eng.onCtrl(sync({ seq: 5, lamport: 999 }), P('gst'));
  eng.onCtrl(sync({ seq: 5, lamport: 999 }), P('stranger'));
  eng.onCtrl(sync({ seq: 5, lamport: 999, origin: 'gst', originName: 'g' }), P('host'));
  // 控制者发来的畸形消息：seq 缺失 / 负数 / 小数 / 字符串，lamport 为负
  const { seq: _omit, ...noSeq } = sync({ lamport: 999 });
  eng.onCtrl(noSeq, P('adm'));
  eng.onCtrl(sync({ seq: -1, lamport: 999 }), P('adm'));
  eng.onCtrl(sync({ seq: 5.5, lamport: 999 }), P('adm'));
  eng.onCtrl(sync({ seq: '5', lamport: 999 }), P('adm'));
  eng.onCtrl(sync({ seq: 5, lamport: -3 }), P('adm'));

  assert.equal(eng.clock, 7);
  assert.deepEqual(eng.shared, before);
  assert.equal(remote.length, 1);
});

/* ------------------------------ 2. 新 seq 暂存与重放 ------------------------------ */

impl('下一部的 SYNC 先暂存不生效，列表跟上（resetMedia 带新 seq）后重放生效', async (dir) => {
  const { eng, remote } = await makeEngine(dir, { seq: 0 });
  eng.onCtrl(sync({ seq: 3, lamport: 7, position: 30, paused: false }), P('host'));
  // 还在上一部：不能把下一部的位置套到这一部上
  assert.equal(eng.shared.position, 0);
  assert.equal(eng.intendedPaused, true);
  assert.equal(remote.length, 0);
  assert.equal(eng.clock, 7, '暂存的消息也要推高时钟');

  eng.resetMedia({ seq: 3 });
  assert.equal(eng.seq, 3);
  assert.equal(remote.length, 1);
  assert.equal(eng.shared.position, 30);
  assert.equal(eng.shared.lamport, 7);
  assert.equal(eng.shared.by, 'host');
  assert.equal(eng.intendedPaused, false);
  assert.equal(eng.pendingSeek, 30, '播放器没起来，位置要记下来等它');
  assert.equal(eng._stash.size, 0);
});

impl('暂存对同一发送者只留最新一条：seq 大者优先，seq 相同比 lamport', async (dir) => {
  const { eng, remote } = await makeEngine(dir, { seq: 0 });
  // 同一部内乱序到达：L7、L9、L8。留下的必须是 L9，而不是「最后到的」或「最先到的」
  eng.onCtrl(sync({ seq: 3, lamport: 7, position: 30, paused: false }), P('host'));
  eng.onCtrl(sync({ seq: 3, lamport: 9, position: 31, paused: true }), P('host'));
  eng.onCtrl(sync({ seq: 3, lamport: 8, position: 99, paused: false }), P('host'));
  eng.resetMedia({ seq: 3 });
  assert.equal(remote.length, 1, '同一个人只该重放一条');
  assert.equal(eng.shared.position, 31);
  assert.equal(eng.shared.lamport, 9);
  assert.equal(eng.intendedPaused, true);

  // 跨部：seq 5 的先到，seq 4 的后到（Lamport 还更大）。seq 大的才是房主最新的意图。
  eng.onCtrl(sync({ seq: 5, lamport: 12, position: 50, paused: false }), P('host'));
  eng.onCtrl(sync({ seq: 4, lamport: 20, position: 40, paused: false }), P('host'));
  assert.equal(eng.clock, 20);
  eng.resetMedia({ seq: 4 });
  assert.equal(remote.length, 1, 'seq 4 那条应该已经被 seq 5 顶掉了');
  assert.equal(eng.shared.lamport, -1);
  eng.resetMedia({ seq: 5 });
  assert.equal(remote.length, 2);
  assert.equal(eng.shared.position, 50);
});

impl('换到新 seq 时：等于它的重放、比它新的留着、比它旧的扔掉，按发送者各管各的', async (dir) => {
  const { eng, remote } = await makeEngine(dir, { admins: ['adm', 'adm2'], seq: 0 });
  eng.onCtrl(sync({ seq: 2, lamport: 3, position: 20 }), P('host'));
  eng.onCtrl(sync({ seq: 3, lamport: 4, position: 33 }), P('adm'));
  eng.onCtrl(sync({ seq: 4, lamport: 6, position: 44 }), P('adm2'));
  assert.equal(eng._stash.size, 3, '不同发送者的暂存不能互相覆盖');

  // 列表一步跳到 3：seq 2 那部已经过去了，它的指令永远不会再有用
  eng.resetMedia({ seq: 3 });
  assert.equal(remote.length, 1);
  assert.equal(remote[0].position, 33);
  assert.equal(eng.shared.by, 'adm');
  assert.equal(eng._stash.size, 1, 'seq 2 的要扔掉、seq 4 的要留着');

  eng.resetMedia({ seq: 4 });
  assert.equal(remote.length, 2);
  assert.equal(eng.shared.position, 44);
  assert.equal(eng.shared.by, 'adm2');
  assert.equal(eng._stash.size, 0);
});

/* ------------------------------ 3. 新人入房的顺序 ------------------------------ */

/** 房主：第 3 部，从 120 秒起播，然后过了 10 秒。 */
async function playingHost(dir, admins = []) {
  const h = await makeEngine(dir, { peerId: 'host', admins });
  h.eng.resetMedia({ seq: 3, broadcast: true });
  h.eng.userSeek(120);
  h.eng.userSetPaused(false);
  h.clock.t += 10000;
  for (const list of [h.outbound, h.relay, h.playing]) list.length = 0;
  return h;
}

impl('房主 greet 的顺序是 ROLE → 列表（beforeSync）→ SYNC → 卡顿名单', async (dir) => {
  const h = await playingHost(dir, ['adm']);
  h.eng.onCtrl(stall({ seq: 3, stallSeq: 1, name: '甲' }), P('adm'));
  const peer = greetPeer('nw');
  h.eng.greet(peer, { beforeSync: () => peer.sent.push({ t: 'playlist' }) });

  // 新人得先知道该信谁（ROLE）、当前是第几部（列表），SYNC 才不会被当成陌生人的或下一部的
  assert.deepEqual(
    peer.sent.map((m) => m.t),
    ['role', 'playlist', 'sync', 'stall', 'ready']
  );
  const s = peer.sent[2];
  assert.equal(s.seq, 3);
  assert.equal(s.paused, false);
  assert.ok(near(s.position, 130), `应报「现在」的位置 130，实际 ${s.position}`);
  assert.equal(peer.sent[3].origin, 'adm');
});

impl('按顺序到达：beforeSync 里应用列表后，SYNC 直接生效，位置正确', async (dir) => {
  const h = await playingHost(dir);
  const n = await makeEngine(dir, { peerId: 'nw', hostId: 'host' });
  const peer = { peerId: 'nw', name: 'nw', send: (m) => n.eng.onCtrl(m, P('host')) };
  h.eng.greet(peer, { beforeSync: () => n.eng.resetMedia({ seq: h.eng.seq }) });
  assert.equal(n.eng.seq, 3);
  assert.equal(n.remote.length, 1);
  assert.equal(n.eng.intendedPaused, false);
  assert.ok(near(n.eng.sharedPositionNow(), 130));
  n.clock.t += 5000;
  assert.ok(near(n.eng.sharedPositionNow(), 135), '新人的房间时钟要接着走');
});

impl('先收到 SYNC 再收到列表：SYNC 暂存，列表应用后生效，卡顿名单也一起补上', async (dir) => {
  const h = await playingHost(dir, ['adm']);
  h.eng.onCtrl(stall({ seq: 3, stallSeq: 1, name: '甲' }), P('adm'));
  h.clock.t += 5000; // 有人卡着，房间时钟停在 130
  const peer = greetPeer('nw');
  let playlistSnapshot = null;
  h.eng.greet(peer, { beforeSync: () => peer.sent.push((playlistSnapshot = { t: 'playlist', seq: h.eng.seq })) });

  const n = await makeEngine(dir, { peerId: 'nw', hostId: 'host' });
  // 列表是大消息，要分段拼装 / 等清单，应用得晚：除它以外的消息先按序送达
  for (const m of peer.sent) if (m.t !== 'playlist') n.eng.onCtrl(m, P('host'));
  assert.equal(n.eng.seq, 0);
  assert.equal(n.remote.length, 0, 'seq=3 的 SYNC 不能套在 seq=0 上');
  assert.equal(n.eng.stalledPeers.size, 0);
  assert.equal(n.eng.shared.position, 0);

  n.eng.resetMedia({ seq: playlistSnapshot.seq });
  assert.equal(n.remote.length, 1);
  assert.equal(n.eng.intendedPaused, false);
  assert.ok(near(n.eng.shared.position, 130), `位置应为 130，实际 ${n.eng.shared.position}`);
  assert.deepEqual([...n.eng.stalledPeers.keys()], ['adm']);
  assert.equal(n.eng.effectivePaused, true);
  n.clock.t += 5000;
  assert.ok(near(n.eng.sharedPositionNow(), 130), '有人卡着，房间时钟不能走');
});

impl('房主换片后没来得及广播就 greet，SYNC 的 lamport 也不能是负数', async (dir) => {
  const h = await makeEngine(dir, { peerId: 'host', seq: 2 });
  assert.equal(h.eng.shared.lamport, -1);
  const n = await makeEngine(dir, { peerId: 'nw', hostId: 'host' });
  const peer = { peerId: 'nw', name: 'nw', send: (m) => n.eng.onCtrl(m, P('host')) };
  const sent = [];
  h.eng.greet({ peerId: 'nw', name: 'nw', send: (m) => sent.push(m) });
  const s = sent.find((m) => m.t === 'sync');
  // 收端把 lamport < 0 当非法丢弃，-1 发出去等于没发
  assert.equal(s.lamport, 0);
  h.eng.greet(peer, { beforeSync: () => n.eng.resetMedia({ seq: 2 }) });
  assert.equal(n.remote.length, 1);
  assert.equal(n.eng.shared.by, 'host');
});

/* ------------------------------ 4. lamport:-1 的意义 ------------------------------ */

for (const order of ['列表先到', 'SYNC 先到']) {
  impl(`管理员 peerId 比房主大且时钟领先时，换片后仍采信房主的 resumeAt（${order}）`, async (dir) => {
    const h = await makeEngine(dir, { peerId: 'host', admins: ['zadm'], seq: 1 });
    const a = await makeEngine(dir, { peerId: 'zadm', admins: ['zadm', 'adm2'], seq: 1 });
    h.eng.userSeek(100);
    for (const m of h.outbound) a.eng.onCtrl(m, P('host'));
    assert.equal(a.eng.shared.position, 100);
    // 管理员收到了一条房主没见过的迟到消息，时钟被推到 40
    a.eng.onCtrl(sync({ seq: 0, lamport: 40 }), P('adm2'));
    assert.ok(a.eng.clock > h.eng.clock, '前提：管理员时钟领先房主');
    assert.ok('zadm' > 'host', '前提：平局时管理员的 peerId 会赢');

    h.outbound.length = 0;
    h.eng.resetMedia({ seq: 2, position: 777, broadcast: true });
    const hs = h.outbound.filter((m) => m.t === 'sync');
    assert.equal(hs.length, 1);
    assert.equal(hs[0].seq, 2);
    assert.equal(hs[0].position, 777);

    a.outbound.length = 0;
    if (order === '列表先到') {
      a.eng.resetMedia({ seq: 2 });
      a.eng.onCtrl(hs[0], P('host'));
    } else {
      a.eng.onCtrl(hs[0], P('host'));
      a.eng.resetMedia({ seq: 2 });
    }
    // 管理员的重置既不能广播，也不能给本地状态盖一个比房主大的时间戳
    assert.equal(a.outbound.filter((m) => m.t === 'sync').length, 0);
    assert.equal(a.eng.shared.position, 777, '房主的 resumeAt 被管理员丢掉了');
    assert.equal(a.eng.shared.by, 'host');
    assert.ok(near(a.eng.sharedPositionNow(), 777));
    assert.equal(a.eng.pendingSeek, 777);

    // 之后管理员的操作照样从他见过的最大时钟往上加，房主能采信
    a.eng.userSeek(800);
    const as = a.outbound.filter((m) => m.t === 'sync');
    assert.equal(as.at(-1).lamport, 41);
    h.eng.onCtrl(as.at(-1), P('zadm'));
    assert.equal(h.eng.shared.position, 800);
    assert.equal(h.eng.shared.by, 'zadm');
  });
}

/* ------------------------------ 5. 谁的 resetMedia 会广播 ------------------------------ */

impl('非房主 resetMedia 不发消息、不推时钟；房主带 broadcast 时发一条带新 seq 的 SYNC', async (dir) => {
  const a = await makeEngine(dir, { peerId: 'adm', admins: ['adm'] });
  a.eng.onCtrl(sync({ lamport: 10 }), P('host'));
  assert.equal(a.eng.clock, 10);
  a.eng.resetMedia({ seq: 4 });
  assert.equal(a.outbound.length, 0);
  assert.equal(a.eng.clock, 10);
  assert.equal(a.eng.seq, 4);
  assert.deepEqual(a.eng.shared, { paused: true, position: 0, lamport: -1, by: '', byName: '' });

  // 游客就算上层误传了 broadcast 也发不出去
  const g = await makeEngine(dir, { peerId: 'gst', guests: ['gst'] });
  g.eng.resetMedia({ seq: 4, broadcast: true });
  assert.equal(g.outbound.length, 0);
  assert.equal(g.eng.clock, 0);

  const h = await makeEngine(dir, { peerId: 'host' });
  h.eng.onCtrl(sync({ lamport: 10 }), P('adm')); // adm 不是管理员，被拒，不影响时钟
  h.eng.applyRoles([['adm', 'admin']], 'host');
  h.eng.onCtrl(sync({ lamport: 10 }), P('adm'));
  assert.equal(h.eng.clock, 10);
  h.eng.resetMedia({ seq: 5, position: 12, broadcast: true });
  assert.equal(h.outbound.length, 1);
  const s = h.outbound[0];
  assert.equal(s.t, 'sync');
  assert.equal(s.seq, 5);
  assert.equal(s.position, 12);
  assert.equal(s.paused, true);
  assert.equal(s.lamport, 11);
  assert.equal(h.eng.shared.lamport, 11);
  assert.equal(h.eng.shared.by, 'host');

  h.eng.resetMedia({ seq: 6 });
  assert.equal(h.outbound.length, 1, '不带 broadcast 时房主也不发');
  assert.equal(h.eng.seq, 6);
});

impl('resetMedia 清掉上一部的卡顿与播放意图', async (dir) => {
  const { eng } = await makeEngine(dir, { admins: ['adm'], seq: 1 });
  eng.onCtrl(sync({ seq: 1, lamport: 3, paused: false }), P('host'));
  eng.onCtrl(stall({ seq: 1, stallSeq: 1 }), P('adm'));
  assert.equal(eng.stalledPeers.size, 1);
  eng.resetMedia({ seq: 2, position: 60 });
  assert.equal(eng.stalledPeers.size, 0);
  assert.equal(eng.localStalled, false);
  assert.equal(eng.intendedPaused, true);
  assert.equal(eng.shared.position, 60);
  assert.equal(eng.sharedPositionNow(), 60);
  // 非法 seq 不改本地序号
  eng.resetMedia({ seq: -1 });
  assert.equal(eng.seq, 2);
  eng.resetMedia({ seq: 2.5 });
  assert.equal(eng.seq, 2);
});

/* ------------------------------ 6. STALL 的编号 ------------------------------ */

impl('同一发送者的卡顿只采信编号更大的，编号相同也不行', async (dir) => {
  const { eng, stalls } = await makeEngine(dir, { admins: ['adm'] });
  eng.onCtrl(stall({ stalled: true, stallSeq: 1 }), P('adm'));
  assert.ok(eng.stalledPeers.has('adm'));
  eng.onCtrl(stall({ stalled: false, stallSeq: 1 }), P('adm'));
  assert.ok(eng.stalledPeers.has('adm'), '编号相同的「好了」不该采信');
  eng.onCtrl(stall({ stalled: false, stallSeq: 2 }), P('adm'));
  assert.equal(eng.stalledPeers.has('adm'), false);
  eng.onCtrl(stall({ stalled: true, stallSeq: 1 }), P('adm'));
  assert.equal(eng.stalledPeers.has('adm'), false, '旧的「卡住」不能盖掉新的「好了」');
  eng.onCtrl(stall({ stalled: true, stallSeq: 3 }), P('adm'));
  assert.ok(eng.stalledPeers.has('adm'));
  assert.equal(stalls.length, 3);
});

impl('卡顿消息经两条路径乱序到达：先到新的「好了」、后到旧的「卡住」，最终不卡', async (dir) => {
  const { eng } = await makeEngine(dir, { admins: ['adm'] });
  eng.onCtrl(sync({ lamport: 1, paused: false }), P('host'));
  // 房主转发的 stallSeq=2「好了」先到，直连的 stallSeq=1「卡住」晚到
  eng.onCtrl(stall({ stalled: false, stallSeq: 2, origin: 'adm', originName: '甲' }), P('host'));
  eng.onCtrl(stall({ stalled: true, stallSeq: 1 }), P('adm'));
  assert.equal(eng.stalledPeers.size, 0);
  assert.equal(eng.effectivePaused, false, '全员会被一条过期的卡顿永远停住');

  // 正常顺序、再各重复一遍（网状模式下两条路都会到）
  const b = await makeEngine(dir, { admins: ['adm'] });
  b.eng.onCtrl(sync({ lamport: 1, paused: false }), P('host'));
  const s1 = stall({ stalled: true, stallSeq: 1 });
  const s2 = stall({ stalled: false, stallSeq: 2 });
  b.eng.onCtrl(s1, P('adm'));
  b.eng.onCtrl(s2, P('adm'));
  b.eng.onCtrl({ ...s1, origin: 'adm', originName: '甲' }, P('host'));
  b.eng.onCtrl({ ...s2, origin: 'adm', originName: '甲' }, P('host'));
  assert.equal(b.eng.stalledPeers.size, 0);
  assert.equal(b.eng.effectivePaused, false);
  assert.equal(b.stalls.length, 2);
});

impl('缺 stallSeq 或 seq（或类型不对）的卡顿消息丢弃，也不占编号', async (dir) => {
  const { eng, stalls } = await makeEngine(dir, { admins: ['adm'] });
  const { stallSeq: _a, ...noStallSeq } = stall({});
  const { seq: _b, ...noSeq } = stall({ stallSeq: 5 });
  const bad = [
    noStallSeq,
    noSeq,
    stall({ stallSeq: -1 }),
    stall({ stallSeq: 1.5 }),
    stall({ stallSeq: '2' }),
    stall({ seq: -1, stallSeq: 6 }),
    stall({ seq: '0', stallSeq: 7 }),
    stall({ stalled: 'yes', stallSeq: 8 }),
    stall({ position: -1, stallSeq: 9 }),
  ];
  for (const m of bad) eng.onCtrl(m, P('adm'));
  assert.equal(eng.stalledPeers.size, 0);
  assert.equal(stalls.length, 0);
  // 前面那些编号更大的非法消息不能把合法的 1 号挡住
  eng.onCtrl(stall({ stallSeq: 1 }), P('adm'));
  assert.ok(eng.stalledPeers.has('adm'));
});

impl('下一部的卡顿先暂存、列表跟上后重放；上一部的卡顿不生效也不占编号', async (dir) => {
  const { eng } = await makeEngine(dir, { admins: ['adm'], seq: 1 });
  // 同一部同一人：编号大的留下（4 号「卡住」），哪怕 3 号「好了」后到
  eng.onCtrl(stall({ seq: 2, stallSeq: 4, stalled: true }), P('adm'));
  eng.onCtrl(stall({ seq: 2, stallSeq: 3, stalled: false }), P('adm'));
  assert.equal(eng.stalledPeers.size, 0, '下一部的卡顿不该卡住这一部');

  eng.resetMedia({ seq: 2 });
  assert.deepEqual([...eng.stalledPeers.keys()], ['adm']);
  assert.equal(eng.effectivePaused, true);

  eng.onCtrl(stall({ seq: 1, stallSeq: 10, stalled: false }), P('adm'));
  assert.ok(eng.stalledPeers.has('adm'), '上一部的「好了」不能解除这一部的卡顿');
  eng.onCtrl(stall({ seq: 2, stallSeq: 5, stalled: false }), P('adm'));
  assert.equal(eng.stalledPeers.size, 0, '被丢弃的旧消息把编号占到了 10');
});

/* ------------------------------ 7. 转发 ------------------------------ */

impl('房主采信管理员的 SYNC / STALL 后转发，带上 origin 和 originName，跳过发送者', async (dir) => {
  const h = await makeEngine(dir, { peerId: 'host', admins: ['adm'], guests: ['gst'], seq: 1 });
  const m = sync({ seq: 1, lamport: 1, position: 5, name: '管理员甲' });
  h.eng.onCtrl(m, P('adm'));
  assert.equal(h.relay.length, 1);
  assert.deepEqual(h.relay[0], {
    msg: { ...m, origin: 'adm', originName: '管理员甲' },
    except: 'adm',
  });

  // 旧的、上一部的、游客的都不转发
  h.eng.onCtrl(sync({ seq: 1, lamport: 1, position: 5 }), P('adm'));
  h.eng.onCtrl(sync({ seq: 1, lamport: 0, position: 6 }), P('adm'));
  h.eng.onCtrl(sync({ seq: 0, lamport: 50, position: 7 }), P('adm'));
  h.eng.onCtrl(sync({ seq: 1, lamport: 60, position: 8 }), P('gst'));
  assert.equal(h.relay.length, 1);

  const st = stall({ seq: 1, stallSeq: 1, name: '管理员甲' });
  h.eng.onCtrl(st, P('adm'));
  assert.equal(h.relay.length, 2);
  assert.deepEqual(h.relay[1], {
    msg: { ...st, origin: 'adm', originName: '管理员甲' },
    except: 'adm',
  });
  h.eng.onCtrl(st, P('adm')); // 重复编号
  h.eng.onCtrl(stall({ seq: 1, stallSeq: 1 }), P('gst'));
  assert.equal(h.relay.length, 2);
});

impl('房主转发时用连接身份覆盖成员自填的 origin，名字截断到 40', async (dir) => {
  const h = await makeEngine(dir, { peerId: 'host', admins: ['adm'], guests: ['gst'], seq: 1 });
  h.eng.onCtrl(sync({ seq: 1, lamport: 1, name: 'y'.repeat(100), origin: 'gst', originName: '冒名' }), P('adm'));
  assert.equal(h.relay.length, 1);
  assert.equal(h.relay[0].msg.origin, 'adm');
  assert.equal(h.relay[0].msg.originName, 'y'.repeat(40));
  assert.equal(h.relay[0].except, 'adm');
  assert.equal(h.eng.shared.by, 'adm');
});

impl('非房主从不转发', async (dir) => {
  for (const role of ['admin', 'guest']) {
    const e = await makeEngine(dir, {
      peerId: 'me',
      admins: role === 'admin' ? ['me', 'adm'] : ['adm'],
      seq: 1,
    });
    e.eng.onCtrl(sync({ seq: 1, lamport: 1 }), P('host'));
    e.eng.onCtrl(sync({ seq: 1, lamport: 2 }), P('adm'));
    e.eng.onCtrl(sync({ seq: 1, lamport: 3, origin: 'adm', originName: '甲' }), P('host'));
    e.eng.onCtrl(stall({ seq: 1, stallSeq: 1 }), P('adm'));
    e.eng.onCtrl(stall({ seq: 1, stallSeq: 1, origin: 'adm2' }), P('host'));
    e.eng.peerGone('adm');
    assert.equal(e.remote.length, 3, `${role}：前提是这些消息都被采信了`);
    assert.equal(e.relay.length, 0, `${role} 不该转发`);
  }
});

impl('收端只对房主连接采信 origin：普通成员自称转发按他本人算', async (dir) => {
  const { eng, remote } = await makeEngine(dir, { admins: ['adm', 'adm2'], guests: ['gst'], seq: 1 });
  // 游客冒充管理员：按游客本人算，拒绝
  eng.onCtrl(sync({ seq: 1, lamport: 1, position: 11, origin: 'adm', originName: '甲' }), P('gst'));
  eng.onCtrl(stall({ seq: 1, stallSeq: 1, origin: 'adm' }), P('gst'));
  assert.equal(remote.length, 0);
  assert.equal(eng.stalledPeers.size, 0);

  // 管理员冒充别人：按他本人算，记在他自己名下
  eng.onCtrl(sync({ seq: 1, lamport: 2, position: 22, origin: 'adm', originName: '甲' }), P('adm2', '乙'));
  assert.equal(remote.length, 1);
  assert.equal(eng.shared.by, 'adm2');
  assert.equal(remote[0].by, '乙');
  eng.onCtrl(stall({ seq: 1, stallSeq: 1, origin: 'adm' }), P('adm2'));
  assert.deepEqual([...eng.stalledPeers.keys()], ['adm2']);

  // 房主转发的：记在原发送者名下，显示原发送者的名字
  eng.onCtrl(sync({ seq: 1, lamport: 3, position: 33, origin: 'adm', originName: '甲' }), P('host'));
  assert.equal(remote.length, 2);
  assert.equal(eng.shared.by, 'adm');
  assert.equal(remote[1].by, '甲');

  // 房主转发游客的（不该发生，但收端也要拦）
  eng.onCtrl(sync({ seq: 1, lamport: 4, position: 44, origin: 'gst', originName: 'g' }), P('host'));
  assert.equal(remote.length, 2);

  // origin 为空串或等于房主自己：就是房主本人的
  eng.onCtrl(sync({ seq: 1, lamport: 5, position: 55, origin: '' }), P('host', '房主'));
  assert.equal(eng.shared.by, 'host');
  eng.onCtrl(sync({ seq: 1, lamport: 6, position: 66, origin: 'host' }), P('host', '房主'));
  assert.equal(eng.shared.by, 'host');
  assert.equal(remote.length, 4);
});

impl('转发回来的自己的消息丢弃；originName 截断到 40', async (dir) => {
  const { eng, remote, stalls } = await makeEngine(dir, { admins: ['me', 'adm'], seq: 1 });
  eng.onCtrl(sync({ seq: 1, lamport: 9, position: 99, origin: 'me', originName: '我' }), P('host'));
  eng.onCtrl(stall({ seq: 1, stallSeq: 9, origin: 'me', originName: '我' }), P('host'));
  assert.equal(remote.length, 0);
  assert.equal(eng.shared.lamport, -1);
  assert.equal(eng.stalledPeers.size, 0);
  assert.equal(stalls.length, 0);

  const long = '名'.repeat(100);
  eng.onCtrl(sync({ seq: 1, lamport: 1, origin: 'adm', originName: long }), P('host'));
  assert.equal(remote[0].by, '名'.repeat(40));
  eng.onCtrl(stall({ seq: 1, stallSeq: 1, origin: 'adm', originName: long }), P('host'));
  assert.equal(stalls[0].name, '名'.repeat(40));
  assert.equal(eng.stalledPeers.get('adm').name, '名'.repeat(40));
  // 没给 originName 时退回原发送者的 id，而不是房主的名字
  eng.onCtrl(stall({ seq: 1, stallSeq: 2, stalled: false, origin: 'adm' }), P('host', '房主'));
  assert.equal(stalls[1].name, 'adm');
});

/* ------------------------------ 8. 网状模式去重 ------------------------------ */

/** 三方：房主、管理员 adm、游客 me，同在第 1 部。 */
async function mesh(dir) {
  const h = await makeEngine(dir, { peerId: 'host', admins: ['adm'], guests: ['me'], seq: 1 });
  const a = await makeEngine(dir, { peerId: 'adm', admins: ['adm'], guests: ['me'], seq: 1 });
  const m = await makeEngine(dir, { peerId: 'me', admins: ['adm'], guests: ['me'], seq: 1 });
  return { h, a, m };
}

for (const order of ['直连先到', '转发先到']) {
  impl(`网状模式同一条 SYNC / STALL 从直连和房主转发各到一次，只生效一次（${order}）`, async (dir) => {
    const { h, a, m } = await mesh(dir);
    const route = (msg) => {
      h.eng.onCtrl(msg, P('adm'));
      const relayed = h.relay.at(-1);
      assert.ok(relayed && relayed.except === 'adm', '房主应当转发');
      h.relay.length = 0;
      const paths = [
        () => m.eng.onCtrl(msg, P('adm')),
        () => m.eng.onCtrl(relayed.msg, P('host')),
      ];
      if (order === '转发先到') paths.reverse();
      for (const p of paths) p();
    };

    a.eng.userSetPaused(false);
    const s = a.outbound.filter((x) => x.t === 'sync');
    assert.equal(s.length, 1);
    route(s[0]);
    assert.equal(m.remote.length, 1, 'remote-action 触发了两次，界面会提示两遍');
    assert.equal(m.playing.length, 1);
    assert.equal(m.eng.shared.by, 'adm');
    assert.equal(m.eng.intendedPaused, false);

    a.outbound.length = 0;
    a.eng.onBufferProgress({ contiguousBytes: 0, complete: false });
    a.eng.onBufferProgress({ contiguousBytes: 64 * 1024 * 1024, complete: false });
    const st = a.outbound.filter((x) => x.t === 'stall');
    assert.deepEqual(st.map((x) => [x.stalled, x.stallSeq]), [[true, 1], [false, 2]]);
    route(st[0]);
    assert.equal(m.stalls.length, 1);
    assert.ok(m.eng.stalledPeers.has('adm'));
    route(st[1]);
    assert.equal(m.stalls.length, 2);
    assert.equal(m.eng.stalledPeers.size, 0);
    assert.equal(m.eng.effectivePaused, false);
  });
}

/* ------------------------------ 9. 星型模式有人掉线 ------------------------------ */

impl('星型模式卡着的管理员掉线：房主替他广播 release，其他成员解除卡顿', async (dir) => {
  const h = await makeEngine(dir, { peerId: 'host', admins: ['adm'], guests: ['me'], seq: 1 });
  const m = await makeEngine(dir, { peerId: 'me', admins: ['adm'], guests: ['me'], seq: 1 });
  m.eng.onCtrl(sync({ seq: 1, lamport: 1, paused: false }), P('host'));
  h.eng.onCtrl(stall({ seq: 1, stallSeq: 3, name: '甲' }), P('adm', '甲'));
  m.eng.onCtrl(h.relay.at(-1).msg, P('host'));
  assert.ok(m.eng.stalledPeers.has('adm'));
  assert.equal(m.eng.effectivePaused, true);

  h.relay.length = 0;
  h.eng.peerGone('adm');
  assert.equal(h.eng.stalledPeers.size, 0);
  assert.equal(h.relay.length, 1);
  assert.deepEqual(h.relay[0], {
    msg: { t: 'stall', stalled: false, release: true, origin: 'adm', originName: '甲', seq: 1, stallSeq: 3 },
    except: null,
  });

  // 编号和他最后一条相同，release 也得认：那个人不会再发更新的了
  m.stalls.length = 0;
  m.eng.onCtrl(h.relay[0].msg, P('host'));
  assert.equal(m.eng.stalledPeers.size, 0);
  assert.equal(m.eng.effectivePaused, false);
  assert.equal(m.stalls.length, 1);
  assert.equal(m.stalls[0].stalled, false);
  assert.equal(m.stalls[0].who, 'adm');
});

impl('release 只认房主连接，对不在名单里的人无效，也不能拿来喊停', async (dir) => {
  const { eng, stalls } = await makeEngine(dir, { admins: ['adm', 'adm2', 'adm3'], guests: ['gst'], seq: 1 });
  eng.onCtrl(stall({ seq: 1, stallSeq: 3, origin: 'adm', originName: '甲' }), P('host'));
  assert.ok(eng.stalledPeers.has('adm'));
  stalls.length = 0;

  const release = { t: 'stall', stalled: false, release: true, origin: 'adm', originName: '甲', seq: 1, stallSeq: 3 };
  eng.onCtrl(release, P('gst'));
  eng.onCtrl({ ...release, stallSeq: 99 }, P('adm2'));
  assert.ok(eng.stalledPeers.has('adm'), '普通成员替别人解除了卡顿');
  // 本人直连发来的 release 标记不享受「不看编号」：走普通路径，编号没变大就不认
  eng.onCtrl({ t: 'stall', stalled: false, release: true, seq: 1, stallSeq: 3 }, P('adm'));
  assert.ok(eng.stalledPeers.has('adm'), '直连的 release 绕过了编号检查');

  // 名单里没有的人：什么都不发生，也不占他的编号
  stalls.length = 0; // adm2 那条按他本人的「好了」处理，会有一条自己的 stall-change
  eng.onCtrl({ ...release, origin: 'adm3', stallSeq: 50 }, P('host'));
  assert.equal(stalls.length, 0);
  eng.onCtrl(stall({ seq: 1, stallSeq: 1 }), P('adm3'));
  assert.ok(eng.stalledPeers.has('adm3'));

  // release 只能解除，stalled:true 的 release 不能把人加进名单
  eng.onCtrl({ ...release, stalled: true, origin: 'adm2', stallSeq: 100 }, P('host'));
  assert.equal(eng.stalledPeers.has('adm2'), false);
});

impl('非房主 peerGone 只清本地，不转发；不在名单里的人掉线房主也不发 release', async (dir) => {
  const m = await makeEngine(dir, { admins: ['adm'], seq: 1 });
  m.eng.onCtrl(stall({ seq: 1, stallSeq: 1 }), P('adm'));
  m.eng.peerGone('adm');
  assert.equal(m.eng.stalledPeers.size, 0);
  assert.equal(m.relay.length, 0);

  const h = await makeEngine(dir, { peerId: 'host', admins: ['adm'], seq: 1 });
  h.eng.peerGone('adm');
  h.eng.peerGone('stranger');
  assert.equal(h.relay.length, 0);
});

impl('peerGone 清掉这个人的暂存，别人的留着', async (dir) => {
  const { eng, remote } = await makeEngine(dir, { admins: ['adm', 'adm2'], seq: 1 });
  eng.onCtrl(sync({ seq: 2, lamport: 5, position: 50 }), P('adm'));
  eng.onCtrl(stall({ seq: 2, stallSeq: 1 }), P('adm'));
  eng.onCtrl(sync({ seq: 2, lamport: 4, position: 40 }), P('adm2'));
  eng.peerGone('adm');
  eng.resetMedia({ seq: 2 });
  assert.equal(remote.length, 1);
  assert.equal(eng.shared.by, 'adm2');
  assert.equal(eng.shared.position, 40);
  assert.equal(eng.stalledPeers.size, 0, '已经离开的人的卡顿不能在换片后冒出来');
});

/* ------------------------------ 10. 全员暂停时入房 ------------------------------ */

impl('新人在全员暂停时入房：房主为每个卡着的人补发 STALL（不含新人自己），新人随即暂停', async (dir) => {
  const h = await makeEngine(dir, { peerId: 'host', admins: ['adm', 'adm2', 'nw'], seq: 1 });
  h.eng.userSetPaused(false);
  h.eng.onCtrl(stall({ seq: 1, stallSeq: 4, name: '甲', position: 12, deficitSeconds: 2 }), P('adm'));
  h.eng.onCtrl(stall({ seq: 1, stallSeq: 7, name: '乙' }), P('adm2'));
  // nw 断线前卡着，旧连接还没来得及清理就重连了
  h.eng.onCtrl(stall({ seq: 1, stallSeq: 2, name: '新' }), P('nw'));

  const peer = greetPeer('nw');
  h.eng.greet(peer);
  const stallsSent = peer.sent.filter((m) => m.t === 'stall');
  assert.equal(stallsSent.length, 2);
  assert.equal(stallsSent.some((m) => m.origin === 'nw' || m.peerId === 'nw'), false, '把新人自己的卡顿发回给他了');
  const byOrigin = Object.fromEntries(stallsSent.map((m) => [m.origin, m]));
  assert.deepEqual(
    { ...byOrigin.adm },
    { t: 'stall', stalled: true, origin: 'adm', originName: '甲', position: 12, deficitSeconds: 2, seq: 1, stallSeq: 4 }
  );
  assert.equal(byOrigin.adm2.stallSeq, 7);
  assert.equal(byOrigin.adm2.originName, '乙');
  assert.equal(byOrigin.adm2.seq, 1);

  const n = await makeEngine(dir, { peerId: 'nw', hostId: 'host', seq: 1 });
  for (const m of peer.sent) n.eng.onCtrl(m, P('host'));
  assert.equal(n.eng.roleOf('nw'), 'admin');
  assert.equal(n.eng.intendedPaused, false);
  assert.deepEqual([...n.eng.stalledPeers.keys()].sort(), ['adm', 'adm2']);
  assert.equal(n.eng.effectivePaused, true);
  assert.deepEqual(n.eng.status().waitingFor.sort(), ['乙', '甲'].sort());

  // 补发的编号就是房主见过的编号：之后本人的「好了」（更大的编号）照样能解除
  h.relay.length = 0;
  h.eng.onCtrl(stall({ seq: 1, stallSeq: 5, stalled: false }), P('adm'));
  n.eng.onCtrl(h.relay.at(-1).msg, P('host'));
  assert.deepEqual([...n.eng.stalledPeers.keys()], ['adm2']);
});

impl('本机卡着的控制者 greet 时用新的 stallSeq，重连的对端能重新认出他在卡', async (dir) => {
  const a = await makeEngine(dir, { peerId: 'adm', admins: ['adm'], seq: 1 });
  const m = await makeEngine(dir, { peerId: 'me', admins: ['adm'], seq: 1 });
  a.eng.onBufferProgress({ contiguousBytes: 0, complete: false });
  const first = a.outbound.filter((x) => x.t === 'stall');
  assert.equal(first.length, 1);
  assert.equal(first[0].stallSeq, 1);
  m.eng.onCtrl(first[0], P('adm'));
  assert.ok(m.eng.stalledPeers.has('adm'));

  // 断线：对端清掉他，但记得见过的编号
  m.eng.peerGone('adm');
  assert.equal(m.eng.stalledPeers.size, 0);

  const peer = greetPeer('me');
  a.eng.greet(peer);
  assert.deepEqual(peer.sent.map((x) => x.t), ['sync', 'stall', 'ready'], '非房主不发 ROLE');
  const again = peer.sent[1];
  assert.equal(again.stalled, true);
  assert.equal(again.seq, 1);
  assert.equal(again.stallSeq, 2, '沿用旧编号会被对端当成重复');
  for (const x of peer.sent) m.eng.onCtrl(x, P('adm'));
  assert.ok(m.eng.stalledPeers.has('adm'));

  // 游客卡着不补发
  const g = await makeEngine(dir, { peerId: 'gst', guests: ['gst'], seq: 1 });
  g.eng.onBufferProgress({ contiguousBytes: 0, complete: false });
  assert.equal(g.eng.localStalled, true);
  const gp = greetPeer('x');
  g.eng.greet(gp);
  assert.deepEqual(gp.sent.map((x) => x.t), ['sync', 'ready']);
});

// 曾经的缺陷（已修）：greet 发出的 SYNC 不带原作者，新人把这份状态记在房主名下
// （shared.by = 'host'）。之后再到一条同 Lamport 的并发指令时，房主按「原作者 vs 新作者」比，
// 新人按「房主 vs 新作者」比，两边的平局裁决不一样 —— 转发把这条指令送到了新人面前，
// 他却把它当成旧的丢掉，从此和全房分叉，直到下一次有人操作。peerId 是随机的，这是抛硬币的事。
impl('新人入房后，与房主当前状态同 Lamport 的并发指令经房主转发到达，新人与房主裁决一致', async (dir) => {
  // id 的大小关系：adm < b < host
  const h = await makeEngine(dir, { peerId: 'host', admins: ['adm', 'b'], seq: 1 });
  // adm 和 b 几乎同时各发了一条 L5（彼此都还没见过对方的）；房主先收到 adm 的
  h.eng.onCtrl(sync({ seq: 1, lamport: 5, position: 100, paused: false }), P('adm'));
  assert.equal(h.eng.shared.by, 'adm');

  const n = await makeEngine(dir, { peerId: 'nw', hostId: 'host', seq: 1 });
  const peer = greetPeer('nw');
  h.eng.greet(peer);
  for (const m of peer.sent) n.eng.onCtrl(m, P('host'));
  assert.equal(n.eng.shared.position, 100);

  // b 的那条这时才到房主：平局，'b' > 'adm'，房主采信并转发
  h.relay.length = 0;
  h.eng.onCtrl(sync({ seq: 1, lamport: 5, position: 200, paused: true }), P('b'));
  assert.equal(h.eng.shared.position, 200);
  assert.equal(h.relay.length, 1);
  n.eng.onCtrl(h.relay[0].msg, P('host'));
  assert.equal(n.eng.shared.position, h.eng.shared.position, '新人和房主分叉了：新人把房主快照记在了房主名下');
  assert.equal(n.eng.intendedPaused, h.eng.intendedPaused);
});

/* ------------------------------ 11. playing 事件 ------------------------------ */

impl('自己广播播放时触发 playing，带当前 seq', async (dir) => {
  const { eng, playing } = await makeEngine(dir, { peerId: 'host' });
  eng.resetMedia({ seq: 2, broadcast: true });
  assert.equal(playing.length, 0, '换片后的初始状态是暂停，不算开播');
  eng.userSetPaused(false);
  assert.deepEqual(playing, [{ seq: 2 }]);
  eng.userSetPaused(true);
  eng.userSeek(50);
  assert.equal(playing.length, 1);
  eng.resetMedia({ seq: 3, broadcast: true });
  eng.userSetPaused(false);
  assert.deepEqual(playing, [{ seq: 2 }, { seq: 3 }]);
});

impl('采信别人的播放时触发 playing，暂存的等重放时才触发；游客自己点播放不算', async (dir) => {
  const { eng, playing } = await makeEngine(dir, { seq: 2 });
  eng.onCtrl(sync({ seq: 2, lamport: 1, paused: true }), P('host'));
  assert.equal(playing.length, 0);
  eng.onCtrl(sync({ seq: 2, lamport: 2, paused: false }), P('host'));
  assert.deepEqual(playing, [{ seq: 2 }]);
  eng.onCtrl(sync({ seq: 2, lamport: 2, paused: false }), P('host')); // 重复
  eng.onCtrl(sync({ seq: 1, lamport: 9, paused: false }), P('host')); // 上一部
  assert.equal(playing.length, 1);

  eng.onCtrl(sync({ seq: 3, lamport: 3, paused: false }), P('host'));
  assert.equal(playing.length, 1, '下一部还没切过去，不能标记它开播');
  eng.resetMedia({ seq: 3 });
  assert.deepEqual(playing, [{ seq: 2 }, { seq: 3 }]);

  // 游客只动自己这一路，房间里的这一部并没有因此开播
  eng.onCtrl(sync({ seq: 3, lamport: 4, paused: true }), P('host'));
  eng.userSetPaused(false);
  assert.equal(playing.length, 2);
});

impl('房主接待的新人恰好就是当前状态的作者时，不带 origin —— 否则会被他当成自己的回声丢掉', async (dir) => {
  const h = await makeEngine(dir, { peerId: 'host', admins: ['adm'], seq: 1 });
  h.eng.onCtrl(sync({ seq: 1, lamport: 5, position: 100, paused: false }), P('adm'));
  assert.equal(h.eng.shared.by, 'adm');

  // adm 断线重连，本机状态已经重置过（lamport -1）
  const a = await makeEngine(dir, { peerId: 'adm', hostId: 'host', admins: ['adm'], seq: 1 });
  const peer = greetPeer('adm');
  h.eng.greet(peer);
  const s = peer.sent.find((m) => m.t === 'sync');
  assert.equal(s.origin, undefined);
  for (const m of peer.sent) a.eng.onCtrl(m, P('host'));
  assert.equal(a.eng.shared.position, 100, '房间状态被当成回声丢掉了');
  assert.equal(a.eng.intendedPaused, false);

  // 作者已经被降为游客：同样不带 origin，整条才不会被拒
  h.eng.setRole('adm', 'guest');
  const other = greetPeer('nw');
  h.eng.greet(other);
  assert.equal(other.sent.find((m) => m.t === 'sync').origin, undefined);
});
