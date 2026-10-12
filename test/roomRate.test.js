'use strict';

// 房间倍速：控制者在 mpv 里长按 → 时全房一起 2 倍速，松手一起回到 1 倍（syncEngine 的 userSetRate）。
// 倍速跟着 SYNC 走（字段 rate，1 倍时不带），房间时钟按它外推；老版本不认，照旧 1 倍、松手那一条把他们拉过来。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { IMPLS } = require('./helpers/impls');

const REPO = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(REPO, ...parts), 'utf8').replace(/\r\n/g, '\n');

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

async function makeEngine(dir, { role = 'host', peerId, hostId = 'host' } = {}) {
  const { SyncEngine } = await import(dir + 'syncEngine.js');
  const id = peerId || (role === 'host' ? 'host' : 'me');
  const eng = new SyncEngine({ peerId: id, name: id, isSeeder: true, hostId });
  const clock = { t: 1000 };
  eng.now = () => clock.t;
  const out = [];
  eng.on('outbound', (m) => out.push(m));
  const rates = [];
  const seeks = [];
  eng.onSeek = (p) => seeks.push(p);
  eng.onSetPause = () => {};
  eng.onSetRate = (r) => rates.push(r);
  eng.started = true;
  if (role === 'host') eng.applyRoles([['admin2', 'admin'], ['g', 'guest']], hostId);
  if (role === 'admin') eng.applyRoles([[id, 'admin'], ['admin2', 'admin']], hostId);
  if (role === 'guest') eng.applyRoles([[id, 'guest'], ['admin2', 'admin']], hostId);
  return { eng, clock, out, rates, seeks };
}

const syncMsg = (over) => ({ t: 'sync', paused: false, position: 10, lamport: 5, seq: 0, ...over });
const tick = (over) => ({ position: 10, paused: false, duration: 600, speed: 1, ...over });
const settle = () => new Promise((r) => setTimeout(r, 0));

impl('控制者开始快进：SYNC 带 rate 2，房间时钟按 2 倍走；松手那一条不带 rate，回到 1 倍', async (dir) => {
  const { eng, clock, out } = await makeEngine(dir, { role: 'admin' });
  eng.onCtrl(syncMsg({ position: 10 }), { peerId: 'host', name: '房主' });
  eng.onMpvTick(tick({ position: 10, sampledAt: 0 }), { contiguousBytes: 0, complete: true });
  out.length = 0;
  assert.equal(eng.userSetRate(2, 10), true);
  const start = out.find((m) => m.t === 'sync');
  assert.equal(start.rate, 2);
  assert.equal(start.paused, false);
  assert.equal(eng.roomRate(), 2);
  assert.equal(eng.rateHolder(), 'me');
  clock.t += 3000;
  assert.ok(Math.abs(eng.sharedPositionNow() - 16) < 0.01, `2 倍速 3 秒应走 6 秒：${eng.sharedPositionNow()}`);
  out.length = 0;
  eng.userSetRate(1, 16.2);
  const end = out.find((m) => m.t === 'sync');
  assert.equal('rate' in end, false, '1 倍时不带 rate：和以前的消息一模一样');
  assert.equal(end.position, 16.2, '松手报自己放到的地方');
  assert.equal(eng.roomRate(), 1);
  assert.equal(eng.rateHolder(), null);
  clock.t += 2000;
  assert.ok(Math.abs(eng.sharedPositionNow() - 18.2) < 0.01);
});

