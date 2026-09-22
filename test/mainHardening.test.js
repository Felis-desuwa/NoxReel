'use strict';

/**
 * 主进程加固（0.7.5 审查，main 组）。
 *
 * 覆盖：preload 不再暴露按路径批准片源、缓存目录只认对话框挑的、过滤代理（SSRF 根治）、
 * 统一的私网判定、Defender 结果分类、ffmpeg 候选顺序、桥接 stdin 的 EPIPE、Discord 握手串线，
 * 以及一批 DoS 上限（Discord 帧、mpv IPC 行、桥 stdout 行、测速 / 地区探测响应体、
 * 覆盖窗消息、探测子进程超时、链接解析并发、IPC 参数类型）。
 *
 * 全程静音：真的起 mpv 的那两条只带 --vo=null --ao=null --idle=no，没有窗口也没有声音；
 * 网络只连本机 127.0.0.1 上临时起的服务器。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const REPO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-main-hardening-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error(`等不到：${label}`);
}

/** 给一个 promise 加上限：被测代码退回到「挂住不返回」时，测试要红，而不是跟着挂住。 */
function within(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}：${ms}ms 内没有结束`)), ms);
    }),
  ]);
}

test.after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }));

/* ========================= 假 electron（必须最先装上） ========================= */
// src/main 里有模块一加载就 require('electron')；Node 按目录缓存模块解析结果，
// 装晚了 preload / main 拿到的就是真的 electron 包（在 Node 里只是一个路径字符串）。

const MAIN_PAGE_URL = pathToFileURL(path.join(REPO, 'src', 'renderer', 'index.html')).href;
const paths = {
  userData: path.join(TMP, 'userData'),
  temp: path.join(TMP, 'systemp'),
  downloads: path.join(TMP, 'downloads'),
};
for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true });

const handlers = new Map();
const appEvents = new Map();
const windows = [];
let exposed = null;
const preloadInvokes = [];
let nextDialogPick = null;
let droppedPath = '';
let readyResolve;
const ready = new Promise((resolve) => (readyResolve = resolve));

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.minimized = false;
    this.visible = true;
    this.calls = [];
    this.webContents = new EventEmitter();
    this.webContents.mainFrame = { url: MAIN_PAGE_URL };
    this.webContents.send = () => {};
    this.webContents.session = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} };
    this.webContents.setWindowOpenHandler = () => {};
    this.webContents.isLoadingMainFrame = () => false;
    windows.push(this);
  }
  setMenuBarVisibility() {}
  loadFile() {}
  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return this.minimized;
  }
  restore() {
    this.calls.push('restore');
    this.minimized = false;
  }
  show() {
    this.calls.push('show');
    this.visible = true;
  }
  focus() {
    this.calls.push('focus');
  }
}

const fakeElectron = {
  app: {
    isPackaged: false,
    getPath: (key) => paths[key],
    setPath: (key, value) => (paths[key] = value),
    getVersion: () => '0.7.5-test',
    enableSandbox() {},
    commandLine: { appendSwitch() {} },
    requestSingleInstanceLock: () => true,
    whenReady: () => ready,
    setAsDefaultProtocolClient() {},
    on(name, fn) {
      const list = appEvents.get(name) || [];
      list.push(fn);
      appEvents.set(name, list);
    },
    quit() {},
  },
  BrowserWindow: Object.assign(FakeWindow, { getAllWindows: () => windows.filter((w) => !w.destroyed) }),
  ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
  dialog: {
    showOpenDialog: async () => {
      const picked = nextDialogPick;
      nextDialogPick = null;
      return picked ? { canceled: false, filePaths: [picked] } : { canceled: true, filePaths: [] };
    },
  },
  shell: { openExternal: async () => {}, showItemInFolder() {} },
  clipboard: { writeText() {} },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
  globalShortcut: { register: () => true, unregister() {}, unregisterAll() {} },
  session: {},
  // preload 用的三样
  contextBridge: { exposeInMainWorld: (_name, api) => (exposed = api) },
  ipcRenderer: {
    invoke: async (channel, ...args) => {
      preloadInvokes.push([channel, ...args]);
      return 'approved';
    },
    on() {},
    off() {},
  },
  webUtils: { getPathForFile: () => droppedPath },
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-fake-main-hardening';
  return originalResolve.call(this, request, ...rest);
};
require.cache['electron-fake-main-hardening'] = {
  id: 'electron-fake-main-hardening',
  filename: 'electron-fake-main-hardening',
  loaded: true,
  exports: fakeElectron,
};
test.after(() => {
  Module._resolveFilename = originalResolve;
});

/* =============================== 统一的私网判定 =============================== */

const { isPublicIp, resolvePublic, publicLookup } = require('../src/main/ipGuard');

test('ipGuard：各种写法的内网 / 保留地址都不算公网', () => {
  const blocked = [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '100.64.0.1',
    '0.0.0.0', '255.255.255.255', '224.0.0.1', '192.0.0.1', '198.18.0.1', '203.0.113.5',
    '::1', '::', 'fe80::1', 'fe80::1%12', 'febf::1', 'fec0::1', 'fc00::1', 'fd12::1', 'ff02::1',
    // WHATWG URL 会把 [::ffff:127.0.0.1] 规范成 [::ffff:7f00:1]，原来 linkMedia 只认点分写法
    '::ffff:127.0.0.1', '::ffff:7f00:1', '[::ffff:7f00:1]', '::ffff:c0a8:101',
    '::7f00:1', '::127.0.0.1', '::ffff:0:7f00:1', '64:ff9b::7f00:1', '64:ff9b:1::1',
    '2002:c0a8:0101::1', '2001:db8::1', '2001::1', '3fff::1', '100::1',
    'localhost', '', 'not-an-ip',
  ];
  for (const ip of blocked) assert.equal(isPublicIp(ip), false, ip);
  const allowed = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '::ffff:8.8.8.8', '::ffff:808:808', '2606:4700:4700::1111', '64:ff9b::808:808', '2002:0808:0808::1'];
  for (const ip of allowed) assert.equal(isPublicIp(ip), true, ip);
});

test('ipGuard：解析结果里只要混进一个内网地址就整体拒绝（DNS 重绑定常见配法）', async () => {
  const mixed = async () => [{ address: '8.8.8.8', family: 4 }, { address: '192.168.1.1', family: 4 }];
  await assert.rejects(resolvePublic('evil.test', { lookup: mixed }), (e) => e.code === 'ENOTPUBLIC');
  const clean = async () => [{ address: '8.8.8.8', family: 4 }];
  assert.deepEqual(await resolvePublic('ok.test', { lookup: clean }), [{ address: '8.8.8.8', family: 4 }]);
  await assert.rejects(resolvePublic('localhost'), (e) => e.code === 'ENOTPUBLIC');
  await assert.rejects(resolvePublic('[::ffff:7f00:1]'), (e) => e.code === 'ENOTPUBLIC');
  // 给 http.request 的 lookup 用：本机名字解析出来是回环，必须报错而不是交出地址
  await new Promise((resolve) => {
    publicLookup('localhost', { all: true }, (error, list) => {
      assert.equal(error && error.code, 'ENOTPUBLIC');
      assert.equal(list, undefined);
      resolve();
    });
  });
});

test('publicHttpUrl 与隔离浏览器用的是同一份判据', async () => {
  const validate = require('../src/main/security');
  for (const url of ['http://[::ffff:c0a8:101]/', 'http://[fec0::1]/', 'http://[64:ff9b::7f00:1]/', 'http://[::7f00:1]/', 'http://[2002:7f00:1::]/']) {
    await assert.rejects(validate.publicHttpUrl(url), /无效/, url);
  }
  const { isBlockedLiteral } = require('../src/main/browserMediaResolver');
  assert.equal(isBlockedLiteral('http://[::ffff:7f00:1]/x.m3u8'), true);
  assert.equal(isBlockedLiteral('http://192.0.0.1/x.m3u8'), true);
  assert.equal(isBlockedLiteral('https://cdn.example/x.m3u8'), false);
});

/* ============================== linkMedia 的预检 ============================== */

const linkMedia = require('../src/main/linkMedia');

test('跳转链预检认得十六进制写法的 IPv4 映射地址和整段 fe80::/10', async () => {
  assert.equal(await linkMedia.hostIsPublic('::ffff:7f00:1'), false);
  assert.equal(await linkMedia.hostIsPublic('[::ffff:c0a8:101]'), false);
  assert.equal(await linkMedia.hostIsPublic('fe90::1'), false);
  assert.equal(await linkMedia.hostIsPublic('8.8.8.8'), true);

  const head = async () => ({ status: 302, location: 'http://[::ffff:127.0.0.1]:8080/admin' });
  await assert.rejects(linkMedia.assertRedirectChainIsPublic('https://example.test/v', { head }), (e) => e.code === 'PRIVATE_REDIRECT');
});

test('预检自己发的 HEAD 也在连接那一刻判定：打不到本机服务器', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    res.end('x');
  });
  const port = await listen(server);
  try {
    await assert.rejects(linkMedia.headOnce(`http://127.0.0.1:${port}/`), (e) => e.code === 'ENOTPUBLIC');
    await assert.rejects(linkMedia.headOnce(`http://[::ffff:7f00:1]:${port}/`), (e) => e.code === 'ENOTPUBLIC');
    // 名字解析到回环：走的是 publicLookup，一样打不到
    await assert.rejects(linkMedia.headOnce(`http://localhost:${port}/`));
    assert.equal(hits, 0);
  } finally {
    server.close();
  }
});

