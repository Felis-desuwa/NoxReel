const STORAGE_KEY = 'sw.language';
const EN = new Map(Object.entries({
  // 中途加入（可信房间）
  '你是中途加入的，正在下载房间当前位置附近的内容':
    'You joined mid-playback; downloading the part the room is at now.',
  '片源没提供时长，算不出房间播到哪；这一部要完整接收后才能播放':
    "The source did not provide a duration, so the room's position cannot be calculated; this video will play only after it is fully received.",
  'P2P 同步观影 · 手机作为观众加入（不做房主）': 'P2P synchronized watching · Join as a viewer from your phone',
  '界面语言': 'Interface language',
  '中文（简体）': 'Chinese (Simplified)',
  '你的昵称': 'Display name',
  '比如：小明的手机': 'For example: Alex’s phone',
  '房间安全模式': 'Room security mode',
  '安全模式（默认，完整接收后播放）': 'Safe mode (default; play after full receipt)',
  '安全模式（完整接收后播放）': 'Safe mode (play after full receipt)',
  '可信房间（默认，边下边播，风险较高）': 'Trusted room (default; progressive playback, higher risk)',
  '可信房间（边下边播，风险较高）': 'Trusted room (progressive playback, higher risk)',
  '房主和成员必须分别选择相同模式才能握手。Android 安全模式会等待完整接收与分片校验；可信房间在片头就绪后提前播放。': 'The host and every member must select the same mode. Android Safe mode waits for full receipt and chunk verification; Trusted room starts when initial data is ready.',
  '信令服务器': 'Signaling server',
  '极简粘贴': 'Manual code exchange',
  '零服务器链接': 'Serverless link',
  '信令服务器地址': 'Signaling server URL',
  'ws://电脑局域网IP:8080': 'ws://computer-lan-ip:8080',
  '房间号（和电脑端填一样的）': 'Room ID (same as on desktop)',
  '比如：movie-night': 'For example: movie-night',
  '加入房间': 'Join room',
  '电脑端启动信令服务器后，把它所在电脑的局域网 IP 填这里（例如 ': 'After starting the signaling server on the desktop, enter that computer’s LAN IP here (for example ',
  '）。手机和电脑要在同一网络，或电脑有公网地址。': '). The phone and computer must share a network unless the computer has a public address.',
  '粘贴房主给你的邀请码': 'Paste the invite code from the host',
  'NR2-...（兼容旧版 SW2 / SW1）': 'NR2-... (also accepts legacy SW2 / SW1)',
  'noxreel://j/… 或 NR3-…': 'noxreel://j/… or NR3-…',
  '打开或粘贴房主给你的 NoxReel 邀请链接': 'Open or paste the host’s NoxReel invite link',
  '生成应答码': 'Generate answer code',
  '生成应答链接': 'Generate answer link',
  '把这段应答码发回给房主（他粘贴后才连上）': 'Send this answer code back to the host; the connection starts after they paste it',
  '复制应答码': 'Copy answer code',
  '复制应答链接': 'Copy answer link',
  '把应答链接发回给房主（对方点开后即可连接）': 'Send the answer link to the host; they can click it to connect',
  '默认不使用信令服务器。点开邀请链接后，应答链接会自动生成；把它发回房主即可。': 'Signaling is off by default. Open the invite link, then send the generated answer link back to the host.',
  '极简模式不需要服务器，但要你俩手动互传一次邀请码/应答码。适合没有信令服务器时用。': 'Manual mode needs no server, but both sides must exchange invite and answer codes.',
  '安全模式': 'Safe mode',
  '可信房间': 'Trusted room',
  '准备就绪。填写信令地址和房间号加入，或用极简粘贴。': 'Ready. Enter a signaling URL and room ID, or use manual code exchange.',
  '请填写信令地址和房间号': 'Enter the signaling URL and room ID',
  '已进入房间，等待房主供片…': 'Joined the room. Waiting for the host…',
  '这不是一个房主邀请码': 'This is not a host invite code',
  '这是房间链接，目前只有电脑端 NoxReel 能用，手机端下个版本支持。请让房主给你发一条「一对一邀请」。':
    'This is a room link, which only the desktop NoxReel can open for now; phones will get it in the next version. Ask the host for a one-to-one invite.',
  '正在生成应答码，收集网络候选中…（几秒）': 'Generating an answer code and collecting network candidates…',
  '正在生成应答链接，收集网络候选中…（几秒）': 'Generating an answer link and collecting network candidates…',
  '应答码已生成，发回给房主': 'Answer code generated. Send it back to the host.',
  '应答码已复制': 'Answer code copied',
  '应答链接已复制': 'Answer link copied',
  '应答链接已生成，发回给房主后对方点开即可': 'Answer link created. Send it to the host so they can click to connect.',
  '准备就绪。默认使用零服务器邀请链接，也可以切换到信令服务器。': 'Ready. Serverless invite links are the default; signaling remains optional.',
  '开始播放': 'Start playback',
  '片头已就绪，开始播放': 'Initial data is ready. Starting playback.',
  '安全模式文件已完整接收并校验，开始播放': 'Safe mode: the file is fully received and verified. Starting playback.',
  '可信房间片头已就绪，开始边接收边播放（风险较高）': 'Trusted room: initial data is ready. Starting progressive playback (higher risk).',
  '全部下载完成': 'Download complete',
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
  '邀请码损坏或不完整 —— 可能是复制时漏了一截，也可能是被聊天软件的格式化改掉了字符；把码放进反引号里再发一次通常能解决':
    'The invite code is damaged or incomplete. Part of it may be missing, or a chat app\u2019s formatting may have altered some characters \u2014 wrapping the code in backticks before sending usually fixes it.',
  '邀请码内容无法解析': 'The invite code could not be parsed',
  '信令服务器拒绝了连接': 'The signaling server rejected the connection',
  '和房主的直连没建立起来。重新粘一次房主的邀请码生成新的应答链接；双方都在严格 NAT 后面时需要各自配同一个 TURN 中继。':
    'The direct connection to the host was never established. Paste the host’s invite code again to generate a new answer link; when both sides are behind strict NAT, each of you needs the same TURN relay configured.',
  '等了几分钟还是没连上房主。应答链接已经发回去的话多半是打洞没成功，双方都要配同一个 TURN 中继；房主还没打开的话，就重新粘一次邀请码生成新的应答链接。':
    'Still not connected to the host after several minutes. If you already sent the answer link back, the direct connection most likely failed and both sides need the same TURN relay; if the host has not opened it yet, paste the invite code again to generate a new answer link.',
  // 播放列表与协议版本（0.7）
  '已忽略非房主发来的播放列表': 'Ignored a playlist from someone other than the host',
  '播放列表已经放完了': 'The playlist has finished',
  '没有人能提供这部片的清单': 'Nobody can provide the manifest for this video',
  '这个邀请来自旧版 NoxReel（0.6.x），和 0.7 不互通。请让房主升级到 0.7 后重新发邀请。':
    'This invite comes from an older NoxReel (0.6.x), which cannot connect to 0.7. Ask the host to upgrade to 0.7 and send a new invite.',
  '这个邀请来自更新版本的 NoxReel，请先升级手机上的 NoxReel。':
    'This invite comes from a newer NoxReel. Upgrade NoxReel on this phone first.',
  // 播放列表面板（只读）
  '列表': 'List',
  '播放列表': 'Playlist',
  '手机端暂不支持编辑列表': 'Editing the playlist is not supported on phones',
  '列表还是空的，等房主加片。': 'The playlist is empty. Waiting for the host to add a video.',
  '正在播放': 'Now playing',
  '待播': 'Up next',
  '已播放': 'Played',
  // 聊天
  '聊天': 'Chat',
  '还没有消息': 'No messages yet',
  '说点什么…': 'Say something…',
  '聊天输入框': 'Chat input box',
  '发送': 'Send',
  '发送中': 'Sending…',
  '已送达': 'Delivered',
  '你加入前的消息': 'Messages from before you joined',
  // 弹幕与它的本地设置
  '弹幕': 'Danmaku',
  '弹幕设置': 'Danmaku settings',
  '不透明度': 'Opacity',
  '字号': 'Font size',
  '速度': 'Speed',
  '显示区域': 'Display area',
  '上半屏': 'Top half',
  '全屏': 'Full screen',
  '这些设置只影响你自己的画面。': 'These settings only affect your own screen.',
  // 站点授权对话框
  '允许': 'Allow',
  '拒绝': 'Decline',
  '关闭': 'Close',
  // 已在房间里又点开一条邀请
  '你已经在房间里了。要离开当前房间，加入新收到的邀请吗？': 'You are already in a room. Leave it and join the invite you just opened?',
  '留在当前房间': 'Stay in this room',
  '离开并加入': 'Leave and join',
  '已留在当前房间，新收到的邀请没有处理': 'Stayed in the current room; the new invite was not opened',
  '你已经在房间里了。要加入新的房间，请先离开当前房间。': 'You are already in a room. Leave it before joining another one.',
  '上一条邀请还在处理，请稍候再试': 'Still processing the previous invite. Try again in a moment.',
  '邀请链接异常过长，已忽略': 'The invite link is unexpectedly long and was ignored',
  '正在加入房间，请稍候': 'Joining the room, please wait',
  '信令服务器一直没有回应': 'The signaling server never responded',
  '生成应答链接超时': 'Generating the answer link timed out',
  // 原生层核对清单时给出的原因（接在「打开接收会话失败：」「没法接收这一部：」后面）
  '同时打开的接收会话太多': 'Too many receive sessions are open at once',
  '清单里的文件大小不对': 'The manifest has an invalid file size',
  '清单里的分片大小不对': 'The manifest has an invalid chunk size',
  '清单里的分片数和文件大小对不上': 'The manifest chunk count does not match the file size',
  '清单里的分片哈希条数不对': 'The manifest has the wrong number of chunk hashes',
  '清单里的分片哈希格式不对': 'The manifest has malformed chunk hashes',
  '非法的 fileId': 'Invalid file ID',
  '接收缓存路径越界': 'The receive cache path is outside the cache folder',
}));

