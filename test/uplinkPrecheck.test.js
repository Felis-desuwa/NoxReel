'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { pickThroughput, ENDPOINT } = require('../src/main/uplink.js');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const app = read('src', 'renderer', 'app.js');

/**
 * 短样本被 TCP 握手和慢启动拖低：实测这台机器 1MB 那次只有 31Mbps，12MB 那次 230Mbps，
 * 服务端 Server-Timing 里的 recv_bytes 证实后者才是真实速度。拿短样本会系统性低估。
 */
test('测速取足够长的样本里最快的那次，不被慢启动的短样本拉低', () => {
  const samples = [
    { bytes: 256 * 1024, ms: 90 },
    { bytes: 1024 * 1024, ms: 268 },
    { bytes: 4 * 1024 * 1024, ms: 450 },
    { bytes: 12 * 1024 * 1024, ms: 436 },
  ];
  const expected = (12 * 1024 * 1024 * 1000) / 436;
  assert.equal(pickThroughput(samples), expected);
});

test('一个够长的样本都没有时退回用最大的那次（快线路上所有请求都很快）', () => {
  const samples = [
    { bytes: 1024 * 1024, ms: 20 },
    { bytes: 12 * 1024 * 1024, ms: 100 },
  ];
  assert.equal(pickThroughput(samples), (12 * 1024 * 1024 * 1000) / 100);
});

test('没有有效样本时返回 0，由调用方报「没测出来」', () => {
  assert.equal(pickThroughput([]), 0);
  assert.equal(pickThroughput(undefined), 0);
  assert.equal(pickThroughput([{ bytes: 0, ms: 100 }, { bytes: 100, ms: 0 }]), 0);
});

