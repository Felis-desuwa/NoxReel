'use strict';

/**
 * 文件系统报错换成一句人话，给界面上看得到的地方用（缓存位置用不了、启动时缓存目录建不出来）。
 *
 * Node 的原文是「ENOENT: no such file or directory, mkdir '\\?'」这种：盘符不在的时候 Windows 上
 * 连路径都会被写成 '\\?'，谁也看不出是哪儿出了问题。where 是出错的那个位置（知道的话），用来分清
 * 「整个盘不在」和「盘在、文件夹没了」—— 移动硬盘没插、网络盘没连上是最常见的一种，得直接说出来。
 * 认不出的错误原样返回 message。
 */

const fsp = require('fs/promises');
const path = require('path');

async function describeFsError(error, where = '') {
  const code = typeof error?.code === 'string' ? error.code : '';
  switch (code) {
    case 'ENOENT':
    case 'ENOTDIR': {
      const drive = where ? await missingDrive(where) : '';
      if (drive) return `所在的盘 ${drive} 不在，可能是移动硬盘没插、网络盘没连上或者盘符变了`;
      return code === 'ENOENT' ? '找不到这个位置，可能已被移走或删掉' : '路径里有一段是文件、不是文件夹';
    }
    case 'EACCES':
    case 'EPERM':
      return '没有权限写入这个位置';
    case 'EEXIST':
      return '要建文件夹的地方已经有一个同名文件';
    case 'EROFS':
      return '这个盘是只读的，写不进去';
    case 'EBUSY':
      return '这个位置正被别的程序占用';
    case 'EIO':
      return '读写这个盘时出错，盘可能出了问题或者刚被拔掉';
    case 'ENAMETOOLONG':
      return '路径太长了';
    default:
      return String(error?.message || error || '');
  }
}

/** where 所在的盘（Q:、\\server\share）不在时返回它的名字；在，或者分不清的时候返回空串。 */
async function missingDrive(where) {
  let root = '';
  try {
    root = path.parse(path.resolve(String(where))).root;
  } catch {
    return '';
  }
  // 类 Unix 系统的根是 /，永远在
  if (!root || root === '/' || root === path.sep) return '';
  try {
    await fsp.stat(root);
    return '';
  } catch (error) {
    // 根目录都没权限看：盘是在的
    if (error?.code === 'EACCES' || error?.code === 'EPERM') return '';
    return root.replace(/[\\/]+$/, '');
  }
}

module.exports = { describeFsError };
