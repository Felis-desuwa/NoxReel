'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { toolCandidates } = require('../src/main/media');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

/**
 * ffmpeg 的候选路径原来只有两条写死的 C:\ 目录，缺了 resourcesPath/bin 和 vendor/bin ——
 * 而 mpv 两条都有。后果是把 ffmpeg.exe 手动放进 vendor/bin 也照样找不到，
 * 放 mpv.exe 就能用。这是两边不一致，不是有意的取舍。
 *
 * 这里必须传参数进去测，不能直接断言 findFfmpeg()：开发机上 process.resourcesPath
 * 是 undefined，那样写出来的是一条永远走不到打包分支的空测试。
 */
test('打包后的 resources/bin 和源码树的 vendor/bin 排在最前', () => {
  const got = toolCandidates('ffmpeg', {
    resourcesPath: 'C:\\App\\resources',
    dirname: 'C:\\App\\resources\\app\\src\\main',
    platform: 'win32',
  });
  assert.equal(got[0], path.join('C:\\App\\resources', 'bin', 'ffmpeg.exe'));
  assert.equal(got[1], path.join('C:\\App\\resources\\app', 'vendor', 'bin', 'ffmpeg.exe'));
  // 原有的两条固定路径不能丢，老用户就是把 ffmpeg 装在那儿的
  assert.ok(got.includes(path.join('C:\\ffmpeg\\bin\\', 'ffmpeg.exe')));
  assert.ok(got.includes(path.join('C:\\Program Files\\ffmpeg\\bin\\', 'ffmpeg.exe')));
});

test('没打包时不会凭空造出一条 undefined 路径', () => {
  const got = toolCandidates('ffprobe', {
    resourcesPath: undefined,
    dirname: 'H:\\dev\\noxreel\\src\\main',
    platform: 'win32',
  });
  assert.ok(!got.some((p) => p.includes('undefined')));
  assert.equal(got[0], path.join('H:\\dev\\noxreel', 'vendor', 'bin', 'ffprobe.exe'));
});

test('ffmpeg 和 ffprobe 用同一套规则 —— 它们是两个可执行文件', () => {
  const opts = { resourcesPath: '/app/resources', dirname: '/app/resources/app/src/main', platform: 'linux' };
  const ffmpeg = toolCandidates('ffmpeg', opts);
  const ffprobe = toolCandidates('ffprobe', opts);
  assert.equal(ffmpeg.length, ffprobe.length);
  // 非 Windows 不加 .exe，也不带那两条 C:\ 路径
  assert.ok(ffmpeg.every((p) => !p.endsWith('.exe')));
  assert.ok(ffmpeg.every((p) => !p.includes('C:')));
});

