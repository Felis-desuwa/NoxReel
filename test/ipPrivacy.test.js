'use strict';

/**
 * IP 隐私三件套（0.7.6）在渲染进程这一侧：
 *
 *  二、「隐藏我的 IP」：只走中继（iceTransportPolicy = 'relay'、不带 STUN）；没有可用 TURN 时
 *      一对一邀请、加入、房间链接、信令开房 / 加入都不建连接，绝不悄悄退回直连。
 *  三、Cloudflare TURN：临时账号合进 iceServers、53 端口过滤、建连接前补齐（await 之后照查代次）、
 *      本机月用量计量（getStats 增量）和到上限后的停用。
 *
 * 共享库（ice.js / peer.js）桌面端和安卓端各跑一遍；app.js 照 appHardening 的做法把顶层函数
 * 原样抠进 vm 沙箱。全程不联网、不起播放器、不出声。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { IMPLS } = require('./helpers/impls');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('src/renderer/app.js');
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

function fnSource(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层函数 ${name}`);
  const end = APP.indexOf('\n}\n', m.index);
  return APP.slice(m.index, end + 2);
}

function declSource(name) {
  const single = new RegExp(`^(?:const|let) ${name} = [^\\n]*;$`, 'm').exec(APP);
  if (single) return single[0];
  // 多行的对象常量：从声明行到顶格的 `};`
  const m = new RegExp(`^const ${name} = \\{$`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层声明 ${name}`);
  return APP.slice(m.index, APP.indexOf('\n};\n', m.index) + 3);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};

const HOUR = 60 * 60 * 1000;
const MANUAL_TURN = { turnEnabled: true, turnUrl: 'turn:relay.example:3478', turnUser: 'u', turnPass: 'p' };
const CF_URLS = ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'];
const cfTurn = (expiresAt = Date.now() + 20 * HOUR) => ({ urls: [...CF_URLS], username: 'cf-user', credential: 'cf-pass', expiresAt });

/* ============================== ice.js：只走中继 ============================== */

impl('只走中继：iceTransportPolicy 是 relay，iceServers 只有那条中继，一条 STUN 都不带', async (dir) => {
  const { peerIceConfig, buildIceServers } = await import(dir + 'ice.js');
  const config = peerIceConfig({ stun: 'stun:stun.l.google.com:19302', relayOnly: true, ...MANUAL_TURN });
  assert.equal(config.iceTransportPolicy, 'relay');
  assert.equal(config.iceServers.length, 1);
  assert.deepEqual(config.iceServers[0].urls, ['turn:relay.example:3478?transport=udp', 'turn:relay.example:3478?transport=tcp']);
  assert.ok(!JSON.stringify(config).includes('stun:'), '只走中继还带着 STUN');
  assert.ok(!JSON.stringify(buildIceServers({ relayOnly: true, ...MANUAL_TURN })).includes('stun:'));
  // 没开的时候照旧：STUN + 中继，策略 all
  const normal = peerIceConfig({ stun: 'stun:stun.l.google.com:19302', ...MANUAL_TURN });
  assert.equal(normal.iceTransportPolicy, 'all');
  assert.ok(normal.iceServers[0].urls.includes('stun:stun.l.google.com:19302'));
  assert.equal(normal.iceServers.length, 2);
});

impl('只走中继却没有可用的 TURN：返回 null（调用方必须停下），不退回直连', async (dir) => {
  const { peerIceConfig } = await import(dir + 'ice.js');
  const now = Date.now();
  const none = [
    { relayOnly: true },
    { relayOnly: true, turnEnabled: false, turnUrl: 'turn:relay.example:3478', turnUser: 'u', turnPass: 'p' },
    { relayOnly: true, turnEnabled: true, turnUrl: 'turn:relay.example:3478', turnUser: 'u', turnPass: '' },
    { relayOnly: true, turnEnabled: true, turnUrl: 'turn:relay.example:53', turnUser: 'u', turnPass: 'p' },
    { relayOnly: true, turnSource: 'cloudflare', cfTurn: null, ...MANUAL_TURN },
    { relayOnly: true, turnSource: 'cloudflare', cfTurn: cfTurn(now - 1), now },
    { relayOnly: true, turnSource: 'cloudflare', cfTurn: { ...cfTurn(), urls: ['turn:turn.cloudflare.com:53'] } },
  ];
  for (const opts of none) assert.equal(peerIceConfig(opts), null, JSON.stringify(opts));
});

impl('Cloudflare 来源：用临时账号组 TURN 项，手动那套字段（连同启用开关）一概不看，53 端口去掉', async (dir) => {
  const { peerIceConfig, buildIceServers, relayServer, turnMissingCredentials } = await import(dir + 'ice.js');
  const now = Date.now();
  const relay = relayServer({ turnSource: 'cloudflare', cfTurn: cfTurn(now + HOUR), now, turnEnabled: false });
  assert.deepEqual(relay, {
    urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
    username: 'cf-user',
    credential: 'cf-pass',
  });
  const list = buildIceServers({ turnSource: 'cloudflare', cfTurn: cfTurn(), ...MANUAL_TURN });
  assert.equal(list.length, 2);
  assert.ok(!JSON.stringify(list).includes('relay.example'), '来源是 Cloudflare 时还带着手填的中继');
  assert.equal(peerIceConfig({ relayOnly: true, turnSource: 'cloudflare', cfTurn: cfTurn() }).iceServers[0].username, 'cf-user');
  // 过期的临时账号不交出去；没开只走中继时就只剩 STUN（照常直连，TURN 本来就是兜底）
  const expired = buildIceServers({ turnSource: 'cloudflare', cfTurn: cfTurn(now - 1), now });
  assert.equal(expired.length, 1);
  // 手动字段缺密码的老配置，来源换成 Cloudflare 之后不再报「缺密码」
  assert.equal(turnMissingCredentials({ turnSource: 'cloudflare', turnEnabled: true, turnUrl: 'turn:x:3478' }), false);
  assert.equal(turnMissingCredentials({ turnEnabled: true, turnUrl: 'turn:x:3478' }), true);
});

impl('端口 53 的 TURN 一律过滤（浏览器会拦，候选收集要干等到超时）；设置里单独报出来', async (dir) => {
  const { expandTurnUrls, turnUrlPort, isBlockedTurnUrl, normalizeTurnInput, buildIceServers } = await import(dir + 'ice.js');
  assert.deepEqual(expandTurnUrls('turn:a.example:53'), []);
  assert.deepEqual(expandTurnUrls('turn:a.example:53?transport=tcp turns:a.example:53'), []);
  assert.deepEqual(expandTurnUrls(['turn:a.example:53?transport=udp', 'turn:a.example:3478?transport=udp']), ['turn:a.example:3478?transport=udp']);
  assert.deepEqual(expandTurnUrls('turn:a.example:5353'), ['turn:a.example:5353?transport=udp', 'turn:a.example:5353?transport=tcp'], '5353 不是 53');
  assert.equal(turnUrlPort('turn:a.example'), 3478);
  assert.equal(turnUrlPort('turns:a.example'), 5349);
  assert.equal(turnUrlPort('turn:[2001:db8::1]:53?transport=udp'), 53);
  assert.equal(turnUrlPort('turn:[2001:db8::1]'), 3478);
  assert.equal(turnUrlPort('stun:a.example:53'), null);
  assert.equal(isBlockedTurnUrl('TURN:A.example:53'), true);
  const check = normalizeTurnInput('turn:a.example:53 b.example:53 turn:c.example:3478');
  assert.deepEqual(check.blocked, ['turn:a.example:53', 'b.example:53']);
  assert.deepEqual(check.urls, ['turn:c.example:3478']);
  assert.equal(buildIceServers({ turnEnabled: true, turnUrl: 'turn:a.example:53', turnUser: 'u', turnPass: 'p' }).length, 1);
});

impl('诊断：只走中继时一条中继候选都没有 → 专门说 TURN 的问题，不往防火墙 / STUN 上指', async (dir) => {
  const { diagnoseCandidates, adviseConnection, summarizeCandidates } = await import(dir + 'ice.js');
  const empty = diagnoseCandidates(summarizeCandidates(''), { relayOnly: true });
  assert.equal(empty.level, 'bad');
  assert.match(empty.text, /隐藏我的 IP/);
  assert.match(empty.text, /中继候选/);
  assert.match(empty.text, /用户名密码|过期/);
  assert.doesNotMatch(empty.text, /防火墙拦掉|STUN 服务器没能/);
  // 不开只走中继时，同样的空统计还是原来那句
  assert.match(diagnoseCandidates(summarizeCandidates('')).text, /防火墙/);
  const relayed = diagnoseCandidates(summarizeCandidates('a=candidate:1 1 udp 100 198.51.100.7 5000 typ relay raddr 0.0.0.0 rport 0'), { relayOnly: true });
  assert.equal(relayed.level, 'ok');
  assert.match(relayed.text, /只能看到 TURN 服务器的地址/);
  // 总入口把 relayOnly 传下去；服务器亲口说的错误照旧优先
  assert.match(adviseConnection({ stats: summarizeCandidates(''), relayOnly: true }).text, /隐藏我的 IP/);
  assert.match(
    adviseConnection({ stats: summarizeCandidates(''), relayOnly: true, candidateErrors: [{ url: 'turn:r.example:3478', errorCode: 401 }] }).text,
    /拒绝了用户名或密码/
  );
});

