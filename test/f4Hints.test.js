'use strict';

// 修复 F4（端到端实测发现的提示与文案问题）的回归测试：
//  - E6-B：组合模板把原因、模式名、名单原样代入，英文界面里夹着中文（桌面和安卓的 i18n 都查了一遍）；
//  - E6-C：一对一打洞超时的结论补上「对方可能已经取消或关掉了」；
//  - E6-D：Cloudflare 回 404 单独归成「Turn Token ID 不对」（两端文案，不在后台重试之列）；
//  - E4-A：复用核对完成的那一句把对端先送到的片分开算，本机副本完好就说「核对通过」；
//  - E4-B：盘不在、没权限这类文件系统报错说人话（主进程 fsErrorText.js）；
//  - E4-C：启动时缓存目录准备失败的日志去掉 Electron 套的前缀；
//  - E4-D：混合拖放时被跳过的文件在准备页上也看得到，离开准备页就撤；
//  - E4-F：用完的工作目录连外层空的 .noxreel-downloading 一起删。
// E3-A 的测试在 miscFixes15.test.js（acceptManualAnswer 那一组），E4-E 在 prepPipeline.test.js（选方案弹窗）。
// 全程不联网、不起播放器、不出声。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const APP = read('src/renderer/app.js');
const APP_ANDROID = read('android/app/src/main/assets/js/app-android.js');

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

const CJK = /[\u4e00-\u9fff]/;

/* ------------------------------ E6-B：组合模板递归翻译 ------------------------------ */

test('E6-B：「没能加入房间」页那句组合提示递归翻译，英文界面里不再夹着中文', async () => {
  const { translate } = await load('src/renderer/lib/i18n.js');
  const zh =
    '连不上信令服务器：ws://10.0.0.2:8080（服务器没开、满载，或者网络不通）\n\n如果对方没有部署信令服务器，让他改用「极简模式」生成邀请码 —— 那个不需要服务器。';
  assert.equal(
    translate(zh, 'en'),
    'Cannot connect to signaling server: ws://10.0.0.2:8080 (the server is down or full, or the network is unreachable)\n\nIf the other person has no signaling server, ask them to use Manual mode, which requires no server.'
  );
});

