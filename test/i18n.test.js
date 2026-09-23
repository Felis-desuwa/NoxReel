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

test('中途加入（可信房间）的新文案都有英文', async () => {
  const { translate } = await import('../src/renderer/lib/i18n.js');
  const android = await import('../android/app/src/main/assets/js/i18n.js');
  assert.equal(
    translate('你是中途加入的，正在下载房间当前位置附近的内容', 'en'),
    'You joined mid-playback; downloading the part the room is at now.'
  );
  assert.equal(
    translate('正在优先获取索引（MKV 的索引常在文件尾）', 'en'),
    'Fetching the index first (MKV keeps it at the end of the file).'
  );
  assert.equal(
    translate('跳转到的位置还没收到，已暂停等缓冲', 'en'),
    'That position has not arrived yet; paused while it buffers.'
  );
  assert.equal(
    translate('播放到已接收内容的末尾，等后续分片', 'en'),
    'Reached the end of what has been received; waiting for more.'
  );
  assert.equal(
    translate('片源没提供时长，算不出房间播到哪；这一部要完整接收后才能播放', 'en'),
    "The source did not provide a duration, so the room's position cannot be calculated; this video will play only after it is fully received."
  );
  assert.equal(
    translate('片源没提供时长 · 完整接收后才播，还剩', 'en'),
    'No duration from the source · plays after full receipt, remaining'
  );
  assert.equal(
    android.translate('片源没提供时长，算不出房间播到哪；这一部要完整接收后才能播放', 'en'),
    "The source did not provide a duration, so the room's position cannot be calculated; this video will play only after it is fully received."
  );
  assert.equal(translate('从当前位置可连续播放', 'en'), 'Continuous playback from here');
  assert.equal(
    translate('距起播还差（当前位置附近）', 'en'),
    'Left before playback starts (around the current position)'
  );
  // 这两条是 stat(label, value) 的标签：值在另一个文本节点里，翻译只看标签本身
  // （整句拼起来反而查不到，别据此以为漏了英文）
  assert.equal(translate('距起播还差 12.0 MB', 'en'), '距起播还差 12.0 MB');
  // 手机端同样会中途加入
  assert.equal(
    android.translate('你是中途加入的，正在下载房间当前位置附近的内容', 'en'),
    'You joined mid-playback; downloading the part the room is at now.'
  );
  assert.equal(translate('你是中途加入的，正在下载房间当前位置附近的内容', 'zh-CN'), '你是中途加入的，正在下载房间当前位置附近的内容');
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
 * README 是 0.7 的唯一对外说明，而它最容易出的错不是写错、是漏写：
 * 中文写了「不互通」英文忘了写，读英文的人升级完才发现连不上。所以按「说法」逐条核对，
 * 两份 README 各自必须命中同一件事，缺一条就报出缺的是哪一条。
 */
test('两份 README 都讲全了 0.7 的关键说法', () => {
  const root = path.join(__dirname, '..');
  const chinese = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const english = fs.readFileSync(path.join(root, 'README.en.md'), 'utf8');

  // 每条：[这件事叫什么, 中文里的说法, 英文里的说法]
  const claims = [
    ['与 0.6.x 不互通', /不互通/, /cannot connect to 0\.6\.x|No interoperability with 0\.6\.x/],
    ['协议 v2', /协议\s*v2|协议升到 v2|协议(?:升级)?到 v2/, /protocol v2|protocol .*to v2/i],
    ['播放列表', /播放列表/, /\bplaylist\b/i],
    ['列表顺序就是传输顺序', /传输顺序/, /transfer order/i],
    ['谁能编辑列表', /管理员/, /moderators?/i],
    ['弹幕', /弹幕/, /danmaku/i],
    ['在播放器里发弹幕的快捷键', /Ctrl\+Shift\+D/, /Ctrl\+Shift\+D/],
    ['PotPlayer', /PotPlayer/, /PotPlayer/],
    ['MPC-BE', /MPC-BE/, /MPC-BE/],
    ['mpv 能边下边播', /mpv/, /\bmpv\b/],
    ['外部播放器只接手收完的文件', /只接手已收完的文件/, /[Ff]ully received files only|fully received files/],
    ['独占全屏下看不到弹幕', /独占全屏/, /exclusive fullscreen/i],
    ['中途加入不拖停全房', /中途加入/, /mid-playback/i],
    ['安卓能聊天看弹幕', /Android/, /Android/],
    ['安卓当管理员能编辑列表', /管理员后能编辑列表/, /moderator you can edit the playlist/i],
    ['安卓只当观众、不能开房', /只当观众/, /only joins as a viewer/i],
    ['安卓能用房间链接加入', /手机端也能用房间链接加入/, /Phones can join through room links/],
    ['APK 在 Releases 的 Assets 里', /app-debug\.apk/, /app-debug\.apk/],
  ];

  const missing = [];
  for (const [what, zh, en] of claims) {
    if (!zh.test(chinese)) missing.push(`README.md 少了「${what}」`);
    if (!en.test(english)) missing.push(`README.en.md 少了「${what}」`);
  }
  assert.deepEqual(missing, [], missing.join('；'));

  // 章节结构对应：中文有播放器支持表，英文也要有，不然英文读者看不到支持范围
  assert.match(chinese, /## 播放器支持/);
  assert.match(english, /## Player support/);
  assert.match(chinese, /## 下载/);
  assert.match(english, /## Downloads/);
});

/**
 * 版本号散在四处（package.json、两份 README 的徽章和下载链接、启动器、安卓）。
 * 只改一处的话，README 会把上一版的安装包链接一直挂着，点下去下到的还是旧版。
 */
test('两份 README 的版本号跟着 package.json 走', () => {
  const root = path.join(__dirname, '..');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const escaped = version.replace(/\./g, '\\.');

  for (const name of ['README.md', 'README.en.md']) {
    const text = fs.readFileSync(path.join(root, name), 'utf8');
    assert.match(text, new RegExp(`badge/version-${escaped}-`), `${name} 的版本徽章不是 ${version}`);
    assert.match(text, new RegExp(`NoxReel-Setup-${escaped}\\.exe`), `${name} 的完整版下载链接不是 ${version}`);
    assert.match(text, new RegExp(`NoxReel-WebSetup-${escaped}\\.exe`), `${name} 的联网版下载链接不是 ${version}`);
    // 上一版的链接留在文里，就等于把旧安装包继续推给用户
    const stale = text.match(/NoxReel-(?:Web)?Setup-(\d+\.\d+\.\d+)\.exe/g) || [];
    for (const hit of stale) {
      assert.ok(hit.includes(version), `${name} 里还留着旧版下载链接：${hit}`);
    }
  }
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
  assert.equal(
    translate('再缓冲 24:00 可一路看完，届时手上有 20:00 的画面', 'en'),
    'Buffer for another 24:00 to play through without stalling; you will then hold 20:00 of video'
  );
  // 成员列表这一句是拼出来的，前半段得再翻一道；没递归就会剩半句中文漏在英文界面上
  assert.equal(
    translate('按现在的速度约 3:20 后会卡 · 再缓冲 24:00 可看完', 'en'),
    'Will stall in about 3:20 at the current speed · buffer 24:00 more to play through'
  );
  assert.equal(
    translate('已经跟不上码率，会卡 · 再缓冲 1:12:30 可看完', 'en'),
    'Already behind the bitrate; will stall · buffer 1:12:30 more to play through'
  );
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
  // 0.7 起列表里可能同时有好几部，放不下时要说是哪一部；片名是用户内容，原样保留
  assert.equal(
    translate('没法接收《海边的卡夫卡》：磁盘空间不够：这部片子需要 48.20GB，缓存所在的磁盘只剩 12.03GB', 'en'),
    'Cannot receive “海边的卡夫卡”: not enough disk space. It needs 48.20 GB, but the cache disk has only 12.03 GB free'
  );
  assert.equal(
    translate('没法接收这部片子：磁盘空间不够：这部片子需要 48.20GB，缓存所在的磁盘只剩 12.03GB', 'en'),
    '没法接收这部片子：磁盘空间不够：这部片子需要 48.20GB，缓存所在的磁盘只剩 12.03GB',
    '旧写法已经不用了，不能留着一条死翻译'
  );
  // 旧的上限提示已经删掉，不能还留着一条永远命不中的死翻译。
  assert.equal(translate('文件超过 10GB 上限（当前 12.00GB）', 'en'), '文件超过 10GB 上限（当前 12.00GB）');

  const android = await import('../android/app/src/main/assets/js/i18n.js');
  assert.equal(
    android.translate('打开接收会话失败：磁盘空间不够：这部片子需要 48.20GB，手机只剩 12.03GB', 'en'),
    'Could not open the receive session: not enough storage. This video needs 48.20 GB, but the phone has only 12.03 GB free'
  );
});

test('播放列表与协议版本的新文案两端都有英文，片名和昵称原样保留', async () => {
  const { translate } = await import('../src/renderer/lib/i18n.js');
  const android = await import('../android/app/src/main/assets/js/i18n.js');
  for (const line of [
    '你没有编辑播放列表的权限',
    '没能加进播放列表',
    '和房主的连接断了',
    '房主没有回应',
    '列表里已经有这部片了',
    '收到一份格式不对的播放列表，已忽略',
    '播放列表已经放完了',
    '播放列表是空的',
    '改用房主提供的临时播放地址',
    '这个邀请来自旧版 NoxReel（0.6.x），和 0.7 不互通。请让房主升级到 0.7 后重新发邀请。',
    '这个邀请来自更新版本的 NoxReel，和本机不互通。请先升级本机的 NoxReel。',
    '对方是旧版 NoxReel（0.6.x），和 0.7 不互通。请让他升级到 0.7 再加入。',
    '对方用的是更新版本的 NoxReel，和本机不互通。请先升级本机的 NoxReel。',
  ]) {
    assert.notEqual(translate(line, 'en'), line, `桌面端缺英文：${line}`);
  }
  assert.equal(translate('现在放：播放', 'en'), 'Now playing: 播放');
  assert.equal(
    translate('还没拿到《暂停》的清单：没有人能提供这部片的清单', 'en'),
    'Still waiting for the manifest of “暂停”: Nobody can provide the manifest for this video'
  );
  assert.equal(
    translate('没拿到这部片的清单：没有人能提供这部片的清单', 'en'),
    'Could not get the manifest for this video: Nobody can provide the manifest for this video'
  );
  assert.equal(translate('Alice 给的媒体清单没通过校验，已换人再要', 'en'), 'The media manifest from Alice failed verification; asking someone else');
  assert.equal(translate('《海边》已全部接收', 'en'), '“海边” has been fully received');
  assert.equal(translate('切换到下一部失败：房间已关闭', 'en'), 'Could not switch to the next item: The room is closed');
  assert.equal(translate('已阻止接收文件：发现威胁', 'en'), 'Blocked receiving the file: 发现威胁');
  assert.equal(
    translate('视频链接 · 正在解析… · 可信房间 · 边下边播', 'en'),
    'Video link · Resolving… · Trusted room · Progressive playback'
  );
  assert.equal(
    translate('1.20 GB · 安全模式 · 扫描后播放 · 正在获取清单…', 'en'),
    '1.20 GB · Safe mode · Play after scanning · Fetching the manifest…'
  );
  assert.equal(
    translate('1.20 GB · 安全模式 · 扫描后播放 · 这部片已被拒绝接收', 'en'),
    '1.20 GB · Safe mode · Play after scanning · This video was refused'
  );
  assert.equal(
    translate('播放 用的是旧版 NoxReel（0.6.x），和 0.7 不互通，已断开。请让对方升级到 0.7 再加入。', 'en'),
    '播放 is using an older NoxReel (0.6.x), which cannot connect to 0.7, and was disconnected. Ask them to upgrade to 0.7 and join again.'
  );
  assert.equal(
    translate('Bob 用的是更新版本的 NoxReel，和本机不互通，已断开。请先升级本机的 NoxReel。', 'en'),
    'Bob is using a newer NoxReel that cannot connect to this one, and was disconnected. Upgrade NoxReel on this computer first.'
  );
  // 换片流程改走播放列表之后，这几条已经没人用了
  // 链接授权改成列表行内确认之后，弹窗那几条也没人用了
  for (const dead of [
    '已切换到：海边',
    '已切换到链接：海边',
    'Bob 手里是另一个文件，已忽略他的分片',
    '忽略了非房主发来的换片请求',
    '同一个网站在这个房间里只问这一次。',
    '你没有允许打开这个网站，这一部你先跳过',
    '房主请求打开在线视频',
    '允许并继续',
    '来源：https://example.com',
    // 片源不一定是房主了
    '房主上行（预估）',
  ]) {
    assert.equal(translate(dead, 'en'), dead, `死翻译没删：${dead}`);
  }

  for (const line of [
    '已忽略非房主发来的播放列表',
    '播放列表已经放完了',
    '这个邀请来自旧版 NoxReel（0.6.x），和 0.7 不互通。请让房主升级到 0.7 后重新发邀请。',
    '这个邀请来自更新版本的 NoxReel，请先升级手机上的 NoxReel。',
  ]) {
    assert.notEqual(android.translate(line, 'en'), line, `安卓端缺英文：${line}`);
  }
  assert.equal(android.translate('暂停 · 安全模式 · 正在获取清单…', 'en'), '暂停 · Safe mode · Fetching the manifest…');
  assert.equal(android.translate('播放列表是空的 · 可信房间', 'en'), 'The playlist is empty · Trusted room');
  assert.equal(
    android.translate('还没拿到《海边》的清单：没有人能提供这部片的清单', 'en'),
    'Still waiting for the manifest of “海边”: Nobody can provide the manifest for this video'
  );
  assert.equal(
    android.translate('Alice 用的是旧版 NoxReel（0.6.x），和 0.7 不互通，已断开。', 'en'),
    'Alice is using an older NoxReel (0.6.x), which cannot connect to 0.7, and was disconnected.'
  );
  assert.equal(android.translate('已忽略非房主发来的换片请求', 'en'), '已忽略非房主发来的换片请求', '安卓端的死翻译没删');
});

// —— 翻译跳过标记 data-i18n-skip ——
// 仓库没有 jsdom，这里只实现 isSkipped / translateTree 用得到的那一小块 DOM：
// nodeType、parentElement、属性读写、closest('[属性]')、nodeValue，以及按文档顺序遍历、遵守 FILTER_REJECT 的 TreeWalker。
const { pathToFileURL } = require('node:url');

const FAKE_NODE = { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_NODE: 9 };
const FAKE_NODE_FILTER = { FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3, SHOW_ELEMENT: 0x1, SHOW_TEXT: 0x4 };

class FakeNodeBase {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
  }

  get parentElement() {
    return this.parentNode?.nodeType === FAKE_NODE.ELEMENT_NODE ? this.parentNode : null;
  }

  append(...children) {
    for (const child of children) {
      const node = typeof child === 'string' ? new FakeText(child) : child;
      node.parentNode = this;
      this.childNodes.push(node);
    }
    return this;
  }
}

class FakeText extends FakeNodeBase {
  constructor(value) {
    super(FAKE_NODE.TEXT_NODE);
    this.nodeValue = value;
  }
}

class FakeElement extends FakeNodeBase {
  constructor(tagName, attrs = {}) {
    super(FAKE_NODE.ELEMENT_NODE);
    this.tagName = tagName.toUpperCase();
    this.attrs = new Map(Object.entries(attrs));
  }

  hasAttribute(name) { return this.attrs.has(name); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }

  // 只认「[属性名]」这一种选择器，别的直接报错，免得实现里悄悄换了写法而测试没发现。
  closest(selector) {
    const match = /^\[([\w-]+)\]$/.exec(selector);
    if (!match) throw new Error(`假 DOM 不支持的选择器：${selector}`);
    for (let element = this; element; element = element.parentElement) {
      if (element.hasAttribute(match[1])) return element;
    }
    return null;
  }
}

class FakeDocument extends FakeNodeBase {
  constructor() {
    super(FAKE_NODE.DOCUMENT_NODE);
    this.documentElement = new FakeElement('html');
    this.body = new FakeElement('body');
    this.documentElement.append(this.body);
    this.append(this.documentElement);
  }

  // 与浏览器一致：根本身不交给过滤器；FILTER_REJECT 跳过整棵子树，FILTER_SKIP 只跳过节点自己。
  createTreeWalker(root, whatToShow, filter) {
    const verdict = (node) => {
      if (!(whatToShow & (1 << (node.nodeType - 1)))) return FAKE_NODE_FILTER.FILTER_SKIP;
      if (!filter) return FAKE_NODE_FILTER.FILTER_ACCEPT;
      return typeof filter === 'function' ? filter(node) : filter.acceptNode(node);
    };
    function* walk(parent) {
      for (const child of parent.childNodes) {
        const result = verdict(child);
        if (result === FAKE_NODE_FILTER.FILTER_REJECT) continue;
        if (result === FAKE_NODE_FILTER.FILTER_ACCEPT) yield child;
        yield* walk(child);
      }
    }
    const iterator = walk(root);
    return { root, nextNode: () => iterator.next().value ?? null };
  }
}

const fakeEl = (tag, attrs, ...children) => new FakeElement(tag, attrs).append(...children);

function serializeFake(node) {
  if (node.nodeType === FAKE_NODE.TEXT_NODE) return node.nodeValue;
  return {
    tag: node.tagName ?? '#document',
    attrs: Object.fromEntries(node.attrs ?? []),
    children: node.childNodes.map(serializeFake),
  };
}

function installFakeDom(doc) {
  const globals = { Node: FAKE_NODE, NodeFilter: FAKE_NODE_FILTER, document: doc };
  const saved = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true, enumerable: false });
  }
  return () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
}

// 对一份 i18n 模块跑同一组跳过断言；返回最终的树和 isSkipped 结果，供两端对照。
// 昵称、聊天这类用户输入故意取词条表里有的词（安全模式 / 可信房间 / 界面语言），不跳过就一定会被翻掉。
function checkSkipMarker(mod, label) {
  assert.equal(mod.SKIP_ATTR, 'data-i18n-skip', `${label}：SKIP_ATTR`);
  const doc = new FakeDocument();
  const restore = installFakeDom(doc);
  const previous = mod.currentLocale();
  mod.setLocale('en');
  try {
    // ① 从 body 整体翻译（startI18n 的路径）：带标记的元素连同后代都不翻，兄弟节点照翻。
    const nick = fakeEl(
      'span',
      { 'data-i18n-skip': '', title: '安全模式' },
      '安全模式',
      fakeEl('b', { title: '可信房间' }, '可信房间')
    );
    const sibling = fakeEl('span', { title: '可信房间' }, '安全模式');
    const row = fakeEl('div', {}, nick, sibling, '界面语言');
    doc.body.append(row);
    mod.translateTree(doc.body);
    assert.equal(nick.childNodes[0].nodeValue, '安全模式', `${label}：被跳过元素里的文本不该翻`);
    assert.equal(nick.getAttribute('title'), '安全模式', `${label}：被跳过元素的 title 不该翻`);
    assert.equal(nick.childNodes[1].childNodes[0].nodeValue, '可信房间', `${label}：被跳过元素的后代文本不该翻`);
    assert.equal(nick.childNodes[1].getAttribute('title'), '可信房间', `${label}：被跳过元素的后代属性不该翻`);
    assert.equal(sibling.childNodes[0].nodeValue, 'Safe mode', `${label}：兄弟节点的文本应照翻`);
    assert.equal(sibling.getAttribute('title'), 'Trusted room', `${label}：兄弟节点的 title 应照翻`);
    assert.equal(row.childNodes[2].nodeValue, 'Interface language', `${label}：兄弟文本节点应照翻`);

    // ② 根节点自己带标记（新增的整行聊天）。
    const markedRoot = fakeEl('li', { 'data-i18n-skip': '', title: '安全模式', 'aria-label': '可信房间' }, '安全模式');
    doc.body.append(markedRoot);
    mod.translateTree(markedRoot);
    assert.equal(markedRoot.childNodes[0].nodeValue, '安全模式', `${label}：根带标记时文本不该翻`);
    assert.equal(markedRoot.getAttribute('title'), '安全模式', `${label}：根带标记时 title 不该翻`);
    assert.equal(markedRoot.getAttribute('aria-label'), '可信房间', `${label}：根带标记时 aria-label 不该翻`);

    // ③ characterData：根是被跳过元素里的文本节点（直接子节点和更深一层都要挡住）。
    const chat = fakeEl('p', { 'data-i18n-skip': '' }, '界面语言', fakeEl('span', {}, '界面语言'));
    doc.body.append(chat);
    const directText = chat.childNodes[0];
    const deepText = chat.childNodes[1].childNodes[0];
    directText.nodeValue = '安全模式';
    deepText.nodeValue = '可信房间';
    mod.translateTree(directText);
    mod.translateTree(deepText);
    assert.equal(directText.nodeValue, '安全模式', `${label}：被跳过元素的直接文本改动不该翻`);
    assert.equal(deepText.nodeValue, '可信房间', `${label}：被跳过子树深处的文本改动不该翻`);

    // ④ 根是被跳过元素的后代元素（新增节点落进被跳过的子树）。
    const inner = fakeEl('i', { title: '安全模式' }, '安全模式');
    chat.childNodes[1].append(inner);
    mod.translateTree(inner);
    assert.equal(inner.childNodes[0].nodeValue, '安全模式', `${label}：被跳过子树里新增元素的文本不该翻`);
    assert.equal(inner.getAttribute('title'), '安全模式', `${label}：被跳过子树里新增元素的 title 不该翻`);

    // 对照组：不在被跳过子树里的文本节点和元素照翻，证明上面的断言不是 translateTree 整体失效造成的。
    const plainText = new FakeText('安全模式');
    doc.body.append(plainText);
    mod.translateTree(plainText);
    assert.equal(plainText.nodeValue, 'Safe mode', `${label}：普通文本节点应照翻`);
    const plainElement = fakeEl('em', { 'aria-label': '可信房间' }, '界面语言');
    doc.body.append(plainElement);
    mod.translateTree(plainElement);
    assert.equal(plainElement.getAttribute('aria-label'), 'Trusted room', `${label}：普通元素的 aria-label 应照翻`);
    assert.equal(plainElement.childNodes[0].nodeValue, 'Interface language', `${label}：普通元素的文本应照翻`);

    // document 根节点照旧遍历，同样遵守跳过标记。
    const lateSkipped = fakeEl('span', { 'data-i18n-skip': '' }, '可信房间');
    const latePlain = fakeEl('span', {}, '可信房间');
    doc.body.append(lateSkipped, latePlain);
    mod.translateTree(doc);
    assert.equal(lateSkipped.childNodes[0].nodeValue, '可信房间', `${label}：从 document 遍历也不该翻被跳过的文本`);
    assert.equal(latePlain.childNodes[0].nodeValue, 'Trusted room', `${label}：从 document 遍历应照翻普通文本`);
    assert.equal(nick.childNodes[0].nodeValue, '安全模式', `${label}：再次遍历后被跳过的文本仍保持原样`);

    const probes = {
      null: null,
      undefined,
      document: doc,
      body: doc.body,
      nick,
      nickText: nick.childNodes[0],
      nickChild: nick.childNodes[1],
      sibling,
      siblingText: sibling.childNodes[0],
      markedRoot,
      directText,
      deepText,
      inner,
      plainText,
      plainElement,
      detachedText: new FakeText('安全模式'),
      detachedElement: fakeEl('div', {}),
    };
    const skipped = Object.fromEntries(Object.entries(probes).map(([name, node]) => [name, mod.isSkipped(node)]));
    assert.deepEqual(
      skipped,
      {
        null: false,
        undefined: false,
        document: false,
        body: false,
        nick: true,
        nickText: true,
        nickChild: true,
        sibling: false,
        siblingText: false,
        markedRoot: true,
        directText: true,
        deepText: true,
        inner: true,
        plainText: false,
        plainElement: false,
        detachedText: false,
        detachedElement: false,
      },
      `${label}：isSkipped`
    );
    return { tree: serializeFake(doc), skipped };
  } finally {
    mod.setLocale(previous);
    restore();
  }
}

test('带 data-i18n-skip 的用户输入不参与自动翻译，两端行为一致', async () => {
  const desktop = await import('../src/renderer/lib/i18n.js');
  const android = await import(
    pathToFileURL(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'js', 'i18n.js')).href
  );
  const hadGlobals = ['Node', 'NodeFilter', 'document'].map((key) => Object.hasOwn(globalThis, key));
  const locales = [desktop.currentLocale(), android.currentLocale()];

  const desktopResult = checkSkipMarker(desktop, '桌面端');
  const androidResult = checkSkipMarker(android, '安卓端');
  assert.deepEqual(androidResult, desktopResult, '两端的翻译结果与 isSkipped 判定应完全一致');

  // 全局假 DOM 和语言设置都已还原，不影响同文件里的其他用例。
  assert.deepEqual(['Node', 'NodeFilter', 'document'].map((key) => Object.hasOwn(globalThis, key)), hadGlobals);
  assert.deepEqual([desktop.currentLocale(), android.currentLocale()], locales);
});

/**
 * 播放列表表格、就绪等待、行内加片（0.7 P4）。表格里的片名和等待名单里的昵称是用户输入，
 * 绝不能跟着翻；翻译只作用在我们自己的文案上。
 */
test('播放列表表格、就绪等待和行内加片的新文案都有英文', async () => {
  const { translate } = await import('../src/renderer/lib/i18n.js');
  const fixed = {
    '自动连播': 'Autoplay',
    '仍然开始': 'Start anyway',
    '允许打开': 'Allow',
    '这一部我先跳过': 'Skip this one for me',
    '跳过这一部': 'Skip this one',
    '再放一次（需重新传输）': 'Play again (needs a new transfer)',
    '排队中（等大家先收完当前这部）': 'Queued (until everyone has the current video)',
    '已收完 · 未经扫描': 'Received · Not scanned',
    '等待房主确认': 'Waiting for the host',
    '你已不是管理员，还没加进列表的片撤回了': 'You are no longer a moderator, so videos not yet added were withdrawn',
    '所有人都准备好了，等房主或管理员开始': 'Everyone is ready. Waiting for the host or a moderator to start',
    '正在给成员供片，这时测不准上行': 'You are serving members right now, so upload speed cannot be measured accurately',
    '片源上行（预估）': 'Source upload (estimated)',
    '安全扫描没能完成': 'The security scan did not finish',
    '操作已取消': 'Cancelled',
  };
  for (const [zh, en] of Object.entries(fixed)) assert.equal(translate(zh, 'en'), en, zh);

  const dynamic = {
    '传输中 43%': 'Transferring 43%',
    '传输已暂停 0%': 'Transfer paused 0%',
    '等待片源 99%': 'Waiting for the source 99%',
    '暂时没人能提供 12%': 'Nobody can provide it right now 12%',
    '已播放（3）': 'Played (3)',
    '等待 1 人准备好：': 'Waiting for 1 person to get ready: ',
    '等待 3 人准备好：': 'Waiting for 3 people to get ready: ',
    '正在放的这部排到下一位，回头从 12:34 接着放。': 'The current video moves to the next position and resumes from 12:34 later.',
    '列表没改成：操作已取消': 'The playlist was not changed: Cancelled',
    '先扫正在放的这部，《海边》稍后接着扫': 'Scanning the current video first; “海边” will be scanned afterwards',
    '磁盘空间不够，先清掉已播放的《海边》的缓存': 'Not enough disk space; clearing the cache of the played video “海边” first',
    '这一部要打开 www.example.com，需要你先允许': 'This video opens www.example.com and needs your permission first',
    '无效的 任务标识': 'Invalid task id',
    '无效的 片源上行带宽': 'Invalid source upload speed',
    // 没登记的字段名不能漏出中文句式，只把字段名原样带上
    '无效的 某个新字段': 'Invalid input (某个新字段)',
  };
  for (const [zh, en] of Object.entries(dynamic)) assert.equal(translate(zh, 'en'), en, zh);

  // 片名原样保留：哪怕片名恰好是一个有翻译的词
  assert.equal(translate('《播放》安全扫描通过', 'en'), '“播放” passed the security scan');
  assert.equal(
    translate('《暂停》没加进列表：操作已取消', 'en'),
    '“暂停” was not added to the playlist: Cancelled'
  );
  assert.equal(
    translate('《播放》没有扫完：安全扫描没能完成', 'en'),
    '“播放” was not fully scanned: The security scan did not finish'
  );

  // 表格组件里的固定文案一条不漏
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'ui', 'playlistPanel.js'), 'utf8');
  const literals = [...panel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').matchAll(/'([^'\n]*[一-鿿][^'\n]*)'/g)].map((m) => m[1]);
  assert.ok(literals.length > 0, '没从 playlistPanel.js 里取到文案，下面的断言会形同虚设');
  for (const text of literals) assert.notEqual(translate(text, 'en'), text, `playlistPanel.js 漏翻：${text}`);

  // 页面上新加的按钮
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  for (const id of ['btn-force-start', 'btn-allow-link', 'btn-skip-link', 'btn-skip-current']) {
    const m = html.match(new RegExp(`id="${id}"[^>]*>([^<]+)<`));
    assert.ok(m, `index.html 缺少 #${id}`);
    assert.notEqual(translate(m[1].trim(), 'en'), m[1].trim(), `#${id} 漏翻`);
  }
});

