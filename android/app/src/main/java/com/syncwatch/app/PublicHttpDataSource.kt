package com.syncwatch.app

import android.net.Uri
import com.google.android.exoplayer2.C
import com.google.android.exoplayer2.PlaybackException
import com.google.android.exoplayer2.upstream.BaseDataSource
import com.google.android.exoplayer2.upstream.DataSource
import com.google.android.exoplayer2.upstream.DataSourceException
import com.google.android.exoplayer2.upstream.DataSpec
import com.google.android.exoplayer2.upstream.HttpDataSource.HttpDataSourceException
import com.google.android.exoplayer2.upstream.HttpDataSource.InvalidResponseCodeException
import com.google.android.exoplayer2.upstream.HttpUtil
import com.google.android.exoplayer2.util.Util
import java.io.IOException
import java.io.InputStream
import java.io.InterruptedIOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * 在线视频（房主解析好的直链、HLS、DASH）的数据源：每一次建连都只许连公网地址。
 *
 * 代替 DefaultHttpDataSource。那个数据源自己跟随重定向、连接时自己解析 DNS，
 * 我们插不进检查；HLS/DASH 的清单、分片、密钥也全都经它去连。这里把建连交给
 * [NetGuard.open]：重定向逐跳检查、跨协议不跟、明文 http 钉住检查过的 IP、
 * https 在套 TLS 前核对对端地址。其余行为照 DefaultHttpDataSource：Range 续读、
 * 服务器不认 Range 时自己跳过、不要透明 gzip、非 2xx 报 InvalidResponseCodeException
 * （播放器按它决定重试还是换轨）。
 *
 * 新增依赖（media3/okhttp）在这台构建机上拉不下来，所以没用 OkHttp 的自定义 Dns，
 * 只用系统自带的 HttpURLConnection。
 */
