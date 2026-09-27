'use strict';

/**
 * 修复批次 10（就绪门槛与卡顿预判）在 app.js 编排层的真行为：
 *  - GG3-6 成员预判的「已收完」只认整部都在手上；安全模式按整部还缺多少算要等多久；
 *  - GG3-3 「约 T 后继续」用攒够恢复线要的时间，不用「一路看完」要等的时间；
 *  - GG3-5 收完了却卡在安全扫描上的原因随就绪消息报给房主，成员表里说清楚。
 *
 * 手法和 midJoinGate.test.js 一样：把 app.js 的顶层函数原样抠进 vm 沙箱，周围配假依赖。
 * 纯函数（stallForecast、同步引擎）用真的。全程不启动任何播放器，不出声。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8').replace(/\r\n/g, '\n');
const LIB = path.join(root, 'src/renderer/lib');
const load = (name) => import(pathToFileURL(path.join(LIB, name)).href);

const MB = 1024 * 1024;
const SIZE = 1000 * MB;

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

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

async function sandbox({ fns, decls = [], globals = {} }) {
  const forecast = await load('stallForecast.js');
  const ctx = {
    Map,
    Math,
    Number,
    fmtTime,
    bufferLead: forecast.bufferLead,
    forecastStall: forecast.forecastStall,
    resumeLead: forecast.resumeLead,
    worstWaitSeconds: forecast.worstWaitSeconds,
    RateMeter: forecast.RateMeter,
    ...globals,
  };
  vm.createContext(ctx);
  vm.runInContext([...decls.map(declSource), ...fns.map(fnSource)].join('\n\n'), ctx, { filename: 'app.js（节选）' });
  return ctx;
}

/* ------------------------------ GG3-6 成员预判 ------------------------------ */

/** 房主的成员表：一个成员，播放位置 P=500MB，码率 1MB/s。 */
async function forecastRoom({ mode = 'trusted', resumeBytes = 15 * MB } = {}) {
  const S = {
    manifest: { size: SIZE },
    sourceType: 'file',
    current: { kind: 'file', sourceId: 'src' },
    isSeeder: false,
    roomSecurityMode: mode,
    sync: { resumeThresholdBytes: resumeBytes },
  };
  const ctx = await sandbox({
    fns: ['updatePeerForecasts', 'forecastLabel'],
    decls: ['intakeMeters', 'lastForecasts'],
    globals: { S, mediaBitrate: () => MB, roomPlayheadByte: () => 500 * MB, Date: { now: () => clock.t } },
  });
  const clock = { t: 0 };
  /** 同一个人隔两秒报两次：第二次起速率就测出来了。 */
  const twice = (info, perSec = 0) => {
    ctx.updatePeerForecasts([info]);
    clock.t += 2000;
    return ctx.updatePeerForecasts([{ ...info, remoteHeldBytes: info.remoteHeldBytes + 2 * perSec }]).get(info.peerId);
  };
  return { ctx, S, clock, twice };
}

test('中途加入的人从 P 往后都收齐了、[0, P) 还缺着：不说「已收完」，但仍然说不会卡，速度照常算', async () => {
  const { ctx, twice } = await forecastRoom();
  const f = twice(
    { peerId: 'a', remoteHeldBytes: 600 * MB, remoteRunEndBytes: SIZE, remoteMissingAhead: [] },
    MB
  );
  assert.equal(f.level, 'ahead');
  assert.equal(ctx.forecastLabel(f), '前方已收齐，不会卡');
  assert.ok(f.rate > 0, '成员表的速率栏要照常显示，房主看得到他还在补 [0, P)');
});

test('「已收完」只认整部都在手上', async () => {
  const { ctx, twice } = await forecastRoom();
  const f = twice({ peerId: 'a', remoteHeldBytes: SIZE - 2 * MB, remoteRunEndBytes: SIZE, remoteMissingAhead: [] });
  assert.notEqual(f.level, 'done');
  const done = twice({ peerId: 'b', remoteHeldBytes: SIZE, remoteRunEndBytes: SIZE, remoteMissingAhead: [] });
  assert.equal(done.level, 'done');
  assert.equal(ctx.forecastLabel(done), '已收完，不会卡');
});

test('安全模式：从 P 往后收齐了也还要等整部收完，按还缺多少算', async () => {
  const { ctx, twice } = await forecastRoom({ mode: 'safe' });
  // 持有 600MB、每秒多 1MB：还缺 400MB，约 6:40
  const f = twice({ peerId: 'a', remoteHeldBytes: 600 * MB, remoteRunEndBytes: SIZE, remoteMissingAhead: [] }, MB);
  assert.equal(ctx.forecastLabel(f), '收完才播 · 预计还需 6:38');
  // 码率未知（forecastStall 给不出结论）也不影响安全模式要说的那句
  const blind = await forecastRoom({ mode: 'safe' });
  blind.ctx.mediaBitrate = () => 0;
  const g = blind.twice({ peerId: 'b', remoteHeldBytes: 100 * MB, remoteRunEndBytes: 500 * MB, remoteMissingAhead: [[500 * MB, SIZE]] }, MB);
  assert.match(blind.ctx.forecastLabel(g), /^收完才播 · 预计还需 /);
});

