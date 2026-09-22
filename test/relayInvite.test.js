'use strict';

// 房间链接在 app.js 里的接线（0.7.4）：默认邀请方式、连不上中继时退回一对一邀请、
// 观众加入的前置检查和报错、链接编码与长度。中继信令本身见 relaySignaling.test.js。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { IMPLS } = require('./helpers/impls');

const APP = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8').replace(/\r\n/g, '\n');

function fnSource(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层函数 ${name}`);
  const end = APP.indexOf('\n}\n', m.index);
  return APP.slice(m.index, end + 2);
}

function sandbox(names, globals) {
  const ctx = { console, Promise, inviteGen: 0, ...globals };
  vm.createContext(ctx);
  vm.runInContext(names.map(fnSource).join('\n\n'), ctx);
  return ctx;
}

test('房间链接编码：往返不丢字段，链接长度远在 Discord 按钮 URL 的 512 上限内', async () => {
  for (const { name, dir } of IMPLS) {
    const { encodeCode, decodeCode, shareLink } = await import(dir + 'signaling.js');
    const payload = {
      k: 'relay',
      key: 'a'.repeat(43),
      hk: 'f'.repeat(64),
      from: 'Abc-d.EfGhI',
      maxMembers: 16,
      securityMode: 'trusted',
      relays: null,
    };
    const link = shareLink(await encodeCode(payload), 'join');
    assert.ok(link.length < 300, `${name}：房间链接 ${link.length} 字`);
    const got = await decodeCode(link);
    assert.deepEqual(
      { ...got },
      { k: 'relay', key: payload.key, hk: payload.hk, from: payload.from, maxMembers: 16, securityMode: 'trusted', relays: null, protocolVersion: 2 }
    );
    // 房主自己改过中继列表：列表跟着链接走，长度仍在上限内
    const custom = await decodeCode(shareLink(await encodeCode({ ...payload, relays: ['wss://a.example', 'wss://b.example'] }), 'join'));
    assert.deepEqual(custom.relays, ['wss://a.example', 'wss://b.example']);
  }
});

test('默认邀请方式是房间链接；一对一和信令服务器都还在', () => {
  const body = fnSource('renderInvite');
  assert.match(body, /inviteViaRelay\(\)\.catch\(/);
  assert.doesNotMatch(body, /\n  inviteViaManual\(\)\.catch\(/, '默认还在生成一对一邀请');
  assert.match(body, /\$\('inv-relay'\)\.onclick = \(\) => inviteViaRelay\(\);/);
  assert.match(body, /\$\('inv-manual'\)\.onclick = \(\) => inviteViaManual\(\);/);
  assert.match(body, /\$\('inv-server'\)\.onclick = inviteViaServer;/);
});

function relayHost({ connectFails = null } = {}) {
  const calls = [];
  const logs = [];
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, value: '', onclick: null, textContent: '' });
    return els.get(id);
  };
  const S = { signaling: null, signalTransport: null, mode: null, peerId: 'host1', roomCapacity: 6, roomSecurityMode: 'trusted', settings: { relays: '' } };
  const ctx = sandbox(['inviteViaRelay', 'renderRelayInvite', 'customRelays', 'setFinalInviteStep'], {
    S,
    $: el,
    make: (tag, o = {}, kids = []) => ({ tag, ...o, kids }),
    replace: (target, ...nodes) => calls.push(['replace', nodes.flat().map((n) => n?.text || n?.id || '').join('|')]),
    inviteStep: (no, title, hint, controls) => ({ text: title, controls }),
    log: (text, kind) => logs.push([text, kind]),
    copyCode: () => {},
    updatePresence: () => calls.push(['presence']),
    newRoomSecret: () => 'SECRET',
    encodeCode: async (p) => {
      calls.push(['encode', p]);
      return 'NR3-Rcode';
    },
    shareLink: (code) => `https://felis-desuwa.github.io/NoxReel/#j/${code.slice(4)}/`,
    connectSignaling: async (url, room, relay) => {
      calls.push(['connect', url, room, relay]);
      if (connectFails) throw Object.assign(new Error(connectFails), { code: 'RELAY_UNREACHABLE' });
      S.signaling = { secret: relay.secret, publicKey: 'b'.repeat(64), close: () => calls.push(['close']) };
      S.signalTransport = 'relay';
    },
    inviteViaManual: async (notice) => calls.push(['manual', notice]),
  });
  return { ctx, S, calls, logs, el };
}

