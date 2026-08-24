package com.syncwatch.app

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
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
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var player: SyncPlayer
    private var pendingInviteLink: String? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) // 看片别熄屏
        setContentView(R.layout.activity_main)

        val playerView = findViewById<StyledPlayerView>(R.id.player_view)
        web = findViewById(R.id.web)

        val store = Store(applicationContext)
        player = SyncPlayer(applicationContext)
        player.attachView(playerView)
        val bridge = NativeBridge(store, player)
        pendingInviteLink = intent?.dataString?.takeIf { it.startsWith("noxreel://", ignoreCase = true) }

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

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                deliverInviteLink()
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

        web.loadUrl("https://appassets.androidplatform.net/assets/index.html")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        pendingInviteLink = intent.dataString?.takeIf { it.startsWith("noxreel://", ignoreCase = true) }
        deliverInviteLink()
    }

    private fun deliverInviteLink() {
        val link = pendingInviteLink ?: return
        if (!::web.isInitialized) return
        pendingInviteLink = null
        web.evaluateJavascript("window.noxreelOpenInvite?.(${JSONObject.quote(link)})", null)
    }

    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        player.release()
        super.onDestroy()
    }
}
