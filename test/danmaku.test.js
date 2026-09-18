'use strict';

/**
 * 弹幕排布（lib/danmaku.js）。桌面端和安卓端各跑一遍。
 *
 * 这里的断言全部基于确定性时钟和可注入的宽度测量，所以跑多少遍结果都一样 ——
 * 弹幕这种东西肉眼看「好像没撞上」是靠不住的，得逐帧算出来比。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { IMPLS } = require('./helpers/impls');

function impl(title, fn) {
  for (const { name, dir } of IMPLS) test(`${name}：${title}`, () => fn(dir));
}

const load = (dir) => import(dir + 'danmaku.js');
/** 固定宽度的测量函数：让「会不会追尾」变成纯算术，不受字形估算影响。 */
const fixedMeasure = (px) => () => px;
const msg = (n, self = false) => ({ id: 'm' + n, text: '第 ' + n + ' 条弹幕', self });

/** 同一条弹道上有没有两条弹幕的横向区间叠在一起。 */
function overlaps(frame) {
  const byTrack = new Map();
  for (const it of frame) {
    if (!byTrack.has(it.track)) byTrack.set(it.track, []);
    byTrack.get(it.track).push(it);
  }
  for (const [track, list] of byTrack) {
    list.sort((a, b) => a.x - b.x);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      if (prev.x + prev.width > list[i].x) {
        return { track, a: prev.id, b: list[i].id, ax: prev.x, aw: prev.width, bx: list[i].x };
      }
    }
  }
  return null;
}

/* ------------------------------ 设置归一化 ------------------------------ */

impl('设置里的坏值一律夹回安全范围', async (dir) => {
  const D = await load(dir);
  const s = D.resolveSettings({ opacity: 99, fontScale: 50, speed: -3, area: '../etc' }, { height: 1080 });
  assert.equal(s.opacity, 1);
  assert.equal(s.speed, 0.25);
  assert.equal(s.area, 'half');
  assert.ok(s.fontSize <= D.MAX_FONT_PX);

  const d = D.resolveSettings(null, { height: 1080 });
  assert.equal(d.enabled, true);
  assert.equal(d.opacity, D.DEFAULT_SETTINGS.opacity);
  assert.equal(d.speed, 1);
  assert.equal(d.area, 'half');
  assert.equal(d.fontSize, D.defaultFontSize(1080));

  // 明确给的字号优先于缩放
  assert.equal(D.resolveSettings({ fontSize: 33, fontScale: 2 }, { height: 1080 }).fontSize, 33);
  assert.equal(D.resolveSettings({ fontSize: 5 }, { height: 1080 }).fontSize, D.MIN_FONT_PX);
  assert.equal(D.resolveSettings({ enabled: false }, { height: 1080 }).enabled, false);
  // NaN / 字符串都当没给
  assert.equal(D.resolveSettings({ opacity: Number.NaN, speed: 'fast' }, { height: 1080 }).speed, 1);

  // pxPerMs 自己也夹一次：覆盖窗那条路直接调它算像素速度，不一定先过 resolveSettings。
  // 速度不夹的话，滑条拉到头就是一帧横穿整屏，等于弹幕全没了
  assert.equal(D.pxPerMs(1000, 999), D.pxPerMs(1000, 4), '速度上限没夹住');
  assert.equal(D.pxPerMs(1000, -5), D.pxPerMs(1000, 0.25), '负速度会让弹幕倒着飞');
  assert.equal(D.pxPerMs(1000, 'fast'), D.pxPerMs(1000, 1));
});

/* ------------------------------ 弹道布局 ------------------------------ */

impl('布局：任何时候都躲开播放器顶部的窗口控件', async (dir) => {
  const D = await load(dir);
  const layout = D.computeLayout({ width: 1920, height: 1080, fontSize: 40, area: 'half', banner: false });
  assert.ok(layout.top >= D.OSC_TOP_PX, `顶部只留了 ${layout.top}px，会盖住窗口控件`);
  assert.ok(layout.trackCount >= 5);
  // 上半屏模式不越过中线
  assert.ok(layout.top + layout.trackCount * layout.trackHeight <= 1080 * 0.5 + 0.001);
});

impl('布局：有横幅时顶部留出约 8%', async (dir) => {
  const D = await load(dir);
  const plain = D.computeLayout({ width: 1920, height: 1080, fontSize: 40, area: 'half', banner: false });
  const banner = D.computeLayout({ width: 1920, height: 1080, fontSize: 40, area: 'half', banner: true });
  assert.ok(banner.top >= 1080 * D.BANNER_TOP_RATIO, `有横幅时只留了 ${banner.top}px`);
  assert.ok(banner.top > plain.top, '有横幅必须比没横幅让得多');
  assert.ok(banner.top >= D.OSC_TOP_PX, '让开横幅的同时也得让开窗口控件');
  assert.ok(banner.bottom - banner.top < plain.bottom - plain.top, '让出来的高度要真的从弹幕区里扣掉');
});

