import { Emitter } from './emitter.js';
import { MSG, ChunkAssembler, unpackBitfield, packBitfield, chunkLengthAt } from './protocol.js';
import { Scheduler } from './scheduler.js';

/**
 * 群管理：一堆 Peer + 一个调度器 + 收发分片。
 *
 * 每个 peer 既可能是我的上游也可能是我的下游 —— 一个人刚下到的片，
 * 马上就能转手发给第三个人，不用等他自己下完。这就是分发能扩散开的原因，
 * 也是它跟「一个人当服务器往外发」的区别。
 */

const TICK_MS = 250;
const SERVE_CONCURRENCY = 2; // 每个 peer 同时最多给他发 2 片，多了会把 ctrl 通道也拖慢
const PING_MS = 3000;
const MANIFEST_HASHES_PER_PART = 600; // 约 40KB/条，稳稳低于 DataChannel 常见 64KB 单消息上限
const MAX_MANIFEST_PARTS = 32;
const PEER_ID_RE = /^[A-Za-z0-9_-]{6,128}$/;
const HASH_RE = /^[a-f0-9]{64}$/i;
const MAX_MANIFEST_CHUNKS = 5120; // 10GB / 2MB

export class Swarm extends Emitter {
  constructor({ peerId, name, securityMode = 'safe' }) {
    super();
    this.peerId = peerId;
    this.name = name;
    this.securityMode = securityMode === 'trusted' ? 'trusted' : 'safe';
    /** @type {Map<string, import('./peer.js').Peer>} */
    this.peers = new Map();

    this.manifest = null;
    this.sessionId = null;
    this.isSeeder = false;
    this.have = null; // Uint8Array
    this.haveCount = 0;
    this.contiguousBytes = 0;
    this.complete = false;

    this.scheduler = null;
    this.assembler = new ChunkAssembler();
    this.inflight = new Map(); // chunkIndex -> {peerId, at}
    this.playbackByte = 0;

    this._serving = new Map(); // peerId -> 正在发的片数
    this._serveQueue = new Map(); // peerId -> number[]
    this._timer = null;
    this._pingTimer = null;
    this._totalReceived = 0;
    this._totalSent = 0;
  }

  /* --------------------------- 会话与位图 --------------------------- */

  setSession({ manifest, sessionId, isSeeder, state }) {
    this.clearSession({ notify: false });
    this.manifest = manifest;
    this.sessionId = sessionId;
    this.isSeeder = isSeeder;
    this.scheduler = new Scheduler({ manifest });

    this.have = new Uint8Array(manifest.chunkCount);
    if (isSeeder) {
      this.have.fill(1);
      this.haveCount = manifest.chunkCount;
      this.contiguousBytes = manifest.size;
      this.complete = true;
    } else if (state?.bitfield) {
      this.have = unpackBitfield(state.bitfield, manifest.chunkCount);
      this.haveCount = state.haveCount || 0;
      this.contiguousBytes = state.contiguousBytes || 0;
      this.complete = !!state.complete;
    }

    // 已经连上的人还不知道我有什么，补发一遍
    for (const p of this.peers.values()) {
      if (p.authenticated) this._sendIntro(p);
    }
    this.emit('progress', this.progress());
  }

  /** 切换影片时只清媒体会话，保留房间里的 Peer 连接与计时器。 */
  clearSession({ notify = true } = {}) {
    for (const [index, info] of this.inflight) {
      this.peers.get(info.peerId)?.send({ t: MSG.CANCEL, index });
      this.peers.get(info.peerId)?.inflight.delete(index);
    }
    this.manifest = null;
    this.sessionId = null;
    this.isSeeder = false;
    this.have = null;
    this.haveCount = 0;
    this.contiguousBytes = 0;
    this.complete = false;
    this.scheduler = null;
    this.playbackByte = 0;
    this.inflight.clear();
    this.assembler.clear();
    for (const peer of this.peers.values()) {
      peer.remoteManifest = null;
      peer.remoteHave = null;
      peer.pendingManifest = null;
      peer.inflight.clear();
      peer.ready = false;
    }
    if (notify) this.emit('progress', this.progress());
  }

