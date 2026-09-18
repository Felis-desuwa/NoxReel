'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildAssEvent, escapeAss, OVERLAY_ROOM } = require('../src/main/mpv');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const app = read('src', 'renderer', 'app.js');

const BACKSLASH = String.fromCharCode(92);

/**
 * 横幅里会拼进别人的昵称，而 ASS 把花括号当样式覆盖块、把反斜杠当转义引导符。
 * 不清掉的话，对方把昵称改成一个覆盖块就能把横幅挪走或者整条隐形 ——
 * 等于用昵称关掉别人的状态提示。这一组是这次改动里唯一的安全面。
 */
test('昵称里的 ASS 控制字符被清掉，改不了横幅的样式和位置', () => {
  // 把横幅挪到左下角
  assert.equal(escapeAss(BACKSLASH + 'an1'), 'an1');
  // 把横幅整条变透明
  assert.equal(escapeAss('{' + BACKSLASH + 'alpha&HFF&}坏人'), 'alpha&HFF&坏人');
  // 单独的花括号也不能留，否则能和后面的文本凑成一个覆盖块
  assert.equal(escapeAss('a{b}c'), 'abc');
  assert.equal(escapeAss('结尾有个{'), '结尾有个');
  // 正常昵称一个字都不能丢
  assert.equal(escapeAss('小明_123 (๑•̀ㅂ•́)'), '小明_123 (๑•̀ㅂ•́)');
});

test('控制字符换成空格，不会把一条 ASS 事件截断成两条', () => {
  assert.equal(escapeAss('a\u0000b'), 'a b');
  assert.equal(escapeAss('a\u001fb'), 'a b');
  assert.equal(escapeAss('ab'), 'a b');
  // 回车换行尤其关键：ASS 是一行一条事件，漏过去就能伪造第二条
  assert.equal(escapeAss('a\r\nb'), 'a  b');
});

test('样式前缀由我们自己拼，换行标记只可能来自我们', () => {
  const out = buildAssEvent('第一行\n第二行');
  assert.ok(out.startsWith('{' + BACKSLASH + 'an8}'), '顶部居中，避开底部的 OSC 控制条');
  assert.ok(out.includes(BACKSLASH + 'N'), '我们自己插入的换行');
  // 用户文本里的反斜杠已经被清掉，所以整条里的反斜杠都是我们写的
  const fromUser = buildAssEvent('a' + BACKSLASH + 'Nb');
  assert.ok(!fromUser.includes('a' + BACKSLASH + 'Nb'), '用户写的换行标记不能生效');
  assert.ok(fromUser.includes('aNb'), '被清成普通文字');
});

test('空文本和 null 不会拼出畸形事件', () => {
  assert.equal(typeof buildAssEvent(null), 'string');
  assert.equal(typeof buildAssEvent(''), 'string');
  assert.ok(!buildAssEvent(null).includes('undefined'));
  assert.ok(!buildAssEvent(null).includes('null'));
});

/**
 * 为什么是 osd-overlay 而不是重复发 show-text：show-text 和 mpv 自己的消息
 * （音量、切字幕、跳转进度条）共用一个槽位，一条要挂几分钟的横幅会被它们冲掉。
 */
test('常驻横幅走独立的 ASS 图层，不跟 show-text 抢槽位', () => {
  const mpv = read('src', 'main', 'mpv.js');
  assert.match(mpv, /'osd-overlay',\s*id,\s*'ass-events'/);
  assert.match(mpv, /show-text/, '一次性提示仍然走 show-text');
  // 文本没变就不发命令 —— renderStatus 每个 tick 都跑一遍
  assert.match(mpv, /if \(this\._overlays\.get\(id\) === next\) return Promise\.resolve\(\);/);
  // 新进程身上没有覆盖层，缓存不清零横幅就再也不重发
  assert.match(mpv, /forgetOverlays\(\)/);
});

