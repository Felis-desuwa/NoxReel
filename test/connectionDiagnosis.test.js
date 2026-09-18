'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const load = () => import('../src/renderer/lib/ice.js');
const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const srflx = (over = {}) => ({
  type: 'srflx',
  component: 1,
  protocol: 'udp',
  relatedAddress: '10.0.0.5',
  relatedPort: 50000,
  address: '203.0.113.9',
  port: 40001,
  ...over,
});

/* --------------------------- 候选行解析 --------------------------- */

test('解析出 raddr 和 rport —— 判对称 NAT 全靠这个本地基地址', async () => {
  const { parseCandidateLine } = await load();
  // 真机抓的格式（本地地址已替换成文档用地址）
  const c = parseCandidateLine(
    'a=candidate:1350206125 1 udp 1685790463 203.0.113.9 55094 typ srflx raddr 10.0.0.203 rport 55094 generation 0 network-id 2 network-cost 10'
  );
  assert.equal(c.type, 'srflx');
  assert.equal(c.relatedAddress, '10.0.0.203');
  assert.equal(c.relatedPort, 55094);
});

test('host 候选没有 raddr，字段给 null 而不是 undefined 混进分组键', async () => {
  const { parseCandidateLine } = await load();
  const c = parseCandidateLine('a=candidate:2778852834 1 udp 2122260223 192.168.1.5 55093 typ host generation 0');
  assert.equal(c.relatedAddress, null);
  assert.equal(c.relatedPort, null);
  // 原有七个字段一个都不能变，去重键和发送去重都依赖它们
  assert.equal(c.foundation, '2778852834');
  assert.equal(c.component, 1);
  assert.equal(c.protocol, 'udp');
  assert.equal(c.address, '192.168.1.5');
  assert.equal(c.port, 55093);
});

test('tcptype 之类的尾部属性不影响解析', async () => {
  const { parseCandidateLine } = await load();
  const c = parseCandidateLine('a=candidate:3681423226 1 tcp 1518280447 192.168.1.5 9 typ host tcptype active generation 0');
  assert.equal(c.protocol, 'tcp');
  assert.equal(c.type, 'host');
});

/* --------------------------- 对称 NAT 判定 --------------------------- */

/**
 * 原理：几台 STUN 各报一次「你的公网端点」。锥形 NAT 给同一个本地端口的映射不随目标变，
 * 几台看到的一模一样，Chromium 去重后只剩一条；对称 NAT 按目标分配映射，去重合并不掉。
 * 实测这台机器配了 3 台 STUN 却只冒出 1 条 srflx，正是锥形 NAT 的样子。
 */
test('同一个本地基地址映射出两个不同公网端口 → 对称 NAT', async () => {
  const { detectSymmetricNat } = await load();
  const got = detectSymmetricNat([srflx({ port: 40001 }), srflx({ port: 40002 })]);
  assert.equal(got.kind, 'symmetric');
  assert.equal(got.mappings.length, 2);
});

test('出口 IP 也随目标变 → 多出口 NAT 网关，比对称还难打', async () => {
  const { detectSymmetricNat } = await load();
  const got = detectSymmetricNat([
    srflx({ address: '203.0.113.9', port: 40001 }),
    srflx({ address: '198.51.100.4', port: 40002 }),
  ]);
  assert.equal(got.kind, 'multi-exit');
});

/**
 * 这是整组里最重要的一条。多网卡（有线 + 无线）、VPN 虚拟网卡、Hyper-V 的 vEthernet
 * 都会产生不同的本地基地址，各自映射出不同的公网端口 —— 跨 base 比较必然把
 * 完全正常的机器读成对称 NAT。实测这台开发机就有 5 个本地地址。
 */
test('多网卡不误报：不同基地址之间绝不比较', async () => {
  const { detectSymmetricNat } = await load();
  assert.equal(
    detectSymmetricNat([
      srflx({ relatedAddress: '10.0.0.203', relatedPort: 55094, port: 40001 }),
      srflx({ relatedAddress: '172.31.192.1', relatedPort: 55093, port: 40002 }),
    ]),
    null
  );
  // 同一张网卡的不同本地端口也是不同的映射，同样不能比
  assert.equal(
    detectSymmetricNat([
      srflx({ relatedPort: 50000, port: 40001 }),
      srflx({ relatedPort: 50001, port: 40002 }),
    ]),
    null
  );
});

test('不跨协议、不跨分量、不跨地址族比较', async () => {
  const { detectSymmetricNat } = await load();
  assert.equal(detectSymmetricNat([srflx({ protocol: 'udp' }), srflx({ protocol: 'tcp', port: 40002 })]), null);
  assert.equal(detectSymmetricNat([srflx({ component: 1 }), srflx({ component: 2, port: 40002 })]), null);
  // v4 和 v6 是两条独立的路，基地址不同天然隔开
  assert.equal(
    detectSymmetricNat([
      srflx({ relatedAddress: '10.0.0.5', address: '203.0.113.9', port: 40001 }),
      srflx({ relatedAddress: '2001:db8::1', address: '2001:db8::2', port: 40002 }),
    ]),
    null
  );
});

