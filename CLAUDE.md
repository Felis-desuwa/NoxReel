# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

NoxReel 是一个 P2P 同步观影软件：一个人有片子，其他人通过 P2P 分片接收。安全模式默认完整接收、校验并通过本机安全扫描后播放；可信房间需双方分别启用，允许片头就绪后边接收边播放。Electron + WebRTC，不自研播放器/编解码器，靠外部的 mpv 和 ffmpeg。

## 常用命令

```bash
npm start          # 启动客户端（= electron .）
npm run signal     # 启动信令服务器（node signaling-server/server.js，默认 :8080）
npm run dist       # 打包 Windows 安装包（electron-builder → NSIS）
npm test           # Node 自动测试（传输、安全、缓存、邀请码、房间容量）
```

- Windows 上双击 `启动.bat`（客户端）/ `启动信令服务器.bat`（服务器）会自动装依赖、修复 Electron 本体、检查 mpv 再启动。
- 信令服务器环境变量：`PORT`、`BLOCKED_COUNTRIES`、`ALLOW_UNKNOWN`、`MAXMIND_DB`、`TRUST_PROXY`。例：`BLOCKED_COUNTRIES=CN ALLOW_UNKNOWN=0 MAXMIND_DB=./GeoLite2-Country.mmdb npm run signal`。
- 调试用环境变量：`SYNCWATCH_SKIP_GEO=1` 跳过地区探测；`SYNCWATCH_MPV_PATH` / `SYNCWATCH_FFMPEG_PATH` 手动指定外部程序路径。

仓库内的测试位于 `test/`。改动核心连接、播放器或原生桥接逻辑后，除运行 `npm test` 外仍需起两个实例做端到端验证；Android 端还需单独验证 WebView 与 ExoPlayer。

## 进程边界（改代码前必须先搞清楚东西该放哪）

严格的两进程分工，跨界只能走 IPC，**不引任何原生模块**：

- **主进程 `src/main/`**（Node 能力）：文件 IO、分片/哈希、mpv 子进程与管道、ffmpeg、地区探测、外部程序探测。
- **渲染进程 `src/renderer/`**（Chromium 能力）：WebRTC（用 Chromium 自带实现，不接 libwebrtc）、调度、同步、UI。
- `src/main/preload.js` 是唯一通道（`contextIsolation` 开启），渲染进程只能用 `window.sw.*` 暴露的方法。新增跨界能力必须同时改 `main.js`（`ipcMain.handle`）和 `preload.js`。

分片数据流：`磁盘 →IPC→ 渲染进程 →DataChannel→ 对端 →IPC→ 磁盘`。2MB 的 Buffer 走 IPC 是有意的取舍——换来整个 P2P 层零原生依赖。注意 `store:readChunk` 返回的是 `ArrayBuffer`（避免 Buffer 被序列化成 `{type:'Buffer',...}`）。

## 核心设计（跨多个文件才能理解的「大图景」）

这几条是整个产品的支点，改动前务必理解，否则很容易破坏不变量：

1. **连续水位线 `contiguousBytes`，不是下载百分比**（`fileStore.js`）。接收方预分配等大稀疏文件，按偏移写分片。它用于传输进度、调度和完整性判断；安全模式不会在文件完整并通过扫描前把路径交给播放器，可信房间则以约 8 MB 连续片头作为提前起播门槛。

2. **播放位置优先调度，不是 rarest-first**（`scheduler.js`）。标准 BT 优先下最稀有的片；这里反过来：当前播放位置 + 未来 30 秒的窗口最优先，窗口外顺序补齐，播放位置之前的片排最后（回拖才用）。牺牲 swarm 健康度换「点开就能看」。

3. **全员暂停联动**（`syncEngine.js`）——本产品与「Syncplay + 网盘」的核心差异。每人算 `contiguousBytes - 播放字节位置`，低于 5 秒余量广播 `stall` 全员暂停，攒够 15 秒才解除（两阈值拉开是为滞回，避免临界点横跳）。**stall 评估有两个驱动源**：`onMpvTick`（播放器属性变化）和 `onBufferProgress`（下载进度）。后者不可省——全员暂停后 mpv 静止不再推 tick，只剩下载进度这条路能把「缓冲攒够了」告诉引擎，否则会死锁。

