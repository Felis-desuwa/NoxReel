import { Peer } from './lib/peer.js';
import { Swarm } from './lib/swarm.js';
import { SyncEngine } from './lib/syncEngine.js';
import { MSG } from './lib/protocol.js';
import { encodeCode, decodeCode, WsSignaling, randomRoomId, randomPeerId } from './lib/signaling.js';

/**
 * UI 与编排层。把存储、传输、调度、同步、播放器串起来。
 *
 * 两条连接路径：
 *  - manual（极简模式）：复制粘贴 SDP，零服务器。星型拓扑 —— 每个人都只连发起者。
 *  - server（信令模式）：走 WebSocket 信令，全互联网状拓扑，谁都能给谁供片。
 */

const $ = (id) => document.getElementById(id);
const randomInt = (min, max) => {
  const value = crypto.getRandomValues(new Uint32Array(1))[0];
  return min + (value % (max - min + 1));
};

function make(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.id) node.id = options.id;
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = String(options.text);
  if (options.attrs) {
    for (const [name, value] of Object.entries(options.attrs)) node.setAttribute(name, String(value));
  }
  if (options.props) Object.assign(node, options.props);
  for (const child of children.flat(Infinity)) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function replace(target, ...children) {
  const node = typeof target === 'string' ? $(target) : target;
  node.replaceChildren(...children.flat(Infinity));
  return node;
}

function field(label, ...children) {
  return make('div', { className: 'field' }, [make('label', { text: label }), ...children]);
}

function hint(...children) {
  return make('p', { className: 'hint' }, children);
}

const S = {
  peerId: randomPeerId(),
  name: localStorage.getItem('sw.name') || `观众-${randomInt(100, 999)}`,
  mode: null, // 'manual' | 'server'
  role: null, // 'host' | 'guest'（发起 or 加入，跟权限角色是两回事）
  hostId: null, // 房主的 peerId —— 角色权威只认它，从邀请码得来
  env: null,
  geo: null,
  swarm: null,
  sync: null,
  signaling: null,
  manifest: null,
  sourceType: null, // 'file' | 'link'
  linkInfo: null,
  syncStarted: false,
  sessionId: null,
  filePath: null,
  isSeeder: false,
  mpvRunning: false,
  switchingMedia: false,
  mediaRevision: 0,
  roomCapacity: Math.max(2, Math.min(16, Number(localStorage.getItem('sw.roomCapacity')) || 4)),
  pendingManualPeer: null,
  settings: {
    signalUrl: localStorage.getItem('sw.signalUrl') || 'ws://localhost:8080',
    stun: localStorage.getItem('sw.stun') || 'stun:stun.l.google.com:19302',
    turnUrl: localStorage.getItem('sw.turnUrl') || '',
    turnUser: localStorage.getItem('sw.turnUser') || '',
    turnPass: localStorage.getItem('sw.turnPass') || '',
    turnEnabled: localStorage.getItem('sw.turnEnabled') !== '0',
  },
};

/* ------------------------------- 工具函数 ------------------------------- */

const fmtBytes = (b) => {
  if (!b || b < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};

const fmtRate = (bps) => (bps > 0 ? `${fmtBytes(bps)}/s` : '—');
const clampCapacity = (value) => Math.max(2, Math.min(16, Number.parseInt(value, 10) || 4));

function connectedPeerCount() {
  return (S.swarm?.peerList() || []).filter((p) => p.state === 'connected' || p.state === 'completed').length;
}

async function copyCode(code, button, idleLabel = '复制邀请码') {
  try {
    await Promise.resolve(window.sw.clipboard.writeText(code));
    button.textContent = `已复制完整 ${code.length} 字符 ✓`;
    setTimeout(() => (button.textContent = idleLabel), 1800);
  } catch (e) {
    button.textContent = '复制失败，请手动全选';
    log(`复制邀请码失败：${e.message || e}`, 'bad');
  }
}

const fmtTime = (s) => {
  if (!s || !isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
};

function show(viewId) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  $(viewId).classList.add('active');
  $('topbar').classList.toggle('hidden', viewId === 'view-boot');
}

function log(text, kind = '') {
  const el = $('event-log');
  if (!el) return;
  const line = document.createElement('div');
  line.className = `log-line ${kind}`;
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  line.append(make('span', { className: 'log-time', text: t }), make('span', { text }));
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  while (el.children.length > 300) el.removeChild(el.firstChild);
}

function iceServers() {
  const list = [{ urls: S.settings.stun }];
  // TURN 是打洞失败时的兜底（CGNAT、卫星网络这类场景）。默认开着，
  // 但需要用户自己填服务器 —— 我们不代运营中继。
  if (S.settings.turnEnabled && S.settings.turnUrl) {
    list.push({
      urls: S.settings.turnUrl,
      username: S.settings.turnUser,
      credential: S.settings.turnPass,
    });
  }
  return list;
}

/* -------------------------------- 启动 -------------------------------- */

async function boot() {
  $('boot-status').textContent = '正在检查运行环境…';

  // 地区探测只用于告知，不阻止任何人使用，所以不必卡住启动流程。
  window.sw.geo.check().then(applyGeoNotice);

  S.env = await window.sw.env.status();
  await window.sw.env.ensureDirs();

  updateDepsPill();
  show('view-home');
}

/**
 * 地区策略：告知 + 服务条款声明，仅此而已。
 * 探测到不在设计范围内就把话说清楚（打洞大概率失败、需要自备 TURN、
 * 这些问题不在支持范围内），然后让用户自己决定。
 */
function applyGeoNotice(geo) {
  S.geo = geo;

  const pill = $('pill-geo');
  if (geo.determined) {
    pill.textContent = `地区 ${geo.country}`;
    pill.className = geo.inScope ? 'pill ok' : 'pill warn';
  } else {
    pill.textContent = '地区未知';
    pill.className = 'pill';
  }

  if (geo.inScope || !geo.notice) return;

  pill.title = geo.notice;
  $('geo-notice-text').textContent = geo.notice;
  $('geo-notice').classList.remove('hidden');
}

// 关闭按钮无条件接线：告知条是提示性质的，必须随时能划走
$('geo-notice-x').onclick = () => $('geo-notice').classList.add('hidden');

function updateDepsPill() {
  const pill = $('pill-deps');
  const missing = [];
  if (!S.env.mpv) missing.push('mpv');
  if (!S.env.ffmpeg) missing.push('ffmpeg');
  if (!S.env.ytDlp) missing.push('yt-dlp');

  if (!missing.length) {
    pill.textContent = '依赖就绪';
    pill.className = 'pill ok';
    pill.onclick = null;
  } else {
    pill.textContent = `缺少 ${missing.join(' / ')}`;
    pill.className = 'pill warn';
    pill.onclick = showDepsHelp;
  }
}

function showDepsHelp() {
  const dependency = (label, found, missing) =>
    field(
      label,
      found ? hint('已找到：', make('code', { text: found })) : hint(missing)
    );

  openModal({
    title: '缺少外部依赖',
    body: () => [
      make('p', {
        className: 'fine',
        text: 'NoxReel 不自研播放器、编解码器和网站解析器，靠这些成熟组件干活：',
      }),
      dependency('mpv —— 播放器（必需）', S.env.mpv, '未找到。装好后重启本软件即可。'),
      dependency('ffmpeg —— 转封装（按需）', S.env.ffmpeg, '未找到。只有当片子需要转封装时才会用到。'),
      dependency(
        'yt-dlp —— 视频网页解析（按需）',
        S.env.ytDlp,
        '未找到。MP4/HLS 直链仍可播放，视频网站页面链接不可用。'
      ),
      field(
        '安装方式（任选其一）',
        hint(
          make('code', { text: 'winget install shinchiro.mpv Gyan.FFmpeg yt-dlp.yt-dlp' }),
          make('br'),
          make('code', { text: 'scoop install mpv ffmpeg yt-dlp' }),
          make('br'),
          '或者手动下载后，把可执行文件路径写进环境变量 ',
          make('code', { text: 'SYNCWATCH_MPV_PATH' }),
          ' / ',
          make('code', { text: 'SYNCWATCH_FFMPEG_PATH' }),
          ' / ',
          make('code', { text: 'SYNCWATCH_YTDLP_PATH' }),
          '。'
        )
      ),
    ],
    okText: '重新检测',
    onOk: async () => {
      S.env = await window.sw.env.status();
      updateDepsPill();
      return true;
    },
  });
}

/* ------------------------------ 发起放映 ------------------------------ */

const dz = $('dropzone');
dz.addEventListener('click', async () => {
  const p = await window.sw.dialog.pickVideo();
  if (p) startHost(p);
});

$('btn-link').addEventListener('click', () => startHostLink($('video-link').value));
$('video-link').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startHostLink(e.currentTarget.value);
});
dz.addEventListener('dragover', (e) => {
  e.preventDefault();
  dz.classList.add('over');
});
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  dz.classList.remove('over');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const path = window.sw.pathForFile(file);
  if (!path) return alert('拿不到这个文件的路径，请改用点击选择。');
  startHost(path);
});