/* ============================== peer.js ============================== */

impl('Peer 把 iceTransportPolicy 交给 RTCPeerConnection；默认 all，别的值一律当 all', async (dir) => {
  const configs = [];
  globalThis.RTCPeerConnection = class {
    constructor(config) {
      configs.push(config);
      this.iceGatheringState = 'complete';
    }
    createDataChannel(label) {
      return { label, readyState: 'connecting', addEventListener() {}, removeEventListener() {}, close() {} };
    }
    addEventListener() {}
    removeEventListener() {}
    close() {}
  };
  globalThis.performance = globalThis.performance || { now: () => 0 };
  const { Peer } = await import(dir + 'peer.js');
  const relay = new Peer({ peerId: 'a', initiator: true, iceServers: [{ urls: ['turn:x:3478'], username: 'u', credential: 'p' }], iceTransportPolicy: 'relay' });
  assert.equal(configs.at(-1).iceTransportPolicy, 'relay');
  assert.equal(relay.iceTransportPolicy, 'relay');
  new Peer({ peerId: 'b', initiator: true, iceServers: [] });
  assert.equal(configs.at(-1).iceTransportPolicy, 'all');
  new Peer({ peerId: 'c', initiator: false, iceServers: [], iceTransportPolicy: 'none; drop' });
  assert.equal(configs.at(-1).iceTransportPolicy, 'all');
});

/* ============================== turnUsage.js ============================== */

function statsReport(entries) {
  return new Map(entries.map((e) => [e.id, e]));
}

const cfRelayLocal = (id, url = 'turn:turn.cloudflare.com:3478?transport=udp') => ({ id, type: 'local-candidate', candidateType: 'relay', url });
const pair = (id, local, sent, received, extra = {}) => ({ id, type: 'candidate-pair', localCandidateId: local, bytesSent: sent, bytesReceived: received, ...extra });

test('计量：只数本地候选是 Cloudflare 中继的候选对，收发两个方向都算', async () => {
  const { cloudflareRelayPairs, isCloudflareTurnUrl, onlyCloudflareRelays } = await load('src/renderer/lib/turnUsage.js');
  assert.equal(isCloudflareTurnUrl('turns:turn.cloudflare.com:443?transport=tcp'), true);
  assert.equal(isCloudflareTurnUrl('turn:TURN.CLOUDFLARE.COM'), true);
  assert.equal(isCloudflareTurnUrl('turn:turn.cloudflare.com.evil.example:3478'), false);
  assert.equal(isCloudflareTurnUrl('turn:relay.example:3478'), false);
  const report = statsReport([
    cfRelayLocal('L-cf'),
    { id: 'L-other', type: 'local-candidate', candidateType: 'relay', url: 'turn:relay.example:3478' },
    { id: 'L-host', type: 'local-candidate', candidateType: 'host', url: '' },
    { id: 'L-nourl', type: 'local-candidate', candidateType: 'relay' },
    pair('P-cf', 'L-cf', 1000, 3000, { nominated: true, state: 'succeeded' }),
    pair('P-other', 'L-other', 5000, 5000),
    pair('P-host', 'L-host', 7000, 7000),
    pair('P-nourl', 'L-nourl', 11, 22),
    { id: 'T', type: 'transport', bytesSent: 999999 },
  ]);
  assert.deepEqual(cloudflareRelayPairs(report), [{ id: 'P-cf', bytes: 4000 }]);
  // 候选没带 url 时，配置里只有 Cloudflare 一家中继才算它的
  assert.deepEqual(cloudflareRelayPairs(report, { assumeCloudflare: true }).map((p) => p.id), ['P-cf', 'P-nourl']);
  assert.equal(onlyCloudflareRelays([{ urls: ['stun:x'] }, { urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'p' }]), true);
  assert.equal(onlyCloudflareRelays([{ urls: ['turn:turn.cloudflare.com:3478', 'turn:relay.example:3478'] }]), false);
  assert.equal(onlyCloudflareRelays([{ urls: ['stun:x'] }]), false);
  assert.deepEqual(cloudflareRelayPairs(null), []);
});

test('计量：每条连接只累加增量；重连换了新的 RTCPeerConnection 从零算，不重复计数', async () => {
  const { RelayUsageMeter } = await load('src/renderer/lib/turnUsage.js');
  const meter = new RelayUsageMeter();
  const pcA = {};
  assert.equal(meter.take(pcA, [{ id: 'P1', bytes: 1000 }]), 1000);
  assert.equal(meter.take(pcA, [{ id: 'P1', bytes: 1500 }]), 500);
  assert.equal(meter.take(pcA, [{ id: 'P1', bytes: 1500 }]), 0, '没涨就是 0');
  // 选中的候选对换了：新的那一对从它自己的零开始算，旧的那一对照样记着
  assert.equal(meter.take(pcA, [{ id: 'P1', bytes: 1600 }, { id: 'P2', bytes: 300 }]), 400);
  // 重连：同一个人、新的 pc。旧 pc 的 1600 不会再算一遍
  const pcB = {};
  assert.equal(meter.take(pcB, [{ id: 'P1', bytes: 200 }]), 200);
  assert.equal(meter.take(pcA, [{ id: 'P1', bytes: 1600 }, { id: 'P2', bytes: 300 }]), 0);
  // 计数器真往回走了（不该发生）：当它从零重来，宁可多算
  assert.equal(meter.take(pcB, [{ id: 'P1', bytes: 50 }]), 50);
  assert.equal(meter.take(null, [{ id: 'x', bytes: 1 }]), 0);
});

/* ============================ app.js：沙箱 ============================ */

const TURN_FNS = [
  'iceInputs', 'iceServers', 'cfQuotaText', 'relayOnlyBlocked', 'peerIce', 'signalPeerIce', 'cfErrorCode', 'cfErrorText',
  'turnFetchNeeded', 'markCfQuota', 'ensureTurnReady', 'scheduleCfTurnRefresh', 'applyCfUsage', 'applyCfTurnState',
  'fmtGB', 'fmtClock', 'cfTurnStatusText', 'cfUsageText', 'renderCfTurnStatus', 'meterTurnUsage', 'inviteBlocked',
  'refreshLiveCfTurn', 'cfErrorDetail',
];
const TURN_DECLS = [
  'turnWarned', 'RELAY_ONLY_NO_TURN', 'CF_REFRESH_BEFORE_MS', 'CF_RETRY_MS', 'CF_MIN_TIMER_MS', 'cfTurnFetch', 'cfTurnRetryAt',
  'cfTurnTimer', 'cfQuotaLogged', 'CF_ERROR_TEXT', 'TURN_METER_MS', 'TURN_REPORT_MAX', 'turnMeter', 'turnMeterBusy', 'turnUsagePending',
  'CF_RETRY_MAX_MS', 'CF_RETRYABLE', 'cfFailStreak',
];

async function turnBox({ settings = {}, turnApi = {}, fns = [], globals = {} } = {}) {
  const ice = await load('src/renderer/lib/ice.js');
  const usage = await load('src/renderer/lib/turnUsage.js');
  const logs = [];
  const timers = [];
  const retries = [];
  const S = {
    settings: { stun: 'stun:stun.l.google.com:19302', turnEnabled: false, turnUrl: '', turnUser: '', turnPass: '', turnSource: 'manual', relayOnly: false, ...settings },
    cfTurn: null,
    cfTurnState: null,
    cfTurnUsage: null,
    swarm: null,
  };
  const ctx = {
    // 汇报失败那条会 console.warn 一句，测试输出里不要它
    console: { ...console, warn() {} },
    Promise,
    Date,
    Number,
    S,
    log: (text, tone) => logs.push([text, tone]),
    sigLog: (_kind, text, tone) => logs.push([text, tone]),
    t: (s) => s,
    $: () => null,
    setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimeout: () => {},
    buildIceServers: ice.buildIceServers,
    peerIceConfig: ice.peerIceConfig,
    relayServer: ice.relayServer,
    turnMissingCredentials: ice.turnMissingCredentials,
    isCloudflareTurnUrl: usage.isCloudflareTurnUrl,
    // 后台那一轮取完会顺手重试被拦下的邀请卡（见 retryBlockedInvite），这里只记次数
    retryBlockedInvite: () => retries.push(1),
    RelayUsageMeter: usage.RelayUsageMeter,
    cloudflareRelayPairs: usage.cloudflareRelayPairs,
    onlyCloudflareRelays: usage.onlyCloudflareRelays,
    window: { sw: { turn: turnApi } },
    inviteGen: 0,
    ...globals,
  };
  vm.createContext(ctx);
  vm.runInContext([...TURN_DECLS.map(declSource), ...[...TURN_FNS, ...fns].map(fnSource)].join('\n\n'), ctx, { filename: 'app.js（节选）' });
  return { ctx, S, logs, timers, retries };
}

