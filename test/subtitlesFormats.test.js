'use strict';

// 外挂字幕随片走、以及更多视频格式（0.7.3）。
//
// 两件事用的是同一个办法：房主本机用 ffmpeg 无损封成 MKV，接收方只见到 MKV。
// 所以这里守三道：房主能选的格式放宽了、接收方收的格式没放宽；字幕的编码认对了；
// 拼给 ffmpeg 的参数把轨道、默认标记、语言都安排对了。最后用真 ffmpeg 跑一遍（没装就跳过）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const guard = require('../src/main/mediaGuard');
const subtitles = require('../src/main/subtitles');
const media = require('../src/main/media');

const root = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8').replace(/\r\n/g, '\n');

// PowerShell 用 936 / 950 / 932 代码页编出来的真实字节
const GBK_SRT = Buffer.from(
  '310d0a30303a30303a30312c303030202d2d3e2030303a30303a30332c3030300d0aced2c3c7bdf1cceccdedc9cfd2bbc6f0bfb4d5e2b2bfb5e7d3b0a3acbac3c2f0a3bf0d0a0d0a320d0a30303a30303a30342c303030202d2d3e2030303a30303a30362c3030300d0ac4e3cbb5b5c3b6d4a3acd5e2b8f6cecacce2badcd6d8d2aaa1a30d0a',
  'hex'
);
const BIG5_SRT = Buffer.from(
  '310d0a30303a30303a30312c303030202d2d3e2030303a30303a30332c3030300d0aa7daadcca4b5a4d1b1dfa457a440b05facddb36fb3a1b971bc76a141a66eb6dca1480d0a0d0a320d0a30303a30303a30342c303030202d2d3e2030303a30303a30362c3030300d0aa741bba1b16fb9efa141b36fadd3b0ddc344abdcadabad6ea1430d0a',
  'hex'
);
const SJIS_SRT = Buffer.from(
  '310d0a30303a30303a30312c303030202d2d3e2030303a30303a30332c3030300d0a8da193fa82cd88ea8f8f82c9896689e682f08ca982dc82b582e582a481420d0a0d0a320d0a30303a30303a30342c303030202d2d3e2030303a30303a30362c3030300d0a82bb82a482c582b782cb814182c682c482e091e58e9682c896e291e882c582b781420d0a',
  'hex'
);
const ASS = [
  '[Script Info]',
  'ScriptType: v4.00+',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:00.50,0:00:01.50,Default,,0,0,0,,简日双语字幕',
  '',
].join('\n');

async function tempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'noxreel-subs-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

/* ------------------------------ 格式白名单 ------------------------------ */

test('房主能选的格式放宽了，接收方收的格式没放宽', () => {
  for (const name of ['a.avi', 'a.ts', 'a.M2TS', 'a.wmv', 'a.webm', 'a.flv', 'a.mpg', 'a.vob', 'a.ogv', 'a.3gp', 'a.mkv', 'a.mp4']) {
    assert.equal(guard.validateSourceName(name), name, `${name} 应该能被房主选中`);
  }
  // RM/RMVB：ffmpeg 的 Matroska 封装器不收 RealVideo，只能重编码，不算无损
  for (const name of ['a.rmvb', 'a.rm', 'a.exe', 'a.srt', 'noext']) {
    assert.throws(() => guard.validateSourceName(name), /不支持这种视频格式|无效的媒体文件名/, name);
  }
  // 接收方：AVI 这类永远不会以原样出现在清单里 —— 进房前已经封成 MKV
  for (const name of ['a.avi', 'a.ts', 'a.webm']) {
    assert.throws(() => guard.validateManifestName(name), /只允许接收/, name);
  }
  assert.equal(guard.validateManifestName('a.mkv'), 'a.mkv');
});

test('外挂字幕只收文本格式', () => {
  for (const name of ['a.ass', 'a.SSA', 'a.srt', 'a.vtt']) assert.equal(guard.validateSubtitleName(name), name);
  for (const name of ['a.sup', 'a.idx', 'a.sub', 'a.txt', 'a.mkv']) {
    assert.throws(() => guard.validateSubtitleName(name), /只支持 ASS、SSA、SRT、VTT 字幕/, name);
  }
});