class PublicHttpDataSource(
    private val headers: Map<String, String>,
) : BaseDataSource(/* isNetwork = */ true) {

    private var dataSpec: DataSpec? = null
    private var uri: Uri? = null
    private var connection: HttpURLConnection? = null
    private var input: InputStream? = null
    private var opened = false
    private var bytesToRead = 0L
    private var bytesRead = 0L

    override fun open(dataSpec: DataSpec): Long {
        this.dataSpec = dataSpec
        bytesRead = 0
        bytesToRead = 0
        transferInitializing(dataSpec)

        val conn: HttpURLConnection
        val code: Int
        try {
            val (finalUrl, c) = NetGuard.open(URL(dataSpec.uri.toString()), { prepare(it, dataSpec) })
            conn = c
            connection = c
            uri = Uri.parse(finalUrl.toString())
            code = c.responseCode
        } catch (e: IOException) {
            closeConnectionQuietly()
            throw HttpDataSourceException.createForIOException(e, dataSpec, HttpDataSourceException.TYPE_OPEN)
        }

        if (code !in 200..299) {
            val headerFields = conn.headerFields
            if (code == 416) {
                // 要的位置正好是文件尾：不算错，给一段空内容
                val documentSize = HttpUtil.getDocumentSize(conn.getHeaderField("Content-Range"))
                if (dataSpec.position == documentSize) {
                    opened = true
                    transferStarted(dataSpec)
                    return if (dataSpec.length != C.LENGTH_UNSET.toLong()) dataSpec.length else 0L
                }
            }
            val message = runCatching { conn.responseMessage }.getOrNull()
            closeConnectionQuietly()
            val cause = if (code == 416) DataSourceException(PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE) else null
            throw InvalidResponseCodeException(code, message, cause, headerFields, dataSpec, Util.EMPTY_BYTE_ARRAY)
        }

        // 要了区间、服务器却回了整份（200）：自己跳过前面那段
        val bytesToSkip = if (code == 200 && dataSpec.position != 0L) dataSpec.position else 0L
        bytesToRead = if (dataSpec.length != C.LENGTH_UNSET.toLong()) {
            dataSpec.length
        } else {
            val length = HttpUtil.getContentLength(
                conn.getHeaderField("Content-Length"),
                conn.getHeaderField("Content-Range"),
            )
            if (length != C.LENGTH_UNSET.toLong()) length - bytesToSkip else C.LENGTH_UNSET.toLong()
        }

        try {
            input = conn.inputStream
            skipFully(bytesToSkip, dataSpec)
        } catch (e: IOException) {
            closeConnectionQuietly()
            if (e is DataSourceException) throw e
            throw HttpDataSourceException.createForIOException(e, dataSpec, HttpDataSourceException.TYPE_OPEN)
        }

        opened = true
        transferStarted(dataSpec)
        return bytesToRead
    }

    /** 每一跳都要设一遍：超时、房主给的请求头、Range。 */
    private fun prepare(conn: HttpURLConnection, spec: DataSpec) {
        conn.connectTimeout = CONNECT_TIMEOUT_MS
        conn.readTimeout = READ_TIMEOUT_MS
        conn.requestMethod = "GET"
        for ((name, value) in headers) conn.setRequestProperty(name, value)
        for ((name, value) in spec.httpRequestHeaders) {
            // Host 由 NetGuard 按原域名填，谁都不许改
            if (!name.equals("Host", ignoreCase = true)) conn.setRequestProperty(name, value)
        }
        HttpUtil.buildRangeRequestHeader(spec.position, spec.length)?.let { conn.setRequestProperty("Range", it) }
        // 不要透明 gzip：解压后的长度和 Range、Content-Length 对不上
        conn.setRequestProperty("Accept-Encoding", "identity")
    }

    private fun skipFully(count: Long, spec: DataSpec) {
        var left = count
        if (left <= 0) return
        val buffer = ByteArray(4096)
        val stream = input ?: return
        while (left > 0) {
            val n = stream.read(buffer, 0, minOf(left, buffer.size.toLong()).toInt())
            if (Thread.currentThread().isInterrupted) throw InterruptedIOException()
            if (n == -1) {
                throw HttpDataSourceException(
                    spec,
                    PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE,
                    HttpDataSourceException.TYPE_OPEN,
                )
            }
            left -= n
            bytesTransferred(n)
        }
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (length == 0) return 0
        var want = length
        if (bytesToRead != C.LENGTH_UNSET.toLong()) {
            val remaining = bytesToRead - bytesRead
            if (remaining <= 0L) return C.RESULT_END_OF_INPUT
            want = minOf(want.toLong(), remaining).toInt()
        }
        val stream = input ?: return C.RESULT_END_OF_INPUT
        val n = try {
            stream.read(buffer, offset, want)
        } catch (e: IOException) {
            throw HttpDataSourceException.createForIOException(
                e,
                dataSpec ?: DataSpec(Uri.EMPTY),
                HttpDataSourceException.TYPE_READ,
            )
        }
        if (n == -1) return C.RESULT_END_OF_INPUT
        bytesRead += n
        bytesTransferred(n)
        return n
    }

    override fun getUri(): Uri? = if (connection != null) uri else null

    override fun getResponseHeaders(): Map<String, List<String>> {
        val fields = connection?.headerFields ?: return emptyMap()
        // HttpURLConnection 把状态行放在键为 null 的那一项里
        val out = LinkedHashMap<String, List<String>>()
        for ((name, values) in fields) if (name != null) out[name] = values
        return out
    }

    override fun close() {
        try {
            // 先断开再关流：关流时 HttpURLConnection 会想把剩下的响应体读完好复用连接，
            // 对一部还没下完的片子那就是白白多等
            closeConnectionQuietly()
            runCatching { input?.close() }
        } finally {
            input = null
            dataSpec = null
            if (opened) {
                opened = false
                transferEnded()
            }
        }
    }

    private fun closeConnectionQuietly() {
        runCatching { connection?.disconnect() }
        connection = null
    }

    class Factory(private val headers: Map<String, String>) : DataSource.Factory {
        override fun createDataSource(): DataSource = PublicHttpDataSource(headers)
    }

    companion object {
        private const val CONNECT_TIMEOUT_MS = 15_000
        private const val READ_TIMEOUT_MS = 30_000
    }
}
