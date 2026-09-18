'use strict';

// 同步引擎在「出过岔子之后」能不能收敛回来：
//  - 有人把 Lamport 顶到离谱的值、之后被降级，房主和其余管理员还能不能控场；
//  - 卡着的游客被提升为管理员、经房主转发得知的卡顿在断线时怎么清、重连 greet 的快照平局、
//    降级那一刻在途的指令。
// 全部用假时钟 + 假网络（按连接先进先出，断开时在途消息丢掉），不碰任何播放器。
const test = require('node:test');
const assert = require('node:assert/strict');
const { IMPLS } = require('./helpers/impls');

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

const near = (a, b) => Math.abs(a - b) < 0.01;
const MB = 1024 * 1024;

/**
 * 假网络。每个节点一台引擎；outbound 发给所有连着的人，relay 按 app.js 的规则转发
 * （不发回给发送者，也不发给原作者）。消息过一遍 JSON，和真实通道一样丢掉 undefined 字段。
 */
function makeNet(dir) {
  const net = { clock: { t: 1000 }, nodes: new Map(), links: new Set(), queue: [] };
  const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  net.linked = (a, b) => net.links.has(key(a, b));
  net.peersOf = (id) => [...net.nodes.keys()].filter((p) => p !== id && net.linked(id, p));
  net.send = (from, to, msg) => {
    if (net.linked(from, to)) net.queue.push({ from, to, msg: JSON.parse(JSON.stringify(msg)) });
  };
  net.add = async (peerId, { hostId, roles, isSeeder = true }) => {
    const { SyncEngine } = await import(dir + 'syncEngine.js');
    const eng = new SyncEngine({ peerId, name: peerId, isSeeder, hostId });
    eng.now = () => net.clock.t;
    eng.onSeek = () => {};
    eng.onSetPause = () => {};
    eng.started = true;
    eng.applyRoles(roles, hostId);
    const node = { id: peerId, eng, out: [], relayed: [], remote: [] };
    eng.on('outbound', (m) => {
      node.out.push(m);
      for (const p of net.peersOf(peerId)) net.send(peerId, p, m);
    });
    eng.on('relay', ({ msg, except }) => {
      node.relayed.push(msg);
      for (const p of net.peersOf(peerId)) if (p !== except && p !== msg.origin) net.send(peerId, p, msg);
    });
    eng.on('remote-action', (e) => node.remote.push(e));
    net.nodes.set(peerId, node);
    return node;
  };
  net.node = (id) => net.nodes.get(id);
  net.connect = (a, b) => net.links.add(key(a, b));
  /** 断线：两边的在途消息都丢掉，两边各自 peerGone。 */
  net.disconnect = (a, b) => {
    net.links.delete(key(a, b));
    net.queue = net.queue.filter((q) => key(q.from, q.to) !== key(a, b));
    net.node(a).eng.peerGone(b);
    net.node(b).eng.peerGone(a);
  };
  /** a 接待 b（对应 app.js 的 peer-authenticated → greet）。 */
  net.greet = (a, b, opts) => {
    net.node(a).eng.greet({ peerId: b, name: b, send: (m) => (net.send(a, b, m), true) }, opts);
  };
  net.flush = () => {
    let n = 0;
    while (net.queue.length) {
      assert.ok(++n < 20000, '消息没完没了');
      const { from, to, msg } = net.queue.shift();
      if (net.linked(from, to)) net.node(to).eng.onCtrl(msg, { peerId: from, name: from });
    }
  };
  net.tick = (sec) => {
    net.clock.t += sec * 1000;
  };
  net.pos = (id) => net.node(id).eng.sharedPositionNow();
  return net;
}

/**
 * 开一个房间：房主换到第 1 部并广播，然后开播。
 * members: [{id, role, seeder}]；links 缺省为全连通（信令模式的网状）。
 */
async function startRoom(dir, { host = 'h1', members, links, play = true }) {
  const net = makeNet(dir);
  const roles = members.map((m) => [m.id, m.role]);
  await net.add(host, { hostId: host, roles });
  for (const m of members) await net.add(m.id, { hostId: host, roles, isSeeder: m.seeder !== false });
  const ids = [host, ...members.map((m) => m.id)];
  for (const [a, b] of links || ids.flatMap((a, i) => ids.slice(i + 1).map((b) => [a, b]))) net.connect(a, b);
  for (const m of members) net.node(m.id).eng.resetMedia({ seq: 1 });
  net.node(host).eng.resetMedia({ seq: 1, broadcast: true });
  net.flush();
  if (play) {
    net.node(host).eng.userSetPaused(false);
    net.flush();
  }
  return net;
}

const stallOn = (node) => node.eng.onBufferProgress({ contiguousBytes: 0, complete: false });
const stallOff = (node) => node.eng.onBufferProgress({ contiguousBytes: 64 * MB, complete: false });

const PERMS = [
  ['a1', 'm1', 'z1'],
  ['a1', 'z1', 'm1'],
  ['m1', 'a1', 'z1'],
  ['m1', 'z1', 'a1'],
  ['z1', 'a1', 'm1'],
  ['z1', 'm1', 'a1'],
];

/* ------------------------------ 1. Lamport 上限（security#2） ------------------------------ */

impl('管理员发来 lamport=MAX_SAFE_INTEGER：整条不收、时钟不动；降级后房主和其他管理员照常控场', async (dir) => {
  const net = await startRoom(dir, {
    members: [
      { id: 'm1', role: 'admin' },
      { id: 'b1', role: 'admin' },
      { id: 'g1', role: 'guest' },
    ],
  });
  const H = net.node('h1');
  const B = net.node('b1');
  const G = net.node('g1');
  const before = { h: H.eng.clock, b: B.eng.clock, g: G.eng.clock, l: H.eng.shared.lamport };
  const evil = {
    t: 'sync',
    paused: true,
    position: 999,
    lamport: Number.MAX_SAFE_INTEGER,
    seq: 1,
    by: 'm1',
    name: 'm1',
  };
  // 改过的客户端：当前这一部的、上一部的、下一部的都试一遍（后两种不会被采信，但以前照样推高时钟）
  for (const seq of [1, 0, 2]) {
    for (const to of ['h1', 'b1', 'g1']) net.send('m1', to, { ...evil, seq });
  }
  H.relayed.length = 0;
  net.flush();
  assert.equal(H.eng.clock, before.h, '房主的时钟被顶上去了');
  assert.equal(B.eng.clock, before.b, '管理员的时钟被顶上去了');
  assert.equal(G.eng.clock, before.g, '游客的时钟被顶上去了');
  assert.equal(H.eng.shared.lamport, before.l);
  assert.equal(H.eng.intendedPaused, false);
  assert.equal(B.eng.intendedPaused, false);
  assert.equal(H.relayed.length, 0, '离谱的指令被房主转发了');

  H.eng.setRole('m1', 'guest');
  net.flush();
  H.eng.userSetPaused(true);
  net.flush();
  const hs = H.out.filter((m) => m.t === 'sync').at(-1);
  assert.ok(Number.isSafeInteger(hs.lamport), `房主发出的 lamport 不是安全整数：${hs.lamport}`);
  for (const n of [B, G]) {
    assert.equal(n.eng.intendedPaused, true, `${n.id} 没跟上房主的暂停`);
    assert.equal(n.eng.shared.by, 'h1');
  }
  B.eng.userSeek(42);
  net.flush();
  assert.equal(H.eng.shared.position, 42, '其他管理员的跳转没被采信');
  assert.equal(G.eng.shared.position, 42);
});