impl('布局：全屏模式给字幕和进度条留底部，上半屏模式不过中线', async (dir) => {
  const D = await load(dir);
  const half = D.computeLayout({ width: 1920, height: 1080, fontSize: 40, area: 'half' });
  const full = D.computeLayout({ width: 1920, height: 1080, fontSize: 40, area: 'full' });
  assert.equal(half.bottom, 540);
  assert.ok(full.bottom <= 1080 * (1 - D.BOTTOM_RESERVE_RATIO) + 0.001);
  assert.ok(full.trackCount > half.trackCount);
});

impl('布局：窗口小到只够一行字时也给一条弹道', async (dir) => {
  const D = await load(dir);
  const tiny = D.computeLayout({ width: 400, height: 220, fontSize: 60, area: 'half' });
  assert.equal(tiny.trackCount, 1, '否则小窗口下弹幕永远只排队不出场');
  // 真的连一行都放不下就只能是 0
  assert.equal(D.computeLayout({ width: 400, height: 90, fontSize: 60, area: 'half' }).trackCount, 0);
});

/* ------------------------------ 出场与弹道 ------------------------------ */

impl('新弹幕从最上面的空弹道开始排，同一帧每条弹道只放一条', async (dir) => {
  const D = await load(dir);
  const base = { width: 1000, height: 1080, settings: { fontSize: 40, speed: 1 }, measure: fixedMeasure(300) };
  const r = D.planFrame({ ...base, now: 0, incoming: [msg(1), msg(2), msg(3)] });
  assert.equal(r.frame.length, 3);
  assert.deepEqual(r.frame.map((f) => f.track), [0, 1, 2]);
  // 刚出场时左边缘正好在右边界上
  assert.ok(r.frame.every((f) => f.x === 1000));
  // 弹道之间隔着一整行高
  assert.equal(r.frame[1].y - r.frame[0].y, Math.round(r.layout.trackHeight));
});

impl('前一条还没完全进场时，同一条弹道不放第二条', async (dir) => {
  const D = await load(dir);
  // 只有一条弹道：高度刚好够一行
  const base = { width: 1000, height: 300, settings: { fontSize: 60, speed: 1 }, measure: fixedMeasure(200) };
  let st = D.planFrame({ ...base, now: 0, incoming: [msg(1)] });
  assert.equal(st.layout.trackCount, 1);
  assert.equal(st.frame.length, 1);

  // 速度 0.125px/ms（宽 1000 / 8000ms）：要挪出 200(宽) + 48(间隔) 才算完全进场，约 1984ms
  st = D.planFrame({ ...base, now: 1500, flying: st.flying, pending: st.pending, incoming: [msg(2)] });
  assert.equal(st.frame.length, 1, '第二条还得等着');
  assert.equal(st.pending.length, 1);

  st = D.planFrame({ ...base, now: 2000, flying: st.flying, pending: st.pending, incoming: [] });
  assert.equal(st.frame.length, 2, '前一条让开了，排队的接上');
  assert.equal(st.pending.length, 0);
  assert.equal(overlaps(st.frame), null);
});

impl('三十帧每秒连续跑三十秒，同一条弹道上永不追尾', async (dir) => {
  const D = await load(dir);
  const texts = ['短', '这句话中等长度', '这是一句相当长的弹幕，用来把弹道撑满看看会不会追上前面那条', 'ASCII only text here'];
  let flying = [];
  let pending = [];
  let n = 0;
  let sawMany = 0;
  for (let f = 0; f < 900; f++) {
    const now = f * 33;
    const incoming = f % 3 === 0 ? [{ id: 'k' + n, text: texts[n++ % texts.length], self: n % 5 === 0 }] : [];
    const out = D.planFrame({
      width: 1920,
      height: 1080,
      now,
      flying,
      pending,
      incoming,
      settings: { speed: 1.5, area: 'full' },
      banner: f > 450, // 中途挂上横幅，弹道数会变
    });
    flying = out.flying;
    pending = out.pending;
    const bad = overlaps(out.frame);
    assert.equal(bad, null, `第 ${f} 帧追尾了：${JSON.stringify(bad)}`);
    if (out.frame.length > 4) sawMany++;
  }
  assert.ok(n > 290, '素材得够多才算压住了');
  assert.ok(sawMany > 100, '大部分时间屏幕上应当同时有好几条弹幕，否则这条测试在空跑');
});

