'use strict';

// 修复 G3（第二轮实测发现的杂项）的回归测试：
//  - R3-B / R4-A：在线视频取消、失败、退出后，下载文件夹和长期缓存文件夹里不留空的 .noxreel-downloading
//    （主进程的 workDirIn 挪进 linkCache.js，abort 也经 removeWorkDir；linkCache.test.js 用的就是这一份）；
//  - R4-B：开房准备失败的结论页去掉 IPC 前缀、ffmpeg 的输出只进诊断；开头就不是 MP4 结构的 .mp4 直接说认不出，
//    不再当成 moov 在尾弹转封装选择窗；
//  - R4-C：几句说明各自翻译，英文界面句子之间补空格；
//  - R4-D：结论页保留「原因\n\n怎么办」的换行，候选诊断接在后面的整段也能翻。
// 全程不联网、不起播放器、不出声；真 ffmpeg 的用例只编码、转封装小样片，没装就跳过。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const media = require('../src/main/media');
const { workDirIn, WORK_DIR } = require('../src/main/linkCache');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const APP = read('src/renderer/app.js');
const CJK = /[\u4e00-\u9fff]/;

function fnSource(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层函数 ${name}`);
  const end = APP.indexOf('\n}\n', m.index);
  assert.ok(end > m.index, `${name} 的结尾没找到`);
  return APP.slice(m.index, end + 2);
}

function declSource(name) {
  const m = new RegExp(`^(?:const|let) ${name} = [^\\n]*;$`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层声明 ${name}`);
  return m[0];
}

function sandbox({ fns = [], decls = [], globals = {} }) {
  const ctx = { console, ...globals };
  vm.createContext(ctx);
  vm.runInContext([...decls.map(declSource), ...fns.map(fnSource)].join('\n\n'), ctx, { filename: 'app.js（节选）' });
  return ctx;
}

async function tempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'noxreel-g3-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

/* ------------------------ R3-B / R4-A：取消后不留空的工作目录 ------------------------ */

test('R3-B：workDirIn 的 abort 连外层空的 .noxreel-downloading 一起删，别的任务还在用时不动', async (t) => {
  const dir = await tempDir(t);
  const a = await workDirIn(dir, 'job-a');
  const b = await workDirIn(dir, 'job-b');
  assert.equal(path.dirname(a.workDir), path.join(dir, WORK_DIR));
  await fsp.writeFile(path.join(a.workDir, 'x.mp4.part'), 'half');
  await fsp.writeFile(path.join(b.workDir, 'y.mp4.part'), 'half');

  await a.abort();
  assert.equal(fs.existsSync(a.workDir), false, '取消的那个工作目录删掉');
  assert.equal(fs.existsSync(path.join(b.workDir, 'y.mp4.part')), true, '别的任务的半截文件不能动');
  await b.abort();
  assert.deepEqual(fs.readdirSync(dir), [], '最后一个也取消了：外层空目录不留到下次启动');
  await b.abort(); // 已经没了也不报错

  // 下完挪到位也一样：成品进 dir，外层空了一起删
  const done = [];
  const c = await workDirIn(dir, 'job-c', async (target, meta) => done.push([target, meta]));
  await fsp.writeFile(path.join(c.workDir, '片子.mp4'), 'whole');
  const target = await c.finish(path.join(c.workDir, '片子.mp4'), { url: 'u' });
  assert.equal(target, path.join(dir, '片子.mp4'));
  assert.deepEqual(done, [[target, { url: 'u' }]]);
  assert.deepEqual(fs.readdirSync(dir), ['片子.mp4']);
});

