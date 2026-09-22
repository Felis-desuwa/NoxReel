'use strict';

/**
 * Cloudflare TURN 自动生成账号 + 本机月用量上限（0.7.6，主进程模块 cloudflareTurn.js）。
 *
 * 不碰外网：请求要么注入假 fetch，要么指到本机 127.0.0.1 上临时起的 http 服务器；
 * safeStorage 用替身（系统密钥服务不参与）；时钟注入，跨月、过期都靠拨表。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const cf = require('../src/main/cloudflareTurn');
const { CloudflareTurn } = cf;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-cfturn-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }));

let dirSeq = 0;
const freshDir = () => {
  const dir = path.join(TMP, `u${++dirSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const KEY_ID = 'abcDEF0123456789';
const TOKEN = 'tok_0123456789abcdefXYZ-._~';
const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 22, 12, 0, 0); // 2026-09-22 12:00 UTC

/** 系统密钥服务的替身：加密结果里看不出原文（按字节翻转再转十六进制）。 */
function fakeSafeStorage({ available = true } = {}) {
  const flip = (buf) => Buffer.from(buf.map((b) => b ^ 0x5a));
  return {
    available,
    isEncryptionAvailable() {
      return this.available;
    },
    encryptString: (text) => Buffer.from(`ENC:${flip(Buffer.from(text, 'utf8')).toString('hex')}`),
    decryptString(buf) {
      const s = Buffer.from(buf).toString('utf8');
      if (!s.startsWith('ENC:')) throw new Error('解不开');
      return flip(Buffer.from(s.slice(4), 'hex')).toString('utf8');
    },
  };
}

const CF_BODY = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
    {
      urls: [
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:53?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp',
        'turn:turn.cloudflare.com:80?transport=tcp',
        'turns:turn.cloudflare.com:5349?transport=tcp',
        'turns:turn.cloudflare.com:443?transport=tcp',
      ],
      username: 'user-from-cloudflare',
      credential: 'secret-from-cloudflare',
    },
  ],
};
const EXPECTED_URLS = [
  'turn:turn.cloudflare.com:3478?transport=udp',
  'turn:turn.cloudflare.com:3478?transport=tcp',
  'turn:turn.cloudflare.com:80?transport=tcp',
  'turns:turn.cloudflare.com:5349?transport=tcp',
  'turns:turn.cloudflare.com:443?transport=tcp',
];

const json = (status, body) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** 假 fetch：记下每次请求，回应由 responder 决定。 */
function fakeFetch(responder = () => json(201, CF_BODY)) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init, calls.length);
  };
  fn.calls = calls;
  return fn;
}

function clock(start = T0) {
  const c = { t: start };
  c.now = () => c.t;
  return c;
}

function make({ dir = freshDir(), fetch = fakeFetch(), safeStorage = fakeSafeStorage(), now = clock(), ...rest } = {}) {
  const turn = new CloudflareTurn({ userDataDir: dir, fetch, safeStorage, now: now.now, ...rest });
  return { turn, dir, fetch, safeStorage, now };
}

const rejectsWith = (promise, code) => assert.rejects(promise, (e) => e.code === code && e.message.startsWith(`[${code}]`));

/* --------------------------------- 格式校验 --------------------------------- */

test('Turn Token ID 只认 8–128 位字母数字；API Token 只认 16–512 位不含空白的可打印字符', () => {
  assert.equal(cf.isValidKeyId('a'.repeat(8)), true);
  assert.equal(cf.isValidKeyId('A1'.repeat(64)), true);
  for (const bad of ['a'.repeat(7), 'a'.repeat(129), 'abc-defgh', 'abcdefgh/../x', 'abcdefgh ', '中文中文中文中文', 12345678, null]) {
    assert.equal(cf.isValidKeyId(bad), false, String(bad));
  }
  assert.equal(cf.isValidApiToken('x'.repeat(16)), true);
  assert.equal(cf.isValidApiToken('!~'.repeat(256)), true);
  for (const bad of ['x'.repeat(15), 'x'.repeat(513), `${'x'.repeat(16)} `, `${'x'.repeat(16)}\n`, `${'x'.repeat(16)}\t`, `${'x'.repeat(16)}é`, undefined]) {
    assert.equal(cf.isValidApiToken(bad), false, JSON.stringify(bad));
  }
});