impl('速度只改快慢，出场次序始终按排队先后', async (dir) => {
  const D = await load(dir);
  const run = (speed) => {
    let st = { flying: [], pending: [] };
    const order = [];
    for (let f = 0; f < 200; f++) {
      st = D.planFrame({
        width: 1000,
        height: 300,
        now: f * 33,
        flying: st.flying,
        pending: st.pending,
        incoming: f % 4 === 0 ? [{ id: String(f), text: '第 ' + f + ' 条' }] : [],
        settings: { fontSize: 60, speed },
        measure: fixedMeasure(200),
      });
      for (const it of st.flying) if (!order.includes(it.id)) order.push(it.id);
      assert.equal(overlaps(st.frame), null);
    }
    return order.map(Number);
  };
  for (const speed of [0.5, 1, 2]) {
    const order = run(speed);
    assert.ok(order.length >= 2, `速度 ${speed} 下一条都没放出来，这条测试在空跑`);
    // 队列满了会丢最老的，所以编号可能不连续，但先来的绝不会排在后来的之后
    for (let i = 1; i < order.length; i++) {
      assert.ok(order[i] > order[i - 1], `速度 ${speed} 下出场次序乱了：${order.join(',')}`);
    }
  }
  assert.ok(run(2).length > run(0.5).length, '快的那次放得出更多条');
});

/* ------------------------------ 排队上限 ------------------------------ */

impl('弹道占满时排队，最多 20 条，再多丢最老的', async (dir) => {
  const D = await load(dir);
  assert.equal(D.MAX_PENDING, 20);
  const base = { width: 1000, height: 300, settings: { fontSize: 60, speed: 1 }, measure: fixedMeasure(200) };
  let st = { flying: [], pending: [] };
  let dropped = 0;
  for (let i = 0; i < 26; i++) {
    st = D.planFrame({ ...base, now: i * 33, flying: st.flying, pending: st.pending, incoming: [msg(i)] });
    dropped += st.dropped;
  }
  assert.equal(st.frame.length, 1, '一条弹道，第一条还在飞');
  assert.equal(st.pending.length, D.MAX_PENDING);
  assert.equal(dropped, 5, '26 条里 1 条出场、20 条排队，剩下的丢掉');
  // 丢的是最老的：留下来的是最近 20 条
  assert.deepEqual(st.pending.map((p) => p.id), Array.from({ length: 20 }, (_, i) => 'm' + (i + 6)));
});

impl('排队里不塞重复 id，也不塞空正文', async (dir) => {
  const D = await load(dir);
  const base = { width: 1000, height: 300, settings: { fontSize: 60 }, measure: fixedMeasure(200) };
  let st = D.planFrame({ ...base, now: 0, incoming: [msg(1), msg(1), { id: 'x', text: '' }, { text: '没有 id' }, null] });
  assert.equal(st.frame.length, 1);
  assert.equal(st.pending.length, 0);
  // 已经在飞的 id 再来一次也不重复排
  st = D.planFrame({ ...base, now: 100, flying: st.flying, pending: st.pending, incoming: [msg(1)] });
  assert.equal(st.pending.length, 0);
  assert.equal(st.frame.length, 1);
});

/* ------------------------------ 输出内容 ------------------------------ */

impl('只显示正文，不显示昵称；自己发的加描边', async (dir) => {
  const D = await load(dir);
  const out = D.planFrame({
    width: 1000,
    height: 1080,
    now: 0,
    incoming: [
      { id: 'a', text: '别人说的', self: false, name: '小明', origin: 'peer-a' },
      { id: 'b', text: '我说的', self: true, name: '我', origin: 'peer-me' },
    ],
    settings: { fontSize: 40 },
  });
  assert.deepEqual(Object.keys(out.frame[0]).sort(), ['fontSize', 'id', 'opacity', 'outline', 'text', 'track', 'width', 'x', 'y']);
  // 昵称一个字都不能进弹幕
  for (const f of out.frame) {
    assert.equal(JSON.stringify(f).includes('小明'), false);
    assert.equal(JSON.stringify(f).includes('peer-'), false);
  }
  assert.equal(out.frame[0].outline, false);
  assert.equal(out.frame[1].outline, true, '自己发的要加描边');
  assert.equal(out.frame[0].text, '别人说的');
});

impl('飞出左边界的弹幕从在飞列表里去掉', async (dir) => {
  const D = await load(dir);
  const base = { width: 1000, height: 1080, settings: { fontSize: 40, speed: 1 }, measure: fixedMeasure(300) };
  let st = D.planFrame({ ...base, now: 0, incoming: [msg(1)] });
  // 0.125px/ms（速度 1，宽 1000）；跑完 1000+300 需要 10400ms
  st = D.planFrame({ ...base, now: 10_000, flying: st.flying, pending: st.pending, incoming: [] });
  assert.equal(st.flying.length, 1, '还差一点点');
  assert.ok(st.frame[0].x < 0);
  st = D.planFrame({ ...base, now: 10_500, flying: st.flying, pending: st.pending, incoming: [] });
  assert.equal(st.flying.length, 0);
  assert.equal(st.frame.length, 0);
});

