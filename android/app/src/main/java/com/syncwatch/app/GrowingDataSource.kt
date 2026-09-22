package com.syncwatch.app

import android.net.Uri
import com.google.android.exoplayer2.C
import com.google.android.exoplayer2.PlaybackException
import com.google.android.exoplayer2.upstream.DataSource
import com.google.android.exoplayer2.upstream.DataSourceException
import com.google.android.exoplayer2.upstream.DataSpec
import com.google.android.exoplayer2.upstream.TransferListener

/**
 * 读一个正在被下载填充的文件。
 *
 * 普通 FileDataSource 会把还没下到的区域（预分配的 0）当正常数据读出来，
 * 解码器直接花屏/崩。这里改成：**读到当前位置所在那段连续已收数据的末尾就阻塞**，
 * 等下载补齐（[Store.Session.awaitData]）再往下读。判据不是从文件头起的连续水位线
 * —— 中途加入房间时播放位置之前整段都是空洞，按水位线算根本读不出数据。
 *
 * 正常播放时全员暂停联动会保证本地播放位置不会冲到本段连续区的末尾，
 * 所以这个阻塞通常很短；真卡住时阻塞会自然让 ExoPlayer 停在这，和暂停等价。
 *
 * seek 之后 ExoPlayer 会带着新的 position 重新 open()，所以「中途加入」和「往回拖到
 * 未接收区域」都会重新走一遍 awaitData：落在空洞里就一直是「缓冲中」，
 * 不会被误判成文件到头（那会让播放器直接 ENDED）。
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
        // 读哪儿由容器里的索引决定，而片子是对端给的：索引指到文件尾以外时照 FileDataSource
        // 的做法报「位置越界」，不能算出一个负的剩余长度交回给播放器。
        if (dataSpec.position < 0 || dataSpec.position > session.size) {
            throw DataSourceException(PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE)
        }
        uri = dataSpec.uri
        position = dataSpec.position
        // 指定了长度就原样认（DataSource 的约定）；读到文件尾时 awaitData 自会报 -1
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

        // 等到 position 处有数据可读（或真读完 / 会话关闭）。
        // available 是「从 position 起连续可读多少」，不是「水位线还剩多少」。
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
