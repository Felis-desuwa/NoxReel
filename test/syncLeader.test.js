'use strict';

// 同步目标（房主指定一个管理员，大家跟着他实际的画面走）和转让房主
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { IMPLS } = require('./helpers/impls');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('src', 'renderer', 'app.js');
const APP_ANDROID = read('android', 'app', 'src', 'main', 'assets', 'js', 'app-android.js');

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

function fnSource(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层函数 ${name}`);
  const end = APP.indexOf('\n}\n', m.index);
  return APP.slice(m.index, end + 2);
}

/**
 * 一个网状房间：房主 h1 加若干成员，共用一只假时钟。每台引擎记下发出去的消息、叫播放器做的跳转，
 * 消息手动 flush 才送达（to 可以限定只送给谁，模拟星型拓扑）。
 */
async function room(dir, members, { streaming = false } = {}) {
  const { SyncEngine } = await import(dir + 'syncEngine.js');
  const clock = { t: 10_000 };
  const nodes = new Map();
  const queue = [];
  const roles = members.map((m) => [m.id, m.role || 'guest']);
  const add = (id) => {
    const eng = new SyncEngine({ peerId: id, name: id, isSeeder: true, hostId: 'h1' });
    eng.now = () => clock.t;
    const node = { id, eng, out: [], seeks: [], events: [] };
    eng.onSeek = (p) => node.seeks.push(p);
    eng.onSetPause = () => {};
    eng.started = true;
    eng.applyRoles(roles, 'h1');
    eng.on('outbound', (m) => {
      node.out.push(m);
      for (const other of nodes.keys()) if (other !== id) queue.push({ from: id, to: other, msg: JSON.parse(JSON.stringify(m)) });
    });
    eng.on('relay', ({ msg, except }) => {
      for (const other of nodes.keys()) {
        if (other !== id && other !== except && other !== msg.origin) queue.push({ from: id, to: other, msg: JSON.parse(JSON.stringify(msg)) });
      }
    });
    eng.on('host-changed', (e) => node.events.push(['host-changed', e]));
    eng.on('drift-correct', (e) => node.events.push(['drift-correct', e]));
    nodes.set(id, node);
    return node;
  };
  add('h1');
  for (const m of members) add(m.id);
  const flush = () => {
    while (queue.length) {
      const { from, to, msg } = queue.shift();
      nodes.get(to)?.eng.onCtrl(msg, { peerId: from, name: from });
    }
  };
  for (const node of nodes.values()) {
    node.eng.resetMedia({ seq: 1, isSeeder: true, broadcast: node.id === 'h1' });
    node.eng.setFollow({ streaming, mode: 'full' });
    node.eng.setMediaInfo({ duration: 3600, size: 0 });
  }
  flush();
  const r = {
    clock,
    flush,
    queue,
    node: (id) => nodes.get(id),
    eng: (id) => nodes.get(id).eng,
    add,
    advance(sec) {
      clock.t += sec * 1000;
    },
    // 播放器命令的效果（cause: 'cmd'）：引擎只当基线，不判成用户拖了进度条
    place(id, fields) {
      const snap = { position: 0, paused: false, eof: false, idle: false, seeking: false, pausedForCache: false, cause: 'cmd', ...fields };
      snap.sampledAt = clock.t;
      nodes.get(id).eng.onMpvTick(snap, { contiguousBytes: 0, runBytes: 0, complete: true });
    },
    async play() {
      nodes.get('h1').eng.userSetPaused(false);
      flush();
      for (const id of nodes.keys()) r.place(id, { position: 0 });
      flush();
      await new Promise((res) => setTimeout(res, 300));
      for (const node of nodes.values()) {
        node.out.length = 0;
        node.seeks.length = 0;
      }
    },
  };
  return r;
}

/* ------------------------------ 同步目标 ------------------------------ */

impl('只有房主能指定同步目标，只能是管理员；随 ROLE 发给大家，降成游客就不再是目标', async (dir) => {
  const r = await room(dir, [
    { id: 'a1', role: 'admin' },
    { id: 'g1', role: 'guest' },
  ]);
  assert.equal(r.eng('a1').setLeader('a1'), false, '管理员不能自己指定');
  assert.equal(r.eng('h1').setLeader('g1'), false, '游客当不了同步目标');
  assert.equal(r.eng('h1').setLeader('a1'), true);
  const role = r.node('h1').out.at(-1);
  assert.equal(role.t, 'role');
  assert.equal(role.leader, 'a1', '同步目标随角色表一起发');
  r.flush();
  for (const id of ['h1', 'a1', 'g1']) assert.equal(r.eng(id).leaderId, 'a1', id);
  assert.equal(r.eng('g1').followingLeader(), true);
  assert.equal(r.eng('a1').followingLeader(), false, '他自己就是标准');
  assert.equal(r.eng('h1').referenceId(), 'a1', '房主也跟他');

  r.eng('h1').setRole('a1', 'guest');
  r.flush();
  for (const id of ['h1', 'a1', 'g1']) assert.equal(r.eng(id).leaderId, null, `${id}：降成游客就不是目标了`);
  assert.equal(r.eng('g1').referenceId(), 'h1');
});

impl('老版本房主发的角色表没有 leader、或者指定的不是管理员：当没指定', async (dir) => {
  const { SyncEngine } = await import(dir + 'syncEngine.js');
  const me = new SyncEngine({ peerId: 'me', name: 'me', isSeeder: false, hostId: 'h1' });
  me.onCtrl({ t: 'role', hostId: 'h1', roles: [['a1', 'admin'], ['me', 'guest']] }, { peerId: 'h1' });
  assert.equal(me.leaderId, null);
  me.onCtrl({ t: 'role', hostId: 'h1', roles: [['a1', 'guest'], ['me', 'guest']], leader: 'a1' }, { peerId: 'h1' });
  assert.equal(me.leaderId, null, '游客不能是同步目标');
  me.onCtrl({ t: 'role', hostId: 'h1', roles: [['a1', 'admin']], leader: 'h1' }, { peerId: 'h1' });
  assert.equal(me.leaderId, null, '指定房主自己等于没指定');
});

impl('同步目标每 2 秒报一次自己实际放到哪；跳转途中不报；别人报的不信', async (dir) => {
  const r = await room(dir, [
    { id: 'a1', role: 'admin' },
    { id: 'g1', role: 'guest' },
  ]);
  r.eng('h1').setLeader('a1');
  r.flush();
  await r.play();
  r.advance(1);
  r.place('a1', { position: 1 });
  r.eng('a1').beaconTick();
  const beacon = r.node('a1').out.filter((m) => m.t === 'beacon');
  assert.equal(beacon.length, 1);
  assert.equal(beacon[0].seq, 1);
  assert.equal(beacon[0].moving, true);
  assert.ok(Math.abs(beacon[0].position - 1) < 0.01);
  assert.equal(beacon[0].lamport, r.eng('a1').shared.lamport);
  r.eng('a1').beaconTick();
  assert.equal(r.node('a1').out.filter((m) => m.t === 'beacon').length, 1, '不到 2 秒不再报');
  r.advance(2);
  r.place('a1', { position: 3, seeking: true });
  r.eng('a1').beaconTick();
  assert.equal(r.node('a1').out.filter((m) => m.t === 'beacon').length, 1, '跳转途中不报');
  // 不是同步目标的人 beaconTick 什么都不发
  r.eng('g1').beaconTick();
  assert.equal(r.node('g1').out.filter((m) => m.t === 'beacon').length, 0);
  // 冒名的 beacon 不信
  r.eng('g1').onCtrl({ t: 'beacon', seq: 1, lamport: 99, position: 500, moving: true }, { peerId: 'h1' });
  assert.ok(r.eng('g1').referencePositionNow() < 100, '只认同步目标本人（或房主转发时注明是他）报的');
});

impl('跟着同步目标：对齐的标准是他报的位置（按经过的时间外推），太久没报就退回房间进度', async (dir) => {
  const r = await room(dir, [
    { id: 'a1', role: 'admin' },
    { id: 'g1', role: 'guest' },
  ]);
  r.eng('h1').setLeader('a1');
  r.flush();
  await r.play();
  r.advance(10);
  // 同步目标实际只放到 6 秒（他那边卡过一下），房间时钟是 10 秒
  r.eng('g1').onCtrl({ t: 'beacon', seq: 1, lamport: r.eng('g1').shared.lamport, position: 6, moving: true }, { peerId: 'a1' });
  assert.ok(Math.abs(r.eng('g1').referencePositionNow() - 6) < 0.01);
  r.advance(2);
  assert.ok(Math.abs(r.eng('g1').referencePositionNow() - 8) < 0.01, '他在走，按经过的时间往后推');
  // 房间之后又有人操作过（lamport 更大）：之前报的位置作废
  const old = { t: 'beacon', seq: 1, lamport: 0, position: 100, moving: true };
  r.eng('g1').shared.lamport = 5;
  r.eng('g1').onCtrl(old, { peerId: 'a1' });
  assert.ok(Math.abs(r.eng('g1').referencePositionNow() - r.eng('g1').sharedPositionNow()) < 0.01, '比房间现在的状态旧的一律不信');
  // 好几秒没报：退回房间进度
  r.eng('g1').onCtrl({ t: 'beacon', seq: 1, lamport: 5, position: 3, moving: false }, { peerId: 'a1' });
  assert.ok(Math.abs(r.eng('g1').referencePositionNow() - 3) < 0.01);
  r.advance(7);
  assert.ok(Math.abs(r.eng('g1').referencePositionNow() - r.eng('g1').sharedPositionNow()) < 0.01);
  // 换片：上一部报的作废
  r.eng('g1').onCtrl({ t: 'beacon', seq: 1, lamport: 5, position: 3, moving: false }, { peerId: 'a1' });
  r.eng('g1').resetMedia({ seq: 2 });
  assert.equal(r.eng('g1')._beacon, null);
});

impl('本地片子跟着同步目标：差开 2 秒以上、连着两次就自动跳到他那里；没指定时本地片子不核对', async (dir) => {
  const r = await room(dir, [
    { id: 'a1', role: 'admin' },
    { id: 'g1', role: 'guest' },
  ]);
  await r.play();
  r.advance(20);
  r.place('g1', { position: 20 });
  r.eng('g1').checkDrift();
  r.eng('g1').checkDrift();
  assert.equal(r.node('g1').seeks.length, 0, '没指定同步目标：本地片子不核对');

  r.eng('h1').setLeader('a1');
  r.flush();
  // 同步目标那边落后房间 6 秒（比如他那里卡过），大家跟他
  const lamport = r.eng('g1').shared.lamport;
  r.eng('g1').onCtrl({ t: 'beacon', seq: 1, lamport, position: 14, moving: true }, { peerId: 'a1' });
  r.eng('g1').checkDrift();
  assert.equal(r.node('g1').seeks.length, 0, '确认两次才动');
  r.eng('g1').checkDrift();
  assert.equal(r.node('g1').seeks.length, 1);
  assert.ok(Math.abs(r.node('g1').seeks[0] - 14) < 0.2, `跳到同步目标的位置：${r.node('g1').seeks[0]}`);
  assert.equal(r.node('g1').events.some(([k]) => k === 'drift-correct'), true);
  // 同步目标自己不核对：他比房间进度慢 8 秒也不把他往房间那边拽，他就是标准
  r.place('a1', { position: 12 });
  r.eng('a1').checkDrift();
  r.eng('a1').checkDrift();
  assert.equal(r.node('a1').seeks.length, 0);
});

impl('指定了别人当同步目标时，房主也能选手动同步；手动同步的「同步到房主」跳到同步目标那里', async (dir) => {
  const r = await room(dir, [{ id: 'a1', role: 'admin' }], { streaming: true });
  await r.play();
  r.eng('h1').setFollow({ mode: 'manual' });
  assert.equal(r.eng('h1')._manual(), false, '没指定：房主是标准，没有手动同步');
  r.eng('h1').setLeader('a1');
  r.flush();
  assert.equal(r.eng('h1')._manual(), true);
  assert.equal(r.eng('a1')._manual(), false, '同步目标自己是标准');
  r.advance(30);
  r.place('h1', { position: 10 });
  r.eng('h1').onCtrl({ t: 'beacon', seq: 1, lamport: r.eng('h1').shared.lamport, position: 25, moving: true }, { peerId: 'a1' });
  assert.equal(r.eng('h1').syncToRoom(), true);
  assert.ok(Math.abs(r.node('h1').seeks.at(-1) - 25) < 0.5, `${r.node('h1').seeks.at(-1)}`);
  assert.equal(r.eng('h1').driftStatus().leader, 'a1');
  // 在线链接里同步目标自己比房间进度慢得多也不被拽回房间进度（大家跟的是他，拽他会来回打架）
  r.place('a1', { position: 5 });
  r.eng('a1').checkDrift();
  r.eng('a1').checkDrift();
  r.eng('a1').checkDrift();
  assert.equal(r.node('a1').seeks.length, 0);
});

impl('星型拓扑：同步目标报的位置由房主转给其他人，其他人认得出是他报的', async (dir) => {
  const { SyncEngine } = await import(dir + 'syncEngine.js');
  const g = new SyncEngine({ peerId: 'g1', name: 'g1', isSeeder: false, hostId: 'h1' });
  g.now = () => 50_000;
  g.started = true;
  g.onCtrl({ t: 'role', hostId: 'h1', roles: [['a1', 'admin'], ['g1', 'guest']], leader: 'a1' }, { peerId: 'h1' });
  g.onCtrl({ t: 'beacon', seq: 0, lamport: 0, position: 42, moving: false, origin: 'a1', originName: 'a1' }, { peerId: 'h1' });
  assert.equal(g.referencePositionNow(), 42);
  // 别人自称转发不算
  g.onCtrl({ t: 'beacon', seq: 0, lamport: 0, position: 7, moving: false, origin: 'a1' }, { peerId: 'x9' });
  assert.equal(g.referencePositionNow(), 42);
});

/* ------------------------------ 转让房主 ------------------------------ */

impl('转让房主：只有房主能转、只能转给管理员；转完他是房主、我是管理员，大家改认他', async (dir) => {
  const r = await room(dir, [
    { id: 'a1', role: 'admin' },
    { id: 'g1', role: 'guest' },
  ]);
  assert.equal(r.eng('a1').transferHost('g1'), false, '管理员转不了');
  assert.equal(r.eng('h1').transferHost('g1'), false, '游客接不了');
  r.eng('h1').setLeader('a1');
  r.flush();
  assert.equal(r.eng('h1').transferHost('a1'), true);
  r.flush();
  for (const id of ['h1', 'a1', 'g1']) assert.equal(r.eng(id).hostId, 'a1', id);
  assert.equal(r.eng('a1').myRole(), 'host');
  assert.equal(r.eng('h1').myRole(), 'admin', '原房主变成管理员');
  assert.equal(r.eng('g1').roleOf('h1'), 'admin');
  for (const id of ['h1', 'a1', 'g1']) assert.equal(r.eng(id).leaderId, null, `${id}：新房主就是标准，同步目标清掉`);
  for (const id of ['h1', 'a1', 'g1']) {
    assert.deepEqual(r.node(id).events.filter(([k]) => k === 'host-changed').map(([, e]) => e), [{ hostId: 'a1', from: 'h1' }], id);
  }
  // 新房主说了算：原房主再发角色表没人认；新房主发的大家都认（原房主也认）
  r.eng('h1').setRole('g1', 'admin');
  r.flush();
  assert.equal(r.eng('g1').myRole(), 'guest', '原房主已经不是房主了');
  r.eng('a1').setRole('g1', 'admin');
  r.flush();
  assert.equal(r.eng('g1').myRole(), 'admin');
  assert.equal(r.eng('h1').roleOf('g1'), 'admin');
  // 新房主不收任何人的角色表
  r.eng('a1').onCtrl({ t: 'role', hostId: 'h1', roles: [] }, { peerId: 'h1' });
  assert.equal(r.eng('a1').myRole(), 'host');
});

impl('转让之后新人还是从原房主那里进来、只认原房主：原房主替新房主作保，新人改认新房主', async (dir) => {
  const { SyncEngine } = await import(dir + 'syncEngine.js');
  const r = await room(dir, [{ id: 'a1', role: 'admin' }]);
  r.eng('h1').transferHost('a1');
  r.flush();
  // 新人：邀请里写的房主是 h1
  const n = new SyncEngine({ peerId: 'n1', name: 'n1', isSeeder: false, hostId: 'h1' });
  const changed = [];
  n.on('host-changed', (e) => changed.push(e));
  const sent = { h1: [], a1: [] };
  const peerFor = (id) => ({ peerId: 'n1', send: (m) => sent[id].push(JSON.parse(JSON.stringify(m))) });
  r.eng('a1').greet(peerFor('a1'));
  r.eng('h1').greet(peerFor('h1'));
  // 新房主那份先到：新人还认 h1，不收
  for (const m of sent.a1.filter((x) => x.t === 'role')) n.onCtrl(m, { peerId: 'a1' });
  assert.equal(n.hostId, 'h1');
  // 原房主作保
  const vouch = sent.h1.filter((x) => x.t === 'role');
  assert.equal(vouch.length, 1, '原房主给新人发一条带新 hostId 的角色表');
  assert.equal(vouch[0].hostId, 'a1');
  n.onCtrl(vouch[0], { peerId: 'h1' });
  assert.equal(n.hostId, 'a1');
  assert.deepEqual(changed, [{ hostId: 'a1', from: 'h1' }]);
  // 之后新房主的角色表照收
  n.onCtrl({ t: 'role', hostId: 'a1', roles: [['n1', 'admin'], ['h1', 'admin']] }, { peerId: 'a1' });
  assert.equal(n.myRole(), 'admin');
  // 没转让过的管理员 greet 时不发角色表
  const plain = await room(dir, [{ id: 'a2', role: 'admin' }]);
  const out = [];
  plain.eng('a2').greet({ peerId: 'n2', send: (m) => out.push(m) });
  assert.equal(out.filter((m) => m.t === 'role').length, 0);
});

/* ------------------------------ 能力声明 ------------------------------ */

impl('HELLO 带上本机能力（老版本不看）；认不得的能力丢掉', async (dir) => {
  const { normalizeCaps, CAPS } = await import(dir + 'protocol.js');
  assert.deepEqual(CAPS, ['leader', 'follow-host', 'host']);
  assert.deepEqual(normalizeCaps(['host', 'evil', 'host', 3]), ['host']);
  assert.deepEqual(normalizeCaps('host'), []);
  const { Peer } = await import(dir + 'peer.js');
  const sent = [];
  const fake = Object.create(Peer.prototype);
  fake.send = (m) => sent.push(m);
  fake.hello('p', 'n', 'safe', 'windows', ['leader']);
  fake.hello('p', 'n', 'safe', 'windows');
  assert.deepEqual(sent[0].caps, ['leader']);
  assert.equal('caps' in sent[1], false, '没有能力就不带这个字段，和老版本发的一模一样');
  const swarm = read(...(dir.includes('android') ? ['android', 'app', 'src', 'main', 'assets', 'js'] : ['src', 'renderer', 'lib']), 'swarm.js');
  assert.match(swarm, /peer\.caps = normalizeCaps\(msg\.caps\);/);
  assert.match(swarm, /peer\.hello\(this\.peerId, this\.name, this\.securityMode, this\.platform, this\.caps\);/);
});

/* ------------------------------ 电脑端接线 ------------------------------ */

test('转让房主的前提：网状房间、对方是管理员、连着、能当房主，房里所有人都跟得上换房主', () => {
  const peers = new Map([
    ['a1', { peerId: 'a1', name: '小林', authenticated: true, platform: 'windows', caps: ['leader', 'follow-host', 'host'] }],
    ['p1', { peerId: 'p1', name: '手机', authenticated: true, platform: 'android', caps: ['leader', 'follow-host'] }],
  ]);
  const S = { hostId: 'me', peerId: 'me', role: 'host', mode: 'server', swarm: { peers }, sync: { roleOf: (id) => (id === 'a1' || id === 'p1' ? 'admin' : 'guest') } };
  const ctx = { S, isRoomHost: () => S.hostId === S.peerId, roomDisplayNames: () => new Map([['a1', '小林'], ['p1', '手机'], ['o1', '老王']]) };
  vm.createContext(ctx);
  vm.runInContext([fnSource('transferBlocker'), fnSource('peerCaps'), fnSource('nameOfPeer')].join('\n\n'), ctx);
  assert.equal(ctx.transferBlocker('a1'), '');
  assert.match(ctx.transferBlocker('p1'), /手机上的 NoxReel 当不了房主/);
  assert.match(ctx.transferBlocker('x'), /先把他设为管理员/);
  S.mode = 'manual';
  assert.match(ctx.transferBlocker('a1'), /一对一邀请的房间是星型连接/);
  S.mode = 'server';
  peers.set('o1', { peerId: 'o1', name: '老王', authenticated: true, platform: 'windows', caps: [] });
  assert.match(ctx.transferBlocker('a1'), /房里还有人用的是旧版本（老王）/);
  peers.delete('o1');
  peers.get('a1').caps = ['leader', 'follow-host'];
  assert.match(ctx.transferBlocker('a1'), /版本太旧，接不了房主/);
  S.hostId = 'a1';
  assert.match(ctx.transferBlocker('a1'), /只有房主能转让房主/);
});

test('电脑端接线：房主身份跟着引擎走；成员表上有同步目标标记和两个按钮；新房主回现状有限速', () => {
  assert.match(APP, /const isRoomHost = \(\) => S\.hostId === S\.peerId && \(S\.role === 'host' \|\| S\.hostTakenOver === true\);/);
  assert.match(APP, /caps: \['leader', 'follow-host', 'host'\],/);
  assert.match(APP, /S\.sync\.on\('host-changed', \(e\) => onHostChanged\(e\)\);/);
  const changed = fnSource('onHostChanged');
  assert.match(changed, /S\.hostId = hostId;/);
  assert.match(changed, /for \(const settle of \[\.\.\.S\.pendingOps\.values\(\)\]\)/, '发给原房主的列表操作当场结束');
  assert.match(changed, /host\.send\(\{ t: MSG\.HOST_SYNC \}\)/);
  assert.match(changed, /takeOverAsHost\(\);/);
  // 成员表：谁是同步目标，自己那一行和别人那几行都标出来
  assert.match(fnSource('selfPeerRow'), /leaderBadge\(S\.peerId\)/);
  assert.match(fnSource('renderPeers'), /leaderBadge\(peer\.peerId\)/);
  assert.match(fnSource('leaderBadge'), /className: 'role-badge leader', text: '同步目标'/);
  assert.match(fnSource('renderPeers'), /iAmHost && role === 'admin'/);
  assert.match(fnSource('renderPeers'), /'取消同步目标' : '设为同步目标'/);
  assert.match(fnSource('renderPeers'), /text: '转让房主'/);
  // 回现状：每人 10 秒最多一次
  assert.match(APP, /case MSG\.HOST_SYNC:\n[^\n]*\n\s+if \(isRoomHost\(\) && Date\.now\(\) - \(hostSyncAnsweredAt\.get\(peer\.peerId\) \|\| 0\) > 10_000\)/);
  // 转让前先把手上的列表操作做完、最新的列表先发
  const transfer = fnSource('transferHostTo');
  assert.ok(transfer.indexOf('await playlistOpChain;') < transfer.indexOf('S.sync.transferHost(peerId)'));
  assert.ok(transfer.indexOf('t: MSG.PLAYLIST') < transfer.indexOf('S.sync.transferHost(peerId)'));
  // 入口留在开房的人那里：离开时说清楚
  assert.match(fnSource('leaveRoomLosses'), /你走了以后，已经在房里的人照常看，但新人就没法用原来的链接进房了。/);
  // 差值、同步按钮跟着同步目标的名字走；本地片子跟着同步目标时也核对
  assert.match(fnSource('driftRefName'), /if \(leader\) return nameOfPeer\(leader\);/);
  assert.match(fnSource('driftTick'), /S\.sync\.beaconTick\?\.\(\);/);
  assert.match(fnSource('driftTick'), /\(S\.sourceType !== 'link' && !followedLeader\(\)\)/);
});

test('安卓端：能当同步目标、跟得上房主换人（当不了房主）；成员面板标出同步目标', () => {
  assert.match(APP_ANDROID, /platform: 'android', caps: \['leader', 'follow-host'\] \}\);/);
  assert.match(APP_ANDROID, /S\.sync\.on\('host-changed', \(\{ hostId, from \}\) => \{\n\s+S\.hostId = hostId;/);
  assert.match(APP_ANDROID, /host\.send\(\{ t: MSG\.HOST_SYNC \}\)/);
  assert.match(APP_ANDROID, /S\.sync\?\.leaderId === peerId \? el\('span', \{ className: 'mb-role mb-leader', text: '同步目标' \}\) : null/);
});

test('新文案都有英文（电脑端、安卓端）', async () => {
  const { translate } = await import(pathToFileURL(path.join(root, 'src', 'renderer', 'lib', 'i18n.js')).href);
  const statics = [
    '同步目标', '设为同步目标', '取消同步目标', '转让房主', '转让', '现在设不了同步目标', '现在转不了房主',
    '只有房主能指定同步目标', '先把他设为管理员：同步目标得是能控场的人', '他用的 NoxReel 版本太旧，报不了自己放到哪，先让他升级',
    '只有房主能转让房主', '一对一邀请的房间是星型连接，其他人只连着你，房主转不过去', '先把他设为管理员', '他现在没连着',
    '手机上的 NoxReel 当不了房主', '他用的 NoxReel 版本太旧，接不了房主，先让他升级',
    '排片、设管理员、在线视频的地址、聊天中转都交给他，你变成管理员。',
    '房间链接和邀请还在你这里：新人照旧从原来的邀请进来。你离开之后，已经在房里的人照常看，但新人就进不来了。',
    '房间链接和邀请还在开房的人那里，他离开之后新人就进不来了。', '房主换人了，没成的请再试一次',
    '你被设为同步目标：大家跟着你的画面走', '同步目标取消了，大家回到跟房间进度',
    '房主是转给你的，邀请还是从开房的人那里发：他在线时，新人从原来的房间链接进来，会自动认你当房主。',
    '想让大家接着看，走之前在成员表里把房主转给一个管理员。',
  ];
  for (const zh of statics) assert.doesNotMatch(translate(zh, 'en'), /[一-鿿]/, zh);
  assert.equal(translate('你比小林慢 3 秒', 'en'), 'You are 3 seconds behind 小林');
  assert.equal(translate('你比房主快 1 秒', 'en'), 'You are 1 second ahead of the host');
  assert.equal(translate('你比房间进度慢 2 秒', 'en'), 'You are 2 seconds behind the room');
  assert.equal(translate('同步到 小林', 'en'), 'Sync to 小林');
  assert.equal(translate('把房主转给 小林？', 'en'), 'Transfer host to 小林?');
  assert.equal(translate('阿杰把房主转给了小林', 'en'), '阿杰 transferred host to 小林');
  assert.equal(translate('你把房主转给了小林，你现在是管理员', 'en'), 'You transferred host to 小林; you are a moderator now');
  const android = await import(pathToFileURL(path.join(root, 'android', 'app', 'src', 'main', 'assets', 'js', 'i18n.js')).href);
  for (const zh of ['同步目标', '房主换人了，没成的请再试一次', '你被设为同步目标：大家跟着你的画面走', '同步目标取消了，大家回到跟房间进度']) {
    assert.doesNotMatch(android.translate(zh, 'en'), /[一-鿿]/, zh);
  }
  assert.equal(android.translate('你比小林慢 3 秒', 'en'), 'You are 3 seconds behind 小林');
  assert.equal(android.translate('阿杰把房主转给了小林', 'en'), '阿杰 transferred host to 小林');
});
