/**
 * 卡顿预判。纯函数，不碰 DOM 也不碰网络，方便单独测。
 *
 * 所有速率一律用「字节/秒」，只在界面上才换算成 Mbps —— 在这里混单位，
 * 一个 8 倍的错就能让「够用」和「会卡」互相颠倒。
 */

/**
 * 速度至少是码率的多少倍才算稳。
 *
 * 刚好等于码率是不够的：码率是全片平均，动作戏的瞬时码率能到均值的两三倍；
 * P2P 路径抖一下、调度器换一个上游，都要吃掉余量。1.2 是现有传输面板一直在用的门槛。
 */
export const SMOOTH_MARGIN = 1.2;

/** 码率（字节/秒）= 文件大小 ÷ 时长。时长未知时返回 0，调用方据此显示「未知」而不是瞎猜。 */
export function bitrateOf(size, durationSec) {
  if (!(size > 0) || !(durationSec > 0)) return 0;
  return size / durationSec;
}

/**
 * 播放位置往后还缺的那几段，[起, 止) 绝对字节位置，按位置排好。
 *
 * 调用方给了 holes（swarm.missingRangesFrom 按位图算的）就用它；没给就退回旧的近似：
 * 从连续区尽头 contiguous 到文件尾整段都当缺着。中途加入之后往回拖、或者先往后跳
 * 再拖回来时，空洞后面往往已经收齐了一大段，整段当缺着会把等待时间高估好几倍。
 */
function gapsAhead({ size, contiguous, playhead, holes }) {
  const head = Math.max(0, Math.min(size, playhead || 0));
  if (!Array.isArray(holes)) {
    const from = Math.max(head, Math.min(size, contiguous || 0));
    return from < size ? [[from, size]] : [];
  }
  const out = [];
  for (const hole of holes) {
    const a = Math.max(head, Math.min(size, hole?.[0] || 0));
    const b = Math.max(head, Math.min(size, hole?.[1] || 0));
    if (b > a) out.push([a, b]);
  }
  return out;
}

/**
 * 预判一个成员边下边播会不会卡。
 *
 * 模型：下载按顺序把播放位置往后的空洞一段段补上（调度器就是播放位置优先、再顺序补齐），
 * 以 rate 往前推；播放头以 bitrate 往前推。播放头在某个空洞里追上正在补的位置，
 * 就是卡住的时刻；如果每个空洞都赶在播放头到达之前补完，就永远不会卡 —— 哪怕速度低于码率。
 * 这一点很重要：一个已经缓冲了大半部片子的人，速度掉到码率以下也不该被报「会卡」。
 *
 * 只有一个空洞（从连续区尽头到文件尾）时，就是「播放头追上水位线之前水位线能不能先推到文件尾」。
 *
 * 暂停中的房间按「现在恢复播放」算，这正是用户想知道的。
 *
 * @param {object} o
 * @param {number} o.size        文件总字节
 * @param {number} o.bitrate     码率，字节/秒
 * @param {number} o.rate        该成员当前实际接收速度，字节/秒
 * @param {number} o.contiguous  该成员从**当前播放位置**起连续可播到的绝对字节位置
 *   （swarm.runEndFrom(playhead)）。从片头起播时它就是旧的「从文件头起的水位线」；
 *   中途加入房间时两者相差整整一部片，传错那个会把晚到的人判成一直在卡。
 * @param {number} [o.playhead]  当前播放到的字节位置
 * @param {Array<[number, number]>} [o.holes] 播放位置往后还缺的各段（见 gapsAhead）；
 *   不给就把 [contiguous, size) 整段当缺着
 * @returns {{level: 'unknown'|'done'|'ok'|'thin'|'stall', margin?: number, stallInSec?: number, finishSec?: number}}
 *   - done  播放位置往后都收齐了（[0, 播放位置) 可能还缺着：「已收完」要调用方另看）
 *   - ok    速度有余量
 *   - thin  不会卡但没余量：速度在码率的 1~1.2 倍之间，或者速度不够但缓冲撑得到收完
 *   - stall 按现在的速度会卡，stallInSec 是还能播多久
 */
export function forecastStall({ size, bitrate, rate, contiguous, playhead = 0, holes }) {
  if (!(size > 0)) return { level: 'unknown' };
  const head = Math.max(0, Math.min(size, playhead || 0));
  const gaps = gapsAhead({ size, contiguous, playhead: head, holes });
  if (!gaps.length) return { level: 'done' };
  if (!(bitrate > 0)) return { level: 'unknown' };

  const speed = rate > 0 ? rate : 0;
  const margin = speed / bitrate;

  if (margin >= SMOOTH_MARGIN) return { level: 'ok', margin };
  if (margin >= 1) return { level: 'thin', margin };

  // 速度不够：逐个空洞看，补到这个空洞末尾之前播放头会不会先到。
  // 空洞里下载比播放慢，差距越拉越大，所以只看每个空洞的末尾就够了。
  let before = 0; // 这个空洞前面还缺的字节（下载得先补完它们）
  for (const [a, b] of gaps) {
    const lateSec = speed > 0 ? (before + (b - a)) / speed - (b - head) / bitrate : Infinity;
    if (lateSec > 0) {
      // 卡在这个空洞里：播放头先到空洞口（下载还没补到这儿），或者在洞里追上正在补的位置
      const stallInSec = Math.max((a - head) / bitrate, (a - head - before) / (bitrate - speed));
      return { level: 'stall', margin, stallInSec };
    }
    before += b - a;
  }
  return { level: 'thin', margin, finishSec: before / speed };
}

