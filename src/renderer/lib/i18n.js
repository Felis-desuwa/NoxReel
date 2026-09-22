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
  '把视频拖到这里，或者点击选择（可多选）。MP4、MKV、AVI、TS、WMV 等都行，同名的外挂字幕会一起带上':
    'Drop videos here, or click to choose (you can pick several). MP4, MKV, AVI, TS, WMV and more are fine, and subtitles with the same name come along',
  '不限文件大小 · 只支持你自己合法拥有的内容': 'No file size limit · Only share content you are legally allowed to use',
  '解析视频链接': 'Open a video link',
  '粘贴单个视频页面或 MP4 / HLS 直链': 'Paste one video page, MP4 URL, or HLS URL',
  '解析并发起': 'Open and host',
  '支持范围由 yt-dlp 与原网站决定；不绕过登录、付费或 DRM。': 'Support depends on yt-dlp and the source website; login, paywalls, and DRM are not bypassed.',
  '加入放映': 'Join a watch party',
  '粘贴朋友给你的邀请链接（在 Discord 里直接点开也行）': 'Paste the invite link from your friend (or just click it in Discord)',
  'NR2-…（兼容旧版 SW2 / SW1）': 'NR2-… (also accepts legacy SW2 / SW1)',
  'https://…#j/… 或 noxreel://j/…（也认旧版的 NR3-…）': 'https://…#j/… or noxreel://j/… (older NR3-… codes also work)',
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
  '距起播还差（当前位置附近）': 'Left before playback starts (around the current position)',
  '预计还需': 'about',
  '安全模式 · 完整接收后才播，还剩': 'Safe mode · plays only after full receipt; remaining',
  '文件码率': 'File bitrate',
  '当前速度': 'Current speed',
  '还能流畅播': 'Smooth playback left',
  '速度低于码率，但缓冲够撑到收完': 'Slower than the bitrate, but the buffer lasts until the download finishes',
  '未知': 'Unknown',
  '未测': 'Not measured',
  '片源': 'Source',
  '已收完，不会卡': 'Fully received, will not stall',
  '正在测速…': 'Measuring speed…',
  '码率未知，没法预判': 'Bitrate unknown; cannot predict stalls',
  '收完才播': 'Plays after full receipt',
  '流畅': 'Smooth',
  '已经跟不上码率，会卡': 'Already behind the bitrate; will stall',
  '上行带宽（预估）': 'Uplink bandwidth (estimated)',
  '当前上传': 'Current upload',
  '安全模式：成员收完才播，不会中途卡顿': 'Safe mode: members play after full receipt, so playback will not stall midway',
  '按码率最多流畅供': 'Smoothly serves at most',
  '在收的成员都跟得上': 'Every receiving member is keeping up',
  '正在评估上行带宽': 'Estimating uplink bandwidth',
  '往最近的 Cloudflare 测速节点传一小段随机数据，估算你的上行能同时供几个人流畅边下边播。只发随机字节，不涉及片子内容。':
    'Uploading a small amount of random data to the nearest Cloudflare speed-test node to estimate how many people your uplink can smoothly serve at once. Only random bytes are sent—none of your video.',
  '不知道这个片子的时长（需要 ffmpeg 才能探测），没法预判成员会不会卡。':
    'The duration of this video is unknown (ffmpeg is needed to detect it), so stalls cannot be predicted.',
  '这个片子可能会让成员卡顿': 'This video may stall for members',
  '上行带宽余量很薄': 'Uplink bandwidth margin is thin',
  '片长': 'Duration',
  '你的上行带宽（预估）': 'Your uplink bandwidth (estimated)',
  '每人分到的上行': 'Uplink per viewer',
  '结论': 'Verdict',
  '按这个码率，你的上行连一个人都供不上流畅边下边播。': 'At this bitrate, your uplink cannot smoothly serve even one viewer.',
  '可以怎么办': 'What you can do',
  '取消后重新选这个文件，改选「无损精简」，能降低一些码率':
    'Cancel, pick this file again, and choose the lossless slim-down to lower the bitrate somewhat',
  '在邀请区调小房间人数上限': 'Lower the room capacity in the invite panel',
  '在设置里调小新房间的默认人数上限': 'Lower the default room capacity in Settings',
  '改用安全模式开房：成员收完再播，不会中途卡顿，只是要等':
    'Host in Safe mode instead: members play after full receipt, so nothing stalls midway—they just wait',
  '也可以直接继续：成员缓冲不够时会自动暂停，攒够了再接着播':
    'Or continue anyway: members pause automatically when their buffer runs low and resume once it refills',
  '仍然继续': 'Continue anyway',
  '测速超过 15 秒': 'The speed test took longer than 15 seconds',
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
  '你的缓冲不够，先暂停你自己（不影响他人）': 'Your buffer is low, so only your playback is paused',
  '缓冲不足，暂停你自己…': 'Buffer low—pausing your playback…',
  '你是游客，不能跳转进度': 'Guests cannot seek',
  '游客不能跳转进度': 'Guests cannot seek',
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
  '从当前位置可连续播放': 'Continuous playback from here',
  '在途': 'In flight',
  '速度': 'Speed',
  '已收': 'Received',
  '已发': 'Sent',
  '下行': 'Download',
  '房主': 'Host',
  '管理员': 'Moderator',
  '（手机）': ' (phone)',
  '游客': 'Guest',
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
  '文件已完整接收但没有扫完 —— 文件还在，可以重新扫描':
    'The file is fully received but the scan did not finish — the file is still here and can be scanned again.',
  '重新扫描': 'Scan again',
  '停止扫描': 'Stop scanning',
  '安全扫描已取消': 'The security scan was stopped',
  '缓冲还不够，攒够了会自动继续': 'Not enough buffer yet — it resumes automatically once there is enough',
  '复制': 'Copy',
  '已复制 ✓': 'Copied ✓',
  '复制失败': 'Copy failed',
  'ffmpeg —— 转封装与无损精简（按需）': 'ffmpeg — remuxing and lossless slim-down (as needed)',
  '未找到。转封装和无损精简都需要它。': 'Not found. Both remuxing and the lossless slim-down need it.',
  'ffprobe —— 读取媒体信息（按需）': 'ffprobe — reading media information (as needed)',
  '未找到。它和 ffmpeg 是两个程序。没有它读不到时长和每轨码率，卡顿预判和无损精简都会失效。':
    'Not found. It is a separate executable from ffmpeg. Without it NoxReel cannot read the duration or per-track bitrates, so the stall forecast and the lossless slim-down both stop working.',
  '重试': 'Retry',
  '复制诊断信息': 'Copy diagnostics',
  '房间进行中不能改名，退出后可改。': 'Your display name cannot change during a screening; leave the room first.',
  '缓存位置': 'Cache location',
  '换个位置': 'Change location',
  '清理残留': 'Clean up leftovers',
  '正在统计…': 'Measuring…',
  '（未知）': '(unknown)',
  '放映进行中不能换位置，退出房间后可改。': 'The location cannot change during a screening; leave the room first.',
  '接收到的片子放在这里，退房或关闭软件时自动删除。':
    'Received videos live here and are deleted when you leave the room or close the app.',
  '换到空间大的盘上，才收得下大文件。': 'Point it at a drive with room, so large files fit.',
  '清理只认本软件自己建的目录，同目录下你自己的文件一个都不会动。':
    'Cleanup only touches directories NoxReel created itself; your own files in the same folder are never touched.',
  '遇到问题时': 'When something goes wrong',
  '。诊断信息里只有运行环境和连接状态，不含文件路径和片名。':
    '. The diagnostics contain only environment and connection state — no file paths and no video titles.',
  '勾了启用 TURN 中继，但地址是空的 —— 这样等于没配。填一个地址，或者把勾去掉。':
    'TURN relay is enabled but the address is empty, which means there is no relay at all. Enter an address, or clear the checkbox.',
  '扫描没做完 · 文件仍在': 'Scan unfinished · File kept',
  '扫描已停止 · 文件仍在': 'Scan stopped · File kept',
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

  // —— IP 隐私：隐藏我的 IP、Cloudflare TURN（0.7.6） ——
  'TURN 中继': 'TURN relay',
  'TURN 来源': 'TURN source',
  '自己填': 'Enter my own',
  'Cloudflare 自动生成': 'Generate with Cloudflare',
  '验证并保存': 'Verify and save',
  '清除': 'Clear',
  '在 Cloudflare 后台 Realtime → TURN Server 新建一个 Key，把 Turn Token ID 和 API Token 填进来，点「验证并保存」。':
    'In the Cloudflare dashboard, create a key under Realtime → TURN Server, paste its Turn Token ID and API Token here, and click “Verify and save”.',
  'API Token 加密保存在本机，只有 NoxReel 的主进程拿它向 Cloudflare 换 24 小时有效的临时账号，界面上不会再显示。':
    'The API Token is stored encrypted on this computer. Only NoxReel’s main process uses it, to get 24-hour temporary credentials from Cloudflare; it is never shown in the interface again.',
  'Cloudflare TURN 月用量上限': 'Cloudflare TURN monthly limit',
  '每月最多用': 'Use at most',
  'GB（本机统计）': 'GB per month (counted on this computer)',
  '到上限就不再用 Cloudflare TURN（为免扣费），下个月 1 日（UTC）自动恢复；已经连着的不会被断开。':
    'At the limit, Cloudflare TURN stops being used (to avoid charges) and comes back automatically on the 1st of next month (UTC); existing connections are not cut off.',
  '这是本机统计，和 Cloudflare 账单可能有出入；建议另外在 Cloudflare 后台 Manage Account → Billing → Billable Usage 建一个 Budget alert 做兜底。':
    'This is counted on this computer and may differ from your Cloudflare bill; as a safety net, also create a Budget alert in the Cloudflare dashboard under Manage Account → Billing → Billable Usage.',
  '隐藏我的 IP（只经 TURN 中继连接）': 'Hide my IP (connect only through a TURN relay)',
  '打开后，房间里的人只能看到 TURN 服务器的地址，看不到你的 IP。':
    'When on, people in the room only see the TURN server’s address, not your IP.',
  '需要先配好 TURN（自己填，或用 Cloudflare 自动生成）；TURN 用不了时会连不上，不会退回直连。只影响之后新建的连接。':
    'Set up TURN first (your own server, or generated with Cloudflare). If TURN is unavailable you will not connect—there is no fallback to a direct connection. Only affects connections made from now on.',
  'Turn Token ID 和 API Token 都要填。': 'Enter both the Turn Token ID and the API Token.',
  '正在向 Cloudflare 验证…': 'Verifying with Cloudflare…',
  '已保存': 'Saved',
  '已清除': 'Cleared',
  'Cloudflare 凭据还没保存：先点「验证并保存」，或者把这两个框清空。':
    'The Cloudflare credentials are not saved yet: click “Verify and save” first, or clear both fields.',
  'Cloudflare TURN 每月上限要填 1 到 1000 之间的整数（GB）。':
    'The Cloudflare TURN monthly limit must be a whole number from 1 to 1000 (GB).',
  '已打开「隐藏我的 IP」，但还没有可用的 TURN 中继：请在设置里配好 TURN，或者先关掉这个开关。':
    '“Hide my IP” is on, but no TURN relay is available yet: set up TURN in Settings, or turn this option off.',
  '还不能连接': 'Cannot connect yet',
  '未授权：Cloudflare 不认这组 Turn Token ID 和 API Token': 'Unauthorized: Cloudflare rejected this Turn Token ID and API Token',
  '网络不通：连不上 Cloudflare': 'Network problem: cannot reach Cloudflare',
  'Cloudflare 的回应看不懂': 'Cloudflare sent a response that could not be understood',
  '还没保存 Cloudflare 凭据': 'No Cloudflare credentials saved yet',
  '本机的加密服务不可用，不能安全地保存 API Token': 'This computer’s encryption service is unavailable, so the API Token cannot be stored safely',
  'Turn Token ID 或 API Token 的格式不对': 'The Turn Token ID or API Token is not in the right format',
  '出错了': 'Something went wrong',
  'Cloudflare TURN：还没配置': 'Cloudflare TURN: not set up',
  'Cloudflare TURN：已配置': 'Cloudflare TURN: set up',
  '本月用量已超过上限的 80%，快到上限了。': 'This month’s usage is past 80% of the limit and close to it.',
  '已打开「隐藏我的 IP」，只能经 TURN 中继连接，但一条中继候选都没拿到 —— TURN 地址、用户名密码大概率有一项不对，或者账号已经过期。请检查设置里的 TURN，或者先关掉「隐藏我的 IP」。':
    '“Hide my IP” is on, so only TURN relay connections are allowed, but no relay candidate arrived—the TURN address, username, or password is most likely wrong, or the credentials have expired. Check TURN in Settings, or turn “Hide my IP” off.',
  '只经 TURN 中继连接：已经拿到中继候选，房间里的人只能看到 TURN 服务器的地址。':
    'Relay-only connection: a relay candidate is available, so people in the room only see the TURN server’s address.',

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
    'Converting the uncompressed PCM audio track to FLAC (lossless). This re-encodes the audio, so a long film can take a few minutes.',
  // 房间界面重排（0.7）
  '播放列表': 'Playlist',
  '+ 本地视频': '+ Local video',
  '+ 链接': '+ Link',
  '加入列表': 'Add to playlist',
  '聊天': 'Chat',
  '日志': 'Log',
  '正在播放': 'Now playing',
  '还没有消息': 'No messages yet',
  // 弹幕聊天（0.7）
  '发送': 'Send',
  '说点什么…': 'Say something…',
  '聊天输入框': 'Chat input box',
  '发送中': 'Sending…',
  '已送达': 'Delivered',
  '你加入前的消息': 'Messages from before you joined',
  '弹幕': 'Danmaku',
  '弹幕设置': 'Danmaku settings',
  // 播放器里按 Ctrl+Shift+D 调出的输入框提示语：随 player:launch 的 chatPrompt 传给 mpv
  '弹幕：': 'Danmaku: ',
  '不透明度': 'Opacity',
  '字号': 'Font size',
  '显示区域': 'Display area',
  '上半屏': 'Top half',
  '全屏': 'Full screen',
  '还没有其他成员。': 'No other members yet.',
  '列表还是空的，点右上角加一部。': 'The playlist is empty. Add a video with the buttons at the top right.',
  '列表还是空的，等房主加片。': 'The playlist is empty. Waiting for the host to add a video.',
  // 播放列表（0.7）
  '你没有编辑播放列表的权限': 'You do not have permission to edit the playlist',
  '没能加进播放列表': 'Could not add it to the playlist',
  '和房主的连接断了': 'The connection to the host is lost',
  '房主没有回应': 'The host did not respond',
  '房间已关闭': 'The room is closed',
  '无效的操作': 'Invalid operation',
  '无效的列表条目': 'Invalid playlist entry',
  '列表里已经有这部片了': 'This video is already in the playlist',
  '列表里已经有这个链接了': 'This link is already in the playlist',
  '列表里没有这一项': 'That item is not in the playlist',
  '列表里没有目标位置': 'The target position is not in the playlist',
  '已播放区里没有这一项': 'That item is not in the played list',
  '不认识的操作': 'Unknown operation',
  '收到一份格式不对的播放列表，已忽略': 'Ignored a malformed playlist',
  '收到的播放列表把已有条目的内容换掉了，已忽略': 'Ignored a playlist that replaced the contents of existing items',
  '播放列表已经放完了': 'The playlist has finished',
  '播放列表是空的': 'The playlist is empty',
  '改用房主提供的临时播放地址': 'Using the host’s temporary stream URL',
  '没有人能提供这部片的清单': 'Nobody can provide the manifest for this video',
  // 播放列表表格、就绪、行内加片（0.7）
  '上移': 'Move up',
  '下移': 'Move down',
  '移除': 'Remove',
  '立即播放': 'Play now',
  '跳过': 'Skip',
  '跳过这一部': 'Skip this one',
  '再放一次': 'Play again',
  '再放一次（需重新传输）': 'Play again (needs a new transfer)',
  '从已播放中移除': 'Remove from played',
  '复制链接': 'Copy link',
  '链接已复制': 'Link copied',
  '更多操作': 'More actions',
  '自动连播': 'Autoplay',
  '放完一部接着放下一部，等所有人准备好再开始': 'When a video ends, play the next one once everyone is ready',
  '添加者：': 'Added by ',
  '下一部': 'Up next',
  '已开播：把别的片拖到它上面会先问你要不要切过去': 'Already playing: dragging another video above it asks before switching',
  '切换正在播放的片子？': 'Switch the video that is playing?',
  '切到': 'Switch to',
  '正在放': 'Now playing',
  '切换': 'Switch',
  '正在放的这部排到下一位。': 'The current video moves to the next position.',
  '移除正在播放的这一部？': 'Remove the video that is playing?',
  '会直接换到下一部。': 'Playback switches straight to the next video.',
  '列表已播完': 'The playlist has finished',
  '房主已离开，列表暂停更新': 'The host left; the playlist is no longer updated',
  '和房主的连接断了，正在重连；列表暂停更新':
    'The connection to the host dropped and is being retried; the playlist is not updating',
  '已取消': 'Cancelled',
  '这一部没有加入放映。': 'This video was not added to the watch party.',
  '清掉已播放的缓存也放不下这一部，缓存先都留着':
    'Even clearing every played cache would not make room for this video, so they are all kept',
  '房主已离开，列表暂停更新；已经连上的成员之间照常传输': 'The host left; the playlist is no longer updated, but connected members keep transferring',
  '房主已离开，这个房间结束了': 'The host left; this room has ended',
  // 传输一栏
  '本机有完整文件': 'Full file on this computer',
  '已拒绝接收': 'Refused',
  '磁盘空间不够': 'Not enough disk space',
  '正在获取清单': 'Fetching the manifest',
  '排队中': 'Queued',
  '排队中（等大家先收完当前这部）': 'Queued (until everyone has the current video)',
  '片源已离开': 'Source left',
  '暂时没人能提供': 'Nobody can provide it right now',
  '已收完': 'Received',
  '已收完 · 扫描中': 'Received · Scanning',
  '已收完 · 扫描通过': 'Received · Scan passed',
  '已收完 · 未经扫描': 'Received · Not scanned',
  '已收完 · 没扫完': 'Received · Scan incomplete',
  '已收完 · 等待扫描': 'Received · Waiting to scan',
  '各自从原网站播放': 'Everyone streams from the original site',
  '片源上行（预估）': 'Source upload (estimated)',
  // 链接授权（行内，不弹窗）
  '需要允许打开': 'Needs your permission to open',
  '房主给的播放地址需要允许打开': 'The host’s stream URL needs your permission to open',
  '本机无法解析这个链接': 'This link cannot be resolved on your computer',
  '这个视频链接在你的电脑上无法解析，可以先跳过这一部':
    'This video link cannot be resolved on your computer. You can skip this one for now.',
  '允许': 'Allow',
  '允许打开': 'Allow',
  '改为允许': 'Allow instead',
  '你跳过了这一部': 'You skipped this one',
  '这一部我先跳过': 'Skip this one for me',
  '你跳过了这一部，播放器保持空闲（不影响其他人）': 'You skipped this one; your player stays idle (others are not affected)',
  '这一部你先跳过了，播放器保持空闲，不影响其他人': 'You skipped this one; your player stays idle and others are not affected',
  // 行内加片
  '排队准备中': 'Waiting to prepare',
  '正在检查格式': 'Checking the format',
  '正在优化传输体积': 'Optimizing transfer size',
  '正在加入列表': 'Adding to the playlist',
  '等待房主确认': 'Waiting for the host',
  '正在取消': 'Cancelling',
  '没加进列表': 'Not added',
  '房主没有接受': 'The host did not accept it',
  '你已不是管理员，还没加进列表的片撤回了': 'You are no longer a moderator, so videos not yet added were withdrawn',
  '拿不到拖进来的文件的路径，请改用「+ 本地视频」选择': 'Could not get the path of the dropped file. Use “+ Local video” instead.',
  '正在给成员供片，这时测不准上行': 'You are serving members right now, so upload speed cannot be measured accurately',
  '操作已取消': 'Cancelled',
  '安全扫描没能完成': 'The security scan did not finish',
  '未知原因': 'Unknown reason',
  '同一任务已在进行中': 'The same task is already running',
  // 就绪与自动开播
  '仍然开始': 'Start anyway',
  '所有人都准备好了，马上开始': 'Everyone is ready; starting now',
  '所有人都准备好了，点「播放」开始': 'Everyone is ready. Press Play to start',
  '所有人都准备好了，等房主或管理员开始': 'Everyone is ready. Waiting for the host or a moderator to start',
  '所有人都准备好了，自动开始播放': 'Everyone is ready; starting playback',
  // 中途加入（可信房间）
  '你是中途加入的，正在下载房间当前位置附近的内容':
    'You joined mid-playback; downloading the part the room is at now.',
  '正在优先获取索引（MKV 的索引常在文件尾）':
    'Fetching the index first (MKV keeps it at the end of the file).',
  '跳转到的位置还没收到，已暂停等缓冲': 'That position has not arrived yet; paused while it buffers.',
  '播放到已接收内容的末尾，等后续分片': 'Reached the end of what has been received; waiting for more.',
  '片源没提供时长，算不出房间播到哪；这一部要完整接收后才能播放':
    "The source did not provide a duration, so the room's position cannot be calculated; this video will play only after it is fully received.",
  '片源没提供时长 · 完整接收后才播，还剩': 'No duration from the source · plays after full receipt, remaining',
  '播放列表是空的，加一部就能开始': 'The playlist is empty. Add a video to start',
  '播放列表是空的，等房主加片': 'The playlist is empty. Waiting for the host to add a video',
  '这一部的片源已经离开，暂时没人能提供': 'The source of this video left, and nobody can provide it right now',
  '本机磁盘放不下这一部，已跳过，不影响其他人': "This video doesn't fit on this computer's disk. Skipped here without holding up anyone else",
  // 协议版本（0.7 与 0.6 不互通）
  '这个邀请来自旧版 NoxReel（0.6.x），和 0.7 不互通。请让房主升级到 0.7 后重新发邀请。':
    'This invite comes from an older NoxReel (0.6.x), which cannot connect to 0.7. Ask the host to upgrade to 0.7 and send a new invite.',
  '这个邀请来自更新版本的 NoxReel，和本机不互通。请先升级本机的 NoxReel。':
    'This invite comes from a newer NoxReel that cannot connect to this one. Upgrade NoxReel on this computer first.',
  '对方是旧版 NoxReel（0.6.x），和 0.7 不互通。请让他升级到 0.7 再加入。':
    'The other person is using an older NoxReel (0.6.x), which cannot connect to 0.7. Ask them to upgrade to 0.7 and join again.',
  '对方用的是更新版本的 NoxReel，和本机不互通。请先升级本机的 NoxReel。':
    'The other person is using a newer NoxReel that cannot connect to this one. Upgrade NoxReel on this computer first.',
  // 可切换播放器（控制条上的下拉框、不可用原因、播放器那一侧的提示）
  '播放器': 'Player',
  '指定路径…': 'Set path…',
  '未找到': 'Not found',
  '桥接程序未构建': 'Bridge not built',
  '只支持 Windows': 'Windows only',
  '这一部还没收完': 'This video is not fully received yet',
  '在线链接只用 mpv 播放': 'Online links play in mpv only',
  '在线链接只能用 mpv 播放': 'Online links can only be played in mpv',
  '不可用': 'Unavailable',
  '桥接程序未构建（npm run build:bridge）': 'The bridge program is not built (npm run build:bridge)',
  '切换失败，已回到 mpv': 'Switching failed, back on mpv',
  '独占全屏下看不到弹幕，切成无边框全屏就能看到':
    'Danmaku cannot be shown over exclusive fullscreen. Switch the player to borderless fullscreen to see it.',
  'Ctrl+Shift+D 被别的程序占用了，在播放器里发不了弹幕':
    'Ctrl+Shift+D is taken by another program, so danmaku cannot be sent from inside the player',
  '这会儿弹不出输入条：播放器不在前台，或者正处于独占全屏':
    'The input bar cannot open right now: the player is not in the foreground, or it is in exclusive fullscreen',
  // 房间页重排（0.7.1）
  '角色': 'Role',
  '状态': 'Status',
  '已就绪': 'Ready',
  '未就绪': 'Not ready',
  '上行': 'Upload',
  '即将开始': 'Starting soon',
  '还没开始': 'Not started',
  'TURN 中继开着但没填用户名或密码，这次先不走中继、只尝试直连。到设置里补全，或者把中继关掉。':
    'The TURN relay is on but has no username or password, so it is skipped this time and only direct connections are tried. Complete it in Settings, or turn the relay off.',
  'TURN 中继要填用户名和密码（中继服务器靠它们认人）。没有的话把「启用 TURN 中继」的勾去掉。':
    'A TURN relay needs a username and password (the relay server uses them to authenticate you). If you do not have them, uncheck “Enable TURN relay”.',
  '点开对方发回的 NoxReel 应答链接，或粘贴到这里': 'Open the NoxReel reply link they sent back, or paste it here',
  '还没有人加入：照下面的步骤把朋友拉进来，也可以自己先放':
    'Nobody has joined yet: follow the steps below to bring friends in, or start watching on your own',
  '邀请下一位': 'Invite someone else',
  '收起': 'Hide',
  '把朋友拉进房间': 'Bring friends into the room',
  '人到齐后按播放': 'Press Play once everyone is here',
  '还有人要来？这位连上后，成员表底下会出现「邀请下一位」。':
    'More people coming? Once this one connects, “Invite someone else” appears under the member list.',
  '+ 添加': '+ Add',
  '本地视频…': 'Local video…',
  '视频链接…': 'Video link…',
  '在播放器里按 Ctrl+Shift+D 也能直接发弹幕': 'Inside the player, press Ctrl+Shift+D to send danmaku directly',
  '白点是播放位置；绿色是从这里起不用等就能接着放的部分，用完之前还没补上，全员会暂停等你；深蓝是已经收到的部分，断开的地方还在补':
    'The white dot is the playback position. Green is what can keep playing from here without waiting; if it runs out before more arrives, everyone pauses for you. Dark blue is what has been received; gaps are still being filled.',
  '重新生成邀请链接': 'Generate a new invite link',
  '复制邀请链接，发给其中一位': 'Copy the invite link and send it to one person',
  '一条链接只给一个人用，几分钟内有效；过期了重新生成一条即可':
    'Each link is for one person and works for a few minutes; generate a new one if it expires',
  '对方发回应答链接后，直接点开或粘贴到这里': 'When they send back a reply link, open it or paste it here',
  '复制邀请码，发给要来的人': 'Copy the invite code and send it to whoever is coming',
  '这个码多人可用、可重复使用；房间会一直开着直到你离开。':
    'This code works for several people and can be reused; the room stays open until you leave.',
  '（你）': ' (you)',
  '各自从原网站播放': 'Each plays from the original site',
  '准备情况': 'Readiness',
  '实时速率': 'Live rate',
  '供片中': 'Seeding',
  '整部都在本机，不用等': 'The whole file is here, no waiting',
  '各自从原网站读取，不走 P2P': 'Everyone reads from the original site, not over P2P',
  '还没人连上，没有流量': 'Nobody has connected yet, no traffic',
  '现在没人在收': 'Nobody is receiving right now',
  '这一部已经收完': 'This one is fully received',
  '安全模式：收完才播': 'Safe mode: plays after the full download',
  '还没开始收': 'Not receiving yet',
  '下行刚好够码率，余量很薄': 'Download just matches the bitrate, very little margin',
  '下行比码率低，边下边播可能会卡': 'Download is below the bitrate, progressive playback may stall',
  // 更多格式与外挂字幕（0.7.3）
  '不支持这种视频格式': 'This video format is not supported',
  '只支持 ASS、SSA、SRT、VTT 字幕': 'Only ASS, SSA, SRT and VTT subtitles are supported',
  '这个文件里没有能封进 MKV 的音视频轨': 'This file has no audio or video track that fits in MKV',
  '读不出这个文件的轨道信息，没法封成 MKV': 'Could not read the tracks of this file, so it cannot be packed into MKV',
  '字幕未经用户选择，已拒绝访问': 'Subtitle access was rejected because it was not selected by the user',
  '无效的字幕列表': 'Invalid subtitle list',
  '是空文件': 'the file is empty',
  '不是文本字幕': 'it is not a text subtitle',
  '里面没有 SRT 时间轴': 'it has no SRT timings',
  '缺少 WEBVTT 文件头': 'it lacks the WEBVTT header',
  '缺少 [Script Info] 段': 'it lacks a [Script Info] section',
  '认不出文字编码': 'its text encoding could not be recognised',
  '正在把字幕封进片子': 'Packing the subtitles into the video',
  '正在封成 MKV': 'Packing into MKV',
  '保留全部轨道': 'Keep all tracks',
  '外挂字幕': 'External subtitles',
  '片子旁边没找到外挂字幕。': 'No external subtitles were found next to the video.',
  '添加字幕文件…': 'Add subtitle files…',
  '勾上的字幕会封进片子一起传（只换容器、不重新编码），每个人在播放器里都能切换；第一条勾上的默认显示。':
    'Checked subtitles are packed into the video and sent with it (container change only, nothing is re-encoded). Everyone can switch between them in their player; the first checked one shows by default.',
  '要带外挂字幕，产物会是 MKV —— MP4 装不下 ASS 字幕。':
    'To carry external subtitles the result will be an MKV — MP4 cannot hold ASS subtitles.',
  // 可点的链接、房间链接、Discord 状态（0.7.4）
  '正在连接公共中继…': 'Connecting to public relays…',
  '复制房间链接，发到群里': 'Copy the room link and post it in your group',
  '谁点开都能进，直到坐满人数上限；你离开房间后链接就失效了。':
    'Anyone who opens it can join until the room is full; the link stops working once you leave.',
  '复制房间链接': 'Copy room link',
  '经公共中继交换连接信息（加密），视频仍在你们之间直传。中继能看到连接者的 IP，看不到内容和片名。':
    'Connection details go through public relays (encrypted); the video still streams directly between you. Relays can see who connects (IP addresses), not what you watch.',
  '换一条链接（旧的作废）': 'New link (old one stops working)',
  '房间链接换好了，旧链接已作废（已经在房里的人不受影响）':
    'The room link was replaced and the old one no longer works (people already in the room are unaffected)',
  '房间链接（谁点谁进）': 'Room link (anyone can join)',
  '一对一邀请（不经过第三方）': 'One-to-one invite (no third party)',
  '这个房间链接不完整，请让房主重新复制一次。': 'This room link is incomplete. Ask the host to copy it again.',
  '正在通过公共中继找房主': 'Finding the host through public relays',
  '解析房间链接': 'Read the room link',
  '等房主放行': 'Wait for the host to let you in',
  '房主已放行，正在和房间里的人打洞…': 'The host let you in; connecting to the people in the room…',
  '找不到房主：他可能已经离开房间，或者换过房间链接。请让房主重新发一条。':
    'Could not find the host: they may have left the room or replaced the room link. Ask the host for a new one.',
  '连不上公共中继（所在网络可能拦了它们）。请让房主改发「一对一邀请」，那个不经过任何第三方。':
    'Could not reach the public relays (your network may block them). Ask the host for a one-to-one invite instead; it involves no third party.',
  '房主不在线，或者这个房间链接已经失效': 'The host is offline, or this room link no longer works',
  '连不上任何公共中继': 'Could not reach any public relay',
  '双方 NoxReel 版本不一致，请都升级到最新版': 'Your NoxReel versions differ; both of you should update to the latest version',
  '这个身份已经在房间里了': 'That identity is already in the room',
  '这个身份是房主的': 'That identity belongs to the host',
  '房主拒绝了加入': 'The host declined the join',
  '房间链接里的房主公钥不对': 'The host key in this room link is invalid',
  '房间密钥格式不对': 'The room key is malformed',
  '只有房主能换房间链接': 'Only the host can replace the room link',
  '房间链接（公共中继）': 'Room link (public relays)',
  '公共中继（房间链接用）': 'Public relays (for room links)',
  '房间链接经这些公共 Nostr 中继交换加密后的连接信息，视频不经过它们。':
    'Room links exchange encrypted connection details through these public Nostr relays; video never goes through them.',
  '留空用内置的一组；想换就每行写一个 wss:// 地址，你当房主时这份列表会写进房间链接。':
    'Leave empty to use the built-in set; to change it, write one wss:// address per line. When you host, this list is included in the room link.',
  'Discord 状态': 'Discord status',
  '在 Discord 上显示我在放映': 'Show on Discord that I’m hosting or watching',
  '显示片名': 'Show the title',
  '显示「加入放映」按钮（用房间链接时）': 'Show a “Join” button (when using a room link)',
  '你所有的 Discord 好友都能在你的资料上看到，点「加入放映」就能进房。':
    'All your Discord friends can see this on your profile and join with the “Join” button.',
  '需要电脑上开着 Discord 客户端，网页版不行。': 'Needs the Discord desktop app running; Discord in a browser won’t work.',
  '这个版本没有配置 Discord 应用，状态显示用不了': 'This build has no Discord application configured, so status display is unavailable',
  '已连上 Discord': 'Connected to Discord',
  '正在连接 Discord…': 'Connecting to Discord…',
  '没检测到 Discord 客户端（开着 Discord 时会自动连上）': 'Discord app not detected (it connects automatically when Discord is running)',
  '进入房间后会显示': 'Shown once you’re in a room',
  '没有打开': 'Off',
  '和朋友一起看片': 'Watching with friends',
  '还有人要来？同一条链接接着发就行，不用重新生成。': 'More people coming? Just send the same link again; no need to make a new one.',
  '还有人要来？这个邀请码接着发就行，不用重新生成。': 'More people coming? Just send the same invite code again; no need to make a new one.',
  '等待开播': 'Waiting to start',
  '下载 NoxReel': 'Download NoxReel',
  // 0.7.5：加入流程的收尾、房间里收到新邀请、设置里的人数上限
  '要离开当前房间吗？': 'Leave the current room?',
  '收到了一条新的邀请。加入它要先离开当前房间，你这边的播放和传输都会停下。':
    'You received a new invite. Joining it means leaving the current room first, and your playback and transfers here will stop.',
  '离开并加入': 'Leave and join',
  '要放弃正在准备的放映吗？': 'Abandon the watch party you are preparing?',
  '收到了一条新的邀请。加入它要先停下正在准备的这部片。':
    'You received a new invite. Joining it means stopping the video you are preparing.',
  '放弃并加入': 'Abandon and join',
  '你已经在这个房间里了。': 'You are already in this room.',
  '同时连着的人太多了，多出来的连接请求已忽略': 'Too many simultaneous connections; the extra connection requests were ignored',
  '操作太频繁了，稍后再试': 'Too many changes at once; try again in a moment',
  '房主那边一直没能和你直连，你已被移出房间。可以请房主改发一对一邀请，或者双方在设置里配置 TURN 后再试。':
    'The host could never connect to you directly, so you were removed from the room. Ask the host for a one-to-one invite, or both set up TURN in Settings and try again.',
  '房间里正有好几个人在连接，稍后再点一次链接试试。': 'Several people are connecting to the room right now. Open the link again in a moment.',
  '只影响以后新开的房间；这个房间的人数上限请在邀请区调整。':
    'Only affects rooms you open later; change this room’s limit in the invite area.',
  简体中文: 'Simplified Chinese',
  繁体中文: 'Traditional Chinese',
  中文: 'Chinese',
  英文: 'English',
  日文: 'Japanese',
  韩文: 'Korean',
  '写入接收缓存失败，磁盘可能已满': 'Could not write to the receive cache; the disk may be full',
  '无效的媒体清单': 'Invalid media manifest',
  '消息必须是 JSON 对象': 'Messages must be JSON objects',
  '加入房间太频繁，请稍后再试': 'Joining rooms too often. Please try again later',
  '创建房间太频繁，请稍后再试': 'Creating rooms too often. Please try again later',
  '服务器的房间数已满，请稍后再试': 'The server has reached its room limit. Please try again later',
  'name 必须是字符串': 'name must be a string',
  'maxMembers 必须是数字': 'maxMembers must be a number',
  'signal 需要字符串 to 和对象 payload': 'signal needs a string "to" and an object "payload"',
  '消息发得太快，连接已断开': 'Messages were sent too fast, so the connection was closed',
  '服务器处理这条消息时出错': 'The server failed to process this message',
  '本机网络过滤代理启动失败，为防访问内网已拒绝打开在线链接': 'The local network filter proxy failed to start, so online links are blocked to protect your local network',
  '正在解析的链接太多，稍后再试': 'Too many links are being resolved. Try again later',
  '缓存目录未经用户选择，已拒绝': 'Rejected a cache folder that was not chosen by the user',
  '本机过滤代理没有启动，已拒绝打开第三方页面': 'The local filter proxy is not running, so third-party pages are blocked',
  '测速节点的响应过大': 'The speed test server response was too large',
  '房主这边正在连接的人太多，暂时进不来，请稍后再试': 'Too many people are connecting to the host right now. Please try again later',
  '你已经被移出这个房间，本场放映不能再加入': 'You were removed from this room and cannot rejoin this screening',
  '你被移出了房间：一直没能和房主建立直连': 'You were removed from the room: a direct connection to the host never came up',
  '房主这边还有人在连接，请稍后再试': 'Others are still connecting to the host. Please try again later',
  '只有房主能移出成员': 'Only the host can remove members',
}));