// 别让拖到窗口别处的文件把整个页面替换掉
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

function setSteps(steps) {
  replace(
    'prep-steps',
    steps.map((step) =>
      make('div', { className: `step ${step.state}` }, [
        make('span', {
          className: 'step-mark',
          text: step.state === 'done' ? '✓' : step.state === 'active' ? '▸' : '·',
        }),
        make('span', { text: step.label }),
      ])
    )
  );
}

async function startHost(filePath) {
  let temporaryPath = null;
  let preparedSessionId = null;
  if (!roomEntered) {
    S.role = 'host';
    S.hostId = S.peerId; // 房主就是自己，角色权威在我这
  }

  show('view-prepare');
  $('prep-title').textContent = '正在准备文件';
  $('prep-file').textContent = filePath;
  $('prep-bar').style.width = '0%';
  replace('prep-actions');
  $('prep-note').textContent = '';

  const steps = [
    { label: '检查格式与兼容性', state: 'active' },
    { label: '转封装（按需）', state: '' },
    { label: '计算分片校验值', state: '' },
    { label: '创建房间', state: '' },
  ];
  setSteps(steps);

  try {
    // 1. 兼容性检查
    const info = await window.sw.media.inspect(filePath);

    if (info.action === 'reject') {
      return prepFail(info.reason);
    }

    if (info.action === 'remux') {
      steps[0].state = 'done';
      steps[1].state = 'active';
      setSteps(steps);
      $('prep-note').textContent = info.reason;

      if (!S.env.ffmpeg) {
        return prepFail(
          '这个 MP4 需要转封装才能边下边播，但没找到 ffmpeg。装上 ffmpeg 后重试，或者换一个 MKV 文件。'
        );
      }

      const ok = await confirmRemux(info);
      if (!ok) return backHome();

      $('prep-title').textContent = '正在转封装';
      const off = window.sw.media.onRemuxProgress(({ progress }) => {
        $('prep-bar').style.width = `${(progress * 100).toFixed(1)}%`;
      });
      try {
        const { outPath } = await window.sw.media.remux(filePath);
        filePath = outPath;
        temporaryPath = outPath;
        $('prep-note').textContent = `已转封装到：${outPath}`;
      } finally {
        off();
      }
    }

    // 2. 分片 + 哈希
    steps[0].state = 'done';
    steps[1].state = 'done';
    steps[2].state = 'active';
    setSteps(steps);
    $('prep-title').textContent = '正在计算分片校验值';
    $('prep-note').textContent =
      '每个分片单独算一次 SHA-256。对方收到一片就能立刻验一片，不用等整个文件下完 —— 这就是「渐进式校验」。';
    $('prep-bar').style.width = '0%';

    const offHash = window.sw.store.onHashProgress(({ done, total }) => {
      $('prep-bar').style.width = `${((done / total) * 100).toFixed(1)}%`;
    });
    let manifest;
    try {
      manifest = await window.sw.store.buildManifest(filePath);
    } finally {
      offHash();
    }

    // 3. 开做种会话
    steps[2].state = 'done';
    steps[3].state = 'active';
    setSteps(steps);

    manifest = { ...manifest, roomRevision: S.mediaRevision + 1 };
    const state = await window.sw.store.openSeed(manifest, filePath);
    preparedSessionId = state.sessionId;

    steps[3].state = 'done';
    setSteps(steps);

    await activateFileSession({ manifest, state, filePath, isSeeder: true });
    preparedSessionId = null;
    temporaryPath = null;
  } catch (e) {
    if (preparedSessionId) {
      await window.sw.store.close(preparedSessionId).catch(() => {});
      if (S.sessionId === preparedSessionId) {
        S.sessionId = null;
        S.filePath = null;
        S.manifest = null;
      }
    } else if (temporaryPath) {
      await window.sw.media.releaseTemp(temporaryPath).catch(() => {});
    }
    console.error(e);
    prepFail(e.message || String(e));
  }
}

async function startHostLink(rawUrl) {
  const url = String(rawUrl || '').trim();
  $('link-err').textContent = '';
  if (!url) return;

  if (!roomEntered) {
    S.role = 'host';
    S.hostId = S.peerId;
  }

  show('view-prepare');
  $('prep-title').textContent = '正在解析视频链接';
  $('prep-file').textContent = url;
  $('prep-bar').style.width = '35%';
  $('prep-note').textContent = '只读取媒体信息，不下载视频。每位参与者会直接从原始网站播放。';
  replace('prep-actions');
  setSteps([
    { label: '验证链接', state: 'done' },
    { label: '解析视频信息', state: 'active' },
    { label: '创建同步房间', state: '' },
  ]);

  try {
    const linkInfo = await window.sw.media.inspectLink(url);
    $('prep-bar').style.width = '85%';
    setSteps([
      { label: '验证链接', state: 'done' },
      { label: '解析视频信息', state: 'done' },
      { label: '创建同步房间', state: 'active' },
    ]);
    await activateLinkSession(linkInfo, { revision: S.mediaRevision + 1, broadcast: true });
  } catch (e) {
    console.error(e);
    prepFail(e.message || String(e));
  }
}

async function stopCurrentMedia() {
  const oldSessionId = S.sessionId;
  S.switchingMedia = true;
  S.mpvRunning = false;
  $('btn-playpause').disabled = true;
  $('btn-reopen')?.classList.add('hidden');
  S.swarm?.clearSession();
  await window.sw.mpv.quit().catch(() => {});
  if (oldSessionId) await window.sw.store.close(oldSessionId).catch(() => {});
}