test('主进程自己跑的 yt-dlp 带上过滤代理，子进程环境去掉 no_proxy', () => {
  const args = linkMedia.ytDlpArgs('https://example.test/v', null, 'http://u:p@127.0.0.1:9');
  const at = args.indexOf('--proxy');
  assert.ok(at >= 0 && args[at + 1] === 'http://u:p@127.0.0.1:9');
  assert.equal(args.at(-1), 'https://example.test/v');
  assert.ok(!linkMedia.ytDlpArgs('https://example.test/v').includes('--proxy'));
  const env = linkMedia.childEnv({ PATH: 'x', no_proxy: '*', NO_PROXY: '*' });
  assert.deepEqual(Object.keys(env), ['PATH']);
});

/* ================================ 过滤代理 ================================ */

const { PublicProxy } = require('../src/main/publicProxy');

/** 把 public.test 当成公网（指向本机的测试服务器），其余照真实规则判。 */
const fakePublic = async (host) => (host === 'public.test' ? [{ address: '127.0.0.1', family: 4 }] : resolvePublic(host));

function authHeader(proxy) {
  return `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`;
}

/** 经代理发一个绝对地址形式的请求，返回 {status, headers, body}。 */
function viaProxy(proxy, target, { auth = true, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxy.port,
      method: 'GET',
      path: target,
      headers: { ...(auth ? { 'Proxy-Authorization': authHeader(proxy) } : {}), ...headers },
      agent: false,
    });
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 发一个 CONNECT，返回 {status, socket}。 */
function connectVia(proxy, authority, { auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxy.port,
      method: 'CONNECT',
      path: authority,
      headers: auth ? { 'Proxy-Authorization': authHeader(proxy) } : {},
      agent: false,
    });
    req.on('connect', (res, socket) => resolve({ status: res.statusCode, socket, headers: res.headers }));
    req.on('response', (res) => {
      res.resume();
      resolve({ status: res.statusCode, headers: res.headers });
    });
    req.on('error', reject);
    req.end();
  });
}

