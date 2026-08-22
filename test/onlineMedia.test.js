'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sanitizePlaybackHeaders, playbackFromInfo } = require('../src/main/linkMedia');
const { buildLaunchArgs } = require('../src/main/mpv');
const validate = require('../src/main/security');

test('网页解析结果只携带播放所需的非敏感请求头', () => {
  const safe = sanitizePlaybackHeaders({
    'User-Agent': 'NoxReel test',
    Referer: 'https://video.example/watch/1',
    Cookie: 'session=secret',
    Authorization: 'Bearer secret',
    Origin: 'https://video.example\r\nX-Evil: yes',
  });
  assert.deepEqual(safe, {
    'user-agent': 'NoxReel test',
    referer: 'https://video.example/watch/1',
  });
  assert.throws(() => validate.mediaHeaders({ cookie: 'secret' }), /无效/);
  assert.throws(() => validate.mediaHeaders({ referer: 'ok\r\nbad' }), /无效/);
});

test('网页解析信息可生成供 Android 使用的临时播放描述', () => {
  assert.deepEqual(
    playbackFromInfo(
      {
        url: 'https://cdn.example/video/master.m3u8?token=short-lived',
        protocol: 'm3u8_native',
        http_headers: { Referer: 'https://video.example/' },
      },
      null
    ),
    {
      url: 'https://cdn.example/video/master.m3u8?token=short-lived',
      headers: { referer: 'https://video.example/' },
      protocol: 'm3u8_native',
    }
  );
});

test('mpv 启动参数启用现代 OSC 且继续禁止磁盘缓存与用户脚本', () => {
  const args = buildLaunchArgs({
    ipcPath: '\\\\.\\pipe\\test',
    source: 'https://cdn.example/video.mp4',
    ytDlp: 'C:\\bin\\yt-dlp.exe',
    headers: { referer: 'https://video.example/' },
  });
  assert.ok(args.includes('--no-config'));
  assert.ok(args.includes('--load-scripts=no'));
  assert.ok(args.includes('--cache-on-disk=no'));
  assert.ok(args.includes('--osc=yes'));
  assert.ok(args.includes('--script-opt=osc-layout=bottombar'));
  assert.ok(args.includes('--script-opt=osc-windowcontrols=yes'));
  assert.ok(args.includes('--http-header-fields-append=referer: https://video.example/'));
  assert.equal(args.at(-1), 'https://cdn.example/video.mp4');
});

test('Android 观众端识别房主的视频链接消息并交给原生播放器', () => {
  const root = path.join(__dirname, '..');
  const app = fs.readFileSync(path.join(root, 'android/app/src/main/assets/js/app-android.js'), 'utf8');
  const bridge = fs.readFileSync(
    path.join(root, 'android/app/src/main/java/com/syncwatch/app/NativeBridge.kt'),
    'utf8'
  );
  const player = fs.readFileSync(
    path.join(root, 'android/app/src/main/java/com/syncwatch/app/SyncPlayer.kt'),
    'utf8'
  );
  assert.match(app, /MSG\.MEDIA_LINK/);
  assert.match(app, /window\.swPlayer\.loadUrl/);
  assert.match(bridge, /fun playerLoadUrl/);
  assert.match(bridge, /requirePublicHttpUrl/);
  assert.match(player, /DefaultMediaSourceFactory/);
});