test('app.js 里每一处 new Peer 都从 peerIce()（信令事件里是 signalPeerIce()）拿 ICE 参数', () => {
  const sites = [...APP.matchAll(/new Peer\(\{[\s\S]*?\}\);/g)].map((m) => m[0]);
  assert.ok(sites.length >= 5, `只找到 ${sites.length} 处 new Peer`);
  for (const site of sites) {
    assert.match(site, /\.\.\.(?:peerIce\(\)|ice),/, `这一处没走统一的 helper：${site.slice(0, 80)}`);
    assert.doesNotMatch(site, /iceServers:/, `这一处自己拼了 iceServers：${site.slice(0, 80)}`);
  }
  const iceVars = [...APP.matchAll(/const ice = (\w+)\(\);/g)].map((m) => m[1]);
  assert.ok(iceVars.length >= 3);
  for (const fn of iceVars) assert.ok(['peerIce', 'signalPeerIce'].includes(fn), fn);
});

test('peerIce：没开「隐藏我的 IP」照常 all + STUN；开了走 relay、只带中继；没有中继就抛错，信令事件里只记日志不建连', async () => {
  const off = await turnBox({ settings: MANUAL_TURN });
  const normal = off.ctx.peerIce();
  assert.equal(normal.iceTransportPolicy, 'all');
  assert.ok(JSON.stringify(normal.iceServers).includes('stun:'));
  assert.equal(off.ctx.relayOnlyBlocked(), '');

  const on = await turnBox({ settings: { ...MANUAL_TURN, relayOnly: true } });
  const relay = on.ctx.peerIce();
  assert.equal(relay.iceTransportPolicy, 'relay');
  assert.equal(relay.iceServers.length, 1);
  assert.ok(!JSON.stringify(relay.iceServers).includes('stun:'));

  const blocked = await turnBox({ settings: { relayOnly: true } });
  const text = '已打开「隐藏我的 IP」，但还没有可用的 TURN 中继：请在设置里配好 TURN，或者先关掉这个开关。';
  assert.equal(blocked.ctx.relayOnlyBlocked(), text);
  assert.throws(() => blocked.ctx.peerIce(), (e) => e.message === text);
  assert.equal(blocked.ctx.signalPeerIce(), null);
  assert.deepEqual(blocked.logs, [[text, 'bad']]);
});

test('Cloudflare 来源：有效的临时账号合进 iceServers；本月用量到上限就当它不存在，只走中继时按上限的说法拦下', async () => {
  const r = await turnBox({ settings: { turnSource: 'cloudflare', relayOnly: true, ...MANUAL_TURN } });
  r.S.cfTurn = cfTurn();
  const config = r.ctx.peerIce();
  assert.equal(config.iceServers[0].username, 'cf-user');
  assert.ok(!JSON.stringify(config).includes('relay.example'), '手动那套字段此时要忽略');
  assert.ok(!JSON.stringify(config).includes(':53'), '53 端口没滤掉');

  r.S.cfTurnUsage = { usedBytes: 900e9, limitGB: 900, exceeded: true };
  const blocked = r.ctx.relayOnlyBlocked();
  assert.match(blocked, /^本月 Cloudflare TURN 用量已到你设的上限（900 GB），为免扣费已停用；下个月 1 日（UTC）自动恢复，或者在设置里调高上限/);
  assert.throws(() => r.ctx.peerIce(), /已到你设的上限/);

  // 没开只走中继：新建的连接不再带 Cloudflare TURN，照常直连
  r.S.settings.relayOnly = false;
  const direct = r.ctx.peerIce();
  assert.equal(direct.iceTransportPolicy, 'all');
  assert.ok(!JSON.stringify(direct.iceServers).includes('turn'), '到上限了还把 Cloudflare TURN 塞进新连接');
});

test('ensureTurnReady：来源是 Cloudflare 才去取；同时只发一个请求；离过期不到 12 小时自己再换一组', async () => {
  const manual = await turnBox({ turnApi: { cfCredentials: async () => assert.fail('来源是自己填，不该去取') } });
  assert.equal(manual.ctx.turnFetchNeeded(), false);
  await manual.ctx.ensureTurnReady();

  const calls = [];
  const gate = deferred();
  const expiresAt = Date.now() + 23 * HOUR;
  const r = await turnBox({
    settings: { turnSource: 'cloudflare' },
    turnApi: {
      cfCredentials: async (opts) => {
        calls.push(opts);
        await gate.promise;
        return { urls: CF_URLS, username: 'cf-user', credential: 'cf-pass', expiresAt };
      },
    },
  });
  assert.equal(r.ctx.turnFetchNeeded(), true);
  const a = r.ctx.ensureTurnReady();
  const b = r.ctx.ensureTurnReady();
  gate.resolve();
  await Promise.all([a, b]);
  assert.equal(calls.length, 1, '同时只该发一个请求');
  assert.equal(calls[0].minValidMs, 12 * HOUR);
  assert.equal(r.S.cfTurn.username, 'cf-user');
  assert.equal(r.ctx.turnFetchNeeded(), false, '手上的还新鲜就不用再取');
  // 定时器排在「过期前 12 小时」：新建的连接至少带着 12 小时有效的凭据，一整晚的播放列表也盖得住
  const timer = r.timers.at(-1);
  assert.ok(Math.abs(timer.ms - (expiresAt - 12 * HOUR - Date.now())) < 5000, `定时器排在 ${timer.ms}ms 之后`);
  // 只剩不到 12 小时：该换了
  r.S.cfTurn.expiresAt = Date.now() + HOUR;
  assert.equal(r.ctx.turnFetchNeeded(), true);
});

test('ensureTurnReady 取不到：没开「隐藏我的 IP」记一条日志、照常直连；开了就拦下；30 秒内不再重试', async () => {
  const fail = async () => {
    throw new Error("Error invoking remote method 'turn:cfCredentials': Error: [CF_NETWORK] 连不上 Cloudflare");
  };
  const r = await turnBox({ settings: { turnSource: 'cloudflare' }, turnApi: { cfCredentials: fail } });
  await r.ctx.ensureTurnReady();
  assert.deepEqual(r.logs, [['Cloudflare TURN 账号没拿到（网络不通：连不上 Cloudflare），这次先不走中继、只尝试直连', 'warn']]);
  assert.equal(r.ctx.peerIce().iceTransportPolicy, 'all', 'TURN 本来就是兜底，取不到不该挡着直连');
  assert.equal(r.S.cfTurnState.lastError, 'CF_NETWORK');
  assert.equal(r.ctx.turnFetchNeeded(), false, '刚失败过，别让每条连接都干等');

  const strict = await turnBox({ settings: { turnSource: 'cloudflare', relayOnly: true }, turnApi: { cfCredentials: fail } });
  await strict.ctx.ensureTurnReady();
  assert.equal(strict.logs[0][1], 'bad');
  assert.match(strict.ctx.relayOnlyBlocked(), /隐藏我的 IP/);
  assert.throws(() => strict.ctx.peerIce());
});

test('主进程说 CF_QUOTA：临时账号作废、记下已到上限，日志只说一次', async () => {
  const quota = async () => {
    throw new Error('Error: [CF_QUOTA] 本月用量已到上限（50 GB）');
  };
  const r = await turnBox({ settings: { turnSource: 'cloudflare', relayOnly: true }, turnApi: { cfCredentials: quota } });
  r.S.cfTurn = cfTurn(Date.now() + HOUR);
  await r.ctx.ensureTurnReady();
  assert.equal(r.S.cfTurn, null);
  assert.equal(r.S.cfTurnUsage.exceeded, true);
  assert.equal(r.S.cfTurnUsage.limitGB, 50);
  assert.match(r.ctx.relayOnlyBlocked(), /已到你设的上限（50 GB）/);
  vm.runInContext('cfTurnRetryAt = 0', r.ctx);
  await r.ctx.ensureTurnReady();
  assert.equal(r.logs.filter(([text]) => /已到你设的上限/.test(text)).length, 1, '到上限的提醒刷屏了');
});