test('过滤代理：没带凭据的一律 407，带着的才转发', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers);
    res.end('hello');
  });
  const port = await listen(upstream);
  const proxy = new PublicProxy({ resolve: fakePublic });
  await proxy.start();
  try {
    assert.match(proxy.url, /^http:\/\/[0-9a-f]+:[0-9a-f]+@127\.0\.0\.1:\d+$/);
    const denied = await viaProxy(proxy, `http://public.test:${port}/a`, { auth: false });
    assert.equal(denied.status, 407);
    assert.match(String(denied.headers['proxy-authenticate']), /^Basic /);
    const wrong = await viaProxy(proxy, `http://public.test:${port}/a`, { auth: false, headers: { 'Proxy-Authorization': 'Basic Zm9vOmJhcg==' } });
    assert.equal(wrong.status, 407);
    assert.equal((await connectVia(proxy, `public.test:${port}`, { auth: false })).status, 407);
    assert.equal(seen.length, 0, '没认证的请求一个都不许转出去');

    const ok = await viaProxy(proxy, `http://public.test:${port}/a`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body, 'hello');
    // 我们自己的凭据绝不能转给上游
    assert.equal(seen.length, 1);
    assert.equal(seen[0]['proxy-authorization'], undefined);
    assert.equal(seen[0].host, `public.test:${port}`);
  } finally {
    await proxy.close();
    upstream.close();
  }
});

