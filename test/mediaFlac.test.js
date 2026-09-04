'use strict';

/**
 * 无损精简里唯一真的在「压缩」的一步：未压缩的 PCM 音轨转 FLAC。
 *
 * 这条路径必须守住两件事，任何一件破了都是欺骗用户：
 *  1. 真的无损 —— 解码出来的采样逐字节相同；
 *  2. 真的省 —— 实测省不到门槛就干脆不提议，绝不让人白等几分钟换来一个更大的文件。
 *     （本机实测：独立双声道白噪声下 FLAC 比原始 PCM 还大 1.5%。）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const media = require('../src/main/media.js');

const pcmTrack = (over = {}) => ({
  index: 1,
  codecType: 'audio',
  codecName: 'pcm_s24le',
  bitRate: 6912000,
  channels: 6,
  sampleRate: 48000,
  bitsPerRawSample: 24,
  isDefault: true,
  flacRatio: 0.55,
  ...over,
});

const probeWith = (streams, over = {}) => ({
  duration: 7200,
  bitrate: 30e6,
  streams,
  ...over,
});

const video = { index: 0, codecType: 'video', codecName: 'h264', bitRate: 20e6 };

/* --------------------------- 能不能转的判据 --------------------------- */

test('整数 PCM 的 16／24 位可以转', () => {
  for (const [codec, bits] of [
    ['pcm_s16le', 16],
    ['pcm_s24le', 24],
    ['pcm_s16be', 16],
    ['pcm_s24be', 24],
    ['pcm_bluray', 24],
    ['pcm_dvd', 16],
  ]) {
    assert.equal(
      media.isFlacConvertible(pcmTrack({ codecName: codec, bitsPerRawSample: bits })),
      true,
      `${codec}/${bits}bit 应该可转`
    );
  }
});

test('20 位、32 位和浮点 PCM 一律不碰 —— ffmpeg 的 FLAC 编码器只稳吃 16／24 位', () => {
  assert.equal(media.isFlacConvertible(pcmTrack({ codecName: 'pcm_bluray', bitsPerRawSample: 20 })), false);
  assert.equal(media.isFlacConvertible(pcmTrack({ codecName: 'pcm_s32le', bitsPerRawSample: 32 })), false);
  assert.equal(media.isFlacConvertible(pcmTrack({ codecName: 'pcm_f32le', bitsPerRawSample: 32 })), false);
});

test('TrueHD 不碰：它本身已经是无损压缩，转过去可能不省反涨', () => {
  assert.equal(media.isFlacConvertible(pcmTrack({ codecName: 'truehd', bitsPerRawSample: 24 })), false);
  assert.equal(media.isFlacConvertible(pcmTrack({ codecName: 'mlp', bitsPerRawSample: 24 })), false);
});

test('DTS 不碰：codec_name 只有 dts，老 ffmpeg 只解得出有损 core，赌不起', () => {
  assert.equal(media.isFlacConvertible(pcmTrack({ codecName: 'dts', bitsPerRawSample: 24 })), false);
});

test('有损编码当然不碰 —— 转过去只会二次损失', () => {
  for (const codec of ['aac', 'ac3', 'eac3', 'opus', 'mp3', 'vorbis']) {
    assert.equal(media.isFlacConvertible(pcmTrack({ codecName: codec })), false, codec);
  }
});

test('视频轨和字幕轨不会被当成音轨', () => {
  assert.equal(media.isFlacConvertible({ ...pcmTrack(), codecType: 'video' }), false);
  assert.equal(media.isFlacConvertible(null), false);
});

/* ------------------------- 值不值得转（含实测） ------------------------- */

test('没实测过压缩比就不提议 —— 宁可少省，也不能让人白等', () => {
  const noRatio = pcmTrack({ flacRatio: undefined });
  assert.equal(media.canTranscodeToFlac(noRatio, { toMkv: true }), false);
  const plan = media.slimPlan(probeWith([video, noRatio]), { toMkv: true });
  assert.deepEqual(plan.toFlac, []);
});

test('实测省不到门槛就不提议', () => {
  // 白噪声那种情况：FLAC 比原始 PCM 还大
  assert.equal(media.canTranscodeToFlac(pcmTrack({ flacRatio: 1.0007 }), { toMkv: true }), false);
  // 刚好卡在门槛上也不提议
  assert.equal(
    media.canTranscodeToFlac(pcmTrack({ flacRatio: 1 - media.MIN_FLAC_SAVING + 0.001 }), { toMkv: true }),
    false
  );
  assert.equal(media.canTranscodeToFlac(pcmTrack({ flacRatio: 1 - media.MIN_FLAC_SAVING }), { toMkv: true }), true);
});

