import { Emitter } from './emitter.js';
import {
  MSG,
  encodeFrames,
  decodeFrame,
  BUFFER_HIGH_WATER,
  BUFFER_LOW_WATER,
  PROTOCOL_VERSION,
} from './protocol.js';
import { pruneSdpCandidates, summarizeCandidates, hasRelay, parseCandidateLine } from './ice.js';

const MAX_PENDING_CANDIDATES = 128; // 排队上限，别让对面用候选把内存灌爆
// DataChannel 单条消息的安全上限。超过它的 send() 会让整条通道断掉，
// 表现成莫名其妙的掉线 —— 宁可这里拒发并留下日志。大消息要走 PART 分段。
const MAX_CTRL_BYTES = 60 * 1024;
// 收端单条控制消息的长度上限（UTF-16 码元）。发端（0.7.0 起）按 UTF-8 字节拒发超过 60KB 的，
// 码元数不会多于字节数，所以合法消息一定在这以内；更长的只会是有人专门喂来的大 JSON。
const MAX_CTRL_IN_CHARS = 64 * 1024;

/**
 * 控制消息的收端预算（按连接记，令牌桶）。
 *
 * ctrl 上的每条消息都要 JSON.parse，再交给上层处理 —— 渲染进程只有一个线程，
 * 一个成员按链路速度灌消息，就能把界面和调度一起拖住。合法流量的量级：
 * 千兆局域网上每秒几十条 HAVE / REQUEST，进房那一下几百条位图和列表分段；
 * 这里的上限留了十倍以上的余量，超出的直接丢掉、不解析。
 * 分段清单是例外：它是我方点名要的，几十 MB 一口气到是正常的（大文件的哈希表），
 * 只在 swarm 正向这个人要清单（bulkManifest）时放行，且上层会把没用上的分段补记进预算。
 */
const CTRL_MSG_BURST = 4000;
const CTRL_MSG_PER_SEC = 500;
const CTRL_BYTES_BURST = 32 * 1024 * 1024;
const CTRL_BYTES_PER_SEC = 4 * 1024 * 1024;
const MANIFEST_PART_PREFIX = `{"t":"${MSG.MANIFEST_PART}"`;
// PING 正常三秒一条。回 PONG 按这个节奏限一下，别让人拿 PING 把我方的 ctrl 通道当回声墙
const PONG_BURST = 4;
const PONG_PER_SEC = 1;
// 只认自己发出去的 PING 的回声，最多记这么多条还没回的
const MAX_OUTSTANDING_PINGS = 4;
// 往返时延超过这个数的样本不收：真实链路到不了，只可能是伪造或者积压得不成样子
const MAX_RTT_MS = 30_000;

/**
 * 单个 P2P 连接。
 *
 * 发起方建通道，应答方等 ondatachannel。两条通道：ctrl（JSON）和 data（二进制）。
 *
 * 关于 ICE 模式：
 *  - trickle=true：候选地址边收集边发，连得快，需要信令服务器持续在线。
 *  - trickle=false：等候集齐所有候选再产出一份完整 SDP，慢几秒，但换来
 *    「一段文本复制粘贴就能连上」—— 这就是极简模式（零服务器）的实现基础。
 *
 * iceTransportPolicy：'all'（默认）或 'relay'。'relay' 是「隐藏我的 IP」：浏览器只收集中继候选，
 * SDP 和 trickle 出去的候选里都不会有本机地址。别的值一律当 'all'。
 */
