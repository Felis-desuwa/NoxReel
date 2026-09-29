'use strict';

// 房间链接：新人偶尔要等约 30 秒才和老成员连上（0.7.10 之前「约每 30 次进房有 1 次」）。
//
// 实测（公共中继，150 次三人进房里 2 次）的根因：老成员从房主广播的 welcome 得知有新人，马上发 offer（只发一次）；
// 新人要是比老成员晚处理到这条 welcome（hello 只经一个中继发出、那个中继限流，welcome 靠积压回放才送到），
// 老成员那份 offer 从每个中继来的副本都被当成「署名的人不认识 = 冒名」丢掉，只能等 30 秒握手超时重发。
// 修法：新人先等几个中继的订阅生效再打招呼；认不出署名的、发给我的 signal 先扣下，welcome 到了再照常验签处理；
// 中继回 CLOSED 关掉订阅的，退避后重新订阅。桌面和安卓是同一份 relaySignaling.js，两份都跑。

const test = require('node:test');
const assert = require('node:assert/strict');
const { IMPLS } = require('./helpers/impls');

const FAST = { hello: 40, join: 1500, connect: 300, alive: 60, silent: 800, sweep: 40 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RELAYS = ['wss://a', 'wss://b'];

/**
 * 最小的假中继网络：REQ 回 EOSE，EVENT 回 OK 并推给所有匹配的订阅。
 * delay.set('发的人->收的人', 毫秒)：这条路上的事件晚这么久才送到（模拟 welcome 靠慢中继的回放才到）。
 */
class FakeNet {
  constructor() {
    this.relays = new Map();
    this.sockets = new Set();
    this.reqs = [];
    this.delay = new Map();
  }
  relay(url) {
    if (!this.relays.has(url)) this.relays.set(url, { subs: new Set() });
    return this.relays.get(url);
  }
  static matches(f, ev) {
    if (!f.kinds.includes(ev.kind) || ev.created_at < (f.since ?? 0)) return false;
    return ev.tags.some((t) => t[0] === 'x' && f['#x'].includes(t[1]));
  }
  WebSocket(owner) {
    const net = this;
    return class FakeWS {
      constructor(url) {
        this.url = url;
        this.owner = owner;
        this.readyState = 0;
        net.sockets.add(this);
        setTimeout(() => {
          if (this.readyState === 3) return;
          this.readyState = 1;
          this.onopen?.();
        }, 5);
      }
      _deliver(frame, extra = 0) {
        if (this.readyState !== 1) return;
        setTimeout(() => this.readyState === 1 && this.onmessage?.({ data: frame }), 2 + extra);
      }
      send(text) {
        if (this.readyState !== 1) return;
        const msg = JSON.parse(text);
        const relay = net.relay(this.url);
        if (msg[0] === 'REQ') {
          const [, id, filter] = msg;
          net.reqs.push({ url: this.url, owner: this.owner, id });
          for (const s of [...relay.subs]) if (s.ws === this && s.id === id) relay.subs.delete(s);
          relay.subs.add({ ws: this, id, filter });
          this._deliver(JSON.stringify(['EOSE', id]));
        } else if (msg[0] === 'CLOSE') {
          for (const s of relay.subs) if (s.ws === this && s.id === msg[1]) relay.subs.delete(s);
        } else if (msg[0] === 'EVENT') {
          const ev = msg[1];
          this._deliver(JSON.stringify(['OK', ev.id, true, '']));
          for (const s of relay.subs) {
            if (FakeNet.matches(s.filter, ev)) s.ws._deliver(JSON.stringify(['EVENT', s.id, ev]), net.delay.get(`${this.owner}->${s.ws.owner}`) || 0);
          }
        }
      }
      close() {
        this.readyState = 3;
        for (const r of net.relays.values()) for (const s of r.subs) if (s.ws === this) r.subs.delete(s);
        setTimeout(() => this.onclose?.(), 1);
      }
    };
  }
}

async function room(t, dir, net = new FakeNet()) {
  const lib = await import(dir + 'relaySignaling.js');
  const secret = lib.newRoomSecret();
  const made = [];
  const make = (owner, o) => {
    const sig = new lib.RelaySignaling({ relays: RELAYS, protocolVersion: 2, WebSocketImpl: net.WebSocket(owner), timing: FAST, ...o });
    sig._backoff = (retry) => Math.min(80, 10 * 2 ** retry);
    made.push(sig);
    return sig;
  };
  t.after(() => made.forEach((s) => s.close()));
  const host = make('host', { secret, isHost: true, hostId: 'host', peerId: 'host', name: '房主', maxMembers: 8 });
  await host.connect();
  const guest = (peerId) => make(peerId, { secret, hostId: 'host', hostKey: host.publicKey, peerId, name: `观众${peerId}` });
  return { lib, net, host, guest };
}

async function until(cond, what, maxMs = 3000) {
  for (let waited = 0; waited < maxMs; waited += 10) {
    if (cond()) return;
    await sleep(10);
  }
  assert.fail(`等不到：${what}`);
}

for (const { name, dir } of IMPLS) {
  test(`${name}：老成员的 offer 比新人自己的 welcome 先到：先扣下，welcome 一到照常验签交出去，不用等 30 秒`, async (t) => {
    const r = await room(t, dir);
    const a = r.guest('a');
    await a.connect();
    // a 看到新人就发 offer（app 里是 peer-join 之后 new Peer + createOffer，这里直接发）
    a.on('peer-join', ({ peerId }) => a.signal(peerId, { type: 'offer', sdp: 'offer-from-a' }));
    // 房主发给新人 c 的一路慢 300 毫秒：c 先收到 a 的 offer，后收到自己的 welcome
    r.net.delay.set('host->c', 300);
    const c = r.guest('c');
    const got = [];
    c.on('signal', (s) => got.push(s));
    await c.connect();
    await until(() => got.some((s) => s.from === 'a'), '新人收到老成员的 offer', 2000);
    const offer = got.find((s) => s.from === 'a');
    assert.deepEqual(offer.payload, { type: 'offer', sdp: 'offer-from-a' });
    assert.equal(c._parked?.size || 0, 0, '扣下的都处理掉了');
  });

  test(`${name}：扣下的只有发给我、署名不认识的 signal；冒名的照样验签不过`, async (t) => {
    const r = await room(t, dir);
    const c = r.guest('c');
    await c.connect();
    const got = [];
    c.on('signal', (s) => got.push(s));
    // 名册里没有、也永远不会有的人：扣着，过期自己扔，不会交出去
    c._park('wss://a', { id: 'e'.repeat(64) }, c._room, null, { t: 'signal', to: 'c', from: 'ghost' });
    assert.equal(c._parked.size, 1);
    // 不是发给我的、房主署名的、hello 都不扣
    c._park('wss://a', { id: 'f'.repeat(64) }, c._room, null, { t: 'signal', to: 'x', from: 'ghost2' });
    c._park('wss://a', { id: 'd'.repeat(64) }, c._room, null, { t: 'signal', to: 'c', from: 'host' });
    c._park('wss://a', { id: 'c'.repeat(64) }, c._room, null, { t: 'hello', to: 'c', from: 'ghost3' });
    assert.equal(c._parked.size, 1);
    // 最多扣 16 条
    for (let i = 0; i < 20; i++) c._park('wss://a', { id: String(i).padStart(64, '0') }, c._room, null, { t: 'signal', to: 'c', from: `g${i}` });
    assert.equal(c._parked.size, 16);
    c._unpark();
    assert.deepEqual(got, []);
  });

  test(`${name}：新人先等订阅生效再打招呼，hello 从每个中继都发出去`, async (t) => {
    const r = await room(t, dir);
    const c = r.guest('c');
    await c.connect();
    const cReqs = r.net.reqs.filter((q) => q.owner === 'c').map((q) => q.url);
    assert.deepEqual([...new Set(cReqs)].sort(), RELAYS, '两个中继都订阅上了才进房');
    assert.equal(c._listeningCount(), RELAYS.length);
  });

  test(`${name}：中继回 CLOSED 把订阅关了：退避之后重新订阅，不会一直聋着`, async (t) => {
    const r = await room(t, dir);
    const before = r.net.reqs.filter((q) => q.owner === 'host' && q.url === 'wss://a').length;
    const slot = r.host._sockets.get('wss://a');
    slot.ws.onmessage({ data: JSON.stringify(['CLOSED', slot.sub, 'rate-limited: server busy, retry later']) });
    // 别的订阅 id 的 CLOSED 不算
    slot.ws.onmessage({ data: JSON.stringify(['CLOSED', 'other', 'x']) });
    await until(() => r.net.reqs.filter((q) => q.owner === 'host' && q.url === 'wss://a').length === before + 1, '重新订阅', 3500);
    await sleep(100);
    assert.equal(slot.closedRetry, 0, '回了 EOSE，退避次数从头算');
  });
}