test('输出不是 MKV 就不转 —— FLAC 在 MP4 里的播放器支持面太窄', () => {
  assert.equal(media.canTranscodeToFlac(pcmTrack(), { toMkv: false }), false);
  const plan = media.slimPlan(probeWith([video, pcmTrack()]), { toMkv: false });
  assert.deepEqual(plan.toFlac, []);
});

test('单条 PCM 音轨、没有别的可丢，也值得单独跑一趟精简', () => {
  const plan = media.slimPlan(probeWith([video, pcmTrack()]), { toMkv: true });
  assert.equal(plan.available, true, '这时候唯一的收益就是转 FLAC，不能因为「没得丢」就整个不提议');
  assert.deepEqual(plan.toFlac, [1]);
  assert.equal(plan.savableBytes, 0, '一条轨都没丢，丢轨省量应该是 0');
  assert.ok(plan.flacSavableBytes > 0);
  assert.equal(plan.reencodesAudio, true);
});

test('单条有损音轨、没有图形字幕 → 确实无事可做', () => {
  const plan = media.slimPlan(probeWith([video, pcmTrack({ codecName: 'aac', flacRatio: undefined })]), {
    toMkv: true,
  });
  assert.equal(plan.available, false);
});

test('省量按实测比例算，不是按固定系数拍脑袋', () => {
  const a = media.slimPlan(probeWith([video, pcmTrack({ flacRatio: 0.5 })]), { toMkv: true });
  const b = media.slimPlan(probeWith([video, pcmTrack({ flacRatio: 0.8 })]), { toMkv: true });
  assert.ok(a.flacSavableBytes > b.flacSavableBytes * 2, '压得越狠，报出来的省量该越大');
  // 6.912 Mbps × 7200s × (1-0.5) / 8 ≈ 3.11 GB
  assert.ok(Math.abs(a.flacSavableBytes - 3110400000) / 3110400000 < 0.01);
});

test('丢轨省量和转码省量分开报 —— 一个是确数，一个只能估量级', () => {
  const extra = { index: 2, codecType: 'audio', codecName: 'ac3', bitRate: 640000 };
  const plan = media.slimPlan(probeWith([video, pcmTrack(), extra]), { toMkv: true });
  assert.ok(plan.savableBytes > 0, '丢掉的 AC3 是确数');
  assert.ok(plan.flacSavableBytes > 0);
  assert.notEqual(plan.savableBytes, plan.flacSavableBytes);
  assert.deepEqual(plan.drop, [2]);
  assert.deepEqual(plan.toFlac, [1]);
});

test('门槛值跟着方案发给界面，两边不各写一个', () => {
  assert.equal(media.slimPlan(probeWith([video, pcmTrack()]), { toMkv: true }).minFlacSaving, media.MIN_FLAC_SAVING);
  assert.equal(media.slimPlan(null).minFlacSaving, media.MIN_FLAC_SAVING);
});

/* --------------------------- ffmpeg 参数拼装 --------------------------- */

test('-c:N 里的 N 是输出流下标，不是输入文件里的下标', () => {
  // 保留输入的 0、3、5 三条，要把输入 #3 转 FLAC → 它在输出里排第 1 位
  const args = media.slimArgs('in.mkv', 'out.mkv', [0, 3, 5], { toFlac: [3] });
  assert.ok(args.includes('-c:1'), `写成了 ${args.join(' ')}`);
  assert.equal(args[args.indexOf('-c:1') + 1], 'flac');
  assert.ok(!args.includes('-c:3'), '用输入下标会把编码设到别的轨上去');
});

test('没有要转的轨时保持纯 -c copy', () => {
  const args = media.slimArgs('in.mkv', 'out.mkv', [0, 1]);
  assert.deepEqual(args, ['-y', '-i', 'in.mkv', '-map', '0:0', '-map', '0:1', '-c', 'copy', 'out.mkv']);
});

test('要转的轨不在保留列表里就直接忽略，不给 ffmpeg 一个必然报错的参数', () => {
  const args = media.slimArgs('in.mkv', 'out.mkv', [0, 1], { toFlac: [7] });
  assert.ok(!args.some((a) => /^-c:\d+$/.test(a)));
});

test('视频轨永远是 -c copy，不会被顺手重编码', () => {
  const args = media.slimArgs('in.mkv', 'out.mkv', [0, 1], { toFlac: [1] });
  assert.ok(!args.includes('-c:0'), '给输出第 0 条（视频）设了编码器');
  assert.ok(!args.some((a) => /libx264|libx265|-crf|-b:v/.test(a)), '出现了重编码参数');
});