test('E6-B：桌面端带原因、模式名的组合模板都把那一段也翻过去', async () => {
  const { translate } = await load('src/renderer/lib/i18n.js');
  for (const zh of [
    '换不了：正在放映时不能换缓存目录，退出房间后再改',
    '改不了：正在放映时不能换缓存目录，退出房间后再改',
    '统计不出来：缓存目录尚未初始化',
    '清不掉：缓存目录尚未初始化',
    '删不掉：拒绝删除缓存根目录之外的路径',
    '没清掉：还没保存 Cloudflare 凭据',
    '启动失败：缓存目录尚未初始化',
    '缓存不了：缓存目录尚未初始化',
    '存不到下载位置：没有权限写入这个位置',
    '运行环境检查失败：缓存目录尚未初始化',
    '缓存目录准备失败：要建文件夹的地方已经有一个同名文件',
    '没能生成邀请链接：还没保存 Cloudflare 凭据',
    '生成邀请链接失败：还没保存 Cloudflare 凭据',
    '上行带宽没测出来，跳过卡顿预判：测速超过 15 秒',
    '房间使用可信房间，你的本机设置是安全模式。请在设置里切换为相同模式，再点「加入」重试。',
    '对方选择的是安全模式，本房间是可信房间。双方需分别选择相同模式。',
    'peer-1 的模式是安全模式，本房间是可信房间，已在传输媒体前断开。',
    '已和 Alice 完成可信房间握手',
    '你配置的 Q:\\nxcache 这次用不了（所在的盘 Q: 不在，可能是移动硬盘没插、网络盘没连上或者盘符变了），已临时用回系统临时目录。',
  ]) {
    const en = translate(zh, 'en');
    assert.notEqual(en, zh, `没翻：${zh}`);
    assert.ok(!CJK.test(en), `英文里还夹着中文：${en}`);
  }
  // 片名是用户内容，原样保留；原因照翻
  assert.equal(
    translate('《片子.mkv》下载失败：没有权限写入这个位置', 'en'),
    'Could not download “片子.mkv”: No permission to write to this location'
  );
  assert.equal(
    translate('《片子.mkv》缓存失败：缓存目录尚未初始化', 'en'),
    'Could not cache “片子.mkv”: The cache directory has not been initialized'
  );
  assert.equal(
    translate('《片子.mkv》存不到下载位置：这个盘是只读的，写不进去', 'en'),
    'Could not save “片子.mkv” to the download folder: This drive is read-only'
  );
  assert.equal(translate('已和 Alice 完成安全模式握手', 'en'), 'Completed Safe mode handshake with Alice');
  // 解析失败带原因时冒号不能丢（以前是 'Unable to parse this video URLERROR: …'）
  assert.equal(translate('无法解析这个视频链接：ERROR: Unsupported URL', 'en'), 'Unable to parse this video URL: ERROR: Unsupported URL');
  assert.equal(translate('无法解析这个视频链接', 'en'), 'Unable to parse this video URL');
  // 原因认不出来（英文的系统报错）就原样带着
  assert.equal(translate('换不了：EBUSY: resource busy', 'en'), 'Could not change it: EBUSY: resource busy');
  // 装外部程序的提示：安装命令和环境变量那两段里夹着的「或」「指向」也要换掉（原文见 media.js / mpv.js）
  const ffmpeg = /new Error\('(没找到 ffmpeg。[^']+)'\)/.exec(read('src/main/media.js'))[1];
  const mpv = /new Error\('(没找到 mpv。[^']+)'\)/.exec(read('src/main/mpv.js'))[1];
  assert.equal(
    translate(ffmpeg, 'en'),
    'ffmpeg was not found. Install it (winget install ffmpeg or scoop install ffmpeg) or set SYNCWATCH_FFMPEG_PATH.'
  );
  assert.equal(
    translate(mpv, 'en'),
    'mpv was not found. Install it (winget install mpv or scoop install mpv) or set SYNCWATCH_MPV_PATH to point to mpv.exe.'
  );
});

test('E4-E：选方案弹窗「产物」一段的两种说法都有英文', async () => {
  const { translate } = await load('src/renderer/lib/i18n.js');
  assert.equal(translate('不生成新文件，直接传原文件。', 'en'), 'No new file is created; the original file is sent as is.');
  assert.ok(!CJK.test(translate('生成一个新文件放进临时缓存，原文件不动，退房时自动清理。', 'en')));
});

test('E6-B：安卓端的模式名、等待名单、信令错误也递归翻译', async () => {
  const { translate } = await load('android/app/src/main/assets/js/i18n.js');
  // 安卓的 securityModeLabel 拼进去的是中文模式名（桌面端拼之前先翻过了）
  assert.match(APP_ANDROID, /const securityModeLabel = \(mode\) => \(normalizeSecurityMode\(mode\) === 'trusted' \? '可信房间' : '安全模式'\);/);
  assert.equal(translate('已和 Alice 完成可信房间握手', 'en'), 'Completed Trusted room handshake with Alice');
  assert.equal(
    translate('模式不一致：本机是安全模式，对方是可信房间，已在传输媒体前断开。', 'en'),
    'Mode mismatch: this device uses Safe mode and the peer uses Trusted room. Disconnected before media transfer.'
  );
  assert.equal(
    translate('房间使用可信房间，本机设置是安全模式。请切换为相同模式后重试。', 'en'),
    'The room uses Trusted room while this device uses Safe mode. Select the same mode and try again.'
  );
  // 名单里「你」要翻，别人的昵称一个字不动
  assert.equal(translate('⏳ 等待缓冲：你、小明', 'en'), '⏳ Waiting for buffer: you, 小明');
  assert.equal(
    translate('信令错误：连不上信令服务器：ws://10.0.0.2:8080（服务器没开、满载，或者网络不通）', 'en'),
    'Signaling error: Cannot connect to signaling server: ws://10.0.0.2:8080 (the server is down or full, or the network is unreachable)'
  );
});

/* ------------------------------ E6-C：一对一超时 ------------------------------ */

