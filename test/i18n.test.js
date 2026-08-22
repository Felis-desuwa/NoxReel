'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('桌面端固定文案和动态状态可翻译为英文', async () => {
  const { translate } = await import('../src/renderer/lib/i18n.js');
  assert.equal(translate('设置', 'en'), 'Settings');
  assert.equal(translate('可信房间（边下边播，风险较高）', 'en'), 'Trusted room (progressive playback, higher risk)');
  assert.equal(translate('Alice 加入了房间', 'en'), 'Alice joined the room');
  assert.equal(translate('Alice 播放 @ 1:23', 'en'), 'Alice played @ 1:23');
  assert.equal(translate('已复制完整 128 字符 ✓', 'en'), 'Copied all 128 characters ✓');
  assert.equal(
    translate('本机解析失败，改用房主提供的临时播放地址：站点暂时不可用', 'en'),
    "Local parsing failed; using the host's temporary stream URL: 站点暂时不可用"
  );
  assert.equal(
    translate('已阻止打开接收文件：安全扫描超时', 'en'),
    'Blocked the received file: The security scan timed out'
  );
  assert.equal(translate('设置', 'zh-CN'), '设置');
});

test('Android 观众端提供相同的中英语言入口', async () => {
  const { translate } = await import('../android/app/src/main/assets/js/i18n.js');
  assert.equal(translate('界面语言', 'en'), 'Interface language');
  assert.equal(translate('2 人在线', 'en'), '2 online');
  assert.equal(translate('安全模式', 'en'), 'Safe mode');
  assert.equal(
    translate('房主请求手机连接 https://cdn.example 播放在线视频。是否允许？', 'en'),
    'The host wants your phone to connect to https://cdn.example for online playback. Allow it?'
  );
  assert.equal(translate('电影 · 安全模式 · 在线', 'en'), '电影 · Safe mode · Online');
  assert.equal(
    translate('邀请码无效：这不像是一个 NoxReel 邀请码', 'en'),
    'Invalid invite code: This does not look like a NoxReel invite code'
  );

  const html = fs.readFileSync(
    path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'index.html'),
    'utf8'
  );
  assert.match(html, /id="language"/);
  assert.match(html, /value="zh-CN"/);
  assert.match(html, /value="en"/);
});

test('中英文 README 互相提供语言入口', () => {
  const root = path.join(__dirname, '..');
  const chinese = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const english = fs.readFileSync(path.join(root, 'README.en.md'), 'utf8');
  assert.match(chinese, /href="README\.en\.md">English/);
  assert.match(english, /href="README\.md">简体中文/);
  assert.match(english, /## Quick start/);
  assert.match(english, /## Security notice and disclaimer/);
});