/**
 * 因为 Chromium 会去重，「只有一条 srflx」既可能是锥形 NAT，也可能是只有一台 STUN
 * 回了话 —— 两者长得一模一样。所以这个判定只能单向成立，绝不能输出「你不是对称 NAT」。
 */
test('证据不足时返回 null，不给「不是对称 NAT」的结论', async () => {
  const { detectSymmetricNat } = await load();
  assert.equal(detectSymmetricNat([srflx()]), null);
  assert.equal(detectSymmetricNat([]), null);
  assert.equal(detectSymmetricNat(null), null);
  // host 候选没有基地址，不参与判定
  assert.equal(detectSymmetricNat([{ type: 'host', address: '10.0.0.5', port: 1 }]), null);
  // 基地址被抹成 0.0.0.0 时同样不能用 —— 那会把所有网卡归成一桶
  assert.equal(
    detectSymmetricNat([
      srflx({ relatedAddress: '0.0.0.0', port: 40001 }),
      srflx({ relatedAddress: '0.0.0.0', port: 40002 }),
    ]),
    null
  );
});

test('判定接进诊断，给的是确定结论而不是「可能」', async () => {
  const { diagnoseCandidates } = await load();
  const stats = { host: 1, srflx: 1, prflx: 0, relay: 0, mdns: 0, total: 2 };
  const plain = diagnoseCandidates(stats, {});
  const sym = diagnoseCandidates(stats, { symmetric: { kind: 'symmetric', mappings: [] } });
  assert.match(plain.text, /双方都在严格 NAT/, '没判出来时还是原来那句笼统的话');
  assert.match(sym.text, /打洞必定失败/);
  assert.equal(sym.level, 'bad');
  // 已经有中继了就别再吓唬人 —— 对称 NAT 配了 TURN 照样连得上
  const withRelay = diagnoseCandidates(
    { ...stats, relay: 1, total: 3 },
    { symmetric: { kind: 'symmetric', mappings: [] }, turnConfigured: true }
  );
  assert.equal(withRelay.level, 'ok');
});

/* --------------------------- 候选错误 --------------------------- */

test('TURN 的凭据错和连不上是两句话，不再含混成一句', async () => {
  const { describeCandidateError } = await load();
  assert.match(describeCandidateError({ url: 'turn:r.example:3478', errorCode: 401 }).text, /用户名或密码/);
  assert.match(describeCandidateError({ url: 'turn:r.example:3478', errorCode: 403 }).text, /用户名或密码/);
  assert.match(describeCandidateError({ url: 'turn:r.example:3478', errorCode: 701 }).text, /连不上/);
  assert.match(
    describeCandidateError({ url: 'turn:r.example:3478', errorCode: 0, errorText: 'Connection refused' }).text,
    /连不上/
  );
  assert.match(describeCandidateError({ url: 'stun:s.example:3478', errorCode: 701 }).text, /STUN/);
});

test('438 是正常重试，不报给用户；认不出的码退回笼统文案', async () => {
  const { describeCandidateError } = await load();
  assert.equal(describeCandidateError({ url: 'turn:r.example:3478', errorCode: 438 }), null);
  assert.equal(describeCandidateError(null), null);
  // 认不出的 url 不硬安一个原因 —— 说错方向比不说更费时间
  assert.equal(describeCandidateError({ url: 'https://x.example', errorCode: 500 }), null);
  // TURN 上认不出的码要如实报码，不能冒充成凭据问题
  const odd = describeCandidateError({ url: 'turn:r.example:3478', errorCode: 599, errorText: 'weird' });
  assert.doesNotMatch(odd.text, /用户名或密码/);
  assert.match(odd.text, /599/);
});

/* --------------------------- TURN 地址校验 --------------------------- */

test('漏了 turn: 前缀自动补上 —— 这是最常见的写法错误', async () => {
  const { normalizeTurnInput, expandTurnUrls } = await load();
  const got = normalizeTurnInput('relay.example:3478');
  assert.deepEqual(got.urls, ['turn:relay.example:3478']);
  assert.deepEqual(got.fixed, ['turn:relay.example:3478']);
  assert.deepEqual(got.invalid, []);
  // 补完之后必须真的能被 expandTurnUrls 接受，否则等于没补
  assert.ok(expandTurnUrls(got.urls.join(' ')).length > 0);
});

