'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeHttpUrl, looksLikeDirectMedia } = require('../src/main/linkMedia');

test('normalizeHttpUrl 只接受 http(s)', () => {
  assert.equal(normalizeHttpUrl(' https://example.com/watch?v=1 '), 'https://example.com/watch?v=1');
  assert.throws(() => normalizeHttpUrl('file:///C:/video.mp4'), /只支持/);
  assert.throws(() => normalizeHttpUrl('javascript:alert(1)'), /只支持/);
  assert.throws(() => normalizeHttpUrl('https://user:pass@example.com/a.mp4'), /用户名或密码/);
});

test('looksLikeDirectMedia 识别常见直链与流媒体清单', () => {
  assert.equal(looksLikeDirectMedia('https://cdn.example/a.mp4?token=x'), true);
  assert.equal(looksLikeDirectMedia('https://cdn.example/live/master.m3u8'), true);
  assert.equal(looksLikeDirectMedia('https://example.com/watch?v=1'), false);
});
