const STORAGE_KEY = 'sw.language';
const SUPPORTED = new Set(['zh-CN', 'en']);

const EN = new Map(Object.entries({
  '正在检查运行环境…': 'Checking the runtime environment…',
  '设置': 'Settings',
  '你所在的地区不在本软件的设计范围内': 'Your region is outside the environment this app was designed for',
  '知道了': 'Got it',
  '和朋友一起看，本地视频和视频链接都能同步': 'Watch together with friends—local videos and video links stay in sync',
  '分享本地视频时边下边播；粘贴公开视频链接时，每个人从原网站播放，\n            播放、暂停和进度保持同步。': 'Share local videos over P2P, or paste a public video link so everyone streams from the original site. Playback, pause, and position stay synchronized.',
  '发起放映': 'Host a watch party',
  '把 MP4 或 MKV 拖到这里，或者点击选择': 'Drop an MP4 or MKV here, or click to choose',
  '最大 10GB · 只支持你自己合法拥有的内容': 'Up to 10 GB · Only share content you are legally allowed to use',
  '解析视频链接': 'Open a video link',
  '粘贴单个视频页面或 MP4 / HLS 直链': 'Paste one video page, MP4 URL, or HLS URL',
  '解析并发起': 'Open and host',
  '支持范围由 yt-dlp 与原网站决定；不绕过登录、付费或 DRM。': 'Support depends on yt-dlp and the source website; login, paywalls, and DRM are not bypassed.',
  '加入放映': 'Join a watch party',
  '粘贴朋友给你的邀请码': 'Paste the invite code from your friend',
  'NR2-…（兼容旧版 SW2 / SW1）': 'NR2-… (also accepts legacy SW2 / SW1)',
  'noxreel://j/… 或 NR3-…（兼容旧版）': 'noxreel://j/… or NR3-… (legacy formats are also accepted)',
  '加入': 'Join',
  '本软件仅用于观看你自有的合法内容，不提供任何内容搜索或资源索引功能。\n            使用即表示你确认对所分享文件拥有合法权利。': 'This app is only for watching content you are legally allowed to use. It does not provide content search or resource indexing. By using it, you confirm that you have the rights to share the selected files.',
  '软件仅针对北美网络环境设计与测试，其他地区未做适配，P2P 直连可能无法建立。': 'The app is designed and tested for North American networks. P2P connections may not work in other regions.',
  '正在准备文件': 'Preparing the file',
  '播放位置': 'Playback position',
  '可连续播放': 'Continuously playable',
  '已接收（含空洞）': 'Received (including gaps)',
  '播放': 'Play',
  '暂停': 'Pause',
  '重新打开播放器': 'Reopen player',
  '打开源文件位置': 'Open source file location',
  '打开临时缓存位置': 'Open temporary cache location',
  '成员': 'Members',
  '邀请': 'Invite',
  '增加 / 切换视频': 'Add / switch video',
  '选择本地视频': 'Choose a local video',
  '切换到视频链接': 'Switch to a video link',
  '成员保持连接，房主换片后会自动同步到全房。': 'Members stay connected and the new video is synchronized to the room.',
  '传输': 'Transfer',
  '离开房间': 'Leave room',
  '取消': 'Cancel',
  '确定': 'OK',
  '保存': 'Save',
  '返回': 'Back',
  '复制邀请码': 'Copy invite code',
  '复制应答码': 'Copy answer code',
  '复制失败，请手动全选': 'Copy failed—select all and copy manually',
  '拿不到这个文件的路径，请改用点击选择。': 'The file path is unavailable. Use the file picker instead.',
  '依赖就绪': 'Dependencies ready',
  '地区未知': 'Region unknown',
  '本软件仅针对北美网络环境设计，没有对你所在地区做过适配。P2P 直连很可能打洞失败，需要自备 TURN 中继才能用。你可以继续使用，但遇到的连接问题不在支持范围内。': 'This app is designed for North American networks and has not been adapted for your region. Direct P2P connections may fail, and a self-hosted TURN relay may be required. You may continue, but regional connectivity issues are outside the supported environment.',
  '缺少外部依赖': 'Missing external dependencies',
  'NoxReel 不自研播放器、编解码器和网站解析器，靠这些成熟组件干活：': 'NoxReel uses established external components for playback, codecs, and website parsing:',
  'mpv —— 播放器（必需）': 'mpv — player (required)',
  'ffmpeg —— 转封装（按需）': 'ffmpeg — remuxing (when needed)',
  'yt-dlp —— 视频网页解析（按需）': 'yt-dlp — video page parser (when needed)',
  '未找到。装好后重启本软件即可。': 'Not found. Install it and restart the app.',
  '未找到。只有当片子需要转封装时才会用到。': 'Not found. It is only needed when a video must be remuxed.',
  '未找到。MP4/HLS 直链仍可播放，视频网站页面链接不可用。': 'Not found. Direct MP4/HLS links still work, but video page URLs do not.',
  '安装方式（任选其一）': 'Installation options',
  // 注意：键不能带首尾空白 —— translate() 会先把它剥掉再查表，带空格的键永远命中不了。
  // 需要空格的是英文那一侧，所以空格加在值上。
  '或者手动下载后，把可执行文件路径写进环境变量': 'Or download it manually and set the executable path in ',
  '重新检测': 'Check again',
  '检查格式与兼容性': 'Check format and compatibility',
  '转封装（按需）': 'Remux (if needed)',
  '计算分片校验值': 'Calculate chunk hashes',
  '创建房间': 'Create room',
  '这个 MP4 需要转封装才能边下边播，但没找到 ffmpeg。装上 ffmpeg 后重试，或者换一个 MKV 文件。': 'This MP4 must be remuxed for progressive playback, but ffmpeg was not found. Install ffmpeg and try again, or use an MKV file.',
  '正在转封装': 'Remuxing',
  '正在计算分片校验值': 'Calculating chunk hashes',
  '每个分片单独算一次 SHA-256。对方收到一片就能立刻验一片，不用等整个文件下完 —— 这就是「渐进式校验」。': 'Each chunk gets its own SHA-256 hash, so recipients can verify it immediately without waiting for the entire file.',
  '正在解析视频链接': 'Parsing the video link',
  '只读取媒体信息，不下载视频。每位参与者会直接从原始网站播放。': 'Only media metadata is read. Each participant streams directly from the original website.',
  '验证链接': 'Validate link',
  '解析视频信息': 'Parse video information',
  '创建同步房间': 'Create synchronized room',
  '这个文件需要先转封装': 'This file needs to be remuxed first',
  '会做什么': 'What will happen',
  '只重写容器外壳，把索引挪到文件开头。视频和音频数据原样搬运，': 'Only the container is rewritten and its index moved to the beginning. Video and audio data are copied as-is, ',
  '不重新编码': 'without re-encoding',
  '，画质无损，通常几十秒完成。': ', with no quality loss. This usually takes a few seconds.',
  '产物': 'Output',
  '优化传输体积（按需）': 'Optimize transfer size (when needed)',
  '正在无损精简': 'Slimming losslessly',
  '这一场要传哪个版本': 'Which version to share',
  '这一场传哪个版本': 'Version to share',
  '无损精简（推荐）': 'Lossless slim-down (recommended)',
  '仅转封装（保留全部轨道）': 'Remux only (keep every track)',
  '原样传输': 'Share as is',
  '无损精简会做什么': 'What the slim-down does',
  '丢掉': 'Drops',
  '，保留下来的轨': ', and every kept track is ',
  '原样搬运、不重新编码': 'copied over untouched, never re-encoded',
  '，画质音质都不变，几秒到几十秒完成。': ', so picture and sound are unchanged. It finishes in seconds.',
  '预计省下': 'Saves about',
  '预计至少省下': 'Saves at least about',
  '这个文件没有可靠的每轨码率，省下多少估不出来': 'This file has no reliable per-track bitrates, so the saving cannot be estimated.',
  '不会做的事': 'What it will not do',
  '不降码率、不降分辨率。视频码流已经是编码器的输出，再套一层通用压缩是零收益，所以传输过程中不做任何额外压缩。':
    'It never lowers the bitrate or resolution. The video stream is already an encoder’s output, so a general-purpose compressor gains nothing on it; nothing extra is compressed during transfer.',
  '生成一个新文件放进临时缓存，原文件不动，退房时自动清理。':
    'A new file is written to the temporary cache. The original is untouched, and the copy is removed when you leave the room.',
  '按这个方案继续': 'Continue with this plan',
  '距起播还差': 'Left before playback starts',
  '预计还需': 'about',
  '安全模式 · 完整接收后才播，还剩': 'Safe mode · plays only after full receipt; remaining',
  '所需码率': 'Required rate',
  '当前速度追不上这个码率，边下边播会反复卡住；建议房主改用无损精简后的文件':
    'The current speed cannot keep up with this bitrate, so progressive playback will stall repeatedly. Ask the host to share a losslessly slimmed file.',
  '余量很薄，网络一抖就会卡': 'The margin is thin; any network hiccup will stall playback',
  '速度充足，可稳定边下边播': 'Fast enough for steady progressive playback',
  '生成一个新文件，原文件不动。': 'A new temporary file is created; the original remains unchanged.',
  '转封装并继续': 'Remux and continue',
  '没法用这个文件': 'This file cannot be used',
  '这是一个应答码，应该由发起方粘贴，不是你。': 'This is an answer code. It should be pasted by the host, not here.',
  '这是一个应答链接，应该由发起方打开。': 'This is an answer link. The host should open it.',
  '无法识别的邀请码类型。': 'Unrecognized invite code type.',
  '正在建立点对点连接': 'Establishing a peer-to-peer connection',
  '正在收集网络候选地址，通常需要几秒钟…': 'Collecting network candidates. This usually takes a few seconds…',
  '解析邀请码': 'Parse invite code',
  '生成应答码': 'Generate answer code',
  '生成应答链接': 'Generate answer link',
  '等待对方粘贴应答码': 'Wait for the host to paste the answer code',
  '等待房主打开应答链接': 'Wait for the host to open the answer link',
  '把这段应答码发回给发起者': 'Send this answer code back to the host',
  '把应答链接发回给发起者': 'Send the answer link back to the host',
  '应答链接已经自动复制。把它发回给对方，对方点开即可完成连接；不需要再手动复制粘贴长码。零服务器的 WebRTC 仍必须交换一次应答。': 'The answer link was copied automatically. Send it back and the host can click it to finish connecting—no long code needs to be pasted. Serverless WebRTC still requires one answer exchange.',
  'NoxReel 应答链接': 'NoxReel answer link',
  '复制应答链接': 'Copy answer link',
  '还差最后一步：': 'One last step: ',
  '把下面这段发回给对方，他粘贴之后连接才建立。这一来一回是「零服务器」的代价 —— 没有服务器帮你们交换地址，就只能你们自己传。': 'Send the code below to the host. The connection is created after they paste it. Manual exchange is the tradeoff for using no signaling server.',
  '正在连接信令服务器': 'Connecting to the signaling server',
  '连接信令服务器': 'Connect to signaling server',
  '建立点对点连接': 'Establish P2P connection',
  '已进入房间，正在和其他成员打洞…': 'Joined the room. Establishing direct connections with other members…',
  '房主身份与邀请码不一致，已拒绝加入': 'The host identity does not match the invite code. Join request rejected.',
  '未知站点': 'Unknown site',
  '房主请求打开在线视频': 'The host wants to open an online video',
  '继续后，你的电脑会直接连接这个网站并解析视频。只在你信任房主和该站点时继续。': 'Your computer will connect directly to this website and parse the video. Continue only if you trust both the host and the site.',
  '允许并继续': 'Allow and continue',
  '你拒绝了房主发送的视频链接': 'You declined the video link sent by the host',
  '正在本机解析房主的视频链接': 'Parsing the host’s video link locally',
  '视频由你的电脑直接从原网站读取；信令服务器和房主都不会中转内容。': 'Your computer streams directly from the original website; neither the signaling server nor the host relays the media.',
  '验证房主身份': 'Verify host identity',
  '启动播放器': 'Start player',
  '你的缓冲不够，先暂停你自己（不影响他人）': 'Your buffer is low, so only your playback is paused',
  '缓冲不足，暂停你自己…': 'Buffer low—pausing your playback…',
  '你是游客，不能跳转进度': 'Guests cannot seek',
  '游客不能跳转进度': 'Guests cannot seek',
  '忽略了非房主发来的换片请求': 'Ignored a media switch request from a non-host member',
  '文件已全部接收并校验，正在执行本机安全扫描…': 'The file is fully received and verified. Running a local security scan…',
  '安全模式': 'Safe mode',
  '可信房间': 'Trusted room',
  '安全模式 · 扫描后播放': 'Safe mode · Play after scanning',
  '可信房间 · 边下边播': 'Trusted room · Progressive playback',
  '在线视频': 'Online video',
  '视频链接': 'Video link',
  '你是片源': 'You are the source',
  '接收中': 'Receiving',
  '可信房间已达到片头缓冲，正在边接收边播放；完整接收后仍会执行安全扫描。': 'The trusted room has enough initial data. Progressive playback is starting; a full scan will still run after download.',
  '可信房间 · 边下边播风险较高': 'Trusted room · Progressive playback has higher risk',
  '完整文件安全扫描通过；退出房间后会自动删除缓存': 'Full-file security scan passed. The cache will be deleted when you leave.',
  '安全扫描通过，正在打开播放器；退出房间后会自动删除缓存': 'Security scan passed. Opening the player; the cache will be deleted when you leave.',
  '未经本机扫描 · 请自行确认片源': 'Not scanned locally · Verify the source yourself',
  '安全扫描通过 · 缓存退出后自动清理': 'Security scan passed · Cache is cleared on exit',
  '安全扫描未通过': 'Security scan did not pass',
  'mpv 已启动（先暂停着，等所有人就绪）': 'mpv started and is paused while everyone gets ready',
  '没找到 mpv，无法播放。装好 mpv 后点右上角「重新检测」。': 'mpv was not found. Install it, then select “Check again” in the top-right corner.',
  '视频': 'Video',
  '你是通过邀请加入的。要拉更多人进来，让发起者再生成一个邀请码。': 'You joined through an invite. Ask the host to generate another invite for additional members.',
  '当前：可信房间（边下边播，风险较高）。加入者也必须在本机选择可信房间。': 'Current: Trusted room (progressive playback, higher risk). Every member must also select Trusted room locally.',
  '当前：安全模式（默认）。成员完整接收并扫描通过后才播放。': 'Current: Safe mode (default). Members play only after the complete file passes scanning.',
  '当前：安全模式。成员完整接收并扫描通过后才播放。': 'Current: Safe mode. Members play only after the complete file passes scanning.',
  '房间人数上限': 'Room capacity',
  '应用': 'Apply',
  '用信令服务器邀请': 'Invite through signaling server',
  '极简模式（零服务器）': 'Manual mode (no server)',
  '生成零服务器邀请链接': 'Create serverless invite link',
  '改用信令服务器': 'Use signaling server instead',
  '默认使用零服务器直连。双方直接点开邀请／应答链接即可，不再手动粘贴长码；跨网络仍需交换一次应答。': 'Serverless direct connection is the default. Both sides click invite/answer links instead of pasting long codes; one answer exchange is still required across networks.',
  '信令服务器只转发连接地址，不碰视频内容。极简模式连这个都不要，代价是要手动来回粘贴两次。': 'The signaling server only relays connection metadata, never video. Manual mode needs no server but requires a two-way code exchange.',
  '正在连接信令服务器…': 'Connecting to the signaling server…',
  '信令服务器没跑起来的话，可以在本机执行': 'If the signaling server is not running, execute ',
  '，或者直接用下面的极简模式。': ', or use manual mode below.',
  '正在收集网络候选地址（几秒钟）…': 'Collecting network candidates (a few seconds)…',
  '待加入': 'Pending member',
  '第 2 步：': 'Step 2: ',
  '对方会给你一段应答码，粘到这里：': 'Paste the answer code returned by the other member:',
  '对方发回应答链接后直接点开，或粘贴到这里：': 'Open the returned answer link, or paste it here:',
  'NoxReel 一键加入链接': 'NoxReel one-click join link',
  '复制邀请链接': 'Copy invite link',
  '完成连接': 'Complete connection',
  '这不是应答码': 'This is not an answer code',
  '正在打洞并校验房间模式…': 'Establishing the direct connection and verifying room mode…',
  '链接里带着这台电脑当前的网络地址，放久了会失效 —— 尽量在几分钟内让对方点开。过期了重新生成一条即可。':
    'The link carries this computer’s current network addresses and goes stale over time—try to have the other side open it within a few minutes. Just generate a new one if it expires.',
  '这条邀请已经用过或已失效，请用当前这条邀请链接重新走一遍。':
    'That invite was already used or has expired. Start again with the current invite link.',
  '打洞一直没成功：对方可能在严格 NAT 后面，也可能是邀请链接放太久、里面的网络地址已经过期。已经给你备好一条新的邀请链接，重发一次试试；还是不行就在设置里配一个 TURN 中继。':
    'The direct connection never came up: the other side may be behind a strict NAT, or the invite link sat too long and its network addresses expired. A fresh invite link is ready—send it again; if it still fails, configure a TURN relay in Settings.',
  '直连没建立起来。已经给你备好一条新的邀请链接，重发一次试试；双方都在严格 NAT 后面时需要在设置里配 TURN 中继。':
    'The direct connection failed. A fresh invite link is ready—send it again; when both sides are behind strict NAT you need a TURN relay configured in Settings.',
  '连接在握手完成前就断了。已经给你备好一条新的邀请链接，重发一次试试。':
    'The connection dropped before the handshake finished. A fresh invite link is ready—send it again.',
  '直连没建立起来': 'The direct connection failed',
  '和房主的直连探测失败了：可能是房主那边的邀请链接放太久、网络地址已经过期，也可能双方都在严格 NAT 后面。重新生成一条应答链接发回给房主再试一次；还是不行就双方在设置里配同一个 TURN 中继。':
    'Connectivity checks with the host failed: the host’s invite link may have sat too long and its network addresses expired, or both sides are behind strict NAT. Generate a new answer link, send it back to the host, and try again; if it still fails, both sides should configure the same TURN relay in Settings.',
  '重新生成应答链接': 'Generate a new answer link',
  '还没能连上房主': 'Still not connected to the host',
  '等了几分钟还是没连上。如果你已经把应答链接发回给房主了，那多半是打洞没成功：双方都在严格 NAT 后面时，需要各自在设置里配同一个 TURN 中继。如果房主还没打开你的应答链接，就重新生成一条再发一次 —— 链接放太久，里面的网络地址会过期。':
    'Still no connection after several minutes. If you already sent the answer link back to the host, the direct connection most likely failed: when both sides are behind strict NAT, each of you needs the same TURN relay configured in Settings. If the host has not opened your answer link yet, generate a new one and send it again—links that sit too long have expired network addresses inside.',
  '来源': 'Source',
  '原始视频网站': 'Original video website',
  '同步': 'Sync',
  '播放 / 暂停 / 跳转': 'Play / Pause / Seek',
  '缓冲': 'Buffer',
  '由各自的 mpv 管理': 'Managed by each member’s mpv',
  '视频传输': 'Video transfer',
  '原网站 → 每位成员': 'Original site → each member',
  '房间消息': 'Room messages',
  'P2P 加密直连': 'Encrypted P2P connection',
  '连接数': 'Connections',
  '模式': 'Mode',
  '极简（零服务器）': 'Manual (no server)',
  '信令服务器': 'Signaling server',
  '已接收': 'Received',
  '可连续播放到': 'Playable through',
  '在途': 'In flight',
  '速度': 'Speed',
  '已收': 'Received',
  '已发': 'Sent',
  '下行': 'Download',
  '房主': 'Host',
  '管理员': 'Moderator',
  '游客': 'Guest',
  '还没有人加入。用右边的邀请码叫人。': 'No one has joined yet. Use the invite panel to add members.',
  '设为游客': 'Make guest',
  '设为管理员': 'Make moderator',
  '你是游客：播放/暂停只对你自己生效，不影响其他人，也不能拖动进度条。': 'You are a guest: play/pause only affects you, and seeking is disabled.',
  '播放中（你在独立观看，操作不影响他人）': 'Playing independently; your controls do not affect others',
  '播放中，所有人同步': 'Playing in sync',
  '已暂停': 'Paused',
  '正在解析并连接原始视频…': 'Resolving and connecting to the original video…',
  '文件已接收，正在进行安全扫描…': 'File received. Running a security scan…',
  '文件已完整接收，但本机扫描器不可用 —— 这份文件没有经过扫描':
    'The file is fully received, but no local scanner is available — it has not been scanned.',
  'Microsoft Defender —— 安全模式的扫描器': 'Microsoft Defender — the scanner Safe mode relies on',
  '装着但没在运行，多半是被第三方杀毒软件接管了。安全模式下收到的文件会因此一律拒播；可以重新启用 Defender，或改用可信房间（风险自负）。':
    'Installed but not running, most likely because third-party antivirus software took over. Safe mode will refuse every received file; re-enable Defender, or switch to a Trusted room at your own risk.',
  '未找到。安全模式需要它才能放行收到的文件；可信房间不受影响。':
    'Not found. Safe mode needs it before a received file can play; Trusted rooms are unaffected.',
  '安全扫描未通过，已阻止播放并清理缓存': 'Security scan did not pass. Playback was blocked and the cache was cleared.',
  '可信房间：正在接收片头，达到约 8 MB 后将边下边播…': 'Trusted room: receiving initial data; progressive playback starts at about 8 MB…',
  '正在完整接收并校验媒体，完成后会进行安全扫描…': 'Receiving and verifying the full media file. A security scan will run when complete…',
  '房间安全模式': 'Room security mode',
  '安全模式（默认）': 'Safe mode (default)',
  '安全模式（完整接收后播放）': 'Safe mode (play after full receipt)',
  '可信房间（默认，边下边播）': 'Trusted room (default, progressive playback)',
  '请先退出当前房间，再打开新的邀请链接。': 'Leave the current room before opening another invite link.',
  '当前没有等待应答的零服务器邀请': 'There is no serverless invite currently waiting for an answer.',
  'NoxReel 邀请链接不完整': 'Incomplete NoxReel invite link',
  '网站拒绝了自动解析，隔离浏览器也没有捕获到可播放媒体': 'The website rejected automatic parsing, and the isolated browser did not detect playable media',
  '可信房间（边下边播，风险较高）': 'Trusted room (progressive playback, higher risk)',
  '房间进行中不能切换。退出后可更改。': 'The mode cannot be changed during a room. Leave the room first.',
  '房主和每位加入者必须分别选择相同模式才能握手。安全模式完整接收并扫描后播放；可信房间约 8 MB 片头就绪后边下边播。': 'The host and every member must select the same mode. Safe mode plays after full receipt and scanning; Trusted room starts progressive playback after about 8 MB.',
  '你的昵称': 'Display name',
  '界面语言': 'Interface language',
  '中文（简体）': 'Chinese (Simplified)',
  '切换语言会重新载入首页；房间进行中不可切换。': 'Changing language reloads the home screen and is unavailable during a room.',
  '只转发连接地址，不接触视频内容。自己跑一个：': 'Relays connection metadata only, never video. Run your own:',
  '新房间默认人数上限（2–16）': 'Default room capacity (2–16)',
  '进入房间后，房主也可以在邀请区实时调整。': 'The host can also adjust this from the invite panel after joining.',
  'STUN 服务器': 'STUN server',
  '用来发现自己的公网地址，不传数据。': 'Discovers your public address; it does not relay media.',
  '启用 TURN 中继兜底': 'Enable TURN relay fallback',
  '双方都在严格 NAT（CGNAT、卫星网络）后面时，打洞会失败，这时数据要经过中继转发。': 'When both sides are behind strict NAT, CGNAT, or satellite networks, direct connection may fail and TURN must relay traffic.',
  '中继会看到加密后的流量并产生带宽成本，所以需要你自己提供服务器 —— 我们不代运营。': 'The relay sees encrypted traffic and incurs bandwidth cost, so you must provide your own server.',
  'TURN 地址': 'TURN URL',
  'TURN 用户名 / 密码': 'TURN username / password',
  '用户名': 'Username',
  '密码': 'Password',
  '邀请码异常过长': 'The invite code is unexpectedly long',
  '这不像是一个 NoxReel 邀请码': 'This does not look like a NoxReel invite code',
  '邀请码损坏或不完整 —— 可能是复制时漏了一截，也可能是被聊天软件的格式化改掉了字符；把码放进反引号里再发一次通常能解决':
    'The invite code is damaged or incomplete. Part of it may be missing, or a chat app\u2019s formatting may have altered some characters \u2014 wrapping the code in backticks before sending usually fixes it.',
  '邀请码内容无法解析': 'The invite code could not be parsed',
  '信令服务器拒绝了连接': 'The signaling server rejected the connection',
  '数据通道未打开': 'The data channel is not open',
  '发送途中数据通道关闭': 'The data channel closed while sending',
  '数据通道已关闭': 'The data channel is closed',
  '请输入完整的视频链接，例如 https://example.com/video': 'Enter a complete video URL, such as https://example.com/video',
  '只支持 http:// 或 https:// 视频链接': 'Only http:// or https:// video URLs are supported',
  '链接中不能包含用户名或密码': 'The URL cannot contain a username or password',
  '解析视频链接超时，请检查网络或换一个链接重试': 'Video URL parsing timed out. Check your network or try another URL.',
  '链接返回的媒体信息过大，可能是播放列表而不是单个视频': 'The media response is too large and may be a playlist rather than a single video',
  '视频链接解析器返回了无法识别的数据': 'The video link parser returned unrecognized data',
  '当前只支持单个视频链接，不支持播放列表或频道页面': 'Only individual video URLs are supported; playlists and channel pages are not',
  '未找到可用的 Microsoft Defender 扫描器': 'No usable Microsoft Defender scanner was found',
  '安全扫描发现威胁': 'The security scan found a threat',
  'Microsoft Defender 没能完成扫描，本机可能已把它关闭或交给第三方杀毒软件接管':
    'Microsoft Defender could not finish the scan. It may be turned off on this computer, or handed over to third-party antivirus software.',
  '安全扫描超时': 'The security scan timed out',
  '接收文件尚未完整校验': 'The received file has not been fully verified',
  '不是一个文件': 'The selected path is not a file',
  '文件是空的': 'The file is empty',
  '文件在计算校验值期间发生了变化，请重新选择': 'The file changed while hashes were being calculated. Select it again.',
  '会话正在关闭': 'The session is closing',
  '不能向只读片源写入分片': 'Cannot write chunks to a read-only source',
  '只支持 MP4／MOV 和 MKV': 'Only MP4/MOV and MKV are supported',
  'MKV 是流式容器，可直接边下边播': 'MKV is streamable and supports progressive playback',
  '媒体文件头过短': 'The media header is too short',
  '检测到 Windows 可执行文件头': 'A Windows executable header was detected',
  '文件内容不是有效的 MKV 容器': 'The file is not a valid MKV container',
  '文件内容不是有效的 MP4/MOV 容器': 'The file is not a valid MP4/MOV container',
  '不支持的媒体格式': 'Unsupported media format',
  '已拒绝不受信任页面的请求': 'Rejected a request from an untrusted page',
  '选择的路径不是文件': 'The selected path is not a file',
  '文件未经用户选择，已拒绝访问': 'File access was rejected because the file was not selected by the user',
  '拒绝扫描不属于当前会话的文件': 'Refused to scan a file outside the current session',
  'mpv 未启动': 'mpv is not running',
  'mpv 已退出': 'mpv has exited',
  'mpv 在建立 IPC 连接前就退出了': 'mpv exited before the IPC connection was established',
  'mpv IPC 连接已关闭': 'The mpv IPC connection is closed',
  'mpv 未连接': 'mpv is not connected',
  '合并写入没有取得进展': 'The merged write made no progress',
  '分片内存缓冲已达到上限': 'The in-memory chunk buffer reached its limit',
  '临时片源不属于当前运行实例': 'The temporary source does not belong to this app instance',
  '缓存目录尚未初始化': 'The cache directory has not been initialized',
  '拒绝删除缓存根目录之外的路径': 'Refused to delete a path outside the cache root',

  // —— 连接层：STUN 冗余、TURN 展开、候选诊断 ——
  '留一条地址时会自动再挂两台备用服务器兜底；想自己管这个列表就用逗号或空格分隔多写几条，那样只用你写的。':
    'With a single address, two backup servers are added automatically. Enter several addresses separated by commas or spaces to manage the list yourself—then only yours are used.',
  '会自动同时尝试 UDP 和 TCP —— 酒店、公司和校园网经常只放行 TCP。':
    'UDP and TCP are both tried automatically—hotel, corporate, and campus networks often allow only TCP.',
  '本机一个网络候选地址都没收集到 —— 通常是网络被完全隔离，或者防火墙拦掉了 NoxReel。':
    'No network candidates were gathered at all—usually the network is fully isolated, or a firewall is blocking NoxReel.',
  'STUN 服务器没能告诉本机公网地址，只有局域网候选。除非双方在同一个局域网，否则连不上；请在设置里换一台 STUN 服务器，或检查防火墙有没有放行 UDP。':
    'The STUN server never reported this machine\u2019s public address, so only local candidates exist. Unless both sides are on the same LAN this cannot connect: choose a different STUN server in Settings, or check that the firewall allows UDP.',
  '配了 TURN 中继却没拿到中继候选 —— 地址、端口或用户名密码大概率有一项不对，这时中继等于没配。':
    'A TURN relay is configured but no relay candidate arrived—the address, port, username, or password is almost certainly wrong, which leaves you with no relay at all.',
  '拿到了公网地址，但没有中继兜底。双方都在严格 NAT（对称 NAT、CGNAT、部分手机热点）后面时会连不上，配一个 TURN 中继可以解决。':
    'A public address was found, but there is no relay fallback. Connections fail when both sides are behind strict NAT (symmetric NAT, CGNAT, some phone hotspots); configuring a TURN relay solves that.',
  '公网地址和中继候选都齐了。': 'Both a public address and a relay candidate are available.',

  // —— 无损精简：选音轨与 PCM 转 FLAC ——
  '其余音轨会被丢掉。这一步不可逆，选错了得重新准备一次文件。':
    'Every other audio track is dropped. This cannot be undone—picking the wrong one means preparing the file again.',
  '还会把这条音轨压一遍（无损）': 'This audio track also gets compressed (losslessly)',
  '这条轨是': 'This track is ',
  '未压缩的 PCM': 'uncompressed PCM',
  '，转成 FLAC 是数学无损的 —— 解码出来的采样逐字节相同。已经拿这个文件实测过：能压掉':
    ', and converting it to FLAC is mathematically lossless—the decoded samples are byte-for-byte identical. Measured on this very file: it shrinks by ',
  '这一步要重新编码音频，比单纯丢轨慢，长片可能要几分钟。':
    'This step re-encodes the audio, so it is slower than simply dropping tracks—a long film can take a few minutes.',
  '正在把未压缩的 PCM 音轨转成 FLAC（无损）。这一步要重新编码音频，长片可能要几分钟。':
    'Converting the uncompressed PCM audio track to FLAC (lossless). This re-encodes the audio, so a long film can take a few minutes.'
}));

