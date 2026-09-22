package com.syncwatch.app

import android.content.Context
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * 分片存储层。对应 PC 端的 fileStore.js（只保留 leech 一侧 —— 手机是纯观众）。
 *
 * 这里有两条不同的「水位线」，千万别混用：
 * - contiguousBytes()：从**文件头**起连续已落盘的字节数，只代表**完整度**
 *   （进度显示、完整性判断）。
 * - [Session.awaitData] 返回的可读长度：从**当前播放位置**起连续已落盘的字节数
 *   （与桌面端 swarm.js 的 runEndFrom() 同一算法），代表**播放器现在还能安全读多远**。
 *   中途加入房间时 [0, P) 整段是空洞，两者相差整整一部片。
 *
 * 播放器的自定义数据源读到当前连续区末尾时会阻塞在 awaitData 上，等分片补上再往下读，
 * 而不是读出一堆 0 把解码器喂花。
 */
class Store(private val context: Context) {

    private val sessions = ConcurrentHashMap<String, Session>()
    private var seq = 0

    // 和桌面端主进程的 FILE_ID_RE 对齐：fileId 由所有分片哈希推导，只可能是 32 位十六进制。
    private val FILE_ID_RE = Regex("^[a-f0-9]{8,64}$")

    private fun mediaDir(): File = File(context.filesDir, "media").apply { mkdirs() }

    /**
     * 接收缓存所在分区的可用字节数。
     *
     * 两个地方读它，必须是同一个数：[openLeech] 开会话前的空间检查，和 JS 侧
     * （`Native.usableSpace()`）决定要不要为下一项再开一个会话的空间预算。
     * 判据分家的话，会出现「JS 觉得放得下、原生这边直接 require 失败」的自相矛盾。
     *
     * 查不到时返回 0（File.usableSpace 在拿不到配额时就返回 0），调用方一律把 0
     * 解释成「不知道」而不是「没空间」—— 别拦，让真正的写入错误说话。
     */
    fun usableSpace(): Long = runCatching { mediaDir().usableSpace }.getOrDefault(0L)

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
        // fileId 来自对端的 MANIFEST 控制消息，直接拼进文件名等于把路径交给对方。
        // 含 ".." 的 fileId 会让接收缓存落到 media 目录之外，既不受清理管辖，
        // 内容还完全由对方决定。桌面端主进程有 FILE_ID_RE 挡这一层，这边一直没有。
        require(FILE_ID_RE.matches(fileId)) { "非法的 fileId" }
        require(sessions.size < MAX_SESSIONS) { "同时打开的接收会话太多" }
        val hashes = JSONArray(hashesJson).let { arr ->
            Array(arr.length()) { arr.getString(it) }
        }
        // 清单的尺寸全由对端给出，这里自己再核一遍，别把后面的分配和按片写盘交给对方决定：
        // 片长 1 字节的「100MB 文件」要分配上亿个元素，直接把 App 撑爆；哈希条数不够时
        // 写到后面的片会越界崩掉；片数比文件大小算出来的多，多出来的片会写到文件尾之外。
        manifestProblem(size, chunkSize, chunkCount, hashes.size)?.let { throw IllegalArgumentException(it) }
        require(hashes.all { HASH_RE.matches(it) }) { "清单里的分片哈希格式不对" }
        val dataFile = File(mediaDir(), "$fileId.dat")
        val partFile = File(mediaDir(), "$fileId.swpart")
        require(dataFile.canonicalPath.startsWith(mediaDir().canonicalPath + File.separator)) {
            "接收缓存路径越界"
        }