test('security.js 的校验报错只说是哪个字段，不把值本身带出去', () => {
  const validate = require('../src/main/security');
  assert.equal(validate.cfKeyId(KEY_ID), KEY_ID);
  assert.equal(validate.cfApiToken(TOKEN), TOKEN);
  const leaky = `${TOKEN} with space`;
  assert.throws(() => validate.cfApiToken(leaky), (e) => e.message === '无效的 API Token' && !e.message.includes(TOKEN));
  assert.throws(() => validate.cfKeyId('bad id!'), /^TypeError: 无效的 Turn Token ID$/);
});

/* ---------------------------------- 保存 ---------------------------------- */

test('保存：格式不对的当场拒，不发请求、不落盘', async () => {
  const { turn, fetch, dir } = make();
  await rejectsWith(turn.save({ keyId: 'short', apiToken: TOKEN }), 'CF_INVALID_INPUT');
  await rejectsWith(turn.save({ keyId: KEY_ID, apiToken: 'has space in it!!' }), 'CF_INVALID_INPUT');
  assert.equal(fetch.calls.length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'cloudflare-turn.json')), false);
});

test('保存：系统加密服务不可用就拒绝保存，并说明原因（宁可不存，也不明文落盘）', async () => {
  const { turn, fetch, dir } = make({ safeStorage: fakeSafeStorage({ available: false }) });
  await assert.rejects(turn.save({ keyId: KEY_ID, apiToken: TOKEN }), (e) => e.code === 'CF_NO_ENCRYPTION' && /加密服务不可用/.test(e.message));
  assert.equal(fetch.calls.length, 0, '存不了就别白调一次接口');
  assert.equal(fs.existsSync(path.join(dir, 'cloudflare-turn.json')), false);
  // 连 safeStorage 都没有（比如还没 ready）也一样
  const bare = new CloudflareTurn({ userDataDir: freshDir(), fetch: fakeFetch() });
  await rejectsWith(bare.save({ keyId: KEY_ID, apiToken: TOKEN }), 'CF_NO_ENCRYPTION');
});

test('保存：Cloudflare 说 401/403 → CF_UNAUTHORIZED，什么都不存', async () => {
  for (const status of [401, 403]) {
    const { turn, dir } = make({ fetch: fakeFetch(() => json(status, { success: false })) });
    await rejectsWith(turn.save({ keyId: KEY_ID, apiToken: TOKEN }), 'CF_UNAUTHORIZED');
    assert.equal(fs.existsSync(path.join(dir, 'cloudflare-turn.json')), false, `${status} 之后不该保存`);
    assert.equal(turn.status().configured, false);
  }
});