test('inspect：AVI 这类报 convert，并说清楚是无损封 MKV', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'x.avi');
  await fsp.writeFile(file, Buffer.alloc(64));
  const info = await media.inspect(file);
  assert.equal(info.action, 'convert');
  assert.equal(info.label, 'AVI');
  assert.match(info.reason, /^AVI 要先无损封成 MKV 才能传：只换容器、不重新编码/);
  assert.equal(media.formatLabel('.webm'), 'WebM');
  const rm = path.join(dir, 'x.rmvb');
  await fsp.writeFile(rm, Buffer.alloc(64));
  const rejected = await media.inspect(rm);
  assert.equal(rejected.action, 'reject');
  assert.equal(rejected.reason, '不支持这种视频格式：.rmvb');
});

/* ------------------------------ 编码识别 ------------------------------ */

test('字幕编码：GBK、Big5、Shift-JIS 都认得出，解出来是正确的字', () => {
  const gbk = subtitles.decodeSubtitle(GBK_SRT);
  assert.equal(gbk.encoding, 'gb18030');
  assert.match(gbk.text, /我们今天晚上一起看这部电影，好吗？/);

  const big5 = subtitles.decodeSubtitle(BIG5_SRT);
  assert.equal(big5.encoding, 'big5');
  assert.match(big5.text, /我們今天晚上一起看這部電影，好嗎？/);

  const sjis = subtitles.decodeSubtitle(SJIS_SRT);
  assert.equal(sjis.encoding, 'shift_jis');
  assert.match(sjis.text, /今日は一緒に映画を見ましょう。/);
});

test('字幕编码：BOM 与合法 UTF-8 直接认，不去猜', () => {
  const text = '1\n00:00:01,000 --> 00:00:02,000\n你好\n';
  const utf8 = subtitles.decodeSubtitle(Buffer.from(text, 'utf8'));
  assert.deepEqual([utf8.encoding, utf8.text], ['utf-8', text]);
  const bom = subtitles.decodeSubtitle(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]));
  assert.deepEqual([bom.encoding, bom.text], ['utf-8', text], 'BOM 要去掉');
  const utf16 = subtitles.decodeSubtitle(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
  assert.deepEqual([utf16.encoding, utf16.text], ['utf-16le', text]);
});

test('字幕内容要像它的扩展名说的那种格式', () => {
  assert.doesNotThrow(() => subtitles.checkSubtitleText('1\n00:00:01,000 --> 00:00:02,000\nhi\n', '.srt'));
  assert.throws(() => subtitles.checkSubtitleText('just some text', '.srt'), /里面没有 SRT 时间轴/);
  assert.doesNotThrow(() => subtitles.checkSubtitleText('WEBVTT\n\n00:01.000 --> 00:02.000\nhi\n', '.vtt'));
  assert.throws(() => subtitles.checkSubtitleText('00:01.000 --> 00:02.000\nhi\n', '.vtt'), /缺少 WEBVTT 文件头/);
  assert.doesNotThrow(() => subtitles.checkSubtitleText(ASS, '.ass'));
  assert.throws(() => subtitles.checkSubtitleText('Dialogue: 0,0:00:00.50', '.ass'), /缺少 \[Script Info\] 段/);
  assert.throws(() => subtitles.checkSubtitleText('MZ\u0000\u0000binary', '.srt'), /不是文本字幕/);
  assert.throws(() => subtitles.checkSubtitleText('  \n ', '.srt'), /是空文件/);
});

/* ------------------------------ 语言与查找 ------------------------------ */

test('从文件名猜语言：简体排最前，其次笼统的中文，再是繁体', () => {
  const cases = [
    ['.chs', 'chi', 0, 'chs'],
    ['.sc&jp', 'chi', 0, 'sc&jp'],
    ['.zh-Hans', 'chi', 0, 'zh-Hans'],
    ['.简体', 'chi', 0, '简体'],
    ['.zh', 'chi', 1, 'zh'],
    ['.cht', 'chi', 2, 'cht'],
    ['.zh-TW', 'chi', 2, 'zh-TW'],
    ['.繁體', 'chi', 2, '繁體'],
    ['.eng', 'eng', 3, 'eng'],
    ['.jpn', 'jpn', 3, 'jpn'],
    ['', null, 4, null],
  ];
  for (const [tag, language, rank, title] of cases) {
    assert.deepEqual(subtitles.describeTag(tag), { language, rank, title }, tag);
  }
  assert.equal(subtitles.tagFor('Movie.chs.ass', 'D:/x/Movie.mkv'), '.chs');
  assert.equal(subtitles.tagFor('movie.ass', 'D:/x/Movie.mkv'), '');
  assert.equal(subtitles.tagFor('简体.srt', 'D:/x/Movie.mkv'), '简体');
});

