'use strict';

/**
 * v0.6.7 修复的回归测试。
 *
 * 这些缺陷来自一次全仓库分维度审查（17 个维度 × 每条 3 个对抗验证者）。
 * 挑出其中能确定性验证的钉在这里 —— 尤其是那些「代码看起来没问题、
 * 只有真走一遍才知道」的，比如 ffprobe 的列序和 translate 的 trim。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

/* ------------------------- 安全模式的起播门槛 ------------------------- */

test('起播门槛长在 launchPlayer 里，不是只长在调用方身上', () => {
  const app = read('src/renderer/app.js');
  assert.match(app, /function playbackAllowed\(\)/, '缺少集中的门槛判定');
  const fn = app.slice(app.indexOf('async function launchPlayer()'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /playbackAllowed\(\)/, 'launchPlayer 自己不判门槛，调用方漏判就绕过去了');
});

test('安全模式只在扫描通过后放行，可信房间放行片头就绪', () => {
  const app = read('src/renderer/app.js');
  const fn = app.slice(app.indexOf('function playbackAllowed()'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /'clean'/, '安全模式必须要求扫描通过');
  assert.match(body, /trusted-streaming/, '可信房间要认片头就绪状态');
  assert.match(body, /S\.isSeeder/, '片源方本地就有完整文件，不该被拦');
});

test('「重新打开」按钮的可见性跟着门槛走', () => {
  const app = read('src/renderer/app.js');
  assert.match(app, /!playbackAllowed\(\)\)/, '按钮还会在不允许播放时露出来');
});

/* --------------------------- 极简模式的身份 --------------------------- */

test('应答码里的 from 会被校验，不能冒用房主身份', () => {
  const app = read('src/renderer/app.js');
  const fn = app.slice(app.indexOf('async function acceptManualAnswer'));
  const body = fn.slice(0, 4000);
  assert.match(body, /claimed === S\.hostId/, '没挡住冒用房主 peerId');
  assert.match(body, /claimed === S\.peerId/, '没挡住冒用自身 peerId');
  assert.match(body, /peers\?\.has\(claimed\)/, '没挡住顶替已在房成员');
});

/* ------------------------------ 重连撞车 ------------------------------ */

for (const [label, f] of [
  ['桌面端', 'src/renderer/app.js'],
  ['安卓端', 'android/app/src/main/assets/js/app-android.js'],
]) {
  test(`${label}：同一个 peer 同时只允许一次重协商`, () => {
    const src = read(f);
    assert.match(src, /RENEGOTIATING/, '缺少重协商去重，会连发两份 offer');
    assert.match(src, /if \(RENEGOTIATING\.has\(peerId\)\) return RENEGOTIATING\.get\(peerId\)/);
  });

  test(`${label}：ICE 自愈后撤掉已排上的重连`, () => {
    const src = read(f);
    const i = src.indexOf("s === 'connected' || s === 'completed'");
    assert.ok(i > 0, '找不到 connected 分支');
    assert.match(src.slice(i, i + 400), /cancelRecovery/, 'ICE 缓过来了还会去拆健康连接');
  });

  test(`${label}：过期 answer 被接住，不变成未处理的 Promise 拒绝`, () => {
    const src = read(f);
    const i = src.indexOf("payload.kind === 'answer'");
    assert.match(src.slice(i, i + 500), /catch\(/, 'acceptAnswer 没有接异常');
  });
}

test('安卓端认识 renegotiate —— 否则手机侧链路断了永远回不来', () => {
  const src = read('android/app/src/main/assets/js/app-android.js');
  assert.match(src, /payload\.kind === 'renegotiate'/);
  assert.match(src, /function scheduleReconnect/);
  assert.match(src, /async function reconnectPeer/);
});

/* --------------------------- 同步引擎的权限 --------------------------- */

test('两端的 SYNC/STALL 权限锚点都是 P2P 连接身份，不是消息体字段', () => {
  for (const f of ['src/renderer/lib/syncEngine.js', 'android/app/src/main/assets/js/syncEngine.js']) {
    const src = read(f);
    // 锚在定义处，别撞上前面那行 `return this._onRemoteSync(msg, fromPeer);` 的调用点
    const sync = src.slice(src.indexOf('  _onRemoteSync(msg, fromPeer) {'));
    const syncBody = sync.slice(0, sync.indexOf('\n  }'));
    assert.match(syncBody, /fromPeer\?\.peerId/, `${f}: SYNC 没用连接身份`);
    assert.ok(!/msg\.by \|\|/.test(syncBody), `${f}: SYNC 还在信可伪造的 msg.by`);
    assert.match(syncBody, /isController\(senderId\)/, `${f}: SYNC 没强制控场权`);

    const stall = src.slice(src.indexOf('  _onRemoteStall(msg, fromPeer) {'));
    const stallBody = stall.slice(0, stall.indexOf('\n  }'));
    assert.ok(!/msg\.peerId \|\|/.test(stallBody), `${f}: STALL 还在信可伪造的 msg.peerId`);
    assert.match(stallBody, /isController\(id\)/, `${f}: STALL 解除时没校验角色`);
  }
});

test('播放器退出后忘掉上一条 tick，重开不会把全房拉回片头', async () => {
  const { SyncEngine } = await import('../src/renderer/lib/syncEngine.js');
  const eng = new SyncEngine({ peerId: 'me', name: 'me' });
  eng.lastTick = { position: 1200, paused: false, at: 1 };
  eng.forgetPlayerState();
  assert.equal(eng.lastTick, null);
});

test('播放器没起来时收到的位置会被记住，起来后补放', async () => {
  const { SyncEngine } = await import('../src/renderer/lib/syncEngine.js');
  const eng = new SyncEngine({ peerId: 'me', name: 'me' });
  eng.started = true;
  eng.lastTick = null; // 播放器还没起来
  const seeks = [];
  eng.onSeek = (p) => seeks.push(p);
  eng.onSetPause = () => {};

  await eng._reconcile({ seekTo: 930 });
  assert.deepEqual(seeks, [], '播放器都没起来，这时候 seek 只会被主进程拒掉');
  assert.equal(eng.pendingSeek, 930, '位置得先记着');

  eng.lastTick = { position: 0, paused: true, at: 1 };
  await eng.resyncToShared();
  assert.deepEqual(seeks, [930], '播放器起来后没把房间位置补上，接收方会从 00:00 开始播');
});

test('resetMedia 只在会广播时才推进 Lamport', () => {
  const src = read('src/renderer/lib/syncEngine.js');
  const fn = src.slice(src.indexOf('resetMedia({ isSeeder = this.isSeeder } = {})'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.match(body, /willBroadcast/, '观众静默推进 Lamport 会让房主换片后的首条指令被丢掉');
  assert.ok(
    !/lamport: this\.shared\.lamport \+ 1,/.test(body),
    '还在无条件自增'
  );
});

/* ------------------------------ 信令服务器 ------------------------------ */

test('XFF 取最后一段（追加型代理里唯一不可伪造的那段）', () => {
  const src = read('signaling-server/server.js');
  const fn = src.slice(src.indexOf('function clientIp(req)'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /hops\[hops\.length - 1\]/, '取第一段等于让任何人自称 127.0.0.1');
});

test('局域网豁免只认真实连接地址，不看任何请求头', () => {
  const src = read('signaling-server/server.js');
  const fn = src.slice(src.indexOf('function isLoopback(req)'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /req\.socket\.remoteAddress/);
  assert.ok(!/clientIp\(/.test(body), '豁免判据掺了请求头就能被绕过');
});

test('maxMembers 传 0 时落到默认值，不是被压成 2', () => {
  const src = read('signaling-server/server.js');
  const fn = src.slice(src.indexOf('function normalizeCapacity(value)'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /n <= 0/, '0 会被 Math.max(2, …) 压成 2，房间被钉死在 2 人');
});

test('房主的 peerId 在房间存续期间不能被顶替', () => {
  const src = read('signaling-server/server.js');
  assert.match(src, /HOST_ID_RESERVED/);
});

test('转发有背压保护，慢消费者会被断开而不是把堆写爆', () => {
  const src = read('signaling-server/server.js');
  const fn = src.slice(src.indexOf('function sendJson(ws, obj)'));
  assert.match(fn.slice(0, 500), /bufferedAmount/);
});

/* ------------------------------ i18n ------------------------------ */

test('字典键不带首尾空白 —— translate 会先剥掉再查表，带空格的键永远命中不了', () => {
  const src = read('src/renderer/lib/i18n.js');
  const bad = [...src.matchAll(/^\s*'([^']*[ \t])':\s*'/gm)].map((m) => m[1]);
  assert.deepEqual(bad, [], `这些键永远不会被命中：${bad.map((k) => JSON.stringify(k)).join(', ')}`);
});

test('v0.6.6 新增的用户可见文案都能翻出英文', async () => {
  const { translate } = await import('../src/renderer/lib/i18n.js');
  const cases = [
    '，约 4.0 GB。',
    '你',
    '游客不能跳转进度',
    '可信房间 · 边下边播风险较高',
    '安全扫描通过 · 缓存退出后自动清理',
    '未经本机扫描 · 请自行确认片源',
    '，转成 FLAC 是数学无损的 —— 解码出来的采样逐字节相同。已经拿这个文件实测过：能压掉',
  ];
  for (const zh of cases) {
    assert.notEqual(translate(zh, 'en'), zh, `没翻出来：${zh}`);
  }
});

test('OSD 文案过 translate —— 它走 IPC 交给 mpv，自动翻译碰不到', () => {
  const src = read('src/renderer/app.js');
  const calls = [...src.matchAll(/window\.sw\.mpv\.osd\(([^,]+),/g)].map((m) => m[1].trim());
  assert.ok(calls.length >= 5, `只找到 ${calls.length} 处 osd 调用，是不是漏了`);
  for (const arg of calls) {
    assert.match(arg, /\bt\(/, `这处 OSD 没过 translate：${arg}`);
  }
});

/* ------------------------------ 邀请码提取 ------------------------------ */

for (const [label, f] of [
  ['桌面端', '../src/renderer/lib/signaling.js'],
  ['安卓端', '../android/app/src/main/assets/js/signaling.js'],
]) {
  test(`${label}：码后面跟英文单词也能提取出来`, async () => {
    const { unwrapInviteInput } = await import(f);
    assert.equal(unwrapInviteInput('NR3-abcDEF123.xyz- thanks'), 'NR3-abcDEF123.xyz-');
    assert.equal(unwrapInviteInput('NR3-abcDEF123.xyz- Thanks'), 'NR3-abcDEF123.xyz-');
    assert.equal(unwrapInviteInput('here is the code: NR3-abcDEF123.xyz-'), 'NR3-abcDEF123.xyz-');
  });

  test(`${label}：邮件折行和引用前缀仍然能拼回来`, async () => {
    const { unwrapInviteInput } = await import(f);
    // 折行的续段和尾随的英文单词结构一样，只能按词形区分 —— 别把续段当单词丢了
    assert.equal(unwrapInviteInput('NR3-abcDEF\n123.xyz-'), 'NR3-abcDEF123.xyz-');
    assert.equal(unwrapInviteInput('> NR3-abcDEF\n> 123.xyzQ9-'), 'NR3-abcDEF123.xyzQ9-');
  });
}

for (const f of ['src/renderer/lib/signaling.js', 'android/app/src/main/assets/js/signaling.js']) {
  test(`${f.includes('android') ? '安卓端' : '桌面端'}：只有真正进过房才自动重连`, () => {
    const src = read(f);
    assert.match(src, /_joinedOnce/, '用 settled 判断会让首连失败也进入无限重连');
    assert.ok(
      !/if \(!this\._closedByUs && settled\) this\._scheduleReconnect\(\)/.test(src),
      '还在用 settled 当重连判据'
    );
  });
}

/* ------------------------------ Android 存储 ------------------------------ */

test('Android 的接收缓存会被删掉，且 fileId 不能穿越目录', () => {
  const kt = read('android/app/src/main/java/com/syncwatch/app/Store.kt');
  assert.match(kt, /FILE_ID_RE/, 'fileId 直接拼进路径，含 .. 就能写到 media 目录之外');
  assert.match(kt, /canonicalPath\.startsWith/, '缺少路径越界的兜底校验');
  assert.match(kt, /session\.dataFile\.delete\(\)/, '关会话时不删缓存，内部存储会一直涨');
  assert.match(kt, /fun cleanupStale\(\)/, '进程被杀后的残留没人回收');
  assert.match(kt, /fun closeAll\(\)/);

  const main = read('android/app/src/main/java/com/syncwatch/app/MainActivity.kt');
  assert.match(main, /store\.cleanupStale\(\)/, '启动时没回收残留');
  assert.match(main, /store\.closeAll\(\)/, '退出时没关会话');
});

/* ------------------------------ 主进程 ------------------------------ */

test('退出软件时会终止还在跑的 ffmpeg', () => {
  const media = read('src/main/media.js');
  assert.match(media, /const activeProcesses = new Set\(\)/);
  assert.match(media, /function cancelAll\(\)/);
  const main = read('src/main/main.js');
  assert.match(main, /media\.cancelAll\(\)/, '孤儿 ffmpeg 会继续满速写盘，用户看不见也停不掉');
});

test('换 mpv 控制器时摘掉旧监听器', () => {
  const main = read('src/main/main.js');
  assert.match(main, /mpv\.removeAllListeners\(\)/, '旧进程迟到的 exit 会把新播放器标记成已关闭');
  assert.match(main, /mpv === controller/, '缺少第二道世代校验');
});

test('换片期间迟到的 mpv exit 不会把新播放器打成已关闭', () => {
  const app = read('src/renderer/app.js');
  const i = app.indexOf('window.sw.mpv.onExit');
  assert.match(app.slice(i, i + 700), /S\.switchingMedia/, '换片窗口内的 exit 要当成预期收尾');
});

test('隐藏的解析窗口不会外放声音', () => {
  const src = read('src/main/browserMediaResolver.js');
  assert.match(src, /setAudioMuted\(true\)/, '用户看不见也关不掉的窗口在放声音');
});

test('浏览器兜底抓到的请求头会被带上', () => {
  const src = read('src/main/linkMedia.js');
  assert.match(
    src,
    /info\?\.http_headers \|\| info\?\.headers/,
    '只认 yt-dlp 的字段名，隔离浏览器抓的 Referer 全被丢掉'
  );
});

test('直链文件名解不开百分号转义时不炸整条解析', () => {
  const src = read('src/main/linkMedia.js');
  assert.match(src, /function fileNameFromUrl/);
  const fn = src.slice(src.indexOf('function fileNameFromUrl'));
  assert.match(fn.slice(0, 400), /catch/, 'decodeURIComponent 遇到非法 % 会抛 URIError');
});

test('yt-dlp 之前会先走一遍跳转链预检，并且局限写在代码里', () => {
  const src = read('src/main/linkMedia.js');
  assert.match(src, /assertRedirectChainIsPublic/);
  assert.match(src, /这只是部分缓解/, '局限必须写在代码里，别让后来人以为已经堵死了');
});

test('choosePrepPlan 重算 FLAC 时带上容器判断', () => {
  const app = read('src/renderer/app.js');
  assert.match(app, /const toMkv = String\(info\.ext \|\| ''\)\.toLowerCase\(\) === '\.mkv'/);
  assert.match(app, /toMkv && chosen && typeof chosen\.flacRatio === 'number'/, 'MP4/MOV 也会被提议转 FLAC');
});