impl('窗口边界：领先本机正好 LAMPORT_WINDOW 的收，多 1 就不收', async (dir) => {
  const { LAMPORT_WINDOW } = await import(dir + 'syncEngine.js');
  const net = await startRoom(dir, { members: [{ id: 'm1', role: 'admin' }] });
  const H = net.node('h1');
  const base = Math.max(H.eng.clock, H.eng.shared.lamport);
  const msg = (lamport, position) => ({ t: 'sync', paused: false, position, lamport, seq: 1 });
  net.send('m1', 'h1', msg(base + LAMPORT_WINDOW + 1, 7));
  net.flush();
  assert.equal(H.eng.clock, base);
  assert.notEqual(H.eng.shared.position, 7);
  net.send('m1', 'h1', msg(base + LAMPORT_WINDOW, 8));
  net.flush();
  assert.equal(H.eng.clock, base + LAMPORT_WINDOW, '合法范围内的跳变被拒了');
  assert.equal(H.eng.shared.position, 8);
});

impl('被一步步抬高之后降级：房主、管理员仍能控场；新人从 0 起也收得下房主报的现状', async (dir) => {
  const { LAMPORT_WINDOW } = await import(dir + 'syncEngine.js');
  // 星型：成员只连房主
  const net = await startRoom(dir, {
    members: [
      { id: 'm1', role: 'admin' },
      { id: 'a1', role: 'admin' },
      { id: 'b1', role: 'guest' },
      { id: 'j1', role: 'admin' },
    ],
    links: [
      ['h1', 'm1'],
      ['h1', 'a1'],
      ['h1', 'b1'],
    ],
  });
  const H = net.node('h1');
  const A = net.node('a1');
  const B = net.node('b1');
  const J = net.node('j1');
  // 每条都卡在窗口边上，房主一条条采信并转发，全房的时钟被一起抬高
  for (let i = 0; i < 40; i++) {
    net.send('m1', 'h1', {
      t: 'sync',
      paused: i % 2 === 0,
      position: i,
      lamport: Math.max(H.eng.clock, H.eng.shared.lamport) + LAMPORT_WINDOW,
      seq: 1,
    });
    net.flush();
  }
  assert.ok(B.eng.shared.lamport >= 40 * LAMPORT_WINDOW, '前提：全房时钟已被抬高');
  assert.equal(B.eng.shared.by, 'm1');

  H.eng.setRole('m1', 'guest');
  net.flush();
  H.eng.userSeek(10);
  net.flush();
  assert.equal(B.eng.shared.position, 10);
  assert.equal(A.eng.shared.position, 10);
  A.eng.userSetPaused(false);
  net.flush();
  assert.equal(H.eng.intendedPaused, false, '管理员的播放没被房主采信');
  assert.equal(B.eng.intendedPaused, false, '房主转发的管理员指令没被成员采信');
  for (const n of [H, A]) {
    const last = n.out.filter((m) => m.t === 'sync').at(-1);
    assert.ok(Number.isSafeInteger(last.lamport));
  }

  // 新人：时钟从 0 起，房主报的现状远超窗口，照样得收
  assert.equal(J.eng.clock, 0);
  net.connect('h1', 'j1');
  net.greet('h1', 'j1');
  net.flush();
  assert.equal(J.eng.shared.lamport, H.eng.shared.lamport, '新人拒收了房主的现状');
  assert.equal(J.eng.intendedPaused, false);
  assert.ok(near(J.eng.shared.position, 10));
  // 之后经房主转发的其他管理员指令也收得下
  A.eng.userSeek(55);
  net.flush();
  assert.equal(J.eng.shared.position, 55);
});

impl('网状模式下时钟被没采信的消息单独顶高：降级后他发的指令别人照样收', async (dir) => {
  const { LAMPORT_WINDOW, LAMPORT_LEAD } = await import(dir + 'syncEngine.js');
  const net = await startRoom(dir, {
    members: [
      { id: 'm1', role: 'admin' },
      { id: 'b1', role: 'admin' },
      { id: 'c1', role: 'guest' },
    ],
  });
  const H = net.node('h1');
  const B = net.node('b1');
  const C = net.node('c1');
  // 只发给 b1、而且是上一部的：不会被采信、不会被转发，只想把 b1 的时钟一步步推高
  const base = B.eng.clock;
  for (let i = 0; i < 10; i++) {
    net.send('m1', 'b1', {
      t: 'sync',
      paused: false,
      position: 1,
      lamport: Math.max(B.eng.clock, B.eng.shared.lamport) + LAMPORT_WINDOW,
      seq: 0,
    });
    net.flush();
  }
  // 窗口按经房主确认过的基准算，不跟着被顶高的时钟走：只有第一条推得动
  assert.equal(B.eng.clock, base + LAMPORT_WINDOW, '前提：b1 的时钟被单独顶高了一个窗口，且没有越推越高');
  assert.ok(H.eng.clock < LAMPORT_WINDOW);

  H.eng.setRole('m1', 'guest');
  net.flush();
  B.eng.userSeek(33);
  const bs = B.out.filter((m) => m.t === 'sync').at(-1);
  assert.ok(bs.lamport <= Math.max(0, H.eng.shared.lamport) + LAMPORT_LEAD, `b1 发出的 lamport 过大：${bs.lamport}`);
  net.flush();
  assert.equal(H.eng.shared.position, 33, '房主拒收了 b1 的跳转');
  assert.equal(C.eng.shared.position, 33);
  // 之后的指令照常一步步往上加
  H.eng.userSetPaused(true);
  net.flush();
  assert.equal(B.eng.intendedPaused, true);
  B.eng.userSetPaused(false);
  net.flush();
  assert.equal(H.eng.intendedPaused, false);
  assert.equal(C.eng.intendedPaused, false);
});

impl('房主连接送来 MAX_SAFE_INTEGER 时，自己下一条也不会越过安全整数', async (dir) => {
  const net = await startRoom(dir, { members: [{ id: 'a1', role: 'admin' }] });
  const A = net.node('a1');
  net.send('h1', 'a1', { t: 'sync', paused: true, position: 3, lamport: Number.MAX_SAFE_INTEGER, seq: 1 });
  net.flush();
  assert.equal(A.eng.shared.lamport, Number.MAX_SAFE_INTEGER);
  A.eng.userSeek(5);
  const s = A.out.filter((m) => m.t === 'sync').at(-1);
  assert.ok(Number.isSafeInteger(s.lamport), `发出的 lamport 不是安全整数：${s.lamport}`);
});

