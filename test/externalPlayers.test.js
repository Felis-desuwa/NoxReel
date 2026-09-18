'use strict';

/**
 * 外部播放器（PotPlayer / MPC-BE）与桥接客户端。
 *
 * 全程不启动任何真播放器，也不启动桥接程序本体：
 *  - 桥接客户端那几条测试用一个说 NDJSON 的假子进程（PassThrough 管道）；
 *  - 两个适配器用一个假桥，它在 Node 里模拟出播放器的行为 ——
 *    PotPlayer 只能轮询、跳转落到关键帧、启动后会覆盖掉我们发的暂停；
 *    MPC-BE 靠推送、可能脱管。
 *
 * 为什么必须假到这个地步：真跑一次 PotPlayer 或 MPC-BE，它们的静音/音量会被写进注册表，
 * 那是在改用户自己的播放器设置。产品代码里一个音量参数都不许出现，这里也一样。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
  BRIDGE_MISSING_MESSAGE,
  BridgeClient,
  bridgeCandidates,
  createWaiterHub,
  findBridge,
  normalizeSource,
  sanitizeArg,
} = require('../src/main/players/bridge');
const {
  discoverPlayers,
  isAllowedExe,
  kindOfExe,
  parseRegQuery,
  programPathCandidates,
} = require('../src/main/players/discover');
const { POT, POT_CMD_NEXT_KEYFRAME, POT_STATE, PotAdapter, buildPotArgs, formatSeek } = require('../src/main/players/potAdapter');
const { MPC, MPC_OSD_MAX, MPC_PLAYSTATE, MpcAdapter, buildMpcArgs } = require('../src/main/players/mpcAdapter');

const BS = String.fromCharCode(92); // 反斜杠：仓库里的字面反斜杠被工具多转义过不止一次
const LOCAL_FILE = `C:${BS}movies${BS}a.mp4`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等一个条件成立，最多等 timeout 毫秒。测试里所有「等播放器动起来」都走它。 */
async function until(fn, { timeout = 3000, step = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await sleep(step);
  }
  throw new Error('等待超时');
}

/* ============================ 假的桥接子进程 ============================ */

function fakeBridgeProcess({ ready = true, pid = 4321, hwnd = 777 } = {}) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.exitCode = null;
  proc.signalCode = null;
  proc.requests = [];
  proc.killed = 0;
  proc.emitLine = (obj) => proc.stdout.write(`${JSON.stringify(obj)}\n`);
  proc.exit = (code = 0) => {
    if (proc.exitCode !== null) return;
    proc.exitCode = code;
    proc.emit('exit', code);
  };
  proc.kill = () => {
    proc.killed += 1;
    proc.exit(9);
  };
  let buffer = '';
  proc.stdin.on('data', (chunk) => {
    buffer += chunk.toString();
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        const msg = JSON.parse(line);
        proc.requests.push(msg);
        if (proc.autoReply) proc.autoReply(msg);
      }
      index = buffer.indexOf('\n');
    }
  });
  // 桥接程序的约定：stdin 一关就退出，不留孤儿。
  proc.stdin.on('finish', () => proc.exit(0));
  if (ready) setImmediate(() => proc.emitLine({ ev: 'ready', version: '1', hwnd, pid }));
  return proc;
}

/* ============================== 假的播放器 ============================== */

function fakeChild(pid = 1234) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.killed = 0;
  proc.exit = (code = 0) => {
    if (proc.exitCode !== null) return;
    proc.exitCode = code;
    proc.emit('exit', code);
  };
  proc.kill = () => {
    proc.killed += 1;
    proc.exit(9);
  };
  return proc;
}

/** 10 秒一个关键帧：PotPlayer 的跳转永远落到目标之前的那个。 */
const GOP_MS = 10000;
const keyframeBefore = (ms) => Math.floor(ms / GOP_MS) * GOP_MS;

class FakePotBridge extends EventEmitter {
  constructor(sim = {}) {
    super();
    this.hwnd = 777;
    this.calls = [];
    this.sim = {
      state: POT_STATE.PLAYING,
      positionMs: 0,
      durationMs: 600000,
      alive: true,
      denied: false,
      // 还要「装聋」几轮：PotPlayer 忙着跳转/换轨时会短暂不处理窗口消息，桥报 ERROR_TIMEOUT
      deaf: 0,
      ignorePauses: 0, // 头几条暂停被它自己的启动流程覆盖掉（P0 实测）
      ...sim,
    };
  }

  async start() {
    return { version: '1', hwnd: this.hwnd, pid: 999 };
  }

  potCalls(code) {
    return this.calls.filter((c) => c.cmd === 'pot' && c.calls.some(([id]) => id === code));
  }

  async call(cmd, payload = {}) {
    this.calls.push({ cmd, ...payload });
    const sim = this.sim;
    switch (cmd) {
      case 'allow':
      case 'forget':
      case 'track':
      case 'untrack':
        return true;
      case 'findWindow':
        return sim.alive ? this.hwnd : 0;
      case 'winState':
        return { hwnd: this.hwnd, alive: sim.alive };
      case 'close':
        if (this.onClose) this.onClose();
        return true;
      case 'potString':
        if (sim.fileName) {
          setImmediate(() => this.emit('copydata', { from: this.hwnd, pid: 1234, code: POT.GET_FILENAME, text: sim.fileName }));
        }
        return true;
      case 'potSetString':
        return 1;
      case 'pot':
        if (sim.deaf > 0) {
          sim.deaf -= 1;
          return payload.calls.map(() => ({ err: 1460 })); // ERROR_TIMEOUT：窗口没在处理消息
        }
        return payload.calls.map(([code, value]) => {
          if (sim.denied) return { err: 5 };
          switch (code) {
            case POT.GET_STATE:
              return { v: sim.state };
            case POT.GET_POSITION:
              return { v: sim.positionMs };
            case POT.GET_DURATION:
              return { v: sim.durationMs };
            case POT.SET_STATE:
              if (value === POT_STATE.PAUSED && sim.ignorePauses > 0) sim.ignorePauses -= 1;
              else sim.state = value;
              return { v: 1 };
            case POT.SET_POSITION:
              sim.positionMs = keyframeBefore(value);
              return { v: 1 };
            case POT.SEND_COMMAND:
              if (value === POT_CMD_NEXT_KEYFRAME) sim.positionMs = keyframeBefore(sim.positionMs) + GOP_MS;
              return { v: 1 };
            default:
              return { v: 0 };
          }
        });
      default:
        return true;
    }
  }
}

