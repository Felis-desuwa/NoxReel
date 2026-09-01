<div align="center">
  <p><strong>简体中文</strong> · <a href="README.en.md">English</a></p>
  <img src="assets/branding/noxreel-icon.png" width="120" alt="NoxReel">
  <h1>NoxReel</h1>
  <p><strong>把“我有这部片”，变成“我们现在一起看”。</strong></p>
  <p>深色、轻量的多人同步观影工具。支持本地视频 P2P 分片传输、安全检查与同步播放，也支持视频链接解析。</p>

  <p>
    <img src="https://img.shields.io/badge/version-0.6.5-7C5CFF?style=for-the-badge" alt="Version 0.6.5">
    <img src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4?style=for-the-badge&logo=windows11&logoColor=white" alt="Windows 10/11">
    <img src="https://img.shields.io/badge/Android-Beta-3DDC84?style=for-the-badge&logo=android&logoColor=white" alt="Android Beta">
    <img src="https://img.shields.io/badge/license-MIT-22C55E?style=for-the-badge" alt="MIT License">
  </p>

  <p>
    <a href="https://github.com/Felis-desuwa/NoxReel/releases/latest"><strong>下载最新版</strong></a>
    ·
    <a href="#快速开始">快速开始</a>
    ·
    <a href="https://github.com/Felis-desuwa/NoxReel/issues">反馈问题</a>
  </p>
</div>

<p align="center">
  <img src="src/renderer/assets/home-abyss.webp" width="100%" alt="NoxReel 深空视觉">
</p>

## 为什么是 NoxReel

| 🎞️ 安全接收 | 🔗 链接同步 | 👥 房间协作 |
|:---|:---|:---|
| 默认使用可信房间边下边播；也可切换到安全模式，完整接收并扫描后播放。 | 支持 YouTube、常见视频页面、MP4/HLS；Cloudflare 页面会使用隔离浏览器解析。 | 设置 2–16 人容量，显示成员连接速度与延迟，并自动等待缓冲最慢的人。 |

### 核心体验

- **最大 10 GB**：支持 MP4、MOV、M4V、MKV 本地视频。
- **一键邀请链接**：默认生成可点击的 `noxreel://` 零服务器邀请／应答链接；底层 `NR3` 握手数据更短，并兼容 `NR2`、`SW2`、`SW1`。
- **链接解析回退**：YouTube 使用专用匿名客户端策略；普通解析遇到 Cloudflare 403 时，自动在无权限、无持久化的隔离浏览器中捕获公开媒体流。
- **随时换片**：房主可在房间内切换本地视频或视频链接，成员不用退出重进。
- **缓冲联动**：任何成员可播余量不足时全员暂停，恢复后继续。
- **真实成员状态**：只显示已建立连接的用户，并给出上传、下载速度和延迟。
- **播放器可恢复**：播放器窗口关闭后，可从房间页面重新打开。
- **现代播放器界面**：mpv 使用 NoxReel 深色无边框外观、圆角窗口、底部控制栏与更清晰的进度反馈。
- **原生 EXE 入口**：源码目录直接双击带品牌图标的 `NoxReel.exe`，不再使用 BAT；信令服务对应 `NoxReel-Signal.exe`。
- **自选安装位置**：Windows 完整版和联网版都使用向导式安装，可在安装前选择目标文件夹。
- **Android 链接播放**：桌面房主解析网页后，Android 观众确认来源站点即可同步播放 HTTP、HLS 或 DASH 临时直链。
- **中英双语**：桌面端与 Android 观众端均可在设置中切换简体中文或 English。
- **缓存自动清理**：接收视频和转封装副本只进入系统临时缓存，换片、退房或关闭软件时自动删除；异常残留会在下次启动时回收。
- **双模式安全门槛**：可信房间为默认，约 8 MB 片头就绪后边下边播，完整后仍补做扫描；也可切换安全模式，完整接收并通过 Microsoft Defender 扫描后才播放。
- **模式握手**：邀请码和 P2P 数据通道都会核对房间模式；双方设置不同会在媒体清单、控制消息和视频数据传输前断开。
- **安全桌面外壳**：启用 Electron sandbox、受控 IPC、安全 DOM 渲染和严格的房间角色权限，并使用与主界面统一的深色 Windows 标题栏。