/**
 * 「先攒多久，之后就能一路看到尾不再卡」。
 *
 * 推导完只剩一句话：**要等的时间 = 剩余下载时间 − 剩余播放时长**。
 * 片尾那个字节不下完就播不到片尾，所以「播完」这一刻不可能早于「下完」这一刻；
 * 把两条时间线的终点对齐，前面多出来的那一段就是开播前必须先等掉的。
 *
 * 这也顺带解释了速度够快时为什么是 0：下载先结束，播放头这辈子追不上水位线。
 *
 * 不套 SMOOTH_MARGIN。这个数是「刚好不卡」的临界值，界面上明说了是按当前速度算的；
 * 乘个 1.2 得到的既不是临界值也不是任何可解释的东西，还会和旁边「余量很薄」的提示打架。
 *
 * @param {object} o
 * @param {number} o.size        文件总字节
 * @param {number} o.bitrate     码率，字节/秒
 * @param {number} o.rate        当前接收速度，字节/秒
 * @param {number} o.contiguous  从**当前播放位置**起连续可播到的绝对字节位置（同上）。
 *   用它而不是从文件头起的水位线，「把前方补到尾还要多久」才不会把 [0,播放位置)
 *   那段回填也算进等待时间 —— 那段补不补都不影响这一场看完。
 * @param {number} [o.playhead]  当前播放到的字节位置
 * @param {Array<[number, number]>} [o.holes] 播放位置往后还缺的各段（同 forecastStall）
 * @returns {{waitSec: number, needBytes: number, bufferSec: number}|null}
 *   waitSec 还要等多久才能开播（0 = 现在开播就能一路播完；Infinity = 速度为 0，等不到）；
 *   needBytes 这段时间要再收的字节；bufferSec 开播那一刻手上有多少秒的可播内容。
 *   码率或大小未知时返回 null，由调用方显示「未知」而不是编一个数。
 *
 * 播放位置往后有好几个空洞时，「下完」和「播完」要在每个空洞的末尾各对齐一次，取等得最久的
 * 那一处：先补完第一个空洞、后面已经收齐的那段直接播过去，比「剩下全部重下一遍」快得多。
 */
export function bufferLead({ size, bitrate, rate, contiguous, playhead = 0, holes }) {
  if (!(size > 0) || !(bitrate > 0)) return null;

  const head = Math.max(0, Math.min(size, playhead || 0));
  const gaps = gapsAhead({ size, contiguous, playhead: head, holes });
  if (!gaps.length) return { waitSec: 0, needBytes: 0, bufferSec: (size - head) / bitrate };

  const missing = gaps.reduce((sum, [a, b]) => sum + (b - a), 0);
  const speed = rate > 0 ? rate : 0;
  if (!speed) return { waitSec: Infinity, needBytes: missing, bufferSec: Infinity };

  let waitSec = 0;
  let upTo = 0; // 补到这个空洞末尾一共要收的字节
  for (const [a, b] of gaps) {
    upTo += b - a;
    waitSec = Math.max(waitSec, upTo / speed - (b - head) / bitrate);
  }
  const needBytes = waitSec * speed;
  return { waitSec, needBytes, bufferSec: (runEndAfter(gaps, needBytes, size) - head) / bitrate };
}

/** 按顺序把空洞补掉 bytes 个字节之后，从播放位置起连续可播到哪。 */
function runEndAfter(gaps, bytes, size) {
  let left = bytes;
  for (const [a, b] of gaps) {
    if (left < b - a) return a + left;
    left -= b - a;
  }
  return size;
}

/**
 * 卡住的人还要多久才攒够、全员暂停自动解除。
 *
 * 和 bufferLead 不是一回事：bufferLead 是「先攒多久，之后一路看到尾不再卡」，
 * 同步引擎却是从播放位置起的连续数据超过恢复线（15 秒 × 码率）就松口 —— 速度低于码率时，
 * 前者常常是十几分钟，后者只要十几秒（之后多半会再卡，那是另一件事）。
 * 横幅和播放器里的「约 T 后自动继续」说的是后者。
 *
 * 全员暂停时播放头不动，所以只是「把 [播放位置, 播放位置 + 恢复线) 里还缺的字节收完」。
 *
 * @param {object} o
 * @param {number} o.size         文件总字节
 * @param {number} o.rate         当前接收速度，字节/秒
 * @param {number} o.contiguous   从播放位置起连续可播到的绝对字节位置（同上）
 * @param {number} [o.playhead]   当前播放到的字节位置
 * @param {Array<[number, number]>} [o.holes] 播放位置往后还缺的各段（同上）
 * @param {number} o.resumeBytes  恢复线（同步引擎的 resumeThresholdBytes）
 * @returns {{waitSec: number, needBytes: number}|null} 速度为 0 时 waitSec 为 Infinity；大小未知返回 null
 */