const potTiming = {
  pollMs: 5,
  // 判死按时间算（默认 2 秒），测试里缩到 60ms，但仍然比「连着几轮没应答」长
  unreachableMs: 60,
  namePollMs: 20,
  pauseTimeoutMs: 200,
  seekTimeoutMs: 800,
  launchTimeoutMs: 2000,
  windowTimeoutMs: 600,
  quitTimeoutMs: 500,
};

async function launchPot(sim = {}, options = {}) {
  const bridge = new FakePotBridge(sim);
  const proc = fakeChild();
  const adapter = new PotAdapter({
    bridge,
    spawn: () => proc,
    exePath: `C:${BS}pot${BS}PotPlayerMini64.exe`,
    timing: potTiming,
  });
  const ticks = [];
  const errors = [];
  adapter.on('tick', (t) => ticks.push(t));
  adapter.on('error', (e) => errors.push(e));
  // 默认「一关就退」，这样每条测试收尾不用干等退出超时；专门测退出的用例自己覆盖它。
  bridge.onClose = () => {
    bridge.sim.alive = false;
    proc.exit(0);
  };
  const info = await adapter.launch({ source: LOCAL_FILE, startPaused: true, startAt: 0, ...options });
  return { adapter, bridge, proc, ticks, errors, info };
}

class FakeMpcBridge extends EventEmitter {
  constructor(sim = {}) {
    super();
    this.hwnd = 777;
    this.calls = [];
    this.playerHwnd = 5150; // CMD_CONNECT 报来的
    this.enumHwnd = 9999; // 枚举窗口找到的，故意和上面不一样，好看出用的是哪条路
    this.sim = { position: 0, duration: 600, playState: MPC_PLAYSTATE.PAUSE, alive: true, deaf: false, connect: true, ...sim };
  }

  async start() {
    return { version: '1', hwnd: this.hwnd, pid: 999 };
  }

  push(code, text) {
    setImmediate(() => this.emit('copydata', { from: this.playerHwnd, pid: 1234, code, text: String(text) }));
  }

  mpcCalls(code) {
    return this.calls.filter((c) => c.cmd === 'mpc' && c.code === code);
  }

  async call(cmd, payload = {}) {
    this.calls.push({ cmd, ...payload });
    const sim = this.sim;
    switch (cmd) {
      case 'allow':
      case 'forget':
      case 'track':
      case 'untrack':
        return true;
      case 'findWindow':
        return sim.alive ? this.enumHwnd : 0;
      case 'winState':
        return { hwnd: payload.hwnd, alive: sim.alive };
      case 'close':
        if (this.onClose) this.onClose();
        return true;
      case 'mpcOsd':
        return 1;
      case 'mpc':
        if (sim.deaf) return 0; // 脱管：命令进得去，回包永远不来
        switch (payload.code) {
          case MPC.GETCURRENTPOSITION:
            this.push(MPC.CURRENTPOSITION, sim.position);
            break;
          case MPC.GETNOWPLAYING:
            this.push(MPC.NOWPLAYING, `标题|作者|描述|${sim.fileName || 'a.mkv'}|${sim.duration}`);
            break;
          case MPC.SETPOSITION:
            sim.position = parseFloat(payload.arg);
            this.push(MPC.NOTIFYSEEK, sim.position);
            break;
          case MPC.PAUSE:
            sim.playState = MPC_PLAYSTATE.PAUSE;
            this.push(MPC.PLAYMODE, MPC_PLAYSTATE.PAUSE);
            break;
          case MPC.PLAY:
            sim.playState = MPC_PLAYSTATE.PLAY;
            this.push(MPC.PLAYMODE, MPC_PLAYSTATE.PLAY);
            break;
          default:
            break;
        }
        return 1;
      default:
        return true;
    }
  }
}

const mpcTiming = {
  pollMs: 10,
  // 脱管按时间算（默认 1.8 秒），测试里缩到 120ms —— 仍然比 pollMs 的好几倍长
  detachMs: 120,
  pauseTimeoutMs: 300,
  seekTimeoutMs: 800,
  seekSettleMs: 30,
  launchTimeoutMs: 2000,
  connectTimeoutMs: 600,
  quitTimeoutMs: 500,
};

async function launchMpc(sim = {}, options = {}) {
  const bridge = new FakeMpcBridge(sim);
  const proc = fakeChild();
  const adapter = new MpcAdapter({
    bridge,
    spawn: () => proc,
    exePath: `C:${BS}mpc${BS}mpc-be64.exe`,
    timing: mpcTiming,
  });
  const ticks = [];
  const errors = [];
  adapter.on('tick', (t) => ticks.push(t));
  adapter.on('error', (e) => errors.push(e));
  bridge.onClose = () => {
    bridge.sim.alive = false;
    proc.exit(0);
  };
  if (bridge.sim.connect) setImmediate(() => bridge.push(MPC.CONNECT, bridge.playerHwnd));
  const info = await adapter.launch({ source: `D:${BS}a.mkv`, startPaused: true, startAt: 0, ...options });
  return { adapter, bridge, proc, ticks, errors, info };
}

/* ================================ 桥接客户端 ================================ */