  setDuration(d) {
    this.scheduler?.setDuration(d);
  }

  setPlaybackByte(b) {
    this.playbackByte = b || 0;
  }

  progress() {
    const total = this.manifest?.chunkCount || 0;
    return {
      haveCount: this.haveCount,
      chunkCount: total,
      ratio: total ? this.haveCount / total : 0,
      contiguousBytes: this.contiguousBytes,
      contiguousRatio: this.manifest ? this.contiguousBytes / this.manifest.size : 0,
      complete: this.complete,
      inflight: this.inflight.size,
      downRate: [...this.peers.values()].reduce((a, p) => a + (p.downRate || 0), 0),
      received: this._totalReceived,
      sent: this._totalSent,
    };
  }

  /* ----------------------------- peer ----------------------------- */

  addPeer(peer) {
    this.peers.set(peer.peerId, peer);
    this._serving.set(peer.peerId, 0);
    this._serveQueue.set(peer.peerId, []);

    peer.on('open', () => {
      // 模式协商是数据通道上的第一步；通过前不发清单、控制消息或媒体数据。
      peer.hello(this.peerId, this.name, this.securityMode);
      this.emit('peers', this.peerList());
    });

    peer.on('ctrl', (msg) => this._onCtrl(peer, msg));
    peer.on('frame', (f) => this._onFrame(peer, f));

    peer.on('close', () => this.removePeer(peer.peerId));
    peer.on('failed', () => this.removePeer(peer.peerId));
    peer.on('rtt', () => this.emit('peers', this.peerList()));

    this.emit('peers', this.peerList());
    return peer;
  }

  /**
   * 给 peer 换身份。
   *
   * 极简模式下 A 得先造好 Peer、生成 offer，才可能知道对面是谁 —— 所以先用占位 id，
   * 等应答码回来再换成真的。每个 peer 在这里有三张表（peers / _serving / _serveQueue），
   * 只换其中一张的话，另外两张就永远查不到，发片的第一步就静默返回，
   * 表现是「连上了、清单也收到了，但一个字节都不动」。
   */
  renamePeer(oldId, newId, name) {
    const p = this.peers.get(oldId);
    if (!p || oldId === newId || !PEER_ID_RE.test(newId)) return false;
    // 绝不能覆盖已有 peer；否则攻击者可以把自己改成房主 ID，接管角色权威。
    if (this.peers.has(newId)) return false;

    this.peers.delete(oldId);
    this._serving.set(newId, this._serving.get(oldId) ?? 0);
    this._serveQueue.set(newId, this._serveQueue.get(oldId) ?? []);
    this._serving.delete(oldId);
    this._serveQueue.delete(oldId);

    // 在途记录也是按 peerId 记的，一并迁过去
    for (const info of this.inflight.values()) {
      if (info.peerId === oldId) info.peerId = newId;
    }

    p.peerId = newId;
    if (name) p.name = name;
    this.peers.set(newId, p);

    this.emit('peers', this.peerList());
    return true;
  }

  removePeer(peerId) {
    const p = this.peers.get(peerId);
    if (!p) return;

    // 他欠我的片得放回池子里，不然那些片就永远卡在 inflight 里没人再去要
    for (const [index, info] of this.inflight) {
      if (info.peerId === peerId) {
        this.inflight.delete(index);
        this.assembler.drop(index);
      }
    }

    this.peers.delete(peerId);
    this._serving.delete(peerId);
    this._serveQueue.delete(peerId);
    p.close();

    this.emit('peer-gone', peerId);
    this.emit('peers', this.peerList());
  }