async function activateFileSession({ manifest, state, filePath, isSeeder }) {
  await stopCurrentMedia();
  S.mediaRevision = Number(manifest.roomRevision) > 0
    ? Math.max(S.mediaRevision, Number(manifest.roomRevision))
    : S.mediaRevision + 1;
  manifest.roomRevision = S.mediaRevision;
  S.sourceType = 'file';
  S.linkInfo = null;
  S.manifest = manifest;
  S.sessionId = state.sessionId;
  S.filePath = filePath;
  S.isSeeder = !!isSeeder;

  initSwarmAndSync();
  S.sync.resetMedia({ isSeeder: S.isSeeder });
  S.swarm.setSession({ manifest, sessionId: state.sessionId, isSeeder: S.isSeeder, state });
  S.sync.sizeHint = manifest.size;
  S.switchingMedia = false;

  if (!roomEntered) await enterRoom();
  else {
    show('view-room');
    refreshMediaUi();
    onSessionReady();
    maybeLaunchPlayer(S.swarm.progress());
    log(`已切换到：${manifest.name}`, 'good');
  }
}

async function activateLinkSession(linkInfo, { revision, broadcast = false } = {}) {
  await stopCurrentMedia();
  S.mediaRevision = Number(revision) > 0 ? Math.max(S.mediaRevision, Number(revision)) : S.mediaRevision + 1;
  S.sourceType = 'link';
  S.linkInfo = linkInfo;
  S.manifest = null;
  S.sessionId = null;
  S.filePath = linkInfo.url;
  S.isSeeder = true; // 链接由每台电脑直接读取，不需要 P2P 分片

  initSwarmAndSync();
  S.sync.resetMedia({ isSeeder: true });
  S.switchingMedia = false;

  if (!roomEntered) await enterRoom();
  else {
    show('view-room');
    refreshMediaUi();
    await onLinkSessionReady();
    log(`已切换到链接：${linkInfo.title || linkInfo.url}`, 'good');
  }

  if (broadcast && S.role === 'host') {
    for (const peer of S.swarm.peers.values()) {
      peer.send({
        t: MSG.MEDIA_LINK,
        url: linkInfo.url,
        title: linkInfo.title,
        duration: linkInfo.duration || 0,
        revision: S.mediaRevision,
      });
    }
  }
}

function confirmRemux(info) {
  return new Promise((resolve) => {
    openModal({
      title: '这个文件需要先转封装',
      body: () => {
        const action = field(
          '会做什么',
          hint(
            '只重写容器外壳，把索引挪到文件开头。视频和音频数据原样搬运，',
            make('b', { text: '不重新编码' }),
            '，画质无损，通常几十秒完成。'
          )
        );
        action.style.marginTop = '14px';
        return [
          make('p', { className: 'fine', text: info.reason }),
          action,
          field('产物', hint('生成一个新文件，原文件不动。')),
        ];
      },
      okText: '转封装并继续',
      onOk: () => {
        resolve(true);
        return true;
      },
      onCancel: () => resolve(false),
    });
  });
}

function prepFail(msg) {
  $('prep-title').textContent = '没法用这个文件';
  $('prep-note').textContent = msg;
  $('prep-bar').style.width = '0%';
  const back = make('button', { id: 'prep-back', className: 'ghost', text: '返回' });
  back.onclick = backHome;
  replace('prep-actions', back);
}

function backHome() {
  show(roomEntered ? 'view-room' : 'view-home');
}

/* ------------------------------ 加入放映 ------------------------------ */

$('btn-join').onclick = async () => {
  const raw = $('join-code').value.trim();
  $('join-err').textContent = '';
  if (!raw) return;

  try {
    const payload = await decodeCode(raw);

    if (payload.k === 'room') return joinViaServer(payload);
    if (payload.k === 'offer') return joinViaManual(payload);
    if (payload.k === 'answer') {
      $('join-err').textContent = '这是一个应答码，应该由发起方粘贴，不是你。';
      return;
    }
    $('join-err').textContent = '无法识别的邀请码类型。';
  } catch (e) {
    $('join-err').textContent = e.message;
  }
};

/** 极简模式：收到 offer，产出 answer 让对方粘回去。 */
async function joinViaManual(payload) {
  S.role = 'guest';
  S.hostId = payload.from; // 邀请码里带着房主身份，认它做角色权威
  S.mode = 'manual';
  S.isSeeder = false;
  S.roomCapacity = clampCapacity(payload.maxMembers || S.roomCapacity);

  show('view-prepare');
  $('prep-title').textContent = '正在建立点对点连接';
  $('prep-file').textContent = payload.file ? `${payload.file.name} · ${fmtBytes(payload.file.size)}` : '';
  $('prep-note').textContent = '正在收集网络候选地址，通常需要几秒钟…';
  setSteps([
    { label: '解析邀请码', state: 'done' },
    { label: '生成应答码', state: 'active' },
    { label: '等待对方粘贴应答码', state: '' },
  ]);
  $('prep-bar').style.width = '40%';

  initSwarmAndSync();

  const peer = new Peer({
    peerId: payload.from,
    name: payload.name || '发起者',
    initiator: false,
    iceServers: iceServers(),
    trickle: false, // 手动模式必须等候选集齐，SDP 得是自包含的
  });
  wirePeer(peer);
  S.swarm.addPeer(peer);

  const answer = await peer.acceptOffer(payload.sdp);
  const code = await encodeCode({ k: 'answer', from: S.peerId, name: S.name, sdp: answer });

  setSteps([
    { label: '解析邀请码', state: 'done' },
    { label: '生成应答码', state: 'done' },
    { label: '等待对方粘贴应答码', state: 'active' },
  ]);
  $('prep-bar').style.width = '75%';
  $('prep-title').textContent = '把这段应答码发回给发起者';
  replace(
    'prep-note',
    make('b', { text: '还差最后一步：' }),
    '把下面这段发回给对方，他粘贴之后连接才建立。这一来一回是「零服务器」的代价 —— 没有服务器帮你们交换地址，就只能你们自己传。'
  );
  const answerArea = make('textarea', {
    id: 'answer-code',
    attrs: { readonly: '', rows: 4 },
  });
  answerArea.style.width = '100%';
  const copyAnswer = make('button', { id: 'copy-answer', className: 'primary', text: '复制应答码' });
  replace('prep-actions', answerArea, copyAnswer);
  $('answer-code').value = code;
  $('answer-code').select();
  $('copy-answer').onclick = () => copyCode(code, $('copy-answer'), '复制应答码');

  // 连上之后 swarm 会收到清单，那时才真正进房
  peer.once('open', () => enterRoom());
}

