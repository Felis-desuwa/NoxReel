'use strict';

// 开房前的预处理（修复批次 9）：转封装保住全部轨道、精简跳过数据轨、
// 安全模式下 moov 在尾的 MP4 可以原样传、外挂字幕不认错片、新装的 ffmpeg 不被旧结论拦下、
// 拖进来用不了的文件按原因提示。
//
// 真 ffmpeg 的用例只编码成文件、只转封装，不播放，不出声；没装 ffmpeg 就跳过。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const media = require('../src/main/media');
const subtitles = require('../src/main/subtitles');

const root = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8').replace(/\r\n/g, '\n');
const MAIN = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8').replace(/\r\n/g, '\n');

function fnSource(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层函数 ${name}`);
  const end = APP.indexOf('\n}\n', m.index);
  return APP.slice(m.index, end + 2);
}

/** 顶层 const（可以跨行），到第一个行尾分号为止。 */
function constSource(name) {
  const m = new RegExp(`^const ${name} =[\\s\\S]*?;\\n`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层常量 ${name}`);
  return m[0].replace(/^const /, 'var ');
}

async function tempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'noxreel-prep-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

/* ------------------------------ 轨道映射 ------------------------------ */

const STREAMS = [
  { index: 0, codecType: 'video', codecName: 'h264' },
  { index: 1, codecType: 'audio', codecName: 'aac' },
  { index: 2, codecType: 'audio', codecName: 'ac3' },
  { index: 3, codecType: 'subtitle', codecName: 'mov_text' },
  { index: 4, codecType: 'data', codecName: '' },
  { index: 5, codecType: 'video', codecName: 'mjpeg', attachedPic: true },
  { index: 6, codecType: 'subtitle', codecName: 'eia_608' },
  { index: 7, codecType: 'subtitle', codecName: 'mov_text' },
];

test('转封装进 MP4：全部音视频和 mov_text 都留，数据轨、封面、MP4 装不下的字幕略过', () => {
  const plan = media.mp4StreamPlan(STREAMS);
  assert.deepEqual(plan.map, [0, 1, 2, 3, 7]);
  assert.deepEqual(plan.droppedSubtitles, ['eia_608'], '只有字幕值得告诉用户');
  // 指定了保留列表时只在列表里挑
  assert.deepEqual(media.mp4StreamPlan(STREAMS, [0, 2, 4, 7]).map, [0, 2, 7]);
});

test('转封装参数：每条轨显式 -map，不再让 ffmpeg 每类只挑一条', () => {
  assert.deepEqual(media.remuxArgs('C:/in.mov', 'C:/out.faststart.mp4', [0, 1, 2, 3]), [
    '-y', '-i', 'C:/in.mov',
    '-map', '0:0', '-map', '0:1', '-map', '0:2', '-map', '0:3',
    '-c', 'copy', '-movflags', '+faststart',
    'C:/out.faststart.mp4',
  ]);
  // 读不出轨道信息时的退路：按类型选，大写 V 不带封面，带问号的没有也不报错
  assert.deepEqual(media.remuxArgs('a.mp4', 'b.mp4', ['V?', 'a?', 's?']).slice(3, 9), ['-map', '0:V?', '-map', '0:a?', '-map', '0:s?']);
});

test('精简方案：留下的轨按产物容器筛过，数据轨不进保留列表', () => {
  const probe = { duration: 100, streams: STREAMS };
  const mp4 = media.slimPlan(probe, { toMkv: false });
  assert.equal(mp4.available, true);
  assert.deepEqual(mp4.keep, [0, 1, 3, 7], '多余音轨丢掉，tmcd、封面、608 字幕本来就进不了 MP4');
  assert.deepEqual(mp4.drop, [2], '「丢掉的」只算精简主动丢的那些');

  const mkvProbe = {
    duration: 100,
    streams: [
      { index: 0, codecType: 'video', codecName: 'h264' },
      { index: 1, codecType: 'audio', codecName: 'aac', isDefault: true },
      { index: 2, codecType: 'audio', codecName: 'aac' },
      { index: 3, codecType: 'subtitle', codecName: 'ass' },
      { index: 4, codecType: 'attachment', codecName: 'ttf' },
      { index: 5, codecType: 'data', codecName: '' },
    ],
  };
  assert.deepEqual(media.slimPlan(mkvProbe, { toMkv: true }).keep, [0, 1, 3, 4], '字体附件留着，数据轨不留');
});

