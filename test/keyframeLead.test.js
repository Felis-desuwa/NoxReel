'use strict';

/**
 * 跳转落点只会在目标之后的播放器（caps.keyframeAhead，也就是 PotPlayer 的关键帧补救）：
 * 落在房间前面时原地停着，等房间时钟追上落点再放（syncEngine 的 _lead）。
 *
 * 实测（R5-A）：以前没有这一步，PotPlayer 跳到 1:00 停在 64.08，房间一播放它就一直领先约 4 秒；
 * PotPlayer 的对齐容差又放宽到 5.3 秒，引擎永远不会把它拉回来。
 *
 * 这里用假时钟 + 一个极简的假播放器：跳转落在目标之后 landing 秒并停住（补救之后原地暂停），
 * 它的每一次变化都像真播放器一样推一条 tick 回引擎。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { IMPLS } = require('./helpers/impls');

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

// v2 起 SYNC 必须带 seq（当前播放项序号），这里的引擎都停在第 0 项
const syncMsg = (over) => ({ t: 'sync', paused: false, position: 10, lamport: 5, seq: 0, ...over });

/**
 * @param {object} opts
 * @param {'admin'|'guest'} [opts.role]
 * @param {(target: number) => number} [opts.landing]  跳到 target 实际落在哪（默认正好落在目标上）
 * @param {object} [opts.caps]  播放器能力，默认是 PotPlayer 那一套
 */
async function setup(dir, { role = 'admin', landing = (t) => t, caps = { seekPrecision: 4.8, keyframeAhead: true } } = {}) {
  const { SyncEngine } = await import(dir + 'syncEngine.js');
  const eng = new SyncEngine({ peerId: 'me', name: 'me', isSeeder: true, hostId: 'host' });
  const clock = { t: 1000 };
  eng.now = () => clock.t;
  const out = [];
  eng.on('outbound', (m) => out.push(m));

  // 假播放器：播放中按假时钟往前走
  const player = { pos: 0, paused: true, at: clock.t };
  const position = () => (player.paused ? player.pos : player.pos + (clock.t - player.at) / 1000);
  const report = (cause = 'user') =>
    eng.onMpvTick(
      { position: position(), paused: player.paused, duration: 600, sampledAt: clock.t, cause },
      { contiguousBytes: 0, complete: true }
    );
  const move = (pos, paused) => {
    player.pos = pos;
    player.paused = paused;
    player.at = clock.t;
  };
  const seeks = [];
  const pauses = [];
  eng.onSeek = (target) => {
    seeks.push(target);
    const landed = landing(target);
    // 精确的播放器（mpv）跳完保持原来的播放状态；落点在目标之后的（PotPlayer）补救完原地暂停
    const keyframe = landed !== target;
    move(landed, keyframe ? true : player.paused);
    report('cmd');
    return { position: landed, target, keyframe, paused: player.paused };
  };
  eng.onSetPause = (paused) => {
    pauses.push(paused);
    move(position(), paused);
    report('cmd');
  };
  // 放行定时器是真定时器、等的时长却按假时钟算：测试里一律手动触发（见 fire），
  // 还要 unref —— 断言失败时没走到收尾，它按冻住的假时钟会一直重排，拖住整个测试进程。
  const schedule = eng._scheduleLead.bind(eng);
  eng._scheduleLead = () => {
    schedule();
    eng._leadTimer?.unref?.();
  };
  eng.started = true;
  eng.applyRoles([['me', role]], 'host');
  eng.setPlayerCaps(caps);
  report();
  await flush();
  seeks.length = 0;
  pauses.length = 0;

  /** 放行定时器到点（真定时器撤掉，按假时钟手动触发）。 */
  const fire = async () => {
    assert.ok(eng._leadTimer, '停着等房间追上，却没排放行的定时器');
    clearTimeout(eng._leadTimer);
    eng._onLeadTimer();
    await flush();
  };
  /** 假时钟往前拨，顺带让播放器推一条 tick（真播放器每 200ms 推一条）。 */
  const advance = (ms) => {
    clock.t += ms;
    report();
  };
  const done = () => eng._clearLead();
  return { eng, clock, out, seeks, pauses, player, position, report, move, fire, advance, done };
}

