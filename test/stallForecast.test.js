'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/renderer/lib/stallForecast.js');

const MB = 1024 * 1024;
const GB = 1024 * MB;

test('码率 = 文件大小 ÷ 时长；时长未知时给 0 而不是瞎猜', async () => {
  const { bitrateOf } = await load();
  assert.equal(bitrateOf(3600 * MB, 3600), MB);
  assert.equal(bitrateOf(3600 * MB, 0), 0);
  assert.equal(bitrateOf(3600 * MB, undefined), 0);
  assert.equal(bitrateOf(0, 3600), 0);
});

test('速度有 1.2 倍余量算流畅，1~1.2 倍算余量薄', async () => {
  const { forecastStall } = await load();
  const base = { size: 4 * GB, bitrate: MB, contiguous: 100 * MB, playhead: 0 };
  assert.equal(forecastStall({ ...base, rate: 1.5 * MB }).level, 'ok');
  assert.equal(forecastStall({ ...base, rate: 1.2 * MB }).level, 'ok');
  assert.equal(forecastStall({ ...base, rate: 1.1 * MB }).level, 'thin');
  assert.equal(forecastStall({ ...base, rate: MB }).level, 'thin');
});

test('速度低于码率时报会卡，并给出还能播多久', async () => {
  const { forecastStall } = await load();
  // 领先 60MB，码率 1MB/s，速度 0.5MB/s：播放头每秒追近 0.5MB，120 秒后追上。
  const r = forecastStall({ size: 4 * GB, bitrate: MB, rate: 0.5 * MB, contiguous: 60 * MB, playhead: 0 });
  assert.equal(r.level, 'stall');
  assert.equal(Math.round(r.stallInSec), 120);
});

/**
 * 这条是模型里最容易写错、也最影响体验的一点：速度低于码率不等于会卡。
 * 已经缓冲了大半部片子的人，剩下的部分在播放头追上来之前就收完了。
 */
test('速度低于码率但缓冲撑得到收完时不报会卡', async () => {
  const { forecastStall } = await load();
  // 文件 1000MB，已连续 900MB，播放头在 0；速度 0.5MB/s，剩 100MB 要 200 秒。
  // 码率 1MB/s，播放头追上水位线要 900/(1-0.5)=1800 秒 —— 远在收完之后。
  const r = forecastStall({ size: 1000 * MB, bitrate: MB, rate: 0.5 * MB, contiguous: 900 * MB, playhead: 0 });
  assert.equal(r.level, 'thin');
  assert.equal(Math.round(r.finishSec), 200);
});

test('已经收完的人永远不会卡，不管速度是多少', async () => {
  const { forecastStall } = await load();
  assert.equal(forecastStall({ size: GB, bitrate: MB, rate: 0, contiguous: GB }).level, 'done');
});

test('完全没在收时报会卡，还能播的时长就是领先量除以码率', async () => {
  const { forecastStall } = await load();
  const r = forecastStall({ size: GB, bitrate: MB, rate: 0, contiguous: 30 * MB, playhead: 10 * MB });
  assert.equal(r.level, 'stall');
  assert.equal(Math.round(r.stallInSec), 20);
});

test('码率未知时如实返回 unknown，不给结论', async () => {
  const { forecastStall } = await load();
  assert.equal(forecastStall({ size: GB, bitrate: 0, rate: MB, contiguous: 0 }).level, 'unknown');
});

test('播放头已经越过水位线时按零领先量算，不出现负数时长', async () => {
  const { forecastStall } = await load();
  const r = forecastStall({ size: GB, bitrate: MB, rate: 0.5 * MB, contiguous: 10 * MB, playhead: 50 * MB });
  assert.equal(r.level, 'stall');
  assert.equal(r.stallInSec, 0);
});

test('上行按码率平分：能供几个人流畅边下边播', async () => {
  const { viewersSupported } = await load();
  // 10MB/s 上行，1MB/s 码率，每人要 1.2MB/s 才算流畅 → 8 人。
  assert.equal(viewersSupported(10 * MB, MB), 8);
  assert.equal(viewersSupported(MB, MB), 0);
  assert.equal(viewersSupported(0, MB), null);
  assert.equal(viewersSupported(10 * MB, 0), null);
});

