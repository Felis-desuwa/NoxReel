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
  const host = body('async function startHost(', 'async function startHostLink(');
  const precheck = host.indexOf('await confirmStreamability(');
  const hashing = host.indexOf('window.sw.store.buildManifest(');
  assert.ok(precheck > 0, '要调用 confirmStreamability');
  assert.ok(hashing > precheck, '预判必须在 buildManifest 之前');
});

test('只有可信房间才测上行：安全模式收完才播，不存在中途卡顿', () => {
  const host = body('async function startHost(', 'async function startHostLink(');
  assert.match(host, /S\.roomSecurityMode === 'trusted'\s*\?\s*window\.sw\.net\.estimateUplink\(\)/);
});

test('房主看完提示选择不传时，精简产生的临时文件要清掉', () => {
  const host = body('async function startHost(', 'async function startHostLink(');
  assert.match(host, /if \(!proceed\) \{\s*if \(temporaryPath\) await window\.sw\.media\.releaseTemp\(temporaryPath\)/);
});

test('码率按精简之后真正要传的体积算，而不是原文件', () => {
  const host = body('async function startHost(', 'async function startHostLink(');
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
  const host = body('async function startHost(', 'async function startHostLink(');
  assert.match(host, /canSlimMore: canSlim && !slimmed && Boolean\(S\.env\.ffmpeg\)/);
  const fn = body('async function confirmStreamability(', 'function choosePrepPlan(');
  assert.match(fn, /if \(canSlimMore\) advice\.push\(/);
  assert.match(fn, /if \(!roomEntered\) advice\.push\('改用安全模式开房/);
  assert.match(fn, /roomEntered \? '在邀请区调小房间人数上限' : '在设置里调小新房间的默认人数上限'/);
  // 人数写清楚：上限含房主，分上行的是除房主之外的人
  assert.match(fn, /人数上限 \$\{S\.roomCapacity\} 人，除你之外 \$\{viewers\} 人同时接收/);
});

test('人数按房间人数上限算，而不是按当前在线人数', () => {
  const fn = body('async function confirmStreamability(', 'function choosePrepPlan(');
  assert.match(fn, /const viewers = Math\.max\(1, S\.roomCapacity - 1\);/);
});

test('清单只带半小时内测的房主上行，太旧的数不如不给', () => {
  const host = body('async function startHost(', 'async function startHostLink(');
  assert.match(host, /Date\.now\(\) - S\.uplinkEstimate\.measuredAt < UPLINK_FRESH_MS/);
  assert.match(app, /const UPLINK_FRESH_MS = 30 \* 60 \* 1000;/);
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
  assert.match(app, /没法接收这部片子：\$\{diskFull\[0\]\}/);
});
