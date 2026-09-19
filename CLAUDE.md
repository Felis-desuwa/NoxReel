# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

NoxReel 是一个 P2P 同步观影软件：一个人有片子，其他人通过 P2P 分片接收。安全模式默认完整接收、校验并通过本机安全扫描后播放；可信房间需双方分别启用，允许片头就绪后边接收边播放。Electron + WebRTC，不自研播放器/编解码器，靠外部的 mpv 和 ffmpeg；播放器可在房间内切到本机装的 PotPlayer / MPC-BE（经 `NoxReelPlayerBridge.exe` 遥控，只接手已收完的文件）。

## 常用命令

```bash
npm start          # 启动客户端（= electron .）
npm run signal     # 启动信令服务器（node signaling-server/server.js，默认 :8080）
npm run dist       # 打包 Windows 安装包（electron-builder → NSIS）
npm test           # Node 自动测试（传输、安全、缓存、邀请码、房间容量）
```

- Windows 上双击 `NoxReel.exe`（客户端）/ `NoxReel-Signal.exe`（服务器）会自动装依赖、修复 Electron 本体、检查 mpv 再启动；启动器由 `npm run build:launcher` 生成并嵌入品牌图标，不再使用 BAT。
- 信令服务器环境变量：`PORT`、`BLOCKED_COUNTRIES`、`ALLOW_UNKNOWN`、`MAXMIND_DB`、`TRUST_PROXY`。例：`BLOCKED_COUNTRIES=CN ALLOW_UNKNOWN=0 MAXMIND_DB=./GeoLite2-Country.mmdb npm run signal`。
- 调试用环境变量：`SYNCWATCH_SKIP_GEO=1` 跳过地区探测；`SYNCWATCH_MPV_PATH` / `SYNCWATCH_FFMPEG_PATH` 手动指定外部程序路径。

仓库内的测试位于 `test/`。改动核心连接、播放器或原生桥接逻辑后，除运行 `npm test` 外仍需起两个实例做端到端验证；Android 端还需单独验证 WebView 与 ExoPlayer。

**测试和任何复现脚本都必须静音，不许发出声音**（机器常在无人值守时跑测试）：起实例带 `NOXREEL_TEST_MUTE=1`；脚本里直接拉起 mpv 时必须带 `--mute=yes` 或 `--ao=null`（经 `players.launch` / `MpvController.launch` 就传 `muted: true`）；不要启动 PotPlayer、MPC-BE 等外部播放器（它们的静音会写进注册表，需要先征得同意）；也别触发 `alert()` 之类会响提示音的东西。

## 进程边界（改代码前必须先搞清楚东西该放哪）

严格的两进程分工，跨界只能走 IPC，**不引任何原生模块**：

- **主进程 `src/main/`**（Node 能力）：文件 IO、分片/哈希、mpv 子进程与管道、ffmpeg、地区探测、外部程序探测。
- **渲染进程 `src/renderer/`**（Chromium 能力）：WebRTC（用 Chromium 自带实现，不接 libwebrtc）、调度、同步、UI。
- `src/main/preload.js` 是唯一通道（`contextIsolation` 开启），渲染进程只能用 `window.sw.*` 暴露的方法。新增跨界能力必须同时改 `main.js`（`ipcMain.handle`）和 `preload.js`。

分片数据流：`磁盘 →IPC→ 渲染进程 →DataChannel→ 对端 →IPC→ 磁盘`。2MB 的 Buffer 走 IPC 是有意的取舍——换来整个 P2P 层零原生依赖。注意 `store:readChunk` 返回的是 `ArrayBuffer`（避免 Buffer 被序列化成 `{type:'Buffer',...}`）。

## 核心设计（跨多个文件才能理解的「大图景」）

这几条是整个产品的支点，改动前务必理解，否则很容易破坏不变量：

1. **两条水位线：完整度 `contiguousBytes` 与可播长度 `runBytes`**（`fileStore.js` / `swarm.js`）。接收方预分配等大稀疏文件，按偏移写分片。`contiguousBytes` 是从**文件头**起连续已收的字节，只代表**完整度**：进度条、完整性判断、安全模式「收完并通过扫描才把路径交给播放器」都用它。`runBytes` 是从**当前播放位置**起连续已收的字节（桌面 `swarm.runEndFrom()`，安卓同一算法在 `Store.kt` 的 `readableFrom()`），代表**播放器现在还能安全读多远**：卡顿判定、起播门槛、卡顿预判都用它。从片头起播时两者等价，**中途加入房间时它们相差整整一部片**——把它们混为一谈，晚到的人会误判自己在卡，把全房拖停一整个下载周期。可信房间的起播门槛因此是两条同时成立：「文件头 ≥ 8 MB（容器索引）」**且**「从起播点起连续数据够放 15 秒」。