/** 换缓存目录被挡下时，主进程抛的中文原因会原样显示给用户，三条都要有英文。 */
test('换缓存目录的三条拒绝原因都有英文', async () => {
  const { translate } = await import('../src/renderer/lib/i18n.js');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  for (const zh of ['正在放映时不能换缓存目录，退出房间后再改', '还有临时文件没回收，退出房间后再改', '正在转封装或精简，完成后再换缓存目录']) {
    assert.ok(main.includes(zh), `main.js 里已经没有这条原因了：${zh}`);
    assert.notEqual(translate(zh, 'en'), zh, `漏翻：${zh}`);
  }
});

/**
 * 弹幕聊天（0.7）。聊天正文和昵称是用户输入，绝不能被翻译；
 * 系统事件反过来必须整句翻译，昵称靠词条里的正则捕获原样带过去。
 */
test('弹幕聊天的新文案都有英文，聊天正文和昵称原样保留', async () => {
  const { translate } = await import('../src/renderer/lib/i18n.js');
  for (const zh of [
    '发送',
    '说点什么…',
    '聊天输入框',
    '发送中',
    '已送达',
    '你加入前的消息',
    '弹幕',
    '弹幕设置',
    '不透明度',
    '字号',
    '速度',
    '显示区域',
    '上半屏',
    '全屏',
    '还没有消息',
    '聊天',
  ]) {
    assert.notEqual(translate(zh, 'en'), zh, `漏翻：${zh}`);
  }

  // 未读条数和限速倒计时是动态的，单复数得跟着变
  assert.equal(translate('↓ 1 条新消息', 'en'), '↓ 1 new message');
  assert.equal(translate('↓ 12 条新消息', 'en'), '↓ 12 new messages');
  assert.equal(translate('发得太快了（1 秒后再试）', 'en'), 'Too many messages — try again in 1 second');
  assert.equal(translate('发得太快了（4 秒后再试）', 'en'), 'Too many messages — try again in 4 seconds');

  // 系统事件：整句翻译，昵称原样
  assert.equal(translate('播放 加入了房间', 'en'), '播放 joined the room');
  assert.equal(translate('播放 离开了房间', 'en'), '播放 left the room');
  assert.equal(translate('暂停 暂停 @ 1:23', 'en'), '暂停 paused @ 1:23');
  assert.equal(translate('现在放：暂停.mkv', 'en'), 'Now playing: 暂停.mkv');

  // 聊天正文自己不进字典 —— 就算整句正好和某条界面文案一模一样，也是靠 data-i18n-skip 挡住的，
  // 这里只确认没人偷偷给聊天正文加过什么「智能翻译」的词条
  assert.equal(translate('说点什么…', 'zh-CN'), '说点什么…');

  // ui/chatPanel.js 里写死的中文一条都不能漏翻
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'ui', 'chatPanel.js'), 'utf8');
  const literals = new Set([...panel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').matchAll(/'([^'\n]*[一-鿿][^'\n]*)'/g)].map((m) => m[1]));
  assert.ok(literals.size > 8, `只找到 ${literals.size} 条中文字面量，正则可能失效了`);
  for (const text of literals) assert.notEqual(translate(text, 'en'), text, `chatPanel.js 漏翻：${text}`);
});

