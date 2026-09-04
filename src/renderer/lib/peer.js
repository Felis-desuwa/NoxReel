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

/**
 * 单个 P2P 连接。
 *
 * 发起方建通道，应答方等 ondatachannel。两条通道：ctrl（JSON）和 data（二进制）。
 *
 * 关于 ICE 模式：
 *  - trickle=true：候选地址边收集边发，连得快，需要信令服务器持续在线。
 *  - trickle=false：等候集齐所有候选再产出一份完整 SDP，慢几秒，但换来
 *    「一段文本复制粘贴就能连上」—— 这就是极简模式（零服务器）的实现基础。
 */
export class Peer extends Emitter {
  constructor({ peerId, name, initiator, iceServers, trickle = true, allowIdentityRename = false }) {
    super();
    this.peerId = peerId;
    this.name = name || peerId;
    this.initiator = initiator;
    this.trickle = trickle;
    // 信令层已经确认身份后必须钉死 peerId。只有极简模式在尚未知晓应答方身份、
    // 且明确使用占位 ID 时，调用方才可以单独放开一次改名。
    this.allowIdentityRename = allowIdentityRename === true;
    this.authenticated = false;
    this.closed = false;

    this.ctrl = null;
    this.data = null;
    this.remoteManifest = null;
    this.remoteHave = null; // Uint8Array
    this.inflight = new Set(); // 我方已向该 peer 请求、还没收齐的分片
    this._pendingCandidates = []; // 远端描述落地前先攒着的 ICE 候选
    this.rtt = null;
    // 本机收集到的候选类型。连不上的时候这是唯一能指路的东西 —— 没有 srflx
    // 说明 STUN 不通，有 srflx 没 relay 说明只能靠打洞。见 ice.js 的 diagnoseCandidates()。
    this.candidateTypes = new Set();
    this.localCandidateStats = null;
    this._sentCandidateKeys = new Set();
    this._expectRelay = hasRelay(iceServers);
    this.bytesReceived = 0;
    this.bytesSent = 0;
    this._lastRecvSample = { t: performance.now(), bytes: 0 };
    this._lastSendSample = { t: performance.now(), bytes: 0 };
    this.downRate = 0;
    this.upRate = 0;

    this.pc = new RTCPeerConnection({
      iceServers,
      iceCandidatePoolSize: 4,
      bundlePolicy: 'max-bundle',
    });

    this.pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const json = e.candidate.toJSON();
      const parsed = parseCandidateLine(`a=${json.candidate}`) || parseCandidateLine(json.candidate || '');
      if (parsed) this.candidateTypes.add(parsed.type);
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
        if (typeof e.data !== 'string' || e.data.length > 256 * 1024) return;
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
        this.bytesReceived += e.data.byteLength;
        this._sampleRate();
        this.emit('frame', f);
      };
    }
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
      this.send({ t: MSG.PONG, ts: msg.ts });
      return;
    }
    if (msg.t === MSG.PONG) {
      this.rtt = performance.now() - msg.ts;
      this.emit('rtt', this.rtt);
      return;
    }
    this.emit('ctrl', msg);
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
    this.ctrl.send(JSON.stringify(msg));
    return true;
  }

  hello(peerId, name, securityMode = 'safe') {
    this.send({ t: MSG.HELLO, peerId, name, ver: PROTOCOL_VERSION, securityMode });
  }

  ping() {
    this._sampleRate();
    this._sampleUploadRate();
    this.send({ t: MSG.PING, ts: performance.now() });
  }

  /**
   * 发一个分片。切帧 + 背压：缓冲满了就等它排空，
   * 不然几个大分片就能把内存顶爆，而且 ctrl 通道的延迟也会被拖垮。
   */
  async sendChunk(chunkIndex, buffer) {
    if (this.data?.readyState !== 'open') throw new Error('数据通道未打开');
    const frames = encodeFrames(chunkIndex, buffer);
    for (const frame of frames) {
      if (this.data.readyState !== 'open') throw new Error('发送途中数据通道关闭');
      if (this.data.bufferedAmount > BUFFER_HIGH_WATER) await this._drain();
      this.data.send(frame);
      this.bytesSent += frame.byteLength;
      this._sampleUploadRate();
    }
  }

  _drain() {
    return new Promise((resolve, reject) => {
      if (this.data.readyState !== 'open') return reject(new Error('数据通道已关闭'));
      const onLow = () => {
        this.data.removeEventListener('bufferedamountlow', onLow);
        resolve();
      };
      this.data.addEventListener('bufferedamountlow', onLow);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ctrl?.close();
      this.data?.close();
      this.pc.close();
    } catch {}
    this.emit('close');
    this.removeAll();
  }
}