2. **播放位置优先调度，不是 rarest-first**（`scheduler.js`）。标准 BT 优先下最稀有的片；这里反过来：当前播放位置 + 未来 30 秒的窗口最优先，窗口外顺序补齐，播放位置之前的片排最后（回拖才用）。牺牲 swarm 健康度换「点开就能看」。队列前面还有两个保留区：**文件头 8 MB**（MP4 的 moov、MKV 的 EBML+Tracks，缺了播放器连格式都认不出来，直接退出）和 **文件尾 4 MB**（MKV 的 Cues 常写在尾部；mpv 缺了它会退化成全文件扫描建索引、起播晚约 2 秒，ExoPlayer 更硬——它在 prepare 完成**之前**就要 seek 到 Cues，读不到就永远起不来）。**文件尾保留区的判据是反着的：只有按内容确认过是 faststart MP4（索引在文件头）才不预留**，`scheduler.setHeadBytes()` 拿第 0 片认容器（EBML 魔数 / ftyp+moov），认不出来就保守预留——扩展名不作数，MKV 改名成 `.mp4` 一样会让安卓永远起不来，多留 4 MB 则毫无代价。除这两个保留区外，播放位置之前的片仍排在最后。

3. **全员暂停联动**（`syncEngine.js`）——本产品与「Syncplay + 网盘」的核心差异。每人算 `runBytes`（从自己的播放字节位置起连续已收的字节，**不是**从文件头起的 `contiguousBytes`），低于 5 秒余量广播 `stall` 全员暂停，攒够 15 秒才解除（两阈值拉开是为滞回，避免临界点横跳）。**余量必须盖住解复用器的预读**——实测 mpv 的 `demuxer-cache-time` 常年领先 `time-pos` 约 1.7 秒；而数据在连续区尽头断掉时 mpv 不是卡住而是报 EOF（`--keep-open` 下停在最后一帧并把 `eof` 报上来），会被误判成「这一部放完了」直接跳下一部，所以 `onMpvTick` 的 eof 分支必须先确认手上真有一路连到文件尾的数据。这道守卫有两条不能漏的配套：① 它必须排在 `_evaluateStall` **前面**，否则「解除卡顿」和「重新置上卡顿」在同一条 tick 里互相打架，每条 eof tick 发一对 STALL，全房按 IPC 的速度反复暂停/播放；② 解除这种卡顿时必须**让播放器重新解复用一次**（`_reconcile({ seekTo, force: true })`，往回跳 0.5 秒）——mpv 停在 eof 那一帧上，只收到 `setPause(false)` 是不会回头去读新落盘的分片的。**stall 评估有两个驱动源**：`onMpvTick`（播放器属性变化）和 `onBufferProgress`（下载进度）。后者不可省——全员暂停后 mpv 静止不再推 tick，只剩下载进度这条路能把「缓冲攒够了」告诉引擎，否则会死锁。

4. **MP4 的 moov 位置检测**（`media.js`）。规格没提但很关键：大多数编码器把 MP4 索引 moov 写在文件末尾，播放器读不到它一帧都解不了——顺序下载就得等整个文件下完才起播，边下边播失效。`inspectMp4Faststart()` 纯 Node 解析顶层 box 看 moov/mdat 谁先出现，moov 在后就提示转封装（`-c copy -movflags +faststart`，无损）。此检测是必查项，**不依赖 ffprobe**（用户可能没装 ffmpeg）。`.mov`/`.m4v` 与 `.mp4` 是同一容器（ISOBMFF），一视同仁；MKV 是流式容器，天生没这问题直接放行。

5. **两条 DataChannel**（`protocol.js` / `peer.js`）：`ctrl`（JSON，握手/清单/位图/请求/同步指令）和 `data`（二进制，只跑分片）。分开是因为控制消息不能被几十 MB 分片堵在队尾——「全员暂停」恰恰在数据通道最满时发出。SCTP 单消息有 64KB 上限，2MB 分片切成 60KB 的帧发送（帧头 12 字节：文件槽位 + 分片下标 + 帧下标）。协议是 v2，**与 0.6.x 不互通**：HELLO 的 `ver` 对不上就断开，邀请码和应答码末尾也带版本号，好在建连前就说清楚是版本问题。

