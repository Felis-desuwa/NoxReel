'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const RUN_DIR_RE = /^run-(\d+)-[a-z0-9]+-[a-f0-9]+$/i;
const RETRY_DELAYS_MS = [0, 100, 300, 1000];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function removeWithRetry(target, delays = RETRY_DELAYS_MS) {
  let lastError = null;
  for (const waitMs of delays) {
    if (waitMs) await delay(waitMs);
    try {
      await fsp.rm(target, { recursive: true, force: true, maxRetries: 0 });
      return true;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError?.code !== 'ENOENT') return false;
  return true;
}

class CacheManager {
  constructor({ rootDir, pid = process.pid, now = Date.now, isAlive = processIsAlive } = {}) {
    if (!rootDir || !path.isAbsolute(rootDir)) throw new TypeError('缓存根目录必须是绝对路径');
    this.rootDir = path.resolve(rootDir);
    this.pid = pid;
    this.isAlive = isAlive;
    const stamp = now().toString(36);
    const token = crypto.randomBytes(6).toString('hex');
    this.runDir = path.join(this.rootDir, `run-${pid}-${stamp}-${token}`);
    this.initialized = false;
    this.sequence = 0;
  }

  async initialize() {
    if (this.initialized) return this.runDir;
    await fsp.mkdir(this.rootDir, { recursive: true });
    await this.cleanupStaleRuns();
    await fsp.mkdir(this.runDir, { recursive: true });
    this.initialized = true;
    return this.runDir;
  }

  async cleanupStaleRuns() {
    const entries = await fsp.readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory()) return;
        const match = RUN_DIR_RE.exec(entry.name);
        if (!match) return;
        const ownerPid = Number(match[1]);
        const candidate = path.join(this.rootDir, entry.name);
        if (candidate === this.runDir) return;
        // 与当前 PID 相同但不是当前运行目录，只可能是 PID 被系统复用后的旧残留。
        if (ownerPid !== this.pid && this.isAlive(ownerPid)) return;
        await removeWithRetry(candidate);
      })
    );
  }

  async createOwnedDir(kind = 'media') {
    await this.initialize();
    const safeKind = String(kind).replace(/[^a-z0-9_-]/gi, '-').slice(0, 32) || 'media';
    const token = crypto.randomBytes(5).toString('hex');
    const dir = path.join(this.runDir, `${safeKind}-${(this.sequence++).toString(36)}-${token}`);
    await fsp.mkdir(dir, { recursive: true });
    return dir;
  }

  owns(target) {
    return Boolean(target && isInside(this.runDir, target));
  }

  async removeOwned(target) {
    if (!this.owns(target)) throw new Error('拒绝删除缓存根目录之外的路径');
    return removeWithRetry(target);
  }

  async cleanupRun() {
    if (!this.initialized) return true;
    const removed = await removeWithRetry(this.runDir);
    if (removed) this.initialized = false;
    return removed;
  }
}

async function cleanupLegacySidecars(legacyDir) {
  if (!legacyDir || !path.isAbsolute(legacyDir)) return;
  const stack = [legacyDir];
  while (stack.length) {
    const dir = stack.pop();
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.swpart')) await fsp.unlink(entryPath).catch(() => {});
    }
  }
}

module.exports = {
  CacheManager,
  cleanupLegacySidecars,
  isInside,
  processIsAlive,
  removeWithRetry,
  RUN_DIR_RE,
};
