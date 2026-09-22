'use strict';

// 房间链接（公共中继）和邀请码解析的加固（0.7.5 审计）。
//
//  1. 中继事件先验签、再按 id 记成「已处理」：恶意中继抢先送一份改过签名的副本，真的那份照样进来。
//  2. 去重表按时间淘汰、只记验过的事件，外加每个发送方的计数窗口：灌垃圾冲不掉，重放不生效。
//  3. 换链接时新密钥逐人 ECDH 加密：只拿着旧链接、挂在旧话题上旁听的人拿不到。
//  4. 各种 DoS：畸形帧、超大帧、hello 洪水、信令洪水、各张表无限增长、密文被人另签冒用；
//     邀请码的 gzip 炸弹和平方级正则。
//  5. 假身份占位：放行了却迟迟不和房主建直连的，宽限期后移出并封禁；待定名额有上限（BUSY）。
//
// 中继信令的基本流程见 relaySignaling.test.js，这里用同一种内存里的假中继网络，
// 另外加了「某个中继收到事件后先做点手脚」的钩子，好模拟恶意中继和旁听的局外人。

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { IMPLS } = require('./helpers/impls');

const LIB = '../src/renderer/lib/relaySignaling.js';
const FAST = { hello: 40, join: 600, connect: 300, alive: 60, silent: 250, sweep: 40 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RELAYS = ['wss://a', 'wss://b', 'wss://c'];

/** 按 Nostr 中继协议（REQ / EVENT / CLOSE）工作的假中继网络。hooks：url -> (ev, deliverNow) => 是否照常投递 */
class FakeNet {
  constructor() {
    this.relays = new Map();
    this.hooks = new Map();
  }
  relay(url) {
    if (!this.relays.has(url)) this.relays.set(url, { subs: new Set(), events: [] });
    return this.relays.get(url);
  }
  /** 立刻把一条事件送给这个中继上所有匹配的订阅者，返回各订阅者处理完的 Promise。 */
  deliverNow(url, ev) {
    const out = [];
    for (const s of this.relay(url).subs) {
      const f = s.filter;
      if (!f.kinds.includes(ev.kind)) continue;
      if (!Array.isArray(ev.tags) || !ev.tags.some((t) => Array.isArray(t) && t[0] === 'x' && f['#x'].includes(t[1]))) continue;
      if (s.ws.readyState === 1) out.push(s.ws.onmessage?.({ data: JSON.stringify(['EVENT', s.id, ev]) }));
    }
    return Promise.all(out);
  }
  WebSocket() {
    const net = this;
    return class FakeWS {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        setTimeout(() => {
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
          const hook = net.hooks.get(this.url);
          if (hook && hook(ev, (fake) => net.deliverNow(this.url, fake)) === false) return;
          setTimeout(() => net.deliverNow(this.url, ev), 2);
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

async function room(t, { maxMembers = 8, net = new FakeNet(), relays = RELAYS, host: hostOpts = {} } = {}) {
  const lib = await import(LIB);
  const secret = lib.newRoomSecret();
  const made = [];
  const make = (o) => {
    const sig = new lib.RelaySignaling({ relays, timing: FAST, WebSocketImpl: net.WebSocket(), protocolVersion: 2, ...o });
    made.push(sig);
    return sig;
  };
  t.after(() => made.forEach((s) => s.close()));
  const logs = new Map();
  const record = (sig) => {
    const log = [];
    for (const e of ['joined', 'peer-join', 'peer-leave', 'signal', 'rekey']) sig.on(e, (p) => log.push([e, p]));
    logs.set(sig, log);
  };
  const host = make({ secret, isHost: true, hostId: 'host', peerId: 'host', name: '房主', maxMembers, ...hostOpts });
  record(host);
  await host.connect();
  const guest = (peerId, extra = {}) => {
    const g = make({ secret, hostId: 'host', hostKey: host.publicKey, peerId, name: `观众${peerId}`, ...extra });
    record(g);
    return g;
  };
  const events = (sig, name) => logs.get(sig).filter(([e]) => e === name).map(([, p]) => p);
  return { lib, host, guest, net, secret, events, make };
}

/* ---------- 测试里自己拼消息：和 0.7.4 客户端一模一样的封装格式 ---------- */

function chatSafeB64(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '.').replace(/=+$/, '');
}

function fromChatSafeB64(s) {
  return new Uint8Array(Buffer.from(String(s).replace(/-/g, '+').replace(/[._]/g, '/'), 'base64'));
}

async function sealLike074(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  return chatSafeB64(Buffer.concat([iv, ct]));
}

async function openWith(key, content) {
  try {
    const bytes = fromChatSafeB64(content);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    return null;
  }
}

async function craft(lib, room, key, body, createdAt) {
  const content = await sealLike074(room.key, body);
  return lib.signEvent(key, { kind: lib.RELAY_EVENT_KIND, tags: [['x', room.topic]], content, createdAt });
}

/** 在假中继上按内容找事件（用房间密钥解开来看）。 */
async function findEvents(r, secret, pred) {
  const room = await r.lib.deriveRoom(secret);
  const out = [];
  const seen = new Set();
  for (const relay of r.net.relays.values()) {
    for (const ev of relay.events) {
      if (seen.has(ev.id) || !ev.tags.some((t) => t[1] === room.topic)) continue;
      seen.add(ev.id);
      const body = await openWith(room.key, ev.content);
      if (body && pred(body, ev)) out.push({ ev, body });
    }
  }
  return out;
}

const randHex = (n) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString('hex');
const flipHex = (hex) => hex.slice(0, -1) + (hex.at(-1) === '0' ? '1' : '0');
const OFFER = (sdp) => ({ kind: 'offer', sdp: { type: 'offer', sdp } });

/* ------------------------------ 1. 先验签再去重 ------------------------------ */

test('恶意中继抢先送一份改过签名（或内容）的副本：真的那份照样被接受，进房和信令都不受影响', async (t) => {
  const net = new FakeNet();
  // wss://evil 收到什么都立刻给订阅者送两份假的（同一个 id：一份签名被改、一份内容被改），真的那份扣下不送
  net.hooks.set('wss://evil', (ev, now) => {
    now({ ...ev, sig: flipHex(ev.sig) });
    now({ ...ev, content: `${ev.content.slice(0, -4)}AAAA` });
    return false;
  });
  const r = await room(t, { net, relays: ['wss://evil', 'wss://a', 'wss://b'] });
  const a = r.guest('a');
  await a.connect(); // 旧实现：房主先收到假的、把 id 记下，真 hello 全被当重复丢掉 —— HOST_OFFLINE
  r.host.signal('a', OFFER('v=0 real'));
  await sleep(80);
  const got = r.events(a, 'signal');
  assert.equal(got.length, 1, `应当恰好收到一次，实际 ${got.length}`);
  assert.equal(got[0].payload.sdp.sdp, 'v=0 real');
});

/* ------------------------------ 2. 去重表与重放 ------------------------------ */

test('只知道话题标签的局外人灌几千条垃圾：去重表不涨，录下的 offer 原样重放也不再生效', async (t) => {
  const r = await room(t);
  const a = r.guest('a');
  await a.connect();
  r.host.signal('a', OFFER('first'));
  await sleep(60);
  const [{ ev: genuine }] = await findEvents(r, r.secret, (b) => b.t === 'signal');
  const topic = genuine.tags[0][1];
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 5000; i++) {
    const junk = {
      id: randHex(32),
      pubkey: randHex(32),
      created_at: now,
      kind: r.lib.RELAY_EVENT_KIND,
      tags: [['x', topic]],
      content: chatSafeB64(crypto.getRandomValues(new Uint8Array(64))),
      sig: randHex(64),
    };
    r.net.deliverNow(RELAYS[i % 3], junk);
  }
  await sleep(80);
  assert.ok(a._seen.size < 200, `垃圾事件进了去重表：${a._seen.size} 条`);
  await r.net.deliverNow('wss://b', genuine);
  await sleep(40);
  assert.equal(r.events(a, 'signal').length, 1, '重放的 offer 又被处理了一次');
});

test('去重记录按时间淘汰：新鲜窗口之内一直记着，出了窗口才忘，两段之间没有空当', async (t) => {
  const r = await room(t);
  const a = r.guest('a');
  await a.connect();
  r.host.signal('a', OFFER('first'));
  await sleep(60);
  const [{ ev: genuine }] = await findEvents(r, r.secret, (b) => b.t === 'signal');
  assert.equal(r.events(a, 'signal').length, 1);

  const realNow = Date.now;
  t.after(() => {
    Date.now = realNow;
  });
  let offset = 0;
  Date.now = () => realNow() + offset;

  // 快到窗口边上（600 秒）：这条事件仍然会通过新鲜检查，所以去重表必须还记着它
  offset = 590 * 1000;
  a._prune();
  assert.ok(a._seen.has(genuine.id), '事件还在新鲜窗口里，去重记录却已经被清掉了');
  await r.net.deliverNow('wss://a', genuine);
  assert.equal(r.events(a, 'signal').length, 1, '窗口内的重放被接受了');

  // 出了窗口：记录可以清掉，重放由新鲜检查挡住
  offset = 700 * 1000;
  a._prune();
  assert.ok(!a._seen.has(genuine.id), '过了窗口的记录应当清掉，否则表只涨不落');
  await r.net.deliverNow('wss://a', genuine);
  assert.equal(r.events(a, 'signal').length, 1, '过期事件被接受了');
});

test('同一段密文换个时间戳重新签一次（id 变了）：按发送方计数挡掉', async (t) => {
  const r = await room(t);
  const a = r.guest('a');
  await a.connect();
  r.host.signal('a', OFFER('first'));
  await sleep(60);
  const [{ ev: genuine, body }] = await findEvents(r, r.secret, (b) => b.t === 'signal');
  assert.ok(Number.isSafeInteger(body.n) && body.n > 0, '0.7.5 发出的消息要带计数 n');
  assert.equal(body.pk, r.host.publicKey, '0.7.5 发出的消息要带签名公钥 pk');
  const again = await r.lib.signEvent(r.host.key, {
    kind: genuine.kind,
    tags: genuine.tags,
    content: genuine.content,
    createdAt: genuine.created_at + 1,
  });
  assert.notEqual(again.id, genuine.id);
  await r.net.deliverNow('wss://a', again);
  await sleep(20);
  assert.equal(r.events(a, 'signal').length, 1, '换了 id 的重放被接受了');
});

test('兼容 0.7.4：不带计数和签名公钥的消息照常处理，0.7.4 房主的广播式换链接也照常跟过去', async (t) => {
  const r = await room(t);
  const a = r.guest('a');
  await a.connect();
  const oldRoom = await r.lib.deriveRoom(r.secret);
  const legacy = (body) => craft(r.lib, oldRoom, r.host.key, { v: 1, from: 'host', name: '房主', ts: Date.now(), ...body });
  await r.net.deliverNow('wss://a', await legacy({ t: 'signal', to: 'a', payload: OFFER('from 0.7.4') }));
  await sleep(20);
  assert.deepEqual(r.events(a, 'signal').map((s) => s.payload.sdp.sdp), ['from 0.7.4']);

  const next = r.lib.newRoomSecret();
  await r.net.deliverNow('wss://a', await legacy({ t: 'rekey', secret: next }));
  await sleep(20);
  assert.equal(a.secret, next, '0.7.4 房主换链接后成员没跟过去');
});

/* ------------------------------ 3. 换链接 ------------------------------ */

test('换链接：新密钥不出现在旧话题的任何消息里；已放行的成员照样拿到并搬过去', async (t) => {
  const r = await room(t);
  const a = r.guest('a');
  await a.connect();
  // 另一个拿着旧链接的人：还在等房主放行（房主不理他），一直挂在旧话题上
  const next = r.lib.newRoomSecret();
  await r.host.rekey(next);
  await sleep(80);
  assert.equal(a.secret, next, '已放行的成员没拿到新密钥');
  assert.equal(r.events(a, 'rekey').length, 1);
  // 旁听者手里有旧链接：旧话题上的每一条他都解得开 —— 里面不能有新密钥
  const leaked = await findEvents(r, r.secret, (body) => JSON.stringify(body).includes(next));
  assert.deepEqual(leaked.map((x) => x.body.t), [], '旧话题上的消息里出现了新密钥');
  // 新链接照常能进，搬过去的成员认得新人
  const c = r.make({ secret: next, hostId: 'host', hostKey: r.host.publicKey, peerId: 'c', name: 'c' });
  await c.connect();
});

test('换链接：已经被静默清理掉的成员拿不到新密钥（还没来得及清理、但已经静默的也拿不到）', async (t) => {
  const r = await room(t);
  const a = r.guest('a');
  await a.connect();
  const b = r.guest('b');
  await b.connect();
  const d = r.guest('d');
  await d.connect();
  // b 彻底哑掉（不发心跳），但还挂在中继上听着
  b._send = async () => {};
  await sleep(450);
  assert.ok(!r.host._members.has('b'), 'b 应当已经被房主当成离开');
  // d 也哑了，只是房主的定期清理还没轮到它（停掉房主的定时器，免得清理抢在换链接前面）
  for (const timer of r.host._timers) clearInterval(timer);
  r.host._timers = [];
  d._send = async () => {};
  r.host._members.get('d').lastSeen = 0;
  const next = r.lib.newRoomSecret();
  await r.host.rekey(next);
  await sleep(80);
  assert.equal(a.secret, next);
  assert.notEqual(b.secret, next, '被清理掉的成员拿到了新密钥');
  assert.notEqual(d.secret, next, '已经静默的成员拿到了新密钥');
});

test('逐人密钥：两边用 x-only 公钥做 ECDH 算出同一把，与 y 的奇偶无关；换一个人算就解不开', async () => {
  const { pairKey, newSigningKey } = await import(LIB);
  const { getPublicKey } = await import('../src/renderer/lib/third_party/secp256k1.js');
  const parity = (k) => getPublicKey(k.secretKey, true)[0]; // 2：y 为偶，3：y 为奇
  const combos = new Set();
  const iv = new Uint8Array(12);
  for (let i = 0; i < 400 && combos.size < 4; i++) {
    const host = newSigningKey();
    const member = newSigningKey();
    combos.add(`${parity(host)}${parity(member)}`);
    const byHost = await pairKey(host.secretKey, member.publicKey, 'topic', 'm');
    const byMember = await pairKey(member.secretKey, host.publicKey, 'topic', 'm');
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, byHost, new TextEncoder().encode('secret'));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, byMember, ct);
    assert.equal(new TextDecoder().decode(pt), 'secret', `y 的奇偶 ${parity(host)}/${parity(member)} 时两边算的不一样`);
    const outsider = await pairKey(newSigningKey().secretKey, host.publicKey, 'topic', 'm');
    await assert.rejects(crypto.subtle.decrypt({ name: 'AES-GCM', iv }, outsider, ct));
    const otherContext = await pairKey(member.secretKey, host.publicKey, 'topic', 'someone-else');
    await assert.rejects(crypto.subtle.decrypt({ name: 'AES-GCM', iv }, otherContext, ct));
  }
  assert.equal(combos.size, 4, `y 的奇偶组合没覆盖全：${[...combos]}`);
});

/* ------------------------------ 4. DoS ------------------------------ */

test('中继发来畸形的帧：一律安静丢掉，不抛异常、不留下未处理的 Promise 拒绝', async (t) => {
  const r = await room(t);
  const a = r.guest('a');
  await a.connect();
  const topic = (await r.lib.deriveRoom(r.secret)).topic;
  const base = {
    id: randHex(32),
    pubkey: randHex(32),
    created_at: Math.floor(Date.now() / 1000),
    kind: r.lib.RELAY_EVENT_KIND,
    tags: [['x', topic]],
    content: 'AAAA',
    sig: randHex(64),
  };
  const ev = (patch) => JSON.stringify(['EVENT', 'nr', { ...base, ...patch }]);
  const frames = [
    123,
    null,
    new ArrayBuffer(8),
    'not json',
    'null',
    '{}',
    '[]',
    '["EVENT"]',
    '["EVENT","nr",null]',
    '["EVENT","nr",[1,2]]',
    '["EVENT","nr","str"]',
    ev({ tags: [null] }),
    ev({ tags: [['x', topic], null] }),
    ev({ tags: 'x' }),
    ev({ tags: [[{}]] }),
    ev({ tags: Array(1000).fill(['x', topic]) }),
    ev({ created_at: 'now' }),
    ev({ created_at: 1e300 }),
    ev({ content: { a: 1 } }),
    ev({ id: 'zz' }),
    ev({ pubkey: null }),
    `["EVENT","nr",${'['.repeat(5000)}${']'.repeat(5000)}]`,
    'x'.repeat(300 * 1024),
  ];
  for (const who of [a, r.host]) {
    for (const f of frames) await who._onRelayMessage('wss://a', f);
  }
  assert.equal(r.events(a, 'signal').length, 0);
});

test('超大事件在解密、验签之前就丢掉；正常大小的照常收', async (t) => {
  const r = await room(t);
  const a = r.guest('a');
  await a.connect();
  r.host.signal('a', OFFER('x'.repeat(200 * 1024)));
  r.host.signal('a', OFFER('small'));
  await sleep(80);
  assert.deepEqual(r.events(a, 'signal').map((s) => s.payload.sdp.sdp), ['small']);
});

test('每个中继同时在处理的事件有上限：一口气灌进来的不会在内存里无限堆积', async (t) => {
  const r = await room(t);
  const a = r.guest('a');
  await a.connect();
  const topic = (await r.lib.deriveRoom(r.secret)).topic;
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 1000; i++) {
    const junk = { id: randHex(32), pubkey: randHex(32), created_at: now, kind: r.lib.RELAY_EVENT_KIND, tags: [['x', topic]], content: 'AAAAAAAAAAAAAAAAAAAAAAAA', sig: randHex(64) };
    a._onRelayMessage('wss://a', JSON.stringify(['EVENT', 'nr', junk]));
  }
  assert.ok(a._inflight.get('wss://a') <= 32, `同时在处理 ${a._inflight.get('wss://a')} 条`);
  assert.ok(a._chains.size <= 32);
  await sleep(50);
  assert.equal(a._inflight.get('wss://a'), 0);
  assert.equal(a._chains.size, 0);
});

test('拿着链接的人用几百个不同身份刷 hello：放行不超过人数上限，回绝有限速，房里的人照常通信', async (t) => {
  const r = await room(t, { maxMembers: 4 });
  const a = r.guest('a');
  await a.connect();
  const cur = await r.lib.deriveRoom(r.secret);
  const hellos = [];
  for (let i = 0; i < 300; i++) {
    const key = r.lib.newSigningKey();
    hellos.push(await craft(r.lib, cur, key, { t: 'hello', ver: 2, v: 1, from: `x${i}`, name: 'x', ts: Date.now(), n: 1, pk: key.publicKey }));
  }
  const before = new Set((await findEvents(r, r.secret, (b) => b.t === 'reject')).map((x) => x.ev.id));
  // 验过签、交到守门逻辑手上的 hello 有多少：没登记过的公钥，验签有总预算
  let handled = 0;
  const onHello = r.host._onHello.bind(r.host);
  r.host._onHello = (...args) => {
    handled++;
    return onHello(...args);
  };
  for (let i = 0; i < hellos.length; i++) await r.net.deliverNow(RELAYS[i % 3], hellos[i]);
  await sleep(60);
  assert.ok(handled <= 90, `300 条 hello 验了 ${handled} 条签名`);
  const admitted = r.events(r.host, 'peer-join').map((p) => p.peerId).filter((id) => id !== 'a');
  assert.ok(admitted.length <= 2, `放行了 ${admitted.length} 个（上限 4 人，房主和 a 已经占了两个）`);
  const rejects = (await findEvents(r, r.secret, (b) => b.t === 'reject')).filter((x) => !before.has(x.ev.id));
  assert.ok(rejects.length <= 12, `房主跟着发了 ${rejects.length} 条回绝`);
  // 已经在房里的人不受影响
  a.signal('host', OFFER('still works'));
  await sleep(80);
  assert.deepEqual(r.events(r.host, 'signal').map((s) => s.payload.sdp.sdp), ['still works']);
});

test('房主没设人数上限（0）时也有硬上限；同一个人连发 hello 不会让房主跟着狂发 welcome', async (t) => {
  const r = await room(t, { maxMembers: 0 });
  const sent = [];
  const realSend = r.host._send.bind(r.host);
  r.host._send = (body) => {
    sent.push(body.t);
    return realSend(body);
  };
  for (let i = 0; i < 100; i++) r.host._onHello({ from: `p${i}`, name: 'x', ver: 2 }, randHex(32));
  assert.ok(r.host._members.size <= 63, `成员表涨到了 ${r.host._members.size}`);
  const welcomes = sent.filter((x) => x === 'welcome').length;
  const member = [...r.host._members.entries()][0];
  sent.length = 0;
  for (let i = 0; i < 20; i++) r.host._onHello({ from: member[0], name: 'x', ver: 2 }, member[1].pubkey);
  assert.ok(sent.filter((x) => x === 'welcome').length <= 1, `连发 20 次 hello，房主重发了 ${sent.length} 次 welcome`);
  assert.equal(welcomes, r.host._members.size);
});

test('已放行的成员狂发信令：收件人按发送方限速，不会跟着无限重建连接', async (t) => {
  const r = await room(t);
  const a = r.guest('a');
  await a.connect();
  const b = r.guest('b');
  await b.connect();
  // 匀速地发：一口气灌的会先撞上「每个中继同时在处理的上限」，测不到按发送方的限速
  for (let i = 0; i < 100; i++) {
    a.signal('b', OFFER(`flood ${i}`));
    await sleep(4);
  }
  await sleep(200);
  const got = r.events(b, 'signal').length;
  assert.ok(got >= 5 && got <= 40, `收了 ${got} 条`);
  // 房主那边的消息不受 a 的洪水影响
  r.host.signal('b', OFFER('from host'));
  await sleep(80);
  assert.ok(r.events(b, 'signal').some((s) => s.from === 'host'));
});

test('成员这边记的公钥有上限，长时间没动静的会被清掉', async (t) => {
  const r = await room(t);
  const a = r.guest('a');
  await a.connect();
  for (let i = 0; i < 300; i++) a._onWelcome({ peerId: `p${i}`, seq: 100 + i, pubkey: randHex(32), memberName: 'x' });
  assert.ok(a._bindings.size <= 128, `记了 ${a._bindings.size} 个`);
  for (const b of a._bindings.values()) b.lastSeen = 0;
  a._sweepSilent();
  assert.equal(a._bindings.size, 0);
  assert.equal(a._announced.size, 0);
});

test('局外人把新人 hello 的密文照抄、用自己的密钥另签一份抢先送到：房主不会把 peerId 绑给他', async (t) => {
  const net = new FakeNet();
  const { newSigningKey, signEvent } = await import(LIB);
  const thief = newSigningKey();
  // 局外人（没有房间链接）盯着中继：每条事件都照抄密文另签一份先送出去，真的随后才到
  net.hooks.set('wss://a', (ev, now) => {
    if (ev.pubkey === thief.publicKey) return true;
    signEvent(thief, { kind: ev.kind, tags: ev.tags, content: ev.content }).then(async (copy) => {
      await now(copy);
      await now(ev);
    });
    return false;
  });
  const r = await room(t, { net, relays: ['wss://a'] });
  const a = r.guest('a');
  await a.connect(); // 旧实现：房主把 a 绑到局外人的公钥上，真 a 的 hello 回 DUP_PEER
  assert.equal(r.host._members.get('a').pubkey, a.publicKey);
});

/* ------------------------------ 5. 假身份占位 ------------------------------ */

// 测试里的直连状态由这张表说了算：app 那边就是「房主和这个人的数据通道开着没有」
async function linkedRoom(t, { grace = 300, host = {}, ...rest } = {}) {
  const linked = new Set();
  const r = await room(t, { ...rest, host: { isLinked: (id) => linked.has(id), timing: { ...FAST, linkGraceMs: grace }, ...host } });
  return { ...r, linked };
}

function errorsOf(sig) {
  const out = [];
  sig.on('error', (e) => out.push(e));
  return out;
}

test('假身份只发心跳、不和房主建直连：宽限期内留着，过了就被移出（签名 leave 带 reason），自己收到 REMOVED 并关掉', async (t) => {
  const r = await linkedRoom(t);
  const a = r.guest('a');
  const aErrs = errorsOf(a);
  await a.connect();
  r.linked.add('a'); // 正常建连的成员
  const fake = r.guest('fake');
  const errs = errorsOf(fake);
  await fake.connect();
  await sleep(150);
  assert.ok(r.host._members.has('fake'), '宽限期还没过就被移出了');
  await sleep(400);
  assert.ok(!r.host._members.has('fake'), '一直没连上的假身份还占着名额');
  assert.ok(r.host._members.has('a'), '正常建连的成员被误伤');
  assert.deepEqual(errs.map((e) => e.code), ['REMOVED']);
  assert.deepEqual(aErrs, []);
  assert.ok(r.events(r.host, 'peer-leave').some((p) => p.peerId === 'fake'));
  assert.ok(r.events(a, 'peer-leave').some((p) => p.peerId === 'fake'), '其他成员要知道他走了');
  const leaves = await findEvents(r, r.secret, (b) => b.t === 'leave' && b.peerId === 'fake');
  assert.deepEqual(leaves.map((x) => x.body.reason), ['unlinked']);
  await sleep(30);
  assert.equal(fake._closedByUs, true, '被移出的一方要自己关掉');
});

test('被移出的人重进：同一个 peerId 换了新密钥也收到 REMOVED；同一把公钥换个 peerId 也不行', async (t) => {
  const r = await linkedRoom(t);
  const fake = r.guest('fake');
  await fake.connect();
  const bannedKey = fake.publicKey;
  await sleep(450);
  assert.ok(!r.host._members.has('fake'));
  const again = r.guest('fake');
  const errs = errorsOf(again);
  await assert.rejects(again.connect(), (e) => e.code === 'REMOVED');
  assert.deepEqual(errs.map((e) => e.code), ['REMOVED']);
  assert.ok(!r.host._members.has('fake'));
  // 公钥也记进了封禁表
  const sent = [];
  const realSend = r.host._send.bind(r.host);
  r.host._send = (body) => {
    sent.push(body);
    return realSend(body);
  };
  r.host._onHello({ from: 'other-id', name: 'x', ver: 2 }, bannedKey);
  assert.deepEqual(sent.map((b) => [b.t, b.code]), [['reject', 'REMOVED']]);
  assert.ok(!r.host._members.has('other-id'));
});

test('kick：房主立即移出并封禁，被踢的人收到 REMOVED、重进也不行；只有房主能用；封禁表有上限', async (t) => {
  const r = await linkedRoom(t, { grace: 60000 });
  const a = r.guest('a');
  const errs = errorsOf(a);
  await a.connect();
  r.linked.add('a');
  assert.throws(() => a.kick('host'), /只有房主/);
  assert.equal(r.host.kick('a'), true);
  assert.ok(!r.host._members.has('a'));
  await sleep(60);
  assert.deepEqual(errs.map((e) => e.code), ['REMOVED']);
  await assert.rejects(r.guest('a').connect(), (e) => e.code === 'REMOVED');
  assert.equal(r.host.kick('nobody-here'), false);
  for (let i = 0; i < 2000; i++) r.host.kick(`z${i}`);
  assert.ok(r.host._banned.size <= 512, `封禁表涨到了 ${r.host._banned.size}`);
});

test('待定名额满了：新人收到 BUSY 不算失败、继续重试；前面的人连上空出名额后就能进', async (t) => {
  const r = await linkedRoom(t, { grace: 10000, host: { pendingMax: 2 } });
  await r.guest('p1').connect();
  await r.guest('p2').connect();
  const p3 = r.guest('p3');
  const joining = p3.connect();
  await sleep(150);
  assert.ok(!r.host._members.has('p3'), '待定名额满了还在放行');
  const busy = await findEvents(r, r.secret, (b) => b.t === 'reject' && b.to === 'p3' && b.code === 'BUSY');
  assert.ok(busy.length >= 1, '新人没收到 BUSY');
  r.linked.add('p1'); // p1 连上了，空出一个待定名额
  await joining; // BUSY 不致命：p3 一直在重发 hello，这时就进来了
  assert.ok(r.host._members.has('p3'));
});

test('一直被 BUSY 挡着：进房超时报 BUSY；房主根本不理的仍报 HOST_OFFLINE', async (t) => {
  const r = await linkedRoom(t, { grace: 10000, host: { pendingMax: 1 } });
  await r.guest('p1').connect();
  // 拿错了房主公钥的人：房主的 BUSY 他不认，等于房主不在
  const { newSigningKey } = await import(LIB);
  const lost = r.guest('lost', { hostKey: newSigningKey().publicKey });
  await Promise.all([
    assert.rejects(r.guest('p2').connect(), (e) => e.code === 'BUSY' && /房主这边正在连接的人太多/.test(e.message)),
    assert.rejects(lost.connect(), (e) => e.code === 'HOST_OFFLINE'),
  ]);
});

test('判满员要算上放行了还没连上的人（occupied 只数得到连上的）', async (t) => {
  // 房主 + 两个一对一邀请进来的人已经连着（occupied = 3），上限 4
  const r = await linkedRoom(t, { grace: 10000, maxMembers: 4, host: { occupied: () => 3 } });
  await r.guest('p1').connect(); // 3 + 0 < 4，放行；p1 还没连上
  await assert.rejects(r.guest('p2').connect(), (e) => e.code === 'ROOM_FULL');
});

test('断线后在宽限期内重连不会被移出；连续断开超过宽限期才移出', async (t) => {
  const r = await linkedRoom(t);
  const a = r.guest('a');
  const errs = errorsOf(a);
  await a.connect();
  r.linked.add('a');
  await sleep(100);
  r.linked.delete('a');
  await sleep(150); // 短于宽限期（300ms）
  r.linked.add('a');
  await sleep(350);
  assert.ok(r.host._members.has('a'), '宽限期内重连上的成员被移出了');
  assert.deepEqual(errs, []);
  r.linked.delete('a');
  await sleep(450);
  assert.ok(!r.host._members.has('a'), '连续断开超过宽限期的还留着');
  assert.deepEqual(errs.map((e) => e.code), ['REMOVED']);
});

test('换链接只发给已经和房主连上直连的成员', async (t) => {
  const r = await linkedRoom(t, { grace: 10000 });
  const a = r.guest('a');
  await a.connect();
  r.linked.add('a');
  const p = r.guest('p');
  await p.connect(); // 放行了、没连上
  const next = r.lib.newRoomSecret();
  await r.host.rekey(next);
  await sleep(80);
  assert.equal(a.secret, next);
  assert.notEqual(p.secret, next, '还没连上直连的人拿到了新密钥');
});

test('没传 isLinked：不限待定名额、不因为没连上而移出，和以前一样', async (t) => {
  const r = await room(t, { maxMembers: 8 });
  const guests = [];
  for (let i = 0; i < 6; i++) {
    const g = r.guest(`g${i}`);
    guests.push(g);
    await g.connect();
  }
  await sleep(200);
  assert.equal(r.host._members.size, 6);
  assert.equal(r.host._t.linkGraceMs, 60000, 'linkGraceMs 默认 60 秒');
  assert.equal(r.host._pendingMax, 4, 'PENDING_MAX 默认 4');
});

/* ------------------------------ 邀请码解析 ------------------------------ */

test('邀请码：gzip 炸弹解到上限就停，报「邀请码异常过长」；正常的大码照常解', async () => {
  const bomb = zlib.gzipSync(`["o","a","${'A'.repeat(64 * 1024 * 1024)}",0,"s",2]`, { level: 9 });
  const code = `NR3-G${chatSafeB64(bomb)}`;
  assert.ok(code.length < 256 * 1024, '炸弹本身要在码长上限之内，才测得到解压这一步');
  const legacy = `SW1-${chatSafeB64(bomb)}`;
  const bigSdp = chatSafeB64(crypto.getRandomValues(new Uint8Array(60 * 1024)));
  for (const { name, dir } of IMPLS) {
    const { decodeCode, encodeCode } = await import(dir + 'signaling.js');
    for (const c of [code, legacy]) {
      const t0 = performance.now();
      await assert.rejects(decodeCode(c), /^Error: 邀请码异常过长$/, `${name}：炸弹被解开了`);
      assert.ok(performance.now() - t0 < 3000, `${name}：解炸弹花了 ${performance.now() - t0}ms`);
    }
    const ok = await decodeCode(await encodeCode({ k: 'offer', from: 'a', sdp: { type: 'offer', sdp: bigSdp }, securityMode: 'safe' }));
    assert.equal(ok.sdp.sdp, bigSdp, `${name}：正常的大码解不开了`);
  }
});

test('邀请码：一长串 http:// 不会把解析卡成平方级；超长输入直接拒；找链接的结果和原来一样', async () => {
  for (const { name, dir } of IMPLS) {
    const { unwrapInviteInput } = await import(dir + 'signaling.js');
    const t0 = performance.now();
    unwrapInviteInput('http://'.repeat(40000));
    const ms = performance.now() - t0;
    assert.ok(ms < 500, `${name}：280KB 的 http:// 串花了 ${ms.toFixed(0)}ms`);
    assert.throws(() => unwrapInviteInput('x'.repeat(1024 * 1024 + 1)), /^Error: 邀请码异常过长$/);
    assert.equal(unwrapInviteInput('看这个 http://a#b 然后 https://x.y/NoxReel/#j/Rabc/ 谢谢'), 'NR3-Rabc');
    assert.equal(unwrapInviteInput('<https://x.y/#a/Gq-.z/>'), 'NR3-Gq-.z');
    assert.equal(unwrapInviteInput('HTTPS://X.Y/#J/Rabc/'), 'NR3-Rabc');
    // http:// 和 # 之间至少要有一个字符（原来的正则就是这样）
    assert.equal(unwrapInviteInput('http://#j/Rabc/'), 'http://#j/Rabc/');
    assert.equal(unwrapInviteInput('https://a"#j/Rabc/'), 'https://a"#j/Rabc/');
  }
});
