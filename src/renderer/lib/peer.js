import { Emitter } from './emitter.js';
import {
  MSG,
  encodeFrames,
  decodeFrame,
  BUFFER_HIGH_WATER,
  BUFFER_LOW_WATER,
  PROTOCOL_VERSION,
} from './protocol.js';

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
    this.rtt = null;
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
      if (this.trickle && e.candidate) this.emit('icecandidate', e.candidate.toJSON());
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
    return this.pc.localDescription.toJSON();
  }

  async acceptOffer(desc) {
    await this.pc.setRemoteDescription(desc);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    if (!this.trickle) await this._waitIceComplete();
    return this.pc.localDescription.toJSON();
  }

  async acceptAnswer(desc) {
    await this.pc.setRemoteDescription(desc);
  }

  async addIceCandidate(c) {
    try {
      await this.pc.addIceCandidate(c);
    } catch (e) {
      console.warn('[peer] 添加 ICE 候选失败', e);
    }
  }

  /** 等 ICE 收集完成，非 trickle 模式下 SDP 必须包含全部候选才能离线交换。 */
  _waitIceComplete(timeoutMs = 8000) {
    if (this.pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => {
        if (this.pc.iceGatheringState === 'complete') done();
      };
      // 超时也要放行：某些网络下 STUN 不通会一直卡在 gathering，
      // 拿已有的候选去试也好过永远连不上。
      const timer = setTimeout(done, timeoutMs);
      this.pc.addEventListener('icegatheringstatechange', check);
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
