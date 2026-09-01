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
const MAX_INFLIGHT_PER_PEER = 4; // 每个 peer 同时最多欠我 4 片（8MB），够填满链路又不至于堆积

export class Scheduler {
  constructor({ manifest, lookaheadSeconds = DEFAULT_LOOKAHEAD_SECONDS, maxInflightPerPeer = MAX_INFLIGHT_PER_PEER }) {
    this.manifest = manifest;
    this.lookaheadSeconds = lookaheadSeconds;
    this.maxInflightPerPeer = maxInflightPerPeer;
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
  plan({ have, playbackByte, inflight, peers }) {
    const usable = peers.filter((p) => p.ready && p.remoteHave && p.inflight.size < this.maxInflightPerPeer);
    if (!usable.length) return [];

    const { critical, rest } = this.priorityList(have, playbackByte, inflight);
    const queue = [...critical, ...rest];
    const assignments = [];

    // 本轮的临时占用计数，避免把同一个 peer 的额度重复分出去
    const load = new Map(usable.map((p) => [p.peerId, p.inflight.size]));

    for (const index of queue) {
      const candidates = usable.filter(
        (p) => p.remoteHave[index] === 1 && load.get(p.peerId) < this.maxInflightPerPeer
      );
      if (!candidates.length) continue;

      // 挑「欠得最少」的；打平了看谁最近吐得快。
      candidates.sort((a, b) => {
        const d = load.get(a.peerId) - load.get(b.peerId);
        return d !== 0 ? d : b.downRate - a.downRate;
      });

      const pick = candidates[0];
      assignments.push({ peerId: pick.peerId, index });
      load.set(pick.peerId, load.get(pick.peerId) + 1);

      if (assignments.length >= usable.length * this.maxInflightPerPeer) break;
    }

    return assignments;
  }
}

export { DEFAULT_LOOKAHEAD_SECONDS, MAX_INFLIGHT_PER_PEER };