/* ------------------------------ 2. 卡着被提升（sync#1） ------------------------------ */

impl('游客卡在缓冲里时被提升为管理员：补发 STALL，全房一起等，两边房间时钟一致', async (dir) => {
  const net = await startRoom(dir, { members: [{ id: 'b1', role: 'guest', seeder: false }] });
  const H = net.node('h1');
  const B = net.node('b1');
  stallOn(B);
  net.flush();
  assert.equal(B.eng.localStalled, true);
  assert.equal(B.out.filter((m) => m.t === 'stall').length, 0, '游客卡住不该广播');
  assert.equal(H.eng.stalledPeers.size, 0);
  net.tick(5);

  H.eng.setRole('b1', 'admin');
  net.flush();
  const st = B.out.filter((m) => m.t === 'stall');
  assert.equal(st.length, 1, '提升后没有补报卡顿');
  assert.equal(st[0].stalled, true);
  assert.equal(st[0].seq, 1);
  assert.ok(H.eng.stalledPeers.has('b1'), '房主不知道新管理员卡着');
  assert.equal(H.eng.effectivePaused, true);
  assert.ok(near(net.pos('h1'), 5) && near(net.pos('b1'), 5));

  net.tick(30);
  assert.ok(near(net.pos('h1'), net.pos('b1')), `房主 ${net.pos('h1')}，b1 ${net.pos('b1')}`);
  stallOff(B);
  net.flush();
  assert.equal(H.eng.stalledPeers.size, 0);
  net.tick(10);
  assert.ok(near(net.pos('h1'), 15), `房主 ${net.pos('h1')}`);
  assert.ok(near(net.pos('b1'), 15), `b1 ${net.pos('b1')}`);

  // 已经是管理员时再收到同样的角色表，不重复补报
  H.eng.setRole('b1', 'admin');
  net.flush();
  assert.equal(B.out.filter((m) => m.t === 'stall').length, 2);
});

impl('提升时没卡着不发 STALL；降级后再提升仍卡着，用新编号补报，房主照收', async (dir) => {
  const net = await startRoom(dir, {
    members: [
      { id: 'b1', role: 'guest', seeder: false },
      { id: 'c1', role: 'guest' },
    ],
    links: [
      ['h1', 'b1'],
      ['h1', 'c1'],
    ],
  });
  const H = net.node('h1');
  const B = net.node('b1');
  const C = net.node('c1');
  H.eng.setRole('c1', 'admin');
  net.flush();
  assert.equal(C.out.filter((m) => m.t === 'stall').length, 0);

  H.eng.setRole('b1', 'admin');
  net.flush();
  stallOn(B);
  net.flush();
  assert.ok(H.eng.stalledPeers.has('b1'));
  assert.ok(C.eng.stalledPeers.has('b1'), '星型下经房主转发');
  H.eng.setRole('b1', 'guest');
  net.flush();
  assert.equal(H.eng.stalledPeers.size, 0);
  assert.equal(C.eng.stalledPeers.size, 0);
  H.eng.setRole('b1', 'admin');
  net.flush();
  const st = B.out.filter((m) => m.t === 'stall');
  assert.equal(st.length, 2);
  assert.ok(st[1].stallSeq > st[0].stallSeq);
  assert.ok(H.eng.stalledPeers.has('b1'), '再次提升后的补报被当成旧消息');
  assert.ok(C.eng.stalledPeers.has('b1'));
});

/* ------------------------------ 3. 经房主转发的卡顿（sync#2） ------------------------------ */

/** a1 和 b1 之间没有直连，只靠房主转发；b1 卡住。 */
async function relayedStallRoom(dir, { direct = false } = {}) {
  const links = [
    ['h1', 'a1'],
    ['h1', 'b1'],
  ];
  if (direct) links.push(['a1', 'b1']);
  const net = await startRoom(dir, {
    members: [
      { id: 'a1', role: 'admin' },
      { id: 'b1', role: 'admin', seeder: false },
    ],
    links,
  });
  stallOn(net.node('b1'));
  net.flush();
  assert.ok(net.node('a1').eng.stalledPeers.has('b1'), '前提：a1 知道 b1 在卡');
  assert.equal(net.node('a1').eng.effectivePaused, true);
  return net;
}

for (const variant of ['缓过来了', '离开了']) {
  impl(`和房主断线期间，只经房主得知在卡的人${variant}：重连后不再永久暂停`, async (dir) => {
    const net = await relayedStallRoom(dir);
    const A = net.node('a1');
    const H = net.node('h1');
    net.disconnect('h1', 'a1');
    assert.equal(A.eng.stalledPeers.size, 0, '经房主得知的卡顿，房主断了就没人能解除');

    if (variant === '缓过来了') {
      stallOff(net.node('b1'));
    } else {
      net.disconnect('h1', 'b1');
    }
    net.flush();
    assert.equal(H.eng.stalledPeers.size, 0);

    net.connect('h1', 'a1');
    net.greet('h1', 'a1');
    net.greet('a1', 'h1');
    net.flush();
    assert.deepEqual([...A.eng.stalledPeers.keys()], []);
    assert.equal(A.eng.effectivePaused, false, 'a1 停在「等待 b1 缓冲」出不来');
    assert.equal(H.eng.effectivePaused, false);
    net.tick(10);
    assert.ok(near(net.pos('a1'), net.pos('h1')));
  });
}

impl('和房主断线期间那人一直卡着：重连后房主补发的同编号卡顿要重新认下', async (dir) => {
  const net = await relayedStallRoom(dir);
  const A = net.node('a1');
  net.disconnect('h1', 'a1');
  net.tick(5);
  net.connect('h1', 'a1');
  net.greet('h1', 'a1');
  net.greet('a1', 'h1');
  net.flush();
  assert.ok(A.eng.stalledPeers.has('b1'), '重连后补发的卡顿被当成重复丢掉了，a1 会自己播起来');
  assert.equal(A.eng.effectivePaused, true);
  // 之后他缓过来，经房主转发照常解除
  stallOff(net.node('b1'));
  net.flush();
  assert.equal(A.eng.stalledPeers.size, 0);
  assert.equal(A.eng.effectivePaused, false);
});

impl('网状下两条路都得知在卡：断掉其中任何一条都还记着，他自己说好了才解除', async (dir) => {
  // 和房主断线，直连还在
  let net = await relayedStallRoom(dir, { direct: true });
  let A = net.node('a1');
  assert.deepEqual([...A.eng.stalledPeers.get('b1').via].sort(), ['b1', 'h1']);
  net.disconnect('h1', 'a1');
  assert.ok(A.eng.stalledPeers.has('b1'), '直连还在，b1 也还卡着');
  stallOff(net.node('b1'));
  net.flush();
  assert.equal(A.eng.stalledPeers.size, 0);

  // 和他的直连断了（他没走，房主还在转发）
  net = await relayedStallRoom(dir, { direct: true });
  A = net.node('a1');
  net.disconnect('a1', 'b1');
  assert.ok(A.eng.stalledPeers.has('b1'), 'b1 还在房间里卡着，a1 却自己播起来了');
  assert.equal(A.eng.effectivePaused, true);
  stallOff(net.node('b1'));
  net.flush();
  assert.equal(A.eng.stalledPeers.size, 0);
  assert.equal(A.eng.effectivePaused, false);

  // 两条都断：记录作废
  net = await relayedStallRoom(dir, { direct: true });
  A = net.node('a1');
  net.disconnect('a1', 'b1');
  net.disconnect('h1', 'a1');
  assert.equal(A.eng.stalledPeers.size, 0);
});

