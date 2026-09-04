/**
 * 安卓端编排（观众专用）。
 *
 * 复用 PC 端的协议核心（peer/swarm/scheduler/syncEngine/signaling），
 * 只把「存储」和「播放器」换成原生实现（经 native-shim 的 window.sw / window.swPlayer）。
 * 信令握手规则与 PC 端 connectSignaling 保持一致，才能互相连上。
 *
 * 手机永远是加入者/观众：接清单、要片、参与全员暂停联动，不做种、不当房主。
 */

import './native-shim.js';
import { Peer } from './peer.js';
import { Swarm } from './swarm.js';
import { SyncEngine } from './syncEngine.js';
import { WsSignaling, encodeCode, decodeCode, inviteLink, randomPeerId } from './signaling.js';
import { buildIceServers } from './ice.js';
import { MSG } from './protocol.js';
import { currentLocale, setLocale, startI18n, translate as t } from './i18n.js';

startI18n();

const HEAD_READY_BYTES = 8 * 1024 * 1024; // 片头下够才起播（同 PC：全零稀疏文件起播拿不到 moov）
const normalizeSecurityMode = (mode) => (mode === 'trusted' ? 'trusted' : 'safe');
const securityModeLabel = (mode) => (normalizeSecurityMode(mode) === 'trusted' ? '可信房间' : '安全模式');

const S = {
  peerId: randomPeerId(),
  name: '',
  hostId: null, // 房主 peerId：极简模式从邀请码得来；信令模式手里没码，靠首个 ROLE 认定
  swarm: null,
  sync: null,
  signaling: null,
  sessionId: null,
  manifest: null,
  sourceType: null,
  linkInfo: null,
  playerStarted: false,
  playerTimer: null,
  prog: { contiguousBytes: 0, complete: false },
  entered: false,
  mediaRevision: 0,
  securityMode: localStorage.getItem('sw.securityMode') === 'safe' ? 'safe' : 'trusted',
};

/* ------------------------------ DOM 小工具 ------------------------------ */
const $ = (id) => document.getElementById(id);
function show(el, on) { el.style.display = on ? '' : 'none'; }