const trimEnd = (text) => String(text).replace(/[.。]+$/, '');

/** 等待名单：只把我们自己的「你」这个标记翻过去，别人的昵称原样保留。 */
const joinWaiting = (list) =>
  String(list)
    .split('、')
    .map((name) => (name === '你' ? 'you' : name))
    .join(', ');

/** 主进程参数校验报「无效的 xxx」时的字段名。 */
const INVALID_LABELS = {
  临时媒体路径: 'temporary media path',
  任务标识: 'task id',
  会话标识: 'session id',
  做种参数: 'seeding parameters',
  写入分片参数: 'chunk write parameters',
  读取分片参数: 'chunk read parameters',
  分片下标: 'chunk index',
  分片哈希: 'chunk hashes',
  分片大小: 'chunk size',
  分片数据: 'chunk data',
  分片数量: 'chunk count',
  剪贴板文本: 'clipboard text',
  地区检测参数: 'region check parameters',
  媒体时长: 'media duration',
  媒体清单: 'media manifest',
  媒体请求头: 'media request headers',
  媒体链接: 'media link',
  片源上行带宽: 'source upload speed',
  房间版本: 'room revision',
  提示文本: 'message text',
  提示时长: 'message duration',
  播放位置: 'playback position',
  播放器代号: 'player id',
  播放器启动参数: 'player launch parameters',
  播放器提示参数: 'player message parameters',
  播放地址: 'stream URL',
  文件名: 'file name',
  文件大小: 'file size',
  文件标识: 'file id',
  测速参数: 'speed test parameters',
  精简参数: 'slimming parameters',
  转换参数: 'conversion parameters',
  'Discord 状态': 'Discord status',
  字幕路径: 'subtitle path',
  转封装参数: 'remux parameters',
  校验参数: 'validation parameters',
  缓存目录: 'cache folder',
  缓存目录参数: 'cache folder parameters',
  覆盖层参数: 'overlay parameters',
  覆盖层文本: 'overlay text',
  视频链接: 'video link',
  起播位置: 'start position',
  轨道下标: 'track index',
  隔离浏览器请求: 'isolated browser request',
  'Cloudflare 凭据': 'Cloudflare credentials',
  'Turn Token ID': 'Turn Token ID',
  'API Token': 'API Token',
  'TURN 参数': 'TURN parameters',
  'TURN 用量': 'TURN usage',
  'TURN 用量上限': 'TURN usage limit',
};

