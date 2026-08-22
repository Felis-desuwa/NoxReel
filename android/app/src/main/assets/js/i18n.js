const STORAGE_KEY = 'sw.language';
const EN = new Map(Object.entries({
  'P2P 同步观影 · 手机作为观众加入（不做房主）': 'P2P synchronized watching · Join as a viewer from your phone',
  '界面语言': 'Interface language',
  '中文（简体）': 'Chinese (Simplified)',
  '你的昵称': 'Display name',
  '比如：小明的手机': 'For example: Alex’s phone',
  '房间安全模式': 'Room security mode',
  '安全模式（默认，完整接收后播放）': 'Safe mode (default; play after full receipt)',
  '可信房间（边下边播，风险较高）': 'Trusted room (progressive playback, higher risk)',
  '房主和成员必须分别选择相同模式才能握手。Android 安全模式会等待完整接收与分片校验；可信房间在片头就绪后提前播放。': 'The host and every member must select the same mode. Android Safe mode waits for full receipt and chunk verification; Trusted room starts when initial data is ready.',
  '信令服务器': 'Signaling server',
  '极简粘贴': 'Manual code exchange',
  '信令服务器地址': 'Signaling server URL',
  'ws://电脑局域网IP:8080': 'ws://computer-lan-ip:8080',
  '房间号（和电脑端填一样的）': 'Room ID (same as on desktop)',
  '比如：movie-night': 'For example: movie-night',
  '加入房间': 'Join room',
  '电脑端启动信令服务器后，把它所在电脑的局域网 IP 填这里（例如 ': 'After starting the signaling server on the desktop, enter that computer’s LAN IP here (for example ',
  '）。手机和电脑要在同一网络，或电脑有公网地址。': '). The phone and computer must share a network unless the computer has a public address.',
  '粘贴房主给你的邀请码': 'Paste the invite code from the host',
  'NR2-...（兼容旧版 SW2 / SW1）': 'NR2-... (also accepts legacy SW2 / SW1)',
  '生成应答码': 'Generate answer code',
  '把这段应答码发回给房主（他粘贴后才连上）': 'Send this answer code back to the host; the connection starts after they paste it',
  '复制应答码': 'Copy answer code',
  '极简模式不需要服务器，但要你俩手动互传一次邀请码/应答码。适合没有信令服务器时用。': 'Manual mode needs no server, but both sides must exchange invite and answer codes.',
  '安全模式': 'Safe mode',
  '可信房间': 'Trusted room',
  '准备就绪。填写信令地址和房间号加入，或用极简粘贴。': 'Ready. Enter a signaling URL and room ID, or use manual code exchange.',
  '请填写信令地址和房间号': 'Enter the signaling URL and room ID',
  '已进入房间，等待房主供片…': 'Joined the room. Waiting for the host…',
  '这不是一个房主邀请码': 'This is not a host invite code',
  '正在生成应答码，收集网络候选中…（几秒）': 'Generating an answer code and collecting network candidates…',
  '应答码已生成，发回给房主': 'Answer code generated. Send it back to the host.',
  '应答码已复制': 'Answer code copied',
  '开始播放': 'Start playback',
  '片头已就绪，开始播放': 'Initial data is ready. Starting playback.',
  '安全模式文件已完整接收并校验，开始播放': 'Safe mode: the file is fully received and verified. Starting playback.',
  '可信房间片头已就绪，开始边接收边播放（风险较高）': 'Trusted room: initial data is ready. Starting progressive playback (higher risk).',
  '全部下载完成': 'Download complete',
  '已忽略非房主发来的换片请求': 'Ignored a media switch request from a non-host member',
  '已忽略非房主发来的视频链接': 'Ignored a video link sent by a non-host member',
  '房主分享的是网页链接，但没有可供 Android 播放的安全直链': 'The host shared a webpage, but no safe Android-compatible stream URL was available',
  '你拒绝了房主发送的视频链接': 'You declined the video link sent by the host',
  'Android 拒绝或无法打开这个播放地址': 'Android rejected or could not open this stream URL',
  '视频直链 · 从原网站播放 · 房间同步中': 'Direct stream · Playing from the source site · Room sync active',
  '游客不能拖动进度': 'Guests cannot seek',
  '你是游客，不能拖动进度': 'Guests cannot seek',
  '等待连接…': 'Waiting for connection…',
  '房主': 'Host',
  '管理员': 'Moderator',
  '游客': 'Guest',
  '邀请码异常过长': 'The invite code is unexpectedly long',
  '这不像是一个 NoxReel 邀请码': 'This does not look like a NoxReel invite code',
  '邀请码损坏或不完整 —— 复制的时候可能漏了一截': 'The invite code is damaged or incomplete—part of it may be missing',
  '邀请码内容无法解析': 'The invite code could not be parsed',
  '信令服务器拒绝了连接': 'The signaling server rejected the connection'
}));

