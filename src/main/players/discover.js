'use strict';

/**
 * 外部播放器的可执行文件探测。
 *
 * 和 findBin.js 的差别是有意的：findBin 为「用户自己装的命令行工具」设计，会查 PATH。
 * 这两个播放器都是 GUI 程序，从来不进 PATH，真正靠谱的线索只有两条 ——
 * 安装器写下的注册表值，和各家固定的安装目录。
 *
 * 白名单是这一层的安全边界：探测出来的路径、以及将来用户自己在对话框里挑的路径，
 * 都必须落在 ALLOWED_EXES 里。渲染进程永远不能直接把一个 exe 路径递到主进程来启动。
 */

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

/** 优先 Mini64：PotPlayer64.exe 会再拉起 Mini 版然后自己退出，PID 和窗口就对不上了。 */
const POT_EXES = ['PotPlayerMini64.exe', 'PotPlayerMini.exe', 'PotPlayer64.exe'];
const MPC_EXES = ['mpc-be64.exe', 'mpc-be.exe'];
const ALLOWED_EXES = new Set([...POT_EXES, ...MPC_EXES].map((name) => name.toLowerCase()));

/** 注册表线索。PotPlayer 记的是 exe 全路径，MPC-BE 的安装器把 ExePath 写在 HKLM。 */
const REGISTRY_HINTS = [
  { id: 'pot', key: 'HKCU\\Software\\DAUM\\PotPlayer64', value: 'ProgramPath' },
  { id: 'pot', key: 'HKCU\\Software\\DAUM\\PotPlayerMini64', value: 'ProgramPath' },
  { id: 'pot', key: 'HKCU\\Software\\DAUM\\PotPlayer', value: 'ProgramPath' },
  { id: 'mpc', key: 'HKCU\\Software\\MPC-BE', value: 'ExePath' },
  { id: 'mpc', key: 'HKLM\\SOFTWARE\\MPC-BE', value: 'ExePath' },
];

function programFiles(env) {
  const list = [env['ProgramFiles'], env['ProgramFiles(x86)'], env['ProgramW6432']];
  return list.filter((dir, i) => dir && list.indexOf(dir) === i);
}

/** 各家默认安装目录。注册表被清掉（绿色版、手动搬目录）时的兜底。 */
function fixedCandidates(env = process.env) {
  const out = [];
  for (const base of programFiles(env)) {
    out.push(path.join(base, 'DAUM', 'PotPlayer', 'PotPlayerMini64.exe'));
    out.push(path.join(base, 'DAUM', 'PotPlayer', 'PotPlayerMini.exe'));
    out.push(path.join(base, 'MPC-BE', 'mpc-be64.exe'));
    out.push(path.join(base, 'MPC-BE x64', 'mpc-be64.exe'));
    out.push(path.join(base, 'MPC-BE', 'mpc-be.exe'));
  }
  const local = env['LOCALAPPDATA'];
  if (local) {
    out.push(path.join(local, 'Programs', 'MPC-BE x64', 'mpc-be64.exe'));
    out.push(path.join(local, 'Programs', 'MPC-BE', 'mpc-be.exe'));
  }
  return out.filter((p, i) => out.indexOf(p) === i);
}

function exeName(target) {
  return path.basename(String(target || '')).toLowerCase();
}

/** 路径是不是白名单里的播放器。用户自选路径也要过这一关。 */
function isAllowedExe(target) {
  return ALLOWED_EXES.has(exeName(target));
}

/** 这个路径属于哪个播放器。认不出来返回 null。 */
function kindOfExe(target) {
  const name = exeName(target);
  if (POT_EXES.some((exe) => exe.toLowerCase() === name)) return 'pot';
  if (MPC_EXES.some((exe) => exe.toLowerCase() === name)) return 'mpc';
  return null;
}

/**
 * 解析 `reg query KEY /v NAME` 的输出。格式是：
 *   HKEY_CURRENT_USER\Software\DAUM\PotPlayer64
 *       ProgramPath    REG_SZ    C:\Program Files\DAUM\PotPlayer\PotPlayerMini64.exe
 * 值里可能带空格，所以只在类型标记之后切一刀，剩下的整段都是值。
 */
