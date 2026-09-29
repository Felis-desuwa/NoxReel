'use strict';

// 在线视频的清晰度：本人选一个上限（按短边的像素，0 = 最高），播放器那一路经 ytdl_hook 的 -S res:N，
// 手动缓存和边下边播的下载经 yt-dlp 的 --format-sort res:N。只影响本机这一路。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8').replace(/\r\n/g, '\n');
const APP = read('src', 'renderer', 'app.js');

function fnSource(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层函数 ${name}`);
  const end = APP.indexOf('\n}\n', m.index);
  return APP.slice(m.index, end + 2);
}

function declSource(name) {
  const m = new RegExp(`^(?:let|const) ${name} = [^\\n]+;$`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层声明 ${name}`);
  return m[0];
}

/* ------------------------------ 主进程 ------------------------------ */

test('清晰度参数只收 0（不限）或 144–4320 的整数：它会拼进 yt-dlp 的参数里', () => {
  const { linkMaxHeight } = require('../src/main/security');
  assert.equal(linkMaxHeight(undefined), 0);
  assert.equal(linkMaxHeight(null), 0);
  assert.equal(linkMaxHeight(0), 0);
  assert.equal(linkMaxHeight(720), 720);
  assert.equal(linkMaxHeight(4320), 4320);
  for (const bad of ['720', 720.5, 100, 5000, -1, NaN, '720 --exec calc', [720], { h: 720 }]) {
    assert.throws(() => linkMaxHeight(bad), /清晰度/, JSON.stringify(bad));
  }
});

test('播放器：在线链接带上 ytdl_hook 的 format-sort=res:N（不动 mpv 默认的 bestvideo+bestaudio），本地文件不带', () => {
  const { buildLaunchArgs } = require('../src/main/mpv');
  const flag = '--ytdl-raw-options-append=format-sort=res:720';
  const remote = buildLaunchArgs({ ipcPath: 'x', source: 'https://www.bilibili.com/video/BV1/', maxHeight: 720 });
  assert.ok(remote.includes(flag));
  assert.ok(remote.indexOf(flag) < remote.indexOf('--'), '选项必须在 -- 之前');
  assert.equal(remote.some((a) => a.startsWith('--ytdl-format')), false, '不改格式串，分开的两条流照样由 mpv 合');
  assert.equal(buildLaunchArgs({ ipcPath: 'x', source: 'https://www.bilibili.com/video/BV1/' }).some((a) => a.includes('format-sort')), false, '0 = 不限');
  assert.equal(buildLaunchArgs({ ipcPath: 'x', source: 'D:/片子.mkv', maxHeight: 720 }).some((a) => a.includes('format-sort')), false);
});

test('主进程接线：player:launch / 手动缓存 / 边下边播下载都先过 linkMaxHeight 再往下传；preload 原样带过去', () => {
  const main = read('src', 'main', 'main.js');
  assert.match(main, /kind = 'mpv', maxHeight = 0 \} = validate\.plainObject\(\s*payload,\s*'播放器启动参数'/);
  assert.match(main, /const heightCap = validate\.linkMaxHeight\(maxHeight\);/);
  assert.match(main, /players\.launch\('mpv', \{[^}]*maxHeight: remote \? heightCap : 0, growing \}, ticket\)/, '本地文件不带');
  assert.match(main, /purpose: 'cache', maxHeight: heightCap \}\)/);
  assert.match(main, /purpose: 'download', maxHeight: heightCap \}\)/);
  const adapter = read('src', 'main', 'players', 'mpvAdapter.js');
  assert.match(adapter, /this\.ctl\.launch\(source, \{[^}]*maxHeight[^}]*\}\)/);
  const preload = read('src', 'main', 'preload.js');
  assert.match(preload, /ipcRenderer\.invoke\('player:launch', \{[^}]*maxHeight \}\)/);
  assert.match(preload, /start: \(url, title, maxHeight = 0\) => ipcRenderer\.invoke\('linkCache:start', \{ url, title, maxHeight \}\)/);
  assert.match(preload, /saveLink: \(url, title, maxHeight = 0\) => ipcRenderer\.invoke\('download:saveLink', \{ url, title, maxHeight \}\)/);
});

test('解析结果带上这一页有哪几档（按短边，和 -S res:N 同一个量法），从高到低', () => {
  const { videoHeights } = require('../src/main/linkMedia');
  const formats = [
    { vcodec: 'none', acodec: 'mp4a' }, // 纯音频不算
    { width: 1920, height: 1080, vcodec: 'av01' },
    { width: 1920, height: 1080, vcodec: 'avc1' },
    { width: 852, height: 480, vcodec: 'avc1' },
    { width: 1080, height: 1920, vcodec: 'avc1' }, // 竖屏：短边 1080
    { width: 640, height: 360 },
    { height: 'x' },
    { width: 50, height: 40 }, // 缩略图级别的不算
  ];
  assert.deepEqual(videoHeights({ formats }), [1080, 480, 360]);
  assert.deepEqual(videoHeights({}), []);
  assert.deepEqual(videoHeights(null), []);
});

