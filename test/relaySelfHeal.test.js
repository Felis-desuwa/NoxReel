'use strict';

// 房间链接的断线自愈（批次 3）。
//
// 中继上都是临时事件：谁的中继全断了，这段时间里发出去的 offer / renegotiate 就丢了，
// 别人发来的也收不到。以前的结果是：房主自己断网一两分钟，经链接进来的人全被当成
// 「连不上直连的假身份」移出并封禁；成员断网几十秒，中继回来了也没有任何东西再拉起直连。
// 这里用一张能按「谁」断网的假中继网络，把断网、半开连接、恢复都跑一遍。
// 桌面和安卓是同一份 relaySignaling.js，两份都跑。

const test = require('node:test');
const assert = require('node:assert/strict');
const { IMPLS } = require('./helpers/impls');

const FAST = { hello: 40, join: 600, connect: 300, alive: 60, silent: 250, sweep: 40 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RELAYS = ['wss://a', 'wss://b'];

/**
 * 按 Nostr 中继协议工作的假中继网络，另外能让某一方「断网」：
 *  - cut(owner)：他的连接全部关掉，新连接也连不上（网卡掉了、IP 没了）；
 *  - cut(owner, 'silent')：连接看着还开着，但两个方向都一个字节不走（半开的 TCP）；
 *  - restore(owner)：网络回来了。
 * EVENT 收到后回 OK，并把事件推给所有匹配的订阅（含发送者自己的），实时推送也按 since 过滤。
 * REQ 之后回 EOSE。中继存着的临时事件回不回放按中继分（replay），和实测的公共中继一样：
 *  - 'limit'：strfry 那样，订阅不带 limit:0 就在 EOSE 之前把存着的全回放；
 *  - 'always'：不理 limit，照样回放（实测 bucket.coracle.social）；
 *  - 不设：什么都不存。
 * noEose 里的中继从不回 EOSE（实测 nostr-relay.corb.net 对带 limit:0 的订阅）。
 */
class FakeNet {
  constructor() {
    this.relays = new Map();
    this.down = new Map(); // owner -> 'close' | 'silent'
    this.sockets = new Set();
    this.reqs = [];
    this.opens = new Map(); // url -> 连上的次数
    this.kick = new Set(); // 这些中继握手后立刻把人踢掉
    this.replay = new Map(); // url -> 'limit' | 'always'
    this.noEose = new Set();
    this.replayed = []; // [{ url, owner, ev }]：回放出去的事件
  }
  relay(url) {
    if (!this.relays.has(url)) this.relays.set(url, { subs: new Set(), events: [] });
    return this.relays.get(url);
  }
  static matches(f, ev) {
    if (!f.kinds.includes(ev.kind) || ev.created_at < (f.since ?? 0)) return false;
    return ev.tags.some((t) => t[0] === 'x' && f['#x'].includes(t[1]));
  }
  cut(owner, mode = 'close') {
    this.down.set(owner, mode);
    if (mode !== 'close') return;
    for (const ws of this.sockets) if (ws.owner === owner && ws.readyState !== 3) ws._drop();
  }
  restore(owner) {
    this.down.delete(owner);
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
          if (net.down.has(owner) || this.readyState === 3) {
            this.readyState = 3;
            this.onclose?.();
            return;
          }
          this.readyState = 1;
          net.opens.set(url, (net.opens.get(url) || 0) + 1);
          this.onopen?.();
          if (net.kick.has(url)) setTimeout(() => this._drop(), 1);
        }, 5);
      }
      _drop() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        for (const r of net.relays.values()) for (const s of r.subs) if (s.ws === this) r.subs.delete(s);
        setTimeout(() => this.onclose?.(), 1);
      }
      _deliver(frame) {
        if (this.readyState !== 1 || net.down.has(this.owner)) return;
        setTimeout(() => this.readyState === 1 && !net.down.has(this.owner) && this.onmessage?.({ data: frame }), 2);
      }
      send(text) {
        if (this.readyState !== 1 || net.down.has(this.owner)) return;
        const msg = JSON.parse(text);
        const relay = net.relay(this.url);
        if (msg[0] === 'REQ') {
          const [, id, filter] = msg;
          net.reqs.push({ url: this.url, owner: this.owner, id, filter, at: Math.floor(Date.now() / 1000) });
          relay.subs.add({ ws: this, id, filter });
          // 回放和 EOSE 走同一个投递队列，先后次序和真中继一样：存着的在前，EOSE 在后
          const mode = net.replay.get(this.url);
          if (mode === 'always' || (mode === 'limit' && filter.limit !== 0)) {
            for (const ev of relay.events) {
              if (!FakeNet.matches(filter, ev)) continue;
              net.replayed.push({ url: this.url, owner: this.owner, ev });
              this._deliver(JSON.stringify(['EVENT', id, ev]));
            }
          }
          if (!net.noEose.has(this.url)) this._deliver(JSON.stringify(['EOSE', id]));
        } else if (msg[0] === 'CLOSE') {
          for (const s of relay.subs) if (s.ws === this && s.id === msg[1]) relay.subs.delete(s);
        } else if (msg[0] === 'EVENT') {
          const ev = msg[1];
          relay.events.push(ev);
          this._deliver(JSON.stringify(['OK', ev.id, true, '']));
          for (const s of relay.subs) {
            if (FakeNet.matches(s.filter, ev)) s.ws._deliver(JSON.stringify(['EVENT', s.id, ev]));
          }
        }
      }
      close() {
        this._drop();
      }
    };
  }
}

