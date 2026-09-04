/**
 * 分片调度器。
 *
 * 标准 BT 用 rarest-first（优先下最稀有的片），因为它的目标是让整个 swarm 的
 * 副本尽快扩散开、避免某片绝版。代价是下载顺序基本随机 —— 对纯下载无所谓，
 * 对边下边播是致命的：进度条 90% 了也可能第 3 分钟那片还没到。
 *
 * 这里反过来：以「当前播放位置 + 前瞻窗口」为第一优先级，窗口外才按顺序补齐。
 * 牺牲一部分 swarm 健康度，换取「点开就能看」。这在小房间（几个人一起看）里
 * 是划算的 —— 我们本来也不是要做长期存活的公共种子。
 */

const DEFAULT_LOOKAHEAD_SECONDS = 30; // 规格：未来 30 秒的窗口
const FALLBACK_LOOKAHEAD_BYTES = 32 * 1024 * 1024; // 拿不到时长时的兜底
const MAX_INFLIGHT_PER_PEER = 4; // 在途窗口下限：局域网上 4 片（8MB）已经绰绰有余
const MAX_INFLIGHT_CEILING = 12; // 上限。再深就是拿「seek 之后的空转」换吞吐，不划算
const RTT_PER_EXTRA_CHUNK_MS = 25; // 每多 25ms 往返延迟，窗口加一片
const COLD_START_RATE = 1; // 还没测出速率的新 peer 先按最乐观处理，好让它尽快被采样到

/**
 * 一个 peer 该同时欠我几片。
 *
 * 固定 4 片在局域网上够用，跨境链路上不够。一片落地到下一片开始传，中间隔着
 * 一整个请求往返：REQUEST 过去、对方读盘、帧回来。窗口小于「往返期间链路能吞下的
 * 字节数」时，链路就会按 RTT 的节奏周期性空转 —— 而用户看到的只是「跨国就是慢」。
 *
 * 两个来源取大：
 *  - 带宽时延积 / 分片大小，这是理论下界；
 *  - RTT 每 25ms 加一片。实测速率本身受窗口限制，光看 BDP 会自锁在低位
 *    （窗口小 → 速率低 → 算出的 BDP 小 → 窗口还是小），所以要有一项只看延迟。
 *
 * 局域网 RTT 1ms 时两项都算不出增量，窗口保持 4，行为和以前完全一样。
 */
function inflightWindow({ downRate = 0, rtt = 0, chunkSize = 0 } = {}) {
  if (!(rtt > 0)) return MAX_INFLIGHT_PER_PEER;
  const byLatency = MAX_INFLIGHT_PER_PEER + Math.ceil(rtt / RTT_PER_EXTRA_CHUNK_MS) - 1;
  const byBdp =
    downRate > 0 && chunkSize > 0 ? Math.ceil((downRate * (rtt / 1000)) / chunkSize) + 2 : 0;
  // 两项取大，不是取小：延迟项是「还没测出速率时的起步深度」，BDP 项是「测出来之后
  // 该有多深」。取小会让延迟项反过来压住 BDP，链路快起来了窗口也不跟着长。
  return Math.min(MAX_INFLIGHT_CEILING, Math.max(MAX_INFLIGHT_PER_PEER, byLatency, byBdp));
}

export class Scheduler {
  constructor({ manifest, lookaheadSeconds = DEFAULT_LOOKAHEAD_SECONDS, maxInflightPerPeer = null }) {
    this.manifest = manifest;
    this.lookaheadSeconds = lookaheadSeconds;
    // 不指定就按链路自适应；指定了就钉死（测试和排障要的确定性）。
    this.fixedWindow = Number.isInteger(maxInflightPerPeer) && maxInflightPerPeer > 0;
    this.maxInflightPerPeer = this.fixedWindow ? maxInflightPerPeer : MAX_INFLIGHT_PER_PEER;
    // 起播之后由 mpv 报真值。起播之前先用清单里房主带来的时长兜底 ——
    // 接收端要在还没开播时就能回答「这个片子需要多少码率、我现在的速度追不追得上」。
    this.duration = manifest?.durationSec > 0 ? manifest.durationSec : 0;
  }

  setDuration(d) {
    if (typeof d === 'number' && d > 0) this.duration = d;
  }

  get bytesPerSecond() {
    if (!this.duration) return 0;
    return this.manifest.size / this.duration;
  }

  /** 前瞻窗口对应多少字节。按平均码率估 —— VBR 下不精确，但窗口本来就是留富余的。 */
  get lookaheadBytes() {
    const bps = this.bytesPerSecond;
    return bps ? bps * this.lookaheadSeconds : FALLBACK_LOOKAHEAD_BYTES;
  }

  byteToChunk(byte) {
    return Math.max(0, Math.min(this.manifest.chunkCount - 1, Math.floor(byte / this.manifest.chunkSize)));
  }