test('找不到桥接程序时，报的是「怎么补上」而不是一个路径', async () => {
  // 文案写死在这里，不引常量：拿常量跟自己比，等于什么都没测。
  assert.equal(BRIDGE_MISSING_MESSAGE, '桥接程序未构建（npm run build:bridge）');
  const client = new BridgeClient({ find: () => null, spawn: () => fakeBridgeProcess() });
  await assert.rejects(client.start(), (error) => {
    assert.equal(error.message, '桥接程序未构建（npm run build:bridge）');
    assert.equal(error.code, 'BRIDGE_MISSING');
    return true;
  });
});

test('桥接程序只在两个落点找：resourcesPath/bin 和仓库 vendor/bin', () => {
  const candidates = bridgeCandidates({ resourcesPath: `C:${BS}app${BS}resources`, projectRoot: `D:${BS}repo` });
  assert.equal(candidates.length, 2);
  assert.ok(candidates[0].startsWith(`C:${BS}app${BS}resources`), '打包后的落点优先');
  assert.ok(candidates[1].startsWith(`D:${BS}repo`));
  assert.ok(candidates.every((p) => p.endsWith('NoxReelPlayerBridge.exe')));
  // 不走 PATH：PATH 里放一个同名程序不该被找到
  const found = findBridge({ resourcesPath: '', projectRoot: `D:${BS}repo`, exists: (p) => p === candidates[1] });
  assert.equal(found, candidates[1]);
});

test('NDJSON 一来一回：请求带自增 id，事件按名字分发', async () => {
  const proc = fakeBridgeProcess();
  proc.autoReply = (msg) => {
    if (msg.cmd === 'ping') proc.emitLine({ id: msg.id, ok: true, result: 'pong' });
    if (msg.cmd === 'boom') proc.emitLine({ id: msg.id, ok: false, error: 'window gone' });
  };
  const client = new BridgeClient({ exePath: 'fake.exe', spawn: () => proc });
  const seen = [];
  client.on('copydata', (msg) => seen.push(msg));
  client.on('win', (msg) => seen.push(msg));

  const info = await client.start();
  assert.equal(info.hwnd, 777, 'ready 里的 hwnd 要留着给 MPC-BE 的 /slave 用');
  assert.equal(client.hwnd, 777);

  assert.equal(await client.call('ping'), 'pong');
  await assert.rejects(client.call('boom'), /window gone/);
  assert.deepEqual(
    proc.requests.map((r) => r.id),
    [1, 2]
  );

  proc.emitLine({ ev: 'copydata', from: 5, pid: 6, code: 0x50000007, text: '12.5' });
  proc.emitLine({ ev: 'win', hwnd: 5, alive: true });
  await until(() => seen.length === 2);
  assert.equal(seen[0].text, '12.5');
  assert.equal(seen[1].alive, true);
  await client.stop();
});

test('桥不回话就超时，不会把适配器永远挂在 await 上', async () => {
  const proc = fakeBridgeProcess();
  const client = new BridgeClient({ exePath: 'fake.exe', spawn: () => proc, timeoutMs: 40 });
  await client.start();
  await assert.rejects(client.call('pot', { hwnd: 1 }), /桥接程序无响应：pot/);
  await client.stop();
});

test('桥意外退出：在途请求当场失败，下一条指令把它拉起来并广播 restart', async () => {
  const procs = [];
  const spawn = () => {
    const proc = fakeBridgeProcess();
    proc.autoReply = (msg) => proc.emitLine({ id: msg.id, ok: true, result: 'pong' });
    procs.push(proc);
    return proc;
  };
  const client = new BridgeClient({ exePath: 'fake.exe', spawn });
  await client.start();
  procs[0].autoReply = null; // 这一条永远不会有回包
  const pending = client.call('ping');
  procs[0].exit(1);
  await assert.rejects(pending, /桥接程序已退出/);

  let restarted = 0;
  client.on('restart', () => {
    restarted += 1;
  });
  assert.equal(await client.call('ping'), 'pong');
  assert.equal(procs.length, 2, '重新拉起了一个');
  assert.equal(restarted, 1, '适配器要靠这个事件把 allow / track 补登记回去');
  await client.stop();
});

test('反复崩溃的桥不会被无限拉起', async () => {
  const spawn = () => {
    const proc = fakeBridgeProcess();
    setImmediate(() => proc.exit(3));
    return proc;
  };
  const client = new BridgeClient({ exePath: 'fake.exe', spawn, maxRestarts: 2 });
  await client.start().catch(() => {});
  await client.call('ping').catch(() => {});
  await client.call('ping').catch(() => {});
  await assert.rejects(client.call('ping'), /反复退出/);
});

test('关掉桥是关 stdin，让它自己退', async () => {
  const proc = fakeBridgeProcess();
  const client = new BridgeClient({ exePath: 'fake.exe', spawn: () => proc });
  await client.start();
  assert.equal(await client.stop(), true);
  assert.equal(proc.exitCode, 0, 'stdin 关了就退出，不用杀');
  assert.equal(proc.killed, 0);
  await assert.rejects(client.call('ping'), /已关闭/);
});

test('等待机构：连续成立几次才算稳，soft 超时返回 null', async () => {
  const hub = createWaiterHub({ name: 'PotPlayer' });
  const waiting = hub.waitFor((s) => s.paused, { times: 2, timeoutMs: 500 });
  hub.notify({ paused: true });
  hub.notify({ paused: false });
  hub.notify({ paused: true });
  let done = false;
  waiting.then(() => {
    done = true;
  });
  await sleep(10);
  assert.equal(done, false, '中间断了一次就要重新数');
  hub.notify({ paused: true });
  await waiting;

  assert.equal(await hub.waitFor(() => false, { timeoutMs: 20, soft: true }), null);
  await assert.rejects(hub.waitFor(() => false, { timeoutMs: 20, label: '暂停' }), /等 PotPlayer 暂停 超时/);
});

