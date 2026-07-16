package com.syncwatch.app

import android.net.Uri
import com.google.android.exoplayer2.C
import com.google.android.exoplayer2.upstream.DataSource
import com.google.android.exoplayer2.upstream.DataSpec
import com.google.android.exoplayer2.upstream.TransferListener

/**
 * 读一个正在被下载填充的文件。
 *
 * 普通 FileDataSource 会把还没下到的区域（预分配的 0）当正常数据读出来，
 * 解码器直接花屏/崩。这里改成：读到连续水位线以外就阻塞等下载补齐
 * （[Store.Session.awaitData]），补上再往下读。
 *
 * 正常播放时全员暂停联动会保证本地播放位置不会冲到自己的水位线前头，
 * 所以这个阻塞通常很短；真卡住时阻塞会自然让 ExoPlayer 停在这，和暂停等价。
 */
class GrowingDataSource(private val session: Store.Session) : DataSource {

    private var uri: Uri? = null
    private var position: Long = 0
    private var bytesRemaining: Long = 0
    private var opened = false
    private val listeners = ArrayList<TransferListener>()

    override fun addTransferListener(transferListener: TransferListener) {
        listeners.add(transferListener)
    }

    override fun open(dataSpec: DataSpec): Long {
        uri = dataSpec.uri
        position = dataSpec.position
        bytesRemaining = if (dataSpec.length != C.LENGTH_UNSET.toLong()) {
            dataSpec.length
        } else {
            session.size - dataSpec.position
        }
        opened = true
        for (l in listeners) l.onTransferStart(this, dataSpec, false)
        return bytesRemaining
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (length == 0) return 0
        if (bytesRemaining == 0L) return C.RESULT_END_OF_INPUT

        // 等到 position 处有数据可读（或读完/关闭）
        val available = session.awaitData(position, WAIT_SLICE_MS)
        if (available < 0) return C.RESULT_END_OF_INPUT

        val toRead = minOf(length.toLong(), bytesRemaining, available).toInt()
        val n = session.readAt(position, buffer, offset, toRead)
        if (n < 0) return C.RESULT_END_OF_INPUT

        position += n
        bytesRemaining -= n
        for (l in listeners) l.onBytesTransferred(this, /* dataSpec */ EMPTY_SPEC, false, n)
        return n
    }

    override fun getUri(): Uri? = uri

    override fun close() {
        if (opened) {
            opened = false
            for (l in listeners) l.onTransferEnd(this, EMPTY_SPEC, false)
        }
    }

    companion object {
        private const val WAIT_SLICE_MS = 1000L
        private val EMPTY_SPEC = DataSpec(Uri.EMPTY)
    }

    /** 工厂：把某个会话绑定给 ExoPlayer 的媒体源。 */
    class Factory(private val session: Store.Session) : DataSource.Factory {
        override fun createDataSource(): DataSource = GrowingDataSource(session)
    }
}
