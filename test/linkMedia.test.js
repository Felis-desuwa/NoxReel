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
