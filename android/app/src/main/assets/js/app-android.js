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
import { WsSignaling, encodeCode, decodeCode, randomPeerId } from './signaling.js';

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
  playerStarted: false,
  playerTimer: null,
  prog: { contiguousBytes: 0, complete: false },
  entered: false,
  mediaRevision: 0,
  securityMode: localStorage.getItem('sw.securityMode') === 'trusted' ? 'trusted' : 'safe',
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
function iceServers() {
  const list = [{ urls: 'stun:stun.l.google.com:19302' }];
  const turn = ($('turn') && $('turn').value.trim()) || '';
  // TURN 可选，格式 turn:host:port|user|pass（这里预留，界面暂未放出）
  if (turn) {
    const [urls, username, credential] = turn.split('|');
    list.push({ urls, username, credential });
  }
  return list;
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
  S.swarm.on('ctrl', ({ msg, peer }) => S.sync.onCtrl(msg, peer));

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
      S.sync.setMediaInfo({ duration: snap.duration, size: S.manifest.size });
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
    S.sync._evaluateStall(S.sync.lastTick, { contiguousBytes: S.prog.contiguousBytes, complete: S.prog.complete });

    // 播放位置告诉调度器，让它优先补「播放点 + 前瞻窗口」的片
    const size = S.manifest.size;
    const pb = snap.duration > 0 ? (snap.position / snap.duration) * size : 0;
    S.swarm.setPlaybackByte(pb);

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
      if (!peer) {
        peer = new Peer({ peerId: from, name, initiator: false, iceServers: iceServers(), trickle: true });
        wirePeer(peer, sig);
        S.swarm.addPeer(peer);
      }
      const answer = await peer.acceptOffer(payload.sdp);
      sig.signal(from, { kind: 'answer', sdp: answer });
      return;
    }
    if (!peer) return;
    if (payload.kind === 'answer') await peer.acceptAnswer(payload.sdp);
    else if (payload.kind === 'ice') await peer.addIceCandidate(payload.candidate);
  });

  sig.on('peer-leave', ({ peerId }) => S.swarm.removePeer(peerId));
  sig.on('reconnecting', ({ in: ms }) => log(`信令断开，${Math.round(ms / 1000)} 秒后重连（已建立的直连不受影响）`, 'warn'));
  sig.on('error', (e) => log('信令错误：' + e.message, 'bad'));

  return sig.connect();
}

function wirePeer(peer, sig) {
  if (sig) peer.on('icecandidate', (c) => sig.signal(peer.peerId, { kind: 'ice', candidate: c }));
  peer.on('open', () => {
    log(`已和 ${peer.name} 建立数据通道，正在校验房间模式…`);
  });
  peer.on('statechange', (s) => {
    if (s === 'failed') log(`和 ${peer.name} 的直连失败了（双方都在严格 NAT 后面时会这样，需要 TURN 中继兜底）`, 'bad');
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

  log('正在生成应答码，收集网络候选中…（几秒）', 'warn');
  const answer = await peer.acceptOffer(payload.sdp);
  const code = await encodeCode({
    k: 'answer', from: S.peerId, name: S.name, sdp: answer, securityMode: S.securityMode,
  });

  $('answer-out').value = code;
  show($('answer-wrap'), true);
  if (payload.file) log(`房主的片子：${payload.file.name} · ${fmtBytes(payload.file.size)}`);
  log('应答码已生成，发回给房主', 'good');
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
  if (S.manifest) $('film').textContent = `${S.manifest.name} · ${securityModeLabel(S.securityMode)}`;
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
  log('应答码已复制', 'good');
});

// 默认昵称
$('name').value = '观众' + Math.floor(Math.random() * 90 + 10);
$('security-mode').value = S.securityMode;
$('security-mode').addEventListener('change', () => {
  S.securityMode = normalizeSecurityMode($('security-mode').value);
  localStorage.setItem('sw.securityMode', S.securityMode);
});
log('准备就绪。填写信令地址和房间号加入，或用极简粘贴。');