function log(msg, level) {
  const box = $('log');
  const line = document.createElement('div');
  if (level) line.className = 'log-' + level;
  line.textContent = msg;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
  console.log('[app]', msg);
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  const h = Math.floor(m / 60);
  if (h) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ------------------------------ ICE 配置 ------------------------------ */
// 只配一台 STUN 时 buildIceServers 会自动补两台兜底 —— 手机换基站、切 Wi-Fi 的
// 频率比桌面高得多，那一台一旦不通就拿不到公网地址，跨 NAT 直接连不上。
// TURN 地址也会自动展开成 UDP + TCP 两条。
function iceServers() {
  const turn = ($('turn') && $('turn').value.trim()) || '';
  // TURN 可选，格式 turn:host:port|user|pass（这里预留，界面暂未放出）
  const [turnUrl, turnUser, turnPass] = turn ? turn.split('|') : [];
  return buildIceServers({
    turnEnabled: Boolean(turnUrl),
    turnUrl: turnUrl || '',
    turnUser: turnUser || '',
    turnPass: turnPass || '',
  });
}

/* ------------------------- 群管理 + 同步引擎 ------------------------- */
function initSwarmAndSync() {
  if (S.swarm) return;
  S.name = ($('name').value.trim() || '观众') .slice(0, 20);
  S.securityMode = normalizeSecurityMode($('security-mode').value);
  localStorage.setItem('sw.securityMode', S.securityMode);
  $('security-mode').disabled = true;

  S.swarm = new Swarm({ peerId: S.peerId, name: S.name, securityMode: S.securityMode });
  S.sync = new SyncEngine({
    peerId: S.peerId,
    name: S.name,
    isSeeder: false,
    hostId: S.hostId, // 极简模式=邀请码里的房主 id；信令模式=null，先当游客，等首个 ROLE 认定
  });

  // 同步引擎驱动原生播放器（对应 PC 端驱动 mpv）
  S.sync.onSetPause = (paused) => window.swPlayer.setPause(paused);
  S.sync.onSeek = (sec) => window.swPlayer.seek(sec);

  // 同步引擎要广播的指令 → 发给所有已连 peer 的 ctrl 通道
  S.sync.on('outbound', (msg) => {
    for (const p of S.swarm.peers.values()) {
      if (p.authenticated) p.send(msg);
    }
  });
  S.sync.on('remote-action', ({ kind, by }) => log(`${by} ${kind === 'pause' ? '暂停了' : kind === 'play' ? '继续播放' : '跳转了'}`, 'good'));
  S.sync.on('stall-change', renderWaiting);
  S.sync.on('state', renderWaiting);
  S.sync.on('duration', (d) => { S.swarm.setDuration(d); });
  // 房主分配的角色变了 → 更新「我是游客还是管理员」的界面（游客禁用拖动条）
  S.sync.on('roles', renderRole);
  // 游客拖了进度被拦下：把滑块弹回、给个提示
  S.sync.on('denied', ({ action }) => {
    if (action === 'seek') {
      log('你是游客，不能拖动进度', 'warn');
      renderRole();
    }
  });

  // swarm 事件
  S.swarm.on('manifest-offer', onManifestOffer);
  S.swarm.on('progress', onProgress);
  S.swarm.on('peers', renderPeers);
  S.swarm.on('peer-gone', (id) => S.sync.peerGone(id));
  S.swarm.on('complete', () => log('全部下载完成', 'good'));
  S.swarm.on('peer-authenticated', (peer) => {
    log(`已和 ${peer.name} 完成${securityModeLabel(S.securityMode)}握手`, 'good');
    S.sync?.greet(peer);
  });
  S.swarm.on('mode-mismatch', ({ localMode, remoteMode }) => {
    log(`模式不一致：本机是${securityModeLabel(localMode)}，对方是${securityModeLabel(remoteMode)}，已在传输媒体前断开。`, 'bad');
    S.signaling?.close();
  });
  S.swarm.on('identity-mismatch', ({ expected }) => {
    log(`已断开身份校验失败的成员：${expected}`, 'bad');
  });
  // SYNC / STALL 这些同步消息 swarm 不认，走 default 抛到 'ctrl'，转给同步引擎
  S.swarm.on('ctrl', ({ msg, peer }) => {
    if (msg.t === MSG.MEDIA_LINK) onMediaLink(msg, peer);
    else S.sync.onCtrl(msg, peer);
  });

  S.swarm.start();
}

/* ------------------------- 收到清单 → 开会话 ------------------------- */
function onManifestOffer({ manifest, from }) {
  const knownHost = S.hostId || S.sync?.hostId;
  if (knownHost && from !== knownHost) {
    log('已忽略非房主发来的换片请求', 'warn');
    return;
  }
  const revision = Number(manifest.roomRevision) || 0;
  if (revision && revision <= S.mediaRevision) return;

  if (S.playerTimer) clearInterval(S.playerTimer);
  S.playerTimer = null;
  S.playerStarted = false;
  window.swPlayer.release();
  S.swarm.clearSession();
  if (S.sessionId) window.sw.store.close(S.sessionId);

  S.manifest = manifest;
  S.sourceType = 'file';
  S.linkInfo = null;
  S.mediaRevision = revision || S.mediaRevision + 1;
  try {
    S.sessionId = window.sw.store.openLeech(manifest);
  } catch (e) {
    log('打开接收会话失败：' + e.message, 'bad');
    return;
  }
  const state = window.sw.store.sessionState(S.sessionId);
  S.swarm.setSession({ manifest, sessionId: S.sessionId, isSeeder: false, state });
  S.sync.resetMedia({ isSeeder: false });
  S.sync.setMediaInfo({ duration: 0, size: manifest.size });
  S.sync.start();

  enterStage();
  renderFilmInfo();
  log(`开始接收《${manifest.name}》 · ${fmtBytes(manifest.size)}`, 'good');
}

/* ----------------------- 收到网页/直链媒体 ----------------------- */
function safePlaybackFromMessage(msg) {
  const playback = msg && msg.playback;
  if (!playback || typeof playback.url !== 'string' || playback.url.length > 16384) return null;
  try {
    const parsed = new URL(playback.url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  } catch {
    return null;
  }
  const headers = {};
  const allowed = new Set(['accept', 'accept-language', 'origin', 'referer', 'user-agent']);
  if (playback.headers && typeof playback.headers === 'object' && !Array.isArray(playback.headers)) {
    for (const [rawName, rawValue] of Object.entries(playback.headers)) {
      const name = String(rawName).trim().toLowerCase();
      if (!allowed.has(name) || typeof rawValue !== 'string' || !rawValue || rawValue.length > 2048) continue;
      if (/\r|\n/.test(rawValue)) continue;
      headers[name] = rawValue;
    }
  }
  return { url: playback.url, headers };
}

function onMediaLink(msg, peer) {
  const knownHost = S.hostId || S.sync?.hostId;
  if (!knownHost || peer.peerId !== knownHost) {
    log('已忽略非房主发来的视频链接', 'warn');
    return;
  }
  const revision = Number(msg.revision) || 0;
  if (revision && revision <= S.mediaRevision) return;
  const playback = safePlaybackFromMessage(msg);
  if (!playback) {
    log('房主分享的是网页链接，但没有可供 Android 播放的安全直链', 'bad');
    return;
  }

  let origin = '';
  try { origin = new URL(playback.url).origin; } catch {}
  const allowed = window.confirm(t(`房主请求手机连接 ${origin} 播放在线视频。是否允许？`));
  if (!allowed) {
    log('你拒绝了房主发送的视频链接', 'warn');
    return;
  }

  if (S.playerTimer) clearInterval(S.playerTimer);
  S.playerTimer = null;
  S.playerStarted = false;
  window.swPlayer.release();
  S.swarm.clearSession();
  if (S.sessionId) window.sw.store.close(S.sessionId);

  S.sessionId = null;
  S.manifest = null;
  S.sourceType = 'link';
  S.linkInfo = {
    title: typeof msg.title === 'string' ? msg.title.slice(0, 240) : '在线视频',
    duration: Number(msg.duration) || 0,
    playback,
  };
  S.mediaRevision = revision || S.mediaRevision + 1;
  S.prog = { contiguousBytes: 0, complete: true };
  S.sync.resetMedia({ isSeeder: true });
  S.sync.setMediaInfo({ duration: S.linkInfo.duration, size: 0 });
  S.sync.start();

  const started = window.swPlayer.loadUrl(playback.url, playback.headers);
  if (!started) {
    log('Android 拒绝或无法打开这个播放地址', 'bad');
    return;
  }
  S.playerStarted = true;
  enterStage();
  renderFilmInfo();
  renderStatus(S.prog);
  startPlayerTicks();
  log(`正在从原网站播放《${S.linkInfo.title}》`, 'good');
}

/* --------------------------- 下载进度回调 --------------------------- */
function onProgress(p) {
  S.prog = p;
  // 下载侧驱动 stall 重评估（全员暂停后 mpv/播放器静止，只剩这条路能解锁）
  S.sync.onBufferProgress({ contiguousBytes: p.contiguousBytes, complete: p.complete });
  maybeLaunchPlayer(p);
  renderStatus(p);
}

function maybeLaunchPlayer(p) {
  if (S.playerStarted) return;
  if (S.securityMode === 'safe' && !p.complete) return;
  if (S.securityMode === 'trusted' && p.contiguousBytes < HEAD_READY_BYTES && !p.complete) return;
  S.playerStarted = true;
  window.swPlayer.load(S.sessionId);
  log(
    S.securityMode === 'trusted'
      ? '可信房间片头已就绪，开始边接收边播放（风险较高）'
      : '安全模式文件已完整接收并校验，开始播放',
    S.securityMode === 'trusted' ? 'warn' : 'good'
  );
  startPlayerTicks();
}

/* --------------------------- 播放器轮询 --------------------------- */
function startPlayerTicks() {
  if (S.playerTimer) return;
  S.playerTimer = setInterval(() => {
    let snap;
    try { snap = window.swPlayer.snapshot(); } catch (e) { return; }

    // 首次拿到时长：喂给同步引擎和调度器（前瞻窗口、stall 阈值都要它）
    if (snap.duration > 0 && !S.sync.duration) {
      S.sync.setMediaInfo({ duration: snap.duration, size: S.manifest?.size || 0 });
      S.swarm.setDuration(snap.duration);
    }

    // 更新本地播放快照 + 触发 stall 评估（播放侧驱动）
    S.sync.lastTick = {
      position: snap.position,
      paused: snap.paused,
      streamPos: null,
      duration: snap.duration,
      at: performance.now(),
    };
    S.sync._evaluateStall(S.sync.lastTick, {
      contiguousBytes: S.prog.contiguousBytes,
      complete: S.sourceType === 'link' || S.prog.complete,
    });

    // 播放位置告诉调度器，让它优先补「播放点 + 前瞻窗口」的片
    const size = S.manifest?.size || 0;
    if (size > 0) {
      const pb = snap.duration > 0 ? (snap.position / snap.duration) * size : 0;
      S.swarm.setPlaybackByte(pb);
    }

    renderPlayback(snap);
  }, 250);
}

/* ------------------------------ 信令连接 ------------------------------ */
// 规则与 PC 端一致：房间里的老成员向新来的发起 offer，避免双方同时发 offer 撞车。
async function connectSignaling(url, roomId) {
  const sig = new WsSignaling({ url, roomId, peerId: S.peerId, name: S.name });
  S.signaling = sig;

  sig.on('peer-join', async ({ peerId, name }) => {
    log(`${name} 加入了房间`, 'good');
    const peer = new Peer({ peerId, name, initiator: true, iceServers: iceServers(), trickle: true });
    wirePeer(peer, sig);
    S.swarm.addPeer(peer);
    const offer = await peer.createOffer();
    sig.signal(peerId, { kind: 'offer', sdp: offer });
  });

  sig.on('signal', async ({ from, name, payload }) => {
    let peer = S.swarm.peers.get(from);
    if (payload.kind === 'offer') {
      // 收到 offer 就等于对方那边已经另起了一条连接 —— 本产品没有重协商场景，老成员只在
      // 新人进房时发一次 offer。此时手上那个同 id 的 Peer 必然是上一轮的残骸：它的
      // 数据通道可能刚被对端 abort，close 事件还堵在事件队列里没轮到。拿它去
      // setRemoteDescription，ICE 会在一条已经废掉的 pc 上重来一遍，双方都以为在协商，
      // 实际再也连不上 —— 表现就是信令一抖，传输永久停在原地。
      if (peer) S.swarm.removePeer(from);
      peer = new Peer({ peerId: from, name, initiator: false, iceServers: iceServers(), trickle: true });
      wirePeer(peer, sig);
      S.swarm.addPeer(peer);
      const answer = await peer.acceptOffer(payload.sdp);
      sig.signal(from, { kind: 'answer', sdp: answer });
      return;
    }
    if (payload.kind === 'renegotiate') {
      // 桌面端 v0.6.6 起的断线重连协议：非 initiator 一侧发这条请求，
      // 由 initiator 重发 offer。手机端不认它的话，凡是「手机当 initiator」的
      // 那条链路断了就永远回不来 —— 桌面之间能自愈，一牵扯到手机就永久卡住。
      cancelRecovery(from);
      await reconnectPeer(from, name, sig).catch((e) => log('重连 ' + (name || from) + ' 失败：' + e.message, 'bad'));
      return;
    }

    if (!peer || peer.closed) return;
    if (payload.kind === 'answer') {
      // 重协商期间可能收到上一轮的 answer，此时 pc 已是 stable，
      // setRemoteDescription 会抛 InvalidStateError。这条本来就该丢掉。
      await peer.acceptAnswer(payload.sdp).catch((e) => console.warn('[android] 丢弃对不上的应答：', e.message));
    } else if (payload.kind === 'ice') await peer.addIceCandidate(payload.candidate);
  });

  // 信令断了不等于人走了 —— 直连不经过服务器。服务重启或网络抖一下，服务器就会
  // 广播 peer-leave；这时候把健康的 P2P 拆掉，传输会白白中断到对方重连为止，
  // 而下一行的提示还写着「已建立的直连不受影响」。真正离开的人，数据通道自己会关。
  sig.on('peer-leave', ({ peerId }) => {
    cancelRecovery(peerId); // 人是真走了，不是链路断了
    const peer = S.swarm.peers.get(peerId);
    if (peer?.ctrl?.readyState === 'open') {
      log(peer.name + ' 的信令连接断了，但直连还在，传输继续', 'warn');
      return;
    }
    S.swarm.removePeer(peerId);
  });
  sig.on('reconnecting', ({ in: ms }) => log(`信令断开，${Math.round(ms / 1000)} 秒后重连（已建立的直连不受影响）`, 'warn'));
  sig.on('error', (e) => log('信令错误：' + e.message, 'bad'));

  return sig.connect();
}

/* --------------------------- 直连断线恢复 --------------------------- */
// 和桌面端同一套节奏。手机换基站、切 Wi-Fi 的频率比桌面高得多，
// 这条链路上没有自动重连，用户只能退房重来。
const RECONNECT_BACKOFF_MS = [1500, 4000, 10000];
const DISCONNECT_GRACE_MS = 6000;
const RECOVERY = new Map(); // peerId -> {attempts, timer}
const RENEGOTIATING = new Map(); // peerId -> 正在跑的重协商 Promise

function cancelRecovery(peerId) {
  const st = RECOVERY.get(peerId);
  if (st?.timer) clearTimeout(st.timer);
  RECOVERY.delete(peerId);
}

function scheduleReconnect(peer, sig) {
  if (!sig || !S.swarm || peer.closed) return;
  const peerId = peer.peerId;
  const st = RECOVERY.get(peerId) || { attempts: 0, timer: null };
  if (st.timer) return;
  if (st.attempts >= RECONNECT_BACKOFF_MS.length) {
    log('和 ' + peer.name + ' 的直连试了 ' + st.attempts + ' 次都没恢复。双方都在严格 NAT 后面时需要 TURN 中继兜底。', 'bad');
    return;
  }
  const wait = RECONNECT_BACKOFF_MS[st.attempts];
  st.attempts += 1;
  const name = peer.name;
  const initiator = peer.initiator;
  log('和 ' + name + ' 的直连断了，' + Math.round(wait / 1000) + ' 秒后自动重连（第 ' + st.attempts + ' 次）', 'warn');

  st.timer = setTimeout(() => {
    st.timer = null;
    if (!sig.connected) {
      log('信令还没恢复，暂时没法重连 ' + name, 'warn');
      return;
    }
    if (initiator) {
      reconnectPeer(peerId, name, sig).catch((e) => log('重连 ' + name + ' 失败：' + e.message, 'bad'));
    } else {
      sig.signal(peerId, { kind: 'renegotiate' });
    }
  }, wait);

  RECOVERY.set(peerId, st);
}

/** 以 initiator 身份重建一条到 peerId 的连接。同一个人同时只允许一次。 */
async function reconnectPeer(peerId, name, sig) {
  if (!S.swarm || !sig?.connected) return;
  if (RENEGOTIATING.has(peerId)) return RENEGOTIATING.get(peerId);

  const run = (async () => {
    if (S.swarm.peers.has(peerId)) S.swarm.removePeer(peerId);
    const peer = new Peer({
      peerId,
      name: name || peerId,
      initiator: true,
      iceServers: iceServers(),
      trickle: true,
    });
    wirePeer(peer, sig);
    S.swarm.addPeer(peer);
    const offer = await peer.createOffer();
    if (S.swarm.peers.get(peerId) !== peer) return; // 等 ICE 的这几秒里被顶替了
    sig.signal(peerId, { kind: 'offer', sdp: offer });
  })();

  RENEGOTIATING.set(peerId, run);
  try {
    await run;
  } finally {
    RENEGOTIATING.delete(peerId);
  }
}

function wirePeer(peer, sig) {
  if (sig) peer.on('icecandidate', (c) => sig.signal(peer.peerId, { kind: 'ice', candidate: c }));

  let graceTimer = null;
  const clearGrace = () => {
    clearTimeout(graceTimer);
    graceTimer = null;
  };

  peer.on('open', () => {
    clearGrace();
    cancelRecovery(peer.peerId);
    log(`已和 ${peer.name} 建立数据通道，正在校验房间模式…`);
  });
  peer.on('statechange', (s) => {
    if (s === 'connected' || s === 'completed') {
      clearGrace();
      cancelRecovery(peer.peerId); // ICE 自己缓过来了，撤掉排着的重连
      return;
    }
    if (s === 'disconnected' && sig && !graceTimer) {
      // 先给 ICE 一点时间自己恢复，网络抖一下就重建反而更慢。
      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (peer.pc.iceConnectionState === 'disconnected') scheduleReconnect(peer, sig);
      }, DISCONNECT_GRACE_MS);
      return;
    }
    if (s === 'failed') {
      clearGrace();
      log(`和 ${peer.name} 的直连失败了（双方都在严格 NAT 后面时会这样，需要 TURN 中继兜底）`, 'bad');
      if (sig) scheduleReconnect(peer, sig);
    }
  });
}

