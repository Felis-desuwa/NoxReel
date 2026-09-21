'use strict';

// 发到聊天里的 https 跳转链接（0.7.4）。
//
// Discord 这类聊天软件不会把 noxreel:// 变成能点的链接，所以应用发出去的是
// https://felis-desuwa.github.io/NoxReel/#j/<正文>/，由 docs/ 里的静态跳转页转回 noxreel://。
// 这里守两件事：跳转页把链接转对了、而且不碰也不外泄邀请内容；应用里所有「复制出去」的地方都发 https 形式。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const OPEN_JS = read('docs/open.js');
const INDEX = read('docs/index.html');
const APP = read('src/renderer/app.js');

const IDS = ['title', 'lead', 'open', 'hint', 'download', 'copy', 'copied', 'privacy'];

/** 用假 DOM 跑一遍 open.js，返回页面最终状态和它想跳去的地址。 */
function runPage({ hash, lang = 'zh-CN', ua = 'Mozilla/5.0 (Windows NT 10.0)' }) {
  const els = {};
  for (const id of IDS) {
    const classes = new Set(['hidden']);
    els[id] = {
      id,
      textContent: '',
      href: '',
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), has: (c) => classes.has(c) },
      listeners: {},
      addEventListener(type, fn) {
        this.listeners[type] = fn;
      },
    };
  }
  const bodyClasses = new Set();
  const timers = [];
  const clipboard = [];
  const location = { hash, href: `https://felis-desuwa.github.io/NoxReel/${hash}` };
  const window = { location, setTimeout: (fn) => timers.push(fn) };
  const document = {
    title: '',
    documentElement: { lang: 'zh-CN' },
    body: { classList: { add: (c) => bodyClasses.add(c) } },
    getElementById: (id) => els[id],
  };
  const navigator = {
    language: lang,
    userAgent: ua,
    clipboard: { writeText: (text) => (clipboard.push(text), Promise.resolve()) },
  };
  vm.runInNewContext(OPEN_JS, { window, document, navigator, encodeURIComponent });
  for (const fn of timers) fn();
  return { els, bodyClasses, location, document, clipboard };
}

const BODY = 'GH4sIAAAAAAAA.abc-XYZ09.';

test('跳转页：桌面上把 #j/<正文>/ 转成 noxreel://j/<正文>，自动试一次、也给按钮', () => {
  const r = runPage({ hash: `#j/${BODY}/` });
  assert.equal(r.els.open.href, `noxreel://j/${BODY}`, '码尾的 . 要原样带过去');
  assert.equal(r.location.href, `noxreel://j/${BODY}`, '自动跳转');
  assert.ok(!r.els.open.classList.has('hidden'), '「用 NoxReel 打开」按钮要露出来');
  assert.equal(r.els.lead.textContent, '有人邀请你一起看片。');
});

test('跳转页：应答链接说清楚要在房主电脑上打开', () => {
  const r = runPage({ hash: `#a/${BODY}/` });
  assert.equal(r.els.open.href, `noxreel://a/${BODY}`);
  assert.match(r.els.lead.textContent, /应答链接/);
});

