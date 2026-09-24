'use strict';

// 界面上的版本号 = package.json 的三段 version + 构建号（0.7.7.101）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { displayVersion, readBuildNumber } = require('../src/main/appVersion');

test('有构建号拼成四段，没有或不是纯数字就原样', () => {
  assert.equal(displayVersion('0.7.7', '101'), '0.7.7.101');
  assert.equal(displayVersion('0.7.7', 101), '0.7.7.101');
  assert.equal(displayVersion('0.7.8', undefined), '0.7.8');
  assert.equal(displayVersion('0.7.8', ''), '0.7.8');
  for (const bad of ['1.2', 'abc', '-1', '10 1', null]) assert.equal(displayVersion('0.7.8', bad), '0.7.8', String(bad));
});

test('读的是仓库根上 package.json 的 buildNumber', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.equal(readBuildNumber(), pkg.buildNumber);
});

test('主进程报给界面的版本号带上构建号', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  assert.match(main, /version: displayVersion\(app\.getVersion\(\), readBuildNumber\(\)\),/);
});
