'use strict';

/**
 * 媒体兼容性检测、转封装与无损精简。
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
 *
 * 另一件能减少传输量的事是「无损精简」。视频码流本身已经是 H.264/H.265 的输出，
 * 熵接近满，再套一层 gzip/zstd 是零收益（实测 zstd 一个字节都压不掉，gzip 还会涨）。
 * 不牺牲画质还能减字节的办法只剩一个：把这一场放映用不上的轨道丢掉 ——
 * 多余音轨和图形字幕。见 slimPlan()。
 */

const { spawn } = require('child_process');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { findBin } = require('./findBin');

// .mov 和 .mp4 是同一个容器格式（都是 ISOBMFF），box 结构完全一致 ——
// 同一个解析器不加改动就能读两者，ffprobe 也把它们报成同一个 demuxer。
// 所以按 MP4 的规则一视同仁：查 moov 位置，在末尾就转封装。
const ISOBMFF_EXT = new Set(['.mp4', '.mov', '.m4v']);
const SUPPORTED_EXT = new Set([...ISOBMFF_EXT, '.mkv']);

// 图形字幕是一帧帧位图，一集能占几十甚至上百 MB；文本字幕（ASS/SRT）只有几百 KB。
// 所以只丢前者 —— 丢文本字幕省不下什么，观众却直接没字幕看了。
const GRAPHIC_SUB_CODECS = new Set([
  'hdmv_pgs_subtitle',
  'dvd_subtitle',
  'dvb_subtitle',
  'xsub',
]);

/**
 * 能安全转成 FLAC 的音频编码。
 *
 * 这是「无损精简」里唯一真的在压缩、而不是在丢东西的一步：PCM 是完全未压缩的
 * 采样数据，FLAC 是数学无损的熵编码，转过去还原出来逐字节相同。蓝光原盘转出来的
 * 片子经常带一条 24bit 5.1 的 PCM 轨，光这一条就有 6.9 Mbps —— 一部两小时的电影
 * 里 6 GB 有余，转 FLAC 之后通常剩一半上下。
 *
 * 名单卡得很死，因为「无损」这个词不能打折：
 *  - 只收整数 PCM，且位深必须正好是 16 或 24 —— ffmpeg 的 FLAC 编码器就支持这两种。
 *    20bit 的蓝光 PCM、32bit 和浮点 PCM 一律不碰。
 *  - **不碰 TrueHD**：它本身已经是无损压缩，多声道下压得往往比 FLAC 还好，
 *    转过去可能不省反涨。
 *  - **不碰 DTS-HD MA**：ffprobe 报的 codec_name 只有 'dts'，要靠 profile 区分，
 *    而老一点的 ffmpeg 构建只解得出有损的 core —— 那就成了偷偷降质，绝不能赌。
 */
const PCM_TO_FLAC_CODECS = new Set([
  'pcm_s16le',
  'pcm_s16be',
  'pcm_s24le',
  'pcm_s24be',
  'pcm_bluray',
  'pcm_dvd',
]);

/**
 * FLAC 能压到多少，完全取决于内容，不能拍一个固定比例。
 *
 * 本机实测（24bit、48kHz）：纯音调压到 9%，褐噪声 83%，粉噪声 89%，
 * **白噪声 101.5% —— 比原始 PCM 还大**。FLAC 是线性预测 + 熵编码，
 * 预测不了的信号它一个字节也省不下来，还要多花头部开销。
 * （测的时候各声道必须用独立信号：同一路复制成左右声道时 FLAC 的 mid/side
 * 会把 side 压成零，白噪声也能测出 51%，那不是最坏情况。）
 *
 * 所以这里不猜，直接拿文件本身去测：截中间 20 秒真编一遍 FLAC，量出比例。
 * 一两秒的代价，换一个属于这个文件的真实数字，而不是一个大概率落空的估计。
 * 量出来省不到 MIN_FLAC_SAVING 就干脆不提议转 —— 白折腾几分钟还可能变大。
 */
const FLAC_SAMPLE_SECONDS = 20;
const MIN_FLAC_SAVING = 0.08; // 省不到 8% 就不值得让用户等这几分钟

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

function requireFfmpeg() {
  const bin = findFfmpeg();
  if (bin) return bin;
  const err = new Error('没找到 ffmpeg。请安装后重试（winget install ffmpeg 或 scoop install ffmpeg），或设置环境变量 SYNCWATCH_FFMPEG_PATH');
  err.code = 'FFMPEG_NOT_FOUND';
  throw err;
}

