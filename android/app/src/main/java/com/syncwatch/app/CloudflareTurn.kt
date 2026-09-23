package com.syncwatch.app

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.security.KeyStore
import java.util.Calendar
import java.util.TimeZone
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** 带代码的错误。message 形如「[CF_NETWORK] 说明」，和桌面端主进程同一个格式，页面按代码说人话。 */
class CfException(val code: String, detail: String) : Exception("[$code] $detail")

/**
 * Cloudflare TURN（安卓原生层）：拿用户自己的 Cloudflare 账号，现取 24 小时有效的 TURN 用户名密码。
 * 规则和桌面端 src/main/cloudflareTurn.js 一条一条对应，改之前两边一起看：
 *
 *  - **API Token 只进不出**：保存时先真的调一次生成接口验证，成功才用安卓系统密钥库（AndroidKeyStore，
 *    AES-GCM，密钥不出系统）加密落盘；之后只有这个类读它。不回传给页面，不写日志，报错信息里也不带它。
 *    密钥库用不了就拒绝保存 —— 宁可不存，也不明文落盘。
 *  - **端口 53 一律去掉**：浏览器内核会拦这个端口，候选收集要干等到超时。Cloudflare 的响应里恰好带着它。
 *  - **只认 turn.cloudflare.com**：响应再怎么写，也不许把中继指到别的主机上。
 *  - **不跟随跳转**：带着 Authorization 头被引到别处去不是我们想要的。
 *  - **本机月用量到了用户设的上限就不再发新账号**（CF_QUOTA）。Cloudflare 自己没有「超量自动停」，
 *    由页面按连接的 getStats() 汇报经 Cloudflare 中继的字节数，这里按 UTC 自然月累加、落盘。
 *
 * 所有方法都在 [NativeBridge] 的单线程执行器上跑，互相不会并发：同时只有一个生成请求在路上。
 */
class CloudflareTurn(private val dir: File) {

    data class Creds(val urls: List<String>, val username: String, val credential: String, val expiresAt: Long)

    private data class Usage(var month: String, var usedBytes: Long, var limitGB: Int, var warned: Boolean)

    private val credFile = File(dir, CREDENTIAL_FILE)
    private val usageFile = File(dir, USAGE_FILE)
    private var cache: Creds? = null
    private var lastError: String? = null
    // 换代：保存了新凭据或清除之后，之前那次请求的结果不再写进缓存
    private var gen = 0
    private var usage: Usage? = null

    /** 分发 JS 桥过来的动作。返回值原样放进回复的 value。 */
    fun dispatch(action: String, args: JSONObject): Any = when (action) {
        "save" -> save(args.optString("keyId", ""), args.optString("apiToken", ""))
        "clear" -> clear()
        "status" -> status()
        "credentials" -> credentials(wholeNumber(args.opt("minValidMs"), 0, MAX_MIN_VALID_MS))
        "addUsage" -> addUsage(wholeNumber(args.opt("bytes"), 0, MAX_USAGE_REPORT))
        "setLimit" -> setLimit(wholeNumber(args.opt("limitGB"), MIN_LIMIT_GB.toLong(), MAX_LIMIT_GB.toLong()).toInt())
        else -> throw CfException("CF_INVALID_INPUT", "不认识的动作")
    }

    /* ------------------------------- 凭据 ------------------------------- */

    /** 保存凭据：先校验格式、确认密钥库能用，再真的调一次生成接口，成功才加密落盘。返回 status()，里面没有 Token。 */
    fun save(keyId: String, apiToken: String): JSONObject {
        if (!isValidKeyId(keyId)) throw CfException("CF_INVALID_INPUT", "Turn Token ID 格式不对")
        if (!isValidApiToken(apiToken)) throw CfException("CF_INVALID_INPUT", "API Token 格式不对")
        val key = try {
            secretKey()
        } catch (e: Exception) {
            throw CfException("CF_NO_ENCRYPTION", "本机的加密服务不可用，不能安全地保存 API Token，所以没有保存")
        }
        val startedAt = System.currentTimeMillis()
        val creds = generate(keyId, apiToken)
        val sealed = try {
            seal(key, JSONObject().put("keyId", keyId).put("apiToken", apiToken).toString())
        } catch (e: Exception) {
            throw CfException("CF_NO_ENCRYPTION", "本机的加密服务不可用，不能安全地保存 API Token，所以没有保存")
        }
        writeAtomic(credFile, JSONObject().put("version", 1).put("iv", sealed.first).put("secret", sealed.second).toString())
        gen += 1
        cache = creds.copy(expiresAt = startedAt + TTL_SEC * 1000 - CACHE_MARGIN_MS)
        lastError = null
        return status()
    }