/* ================================ 参数消毒 ================================ */

test('参数一律拒绝双引号和前导斜杠', () => {
  assert.throws(() => sanitizeArg(`a${BS}b"c`), /不合法/);
  assert.throws(() => sanitizeArg('/volume=0'), /不合法/);
  assert.throws(() => sanitizeArg('-fullscreen'), /不合法/);
  assert.throws(() => sanitizeArg(`行首${String.fromCharCode(10)}换行`), /不合法/);
  assert.equal(sanitizeArg(LOCAL_FILE), LOCAL_FILE);
});

test('链接统一用 new URL().href 规范化，带凭据的一律拒绝', () => {
  assert.equal(normalizeSource('HTTP://Example.COM:80/a b.mp4?x=1'), 'http://example.com/a%20b.mp4?x=1');
  assert.throws(() => normalizeSource('ftp://h/a.mp4'), /媒体链接不合法/);
  assert.throws(() => normalizeSource('https://user:pass@h/a.mp4'), /媒体链接不合法/);
  assert.equal(normalizeSource(` ${LOCAL_FILE} `), LOCAL_FILE);
});

/* ================================ 路径探测 ================================ */

test('reg query 的输出能解出带空格的路径，查不到时返回 null', () => {
  const out = [
    '',
    'HKEY_CURRENT_USER' + BS + 'Software' + BS + 'DAUM' + BS + 'PotPlayer64',
    `    ProgramPath    REG_SZ    C:${BS}Program Files${BS}DAUM${BS}PotPlayer${BS}PotPlayerMini64.exe`,
    '',
  ].join(String.fromCharCode(13, 10));
  assert.equal(parseRegQuery(out, 'ProgramPath'), `C:${BS}Program Files${BS}DAUM${BS}PotPlayer${BS}PotPlayerMini64.exe`);
  assert.equal(parseRegQuery('错误: 系统找不到指定的注册表项或值。', 'ProgramPath'), null);
  assert.equal(parseRegQuery('', 'ExePath'), null);
});

test('注册表值可能是 exe 也可能是目录，非白名单的 exe 一概不碰', () => {
  const exe = `C:${BS}p${BS}PotPlayerMini64.exe`;
  assert.deepEqual(programPathCandidates(exe, ['PotPlayerMini64.exe']), [exe]);
  assert.deepEqual(programPathCandidates(`"${exe}"`, ['PotPlayerMini64.exe']), [exe]);
  assert.deepEqual(programPathCandidates(`C:${BS}p${BS}evil.exe`, ['PotPlayerMini64.exe']), []);
  assert.deepEqual(programPathCandidates(`C:${BS}p`, ['mpc-be64.exe']), [`C:${BS}p${BS}mpc-be64.exe`]);
  assert.equal(isAllowedExe(`C:${BS}x${BS}mpc-be64.exe`), true);
  assert.equal(isAllowedExe(`C:${BS}x${BS}cmd.exe`), false);
  assert.equal(kindOfExe('PotPlayerMini.exe'), 'pot');
  assert.equal(kindOfExe('mpc-be.exe'), 'mpc');
  assert.equal(kindOfExe('vlc.exe'), null);
  // 白名单只说明「是个播放器」，不说明是哪个：pot 的注册表值指向 mpc 的 exe 一律不认。
  // 认了的话 PotPlayer 适配器会拿着 /new /seek= 去启动 MPC-BE，然后一路卡到 20 秒启动超时。
  assert.deepEqual(programPathCandidates(`C:${BS}p${BS}mpc-be64.exe`, ['PotPlayerMini64.exe', 'PotPlayer64.exe']), []);
  assert.deepEqual(programPathCandidates(`C:${BS}p${BS}PotPlayerMini64.exe`, ['mpc-be64.exe', 'mpc-be.exe']), []);
});

test('注册表串了台：pot 的键指向 mpc 的 exe 时，两边都不认', async () => {
  const mpcExe = `C:${BS}Program Files${BS}MPC-BE${BS}mpc-be64.exe`;
  const found = await discoverPlayers({
    // PotPlayer 装过又卸过（或者有人写进去的）：ProgramPath 留在注册表里，指的却是 MPC-BE
    regQuery: async (key, value) => (key.includes('PotPlayer64') ? `    ${value}    REG_SZ    ${mpcExe}` : ''),
    exists: (p) => p === mpcExe,
    env: {},
  });
  assert.equal(found.pot.path, null, 'PotPlayer 适配器会拿它的参数去启动 MPC-BE');
  assert.equal(found.pot.source, 'none');
  assert.equal(found.mpc.path, null, 'pot 那条线索不该顺手把 mpc 也认了');
});

test('探测优先注册表，用户自选路径必须过白名单', async () => {
  const potExe = `C:${BS}DAUM${BS}PotPlayerMini64.exe`;
  const mpcExe = `C:${BS}MPC-BE${BS}mpc-be64.exe`;
  const regQuery = async (key, value) => {
    if (key.includes('PotPlayer64') && value === 'ProgramPath') return `    ProgramPath    REG_SZ    ${potExe}`;
    if (key.includes('MPC-BE') && value === 'ExePath') return `    ExePath    REG_SZ    ${mpcExe}`;
    return '';
  };
  const exists = (p) => [potExe, mpcExe, `C:${BS}other${BS}mpc-be.exe`].includes(p);
  const found = await discoverPlayers({ regQuery, exists, env: {} });
  assert.equal(found.pot.path, potExe);
  assert.equal(found.pot.source, 'registry');
  assert.equal(found.mpc.path, mpcExe);

  const overridden = await discoverPlayers({
    regQuery,
    exists,
    env: {},
    overrides: { pot: `C:${BS}evil${BS}cmd.exe`, mpc: `C:${BS}other${BS}mpc-be.exe` },
  });
  assert.equal(overridden.pot.path, potExe, '不在白名单里的自选路径直接无视');
  assert.equal(overridden.mpc.path, `C:${BS}other${BS}mpc-be.exe`);
  assert.equal(overridden.mpc.source, 'user');
});

