'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const media = require('../src/main/media');

const root = path.join(__dirname, '..');

/** 造一份 probeStreams 的输出，省得为了测选轨逻辑真去准备一堆样片。 */
function probe(streams, duration = 1440) {
  return { duration, streams };
}
const track = (index, codecType, codecName, extra = {}) => ({
  index,
  codecType,
  codecName,
  bitRate: null,
  language: null,
  title: null,
  channels: null,
  isDefault: false,
  ...extra,
});

test('单音轨、无图形字幕时没有可精简的余地', () => {
  const plan = media.slimPlan(
    probe([track(0, 'video', 'h264', { bitRate: 2_000_000, isDefault: true }), track(1, 'audio', 'aac', { bitRate: 192_000, isDefault: true })])
  );
  assert.equal(plan.available, false);
  assert.equal(plan.savableBytes, 0);
});

test('probe 缺失或没有轨道时安全退化，不抛错', () => {
  for (const bad of [null, undefined, {}, { streams: [] }, { streams: null }]) {
    const plan = media.slimPlan(bad);
    assert.equal(plan.available, false);
    assert.deepEqual(plan.keep, []);
  }
});

test('多音轨时保留默认音轨，丢掉其余音轨和图形字幕', () => {
  const plan = media.slimPlan(
    probe([
      track(0, 'video', 'h264', { bitRate: 4_000_000, isDefault: true }),
      track(1, 'audio', 'aac', { bitRate: 128_000, language: 'jpn' }),
      track(2, 'audio', 'ac3', { bitRate: 640_000, language: 'chi', isDefault: true }),
      track(3, 'subtitle', 'ass', { isDefault: true }),
      track(4, 'subtitle', 'hdmv_pgs_subtitle', { bitRate: 900_000 }),
      track(5, 'attachment', 'ttf'),
    ])
  );

  assert.equal(plan.available, true);
  assert.equal(plan.keepAudioIndex, 2, '应当选中带 default 标记的那条音轨');
  // 文本字幕和字体附件都必须留下 —— 丢了字体，ASS 字幕会掉字形，就不叫无损了
  assert.deepEqual(plan.keep, [0, 2, 3, 5]);
  assert.deepEqual(plan.drop, [1, 4]);
  assert.equal(plan.dropAudio, 1);
  assert.equal(plan.dropSubs, 1);
  assert.equal(plan.estimateComplete, true);
  assert.equal(plan.savableBytes, Math.round(((128_000 + 900_000) / 8) * 1440));
});

test('没有 default 标记时退回第一条音轨', () => {
  const plan = media.slimPlan(
    probe([
      track(0, 'video', 'h264'),
      track(1, 'audio', 'aac', { language: 'jpn' }),
      track(2, 'audio', 'aac', { language: 'eng' }),
    ])
  );
  assert.equal(plan.keepAudioIndex, 1);
  assert.deepEqual(plan.drop, [2]);
});

test('文本字幕一律保留，只丢图形字幕', () => {
  const plan = media.slimPlan(
    probe([
      track(0, 'video', 'h264'),
      track(1, 'audio', 'aac'),
      track(2, 'subtitle', 'subrip'),
      track(3, 'subtitle', 'mov_text'),
      track(4, 'subtitle', 'dvd_subtitle'),
    ])
  );
  assert.deepEqual(plan.keep, [0, 1, 2, 3]);
  assert.deepEqual(plan.drop, [4]);
  assert.equal(plan.dropAudio, 0);
});

test('估不出体积时如实标记，不编一个数字出来', () => {
  const plan = media.slimPlan(
    probe([
      track(0, 'video', 'h264'),
      track(1, 'audio', 'aac', { bitRate: 128_000 }),
      track(2, 'audio', 'ac3'), // 没有码率信息
    ])
  );
  assert.equal(plan.available, true);
  assert.equal(plan.estimateComplete, false, '有一条轨估不出来就不能声称是确数');
  assert.equal(plan.savableBytes, 0);
});

test('没有时长同样估不出体积', () => {
  const plan = media.slimPlan(
    probe([track(0, 'video', 'h264'), track(1, 'audio', 'aac', { bitRate: 1 }), track(2, 'audio', 'ac3', { bitRate: 640_000 })], 0)
  );
  assert.equal(plan.estimateComplete, false);
  assert.equal(plan.savableBytes, 0);
});

