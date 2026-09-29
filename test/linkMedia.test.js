'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeHttpUrl, looksLikeDirectMedia, isYouTubeUrl, ytDlpArgs } = require('../src/main/linkMedia');

test('normalizeHttpUrl 只接受 http(s)', () => {
  assert.equal(normalizeHttpUrl(' https://example.com/watch?v=1 '), 'https://example.com/watch?v=1');
  assert.throws(() => normalizeHttpUrl('file:///C:/video.mp4'), /只支持/);
  assert.throws(() => normalizeHttpUrl('javascript:alert(1)'), /只支持/);
  assert.throws(() => normalizeHttpUrl('https://user:pass@example.com/a.mp4'), /用户名或密码/);
});

test('YouTube 使用仍可匿名返回普通格式的专用客户端回退', () => {
  assert.equal(isYouTubeUrl('https://youtu.be/dQw4w9WgXcQ'), true);
  assert.equal(isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true);
  assert.equal(isYouTubeUrl('https://example.com/youtube.com'), false);
  const args = ytDlpArgs('https://youtu.be/test', 'youtube:player_client=android_vr');
  assert.ok(args.includes('youtube:player_client=android_vr'));
  assert.equal(args.at(-1), 'https://youtu.be/test');
});

test('looksLikeDirectMedia 识别常见直链与流媒体清单', () => {
  assert.equal(looksLikeDirectMedia('https://cdn.example/a.mp4?token=x'), true);
  assert.equal(looksLikeDirectMedia('https://cdn.example/live/master.m3u8'), true);
  assert.equal(looksLikeDirectMedia('https://example.com/watch?v=1'), false);
});

test('解析和下载的格式串：音画合一优先、最后带 /b（直链 mp4 报不出编码时也选得中），解析时后面再接分开的两条流', () => {
  const { MUXED_FORMAT, SPLIT_FORMAT, PARSE_FORMAT } = require('../src/main/linkMedia');
  const { FORMAT, MERGE_FORMAT } = require('../src/main/linkCache');
  const args = ytDlpArgs('https://cdn.example/a.mp4', null, 'http://u:p@127.0.0.1:9');
  assert.equal(args[args.indexOf('--format') + 1], PARSE_FORMAT);
  assert.equal(PARSE_FORMAT, `${MUXED_FORMAT}/${SPLIT_FORMAT}`, '一次 yt-dlp 里按顺序回退，不用失败了再跑一次');
  assert.equal(SPLIT_FORMAT, 'bv*+ba/b');
  assert.equal(FORMAT, MUXED_FORMAT, '没有 ffmpeg 时下载只要音画合一的');
  assert.equal(MERGE_FORMAT, PARSE_FORMAT, '有 ffmpeg 时下载和解析同一串，别再分叉');
  assert.match(MUXED_FORMAT, /\/b$/);
  // 前面几项照旧优先音画合一的 HTTP / HLS
  assert.ok(MUXED_FORMAT.startsWith('best[protocol^=http][vcodec!=none][acodec!=none]/best[protocol^=m3u8]'));
  assert.deepEqual(args.slice(-2), ['--', 'https://cdn.example/a.mp4']);
});

/** 假的 runJson：只给分开的两条流的网站（B 站全站如此，实测），选中的是 bv*+ba：顶层没有 url。 */
function splitOnlySite(calls) {
  return async (bin, args) => {
    calls.push({
      format: args[args.indexOf('--format') + 1],
      extractorArgs: args.includes('--extractor-args') ? args[args.indexOf('--extractor-args') + 1] : null,
    });
    return {
      title: '『FX战士久留美』第1话',
      duration: 1638.4,
      extractor_key: 'BiliBili',
      http_headers: { Referer: 'https://www.bilibili.com/' },
      requested_formats: [
        { format_id: '100026', url: 'https://upos.bilivideo.com/v.m4s', vcodec: 'av01', acodec: 'none' },
        { format_id: '30280', url: 'https://upos.bilivideo.com/a.m4s', vcodec: 'none', acodec: 'mp4a.40.2' },
      ],
    };
  };
}

