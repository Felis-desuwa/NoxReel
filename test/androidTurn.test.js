'use strict';

/**
 * 安卓端的 Cloudflare TURN：页面这一侧的异步桥（native-shim 的 window.sw.turn）和原生层（CloudflareTurn.kt）。
 *
 * 桥是真跑的：假 Native 记下每次 cfCall，测试按请求 id 把结果送回 window.__noxreelNativeReply。
 * Kotlin 这边跑不了 JVM 单测（见 androidNative.test.js 开头的说明），守的是和桌面端
 * src/main/cloudflareTurn.js 一一对应的那几条不变量：Token 只进不出、系统密钥库加密、只认 turn.cloudflare.com、
 * 去掉 53 端口、不跟随跳转、超时和响应体上限、月用量的默认值和范围。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const KT = 'android/app/src/main/java/com/syncwatch/app';
const cfSrc = read(`${KT}/CloudflareTurn.kt`);
const bridgeSrc = read(`${KT}/NativeBridge.kt`);
const activitySrc = read(`${KT}/MainActivity.kt`);
const desktopSrc = read('src/main/cloudflareTurn.js');

/* ------------------------------ 异步桥 ------------------------------ */

const realConsoleLog = console.log;
test.after(() => {
  console.log = realConsoleLog;
});

let shim = null;
async function loadShim() {
  if (shim) return shim;
  console.log = () => {};
  globalThis.window = globalThis.window || {};
  const calls = [];
  globalThis.Native = {
    calls,
    cfCall(id, action, args) {
      calls.push({ id, action, args: JSON.parse(args) });
    },
    log() {},
  };
  await import(pathToFileURL(path.join(root, 'android/app/src/main/assets/js/native-shim.js')).href);
  shim = { calls, reply: (id, json) => globalThis.window.__noxreelNativeReply(id, json) };
  return shim;
}

test('window.sw.turn 和桌面端 preload 同一个签名；参数原样交给原生层，请求 id 对得上原生层的校验', async () => {
  const s = await loadShim();
  const turn = globalThis.window.sw.turn;
  assert.deepEqual(Object.keys(turn).sort(), ['cfClear', 'cfCredentials', 'cfReportUsage', 'cfSave', 'cfSetLimit', 'cfStatus']);
  const pending = [
    turn.cfSave('abcd1234', 'x'.repeat(40)),
    turn.cfClear(),
    turn.cfStatus(),
    turn.cfCredentials({ minValidMs: 7_200_000 }),
    turn.cfReportUsage(12345),
    turn.cfSetLimit(500),
  ];
  const last = s.calls.slice(-6);
  assert.deepEqual(
    last.map((c) => [c.action, c.args]),
    [
      ['save', { keyId: 'abcd1234', apiToken: 'x'.repeat(40) }],
      ['clear', {}],
      ['status', {}],
      ['credentials', { minValidMs: 7_200_000 }],
      ['addUsage', { bytes: 12345 }],
      ['setLimit', { limitGB: 500 }],
    ]
  );
  // 原生层只认 c + 数字的请求 id（NativeBridge.CF_REQ_ID），对不上的它会直接丢掉、页面干等到超时
  const reqId = new RegExp(/CF_REQ_ID = Regex\("([^"]+)"\)/.exec(bridgeSrc)[1]);
  for (const c of last) assert.match(c.id, reqId);
  // 动作集合两边一致
  const actions = /CF_ACTIONS = setOf\(([^)]+)\)/.exec(bridgeSrc)[1].match(/"(\w+)"/g).map((a) => a.slice(1, -1));
  assert.deepEqual(actions.sort(), [...new Set(last.map((c) => c.action))].sort());
  last.forEach((c) => s.reply(c.id, JSON.stringify({ ok: true, value: c.action })));
  assert.deepEqual(await Promise.all(pending), ['save', 'clear', 'status', 'credentials', 'addUsage', 'setLimit']);
});