/* ================================ PotPlayer ================================ */

test('PotPlayer 的命令行：文件在前、开关在后，一个音量参数都没有', () => {
  const args = buildPotArgs({ source: LOCAL_FILE, startAt: 3661, headers: { Referer: 'https://e.com/', 'User-Agent': 'UA/1' } });
  assert.deepEqual(args, [LOCAL_FILE, '/new', '/seek=01:01:01', '/referer=https://e.com/', '/user_agent=UA/1']);
  assert.equal(formatSeek(0), '00:00:00');
  for (const arg of args) {
    assert.ok(!/volume|mute/i.test(arg), '音量会被 PotPlayer 永久写进注册表，绝不能传');
  }
  assert.throws(() => buildPotArgs({ source: `C:${BS}a"b.mp4` }), /不合法/);
  assert.throws(() => buildPotArgs({ source: LOCAL_FILE, headers: { Referer: '/x' } }), /不合法/);
});

test('PotPlayer 启动：反复补发暂停，连着三次读到暂停才 resolve，之前不发 tick', async () => {
  const { adapter, bridge, ticks } = await launchPot({ state: POT_STATE.PLAYING, ignorePauses: 2 });
  const pauses = bridge.potCalls(POT.SET_STATE);
  assert.ok(pauses.length >= 3, `单发一次会被覆盖，实际发了 ${pauses.length} 次`);
  assert.equal(adapter.snapshot().paused, true);
  assert.ok(ticks.length <= 1, '稳定之前不许发 tick');
  const traffic = bridge.calls.map((c) => c.cmd);
  assert.ok(traffic.includes('allow') && traffic.includes('track'), '先登记 PID 再跟踪窗口');
  await adapter.quit();
});

test('PotPlayer 跳转：先跳目标，再跳下一个关键帧，然后原地暂停', async () => {
  const { adapter, bridge } = await launchPot({ state: POT_STATE.PLAYING, positionMs: 0 });
  bridge.calls.length = 0;
  const result = await adapter.seek(25);

  const sent = bridge.calls
    .filter((c) => c.cmd === 'pot')
    .flatMap((c) => c.calls)
    .filter(([code]) => code !== POT.GET_STATE && code !== POT.GET_POSITION && code !== POT.GET_DURATION);
  assert.deepEqual(sent, [
    [POT.SET_POSITION, 25000],
    [POT.SEND_COMMAND, POT_CMD_NEXT_KEYFRAME],
    [POT.SET_STATE, POT_STATE.PAUSED],
  ]);
  assert.equal(result.keyframe, true);
  assert.equal(result.paused, true, '停在房间前面等大家追上来');
  assert.ok(result.position >= 25, `落点要在目标之后，实际 ${result.position}`);
  assert.equal(adapter.caps.keyframeAhead, true);
  await adapter.quit();
});

test('PotPlayer 跳转：落点已经贴着目标时不做补救，跳 0:00 不会跳过片头', async () => {
  const { adapter, bridge } = await launchPot({ state: POT_STATE.PAUSED });
  await playTo(adapter, bridge, 120);
  bridge.calls.length = 0;
  const result = await adapter.seek(0);
  const sent = bridge.calls
    .filter((c) => c.cmd === 'pot')
    .flatMap((c) => c.calls)
    .filter(([code]) => code === POT.SEND_COMMAND);
  assert.deepEqual(sent, [], '本来就落在关键帧上，再跳一次会白跳过一整个 GOP');
  assert.equal(result.keyframe, false);
  assert.equal(bridge.sim.positionMs, 0);
  await adapter.quit();
});

/** 起播之后把播放头挪到某处，并等轮询把它读进来（launch 是从 0 起的，不能一开始就塞在片尾）。 */
async function playTo(adapter, bridge, seconds) {
  bridge.sim.positionMs = Math.round(seconds * 1000);
  await until(() => Math.abs(adapter.snapshot().position - seconds) < 1);
}

test('PotPlayer 放完：状态归零前贴着片尾算 eof，半截停下只是用户按了停止', async () => {
  const { adapter, bridge, ticks } = await launchPot({ state: POT_STATE.PLAYING, durationMs: 600000 });
  await playTo(adapter, bridge, 599);
  ticks.length = 0;
  bridge.sim.state = POT_STATE.STOPPED;
  bridge.sim.positionMs = 0; // P0：放完时位置会归零，判定只能用停止前的最后一次
  const eof = await until(() => ticks.find((t) => t.eof));
  assert.equal(eof.eof, true);
  assert.equal(adapter.snapshot().eof, true);

  // 用户又按了播放：上一次的 eof 必须翻篇，否则上层会以为这一部也放完了，一路推下去
  bridge.sim.state = POT_STATE.PLAYING;
  bridge.sim.positionMs = 1000;
  await until(() => adapter.snapshot().eof === false);
  await adapter.quit();

  const second = await launchPot({ state: POT_STATE.PLAYING, durationMs: 600000 });
  await playTo(second.adapter, second.bridge, 60);
  second.ticks.length = 0;
  second.bridge.sim.state = POT_STATE.STOPPED;
  second.bridge.sim.positionMs = 0;
  await sleep(60);
  assert.deepEqual(second.ticks, [], '停止时不广播，否则全房间被拖回片头');
  await second.adapter.quit();
});

