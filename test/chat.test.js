'use strict';

/**
 * 弹幕聊天的规则层（lib/chat.js）。桌面端和安卓端各跑一遍 —— 这两份是逐字节一致的副本，
 * 只测一边等于另一边没测。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { IMPLS } = require('./helpers/impls');

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

const load = (dir) => import(dir + 'chat.js');
/** 确定性时钟：测限速必须能精确控制「过了多久」。 */
const fakeClock = (start = 0) => {
  const c = { t: start, now: () => c.t, advance: (ms) => (c.t += ms) };
  return c;
};

/* ------------------------------ 文本清洗 ------------------------------ */

impl('清洗：控制字符一律删掉，双向覆盖字符也不放过', async (dir) => {
  const C = await load(dir);
  assert.equal(C.sanitizeText('你\x00好\x07啊\x1B'), '你好啊');
  assert.equal(C.sanitizeText('a\x7Fb\x85c'), 'abc');
  // \u{202E} 能让后面的文字反向显示，是聊天里最实用的伪装
  assert.equal(C.sanitizeText('gpj.\u{202E}gnos'), 'gpj.gnos');
  assert.equal(C.sanitizeText('a\u{2066}b\u{2069}c'), 'abc');
  // 落单的代理项画出来是问号
  assert.equal(C.sanitizeText('好\ud83d玩'), '好玩');
  assert.equal(C.sanitizeText('好\udc4d玩'), '好玩');
});

impl('清洗：连续空白并成一个半角空格，首尾 trim', async (dir) => {
  const C = await load(dir);
  assert.equal(C.sanitizeText('  你好    世界  '), '你好 世界');
  assert.equal(C.sanitizeText('第一行\n第二行\r\n第三行'), '第一行 第二行 第三行');
  assert.equal(C.sanitizeText('a\t\t\tb'), 'a b');
  // 全角空格、不换行空格、BOM 都算空白
  assert.equal(C.sanitizeText('\u{3000}你好\xA0世界\u{FEFF}'), '你好 世界');
  assert.equal(C.sanitizeText('a\u{2003}\u{2003}b'), 'a b');
  // trim 必须排在 200 字截断之前：外面包一圈空白的 200 字正文，一个字都不能少。
  // 顺序反过来的话，前导空格会占掉一个名额，末尾那个字被白白切掉
  assert.equal(C.sanitizeText('  ' + '弹'.repeat(200) + '  '), '弹'.repeat(200));
});

impl('清洗：最长 200 字，按码点算，emoji 不会被截成半个', async (dir) => {
  const C = await load(dir);
  assert.equal(C.MAX_TEXT, 200);
  const long = '弹'.repeat(250);
  assert.equal(Array.from(C.sanitizeText(long)).length, 200);
  assert.equal(C.sanitizeText(long), '弹'.repeat(200));
  // 正好 200 字不动它
  assert.equal(C.sanitizeText('弹'.repeat(200)), '弹'.repeat(200));

  // 第 200 个字是 emoji：按 UTF-16 截断会切出孤立代理项，按码点截断不会
  const withEmoji = '弹'.repeat(199) + '😀' + '弹'.repeat(10);
  const cut = C.sanitizeText(withEmoji);
  assert.equal(Array.from(cut).length, 200);
  assert.ok(cut.endsWith('😀'), '最后一个码点应当是完整的 emoji');
  // u 模式下代理项成对的会被当成一个码点，所以这个类只会命中落单的那种
  assert.doesNotMatch(cut, /[\u{D800}-\u{DFFF}]/u);

  // 截断正好切在空格上时，尾部空格要再 trim 掉
  const spaced = 'a'.repeat(199) + ' b';
  assert.equal(C.sanitizeText(spaced), 'a'.repeat(199));
});

impl('清洗：空消息、纯空白、纯控制字符都丢弃', async (dir) => {
  const C = await load(dir);
  for (const bad of ['', '   ', '\n\n', '\x00\x01', '\u{3000}', null, undefined, 42, {}, ['hi']]) {
    assert.equal(C.sanitizeText(bad), '', `${JSON.stringify(bad)} 应当被丢弃`);
  }
  assert.equal(C.createMessage('   \n  '), null);
});