/* ---------------------- 临时账号的续取（修复批次 12） ---------------------- */

const freshCreds = (username = 'cf-user') => ({ urls: CF_URLS, username, credential: 'cf-pass', expiresAt: Date.now() + 23 * HOUR });

test('取号失败：后台按退避接着取（30 秒起翻倍、封顶 10 分钟）直到拿到；日志只在第一次失败和恢复时各说一句', async () => {
  let fail = true;
  let calls = 0;
  const r = await turnBox({
    settings: { turnSource: 'cloudflare' },
    turnApi: {
      cfCredentials: async () => {
        calls++;
        if (fail) throw new Error("Error invoking remote method 'turn:cfCredentials': Error: [CF_UNAVAILABLE] HTTP 503");
        return freshCreds();
      },
    },
  });
  await r.ctx.ensureTurnReady();
  assert.equal(calls, 1);
  const waits = [r.timers.at(-1).ms];
  for (let i = 0; i < 7; i++) {
    // 定时器到点时 30 秒的冷却早过了；这里不真等，拨掉
    vm.runInContext('cfTurnRetryAt = 0', r.ctx);
    await r.timers.at(-1).fn();
    waits.push(r.timers.at(-1).ms);
  }
  assert.deepEqual(waits, [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000]);
  assert.equal(calls, 8, '每一轮都真的去取了');
  assert.equal(r.logs.length, 1, '同一件事别刷屏');
  assert.deepEqual(r.logs[0], ['Cloudflare TURN 账号没拿到（Cloudflare 暂时不可用（限流或服务故障），稍后再试），这次先不走中继、只尝试直连', 'warn']);
  assert.equal(r.retries.length, 7, '每一轮之后都让被拦下的邀请卡看一眼');

  // 恢复了：说一声，回到「离过期 12 小时前换一组」的节奏
  fail = false;
  vm.runInContext('cfTurnRetryAt = 0', r.ctx);
  await r.timers.at(-1).fn();
  assert.equal(r.S.cfTurn.username, 'cf-user');
  assert.deepEqual(r.logs.at(-1), ['Cloudflare TURN 账号拿到了，之后新建的连接会带上中继', 'good']);
  assert.equal(vm.runInContext('cfFailStreak', r.ctx), 0);
  assert.ok(Math.abs(r.timers.at(-1).ms - 11 * HOUR) < 5000, `下一次排在 ${r.timers.at(-1).ms}ms 之后`);
});

test('要用户动手的失败（凭据被拒、没配置、到上限）后台不重试', async () => {
  for (const message of ['Error: [CF_UNAUTHORIZED] HTTP 401', 'Error: [CF_NOT_CONFIGURED] 还没保存 Cloudflare 凭据', 'Error: [CF_QUOTA] 本月用量已到上限（50 GB）']) {
    const r = await turnBox({
      settings: { turnSource: 'cloudflare' },
      turnApi: {
        cfCredentials: async () => {
          throw new Error(message);
        },
      },
    });
    await r.ctx.ensureTurnReady();
    assert.equal(r.timers.length, 0, message);
  }
});

test('信令事件里建连（peerIce / signalPeerIce）：没有能用的 Cloudflare 账号就顺手在后台取，不等它、这一次照旧；下一次就带上中继', async () => {
  const peerIce = fnSource('peerIce');
  assert.ok(!/^async /.test(peerIce) && !/await/.test(peerIce), 'peerIce 必须保持同步，不能改变信令事件里建连的时序');
  assert.match(peerIce, /if \(turnFetchNeeded\(\)\) ensureTurnReady\(\)\.catch\(\(\) => \{\}\);/);
  assert.doesNotMatch(fnSource('signalPeerIce'), /await/);

  const gate = deferred();
  let calls = 0;
  const r = await turnBox({
    settings: { turnSource: 'cloudflare' },
    turnApi: {
      cfCredentials: async () => {
        calls++;
        await gate.promise;
        return freshCreds();
      },
    },
  });
  const first = r.ctx.peerIce();
  assert.equal(first.iceTransportPolicy, 'all');
  assert.ok(!JSON.stringify(first.iceServers).includes('turn:'), '这一次照旧：还没有中继');
  await flush();
  assert.equal(calls, 1, '顺手去取了');
  r.ctx.peerIce();
  await flush();
  assert.equal(calls, 1, '在途的那次还没回来，不重复发');
  gate.resolve();
  await flush();
  assert.ok(JSON.stringify(r.ctx.peerIce().iceServers).includes('cf-user'), '下一次就带上了');

  // 只走中继：这一次拦下（绝不退回直连），同样顺手去取；取到之后信令事件里的下一次就放行
  const gate2 = deferred();
  const strict = await turnBox({
    settings: { turnSource: 'cloudflare', relayOnly: true },
    turnApi: {
      cfCredentials: async () => {
        await gate2.promise;
        return freshCreds();
      },
    },
  });
  assert.equal(strict.ctx.signalPeerIce(), null);
  gate2.resolve();
  await flush();
  const ok = strict.ctx.signalPeerIce();
  assert.equal(ok.iceTransportPolicy, 'relay');
  assert.equal(ok.iceServers[0].username, 'cf-user');
});

test('换到新账号后，还连着的连接用 setConfiguration 换上：只换 Cloudflare 那一条，relay / all 策略原样保留，证书不回传', async () => {
  const r = await turnBox({
    settings: { turnSource: 'cloudflare', relayOnly: true },
    turnApi: { cfCredentials: async () => freshCreds('new-user') },
  });
  const pcOf = (iceServers, policy) => {
    const pc = {
      applied: [],
      getConfiguration: () => ({
        iceServers,
        iceTransportPolicy: policy,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
        iceCandidatePoolSize: 4,
        certificates: [{ id: 'cert' }],
      }),
      setConfiguration: (config) => pc.applied.push(config),
    };
    return pc;
  };
  const oldCf = { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'old-user', credential: 'old-pass' };
  const manual = { urls: ['turn:relay.example:3478?transport=udp'], username: 'u', credential: 'p' };
  const stun = { urls: ['stun:stun.l.google.com:19302'] };
  const relayPeer = { closed: false, iceTransportPolicy: 'relay', pc: pcOf([oldCf], 'relay') };
  const allPeer = { closed: false, iceTransportPolicy: 'all', pc: pcOf([stun, oldCf, manual], 'all') };
  const noCf = { closed: false, iceTransportPolicy: 'all', pc: pcOf([stun, manual], 'all') };
  const closed = { closed: true, iceTransportPolicy: 'all', pc: pcOf([stun, oldCf], 'all') };
  const pending = { closed: false, iceTransportPolicy: 'relay', pc: pcOf([oldCf], 'relay') };
  r.S.swarm = { peers: new Map([['a', relayPeer], ['b', allPeer], ['c', noCf], ['d', closed]]) };
  r.S.pendingManualPeer = pending;
  r.S.cfTurn = cfTurn(Date.now() + HOUR); // 离过期不到 12 小时，该换了
  await r.ctx.ensureTurnReady();
  assert.equal(r.S.cfTurn.username, 'new-user');

  const [relayCfg] = relayPeer.pc.applied;
  assert.equal(relayCfg.iceTransportPolicy, 'relay', '只走中继的连接不许放宽');
  assert.deepEqual([...relayCfg.iceServers].map((s) => s.username), ['new-user']);
  assert.ok(!JSON.stringify(relayCfg).includes(':53'), '53 端口没滤掉');
  assert.equal(relayCfg.iceCandidatePoolSize, 4, '候选池大小不能变（setLocalDescription 之后改会抛错）');
  assert.equal(relayCfg.bundlePolicy, 'max-bundle');
  assert.ok(!('certificates' in relayCfg), '证书不回传');
  const [allCfg] = allPeer.pc.applied;
  assert.equal(allCfg.iceTransportPolicy, 'all');
  assert.deepEqual([...allCfg.iceServers].map((s) => s.username ?? 'stun'), ['stun', 'u', 'new-user'], '别的服务器原样留着');
  assert.equal(noCf.pc.applied.length, 0, '本来没带 Cloudflare 中继的连接不往里加');
  assert.equal(closed.pc.applied.length, 0);
  assert.equal(pending.pc.applied.length, 1, '还在等应答的一对一邀请也换');

  // 本月到上限了：不再给连着的连接续新账号
  r.S.cfTurnUsage = { exceeded: true, limitGB: 1 };
  assert.equal(r.ctx.refreshLiveCfTurn(), 0);
  // setConfiguration 抛错（浏览器不认）：记一句，不影响别的连接，也不让取号算成失败
  r.S.cfTurnUsage = null;
  noCf.pc.setConfiguration = () => {
    throw new Error('InvalidModificationError');
  };
  allPeer.pc.setConfiguration = () => {
    throw new Error('InvalidModificationError');
  };
  assert.equal(r.ctx.refreshLiveCfTurn(), 2);
});