test('房主预判按房间人数平分上行', async () => {
  const { hostPrecheck } = await load();
  // 上行 6MB/s、码率 1MB/s、3 个接收者：每人 2MB/s，流畅。
  assert.equal(hostPrecheck({ uplink: 6 * MB, bitrate: MB, viewers: 3 }).level, 'ok');
  // 同样上行、7 个接收者：每人约 0.86MB/s，会卡。
  const busy = hostPrecheck({ uplink: 6 * MB, bitrate: MB, viewers: 7 });
  assert.equal(busy.level, 'stall');
  assert.equal(busy.supported, 5);
  // 5.5 个人的量刚好卡在 1~1.2 倍之间
  assert.equal(hostPrecheck({ uplink: 5.5 * MB, bitrate: MB, viewers: 5 }).level, 'thin');
  // 测不出上行或码率时不下结论
  assert.equal(hostPrecheck({ uplink: 0, bitrate: MB, viewers: 3 }).level, 'unknown');
  // 人数给 0 或乱给时至少按 1 人算，不除以零
  assert.equal(hostPrecheck({ uplink: 2 * MB, bitrate: MB, viewers: 0 }).level, 'ok');
});

test('接收速度由对方已有字节的增长算出，跨度不足时说还在测', async () => {
  const { RateMeter } = await load();
  const m = new RateMeter(8000);
  m.sample(0, 0);
  m.sample(1000, 2 * MB);
  assert.equal(m.rate, null, '1 秒的跨度太短，不给数');
  m.sample(2000, 4 * MB);
  assert.equal(m.rate, 2 * MB);
});

test('换片后已有字节变少，速度计从头开始而不是算出负数', async () => {
  const { RateMeter } = await load();
  const m = new RateMeter(8000);
  m.sample(0, 0);
  m.sample(3000, 90 * MB);
  m.sample(4000, 2 * MB); // 新片子的位图
  assert.equal(m.rate, null);
  m.sample(6000, 6 * MB);
  assert.equal(m.rate, 2 * MB);
});

test('速度计只看最近一个窗口，老样本会被丢掉', async () => {
  const { RateMeter } = await load();
  const m = new RateMeter(8000);
  m.sample(0, 0);
  for (let t = 1000; t <= 10000; t += 1000) m.sample(t, t < 5000 ? t * 10 : 40000 + (t - 4000) * 1000);
  // 窗口保留 2000~10000 的样本：(6040000-20000)/8 秒 ≈ 752500 B/s。
  // 如果没丢老样本、从 0 算起，会是 6040000/10 秒 = 604000 B/s —— 这条断言能区分两者。
  assert.ok(m.rate > 700_000, `应当只看最近 8 秒，实际 ${m.rate}`);
  assert.equal(m.samples[0].t, 2000);
});

/**
 * 预缓冲时间的骨架就是一个恒等式：等待时间 + 剩余播放时长 = 剩余下载时间。
 * 拿这条去校对，比重抄一遍被测公式有意义 —— 抄错了两边会一起错。
 */
test('预缓冲时间 = 剩余下载时间 − 剩余播放时长', async () => {
  const { bufferLead } = await load();
  // 2 小时片子，码率 1MB/s（总 7200MB），已收 200MB，速度 0.5MB/s。
  const size = 7200 * MB;
  const r = bufferLead({ size, bitrate: MB, rate: 0.5 * MB, contiguous: 200 * MB, playhead: 0 });
  const downloadSec = (size - 200 * MB) / (0.5 * MB); // 14000 秒
  assert.equal(r.waitSec, downloadSec - 7200);
  assert.equal(r.waitSec, 6800);
  // 等的这 6800 秒里又收了 3400MB，开播时手上 3600MB，正好是 3600 秒的画面。
  assert.equal(r.needBytes, 3400 * MB);
  assert.equal(r.bufferSec, 3600);
});

test('速度追得上码率时不用等，waitSec 为 0', async () => {
  const { bufferLead } = await load();
  const base = { size: 4 * GB, bitrate: MB, contiguous: 8 * MB, playhead: 0 };
  assert.equal(bufferLead({ ...base, rate: MB }).waitSec, 0);
  assert.equal(bufferLead({ ...base, rate: 2 * MB }).waitSec, 0);
  // 刚好等于码率时，开播那一刻手上有多少就一直有多少
  assert.equal(bufferLead({ ...base, rate: MB }).bufferSec, 8);
});

// 0.7 起 contiguous 由调用方传「从播放位置起连续可播到的绝对位置」（swarm.runEndFrom），
// 这条用例的名字才真正成立：中途加入时播放头之前那段空洞压根不算进等待时间。
// 函数本身没改，所以这里的期望值一个字也没动。
test('从播放头往后算，不是从文件头', async () => {
  const { bufferLead } = await load();
  const size = 1000 * MB;
  const at = (playhead) => bufferLead({ size, bitrate: MB, rate: 0.5 * MB, contiguous: 400 * MB, playhead });
  // 播放头越靠后，剩下要播的越少，能容忍的落后就越少 —— 等待时间反而更长
  assert.equal(at(0).waitSec, (600 * MB) / (0.5 * MB) - 1000);
  assert.equal(at(300 * MB).waitSec, (600 * MB) / (0.5 * MB) - 700);
  assert.ok(at(300 * MB).waitSec > at(0).waitSec);
});

