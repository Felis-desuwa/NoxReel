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

test('媒体清单严格限制分片结构，但不再限制文件大小', () => {
  assert.equal(validate.manifest(validManifest()).chunkCount, 1);

  // 这条以前断言「10GB + 1 字节会被拒」，可它造的清单分片数还是 1，真正拒绝它的是
  // 分片数一致性检查 —— 上限去掉以后它照样能过，等于在空跑。改成造一个结构完全
  // 合法的 12GB 清单：能拒绝它的只可能是大小上限，所以它能通过才证明上限真的没了。
  const big = 12 * 1024 ** 3;
  const chunks = Math.ceil(big / CHUNK_SIZE);
  const large = { ...validManifest(), size: big, chunkCount: chunks, hashes: Array(chunks).fill('b'.repeat(64)) };
  assert.equal(validate.manifest(large).chunkCount, chunks);

  // 去掉上限不等于去掉一致性检查：大小和分片数对不上照样拒绝。
  assert.throws(() => validate.manifest({ ...validManifest(), size: CHUNK_SIZE * 3 }), /无效/);
  // 超过 2^53 连字节偏移都算不准，这是唯一保留的数值边界。
  assert.throws(() => validate.manifest({ ...validManifest(), size: Number.MAX_SAFE_INTEGER + 2 }), /无效/);

  // 房主上行是可选的诊断字段，只接受非负有限数。
  assert.equal(validate.manifest({ ...validManifest(), uplinkBps: 3_000_000 }).uplinkBps, 3_000_000);
  assert.throws(() => validate.manifest({ ...validManifest(), uplinkBps: -1 }), /无效/);
  assert.throws(() => validate.manifest({ ...validManifest(), uplinkBps: 'fast' }), /无效/);

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