test('PotPlayer 换文件：时长一变就是换了片，没放完就暂停并提示', async () => {
  const { adapter, bridge, errors } = await launchPot({ state: POT_STATE.PLAYING, durationMs: 600000 });
  await playTo(adapter, bridge, 60);
  bridge.calls.length = 0;
  bridge.sim.durationMs = 1200000;
  const error = await until(() => errors[0]);
  assert.equal(error.code, 'PLAYER_FOREIGN_FILE');
  assert.ok(bridge.potCalls(POT.SET_STATE).length > 0, '要把它按住，不能让它推着房间往下走');
  await adapter.quit();
});

test('PotPlayer 换文件：换之前已经贴着片尾，算放完而不是走神', async () => {
  const { adapter, bridge, ticks, errors } = await launchPot({ state: POT_STATE.PLAYING, durationMs: 600000 });
  await playTo(adapter, bridge, 599);
  ticks.length = 0;
  bridge.sim.durationMs = 1200000;
  const eof = await until(() => ticks.find((t) => t.eof));
  assert.equal(eof.eof, true);
  assert.deepEqual(errors, []);
  await adapter.quit();
});

test('PotPlayer 被提权了就明说，而不是装作在同步', async () => {
  const bridge = new FakePotBridge({ denied: true });
  const proc = fakeChild();
  const adapter = new PotAdapter({ bridge, spawn: () => proc, exePath: 'pot.exe', timing: potTiming });
  const errors = [];
  adapter.on('error', (e) => errors.push(e));
  await assert.rejects(adapter.launch({ source: LOCAL_FILE }), (error) => {
    assert.ok(error.code === 'PLAYER_ELEVATED' || errors.some((e) => e.code === 'PLAYER_ELEVATED'), error.message);
    return true;
  });
  await adapter.quit();
});

test('PotPlayer 不理暂停时，命令在上限处收手，期间的 tick 标 cmd', async () => {
  const { adapter, bridge, ticks } = await launchPot({ state: POT_STATE.PAUSED });
  bridge.sim.ignorePauses = 1000; // 怎么发都不听
  bridge.sim.state = POT_STATE.PLAYING;
  ticks.length = 0;
  const started = Date.now();
  const result = await adapter.setPause(true);
  const spent = Date.now() - started;
  assert.equal(result.settled, false, '等不到就如实报，别谎称已暂停');
  assert.ok(spent < 1000, `1 秒上限，实际 ${spent}ms`);
  assert.ok(
    ticks.length > 0 && ticks.every((t) => t.cause === 'cmd'),
    '命令在途期间的 tick 一律 cmd，同步引擎不该拿它当用户操作'
  );
  await adapter.quit();
});

test('PotPlayer 的位置在两次采样之间靠外推往前走', async () => {
  const { adapter, bridge } = await launchPot({ state: POT_STATE.PAUSED });
  await playTo(adapter, bridge, 30);
  bridge.sim.state = POT_STATE.PLAYING;
  await until(() => !adapter.snapshot().paused);
  const first = adapter.position();
  await sleep(120);
  const second = adapter.position();
  assert.ok(second > first, `位置每 500ms 才变一次，中间要自己推：${first} → ${second}`);
  assert.ok(second - first < 0.8, '外推有上限，轮询断了不能越推越离谱');
  await adapter.quit();
});

test('PotPlayer 退出：先发 WM_CLOSE，进程真没了才算退干净', async () => {
  const { adapter, bridge, proc } = await launchPot();
  bridge.onClose = () => {
    setTimeout(() => {
      bridge.sim.alive = false;
      proc.exit(0);
    }, 120);
  };
  const started = Date.now();
  assert.equal(await adapter.quit(), true);
  assert.ok(Date.now() - started >= 100, '没等进程落地就返回，删缓存会撞上没放开的文件句柄');
  assert.equal(proc.killed, 0, '正常关掉的不该被杀');
  assert.ok(bridge.calls.some((c) => c.cmd === 'close'));
  assert.ok(bridge.calls.some((c) => c.cmd === 'forget'), '退出后要撤掉 PID 授权');
});

test('PotPlayer 不肯退出时超时强杀，不会永远挂着', async () => {
  const { adapter, bridge, proc } = await launchPot();
  bridge.onClose = null; // 装死：WM_CLOSE 收下了，窗口和进程都不动
  assert.equal(await adapter.quit(), false);
  assert.equal(proc.killed, 1);
});

test('PotPlayer 短暂不处理消息不算断了：跳转、换轨常常要几百毫秒', async () => {
  const { adapter, bridge, errors } = await launchPot({ state: POT_STATE.PAUSED });
  // 连着 6 轮（6 × 5ms = 30ms）没应答。真机上 3 × 200ms 才 600ms，一次大文件跳转就到了
  bridge.sim.deaf = 6;
  await until(() => bridge.sim.deaf === 0, { timeout: 1000 });
  await sleep(30);
  assert.deepEqual(errors, [], '几轮不应答就判死，等于让一次正常的卡顿把播放器踢掉');
  assert.equal(adapter.lastError, null);
  // 判死是终态：得连着 unreachableMs 那么久一条都问不到才算
  bridge.sim.deaf = 10 ** 6;
  const error = await until(() => errors[0], { timeout: 2000 });
  assert.equal(error.code, 'PLAYER_UNREACHABLE');
  await adapter.quit();
});

test('PotPlayer 判死之后轮询真的停下来，不再往桥上发指令', async () => {
  const { adapter, bridge, errors } = await launchPot({ state: POT_STATE.PAUSED });
  bridge.sim.denied = true; // 提权：每一条都 ACCESS_DENIED，当场判死
  await until(() => errors[0], { timeout: 1000 });
  assert.equal(errors[0].code, 'PLAYER_ELEVATED');
  // _fail() 里的 _stopLoop() 是在轮询回调内部调的：那时本轮定时器早触发过了，
  // clearTimeout 清了个寂寞 —— 少一道 _looping 判断，判死之后照样一秒几十批桥接调用
  const after = bridge.calls.length;
  await sleep(60); // 按 pollMs=5 算，这段时间够跑十几轮
  assert.equal(bridge.calls.length, after, '判死之后还在轮询');
  assert.equal(adapter._loopTimer, null, '定时器还排着，下一轮照样会跑起来');
  await adapter.quit();
});

