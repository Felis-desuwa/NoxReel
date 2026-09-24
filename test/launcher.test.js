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

test('启动器构建脚本嵌入 NoxReel 图标和 0.7.7.101 版本信息', () => {
  const source = fs.readFileSync(path.join(root, 'src/launcher/NoxReelLauncher.cs'), 'utf8');
  const build = fs.readFileSync(path.join(root, 'scripts/build-launcher.ps1'), 'utf8');
  assert.match(source, /AssemblyVersion\("0\.7\.7\.101"\)/);
  assert.match(source, /AssemblyFileVersion\("0\.7\.7\.101"\)/);
  assert.match(source, /WindowsPowerShell/);
  assert.match(source, /--self-test/);
  assert.match(build, /noxreel-icon\.ico/);
  assert.match(build, /\/win32icon:/);
  assert.match(build, /NoxReel-Signal\.exe/);
});

/**
 * 版本号写在四个互相不认识的地方：package.json、启动器源码、入库的两个 exe、安卓的 build.gradle。
 * 各写各的时，用户看到的是「桌面 0.7、手机 0.6.8」这种自相矛盾的东西，而 0.7 和 0.6.x 本来就不互通，
 * 排查起来先得怀疑网络。所以这里把四处钉在一起。
 */
test('package.json、启动器与安卓的版本号一致', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  // version 只能是三段（electron-builder 按 semver 校验）；构建号另记在 buildNumber，拼成 0.7.7.101
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'package.json 的 version 写成四段的话打包直接报 Invalid version');
  const { displayVersion } = require('../src/main/appVersion');
  const version = displayVersion(pkg.version, pkg.buildNumber);
  // 顶层的给界面用，build 里的给 electron-builder 用（文件名、Windows 文件版本、联网安装器地址），必须一致
  assert.equal(pkg.build.buildNumber, pkg.buildNumber, 'package.json 顶层和 build 里的 buildNumber 对不上');
  assert.match(pkg.build.win.artifactName, /\$\{buildVersion\}/);
  assert.match(pkg.build.nsisWeb.artifactName, /\$\{buildVersion\}/);
  // appPackageUrl 只认 ${version}（三段，会指到上一个不带构建号的 Release），不认 ${buildVersion}
  // （原样写进安装器，NSIS 当成错误停下）—— 所以写死，每次改版本号都要跟着改
  assert.ok(
    pkg.build.nsisWeb.appPackageUrl.endsWith(`/releases/download/v${version}`),
    `联网安装器要去 v${version} 那个 Release 取包，现在是 ${pkg.build.nsisWeb.appPackageUrl}`
  );
  // 程序集版本本来就是四段，三段的补 .0
  const assembly = version.split('.').length === 4 ? version : `${version}.0`;

  const source = fs.readFileSync(path.join(root, 'src/launcher/NoxReelLauncher.cs'), 'utf8');
  for (const attr of ['AssemblyVersion', 'AssemblyFileVersion']) {
    const hit = source.match(new RegExp(`${attr}\\("([^"]+)"\\)`));
    assert.ok(hit, `启动器源码里没有 ${attr}`);
    assert.equal(hit[1], assembly, `启动器的 ${attr} 和 package.json 对不上`);
  }

  const gradle = fs.readFileSync(path.join(root, 'android/app/build.gradle'), 'utf8');
  const versionName = gradle.match(/versionName\s+"([^"]+)"/);
  assert.ok(versionName, 'build.gradle 里没有 versionName');
  assert.equal(versionName[1], version, '安卓的 versionName 和 package.json 对不上');
});

/**
 * 改了 .cs 却忘了 `npm run build:launcher`，入库的 exe 还是上一版 —— 源码看着没问题，
 * 用户右键属性看到的却是旧版本号。版本资源以 UTF-16 存在 .rsrc 里，直接在字节里找。
 */
test('入库的两个 exe 是按当前版本号重建过的', () => {
  const source = fs.readFileSync(path.join(root, 'src/launcher/NoxReelLauncher.cs'), 'utf8');
  const expected = source.match(/AssemblyFileVersion\("([^"]+)"\)/)[1];
  for (const name of launchers) {
    const text = fs.readFileSync(path.join(root, name)).toString('utf16le');
    assert.ok(text.includes(expected), `${name} 里没有 ${expected}，忘了 npm run build:launcher？`);
  }
});

test('两个 Windows 启动器均通过无界面自检', { skip: process.platform !== 'win32' }, () => {
  for (const name of launchers) {
    const result = spawnSync(path.join(root, name), ['--self-test'], { timeout: 10_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `${name} 自检失败`);
  }
});
