package com.syncwatch.app

import android.content.Context
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * 分片存储层。对应 PC 端的 fileStore.js（只保留 leech 一侧 —— 手机是纯观众）。
 *
 * 「边下边播」的支点是连续水位线 contiguousBytes：从文件头开始连续已落盘的字节数。
 * 播放器只能安全读到这里，往后是空洞。这里额外提供 [Session.awaitData]：
 * 播放器的自定义数据源读到水位线以外时会阻塞在这上面，等下载补上再往下读，
 * 而不是读出一堆 0 把解码器喂花。
 */
class Store(private val context: Context) {

    private val sessions = ConcurrentHashMap<String, Session>()
    private var seq = 0

    private fun mediaDir(): File = File(context.filesDir, "media").apply { mkdirs() }

    /**
     * 打开一个接收会话。清单由房主通过 DataChannel 发来，这里不自己算。
     * @return sessionId
     */
    fun openLeech(
        fileId: String,
        name: String,
        size: Long,
        chunkSize: Int,
        chunkCount: Int,
        hashesJson: String,
    ): String {
        val hashes = JSONArray(hashesJson).let { arr ->
            Array(arr.length()) { arr.getString(it) }
        }
        val dataFile = File(mediaDir(), "$fileId.dat")
        val partFile = File(mediaDir(), "$fileId.swpart")

        val raf = RandomAccessFile(dataFile, "rw")
        if (raf.length() != size) raf.setLength(size) // 预分配等大稀疏文件

        val session = Session(
            id = "leech-${System.currentTimeMillis().toString(36)}-${seq++}",
            dataFile = dataFile,
            partFile = partFile,
            raf = raf,
            size = size,
            chunkSize = chunkSize,
            chunkCount = chunkCount,
            hashes = hashes,
            displayName = name,
        )
        session.loadBitfield()
        sessions[session.id] = session
        return session.id
    }

    fun get(sessionId: String): Session? = sessions[sessionId]

    fun filePath(sessionId: String): String? = sessions[sessionId]?.dataFile?.absolutePath

    /** 断点续传状态：交给 swarm.setSession，让它知道本地已有哪些片。 */
    fun sessionState(sessionId: String): String =
        sessions[sessionId]?.stateJson() ?: "{}"

    /** 写入一片。渐进式校验：SHA-256 不过当场丢弃。返回 JSON 结果字符串。 */
    fun writeChunk(sessionId: String, index: Int, b64: String): String {
        val s = sessions[sessionId] ?: return err("no-session")
        if (index < 0 || index >= s.chunkCount) return err("bad-index")
        val bytes = Base64.decode(b64, Base64.NO_WRAP)
        return s.write(index, bytes)
    }

