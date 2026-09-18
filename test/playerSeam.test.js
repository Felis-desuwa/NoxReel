'use strict';

// 播放器接缝：主进程只通过 PlayerManager 管播放器，渲染进程只认 window.sw.player。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PlayerManager } = require('../src/main/players');
const { buildLaunchArgs } = require('../src/main/mpv');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

class FakeAdapter extends EventEmitter {
  constructor() {
    super();
    this.caps = { seekPrecision: 0 };
    this.quitCalls = 0;
    this.calls = [];
    FakeAdapter.made.push(this);
  }
  async launch(opts) {
    if (FakeAdapter.failNext) {
      FakeAdapter.failNext = false;
      throw new Error('没找到播放器');
    }
    this.calls.push(['launch', opts]);
    return { bin: 'fake' };
  }
  async setPause(p) {
    this.calls.push(['pause', p]);
  }
  async seek(s) {
    this.calls.push(['seek', s]);
  }
  osd(t) {
    this.calls.push(['osd', t]);
  }
  setBanner(t) {
    this.calls.push(['banner', t]);
  }
  snapshot() {
    return { running: true, position: 3 };
  }
  async quit() {
    this.quitCalls++;
  }
}
FakeAdapter.made = [];

const manager = (sent = []) =>
  new PlayerManager({ send: (ch, payload) => sent.push([ch, payload]), adapters: { fake: FakeAdapter } });

test('启动失败时收拾干净，不留一个半死的播放器', async () => {
  FakeAdapter.made.length = 0;
  const mgr = manager();
  FakeAdapter.failNext = true;
  await assert.rejects(mgr.launch('fake', {}), /没找到播放器/);
  assert.equal(mgr.running, false);
  assert.equal(FakeAdapter.made[0].quitCalls, 1, '失败的那个进程也要退掉');
  assert.equal(FakeAdapter.made[0].listenerCount('exit'), 0);
  await assert.rejects(mgr.setPause(true), /播放器未启动/);
});

test('没开播放器时，控制命令报错、提示和横幅静默忽略', async () => {
  const mgr = manager();
  await assert.rejects(mgr.seek(10), /播放器未启动/);
  assert.equal(mgr.osd('x', 100), undefined);
  assert.equal(mgr.setBanner('x'), undefined);
  assert.deepEqual(mgr.snapshot(), { running: false });
});

test('命令转给当前播放器，快照带上代号和种类', async () => {
  FakeAdapter.made.length = 0;
  const mgr = manager();
  const info = await mgr.launch('fake', { source: 'a', startAt: 12 });
  await mgr.setPause(false);
  await mgr.seek(30);
  mgr.osd('提示');
  mgr.setBanner('横幅');
  const a = FakeAdapter.made[0];
  assert.deepEqual(a.calls.map((c) => c[0]), ['launch', 'pause', 'seek', 'osd', 'banner']);
  assert.equal(a.calls[0][1].startAt, 12);
  assert.deepEqual(mgr.snapshot(), { running: true, position: 3, gen: info.gen, kind: 'fake' });
  assert.deepEqual(info.caps, { seekPrecision: 0 });
});

test('播放器自己退出后，管理器不再认为有播放器', async () => {
  const sent = [];
  const mgr = manager(sent);
  const info = await mgr.launch('fake', {});
  FakeAdapter.made.at(-1).emit('exit', { code: 0 });
  assert.equal(mgr.running, false);
  assert.deepEqual(sent.at(-1), ['player:exit', { code: 0, gen: info.gen, kind: 'fake' }]);
});

test('主动退出时先摘监听器，旧进程的收尾事件不再转发', async () => {
  const sent = [];
  const mgr = manager(sent);
  await mgr.launch('fake', {});
  const a = FakeAdapter.made.at(-1);
  await mgr.quit();
  assert.equal(a.listenerCount('exit') + a.listenerCount('tick') + a.listenerCount('error'), 0, '旧播放器身上还挂着监听器');
  a.emit('exit', { code: 0 });
  assert.deepEqual(sent, []);
  assert.equal(a.quitCalls, 1);
});

test('不认识的播放器种类直接拒绝', async () => {
  await assert.rejects(manager().launch('vlc', {}), /不支持的播放器/);
});