test('E6-C：一对一打洞超时的结论也说「对方可能已经取消或关掉了」，两种语言都有', async () => {
  const { translate } = await load('src/renderer/lib/i18n.js');
  const body = fnSource('watchManualHandshake');
  const m = /'(打洞一直没成功：[^']+)'/.exec(body);
  assert.ok(m, '超时那句没找到');
  assert.match(m[1], /对方可能已经取消或关掉了/);
  const en = translate(m[1], 'en');
  assert.notEqual(en, m[1], '新句子缺英文');
  assert.match(en, /canceled or closed/);
});

/* ------------------------------ E6-D：Turn Token ID 不对 ------------------------------ */

const BAD_KEY_TEXT = 'Turn Token ID 不对：Cloudflare 找不到这个 ID，请到 Cloudflare 控制台核对';

test('E6-D：两端都把 CF_BAD_KEY_ID 说成「Turn Token ID 不对」，而且不在后台自动重试之列', async () => {
  for (const [label, src] of [
    ['桌面端', APP],
    ['安卓端', APP_ANDROID],
  ]) {
    assert.ok(src.includes(`CF_BAD_KEY_ID: '${BAD_KEY_TEXT}',`), `${label}缺 CF_BAD_KEY_ID 的文案`);
    const retryable = /const CF_RETRYABLE = new Set\(\[([^\]]*)\]\);/.exec(src)[1];
    assert.ok(!retryable.includes('CF_BAD_KEY_ID'), `${label}：填错了 ID 后台重试没用，要用户去改`);
  }
  for (const rel of ['src/renderer/lib/i18n.js', 'android/app/src/main/assets/js/i18n.js']) {
    const { translate } = await load(rel);
    assert.equal(translate(BAD_KEY_TEXT, 'en'), 'Wrong Turn Token ID: Cloudflare cannot find this ID. Check it in the Cloudflare dashboard', rel);
    assert.equal(
      translate(`Cloudflare TURN：${BAD_KEY_TEXT}`, 'en'),
      'Cloudflare TURN: Wrong Turn Token ID: Cloudflare cannot find this ID. Check it in the Cloudflare dashboard',
      rel
    );
  }
  // 安卓原生层同一套归类：404 排在「其余非 2xx 算看不懂」之前
  const kt = read('android/app/src/main/java/com/syncwatch/app/CloudflareTurn.kt');
  const gen = kt.slice(kt.indexOf('private fun generate('), kt.indexOf('private fun readLimited('));
  const notFound = gen.indexOf('if (status == 404) throw CfException("CF_BAD_KEY_ID", "HTTP $status")');
  const bad = gen.indexOf('if (status !in 200..299) throw CfException("CF_BAD_RESPONSE"');
  assert.ok(notFound > 0 && bad > notFound, '安卓端 404 没单独归类');
});

test('E6-D：保存凭据时报 CF_BAD_KEY_ID 不再拖着「（HTTP 404）」', () => {
  const m = /^const CF_ERROR_TEXT = \{[\s\S]*?\n\};$/m.exec(APP);
  assert.ok(m);
  const ctx = sandbox({ fns: ['cfErrorCode', 'cfErrorText', 'cfErrorDetail'], globals: { cfQuotaText: () => '到上限了' } });
  vm.runInContext(m[0], ctx);
  assert.equal(ctx.cfErrorDetail(new Error("Error invoking remote method 'turn:cfSave': Error: [CF_BAD_KEY_ID] HTTP 404")), BAD_KEY_TEXT);
});

/* ------------------------------ E4-A：复用核对完成的那一句 ------------------------------ */