/* ------------------------------ 4. 重连 greet 的快照平局（sync#3） ------------------------------ */

for (const [H, A, B] of PERMS) {
  // 「作者」：断线前最后一次操作是重连者自己做的。房主的快照这时不带 origin，
  // 重连者得照抄快照里的 by，作者记录才和房主一致（之后同 Lamport 的平局才裁决得一样）。
  for (const variant of ['管理员', '游客', '作者']) {
    impl(`重连时 Lamport 相同、外推位置不同：全房以房主为准（${variant}，${H}/${A}/${B}）`, async (dir) => {
      const net = await startRoom(dir, {
        host: H,
        members: [
          { id: A, role: variant === '游客' ? 'guest' : 'admin' },
          { id: B, role: 'admin', seeder: false },
        ],
      });
      if (variant === '作者') {
        net.node(A).eng.userSeek(0);
        net.flush();
        assert.equal(net.node(H).eng.shared.by, A, '前提：最后一次操作是重连者做的');
      }
      net.tick(100);
      net.disconnect(H, A);
      net.disconnect(A, B);
      // 断线期间 b 卡了 10 秒，房主和 b 的房间时钟停了，a 的没停；卡顿不推进 Lamport
      stallOn(net.node(B));
      net.flush();
      net.tick(10);
      stallOff(net.node(B));
      net.flush();
      net.tick(5);
      assert.ok(near(net.pos(H), 105) && near(net.pos(B), 105) && near(net.pos(A), 115), '前提');
      assert.equal(net.node(A).eng.shared.lamport, net.node(H).eng.shared.lamport, '前提：Lamport 相同');

      const remoteBefore = [H, A, B].map((id) => net.node(id).remote.length);
      net.connect(H, A);
      net.connect(A, B);
      net.greet(H, A);
      net.greet(A, H);
      net.greet(B, A);
      net.greet(A, B);
      net.flush();
      for (const id of [H, A, B]) assert.ok(near(net.pos(id), 105), `${id} 在 ${net.pos(id)}，应为 105`);
      assert.equal(net.node(A).eng.shared.by, net.node(H).eng.shared.by);
      assert.equal(net.node(B).eng.shared.by, net.node(H).eng.shared.by);
      assert.deepEqual(
        [H, A, B].map((id) => net.node(id).remote.length),
        remoteBefore,
        '位置校正不该当成别人的操作报出来'
      );
      net.tick(20);
      for (const id of [H, A, B]) assert.ok(near(net.pos(id), 125), `${id} 在 ${net.pos(id)}，应为 125`);
    });
  }

  impl(`断线的管理员自己卡住、时钟停了：重连后被房主校正，全房一起等他（${H}/${A}/${B}）`, async (dir) => {
    const net = await startRoom(dir, {
      host: H,
      members: [
        { id: A, role: 'admin', seeder: false },
        { id: B, role: 'admin' },
      ],
    });
    stallOff(net.node(A));
    net.tick(100);
    net.disconnect(H, A);
    net.disconnect(A, B);
    stallOn(net.node(A));
    net.flush();
    net.tick(10);
    assert.ok(near(net.pos(A), 100) && near(net.pos(H), 110), '前提');

    net.connect(H, A);
    net.connect(A, B);
    net.greet(H, A);
    net.greet(A, H);
    net.greet(B, A);
    net.greet(A, B);
    net.flush();
    for (const id of [H, A, B]) assert.ok(near(net.pos(id), 110), `${id} 在 ${net.pos(id)}，应为 110`);
    assert.ok(net.node(H).eng.stalledPeers.has(A));
    net.tick(5);
    for (const id of [H, A, B]) assert.ok(near(net.pos(id), 110), `有人卡着，${id} 的时钟不该走`);
    stallOff(net.node(A));
    net.flush();
    net.tick(5);
    for (const id of [H, A, B]) assert.ok(near(net.pos(id), 115), `${id} 在 ${net.pos(id)}，应为 115`);
  });

  impl(`房主自己断线期间有人卡过：重连后三方一致（${H}/${A}/${B}）`, async (dir) => {
    const net = await startRoom(dir, {
      host: H,
      members: [
        { id: A, role: 'admin' },
        { id: B, role: 'admin', seeder: false },
      ],
    });
    net.tick(100);
    net.disconnect(H, A);
    net.disconnect(H, B);
    stallOn(net.node(B));
    net.flush();
    net.tick(10);
    stallOff(net.node(B));
    net.flush();
    net.tick(5);
    net.connect(H, A);
    net.connect(H, B);
    net.greet(H, A);
    net.greet(A, H);
    net.greet(H, B);
    net.greet(B, H);
    net.flush();
    const want = net.pos(H);
    for (const id of [A, B]) assert.ok(near(net.pos(id), want), `${id} 在 ${net.pos(id)}，房主在 ${want}`);
    net.tick(7);
    for (const id of [A, B]) assert.ok(near(net.pos(id), net.pos(H)));
  });
}

impl('非房主的快照：平局时房主不采信也不转发；Lamport 更大时采信，转发出去不带快照标记', async (dir) => {
  const net = await startRoom(dir, {
    members: [
      { id: 'z9', role: 'admin' },
      { id: 'c1', role: 'guest' },
    ],
    links: [
      ['h1', 'z9'],
      ['h1', 'c1'],
    ],
  });
  const H = net.node('h1');
  const Z = net.node('z9');
  const C = net.node('c1');
  net.tick(50);
  const lamport = H.eng.shared.lamport;
  H.relayed.length = 0;
  // 和 greet 发的一样带着 z9 记着的作者：同一次操作，外推出的位置不同
  net.send('z9', 'h1', { t: 'sync', paused: true, position: 1, lamport, by: 'h1', seq: 1, snapshot: true });
  net.flush();
  assert.equal(H.eng.shared.by, 'h1', "平局时 'z9' > 'h1' 也不能靠快照赢");
  assert.equal(H.eng.intendedPaused, false);
  assert.ok(near(net.pos('h1'), 50), `房主被带到 ${net.pos('h1')}`);
  assert.equal(H.relayed.length, 0);

  // z9 断线期间自己暂停过（房主没收到），重连后他的快照 Lamport 更大
  net.disconnect('h1', 'z9');
  Z.eng.userSetPaused(true);
  net.connect('h1', 'z9');
  net.greet('z9', 'h1');
  net.flush();
  assert.equal(H.eng.intendedPaused, true);
  const relayedSync = H.relayed.filter((m) => m.t === 'sync');
  assert.equal(relayedSync.length, 1);
  assert.equal('snapshot' in relayedSync[0], false, '转发出去的还带着快照标记');
  assert.equal(C.eng.intendedPaused, true);
  assert.equal(C.eng.shared.by, 'z9');
});

