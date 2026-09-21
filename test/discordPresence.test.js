'use strict';

// Discord 状态显示（0.7.4）。
//
// 主进程那一半用一个假的 Discord（命名管道服务端）跑真实的握手、READY、SET_ACTIVITY，
// 不碰本机真的 Discord。渲染进程那一半是纯函数：守的是隐私默认值（默认关、默认不带片名）
// 和「加入放映」按钮只在有房间链接时出现。

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  DiscordPresence,
  sanitizeActivity,
  encodeFrame,
  FrameReader,
  OP_HANDSHAKE,
  OP_FRAME,
} = require('../src/main/discordPresence');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pipeName = () =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\noxreel-test-discord-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
    : path.join(require('node:os').tmpdir(), `noxreel-test-discord-${crypto.randomBytes(4).toString('hex')}.sock`);

/** 假 Discord：记下收到的帧，握手后回 READY。 */
function fakeDiscord(t, { ready = true } = {}) {
  const pipe = pipeName();
  const frames = [];
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    const reader = new FrameReader();
    sock.on('data', (chunk) => {
      for (const f of reader.push(chunk)) {
        frames.push(f);
        if (f.op === OP_HANDSHAKE && ready) {
          sock.write(encodeFrame(OP_FRAME, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1 } }));
        }
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => sockets.delete(sock));
  });
  const listening = new Promise((r) => server.listen(pipe, r));
  t.after(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  return {
    pipe,
    frames,
    listening,
    activities: () => frames.filter((f) => f.op === OP_FRAME && f.data?.cmd === 'SET_ACTIVITY').map((f) => f.data.args),
    connections: () => sockets.size,
    kick: () => {
      for (const s of sockets) s.destroy();
    },
  };
}

const ACT = (details) => ({ type: 3, details, state: '房间 2/4 人', assets: { large_image: 'noxreel', large_text: 'NoxReel' } });

test('帧编解码：分几块到也拼得回来', () => {
  const buf = Buffer.concat([encodeFrame(1, { a: '中文' }), encodeFrame(3, { b: 2 })]);
  const r = new FrameReader();
  const out = [...r.push(buf.subarray(0, 5)), ...r.push(buf.subarray(5, 20)), ...r.push(buf.subarray(20))];
  assert.deepEqual(out, [
    { op: 1, data: { a: '中文' } },
    { op: 3, data: { b: 2 } },
  ]);
  assert.throws(() => new FrameReader().push(Buffer.from([1, 0, 0, 0, 255, 255, 255, 127])), /帧长度不对/);
});

test('握手带应用 ID；READY 之后才发状态，发的是 Watching', async (t) => {
  const d = fakeDiscord(t);
  await d.listening;
  const p = new DiscordPresence({ clientId: '123456', pipePath: d.pipe, minIntervalMs: 100 });
  t.after(() => p.destroy());
  const statuses = [];
  p.onStatus = (s) => statuses.push(s);
  p.setActivity(ACT('和朋友一起看片'));
  await sleep(150);
  assert.deepEqual(d.frames[0], { op: OP_HANDSHAKE, data: { v: 1, client_id: '123456' } });
  const acts = d.activities();
  assert.equal(acts.length, 1);
  assert.equal(acts[0].pid, process.pid);
  assert.equal(acts[0].activity.type, 3);
  assert.equal(acts[0].activity.details, '和朋友一起看片');
  assert.ok(statuses.includes('ready'));
});

test('限频：连着改三次只发第一次和合并后的最后一次', async (t) => {
  const d = fakeDiscord(t);
  await d.listening;
  const p = new DiscordPresence({ clientId: '1', pipePath: d.pipe, minIntervalMs: 250 });
  t.after(() => p.destroy());
  p.setActivity(ACT('一'));
  await sleep(80);
  p.setActivity(ACT('二'));
  p.setActivity(ACT('三'));
  await sleep(60);
  assert.deepEqual(d.activities().map((a) => a.activity.details), ['一'], '间隔内不该再发');
  await sleep(300);
  assert.deepEqual(d.activities().map((a) => a.activity.details), ['一', '三']);
  // 内容没变不重发
  p.setActivity(ACT('三'));
  await sleep(300);
  assert.equal(d.activities().length, 2);
});

