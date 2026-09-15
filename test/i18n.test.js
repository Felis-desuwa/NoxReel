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
  // 加入方的定时兜底文案要几分钟后才出现，靠 MutationObserver 翻译，同样得有英文。
  assert.equal(translate('还没能连上房主', 'en'), 'Still not connected to the host');
  assert.match(
    translate(
      '等了几分钟还是没连上。如果你已经把应答链接发回给房主了，那多半是打洞没成功：双方都在严格 NAT 后面时，需要各自在设置里配同一个 TURN 中继。如果房主还没打开你的应答链接，就重新生成一条再发一次 —— 链接放太久，里面的网络地址会过期。',
      'en'
    ),
    /^Still no connection after several minutes\..*TURN relay configured in Settings\./s
  );
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
  assert.equal(translate('文件码率', 'en'), 'File bitrate');
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
  // 极简加入的两条兜底日志同样是用户可见文案。
  assert.match(
    translate('等了几分钟还是没连上房主。应答链接已经发回去的话多半是打洞没成功，双方都要配同一个 TURN 中继；房主还没打开的话，就重新粘一次邀请码生成新的应答链接。', 'en'),
    /^Still not connected to the host after several minutes\..*TURN relay/s
  );
  assert.match(
    translate('和房主的直连没建立起来。重新粘一次房主的邀请码生成新的应答链接；双方都在严格 NAT 后面时需要各自配同一个 TURN 中继。', 'en'),
    /^The direct connection to the host was never established\./
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

/**
 * 卡顿预判的文案大多带着动态数字（码率、人数、时长），查表命中不了，全靠模式翻译。
 * 模式写错一个标点，整句就原样漏出中文 —— 所以每一种动态句式都要实际跑一遍。
 */
test('卡顿预判与不限文件大小的新文案都有英文', async () => {
  const { translate } = await import('../src/renderer/lib/i18n.js');
  const fixed = {
    '不限文件大小 · 只支持你自己合法拥有的内容': 'No file size limit · Only share content you are legally allowed to use',
    '当前速度': 'Current speed',
    '房主上行（预估）': 'Host uplink (estimated)',
    '上行带宽（预估）': 'Uplink bandwidth (estimated)',
    '当前上传': 'Current upload',
    '按码率最多流畅供': 'Smoothly serves at most',
    '还能流畅播': 'Smooth playback left',
    '正在测速…': 'Measuring speed…',
    '片源': 'Source',
    '流畅': 'Smooth',
    '这个片子可能会让成员卡顿': 'This video may stall for members',
    '仍然继续': 'Continue anyway',
  };
  for (const [zh, en] of Object.entries(fixed)) assert.equal(translate(zh, 'en'), en);

  assert.equal(
    translate('持有 42% · 延迟 31ms · 收片 12 Mbps', 'en'),
    'Has 42% · Latency 31ms · Receiving 12 Mbps'
  );
  assert.equal(translate('按现在的速度约 3:20 后会卡', 'en'), 'Will stall in about 3:20 at the current speed');
  assert.equal(translate('收完才播 · 预计还需 1:02:03', 'en'), 'Plays after full receipt · about 1:02:03 left');
  assert.equal(translate('2 人按现在的速度会卡', 'en'), '2 viewer(s) will stall at the current speed');
  assert.equal(translate('1 人余量很薄', 'en'), '1 viewer(s) have a thin margin');
  assert.equal(translate('5 人', 'en'), '5 viewer(s)');
  assert.equal(
    translate('67 Mbps（人数上限 4 人，除你之外 3 人同时接收）', 'en'),
    '67 Mbps (capacity 4; 3 viewer(s) besides you receiving at once)'
  );
  for (const line of [
    '取消后重新选这个文件，改选「无损精简」，能降低一些码率',
    '在邀请区调小房间人数上限',
    '在设置里调小新房间的默认人数上限',
    '改用安全模式开房：成员收完再播，不会中途卡顿，只是要等',
    '也可以直接继续：成员缓冲不够时会自动暂停，攒够了再接着播',
  ]) {
    assert.notEqual(translate(line, 'en'), line, `建议缺英文：${line}`);
  }
  assert.equal(
    translate('按这个码率，你的上行最多能同时供 4 人流畅边下边播。', 'en'),
    'At this bitrate, your uplink can smoothly serve at most 4 viewer(s) at once.'
  );
  assert.equal(
    translate('上行带宽没测出来，跳过卡顿预判：测速超过 15 秒', 'en'),
    'Could not measure uplink bandwidth; skipping the stall check: 测速超过 15 秒'
  );
  assert.equal(
    translate('没法接收这部片子：磁盘空间不够：这部片子需要 48.20GB，缓存所在的磁盘只剩 12.03GB', 'en'),
    'Cannot receive this video: not enough disk space. It needs 48.20 GB, but the cache disk has only 12.03 GB free'
  );
  // 旧的上限提示已经删掉，不能还留着一条永远命不中的死翻译。
  assert.equal(translate('文件超过 10GB 上限（当前 12.00GB）', 'en'), '文件超过 10GB 上限（当前 12.00GB）');

  const android = await import('../android/app/src/main/assets/js/i18n.js');
  assert.equal(
    android.translate('打开接收会话失败：磁盘空间不够：这部片子需要 48.20GB，手机只剩 12.03GB', 'en'),
    'Could not open the receive session: not enough storage. This video needs 48.20 GB, but the phone has only 12.03 GB free'
  );
});