test('调高月上限（exceeded 由真变假）：「已到上限」那条旧错误撤掉，冷却不等，来源是 Cloudflare 就马上取一组', async () => {
  let calls = 0;
  const r = await turnBox({
    settings: { turnSource: 'cloudflare' },
    turnApi: {
      cfCredentials: async () => {
        calls++;
        if (calls === 1) throw new Error('Error: [CF_QUOTA] 本月用量已到上限（50 GB）');
        return freshCreds();
      },
    },
  });
  r.S.cfTurnState = { configured: true, expiresAt: null, lastError: null };
  await r.ctx.ensureTurnReady();
  assert.equal(r.S.cfTurnState.lastError, 'CF_QUOTA');
  assert.match(r.ctx.cfTurnStatusText(), /已到你设的上限（50 GB）/);
  assert.equal(r.ctx.turnFetchNeeded(), false, '刚失败过，本来要冷却 30 秒');

  r.ctx.applyCfUsage({ usedBytes: 50e9, limitGB: 100, exceeded: false, nearLimit: false });
  assert.equal(r.S.cfTurnState.lastError, null, '状态行不能还说已停用');
  await flush();
  assert.equal(calls, 2, '上限调高了就马上去取');
  assert.match(r.ctx.cfTurnStatusText(), /^Cloudflare TURN：已配置，账号有效至 \d{2}:\d{2}$/);

  // 来源不是 Cloudflare：只撤错误，不去取
  const manual = await turnBox({ turnApi: { cfCredentials: async () => assert.fail('来源是自己填，不该去取') } });
  manual.S.cfTurnUsage = { usedBytes: 50e9, limitGB: 50, exceeded: true };
  manual.S.cfTurnState = { configured: true, expiresAt: null, lastError: 'CF_QUOTA' };
  manual.ctx.applyCfUsage({ usedBytes: 50e9, limitGB: 100, exceeded: false });
  await flush();
  assert.equal(manual.S.cfTurnState.lastError, null);
});

test('保存凭据时 Cloudflare 回了 HTTP 错误：限流 / 故障说「稍后再试」，都带上状态码；凭据被拒照旧', async () => {
  const r = await turnBox();
  const detail = (message) => r.ctx.cfErrorDetail(new Error(message));
  assert.equal(detail("Error invoking remote method 'turn:cfSave': Error: [CF_UNAVAILABLE] HTTP 503"), 'Cloudflare 暂时不可用（限流或服务故障），稍后再试（HTTP 503）');
  assert.equal(detail('Error: [CF_UNAVAILABLE] HTTP 429'), 'Cloudflare 暂时不可用（限流或服务故障），稍后再试（HTTP 429）');
  assert.equal(detail('Error: [CF_BAD_RESPONSE] HTTP 404'), 'Cloudflare 的回应看不懂（HTTP 404）');
  assert.equal(detail('Error: [CF_BAD_RESPONSE] 响应不是 JSON'), 'Cloudflare 的回应看不懂');
  assert.equal(detail('Error: [CF_UNAUTHORIZED] HTTP 401'), '未授权：Cloudflare 不认这组 Turn Token ID 和 API Token');
});

test('渲染进程要的最短有效期没超过主进程放行的上限', () => {
  const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
  const hours = (src, name) => Number(new RegExp(`const ${name} = (\\d+) \\* 60 \\* 60 \\* 1000;`).exec(src)?.[1]);
  const refresh = hours(APP, 'CF_REFRESH_BEFORE_MS');
  const cap = hours(main, 'MAX_TURN_MIN_VALID_MS');
  assert.equal(refresh, 12);
  assert.ok(cap >= refresh && cap < 23, `主进程上限 ${cap} 小时`);
});

test('用量计量：每 10 秒汇报一次增量，重连不重复计数；80% 提醒一次；到上限停用 Cloudflare TURN', async () => {
  const reports = [];
  let used = 0;
  const limitGB = 20;
  const r = await turnBox({
    settings: { turnSource: 'cloudflare', relayOnly: true },
    turnApi: {
      cfReportUsage: async (bytes) => {
        reports.push(bytes);
        const before = used;
        used += bytes;
        return {
          usedBytes: used,
          limitGB,
          exceeded: used >= limitGB * 1e9,
          nearLimit: used >= limitGB * 1e9 * 0.8,
          crossedWarn: before < limitGB * 1e9 * 0.8 && used >= limitGB * 1e9 * 0.8,
        };
      },
    },
  });
  const pcOf = (bytes) => {
    const pc = { bytes, getStats: async () => statsReport([cfRelayLocal('L'), pair('P', 'L', pc.bytes / 2, pc.bytes / 2)]) };
    return pc;
  };
  const peerA = { peerId: 'a', closed: false, pc: pcOf(2e9) };
  const direct = { peerId: 'd', closed: false, pc: { getStats: async () => statsReport([{ id: 'L', type: 'local-candidate', candidateType: 'host' }, pair('P', 'L', 5e9, 5e9)]) } };
  r.S.swarm = { peers: new Map([['a', peerA], ['d', direct]]) };
  r.S.cfTurn = cfTurn();
  assert.equal(vm.runInContext('TURN_METER_MS', r.ctx), 10_000);

  await r.ctx.meterTurnUsage();
  assert.deepEqual(reports, [2e9], '直连的那条不该算进 Cloudflare 的用量');
  peerA.pc.bytes = 5e9;
  await r.ctx.meterTurnUsage();
  assert.deepEqual(reports, [2e9, 3e9], '要报增量，不是累计值');
  await r.ctx.meterTurnUsage();
  assert.equal(reports.length, 2, '没涨就不报');

  // 重连：同一个人换了一条新连接。新连接从零算（6GB 全算），旧连接的 5GB 不再算一遍；
  // 按人记的话这里只会算出 1GB
  peerA.pc = pcOf(6e9);
  await r.ctx.meterTurnUsage();
  assert.deepEqual(reports, [2e9, 3e9, 6e9]);
  assert.equal(r.logs.filter(([t]) => /超过你设的上限的 80%/.test(t)).length, 0);

  peerA.pc.bytes = 11.5e9;
  await r.ctx.meterTurnUsage();
  assert.equal(r.logs.filter(([t]) => /超过你设的上限的 80%/.test(t)).length, 1, '过 80% 要在日志里提醒一次');
  assert.ok(r.S.cfTurn, '还没到上限');

  peerA.pc.bytes = 15e9;
  await r.ctx.meterTurnUsage();
  assert.deepEqual(reports, [2e9, 3e9, 6e9, 5.5e9, 3.5e9]);
  assert.equal(r.S.cfTurnUsage.exceeded, true);
  assert.equal(r.S.cfTurn, null, '到上限了，新连接不能再用 Cloudflare TURN');
  assert.match(r.ctx.relayOnlyBlocked(), /已到你设的上限（20 GB）/);
  assert.ok(r.logs.some(([t, tone]) => /已到你设的上限（20 GB）/.test(t) && tone === 'bad'));
  assert.equal(r.logs.filter(([t]) => /超过你设的上限的 80%/.test(t)).length, 1, '80% 的提醒只说一次');
  // 已经连着的连接不强行断开：计量照常，只是不再续用
  assert.equal(peerA.closed, false);
});

test('用量汇报失败：这一轮的增量先攒着，下一轮一起报', async () => {
  const reports = [];
  let fail = true;
  const r = await turnBox({
    turnApi: {
      cfReportUsage: async (bytes) => {
        if (fail) throw new Error('IPC 没通');
        reports.push(bytes);
        return { usedBytes: bytes, limitGB: 900 };
      },
    },
  });
  const pc = { getStats: async () => statsReport([cfRelayLocal('L'), pair('P', 'L', pc.sent, 0)]), sent: 100 };
  r.S.swarm = { peers: new Map([['a', { peerId: 'a', closed: false, pc }]]) };
  await r.ctx.meterTurnUsage();
  assert.deepEqual(reports, []);
  fail = false;
  pc.sent = 250;
  await r.ctx.meterTurnUsage();
  assert.deepEqual(reports, [250]);
});