test('E4-A：对端先送到的片不算对不上，本机核对过的全对得上就说「核对通过」', async () => {
  const ctx = sandbox({ fns: ['reuseDoneLine'] });
  const line = (e) => Array.from(ctx.reuseDoneLine(e));
  // 实测那一场：716 片，核对到之前对端已经送来 1 片
  assert.deepEqual(line({ name: 'big.mkv', total: 716, matched: 715, fromPeer: 1 }), [
    '本机已有的《big.mkv》核对通过（1 片在核对到之前已从对端收到）',
    'good',
  ]);
  assert.deepEqual(line({ name: 'big.mkv', total: 716, matched: 716, fromPeer: 0 }), ['本机已有的《big.mkv》核对通过，不用再传', 'good']);
  // 真有对不上的：分母只算本机核对过的
  assert.deepEqual(line({ name: 'big.mkv', total: 716, matched: 700, fromPeer: 1 }), [
    '本机的《big.mkv》有 700/715 片对得上，其余照常接收',
    'warn',
  ]);
  assert.deepEqual(line({ name: 'big.mkv', total: 716, matched: 0 }), ['本机的《big.mkv》和这一部对不上，重新接收', 'warn']);
  // 抽查阶段就收尾的那条不带 fromPeer
  assert.deepEqual(line({ name: 'a.mkv', total: 6, matched: 6 }), ['本机已有的《a.mkv》核对通过，不用再传', 'good']);
  assert.match(APP, /else if \(e\.stage === 'done'\) log\(\.\.\.reuseDoneLine\(e\)\);/);

  const { translate } = await load('src/renderer/lib/i18n.js');
  assert.equal(
    translate('本机已有的《片子.mkv》核对通过（1 片在核对到之前已从对端收到）', 'en'),
    '“片子.mkv” on this computer checks out (1 chunk had already arrived from others before being checked)'
  );
  assert.equal(
    translate('本机已有的《片子.mkv》核对通过（3 片在核对到之前已从对端收到）', 'en'),
    '“片子.mkv” on this computer checks out (3 chunks had already arrived from others before being checked)'
  );
});

/* ------------------------------ E4-B：文件系统报错说人话 ------------------------------ */

const { describeFsError } = require('../src/main/fsErrorText');
const fsError = (code, message = `${code}: something, mkdir 'x'`) => Object.assign(new Error(message), { code });

/** 这台机器上没有的盘符（Z 往前找），找不到就返回空串。 */
function missingDriveLetter() {
  for (const letter of 'ZYXWVUTSRQPONMLKJIHG') if (!fs.existsSync(`${letter}:\\`)) return letter;
  return '';
}

test('E4-B：常见的文件系统报错换成人话，认不出的原样返回', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'noxreel-fserr-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  assert.equal(await describeFsError(fsError('EACCES')), '没有权限写入这个位置');
  assert.equal(await describeFsError(fsError('EPERM')), '没有权限写入这个位置');
  assert.equal(await describeFsError(fsError('EEXIST')), '要建文件夹的地方已经有一个同名文件');
  assert.equal(await describeFsError(fsError('EROFS')), '这个盘是只读的，写不进去');
  assert.equal(await describeFsError(fsError('EBUSY')), '这个位置正被别的程序占用');
  assert.equal(await describeFsError(fsError('EIO')), '读写这个盘时出错，盘可能出了问题或者刚被拔掉');
  // 盘在，只是文件夹没了
  assert.equal(await describeFsError(fsError('ENOENT'), path.join(dir, 'gone', 'kept')), '找不到这个位置，可能已被移走或删掉');
  assert.equal(await describeFsError(fsError('ENOENT')), '找不到这个位置，可能已被移走或删掉');
  assert.equal(await describeFsError(fsError('ENOTDIR'), dir), '路径里有一段是文件、不是文件夹');
  // 认不出来的：原话
  assert.equal(await describeFsError(fsError('EWHATEVER', '奇怪的错')), '奇怪的错');
  assert.equal(await describeFsError(new Error('缓存目录不能放在这里')), '缓存目录不能放在这里');
});

test('E4-B：整个盘不在（移动硬盘没插）说成「所在的盘 X: 不在」，不是「ENOENT … mkdir \\\\?」', { skip: process.platform !== 'win32' }, async (t) => {
  const letter = missingDriveLetter();
  if (!letter) return t.skip('这台机器上找不到空着的盘符');
  const text = await describeFsError(fsError('ENOENT', "ENOENT: no such file or directory, mkdir '\\\\?'"), `${letter}:\\nxcache`);
  assert.equal(text, `所在的盘 ${letter}: 不在，可能是移动硬盘没插、网络盘没连上或者盘符变了`);
  const { translate } = await load('src/renderer/lib/i18n.js');
  assert.equal(
    translate(`没法接收《片子.mkv》：缓存位置用不了：${text}`, 'en'),
    `Cannot receive “片子.mkv”: the cache location is unavailable: The drive ${letter}: is not available—a removable drive may be unplugged, a network drive disconnected, or the drive letter changed`
  );
});

