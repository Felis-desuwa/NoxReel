'use strict';

/**
 * 结束我们自己起的子进程，连同它的子孙。
 *
 * yt-dlp.exe 是 PyInstaller 单文件包：先起一个引导进程，引导进程再起真正干活的 Python 子进程。
 * Windows 上 child.kill() 只 TerminateProcess 引导进程 —— 子进程成了孤儿接着下，还攥着继承来的
 * stdout / stderr 管道，Node 的 'close' 要等它自己下完退出才来：半截文件删不掉，下载名额也一直占着（实测）。
 *
 * Windows 上改用系统自带的 taskkill /PID <pid> /T /F：只认这个 PID 和它的子孙，绝不按进程名杀
 * （用户自己另开的 yt-dlp 不能被连带）。调用时子进程还没退（exitCode / signalCode 都是 null），
 * Node 手里还握着它的进程句柄，这个 PID 不会被系统挪给别的进程。
 * 其他平台上 PyInstaller 的引导进程会把 SIGTERM 转给子进程，child.kill() 就够了。
 * taskkill 起不来、失败或超时都退回 child.kill()：至少引导进程要停。
 */

const path = require('path');
const { spawn } = require('child_process');

const TASKKILL_TIMEOUT_MS = 5000;

function taskkillPath(env = process.env) {
  return path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'taskkill.exe');
}

/**
 * @param {import('child_process').ChildProcess} child
 * @param {object} [opts]  测试用：换掉平台和 spawn
 * @returns {Promise<void>} 结束的尝试做完（不代表进程已经退出，那要等 child 的 'exit' / 'close'）；从不 reject
 */
function killTree(child, { platform = process.platform, spawnImpl = spawn, timeoutMs = TASKKILL_TIMEOUT_MS } = {}) {
  if (!child || child.exitCode != null || child.signalCode != null) return Promise.resolve();
  const plainKill = () => {
    try {
      child.kill();
    } catch {
      /* 已经退了 */
    }
  };
  if (platform !== 'win32' || !Number.isInteger(child.pid) || child.pid <= 0) {
    plainKill();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!ok) plainKill();
      resolve();
    };
    let killer;
    try {
      killer = spawnImpl(taskkillPath(), ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      done(false);
      return;
    }
    timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();
    killer.on('error', () => done(false));
    killer.on('exit', (code) => done(code === 0));
  });
}

module.exports = { killTree, taskkillPath };