impl('不透明度和字号原样带给渲染方', async (dir) => {
  const D = await load(dir);
  const out = D.planFrame({
    width: 1000,
    height: 1080,
    now: 0,
    incoming: [msg(1)],
    settings: { fontSize: 52, opacity: 0.4 },
  });
  assert.equal(out.frame[0].fontSize, 52);
  assert.equal(out.frame[0].opacity, 0.4);
  assert.equal(out.settings.fontSize, 52);
});

impl('关掉弹幕就整场清空，连排队的也不留', async (dir) => {
  const D = await load(dir);
  const base = { width: 1000, height: 300, settings: { fontSize: 60 }, measure: fixedMeasure(200) };
  let st = D.planFrame({ ...base, now: 0, incoming: [msg(1), msg(2), msg(3)] });
  assert.equal(st.pending.length, 2);
  st = D.planFrame({
    ...base,
    settings: { fontSize: 60, enabled: false },
    now: 100,
    flying: st.flying,
    pending: st.pending,
    incoming: [msg(4)],
  });
  assert.deepEqual(st.frame, []);
  assert.deepEqual(st.flying, []);
  assert.deepEqual(st.pending, []);
});

impl('窗口小到放不下弹道时先攒着，放大后照常出场', async (dir) => {
  const D = await load(dir);
  const settings = { fontSize: 60, speed: 1 };
  let st = D.planFrame({ width: 1000, height: 90, now: 0, settings, incoming: [msg(1), msg(2)] });
  assert.equal(st.layout.trackCount, 0);
  assert.equal(st.frame.length, 0);
  assert.equal(st.pending.length, 2);
  st = D.planFrame({
    width: 1000,
    height: 1080,
    now: 100,
    settings,
    flying: st.flying,
    pending: st.pending,
    incoming: [],
  });
  assert.equal(st.frame.length, 2);
  assert.deepEqual(st.frame.map((f) => f.id), ['m1', 'm2']);
});

/* ------------------------------ 纯函数性质 ------------------------------ */

impl('planFrame 不改动传进来的数组，同样输入给同样输出', async (dir) => {
  const D = await load(dir);
  const flying = Object.freeze([]);
  const pending = Object.freeze([]);
  const incoming = Object.freeze([msg(1), msg(2)]);
  const input = { width: 1280, height: 720, now: 1234, flying, pending, incoming, settings: { fontSize: 40 } };
  const a = D.planFrame(input);
  const b = D.planFrame(input);
  assert.deepEqual(a.frame, b.frame);
  assert.equal(flying.length, 0);
  assert.equal(pending.length, 0);
  assert.equal(incoming.length, 2);

  // 时刻是唯一的时间来源：不传时刻就复算不出位置
  const later = D.planFrame({ ...input, now: 1234 + 1000, flying: a.flying, pending: a.pending, incoming: [] });
  assert.ok(later.frame[0].x < a.frame[0].x, '时间往前走，弹幕就该往左走');
});

impl('宽度估算：中日韩和 emoji 按一个字宽算，西文窄一些', async (dir) => {
  const D = await load(dir);
  assert.equal(D.measureTextWidth('中文', 40), 80);
  assert.equal(D.measureTextWidth('ab', 40), 44);
  assert.ok(D.measureTextWidth('😀', 40) > D.measureTextWidth('a', 40));
  assert.equal(D.measureTextWidth('', 40), 0);
  assert.equal(D.measureTextWidth(null, 40), 0);
});

/* ------------------------------ 有状态的包装 ------------------------------ */

impl('DanmakuEngine 只是薄包装，行为和 planFrame 一致', async (dir) => {
  const D = await load(dir);
  const engine = new D.DanmakuEngine({ width: 1000, height: 300, settings: { fontSize: 60, speed: 1 }, measure: fixedMeasure(200) });
  engine.push(msg(1));
  engine.push(msg(2));
  const frame = engine.frame(0);
  assert.equal(frame.length, 1);
  assert.equal(engine.pendingCount, 1);
  assert.equal(engine.flyingCount, 1);

  engine.setBanner(true);
  engine.resize(1000, 1080);
  engine.setSettings({ fontSize: 40, speed: 1 });
  const wide = engine.frame(100);
  assert.equal(wide.length, 2, '放大之后排队的也出来了');
  assert.ok(wide[0].y >= 1080 * D.BANNER_TOP_RATIO, '挂上横幅后要让出顶部');

  engine.clear();
  assert.equal(engine.frame(200).length, 0);
  assert.equal(engine.pendingCount, 0);
});
