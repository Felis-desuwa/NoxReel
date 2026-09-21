'use strict';

// 房间链接：经公共 Nostr 中继交换握手（0.7.4）。
//
// 用一张内存里的假中继网络跑完整流程。守的是信令服务器原本替我们做、现在改由房主签名来做的
// 那几件事：发信人是谁、谁是房主、满员、进出通知；以及中继带来的新问题：重复、重放、乱序、
// 部分中继挂掉、中继能看到什么。

const test = require('node:test');
const assert = require('node:assert/strict');

const LIB = '../src/renderer/lib/relaySignaling.js';
const FAST = { hello: 40, join: 600, connect: 300, alive: 60, silent: 250, sweep: 40 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 按 Nostr 中继协议（REQ / EVENT / CLOSE）工作的假中继网络。 */
class FakeNet {
  constructor() {
    this.relays = new Map(); // url -> { subs: Set<{ws, filter}>, events: [] }
    this.down = new Set();
    this.duplicate = false;
    this.sockets = new Set();
  }
  relay(url) {
    if (!this.relays.has(url)) this.relays.set(url, { subs: new Set(), events: [] });
    return this.relays.get(url);
  }
  WebSocket() {
    const net = this;
    return class FakeWS {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        net.sockets.add(this);
        setTimeout(() => {
          if (net.down.has(url)) {
            this.readyState = 3;
            this.onclose?.();
            return;
          }
          this.readyState = 1;
          this.onopen?.();
        }, 5);
      }
      send(text) {
        if (this.readyState !== 1) return;
        const msg = JSON.parse(text);
        const relay = net.relay(this.url);
        if (msg[0] === 'REQ') {
          relay.subs.add({ ws: this, id: msg[1], filter: msg[2] });
        } else if (msg[0] === 'CLOSE') {
          for (const s of relay.subs) if (s.ws === this && s.id === msg[1]) relay.subs.delete(s);
        } else if (msg[0] === 'EVENT') {
          const ev = msg[1];
          relay.events.push(ev);
          for (const s of relay.subs) {
            const f = s.filter;
            if (!f.kinds.includes(ev.kind)) continue;
            if (!ev.tags.some((t) => t[0] === 'x' && f['#x'].includes(t[1]))) continue;
            const deliver = () => s.ws.readyState === 1 && s.ws.onmessage?.({ data: JSON.stringify(['EVENT', s.id, ev]) });
            setTimeout(deliver, 2);
            if (net.duplicate) setTimeout(deliver, 7);
          }
        }
      }
      close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        for (const r of net.relays.values()) for (const s of r.subs) if (s.ws === this) r.subs.delete(s);
        setTimeout(() => this.onclose?.(), 1);
      }
    };
  }
}

const RELAYS = ['wss://a', 'wss://b', 'wss://c'];

async function room(t, { maxMembers = 8, net = new FakeNet(), relays = RELAYS } = {}) {
  const { RelaySignaling, newRoomSecret } = await import(LIB);
  const secret = newRoomSecret();
  const made = [];
  const make = (o) => {
    const sig = new RelaySignaling({ relays, timing: FAST, WebSocketImpl: net.WebSocket(), protocolVersion: 2, ...o });
    made.push(sig);
    return sig;
  };
  t.after(() => made.forEach((s) => s.close()));
  const host = make({ secret, isHost: true, hostId: 'host', peerId: 'host', name: '房主', maxMembers });
  const events = new Map();
  const record = (sig) => {
    const log = [];
    for (const e of ['joined', 'peer-join', 'peer-leave', 'signal', 'room-config']) sig.on(e, (p) => log.push([e, p]));
    events.set(sig, log);
    return log;
  };
  record(host);
  await host.connect();
  const guest = (peerId, extra = {}) => {
    const g = make({ secret, hostId: 'host', hostKey: host.publicKey, peerId, name: `观众${peerId}`, ...extra });
    record(g);
    return g;
  };
  return { host, guest, net, secret, log: (s) => events.get(s), RelaySignaling, make };
}

const joinsOf = (log) => log.filter(([e]) => e === 'peer-join').map(([, p]) => p.peerId);

test('进房：房主放行后 connect 返回房主身份；老成员向新人发起，新人不向老成员发起', async (t) => {
  const r = await room(t);
  const a = r.guest('a');
  const joinedA = await a.connect();
  assert.deepEqual({ hostId: joinedA.hostId, maxMembers: joinedA.maxMembers }, { hostId: 'host', maxMembers: 8 });
  const b = r.guest('b');
  await b.connect();
  await sleep(60);
  assert.deepEqual(joinsOf(r.log(r.host)), ['a', 'b'], '房主是老成员，两个人都由它发起');
  assert.deepEqual(joinsOf(r.log(a)), ['b'], 'a 比 b 早，由 a 向 b 发起');
  assert.deepEqual(joinsOf(r.log(b)), [], 'b 是新人，不主动发起');
});

