'use strict';

// noxreel:// 的系统登记补显示名：浏览器弹窗里别再问「要打开 Electron 吗？」
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { labelProtocolHandler, regArgs, REG_TIMEOUT_MS } = require('../src/main/protocolName');

test('只写 HKCU 下自己那个协议键的 shell\\open\\FriendlyAppName', async () => {
  const calls = [];
  const ok = await labelProtocolHandler({
    platform: 'win32',
    run: (file, args, opts, cb) => {
      calls.push({ file, args, opts });
      cb(null);
    },
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].file, /System32[\\/]reg\.exe$/i, '用系统自带的 reg.exe，不靠 PATH');
  assert.deepEqual(calls[0].args, [
    'add',
    'HKCU\\Software\\Classes\\noxreel\\shell\\open',
    '/v',
    'FriendlyAppName',
    '/t',
    'REG_SZ',
    '/d',
    'NoxReel',
    '/f',
  ]);
  assert.equal(calls[0].opts.timeout, REG_TIMEOUT_MS);
  assert.equal(calls[0].opts.windowsHide, true, '别闪一个控制台窗口');
});

test('不是 Windows 不做；reg.exe 失败、根本起不来都只返回 false，不抛', async () => {
  let ran = 0;
  assert.equal(await labelProtocolHandler({ platform: 'darwin', run: () => ran++ }), false);
  assert.equal(ran, 0);
  assert.equal(await labelProtocolHandler({ platform: 'win32', run: (f, a, o, cb) => cb(new Error('拒绝访问')) }), false);
  assert.equal(
    await labelProtocolHandler({
      platform: 'win32',
      run: () => {
        throw new Error('spawn ENOENT');
      },
    }),
    false
  );
});

test('协议名和显示名都过白名单，拼不进别的注册表路径或 reg 参数', async () => {
  assert.throws(() => regArgs('noxreel\\..\\evil', 'NoxReel'));
  assert.throws(() => regArgs('noxreel', 'NoxReel" /f /v x'));
  assert.throws(() => regArgs('noxreel', ''));
  let ran = 0;
  assert.equal(await labelProtocolHandler({ platform: 'win32', name: 'a&b', run: () => ran++ }), false);
  assert.equal(ran, 0);
});

test('main.js 只在协议真的登记上之后才补显示名，测试实例（NOXREEL_USER_DATA）两样都不碰', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const ready = main.slice(main.indexOf('app.whenReady().then('), main.indexOf('await ensureCacheReady();'));
  assert.match(ready, /if \(!DEV_USER_DATA\) \{/);
  assert.match(ready, /const registered =[\s\S]*?setAsDefaultProtocolClient\('noxreel', process\.execPath/);
  assert.match(ready, /if \(registered\) labelProtocolHandler\(\)\.catch\(\(\) => \{\}\);/);
  // 不 await：写注册表不能拖慢开窗口
  assert.doesNotMatch(ready, /await labelProtocolHandler/);
});