/**
 * 播放器里按 Ctrl+Shift+D 调出的输入框提示语由渲染进程定：主进程不做翻译，
 * 漏传的话英文界面下 mpv 里弹出来的还是中文。
 */
test('播放器内弹幕输入框的提示语按界面语言传给 mpv', async () => {
  const { translate } = await import('../src/renderer/lib/i18n.js');
  assert.equal(translate('弹幕：', 'en'), 'Danmaku: ');

  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  const call = app.slice(app.indexOf('window.sw.player.launch({'));
  const body = call.slice(0, call.indexOf('});'));
  assert.match(body, /chatPrompt: t\('弹幕：'\)/, 'launch 要把翻译好的提示语带下去');

  // preload 是唯一通道：它只转发自己解构出来的字段，漏了这一个的话前面传了也白传
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf8');
  const launch = preload.slice(preload.indexOf('launch: ('), preload.indexOf('setPause:'));
  assert.match(launch, /chatPrompt/, 'preload 的 launch 要把提示语转下去');
  assert.equal((launch.match(/chatPrompt/g) || []).length, 2, '解构和转发两处都要有');

  // 主进程这一侧只做校验和透传，不认识中文文案
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  assert.match(main, /chatPrompt/);
  const lua = fs.readFileSync(path.join(__dirname, '..', 'resources', 'mpv-scripts', 'noxreel-chat.lua'), 'utf8');
  assert.match(lua, /noxreel_chat-prompt/, 'Lua 侧要认这个 script-opt，否则传下去也没人用');
});

