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

test('解析的格式串和下载同一个，最后带 /b：直链 mp4 报不出编码时也选得中，不必每次退到隔离浏览器', () => {
  const { MUXED_FORMAT } = require('../src/main/linkMedia');
  const { FORMAT } = require('../src/main/linkCache');
  const args = ytDlpArgs('https://cdn.example/a.mp4', null, 'http://u:p@127.0.0.1:9');
  assert.equal(args[args.indexOf('--format') + 1], MUXED_FORMAT);
  assert.equal(FORMAT, MUXED_FORMAT, '解析和下载别再分叉');
  assert.match(MUXED_FORMAT, /\/b$/);
  // 前面几项照旧优先音画合一的 HTTP / HLS
  assert.ok(MUXED_FORMAT.startsWith('best[protocol^=http][vcodec!=none][acodec!=none]/best[protocol^=m3u8]'));
  assert.deepEqual(args.slice(-2), ['--', 'https://cdn.example/a.mp4']);
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