test('R3-B：主进程用的就是 linkCache.workDirIn，不再自己留一份只删 <号> 那一层的', () => {
  const main = read('src/main/main.js');
  assert.match(main, /const \{ LinkCache, workDirIn \} = require\('\.\/linkCache'\);/);
  assert.doesNotMatch(main, /function workDirIn\(/);
  assert.doesNotMatch(main, /abort: \(\) => fsp\.rm\(work/);
  const lc = read('src/main/linkCache.js');
  const fn = lc.slice(lc.indexOf('async function workDirIn('), lc.indexOf('/** 路径是不是在 dir 里面'));
  assert.match(fn, /abort: \(\) => removeWorkDir\(work\)/);
});

/* ------------------------------ R4-B：认不出的 MP4 ------------------------------ */

function box(type, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
}
// 固定的「随机」字节：每次都一样，免得测试偶尔撞上一个像样的 box 头
const noise = (n) => {
  const out = [];
  for (let i = 0; out.length < n; i++) out.push(...crypto.createHash('sha256').update(`g3-${i}`).digest());
  return Buffer.from(out.slice(0, n));
};

test('R4-B：inspectMp4Faststart 开头不是 ISOBMFF 结构的判 valid:false，真 MP4 的判法不变', async (t) => {
  const dir = await tempDir(t);
  const ftyp = box('ftyp', Buffer.from('isom\0\0\x02\0isomiso2', 'latin1'));
  const cases = [
    ['随机字节', noise(256 * 1024), { valid: false }],
    ['文本文件', Buffer.from('Hello, this is not a video at all.\n'.repeat(200)), { valid: false }],
    ['空文件', Buffer.alloc(0), { valid: false }],
    ['不到一个 box 头', Buffer.from([0, 0, 0, 8]), { valid: false }],
    ['第一个 box 长度超出文件', Buffer.concat([Buffer.from([0, 0x10, 0, 0]), Buffer.from('ftyp'), Buffer.alloc(64)]), { valid: false }],
    ['moov 在尾', Buffer.concat([ftyp, box('free'), box('mdat', Buffer.alloc(64)), box('moov', Buffer.alloc(16))]), { faststart: false }],
    ['moov 在头', Buffer.concat([ftyp, box('moov', Buffer.alloc(16)), box('mdat', Buffer.alloc(64))]), { faststart: true }],
    ['老式 QuickTime（wide + mdat 打头）', Buffer.concat([box('wide'), box('mdat', Buffer.alloc(64)), box('moov', Buffer.alloc(16))]), { faststart: false }],
    // 没下完：ftyp 认得出，后面那个 box 的长度超出了文件 —— 照旧按「不知道」处理，不算认不出
    ['截断的 MP4', Buffer.concat([ftyp, Buffer.from([0x7f, 0xff, 0xff, 0xff]), Buffer.from('free')]), { faststart: false, unknown: true }],
  ];
  for (const [name, bytes, expected] of cases) {
    const file = path.join(dir, `${name}.mp4`);
    await fsp.writeFile(file, bytes);
    const got = await media.inspectMp4Faststart(file);
    for (const [key, value] of Object.entries(expected)) assert.equal(got[key], value, `${name}：${JSON.stringify(got)}`);
    if (expected.valid === undefined) assert.notEqual(got.valid, false, `${name} 不该判成认不出`);
  }
});

test('R4-B：随机字节的 .mp4 在检查格式这一步就拒掉并说清原因，不再弹转封装选择窗', async (t) => {
  const dir = await tempDir(t);
  for (const ext of ['.mp4', '.mov']) {
    const file = path.join(dir, `随机${ext}`);
    await fsp.writeFile(file, noise(512 * 1024));
    const info = await media.inspect(file);
    assert.equal(info.action, 'reject', JSON.stringify(info));
    const label = ext === '.mov' ? 'MOV' : 'MP4';
    assert.equal(info.reason, `认不出这个文件：扩展名是 ${label}，内容却不是 ${label} 格式，可能已损坏，或者根本不是视频。`);
    // 渲染进程拿到 reject 直接 throw new Error(info.reason)，英文界面上是一整句英文
    const { translate } = await load('src/renderer/lib/i18n.js');
    assert.doesNotMatch(translate(info.reason, 'en'), CJK);
  }
});

test('R4-B：ffmpeg 失败只给一句人话，输出尾部挂在 detail 上（去掉版本横幅、路径换成占位）；取消原样放过', () => {
  const src = 'C:\\Films\\秘密片名.mp4';
  const out = 'C:\\Temp\\run-1\\remux-x\\秘密片名.faststart.mp4';
  const error = Object.assign(new Error('ffmpeg.exe 退出码 1'), {
    exitCode: 1,
    stderr: [
      'ffmpeg version 8.1.2-full_build Copyright (c) 2000-2026',
      '  built with gcc 15',
      '  configuration: --enable-gpl',
      '  libavutil      60. 13.100 / 60. 13.100',
      `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '${src}':`,
      `[out#0/mp4 @ 0000] Error opening output ${out.replace(/\\/g, '/')}: No space left on device`,
      'Conversion failed!',
      '',
    ].join('\r\n'),
  });
  const failure = media.toolFailure('转封装失败', error, [src, out]);
  assert.equal(failure.message, '转封装失败：磁盘空间不够。');
  assert.match(failure.detail, /^ffmpeg\.exe 退出码 1\n/);
  assert.match(failure.detail, /No space left on device/);
  assert.doesNotMatch(failure.detail, /秘密片名|Films|run-1/, '诊断信息不收文件路径和片名');
  assert.doesNotMatch(failure.detail, /ffmpeg version|built with|configuration:|libavutil/);
  assert.equal(media.errorForIpc(failure).message, `${failure.message}${media.TOOL_DETAIL_MARK}${failure.detail}`);

  const invalid = media.toolFailure('封成 MKV 失败', { ...error, exitCode: 1, stderr: 'moov atom not found\nError opening input: Invalid data found when processing input' });
  assert.equal(invalid.message, '封成 MKV 失败：这个文件可能已损坏，或者不是视频。');
  const other = media.toolFailure('无损精简失败', Object.assign(new Error('ffmpeg.exe 退出码 -22'), { exitCode: -22, stderr: 'something odd' }));
  assert.equal(other.message, '无损精简失败：ffmpeg 没能处理这个文件。');

  // 取消、超时本来就是一句人话：原样放过，也不带诊断
  const cancelled = new Error('操作已取消');
  assert.equal(media.toolFailure('转封装失败', cancelled), cancelled);
  assert.equal(media.errorForIpc(cancelled), cancelled);
});

test('R4-B：run() 失败时 message 不再拼整段 stderr，stderr 挂在错误上', async () => {
  const error = await media
    .run(process.execPath, ['-e', "process.stderr.write('boom line\\n'.repeat(40)); process.exit(3)"])
    .then(() => null, (e) => e);
  assert.ok(error);
  assert.equal(error.message, `${path.basename(process.execPath)} 退出码 3`);
  assert.equal(error.exitCode, 3);
  assert.match(error.stderr, /boom line/);
});

test('R4-B：主进程转封装 / 精简 / 封 MKV 失败时经 errorForIpc 把诊断接在报错后面', () => {
  const main = read('src/main/main.js');
  for (const channel of ['media:remux', 'media:slim', 'media:convert']) {
    const start = main.indexOf(`secureHandle('${channel}'`);
    const body = main.slice(start, main.indexOf('\n});', start));
    assert.match(body, /throw media\.errorForIpc\(error\);/, channel);
  }
  const src = read('src/main/media.js');
  for (const [fn, what] of [['remux', '转封装失败'], ['slim', '无损精简失败'], ['convert', '封成 MKV 失败']]) {
    const start = src.indexOf(`async function ${fn}(`);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    assert.ok(body.includes(`toolFailure('${what}'`), `${fn} 没把 ffmpeg 的失败换成人话`);
  }
});

const ffmpeg = media.findFfmpeg();
const ffprobe = media.findFfprobe();

test('R4-B：真跑一遍：随机字节转封装报一句人话；改了扩展名的 MKV 说清是别的格式；moov 在尾的 MP4 照旧转封装', { skip: !ffmpeg || !ffprobe }, async (t) => {
  const dir = await tempDir(t);
  const junk = path.join(dir, '随机片.mp4');
  await fsp.writeFile(junk, noise(512 * 1024));
  const failure = await media.remux(junk, path.join(dir, 'out-junk')).then(() => null, (e) => e);
  assert.ok(failure, '随机字节转封装不该成功');
  assert.equal(failure.message, '转封装失败：这个文件可能已损坏，或者不是视频。');
  assert.match(failure.detail, /退出码/);
  assert.ok(!failure.detail.includes(dir) && !failure.detail.includes('随机片'), '诊断里没有路径和片名');

  const mkv = path.join(dir, 'real.mkv');
  const run = (args) => {
    const r = spawnSync(ffmpeg, ['-v', 'error', '-y', ...args], { windowsHide: true });
    assert.equal(r.status, 0, String(r.stderr));
  };
  run(['-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=10:d=1', '-c:v', 'libx264', mkv]);
  const renamed = path.join(dir, 'renamed.mp4');
  await fsp.copyFile(mkv, renamed);
  const info = await media.inspect(renamed);
  assert.equal(info.action, 'reject');
  assert.match(info.reason, /^这个文件的扩展名是 MP4，内容却是别的格式（matroska/);
  const { translate } = await load('src/renderer/lib/i18n.js');
  assert.doesNotMatch(translate(info.reason, 'en'), CJK);

  const tail = path.join(dir, 'tail.mp4');
  run(['-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=10:d=1', '-c:v', 'libx264', tail]);
  const moov = await media.inspect(tail);
  assert.equal(moov.action, 'remux', '真正 moov 在尾的 MP4 不受影响');
});

/* ------------------------------ R4-B：渲染进程的结论页 ------------------------------ */

test('R4-B：报错标记两边一致；渲染进程去掉 IPC 前缀、把诊断拆出来只进日志', () => {
  const logs = [];
  const ctx = sandbox({
    fns: ['ipcErrorText', 'splitIpcError', 'logToolDetail'],
    decls: ['TOOL_DETAIL_MARK'],
    globals: { log: (text, kind) => logs.push([text, kind]) },
  });
  const mark = vm.runInContext('TOOL_DETAIL_MARK', ctx);
  assert.equal(mark, media.TOOL_DETAIL_MARK, 'app.js 和 media.js 的标记不一致，拆不开');

  const ipc = new Error(
    `Error invoking remote method 'media:remux': Error: 转封装失败：这个文件可能已损坏，或者不是视频。${mark}ffmpeg.exe 退出码 1\nmoov atom not found`
  );
  const split = ctx.splitIpcError(ipc);
  assert.equal(split.text, '转封装失败：这个文件可能已损坏，或者不是视频。');
  assert.equal(split.detail, 'ffmpeg.exe 退出码 1\nmoov atom not found');
  ctx.logToolDetail(split.detail);
  assert.deepEqual(logs, [['外部程序的输出（诊断用）：ffmpeg.exe 退出码 1\nmoov atom not found', 'warn']]);

  // 没有诊断的报错：只去前缀，不记日志
  const plain = ctx.splitIpcError(new Error("Error invoking remote method 'media:inspect': Error: 不支持这种视频格式：.rm"));
  assert.equal(plain.text, '不支持这种视频格式：.rm');
  assert.equal(plain.detail, '');
  ctx.logToolDetail(plain.detail);
  assert.equal(logs.length, 1);
  // 渲染进程自己抛的错原样
  assert.equal(ctx.splitIpcError(new Error('这个 MP4 需要转封装')).text, '这个 MP4 需要转封装');
});

test('R4-B：开房失败页只写那句人话，有诊断时给「复制诊断信息」；在线链接和列表行内也去掉 IPC 前缀', () => {
  const host = fnSource('startHost');
  assert.match(host, /const \{ text: message, detail \} = splitIpcError\(e\);/);
  assert.match(host, /logToolDetail\(detail\);/);
  assert.match(host, /prepFail\(message, '', \{ diagnostics: !!detail \}\);/);
  assert.doesNotMatch(host, /e\.message \|\| String\(e\)/);
  assert.match(fnSource('startHostLink'), /prepFail\(ipcErrorText\(e\)\);/);
  const job = fnSource('failPrepJob');
  assert.match(job, /const \{ text, detail \} = splitIpcError\(error\);/);
  assert.match(job, /job\.detail = text;/);

  const els = {};
  const $ = (id) => (els[id] ||= { id, textContent: '', style: {}, kids: null });
  const ctx = sandbox({
    fns: ['prepFail', 'prepStop'],
    globals: {
      $,
      endAttempt: () => {},
      show: () => {},
      backHome: () => {},
      make: (tag, opts = {}) => ({ tag, ...opts }),
      hint: (text) => ({ hint: text }),
      replace: (id, ...kids) => ($(id).kids = kids),
      copyDiagnosticsButton: () => ({ diagnostics: true }),
    },
  });
  ctx.prepFail('转封装失败：这个文件可能已损坏，或者不是视频。', '', { diagnostics: true });
  assert.equal(els['prep-title'].textContent, '没法用这个文件');
  assert.equal(els['prep-note'].textContent, '转封装失败：这个文件可能已损坏，或者不是视频。');
  assert.deepEqual(els['prep-actions'].kids.map((k) => k.text || (k.diagnostics ? 'diag' : k.hint)), ['返回', 'diag']);
  ctx.prepFail('不支持这种视频格式：.rm');
  assert.deepEqual(els['prep-actions'].kids.map((k) => k.text), ['返回'], '没有诊断就只留「返回」');
  ctx.prepFail('坏了', '这些也没能用：a.mp4');
  assert.deepEqual(els['prep-actions'].kids.map((k) => k.text || k.hint), ['这些也没能用：a.mp4', '返回']);
});

test('R4-B：新文案的英文：失败原因、诊断输出前缀、退出码、认不出的格式', async () => {
  const { translate } = await load('src/renderer/lib/i18n.js');
  const causes = ['磁盘空间不够', '没有权限读写这个文件', '这个文件可能已损坏，或者不是视频', 'ffmpeg 没能处理这个文件'];
  for (const what of ['转封装失败', '无损精简失败', '封成 MKV 失败']) {
    for (const cause of causes) {
      const en = translate(`${what}：${cause}。`, 'en');
      assert.doesNotMatch(en, CJK, en);
      assert.match(en, / failed: .+\.$/);
    }
  }
  assert.equal(translate('转封装失败：磁盘空间不够。', 'en'), 'Remuxing failed: there is not enough disk space.');
  assert.equal(
    translate('外部程序的输出（诊断用）：ffmpeg.exe 退出码 3199971767\nError opening input file <文件>.', 'en'),
    'Tool output (for diagnostics): ffmpeg.exe exited with code 3199971767\nError opening input file <file>.'
  );
  assert.equal(translate('ffmpeg.exe 退出码 1', 'en'), 'ffmpeg.exe exited with code 1');
  assert.equal(
    translate('认不出这个文件：扩展名是 MOV，内容却不是 MOV 格式，可能已损坏，或者根本不是视频。', 'en'),
    'Cannot recognize this file: its extension says MOV, but the content is not MOV. It may be damaged, or not a video at all.'
  );
  assert.equal(
    translate('这个文件的扩展名是 MP4，内容却是别的格式（avi）。把扩展名改成和内容一致再试，比如 MKV 的改成 .mkv。', 'en'),
    'This file has a MP4 extension, but its content is another format (avi). Rename it to match the content and try again—for example, an MKV file should end in .mkv.'
  );
  // 列表行内的日志把它当原因递归翻
  assert.equal(
    translate('《a.mp4》没加进列表：转封装失败：这个文件可能已损坏，或者不是视频。', 'en'),
    '“a.mp4” was not added to the playlist: Remuxing failed: the file may be damaged, or it is not a video.'
  );
});

/* ------------------------------ R4-C：英文句子之间的空格 ------------------------------ */

async function hintBox(locale) {
  const { translate } = await load('src/renderer/lib/i18n.js');
  const ctx = sandbox({
    fns: ['hint', 'sentenceGap'],
    globals: {
      currentLocale: () => locale,
      t: (text) => translate(text, locale),
      make: (tag, opts, children) => ({ tag, opts, children }),
    },
  });
  // 和 make() 一样：字符串逐段翻译后成为相邻的文本节点
  const render = (p) => p.children.map((c) => (typeof c === 'string' ? translate(c, locale) : `<${c.tag}>`)).join('');
  return { ctx, render };
}

test('R4-C：设置页几句说明分开翻译后，英文界面句子之间有空格；中文不加', async () => {
  const pairs = [
    [
      '在 Cloudflare 后台 Realtime → TURN Server 新建一个 Key，把 Turn Token ID 和 API Token 填进来，点「验证并保存」。',
      'API Token 加密保存在本机，只有 NoxReel 的主进程拿它向 Cloudflare 换 24 小时有效的临时账号，界面上不会再显示。',
      '“Verify and save”. The API Token',
    ],
    [
      '到上限就不再用 Cloudflare TURN（为免扣费），下个月 1 日（UTC）自动恢复；已经连着的不会被断开。',
      '这是本机统计，和 Cloudflare 账单可能有出入；建议另外在 Cloudflare 后台 Manage Account → Billing → Billable Usage 建一个 Budget alert 做兜底。',
      'cut off. This is counted',
    ],
    [
      '打开后，房间里的人只能看到 TURN 服务器的地址，看不到你的 IP。',
      '需要先配好 TURN（自己填，或用 Cloudflare 自动生成）；TURN 用不了时会连不上，不会退回直连。只影响之后新建的连接。',
      'not your IP. Set up TURN',
    ],
  ];
  const en = await hintBox('en');
  const zh = await hintBox('zh-CN');
  for (const [a, b, joint] of pairs) {
    const text = en.render(en.ctx.hint(a, b));
    assert.ok(text.includes(joint), text);
    assert.doesNotMatch(text, /[.”][A-Z]/, `句号后面直接接下一句：${text}`);
    assert.equal(zh.render(zh.ctx.hint(a, b)), a + b, '中文句子之间不加空格');
  }
  // 三句的也一样
  const three = en.render(
    en.ctx.hint(
      '自动：收到的片先放在上面的缓存位置，换片、退房都不删，这次运行里再放同一部直接用，关软件时清掉；磁盘不够时先删最久没用的。',
      '手动：收到的片放进长期缓存文件夹，从不自动删，以后再放同一部直接用；磁盘满了会停下来提示你来这里清理。',
      '只影响之后开始接收的片。'
    )
  );
  assert.doesNotMatch(three, /\.[A-Z]/, three);
});

test('R4-C：后一句以标点开头、或中间隔着元素的不补空格', async () => {
  const { ctx, render } = await hintBox('en');
  const version = render(ctx.hint('当前版本 0.7.7', '。诊断信息里只有运行环境和连接状态，不含文件路径和片名。'));
  assert.ok(!version.includes(' . '), version);
  assert.match(version, /0\.7\.7\. The diagnostics/);
  const bold = ctx.hint('丢掉 ', { tag: 'b' }, '，保留下来的轨');
  assert.equal(bold.children.length, 3, '字符串不相邻：不插空格');
  assert.equal(ctx.hint('只有一句。').children.length, 1);
});

// H1（N2）：hint() 以前只在两个字符串之间补空格，句子后面紧跟 <code> 的照样粘在一起
test('H1 N2：英文界面句子和行内元素（<code>）相邻也补空格；自带空格、标点、<br> 两边、两个元素之间不补；中文不加', async () => {
  const en = await hintBox('en');
  const zh = await hintBox('zh-CN');
  const code = (text) => ({ tag: 'code', tagName: 'CODE', text });
  const br = { tag: 'br', tagName: 'BR' };
  // 设置里「信令服务器」下面那句、依赖帮助的「已找到：」
  assert.equal(
    en.render(en.ctx.hint('只转发连接地址，不接触视频内容。自己跑一个：', code('npm run signal'))),
    'Relays connection metadata only, never video. Run your own: <code>'
  );
  assert.equal(en.render(en.ctx.hint('已找到：', code('C:\\mpv\\mpv.exe'))), 'Found: <code>');
  // 元素后面紧跟一个以字母开头的句子也隔开；以标点开头的不隔
  assert.equal(en.render(en.ctx.hint(code('x'), '已找到：')), '<code> Found:');
  assert.equal(en.render(en.ctx.hint(code('x'), '。')), '<code>.');
  // 依赖帮助的安装方式：译文自带结尾空格、「 / 」两边自带空格、句号、<br> 两边、两个元素之间都不补
  const deps = en.ctx.hint(
    code('winget install …'),
    br,
    code('scoop install …'),
    br,
    '或者手动下载后，把可执行文件路径写进环境变量',
    code('SYNCWATCH_MPV_PATH'),
    ' / ',
    code('SYNCWATCH_FFMPEG_PATH'),
    '。'
  );
  assert.equal(deps.children.length, 9, en.render(deps));
  // 无损精简、PCM 转 FLAC 那两段：译文两头已经留好空格或以标点开头
  const b = { tag: 'b', tagName: 'B' };
  assert.equal(en.ctx.hint('丢掉 ', b, '，保留下来的轨', b, '，画质音质都不变，几秒到几十秒完成。').children.length, 5);
  assert.equal(
    en.ctx.hint('这条轨是', b, '，转成 FLAC 是数学无损的 —— 解码出来的采样逐字节相同。已经拿这个文件实测过：能压掉', b, '，约 1 MB。').children.length,
    5
  );
  // 中文界面一概不加
  assert.equal(zh.ctx.hint('已找到：', code('p')).children.length, 2);
  assert.equal(zh.ctx.hint(code('x'), '已找到：').children.length, 2);
});

test('R4-C：设置页这几处多句说明都用 hint() 拼，而且每一句都有英文', async () => {
  const { translate } = await load('src/renderer/lib/i18n.js');
  // 找 hint( 调用里相邻的两个字符串字面量（它们各自成一个文本节点、分开翻译）
  const re = /hint\(\s*((?:'[^'\n]*'\s*,\s*)+'[^'\n]*')\s*,?\s*\)/g;
  let found = 0;
  for (const m of APP.matchAll(re)) {
    const parts = [...m[1].matchAll(/'([^'\n]*)'/g)].map((x) => x[1]);
    if (parts.length < 2) continue;
    found++;
    for (const part of parts) assert.doesNotMatch(translate(part, 'en'), CJK, `没有英文：${part}`);
  }
  assert.ok(found >= 8, `找到的多句说明太少（${found}），正则可能失效了`);
});

/* ------------------------------ R4-D：结论页的换行 ------------------------------ */

test('R4-D：准备页的结论保留换行（white-space: pre-line），「原因\\n\\n怎么办」不再挤成一行', () => {
  const css = read('src/renderer/styles.css');
  const start = css.indexOf('.prep-note {');
  assert.ok(start !== -1);
  assert.match(css.slice(start, css.indexOf('}', start)), /white-space:\s*pre-line;/);
});

test('R4-D：结论后面换行接候选诊断的整段，英文界面两半都翻，换行原样留着', async () => {
  const { translate } = await load('src/renderer/lib/i18n.js');
  const note =
    '和房主的直连探测失败了：可能是房主那边的邀请链接放太久、网络地址已经过期，也可能双方都在严格 NAT 后面。重新生成一条应答链接发回给房主再试一次；还是不行就双方在设置里配同一个 TURN 中继。';
  const advice = '公网地址和中继候选都齐了。';
  const en = translate(`${note}\n\n诊断：${advice}`, 'en');
  assert.equal(en, `${translate(note, 'en')}\n\nDiagnosis: ${translate(advice, 'en')}`);
  assert.doesNotMatch(en, CJK);
  // 房主一侧邀请卡片上那条只换一行
  const card = '直连没建立起来。已经给你备好一条新的邀请链接，重发一次试试；双方都在严格 NAT 后面时需要在设置里配 TURN 中继。';
  const enCard = translate(`${card}\n诊断：${advice}`, 'en');
  assert.equal(enCard, `${translate(card, 'en')}\nDiagnosis: ${translate(advice, 'en')}`);
  assert.doesNotMatch(enCard, CJK);
  // 「没能加入房间」页那句组合提示照旧保留空行（E6-B）
  const join = translate(
    '连不上信令服务器：ws://127.0.0.1:9559（服务器没开、满载，或者网络不通）\n\n如果对方没有部署信令服务器，让他改用「极简模式」生成邀请码 —— 那个不需要服务器。',
    'en'
  );
  assert.match(join, /unreachable\)\n\nIf the other person/);
});
