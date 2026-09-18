'use strict';

// P4 修复（第二批）：离开房间的收尾、准备队列、会话与磁盘。
//
// app.js 是整页的编排脚本，没法整个在 Node 里跑：这里沿用 roomFlowFixes / p4LinkReady 的办法，
// 把涉及的顶层函数（和几个事件处理器）原样抠进 vm 沙箱，配上假 DOM、假主进程接口和假通道，
// 按出事时的先后顺序喂事件。全程不启动播放器、不联网、不出声。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8').replace(/\r\n/g, '\n');

/** app.js 顶层函数的源码：从声明行到下一个顶格的 `}`。 */
function fnSource(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层函数 ${name}`);
  const end = APP.indexOf('\n}\n', m.index);
  assert.ok(end > m.index, `${name} 的结尾没找到`);
  return APP.slice(m.index, end + 2);
}

/** 事件处理器 / 顶层赋值语句的源码：从锚点到最近的收尾行。 */
function stmtSource(anchor, close) {
  const i = APP.indexOf(anchor);
  assert.ok(i !== -1, `app.js 里没找到「${anchor}」`);
  const end = APP.indexOf(close, i);
  assert.ok(end > i, `「${anchor}」的结尾没找到`);
  return APP.slice(i, end + close.length);
}

function sandbox(sources, globals) {
  const ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, ...globals };
  vm.createContext(ctx);
  vm.runInContext(sources.join('\n\n'), ctx, { filename: 'app.js（节选）' });
  return ctx;
}

const fns = (...names) => names.map(fnSource);

async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

const GB = 1024 ** 3;

/* ------------------------------ 假 DOM ------------------------------ */

function el() {
  const e = { className: '', textContent: '', value: '', hidden: false, disabled: false, style: {}, blurred: 0 };
  e.blur = () => {
    e.blurred++;
  };
  e.setAttribute = (name, value) => {
    e[name] = String(value);
  };
  e.classList = {
    toggle: (c, on) => {
      if (c === 'hidden') e.hidden = on === undefined ? !e.hidden : !!on;
    },
    add: (c) => {
      if (c === 'hidden') e.hidden = true;
    },
    remove: (c) => {
      if (c === 'hidden') e.hidden = false;
    },
    contains: (c) => (c === 'hidden' ? e.hidden : false),
  };
  return e;
}

function domStub() {
  const map = new Map();
  const $ = (id) => {
    if (!map.has(id)) map.set(id, el());
    return map.get(id);
  };
  return { $, map };
}

/* --------------------------- 一、离开房间的收尾 --------------------------- */

function leaveRoomBox({ prepDrainMs = 300 } = {}) {
  const events = [];
  const S = {
    leaving: false,
    prepJobs: [],
    prepRuns: new Set(),
    closing: new Set(),
    leechOpens: new Set(),
    sessions: new Map(),
    playerQuit: Promise.resolve(),
    signaling: { close: () => events.push('signaling.close') },
    swarm: { destroy: () => events.push('swarm.destroy') },
  };
  const ctx = sandbox(fns('leaveRoom', 'cancelPrepJob', 'removePrepJob', 'trackPending', 'trackClosing'), {
    S,
    events,
    PREP_DRAIN_MS: prepDrainMs,
    DRAIN_ROUNDS: 10,
    delay: (ms) => new Promise((r) => setTimeout(r, ms)),
    roomEntered: true,
    renderPlaylist: () => {},
    retirePlayer: () => events.push('retirePlayer'),
    location: { reload: () => events.push('reload') },
    window: { sw: { store: { close: (id) => (events.push(`store.close:${id}`), Promise.resolve()) } } },
  });
  return { ctx, S, events };
}

test('离开房间先等在跑的准备任务收尾，回收临时文件的 IPC 才发得出去', async () => {
  const { ctx, S, events } = leaveRoomBox();
  // 一个已经转封装完、正在算哈希的任务：收到取消后还要过一会儿才发出 releaseTemp
  const job = { key: 'j1', kind: 'file', state: 'running', cancelled: false, cancelHooks: [] };
  S.prepJobs.push(job);
  const run = new Promise((resolve) => {
    job.cancelHooks.push(() => {
      setTimeout(() => {
        events.push('releaseTemp');
        resolve();
      }, 20);
    });
  });
  ctx.trackPending(S.prepRuns, run);

  await ctx.leaveRoom();
  assert.ok(events.includes('releaseTemp'), '回收临时文件的请求根本没发出去');
  assert.ok(
    events.indexOf('releaseTemp') < events.indexOf('reload'),
    `回收排在页面刷新之后就等于没发：${events.join(' → ')}`
  );
});

test('准备任务迟迟不收尾时，离开房间仍然会走完（有时间上限）', async () => {
  const { ctx, S, events } = leaveRoomBox({ prepDrainMs: 40 });
  // submitting 状态的任务在等房主回音，cancelPrepJob 撤不回来，可能永远不结束
  S.prepRuns.add(new Promise(() => {}));
  await ctx.leaveRoom();
  assert.ok(events.includes('reload'), '退出房间被一个撤不回来的任务卡死了');
});

test('离开房间反复排空在途会话请求，等待期间新冒出来的也等', async () => {
  const { ctx, S, events } = leaveRoomBox();
  const first = new Promise((resolve) =>
    setTimeout(() => {
      // 关完旧缓存之后才发出的新请求：一次性快照盖不住它
      ctx.trackClosing(
        new Promise((r) =>
          setTimeout(() => {
            events.push('late-close');
            r();
          }, 10)
        )
      );
      resolve();
    }, 10)
  );
  ctx.trackClosing(first);
  await ctx.leaveRoom();
  assert.ok(events.includes('late-close'), '等待期间新增的收尾请求被漏掉了');
  assert.ok(events.indexOf('late-close') < events.indexOf('reload'), `顺序不对：${events.join(' → ')}`);
});

test('离开房间在删缓存之前再退一次播放器', async () => {
  const { ctx, S, events } = leaveRoomBox();
  S.sessions.set('f1', { sessionId: 'sess-1' });
  await ctx.leaveRoom();
  const quits = events.filter((e) => e === 'retirePlayer').length;
  assert.equal(quits, 2, `收尾期间被抢跑起来的播放器没人退：${events.join(' → ')}`);
  assert.ok(
    events.lastIndexOf('retirePlayer') < events.indexOf('store.close:sess-1'),
    `第二次退播放器要赶在删缓存之前，否则缓存被它占着删不掉：${events.join(' → ')}`
  );
});

/* ------------------------- 二、离开途中不再起播/扫描 ------------------------- */

function playerBox({ leaving }) {
  const calls = [];
  const S = {
    leaving,
    mpvRunning: false,
    filePath: 'C:/cache/a.mkv',
    isSeeder: false,
    sourceType: 'file',
    roomSecurityMode: 'safe',
    mediaSafety: { status: 'clean' },
    currentSeq: 1,
    sync: { sharedPositionNow: () => 0, setPlayerCaps: () => {}, resyncToShared: () => {} },
  };
  const { $ } = domStub();
  const ctx = sandbox(fns('launchPlayer', 'playbackAllowed'), {
    S,
    calls,
    $,
    log: (m) => calls.push(`log:${m}`),
    t: (s) => s,
    playerGate: { begin: () => 7, confirm: () => ({}), epoch: 7 },
    // P6：这两条用例只看「离开途中还起不起播放器」，播放器选择整条让开
    desiredPlayerKind: () => ({ kind: 'mpv', reason: '' }),
    playerName: () => 'mpv',
    renderPlayerControls: () => {},
    reportLaunchFailure: (error) => calls.push(`log:启动 mpv 失败：${error?.message || error}`),
    handlePlayerTick: () => {},
    handlePlayerExit: () => {},
    window: {
      sw: {
        player: {
          launch: (opts) => {
            calls.push(`launch:${opts.filePath}`);
            return Promise.resolve({ gen: 1, caps: {} });
          },
          quit: () => Promise.resolve(),
          osd: () => Promise.resolve(),
        },
      },
    },
  });
  return { ctx, calls, S };
}

test('离开房间途中不再拉起播放器（否则刷新后留下没人管的 mpv）', async () => {
  const leaving = playerBox({ leaving: true });
  await leaving.ctx.launchPlayer();
  assert.deepEqual(
    leaving.calls.filter((c) => c.startsWith('launch:')),
    [],
    '离开房间的收尾里还把播放器拉起来了'
  );
  // 反面：没在离开时照常起播，别把正常路径也堵死
  const normal = playerBox({ leaving: false });
  await normal.ctx.launchPlayer();
  assert.ok(normal.calls.includes('launch:C:/cache/a.mkv'), '正常情况下反而起不了播了');
});

test('离开房间途中扫描通过，不再按结果拉起播放器读马上要删的缓存', async () => {
  const calls = [];
  const session = { fileId: 'f1', sessionId: 's1', slot: 0, manifest: { name: 'a.mkv' }, safety: { status: 'scanning' } };
  const S = { leaving: true, sessions: new Map([['f1', session]]), roomSecurityMode: 'safe', mpvRunning: false };
  const ctx = sandbox(fns('applyScanResult'), {
    S,
    calls,
    log: (m) => calls.push(`log:${m}`),
    t: (s) => s,
    decideScanOutcome: () => ({ destroy: false, status: 'clean' }),
    blockScannedSession: () => Promise.resolve(),
    currentSession: () => session,
    launchPlayer: () => calls.push('launch'),
    renderStatus: () => {},
    window: { sw: { player: { osd: () => Promise.resolve() } } },
  });
  await ctx.applyScanResult(session, { ok: true, status: 'clean' }, 'waiting-download');
  assert.ok(!calls.includes('launch'), '离开房间途中扫描通过又把播放器拉起来了');
  assert.equal(session.safety.status, 'scanning', '离开途中不该再改会话状态');
});

test('离开房间途中不再排新的扫描，也不再替房主推进列表', async () => {
  const calls = [];
  const S = {
    leaving: true,
    swarm: { files: new Map() },
    playlist: { queue: [], seq: 1, started: true },
    sessions: new Map(),
    current: { kind: 'file', fileId: 'f1' },
    switchingMedia: false,
    mpvRunning: false,
    role: 'host',
    hostId: 'me',
    peerId: 'me',
    sync: { started: true, duration: 100, shared: { paused: false }, roomStalled: false, sharedPositionNow: () => 999 },
  };
  const ctx = sandbox(fns('pumpScans', 'hostFallbackTick'), {
    S,
    calls,
    isRoomHost: () => true,
    pickScanTarget: () => {
      calls.push('pick');
      return null;
    },
    shouldPreempt: () => false,
    verifyReceivedMedia: () => calls.push('verify'),
    currentSession: () => null,
    log: () => {},
    submitPlaylistOp: () => calls.push('ended'),
    fallbackSeq: -1,
  });
  ctx.pumpScans();
  ctx.hostFallbackTick();
  assert.deepEqual(calls, [], `离开房间途中还在动作：${calls.join('、')}`);
});

/* --------------------------- 三、准备任务的收尾 --------------------------- */

test('准备任务的收尾都记进 leechOpens / closing，离开房间时才等得到', async () => {
  const S = { leechOpens: new Set(), closing: new Set(), roomSecurityMode: 'safe', env: { ffmpeg: true } };
  const calls = [];
  let releaseSeed = null;
  const ctx = sandbox(fns('prepareLocalFile', 'trackPending', 'trackClosing'), {
    S,
    calls,
    randomId: () => 'task-1',
    uplinkFresh: () => false,
    choosePrepPlan: () => ({ plan: 'as-is' }),
    confirmStreamability: () => true,
    window: {
      sw: {
        media: {
          inspect: () => Promise.resolve({ action: 'ok', size: 10, slim: {}, probe: {} }),
          releaseTemp: () => Promise.resolve(),
        },
        tasks: { cancel: () => Promise.resolve(true) },
        store: {
          onHashProgress: () => () => {},
          buildManifest: () => Promise.resolve({ fileId: 'f1', name: 'a.mkv', size: 10, chunkCount: 1 }),
          openSeed: () =>
            new Promise((resolve) => {
              releaseSeed = () => resolve({ sessionId: 'seed-1' });
            }),
          close: (id) => {
            calls.push(`close:${id}`);
            return Promise.resolve();
          },
        },
      },
    },
  });
  const reporter = {
    label: 'a.mkv',
    stage: () => {},
    title: () => {},
    note: () => {},
    progress: () => {},
    cancelled: () => cancelled,
    onCancel: () => {},
  };
  let cancelled = false;
  const run = ctx.prepareLocalFile('D:/films/a.mkv', reporter);
  await flush();
  assert.equal(S.leechOpens.size, 1, '开做种会话的请求没记进 leechOpens，离开房间时等不到它');
  // 开会话的回包到达时任务已经取消：补发的 close 也要能被 leaveRoom 等到
  cancelled = true;
  releaseSeed();
  const prepared = await run;
  assert.equal(prepared, null);
  assert.ok(calls.includes('close:seed-1'), '取消后没有关掉刚开的会话');
  assert.equal(S.leechOpens.size, 0, 'trackPending 应该在落定后自动摘掉');
});

test('取消之后注册的收尾钩子当场执行，不会变成哑弹', () => {
  const ctx = sandbox(fns('jobReporter'), { renderPlaylistSoon: () => {}, PREP_STAGE_TEXT: ['正在检查格式'] });
  const job = { cancelled: true, cancelHooks: [] };
  let fired = 0;
  ctx.jobReporter(job).onCancel(() => fired++);
  assert.equal(fired, 1, '任务已经取消了，晚注册的钩子再也不会被调用');
  assert.equal(job.cancelHooks.length, 0);
});

test('等测速期间取消，测完不再给已取消的任务弹卡顿预判框', async () => {
  const calls = [];
  const ctx = sandbox(fns('confirmStreamability'), {
    S: { uplinkEstimate: null, roomCapacity: 4, mode: 'server' },
    calls,
    roomEntered: true,
    isRoomHost: () => true,
    bitrateOf: (size, duration) => (duration > 0 ? size / duration : 0),
    hostPrecheck: () => ({ level: 'stall', perViewer: 1, supported: 0 }),
    connectedPeerCount: () => 1,
    openModal: () => {
      calls.push('openModal');
      return { cancel: () => {} };
    },
    log: (m) => calls.push(`log:${m}`),
    make: () => ({}),
    field: () => ({}),
    hint: () => ({}),
    fmtMbps: () => '1 Mbps',
    fmtTime: () => '1:00',
    // 函数里那道 15 秒兜底计时器会一直挂着，让测试进程空等：这里放掉它
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return timer;
    },
  });
  let cancelled = false;
  const reporter = {
    label: 'a.mkv',
    title: () => {},
    note: () => {},
    cancelled: () => cancelled,
    onCancel: () => {},
  };
  const uplink = new Promise((resolve) => setTimeout(() => resolve({ ok: true, bytesPerSec: 1e6, measuredAt: 1 }), 5));
  const proceed = ctx.confirmStreamability({ size: 1e9, duration: 3600, uplinkPromise: uplink, reporter });
  cancelled = true; // 等测速的这十几秒里点了行内「取消」
  assert.equal(await proceed, false, '已取消的任务不该再走到「仍然继续」这一路');
  assert.ok(!calls.includes('openModal'), '给一个已取消的任务弹出了全屏弹窗，还会挡住后面排队的弹窗');
});

test('本机准备阶段失败不写成「房主没有接受」', () => {
  const ctx = sandbox(fns('failPrepJob', 'removePrepJob'), {
    S: { prepJobs: [] },
    roomEntered: true,
    isRoomHost: () => false, // 管理员
    log: () => {},
    renderPlaylist: () => {},
  });
  const local = { state: 'running', cancelled: false, cancelHooks: [], name: 'a.mp4' };
  ctx.failPrepJob(local, new Error('这个 MP4 需要转封装才能边下边播，但没找到 ffmpeg。'));
  assert.equal(local.text, '没法用这个文件', '房主根本没收到请求，别说成他不接受');
  const submitted = { state: 'submitting', cancelled: false, cancelHooks: [], name: 'b.mkv' };
  ctx.failPrepJob(submitted, new Error('房主没有回应'));
  assert.equal(submitted.text, '房主没有接受', '真交给房主之后失败的，文案不变');
});

test('同一个源文件不会被加两次（精简产物的字节不一定一样，按 fileId 去重拦不住）', () => {
  const S = { prepJobs: [], sessions: new Map() };
  const logs = [];
  const ctx = sandbox(fns('queueLocalFiles', 'localPathAlreadyHere', 'newPrepJob'), {
    S,
    logs,
    canEditPlaylist: () => true,
    baseName: (p) => String(p).split(/[\\/]/).pop(),
    randomId: () => 'k' + S.prepJobs.length,
    renderPlaylist: () => {},
    pumpPrepJobs: () => {},
    log: (m) => logs.push(m),
  });
  ctx.queueLocalFiles(['D:/films/a.mkv']);
  ctx.queueLocalFiles(['D:/films/a.mkv']);
  assert.equal(S.prepJobs.length, 1, '同一个文件排了两次准备队列');
  // 已经在做种的那一部再加一次也拦住
  S.prepJobs.length = 0;
  S.sessions.set('f1', { isSeeder: true, sourcePath: 'D:/films/b.mkv' });
  ctx.queueLocalFiles(['D:/films/b.mkv', 'D:/films/c.mkv']);
  assert.deepEqual(
    S.prepJobs.map((j) => j.path),
    ['D:/films/c.mkv'],
    '已经在做种的片被重复准备了一遍'
  );
  assert.ok(logs.some((m) => m.includes('已经在列表里了')), '跳过了却一声不吭');
});

/* --------------------------- 四、首页多选的去向 --------------------------- */

function hostManyBox(outcomes) {
  const calls = [];
  const ctx = sandbox(fns('startHostMany'), {
    calls,
    baseName: (p) => String(p).split(/[\\/]/).pop(),
    startHost: (p) => {
      calls.push(`startHost:${p}`);
      return Promise.resolve(outcomes.shift());
    },
    queueLocalFiles: (paths) => calls.push(`queue:${paths.join(',')}`),
    prepFail: (msg, extra) => calls.push(`prepFail:${msg}|${extra || ''}`),
    prepStop: (title, msg, extra) => calls.push(`prepStop:${title}|${extra || ''}`),
  });
  return { ctx, calls };
}

test('首页多选时第一部失败，其余几部不会被悄悄丢掉', async () => {
  const { ctx, calls } = hostManyBox([
    { outcome: 'failed', message: '这个 MP4 需要转封装才能边下边播，但没找到 ffmpeg。' },
    { outcome: 'entered' },
  ]);
  await ctx.startHostMany(['D:/a.mp4', 'D:/b.mkv', 'D:/c.mkv']);
  assert.ok(calls.includes('startHost:D:/b.mkv'), '第一部失败后没有用下一部接着开房');
  assert.ok(calls.includes('queue:D:/c.mkv'), '剩下的片没有排进准备队列');
});

test('首页多选时第一部被取消，会说清其余几部没有加入', async () => {
  const { ctx, calls } = hostManyBox([{ outcome: 'cancelled' }]);
  await ctx.startHostMany(['D:/a.mp4', 'D:/b.mkv', 'D:/c.mkv']);
  assert.ok(!calls.includes('startHost:D:/b.mkv'), '用户取消是「这一场不传了」，不该替他拿下一部开房');
  const stop = calls.find((c) => c.startsWith('prepStop:'));
  assert.ok(stop && stop.includes('还有 2 部没有加入'), `没有告诉用户剩下的片去哪了：${calls.join('、')}`);
});

/* ----------------------------- 五、会话与磁盘 ----------------------------- */

function leechBox({ queue, sessions, manifest, openLeech }) {
  const calls = [];
  const S = {
    opening: new Set(),
    manifestRetryAt: new Map(),
    knownManifests: new Map([[manifest.fileId, manifest]]),
    leechOpens: new Set(),
    closing: new Set(),
    diskFull: new Set(),
    blockedFiles: new Set(),
    pendingAdds: new Set(),
    sessions,
    playlist: { queue, history: [] },
    leaving: false,
    current: null,
    playerQuit: Promise.resolve(),
    swarm: { removeFile: () => {}, withdrawManifest: () => {}, peers: new Map() },
  };
  const ctx = sandbox(
    fns(
      'openLeechFor',
      'evictableSessions',
      'evictableSession',
      'evictionVictim',
      'parseFreeBytes',
      'closeSession',
      'announceGone',
      'trackPending',
      'trackClosing',
      'newSession'
    ),
    {
      S,
      calls,
      MSG: { DENY: 'deny' },
      log: (m, tone) => calls.push(`log:${tone || ''}:${m}`),
      fmtBytes: (n) => `${n}`,
      renderPlaylistSoon: () => {},
      attachLocalFiles: () => {},
      onCurrentSessionReady: () => {},
      skipCurrentLocally: () => {},
      scheduleTransferUpdate: () => {},
      manifestCandidates: () => [],
      window: {
        sw: {
          store: {
            openLeech: (m) => {
              calls.push('openLeech');
              return openLeech(m);
            },
            close: (id) => {
              calls.push(`close:${id}`);
              return Promise.resolve();
            },
          },
        },
      },
    }
  );
  return { ctx, S, calls };
}

const diskFullError = (needGb, freeGb) =>
  new Error(
    `Error invoking remote method 'store:openLeech': Error: 磁盘空间不够：这部片子需要 ${needGb.toFixed(
      2
    )}GB，缓存所在的磁盘只剩 ${freeGb.toFixed(2)}GB`
  );

test('磁盘放不下时先算「清掉够不够」，不够就一部也不清', async () => {
  const sessions = new Map();
  for (let i = 1; i <= 3; i++) {
    sessions.set(`h${i}`, {
      fileId: `h${i}`,
      slot: i,
      sessionId: `s${i}`,
      isSeeder: false,
      lastPlayedAt: i,
      manifest: { name: `H${i}.mkv`, size: 2 * GB },
    });
  }
  const manifest = { fileId: 'f-big', name: 'BIG.mkv', size: 80 * GB, chunkCount: 40960 };
  const item = { kind: 'file', fileId: 'f-big', slot: 0, name: 'BIG.mkv', size: 80 * GB };
  const { ctx, S, calls } = leechBox({
    queue: [item],
    sessions,
    manifest,
    openLeech: () => Promise.reject(diskFullError(80, 10)),
  });
  await ctx.openLeechFor(item);
  assert.equal(S.sessions.size, 3, '已播放的缓存被逐个清光了，那一部照样收不下');
  assert.equal(calls.filter((c) => c === 'openLeech').length, 1, '不该边删边试');
  assert.ok(S.diskFull.has('f-big'));
  assert.ok(calls.some((c) => c.includes('清掉已播放的缓存也放不下这一部')), '没有说明为什么不清缓存');
});

test('清得够时照常淘汰，但删完要再确认一次还要不要', async () => {
  const victim = {
    fileId: 'h1',
    slot: 1,
    sessionId: 's1',
    isSeeder: false,
    lastPlayedAt: 1,
    manifest: { name: 'H1.mkv', size: 20 * GB },
  };
  const manifest = { fileId: 'f-mid', name: 'MID.mkv', size: 15 * GB, chunkCount: 7680 };
  const item = { kind: 'file', fileId: 'f-mid', slot: 0, name: 'MID.mkv', size: 15 * GB };
  const { ctx, S, calls } = leechBox({
    queue: [item],
    sessions: new Map([['h1', victim]]),
    manifest,
    openLeech: () => Promise.reject(diskFullError(15, 10)),
  });
  // 删缓存要花一会儿，这期间用户点了「离开房间」
  const realClose = ctx.window.sw.store.close;
  ctx.window.sw.store.close = (id) => {
    S.leaving = true;
    return realClose(id);
  };
  await ctx.openLeechFor(item);
  assert.ok(calls.includes('close:s1'), '够腾的时候还是要淘汰');
  assert.equal(
    calls.filter((c) => c === 'openLeech').length,
    1,
    '离开房间途中又发出了新的 openLeech，刷新后主进程会留一个按整片大小预分配的会话'
  );
});

test('中途落进已播放区的片不再为它开接收会话', async () => {
  const manifest = { fileId: 'f-x', name: 'X.mkv', size: 60 * GB, chunkCount: 30720 };
  const item = { kind: 'file', fileId: 'f-x', slot: 0, name: 'X.mkv', size: 60 * GB };
  const { ctx, S, calls } = leechBox({
    queue: [], // 清单在路上时这一部被跳过 / 放完了，只剩已播放区还引用着它
    sessions: new Map(),
    manifest,
    openLeech: () => Promise.resolve({ sessionId: 'ghost', filePath: 'C:/cache/x.mkv' }),
  });
  S.playlist.history = [item];
  await ctx.openLeechFor(item);
  assert.ok(!calls.includes('openLeech'), '为一个不会被调度的会话按整片大小预分配了磁盘');
  assert.equal(S.sessions.size, 0);
});

test('淘汰缓存要告诉对端，别让他们一直把本机当完整片源', async () => {
  const sent = [];
  const sess = { fileId: 'h1', slot: 3, sessionId: 's1', manifest: { name: 'H1.mkv', size: GB } };
  const S = {
    playerQuit: Promise.resolve(),
    closing: new Set(),
    swarm: {
      removeFile: () => {},
      withdrawManifest: () => {},
      peers: new Map([
        ['v1', { authenticated: true, send: (m) => sent.push(m) }],
        ['v2', { authenticated: false, send: (m) => sent.push(m) }],
      ]),
    },
  };
  const ctx = sandbox(fns('closeSession', 'announceGone', 'trackPending', 'trackClosing'), {
    S,
    MSG: { DENY: 'deny' },
    window: { sw: { store: { close: () => Promise.resolve() } } },
  });
  await ctx.closeSession(sess);
  assert.equal(JSON.stringify(sent), JSON.stringify([{ t: 'deny', s: 3, index: 0, gone: true }]), '淘汰缓存时一条消息都没发');
});

test('房主替人转发时也算「正在供片」，不再重测上行', () => {
  const S = { sessions: new Map([['f1', { isSeeder: false }]]), swarm: { peerList: () => [{ upRate: 5e6 }] } };
  const ctx = sandbox(fns('seedingToOthers'), {
    S,
    connectedPeerCount: () => 2,
    UPLINK_BUSY_BPS: 64 * 1024,
  });
  assert.equal(ctx.seedingToOthers(), true, '正在满速转发时重测上行，测出来的数偏低还抢带宽');
  S.swarm.peerList = () => [{ upRate: 0 }];
  assert.equal(ctx.seedingToOthers(), false, '没在发片就该照常测');
});

test('磁盘余量读得出来，删了等于没删就停手', () => {
  const ctx = sandbox(fns('parseFreeBytes', 'evictionVictim', 'evictableSessions'), {
    S: {
      playlist: { queue: [] },
      pendingAdds: new Set(),
      sessions: new Map([
        ['a', { fileId: 'a', isSeeder: false, lastPlayedAt: 2, manifest: { size: 30 * GB } }],
        ['b', { fileId: 'b', isSeeder: false, lastPlayedAt: 1, manifest: { size: 30 * GB } }],
      ]),
    },
  });
  assert.equal(ctx.parseFreeBytes('磁盘空间不够：这部片子需要 80.00GB，缓存所在的磁盘只剩 10.00GB'), 10 * GB);
  assert.equal(ctx.parseFreeBytes('清单没通过校验'), null);
  // 最久没放的排前面
  assert.equal(ctx.evictionVictim(50 * GB, 10 * GB, null).fileId, 'b');
  // 上一次淘汰完可用空间没变大：缓存删不掉，别再往下清
  assert.equal(ctx.evictionVictim(50 * GB, 10 * GB, 10 * GB), null);
  // 读不出余量就退回老办法，别把正常淘汰也堵死
  assert.equal(ctx.evictionVictim(50 * GB, null, null).fileId, 'b');
});

/* --------------------------- 六、房主是走了还是断了 --------------------------- */

function hostLinkBox() {
  const logs = [];
  const handlers = new Map();
  const S = {
    hostId: 'host-1',
    peerId: 'me',
    role: 'guest',
    mode: 'server',
    hostGone: false,
    hostLink: null,
    swarm: { on: (name, fn) => handlers.set(name, fn), peers: new Map(), removePeer: (id) => logs.push(`remove:${id}`) },
  };
  const src = [
    fnSource('hostReallyGone'),
    fnSource('playlistView'),
    `function wire() {\n${stmtSource("  S.swarm.on('peer-gone', (peerId) => {", '\n  });')}\n}`,
  ];
  const ctx = sandbox(src, {
    S,
    logs,
    roomEntered: true,
    isRoomHost: () => false,
    log: (m) => logs.push(m),
    renderPlaylistSoon: () => {},
    refreshSources: () => {},
    scheduleTransferUpdate: () => {},
    renderReady: () => {},
    maybeAutoStart: () => {},
    canEditPlaylist: () => false,
    itemName: () => '',
    itemMeta: () => ({}),
    prepJobView: (j) => j,
    historyView: () => [],
  });
  ctx.wire();
  return { ctx, S, logs, handlers };
}

test('ICE 断了只说「正在重连」，不冒充「房主已离开」', () => {
  const { ctx, S, logs, handlers } = hostLinkBox();
  handlers.get('peer-gone')('host-1');
  assert.equal(S.hostGone, false, '直连断了不等于人走了，何况这时正在重连');
  assert.equal(S.hostLink, 'reconnecting');
  assert.ok(!logs.some((m) => String(m).includes('房主已离开')), `不该报「房主已离开」：${logs.join('、')}`);

  // 重连退避用尽 / 信令说他离开了，才算真走
  ctx.hostReallyGone();
  assert.equal(S.hostGone, true);
  assert.equal(S.hostLink, null);
  assert.ok(logs.some((m) => String(m).includes('房主已离开')));
});

test('极简模式没有重连的路，直连断了仍然直接收场', () => {
  const { S, logs, handlers } = hostLinkBox();
  S.mode = 'manual';
  handlers.get('peer-gone')('host-1');
  assert.equal(S.hostGone, true);
  assert.ok(logs.some((m) => String(m).includes('这个房间结束了')));
});

test('列表横幅按「正在重连 / 已离开」分开说', () => {
  const { ctx, S } = hostLinkBox();
  S.playlist = { queue: [], history: [], started: false };
  S.prepJobs = [];
  S.hostLink = 'reconnecting';
  assert.equal(ctx.playlistView().banner, '和房主的连接断了，正在重连；列表暂停更新');
  S.hostGone = true;
  assert.equal(ctx.playlistView().banner, '房主已离开，列表暂停更新');
});

test('新加的房间横幅与准备队列文案都有英文', async () => {
  const { translate } = await import('../src/renderer/lib/i18n.js');
  assert.equal(
    translate('和房主的连接断了，正在重连；列表暂停更新', 'en'),
    'The connection to the host dropped and is being retried; the playlist is not updating'
  );
  assert.equal(translate('没法用这个文件', 'en'), 'This file cannot be used');
  assert.equal(translate('已取消', 'en'), 'Cancelled');
  assert.equal(translate('这一部没有加入放映。', 'en'), 'This video was not added to the watch party.');
  assert.equal(
    translate('清掉已播放的缓存也放不下这一部，缓存先都留着', 'en'),
    'Even clearing every played cache would not make room for this video, so they are all kept'
  );
  assert.equal(translate('《a.mkv》已经在列表里了，跳过', 'en'), '“a.mkv” is already in the playlist; skipped');
  assert.equal(
    translate('还有 1 部没有加入，要用它们开房请重新选择。', 'en'),
    '1 more video was not added; pick them again to host with them.'
  );
  assert.equal(
    translate('还有 3 部没有加入，要用它们开房请重新选择。', 'en'),
    '3 more videos were not added; pick them again to host with them.'
  );
  assert.equal(translate('这些也没能用：a.mp4、b.mkv', 'en'), 'These could not be used either: a.mp4、b.mkv');
});

/* ------------------------------ 七、弹窗与横幅 ------------------------------ */

test('弹窗排队时双击「确定」不会把下一个弹窗一起确认掉', async () => {
  const { $ } = domStub();
  const src = [
    fnSource('openModal'),
    fnSource('showNextModal'),
    fnSource('finishModal'),
    stmtSource("$('modal-ok').onclick = async (e) => {", '\n};'),
    stmtSource("$('modal-cancel').onclick = (e) => {", '\n};'),
  ];
  const ctx = sandbox(src, { $, replace: () => {}, modalQueue: [], modalCurrent: null });
  const first = ctx.openModal({ title: 'A', body: () => [], onOk: () => true });
  const second = ctx.openModal({ title: 'B', body: () => [], onOk: () => true });
  const ok = $('modal-ok');
  await ok.onclick({ detail: 1 });
  await ok.onclick({ detail: 2 }); // 双击的第二下：此时显示的已经是 B 了
  await flush();
  assert.equal(await first.done, true);
  assert.equal(second.closed, false, '用户根本没看见 B 的内容，就被这一下替他确认了');
});

test('后台扫的片切成当前项后，扫描已用时间会自己走起来', () => {
  const { $ } = domStub();
  const timers = { created: 0, cleared: 0 };
  const S = {
    sync: {
      status: () => ({ stalled: false, paused: true, position: 0, duration: 100, intendedPaused: true, waitingFor: [] }),
      canIControl: () => true,
    },
    current: { kind: 'file', fileId: 'f1' },
    sourceType: 'file',
    mpvRunning: false,
    mediaSafety: { status: 'scanning', scanStartedAt: Date.now() - 1000 },
    roomSecurityMode: 'safe',
    skippedLinks: new Set(),
    diskFull: new Set(),
  };
  const ctx = sandbox(fns('renderStatus', 'renderNowKicker', 'updateStripTone', 'setScanTicker', 'scanProgressLabel'), {
    S,
    $,
    t: (s) => s,
    fmtTime: () => '3:12',
    stallBannerText: () => '',
    canEditPlaylist: () => true,
    linkWaitText: () => '',
    linkResolveFailed: () => false,
    linkAsking: () => false,
    fallbackAsking: () => false,
    currentUnavailable: () => false,
    currentSession: () => ({}),
    pushMpvBanner: () => {},
    setInterval: () => {
      timers.created++;
      return { id: timers.created };
    },
    clearInterval: () => timers.cleared++,
    scanTicker: null,
  });
  ctx.renderStatus();
  assert.equal(timers.created, 1, '横幅在显示「已用 X:XX」，却没有计时器让它往前走');
  ctx.renderStatus();
  assert.equal(timers.created, 1, '计时器不该重复创建');
  S.mediaSafety.status = 'clean';
  ctx.renderStatus();
  assert.equal(timers.cleared, 1, '扫完之后计时器要关掉');
});