/**
 * 安卓端补齐电脑端的那几块：房间链接、连接设置（TURN、隐藏我的 IP、Cloudflare）、管理员编辑列表。
 * 大厅和列表面板里新加的中文逐条扫一遍（标签、按钮、提示、占位符），代码里拼出来的句子单独列。
 */
test('安卓端：房间链接、连接设置、Cloudflare、列表编辑的新文案都有英文', async () => {
  const androidI18n = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'js', 'i18n.js');
  const { translate } = await import(pathToFileURL(androidI18n).href);
  const html = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'index.html'), 'utf8');
  const cjk = /[一-鿿]/;
  const texts = new Set();
  for (const [start, end] of [
    ['<div id="panel-manual"', '<div id="log">'],
    ['<div id="playlist-edit"', '<div class="sheet-body" id="playlist-body">'],
    ['<div id="confirm-ask">', '<script'],
  ]) {
    const block = html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
    assert.ok(block.length > 20, `找不到 ${start}`);
    const withoutComments = block.replace(/<!--[\s\S]*?-->/g, '');
    for (const m of withoutComments.matchAll(/>([^<>]+)</g)) {
      const text = m[1].trim();
      if (cjk.test(text)) texts.add(text);
    }
    for (const m of withoutComments.matchAll(/(?:placeholder|title)="([^"]+)"/g)) if (cjk.test(m[1])) texts.add(m[1]);
  }
  texts.add('邀请链接');
  assert.ok(texts.size > 25, `扫到的文案太少，扫描范围可能不对：${texts.size}`);
  for (const zh of texts) {
    const en = translate(zh, 'en');
    assert.doesNotMatch(en, cjk, `安卓端漏翻：${zh}`);
  }

  // 代码里拼出来的句子
  for (const [zh, en] of [
    ['加入房间失败：等房主放行超时', 'Could not join the room: Timed out waiting for the host to let you in'],
    [
      '本月 Cloudflare TURN 用量已到你设的上限（900 GB），为免扣费已停用；下个月 1 日自动恢复，或者在连接设置里调高上限。「隐藏我的 IP」开着，没有中继就不连接。',
      'This month’s Cloudflare TURN usage has reached your limit (900 GB) and was turned off to avoid charges; it comes back on the 1st of next month, or raise the limit in the connection settings. “Hide my IP” is on, so without a relay no connection is made.',
    ],
    ['Cloudflare TURN：已配置，账号有效至 09:30', 'Cloudflare TURN: set up, credentials valid until 09:30'],
    ['Cloudflare TURN：网络不通：连不上 Cloudflare', 'Cloudflare TURN: Network problem: cannot reach Cloudflare'],
    ['没保存：未授权：Cloudflare 不认这组 Turn Token ID 和 API Token', 'Not saved: Unauthorized: Cloudflare rejected this Turn Token ID and API Token'],
    ['本月已用 12.50 GB / 900 GB', 'Used this month: 12.50 GB / 900 GB'],
    ['Cloudflare TURN 每月上限已设为 500 GB', 'Cloudflare TURN monthly limit set to 500 GB'],
    ['列表没改成：列表里没有这一项', 'The playlist was not changed: That item is not in the playlist'],
    ['列表没改成：列表最多 100 项', 'The playlist was not changed: The playlist can hold at most 100 items'],
    ['正在放的这部排到下一位，回头从 12:30 接着放。', 'The current video moves to the next position and resumes from 12:30 later.'],
    ['这些 TURN 地址用的是 53 端口，浏览器会拦下这个端口：turn:a:53。换一个端口，常见的是 3478 或 443', 'These TURN addresses use port 53, which the browser blocks: turn:a:53. Use another port—3478 or 443 are common'],
  ]) {
    assert.equal(translate(zh, 'en'), en);
  }
  for (const zh of [
    '正在通过公共中继找房主，等房主放行…',
    '房主已放行，正在和房间里的人打洞…',
    '这个房间链接不完整，请让房主重新复制一次。',
    '找不到房主：他可能已经离开房间，或者换过房间链接。请让房主重新发一条。',
    '房主那边一直没能和你直连，你已被移出房间。可以请房主改发一对一邀请，或者双方配置 TURN 后再试。',
    '已打开「隐藏我的 IP」，但还没有可用的 TURN 中继：请在连接设置里配好 TURN，或者先关掉这个开关。',
    'TURN 中继开着但没填用户名或密码，这次先不走中继、只尝试直连。到连接设置里补全，或者把中继关掉。',
    '连接设置已保存（只影响之后新建的连接）',
    '只能加 http:// 或 https:// 开头的视频链接',
    '链接已加进列表',
    '你是管理员：点一行可以调整；改动由房主那边执行',
    '列表还是空的，在上面加一个在线链接。',
    '本月用量已超过上限的 80%，快到上限了。',
  ]) {
    assert.doesNotMatch(translate(zh, 'en'), cjk, `安卓端漏翻：${zh}`);
  }
});