/* ------------------------------ 极简粘贴 ------------------------------ */
async function joinManual(hostCode) {
  let payload;
  try {
    payload = await decodeCode(hostCode);
  } catch (e) {
    log('邀请码无效：' + e.message, 'bad');
    return;
  }
  if (payload.k !== 'offer' || !payload.sdp) {
    log('这不是一个房主邀请码', 'bad');
    return;
  }
  if (normalizeSecurityMode(payload.securityMode) !== S.securityMode) {
    log(`房间使用${securityModeLabel(payload.securityMode)}，本机设置是${securityModeLabel(S.securityMode)}。请切换为相同模式后重试。`, 'bad');
    return;
  }
  S.hostId = payload.from; // 邀请码带着房主身份，认它做角色权威
  initSwarmAndSync();

  const peer = new Peer({
    peerId: payload.from,
    name: payload.name || '房主',
    initiator: false,
    iceServers: iceServers(),
    trickle: false, // 手动模式等候选集齐，SDP 自包含
  });
  wirePeer(peer, null);
  S.swarm.addPeer(peer);

  log('正在生成应答链接，收集网络候选中…（几秒）', 'warn');
  const answer = await peer.acceptOffer(payload.sdp);
  const code = await encodeCode({
    k: 'answer', from: S.peerId, name: S.name, sdp: answer, securityMode: S.securityMode,
  });

  $('answer-out').value = inviteLink(code, 'answer');
  show($('answer-wrap'), true);
  if (payload.file) log(`房主的片子：${payload.file.name} · ${fmtBytes(payload.file.size)}`);
  log('应答链接已生成，发回给房主后对方点开即可', 'good');
}

