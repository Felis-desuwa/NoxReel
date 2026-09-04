'use strict';

/**
 * ICE 配置与 SDP 候选处理。
 *
 * 这一层的 bug 表现出来全是同一句「连不上」，没有任何中间线索，所以断言写得细：
 * 兜底 STUN 什么时候加、TURN 展不展开 TCP、去重会不会误删、诊断结论对不对得上。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const load = () => import('../src/renderer/lib/ice.js');

/* ------------------------------ STUN 兜底 ------------------------------ */

test('只填一台 STUN 时自动补兜底服务器', async () => {
  const { buildIceServers, DEFAULT_STUN, FALLBACK_STUN } = await load();
  const list = buildIceServers({ stun: DEFAULT_STUN });
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].urls, [DEFAULT_STUN, ...FALLBACK_STUN]);
});

test('什么都不填也能拿到一份可用的配置', async () => {
  const { buildIceServers, DEFAULT_STUN } = await load();
  const list = buildIceServers({});
  assert.equal(list[0].urls[0], DEFAULT_STUN);
  assert.ok(list[0].urls.length > 1, '默认配置也要有冗余');
});

test('用户自己填了多台就完全按他写的来，不掺兜底', async () => {
  const { buildIceServers, FALLBACK_STUN } = await load();
  const list = buildIceServers({ stun: 'stun:a.example:3478, stun:b.example:3478' });
  assert.deepEqual(list[0].urls, ['stun:a.example:3478', 'stun:b.example:3478']);
  for (const fallback of FALLBACK_STUN) {
    assert.ok(!list[0].urls.includes(fallback), '显式管理列表时不该再塞别的服务器进去');
  }
});

test('换掉默认 STUN 但只填一台时，仍然给他补兜底', async () => {
  const { buildIceServers } = await load();
  const list = buildIceServers({ stun: 'stun:mine.example:3478' });
  assert.equal(list[0].urls[0], 'stun:mine.example:3478', '用户填的排第一');
  assert.ok(list[0].urls.length === 3);
});

/* ------------------------------ TURN 展开 ------------------------------ */

test('turn 地址展开成 UDP 与 TCP 两条', async () => {
  const { expandTurnUrls } = await load();
  assert.deepEqual(expandTurnUrls('turn:relay.example:3478'), [
    'turn:relay.example:3478?transport=udp',
    'turn:relay.example:3478?transport=tcp',
  ]);
});

test('turns 只补 TCP —— 它本来就是 TLS over TCP，没有 UDP 变体', async () => {
  const { expandTurnUrls } = await load();
  assert.deepEqual(expandTurnUrls('turns:relay.example:5349'), ['turns:relay.example:5349?transport=tcp']);
});

test('用户自己写死了 transport 就原样保留，那是明确的意图', async () => {
  const { expandTurnUrls } = await load();
  assert.deepEqual(expandTurnUrls('turn:relay.example:3478?transport=tcp'), [
    'turn:relay.example:3478?transport=tcp',
  ]);
});

test('不是 turn/turns 的地址一律丢掉，不会把 STUN 塞进中继位', async () => {
  const { expandTurnUrls } = await load();
  assert.deepEqual(expandTurnUrls('stun:a.example:3478 http://evil.example'), []);
});

test('没开 TURN 开关时不下发中继配置', async () => {
  const { buildIceServers } = await load();
  const list = buildIceServers({ turnEnabled: false, turnUrl: 'turn:relay.example:3478' });
  assert.equal(list.length, 1, '只该有 STUN 一项');
});

test('开了开关但地址是空的，也不该多出一个空中继项', async () => {
  const { buildIceServers } = await load();
  assert.equal(buildIceServers({ turnEnabled: true, turnUrl: '   ' }).length, 1);
});