impl('收到快进：倍速落到播放器上、只报 rate 事件不报「播放」；不带 rate 的 SYNC（1 倍、老版本）回到 1 倍', async (dir) => {
  const { eng, clock, rates } = await makeEngine(dir, { role: 'guest' });
  const events = [];
  eng.on('rate', (e) => events.push(e));
  const actions = [];
  eng.on('remote-action', (e) => actions.push(e));
  eng.onCtrl(syncMsg({ position: 10, lamport: 5 }), { peerId: 'host', name: '房主' });
  eng.onMpvTick(tick({ position: 10, sampledAt: 0 }), { contiguousBytes: 0, complete: true });
  await settle();
  actions.length = 0;
  eng.onCtrl(syncMsg({ position: 10.2, lamport: 6, rate: 2 }), { peerId: 'admin2', name: '甲' });
  await settle();
  assert.deepEqual(rates, [2], '播放器报的是 1 倍，要改成 2 倍');
  assert.equal(events.length, 1);
  assert.equal(events[0].rate, 2);
  assert.equal(events[0].by, '甲');
  assert.equal(actions.length, 0, '只是倍速变了，不再报成一次「播放」');
  assert.equal(eng.status().rate, 2);
  clock.t += 1000;
  assert.ok(Math.abs(eng.sharedPositionNow() - 12.2) < 0.01);

  eng.onMpvTick(tick({ position: 12.2, speed: 2, sampledAt: 1000 }), { contiguousBytes: 0, complete: true });
  eng.onCtrl(syncMsg({ position: 14, lamport: 7 }), { peerId: 'admin2', name: '甲' });
  await settle();
  assert.equal(eng.roomRate(), 1, '不带 rate 就是 1 倍');
  assert.deepEqual(rates, [2, 1]);
  assert.equal(events.at(-1).rate, 1);
});

impl('认不出来的倍速一律当 1 倍：超出 0.5–2、不是数', async (dir) => {
  const { normalizeRate } = await import(dir + 'syncEngine.js');
  for (const bad of [5, 0, -1, 0.25, NaN, Infinity, '2', null, undefined, {}]) assert.equal(normalizeRate(bad), 1, String(bad));
  assert.equal(normalizeRate(2), 2);
  assert.equal(normalizeRate(1.5), 1.5);
  const { eng } = await makeEngine(dir, { role: 'guest' });
  eng.onCtrl(syncMsg({ position: 10, lamport: 5, rate: 8 }), { peerId: 'host', name: '房主' });
  assert.equal(eng.roomRate(), 1);
});

impl('游客不能改房间倍速：不发消息、报 denied', async (dir) => {
  const { eng, out } = await makeEngine(dir, { role: 'guest' });
  const denied = [];
  eng.on('denied', (e) => denied.push(e.action));
  out.length = 0;
  assert.equal(eng.userSetRate(2, 10), false);
  assert.equal(out.length, 0);
  assert.deepEqual(denied, ['rate']);
  assert.equal(eng.roomRate(), 1);
});

impl('2 倍速播放时位置每秒走两秒，不当成拖了进度条；播放器位置按 tick 的倍速外推', async (dir) => {
  const { eng, clock, out } = await makeEngine(dir, { role: 'admin' });
  eng.onCtrl(syncMsg({ position: 10 }), { peerId: 'host', name: '房主' });
  eng.onMpvTick(tick({ position: 10, sampledAt: 0 }), { contiguousBytes: 0, complete: true });
  eng.userSetRate(2, 10);
  await new Promise((r) => setTimeout(r, 300)); // 回声窗口关上
  out.length = 0;
  // 两秒一条（PotPlayer 那种只在变化时推 tick 的、或者 IPC 堵了一下）：按 1 倍外推的话每条差两秒，超过跳变阈值
  for (let i = 1; i <= 4; i++) {
    clock.t += 2000;
    eng.onMpvTick(tick({ position: 10 + 4 * i, speed: 2, sampledAt: i * 2000 }), { contiguousBytes: 0, complete: true });
  }
  assert.equal(out.filter((m) => m.t === 'sync').length, 0, '按 1 倍外推就当成拖了进度条，全房被广播一次跳转');
  clock.t += 500;
  assert.ok(Math.abs(eng.playerPositionNow() - 27) < 0.01, `外推 ${eng.playerPositionNow()}`);
});

impl('新人进来时房间正在快进：快照带 rate，他也按 2 倍放', async (dir) => {
  const { eng } = await makeEngine(dir, { role: 'host' });
  eng.userSetPaused(false);
  eng.userSetRate(2, 10);
  const sent = [];
  eng.greet({ peerId: 'new', send: (m) => sent.push(m) });
  const snap = sent.find((m) => m.t === 'sync');
  assert.equal(snap.rate, 2);
  const joiner = await makeEngine(dir, { role: 'guest', peerId: 'new' });
  joiner.eng.onCtrl(snap, { peerId: 'host', name: '房主' });
  assert.equal(joiner.eng.roomRate(), 2);
});