impl('greet 发的 SYNC 带快照标记；房主的同 Lamport 快照只校正位置，不当成别人的操作', async (dir) => {
  const net = await startRoom(dir, { members: [{ id: 'g1', role: 'guest' }] });
  const G = net.node('g1');
  const sent = [];
  net.node('h1').eng.greet({ peerId: 'x', send: (m) => sent.push(m) });
  assert.equal(sent.find((m) => m.t === 'sync').snapshot, true);

  G.remote.length = 0;
  net.tick(30);
  G.eng._syncClock(99); // 游客本机的外推跑偏了
  net.greet('h1', 'g1');
  net.flush();
  assert.ok(near(net.pos('g1'), 30), `游客在 ${net.pos('g1')}`);
  assert.equal(G.eng.pendingSeek, net.pos('h1'));
  assert.equal(G.remote.length, 0);
});

/* ------------------------------ 5. 降级时在途的指令（sync#5） ------------------------------ */

impl('被降级者在途的指令被别人采信了：房主下一条（同 Lamport）照样生效', async (dir) => {
  const net = await startRoom(dir, {
    play: false,
    members: [
      { id: 'z1', role: 'admin' },
      { id: 'b1', role: 'guest' },
    ],
  });
  const H = net.node('h1');
  const Z = net.node('z1');
  const B = net.node('b1');
  assert.ok('z1' > 'h1', '前提：平局时 z1 的 peerId 会赢');
  // z1 按了播放，同时房主把他降为游客：房主先改了角色，b1 先收到了 z1 的指令
  Z.eng.userSetPaused(false);
  H.eng.setRole('z1', 'guest');
  net.flush();
  assert.equal(H.eng.intendedPaused, true, '前提：房主拒收');
  assert.equal(B.eng.intendedPaused, false, '前提：b1 已采信 z1 的播放');
  assert.equal(B.eng.shared.lamport, H.eng.shared.lamport + 1);

  H.eng.userSeek(30);
  net.flush();
  const hs = H.out.filter((m) => m.t === 'sync').at(-1);
  assert.equal(hs.lamport, B.eng.shared.lamport, '前提：两条同 Lamport');
  for (const n of [B, Z]) {
    assert.equal(n.eng.intendedPaused, true, `${n.id} 丢掉了房主的指令`);
    assert.equal(n.eng.shared.position, 30);
    assert.equal(n.eng.shared.by, 'h1');
  }
});

/**
 * 降级与 z1 的操作交叉：房主先改角色，z1 同时发出 zActions 里的指令。
 * a1 先收到角色表（拒收 z1 的指令），b1 先收到 z1 的指令（采信）再收到角色表。
 */
async function demoteRace(dir, zActions) {
  const net = await startRoom(dir, {
    play: false,
    members: [
      { id: 'z1', role: 'admin' },
      { id: 'a1', role: 'admin' },
      { id: 'b1', role: 'guest' },
    ],
  });
  net.node('h1').eng.setRole('z1', 'guest');
  const roleMsgs = net.queue.splice(0);
  zActions(net.node('z1').eng);
  const zMsgs = net.queue.splice(0);
  const deliver = (list, to) => {
    for (const q of list) if (q.to === to) net.node(to).eng.onCtrl(q.msg, { peerId: q.from, name: q.from });
  };
  deliver(roleMsgs, 'a1');
  deliver(zMsgs, 'a1');
  deliver(zMsgs, 'h1');
  deliver(zMsgs, 'b1');
  deliver(roleMsgs, 'b1');
  deliver(roleMsgs, 'z1');
  assert.equal(net.node('b1').eng.intendedPaused, false, '前提：b1 采信了 z1 的播放');
  assert.equal(net.node('a1').eng.intendedPaused, true, '前提：a1 拒收了');
  assert.equal(net.node('h1').eng.intendedPaused, true, '前提：房主拒收了');
  return net;
}

impl('降级时在途的指令被 b1 采信：现任管理员同 Lamport 的直连指令，b1 也要认', async (dir) => {
  const net = await demoteRace(dir, (z) => z.userSetPaused(false));
  const A = net.node('a1');
  const B = net.node('b1');
  assert.ok('a1' < 'z1', "前提：平局按 peerId 比，'a1' 会输");
  A.eng.userSeek(20);
  const as = A.out.filter((m) => m.t === 'sync').at(-1);
  assert.equal(as.lamport, B.eng.shared.lamport, '前提：同 Lamport');
  // 只走直连这一条（房主的转发还没到）
  B.eng.onCtrl(JSON.parse(JSON.stringify(as)), { peerId: 'a1', name: 'a1' });
  assert.equal(B.eng.shared.position, 20, 'b1 按 peerId 把现任管理员的指令丢了');
  assert.equal(B.eng.intendedPaused, true);
  assert.equal(B.eng.shared.by, 'a1');
  net.flush();
  for (const id of ['h1', 'z1', 'b1']) assert.equal(net.node(id).eng.shared.position, 20, id);
});

impl('被降级者连发了几条在途指令：现任管理员 Lamport 更小的指令，经房主转发后照样生效', async (dir) => {
  const net = await demoteRace(dir, (z) => {
    z.userSetPaused(false);
    z.userSeek(90);
  });
  const H = net.node('h1');
  const Z = net.node('z1');
  const A = net.node('a1');
  const B = net.node('b1');
  assert.equal(B.eng.shared.position, 90);
  A.eng.userSeek(40);
  const as = A.out.filter((m) => m.t === 'sync').at(-1);
  assert.ok(as.lamport < B.eng.shared.lamport, '前提：a1 的指令比 b1 采信的那条小');
  net.flush();
  assert.equal(H.eng.shared.position, 40);
  for (const n of [B, Z]) {
    assert.equal(n.eng.shared.position, 40, `${n.id}：经房主转发的现任管理员指令被当成旧的`);
    assert.equal(n.eng.intendedPaused, true);
    assert.equal(n.eng.shared.by, 'a1');
  }
  // 之后大家继续按 Lamport 往上走
  H.eng.userSetPaused(false);
  net.flush();
  for (const n of [A, B, Z]) assert.equal(n.eng.intendedPaused, false, n.id);
});

/* ------------------------------ 6. 审查后的收尾 ------------------------------ */

