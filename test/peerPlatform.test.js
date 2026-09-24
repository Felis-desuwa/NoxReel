'use strict';

// 成员表上的设备标记：HELLO 里报的平台只认白名单，电脑端按 process.platform 定自己报什么
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = (file) => import(pathToFileURL(path.join(__dirname, '../src/renderer/lib', file)).href);

test('normalizePlatform 只认 windows / mac / linux / android，其余一律 desktop', async () => {
  const { normalizePlatform, PLATFORMS } = await load('protocol.js');
  assert.deepEqual(PLATFORMS, ['windows', 'mac', 'linux', 'android']);
  for (const ok of PLATFORMS) assert.equal(normalizePlatform(ok), ok);
  for (const bad of ['desktop', undefined, null, '', 'Windows', 'ANDROID', 'ios', 'windows ', 42, ['windows'], { toString: () => 'mac' }]) {
    assert.equal(normalizePlatform(bad), 'desktop', JSON.stringify(bad));
  }
});

test('platformOfOs 把 Node 的 process.platform 换成 HELLO 里报的值', async () => {
  const { platformOfOs } = await load('protocol.js');
  assert.equal(platformOfOs('win32'), 'windows');
  assert.equal(platformOfOs('darwin'), 'mac');
  assert.equal(platformOfOs('linux'), 'linux');
  // 主进程的 env 还没到、或者是没见过的系统：笼统报「电脑」
  for (const os of [undefined, '', 'freebsd', 'android']) assert.equal(platformOfOs(os), 'desktop', String(os));
});

test('Swarm 在 HELLO 里报的是过了白名单的平台', async () => {
  const { Swarm } = await load('swarm.js');
  assert.equal(new Swarm({ peerId: 'a', name: 'a', platform: 'windows' }).platform, 'windows');
  assert.equal(new Swarm({ peerId: 'a', name: 'a', platform: 'android' }).platform, 'android');
  assert.equal(new Swarm({ peerId: 'a', name: 'a' }).platform, 'desktop');
  assert.equal(new Swarm({ peerId: 'a', name: 'a', platform: '<img>' }).platform, 'desktop');
});
