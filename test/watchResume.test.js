'use strict';

// 「上次看到哪」：每部片看到哪记在本机，房主下次放同一部时问一句要不要接着看
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { IMPLS } = require('./helpers/impls');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('src', 'renderer', 'app.js');
const lib = () => import(pathToFileURL(path.join(root, 'src', 'renderer', 'lib', 'watchProgress.js')).href);

function fnSource(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层函数 ${name}`);
  const end = APP.indexOf('\n}\n', m.index);
  return APP.slice(m.index, end + 2);
}

function memoryStorage(init = {}) {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
  };
}

test('记录的键：本地片子按 fileId、在线视频按网址；认不出来的不记', async () => {
  const { progressKey } = await lib();
  assert.equal(progressKey({ kind: 'file', fileId: 'abc' }), 'f:abc');
  assert.equal(progressKey({ kind: 'link', url: 'https://v.example/1' }), 'l:https://v.example/1');
  assert.equal(progressKey({ kind: 'link', url: 'x'.repeat(3000) }), null);
  assert.equal(progressKey(null), null);
  assert.equal(progressKey({ kind: 'file' }), null);
});

test('该不该问、从哪接着看：看了不到一分钟不问，快看完了不问，接着看往回退 5 秒', async () => {
  const { resumePoint } = await lib();
  assert.equal(resumePoint(null), 0);
  assert.equal(resumePoint({ pos: 59, dur: 3600 }), 0, '没看多少');
  assert.equal(resumePoint({ pos: 834.7, dur: 3600 }), 829);
  assert.equal(resumePoint({ pos: 3500, dur: 3600 }), 0, '离片尾不到 2 分钟');
  assert.equal(resumePoint({ pos: 1000, dur: 1040 }), 0);
  assert.equal(resumePoint({ pos: 2000, dur: 0 }), 1995, '记下时还不知道片长');
  assert.equal(resumePoint({ pos: 2000, dur: 0 }, 2050), 0, '现在知道片长了，按现在的算');
});

test('记下、落盘、重新读出来；落盘攒着（flush 才写）；最多记 300 部，挤掉最久没看的；坏掉的存档当空的', async () => {
  const { WatchProgress, WATCH_PROGRESS_KEY } = await lib();
  let now = 1000;
  const storage = memoryStorage();
  const w = new WatchProgress({ storage, now: () => now, max: 3 });
  w.record('f:a', { pos: 600, dur: 3600, title: '甲' });
  assert.equal(storage.data.size, 0, '没 flush 不写');
  w.flush();
  const again = new WatchProgress({ storage, now: () => now });
  assert.equal(again.resumeFor('f:a'), 595);
  assert.equal(again.get('f:a').title, '甲');
  for (const k of ['f:b', 'f:c', 'f:d']) {
    now += 10;
    w.record(k, { pos: 100, dur: 3600 });
  }
  assert.equal(w.get('f:a'), null, '最久没看的挤掉了');
  assert.ok(w.get('f:d'));
  w.forget('f:d');
  assert.equal(w.get('f:d'), null);
  // 坏掉的、版本不对的、手改的键
  for (const raw of ['{bad', JSON.stringify({ v: 2, items: { 'f:a': { pos: 1, at: 1 } } }), JSON.stringify({ v: 1, items: { 'x:a': { pos: 1, at: 1 }, 'f:b': { pos: -1, at: 1 } } })]) {
    const broken = new WatchProgress({ storage: memoryStorage({ [WATCH_PROGRESS_KEY]: raw }) });
    assert.equal(broken.entries.size, 0);
  }
  // 存不下（配额满了、拿不到 localStorage）不抛
  const throwing = new WatchProgress({ storage: { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('y'); } } });
  throwing.record('f:a', { pos: 100 });
  throwing.flush();
});

/* ------------------------------ 列表操作 ------------------------------ */

function listState(item, { started = false } = {}) {
  return { rev: 1, seq: 4, nextSlot: 1, started, autoplay: true, queue: [item], history: [], roomName: '' };
}

const ctx = { actor: 'h1', actorName: '房主', isController: () => true, newId: () => 'aaaaaaaa' };

for (const { name, dir } of IMPLS) {
  test(`${name}：列表操作 resume——只给正在放、还没开播的这一部定起播点，当成换了一次片（seq 加一）`, async () => {
    const { applyOp } = await import(dir + 'playlist.js');
    const item = { id: 'abcdef01', kind: 'link', url: 'https://v.example/1', title: 'v', durationSec: 3600, resumeAt: 0 };
    const res = applyOp(listState(item), { type: 'resume', id: item.id, at: 829 }, ctx);
    assert.equal(res.ok, true);
    assert.equal(res.state.queue[0].resumeAt, 829);
    assert.equal(res.state.seq, 5, '起播点只在换片时定，大家从新的起播点重来一遍');
    assert.equal(res.state.started, false);
    assert.equal(applyOp(listState(item, { started: true }), { type: 'resume', id: item.id, at: 829 }, ctx).ok, false, '开播了就是跳转');
    assert.equal(applyOp(listState(item), { type: 'resume', id: 'bbbbbbbb', at: 829 }, ctx).ok, false);
    assert.equal(applyOp(listState(item), { type: 'resume', id: item.id, at: 4000 }, ctx).ok, false, '超过片长');
    assert.equal(applyOp(listState(item), { type: 'resume', id: item.id, at: -1 }, ctx).ok, false);
    assert.equal(applyOp(listState({ ...item, resumeAt: 829 }), { type: 'resume', id: item.id, at: 829 }, ctx).unchanged, true);
    assert.equal(applyOp(listState(item), { type: 'resume', id: item.id, at: 829 }, { ...ctx, isController: () => false }).ok, false);
  });
}

/* ------------------------------ 界面接线 ------------------------------ */

function resumeBox({ host = true, started = false, resumeAt = 0, entry = { pos: 834.7, dur: 3600 } } = {}) {
  const item = { id: 'abcdef01', kind: 'file', fileId: 'f1', durationSec: 3600, resumeAt };
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, { id, textContent: '', classList: { hidden: true, toggle(_c, on) { this.hidden = !!on; } } });
    return els.get(id);
  };
  const calls = [];
  const S = { playlist: { seq: 4, started }, current: item, resumeOffer: null, sync: { canIControl: () => true, userSeek: (p) => calls.push(['seek', p]) } };
  const box = {
    S,
    $,
    isRoomHost: () => host,
    progressKey: (it) => `f:${it.fileId}`,
    watchProgress: { resumeFor: () => (entry ? Math.floor(entry.pos - 5) : 0), get: () => entry },
    fmtTime: (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`,
    roomPositionSec: () => 0,
    runPlaylistOp: async (op) => {
      calls.push(['op', op]);
      return { ok: true };
    },
    log: () => {},
  };
  vm.createContext(box);
  vm.runInContext(['offerResume', 'renderResumeOffer', 'acceptResume'].map(fnSource).join('\n\n'), box);
  return { box, S, $, calls, item };
}

