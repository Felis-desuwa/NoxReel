'use strict';

// 两层的假程序，模拟 PyInstaller 单文件包（yt-dlp.exe）：引导进程再起一个继承 stdio 的干活子进程，
// 引导进程被 TerminateProcess 时子进程不跟着死、还攥着管道。
//  - 子进程用 detached 起：Node 自己起的子进程会被 libuv 放进「句柄一关就全杀」的任务对象，
//    引导进程一死子进程就跟着死，那就测不出孤儿了（PyInstaller 的引导进程没有这层）。
//  - POSIX 上 PyInstaller 的引导进程会把 SIGTERM 转给子进程，这里照做。
//  - 子进程一起来先报 `WORKER <pid>`，其余行为由 workerSource 决定（拿得到引导进程的命令行参数）。
const fsp = require('node:fs/promises');
const path = require('node:path');

async function writeTwoLayer(dir, workerSource) {
  const worker = path.join(dir, 'worker.js');
  const parent = path.join(dir, 'parent.js');
  await fsp.writeFile(worker, ["process.stdout.write(`WORKER ${process.pid}\\n`);", workerSource, ''].join('\n'));
  await fsp.writeFile(
    parent,
    [
      "const { spawn } = require('child_process');",
      `const worker = spawn(process.execPath, [${JSON.stringify(worker)}, ...process.argv.slice(2)], { stdio: 'inherit', detached: true });`,
      "process.on('SIGTERM', () => { worker.kill('SIGTERM'); process.exit(143); });",
      "worker.on('exit', (code) => process.exit(code ?? 1));",
      '',
    ].join('\n')
  );
  return parent;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 从子进程的 stdout 里等 `WORKER <pid>`。 */
function workerPidOf(child) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (d) => {
      buf += d;
      const m = /WORKER (\d+)/.exec(buf);
      if (!m) return;
      child.stdout.off('data', onData);
      resolve(Number(m[1]));
    };
    child.stdout.on('data', onData);
    child.on('error', reject);
  });
}

module.exports = { writeTwoLayer, alive, workerPidOf };
