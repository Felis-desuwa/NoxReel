package com.syncwatch.app

import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.net.InetAddress
import java.net.URI

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
            Log.e(TAG, "openLeech 失败", e)
            // 失败原因要带回 JS：磁盘放不下这种情况，用户得知道是空间问题，而不是一句「openLeech 失败」。
            // 会话 id 一律以 "leech-" 开头，用 "!" 前缀表示错误不会和正常返回值撞上。
            "!" + (e.message ?: "openLeech 失败")
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

    /**
     * 接收缓存所在分区还能用多少字节。
     *
     * 0.7 起手机端最多同时开两个接收会话（当前项和下一项），要不要开第二个由 JS 侧
     * 做空间预算决定 —— 预算得有个数可算，就是这里。数字可能远超 2^31，按字符串返回
     * （与 [contiguousBytes] 同一约定），JS 侧 `Number()` 一下即可。
     *
     * 查不到时返回 "0"：这时 JS **不应该**拦，让真正的写入错误说话（和 openLeech 的
     * 空间检查同一判据，两边都读 [Store.usableSpace]）。
     */
    @JavascriptInterface
    fun usableSpace(): String = store.usableSpace().toString()

    /* ------------------------------ 播放器 ------------------------------ */

    /**
     * 让 ExoPlayer 加载某个接收会话的文件，开始边下边播。
     *
     * @return 这次换片的快照代号（见 [SyncPlayer]），**0 表示失败**（会话不存在）。
     * 代号从 1 开始递增，所以 JS 侧原来的 `if (!Native.playerLoad(id))` 判真假照样成立；
     * 接上代号过滤后改成记下这个数，再拿它和快照里的 `generation` 比对。
     */
    @JavascriptInterface
    fun playerLoad(sessionId: String): Int {
        val s = store.get(sessionId) ?: return 0
        return player.load(s)
    }

    /**
     * 加载由房主桌面端解析出的临时 HTTP(S) 播放地址。
     * @return 快照代号，0 表示地址或请求头没通过校验。
     */
    @JavascriptInterface
    fun playerLoadUrl(rawUrl: String, headersJson: String): Int {
        return try {
            val url = requirePublicHttpUrl(rawUrl)
            val headersObject = JSONObject(headersJson.ifBlank { "{}" })
            val allowed = setOf("accept", "accept-language", "origin", "referer", "user-agent")
            val headers = mutableMapOf<String, String>()
            headersObject.keys().forEach { rawName ->
                val name = rawName.trim().lowercase()
                val value = headersObject.optString(rawName, "")
                require(name in allowed && value.isNotBlank() && value.length <= 2048)
                require(!value.contains('\r') && !value.contains('\n'))
                headers[name] = value
            }
            player.loadRemote(url, headers)
        } catch (e: Exception) {
            Log.e(TAG, "playerLoadUrl 失败", e)
            0
        }
    }

    @JavascriptInterface
    fun playerSetPause(paused: Boolean) = player.setPause(paused)

    @JavascriptInterface
    fun playerSeek(seconds: Double) = player.seek(seconds)

    /**
     * @return 播放快照 JSON：{generation, position, duration, paused, idle, eof}（位置单位秒）。
     * `generation` 是这组读数属于哪个播放器：和最后一次 playerLoad/playerLoadUrl/playerRelease
     * 返回的数对不上，说明换片还没落到主线程，这条快照是上一部片的，整条丢弃。
     */
    @JavascriptInterface
    fun playerSnapshot(): String = player.snapshotJson()

    /** @return 这次释放的快照代号；释放完成前的快照仍带旧代号。 */
    @JavascriptInterface
    fun playerRelease(): Int = player.release()

    /* ------------------------------ 杂项 ------------------------------ */

    @JavascriptInterface
    fun log(msg: String) { Log.d(TAG, msg) }

    private fun requirePublicHttpUrl(raw: String): String {
        require(raw.length in 1..16384)
        val uri = URI(raw)
        require(uri.scheme.equals("http", true) || uri.scheme.equals("https", true))
        require(uri.userInfo == null && !uri.host.isNullOrBlank())
        val host = uri.host
        require(!host.equals("localhost", true) && !host.endsWith(".localhost", true))
        val addresses = InetAddress.getAllByName(host)
        require(addresses.isNotEmpty())
        require(addresses.none(::isPrivateAddress))
        return uri.toASCIIString()
    }

    private fun isPrivateAddress(address: InetAddress): Boolean {
        if (address.isAnyLocalAddress || address.isLoopbackAddress || address.isLinkLocalAddress ||
            address.isSiteLocalAddress || address.isMulticastAddress) return true
        val bytes = address.address.map { it.toInt() and 0xff }
        if (bytes.size == 4) {
            val (a, b, c) = bytes
            return a == 0 || a == 10 || a == 127 ||
                (a == 100 && b in 64..127) || (a == 169 && b == 254) ||
                (a == 172 && b in 16..31) || (a == 192 && (b == 168 || (b == 0 && c in 0..2))) ||
                (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100))) ||
                (a == 203 && b == 0 && c == 113) || a >= 224
        }
        if (bytes.size == 16) {
            if ((bytes[0] and 0xfe) == 0xfc || bytes[0] == 0xff) return true
            val mappedV4 = bytes.take(10).all { it == 0 } && bytes[10] == 0xff && bytes[11] == 0xff
            if (mappedV4) return isPrivateAddress(InetAddress.getByAddress(bytes.takeLast(4).map(Int::toByte).toByteArray()))
        }
        return false
    }

    companion object {
        const val NAME = "Native"
        private const val TAG = "NoxReel"
    }
}
