'use strict';

// 昵称：重名临时编号、进房后改名（NAME 消息的收发、清洗、限速）、同步引擎里的名字副本
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { IMPLS } = require('./helpers/impls');

const LIB = path.join(__dirname, '../src/renderer/lib');
const load = (file) => import(pathToFileURL(path.join(LIB, file)).href);

/* ------------------------------ 重名编号 ------------------------------ */

test('没人重名时名字原样', async () => {
  const { numberDuplicateNames } = await load('chat.js');
  const names = numberDuplicateNames([
    { id: 'b', name: '小明' },
    { id: 'a', name: '阿花' },
  ]);
  assert.deepEqual([...names], [
    ['b', '小明'],
    ['a', '阿花'],
  ]);
});

test('重名的按 id 排序，排第一的保持原名，其余依次 #2、#3；和谁先进来无关', async () => {
  const { numberDuplicateNames } = await load('chat.js');
  const members = [
    { id: 'p3', name: '小明' },
    { id: 'p1', name: '小明' },
    { id: 'x', name: '阿花' },
    { id: 'p2', name: '小明' },
  ];
  const names = numberDuplicateNames(members);
  assert.equal(names.get('p1'), '小明');
  assert.equal(names.get('p2'), '小明 #2');
  assert.equal(names.get('p3'), '小明 #3');
  assert.equal(names.get('x'), '阿花');
  // 换个顺序看到的是同一套编号：房间里看到同一批人的成员算出来一样
  const again = numberDuplicateNames([...members].reverse());
  for (const { id } of members) assert.equal(again.get(id), names.get(id));
});

test('编号撞上别人的真名就往后跳；同一个 id 出现两次只算一次', async () => {
  const { numberDuplicateNames } = await load('chat.js');
  const names = numberDuplicateNames([
    { id: 'a', name: '小明' },
    { id: 'b', name: '小明' },
    { id: 'c', name: '小明 #2' },
    { id: 'a', name: '小明' },
  ]);
  assert.equal(names.get('a'), '小明');
  assert.equal(names.get('c'), '小明 #2', '真叫「小明 #2」的人不动');
  assert.equal(names.get('b'), '小明 #3');
  assert.equal(names.size, 3);
});

/* ------------------------------ 改名：发 ------------------------------ */

function fakePeer(peerId, { authenticated = true } = {}) {
  return {
    peerId,
    name: peerId,
    pc: { iceConnectionState: 'connected' },
    authenticated,
    remote: new Map(),
    inflight: new Set(),
    ctrl: { readyState: 'open', bufferedAmount: 0 },
    sent: [],
    send(m) {
      this.sent.push(m);
      return true;
    },
    on() {
      return () => {};
    },
    close() {},
    async sendChunk() {},
    ping() {},
    hello() {},
  };
}

test('setName：清洗后发给握过手的人，没握手的不发；和原来一样或清洗后为空就不动', async () => {
  const { Swarm } = await load('swarm.js');
  const swarm = new Swarm({ peerId: 'me', name: '旧名字' });
  const a = swarm.addPeer(fakePeer('pa'));
  const b = swarm.addPeer(fakePeer('pb', { authenticated: false }));
  const names = (p) => p.sent.filter((m) => m.t === 'name').map((m) => m.name);

  assert.equal(swarm.setName('  新\u0000名字 \n  '), true);
  assert.equal(swarm.name, '新名字', '控制字符去掉、两头空白去掉');
  assert.deepEqual(names(a), ['新名字']);
  assert.deepEqual(names(b), [], '没握手的连接不许收到任何房间消息');

  assert.equal(swarm.setName(swarm.name), false, '没变不发');
  assert.equal(swarm.setName('   '), false, '空名字不要');
  assert.equal(swarm.setName(42), false);
  assert.equal(names(a).length, 1);
  assert.ok(Array.from(swarm.name).length <= 40);
  swarm.setName('长'.repeat(500));
  assert.equal(Array.from(swarm.name).length, 40, '截到 40 字');
});

/* ------------------------------ 改名：收 ------------------------------ */