test('保存成功：先真的调一次生成接口，加密落盘；状态里没有 Token；验证拿到的账号直接进缓存', async () => {
  const { turn, fetch, dir } = make();
  const state = await turn.save({ keyId: KEY_ID, apiToken: TOKEN });
  assert.equal(fetch.calls.length, 1);
  const { url, init } = fetch.calls[0];
  assert.equal(url, `https://rtc.live.cloudflare.com/v1/turn/keys/${KEY_ID}/credentials/generate-ice-servers`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(init.body), { ttl: 86400 });
  assert.equal(init.redirect, 'error', '带着 Authorization 被跳转引到别处去不行');
  assert.ok(init.signal, '要能超时中止');

  const file = fs.readFileSync(path.join(dir, 'cloudflare-turn.json'), 'utf8');
  assert.ok(!file.includes(TOKEN), '凭据文件里不能有明文 Token');
  assert.ok(!file.includes(KEY_ID), 'Turn Token ID 也一起加密');
  assert.equal(JSON.parse(file).version, 1);

  assert.equal(state.configured, true);
  assert.equal(state.lastError, null);
  assert.equal(state.expiresAt, T0 + 86400 * 1000 - HOUR);
  assert.ok(!JSON.stringify(state).includes(TOKEN) && !JSON.stringify(state).includes(KEY_ID));
  assert.deepEqual(Object.keys(state).sort(), ['configured', 'expiresAt', 'lastError', 'usage']);

  const creds = await turn.credentials();
  assert.equal(fetch.calls.length, 1, '刚验证过的账号直接复用');
  assert.deepEqual(creds.urls, EXPECTED_URLS);
});

/* --------------------------------- 生成账号 --------------------------------- */

async function configured(opts = {}) {
  const ctx = make(opts);
  const setup = new CloudflareTurn({ storePath: ctx.turn.storePath, usagePath: ctx.turn.usagePath, fetch: fakeFetch(), safeStorage: ctx.safeStorage, now: ctx.now.now });
  await setup.save({ keyId: KEY_ID, apiToken: TOKEN });
  return ctx;
}

test('生成账号：从落盘的凭据解密出 Token 去请求，只留 turn.cloudflare.com 上的 turn/turns 地址，去掉 53 端口', async () => {
  const { turn, fetch } = await configured();
  const creds = await turn.credentials();
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(creds.urls, EXPECTED_URLS);
  assert.ok(!creds.urls.some((u) => /:53\b/.test(u)), '53 端口会被浏览器拦下，候选收集要干等到超时');
  assert.equal(creds.username, 'user-from-cloudflare');
  assert.equal(creds.credential, 'secret-from-cloudflare');
  assert.equal(creds.expiresAt, T0 + 86400 * 1000 - HOUR);
});

test('响应校验：别的主机、别的协议、奇怪的参数一律不要；老接口的单个对象也认', () => {
  const picked = cf.pickTurnServer({
    iceServers: [
      {
        urls: [
          'turn:evil.example:3478',
          'turn:turn.cloudflare.com.evil.example:3478',
          'turn:turn.cloudflare.com:3478?transport=udp&x=1',
          'turn:turn.cloudflare.com:99999',
          'turns:turn.cloudflare.com:53?transport=tcp',
          'stun:turn.cloudflare.com:3478',
          'turn:TURN.cloudflare.com:3478',
        ],
        username: 'u',
        credential: 'c',
      },
    ],
  });
  assert.deepEqual(picked.urls, ['turn:TURN.cloudflare.com:3478']);
  const legacy = cf.pickTurnServer({ iceServers: { urls: 'turn:turn.cloudflare.com:3478', username: 'u', credential: 'c' } });
  assert.deepEqual(legacy.urls, ['turn:turn.cloudflare.com:3478']);
  assert.throws(() => cf.pickTurnServer({ iceServers: [{ urls: ['turn:evil.example:3478'], username: 'u', credential: 'c' }] }), (e) => e.code === 'CF_BAD_RESPONSE');
  const long = 'x'.repeat(1025);
  assert.throws(() => cf.pickTurnServer({ iceServers: [{ urls: ['turn:turn.cloudflare.com:3478'], username: long, credential: 'c' }] }), (e) => e.code === 'CF_BAD_RESPONSE');
  assert.throws(() => cf.pickTurnServer({ iceServers: [{ urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 42 }] }), (e) => e.code === 'CF_BAD_RESPONSE');
  assert.equal(cf.pickTurnServer({ iceServers: [{ urls: ['turn:turn.cloudflare.com:3478'], username: 'u'.repeat(1024), credential: 'c' }] }).username.length, 1024);
});