6. **权限：房主 / 管理员 / 游客**（`syncEngine.js`，`ROLE` 消息）。房主（发起放映者）是角色的唯一权威，给每个人分「管理员」或「游客」并 `ROLE` 广播全场。管理员/房主的播放·暂停·跳转同步全员（原有行为）；**游客只能播放/暂停自己这一路——不广播、不影响他人，且不许跳转**；游客的缓冲不足也只暂停自己，不触发全员 stall。三条易踩的不变量：① **hostId 是「谁是房主」的信任锚点**，绝不能默认成自身 peerId（否则不知情的加入者会错认自己是房主、短暂拿到控场权）——房主传自身 id，加入者从邀请码 `payload.from` 拿到，都不知道时传 `null` 先当游客，靠首条 ROLE「首认为准」钉死。② **游客必须在 `roles` 表里显式登记**（而非留作默认），否则无法把「已知游客」和「角色表还没同步到的陌生人」区分开。③ **纵深防御**：除了游客自己不广播，收到 SYNC/STALL 的一方还会忽略「已知是游客」的发送者——改一版客户端也控不了场。UI 侧房主在成员列表切换角色，游客的进度条禁用。

## 两种连接方式（`app.js` 编排）

| | 极简模式 `manual` | 信令服务器 `server` |
|---|---|---|
| 服务器 | 完全不需要 | 只转发 SDP/ICE，不碰视频 |
| 拓扑 | 星型（都只连发起者） | 网状（谁都能给谁供片） |
| ICE | `trickle=false`（等候选集齐，SDP 自包含可粘贴） | `trickle=true` |

两种都不让视频内容经过任何服务器。

**极简模式的 renamePeer 不变量**（`swarm.js`）：发起者生成 offer 时还不知道对面是谁，先用占位 id 建 Peer，拿到应答码才知道真实身份。每个 peer 在 swarm 里有**三张按 peerId 索引的表**（`peers` / `_serving` / `_serveQueue`）加 `inflight` 记录。换 id 必须走 `swarm.renamePeer()` 统一迁移所有表——只改 `peers` 会让发片第一步 `_serveQueue.get(peerId)` 拿到 undefined 静默返回，表现是「连上了、清单也收到了，但进度永远 0%」。这是曾经的真 bug，别退回去。

## 关键约定与陷阱

