package com.syncwatch.app

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.util.Log
import org.json.JSONObject
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import com.google.android.exoplayer2.ui.StyledPlayerView

/**
 * 唯一的 Activity。
 *
 * 架构：视频用 ExoPlayer 画在底层 StyledPlayerView，界面全部由上层透明 WebView 承担。
 * WebView 里跑的是从 PC 端原样搬来的 P2P/同步协议（同一套 Chromium WebRTC），
 * 通过 [NativeBridge] 调用原生的存储与播放器。手机只当观众，不做种、不当房主。
 *
 * 这个 Activity 不能被系统重建：重建会走 onDestroy（释放播放器、删光接收缓存），
 * 新的 WebView 从大厅重新开始，房间和直连全丢。所以清单里的 configChanges 把
 * 深色模式、字体大小、语言、键盘、旋转这些配置变更都声明成自己处理 —— 界面全在
 * WebView 里，它和 ExoPlayer 的画面会按新尺寸自己重排，不需要重新加载任何资源。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var player: SyncPlayer
    private lateinit var store: Store
    private lateinit var bridge: NativeBridge
    private val main = Handler(Looper.getMainLooper())
    // WebView 已经被摘下销毁（渲染进程没了）：后台线程迟到的回复别再往它身上送
    private var webGone = false

    // 深链接收件箱：只留最新一条。页面没加载完之前先存着，加载完再送。
    private var pendingInviteLink: String? = null
    private var pageReady = false
    private var inviteScheduled = false
    private var lastInviteAt = 0L

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) // 看片别熄屏
        setContentView(R.layout.activity_main)

        val playerView = findViewById<StyledPlayerView>(R.id.player_view)
        web = findViewById(R.id.web)

        store = Store(applicationContext)
        // 上次进程被系统杀掉时 close() 根本没机会跑，那批接收缓存会一直留着。
        // 冷启动时会话表是空的，正是回收它们的时机。
        store.cleanupStale()
        player = SyncPlayer(applicationContext)
        player.attachView(playerView)
        // Cloudflare TURN 的结果从后台线程回来：切回主线程，按请求 id 交给页面（见 native-shim 的 nativeCall）。
        // 两个参数都经 JSONObject.quote 变成 JS 字符串字面量，不拼接任何未转义的内容。
        bridge = NativeBridge(store, player, CloudflareTurn(applicationContext.filesDir)) { id, json ->
            main.post {
                if (webGone || !::web.isInitialized) return@post
                web.evaluateJavascript(
                    "window.__noxreelNativeReply?.(${JSONObject.quote(id)}, ${JSONObject.quote(json)})",
                    null
                )
            }
        }
        // 只有全新启动才看启动它的那条链接。重建（渲染进程崩溃后、从最近任务恢复）时
        // Intent 还是上一次那条：再处理一遍就是把旧邀请重放一次，要是正是它把页面撑崩的，
        // 还会崩了又重建、重建又崩。
        if (savedInstanceState == null) pendingInviteLink = inviteLinkOf(intent?.dataString)

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG) // 发布包不暴露 chrome://inspect
        web.setBackgroundColor(0x00000000) // 透明，露出底下视频
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            // 页面从 https 虚拟域加载（见下），而信令是 ws:// 明文 —— 允许混合内容，
            // 否则 https 源连 ws:// 会被当混合内容拦掉。视频走 DTLS，不受此影响。
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }
        web.addJavascriptInterface(bridge, NativeBridge.NAME)

        // 用 WebViewAssetLoader 把 assets 映射到 https 虚拟域。
        // 关键：ES 模块（import/export）在 file:// 源下会被 CORS 拦掉，https 源才行。
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        web.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

            // 页面只该待在自己的虚拟域里。Native 桥对这个 WebView 里的任何页面都开放，
            // 真被带到别的网站，那个网站就能调 Native.*；所以站外跳转一律拦下，也不替它开浏览器。
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                !isAppPage(request.url)

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                pageReady = false
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                pageReady = true
                scheduleInviteDelivery()
            }

            // 渲染进程没了（崩溃，或被系统回收内存）。不接住的话整个 App 跟着被杀，
            // 接收缓存也没人删。这个 WebView 已经不能再用：摘下、销毁，整个界面重建回到大厅。
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                Log.e(TAG, "WebView 渲染进程退出（崩溃：${detail.didCrash()}），重建界面")
                pageReady = false
                webGone = true
                (view.parent as? ViewGroup)?.removeView(view)
                view.destroy()
                recreate()
                return true
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                Log.d("NoxReel/web", "${m.message()} @${m.sourceId()}:${m.lineNumber()}")
                return true
            }
            // DataChannel 不需要摄像头或麦克风，任何媒体权限请求都拒绝。
            override fun onPermissionRequest(request: PermissionRequest) {
                request.deny()
            }
        }

        web.loadUrl("$APP_ORIGIN/assets/index.html")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val link = inviteLinkOf(intent.dataString) ?: return
        // 连着来好几条只留最后一条。noxreel:// 谁都能发（Activity 是公开的、可从浏览器唤起），
        // 别的 App 可以对着它狂发 Intent；照单全收的话，页面每条都要解码、建连接、生成应答。
        pendingInviteLink = link
        scheduleInviteDelivery()
    }

    /** 页面就绪后送出收件箱里那条链接；两次之间至少隔 [INVITE_MIN_INTERVAL_MS]。 */
    private fun scheduleInviteDelivery() {
        if (inviteScheduled || !pageReady || pendingInviteLink == null) return
        val wait = (lastInviteAt + INVITE_MIN_INTERVAL_MS - SystemClock.uptimeMillis()).coerceAtLeast(0L)
        inviteScheduled = true
        main.postDelayed({
            inviteScheduled = false
            deliverInviteLink()
        }, wait)
    }

    private fun deliverInviteLink() {
        val link = pendingInviteLink ?: return
        if (!::web.isInitialized || !pageReady) return
        pendingInviteLink = null
        lastInviteAt = SystemClock.uptimeMillis()
        web.evaluateJavascript("window.noxreelOpenInvite?.(${JSONObject.quote(link)})", null)
    }

    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        webGone = true
        if (::bridge.isInitialized) bridge.shutdown()
        player.release()
        // 关掉所有会话，接收缓存跟着删。原来只 release 播放器，
        // 缓存留在 filesDir 里既看不到也删不掉，只能去系统设置清数据。
        if (::store.isInitialized) runCatching { store.closeAll() }
        super.onDestroy()
    }

    companion object {
        private const val TAG = "NoxReel"

        /** 页面所在的虚拟域（WebViewAssetLoader 的默认域名）。 */
        private const val APP_ORIGIN = "https://appassets.androidplatform.net"

        /** 两次送链接之间的最短间隔。人点链接不会这么快，狂发的才会。 */
        private const val INVITE_MIN_INTERVAL_MS = 1000L

        /**
         * 深链接的长度上限。正常的一对一邀请只有一两千字；邀请码是 gzip 压过的，
         * 几百 KB 的码解压出来能在 WebView 里撑出上百 MB。和页面那边的上限一致。
         */
        const val MAX_INVITE_LINK_CHARS = 32 * 1024

        /** 只收 noxreel:// 开头、长度正常的链接，其余一律当没收到。 */
        fun inviteLinkOf(data: String?): String? {
            if (data == null || data.length > MAX_INVITE_LINK_CHARS) return null
            return if (data.startsWith("noxreel://", ignoreCase = true)) data else null
        }

        private fun isAppPage(url: Uri): Boolean =
            url.scheme.equals("https", ignoreCase = true) && "https://${url.host}" == APP_ORIGIN
    }
}