const trimEnd = (text) => String(text).replace(/[.。]+$/, '');

const EN_PATTERNS = [
  [/^观众-(\d+)$/, 'Viewer-$1'],
  [/^已复制完整 (\d+) 字符 ✓$/, 'Copied all $1 characters ✓'],
  [/^复制邀请码失败：(.*)$/, (_all, detail) => `Failed to copy invite code: ${translate(detail, 'en')}`],
  [/^地区 (.+)$/, 'Region $1'],
  [/^缺少 (.+)$/, 'Missing $1'],
  [/^已找到：$/, 'Found:'],
  [/^已转封装到：(.*)$/, 'Remuxed to: $1'],
  // 带体积对比的那条必须排在上面 —— 下面那条的 (.*) 是贪婪的，会把「，体积…」也吞进路径里。
  [/^已精简到：(.*)，体积 (.*) → (.*)$/, 'Slimmed to: $1 — size $2 → $3'],
  [/^已精简到：(.*)$/, 'Slimmed to: $1'],
  [/^保留哪条音轨（共 (\d+) 条）$/, (_all, n) => `Which audio track to keep (${n} available)`],
  [/^，约 (.+)。$/, ', about $1.'],
  [/^你$/, 'you'],
  [
    /^和 (.+) 的直连断了，(\d+) 秒后自动重连（第 (\d+) 次）$/,
    'Lost the direct connection to $1. Reconnecting automatically in $2 seconds (attempt $3).',
  ],
  [
    /^和 (.+) 的直连试了 (\d+) 次都没恢复。(.*)$/,
    (_all, name, tries, advice) =>
      `The direct connection to ${name} did not recover after ${tries} attempts. ${translate(advice, 'en')}`,
  ],
  [/^重连 (.+) 失败：(.*)$/, (_all, name, detail) => `Failed to reconnect to ${name}: ${translate(detail, 'en')}`],
  [/^信令还没恢复，暂时没法重连 (.+)$/, 'Signaling has not recovered yet, so $1 cannot be reconnected for now'],
  [/^(\d+) 条多余音轨$/, (_all, n) => `${n} extra audio track${n === '1' ? '' : 's'}`],
  [/^(\d+) 条图形字幕$/, (_all, n) => `${n} image-based subtitle track${n === '1' ? '' : 's'}`],
  [/^已切换到：(.*)$/, 'Switched to: $1'],
  [/^已切换到链接：(.*)$/, 'Switched to link: $1'],
  [/^(.*)\n\n如果对方没有部署信令服务器，让他改用「极简模式」生成邀请码 —— 那个不需要服务器。$/, '$1\n\nIf the other person has no signaling server, ask them to use Manual mode, which requires no server.'],
  [/^房间使用(.+)，你的本机设置是(.+)。请先在设置中切换为相同模式，再重新粘贴邀请码。$/, 'The room uses $1, while your local setting is $2. Select the same mode in Settings, then paste the invite code again.'],
  [/^(.+) 加入了房间$/, '$1 joined the room'],
  [/^房间人数上限已设为 (\d+)$/, 'Room capacity set to $1'],
  [/^信令断开，(\d+) 秒后重连（已建立的直连不受影响）$/, 'Signaling disconnected. Reconnecting in $1 seconds; existing direct connections are unaffected.'],
  [/^信令错误：(.*)$/, (_all, detail) => `Signaling error: ${translate(detail, 'en')}`],
  [/^已和 (.+) 建立数据通道，正在校验房间模式…$/, 'Data channel established with $1; verifying room mode…'],
  [
    /^和 (.+) 的直连失败了。(.*)$/,
    (_all, name, advice) => `Direct connection to ${name} failed. ${translate(advice, 'en')}`,
  ],
  [/^(.+) 断开了$/, '$1 disconnected'],
  [
    /^(.+) 的信令连接断了，但直连还在，传输继续$/,
    '$1 lost the signaling connection, but the direct connection is still up and the transfer continues',
  ],
  [/^来源：(.*)$/, 'Source: $1'],
  [/^这个视频链接在你的电脑上无法解析：(.*)$/, (_all, detail) => `This video link could not be parsed on your computer: ${translate(detail, 'en')}`],
  [/^本机解析失败，改用房主提供的临时播放地址：(.*)$/, (_all, detail) => `Local parsing failed; using the host's temporary stream URL: ${translate(detail, 'en')}`],
  [/^已和 (.+) 完成(.+)握手$/, 'Completed $2 handshake with $1'],
  [/^(.+)的缓冲跟不上了，全员暂停等待$/, '$1 is buffering; pausing everyone'],
  [/^等待 (.+) 缓冲…$/, 'Waiting for $1 to buffer…'],
  [/^你缓冲够了$/, 'Your buffer has recovered'],
  [/^(.+)缓冲够了$/, '$1 has enough buffer'],
  [/^(.+) (播放|暂停|跳转) @ (.+)$/, (_all, name, action, position) => `${name} ${{ 播放: 'played', 暂停: 'paused', 跳转: 'seeked' }[action]} @ ${position}`],
  [/^已拒绝不安全的媒体清单：(.*)$/, (_all, detail) => `Rejected an unsafe media manifest: ${translate(detail, 'en')}`],
  [/^开始接收：(.*)（(.*)，(\d+) 片）$/, 'Receiving: $1 ($2, $3 chunks)'],
  [/^(.+) 手里是另一个文件，已忽略他的分片$/, '$1 has a different file; their chunks were ignored'],
  [/^分片 (\d+) 校验未通过（(.*)），已丢弃重下$/, 'Chunk $1 failed verification ($2) and will be downloaded again'],
  [/^已断开身份校验失败的成员：(.*)$/, 'Disconnected member after identity verification failed: $1'],
  [/^(.+) 的模式是(.+)，本房间是(.+)，已在传输媒体前断开。$/, '$1 uses $2 while this room uses $3. Disconnected before media transfer.'],
  [/^已阻止打开接收文件：(.*)$/, (_all, detail) => `Blocked the received file: ${translate(detail, 'en')}`],
  [/^启动 mpv 失败：(.*)$/, (_all, detail) => `Failed to start mpv: ${translate(detail, 'en')}`],
  [/^当前 (\d+) \/ (\d+) 人（包含房主）$/, '$1 / $2 people, including the host'],
  [/^当前已有 (\d+) 人，人数上限不能低于当前人数。$/, 'There are already $1 people; capacity cannot be lower than the current count.'],
  [/^完整短码共 (\d+) 字符，可重复使用。房间会一直开着直到你离开。$/, 'Complete code: $1 characters. It can be reused while the room remains open.'],
  [/^房间已开：(.*)$/, 'Room opened: $1'],
  [/^房间已满（(\d+) 人）。请先调高人数上限。$/, 'The room is full ($1 people). Increase the capacity first.'],
  [/^完整邀请码共 (\d+) 字符；在对方真正连上前，不会计入成员列表。$/, 'Complete invite code: $1 characters. The member is not counted until the connection succeeds.'],
  [/^已生成可点击的邀请链接；压缩握手数据 (\d+) 字符。在对方真正连上前，不会计入成员列表。$/, 'Clickable invite created; compressed handshake data: $1 characters. The member is not counted until connected.'],
  [/^对方选择的是(.+)，本房间是(.+)。双方需分别选择相同模式。$/, 'The other member selected $1 while this room uses $2. Both sides must select the same mode.'],
  [/^(.+) 已连上 ✓$/, '$1 connected ✓'],
  [/^视频链接 · (.+) · (安全模式 · 扫描后播放|可信房间 · 边下边播|Safe mode · Play after scanning|Trusted room · Progressive playback) · 每位成员从原网站播放$/, 'Video link · $1 · $2 · Each member streams from the original site'],
  [/^(.+) · (\d+) 片 × (.+) · (安全模式 · 扫描后播放|可信房间 · 边下边播|Safe mode · Play after scanning|Trusted room · Progressive playback) · (你是片源|接收中)$/, (_all, size, chunks, chunkSize, mode, state) => `${size} · ${chunks} chunks × ${chunkSize} · ${mode} · ${state === '你是片源' ? 'You are the source' : 'Receiving'}`],
  [/^(\d+(?:\.\d+)?)%（(\d+)\/(\d+) 片）$/, '$1% ($2/$3 chunks)'],
  [/^(\d+) 片$/, '$1 chunks'],
  [/^持有 (\d+)% · 延迟 (.+) · ↓(.+) ↑(.+)$/, 'Has $1% · Latency $2 · ↓$3 ↑$4'],
  [/^延迟 (.+) · P2P 媒体速度 —（各自读取原网站）$/, 'Latency $1 · P2P media rate — (each member streams from source)'],
  [/^全员暂停中 —— 在等 (.+) 把缓冲攒够$/, 'Paused for everyone — waiting for $1 to buffer'],
  [/^播放器已关闭（code (.+)），可在房间里重新打开$/, 'Player closed (code $1). You can reopen it from the room.'],
  [/^mpv 错误：(.*)$/, (_all, detail) => `mpv error: ${translate(detail, 'en')}`],
  [/^信令地址无效：(.*)$/, 'Invalid signaling URL: $1'],
  [/^连不上信令服务器：(.*)$/, 'Cannot connect to signaling server: $1'],
  [/^无法解析这个视频链接(?:：(.*))?$/, 'Unable to parse this video URL$1'],
  [/^只支持 MP4／MOV 和 MKV，当前是 (.+)$/, 'Only MP4/MOV and MKV are supported; current type: $1'],
  [/^(.+) 索引已在文件头，可直接边下边播$/, '$1 index is at the beginning and supports progressive playback'],
  [/^(.+) 的 moov 索引在文件末尾，顺序下载时要等整个文件下完才能起播。转封装把索引挪到开头即可，无损且不重编码。$/, '$1 has its moov index at the end, so sequential download cannot start early. Remuxing moves it to the beginning without re-encoding or quality loss.'],
  [/^没找到 ffmpeg。请安装后重试（(.*)），或设置环境变量 (.*)$/, 'ffmpeg was not found. Install it ($1) or set $2.'],
  [/^没找到 mpv。请安装后重试（(.*)），或设置环境变量 (.*)$/, 'mpv was not found. Install it ($1) or set $2.'],
  [/^没找到 yt-dlp，无法解析视频网页。请重新安装完整版本，或设置 (.*)。$/, 'yt-dlp was not found, so video pages cannot be parsed. Reinstall the full build or set $1.'],
  [/^文件超过 10GB 上限（当前 (.+)GB）$/, 'File exceeds the 10 GB limit (current size: $1 GB)'],
  [/^安全扫描失败（代码 (.+)）$/, 'Security scan failed (code $1)'],
  [
    /^(.*)。可信房间不因此中断播放，但这份文件始终没有经过本机扫描 —— 请自行确认片源可信。$/,
    (_all, detail) =>
      `${trimEnd(translate(detail, 'en'))}. The trusted room keeps playing, but this file was never scanned on your computer — make sure you trust the source.`,
  ],
  [
    /^(.*)。安全模式必须扫过才放行；你可以启用 Microsoft Defender，或改用可信房间（风险自负）。$/,
    (_all, detail) =>
      `${trimEnd(translate(detail, 'en'))}. Safe mode plays a file only after it is scanned; enable Microsoft Defender, or switch to a Trusted room at your own risk.`,
  ],
  [/^连接 mpv IPC 超时：(.*)$/, 'Timed out connecting to mpv IPC: $1'],
  [/^mpv 命令超时：(.*)$/, 'mpv command timed out: $1'],
  [/^读取分片 (\d+) 失败：期望 (\d+) 字节，实际 (\d+)$/, 'Failed to read chunk $1: expected $2 bytes, got $3'],
  [/^会话不存在：(.*)$/, 'Session does not exist: $1'],
  [/^分片下标越界：(.*)$/, 'Chunk index out of range: $1'],
  [/^本地没有分片 (.*)$/, 'Chunk $1 is not available locally'],
  [/^读取分片 (.*) 短读$/, 'Short read while reading chunk $1']
];