test('缓存：到「生成时刻 + ttl − 1 小时」之前直接复用，过了才重新生成；minValidMs 不够就提前换', async () => {
  const { turn, fetch, now } = await configured();
  await turn.credentials();
  now.t = T0 + 86400 * 1000 - HOUR - 1;
  await turn.credentials();
  assert.equal(fetch.calls.length, 1, '缓存期内又去请求了');
  now.t = T0 + 86400 * 1000 - HOUR;
  const fresh = await turn.credentials();
  assert.equal(fetch.calls.length, 2, '过期了还在用旧的');
  assert.equal(fresh.expiresAt, now.t + 86400 * 1000 - HOUR);

  // 离过期还剩 1.5 小时：普通调用复用，要求至少剩 2 小时的换一组
  now.t = fresh.expiresAt - 1.5 * HOUR;
  await turn.credentials();
  assert.equal(fetch.calls.length, 2);
  await turn.credentials({ minValidMs: 2 * HOUR });
  assert.equal(fetch.calls.length, 3);
});

test('同时只发一个请求：几路一起要，共用同一次生成', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { turn, fetch } = await configured({ fetch: fakeFetch(async () => (await gate, json(201, CF_BODY))) });
  const all = [turn.credentials(), turn.credentials(), turn.credentials({ minValidMs: HOUR })];
  await new Promise((r) => setImmediate(r));
  release();
  const results = await Promise.all(all);
  assert.equal(fetch.calls.length, 1);
  for (const r of results) assert.deepEqual(r.urls, EXPECTED_URLS);
});

test('失败归类：网络 → CF_NETWORK，其他状态码 / 坏 JSON / 没有 TURN → CF_BAD_RESPONSE，没配置 → CF_NOT_CONFIGURED；报错里没有 Token', async () => {
  const cases = [
    [() => Promise.reject(new TypeError('fetch failed')), 'CF_NETWORK'],
    [() => json(500, { error: 'x' }), 'CF_BAD_RESPONSE'],
    [() => json(404, { error: 'x' }), 'CF_BAD_RESPONSE'],
    [() => json(201, 'not json {'), 'CF_BAD_RESPONSE'],
    [() => json(201, { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }] }), 'CF_BAD_RESPONSE'],
    [() => json(201, { nothing: true }), 'CF_BAD_RESPONSE'],
  ];
  for (const [responder, code] of cases) {
    const { turn } = await configured({ fetch: fakeFetch(responder) });
    await assert.rejects(turn.credentials(), (e) => {
      assert.equal(e.code, code);
      assert.ok(!e.message.includes(TOKEN) && !e.message.includes(KEY_ID), '报错里带出了凭据');
      return true;
    });
    assert.equal(turn.status().lastError, code, 'status 要能说出上次为什么失败');
  }
  const { turn, fetch } = make();
  await rejectsWith(turn.credentials(), 'CF_NOT_CONFIGURED');
  assert.equal(fetch.calls.length, 0);
});

test('凭据文件坏了或解不开：当成没配置，不去请求', async () => {
  const { turn, fetch, dir } = make();
  fs.writeFileSync(path.join(dir, 'cloudflare-turn.json'), '{"version":1,"secret":"bm90LWVuY3J5cHRlZA=="}');
  await rejectsWith(turn.credentials(), 'CF_NOT_CONFIGURED');
  fs.writeFileSync(path.join(dir, 'cloudflare-turn.json'), 'garbage');
  await rejectsWith(turn.credentials(), 'CF_NOT_CONFIGURED');
  assert.equal(fetch.calls.length, 0);
});