/* ------------------------------ 界面渲染 ------------------------------ */
function enterStage() {
  if (S.entered) return;
  S.entered = true;
  show($('lobby'), false);
  $('stage').style.display = 'block';
  renderRole();
}

function renderFilmInfo() {
  if (S.sourceType === 'link' && S.linkInfo) {
    $('film').textContent = `${S.linkInfo.title} · ${securityModeLabel(S.securityMode)} · 在线`;
  } else if (S.manifest) {
    $('film').textContent = `${S.manifest.name} · ${securityModeLabel(S.securityMode)}`;
  }
}

const ROLE_LABEL = { host: '房主', admin: '管理员', guest: '游客' };

/** 反映房主分给我的角色：游客禁用进度条、给出说明；管理员/房主放开控制。 */
function renderRole() {
  if (!S.sync) return;
  const canControl = S.sync.canIControl();
  const seek = $('seek');
  if (seek) {
    seek.disabled = !canControl;
    seek.style.opacity = canControl ? '' : '0.4';
  }
  const hint = $('role-hint');
  if (hint) {
    hint.textContent = canControl
      ? `身份：${ROLE_LABEL[S.sync.myRole()]}`
      : '身份：游客 · 播放/暂停仅对自己生效，不能拖动进度';
  }
}

function renderStatus(p) {
  if (S.sourceType === 'link') {
    $('status').textContent = '视频直链 · 从原网站播放 · 房间同步中';
    $('buf').firstElementChild.style.width = '100%';
    return;
  }
  const pct = Math.round((p.contiguousRatio || 0) * 100);
  const rate = fmtBytes(p.downRate || 0) + '/s';
  $('status').textContent = `可播 ${pct}% · 已有 ${p.haveCount}/${p.chunkCount} 片 · ↓${rate}`;
  $('buf').firstElementChild.style.width = pct + '%';
}

