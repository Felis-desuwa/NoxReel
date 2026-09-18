'use strict';

// 播放列表（playlist.js）：房主手里那张表的每一种改法。
// 这张表决定「现在放哪部、同步消息属于哪部、先传哪部」，两端逐字节相同，
// 所以桌面端和安卓端各跑一遍；每条改表操作都会先把传入的 state 深冻结，
// 确保纯函数真的没有就地改——房主会把旧 state 留着和新 state 比较、广播差异。
const test = require('node:test');
const assert = require('node:assert/strict');
const { IMPLS } = require('./helpers/impls');

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

const load = (dir) => import(dir + 'playlist.js');

const MB = 1024 * 1024;
const CHUNK = 2 * MB;
const NO_PERMISSION = '你没有编辑播放列表的权限';

const fid = (n) => n.toString(16).padStart(32, '0');

/** 合法的文件条目；改了 size/chunkSize 时 chunkCount 跟着算，除非显式给了。 */
function fileItem(n, over = {}) {
  const item = {
    kind: 'file',
    fileId: fid(n),
    name: `片${n}.mkv`,
    size: 10 * MB + n,
    chunkSize: CHUNK,
    durationSec: 600,
    ...over,
  };
  if (!('chunkCount' in over)) item.chunkCount = Math.ceil(item.size / item.chunkSize);
  return item;
}

const linkItem = (n, over = {}) => ({
  kind: 'link',
  url: `https://example.com/v/${n}`,
  title: `链接${n}`,
  durationSec: 0,
  ...over,
});

/** 房主 ctx。newId 是确定性的计数器（12 位十六进制，和 randomId(6) 同形），派生 ctx 共用计数。 */
function makeCtx(over = {}) {
  let n = 0;
  return {
    actor: 'host',
    actorName: '房主',
    isController: (id) => id === 'host' || id === 'admin',
    newId: () => (++n).toString(16).padStart(12, '0'),
    position: 0,
    ...over,
  };
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/**
 * 执行一条操作并断言没有改动传入的 state。
 * ESM 是严格模式，冻结对象上的任何写入都会直接抛 TypeError，JSON 比较再兜一层。
 */
function run(P, state, op, ctx) {
  const before = JSON.stringify(state);
  deepFreeze(state);
  const res = P.applyOp(state, op, ctx);
  assert.equal(JSON.stringify(state), before, `操作 ${op && op.type} 改动了传入的 state`);
  return res;
}

/** 执行并断言成功，返回新 state。 */
function ok(P, state, op, ctx) {
  const res = run(P, state, op, ctx);
  assert.equal(res.ok, true, `操作 ${op && op.type} 失败：${res.reason}`);
  return res.state;
}

/** 执行并断言失败、原样返回同一个 state 对象。 */
function rejected(P, state, op, ctx, reason) {
  const res = run(P, state, op, ctx);
  assert.equal(res.ok, false, `操作 ${op && op.type} 本该被拒绝`);
  assert.equal(res.state, state, '被拒绝时必须原样返回传入的 state');
  if (reason !== undefined) assert.equal(res.reason, reason);
  return res;
}

/** 断言「没有变化」：ok、unchanged、同一个对象。 */
function unchanged(P, state, op, ctx) {
  const res = run(P, state, op, ctx);
  assert.equal(res.ok, true);
  assert.equal(res.unchanged, true, `操作 ${op && op.type} 本该返回 unchanged`);
  assert.equal(res.state, state, '没有变化时必须原样返回同一个对象，调用方靠引用相等跳过广播');
  return res;
}

function build(P, ctx, items, state = P.createPlaylist()) {
  for (const item of items) state = ok(P, state, { type: 'add', item }, ctx);
  return state;
}

const ids = (list) => list.map((it) => it.id);
/** 模拟走一趟网络：快照、分段都是 JSON。 */
const roundTrip = (s) => JSON.parse(JSON.stringify(s));

/* ------------------------------ createPlaylist ------------------------------ */

impl('createPlaylist 的默认值，且每次都是独立的新对象', async (dir) => {
  const P = await load(dir);
  const a = P.createPlaylist();
  assert.deepEqual(a, { rev: 0, seq: 0, queue: [], history: [], started: false, autoplay: true, nextSlot: 1 });
  // 两个房间如果共用同一个默认对象，一边加片另一边也会冒出来
  const b = P.createPlaylist();
  a.queue.push('x');
  assert.equal(b.queue.length, 0);
  assert.notEqual(a.history, b.history);
  // 槽位 0 留着不用：nextSlot 从 1 起
  assert.equal(P.createPlaylist().nextSlot, 1);
  assert.equal(P.currentItem(P.createPlaylist()), null);
  assert.equal(P.currentItem(null), null);
  assert.equal(P.currentItem(undefined), null);
});

/* ------------------------------ add ------------------------------ */

impl('add 文件：规范化字段，丢掉调用方夹带的字段', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  const longName = '  ' + '长'.repeat(250);
  const res = run(
    P,
    P.createPlaylist(),
    {
      type: 'add',
      item: {
        ...fileItem(1, { name: longName }),
        // 这些字段只能由房主生成，调用方塞进来的必须被无视
        id: 'ffffffffffff',
        slot: 99,
        addedBy: 'mallory',
        sourceGone: true,
        resumeAt: 50,
        evil: 1,
      },
    },
    ctx,
  );
  assert.equal(res.ok, true);
  const s = res.state;
  assert.equal(s.queue.length, 1);
  const it = s.queue[0];
  assert.equal(res.id, it.id);
  assert.equal(it.id, '000000000001');
  // 先截 200 再去空白：两个前导空格占了截断额度
  assert.equal(it.name, '长'.repeat(198));
  assert.equal(it.name.length <= P.MAX_NAME, true);
  assert.deepEqual(it, {
    id: '000000000001',
    kind: 'file',
    fileId: fid(1),
    name: '长'.repeat(198),
    size: 10 * MB + 1,
    chunkSize: CHUNK,
    chunkCount: 6,
    durationSec: 600,
    slot: 1,
    addedBy: 'host',
    addedByName: '房主',
    sourceId: 'host',
    sourceGone: false,
    resumeAt: 0,
  });
  assert.equal(s.rev, 1);
  assert.equal(s.nextSlot, 2);

  // 名字正好 200 字不截
  const exact = ok(P, P.createPlaylist(), { type: 'add', item: fileItem(2, { name: '名'.repeat(200) }) }, ctx);
  assert.equal(exact.queue[0].name, '名'.repeat(200));
});

impl('add 文件：时长不合法一律记 0', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  for (const durationSec of [NaN, -1, 0, 86401, Infinity, 'abc', null, undefined]) {
    const s = ok(P, P.createPlaylist(), { type: 'add', item: fileItem(1, { durationSec }) }, ctx);
    assert.equal(s.queue[0].durationSec, 0, `durationSec=${String(durationSec)}`);
  }
  const s = ok(P, P.createPlaylist(), { type: 'add', item: fileItem(1, { durationSec: 86400 }) }, ctx);
  assert.equal(s.queue[0].durationSec, 86400);
});

impl('add 文件：清单形状不对（片数、大小、fileId、名字）直接拒绝', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  const base = P.createPlaylist();
  const bad = [
    // 片数必须正好是 ceil(size/chunkSize)，否则接收方会按错误的片数建位图
    fileItem(1, { chunkCount: 0 }),
    fileItem(1, { chunkCount: 7 }),
    fileItem(1, { chunkCount: 5 }),
    fileItem(1, { chunkCount: 5.5 }),
    fileItem(1, { chunkCount: '6' }),
    fileItem(1, { chunkCount: -6 }),
    fileItem(1, { chunkCount: NaN }),
    fileItem(1, { size: 0, chunkCount: 0 }),
    fileItem(1, { size: 1.5, chunkCount: 1 }),
    fileItem(1, { chunkSize: 0, chunkCount: 1 }),
    fileItem(1, { size: Number.MAX_SAFE_INTEGER + 1, chunkCount: 1 }),
    fileItem(1, { fileId: 'A'.repeat(32) }),
    fileItem(1, { fileId: 'a'.repeat(31) }),
    fileItem(1, { fileId: 'a'.repeat(33) }),
    fileItem(1, { fileId: 'g'.repeat(32) }),
    fileItem(1, { fileId: undefined }),
    fileItem(1, { name: '   ' }),
    fileItem(1, { name: '' }),
    fileItem(1, { name: 42 }),
    { ...fileItem(1), kind: 'dvd' },
    null,
    undefined,
    'file',
  ];
  for (const item of bad) {
    rejected(P, base, { type: 'add', item }, ctx, '无效的列表条目');
  }
  rejected(P, base, { type: 'add' }, ctx, '无效的列表条目');
});