test('手动缓存 / 边下边播：选了清晰度就给 yt-dlp --format-sort res:N，没选不带', () => {
  const { LinkCache } = require('../src/main/linkCache');
  const cache = new LinkCache({ findYtDlp: () => 'y', proxyInfo: async () => ({}), resolve: async () => null, placement: async () => ({}) });
  const job = (maxHeight) => ({ id: 'a', url: 'https://www.bilibili.com/video/BV1/', title: '', workDir: 'D:/w', maxHeight });
  const capped = cache._args(job(720), 'https://www.bilibili.com/video/BV1/', [], { url: 'http://127.0.0.1:1' });
  assert.equal(capped[capped.indexOf('--format-sort') + 1], 'res:720');
  assert.ok(capped.indexOf('--format-sort') < capped.indexOf('--'));
  assert.equal(cache._args(job(0), 'https://x.example/', [], { url: 'http://127.0.0.1:1' }).includes('--format-sort'), false);
  // start 只认正整数，别的一律当不限
  const started = [];
  cache._pump = () => {};
  cache.start({ url: 'https://a.example/1', maxHeight: 480 });
  cache.start({ url: 'https://a.example/2', maxHeight: '480' });
  for (const j of cache.jobs.values()) started.push(j.maxHeight);
  assert.deepEqual(started, [480, 0]);
});

/* ------------------------------ 界面 ------------------------------ */

function qualityUi({ linkInfo, filePath, sourceType = 'link', mpvRunning = true, linkQuality = 0, stored = {} } = {}) {
  const nodes = new Map();
  const el = (id) => ({
    id,
    value: '',
    disabled: false,
    children: [],
    classes: new Set(['hidden']),
    classList: {
      toggle(c, on) {
        if (on) this.owner.classes.add(c);
        else this.owner.classes.delete(c);
      },
    },
  });
  const $ = (id) => {
    if (!nodes.has(id)) {
      const node = el(id);
      node.classList.owner = node;
      nodes.set(id, node);
    }
    return nodes.get(id);
  };
  const calls = [];
  const logs = [];
  const S = { sourceType, mpvRunning, linkInfo, filePath, switchingPlayer: false, settings: { linkQuality } };
  const ctx = {
    S,
    $,
    roomEntered: true,
    make: (tag, o = {}) => ({ tag, ...o }),
    replace: (node, ...kids) => {
      node.children = kids.flat();
    },
    log: (text, tone) => logs.push([text, tone]),
    localStorage: { setItem: (k, v) => (stored[k] = v), getItem: (k) => stored[k] ?? null },
    renderPlayerControls: () => calls.push('renderPlayerControls'),
    relaunchWithPlayer: async () => {
      calls.push(['relaunch', S.settings.linkQuality, S.switchingPlayer]);
      return true;
    },
    errText: (e) => String(e?.message || e),
  };
  vm.createContext(ctx);
  const sources = [
    declSource('LINK_QUALITY_DEFAULTS'),
    declSource('qualityKey'),
    ...['normalizeLinkQuality', 'linkQualityApplies', 'linkQualityOptions', 'renderQualityControl', 'setLinkQuality'].map(fnSource),
  ];
  vm.runInContext(sources.join('\n\n'), ctx, { filename: 'app.js（节选）' });
  return { ctx, S, $, calls, logs, stored };
}

const PAGE = 'https://www.bilibili.com/video/BV1XPaY6hEes/';

test('清晰度下拉框：只在交给 mpv 的是网页地址时出现，列出这一页实际有的几档', () => {
  const ui = qualityUi({ linkInfo: { url: PAGE, heights: [1080, 720, 480, 360] }, filePath: PAGE });
  ui.ctx.renderQualityControl();
  const box = ui.$('quality-box');
  const select = ui.$('link-quality');
  assert.equal(box.classes.has('hidden'), false);
  assert.deepEqual(
    select.children.map((o) => [o.attrs.value, o.text]),
    [
      ['0', '最高'],
      ['1080', '1080p'],
      ['720', '720p'],
      ['480', '480p'],
      ['360', '360p'],
    ]
  );
  assert.equal(select.value, '0');

  // 本地缓存、隔离浏览器抓来的直链、房主给的临时地址：只有一条，不摆
  for (const [linkInfo, filePath] of [
    [{ url: PAGE, local: true }, 'D:/缓存/片.mp4'],
    [{ url: PAGE, extractor: 'isolated-browser', playback: { url: 'https://cdn.example/v.mp4' } }, 'https://cdn.example/v.mp4'],
  ]) {
    const other = qualityUi({ linkInfo, filePath });
    other.ctx.renderQualityControl();
    assert.equal(other.$('quality-box').classes.has('hidden'), true, filePath);
  }
  const file = qualityUi({ sourceType: 'file', linkInfo: null, filePath: 'D:/a.mkv' });
  file.ctx.renderQualityControl();
  assert.equal(file.$('quality-box').classes.has('hidden'), true);
});

