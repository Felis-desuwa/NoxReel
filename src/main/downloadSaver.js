'use strict';

/**
 * 边下边播：把看的片另存一份到下载文件夹。
 *
 * 和缓存是两回事 —— 存下来的是用户自己的文件，缓存清理不碰，登记表里也不记。
 *  - 同一个盘上用硬链接：不多占空间，缓存那份被清掉也不影响这份；跨盘（EXDEV）、
 *    文件系统不支持硬链接时才复制。
 *  - 绝不覆盖下载文件夹里已有的文件：同名就另起「片名 (2).mkv」。
 *  - 这次运行里存过的（按 key：P2P 是 fileId，在线视频是链接）不再存第二份；
 *    用户把存下来的那份删了、挪走了，才重新存。
 */

const { constants } = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { uniquePath } = require('./linkCache');

class DownloadSaver {
  /**
   * @param {object} deps
   * @param {() => string} deps.dir  当前的下载位置（设置里随时能换）
   * @param {Function} [deps.link]  测试注入：fs.promises.link
   * @param {Function} [deps.copy]  测试注入：fs.promises.copyFile
   */
  constructor({ dir, link = fsp.link, copy = fsp.copyFile }) {
    this.dir = dir;
    this.link = link;
    this.copy = copy;
    this.saved = new Map(); // key -> 下载文件夹里的路径
  }

  /** 这次运行里存过、而且那份还在的，返回它的路径。 */
  async existing(key) {
    const saved = this.saved.get(key);
    if (!saved) return null;
    try {
      await fsp.access(saved);
      return saved;
    } catch {
      this.saved.delete(key);
      return null;
    }
  }

  /** 别处下好的（在线视频的后台下载）记一笔，之后同一个链接不再另下。 */
  remember(key, filePath) {
    if (key && filePath) this.saved.set(key, filePath);
  }

  /**
   * 事后扫出威胁（可信房间里没扫完就存了，后来点「重新扫描」扫出了东西）：这一份也删掉。
   * 只删这次运行里我们自己放进去的那个路径。
   */
  async discard(key) {
    const saved = this.saved.get(key);
    if (!saved) return false;
    this.saved.delete(key);
    await fsp.rm(saved, { force: true });
    return true;
  }

  /**
   * 放一份 source 到下载文件夹。
   * @returns {Promise<{path: string, fresh: boolean}>} fresh=false 表示早就存过了
   */
  async save(key, source, name = path.basename(source)) {
    const existing = await this.existing(key);
    if (existing) return { path: existing, fresh: false };
    const dir = this.dir();
    await fsp.mkdir(dir, { recursive: true });
    const target = await uniquePath(dir, path.basename(name));
    try {
      await this.link(source, target);
    } catch {
      // COPYFILE_EXCL：uniquePath 和真正写入之间有人抢先建了同名文件，宁可失败也不覆盖
      await this.copy(source, target, constants.COPYFILE_EXCL);
    }
    this.saved.set(key, target);
    return { path: target, fresh: true };
  }
}

module.exports = { DownloadSaver };