test('过滤代理：跳转到内网的下一跳、CONNECT 到内网，都在代理处 403', async () => {
  let internalHits = 0;
  const internal = http.createServer((req, res) => {
    internalHits++;
    res.end('secret');
  });
  const A = await listen(internal);
  const pub = http.createServer((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${A}/secret` });
    res.end();
  });
  const B = await listen(pub);
  const proxy = new PublicProxy({ resolve: fakePublic });
  await proxy.start();
  try {
    // 代理不替客户端跟随跳转：302 原样交回，客户端的下一跳还得经过代理
    const first = await viaProxy(proxy, `http://public.test:${B}/`);
    assert.equal(first.status, 302);
    const second = await viaProxy(proxy, first.headers.location);
    assert.equal(second.status, 403);
    assert.equal((await viaProxy(proxy, `http://[::ffff:7f00:1]:${A}/`)).status, 403);
    assert.equal((await viaProxy(proxy, `http://localhost:${A}/`)).status, 403);
    assert.equal((await connectVia(proxy, `127.0.0.1:${A}`)).status, 403);
    assert.equal((await connectVia(proxy, `[::1]:${A}`)).status, 403);
    assert.equal(internalHits, 0, '内网服务器一次都不该被连到');
    assert.ok(proxy.blocked.some((b) => b.host === '127.0.0.1' && b.port === A));
  } finally {
    await proxy.close();
    internal.close();
    pub.close();
  }
});

test('过滤代理：CONNECT 连的是判定过的那个 IP（主机名根本解析不了也能连上）', async () => {
  const echo = net.createServer((s) => s.pipe(s));
  const port = await listen(echo);
  const proxy = new PublicProxy({ resolve: fakePublic });
  await proxy.start();
  try {
    const { status, socket } = await connectVia(proxy, `public.test:${port}`);
    assert.equal(status, 200);
    const echoed = await new Promise((resolve) => {
      socket.once('data', (d) => resolve(d.toString()));
      socket.write('ping');
    });
    assert.equal(echoed, 'ping');
    socket.destroy();
  } finally {
    await proxy.close();
    echo.close();
  }
});

test('过滤代理：并发连接数有上限，慢慢发请求头的连接会被超时掐掉', async () => {
  const proxy = new PublicProxy({ resolve: fakePublic, maxConnections: 2, headersTimeoutMs: 1000 });
  await proxy.start();
  const sockets = [];
  try {
    for (let i = 0; i < 3; i++) {
      const s = net.connect(proxy.port, '127.0.0.1');
      s.on('error', () => {});
      s.gone = false;
      s.on('close', () => (s.gone = true));
      s.resume(); // 不读的话 end / close 永远不触发
      sockets.push(s);
      await new Promise((resolve) => s.once('connect', resolve));
      s.write('GET http://public.test/ HTTP/1.1\r\n'); // 请求头故意不发完
    }
    await waitFor(() => sockets[2].gone, '超出上限的连接当场被拒', 400);
    assert.equal(sockets[0].gone || sockets[1].gone, false, '名额内的连接不该这么快被断');
    // 占着名额不发完请求头的，headersTimeout 到了要被收掉
    await waitFor(() => sockets[0].gone && sockets[1].gone, '慢速请求头被掐断', 5000);
  } finally {
    for (const s of sockets) s.destroy();
    await proxy.close();
  }
});

/* ============================ mpv 的网络参数 ============================ */

const mpvModule = require('../src/main/mpv');

test('mpv 启动参数：远程源经代理 + 协议白名单，本地文件关掉引用跟随', () => {
  const proxy = 'http://u:p@127.0.0.1:9';
  const remote = mpvModule.buildLaunchArgs({ ipcPath: 'x', source: 'https://example.test/v', proxy });
  assert.ok(remote.includes(`--http-proxy=${proxy}`));
  // ytdl_hook 不会把 --http-proxy 转给 yt-dlp（mpv v0.41 实测），必须经 ytdl-raw-options 单给
  assert.ok(remote.includes(`--ytdl-raw-options-append=proxy=${proxy}`));
  assert.ok(remote.includes(`--stream-lavf-o-append=protocol_whitelist=${mpvModule.REMOTE_PROTOCOLS}`));
  assert.ok(remote.includes(`--demuxer-lavf-o-append=protocol_whitelist=${mpvModule.REMOTE_PROTOCOLS}`));
  assert.ok(!mpvModule.REMOTE_PROTOCOLS.split(',').some((p) => ['ftp', 'rtmp', 'rtsp', 'file', 'udp'].includes(p)));
  assert.ok(remote.indexOf('--') < remote.length - 1 && remote.at(-1) === 'https://example.test/v');

  const local = mpvModule.buildLaunchArgs({ ipcPath: 'x', source: 'C:\\films\\a.mkv', proxy });
  assert.ok(local.includes('--access-references=no'));
  assert.ok(local.includes(`--http-proxy=${proxy}`));
  assert.ok(!local.some((a) => a.startsWith('--ytdl-raw-options')));

  const env = mpvModule.childEnv({ PATH: 'x', no_proxy: '*', No_Proxy: '*' });
  assert.deepEqual(Object.keys(env), ['PATH']);
});

const MPV_BIN = path.join(REPO, 'vendor', 'bin', 'mpv.exe');
const YTDLP_BIN = path.join(REPO, 'vendor', 'bin', 'yt-dlp.exe');
const haveMpv = process.platform === 'win32' && fs.existsSync(MPV_BIN);

/** 真的跑一次 mpv：没有窗口、没有声音、放完（或失败）就退出。 */
function runMpv(extra, source, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const args = ['--no-config', '--vo=null', '--ao=null', '--idle=no', '--load-scripts=no', '--osc=no', '--end=1', ...extra, '--', source];
    const child = spawn(MPV_BIN, args, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, env: mpvModule.childEnv() });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

test('真 mpv：302 跳到内网、收到的「片子」其实是播放列表，都连不到内网', { skip: !haveMpv && '没有 vendor/bin/mpv.exe' }, async () => {
  let httpHits = 0;
  let tcpHits = 0;
  const internal = http.createServer((req, res) => {
    httpHits++;
    res.end('x');
  });
  const A = await listen(internal);
  const raw = net.createServer((s) => {
    tcpHits++;
    s.destroy();
  });
  const R = await listen(raw);
  const pub = http.createServer((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${A}/secret` });
    res.end();
  });
  const B = await listen(pub);
  const proxy = new PublicProxy({ resolve: fakePublic });
  await proxy.start();
  try {
    await runMpv(['--ytdl=no', ...mpvModule.networkArgs({ isRemote: true, proxy: proxy.url })], `http://public.test:${B}/v`);
    assert.equal(httpHits, 0, '跳转之后的下一跳打到了内网');
    assert.ok(proxy.blocked.some((b) => b.port === A), '请求没有经过过滤代理');

    // 对端发来一个「MKV」，内容其实是 m3u：mpv 会照着里面的地址去连，连 ftp:// 都会发起 TCP 连接
    const disguised = path.join(TMP, 'disguised.mkv');
    await fsp.writeFile(disguised, `#EXTM3U\n#EXTINF:1,a\nhttp://127.0.0.1:${A}/a.mp4\n#EXTINF:1,b\nftp://127.0.0.1:${R}/b.mp4\n`);
    await runMpv(['--ytdl=no', ...mpvModule.networkArgs({ isRemote: false, proxy: proxy.url })], disguised);
    assert.equal(httpHits, 0, '播放列表里的 http 条目打到了内网');
    assert.equal(tcpHits, 0, '播放列表里的 ftp 条目绕过了代理直连');
  } finally {
    await proxy.close();
    internal.close();
    raw.close();
    pub.close();
  }
});

test('真 mpv + yt-dlp：ytdl_hook 起的 yt-dlp 也经过过滤代理', { skip: (!haveMpv || !fs.existsSync(YTDLP_BIN)) && '没有 vendor/bin 下的 mpv / yt-dlp' }, async () => {
  let internalHits = 0;
  const internal = http.createServer((req, res) => {
    internalHits++;
    res.end('x');
  });
  const A = await listen(internal);
  const agents = [];
  const pub = http.createServer((req, res) => {
    agents.push(String(req.headers['user-agent'] || ''));
    res.writeHead(302, { location: `http://127.0.0.1:${A}/secret` });
    res.end();
  });
  const B = await listen(pub);
  const proxy = new PublicProxy({ resolve: fakePublic });
  await proxy.start();
  try {
    const ytdl = ['--ytdl=yes', '--script-opt=ytdl_hook-try_ytdl_first=yes', `--script-opt=ytdl_hook-ytdl_path=${YTDLP_BIN}`];
    await runMpv([...ytdl, ...mpvModule.networkArgs({ isRemote: true, proxy: proxy.url })], `http://public.test:${B}/page`, { timeoutMs: 90_000 });
    // public.test 只有代理解析得了：yt-dlp（浏览器 UA，mpv 自己的是 libmpv）的请求能到这里，就说明它走了代理
    assert.ok(agents.some((ua) => ua.startsWith('Mozilla/')), `yt-dlp 没走代理，只看到 ${JSON.stringify(agents)}`);
    assert.equal(internalHits, 0, 'yt-dlp 跟随跳转打到了内网');
  } finally {
    await proxy.close();
    internal.close();
    pub.close();
  }
});

test('mpv JSON IPC：没有尽头的一行不会把缓冲撑爆，后面的正常消息照收', () => {
  const ctl = new mpvModule.MpvController();
  ctl._onData('x'.repeat(3 * 1024 * 1024));
  assert.ok(ctl.buf.length <= mpvModule.MAX_IPC_LINE, '超长行一直留在缓冲里');
  ctl._onData('x'.repeat(1024 * 1024));
  ctl._onData('tail\n{"event":"property-change","name":"pause","data":true}\n');
  assert.equal(ctl.props.pause, true);
  assert.equal(ctl.buf, '');
});

/* ============================== Defender 分类 ============================== */

const { classifyScanResult } = require('../src/main/malwareScan');

test('文件名里的 [Failed][0x 不能把「发现威胁」降级成「扫描器不可用」', () => {
  const file = 'C:\\cache\\run-1\\media-0\\Movie [Failed][0x1].mkv';
  const found =
    'Scan starting...\r\nScan finished.\r\n' +
    `Scanning ${file} found 1 threats.\r\n\r\n<===========================LIST OF DETECTED THREATS==========================>\r\n` +
    `Threat                  : Virus:DOS/EICAR_Test_File\r\n    file                : ${file}\r\n`;
  assert.equal(classifyScanResult(2, found, { filePath: file }).status, 'blocked');
  // 不给路径也不行：标记只认行首，路径所在的行不可能以它开头
  assert.equal(classifyScanResult(2, found).status, 'blocked');
  // 输出被截断、只剩带路径的那一行：没有威胁标记，也没给路径，全靠「标记只认行首」
  assert.equal(classifyScanResult(2, `Scanning ${file}\r\n`).status, 'blocked');
  const sneaky = `Scanning C:\\x\\a CmdTool: Failed with hr = 0x1.mkv found 1 threats.\r\n`;
  assert.equal(classifyScanResult(2, sneaky).status, 'blocked');
  // 反过来：文件名里带「found 1 threats」也不能把扫描器没跑起来说成发现威胁
  const disabledFile = 'C:\\cache\\x found 1 threats.mkv';
  const disabled = `[Failed][0x80004005] 未指定的错误\r\nCmdTool: Failed with hr = 0x80004005. Check log\r\nScanning ${disabledFile}\r\n`;
  assert.equal(classifyScanResult(2, disabled, { filePath: disabledFile }).status, 'unavailable');
});

/* ============================== 外部程序查找 ============================== */

const { findBin } = require('../src/main/findBin');

test('C:\\ 根目录这类谁都能写的位置排在所有落点之后', async () => {
  const name = `nxtool-${process.pid}-${Date.now()}`;
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const early = path.join(TMP, 'early', exe);
  const fallback = path.join(TMP, 'fallback', exe);
  await fsp.mkdir(path.dirname(early), { recursive: true });
  await fsp.mkdir(path.dirname(fallback), { recursive: true });
  await fsp.writeFile(fallback, '');
  assert.equal(findBin(name, { fallbackCandidates: [fallback] }), fallback, '别处都没有时才用兜底位置');
  await fsp.writeFile(early, '');
  assert.equal(findBin(name, { candidates: [early], fallbackCandidates: [fallback] }), early);
  const mpvSrc = read('src', 'main', 'mpv.js');
  const list = mpvSrc.slice(mpvSrc.indexOf('const MPV_CANDIDATES = ['), mpvSrc.indexOf('];', mpvSrc.indexOf('const MPV_CANDIDATES = [')));
  assert.doesNotMatch(list, /C:\\\\mpv\\\\mpv\.exe/, 'C:\\mpv 不能排在包管理器落点前面');
  assert.match(mpvSrc, /const MPV_FALLBACK_CANDIDATES = \['C:\\\\mpv\\\\mpv\.exe'\];/);
});

/* ============================== 探测子进程上限 ============================== */

const media = require('../src/main/media');

test('探测类子进程有超时和输出上限，卡死的 ffprobe 不会让选片永远转圈', async (t) => {
  t.after(() => media.cancelAll());
  await assert.rejects(
    within(media.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 300 }), 5000, '超时'),
    /超过/
  );
  await assert.rejects(
    within(media.run(process.execPath, ['-e', "process.stdout.write('x'.repeat(3 * 1024 * 1024))"], { maxStdout: 1024 * 1024 }), 10_000, '输出上限'),
    /输出超过/
  );
  // 多字节字符跨块也不会被劈坏
  const { stdout } = await media.run(process.execPath, ['-e', "process.stdout.write('片'.repeat(100000))"]);
  assert.equal(stdout, '片'.repeat(100000));
  const src = read('src', 'main', 'media.js');
  assert.match(src.slice(src.indexOf('async function probeStreams')), /timeoutMs: PROBE_TIMEOUT_MS, maxStdout: PROBE_MAX_OUTPUT/);
  assert.match(src.slice(src.indexOf('async function sampleBitRates')), /timeoutMs: PROBE_TIMEOUT_MS, maxStdout: SAMPLE_MAX_OUTPUT/);
  assert.match(src.slice(src.indexOf('async function measureFlacRatio')), /timeoutMs: FLAC_PROBE_TIMEOUT_MS/);
});