test('找字幕：认片名开头的；一个文件夹好几集时不把别集的挂上来', async (t) => {
  const dir = await tempDir(t);
  const put = (name, body = '1\n00:00:01,000 --> 00:00:02,000\nx\n') => fsp.writeFile(path.join(dir, name), body);
  await put('Show - 01.mkv', 'video');
  await put('Show - 02.mkv', 'video');
  await put('Show - 01.cht.ass');
  await put('Show - 01.chs.ass');
  await put('Show - 01.srt');
  await put('Show - 02.chs.ass');
  await put('Show - 011.chs.ass'); // 片名只是前缀、后面没有分隔符：不是这一集的
  await put('notes.txt');
  const found = await subtitles.findSubtitles(path.join(dir, 'Show - 01.mkv'));
  assert.deepEqual(
    found.map((f) => f.name),
    // 简体、繁体、看不出语言的依次排；别集的和前缀撞车的都不要
    ['Show - 01.chs.ass', 'Show - 01.cht.ass', 'Show - 01.srt']
  );
  assert.equal(found[0].language, 'chi');
  assert.ok(found.every((f) => path.isAbsolute(f.path) && f.size > 0));
});

test('找字幕：文件夹里只有这一部片时，名字对不上的字幕也算', async (t) => {
  const dir = await tempDir(t);
  await fsp.writeFile(path.join(dir, 'Movie.2019.1080p.mkv'), 'video');
  await fsp.writeFile(path.join(dir, '简体.srt'), '1\n00:00:01,000 --> 00:00:02,000\nx\n');
  await fsp.writeFile(path.join(dir, 'empty.srt'), ''); // 空文件不列
  const found = await subtitles.findSubtitles(path.join(dir, 'Movie.2019.1080p.mkv'));
  assert.deepEqual(found.map((f) => [f.name, f.language, f.title]), [['简体.srt', 'chi', '简体']]);
});

test('封装前把 GBK 字幕转成 UTF-8，读不了的说清楚是哪一条', async (t) => {
  const dir = await tempDir(t);
  const out = path.join(dir, 'out');
  await fsp.mkdir(out);
  await fsp.writeFile(path.join(dir, 'M.chs.srt'), GBK_SRT);
  await fsp.writeFile(path.join(dir, 'M.ass'), ASS);
  const prepared = await subtitles.prepareForMux(
    [path.join(dir, 'M.chs.srt'), path.join(dir, 'M.ass'), path.join(dir, 'M.chs.srt')],
    out,
    path.join(dir, 'M.mkv')
  );
  assert.equal(prepared.length, 2, '同一条只封一次');
  assert.deepEqual(prepared.map((p) => [p.ext, p.language, p.title, p.encoding]), [
    ['.srt', 'chi', 'chs', 'gb18030'],
    ['.ass', null, null, 'utf-8'],
  ]);
  assert.match(await fsp.readFile(prepared[0].path, 'utf8'), /我们今天晚上一起看这部电影/);

  await fsp.writeFile(path.join(dir, 'bad.srt'), 'no timings here');
  await assert.rejects(subtitles.prepareForMux([path.join(dir, 'bad.srt')], out, null), /^Error: 字幕 bad\.srt 用不了：里面没有 SRT 时间轴$/);
});

/* ------------------------------ ffmpeg 参数 ------------------------------ */

const STREAMS = [
  { index: 0, codecType: 'video', codecName: 'h264' },
  { index: 1, codecType: 'audio', codecName: 'aac' },
  { index: 2, codecType: 'subtitle', codecName: 'mov_text' },
  { index: 3, codecType: 'data', codecName: '' },
  { index: 4, codecType: 'video', codecName: 'mjpeg', attachedPic: true },
  { index: 5, codecType: 'subtitle', codecName: 'dvb_teletext' },
];