test('E4-B：人话的原因都有英文', async () => {
  const { translate } = await load('src/renderer/lib/i18n.js');
  const src = read('src/main/fsErrorText.js');
  const body = src.slice(src.indexOf('async function describeFsError('), src.indexOf('async function missingDrive('));
  const fixed = [...body.matchAll(/'([^'\n]*[一-鿿][^'\n]*)'/g)].map((m) => m[1]);
  assert.ok(fixed.length >= 8, `只找到 ${fixed.length} 句`);
  for (const zh of fixed) assert.ok(!CJK.test(translate(zh, 'en')), `缺英文：${zh}`);
  assert.equal(
    translate('所在的盘 \\\\nas\\movies 不在，可能是移动硬盘没插、网络盘没连上或者盘符变了', 'en'),
    'The drive \\\\nas\\movies is not available—a removable drive may be unplugged, a network drive disconnected, or the drive letter changed'
  );
});

test('E4-B：主进程的「配置的目录这次用不了」和接收失败都经 describeFsError', () => {
  const main = read('src/main/main.js');
  const fn = main.slice(main.indexOf('async function ensureCacheReady('), main.indexOf('app.whenReady()'));
  assert.match(fn, /cacheFallback = \{ configured: cache\.rootDir, reason: await describeFsError\(error, cache\.rootDir\) \};/);
  const store = read('src/main/fileStore.js');
  assert.match(store, /throw await asCacheIoError\(error, manual \? keptDir : cacheManager\.rootDir\);/);
  assert.match(store, /new Error\(`缓存位置用不了：\$\{await describeFsError\(error, where\)\}`\)/);
});

/* ------------------------------ E4-C：去掉 Electron 的前缀 ------------------------------ */

test('E4-C：启动时的两条失败日志只留我们自己那句，不带「Error invoking remote method」', async () => {
  const ctx = sandbox({ fns: ['ipcErrorText'] });
  assert.equal(
    ctx.ipcErrorText(new Error("Error invoking remote method 'app:ensureDirs': Error: 要建文件夹的地方已经有一个同名文件")),
    '要建文件夹的地方已经有一个同名文件'
  );
  assert.equal(ctx.ipcErrorText(new Error("Error invoking remote method 'env:status': TypeError: 无效的 地区检测参数")), '无效的 地区检测参数');
  assert.equal(ctx.ipcErrorText(new Error('本来就没前缀')), '本来就没前缀');
  assert.equal(ctx.ipcErrorText('字符串'), '字符串');
  const boot = fnSource('boot');
  assert.match(boot, /log\(`缓存目录准备失败：\$\{ipcErrorText\(error\)\}`, 'bad'\);/);
  assert.match(boot, /log\(`运行环境检查失败：\$\{ipcErrorText\(error\)\}`, 'bad'\);/);
  // app:ensureDirs 把原因换成人话再交给页面
  const main = read('src/main/main.js');
  const handler = main.slice(main.indexOf("secureHandle('app:ensureDirs'"));
  assert.match(handler.slice(0, handler.indexOf('\n});\n')), /throw new Error\(await describeFsError\(error, cache\.rootDir\)\);/);
  const { translate } = await load('src/renderer/lib/i18n.js');
  assert.equal(
    translate('缓存目录准备失败：要建文件夹的地方已经有一个同名文件', 'en'),
    'Could not prepare the cache directory: A file with the same name is already where the folder should go'
  );
});

/* ------------------------------ E4-D：准备页也列出被跳过的文件 ------------------------------ */

function prepDom() {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) {
      els.set(id, {
        id,
        children: [],
        replaceChildren(...c) {
          this.children = c;
        },
        classList: { add() {}, remove() {}, toggle() {} },
      });
    }
    return els.get(id);
  };
  return { $, texts: (id) => $(id).children.map((c) => c.text) };
}