impl('add 链接：地址规范化，标题截断，不占槽位也没有片源', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  const res = run(
    P,
    P.createPlaylist(),
    {
      type: 'add',
      item: { kind: 'link', url: 'HTTPS://Example.COM/a b?x=1', title: ' ' + '题'.repeat(300), durationSec: 90 },
      sourceId: 'someone',
    },
    ctx,
  );
  assert.equal(res.ok, true);
  const s = res.state;
  const it = s.queue[0];
  assert.deepEqual(it, {
    id: res.id,
    kind: 'link',
    url: 'https://example.com/a%20b?x=1',
    title: '题'.repeat(199),
    durationSec: 90,
    addedBy: 'host',
    addedByName: '房主',
    // 链接谁都不用供片，传了 sourceId 也不认
    sourceId: '',
    sourceGone: false,
    resumeAt: 0,
  });
  assert.equal('slot' in it, false);
  assert.equal(s.nextSlot, 1, '链接不能占用文件槽位');
  assert.equal(s.seq, 1);

  // 没标题也行
  const untitled = ok(P, P.createPlaylist(), { type: 'add', item: { kind: 'link', url: 'http://a.example/x' } }, ctx);
  assert.equal(untitled.queue[0].title, '');
});

impl('add 链接：只收 http/https，长度不超过 2048（规范化之后也算）', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  const base = P.createPlaylist();
  for (const url of [
    'javascript:alert(1)',
    'ftp://example.com/a.mp4',
    'file:///C:/a.mp4',
    'data:text/html,hi',
    'about:blank',
    'not a url',
    '',
    42,
    null,
    undefined,
  ]) {
    rejected(P, base, { type: 'add', item: linkItem(1, { url }) }, ctx, '无效的列表条目');
  }
  const prefix = 'https://example.com/';
  const exact = prefix + 'a'.repeat(P.MAX_URL - prefix.length);
  assert.equal(exact.length, 2048);
  const s = ok(P, base, { type: 'add', item: linkItem(1, { url: exact }) }, ctx);
  assert.equal(s.queue[0].url, exact);
  rejected(P, base, { type: 'add', item: linkItem(1, { url: exact + 'a' }) }, ctx, '无效的列表条目');
  // 原文不到 2048，但空格转义成 %20 之后超了：存进表里的是规范化后的地址，必须按它算
  const spaced = prefix + 'a b'.repeat(600);
  assert.ok(spaced.length < 2048);
  rejected(P, base, { type: 'add', item: linkItem(1, { url: spaced }) }, ctx, '无效的列表条目');
});

impl('非控制者的任何操作都被拒绝，并原样返回传入的 state', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  let s = build(P, ctx, [fileItem(1), fileItem(2)]);
  s = ok(P, s, { type: 'ended', seq: s.seq }, ctx);
  // s：queue [2]，history [1]
  const guest = { ...ctx, actor: 'guest', actorName: '游客' };
  const seen = [];
  const spy = { ...guest, isController: (id) => (seen.push(id), false) };
  const ops = [
    { type: 'add', item: fileItem(3) },
    { type: 'move', id: s.queue[0].id, beforeId: null },
    { type: 'remove', id: s.queue[0].id },
    { type: 'playNow', id: s.history[0].id },
    { type: 'requeue', id: s.history[0].id },
    { type: 'ended', seq: s.seq },
    { type: 'forceStart', seq: s.seq },
    { type: 'setAutoplay', on: false },
  ];
  for (const op of ops) {
    rejected(P, s, op, guest, NO_PERMISSION);
    rejected(P, s, op, spy, NO_PERMISSION);
  }
  // 权限是按「这条操作是谁发的」判断的，不是按本机身份
  assert.ok(seen.length === ops.length && seen.every((id) => id === 'guest'), `isController 收到 ${seen}`);
  // ctx 缺 isController 时宁可拒绝也不能放行
  rejected(P, s, { type: 'add', item: fileItem(3) }, { ...ctx, isController: undefined }, NO_PERMISSION);
  rejected(P, s, { type: 'add', item: fileItem(3) }, undefined, NO_PERMISSION);
  // 管理员不是房主，但也是控制者
  const admin = { ...ctx, actor: 'admin', actorName: '管理员' };
  const s2 = ok(P, s, { type: 'add', item: fileItem(3) }, admin);
  assert.equal(s2.queue[1].addedBy, 'admin');
  assert.equal(s2.queue[1].sourceId, 'admin');
});

impl('队列满 100 项时 add / requeue / 从已播放区 playNow 都被拒绝', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  let s = build(P, ctx, [fileItem(1000)]);
  s = ok(P, s, { type: 'ended', seq: s.seq }, ctx);
  const old = s.history[0];
  const items = [];
  for (let i = 1; i <= 100; i++) items.push(i % 2 ? fileItem(i) : linkItem(i));
  s = build(P, ctx, items, s);
  assert.equal(s.queue.length, P.MAX_QUEUE);
  rejected(P, s, { type: 'add', item: fileItem(101) }, ctx, '列表最多 100 项');
  rejected(P, s, { type: 'add', item: linkItem(101) }, ctx, '列表最多 100 项');
  rejected(P, s, { type: 'requeue', id: old.id }, ctx, '列表最多 100 项');
  rejected(P, s, { type: 'playNow', id: old.id }, ctx, '列表最多 100 项');
  // 队列里的项 playNow 只是换位置，不增加条数，满了也照样可以
  const s2 = ok(P, s, { type: 'playNow', id: s.queue[99].id }, ctx);
  assert.equal(s2.queue.length, 100);
  // 满载快照本身仍然合法
  assert.ok(P.validateSnapshot(JSON.parse(JSON.stringify(s))));
});

impl('队列里已有同一 fileId / 同一链接时拒绝重复添加', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  const s = build(P, ctx, [fileItem(1), linkItem(1)]);
  // 同一部片换个名字、换个人加，也还是同一部片
  rejected(P, s, { type: 'add', item: fileItem(1, { name: '另一个名字.mkv' }) }, { ...ctx, actor: 'admin' }, '列表里已经有这部片了');
  // 链接按规范化之后的地址比较
  rejected(P, s, { type: 'add', item: linkItem(1, { url: 'HTTPS://EXAMPLE.com/v/1' }) }, ctx, '列表里已经有这个链接了');
  rejected(P, s, { type: 'add', item: linkItem(1, { title: '换个标题' }) }, ctx, '列表里已经有这个链接了');
  // 不同的片、不同的链接照常加
  const s2 = ok(P, s, { type: 'add', item: fileItem(2) }, ctx);
  const s3 = ok(P, s2, { type: 'add', item: linkItem(2) }, ctx);
  assert.equal(s3.queue.length, 4);
});

impl('队列从空变为非空时 seq+1 且 started 清零；后续添加不动 seq', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  const empty = P.createPlaylist();
  const s1 = ok(P, empty, { type: 'add', item: fileItem(1) }, ctx);
  assert.equal(s1.seq, 1);
  assert.equal(s1.started, false);
  const started = P.markStarted(s1, 1);
  assert.equal(started.started, true);
  // 往后排加片不影响当前项，seq 和开播标志都不能动，否则正在放的片的同步消息会被当成过期
  const s2 = ok(P, started, { type: 'add', item: fileItem(2) }, ctx);
  assert.equal(s2.seq, 1);
  assert.equal(s2.started, true);
  assert.equal(s2.rev, started.rev + 1);
  // 即使传进来的 started 是脏的，空队列加第一项也必须清零
  const dirty = { ...P.createPlaylist(), started: true, seq: 7 };
  const s3 = ok(P, dirty, { type: 'add', item: linkItem(1) }, ctx);
  assert.equal(s3.seq, 8);
  assert.equal(s3.started, false);
});

impl('槽位单调递增，删掉的片再加回来换新槽位；已播放区里的同一部片复用槽位并移出已播放区', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  let s = build(P, ctx, [fileItem(1), linkItem(1), fileItem(2)]);
  assert.deepEqual(
    s.queue.map((it) => it.slot),
    [1, undefined, 2],
  );
  assert.equal(s.nextSlot, 3);
  // 删掉再加：对端可能还留着旧槽位的在途请求，复用旧号会把旧分片写到新会话里
  const b = s.queue[2];
  s = ok(P, s, { type: 'remove', id: b.id }, ctx);
  s = ok(P, s, { type: 'add', item: fileItem(3) }, ctx);
  assert.equal(s.queue[2].slot, 3);
  s = ok(P, s, { type: 'add', item: fileItem(2) }, ctx);
  assert.equal(s.queue[3].slot, 4);
  assert.equal(s.nextSlot, 5);

  // 放完第一部进已播放区，再加回来：会话还在，复用槽位才能接着用已收的分片
  const a = s.queue[0];
  s = ok(P, s, { type: 'ended', seq: s.seq }, ctx);
  assert.deepEqual(ids(s.history), [a.id]);
  const before = s;
  s = ok(P, s, { type: 'add', item: fileItem(1, { name: '重新加的.mkv' }) }, ctx);
  const re = s.queue[s.queue.length - 1];
  assert.equal(re.slot, a.slot);
  assert.notEqual(re.id, a.id);
  assert.equal(re.name, '重新加的.mkv');
  assert.equal(s.nextSlot, before.nextSlot, '复用槽位不能再消耗新号');
  assert.equal(s.history.length, 0, '同一部片不能同时出现在队列和已播放区');
  assert.equal(s.queue.filter((it) => it.fileId === fid(1)).length, 1);
  assert.ok(P.validateSnapshot(JSON.parse(JSON.stringify(s))));
});