for (const { name: implName, dir } of IMPLS) {
  const loadImpl = (file) => import(pathToFileURL(path.join(__dirname, dir, file)).href);

  test(`${implName}：收到 NAME：清洗后换名字、发 peer-renamed；2 秒内再改先记下、到点只换最后一次；空的、一样的不理`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 });
    const { Swarm } = await loadImpl('swarm.js');
    const swarm = new Swarm({ peerId: 'me', name: '我' });
    const peer = swarm.addPeer(fakePeer('pa'));
    peer.name = '阿花';
    const events = [];
    swarm.on('peer-renamed', (e) => events.push(e));

    swarm._onCtrl(peer, { t: 'name', name: ' 花花\u202E ' });
    assert.equal(peer.name, '花花');
    assert.deepEqual(events, [{ peerId: 'pa', name: '花花', oldName: '阿花' }]);
    assert.equal(swarm.peerList().find((p) => p.peerId === 'pa').name, '花花');

    // 改错字马上又改：间隔内先不换（成员表和聊天不会被刷屏），但也不能悄悄丢掉
    t.mock.timers.tick(500);
    swarm._onCtrl(peer, { t: 'name', name: '又改了' });
    swarm._onCtrl(peer, { t: 'name', name: '改错了再改' });
    assert.equal(peer.name, '花花', '2 秒内连着改的先不换');
    assert.equal(events.length, 1);
    t.mock.timers.tick(1499);
    assert.equal(peer.name, '花花');
    t.mock.timers.tick(1);
    assert.equal(peer.name, '改错了再改', '到点只换最后一次，两边看到的名字最终一致');
    assert.deepEqual(events[1], { peerId: 'pa', name: '改错了再改', oldName: '花花' });
    assert.equal(events.length, 2, '中间那次不单独报');

    // 间隔内改回原名：到点一看没变，什么都不报
    swarm._onCtrl(peer, { t: 'name', name: '临时' });
    swarm._onCtrl(peer, { t: 'name', name: '改错了再改' });
    t.mock.timers.tick(5000);
    assert.equal(peer.name, '改错了再改');
    assert.equal(events.length, 2);

    for (const bad of ['', '   ', null, 42, { name: 'x' }, '改错了再改']) swarm._onCtrl(peer, { t: 'name', name: bad });
    t.mock.timers.tick(5000);
    assert.equal(peer.name, '改错了再改');
    assert.equal(events.length, 2);

    swarm._onCtrl(peer, { t: 'name', name: 'x'.repeat(100_000) });
    assert.equal(peer.name.length, 40, '几十 KB 的名字截到 40 字');
  });

  test(`${implName}：间隔内记下的改名，人走了就作废`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 });
    const { Swarm } = await loadImpl('swarm.js');
    const swarm = new Swarm({ peerId: 'me', name: '我' });
    const peer = swarm.addPeer(fakePeer('pa'));
    let fired = 0;
    swarm.on('peer-renamed', () => fired++);
    swarm._onCtrl(peer, { t: 'name', name: '一' });
    swarm._onCtrl(peer, { t: 'name', name: '二' });
    assert.equal(fired, 1);
    swarm.removePeer('pa');
    t.mock.timers.tick(5000);
    assert.equal(fired, 1);
    assert.equal(peer.name, '一');
  });

  test(`${implName}：HELLO 里的昵称和 NAME、聊天走同一个 clampName；清洗后为空就用信令给的，再不行用 peerId`, async () => {
    const { Swarm } = await loadImpl('swarm.js');
    const { numberDuplicateNames } = await loadImpl('chat.js');
    const swarm = new Swarm({ peerId: 'me', name: '我' });
    const helloFrom = (peerId, name, signaled) => {
      const peer = swarm.addPeer(fakePeer(peerId, { authenticated: false }));
      if (signaled !== undefined) peer.name = signaled;
      swarm._onCtrl(peer, { t: 'hello', peerId, name, ver: 2, securityMode: 'safe', platform: 'windows' });
      assert.equal(peer.authenticated, true, peerId);
      return peer;
    };

    // 双向覆盖字符能让「花阿」显示成「阿花」：去掉，换行和首尾空白一并清掉
    assert.equal(helloFrom('p1', '\u202E花阿\n\t ').name, '花阿');
    // 纯空白：退回信令 / 邀请码给的名字；那个名字也要清洗，都不行就用 peerId
    assert.equal(helloFrom('p2', '   ', '信令给的').name, '信令给的');
    assert.equal(helloFrom('p3', undefined, ' \u202E ').name, 'p3');
    assert.equal(helloFrom('p4', 42, '邀请码给的').name, '邀请码给的');
    // 按码点截到 40 字，emoji 不会被拦腰截断
    const long = helloFrom('p5', '😀'.repeat(60)).name;
    assert.equal(Array.from(long).length, 40);
    assert.ok(!/[\uD800-\uDBFF]$/.test(long));
    // 「小明 」和「小明」清洗后是同一个名字，重名照样编号
    const a = helloFrom('p6', '小明 ');
    const b = helloFrom('p7', '小明');
    const shown = numberDuplicateNames([a, b].map((p) => ({ id: p.peerId, name: p.name })));
    assert.deepEqual([shown.get('p6'), shown.get('p7')], ['小明', '小明 #2']);
    assert.equal(swarm.peerList().find((p) => p.peerId === 'p1').name, '花阿');
  });

  test(`${implName}：版本不对的 HELLO 报出来的名字、renamePeer 换上的名字也清洗`, async () => {
    const { Swarm } = await loadImpl('swarm.js');
    const swarm = new Swarm({ peerId: 'me', name: '我' });
    const mismatches = [];
    swarm.on('version-mismatch', (e) => mismatches.push(e.name));
    const old = swarm.addPeer(fakePeer('old-1', { authenticated: false }));
    swarm._onCtrl(old, { t: 'hello', peerId: 'old-1', name: '\u202E客户端旧', ver: 1 });
    assert.deepEqual(mismatches, ['客户端旧']);

    const temp = swarm.addPeer(fakePeer('pending-01', { authenticated: false }));
    temp.allowIdentityRename = true;
    swarm._onCtrl(temp, { t: 'hello', peerId: 'real-01', name: ' 真名\u2066 ', ver: 2, securityMode: 'safe' });
    assert.equal(temp.peerId, 'real-01');
    assert.equal(temp.name, '真名');
    assert.equal(swarm.renamePeer('real-01', 'real-02', '\u202E'), true);
    assert.equal(temp.name, '真名', '清洗后为空不覆盖');
  });

  test(`${implName}：HELLO 发出去、对方还没认证时改的名，认证时补一条 NAME`, async () => {
    const { Swarm } = await loadImpl('swarm.js');
    const swarm = new Swarm({ peerId: 'me', name: '旧名字' });
    // 带事件的假连接：swarm 在 open 时发 HELLO
    const withEvents = (peerId) => {
      const peer = fakePeer(peerId, { authenticated: false });
      const handlers = {};
      peer.on = (ev, fn) => {
        (handlers[ev] ||= []).push(fn);
        return () => {};
      };
      peer.fire = (ev, ...args) => (handlers[ev] || []).forEach((fn) => fn(...args));
      peer.hellos = [];
      peer.hello = (...args) => peer.hellos.push(args);
      return peer;
    };
    const names = (p) => p.sent.filter((m) => m.t === 'name').map((m) => m.name);
    const hello = (peerId) => ({ t: 'hello', peerId, name: '对方', ver: 2, securityMode: 'safe' });

    const a = swarm.addPeer(withEvents('pa'));
    a.fire('open');
    assert.equal(a.hellos[0][1], '旧名字');
    swarm.setName('新名字');
    assert.deepEqual(names(a), [], '还没认证的连接收不到 NAME');
    swarm._onCtrl(a, hello('pa'));
    assert.deepEqual(names(a), ['新名字'], '认证时补上，对方不会一直显示 HELLO 里的旧名');

    // 没改过名的不补
    const b = swarm.addPeer(withEvents('pb'));
    b.fire('open');
    swarm._onCtrl(b, hello('pb'));
    assert.deepEqual(names(b), []);

    // 还没发 HELLO（open 之前）就改了名：HELLO 本身就带新名字，也不用补
    const c = swarm.addPeer(withEvents('pc'));
    swarm.setName('再改');
    c.fire('open');
    assert.equal(c.hellos[0][1], '再改');
    swarm._onCtrl(c, hello('pc'));
    assert.deepEqual(names(c), []);
  });
}