/** 信令模式：连服务器，进房间，等对方发 offer 过来。 */
async function joinViaServer(payload) {
  S.role = 'guest';
  S.hostId = payload.from; // 邀请码里带着房主身份，认它做角色权威
  S.mode = 'server';
  S.isSeeder = false;
  S.roomCapacity = clampCapacity(payload.maxMembers || S.roomCapacity);

  show('view-prepare');
  $('prep-title').textContent = '正在连接信令服务器';
  $('prep-file').textContent = payload.file ? `${payload.file.name} · ${fmtBytes(payload.file.size)}` : '';
  setSteps([
    { label: '解析邀请码', state: 'done' },
    { label: '连接信令服务器', state: 'active' },
    { label: '建立点对点连接', state: '' },
  ]);
  $('prep-bar').style.width = '35%';

  initSwarmAndSync();

  try {
    await connectSignaling(payload.url, payload.room);
    setSteps([
      { label: '解析邀请码', state: 'done' },
      { label: '连接信令服务器', state: 'done' },
      { label: '建立点对点连接', state: 'active' },
    ]);
    $('prep-bar').style.width = '70%';
    $('prep-note').textContent = '已进入房间，正在和其他成员打洞…';
  } catch (e) {
    return prepFail(
      e.code === 'REGION_BLOCKED'
        ? e.message
        : `${e.message}\n\n如果对方没有部署信令服务器，让他改用「极简模式」生成邀请码 —— 那个不需要服务器。`
    );
  }
}

/* ------------------------------ 信令连接 ------------------------------ */

async function connectSignaling(url, roomId) {
  const sig = new WsSignaling({
    url,
    roomId,
    peerId: S.peerId,
    name: S.name,
    maxMembers: S.role === 'host' ? S.roomCapacity : 0,
  });
  S.signaling = sig;

  // 规则：房间里的老成员向新来的发起 offer。这样不会两边同时发 offer 撞车。
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
  sig.on('joined', ({ maxMembers }) => {
    if (maxMembers) S.roomCapacity = clampCapacity(maxMembers);
    renderCapacityStatus();
  });
  sig.on('room-config', ({ maxMembers }) => {
    S.roomCapacity = clampCapacity(maxMembers);
    renderCapacityStatus();
    log(`房间人数上限已设为 ${S.roomCapacity}`, 'good');
  });
  sig.on('reconnecting', ({ in: ms }) => log(`信令断开，${Math.round(ms / 1000)} 秒后重连（已建立的直连不受影响）`, 'warn'));
  sig.on('error', (e) => log(`信令错误：${e.message}`, 'bad'));

  return sig.connect();
}

/* ------------------------------ peer 接线 ------------------------------ */

function wirePeer(peer, sig) {
  if (sig) peer.on('icecandidate', (c) => sig.signal(peer.peerId, { kind: 'ice', candidate: c }));

  peer.on('open', () => {
    log(`已和 ${peer.name} 建立直连`, 'good');
    S.sync?.greet(peer);
    if (S.role === 'host' && S.sourceType === 'link' && S.linkInfo) {
      peer.send({
        t: MSG.MEDIA_LINK,
        url: S.linkInfo.url,
        title: S.linkInfo.title,
        duration: S.linkInfo.duration || 0,
        revision: S.mediaRevision,
      });
    }
  });
  peer.on('statechange', (s) => {
    if (s === 'failed') {
      log(
        `和 ${peer.name} 的直连失败了。双方都在严格 NAT 后面时会这样 —— 在设置里配一个 TURN 中继可以兜底。`,
        'bad'
      );
    }
  });
  peer.on('close', () => {
    log(`${peer.name} 断开了`, 'warn');
    S.sync?.peerGone(peer.peerId);
  });
  peer.on('ctrl', (msg) => {
    if (msg.t === MSG.MEDIA_LINK) handleMediaLink(msg, peer);
    else S.sync?.onCtrl(msg, peer);
  });
}

async function handleMediaLink(msg, peer) {
  // 片源类型只能由邀请码中钉死的房主指定，防止普通成员替换全房媒体。
  if (S.role === 'host' || !S.hostId || peer.peerId !== S.hostId) return;
  if (typeof msg.url !== 'string') return;
  if (Number(msg.revision) && Number(msg.revision) <= S.mediaRevision) return;

  show('view-prepare');
  $('prep-title').textContent = '正在本机解析房主的视频链接';
  $('prep-file').textContent = msg.title || msg.url;
  $('prep-bar').style.width = '45%';
  $('prep-note').textContent = '视频由你的电脑直接从原网站读取；信令服务器和房主都不会中转内容。';
  setSteps([
    { label: '验证房主身份', state: 'done' },
    { label: '解析视频链接', state: 'active' },
    { label: '启动播放器', state: '' },
  ]);

  try {
    const local = await window.sw.media.inspectLink(msg.url);
    if (Number(msg.revision) && Number(msg.revision) <= S.mediaRevision) return;
    const linkInfo = {
      ...local,
      title: msg.title || local.title,
      duration: Number(msg.duration) || local.duration || 0,
    };
    $('prep-bar').style.width = '90%';
    await activateLinkSession(linkInfo, { revision: Number(msg.revision) || S.mediaRevision + 1 });
  } catch (e) {
    prepFail(`这个视频链接在你的电脑上无法解析：${e.message || e}`);
  }
}

/* ------------------------------ swarm/同步 ----------------------------- */

function initSwarmAndSync() {
  if (S.swarm) return;

  S.swarm = new Swarm({ peerId: S.peerId, name: S.name });
  S.sync = new SyncEngine({
    peerId: S.peerId,
    name: S.name,
    isSeeder: S.isSeeder,
    hostId: S.hostId, // 房主=自身 peerId；加入者=邀请码里的房主 id。两条路都已提前设好
  });

  S.sync.onSetPause = (p) => window.sw.mpv.setPause(p).catch(() => {});
  S.sync.onSeek = (pos) => window.sw.mpv.seek(pos).catch(() => {});

  // 同步引擎要发的消息，广播给所有 peer
  S.sync.on('outbound', (msg) => {
    for (const p of S.swarm.peers.values()) p.send(msg);
  });

  S.sync.on('stall-change', ({ name, stalled, self }) => {
    const who = self ? '你' : name;
    // 游客的缓冲不足只暂停自己，别喊「全员暂停」误导人。
    const guestSelf = self && !S.sync.canIControl();
    if (stalled) {
      log(
        guestSelf ? '你的缓冲不够，先暂停你自己（不影响他人）' : `${who}的缓冲跟不上了，全员暂停等待`,
        'warn'
      );
      window.sw.mpv.osd(guestSelf ? '缓冲不足，暂停你自己…' : `等待 ${who} 缓冲…`, 3000);
    } else {
      log(`${who}缓冲够了`, 'good');
    }
  });

  S.sync.on('remote-action', ({ kind, by, position }) => {
    const label = { play: '播放', pause: '暂停', seek: '跳转' }[kind] || kind;
    log(`${by} ${label} @ ${fmtTime(position)}`);
  });

  S.sync.on('state', renderStatus);
  S.sync.on('margin', renderStatus);

  // 角色变化：重画成员列表（含标签/切换按钮）、更新我自己的身份提示。
  S.sync.on('roles', () => {
    renderPeers();
    renderMyRole();
  });

  // 游客试图跳转被拦下的反馈。
  S.sync.on('denied', ({ action }) => {
    if (action === 'seek') {
      log('你是游客，不能跳转进度', 'warn');
      window.sw.mpv.osd('游客不能跳转进度', 2000);
    }
  });

  // 我这边还没有文件 → 对方把清单发来了 → 建接收会话
  S.swarm.on('manifest-offer', async ({ manifest, from }) => {
    if (S.role === 'host') return;
    if (S.hostId && from !== S.hostId) {
      log('忽略了非房主发来的换片请求', 'warn');
      return;
    }
    const revision = Number(manifest.roomRevision) || 0;
    if (revision && revision <= S.mediaRevision) return;

    const state = await window.sw.store.openLeech(manifest);
    if (revision && revision <= S.mediaRevision) {
      await window.sw.store.close(state.sessionId).catch(() => {});
      return;
    }
    await activateFileSession({ manifest, state, filePath: state.filePath, isSeeder: false });

    log(`开始接收：${manifest.name}（${fmtBytes(manifest.size)}，${manifest.chunkCount} 片）`, 'good');

    maybeLaunchPlayer(S.swarm.progress());
  });

  S.swarm.on('mismatch', ({ peerId }) => {
    log(`${peerId} 手里是另一个文件，已忽略他的分片`, 'warn');
  });
  S.swarm.on('chunk-bad', ({ index, reason }) => {
    log(`分片 ${index} 校验未通过（${reason}），已丢弃重下`, 'warn');
  });
  // 接收进度是 stall 评估的第二个驱动源。全员暂停后 mpv 不再发 tick，
  // 只剩这条路能把「缓冲攒够了」告诉同步引擎。
  S.swarm.on('progress', (p) => {
    S.sync.onBufferProgress({ contiguousBytes: p.contiguousBytes, complete: p.complete });
    maybeLaunchPlayer(p);
    renderProgress(p);
  });
  S.swarm.on('peers', renderPeers);
  S.swarm.on('complete', () => {
    log('文件已全部接收并校验通过；退出房间后会自动删除缓存', 'good');
    window.sw.mpv.osd('接收完成 · 退出房间后自动清理', 2500);
  });

  S.swarm.start();
}

