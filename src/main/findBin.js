'use strict';

/**
 * 找外部可执行程序（mpv / ffmpeg / ffprobe）。
 *
 * 为什么不能只查 PATH：Windows 上 PATH 是进程启动时继承的快照。winget 装完程序
 * 会更新用户 PATH，但已经开着的进程（包括从旧终端启动的本软件）看到的还是旧值 ——
 * 用户「明明装了」却被告知「没找到」，这是最常见的一类误报。
 *
 * 所以除了 PATH，还要：
 *  1. 查各家包管理器的固定落点（winget/scoop/choco 各装各的，且多数不进 PATH）
 *  2. 扫一遍 winget 的 Packages 目录（覆盖「刚装完还没重启」的情况）
 *  3. 认环境变量覆盖（用户手动装到犄角旮旯时的兜底）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const isWin = process.platform === 'win32';
const exeName = (name) => (isWin ? `${name}.exe` : name);

function exists(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function fromPath(name) {
  const exe = exeName(name);
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir.replace(/^"|"$/g, ''), exe);
    if (exists(p)) return p;
  }
  return null;
}

/**
 * winget 把程序解到 %LOCALAPPDATA%\Microsoft\WinGet\Packages\<包名>\<版本目录>\...\bin\
 * 层级不固定，所以限定深度扫一遍。只在别处都找不到时才走这里。
 */
function fromWingetPackages(name) {
  if (!isWin) return null;
  const root = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
  if (!exists(path.join(root, '.')) && !fs.existsSync(root)) return null;

  const exe = exeName(name);
  const stack = [{ dir: root, depth: 0 }];

  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > 4) continue;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name.toLowerCase() === exe.toLowerCase()) return full;
      if (e.isDirectory()) stack.push({ dir: full, depth: depth + 1 });
    }
  }
  return null;
}

function defaultCandidates(name) {
  const exe = exeName(name);
  const home = os.homedir();

  if (!isWin) {
    return [`/usr/bin/${exe}`, `/usr/local/bin/${exe}`, `/opt/homebrew/bin/${exe}`];
  }

  return [
    path.join(home, 'scoop', 'shims', exe),
    path.join(home, 'scoop', 'apps', name, 'current', exe),
    `C:\\ProgramData\\chocolatey\\bin\\${exe}`,
    path.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', exe),
  ];
}

/**
 * @param {string} name 程序名，不带扩展名（'mpv' / 'ffmpeg'）
 * @param {{envVar?: string, candidates?: string[]}} opts
 *   envVar     用户指定路径的环境变量名，优先级最高
 *   candidates 该程序特有的安装位置，插在通用候选之前
 * @returns {string|null} 可执行文件绝对路径
 */
function findBin(name, { envVar, candidates = [] } = {}) {
  if (envVar && process.env[envVar] && exists(process.env[envVar])) {
    return process.env[envVar];
  }

  const fromEnvPath = fromPath(name);
  if (fromEnvPath) return fromEnvPath;

  for (const p of [...candidates, ...defaultCandidates(name)]) {
    if (exists(p)) return p;
  }

  // 最后才扫 winget 目录 —— 有 IO 开销，前面命中就不用走到这
  return fromWingetPackages(name);
}

module.exports = { findBin, exists };
