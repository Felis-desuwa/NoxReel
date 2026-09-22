package com.syncwatch.app

import java.io.IOException
import java.net.HttpURLConnection
import java.net.Inet6Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ProtocolException
import java.net.Proxy
import java.net.Socket
import java.net.URL
import java.net.UnknownHostException
import java.util.Locale
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLSocketFactory

/**
 * 房主发来的在线视频地址只许连公网。
 *
 * 只在加载前查一次域名是不够的，至少有三条路能绕过去：
 * - 同协议的 3xx 重定向由 HttpURLConnection 自动跟随，跳到 http://192.168.1.1/ 照走；
 * - HLS/DASH 清单里的分片、子清单地址由播放器自己去连，根本不经过加载前那道检查；
 * - 检查时解析出公网地址、真正连接时系统再解析一次，被换成内网地址（DNS 重绑定）。
 *
 * 所以检查挪到「每一次真正建连」上（见 [open]）：
 * - 重定向不交给系统，自己一跳一跳地跟，每一跳都重新检查，跨协议一律不跟；
 * - 明文 http 直接连刚检查过的那个 IP（Host 头照填域名），连接时不会再查一次 DNS；
 * - https 不能改连 IP（证书按域名验），由 [PublicOnlySslSocketFactory] 在套 TLS 之前
 *   看一眼这条 TCP 连接的对端到底是谁 —— 这时一个字节的请求都还没发出去；
 * - 不走系统代理：经代理时连上的是代理，对面到底是谁就看不到了。
 *
 * 这里只用 java.net，不碰安卓 API，桌面 JVM 上也能直接跑。
 */
object NetGuard {

    /** 被我们拦下的连接。单独一个类型，日志里一眼认得出不是网络本身的问题。 */
    class BlockedAddressException(message: String) : IOException(message)

    /** 最多跟几跳重定向。正常的 CDN 跳一两次就到了。 */
    const val MAX_REDIRECTS = 5

    private val REDIRECT_CODES = setOf(301, 302, 303, 307, 308)

    private const val CONNECT_TIMEOUT_MS = 15_000

    /** 这个地址是不是不许房主让手机去连的：本机、局域网、链路本地、组播、各种保留段。 */
    fun isPrivateAddress(address: InetAddress): Boolean {
        val raw = address.address
        return isPrivateBytes(IntArray(raw.size) { raw[it].toInt() and 0xff })
    }

    /** 按原始字节判断（每个元素 0～255）。认不出来的长度一律当内网。 */
    fun isPrivateBytes(b: IntArray): Boolean {
        if (b.size == 4) return isPrivateV4(b[0], b[1], b[2])
        if (b.size != 16) return true
        // ::/64：未指定地址、回环、早已废弃的 IPv4 兼容地址……正常网站不会落在这里。
        // 只有 IPv4 映射地址（::ffff:a.b.c.d）按内嵌的那个 IPv4 算。
        if (isZero(b, 0, 8)) {
            if (isZero(b, 8, 10) && b[10] == 0xff && b[11] == 0xff) return isPrivateV4(b[12], b[13], b[14])
            return true
        }
        // NAT64（64:ff9b::/96）：纯 IPv6 的移动网络访问 IPv4 网站都经它，按内嵌的 IPv4 算。
        // 同前缀下的其余地址（64:ff9b:1::/48 本地 NAT64 等）当内网。
        if (b[0] == 0x00 && b[1] == 0x64 && b[2] == 0xff && b[3] == 0x9b) {
            if (isZero(b, 4, 12)) return isPrivateV4(b[12], b[13], b[14])
            return true
        }
        // 6to4（2002::/16）：第 2～5 字节就是一个 IPv4
        if (b[0] == 0x20 && b[1] == 0x02) return isPrivateV4(b[2], b[3], b[4])
        // 2001::/23 协议专用段（Teredo、基准测试、ORCHID 等）和 2001:db8::/32 文档地址
        if (b[0] == 0x20 && b[1] == 0x01 && (b[2] < 0x02 || (b[2] == 0x0d && b[3] == 0xb8))) return true
        // 100::/64 丢弃地址、3fff::/20 文档地址
        if (b[0] == 0x01 && b[1] == 0x00 && isZero(b, 2, 8)) return true
        if (b[0] == 0x3f && b[1] == 0xff && b[2] < 0x10) return true
        // fc00::/7 唯一本地（ULA）
        if ((b[0] and 0xfe) == 0xfc) return true
        // fe80::/10 链路本地、fec0::/10 已废弃的站点本地
        if (b[0] == 0xfe && (b[1] and 0xc0) >= 0x80) return true
        // ff00::/8 组播
        return b[0] == 0xff
    }