/* ======================== app.js：建连接之前的关口 ======================== */

const BLOCK_TEXT = '已打开「隐藏我的 IP」，但还没有可用的 TURN 中继：请在设置里配好 TURN，或者先关掉这个开关。';

/** 各条建连路径的沙箱：一次加入 / 一次邀请走到哪一步，全记在 calls 里。 */
function flowBox(fns, { blocked = BLOCK_TEXT, fetchNeeded = false, ensure = async () => {}, extra = {} } = {}) {
  const calls = [];
  const gens = { join: 0 };
  const S = { settings: { securityMode: 'trusted', relays: '', signalUrl: 'ws://x' }, roomCapacity: 4, roomSecurityMode: 'trusted', peerId: 'me', name: '我', pendingManualPeer: null };
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, { id, textContent: '', value: '', style: {}, classList: { add() {}, remove() {}, toggle() {} } });
    return els.get(id);
  };
  class Peer {
    constructor(o) {
      calls.push(['peer', o]);
    }
  }
  const ctx = {
    console,
    Promise,
    S,
    $,
    Peer,
    PROTOCOL_VERSION: 2,
    normalizeSecurityMode: (m) => (m === 'trusted' ? 'trusted' : 'safe'),
    securityModeLabel: (m) => m,
    inviteVersionText: () => '版本不对',
    inviteKey: () => 'key',
    joiningWith: () => false,
    beginAttempt: () => ++gens.join,
    attemptLive: (g) => g === gens.join,
    clampCapacity: (n) => n,
    show: (v) => calls.push(['show', v]),
    setSteps: () => {},
    inviteFileLine: () => '',
    replace: (target, ...nodes) => calls.push(['replace', nodes.flat().map((n) => n?.text || '').join('|')]),
    make: (tag, o = {}) => ({ tag, ...o, style: {} }),
    cancelJoinButton: () => ({}),
    initSwarmAndSync: () => calls.push(['init']),
    connectSignaling: async (...args) => {
      calls.push(['connect', ...args]);
      return { hostId: 'host' };
    },
    connectedPeerCount: () => 0,
    prepStop: (title, msg) => calls.push(['stop', title, msg]),
    prepFail: (msg) => calls.push(['fail', msg]),
    log: (text, tone) => calls.push(['log', text, tone]),
    inviteViaManual: async (notice) => calls.push(['manual', notice]),
    createManualInvite: async () => calls.push(['create']),
    turnFetchNeeded: () => fetchNeeded,
    ensureTurnReady: ensure,
    relayOnlyBlocked: () => blocked,
    peerIce: () => {
      if (blocked) throw new Error(blocked);
      return { iceServers: [], iceTransportPolicy: 'all' };
    },
    inviteGen: 0,
    ...extra,
  };
  vm.createContext(ctx);
  vm.runInContext(fns.map(fnSource).join('\n\n'), ctx, { filename: 'app.js（节选）' });
  return { ctx, S, calls, gens, $ };
}

const OFFER = { k: 'offer', from: 'host', name: '房主', sdp: { type: 'offer', sdp: 'v=0' }, securityMode: 'trusted', protocolVersion: 2 };
const ROOM = { k: 'room', url: 'ws://x', room: 'R1', from: 'host', securityMode: 'trusted', protocolVersion: 2 };
const RELAY = { k: 'relay', key: 'K'.repeat(43), hk: 'a'.repeat(64), from: 'host', securityMode: 'trusted', relays: null, protocolVersion: 2 };

test('开了「隐藏我的 IP」却没有中继：三种加入都停在准备页说清楚，不建连接、不连信令', async () => {
  const manual = flowBox(['joinViaManual']);
  await manual.ctx.joinViaManual(OFFER);
  const server = flowBox(['joinViaServer']);
  await server.ctx.joinViaServer(ROOM);
  const relay = flowBox(['joinViaRelay']);
  await relay.ctx.joinViaRelay(RELAY);
  for (const [name, box] of [['一对一', manual], ['信令', server], ['房间链接', relay]]) {
    const kinds = box.calls.map((c) => c[0]);
    assert.ok(!kinds.includes('peer'), `${name}：建了连接`);
    assert.ok(!kinds.includes('connect'), `${name}：连了信令`);
    assert.ok(!kinds.includes('init'), `${name}：建了 Swarm`);
    assert.deepEqual(box.calls.find((c) => c[0] === 'stop'), ['stop', '还不能连接', BLOCK_TEXT], `${name}：没把原因说出来`);
  }
  // 不拦的时候照常往下走（反面对照，免得上面是空跑）
  const open = flowBox(['joinViaRelay'], { blocked: '', extra: { refreshRoomLink: async () => {} } });
  await open.ctx.joinViaRelay(RELAY);
  assert.ok(open.calls.some((c) => c[0] === 'connect'));
});

test('开了「隐藏我的 IP」却没有中继：三种邀请都不发，原因画在邀请卡上；房间链接也不退回一对一', async () => {
  const relay = flowBox(['inviteViaRelay', 'inviteBlocked']);
  await relay.ctx.inviteViaRelay();
  const server = flowBox(['inviteViaServer', 'inviteBlocked']);
  await server.ctx.inviteViaServer();
  const closed = [];
  const manual = flowBox(['inviteViaManual', 'inviteBlocked'], { extra: { createManualInvite: async () => manual.calls.push(['create']) } });
  manual.S.pendingManualPeer = { close: () => closed.push('old') };
  await manual.ctx.inviteViaManual();
  for (const [name, box] of [['房间链接', relay], ['信令', server], ['一对一', manual]]) {
    const kinds = box.calls.map((c) => c[0]);
    assert.ok(!kinds.includes('connect') && !kinds.includes('create') && !kinds.includes('peer'), `${name}：还是建了连接`);
    assert.ok(!kinds.includes('manual'), `${name}：退回了一对一邀请`);
    assert.ok(box.calls.some((c) => c[0] === 'replace' && c[1] === BLOCK_TEXT), `${name}：邀请卡上没写原因`);
    assert.ok(box.calls.some((c) => c[0] === 'log' && c[1] === BLOCK_TEXT && c[2] === 'bad'), `${name}：日志里没记`);
  }
  assert.deepEqual(closed, ['old'], '手上那条旧的一对一链接也要作废');
  assert.equal(manual.S.pendingManualPeer, null);
});