test('房主开房间链接：连上中继后挂出 https 链接，内容是房间密钥和房主签名公钥', async () => {
  const r = relayHost();
  await r.ctx.inviteViaRelay();
  const connect = r.calls.find((c) => c[0] === 'connect');
  // 沙箱里造出来的对象跨 realm，按 JSON 比
  assert.equal(JSON.stringify(connect.slice(1)), JSON.stringify([null, null, { secret: 'SECRET', isHost: true, hostId: 'host1' }]));
  const encoded = r.calls.find((c) => c[0] === 'encode')[1];
  assert.deepEqual(
    { ...encoded },
    { k: 'relay', key: 'SECRET', hk: 'b'.repeat(64), from: 'host1', maxMembers: 6, securityMode: 'trusted', relays: null }
  );
  assert.equal(r.S.mode, 'server', 'S.mode 必须是 server：好几处判断靠它区分「极简」和「有信令」');
  assert.equal(r.S.roomLink, 'https://felis-desuwa.github.io/NoxReel/#j/Rcode/');
  assert.equal(r.el('inv-code').value, r.S.roomLink);
  assert.ok(r.calls.some((c) => c[0] === 'presence'), '挂出链接后 Discord 状态要跟着更新');
});

test('连不上任何中继：退回一对一邀请，并说明原因', async () => {
  const r = relayHost({ connectFails: '连不上任何公共中继' });
  await r.ctx.inviteViaRelay();
  const manual = r.calls.find((c) => c[0] === 'manual');
  assert.ok(manual, '没有退回一对一邀请');
  assert.equal(manual[1], '连不上公共中继（连不上任何公共中继），先用一对一邀请：一条链接只给一个人。');
  assert.equal(r.S.signaling, null);
  assert.equal(r.S.signalTransport, null);
  assert.deepEqual(r.logs, [['连不上公共中继（连不上任何公共中继），改用一对一邀请', 'warn']]);
});

test('从房间链接切到信令服务器：先关掉中继那条，不拿空房间号编码', () => {
  const body = fnSource('inviteViaServer');
  assert.match(body, /if \(S\.signaling && S\.signalTransport !== 'ws'\) \{\s*S\.signaling\.close\(\);\s*S\.signaling = null;\s*\}/);
});

test('connectSignaling：传了 relay 就建 RelaySignaling，带上协议版本、满员判定和中继列表', async () => {
  const made = [];
  class FakeRelay {
    constructor(o) {
      made.push(['relay', o]);
      this.o = o;
    }
    on() {}
    close() {}
    connect() {
      return Promise.resolve({ hostId: 'host1', maxMembers: 4 });
    }
  }
  class FakeWs extends FakeRelay {
    constructor(o) {
      super(o);
      made[made.length - 1][0] = 'ws';
    }
  }
  const S = { role: 'guest', roomCapacity: 4, peerId: 'me', name: '我', hostId: 'host1', settings: { relays: '' } };
  const ctx = sandbox(['connectSignaling', 'customRelays', 'relayList'], {
    S,
    RelaySignaling: FakeRelay,
    WsSignaling: FakeWs,
    DEFAULT_RELAYS: ['wss://default'],
    PROTOCOL_VERSION: 2,
    connectedPeerCount: () => 2,
    renderCapacityStatus: () => {},
    clampCapacity: (n) => n,
    log: () => {},
  });
  await ctx.connectSignaling(null, null, { secret: 'K', hostKey: 'h'.repeat(64), hostId: 'host1', relays: null });
  assert.equal(S.signalTransport, 'relay');
  const [kind, o] = made[0];
  assert.equal(kind, 'relay');
  assert.equal(o.hostId, 'host1');
  assert.equal(o.protocolVersion, 2);
  assert.deepEqual([...o.relays], ['wss://default']);
  assert.equal(o.occupied(), 3, '满员判定要算上一对一进来的人和自己');
  await ctx.connectSignaling('ws://x', 'room1');
  assert.equal(made[1][0], 'ws');
  assert.equal(S.signalTransport, 'ws');
});