  _sendIntro(peer) {
    if (!peer.authenticated || !this.manifest) return;
    this._sendManifest(peer, this.manifest);
    peer.send({ t: MSG.BITFIELD, bits: packBitfield(this.have) });
    peer.ready = true;
  }

  _sendManifest(peer, manifest) {
    if (manifest.hashes.length <= MANIFEST_HASHES_PER_PART) {
      peer.send({ t: MSG.MANIFEST, manifest });
      return;
    }
    const { hashes, ...meta } = manifest;
    const totalParts = Math.ceil(hashes.length / MANIFEST_HASHES_PER_PART);
    peer.send({ t: MSG.MANIFEST_START, meta, totalParts });
    for (let index = 0; index < totalParts; index++) {
      peer.send({
        t: MSG.MANIFEST_PART,
        fileId: manifest.fileId,
        index,
        hashes: hashes.slice(index * MANIFEST_HASHES_PER_PART, (index + 1) * MANIFEST_HASHES_PER_PART),
      });
    }
  }

  _handleManifest(peer, manifest) {
    if (
      !manifest?.fileId ||
      !Number.isInteger(manifest.chunkCount) ||
      manifest.chunkCount < 1 ||
      manifest.chunkCount > MAX_MANIFEST_CHUNKS ||
      !Array.isArray(manifest.hashes) ||
      manifest.hashes.length !== manifest.chunkCount ||
      manifest.hashes.some((hash) => typeof hash !== 'string' || !HASH_RE.test(hash))
    ) return;
    const previous = this.manifest;
    peer.remoteManifest = manifest;
    if (!previous || manifest.fileId !== previous.fileId) {
      this.emit('manifest-offer', { manifest, from: peer.peerId, replacing: !!previous });
    }
  }

  _peerInfo(peer) {
    const remoteCount = peer.remoteHave ? peer.remoteHave.reduce((a, b) => a + b, 0) : 0;
    return {
      peerId: peer.peerId,
      name: peer.name,
      state: peer.pc.iceConnectionState,
      rtt: peer.rtt ? Math.round(peer.rtt) : null,
      downRate: peer.downRate || 0,
      upRate: peer.upRate || 0,
      bytesReceived: peer.bytesReceived,
      bytesSent: peer.bytesSent,
      authenticated: peer.authenticated === true,
      remoteRatio: this.manifest?.chunkCount ? remoteCount / this.manifest.chunkCount : 0,
      inflight: peer.inflight.size,
    };
  }

  peerList() {
    return [...this.peers.values()].map((p) => this._peerInfo(p));
  }

  /* --------------------------- 控制消息 --------------------------- */

