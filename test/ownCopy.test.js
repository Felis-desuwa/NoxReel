'use strict';

// 成员「用我自己的文件播放」：本机有这部片（可能是别的版本）就不从房主那里收，直接放自己的，同步照常按时间点走。
//  - 主进程 fileStore.spotCheckFile：大小 + 文件头尾几片的哈希粗查，只读；
//  - 渲染进程：对不上先弹窗说清可能出什么问题，点「仍然用」才换；对得上直接换、后台完整算一遍清单，
//    fileId 一样就开做种会话当片源；用自己的文件时这一部不收、不扫，按「已收完」参与卡顿和就绪。
// 全程不联网、不起播放器。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('src/renderer/app.js');
const store = require('../src/main/fileStore');

function fnSource(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层函数 ${name}`);
  const end = APP.indexOf('\n}\n', m.index);
  assert.ok(end > m.index, `${name} 的结尾没找到`);
  return APP.slice(m.index, end + 2);
}

async function tempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'noxreel-own-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('粗查：大小、文件头尾几片的哈希；只读，不改用户的文件；没有清单时只比大小', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'movie.mkv');
  // 7 片半：抽查头 4 片 + 尾 2 片
  const bytes = crypto.randomBytes(store.CHUNK_SIZE * 7 + 12345);
  await fsp.writeFile(file, bytes);
  store._testing.reset();
  const manifest = await store.buildManifest(file);
  assert.equal(manifest.chunkCount, 8);

  const same = await store.spotCheckFile(file, manifest);
  assert.deepEqual(same, { size: bytes.length, sizeMatch: true, checked: 6, mismatched: 0 });
  assert.ok((await fsp.readFile(file)).equals(bytes), '只读，文件一个字节都不能动');

  // 尾片改了一个字节：大小一样、内容对不上
  const tail = Buffer.from(bytes);
  tail[tail.length - 1] ^= 0xff;
  const other = path.join(dir, 'other.mkv');
  await fsp.writeFile(other, tail);
  assert.deepEqual(await store.spotCheckFile(other, manifest), { size: bytes.length, sizeMatch: true, checked: 6, mismatched: 1 });

  // 中间改了不在抽查范围里的一片：粗查看不出来（所以对上了还要完整核对一遍）
  const middle = Buffer.from(bytes);
  middle[store.CHUNK_SIZE * 4 + 7] ^= 0xff;
  await fsp.writeFile(other, middle);
  assert.equal((await store.spotCheckFile(other, manifest)).mismatched, 0);

  // 大小不一样：不读内容
  await fsp.writeFile(other, bytes.subarray(0, bytes.length - 1));
  assert.deepEqual(await store.spotCheckFile(other, manifest), { size: bytes.length - 1, sizeMatch: false, checked: 0, mismatched: 0 });

  // 清单还没到手：只比大小
  assert.deepEqual(await store.spotCheckFile(file, { size: bytes.length }), { size: bytes.length, sizeMatch: true, checked: 0, mismatched: 0 });
  await assert.rejects(store.spotCheckFile(dir, manifest), /不是文件/);
});

/** 渲染进程那几个函数的沙箱。window.sw 和界面都是假的，记下调用。 */
function harness({ manifest = { fileId: 'f1', size: 1000, chunkCount: 1 }, spot, built, modalAnswer = true, current = true } = {}) {
  const calls = [];
  const item = { id: 'i1', kind: 'file', fileId: 'f1', slot: 3, name: 'movie.mkv', size: 1000, chunkCount: 1, durationSec: 60 };
  const leech = { fileId: 'f1', slot: 3, sessionId: 's-leech', isSeeder: false, filePath: 'C:/cache/movie.mkv', manifest };
  const modals = [];
  const S = {
    ownCopies: new Map(),
    ownCopy: null,
    sessions: new Map([['f1', leech]]),
    knownManifests: new Map(manifest ? [['f1', manifest]] : []),
    blockedFiles: new Set(),
    diskFull: new Set(),
    current: current ? item : null,
    currentSeq: 1,
    playlist: { seq: 1, queue: [item], history: [] },
    playerQuit: Promise.resolve(),
    leechOpens: new Set(),
    switchingMedia: false,
    leaving: false,
    swarm: {
      offerManifest: (m) => calls.push(['offerManifest', m.fileId]),
      requestManifest: async () => {
        calls.push(['requestManifest']);
        return manifest;
      },
    },
    sync: { isSeeder: false },
  };
  const hashListeners = [];
  const ctx = {
    console,
    S,
    roomEntered: true,
    window: {
      sw: {
        dialog: {
          pickOwnCopy: async () => {
            calls.push(['pickOwnCopy']);
            return 'D:/my/movie.mkv';
          },
        },
        store: {
          spotCheck: async (m, p, size) => {
            calls.push(['spotCheck', m ? m.fileId : null, p, size]);
            return spot;
          },
          buildManifest: async (p, taskId) => {
            calls.push(['buildManifest', p, taskId]);
            for (const fn of hashListeners) fn({ done: 1, total: 2, taskId });
            return built;
          },
          onHashProgress: (fn) => {
            hashListeners.push(fn);
            return () => hashListeners.splice(hashListeners.indexOf(fn), 1);
          },
          openSeed: async (m, p) => {
            calls.push(['openSeed', m.fileId, m.name, p]);
            return { sessionId: 's-seed' };
          },
          close: async (id) => calls.push(['store.close', id]),
        },
        tasks: { cancel: async (id) => calls.push(['cancelTask', id]) },
      },
    },
    log: (text, kind) => calls.push(['log', text, kind || '']),
    openModal: (options) => {
      modals.push(options);
      if (!modalAnswer) options.onCancel?.();
      return { done: Promise.resolve(modalAnswer) };
    },
    make: (tag, opts = {}, children = []) => ({ tag, text: opts.text, children }),
    hint: (text) => ({ tag: 'hint', text }),
    fmtBytes: (n) => `${n} B`,
    pct: (r) => `${Math.floor(r * 100)}%`,
    baseName: (p) => p.split(/[\\/]/).pop(),
    itemLabel: (it) => it.name,
    randomId: () => 'xyz',
    findItem: (pl, id) => (pl.queue.some((it) => it.id === id) ? { item: pl.queue.find((it) => it.id === id) } : null),
    manifestCandidates: () => ['host'],
    retirePlayer: () => calls.push(['retirePlayer']),
    closeSession: async (sess) => calls.push(['closeSession', sess.sessionId]),
    updateTransfer: () => calls.push(['updateTransfer']),
    renderPlaylistSoon: () => {},
    renderFilmInfo: () => {},
    renderStatus: () => {},
    refreshMediaUi: () => {},
    $: () => ({ disabled: false, classList: { add() {}, toggle() {} } }),
    onFileItemCurrent: (it) => calls.push(['onFileItemCurrent', it.id, !!ctx.ownCopyFor(it)]),
    onPlaylistChanged: () => {
      // 挂到列表的槽位上
      for (const sess of S.sessions.values()) if (sess.slot === null) sess.slot = 3;
      calls.push(['onPlaylistChanged']);
    },
    currentSession: () => (S.current ? S.sessions.get(S.current.fileId) || null : null),
    onCurrentSessionReady: (sess) => calls.push(['onCurrentSessionReady', sess.sessionId, sess.filePath]),
    trackPending: (_set, p) => p,
    trackClosing: (p) => p,
    newSession: ({ manifest: m, state, filePath, isSeeder }) => ({
      fileId: m.fileId,
      slot: null,
      manifest: m,
      sessionId: state.sessionId,
      filePath,
      isSeeder,
    }),
  };
  vm.createContext(ctx);
  const fns = [
    'ownCopyFor',
    'canUseOwnCopy',
    'chooseOwnCopy',
    'ownCopyWarning',
    'adoptOwnCopy',
    'dropOwnCopy',
    'verifyOwnCopy',
    'adoptOwnCopyAsSeed',
    'ownCopyTransferView',
    'localMenu',
    'syncCurrentMirrors',
  ];
  vm.runInContext(fns.map(fnSource).join('\n\n'), ctx, { filename: 'app.js（节选）' });
  return { ctx, S, calls, item, modals, leech };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
// 沙箱里造出来的数组、对象原型不是这边的，deepStrictEqual 比之前先倒成普通值
const plain = (v) => JSON.parse(JSON.stringify(v));

test('对不上：先弹窗说清可能出什么问题，点「仍然用」才换过去；不做完整核对、不当片源', async () => {
  const h = harness({ spot: { size: 900, sizeMatch: false, checked: 0, mismatched: 0 } });
  await h.ctx.chooseOwnCopy(h.item);
  assert.equal(h.modals.length, 1);
  assert.equal(h.modals[0].title, '你的文件和房主的不是同一个');
  const texts = JSON.stringify(h.modals[0].body);
  assert.match(texts, /大小不一样：你的 900 B，房主的 1000 B/);
  assert.match(texts, /同步照常/);
  assert.match(texts, /帧率不同/);
  assert.match(texts, /版本不同/);
  const own = h.S.ownCopies.get('f1');
  assert.equal(own.quick, 'different');
  assert.equal(own.reason, 'size');
  assert.equal(own.path, 'D:/my/movie.mkv');
  // 正在收的会话关掉、当前项退掉播放器后按自己的文件重新起
  const names = h.calls.map((c) => c[0]);
  assert.ok(names.includes('retirePlayer'));
  assert.deepEqual(h.calls.find((c) => c[0] === 'closeSession'), ['closeSession', 's-leech']);
  assert.equal(h.S.sessions.has('f1'), false);
  assert.deepEqual(h.calls.find((c) => c[0] === 'onFileItemCurrent'), ['onFileItemCurrent', 'i1', true]);
  assert.equal(names.includes('buildManifest'), false, '粗查都对不上，不用再完整算一遍');
  assert.equal(names.includes('openSeed'), false);
});

test('对不上、点了取消：什么都不变，接着从房主那里收', async () => {
  const h = harness({ spot: { size: 1000, sizeMatch: true, checked: 1, mismatched: 1 }, modalAnswer: false });
  await h.ctx.chooseOwnCopy(h.item);
  assert.equal(h.modals.length, 1);
  assert.match(JSON.stringify(h.modals[0].body), /大小一样，但内容对不上/);
  assert.equal(h.S.ownCopies.size, 0);
  assert.equal(h.S.sessions.get('f1'), h.leech);
  assert.equal(h.calls.some((c) => c[0] === 'retirePlayer' || c[0] === 'closeSession'), false);
});

test('粗查对上：不弹窗直接换；后台完整核对 fileId 一样就开做种会话当片源（用房主的清单、自己的文件）', async () => {
  const manifest = { fileId: 'f1', size: 1000, chunkCount: 1, name: 'movie.mkv', hashes: ['a'] };
  const h = harness({ manifest, spot: { size: 1000, sizeMatch: true, checked: 1, mismatched: 0 }, built: { fileId: 'f1', name: 'mine.mkv' } });
  await h.ctx.chooseOwnCopy(h.item);
  await flush();
  assert.equal(h.modals.length, 0);
  const own = h.S.ownCopies.get('f1');
  assert.equal(own.quick, 'same');
  assert.equal(own.full, 'same');
  assert.deepEqual(h.calls.find((c) => c[0] === 'buildManifest'), ['buildManifest', 'D:/my/movie.mkv', 'own-xyz']);
  assert.deepEqual(h.calls.find((c) => c[0] === 'openSeed'), ['openSeed', 'f1', 'movie.mkv', 'D:/my/movie.mkv']);
  const sess = h.S.sessions.get('f1');
  assert.equal(sess.isSeeder, true);
  assert.equal(sess.filePath, 'D:/my/movie.mkv');
  assert.ok(h.calls.some((c) => c[0] === 'offerManifest'));
  // 正在放的就是它：按片源重新就绪（播放器开着的话不动它，文件是同一个）
  assert.deepEqual(h.calls.find((c) => c[0] === 'onCurrentSessionReady'), ['onCurrentSessionReady', 's-seed', 'D:/my/movie.mkv']);
  // 成了片源之后按片源走，不再算「用自己的文件」
  assert.equal(h.ctx.ownCopyFor(h.item), null);
  assert.equal(h.ctx.canUseOwnCopy(h.item), false);
});

test('完整核对才发现不一样：照样放着，再提醒一次；点取消改回从房主那里收', async () => {
  const h = harness({ spot: { size: 1000, sizeMatch: true, checked: 1, mismatched: 0 }, built: { fileId: 'other' }, modalAnswer: false });
  await h.ctx.chooseOwnCopy(h.item);
  await flush();
  await flush();
  assert.equal(h.modals.length, 1);
  assert.equal(h.modals[0].okText, '继续用我的文件');
  assert.equal(h.calls.some((c) => c[0] === 'openSeed'), false);
  // 点了取消（onCancel）→ 改回从房主那里收
  assert.equal(h.S.ownCopies.size, 0);
  assert.ok(h.calls.some((c) => c[0] === 'log' && /改回从房主那里收/.test(c[1])));
});

test('清单还没到手：先向房里要；要不到就只比大小，交给完整核对按 fileId 判', async () => {
  const h = harness({ manifest: null, spot: { size: 1000, sizeMatch: true, checked: 0, mismatched: 0 }, built: { fileId: 'f1', name: 'mine.mkv', size: 1000 } });
  await h.ctx.chooseOwnCopy(h.item);
  await flush();
  assert.ok(h.calls.some((c) => c[0] === 'requestManifest'));
  assert.deepEqual(h.calls.find((c) => c[0] === 'spotCheck'), ['spotCheck', null, 'D:/my/movie.mkv', 1000]);
  assert.equal(h.S.ownCopies.get('f1').quick, 'unknown');
  // 用自己算的清单当片源，片名、时长以列表为准
  assert.deepEqual(h.calls.find((c) => c[0] === 'openSeed'), ['openSeed', 'f1', 'movie.mkv', 'D:/my/movie.mkv']);
});

test('「不用我自己的文件了」：撤掉记录、取消还在算的核对，当前项按没有会话重新来过（会去要清单、开接收会话）', async () => {
  const h = harness({ spot: { size: 900, sizeMatch: false, checked: 0, mismatched: 0 } });
  await h.ctx.chooseOwnCopy(h.item);
  h.S.ownCopy = h.S.ownCopies.get('f1');
  h.S.ownCopy.taskId = 'own-run';
  h.calls.length = 0;
  await h.ctx.dropOwnCopy(h.item);
  assert.equal(h.S.ownCopies.size, 0);
  assert.deepEqual(h.calls.find((c) => c[0] === 'cancelTask'), ['cancelTask', 'own-run']);
  assert.ok(h.calls.some((c) => c[0] === 'retirePlayer'));
  assert.deepEqual(h.calls.find((c) => c[0] === 'onFileItemCurrent'), ['onFileItemCurrent', 'i1', false]);
  assert.ok(h.calls.some((c) => c[0] === 'updateTransfer'));
});

test('列表行菜单和传输一栏：没用时给「用我自己的文件播放…」，用着时能换、能撤；片源没有这一项', async () => {
  const h = harness({ spot: { size: 900, sizeMatch: false, checked: 0, mismatched: 0 } });
  assert.deepEqual(
    plain(h.ctx.localMenu(h.item).map((m) => m.key)),
    ['reveal', 'own-copy']
  );
  await h.ctx.chooseOwnCopy(h.item);
  const menu = h.ctx.localMenu(h.item);
  assert.deepEqual(plain(menu.map((m) => m.key)), ['reveal', 'own-copy', 'own-copy-drop']);
  assert.equal(menu[0].label, '打开你的文件位置');
  const own = h.S.ownCopies.get('f1');
  assert.deepEqual(plain(h.ctx.ownCopyTransferView(own)), { text: '用你自己的文件 · 和房主的不一样', tone: 'warn' });
  own.quick = 'same';
  own.full = { done: 1, total: 4 };
  assert.deepEqual(plain(h.ctx.ownCopyTransferView(own)), { text: '用你自己的文件 · 核对中 25%', tone: '', ratio: 0.25 });
  own.full = null;
  assert.deepEqual(plain(h.ctx.ownCopyTransferView(own)), { text: '用你自己的文件', tone: 'good' });
  // 自己是片源的那部没有这一项
  h.S.sessions.set('f1', { fileId: 'f1', isSeeder: true, filePath: 'D:/src.mkv' });
  assert.equal(h.ctx.localMenu(h.item).some((m) => m.key.startsWith('own-copy')), false);
  assert.equal(h.ctx.canUseOwnCopy({ id: 'l', kind: 'link', url: 'https://x' }), false, '在线视频各自从网站播，没有这一项');
});

test('接线：用自己的文件时不收、不扫、按「已收完」参与就绪和卡顿，不说自己在供片', () => {
  assert.match(fnSource('syncCurrentMirrors'), /const own = ownCopyFor\(item\);\s*if \(own\) \{[\s\S]*?S\.filePath = own\.path;\s*S\.isSeeder = true;\s*S\.mediaSafety = \{ sessionId: null, status: 'trusted-local' \};/);
  assert.match(fnSource('onFileItemCurrent'), /if \(ownCopyFor\(item\)\) \{\s*onOwnCopyCurrent\(\);\s*return;/);
  assert.match(fnSource('onFileItemCurrent'), /S\.sync\.isSeeder = !!sess\?\.isSeeder;/);
  const onOwn = fnSource('onOwnCopyCurrent');
  assert.match(onOwn, /S\.sync\.isSeeder = true;/);
  assert.match(onOwn, /S\.sync\.onBufferProgress\(\{ contiguousBytes: 0, runBytes: 0, complete: true \}\);/);
  assert.match(onOwn, /launchPlayer\(\);/);
  assert.match(fnSource('updateTransfer'), /if \(S\.ownCopies\?\.has\(it\.fileId\)\) return true;/);
  assert.match(fnSource('openLeechFor'), /!S\.ownCopies\?\.has\(fileId\)/);
  assert.match(fnSource('localReadyNow'), /if \(ownCopyFor\(item\)\) return true;/);
  assert.match(fnSource('handlePlayerTick'), /complete: S\.sourceType === 'link' \|\| !!S\.ownCopy \|\| !!ctx\?\.complete,/);
  assert.match(fnSource('servingCurrent'), /\(S\.isSeeder && !S\.ownCopy\)/);
  assert.match(fnSource('fileTransferView'), /const own = ownCopyFor\(item\);\s*if \(own\) return ownCopyTransferView\(own\);/);
  assert.match(fnSource('onPlaylistAction'), /case 'own-copy':\s*await chooseOwnCopy\(item\);/);
  assert.match(fnSource('onPlaylistAction'), /case 'own-copy-drop':\s*await dropOwnCopy\(item\);/);
  assert.match(APP, /\$\('btn-own-copy'\)\.onclick = \(\) => \{\s*if \(S\.current\?\.kind === 'file'\) chooseOwnCopy\(S\.current\);/);
  assert.match(read('src/renderer/index.html'), /<button class="ghost tiny hidden" id="btn-own-copy"[^>]*>用我自己的文件<\/button>/);
});

test('主进程：路径只从对话框来（经 approveSource 批准），粗查要批准过的路径，没有清单时只认整数大小', () => {
  const main = read('src/main/main.js');
  assert.match(main, /secureHandle\('dialog:pickOwnCopy', async \(\) => \{[\s\S]*?return r\.canceled \? null : approveSource\(r\.filePaths\[0\]\);/);
  assert.match(main, /secureHandle\('store:spotCheck'[\s\S]*?validate\.integer\(size, '文件大小'[\s\S]*?: validate\.manifest\(manifest\);\s*return store\.spotCheckFile\(await requireAllowedLocalPath\(filePath\), expected\);/);
  const preload = read('src/main/preload.js');
  assert.match(preload, /pickOwnCopy: \(\) => ipcRenderer\.invoke\('dialog:pickOwnCopy'\)/);
  assert.match(preload, /spotCheck: \(manifest, filePath, size\) => ipcRenderer\.invoke\('store:spotCheck', \{ manifest, filePath, size \}\)/);
});

test('文案：用自己的文件的几句都有英文', async () => {
  const { translate } = await import('../src/renderer/lib/i18n.js');
  for (const zh of [
    '用我自己的文件播放…',
    '不用我自己的文件了',
    '换一个我自己的文件…',
    '打开你的文件位置',
    '用我自己的文件',
    '你的文件和房主的不是同一个',
    '仍然可以用它看，同步照常：播放、暂停、跳转都按时间点跟着房间走。可能会遇到：',
    '帧率不同（比如 23.976 帧和 25 帧）：时间轴会越放越偏',
    '仍然用我的文件',
    '继续用我的文件',
    '用你自己的文件 · 和房主的不一样',
  ]) {
    const en = translate(zh, 'en');
    assert.notEqual(en, zh, zh);
    assert.doesNotMatch(en, /[\u4e00-\u9fff]/, zh);
  }
  assert.equal(translate('大小不一样：你的 1.2 GB，房主的 1.4 GB', 'en'), 'Different size: yours is 1.2 GB, the host’s is 1.4 GB');
  assert.equal(translate('用你自己的文件 · 核对中 37%', 'en'), 'Using your own file · checking 37%');
  assert.equal(translate('1.2 GB · 可信房间 · 边下边播 · 用你自己的文件播放', 'en'), '1.2 GB · Trusted room · Progressive playback · Playing your own copy');
  assert.equal(translate('《片》改回从房主那里收', 'en'), 'Receiving “片” from the host again');
  assert.match(translate('核对完了：你的文件和房主的《片》是同一个，你也开始给别人供片', 'en'), /^Check done/);
});
