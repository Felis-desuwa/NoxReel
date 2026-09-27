'use strict';

/**
 * 收下来的片子登记在哪儿：缓存清理方式、复用、手动清理都靠它。
 *
 * 两种条目：
 *  - file：P2P 收完的片，按 fileId 认。复用前拿房主发来的清单逐片核对哈希（fileStore.openLeech 做）；
 *    fileId 本来就是由全部分片哈希算出来的，所以这里不用另存清单。
 *  - link：手动缓存的在线视频，按链接地址认。
 *
 * 两种存法：
 *  - 持久（persistent）：手动清理模式下收的片和手动缓存的在线视频。文件在长期缓存文件夹里
 *    （不在系统临时目录，Windows 的磁盘清理碰不到），登记表落在用户数据目录（library.json），跨重启复用。
 *    登记表记的是绝对路径，换了缓存位置，以前存的照样认得、照样能在手动清理里删。
 *  - 临时（temp）：自动清理模式下收的片和手动缓存的在线视频。文件在本次运行的临时缓存里，登记只在内存；
 *    关软件时整个运行目录被清掉，登记也跟着没了。磁盘不够时先删这些里最久没用的。
 *
 * 「边下边播」另存到下载文件夹的不归这里管：那是用户自己的文件，缓存清理不碰。
 *
 * 删除只删登记表里记着、而且大小还对得上的文件（大小变了说明已经不是我们存的那个），不凭名字删。
 *
 * 登记只在「确认文件真没了」时才摘（见 locateFile）：缓存放在移动硬盘上、这次开机没插，
 * 整个盘访问不了的时候判断不了文件在不在，登记留着、标成「暂不可用」。摘掉的话盘插回来，
 * 这些片既不复用、也不在手动清理里出现，只能去资源管理器里自己找出来删。
 */

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const INDEX_FILE = 'library.json';
const VERSION = 1;
// 登记表上限：手改的配置文件塞几十万条进来也不至于拖垮启动
const MAX_ENTRIES = 5000;
const ID_RE = /^[0-9a-f]{16}$/;
const FILE_ID_RE = /^[0-9a-f]{16,128}$/;

const pathKey = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const newId = () => crypto.randomBytes(8).toString('hex');
const now = () => Date.now();

