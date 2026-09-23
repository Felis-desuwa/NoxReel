'use strict';

/**
 * 给 noxreel:// 的系统登记补一个显示名。
 *
 * 浏览器点开邀请链接时会问「要打开 XXX 吗？」，XXX 是 Windows 按登记的程序查出来的名字
 * （Chromium 用 AssocQueryString(ASSOCF_IS_PROTOCOL, ASSOCSTR_FRIENDLYAPPNAME)）。
 * 源码运行时登记的是 node_modules 里的 electron.exe，查出来就是「Electron」，
 * 用户根本认不出这是 NoxReel。在 shell\open 下写 FriendlyAppName 会优先于 exe 自己的描述
 * （实测：Windows 11，同样的调用从 Electron 变成 NoxReel）。
 *
 * 不引原生模块，借系统自带的 reg.exe；只写 HKCU 下我们自己那个协议键，写不上就算了 ——
 * 弹窗里显示 Electron 不影响链接打开。
 */

const path = require('path');
const { execFile } = require('child_process');

const REG_TIMEOUT_MS = 5000;

function regExe(env = process.env) {
  return path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'reg.exe');
}

/** reg.exe 的参数。名字只收字母数字和空格，别让它变成注入的口子（调用方现在只传常量）。 */
function regArgs(scheme, name) {
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) throw new Error('协议名不合法');
  if (!/^[A-Za-z0-9 ]{1,64}$/.test(name)) throw new Error('显示名不合法');
  return ['add', `HKCU\\Software\\Classes\\${scheme}\\shell\\open`, '/v', 'FriendlyAppName', '/t', 'REG_SZ', '/d', name, '/f'];
}

/**
 * 写显示名。只在 Windows 上做；失败、超时都只是返回 false，不抛。
 * @param {{scheme?: string, name?: string, platform?: string, run?: Function}} [opts] run 给测试换掉 execFile
 * @returns {Promise<boolean>}
 */
function labelProtocolHandler({ scheme = 'noxreel', name = 'NoxReel', platform = process.platform, run = execFile } = {}) {
  if (platform !== 'win32') return Promise.resolve(false);
  let args;
  try {
    args = regArgs(scheme, name);
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    try {
      run(regExe(), args, { timeout: REG_TIMEOUT_MS, windowsHide: true }, (error) => resolve(!error));
    } catch {
      resolve(false);
    }
  });
}

module.exports = { labelProtocolHandler, regArgs, REG_TIMEOUT_MS };