// 窗口的基准：网状下只有我采信、没被转发的直连指令，不能抬高我之后发出的 Lamport
for (const order of ['先按再降级', '先降级再按']) {
  impl(`网状：恶意管理员只给一位管理员直发窗口边上的指令，这位管理员之后的操作全房照收（${order}）`, async (dir) => {
    const { LAMPORT_WINDOW } = await import(dir + 'syncEngine.js');
    const net = await startRoom(dir, {
      members: [
        { id: 'm1', role: 'admin' },
        { id: 'v1', role: 'admin' },
        { id: 'g1', role: 'guest' },
      ],
    });
    const H = net.node('h1');
    const V = net.node('v1');
    const G = net.node('g1');
    const base = Math.max(V.eng.clock, V.eng.shared.lamport);
    net.send('m1', 'v1', { t: 'sync', paused: false, position: 0, lamport: base + LAMPORT_WINDOW, seq: 1 });
    net.flush();
    assert.equal(V.eng.shared.lamport, base + LAMPORT_WINDOW, '前提：v1 采信了');
    assert.ok(H.eng.shared.lamport <= base, '前提：房主没见过');

    const act = () => {
      V.eng.userSeek(50);
      net.flush();
    };
    const demote = () => {
      H.eng.setRole('m1', 'guest');
      net.flush();
    };
    if (order === '先按再降级') {
      act();
      demote();
    } else {
      demote();
      act();
    }
    for (const n of [H, G]) {
      assert.equal(n.eng.shared.position, 50, `${n.id} 拒收了 v1 的跳转`);
      assert.equal(n.eng.shared.by, 'v1');
      assert.equal(n.eng.shared.lamport, V.eng.shared.lamport);
    }
    for (let i = 0; i < 3; i++) {
      H.eng.userSetPaused(i % 2 === 0);
      net.flush();
      H.eng.userSeek(100 + i);
      net.flush();
      for (const n of [V, G]) {
        assert.equal(n.eng.intendedPaused, H.eng.intendedPaused, `第 ${i} 轮 ${n.id} 的暂停状态和房主不同`);
        assert.equal(n.eng.shared.position, 100 + i, `第 ${i} 轮 ${n.id} 没跟上房主`);
      }
    }
  });
}

impl('网状：恶意管理员连发几条只给一个人，降级后这个人、房主、其他管理员的指令互相都收', async (dir) => {
  const { LAMPORT_WINDOW } = await import(dir + 'syncEngine.js');
  const net = await startRoom(dir, {
    members: [
      { id: 'm1', role: 'admin' },
      { id: 'd1', role: 'admin' },
      { id: 'e1', role: 'admin' },
    ],
  });
  const H = net.node('h1');
  const D = net.node('d1');
  const E = net.node('e1');
  for (let i = 0; i < 3; i++) {
    net.send('m1', 'd1', {
      t: 'sync',
      paused: true,
      position: 500 + i,
      lamport: Math.max(D.eng.clock, D.eng.shared.lamport) + LAMPORT_WINDOW,
      seq: 1,
    });
    net.flush();
  }
  assert.equal(D.eng.shared.by, 'm1', '前提：d1 采信了 m1 的指令');
  assert.equal(H.eng.shared.by, 'h1');
  const state = (n) => [n.eng.shared.lamport, n.eng.shared.by, n.eng.shared.position, n.eng.intendedPaused];
  const same = (label) => {
    for (const n of [H, E]) assert.deepEqual(state(n), state(D), `${label}：${n.id} 和 d1 分叉了`);
  };

  H.eng.setRole('m1', 'guest');
  net.flush();
  D.eng.userSeek(10);
  net.flush();
  same('d1 拖回进度之后');
  assert.equal(H.eng.shared.position, 10);
  for (let i = 0; i < 5; i++) {
    H.eng.userSetPaused(i % 2 === 0);
    net.flush();
  }
  same('房主连按几下之后');
  E.eng.userSeek(88);
  net.flush();
  same('e1 跳转之后');
  D.eng.userSeek(33);
  net.flush();
  same('d1 再跳转之后');
  assert.equal(H.eng.shared.position, 33);
  H.eng.userSeek(44);
  net.flush();
  same('房主跳转之后');
  assert.equal(D.eng.shared.position, 44);
});

// 直连来的卡顿因为角色表没到被拒，只经房主记下：他本人有直连，他缓过来时照样会直接说
impl('新人先连上正卡着的管理员（角色表还没到），再连房主：和房主的连接抖一下，仍然记着他在卡', async (dir) => {
  const net = makeNet(dir);
  const roles = [['b1', 'admin']];
  const H = await net.add('h1', { hostId: 'h1', roles });
  const B = await net.add('b1', { hostId: 'h1', roles, isSeeder: false });
  net.connect('h1', 'b1');
  B.eng.resetMedia({ seq: 1 });
  H.eng.resetMedia({ seq: 1, broadcast: true });
  net.flush();
  H.eng.userSetPaused(false);
  net.flush();
  stallOn(B);
  net.flush();
  net.tick(3);

  // 新人只知道房主是谁
  const M = await net.add('m1', { hostId: 'h1', roles: [] });
  M.eng.resetMedia({ seq: 1 });
  net.connect('b1', 'm1');
  net.greet('b1', 'm1');
  net.greet('m1', 'b1');
  net.flush();
  assert.equal(M.eng.stalledPeers.has('b1'), false, '前提：b1 直连报的卡顿被拒了');
  net.connect('h1', 'm1');
  net.greet('h1', 'm1');
  net.greet('m1', 'h1');
  net.flush();
  assert.ok(M.eng.stalledPeers.has('b1'), '前提：经房主得知 b1 在卡');

  net.disconnect('h1', 'm1');
  assert.ok(M.eng.stalledPeers.has('b1'), 'b1 还在卡、和 m1 的直连也还在，m1 却忘了');
  assert.equal(M.eng.effectivePaused, true);
  net.tick(10);
  assert.ok(near(net.pos('m1'), net.pos('h1')), `m1 在 ${net.pos('m1')}，房主在 ${net.pos('h1')}`);

  // 他缓过来，直连告诉 m1
  stallOff(B);
  net.flush();
  assert.equal(M.eng.stalledPeers.size, 0);
  assert.equal(M.eng.effectivePaused, false);

  // 再卡一次，这回直连也断了：记录作废（没人能告诉 m1 他好了）
  stallOn(B);
  net.flush();
  assert.ok(M.eng.stalledPeers.has('b1'));
  net.disconnect('b1', 'm1');
  assert.equal(M.eng.stalledPeers.size, 0);
});

// 房主的同 Lamport 快照：作者不同就是两次不同的操作，按 peerId 裁决，不能直接盖掉我刚发出的指令
for (const topo of ['星型', '网状']) {
  impl(`重连后还没处理房主的快照就按了播放：三方按同一规则裁决，不分叉（${topo}）`, async (dir) => {
    const net = await startRoom(dir, {
      play: false,
      members: [
        { id: 'z1', role: 'admin' },
        { id: 'b1', role: 'admin' },
      ],
      links:
        topo === '星型'
          ? [
              ['h1', 'z1'],
              ['h1', 'b1'],
            ]
          : undefined,
    });
    const H = net.node('h1');
    const Z = net.node('z1');
    const B = net.node('b1');
    net.disconnect('h1', 'z1');
    if (topo === '网状') net.disconnect('b1', 'z1');
    B.eng.userSeek(20); // z1 断线期间 b1 跳了一下
    net.flush();
    net.connect('h1', 'z1');
    net.greet('h1', 'z1');
    net.greet('z1', 'h1');
    Z.eng.userSetPaused(false); // 房主的快照还在路上
    net.flush();
    if (topo === '网状') {
      net.connect('b1', 'z1');
      net.greet('b1', 'z1');
      net.greet('z1', 'b1');
      net.flush();
    }
    const state = (n) => [n.eng.shared.lamport, n.eng.shared.by, n.eng.shared.position, n.eng.intendedPaused];
    assert.deepEqual(state(Z), state(H), 'z1 和房主分叉了');
    assert.deepEqual(state(B), state(H), 'b1 和房主分叉了');
    assert.equal(H.eng.shared.by, 'z1', "同 Lamport 时 'z1' > 'b1'");
    assert.equal(Z.eng.intendedPaused, false);
  });
}