    /** 读出保存的凭据。没有、坏了、解不开都算「没配置」。 */
    private fun readSecret(): Pair<String, String> {
        if (!credFile.exists()) throw CfException("CF_NOT_CONFIGURED", "还没保存 Cloudflare 凭据")
        try {
            val data = JSONObject(credFile.readText(Charsets.UTF_8))
            val plain = JSONObject(open(data.getString("iv"), data.getString("secret")))
            val keyId = plain.optString("keyId", "")
            val apiToken = plain.optString("apiToken", "")
            if (isValidKeyId(keyId) && isValidApiToken(apiToken)) return keyId to apiToken
        } catch (e: Exception) {
            /* 落到下面 */
        }
        throw CfException("CF_NOT_CONFIGURED", "保存的凭据解不开，请重新保存")
    }

    /**
     * 一组能用的临时 TURN 账号。缓存期内直接复用；缓存剩下的时间不到 minValidMs 就重新生成。
     * 本月用量到了上限就直接抛 CF_QUOTA，连缓存都不给。
     */
    fun credentials(minValidMs: Long): JSONObject {
        val u = usageJson()
        if (u.getBoolean("exceeded")) {
            lastError = "CF_QUOTA"
            throw CfException("CF_QUOTA", "本月用量已到上限（${u.getInt("limitGB")} GB）")
        }
        cache?.let { if (it.expiresAt - System.currentTimeMillis() > minValidMs) return credsJson(it) }
        val myGen = gen
        try {
            val (keyId, apiToken) = readSecret()
            val startedAt = System.currentTimeMillis()
            val entry = generate(keyId, apiToken).copy(expiresAt = startedAt + TTL_SEC * 1000 - CACHE_MARGIN_MS)
            if (myGen == gen) {
                cache = entry
                lastError = null
            }
            return credsJson(entry)
        } catch (e: CfException) {
            if (myGen == gen) lastError = e.code
            throw e
        }
    }

    /** 删掉凭据文件、清缓存。本机月用量不动：它记的是这个月实际用掉的流量。 */
    fun clear(): JSONObject {
        gen += 1
        cache = null
        lastError = null
        runCatching { credFile.delete() }
        return status()
    }

    /** 设置里要的状态。没有 Token，也没有 Turn Token ID。 */
    fun status(): JSONObject = JSONObject()
        .put("configured", credFile.exists())
        .put("expiresAt", cache?.expiresAt ?: JSONObject.NULL)
        .put("lastError", lastError ?: JSONObject.NULL)
        .put("usage", usageJson())

    private fun credsJson(c: Creds): JSONObject = JSONObject()
        .put("urls", JSONArray(c.urls))
        .put("username", c.username)
        .put("credential", c.credential)
        .put("expiresAt", c.expiresAt)

    /* ---------------------------- 生成接口 ---------------------------- */