// 正在跑的 ffmpeg/ffprobe。转封装和精简都是分钟级的，用户在中途关掉软件时
// 必须把它们一起收掉 —— 否则 Electron 退出了，ffmpeg 还在满速往 %TEMP% 里写几个 GB，
// 用户界面上已经「关掉了」，既看不见也停不掉；顺带还会让缓存目录当次删不掉
// （Windows 上被持有写句柄的文件删不了，要等下次启动才回收）。
const activeProcesses = new Set();

/** 退出前调用：终止所有还在跑的 ffmpeg/ffprobe。 */
function cancelAll() {
  for (const p of [...activeProcesses]) {
    try {
      p.kill();
    } catch {}
  }
  activeProcesses.clear();
}

function run(bin, args, { onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    activeProcesses.add(p);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => {
      const s = d.toString();
      err += s;
      if (err.length > 65536) err = err.slice(-32768);
      if (onStderr) onStderr(s);
    });
    p.on('error', (e) => {
      activeProcesses.delete(p);
      reject(e);
    });
    p.on('close', (code) => {
      activeProcesses.delete(p);
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(`${path.basename(bin)} 退出码 ${code}：${err.slice(-600)}`));
    });
  });
}

/** 从 ffmpeg 的 stderr 里解出 time=，换算成 0..1 的进度。拿不到总时长就不报进度。 */
function progressWatcher(total, onProgress) {
  if (!onProgress || !total) return undefined;
  return (s) => {
    const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(s);
    if (!m) return;
    const secs = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
    onProgress(Math.max(0, Math.min(1, secs / total)));
  };
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

/**
 * 取单条轨道的码率。
 *
 * MP4 一般直接给 bit_rate；MKV 基本都缺，但 mkvmerge 会往每条轨写 BPS 标签
 * （番剧压制组几乎都用 mkvmerge），键名可能带语言后缀，比如 BPS-eng。
 * 两处都没有就返回 null —— 上层据此只报「丢掉几条轨」，不编一个省量百分比出来。
 */
function streamBitRate(stream) {
  const direct = parseInt(stream.bit_rate, 10);
  if (Number.isFinite(direct) && direct > 0) return direct;

  for (const [key, value] of Object.entries(stream.tags || {})) {
    const upper = key.toUpperCase();
    if (upper !== 'BPS' && !upper.startsWith('BPS-')) continue;
    const bps = parseInt(value, 10);
    if (Number.isFinite(bps) && bps > 0) return bps;
  }
  return null;
}

/**
 * 采样估算每条轨的码率。
 *
 * ffprobe 的 bit_rate 在 MKV 里基本都是空的，mkvmerge 的 BPS 标签也只有压制组
 * 会写。两处都没有时以前只能报「估不出来」—— 用户于是完全不知道精简能省多少，
 * 也就不会去用它。这里退而求其次：读开头一段的包大小求和外推。
 *
 * 一次 ffprobe 把所有轨的包都读回来按 stream_index 分桶，不是每条轨跑一次。
 * VBR 下开头这段不完全代表全片，所以结果只用来给「省多少」这个量级，
 * 调用方要把它标成估算值。
 *
 * @returns {Promise<Map<number, number>>} 轨下标 -> bps
 */
async function sampleBitRates(filePath, { seconds = 120 } = {}) {
  const bin = findFfprobe();
  const out = new Map();
  if (!bin) return out;

  // 一定要用 json 按字段名取值。csv 的列序由 ffprobe 自己定，**不是** -show_entries
  // 里写的顺序 —— 实测它输出的是 stream_index, duration_time, size，按位置解构会把
  // 包时长当成包大小，parseInt('0.021000') 得 0，累加恒为 0，整个函数永远返回空 Map。
  const { stdout } = await run(bin, [
    '-v', 'error',
    '-read_intervals', `%+${seconds}`,
    '-select_streams', 'a',
    '-show_entries', 'packet=stream_index,size,duration_time',
    '-of', 'json',
    filePath,
  ]).catch(() => ({ stdout: '' }));

  let packets;
  try {
    packets = JSON.parse(stdout).packets;
  } catch {
    return out;
  }
  if (!Array.isArray(packets)) return out;

  const bytes = new Map();
  const span = new Map(); // 每轨实际采到多长，别拿固定的 seconds 当分母
  for (const p of packets) {
    const i = parseInt(p.stream_index, 10);
    const n = parseInt(p.size, 10);
    if (!Number.isFinite(i) || !Number.isFinite(n) || n <= 0) continue;
    bytes.set(i, (bytes.get(i) || 0) + n);
    const dt = parseFloat(p.duration_time);
    if (Number.isFinite(dt) && dt > 0) span.set(i, (span.get(i) || 0) + dt);
  }

  for (const [i, total] of bytes) {
    // 文件比采样区间短时，用固定的 seconds 当分母会把码率成比例算低。
    // 拿这一轨实际采到的时长当分母；时长信息缺失才退回 seconds。
    const dur = span.get(i);
    const divisor = Number.isFinite(dur) && dur > 0.5 ? dur : seconds;
    if (total > 0) out.set(i, Math.round((total * 8) / divisor));
  }
  return out;
}

/**
 * 实测这条 PCM 轨转 FLAC 能压到多少。
 *
 * 从文件中段截一段真编一遍（开头常常是没声音的厂标，压缩比会好得离谱，
 * 拿它外推整部片子必然偏乐观）。PCM 是定长的，同一段的原始字节数直接算得出来，
 * 不用再解码一次去量。
 *
 * @returns {Promise<number|null>} 0..1 的体积比，测不出来返回 null
 */
async function measureFlacRatio(filePath, stream, duration) {
  const bin = findFfmpeg();
  const bits = stream.bitsPerRawSample || (/_s16/.test(stream.codecName) ? 16 : 24);
  if (!bin || !stream.sampleRate || !stream.channels || !bits) return null;

  const span = Math.min(FLAC_SAMPLE_SECONDS, Math.max(1, duration || FLAC_SAMPLE_SECONDS));
  const start = duration > span * 3 ? Math.floor(duration / 2) : 0;
  const tmp = path.join(
    os.tmpdir(),
    `noxreel-flacprobe-${process.pid}-${Date.now()}.flac`
  );

  try {
    await run(bin, [
      '-y', '-v', 'error',
      '-ss', String(start),
      '-t', String(span),
      '-i', filePath,
      '-map', `0:${stream.index}`,
      '-c:a', 'flac',
      tmp,
    ]);
    const encoded = (await fsp.stat(tmp)).size;
    // ffmpeg 实际编到的时长可能比要求的短（比如文件到头了），用产物里的时长会更准，
    // 但那要再跑一次 ffprobe。这里直接用理论值：偏差只影响两边共同的分母。
    const rawBytes = stream.sampleRate * stream.channels * Math.ceil(bits / 8) * span;
    if (!rawBytes || !encoded) return null;
    return encoded / rawBytes;
  } catch {
    return null;
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

/**
 * ffprobe 拿编码信息。没装 ffprobe 不算致命错误，返回 null 让上层降级。
 * sample:true 时对拿不到码率的音轨补一次采样估算 —— 多花一两秒，
 * 换来界面上能说出「省多少」而不是「估不出来」。
 */
async function probeStreams(filePath, { sample = false } = {}) {
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
  const raw = data.streams || [];
  const video = raw.find((s) => s.codec_type === 'video') || null;
  const audio = raw.find((s) => s.codec_type === 'audio') || null;

  const streams = raw.map((s) => ({
    index: s.index,
    codecType: s.codec_type || '',
    codecName: s.codec_name || '',
    bitRate: streamBitRate(s),
    bitRateEstimated: false,
    language: s.tags?.language || null,
    title: s.tags?.title || null,
    channels: s.channels || null,
    sampleRate: parseInt(s.sample_rate, 10) || null,
    bitsPerRawSample: parseInt(s.bits_per_raw_sample, 10) || null,
    isDefault: s.disposition?.default === 1,
  }));

  if (sample && streams.some((s) => s.codecType === 'audio' && !s.bitRate)) {
    const sampled = await sampleBitRates(filePath).catch(() => new Map());
    for (const s of streams) {
      if (s.bitRate || !sampled.has(s.index)) continue;
      s.bitRate = sampled.get(s.index);
      s.bitRateEstimated = true;
    }
  }

  const duration = parseFloat(data.format?.duration) || 0;
  if (sample) {
    for (const s of streams) {
      if (!isFlacConvertible(s)) continue;
      s.flacRatio = await measureFlacRatio(filePath, s, duration);
    }
  }

  return {
    duration: parseFloat(data.format?.duration) || 0,
    bitrate: parseInt(data.format?.bit_rate, 10) || 0,
    formatName: data.format?.format_name || '',
    videoCodec: video?.codec_name || null,
    audioCodec: audio?.codec_name || null,
    width: video?.width || null,
    height: video?.height || null,
    streams,
  };
}

const EMPTY_SLIM_PLAN = Object.freeze({
  available: false,
  savableBytes: 0,
  estimateComplete: true,
  keep: [],
  drop: [],
  keepAudioIndex: null,
  dropAudio: 0,
  dropSubs: 0,
  toFlac: [],
  flacSavableBytes: 0,
  flacRatio: null,
  minFlacSaving: MIN_FLAC_SAVING,
  reencodesAudio: false,
});

/**
 * 算一份「无损精简」方案：只重写容器、不重编码，靠丢掉这一场用不上的轨来省体积。
 *
 * 省下来的大头是多余音轨（一条两小时的 AC3 5.1 就有 300MB 上下）和图形字幕。
 * 必须留下的：视频轨、一条音轨、全部文本字幕，以及 MKV 的内嵌字体附件 ——
 * 字体丢了 ASS 字幕会掉字形，那就不叫无损了。
 */
/** 编码本身允不允许无损转 FLAC。判据见 PCM_TO_FLAC_CODECS 的注释。 */
function isFlacConvertible(stream) {
  if (!stream || stream.codecType !== 'audio') return false;
  if (!PCM_TO_FLAC_CODECS.has(stream.codecName)) return false;
  const bits =
    stream.bitsPerRawSample ||
    (/_s16/.test(stream.codecName) ? 16 : /_s24/.test(stream.codecName) ? 24 : 0);
  return bits === 16 || bits === 24;
}

/**
 * 这条音轨值不值得转 FLAC：编码允许、输出是 MKV、而且实测确实能省下东西。
 * 没测过（没装 ffmpeg、或者调用方没要采样）就不提议 —— 宁可少省一点，
 * 也不能让人等上几分钟换来一个更大的文件。
 */
function canTranscodeToFlac(stream, { toMkv }) {
  if (!toMkv) return false; // FLAC 在 MP4 里的播放器支持面窄，尤其是安卓的 ExoPlayer
  if (!isFlacConvertible(stream)) return false;
  return typeof stream.flacRatio === 'number' && stream.flacRatio <= 1 - MIN_FLAC_SAVING;
}

function slimPlan(probe, { toMkv = true } = {}) {
  const streams = probe?.streams;
  if (!Array.isArray(streams) || !streams.length) return EMPTY_SLIM_PLAN;

  const audio = streams.filter((s) => s.codecType === 'audio');
  const graphicSubs = streams.filter(
    (s) => s.codecType === 'subtitle' && GRAPHIC_SUB_CODECS.has(s.codecName)
  );
  const keepAudioPreview = audio.find((s) => s.isDefault) || audio[0] || null;
  const flacCandidate =
    keepAudioPreview && canTranscodeToFlac(keepAudioPreview, { toMkv }) ? keepAudioPreview : null;

  // 只有一条音轨、没有图形字幕、那条音轨也不值得转 FLAC —— 那确实没什么可做的。
  if (audio.length <= 1 && !graphicSubs.length && !flacCandidate) return EMPTY_SLIM_PLAN;

  const keepAudio = keepAudioPreview;
  const dropped = new Set([
    ...audio.filter((s) => s !== keepAudio).map((s) => s.index),
    ...graphicSubs.map((s) => s.index),
  ]);
  const keep = streams.filter((s) => !dropped.has(s.index));

  const duration = probe.duration || 0;
  let savableBytes = 0;
  let estimateComplete = true;
  for (const s of streams) {
    if (!dropped.has(s.index)) continue;
    if (!s.bitRate || !duration) {
      estimateComplete = false; // 这条轨估不出来，别把总数说得像确数
      continue;
    }
    savableBytes += Math.round((s.bitRate / 8) * duration);
  }

  // 每轨码率的可信度自查：各轨之和不该明显超过容器整体码率。对不上就说明标签
  // 是陈的（有些工具会把 BPS 原样抄进重新压过的文件），这时候宁可说「估不出来」，
  // 也别报一个必定落空的数字。实测正常文件这个比值在 0.97~1.00。
  const declared = streams.reduce((sum, s) => sum + (s.bitRate || 0), 0);
  if (probe.bitrate > 0 && declared > probe.bitrate * 1.15) {
    estimateComplete = false;
    savableBytes = 0;
  }

  // PCM 转 FLAC 是这里唯一真的在「压缩」的一步，跟丢轨分开算：丢轨的省量
  // 是确数（那条轨的字节整个不传了），转码的省量只能估个量级。
  let flacSavableBytes = 0;
  const toFlac = [];
  if (flacCandidate && !dropped.has(flacCandidate.index)) {
    toFlac.push(flacCandidate.index);
    const bps =
      flacCandidate.bitRate ||
      (flacCandidate.sampleRate && flacCandidate.channels && flacCandidate.bitsPerRawSample
        ? flacCandidate.sampleRate * flacCandidate.channels * flacCandidate.bitsPerRawSample
        : 0);
    if (bps && duration) {
      flacSavableBytes = Math.round((bps / 8) * duration * (1 - flacCandidate.flacRatio));
    }
  }

  return {
    available: true,
    savableBytes,
    estimateComplete,
    keep: keep.map((s) => s.index),
    drop: [...dropped].sort((a, b) => a - b),
    keepAudioIndex: keepAudio ? keepAudio.index : null,
    dropAudio: Math.max(0, audio.length - 1),
    dropSubs: graphicSubs.length,
    toFlac,
    flacSavableBytes,
    flacRatio: flacCandidate ? flacCandidate.flacRatio : null,
    // 门槛跟着方案一起过去，界面换音轨时重算才不会另写一个数。
    minFlacSaving: MIN_FLAC_SAVING,
    // 转码要解一遍再编一遍，是分钟级；纯丢轨只重写容器，是秒级。
    // 这两件事的等待体感差一个数量级，界面必须提前说清楚。
    reencodesAudio: toFlac.length > 0,
  };
}

/**
 * 检查一个文件能不能直接进房。
 * 返回 action：
 *   'ok'      —— 直接用
 *   'remux'   —— 需要转封装（无损，几十秒内搞定）
 *   'reject'  —— 格式不支持
 * 另外带一份 slim 方案，告诉上层「还能无损省掉多少」。
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

  // 这里是唯一需要把「能省多少」说清楚的地方，值得多花一两秒去采样估码率。
  const probe = await probeStreams(filePath, { sample: true }).catch(() => null);
  const slim = slimPlan(probe, { toMkv: ext === '.mkv' });

  if (ext === '.mkv') {
    return { action: 'ok', ext, size: stat.size, probe, slim, reason: 'MKV 是流式容器，可直接边下边播' };
  }

  const label = ext === '.mov' ? 'MOV' : 'MP4';
  const fs4 = await inspectMp4Faststart(filePath);
  if (fs4.faststart) {
    return { action: 'ok', ext, size: stat.size, probe, slim, faststart: true, reason: `${label} 索引已在文件头，可直接边下边播` };
  }

  return {
    action: 'remux',
    ext,
    size: stat.size,
    probe,
    slim,
    faststart: false,
    reason: `${label} 的 moov 索引在文件末尾，顺序下载时要等整个文件下完才能起播。转封装把索引挪到开头即可，无损且不重编码。`,
  };
}

/**
 * 转封装：只重写容器，-c copy 表示编码数据原样搬运，不重新编码。
 * onProgress 收到 0..1 的进度（从 ffmpeg stderr 的 time= 里解出来）。
 */
async function remux(filePath, outDir, { onProgress } = {}) {
  const bin = requireFfmpeg();

  await fsp.mkdir(outDir, { recursive: true });
  const base = path.basename(filePath, path.extname(filePath));
  const outPath = path.join(outDir, `${base}.faststart.mp4`);

  const probe = await probeStreams(filePath).catch(() => null);

  await run(
    bin,
    ['-y', '-i', filePath, '-c', 'copy', '-movflags', '+faststart', outPath],
    { onStderr: progressWatcher(probe?.duration || 0, onProgress) }
  );

  return { outPath };
}

/** 按精简方案拼 ffmpeg 参数。抽出来单独测，不用真跑一遍 ffmpeg。 */
function slimArgs(filePath, outPath, keepIndexes, { toFlac = [] } = {}) {
  const args = ['-y', '-i', filePath];
  for (const index of keepIndexes) args.push('-map', `0:${index}`);
  args.push('-c', 'copy');
  // -c:<n> 里的 n 是**输出**流下标，也就是这条轨在 -map 顺序里的位置，
  // 不是输入文件里的下标。写错就会把编码设到别的轨上去。
  for (const inputIndex of toFlac) {
    const outIndex = keepIndexes.indexOf(inputIndex);
    if (outIndex >= 0) args.push(`-c:${outIndex}`, 'flac');
  }
  // faststart 只对 ISOBMFF 有效。MKV 天生流式不需要，硬加 ffmpeg 会直接报错。
  if (path.extname(outPath).toLowerCase() !== '.mkv') args.push('-movflags', '+faststart');
  args.push(outPath);
  return args;
}

/**
 * 无损精简：丢掉多余音轨和图形字幕，-c copy 把留下的轨原样搬运。
 *
 * 输入是 MP4／MOV／M4V 时输出 MP4 并顺手加 +faststart —— 也就是说这一步
 * 同时把转封装做了，需要 remux 的文件选了精简就不必再单独跑一次。
 * 输入是 MKV 时输出仍是 MKV（保住 ASS 字幕和内嵌字体）。
 */
async function slim(filePath, outDir, { keepIndexes, toFlac: toFlacIn, onProgress } = {}) {
  const bin = requireFfmpeg();

  const ext = path.extname(filePath).toLowerCase();
  const isMkv = ext === '.mkv';
  await fsp.mkdir(outDir, { recursive: true });
  const base = path.basename(filePath, ext);
  const outPath = path.join(outDir, `${base}.slim${isMkv ? '.mkv' : '.mp4'}`);

  // 必须和 inspect() 用同一套采样选项：转不转 FLAC 取决于实测出来的压缩比，
  // 这里少给一个 sample:true，方案就会静默退化成「只丢轨、不转码」，
  // 而界面上刚跟用户承诺过要省那一块。
  const probe = await probeStreams(filePath, { sample: true }).catch(() => null);
  const plan = slimPlan(probe, { toMkv: isMkv });
  const indexes = Array.isArray(keepIndexes) && keepIndexes.length ? keepIndexes : plan.keep;
  if (!indexes.length) throw new Error('没有可保留的轨道，无法精简');
  // 调用方换了要保留的音轨时，转 FLAC 的目标要跟着换 —— 否则会去转一条
  // 根本没保留的轨，ffmpeg 直接报错。留下的那条也得重新判一次能不能转。
  const requested = Array.isArray(toFlacIn) ? toFlacIn : plan.toFlac || [];
  // 除了「这条轨还在不在保留列表里」，还得自己复查一遍能不能转。
  // canTranscodeToFlac 的第一道判据就是输出容器必须是 MKV（FLAC-in-MP4 的播放器
  // 支持面太窄，安卓的 ExoPlayer 尤其），而调用方传来的 toFlac 是渲染进程算的、
  // 那边漏掉了容器判断。守卫写在两处都不算冗余：这一步的产物是不可逆的。
  const byIndex = new Map((probe?.streams || []).map((s) => [s.index, s]));
  const toFlac = requested.filter(
    (i) => indexes.includes(i) && canTranscodeToFlac(byIndex.get(i), { toMkv: isMkv })
  );

  await run(bin, slimArgs(filePath, outPath, indexes, { toFlac }), {
    onStderr: progressWatcher(probe?.duration || 0, onProgress),
  });

  const [inputSize, outputSize] = await Promise.all([
    fsp.stat(filePath).then((s) => s.size, () => 0),
    fsp.stat(outPath).then((s) => s.size, () => 0),
  ]);

  return {
    outPath,
    plan: { ...plan, toFlac, reencodesAudio: toFlac.length > 0 },
    inputSize,
    outputSize,
  };
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
  slim,
  slimArgs,
  slimPlan,
  cancelAll,
  canTranscodeToFlac,
  isFlacConvertible,
  measureFlacRatio,
  probeStreams,
  sampleBitRates,
  streamBitRate,
  inspectMp4Faststart,
  findFfmpeg,
  findFfprobe,
  toolStatus,
  SUPPORTED_EXT,
  GRAPHIC_SUB_CODECS,
  PCM_TO_FLAC_CODECS,
  MIN_FLAC_SAVING,
  FLAC_SAMPLE_SECONDS,
};