test('跳转页：安卓走 intent://，指定包名，没装就落到下载页', () => {
  const r = runPage({ hash: `#j/${BODY}/`, ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' });
  assert.equal(
    r.els.open.href,
    `intent://j/${BODY}#Intent;scheme=noxreel;package=app.noxreel.android;S.browser_fallback_url=` +
      encodeURIComponent('https://github.com/Felis-desuwa/NoxReel/releases/latest') +
      ';end'
  );
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android:scheme="noxreel"/, '安卓那边得真的接 noxreel://');
  assert.match(read('android/app/build.gradle'), /applicationId "app\.noxreel\.android"/, '包名要和跳转页里写的一致');
});

test('跳转页：不完整或带怪字符的链接不跳，只说链接不完整', () => {
  for (const hash of ['', '#', '#j/', '#x/abc/', `#j/${BODY}<script>/`, `#j/${BODY}/extra`, '#j/a b/']) {
    const r = runPage({ hash });
    assert.ok(r.bodyClasses.has('bad'), `${JSON.stringify(hash)} 应该判成坏链接`);
    assert.ok(r.location.href.startsWith('https://'), `${JSON.stringify(hash)} 不该跳走`);
    assert.ok(r.els.open.classList.has('hidden'));
  }
});

test('跳转页：邀请内容不写进页面，复制的是原 https 链接', async () => {
  const r = runPage({ hash: `#j/${BODY}/` });
  for (const id of IDS) assert.ok(!r.els[id].textContent.includes(BODY), `#${id} 的文字里出现了邀请内容`);
  r.els.copy.listeners.click();
  await Promise.resolve();
  assert.deepEqual(r.clipboard, [`https://felis-desuwa.github.io/NoxReel/#j/${BODY}/`]);
});

test('跳转页：英文系统显示英文', () => {
  const r = runPage({ hash: `#j/${BODY}/`, lang: 'en-US' });
  assert.equal(r.document.title, 'Watch together on NoxReel');
  assert.equal(r.els.open.textContent, 'Open in NoxReel');
  assert.equal(r.document.documentElement.lang, 'en');
});

test('跳转页：CSP 从严、没有内联脚本和外部资源，带 Discord 预览卡片', () => {
  assert.match(INDEX, /Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'/);
  assert.match(INDEX, /<meta name="referrer" content="no-referrer">/);
  assert.doesNotMatch(INDEX, /<script>[\s\S]*?<\/script>/, '不许有内联脚本');
  assert.doesNotMatch(INDEX, /src="https?:|href="https?:\/\/(?!github\.com\/Felis-desuwa\/NoxReel\/releases)/, '不许加载外部资源');
  assert.match(INDEX, /<meta property="og:title" content="来 NoxReel 一起看">/);
  assert.match(INDEX, /<meta property="og:image" content="https:\/\/felis-desuwa\.github\.io\/NoxReel\/icon\.png">/);
  assert.ok(fs.existsSync(path.join(root, 'docs/icon.png')));
  assert.ok(fs.existsSync(path.join(root, 'docs/.nojekyll')), '不关 Jekyll 的话以点开头的文件会被吞');
  assert.doesNotMatch(OPEN_JS, /innerHTML|insertAdjacentHTML|document\.write|eval\(|fetch\(|XMLHttpRequest|sendBeacon/);
});

test('应用里复制出去的邀请、应答、房间码都是 https 跳转链接', () => {
  assert.match(APP, /import \{[^}]*\bshareLink\b[^}]*\} from '\.\/lib\/signaling\.js'/);
  assert.doesNotMatch(APP, /\binviteLink\(/, '还有地方在往外发 noxreel:// —— Discord 里点不开');
  assert.match(APP, /const link = shareLink\(code, 'join'\);/);
  assert.match(APP, /const answerLink = shareLink\(code, 'answer'\);/);
  const server = APP.slice(APP.indexOf('async function inviteViaServer('), APP.indexOf('async function inviteViaManual('));
  assert.match(server, /const link = shareLink\(code, 'join'\);\s*\$\('inv-code'\)\.value = link;\s*\$\('inv-copy'\)\.onclick = \(\) => copyCode\(link, \$\('inv-copy'\)\);/);
});

test('深链接仍然只接 noxreel://（跳转页负责转过来）', () => {
  const main = read('src/main/main.js');
  assert.match(main, /const DEEP_LINK_SCHEME = 'noxreel:';/);
  assert.match(main, /\['j', 'a'\]\.includes\(parsed\.hostname\.toLowerCase\(\)\)/);
});

test('新文案都有英文', async () => {
  const { translate } = await import('../src/renderer/lib/i18n.js');
  for (const line of [
    '粘贴朋友给你的邀请链接（在 Discord 里直接点开也行）',
    'https://…#j/… 或 noxreel://j/…（也认旧版的 NR3-…）',
    '点开对方发回的 NoxReel 应答链接，或粘贴到这里',
  ]) {
    assert.notEqual(translate(line, 'en'), line, line);
  }
});