export function resumeLead({ size, rate, contiguous, playhead = 0, holes, resumeBytes }) {
  if (!(size > 0) || !(resumeBytes > 0)) return null;
  const head = Math.max(0, Math.min(size, playhead || 0));
  const target = Math.min(size, head + resumeBytes);
  let needBytes = 0;
  for (const [a, b] of gapsAhead({ size, contiguous, playhead: head, holes })) {
    if (a >= target) break;
    needBytes += Math.min(b, target) - a;
  }
  if (!needBytes) return { waitSec: 0, needBytes: 0 };
  return { waitSec: rate > 0 ? needBytes / rate : Infinity, needBytes };
}

/**
 * 一屋子人里还要等多久才能恢复播放。
 *
 * 取最慢的那个 —— 全员暂停要等所有人都攒够才解除，谁最慢就等谁。
 * 任何一个人算不出来（速度还没测出来、码率未知、速度为 0）就整个返回 null：
 * 少一个人的数，剩下那个「最大值」必然偏乐观，宁可不给数也别让人白等。
 *
 * @param {Array<{waitSec: number}|null|undefined>} leads 每个卡住的人的 bufferLead 结果
 * @returns {number|null} 秒；无人需要等或算不出来时为 null
 */
export function worstWaitSeconds(leads) {
  let worst = 0;
  for (const lead of leads) {
    if (!lead || !Number.isFinite(lead.waitSec)) return null;
    worst = Math.max(worst, lead.waitSec);
  }
  return worst > 0 ? worst : null;
}

/**
 * 房主的上行按码率能同时供几个人流畅边下边播。
 *
 * 按「上行被所有接收者平分」算。极简模式是星型拓扑，本来就只有房主一个上游；
 * 信令模式虽然成员之间能互相供片，但播放位置优先调度让大家同一时刻要的是同一批片，
 * 播放前沿的那几片只有房主手里有 —— 所以平分是贴近实际的保守估计，不是悲观假设。
 *
 * @returns {number|null} 人数；带宽或码率未知时为 null
 */
export function viewersSupported(uplink, bitrate) {
  if (!(uplink > 0) || !(bitrate > 0)) return null;
  return Math.floor(uplink / (bitrate * SMOOTH_MARGIN));
}

/**
 * 房主选片时的预判：按房间人数上限，每个人分到的上行够不够这个码率。
 *
 * @param {object} o
 * @param {number} o.uplink   上行带宽，字节/秒
 * @param {number} o.bitrate  码率，字节/秒
 * @param {number} o.viewers  预计同时接收的人数（房间人数上限减去房主自己）
 * @returns {{level: 'unknown'|'ok'|'thin'|'stall', perViewer?: number, margin?: number, supported?: number|null}}
 */
export function hostPrecheck({ uplink, bitrate, viewers }) {
  if (!(uplink > 0) || !(bitrate > 0)) return { level: 'unknown' };
  const n = Math.max(1, Math.floor(viewers) || 1);
  const perViewer = uplink / n;
  const margin = perViewer / bitrate;
  const supported = viewersSupported(uplink, bitrate);
  const level = margin >= SMOOTH_MARGIN ? 'ok' : margin >= 1 ? 'thin' : 'stall';
  return { level, perViewer, margin, supported };
}

/**
 * 从「对方手里已有多少字节」随时间的增长，算出对方的实际接收速度。
 *
 * 为什么不直接用本机统计的 upRate：信令模式下成员能从多个人那里同时收片，
 * 本机只看得到自己发给他的那一份。对方位图的增长是他从所有来源收到的总和，
 * 在两种模式下都准，而且不需要改协议 —— HAVE 消息本来就会逐片发过来。
 */
export class RateMeter {
  constructor(windowMs = 8000) {
    this.windowMs = windowMs;
    this.samples = [];
  }

  sample(now, totalBytes) {
    const last = this.samples[this.samples.length - 1];
    // 总量变少只可能是换片后位图重置了，旧样本不再可比。
    if (last && totalBytes < last.total) this.samples = [];
    this.samples.push({ t: now, total: totalBytes });
    const cutoff = now - this.windowMs;
    while (this.samples.length > 2 && this.samples[1].t <= cutoff) this.samples.shift();
  }

  /** 字节/秒。样本跨度不足 1.5 秒时返回 null —— 刚连上时宁可说「还在测」，也不给一个抖动的数。 */
  get rate() {
    if (this.samples.length < 2) return null;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const span = last.t - first.t;
    if (span < 1500) return null;
    return ((last.total - first.total) * 1000) / span;
  }
}