/* ------------------------------- 进入房间 ------------------------------ */

let roomEntered = false;

async function enterRoom() {
  if (roomEntered) return;
  roomEntered = true;

  initSwarmAndSync();

  if (S.isSeeder && S.manifest) {
    S.swarm.setSession({ manifest: S.manifest, sessionId: S.sessionId, isSeeder: true });
    S.sync.sizeHint = S.manifest.size;
  }

  show('view-room');

  refreshMediaUi();
  renderMyRole();
  renderInvite();
  renderPeers([]);

  // 片源进房时会话已经就绪；观众要等清单到了才由 manifest-offer 那边调
  if (S.isSeeder && S.manifest) onSessionReady();
  else if (S.sourceType === 'link' && S.linkInfo) await onLinkSessionReady();
}

function refreshMediaUi() {
  renderFilmInfo();
  renderProgress(S.swarm?.progress());
  $('btn-reveal').classList.toggle('hidden', S.sourceType === 'link');
  $('btn-reveal').textContent = S.isSeeder ? '打开源文件位置' : '打开临时缓存位置';
  $('buffer').classList.toggle('link-mode', S.sourceType === 'link');
  $('media-switch-block')?.classList.toggle('hidden', S.role !== 'host');
  $('btn-reopen')?.classList.toggle('hidden', S.mpvRunning || !S.filePath);
}

/**
 * 渲染片名和元信息。
 *
 * 这个不能塞进 enterRoom：观众是先建立连接进房、之后才收到清单的，
 * 而 enterRoom 有个只跑一次的守卫。放在里面的话，观众进房时 manifest 还是 null，
 * 等清单到了又被守卫挡回去，结果房间头部永远是空的。
 */
function renderFilmInfo() {
  if (S.sourceType === 'link' && S.linkInfo) {
    $('room-file').textContent = S.linkInfo.title || '在线视频';
    const duration = S.linkInfo.duration ? ` · ${fmtTime(S.linkInfo.duration)}` : '';
    $('room-meta').textContent = `视频链接 · ${S.linkInfo.extractor || 'direct'}${duration} · 每位成员从原网站播放`;
    return;
  }
  if (!S.manifest) return;
  $('room-file').textContent = S.manifest.name;
  $('room-meta').textContent = `${fmtBytes(S.manifest.size)} · ${S.manifest.chunkCount} 片 × ${fmtBytes(
    S.manifest.chunkSize
  )} · ${S.isSeeder ? '你是片源' : '接收中'}`;
}

/**
 * mpv 要读到文件开头的 moov 索引才能解出时长、建立时间轴。
 * 接收方一开始拿到的是一个全零的稀疏文件 —— 这时候把 mpv 拉起来，它找不到索引，
 * 会把时长判成未知，而且之后不会再重新探测。表现是进度永远 0:00、
 * 前瞻窗口和 stall 阈值全部退化成兜底常量。所以必须等片头落地再起播放器。
 *
 * 8MB 对绝大多数文件都够装下 moov（16 分钟 1080p 的 moov 约几百 KB）。
 */
const HEAD_READY_BYTES = 8 * 1024 * 1024;

/** 会话就绪：同步引擎立刻开工（哪怕播放器还没起，也要参与 stall 计算）。 */
function onSessionReady() {
  renderFilmInfo();
  S.syncStarted = true;
  S.sync.start();
  if (S.isSeeder) launchPlayer(); // 片源本地就有完整文件，不用等
}

async function onLinkSessionReady() {
  if (!S.linkInfo) return;
  renderFilmInfo();
  S.syncStarted = true;
  if (S.linkInfo.duration) S.sync.setMediaInfo({ duration: S.linkInfo.duration, size: 0 });
  S.sync.start();
  await launchPlayer();
  renderProgress(S.swarm.progress());
}

/** 接收方：片头够了才起播放器。在此之前我们会一直处于 stall，全员等着。 */
function maybeLaunchPlayer(p) {
  if (S.mpvRunning || S.isSeeder || !S.filePath) return;
  if (p.contiguousBytes >= HEAD_READY_BYTES || p.complete) launchPlayer();
}

async function launchPlayer() {
  if (S.mpvRunning || !S.filePath) return;
  S.mpvRunning = true; // 先占位，防止 progress 事件密集时重复拉起
  try {
    await window.sw.mpv.launch(S.filePath, true);
    $('btn-playpause').disabled = false;
    $('btn-reopen')?.classList.add('hidden');
    log('mpv 已启动（先暂停着，等所有人就绪）', 'good');
  } catch (e) {
    S.mpvRunning = false; // 占位撤回，否则再也不会重试
    $('btn-reopen')?.classList.remove('hidden');
    if (e.message.includes('mpv')) {
      log('没找到 mpv，无法播放。装好 mpv 后点右上角「重新检测」。', 'bad');
      showDepsHelp();
    } else {
      log(`启动 mpv 失败：${e.message}`, 'bad');
    }
  }
}

/* ------------------------------- 邀请区 ------------------------------- */

function inviteMediaInfo() {
  if (S.sourceType === 'link' && S.linkInfo) {
    return { name: S.linkInfo.title || '在线视频', size: 0, kind: 'link' };
  }
  return { name: S.manifest?.name || '视频', size: S.manifest?.size || 0, kind: 'file' };
}