test('原生层报错按「[CF_XXX] 说明」原样交给页面；回的不是 JSON、id 对不上、重复回复都不出事', async () => {
  const s = await loadShim();
  const turn = globalThis.window.sw.turn;
  const a = turn.cfCredentials();
  const b = turn.cfStatus();
  const [ca, cb] = s.calls.slice(-2);
  s.reply('c999999', JSON.stringify({ ok: true, value: 'nobody' })); // 没有这个请求
  s.reply(ca.id, JSON.stringify({ ok: false, error: '[CF_UNAUTHORIZED] HTTP 401' }));
  s.reply(ca.id, JSON.stringify({ ok: true, value: 'late' })); // 同一个 id 又回一次
  s.reply(cb.id, '{not json');
  await assert.rejects(a, /\[CF_UNAUTHORIZED\] HTTP 401/);
  await assert.rejects(b, /\[CF_BAD_RESPONSE\]/);
});

test('原生层一直不回话：30 秒后按网络不通失败；这个版本的原生层没有 cfCall 时说不支持', async (t) => {
  const s = await loadShim();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const p = globalThis.window.sw.turn.cfStatus();
  assert.ok(s.calls.length);
  t.mock.timers.tick(30_000);
  await assert.rejects(p, /\[CF_NETWORK\] 原生层没有回应/);
  t.mock.timers.reset();

  const cfCall = globalThis.Native.cfCall;
  delete globalThis.Native.cfCall;
  try {
    await assert.rejects(globalThis.window.sw.turn.cfStatus(), /\[CF_NOT_CONFIGURED\]/);
  } finally {
    globalThis.Native.cfCall = cfCall;
  }
});

/* ------------------------------ 原生层 ------------------------------ */

test('API Token 只进不出：系统密钥库 AES-GCM 加密；密钥库用不了就拒存；先验证再落盘', () => {
  assert.match(cfSrc, /KeyStore\.getInstance\(KEYSTORE\)/);
  assert.match(cfSrc, /private const val KEYSTORE = "AndroidKeyStore"/);
  assert.match(cfSrc, /private const val TRANSFORMATION = "AES\/GCM\/NoPadding"/);
  assert.match(cfSrc, /setBlockModes\(KeyProperties\.BLOCK_MODE_GCM\)/);
  const save = cfSrc.slice(cfSrc.indexOf('fun save('), cfSrc.indexOf('private fun readSecret('));
  // 先确认密钥库能用（不能用就 CF_NO_ENCRYPTION），再真的调一次生成接口，成功才写文件
  assert.ok(save.indexOf('secretKey()') < save.indexOf('generate(keyId, apiToken)'), '密钥库要在发请求之前确认');
  assert.ok(save.indexOf('generate(keyId, apiToken)') < save.indexOf('writeAtomic('), '验证通过才落盘');
  assert.match(save, /CF_NO_ENCRYPTION/);
  // 状态里没有 Token、没有 Turn Token ID
  const status = cfSrc.slice(cfSrc.indexOf('fun status()'), cfSrc.indexOf('private fun credsJson('));
  assert.doesNotMatch(status, /apiToken|keyId/);
  // 这个文件不写任何日志；桥上出错只记异常类型
  assert.doesNotMatch(cfSrc, /\bLog\./);
  const call = bridgeSrc.slice(bridgeSrc.indexOf('fun cfCall('), bridgeSrc.indexOf('fun shutdown('));
  assert.doesNotMatch(call, /Log\.[a-z]\(TAG, [^)]*(args|argsJson|e\.message)/);
  assert.match(call, /e\.javaClass\.simpleName/);
});

test('请求：只认 turn.cloudflare.com、去掉 53 端口、不跟随跳转、10 秒超时、响应体 64KB 封顶', () => {
  assert.match(cfSrc, /const val TURN_HOST = "turn\.cloudflare\.com"/);
  assert.match(cfSrc, /BLOCKED_PORTS = setOf\(53\)/);
  assert.match(cfSrc, /instanceFollowRedirects = false/);
  assert.match(cfSrc, /const val REQUEST_TIMEOUT_MS = 10_000/);
  assert.match(cfSrc, /const val MAX_RESPONSE_BYTES = 64 \* 1024/);
  assert.match(cfSrc, /https:\/\/rtc\.live\.cloudflare\.com\/v1\/turn\/keys/);
  assert.match(cfSrc, /\/credentials\/generate-ice-servers/);
  // 地址的认法和桌面端 parseTurnUrl 是同一个正则
  const desktopRe = /\/(\^\(turns\?\):[^/]+\$)\/i/.exec(desktopSrc)[1];
  const ktRe = /TURN_URL = Regex\("([^"]+)"/.exec(cfSrc)[1].replace(/\\\\/g, '\\');
  assert.equal(ktRe, desktopRe);
  // Turn Token ID 的字符集两边一样窄
  assert.match(desktopSrc, /\^\[A-Za-z0-9\]\{8,128\}\$/);
  assert.match(cfSrc, /\^\[A-Za-z0-9\]\{8,128\}\$/);
  // 401/403 算未授权，其余非 2xx 算看不懂
  assert.match(cfSrc, /status == 401 \|\| status == 403\) throw CfException\("CF_UNAUTHORIZED"/);
});