test('每轨码率优先用 bit_rate，MKV 缺失时回退到 mkvmerge 的 BPS 标签', () => {
  assert.equal(media.streamBitRate({ bit_rate: '640000' }), 640_000);
  assert.equal(media.streamBitRate({ tags: { BPS: '448000' } }), 448_000);
  // mkvmerge 会写成带语言后缀的形式
  assert.equal(media.streamBitRate({ tags: { 'BPS-eng': '128000' } }), 128_000);
  assert.equal(media.streamBitRate({ bit_rate: '640000', tags: { BPS: '1' } }), 640_000);
  assert.equal(media.streamBitRate({}), null);
  assert.equal(media.streamBitRate({ bit_rate: 'N/A' }), null);
  assert.equal(media.streamBitRate({ bit_rate: '0' }), null);
  assert.equal(media.streamBitRate({ tags: { TITLE: '中文' } }), null);
});

test('精简参数：MP4 输出补 faststart，MKV 输出不能带 movflags', () => {
  const mp4 = media.slimArgs('C:/in.mp4', 'C:/out.slim.mp4', [0, 2]);
  assert.deepEqual(mp4, [
    '-y', '-i', 'C:/in.mp4',
    '-map', '0:0', '-map', '0:2',
    '-c', 'copy',
    '-movflags', '+faststart',
    'C:/out.slim.mp4',
  ]);

  // MKV 是流式容器，硬加 +faststart ffmpeg 会直接报错
  const mkv = media.slimArgs('C:/in.mkv', 'C:/out.slim.mkv', [0, 2, 3, 5]);
  assert.equal(mkv.includes('-movflags'), false);
  assert.equal(mkv.at(-1), 'C:/out.slim.mkv');
  assert.ok(mkv.includes('-c') && mkv[mkv.indexOf('-c') + 1] === 'copy', '必须是 -c copy，不能重新编码');
});

test('精简全程不出现任何重新编码的参数', () => {
  for (const out of ['C:/o.mp4', 'C:/o.mkv']) {
    const args = media.slimArgs('C:/in.mkv', out, [0, 1]);
    for (const forbidden of ['-crf', '-b:v', '-vf', '-s', 'libx264', 'libx265', '-preset']) {
      assert.equal(args.includes(forbidden), false, `${out} 不应出现 ${forbidden}`);
    }
  }
});

test('传输层不做任何通用压缩 —— 视频码流压不动，压了只会白烧 CPU', () => {
  const sources = ['src/renderer/lib/protocol.js', 'src/renderer/lib/peer.js', 'src/renderer/lib/swarm.js'];
  for (const rel of sources) {
    const code = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const forbidden of ['CompressionStream', 'DecompressionStream', 'pako', 'zlib', 'gzip', 'brotli', 'zstd']) {
      assert.equal(code.includes(forbidden), false, `${rel} 不应引入 ${forbidden}`);
    }
  }
});

test('每轨码率之和明显超过容器码率时判定标签不可信，不报假数字', () => {
  // 有些工具会把源文件的 BPS 标签原样抄进重新压过的文件，数字就此对不上。
  // 实测正常文件里「各轨之和 / 容器码率」在 0.97~1.00，超出一大截只能是标签陈了。
  const plan = media.slimPlan({
    duration: 1440,
    bitrate: 400_000,
    streams: [
      track(0, 'video', 'h264', { bitRate: 3_500_000 }),
      track(1, 'audio', 'aac', { bitRate: 128_000 }),
      track(2, 'audio', 'ac3', { bitRate: 640_000 }),
    ],
  });
  assert.equal(plan.available, true, '轨道该丢还是要丢');
  assert.equal(plan.estimateComplete, false);
  assert.equal(plan.savableBytes, 0, '与其报一个必定落空的数字，不如说估不出来');
});

test('码率自洽的文件正常给出估算', () => {
  const plan = media.slimPlan({
    duration: 1000,
    bitrate: 4_270_000,
    streams: [
      track(0, 'video', 'h264', { bitRate: 3_500_000 }),
      track(1, 'audio', 'aac', { bitRate: 128_000, isDefault: true }),
      track(2, 'audio', 'ac3', { bitRate: 640_000 }),
    ],
  });
  assert.equal(plan.estimateComplete, true);
  assert.equal(plan.savableBytes, Math.round((640_000 / 8) * 1000));
});

test('容器没报整体码率时不做自洽性判断，按已知轨道算', () => {
  const plan = media.slimPlan({
    duration: 1000,
    bitrate: 0,
    streams: [
      track(0, 'video', 'h264', { bitRate: 3_500_000 }),
      track(1, 'audio', 'aac', { bitRate: 128_000, isDefault: true }),
      track(2, 'audio', 'ac3', { bitRate: 640_000 }),
    ],
  });
  assert.equal(plan.estimateComplete, true);
  assert.equal(plan.savableBytes, Math.round((640_000 / 8) * 1000));
});