/**
 * 安卓观众端的弹幕聊天与只读播放列表（0.7 P7）。
 * 桌面和安卓是两份独立的字典，桌面加了词条不代表手机上也有 ——
 * 手机端界面里写死的中文一条都不能漏翻，聊天正文和昵称则反过来一律不翻。
 */
test('安卓端：弹幕聊天与只读列表的新文案都有英文', async () => {
  const androidI18n = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'js', 'i18n.js');
  const { translate } = await import(pathToFileURL(androidI18n).href);

  for (const zh of [
    // 只读播放列表
    '列表',
    '播放列表',
    '手机端暂不支持编辑列表',
    '列表还是空的，等房主加片。',
    '正在播放',
    '待播',
    '已播放',
    // 聊天
    '聊天',
    '还没有消息',
    '说点什么…',
    '聊天输入框',
    '发送',
    '发送中',
    '已送达',
    '你加入前的消息',
    // 弹幕与它的本地设置
    '弹幕',
    '弹幕设置',
    '不透明度',
    '字号',
    '速度',
    '显示区域',
    '上半屏',
    '全屏',
    '这些设置只影响你自己的画面。',
    // 站点授权
    '允许',
    '拒绝',
    '关闭',
  ]) {
    assert.notEqual(translate(zh, 'en'), zh, `安卓端漏翻：${zh}`);
  }

  // 身份提示：具体那两条要排在通配的「身份：X」前面，否则永远轮不到它们
  assert.equal(
    translate('身份：管理员 · 可以控制播放、编辑列表', 'en'),
    'Role: Moderator · You can control playback and edit the playlist'
  );
  assert.equal(
    translate('身份：房主 · 可以控制播放、编辑列表', 'en'),
    'Role: Host · You can control playback and edit the playlist'
  );
  assert.equal(
    translate('身份：游客 · 播放/暂停仅对自己生效，不能拖动进度', 'en'),
    'Role: Guest · Play/pause only affects you; seeking is disabled'
  );
  // 角色名本身也要翻
  assert.equal(translate('身份：房主', 'en'), 'Role: Host');
  assert.equal(translate('身份：游客', 'en'), 'Role: Guest');

  // 系统事件：整句翻译，昵称和片名靠词条里的正则捕获原样带过去
  assert.equal(translate('播放 加入了房间', 'en'), '播放 joined the room');
  assert.equal(translate('播放 离开了房间', 'en'), '播放 left the room');
  assert.equal(translate('暂停 暂停 @ 1:23', 'en'), '暂停 paused @ 1:23');
  assert.equal(translate('暂停 播放 @ 1:23', 'en'), '暂停 played @ 1:23');
  assert.equal(translate('现在放：暂停.mkv', 'en'), 'Now playing: 暂停.mkv');

  // 限速倒计时的单复数
  assert.equal(translate('发得太快了（1 秒后再试）', 'en'), 'Too many messages — try again in 1 second');
  assert.equal(translate('发得太快了（4 秒后再试）', 'en'), 'Too many messages — try again in 4 seconds');

  // 聊天正文和昵称不进字典：靠 data-i18n-skip 挡住，字典这边不该有任何「智能翻译」
  assert.equal(translate('说点什么…', 'zh-CN'), '说点什么…');

  // index.html 的播放层里写死的中文一条都不能漏翻（聊天正文、昵称、片名都是运行时填的，不在这里）
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'index.html'),
    'utf8'
  );
  const stage = html.slice(html.indexOf('<div id="stage">'), html.lastIndexOf('</div>')).replace(/<!--[\s\S]*?-->/g, '');
  const literals = new Set();
  for (const m of stage.matchAll(/>([^<>]*[\u4e00-\u9fff][^<>]*)</g)) literals.add(m[1].trim());
  for (const m of stage.matchAll(/(?:placeholder|aria-label|title)="([^"]*[\u4e00-\u9fff][^"]*)"/g)) literals.add(m[1].trim());
  assert.ok(literals.size > 15, `只找到 ${literals.size} 条中文字面量，正则可能失效了`);
  for (const zh of literals) assert.notEqual(translate(zh, 'en'), zh, `index.html 漏翻：${zh}`);
});