impl('昵称截断到 40 字，并且同样清洗', async (dir) => {
  const C = await load(dir);
  assert.equal(C.MAX_NAME, 40);
  assert.equal(Array.from(C.clampName('观'.repeat(100))).length, 40);
  assert.equal(C.clampName('  张\x00三  '), '张三');
  assert.equal(C.clampName(123), '');
});

/* ------------------------------ 消息 id ------------------------------ */

impl('消息 id 是 12 位随机十六进制', async (dir) => {
  const C = await load(dir);
  const ids = new Set();
  for (let i = 0; i < 500; i++) {
    const id = C.newMessageId();
    assert.match(id, /^[0-9a-f]{12}$/);
    ids.add(id);
  }
  assert.ok(ids.size > 490, '500 次里几乎不该撞 id');
  assert.match(C.createMessage('你好').id, C.MSG_ID_RE);
});

test('消息 id 用 crypto.getRandomValues，不许退回 Math.random', () => {
  for (const { dir } of IMPLS) {
    const src = fs.readFileSync(path.resolve(__dirname, dir + 'chat.js'), 'utf8');
    assert.match(src, /crypto\.getRandomValues/);
    assert.doesNotMatch(src, /Math\.random/);
  }
});

impl('createMessage 产出 {id, text, ts}，ts 可注入', async (dir) => {
  const C = await load(dir);
  const m = C.createMessage('  你好   世界  ', { ts: 1_700_000_000_123 });
  assert.deepEqual(Object.keys(m).sort(), ['id', 'text', 'ts']);
  assert.equal(m.text, '你好 世界');
  assert.equal(m.ts, 1_700_000_000_123);
  // 外部传进来的 id 必须是合法格式，否则重新生成
  assert.equal(C.createMessage('hi', { id: 'abcdef012345' }).id, 'abcdef012345');
  assert.notEqual(C.createMessage('hi', { id: 'NOT-HEX' }).id, 'NOT-HEX');
});

/* ------------------------------ 令牌桶 ------------------------------ */

impl('令牌桶：突发 5 条，第 6 条被拒', async (dir) => {
  const C = await load(dir);
  assert.equal(C.BURST_TOKENS, 5);
  assert.equal(C.REFILL_PER_SECOND, 1);
  const clock = fakeClock();
  const b = new C.TokenBucket({ now: clock.now });
  for (let i = 0; i < 5; i++) assert.equal(b.take(), true, `第 ${i + 1} 条应当放行`);
  assert.equal(b.take(), false, '第 6 条应当被拒');
  assert.equal(b.retryAfterMs(), 1000);
});

impl('令牌桶：每秒恢复一条，不会攒过上限', async (dir) => {
  const C = await load(dir);
  const clock = fakeClock();
  const b = new C.TokenBucket({ now: clock.now });
  for (let i = 0; i < 5; i++) b.take();

  clock.advance(500);
  assert.equal(b.take(), false, '半秒只攒了半个令牌');
  assert.equal(b.retryAfterMs(), 500);
  clock.advance(500);
  assert.equal(b.take(), true, '满一秒恢复一条');
  assert.equal(b.take(), false, '一条就是一条');

  // 攒一整天也只能攒到上限，回来不能连发一天的量
  clock.advance(86_400_000);
  for (let i = 0; i < 5; i++) assert.equal(b.take(), true);
  assert.equal(b.take(), false, '上限就是 5 条');
});

impl('令牌桶：时钟往回跳不会白送令牌', async (dir) => {
  const C = await load(dir);
  const clock = fakeClock(10_000);
  const b = new C.TokenBucket({ now: clock.now });
  for (let i = 0; i < 5; i++) b.take();
  clock.t = 0; // 墙上时间被校准回去了
  assert.equal(b.take(), false, '往回跳不算时间流逝');
  clock.advance(999);
  assert.equal(b.take(), false);
  clock.advance(1);
  assert.equal(b.take(), true, '从倒退后的时刻重新计时');
});

/* ------------------------------ 收端闸门 ------------------------------ */

const wire = (id, text, extra = {}) => ({ t: 'chat', id, text, ts: 1_700_000_000_000, ...extra });
const idOf = (n) => n.toString(16).padStart(12, '0');

