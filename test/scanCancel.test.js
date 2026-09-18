'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const malwareScan = require('../src/main/malwareScan');
const validate = require('../src/main/security');
const fileStore = require('../src/main/fileStore');
const { IMPLS } = require('./helpers/impls');

const root = path.join(__dirname, '..');
const { cancel, cancelAll, scanFile } = malwareScan;

/**
 * 0.7 起一个房间能同时挂好几部片（播放列表），每部片各有一个会话、各自可能在扫描。
 * 以前只有 cancelAll()：换一部片、关一个会话就把所有人的扫描一起掐掉，
 * 已经扫到一半的下一部片只能从头再来；更糟的是关会话时不等扫描进程退出，
 * MpCmdRun 还攥着文件句柄，删缓存直接失败，留下一整部片的垃圾。
 * 这组测试真的起挂起的假扫描器，看 cancel(tag) 是不是只停该停的、停完才返回。
 */

// 假扫描器：把自己的 pid 写进 argv[1] 指定的文件，然后永远不返回。
const HANG_SCRIPT = "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noxreel-scan-cancel-'));
let seq = 0;
const leftovers = new Set();

test.after(() => {
  cancelAll();
  for (const pid of leftovers) {
    try {
      process.kill(pid);
    } catch {}
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function pidFile() {
  return path.join(tmp, `pid-${process.pid}-${++seq}.txt`);
}

/** 起一个永不返回的扫描，返回 { promise, settled, result } 以便观察它什么时候结束。 */
function hangingScan(tag) {
  const file = pidFile();
  const handle = { file, settled: false, result: null, promise: null };
  handle.promise = scanFile('C:/tmp/never.mkv', {
    defenderPath: process.execPath,
    scanArgs: ['-e', HANG_SCRIPT, file],
    timeoutMs: 60_000,
    tag,
  }).then((result) => {
    handle.settled = true;
    handle.result = result;
    return result;
  });
  return handle;
}

async function readPid(file, { deadlineMs = 10_000 } = {}) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      if (text) {
        const pid = Number(text);
        leftovers.add(pid);
        return pid;
      }
    } catch {}
    if (Date.now() > until) throw new Error(`假扫描器没有按时启动：${file}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function waitDead(pid, { deadlineMs = 5000 } = {}) {
  const until = Date.now() + deadlineMs;
  while (alive(pid)) {
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  leftovers.delete(pid);
  return true;
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('cancel(tag) 只停这个会话的扫描，别的会话照常扫', async () => {
  const a = hangingScan('a');
  const b = hangingScan('b');
  const [pidA, pidB] = await Promise.all([readPid(a.file), readPid(b.file)]);

  const stopped = await cancel('a');
  assert.equal(stopped, true, '确实停了一个扫描，要如实报 true');
  // 这是「等进程退出再返回」的直接证据：扫描的 Promise 是在子进程 close 时才 resolve 的，
  // cancel 若是杀完就走，这里还会是 false —— 而关会话紧接着就要删缓存。
  assert.equal(a.settled, true, 'cancel 返回时 a 的扫描进程应当已经退出');
  assert.equal(alive(pidA), false, 'cancel 返回时 a 的子进程不能还活着');
  leftovers.delete(pidA);
  assert.equal(a.result.status, 'cancelled', '主动叫停必须报 cancelled，不能落进 error／blocked');
  assert.equal(a.result.ok, false);
  assert.doesNotMatch(a.result.message, /威胁/);

  // b 属于另一个会话，绝不能被连带掐掉
  await tick(150);
  assert.equal(b.settled, false, 'b 的扫描不该被 cancel(a) 结束');
  assert.equal(alive(pidB), true, 'b 的子进程应当还在跑');

  // 同一个 tag 再叫停一次：已经没有东西可停了
  assert.equal(await cancel('a'), false, '重复叫停不能谎报停了东西');
  assert.equal(b.settled, false);

  cancelAll();
  const resultB = await b.promise;
  assert.equal(resultB.status, 'cancelled');
  assert.equal(await waitDead(pidB), true, 'cancelAll 之后 b 的子进程必须退出，不能留孤儿');
});

test('同一个会话挂着多个扫描时，cancel 全部停掉并且等它们都退出', async () => {
  const first = hangingScan('same');
  const second = hangingScan('same');
  const other = hangingScan('other');
  const pids = await Promise.all([first, second, other].map((h) => readPid(h.file)));

  assert.equal(await cancel('same'), true);
  assert.equal(first.settled, true, '第一个扫描应当已经结束');
  assert.equal(second.settled, true, '第二个扫描也应当已经结束 —— 只等其中一个不够');
  assert.equal(first.result.status, 'cancelled');
  assert.equal(second.result.status, 'cancelled');
  assert.equal(alive(pids[0]), false);
  assert.equal(alive(pids[1]), false);
  leftovers.delete(pids[0]);
  leftovers.delete(pids[1]);

  assert.equal(other.settled, false, '别的会话的扫描不受影响');
  cancelAll();
  assert.equal((await other.promise).status, 'cancelled');
  assert.equal(await waitDead(pids[2]), true);
});

test('不存在的 tag 返回 false；null／undefined 不能被当成「全停」', async () => {
  // 没打标签的扫描（tag 为 null）和打了标签的都各挂一个
  const untagged = hangingScan(null);
  const tagged = hangingScan('d');
  const pids = await Promise.all([untagged, tagged].map((h) => readPid(h.file)));

  assert.equal(await cancel('nope'), false, '没有这个会话的扫描，就不能说停了');
  // 渲染进程传来的会话 id 缺失时，store:cancelScan 会走 cancelAll 那一支；
  // cancel 自己绝不能把 null 当通配符，否则「关一个会话」会变成「停所有扫描」。
  assert.equal(await cancel(null), false, 'cancel(null) 不能停掉没打标签的扫描');
  assert.equal(await cancel(undefined), false, 'cancel(undefined) 同理');
  assert.equal(await cancel(''), false, '空字符串不是任何会话的 id');

  await tick(150);
  assert.equal(untagged.settled, false, '没打标签的扫描应当还在跑');
  assert.equal(tagged.settled, false, '打了标签的扫描应当还在跑');
  assert.ok(pids.every(alive), '两个子进程都应当还活着');

  cancelAll();
  const results = await Promise.all([untagged.promise, tagged.promise]);
  assert.deepEqual(results.map((r) => r.status), ['cancelled', 'cancelled']);
  for (const pid of pids) assert.equal(await waitDead(pid), true, 'cancelAll 收尾后不能留下子进程');
});

/**
 * 真进程杀掉之后 close 几乎立刻就来（Windows 上连继承了管道的孙进程都拖不住它），
 * 所以「叫停了却迟迟不退」只能换一个假的 child 来造：
 * 另载一份 malwareScan，让它拿到的 spawn 返回一个 kill() 什么都不做的假进程。
 */
function loadScanWithFakeSpawn(fakeSpawn) {
  const cp = require('node:child_process');
  const modPath = require.resolve('../src/main/malwareScan');
  const original = cp.spawn;
  const saved = require.cache[modPath];
  delete require.cache[modPath];
  cp.spawn = fakeSpawn;
  try {
    return require(modPath);
  } finally {
    cp.spawn = original;
    if (saved) require.cache[modPath] = saved;
    else delete require.cache[modPath];
  }
}

function stubbornChild() {
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    return true; // 信号发出去了，可进程就是不退
  };
  return child;
}

test('进程迟迟不退时 cancel 最多等 timeoutMs，不会把关会话卡死', async () => {
  // store:close 会 await cancel(id)。扫描进程若因为某种原因一直不触发 close，
  // 没有上限的等待会让「关会话」这个 IPC 永远不返回，界面就卡在切片那一步。
  const children = [];
  const scan = loadScanWithFakeSpawn(() => {
    const child = stubbornChild();
    children.push(child);
    return child;
  });
  assert.notEqual(scan.scanFile, scanFile, '前提不成立：没载入独立的一份 malwareScan');

  let settled = false;
  const pending = scan
    .scanFile('C:/tmp/never.mkv', { defenderPath: 'fake-mpcmdrun.exe', timeoutMs: 60_000, tag: 'slow' })
    .then((result) => {
      settled = true;
      return result;
    });
  assert.equal(children.length, 1, '前提不成立：假 spawn 没被调用');
  const [child] = children;

  const started = Date.now();
  const stopped = await scan.cancel('slow', { timeoutMs: 300 });
  const elapsed = Date.now() - started;
  assert.equal(stopped, true, '确实叫停了，即使没等到退出也要报 true');
  assert.equal(child.killCalls, 1, '必须向扫描进程发出终止');
  assert.ok(elapsed >= 250, `应当先等一会儿进程退出（实际 ${elapsed}ms）`);
  assert.ok(elapsed < 900, `等到上限就该返回，不能一直等下去（实际 ${elapsed}ms）`);
  assert.equal(settled, false, '进程没退，扫描结果此时还不该出来');

  // 已经从活动表里摘掉了：再叫停不会重复计数，也不会再杀一次
  assert.equal(await scan.cancel('slow', { timeoutMs: 300 }), false);
  assert.equal(child.killCalls, 1);

  // 迟到的 close（哪怕退出码是 2）仍然要记成取消，绝不能被读成「发现威胁」
  child.emit('close', 2);
  const result = await pending;
  assert.equal(result.status, 'cancelled', '超时返回之后迟到的 close 仍然要记成取消');
  assert.doesNotMatch(result.message, /威胁/);
});

/* ------------------------------ 清单的文件标识 ------------------------------ */

const CHUNK = fileStore.CHUNK_SIZE;

function digestOf(hashes) {
  return crypto.createHash('sha256').update(hashes.join('')).digest('hex').slice(0, 32);
}

function manifestWith(overrides = {}) {
  const hashes = ['1'.repeat(64), 'ab'.repeat(32)];
  return {
    fileId: digestOf(hashes),
    name: 'movie.mkv',
    size: CHUNK + 1,
    chunkSize: CHUNK,
    chunkCount: 2,
    hashes,
    ...overrides,
  };
}

test('fileId 与分片哈希推导的摘要一致时清单通过', () => {
  const manifest = manifestWith();
  assert.equal(validate.manifest(manifest), manifest);
});

test('fileId 对不上分片哈希时拒绝，错误信息指向「文件标识」', () => {
  // 拿别人的 fileId 配上自己的哈希，缓存和进度就会记到别的片子头上，
  // 播放列表里「同一部片复用槽位」的判断也会被骗。
  assert.throws(() => validate.manifest(manifestWith({ fileId: 'a'.repeat(32) })), /文件标识/);

  // 只改一片哈希、fileId 不跟着变：同样是被篡改过的清单
  const base = manifestWith();
  const tampered = { ...base, hashes: [base.hashes[0], 'cd'.repeat(32)] };
  assert.throws(() => validate.manifest(tampered), /文件标识/);

  // 顺序也算在摘要里：把分片对调就是另一部片，不能沿用原来的 fileId
  const swapped = { ...base, hashes: [base.hashes[1], base.hashes[0]] };
  assert.throws(() => validate.manifest(swapped), /文件标识/);

  // 完整的 64 位摘要不是 fileId，只取前 32 位
  const full = crypto.createHash('sha256').update(base.hashes.join('')).digest('hex');
  assert.throws(() => validate.manifest({ ...base, fileId: full }), /文件标识/);

  // 大写形式指向同一个摘要，但 fileId 是缓存和播放列表的键，大小写两份会被当成两部片
  assert.throws(() => validate.manifest({ ...base, fileId: base.fileId.toUpperCase() }), /文件标识/);
});

test('主进程自己算出来的清单一定能通过自己的校验', async () => {
  // buildManifest 和 security.manifest 各写了一遍推导，两边只要有一处不一致，
  // 房主选完片就会被自己的 validateManifest 拒掉。
  const file = path.join(tmp, 'movie.mkv');
  fs.writeFileSync(file, Buffer.alloc(4096, 7));
  const manifest = await fileStore.buildManifest(file);
  assert.equal(manifest.fileId, digestOf(manifest.hashes));
  assert.doesNotThrow(() => validate.manifest(manifest));
});

test('主进程与两端共享库对 fileId 的判定一致', async () => {
  // 房主的主进程放行、观众的渲染进程却拒绝（或反过来）时，表现是「列表里有这部片，
  // 却谁也拿不到清单」。两边必须对同一份清单给出同一个结论。
  const good = manifestWith();
  const bad = manifestWith({ fileId: 'f'.repeat(32) });
  for (const { name, dir } of IMPLS) {
    const { manifestDigestOk, manifestShapeOk } = await import(dir + 'swarm.js');
    assert.equal(manifestShapeOk(good), true, `${name}：形状应当合法`);
    assert.equal(await manifestDigestOk(good), true, `${name}：摘要一致的清单应当通过`);
    assert.equal(await manifestDigestOk(bad), false, `${name}：摘要不一致的清单应当被拒`);
  }
  assert.doesNotThrow(() => validate.manifest(good));
  assert.throws(() => validate.manifest(bad), /文件标识/);
});

/* ------------------------------ IPC 接线（源码） ------------------------------ */

const mainSrc = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(root, 'src/main/preload.js'), 'utf8');

function handlerBody(channel) {
  const marker = `secureHandle('${channel}'`;
  const start = mainSrc.indexOf(marker);
  assert.ok(start >= 0, `main.js 里找不到 ${channel} 处理器`);
  const next = mainSrc.indexOf('\nsecureHandle(', start + marker.length);
  const body = mainSrc.slice(start, next < 0 ? undefined : next);
  assert.ok(body.length > marker.length + 20, `${channel} 处理器切出来太短，下面的断言会形同虚设`);
  return body;
}

test('store:close 先等扫描退出，再关会话删缓存', () => {
  const body = handlerBody('store:close');
  assert.match(body, /const id = validate\.sessionId\(sessionId\)/);
  const cancelAt = body.search(/await malwareScan\.cancel\(id\)/);
  const closeAt = body.indexOf('store.close(id)');
  assert.ok(cancelAt >= 0, 'store:close 必须 await malwareScan.cancel(id) —— 不 await 就等于没等');
  assert.ok(closeAt >= 0, 'store:close 必须调用 store.close(id)');
  // 顺序反了，MpCmdRun 还攥着文件句柄，删缓存会失败
  assert.ok(cancelAt < closeAt, '必须先停扫描再关会话');
  // 停扫描失败也不能挡住关会话，否则缓存永远删不掉
  assert.ok(
    /malwareScan\.cancel\(id\)\.catch\(/.test(body) || /try\s*\{[\s\S]*malwareScan\.cancel\(id\)/.test(body),
    '停扫描出错时也要继续关会话'
  );
  // 关一个会话不能把其它片子的扫描一起掐掉
  assert.doesNotMatch(body, /cancelAll/, '关单个会话不能调用 cancelAll');
});

test('store:scanReceivedMedia 给扫描打上会话 id 的标签', () => {
  const body = handlerBody('store:scanReceivedMedia');
  assert.match(body, /const id = validate\.sessionId\(sessionId\)/);
  // 没有 tag，cancel(id) 就找不到它，关会话时只能干等扫描自己结束
  assert.match(body, /malwareScan\.scanFile\(filePath, \{[^}]*\btag: id\b[^}]*\}\)/);
});

test('store:cancelScan 带会话 id 时只停那一个，不带才全停', () => {
  const body = handlerBody('store:cancelScan');
  const ifAt = body.indexOf('if (sessionId === undefined || sessionId === null)');
  assert.ok(ifAt > 0, '「不带 id」的判断必须显式写出来');
  const blockOpen = body.indexOf('{', ifAt);
  const blockClose = body.indexOf('}', blockOpen);
  const allBranch = body.slice(blockOpen, blockClose + 1);
  const rest = body.slice(blockClose + 1);

  assert.match(allBranch, /malwareScan\.cancelAll\(\);\s*return/, '全停那一支必须就地返回，不能往下掉');
  assert.doesNotMatch(body.slice(0, ifAt), /cancelAll/, '判断之前不能先全停');
  // 带 id 的这一支：只调 cancel，并把「停没停」回给渲染进程
  assert.match(rest, /return malwareScan\.cancel\(validate\.sessionId\(sessionId\)\)/);
  assert.doesNotMatch(rest, /cancelAll/, '带会话 id 时不能再调用 cancelAll');
});

test('store:validateManifest 只校验不开会话', () => {
  const body = handlerBody('store:validateManifest');
  assert.match(body, /validate\.manifest\(manifest\)/);
  // 房主收下管理员的片之前只是过一遍，不能顺手建出一个接收会话
  assert.doesNotMatch(body, /store\.open/);
});

test('应用退出时仍然停掉全部扫描', () => {
  const start = mainSrc.indexOf('async function cleanup()');
  assert.ok(start >= 0, 'main.js 里找不到 cleanup()');
  const body = mainSrc.slice(start, mainSrc.indexOf('\n}\n', start));
  // 按会话叫停只管得了还开着的会话，退出时必须兜底全停，不能留 MpCmdRun 孤儿
  assert.match(body, /malwareScan\.cancelAll\(\)/);
});

test('preload 暴露 validateManifest 与 cancelScan(sessionId)', () => {
  assert.match(
    preloadSrc,
    /validateManifest:\s*\(manifest\)\s*=>\s*ipcRenderer\.invoke\('store:validateManifest',\s*manifest\)/
  );
  // 会话 id 必须原样转交：丢了它，主进程会走「不带 id → 全停」那一支
  assert.match(
    preloadSrc,
    /cancelScan:\s*\(sessionId\)\s*=>\s*ipcRenderer\.invoke\('store:cancelScan',\s*sessionId\)/
  );
});