  /** 播放位置（秒）换算成字节。mpv 给了 stream-pos 就用真值，没有才按比例估。 */
  positionToByte(seconds, streamPos) {
    if (typeof streamPos === 'number' && streamPos > 0) return streamPos;
    if (!this.duration) return 0;
    return (seconds / this.duration) * this.manifest.size;
  }

  /**
   * 排出待下分片的优先级队列。
   * @param {Uint8Array} have 本地已有位图
   * @param {number} playbackByte 当前播放的字节位置
   * @param {Set<number>} inflight 全局已在途的分片
   */
  priorityList(have, playbackByte, inflight) {
    const { chunkCount } = this.manifest;
    const startChunk = this.byteToChunk(playbackByte);
    const endChunk = this.byteToChunk(playbackByte + this.lookaheadBytes);

    const critical = [];
    const rest = [];

    // 关键窗口：正在播的位置往后 30 秒。这些片不到，播放就会卡。
    for (let i = startChunk; i <= endChunk && i < chunkCount; i++) {
      if (!have[i] && !inflight.has(i)) critical.push(i);
    }

    // 窗口外顺序补齐。从窗口末尾往后接着排，这样正常播放时下载会走在播放前面，
    // 天然形成一个不断前移的缓冲带。
    for (let i = endChunk + 1; i < chunkCount; i++) {
      if (!have[i] && !inflight.has(i)) rest.push(i);
    }
    // 播放位置之前还缺的片放最后 —— 只有用户往回 seek 才会用到。
    for (let i = 0; i < startChunk; i++) {
      if (!have[i] && !inflight.has(i)) rest.push(i);
    }

    return { critical, rest, startChunk, endChunk };
  }

  /**
   * 决定接下来向谁要哪些片。
   * @param {Array<{peerId:string, remoteHave:Uint8Array, inflight:Set<number>, downRate:number, ready:boolean}>} peers
   * @returns {Array<{peerId:string, index:number}>}
   */
  /** 这个 peer 现在的在途窗口。构造时显式指定了就用固定值（测试要的确定性）。 */
  windowFor(peer) {
    if (this.fixedWindow) return this.maxInflightPerPeer;
    return inflightWindow({
      downRate: peer?.downRate || 0,
      rtt: peer?.rtt || 0,
      chunkSize: this.manifest?.chunkSize || 0,
    });
  }

  plan({ have, playbackByte, inflight, peers }) {
    const windows = new Map(peers.map((p) => [p.peerId, this.windowFor(p)]));
    const usable = peers.filter(
      (p) => p.ready && p.remoteHave && p.inflight.size < windows.get(p.peerId)
    );
    if (!usable.length) return [];

    const { critical, rest } = this.priorityList(have, playbackByte, inflight);
    const queue = [...critical, ...rest];
    const assignments = [];

    // 本轮的临时占用计数，避免把同一个 peer 的额度重复分出去
    const load = new Map(usable.map((p) => [p.peerId, p.inflight.size]));

    // 还没测出速率的 peer 先按已知最快处理。给 0 会让它永远排在最后，
    // 于是永远拿不到片、也就永远测不出速率 —— 新来的上游会被活活饿死。
    const known = usable.map((p) => p.downRate || 0).filter((r) => r > 0);
    const optimistic = known.length ? Math.max(...known) : COLD_START_RATE;
    const rateOf = (p) => (p.downRate > 0 ? p.downRate : optimistic);
    const chunkSize = this.manifest.chunkSize;

    // 「这片交给他，大概多久能到手」= 他前面还欠的片数 × 每片耗时。
    // 原来只按欠的片数轮流分，一个上行慢十倍的人照样分到 1/N 的关键片，
    // 整个关键窗口就被拖到他的速度上。跨境房间里这种速度差是常态。
    const eta = (p) => ((load.get(p.peerId) + 1) * chunkSize) / rateOf(p);
    const capacity = usable.reduce((sum, p) => sum + windows.get(p.peerId), 0);

    for (const index of queue) {
      let pick = null;
      let best = Infinity;
      for (const p of usable) {
        if (p.remoteHave[index] !== 1) continue;
        if (load.get(p.peerId) >= windows.get(p.peerId)) continue;
        const score = eta(p);
        if (score < best) {
          best = score;
          pick = p;
        }
      }
      if (!pick) continue;

      assignments.push({ peerId: pick.peerId, index });
      load.set(pick.peerId, load.get(pick.peerId) + 1);

      if (assignments.length >= capacity) break;
    }

    return assignments;
  }
}

export { DEFAULT_LOOKAHEAD_SECONDS, MAX_INFLIGHT_PER_PEER, MAX_INFLIGHT_CEILING, inflightWindow };