test('测速只打 Cloudflare 的上传接口，走 HTTPS', () => {
  assert.equal(ENDPOINT, 'https://speed.cloudflare.com/__up');
  const src = read('src', 'main', 'uplink.js');
  // 只发随机字节：请求体必须来自 crypto.randomBytes，不能碰任何文件
  assert.match(src, /crypto\.randomBytes\(bytes\)/);
  assert.doesNotMatch(src, /require\(['"](?:fs|fs\/promises|\.\/fileStore)['"]\)/);
});

test('测速能力经 IPC 暴露：主进程注册、preload 转发', () => {
  assert.match(read('src', 'main', 'main.js'), /secureHandle\('net:estimateUplink'/);
  assert.match(read('src', 'main', 'preload.js'), /estimateUplink: \(opts\) => ipcRenderer\.invoke\('net:estimateUplink', opts\)/);
});

function body(name, next) {
  const start = app.indexOf(name);
  const end = app.indexOf(next, start + name.length);
  assert.ok(start >= 0 && end > start, `找不到 ${name}`);
  return app.slice(start, end);
}

/**
 * 预判必须发生在算哈希之前：大文件哈希要算好几分钟，房主要是看完提示决定不传了，
 * 白等这几分钟是纯损失。
 */
test('房主选片时先做卡顿预判，再算分片哈希', () => {
  // 准备流程抽成了 prepareLocalFile：首页开房和房间里加片走同一条路
  const host = body('async function prepareLocalFile(', 'async function startHostMany(');
  const precheck = host.indexOf('await confirmStreamability(');
  const hashing = host.indexOf('window.sw.store.buildManifest(');
  assert.ok(precheck > 0, '要调用 confirmStreamability');
  assert.ok(hashing > precheck, '预判必须在 buildManifest 之前');
  // 算哈希要带任务号，才能中途叫停、分清进度是谁的
  assert.match(host, /window\.sw\.store\.buildManifest\(filePath, taskId\)/);
  // 首页开房仍然走这条路；startHost 和 startHostLink 的相对位置别的测试也在用
  const start = body('async function startHost(', 'async function startHostLink(');
  assert.match(start, /await prepareLocalFile\(filePath, reporter\)/);
});

test('只有可信房间才测上行：安全模式收完才播，不存在中途卡顿', () => {
  const host = body('async function prepareLocalFile(', 'async function startHostMany(');
  assert.match(host, /S\.roomSecurityMode === 'trusted'\s*\?\s*uplinkForPrecheck\(\)\s*:\s*null/);
});

/**
 * 房间里加片时多半已经在给别人供片：这时重测上行既测不准，又会挤占大家的带宽。
 */
test('房间里加片复用半小时内的测速结果，供片期间绝不重测', () => {
  const fn = body('function uplinkForPrecheck(', 'async function prepareLocalFile(');
  const fresh = fn.indexOf('if (uplinkFresh())');
  const seeding = fn.indexOf('if (seedingToOthers())');
  const measure = fn.indexOf('window.sw.net.estimateUplink()');
  assert.ok(fresh >= 0 && seeding > fresh && measure > seeding, '顺序应是：新鲜结果 → 正在供片 → 才去测');
  assert.match(fn, /if \(seedingToOthers\(\)\) return Promise\.resolve\(\{ ok: false,/);
  const seed = body('function seedingToOthers(', 'function uplinkForPrecheck(');
  assert.match(seed, /connectedPeerCount\(\) > 0/);
  assert.match(seed, /sess\.isSeeder/);
});

test('房主看完提示选择不传时，精简产生的临时文件要清掉', () => {
  const host = body('async function prepareLocalFile(', 'async function startHostMany(');
  assert.match(host, /if \(!proceed\) \{\s*if \(temporaryPath\) await window\.sw\.media\.releaseTemp\(temporaryPath\)/);
  // 中途取消（行内点了取消）和出错同样要收拾：临时文件或已开的做种会话
  assert.match(host, /if \(cancelled\(\)\) return release\(\);/);
  assert.match(host, /if \(preparedSessionId\) await window\.sw\.store\.close\(preparedSessionId\)[\s\S]*?else await release\(\);/);
});

test('码率按精简之后真正要传的体积算，而不是原文件', () => {
  const host = body('async function prepareLocalFile(', 'async function startHostMany(');
  assert.match(host, /let finalSize = info\.size;/);
  assert.match(host, /if \(result\.outputSize > 0\) finalSize = result\.outputSize;/);
  assert.match(host, /confirmStreamability\(\{\s*size: finalSize,/);
});

test('预判不拦截无法下结论的情况：测不出上行、或不知道时长', () => {
  const fn = body('async function confirmStreamability(', 'function choosePrepPlan(');
  assert.match(fn, /if \(!\(bitrate > 0\)\) \{[\s\S]*?return true;/);
  assert.match(fn, /if \(!measured\?\.ok\) \{[\s\S]*?return true;/);
  assert.match(fn, /if \(verdict\.level === 'ok' \|\| verdict\.level === 'unknown'\) return true;/);
  // 主进程测速最坏要二十秒，这边必须有自己的等待上限
  assert.match(fn, /Promise\.race\(\[/);
  // 会卡时是「问」，由房主决定继续还是返回
  assert.match(fn, /okText: '仍然继续'/);
  assert.match(fn, /onCancel: \(\) => resolve\(false\)/);
});

/**
 * 真机上第一次弹出来时，建议里写着「上一步选无损精简」—— 可那个片子根本没有能精简的轨，
 * 那一步压根没出现过。建议只能列当下真做得到的事。
 */
test('建议只列真做得到的：没得精简不提精简，房间开着不提改安全模式', () => {
  const host = body('async function prepareLocalFile(', 'async function startHostMany(');
  assert.match(host, /canSlimMore: canSlim && !slimmed && Boolean\(S\.env\.ffmpeg\)/);
  const fn = body('async function confirmStreamability(', 'function choosePrepPlan(');
  assert.match(fn, /if \(canSlimMore\) advice\.push\(/);
  assert.match(fn, /if \(!roomEntered\) advice\.push\('改用安全模式开房/);
  assert.match(fn, /roomEntered \? '在邀请区调小房间人数上限' : '在设置里调小新房间的默认人数上限'/);
  // 管理员改不了人数上限，不给这条建议
  assert.match(fn, /if \(!asAdmin\) advice\.push\(roomEntered \? '在邀请区调小房间人数上限'/);
  // 人数写清楚：上限含房主，分上行的是除房主之外的人
  assert.match(fn, /人数上限 \$\{S\.roomCapacity\} 人，除你之外 \$\{viewers\} 人同时接收/);
});

test('人数按房间人数上限算，而不是按当前在线人数', () => {
  const fn = body('async function confirmStreamability(', 'function choosePrepPlan(');
  assert.match(fn, /let viewers = Math\.max\(1, S\.roomCapacity - 1\);/);
  // 管理员加片：星型模式只传给房主一人，网状模式按在线人数（管理员改不了人数上限）
  assert.match(fn, /const asAdmin = roomEntered && !isRoomHost\(\);/);
  assert.match(fn, /if \(asAdmin\) viewers = S\.mode === 'manual' \? 1 : Math\.max\(1, connectedPeerCount\(\)\);/);
});

test('清单只带半小时内测的片源上行，太旧的数不如不给', () => {
  const fresh = body('function uplinkFresh(', 'function seedingToOthers(');
  assert.match(fresh, /Date\.now\(\) - S\.uplinkEstimate\.measuredAt < UPLINK_FRESH_MS/);
  assert.match(app, /const UPLINK_FRESH_MS = 30 \* 60 \* 1000;/);
  const host = body('async function prepareLocalFile(', 'async function startHostMany(');
  assert.match(host, /\.\.\.\(uplinkFresh\(\) \? \{ sourceUplinkBps: Math\.round\(S\.uplinkEstimate\.bytesPerSec\) \} : \{\}\)/);
  // 0.6 的字段名不再用
  assert.doesNotMatch(app, /\buplinkBps\b/);
});

test('成员列表每人一条预判，房主面板汇总会卡的人数', () => {
  const peers = body('function renderPeers(', "$('peer-list').addEventListener");
  assert.match(peers, /const forecasts = updatePeerForecasts\(list\);/);
  assert.match(peers, /renderHostVerdict\(list\);/);
  assert.match(peers, /className: `peer-forecast \$\{tone\}`/);
  const host = body('function renderHostVerdict(', 'function renderPeers(');
  assert.match(host, /stat\('文件码率'/);
  assert.match(host, /stat\('上行带宽（预估）'/);
  assert.match(host, /stat\('当前上传'/);
  assert.match(host, /人按现在的速度会卡/);
});

test('磁盘放不下和清单不安全分开报，不混成一句', () => {
  assert.match(app, /const diskFull = message\.match\(\/磁盘空间不够：\[\^\\n\]\*\/\);/);
  // 0.7 起列表里可能同时有好几部，要说清楚是哪一部放不下
  assert.match(app, /没法接收《\$\{item\.name\}》：\$\{diskFull\[0\]\}/);
});

/**
 * 「会卡」只是坏消息，房主和成员真正拿来做决定的是「先等多久就不用再等了」。
 * 两处都要给：成员自己的面板给完整一句，房主的成员列表每人跟一句。
 */
test('会卡时给出「再缓冲多久可一路看完」，不会卡时不显示', () => {
  const verdict = body('function renderTransferVerdict(', 'function drawChunkMap(');
  assert.match(verdict, /const lead = bufferLead\(\{/);
  // 必须在 stall 分支里：不卡的人这个数恒为 0，摆出来只会让人以为还得等
  const stall = verdict.indexOf("forecast.level === 'stall'");
  const thin = verdict.indexOf("forecast.level === 'thin'");
  const lead = verdict.indexOf('const lead = bufferLead(');
  assert.ok(stall >= 0 && lead > stall && lead < thin, 'bufferLead 要在 stall 分支内');
  // 速度为 0 时 waitSec 是 Infinity，fmtTime 会渲染成 0:00 —— 得挡住
  assert.match(verdict, /lead\.waitSec > 0 && Number\.isFinite\(lead\.waitSec\)/);
  assert.match(verdict, /再缓冲 \$\{fmtTime\(lead\.waitSec\)\} 可一路看完，届时手上有 \$\{fmtTime\(lead\.bufferSec\)\} 的画面/);
});

test('成员列表里每个会卡的人都跟一句「再缓冲多久可看完」', () => {
  const update = body('function updatePeerForecasts(', 'function forecastLabel(');
  assert.match(update, /forecast\.level === 'stall'\s*\?\s*bufferLead\(\{/);
  assert.match(update, /next\.set\(info\.peerId, \{ \.\.\.forecast, rate, held, lead \}\)/);
  const label = body('function forecastLabel(', 'function renderHostVerdict(');
  assert.match(label, /Number\.isFinite\(wait\) \? `\$\{base\} · 再缓冲 \$\{fmtTime\(wait\)\} 可看完` : base/);
});

/**
 * 上面几条是对源码文本的断言 —— 换个等价写法就会假红/假绿。真正要钉住的是
 * 「传进 forecastStall / bufferLead 的是从播放位置起的 runEndBytes，不是从文件头起的
 * 水位线」，所以这里把 renderTransferVerdict 真跑一遍，看它究竟拿了哪个数。
 * 中途加入时两者差着整整一部片：拿水位线会把「不影响看完」的 [0,P) 回填也算进等待时间。
 */
async function runTransferVerdict(p, { playhead = 0, size = 2e9, level = 'stall' } = {}) {
  const vm = require('node:vm');
  const calls = { forecast: [], lead: [] };
  const parts = [];
  const node = { className: '', classList: { add: () => {}, remove: () => {} } };
  const ctx = {
    S: { manifest: { size, sourceUplinkBps: 0 }, roomSecurityMode: 'trusted', sourceType: 'file', mpvRunning: true },
    $: () => node,
    servingCurrent: () => false,
    renderHostVerdict: () => {},
    currentFileCtx: () => ({ scheduler: { bytesPerSecond: 1e6 } }),
    midJoinNow: () => playhead > 0,
    roomPlayheadByte: () => playhead,
    startRunNeeded: () => 0,
    HEAD_READY_BYTES: 8 * 1024 * 1024,
    stat: (label, value) => ({ label, value }),
    make: (tag, o) => ({ tag, ...o }),
    fmtBytes: (n) => `${n} B`,
    fmtTime: (n) => `${n}s`,
    fmtMbps: (n) => `${n} bps`,
    replace: (_n, ...items) => parts.push(...items),
    forecastStall: (args) => {
      calls.forecast.push(args);
      return { level, stallInSec: 10 };
    },
    bufferLead: (args) => {
      calls.lead.push(args);
      return { waitSec: 30, bufferSec: 100 };
    },
  };
  vm.createContext(ctx);
  const src = body('function renderTransferVerdict(', 'function drawChunkMap(').replace(/\r\n/g, '\n');
  vm.runInContext(src, ctx, { filename: 'app.js（节选）' });
  ctx.renderTransferVerdict(p);
  return calls;
}

test('预缓冲时间按播放头算，和会卡预判用同一套输入', async () => {
  const size = 2e9;
  const playhead = 1e9;
  // 中途加入的典型形状：水位线只有片头 8MB，但从播放位置起还有 200MB 连续可播
  const p = {
    complete: false,
    ratio: 0.2,
    downRate: 5e6,
    contiguousBytes: 8 * 1024 * 1024,
    runEndBytes: playhead + 200e6,
    runBytes: 200e6,
  };
  const calls = await runTransferVerdict(p, { playhead, size });
  assert.equal(calls.forecast.length, 1);
  assert.equal(calls.lead.length, 1, 'bufferLead 只在会卡的时候算');
  for (const args of [calls.forecast[0], calls.lead[0]]) {
    assert.equal(args.contiguous, p.runEndBytes, '传的是从文件头起的水位线，中途加入时差着整整一部片');
    assert.notEqual(args.contiguous, p.contiguousBytes);
    assert.equal(args.playhead, playhead);
    assert.equal(args.size, size);
    assert.equal(args.bitrate, 1e6);
    assert.equal(args.rate, p.downRate);
  }
});

test('不会卡的人不算 bufferLead（那个数恒为 0，摆出来只会让人以为还得等）', async () => {
  const p = { complete: false, ratio: 0.9, downRate: 5e6, contiguousBytes: 1e9, runEndBytes: 2e9, runBytes: 1e9 };
  for (const level of ['ok', 'thin']) {
    const calls = await runTransferVerdict(p, { playhead: 1e9, level });
    assert.equal(calls.forecast.length, 1);
    assert.equal(calls.lead.length, 0, `${level} 也算了预缓冲时间`);
  }
});
