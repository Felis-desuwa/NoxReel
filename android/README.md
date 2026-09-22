# NoxReel 安卓版（观众端）

手机作为**观众**加入 PC 端发起的同步观影房间：支持 P2P 文件、房主解析的视频直链、
边下边播与「全员暂停」联动。
手机不做种、不当房主——只接收、只跟随。

0.7 版本（versionCode 16 / versionName 0.7.0）跟上了桌面端的播放列表、聊天和弹幕：
列表变了跟着切片、聊天能看能发、画面上飘弹幕。**但手机端不能编辑列表**——加片、
调序、删除、开关自动连播都只在电脑上做。协议升到 v2，与 0.6.x 的电脑端不互通，
两边要一起升级。

## 为什么这么做

安卓端**复用了 PC 端的整套 P2P/同步协议**（`peer` / `swarm` / `scheduler` / `syncEngine` /
`signaling`），原样跑在 WebView 里。安卓 WebView 就是 Chromium，自带和 PC 端同一套
WebRTC / DataChannel / WebSocket 实现——所以帧格式、控制消息、信令握手天然对齐，
互通零风险。安卓只补两块原生能力：

| 能力 | PC 端 | 安卓端 |
|---|---|---|
| 分片存储 + 校验 + 两条水位线 | `fileStore.js`（Node） | `Store.kt` |
| 播放器 | 外部 mpv | ExoPlayer + `GrowingDataSource` / HTTP、HLS、DASH |

`GrowingDataSource` 只读到**当前播放位置所在那段连续已收数据**的末尾，读到还没下的
区域就阻塞等下载补齐——这就是「边下边播」不花屏的关键。判据不是从文件头起的连续
水位线：中途加入房间时播放位置之前整段都是空洞，按水位线算根本读不出数据，而
`Store.awaitData()` 在这种情况下**绝不能返回 -1**（ExoPlayer 会当成文件到头直接 ENDED）。HEVC 用原生 MediaCodec 解码（WebView 的
`<video>`/MSE 放 HEVC 不可靠，才没走那条路）。

文件数据流：`PC 做种 →DataChannel→ 手机 WebView(JS 协议) →bridge→ Store 写盘 →ExoPlayer 播`

链接数据流：`房主 yt-dlp 解析 →DataChannel 发送临时直链 →手机确认站点 →ExoPlayer 直连原网站`

链接消息只接受通过房间握手认证的房主，并删除 Cookie、Authorization 等敏感请求头；
手机仍会在连接外部站点前单独确认。登录、付费、DRM 内容不在支持范围内。

## 目录

```
android/
  app/src/main/
    java/com/syncwatch/app/
      MainActivity.kt        WebView(界面) + ExoPlayer(画面) 装配
      Store.kt               分片存储：写盘/SHA-256 校验/两条水位线/断点位图
      GrowingDataSource.kt   只读到当前连续区末尾的 ExoPlayer 数据源
      SyncPlayer.kt          ExoPlayer 包装，对齐同步引擎期望的接口
      NativeBridge.kt        JS↔原生 唯一通道（对应 PC 的 preload.js）
      NetGuard.kt            在线链接的建连守卫：逐跳跟重定向、每条 TCP 连接都核对对端不是内网
      PublicHttpDataSource.kt  代替 DefaultHttpDataSource 的数据源，清单/分片/密钥全经 NetGuard
    assets/
      index.html             界面
      js/
        app-android.js       编排（观众端，复用协议 + 接原生）
        native-shim.js       window.sw / window.swPlayer 垫片
        i18n.js              界面文案（简体中文为源语言，英文跟着补）
        emitter/ice/scheduler/protocol/peer/swarm/syncEngine/
        signaling/playlist/chat/danmaku.js  ← 从 PC 端原样拷来
```

> `assets/js/` 下那 11 个共享库是从 `src/renderer/lib/` **原样复制**的，不要手改。
> PC 端一改，这里要同步复制过来：`test/sharedLibParity.test.js` 会逐字节比对（行尾除外），
> 两边不一致直接红。

## 原生侧的约定（改 `assets/js` 之前先看这里）

**① 快照代号 `generation`。** `Native.playerLoad` / `playerLoadUrl` / `playerRelease` 都只是把活儿
投递到主线程，**同步返回时播放器还没换**。0.7 的播放列表会连播，换片后 JS 立刻取一条快照
是常态，而那条快照很可能还是上一部片的读数（位置停在 1:23:45、`paused:false`），
同步引擎会当成「有人拖动了」广播出去。所以：