impl('收端：正常消息通过，正文被清洗，身份按连接算', async (dir) => {
  const C = await load(dir);
  const clock = fakeClock();
  const gate = new C.ChatGate({ now: clock.now });
  const r = gate.accept(wire(idOf(1), '  好\x00看  '), { senderId: 'peer-a', senderName: '小明', hostId: 'peer-h' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.message, {
    id: idOf(1),
    text: '好看',
    ts: 1_700_000_000_000,
    origin: 'peer-a',
    name: '小明',
    relayed: false,
  });
});

impl('收端：先去重、再扣令牌 —— 重复副本不消耗速率额度', async (dir) => {
  const C = await load(dir);
  const clock = fakeClock();
  const gate = new C.ChatGate({ now: clock.now });
  const ctx = { senderId: 'peer-a', senderName: '小明', hostId: 'peer-h' };

  assert.equal(gate.accept(wire(idOf(1), '第一条'), ctx).ok, true);
  // 网状模式下同一条会从另一条路径再来一次，来 20 次也不该扣令牌
  for (let i = 0; i < 20; i++) {
    const dup = gate.accept(wire(idOf(1), '第一条'), ctx);
    assert.equal(dup.ok, false);
    assert.equal(dup.reason, 'duplicate');
  }
  // 桶里还剩 4 个令牌：顺序反过来（先扣令牌）这 4 条就会被限速吃掉
  for (let i = 2; i <= 5; i++) {
    assert.equal(gate.accept(wire(idOf(i), `第 ${i} 条`), ctx).ok, true, `第 ${i} 条应当放行`);
  }
  const over = gate.accept(wire(idOf(6), '第六条'), ctx);
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'rate');
  assert.equal(over.retryAfterMs, 1000);
});

impl('收端：超额丢弃，一秒后恢复', async (dir) => {
  const C = await load(dir);
  const clock = fakeClock();
  const gate = new C.ChatGate({ now: clock.now });
  const ctx = { senderId: 'peer-a', hostId: 'peer-h' };
  for (let i = 1; i <= 5; i++) assert.equal(gate.accept(wire(idOf(i), '刷屏'), ctx).ok, true);
  assert.equal(gate.accept(wire(idOf(6), '刷屏'), ctx).reason, 'rate');
  clock.advance(1000);
  assert.equal(gate.accept(wire(idOf(7), '刷屏'), ctx).ok, true);
  assert.equal(gate.accept(wire(idOf(8), '刷屏'), ctx).reason, 'rate');
});

impl('收端：令牌桶按人分开，一个人刷屏不影响别人', async (dir) => {
  const C = await load(dir);
  const clock = fakeClock();
  const gate = new C.ChatGate({ now: clock.now });
  for (let i = 1; i <= 6; i++) gate.accept(wire(idOf(i), '刷屏'), { senderId: 'peer-a', hostId: 'peer-h' });
  assert.equal(gate.accept(wire(idOf(99), '我才第一句'), { senderId: 'peer-b', hostId: 'peer-h' }).ok, true);
});

impl('收端：只有房主转发的消息才采信 origin', async (dir) => {
  const C = await load(dir);
  const clock = fakeClock();
  const gate = new C.ChatGate({ now: clock.now });

  // 房主转发：采信 origin 和 originName
  const relayed = gate.accept(wire(idOf(1), '我是老张说的', { origin: 'peer-z', originName: '老张' }), {
    senderId: 'peer-h',
    senderName: '房主',
    hostId: 'peer-h',
  });
  assert.equal(relayed.ok, true);
  assert.equal(relayed.message.origin, 'peer-z');
  assert.equal(relayed.message.name, '老张');
  assert.equal(relayed.message.relayed, true);

  // 普通成员自称转发：一律按他本人算，冒充不了别人
  const faked = gate.accept(wire(idOf(2), '我冒充老张', { origin: 'peer-z', originName: '老张' }), {
    senderId: 'peer-b',
    senderName: '小王',
    hostId: 'peer-h',
  });
  assert.equal(faked.ok, true);
  assert.equal(faked.message.origin, 'peer-b');
  assert.equal(faked.message.name, '小王');
  assert.equal(faked.message.relayed, false);

  // 还不知道房主是谁的时候，谁也不能自称转发
  const noHost = gate.accept(wire(idOf(3), '房主还没露面', { origin: 'peer-z', originName: '老张' }), {
    senderId: 'peer-b',
    senderName: '小王',
  });
  assert.equal(noHost.message.origin, 'peer-b');
});