impl('快进的人掉线、被降成游客：房主替他收回 1 倍；不是他就不动', async (dir) => {
  const { eng, out } = await makeEngine(dir, { role: 'host' });
  const events = [];
  eng.on('rate', (e) => events.push(e));
  eng.onCtrl(syncMsg({ position: 10, lamport: 5, rate: 2 }), { peerId: 'admin2', name: '甲' });
  assert.equal(eng.roomRate(), 2);
  assert.equal(eng.rateHolder(), 'admin2');
  out.length = 0;
  eng.peerGone('g');
  assert.equal(eng.roomRate(), 2, '走的不是快进的人');
  eng.peerGone('admin2');
  assert.equal(eng.roomRate(), 1);
  const reset = out.find((m) => m.t === 'sync');
  assert.ok(reset && !('rate' in reset), '发一条 1 倍的 SYNC');
  assert.equal(events.at(-1).orphan, true);

  eng.onCtrl(syncMsg({ position: 20, lamport: 50, rate: 2 }), { peerId: 'admin2', name: '甲' });
  assert.equal(eng.roomRate(), 2);
  eng.setRole('admin2', 'guest');
  assert.equal(eng.roomRate(), 1, '降成游客后他松手那一条会被拒');
});

impl('不是房主的人看到快进的人掉线，不自己收回（只由房主一个人说了算）', async (dir) => {
  const { eng, out } = await makeEngine(dir, { role: 'admin' });
  eng.onCtrl(syncMsg({ position: 10, lamport: 5, rate: 2 }), { peerId: 'admin2', name: '甲' });
  out.length = 0;
  eng.peerGone('admin2');
  assert.equal(eng.roomRate(), 2);
  assert.equal(out.filter((m) => m.t === 'sync').length, 0);
});

impl('缓冲线按墙上的秒算：2 倍速时卡顿线和恢复线都放大一倍', async (dir) => {
  const { eng } = await makeEngine(dir, { role: 'admin' });
  eng.bytesPerSecond = 1000;
  const stall = eng.stallThresholdBytes;
  const resume = eng.resumeThresholdBytes;
  eng.onCtrl(syncMsg({ position: 10, lamport: 5, rate: 2 }), { peerId: 'host', name: '房主' });
  assert.equal(eng.stallThresholdBytes, stall * 2);
  assert.equal(eng.resumeThresholdBytes, resume * 2);
});

impl('换片回到 1 倍；房主转发快进时原样带着 rate', async (dir) => {
  const { eng } = await makeEngine(dir, { role: 'host' });
  const relayed = [];
  eng.on('relay', (r) => relayed.push(r.msg));
  eng.onCtrl(syncMsg({ position: 10, lamport: 5, rate: 2 }), { peerId: 'admin2', name: '甲' });
  assert.equal(relayed.at(-1).rate, 2);
  eng.resetMedia({ seq: 1 });
  assert.equal(eng.roomRate(), 1);
  assert.equal(eng.rateHolder(), null);
});