test('E4-D：混合拖放时被跳过的文件在准备页上也列出来，离开准备页（进房、回首页）就撤', async () => {
  const dom = prepDom();
  const calls = [];
  const ctx = sandbox({
    fns: ['startHostMany', 'renderDropFailures', 'show'],
    decls: ['DROP_FAILURES_SHOWN', 'dropFailureLine'],
    globals: {
      $: dom.$,
      make: (tag, opts = {}) => ({ tag, text: opts.text }),
      document: { querySelectorAll: () => [] },
      baseName: (p) => p,
      startHost: async (p) => {
        calls.push(['startHost', p, dom.texts('prep-skipped')]);
        ctx.show('view-prepare');
        return { outcome: 'failed', message: '坏了' };
      },
      queueLocalFiles: () => {},
      prepFail: (msg) => calls.push(['prepFail', msg, dom.texts('prep-skipped')]),
      prepStop: () => {},
    },
  });
  const skipped = [{ name: 'x.rmvb', reason: 'RM/RMVB 只能重新编码、没法无损封成 MKV，不支持' }];
  // 两部都没开成：一部接一部地准备，最后是「这些也没能用」的结论页
  await ctx.startHostMany(['D:/a.mkv', 'D:/b.mkv'], skipped);
  const line = '没加上《x.rmvb》：RM/RMVB 只能重新编码、没法无损封成 MKV，不支持';
  assert.deepEqual(calls[0], ['startHost', 'D:/a.mkv', [line]], '准备的时候就看得到');
  assert.deepEqual(calls[1], ['startHost', 'D:/b.mkv', [line]], '换下一部接着准备时还在');
  assert.deepEqual(calls[2], ['prepFail', '坏了', [line]], '失败的结论页上也还在');
  ctx.show('view-home');
  assert.deepEqual(dom.texts('prep-skipped'), [], '回首页就撤掉，别带到下一次加入里');

  // 点选的（没有被跳过的）不碰这一栏
  calls.length = 0;
  await ctx.startHostMany(['D:/b.mkv']);
  assert.deepEqual(calls[0][2], []);

  const drop = APP.slice(APP.indexOf("dz.addEventListener('drop'"), APP.indexOf('async function approvedDropPaths('));
  assert.match(drop, /startHostMany\(paths, failures\);/);
  assert.match(read('src/renderer/index.html'), /id="prep-skipped"/);
});

/* ------------------------------ E4-F：空的 .noxreel-downloading 一起删 ------------------------------ */

test('E4-F：removeWorkDir 删掉工作目录，外层 .noxreel-downloading 空了一起删，别的任务还在用时不动', async (t) => {
  const { removeWorkDir, WORK_DIR } = require('../src/main/linkCache');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'noxreel-workdir-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const outer = path.join(dir, WORK_DIR);
  const a = path.join(outer, 'a');
  const b = path.join(outer, 'b');
  await fsp.mkdir(a, { recursive: true });
  await fsp.mkdir(b, { recursive: true });
  await fsp.writeFile(path.join(a, 'x.part'), 'x');
  await fsp.writeFile(path.join(b, 'y.part'), 'y');

  await removeWorkDir(a);
  assert.equal(fs.existsSync(a), false);
  assert.equal(fs.existsSync(path.join(b, 'y.part')), true, '别的任务的半截文件不能动');
  await removeWorkDir(b);
  assert.equal(fs.existsSync(outer), false, '最后一个用完，外层空了一起删');
  assert.deepEqual(fs.readdirSync(dir), []);

  // 已经没了也不报错；父目录不叫 .noxreel-downloading 的不去碰
  await removeWorkDir(a);
  const other = path.join(dir, 'other', 'job');
  await fsp.mkdir(other, { recursive: true });
  await removeWorkDir(other);
  assert.equal(fs.existsSync(path.join(dir, 'other')), true);
});

test('E4-F：在线视频下完挪到位时也经 removeWorkDir（主进程 workDirIn）', () => {
  const main = read('src/main/main.js');
  const fn = main.slice(main.indexOf('async function workDirIn('), main.indexOf('const linkCache = new LinkCache('));
  const finish = fn.slice(fn.indexOf('finish:'), fn.indexOf('abort:'));
  assert.match(finish, /await removeWorkDir\(work\);/);
  assert.match(read('src/main/downloadSaver.js'), /finally \{[\s\S]{0,200}await removeWorkDir\(work\);/);
});
