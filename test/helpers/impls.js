'use strict';

/**
 * 桌面端和安卓观众端各有一份同源的 peer / swarm / syncEngine。
 * 连接层的回归测试一律对两份都跑一遍 —— 这几个 bug 当初就是两边一模一样，
 * 只修一边等于留着另一半继续踩。
 */
const IMPLS = [
  { name: '桌面端', dir: '../src/renderer/lib/' },
  { name: '安卓端', dir: '../android/app/src/main/assets/js/' },
];

module.exports = { IMPLS };