test('层 id 不由渲染进程决定，文本长度有上限', () => {
  const main = read('src', 'main', 'main.js');
  const adapter = read('src', 'main', 'players', 'mpvAdapter.js');
  assert.equal(OVERLAY_ROOM, 1);
  assert.match(main, /players\.setBanner\(validate\.string\(text, '覆盖层文本', \{ max: 400/);
  assert.match(adapter, /setOverlay\(OVERLAY_ROOM, text\)/, '层 id 由适配器固定，不从渲染进程来');
});

test('渲染端也去重，并在播放器重启时清零', () => {
  assert.match(app, /if \(next === lastMpvBanner\) return;/);
  // 三处生命周期变化都要清零：拉起、正常退出、换片
  assert.ok(app.split("lastMpvBanner = ''").length - 1 >= 3, '拉起／退出／换片都要清零');
  // 发完就不管：在 tick 处理器里 await 会让 mpv 那条 socket 上的命令乱序
  assert.match(app, /window\.sw\.player\.overlay\(next \? t\(next\) : ''\)\.catch\(\(\) => \{\}\);/);
});

/**
 * 全员暂停期间在 mpv 里按空格，引擎会把暂停压回去并 emit denied。
 * 以前 app.js 只处理 seek，play 那一路被静默吞掉 —— 画面弹回暂停却一个字不给。
 */
test('全员暂停时按播放有反馈，而且只做提示不改状态', () => {
  const start = app.indexOf("S.sync.on('denied'");
  assert.ok(start > 0);
  const end = app.indexOf("S.swarm.on('manifest-bad'", start);
  assert.ok(end > start, '找不到 denied 处理器的结尾');
  const body = app.slice(start, end);
  assert.ok(body.length > 200, `切出来的处理器太短（${body.length} 字符），断言会形同虚设`);
  assert.match(body, /if \(action === 'play'\)/);
  // 连按空格会连发，得节流
  assert.match(body, /lastPlayDeniedAt/);
  // 这一支只负责说话：改 intendedPaused 或再调一次 _reconcile 会和引擎打架
  assert.doesNotMatch(body, /intendedPaused/);
  assert.doesNotMatch(body, /_reconcile/);
});

test('等待时间取最慢的那个人，算不出来就不给数', async () => {
  const { worstWaitSeconds } = await import('../src/renderer/lib/stallForecast.js');
  // 房间要等最慢的那个攒够才恢复 —— 取最大值，不是最小、不是平均
  assert.equal(worstWaitSeconds([{ waitSec: 30 }, { waitSec: 150 }, { waitSec: 90 }]), 150);
  assert.equal(worstWaitSeconds([{ waitSec: 42 }]), 42);
  // 任何一个人算不出来就整个放弃：少一个人的数，最大值必然偏乐观
  assert.equal(worstWaitSeconds([{ waitSec: 150 }, null]), null);
  assert.equal(worstWaitSeconds([{ waitSec: 150 }, undefined]), null);
  assert.equal(worstWaitSeconds([{ waitSec: 150 }, { waitSec: Infinity }]), null);
  // 没人需要等就别显示一个 0:00
  assert.equal(worstWaitSeconds([]), null);
  assert.equal(worstWaitSeconds([{ waitSec: 0 }]), null);
});

test('等待时间按 peerId 取预判，而不是按名字', () => {
  const fn = app.slice(app.indexOf('function stallWaitSeconds('), app.indexOf('function stallBannerText('));
  assert.ok(fn.length > 100);
  // status().waitingFor 返回的是名字，和 lastForecasts 的键对不上，join 不起来
  assert.match(fn, /S\.sync\.stalledPeers\.keys\(\)/);
  assert.doesNotMatch(fn, /waitingFor/);
  // 自己卡住时也要算进去
  assert.match(fn, /S\.sync\.localStalled/);
});

test('自己的播放暂停跳转也进日志，不只是记录别人', () => {
  assert.match(app, /S\.sync\.on\('local-action'/);
  assert.match(app, /（只影响你自己）/, '游客的操作要说明只影响自己');
});