test('信令事件里（有人进房、收到 offer）被拦下时不建连接', () => {
  const connect = fnSource('connectSignaling');
  const join = connect.slice(connect.indexOf("sig.on('peer-join'"), connect.indexOf("sig.on('signal'"));
  assert.match(join, /const ice = signalPeerIce\(\);\s*if \(!ice\) return;[\s\S]*new Peer\(/);
  const offer = connect.slice(connect.indexOf("if (payload.kind === 'offer')"), connect.indexOf("if (payload.kind === 'renegotiate')"));
  assert.match(offer, /const ice = signalPeerIce\(\);\s*if \(!ice\) return;\s*if \(peer\) S\.swarm\.removePeer\(from\);/, '拦下之前不能先把旧连接拆了');
  // 重连：先拿 ICE 参数（拦下就抛给调用方记日志），旧连接也不拆
  assert.match(fnSource('reconnectPeer'), /const ice = peerIce\(\);\s*if \(S\.swarm\.peers\.has\(peerId\)\) S\.swarm\.removePeer\(peerId\);/);
});

test('要现取 Cloudflare 账号时先 await，回来之后照查加入代次：已经换了一次尝试就什么都不动', async () => {
  for (const [fn, payload] of [['joinViaRelay', RELAY], ['joinViaServer', ROOM], ['joinViaManual', OFFER]]) {
    const gate = deferred();
    let waited = 0;
    const box = flowBox([fn], {
      blocked: '',
      fetchNeeded: true,
      ensure: async () => {
        waited++;
        await gate.promise;
      },
      extra: { refreshRoomLink: async () => {}, wirePeer: () => {}, encodeCode: async () => 'c', shareLink: () => 'l', copyCode: () => {}, window: { sw: { clipboard: { writeText: async () => {} } } }, S: undefined },
    });
    box.ctx.S = box.S;
    box.S.swarm = { removePeer() {}, addPeer() {}, on: () => () => {}, peers: new Map() };
    const running = box.ctx[fn](payload);
    await flush();
    assert.equal(waited, 1, `${fn}：没等 TURN 就往下走了`);
    assert.ok(!box.calls.some((c) => ['connect', 'init', 'peer'].includes(c[0])), `${fn}：等 TURN 的时候就开始建连了`);
    box.gens.join += 1; // 用户这时点了返回、又去加入了别的
    gate.resolve();
    await running;
    assert.ok(!box.calls.some((c) => ['connect', 'init', 'peer', 'stop'].includes(c[0])), `${fn}：过期的那次还在往下走`);
  }
});

test('要现取 Cloudflare 账号时先 await，回来之后照查邀请卡代次：房主改点了别的邀请方式就作废', async () => {
  for (const fn of ['inviteViaRelay', 'inviteViaServer', 'inviteViaManual']) {
    const gate = deferred();
    const box = flowBox([fn, 'inviteBlocked'], { blocked: '', fetchNeeded: true, ensure: () => gate.promise });
    const running = box.ctx[fn]();
    await flush();
    vm.runInContext('inviteGen += 1', box.ctx); // 房主手快，点了另一种邀请
    gate.resolve();
    await running;
    const kinds = box.calls.map((c) => c[0]);
    assert.ok(!kinds.includes('connect') && !kinds.includes('create') && !kinds.includes('manual'), `${fn}：过期的邀请还在往下走`);
  }
});

test('邀请卡被「隐藏我的 IP」拦下后补好了 TURN：按原来的邀请方式自动重来；房主换了邀请方式就作废；还是没中继就不动', async () => {
  const state = { blocked: BLOCK_TEXT, fetchNeeded: false };
  const box = flowBox(['inviteViaRelay', 'inviteBlocked', 'retryBlockedInvite'], {
    extra: {
      roomEntered: true,
      blockedInvite: null,
      relayOnlyBlocked: () => state.blocked,
      turnFetchNeeded: () => state.fetchNeeded,
      customRelays: () => null,
      newRoomSecret: () => 'secret',
      renderRelayInvite: async () => box.calls.push(['render']),
    },
  });
  box.S.role = 'host';
  await box.ctx.inviteViaRelay();
  assert.ok(!box.calls.some((c) => c[0] === 'connect'), '拦下时不该连中继');
  const pending = vm.runInContext('blockedInvite', box.ctx);
  assert.ok(pending && typeof pending.retry === 'function', '拦下时记下怎么重来');

  // 还是没中继、也没有账号可取：不动它，免得日志里再刷一遍同一句
  box.ctx.retryBlockedInvite();
  await flush();
  assert.ok(!box.calls.some((c) => c[0] === 'connect'));
  assert.ok(vm.runInContext('blockedInvite', box.ctx), '记录留着，等下一次补好');

  // 补好了（或关掉了开关）：按原来的方式（房间链接）重来一次，只来一次
  state.blocked = '';
  box.ctx.retryBlockedInvite();
  box.ctx.retryBlockedInvite();
  await flush();
  assert.equal(box.calls.filter((c) => c[0] === 'connect').length, 1);
  assert.ok(box.calls.some((c) => c[0] === 'render'));
  assert.equal(vm.runInContext('blockedInvite', box.ctx), null);

  // Cloudflare 的账号还在取：一样重来（邀请流程自己会先等账号）
  const cf = flowBox(['inviteViaServer', 'inviteBlocked', 'retryBlockedInvite'], {
    extra: { roomEntered: true, blockedInvite: null, turnFetchNeeded: () => cf.fetch === true },
  });
  cf.S.role = 'host';
  await cf.ctx.inviteViaServer();
  cf.fetch = true;
  const before = cf.calls.length;
  cf.ctx.retryBlockedInvite();
  await flush();
  assert.ok(cf.calls.length > before, '有账号可取时应当重来');

  // 房主已经点了别的邀请方式：旧的那张作废，不重来
  const stale = flowBox(['inviteViaRelay', 'inviteBlocked', 'retryBlockedInvite'], {
    extra: { roomEntered: true, blockedInvite: null, relayOnlyBlocked: () => state.stale ?? BLOCK_TEXT },
  });
  stale.S.role = 'host';
  await stale.ctx.inviteViaRelay();
  vm.runInContext('inviteGen += 1', stale.ctx);
  state.stale = '';
  stale.ctx.retryBlockedInvite();
  await flush();
  assert.ok(!stale.calls.some((c) => c[0] === 'connect'));
  assert.equal(vm.runInContext('blockedInvite', stale.ctx), null);
});

test('只走中继的连接连不上时，诊断按「中继候选为 0」说话；Cloudflare 来源看这条连接有没有带上中继', async () => {
  const ice = await load('src/renderer/lib/ice.js');
  const ctx = {
    S: { settings: { turnSource: 'manual', turnEnabled: false, turnUrl: '' } },
    summarizeCandidates: ice.summarizeCandidates,
    parseSdpCandidates: ice.parseSdpCandidates,
    adviseConnection: ice.adviseConnection,
  };
  vm.createContext(ctx);
  vm.runInContext(fnSource('connectionAdvice'), ctx);
  const relayPeer = { iceTransportPolicy: 'relay', localCandidateStats: ice.summarizeCandidates(''), candidateErrors: [], localCandidates: [], candidateTypes: new Set() };
  assert.match(ctx.connectionAdvice(relayPeer).text, /隐藏我的 IP/);
  const allPeer = { ...relayPeer, iceTransportPolicy: 'all' };
  assert.match(ctx.connectionAdvice(allPeer).text, /防火墙/);
  ctx.S.settings.turnSource = 'cloudflare';
  const srflx = ice.summarizeCandidates('a=candidate:1 1 udp 100 203.0.113.9 5000 typ srflx raddr 10.0.0.1 rport 5000');
  assert.match(ctx.connectionAdvice({ ...allPeer, localCandidateStats: srflx, _expectRelay: true }).text, /配了 TURN 中继却没拿到中继候选/);
});

test('诊断信息里只有 TURN 来源和开关状态，不含任何凭据', () => {
  const fn = APP.slice(APP.indexOf('function collectDiagnostics('), APP.indexOf('function copyDiagnosticsButton('));
  assert.match(fn, /TURN来源=/);
  assert.match(fn, /隐藏IP=/);
  for (const leak of ['credential', 'username', 'turnPass', 'turnUser', 'apiToken', 'keyId']) assert.ok(!fn.includes(leak), leak);
});

/* ============================== 设置 ============================== */

test('设置：TURN 来源存 sw.turnSource（默认 manual），「隐藏我的 IP」存 sw.relayOnly（默认关）；Token 不进 localStorage', () => {
  assert.match(APP, /turnSource: localStorage\.getItem\('sw\.turnSource'\) === 'cloudflare' \? 'cloudflare' : 'manual',/);
  assert.match(APP, /relayOnly: localStorage\.getItem\('sw\.relayOnly'\) === '1',/);
  const save = APP.slice(APP.indexOf("okText: '保存',"), APP.indexOf('function saveCapacitySetting('));
  assert.match(save, /localStorage\.setItem\('sw\.turnSource', S\.settings\.turnSource\);/);
  assert.match(save, /localStorage\.setItem\('sw\.relayOnly', S\.settings\.relayOnly \? '1' : '0'\);/);
  // 月上限存在主进程，不在 localStorage
  assert.match(save, /window\.sw\.turn\s*\.cfSetLimit\(cfLimit\)/);
  assert.doesNotMatch(APP, /localStorage\.setItem\([^)]*(?:cf|Token|token|limit)/i, 'Cloudflare 的东西写进了 localStorage');
  const fields = fnSource('turnSettingsFields');
  assert.match(fields, /'隐藏我的 IP（只经 TURN 中继连接）'/);
  assert.match(fields, /'自己填'/);
  assert.match(fields, /'Cloudflare 自动生成'/);
  assert.match(fields, /id: 'set-cf-token', attrs: \{ type: 'password'/);
  assert.doesNotMatch(fields, /id: 'set-cf-token'[^\n]*props:/, 'API Token 输入框不能预填');
  assert.match(fields, /Manage Account → Billing → Billable Usage/);
  assert.match(fields, /本机统计/);
});

test('「验证并保存」成功后清空两个输入框，只显示「已保存」；失败时按代码说原因', async () => {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, { id, value: '', textContent: '', classList: { toggle() {} } });
    return els.get(id);
  };
  $('set-cf-key').value = 'abcdefgh1234';
  $('set-cf-token').value = 'x'.repeat(20);
  const saved = [];
  let failWith = null;
  const r = await turnBox({
    fns: ['saveCfTurnCredentials', 'noteSettingsApplied'],
    globals: { $, settingsApplied: null, retryBlockedInvite: () => {} },
    turnApi: {
      cfSave: async (keyId, apiToken) => {
        if (failWith) throw new Error(failWith);
        saved.push([keyId, apiToken]);
        return { configured: true, expiresAt: Date.now() + HOUR, lastError: null, usage: { usedBytes: 0, limitGB: 900 } };
      },
    },
  });
  const button = { disabled: false };
  const result = { textContent: '' };
  await r.ctx.saveCfTurnCredentials(button, result);
  assert.deepEqual(saved, [['abcdefgh1234', 'x'.repeat(20)]]);
  assert.equal($('set-cf-token').value, '', 'Token 留在输入框里了');
  assert.equal($('set-cf-key').value, '');
  assert.equal(result.textContent, '已保存');
  assert.equal(r.S.cfTurnState.configured, true);
  assert.equal(button.disabled, false);

  $('set-cf-key').value = 'abcdefgh1234';
  $('set-cf-token').value = 'y'.repeat(20);
  failWith = "Error invoking remote method 'turn:cfSave': Error: [CF_UNAUTHORIZED] HTTP 401";
  await r.ctx.saveCfTurnCredentials(button, result);
  assert.equal(result.textContent, '没保存：未授权：Cloudflare 不认这组 Turn Token ID 和 API Token');
  failWith = "Error invoking remote method 'turn:cfSave': TypeError: 无效的 API Token";
  await r.ctx.saveCfTurnCredentials(button, result);
  assert.equal(result.textContent, '没保存：Turn Token ID 或 API Token 的格式不对');
});