test('信令：只送给收件人，带发信人昵称；老成员发给新人的也认（名册里有他的公钥）', async (t) => {
  const r = await room(t);
  const a = r.guest('a');
  await a.connect();
  const b = r.guest('b');
  await b.connect();
  r.host.signal('a', { kind: 'offer', sdp: { type: 'offer', sdp: 'v=0 host' } });
  a.signal('b', { kind: 'offer', sdp: { type: 'offer', sdp: 'v=0 a' } });
  b.signal('a', { kind: 'answer', sdp: { type: 'answer', sdp: 'v=0 b' } });
  await sleep(80);
  const sigs = (s) => r.log(s).filter(([e]) => e === 'signal').map(([, p]) => `${p.from}(${p.name})>${p.payload.sdp.sdp}`);
  assert.deepEqual(sigs(a).sort(), ['b(观众b)>v=0 b', 'host(房主)>v=0 host']);
  assert.deepEqual(sigs(b), ['a(观众a)>v=0 a'], 'b 收不到发给 a 的，也要认得早进房的 a');
  assert.deepEqual(sigs(r.host), []);
});

test('两人同时进房：只有序号小的那个发起，不会互相发 offer 撞车', async (t) => {
  const r = await room(t);
  const a = r.guest('a');
  const b = r.guest('b');
  await Promise.all([a.connect(), b.connect()]);
  await sleep(80);
  const both = [...joinsOf(r.log(a)), ...joinsOf(r.log(b))];
  assert.equal(both.length, 1, `两边加起来只该发起一次，实际 ${JSON.stringify(both)}`);
});

test('满员：房主回 ROOM_FULL，connect 带着 code 被拒', async (t) => {
  const r = await room(t, { maxMembers: 2 });
  await r.guest('a').connect();
  await assert.rejects(r.guest('b').connect(), (e) => e.code === 'ROOM_FULL' && /房间已满（上限 2 人）/.test(e.message));
});

test('满员判定也算上不经中继进来的人（occupied 回调）', async (t) => {
  const net = new FakeNet();
  const { RelaySignaling, newRoomSecret } = await import(LIB);
  const secret = newRoomSecret();
  const host = new RelaySignaling({ secret, isHost: true, hostId: 'host', peerId: 'host', relays: RELAYS, maxMembers: 3, occupied: () => 3, timing: FAST, WebSocketImpl: net.WebSocket() });
  t.after(() => host.close());
  await host.connect();
  const g = new RelaySignaling({ secret, hostId: 'host', hostKey: host.publicKey, peerId: 'a', relays: RELAYS, timing: FAST, WebSocketImpl: net.WebSocket() });
  t.after(() => g.close());
  await assert.rejects(g.connect(), (e) => e.code === 'ROOM_FULL');
});

test('房主不在线：等不到 welcome 就报 HOST_OFFLINE', async (t) => {
  const net = new FakeNet();
  const { RelaySignaling, newRoomSecret, newSigningKey } = await import(LIB);
  const g = new RelaySignaling({ secret: newRoomSecret(), hostId: 'host', hostKey: newSigningKey().publicKey, peerId: 'a', relays: RELAYS, timing: FAST, WebSocketImpl: net.WebSocket() });
  t.after(() => g.close());
  await assert.rejects(g.connect(), (e) => e.code === 'HOST_OFFLINE' && /房主不在线，或者这个房间链接已经失效/.test(e.message));
});

test('版本不一致：房主回 VERSION', async (t) => {
  const r = await room(t);
  await assert.rejects(r.guest('a', { protocolVersion: 1 }).connect(), (e) => e.code === 'VERSION');
});

test('冒充房主：拿着链接的人自己签一条 welcome，新人不认', async (t) => {
  const net = new FakeNet();
  const { RelaySignaling, newRoomSecret, newSigningKey } = await import(LIB);
  const secret = newRoomSecret();
  const realHostKey = newSigningKey().publicKey; // 真房主不在线
  // 冒充者：同一个房间密钥，自称 host，但签名公钥是它自己的
  const fake = new RelaySignaling({ secret, isHost: true, hostId: 'host', peerId: 'host', relays: RELAYS, timing: FAST, WebSocketImpl: net.WebSocket() });
  t.after(() => fake.close());
  await fake.connect();
  const g = new RelaySignaling({ secret, hostId: 'host', hostKey: realHostKey, peerId: 'a', relays: RELAYS, timing: FAST, WebSocketImpl: net.WebSocket() });
  t.after(() => g.close());
  await assert.rejects(g.connect(), (e) => e.code === 'HOST_OFFLINE', '冒充者签的 welcome 被当真了');
});