test('本人选过的那一档这一页没有也留在列表里；网站不报尺寸时给常见的几档', () => {
  const ui = qualityUi({ linkInfo: { url: PAGE, heights: [1080, 480] }, filePath: PAGE, linkQuality: 720 });
  ui.ctx.renderQualityControl();
  assert.deepEqual(ui.$('link-quality').children.map((o) => o.attrs.value), ['0', '1080', '720', '480']);
  assert.equal(ui.$('link-quality').value, '720');
  const unknown = qualityUi({ linkInfo: { url: PAGE, heights: [] }, filePath: PAGE });
  unknown.ctx.renderQualityControl();
  assert.deepEqual(unknown.$('link-quality').children.map((o) => o.attrs.value), ['0', '2160', '1440', '1080', '720', '480', '360']);
});

test('换清晰度：存在本机；正在放就原位重开播放器（换的期间下拉框锁住），没在放只记下', async () => {
  const ui = qualityUi({ linkInfo: { url: PAGE, heights: [1080, 720] }, filePath: PAGE });
  await ui.ctx.setLinkQuality('720');
  assert.equal(ui.S.settings.linkQuality, 720);
  assert.equal(ui.stored['sw.linkQuality'], '720');
  assert.deepEqual(ui.calls.filter((c) => Array.isArray(c)), [['relaunch', 720, true]], '重开时 switchingPlayer 占着，别的切换让开');
  assert.equal(ui.S.switchingPlayer, false, '收完尾放开');
  assert.deepEqual(ui.logs.at(-1), ['在线视频的清晰度改成不超过 720p', 'good']);

  await ui.ctx.setLinkQuality('720');
  assert.equal(ui.calls.filter((c) => Array.isArray(c)).length, 1, '没变不重开');

  const idle = qualityUi({ linkInfo: { url: PAGE }, filePath: PAGE, mpvRunning: false });
  await idle.ctx.setLinkQuality('0x');
  assert.equal(idle.S.settings.linkQuality, 0, '乱填的当最高');
  await idle.ctx.setLinkQuality('480');
  assert.equal(idle.stored['sw.linkQuality'], '480');
  assert.equal(idle.calls.some((c) => Array.isArray(c)), false, '没在放：只记下，下次起播就用它');
});

test('界面接线：起播、手动缓存、边下边播都带上本人选的清晰度；设置默认最高、存在本机', () => {
  assert.match(APP, /linkQuality: normalizeLinkQuality\(localStorage\.getItem\('sw\.linkQuality'\)\),/);
  assert.match(fnSource('launchPlayer'), /maxHeight: S\.sourceType === 'link' \? S\.settings\.linkQuality : 0,/);
  assert.match(fnSource('startLinkCache'), /window\.sw\.linkCache\.start\(item\.url, item\.title \|\| '', S\.settings\.linkQuality\)/);
  assert.match(fnSource('saveLinkDownload'), /window\.sw\.download\.saveLink\(item\.url, item\.title \|\| '', S\.settings\.linkQuality\)/);
  assert.match(fnSource('renderDrift'), /renderQualityControl\(\);/, '跟着状态一起刷新');
  assert.match(read('src', 'renderer', 'index.html'), /id="quality-box"[\s\S]*?<select class="player-pick" id="link-quality" aria-label="清晰度"><\/select>/);
});

test('清晰度的文案都有英文', async () => {
  const { pathToFileURL } = require('node:url');
  const { translate } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/lib/i18n.js')).href);
  const en = (s) => translate(s, 'en');
  assert.equal(en('清晰度'), 'Quality');
  assert.equal(en('最高'), 'Best');
  assert.equal(en('在线视频的清晰度改成不超过 720p'), 'Online video quality capped at 720p');
  assert.equal(en('在线视频的清晰度改成最高'), 'Online video quality set to best');
  assert.equal(en('换清晰度失败：切换播放器失败：boom'), 'Could not change quality: Could not switch player: boom');
  assert.notEqual(en('在线视频的清晰度：不超过所选这一档，这一档没有就用低一档。只影响你自己，手动缓存和边下边播也按它下。'), '在线视频的清晰度：不超过所选这一档，这一档没有就用低一档。只影响你自己，手动缓存和边下边播也按它下。');
});
