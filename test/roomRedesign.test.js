'use strict';

// 0.7.1 房间页重排：邀请区的几种状态、状态带的颜色、实时速率那一句结论、「仍然开始」挪位置之后的收起。
// app.js 没法整个在 Node 里跑，沿用 p4RoomCleanup 的办法：把要测的顶层函数抠出来放进 vm 里跑。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8').replace(/\r\n/g, '\n');

function fnSource(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(APP);
  assert.ok(m, `app.js 里没找到顶层函数 ${name}`);
  const end = APP.indexOf('\n}\n', m.index);
  assert.ok(end > m.index, `${name} 的结尾没找到`);
  return APP.slice(m.index, end + 2);
}

function sandbox(sources, globals) {
  const ctx = { console, Promise, ...globals };
  vm.createContext(ctx);
  vm.runInContext(sources.join('\n\n'), ctx, { filename: 'app.js（节选）' });
  return ctx;
}

/* ------------------------------ 假 DOM ------------------------------ */

function el(id) {
  const classes = new Set();
  const e = {
    id,
    textContent: '',
    className: '',
    attrs: {},
    classes,
    classList: {
      toggle(c, on) {
        const want = on === undefined ? !classes.has(c) : !!on;
        if (want) classes.add(c);
        else classes.delete(c);
        return want;
      },
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    setAttribute(name, value) {
      e.attrs[name] = String(value);
    },
    scrollIntoView() {},
  };
  return e;
}

function dom(preset = {}) {
  const map = new Map(Object.entries(preset));
  const $ = (id) => {
    if (!map.has(id)) map.set(id, el(id));
    return map.get(id);
  };
  return { $, map };
}

const hidden = (node) => node.classes.has('hidden');

/* ------------------------------ 邀请区 ------------------------------ */

function inviteRoom({ role = 'host', others = 0, capacity = 4, mode, pending = null, entered = true, link = true } = {}) {
  const calls = [];
  const { $, map } = dom();
  if (!link) map.set('inv-link', null);
  const S = { role, roomCapacity: capacity, mode, pendingManualPeer: pending, leaving: false };
  const ctx = sandbox(
    ['let inviteOpen = false;', fnSource('renderInviteArea'), fnSource('openInvite'), fnSource('closeInvite')],
    {
      S,
      $,
      roomEntered: entered,
      connectedPeerCount: () => others,
      inviteViaManual: () => {
        calls.push('invite');
        return Promise.resolve();
      },
      selectRoomTab: (name, opts) => calls.push(['tab', name, opts?.byUser]),
      replace: () => {},
      make: () => ({}),
    }
  );
  return { ctx, $, S, calls };
}

test('房主一个人的时候，成员页整页就是邀请流程', () => {
  const { ctx, $ } = inviteRoom({ pending: {} });
  ctx.renderInviteArea();
  assert.equal(hidden($('invite-card')), false);
  assert.equal($('invite-card').classes.has('lone'), true, '整页铺开，不画成卡片');
  assert.equal($('invite-title').textContent, '把朋友拉进房间');
  assert.equal(hidden($('invite-next')), true, '还没人进来，没有「下一位」可言');
  assert.equal(hidden($('btn-invite-close')), true, '空房间收起来就什么都没了，不给收');
});

test('有人进来之后，邀请收成成员表底下一行「还能再来 N 人 · 邀请下一位」', () => {
  const { ctx, $ } = inviteRoom({ others: 1, capacity: 4 });
  ctx.renderInviteArea();
  assert.equal(hidden($('invite-card')), true);
  assert.equal(hidden($('invite-next')), false);
  assert.equal($('invite-left').textContent, '还能再来 2 人', '上限 4 人，房主和一位成员已经占了两个');
});

test('点「邀请下一位」：展开卡片，极简模式现生成一条新链接（上一条已经用掉了）', () => {
  const { ctx, $, calls } = inviteRoom({ others: 1, pending: null });
  ctx.openInvite();
  assert.equal(hidden($('invite-card')), false);
  assert.equal($('invite-card').classes.has('lone'), false, '有人了就画成卡片，挂在成员表下面');
  assert.equal($('invite-title').textContent, '邀请下一位');
  assert.equal(hidden($('btn-invite-close')), false);
  assert.equal(hidden($('invite-next')), true, '卡片展开时那一行收起来，不然同一件事出现两遍');
  assert.deepEqual(calls, [['tab', 'peers', true], 'invite']);
});

test('手上还有一条没用掉的链接时，点「邀请」不重新生成（重新生成会作废它）', () => {
  const { ctx, calls } = inviteRoom({ others: 1, pending: { peerId: 'pending-abc' } });
  ctx.openInvite();
  assert.deepEqual(calls, [['tab', 'peers', true]]);
});

test('信令模式的邀请码多人可用，点「邀请」只展开，不重新生成', () => {
  const { ctx, calls } = inviteRoom({ others: 2, mode: 'server' });
  ctx.openInvite();
  assert.deepEqual(calls, [['tab', 'peers', true]]);
});

test('收起之后回到那一行；房间满了那一行也不出现', () => {
  const room = inviteRoom({ others: 1, pending: {} });
  room.ctx.openInvite();
  room.ctx.closeInvite();
  assert.equal(hidden(room.$('invite-card')), true);
  assert.equal(hidden(room.$('invite-next')), false);

  const full = inviteRoom({ others: 1, capacity: 2, pending: {} });
  full.ctx.renderInviteArea();
  assert.equal(hidden(full.$('invite-next')), true);
  assert.equal(full.$('invite-left').textContent, '还能再来 0 人');
});

test('观众看到的是一句「让发起者再生成一个邀请码」，不是邀请流程', () => {
  const { ctx, $, calls } = inviteRoom({ role: 'guest', others: 1 });
  ctx.renderInviteArea();
  assert.equal(hidden($('invite-card')), false);
  assert.equal($('invite-card').classes.has('guest'), true);
  assert.equal(hidden($('invite-next')), true);
  ctx.openInvite();
  assert.deepEqual(calls, [], '观众点不出邀请');
});

test('人都走光了又剩房主一个：屏幕上那条早已用掉的链接要换一条新的', () => {
  const stale = inviteRoom({ others: 0, pending: null });
  stale.ctx.renderInviteArea();
  assert.deepEqual(stale.calls, ['invite']);

  // 还没画过链接（刚进房，renderInvite 正在生成第一条）、或者已经离开房间：都不重复生成
  assert.deepEqual(inviteRoom({ others: 0, pending: null, link: false }).calls, []);
  const first = inviteRoom({ others: 0, pending: null, link: false });
  first.ctx.renderInviteArea();
  assert.deepEqual(first.calls, []);
  const gone = inviteRoom({ others: 0, pending: null, entered: false });
  gone.ctx.renderInviteArea();
  assert.deepEqual(gone.calls, []);
});

test('极简模式握手成功后，邀请卡片收起来，换成「邀请下一位」那一行', () => {
  const src = fnSource('watchManualHandshake');
  const success = src.slice(src.indexOf('if (!retry) {'), src.indexOf('// 失效的连接'));
  assert.match(success, /if \(peer\.authenticated\) \{\s*inviteOpen = false;\s*renderInviteArea\(\);/);
});

/* ------------------------------ 状态带 ------------------------------ */

function stripRoom({ banner = [], ready = null, safety = 'clean' } = {}) {
  const { $ } = dom();
  for (const c of banner) $('status-banner').classes.add(c);
  if (ready === null) $('ready-row').classes.add('hidden');
  else if (ready === 'all') $('ready-row').classes.add('all');
  else if (ready === 'alone') {
    $('ready-row').classes.add('all');
    $('ready-row').classes.add('alone');
  }
  const ctx = sandbox([fnSource('updateStripTone')], { $, S: { mediaSafety: { status: safety } } });
  ctx.updateStripTone();
  return $('status-strip').attrs['data-tone'];
}

test('状态带的颜色跟着情况走', () => {
  assert.equal(stripRoom({ banner: ['playing'] }), 'ok', '同步在播：绿');
  assert.equal(stripRoom({ banner: ['waiting'] }), 'warn', '有人卡住、全员在等：黄');
  assert.equal(stripRoom({}), 'info', '其余情况：蓝');
  assert.equal(stripRoom({ ready: 'waiting' }), 'warn', '还有人没准备好：黄');
  assert.equal(stripRoom({ ready: 'all' }), 'ok', '都准备好了：绿');
  assert.equal(stripRoom({ ready: 'alone' }), 'info', '房主一个人：不是「都准备好了」，是该去拉人');
  assert.equal(stripRoom({ banner: ['playing'], safety: 'blocked' }), 'bad', '扫出威胁：红，压过别的');
});

test('「仍然开始」挪进状态带以后，这一部开播了要自己收起来', () => {
  const { $ } = dom();
  $('btn-force-start').classes.delete('hidden');
  let tone = 0;
  const ctx = sandbox([fnSource('renderReady')], {
    $,
    S: { sync: null, current: null },
    roomEntered: false,
    updateStripTone: () => tone++,
  });
  ctx.renderReady();
  assert.equal(hidden($('ready-row')), true);
  assert.equal(hidden($('btn-force-start')), true, '以前它在就绪行里面，跟着那一行一起藏；现在不在了');
  assert.equal(tone, 1, '就绪行藏起来以后状态带的颜色也要重算');
});

/* ---------------------------- 实时速率的结论 ---------------------------- */

function verdict({ current = { kind: 'file' }, link = false, serving = false, complete = false, mode = 'trusted', down = 0, bitrate = 0, peers = [] } = {}) {
  const ctx = sandbox([fnSource('rateVerdict')], {
    S: {
      current,
      sourceType: link ? 'link' : 'file',
      roomSecurityMode: mode,
      swarm: { progress: () => ({ complete }) },
    },
    servingCurrent: () => serving,
  });
  return ctx.rateVerdict(down, bitrate, peers);
}

const MB = 1e6 / 8; // 1 Mbps 对应的字节/秒

test('速率那一行最右边的一句：片源说在给几个人供片', () => {
  assert.equal(verdict({ serving: true }).text, '还没人连上，没有流量');
  const peers = [
    { authenticated: true, upRate: 3 * MB },
    { authenticated: true, upRate: 0 },
    { authenticated: false, upRate: 5 * MB },
  ];
  assert.equal(verdict({ serving: true, peers }).text, '正在给 1 人供片');
  assert.equal(verdict({ serving: true, peers: [{ authenticated: true, upRate: 0 }] }).text, '现在没人在收');
});

test('速率那一行最右边的一句：接收方拿下行和码率比', () => {
  const bitrate = 16 * MB;
  // vm 里造的对象原型不同，逐个字段比
  const plenty = verdict({ down: 42 * MB, bitrate });
  assert.equal(plenty.text, '下行是码率的 2.6 倍，够用');
  assert.equal(plenty.tone, 'ok');
  assert.equal(verdict({ down: 17 * MB, bitrate }).tone, 'warn');
  assert.equal(verdict({ down: 9 * MB, bitrate }).tone, 'bad');
  assert.equal(verdict({ down: 0, bitrate }).text, '还没开始收');
  assert.equal(verdict({ down: 9 * MB, bitrate: 0 }).text, '', '码率未知就不下结论');
});

test('速率结论不在不该说的时候说「会卡」', () => {
  assert.equal(verdict({ complete: true, down: 1 * MB, bitrate: 16 * MB }).text, '这一部已经收完');
  // 安全模式收完才播，速度只决定等多久
  assert.equal(verdict({ mode: 'safe', down: 1 * MB, bitrate: 16 * MB }).text, '安全模式：收完才播');
  assert.equal(verdict({ link: true }).text, '各自从原网站读取，不走 P2P');
  assert.equal(verdict({ current: null }).text, '');
});

/* ------------------------------ 进度条 ------------------------------ */

test('进度条的绿色画的是「从播放位置起不用等的一段」，不是从文件头起的完整度', () => {
  const src = fnSource('renderProgress');
  assert.match(src, /const runStart = Math\.max\(0, Math\.min\(size, p\.playbackByte \?\? 0\)\);/);
  assert.match(src, /\$\('buf-safe'\)\.style\.left = `\$\{\(\(runStart \/ size\) \* 100\)\.toFixed\(2\)\}%`;/);
  assert.match(src, /\$\('buf-safe'\)\.style\.width = `\$\{\(\(runBytes \/ size\) \* 100\)\.toFixed\(2\)\}%`;/);
  assert.doesNotMatch(src, /p\.contiguousRatio \* 100/);
  // 图例带数值
  assert.match(src, /legendItem\('play', position > 0 \? `播放到 \$\{fmtTime\(position\)\}` : '还没开始'\)/);
  assert.match(src, /`不用等还能放 \$\{fmtTime\(runBytes \/ bitrate\)\}`/);
});

/* ------------------------------ 翻译 ------------------------------ */

test('重排后的动态文案都有英文，昵称和片名照旧不翻', async () => {
  const { translate } = await import('../src/renderer/lib/i18n.js');
  const cases = [
    ['还能再来 3 人', 'Room for 3 more'],
    ['已连接 · 可信房间 · 4 / 8 人', 'Connected · Trusted room · 4 / 8 people'],
    ['等人加入 · 安全模式 · 1 / 4 人', 'Waiting for people · Safe mode · 1 / 4 people'],
    ['第 2 / 4 部', 'Item 2 of 4'],
    ['播放到 1:02:14', 'Playing at 1:02:14'],
    ['不用等还能放 32:10', '32:10 playable without waiting'],
    ['已收到 73.0%（1500/2048 片）', 'Received 73.0% (1500/2048 chunks)'],
    ['未就绪 · 余量很薄，网络一抖就会卡', `Not ready · ${translate('余量很薄，网络一抖就会卡', 'en')}`],
    ['持有 42% · 延迟 31ms', 'Has 42% · Latency 31ms'],
    ['片子码率 16 Mbps', 'Video bitrate 16 Mbps'],
    ['正在给 1 人供片', 'Seeding to 1 person'],
    ['下行是码率的 2.6 倍，够用', 'Download is 2.6× the bitrate, plenty'],
    ['（你）', ' (you)'],
    // 应答框的占位文字以前就漏了英文，邀请区重排时一起补上
    ['点开对方发回的 NoxReel 应答链接，或粘贴到这里', 'Open the NoxReel reply link they sent back, or paste it here'],
  ];
  for (const [zh, en] of cases) assert.equal(translate(zh, 'en'), en, zh);
  // 三段式的老模板不能被新加的两段式吞掉
  assert.equal(translate('持有 42% · 延迟 31ms · 收片 12 Mbps', 'en'), 'Has 42% · Latency 31ms · Receiving 12 Mbps');
  assert.notEqual(translate('余量很薄，网络一抖就会卡', 'en'), '余量很薄，网络一抖就会卡', '嵌在「未就绪 · 」后面的那句本身也得有英文');
});