const PATTERNS = [
  [/^观众(\d+)$/, 'Viewer $1'],
  [/^(.+) 加入了房间$/, '$1 joined the room'],
  [/^已和 (.+) 建立数据通道，正在校验房间模式…$/, 'Data channel established with $1; verifying room mode…'],
  [/^已和 (.+) 完成(.+)握手$/, 'Completed $2 handshake with $1'],
  [/^模式不一致：本机是(.+)，对方是(.+)，已在传输媒体前断开。$/, 'Mode mismatch: this device uses $1 and the peer uses $2. Disconnected before media transfer.'],
  [/^已断开身份校验失败的成员：(.*)$/, 'Disconnected member after identity verification failed: $1'],
  [/^开始接收《(.+)》 · (.+)$/, 'Receiving “$1” · $2'],
  [/^房主请求手机连接 (.+) 播放在线视频。是否允许？$/, 'The host wants your phone to connect to $1 for online playback. Allow it?'],
  [/^正在从原网站播放《(.+)》$/, 'Playing “$1” from the source site'],
  [/^(.+) · (安全模式|可信房间|Safe mode|Trusted room) · 在线$/, (_all, title, mode) => `${title} · ${translate(mode, 'en')} · Online`],
  [/^正在连接 (.+) …$/, 'Connecting to $1 …'],
  [/^连接失败：(.*)$/, (_all, detail) => `Connection failed: ${translate(detail, 'en')}`],
  [/^邀请码无效：(.*)$/, (_all, detail) => `Invalid invite code: ${translate(detail, 'en')}`],
  [/^房间使用(.+)，本机设置是(.+)。请切换为相同模式后重试。$/, 'The room uses $1 while this device uses $2. Select the same mode and try again.'],
  [/^房主的片子：(.+) · (.+)$/, 'Host video: $1 · $2'],
  [/^身份：(.+)$/, 'Role: $1'],
  [/^身份：游客 · 播放\/暂停仅对自己生效，不能拖动进度$/, 'Role: Guest · Play/pause only affects you; seeking is disabled'],
  [/^可播 (\d+)% · 已有 (\d+)\/(\d+) 片 · ↓(.+)$/, 'Playable $1% · $2/$3 chunks · ↓$4'],
  [/^(\d+) 人在线$/, '$1 online'],
  [/^⏳ 等待缓冲：(.*)$/, '⏳ Waiting for buffer: $1'],
  [/^信令断开，(\d+) 秒后重连（已建立的直连不受影响）$/, 'Signaling disconnected. Reconnecting in $1 seconds.'],
  [/^信令错误：(.*)$/, 'Signaling error: $1']
];

let locale = (() => {
  try { return globalThis.window?.localStorage?.getItem(STORAGE_KEY) === 'en' ? 'en' : 'zh-CN'; } catch { return 'zh-CN'; }
})();

export const currentLocale = () => locale;
export function setLocale(next) {
  locale = next === 'en' ? 'en' : 'zh-CN';
  try { globalThis.window?.localStorage?.setItem(STORAGE_KEY, locale); } catch {}
  return locale;
}

export function translate(input, targetLocale = locale) {
  if (input == null || targetLocale !== 'en') return input == null ? '' : String(input);
  const value = String(input);
  const match = value.match(/^(\s*)([\s\S]*?)(\s*)$/);
  const [, leading, core, trailing] = match;
  let translated = EN.get(core);
  if (!translated) {
    for (const [pattern, replacement] of PATTERNS) {
      if (pattern.test(core)) { translated = core.replace(pattern, replacement); break; }
    }
  }
  return translated ? `${leading}${translated}${trailing}` : value;
}

function translateTree(root) {
  if (locale !== 'en' || !root) return;
  if (root.nodeType === Node.TEXT_NODE) {
    const next = translate(root.nodeValue);
    if (next !== root.nodeValue) root.nodeValue = next;
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  const apply = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const next = translate(node.nodeValue);
      if (next !== node.nodeValue) node.nodeValue = next;
    } else {
      for (const attr of ['placeholder', 'title', 'aria-label']) {
        if (node.hasAttribute?.(attr)) node.setAttribute(attr, translate(node.getAttribute(attr)));
      }
    }
  };
  if (root.nodeType === Node.ELEMENT_NODE) apply(root);
  let node;
  while ((node = walker.nextNode())) apply(node);
}

export function startI18n() {
  document.documentElement.lang = locale;
  translateTree(document.body);
  if (locale !== 'en') return;
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') translateTree(mutation.target);
      for (const node of mutation.addedNodes) translateTree(node);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}
