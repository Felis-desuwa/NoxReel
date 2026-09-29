'use strict';

// 只给分开音视频流的网站（B 站）：房主挑一对直链给安卓成员（ExoPlayer 自己合）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const linkMedia = require('../src/main/linkMedia');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('src', 'renderer', 'app.js');

function fnSource(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层函数 ${name}`);
  const end = APP.indexOf('\n}\n', m.index);
  return APP.slice(m.index, end + 2);
}

const REF = { Referer: 'https://www.bilibili.com/video/BV1', 'User-Agent': 'UA' };
const fmt = (id, extra) => ({ format_id: id, protocol: 'https', url: `https://upos.example.com/${id}.m4s`, http_headers: REF, ...extra });

function bilibiliInfo() {
  const av1 = fmt('30080', { vcodec: 'av01.0.08M.08', acodec: 'none', width: 1920, height: 1080, tbr: 900 });
  const hevc = fmt('30077', { vcodec: 'hev1.1.6.L120.90', acodec: 'none', width: 1920, height: 1080, tbr: 1100 });
  const avc1080 = fmt('30081', { vcodec: 'avc1.640032', acodec: 'none', width: 1920, height: 1080, tbr: 2400 });
  const avc4k = fmt('30120', { vcodec: 'avc1.640033', acodec: 'none', width: 3840, height: 2160, tbr: 9000 });
  const avc720 = fmt('30064', { vcodec: 'avc1.64001F', acodec: 'none', width: 1280, height: 720, tbr: 1200 });
  const aac = fmt('30280', { vcodec: 'none', acodec: 'mp4a.40.2', abr: 192 });
  const aacLow = fmt('30216', { vcodec: 'none', acodec: 'mp4a.40.2', abr: 64 });
  const flac = fmt('30251', { vcodec: 'none', acodec: 'flac', abr: 900 });
  return {
    title: 'B 站视频',
    duration: 300,
    extractor_key: 'BiliBili',
    http_headers: REF,
    formats: [av1, hevc, avc1080, avc4k, avc720, aac, aacLow, flac],
    // yt-dlp 默认挑的：AV1 + FLAC —— 很多手机解不动
    requested_formats: [av1, flac],
  };
}

test('挑给手机的一对：视频优先 H.264 且不超过 1080p（不挑 AV1、不挑 4K），音频优先 AAC；每条带自己的请求头', () => {
  const pair = linkMedia.splitPlaybackFromInfo(bilibiliInfo());
  assert.equal(pair.video.url, 'https://upos.example.com/30081.m4s');
  assert.equal(pair.audio.url, 'https://upos.example.com/30280.m4s');
  assert.equal(pair.video.headers.referer, REF.Referer, 'B 站的 CDN 不带 Referer 就 403');
  assert.equal(pair.audio.headers['user-agent'], 'UA');
});

test('没有 H.264 就挑 H.265；都没有、也没有 AAC 时用 yt-dlp 选中的那一对；分段式的（m3u8）不要', () => {
  const info = bilibiliInfo();
  info.formats = info.formats.filter((f) => !/^avc1/.test(f.vcodec));
  assert.equal(linkMedia.splitPlaybackFromInfo(info).video.url, 'https://upos.example.com/30077.m4s');
  const bare = bilibiliInfo();
  bare.formats = [];
  const fallback = linkMedia.splitPlaybackFromInfo(bare);
  assert.equal(fallback.video.url, 'https://upos.example.com/30080.m4s');
  assert.equal(fallback.audio.url, 'https://upos.example.com/30251.m4s');
  // 格式自己没带请求头的，用顶层的
  const noHeaders = bilibiliInfo();
  noHeaders.formats = noHeaders.formats.map(({ http_headers, ...f }) => f);
  assert.equal(linkMedia.splitPlaybackFromInfo(noHeaders).video.headers.referer, REF.Referer);
  const hls = bilibiliInfo();
  hls.formats = hls.formats.map((f) => ({ ...f, protocol: 'm3u8_native' }));
  hls.requested_formats = hls.requested_formats.map((f) => ({ ...f, protocol: 'm3u8_native' }));
  assert.equal(linkMedia.splitPlaybackFromInfo(hls), null);
});

test('主进程：一对直链两条都照同样的规矩查（公网地址、请求头白名单），不过关整对不给', () => {
  // 解析结果里带不带 splitPlayback 见 linkMedia.test.js 的 B 站那条（经 inspectLink 整条跑）
  const main = read('src', 'main', 'main.js');
  assert.match(main, /for \(const key of \['video', 'audio'\]\) \{\n\s+const track = result\.splitPlayback\[key\];\n\s+track\.url = await validate\.publicHttpUrl\(track\.url, '播放地址'\);\n\s+track\.headers = validate\.mediaHeaders\(track\.headers\);/);
  assert.match(main, /\} catch \{\n\s+delete result\.splitPlayback;/);
});

test('房主发给成员的播放地址：没有 playback 时带上 split（只留地址和请求头）', () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fnSource('nowLinkOf'), ctx);
  const info = { playback: null, splitPlayback: { video: { url: 'https://v/1', headers: { referer: 'r' }, protocol: 'https' }, audio: { url: 'https://a/1', headers: {} } } };
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.nowLinkOf(3, info, 99))), {
    seq: 3,
    playback: null,
    split: { video: { url: 'https://v/1', headers: { referer: 'r' } }, audio: { url: 'https://a/1', headers: {} } },
    resolvedAt: 99,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.nowLinkOf(3, { playback: { url: 'https://p' } }, 1))), { seq: 3, playback: { url: 'https://p' }, resolvedAt: 1 });
  // 四处发 now-link 的地方都经它
  assert.equal((APP.match(/nowLinkOf\(/g) || []).length, 5, '定义一处 + 四处调用');
});

test('安卓原生层：两条轨道各自按整个文件读、各带各的请求头，MergingMediaSource 合成一路', () => {
  const player = read('android', 'app', 'src', 'main', 'java', 'com', 'syncwatch', 'app', 'SyncPlayer.kt');
  assert.match(player, /import com\.google\.android\.exoplayer2\.source\.MergingMediaSource/);
  assert.match(player, /ProgressiveMediaSource\.Factory\(PublicHttpDataSource\.Factory\(videoHeaders\)\)/);
  assert.match(player, /ProgressiveMediaSource\.Factory\(PublicHttpDataSource\.Factory\(audioHeaders\)\)/);
  assert.match(player, /replacePlayer\(MergingMediaSource\(true, true, video, audio\), generation\)/);
  const shim = read('android', 'app', 'src', 'main', 'assets', 'js', 'native-shim.js');
  assert.match(shim, /Native\.playerLoadSplit\(videoUrl, JSON\.stringify\(videoHeaders\), audioUrl, JSON\.stringify\(audioHeaders\)\)/);
});