test('成员预判按他的各段空洞算：空洞后面他已经收齐的不算要等的', async () => {
  const { twice } = await forecastRoom();
  // P=500MB，[500,550) 缺、[550,1000) 有；速度 0.8MB/s < 码率。整段当缺着会报「会卡」
  const info = { peerId: 'a', remoteHeldBytes: 800 * MB, remoteRunEndBytes: 500 * MB };
  const f = twice({ ...info, remoteMissingAhead: [[500 * MB, 550 * MB]] }, 0.8 * MB);
  assert.equal(f.level, 'stall');
  assert.equal(Math.round(f.lead.waitSec * 10) / 10, 12.5, '50/0.8 − 50 = 12.5 秒，不是 (500/0.8 − 500) = 125 秒');
  // 恢复线 15MB 全在洞里：15 / 0.8 ≈ 18.75 秒
  assert.equal(Math.round(f.resume.waitSec * 100) / 100, 18.75);
});

/* ------------------------------ GG3-3 约 T 后继续 ------------------------------ */

test('全员暂停「约 T 后继续」用攒够恢复线要的时间', async () => {
  const { resumeLead } = await load('stallForecast.js');
  const S = {
    isSeeder: false,
    sourceType: 'file',
    manifest: { size: 4096 * MB },
    // 引擎只在余量过了恢复线（15 秒 × 码率）时才松口
    sync: { resumeThresholdBytes: 15 * MB, localStalled: true, canIControl: () => true, stalledPeers: new Map() },
    swarm: {
      // 4GiB、码率 1MB/s、速度 0.8MB/s、播放头 1GiB、余量 3MB
      progress: () => ({ slot: 1, complete: false, downRate: 0.8 * MB, playbackByte: 1024 * MB, runEndBytes: 1027 * MB }),
      missingAhead: () => [[1027 * MB, 4096 * MB]],
    },
  };
  const ctx = await sandbox({
    fns: ['myResumeLead', 'stallWaitSeconds'],
    globals: { S, resumeLead, lastForecasts: new Map() },
  });
  assert.equal(ctx.stallWaitSeconds(), 15, '(15MB − 3MB) / 0.8MB/s；以前显示的是一路看完要等的约 12:44');

  // 别人卡着：取他的恢复时间，不取他「一路看完」要等的时间
  S.sync.localStalled = false;
  S.sync.stalledPeers = new Map([['a', { name: 'A' }]]);
  ctx.lastForecasts.set('a', { lead: { waitSec: 764 }, resume: { waitSec: 42 } });
  assert.equal(ctx.stallWaitSeconds({ room: true }), 42);
  // 算不出来就不给数
  ctx.lastForecasts.set('a', { lead: { waitSec: 764 }, resume: null });
  assert.equal(ctx.stallWaitSeconds({ room: true }), null);
});

/* ------------------------------ GG3-5 没准备好的原因 ------------------------------ */

async function whyRoom({ mode = 'safe', status = 'scan-timeout', unavailable = true, complete = true } = {}) {
  const { SyncEngine } = await load('syncEngine.js');
  const eng = new SyncEngine({ peerId: 'me', name: 'me', isSeeder: false, hostId: 'host' });
  const out = [];
  eng.on('outbound', (m) => out.push(m));
  const item = { kind: 'file', fileId: 'f1', slot: 1 };
  const S = {
    sync: eng,
    current: item,
    roomSecurityMode: mode,
    blockedFiles: new Set(),
    diskFull: new Set(),
    sessions: new Map([['f1', { slot: 1, isSeeder: false, safety: { status, unavailable } }]]),
    swarm: { files: new Map([[1, { complete }]]) },
  };
  const ctx = await sandbox({
    fns: ['localNotReadyWhy', 'localOptedOut', 'updateLocalReady'],
    globals: {
      S,
      localReadyNow: () => false,
      renderReady: () => {},
      maybeAutoStart: () => {},
    },
  });
  return { ctx, S, eng, out };
}

test('安全模式下扫描器不可用：就绪消息带上原因；重新扫描时换成「在做安全扫描」', async () => {
  const room = await whyRoom();
  room.ctx.updateLocalReady();
  assert.deepEqual(
    room.out.map((m) => [m.ready, m.why]),
    [[false, 'scan-unavailable']]
  );
  room.S.sessions.get('f1').safety.status = 'scanning';
  room.ctx.updateLocalReady();
  assert.equal(room.out.at(-1).why, 'scanning', '原因变了要重发');
});

test('没准备好的原因只报房主从位图上看不出来的几种', async () => {
  const cases = [
    [{ status: 'scan-timeout', unavailable: false }, 'scan-incomplete'],
    [{ status: 'scan-stopped', unavailable: false }, 'scan-incomplete'],
    [{ status: 'waiting-download', unavailable: false }, 'scanning'], // 收完了、排着等扫
    [{ status: 'scan-timeout', complete: false }, null], // 还没收完：房主看得到进度
    [{ status: 'scan-timeout', mode: 'trusted' }, null], // 可信房间不等扫描
  ];
  for (const [opts, why] of cases) {
    const room = await whyRoom(opts);
    assert.equal(room.ctx.localNotReadyWhy(), why, JSON.stringify(opts));
  }
});

test('成员表：没准备好的人报了原因就显示原因，没报的照旧显示预判', () => {
  const body = fnSource('renderPeers');
  assert.match(body, /const waitText = READY_WHY_LABEL\[readyWhy\.get\(peer\.peerId\)\] \|\| forecastText;/);
  assert.match(body, /`未就绪 · \$\{waitText\}`/);
  const labels = vm.runInNewContext(`(${declSource('READY_WHY_LABEL').replace(/^const READY_WHY_LABEL = /, '').replace(/;$/, '')})`);
  assert.deepEqual(Object.keys(labels).sort(), ['scan-incomplete', 'scan-unavailable', 'scanning']);
});