export class Peer extends Emitter {
  constructor({ peerId, name, initiator, iceServers, iceTransportPolicy = 'all', trickle = true, allowIdentityRename = false }) {
    super();
    this.peerId = peerId;
    this.name = name || peerId;
    this.initiator = initiator;
    this.trickle = trickle;
    this.iceTransportPolicy = iceTransportPolicy === 'relay' ? 'relay' : 'all';
    // 信令层已经确认身份后必须钉死 peerId。只有极简模式在尚未知晓应答方身份、
    // 且明确使用占位 ID 时，调用方才可以单独放开一次改名。
    this.allowIdentityRename = allowIdentityRename === true;
    this.authenticated = false;
    this.closed = false;

    this.ctrl = null;
    this.data = null;
    this.platform = null; // HELLO 里对方报的平台：windows / mac / linux / android，老电脑端是 desktop
    // 对方每个文件槽位上有哪些分片：slot -> { have: Uint8Array }
    this.remote = new Map();
    this.inflight = new Set(); // 我方已向该 peer 请求、还没收齐的分片，键是 "槽位:下标"
    this._drainWaiters = new Set(); // 正在等 data 缓冲回落的 sendChunk，关连接时要统一放掉
    this._pendingCandidates = []; // 远端描述落地前先攒着的 ICE 候选
    this.rtt = null;
    // 本机收集到的候选类型。连不上的时候这是唯一能指路的东西 —— 没有 srflx
    // 说明 STUN 不通，有 srflx 没 relay 说明只能靠打洞。见 ice.js 的 diagnoseCandidates()。
    this.candidateTypes = new Set();
    // 解析过的本机候选。判对称 NAT 要按「同一个本地基地址映射出几个公网端点」分组，
    // 光有类型集合不够。信令模式下候选是一条条冒出来的，SDP 里看不到，只能在这儿攒。
    this.localCandidates = [];
    // 最近几条 ICE 候选错误。这是唯一能分清「TURN 密码错」和「TURN 地址连不上」的信息源。
    this.candidateErrors = [];
    this.localCandidateStats = null;
    this._sentCandidateKeys = new Set();
    this._expectRelay = hasRelay(iceServers);
    this.bytesReceived = 0;
    this.bytesSent = 0;
    this._lastRecvSample = { t: performance.now(), bytes: 0 };
    this._lastSendSample = { t: performance.now(), bytes: 0 };
    this.downRate = 0;
    this.upRate = 0;
    // 控制消息收端预算，见 CTRL_MSG_BURST 的说明
    this._ctrlBudget = { msgs: CTRL_MSG_BURST, bytes: CTRL_BYTES_BURST, at: performance.now() };
    this.ctrlDropped = 0;
    // swarm 正在向他要分段清单：这段时间里清单分段不占预算
    this.bulkManifest = false;
    this._pongBudget = { tokens: PONG_BURST, at: performance.now() };
    this._outstandingPings = [];

    this.pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: this.iceTransportPolicy,
      iceCandidatePoolSize: 4,
      bundlePolicy: 'max-bundle',
    });

    this.pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const json = e.candidate.toJSON();
      const parsed = parseCandidateLine(`a=${json.candidate}`) || parseCandidateLine(json.candidate || '');
      if (parsed) {
        this.candidateTypes.add(parsed.type);
        if (this.localCandidates.length < 64) this.localCandidates.push(parsed);
      }
      if (!this.trickle) return;
      // 多台 STUN 会对同一个 NAT 映射各报一次，内容完全一样。重复候选传过去
      // 只会让对端多试几遍同一个地址，白白占信令带宽和配对时间。
      if (parsed) {
        const key = `${parsed.component}|${parsed.protocol}|${parsed.address}|${parsed.port}|${parsed.type}`;
        if (this._sentCandidateKeys.has(key)) return;
        this._sentCandidateKeys.add(key);
        if (String(parsed.address).toLowerCase().startsWith('fe80:')) return; // 链路本地，连不通
      }
      this.emit('icecandidate', json);
    };
    // ICE 候选收集失败。这是唯一能把「TURN 凭据不对」和「TURN 根本连不上」分开的事件：
    // 光看「配了 TURN 却没有 relay 候选」只知道有一项不对，不知道是哪一项。
    // 按 url + 错误码去重，STUN/TURN 重试时同一条会反复来。
    this.pc.onicecandidateerror = (e) => {
      const key = `${e.url}|${e.errorCode}`;
      if (this.candidateErrors.some((x) => x.key === key)) return;
      if (this.candidateErrors.length >= 8) return;
      this.candidateErrors.push({
        key,
        url: String(e.url || ''),
        errorCode: Number(e.errorCode) || 0,
        errorText: String(e.errorText || ''),
      });
    };
    this.pc.oniceconnectionstatechange = () => {
      const s = this.pc.iceConnectionState;
      this.emit('statechange', s);
      if (s === 'failed' || s === 'closed') this.emit('failed', s);
      if (s === 'disconnected') this.emit('disconnected', s);
    };
    this.pc.onconnectionstatechange = () => this.emit('connectionstate', this.pc.connectionState);

    if (initiator) {
      this._setupChannel((this.ctrl = this.pc.createDataChannel('ctrl', { ordered: true })), 'ctrl');
      this._setupChannel(
        (this.data = this.pc.createDataChannel('data', { ordered: true })),
        'data'
      );
    } else {
      this.pc.ondatachannel = (e) => {
        const ch = e.channel;
        if (ch.label === 'ctrl') this._setupChannel((this.ctrl = ch), 'ctrl');
        else if (ch.label === 'data') this._setupChannel((this.data = ch), 'data');
      };
    }
  }

  _setupChannel(ch, kind) {
    ch.binaryType = 'arraybuffer';
    ch.bufferedAmountLowThreshold = BUFFER_LOW_WATER;

    ch.onopen = () => {
      if (this.ctrl?.readyState === 'open' && this.data?.readyState === 'open') {
        this.emit('open');
      }
    };
    ch.onclose = () => {
      if (!this.closed) this.emit('close');
    };
    ch.onerror = (e) => this.emit('error', e?.error || new Error(`${kind} 通道出错`));

    if (kind === 'ctrl') {
      ch.onmessage = (e) => {
        if (typeof e.data !== 'string' || e.data.length > MAX_CTRL_IN_CHARS) return;
        const bulk = this.bulkManifest && e.data.startsWith(MANIFEST_PART_PREFIX);
        if (!bulk && !this.chargeCtrl(e.data.length)) return;
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return;
        this._onCtrl(msg);
      };
    } else {
      ch.onmessage = (e) => {
        const f = decodeFrame(e.data);
        if (!f) return;
        this.emit('frame', f);
        // 只有被 swarm 收下的帧（正向他要的那一片、帧号和长度都对）才算他的速率。
        // 不然谁都能灌几个 12 字节的空帧把速率撑成一个很小的正数 —— 请求超时按速率估，
        // 速率越小超时越长，那几片就一直挂在他名下，别人也不会去要。
        if (f.accepted !== true) return;
        this.bytesReceived += e.data.byteLength;
        this._sampleRate();
      };
    }
  }

  /**
   * 从控制消息预算里扣一笔（一条消息 + 它的字节数）。不够就返回 false，调用方把消息丢掉。
   * 上层发现某条放行过的消息其实没用（比如不请自来的清单分段）时也会来补扣。
   */
  chargeCtrl(bytes, msgs = 1) {
    const b = this._ctrlBudget;
    const now = performance.now();
    const elapsed = now > b.at ? (now - b.at) / 1000 : 0;
    b.at = now;
    b.msgs = Math.min(CTRL_MSG_BURST, b.msgs + elapsed * CTRL_MSG_PER_SEC);
    b.bytes = Math.min(CTRL_BYTES_BURST, b.bytes + elapsed * CTRL_BYTES_PER_SEC);
    const n = Math.max(0, Number(bytes) || 0);
    if (b.msgs < msgs || b.bytes < n) {
      if (this.ctrlDropped++ === 0) console.warn(`[peer] ${this.name} 的控制消息太密，超出的先丢掉`);
      return false;
    }
    b.msgs -= msgs;
    b.bytes -= n;
    return true;
  }

  _sampleRate() {
    const now = performance.now();
    const dt = now - this._lastRecvSample.t;
    if (dt < 500) return;
    this.downRate = ((this.bytesReceived - this._lastRecvSample.bytes) * 1000) / dt;
    this._lastRecvSample = { t: now, bytes: this.bytesReceived };
  }

  _sampleUploadRate() {
    const now = performance.now();
    const dt = now - this._lastSendSample.t;
    if (dt < 500) return;
    this.upRate = ((this.bytesSent - this._lastSendSample.bytes) * 1000) / dt;
    this._lastSendSample = { t: now, bytes: this.bytesSent };
  }

  _onCtrl(msg) {
    if (msg.t === MSG.PING) {
      // ts 原样回过去，所以只回数字，而且按 PING 的正常节奏限速
      if (Number.isFinite(msg.ts) && this._takePong()) this.send({ t: MSG.PONG, ts: msg.ts });
      return;
    }
    if (msg.t === MSG.PONG) {
      // 只认自己发出去的那几条 PING 的回声。ts 是对方填回来的：不核对的话，
      // 一条 ts=-1e13 的 PONG 就能把往返时延报成几百年，请求超时和在途窗口都跟着失真
      const i = this._outstandingPings.indexOf(msg.ts);
      if (i === -1) return;
      this._outstandingPings.splice(0, i + 1); // 比它早发的那几条也不用再等了
      const rtt = performance.now() - msg.ts;
      if (!(rtt >= 0 && rtt <= MAX_RTT_MS)) return;
      this.rtt = rtt;
      this.emit('rtt', this.rtt);
      return;
    }
    this.emit('ctrl', msg);
  }

  _takePong() {
    const b = this._pongBudget;
    const now = performance.now();
    if (now > b.at) b.tokens = Math.min(PONG_BURST, b.tokens + ((now - b.at) / 1000) * PONG_PER_SEC);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /* ------------------------------ 信令握手 ------------------------------ */

  async createOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    if (!this.trickle) await this._waitIceComplete();
    return this._localDescription();
  }

  async acceptOffer(desc) {
    await this.pc.setRemoteDescription(desc);
    await this._flushPendingCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    if (!this.trickle) await this._waitIceComplete();
    return this._localDescription();
  }

  async acceptAnswer(desc) {
    await this.pc.setRemoteDescription(desc);
    await this._flushPendingCandidates();
  }

  async addIceCandidate(c) {
    // 远端描述还没设进去时不能加候选 —— WebRTC 会抛错，候选就这么没了。
    // trickle 模式下 SDP 和候选是并发到达的，而 setRemoteDescription 是异步的，
    // 早到的那批（往往正是最有用的同网段主机候选）很容易撞进这个窗口，
    // 丢掉就表现为「有时怎么都连不上」。先排队，等远端描述落地再补。
    if (!this.pc.remoteDescription) {
      if (this._pendingCandidates.length < MAX_PENDING_CANDIDATES) this._pendingCandidates.push(c);
      return;
    }
    try {
      await this.pc.addIceCandidate(c);
    } catch (e) {
      console.warn('[peer] 添加 ICE 候选失败', e);
    }
  }

  async _flushPendingCandidates() {
    const queued = this._pendingCandidates;
    this._pendingCandidates = [];
    for (const candidate of queued) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (e) {
        console.warn('[peer] 补加排队的 ICE 候选失败', e);
      }
    }
  }

  /**
   * 产出要发出去的那份本地描述：候选去重、去掉链路本地地址。
   *
   * 只精简发出去的副本，本地 ICE agent 的候选表保持完整 —— 删掉的都是
   * 多台 STUN 对同一个 NAT 映射的重复上报，对端少试几次完全等价。
   * 极简模式下这一步直接决定邀请码有多长。
   */
  _localDescription() {
    const desc = this.pc.localDescription.toJSON();
    const { sdp, removed } = pruneSdpCandidates(desc.sdp);
    this.localCandidateStats = summarizeCandidates(sdp);
    if (removed) console.debug(`[peer] SDP 去掉了 ${removed} 条重复/无用候选`);
    return { ...desc, sdp };
  }

  /**
   * 等 ICE 收集完成，非 trickle 模式下 SDP 必须包含全部候选才能离线交换。
   *
   * 收集不是「越久越全」：拿到公网映射地址之后再来的候选，绝大多数是另外几台
   * STUN 报回来的同一个地址。所以一旦手上有了 srflx（配了 TURN 的还要等到 relay），
   * 再静一小段没有新候选就收工 —— 极简模式下省下的每一秒都是用户盯着
   * 「正在生成邀请码」干等的时间。硬超时兜底不变。
   */
  _waitIceComplete({ timeoutMs = 8000, quietMs = 1200 } = {}) {
    if (this.pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      let quiet = null;
      const done = () => {
        clearTimeout(quiet);
        clearTimeout(timer);
        this.pc.removeEventListener('icegatheringstatechange', check);
        this.pc.removeEventListener('icecandidate', onCandidate);
        resolve();
      };
      const armQuiet = () => {
        if (!this.candidateTypes.has('srflx') && !this.candidateTypes.has('relay')) return;
        // 配了 TURN 就一定要等到中继候选。它比 srflx 慢，抢跑会把兜底手段扔掉，
        // 而兜底恰恰是严格 NAT 下唯一能连上的那条路。
        if (this._expectRelay && !this.candidateTypes.has('relay')) return;
        clearTimeout(quiet);
        quiet = setTimeout(done, quietMs);
      };
      const onCandidate = (e) => (e.candidate ? armQuiet() : done());
      const check = () => {
        if (this.pc.iceGatheringState === 'complete') done();
      };
      // 超时也要放行：某些网络下 STUN 不通会一直卡在 gathering，
      // 拿已有的候选去试也好过永远连不上。
      const timer = setTimeout(done, timeoutMs);
      this.pc.addEventListener('icegatheringstatechange', check);
      this.pc.addEventListener('icecandidate', onCandidate);
      armQuiet(); // 候选可能在两次 await 之间就已经到齐了
    });
  }

  /* ------------------------------ 收发数据 ------------------------------ */

  send(msg) {
    if (this.ctrl?.readyState !== 'open') return false;
    const text = JSON.stringify(msg);
    // 一个字符最多 3 个 UTF-8 字节，短消息不必真去编码
    if (text.length * 3 > MAX_CTRL_BYTES && new TextEncoder().encode(text).length > MAX_CTRL_BYTES) {
      console.warn(`[peer] 控制消息 ${msg.t} 太大（${text.length} 字符），已拒发`);
      return false;
    }
    this.ctrl.send(text);
    return true;
  }

  hello(peerId, name, securityMode = 'safe', platform = 'desktop') {
    this.send({ t: MSG.HELLO, peerId, name, ver: PROTOCOL_VERSION, securityMode, platform });
  }

  ping() {
    this._sampleRate();
    this._sampleUploadRate();
    const ts = performance.now();
    if (!this.send({ t: MSG.PING, ts })) return;
    this._outstandingPings.push(ts);
    if (this._outstandingPings.length > MAX_OUTSTANDING_PINGS) this._outstandingPings.shift();
  }

  /**
   * 发一个分片。切帧 + 背压：缓冲满了就等它排空，
   * 不然几个大分片就能把内存顶爆，而且 ctrl 通道的延迟也会被拖垮。
   */
  async sendChunk(slot, chunkIndex, buffer) {
    if (this.data?.readyState !== 'open') throw new Error('数据通道未打开');
    const frames = encodeFrames(slot, chunkIndex, buffer);
    for (const frame of frames) {
      if (this.data.readyState !== 'open') throw new Error('发送途中数据通道关闭');
      if (this.data.bufferedAmount > BUFFER_HIGH_WATER) {
        await this._drain();
        if (this.closed || this.data.readyState !== 'open') throw new Error('发送途中数据通道关闭');
      }
      this.data.send(frame);
      this.bytesSent += frame.byteLength;
      this._sampleUploadRate();
    }
  }

  /**
   * 等 data 缓冲回落。通道关掉时必须落定（reject），不能一直挂着：
   * 关闭后 bufferedAmount 不会归零，bufferedamountlow 永远等不到；pc.close() 按规范
   * 连 close 事件都不发。挂住的 sendChunk 会让上层发片计数永远扣不回去 ——
   * swarm 的「当前这部优先」据此判断还有没有人在收，于是后面几部的片再也发不出去。
   */
  _drain() {
    return new Promise((resolve, reject) => {
      const ch = this.data;
      if (this.closed || ch?.readyState !== 'open') return reject(new Error('数据通道已关闭'));
      const settle = (error) => {
        ch.removeEventListener('bufferedamountlow', onLow);
        ch.removeEventListener('close', onGone);
        ch.removeEventListener('error', onGone);
        this._drainWaiters.delete(settle);
        if (error) reject(error);
        else resolve();
      };
      const onLow = () => settle(null);
      const onGone = () => settle(new Error('数据通道已关闭'));
      ch.addEventListener('bufferedamountlow', onLow);
      ch.addEventListener('close', onGone);
      ch.addEventListener('error', onGone);
      this._drainWaiters.add(settle);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    // 先放掉等缓冲的发送：下面的 pc.close() 不会再给通道发任何事件
    for (const settle of [...this._drainWaiters]) settle(new Error('连接已关闭'));
    try {
      this.ctrl?.close();
      this.data?.close();
      this.pc.close();
    } catch {}
    this.emit('close');
    this.removeAll();
  }
}