function renderPeers() {
  const n = S.swarm
    ? S.swarm.peerList().filter((p) => p.authenticated && (p.state === 'connected' || p.state === 'completed')).length
    : 0;
  $('peers').textContent = n ? `${n} 人在线` : '等待连接…';
}

let seeking = false;
$('seek').addEventListener('input', () => { seeking = true; });
$('seek').addEventListener('change', () => {
  const dur = S.sync?.duration || 0;
  if (dur > 0) S.sync.userSeek((Number($('seek').value) / 1000) * dur);
  seeking = false;
});

function renderPlayback(snap) {
  const dur = snap.duration || S.sync?.duration || 0;
  $('time').textContent = `${fmtTime(snap.position)} / ${fmtTime(dur)}`;
  if (!seeking && dur > 0) $('seek').value = Math.round((snap.position / dur) * 1000);
  const paused = S.sync ? S.sync.effectivePaused : snap.paused;
  $('pp').textContent = paused ? '▶' : '⏸';
}

function renderWaiting() {
  if (!S.sync) return;
  const st = S.sync.status();
  const w = $('waiting');
  if (st.stalled && st.waitingFor.length) {
    w.textContent = '⏳ 等待缓冲：' + st.waitingFor.join('、');
    show(w, true);
  } else {
    show(w, false);
  }
  $('pp').textContent = st.paused ? '▶' : '⏸';
}