async function renderInvite() {
  const box = $('invite-body');

  if (S.role !== 'host') {
    replace(box, make('p', { text: '你是通过邀请加入的。要拉更多人进来，让发起者再生成一个邀请码。' }));
    return;
  }

  const capacityInput = make('input', {
    id: 'room-capacity',
    attrs: { type: 'number', min: 2, max: 16 },
    props: { value: String(S.roomCapacity) },
  });
  replace(
    box,
    make('div', { className: 'capacity-row' }, [
      make('label', { text: '房间人数上限', attrs: { for: 'room-capacity' } }),
      capacityInput,
      make('button', { className: 'ghost', id: 'capacity-apply', text: '应用' }),
    ]),
    make('p', { className: 'fine', id: 'capacity-status' }),
    make('button', { className: 'primary', id: 'inv-server', text: '用信令服务器邀请' }),
    make('button', { className: 'ghost', id: 'inv-manual', text: '极简模式（零服务器）' }),
    make('p', {
      id: 'inv-hint',
      text: '信令服务器只转发连接地址，不碰视频内容。极简模式连这个都不要，代价是要手动来回粘贴两次。',
    }),
    make('div', { id: 'inv-out' })
  );

  $('inv-server').onclick = inviteViaServer;
  $('inv-manual').onclick = inviteViaManual;
  $('capacity-apply').onclick = applyRoomCapacity;
  renderCapacityStatus();
}

function renderCapacityStatus() {
  const input = $('room-capacity');
  const status = $('capacity-status');
  if (input) input.value = String(S.roomCapacity);
  if (status) status.textContent = `当前 ${connectedPeerCount() + 1} / ${S.roomCapacity} 人（包含房主）`;
}

function applyRoomCapacity() {
  const next = clampCapacity($('room-capacity')?.value);
  const current = connectedPeerCount() + 1;
  if (next < current) {
    $('capacity-status').textContent = `当前已有 ${current} 人，人数上限不能低于当前人数。`;
    return;
  }
  S.roomCapacity = next;
  localStorage.setItem('sw.roomCapacity', String(next));
  S.signaling?.setMaxMembers(next);
  renderCapacityStatus();
}

async function inviteViaServer() {
  const out = $('inv-out');
  replace(out, make('p', { text: '正在连接信令服务器…' }));

  try {
    if (!S.signaling) {
      S.mode = 'server';
      const room = randomRoomId();
      await connectSignaling(S.settings.signalUrl, room);
      S.roomId = room;
    }

    const code = await encodeCode({
      k: 'room',
      url: S.settings.signalUrl,
      room: S.roomId,
      from: S.peerId,
      name: S.name,
      file: inviteMediaInfo(),
      maxMembers: S.roomCapacity,
    });

    replace(
      out,
      make('textarea', { id: 'inv-code', attrs: { readonly: '', rows: 4 } }),
      make('button', { className: 'primary', id: 'inv-copy', text: '复制邀请码' }),
      make('p', { text: `完整短码共 ${code.length} 字符，可重复使用。房间会一直开着直到你离开。` })
    );
    $('inv-code').value = code;
    $('inv-copy').onclick = () => copyCode(code, $('inv-copy'));
    log(`房间已开：${S.roomId}`, 'good');
  } catch (e) {
    const error = make('p', { text: e.message });
    error.style.color = 'var(--danger)';
    replace(
      out,
      error,
      make('p', {}, [
        '信令服务器没跑起来的话，可以在本机执行 ',
        make('code', { text: 'npm run signal' }),
        '，或者直接用下面的极简模式。',
      ])
    );
  }
}

/**
 * 极简模式邀请。一次只能拉一个人 —— 每个人都要单独走一遍 offer/answer。
 * 而且大家都只连到发起者（星型），彼此之间不互连。
 */
async function inviteViaManual() {
  if (connectedPeerCount() + 1 >= S.roomCapacity) {
    const full = make('p', { text: `房间已满（${S.roomCapacity} 人）。请先调高人数上限。` });
    full.style.color = 'var(--danger)';
    replace('inv-out', full);
    return;
  }
  S.mode = 'manual';
  const out = $('inv-out');
  replace(out, make('p', { text: '正在收集网络候选地址（几秒钟）…' }));

  S.pendingManualPeer?.close();

  const peer = new Peer({
    peerId: `pending-${crypto.randomUUID().replaceAll('-', '').slice(0, 6)}`,
    name: '待加入',
    initiator: true,
    iceServers: iceServers(),
    trickle: false,
  });
  S.pendingManualPeer = peer;

  const offer = await peer.createOffer();
  const code = await encodeCode({
    k: 'offer',
    from: S.peerId,
    name: S.name,
    sdp: offer,
    file: inviteMediaInfo(),
    maxMembers: S.roomCapacity,
  });

  replace(
    out,
    make('textarea', { id: 'inv-code', attrs: { readonly: '', rows: 4 } }),
    make('button', { className: 'primary', id: 'inv-copy', text: '复制邀请码' }),
    make('p', { text: `完整邀请码共 ${code.length} 字符；在对方真正连上前，不会计入成员列表。` }),
    make('p', {}, [make('b', { text: '第 2 步：' }), '对方会给你一段应答码，粘到这里：']),
    make('textarea', {
      id: 'inv-answer',
      attrs: { rows: 3, placeholder: 'NR2-…（兼容 SW2 / SW1）' },
    }),
    make('button', { className: 'ghost', id: 'inv-accept', text: '完成连接' }),
    make('p', { id: 'inv-status' })
  );
  $('inv-code').value = code;
  $('inv-copy').onclick = () => copyCode(code, $('inv-copy'));

  $('inv-accept').onclick = async () => {
    const raw = $('inv-answer').value.trim();
    if (!raw) return;
    let registered = false;
    try {
      const payload = await decodeCode(raw);
      if (payload.k !== 'answer') throw new Error('这不是应答码');

      // 只有拿到真实身份后才登记到 swarm，避免“点分享就多一个待加入用户”的幽灵成员。
      peer.peerId = payload.from;
      peer.name = payload.name || '观众';
      wirePeer(peer);
      S.swarm.addPeer(peer);
      registered = true;
      S.pendingManualPeer = null;
      await peer.acceptAnswer(payload.sdp);
      $('inv-status').textContent = '正在打洞…';
      peer.once('open', () => {
        $('inv-status').textContent = `${peer.name} 已连上 ✓`;
      });
    } catch (e) {
      if (registered) S.swarm.removePeer(peer.peerId);
      $('inv-status').textContent = e.message;
    }
  };
}

/* ------------------------------- 渲染 ------------------------------- */

function stat(label, value) {
  return make('span', {}, [make('b', { text: label }), ` ${value}`]);
}

function kv(label, value) {
  return make('div', { className: 'kv-row' }, [make('span', { text: label }), make('span', { text: value })]);
}