test('临时账号和月用量的几个数和桌面端一致', () => {
  const kt = (name) => {
    const m = new RegExp(`const val ${name} = ([^\\n]+)`).exec(cfSrc);
    assert.ok(m, `${name} 不见了`);
    // eslint-disable-next-line no-new-func
    const expr = m[1].replace(/\/\/.*$/, '').replace(/(\d)_(?=\d)/g, '$1').replace(/(\d)L\b/g, '$1');
    // eslint-disable-next-line no-new-func
    return new Function(`const BYTES_PER_GB = 1e9; return ${expr}`)();
  };
  const js = (name) => {
    const m = new RegExp(`const ${name} = ([^;]+);`).exec(desktopSrc);
    assert.ok(m, `桌面端 ${name} 不见了`);
    // eslint-disable-next-line no-new-func
    return new Function(`return ${m[1].replace(/(\d)_(?=\d)/g, '$1')}`)();
  };
  assert.equal(kt('TTL_SEC'), js('TTL_SEC'));
  assert.equal(kt('CACHE_MARGIN_MS'), js('CACHE_MARGIN_MS'));
  assert.equal(kt('DEFAULT_LIMIT_GB'), js('DEFAULT_LIMIT_GB'));
  assert.equal(kt('MIN_LIMIT_GB'), js('MIN_LIMIT_GB'));
  assert.equal(kt('MAX_LIMIT_GB'), js('MAX_LIMIT_GB'));
  assert.equal(kt('BYTES_PER_GB'), 1e9);
  // 桌面端主进程的 IPC 校验上限
  const main = read('src/main/main.js');
  assert.match(main, /const MAX_TURN_MIN_VALID_MS = 3 \* 60 \* 60 \* 1000;/);
  assert.equal(kt('MAX_MIN_VALID_MS'), 3 * 60 * 60 * 1000);
  assert.match(main, /const MAX_TURN_USAGE_REPORT = 64 \* 1e9;/);
  assert.equal(kt('MAX_USAGE_REPORT'), 64e9);
  // 用量按 UTC 自然月
  assert.match(cfSrc, /TimeZone\.getTimeZone\("UTC"\)/);
  // 参数必须是 JSON 整数（1.5、"12" 都不收）
  const whole = cfSrc.slice(cfSrc.indexOf('fun wholeNumber('), cfSrc.indexOf('fun monthKey('));
  assert.match(whole, /is Int ->/);
  assert.match(whole, /is Long ->/);
  assert.match(whole, /else -> throw CfException\("CF_INVALID_INPUT"/);
});

test('桥：网络调用在单独的后台线程里做，结果切回主线程经 JSONObject.quote 交给页面；WebView 没了就不送', () => {
  assert.match(bridgeSrc, /Executors\.newSingleThreadExecutor/);
  assert.match(bridgeSrc, /cfExecutor\.execute \{/);
  assert.match(bridgeSrc, /argsJson\.length > MAX_CF_ARGS_CHARS/);
  assert.match(activitySrc, /CloudflareTurn\(applicationContext\.filesDir\)/);
  assert.match(activitySrc, /main\.post \{\s*if \(webGone \|\| !::web\.isInitialized\) return@post/);
  assert.match(activitySrc, /window\.__noxreelNativeReply\?\.\(\$\{JSONObject\.quote\(id\)\}, \$\{JSONObject\.quote\(json\)\}\)/);
  assert.match(activitySrc, /bridge\.shutdown\(\)/);
  // 渲染进程没了（界面要重建）时也标记上，迟到的回复别往已销毁的 WebView 上送
  const gone = activitySrc.slice(activitySrc.indexOf('override fun onRenderProcessGone'));
  assert.match(gone.slice(0, 400), /webGone = true/);
});