impl('sourceId 缺省为操作者，不合法的 sourceId 也回落到操作者；addedByName 截断 40', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx({ actorName: '名'.repeat(50) });
  const base = P.createPlaylist();
  const s = ok(P, base, { type: 'add', item: fileItem(1) }, ctx);
  assert.equal(s.queue[0].sourceId, 'host');
  assert.equal(s.queue[0].addedByName, '名'.repeat(40));
  // 房主替别人登记片子：片源是那个人
  const other = ok(P, base, { type: 'add', item: fileItem(1), sourceId: 'peer_A-1' }, ctx);
  assert.equal(other.queue[0].sourceId, 'peer_A-1');
  assert.equal(other.queue[0].addedBy, 'host');
  // peerId 是聊天安全版 base64，里面本来就有 . 和 -（真实的房主 id 形如 .aD14UqgpFw）
  const dotted = ok(P, base, { type: 'add', item: fileItem(1), sourceId: '.aD14Uq-gpFw' }, ctx);
  assert.equal(dotted.queue[0].sourceId, '.aD14Uq-gpFw');
  for (const sourceId of ['有 空格', 'a'.repeat(129), '', null, 'a/b', ['host2'], 42]) {
    const r = ok(P, base, { type: 'add', item: fileItem(1), sourceId }, ctx);
    assert.equal(r.queue[0].sourceId, 'host', `sourceId=${String(sourceId)}`);
  }
  const noName = ok(P, base, { type: 'add', item: fileItem(1) }, { ...ctx, actorName: undefined });
  assert.equal(noName.queue[0].addedByName, '');
});

/* ------------------------------ move ------------------------------ */

impl('move：未开播时把第二项拖到第一位，seq+1、rev+1', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  const s = build(P, ctx, [fileItem(1), fileItem(2), fileItem(3)]);
  const [A, B, C] = s.queue;
  const res = run(P, s, { type: 'move', id: B.id, beforeId: A.id }, ctx);
  assert.equal(res.ok, true);
  assert.deepEqual(ids(res.state.queue), [B.id, A.id, C.id]);
  assert.equal(res.state.seq, s.seq + 1);
  assert.equal(res.state.rev, s.rev + 1);
  assert.equal(res.state.started, false);
  // 把当前项拖到末尾同样是换当前项
  const res2 = run(P, s, { type: 'move', id: A.id, beforeId: null }, ctx);
  assert.deepEqual(ids(res2.state.queue), [B.id, C.id, A.id]);
  assert.equal(res2.state.seq, s.seq + 1);
  // beforeId 省略等于放到末尾
  const res3 = run(P, s, { type: 'move', id: A.id }, ctx);
  assert.deepEqual(ids(res3.state.queue), [B.id, C.id, A.id]);
});

impl('move：开播后改变当前项需要确认，state 原样返回', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  const s = P.markStarted(build(P, ctx, [fileItem(1), fileItem(2), fileItem(3)]), 1);
  assert.equal(s.started, true);
  const [A, B, C] = s.queue;
  // 一次误拖就把正在放的片换掉是不可接受的，必须走 playNow 并确认
  rejected(P, s, { type: 'move', id: B.id, beforeId: A.id }, ctx, 'needs-confirm');
  rejected(P, s, { type: 'move', id: C.id, beforeId: A.id }, ctx, 'needs-confirm');
  rejected(P, s, { type: 'move', id: A.id, beforeId: null }, ctx, 'needs-confirm');
  rejected(P, s, { type: 'move', id: A.id, beforeId: C.id }, ctx, 'needs-confirm');
});

impl('move：开播后在非当前项之间调序正常，当前项留在原位不算变化', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  const s = P.markStarted(build(P, ctx, [fileItem(1), fileItem(2), fileItem(3), linkItem(4)]), 1);
  const [A, B, C, D] = s.queue;
  const moved = ok(P, s, { type: 'move', id: D.id, beforeId: B.id }, ctx);
  assert.deepEqual(ids(moved.queue), [A.id, D.id, B.id, C.id]);
  assert.equal(moved.seq, s.seq, '当前项没变，seq 不能动');
  assert.equal(moved.started, true, '当前项没变，开播标志不能丢');
  assert.equal(moved.rev, s.rev + 1);
  const moved2 = ok(P, moved, { type: 'move', id: D.id, beforeId: null }, ctx);
  assert.deepEqual(ids(moved2.queue), [A.id, B.id, C.id, D.id]);
  // 把当前项「拖回」自己原来的位置：结果不变，不需要确认
  unchanged(P, s, { type: 'move', id: A.id, beforeId: B.id }, ctx);
});

impl('move：id 或 beforeId 不在队列里时拒绝', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  let s = build(P, ctx, [fileItem(1), fileItem(2), fileItem(3)]);
  s = ok(P, s, { type: 'ended', seq: s.seq }, ctx);
  const h = s.history[0];
  const [B, C] = s.queue;
  rejected(P, s, { type: 'move', id: B.id, beforeId: 'abcdefabcdef' }, ctx, '列表里没有目标位置');
  // 已播放区的条目不是队列里的位置
  rejected(P, s, { type: 'move', id: C.id, beforeId: h.id }, ctx, '列表里没有目标位置');
  rejected(P, s, { type: 'move', id: 'abcdefabcdef', beforeId: null }, ctx, '列表里没有这一项');
  rejected(P, s, { type: 'move', id: h.id, beforeId: null }, ctx, '列表里没有这一项');
  rejected(P, P.createPlaylist(), { type: 'move', id: B.id, beforeId: null }, ctx, '列表里没有这一项');
});

impl('move：位置没变时返回 unchanged，rev 不涨', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  const s = build(P, ctx, [fileItem(1), fileItem(2), fileItem(3)]);
  const [A, B, C] = s.queue;
  unchanged(P, s, { type: 'move', id: C.id, beforeId: null }, ctx);
  unchanged(P, s, { type: 'move', id: B.id, beforeId: C.id }, ctx);
  unchanged(P, s, { type: 'move', id: A.id, beforeId: B.id }, ctx);
  const single = build(P, ctx, [fileItem(9)]);
  unchanged(P, single, { type: 'move', id: single.queue[0].id, beforeId: null }, ctx);
});

/* ------------------------------ remove ------------------------------ */

impl('remove：删当前项等于推进，seq+1、started 清零；删别的项不动 seq', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  const s = P.markStarted(build(P, ctx, [fileItem(1), fileItem(2), fileItem(3)]), 1);
  const [A, B, C] = s.queue;
  const r1 = ok(P, s, { type: 'remove', id: A.id }, ctx);
  assert.deepEqual(ids(r1.queue), [B.id, C.id]);
  assert.equal(r1.seq, s.seq + 1);
  assert.equal(r1.started, false);
  assert.equal(r1.rev, s.rev + 1);
  assert.equal(r1.history.length, 0, '删除不是播完，不进已播放区');

  const r2 = ok(P, s, { type: 'remove', id: C.id }, ctx);
  assert.deepEqual(ids(r2.queue), [A.id, B.id]);
  assert.equal(r2.seq, s.seq);
  assert.equal(r2.started, true);
  assert.equal(r2.rev, s.rev + 1);

  // 删掉最后一项：空表也要换 seq，旧片的迟到消息不能再生效
  const one = build(P, ctx, [fileItem(9)]);
  const r3 = ok(P, one, { type: 'remove', id: one.queue[0].id }, ctx);
  assert.equal(r3.queue.length, 0);
  assert.equal(r3.seq, one.seq + 1);
  assert.equal(P.currentItem(r3), null);
});