impl('暂停中跳转落在目标之后：房间放起来时原地停着，走到落点才放', async (dir) => {
  const s = await setup(dir, { landing: (t) => t + 4.08 });
  s.move(5.2, true);
  s.report('cmd');
  s.eng.onCtrl(syncMsg({ paused: true, position: 60, lamport: 5 }), { peerId: 'host' });
  await flush();
  assert.deepEqual(s.seeks, [60]);
  assert.ok(Math.abs(s.position() - 64.08) < 1e-9);
  assert.ok(s.eng._lead, '落在房间前面 4 秒，要记下来等房间');
  assert.equal(s.eng._leadTimer, null, '房间停着，还不用排放行');

  // 房主按播放
  s.eng.onCtrl(syncMsg({ paused: false, position: 60, lamport: 6 }), { peerId: 'host' });
  await flush();
  assert.deepEqual(s.seeks, [60], '领先在容差内不该再跳一次 —— 跳了落点照样在前面');
  assert.equal(s.player.paused, true, '房间在播，本机停在前面等');
  assert.equal(s.eng.status().paused, false, '界面上房间是在播的，不能写「已暂停」');

  // 定时器早到（房间才走了 2 秒）也不放行
  s.advance(2000);
  await s.fire();
  assert.equal(s.player.paused, true);

  s.advance(2000);
  await s.fire();
  assert.equal(s.player.paused, false, '房间走到落点了，该放了');
  assert.equal(s.eng._lead, null);
  s.advance(3000);
  const diff = s.position() - s.eng.sharedPositionNow();
  assert.ok(Math.abs(diff) < 0.2, `放起来之后应当和房间对齐，差 ${diff.toFixed(2)} 秒`);
  assert.equal(s.out.filter((m) => m.t === 'sync').length, 0, '停着等房间不是用户操作，不许广播');
  s.done();
});

impl('播放中跳转落在目标之后：停几秒等房间，而不是一直领先', async (dir) => {
  const s = await setup(dir, { landing: (t) => (t === 31 ? 36.08 : t) });
  s.eng.onCtrl(syncMsg({ paused: false, position: 75, lamport: 5 }), { peerId: 'host' });
  await flush();
  s.seeks.length = 0;
  s.advance(1000);

  s.eng.onCtrl(syncMsg({ paused: false, position: 31, lamport: 6 }), { peerId: 'host' });
  await flush();
  assert.deepEqual(s.seeks, [31]);
  assert.equal(s.player.paused, true, '落点在房间前面 5 秒，原地停着');
  assert.ok(s.eng._leadTimer, '房间在走，要排放行');

  s.advance(5000);
  await s.fire();
  assert.equal(s.player.paused, false);
  s.advance(4000);
  const diff = s.position() - s.eng.sharedPositionNow();
  assert.ok(Math.abs(diff) < 0.2, `差 ${diff.toFixed(2)} 秒（以前一直领先 5 秒）`);
  assert.equal(s.out.filter((m) => m.t === 'sync').length, 0);
  s.done();
});

impl('停着等房间期间别人按暂停 / 播放：不重跳，等的时长照算', async (dir) => {
  const s = await setup(dir, { landing: (t) => (t >= 100 ? t + 6 : t) });
  s.eng.onCtrl(syncMsg({ paused: false, position: 40, lamport: 5 }), { peerId: 'host' });
  await flush();
  s.seeks.length = 0;
  s.eng.onCtrl(syncMsg({ paused: false, position: 100, lamport: 6 }), { peerId: 'host' });
  await flush();
  assert.deepEqual(s.seeks, [100]);
  // 领先 5.5 秒，比放宽后的容差（5.3 秒）还多：正在等的不能因此又被当成「跑太远」重跳
  s.advance(500);
  s.eng.onCtrl(syncMsg({ paused: true, position: 100.5, lamport: 7 }), { peerId: 'host' });
  await flush();
  assert.equal(s.eng._leadTimer, null, '房间停了，放行跟着停');
  s.advance(10_000);
  s.eng.onCtrl(syncMsg({ paused: false, position: 100.5, lamport: 8 }), { peerId: 'host' });
  await flush();
  assert.deepEqual(s.seeks, [100], '每条同步指令都重跳一次，落点照样在前面，只会越等越久');
  assert.equal(s.player.paused, true);
  s.advance(5500);
  await s.fire();
  assert.equal(s.player.paused, false);
  const diff = s.position() - s.eng.sharedPositionNow();
  assert.ok(Math.abs(diff) < 0.2, `差 ${diff.toFixed(2)} 秒`);
  s.done();
});