test('已经收完就不用再等；速度为 0 时说等不到，而不是给个 0', async () => {
  const { bufferLead } = await load();
  const done = bufferLead({ size: 100 * MB, bitrate: MB, rate: 0, contiguous: 100 * MB, playhead: 0 });
  assert.equal(done.waitSec, 0);
  assert.equal(done.bufferSec, 100);
  const stuck = bufferLead({ size: 100 * MB, bitrate: MB, rate: 0, contiguous: 10 * MB, playhead: 0 });
  assert.equal(stuck.waitSec, Infinity);
  assert.equal(stuck.needBytes, 90 * MB);
});

test('码率或大小未知时返回 null，不编数字', async () => {
  const { bufferLead } = await load();
  const ok = { size: 100 * MB, bitrate: MB, rate: MB, contiguous: 0 };
  assert.equal(bufferLead({ ...ok, bitrate: 0 }), null);
  assert.equal(bufferLead({ ...ok, size: 0 }), null);
  assert.ok(bufferLead(ok));
});

/**
 * 界面上这两个数是并排出现的，说的必须是同一件事：forecastStall 说会卡，
 * bufferLead 就该给出一个大于 0 的等待时间；说不卡，就该是 0。
 */
test('和 forecastStall 的结论一致：报会卡才需要等，不卡就不用等', async () => {
  const { bufferLead, forecastStall } = await load();
  const size = 2000 * MB;
  for (const rate of [0.2, 0.5, 0.9, 1, 1.1, 1.5].map((x) => x * MB)) {
    for (const contiguous of [0, 100 * MB, 1000 * MB, 1900 * MB]) {
      const o = { size, bitrate: MB, rate, contiguous, playhead: 0 };
      const willStall = forecastStall(o).level === 'stall';
      const { waitSec } = bufferLead(o);
      assert.equal(waitSec > 0, willStall, `rate=${rate} contiguous=${contiguous} 两者结论不一致`);
    }
  }
});

/* ------------------- 播放位置往后有好几个空洞（A4-4） ------------------- */

/**
 * 中途加入之后往回拖（或者先往后跳、再拖回来）：空洞后面往往已经收齐了一大段。
 * 以前 [连续区尽头, 文件尾) 整段都当缺着，要等多久、会不会卡都算得离谱。
 * 例子：片子码率 b，播放头在 25%，[25%, 50%) 缺着，[50%, 100%) 早就收齐了，速度 0.8b。
 * 整段当缺着：0.75/0.8 − 0.75 = 0.1875 个片长；按空洞算：0.25/0.8 − 0.25 = 0.0625 个片长。
 */
test('预缓冲时间按空洞逐段算：空洞后面已经收齐的不算要等的', async () => {
  const { bufferLead } = await load();
  const size = 1000 * MB;
  const bitrate = MB; // 片长 1000 秒
  const o = { size, bitrate, rate: 0.8 * MB, contiguous: 250 * MB, playhead: 250 * MB };
  assert.equal(Math.round(bufferLead(o).waitSec), 188, '不给空洞时照旧按整段缺着算（0.1875 个片长）');
  const lead = bufferLead({ ...o, holes: [[250 * MB, 500 * MB]] });
  assert.equal(Math.round(lead.waitSec * 10) / 10, 62.5, '0.0625 个片长');
  // 等的这 62.5 秒收了 50MB，开播时从播放头起连续 50MB
  assert.equal(Math.round(lead.bufferSec), 50);
});

test('好几个空洞时取等得最久的那一处，而不是只看第一个或只看总量', async () => {
  const { bufferLead, forecastStall } = await load();
  const size = 1000 * MB;
  const bitrate = MB;
  const rate = 0.5 * MB;
  // 洞 1：[100,110) 很小；洞 2：[600,1000) 很大、离得远
  const holes = [
    [100 * MB, 110 * MB],
    [600 * MB, 1000 * MB],
  ];
  const o = { size, bitrate, rate, contiguous: 100 * MB, playhead: 0, holes };
  // 洞 1 末尾：10/0.5 − 110 < 0；洞 2 末尾：410/0.5 − 1000 = −180 < 0 → 不用等
  assert.equal(bufferLead(o).waitSec, 0);
  const f = forecastStall(o);
  assert.equal(f.level, 'thin', '速度低于码率，但每个洞都赶在播放头到之前补完');
  assert.equal(Math.round(f.finishSec), 820);

  // 洞 2 挪近：[300,1000) → 710/0.5 − 1000 = 420 秒
  const near = { ...o, holes: [holes[0], [300 * MB, 1000 * MB]] };
  assert.equal(Math.round(bufferLead(near).waitSec), 420);
  const g = forecastStall(near);
  assert.equal(g.level, 'stall');
  // 卡在洞 2 里：前面还欠洞 1 的 10MB；之后播放头每秒追近 0.5MB：(300 − 10) / (1 − 0.5) = 580 秒
  assert.equal(Math.round(g.stallInSec), 580);
});