test('hasRelay 认得出配置里有没有真的中继', async () => {
  const { buildIceServers, hasRelay } = await load();
  assert.equal(hasRelay(buildIceServers({})), false);
  assert.equal(
    hasRelay(buildIceServers({ turnEnabled: true, turnUrl: 'turn:relay.example:3478', turnUser: 'u', turnPass: 'p' })),
    true
  );
});

/* ---------------------------- SDP 候选精简 ---------------------------- */

// 两台 STUN 对同一个 NAT 映射各报一次：foundation 和 priority 不同，
// 但地址端口完全一样 —— 对端拿去试是同一条路径。
const SDP = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'a=ice-ufrag:abcd',
  'a=candidate:1 1 udp 2113937151 192.168.1.5 54321 typ host generation 0',
  'a=candidate:2 1 udp 1677729535 203.0.113.9 54321 typ srflx raddr 192.168.1.5 rport 54321',
  'a=candidate:3 1 udp 1677729535 203.0.113.9 54321 typ srflx raddr 192.168.1.5 rport 54321',
  'a=candidate:4 1 udp 2113937151 fe80::1234 54322 typ host generation 0',
  'a=candidate:5 1 udp 41885439 198.51.100.7 3478 typ relay raddr 203.0.113.9 rport 54321',
  'a=end-of-candidates',
].join('\r\n');

test('重复的公网映射候选被去掉，其余一条不动', async () => {
  const { pruneSdpCandidates, parseCandidateLine } = await load();
  const { sdp, removed } = pruneSdpCandidates(SDP);
  assert.equal(removed, 2, '一条重复 srflx + 一条 fe80');

  const kept = sdp.split('\r\n').map(parseCandidateLine).filter(Boolean);
  assert.deepEqual(
    kept.map((c) => `${c.type}:${c.address}`),
    ['host:192.168.1.5', 'srflx:203.0.113.9', 'relay:198.51.100.7']
  );
});

