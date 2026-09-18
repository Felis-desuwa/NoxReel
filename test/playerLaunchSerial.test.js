'use strict';

// 播放器启动的先后次序：主进程在 player:launch 里先做异步校验（realpath / DNS）才交给
// PlayerManager，换片又会在旧进程退出期间插进新的启动。这里用可控的假播放器把这些时序
// 一步步摆出来，确认任何时候最多只有一个活着的播放器，而且它就是管理器手里那一代。
// 纯 Node，不拉起任何真实进程。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PlayerManager } = require('../src/main/players');

const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 20) => {
  for (let i = 0; i < n; i++) await tick();
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * 一个「世界」：假播放器 + 假的主进程 IPC 处理器 + 渲染进程换片骨架。
 * - 假播放器拉起即算进程活着；launch 要等 connect(片源) 才返回，被关掉则立刻失败；
 *   quit 之后进程要等 exitAll() 才真正退出（模拟 mpv 落地要几百毫秒）。
 * - ipcLaunch 与 main.js 的 player:launch 同构：到达即领号，校验（pass(片源)）完才交给管理器。
 * - switchCurrent / launchPlayer 与 app.js 的顺序和 seq 判断一致。
 */
function makeWorld() {
  const alive = new Set();
  const armed = new Set();
  const exits = [];
  let maxAlive = 0;

  class FakeAdapter extends EventEmitter {
    constructor() {
      super();
      this.caps = {};
      this.source = null;
      this.killed = false;
      this.resolveAfterKill = false;
      this.connected = deferred();
      FakeAdapter.made.push(this);
    }
    async launch({ source }) {
      this.source = source;
      alive.add(this);
      maxAlive = Math.max(maxAlive, alive.size);
      if (armed.has(source)) this.connected.resolve();
      await this.connected.promise;
      return { bin: 'fake', filePath: source };
    }
    connect() {
      this.connected.resolve();
    }
    quit() {
      if (!this.killed) {
        this.killed = true;
        // 模拟 mpv 被关时还没连上管道：启动随之失败
        if (!this.resolveAfterKill) this.connected.reject(new Error('mpv 在建立 IPC 连接前就退出了'));
      }
      const d = deferred();
      exits.push(() => {
        alive.delete(this);
        d.resolve();
      });
      return d.promise;
    }
    setPause() {}
    seek() {}
    osd() {}
    setBanner() {}
    snapshot() {
      return {};
    }
  }
  FakeAdapter.made = [];

  const players = new PlayerManager({ send: () => {}, adapters: { fake: FakeAdapter } });

  const validations = new Map();
  const validation = (file) => {
    if (!validations.has(file)) validations.set(file, deferred());
    return validations.get(file);
  };
  /** 放行某个片源的路径校验（可以提前放行，请求到了直接通过）。 */
  const pass = (file) => validation(file).resolve();
  /** 让某个片源的播放器连上管道（可以提前约定，拉起后立刻连上）。 */
  const connect = (file) => {
    armed.add(file);
    for (const a of FakeAdapter.made) if (a.source === file) a.connect();
  };
  /** 让所有已经被关的进程真正退出。 */
  const exitAll = () => {
    for (const done of exits.splice(0)) done();
  };

  const ipcLaunch = (file) =>
    new Promise((resolve, reject) =>
      setImmediate(async () => {
        const ticket = players.reserve?.();
        try {
          await validation(file).promise;
          resolve(await players.launch('fake', { source: file }, ticket));
        } catch (e) {
          reject(e);
        }
      })
    );
  const ipcQuit = (gen) => new Promise((resolve) => setImmediate(() => players.quit(gen).then(resolve)));

  const S = { currentSeq: 0, mpvRunning: false, gen: null, file: null };
  async function launchPlayer() {
    if (S.mpvRunning || !S.file) return;
    const seq = S.currentSeq;
    S.mpvRunning = true;
    try {
      const info = await ipcLaunch(S.file);
      if (seq !== S.currentSeq) {
        ipcQuit(info?.gen).catch(() => {});
        return;
      }
      S.gen = info.gen;
    } catch {
      if (seq !== S.currentSeq) return;
      S.mpvRunning = false;
    }
  }
  async function switchCurrent(seq, file) {
    S.currentSeq = seq;
    S.mpvRunning = false;
    S.file = file;
    await ipcQuit();
    if (S.currentSeq !== seq) return;
    launchPlayer();
  }

  const aliveSources = () => [...alive].map((a) => a.source).sort();
  return {
    players,
    S,
    FakeAdapter,
    switchCurrent,
    pass,
    connect,
    exitAll,
    aliveSources,
    get maxAlive() {
      return maxAlive;
    },
  };
}

/** 收尾时退出程序（main.js 的 cleanup 只退 current），不能留下任何进程。 */
async function assertCleanShutdown(w) {
  const quitting = w.players.quit();
  await settle();
  w.exitAll();
  await quitting;
  assert.deepEqual(w.aliveSources(), [], '关程序后还有播放器活着');
}

test('三次快速换片：落后的启动不能覆盖后来者，最后只剩当前这部且受管理器控制', async () => {
  const w = makeWorld();
  w.switchCurrent(1, 'A');
  await settle(); // L1 已到主进程，还在校验
  w.switchCurrent(2, 'B');
  await settle(); // Q2 时还没有播放器；L2 也在校验
  w.pass('A');
  await settle(); // L1 校验完
  w.pass('B');
  await settle(); // L2 校验完
  w.switchCurrent(3, 'C');
  await settle();
  w.pass('C');
  w.connect('C');
  await settle();
  w.exitAll(); // 被关的旧进程陆续落地
  await settle();
  w.connect('B');
  await settle();
  w.exitAll();
  await settle();

  assert.equal(w.S.currentSeq, 3);
  assert.equal(w.S.mpvRunning, true);
  assert.deepEqual(w.aliveSources(), ['C'], '应当只剩当前这部在放');
  assert.ok(w.players.current, '当前这部必须在管理器手里');
  assert.equal(w.players.current.gen, w.S.gen, '渲染进程认的代号和主进程手里的不是同一个');
  assert.equal(w.maxAlive, 1, '新播放器在旧进程退干净之前就拉起来了');
  await assertCleanShutdown(w);
});

test('两次换片、先发的校验更慢：过期的启动不许关掉后来者、也不许自己拉起', async () => {
  const w = makeWorld();
  w.connect('A');
  w.connect('B');
  w.switchCurrent(1, 'A'); // 链接项，DNS 慢
  await settle();
  w.switchCurrent(2, 'B'); // 本地文件，realpath 快
  await settle();
  w.pass('B');
  await settle();
  assert.equal(w.S.mpvRunning, true);
  w.pass('A'); // 迟到的 L1 这时才校验完
  await settle();
  w.exitAll();
  await settle();

  assert.deepEqual(w.aliveSources(), ['B']);
  assert.ok(w.players.current, '渲染进程以为在放，主进程手里却没有播放器');
  assert.equal(w.players.current.gen, w.S.gen);
  assert.equal(w.FakeAdapter.made.length, 1, '过期的启动不该拉起任何播放器');
  await assertCleanShutdown(w);
});

test('不带 gen 的退出作废还在校验中的启动；带 gen 的退出不作废', async () => {
  const w = makeWorld();
  w.connect('A'); // 万一放行了也立刻连上，测试直接失败而不是干等
  const stale = w.players.reserve();
  await w.players.quit(); // 换片 / 拦下威胁
  await assert.rejects(w.players.launch('fake', { source: 'A' }, stale), /操作已取消/);
  assert.equal(w.FakeAdapter.made.length, 0);

  w.connect('B');
  const ticket = w.players.reserve();
  await w.players.quit(99); // 上一部迟到的「退掉自己」，不能误伤正在校验的新启动
  const info = await w.players.launch('fake', { source: 'B' }, ticket);
  assert.equal(w.players.current.gen, info.gen);
  await assertCleanShutdown(w);
});

test('启动途中被退掉，即使播放器恰好连上了也不能报成功', async () => {
  const w = makeWorld();
  const launching = w.players.launch('fake', { source: 'A' });
  const refused = assert.rejects(launching, /操作已取消/);
  await settle();
  const a = w.FakeAdapter.made[0];
  a.resolveAfterKill = true; // mpv 在被关之前刚好连上了管道
  const quitting = w.players.quit();
  a.connect();
  await settle();
  w.exitAll();
  await quitting;
  await refused;
  assert.equal(w.players.running, false);
  assert.deepEqual(w.aliveSources(), []);
});

test('别人正在关的旧播放器没退干净之前，新的不拉起、不带 gen 的退出也不返回', async () => {
  const w = makeWorld();
  w.connect('A');
  w.connect('B');
  w.connect('C');
  await w.players.launch('fake', { source: 'A' });
  // 不带 gen 的退出正在等 A 落地，这时新的启动进来：current 已经空了，但 A 还活着
  const quitting = w.players.quit();
  const launchB = w.players.launch('fake', { source: 'B' });
  await settle();
  assert.deepEqual(w.aliveSources(), ['A'], 'A 还没退干净，B 就拉起来了');
  w.exitAll();
  await quitting;
  const infoB = await launchB;
  assert.deepEqual(w.aliveSources(), ['B']);

  // 换片时由新启动发起的退出还没落地，这时关程序：必须等 B 真正退出才返回（之后要删缓存）
  const launchC = w.players.launch('fake', { source: 'C' });
  const refusedC = assert.rejects(launchC, /操作已取消/, '关程序之后不该再拉起 C');
  await settle();
  let quitDone = false;
  const closing = w.players.quit().then(() => {
    quitDone = true;
  });
  await settle();
  assert.equal(quitDone, false, 'B 还攥着文件，退出就先返回了');
  w.exitAll();
  await closing;
  await refusedC;
  assert.equal(infoB.filePath, 'B');
  assert.deepEqual(w.aliveSources(), []);
  assert.equal(w.maxAlive, 1);
});

test('player:launch 在第一个 await 之前领号，并把号交给 PlayerManager', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8');
  const start = main.indexOf("secureHandle('player:launch'");
  assert.ok(start >= 0);
  // 去掉整行注释，免得注释里提到的 await 干扰判断
  const body = main.slice(start, main.indexOf('\n});', start)).replace(/^\s*\/\/.*$/gm, '');
  const reserveAt = body.search(/const (\w+) = players\.reserve\(\);/);
  assert.ok(reserveAt >= 0, 'player:launch 没有领启动号');
  const ticketName = body.match(/const (\w+) = players\.reserve\(\);/)[1];
  const firstAwait = body.indexOf('await ');
  assert.ok(firstAwait > reserveAt, '领号必须在第一个 await 之前，否则号码次序不等于请求到达次序');
  assert.match(body, new RegExp(`players\\.launch\\('mpv', \\{[^}]*\\}, ${ticketName}\\)`), '启动号没有交给 players.launch');
});