  _onCtrl(peer, msg) {
    // HELLO 必须是第一条业务消息。未认证连接不能触发任何房间行为。
    if (!peer.authenticated && msg.t !== MSG.HELLO) return;
    switch (msg.t) {
      case MSG.HELLO:
        if (peer.authenticated) break;
        // HELLO 只用于确认身份，不能覆盖信令层已经绑定的 peerId。
        if (msg.peerId && msg.peerId !== peer.peerId) {
          if (!peer.allowIdentityRename || !this.renamePeer(peer.peerId, msg.peerId, msg.name)) {
            this.emit('identity-mismatch', { expected: peer.peerId, claimed: msg.peerId });
            this.removePeer(peer.peerId);
            return;
          } else {
            peer.allowIdentityRename = false;
          }
        } else if (msg.name) {
          peer.name = String(msg.name).slice(0, 40);
        }

        // 旧客户端没有 securityMode，按安全模式处理。可信房间绝不允许缺省值。
        const remoteMode = msg.securityMode === 'trusted' ? 'trusted' : 'safe';
        if (remoteMode !== this.securityMode) {
          this.emit('mode-mismatch', {
            peerId: peer.peerId,
            localMode: this.securityMode,
            remoteMode,
          });
          this.removePeer(peer.peerId);
          return;
        }

        peer.authenticated = true;
        this._sendIntro(peer);
        this.emit('peer-authenticated', peer);
        this.emit('peer-open', this._peerInfo(peer));
        this.emit('peers', this.peerList());
        break;

      case MSG.MANIFEST:
        this._handleManifest(peer, msg.manifest);
        break;

      case MSG.MANIFEST_START: {
        const totalParts = Number(msg.totalParts);
        const meta = msg.meta;
        if (
          !meta?.fileId ||
          !Number.isInteger(totalParts) ||
          totalParts < 1 ||
          totalParts > MAX_MANIFEST_PARTS ||
          !Number.isInteger(meta.chunkCount) ||
          meta.chunkCount < 1
        ) break;
        peer.pendingManifest = { meta, totalParts, parts: new Array(totalParts), received: 0 };
        break;
      }

      case MSG.MANIFEST_PART: {
        const pending = peer.pendingManifest;
        const index = Number(msg.index);
        if (
          !pending ||
          msg.fileId !== pending.meta.fileId ||
          !Number.isInteger(index) ||
          index < 0 ||
          index >= pending.totalParts ||
          !Array.isArray(msg.hashes) ||
          msg.hashes.length > MANIFEST_HASHES_PER_PART ||
          pending.parts[index]
        ) break;
        pending.parts[index] = msg.hashes;
        pending.received++;
        if (pending.received === pending.totalParts) {
          peer.pendingManifest = null;
          this._handleManifest(peer, { ...pending.meta, hashes: pending.parts.flat() });
        }
        break;
      }

      case MSG.BITFIELD:
        if (peer.remoteManifest || this.manifest) {
          const count = (this.manifest || peer.remoteManifest).chunkCount;
          peer.remoteHave = unpackBitfield(msg.bits, count);
          peer.ready = true;
          this.emit('peers', this.peerList());
        }
        break;

      case MSG.HAVE:
        if (peer.remoteHave && Number.isInteger(msg.index) && msg.index >= 0 && msg.index < peer.remoteHave.length) {
          peer.remoteHave[msg.index] = 1;
        }
        break;

      case MSG.REQUEST:
        this._enqueueServe(peer, msg.index);
        break;

      case MSG.CANCEL: {
        const q = this._serveQueue.get(peer.peerId);
        if (q) {
          const i = q.indexOf(msg.index);
          if (i !== -1) q.splice(i, 1);
        }
        break;
      }

      case MSG.DENY: {
        // 他其实没有这片，撤销在途标记，下一轮换个人要
        const info = this.inflight.get(msg.index);
        if (info?.peerId === peer.peerId) {
          this.inflight.delete(msg.index);
          this.assembler.drop(msg.index);
          peer.inflight.delete(msg.index);
        }
        break;
      }

      default:
        this.emit('ctrl', { msg, peer });
    }
  }

  /* ---------------------------- 发送侧 ---------------------------- */

  _enqueueServe(peer, index) {
    if (!this.manifest || index < 0 || index >= this.manifest.chunkCount) return;
    if (this.have[index] !== 1) {
      peer.send({ t: MSG.DENY, index });
      return;
    }
    const q = this._serveQueue.get(peer.peerId);
    if (!q || q.includes(index)) return;
    q.push(index);
    this._pumpServe(peer);
  }

  async _pumpServe(peer) {
    const q = this._serveQueue.get(peer.peerId);
    if (!q) return;
    while (q.length && (this._serving.get(peer.peerId) || 0) < SERVE_CONCURRENCY) {
      const index = q.shift();
      this._serving.set(peer.peerId, (this._serving.get(peer.peerId) || 0) + 1);
      this._serveOne(peer, index).finally(() => {
        this._serving.set(peer.peerId, Math.max(0, (this._serving.get(peer.peerId) || 1) - 1));
        if (this.peers.has(peer.peerId)) this._pumpServe(peer);
      });
    }
  }

