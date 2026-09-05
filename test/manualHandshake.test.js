'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');

/**
 * 极简模式打洞可能一直连不上（对方在严格 NAT 后面，或邀请链接放太久、里面的网络地址
 * 已过期）。「正在打洞」这行字曾经只有 peer-authenticated 一条路能改，失败时没人收尾，
 * 界面就永远停在那里。失败、断开、超时三条路都必须有结局。
 */
test('房主侧的极简握手有失败、断开和超时三条收尾路径', () => {
  assert.match(app, /function watchManualHandshake\(/);
  assert.match(app, /watchManualHandshake\(peer, status\);/);

  const body = app.slice(app.indexOf('function watchManualHandshake('), app.indexOf('async function acceptManualAnswer('));
  assert.match(body, /S\.swarm\.on\('peer-authenticated'/, '连上了要收尾');
  assert.match(body, /peer\.on\('failed'/, '打洞失败要收尾');
  assert.match(body, /peer\.on\('close'/, '握手前断开要收尾');
  assert.match(body, /setTimeout\(/, '一直停在 checking 也要收尾');
  assert.match(body, /MANUAL_HANDSHAKE_TIMEOUT_MS/);
  // 收尾时要把失效连接摘掉并备好新链接，否则用户没有下一步可走。
  assert.match(body, /S\.swarm\.removePeer\(peer\.peerId\)/);
  assert.match(body, /inviteViaManual\(text\)/);
});

test('应答链接重复点开时给出提示而不是抛到无人接住的地方', () => {
  assert.doesNotMatch(app, /throw new Error\('当前没有等待应答的零服务器邀请'\)/);
  assert.match(app, /这条邀请已经用过或已失效/);
});

test('访客侧在房主粘贴前探测失败也能重新生成应答链接', () => {
  const body = app.slice(app.indexOf('async function joinViaManual('), app.indexOf('async function joinViaServer('));
  assert.match(body, /peer\.on\('failed'/, '访客侧同样不能永远停在等待');
  assert.match(body, /重新生成应答链接/);
  assert.match(body, /joinViaManual\(payload\)/, '重试要能用同一份邀请重开一条连接');
  assert.match(body, /S\.swarm\.removePeer\(payload\.from\)/, '重试前要摘掉上一条死连接');
});

/**
 * 只挂 'failed' 不够。对方的 NAT 如果连出口 IP 都随目标变（云上的多出口 NAT 网关就是
 * 这样：同一个本地套接字问两台 STUN，得到两个不同的公网 IP 和端口），ICE 会一直停在
 * checking 永远不进 failed，那条 handler 就永远不触发。
 *
 * 实测过一次：房主端按 MANUAL_HANDSHAKE_TIMEOUT_MS 五十秒就给出了结论并备好新邀请链接，
 * 加入方这边十二分钟仍然停在「等待房主打开应答链接」，一个字都没有。
 */
test('访客侧在 ICE 永远不进入 failed 时也有定时兜底', () => {
  const body = app.slice(app.indexOf('async function joinViaManual('), app.indexOf('async function joinViaServer('));
  assert.match(body, /setTimeout\(/, '只挂 failed 不够，ICE 可能一直停在 checking');
  assert.match(body, /MANUAL_JOIN_WAIT_TIMEOUT_MS/);
  assert.match(body, /S\.swarm\.on\('peer-authenticated'/, '连上了要把定时器撤掉');
  assert.match(body, /clearTimeout\(joinWaitTimer\)/);
  assert.match(body, /还没能连上房主/, '兜底要给用户一个明确结论');
  assert.match(body, /TURN/, '并且要告诉用户下一步能做什么');
  // 用户点过「重新生成应答链接」之后，旧连接的定时器不能盖掉新界面。
  assert.match(body, /S\.swarm\?\.peers\?\.get\(payload\.from\) !== peer/);
});

/**
 * 房主是粘完应答才开始计时的，那一刻双方都拿到了对方的 SDP，45 秒足够打洞。
 * 加入方没有这个时刻可用：应答链接一生成它就在探测，而房主可能过好几分钟才粘贴，
 * 也就是说它分不清「房主还没粘」和「粘了但没打通」。时限必须给足人去转发链接的时间，
 * 否则人还在发消息就被判失败了。
 */
test('访客侧的等待时限明显长于房主侧的握手超时', () => {
  const host = /const MANUAL_HANDSHAKE_TIMEOUT_MS = ([\d_]+);/.exec(app);
  const join = /const MANUAL_JOIN_WAIT_TIMEOUT_MS = ([\d_]+);/.exec(app);
  assert.ok(host && join, '两个时限都要有名字，不能写成裸数字');
  const hostMs = Number(host[1].replace(/_/g, ''));
  const joinMs = Number(join[1].replace(/_/g, ''));
  assert.ok(joinMs >= hostMs * 2, `加入方时限 ${joinMs}ms 必须明显长于房主侧 ${hostMs}ms`);
});

/**
 * 安卓端这条路以前连 'failed' 都没挂：生成完应答链接就再没有任何反馈，房主那边早已
 * 超时放弃，手机上还停在「发回给房主后对方点开即可」，用户不知道该继续等还是该重来。
 */
test('安卓观众端的极简加入同样有失败和超时两条收尾路径', () => {
  const android = fs.readFileSync(
    path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'js', 'app-android.js'),
    'utf8'
  );
  assert.match(android, /peer\.on\('failed'/, '安卓端探测失败也要说一声');
  assert.match(android, /MANUAL_JOIN_WAIT_TIMEOUT_MS/, 'ICE 停在 checking 时要有定时兜底');
  assert.match(android, /clearTimeout\(joinWaitTimer\)/);
  assert.match(android, /S\.swarm\.on\('peer-authenticated'/, '连上了要把定时器撤掉');
  assert.match(android, /等了几分钟还是没连上房主/);
  assert.match(android, /TURN/);

  // 两端时限必须一样，否则同一场放映里两个人得到的结论时间不同，很难对着排查。
  const desktopMs = /const MANUAL_JOIN_WAIT_TIMEOUT_MS = ([\d_]+);/.exec(app)[1];
  const androidMs = /const MANUAL_JOIN_WAIT_TIMEOUT_MS = ([\d_]+);/.exec(android)[1];
  assert.equal(androidMs, desktopMs, '桌面端和安卓端的等待时限要一致');
});

/**
 * inviteViaManual 的第一个参数是要显示给用户的提示语。直接当 onclick 处理器挂上去，
 * 实参就成了 PointerEvent，会被原样渲染成「[object PointerEvent]」贴在邀请区顶上。
 */
test('生成零服务器邀请的按钮不会把事件对象当提示语传进去', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  assert.doesNotMatch(
    app,
    /\$\('inv-manual'\)\.onclick = inviteViaManual;/,
    '不能把函数本身直接当处理器挂上去'
  );
  assert.match(app, /\$\('inv-manual'\)\.onclick = \(\) => inviteViaManual\(\);/);
  assert.match(
    app,
    /if \(typeof notice !== 'string'\) notice = '';/,
    '函数内也要挡一道，防止别处再犯'
  );
});
