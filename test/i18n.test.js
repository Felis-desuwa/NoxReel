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
  assert.equal(translate('重新生成应答链接', 'en'), 'Generate a new answer link');
  assert.equal(
    translate('Alice 的信令连接断了，但直连还在，传输继续', 'en'),
    'Alice lost the signaling connection, but the direct connection is still up and the transfer continues'
  );
  assert.equal(translate('直连没建立起来', 'en'), 'The direct connection failed');
  assert.equal(
    translate('这条邀请已经用过或已失效，请用当前这条邀请链接重新走一遍。', 'en'),
    'That invite was already used or has expired. Start again with the current invite link.'
  );
  assert.equal(translate('设置', 'zh-CN'), '设置');
});

test('无损精简与传输诊断的新文案都有英文', async () => {
  const { translate } = await import('../src/renderer/lib/i18n.js');
  assert.equal(translate('这一场要传哪个版本', 'en'), 'Which version to share');
  assert.equal(translate('无损精简（推荐）', 'en'), 'Lossless slim-down (recommended)');
  assert.equal(translate('仅转封装（保留全部轨道）', 'en'), 'Remux only (keep every track)');
  assert.equal(translate('原样传输', 'en'), 'Share as is');
  assert.equal(translate('优化传输体积（按需）', 'en'), 'Optimize transfer size (when needed)');
  assert.equal(translate('所需码率', 'en'), 'Required rate');
  // 中文不需要空格，英文需要 —— 这里丢了空格会渲染成「track iscopied over」
  assert.equal(translate('，保留下来的轨', 'en'), ', and every kept track is ');
  assert.equal(translate('速度充足，可稳定边下边播', 'en'), 'Fast enough for steady progressive playback');
  assert.equal(translate('已精简到：C:/tmp/film.slim.mkv', 'en'), 'Slimmed to: C:/tmp/film.slim.mkv');
  // 轨道数量是动态的，单复数得跟着变
  assert.equal(translate('1 条多余音轨', 'en'), '1 extra audio track');
  assert.equal(translate('2 条多余音轨', 'en'), '2 extra audio tracks');
  assert.equal(translate('1 条图形字幕', 'en'), '1 image-based subtitle track');
  assert.equal(translate('3 条图形字幕', 'en'), '3 image-based subtitle tracks');
  assert.equal(
    translate('这个文件没有可靠的每轨码率，省下多少估不出来', 'en'),
    'This file has no reliable per-track bitrates, so the saving cannot be estimated.'
  );
  assert.equal(translate('这一场要传哪个版本', 'zh-CN'), '这一场要传哪个版本');
});

test('扫描器不可用的提示有英文，且拼接后不会出现双句点', async () => {
  const { translate } = await import('../src/renderer/lib/i18n.js');
  const base = 'Microsoft Defender 没能完成扫描，本机可能已把它关闭或交给第三方杀毒软件接管';
  assert.equal(translate('安全扫描发现威胁', 'en'), 'The security scan found a threat');
  assert.match(translate(base, 'en'), /^Microsoft Defender could not finish the scan\./);

  const trusted = translate(`${base}。可信房间不因此中断播放，但这份文件始终没有经过本机扫描 —— 请自行确认片源可信。`, 'en');
  assert.match(trusted, /software\. The trusted room keeps playing/, '前半句的句号要削掉，别拼成 software..');
  assert.doesNotMatch(trusted, /\.\./);

  const safe = translate(`已阻止打开接收文件：${base}。安全模式必须扫过才放行；你可以启用 Microsoft Defender，或改用可信房间（风险自负）。`, 'en');
  assert.match(safe, /^Blocked the received file: /);
  assert.match(safe, /Safe mode plays a file only after it is scanned/);
  assert.doesNotMatch(safe, /\.\./);
});

test('Android 观众端提供相同的中英语言入口', async () => {
  const { translate } = await import('../android/app/src/main/assets/js/i18n.js');
  assert.equal(translate('界面语言', 'en'), 'Interface language');
  assert.equal(
    translate('Alice 的信令连接断了，但直连还在，传输继续', 'en'),
    'Alice lost the signaling connection, but the direct connection is still up and the transfer continues'
  );
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