  async _serveOne(peer, index) {
    try {
      const buf = await window.sw.store.readChunk(this.sessionId, index);
      if (!this.peers.has(peer.peerId)) return;
      await peer.sendChunk(index, buf);
      this._totalSent += buf.byteLength;
      this.emit('progress', this.progress());
    } catch (e) {
      console.warn(`[swarm] 发送分片 ${index} 给 ${peer.name} 失败:`, e.message);
    }
  }

  /* ---------------------------- 接收侧 ---------------------------- */

  _onFrame(peer, { chunkIndex, frameIndex, payload }) {
    if (!peer.authenticated || !this.manifest) return;
    const full = this.assembler.push(chunkIndex, frameIndex, payload);
    if (!full) return;
    this._commitChunk(peer, chunkIndex, full);
  }

  async _commitChunk(peer, index, bytes) {
    this.inflight.delete(index);
    peer.inflight.delete(index);

    try {
      const res = await window.sw.store.writeChunk(this.sessionId, index, bytes.buffer);

      if (!res.ok) {
        // 校验没过。这片作废重下 —— 这就是渐进式校验的意义：
        // 坏数据当场拦住，不会等到播放的时候才发现花屏。
        console.warn(`[swarm] 分片 ${index} 校验失败（${res.reason}），来自 ${peer.name}`);
        this.emit('chunk-bad', { index, from: peer.peerId, reason: res.reason });
        return;
      }

      this._totalReceived += bytes.length;

      if (!res.duplicate) {
        this.have[index] = 1;
        this.haveCount = res.haveCount;
        this.contiguousBytes = res.contiguousBytes;
        this.complete = !!res.complete;

        // 告诉所有人我有这片了，他们马上就能来找我要
        for (const p of this.peers.values()) {
          if (p.authenticated) p.send({ t: MSG.HAVE, index });
        }

        this.emit('progress', this.progress());
        if (this.complete) this.emit('complete');
      }
    } catch (e) {
      console.error(`[swarm] 写入分片 ${index} 出错:`, e);
      this.emit('error', e);
    }
  }

  /* ---------------------------- 调度循环 ---------------------------- */

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), TICK_MS);
    this._pingTimer = setInterval(() => {
      for (const p of this.peers.values()) p.ping();
      this.emit('peers', this.peerList());
    }, PING_MS);
  }

  stop() {
    clearInterval(this._timer);
    clearInterval(this._pingTimer);
    this._timer = this._pingTimer = null;
  }

  _tick() {
    if (!this.manifest || !this.scheduler || this.complete || this.isSeeder) return;

    this._expireStale();

    const assignments = this.scheduler.plan({
      have: this.have,
      playbackByte: this.playbackByte,
      inflight: new Set(this.inflight.keys()),
      peers: [...this.peers.values()],
    });

    for (const { peerId, index } of assignments) {
      const peer = this.peers.get(peerId);
      if (!peer || peer.ctrl?.readyState !== 'open') continue;

      const len = chunkLengthAt(index, this.manifest.size, this.manifest.chunkSize);
      this.assembler.expect(index, len);
      this.inflight.set(index, { peerId, at: performance.now() });
      peer.inflight.add(index);
      peer.send({ t: MSG.REQUEST, index });
    }
  }

  /** 要了半天不给的片，超时收回重新分配。对面可能网卡了或者悄悄挂了。 */
  _expireStale(timeoutMs = 20000) {
    const now = performance.now();
    for (const [index, info] of this.inflight) {
      if (now - info.at < timeoutMs) continue;
      this.inflight.delete(index);
      this.assembler.drop(index);
      this.peers.get(info.peerId)?.inflight.delete(index);
    }
  }

  destroy() {
    this.stop();
    for (const p of [...this.peers.values()]) p.close();
    this.peers.clear();
    this.assembler.clear();
    this.inflight.clear();
    this.removeAll();
  }
}