test('和 mpv 的候选路径形状一致 —— 这正是原来不一致的地方', () => {
  const mpv = read('src', 'main', 'mpv.js');
  assert.match(mpv, /process\.resourcesPath\s*\?\s*\[path\.join\(process\.resourcesPath, 'bin'/);
  const media = read('src', 'main', 'media.js');
  assert.match(media, /resourcesPath \? \[path\.join\(resourcesPath, 'bin', exe\)\] : \[\]/);
  assert.match(media, /path\.join\(dirname, '\.\.', '\.\.', 'vendor', 'bin', exe\)/);
});

/**
 * ffprobe 缺失原来没人告知：env:status 返回了它，但依赖胶囊只看 mpv/ffmpeg/ytDlp。
 * 而 probeStreams 失败被 .catch(() => null) 吞掉，用户看到的是卡顿预判和无损精简
 * 无声无息地不见了。
 */
test('ffprobe 缺失会进依赖胶囊，并说清后果', () => {
  const app = read('src', 'renderer', 'app.js');
  assert.match(app, /if \(!S\.env\.ffprobe\) missing\.push\('ffprobe'\);/);
  assert.match(app, /卡顿预判和无损精简都会失效/);
  // 它和 ffmpeg 是两个程序，装了一个不代表另一个也在
  assert.match(app, /它和 ffmpeg 是两个程序/);
});

test('安装命令能一键复制，不用照着长串包名手抄', () => {
  const app = read('src', 'renderer', 'app.js');
  assert.match(app, /function copyableCommand\(command\)/);
  assert.match(app, /copyableCommand\('winget install shinchiro\.mpv Gyan\.FFmpeg yt-dlp\.yt-dlp'\)/);
  assert.match(app, /copyableCommand\('scoop install mpv ffmpeg yt-dlp'\)/);
  assert.match(app, /window\.sw\.clipboard\.writeText\(command\)/);
});

/**
 * boot() 以前只有 .then()。env:status 一旦 reject，用户就永远停在转圈的启动页上：
 * 没有报错、没有重试，看起来就是软件坏了。
 */
test('启动失败有兜底和重试，环境探测失败不致命', () => {
  const app = read('src', 'renderer', 'app.js');
  const tail = app.slice(app.indexOf('boot()\n') >= 0 ? app.indexOf('boot()\n') : app.lastIndexOf('boot()'));
  assert.ok(tail.length > 100, '找不到 boot 的调用处');
  assert.match(tail, /\.catch\(\(error\) => \{/);
  assert.match(tail, /启动失败：/);
  assert.match(tail, /text: '重试'/);
  // 探测本身失败要降级成「全都缺」，而不是把整个启动流程打断
  assert.match(app, /S\.env = \{\};/);
  // 地区探测的未处理拒绝也要接住
  assert.match(app, /window\.sw\.geo\.check\(\)\.then\(applyGeoNotice\)\.catch\(\(\) => \{\}\);/);
});

test('README 如实说明 ffmpeg 要自己装', () => {
  const zh = read('README.md');
  const en = read('README.en.md');
  assert.match(zh, /无损精简\*\*（需自行安装 ffmpeg）/);
  assert.match(zh, /winget install Gyan\.FFmpeg/);
  assert.match(en, /Lossless slim-down\*\* \(requires ffmpeg, installed separately\)/);
  // 别把「安装包自带 mpv 和 yt-dlp」这句说成也带了 ffmpeg
  const pkg = JSON.parse(read('package.json'));
  const shipped = pkg.build.extraResources.flatMap((r) => r.filter || []);
  assert.deepEqual(
    shipped.filter((f) => f.endsWith('.exe')).sort(),
    ['NoxReelPlayerBridge.exe', 'mpv.exe', 'yt-dlp.exe'],
    '随包带的第三方程序只有 mpv 和 yt-dlp，另一个是我们自己编的桥接程序'
  );
});

/**
 * 桥接程序必须随包走，而且落在 resources/bin —— 运行时只从 resourcesPath/bin 和
 * 仓库 vendor/bin 两处找它（见 players/bridge.js 文件头）。放错地方的后果不是报错，
 * 而是 PotPlayer / MPC-BE 在打包版里永远显示「桥接程序未构建」。
 */
test('外部播放器的桥接程序进打包资源，落点和运行时查找的一致', () => {
  const pkg = JSON.parse(read('package.json'));
  const entry = pkg.build.extraResources.find((r) => (r.filter || []).includes('NoxReelPlayerBridge.exe'));
  assert.ok(entry, 'extraResources 里没有桥接程序，打包后遥控不了外部播放器');
  assert.equal(entry.from, 'vendor/bin');
  assert.equal(entry.to, 'bin', '运行时按 resourcesPath/bin 找，改了这里就找不到了');

  const bridge = read('src', 'main', 'players', 'bridge.js');
  assert.match(bridge, /path\.join\(resourcesPath, 'bin', BRIDGE_EXE\)/);
  assert.match(bridge, /path\.join\(root, 'vendor', 'bin', BRIDGE_EXE\)/);

  // 产物不进 git，所以只能靠构建脚本；打包前必须自动跑一遍，别指望人记得
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'build-bridge.ps1')), '构建脚本本身必须在仓库里');
  assert.match(pkg.scripts['build:bridge'], /build-bridge\.ps1/);
  for (const hook of ['predist', 'predist:offline', 'predist:web']) {
    assert.match(pkg.scripts[hook], /build:bridge/, `${hook} 没有先构建桥接程序`);
  }
});

/**
 * 覆盖窗是 Electron 自己加载的页面，走 asar 就行 —— 但它必须真的被 files 收进去。
 * 少了它，外部播放器能放片，画面上却一条弹幕、一句横幅都不会有。
 */
test('覆盖窗页面进 asar，preload 和样式一个都不少', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(
    pkg.build.files.includes('src/**/*'),
    'files 收的是整个 src/**，覆盖窗页面才会跟着进包'
  );
  for (const rel of [
    ['src', 'renderer', 'overlay.html'],
    ['src', 'renderer', 'overlay', 'overlay.js'],
    ['src', 'renderer', 'overlay', 'overlay.css'],
    ['src', 'main', 'overlayPreload.js'],
  ]) {
    assert.ok(fs.existsSync(path.join(root, ...rel)), `${rel.join('/')} 不在仓库里`);
  }
  // 主进程按 __dirname/../renderer/overlay.html 加载它，路径变了就白打包
  const overlay = read('src', 'main', 'overlay.js');
  assert.match(overlay, /path\.join\(__dirname, '\.\.', 'renderer', 'overlay\.html'\)/);
});