test('三处建连都按信令的 trickle 走：中继不 trickle，信令服务器照旧', () => {
  assert.equal((APP.match(/trickle: sig\.trickle !== false/g) || []).length, 3);
  assert.doesNotMatch(APP, /trickle: true/);
});

function relayGuest({ fail = null, settingsMode = 'trusted' } = {}) {
  const calls = [];
  const errs = {};
  const el = (id) => {
    errs[id] ||= { textContent: '', style: {} };
    return errs[id];
  };
  const S = { settings: { securityMode: settingsMode, relays: '' }, roomCapacity: 4 };
  const ctx = sandbox(['joinViaRelay', 'relayJoinError', 'refreshRoomLink'], {
    S,
    $: el,
    PROTOCOL_VERSION: 2,
    normalizeSecurityMode: (m) => (m === 'trusted' ? 'trusted' : 'safe'),
    securityModeLabel: (m) => (m === 'trusted' ? '可信房间' : '安全模式'),
    inviteVersionText: () => '版本不对',
    clampCapacity: (n) => n,
    show: () => {},
    setSteps: () => {},
    initSwarmAndSync: () => calls.push(['init']),
    // 加入的代次（换代、重复点开的去重）另见 appHardening.test.js，这里只看一次加入本身
    inviteKey: () => 'relay-key',
    joiningWith: () => false,
    beginAttempt: () => 1,
    attemptLive: () => true,
    replace: () => {},
    cancelJoinButton: () => null,
    updatePresence: () => calls.push(['presence']),
    encodeCode: async () => 'NR3-Rlink',
    shareLink: (code) => `https://felis-desuwa.github.io/NoxReel/#j/${code.slice(4)}/`,
    connectSignaling: async (url, room, relay) => {
      calls.push(['connect', relay]);
      if (fail) throw Object.assign(new Error(fail.message), { code: fail.code });
    },
    prepFail: (msg) => calls.push(['fail', msg]),
  });
  return { ctx, S, calls, errs };
}

const LINK = { k: 'relay', key: 'K'.repeat(43), hk: 'a'.repeat(64), from: 'host1', maxMembers: 5, securityMode: 'trusted', relays: null, protocolVersion: 2 };

test('观众用房间链接加入：房主身份取自链接，成功后记下同一条链接', async () => {
  const r = relayGuest();
  await r.ctx.joinViaRelay(LINK);
  const connect = r.calls.find((c) => c[0] === 'connect')[1];
  assert.deepEqual({ ...connect }, { secret: LINK.key, hostKey: LINK.hk, hostId: 'host1', relays: null });
  assert.equal(r.S.hostId, 'host1');
  assert.equal(r.S.mode, 'server');
  assert.equal(r.S.role, 'guest');
  assert.equal(r.S.roomCapacity, 5);
  assert.equal(r.S.roomLink, 'https://felis-desuwa.github.io/NoxReel/#j/Rlink/');
});

test('观众加入：模式不一致、链接残缺时当场说，不去连中继', async () => {
  const mismatch = relayGuest({ settingsMode: 'safe' });
  await mismatch.ctx.joinViaRelay(LINK);
  assert.match(mismatch.errs['join-err'].textContent, /^房间使用可信房间，你的本机设置是安全模式/);
  assert.ok(!mismatch.calls.some((c) => c[0] === 'connect'));

  const broken = relayGuest();
  await broken.ctx.joinViaRelay({ ...LINK, hk: 'nothex' });
  assert.equal(broken.errs['join-err'].textContent, '这个房间链接不完整，请让房主重新复制一次。');
  assert.ok(!broken.calls.some((c) => c[0] === 'connect'));
});