impl('remove：删已播放区条目，引用随之消失；找不到时拒绝', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  let s = build(P, ctx, [fileItem(1), fileItem(2)]);
  s = ok(P, s, { type: 'ended', seq: s.seq }, ctx);
  const h = s.history[0];
  assert.ok(P.referencedFileIds(s).has(fid(1)));
  const r = ok(P, s, { type: 'remove', id: h.id }, ctx);
  assert.equal(r.history.length, 0);
  assert.deepEqual(r.queue, s.queue);
  assert.equal(r.seq, s.seq);
  assert.equal(r.rev, s.rev + 1);
  // 不再被引用的会话才可以关掉
  assert.equal(P.referencedFileIds(r).has(fid(1)), false);
  assert.equal(P.findItem(r, h.id), null);
  rejected(P, r, { type: 'remove', id: h.id }, ctx, '列表里没有这一项');
  rejected(P, r, { type: 'remove' }, ctx, '列表里没有这一项');
});

/* ------------------------------ playNow ------------------------------ */

impl('playNow：未开播时直接换到最前，不记 resumeAt', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx({ position: 120 });
  const s = build(P, ctx, [fileItem(1), fileItem(2), fileItem(3)]);
  const [A, B, C] = s.queue;
  const r = ok(P, s, { type: 'playNow', id: C.id }, ctx);
  assert.deepEqual(ids(r.queue), [C.id, A.id, B.id]);
  assert.equal(r.seq, s.seq + 1);
  assert.equal(r.rev, s.rev + 1);
  assert.equal(r.started, false);
  // 还没开始放，没有「播到哪」可言
  assert.equal(r.queue[1].resumeAt, 0);
});

impl('playNow：开播后原当前项退到第二位并记下播放位置', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx({ position: 123.5 });
  const s = P.markStarted(build(P, ctx, [fileItem(1), fileItem(2), fileItem(3)]), 1);
  const [A, B, C] = s.queue;
  const r = ok(P, s, { type: 'playNow', id: C.id }, ctx);
  assert.deepEqual(ids(r.queue), [C.id, A.id, B.id]);
  assert.equal(r.queue[1].resumeAt, 123.5);
  assert.equal(r.queue[2].resumeAt, 0);
  assert.equal(r.seq, s.seq + 1);
  assert.equal(r.started, false, '新当前项还没开播');
  // 原条目对象不能被改（旧 state 可能还在界面上渲染）
  assert.equal(A.resumeAt, 0);

  // 超过一天的位置钳到上限；拿不到有效位置时保留原来记的值
  const big = ok(P, s, { type: 'playNow', id: B.id }, { ...ctx, position: 999999 });
  assert.equal(big.queue[1].resumeAt, 86400);
  for (const position of [0, -5, NaN, undefined, 'abc']) {
    const r2 = ok(P, s, { type: 'playNow', id: B.id }, { ...ctx, position });
    assert.equal(r2.queue[1].resumeAt, 0, `position=${String(position)}`);
  }
  // A 已经记过 123.5：再被顶下去但拿不到位置，不能把记过的进度抹掉
  const back = P.markStarted(ok(P, r, { type: 'playNow', id: A.id }, { ...ctx, position: 10 }), r.seq + 1);
  assert.equal(back.queue[0].id, A.id);
  const again = ok(P, back, { type: 'playNow', id: B.id }, { ...ctx, position: undefined });
  assert.equal(again.queue[1].id, A.id);
  assert.equal(again.queue[1].resumeAt, 123.5);
});

impl('playNow：从已播放区拿回来放，保留槽位', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx({ position: 42 });
  let s = build(P, ctx, [fileItem(1), fileItem(2)]);
  s = ok(P, s, { type: 'ended', seq: s.seq }, ctx);
  s = P.markStarted(s, s.seq);
  const X = s.history[0];
  const B = s.queue[0];
  const r = ok(P, s, { type: 'playNow', id: X.id }, ctx);
  assert.deepEqual(ids(r.queue), [X.id, B.id]);
  assert.equal(r.queue[0].slot, X.slot);
  assert.equal(r.history.length, 0);
  assert.equal(r.queue[1].resumeAt, 42);
  assert.equal(r.seq, s.seq + 1);

  // 队列空着时从已播放区 playNow
  let e = build(P, ctx, [fileItem(5)]);
  e = ok(P, e, { type: 'ended', seq: e.seq }, ctx);
  const r2 = ok(P, e, { type: 'playNow', id: e.history[0].id }, ctx);
  assert.equal(r2.queue.length, 1);
  assert.equal(r2.queue[0].resumeAt, 0);
  assert.equal(r2.seq, e.seq + 1);
});

impl('playNow：已经是当前项时 unchanged；找不到时拒绝', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx({ position: 30 });
  const s = P.markStarted(build(P, ctx, [fileItem(1), fileItem(2)]), 1);
  // 重复点「立即播放」不能把正在放的片从头再来
  const res = unchanged(P, s, { type: 'playNow', id: s.queue[0].id }, ctx);
  assert.equal(res.state.seq, s.seq);
  rejected(P, s, { type: 'playNow', id: 'abcdefabcdef' }, ctx, '列表里没有这一项');
});

/* ------------------------------ requeue ------------------------------ */

impl('requeue：已播放区条目排回队尾，resumeAt 清零；队列空时成为当前项', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  let s = build(P, ctx, [fileItem(1), fileItem(2)]);
  s = ok(P, s, { type: 'ended', seq: s.seq }, ctx);
  const X = s.history[0];
  const B = s.queue[0];
  const r = ok(P, s, { type: 'requeue', id: X.id }, ctx);
  assert.deepEqual(ids(r.queue), [B.id, X.id]);
  assert.equal(r.queue[1].slot, X.slot);
  assert.equal(r.queue[1].resumeAt, 0);
  assert.equal(r.history.length, 0);
  assert.equal(r.seq, s.seq, '当前项没变');
  assert.equal(r.rev, s.rev + 1);
  // 队列里的项不是 requeue 的对象
  rejected(P, r, { type: 'requeue', id: B.id }, ctx, '已播放区里没有这一项');
  rejected(P, r, { type: 'requeue', id: X.id }, ctx, '已播放区里没有这一项');

  // 队列空时 requeue：它就是新的当前项，seq 要换
  let e = build(P, ctx, [fileItem(3)]);
  e = ok(P, e, { type: 'ended', seq: e.seq }, ctx);
  const r2 = ok(P, e, { type: 'requeue', id: e.history[0].id }, ctx);
  assert.equal(r2.queue.length, 1);
  assert.equal(r2.seq, e.seq + 1);
  assert.equal(r2.started, false);
});

/* ------------------------------ ended ------------------------------ */

impl('ended：seq 对不上（迟到的旧消息）时 unchanged', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  const s = P.markStarted(build(P, ctx, [fileItem(1), fileItem(2)]), 1);
  // 上一部的「放完了」晚到，不能把刚开始的这一部也跳过去
  for (const seq of [s.seq - 1, s.seq + 1, undefined, String(s.seq), null]) {
    const res = unchanged(P, s, { type: 'ended', seq }, ctx);
    assert.equal(res.effects, undefined);
  }
  // 空队列没有可结束的
  const empty = { ...P.createPlaylist(), seq: 3 };
  unchanged(P, empty, { type: 'ended', seq: 3 }, ctx);
});

impl('ended：当前项进已播放区（resumeAt 清零），seq+1，按剩余项给 advanced / finished', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx({ position: 50 });
  let s = P.markStarted(build(P, ctx, [fileItem(1), fileItem(2)]), 1);
  const [A, B] = s.queue;
  // 让 A 带上 resumeAt：B 插播，A 记下 50
  s = ok(P, s, { type: 'playNow', id: B.id }, ctx);
  s = P.markStarted(s, s.seq);
  assert.equal(s.queue[1].resumeAt, 50);

  const r1 = run(P, s, { type: 'ended', seq: s.seq }, ctx);
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.effects, ['advanced']);
  assert.deepEqual(ids(r1.state.queue), [A.id]);
  assert.deepEqual(ids(r1.state.history), [B.id]);
  assert.equal(r1.state.seq, s.seq + 1);
  assert.equal(r1.state.started, false);
  assert.equal(r1.state.rev, s.rev + 1);
  // A 还在队列里，接着放的进度要保住
  assert.equal(r1.state.queue[0].resumeAt, 50);

  const s2 = P.markStarted(r1.state, r1.state.seq);
  const r2 = run(P, s2, { type: 'ended', seq: s2.seq }, ctx);
  assert.deepEqual(r2.effects, ['finished']);
  assert.equal(r2.state.queue.length, 0);
  assert.deepEqual(ids(r2.state.history), [A.id, B.id], '已播放区最新的在前');
  // 放完的片不需要续播位置，重新排回去要从头放
  assert.equal(r2.state.history[0].resumeAt, 0);
  assert.equal(r2.state.history[0].slot, A.slot);
  assert.equal(r2.state.started, false);
  assert.equal(r2.state.seq, s2.seq + 1);
});

