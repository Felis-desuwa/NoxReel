'use strict';

const path = require('path');

// 接收方只收这四种。房主那边能选的格式更多（见 CONVERT_EXTENSIONS），但它们在房主本机
// 先无损封成 MKV 再进房 —— 所以这张表不跟着放宽：接收链路、安卓端和 0.7.x 的老客户端
// 看到的永远只有这四种容器。
const ALLOWED_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.mkv']);
const MP4_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov']);

// 房主可以选、但要先转成 MKV 的格式。都实测过 ffmpeg 能 -c copy 封进 MKV；
// RM/RMVB 不在里面：ffmpeg 的 Matroska 封装器不收 RealVideo，只能重编码，那就不是无损了。
const CONVERT_EXTENSIONS = new Set([
  '.webm', '.avi', '.ts', '.m2ts', '.mts', '.flv', '.f4v', '.wmv', '.asf',
  '.mpg', '.mpeg', '.vob', '.ogv', '.3gp',
]);
const SOURCE_EXTENSIONS = new Set([...ALLOWED_EXTENSIONS, ...CONVERT_EXTENSIONS]);

// 外挂字幕只收文本格式：它们会在房主本机转成 UTF-8、封进 MKV。
// 图形字幕（.sup / .idx+.sub）是位图，另说。
const SUBTITLE_EXTENSIONS = new Set(['.ass', '.ssa', '.srt', '.vtt']);

function extensionOf(name) {
  return path.extname(String(name || '').trim()).toLowerCase();
}

function checkFileName(name) {
  if (typeof name !== 'string' || name.length < 1 || name.length > 200) {
    throw new TypeError('无效的媒体文件名');
  }
  if (path.basename(name) !== name || /[<>:"/\\|?*\x00-\x1f]/.test(name)) {
    throw new TypeError('无效的媒体文件名');
  }
}

function validateManifestName(name) {
  checkFileName(name);
  if (!ALLOWED_EXTENSIONS.has(extensionOf(name))) {
    throw new TypeError('只允许接收 MP4、M4V、MOV 或 MKV 视频');
  }
  return name;
}

/** 房主选片时的文件名检查：比接收方宽，多出来的格式会先封成 MKV。 */
function validateSourceName(name) {
  checkFileName(name);
  if (!SOURCE_EXTENSIONS.has(extensionOf(name))) {
    throw new TypeError('不支持这种视频格式');
  }
  return name;
}

function validateSubtitleName(name) {
  checkFileName(name);
  if (!SUBTITLE_EXTENSIONS.has(extensionOf(name))) {
    throw new TypeError('只支持 ASS、SSA、SRT、VTT 字幕');
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
  CONVERT_EXTENSIONS,
  SOURCE_EXTENSIONS,
  SUBTITLE_EXTENSIONS,
  extensionOf,
  validateManifestName,
  validateSourceName,
  validateSubtitleName,
  validateMediaHeader,
};
