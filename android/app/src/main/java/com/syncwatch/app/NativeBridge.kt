package com.syncwatch.app

import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.net.InetAddress
import java.net.URI
import java.net.URL

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
            // 合法的请求头最多五条、每条 2KB，整串不可能比这长；超长的不去解析
            require(headersJson.length <= MAX_HEADERS_JSON_CHARS)
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

    /** 位置来自同步消息：NaN、无穷大、负数一律不往播放器里送。 */
    @JavascriptInterface
    fun playerSeek(seconds: Double) {
        if (!seconds.isFinite()) return
        player.seek(seconds.coerceAtLeast(0.0))
    }

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

    /* ------------------------------ 房间 ------------------------------ */

    /**
     * 离开房间：播放器释放、所有接收会话关掉（缓存跟着删）。页面随后自己整页重载 ——
     * 只重载页面的话，原生这边的会话和播放器没人收，缓存要一直躺到下次冷启动。
     */
    @JavascriptInterface
    fun leaveRoom() {
        player.release()
        store.closeAll()
    }

    /** 安装包版本号（build.gradle 的 versionName），大厅里显示成「v0.7.4」。 */
    @JavascriptInterface
    fun appVersion(): String = BuildConfig.VERSION_NAME

    /* ------------------------------ 杂项 ------------------------------ */

    /** logcat 单条本来就只显示 4KB 左右，超长的截掉，别让一条日志拖着几 MB 的字符串过桥。 */
    @JavascriptInterface
    fun log(msg: String) { Log.d(TAG, if (msg.length > MAX_LOG_CHARS) msg.take(MAX_LOG_CHARS) + "…" else msg) }

    /**
     * 只看字面，不查 DNS：这个方法在 JS 桥线程上跑，JS 那边同步等着返回，
     * 一次慢吞吞的 DNS（房主完全可以挑一个故意拖着不答的域名）就能把整页卡住好几秒。
     * 真正的地址检查在播放器每一次建连时做（[NetGuard.open]），那里挡得住重定向、
     * HLS/DASH 子资源和 DNS 重绑定；这里只把一眼就能看出来的内网地址提前拒掉。
     */
    private fun requirePublicHttpUrl(raw: String): String {
        require(raw.length in 1..16384)
        val uri = URI(raw)
        require(uri.scheme.equals("http", true) || uri.scheme.equals("https", true))
        require(uri.userInfo == null && !uri.host.isNullOrBlank())
        val ascii = uri.toASCIIString()
        NetGuard.checkUrlShape(URL(ascii))
        literalAddress(NetGuard.bareHost(uri.host))?.let { require(!NetGuard.isPrivateAddress(it)) }
        return ascii
    }

    /** 主机名本身就是 IP 字面量时直接换成地址（不经 DNS）；是域名就返回 null。 */
    private fun literalAddress(host: String): InetAddress? {
        if (IPV4_LITERAL.matches(host)) {
            val octets = host.split('.').map { it.toInt() }
            if (octets.any { it > 255 }) return null
            return InetAddress.getByAddress(ByteArray(4) { octets[it].toByte() })
        }
        // URI 只放行语法正确的 IPv6 字面量，按字面解析，不会去查 DNS
        return if (host.contains(':')) InetAddress.getByName(host) else null
    }

    companion object {
        const val NAME = "Native"
        private const val TAG = "NoxReel"
        private const val MAX_LOG_CHARS = 4000
        private const val MAX_HEADERS_JSON_CHARS = 16 * 1024
        private val IPV4_LITERAL = Regex("""^\d{1,3}(\.\d{1,3}){3}$""")
    }
}