/* ------------------------------ 事件绑定 ------------------------------ */
$('pp').addEventListener('click', () => {
  if (!S.sync) return;
  S.sync.userSetPaused(!S.sync.intendedPaused);
});

$('tab-server').addEventListener('click', () => {
  $('tab-server').classList.add('on'); $('tab-manual').classList.remove('on');
  $('panel-server').classList.add('on'); $('panel-manual').classList.remove('on');
});
$('tab-manual').addEventListener('click', () => {
  $('tab-manual').classList.add('on'); $('tab-server').classList.remove('on');
  $('panel-manual').classList.add('on'); $('panel-server').classList.remove('on');
});

$('join').addEventListener('click', async () => {
  const url = $('url').value.trim();
  const room = $('room').value.trim();
  if (!url || !room) { log('请填写信令地址和房间号', 'bad'); return; }
  initSwarmAndSync();
  log(`正在连接 ${url} …`);
  try {
    await connectSignaling(url, room);
    log('已进入房间，等待房主供片…', 'good');
  } catch (e) {
    log('连接失败：' + e.message, 'bad');
  }
});

$('gen-answer').addEventListener('click', () => {
  const code = $('host-code').value.trim();
  if (!code) { log('请先粘贴房主的邀请码', 'bad'); return; }
  joinManual(code);
});
$('copy-answer').addEventListener('click', () => {
  $('answer-out').select();
  try { document.execCommand('copy'); } catch (e) {}
  navigator.clipboard?.writeText($('answer-out').value).catch(() => {});
  log('应答链接已复制', 'good');
});

// 默认昵称
$('name').value = '观众' + Math.floor(Math.random() * 90 + 10);
$('security-mode').value = S.securityMode;
$('security-mode').addEventListener('change', () => {
  S.securityMode = normalizeSecurityMode($('security-mode').value);
  localStorage.setItem('sw.securityMode', S.securityMode);
});
$('language').value = currentLocale();
$('language').addEventListener('change', () => {
  setLocale($('language').value);
  location.reload();
});
log('准备就绪。默认使用零服务器邀请链接，也可以切换到信令服务器。');

window.noxreelOpenInvite = (link) => {
  $('tab-manual').click();
  $('host-code').value = String(link || '');
  joinManual(link);
};