test('冒充别的成员：b 以 a 的名义发信令，收件人丢掉', async (t) => {
  const r = await room(t);
  const a = r.guest('a');
  await a.connect();
  const b = r.guest('b');
  await b.connect();
  // b 用自己的签名密钥，但把 from 写成 a
  const orig = b.peerId;
  b.peerId = 'a';
  b.signal('host', { kind: 'offer', sdp: { type: 'offer', sdp: 'forged' } });
  await sleep(60);
  b.peerId = orig;
  const hostSignals = r.log(r.host).filter(([e]) => e === 'signal');
  assert.deepEqual(hostSignals, [], '房主收下了冒名的信令');
});

test('伪造签名：拿着链接的人把房主公钥写进事件、用自己的私钥签，收件人不认', async (t) => {
  // 中继本该验签，但中继不受我们控制（恶意中继可以原样转发假事件），所以收件人自己再验一遍
  const r = await room(t);
  const a = r.guest('a');
  await a.connect();
  const evil = r.guest('evil');
  await evil.connect();
  evil.key = { secretKey: evil.key.secretKey, publicKey: r.host.publicKey };
  evil.peerId = 'host';
  evil.signal('a', { kind: 'offer', sdp: { type: 'offer', sdp: 'forged' } });
  await sleep(60);
  assert.deepEqual(r.log(a).filter(([e]) => e === 'signal'), [], '签名对不上房主公钥的事件被当成房主发的');
});

test('冒名进房：别人顶着已在房里的 peerId 发 hello，房主回 DUP_PEER', async (t) => {
  const r = await room(t);
  await r.guest('a').connect();
  await assert.rejects(r.guest('a').connect(), (e) => e.code === 'DUP_PEER');
  await assert.rejects(r.guest('host').connect(), (e) => e.code === 'HOST_ID_RESERVED');
});

test('同一条事件从几个中继各来一份：只处理一次', async (t) => {
  const net = new FakeNet();
  net.duplicate = true;
  const r = await room(t, { net });
  const a = r.guest('a');
  await a.connect();
  r.host.signal('a', { kind: 'offer', sdp: { type: 'offer', sdp: 'once' } });
  await sleep(60);
  const got = r.log(a).filter(([e]) => e === 'signal');
  assert.equal(got.length, 1, `3 个中继 × 重复投递，实际收到 ${got.length} 次`);
  assert.equal(joinsOf(r.log(r.host)).length, 1);
});

test('重放：原样重发旧事件不再生效，过期的事件直接丢', async (t) => {
  const r = await room(t);
  const a = r.guest('a');
  await a.connect();
  r.host.signal('a', { kind: 'offer', sdp: { type: 'offer', sdp: 'first' } });
  await sleep(40);
  const relay = r.net.relay('wss://a');
  const old = relay.events.at(-1);
  // 原样重放
  for (const s of relay.subs) s.ws.onmessage({ data: JSON.stringify(['EVENT', s.id, old]) });
  await sleep(40);
  assert.equal(r.log(a).filter(([e]) => e === 'signal').length, 1);

  // 签一条时间戳在 20 分钟前的
  const { signEvent, RELAY_EVENT_KIND } = await import(LIB);
  const stale = await signEvent(r.host.key, { kind: RELAY_EVENT_KIND, tags: old.tags, content: old.content, createdAt: Math.floor(Date.now() / 1000) - 1200 });
  for (const s of relay.subs) s.ws.onmessage({ data: JSON.stringify(['EVENT', s.id, stale]) });
  await sleep(40);
  assert.equal(r.log(a).filter(([e]) => e === 'signal').length, 1, '过期事件被处理了');
});

test('部分中继挂了照常；全挂了报 RELAY_UNREACHABLE', async (t) => {
  const net = new FakeNet();
  net.down.add('wss://a');
  net.down.add('wss://b');
  const r = await room(t, { net });
  await r.guest('x').connect();
  const { RelaySignaling, newRoomSecret } = await import(LIB);
  const all = new FakeNet();
  for (const u of RELAYS) all.down.add(u);
  const h = new RelaySignaling({ secret: newRoomSecret(), isHost: true, hostId: 'h', peerId: 'h', relays: RELAYS, timing: FAST, WebSocketImpl: all.WebSocket() });
  t.after(() => h.close());
  await assert.rejects(h.connect(), (e) => e.code === 'RELAY_UNREACHABLE');
});