    /** IPv4 只看前三段就够分出所有保留段。 */
    fun isPrivateV4(a: Int, b: Int, c: Int): Boolean =
        a == 0 || a == 10 || a == 127 || a >= 224 ||
            (a == 100 && b >= 64 && b <= 127) ||
            (a == 169 && b == 254) ||
            (a == 172 && b >= 16 && b <= 31) ||
            (a == 192 && b == 168) ||
            (a == 192 && b == 0 && c <= 2) ||
            (a == 192 && b == 88 && c == 99) ||
            (a == 198 && (b == 18 || b == 19)) ||
            (a == 198 && b == 51 && c == 100) ||
            (a == 203 && b == 0 && c == 113)

    private fun isZero(b: IntArray, from: Int, end: Int): Boolean {
        for (i in from until end) if (b[i] != 0) return false
        return true
    }

    /** URL 里的主机名去掉 IPv6 字面量外面那对方括号。 */
    fun bareHost(host: String?): String = (host ?: "").removePrefix("[").removeSuffix("]")

    /**
     * 只看字面：协议、账号、主机名。**不查 DNS** —— 调用方之一在 JS 桥线程上，
     * 一次慢吞吞的 DNS 就能把整页（心跳、收片、同步）卡住几秒。真正的地址检查在建连时做。
     */
    fun checkUrlShape(url: URL) {
        val scheme = url.protocol.lowercase(Locale.ROOT)
        if (scheme != "http" && scheme != "https") throw BlockedAddressException("只允许 http/https：$scheme")
        if (url.userInfo != null) throw BlockedAddressException("地址里不许带账号密码")
        val host = bareHost(url.host)
        if (host.isBlank()) throw BlockedAddressException("地址里没有主机名")
        if (host.equals("localhost", true) || host.endsWith(".localhost", true)) {
            throw BlockedAddressException("不许连本机：$host")
        }
    }

    /**
     * 按 [start] 发 GET，自己一跳一跳地跟重定向，每一跳都重新检查、重新钉住地址。
     * @param prepare 给每一跳的连接设超时、请求头、Range（在 connect 之前调用）。
     * @return 最终那一跳的原样地址（带域名，HLS/DASH 按它解析相对路径）和已经拿到响应的连接。
     */
    fun open(
        start: URL,
        prepare: (HttpURLConnection) -> Unit,
        guard: Guard = Guard.DEFAULT,
    ): Pair<URL, HttpURLConnection> {
        var url = start
        val scheme = url.protocol.lowercase(Locale.ROOT)
        var hops = 0
        while (true) {
            val conn = connectOnce(url, prepare, guard)
            val code = try {
                conn.responseCode
            } catch (e: IOException) {
                conn.disconnect()
                throw e
            }
            if (code !in REDIRECT_CODES) return url to conn
            val location = conn.getHeaderField("Location")
            conn.disconnect()
            if (++hops > MAX_REDIRECTS) throw ProtocolException("重定向次数过多")
            if (location.isNullOrBlank()) throw ProtocolException("重定向没有给出目标地址")
            val next = URL(url, location)
            // 跨协议一律不跟：https 跳 http 等于换了一条没有证书约束、谁都能改的路
            if (!next.protocol.equals(scheme, ignoreCase = true)) {
                throw BlockedAddressException("不允许跨协议重定向：${url.protocol} → ${next.protocol}")
            }
            url = next
        }
    }

    /** 连一跳：先查地址再连，连接期间不会再有第二次 DNS 解析能绕开这次检查。 */
    private fun connectOnce(url: URL, prepare: (HttpURLConnection) -> Unit, guard: Guard): HttpURLConnection {
        checkUrlShape(url)
        // 解析结果里只要有一个内网地址就整个不连
        val address = guard.resolvePublic(url.host)
        val conn = if (url.protocol.equals("https", ignoreCase = true)) {
            // https 按域名连（证书要按域名验）；系统连上 TCP 之后、套 TLS 之前，
            // PublicOnlySslSocketFactory 会再看一眼对端地址，重绑定到内网的在这里被拦下。
            (url.openConnection(Proxy.NO_PROXY) as HttpsURLConnection).also {
                it.sslSocketFactory = guard.sslSocketFactory
            }
        } else {
            // 明文 http：直接连刚检查过的那个 IP，Host 头照填域名
            val pinned = URL(url.protocol, literal(address), url.port, url.file)
            (pinned.openConnection(Proxy.NO_PROXY) as HttpURLConnection).also {
                it.setRequestProperty("Host", hostHeader(url))
            }
        }
        conn.instanceFollowRedirects = false
        conn.useCaches = false
        prepare(conn)
        try {
            conn.connect()
        } catch (e: IOException) {
            conn.disconnect()
            throw e
        }
        return conn
    }