/**
 * 弹幕输入的 Lua 脚本必须单独放在 asar 外面：asar 只有 Electron 自己认，
 * mpv 是另一个进程，路径指进 asar 它一个字节都读不到，表现是快捷键按了没反应。
 */
test('mpv 的弹幕输入脚本进打包资源，而且在 asar 外面', () => {
  const pkg = JSON.parse(read('package.json'));
  const entry = pkg.build.extraResources.find((r) => (r.filter || []).includes('noxreel-chat.lua'));
  assert.ok(entry, 'extraResources 里没有 Lua 脚本，打包后播放器内发不了弹幕');
  assert.equal(entry.from, 'resources/mpv-scripts');
  assert.equal(entry.to, 'mpv-scripts', '运行时按 resourcesPath/mpv-scripts 找，改了这里就找不到了');
  assert.ok(fs.existsSync(path.join(root, entry.from, 'noxreel-chat.lua')), '脚本本身必须在仓库里');
  // files 只打包 src/**，所以 resources/ 不会又被塞进 asar 里一份
  assert.ok(!pkg.build.files.some((f) => f.startsWith('resources')));
});

/**
 * mpv、yt-dlp 和桥接程序三个都躺在 vendor/bin，而 vendor/ 是 .gitignore 掉的。
 * extraResources 的源目录不存在时，electron-builder 只打一行
 * 「file source doesn't exist」的 warn 就接着往下走（app-builder-lib 的 copyFiles），
 * 安装包照样出得来、装得上，只是 resources/bin 是空的：用户打开看到「没装 mpv」，
 * 打包的人这边一个错都没有。所以三个 predist 钩子必须同时挂 build:bridge 和
 * prepare:runtime，少一个就是在默默发一个残包。
 */
test('随包的外部程序有构建前置，三个 predist 钩子都跑 prepare:runtime', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(
    fs.existsSync(path.join(root, 'scripts', 'prepare-runtime.ps1')),
    'vendor/ 不进 git，备好 mpv / yt-dlp 只能靠这个脚本'
  );
  assert.match(pkg.scripts['prepare:runtime'], /prepare-runtime\.ps1/);
  for (const hook of ['predist', 'predist:offline', 'predist:web']) {
    assert.match(pkg.scripts[hook], /prepare:runtime/, `${hook} 没有先备好 mpv / yt-dlp`);
  }
  // 随包的版本是钉死的：换 mpv / yt-dlp 必须连哈希一起改，不然 prepare-runtime 会拦下
  const lock = JSON.parse(read('scripts', 'runtime-lock.json'));
  assert.match(lock.mpv.sha256, /^[0-9a-f]{64}$/);
  assert.match(lock.ytDlp.sha256, /^[0-9a-f]{64}$/);
});

/* ------------------------- 真打出来的包（有产物才查） ------------------------- */