test('封 MKV 的参数：数据轨和封面略过、mov_text 转 SRT、外挂字幕接在后面并默认显示', () => {
  const { args, droppedSubtitles } = media.convertArgs('in.mp4', 'out.mkv', {
    streams: STREAMS,
    subtitles: [
      { path: 's0.srt', ext: '.srt', language: 'chi', title: 'chs' },
      { path: 's1.vtt', ext: '.vtt', language: 'eng', title: null },
    ],
  });
  const line = args.join(' ');
  assert.ok(!args.includes('-fflags'), 'MP4 源不需要补时间戳');
  assert.match(line, /^-y -i in\.mp4 -i s0\.srt -i s1\.vtt -map 0:0 -map 0:1 -map 0:2 -map 1:0 -map 2:0 -c copy /);
  assert.ok(!line.includes('-map 0:3') && !line.includes('-map 0:4') && !line.includes('-map 0:5'));
  assert.match(line, / -c:2 srt /, 'mov_text 是第 2 路输出，转 SRT');
  assert.match(line, / -disposition:2 0 /, '片子原有的字幕取消默认');
  assert.match(line, / -disposition:3 default /, '第一条外挂字幕默认显示');
  assert.match(line, / -disposition:4 0 /);
  assert.match(line, / -metadata:s:3 language=chi -metadata:s:3 title=chs /);
  assert.match(line, / -c:4 srt -metadata:s:4 language=eng /, 'VTT 转 SRT');
  assert.ok(!line.includes('title=null'));
  assert.equal(args.at(-1), 'out.mkv');
  assert.deepEqual(droppedSubtitles, ['dvb_teletext']);
});

test('封 MKV 的参数：精简时只留选中的轨，FLAC 和 B 帧解包按输出下标写', () => {
  const streams = [
    { index: 0, codecType: 'video', codecName: 'mpeg4' },
    { index: 1, codecType: 'audio', codecName: 'mp3' },
    { index: 2, codecType: 'audio', codecName: 'pcm_s16le' },
    { index: 3, codecType: 'subtitle', codecName: 'subrip' },
  ];
  const { args } = media.convertArgs('in.avi', 'out.mkv', {
    streams,
    keepIndexes: [0, 2, 3],
    toFlac: [2],
    genpts: true,
  });
  const line = args.join(' ');
  assert.match(line, /^-y -fflags \+genpts -i in\.avi -map 0:0 -map 0:2 -map 0:3 -c copy /);
  assert.match(line, / -c:1 flac /, '输入第 2 轨是第 1 路输出');
  assert.match(line, / -bsf:0 mpeg4_unpack_bframes /);
  assert.ok(!line.includes('-disposition'), '没有外挂字幕时不动原有的默认标记');
});

test('封 MKV 的参数：一条音视频轨都留不下时直接说', () => {
  assert.throws(
    () => media.convertArgs('in.ts', 'out.mkv', { streams: [{ index: 0, codecType: 'data', codecName: '' }] }),
    /这个文件里没有能封进 MKV 的音视频轨/
  );
});

/* ------------------------------ 主进程接线 ------------------------------ */

const MAIN = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8').replace(/\r\n/g, '\n');
function handlerBody(channel) {
  const i = MAIN.indexOf(`secureHandle('${channel}'`);
  assert.ok(i !== -1, `main.js 里没找到 ${channel}`);
  return MAIN.slice(i, MAIN.indexOf('\n});\n', i));
}