/** 一个房间：房主带 isLinked（直连状态由 linked 这张表说了算），成员按需加。 */
async function room(t, dir, { grace = 300, host: hostOpts = {}, timing = {}, net = new FakeNet() } = {}) {
  const lib = await import(dir + 'relaySignaling.js');
  const secret = lib.newRoomSecret();
  const made = [];
  const logs = new Map();
  const linked = new Set();
  const make = (owner, o) => {
    const sig = new lib.RelaySignaling({
      relays: RELAYS,
      protocolVersion: 2,
      WebSocketImpl: net.WebSocket(owner),
      timing: { ...FAST, linkGraceMs: grace, ...timing },
      ...o,
    });
    // 测试里重连退避压到几十毫秒；退避公式本身不在这里测
    sig._backoff = (retry) => Math.min(80, 10 * 2 ** retry);
    made.push(sig);
    const log = [];
    for (const e of ['joined', 'peer-join', 'peer-leave', 'signal', 'reconnected', 'disconnected', 'error', 'rekey']) {
      sig.on(e, (p) => log.push([e, p]));
    }
    logs.set(sig, log);
    return sig;
  };
  t.after(() => made.forEach((s) => s.close()));
  const host = make('host', { secret, isHost: true, hostId: 'host', peerId: 'host', name: '房主', maxMembers: 8, isLinked: (id) => linked.has(id), ...hostOpts });
  await host.connect();
  const guest = (peerId, extra = {}) => make(peerId, { secret, hostId: 'host', hostKey: host.publicKey, peerId, name: `观众${peerId}`, ...extra });
  const events = (sig, name) => logs.get(sig).filter(([e]) => e === name).map(([, p]) => p);
  return { lib, net, host, guest, linked, events, secret, make };
}

async function until(cond, what, maxMs = 3000) {
  for (let waited = 0; waited < maxMs; waited += 10) {
    if (cond()) return;
    await sleep(10);
  }
  assert.fail(`等不到：${what}`);
}

