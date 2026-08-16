'use strict';

const path = require('path');

const ALLOWED_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.mkv']);
const MP4_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov']);

function extensionOf(name) {
  return path.extname(String(name || '').trim()).toLowerCase();
}

function validateManifestName(name) {
  if (typeof name !== 'string' || name.length < 1 || name.length > 200) {
    throw new TypeError('无效的媒体文件名');
  }
  if (path.basename(name) !== name || /[<>:"/\\|?*\x00-\x1f]/.test(name)) {
    throw new TypeError('无效的媒体文件名');
  }
  if (!ALLOWED_EXTENSIONS.has(extensionOf(name))) {
    throw new TypeError('只允许接收 MP4、M4V、MOV 或 MKV 视频');
  }
  return name;
}

function hasIsoBmffHeader(buffer) {
  const max = Math.min(buffer.length, 1024 * 1024);
  let offset = 0;
  let boxes = 0;
  while (offset + 8 <= max && boxes++ < 128) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > max) return false;
      const large = buffer.readBigUInt64BE(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      size = Number(large);
      headerSize = 16;
    }
    if (type === 'ftyp' && size >= headerSize + 4 && offset + size <= buffer.length) return true;
    if (size === 0) return false;
    if (size < headerSize || offset + size > buffer.length) return false;
    offset += size;
  }
  return false;
}

function validateMediaHeader(name, bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length < 16) return { ok: false, reason: '媒体文件头过短' };

  // PE/COFF 可执行文件即便伪装成 .mp4，也绝不能进入播放器链路。
  if (buffer[0] === 0x4d && buffer[1] === 0x5a) {
    return { ok: false, reason: '检测到 Windows 可执行文件头' };
  }

  const ext = extensionOf(name);
  if (ext === '.mkv') {
    const isEbml = buffer.readUInt32BE(0) === 0x1a45dfa3;
    return isEbml ? { ok: true, container: 'matroska' } : { ok: false, reason: '文件内容不是有效的 MKV 容器' };
  }
  if (MP4_EXTENSIONS.has(ext)) {
    return hasIsoBmffHeader(buffer)
      ? { ok: true, container: 'isobmff' }
      : { ok: false, reason: '文件内容不是有效的 MP4/MOV 容器' };
  }
  return { ok: false, reason: '不支持的媒体格式' };
}

module.exports = {
  ALLOWED_EXTENSIONS,
  extensionOf,
  validateManifestName,
  validateMediaHeader,
};