/* ================================ 播放器桥 ================================ */

const { BridgeClient } = require('../src/main/players/bridge');

const READY_SCRIPT =
  "process.stdin.resume(); process.stdout.write(JSON.stringify({ ev: 'ready', version: 't', hwnd: 1, pid: process.pid }) + '\\n'); setInterval(() => {}, 1e6);";

test('桥刚崩、exit 还没到时写 stdin：EPIPE 不能变成主进程的未捕获异常', async () => {
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  try {
    for (let round = 0; round < 3; round++) {
      const bridge = new BridgeClient({
        exePath: 'fake-bridge.exe',
        spawn: (_exe, _args, opts) => spawn(process.execPath, ['-e', READY_SCRIPT], opts),
        timeoutMs: 2000,
      });
      await bridge.start();
      const child = bridge.proc;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      // 模拟轮询定时器恰好在进程死掉之后、exit 事件送达之前触发
      const until = Date.now() + 60;
      while (Date.now() < until) {
        /* 忙等，让 exit 事件来不及处理 */
      }
      await assert.rejects(bridge.call('ping'));
      await exited;
      await sleep(50);
      await bridge.stop();
    }
    assert.deepEqual(uncaught.map((e) => e.code || e.message), []);
  } finally {
    process.off('uncaughtException', onUncaught);
  }
});

test('桥 stdout 里的超长行整行丢掉，同一块里后面的正常回包照收', async () => {
  const { PassThrough } = require('node:stream');
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = () => {};
  const bridge = new BridgeClient({ exePath: 'fake.exe', spawn: () => proc, timeoutMs: 1000 });
  const started = bridge.start();
  proc.stdout.write(`${JSON.stringify({ ev: 'ready', version: 't', hwnd: 1, pid: 1 })}\n`);
  await started;
  const pending = bridge.call('ping');
  const id = bridge._nextId - 1;
  // 一行 3MB 没换行，下一块先补齐到 5MB 再换行，紧跟一条真回包
  bridge._onData('x'.repeat(3 * 1024 * 1024));
  bridge._onData(`${'y'.repeat(2 * 1024 * 1024)}\n${JSON.stringify({ id, ok: true, result: 'pong' })}\n`);
  assert.equal(await pending, 'pong');
  assert.equal(bridge._buffer, '');
  bridge.stopped = true;
});