/** 只读 asar 头，返回「包内相对路径 → 字节数」。不依赖 @electron/asar，省得为一条断言加依赖。 */
function asarEntries(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    // 两层 pickle：前 8 字节给出 header 的长度；header 里 [4,8) 是 JSON 串长度，JSON 从第 8 字节起
    const sizeBuf = Buffer.alloc(8);
    fs.readSync(fd, sizeBuf, 0, 8, 0);
    const headerBuf = Buffer.alloc(sizeBuf.readUInt32LE(4));
    fs.readSync(fd, headerBuf, 0, headerBuf.length, 8);
    const header = JSON.parse(headerBuf.toString('utf8', 8, 8 + headerBuf.readUInt32LE(4)));
    const out = new Map();
    const walk = (node, prefix) => {
      for (const [name, value] of Object.entries(node.files || {})) {
        const rel = prefix ? `${prefix}/${name}` : name;
        if (value.files) walk(value, rel);
        else out.set(rel, value.size);
      }
    };
    walk(header, '');
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

const unpackedDir = path.join(root, 'dist', 'win-unpacked');
const packedAsar = path.join(unpackedDir, 'resources', 'app.asar');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const REBUILD_HINT = '重新打一遍：npm run build:bridge && npm run prepare:runtime && npx electron-builder --dir';

/**
 * 为什么是「跳过」而不是「失败」：dist/ 是本地产物，改完源文件它立刻就过期了，
 * 过期的包和现在的源码没有可比性。硬拿它断言的话，每改一次覆盖窗、每改一次 Lua 脚本，
 * 全量测试就跟着红一次 —— 那种红是噪音，人只会学会无视它。所以：没打过包跳过，
 * 这一条要比的源文件里有谁比包新也跳过，只有「打完之后没再动过」的包才真查。
 * 只看这一条自己要比的那几个文件，不看整个 src/：改别处的代码不该让这里失去判断力。
 */
function packagedState(sources) {
  if (!fs.existsSync(packedAsar)) return { skip: '没有 dist/win-unpacked，' + REBUILD_HINT };
  const builtAt = fs.statSync(packedAsar).mtimeMs;
  for (const abs of sources) {
    if (fs.existsSync(abs) && fs.statSync(abs).mtimeMs > builtAt) {
      return { skip: `${path.relative(root, abs)} 比 dist/win-unpacked 新，产物已过期；${REBUILD_HINT}` };
    }
  }
  return { skip: null };
}

/**
 * 上面那些断的都是 package.json 里「写了什么」，这两条断的是真打出来的包里「有什么」——
 * 两者不等价：files 收着 src/**，但只要有人往里补一条 "!src/renderer/overlay/**"
 * 之类的排除，静态断言照样全绿，覆盖窗却没进包，外部播放器上一条弹幕都不会出现。
 * dist/ 不进 git，所以没打过包就跳过。
 */
test('打出来的包里，覆盖窗页面确实在 asar 内', (t) => {
  const inside = [
    'src/renderer/overlay.html',
    'src/renderer/overlay/overlay.js',
    'src/renderer/overlay/overlay.css',
    'src/main/overlayPreload.js',
    'src/main/players/bridge.js',
  ];
  const { skip } = packagedState(inside.map((rel) => path.join(root, ...rel.split('/'))));
  if (skip) return t.skip(skip);
  const entries = asarEntries(packedAsar);
  for (const rel of inside) {
    assert.ok(entries.get(rel) > 0, `asar 里没有 ${rel}，打包版的覆盖窗会是空的。${REBUILD_HINT}`);
  }
  // mpv 和外部播放器都是别的进程，读不到 asar：这两类文件进了 asar 等于没打包
  assert.deepEqual(
    [...entries.keys()].filter((k) => k.endsWith('.lua') || k.endsWith('.exe')),
    [],
    'asar 里不该有 .lua / .exe —— 它们只有放在 asar 外面才用得上'
  );
});

test('打出来的包里，mpv 和外部播放器要的文件确实在 asar 外', (t) => {
  // 键是包内的落点，值是它该和仓库里的哪一份一模一样
  const outside = {
    'resources/mpv-scripts/noxreel-chat.lua': path.join(root, 'resources', 'mpv-scripts', 'noxreel-chat.lua'),
    'resources/bin/NoxReelPlayerBridge.exe': path.join(root, 'vendor', 'bin', 'NoxReelPlayerBridge.exe'),
    'resources/bin/mpv.exe': path.join(root, 'vendor', 'bin', 'mpv.exe'),
    'resources/bin/yt-dlp.exe': path.join(root, 'vendor', 'bin', 'yt-dlp.exe'),
  };
  const { skip } = packagedState(Object.values(outside));
  if (skip) return t.skip(skip);
  for (const [rel, source] of Object.entries(outside)) {
    const packed = path.join(unpackedDir, ...rel.split('/'));
    assert.ok(fs.existsSync(packed), `打包资源里缺 ${rel}（源目录不在时 electron-builder 只 warn 不报错）。${REBUILD_HINT}`);
    // vendor/ 是构建产物，不一定在；在的话就要求字节一致，免得包里是上一版
    if (fs.existsSync(source)) {
      assert.equal(sha256(packed), sha256(source), `${rel} 和仓库里的那一份对不上。${REBUILD_HINT}`);
    }
  }
  // 随包的 mpv 就是 runtime-lock 里钉死的那一个版本
  const lock = JSON.parse(read('scripts', 'runtime-lock.json'));
  assert.equal(sha256(path.join(unpackedDir, 'resources', 'bin', 'mpv.exe')), lock.mpv.sha256);
  // 编译桥接程序留下的哈希戳不该跟着进包
  assert.ok(!fs.existsSync(path.join(unpackedDir, 'resources', 'bin', 'NoxReelPlayerBridge.exe.srchash')));
});