impl('收端：转发来的昵称截断到 40 字', async (dir) => {
  const C = await load(dir);
  const gate = new C.ChatGate({ now: fakeClock().now });
  const r = gate.accept(wire(idOf(1), '嗨', { origin: 'peer-z', originName: '超'.repeat(200) }), {
    senderId: 'peer-h',
    hostId: 'peer-h',
  });
  assert.equal(Array.from(r.message.name).length, 40);
  // 没有昵称时退回 peerId，不留空白
  const bare = gate.accept(wire(idOf(2), '嗨', { origin: 'peer-z' }), { senderId: 'peer-h', hostId: 'peer-h' });
  assert.equal(bare.message.name, 'peer-z');
});

impl('收端：自己的回声不再入列，用来把「发送中」改成已送达', async (dir) => {
  const C = await load(dir);
  const gate = new C.ChatGate({ now: fakeClock().now });
  const echo = gate.accept(wire(idOf(1), '我说的'), {
    senderId: 'peer-h',
    hostId: 'peer-h',
    selfId: 'peer-me',
    // 房主把我说的话转了回来
  });
  assert.equal(echo.ok, true, '不带 origin 时就是房主自己说的话');

  const mine = gate.accept(wire(idOf(2), '我说的', { origin: 'peer-me', originName: '我' }), {
    senderId: 'peer-h',
    hostId: 'peer-h',
    selfId: 'peer-me',
  });
  assert.equal(mine.ok, false);
  assert.equal(mine.reason, 'echo');
  assert.equal(mine.id, idOf(2));
});

impl('收端：形状不对的消息直接拒，不消耗令牌', async (dir) => {
  const C = await load(dir);
  const gate = new C.ChatGate({ now: fakeClock().now });
  const ctx = { senderId: 'peer-a', hostId: 'peer-h' };
  const bad = [
    null,
    'hi',
    ['hi'],
    { id: idOf(1) },
    { id: 'XYZ', text: 'hi' },
    { id: idOf(255).toUpperCase(), text: 'hi' },
    { id: idOf(1) + '0', text: 'hi' },
    { id: idOf(1), text: 123 },
  ];
  for (const msg of bad) {
    const r = gate.accept(msg, ctx);
    assert.equal(r.ok, false, `${JSON.stringify(msg)} 应当被拒`);
    assert.equal(r.reason, 'invalid');
  }
  // 没有发送者身份（连接没认证）同样拒
  assert.equal(gate.accept(wire(idOf(1), 'hi'), {}).reason, 'invalid');
  // 房主转发了一个不像 peerId 的 origin
  assert.equal(
    gate.accept(wire(idOf(1), 'hi', { origin: '../../etc' }), { senderId: 'peer-h', hostId: 'peer-h' }).reason,
    'invalid'
  );
  // 前面全被拒，令牌一个没少
  for (let i = 1; i <= 5; i++) assert.equal(gate.accept(wire(idOf(i), '正常'), ctx).ok, true);
});

impl('收端：清洗后为空的消息丢弃，但照样算一次额度', async (dir) => {
  const C = await load(dir);
  const gate = new C.ChatGate({ now: fakeClock().now });
  const ctx = { senderId: 'peer-a', hostId: 'peer-h' };
  const r = gate.accept(wire(idOf(1), '\x00\x01   '), ctx);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty');
  // 空消息刷屏也要受限速约束，否则等于开了一条免费通道
  for (let i = 2; i <= 5; i++) assert.equal(gate.accept(wire(idOf(i), '正常'), ctx).ok, true);
  assert.equal(gate.accept(wire(idOf(6), '正常'), ctx).reason, 'rate');
});