for (const [x, y] of [
  ['z1', 'a1'],
  ['a1', 'z1'],
]) {
  impl(`断线期间两位管理员各操作一次、Lamport 撞了：重连后按 peerId 收敛（断线的是 ${x}）`, async (dir) => {
    const net = await startRoom(dir, {
      members: [
        { id: x, role: 'admin' },
        { id: y, role: 'admin' },
      ],
    });
    const H = net.node('h1');
    const X = net.node(x);
    const Y = net.node(y);
    net.disconnect('h1', x);
    net.disconnect(x, y);
    X.eng.userSeek(70); // 谁也没收到
    Y.eng.userSeek(30); // 房主采信了
    net.flush();
    assert.equal(X.eng.shared.lamport, H.eng.shared.lamport, '前提：Lamport 相同');

    net.connect('h1', x);
    net.connect(x, y);
    net.greet('h1', x);
    net.greet(x, 'h1');
    net.greet(x, y);
    net.greet(y, x);
    net.flush();
    const winner = x > y ? x : y;
    const state = (n) => [n.eng.shared.lamport, n.eng.shared.by, n.eng.shared.position, n.eng.intendedPaused];
    for (const n of [X, Y]) assert.deepEqual(state(n), state(H), `${n.id} 和房主分叉了`);
    assert.equal(H.eng.shared.by, winner);
    assert.equal(H.eng.shared.position, winner === x ? 70 : 30);
  });
}

impl('快照里的作者不是发来的人：房主记在原作者名下，转发出去也是', async (dir) => {
  const net = await startRoom(dir, {
    members: [
      { id: 'x1', role: 'admin' },
      { id: 'y1', role: 'admin' },
      { id: 'c1', role: 'guest' },
    ],
  });
  const H = net.node('h1');
  const X = net.node('x1');
  const C = net.node('c1');
  // y1 只和 x1 连着：他的跳转只有 x1 收到
  net.disconnect('h1', 'y1');
  net.disconnect('c1', 'y1');
  net.node('y1').eng.userSeek(40);
  net.flush();
  assert.equal(X.eng.shared.by, 'y1', '前提');
  assert.notEqual(H.eng.shared.by, 'y1', '前提');
  // x1 和房主的连接抖一下，重连时的快照把 y1 的跳转带给房主
  net.disconnect('h1', 'x1');
  net.connect('h1', 'x1');
  net.greet('h1', 'x1');
  net.greet('x1', 'h1');
  net.flush();
  for (const n of [H, X, C]) {
    assert.equal(n.eng.shared.by, 'y1', `${n.id} 把作者记成了 ${n.eng.shared.by}`);
    assert.equal(n.eng.shared.position, 40);
    assert.equal(n.eng.shared.lamport, X.eng.shared.lamport);
  }
});

// 同一次操作的房主快照只校正房间时钟：游客自己的暂停不广播，本来就可以和房间不同
for (const topo of ['星型', '网状']) {
  impl(`游客自己暂停着，和房主重连：房主的快照不改他的暂停、不拽他的进度（${topo}）`, async (dir) => {
    const net = await startRoom(dir, {
      members: [
        { id: 'g1', role: 'guest' },
        { id: 'a1', role: 'admin' },
      ],
      links:
        topo === '星型'
          ? [
              ['h1', 'g1'],
              ['h1', 'a1'],
            ]
          : undefined,
    });
    const G = net.node('g1');
    const calls = [];
    G.eng.onSeek = (p) => calls.push(['seek', p]);
    G.eng.onSetPause = (p) => calls.push(['pause', p]);
    net.tick(10);
    G.eng.userSetPaused(true); // 只停自己
    net.flush();
    assert.equal(G.out.filter((m) => m.t === 'sync').length, 0, '前提：游客的暂停不广播');
    assert.equal(net.node('h1').eng.intendedPaused, false);
    net.tick(30);
    G.eng._syncClock(99); // 本机外推的房间时钟跑偏了
    G.eng.pendingSeek = null;
    calls.length = 0;
    const remoteBefore = G.remote.length;

    net.disconnect('h1', 'g1');
    net.connect('h1', 'g1');
    net.greet('h1', 'g1');
    net.greet('g1', 'h1');
    net.flush();
    assert.equal(G.eng.intendedPaused, true, '游客自己的暂停被房主的快照改掉了');
    assert.equal(G.eng.effectivePaused, true);
    assert.deepEqual(
      calls.filter((c) => c[0] === 'seek' || (c[0] === 'pause' && c[1] === false)),
      [],
      '游客的播放器被拽走或放起来了'
    );
    assert.equal(G.eng.pendingSeek, null, '游客的进度被记下要拽走');
    assert.equal(G.remote.length, remoteBefore);
    // 房间时钟照样校正
    assert.ok(near(net.pos('g1'), net.pos('h1')), `游客的房间时钟在 ${net.pos('g1')}，房主在 ${net.pos('h1')}`);

    // 房间真有新操作时照旧跟随
    net.node('a1').eng.userSeek(5);
    net.flush();
    assert.equal(G.eng.shared.position, 5);
  });
}

// 被降级者在途的指令只有 x1 采信了：重连时既不能借 x1 的快照复活，x1 也要回到房主的现状
async function orphanRoom(dir, { xKnowsDemotion }) {
  const net = await startRoom(dir, {
    play: false,
    members: [
      { id: 'z1', role: 'admin' },
      { id: 'a1', role: 'admin' },
      { id: 'x1', role: 'admin' },
    ],
  });
  net.node('h1').eng.setRole('z1', 'guest');
  const roleMsgs = net.queue.splice(0);
  net.node('z1').eng.userSetPaused(false);
  net.node('z1').eng.userSeek(90);
  const zMsgs = net.queue.splice(0);
  const deliver = (list, to) => {
    for (const q of list) if (q.to === to) net.node(to).eng.onCtrl(q.msg, { peerId: q.from, name: q.from });
  };
  deliver(roleMsgs, 'a1');
  deliver(zMsgs, 'a1');
  deliver(zMsgs, 'h1');
  deliver(zMsgs, 'x1');
  if (xKnowsDemotion) deliver(roleMsgs, 'x1');
  deliver(roleMsgs, 'z1');
  const X = net.node('x1');
  assert.equal(X.eng.shared.by, 'z1', '前提：x1 采信了 z1 的指令');
  assert.equal(X.eng.shared.position, 90);
  assert.equal(net.node('h1').eng.shared.position, 0, '前提：房主拒收了');
  return net;
}