test('非候选行一个字节都不动', async () => {
  const { pruneSdpCandidates } = await load();
  const { sdp } = pruneSdpCandidates(SDP);
  for (const line of ['v=0', 'a=ice-ufrag:abcd', 'a=end-of-candidates', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel']) {
    assert.ok(sdp.includes(line), `丢了 ${line}`);
  }
});

test('同地址不同端口不算重复 —— 那是两条真的路径', async () => {
  const { pruneSdpCandidates } = await load();
  const sdp = [
    'a=candidate:1 1 udp 100 203.0.113.9 1111 typ srflx raddr 10.0.0.1 rport 1111',
    'a=candidate:2 1 udp 100 203.0.113.9 2222 typ srflx raddr 10.0.0.1 rport 2222',
  ].join('\r\n');
  assert.equal(pruneSdpCandidates(sdp).removed, 0);
});

test('同地址端口但一个 udp 一个 tcp，也不算重复', async () => {
  const { pruneSdpCandidates } = await load();
  const sdp = [
    'a=candidate:1 1 udp 100 203.0.113.9 1111 typ srflx raddr 10.0.0.1 rport 1111',
    'a=candidate:2 1 tcp 100 203.0.113.9 1111 typ srflx raddr 10.0.0.1 rport 1111 tcptype passive',
  ].join('\r\n');
  assert.equal(pruneSdpCandidates(sdp).removed, 0);
});

test('保留换行风格，LF 的 SDP 不会被换成 CRLF', async () => {
  const { pruneSdpCandidates } = await load();
  const lf = SDP.replace(/\r\n/g, '\n');
  const { sdp } = pruneSdpCandidates(lf);
  assert.ok(!sdp.includes('\r'), 'LF 输入不该冒出 CR');
});

test('空 SDP 不炸', async () => {
  const { pruneSdpCandidates } = await load();
  assert.deepEqual(pruneSdpCandidates(''), { sdp: '', removed: 0 });
  assert.deepEqual(pruneSdpCandidates(null), { sdp: '', removed: 0 });
});

test('精简过的 SDP 只会更短 —— 邀请码不会因为多挂 STUN 而变长', async () => {
  const { pruneSdpCandidates } = await load();
  const { sdp } = pruneSdpCandidates(SDP);
  assert.ok(sdp.length < SDP.length);
});

/* ------------------------------ 候选诊断 ------------------------------ */

test('候选统计分门别类数对', async () => {
  const { summarizeCandidates } = await load();
  const stats = summarizeCandidates(SDP);
  assert.equal(stats.host, 2);
  assert.equal(stats.srflx, 2);
  assert.equal(stats.relay, 1);
  assert.equal(stats.total, 5);
});

test('mDNS 候选会被单独数出来', async () => {
  const { summarizeCandidates } = await load();
  const stats = summarizeCandidates(
    'a=candidate:1 1 udp 100 3d1f0c6e-1111-2222-3333-444455556666.local 5000 typ host'
  );
  assert.equal(stats.mdns, 1);
  assert.equal(stats.host, 1);
});

test('一个候选都没有 → 说清楚是网络被隔离', async () => {
  const { diagnoseCandidates, summarizeCandidates } = await load();
  const d = diagnoseCandidates(summarizeCandidates(''));
  assert.equal(d.level, 'bad');
  assert.match(d.text, /防火墙|隔离/);
});

test('只有局域网候选 → 指向 STUN 不通，而不是笼统地叫人配 TURN', async () => {
  const { diagnoseCandidates, summarizeCandidates } = await load();
  const d = diagnoseCandidates(summarizeCandidates('a=candidate:1 1 udp 100 192.168.1.5 5000 typ host'));
  assert.equal(d.level, 'bad');
  assert.match(d.text, /STUN/);
});

test('配了 TURN 却没有中继候选 → 直说凭据可能不对', async () => {
  const { diagnoseCandidates, summarizeCandidates } = await load();
  const stats = summarizeCandidates('a=candidate:1 1 udp 100 203.0.113.9 5000 typ srflx raddr 10.0.0.1 rport 5000');
  const d = diagnoseCandidates(stats, { turnConfigured: true });
  assert.equal(d.level, 'warn');
  assert.match(d.text, /用户名密码|地址、端口/);
});

test('有公网地址没中继（也没配 TURN）→ 建议配中继', async () => {
  const { diagnoseCandidates, summarizeCandidates } = await load();
  const stats = summarizeCandidates('a=candidate:1 1 udp 100 203.0.113.9 5000 typ srflx raddr 10.0.0.1 rport 5000');
  const d = diagnoseCandidates(stats, { turnConfigured: false });
  assert.equal(d.level, 'warn');
  assert.match(d.text, /TURN/);
});

test('候选齐全时不再危言耸听', async () => {
  const { diagnoseCandidates, summarizeCandidates } = await load();
  assert.equal(diagnoseCandidates(summarizeCandidates(SDP), { turnConfigured: true }).level, 'ok');
});

/* --------------------------- 两端共用同一份 --------------------------- */

test('桌面端与 Android 端用的是同一份 ice.js', () => {
  const a = fs.readFileSync(path.join(__dirname, '../src/renderer/lib/ice.js'), 'utf8');
  const b = fs.readFileSync(
    path.join(__dirname, '../android/app/src/main/assets/js/ice.js'),
    'utf8'
  );
  assert.equal(a.replace(/\r\n/g, '\n'), b.replace(/\r\n/g, '\n'), 'ICE 策略两端必须一致，否则一端连得上另一端连不上');
});

test('两端都不再把单台 STUN 写死在编排层', () => {
  for (const f of ['../src/renderer/app.js', '../android/app/src/main/assets/js/app-android.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const iceFn = src.slice(src.indexOf('function iceServers()'));
    const body = iceFn.slice(0, iceFn.indexOf('\n}'));
    assert.ok(
      !/stun:stun\.l\.google\.com/.test(body),
      `${f} 的 iceServers() 里还写死着单台 STUN，冗余就失效了`
    );
    assert.match(body, /buildIceServers/);
  }
});