function renderProgress(p) {
  if (!p) return;

  if (S.sourceType === 'link') {
    $('buf-have').style.width = '100%';
    $('buf-safe').style.width = '100%';
    const snap = S.sync?.lastTick;
    const playRatio = snap && S.sync.duration ? Math.min(1, (snap.position || 0) / S.sync.duration) : 0;
    $('buf-head').style.left = `${(playRatio * 100).toFixed(2)}%`;
    replace(
      'buffer-stats',
      stat('来源', '原始视频网站'),
      stat('同步', '播放 / 暂停 / 跳转'),
      stat('缓冲', '由各自的 mpv 管理')
    );
    replace(
      'transfer-stats',
      kv('视频传输', '原网站 → 每位成员'),
      kv('房间消息', 'P2P 加密直连'),
      kv('连接数', S.swarm.peers.size),
      kv('模式', S.mode === 'manual' ? '极简（零服务器）' : '信令服务器')
    );
    return;
  }

  if (!S.manifest) return;

  $('buf-have').style.width = `${(p.ratio * 100).toFixed(2)}%`;
  $('buf-safe').style.width = `${(p.contiguousRatio * 100).toFixed(2)}%`;

  const snap = S.sync?.lastTick;
  const playRatio =
    snap && S.sync.duration ? Math.min(1, (snap.position || 0) / S.sync.duration) : 0;
  $('buf-head').style.left = `${(playRatio * 100).toFixed(2)}%`;

  drawChunkMap();

  replace(
    'buffer-stats',
    stat('已接收', `${(p.ratio * 100).toFixed(1)}%（${p.haveCount}/${p.chunkCount} 片）`),
    stat('可连续播放到', fmtBytes(p.contiguousBytes)),
    stat('在途', `${p.inflight} 片`),
    stat('速度', fmtRate(p.downRate))
  );

  replace(
    'transfer-stats',
    kv('已收', fmtBytes(p.received)),
    kv('已发', fmtBytes(p.sent)),
    kv('下行', fmtRate(p.downRate)),
    kv('连接数', S.swarm.peers.size),
    kv('模式', S.mode === 'manual' ? '极简（零服务器）' : '信令服务器')
  );

  // 播放位置告诉调度器，它据此决定先下哪些片
  if (snap) {
    const byte = S.swarm.scheduler?.positionToByte(snap.position || 0, snap.streamPos) || 0;
    S.swarm.setPlaybackByte(byte);
  }
}

/** 画分片位图。空洞在这里一眼可见 —— 「下了 90% 却播不了」就是这么来的。 */
function drawChunkMap() {
  const cv = $('buf-map');
  const have = S.swarm?.have;
  if (!cv || !have) return;

  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (!w || !h) return;
  if (cv.width !== w) cv.width = w;
  if (cv.height !== h) cv.height = h;

  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(63, 185, 80, 0.28)';

  const n = have.length;
  const scale = w / n;
  let runStart = -1;

  // 连续段合并成一条画，比一片一格快得多（10GB 有 5120 片）
  for (let i = 0; i <= n; i++) {
    const on = i < n && have[i] === 1;
    if (on && runStart === -1) runStart = i;
    else if (!on && runStart !== -1) {
      ctx.fillRect(runStart * scale, 0, Math.max(1, (i - runStart) * scale), h);
      runStart = -1;
    }
  }
}

const ROLE_LABEL = { host: '房主', admin: '管理员', guest: '游客' };

function renderPeers(list) {
  list = list || S.swarm?.peerList() || [];
  list = list.filter((p) => p.state === 'connected' || p.state === 'completed');
  $('peer-count').textContent = list.length;
  renderCapacityStatus();

  if (!list.length) {
    const empty = make('p', { className: 'fine', text: '还没有人加入。用右边的邀请码叫人。' });
    empty.style.padding = '4px';
    replace('peer-list', empty);
    return;
  }

  const iAmHost = S.sync?.myRole() === 'host';
  replace(
    'peer-list',
    list.map((peer) => {
      const stalled = S.sync?.stalledPeers.has(peer.peerId);
      const candidateRole = S.sync?.roleOf(peer.peerId) || 'guest';
      const role = ROLE_LABEL[candidateRole] ? candidateRole : 'guest';
      const roleControl =
        iAmHost && role !== 'host'
          ? make('button', {
              className: 'role-toggle',
              text: role === 'admin' ? '设为游客' : '设为管理员',
              attrs: { 'data-peer': peer.peerId, 'data-next': role === 'admin' ? 'guest' : 'admin' },
            })
          : make('span', { className: `role-badge ${role}`, text: ROLE_LABEL[role] });

      let mediaProgress;
      if (S.sourceType === 'link') {
        mediaProgress = [
          make('div', {
            className: 'peer-sub',
            text: `延迟 ${peer.rtt != null ? `${peer.rtt}ms` : '—'} · P2P 媒体速度 —（各自读取原网站）`,
          }),
        ];
      } else {
        const ratio = Math.max(0, Math.min(1, Number(peer.remoteRatio) || 0));
        const barValue = make('div');
        barValue.style.width = `${(ratio * 100).toFixed(1)}%`;
        mediaProgress = [
          make('div', { className: 'peer-bar' }, [barValue]),
          make('div', {
            className: 'peer-sub',
            text: `持有 ${(ratio * 100).toFixed(0)}% · 延迟 ${
              peer.rtt != null ? `${peer.rtt}ms` : '—'
            } · ↓ ${fmtRate(peer.downRate)} · ↑ ${fmtRate(peer.upRate)}`,
          }),
        ];
      }

      return make('div', { className: 'peer' }, [
        make('div', { className: 'peer-top' }, [
          make('span', { className: `peer-name ${stalled ? 'stalled' : ''}`, text: peer.name }),
          make('span', { className: 'dot connected' }),
        ]),
        make('div', { className: 'peer-role' }, [roleControl]),
        ...mediaProgress,
      ]);
    })
  );
}

// 房主点「设为管理员/游客」—— 事件委托，省得每次重画都重新接线。
$('peer-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.role-toggle');
  if (!btn || S.sync?.myRole() !== 'host') return;
  S.sync.setRole(btn.dataset.peer, btn.dataset.next);
});

/** 更新「我是谁」的身份提示：房主/管理员可控场，游客只能管自己、不能跳转。 */
function renderMyRole() {
  const badge = $('my-role');
  const hint = $('role-hint');
  if (!badge || !S.sync) return;

  const role = S.sync.myRole();
  badge.textContent = ROLE_LABEL[role];
  badge.className = `role-badge ${role}`;

  const canControl = S.sync.canIControl();
  $('buffer').classList.toggle('locked', !canControl);
  if (hint) {
    hint.textContent = canControl
      ? ''
      : '你是游客：播放/暂停只对你自己生效，不影响其他人，也不能拖动进度条。';
    hint.classList.toggle('hidden', canControl);
  }
}

function renderStatus() {
  if (!S.sync) return;
  const st = S.sync.status();
  const banner = $('status-banner');

  const guest = !S.sync.canIControl();

  if (st.stalled) {
    banner.className = 'status-banner waiting';
    banner.textContent = `全员暂停中 —— 在等 ${st.waitingFor.join('、')} 把缓冲攒够`;
  } else if (!st.paused) {
    banner.className = 'status-banner playing';
    banner.textContent = guest ? '播放中（你在独立观看，操作不影响他人）' : '播放中，所有人同步';
  } else {
    banner.className = 'status-banner';
    banner.textContent = S.mpvRunning
      ? '已暂停'
      : S.sourceType === 'link'
      ? '正在解析并连接原始视频…'
      : '正在缓冲片头，马上就好…';
  }

  $('btn-playpause').textContent = st.intendedPaused ? '播放' : '暂停';
  $('time-display').textContent = `${fmtTime(st.position)} / ${fmtTime(st.duration)}`;
}