test('观众加入失败：按原因说人话', async () => {
  const cases = [
    [{ code: 'HOST_OFFLINE', message: 'x' }, '找不到房主：他可能已经离开房间，或者换过房间链接。请让房主重新发一条。'],
    [{ code: 'RELAY_UNREACHABLE', message: 'x' }, '连不上公共中继（所在网络可能拦了它们）。请让房主改发「一对一邀请」，那个不经过任何第三方。'],
    [{ code: 'ROOM_FULL', message: '房间已满（上限 4 人）' }, '房间已满（上限 4 人）'],
  ];
  for (const [fail, want] of cases) {
    const r = relayGuest({ fail });
    await r.ctx.joinViaRelay(LINK);
    assert.deepEqual(r.calls.find((c) => c[0] === 'fail'), ['fail', want]);
  }
});

test('粘贴或点开房间链接会走 joinViaRelay；诊断里认得出这种连接方式', () => {
  assert.match(fnSource('handleJoinInput'), /if \(payload\.k === 'relay'\) return joinViaRelay\(payload\);/);
  const ctx = sandbox(['connectionModeLabel'], { S: { mode: 'server', signalTransport: 'relay' } });
  assert.equal(ctx.connectionModeLabel(), '房间链接（公共中继）');
  ctx.S.signalTransport = 'ws';
  assert.equal(ctx.connectionModeLabel(), '信令服务器');
  ctx.S.mode = 'manual';
  assert.equal(ctx.connectionModeLabel(), '极简（零服务器）');
});