let locale = readStoredLocale();
let observer = null;

function readStoredLocale() {
  try {
    const value = globalThis.window?.localStorage?.getItem(STORAGE_KEY);
    return SUPPORTED.has(value) ? value : 'zh-CN';
  } catch {
    return 'zh-CN';
  }
}

export function currentLocale() {
  return locale;
}

export function setLocale(next) {
  locale = SUPPORTED.has(next) ? next : 'zh-CN';
  try { globalThis.window?.localStorage?.setItem(STORAGE_KEY, locale); } catch {}
  return locale;
}

export function translate(input, targetLocale = locale) {
  if (input == null || targetLocale !== 'en') return input == null ? '' : String(input);
  const value = String(input);
  const match = value.match(/^(\s*)([\s\S]*?)(\s*)$/);
  const [, leading, core, trailing] = match;
  if (!core) return value;
  let translated = EN.get(core);
  if (!translated) {
    for (const [pattern, replacement] of EN_PATTERNS) {
      if (pattern.test(core)) {
        translated = core.replace(pattern, replacement);
        break;
      }
    }
  }
  return translated ? `${leading}${translated}${trailing}` : value;
}

function translateElement(element) {
  for (const attr of ['placeholder', 'title', 'aria-label']) {
    if (element.hasAttribute?.(attr)) element.setAttribute(attr, translate(element.getAttribute(attr)));
  }
}

function translateTree(root) {
  if (locale !== 'en' || !root) return;
  if (root.nodeType === Node.TEXT_NODE) {
    const next = translate(root.nodeValue);
    if (next !== root.nodeValue) root.nodeValue = next;
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
  if (root.nodeType === Node.ELEMENT_NODE) translateElement(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.TEXT_NODE) {
      const next = translate(node.nodeValue);
      if (next !== node.nodeValue) node.nodeValue = next;
    } else {
      translateElement(node);
    }
  }
}

export function startI18n() {
  document.documentElement.lang = locale;
  translateTree(document.body);
  observer?.disconnect();
  if (locale !== 'en') return;
  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') translateTree(mutation.target);
      for (const node of mutation.addedNodes) translateTree(node);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}
