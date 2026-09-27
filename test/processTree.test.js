'use strict';

// 结束子进程连同它的子孙（src/main/processTree.js）。yt-dlp.exe 是 PyInstaller 单文件包：引导进程再起干活的子进程，
// Windows 上 child.kill() 只杀引导进程，子进程接着下、还攥着管道（实测）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { killTree, taskkillPath } = require('../src/main/processTree');
const { writeTwoLayer, alive, workerPidOf } = require('./helpers/twoLayerProcess');

function fakeChild({ pid = 4242, exitCode = null } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = exitCode;
  child.signalCode = null;
  child.kills = 0;
  child.kill = () => {
    child.kills++;
    return true;
  };
  return child;
}

/** 假 taskkill：记下命令行，按 outcome 退出（数字 = 退出码，'error' = 起不来，'hang' = 一直不退）。 */
function fakeTaskkill(outcome) {
  const calls = [];
  const spawnImpl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (outcome === 'throw') throw new Error('spawn EPERM');
    const proc = new EventEmitter();
    if (outcome === 'error') setImmediate(() => proc.emit('error', new Error('spawn ENOENT')));
    else if (outcome !== 'hang') setImmediate(() => proc.emit('exit', outcome));
    return proc;
  };
  return { spawnImpl, calls };
}

test('Windows 上用系统目录里的 taskkill 按 PID 结束整棵树（/T /F），不按进程名', async () => {
  const child = fakeChild({ pid: 31337 });
  const { spawnImpl, calls } = fakeTaskkill(0);
  await killTree(child, { platform: 'win32', spawnImpl });
  assert.equal(calls.length, 1);
  assert.equal(path.basename(calls[0].cmd).toLowerCase(), 'taskkill.exe');
  assert.equal(path.basename(path.dirname(calls[0].cmd)).toLowerCase(), 'system32', '用系统目录里那个，不靠 PATH');
  assert.deepEqual(calls[0].args, ['/PID', '31337', '/T', '/F']);
  assert.ok(!calls[0].args.includes('/IM'), '绝不按映像名杀：用户自己另开的 yt-dlp 不能被连带');
  assert.equal(calls[0].opts.windowsHide, true);
  assert.equal(child.kills, 0, 'taskkill 成功了就不用再补一刀');
  assert.match(taskkillPath({ SystemRoot: 'D:\\Win' }), /^D:[\\/]Win[\\/]System32[\\/]taskkill\.exe$/);
});

test('taskkill 失败、起不来、卡住都退回 child.kill()，至少引导进程要停', async () => {
  for (const outcome of [128, 'error', 'throw']) {
    const child = fakeChild();
    await killTree(child, { platform: 'win32', spawnImpl: fakeTaskkill(outcome).spawnImpl });
    assert.equal(child.kills, 1, String(outcome));
  }
  const child = fakeChild();
  await killTree(child, { platform: 'win32', spawnImpl: fakeTaskkill('hang').spawnImpl, timeoutMs: 20 });
  assert.equal(child.kills, 1, '卡住的 taskkill 等超时就不等了');
});

test('已经退了的不再动它（PID 可能已经给了别的进程）；没有 PID、不是 Windows 就直接 child.kill()', async () => {
  const exited = fakeChild({ exitCode: 0 });
  const { spawnImpl, calls } = fakeTaskkill(0);
  await killTree(exited, { platform: 'win32', spawnImpl });
  const signaled = fakeChild();
  signaled.signalCode = 'SIGTERM';
  await killTree(signaled, { platform: 'win32', spawnImpl });
  assert.equal(calls.length, 0);
  assert.equal(exited.kills + signaled.kills, 0);
  await killTree(null);

  const noPid = fakeChild();
  noPid.pid = undefined; // 起不来的子进程没有 PID
  await killTree(noPid, { platform: 'win32', spawnImpl });
  const posix = fakeChild();
  await killTree(posix, { platform: 'linux', spawnImpl });
  assert.equal(calls.length, 0);
  assert.equal(noPid.kills, 1);
  assert.equal(posix.kills, 1, 'PyInstaller 的引导进程在 POSIX 上会把 SIGTERM 转给子进程');
});

test('真的两层进程：引导进程和它起的子进程都结束，管道随之关上', { timeout: 30_000 }, async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'noxreel-tree-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const parent = await writeTwoLayer(dir, "setInterval(() => process.stdout.write('tick\\n'), 50);");
  const child = spawn(process.execPath, [parent], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let workerPid = 0;
  t.after(() => {
    for (const pid of [child.pid, workerPid]) {
      if (pid && alive(pid)) process.kill(pid);
    }
  });
  workerPid = await workerPidOf(child);
  assert.ok(alive(workerPid));
  const closed = new Promise((resolve) => child.on('close', resolve));
  await killTree(child);
  // 'close' 要等两层都退了、管道都关上才来：只杀引导进程的话（Windows 上的 child.kill()）它不会来
  await closed;
  for (let i = 0; i < 100 && alive(workerPid); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(workerPid), false, '干活的子进程也结束了');
});