    /** 地址写进 URL 的样子：IPv6 要加方括号，去掉 %scope。 */
    private fun literal(address: InetAddress): String {
        val text = address.hostAddress ?: throw UnknownHostException("解析结果没有地址")
        return if (address is Inet6Address) "[" + text.substringBefore('%') + "]" else text
    }

    /** Host 头：非默认端口要带上。 */
    private fun hostHeader(url: URL): String {
        val port = url.port
        return if (port == -1 || port == url.defaultPort) url.host else "${url.host}:$port"
    }

    /**
     * 一套检查规则。平时只用 [DEFAULT]；可替换的几样（地址判据、DNS、TLS）只是为了能在
     * 桌面 JVM 上对着本机服务器验证这套逻辑。
     */
    class Guard(
        val blocked: (InetAddress) -> Boolean = ::isPrivateAddress,
        private val resolve: (String) -> Array<InetAddress> = { InetAddress.getAllByName(it) },
        delegate: SSLSocketFactory? = null,
    ) {
        /**
         * 同一套规则只用同一个工厂：系统按工厂区分连接池，每次新建一个的话
         * HLS 的每个分片都要重新握手一次 TLS。
         */
        val sslSocketFactory: SSLSocketFactory by lazy {
            PublicOnlySslSocketFactory(delegate ?: HttpsURLConnection.getDefaultSSLSocketFactory(), this)
        }

        /** 解析主机名，解析结果里有任何一个内网地址就拒绝；返回第一个地址。 */
        fun resolvePublic(host: String?): InetAddress {
            val name = bareHost(host)
            val addresses = resolve(name)
            if (addresses.isEmpty()) throw UnknownHostException(name)
            // 不能「挑那个公网的连」：重绑定的人会把内网地址混在结果里赌运气
            if (addresses.any(blocked)) throw BlockedAddressException("$name 解析到了内网地址")
            return addresses[0]
        }

        companion object {
            val DEFAULT = Guard()
        }
    }

    /**
     * 套 TLS 之前先看对端地址。系统的 HTTPS 连接（安卓和桌面 JDK 都是）先按域名连上一条
     * 普通 TCP，再调 [createSocket]（带 Socket 参数的那个）把 TLS 套上去 —— 这时 DNS 已经
     * 解析完、TCP 已经连上，对端地址就是真正要说话的那台机器，请求还一个字节都没发。
     */
    class PublicOnlySslSocketFactory(
        private val delegate: SSLSocketFactory,
        private val guard: Guard,
    ) : SSLSocketFactory() {

        override fun getDefaultCipherSuites(): Array<String> = delegate.defaultCipherSuites

        override fun getSupportedCipherSuites(): Array<String> = delegate.supportedCipherSuites

        override fun createSocket(s: Socket, host: String?, port: Int, autoClose: Boolean): Socket {
            val remote = s.inetAddress
            if (remote == null || guard.blocked(remote)) {
                runCatching { s.close() }
                throw BlockedAddressException("拒绝连接内网地址：$host")
            }
            return delegate.createSocket(s, host, port, autoClose)
        }

        // 下面几种是「让工厂自己去连」的入口。系统的 HTTPS 连接不走它们（不实现无参的
        // createSocket()，逼调用方先自己连好 TCP 再交给上面那个）；真有人走，也先查地址再连，
        // 别留一条不检查的路。

        override fun createSocket(host: String?, port: Int): Socket {
            val plain = Socket()
            plain.connect(InetSocketAddress(guard.resolvePublic(host), port), CONNECT_TIMEOUT_MS)
            return createSocket(plain, host, port, true)
        }

        override fun createSocket(host: String?, port: Int, localHost: InetAddress?, localPort: Int): Socket {
            val plain = Socket()
            plain.bind(InetSocketAddress(localHost, localPort))
            plain.connect(InetSocketAddress(guard.resolvePublic(host), port), CONNECT_TIMEOUT_MS)
            return createSocket(plain, host, port, true)
        }

        override fun createSocket(address: InetAddress, port: Int): Socket {
            if (guard.blocked(address)) throw BlockedAddressException("拒绝连接内网地址：${address.hostAddress}")
            return delegate.createSocket(address, port)
        }

        override fun createSocket(address: InetAddress, port: Int, localAddress: InetAddress?, localPort: Int): Socket {
            if (guard.blocked(address)) throw BlockedAddressException("拒绝连接内网地址：${address.hostAddress}")
            return delegate.createSocket(address, port, localAddress, localPort)
        }
    }
}