- 这三个方法**同步返回一个递增的代号**（`Int`，从 1 开始；`0` 表示失败，所以 JS 里
  原来的真假判断照样成立）。
- `playerSnapshot()` 的 JSON 多了一个 `generation` 字段，它只在主线程真正换完播放器的
  那一刻才变成新值。
- **JS 侧要记住最后一次调用拿到的代号，快照里代号对不上就整条丢弃**，别拿它更新
  同步基线。宁可少更新几个 250ms 周期，也不能把旧片的位置当成新片的用户操作。

**② `Native.usableSpace()`。** 返回接收缓存所在分区的可用字节数（字符串，JS 侧 `Number()`
一下）。手机端最多同时开两个接收会话（当前项和下一项），要不要开第二个由 JS 侧按这个数
做预算。它和 `openLeech` 的空间检查读的是同一个 `Store.usableSpace()`，判据不会分家；
留量规则也照抄那边：**留 1% 或 256MB，取大**。查不到时返回 `"0"`，这时**不要拦**，
让真正的写入错误说话。

**③ 输入法。** Activity 设了 `windowSoftInputMode="adjustResize"`：键盘弹出时窗口自己变矮，
聊天输入条贴在键盘上方，WebView 会收到新的视口高度。别给主题加 `windowFullscreen`，
全屏窗口会让 `adjustResize` 失效。

**④ 配置变更不重建 Activity。** `AndroidManifest.xml` 的 `configChanges` 列全了深色模式、字体大小、
语言、键盘、旋转等：重建会让观众退房、接收缓存被删。界面全在 WebView 里会自己重排，
新加带限定符的资源之前先想清楚这一点。

**⑤ `Native.leaveRoom()` / `Native.appVersion()`。** 在房间里再点一条邀请时，页面先问
「留在当前房间 / 离开并加入」；选离开就调 `leaveRoom()`（释放播放器、删掉接收缓存），
把邀请记进 sessionStorage 后整页重载，重载完再处理它。`appVersion()` 返回
`BuildConfig.VERSION_NAME`，大厅标题旁的版本号就从这里来。

**⑥ 在线视频不走系统代理。** `NetGuard` 用 `Proxy.NO_PROXY` 直连：走代理时看不到真正的对端地址，
就没法在建连那一刻判断是不是内网。VPN 类 App 不受影响。

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

1. **电脑端**：正常发起房间，默认会生成零服务器 NoxReel 邀请链接。
2. **手机端**：点开邀请链接，App 会自动生成应答链接；把它发回电脑，房主点开即可连接。
   不需要手动粘贴长码。若改用信令服务器，先在电脑运行 `npm run signal`，手机填写
   `ws://电脑局域网IP:8080` 和相同房间号。
3. 连上后自动接片；房主切换到网页视频时，手机确认来源站点后直接播放。谁缓冲跟不上，
   全员一起等。
4. 播放列表跟着电脑走：当前项一变，手机自动切到新的片子（或链接），准备好了会回一个
   READY，等大家都好了再开播。列表面板在手机上是**只读**的。
5. 聊天：横屏是侧边抽屉，竖屏是底部面板；发出去的话会以弹幕形式飘在画面上。
   进出房间这类系统事件也混在聊天流里。

## 已知边界

- **不能编辑播放列表**：加片、调序、立即播放、删除、开关自动连播都只在电脑端做。
  就算本机被房主设成管理员，手机上也只是「能控制播放，但不能编辑列表」。
- 手机永远是观众：不做种、不当房主，本地文件传不出去。
- 协议 v2 与 0.6.x 不互通，电脑端和手机端必须一起升到 0.7。
- 最多同时开两个接收会话（当前项 + 下一项），空间不够时下一项不预取。
- HEVC 靠设备硬件解码器；绝大多数安卓 12 机器都支持，个别老芯片可能不行。
- 网站链接能否播放取决于 yt-dlp、原网站和 ExoPlayer；短时效链接过期后需房主重新切换。
- 真实公网 NAT 打洞未在多机环境验证；同一 WiFi（局域网直连）最稳。
  连不上时在电脑端设置里配 TURN 中继兜底。
