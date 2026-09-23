'use strict';

// 桌面端和安卓端共用的库必须逐字节一致（行尾除外）。
//
// 以前这几份是各改各的：安卓的 HELLO 昵称没截断、帧长没校验、同步引擎落后好几处修复，
// 协议一升级就更没法保证两边说的是同一种话。现在统一以 src/renderer/lib 为准，
// 改完桌面端就把文件原样拷到 android/app/src/main/assets/js。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SHARED = [
  'emitter.js',
  'ice.js',
  'scheduler.js',
  'protocol.js',
  'peer.js',
  'swarm.js',
  'syncEngine.js',
  'signaling.js',
  'playlist.js',
  'chat.js',
  'danmaku.js',
  // 房间链接（安卓也能用了）和 Cloudflare TURN 的用量计量
  'relaySignaling.js',
  'third_party/secp256k1.js',
  'turnUsage.js',
];

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

for (const name of SHARED) {
  test(`共享库 ${name} 桌面端与安卓端一致`, () => {
    const desktop = read(`src/renderer/lib/${name}`);
    const android = read(`android/app/src/main/assets/js/${name}`);
    assert.ok(desktop.length > 200, `${name} 读出来太短，路径可能不对`);
    assert.equal(android, desktop, `${name} 两端不一致：改完桌面端后把它拷到安卓端`);
  });
}

test('共享库里没有混进真实的制表符（转义被改写的老问题）', () => {
  for (const name of SHARED) {
    const text = read(`src/renderer/lib/${name}`);
    assert.ok(!text.includes(String.fromCharCode(9)), `${name} 里有真实的制表符`);
  }
});