        // 文件大小不再设上限以后，一部片子塞满手机存储就是常态风险。setLength 在 ext4/f2fs
        // 上是稀疏的，照样成功，要传到一半才写不进去 —— 所以开会话前先看剩余空间够不够。
        // 留 1% 或 256MB 余量（取大），和桌面端 ensureFreeSpace 一致。usableSpace 查不到时
        // 返回 0，这时不拦，让真正的写入错误说话。
        val free = usableSpace()
        val reserve = maxOf(256L * 1024 * 1024, size / 100)
        require(free <= 0L || free >= size + reserve) {
            val gb = 1024.0 * 1024 * 1024
            String.format(Locale.ROOT, "磁盘空间不够：这部片子需要 %.2fGB，手机只剩 %.2fGB", size / gb, free / gb)
        }

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
        // 解码要先按串长分配整块内存：长度已经不对的串，别等解出来再拦
        if (b64.length > base64Chars(s.chunkLen(index))) return err("bad-length")
        val bytes = Base64.decode(b64, Base64.NO_WRAP)
        return s.write(index, bytes)
    }

    /** 读出一片，base64 返回（用于把已有片转发给别的 peer）。 */
    fun readChunk(sessionId: String, index: Int): String? {
        val s = sessions[sessionId] ?: return null
        val bytes = s.read(index) ?: return null
        return Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    /**
     * 关闭会话。
     *
     * 接收缓存必须在这里删掉：换片、退房走的都是这一条路，而 Android 侧
     * 此前没有任何地方删过它们。文件在 filesDir（不是 cacheDir），系统的
     * 存储压力回收也永远不会碰 —— 连看三部 4GB 的片就是 12GB 躺在内部存储里，
     * 用户在应用里看不到也删不掉，只能去系统设置「清除应用数据」。
     * 而界面上一直在向用户承诺「退出房间后会自动删除缓存」。
     *
     * 做种会话（本机自有文件）不删：那是用户自己的片子，不是我们生成的缓存。
     */
    fun close(sessionId: String) {
        val session = sessions.remove(sessionId) ?: return
        session.close()
        // 手机端是纯观众，会话产物一律是我们自己生成的接收缓存，删干净即可。
        runCatching { session.dataFile.delete() }
        runCatching { session.partFile.delete() }
    }

    /**
     * 启动时回收上次异常退出留下的缓存。
     *
     * 进程被系统杀掉时 close() 根本不会被调用，那批文件会一直留着。
     * 这里只清 media 目录下我们自己生成的 .dat/.swpart，且只清当前没有会话
     * 正在用的 —— 冷启动时 sessions 本来就是空的。
     */
    /** 关掉所有会话（应用退出时）。每个会话的接收缓存跟着删。 */
    fun closeAll() {
        for (id in sessions.keys.toList()) close(id)
    }

    fun cleanupStale() {
        val inUse = sessions.values.mapNotNull { it.dataFile.name }.toSet()
        mediaDir().listFiles()?.forEach { f ->
            if (f.name in inUse) return@forEach
            if (f.name.endsWith(".dat") || f.name.endsWith(".swpart")) runCatching { f.delete() }
        }
    }

    private fun err(reason: String): String =
        JSONObject().put("ok", false).put("reason", reason).toString()

    companion object {
        /** 同时开着的接收会话上限。JS 最多开两个（当前项 + 下一项），多留一点余量。 */
        const val MAX_SESSIONS = 4

        /** 片长范围。桌面端固定 2MB；上下各留足余量，只挡明显不对的清单。 */
        const val MIN_CHUNK_SIZE = 64 * 1024
        const val MAX_CHUNK_SIZE = 16 * 1024 * 1024

        private val HASH_RE = Regex("^[a-f0-9]{64}$")

        /**
         * 清单的尺寸信息说得通吗？说得通返回 null，否则返回原因（会原样显示给用户）。
         * 与 swarm.js 的 manifestShapeOk 同一套判据，外加片长的上下限。
         */
        fun manifestProblem(size: Long, chunkSize: Int, chunkCount: Int, hashCount: Int): String? {
            if (size <= 0) return "清单里的文件大小不对"
            if (chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) return "清单里的分片大小不对"
            if (chunkCount.toLong() != Math.floorDiv(size + chunkSize - 1, chunkSize.toLong())) {
                return "清单里的分片数和文件大小对不上"
            }
            if (hashCount != chunkCount) return "清单里的分片哈希条数不对"
            return null
        }

        /** [bytes] 个字节编成不换行的 base64 有多少个字符。 */
        fun base64Chars(bytes: Int): Int = Math.floorDiv(bytes + 2, 3) * 4
    }

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

        fun chunkLen(index: Int): Int =
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

                // 唤醒可能正卡在连续区末尾等数据的播放器数据源
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
         * 从 pos 起连续可读的字节数；pos 所在分片还没收到就返回 0。调用方持锁。
         *
         * 这是「播放器从当前位置能安全读到哪」的唯一算法，与桌面端 swarm.js 的
         * runEndFrom() 必须保持一致：看的是 **pos 所在分片开始的那一段连续已收片**，
         * 不是从文件头起的连续水位线 contiguousBytes()。中途加入房间时播放位置 P
         * 之前全是空洞，按水位线算会永远报 0。
         */
        private fun readableFrom(pos: Long): Long {
            if (pos < 0 || pos >= size) return 0
            val k = (pos / chunkSize).toInt()
            if (k >= chunkCount || !have[k]) return 0
            var i = k
            while (i < chunkCount && have[i]) i++
            // 末片比 chunkSize 小，按文件大小封顶，别报出文件尾以外的字节
            return minOf(i.toLong() * chunkSize, size) - pos
        }

        /**
         * 供播放器数据源调用：阻塞到 pos 处有数据可读为止。
         * @return 从 pos 起连续可读的字节数；真到文件尾或会话关闭返回 -1。
         *
         * 三条必须守住的不变量：
         * ① pos 所在分片还没收到时**绝不能**返回 -1 —— ExoPlayer 把 END_OF_INPUT 当作
         *   文件到头，会直接进 ENDED（表现是中途加入的人刚进房就「放完了」）。
         *   这里只能继续阻塞等分片补上。
         * ② complete（全片收齐）的情形已被 readableFrom 覆盖（返回 size - pos），
         *   不需要特判；收齐了还读不出来只可能是越界，那才返回 -1。
         * ③ 真 EOF（pos >= size）仍然返回 -1。
         */
        fun awaitData(pos: Long, timeoutMs: Long): Long {
            lock.withLock {
                while (true) {
                    if (closed) return -1
                    if (pos < 0 || pos >= size) return -1   // 真 EOF / 越界
                    val n = readableFrom(pos)
                    if (n > 0) return n
                    // 收完了还读不到 = 越界；没收完就继续等，绝不能当 EOF 返回 -1
                    if (complete) return -1
                    // 超时也回一圈重判，交由上层决定是否继续等
                    progress.await(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
                }
            }
        }

        /** 直接读文件字节（数据源用）。调用前应确保 pos+len 落在 awaitData 报出的连续区内。 */
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
