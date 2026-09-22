'use strict';

/**
 * 主窗口 session 的权限处理器：「请求」和「检查」两道都一律拒绝。
 *
 * 检查这一道不能省。只设 setPermissionRequestHandler 时，Electron 对权限「检查」默认放行，
 * Chromium 就以为页面已经拿到了摄像头 / 麦克风（media）权限 —— 而 WebRTC 对有 media 权限的
 * 页面不做 mDNS 混淆，会把本机的局域网 IP 和公网 IPv6 明文写进 SDP 的 host 候选，
 * 一对一邀请码里直接就能看到（Electron 43 实测）。检查对 media 返回 false 之后，
 * host 候选换成 `<uuid>.local`，srflx 候选的 raddr 也抹成 0.0.0.0 / ::。
 * 只加 --enable-features=WebRtcHideLocalIpsWithMdns 没用，决定权在这道检查上。
 *
 * 所以 **media 永远不能放行**。渲染进程眼下也用不到任何要过权限检查的能力：
 * 剪贴板走 IPC（clipboard:writeText），不用 Notification、全屏、getUserMedia、
 * navigator.permissions —— 整个一律拒绝最省事。将来真要放行某一项，也只能单独放那一项，
 * 而且要在这里写清为什么；media 不在可以放的范围里。
 *
 * 弹幕覆盖窗也在默认 session 里，这两道处理器对它同样生效。
 */
function lockDownPermissions(session) {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
}

module.exports = { lockDownPermissions };