function cleanString(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

async function isDirectory(p) {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 登记的文件现在怎么样：
 *  - ok：在，带着 stat；
 *  - gone：确实没了 —— 文件本身 ENOENT，而它所在的目录还在（Windows 上目录没了但那个盘、那个网络共享还在，
 *    说明是用户把文件夹删了，也算）；
 *  - unavailable：判断不了 —— 整个盘或共享访问不了（移动硬盘没插、网盘断了）、没权限、读出错。
 * POSIX 上根目录永远在，挂载点没挂上时和「文件夹被删了」看不出区别，目录不在就一律当 unavailable。
 */
async function locateFile(filePath) {
  try {
    return { status: 'ok', stat: await fsp.stat(filePath) };
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return { status: 'unavailable' };
  }
  if (await isDirectory(path.dirname(filePath))) return { status: 'gone' };
  if (process.platform !== 'win32') return { status: 'unavailable' };
  const root = path.parse(path.resolve(filePath)).root;
  return { status: root && (await isDirectory(root)) ? 'gone' : 'unavailable' };
}

/**
 * 这个文件删掉能腾出多少空间。还有别的硬链接指着它（另存到了下载文件夹）就是 0 —— 删了这一个名字，
 * 数据还在。能读出占用块数就按块数算；读出 0 块却有内容时按大小算：Windows 上 libuv 对稀疏文件
 * （接收文件都标了稀疏，见 fileStore.markSparse）报的块数恒为 0（实测），而临时条目都是收完的整部片。
 */
async function reclaimableBytes(filePath) {
  try {
    const st = await fsp.stat(filePath);
    if (!st.isFile() || st.nlink > 1) return 0;
    return typeof st.blocks === 'number' && st.blocks > 0 ? st.blocks * 512 : st.size;
  } catch {
    return 0;
  }
}

/** 落盘的登记表是用户能手改的：一条条过一遍，认不出来的扔掉。 */
function sanitizeEntries(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const e of raw.slice(0, MAX_ENTRIES)) {
    if (!e || typeof e !== 'object') continue;
    if (!ID_RE.test(e.id) || seen.has(e.id)) continue;
    if (e.kind !== 'file' && e.kind !== 'link') continue;
    if (typeof e.path !== 'string' || !path.isAbsolute(e.path)) continue;
    if (!Number.isSafeInteger(e.size) || e.size < 0) continue;
    const entry = {
      id: e.id,
      kind: e.kind,
      name: cleanString(e.name, 300) || path.basename(e.path),
      path: path.resolve(e.path),
      size: e.size,
      savedAt: Number.isFinite(e.savedAt) ? e.savedAt : 0,
      lastUsedAt: Number.isFinite(e.lastUsedAt) ? e.lastUsedAt : 0,
    };
    if (e.kind === 'file') {
      if (typeof e.fileId !== 'string' || !FILE_ID_RE.test(e.fileId)) continue;
      entry.fileId = e.fileId;
    } else {
      if (typeof e.url !== 'string' || !/^https?:\/\//i.test(e.url)) continue;
      entry.url = e.url.slice(0, 8192);
    }
    seen.add(e.id);
    out.push(entry);
  }
  return out;
}

class MediaLibrary {
  /**
   * @param {{dataDir: string, removeOwned?: (dir: string) => Promise<boolean>, locate?: Function}} opts
   *   removeOwned：临时条目的整个目录交还缓存管理器去删（它知道哪些目录是本软件的），删不掉返回 false
   *   locate：查文件在不在（测试里换成桩函数，模拟移动硬盘没插）
   */
  constructor({ dataDir, removeOwned = null, locate = locateFile } = {}) {
    if (!dataDir || !path.isAbsolute(dataDir)) throw new TypeError('登记表目录必须是绝对路径');
    this.dataDir = dataDir;
    this.removeOwned = removeOwned;
    this.locate = locate;
    this.persistent = [];
    this.temp = new Map();
    this.writing = Promise.resolve();
  }

  get indexPath() {
    return path.join(this.dataDir, INDEX_FILE);
  }

  /** 读登记表。读不出来就当空的：坏掉的 JSON 不能把软件卡住。 */
  async load() {
    try {
      const raw = JSON.parse(await fsp.readFile(this.indexPath, 'utf8'));
      this.persistent = sanitizeEntries(raw?.entries);
    } catch {
      this.persistent = [];
    }
    return this;
  }

  /** 写登记表：一个接一个写，先写临时文件再改名，写一半断电也不会留下半截 JSON。 */
  _save() {
    const data = JSON.stringify({ version: VERSION, entries: this.persistent }, null, 2);
    this.writing = this.writing
      .then(async () => {
        await fsp.mkdir(this.dataDir, { recursive: true });
        const tmp = `${this.indexPath}.tmp-${process.pid}`;
        await fsp.writeFile(tmp, data, 'utf8');
        await fsp.rename(tmp, this.indexPath);
      })
      .catch(() => {});
    return this.writing;
  }

  /* ------------------------------ 查 ------------------------------ */

  /** 这部片（fileId）有没有收完的副本。临时的优先（就在本次运行的缓存里，最近用过）。正在删的不算。 */
  findFile(fileId) {
    for (const entry of this.temp.values()) {
      if (entry.fileId === fileId && !entry.removing) return { entry, persistent: false };
    }
    const entry = this.persistent.find((e) => e.kind === 'file' && e.fileId === fileId);
    return entry ? { entry, persistent: true } : null;
  }

  /** 这个链接有没有手动缓存好的副本（临时的优先）。正在删的不算。 */
  findLink(url) {
    for (const entry of this.temp.values()) {
      if (entry.kind === 'link' && entry.url === url && !entry.removing) return entry;
    }
    return this.persistent.find((e) => e.kind === 'link' && e.url === url) || null;
  }

  /** 登记的这个文件现在在不在：{status: 'ok'|'gone'|'unavailable', stat?}，见 locateFile。 */
  probe(filePath) {
    return this.locate(filePath);
  }

  /**
   * 给手动清理列的清单。确认没了的持久条目顺手摘掉；整个盘访问不了的留着，标 available: false。
   */
  async list() {
    const gone = new Set();
    const unavailable = new Set();
    for (const entry of [...this.persistent]) {
      const { status } = await this.probe(entry.path);
      if (status === 'gone') gone.add(entry);
      else if (status !== 'ok') unavailable.add(entry);
    }
    // 查的这段时间里可能又登记了新的：只摘查过、确认没了的那几条
    if (gone.size) {
      this.persistent = this.persistent.filter((e) => !gone.has(e));
      await this._save();
    }
    const view = (e, persistent) => ({
      id: e.id,
      kind: e.kind,
      name: e.name,
      size: e.size,
      path: e.path,
      url: e.url || null,
      savedAt: e.savedAt,
      lastUsedAt: e.lastUsedAt,
      persistent,
      available: !unavailable.has(e),
    });
    return [...this.persistent.map((e) => view(e, true)), ...[...this.temp.values()].map((e) => view(e, false))];
  }

  /* ------------------------------ 记 ------------------------------ */

  /** 自动模式收完的片：只记在内存里，文件跟着运行目录走。 */
  addTempFile({ manifest, filePath, ownedDir }) {
    for (const [id, e] of this.temp) if (e.fileId === manifest.fileId) this.temp.delete(id);
    const id = newId();
    this.temp.set(id, {
      id,
      kind: 'file',
      name: manifest.name,
      path: filePath,
      size: manifest.size,
      fileId: manifest.fileId,
      ownedDir,
      savedAt: now(),
      lastUsedAt: now(),
    });
    return id;
  }

  /** 自动清理模式下手动缓存好的在线视频：只记在内存里，文件跟着运行目录走。 */
  addTempLink({ url, title, filePath, size, ownedDir }) {
    for (const [id, e] of this.temp) if (e.kind === 'link' && e.url === url) this.temp.delete(id);
    const id = newId();
    this.temp.set(id, {
      id,
      kind: 'link',
      name: cleanString(title, 300) || path.basename(filePath),
      path: filePath,
      size,
      url,
      ownedDir,
      savedAt: now(),
      lastUsedAt: now(),
    });
    return id;
  }

  /** 临时条目被一个会话接过去了：用完之前别让磁盘不够时的清理把它删掉。 */
  takeTemp(id) {
    const entry = this.temp.get(id);
    this.temp.delete(id);
    return entry || null;
  }

  /** 手动模式收完的片：登记下来，下次同一部片再来时直接复用（复用前逐片核对）。 */
  async addFile({ manifest, filePath }) {
    const key = pathKey(filePath);
    let entry = this.persistent.find((e) => e.kind === 'file' && pathKey(e.path) === key);
    if (entry) {
      entry.fileId = manifest.fileId;
      entry.size = manifest.size;
      entry.lastUsedAt = now();
    } else {
      // 同一部片换了位置又存了一份：旧登记指向的那份照样留着（手动清理里能看到、能删）
      entry = {
        id: newId(),
        kind: 'file',
        name: manifest.name,
        path: path.resolve(filePath),
        size: manifest.size,
        fileId: manifest.fileId,
        savedAt: now(),
        lastUsedAt: now(),
      };
      this.persistent.push(entry);
    }
    await this._save();
    return entry.id;
  }

  /** 手动缓存好的在线视频。同一个链接再缓存一次，就指向新的那份。 */
  async addLink({ url, title, filePath, size }) {
    const old = this.persistent.find((e) => e.kind === 'link' && e.url === url);
    const entry = {
      id: newId(),
      kind: 'link',
      name: cleanString(title, 300) || path.basename(filePath),
      path: path.resolve(filePath),
      size,
      url,
      savedAt: now(),
      lastUsedAt: now(),
    };
    if (old) this.persistent = this.persistent.filter((e) => e !== old);
    this.persistent.push(entry);
    await this._save();
    return entry.id;
  }

  async touch(id) {
    const entry = this.persistent.find((e) => e.id === id);
    if (entry) {
      entry.lastUsedAt = now();
      await this._save();
    } else if (this.temp.has(id)) {
      this.temp.get(id).lastUsedAt = now();
    }
  }

  /* ------------------------------ 删 ------------------------------ */

  /**
   * 删一条：文件连同登记一起。持久条目只在大小还对得上时才删文件
   * （大小变了说明那个位置已经换成别的东西了，只摘登记，不碰文件）。
   * 两种条目都是先删文件、删掉了才摘登记：删不掉（被播放器占着）、盘不在，就原样留着并抛出来，
   * 不能报「删掉了」却只丢了登记 —— 文件还占着空间，之后也不再复用。
   * @returns {Promise<boolean>} 登记里有这一条
   */
  async remove(id) {
    const temp = this.temp.get(id);
    if (temp) {
      if (temp.ownedDir && this.removeOwned) {
        temp.removing = true;
        let removed = false;
        try {
          removed = (await this.removeOwned(temp.ownedDir)) !== false;
        } finally {
          temp.removing = false;
        }
        if (!removed) throw new Error('删不掉（可能被别的程序占着）');
      }
      if (this.temp.get(id) === temp) this.temp.delete(id);
      return true;
    }
    const entry = this.persistent.find((e) => e.id === id);
    if (!entry) return false;
    const { status, stat } = await this.probe(entry.path);
    // 盘不在：文件在不在都说不准，登记留着，等盘插回来再删
    if (status === 'unavailable') throw new Error('文件所在的盘现在访问不了');
    // 先删文件再摘登记：删不掉（被播放器占着）就原样留着，报给调用方
    if (status === 'ok' && stat.isFile() && stat.size === entry.size) await fsp.unlink(entry.path);
    this.persistent = this.persistent.filter((e) => e !== entry);
    await this._save();
    return true;
  }

  /** 按路径摘掉持久登记（文件已经被会话自己删了、或者内容已经不对了）。 */
  async forgetPath(filePath) {
    const key = pathKey(filePath);
    if (!this.persistent.some((e) => pathKey(e.path) === key)) return;
    this.persistent = this.persistent.filter((e) => pathKey(e.path) !== key);
    await this._save();
  }

  /** 临时条目全删掉最多能腾出多少空间（硬链接到下载文件夹的不算，删了也腾不出来）。 */
  async tempReclaimableBytes() {
    let total = 0;
    for (const entry of [...this.temp.values()]) if (!entry.removing) total += await reclaimableBytes(entry.path);
    return total;
  }

  /**
   * 磁盘不够时腾地方（只在自动模式下用）：删一条临时条目里最久没用的。
   * 临时条目是自动模式下这次运行里收完的片、手动缓存的在线视频；持久的（手动模式存的）一个都不碰。
   * 删了也腾不出地方的（硬链接到下载文件夹的）跳过；删不掉的（被播放器占着）登记留着，换下一条。
   * @returns {Promise<boolean>} 真删掉了一条（没有能删的时是 false）
   */
  async evictOldestTemp() {
    const oldestFirst = [...this.temp.values()].filter((e) => !e.removing).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const entry of oldestFirst) {
      if (!this.temp.has(entry.id) || (await reclaimableBytes(entry.path)) <= 0) continue;
      try {
        if (await this.remove(entry.id)) return true;
      } catch {
        /* 删不掉：换下一条 */
      }
    }
    return false;
  }

  /** 缓存根目录换了：旧运行目录里的临时条目不再归这里管（下次启动按残留回收）。 */
  dropTemp() {
    this.temp.clear();
  }
}

module.exports = { MediaLibrary, sanitizeEntries, locateFile, reclaimableBytes, INDEX_FILE, MAX_ENTRIES };