for (const { name, dir } of IMPLS) {
  test(`${name}：房主自己断网比宽限期和静默阈值都长：成员不被移出、不被封禁；恢复后发 reconnected，宽限期从头算`, async (t) => {
    const r = await room(t, dir);
    const a = r.guest('a');
    await a.connect();
    r.linked.add('a');
    await sleep(80);
    assert.ok(r.host._members.get('a').linkedEver);

    // 房主断网：和 a 的直连也跟着断了
    r.net.cut('host');
    r.linked.delete('a');
    await until(() => r.host.connected === false, '房主发现中继全断');
    await sleep(700); // 远超宽限期（300）和静默阈值（250）
    assert.ok(r.host._members.has('a'), '房主自己断网，却把成员移出了');
    assert.ok(!r.host._isBanned('a', a.publicKey), '房主自己断网，却把成员封禁了');
    assert.deepEqual(r.events(r.host, 'peer-leave'), []);

    r.net.restore('host');
    await until(() => r.events(r.host, 'reconnected').length === 1, '中继恢复后发 reconnected');
    const [ev] = r.events(r.host, 'reconnected');
    assert.deepEqual(ev.peers, [{ peerId: 'a', name: '观众a', initiator: true }], '房主向每个成员发起');
    assert.ok(ev.downMs >= 700);
    // 宽限期从恢复这一刻重新算：马上重连上的不受影响
    await sleep(150);
    assert.ok(r.host._members.has('a'));
    r.linked.add('a');
    await sleep(400);
    assert.ok(r.host._members.has('a'), '恢复后宽限期内重连上的成员被移出了');
    // 暂停不是永久的：恢复之后还是连不上的，照样按宽限期移出
    r.linked.delete('a');
    await until(() => !r.host._members.has('a'), '恢复后一直连不上的照样移出', 2000);
    assert.ok(r.host._isBanned('a', a.publicKey));
  });

  test(`${name}：半开的连接（看着开着、一个字都收不到）自己关掉，按全断处理，恢复后同样发 reconnected`, async (t) => {
    const r = await room(t, dir, { timing: { relayQuiet: 200 } });
    const a = r.guest('a');
    await a.connect();
    r.linked.add('a');
    await sleep(150); // 心跳一来一回，两条中继都回应过我们
    assert.ok([...r.host._sockets.values()].every((s) => s.heard), '中继回过 OK / 推回过自己的事件，应当记为回应过');

    r.net.cut('host', 'silent');
    r.linked.delete('a');
    await until(() => r.host.connected === false, '半开的连接被识别出来');
    await sleep(600);
    assert.ok(r.host._members.has('a'), '半开期间把成员移出了');
    assert.deepEqual(r.events(r.host, 'peer-leave'), []);
    r.net.restore('host');
    await until(() => r.events(r.host, 'reconnected').length === 1, '恢复');
  });

  test(`${name}：系统报网络恢复（online）时不等退避，马上重连中继；关掉之后不再听`, async (t) => {
    const net = new EventTarget();
    const r = await room(t, dir, { host: { netEvents: net } });
    r.host._backoff = () => 60_000; // 退避已经涨到头了
    r.net.cut('host');
    await until(() => r.host.connected === false, '中继全断');
    await sleep(50);
    r.net.restore('host');
    await sleep(100);
    assert.equal(r.host.connected, false, '退避还没到就连上了？');
    net.dispatchEvent(new Event('online'));
    await until(() => r.events(r.host, 'reconnected').length === 1, '网络恢复后马上重连', 1000);
    r.host.close();
    await sleep(30);
    const before = r.net.sockets.size;
    net.dispatchEvent(new Event('online'));
    await sleep(30);
    assert.equal(r.net.sockets.size, before, '关掉之后还在听网络事件');
  });

  test(`${name}：从没回应过的中继（不回 OK、也不推回）不会因为安静被踢`, async (t) => {
    const lib = await import(dir + 'relaySignaling.js');
    const sig = new lib.RelaySignaling({ secret: lib.newRoomSecret(), isHost: true, hostId: 'h', peerId: 'h', relays: RELAYS, timing: { ...FAST, relayQuiet: 50 } });
    const ws = { close() {} };
    sig._sockets.set('wss://quiet', { ws, retry: 0, timer: null, open: true, openedAt: 0, rxAt: 0, heard: false });
    sig.connected = true;
    sig._checkRelays(Date.now());
    assert.equal(sig._sockets.get('wss://quiet').open, true);
    assert.equal(sig.connected, true);
  });

  test(`${name}：成员断网期间被移出（错过了那条 leave）：中继恢复后重新 hello，收到 REMOVED 自己退出`, async (t) => {
    const r = await room(t, dir);
    const a = r.guest('a');
    await a.connect();
    r.linked.add('a');
    await sleep(80);
    r.net.cut('a');
    r.linked.delete('a');
    await until(() => !r.host._members.has('a'), '房主按宽限期移出 a', 2000);
    assert.deepEqual(r.events(a, 'error'), [], '断着网不该收到 leave');
    r.net.restore('a');
    await until(() => r.events(a, 'error').length === 1, 'a 恢复后得知自己被移出');
    assert.equal(r.events(a, 'error')[0].code, 'REMOVED');
    await sleep(30);
    assert.equal(a._closedByUs, true, '被移出的一方要自己关掉');
  });

  test(`${name}：成员断网恢复：发 reconnected（房主那条由房主发起，成员之间按序号），重新 hello 补上断线期间进来的人`, async (t) => {
    const r = await room(t, dir, { grace: 5000 });
    const a = r.guest('a');
    await a.connect();
    const b = r.guest('b');
    await b.connect();
    r.linked.add('a');
    r.linked.add('b');
    await sleep(80);

    r.net.cut('b');
    await until(() => b.connected === false, 'b 发现中继全断');
    // b 断着的时候 c 进房：c 的 welcome b 收不到
    const c = r.guest('c');
    await c.connect();
    await sleep(60);
    assert.ok(!b._bindings.has('c'));
    // b 断的时间比静默阈值长：这期间 b 不该把房主和 a 当成离开
    await sleep(400);
    assert.deepEqual(r.events(b, 'peer-leave'), [], 'b 自己断网，却把别人当成走了');

    r.net.restore('b');
    await until(() => r.events(b, 'reconnected').length === 1, 'b 恢复');
    const peers = r.events(b, 'reconnected')[0].peers;
    const byId = Object.fromEntries(peers.map((p) => [p.peerId, p.initiator]));
    assert.equal(byId.host, false, '和房主那条由房主发起');
    assert.equal(byId.a, false, 'a 比 b 早，由 a 发起');
    await until(() => b._bindings.has('c'), '重新 hello 拿到带名册的 welcome，认识了断线期间进来的 c');
    await until(() => r.events(b, 'peer-join').some((p) => p.peerId === 'c'), 'b 比 c 早，由 b 向 c 发起');
    assert.equal(r.host._members.get('b').seq, 2, 'b 还是原来的序号');
  });

  test(`${name}：成员只是中继断了（直连一直通着）、被房主按静默清掉：回来重新 hello 按原序号放行`, async (t) => {
    const r = await room(t, dir, { grace: 5000 });
    const a = r.guest('a');
    await a.connect();
    const b = r.guest('b');
    await b.connect();
    r.linked.add('a');
    r.linked.add('b');
    const seq = r.host._members.get('b').seq;
    r.net.cut('b');
    await until(() => !r.host._members.has('b'), '房主按静默清掉 b', 2000);
    assert.ok(!r.host._isBanned('b', b.publicKey), '只是静默，不封禁');
    r.net.restore('b');
    await until(() => r.host._members.has('b'), 'b 重新 hello 回来');
    assert.equal(r.host._members.get('b').seq, seq, '回来的人换了序号：老成员之间谁向谁发起就对不上了');
    await until(() => a._bindings.get('b')?.seq === seq, 'a 重新认得 b');
  });

  test(`${name}：房主又有动静之后再静默，成员还会再报一次房主离开`, async (t) => {
    const r = await room(t, dir, { grace: 5000 });
    const a = r.guest('a');
    await a.connect();
    r.linked.add('a');
    r.net.cut('host');
    await until(() => r.events(a, 'peer-leave').some((p) => p.peerId === 'host'), '第一次静默');
    r.net.restore('host');
    await until(() => a._hostGoneSent === false, '房主回来了');
    r.net.cut('host');
    await until(() => r.events(a, 'peer-leave').filter((p) => p.peerId === 'host').length === 2, '第二次静默也要报');
  });

  test(`${name}：初次连上不发 reconnected`, async (t) => {
    const r = await room(t, dir);
    const a = r.guest('a');
    await a.connect();
    await sleep(80);
    assert.deepEqual(r.events(r.host, 'reconnected'), []);
    assert.deepEqual(r.events(a, 'reconnected'), []);
  });

  test(`${name}：中继握手后立刻踢人：退避一直累加，不会每秒重连；连稳过的断了才从头算`, async (t) => {
    const lib = await import(dir + 'relaySignaling.js');
    const net = new FakeNet();
    net.kick.add('wss://flaky');
    const sig = new lib.RelaySignaling({
      secret: lib.newRoomSecret(),
      isHost: true,
      hostId: 'h',
      peerId: 'h',
      relays: ['wss://ok', 'wss://flaky'],
      WebSocketImpl: net.WebSocket('h'),
      timing: { ...FAST, relayStable: 150 },
    });
    const waits = [];
    sig._backoff = (retry) => {
      waits.push(retry);
      return 5;
    };
    t.after(() => sig.close());
    await sig.connect();
    await until(() => (net.opens.get('wss://flaky') || 0) >= 5, '被踢的中继反复重连');
    const flaky = sig._sockets.get('wss://flaky');
    assert.ok(flaky.retry >= 4, `连上就被踢，退避却被清零了（retry=${flaky.retry}）`);
    assert.ok(waits.slice(-3).every((r, i, a) => i === 0 || r > a[i - 1]), `退避没有一路累加：${waits}`);
    // 稳定连着的那条：连住超过 relayStable 再断，退避从头算
    const ok = sig._sockets.get('wss://ok');
    ok.retry = 5;
    await sleep(200);
    ok.ws.close();
    await sleep(20);
    assert.equal(ok.retry, 1, '连稳了的中继断开后退避没从头算');
  });

  test(`${name}：订阅的 since 和新鲜窗口一样宽（600 秒）：时钟比房主慢几分钟的人也收得到；同时带 limit: 0，不要中继回放`, async (t) => {
    const r = await room(t, dir);
    const a = r.guest('a');
    await a.connect();
    assert.ok(r.net.reqs.length >= 4);
    for (const { filter, at } of r.net.reqs) {
      assert.ok(at - filter.since >= 599 && at - filter.since <= 601, `since 只往前放了 ${at - filter.since} 秒`);
      assert.equal(filter.limit, 0, '订阅没带 limit: 0，中继会把存着的约 5 分钟临时事件全回放');
    }
  });

  // E2-A（实测 r7）：批次 3 把 since 放宽到 now − 600 之后，真实中继在 EOSE 之前回放约 5 分钟内的临时事件。
  // 房主中继断着时有人点了链接（HOST_OFFLINE、早已放弃），房主恢复时收到回放的旧 hello 把他放行成待定成员；
  // 他再点链接得 DUP_PEER，60 秒后又被当成「一直没直连」封禁，本次运行再也进不来
  test(`${name}：房主断网时有人点过链接又放弃了：中继恢复后在 EOSE 之前回放那几条旧 hello，房主不放行；那人再来照常进房、不会被封`, async (t) => {
    const net = new FakeNet();
    net.replay.set('wss://a', 'limit'); // strfry：订阅不带 limit:0 才回放
    net.replay.set('wss://b', 'always'); // 不理 limit 的
    const r = await room(t, dir, { net });
    r.net.cut('host');
    await until(() => r.host.connected === false, '房主发现中继全断');
    const late = r.guest('late');
    await assert.rejects(late.connect(), (e) => e.code === 'HOST_OFFLINE');
    late.close();
    const stale = r.net.relay('wss://b').events.filter((ev) => ev.pubkey === late.publicKey);
    assert.ok(stale.length > 0, '断网期间的 hello 没存到中继上，测不出回放');

    r.net.restore('host');
    await until(() => r.events(r.host, 'reconnected').length === 1, '房主恢复');
    await until(() => r.net.replayed.some((x) => x.owner === 'host' && x.ev.pubkey === late.publicKey), '不理 limit 的中继回放了旧 hello');
    await sleep(120);
    assert.ok(!r.net.replayed.some((x) => x.url === 'wss://a'), '订阅带了 limit:0，strfry 那样的中继就不该回放');
    assert.deepEqual(r.events(r.host, 'peer-join'), [], '回放的旧 hello 被放行了');
    assert.equal(r.host._members.size, 0, '早已放弃的人占着待定名额');

    // 他重新点链接：同一个 peerId、新的签名公钥，照常放行（不是 DUP_PEER）
    const again = r.guest('late');
    await again.connect();
    r.linked.add('late');
    await sleep(400); // 超过宽限期（300）
    assert.ok(r.host._members.has('late'));
    assert.ok(!r.host._isBanned('late', again.publicKey), '被回放那一次连累封禁了');
    assert.deepEqual(r.events(again, 'error'), []);
  });

  test(`${name}：成员断网期间别人发给他的 offer：恢复时不理 limit 的中继在 EOSE 之前回放，不交给 app；恢复后实时发来的照常收`, async (t) => {
    const net = new FakeNet();
    for (const url of RELAYS) net.replay.set(url, 'always');
    const r = await room(t, dir, { grace: 5000, net });
    const a = r.guest('a');
    await a.connect();
    r.linked.add('a');
    await sleep(80);
    r.net.cut('a');
    await until(() => a.connected === false, 'a 发现中继全断');
    r.host.signal('a', { kind: 'offer', sdp: { type: 'offer', sdp: 'v=0 old' } });
    await sleep(30);
    r.net.restore('a');
    await until(() => r.events(a, 'reconnected').length === 1, 'a 恢复');
    await until(() => r.net.replayed.some((x) => x.owner === 'a'), '中继向 a 回放了');
    await sleep(60);
    assert.deepEqual(r.events(a, 'signal'), [], '回放的旧 offer 交给了 app：它会拆掉正在重建的连接');
    r.host.signal('a', { kind: 'offer', sdp: { type: 'offer', sdp: 'v=0 new' } });
    await until(() => r.events(a, 'signal').length > 0, 'a 收到恢复之后的 offer');
    await sleep(30);
    assert.deepEqual(r.events(a, 'signal').map((s) => s.payload.sdp.sdp), ['v=0 new']);
  });

  test(`${name}：带 limit:0 时不回 EOSE 的中继：等 eoseWait 之后按实时算，照常放行、照常收信令；只认当前这次订阅的 EOSE`, async (t) => {
    const net = new FakeNet();
    for (const url of RELAYS) net.noEose.add(url);
    const eoseWait = 250;
    // 进房超时放宽：前 eoseWait 里的 hello 都被丢掉，高负载时别卡在默认的 600 毫秒上
    const r = await room(t, dir, { net, grace: 5000, timing: { eoseWait, join: 3000 } });
    const t0 = Date.now(); // 房主刚订阅完
    const a = r.guest('a');
    await a.connect();
    assert.ok(Date.now() - t0 >= eoseWait - 50, `等不到 EOSE 的那段时间里 hello 就被放行了（${Date.now() - t0}ms）`);
    await sleep(eoseWait + 50);
    r.host.signal('a', { kind: 'offer', sdp: { type: 'offer', sdp: 'v=0 x' } });
    await until(() => r.events(a, 'signal').length === 1, 'a 收到 offer');

    // EOSE 只认当前订阅的 id；换话题重新订阅之后要重新等
    const url = RELAYS[0];
    const slot = r.host._sockets.get(url);
    r.host._t.eoseWait = 60_000;
    const before = slot.sub;
    await r.host._moveTo(r.lib.newRoomSecret());
    assert.notEqual(slot.sub, before, '换话题要换一个订阅 id');
    assert.equal(r.host._live(url), false);
    r.host._onRelayMessage(url, JSON.stringify(['EOSE', before]));
    assert.equal(r.host._live(url), false, '上一次订阅迟到的 EOSE 被当成了这一次的');
    r.host._onRelayMessage(url, JSON.stringify(['EOSE', slot.sub]));
    assert.equal(r.host._live(url), true);
  });

  test(`${name}：换链接：连上过、正在重连的成员（还在宽限期里）也拿到新密钥；从没连上过的不给，并报给房主`, async (t) => {
    const r = await room(t, dir, { grace: 5000 });
    const a = r.guest('a');
    await a.connect();
    r.linked.add('a');
    const b = r.guest('b');
    await b.connect();
    r.linked.add('b');
    const p = r.guest('p');
    await p.connect(); // 放行了、一直没连上
    await sleep(80);
    r.linked.delete('b'); // b 正好在重协商
    await sleep(50);
    const next = r.lib.newRoomSecret();
    const res = await r.host.rekey(next);
    await sleep(100);
    assert.equal(a.secret, next);
    assert.equal(b.secret, next, '正在重连的成员被留在了旧话题上');
    assert.notEqual(p.secret, next, '从没连上过的待定名额拿到了新密钥');
    assert.deepEqual(res.left, ['观众p']);
  });

  test(`${name}：换链接：连上过、但断开已经超过宽限期的不给`, async (t) => {
    const r = await room(t, dir, { grace: 5000 });
    const a = r.guest('a');
    await a.connect();
    r.linked.add('a');
    await sleep(80);
    for (const timer of r.host._timers) clearInterval(timer); // 别让定时的移出抢在换链接前面
    r.host._timers = [];
    r.linked.delete('a');
    r.host._refreshLinks();
    r.host._members.get('a').unlinkedSince = Date.now() - 6000;
    const next = r.lib.newRoomSecret();
    const res = await r.host.rekey(next);
    await sleep(100);
    assert.notEqual(a.secret, next);
    assert.deepEqual(res.left, []);
  });
}