const EN_PATTERNS = [
  // 0.7.5 加固
  [/^(.+) 被停止供片后仍在持续发送数据，已断开连接$/, '$1 kept sending data after being cut off as a source and was disconnected'],
  [/^(.+) 送来的分片多次校验失败，已停止向他要片$/, 'Chunks from $1 failed verification repeatedly; no longer requesting chunks from them'],
  [/^写入接收缓存失败：(.*)$/, (_all, detail) => `Could not write to the receive cache: ${translate(detail, 'en')}`],
  [/^信令消息太大（上限 (\d+) 字节）$/, 'Signaling message too large (limit $1 bytes)'],
  [/^(.+) 超过 (\d+) 秒没有结束，已停止$/, '$1 did not finish within $2 seconds and was stopped'],
  [/^(.+) 的输出超过 (\d+) MB，已停止$/, 'The output of $1 exceeded $2 MB, so it was stopped'],
  // 播放列表表格、就绪、行内加片（0.7）
  [/^传输中 (\d+)%$/, 'Transferring $1%'],
  [/^传输已暂停 (\d+)%$/, 'Transfer paused $1%'],
  [/^等待片源 (\d+)%$/, 'Waiting for the source $1%'],
  [/^片源已离开 (\d+)%$/, 'Source left $1%'],
  [/^暂时没人能提供 (\d+)%$/, 'Nobody can provide it right now $1%'],
  [/^已播放（(\d+)）$/, 'Played ($1)'],
  [/^等待 (\d+) 人准备好：$/, (_all, n) => `Waiting for ${n} ${n === '1' ? 'person' : 'people'} to get ready: `],
  [/^正在放的这部排到下一位，回头从 (.+) 接着放。$/, 'The current video moves to the next position and resumes from $1 later.'],
  [/^列表没改成：(.*)$/, (_all, detail) => `The playlist was not changed: ${translate(detail, 'en')}`],
  [/^《(.+)》没加进列表：(.*)$/, (_all, name, detail) => `“${name}” was not added to the playlist: ${translate(detail, 'en')}`],
  [/^《(.+)》已经在列表里了，跳过$/, '“$1” is already in the playlist; skipped'],
  [
    /^还有 (\d+) 部没有加入，要用它们开房请重新选择。$/,
    (_all, n) => `${n} more ${n === '1' ? 'video was' : 'videos were'} not added; pick them again to host with them.`,
  ],
  [/^这些也没能用：(.+)$/, 'These could not be used either: $1'],
  [/^《(.+)》安全扫描通过$/, '“$1” passed the security scan'],
  [/^《(.+)》没有扫完：(.*)$/, (_all, name, detail) => `“${name}” was not fully scanned: ${translate(detail, 'en')}`],
  [/^先扫正在放的这部，《(.+)》稍后接着扫$/, 'Scanning the current video first; “$1” will be scanned afterwards'],
  [/^磁盘空间不够，先清掉已播放的《(.+)》的缓存$/, 'Not enough disk space; clearing the cache of the played video “$1” first'],
  [/^这一部来自 (.+)，在列表或上方点「允许打开」后才会播放$/, 'This video comes from $1. It plays after you choose “Allow” in the playlist or above.'],
  [/^这一部要打开 (.+)，需要你先允许$/, 'This video opens $1 and needs your permission first'],
  [/^房主提供的播放地址来自 (.+)，需要你先允许$/, 'The host’s stream URL comes from $1 and needs your permission first'],
  [/^房主提供的临时播放地址来自 (.+)，在列表或上方点「允许打开」后才会使用$/, 'The host’s temporary stream URL comes from $1. It is used only after you choose “Allow” in the playlist or above.'],
  [/^房主给的播放地址刚更新，现在来自 (.+)，看清楚再点「允许」$/, 'The host’s stream URL just changed and now comes from $1. Check it before choosing “Allow”.'],
  [/^这一部的网址刚换成 (.+)，看清楚再点「允许」$/, 'This item’s address just changed to $1. Check it before choosing “Allow”.'],
  [/^这个询问刚出现，要打开的是 (.+)，看清楚再点「允许」$/, 'This prompt just appeared and opens $1. Check it before choosing “Allow”.'],
  [/^列表最多 (\d+) 项$/, 'The playlist can hold at most $1 items'],
  [/^(.+)（极简模式下你只供房主一人，再由房主转给其他人）$/, '$1 (in Minimal mode you only serve the host, who relays it to everyone else)'],
  [/^(.+)（房间里另外 (\d+) 人同时接收）$/, '$1 ($2 other people in the room receive at the same time)'],
  [/^无效的 (.+)$/, (_all, label) => `Invalid ${INVALID_LABELS[label] || `input (${label})`}`],
  // 播放列表（0.7）
  [/^切换到下一部失败：(.*)$/, (_all, detail) => `Could not switch to the next item: ${translate(detail, 'en')}`],
  [/^现在放：(.*)$/, 'Now playing: $1'],
  [/^还没拿到《(.+)》的清单：(.*)$/, (_all, name, detail) => `Still waiting for the manifest of “${name}”: ${translate(detail, 'en')}`],
  [/^没拿到这部片的清单：(.*)$/, (_all, detail) => `Could not get the manifest for this video: ${translate(detail, 'en')}`],
  [/^(.+) 给的媒体清单没通过校验，已换人再要$/, 'The media manifest from $1 failed verification; asking someone else'],
  [/^《(.+)》已全部接收$/, '“$1” has been fully received'],
  [/^已阻止接收文件：(.*)$/, (_all, detail) => `Blocked receiving the file: ${translate(detail, 'en')}`],
  [
    /^视频链接 · 正在解析… · (安全模式 · 扫描后播放|可信房间 · 边下边播|Safe mode · Play after scanning|Trusted room · Progressive playback)$/,
    (_all, mode) => `Video link · Resolving… · ${translate(mode, 'en')}`,
  ],
  [
    /^(.+) · (安全模式 · 扫描后播放|可信房间 · 边下边播|Safe mode · Play after scanning|Trusted room · Progressive playback) · (正在获取清单…|这部片已被拒绝接收|本机磁盘放不下，这一部跳过)$/,
    (_all, size, mode, state) =>
      `${size} · ${translate(mode, 'en')} · ${
        {
          '正在获取清单…': 'Fetching the manifest…',
          '这部片已被拒绝接收': 'This video was refused',
          '本机磁盘放不下，这一部跳过': "Doesn't fit on this computer's disk; skipped here",
        }[state]
      }`,
  ],
  [
    /^(.+) 用的是旧版 NoxReel（0\.6\.x），和 0\.7 不互通，已断开。请让对方升级到 0\.7 再加入。$/,
    '$1 is using an older NoxReel (0.6.x), which cannot connect to 0.7, and was disconnected. Ask them to upgrade to 0.7 and join again.',
  ],
  [
    /^(.+) 用的是更新版本的 NoxReel，和本机不互通，已断开。请先升级本机的 NoxReel。$/,
    '$1 is using a newer NoxReel that cannot connect to this one, and was disconnected. Upgrade NoxReel on this computer first.',
  ],
  [
    /^没法接收《(.+)》：磁盘空间不够：这部片子需要 ([\d.]+)GB，缓存所在的磁盘只剩 ([\d.]+)GB$/,
    'Cannot receive “$1”: not enough disk space. It needs $2 GB, but the cache disk has only $3 GB free',
  ],
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
  [/^(.*)\n\n如果对方没有部署信令服务器，让他改用「极简模式」生成邀请码 —— 那个不需要服务器。$/, '$1\n\nIf the other person has no signaling server, ask them to use Manual mode, which requires no server.'],
  [/^房间使用(.+)，你的本机设置是(.+)。请先在设置中切换为相同模式，再重新粘贴邀请码。$/, 'The room uses $1, while your local setting is $2. Select the same mode in Settings, then paste the invite code again.'],
  [/^(.+) 加入了房间$/, '$1 joined the room'],
  [/^(.+) 离开了房间$/, '$1 left the room'],
  // 未读条数和限速倒计时是动态的，单复数得跟着变
  [/^↓ (\d+) 条新消息$/, (_all, n) => `↓ ${n} new message${n === '1' ? '' : 's'}`],
  [
    /^发得太快了（(\d+) 秒后再试）$/,
    (_all, n) => `Too many messages — try again in ${n} second${n === '1' ? '' : 's'}`,
  ],
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
  [/^这个视频链接在你的电脑上无法解析：(.*)$/, (_all, detail) => `This video link could not be parsed on your computer: ${translate(detail, 'en')}`],
  [/^本机解析失败，改用房主提供的临时播放地址：(.*)$/, (_all, detail) => `Local parsing failed; using the host's temporary stream URL: ${translate(detail, 'en')}`],
  [/^已和 (.+) 完成(.+)握手$/, 'Completed $2 handshake with $1'],
  [/^(.+)的缓冲跟不上了，全员暂停等待$/, '$1 is buffering; pausing everyone'],
  [/^等待 (.+) 缓冲…$/, 'Waiting for $1 to buffer…'],
  [/^你缓冲够了$/, 'Your buffer has recovered'],
  [/^(.+)缓冲够了$/, '$1 has enough buffer'],
  // 自己的操作要排在通用那条前面，否则「你」会被当成别人的昵称原样留下来
  [
    /^你 (播放|暂停|跳转) @ (.+)（只影响你自己）$/,
    (_all, action, position) =>
      `You ${{ 播放: 'played', 暂停: 'paused', 跳转: 'seeked' }[action]} @ ${position} (affects only you)`,
  ],
  [
    /^你 (播放|暂停|跳转) @ (.+)$/,
    (_all, action, position) => `You ${{ 播放: 'played', 暂停: 'paused', 跳转: 'seeked' }[action]} @ ${position}`,
  ],
  [/^(.+) (播放|暂停|跳转) @ (.+)$/, (_all, name, action, position) => `${name} ${{ 播放: 'played', 暂停: 'paused', 跳转: 'seeked' }[action]} @ ${position}`],
  [/^已拒绝不安全的媒体清单：(.*)$/, (_all, detail) => `Rejected an unsafe media manifest: ${translate(detail, 'en')}`],
  [/^开始接收：(.*)（(.*)，(\d+) 片）$/, 'Receiving: $1 ($2, $3 chunks)'],
  [/^分片 (\d+) 校验未通过（(.*)），已丢弃重下$/, 'Chunk $1 failed verification ($2) and will be downloaded again'],
  [/^已断开身份校验失败的成员：(.*)$/, 'Disconnected member after identity verification failed: $1'],
  [/^(.+) 的模式是(.+)，本房间是(.+)，已在传输媒体前断开。$/, '$1 uses $2 while this room uses $3. Disconnected before media transfer.'],
  [/^已阻止打开接收文件：(.*)$/, (_all, detail) => `Blocked the received file: ${translate(detail, 'en')}`],
  [/^启动 mpv 失败：(.*)$/, (_all, detail) => `Failed to start mpv: ${translate(detail, 'en')}`],
  // 可切换播放器：文案里的 X 是播放器名（mpv / PotPlayer / MPC-BE），名字本身不翻译。
  // 这几条必须排在上面那条 mpv 专用的后面，否则「启动 mpv 失败」会被通用式先吃掉。
  [/^(.+) 已启动（先暂停着，等所有人就绪）$/, '$1 started and is paused while everyone gets ready'],
  [/^启动 (.+) 失败：(.*)$/, (_all, name, detail) => `Failed to start ${name}: ${translate(detail, 'en')}`],
  [/^没找到 (.+)，可以在控制条里指定它的路径$/, '$1 was not found. You can set its path from the control bar.'],
  [/^(.+) 以管理员身份运行，NoxReel 遥控不了它$/, '$1 runs as administrator, so NoxReel cannot control it'],
  [/^(.+) 打不开需要请求头的链接$/, '$1 cannot open a link that needs request headers'],
  [/^(.+) 脱离了遥控，请关掉它再重开$/, '$1 is no longer under remote control — close it and open it again'],
  [/^(.+) 脱离了遥控$/, '$1 is no longer under remote control'],
  [/^(.+) 不再应答遥控$/, '$1 stopped answering remote control'],
  [/^有人在 (.+) 里打开了别的文件$/, 'Someone opened a different file in $1'],
  // 运行期出错后自动退回 mpv：前半段自己还要再翻一道
  [/^(.+)，正在退回 mpv$/, (_all, head) => `${translate(head, 'en')} — falling back to mpv`],
  [/^退回 mpv 失败：(.*)$/, (_all, detail) => `Could not fall back to mpv: ${translate(detail, 'en')}`],
  [/^你在 (.+) 里打开了别的文件，这边已经不跟着它同步了$/, 'You opened another file in $1, so this room no longer follows it'],
  [/^播放器 (.+) 报错：(.*)$/, (_all, name, detail) => `Player ${name} error: ${translate(detail, 'en')}`],
  // 主进程适配器报上来的错误正文。它们会被上面那条「播放器 X 报错：…」按 detail 再翻一道，
  // 没有这几条的话英文界面上会原样蹦出一句中文。
  [/^有人在 (.+) 里打开了别的文件，已暂停$/, 'Someone opened a different file in $1, so playback is paused'],
  [
    /^(.+) 不再响应遥控（可能是被资源管理器转发启动的）。已退回 mpv$/,
    '$1 stopped answering remote control (it was probably launched through Explorer). Falling back to mpv.',
  ],
  [/^(.+) 没有应答$/, '$1 is not answering'],
  [/^(.+) 断开了遥控连接$/, '$1 closed the remote-control connection'],
  [
    /^当前实际使用：(.+)（原因：(.+)）$/,
    (_all, name, reason) => `Actually using ${name} (reason: ${translate(reason, 'en')})`,
  ],
  [/^已收完 · 切换到 (.+)$/, 'Fully received · switch to $1'],
  [/^切换播放器失败：(.*)$/, (_all, detail) => `Could not switch player: ${translate(detail, 'en')}`],
  [/^指定播放器路径失败：(.*)$/, (_all, detail) => `Could not set the player path: ${translate(detail, 'en')}`],
  [/^已指定 (.+) 的路径$/, 'Path set for $1'],
  // 下拉框里那一项：「PotPlayer（未找到）」。原因是枚举出来的那几个，不会误伤别的括号文案。
  [
    /^(.+)（(未找到|桥接程序未构建|只支持 Windows|这一部还没收完|在线链接只用 mpv 播放|不可用)）$/,
    (_all, name, reason) => `${name} (${translate(reason, 'en')})`,
  ],
  [/^当前 (\d+) \/ (\d+) 人（包含房主）$/, '$1 / $2 people, including the host'],
  [/^当前已有 (\d+) 人，人数上限不能低于当前人数。$/, 'There are already $1 people; capacity cannot be lower than the current count.'],
  [/^完整短码共 (\d+) 字符，可重复使用。房间会一直开着直到你离开。$/, 'Complete code: $1 characters. It can be reused while the room remains open.'],
  [/^房间已开：(.*)$/, 'Room opened: $1'],
  [/^房间已满（(\d+) 人）。请先调高人数上限。$/, 'The room is full ($1 people). Increase the capacity first.'],
  [/^完整邀请码共 (\d+) 字符；在对方真正连上前，不会计入成员列表。$/, 'Complete invite code: $1 characters. The member is not counted until the connection succeeds.'],
  [/^已生成可点击的邀请链接；压缩握手数据 (\d+) 字符。在对方真正连上前，不会计入成员列表。$/, 'Clickable invite created; compressed handshake data: $1 characters. The member is not counted until connected.'],
  [/^对方选择的是(.+)，本房间是(.+)。双方需分别选择相同模式。$/, 'The other member selected $1 while this room uses $2. Both sides must select the same mode.'],
  [/^(.+) 已连上 ✓$/, '$1 connected ✓'],
  [/^视频链接 · (.+) · (安全模式 · 扫描后播放|可信房间 · 边下边播|Safe mode · Play after scanning|Trusted room · Progressive playback) · 每位成员从原网站播放$/, (_all, detail, mode) => `Video link · ${detail} · ${translate(mode, 'en')} · Each member streams from the original site`],
  [/^(.+) · (\d+) 片 × (.+) · (安全模式 · 扫描后播放|可信房间 · 边下边播|Safe mode · Play after scanning|Trusted room · Progressive playback) · (你是片源|接收中)$/, (_all, size, chunks, chunkSize, mode, state) => `${size} · ${chunks} chunks × ${chunkSize} · ${translate(mode, 'en')} · ${state === '你是片源' ? 'You are the source' : 'Receiving'}`],
  [/^(\d+(?:\.\d+)?)%（(\d+)\/(\d+) 片）$/, '$1% ($2/$3 chunks)'],
  [/^(\d+) 片$/, '$1 chunks'],
  [/^持有 (\d+)% · 延迟 (.+) · 收片 (.+)$/, 'Has $1% · Latency $2 · Receiving $3'],
  [/^收完才播 · 预计还需 (.+)$/, 'Plays after full receipt · about $1 left'],
  [/^按现在的速度约 (.+) 后会卡$/, 'Will stall in about $1 at the current speed'],
  [
    /^再缓冲 (.+) 可一路看完，届时手上有 (.+) 的画面$/,
    'Buffer for another $1 to play through without stalling; you will then hold $2 of video',
  ],
  // 成员列表里这一句是拼出来的，前半段自己还要再翻一道
  [/^(.+) · 再缓冲 (.+) 可看完$/, (_all, head, wait) => `${translate(head, 'en')} · buffer ${wait} more to play through`],
  [/^(\d+) 人按现在的速度会卡$/, '$1 viewer(s) will stall at the current speed'],
  [/^(\d+) 人余量很薄$/, '$1 viewer(s) have a thin margin'],
  [/^(\d+) 人$/, '$1 viewer(s)'],
  [/^(.+)（人数上限 (\d+) 人，除你之外 (\d+) 人同时接收）$/, '$1 (capacity $2; $3 viewer(s) besides you receiving at once)'],
  [/^按这个码率，你的上行最多能同时供 (\d+) 人流畅边下边播。$/, 'At this bitrate, your uplink can smoothly serve at most $1 viewer(s) at once.'],
  [/^上行带宽没测出来，跳过卡顿预判：(.+)$/, 'Could not measure uplink bandwidth; skipping the stall check: $1'],
  [/^延迟 (.+) · P2P 媒体速度 —（各自读取原网站）$/, 'Latency $1 · P2P media rate — (each member streams from source)'],
  // 名单里可能混着我们自己的「你」这个标记，它要翻，别人的昵称一个字都不能动。
  // 顺带把中文顿号换成英文逗号 —— 整句都英文了，分隔符还是顿号会很刺眼。
  [
    /^全员暂停中 —— 在等 (.+) 把缓冲攒够，约 (.+)$/,
    (_all, who, eta) => `Paused for everyone — waiting for ${joinWaiting(who)} to buffer, about ${eta}`,
  ],
  [
    /^全员暂停中 —— 在等 (.+) 把缓冲攒够$/,
    (_all, who) => `Paused for everyone — waiting for ${joinWaiting(who)} to buffer`,
  ],
  [/^缓冲还不够，约 (.+) 后自动继续$/, 'Not enough buffer yet — resuming automatically in about $1'],
  [/^启动失败：(.+)$/, 'Startup failed: $1'],
  [
    /^这些 TURN 地址认不出来：(.+)。地址要形如 turn:example\.com:3478$/,
    'These TURN addresses could not be understood: $1. An address looks like turn:example.com:3478',
  ],
  [/^当前版本 (.+)$/, 'Current version $1'],
  [/^本次会话 (.+) · 上次退出没清掉 (.+)$/, 'This session $1 · $2 left over from last exit'],
  [/^本次会话 (.+)$/, 'This session $1'],
  [/^统计不出来：(.+)$/, 'Could not measure: $1'],
  [/^换不了：(.+)$/, 'Could not change it: $1'],
  [/^清不掉：(.+)$/, 'Could not clean up: $1'],
  [/^缓存目录已改到 (.+)$/, 'Cache directory moved to $1'],
  [/^清掉了 (\d+) 处残留缓存$/, 'Cleaned up $1 leftover cache director(ies)'],
  [
    /^你配置的 (.+) 这次用不了（(.+)），已临时用回系统临时目录。$/,
    'The directory you configured ($1) is unavailable this time ($2); the system temp directory is being used instead.',
  ],
  [/^正在放映时不能换缓存目录，退出房间后再改$/, 'The cache directory cannot change during a screening; leave the room first'],
  [/^还有临时文件没回收，退出房间后再改$/, 'Temporary files are still in use; leave the room first'],
  [/^正在转封装或精简，完成后再换缓存目录$/, 'A remux or slim job is running; change the cache directory after it finishes'],
  [
    /^本机在对称 NAT 后面（几台 STUN 服务器各看到一个不同的公网端口）—— 这种网络打洞必定失败，只能走 TURN 中继。请在设置里配一个。$/,
    'This machine is behind a symmetric NAT (several STUN servers each saw a different public port). Hole punching always fails on such a network — only a TURN relay works. Configure one in Settings.',
  ],
  [
    /^本机的公网出口地址随目标而变（多出口的 NAT 网关，云主机上常见）—— 这种网络打洞必定失败，只能走 TURN 中继。请在设置里配一个。$/,
    'This machine’s public egress address changes per destination (a multi-exit NAT gateway, common on cloud hosts). Hole punching always fails on such a network — only a TURN relay works. Configure one in Settings.',
  ],
  [/^TURN 中继 (.+) 拒绝了用户名或密码 —— 请核对设置里的 TURN 凭据。$/, 'The TURN relay $1 rejected the username or password — check the TURN credentials in Settings.'],
  [/^连不上 TURN 中继 (.+) —— 地址或端口可能写错了，也可能被防火墙挡住。$/, 'Cannot reach the TURN relay $1 — the address or port may be wrong, or a firewall is blocking it.'],
  [/^TURN 中继 (.+) 要求改用另一个地址，当前这条可能已经迁移。$/, 'The TURN relay $1 asked for a different address; this one may have moved.'],
  [/^TURN 中继 (.+) 报错（(.+)）。$/, 'The TURN relay $1 reported an error ($2).'],
  [/^STUN 服务器 (.+) 没能应答 —— 换一台，或检查防火墙有没有放行 UDP。$/, 'The STUN server $1 did not answer — try another one, or check whether the firewall allows UDP.'],
  [/^诊断：(.+)$/, (_all, detail) => `Diagnosis: ${translate(detail, 'en')}`],
  // IP 隐私：隐藏我的 IP、Cloudflare TURN（0.7.6）
  [
    /^本月 Cloudflare TURN 用量已到你设的上限（(.+) GB），为免扣费已停用；下个月 1 日自动恢复，或者在设置里调高上限(。「隐藏我的 IP」开着，没有中继就不连接。)?$/,
    (_all, gb, relayOnly) =>
      `This month’s Cloudflare TURN usage has reached your limit (${gb} GB) and was turned off to avoid charges; it comes back on the 1st of next month, or raise the limit in Settings${
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
  [
    /^本月 Cloudflare TURN 用量已超过你设的上限的 80%（([\d.]+) \/ (\d+) GB）$/,
    'This month’s Cloudflare TURN usage is past 80% of your limit ($1 / $2 GB)',
  ],
  [/^本月已用 ([\d.]+) GB \/ (\d+) GB$/, 'Used this month: $1 GB / $2 GB'],
  [/^没保存：(.+)$/, (_all, detail) => `Not saved: ${translate(detail, 'en')}`],
  [/^没清掉：(.+)$/, 'Could not clear: $1'],
  [/^Cloudflare TURN 月上限没改成：(.+)$/, (_all, detail) => `The Cloudflare TURN monthly limit was not changed: ${translate(detail, 'en')}`],
  [
    /^这些 TURN 地址用的是 53 端口，浏览器会拦下这个端口：(.+)。换一个端口，常见的是 3478 或 443$/,
    'These TURN addresses use port 53, which the browser blocks: $1. Use another port—3478 or 443 are common',
  ],
  [/^运行环境检查失败：(.+)$/, 'Environment check failed: $1'],
  [/^缓存目录准备失败：(.+)$/, 'Could not prepare the cache directory: $1'],
  [/^播放器已关闭（code (.+)），可在房间里重新打开$/, 'Player closed (code $1). You can reopen it from the room.'],
  [/^mpv 错误：(.*)$/, (_all, detail) => `mpv error: ${translate(detail, 'en')}`],
  [/^信令地址无效：(.*)$/, 'Invalid signaling URL: $1'],
  [/^连不上信令服务器：(.*)$/, 'Cannot connect to signaling server: $1'],
  [/^无法解析这个视频链接(?:：(.*))?$/, 'Unable to parse this video URL$1'],
  [/^(.+) 索引已在文件头，可直接边下边播$/, '$1 index is at the beginning and supports progressive playback'],
  [/^(.+) 的 moov 索引在文件末尾，顺序下载时要等整个文件下完才能起播。转封装把索引挪到开头即可，无损且不重编码。$/, '$1 has its moov index at the end, so sequential download cannot start early. Remuxing moves it to the beginning without re-encoding or quality loss.'],
  [/^没找到 ffmpeg。请安装后重试（(.*)），或设置环境变量 (.*)$/, 'ffmpeg was not found. Install it ($1) or set $2.'],
  [/^没找到 mpv。请安装后重试（(.*)），或设置环境变量 (.*)$/, 'mpv was not found. Install it ($1) or set $2.'],
  [/^没找到 yt-dlp，无法解析视频网页。请重新安装完整版本，或设置 (.*)。$/, 'yt-dlp was not found, so video pages cannot be parsed. Reinstall the full build or set $1.'],
  [/^安全扫描失败（代码 (.+)）$/, 'Security scan failed (code $1)'],
  [/^安全扫描超过 (\d+) 分钟仍未完成$/, 'The security scan did not finish within $1 minutes'],
  [/^文件已接收，正在进行安全扫描… 已用 (.+)$/, 'File received. Running a security scan… $1 elapsed'],
  // 「没扫完」的两句：和上面「扫描器不可用」的两句同构，前半段同样要再翻一道并削掉句号
  [
    /^(.*)。可信房间不因此中断播放，但这份文件没有扫完 —— 可以点「重新扫描」再来一遍。$/,
    (_all, detail) =>
      `${trimEnd(translate(detail, 'en'))}. The trusted room keeps playing, but this file was not fully scanned — use "Scan again" to retry.`,
  ],
  [
    /^(.*)。安全模式必须扫过才放行，先不打开播放器；文件还在，可以点「重新扫描」再来一遍。$/,
    (_all, detail) =>
      `${trimEnd(translate(detail, 'en'))}. Safe mode plays a file only after it is scanned, so the player stays closed; the file is still here — use "Scan again" to retry.`,
  ],
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
  [/^读取分片 (.*) 短读$/, 'Short read while reading chunk $1'],
  // 房间页重排（0.7.1）。放在最后：「持有 N% · 延迟 X」要排在上面三段式那条后面，不然会把它吞掉
  [/^还能再来 (\d+) 人$/, (_all, n) => `Room for ${n} more`],
  [/^没能生成邀请链接：(.+)$/, 'Could not create the invite link: $1'],
  [/^生成邀请链接失败：(.+)$/, 'Failed to create the invite link: $1'],
  [
    /^(已连接|等人加入) · (可信房间|安全模式) · (\d+) \/ (\d+) 人$/,
    (_all, state, mode, n, max) =>
      `${state === '已连接' ? 'Connected' : 'Waiting for people'} · ${mode === '可信房间' ? 'Trusted room' : 'Safe mode'} · ${n} / ${max} people`,
  ],
  [/^第 (\d+) \/ (\d+) 部$/, 'Item $1 of $2'],
  [/^播放到 (.+)$/, 'Playing at $1'],
  [/^不用等还能放 (.+)$/, '$1 playable without waiting'],
  [/^从当前位置可连续播放 (.+)$/, 'Continuous from here: $1'],
  [/^已收到 ([\d.]+)%（(\d+)\/(\d+) 片）$/, 'Received $1% ($2/$3 chunks)'],
  [/^已收 (\d+)%$/, 'Received $1%'],
  [/^未就绪 · (.+)$/, (_all, rest) => `Not ready · ${translate(rest, 'en')}`],
  [/^持有 (\d+)% · 延迟 (.+)$/, 'Has $1% · Latency $2'],
  [/^延迟 (.+)$/, 'Latency $1'],
  [/^片子码率 (.+)$/, 'Video bitrate $1'],
  [/^正在给 (\d+) 人供片$/, (_all, n) => `Seeding to ${n} ${n === '1' ? 'person' : 'people'}`],
  [/^下行是码率的 ([\d.]+) 倍，够用$/, 'Download is $1× the bitrate, plenty'],
  // 更多格式与外挂字幕（0.7.3）
  [/^不支持这种视频格式：(.+)$/, 'This video format is not supported: $1'],
  [
    /^(.+) 要先无损封成 MKV 才能传：只换容器、不重新编码，画质音质都不变。$/,
    '$1 has to be packed losslessly into MKV before it can be sent: only the container changes, nothing is re-encoded, picture and sound stay identical.',
  ],
  [
    /^(.+) 要先无损封成 MKV 才能传，这一步需要 ffmpeg，但没找到。装上 ffmpeg 后重试。$/,
    '$1 has to be packed losslessly into MKV before it can be sent, which needs ffmpeg, and ffmpeg was not found. Install ffmpeg and try again.',
  ],
  [
    /^片子旁边有 (\d+) 个外挂字幕，但封进片子需要 ffmpeg，这次先不带字幕。$/,
    (_all, n) =>
      `Found ${n} external subtitle file${n === '1' ? '' : 's'} next to the video, but packing ${n === '1' ? 'it' : 'them'} in needs ffmpeg, so this time the video goes without them.`,
  ],
  // 带体积对比的那条必须排在上面，理由同「已精简到」
  [/^已封成 MKV：(.*)，体积 (.*) → (.*)$/, 'Packed into MKV: $1 — size $2 → $3'],
  [/^已封成 MKV：(.*)$/, 'Packed into MKV: $1'],
  [
    /^已把 (\d+) 条外挂字幕封进片子$/,
    (_all, n) => `Packed ${n} external subtitle${n === '1' ? '' : 's'} into the video`,
  ],
  [
    /^片子里有 (\d+) 条字幕 MKV 装不下，已略过（(.+)）$/,
    (_all, n, codecs) => `${n} subtitle track${n === '1' ? '' : 's'} in the video cannot go into MKV and ${n === '1' ? 'was' : 'were'} skipped (${codecs})`,
  ],
  [/^字幕 (.+) 用不了：(.+)$/, (_all, name, reason) => `Subtitle ${name} cannot be used: ${translate(reason, 'en')}`],
  [/^一部片最多封 (\d+) 条外挂字幕$/, 'At most $1 external subtitles can be packed into one video'],
  // 房间链接、Discord 状态（0.7.4）
  [
    /^连不上公共中继（(.+)），改用一对一邀请$/,
    (_all, why) => `Could not reach public relays (${translate(why, 'en')}); using a one-to-one invite instead`,
  ],
  [
    /^连不上公共中继（(.+)），先用一对一邀请：一条链接只给一个人。$/,
    (_all, why) => `Could not reach public relays (${translate(why, 'en')}), so here is a one-to-one invite: one link per person.`,
  ],
  [/^换链接失败：(.+)$/, (_all, why) => `Could not replace the link: ${translate(why, 'en')}`],
  [
    /^房间使用(.+)，你的本机设置是(.+)。请先在设置中切换为相同模式，再重新打开房间链接。$/,
    'The room uses $1, while your local setting is $2. Select the same mode in Settings, then open the room link again.',
  ],
  [/^房间已满（上限 (\d+) 人）$/, 'The room is full (limit $1)'],
  [
    /^这些中继地址认不出来：(.+)。地址要形如 wss:\/\/relay\.example\.com$/,
    'These relay addresses are not recognised: $1. Use the form wss://relay.example.com',
  ],
  [/^在看《(.+)》$/, 'Watching “$1”'],
  [/^房间 (\d+)\/(\d+) 人$/, 'Room $1/$2'],
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

// 带这个属性的元素连同整棵子树都不参与自动翻译。昵称、片名、聊天这类用户输入必须原样显示，
// 否则昵称叫「播放」的人会被翻成 Play。
export const SKIP_ATTR = 'data-i18n-skip';
const SKIP_SELECTOR = `[${SKIP_ATTR}]`;

// 元素看它自己，文本节点看所在的元素；祖先链上任何一层带标记都算跳过。
export function isSkipped(node) {
  if (!node) return false;
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return !!element?.closest?.(SKIP_SELECTOR);
}

// TreeWalker 的过滤器：遇到带标记的元素返回 FILTER_REJECT，整棵子树（含文本节点）都不会被遍历到。
function skipFilter(node) {
  return node.nodeType === Node.ELEMENT_NODE && node.hasAttribute?.(SKIP_ATTR)
    ? NodeFilter.FILTER_REJECT
    : NodeFilter.FILTER_ACCEPT;
}

function translateElement(element) {
  if (isSkipped(element)) return;
  for (const attr of ['placeholder', 'title', 'aria-label']) {
    if (element.hasAttribute?.(attr)) element.setAttribute(attr, translate(element.getAttribute(attr)));
  }
}

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
  if (root.nodeType === Node.ELEMENT_NODE) {
    // TreeWalker 不会把根交给过滤器，根自己带标记或落在被跳过的子树里时得先挡掉。
    if (isSkipped(root)) return;
    translateElement(root);
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, skipFilter);
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
      // 新增节点和文本改动都经 translateTree，带 data-i18n-skip 的子树在那里统一挡掉。
      if (mutation.type === 'characterData') translateTree(mutation.target);
      for (const node of mutation.addedNodes) translateTree(node);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}