test('只给分开音视频流的网站（B 站）：一次解析就拿到标题时长，交给 mpv 自己合；没声音的视频流不当播放地址', async () => {
  const { inspectLink, PARSE_FORMAT } = require('../src/main/linkMedia');
  const calls = [];
  let browser = 0;
  const info = await inspectLink('https://www.bilibili.com/video/BV1XPaY6hEes/', {
    ytDlp: 'yt-dlp.exe',
    runJsonImpl: splitOnlySite(calls),
    redirectCheck: async () => {},
    browserFallback: async () => {
      browser++;
      throw new Error('不该走到隔离浏览器');
    },
  });
  assert.deepEqual(calls, [{ format: PARSE_FORMAT, extractorArgs: null }], '只跑一次 yt-dlp');
  assert.equal(browser, 0);
  assert.equal(info.title, '『FX战士久留美』第1话');
  assert.equal(info.duration, 1638.4);
  assert.equal(info.url, 'https://www.bilibili.com/video/BV1XPaY6hEes/', '桌面端交给 mpv 的还是网页地址');
  assert.equal(info.playback, null, '没有一条能单独播放的地址：不能把没声音的视频流当播放地址发给成员');
  assert.equal(info.split, true);
  // 给安卓成员的一对直链（ExoPlayer 自己合），带上顶层的请求头（格式自己没带）
  assert.equal(info.splitPlayback.video.url, 'https://upos.bilivideo.com/v.m4s');
  assert.equal(info.splitPlayback.audio.url, 'https://upos.bilivideo.com/a.m4s');
  assert.equal(info.splitPlayback.video.headers.referer, 'https://www.bilibili.com/');
});

test('音画合一的照旧给出播放地址、不标 split；网站不认的照旧换解析方式，最后退到隔离浏览器', async () => {
  const { inspectLink, PARSE_FORMAT } = require('../src/main/linkMedia');
  const muxed = await inspectLink('https://video.example/watch/1', {
    ytDlp: 'y',
    redirectCheck: async () => {},
    runJsonImpl: async () => ({ title: 't', url: 'https://cdn.example/v.mp4', protocol: 'https', http_headers: { Referer: 'https://video.example/' } }),
  });
  assert.equal(muxed.playback.url, 'https://cdn.example/v.mp4');
  assert.equal(muxed.playback.headers.referer, 'https://video.example/');
  assert.equal('split' in muxed, false);

  const calls = [];
  const unsupported = async (bin, args) => {
    calls.push([args[args.indexOf('--format') + 1], args.includes('--extractor-args') ? args[args.indexOf('--extractor-args') + 1] : null]);
    const detail = 'ERROR: Unsupported URL: https://x.example/';
    throw Object.assign(new Error(`无法解析这个视频链接：${detail}`), { code: 'YTDLP_FAILED', detail });
  };
  await assert.rejects(inspectLink('https://x.example/page', { ytDlp: 'y', runJsonImpl: unsupported, redirectCheck: async () => {} }), /Unsupported URL/);
  assert.deepEqual(calls, [
    [PARSE_FORMAT, null],
    [PARSE_FORMAT, 'generic:impersonate'],
  ]);
  const got = await inspectLink('https://x.example/page', {
    ytDlp: 'y',
    runJsonImpl: unsupported,
    redirectCheck: async () => {},
    browserFallback: async () => ({ title: '浏览器', playback: { url: 'https://cdn.example/v.mp4', headers: {} } }),
  });
  assert.equal(got.extractor, 'isolated-browser');
});

test('解析超时、输出过大时结束 yt-dlp 整棵进程树（它是两层进程，只杀引导进程的话子进程接着跑）', async () => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const { runJson } = require('../src/main/linkMedia');
  const spawned = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => assert.fail('不能只杀引导进程');
    spawned.push(child);
    return child;
  };
  const killed = [];
  const killTreeImpl = (child) => killed.push(child);

  await assert.rejects(runJson('yt-dlp', [], { spawnImpl, killTreeImpl, timeoutMs: 10 }), /超时/);
  assert.deepEqual(killed, [spawned[0]]);

  const big = runJson('yt-dlp', [], { spawnImpl, killTreeImpl, maxOutputBytes: 8 });
  spawned[1].stdout.write('0123456789');
  await assert.rejects(big, /过大/);
  assert.deepEqual(killed, [spawned[0], spawned[1]]);

  const ok = runJson('yt-dlp', [], { spawnImpl, killTreeImpl });
  spawned[2].stdout.end('{"title":"x"}');
  setImmediate(() => spawned[2].emit('close', 0));
  assert.deepEqual(await ok, { title: 'x' });
  assert.equal(killed.length, 2, '正常结束的不用结束');
});