test('clear 发一条不带 activity 的 SET_ACTIVITY；disconnect 直接断开（Discord 自己会清）', async (t) => {
  const d = fakeDiscord(t);
  await d.listening;
  const p = new DiscordPresence({ clientId: '1', pipePath: d.pipe, minIntervalMs: 20 });
  t.after(() => p.destroy());
  p.setActivity(ACT('一'));
  await sleep(80);
  p.clear();
  await sleep(80);
  const acts = d.activities();
  assert.equal(acts.length, 2);
  assert.equal('activity' in acts[1], false);
  p.disconnect();
  await sleep(50);
  assert.equal(d.connections(), 0);
  // 断开后还能再用（页面刷新后进下一个房间）
  p.setActivity(ACT('二'));
  await sleep(100);
  assert.equal(d.activities().at(-1).activity.details, '二');
});

test('Discord 重启：连接断了会重连，并把该显示的补发一遍', async (t) => {
  const d = fakeDiscord(t);
  await d.listening;
  const p = new DiscordPresence({ clientId: '1', pipePath: d.pipe, minIntervalMs: 20, retryMs: 60 });
  t.after(() => p.destroy());
  p.setActivity(ACT('一'));
  await sleep(80);
  d.kick();
  await sleep(250);
  const acts = d.activities();
  assert.equal(acts.length, 2, '重连后要补发');
  assert.equal(acts[1].activity.details, '一');
});

test('懒连接：构造时不碰管道；没配置应用 ID 就整个不工作', async (t) => {
  const d = fakeDiscord(t);
  await d.listening;
  const p = new DiscordPresence({ clientId: '1', pipePath: d.pipe });
  t.after(() => p.destroy());
  await sleep(60);
  assert.equal(d.connections(), 0, '还没有状态要显示就去连了');
  const none = new DiscordPresence({ clientId: '', pipePath: d.pipe });
  none.setActivity(ACT('一'));
  await sleep(60);
  assert.equal(d.connections(), 0);
  assert.equal(none.status, 'unconfigured');
});

test('没开 Discord：报 unavailable，隔一阵重试；撤掉状态后不再重试', async (t) => {
  const p = new DiscordPresence({ clientId: '1', pipePath: pipeName(), retryMs: 50 });
  t.after(() => p.destroy());
  const statuses = [];
  p.onStatus = (s) => statuses.push(s);
  p.setActivity(ACT('一'));
  await sleep(120);
  assert.ok(statuses.includes('unavailable'));
  assert.ok(p.retryTimer, '有状态要显示时要安排重试');
  p.clear();
  assert.equal(p.retryTimer, null, '撤掉状态后还在重试');
});

test('主进程校验：按钮只放行我们自己的 https 链接，长度和数量按 Discord 的规矩截', () => {
  const room = 'https://felis-desuwa.github.io/NoxReel/#j/Rabc/';
  const a = sanitizeActivity({
    details: '在看《某部电影》'.repeat(30),
    state: 'x',
    startMs: 1_750_000_000_000,
    endMs: 1_750_000_600_000,
    partyId: 'p1',
    partySize: [3, 8],
    buttons: [
      { label: '加入放映'.repeat(10), url: room },
      { label: '坏的', url: 'http://felis-desuwa.github.io/NoxReel/' },
      { label: '别家', url: 'https://evil.example/' },
      { label: '脚本', url: 'javascript:alert(1)' },
    ],
  });
  assert.equal(a.type, 3);
  assert.equal(Array.from(a.details).length, 128);
  assert.equal('state' in a, false, 'Discord 要求至少 2 个字符');
  assert.deepEqual(a.timestamps, { start: 1_750_000_000_000, end: 1_750_000_600_000 });
  assert.deepEqual(a.party, { id: 'p1', size: [3, 8] });
  assert.equal(a.buttons.length, 1);
  assert.equal(Array.from(a.buttons[0].label).length, 32);
  assert.equal(a.buttons[0].url, room);
  assert.deepEqual(a.assets, { large_image: 'noxreel', large_text: 'NoxReel' });

  const b = sanitizeActivity({ details: 'ok', partySize: [9, 3], partyId: 'p', startMs: 12, buttons: 'x' });
  assert.equal('party' in b, false, '人数比上限还多');
  assert.equal('timestamps' in b, false);
  assert.equal('buttons' in b, false);
  assert.equal(sanitizeActivity(null), null);
  assert.equal(sanitizeActivity([1]), null);
});