impl('收端：去重表有上限和存活期，掉线的人清得掉', async (dir) => {
  const C = await load(dir);
  const clock = fakeClock();
  const gate = new C.ChatGate({ now: clock.now, seenLimit: 4, seenTtlMs: 5000, capacity: 1000 });
  const ctx = { senderId: 'peer-a', hostId: 'peer-h' };
  for (let i = 1; i <= 6; i++) gate.accept(wire(idOf(i), `第 ${i} 条`), ctx);
  assert.equal(gate.seen.size, 4, '去重表不能无限长');
  // 最老的两条已经被挤掉，会被当成新消息（可接受：撑爆内存更糟）
  assert.equal(gate.accept(wire(idOf(1), '第 1 条'), ctx).ok, true);
  // 超过存活期的也不再算重复
  assert.equal(gate.accept(wire(idOf(6), '第 6 条'), ctx).reason, 'duplicate');
  clock.advance(5001);
  assert.equal(gate.accept(wire(idOf(6), '第 6 条'), ctx).ok, true);

  gate.forget('peer-a');
  gate.clear();
  assert.equal(gate.seen.size, 0);
});

impl('收端：自己发的 id 先记一笔，房主转回来时不会显示两遍', async (dir) => {
  const C = await load(dir);
  const gate = new C.ChatGate({ now: fakeClock().now });
  gate.remember(idOf(7));
  const back = gate.accept(wire(idOf(7), '我说的'), { senderId: 'peer-h', hostId: 'peer-h' });
  assert.equal(back.reason, 'duplicate');
});

/* ------------------------------ 发端 ------------------------------ */

impl('发端：突发 5 条之后提示还要等几秒', async (dir) => {
  const C = await load(dir);
  const clock = fakeClock();
  const sender = new C.ChatSender({ now: clock.now, wallClock: () => 1_700_000_000_000 });
  for (let i = 0; i < 5; i++) {
    const r = sender.submit(`第 ${i} 条`);
    assert.equal(r.ok, true);
    assert.match(r.message.id, /^[0-9a-f]{12}$/);
    assert.equal(r.message.ts, 1_700_000_000_000);
  }
  const over = sender.submit('太快了');
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'rate');
  assert.equal(over.retryAfterMs, 1000);
  assert.equal(over.retryAfterSec, 1, '给用户看的秒数至少是 1');

  clock.advance(1000);
  assert.equal(sender.submit('现在可以了').ok, true);
  assert.equal(sender.retryAfterMs(), 1000);

  // 空消息不占额度
  const empty = sender.submit('   ');
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'empty');

  sender.reset();
  assert.equal(sender.submit('重置之后').ok, true);
});

/* ------------------------------ 历史 ------------------------------ */

impl('历史只留最近 50 条', async (dir) => {
  const C = await load(dir);
  assert.equal(C.HISTORY_LIMIT, 50);
  const h = new C.ChatHistory();
  for (let i = 1; i <= 80; i++) {
    h.add({ id: idOf(i), text: `第 ${i} 条`, origin: 'peer-a', name: '小明', ts: 1_700_000_000_000 + i });
  }
  const list = h.list();
  assert.equal(list.length, 50);
  assert.equal(list[0].text, '第 31 条');
  assert.equal(list[49].text, '第 80 条');

  const snap = h.snapshot();
  assert.deepEqual(Object.keys(snap[0]).sort(), ['at', 'from', 'id', 'name', 'text']);
  assert.equal(snap[0].from, 'peer-a');

  // 不合法的条目进不去
  assert.equal(h.add({ id: 'bad', text: 'hi', origin: 'peer-a' }), null);
  assert.equal(h.add({ id: idOf(1), text: '   ', origin: 'peer-a' }), null);
  assert.equal(h.add({ id: idOf(1), text: 'hi' }), null);
  assert.equal(h.list().length, 50);
  h.clear();
  assert.equal(h.list().length, 0);
});