impl('ended：已播放区上限 30，淘汰最老的，被淘汰的片不再被引用', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  const items = [];
  for (let i = 1; i <= P.MAX_HISTORY + 1; i++) items.push(i === 2 ? linkItem(i) : fileItem(i));
  let s = build(P, ctx, items);
  const firstId = s.queue[0].id;
  for (let i = 0; i < items.length; i++) {
    const res = run(P, s, { type: 'ended', seq: s.seq }, ctx);
    assert.deepEqual(res.effects, [i === items.length - 1 ? 'finished' : 'advanced']);
    s = res.state;
  }
  assert.equal(s.history.length, P.MAX_HISTORY);
  assert.equal(s.history[0].fileId, fid(31));
  assert.equal(s.history[s.history.length - 1].title, '链接2');
  assert.equal(P.findItem(s, firstId), null);
  assert.equal(P.referencedFileIds(s).has(fid(1)), false);
  assert.equal(
    P.catalogOf(s).some((c) => c.fileId === fid(1)),
    false,
  );
  // 被淘汰后再加回来：旧槽位已不在表里，只能分配新号
  const re = ok(P, s, { type: 'add', item: fileItem(1) }, ctx);
  assert.equal(re.queue[0].slot, s.nextSlot);
  assert.ok(P.validateSnapshot(JSON.parse(JSON.stringify(s))));
});

/* ------------------------------ forceStart / setAutoplay / 其他 ------------------------------ */

impl('forceStart：只对当前这一场给出 start，且不改表', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  const s = build(P, ctx, [fileItem(1)]);
  const res = unchanged(P, s, { type: 'forceStart', seq: s.seq }, ctx);
  assert.deepEqual(res.effects, ['start']);
  assert.equal(res.state.rev, s.rev);
  const stale = unchanged(P, s, { type: 'forceStart', seq: s.seq - 1 }, ctx);
  assert.equal(stale.effects, undefined);
  const empty = { ...P.createPlaylist(), seq: 2 };
  const none = unchanged(P, empty, { type: 'forceStart', seq: 2 }, ctx);
  assert.equal(none.effects, undefined);
});

impl('setAutoplay：非布尔拒绝，没变化 unchanged，切换时 rev+1', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  const s = build(P, ctx, [fileItem(1)]);
  for (const on of ['false', 0, 1, null, undefined]) {
    rejected(P, s, { type: 'setAutoplay', on }, ctx, '无效的操作');
  }
  unchanged(P, s, { type: 'setAutoplay', on: true }, ctx);
  const off = ok(P, s, { type: 'setAutoplay', on: false }, ctx);
  assert.equal(off.autoplay, false);
  assert.equal(off.rev, s.rev + 1);
  assert.equal(off.seq, s.seq);
  assert.deepEqual(off.queue, s.queue);
  unchanged(P, off, { type: 'setAutoplay', on: false }, ctx);
  const on = ok(P, off, { type: 'setAutoplay', on: true }, ctx);
  assert.equal(on.autoplay, true);
});

impl('不认识的操作和畸形操作被拒绝', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  const s = build(P, ctx, [fileItem(1)]);
  rejected(P, s, { type: 'clear' }, ctx, '不认识的操作');
  rejected(P, s, { type: '__proto__' }, ctx, '不认识的操作');
  rejected(P, s, { type: 42 }, ctx, '无效的操作');
  rejected(P, s, {}, ctx, '无效的操作');
  assert.equal(P.applyOp(s, null, ctx).ok, false);
  assert.equal(P.applyOp(s, 'add', ctx).ok, false);
});

impl('findItem 区分队列和已播放区', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  let s = build(P, ctx, [fileItem(1), fileItem(2)]);
  s = ok(P, s, { type: 'ended', seq: s.seq }, ctx);
  const h = s.history[0];
  const q = s.queue[0];
  assert.deepEqual(P.findItem(s, q.id), { where: 'queue', index: 0, item: q });
  assert.deepEqual(P.findItem(s, h.id), { where: 'history', index: 0, item: h });
  assert.equal(P.findItem(s, 'nope'), null);
});

/* ------------------------------ validateSnapshot ------------------------------ */

/** 各种操作都用上的一张表：文件、链接、已播放区、resumeAt、来源离开、关自动播放。 */
function richState(P) {
  const ctx = makeCtx({ position: 77.25 });
  let s = build(P, ctx, [fileItem(1), linkItem(2), fileItem(3), fileItem(4, { name: '中文 片名.mp4' })]);
  s = P.markStarted(s, s.seq);
  s = ok(P, s, { type: 'ended', seq: s.seq }, ctx);
  s = P.markStarted(s, s.seq);
  s = ok(P, s, { type: 'playNow', id: s.queue[2].id }, ctx);
  s = ok(P, s, { type: 'add', item: fileItem(5), sourceId: 'guest-1' }, { ...ctx, actor: 'admin', actorName: '管理员' });
  s = ok(P, s, { type: 'setAutoplay', on: false }, ctx);
  s = P.markSources(s, (id) => id !== 'guest-1');
  s = P.markStarted(s, s.seq);
  return s;
}

impl('validateSnapshot：applyOp 产出的状态经 JSON 往返后得到等价状态', async (dir) => {
  const P = await load(dir);
  const s = richState(P);
  // 确认这张表真的覆盖到了各个字段
  assert.equal(s.started, true);
  assert.equal(s.autoplay, false);
  assert.ok(s.history.length > 0);
  assert.ok(s.queue.some((it) => it.resumeAt > 0));
  assert.ok(s.queue.some((it) => it.sourceGone));
  assert.ok(s.queue.some((it) => it.kind === 'link'));

  const v = P.validateSnapshot(roundTrip(s));
  assert.deepEqual(v, s);
  // 幂等：校验过的再校验一遍还是它
  assert.deepEqual(P.validateSnapshot(roundTrip(v)), v);
  // 空表也能往返
  assert.deepEqual(P.validateSnapshot(roundTrip(P.createPlaylist())), P.createPlaylist());
  // 返回的是新对象，调用方之后改原始数据不会影响它
  const raw = roundTrip(s);
  const v2 = P.validateSnapshot(raw);
  raw.queue[0].name = '被改了';
  raw.queue.length = 0;
  assert.deepEqual(v2, s);
});

impl('validateSnapshot：任何一项不合法，整张拒绝', async (dir) => {
  const P = await load(dir);
  const good = roundTrip(richState(P));
  const fileIdx = good.queue.findIndex((it) => it.kind === 'file');
  const linkIdx = good.queue.findIndex((it) => it.kind === 'link');
  assert.ok(P.validateSnapshot(roundTrip(good)));

  const cases = {
    '队列里文件 fileId 大写': (s) => (s.queue[fileIdx].fileId = s.queue[fileIdx].fileId.toUpperCase().replace(/0/g, 'A')),
    '片数对不上': (s) => (s.queue[fileIdx].chunkCount += 1),
    '名字为空': (s) => (s.queue[fileIdx].name = ' '),
    '缺槽位': (s) => delete s.queue[fileIdx].slot,
    '槽位为负': (s) => (s.queue[fileIdx].slot = -1),
    '槽位是小数': (s) => (s.queue[fileIdx].slot = 1.5),
    '槽位是字符串': (s) => (s.queue[fileIdx].slot = String(s.queue[fileIdx].slot)),
    '链接是 javascript:': (s) => (s.queue[linkIdx].url = 'javascript:alert(1)'),
    '链接超长': (s) => (s.queue[linkIdx].url = 'https://example.com/' + 'a'.repeat(2048)),
    '已播放区条目种类不认识': (s) => (s.history[0].kind = 'torrent'),
    '条目 id 太短': (s) => (s.queue[0].id = 'abcdef1'),
    '条目 id 大写': (s) => (s.queue[0].id = s.queue[0].id.toUpperCase().replace(/0/g, 'A')),
    '条目 id 太长': (s) => (s.queue[0].id = 'a'.repeat(33)),
    '条目缺 id': (s) => delete s.queue[0].id,
    '条目是 null': (s) => (s.queue[1] = null),
    '条目是字符串': (s) => (s.history[0] = 'item'),
    'rev 为负': (s) => (s.rev = -1),
    'rev 是小数': (s) => (s.rev = 1.5),
    'rev 是字符串': (s) => (s.rev = String(s.rev)),
    'seq 为负': (s) => (s.seq = -1),
    'seq 缺失': (s) => delete s.seq,
    'nextSlot 为负': (s) => (s.nextSlot = -1),
    'nextSlot 超过 32 位': (s) => (s.nextSlot = 2 ** 32),
    'queue 不是数组': (s) => (s.queue = { 0: s.queue[0], length: 1 }),
    'history 缺失': (s) => delete s.history,
    '队列 101 项': (s) => {
      while (s.queue.length <= P.MAX_QUEUE) {
        s.queue.push({ ...linkItem(s.queue.length + 1000), id: (s.queue.length + 5000).toString(16).padStart(12, '0') });
      }
    },
    '已播放区 31 项': (s) => {
      while (s.history.length <= P.MAX_HISTORY) {
        s.history.push({ ...linkItem(s.history.length + 2000), id: (s.history.length + 9000).toString(16).padStart(12, '0') });
      }
    },
  };
  for (const [label, mutate] of Object.entries(cases)) {
    const s = roundTrip(good);
    mutate(s);
    assert.equal(P.validateSnapshot(s), null, label);
  }
  for (const raw of [null, undefined, 'playlist', 42, [], true]) {
    assert.equal(P.validateSnapshot(raw), null, `raw=${JSON.stringify(raw)}`);
  }

  // 边界本身是合法的：正好 100 项队列、正好 30 项已播放区
  const full = roundTrip(good);
  while (full.queue.length < P.MAX_QUEUE) {
    full.queue.push({ ...linkItem(full.queue.length + 1000), id: (full.queue.length + 5000).toString(16).padStart(12, '0') });
  }
  while (full.history.length < P.MAX_HISTORY) {
    full.history.push({ ...linkItem(full.history.length + 2000), id: (full.history.length + 9000).toString(16).padStart(12, '0') });
  }
  const v = P.validateSnapshot(full);
  assert.ok(v);
  assert.equal(v.queue.length, 100);
  assert.equal(v.history.length, 30);
});