/** 设置页里 Cloudflare 那几个按钮的假输入框：id → { value, checked, textContent }。 */
function fakeInputs() {
  const els = new Map();
  return (id) => {
    if (!els.has(id)) els.set(id, { id, value: '', checked: false, textContent: '', classList: { toggle() {}, add() {}, remove() {} } });
    return els.get(id);
  };
}

test('「验证并保存」是动作按钮：表单选的是 Cloudflare 时来源一并存下，马上取号、重试被拦的邀请卡，记进「已经生效」', async () => {
  const $ = fakeInputs();
  const storage = new Map();
  const retried = [];
  const creds = [];
  const r = await turnBox({
    fns: ['saveCfTurnCredentials', 'noteSettingsApplied'],
    globals: {
      $,
      settingsApplied: new Set(),
      retryBlockedInvite: () => retried.push(1),
      localStorage: { setItem: (k, v) => storage.set(k, String(v)) },
    },
    turnApi: {
      cfSave: async () => ({ configured: true, expiresAt: Date.now() + 20 * HOUR, lastError: null, usage: { usedBytes: 0, limitGB: 900 } }),
      cfCredentials: async (opts) => {
        creds.push(opts);
        return { urls: CF_URLS, username: 'cf-user', credential: 'cf-pass', expiresAt: Date.now() + 23 * HOUR };
      },
    },
  });
  $('set-cf-key').value = 'abcdefgh1234';
  $('set-cf-token').value = 'x'.repeat(20);
  $('set-turn-source-cf').checked = true;
  const result = { textContent: '' };
  await r.ctx.saveCfTurnCredentials({ disabled: false }, result);
  await flush();
  assert.equal(r.S.settings.turnSource, 'cloudflare', '点了取消也不该丢：来源当场存下');
  assert.equal(storage.get('sw.turnSource'), 'cloudflare');
  assert.equal(result.textContent, '已保存，TURN 来源已改成 Cloudflare 自动生成');
  assert.equal(creds.length, 1, '来源切过来了就马上取一组');
  assert.equal(r.S.cfTurn.username, 'cf-user');
  assert.equal(retried.length, 1, '被拦下的邀请卡要重来');
  assert.deepEqual([...vm.runInContext('settingsApplied', r.ctx)], ['保存了 Cloudflare 凭据', 'TURN 来源改成了「Cloudflare 自动生成」']);
  for (const value of storage.values()) assert.ok(!value.includes('x'.repeat(20)), 'Token 进了 localStorage');
});

test('「清除」要点两次：第一次只说后果、按钮换成「确认清除」，过了几秒自己复原；再点才真删，记进「已经生效」', async () => {
  const $ = fakeInputs();
  let cleared = 0;
  const r = await turnBox({
    fns: ['clearCfTurnCredentials', 'noteSettingsApplied'],
    globals: { $, settingsApplied: new Set(), cfClearArmedUntil: 0, CONFIRM_WINDOW_MS: 5000 },
    turnApi: {
      cfClear: async () => {
        cleared++;
        return { configured: false, expiresAt: null, lastError: null };
      },
    },
  });
  r.S.cfTurnState = { configured: true };
  $('set-turn-source-cf').checked = true;
  $('set-relay-only').checked = true;
  const button = { textContent: '清除' };
  const result = { textContent: '' };
  await r.ctx.clearCfTurnCredentials(button, result);
  assert.equal(cleared, 0, '第一次点不删');
  assert.equal(button.textContent, '确认清除');
  assert.match(result.textContent, /^再点一次「确认清除」才会删掉本机保存的 Cloudflare 凭据/);
  assert.match(result.textContent, /「隐藏我的 IP」开着：清除之后新建的连接会被拦下/);
  // 没再点：几秒后按钮复原，下一次点又只是确认
  const timer = r.timers.at(-1);
  assert.equal(timer.ms, 5000);
  timer.fn();
  assert.equal(button.textContent, '清除');
  assert.equal(result.textContent, '');
  await r.ctx.clearCfTurnCredentials(button, result);
  assert.equal(cleared, 0);
  // 确认窗口里再点一次：真删
  await r.ctx.clearCfTurnCredentials(button, result);
  assert.equal(cleared, 1);
  assert.equal(result.textContent, '已清除');
  assert.equal(button.textContent, '清除');
  assert.deepEqual([...vm.runInContext('settingsApplied', r.ctx)], ['清除了 Cloudflare 凭据']);
  // 已经没有凭据了：没什么可删的，不用确认，也不算「已经生效」的改动
  await r.ctx.clearCfTurnCredentials(button, result);
  assert.equal(cleared, 2);
  assert.equal(vm.runInContext('settingsApplied', r.ctx).size, 1);
});

test('设置页的状态行：已配置、有效到几点、出错原因、本月用量和 80% 提醒', async () => {
  const r = await turnBox();
  assert.equal(r.ctx.cfTurnStatusText(), '');
  r.ctx.applyCfTurnState({ configured: false, expiresAt: null, lastError: null, usage: { usedBytes: 0, limitGB: 900 } });
  assert.equal(r.ctx.cfTurnStatusText(), 'Cloudflare TURN：还没配置');
  const at = new Date(2026, 8, 22, 14, 5).getTime();
  r.ctx.applyCfTurnState({ configured: true, expiresAt: Math.max(at, Date.now() + HOUR), lastError: null });
  assert.match(r.ctx.cfTurnStatusText(), /^Cloudflare TURN：已配置，账号有效至 \d{2}:\d{2}$/);
  r.ctx.applyCfTurnState({ configured: true, expiresAt: null, lastError: 'CF_UNAUTHORIZED' });
  assert.equal(r.ctx.cfTurnStatusText(), 'Cloudflare TURN：未授权：Cloudflare 不认这组 Turn Token ID 和 API Token');
  r.ctx.applyCfUsage({ usedBytes: 123.456e9, limitGB: 900 });
  assert.equal(r.ctx.cfUsageText(), '本月已用 123.5 GB / 900 GB');
  r.ctx.applyCfUsage({ usedBytes: 1.234e9, limitGB: 900 });
  assert.equal(r.ctx.cfUsageText(), '本月已用 1.23 GB / 900 GB');
});

/* ============================== 文档 ============================== */

test('两份 README 写了「隐藏我的 IP」和 Cloudflare TURN 的用法；CLAUDE.md 记下了几条不变量', () => {
  const zh = read('README.md');
  const en = read('README.en.md');
  for (const [text, patterns] of [
    [zh, [/隐藏我的 IP/, /Realtime → TURN Server/, /Turn Token ID/, /API Token/, /Billable Usage/, /本机统计/, /不会悄悄退回直连/]],
    [en, [/Hide my IP/, /Realtime → TURN Server/, /Turn Token ID/, /API Token/, /Billable Usage/, /counted (?:on this computer|locally)/, /never quietly falls back/]],
  ]) {
    for (const re of patterns) assert.match(text, re);
  }
  const guide = read('CLAUDE.md');
  const pitfalls = guide.slice(guide.indexOf('## 关键约定与陷阱'));
  assert.match(pitfalls, /setPermissionCheckHandler/);
  assert.match(pitfalls, /media 永远不能放行/);
  assert.match(pitfalls, /\.local/);
  assert.match(pitfalls, /API Token 只在主进程/);
  assert.match(pitfalls, /端口 53/);
  assert.match(pitfalls, /不许悄悄退回直连/);
  assert.match(pitfalls, /CF_QUOTA/);
});