impl('停着等房间时控制者在界面上按暂停：报房间的位置，不把全房往前拽', async (dir) => {
  const s = await setup(dir, { landing: (t) => t + 4 });
  s.eng.onCtrl(syncMsg({ paused: false, position: 60, lamport: 5 }), { peerId: 'host' });
  await flush();
  s.advance(1000);
  assert.ok(s.eng._lead);
  s.eng.userSetPaused(true);
  await flush();
  const sent = s.out.filter((m) => m.t === 'sync').at(-1);
  assert.ok(sent && sent.paused === true);
  assert.ok(Math.abs(sent.position - 61) < 0.01, `报了 ${sent.position}，本机停在 64，房间才到 61`);
  s.done();
});

impl('停下之后用户在播放器里自己按了播放：不再按住他，也不把全房往前拽', async (dir) => {
  const s = await setup(dir, { landing: (t) => t + 4 });
  s.eng.onCtrl(syncMsg({ paused: false, position: 60, lamport: 5 }), { peerId: 'host' });
  await flush();
  assert.equal(s.player.paused, true);
  s.advance(250);
  await new Promise((r) => setTimeout(r, 300)); // 等回声窗口关掉，之后的 tick 才算用户操作
  s.pauses.length = 0;
  s.move(s.position(), false);
  s.report();
  const sent = s.out.filter((m) => m.t === 'sync').at(-1);
  assert.ok(sent && sent.paused === false, '控制者在播放器里按播放照常广播');
  assert.ok(Math.abs(sent.position - s.eng.sharedPositionNow()) < 0.01, '按播放报的是房间的位置');
  await s.fire();
  assert.equal(s.eng._lead, null);
  assert.ok(!s.pauses.includes(true), '用户自己放起来了，不该又被按回去');
  s.done();
});

impl('落后超过 1 秒就重跳；领先几秒原地停着等，不跳', async (dir) => {
  const s = await setup(dir);
  // 落后 1.5 秒：以前 PotPlayer 的容差是 5.3 秒，这一截永远没人管
  s.move(58.5, true);
  s.report('cmd');
  s.eng.onCtrl(syncMsg({ paused: true, position: 60, lamport: 5 }), { peerId: 'host' });
  await flush();
  assert.deepEqual(s.seeks, [60]);

  // 落后不到 1 秒：在容差内（适配器落后不到 0.75 秒不补救，这里不能又把它判成落后）
  s.seeks.length = 0;
  s.move(59.3, true);
  s.report('cmd');
  s.eng.onCtrl(syncMsg({ paused: false, position: 60, lamport: 6 }), { peerId: 'host' });
  await flush();
  assert.deepEqual(s.seeks, []);
  assert.equal(s.player.paused, false);

  // 领先 3 秒（不是刚跳的）：同样原地停着等，不去跳
  s.move(63, true);
  s.report('cmd');
  s.eng.onCtrl(syncMsg({ paused: false, position: 60, lamport: 7 }), { peerId: 'host' });
  await flush();
  assert.deepEqual(s.seeks, []);
  assert.equal(s.player.paused, true);
  s.advance(3000);
  await s.fire();
  assert.equal(s.player.paused, false);
  s.done();
});

impl('跳转精确的播放器（mpv）不受影响：没有「停着等」这回事', async (dir) => {
  const s = await setup(dir, { caps: { seekPrecision: 0 }, landing: (t) => t + 0.5 });
  s.eng.onCtrl(syncMsg({ paused: false, position: 60, lamport: 5 }), { peerId: 'host' });
  await flush();
  assert.deepEqual(s.seeks, [60]);
  assert.equal(s.eng._lead, null);
  assert.equal(s.pauses.at(-1), false);
  s.done();
});

impl('换片、播放器退出、换播放器时，停着等的那一段作废', async (dir) => {
  for (const drop of [
    (eng) => eng.resetMedia({ seq: 1 }),
    (eng) => eng.playerGone(),
    (eng) => eng.setPlayerCaps({ seekPrecision: 0 }),
  ]) {
    const s = await setup(dir, { landing: (t) => t + 4 });
    s.eng.onCtrl(syncMsg({ paused: false, position: 60, lamport: 5 }), { peerId: 'host' });
    await flush();
    assert.ok(s.eng._lead && s.eng._leadTimer);
    drop(s.eng);
    assert.equal(s.eng._lead, null);
    assert.equal(s.eng._leadTimer, null, '定时器还挂着，到点会对下一部 / 下一个播放器发播放');
  }
});