test('离开：close 发 bye，房主和其他成员都收到 peer-leave', async (t) => {
  const r = await room(t);
  const a = r.guest('a');
  await a.connect();
  const b = r.guest('b');
  await b.connect();
  a.close();
  await sleep(80);
  assert.ok(r.log(r.host).some(([e, p]) => e === 'peer-leave' && p.peerId === 'a'));
  assert.ok(r.log(b).some(([e, p]) => e === 'peer-leave' && p.peerId === 'a'));
  assert.equal(r.host.admittedCount, 1);
});

test('长时间没心跳的成员被房主判定离开', async (t) => {
  const r = await room(t);
  const a = r.guest('a');
  await a.connect();
  // 让 a 彻底哑掉（不再发 alive，也不发 bye）：停掉它的心跳，连接也不再往外发
  for (const timer of a._timers) clearInterval(timer);
  a._timers = [];
  for (const s of a._sockets.values()) s.ws.readyState = 3;
  await sleep(450);
  assert.ok(r.log(r.host).some(([e, p]) => e === 'peer-leave' && p.peerId === 'a'));
});

test('房间人数上限改了，成员跟着更新', async (t) => {
  const r = await room(t);
  const a = r.guest('a');
  await a.connect();
  r.host.setMaxMembers(5);
  await sleep(60);
  assert.ok(r.log(a).some(([e, p]) => e === 'room-config' && p.maxMembers === 5));
});

test('换一条房间链接：老成员跟着搬，新链接能进，老链接失效', async (t) => {
  const r = await room(t);
  const a = r.guest('a');
  await a.connect();
  const { newRoomSecret } = await import(LIB);
  const next = newRoomSecret();
  await r.host.rekey(next);
  await sleep(60);
  const c = r.make({ secret: next, hostId: 'host', hostKey: r.host.publicKey, peerId: 'c', name: 'c' });
  const cl = [];
  c.on('peer-join', (p) => cl.push(p.peerId));
  await c.connect();
  await sleep(60);
  assert.deepEqual(joinsOf(r.log(a)), ['c'], '搬过去的老成员要认得新人');
  const old = r.guest('d');
  await assert.rejects(old.connect(), (e) => e.code === 'HOST_OFFLINE', '老链接还能进');
});

test('中继上看不到明文：没有 peerId、昵称、SDP', async (t) => {
  const r = await room(t);
  const a = r.guest('a');
  await a.connect();
  r.host.signal('a', { kind: 'offer', sdp: { type: 'offer', sdp: 'v=0 c=IN IP4 203.0.113.9' } });
  await sleep(60);
  const seen = JSON.stringify([...r.net.relays.values()].flatMap((x) => x.events));
  for (const plain of ['203.0.113.9', '观众a', '房主', '"host"', 'offer', 'welcome']) {
    assert.ok(!seen.includes(plain), `中继看到了 ${plain}`);
  }
  // 话题标签由房间密钥派生，不是密钥本身
  assert.ok(!seen.includes(r.secret));
});

test('别的房间的事件解不开，直接忽略', async (t) => {
  const net = new FakeNet();
  const one = await room(t, { net });
  const two = await room(t, { net });
  const a = one.guest('a');
  await a.connect();
  const b = two.guest('b');
  await b.connect();
  await sleep(60);
  assert.deepEqual(joinsOf(one.log(one.host)), ['a']);
  assert.deepEqual(joinsOf(two.log(two.host)), ['b']);
});

test('内置的签名库在仓库里、带许可证，且不在 .gitignore 的 vendor/ 规则底下', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '../src/renderer/lib/third_party');
  const src = fs.readFileSync(path.join(dir, 'secp256k1.js'), 'utf8');
  assert.match(src, /noble-secp256k1 - MIT License/);
  assert.match(fs.readFileSync(path.join(dir, 'secp256k1.LICENSE'), 'utf8'), /The MIT License/);
  // .gitignore 里的 vendor/ 会匹配任何一级叫 vendor 的目录：放在那种目录下提交时会被静默漏掉
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../src/renderer/lib/relaySignaling.js'), 'utf8'), /from '\.\/vendor\//);
  assert.doesNotMatch(src, /Math\.random|innerHTML/);
});

test('签名：改过内容的事件验不过', async () => {
  const { signEvent, verifyEvent, newSigningKey } = await import(LIB);
  const ev = await signEvent(newSigningKey(), { kind: 23473, tags: [['x', 'aa']], content: 'hello' });
  assert.equal(await verifyEvent(ev), true);
  assert.equal(await verifyEvent({ ...ev, content: 'hellp' }), false);
  const other = await signEvent(newSigningKey(), { kind: 23473, tags: [['x', 'aa']], content: 'hello' });
  assert.equal(await verifyEvent({ ...ev, pubkey: other.pubkey }), false);
});