    /** 读出一片，base64 返回（用于把已有片转发给别的 peer）。 */
    fun readChunk(sessionId: String, index: Int): String? {
        val s = sessions[sessionId] ?: return null
        val bytes = s.read(index) ?: return null
        return Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    fun close(sessionId: String) {
        sessions.remove(sessionId)?.close()
    }

    private fun err(reason: String): String =
        JSONObject().put("ok", false).put("reason", reason).toString()

    /* ------------------------------------------------------------------ */

    class Session(
        val id: String,
        val dataFile: File,
        val partFile: File,
        private val raf: RandomAccessFile,
        val size: Long,
        val chunkSize: Int,
        val chunkCount: Int,
        private val hashes: Array<String>,
        val displayName: String,
    ) {
        private val have = BooleanArray(chunkCount)
        @Volatile var haveCount = 0; private set
        @Volatile private var contiguousIndex = 0
        @Volatile private var closed = false

        private val lock = ReentrantLock()
        private val progress = lock.newCondition()
        private var dirtyWrites = 0

        val complete: Boolean get() = haveCount == chunkCount

        /** 连续水位线：从头连续已落盘的字节数。 */
        fun contiguousBytes(): Long =
            minOf(contiguousIndex.toLong() * chunkSize, size)

        /** 位图打包成 base64（位序与 protocol.js 的 packBitfield 一致）+ 进度概况。 */
        fun stateJson(): String {
            lock.withLock {
                val bytes = ByteArray((chunkCount + 7) / 8)
                for (i in 0 until chunkCount) {
                    if (have[i]) bytes[i shr 3] =
                        (bytes[i shr 3].toInt() or (0x80 shr (i and 7))).toByte()
                }
                return JSONObject()
                    .put("bitfield", Base64.encodeToString(bytes, Base64.NO_WRAP))
                    .put("haveCount", haveCount)
                    .put("contiguousBytes", contiguousBytes())
                    .put("complete", complete)
                    .toString()
            }
        }

        private fun chunkLen(index: Int): Int =
            minOf(chunkSize.toLong(), size - index.toLong() * chunkSize).toInt()

        fun write(index: Int, bytes: ByteArray): String {
            lock.withLock {
                if (closed) return JSONObject().put("ok", false).put("reason", "closed").toString()
                if (have[index]) {
                    return JSONObject()
                        .put("ok", true).put("duplicate", true)
                        .put("haveCount", haveCount)
                        .put("contiguousBytes", contiguousBytes())
                        .put("complete", complete).toString()
                }
                val expectLen = chunkLen(index)
                if (bytes.size != expectLen) {
                    return JSONObject().put("ok", false).put("reason", "bad-length").toString()
                }
                // 渐进式校验：坏片当场拦住，不污染水位线
                if (sha256Hex(bytes) != hashes[index]) {
                    return JSONObject().put("ok", false).put("reason", "hash-mismatch").toString()
                }

                raf.seek(index.toLong() * chunkSize)
                raf.write(bytes)

                have[index] = true
                haveCount++
                if (index == contiguousIndex) {
                    while (contiguousIndex < chunkCount && have[contiguousIndex]) contiguousIndex++
                }

                // 唤醒可能正卡在水位线外等数据的播放器数据源
                progress.signalAll()

                dirtyWrites++
                if (dirtyWrites >= 32 || complete) { flushBitfield(); dirtyWrites = 0 }

                return JSONObject()
                    .put("ok", true).put("duplicate", false)
                    .put("haveCount", haveCount)
                    .put("contiguousBytes", contiguousBytes())
                    .put("complete", complete).toString()
            }
        }

        fun read(index: Int): ByteArray? {
            lock.withLock {
                if (index < 0 || index >= chunkCount || !have[index]) return null
                val len = chunkLen(index)
                val buf = ByteArray(len)
                raf.seek(index.toLong() * chunkSize)
                raf.readFully(buf)
                return buf
            }
        }

        /**
         * 供播放器数据源调用：从 pos 起至少要读到有数据可读。
         * 若 pos 已在水位线内立即返回可读字节数；否则阻塞等下载补齐。
         * @return 从 pos 起连续可读的字节数；文件读完或会话关闭返回 -1。
         */
        fun awaitData(pos: Long, timeoutMs: Long): Long {
            lock.withLock {
                while (true) {
                    if (closed) return -1
                    val cont = contiguousBytes()
                    if (pos < cont) return cont - pos
                    if (complete) {
                        // 全部下完，pos 若已到文件尾就是 EOF
                        return if (pos >= size) -1 else size - pos
                    }
                    if (!progress.await(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)) {
                        // 超时也回一圈重判，交由上层决定是否继续等
                        if (closed) return -1
                    }
                }
            }
        }

        /** 直接读文件字节（数据源用）。调用前应确保 pos+len 在水位线内。 */
        fun readAt(pos: Long, buffer: ByteArray, offset: Int, len: Int): Int {
            lock.withLock {
                if (closed) return -1
                raf.seek(pos)
                return raf.read(buffer, offset, len)
            }
        }

        fun close() {
            lock.withLock {
                if (closed) return
                closed = true
                flushBitfield()
                progress.signalAll()
                try { raf.close() } catch (_: Exception) {}
            }
        }

        /* --------------------------- 断点位图 --------------------------- */

        fun loadBitfield() {
            if (!partFile.exists()) return
            try {
                val bits = partFile.readBytes()
                var count = 0
                for (i in 0 until chunkCount) {
                    val byte = if (i shr 3 < bits.size) bits[i shr 3].toInt() else 0
                    if ((byte shr (7 - (i and 7))) and 1 == 1) { have[i] = true; count++ }
                }
                haveCount = count
                contiguousIndex = 0
                while (contiguousIndex < chunkCount && have[contiguousIndex]) contiguousIndex++
            } catch (_: Exception) { /* 位图坏了就当没进度，重下即可 */ }
        }

        private fun flushBitfield() {
            try {
                val bytes = ByteArray((chunkCount + 7) / 8)
                for (i in 0 until chunkCount) {
                    if (have[i]) bytes[i shr 3] = (bytes[i shr 3].toInt() or (0x80 shr (i and 7))).toByte()
                }
                partFile.writeBytes(bytes)
            } catch (_: Exception) {}
        }

        private fun sha256Hex(bytes: ByteArray): String {
            val d = MessageDigest.getInstance("SHA-256").digest(bytes)
            val sb = StringBuilder(d.size * 2)
            for (b in d) {
                val v = b.toInt() and 0xff
                sb.append(HEX[v shr 4]); sb.append(HEX[v and 0xf])
            }
            return sb.toString()
        }

        companion object {
            private val HEX = "0123456789abcdef".toCharArray()
        }
    }
}
