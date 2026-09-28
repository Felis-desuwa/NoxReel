'use strict';

// 修复 H1（第三轮实测发现的加入流程与提示）里安卓端和两端共用文案的那一半：
//  - N1：一对一加入时 ICE 真的失败了。Swarm 的 forgetSelf 比加入方的收尾先挂在 failed 上，收尾时这条连接
//    已经不在成员表里 —— 以前按「不在表里」早退，手机上永远没有结论（电脑端的同一处见 joinCancel.test.js）；
//  - N3：一对一邀请里没带昵称时，给房主的兜底名按界面语言取，不在英文日志里夹一句中文。
// 电脑端的 N1 / N8 在 joinCancel.test.js，N2 在 g3Misc.test.js，N6 在 relaySelfHealApp.test.js。
// 照 relaySelfHealApp 的做法把 app-android.js 的顶层函数原样抠进 vm 沙箱。全程不联网、不出声。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const ANDROID = read('android/app/src/main/assets/js/app-android.js');
const CJK = /[一-鿿]/;

function fnSource(src, name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(src);
  assert.ok(m, `没找到顶层函数 ${name}`);
  const end = src.indexOf('\n}\n', m.index);
  assert.ok(end > m.index, `${name} 的结尾没找到`);
  return src.slice(m.index, end + 2);
}

function declSource(src, name) {
  const m = new RegExp(`^(?:const|let) ${name} = ([^\\n;]*);`, 'm').exec(src);
  assert.ok(m, `没找到顶层声明 ${name}`);
  return `var ${name} = ${m[1]};`;
}

let clampName = null;
let Emitter = null;
test.before(async () => {
  ({ clampName } = await load('src/renderer/lib/chat.js'));
  ({ Emitter } = await load('src/renderer/lib/emitter.js'));
});

