'use strict';

/**
 * 安卓端加固（0.7.5 审查）的回归测试。
 *
 * 1. 已在房间里再点 noxreel:// 深链接：不能拆掉活连接、不能换掉房主；加入过程中不重入。
 * 2. 配置变更（深色模式、字体、语言、键盘……）不重建 Activity。
 * 3. 在线视频只连公网：每一次建连都检查（重定向、HLS/DASH 子资源、DNS 重绑定）。
 * 4. 大厅显示版本号。
 * 5. DoS：桥方法的超大参数、清单尺寸、base64 长度、数据源越界、深链接洪水、日志刷屏、WebView 设置。
 *
 * JS 部分用假 DOM 和假 Native 把 app-android.js 整个跑起来（同 androidFollow.test.js 的做法）；
 * Kotlin 部分沿用 androidNative/androidStoreKt 的办法：纯函数现场翻成 JS 执行，断言真实行为，
 * 只有跑不起来的（建连、线程）才退回结构断言。NetGuard 的建连逻辑另在桌面 JVM 上对着本机
 * 服务器实测过（见任务报告），这里守的是那几处一改就失效的位置。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { fakeDocument } = require('./helpers/androidDom.js');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const KT = 'android/app/src/main/java/com/syncwatch/app';
const netSrc = read(`${KT}/NetGuard.kt`);
const storeSrc = read(`${KT}/Store.kt`);
const activitySrc = read(`${KT}/MainActivity.kt`);
const bridgeSrc = read(`${KT}/NativeBridge.kt`);
const playerSrc = read(`${KT}/SyncPlayer.kt`);
const growingSrc = read(`${KT}/GrowingDataSource.kt`);
const httpSrc = read(`${KT}/PublicHttpDataSource.kt`);
const manifestXml = read('android/app/src/main/AndroidManifest.xml');
const indexHtml = read('android/app/src/main/assets/index.html');
const shimSrc = read('android/app/src/main/assets/js/native-shim.js');

const ASSETS = path.join(root, 'android', 'app', 'src', 'main', 'assets', 'js');
const assetUrl = (file) => pathToFileURL(path.join(ASSETS, file)).href;

/* --------------------- Kotlin 子集 → JS 的最小翻译器 --------------------- */

/**
 * 按名字取 Kotlin 函数，返回 {params, body, kind}。块体数花括号；表达式体取到
 * 「括号配平、且这一行不是以 || / && 结尾」的那一行为止（多行的布尔表达式也取得全）。
 */
function kotlinFun(src, name) {
  const head = new RegExp(`\\bfun\\s+${name}\\s*\\(`).exec(src);
  if (!head) return null;
  let i = head.index + head[0].length;
  const paramStart = i;
  let depth = 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') depth--;
    i++;
  }
  const params = src
    .slice(paramStart, i - 1)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(':')[0].trim());
  while (i < src.length && src[i] !== '=' && src[i] !== '{') i++;
  if (src[i] === '{') {
    let d = 0;
    for (let p = i; p < src.length; p++) {
      if (src[p] === '{') d++;
      else if (src[p] === '}' && --d === 0) return { params, body: src.slice(i + 1, p), kind: 'block' };
    }
    return null;
  }
  let p = i + 1;
  let d = 0;
  let q = p;
  for (; q < src.length; q++) {
    const c = src[q];
    if (c === '(' || c === '{') d++;
    else if (c === ')' || c === '}') d--;
    else if (c === '\n' && d === 0) {
      const sofar = src.slice(p, q).trim();
      if (sofar && !/(\|\||&&)$/.test(sofar)) break;
    }
  }
  return { params, body: src.slice(p, q).trim(), kind: 'expr' };
}