function parseRegQuery(stdout, valueName) {
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.toLowerCase().startsWith(String(valueName).toLowerCase())) continue;
    const match = trimmed.match(/\s(REG_[A-Z_]+)\s+(.*)$/);
    if (!match) continue;
    const value = match[2].trim();
    if (value) return value;
  }
  return null;
}

/**
 * 注册表值 → 候选 exe 路径。安装器写的可能是 exe 全路径，也可能是安装目录，
 * 两种都见过，所以目录形式再逐个拼上白名单文件名。
 *
 * 白名单只说明「这是个播放器」，还得说明是**哪个**播放器：`exes` 是这一条线索
 * 所属播放器的文件名表，注册表值指到别人家的 exe 一律不认。
 * `HKCU\Software\DAUM\PotPlayer64\ProgramPath` 指向 mpc-be64.exe（装过又卸过、
 * 或者有人写进去的）时，只查白名单就会让 PotPlayer 适配器拿着 `/new /seek=`
 * 去启动 MPC-BE，然后一路卡到 20 秒启动超时。
 */
function programPathCandidates(value, exes) {
  const raw = String(value || '').trim().replace(/^"|"$/g, '');
  if (!raw) return [];
  const names = (exes || []).map((exe) => String(exe).toLowerCase());
  // 是个 exe：文件名必须正好是这个播放器的，别人家的和不在白名单里的都不碰
  if (/\.exe$/i.test(raw)) return names.includes(exeName(raw)) ? [raw] : [];
  return exes.map((exe) => path.join(raw, exe));
}

function existsSync(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** 默认的 reg 执行器。查不到键时 reg 返回非 0，这里一律当作「没这条线索」。 */
function defaultRegQuery(key, value) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', value], { windowsHide: true, timeout: 4000 }, (error, stdout) => {
      resolve(error ? '' : String(stdout || ''));
    });
  });
}

const PLAYER_META = {
  pot: { id: 'pot', name: 'PotPlayer', exes: POT_EXES },
  mpc: { id: 'mpc', name: 'MPC-BE', exes: MPC_EXES },
};

/**
 * 找出本机可用的外部播放器。
 *
 * @param {object} [opts]
 * @param {(key: string, value: string) => Promise<string>} [opts.regQuery] reg query 的替身
 * @param {(p: string) => boolean} [opts.exists] 文件存在性判断的替身
 * @param {Record<string,string>} [opts.env]
 * @param {Record<string,string>} [opts.overrides] 用户自己指定的路径（settings 里存的）
 * @returns {Promise<Record<string, {id, name, path: string|null, source: string}>>}
 */
async function discoverPlayers({ regQuery = defaultRegQuery, exists = existsSync, env = process.env, overrides = {} } = {}) {
  const found = {};
  for (const id of Object.keys(PLAYER_META)) {
    found[id] = { ...PLAYER_META[id], path: null, source: 'none' };
    delete found[id].exes;
  }

  // 1. 用户自己指定的优先，但同样要过白名单
  for (const [id, value] of Object.entries(overrides)) {
    if (!found[id] || !value) continue;
    if (!isAllowedExe(value) || kindOfExe(value) !== id) continue;
    if (!exists(value)) continue;
    found[id].path = value;
    found[id].source = 'user';
  }

  // 2. 注册表
  for (const hint of REGISTRY_HINTS) {
    const slot = found[hint.id];
    if (!slot || slot.path) continue;
    let stdout = '';
    try {
      stdout = await regQuery(hint.key, hint.value);
    } catch {
      stdout = '';
    }
    const value = parseRegQuery(stdout, hint.value);
    if (!value) continue;
    for (const candidate of programPathCandidates(value, PLAYER_META[hint.id].exes)) {
      if (!exists(candidate)) continue;
      slot.path = candidate;
      slot.source = 'registry';
      break;
    }
  }

  // 3. 固定安装目录
  for (const candidate of fixedCandidates(env)) {
    const id = kindOfExe(candidate);
    if (!id || !found[id] || found[id].path) continue;
    if (!exists(candidate)) continue;
    found[id].path = candidate;
    found[id].source = 'default';
  }

  return found;
}

module.exports = {
  ALLOWED_EXES,
  MPC_EXES,
  POT_EXES,
  discoverPlayers,
  fixedCandidates,
  isAllowedExe,
  kindOfExe,
  parseRegQuery,
  programPathCandidates,
};
