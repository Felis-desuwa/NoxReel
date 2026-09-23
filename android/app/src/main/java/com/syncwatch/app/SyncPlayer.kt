package com.syncwatch.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.google.android.exoplayer2.C
import com.google.android.exoplayer2.ExoPlayer
import com.google.android.exoplayer2.MediaItem
import com.google.android.exoplayer2.PlaybackException
import com.google.android.exoplayer2.Player
import com.google.android.exoplayer2.source.ProgressiveMediaSource
import com.google.android.exoplayer2.ui.StyledPlayerView
import com.google.android.exoplayer2.source.DefaultMediaSourceFactory
import com.google.android.exoplayer2.source.MediaSource
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONObject

/**
 * 播放器控制器：把 ExoPlayer 包装成同步引擎期望的接口（对齐 PC 端的 mpv）。
 *
 * 同步引擎在 JS 里，通过 bridge 调 [setPause] / [seek]，并周期性拿 [snapshotJson]。
 * 手机端所有暂停/拖动都从界面显式发起，走同步引擎，再落到这里 —— 不去猜「用户在
 * 播放器窗口里动了什么」，因为根本没有那样一个独立窗口。
 *
 * 媒体源用 [GrowingDataSource]：只读到当前位置所在那段连续已收数据的末尾，边下边播。
 *
 * ## 快照代号（generation）
 *
 * [load] / [loadRemote] / [release] 都只是把活儿 post 到主线程，**同步返回时播放器还没换**。
 * 0.7 起播放列表会连播，换片后 JS 立刻拿一条快照是常态，而那条快照很可能还是上一部片
 * 的读数（位置停在 1 小时 23 分、paused=false），同步引擎会拿它当「用户拖动了」去广播。
 *
 * 所以每次换片/释放都分配一个递增的代号：
 * - 三个方法**同步**返回自己分配到的代号（[load] / [loadRemote] 失败前不会走到这一步，
 *   失败由 NativeBridge 用 0 表示）；
 * - 快照里带 `generation`，它只在主线程真正换完播放器的那一刻才变成新值；
 * - JS 侧记住最后一次调用拿到的代号，快照里代号对不上就整条丢弃（别拿它更新同步基线）。
 *
 * 换句话说：代号不一致 = 这条快照属于上一个播放器。宁可少更新几个 250ms 周期，
 * 也不能把旧片的位置当成新片的用户操作。
 */
class SyncPlayer(private val context: Context) {

    private val main = Handler(Looper.getMainLooper())
    private var player: ExoPlayer? = null
    private var view: StyledPlayerView? = null

    /** 代号发号器。在调用方线程（WebView 的 JavaBridge 线程）分配，所以要原子的。 */
    private val generationSeq = AtomicInteger(0)

    /**
     * 当前快照。**整体替换**而不是逐字段写：读的一方（任意线程）永远拿到自洽的一组值，
     * 不会出现「新代号配旧位置」这种撕裂 —— 那正是代号要解决的问题本身。
     * 所有写入都发生在主线程，所以 `snap = snap.copy(...)` 这种读改写不会丢更新。
     * 代号 0 表示从没加载过任何东西。
     */
    @Volatile private var snap = Snap(0, 0L, 0L, false, Player.STATE_IDLE)

    fun attachView(v: StyledPlayerView) { view = v }

    /**
     * 主线程创建 ExoPlayer 并加载会话文件；切换媒体时替换旧实例。
     * @return 这次换片的快照代号，JS 侧据此丢弃旧播放器的快照。
     */
    fun load(session: Store.Session): Int {
        val generation = generationSeq.incrementAndGet()
        main.post {
            val factory = GrowingDataSource.Factory(session)
            val uri = android.net.Uri.fromFile(session.dataFile)
            val source = ProgressiveMediaSource.Factory(factory)
                .createMediaSource(MediaItem.fromUri(uri))

            replacePlayer(source, generation)
        }
        return generation
    }

    /**
     * 播放网页解析出的临时直链；HLS/DASH/渐进式 MP4 由 ExoPlayer 自动选择。
     *
     * 数据源是 [PublicHttpDataSource]：清单、分片、每一跳重定向在真正建连时都会查一遍
     * 是不是公网地址。加载前 NativeBridge 那道检查只看字面，挡不住重定向、子资源和 DNS 重绑定。
     * @return 这次换片的快照代号。
     */
    fun loadRemote(url: String, headers: Map<String, String>): Int {
        val generation = generationSeq.incrementAndGet()
        main.post {
            val http = PublicHttpDataSource.Factory(headers)
            val source = DefaultMediaSourceFactory(http)
                .createMediaSource(MediaItem.fromUri(url))
            replacePlayer(source, generation)
        }
        return generation
    }

