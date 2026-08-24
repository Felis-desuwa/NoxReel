'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const launchers = ['NoxReel.exe', 'NoxReel-Signal.exe'];

test('源码目录只提供带图标的 EXE 启动入口，不再保留 BAT', () => {
  assert.equal(fs.existsSync(path.join(root, '启动.bat')), false);
  assert.equal(fs.existsSync(path.join(root, '启动信令服务器.bat')), false);

  for (const name of launchers) {
    const file = path.join(root, name);
    const data = fs.readFileSync(file);
    assert.equal(data.subarray(0, 2).toString('ascii'), 'MZ');
    assert.ok(data.length > 50 * 1024, `${name} 没有包含预期的图标资源`);
    assert.match(data.toString('latin1'), /\.rsrc/);
    const peOffset = data.readUInt32LE(0x3c);
    const optionalHeader = peOffset + 24;
    const magic = data.readUInt16LE(optionalHeader);
    const subsystemOffset = optionalHeader + (magic === 0x20b ? 88 : 68);
    assert.equal(data.readUInt16LE(subsystemOffset), 2, `${name} 不是 Windows GUI EXE`);
  }
});

test('启动器构建脚本嵌入 NoxReel 图标和 0.6.0 版本信息', () => {
  const source = fs.readFileSync(path.join(root, 'src/launcher/NoxReelLauncher.cs'), 'utf8');
  const build = fs.readFileSync(path.join(root, 'scripts/build-launcher.ps1'), 'utf8');
  assert.match(source, /AssemblyFileVersion\("0\.6\.0\.0"\)/);
  assert.match(source, /WindowsPowerShell/);
  assert.match(source, /--self-test/);
  assert.match(build, /noxreel-icon\.ico/);
  assert.match(build, /\/win32icon:/);
  assert.match(build, /NoxReel-Signal\.exe/);
});

test('两个 Windows 启动器均通过无界面自检', { skip: process.platform !== 'win32' }, () => {
  for (const name of launchers) {
    const result = spawnSync(path.join(root, name), ['--self-test'], { timeout: 10_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `${name} 自检失败`);
  }
});
