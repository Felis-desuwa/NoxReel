package com.syncwatch.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.google.android.exoplayer2.C
import com.google.android.exoplayer2.ExoPlayer
import com.google.android.exoplayer2.MediaItem
import com.google.android.exoplayer2.Player
import com.google.android.exoplayer2.source.ProgressiveMediaSource
import com.google.android.exoplayer2.ui.StyledPlayerView
import com.google.android.exoplayer2.source.DefaultMediaSourceFactory
import com.google.android.exoplayer2.source.MediaSource
import com.google.android.exoplayer2.upstream.DefaultHttpDataSource
import org.json.JSONObject

/**
 * 播放器控制器：把 ExoPlayer 包装成同步引擎期望的接口（对齐 PC 端的 mpv）。
 *
 * 同步引擎在 JS 里，通过 bridge 调 [setPause] / [seek]，并周期性拿 [snapshotJson]。
 * 手机端所有暂停/拖动都从界面显式发起，走同步引擎，再落到这里 —— 不去猜「用户在
 * 播放器窗口里动了什么」，因为根本没有那样一个独立窗口。
 *
 * 媒体源用 [GrowingDataSource]：只读到连续水位线，边下边播。
 */
class SyncPlayer(private val context: Context) {

    private val main = Handler(Looper.getMainLooper())
    private var player: ExoPlayer? = null
    private var view: StyledPlayerView? = null

    // 快照字段：主线程更新，任意线程读
    @Volatile private var posMs = 0L
    @Volatile private var durMs = 0L
    @Volatile private var playWhenReady = false
    @Volatile private var state = Player.STATE_IDLE
    @Volatile private var loaded = false

    fun attachView(v: StyledPlayerView) { view = v }

    /** 主线程创建 ExoPlayer 并加载会话文件；切换媒体时替换旧实例。 */
    fun load(session: Store.Session) {
        main.post {
            val factory = GrowingDataSource.Factory(session)
            val uri = android.net.Uri.fromFile(session.dataFile)
            val source = ProgressiveMediaSource.Factory(factory)
                .createMediaSource(MediaItem.fromUri(uri))

            replacePlayer(source)
        }
    }

    /** 播放网页解析出的临时直链；HLS/DASH/渐进式 MP4 由 ExoPlayer 自动选择。 */
    fun loadRemote(url: String, headers: Map<String, String>) {
        main.post {
            val http = DefaultHttpDataSource.Factory()
                .setAllowCrossProtocolRedirects(false)
                .setConnectTimeoutMs(15_000)
                .setReadTimeoutMs(30_000)
                .setDefaultRequestProperties(headers)
            val source = DefaultMediaSourceFactory(http)
                .createMediaSource(MediaItem.fromUri(url))
            replacePlayer(source)
        }
    }

    private fun replacePlayer(source: MediaSource) {
        view?.player = null
        player?.release()
        pollGeneration++
        loaded = false
        posMs = 0
        durMs = 0
        playWhenReady = false
        state = Player.STATE_IDLE

        val exo = ExoPlayer.Builder(context).build()

        exo.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(s: Int) { state = s }
            override fun onPlayWhenReadyChanged(p: Boolean, reason: Int) { playWhenReady = p }
        })
        exo.setMediaSource(source)
        exo.playWhenReady = false
        exo.prepare()

        view?.player = exo
        player = exo
        loaded = true
        startPolling()
    }

    private var pollGeneration = 0
    private fun startPolling() {
        val generation = ++pollGeneration
        val tick = object : Runnable {
            override fun run() {
                if (generation != pollGeneration) return
                player?.let {
                    posMs = it.currentPosition
                    durMs = if (it.duration == C.TIME_UNSET) 0 else it.duration
                }
                if (generation == pollGeneration) main.postDelayed(this, 250)
            }
        }
        main.post(tick)
    }

    fun setPause(paused: Boolean) {
        main.post { player?.playWhenReady = !paused }
    }

    fun seek(seconds: Double) {
        main.post { player?.seekTo((seconds * 1000).toLong()) }
    }

    /**
     * 快照。paused 取「是否真的在推进」的语义：非 READY 或没让它播都算暂停 ——
     * 这样播放位置在缓冲时不会被同步引擎误判成拖动。
     */
    fun snapshotJson(): String {
        val advancing = playWhenReady && state == Player.STATE_READY
        return JSONObject()
            .put("position", posMs / 1000.0)
            .put("duration", durMs / 1000.0)
            .put("paused", !advancing)
            .put("idle", state == Player.STATE_IDLE)
            .put("eof", state == Player.STATE_ENDED)
            .toString()
    }

    fun release() {
        main.post {
            pollGeneration++
            view?.player = null
            player?.release()
            player = null
            loaded = false
            posMs = 0
            durMs = 0
            playWhenReady = false
            state = Player.STATE_IDLE
        }
    }
}