    private fun replacePlayer(source: MediaSource, generation: Int) {
        view?.player = null
        player?.release()
        player = null
        // 先把快照整体换成新代号的初始值（0:00、暂停、idle）：这一刻之前的任何读数都还挂着
        // 旧代号，JS 会丢掉；这一刻之后写进来的才是新播放器的。
        snap = resetSnap(generation)

        val exo = ExoPlayer.Builder(context).build()

        exo.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(s: Int) {
                updateSnap(generation) { it.copy(state = s) }
            }
            override fun onPlayWhenReadyChanged(p: Boolean, reason: Int) {
                updateSnap(generation) { it.copy(playWhenReady = p) }
            }
            // 出错时 ExoPlayer 自己回到 IDLE，快照会照实报 idle；这里只留一条日志，
            // 被 NetGuard 拦下的内网地址也是从这里看出来的
            override fun onPlayerError(error: PlaybackException) {
                Log.w(TAG, "播放出错：${error.errorCodeName}", error)
            }
        })
        exo.setMediaSource(source)
        exo.playWhenReady = false
        exo.prepare()

        view?.player = exo
        player = exo
        startPolling(generation)
    }

    /**
     * 只有属于当前代号的更新才写得进去。旧播放器 release 之后迟到的回调（或上一轮
     * 还没跑完的轮询）就这样被挡在外面，污染不了新快照。只在主线程调用。
     */
    private fun updateSnap(generation: Int, patch: (Snap) -> Snap) {
        val current = snap
        if (current.generation != generation) return
        snap = patch(current)
    }

    /** 轮询播放位置。代号一变就自己停下来，不用再额外维护一个轮询代号。 */
    private fun startPolling(generation: Int) {
        val tick = object : Runnable {
            override fun run() {
                if (snap.generation != generation) return
                player?.let { p ->
                    val dur = if (p.duration == C.TIME_UNSET) 0L else p.duration
                    updateSnap(generation) { s -> s.copy(posMs = p.currentPosition, durMs = dur) }
                }
                if (snap.generation == generation) main.postDelayed(this, 250)
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

    /** 快照 JSON，见 [snapJson]。 */
    fun snapshotJson(): String = snapJson(snap)

    /**
     * 释放播放器。同样是投递到主线程的，所以也要占一个代号：
     * 释放完成前的快照还带着旧代号，JS 一看就知道「这条是上一个播放器的」。
     * @return 这次释放的快照代号。
     */
    fun release(): Int {
        val generation = generationSeq.incrementAndGet()
        main.post {
            view?.player = null
            player?.release()
            player = null
            snap = resetSnap(generation)
        }
        return generation
    }

    /* ------------------------------ 纯函数部分 ------------------------------ */

    /** 换到新代号时快照的初始值：位置归零、暂停、idle。 */
    private fun resetSnap(generation: Int): Snap =
        Snap(generation, 0L, 0L, false, Player.STATE_IDLE)

    /**
     * 快照 → JSON。paused 取「是否真的在推进」的语义：非 READY 或没让它播都算暂停 ——
     * 这样播放位置在缓冲时不会被同步引擎误判成拖动。
     * `generation` 是这组读数属于哪个播放器，JS 侧用它丢弃换片前的残留快照。
     */
    private fun snapJson(s: Snap): String {
        val advancing = s.playWhenReady && s.state == Player.STATE_READY
        return JSONObject()
            .put("generation", s.generation)
            .put("position", s.posMs / 1000.0)
            .put("duration", s.durMs / 1000.0)
            .put("paused", !advancing)
            // 缺数据在等（跳转后、网速跟不上时）。让没让它播都算：同步引擎让全房等的时候会把它暂停，
            // 暂停期间 ExoPlayer 照样在缓冲，攒够了变成 READY 才算缓冲完
            .put("buffering", s.state == Player.STATE_BUFFERING)
            .put("idle", s.state == Player.STATE_IDLE)
            .put("eof", s.state == Player.STATE_ENDED)
            .toString()
    }

    /** 一次快照的全部字段，含它属于哪个播放器代号。整体替换，不逐字段写。 */
    private data class Snap(
        val generation: Int,
        val posMs: Long,
        val durMs: Long,
        val playWhenReady: Boolean,
        val state: Int,
    )

    companion object {
        private const val TAG = "NoxReel"
    }
}
