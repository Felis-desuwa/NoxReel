'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('桌面端和 Android 新安装默认可信房间与零服务器连接', () => {
  const desktop = read('src/renderer/app.js');
  const android = read('android/app/src/main/assets/js/app-android.js');
  const androidPage = read('android/app/src/main/assets/index.html');
  assert.match(desktop, /localStorage\.getItem\('sw\.securityMode'\) === 'safe' \? 'safe' : 'trusted'/);
  assert.match(desktop, /inviteViaManual\(\)\.catch/);
  assert.match(android, /localStorage\.getItem\('sw\.securityMode'\) === 'safe' \? 'safe' : 'trusted'/);
  assert.match(androidPage, /id="tab-manual" class="on"/);
  assert.match(androidPage, /value="trusted" selected/);
});

test('Windows 安装包和 Android 都声明 noxreel 邀请链接协议', () => {
  const pkg = JSON.parse(read('package.json'));
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  assert.deepEqual(pkg.build.protocols[0].schemes, ['noxreel']);
  assert.match(manifest, /android:scheme="noxreel"/);
  assert.match(read('src/main/main.js'), /setAsDefaultProtocolClient\('noxreel'/);
  assert.match(read('src/main/preload.js'), /app:deepLink/);
});

test('Windows 完整版和联网版安装器都允许选择安装目录', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const installer of [pkg.build.nsis, pkg.build.nsisWeb]) {
    assert.equal(installer.oneClick, false);
    assert.equal(installer.allowToChangeInstallationDirectory, true);
  }
});