impl('收端解析历史：逐条清洗、按 id 去重、只留最近 50 条', async (dir) => {
  const C = await load(dir);
  const items = [];
  for (let i = 1; i <= 120; i++) items.push({ id: idOf(i), text: `第 ${i} 条`, from: 'peer-a', name: '小明', at: i });

  const parsed = C.parseHistory(items);
  assert.equal(parsed.length, 50, '超长的历史包只留末尾 50 条');
  assert.equal(parsed[0].text, '第 71 条');
  assert.equal(parsed[49].text, '第 120 条');
  assert.equal(parsed[0].origin, 'peer-a');
  assert.equal(parsed[0].ts, 71);

  // 重复的、正文为空的、id 不合法的、没有来源的，逐条剔掉
  const mixed = C.parseHistory([
    { id: idOf(1), text: '正常', from: 'peer-a' },
    { id: idOf(1), text: '重复的', from: 'peer-a' },
    { id: idOf(2), text: '  ', from: 'peer-a' },
    { id: 'zzz', text: '坏 id', from: 'peer-a' },
    { id: idOf(3), text: '没有来源' },
    { id: idOf(4), text: '来源不像 peerId', from: '../../etc' },
  ]);
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].text, '正常');
  assert.equal(C.parseHistory('nope').length, 0);
  assert.equal(C.parseHistory(null).length, 0);

  // 历史里的正文同样要清洗
  const dirty = C.parseHistory([{ id: idOf(1), text: '坏\x00\u{202E}东西', from: 'peer-a', name: '超'.repeat(80) }]);
  assert.equal(dirty[0].text, '坏东西');
  assert.equal(Array.from(dirty[0].name).length, 40);
});

impl('只有房主那条连接才有资格发历史', async (dir) => {
  const C = await load(dir);
  assert.equal(C.trustsRelay('peer-h', 'peer-h'), true);
  assert.equal(C.trustsRelay('peer-b', 'peer-h'), false);
  assert.equal(C.trustsRelay('peer-h', null), false);
  assert.equal(C.trustsRelay(undefined, 'peer-h'), false);
});

/* --------------------- 协议类型 --------------------- */

impl('协议里有 CHAT 和 CHAT_HISTORY，字面量就是线缆上跑的那两个', async (dir) => {
  const P = await import(dir + 'protocol.js');
  // 这两个字面量是线缆格式的一部分：改了就和 0.7 的其他客户端对不上，
  // 所以这里钉死值本身，而不是「有这个键就行」
  assert.equal(P.MSG.CHAT, 'chat');
  assert.equal(P.MSG.CHAT_HISTORY, 'chat-history');
  // 本阶段不动协议版本号 —— 聊天是新增消息类型，老客户端遇到未知类型本来就会忽略
  assert.equal(P.PROTOCOL_VERSION, 2);
});

/* --------------------- 历史走 PART 分段信封 --------------------- */

impl('50 条 200 字全中文的历史经 PART 分段，每段都不到 64KB', async (dir) => {
  const C = await load(dir);
  const P = await import(dir + 'protocol.js');
  assert.ok(P.PART_INNER_TYPES.has(P.MSG.CHAT_HISTORY), 'CHAT_HISTORY 必须允许走 PART');

  const h = new C.ChatHistory();
  for (let i = 0; i < C.HISTORY_LIMIT; i++) {
    h.add({
      id: idOf(i + 1),
      text: '这部片子的配乐真是太好听了'.repeat(20), // 260 字，清洗后正好截到 200
      origin: 'peer-' + i,
      name: '观'.repeat(40),
      ts: 1_700_000_000_000 + i,
    });
  }
  const snap = h.snapshot();
  assert.equal(snap.length, 50);
  assert.equal(Array.from(snap[0].text).length, 200);

  const msg = { t: P.MSG.CHAT_HISTORY, items: snap };
  const parts = P.splitLarge(msg, 'f'.repeat(32));
  const SCTP_LIMIT = 64 * 1024;
  for (const [i, part] of parts.entries()) {
    const size = Buffer.byteLength(JSON.stringify(part), 'utf8');
    assert.ok(size < SCTP_LIMIT, `第 ${i} 段 ${size} 字节，超过 64KB 会把整条通道打断`);
    assert.equal(part.t, P.MSG.PART);
  }

  // 拼回来还得是同一份
  const asm = new P.PartAssembler({ now: () => 0 });
  let inner = null;
  for (const part of parts) inner = asm.push(JSON.parse(JSON.stringify(part))) || inner;
  assert.deepEqual(inner, msg);
  assert.deepEqual(
    C.parseHistory(inner.items).map((it) => it.id),
    snap.map((it) => it.id)
  );
});