test('安卓端拿到房间链接：说清楚手机端下个版本支持，不报「不是邀请码」', async () => {
  const android = fs.readFileSync(path.join(__dirname, '../android/app/src/main/assets/js/app-android.js'), 'utf8');
  assert.match(android, /if \(payload\.k === 'relay'\) \{\s*log\('这是房间链接，目前只有电脑端 NoxReel 能用/);
  const i18n = fs.readFileSync(path.join(__dirname, '../android/app/src/main/assets/js/i18n.js'), 'utf8');
  assert.ok(i18n.includes("'这是房间链接，目前只有电脑端 NoxReel 能用，手机端下个版本支持。请让房主给你发一条「一对一邀请」。'"));
});

test('新文案都有英文', async () => {
  const { translate } = await import('../src/renderer/lib/i18n.js');
  const en = (s) => translate(s, 'en');
  assert.equal(en('房间已满（上限 4 人）'), 'The room is full (limit 4)');
  assert.match(en('连不上公共中继（连不上任何公共中继），先用一对一邀请：一条链接只给一个人。'), /^Could not reach public relays \(Could not reach any public relay\)/);
  for (const line of [
    '正在连接公共中继…', '复制房间链接，发到群里', '谁点开都能进，直到坐满人数上限；你离开房间后链接就失效了。', '复制房间链接',
    '经公共中继交换连接信息（加密），视频仍在你们之间直传。中继能看到连接者的 IP，看不到内容和片名。',
    '换一条链接（旧的作废）', '房间链接（谁点谁进）', '一对一邀请（不经过第三方）', '这个房间链接不完整，请让房主重新复制一次。',
    '正在通过公共中继找房主', '解析房间链接', '等房主放行', '房主已放行，正在和房间里的人打洞…',
    '找不到房主：他可能已经离开房间，或者换过房间链接。请让房主重新发一条。',
    '连不上公共中继（所在网络可能拦了它们）。请让房主改发「一对一邀请」，那个不经过任何第三方。',
    '房主不在线，或者这个房间链接已经失效', '房间链接（公共中继）', '公共中继（房间链接用）',
  ]) {
    assert.notEqual(en(line), line, line);
  }
});

// 进房后邀请卡默认先连公共中继（一两秒）。这期间房主点了「一对一」或「信令服务器」：
// 晚到的中继结果不许盖掉新的邀请卡，中继失败时也不许去关人家新建的连接（0.7.5 端到端测出来的竞态）。
function inviteRace() {
  const calls = [];
  const pend = [];
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, value: '', onclick: null, textContent: '' });
    return els.get(id);
  };
  const S = {
    signaling: null, signalTransport: null, mode: null, peerId: 'host1', name: '房主', roomCapacity: 6,
    roomSecurityMode: 'safe', settings: { relays: '', signalUrl: 'ws://sig.example:8080' },
  };
  const ctx = sandbox(['inviteViaRelay', 'renderRelayInvite', 'inviteViaServer', 'customRelays', 'setFinalInviteStep'], {
    S,
    $: el,
    make: (tag, o = {}, kids = []) => ({ tag, ...o, kids, style: {} }),
    replace: (target, ...nodes) => calls.push(['replace', nodes.flat().map((n) => n?.text || n?.id || '').join('|')]),
    inviteStep: (no, title, hint, controls) => ({ text: title, controls }),
    log: (text, kind) => calls.push(['log', text, kind]),
    copyCode: () => {},
    updatePresence: () => {},
    newRoomSecret: () => 'SECRET',
    randomRoomId: () => 'ROOM1',
    inviteMediaInfo: () => null,
    encodeCode: async (p) => {
      calls.push(['encode', p.k]);
      return 'NR3-Xcode';
    },
    shareLink: (code) => `https://felis-desuwa.github.io/NoxReel/#j/${code.slice(4)}/`,
    // 和真的一样：第一个 await 之前就把新连接挂上 S.signaling，并关掉手上那条
    connectSignaling: (url, room, relay) => {
      let resolve;
      let reject;
      const promise = new Promise((a, b) => ((resolve = a), (reject = b)));
      const sig = {
        transport: relay ? 'relay' : 'ws',
        closed: false,
        secret: relay?.secret,
        publicKey: 'b'.repeat(64),
        close() {
          this.closed = true;
          reject(Object.assign(new Error('连不上任何公共中继'), { code: 'RELAY_UNREACHABLE' }));
        },
      };
      const previous = S.signaling;
      S.signaling = sig;
      S.signalTransport = sig.transport;
      if (previous && previous !== sig) previous.close();
      pend.push({ sig, resolve });
      return promise;
    },
    // 真的 inviteViaManual 开头会领一个新代次、把 S.mode 改成 manual
    inviteViaManual: async (notice = '') => {
      ctx.inviteGen++;
      S.mode = 'manual';
      calls.push(['manual', notice]);
    },
  });
  return { ctx, S, calls, pend };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

test('连中继那几秒里改点「一对一」：晚到的房间链接不盖掉一对一邀请', async () => {
  const r = inviteRace();
  const relayRun = r.ctx.inviteViaRelay();
  await r.ctx.inviteViaManual(); // 房主手快，中继还没连上就点了「一对一邀请」
  r.pend[0].resolve({ hostId: 'host1' }); // 中继这时才连上
  await relayRun;
  await settle();
  assert.equal(r.S.mode, 'manual', '房间链接晚到后把 S.mode 改回了 server');
  assert.ok(!r.calls.some((c) => c[0] === 'encode'), '晚到的中继结果还是编出了房间链接、盖掉了邀请卡');
  assert.equal(r.calls.filter((c) => c[0] === 'manual').length, 1, '不该再退回一次一对一');
});

test('连中继那几秒里改点「信令服务器」：中继那条失败时不去关新建的信令连接', async () => {
  const r = inviteRace();
  const relayRun = r.ctx.inviteViaRelay();
  const serverRun = r.ctx.inviteViaServer(); // 这一步会关掉中继那条，它的 connect 随即失败
  const ws = r.pend[1].sig;
  await relayRun;
  r.pend[1].resolve({ hostId: 'host1' });
  await serverRun;
  await settle();
  assert.equal(ws.closed, false, '中继失败的收尾把信令服务器那条新连接关掉了');
  assert.equal(r.S.signaling, ws);
  assert.equal(r.S.signalTransport, 'ws');
  assert.ok(!r.calls.some((c) => c[0] === 'manual'), '中继失败后还退回了一对一，盖掉了信令邀请码');
  assert.deepEqual(r.calls.filter((c) => c[0] === 'encode').map((c) => c[1]), ['room']);
});