test('PotPlayer 判死之后再跳转，关键帧补救照做 —— 落点不许退回目标之前', async () => {
  const { adapter, bridge, errors } = await launchPot({ state: POT_STATE.PAUSED });
  bridge.sim.denied = true;
  await until(() => errors[0], { timeout: 1000 });
  bridge.sim.denied = false; // 播放器其实好好的，只是这一路已经判过死了

  const result = await adapter.seek(245);
  assert.equal(result.keyframe, true, '补救整段被跳过了');
  // 10 秒 GOP：0x5005 落到 240s，补一次「下一个关键帧」才到 250s。
  // 少了这一步就是 240s —— 比目标早 5 秒，而上层对 seek 的失败是静默吞掉的，再没人纠正
  assert.equal(bridge.sim.positionMs, 250000);
  assert.ok(bridge.potCalls(POT.SEND_COMMAND).length >= 1, '没发「下一个关键帧」');

  // 跳到片头那一下除外：0:00 本来就在关键帧上，补一下反而跳过一整个 GOP 的片头
  await adapter.seek(0);
  assert.equal(bridge.sim.positionMs, 0, '跳到片头不该被补救推到 0:10');
  await adapter.quit();
});

test('PotPlayer 判死之后往回跳：不能拿判死前的旧位置当落点', async () => {
  const { adapter, bridge, errors } = await launchPot({ state: POT_STATE.PLAYING });
  await playTo(adapter, bridge, 300); // 判死之前最后读到的位置是 5:00
  bridge.sim.denied = true;
  await until(() => errors[0], { timeout: 1000 });
  bridge.sim.denied = false;

  // 往回跳到 2:35。轮询停了，适配器手上的位置还停在 300 秒 ——
  // 照它判断会得出「落点 300 秒，比目标靠后，不用补救」，而真实落点是 2:30（早 5 秒）
  const back = await adapter.seek(155);
  assert.equal(back.keyframe, true);
  assert.equal(bridge.sim.positionMs, 160000, '落在目标之前的关键帧上，没人再纠正得了');
  await adapter.quit();
});

test('外部播放器不画弹幕帧，但横幅和 OSD 都要有', async () => {
  const { adapter, bridge } = await launchPot();
  assert.equal(typeof adapter.setDanmakuFrame, 'undefined', '弹幕由覆盖窗画，适配器不能假装能画');
  const banners = [];
  adapter.on('banner', (b) => banners.push(b.text));
  assert.equal(adapter.setBanner('等 3 人缓冲'), true);
  assert.equal(adapter.setBanner('等 3 人缓冲'), false, '没变化就别重发');
  assert.deepEqual(banners, ['等 3 人缓冲']);
  await adapter.osd('已连接');
  const osd = bridge.calls.filter((c) => c.cmd === 'potSetString');
  assert.ok(osd.length >= 2);
  assert.equal(osd[osd.length - 1].code, POT.SHOW_OSD);
  await adapter.quit();
});

test('外部播放器的弹幕输入走覆盖窗，事件名和 mpv 一样', async () => {
  const { adapter } = await launchPot();
  const got = [];
  adapter.on('chat-input', (payload) => got.push(payload));
  adapter.deliverChatInput({ text: '哈哈' });
  assert.deepEqual(got, [{ text: '哈哈', kind: 'pot' }]);
  await adapter.quit();
});

/* ================================= MPC-BE ================================= */

test('MPC-BE 的命令行：/new /open /slave，起播位置按毫秒，没有音量', () => {
  const args = buildMpcArgs({ source: `D:${BS}a.mkv`, startAt: 12.5, slaveHwnd: 66051 });
  assert.deepEqual(args, [`D:${BS}a.mkv`, '/new', '/open', '/slave', '66051', '/start', '12500']);
  for (const arg of args) assert.ok(!/volume/i.test(arg), 'MPC-BE 的 /volume 会写进注册表');
});

test('MPC-BE 传不了请求头，需要请求头的链接当场退回 mpv', () => {
  assert.throws(
    () => buildMpcArgs({ source: 'https://h/a.mp4', headers: { referer: 'https://h/' }, slaveHwnd: 1 }),
    (error) => {
      assert.equal(error.code, 'PLAYER_NO_HEADERS');
      return true;
    }
  );
  assert.doesNotThrow(() => buildMpcArgs({ source: 'https://h/a.mp4', headers: {}, slaveHwnd: 1 }));
});

test('MPC-BE 启动：认 CMD_CONNECT 报来的 hwnd，/open 即暂停', async () => {
  const { adapter, bridge, info } = await launchMpc();
  assert.equal(info.hwnd, bridge.playerHwnd, 'CONNECT 带回来的 hwnd 比枚举出来的可靠');
  assert.notEqual(info.hwnd, bridge.enumHwnd);
  assert.equal(adapter.snapshot().paused, true);
  assert.ok(bridge.calls.some((c) => c.cmd === 'track' && c.hwnd === bridge.playerHwnd));
  await adapter.quit();
});

test('MPC-BE 的 /start 没生效时，启动阶段自己补一跳', async () => {
  const { adapter, bridge } = await launchMpc({}, { startAt: 300 }); // 假播放器故意无视 /start
  assert.ok(Math.abs(adapter.snapshot().position - 300) < 1, `起点要对上，实际 ${adapter.snapshot().position}`);
  assert.equal(bridge.mpcCalls(MPC.SETPOSITION)[0].arg, '300');
  await adapter.quit();
});

test('MPC-BE 不发 CONNECT 时退一步枚举窗口，照样能接管', async () => {
  const { adapter, bridge, info } = await launchMpc({ connect: false });
  assert.equal(info.hwnd, bridge.enumHwnd);
  await adapter.quit();
});