const PATTERNS = [
  [
    /^(.+) 用的是旧版 NoxReel（0\.6\.x），和 0\.7 不互通，已断开。$/,
    '$1 is using an older NoxReel (0.6.x), which cannot connect to 0.7, and was disconnected.',
  ],
  [/^(.+) 用的是更新版本的 NoxReel，请先升级手机上的 NoxReel。$/, '$1 is using a newer NoxReel. Upgrade NoxReel on this phone first.'],
  [/^还没拿到《(.+)》的清单：(.*)$/, (_all, name, detail) => `Still waiting for the manifest of “${name}”: ${translate(detail, 'en')}`],
  [/^(.+) · (安全模式|可信房间|Safe mode|Trusted room) · 正在获取清单…$/, (_all, name, mode) => `${name} · ${translate(mode, 'en')} · Fetching the manifest…`],
  [/^播放列表是空的 · (安全模式|可信房间|Safe mode|Trusted room)$/, (_all, mode) => `The playlist is empty · ${translate(mode, 'en')}`],
  [
    /^打开接收会话失败：磁盘空间不够：这部片子需要 ([\d.]+)GB，手机只剩 ([\d.]+)GB$/,
    'Could not open the receive session: not enough storage. This video needs $1 GB, but the phone has only $2 GB free',
  ],
  // 其余打不开会话的原因（清单不对、会话太多……）：原因本身另有词条
  [/^打开接收会话失败：(.*)$/, (_all, detail) => `Could not open the receive session: ${translate(detail, 'en')}`],
  [/^生成应答链接失败：(.*)$/, (_all, detail) => `Could not generate the answer link: ${translate(detail, 'en')}`],
  // 状态栏：本机收不下当前这一部（原因多半是下面这条存储不够）
  [/^没法接收这一部：(.*)$/, (_all, detail) => `Cannot receive this video: ${translate(detail, 'en')}`],
  [
    /^磁盘空间不够：这部片子需要 ([\d.]+)GB，手机只剩 ([\d.]+)GB$/,
    'Not enough storage: this video needs $1 GB, but the phone has only $2 GB free',
  ],
  [/^观众(\d+)$/, 'Viewer $1'],
  [/^(.+) 加入了房间$/, '$1 joined the room'],
  [
    /^(.+) 的信令连接断了，但直连还在，传输继续$/,
    '$1 lost the signaling connection, but the direct connection is still up and the transfer continues',
  ],
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
  // 具体的身份说明要排在通配的「身份：X」前面：PATTERNS first-match-wins，排在后面就永远轮不到
  [/^身份：游客 · 播放\/暂停仅对自己生效，不能拖动进度$/, 'Role: Guest · Play/pause only affects you; seeking is disabled'],
  [
    /^身份：(.+) · 可以控制播放，但手机端不能编辑列表$/,
    (_all, role) => `Role: ${translate(role, 'en')} · You can control playback, but the playlist cannot be edited on phones`,
  ],
  // 角色名本身也要翻，'Role: $1' 那种写法会把「房主」原样留在英文界面里
  [/^身份：(.+)$/, (_all, role) => `Role: ${translate(role, 'en')}`],
  // 聊天流里的系统事件：整句翻译，昵称和片名靠捕获原样带过去
  [/^现在放：(.*)$/, 'Now playing: $1'],
  [/^(.+) 离开了房间$/, '$1 left the room'],
  [
    /^(.+) (播放|暂停) @ (.+)$/,
    (_all, name, action, position) => `${name} ${{ 播放: 'played', 暂停: 'paused' }[action]} @ ${position}`,
  ],
  // 限速倒计时是动态的，单复数得跟着变
  [
    /^发得太快了（(\d+) 秒后再试）$/,
    (_all, n) => `Too many messages — try again in ${n} second${n === '1' ? '' : 's'}`,
  ],
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

// 带这个属性的元素连同整棵子树都不参与自动翻译。昵称、片名、聊天这类用户输入必须原样显示，
// 否则昵称叫「播放」的人会被翻成 Play。和桌面端 src/renderer/lib/i18n.js 保持同一套规则。
export const SKIP_ATTR = 'data-i18n-skip';
const SKIP_SELECTOR = `[${SKIP_ATTR}]`;

// 元素看它自己，文本节点看所在的元素；祖先链上任何一层带标记都算跳过。
export function isSkipped(node) {
  if (!node) return false;
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return !!element?.closest?.(SKIP_SELECTOR);
}

// TreeWalker 的过滤器：遇到带标记的元素返回 FILTER_REJECT，整棵子树（含文本节点）都不会被遍历到。
const skipFilter = (node) =>
  node.nodeType === Node.ELEMENT_NODE && node.hasAttribute?.(SKIP_ATTR)
    ? NodeFilter.FILTER_REJECT
    : NodeFilter.FILTER_ACCEPT;

export function translateTree(root) {
  if (locale !== 'en' || !root) return;
  if (root.nodeType === Node.TEXT_NODE) {
    // characterData 变化的目标就是文本节点，靠 parentElement 判断它是否落在被跳过的子树里。
    if (isSkipped(root)) return;
    const next = translate(root.nodeValue);
    if (next !== root.nodeValue) root.nodeValue = next;
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
  // TreeWalker 不会把根交给过滤器，根自己带标记或落在被跳过的子树里时得先挡掉。
  if (root.nodeType === Node.ELEMENT_NODE && isSkipped(root)) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, skipFilter);
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
      // 新增节点和文本改动都经 translateTree，带 data-i18n-skip 的子树在那里统一挡掉。
      if (mutation.type === 'characterData') translateTree(mutation.target);
      for (const node of mutation.addedNodes) translateTree(node);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}