impl('validateSnapshot：非关键字段不对只归零，不连累整张表', async (dir) => {
  const P = await load(dir);
  const s = roundTrip(richState(P));
  const it = s.queue[0];
  Object.assign(it, {
    addedBy: '有 空格',
    addedByName: '名'.repeat(60),
    sourceId: 'x'.repeat(129),
    sourceGone: 'yes',
    resumeAt: -3,
    durationSec: 1e9,
    extra: '<script>',
  });
  s.history[0].resumeAt = 'NaN';
  const v = P.validateSnapshot(s);
  assert.ok(v);
  const n = v.queue[0];
  assert.equal(n.addedBy, '');
  assert.equal(n.addedByName, '名'.repeat(40));
  assert.equal(n.sourceId, '');
  assert.equal(n.sourceGone, false);
  assert.equal(n.resumeAt, 0);
  assert.equal(n.durationSec, 0);
  assert.equal('extra' in n, false, '快照里夹带的字段不能被带进本地状态');
  assert.equal(v.history[0].resumeAt, 0);
  // 链接条目即使带了 slot 也不保留
  const withSlot = roundTrip(richState(P));
  const li = withSlot.queue.findIndex((x) => x.kind === 'link');
  withSlot.queue[li].slot = 0;
  const v2 = P.validateSnapshot(withSlot);
  assert.equal('slot' in v2.queue[li], false);
});

/*
 * 下面两条针对的是 RegExp.prototype.test 的隐式转字符串：
 * /^[a-f0-9]{32}$/.test(['<32 位十六进制>']) 为 true，/^…$/.test(42) 也可能为 true。
 * 播放列表操作和快照都来自网络（改过的客户端可以发任意 JSON），
 * 规范化之后的状态必须只含字符串 id，否则按 === / Map 键做的去重和一一对应检查全部失效。
 */
impl('数组包着的 fileId 不能绕过队列去重和 fileId↔槽位一一对应', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  const s = build(P, ctx, [fileItem(1)]);
  // 同一部片包一层数组再加一次：本该被当成非法条目（或重复）拒绝，而不是分到第二个槽位
  const res = run(P, s, { type: 'add', item: fileItem(1, { fileId: [fid(1)] }) }, ctx);
  assert.equal(res.ok, false, `数组 fileId 被接受了，分到槽位 ${res.state.queue[1] && res.state.queue[1].slot}`);

  // 快照里两项同一部片、两个槽位，只是 fileId 各包了一层数组：必须整张拒绝
  const raw = roundTrip(build(P, ctx, [fileItem(1), fileItem(2)]));
  raw.queue[0].fileId = [fid(3)];
  raw.queue[1].fileId = [fid(3)];
  assert.equal(P.validateSnapshot(raw), null, '同一部片占了两个槽位却通过了校验');
});

impl('非字符串的条目 id / sourceId / addedBy 不能原样进入规范化后的状态', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  // 片源 id 要和成员表按 === 比较，数字 42 永远对不上，会被误标成「来源已离开」
  const s = ok(P, P.createPlaylist(), { type: 'add', item: fileItem(1), sourceId: 42 }, ctx);
  assert.equal(s.queue[0].sourceId, 'host', `sourceId 变成了 ${typeof s.queue[0].sourceId}`);

  // 条目 id 是 move/remove/playNow 的寻址键：数字 id 既查不到，也逃过了重复检查
  const base = roundTrip(build(P, ctx, [linkItem(1), linkItem(2)]));
  const numeric = roundTrip(base);
  numeric.queue[0].id = 12345678;
  assert.equal(P.validateSnapshot(numeric), null, '数字 id 通过了校验');
  const wrapped = roundTrip(base);
  wrapped.queue[0].id = [base.queue[1].id];
  assert.equal(P.validateSnapshot(wrapped), null, '数组 id 通过了校验，且与另一项实际重复');

  const soft = roundTrip(build(P, ctx, [fileItem(1)]));
  soft.queue[0].sourceId = 42;
  soft.queue[0].addedBy = ['alice'];
  const v = P.validateSnapshot(soft);
  assert.ok(v);
  assert.equal(typeof v.queue[0].sourceId, 'string');
  assert.equal(typeof v.queue[0].addedBy, 'string');
});

impl('validateSnapshot：fileId 与槽位必须一一对应', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  let s = build(P, ctx, [fileItem(1), fileItem(2), fileItem(3)]);
  s = ok(P, s, { type: 'ended', seq: s.seq }, ctx);
  // s：queue [2(slot2), 3(slot3)]，history [1(slot1)]，nextSlot 4
  const base = roundTrip(s);
  assert.ok(P.validateSnapshot(base));

  // 同一个 fileId 两个槽位（跨队列和已播放区）：两端会把位图套到不同会话上
  const twoSlots = roundTrip(base);
  twoSlots.history[0].fileId = twoSlots.queue[0].fileId;
  assert.equal(P.validateSnapshot(twoSlots), null);

  // 同一个槽位两个 fileId：一个槽位的分片会写进另一部片
  const twoFiles = roundTrip(base);
  twoFiles.queue[1].slot = twoFiles.queue[0].slot;
  assert.equal(P.validateSnapshot(twoFiles), null);
  const twoFilesHist = roundTrip(base);
  twoFilesHist.history[0].slot = twoFilesHist.queue[0].slot;
  assert.equal(P.validateSnapshot(twoFilesHist), null);

  // 同一 fileId 同一槽位出现两次是一致的，不算冲突
  const same = roundTrip(base);
  same.history[0] = { ...same.queue[0], id: 'abcdefabcdef' };
  const v = P.validateSnapshot(same);
  assert.ok(v);
  assert.deepEqual(
    P.catalogOf(v).map((c) => c.slot),
    [2, 3],
  );
});

impl('validateSnapshot：槽位必须小于 nextSlot', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  const s = roundTrip(build(P, ctx, [fileItem(1), linkItem(2), fileItem(3)]));
  assert.equal(s.nextSlot, 3);
  // nextSlot 没盖住已分配的槽位，下一次 add 就会发出重复的号
  const low = roundTrip(s);
  low.nextSlot = 2;
  assert.equal(P.validateSnapshot(low), null);
  const eq = roundTrip(s);
  eq.queue[2].slot = 3;
  assert.equal(P.validateSnapshot(eq), null);
  const zero = roundTrip(s);
  zero.nextSlot = 0;
  assert.equal(P.validateSnapshot(zero), null);
  // 正好 nextSlot-1 合法；槽位 0 也合法；链接不受限制
  const okSlot = roundTrip(s);
  okSlot.queue[0].slot = 0;
  assert.ok(P.validateSnapshot(okSlot));
  const linksOnly = roundTrip(build(P, ctx, [linkItem(1)]));
  linksOnly.nextSlot = 0;
  assert.ok(P.validateSnapshot(linksOnly));
});

impl('validateSnapshot：条目 id 在队列和已播放区之间也不许重复', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  let s = build(P, ctx, [fileItem(1), fileItem(2), linkItem(3)]);
  s = ok(P, s, { type: 'ended', seq: s.seq }, ctx);
  const base = roundTrip(s);
  const inQueue = roundTrip(base);
  inQueue.queue[1].id = inQueue.queue[0].id;
  assert.equal(P.validateSnapshot(inQueue), null);
  // id 是 move/remove/playNow 的寻址依据，重复了操作会落到错的那一项上
  const across = roundTrip(base);
  across.history[0].id = across.queue[1].id;
  assert.equal(P.validateSnapshot(across), null);
});