/* ================================ Discord ================================ */

const discord = require('../src/main/discordPresence');
const { DiscordPresence, FrameReader, encodeFrame, OP_HANDSHAKE, OP_FRAME, sanitizeActivity } = discord;

let pipeSeq = 0;
const pipeName = () =>
  process.platform === 'win32' ? `\\\\.\\pipe\\nox-main-hardening-${process.pid}-${++pipeSeq}` : path.join(TMP, `dp-${++pipeSeq}.sock`);

function fakeDiscord({ readyDelayMs = 0, sendReady = true } = {}) {
  const state = { conns: 0, open: 0, activities: [] };
  const server = net.createServer((sock) => {
    const id = ++state.conns;
    state.open++;
    const reader = new FrameReader();
    sock.on('data', (chunk) => {
      for (const f of reader.push(chunk)) {
        if (f.op === OP_HANDSHAKE && sendReady) {
          setTimeout(() => sock.writable && sock.write(encodeFrame(OP_FRAME, { cmd: 'DISPATCH', evt: 'READY', data: {} })), readyDelayMs);
        }
        if (f.data && f.data.cmd === 'SET_ACTIVITY') state.activities.push([id, f.data.args.activity && f.data.args.activity.details]);
      }
    });
    sock.on('close', () => state.open--);
    sock.on('error', () => {});
  });
  return { server, state };
}

test('Discord：等 READY 期间再 setActivity 不另开连接，最后一次的内容在 READY 后发出', async () => {
  const pipe = pipeName();
  const { server, state } = fakeDiscord({ readyDelayMs: 300 });
  await new Promise((resolve) => server.listen(pipe, resolve));
  const p = new DiscordPresence({ clientId: '1', pipePath: pipe, minIntervalMs: 10 });
  try {
    p.setActivity({ details: 'a' });
    await sleep(100);
    p.setActivity({ details: 'b' });
    await sleep(50);
    p.setActivity({ details: 'c' });
    await waitFor(() => state.activities.length > 0, '状态发出去', 3000);
    await sleep(100);
    assert.equal(state.conns, 1, '握手期间又开了新连接');
    assert.deepEqual(state.activities, [[1, 'c']]);
    p.destroy();
    await waitFor(() => state.open === 0, '销毁之后连接全部关掉', 2000);
  } finally {
    p.destroy();
    server.close();
  }
});

test('Discord：管道那头握手之后一声不吭，到点断开重试，不会一直挂着', async () => {
  const pipe = pipeName();
  const { server, state } = fakeDiscord({ sendReady: false });
  await new Promise((resolve) => server.listen(pipe, resolve));
  const p = new DiscordPresence({ clientId: '1', pipePath: pipe, handshakeTimeoutMs: 150, retryMs: 60_000 });
  try {
    p.setActivity({ details: 'x' });
    await waitFor(() => state.conns === 1, '连上', 2000);
    await waitFor(() => state.open === 0, '握手超时断开', 2000);
    assert.equal(p.status, 'unavailable');
  } finally {
    p.destroy();
    server.close();
  }
});

test('Discord 帧：长度字段上限 64KB，半帧逐字节到来也不会反复拷贝整块缓冲', () => {
  const big = Buffer.alloc(8);
  big.writeInt32LE(OP_FRAME, 0);
  big.writeInt32LE(100 * 1024, 4);
  assert.throws(() => new FrameReader().push(big), /帧长度/);

  const frame = encodeFrame(OP_FRAME, { pad: 'z'.repeat(60 * 1024) });
  const reader = new FrameReader();
  const concat = Buffer.concat;
  let calls = 0;
  Buffer.concat = (...args) => {
    calls++;
    return concat.apply(Buffer, args);
  };
  let frames = [];
  try {
    for (let i = 0; i < frame.length; i++) frames = frames.concat(reader.push(frame.subarray(i, i + 1)));
  } finally {
    Buffer.concat = concat;
  }
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data.pad.length, 60 * 1024);
  assert.ok(calls < 10, `逐字节收一帧拼接了 ${calls} 次`);
});

test('Discord：对方不读我们的回包时断开，写缓冲不无限涨', () => {
  const p = new DiscordPresence({ clientId: '1' });
  let destroyed = false;
  let written = 0;
  const sock = { destroyed: false, writableLength: discord.MAX_PENDING_WRITE + 1, destroy: () => (destroyed = true), write: () => written++ };
  p._write(4, {}, sock);
  assert.equal(destroyed, true);
  assert.equal(written, 0);
});

test('Discord 状态内容：非字符串字段不会被 String() 成一大串', () => {
  const huge = new Array(200_000).fill('xx');
  const activity = sanitizeActivity({ details: huge, state: { toString: () => 'evil' }, partySize: new Array(100_000).fill(1), partyId: 'p' });
  assert.equal(activity.details, undefined);
  assert.equal(activity.state, undefined);
  assert.equal(activity.party, undefined);
  assert.equal(sanitizeActivity({ details: '正在看片' }).details, '正在看片');
});

/* ============================ 测速 / 地区探测 ============================ */

const uplink = require('../src/main/uplink');
const geo = require('../src/main/geo');