/* ------------------------------ 真的走一遍 HTTP ------------------------------ */

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('本机假服务器：响应体超过 64KB 拒收；迟迟不回的 10 秒（这里调成 300ms）就放弃', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      if (req.url.includes('/BIGBIGBIG/')) {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...CF_BODY, pad: 'x'.repeat(70 * 1024) }));
      } else if (req.url.includes('/SLOWSLOW/')) {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.write('{"iceServers":');
        // 故意不结束
      } else {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify(CF_BODY));
      }
    });
  });
  const port = await listen(server);
  const endpoint = `http://127.0.0.1:${port}/v1/turn/keys`;
  try {
    const ok = new CloudflareTurn({ userDataDir: freshDir(), safeStorage: fakeSafeStorage(), endpoint });
    await ok.save({ keyId: KEY_ID, apiToken: TOKEN });
    assert.equal(seen[0].url, `/v1/turn/keys/${KEY_ID}/credentials/generate-ice-servers`);
    assert.equal(seen[0].auth, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(seen[0].body), { ttl: 86400 });

    const big = new CloudflareTurn({ userDataDir: freshDir(), safeStorage: fakeSafeStorage(), endpoint });
    await assert.rejects(big.save({ keyId: 'BIGBIGBIG', apiToken: TOKEN }), (e) => e.code === 'CF_BAD_RESPONSE' && /过大/.test(e.message));

    const slow = new CloudflareTurn({ userDataDir: freshDir(), safeStorage: fakeSafeStorage(), endpoint, timeoutMs: 300 });
    const started = Date.now();
    await rejectsWith(slow.save({ keyId: 'SLOWSLOW', apiToken: TOKEN }), 'CF_NETWORK');
    assert.ok(Date.now() - started < 5000, '超时没生效');
    assert.equal(cf.REQUEST_TIMEOUT_MS, 10_000);
    assert.equal(cf.MAX_RESPONSE_BYTES, 64 * 1024);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

/* ---------------------------------- 清除 ---------------------------------- */

test('清除：删掉凭据文件、清缓存，之后要账号就是没配置', async () => {
  const { turn, dir } = await configured();
  await turn.credentials();
  const state = await turn.clear();
  assert.equal(state.configured, false);
  assert.equal(state.expiresAt, null);
  assert.equal(fs.existsSync(path.join(dir, 'cloudflare-turn.json')), false);
  await rejectsWith(turn.credentials(), 'CF_NOT_CONFIGURED');
});

test('清除时在途的请求：回来的账号不再写进缓存', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { turn } = await configured({ fetch: fakeFetch(async () => (await gate, json(201, CF_BODY))) });
  const pending = turn.credentials();
  await new Promise((r) => setImmediate(r));
  await turn.clear();
  release();
  await pending.catch(() => {});
  assert.equal(turn.status().expiresAt, null, '清除之后缓存里又冒出一组账号');
});

/* --------------------------------- 月用量 --------------------------------- */

test('用量：增量累加并落盘，重开软件接着算', async () => {
  const dir = freshDir();
  const now = clock();
  const a = make({ dir, now }).turn;
  await a.addUsage(1_000_000);
  const after = await a.addUsage(2_500_000);
  assert.equal(after.usedBytes, 3_500_000);
  assert.equal(after.month, '2026-09');
  assert.equal(after.limitGB, 900, '默认上限 900 GB（免费 1000 GB 留 100 GB 余量）');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'cloudflare-turn-usage.json'), 'utf8'));
  assert.equal(saved.usedBytes, 3_500_000);

  const b = make({ dir, now }).turn;
  assert.equal(b.usage().usedBytes, 3_500_000, '重开之后从零算了');
  assert.equal((await b.addUsage(500_000)).usedBytes, 4_000_000);
  await assert.rejects(b.addUsage(-1), /无效/);
  await assert.rejects(b.addUsage(1.5), /无效/);
});