test('认不出的地址要报出来，不能像以前那样静默丢掉', async () => {
  const { normalizeTurnInput } = await load();
  assert.deepEqual(normalizeTurnInput('https://relay.example').invalid, ['https://relay.example']);
  // stun: 不是中继，补个前缀也变不成中继
  assert.deepEqual(normalizeTurnInput('stun:a.example:3478').invalid, ['stun:a.example:3478']);
  assert.deepEqual(normalizeTurnInput('turn:ok.example:3478').invalid, []);
  // 彻底不像地址的东西走的是最后那条兜底分支，同样要报出来
  assert.deepEqual(normalizeTurnInput('!!!').invalid, ['!!!']);
  assert.deepEqual(normalizeTurnInput('!!!').urls, []);
});

/* --------------------------- 接线 --------------------------- */

test('诊断接到了极简模式的两处失败界面，而不是只写进看不见的日志', () => {
  const app = read('src', 'renderer', 'app.js');
  // 加入方停在准备页，房间视图是隐藏的 —— #event-log 就在那里面
  assert.match(app, /const advice = connectionAdvice\(peer\);\r?\n\s*\$\('prep-note'\)\.textContent/);
  // 房主侧的握手看门狗
  assert.match(app, /const advice = retry \? connectionAdvice\(peer\) : null;/);
});

/**
 * 顺序：候选错误是服务器亲口说的（「401，凭据不对」），候选统计只能反推
 * （「配了 TURN 却没 relay，三件事之一错了」）。有确凿信息就别去推断。
 */
test('候选错误优先于候选统计 —— 它直接说出是哪台服务器错在哪', async () => {
  const { adviseConnection } = await load();
  const stats = { host: 1, srflx: 1, prflx: 0, relay: 0, mdns: 0, total: 2 };
  // 只有统计：只能给那句笼统的
  assert.match(adviseConnection({ stats, turnConfigured: true }).text, /地址、端口或用户名密码大概率有一项不对/);
  // 有候选错误：直接说是凭据
  const precise = adviseConnection({
    stats,
    turnConfigured: true,
    candidateErrors: [{ url: 'turn:r.example:3478', errorCode: 401 }],
  });
  assert.match(precise.text, /拒绝了用户名或密码/);
  // 认不出的错误码不能把结论盖掉，要退回统计那条路
  assert.match(
    adviseConnection({ stats, turnConfigured: true, candidateErrors: [{ url: 'turn:r.example:3478', errorCode: 438 }] })
      .text,
    /地址、端口或用户名密码大概率有一项不对/
  );
  // 候选也要真的传进去参与判定
  assert.match(
    adviseConnection({ stats, candidates: [srflx({ port: 40001 }), srflx({ port: 40002 })] }).text,
    /打洞必定失败/
  );
});

test('编排层只负责凑输入，信令模式下用攒下来的候选', () => {
  const app = read('src', 'renderer', 'app.js');
  const fn = app.slice(app.indexOf('function connectionAdvice('), app.indexOf('function collectDiagnostics('));
  assert.ok(fn.length > 300, `切出来的函数太短（${fn.length} 字符）`);
  assert.match(fn, /return adviseConnection\(\{/);
  assert.match(fn, /candidateErrors: peer\?\.candidateErrors \|\| \[\],/);
  // 信令模式下 SDP 里没有候选行，得用一条条攒下来的那份
  assert.match(fn, /peer\?\.localCandidates\?\.length/);
});

test('peer 会攒候选和候选错误，且都有上限', () => {
  const peer = read('src', 'renderer', 'lib', 'peer.js');
  // 必须是真的挂在 pc 上的那个事件名 —— 改一个字它就永远不触发，而源码里还留着这串字
  assert.match(peer, /this\.pc\.onicecandidateerror = \(e\) => \{/);
  assert.match(peer, /this\.localCandidates\.length < 64/);
  assert.match(peer, /this\.candidateErrors\.length >= 8/);
  // 同一条错误会反复来，要去重
  assert.match(peer, /this\.candidateErrors\.some\(\(x\) => x\.key === key\)/);
});

test('诊断信息不含文件路径和片名', () => {
  const app = read('src', 'renderer', 'app.js');
  const fn = app.slice(app.indexOf('function collectDiagnostics('), app.indexOf('function copyDiagnosticsButton('));
  assert.ok(fn.length > 300);
  for (const leak of ['S.filePath', 'roomFile', 'manifest.name', 'S.manifest.name']) {
    assert.ok(!fn.includes(leak), `诊断信息里不该出现 ${leak}`);
  }
  assert.match(fn, /env\.version/);
  assert.match(fn, /对称NAT判定/);
});

test('桌面端与 Android 端的 ice.js 仍然逐字节一致', () => {
  const a = read('src', 'renderer', 'lib', 'ice.js');
  const b = read('android', 'app', 'src', 'main', 'assets', 'js', 'ice.js');
  assert.equal(a.replace(/\r\n/g, '\n'), b.replace(/\r\n/g, '\n'));
});
