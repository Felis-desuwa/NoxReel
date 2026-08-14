'use strict';

/**
 * 媒体兼容性检测与转封装。
 *
 * 规格：默认只做 remux（无损、快），不默认全量转码。
 *
 * 对「边下边播」来说最要命的兼容性问题是 MP4 的 moov 原子位置：
 * moov 是索引（时间戳→字节偏移的映射表），播放器不读到它就没法解码任何一帧。
 * 大部分编码器默认把 moov 写在文件末尾（因为要全部编完才知道索引），
 * 结果就是：顺序下载到 99% 都放不了，必须等最后一片。
 * faststart 就是把 moov 挪到文件头，代价只是重写一遍容器，不碰编码数据。
 *
 * MKV 天生就是流式容器（Cluster 自带时间戳），没这个问题。
 */

const { spawn } = require('child_process');
const fsp = require('fs/promises');
const path = require('path');
const { findBin } = require('./findBin');

// .mov 和 .mp4 是同一个容器格式（都是 ISOBMFF），box 结构完全一致 ——
// 同一个解析器不加改动就能读两者，ffprobe 也把它们报成同一个 demuxer。
// 所以按 MP4 的规则一视同仁：查 moov 位置，在末尾就转封装。
const ISOBMFF_EXT = new Set(['.mp4', '.mov', '.m4v']);
const SUPPORTED_EXT = new Set([...ISOBMFF_EXT, '.mkv']);

const FFMPEG_CANDIDATES =
  process.platform === 'win32'
    ? ['C:\\ffmpeg\\bin\\', 'C:\\Program Files\\ffmpeg\\bin\\']
    : [];

const findTool = (name) =>
  findBin(name, {
    envVar: `SYNCWATCH_${name.toUpperCase()}_PATH`,
    candidates: FFMPEG_CANDIDATES.map((d) => d + name + (process.platform === 'win32' ? '.exe' : '')),
  });

const findFfmpeg = () => findTool('ffmpeg');
const findFfprobe = () => findTool('ffprobe');

function run(bin, args, { onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => {
      const s = d.toString();
      err += s;
      if (err.length > 65536) err = err.slice(-32768);
      if (onStderr) onStderr(s);
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(`${path.basename(bin)} 退出码 ${code}：${err.slice(-600)}`));
    });
  });
}

/**
 * 顺序扫描 MP4 顶层 box，看 moov 和 mdat 谁先出现。
 * 纯 Node 实现，不依赖 ffprobe —— 这是启动前必查的项，不能因为没装 ffmpeg 就跳过。
 */
async function inspectMp4Faststart(filePath) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const stat = await fh.stat();
    const head = Buffer.allocUnsafe(16);
    let offset = 0;

    // 最多看 64 个顶层 box，正常文件远用不到，纯粹防畸形文件死循环
    for (let i = 0; i < 64 && offset < stat.size; i++) {
      const { bytesRead } = await fh.read(head, 0, 16, offset);
      if (bytesRead < 8) break;

      let size = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      let headerLen = 8;

      if (size === 1) {
        // 64 位大 box
        if (bytesRead < 16) break;
        const hi = head.readUInt32BE(8);
        const lo = head.readUInt32BE(12);
        size = hi * 2 ** 32 + lo;
        headerLen = 16;
      } else if (size === 0) {
        size = stat.size - offset; // 延伸到文件尾
      }

      if (type === 'moov') return { faststart: true, moovOffset: offset };
      if (type === 'mdat') return { faststart: false, mdatOffset: offset };

      if (size < headerLen) break; // 畸形
      offset += size;
    }
    return { faststart: false, unknown: true };
  } finally {
    await fh.close();
  }
}

/** ffprobe 拿编码信息。没装 ffprobe 不算致命错误，返回 null 让上层降级。 */
async function probeStreams(filePath) {
  const bin = findFfprobe();
  if (!bin) return null;
  const { stdout } = await run(bin, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);
  const data = JSON.parse(stdout);
  const video = (data.streams || []).find((s) => s.codec_type === 'video') || null;
  const audio = (data.streams || []).find((s) => s.codec_type === 'audio') || null;
  return {
    duration: parseFloat(data.format?.duration) || 0,
    bitrate: parseInt(data.format?.bit_rate, 10) || 0,
    formatName: data.format?.format_name || '',
    videoCodec: video?.codec_name || null,
    audioCodec: audio?.codec_name || null,
    width: video?.width || null,
    height: video?.height || null,
  };
}

/**
 * 检查一个文件能不能直接进房。
 * 返回 action：
 *   'ok'      —— 直接用
 *   'remux'   —— 需要转封装（无损，几十秒内搞定）
 *   'reject'  —— 格式不支持
 */
async function inspect(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const stat = await fsp.stat(filePath);

  if (!SUPPORTED_EXT.has(ext)) {
    return {
      action: 'reject',
      ext,
      size: stat.size,
      reason: `只支持 MP4／MOV 和 MKV，当前是 ${ext || '(无扩展名)'}`,
    };
  }
  if (stat.size > 10 * 1024 ** 3) {
    return {
      action: 'reject',
      ext,
      size: stat.size,
      reason: `文件超过 10GB 上限（当前 ${(stat.size / 1024 ** 3).toFixed(2)}GB）`,
    };
  }

  const probe = await probeStreams(filePath).catch(() => null);

  if (ext === '.mkv') {
    return { action: 'ok', ext, size: stat.size, probe, reason: 'MKV 是流式容器，可直接边下边播' };
  }

  const label = ext === '.mov' ? 'MOV' : 'MP4';
  const fs4 = await inspectMp4Faststart(filePath);
  if (fs4.faststart) {
    return { action: 'ok', ext, size: stat.size, probe, faststart: true, reason: `${label} 索引已在文件头，可直接边下边播` };
  }

  return {
    action: 'remux',
    ext,
    size: stat.size,
    probe,
    faststart: false,
    reason: `${label} 的 moov 索引在文件末尾，顺序下载时要等整个文件下完才能起播。转封装把索引挪到开头即可，无损且不重编码。`,
  };
}

/**
 * 转封装：只重写容器，-c copy 表示编码数据原样搬运，不重新编码。
 * onProgress 收到 0..1 的进度（从 ffmpeg stderr 的 time= 里解出来）。
 */
async function remux(filePath, outDir, { onProgress } = {}) {
  const bin = findFfmpeg();
  if (!bin) {
    const err = new Error('没找到 ffmpeg。请安装后重试（winget install ffmpeg 或 scoop install ffmpeg），或设置环境变量 SYNCWATCH_FFMPEG_PATH');
    err.code = 'FFMPEG_NOT_FOUND';
    throw err;
  }

  await fsp.mkdir(outDir, { recursive: true });
  const base = path.basename(filePath, path.extname(filePath));
  const outPath = path.join(outDir, `${base}.faststart.mp4`);

  const probe = await probeStreams(filePath).catch(() => null);
  const total = probe?.duration || 0;

  await run(
    bin,
    ['-y', '-i', filePath, '-c', 'copy', '-movflags', '+faststart', outPath],
    {
      onStderr: (s) => {
        if (!onProgress || !total) return;
        const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(s);
        if (!m) return;
        const secs = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
        onProgress(Math.max(0, Math.min(1, secs / total)));
      },
    }
  );

  return { outPath };
}

function toolStatus() {
  return {
    ffmpeg: findFfmpeg(),
    ffprobe: findFfprobe(),
  };
}

module.exports = {
  inspect,
  remux,
  probeStreams,
  inspectMp4Faststart,
  findFfmpeg,
  findFfprobe,
  toolStatus,
  SUPPORTED_EXT,
};