4. **MP4 的 moov 位置检测**（`media.js`）。规格没提但很关键：大多数编码器把 MP4 索引 moov 写在文件末尾，播放器读不到它一帧都解不了——顺序下载就得等整个文件下完才起播，边下边播失效。`inspectMp4Faststart()` 纯 Node 解析顶层 box 看 moov/mdat 谁先出现，moov 在后就提示转封装（`-c copy -movflags +faststart`，无损）。此检测是必查项，**不依赖 ffprobe**（用户可能没装 ffmpeg）。`.mov`/`.m4v` 与 `.mp4` 是同一容器（ISOBMFF），一视同仁；MKV 是流式容器，天生没这问题直接放行。

5. **两条 DataChannel**（`protocol.js` / `peer.js`）：`ctrl`（JSON，握手/清单/位图/请求/同步指令）和 `data`（二进制，只跑分片）。分开是因为控制消息不能被几十 MB 分片堵在队尾——「全员暂停」恰恰在数据通道最满时发出。SCTP 单消息有 64KB 上限，2MB 分片切成 60KB 的帧发送（帧头 8 字节：分片下标 + 帧下标）。

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
- **房间安全模式必须双向一致**：`safe` 是默认值，旧邀请码和缺少模式的 HELLO 也只能解释为 `safe`。邀请码先做本地匹配，P2P 数据通道再以 HELLO 独立协商；双方模式一致前禁止清单、同步控制和媒体帧。`trusted` 允许约 8 MB 连续片头后边下边播，风险更高；文件完整后仍调用 `store:scanReceivedMedia`，扫描失败立即退出 mpv 并清理缓存。
- **`enterRoom()` 有只跑一次的守卫**，但观众是先进房后收清单——片名渲染必须放在独立的 `renderFilmInfo()` 里，不能塞进 `enterRoom`，否则观众永远看不到片名。
- **`fileStore.close()` 的顺序**：先阻止新分片、等待批量写入、关闭文件句柄，再删除软件拥有的会话缓存；不再生成 `.swpart`，也不提供跨重启断点续传。
- **外部程序探测不能只查 PATH**（`findBin.js`）：Windows 上 PATH 是进程启动时的快照，winget 装完的新 PATH 对已开着的进程不生效。探测会额外扫各家包管理器落点 + winget Packages 目录。mpv 的 winget 落点 `MPV Player\mpv.exe` 既不进 PATH 也不叫 mpv，单列在 `mpv.js` 的 `MPV_CANDIDATES`。
- **TURN 默认开但需用户自填地址/凭据**（设置里）——中继消耗真金白银带宽，不内置公共服务器。
- **地区策略是「告知不拦截」**：客户端 `geo.js` 探测到不在设计范围（`OUT_OF_SCOPE`，仅 CN）只弹可关闭提示，任何地区都能正常用。强制拦截机制保留在信令服务器（默认关），且只对信令模式有效（极简模式绕过服务器）。
- **`.bat` 必须纯 ASCII，逻辑放 `.ps1`**：cmd.exe 按 OEM 代码页解析批处理，UTF-8 中文会变乱码被当命令执行。`.ps1` 必须存成 **UTF-8 带 BOM**（Windows PowerShell 5.1 没 BOM 会按 ANSI 读）。
- **界面文案以简体中文为源语言**：桌面端翻译集中在 `src/renderer/lib/i18n.js`，Android 翻译集中在对应 assets 的 `js/i18n.js`；语言保存为 `sw.language`。新增用户可见文案时必须补英文翻译和动态模板测试，协议字段、邀请码和用户输入不得翻译。
- **限制**：仅支持 MP4/MOV/M4V/MKV，10GB 上限，分片 2MB。房主可在 2–16 人范围内设置房间人数。
- 注释和用户可见文案一律用简体中文，与现有代码保持一致。