test('按空洞算的会不会卡，和预缓冲时间的结论一致', async () => {
  const { bufferLead, forecastStall } = await load();
  const size = 2000 * MB;
  const shapes = [
    [[0, 2000]],
    [[100, 200], [1500, 2000]],
    [[10, 20], [30, 40], [1000, 1200]],
    [[400, 2000]],
  ];
  for (const rate of [0, 0.2, 0.5, 0.9, 1, 1.5].map((x) => x * MB)) {
    for (const shape of shapes) {
      const holes = shape.map(([a, b]) => [a * MB, b * MB]);
      const o = { size, bitrate: MB, rate, contiguous: holes[0][0], playhead: 0, holes };
      const willStall = forecastStall(o).level === 'stall';
      const { waitSec } = bufferLead(o);
      assert.equal(waitSec > 0, willStall, `rate=${rate} holes=${JSON.stringify(shape)} 两者结论不一致`);
    }
  }
});

test('空洞列表是空的：播放位置往后都收齐了；播放头之前的空洞不算', async () => {
  const { bufferLead, forecastStall } = await load();
  const o = { size: 100 * MB, bitrate: MB, rate: 0, contiguous: 40 * MB, playhead: 20 * MB, holes: [] };
  assert.equal(forecastStall(o).level, 'done');
  assert.deepEqual(bufferLead(o), { waitSec: 0, needBytes: 0, bufferSec: 80 });
  // [0, P) 在回填：不影响往后播
  assert.equal(forecastStall({ ...o, holes: [[0, 10 * MB]] }).level, 'done');
});

/* ------------------- 全员暂停还要多久（GG3-3） ------------------- */

/**
 * 引擎在余量超过恢复线（15 秒 × 码率）时就解除全员暂停。以前「约 T 后自动继续」用的是
 * 「再缓冲多久可一路看完」：4GiB、码率 1MB/s、速度 0.8MB/s、播放头 1GiB、余量 3MB 时显示约 12:44，
 * 实际约 15 秒就继续了。
 */
test('恢复要等的时间 = 恢复线里还缺的字节 ÷ 速度，不是「一路看完」要等的时间', async () => {
  const { resumeLead, bufferLead } = await load();
  const o = { size: 4 * GB, bitrate: MB, rate: 0.8 * MB, contiguous: GB + 3 * MB, playhead: GB };
  const resume = resumeLead({ ...o, resumeBytes: 15 * MB });
  assert.equal(resume.waitSec, 15, '(15MB − 3MB) / 0.8MB/s');
  assert.equal(resume.needBytes, 12 * MB);
  assert.equal(Math.round(bufferLead(o).waitSec), 764, '另一个数：一路看完要等 12:44');
});

test('恢复时间也按空洞算；速度为 0 时等不到；已经够了就是 0', async () => {
  const { resumeLead } = await load();
  const base = { size: 1000 * MB, rate: MB, playhead: 100 * MB, resumeBytes: 15 * MB };
  // [100,105) 缺、[105,112) 有、[112,120) 缺：恢复线 [100,115) 里缺 5 + 3 = 8MB
  const holes = [
    [100 * MB, 105 * MB],
    [112 * MB, 120 * MB],
  ];
  assert.equal(resumeLead({ ...base, contiguous: 100 * MB, holes }).waitSec, 8);
  assert.equal(resumeLead({ ...base, contiguous: 100 * MB, holes, rate: 0 }).waitSec, Infinity);
  assert.equal(resumeLead({ ...base, contiguous: 130 * MB }).waitSec, 0);
  // 靠近片尾：恢复线越过文件尾时只算到文件尾
  assert.equal(resumeLead({ ...base, playhead: 995 * MB, contiguous: 995 * MB }).waitSec, 5);
  assert.equal(resumeLead({ ...base, resumeBytes: 0, contiguous: 0 }), null);
});