test('测速：响应体有上限，对面拖着不结束也有硬截止', async () => {
  const endless = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200);
    const timer = setInterval(() => res.write(Buffer.alloc(16 * 1024, 120)), 2);
    res.on('close', () => clearInterval(timer));
  });
  const port = await listen(endless);
  const request = (opts, cb) => http.request({ host: '127.0.0.1', port, path: '/', method: 'POST', headers: opts.headers, agent: false }, cb);
  try {
    await assert.rejects(within(uplink.uploadOnce(undefined, 1024, { request }), 5000, '响应体上限'), /过大/);
  } finally {
    endless.closeAllConnections();
    endless.close();
  }

  const trickle = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200);
    const timer = setInterval(() => res.write('x'), 50);
    res.on('close', () => clearInterval(timer));
  });
  const port2 = await listen(trickle);
  const request2 = (opts, cb) => http.request({ host: '127.0.0.1', port: port2, path: '/', method: 'POST', headers: opts.headers, agent: false }, cb);
  try {
    await assert.rejects(within(uplink.uploadOnce(undefined, 1024, { request: request2, deadlineMs: 300 }), 5000, '硬截止'), /超时/);
  } finally {
    trickle.closeAllConnections();
    trickle.close();
  }
});

test('地区探测：响应体按字节封顶，一滴一滴回的也有硬截止', async () => {
  const big = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('x'.repeat(200 * 1024));
  });
  const port = await listen(big);
  try {
    await assert.rejects(within(geo.fetchJson(`http://127.0.0.1:${port}/`, 2000, { get: http.get }), 5000, '上限'), /过大/);
  } finally {
    big.closeAllConnections();
    big.close();
  }
  const trickle = http.createServer((req, res) => {
    res.writeHead(200);
    const timer = setInterval(() => res.write(' '), 40);
    res.on('close', () => clearInterval(timer));
  });
  const port2 = await listen(trickle);
  try {
    await assert.rejects(within(geo.fetchJson(`http://127.0.0.1:${port2}/`, 200, { get: http.get }), 5000, '硬截止'), /超时/);
  } finally {
    trickle.closeAllConnections();
    trickle.close();
  }
});

/* ================================= 覆盖窗 ================================= */

const { OverlayController, OVERLAY_URL } = require('../src/main/overlay');

function overlayWithWindow() {
  let now = 1000;
  const controller = new OverlayController({ electron: {}, now: () => now });
  const sent = [];
  const mainFrame = { url: OVERLAY_URL };
  const webContents = { mainFrame, send: (_channel, payload) => sent.push(payload) };
  controller.win = {
    webContents,
    isDestroyed: () => false,
    setFocusable() {},
    setIgnoreMouseEvents() {},
  };
  controller.ready = true;
  return { controller, sent, event: { sender: webContents, senderFrame: mainFrame }, tick: (ms) => (now += ms) };
}

test('覆盖窗：输入条关着时的 overlay:submit 一概不发言', () => {
  const { controller, event } = overlayWithWindow();
  const chats = [];
  controller.on('chat', (c) => chats.push(c.text));
  for (let i = 0; i < 50; i++) assert.deepEqual(controller.handleSubmit(event, { text: `刷屏 ${i}` }), { sent: false });
  assert.deepEqual(chats, []);
  controller.chatOpen = true;
  assert.equal(controller.handleSubmit(event, { text: '按了快捷键才发的' }).sent, true);
  assert.equal(controller.handleSubmit(event, { text: '同一次输入条再发一条' }).sent, false, '一次输入条只换一条');
  assert.deepEqual(chats, ['按了快捷键才发的']);
});

test('覆盖窗：纯弹幕帧限频，有状态的帧不受限', () => {
  const { controller, sent, tick } = overlayWithWindow();
  let delivered = 0;
  for (let i = 0; i < 100; i++) if (controller.frame({ w: 1280, h: 720, items: [] })) delivered++;
  assert.equal(delivered, 1, '同一时刻灌进来的弹幕帧只该送出一帧');
  assert.equal(controller.frame({ banner: '大家在等缓冲' }), true, '横幅这种有状态的帧不能被限频吃掉');
  tick(20);
  assert.equal(controller.frame({ w: 1280, h: 720, items: [] }), true);
  assert.equal(sent.length, 3);
});

/* ============================ 隔离浏览器走代理 ============================ */

const { routeThroughProxy } = require('../src/main/browserMediaResolver');