test('main.js：懒连接、退房和退出都断开、IPC 内容先过 sanitizeActivity', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(main, /const DEV_DISCORD_PIPE = DEV_HOOKS \? process\.env\.NOXREEL_DISCORD_PIPE \|\| null : null;/, '假管道只在开发钩子打开时生效');
  // 发布版必须带着真的应用 ID，空着的话状态显示整个不工作（设置里只会写「没有配置」）
  assert.match(main, /const DISCORD_CLIENT_ID = \(DEV_HOOKS && process\.env\.NOXREEL_DISCORD_CLIENT_ID\) \|\| '\d{17,20}';/);
  const reclaim = main.slice(main.indexOf('function reclaimAfterRendererGone('), main.indexOf('function send('));
  assert.match(reclaim, /discordPresence\.disconnect\(\);/, '退房（刷新页面）要撤掉 Discord 状态');
  const cleanup = main.slice(main.indexOf('async function cleanup('));
  assert.match(cleanup.slice(0, 600), /discordPresence\.destroy\(\);/, '退出时要断开，且放在前面');
  const set = main.slice(main.indexOf("secureHandle('discord:setActivity'"), main.indexOf("secureHandle('discord:clear'"));
  assert.match(set, /sanitizeActivity\(validate\.plainObject\(payload, 'Discord 状态'\)\)/);
  const preload = fs.readFileSync(path.join(__dirname, '../src/main/preload.js'), 'utf8');
  assert.match(preload, /setActivity: \(activity\) => ipcRenderer\.invoke\('discord:setActivity', activity\)/);
});

/* ------------------------------ 渲染进程 ------------------------------ */

const UI = '../src/renderer/ui/discordPresence.js';
const ROOM = 'https://felis-desuwa.github.io/NoxReel/#j/Rabc/';
const base = (o = {}) => ({
  title: 'Some.Movie.2019.mkv',
  paused: false,
  started: true,
  position: 60,
  duration: 600,
  members: 3,
  capacity: 8,
  roomLink: ROOM,
  partyId: 'party1',
  now: 1_750_000_100_000,
  ...o,
});

test('默认值：总开关关着就什么也不显示；打开后默认不带片名', async () => {
  const { buildActivity, PRESENCE_DEFAULTS, loadPresenceSettings } = await import(UI);
  assert.deepEqual(PRESENCE_DEFAULTS, { enabled: false, showTitle: false, showJoin: true });
  assert.equal(buildActivity(base(), PRESENCE_DEFAULTS), null);
  const a = buildActivity(base(), { ...PRESENCE_DEFAULTS, enabled: true });
  assert.equal(a.details, '和朋友一起看片');
  assert.ok(!JSON.stringify(a).includes('Some.Movie'), '没勾「显示片名」却带出了片名');
  // 读不到或读坏了一律当默认（也就是不显示）
  assert.deepEqual(loadPresenceSettings({ getItem: () => '{bad' }), PRESENCE_DEFAULTS);
  assert.deepEqual(loadPresenceSettings({ getItem: () => { throw new Error('denied'); } }), PRESENCE_DEFAULTS);
  assert.deepEqual(loadPresenceSettings(null), { enabled: false, showTitle: false, showJoin: true });
});

test('显示片名：去掉扩展名；播放中带起止时间，暂停和没开播时不带', async () => {
  const { buildActivity } = await import(UI);
  const on = { enabled: true, showTitle: true, showJoin: true };
  const playing = buildActivity(base(), on);
  assert.equal(playing.details, '在看《Some.Movie.2019》');
  assert.equal(playing.state, '房间 3/8 人');
  assert.equal(playing.startMs, 1_750_000_100_000 - 60_000);
  assert.equal(playing.endMs, playing.startMs + 600_000);
  assert.deepEqual(playing.partySize, [3, 8]);

  const paused = buildActivity(base({ paused: true }), on);
  assert.equal(paused.state, '已暂停 · 房间 3/8 人');
  assert.equal('startMs' in paused, false, '暂停时给了时间，Discord 会自己往前走');
  const waiting = buildActivity(base({ started: false, paused: true }), on);
  assert.equal(waiting.state, '等待开播 · 房间 3/8 人');
});

