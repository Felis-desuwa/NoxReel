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
const MAX_MANIFEST_CHUNKS = 5120;

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
    this._writing = new Set(); // 已经收齐、正在落盘的分片。见 _commitChunk() 里的说明
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

    // 已经连上的人还不知道我有什么，补发一遍。
    // 顺带判定对方手里那份还算不算数：位图是按 fileId 对应的分片数解出来的，
    // 对方拿的是另一个文件时长度对不上，必须丢掉、等他发来新清单再启用。
    for (const p of this.peers.values()) {
      if (p.remoteManifest && p.remoteManifest.fileId !== manifest.fileId) {
        p.remoteManifest = null;
        p.remoteHave = null;
        p.ready = false;
      }
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
    this._writing.clear();
    this.assembler.clear();
    // 只清跟「本机会话」绑定的东西。remoteManifest / remoteHave 描述的是**对方**手里
    // 有什么，跟我这边开不开会话无关；接收方一旦变成「先收到清单和位图 → 再异步打开
    // 本地会话」的顺序（桌面端就是这样），在这里一并清掉就再也没人补发位图，
    // 调度器永远筛不出可用上游 —— 连上了、清单也有了，却一个字节都不动。
    // 换片后对方那份还算不算数，交给 setSession 按 fileId 判定。
    for (const peer of this.peers.values()) {
      peer.inflight.clear();
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
    // 同一个 peerId 可能再来一次（对方信令重连后老成员会重新发起 offer）。
    // 直接覆盖的话，旧的 RTCPeerConnection 既没关、监听器也还挂着，
    // 成了收得到消息却谁也管不着的幽灵，还占着一份内存和一条 ICE 连接。
    const previous = this.peers.get(peer.peerId);
    if (previous && previous !== peer) this.removePeer(peer.peerId);

    this.peers.set(peer.peerId, peer);
    this._serving.set(peer.peerId, 0);
    this._serveQueue.set(peer.peerId, []);

    peer.on('open', () => {
      peer.hello(this.peerId, this.name, this.securityMode);
      this.emit('peers', this.peerList());
    });

    peer.on('ctrl', (msg) => this._onCtrl(peer, msg));
    peer.on('frame', (f) => this._onFrame(peer, f));

    // 只摘自己，不摘同名的后来者。旧连接的 close/failed 是异步到达的：对端信令重连后
    // 会重新发 offer，我方按同一个 peerId 换上新 Peer，紧接着旧连接的关闭事件才姗姗来迟
    // —— 按 peerId 无差别删除的话，删掉的正是刚建好的新连接，之后谁也不会再发起协商。
    const forgetSelf = () => {
      if (this.peers.get(peer.peerId) === peer) this.removePeer(peer.peerId);
    };
    peer.on('close', forgetSelf);
    peer.on('failed', forgetSelf);
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
    if (!p || oldId === newId || !PEER_ID_RE.test(newId) || this.peers.has(newId)) return false;

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
    if (!peer.authenticated && msg.t !== MSG.HELLO) return;
    switch (msg.t) {
      case MSG.HELLO:
        if (peer.authenticated) break;
        if (msg.peerId && msg.peerId !== peer.peerId) {
          if (!peer.allowIdentityRename || !this.renamePeer(peer.peerId, msg.peerId, msg.name)) {
            this.emit('identity-mismatch', { expected: peer.peerId, claimed: msg.peerId });
            this.removePeer(peer.peerId);
            return;
          }
          peer.allowIdentityRename = false;
        } else if (msg.name) {
          peer.name = msg.name;
        }
        const remoteMode = msg.securityMode === 'trusted' ? 'trusted' : 'safe';
        if (remoteMode !== this.securityMode) {
          this.emit('mode-mismatch', { peerId: peer.peerId, localMode: this.securityMode, remoteMode });
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

      case MSG.BITFIELD: {
        // 位图是对方那个文件的，尺寸只能按他的清单算；本机会话可能还没打开，
        // 更不能拿本机的 chunkCount 去解。
        const source = peer.remoteManifest || this.manifest;
        if (source) {
          peer.remoteHave = unpackBitfield(msg.bits, source.chunkCount);
          peer.ready = true;
          this.emit('peers', this.peerList());
        }
        break;
      }

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
    // 一定要按记账里登记的那个 peer 去销账，而不是「送来最后一帧的人」。
    //
    // 这两者会不一致：一片超时被回收后改派给了 B，原来的 A 随后从头重发并抢先
    // 把它凑齐，_commitChunk 收到的 peer 就是 A。此时去删 A.inflight 是空操作，
    // 而 B.inflight 里那个下标再也没人清 —— 全局记录已经删掉，_expireStale 扫不到，
    // DENY 分支也会因为取不到 info 而跳过。每漏一个，B 的在途窗口就永久少一格，
    // 攒够窗口数这个上游就被 plan() 的 usable 过滤器永久剔除：连接全都健康、
    // 成员列表也正常，进度条却停住不动。
    const owner = this.inflight.get(index);
    this.inflight.delete(index);
    if (owner) this.peers.get(owner.peerId)?.inflight.delete(index);
    peer.inflight.delete(index); // 送达方那边也清一次，两者相同时等价

    // 从「在途」到「已有」中间隔着一整个写盘往返：2MB 过 IPC、算 SHA-256、落盘。
    // 这段时间里这片既不在 inflight 里、have 也还是 0，调度器只能判定它还缺，
    // 于是再去要一遍 —— 而 v0.6.5 起每片落地都会触发一次 _tick，等于把这个窗口
    // 撞得更频繁。实测一个 25.9 MB 的文件，发送端总共发出 59.8 MB（2.3 倍）。
    // 重复的那份最后被 fileStore 认出来丢掉（res.duplicate），带宽却已经花掉了。
    this._writing.add(index);

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
    } finally {
      this._writing.delete(index);
      // 一片落地就立刻把空出来的名额补上，别干等下一个 tick。
      //
      // 这条不是锦上添花：Chromium 会把不可见窗口的定时器节流到 1 秒一次，
      // 而「正在看片」恰恰就是 NoxReel 窗口不可见的时候 —— mpv 是另一个窗口，
      // 就压在它上面。于是 TICK_MS 的 250ms 变成 1000ms，每秒最多补
      // MAX_INFLIGHT_PER_PEER 片，吞吐被硬卡在 4 × 2MB = 8 MB/s，
      // 网络再快也没用（实测回环链路正好停在 7.7 MB/s）。
      // 数据通道的消息事件不受节流，把补片挂在它上面，定时器退回兜底角色。
      this._tick();
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
      // 正在落盘的那几片也算「已经安排上了」，否则它们会在写盘的空档里被重复请求。
      inflight: new Set([...this.inflight.keys(), ...this._writing]),
      // 只跟手里是同一个文件的人要片。对方换片之后会发来新清单和新位图，
      // 那张位图描述的是另一个文件 —— 照着它要片，要回来的分片哈希必然对不上，
      // 白白占着在途名额反复重下。setSession 只处理了「我换片」这个方向。
      peers: [...this.peers.values()].filter((p) => this._sameFile(p)),
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

  /**
   * 一个请求等多久才算废。
   *
   * 固定 20 秒对跨境链路太长了：丢掉一条 REQUEST，这个槽位就空转 20 秒 ——
   * 四选一的窗口等于凭空少了四分之一吞吐，而且关键窗口里的那一片迟到 20 秒
   * 足够让全员暂停触发一次。按对方的往返延迟和实测速率估「这片本来该多久到」，
   * 再留三倍余量。测不出速率（刚连上、或者对方一直没吐东西）就退回 20 秒。
   */
  _requestTimeout(peer) {
    const rtt = peer?.rtt > 0 ? peer.rtt : 0;
    const rate = peer?.downRate > 0 ? peer.downRate : 0;
    if (!rtt || !rate || !this.manifest) return 20000;
    // 他手上欠我的片是排队发的，最后一片要等前面都发完。
    const queued = Math.max(1, peer.inflight?.size || 1);
    const expected = rtt + ((queued * this.manifest.chunkSize) / rate) * 1000;
    // 上限不能一刀切在 20 秒：窗口放深之后（跨境链路会涨到 12 片），慢链路上
    // expected 本身就可能超过 20 秒，那样队尾那片必然在能到达之前就被判超时，
    // 于是无限重派、永远收不齐。上限至少要给到期望送达时间本身留出余量。
    const ceiling = Math.max(20000, expected * 1.5 + 2000);
    return Math.max(6000, Math.min(ceiling, expected * 3 + 2000));
  }

  /** 这个 peer 手里是不是同一个文件。fileId 由所有分片哈希推导，同内容必然同 id。 */
  _sameFile(peer) {
    const theirs = peer?.remoteManifest?.fileId;
    if (!theirs || !this.manifest?.fileId) return true; // 还没交换清单时不拦，握手流程自己会处理
    return theirs === this.manifest.fileId;
  }

  /** 要了半天不给的片，超时收回重新分配。对面可能网卡了或者悄悄挂了。 */
  _expireStale() {
    const now = performance.now();
    for (const [index, info] of this.inflight) {
      if (now - info.at < this._requestTimeout(this.peers.get(info.peerId))) continue;
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
    this._writing.clear();
    this.removeAll();
  }
}