test('接线：长按 → 开始 / 松手 / 播放器没了都经 userSetRate；主进程、mpv、控制条、安卓都认倍速', () => {
  const app = read('src/renderer/app.js');
  assert.match(app, /S\.sync\.userSetRate\(2, S\.sync\.playerPositionNow\(\)\)/);
  assert.match(app, /S\.sync\.userSetRate\(1, /);
  assert.match(app, /function forgetMpvOsc\(\) \{[\s\S]*?if \(S\.speedHold\) releaseSpeedHold\(null\);/);
  assert.match(app, /S\.sync\.onSetRate = \(rate\) => whilePlayerBusy\(window\.sw\.player\.setSpeed\(rate\)/);
  assert.match(app, /rate: oscRate\(\),/);
  assert.doesNotMatch(app, /S\.sync\.userSeek\(payload\.position\)/, '松手不再只是跳转');
  // 房间窗口的横幅：全房在快进时说一声（引擎 status() 带 rate）
  assert.match(app, /: st\.rate > 0 && st\.rate !== 1\s*\? \/\/ 有人按着 → 让全房快进\s*`全房 \$\{st\.rate\} 倍速快进中`/);

  const main = read('src/main/main.js');
  assert.match(main, /secureHandle\('player:setSpeed', async \(rate\) => \{\s*return players\.setSpeed\(validate\.finiteNumber\(rate, '倍速', \{ min: 0\.5, max: 2 \}\)\);/);
  assert.match(read('src/main/preload.js'), /setSpeed: \(rate\) => ipcRenderer\.invoke\('player:setSpeed', rate\)/);

  const { OBSERVED, MpvController } = require('../src/main/mpv');
  assert.ok(OBSERVED.includes('speed'));
  const ctl = new MpvController();
  assert.equal(ctl.snapshot().speed, 1);
  ctl.props.speed = 2;
  assert.equal(ctl.snapshot().speed, 2);
  const sent = [];
  ctl.command = (cmd) => {
    sent.push(cmd);
    return Promise.resolve();
  };
  ctl.setSpeed(2);
  assert.deepEqual(sent, [['set_property', 'speed', 2]]);

  const security = require('../src/main/security');
  const ok = security.oscState({ rate: { x: 2, text: '全房 2 倍速 · 甲 在快进' } });
  assert.deepEqual(ok.rate, { x: 2, text: '全房 2 倍速 · 甲 在快进' });
  assert.throws(() => security.oscState({ rate: { x: 5, text: 'x' } }));

  const lua = read('resources/mpv-scripts/noxreel-osc.lua');
  assert.match(lua, /next_room\.rate = \{ x = raw\.rate\.x, text = str\(raw\.rate\.text, 120\) \}/);
  assert.match(lua, /elseif room\.rate then\s+draw_room_rate\(toast_y\)/);
  assert.match(lua, /room\.danmaku ~= nil then return end/, '房间里倍速跟着房间变，不弹「倍速 2×」');

  const kt = read('android/app/src/main/java/com/syncwatch/app/NativeBridge.kt');
  assert.match(kt, /fun playerSetSpeed\(speed: Double\) \{\s*if \(!speed\.isFinite\(\) \|\| speed < 0\.5 \|\| speed > 2\.0\) return/);
  const player = read('android/app/src/main/java/com/syncwatch/app/SyncPlayer.kt');
  assert.match(player, /player\?\.setPlaybackSpeed\(speed\.toFloat\(\)\)/);
  assert.match(player, /\.put\("speed", s\.speed\.toDouble\(\)\)/);
  assert.match(read('android/app/src/main/assets/js/native-shim.js'), /Native\.playerSetSpeed\(Number\(rate\) \|\| 1\)/);
  const android = read('android/app/src/main/assets/js/app-android.js');
  assert.match(android, /S\.sync\.onSetRate = \(rate\) => window\.swPlayer\.setSpeed\(rate\)/);
  assert.match(android, /typeof snap\.speed === 'number' \? \{ speed: snap\.speed \} : \{\}/);
});

test('文案：快进的几行日志 / 控制条那一条都有英文，「你」要翻、别人的昵称原样', async () => {
  const { translate } = await import('../src/renderer/lib/i18n.js');
  assert.equal(translate('你 开始全房 2 倍速快进', 'en'), 'You started fast-forwarding everyone at 2×');
  assert.equal(translate('甲 开始全房 2 倍速快进', 'en'), '甲 started fast-forwarding everyone at 2×');
  assert.equal(translate('甲 松开快进，全房回到正常速度 @ 1:02', 'en'), '甲 let go — everyone is back to normal speed @ 1:02');
  assert.equal(translate('你 松开快进，全房回到正常速度 @ 1:02', 'en'), 'You let go — everyone is back to normal speed @ 1:02');
  assert.match(translate('快进的人离开了，全房回到正常速度 @ 1:02', 'en'), /^Whoever was fast-forwarding left/);
  assert.equal(translate('全房 2 倍速 · 甲 在快进', 'en'), 'Everyone at 2× · 甲 is fast-forwarding');
  assert.equal(translate('全房 2 倍速 · 你 在快进', 'en'), 'Everyone at 2× · you’re fast-forwarding');
  assert.equal(translate('全房 2 倍速快进中', 'en'), 'Everyone fast-forwarding at 2×');
  assert.equal(translate('全房跟着一起快进', 'en'), 'everyone speeds up with you');
  const android = await import('../android/app/src/main/assets/js/i18n.js');
  assert.equal(android.translate('甲 开始全房 2 倍速快进', 'en'), '甲 started fast-forwarding everyone at 2×');
  assert.equal(android.translate('甲 松开快进，全房回到正常速度 @ 1:02', 'en'), '甲 let go — everyone is back to normal speed @ 1:02');
});
