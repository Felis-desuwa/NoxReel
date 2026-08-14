# NoxReel

<p align="center">
  <img src="assets/branding/noxreel-icon.png" width="160" alt="NoxReel 图标">
</p>

<p align="center">
  深色、轻量的多人同步观影工具。支持本地视频 P2P 边传边播，也支持解析视频链接并同步播放。
</p>

## 下载

前往 [Releases](../../releases/latest) 下载最新版本：

- `NoxReel-Setup-0.4.0.exe`：完整离线安装包，已包含 mpv 与 yt-dlp，推荐使用。
- `NoxReel-WebSetup-0.4.0.exe`：小型联网安装器，安装时下载应用组件。
- `app-debug.apk`：Android 测试版；当前仍以桌面端为主要体验。

Windows 可能显示“未知发布者”，因为当前安装包尚未购买代码签名证书。请只从本仓库的 Release 页面下载。

## 主要功能

- 本地视频 P2P 边传边播，支持 MP4、MOV、M4V、MKV，单个文件最大 10 GB。
- 解析公开视频页面、MP4 直链和 HLS 播放清单，并同步播放、暂停与跳转。
- 两种加入方式：短邀请码信令房间，以及无需服务器的手动握手模式。
- 房主可设置 2–16 人的房间容量，并在房间内切换本地视频或视频链接。
- 显示每位已连接用户的上传速度、下载速度与延迟。
- 最慢成员缓冲不足时，全员自动暂停；缓冲恢复后继续播放。
- 播放器窗口关闭后可以从房间页面重新打开。
- 分享操作不会提前创建虚假的“幽灵用户”。

## 快速使用

1. 安装并启动 NoxReel。
2. 创建房间，设置人数上限。
3. 选择本地视频，或粘贴受支持的视频链接。
4. 把短邀请码发送给其他成员。
5. 成员加入后，房主即可统一控制播放。

链接解析依赖目标网站是否允许访问。NoxReel 不绕过登录、付费墙、地区限制或 DRM，也不会把链接视频内容转发到信令服务器。

## 连接方式

| 模式 | 适用场景 | 说明 |
|---|---|---|
| 信令房间 | 日常使用 | 一次粘贴短邀请码；服务器只交换连接信息，不接触视频内容。 |
| 手动握手 | 不使用信令服务器 | 双方交换邀请码与应答码，视频仍通过 WebRTC 直连。 |

WebRTC 直连结果会受到 NAT、防火墙和运营商网络影响。严格 NAT 或 CGNAT 环境可能需要自行配置 TURN 服务器。

## 隐私与内容边界

- 本地视频分片通过 WebRTC 在房间成员之间传输。
- 信令服务器只负责交换 SDP/ICE 与房间状态。
- 视频链接由每位成员直接从原始网站读取。
- 本项目不提供内容搜索、资源索引或版权内容来源。

请仅分享和观看你有权使用的内容。

## 从源码运行

需要 Node.js 20 或更新版本：

```powershell
npm install
npm start
```

常用命令：

```powershell
npm test              # 运行测试
npm run signal        # 启动本地信令服务器
npm run dist:offline  # 构建完整离线安装包
npm run dist:web      # 构建联网安装器
```

完整安装包会自动携带 mpv 和 yt-dlp。从源码运行时，可以安装这些工具，或使用以下兼容环境变量指定程序路径：

- `SYNCWATCH_MPV_PATH`
- `SYNCWATCH_YTDLP_PATH`
- `SYNCWATCH_FFMPEG_PATH`

## 技术结构

- Electron：桌面应用与房间界面
- mpv：视频播放与 IPC 控制
- WebRTC DataChannel：P2P 视频分片传输
- WebSocket：可选信令服务
- yt-dlp：公开视频链接解析

## 当前限制

- 真实公网 NAT 穿透效果取决于双方网络，无法保证所有网络组合都能直连。
- TURN 中继需要使用者自行提供服务器与凭据。
- 10 GB 上限已通过清单拆分和稀疏文件逻辑覆盖；目前真实媒体端到端测试规模为 1.75 GB。
- Android 版本仍处于测试阶段。

## License

[MIT](LICENSE)
