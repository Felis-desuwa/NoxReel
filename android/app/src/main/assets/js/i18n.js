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
  // 在线链接的跟随方式
  '完全同步': 'Full sync',
  '手动同步': 'Manual sync',
  '同步到房主': 'Sync to host',
  '自动同步没跟上': 'Auto-sync could not keep up',
  '已同步到房主的进度': 'Synced to the host’s position',
  '完全同步：一直跟房主对齐，差开了自动跳过去。手动同步：只跟房主的播放、暂停和跳转，差开了提示差多少秒，由你点「同步到房主」。':
    'Full sync: stay aligned with the host and jump back automatically when you drift. Manual sync: follow only the host’s play, pause, and seek; when you drift you are told by how many seconds, then tap “Sync to host”.',
  '改成手动同步：缓冲慢了不再把你拽走，和房主差开时提示差多少秒':
    'Switched to manual sync: slow buffering no longer yanks you around, and you are told how far you drift from the host',
  '改成完全同步：一直跟房主对齐，差开了自动跳过去': 'Switched to full sync: you stay aligned with the host and jump back automatically when you drift',

  // 房间链接
  '邀请链接': 'Invite link',
  '加入': 'Join',
  'https://…#j/… 或 noxreel://j/…': 'https://…#j/… or noxreel://j/…',
  '房间链接点开就进，等房主放行即可。一对一邀请会生成一条应答链接，把它发回给房主，对方点开就连上。':
    'A room link takes you straight in once the host lets you in. A one-to-one invite generates an answer link: send it back to the host and the connection starts when they open it.',
  '正在通过公共中继找房主，等房主放行…': 'Looking for the host through public relays; waiting for the host to let you in…',
  '房主已放行，正在和房间里的人打洞…': 'The host let you in; connecting to the people in the room…',
  '这个房间链接不完整，请让房主重新复制一次。': 'This room link is incomplete. Ask the host to copy it again.',
  '找不到房主：他可能已经离开房间，或者换过房间链接。请让房主重新发一条。':
    'Could not find the host: they may have left the room or replaced the room link. Ask the host for a new one.',
  '连不上公共中继（所在网络可能拦了它们）。请让房主改发「一对一邀请」，那个不经过任何第三方。':
    'Could not reach the public relays (your network may block them). Ask the host for a one-to-one invite instead; it involves no third party.',
  '房主那边一直没能和你直连，你已被移出房间。可以请房主改发一对一邀请，或者双方配置 TURN 后再试。':
    'The host could never connect to you directly, so you were removed from the room. Ask the host for a one-to-one invite, or both set up TURN and try again.',
  '房间里正有好几个人在连接，稍后再点一次链接试试。': 'Several people are connecting to the room right now. Open the link again in a moment.',
  '等房主放行超时': 'Timed out waiting for the host to let you in',
  '房主离开了房间': 'The host left the room',
  '同时连着的人太多了，多出来的连接请求已忽略': 'Too many simultaneous connections; the extra connection requests were ignored',
  '收到的播放列表把已有条目的内容换掉了，已忽略': 'Ignored a playlist that replaced the contents of existing items',

  // 连接设置：TURN、隐藏我的 IP、Cloudflare
  '连接设置（TURN 中继、隐藏我的 IP）': 'Connection settings (TURN relay, hide my IP)',
  '双方都在严格 NAT（CGNAT、部分手机热点）后面时，打洞会失败，这时数据要经过中继转发。中继会产生带宽成本，需要你自己提供：自己填服务器，或者用自己的 Cloudflare 账号自动生成。':
    'When both sides are behind strict NAT (CGNAT, some mobile hotspots), hole punching fails and data has to go through a relay. A relay costs bandwidth, so you provide it yourself: enter your own server, or generate credentials from your own Cloudflare account.',
  'TURN 来源': 'TURN source',
  '自己填': 'Enter my own',
  'Cloudflare 自动生成': 'Generate from Cloudflare',
  '启用 TURN 中继兜底': 'Enable TURN relay fallback',
  'TURN 地址': 'TURN address',
  '会自动同时尝试 UDP 和 TCP —— 酒店、公司和校园网经常只放行 TCP。': 'UDP and TCP are both tried automatically — hotel, office, and campus networks often allow only TCP.',
  'TURN 用户名 / 密码': 'TURN username / password',
  '用户名': 'Username',
  '密码': 'Password',
  '在 Cloudflare 后台 Realtime → TURN Server 新建一个 Key，把 Turn Token ID 和 API Token 填进来，点「验证并保存」。API Token 用手机系统的密钥库加密保存，只有 NoxReel 的原生层拿它换 24 小时有效的临时账号，界面上不会再显示。':
    'In the Cloudflare dashboard, create a key under Realtime → TURN Server, enter its Turn Token ID and API Token here, and tap “Verify and save”. The API Token is encrypted with the phone’s system keystore; only NoxReel’s native layer uses it to fetch 24-hour credentials, and it is never shown again.',
  '验证并保存': 'Verify and save',
  '清除': 'Clear',
  'Cloudflare TURN 月用量上限': 'Cloudflare TURN monthly limit',
  '每月最多用': 'Use at most',
  'GB（本机统计）': 'GB per month (counted on this device)',
  '保存上限': 'Save limit',
  '到上限就不再用 Cloudflare TURN（为免扣费），下个月 1 日（UTC）自动恢复；已经连着的不会被断开。这是本机统计，和 Cloudflare 账单可能有出入；建议另外在 Cloudflare 后台建一个 Budget alert 做兜底。':
    'At the limit Cloudflare TURN stops being used (to avoid charges) and comes back on the 1st of next month (UTC); existing connections are not cut. This is counted on this device and may differ from Cloudflare’s bill, so also set up a Budget alert in the Cloudflare dashboard as a backstop.',
  '隐藏我的 IP（只经 TURN 中继连接）': 'Hide my IP (connect only through a TURN relay)',
  '打开后，房间里的人只能看到 TURN 服务器的地址，看不到你的 IP。需要先配好 TURN；TURN 用不了时会连不上，不会退回直连。':
    'With this on, people in the room only see the TURN server’s address, not your IP. Set up TURN first; if TURN is unavailable the connection fails rather than falling back to a direct one.',
  '保存连接设置': 'Save connection settings',
  '连接设置已保存（只影响之后新建的连接）': 'Connection settings saved (they apply to new connections only)',
  '勾了启用 TURN 中继，但地址是空的 —— 这样等于没配。填一个地址，或者把勾去掉。':
    'TURN relay is enabled but the address is empty, which means there is no relay at all. Enter an address, or clear the checkbox.',
  'TURN 中继要填用户名和密码（中继服务器靠它们认人）。没有的话把「启用 TURN 中继」的勾去掉。':
    'A TURN relay needs a username and password (the relay server uses them to authenticate you). If you do not have them, uncheck “Enable TURN relay fallback”.',
  'Cloudflare 凭据还没保存：先点「验证并保存」，或者把这两个框清空。':
    'The Cloudflare credentials are not saved yet: tap “Verify and save” first, or clear both fields.',
  'Cloudflare TURN 每月上限要填 1 到 1000 之间的整数（GB）。': 'The Cloudflare TURN monthly limit must be a whole number from 1 to 1000 (GB).',
  'TURN 中继开着但没填用户名或密码，这次先不走中继、只尝试直连。到连接设置里补全，或者把中继关掉。':
    'The TURN relay is on but has no username or password, so it is skipped this time and only direct connections are tried. Complete it in the connection settings, or turn the relay off.',
  '已打开「隐藏我的 IP」，但还没有可用的 TURN 中继：请在连接设置里配好 TURN，或者先关掉这个开关。':
    '“Hide my IP” is on, but no TURN relay is available: set up TURN in the connection settings, or turn this switch off.',
  '已打开「隐藏我的 IP」，只能经 TURN 中继连接，但一条中继候选都没拿到 —— TURN 地址、用户名密码大概率有一项不对，或者账号已经过期。请检查设置里的 TURN，或者先关掉「隐藏我的 IP」。':
    '“Hide my IP” is on, so only TURN relay connections are allowed, but no relay candidate arrived—the TURN address, username, or password is most likely wrong, or the credentials have expired. Check TURN in the connection settings, or turn “Hide my IP” off.',
  '配了 TURN 中继却没拿到中继候选 —— 地址、端口或用户名密码大概率有一项不对，这时中继等于没配。':
    'A TURN relay is configured but no relay candidate arrived—the address, port, username, or password is almost certainly wrong, which leaves you with no relay at all.',
  '本机一个网络候选地址都没收集到 —— 通常是网络被完全隔离，或者防火墙拦掉了 NoxReel。':
    'No network candidates were gathered at all—usually the network is fully isolated, or a firewall is blocking NoxReel.',
  'STUN 服务器没能告诉本机公网地址，只有局域网候选。除非双方在同一个局域网，否则连不上；请在设置里换一台 STUN 服务器，或检查防火墙有没有放行 UDP。':
    'The STUN server never reported this device’s public address, so only local candidates exist. Unless both sides are on the same LAN this cannot connect; check that the network allows UDP.',
  'Turn Token ID 和 API Token 都要填。': 'Enter both the Turn Token ID and the API Token.',
  '正在向 Cloudflare 验证…': 'Verifying with Cloudflare…',
  '已保存': 'Saved',
  '已清除': 'Cleared',
  '未授权：Cloudflare 不认这组 Turn Token ID 和 API Token': 'Unauthorized: Cloudflare rejected this Turn Token ID and API Token',
  '网络不通：连不上 Cloudflare': 'Network problem: cannot reach Cloudflare',
  'Cloudflare 的回应看不懂': 'Cloudflare sent a response that could not be understood',
  '还没保存 Cloudflare 凭据': 'No Cloudflare credentials saved yet',
  '本机的加密服务不可用，不能安全地保存 API Token': 'This phone’s encryption service is unavailable, so the API Token cannot be stored safely',
  'Turn Token ID 或 API Token 的格式不对': 'The Turn Token ID or API Token is not in the right format',
  '出错了': 'Something went wrong',
  'Cloudflare TURN：还没配置': 'Cloudflare TURN: not set up',
  'Cloudflare TURN：已配置': 'Cloudflare TURN: set up',
  '本月用量已超过上限的 80%，快到上限了。': 'This month’s usage is past 80% of the limit and close to it.',

  // 手机端编辑播放列表（管理员）
  '你是管理员：点一行可以调整；改动由房主那边执行': 'You are a moderator: tap a row to change it; the host’s device applies the change',
  '只有房主和管理员能改列表': 'Only the host and moderators can change the playlist',
  '列表还是空的，在上面加一个在线链接。': 'The playlist is empty. Add a video link above.',
  '粘贴视频页面或直链（http/https）': 'Paste a video page or direct link (http/https)',
  '放完自动接下一部': 'Play the next one automatically',
  '立即播放': 'Play now',
  '跳过这一部': 'Skip this one',
  '上移': 'Move up',
  '下移': 'Move down',
  '移除': 'Remove',
  '再放一次': 'Play again',
  '从已播放中移除': 'Remove from played',
  '只能加 http:// 或 https:// 开头的视频链接': 'Only video links starting with http:// or https:// can be added',
  '链接已加进列表': 'Link added to the playlist',
  '你没有编辑播放列表的权限': 'You do not have permission to edit the playlist',
  '和房主的连接断了': 'The connection to the host is lost',
  '房主没有回应': 'The host did not respond',
  '无效的列表条目': 'Invalid playlist entry',
  '列表里已经有这个链接了': 'This link is already in the playlist',
  '列表里没有这一项': 'That item is not in the playlist',
  '列表里没有目标位置': 'The target position is not in the playlist',
  '已播放区里没有这一项': 'That item is not among the played videos',
  '操作太频繁了，稍后再试': 'Too many changes at once; try again in a moment',
  '不认识的操作': 'Unknown operation',
  '无效的操作': 'Invalid operation',
  '切换正在播放的片子？': 'Switch the video that is playing?',
  '正在放的这部排到下一位。': 'The current video moves to the next position.',
  '移除正在播放的这一部？': 'Remove the video that is playing?',
  '会直接换到下一部。': 'Playback switches straight to the next video.',
  '切换': 'Switch',
  '取消': 'Cancel',
  '确定': 'OK',
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
    /^身份：(.+) · 可以控制播放、编辑列表$/,
    (_all, role) => `Role: ${translate(role, 'en')} · You can control playback and edit the playlist`,
  ],
  // 房间链接、连接设置、Cloudflare TURN、列表编辑里带参数的几句
  [/^加入房间失败：(.*)$/, (_all, detail) => `Could not join the room: ${translate(detail, 'en')}`],
  [/^(.+) 的信令连接断了，但直连还在，传输继续$/, '$1’s signaling connection dropped, but the direct link is still up and the transfer continues'],
  [
    /^这些 TURN 地址认不出来：(.+)。地址要形如 turn:example\.com:3478$/,
    'These TURN addresses could not be understood: $1. An address looks like turn:example.com:3478',
  ],
  [
    /^这些 TURN 地址用的是 53 端口，浏览器会拦下这个端口：(.+)。换一个端口，常见的是 3478 或 443$/,
    'These TURN addresses use port 53, which the browser blocks: $1. Use another port—3478 or 443 are common',
  ],
  [
    /^本月 Cloudflare TURN 用量已到你设的上限（(.+) GB），为免扣费已停用；下个月 1 日自动恢复，或者在连接设置里调高上限(。「隐藏我的 IP」开着，没有中继就不连接。)?$/,
    (_all, gb, relayOnly) =>
      `This month’s Cloudflare TURN usage has reached your limit (${gb} GB) and was turned off to avoid charges; it comes back on the 1st of next month, or raise the limit in the connection settings${
        relayOnly ? '. “Hide my IP” is on, so without a relay no connection is made.' : ''
      }`,
  ],
  [/^Cloudflare TURN：已配置，账号有效至 (\d{1,2}:\d{2})$/, 'Cloudflare TURN: set up, credentials valid until $1'],
  [/^Cloudflare TURN：(.+)$/, (_all, detail) => `Cloudflare TURN: ${translate(detail, 'en')}`],
  [/^Cloudflare TURN 账号没拿到：(.+)$/, (_all, detail) => `Could not get Cloudflare TURN credentials: ${translate(detail, 'en')}`],
  [
    /^Cloudflare TURN 账号没拿到（(.+)），这次先不走中继、只尝试直连$/,
    (_all, detail) => `Could not get Cloudflare TURN credentials (${translate(detail, 'en')}); trying a direct connection only this time`,
  ],
  [/^本月 Cloudflare TURN 用量已超过你设的上限的 80%（([\d.]+) \/ (\d+) GB）$/, 'This month’s Cloudflare TURN usage is past 80% of your limit ($1 / $2 GB)'],
  [/^本月已用 ([\d.]+) GB \/ (\d+) GB$/, 'Used this month: $1 GB / $2 GB'],
  [/^没保存：(.+)$/, (_all, detail) => `Not saved: ${translate(detail, 'en')}`],
  [/^没清除：(.+)$/, (_all, detail) => `Not cleared: ${translate(detail, 'en')}`],
  [/^没保存上限：(.+)$/, (_all, detail) => `Limit not saved: ${translate(detail, 'en')}`],
  [/^Cloudflare TURN 每月上限已设为 (\d+) GB$/, 'Cloudflare TURN monthly limit set to $1 GB'],
  [/^列表没改成：(.*)$/, (_all, detail) => `The playlist was not changed: ${translate(detail, 'en')}`],
  [/^列表最多 (\d+) 项$/, 'The playlist can hold at most $1 items'],
  [/^正在放的这部排到下一位，回头从 (.+) 接着放。$/, 'The current video moves to the next position and resumes from $1 later.'],
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
  // 在线链接和房主差多少秒
  [
    /^你比房主(慢|快) (\d+) 秒$/,
    (_all, dir, n) => `You are ${n} ${n === '1' ? 'second' : 'seconds'} ${dir === '慢' ? 'behind' : 'ahead of'} the host`,
  ],
  [/^和房主差了 ([\d.]+) 秒，自动对齐$/, '$1 seconds off from the host; realigned automatically'],
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
