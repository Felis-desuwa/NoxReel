'use strict';

/**
 * 界面上显示的版本号。
 *
 * package.json 的 version 必须是 x.y.z —— electron-builder 打包时按 semver 校验，0.7.7.101 这种
 * 四段式直接报 Invalid version。所以构建号另记在顶层 buildNumber 里，这里拼成 0.7.7.101；
 * 没有构建号就是 version 本身。安装包文件名、Windows 文件版本、联网安装器的下载地址由
 * electron-builder 按 build.buildNumber 拼出同一个值（${buildVersion}），两处由 launcher.test 钉成一致。
 */
function displayVersion(version, buildNumber) {
  const build = String(buildNumber ?? '').trim();
  return /^\d+$/.test(build) ? `${version}.${build}` : String(version);
}

/** 打包后 package.json 在 app.asar 根上，开发时就是仓库根上那份；读不到就当没有构建号。 */
function readBuildNumber() {
  try {
    return require('../../package.json').buildNumber;
  } catch {
    return undefined;
  }
}

module.exports = { displayVersion, readBuildNumber };