impl('validateSnapshot：空队列时 started 一定是 false；autoplay 只有明确 false 才关', async (dir) => {
  const P = await load(dir);
  const empty = { ...roundTrip(P.createPlaylist()), started: true };
  assert.equal(P.validateSnapshot(empty).started, false);
  const ctx = makeCtx();
  const s = roundTrip(build(P, ctx, [fileItem(1)]));
  for (const [started, want] of [
    [true, true],
    ['true', false],
    [1, false],
    [undefined, false],
  ]) {
    assert.equal(P.validateSnapshot({ ...s, started }).started, want, `started=${String(started)}`);
  }
  for (const [autoplay, want] of [
    [false, false],
    [true, true],
    [undefined, true],
    ['false', true],
    [0, true],
  ]) {
    assert.equal(P.validateSnapshot({ ...s, autoplay }).autoplay, want, `autoplay=${String(autoplay)}`);
  }
});

/* ------------------------------ markStarted / markSources ------------------------------ */

impl('markStarted 只对当前 seq 生效，且只生效一次', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  const s = deepFreeze(build(P, ctx, [fileItem(1)]));
  // 旧片的「开始播放」不能把新片标成已开播，否则新片被拖动时会误要求确认
  assert.equal(P.markStarted(s, s.seq - 1), s);
  assert.equal(P.markStarted(s, s.seq + 1), s);
  assert.equal(P.markStarted(s, String(s.seq)), s);
  const m = P.markStarted(s, s.seq);
  assert.notEqual(m, s);
  assert.equal(m.started, true);
  assert.equal(m.rev, s.rev + 1);
  assert.equal(m.seq, s.seq);
  assert.equal(s.started, false);
  deepFreeze(m);
  // 每个人都会报一次「开始了」，只有第一条改表，免得 rev 被刷上去
  assert.equal(P.markStarted(m, m.seq), m);
  const empty = deepFreeze({ ...P.createPlaylist(), seq: 4 });
  assert.equal(P.markStarted(empty, 4), empty);
});

impl('markSources 标记 / 取消「来源已离开」，没有变化时返回原对象', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  let s = ok(P, P.createPlaylist(), { type: 'add', item: fileItem(1), sourceId: 'alice' }, ctx);
  s = build(P, ctx, [fileItem(2), linkItem(3)], s);
  s = ok(P, s, { type: 'add', item: fileItem(4), sourceId: 'alice' }, ctx);
  // alice 的片 1 放完进已播放区：已播放区的条目也要标，requeue 时才知道没人供片
  s = ok(P, s, { type: 'ended', seq: s.seq }, ctx);
  // 再造一个 sourceId 为空的文件条目（旧快照里可能出现）
  const raw = roundTrip(s);
  raw.queue.push({ ...raw.queue[raw.queue.length - 1], id: 'abcdefabcdef', fileId: fid(6), slot: raw.nextSlot, sourceId: '' });
  raw.nextSlot += 1;
  s = deepFreeze(P.validateSnapshot(raw));
  assert.ok(s);
  assert.equal(s.history[0].sourceId, 'alice');

  const asked = [];
  const online = new Set(['host']);
  const isOnline = (id) => (asked.push(id), online.has(id));
  const before = JSON.stringify(s);
  const gone = P.markSources(s, isOnline);
  assert.equal(JSON.stringify(s), before);
  assert.notEqual(gone, s);
  assert.equal(gone.rev, s.rev + 1);
  for (const it of [...gone.queue, ...gone.history]) {
    const want = it.kind === 'file' && it.sourceId === 'alice';
    assert.equal(it.sourceGone, want, `${it.name || it.title}`);
  }
  // 链接和没有片源的条目根本不该去问在不在线
  assert.ok(asked.every((id) => id === 'host' || id === 'alice'), `问了 ${asked}`);
  assert.equal(asked.includes(''), false);

  deepFreeze(gone);
  // 状态没变化：返回同一个对象，房主据此跳过广播
  assert.equal(P.markSources(gone, isOnline), gone);
  // alice 回来了
  online.add('alice');
  const back = P.markSources(gone, isOnline);
  assert.notEqual(back, gone);
  assert.equal(back.rev, gone.rev + 1);
  assert.ok([...back.queue, ...back.history].every((it) => it.sourceGone === false));
  assert.equal(P.markSources(s, () => true), s);
});

/* ------------------------------ transferOrder / isItemReady / waitingFor ------------------------------ */

impl('transferOrder：按队列顺序，跳过链接、已收完、没片源、磁盘放不下、重复的片', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  let s = build(P, ctx, [fileItem(99)]);
  s = ok(P, s, { type: 'ended', seq: s.seq }, ctx); // 已播放区里的片不参与传输排序
  s = build(P, ctx, [linkItem(1), fileItem(2), fileItem(3), fileItem(4), fileItem(6), fileItem(5)], s);
  // 快照里允许同一 fileId 同槽位出现两次，排序时只算一次
  const raw = roundTrip(s);
  raw.queue.push({ ...raw.queue[4], id: 'abcdefabcdef' });
  s = deepFreeze(P.validateSnapshot(raw));
  assert.equal(s.queue.length, 7);

  const complete = new Set([fid(2)]);
  const noSource = new Set([fid(3)]);
  const blocked = new Set([fid(4)]);
  const checked = [];
  const order = P.transferOrder(s, {
    isComplete: (it) => (checked.push(it.kind), complete.has(it.fileId)),
    hasSource: (it) => !noSource.has(it.fileId),
    diskBlocked: (it) => blocked.has(it.fileId),
  });
  assert.deepEqual(
    order.map((it) => it.fileId),
    [fid(6), fid(5)],
    '顺序必须和队列一致，第一项就是现在该要的那部',
  );
  assert.ok(checked.every((k) => k === 'file'));
  assert.equal(checked.length, 5, '重复的 fileId 不再重复判断');

  // diskBlocked 可以不传
  const order2 = P.transferOrder(s, { isComplete: () => false, hasSource: () => true });
  assert.deepEqual(
    order2.map((it) => it.fileId),
    [fid(2), fid(3), fid(4), fid(6), fid(5)],
  );
  assert.deepEqual(P.transferOrder(null, { isComplete: () => false, hasSource: () => true }), []);
});

impl('isItemReady：片源、可信房间、安全模式、链接各自的就绪条件', async (dir) => {
  const P = await load(dir);
  const big = { kind: 'file', size: 100 * MB };
  const small = { kind: 'file', size: 3 * MB };
  const link = { kind: 'link', url: 'https://example.com/' };
  assert.equal(P.HEAD_READY_BYTES, 8 * MB);

  assert.equal(P.isItemReady(null, { isSeeder: true }), false);
  assert.equal(P.isItemReady(undefined, { skipped: true }), false);

  // 片源自己不用等任何东西
  assert.equal(P.isItemReady(big, { isSeeder: true, mode: 'safe', complete: false }), true);

  // 可信房间：连续片头够 min(8MB, 大小)，不看是否收完、是否扫过
  assert.equal(P.isItemReady(big, { mode: 'trusted', contiguousBytes: 8 * MB - 1 }), false);
  assert.equal(P.isItemReady(big, { mode: 'trusted', contiguousBytes: 8 * MB }), true);
  assert.equal(P.isItemReady(big, { mode: 'trusted', contiguousBytes: 8 * MB, scanStatus: 'pending' }), true);
  assert.equal(P.isItemReady(big, { mode: 'trusted' }), false);
  // 比 8MB 还小的片，收完整部就算够，不能永远等不到 8MB
  assert.equal(P.isItemReady(small, { mode: 'trusted', contiguousBytes: 3 * MB - 1 }), false);
  assert.equal(P.isItemReady(small, { mode: 'trusted', contiguousBytes: 3 * MB }), true);
  assert.equal(P.isItemReady({ kind: 'file' }, { mode: 'trusted', contiguousBytes: 8 * MB }), true);

  // 安全模式：必须收完且扫描结论是 clean；扫不成（unavailable）也不放行
  assert.equal(P.isItemReady(big, { mode: 'safe', complete: true, scanStatus: 'clean' }), true);
  assert.equal(P.isItemReady(big, { complete: true, scanStatus: 'clean' }), true, '缺省按安全模式');
  assert.equal(P.isItemReady(big, { mode: 'safe', complete: true, scanStatus: 'unavailable' }), false);
  assert.equal(P.isItemReady(big, { mode: 'safe', complete: true, scanStatus: 'blocked' }), false);
  assert.equal(P.isItemReady(big, { mode: 'safe', complete: true, scanStatus: 'scanning' }), false);
  assert.equal(P.isItemReady(big, { mode: 'safe', complete: false, scanStatus: 'clean' }), false);
  assert.equal(P.isItemReady(big, { mode: 'safe', complete: 1, scanStatus: 'clean' }), false);
  assert.equal(P.isItemReady(big, { mode: 'safe', contiguousBytes: 100 * MB, scanStatus: 'clean' }), false);

  // 链接：自己跳过算就绪（不挡别人）；否则要允许站点且解析成功
  assert.equal(P.isItemReady(link, { skipped: true }), true);
  assert.equal(P.isItemReady(link, { consented: true, resolved: true }), true);
  assert.equal(P.isItemReady(link, { consented: true, resolved: false }), false);
  assert.equal(P.isItemReady(link, { consented: false, resolved: true }), false);
  assert.equal(P.isItemReady(link, { consented: 'yes', resolved: 1 }), false);
  assert.equal(P.isItemReady(link, { skipped: 'true' }), false);
  // 链接没有片源一说：房主自己也得允许并解析成功
  assert.equal(P.isItemReady(link, { isSeeder: true }), false);
  assert.equal(P.isItemReady(link, { mode: 'trusted', contiguousBytes: 100 * MB, complete: true, scanStatus: 'clean' }), false);
});

