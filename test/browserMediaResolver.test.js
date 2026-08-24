'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { candidateScore, isBlockedLiteral } = require('../src/main/browserMediaResolver');

test('隔离浏览器优先选择播放清单而不是媒体分片', () => {
  assert.equal(candidateScore('https://cdn.example/master.m3u8'), 100);
  assert.equal(candidateScore('https://cdn.example/manifest.mpd'), 90);
  assert.equal(candidateScore('https://cdn.example/video.mp4'), 80);
  assert.equal(candidateScore('https://cdn.example/segment-1.ts'), 0);
});

test('隔离浏览器阻止显式本机和私有网络 URL', () => {
  assert.equal(isBlockedLiteral('http://127.0.0.1/video.mp4'), true);
  assert.equal(isBlockedLiteral('http://192.168.1.2/video.mp4'), true);
  assert.equal(isBlockedLiteral('http://[::1]/video.mp4'), true);
  assert.equal(isBlockedLiteral('https://cdn.example/video.mp4'), false);
});
