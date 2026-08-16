'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const validate = require('../src/main/security');
const mediaGuard = require('../src/main/mediaGuard');
const { CHUNK_SIZE } = require('../src/main/fileStore');

function validManifest() {
  return {
    fileId: 'a'.repeat(32),
    name: 'movie.mkv',
    size: CHUNK_SIZE,
    chunkSize: CHUNK_SIZE,
    chunkCount: 1,
    hashes: ['b'.repeat(64)],
    roomRevision: 1,
  };
}

test('外部链接只允许无凭据的 HTTP(S) URL', () => {
  assert.equal(validate.externalUrl('https://example.com/video?q=1'), 'https://example.com/video?q=1');
  assert.throws(() => validate.externalUrl('javascript:alert(1)'), /无效/);
  assert.throws(() => validate.externalUrl('file:///C:/Windows/System32/calc.exe'), /无效/);
  assert.throws(() => validate.externalUrl('https://user:pass@example.com/'), /无效/);
});

test('媒体链接拒绝本机和私有网络地址', async () => {
  await assert.rejects(validate.publicHttpUrl('http://127.0.0.1/video.mp4'), /无效/);
  await assert.rejects(validate.publicHttpUrl('http://10.0.0.8/video.mp4'), /无效/);
  await assert.rejects(validate.publicHttpUrl('http://[::1]/video.mp4'), /无效/);
  await assert.rejects(validate.publicHttpUrl('http://[::ffff:7f00:1]/video.mp4'), /无效/);
  await assert.rejects(validate.publicHttpUrl('http://localhost/video.mp4'), /无效/);
});

test('文件路径必须是绝对路径且不能含 NUL', () => {
  assert.equal(validate.absolutePath(path.resolve('movie.mkv')), path.resolve('movie.mkv'));
  assert.throws(() => validate.absolutePath('movie.mkv'), /无效/);
  assert.throws(() => validate.absolutePath(`${path.resolve('movie.mkv')}\0bad`), /无效/);
});

test('媒体清单严格限制分片结构和 10GB 边界', () => {
  assert.equal(validate.manifest(validManifest()).chunkCount, 1);
  assert.throws(() => validate.manifest({ ...validManifest(), size: 10 * 1024 ** 3 + 1 }), /无效/);
  assert.throws(() => validate.manifest({ ...validManifest(), chunkCount: 2 }), /无效/);
  assert.throws(() => validate.manifest({ ...validManifest(), hashes: ['not-a-hash'] }), /无效/);
  assert.throws(() => validate.manifest({ ...validManifest(), name: 'payload.exe' }), /只允许接收/);
  assert.throws(() => validate.manifest({ ...validManifest(), name: '..\\movie.mkv' }), /无效/);
});

test('IPC 数值和分片数据拒绝越界输入', () => {
  assert.equal(validate.integer(0, '分片下标', { min: 0 }), 0);
  assert.throws(() => validate.integer(-1, '分片下标', { min: 0 }), /无效/);
  assert.throws(() => validate.finiteNumber(Number.NaN, '播放位置'), /无效/);
  assert.equal(validate.binary(new ArrayBuffer(CHUNK_SIZE)).byteLength, CHUNK_SIZE);
  assert.throws(() => validate.binary(new ArrayBuffer(CHUNK_SIZE + 1)), /无效/);
});

test('媒体文件头必须与允许的容器类型一致', () => {
  const mp4 = Buffer.alloc(32);
  mp4.writeUInt32BE(24, 0);
  mp4.write('ftyp', 4, 'ascii');
  mp4.write('isom', 8, 'ascii');
  assert.equal(mediaGuard.validateMediaHeader('movie.mp4', mp4).ok, true);

  const mkv = Buffer.alloc(32);
  mkv.writeUInt32BE(0x1a45dfa3, 0);
  assert.equal(mediaGuard.validateMediaHeader('movie.mkv', mkv).ok, true);

  const exe = Buffer.alloc(32);
  exe.write('MZ', 0, 'ascii');
  assert.equal(mediaGuard.validateMediaHeader('movie.mp4', exe).ok, false);
});

test('Electron 安全配置和 DOM 渲染模式不会退化', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  const mpv = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'mpv.js'), 'utf8');
  const fileStore = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'fileStore.js'), 'utf8');

  assert.match(main, /app\.enableSandbox\(\)/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /titleBarStyle:\s*'hidden'/);
  assert.match(main, /titleBarOverlay/);
  assert.match(main, /will-navigate/);
  assert.doesNotMatch(preload, /\bclipboard\s*,\s*contextBridge/);
  assert.doesNotMatch(renderer, /(?:inner|outer)HTML|insertAdjacentHTML|Math\.random/);
  assert.doesNotMatch(mpv, /Math\.random/);
  assert.match(mpv, /randomBytes\(16\)/);
  assert.match(mpv, /--cache-on-disk=no/);
  assert.match(mpv, /--no-config/);
  assert.match(mpv, /--load-scripts=no/);
  assert.match(main, /disable-http-cache/);
  assert.match(main, /requireAllowedLocalPath/);
  assert.match(main, /publicHttpUrl/);
  assert.doesNotMatch(fileStore, /\.swpart|tryResume|PART_SUFFIX/);
});
