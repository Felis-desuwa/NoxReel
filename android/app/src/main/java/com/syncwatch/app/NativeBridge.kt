package com.syncwatch.app

import android.util.Log
import android.webkit.JavascriptInterface

/**
 * JS ↔ 原生 的唯一通道，对应 PC 端 preload.js 暴露的 window.sw。
 *
 * addJavascriptInterface 的方法可以直接 return String 给 JS，是同步返回的 ——
 * 于是不用搞异步回调编排。分片是二进制，过桥时 base64 编码（一片 2MB，
 * 编解码几毫秒，吞吐本来就是网络瓶颈，划算）。
 *
 * 注意：这些方法运行在 WebView 的 JavaBridge 线程，不是主线程。
 * 碰播放器（ExoPlayer 只能主线程）的调用由 [SyncPlayer] 内部 post 到主线程。
 */
class NativeBridge(
    private val store: Store,
    private val player: SyncPlayer,
) {
    /* ------------------------------ 存储 ------------------------------ */

    @JavascriptInterface
    fun openLeech(
        fileId: String,
        name: String,
        size: String,
        chunkSize: Int,
        chunkCount: Int,
        hashesJson: String,
    ): String {
        return try {
            store.openLeech(fileId, name, size.toLong(), chunkSize, chunkCount, hashesJson)
        } catch (e: Exception) {
            Log.e(TAG, "openLeech 失败", e); ""
        }
    }

    /** @return 结果 JSON：{ok, duplicate, haveCount, contiguousBytes, complete, reason} */
    @JavascriptInterface
    fun writeChunk(sessionId: String, index: Int, b64: String): String {
        return try {
            store.writeChunk(sessionId, index, b64)
        } catch (e: Exception) {
            Log.e(TAG, "writeChunk 失败", e)
            "{\"ok\":false,\"reason\":\"exception\"}"
        }
    }

    /** @return 分片 base64；没有或出错返回 null（JS 侧判空）。 */
    @JavascriptInterface
    fun readChunk(sessionId: String, index: Int): String? {
        return try {
            store.readChunk(sessionId, index)
        } catch (e: Exception) {
            Log.e(TAG, "readChunk 失败", e); null
        }
    }

    @JavascriptInterface
    fun contiguousBytes(sessionId: String): String {
        val s = store.get(sessionId) ?: return "0"
        return s.contiguousBytes().toString()
    }

    /** @return 断点续传状态 JSON：{bitfield(base64), haveCount, contiguousBytes, complete} */
    @JavascriptInterface
    fun sessionState(sessionId: String): String = store.sessionState(sessionId)

    @JavascriptInterface
    fun closeSession(sessionId: String) {
        store.close(sessionId)
    }

    /* ------------------------------ 播放器 ------------------------------ */

    /** 让 ExoPlayer 加载某个接收会话的文件，开始边下边播。 */
    @JavascriptInterface
    fun playerLoad(sessionId: String): Boolean {
        val s = store.get(sessionId) ?: return false
        player.load(s)
        return true
    }

    @JavascriptInterface
    fun playerSetPause(paused: Boolean) = player.setPause(paused)

    @JavascriptInterface
    fun playerSeek(seconds: Double) = player.seek(seconds)

    /** @return 播放快照 JSON：{position, duration, paused, idle, eof}（秒） */
    @JavascriptInterface
    fun playerSnapshot(): String = player.snapshotJson()

    @JavascriptInterface
    fun playerRelease() = player.release()

    /* ------------------------------ 杂项 ------------------------------ */

    @JavascriptInterface
    fun log(msg: String) { Log.d(TAG, msg) }

    companion object {
        const val NAME = "Native"
        private const val TAG = "SyncWatch"
    }
}