test('主进程只剩 player:* 通道，渲染端只认 window.sw.player', () => {
  const main = read('src/main/main.js');
  const preload = read('src/main/preload.js');
  const app = read('src/renderer/app.js');
  for (const ch of ['launch', 'setPause', 'seek', 'osd', 'overlay', 'snapshot', 'quit']) {
    assert.match(main, new RegExp(`secureHandle\\('player:${ch}'`), `缺少 player:${ch}`);
    assert.match(preload, new RegExp(`'player:${ch}'`));
  }
  assert.doesNotMatch(main, /'mpv:/, '还有没改名的 mpv:* 通道');
  assert.doesNotMatch(preload, /'mpv:/);
  assert.doesNotMatch(app, /window\.sw\.mpv\b/);
  assert.match(main, /players\.launch\('mpv'/);
});

test('启动参数里判断在线链接的正则没被写坏', () => {
  // 反斜杠一旦被工具吞掉，/^https?:\/\//i 会变成 /^https?:/ 加一行注释 —— 语法照样合法，
  // 于是任何以 http: 开头的字符串都被当成链接、跳过本地路径校验。
  const main = read('src/main/main.js');
  const handler = main.slice(main.indexOf("secureHandle('player:launch'"));
  const body = handler.slice(0, handler.indexOf('\n});'));
  assert.ok(body.length > 200);
  assert.equal(body.split('/^https?:\\/\\//i.test(').length - 1, 2, 'player:launch 里的链接判断被改坏了');
  for (const f of ['src/main/main.js', 'src/main/linkMedia.js', 'src/main/security.js', 'src/renderer/app.js']) {
    assert.doesNotMatch(read(f), /https\?:\/\/\//, `${f} 里有被吞掉反斜杠的链接正则`);
  }
});

test('主窗口不做后台节流', () => {
  const main = read('src/main/main.js');
  const win = main.slice(main.indexOf('function createWindow()'), main.indexOf('function send('));
  assert.match(win, /backgroundThrottling: false/);
});

test('测试静音只在开发期、显式打开时才生效', () => {
  const main = read('src/main/main.js');
  assert.match(main, /const TEST_MUTE = !app\.isPackaged && process\.env\.NOXREEL_TEST_MUTE === '1';/);
  assert.match(main, /muted: TEST_MUTE/);
});

test('mpv 能从指定位置起播，静音只在要求时才加', () => {
  const base = { ipcPath: 'p', source: 'C:/x.mkv' };
  const plain = buildLaunchArgs(base);
  assert.ok(!plain.some((a) => a.startsWith('--start=')));
  assert.ok(!plain.includes('--mute=yes'));
  const args = buildLaunchArgs({ ...base, startAt: 754.25, muted: true });
  assert.ok(args.includes('--start=754.250'));
  assert.ok(args.includes('--mute=yes'));
  assert.equal(args.at(-1), 'C:/x.mkv', '片源必须是最后一个参数，放在 -- 之后');
  assert.ok(args.indexOf('--start=754.250') < args.indexOf('--'));
});

test('新播放器的第一条 tick 会补上启动前记下的位置', async () => {
  const { SyncEngine } = await import('../src/renderer/lib/syncEngine.js');
  const eng = new SyncEngine({ peerId: 'me', name: 'me', hostId: 'host' });
  eng.started = true;
  const seeks = [];
  eng.onSeek = (p) => seeks.push(p);
  eng.onSetPause = () => {};
  // v2 的 SYNC 必须带当前项序号 seq，缺了会被当非法消息丢掉
  eng.onCtrl({ t: 'sync', paused: true, position: 600, lamport: 3, seq: 0 }, { peerId: 'host' });
  assert.equal(eng.pendingSeek, 600, '播放器还没起来，位置得先记着');
  // launchPlayer 里的 resyncToShared 赶在第一条 tick 之前：只会再记一次
  await eng.resyncToShared();
  assert.deepEqual(seeks, []);
  eng.onMpvTick({ position: 0, paused: true }, { contiguousBytes: 0, complete: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seeks, [600], '第一条 tick 到了却没人补跳，新播放器会停在片头');
});