function kotlinToJs(body) {
  return body
    .replace(/\r/g, '')
    .replace(/\b(?:val|var)\s+/g, 'let ')
    .replace(/\bfor \((\w+) in (.+?) until (.+?)\)/g, 'for (let $1 = $2; $1 < $3; $1++)')
    .replace(/\.size\b/g, '.length')
    .replace(/ and /g, ' & ')
    .replace(/\bMath\.floorDiv\(/g, 'floorDiv(')
    .replace(/\.toLong\(\)/g, '')
    .replace(/(\w+)\.startsWith\(("[^"]*"), ignoreCase = true\)/g, '$1.toLowerCase().startsWith($2)')
    .replace(/return if \((.+)\) (\w+) else (\w+)/g, 'return ($1) ? $2 : $3');
}

const floorDiv = (a, b) => Math.floor(a / b);

/** 把 Kotlin 函数翻成 JS 函数；extra 是函数体里要用到的其他名字（按名字传进去）。 */
function translate(src, name, extra = {}) {
  const fn = kotlinFun(src, name);
  assert.ok(fn, `${name} 不见了`);
  const body = kotlinToJs(fn.kind === 'expr' ? `return ${fn.body}` : fn.body);
  const names = Object.keys(extra);
  // eslint-disable-next-line no-new-func
  const compiled = new Function(...fn.params, ...names, body);
  return (...args) => compiled(...args, ...names.map((n) => extra[n]));
}

/** 取 Kotlin 里 `const val NAME = 表达式` 的值（只认纯算术）。 */
function kotlinConst(src, name) {
  const m = new RegExp(`const val ${name}\\s*=\\s*([\\d\\s*+_L]+)`).exec(src);
  assert.ok(m, `${name} 不见了`);
  // eslint-disable-next-line no-new-func
  return new Function(`return ${m[1].replace(/_/g, '').replace(/L/g, '')}`)();
}

/* ------------------------- IPv4 / IPv6 → 字节 ------------------------- */

function ipBytes(ip) {
  if (!ip.includes(':')) return ip.split('.').map(Number);
  const groupsOf = (s) =>
    (s ? s.split(':') : []).flatMap((g) => {
      if (!g.includes('.')) return [g];
      const [a, b, c, d] = g.split('.').map(Number);
      return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
    });
  const [head, tail] = ip.split('::');
  const h = groupsOf(head);
  const t = tail === undefined ? [] : groupsOf(tail);
  const groups = [...h, ...Array(tail === undefined ? 0 : 8 - h.length - t.length).fill('0'), ...t];
  return groups.flatMap((g) => {
    const v = parseInt(g, 16);
    return [v >> 8, v & 0xff];
  });
}

test('测试自己的地址解析没写错', () => {
  assert.deepEqual(ipBytes('::1'), [...Array(15).fill(0), 1]);
  assert.deepEqual(ipBytes('::ffff:10.0.0.1'), [...Array(10).fill(0), 0xff, 0xff, 10, 0, 0, 1]);
  assert.deepEqual(ipBytes('64:ff9b::a00:1').slice(0, 4), [0x00, 0x64, 0xff, 0x9b]);
});

/* ============================== ③ 只连公网 ============================== */

let netGuardCache = null;
function netGuard() {
  if (netGuardCache) return netGuardCache;
  const isPrivateV4 = translate(netSrc, 'isPrivateV4');
  const isZero = translate(netSrc, 'isZero');
  const isPrivateBytes = translate(netSrc, 'isPrivateBytes', { isPrivateV4, isZero });
  netGuardCache = { isPrivate: (ip) => isPrivateBytes(ipBytes(ip)) };
  return netGuardCache;
}

test('私网判断：IPv4 的局域网、回环、链路本地、CGNAT、组播、保留段都算内网', () => {
  const { isPrivate } = netGuard();
  for (const ip of [
    '10.0.0.1', '127.0.0.1', '0.0.0.0', '192.168.1.1', '172.16.0.1', '172.31.255.255', '100.64.0.1',
    '169.254.169.254', '224.0.0.1', '239.255.255.250', '255.255.255.255', '198.18.0.1', '192.0.2.1',
  ]) {
    assert.equal(isPrivate(ip), true, `${ip} 应该算内网`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '203.0.114.1']) {
    assert.equal(isPrivate(ip), false, `${ip} 是公网地址`);
  }
});

test('私网判断：IPv4 映射的 IPv6、链路本地、ULA、NAT64/6to4 里夹带的内网 IPv4 都认得出来', () => {
  const { isPrivate } = netGuard();
  const privateOnes = {
    '::ffff:192.168.1.1': 'IPv4 映射地址按内嵌的 IPv4 算',
    '::ffff:127.0.0.1': 'IPv4 映射的回环',
    '::1': '回环',
    '::': '未指定地址',
    '::7f00:1': '早已废弃的 IPv4 兼容地址',
    'fe80::1': '链路本地',
    'febf::1': '链路本地的上沿',
    'fec0::1': '已废弃的站点本地',
    'fc00::1': 'ULA',
    'fd12:3456::1': 'ULA（fd 开头）',
    'ff02::1': '组播',
    '64:ff9b::a00:1': 'NAT64 里夹带 10.0.0.1',
    '64:ff9b:1::1': '本地 NAT64',
    '2002:c0a8:101::1': '6to4 里夹带 192.168.1.1',
    '2001:db8::1': '文档地址',
    '2001::1': 'Teredo',
  };
  for (const [ip, why] of Object.entries(privateOnes)) assert.equal(isPrivate(ip), true, `${ip}：${why}`);
  for (const ip of ['2001:4860:4860::8888', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1']) {
    assert.equal(isPrivate(ip), false, `${ip} 是公网地址（纯 IPv6 的移动网络上访问 IPv4 站点都走 NAT64）`);
  }
});

test('在线视频的数据源换成了逐次建连检查的 PublicHttpDataSource', () => {
  const load = kotlinFun(playerSrc, 'loadRemote');
  assert.ok(load, 'SyncPlayer.loadRemote 不见了');
  assert.match(load.body, /PublicHttpDataSource\.Factory\(headers\)/, '在线视频没走 PublicHttpDataSource');
  assert.doesNotMatch(playerSrc, /DefaultHttpDataSource/, 'DefaultHttpDataSource 自己跟重定向、自己解析 DNS，检查插不进去');
  const open = kotlinFun(httpSrc, 'open');
  assert.match(open.body, /NetGuard\.open\(/, 'PublicHttpDataSource 没把建连交给 NetGuard');
  const prepare = kotlinFun(httpSrc, 'prepare');
  assert.match(prepare.body, /"Accept-Encoding", "identity"/, '透明 gzip 会让长度和 Range 对不上');
  assert.match(prepare.body, /equals\("Host", ignoreCase = true\)/, 'ExoPlayer 给的请求头不能改写 Host');
});

test('NetGuard.open：重定向自己一跳一跳地跟，每跳都重新检查，跨协议不跟，有次数上限', () => {
  const open = kotlinFun(netSrc, 'open');
  assert.ok(open, 'NetGuard.open 不见了');
  assert.match(open.body, /while \(true\)[\s\S]*connectOnce\(url, prepare, guard\)/, '每一跳都得经 connectOnce');
  assert.match(open.body, /\+\+hops > MAX_REDIRECTS/, '重定向没有次数上限');
  assert.match(open.body, /next\.protocol\.equals\(scheme, ignoreCase = true\)/, '没拦跨协议重定向');
  assert.match(open.body, /URL\(url, location\)/, '相对地址要按当前这一跳解析');

  const once = kotlinFun(netSrc, 'connectOnce');
  assert.match(once.body, /instanceFollowRedirects = false/, '重定向又交给系统自动跟了：跳到内网也照走');
  const check = once.body.indexOf('guard.resolvePublic(url.host)');
  const connect = once.body.indexOf('conn.connect()');
  assert.ok(check >= 0 && connect > check, '得先查地址再建连');
  assert.equal((once.body.match(/Proxy\.NO_PROXY/g) || []).length, 2, '经代理时连上的是代理，看不到对面是谁');
  assert.match(once.body, /URL\(url\.protocol, literal\(address\), url\.port, url\.file\)/, '明文 http 没钉住检查过的 IP：连接时会再解析一次 DNS');
  assert.match(once.body, /setRequestProperty\("Host", hostHeader\(url\)\)/, '钉 IP 之后 Host 头得照填域名');
  assert.match(once.body, /sslSocketFactory = guard\.sslSocketFactory/, 'https 没装套 TLS 前核对对端的工厂');
  assert.ok(once.body.indexOf('prepare(conn)') > once.body.indexOf('setRequestProperty("Host"'), '调用方的请求头不能盖掉 Host');
});

test('解析结果里只要有一个内网地址就不连；https 在套 TLS 前核对 TCP 对端', () => {
  const resolve = kotlinFun(netSrc, 'resolvePublic');
  assert.match(resolve.body, /addresses\.any\(blocked\)/, '「挑那个公网的连」挡不住把内网地址混进解析结果的重绑定');
  const layered = /override fun createSocket\(s: Socket, host: String\?, port: Int, autoClose: Boolean\): Socket \{([\s\S]*?)\n {8}\}/.exec(netSrc);
  assert.ok(layered, '没有「在已连上的 socket 上套 TLS」那个入口');
  const body = layered[1];
  assert.ok(body.indexOf('s.inetAddress') >= 0 && body.indexOf('guard.blocked(remote)') >= 0, '没看 TCP 对端地址');
  assert.ok(body.indexOf('guard.blocked(remote)') < body.indexOf('delegate.createSocket'), '得先核对再套 TLS');
  assert.doesNotMatch(netSrc, /override fun createSocket\(\): Socket/, '实现了无参 createSocket：调用方就能拿一条没检查过的 socket 自己去连');
});

test('JS 桥上的地址预检不查 DNS（房主挑个拖着不答的域名就能把整页卡住）', () => {
  const req = kotlinFun(bridgeSrc, 'requirePublicHttpUrl');
  assert.ok(req, 'requirePublicHttpUrl 不见了');
  assert.doesNotMatch(bridgeSrc, /getAllByName/, 'JS 桥线程上又查 DNS 了');
  assert.match(req.body, /NetGuard\.checkUrlShape/, '字面检查没做');
  assert.match(req.body, /NetGuard\.isPrivateAddress/, 'IP 字面量的内网地址要当场拒掉');
  const load = kotlinFun(bridgeSrc, 'playerLoadUrl');
  assert.match(load.body, /headersJson\.length <= MAX_HEADERS_JSON_CHARS/, '超长的请求头 JSON 不该去解析');
});

/* ============================== ② 配置变更 ============================== */

// API 33 的 configChanges 可用取值（来自 SDK 的 attrs_manifest.xml）：写错一个 aapt2 就编不过
const API33_CONFIG_FLAGS = new Set([
  'mcc', 'mnc', 'locale', 'touchscreen', 'keyboard', 'keyboardHidden', 'navigation', 'orientation',
  'screenLayout', 'uiMode', 'screenSize', 'smallestScreenSize', 'density', 'layoutDirection', 'colorMode',
  'fontScale', 'fontWeightAdjustment',
]);

test('深色模式、字体、语言、键盘、旋转等配置变更都声明成自己处理，不重建 Activity', () => {
  const m = /<activity\b[\s\S]*?android:configChanges="([^"]+)"/.exec(manifestXml);
  assert.ok(m, 'Activity 上没有 configChanges');
  const flags = m[1].split('|');
  for (const flag of flags) assert.ok(API33_CONFIG_FLAGS.has(flag), `configChanges 里的 ${flag} 不是 API 33 认得的取值`);
  for (const flag of [
    'uiMode', 'fontScale', 'fontWeightAdjustment', 'density', 'locale', 'layoutDirection', 'keyboard',
    'keyboardHidden', 'navigation', 'orientation', 'screenSize', 'screenLayout', 'smallestScreenSize',
  ]) {
    assert.ok(flags.includes(flag), `少了 ${flag}：这项配置一变 Activity 就重建，观众退房、缓存被删`);
  }
});

test('重建后不重放启动它的那条旧邀请', () => {
  const create = kotlinFun(activitySrc, 'onCreate');
  assert.match(
    create.body,
    /if \(savedInstanceState == null\) pendingInviteLink = inviteLinkOf\(intent\?\.dataString\)/,
    '渲染进程崩溃重建时又处理一遍旧邀请：要是正是它把页面撑崩的，会崩了又建、建了又崩'
  );
});

/* ============================ ⑤ WebView 与深链接 ============================ */

test('深链接只收 noxreel:// 开头、长度正常的', () => {
  const max = kotlinConst(activitySrc, 'MAX_INVITE_LINK_CHARS');
  const inviteLinkOf = translate(activitySrc, 'inviteLinkOf', { MAX_INVITE_LINK_CHARS: max });
  assert.equal(inviteLinkOf(null), null);
  assert.equal(inviteLinkOf('https://evil.example/'), null);
  assert.equal(inviteLinkOf('NOXREEL://j/abc'), 'NOXREEL://j/abc', '协议名不分大小写');
  const long = 'noxreel://j/' + 'A'.repeat(max);
  assert.equal(inviteLinkOf(long), null, '超长的链接不能交给页面去解压');
  assert.equal(inviteLinkOf(long.slice(0, max)), long.slice(0, max));
  assert.equal(max, 32 * 1024, '和页面那边的 MAX_INVITE_CHARS 保持一致');
  assert.match(read('android/app/src/main/assets/js/app-android.js'), /const MAX_INVITE_CHARS = 32 \* 1024;/);
});

test('深链接洪水：只留最新一条，页面就绪后再送，两次之间有最短间隔', () => {
  const onNew = kotlinFun(activitySrc, 'onNewIntent');
  assert.doesNotMatch(onNew.body, /evaluateJavascript/, 'onNewIntent 每来一条就直接塞给页面');
  assert.match(onNew.body, /pendingInviteLink = link[\s\S]*scheduleInviteDelivery\(\)/);
  const schedule = kotlinFun(activitySrc, 'scheduleInviteDelivery');
  assert.match(schedule.body, /if \(inviteScheduled \|\| !pageReady \|\| pendingInviteLink == null\) return/);
  assert.match(schedule.body, /INVITE_MIN_INTERVAL_MS/);
  const deliver = kotlinFun(activitySrc, 'deliverInviteLink');
  assert.match(deliver.body, /!pageReady/, '页面还没加载完就送，noxreelOpenInvite 还不存在，链接就丢了');
  assert.ok(kotlinConst(activitySrc, 'INVITE_MIN_INTERVAL_MS') >= 500);
});

test('WebView：不许被带去站外页面（Native 桥对任何页面都开放），渲染进程崩了不拖死整个 App', () => {
  assert.match(
    activitySrc,
    /override fun shouldOverrideUrlLoading\(view: WebView, request: WebResourceRequest\): Boolean =\s*!isAppPage\(request\.url\)/,
    '站外跳转没拦'
  );
  const gone = kotlinFun(activitySrc, 'onRenderProcessGone');
  assert.ok(gone, '没接渲染进程退出：默认处理是把整个 App 杀掉，接收缓存也没人删');
  assert.match(gone.body, /view\.destroy\(\)/);
  assert.match(gone.body, /recreate\(\)/);
  assert.match(gone.body, /return true/);
});

/* ============================== ⑤ 桥与存储 ============================== */

test('Store：清单尺寸不对（片长离谱、片数对不上、哈希条数不够）一律不开会话', () => {
  const MIN_CHUNK_SIZE = kotlinConst(storeSrc, 'MIN_CHUNK_SIZE');
  const MAX_CHUNK_SIZE = kotlinConst(storeSrc, 'MAX_CHUNK_SIZE');
  const problem = translate(storeSrc, 'manifestProblem', { MIN_CHUNK_SIZE, MAX_CHUNK_SIZE, floorDiv });
  const MB = 1024 * 1024;
  assert.equal(problem(10 * MB, 2 * MB, 5, 5), null, '桌面端的正常清单要放行');
  assert.equal(problem(10 * MB + 1, 2 * MB, 6, 6), null, '末片不满一片');
  assert.equal(problem(1, 2 * MB, 1, 1), null, '一个字节的小文件也是一片');
  assert.ok(problem(100 * MB, 1, 100 * MB, 100 * MB), '片长 1 字节：要分配上亿个元素');
  assert.ok(problem(100 * MB, 64 * MB, 2, 2), '片长 64MB：一片过桥就是上百 MB 的字符串');
  assert.ok(problem(10 * MB, 2 * MB, 6, 6), '片数比文件大小算出来的多：多出来的片写到文件尾之外');
  assert.ok(problem(10 * MB, 2 * MB, 4, 4), '片数少了：文件尾永远是空的却报「收齐了」');
  assert.ok(problem(10 * MB, 2 * MB, 5, 4), '哈希条数不够：写到后面的片越界');
  assert.ok(problem(0, 2 * MB, 0, 0), '空文件');
  assert.ok(problem(-1, 2 * MB, 1, 1), '负的文件大小');
  assert.ok(MIN_CHUNK_SIZE <= 2 * MB && MAX_CHUNK_SIZE >= 2 * MB, '桌面端固定 2MB 的片必须在范围里');

  const open = kotlinFun(storeSrc, 'openLeech');
  const at = (s) => open.body.indexOf(s);
  assert.ok(at('manifestProblem(') >= 0 && at('manifestProblem(') < at('RandomAccessFile('), '得先核对清单再建文件');
  assert.ok(at('HASH_RE.matches') >= 0 && at('HASH_RE.matches') < at('Session('));
  assert.match(open.body, /sessions\.size < MAX_SESSIONS/, '接收会话数没有上限');
});

test('Store：写片前先按长度挡 base64，别等解出来再说', () => {
  const base64Chars = translate(storeSrc, 'base64Chars', { floorDiv });
  for (const n of [0, 1, 2, 3, 4, 5, 1000, 2 * 1024 * 1024, 2 * 1024 * 1024 - 1]) {
    assert.equal(base64Chars(n), Buffer.alloc(n).toString('base64').length, `${n} 字节`);
  }
  const write = kotlinFun(storeSrc, 'writeChunk');
  const check = write.body.indexOf('b64.length > base64Chars(s.chunkLen(index))');
  assert.ok(check >= 0, '没按长度挡超长的串');
  assert.ok(check < write.body.indexOf('Base64.decode'), '长度检查得在解码之前');
  assert.ok(write.body.indexOf('index < 0 || index >= s.chunkCount') < check, '下标得先检查（chunkLen 按下标算）');
});

test('GrowingDataSource：索引指到文件尾以外时报位置越界，不算出负的剩余长度', () => {
  const open = kotlinFun(growingSrc, 'open');
  const guard = open.body.indexOf('dataSpec.position < 0 || dataSpec.position > session.size');
  assert.ok(guard >= 0, '没挡越界的位置');
  assert.ok(guard < open.body.indexOf('bytesRemaining ='), '得在算剩余长度之前挡');
  assert.match(open.body, /ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE/);
});

test('JS 桥：跳转位置、日志长度、请求头都有边界；离开房间和版本号经桥提供', () => {
  const seek = kotlinFun(bridgeSrc, 'playerSeek');
  assert.match(seek.body, /if \(!seconds\.isFinite\(\)\) return/, 'NaN / 无穷大的跳转位置不能往播放器里送');
  assert.match(seek.body, /coerceAtLeast\(0\.0\)/);
  assert.match(kotlinFun(bridgeSrc, 'log').body, /MAX_LOG_CHARS/, '日志不截断：一条几 MB 的字符串整个过桥');
  assert.match(shimSrc, /MAX_NATIVE_LOG_CHARS/, 'JS 这边也得先截，别把大串交给桥');
  assert.match(bridgeSrc, /@JavascriptInterface\s*\n\s*fun appVersion\(\): String = BuildConfig\.VERSION_NAME/);
  const leave = kotlinFun(bridgeSrc, 'leaveRoom');
  assert.ok(leave, '没有 leaveRoom：只重载页面的话原生会话和缓存没人收');
  assert.match(leave.body, /player\.release\(\)/);
  assert.match(leave.body, /store\.closeAll\(\)/);
});

/* =========================== 页面：假 DOM 跑起来 =========================== */

const realConsoleLog = console.log;
const realWebSocket = globalThis.WebSocket;
test.after(() => {
  console.log = realConsoleLog;
  Object.defineProperty(globalThis, 'WebSocket', { value: realWebSocket, configurable: true, writable: true });
});

/** 最小的 RTCPeerConnection 替身：Peer 构造时只往上面挂回调、关的时候调 close。 */
class FakePC {
  constructor(config = {}) {
    this.config = config;
    FakePC.instances.push(this);
    this.iceConnectionState = 'new';
    this.connectionState = 'new';
    this.closed = false;
  }
  close() {
    this.closed = true;
  }
  createDataChannel() {
    return { close() {}, readyState: 'connecting' };
  }
  addEventListener() {}
  removeEventListener() {}
}
FakePC.instances = [];

/** 永远连不上也不报错的 WebSocket：数一数建了几条。 */
class CountingWebSocket {
  constructor(url) {
    this.url = url;
    this.closed = false;
    CountingWebSocket.instances.push(this);
  }
  send() {}
  close() {
    this.closed = true;
  }
}
CountingWebSocket.instances = [];
CountingWebSocket.OPEN = 1;

function fakeNative(extra = {}) {
  const native = {
    logs: [],
    leaves: 0,
    openLeech: () => 'leech-1',
    sessionState: () => JSON.stringify({ bitfield: '', haveCount: 0, contiguousBytes: 0, complete: false }),
    contiguousBytes: () => '0',
    closeSession() {},
    readChunk: () => null,
    writeChunk: () => JSON.stringify({ ok: false, reason: 'test' }),
    playerLoad: () => 1,
    playerLoadUrl: () => 1,
    playerSetPause() {},
    playerSeek() {},
    playerSnapshot: () => JSON.stringify({ generation: 0, position: 0, duration: 0, paused: true, idle: true, eof: false }),
    playerRelease: () => 1,
    usableSpace: () => '0',
    leaveRoom() {
      native.leaves++;
    },
    appVersion: () => '0.7.4',
    log(msg) {
      native.logs.push(msg);
    },
    ...extra,
  };
  return native;
}

let hooks = null;
async function installHooks() {
  if (hooks) return hooks;
  // native-shim 只加载一次，它会把 console.log 包一层（先送 Native.log）。先换成空函数，别刷屏。
  console.log = () => {};
  globalThis.window = globalThis.window || {};
  globalThis.RTCPeerConnection = FakePC;
  const { Swarm } = await import(assetUrl('swarm.js'));
  const { SyncEngine } = await import(assetUrl('syncEngine.js'));
  const { Peer } = await import(assetUrl('peer.js'));
  const signaling = await import(assetUrl('signaling.js'));
  const swarms = [];
  const syncs = [];
  const origStart = Swarm.prototype.start;
  Swarm.prototype.start = function start(...args) {
    swarms.push(this);
    return origStart.apply(this, args);
  };
  const origOn = SyncEngine.prototype.on;
  SyncEngine.prototype.on = function on(...args) {
    if (!syncs.includes(this)) syncs.push(this);
    return origOn.apply(this, args);
  };
  // 生成应答要真的跑 WebRTC：换成由测试决定什么时候给出应答
  const offers = [];
  Peer.prototype.acceptOffer = function acceptOffer(sdp) {
    return new Promise((resolve, reject) => offers.push({ peer: this, sdp, resolve, reject }));
  };
  hooks = { swarms, syncs, offers, signaling };
  return hooks;
}

async function flush(rounds = 30) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

async function until(cond, what, max = 3000) {
  for (let i = 0; i < max; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail(`等不到：${what}`);
}

/** 某个房主发的一对一邀请链接（noxreel://…）。 */
async function inviteFrom(h, hostId) {
  const code = await h.signaling.encodeCode({
    k: 'offer',
    from: hostId,
    sdp: `v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=${hostId}\r\n`,
    securityMode: 'trusted',
  });
  return h.signaling.inviteLink(code, 'join');
}

let caseNo = 0;

async function loadPhone(t, { native = fakeNative(), session = new Map(), storage = {} } = {}) {
  const h = await installHooks();
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 });
  const store = new Map([['sw.securityMode', 'trusted'], ...Object.entries(storage)]);
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  globalThis.window.localStorage = globalThis.localStorage;
  globalThis.sessionStorage = {
    getItem: (k) => (session.has(k) ? session.get(k) : null),
    setItem: (k, v) => session.set(k, String(v)),
    removeItem: (k) => session.delete(k),
  };
  globalThis.document = fakeDocument();
  const reloads = [];
  globalThis.location = { reload: () => reloads.push(Date.now()) };
  globalThis.Native = native;
  Object.defineProperty(globalThis, 'WebSocket', { value: CountingWebSocket, configurable: true, writable: true });
  const swarmCount = h.swarms.length;
  const offerCount = h.offers.length;
  await import(assetUrl('app-android.js') + `?case=${++caseNo}`);
  const $ = (id) => globalThis.document.getElementById(id);
  return {
    h,
    native,
    $,
    reloads,
    session,
    open: (link) => globalThis.window.noxreelOpenInvite(link),
    swarm: () => h.swarms.slice(swarmCount).at(-1),
    offers: () => h.offers.slice(offerCount),
    logged: (text) => native.logs.filter((l) => l.includes(text)).length,
  };
}

/** 点开 hostId 的邀请、生成应答、房主那边连上：这台手机就「在房间里」了。 */
async function joinedPhone(t, hostId = 'HOSTAAAA') {
  const phone = await loadPhone(t);
  phone.open(await inviteFrom(phone.h, hostId));
  await until(() => phone.offers().length === 1, '开始生成应答');
  const { peer } = phone.offers()[0];
  phone.offers()[0].resolve('v=0 answer');
  await until(() => !!phone.$('answer-out').value, '应答链接生成');
  peer.authenticated = true; // 房主点开了应答，握手完成
  return { phone, peer };
}

const emptyPlaylist = (rev) => ({
  t: 'playlist',
  state: { rev, seq: 0, queue: [], history: [], started: false, autoplay: true, nextSlot: 1 },
});

/* ============================== ① 深链接重入 ============================== */

test('已在房间里再点同一个房主的邀请：不拆掉活连接，先问要不要离开', async (t) => {
  const { phone, peer } = await joinedPhone(t);
  const swarm = phone.swarm();
  const pcs = FakePC.instances.length;

  phone.open(await inviteFrom(phone.h, 'HOSTAAAA'));
  await flush();

  assert.equal(swarm.peers.get('HOSTAAAA'), peer, '同一个房主的活连接被新建的 Peer 顶掉了');
  assert.equal(peer.closed, false, '活连接被关了');
  assert.equal(FakePC.instances.length, pcs, '在房间里还在新建连接');
  assert.equal(phone.offers().length, 1, '在房间里还在走加入流程');
  assert.ok(phone.$('invite-ask').classList.contains('on'), '应该弹框问要不要离开当前房间');
});

test('已在房间里点开陌生房主的邀请：房主身份不变，真房主的列表照收', async (t) => {
  const { phone, peer } = await joinedPhone(t);
  const swarm = phone.swarm();

  phone.open(await inviteFrom(phone.h, 'STRANGER'));
  await flush();
  assert.equal(swarm.peers.has('STRANGER'), false, '陌生人的邀请建起了连接');
  assert.equal(phone.h.syncs.at(-1).hostId, 'HOSTAAAA');

  // 真房主之后发来的列表必须照收（S.hostId 被换掉的话会被当成「非房主」丢掉）
  swarm._onCtrl(peer, emptyPlaylist(1));
  await flush();
  assert.equal(phone.logged('已忽略非房主发来的播放列表'), 0, '真房主的列表被当成非房主的丢了');
  assert.equal(phone.$('lobby').style.display, 'none', '收到房主的列表就该进房');
});

test('确认框：留下什么都不动；离开并加入会收掉原生会话、记下邀请、整页重载', async (t) => {
  const { phone } = await joinedPhone(t);
  const linkB = await inviteFrom(phone.h, 'HOSTBBBB');
  const linkC = await inviteFrom(phone.h, 'HOSTCCCC');

  phone.open(linkB);
  await flush();
  phone.$('invite-stay').click();
  assert.equal(phone.$('invite-ask').classList.contains('on'), false);
  assert.equal(phone.native.leaves, 0);
  assert.equal(phone.reloads.length, 0);

  // 连着来两条：只弹一个框，留最后一条
  phone.open(linkB);
  phone.open(linkC);
  await flush();
  phone.$('invite-leave').click();
  assert.equal(phone.native.leaves, 1, '没让原生收掉播放器和接收缓存');
  assert.equal(phone.session.get('sw.pendingInvite'), linkC, '要处理的是最后收到的那条');
  assert.equal(phone.reloads.length, 1, '离开房间要整页重载');
});

test('重载后接着处理「离开并加入」留下的那条邀请，只处理一次', async (t) => {
  const h = await installHooks();
  const link = await inviteFrom(h, 'HOSTBBBB');
  const session = new Map([['sw.pendingInvite', link]]);
  const phone = await loadPhone(t, { session });
  await until(() => phone.offers().length === 1, '重载后开始按那条邀请生成应答');
  assert.equal(session.has('sw.pendingInvite'), false, '处理完要删掉，否则每次重载都再加入一次');
});

test('加入进行中再来邀请：不重入，只建一条连接', async (t) => {
  const phone = await loadPhone(t);
  const pcs = FakePC.instances.length;
  phone.open(await inviteFrom(phone.h, 'HOSTAAAA'));
  await until(() => phone.offers().length === 1, '开始生成应答');

  phone.open(await inviteFrom(phone.h, 'HOSTBBBB'));
  phone.$('host-code').value = await inviteFrom(phone.h, 'HOSTCCCC');
  phone.$('gen-answer').click();
  await flush();
  assert.equal(phone.offers().length, 1, '加入还没跑完就又开了一轮');
  assert.equal(FakePC.instances.length, pcs + 1);
  assert.ok(phone.logged('上一条邀请还在处理') >= 2);
});

test('还没连上时换一个房主的邀请：上一次的残骸收干净，同步引擎的房主跟着换', async (t) => {
  const phone = await loadPhone(t);
  phone.open(await inviteFrom(phone.h, 'HOSTAAAA'));
  await until(() => phone.offers().length === 1, '第一轮生成应答');
  const first = phone.offers()[0];
  first.resolve('v=0 answer');
  await until(() => !!phone.$('answer-out').value, '第一轮应答生成');
  const swarm = phone.swarm();
  const listeners = () => swarm._h.get('peer-authenticated')?.size || 0;
  const before = listeners();

  phone.open(await inviteFrom(phone.h, 'HOSTBBBB'));
  await until(() => phone.offers().length === 2, '第二轮生成应答');
  assert.equal(first.peer.closed, true, '上一轮等不到应答的连接没收掉');
  assert.equal(swarm.peers.has('HOSTAAAA'), false);
  assert.equal(phone.h.syncs.at(-1).hostId, 'HOSTBBBB', '同步引擎还认着上一个房主');
  assert.equal(listeners(), before, '每重粘一次就多挂一个监听');
});

test('生成应答卡死：到时限放开闸门；迟到的旧应答不会盖掉新的那条', async (t) => {
  const phone = await loadPhone(t);
  phone.open(await inviteFrom(phone.h, 'HOSTAAAA'));
  await until(() => phone.offers().length === 1, '第一轮开始生成应答');
  const stale = phone.offers()[0]; // 一直不给结果

  t.mock.timers.tick(30_000);
  await until(() => phone.logged('生成应答链接失败：生成应答链接超时') === 1, '第一轮超时');

  phone.open(await inviteFrom(phone.h, 'HOSTBBBB'));
  await until(() => phone.offers().length === 2, '超时之后应该能处理新的邀请');
  phone.offers()[1].resolve('v=0 answer-B');
  await until(() => !!phone.$('answer-out').value, '第二轮应答生成');
  const fresh = phone.$('answer-out').value;

  stale.resolve('v=0 answer-A');
  await flush();
  assert.equal(phone.$('answer-out').value, fresh, '迟到的旧应答把新的盖掉了：发回给房主的是一条作废的应答');
});

test('超长的深链接不解码、不加入', async (t) => {
  const phone = await loadPhone(t);
  phone.open('noxreel://j/' + 'A'.repeat(40 * 1024));
  await flush();
  assert.equal(phone.offers().length, 0);
  assert.equal(phone.logged('邀请链接异常过长'), 1);
});

test('信令模式：连着点两下「加入房间」只建一条信令；服务器一直不回话也会放开', async (t) => {
  const phone = await loadPhone(t);
  const before = CountingWebSocket.instances.length;
  phone.$('url').value = 'ws://127.0.0.1:9';
  phone.$('room').value = 'room';
  phone.$('join').click();
  phone.$('join').click();
  await flush();
  assert.equal(CountingWebSocket.instances.length, before + 1, '点两下建了两条信令');
  assert.equal(phone.logged('正在加入房间，请稍候'), 1);

  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(phone.logged('连接失败：信令服务器一直没有回应'), 1, '一直不回话的服务器会让「正在加入」永远挂着');
  assert.equal(CountingWebSocket.instances.at(-1).closed, true, '放弃的那条信令要关掉');

  phone.$('join').click();
  await flush();
  assert.equal(CountingWebSocket.instances.length, before + 2, '超时之后应该能再试');
});

test('信令模式：进了房但还没人连上时可以换个房间号重进（旧信令先关）；这时的深链接要先问', async (t) => {
  const phone = await loadPhone(t);
  const before = CountingWebSocket.instances.length;
  phone.$('url').value = 'ws://127.0.0.1:9';
  phone.$('room').value = 'room-typo';
  phone.$('join').click();
  const ws = CountingWebSocket.instances.at(-1);
  ws.onopen();
  ws.onmessage({ data: JSON.stringify({ t: 'joined', peers: [] }) });
  await until(() => phone.logged('已进入房间') === 1, '进房');

  phone.open(await inviteFrom(phone.h, 'HOSTAAAA'));
  await flush();
  assert.ok(phone.$('invite-ask').classList.contains('on'), '已经用信令进了房间，深链接要先问');
  assert.equal(phone.offers().length, 0);
  phone.$('invite-stay').click();

  phone.$('room').value = 'room';
  phone.$('join').click();
  await flush();
  assert.equal(CountingWebSocket.instances.length, before + 2, '还没人连上时应该能换个房间号重进');
  assert.equal(ws.closed, true, '旧信令没关：同一个身份挂在两个房间里');
});

/* ============================== ⑤ 日志刷屏 ============================== */

test('别人反复发会被忽略的消息：警告限频，页面日志有上限', async (t) => {
  const { phone } = await joinedPhone(t);
  const swarm = phone.swarm();
  for (let i = 0; i < 1000; i++) swarm.emit('ctrl', { msg: emptyPlaylist(i + 1), peer: { peerId: 'EVIL' } });
  await flush();
  assert.equal(phone.logged('已忽略非房主发来的播放列表'), 1, '每条都记一行：别人能拿它刷屏');
  t.mock.timers.tick(10_000);
  swarm.emit('ctrl', { msg: emptyPlaylist(2000), peer: { peerId: 'EVIL' } });
  assert.equal(phone.logged('已忽略非房主发来的播放列表'), 2, '过了限频窗口还得照常提示');

  for (let i = 0; i < 1000; i++) phone.open('noxreel://j/' + 'A'.repeat(33 * 1024));
  assert.ok(phone.$('log').children.length <= 250, `页面日志涨到了 ${phone.$('log').children.length} 行`);
});

/* ============================== ④ 版本号 ============================== */

test('大厅显示安装包版本号', async (t) => {
  const phone = await loadPhone(t);
  assert.equal(phone.$('app-version').textContent, 'v0.7.4');
  assert.match(indexHtml, /<span id="app-version" data-i18n-skip><\/span>/, '版本号不该被自动翻译');
  assert.match(indexHtml, /#app-version \{ font-size:12px;/, '版本号是小字');
});

test('版本号长得不对就不显示', async (t) => {
  const odd = await loadPhone(t, { native: fakeNative({ appVersion: () => '<img src=x>' }) });
  assert.equal(odd.$('app-version').textContent, '');
});

test('旧的原生层没有 appVersion 时页面照常加载', async (t) => {
  const none = await loadPhone(t, { native: fakeNative({ appVersion: undefined }) });
  assert.equal(none.$('app-version').textContent, '');
  assert.ok(none.logged('准备就绪') >= 1, '页面没跑完');
});

/* ============================== 文案与页面 ============================== */

test('新文案都有英文', async () => {
  const { translate: tr } = await import(assetUrl('i18n.js'));
  for (const line of [
    '你已经在房间里了。要离开当前房间，加入新收到的邀请吗？',
    '留在当前房间',
    '离开并加入',
    '已留在当前房间，新收到的邀请没有处理',
    '你已经在房间里了。要加入新的房间，请先离开当前房间。',
    '上一条邀请还在处理，请稍候再试',
    '邀请链接异常过长，已忽略',
    '正在加入房间，请稍候',
    '连接失败：信令服务器一直没有回应',
    '生成应答链接失败：生成应答链接超时',
    '打开接收会话失败：清单里的分片大小不对',
    '打开接收会话失败：同时打开的接收会话太多',
    '没法接收这一部：清单里的分片数和文件大小对不上',
    '没法接收这一部：清单里的分片哈希条数不对',
    '没法接收这一部：清单里的分片哈希格式不对',
    '没法接收这一部：清单里的文件大小不对',
  ]) {
    const en = tr(line, 'en');
    assert.notEqual(en, line, `缺英文：${line}`);
    assert.doesNotMatch(en, /[一-鿿]/, `英文里还夹着中文：${line} → ${en}`);
  }
  // 磁盘空间那条更具体的译法仍然排在通配的前面
  assert.match(tr('打开接收会话失败：磁盘空间不够：这部片子需要 48.20GB，手机只剩 12.03GB', 'en'), /not enough storage/);
});

test('确认框放在播放层外面：大厅里也弹得出来', () => {
  const stage = indexHtml.indexOf('<div id="stage">');
  const ask = indexHtml.indexOf('<div id="invite-ask">');
  const script = indexHtml.indexOf('<script type="module"');
  assert.ok(stage > 0 && ask > stage && ask < script);
  // #stage 在进房前是 display:none；框要是塞在里面，大厅里就看不见
  const stageBlock = indexHtml.slice(stage, ask);
  const opens = (stageBlock.match(/<div\b/g) || []).length;
  const closes = (stageBlock.match(/<\/div>/g) || []).length;
  assert.equal(opens, closes, '#invite-ask 落在了 #stage 里面');
  assert.match(indexHtml, /#invite-ask \{ position:fixed;/);
  for (const id of ['invite-stay', 'invite-leave']) assert.match(indexHtml, new RegExp(`id="${id}"`));
});

/* ================= 和电脑端补齐：房间链接、TURN、隐藏我的 IP、连接上限 ================= */

/** 按 Nostr 中继协议（REQ / EVENT / CLOSE）工作的内存中继，和 relaySignaling.test.js 那份同一套。计时器走 mock。 */
class FakeRelayNet {
  constructor() {
    this.relays = new Map();
    this.sockets = new Set();
  }
  relay(url) {
    if (!this.relays.has(url)) this.relays.set(url, { subs: new Set() });
    return this.relays.get(url);
  }
  WebSocket() {
    const net = this;
    return class FakeRelayWS {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        net.sockets.add(this);
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.();
        }, 5);
      }
      send(text) {
        if (this.readyState !== 1) return;
        const msg = JSON.parse(text);
        const relay = net.relay(this.url);
        if (msg[0] === 'REQ') relay.subs.add({ ws: this, id: msg[1], filter: msg[2] });
        else if (msg[0] === 'CLOSE') {
          for (const s of relay.subs) if (s.ws === this && s.id === msg[1]) relay.subs.delete(s);
        } else if (msg[0] === 'EVENT') {
          const ev = msg[1];
          for (const s of relay.subs) {
            if (!s.filter.kinds.includes(ev.kind)) continue;
            if (!ev.tags.some((tag) => tag[0] === 'x' && s.filter['#x'].includes(tag[1]))) continue;
            setTimeout(() => s.ws.readyState === 1 && s.ws.onmessage?.({ data: JSON.stringify(['EVENT', s.id, ev]) }), 2);
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

const RELAYS = ['wss://relay-a.example', 'wss://relay-b.example'];

/** 推着假时钟走（中继的连接、hello 重发、等放行的超时都是计时器），每一步让 Promise 链跑完。 */
async function pump(t, ms, step = 25) {
  for (let done = 0; done < ms; done += step) {
    t.mock.timers.tick(step);
    await flush(20);
  }
}

async function pumpUntil(t, cond, what, maxMs = 20_000) {
  for (let waited = 0; waited < maxMs; waited += 25) {
    if (cond()) return;
    t.mock.timers.tick(25);
    // 签名、加解密有一部分是真的异步（WebCrypto），多让几轮事件循环，别让假时钟跑在它前头
    await flush(20);
  }
  assert.fail(`等不到：${what}`);
}

/** 推着假时钟等一个 Promise 落定（里面既有假计时器，也有真的 WebCrypto）。 */
async function pumpPromise(t, promise, what, maxMs = 20_000) {
  let done = false;
  let value;
  let error;
  promise.then(
    (v) => {
      done = true;
      value = v;
    },
    (e) => {
      done = true;
      error = e;
    }
  );
  await pumpUntil(t, () => done, what, maxMs);
  if (error) throw error;
  return value;
}

/** 电脑端的房主（和手机上是同一份 relaySignaling.js），连在假中继上。返回房主和它的房间链接。 */
async function relayHost(t, phone, net, { securityMode = 'trusted' } = {}) {
  const { RelaySignaling, newRoomSecret } = await import(assetUrl('relaySignaling.js'));
  const { PROTOCOL_VERSION } = await import(assetUrl('protocol.js'));
  const secret = newRoomSecret();
  const host = new RelaySignaling({
    secret,
    isHost: true,
    hostId: 'HOSTRLY1',
    peerId: 'HOSTRLY1',
    name: '房主',
    relays: RELAYS,
    maxMembers: 8,
    occupied: () => 1,
    protocolVersion: PROTOCOL_VERSION,
    WebSocketImpl: net.WebSocket(),
  });
  t.after(() => host.close());
  const events = { join: [], signal: [] };
  host.on('peer-join', (e) => events.join.push(e));
  host.on('signal', (e) => events.signal.push(e));
  await pumpPromise(t, host.connect(), '房主连上假中继');
  const code = await phone.h.signaling.encodeCode({
    k: 'relay',
    key: secret,
    hk: host.publicKey,
    from: 'HOSTRLY1',
    maxMembers: 8,
    securityMode,
    relays: RELAYS,
  });
  return { host, events, link: phone.h.signaling.shareLink(code, 'join') };
}

function useRelayNet(net) {
  Object.defineProperty(globalThis, 'WebSocket', { value: net.WebSocket(), configurable: true, writable: true });
}

test('房间链接：手机点开电脑房主的链接，等放行后进房；房主发来的 offer 不 trickle，手机回 answer', { timeout: 60_000 }, async (t) => {
  const phone = await loadPhone(t);
  const net = new FakeRelayNet();
  useRelayNet(net);
  const { host, events, link } = await relayHost(t, phone, net);

  phone.open(link);
  await pumpUntil(t, () => phone.logged('房主已放行，正在和房间里的人打洞') === 1, '房主放行');
  assert.equal(events.join.length, 1, '房主那边看到手机进房');
  assert.equal(phone.logged('这是房间链接，目前只有电脑端'), 0, '不能再说手机不支持');

  // 老成员（房主）向新人发 offer
  const phoneId = events.join[0].peerId;
  host.signal(phoneId, { kind: 'offer', sdp: 'v=0 offer-from-host' });
  await pumpUntil(t, () => phone.offers().length === 1, '手机收到 offer');
  const { peer } = phone.offers()[0];
  assert.equal(peer.peerId, 'HOSTRLY1');
  assert.equal(peer.trickle, false, '中继路径不 trickle：候选打包进 SDP');
  phone.offers()[0].resolve('v=0 answer-from-phone');
  await pumpUntil(t, () => events.signal.some((s) => s.payload?.kind === 'answer'), '房主收到 answer');
  assert.equal(events.signal.find((s) => s.payload?.kind === 'answer').from, phoneId, '署名是手机');

  // 已经在房间里了：再点一条邀请要先问
  phone.open(link);
  await flush();
  assert.ok(phone.$('invite-ask').classList.contains('on'));
});

test('房间链接：房主不在线就说清楚、收掉中继连接，之后还能再点', { timeout: 60_000 }, async (t) => {
  const phone = await loadPhone(t);
  const net = new FakeRelayNet();
  useRelayNet(net);
  const { host, link } = await relayHost(t, phone, net);
  host.close(); // 房主走了
  await pump(t, 50);

  phone.open(link);
  await pumpUntil(t, () => phone.logged('加入房间失败：找不到房主') === 1, '等放行超时', 40_000);
  await pump(t, 50);
  const phoneSockets = [...net.sockets].filter((ws) => ws.readyState !== 3);
  assert.equal(phoneSockets.length, 0, '放弃之后中继连接要关掉');

  phone.open(link);
  await pump(t, 100);
  assert.equal(phone.logged('上一条邀请还在处理'), 0, '闸门放开了');
});

test('房间链接：模式不一致、链接不完整都不连中继', { timeout: 60_000 }, async (t) => {
  const phone = await loadPhone(t);
  const net = new FakeRelayNet();
  useRelayNet(net);
  const { link } = await relayHost(t, phone, net, { securityMode: 'safe' });
  const before = net.sockets.size;
  phone.open(link);
  await pump(t, 100);
  assert.equal(phone.logged('房间使用安全模式，本机设置是可信房间'), 1);

  const broken = await phone.h.signaling.encodeCode({ k: 'relay', key: 'x', hk: 'nothex', from: 'HOSTRLY1', securityMode: 'trusted' });
  phone.open(phone.h.signaling.shareLink(broken, 'join'));
  await pump(t, 100);
  assert.equal(phone.logged('这个房间链接不完整'), 1);
  assert.equal(net.sockets.size, before, '一条中继连接都不该开');
});

test('隐藏我的 IP 开着却没有中继：房间链接、一对一邀请、信令服务器都不建连接，也不退回直连', { timeout: 60_000 }, async (t) => {
  const phone = await loadPhone(t, { storage: { 'sw.relayOnly': '1' } });
  const net = new FakeRelayNet();
  useRelayNet(net);
  const { link } = await relayHost(t, phone, net);
  const sockets = net.sockets.size;
  phone.open(link);
  await pump(t, 100);
  assert.equal(net.sockets.size, sockets, '房间链接没开任何中继连接');

  phone.open(await inviteFrom(phone.h, 'HOSTAAAA'));
  await pump(t, 100);
  assert.equal(phone.offers().length, 0, '一对一邀请没生成应答');

  Object.defineProperty(globalThis, 'WebSocket', { value: CountingWebSocket, configurable: true, writable: true });
  const ws = CountingWebSocket.instances.length;
  phone.$('url').value = 'ws://127.0.0.1:9';
  phone.$('room').value = 'room';
  phone.$('join').click();
  await flush();
  assert.equal(CountingWebSocket.instances.length, ws, '信令服务器也没连');
  assert.ok(phone.logged('已打开「隐藏我的 IP」，但还没有可用的 TURN 中继') >= 3, '三处都说清楚了');
});

test('隐藏我的 IP + 自己填的 TURN：一对一应答只走中继、不带 STUN；没拿到中继候选当场说', { timeout: 60_000 }, async (t) => {
  const phone = await loadPhone(t, {
    storage: {
      'sw.relayOnly': '1',
      'sw.turnEnabled': '1',
      'sw.turnUrl': 'turn:turn.example.org:3478',
      'sw.turnUser': 'u',
      'sw.turnPass': 'p',
    },
  });
  phone.open(await inviteFrom(phone.h, 'HOSTAAAA'));
  await until(() => phone.offers().length === 1, '生成应答');
  const { peer } = phone.offers()[0];
  assert.equal(peer.iceTransportPolicy, 'relay');
  const servers = peer.pc.config.iceServers;
  assert.ok(servers.length === 1 && servers[0].urls.every((u) => /^turn:/.test(u)), JSON.stringify(servers));
  assert.equal(peer.pc.config.iceTransportPolicy, 'relay');
  phone.offers()[0].resolve('v=0 answer-without-candidates');
  await until(() => !!phone.$('answer-out').value, '应答生成');
  assert.equal(phone.logged('一条中继候选都没拿到'), 1, '只走中继却一条中继候选都没有：当场说');
});

test('没开隐藏我的 IP：自己填的 TURN 照样带上，STUN 也在', { timeout: 60_000 }, async (t) => {
  const phone = await loadPhone(t, {
    storage: { 'sw.turnEnabled': '1', 'sw.turnUrl': 'turn:turn.example.org:3478', 'sw.turnUser': 'u', 'sw.turnPass': 'p' },
  });
  phone.open(await inviteFrom(phone.h, 'HOSTAAAA'));
  await until(() => phone.offers().length === 1, '生成应答');
  const { peer } = phone.offers()[0];
  assert.equal(peer.iceTransportPolicy, 'all');
  const urls = peer.pc.config.iceServers.flatMap((s) => s.urls);
  assert.ok(urls.some((u) => u.startsWith('stun:')), 'STUN 在');
  assert.ok(urls.includes('turn:turn.example.org:3478?transport=udp') && urls.includes('turn:turn.example.org:3478?transport=tcp'), JSON.stringify(urls));
});

test('连接设置：写错了当场说；保存后用的是和电脑端同一组键', { timeout: 60_000 }, async (t) => {
  const phone = await loadPhone(t);
  const save = async () => {
    phone.$('net-save').click();
    await flush();
    return phone.$('net-err').textContent;
  };
  phone.$('turn-source-manual').checked = true;
  phone.$('turn-on').checked = true;
  phone.$('turn-url').value = 'https://turn.example.org';
  assert.match(await save(), /这些 TURN 地址认不出来/);
  phone.$('turn-url').value = 'turn:turn.example.org:53';
  assert.match(await save(), /53 端口/);
  phone.$('turn-url').value = 'turn.example.org:3478';
  phone.$('turn-user').value = 'u';
  phone.$('turn-pass').value = '';
  assert.match(await save(), /要填用户名和密码/);
  phone.$('turn-pass').value = 'p';
  phone.$('cf-key').value = 'abcdef1234';
  assert.match(await save(), /Cloudflare 凭据还没保存/);
  phone.$('cf-key').value = '';
  phone.$('relay-only').checked = true;
  assert.equal(await save(), '');
  const get = (k) => globalThis.localStorage.getItem(k);
  assert.equal(get('sw.turnSource'), 'manual');
  assert.equal(get('sw.turnEnabled'), '1');
  assert.equal(get('sw.turnUrl'), 'turn:turn.example.org:3478', '漏了 turn: 前缀的直接补上');
  assert.equal(get('sw.turnUser'), 'u');
  assert.equal(get('sw.turnPass'), 'p');
  assert.equal(get('sw.relayOnly'), '1');
  assert.equal(phone.logged('连接设置已保存'), 1);
});

test('信令那头刷人：同时挂着的连接有上限，同一个人刷 offer 被限速', { timeout: 60_000 }, async (t) => {
  const phone = await loadPhone(t);
  const { Peer } = await import(assetUrl('peer.js'));
  const realCreateOffer = Peer.prototype.createOffer;
  Peer.prototype.createOffer = () => new Promise(() => {});
  t.after(() => {
    Peer.prototype.createOffer = realCreateOffer;
  });
  phone.$('url').value = 'ws://127.0.0.1:9';
  phone.$('room').value = 'room';
  phone.$('join').click();
  const ws = CountingWebSocket.instances.at(-1);
  ws.onopen();
  ws.onmessage({ data: JSON.stringify({ t: 'joined', peers: [] }) });
  await until(() => phone.logged('已进入房间') === 1, '进房');
  const swarm = phone.swarm();

  for (let i = 0; i < 40; i++) ws.onmessage({ data: JSON.stringify({ t: 'peer-join', peerId: `FLOOD${String(i).padStart(3, '0')}`, name: 'x' }) });
  await flush();
  assert.equal(swarm.peers.size, 24, '同时挂着的连接不能超过 24 条');
  assert.equal(phone.logged('同时连着的人太多了'), 1, '只说一次');

  for (const p of [...swarm.peers.keys()]) swarm.removePeer(p);
  const pcs = FakePC.instances.length;
  for (let i = 0; i < 10; i++) {
    ws.onmessage({ data: JSON.stringify({ t: 'signal', from: 'SPAMMER1', name: 'x', payload: { kind: 'offer', sdp: 'v=0' } }) });
  }
  await flush();
  assert.equal(FakePC.instances.length - pcs, 4, '同一个人一下子最多重建 4 次');
  ws.onmessage({ data: JSON.stringify({ t: 'signal', from: 'SPAMMER1', name: 'x', payload: 'not-an-object' }) });
  await flush();
});

test('信令说「你被移出房间」（房间链接的房主一直没和你直连上）：还没进房就停在大厅说清楚', { timeout: 60_000 }, async (t) => {
  const phone = await loadPhone(t);
  phone.$('url').value = 'ws://127.0.0.1:9';
  phone.$('room').value = 'room';
  phone.$('join').click();
  const ws = CountingWebSocket.instances.at(-1);
  ws.onopen();
  ws.onmessage({ data: JSON.stringify({ t: 'joined', peers: [] }) });
  await until(() => phone.logged('已进入房间') === 1, '进房');
  ws.onmessage({ data: JSON.stringify({ t: 'error', code: 'REMOVED', message: 'removed' }) });
  await flush();
  assert.equal(phone.logged('房主那边一直没能和你直连，你已被移出房间'), 1);
  assert.equal(ws.closed, true, '信令收掉');
  assert.equal(phone.reloads.length, 0, '还没进房不用整页重载');
});

test('被移出前已经在房间里：整页重载回大厅，原因留到大厅再说一遍（只说一次）', { timeout: 60_000 }, async (t) => {
  const session = new Map([['sw.lobbyNotice', '房主那边一直没能和你直连，你已被移出房间。']]);
  const phone = await loadPhone(t, { session });
  assert.equal(phone.logged('你已被移出房间'), 1);
  assert.equal(session.has('sw.lobbyNotice'), false, '说完就删');
  const src = fs.readFileSync(path.join(root, 'android', 'app', 'src', 'main', 'assets', 'js', 'app-android.js'), 'utf8');
  const fn = src.slice(src.indexOf('function removedFromRoom()'), src.indexOf('\n}\n', src.indexOf('function removedFromRoom()')));
  assert.match(fn, /sessionStorage\.setItem\(LOBBY_NOTICE_KEY, text\)/);
  assert.match(fn, /window\.sw\.leaveRoom\(\);\s*location\.reload\(\);/);
});

/* ------------------------- Cloudflare TURN（页面这一侧） ------------------------- */

/**
 * 假原生层的 Cloudflare 调用：按动作交给 handlers，结果在下一个微任务里经 __noxreelNativeReply 送回，
 * 和真机上「后台线程做完再切回主线程」一样是异步的。
 */
function cfNative(handlers) {
  const calls = [];
  return fakeNative({
    cfCalls: calls,
    cfCall(id, action, args) {
      calls.push({ action, args: JSON.parse(args) });
      queueMicrotask(() => {
        let reply;
        try {
          reply = { ok: true, value: (handlers[action] || (() => ({})))(JSON.parse(args)) };
        } catch (e) {
          reply = { ok: false, error: e.message };
        }
        globalThis.window.__noxreelNativeReply(id, JSON.stringify(reply));
      });
    },
  });
}

const CF_URLS = ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:443?transport=tcp'];
const cfUsage = (over = {}) => ({ month: '2026-09', usedBytes: 0, limitGB: 900, limitBytes: 900e9, exceeded: false, nearLimit: false, ...over });

test('Cloudflare 来源 + 隐藏我的 IP：生成应答前先取临时账号，连接只走 Cloudflare 中继', { timeout: 60_000 }, async (t) => {
  const native = cfNative({
    status: () => ({ configured: true, expiresAt: null, lastError: null, usage: cfUsage() }),
    credentials: () => ({ urls: CF_URLS, username: 'cf-user', credential: 'cf-pass', expiresAt: Date.now() + 23 * 3600e3 }),
  });
  const phone = await loadPhone(t, { native, storage: { 'sw.turnSource': 'cloudflare', 'sw.relayOnly': '1' } });
  await flush();
  assert.deepEqual(native.cfCalls.map((c) => c.action), ['status'], '打开就看一眼状态，Token 不回来');
  phone.open(await inviteFrom(phone.h, 'HOSTAAAA'));
  await until(() => phone.offers().length === 1, '生成应答');
  assert.deepEqual(native.cfCalls.at(-1), { action: 'credentials', args: { minValidMs: 2 * 3600e3 } });
  const { peer } = phone.offers()[0];
  assert.equal(peer.iceTransportPolicy, 'relay');
  assert.deepEqual(peer.pc.config.iceServers, [{ urls: CF_URLS, username: 'cf-user', credential: 'cf-pass' }]);

  // 手上的还新鲜：下一次建连接不再去取
  const before = native.cfCalls.length;
  phone.offers()[0].resolve('v=0 answer');
  await until(() => !!phone.$('answer-out').value, '应答生成');
  assert.equal(native.cfCalls.length, before);
});

test('本月 Cloudflare 用量到上限：取账号被拒（CF_QUOTA），隐藏我的 IP 开着就不连，说清楚是用量到了', { timeout: 60_000 }, async (t) => {
  const native = cfNative({
    status: () => ({ configured: true, expiresAt: null, lastError: null, usage: cfUsage() }),
    credentials: () => {
      throw new Error('[CF_QUOTA] 本月用量已到上限（900 GB）');
    },
  });
  const phone = await loadPhone(t, { native, storage: { 'sw.turnSource': 'cloudflare', 'sw.relayOnly': '1' } });
  phone.open(await inviteFrom(phone.h, 'HOSTAAAA'));
  await flush();
  await flush();
  assert.equal(phone.offers().length, 0, '没有中继就不生成应答');
  assert.ok(phone.logged('本月 Cloudflare TURN 用量已到你设的上限（900 GB）') >= 1);
  assert.equal(phone.logged('「隐藏我的 IP」开着，没有中继就不连接'), 1);
});

test('连接设置里「验证并保存」：Token 交给原生层，成功后两个框清空；失败说人话；月上限另外保存', { timeout: 60_000 }, async (t) => {
  let fail = true;
  const native = cfNative({
    status: () => ({ configured: false, expiresAt: null, lastError: null, usage: cfUsage() }),
    save: () => {
      if (fail) throw new Error('[CF_UNAUTHORIZED] HTTP 401');
      return { configured: true, expiresAt: Date.now() + 23 * 3600e3, lastError: null, usage: cfUsage() };
    },
    setLimit: ({ limitGB }) => cfUsage({ limitGB, limitBytes: limitGB * 1e9 }),
  });
  const phone = await loadPhone(t, { native });
  phone.$('cf-key').value = 'abcdef1234';
  phone.$('cf-token').value = 't'.repeat(40);
  phone.$('cf-save').click();
  await flush();
  assert.equal(native.cfCalls.at(-1).action, 'save');
  assert.deepEqual(native.cfCalls.at(-1).args, { keyId: 'abcdef1234', apiToken: 't'.repeat(40) });
  assert.equal(phone.$('cf-result').textContent, '没保存：未授权：Cloudflare 不认这组 Turn Token ID 和 API Token');
  assert.equal(phone.$('cf-token').value, 't'.repeat(40), '没保存成功就别清空，让人改');

  fail = false;
  phone.$('cf-save').click();
  await flush();
  assert.equal(phone.$('cf-result').textContent, '已保存');
  assert.equal(phone.$('cf-key').value, '');
  assert.equal(phone.$('cf-token').value, '', '只进不出：保存成功就清空');
  assert.equal(phone.$('cf-status').textContent.startsWith('Cloudflare TURN：已配置'), true);

  phone.$('cf-limit').value = '0';
  phone.$('cf-limit-save').click();
  await flush();
  assert.match(phone.$('net-err').textContent, /1 到 1000 之间的整数/);
  phone.$('cf-limit').value = '500';
  phone.$('cf-limit-save').click();
  await flush();
  assert.deepEqual(native.cfCalls.at(-1), { action: 'setLimit', args: { limitGB: 500 } });
  assert.equal(phone.$('cf-usage').textContent, '本月已用 0.00 GB / 500 GB');
});