    /** 调一次生成接口。所有网络层的失败都归成 CF_NETWORK；Token 不进任何一条报错和日志。 */
    private fun generate(keyId: String, apiToken: String): Creds {
        val conn = try {
            URL("$ENDPOINT/$keyId/credentials/generate-ice-servers").openConnection() as HttpURLConnection
        } catch (e: Exception) {
            throw CfException("CF_NETWORK", "连不上 Cloudflare")
        }
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = REQUEST_TIMEOUT_MS
            conn.readTimeout = REQUEST_TIMEOUT_MS
            conn.instanceFollowRedirects = false
            conn.useCaches = false
            conn.doOutput = true
            conn.setRequestProperty("Authorization", "Bearer $apiToken")
            conn.setRequestProperty("Content-Type", "application/json")
            val deadline = System.currentTimeMillis() + REQUEST_TIMEOUT_MS
            val status = try {
                conn.outputStream.use { it.write("{\"ttl\":$TTL_SEC}".toByteArray(Charsets.UTF_8)) }
                conn.responseCode
            } catch (e: SocketTimeoutException) {
                throw CfException("CF_NETWORK", "请求超时")
            } catch (e: IOException) {
                throw CfException("CF_NETWORK", "连不上 Cloudflare")
            }
            if (status == 401 || status == 403) throw CfException("CF_UNAUTHORIZED", "HTTP $status")
            if (status !in 200..299) throw CfException("CF_BAD_RESPONSE", "HTTP $status")
            if (conn.contentLengthLong > MAX_RESPONSE_BYTES) throw CfException("CF_BAD_RESPONSE", "响应体过大")
            val text = try {
                conn.inputStream.use { readLimited(it, deadline) }
            } catch (e: CfException) {
                throw e
            } catch (e: IOException) {
                throw CfException("CF_NETWORK", if (e is SocketTimeoutException) "请求超时" else "响应没收完")
            }
            val body = try {
                JSONObject(text)
            } catch (e: Exception) {
                throw CfException("CF_BAD_RESPONSE", "响应不是 JSON")
            }
            return pickTurnServer(body)
        } finally {
            conn.disconnect()
        }
    }

    /** 读响应体，按字节封顶；整个请求也有总时限（readTimeout 只管两次读之间）。 */
    private fun readLimited(input: InputStream, deadline: Long): String {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(8192)
        while (true) {
            if (System.currentTimeMillis() > deadline) throw CfException("CF_NETWORK", "请求超时")
            val n = input.read(buf)
            if (n < 0) break
            if (out.size() + n > MAX_RESPONSE_BYTES) throw CfException("CF_BAD_RESPONSE", "响应体过大")
            out.write(buf, 0, n)
        }
        return out.toString("UTF-8")
    }

    /* ------------------------------ 月用量 ------------------------------ */

    /** 懒加载用量文件。读不出来就从零开始，上限用默认值。 */
    private fun loadUsage(): Usage {
        usage?.let { return it }
        var data = JSONObject()
        try {
            if (usageFile.exists()) data = JSONObject(usageFile.readText(Charsets.UTF_8))
        } catch (e: Exception) {
            data = JSONObject()
        }
        val used = data.optLong("usedBytes", 0L)
        val limit = data.optInt("limitGB", DEFAULT_LIMIT_GB)
        val loaded = Usage(
            month = data.optString("month", "").ifEmpty { monthKey(System.currentTimeMillis()) },
            usedBytes = if (used >= 0) used else 0L,
            limitGB = if (limit in MIN_LIMIT_GB..MAX_LIMIT_GB) limit else DEFAULT_LIMIT_GB,
            warned = data.optBoolean("warned", false),
        )
        usage = loaded
        return loaded
    }

    /** 跨月清零（UTC）。上限是用户的设置，不跟着清。 */
    private fun rollover(): Usage {
        val u = loadUsage()
        val current = monthKey(System.currentTimeMillis())
        if (u.month != current) {
            u.month = current
            u.usedBytes = 0
            u.warned = false
        }
        return u
    }

    private fun persistUsage() {
        val u = usage ?: return
        writeAtomic(
            usageFile,
            JSONObject()
                .put("version", 1)
                .put("month", u.month)
                .put("usedBytes", u.usedBytes)
                .put("limitGB", u.limitGB)
                .put("warned", u.warned)
                .toString()
        )
    }

    /** 本月用量：{ month, usedBytes, limitGB, limitBytes, exceeded, nearLimit }。 */
    private fun usageJson(): JSONObject {
        val u = rollover()
        val limitBytes = u.limitGB.toLong() * BYTES_PER_GB
        return JSONObject()
            .put("month", u.month)
            .put("usedBytes", u.usedBytes)
            .put("limitGB", u.limitGB)
            .put("limitBytes", limitBytes)
            .put("exceeded", u.usedBytes >= limitBytes)
            .put("nearLimit", u.usedBytes >= limitBytes * WARN_PERCENT / 100)
    }

    /** 记一笔增量（字节）。第一次越过 80% 的那一笔额外带 crossedWarn: true，每个月只带一次。 */
    fun addUsage(bytes: Long): JSONObject {
        val u = rollover()
        u.usedBytes = if (Long.MAX_VALUE - u.usedBytes < bytes) Long.MAX_VALUE else u.usedBytes + bytes
        var crossedWarn = false
        if (!u.warned && u.usedBytes >= u.limitGB.toLong() * BYTES_PER_GB * WARN_PERCENT / 100) {
            u.warned = true
            crossedWarn = true
        }
        persistUsage()
        return usageJson().put("crossedWarn", crossedWarn)
    }

    /** 改月上限（GB，1–1000）。调高到 80% 以下时，80% 的提醒下次还会再来一次。 */
    fun setLimit(limitGB: Int): JSONObject {
        val u = rollover()
        u.limitGB = limitGB
        if (u.usedBytes < limitGB.toLong() * BYTES_PER_GB * WARN_PERCENT / 100) u.warned = false
        persistUsage()
        return usageJson()
    }

    /* ---------------------------- 系统密钥库 ---------------------------- */

    private fun secretKey(): SecretKey {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (ks.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    /** AES-GCM 加密。返回 (iv, 密文) 的 base64。iv 由密钥库生成（不允许调用方指定）。 */
    private fun seal(key: SecretKey, plain: String): Pair<String, String> {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key)
        val ct = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return b64(cipher.iv) to b64(ct)
    }

    private fun open(iv: String, secret: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, unb64(iv)))
        return String(cipher.doFinal(unb64(secret)), Charsets.UTF_8)
    }

    /** 先写临时文件再改名：写一半断电也不会留下半截 JSON。 */
    private fun writeAtomic(target: File, text: String) {
        dir.mkdirs()
        val tmp = File(dir, "${target.name}.tmp")
        tmp.writeText(text, Charsets.UTF_8)
        if (!tmp.renameTo(target)) {
            target.delete()
            if (!tmp.renameTo(target)) throw CfException("CF_NETWORK", "写不进本机存储")
        }
    }

    companion object {
        private const val ENDPOINT = "https://rtc.live.cloudflare.com/v1/turn/keys"
        const val TTL_SEC = 86400L
        // 缓存到「生成时刻 + ttl − 1 小时」：别拿一组快过期的账号去建一条要连好几个小时的连接
        const val CACHE_MARGIN_MS = 60 * 60 * 1000L
        const val REQUEST_TIMEOUT_MS = 10_000
        const val MAX_RESPONSE_BYTES = 64 * 1024
        private const val MAX_CREDENTIAL_LENGTH = 1024
        const val TURN_HOST = "turn.cloudflare.com"
        // 浏览器内核拦下的端口：候选收集会一直等到超时
        private val BLOCKED_PORTS = setOf(53)
        private const val CREDENTIAL_FILE = "cloudflare-turn.json"
        private const val USAGE_FILE = "cloudflare-turn-usage.json"
        private const val KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "noxreel-cloudflare-turn"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"

        const val BYTES_PER_GB = 1_000_000_000L
        const val DEFAULT_LIMIT_GB = 900 // 免费额度 1000 GB，留 100 GB 余量（本机统计和账单难免有出入）
        const val MIN_LIMIT_GB = 1
        const val MAX_LIMIT_GB = 1000
        private const val WARN_PERCENT = 80L
        // 和桌面端主进程的校验上限一致
        const val MAX_MIN_VALID_MS = 3 * 60 * 60 * 1000L
        const val MAX_USAGE_REPORT = 64L * BYTES_PER_GB

        /** Turn Token ID：只能是字母数字，8–128 位。它会拼进请求路径，字符集必须收得很窄。 */
        fun isValidKeyId(value: String): Boolean = Regex("^[A-Za-z0-9]{8,128}$").matches(value)

        /** API Token：可打印的 ASCII，不含空白，16–512 位。它会写进 Authorization 头，控制字符和换行进不得。 */
        fun isValidApiToken(value: String): Boolean =
            value.length in 16..512 && value.all { it.code in 0x21..0x7e }

        /** 参数里的整数：必须是 JSON 整数，且在范围内。1.5、"12"、超范围的一律不收。 */
        fun wholeNumber(value: Any?, min: Long, max: Long): Long {
            val n = when (value) {
                is Int -> value.toLong()
                is Long -> value
                else -> throw CfException("CF_INVALID_INPUT", "参数不是整数")
            }
            if (n < min || n > max) throw CfException("CF_INVALID_INPUT", "参数超出范围")
            return n
        }

        /** UTC 自然月，形如 2026-09。 */
        fun monthKey(ms: Long): String {
            val c = Calendar.getInstance(TimeZone.getTimeZone("UTC"))
            c.timeInMillis = ms
            return String.format(java.util.Locale.ROOT, "%04d-%02d", c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1)
        }

        private val TURN_URL = Regex("^(turns?):([A-Za-z0-9.-]+)(?::(\\d{1,5}))?(\\?transport=(?:udp|tcp))?$", RegexOption.IGNORE_CASE)

        /** 能交给浏览器内核的 Cloudflare 中继地址：主机必须是 turn.cloudflare.com，端口不能是 53。 */
        fun isUsableTurnUrl(url: String): Boolean {
            if (url.length > 256) return false
            val m = TURN_URL.matchEntire(url) ?: return false
            val scheme = m.groupValues[1].lowercase()
            val host = m.groupValues[2].lowercase()
            val port = m.groupValues[3].ifEmpty { if (scheme == "turns") "5349" else "3478" }.toIntOrNull() ?: return false
            return host == TURN_HOST && port in 1..65535 && port !in BLOCKED_PORTS
        }

        /**
         * 从生成接口的响应里挑出那条 TURN。新接口给数组（一条 STUN 一条 TURN），老接口给单个对象，两种都认。
         * STUN 那条没有用户名密码，地址也过不了 isUsableTurnUrl，自然被跳过。
         */
        fun pickTurnServer(body: JSONObject): Creds {
            val servers = when (val raw = body.opt("iceServers")) {
                is JSONArray -> raw
                is JSONObject -> JSONArray().put(raw)
                else -> throw CfException("CF_BAD_RESPONSE", "响应里没有 iceServers")
            }
            if (servers.length() > 16) throw CfException("CF_BAD_RESPONSE", "响应里没有 iceServers")
            for (i in 0 until servers.length()) {
                val server = servers.optJSONObject(i) ?: continue
                val rawUrls = server.opt("urls")
                val list: List<Any?> = if (rawUrls is JSONArray) List(rawUrls.length()) { rawUrls.opt(it) } else listOf(rawUrls)
                if (list.size > 32) continue
                val urls = mutableListOf<String>()
                for (u in list) if (u is String && isUsableTurnUrl(u) && u !in urls) urls.add(u)
                if (urls.isEmpty()) continue
                val username = server.opt("username")
                val credential = server.opt("credential")
                if (username !is String || username.isEmpty() || username.length > MAX_CREDENTIAL_LENGTH) {
                    throw CfException("CF_BAD_RESPONSE", "TURN 用户名不合格")
                }
                if (credential !is String || credential.isEmpty() || credential.length > MAX_CREDENTIAL_LENGTH) {
                    throw CfException("CF_BAD_RESPONSE", "TURN 密码不合格")
                }
                return Creds(urls, username, credential, 0L)
            }
            throw CfException("CF_BAD_RESPONSE", "响应里没有可用的 TURN 地址")
        }

        private fun b64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)
        private fun unb64(text: String): ByteArray = Base64.decode(text, Base64.NO_WRAP)
    }
}
