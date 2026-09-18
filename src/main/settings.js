'use strict';

/**
 * 主进程侧的极小配置。
 *
 * 这是主进程第一处持久化 —— 在此之前所有设置都在渲染进程的 localStorage 里。
 * 为什么非得再开一处：缓存根目录在 main.js 模块加载期就要用（CacheManager 要它来
 * 建 run 目录），那时候渲染进程还没启动，localStorage 根本读不到。
 *
 * 所以这里只放「渲染进程起来之前就要用」的键，其余一个都不搬 ——
 * 把九个设置分散在两个地方，只会造出两套互相打架的真相。
 *
 * 读取一律同步且吞掉所有异常：一个坏掉的 JSON 绝不能把软件卡在启动页上。
 * 任何一步出问题都退回默认值，最坏情况就是缓存又回到系统临时目录。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const FILE_NAME = 'config.json';
const VERSION = 1;

function filePath(userDataDir) {
  return path.join(userDataDir, FILE_NAME);
}

/** 同步读。模块加载期就要用，没得选。读不出来就当空配置。 */
function read(userDataDir) {
  try {
    const raw = fs.readFileSync(filePath(userDataDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

/** 写。先写临时文件再改名，避免写一半断电留下个半截 JSON。 */
async function write(userDataDir, patch) {
  const next = { ...read(userDataDir), ...patch, version: VERSION };
  const target = filePath(userDataDir);
  const temporary = `${target}.tmp-${process.pid}`;
  await fsp.mkdir(userDataDir, { recursive: true });
  await fsp.writeFile(temporary, JSON.stringify(next, null, 2), 'utf8');
  await fsp.rename(temporary, target);
  return next;
}

/**
 * 决定这次运行用哪个缓存根目录。
 *
 * 纯函数，不碰磁盘 —— 优先级本身值得单独测，而「目录存不存在」是另一件事，
 * 由调用方在 whenReady 之后去试，试不成再退回默认值。
 *
 * @returns {{root: string, source: 'env'|'config'|'default'}}
 */
function resolveCacheRoot({ env = process.env, config = {}, defaultRoot }) {
  const fromEnv = String(env.SYNCWATCH_CACHE_DIR || '').trim();
  if (fromEnv && path.isAbsolute(fromEnv)) return { root: path.resolve(fromEnv), source: 'env' };
  const fromConfig = String(config.cacheRoot || '').trim();
  if (fromConfig && path.isAbsolute(fromConfig)) return { root: path.resolve(fromConfig), source: 'config' };
  return { root: defaultRoot, source: 'default' };
}

/**
 * 历史用过的根目录，去重后返回。
 *
 * 换过缓存目录之后，旧盘上可能还躺着上次没清干净的 run 目录。不记着它们，
 * 那些几十 GB 就再也没人回收了 —— 而用户根本不知道它们在哪。
 */
function knownRoots(config, current) {
  const seen = [];
  for (const candidate of [current, ...(Array.isArray(config.knownRoots) ? config.knownRoots : [])]) {
    const value = String(candidate || '').trim();
    if (!value || !path.isAbsolute(value)) continue;
    const resolved = path.resolve(value);
    if (!seen.includes(resolved)) seen.push(resolved);
  }
  // 留最近 5 个就够了，再多只是给启动时的扫描添负担
  return seen.slice(0, 5);
}

/**
 * 播放器选择也放在主进程侧，和缓存根目录同理：拉起播放器的是主进程，
 * 而 exe 路径是一道授权（白名单之外的路径一律不许启动）。把它存在渲染进程的
 * localStorage 里，等于让页面自己保管这道授权 —— 页面被换掉、被刷新都算数。
 */
const PLAYER_IDS = ['mpv', 'pot', 'mpc'];

/** 用哪个播放器。配置文件是用户能手改的，认不出来就退回内置的 mpv。 */
function resolvePlayer(config = {}) {
  const want = String(config.player || '').trim();
  return PLAYER_IDS.includes(want) ? want : 'mpv';
}

/**
 * 用户自己指定的播放器 exe 路径。
 *
 * 这里只做形状上的规整（必须是绝对路径）。**白名单那一关不在这儿**，而在真正去启动的
 * 那一侧（discover.js 的 isAllowedExe）—— 配置文件是能手改的，它不该成为绕过白名单的入口。
 */
function playerPaths(config = {}) {
  const raw = config && typeof config.playerPaths === 'object' ? config.playerPaths : null;
  const out = {};
  if (!raw) return out;
  for (const id of PLAYER_IDS) {
    const value = String(raw[id] || '').trim();
    if (value && path.isAbsolute(value)) out[id] = path.resolve(value);
  }
  return out;
}

module.exports = {
  read,
  write,
  resolveCacheRoot,
  knownRoots,
  filePath,
  resolvePlayer,
  playerPaths,
  PLAYER_IDS,
  FILE_NAME,
  VERSION,
};