/**
 * IP 隐私（0.7.6）：「隐藏我的 IP」和 Cloudflare TURN 的新文案。
 * 带数字、时间和嵌套原因的句子全靠模式翻译 —— 每一种动态句式都实际跑一遍，
 * 设置页和报错里写死的中文字面量一条条过一遍，一条都不能漏。
 */
test('IP 隐私（隐藏我的 IP、Cloudflare TURN）的新文案都有英文', async () => {
  const { translate } = await import('../src/renderer/lib/i18n.js');
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
  const fnSource = (name) => {
    const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(app);
    assert.ok(m, `app.js 里没找到 ${name}`);
    return app.slice(m.index, app.indexOf('\n}\n', m.index) + 2);
  };
  const errorTable = app.slice(app.indexOf('const CF_ERROR_TEXT = {'), app.indexOf('\n};\n', app.indexOf('const CF_ERROR_TEXT = {')));
  const sources = [
    fnSource('turnSettingsFields'),
    fnSource('saveCfTurnCredentials'),
    fnSource('clearCfTurnCredentials'),
    fnSource('renderCfTurnStatus'),
    fnSource('cfErrorText'),
    fnSource('cfTurnStatusText'),
    errorTable,
    /^const RELAY_ONLY_NO_TURN = .*$/m.exec(app)[0],
  ].join('\n');
  const literals = new Set();
  for (const m of sources.matchAll(/'([^'\n]*[一-鿿][^'\n]*)'/g)) literals.add(m[1]);
  assert.ok(literals.size > 25, `只找到 ${literals.size} 条中文字面量，正则可能失效了`);
  for (const zh of literals) assert.notEqual(translate(zh, 'en'), zh, `漏翻：${zh}`);

  // 保存设置时的几条报错
  assert.equal(
    translate('这些 TURN 地址用的是 53 端口，浏览器会拦下这个端口：turn:a.example:53。换一个端口，常见的是 3478 或 443', 'en'),
    'These TURN addresses use port 53, which the browser blocks: turn:a.example:53. Use another port—3478 or 443 are common'
  );
  assert.equal(translate('Cloudflare TURN 每月上限要填 1 到 1000 之间的整数（GB）。', 'en'), 'The Cloudflare TURN monthly limit must be a whole number from 1 to 1000 (GB).');
  assert.match(translate('Cloudflare 凭据还没保存：先点「验证并保存」，或者把这两个框清空。', 'en'), /^The Cloudflare credentials are not saved yet/);

  // 到上限：单独一句、带「隐藏我的 IP」的后半句、放在状态行里
  const quota = '本月 Cloudflare TURN 用量已到你设的上限（900 GB），为免扣费已停用；下个月 1 日自动恢复，或者在设置里调高上限';
  assert.equal(
    translate(quota, 'en'),
    'This month’s Cloudflare TURN usage has reached your limit (900 GB) and was turned off to avoid charges; it comes back on the 1st of next month, or raise the limit in Settings'
  );
  assert.match(translate(`${quota}。「隐藏我的 IP」开着，没有中继就不连接。`, 'en'), /raise the limit in Settings\. “Hide my IP” is on, so without a relay no connection is made\.$/);
  assert.match(translate(`Cloudflare TURN：${quota}`, 'en'), /^Cloudflare TURN: This month’s Cloudflare TURN usage has reached your limit \(900 GB\)/);

  // 状态行、用量、80% 提醒
  assert.equal(translate('Cloudflare TURN：已配置，账号有效至 14:05', 'en'), 'Cloudflare TURN: set up, credentials valid until 14:05');
  assert.equal(translate('Cloudflare TURN：还没配置', 'en'), 'Cloudflare TURN: not set up');
  assert.equal(
    translate('Cloudflare TURN：未授权：Cloudflare 不认这组 Turn Token ID 和 API Token', 'en'),
    'Cloudflare TURN: Unauthorized: Cloudflare rejected this Turn Token ID and API Token'
  );
  assert.equal(translate('本月已用 123.5 GB / 900 GB', 'en'), 'Used this month: 123.5 GB / 900 GB');
  assert.equal(
    translate('本月 Cloudflare TURN 用量已超过你设的上限的 80%（720.3 / 900 GB）', 'en'),
    'This month’s Cloudflare TURN usage is past 80% of your limit (720.3 / 900 GB)'
  );

  // 日志：取账号失败的两种说法，原因嵌在里面
  assert.equal(
    translate('Cloudflare TURN 账号没拿到（网络不通：连不上 Cloudflare），这次先不走中继、只尝试直连', 'en'),
    'Could not get Cloudflare TURN credentials (Network problem: cannot reach Cloudflare); trying a direct connection only this time'
  );
  assert.equal(translate('Cloudflare TURN 账号没拿到：还没保存 Cloudflare 凭据', 'en'), 'Could not get Cloudflare TURN credentials: No Cloudflare credentials saved yet');
  assert.equal(translate('没保存：Turn Token ID 或 API Token 的格式不对', 'en'), 'Not saved: The Turn Token ID or API Token is not in the right format');
  assert.equal(translate('Cloudflare TURN 月上限没改成：无效的 TURN 用量上限', 'en'), 'The Cloudflare TURN monthly limit was not changed: Invalid TURN usage limit');

  // 主进程参数校验的字段名
  assert.equal(translate('无效的 API Token', 'en'), 'Invalid API Token');
  assert.equal(translate('无效的 Cloudflare 凭据', 'en'), 'Invalid Cloudflare credentials');

  // 只走中继时的连接诊断（ice.js）：单独一句，也嵌在「诊断：」和「直连失败了」里
  const { diagnoseCandidates, summarizeCandidates } = await import('../src/renderer/lib/ice.js');
  const none = diagnoseCandidates(summarizeCandidates(''), { relayOnly: true }).text;
  const ok = diagnoseCandidates(summarizeCandidates('a=candidate:1 1 udp 100 198.51.100.7 5000 typ relay raddr 0.0.0.0 rport 0'), { relayOnly: true }).text;
  assert.match(translate(none, 'en'), /^“Hide my IP” is on, so only TURN relay connections are allowed, but no relay candidate arrived/);
  assert.match(translate(ok, 'en'), /^Relay-only connection: a relay candidate is available/);
  assert.match(translate(`诊断：${none}`, 'en'), /^Diagnosis: “Hide my IP” is on/);
  assert.match(translate(`和 Alice 的直连失败了。${none}`, 'en'), /“Hide my IP” is on/);
  assert.equal(translate('还不能连接', 'zh-CN'), '还不能连接');
});