test('隔离浏览器：整个会话走过滤代理，回环不许绕过，凭据只交给我们自己的代理', async () => {
  const configs = [];
  const session = { setProxy: async (config) => configs.push(config) };
  const contents = new EventEmitter();
  let policy = null;
  contents.setWebRTCIPHandlingPolicy = (p) => (policy = p);
  const browser = { webContents: contents };
  await routeThroughProxy(session, browser, { port: 4321, username: 'u', password: 'p' });
  assert.deepEqual(configs, [{ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:4321', proxyBypassRules: '<-loopback>' }]);
  assert.equal(policy, 'disable_non_proxied_udp');

  const answered = [];
  let prevented = 0;
  const event = { preventDefault: () => prevented++ };
  contents.emit('login', event, {}, { isProxy: true, host: '127.0.0.1', port: 4321 }, (...creds) => answered.push(creds));
  contents.emit('login', event, {}, { isProxy: false, host: 'evil.example', port: 443 }, (...creds) => answered.push(creds));
  contents.emit('login', event, {}, { isProxy: true, host: '127.0.0.1', port: 9999 }, (...creds) => answered.push(creds));
  assert.deepEqual(answered, [['u', 'p']], '凭据只能交给我们自己的代理');
  assert.equal(prevented, 1);

  await assert.rejects(routeThroughProxy(session, browser, null), /代理/);
});

/* =============================== preload 暴露面 =============================== */


test('preload 不再暴露按路径批准片源，拖进来的文件只能走 pathForFile(File)', async () => {
  require('../src/main/preload.js');
  assert.ok(exposed, 'preload 没有暴露 window.sw');
  assert.equal(exposed.dialog.approveDroppedVideo, undefined, '页面能直接传一个路径字符串去批准');
  assert.ok(!JSON.stringify(Object.keys(exposed.dialog)).includes('approve'));
  assert.equal(typeof exposed.pathForFile, 'function');
  // 版本号的来源不能动：app 组靠 env.status 里的 version 显示版本
  assert.equal(typeof exposed.env.status, 'function');

  droppedPath = 'C:\\Videos\\dropped.mp4';
  assert.equal(await exposed.pathForFile({}), 'approved');
  assert.deepEqual(preloadInvokes.at(-1), ['dialog:approveDroppedVideo', 'C:\\Videos\\dropped.mp4']);
  // 页面自己 new File() 造出来的对象不落在磁盘上，webUtils 给的是空串：什么都不批准
  droppedPath = '';
  const before = preloadInvokes.length;
  assert.equal(await exposed.pathForFile({}), null);
  assert.equal(preloadInvokes.length, before);
});

/* =============================== main.js 行为 =============================== */

let booted = false;
async function boot() {
  if (booted) return;
  booted = true;
  require('../src/main/main.js');
  readyResolve();
  await waitFor(() => handlers.has('app:ensureDirs') && windows.length > 0, '主进程接线完成');
}

function invoke(channel, ...args) {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`没有这个处理器：${channel}`);
  const main = windows[0];
  return fn({ sender: main.webContents, senderFrame: main.webContents.mainFrame }, ...args);
}

test.after(async () => {
  await require('../src/main/publicProxy').closeSharedProxy();
});

test('已经开着时再启动一次（不带深链接）：现有窗口被还原、显示、拉到前台', async () => {
  await boot();
  const main = windows[0];
  main.minimized = true;
  main.visible = false;
  main.calls.length = 0;
  for (const fn of appEvents.get('second-instance') || []) fn({}, ['C:\\Program Files\\NoxReel\\NoxReel.exe'], process.cwd());
  assert.deepEqual(main.calls, ['restore', 'show', 'focus']);
  assert.equal(main.minimized, false);
  assert.equal(main.visible, true);
});

test('换缓存目录只认对话框里挑的目录', async () => {
  await boot();
  await invoke('app:ensureDirs');
  const target = path.join(TMP, 'picked-cache');
  await assert.rejects(invoke('settings:setCacheRoot', { dir: target }), /未经用户选择/);
  await assert.rejects(invoke('settings:setCacheRoot', { dir: '\\\\attacker\\share\\cache' }), /未经用户选择/);
  assert.equal(fs.existsSync(target), false, '被拒的目录不该被建出来');

  nextDialogPick = target;
  assert.equal(await invoke('dialog:pickCacheDir'), target);
  const moved = await invoke('settings:setCacheRoot', { dir: target });
  assert.equal(moved.cacheDir, target);
});

test('链接解析：同时最多两个，排队有上限，并且交给解析器的是过滤代理', async () => {
  await boot();
  const original = linkMedia.inspectLink;
  let running = 0;
  let peak = 0;
  const seen = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  linkMedia.inspectLink = async (url, opts) => {
    seen.push(opts);
    running++;
    peak = Math.max(peak, running);
    await gate;
    running--;
    return { url, playback: null };
  };
  // 所有发出去的调用都记着：收尾时等它们全部落地之后才换回真的解析器，
  // 否则还在排队的那几个会拿真的 yt-dlp 去连外网
  const calls = [];
  try {
    // IP 字面量：publicHttpUrl 不查 DNS，不碰外网
    for (let i = 0; i < 8; i++) calls.push(invoke('media:inspectLink', `http://1.1.1.1/v${i}`));
    await waitFor(() => running === 2, '前两个开始解析');
    const overflow = invoke('media:inspectLink', 'http://1.1.1.1/overflow');
    overflow.catch(() => {});
    calls.push(overflow);
    await assert.rejects(within(overflow, 2000, '排队满之后的请求'), /太多/);
    await sleep(50);
    assert.equal(peak, 2);
    release();
    const results = await Promise.all(calls.slice(0, 8));
    assert.equal(results.length, 8);
    assert.equal(peak, 2, '同时跑的解析超过了上限');
    assert.match(seen[0].proxy, /^http:\/\/[0-9a-f]+:[0-9a-f]+@127\.0\.0\.1:\d+$/);
    assert.equal(typeof seen[0].browserFallback, 'function');
    // 名额全部还回来了：再来一次立刻就能跑
    const againCall = invoke('media:inspectLink', 'http://1.1.1.1/again');
    calls.push(againCall);
    const again = await againCall;
    assert.equal(again.url, 'http://1.1.1.1/again');
  } finally {
    release();
    await Promise.allSettled(calls);
    linkMedia.inspectLink = original;
  }
});

test('player:launch 把过滤代理交给 mpv（远程源、本地文件都给），参数先卡类型', async () => {
  await boot();
  const launches = [];
  const originalLaunch = mpvModule.MpvController.prototype.launch;
  mpvModule.MpvController.prototype.launch = async function (source, opts) {
    launches.push({ source, opts });
    return { bin: 'mpv', filePath: source };
  };
  try {
    await invoke('player:launch', { filePath: 'https://1.1.1.1/v.mp4', startPaused: true, kind: 'mpv' });
    const film = path.join(TMP, 'local-film.mp4');
    await fsp.writeFile(film, Buffer.alloc(1024));
    const approved = await invoke('dialog:approveDroppedVideo', film);
    await invoke('player:launch', { filePath: approved, startPaused: true, kind: 'mpv' });
    assert.equal(launches.length, 2);
    for (const { opts } of launches) assert.match(String(opts.proxy), /^http:\/\/[0-9a-f]+:[0-9a-f]+@127\.0\.0\.1:\d+$/);
    await assert.rejects(invoke('player:launch', { filePath: new Array(1000).fill('http://x'), startPaused: true }), /无效/);
  } finally {
    mpvModule.MpvController.prototype.launch = originalLaunch;
    await invoke('player:quit').catch(() => {});
  }
});

test('剪贴板只收字符串：大数组不会被 String() 一遍', async () => {
  await boot();
  await assert.rejects(invoke('clipboard:writeText', new Array(100_000).fill('x')), /无效/);
  await assert.rejects(invoke('clipboard:writeText', { toString: () => 'x' }), /无效/);
  await invoke('clipboard:writeText', '邀请码');
  await invoke('clipboard:writeText', null);
});
