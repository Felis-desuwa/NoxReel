# NoxReel 安卓版（观众端）

手机作为**观众**加入 PC 端发起的同步观影房间：边下边播、参与「全员暂停」联动。
手机不做种、不当房主——只接收、只跟随。

## 为什么这么做

安卓端**复用了 PC 端的整套 P2P/同步协议**（`peer` / `swarm` / `scheduler` / `syncEngine` /
`signaling`），原样跑在 WebView 里。安卓 WebView 就是 Chromium，自带和 PC 端同一套
WebRTC / DataChannel / WebSocket 实现——所以帧格式、控制消息、信令握手天然对齐，
互通零风险。安卓只补两块原生能力：

| 能力 | PC 端 | 安卓端 |
|---|---|---|
| 分片存储 + 校验 + 水位线 | `fileStore.js`（Node） | `Store.kt` |
| 播放器 | 外部 mpv | ExoPlayer + `GrowingDataSource` |

`GrowingDataSource` 只读到连续水位线为止，读到还没下的区域就阻塞等下载补齐——
这就是「边下边播」不花屏的关键。HEVC 用原生 MediaCodec 解码（WebView 的
`<video>`/MSE 放 HEVC 不可靠，才没走那条路）。

数据流：`PC 做种 →DataChannel→ 手机 WebView(JS 协议) →bridge→ Store 写盘 →ExoPlayer 播`

## 目录

```
android/
  app/src/main/
    java/com/syncwatch/app/
      MainActivity.kt        WebView(界面) + ExoPlayer(画面) 装配
      Store.kt               分片存储：写盘/SHA-256 校验/连续水位线/断点位图
      GrowingDataSource.kt   只读到水位线的 ExoPlayer 数据源
      SyncPlayer.kt          ExoPlayer 包装，对齐同步引擎期望的接口
      NativeBridge.kt        JS↔原生 唯一通道（对应 PC 的 preload.js）
    assets/
      index.html             界面
      js/
        app-android.js       编排（观众端，复用协议 + 接原生）
        native-shim.js       window.sw / window.swPlayer 垫片
        peer/swarm/scheduler/syncEngine/signaling/protocol/emitter.js  ← 从 PC 端原样拷来
```

> `assets/js/` 下那 7 个协议文件是从 `src/renderer/lib/` **原样复制**的，不要手改。
> PC 端协议一改，这里要同步复制过来。

## 环境（一次性）

- JDK 17（`winget install Microsoft.OpenJDK.17`）
- Android SDK：platform-tools、`platforms;android-33`、`build-tools;33.0.2`
- 目标机：安卓 12（minSdk 26，理论上 8.0+ 都能装）

`local.properties` 里的 `sdk.dir` 指向本机 SDK 路径（此文件不进版本库）。

## 构建 APK

```powershell
cd android
powershell -ExecutionPolicy Bypass -File build-apk.ps1
```

产物：`app/build/outputs/apk/debug/app-debug.apk`

## 装到手机 + 联调

```powershell
adb install -r app\build\outputs\apk\debug\app-debug.apk
adb logcat -s NoxReel NoxReel/web   # 看日志
```

也可以直接把 apk 拷进手机点击安装（需允许「未知来源」）。

## 怎么用

1. **电脑端**：正常发起房间。若用信令服务器模式，先 `npm run signal` 启动，
   记下电脑的局域网 IP（如 `192.168.1.20`）。
2. **手机端**：和电脑连同一 WiFi，打开 App：
   - **信令服务器**：填 `ws://192.168.1.20:8080` + 相同房间号 → 加入。
   - **极简粘贴**：把电脑生成的邀请码贴进去 → 生成应答码 → 发回电脑粘贴。
3. 连上后自动接片，片头就绪即起播；谁缓冲跟不上，全员一起等。

## 已知边界

- HEVC 靠设备硬件解码器；绝大多数安卓 12 机器都支持，个别老芯片可能不行。
- 真实公网 NAT 打洞未在多机环境验证；同一 WiFi（局域网直连）最稳。
  连不上时在电脑端设置里配 TURN 中继兜底。
