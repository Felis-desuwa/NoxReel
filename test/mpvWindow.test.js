'use strict';

// mpv 窗口大小记忆：按占屏幕的百分比记（osd-dimensions ÷ display-width/height），下次 --geometry=W%xH% 开窗
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MpvController, buildLaunchArgs, normalizeWindowPref, windowArgs, WINDOW_OBSERVED } = require('../src/main/mpv');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8').replace(/\r\n/g, '\n');

test('记下来的偏好只收 15%–100% 的宽高，保留一位小数；认不出来的当没记过', () => {
  assert.deepEqual(normalizeWindowPref({ w: 50.04, h: 44.96, maximized: true }), { w: 50, h: 45, maximized: true });
  assert.deepEqual(normalizeWindowPref({ w: 100, h: 15, maximized: 'yes' }), { w: 100, h: 15, maximized: false });
  for (const bad of [null, 'x', {}, { w: 10, h: 50 }, { w: 50, h: 101 }, { w: 'a', h: 50 }, { w: NaN, h: 50 }]) {
    assert.equal(normalizeWindowPref(bad), null, JSON.stringify(bad));
  }
});

test('开窗参数：没记过按片子大小（autofit）；记过就 --geometry=W%xH%，最大化的再加 --window-maximized', () => {
  assert.deepEqual(windowArgs(null), ['--autofit=960x540', '--autofit-larger=92%x88%']);
  assert.deepEqual(windowArgs({ w: 60, h: 55.5 }), ['--geometry=60%x55.5%']);
  assert.deepEqual(windowArgs({ w: 60, h: 55.5, maximized: true }), ['--geometry=60%x55.5%', '--window-maximized=yes']);
  const args = buildLaunchArgs({ ipcPath: 'x', source: 'D:/a.mkv', windowPref: { w: 70, h: 60 } });
  assert.ok(args.includes('--geometry=70%x60%'));
  assert.equal(args.some((a) => a.startsWith('--autofit')), false, '按记的开就不再按片子大小缩放');
  assert.ok(args.indexOf('--geometry=70%x60%') < args.indexOf('--'));
  assert.ok(buildLaunchArgs({ ipcPath: 'x', source: 'D:/a.mkv' }).includes('--autofit=960x540'));
});

function controller(pref = null) {
  const ctl = new MpvController();
  const events = [];
  ctl.on('geometry', (p) => events.push(p));
  ctl._resetWindow(pref);
  const set = (props) => {
    for (const [name, value] of Object.entries(props)) ctl._dispatch({ event: 'property-change', name, data: value });
  };
  return { ctl, events, set };
}

test('拖窗口：定下来之后按屏幕百分比报一次；没变不报；属性变化不进 tick', () => {
  const { ctl, events, set } = controller();
  let ticks = 0;
  ctl.on('tick', () => ticks++);
  set({ 'display-width': 2560, 'display-height': 1440, 'osd-dimensions': { w: 1280, h: 720 }, 'window-maximized': false, fullscreen: false });
  ctl._settleWindow();
  assert.deepEqual(events, [{ w: 50, h: 50, maximized: false }]);
  ctl._settleWindow();
  assert.equal(events.length, 1, '没变不报');
  set({ 'osd-dimensions': { w: 1600, h: 900 } });
  ctl._settleWindow();
  assert.deepEqual(events.at(-1), { w: 62.5, h: 62.5, maximized: false });
  assert.equal(ticks, 0, '窗口属性不该冒出 tick');
  clearTimeout(ctl._winTimer);
});

test('最大化：只记「最大化」，不拿最大化的尺寸盖掉平时的大小；全屏时什么都不记；最小化（尺寸为 0）不记', () => {
  const { ctl, events, set } = controller({ w: 50, h: 50 });
  set({ 'display-width': 1920, 'display-height': 1080, 'osd-dimensions': { w: 1920, h: 1040 }, 'window-maximized': true, fullscreen: false });
  ctl._settleWindow();
  assert.deepEqual(events.at(-1), { w: 50, h: 50, maximized: true }, '平时的大小还是上次那个');
  set({ fullscreen: true, 'window-maximized': false, 'osd-dimensions': { w: 1920, h: 1080 } });
  ctl._settleWindow();
  assert.equal(events.length, 1, '全屏不算');
  set({ fullscreen: false, 'osd-dimensions': { w: 0, h: 0 } });
  ctl._settleWindow();
  assert.deepEqual(events.at(-1), { w: 50, h: 50, maximized: false }, '还原了：最大化标志去掉，大小不动');
  clearTimeout(ctl._winTimer);
});

test('接线：观察这几个属性；主进程存进配置、下次开窗带上；退出前把攒着的写掉；PlayerManager 转发', () => {
  assert.deepEqual(WINDOW_OBSERVED, ['osd-dimensions', 'display-width', 'display-height', 'window-maximized', 'fullscreen']);
  const mpv = read('src', 'main', 'mpv.js');
  assert.match(mpv, /observe_property', WINDOW_OBSERVE_BASE \+ i, WINDOW_OBSERVED\[i\]/);
  assert.match(mpv, /this\._resetWindow\(windowPref\);/);
  assert.match(mpv, /\/\/ 关窗前刚拖过的大小还在等「定下来」：马上算一次，别丢了\n\s+this\._settleWindow\(\);/);
  const main = read('src', 'main', 'main.js');
  assert.match(main, /let mpvWindowPref = normalizeWindowPref\(mainConfig\.mpvWindow\);/);
  assert.match(main, /players\.on\('geometry', \(pref\) => \{[\s\S]*?settings\.write\(USER_DATA_DIR, \{ mpvWindow: mpvWindowPref \}\)/);
  assert.match(main, /players\.launch\('mpv', \{[^}]*windowPref: mpvWindowPref,[^}]*growing \}, ticket\)/);
  assert.match(main, /await players\.quit\(\)\.catch\(\(\) => \{\}\);\n\s+\/\/ mpv 窗口大小还攒着没落盘[\s\S]*?settings\.write\(USER_DATA_DIR, \{ mpvWindow: mpvWindowPref \}\)/);
  assert.match(read('src', 'main', 'players', 'index.js'), /adapter\.on\('geometry', \(pref\) => this\.emit\('geometry', pref\)\);/);
  assert.match(read('src', 'main', 'players', 'mpvAdapter.js'), /this\.ctl\.on\('geometry', \(pref\) => this\.emit\('geometry', pref\)\);/);
});