- **manifest 是接收方唯一真相来源**：`fileId` 由所有分片哈希推导（同内容任何机器得同 id）。**渐进式校验**——每片收到即验 SHA-256，坏片当场丢弃重下，不污染水位线。
- **房间安全模式必须双向一致**：`safe` 是默认值，旧邀请码和缺少模式的 HELLO 也只能解释为 `safe`。邀请码先做本地匹配，P2P 数据通道再以 HELLO 独立协商；双方模式一致前禁止清单、同步控制和媒体帧。`trusted` 允许约 8 MB 连续片头后边下边播，风险更高；文件完整后仍调用 `store:scanReceivedMedia`。**扫描结果分三类，别混为一谈**（`malwareScan.classifyScanResult`）：`blocked`（真发现威胁）一律退出 mpv 并清理缓存；`unavailable`（扫描器根本没跑起来）在安全模式下同样拒播，但在可信房间只警告不中断——那一场本来就是全程无扫描播过来的，扫不成没带来任何新信息，此时杀播放器加删缓存是纯损失。MpCmdRun 的退出码 2 同时表示这两种情况，只能靠输出里的 `CmdTool: Failed with hr = 0x…` 区分；最常见的诱因是 Defender 被第三方杀毒软件（360、火绒之类）接管停用，`env:status` 的 `defenderRunning` 会在启动时就把这件事说出来。
- **中途加入（可信房间）**：加入者按房间当前位置 P 起播，此时 `[8MB, P)` 是空洞。实测（mpv v0.41，faststart MP4 / Cues 在头的 MKV）mpv **根本不读**这段空洞，正常从 P 起播、0 丢帧；所以「播放头之前必须落盘」这条旧不变量不成立，别据此把中途加入判成不安全。真正的约束只有三条：容器头在、MKV 的文件尾 Cues 在、播放头撞到连续区尽头**之前**要先暂停。往回拖进空洞仍会花一帧并跳过几秒，所以跳转到 `runBytes === 0` 的位置要先暂停播放器。安卓侧的同一判据在 `Store.awaitData()`：**pos 所在分片还没收到时绝不能返回 -1**，ExoPlayer 会把它当成文件到头直接进 ENDED。还有一处容易漏：**「是不是中途加入」要看房间播到第几秒，不是看换算出来的字节位置**——房主没装 ffmpeg 时清单里没有时长，码率为 0、字节位置恒为 0，只看它的话整套门槛会静默失效（人以为准备好了，一起播就落在空洞里）。这种算不出字节位置的场次，可信房间不提前起播，等收完再说。
- **`enterRoom()` 有只跑一次的守卫**，但观众是先进房后收清单——片名渲染必须放在独立的 `renderFilmInfo()` 里，不能塞进 `enterRoom`，否则观众永远看不到片名。
- **`fileStore.close()` 的顺序**：先阻止新分片、等待批量写入、关闭文件句柄，再删除软件拥有的会话缓存；不再生成 `.swpart`，也不提供跨重启断点续传。
- **外部程序探测不能只查 PATH**（`findBin.js`）：Windows 上 PATH 是进程启动时的快照，winget 装完的新 PATH 对已开着的进程不生效。探测会额外扫各家包管理器落点 + winget Packages 目录。mpv 的 winget 落点 `MPV Player\mpv.exe` 既不进 PATH 也不叫 mpv，单列在 `mpv.js` 的 `MPV_CANDIDATES`。
- **TURN 默认开但需用户自填地址/凭据**（设置里）——中继消耗真金白银带宽，不内置公共服务器。
- **地区策略是「告知不拦截」**：客户端 `geo.js` 探测到不在设计范围（`OUT_OF_SCOPE`，仅 CN）只弹可关闭提示，任何地区都能正常用。强制拦截机制保留在信令服务器（默认关），且只对信令模式有效（极简模式绕过服务器）。
- **`.bat` 必须纯 ASCII，逻辑放 `.ps1`**：cmd.exe 按 OEM 代码页解析批处理，UTF-8 中文会变乱码被当命令执行。`.ps1` 必须存成 **UTF-8 带 BOM**（Windows PowerShell 5.1 没 BOM 会按 ANSI 读）。
- **界面文案以简体中文为源语言**：桌面端翻译集中在 `src/renderer/lib/i18n.js`，Android 翻译集中在对应 assets 的 `js/i18n.js`；语言保存为 `sw.language`。新增用户可见文案时必须补英文翻译和动态模板测试，协议字段、邀请码和用户输入不得翻译。
- **限制**：接收方只收 MP4/MOV/M4V/MKV，**不限文件大小**，分片 2MB。房主可在 2–16 人范围内设置房间人数。
- **更多格式和外挂字幕都靠「房主本机封成 MKV」**（`media.convert` / `subtitles.js`），不单独传字幕、不放宽接收白名单：`mediaGuard` 里 `SOURCE_EXTENSIONS`（房主能选）比 `ALLOWED_EXTENSIONS`（接收方收）宽，后者**不能跟着放宽** —— 放宽了就要改协议、改安卓，0.7.x 的老客户端也收不了。几个实测踩出来的坑：① `-c copy` 时 `-sub_charenc` 不生效，GBK 字幕会原样拷进 MKV 变乱码，所以编码必须在 Node 里认出来、转成 UTF-8 再交给 ffmpeg（`decodeSubtitle` 在 GB18030/Big5/Shift-JIS 里按常用字打分挑）；② MKV 不收 MP4 的 mov_text（要转 SRT）、数据轨（tmcd 等，带上就整个失败），封面图拷进去会变成一条真视频轨，都得在 `mkvStreamPlan` 里处理；③ MPG/VOB 的包缺时间戳，没有 `-fflags +genpts` 直接报「Can't write packet with unknown timestamp」（小分辨率的测试片一帧一个 PES 包测不出来）；④ RM/RMVB 不收：ffmpeg 的 Matroska 封装器不支持 RealVideo，只能重编码。外挂字幕默认显示第一条勾选的（`-disposition` 按**输出**流下标写），片子原有字幕轨同时取消默认标记，否则播放器照旧选原来那条。
- **不限大小的两个隐藏前提**（改传输协议时别破坏）：① 清单哈希和分片位图都要按 DataChannel 单条 64KB 分段发 —— 位图整张一条发，约 38 万片（约 750GB）就超限，超限的 send() 会让整条通道断掉，表现成莫名掉线；② 接收前查磁盘余量（桌面 `fileStore.ensureFreeSpace`、安卓 `Store.openLeech`），不然 ext4/f2fs 上稀疏文件照样建成功，传到一半才写不进去。
- **卡顿预判**（`lib/stallForecast.js`）：成员接收速度由对方位图随时间的增长算出（信令模式下能从多人收片，本机 upRate 只是其中一份）；「会不会卡」看播放头追上连续水位线之前水位线能否先推到文件尾，速度低于码率但缓冲够的人不报卡。房主选片时的上行带宽来自 `src/main/uplink.js` 往 Cloudflare 测速节点传随机字节，只是预估。
- 注释和用户可见文案一律用简体中文，与现有代码保持一致。