/* ------------------------------ 播放器事件 ----------------------------- */

window.sw.mpv.onTick((snap) => {
  if (!S.sync || !S.swarm) return;

  if (snap.duration) {
    if (S.swarm.scheduler) S.swarm.setDuration(snap.duration);
    S.sync.setMediaInfo({ duration: snap.duration, size: S.sourceType === 'link' ? 0 : S.manifest?.size });
  }

  S.sync.onMpvTick(snap, {
    contiguousBytes: S.swarm.contiguousBytes,
    complete: S.sourceType === 'link' || S.swarm.complete,
  });

  renderProgress(S.swarm.progress());
  renderStatus();
});

window.sw.mpv.onExit(({ code }) => {
  S.mpvRunning = false;
  $('btn-playpause').disabled = true;
  if (!S.switchingMedia && S.filePath) {
    $('btn-reopen')?.classList.remove('hidden');
    log(`播放器已关闭（code ${code}），可在房间里重新打开`, 'warn');
  }
  renderStatus();
});

window.sw.mpv.onError(({ message }) => log(`mpv 错误：${message}`, 'bad'));

/* ------------------------------- 控件 ------------------------------- */

$('btn-playpause').onclick = () => {
  if (!S.sync) return;
  S.sync.userSetPaused(!S.sync.intendedPaused);
  renderStatus();
};

$('btn-reopen').onclick = launchPlayer;

$('btn-switch-file').onclick = async () => {
  const path = await window.sw.dialog.pickVideo();
  if (path) startHost(path);
};

$('btn-switch-link').onclick = () => startHostLink($('room-video-link').value);
$('room-video-link').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startHostLink(e.currentTarget.value);
});

$('btn-reveal').onclick = () => {
  if (S.filePath) window.sw.store.reveal(S.filePath);
};

$('btn-leave').onclick = async () => {
  S.signaling?.close();
  S.swarm?.destroy();
  await window.sw.mpv.quit().catch(() => {});
  if (S.sessionId) await window.sw.store.close(S.sessionId).catch(() => {});
  location.reload();
};

// 点进度条 seek —— 会同步给所有人。游客不允许跳转。
$('buffer').onclick = (e) => {
  if (!S.sync?.duration || !S.mpvRunning) return;
  if (!S.sync.canIControl()) {
    log('你是游客，不能跳转进度', 'warn');
    return;
  }
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  S.sync.userSeek(ratio * S.sync.duration);
};

/* ------------------------------- 设置 ------------------------------- */

$('btn-settings').onclick = () => {
  openModal({
    title: '设置',
    body: () => {
      const turnPassword = make('input', {
        id: 'set-turn-pass',
        attrs: { type: 'text', placeholder: '密码' },
        props: { value: S.settings.turnPass },
      });
      turnPassword.style.marginTop = '6px';
      return [
        field(
          '你的昵称',
          make('input', { id: 'set-name', attrs: { type: 'text' }, props: { value: S.name } })
        ),
        field(
          '信令服务器',
          make('input', {
            id: 'set-signal',
            attrs: { type: 'text' },
            props: { value: S.settings.signalUrl },
          }),
          hint('只转发连接地址，不接触视频内容。自己跑一个：', make('code', { text: 'npm run signal' }))
        ),
        field(
          '新房间默认人数上限（2–16）',
          make('input', {
            id: 'set-capacity',
            attrs: { type: 'number', min: 2, max: 16 },
            props: { value: String(S.roomCapacity) },
          }),
          hint('进入房间后，房主也可以在邀请区实时调整。')
        ),
        field(
          'STUN 服务器',
          make('input', {
            id: 'set-stun',
            attrs: { type: 'text' },
            props: { value: S.settings.stun },
          }),
          hint('用来发现自己的公网地址，不传数据。')
        ),
        make('div', { className: 'field' }, [
          make('label', { className: 'check' }, [
            make('input', {
              id: 'set-turn-on',
              attrs: { type: 'checkbox' },
              props: { checked: S.settings.turnEnabled },
            }),
            '启用 TURN 中继兜底',
          ]),
          hint(
            '双方都在严格 NAT（CGNAT、卫星网络）后面时，打洞会失败，这时数据要经过中继转发。',
            '中继会看到加密后的流量并产生带宽成本，所以需要你自己提供服务器 —— 我们不代运营。'
          ),
        ]),
        field(
          'TURN 地址',
          make('input', {
            id: 'set-turn-url',
            attrs: { type: 'text', placeholder: 'turn:example.com:3478' },
            props: { value: S.settings.turnUrl },
          })
        ),
        field(
          'TURN 用户名 / 密码',
          make('input', {
            id: 'set-turn-user',
            attrs: { type: 'text', placeholder: '用户名' },
            props: { value: S.settings.turnUser },
          }),
          turnPassword
        ),
      ];
    },
    okText: '保存',
    onOk: () => {
      S.name = $('set-name').value.trim() || S.name;
      S.settings.signalUrl = $('set-signal').value.trim();
      S.roomCapacity = clampCapacity($('set-capacity').value);
      S.settings.stun = $('set-stun').value.trim();
      S.settings.turnEnabled = $('set-turn-on').checked;
      S.settings.turnUrl = $('set-turn-url').value.trim();
      S.settings.turnUser = $('set-turn-user').value.trim();
      S.settings.turnPass = $('set-turn-pass').value.trim();

      localStorage.setItem('sw.name', S.name);
      localStorage.setItem('sw.signalUrl', S.settings.signalUrl);
      localStorage.setItem('sw.roomCapacity', String(S.roomCapacity));
      localStorage.setItem('sw.stun', S.settings.stun);
      localStorage.setItem('sw.turnEnabled', S.settings.turnEnabled ? '1' : '0');
      localStorage.setItem('sw.turnUrl', S.settings.turnUrl);
      localStorage.setItem('sw.turnUser', S.settings.turnUser);
      localStorage.setItem('sw.turnPass', S.settings.turnPass);
      return true;
    },
  });
};

let modalOnOk = null;
let modalOnCancel = null;

function openModal({ title, body, okText = '确定', onOk, onCancel }) {
  $('modal-title').textContent = title;
  const content = typeof body === 'function' ? body() : body;
  replace('modal-body', ...(Array.isArray(content) ? content : [content]));
  $('modal-ok').textContent = okText;
  modalOnOk = onOk;
  modalOnCancel = onCancel;
  $('modal').classList.remove('hidden');
}

function closeModal() {
  $('modal').classList.add('hidden');
  modalOnOk = modalOnCancel = null;
}

$('modal-ok').onclick = async () => {
  const r = modalOnOk ? await modalOnOk() : true;
  if (r !== false) closeModal();
};
$('modal-cancel').onclick = () => {
  modalOnCancel?.();
  closeModal();
};

window.addEventListener('resize', drawChunkMap);
window.addEventListener('beforeunload', () => {
  S.signaling?.close();
  S.swarm?.destroy();
});

window.sw.app.onShutdownRequested(() => {
  S.signaling?.close();
  S.swarm?.destroy();
});

boot();