/* ------------------------------ 真 ffmpeg ------------------------------ */

const ffmpeg = media.findFfmpeg();
const ffprobe = media.findFfprobe();

function ff(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`${path.basename(bin)} ${args.join(' ')}\n${r.stderr}`);
  return r.stdout;
}
const streamsOf = (file) =>
  JSON.parse(ff(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', file])).streams.map((s) => [
    s.codec_type,
    s.codec_name,
  ]);
const SRT = '1\n00:00:00,500 --> 00:00:01,500\nhello\n';

test('真跑一遍：多音轨、两条 mov_text、带封面的非 faststart MP4 转封装后一条都不少', { skip: !ffmpeg || !ffprobe }, async (t) => {
  const dir = await tempDir(t);
  const srt = path.join(dir, 'en.srt');
  await fsp.writeFile(srt, SRT);
  const mp4 = path.join(dir, 'multi.mp4');
  ff(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=10:d=2', '-f', 'lavfi', '-i', 'sine=d=2',
    '-f', 'lavfi', '-i', 'sine=f=880:d=2', '-i', srt, '-i', srt, '-f', 'lavfi', '-i', 'color=red:s=32x32:d=0.1',
    '-map', '0', '-map', '1', '-map', '2', '-map', '3', '-map', '4', '-map', '5',
    '-c:v', 'libx264', '-c:a', 'aac', '-c:s', 'mov_text', '-c:v:1', 'mjpeg', '-disposition:v:1', 'attached_pic', mp4]);
  assert.equal((await media.inspectMp4Faststart(mp4)).faststart, false, '样片得是 moov 在尾的');

  const result = await media.remux(mp4, path.join(dir, 'out'));
  assert.deepEqual(streamsOf(result.outPath), [
    ['video', 'h264'],
    ['audio', 'aac'],
    ['audio', 'aac'],
    ['subtitle', 'mov_text'],
    ['subtitle', 'mov_text'],
  ]);
  assert.deepEqual(result.droppedSubtitles, []);
  assert.equal((await media.inspectMp4Faststart(result.outPath)).faststart, true);
});

test('真跑一遍：带 tmcd 时间码轨的多音轨 MOV，默认推荐的无损精简不再失败', { skip: !ffmpeg || !ffprobe }, async (t) => {
  const dir = await tempDir(t);
  const mov = path.join(dir, 'camera.mov');
  ff(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=10:d=2', '-f', 'lavfi', '-i', 'sine=d=2',
    '-f', 'lavfi', '-i', 'sine=f=880:d=2', '-map', '0', '-map', '1', '-map', '2',
    '-c:v', 'libx264', '-c:a', 'aac', '-timecode', '00:00:00:00', mov]);
  const info = await media.inspect(mov);
  assert.equal(info.action, 'remux');
  assert.equal(info.slim.available, true);
  assert.ok(info.probe.streams.some((s) => s.codecType === 'data'), '样片得带数据轨');

  // 渲染进程老版本算出来的保留列表是「除了丢掉的都留」，夹着数据轨 —— 主进程也要挡得住
  const everythingButDropped = info.probe.streams.map((s) => s.index).filter((i) => !info.slim.drop.includes(i));
  const result = await media.slim(mov, path.join(dir, 'out'), { keepIndexes: everythingButDropped });
  const kinds = streamsOf(result.outPath).map(([type]) => type);
  assert.deepEqual(kinds.filter((k) => k !== 'data'), ['video', 'audio'], '留一条音轨；时间码轨由封装器按元数据重写与否无所谓');
  assert.equal((await media.inspectMp4Faststart(result.outPath)).faststart, true);
});