test('房主换上来一部上次没看完的：问一句（写着上次看到哪、从哪接着看）；不是房主、已经开播、已经定过起播点都不问', async () => {
  const r = resumeBox();
  r.box.offerResume(r.item);
  r.box.renderResumeOffer();
  assert.deepEqual({ ...r.S.resumeOffer }, { seq: 4, id: 'abcdef01', at: 829, seen: 834.7 });
  assert.equal(r.$('resume-row').classList.hidden, false);
  assert.equal(r.$('resume-row').textContent, '这一部你上次看到 13:54');
  assert.equal(r.$('btn-resume').textContent, '从 13:49 接着看');
  for (const opts of [{ host: false }, { started: true }, { resumeAt: 100 }, { entry: null }]) {
    const other = resumeBox(opts);
    other.box.offerResume(other.item);
    assert.equal(other.S.resumeOffer, null, JSON.stringify(opts));
  }
});

test('「接着看」：还没开播时发列表操作 resume；已经开播了就是一次跳转，全房跟过去', async () => {
  const r = resumeBox();
  r.box.offerResume(r.item);
  await r.box.acceptResume();
  assert.deepEqual(JSON.parse(JSON.stringify(r.calls)), [['op', { type: 'resume', id: 'abcdef01', at: 829 }]]);
  assert.equal(r.S.resumeOffer, null);

  const s = resumeBox();
  s.box.offerResume(s.item);
  s.S.playlist.started = true; // 等人点的这段时间里自动开播了
  await s.box.acceptResume();
  assert.deepEqual(s.calls, [['seek', 829]]);
});

test('接线：换片时先把上一部落盘再问；房间开播后每秒记一次；退房、关窗口、关软件都落盘；「接着看」上膛的照样上膛', () => {
  const sw = fnSource('switchCurrent');
  assert.ok(sw.indexOf('flushWatchProgress();') < sw.indexOf('S.current = item;'));
  assert.ok(sw.indexOf('offerResume(item);') > sw.indexOf('S.current = item;'));
  assert.match(fnSource('driftTick'), /recordWatchProgress\(\);/);
  assert.match(fnSource('recordWatchProgress'), /if \(!item \|\| !S\.playlist\?\.started \|\| S\.currentSeq !== S\.playlist\.seq\) return;/);
  assert.match(fnSource('leaveRoom'), /flushWatchProgress\(\);/);
  assert.match(APP, /window\.addEventListener\('beforeunload', \(\) => \{\n\s+flushWatchProgress\(\);/);
  assert.match(fnSource('armAutoStart'), /\(live && op\.type === 'resume'\) \|\|/);
  assert.match(fnSource('renderStatus'), /renderResumeOffer\(\);/);
});

test('新文案都有英文', async () => {
  const { translate } = await import(pathToFileURL(path.join(root, 'src', 'renderer', 'lib', 'i18n.js')).href);
  assert.equal(translate('这一部你上次看到 13:54', 'en'), 'You last watched this up to 13:54');
  assert.equal(translate('从 13:49 接着看', 'en'), 'Resume from 13:49');
  for (const zh of ['接着看', '从头看', '只能给正在放的这一部定起播点', '已经开播了，直接拖进度条吧', '起播点超过了片长']) {
    assert.doesNotMatch(translate(zh, 'en'), /[一-鿿]/, zh);
  }
  assert.equal(translate('列表没改成：已经开播了，直接拖进度条吧', 'en'), 'The playlist was not changed: Playback has already started; drag the seek bar instead');
});