impl('waitingFor 只列出没有明确就绪的人，保持成员顺序', async (dir) => {
  const P = await load(dir);
  const members = [
    { peerId: 'a', name: 'A' },
    { peerId: 'b', name: 'B' },
    { peerId: 'c', name: 'C' },
    { peerId: 'd', name: 'D' },
  ];
  const ready = new Map([
    ['a', true],
    ['b', false],
    ['d', 1],
  ]);
  const out = P.waitingFor(members, ready);
  assert.deepEqual(
    out.map((m) => m.peerId),
    ['b', 'c', 'd'],
  );
  assert.equal(out[0], members[1]);
  assert.deepEqual(P.waitingFor([], ready), []);
  assert.deepEqual(P.waitingFor(members, new Map(members.map((m) => [m.peerId, true]))), []);
});

/* ------------------------------ catalogOf / referencedFileIds ------------------------------ */

impl('catalogOf：按槽位去重，含已播放区，不含链接，只带解位图需要的字段', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  let s = build(P, ctx, [fileItem(1), linkItem(2), fileItem(3)]);
  s = ok(P, s, { type: 'ended', seq: s.seq }, ctx);
  const raw = roundTrip(s);
  raw.queue.push({ ...raw.queue[1], id: 'abcdefabcdef' }); // 同片同槽位重复
  s = P.validateSnapshot(raw);
  const cat = P.catalogOf(s);
  // 队列在前、已播放区在后
  assert.deepEqual(cat, [
    { slot: 2, fileId: fid(3), size: 10 * MB + 3, chunkCount: 6, chunkSize: CHUNK },
    { slot: 1, fileId: fid(1), size: 10 * MB + 1, chunkCount: 6, chunkSize: CHUNK },
  ]);
  assert.deepEqual(P.catalogOf(null), []);
  assert.deepEqual(P.catalogOf(P.createPlaylist()), []);
});

impl('referencedFileIds 含已播放区，不含链接', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  let s = build(P, ctx, [fileItem(1), linkItem(2), fileItem(3)]);
  s = ok(P, s, { type: 'ended', seq: s.seq }, ctx);
  const refs = P.referencedFileIds(s);
  assert.ok(refs instanceof Set);
  // 已播放区的片还可能被 requeue，会话不能关
  assert.deepEqual([...refs].sort(), [fid(1), fid(3)]);
  assert.equal(P.referencedFileIds(null).size, 0);
  assert.equal(P.referencedFileIds({}).size, 0);
});

/* ------------------------------ 与分段传输的配合 ------------------------------ */

impl('满载列表（100 项 × 200 字中文片名 + 30 项已播放）能分段发出并原样拼回', async (dir) => {
  const P = await load(dir);
  const { splitLarge, PartAssembler } = await import(dir + 'protocol.js');
  const ctx = makeCtx({ actorName: '昵'.repeat(40) });
  const items = [];
  for (let i = 1; i <= P.MAX_QUEUE + P.MAX_HISTORY; i++) {
    items.push(i % 3 ? fileItem(i, { name: `第${i}部` + '长'.repeat(300) }) : linkItem(i, { title: '题'.repeat(300) }));
  }
  let s = build(P, ctx, items.slice(0, P.MAX_HISTORY));
  for (let i = 0; i < P.MAX_HISTORY; i++) s = ok(P, s, { type: 'ended', seq: s.seq }, ctx);
  s = build(P, ctx, items.slice(P.MAX_HISTORY), s);
  assert.equal(s.queue.length, 100);
  assert.equal(s.history.length, 30);

  const msg = { t: 'playlist', state: s };
  // 这正是 64KB 单条上限会被撞穿的场景
  assert.ok(new TextEncoder().encode(JSON.stringify(msg)).length > 64 * 1024);
  const parts = splitLarge(msg, 'abcdef012345');
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(new TextEncoder().encode(JSON.stringify(part)).length < 64 * 1024);
  }
  const asm = new PartAssembler();
  let out = null;
  for (const part of [...parts].reverse()) out = asm.push(roundTrip(part)) || out;
  assert.ok(out);
  assert.deepEqual(P.validateSnapshot(out.state), s);
});

impl('拖到自己身上什么都不变；已播放区的链接回到队列时不能和队列里的重复', async (dir) => {
  const P = await load(dir);
  const ctx = makeCtx();
  let s = P.createPlaylist();
  s = ok(P, s, { type: 'add', item: fileItem(1) }, ctx);
  s = ok(P, s, { type: 'add', item: linkItem(1) }, ctx);
  const same = run(P, s, { type: 'move', id: s.queue[1].id, beforeId: s.queue[1].id }, ctx);
  assert.equal(same.ok, true);
  assert.equal(same.state, s, '拖到自己身上不该产生新版本');

  // 链接放完进已播放区，队列里又加了同一个地址
  const linkId = s.queue[1].id;
  s = ok(P, s, { type: 'remove', id: s.queue[0].id }, ctx); // 链接成为当前项
  s = ok(P, s, { type: 'ended', seq: s.seq }, ctx); // 链接进已播放区
  assert.equal(s.history[0].id, linkId);
  s = ok(P, s, { type: 'add', item: linkItem(1) }, ctx);
  for (const op of [
    { type: 'requeue', id: linkId },
    { type: 'playNow', id: linkId },
  ]) {
    const res = run(P, s, op, ctx);
    assert.equal(res.ok, false, `${op.type} 应当被拒`);
    assert.equal(res.reason, '列表里已经有这个链接了');
    assert.equal(res.state, s);
  }
  // 队列里没有同一个地址时照常能回来
  const cleared = ok(P, s, { type: 'remove', id: s.queue[0].id }, ctx);
  const back = ok(P, cleared, { type: 'requeue', id: linkId }, ctx);
  assert.equal(back.queue.at(-1).url, linkItem(1).url);
});

test('reorderIds 和 applyOp 的 move 给出同一个顺序', async () => {
  const { reorderIds, applyOp, createPlaylist } = await import('../src/renderer/lib/playlist.js');
  let state = createPlaylist();
  let n = 0;
  const ctx = { actor: 'host', actorName: 'H', isController: () => true, newId: () => `${String(++n).padStart(8, '0')}`, position: 0 };
  for (let i = 0; i < 5; i++) {
    state = applyOp(state, { type: 'add', item: { kind: 'link', url: `https://example.com/${i}`, title: `t${i}` } }, ctx).state;
  }
  const ids = state.queue.map((it) => it.id);
  for (const id of ids) {
    for (const beforeId of [...ids, null]) {
      const expected = reorderIds(ids, id, beforeId);
      const res = applyOp(state, { type: 'move', id, beforeId }, ctx);
      if (expected === null) {
        assert.ok(res.unchanged, `${id} 插到自己前面应当原样返回`);
        continue;
      }
      assert.equal(res.ok, true);
      assert.deepEqual(res.state.queue.map((it) => it.id), expected, `${id} → ${beforeId}`);
    }
  }
  assert.equal(reorderIds(ids, 'nope', null), null);
  assert.equal(reorderIds(ids, ids[0], 'nope'), null);
  assert.deepEqual(reorderIds(ids, ids[0], null), [...ids.slice(1), ids[0]]);
  assert.deepEqual(reorderIds(ids, ids[4], ids[0]), [ids[4], ...ids.slice(0, 4)]);
  // 不改原数组
  const copy = ids.slice();
  reorderIds(ids, ids[2], ids[0]);
  assert.deepEqual(ids, copy);
});