test('用量：按 UTC 自然月累计，跨月清零（上限不清）', async () => {
  const dir = freshDir();
  const now = clock(Date.UTC(2026, 8, 30, 23, 59, 0));
  const turn = make({ dir, now }).turn;
  await turn.setLimit(100);
  await turn.addUsage(5e9);
  assert.equal(turn.usage().usedBytes, 5e9);
  // 本地时区还在 9 月 30 日也好，UTC 已经是 10 月 1 日
  now.t = Date.UTC(2026, 9, 1, 0, 0, 1);
  assert.equal(turn.usage().month, '2026-10');
  assert.equal(turn.usage().usedBytes, 0);
  assert.equal(turn.usage().limitGB, 100);
  assert.equal((await turn.addUsage(1)).usedBytes, 1);
  // 重开也认得出是新的一个月
  now.t = Date.UTC(2026, 10, 2);
  assert.equal(make({ dir, now }).turn.usage().usedBytes, 0);
  assert.equal(cf.monthKey(Date.UTC(2026, 0, 1)), '2026-01');
});

test('用量：到 80% 提醒一次（每个月一次）；到上限就拒绝生成新账号（连缓存都不给）', async () => {
  const { turn, fetch, now } = await configured();
  await turn.credentials();
  await turn.setLimit(10);
  const below = await turn.addUsage(7.9e9);
  assert.equal(below.crossedWarn, false);
  assert.equal(below.nearLimit, false);
  const warn = await turn.addUsage(0.2e9);
  assert.equal(warn.crossedWarn, true, '过 80% 要提醒');
  assert.equal(warn.nearLimit, true);
  assert.equal((await turn.addUsage(0.1e9)).crossedWarn, false, '只提醒一次');

  const full = await turn.addUsage(1.8e9);
  assert.equal(full.exceeded, true);
  const calls = fetch.calls.length;
  await assert.rejects(turn.credentials(), (e) => e.code === 'CF_QUOTA' && /10 GB/.test(e.message));
  assert.equal(fetch.calls.length, calls, '到上限了还去 Cloudflare 生成账号');
  assert.equal(turn.status().lastError, 'CF_QUOTA');
  assert.equal(turn.status().usage.exceeded, true);

  // 调高上限：立刻恢复；下个月 1 日也自动恢复
  await turn.setLimit(20);
  assert.equal((await turn.credentials()).username, 'user-from-cloudflare');
  await turn.setLimit(10);
  await rejectsWith(turn.credentials(), 'CF_QUOTA');
  now.t = Date.UTC(2026, 9, 1, 0, 0, 0);
  assert.equal(turn.usage().exceeded, false);
  await turn.credentials();
});

test('上限的读写：只收 1–1000 的整数，存在主进程的 userData 里，重开还在', async () => {
  const dir = freshDir();
  const turn = make({ dir }).turn;
  for (const bad of [0, 1001, 1.5, -3, '500', null, NaN]) await assert.rejects(turn.setLimit(bad), /无效/, String(bad));
  assert.equal(turn.usage().limitGB, 900);
  const set = await turn.setLimit(250);
  assert.equal(set.limitGB, 250);
  assert.equal(set.limitBytes, 250e9);
  assert.equal(make({ dir }).turn.usage().limitGB, 250);
  // 文件坏了：从零开始、上限回到默认值，不能把软件卡住
  fs.writeFileSync(path.join(dir, 'cloudflare-turn-usage.json'), '{ broken');
  const fresh = make({ dir }).turn.usage();
  assert.equal(fresh.limitGB, 900);
  assert.equal(fresh.usedBytes, 0);
  assert.equal(cf.MIN_LIMIT_GB, 1);
  assert.equal(cf.MAX_LIMIT_GB, 1000);
  assert.equal(cf.DEFAULT_LIMIT_GB, 900);
});

test('调高上限回到 80% 以下：下次再过 80% 还会提醒', async () => {
  const turn = make().turn;
  await turn.setLimit(10);
  assert.equal((await turn.addUsage(8.5e9)).crossedWarn, true);
  await turn.setLimit(100);
  assert.equal((await turn.addUsage(1e9)).crossedWarn, false);
  assert.equal((await turn.addUsage(71e9)).crossedWarn, true);
});