test('真跑一遍：只能转封装的单音轨 MOV（mov_text + tmcd），字幕不再被悄悄丢掉', { skip: !ffmpeg || !ffprobe }, async (t) => {
  const dir = await tempDir(t);
  const srt = path.join(dir, 'en.srt');
  await fsp.writeFile(srt, SRT);
  const mov = path.join(dir, 'single.mov');
  ff(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=10:d=2', '-f', 'lavfi', '-i', 'sine=d=2', '-i', srt,
    '-map', '0', '-map', '1', '-map', '2', '-c:v', 'libx264', '-c:a', 'aac', '-c:s', 'mov_text', '-timecode', '00:00:00:00', mov]);
  const info = await media.inspect(mov);
  assert.equal(info.slim.available, false, '这种片子只剩「仅转封装」一个选项');
  const result = await media.remux(mov, path.join(dir, 'out'));
  const kinds = streamsOf(result.outPath).filter(([type]) => type !== 'data');
  assert.deepEqual(kinds, [['video', 'h264'], ['audio', 'aac'], ['subtitle', 'mov_text']]);
});

/* ------------------------------ 外挂字幕 ------------------------------ */

test('找字幕：续集的字幕归续集，不挂到片名更短的那一部上', async (t) => {
  const dir = await tempDir(t);
  const put = (name, body = SRT) => fsp.writeFile(path.join(dir, name), body);
  await put('Toy Story.mkv', 'video');
  await put('Toy Story 2.mkv', 'video');
  await put('Toy Story 2.chs.srt');
  await put('Toy Story.eng.srt');
  await put('Movie.mkv', 'video');
  await put("Movie Director's Cut.mp4", 'video');
  await put("Movie Director's Cut.chs.srt");
  await put('Movie.chs.srt');

  const first = await subtitles.findSubtitles(path.join(dir, 'Toy Story.mkv'));
  assert.deepEqual(first.map((f) => f.name), ['Toy Story.eng.srt']);
  const sequel = await subtitles.findSubtitles(path.join(dir, 'Toy Story 2.mkv'));
  assert.deepEqual(sequel.map((f) => f.name), ['Toy Story 2.chs.srt']);
  const movie = await subtitles.findSubtitles(path.join(dir, 'Movie.mkv'));
  assert.deepEqual(movie.map((f) => f.name), ['Movie.chs.srt']);
  const cut = await subtitles.findSubtitles(path.join(dir, "Movie Director's Cut.mp4"));
  assert.deepEqual(cut.map((f) => f.name), ["Movie Director's Cut.chs.srt"]);
});

test('找字幕：同目录没有那部更长片名的片子时，照旧按前缀认', async (t) => {
  const dir = await tempDir(t);
  await fsp.writeFile(path.join(dir, 'Show - 01.mkv'), 'video');
  await fsp.writeFile(path.join(dir, 'Show - 02.mkv'), 'video');
  await fsp.writeFile(path.join(dir, 'Show - 01.Extended.chs.srt'), SRT);
  const found = await subtitles.findSubtitles(path.join(dir, 'Show - 01.mkv'));
  assert.deepEqual(found.map((f) => f.name), ['Show - 01.Extended.chs.srt']);
});

/* ------------------------------ 准备流程 ------------------------------ */

const MP4_TAIL = { action: 'remux', ext: '.mp4', size: 10, slim: {}, probe: {}, reason: 'MP4 的 moov 索引在文件末尾' };
const AVI_INFO = { action: 'convert', ext: '.avi', label: 'AVI', size: 10, slim: {}, probe: {}, reason: 'AVI 要先无损封成 MKV 才能传' };
const MKV_INFO = { action: 'ok', ext: '.mkv', size: 10, slim: {}, probe: {}, reason: 'ok' };