test('MPC-BE 靠推送更新状态，播完推 NOTIFYENDOFSTREAM', async () => {
  const { adapter, bridge, ticks } = await launchMpc();
  bridge.push(MPC.PLAYMODE, MPC_PLAYSTATE.PLAY);
  await until(() => adapter.snapshot().paused === false);
  bridge.sim.position = 42;
  await until(() => adapter.snapshot().position >= 42);
  ticks.length = 0;
  bridge.push(MPC.NOTIFYENDOFSTREAM, '');
  const eof = await until(() => ticks.find((t) => t.eof));
  assert.equal(eof.eof, true);
  await adapter.quit();
});

test('MPC-BE 跳转：等 NOTIFYSEEK 且状态稳定，不需要关键帧补救', async () => {
  const { adapter, bridge } = await launchMpc();
  const result = await adapter.seek(75);
  assert.equal(result.keyframe, false);
  assert.equal(result.settled, true);
  assert.ok(Math.abs(result.position - 75) < 0.5, `跳转精确到帧，实际 ${result.position}`);
  assert.equal(bridge.mpcCalls(MPC.SETPOSITION)[0].arg, '75');
  assert.equal(adapter.caps.seekPrecision, 0);
  await adapter.quit();
});

test('MPC-BE 脱管：一直问不到位置就明说，不装作还在同步', async () => {
  const { adapter, bridge, errors } = await launchMpc();
  bridge.sim.deaf = true;
  const error = await until(() => errors[0], { timeout: 2000 });
  assert.equal(error.code, 'PLAYER_DETACHED');
  assert.ok(/退回 mpv/.test(error.message));
  await adapter.quit();
});

test('MPC-BE 忙上半秒不算脱管：判据是时间，不是轮数', async () => {
  const bridge = new FakeMpcBridge();
  const proc = fakeChild();
  // pollMs 25ms、detachMs 500ms：回包晚到 200ms（等于 8 个轮询周期）也不能判脱管
  const adapter = new MpcAdapter({
    bridge,
    spawn: () => proc,
    exePath: `C:${BS}mpc${BS}mpc-be64.exe`,
    timing: { ...mpcTiming, pollMs: 25, detachMs: 500 },
  });
  const errors = [];
  adapter.on('error', (e) => errors.push(e));
  bridge.onClose = () => {
    bridge.sim.alive = false;
    proc.exit(0);
  };
  setImmediate(() => bridge.push(MPC.CONNECT, bridge.playerHwnd));
  await adapter.launch({ source: `D:${BS}a.mkv`, startPaused: true, startAt: 0 });

  bridge.sim.deaf = true; // 播放器忙着（大文件跳转 / 换音轨 / madVR 初始化）
  await sleep(200);
  bridge.sim.deaf = false;
  assert.deepEqual(errors, [], '半秒以内没回包就判脱管，等于把一个健康的播放器当场判死');
  await until(() => !adapter._awaiting, { timeout: 1000 });

  // 真的一直不回包才算脱管
  bridge.sim.deaf = true;
  const error = await until(() => errors[0], { timeout: 2000 });
  assert.equal(error.code, 'PLAYER_DETACHED');
  await adapter.quit();
});

test('MPC-BE 判死之后轮询停下来，不再空转', async () => {
  const { adapter, bridge, errors } = await launchMpc();
  bridge.sim.deaf = true;
  await until(() => errors[0], { timeout: 2000 });
  const after = bridge.calls.length;
  await sleep(60); // pollMs=10，这段时间够跑好几轮
  assert.equal(bridge.calls.length, after, '判死之后还在往桥上发指令');
  // 和 pot 那边同源：_fail() → _stopLoop() 是在轮询回调内部调的，那时本轮定时器早触发过了，
  // clearTimeout 清了个寂寞。少一道 _looping 判断，这个表会一直转到 quit() 为止。
  assert.equal(adapter._loopTimer, null, '判死之后定时器还排着，轮询一直在空转');
  await adapter.quit();
});

test('MPC-BE 的 OSD 截到 127 字，结构体的位置和时长都带上', async () => {
  const { adapter, bridge } = await launchMpc();
  await adapter.osd('字'.repeat(200));
  const osd = bridge.calls.filter((c) => c.cmd === 'mpcOsd').pop();
  assert.equal([...osd.text].length, MPC_OSD_MAX, '结构体里是 WCHAR[128]，末尾要留给 NUL');
  assert.equal(typeof osd.pos, 'number');
  assert.ok(osd.ms >= 500);
  await adapter.quit();
});

test('MPC-BE 换文件：NOWPLAYING 的文件名变了就暂停并提示', async () => {
  const { adapter, bridge, errors } = await launchMpc();
  bridge.push(MPC.NOWPLAYING, '标题|作者|描述|另一部.mkv|1200');
  const error = await until(() => errors[0]);
  assert.equal(error.code, 'PLAYER_FOREIGN_FILE');
  assert.ok(bridge.mpcCalls(MPC.PAUSE).length > 0);
  await adapter.quit();
});

test('MPC-BE 退出：等进程真正退出', async () => {
  const { adapter, bridge, proc } = await launchMpc();
  bridge.onClose = () => {
    bridge.sim.alive = false;
    proc.exit(0);
  };
  assert.equal(await adapter.quit(), true);
  assert.equal(proc.killed, 0);
  assert.ok(bridge.calls.some((c) => c.cmd === 'close'));
});

test('两个外部播放器都不接手正在增长的文件', () => {
  assert.equal(new PotAdapter().caps.streaming, false);
  assert.equal(new MpcAdapter().caps.streaming, false);
  assert.equal(new PotAdapter().kind, 'pot');
  assert.equal(new MpcAdapter().kind, 'mpc');
});