test('main.js：字幕只有经过批准的才读；找字幕的前提是片子本身已批准', () => {
  const convert = handlerBody('media:convert');
  assert.match(convert, /const source = await requireAllowedLocalPath\(filePath\)/);
  assert.match(convert, /for \(const item of subtitleList \|\| \[\]\) subtitlePaths\.push\(await requireApprovedSubtitle\(item\)\)/);
  assert.match(convert, /subtitleList\.length > subtitles\.MAX_SUBTITLES/);
  assert.match(convert, /remuxOutputs\.set\(result\.outPath, ownedDir\)/, '产物要走转封装那套回收');

  const find = handlerBody('media:findSubtitles');
  assert.match(find, /const source = await requireAllowedLocalPath\(filePath\)/);
  assert.match(find, /approveSubtitle\(entry\.path, source\)/);

  // 字幕和片源是两张表：批准过的字幕不能被当成片源去算哈希、开会话
  assert.match(MAIN, /if \(!approvedSubtitles\.has\(pathKey\(realPath\)\)\) throw new Error\('字幕未经用户选择，已拒绝访问'\)/);
  const allowed = MAIN.slice(MAIN.indexOf('async function requireAllowedLocalPath('), MAIN.indexOf('async function approveSubtitle('));
  assert.ok(!allowed.includes('approvedSubtitles'));
  // 片源批准放宽到房主能选的格式
  assert.match(MAIN, /async function approveSource\(filePath\) \{[\s\S]*?validateSourceName\(path\.basename\(target\)\)/);
});

/* ------------------------------ 渲染进程 ------------------------------ */

function fnSource(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层函数 ${name}`);
  const end = APP.indexOf('\n}\n', m.index);
  return APP.slice(m.index, end + 2);
}

function prepRoom({ info, sidecars = [], ffmpeg = true, choice = { plan: 'as-is' } }) {
  const calls = [];
  const notes = [];
  const logs = [];
  const S = { leechOpens: new Set(), closing: new Set(), roomSecurityMode: 'safe', env: { ffmpeg } };
  const ctx = {
    console,
    Promise,
    S,
    randomId: () => 'task-1',
    uplinkFresh: () => false,
    fmtBytes: (n) => `${n}B`,
    log: (text, kind) => logs.push([text, kind]),
    trackPending: (_set, p) => p,
    trackClosing: (p) => p,
    confirmStreamability: () => true,
    choosePrepPlan: (_info, opts) => {
      calls.push(['choosePrepPlan', opts.mustConvert, opts.subtitles.length]);
      return choice;
    },
    window: {
      sw: {
        tasks: { cancel: () => Promise.resolve(true) },
        media: {
          inspect: () => Promise.resolve(info),
          findSubtitles: () => Promise.resolve(sidecars),
          convert: (filePath, opts) => {
            calls.push(['convert', filePath, opts]);
            return Promise.resolve({ outPath: 'C:/cache/x.mkv', inputSize: 10, outputSize: 9, subtitles: opts.subtitles.length, droppedSubtitles: [] });
          },
          slim: () => calls.push(['slim']),
          remux: () => calls.push(['remux']),
          onConvertProgress: () => () => {},
          onSlimProgress: () => () => {},
          onRemuxProgress: () => () => {},
          releaseTemp: () => Promise.resolve(),
        },
        store: {
          onHashProgress: () => () => {},
          buildManifest: (filePath) => {
            calls.push(['buildManifest', filePath]);
            return Promise.resolve({ fileId: 'f1', name: 'x.mkv', size: 9, chunkCount: 1 });
          },
          openSeed: () => Promise.resolve({ sessionId: 'seed-1' }),
          close: () => Promise.resolve(),
        },
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fnSource('prepareLocalFile'), ctx);
  const reporter = {
    label: 'x',
    stage: () => {},
    title: (text) => notes.push(`title:${text}`),
    note: (text) => notes.push(text),
    progress: () => {},
    cancelled: () => false,
    onCancel: () => {},
  };
  return { run: () => ctx.prepareLocalFile('D:/films/x.avi', reporter), calls, notes, logs };
}

const AVI_INFO = { action: 'convert', ext: '.avi', label: 'AVI', size: 10, slim: {}, probe: {}, reason: 'AVI 要先无损封成 MKV 才能传' };
const MKV_INFO = { action: 'ok', ext: '.mkv', size: 10, slim: {}, probe: {}, reason: 'ok' };

test('加片：AVI 走 convert，产物（MKV）拿去算哈希', async () => {
  const r = prepRoom({ info: AVI_INFO });
  await r.run();
  const convert = r.calls.find((c) => c[0] === 'convert');
  assert.ok(convert, '没走 convert');
  assert.equal(convert[1], 'D:/films/x.avi');
  assert.deepEqual([convert[2].keepIndexes, convert[2].toFlac, [...convert[2].subtitles]], [null, null, []]);
  assert.deepEqual(r.calls.find((c) => c[0] === 'buildManifest'), ['buildManifest', 'C:/cache/x.mkv']);
  assert.ok(r.notes.includes('title:正在封成 MKV'));
});

test('加片：MKV 旁边有字幕就弹方案框，勾上的字幕交给 convert', async () => {
  const sidecars = [{ path: 'D:/films/x.chs.ass', name: 'x.chs.ass', size: 5, language: 'chi', rank: 0 }];
  const r = prepRoom({ info: MKV_INFO, sidecars, choice: { plan: 'as-is', subtitles: ['D:/films/x.chs.ass'] } });
  await r.run();
  assert.deepEqual(r.calls[0], ['choosePrepPlan', false, 1], '只是因为有字幕也要问');
  const convert = r.calls.find((c) => c[0] === 'convert');
  assert.deepEqual([...convert[2].subtitles], ['D:/films/x.chs.ass']);
  assert.ok(r.notes.includes('title:正在把字幕封进片子'));
  assert.deepEqual(r.logs.at(-1), ['已把 1 条外挂字幕封进片子', 'good']);
});

test('加片：字幕全勾掉、又不用精简时，MKV 原样传', async () => {
  const sidecars = [{ path: 'D:/films/x.chs.ass', name: 'x.chs.ass', size: 5 }];
  const r = prepRoom({ info: MKV_INFO, sidecars, choice: { plan: 'as-is', subtitles: [] } });
  await r.run();
  assert.ok(!r.calls.some((c) => ['convert', 'slim', 'remux'].includes(c[0])));
  assert.deepEqual(r.calls.find((c) => c[0] === 'buildManifest'), ['buildManifest', 'D:/films/x.avi']);
});

test('加片：没有 ffmpeg 时 AVI 拦下并说要装 ffmpeg；MKV 旁的字幕只提示、照常放', async () => {
  const avi = prepRoom({ info: AVI_INFO, ffmpeg: false });
  await assert.rejects(avi.run(), /^Error: AVI 要先无损封成 MKV 才能传，这一步需要 ffmpeg，但没找到。装上 ffmpeg 后重试。$/);

  const mkv = prepRoom({ info: MKV_INFO, ffmpeg: false, sidecars: [{ path: 'a', name: 'a.srt', size: 1 }] });
  const prepared = await mkv.run();
  assert.ok(prepared, '为了字幕拦下整场放映不值得');
  assert.ok(!mkv.calls.some((c) => c[0] === 'choosePrepPlan' || c[0] === 'convert'));
  assert.deepEqual(mkv.logs[0], ['片子旁边有 1 个外挂字幕，但封进片子需要 ffmpeg，这次先不带字幕。', 'warn']);
});

test('新文案都有英文', async () => {
  const { translate } = await import('../src/renderer/lib/i18n.js');
  const en = (s) => translate(s, 'en');
  assert.equal(en('AVI 要先无损封成 MKV 才能传：只换容器、不重新编码，画质音质都不变。').startsWith('AVI has to be packed'), true);
  assert.equal(en('片子旁边有 2 个外挂字幕，但封进片子需要 ffmpeg，这次先不带字幕。').startsWith('Found 2 external subtitle files'), true);
  assert.equal(en('已封成 MKV：C:/a.mkv，体积 10 MB → 9 MB'), 'Packed into MKV: C:/a.mkv — size 10 MB → 9 MB');
  assert.equal(en('已把 1 条外挂字幕封进片子'), 'Packed 1 external subtitle into the video');
  assert.equal(en('字幕 a.srt 用不了：里面没有 SRT 时间轴'), 'Subtitle a.srt cannot be used: it has no SRT timings');
  assert.equal(en('字幕 a.ass 用不了：缺少 [Script Info] 段'), 'Subtitle a.ass cannot be used: it lacks a [Script Info] section');
  assert.equal(en('片子里有 2 条字幕 MKV 装不下，已略过（dvb_teletext、arib_caption）').startsWith('2 subtitle tracks'), true);
  assert.equal(en('不支持这种视频格式：.rmvb'), 'This video format is not supported: .rmvb');
  assert.equal(en('无效的 字幕路径'), 'Invalid subtitle path');
  for (const line of [
    '正在把字幕封进片子',
    '正在封成 MKV',
    '保留全部轨道',
    '外挂字幕',
    '添加字幕文件…',
    '片子旁边没找到外挂字幕。',
    '勾上的字幕会封进片子一起传（只换容器、不重新编码），每个人在播放器里都能切换；第一条勾上的默认显示。',
    '要带外挂字幕，产物会是 MKV —— MP4 装不下 ASS 字幕。',
    '把视频拖到这里，或者点击选择（可多选）。MP4、MKV、AVI、TS、WMV 等都行，同名的外挂字幕会一起带上',
    '简体中文',
    '繁体中文',
  ]) {
    assert.notEqual(en(line), line, line);
  }
});

/* ------------------------------ 真 ffmpeg ------------------------------ */

const ffmpeg = media.findFfmpeg();
const ffprobe = media.findFfprobe();

function ff(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`${path.basename(bin)} ${args.join(' ')}\n${r.stderr}`);
  return r.stdout;
}

test('真跑一遍：AVI + GBK 的 SRT + ASS 封成 MKV，字幕是正确的 UTF-8、第一条默认显示', { skip: !ffmpeg || !ffprobe }, async (t) => {
  const dir = await tempDir(t);
  const avi = path.join(dir, 'Film.avi');
  // 只编码成文件，不播放 —— 测试不出声
  ff(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=10:d=2', '-f', 'lavfi', '-i', 'sine=d=2',
    '-c:v', 'mpeg4', '-c:a', 'mp2', avi]);
  await fsp.writeFile(path.join(dir, 'Film.chs.srt'), GBK_SRT);
  await fsp.writeFile(path.join(dir, 'Film.jpn.ass'), ASS);

  const found = await subtitles.findSubtitles(avi);
  assert.deepEqual(found.map((f) => f.name), ['Film.chs.srt', 'Film.jpn.ass']);
  const out = path.join(dir, 'out');
  const result = await media.convert(avi, out, { subtitles: found.map((f) => f.path) });
  assert.equal(path.basename(result.outPath), 'Film.mkv');
  assert.equal(result.subtitles, 2);
  assert.deepEqual(await fsp.readdir(out), ['Film.mkv'], '转好的 UTF-8 副本用完要删');

  const probe = JSON.parse(ff(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', result.outPath]));
  assert.match(probe.format.format_name, /matroska/);
  const subs = probe.streams.filter((s) => s.codec_type === 'subtitle');
  assert.deepEqual(
    subs.map((s) => [s.codec_name, s.tags?.language, s.tags?.title, s.disposition.default]),
    [['subrip', 'chi', 'chs', 1], ['ass', 'jpn', 'jpn', 0]]
  );
  const text = ff(ffmpeg, ['-v', 'error', '-i', result.outPath, '-map', '0:s:0', '-f', 'srt', '-']);
  assert.match(text, /我们今天晚上一起看这部电影，好吗？/, 'GBK 没转成 UTF-8 的话这里是乱码');
  // 封出来的 MKV 接收方要能认：扩展名和文件头都过得了接收方那道检查
  const head = await fsp.readFile(result.outPath).then((b) => b.subarray(0, 64));
  assert.deepEqual(guard.validateMediaHeader(path.basename(result.outPath), head), { ok: true, container: 'matroska' });
});

test('真跑一遍：MPG 的包缺时间戳，要靠 +genpts 补上才封得进 MKV', { skip: !ffmpeg || !ffprobe }, async (t) => {
  // 不补的话 ffmpeg 报「Can't write packet with unknown timestamp」直接失败（VOB 同理）
  const dir = await tempDir(t);
  const mpg = path.join(dir, 'old.mpg');
  // 画面不能太小：160x120 时一帧装得进一个 PES 包、包包都有时间戳，就测不出这个问题
  ff(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25:d=1', '-f', 'lavfi', '-i', 'sine=d=1',
    '-c:v', 'mpeg2video', '-c:a', 'mp2', mpg]);
  const result = await media.convert(mpg, path.join(dir, 'out'), {});
  const probe = JSON.parse(ff(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', result.outPath]));
  assert.deepEqual(probe.streams.map((s) => s.codec_name), ['mpeg2video', 'mp2']);
});

test('真跑一遍：带 mov_text、时间码轨和封面的 MP4 也封得进 MKV', { skip: !ffmpeg || !ffprobe }, async (t) => {
  const dir = await tempDir(t);
  const srt = path.join(dir, 'en.srt');
  await fsp.writeFile(srt, '1\n00:00:00,500 --> 00:00:01,500\nhello\n');
  const mp4 = path.join(dir, 'm.mp4');
  ff(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=10:d=2', '-f', 'lavfi', '-i', 'sine=d=2', '-i', srt,
    '-f', 'lavfi', '-i', 'color=red:s=32x32:d=0.1', '-map', '0', '-map', '1', '-map', '2', '-map', '3',
    '-c:v', 'libx264', '-c:a', 'aac', '-c:s', 'mov_text', '-c:v:1', 'mjpeg', '-disposition:v:1', 'attached_pic',
    '-timecode', '00:00:00:00', mp4]);
  const result = await media.convert(mp4, path.join(dir, 'out'), {});
  const probe = JSON.parse(ff(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', result.outPath]));
  assert.deepEqual(probe.streams.map((s) => [s.codec_type, s.codec_name]), [
    ['video', 'h264'],
    ['audio', 'aac'],
    ['subtitle', 'subrip'],
  ]);
});