test('没握手的连接发 NAME 不理', async () => {
  const { Swarm } = await load('swarm.js');
  const swarm = new Swarm({ peerId: 'me', name: '我' });
  const peer = swarm.addPeer(fakePeer('pa', { authenticated: false }));
  peer.name = '阿花';
  let fired = 0;
  swarm.on('peer-renamed', () => fired++);
  swarm._onCtrl(peer, { t: 'name', name: '冒名' });
  assert.equal(peer.name, '阿花');
  assert.equal(fired, 0);
});

/* ------------------------------ 同步引擎里的名字副本 ------------------------------ */

test('同步引擎：自己改名后发出去的消息用新名字；别人改名后就绪表、卡顿表里的名字跟着换', async () => {
  const { SyncEngine } = await load('syncEngine.js');
  const sync = new SyncEngine({ peerId: 'me', name: '旧', isSeeder: true, hostId: 'me' });
  sync.setName(' 新名字 ');
  assert.equal(sync.name, '新名字');
  assert.equal(sync.shared.byName, '新名字', '房间状态是我定的，署名跟着换');
  sync.setName('   ');
  assert.equal(sync.name, '新名字', '空名字不要');

  sync.readyPeers.set('pa', { name: '阿花', ready: false });
  sync.stalledPeers.set('pa', { name: '阿花', position: 0, deficitSeconds: 3, via: new Set() });
  sync.noteRename('pa', '花花');
  assert.equal(sync.readyPeers.get('pa').name, '花花');
  assert.equal(sync.stalledPeers.get('pa').name, '花花');
  sync.noteRename('nobody', '谁');
  assert.equal(sync.readyPeers.has('nobody'), false, '不认识的人不凭空登记');
});