test('MP4 输出仍带 +faststart，MKV 不带', () => {
  assert.ok(media.slimArgs('in.mp4', 'out.mp4', [0, 1]).includes('+faststart'));
  assert.ok(!media.slimArgs('in.mkv', 'out.mkv', [0, 1]).includes('+faststart'));
});

/* ---------------------- 真跑一遍 ffmpeg（有才跑） ---------------------- */

const { ffmpeg } = media.toolStatus();

test('端到端：PCM 转 FLAC 之后解码出来逐字节相同', { skip: ffmpeg ? false : '本机没装 ffmpeg' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noxreel-flac-'));
  const src = path.join(dir, 'src.mkv');
  const md5 = (file, spec) =>
    execFileSync(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', spec, '-f', 'md5', '-c:a', 'pcm_s24le', '-'],
      { encoding: 'utf8' }
    ).trim();

  try {
    execFileSync(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15:duration=8',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=8',
      '-filter_complex', '[1:a]pan=stereo|c0=c0|c1=c0[a]',
      '-map', '0:v', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '35',
      '-c:a', 'pcm_s24le',
      src,
    ]);

    const probe = await media.probeStreams(src, { sample: true });
    const audio = probe.streams.find((s) => s.codecType === 'audio');
    assert.equal(typeof audio.flacRatio, 'number', '应该已经实测过压缩比');

    const before = md5(src, '0:a:0');
    const result = await media.slim(src, path.join(dir, 'out'), {});
    assert.deepEqual(result.plan.toFlac, [audio.index]);

    const out = await media.probeStreams(result.outPath);
    assert.equal(out.streams.find((s) => s.codecType === 'audio').codecName, 'flac');
    assert.equal(md5(result.outPath, '0:a:0'), before, 'FLAC 解码结果和源 PCM 不一致 —— 这就不叫无损了');
    assert.equal(md5(result.outPath, '0:v:0'), md5(src, '0:v:0'), '视频轨被动过');
    assert.ok(result.outputSize < result.inputSize);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('端到端：压不动的内容不会被提议转码', { skip: ffmpeg ? false : '本机没装 ffmpeg' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noxreel-flac-'));
  const src = path.join(dir, 'noise.mkv');
  try {
    execFileSync(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15:duration=8',
      // 两路独立种子：拿同一路复制成左右声道的话，FLAC 的 mid/side 会把 side 压成零，
      // 测出来是 51% 而不是最坏情况，守卫就被绕过去了。
      '-f', 'lavfi', '-i', 'anoisesrc=color=white:amplitude=0.9:sample_rate=48000:duration=8:seed=1',
      '-f', 'lavfi', '-i', 'anoisesrc=color=white:amplitude=0.9:sample_rate=48000:duration=8:seed=77',
      '-filter_complex', '[1:a][2:a]amerge=inputs=2[a]',
      '-map', '0:v', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '35',
      '-c:a', 'pcm_s24le',
      src,
    ]);

    const probe = await media.probeStreams(src, { sample: true });
    const audio = probe.streams.find((s) => s.codecType === 'audio');
    assert.ok(audio.flacRatio > 1 - media.MIN_FLAC_SAVING, `白噪声居然压到了 ${audio.flacRatio}`);
    assert.deepEqual(media.slimPlan(probe, { toMkv: true }).toFlac, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('采样估码率：容器不写每轨码率时也能给出量级', { skip: ffmpeg ? false : '本机没装 ffmpeg' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noxreel-bps-'));
  const src = path.join(dir, 'a.mkv');
  try {
    execFileSync(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15:duration=8',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=8',
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '35',
      '-c:a', 'ac3', '-b:a', '192k',
      src,
    ]);

    const plain = await media.probeStreams(src);
    const audioPlain = plain.streams.find((s) => s.codecType === 'audio');
    const sampled = await media.probeStreams(src, { sample: true });
    const audioSampled = sampled.streams.find((s) => s.codecType === 'audio');

    // MKV 不写每轨 bit_rate，所以不采样时这一栏是空的
    if (audioPlain.bitRate === null) {
      assert.equal(typeof audioSampled.bitRate, 'number', '采样之后应该有数了');
      assert.equal(audioSampled.bitRateEstimated, true, '估出来的必须标记成估算值');
      assert.ok(
        audioSampled.bitRate > 150e3 && audioSampled.bitRate < 260e3,
        `192kbps 的轨估成了 ${audioSampled.bitRate}`
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