function fakeClock() {
  let now = 0;
  let seq = 0;
  const queue = new Map();
  return {
    setTimeout: (fn, ms = 0) => {
      seq += 1;
      queue.set(seq, { fn, at: now + ms });
      return seq;
    },
    clearTimeout: (h) => queue.delete(h),
    get pending() {
      return queue.size;
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [h, t] of queue) if (t.at <= end && (!next || t.at < next[1].at)) next = [h, t];
        if (!next) break;
        queue.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((a) => {
    resolve = a;
  });
  return { promise, resolve };
}

/**
 * 手机上的一对一加入（joinManualNow）。假 Swarm、假 Peer 照真的来：addPeer 时先把 forgetSelf 挂在
 * close / failed 上（早于 joinManualNow 挂的那条），摘掉时 close() 报一次 close 再清掉监听。
 */
async function androidManualJoin({ locale = 'zh-CN' } = {}) {
  const { translate } = await load('android/app/src/main/assets/js/i18n.js');
  const clock = fakeClock();
  const logs = [];
  const resets = [];
  const peers = [];
  const offer = deferred();
  class FakePeer extends Emitter {
    constructor(o) {
      super();
      Object.assign(this, o);
      this.closed = false;
      this.authenticated = false;
      peers.push(this);
    }
    acceptOffer() {
      return offer.promise;
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.emit('close');
      this.removeAll();
    }
  }
  class FakeSwarm extends Emitter {
    constructor() {
      super();
      this.peers = new Map();
    }
    addPeer(peer) {
      this.peers.set(peer.peerId, peer);
      const forgetSelf = () => {
        if (this.peers.get(peer.peerId) === peer) this.removePeer(peer.peerId);
      };
      peer.on('close', forgetSelf);
      peer.on('failed', forgetSelf);
    }
    removePeer(id) {
      const p = this.peers.get(id);
      if (!p) return;
      this.peers.delete(id);
      p.close();
    }
  }
  const els = new Map();
  const S = { peerId: 'me-peer', name: '我', securityMode: 'trusted', swarm: null, entered: false, manualAttempt: null, hostId: null };
  const ctx = {
    console,
    clampName,
    S,
    Peer: FakePeer,
    t: (text) => translate(text, locale),
    inviteUsable: () => true,
    turnFetchNeeded: () => false,
    ensureTurnReady: async () => {},
    relayBlockedStop: () => false,
    initSwarmAndSync: () => {
      if (!S.swarm) S.swarm = new FakeSwarm();
    },
    peerIce: () => ({ iceServers: [], iceTransportPolicy: 'all' }),
    wirePeer: () => {},
    log: (text, tone) => logs.push([text, tone]),
    // 真的 resetAttempt 拆 Swarm、收起应答链接；这里只记一笔，并像它一样收掉挂着的那一轮
    resetAttempt: () => {
      resets.push(true);
      S.manualAttempt?.cancel();
      S.manualAttempt = null;
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    encodeCode: async () => 'NR2-answer',
    adviseLocalCandidates: () => {},
    inviteLink: (code) => `https://example.test/#a/${code}/`,
    $: (id) => {
      if (!els.has(id)) els.set(id, { id, value: '', textContent: '', style: {} });
      return els.get(id);
    },
    show: () => {},
    fmtBytes: (n) => `${n} B`,
  };
  vm.createContext(ctx);
  vm.runInContext(
    [declSource(ANDROID, 'MANUAL_JOIN_WAIT_TIMEOUT_MS'), fnSource(ANDROID, 'peerName'), fnSource(ANDROID, 'joinManualNow')].join('\n\n'),
    ctx
  );
  return { ctx, S, clock, logs, resets, peers, offer };
}

const OFFER = { k: 'offer', from: 'host-A', name: '阿明', sdp: { type: 'offer', sdp: 'v=0' }, securityMode: 'trusted', protocolVersion: 2 };

async function answered(w, payload = OFFER) {
  const joining = w.ctx.joinManualNow(payload);
  w.offer.resolve({ type: 'answer', sdp: 'a' });
  await joining;
  assert.ok(w.logs.some(([t]) => t === '应答链接已生成，发回给房主后对方点开即可'));
}

test('安卓 N1：应答链接发出去之后 ICE 真的失败了（swarm 先摘掉这条连接）：说清楚、这一轮拆掉', async () => {
  const w = await androidManualJoin();
  await answered(w);
  w.peers[0].emit('failed', 'failed');
  assert.equal(w.S.swarm.peers.has('host-A'), false, '这个用例要的就是「先被摘掉、再轮到加入方收尾」');
  assert.deepEqual(w.logs.at(-1), [
    '和房主的直连没建立起来。重新粘一次房主的邀请码生成新的应答链接；双方都在严格 NAT 后面时需要各自配同一个 TURN 中继。',
    'bad',
  ]);
  assert.equal(w.resets.length, 1, '这一轮没拆：应答链接还挂着，安全模式下拉框也还是灰的');
  assert.equal(w.clock.pending, 0, '三分钟兜底要撤掉');
});

test('安卓 N1：连接早就被摘掉了（只关了、没报 failed），三分钟兜底照样说清楚', async () => {
  const w = await androidManualJoin();
  await answered(w);
  w.peers[0].close();
  assert.equal(w.resets.length, 0);
  w.clock.advance(180_000);
  assert.match(w.logs.at(-1)[0], /^等了几分钟还是没连上房主/);
  assert.equal(w.resets.length, 1);
});

test('安卓 N1：这个房主 id 已经换成了别的连接，旧连接的收尾什么都不动', async () => {
  const w = await androidManualJoin();
  await answered(w);
  const count = w.logs.length;
  w.S.swarm.peers.set('host-A', { peerId: 'host-A', close() {} });
  w.peers[0].emit('failed', 'failed');
  assert.equal(w.logs.length, count);
  assert.equal(w.resets.length, 0);
});

test('N3：一对一邀请没带昵称时，给房主的兜底名按界面语言取（英文日志里不夹中文）；带了就照样清洗截断', async () => {
  const en = await androidManualJoin({ locale: 'en' });
  await answered(en, { ...OFFER, name: '' });
  assert.equal(en.peers[0].name, 'Host');
  const zh = await androidManualJoin();
  await answered(zh, { ...OFFER, name: undefined });
  assert.equal(zh.peers[0].name, '房主');
  const long = await androidManualJoin();
  await answered(long, { ...OFFER, name: 'x'.repeat(500) });
  assert.ok(long.peers[0].name.length <= 40, '邀请码里的昵称没截断');

  // 兜底名进了日志模板，整行英文不夹中文（两端）
  for (const file of ['src/renderer/lib/i18n.js', 'android/app/src/main/assets/js/i18n.js']) {
    const { translate } = await load(file);
    const host = translate('房主', 'en');
    assert.equal(host, 'Host', file);
    assert.doesNotMatch(translate(`和 ${host} 的直连失败了。之前是连通的，多半是对方断网或关掉了 NoxReel，正在等他回来。`, 'en'), CJK, file);
  }
  // 电脑端还记「X 断开了」；房主一侧给观众的兜底名也一样按语言取
  const { translate } = await load('src/renderer/lib/i18n.js');
  assert.equal(translate('Host 断开了', 'en'), 'Host disconnected');
  assert.equal(translate('观众', 'en'), 'Viewer');
});