for (const xKnowsDemotion of [true, false]) {
  const label = xKnowsDemotion ? '已经知道他被降级' : '断线前还没收到降级';
  impl(`x1 采信了被降级者在途的指令，和房主重连：各方回到房主的现状（${label}）`, async (dir) => {
    const net = await orphanRoom(dir, { xKnowsDemotion });
    const H = net.node('h1');
    const X = net.node('x1');
    const want = [H.eng.shared.lamport, 'h1', 0, true];
    net.disconnect('h1', 'x1');
    net.connect('h1', 'x1');
    net.greet('h1', 'x1');
    net.greet('x1', 'h1');
    net.flush();
    assert.equal(X.eng.roleOf('z1'), 'guest');
    const state = (n) => [n.eng.shared.lamport, n.eng.shared.by, n.eng.shared.position, n.eng.intendedPaused];
    for (const id of ['h1', 'a1', 'x1']) assert.deepEqual(state(net.node(id)), want, `${id} 的状态不对`);
    // 房主下一条指令，被降级者也跟上
    H.eng.userSeek(15);
    net.flush();
    for (const id of ['z1', 'a1', 'x1']) assert.equal(net.node(id).eng.shared.position, 15, id);
  });
}

impl('x1 采信了被降级者在途的指令，和另一位管理员重连：不会把那条指令带给他', async (dir) => {
  const net = await orphanRoom(dir, { xKnowsDemotion: true });
  const A = net.node('a1');
  const state = () => [A.eng.shared.lamport, A.eng.shared.by, A.eng.shared.position, A.eng.intendedPaused];
  const before = state();
  net.disconnect('a1', 'x1');
  net.connect('a1', 'x1');
  net.greet('a1', 'x1');
  net.greet('x1', 'a1');
  net.flush();
  assert.deepEqual(state(), before, 'a1 被带到了已被拒收的那条指令');
  assert.equal(A.eng.intendedPaused, true);
});

impl('时钟被单独顶高之后连按两下：第二下的 Lamport 照样往上走，别人不会当成重复', async (dir) => {
  const { LAMPORT_WINDOW } = await import(dir + 'syncEngine.js');
  const net = await startRoom(dir, {
    members: [
      { id: 'm1', role: 'admin' },
      { id: 'b1', role: 'admin' },
    ],
  });
  const H = net.node('h1');
  const B = net.node('b1');
  // 上一部的：不会被采信，只把 b1 的时钟顶高
  net.send('m1', 'b1', {
    t: 'sync',
    paused: false,
    position: 1,
    lamport: B.eng.clock + LAMPORT_WINDOW,
    seq: 0,
  });
  net.flush();
  B.eng.userSeek(33);
  B.eng.userSeek(34);
  const [first, second] = B.out.filter((m) => m.t === 'sync').slice(-2);
  assert.ok(second.lamport > first.lamport, `两下的 Lamport：${first.lamport}、${second.lamport}`);
  net.flush();
  assert.equal(H.eng.shared.position, 34, '第二下被房主当成重复丢掉了');
});

impl('网状：全房时钟经房主抬到窗口之外，管理员直连发来的指令当场就收', async (dir) => {
  const { LAMPORT_WINDOW } = await import(dir + 'syncEngine.js');
  const net = await startRoom(dir, {
    members: [
      { id: 'm1', role: 'admin' },
      { id: 'a1', role: 'admin' },
      { id: 'b1', role: 'admin' },
    ],
  });
  const H = net.node('h1');
  const A = net.node('a1');
  const B = net.node('b1');
  // m1 只发给房主，房主采信后转发给所有人
  for (let i = 0; i < 3; i++) {
    net.send('m1', 'h1', {
      t: 'sync',
      paused: false,
      position: i,
      lamport: Math.max(H.eng.clock, H.eng.shared.lamport) + LAMPORT_WINDOW,
      seq: 1,
    });
    net.flush();
  }
  assert.ok(B.eng.shared.lamport >= 3 * LAMPORT_WINDOW, '前提：全房时钟已被抬高');
  A.eng.userSeek(20);
  const direct = net.queue.splice(0).filter((q) => q.to === 'b1');
  assert.equal(direct.length, 1);
  // 只走直连（房主的转发还没到）
  B.eng.onCtrl(direct[0].msg, { peerId: 'a1', name: 'a1' });
  assert.equal(B.eng.shared.position, 20, 'b1 按窗口把直连来的合法指令拒了');
  assert.equal(B.eng.shared.by, 'a1');
});

impl('和他的直连已经断了：经房主得知的卡顿，房主一断就作废', async (dir) => {
  const net = await startRoom(dir, {
    members: [
      { id: 'a1', role: 'admin' },
      { id: 'b1', role: 'admin', seeder: false },
    ],
  });
  const A = net.node('a1');
  net.greet('b1', 'a1');
  net.greet('a1', 'b1');
  net.flush();
  net.disconnect('a1', 'b1');
  stallOn(net.node('b1'));
  net.flush();
  assert.deepEqual([...A.eng.stalledPeers.get('b1').via], ['h1'], '前提：只经房主得知');
  net.disconnect('h1', 'a1');
  assert.equal(A.eng.stalledPeers.size, 0, '和 b1 已经没有直连，房主断了就没人能告诉 a1 他好了');
  assert.equal(A.eng.effectivePaused, false);
});

impl('房主的快照记在已被降级的人名下、我这边同 Lamport 是现任管理员的：两边都认现任管理员的', async (dir) => {
  const net = await startRoom(dir, {
    members: [
      { id: 'z1', role: 'admin' },
      { id: 'b1', role: 'admin' },
    ],
  });
  const H = net.node('h1');
  const B = net.node('b1');
  assert.ok('z1' > 'b1', '前提：只比 peerId 的话 z1 会赢');
  net.disconnect('h1', 'b1');
  net.disconnect('z1', 'b1');
  B.eng.userSeek(60); // 谁也没收到
  net.node('z1').eng.userSeek(25); // 房主采信了
  net.flush();
  assert.equal(B.eng.shared.lamport, H.eng.shared.lamport, '前提：Lamport 相同');
  H.eng.setRole('z1', 'guest');
  net.flush();
  assert.equal(H.eng.shared.by, 'z1', '前提：房主的现状记在被降级的 z1 名下');

  net.connect('h1', 'b1');
  net.greet('h1', 'b1');
  net.greet('b1', 'h1');
  net.flush();
  const state = (n) => [n.eng.shared.lamport, n.eng.shared.by, n.eng.shared.position, n.eng.intendedPaused];
  assert.deepEqual(state(B), state(H), 'b1 和房主分叉了');
  assert.equal(H.eng.shared.by, 'b1');
  assert.equal(H.eng.shared.position, 60);
});