test('「加入放映」按钮：只有房间链接时才有，排第一；另一个是下载', async () => {
  const { buildActivity, RELEASES_URL } = await import(UI);
  const on = { enabled: true, showTitle: false, showJoin: true };
  assert.deepEqual(buildActivity(base(), on).buttons, [
    { label: '加入放映', url: ROOM },
    { label: '下载 NoxReel', url: RELEASES_URL },
  ]);
  assert.deepEqual(buildActivity(base({ roomLink: null }), on).buttons, [{ label: '下载 NoxReel', url: RELEASES_URL }], '一对一邀请只能给一个人，不该挂出来');
  assert.deepEqual(buildActivity(base(), { ...on, showJoin: false }).buttons, [{ label: '下载 NoxReel', url: RELEASES_URL }]);
  // 主进程那道校验也放行这两个链接
  const cleaned = sanitizeActivity(buildActivity(base(), on));
  assert.equal(cleaned.buttons.length, 2);
});

test('比对键：进度按 10 秒粗化，播放中每个 tick 不会都算「变了」', async () => {
  const { buildActivity, activityKey } = await import(UI);
  const on = { enabled: true, showTitle: false, showJoin: true };
  const a = activityKey(buildActivity(base({ position: 60, now: 1_750_000_100_000 }), on));
  const b = activityKey(buildActivity(base({ position: 61, now: 1_750_000_101_000 }), on));
  assert.equal(a, b);
  const seeked = activityKey(buildActivity(base({ position: 300 }), on));
  assert.notEqual(a, seeked, '跳转之后要更新');
  assert.equal(activityKey(null), 'off');
});

test('app.js：房间链接只在中继模式下挂出去；进房前不发清空；设置保存后立即生效', () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(app, /let presenceKey = 'off';/);
  assert.match(app, /roomLink: S\.signalTransport === 'relay' \? S\.roomLink : null,/);
  assert.match(app, /paused: S\.sync\?\.shared\?\.paused !== false,/, '要看全房的暂停，不是游客自己那一路');
  const save = app.slice(app.indexOf("okText: '保存',"));
  assert.match(save, /savePresenceSettings\(S\.discord\);\s*updatePresence\(\);/);
  for (const hook of ['function renderStatus(', 'function renderPeers(', 'function enterRoom(']) {
    const i = app.indexOf(hook);
    const body = app.slice(i, app.indexOf('\n}\n', i));
    assert.match(body, /updatePresence\(\);/, `${hook} 里没有更新 Discord 状态`);
  }
});

test('新文案都有英文', async () => {
  const { translate } = await import('../src/renderer/lib/i18n.js');
  const en = (s) => translate(s, 'en');
  assert.equal(en('在看《Some Movie》'), 'Watching “Some Movie”');
  assert.equal(en('房间 3/8 人'), 'Room 3/8');
  for (const line of [
    '和朋友一起看片', '等待开播', '已暂停', '加入放映', '下载 NoxReel', 'Discord 状态',
    '在 Discord 上显示我在放映', '显示片名', '显示「加入放映」按钮（用房间链接时）',
    '你所有的 Discord 好友都能在你的资料上看到，点「加入放映」就能进房。', '需要电脑上开着 Discord 客户端，网页版不行。',
    '这个版本没有配置 Discord 应用，状态显示用不了', '已连上 Discord', '正在连接 Discord…',
    '没检测到 Discord 客户端（开着 Discord 时会自动连上）', '进入房间后会显示', '没有打开',
  ]) {
    assert.notEqual(en(line), line, line);
  }
  // 按钮文字过了翻译也不能超过 Discord 的 32 字上限
  for (const label of ['加入放映', '下载 NoxReel']) assert.ok(Array.from(en(label)).length <= 32);
});