> [!IMPORTANT]
> `v0.6.5` 做了四件事。**传输快了 2.6 倍**：补片原本只靠 250ms 定时器驱动，而 Chromium 会把不可见窗口的定时器节流到 1 秒一次 —— 看片时 mpv 正压在 NoxReel 窗口上，于是吞吐被硬卡在 8 MB/s；现在改成分片一落地就立刻补请求（实测 285.8 MB 从 39 秒降到 15 秒）。**邀请码不再被聊天软件改坏**：旧字母表含 `_`，Discord 的 `__下划线__` 会把它从可复制文本里删掉（实测常见家用机 15%、多网卡机 75% 的码作废），现已换用 markdown 中性的字符集，并且改成能从一段聊天文本里把码提取出来。**新增无损精简**：发片前可丢掉多余音轨与图形字幕，不重编码、画质零损失。**修复安全扫描误报**：Defender 被第三方杀毒软件接管停用时，不再谎报「发现威胁」。

## 下载

| 版本 | 适合谁 | 下载 |
|---|---|---|
| Windows 完整版 | 推荐。内置 mpv 与 yt-dlp，可选择安装文件夹 | [NoxReel-Setup-0.6.5.exe](https://github.com/Felis-desuwa/NoxReel/releases/latest/download/NoxReel-Setup-0.6.5.exe) |
| Windows 联网版 | 安装器体积小，可选择安装文件夹，安装时下载应用组件 | [NoxReel-WebSetup-0.6.5.exe](https://github.com/Felis-desuwa/NoxReel/releases/latest/download/NoxReel-WebSetup-0.6.5.exe) |
| Android 测试版 | 作为观众加入电脑端房间 | [app-debug.apk](https://github.com/Felis-desuwa/NoxReel/releases/latest/download/app-debug.apk) |
| SHA-256 | 校验下载文件是否完整 | [SHA256SUMS.txt](https://github.com/Felis-desuwa/NoxReel/releases/latest/download/SHA256SUMS.txt) |

> [!NOTE]
> Windows 安装包目前没有商业代码签名，系统可能显示“未知发布者”。请只从本仓库的 [Releases](https://github.com/Felis-desuwa/NoxReel/releases) 页面下载。

## 快速开始

1. 安装并启动 NoxReel。
2. 默认是可信房间（边下边播）；需要先完整扫描时，可在设置中切换安全模式。房主与成员必须选择相同模式。
3. 创建房间，设置人数上限。
4. 选择本地视频，或粘贴受支持的视频链接。
5. 把自动生成的 NoxReel 邀请链接发给成员；成员点开后，再把应答链接发回房主点开。
6. 成员加入后，房主即可统一控制播放、暂停和跳转。

```text
本地视频 → WebRTC P2P 直连
视频链接 → 每位成员直连原网站
        ↓
安全模式：完整校验与扫描后播放
可信房间：约 8 MB 片头后边下边播（完整后补扫）
                    ↕
               全房同步状态
```

## 两种连接方式

| 模式 | 操作 | 是否需要服务器 | 适合场景 |
|---|---|---:|---|
| 零服务器链接（默认） | 双方各点一次邀请／应答链接 | 不需要 | 默认使用；一次邀请连接一位成员 |
| 信令房间（可选） | 成员点一次可复用房间邀请 | 需要轻量信令服务 | 多人频繁加入 |

零服务器 WebRTC 必须交换 offer 和 answer，因此跨设备仍需要把应答链接发回一次；现在不再需要手动粘贴长码。信令服务器只交换 SDP、ICE 和房间状态，不读取或保存视频内容。严格 NAT、CGNAT 或防火墙环境可能需要自行配置 TURN 中继。

## 隐私与内容边界

- 本地视频分片通过加密的 WebRTC 连接在成员之间传输。
- 视频链接由每位成员直接从原始网站读取，不经过 NoxReel 信令服务器；Android 所需的短时效播放地址仅通过已认证的房间连接发送，并剔除 Cookie 与 Authorization。
- 用户选择的源视频始终保持原样；软件生成的接收缓存不会保留在“下载”文件夹，也不提供跨重启断点续传。
- 桌面端启用 Chromium sandbox、上下文隔离和严格 CSP；所有特权操作均通过白名单 IPC 完成。
- 昵称、成员信息和错误内容通过文本节点渲染，不作为 HTML 执行。
- 接收媒体仅允许 MP4、M4V、MOV、MKV 容器，并检查扩展名、文件头和每个分片哈希。安全模式在完整文件通过本机扫描后播放；可信房间会提前播放尚未完成扫描的内容。
- NoxReel 不绕过登录、付费墙、地区限制或 DRM。
- 本项目不提供内容搜索、资源索引或版权内容来源。

> 请仅分享和观看你有权使用的内容。

## 安全使用与免责声明

> [!CAUTION]
> NoxReel 按“现状”提供，不承诺软件、网络连接、第三方播放器或安全扫描能够识别和阻止所有风险。请只加入你信任的房间、只接收可信来源的内容，并保持 Windows、Microsoft Defender、NoxReel 与播放器组件为最新版本。因使用第三方内容、服务或自行部署的基础设施产生的损失与法律责任，由使用者自行承担；在适用法律允许的最大范围内，项目作者不提供明示或默示担保。

如果你发现安全问题，请不要在公开 Issue 中披露可利用细节；请先通过仓库维护者提供的私密联系方式报告，以便核实和修复。

<details>
<summary><strong>技术结构</strong></summary>

| 组件 | 用途 |
|---|---|
| Electron | 桌面应用与房间界面 |
| mpv | 视频播放与 IPC 控制 |
| WebRTC DataChannel | P2P 视频分片传输 |
| WebSocket | 可选信令服务 |
| yt-dlp | 公共视频链接解析 |

本地文件采用分片校验与连续水位线机制；热点分片使用有上限的内存缓存，相邻分片合并落盘，以减少多人传输时的重复磁盘读取和零碎写入。安全模式只在完整文件通过本机安全扫描后把缓存交给 mpv；可信房间在片头连续水位达到约 8 MB 后提前播放，并在完整接收后补做扫描。

</details>

<details>
<summary><strong>当前限制</strong></summary>

- 真实公网 NAT 穿透效果取决于双方网络，无法保证所有网络组合都能直连。
- TURN 中继需要使用者自行提供服务器与凭据。
- 10 GB 上限已覆盖清单拆分和稀疏文件逻辑；目前真实媒体端到端测试规模为 1.75 GB。
- Android 版本仍处于测试阶段，可作为观众接收本地视频或房主解析的视频链接。
- 网站支持范围会随 yt-dlp 和原网站变化；短时效播放地址过期后，需要房主重新切换该链接。
- 安全模式需要**正在运行**的 Microsoft Defender 才能自动播放其他成员传来的本地视频；扫描不可用或未通过时会拒绝播放。装了 360、火绒等第三方杀毒软件的机器上 Defender 往往已被接管停用，这时安全模式无法放行任何接收到的文件——启动时依赖状态里会直接提示「缺少 Defender」。可信房间会在完整扫描前开始播放，扫描器不可用时只警告、不中断播放，只适合双方都信任房主与内容来源的场景。

</details>

## 从源码运行

需要 Node.js 22.12 或更新版本：

```powershell
git clone https://github.com/Felis-desuwa/NoxReel.git
cd NoxReel
npm install
npm start
```

Windows 也可以在源码目录直接双击 `NoxReel.exe`。它会自动检查 Node.js、安装缺失依赖并启动桌面端；需要本地信令服务时双击 `NoxReel-Signal.exe`。这两个启动器都使用项目的 NoxReel 图标，不依赖 BAT 文件。

### 常用命令

```powershell
npm test              # 运行测试
npm run signal        # 启动本地信令服务器
npm run build:launcher # 重新生成带图标的 EXE 启动器
npm run dist:offline  # 构建 Windows 完整安装包
npm run dist:web      # 构建 Windows 联网安装器
```

完整安装包会自动携带 mpv 和 yt-dlp。从源码运行时，也可以通过兼容环境变量指定程序路径：

- `SYNCWATCH_MPV_PATH`
- `SYNCWATCH_YTDLP_PATH`
- `SYNCWATCH_FFMPEG_PATH`

## 参与项目

欢迎通过 [Issues](https://github.com/Felis-desuwa/NoxReel/issues) 报告问题或提出建议。提交问题时，请尽量附上系统版本、连接方式、媒体格式和可复现步骤。

## License

NoxReel 使用 [MIT License](LICENSE)。

<div align="center">
  <sub>Built for movie nights across distance.</sub>
</div>