function prepRoom({ info, mode = 'safe', ffmpeg = true, envAfter = null, sidecars = [], choice = { plan: 'as-is' }, remuxResult = null }) {
  const calls = [];
  const notes = [];
  const logs = [];
  const plans = [];
  const S = { leechOpens: new Set(), roomSecurityMode: mode, env: { ffmpeg } };
  const ctx = {
    console,
    Promise,
    S,
    randomId: () => 'task-1',
    uplinkFresh: () => false,
    uplinkForPrecheck: () => Promise.resolve({ ok: false }),
    fmtBytes: (n) => `${n}B`,
    log: (text, kind) => logs.push([text, kind]),
    trackPending: (_set, p) => p,
    trackClosing: (p) => p,
    confirmStreamability: () => true,
    updateDepsPill: () => calls.push(['updateDepsPill']),
    choosePrepPlan: (_info, opts) => {
      plans.push({ needsRemux: opts.needsRemux, optionalRemux: opts.optionalRemux });
      return choice;
    },
    window: {
      sw: {
        tasks: { cancel: () => Promise.resolve(true) },
        env: {
          status: () => {
            calls.push(['envStatus']);
            return Promise.resolve(envAfter || { ffmpeg });
          },
        },
        media: {
          inspect: () => Promise.resolve(info),
          findSubtitles: () => Promise.resolve(sidecars),
          convert: (filePath, opts) => {
            calls.push(['convert', filePath, opts]);
            return Promise.resolve({ outPath: 'C:/cache/x.mkv', inputSize: 10, outputSize: 9, subtitles: opts.subtitles.length, droppedSubtitles: [] });
          },
          slim: () => calls.push(['slim']),
          remux: (filePath) => {
            calls.push(['remux', filePath]);
            return Promise.resolve(remuxResult || { outPath: 'C:/cache/x.faststart.mp4', droppedSubtitles: [] });
          },
          onConvertProgress: () => () => {},
          onSlimProgress: () => () => {},
          onRemuxProgress: () => () => {},
          releaseTemp: () => Promise.resolve(),
        },
        store: {
          onHashProgress: () => () => {},
          buildManifest: (filePath) => {
            calls.push(['buildManifest', filePath]);
            return Promise.resolve({ fileId: 'f1', name: 'x.mp4', size: 9, chunkCount: 1 });
          },
          openSeed: () => Promise.resolve({ sessionId: 'seed-1' }),
          close: () => Promise.resolve(),
        },
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(constSource('SAFE_MOOV_NOTE'), ctx);
  vm.runInContext(fnSource('ffmpegReady'), ctx);
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
  return { run: () => ctx.prepareLocalFile('D:/films/x.mp4', reporter), calls, notes, logs, plans, S, ctx };
}

test('安全模式：moov 在尾的 MP4 没装 ffmpeg 也能原样传，不再拦下', async () => {
  const r = prepRoom({ info: MP4_TAIL, mode: 'safe', ffmpeg: false });
  const prepared = await r.run();
  assert.ok(prepared, '安全模式收完才播，索引在哪不影响');
  assert.deepEqual(r.calls.find((c) => c[0] === 'buildManifest'), ['buildManifest', 'D:/films/x.mp4'], '原样拿源文件算哈希');
  assert.ok(!r.calls.some((c) => c[0] === 'remux'));
  assert.ok(r.notes.includes(r.ctx.SAFE_MOOV_NOTE), '说明为什么可以原样传');
  assert.equal(prepared.moovAtEnd, true, '进列表前还要按最终模式再核一次');
});

test('可信房间：moov 在尾的 MP4 仍然必须转封装，没 ffmpeg 就拦下', async () => {
  const r = prepRoom({ info: MP4_TAIL, mode: 'trusted', ffmpeg: false });
  await assert.rejects(r.run(), /^Error: 这个 MP4 需要转封装才能边下边播，但没找到 ffmpeg。/);

  const ok = prepRoom({ info: MP4_TAIL, mode: 'trusted', choice: { plan: 'remux', subtitles: [] } });
  const prepared = await ok.run();
  assert.deepEqual(ok.plans, [{ needsRemux: true, optionalRemux: false }]);
  assert.deepEqual(ok.calls.find((c) => c[0] === 'buildManifest'), ['buildManifest', 'C:/cache/x.faststart.mp4']);
  assert.equal(prepared.moovAtEnd, false, '转封装过的产物索引已在文件头');
});

test('安全模式装了 ffmpeg：弹窗里转封装是可选项，选原样传就不复制整片', async () => {
  const asIs = prepRoom({ info: MP4_TAIL, mode: 'safe', choice: { plan: 'as-is', subtitles: [] } });
  await asIs.run();
  assert.deepEqual(asIs.plans, [{ needsRemux: false, optionalRemux: true }]);
  assert.ok(!asIs.calls.some((c) => c[0] === 'remux'));

  const remuxed = prepRoom({
    info: MP4_TAIL,
    mode: 'safe',
    choice: { plan: 'remux', subtitles: [] },
    remuxResult: { outPath: 'C:/cache/x.faststart.mp4', droppedSubtitles: ['eia_608'] },
  });
  const prepared = await remuxed.run();
  assert.ok(remuxed.calls.some((c) => c[0] === 'remux'), '想挪索引的也能挪');
  assert.equal(prepared.moovAtEnd, false);
  assert.deepEqual(remuxed.logs.at(-1), ['片子里有 1 条字幕 MP4 装不下，已略过（eia_608）', 'warn'], '转封装略过的字幕要说出来，而且说对容器');
});

test('ffmpeg 是开着软件时才装上的：准备前重新问一次，不被启动时的旧结论拦下', async () => {
  const r = prepRoom({ info: AVI_INFO, ffmpeg: false, envAfter: { ffmpeg: 'C:/ffmpeg/bin/ffmpeg.exe' } });
  const prepared = await r.run();
  assert.ok(prepared);
  assert.ok(r.calls.some((c) => c[0] === 'envStatus'));
  assert.ok(r.calls.some((c) => c[0] === 'updateDepsPill'), '首页的「缺少 ffmpeg」也跟着消掉');
  assert.ok(r.calls.some((c) => c[0] === 'convert'));
  assert.equal(r.S.env.ffmpeg, 'C:/ffmpeg/bin/ffmpeg.exe');

  // 新装之后外挂字幕也不再被静默跳过
  const sidecars = [{ path: 'D:/films/x.chs.srt', name: 'x.chs.srt', size: 5 }];
  const subs = prepRoom({ info: MKV_INFO, ffmpeg: false, envAfter: { ffmpeg: 'C:/ff.exe' }, sidecars, choice: { plan: 'as-is', subtitles: ['D:/films/x.chs.srt'] } });
  await subs.run();
  assert.ok(subs.calls.some((c) => c[0] === 'convert'));
  assert.ok(!subs.logs.some(([text]) => text.includes('这次先不带字幕')));

  // 用不上 ffmpeg 的片子不去白问
  const plain = prepRoom({ info: MKV_INFO, ffmpeg: false });
  await plain.run();
  assert.ok(!plain.calls.some((c) => c[0] === 'envStatus'));
});

test('进列表前按最终模式复核：原样传的 moov 在尾 MP4 进不了可信房间', async () => {
  const run = async (mode, moovAtEnd) => {
    const closed = [];
    const ctx = {
      S: { roomSecurityMode: mode },
      trackClosing: (p) => p,
      initSwarmAndSync: () => {
        throw new Error('SWARM');
      },
      window: { sw: { store: { close: (id) => (closed.push(id), Promise.resolve()) } } },
    };
    vm.createContext(ctx);
    vm.runInContext(fnSource('addLocalFile'), ctx);
    const error = await ctx
      .addLocalFile({ manifest: { fileId: 'f' }, state: { sessionId: 's1' }, filePath: 'x', moovAtEnd })
      .catch((e) => e);
    return { message: error.message, closed };
  };
  const blocked = await run('trusted', true);
  assert.match(blocked.message, /^这个 MP4 的索引在文件末尾，可信房间要边下边播，得先转封装/);
  assert.deepEqual(blocked.closed, ['s1'], '开好的做种会话要关掉');
  assert.equal((await run('safe', true)).message, 'SWARM', '安全模式照常进列表');
  assert.equal((await run('trusted', false)).message, 'SWARM');
});

test('准备期间房间模式锁住：房主从选片到进房这段改不了，加入中的游客照旧能改', () => {
  const locked = (state) => {
    const ctx = { S: { swarm: null, role: null, ...state.S }, roomEntered: state.roomEntered || false };
    vm.createContext(ctx);
    vm.runInContext(fnSource('securityModeLocked'), ctx);
    return ctx.securityModeLocked();
  };
  assert.equal(locked({ S: {} }), false, '首页');
  assert.equal(locked({ S: { role: 'host' } }), true, '房主正在准备第一部片（Swarm 还没建）');
  assert.equal(locked({ S: { role: 'guest' } }), false);
  assert.equal(locked({ S: { swarm: {} } }), true);
  assert.equal(locked({ roomEntered: true, S: {} }), true);

  // 设置页的显示和保存用同一个判据，而且不再在准备期间改 S.roomSecurityMode
  const settings = APP.slice(APP.indexOf("$('btn-settings').onclick"), APP.indexOf("localStorage.setItem('sw.securityMode'"));
  assert.match(settings, /const modeLocked = securityModeLocked\(\);/);
  assert.match(settings, /if \(!securityModeLocked\(\)\) \{\n\s*S\.settings\.securityMode = /);
  assert.ok(!settings.includes('S.roomSecurityMode = S.settings.securityMode'));
});

/* ------------------------------ 选方案弹窗 ------------------------------ */

/** 够 choosePrepPlan 跑起来的假 DOM：只记标签、选项和子节点。 */
function fakeEl(tag, opts = {}, children = []) {
  const el = {
    tag,
    ...opts,
    children: [...children],
    value: undefined,
    appendChild(c) {
      el.children.push(c);
    },
    replaceChildren(...c) {
      el.children = c;
    },
  };
  return el;
}

function openPlan(info, opts) {
  let modal = null;
  const ctx = {
    t: (s) => s,
    make: fakeEl,
    field: (...c) => fakeEl('field', {}, c),
    hint: (...c) => fakeEl('hint', {}, c),
    fmtBytes: (n) => `${n}B`,
    trackLabel: (s) => `#${s.index}`,
    currentLocale: () => 'zh-CN',
    openModal: (m) => {
      modal = m;
      return { cancel: () => {} };
    },
    window: { sw: { dialog: { pickSubtitles: () => Promise.resolve([]) } } },
  };
  vm.createContext(ctx);
  vm.runInContext(constSource('SAFE_MOOV_NOTE'), ctx);
  vm.runInContext(constSource('KEEPABLE_TRACK_TYPES'), ctx);
  vm.runInContext(fnSource('choosePrepPlan'), ctx);
  const result = ctx.choosePrepPlan(info, opts);
  const parts = modal.body();
  const select = parts.flatMap((p) => [p, ...(p.children || [])]).find((el) => el && el.id === 'prep-plan');
  return {
    options: select.children.map((o) => o.attrs.value),
    picked: select.value,
    texts: parts.filter((p) => p.tag === 'p').map((p) => p.text),
    ok: () => (modal.onOk(), result),
  };
}

test('选方案：安全模式下默认原样传，转封装是可选项；可信房间只有转封装', async () => {
  const safe = openPlan(MP4_TAIL, { needsRemux: false, optionalRemux: true, canSlim: false });
  assert.deepEqual(safe.options, ['as-is', 'remux']);
  assert.equal(safe.picked, 'as-is');
  assert.ok(safe.texts.some((text) => text.startsWith('这个文件的索引（moov）在文件末尾。安全模式下')));
  assert.equal((await safe.ok()).plan, 'as-is');

  const trusted = openPlan(MP4_TAIL, { needsRemux: true, optionalRemux: false, canSlim: false });
  assert.deepEqual(trusted.options, ['remux']);
});

test('选方案：精简时的保留列表不带数据轨', async () => {
  const info = {
    ...MP4_TAIL,
    probe: {
      duration: 10,
      streams: [
        { index: 0, codecType: 'video', codecName: 'h264' },
        { index: 1, codecType: 'audio', codecName: 'aac' },
        { index: 2, codecType: 'audio', codecName: 'aac' },
        { index: 3, codecType: 'data', codecName: '' },
      ],
    },
    slim: { available: true, keepAudioIndex: 1, drop: [2] },
  };
  const plan = openPlan(info, { needsRemux: false, optionalRemux: true, canSlim: true });
  assert.deepEqual(plan.options, ['slim', 'as-is', 'remux']);
  assert.equal(plan.picked, 'slim');
  const choice = await plan.ok();
  assert.deepEqual(choice.keepIndexes, [0, 1]);
});

/* ------------------------------ 拖放 ------------------------------ */

function dropCtx(pathForFile) {
  const logs = [];
  const queued = [];
  const ctx = {
    log: (text, kind) => logs.push([text, kind]),
    canEditPlaylist: () => true,
    queueLocalFiles: (paths) => queued.push(...paths),
    window: { sw: { pathForFile } },
  };
  vm.createContext(ctx);
  vm.runInContext(fnSource('approvedDropPaths'), ctx);
  vm.runInContext(fnSource('dropFailureReason'), ctx);
  vm.runInContext(constSource('dropFailureLine'), ctx);
  vm.runInContext(fnSource('addDroppedFiles'), ctx);
  return { ctx, logs, queued };
}

// Electron 会给主进程抛的错套一层前缀
const remoteError = (text) => new Error(`Error invoking remote method 'dialog:approveDroppedVideo': ${text}`);

test('拖放：每个没加上的都按原因说，格式不支持不再说成「拿不到路径」', async () => {
  const { ctx } = dropCtx(async (file) => {
    if (file.name === 'ok.mp4') return 'D:/v/ok.mp4';
    if (file.name === 'x.rmvb' || file.name === 'x.flv2') throw remoteError('TypeError: 不支持这种视频格式');
    if (file.name === 'Movies') throw remoteError('Error: 拖进来的是文件夹，请打开它，把里面的视频文件拖进来');
    if (file.name === 'gone.mp4') throw remoteError("Error: ENOENT: no such file or directory, stat 'D:\\v\\gone.mp4'");
    return null; // 从浏览器里直接拖出来的，不落在磁盘上
  });
  const { paths, failures } = await ctx.approvedDropPaths(
    ['ok.mp4', 'x.rmvb', 'x.flv2', 'Movies', 'gone.mp4', 'web.mp4'].map((name) => ({ name }))
  );
  assert.deepEqual([...paths], ['D:/v/ok.mp4']);
  assert.deepEqual(
    [...failures].map((f) => [f.name, f.reason]),
    [
      ['x.rmvb', 'RM/RMVB 只能重新编码、没法无损封成 MKV，不支持'],
      ['x.flv2', '不支持这种视频格式：.flv2'],
      ['Movies', '拖进来的是文件夹，请打开它，把里面的视频文件拖进来'],
      ['gone.mp4', '找不到这个文件，可能已被移动或删除'],
      ['web.mp4', '拿不到这个文件的路径，请改用选择文件的方式添加'],
    ]
  );
});

test('拖放：房间里一起拖进来的，能用的照常排队，用不了的逐个记进日志', async () => {
  const { ctx, logs, queued } = dropCtx(async (file) => {
    if (file.name === 'x.rmvb') throw remoteError('TypeError: 不支持这种视频格式');
    return `D:/v/${file.name}`;
  });
  await ctx.addDroppedFiles([{ name: 'a.mkv' }, { name: 'x.rmvb' }]);
  assert.deepEqual(queued, ['D:/v/a.mkv']);
  assert.deepEqual(logs, [['没加上《x.rmvb》：RM/RMVB 只能重新编码、没法无损封成 MKV，不支持', 'warn']]);
});

test('拖放：首页不再用 alert（会响提示音），用不了的写在卡片上', () => {
  const drop = APP.slice(APP.indexOf("dz.addEventListener('drop'"), APP.indexOf('async function approvedDropPaths('));
  assert.ok(!drop.includes('alert('));
  assert.match(drop, /showDropFailures\(failures\)/);
  assert.match(fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8'), /id="drop-err"/);
  // 拖进文件夹时主进程先认出来，别让名字检查报成「格式不支持」
  const handler = MAIN.slice(MAIN.indexOf("secureHandle('dialog:approveDroppedVideo'"));
  assert.match(handler.slice(0, handler.indexOf('\n});\n')), /isDirectory\(\)[\s\S]*approveSource\(filePath\)/);
});

/* ------------------------------ 主进程接线 ------------------------------ */

test('主进程把转封装、精简略过的字幕交回页面', () => {
  const body = (channel) => {
    const i = MAIN.indexOf(`secureHandle('${channel}'`);
    return MAIN.slice(i, MAIN.indexOf('\n});\n', i));
  };
  assert.match(body('media:remux'), /return \{ outPath, droppedSubtitles, subtitlesUnchecked \}/);
  assert.match(body('media:slim'), /return \{ outPath, plan, inputSize, outputSize, droppedSubtitles \}/);
});

/* ------------------------------ 英文 ------------------------------ */

test('这一批的新文案都有英文，动态模板按原因再翻一道', async () => {
  const { translate } = await import('../src/renderer/lib/i18n.js');
  const en = (s) => translate(s, 'en');
  const vmCtx = {};
  vm.createContext(vmCtx);
  vm.runInContext(constSource('SAFE_MOOV_NOTE'), vmCtx);
  for (const line of [
    vmCtx.SAFE_MOOV_NOTE,
    '这个 MP4 的索引在文件末尾，可信房间要边下边播，得先转封装。请重新选择这个文件。',
    '读不出这个片子的轨道信息（可能没装 ffprobe），片子里的字幕放不进 MP4，这次没带上',
    '正在准备开房，这时不能切换。回到首页后可更改。',
    '这个文件里没有能放进 MP4 的音视频轨',
    '拿不到这个文件的路径，请改用选择文件的方式添加',
    '拖进来的是文件夹，请打开它，把里面的视频文件拖进来',
    'RM/RMVB 只能重新编码、没法无损封成 MKV，不支持',
    '找不到这个文件，可能已被移动或删除',
    '没有权限读取这个文件',
    '文件名太长或带有不支持的字符，改个名再试',
  ]) {
    assert.notEqual(en(line), line, line);
  }
  assert.equal(
    en('片子里有 2 条字幕 MP4 装不下，已略过（eia_608、dvd_subtitle）'),
    '2 subtitle tracks in the video cannot go into MP4 and were skipped (eia_608、dvd_subtitle)'
  );
  assert.equal(
    en('片子里有 1 条字幕 MKV 装不下，已略过（arib_caption）'),
    '1 subtitle track in the video cannot go into MKV and was skipped (arib_caption)'
  );
  assert.equal(
    en('没加上《我的片子.rmvb》：RM/RMVB 只能重新编码、没法无损封成 MKV，不支持'),
    'Not added: “我的片子.rmvb” — RM/RMVB is not supported: it can only be re-encoded, not packed losslessly into MKV'
  );
  assert.equal(en('没加上《a.xyz》：不支持这种视频格式：.xyz'), 'Not added: “a.xyz” — This video format is not supported: .xyz');
  assert.equal(en('不支持这种视频格式：(无扩展名)'), 'This video format is not supported: (no extension)');
  assert.equal(en('还有 3 个也没加上'), '3 more were not added');
  assert.equal(en('还有 1 个也没加上'), '1 more was not added');
});
