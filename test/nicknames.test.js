'use strict';

// 昵称：重名临时编号、进房后改名（NAME 消息的收发、清洗、限速）、同步引擎里的名字副本
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

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

test('收到 NAME：清洗后换名字、发 peer-renamed；2 秒内再改不理；空的、一样的不理', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const { Swarm } = await load('swarm.js');
  const swarm = new Swarm({ peerId: 'me', name: '我' });
  const peer = swarm.addPeer(fakePeer('pa'));
  peer.name = '阿花';
  const events = [];
  swarm.on('peer-renamed', (e) => events.push(e));

  swarm._onCtrl(peer, { t: 'name', name: ' 花花‮ ' });
  assert.equal(peer.name, '花花');
  assert.deepEqual(events, [{ peerId: 'pa', name: '花花', oldName: '阿花' }]);
  assert.equal(swarm.peerList().find((p) => p.peerId === 'pa').name, '花花');

  swarm._onCtrl(peer, { t: 'name', name: '又改了' });
  assert.equal(peer.name, '花花', '2 秒内连着改的不理：成员表和聊天不会被刷屏');
  t.mock.timers.tick(2000);
  swarm._onCtrl(peer, { t: 'name', name: '又改了' });
  assert.equal(peer.name, '又改了');

  t.mock.timers.tick(5000);
  for (const bad of ['', '   ', null, 42, { name: 'x' }, '又改了']) swarm._onCtrl(peer, { t: 'name', name: bad });
  assert.equal(peer.name, '又改了');
  assert.equal(events.length, 2);

  t.mock.timers.tick(5000);
  swarm._onCtrl(peer, { t: 'name', name: 'x'.repeat(100_000) });
  assert.equal(peer.name.length, 40, '几十 KB 的名字截到 40 字');
});

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
