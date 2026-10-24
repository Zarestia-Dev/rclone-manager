package com.rclone.manager

import java.io.ByteArrayInputStream
import org.junit.Assert.*
import org.junit.Test

class MediaRangeResponseTest {
    @Test
    fun onlySinglePartialRangesHaveAPrefix() {
        assertEquals(300000L, MediaRangeResponse.prefixLength(206, "bytes=300000-", "bytes 300000-300002/400000"))
        assertEquals(0L, MediaRangeResponse.prefixLength(206, "bytes=0-2", "bytes 0-2/3"))
        for (range in listOf(null, "", "bytes=-3", "bytes=0-1,4-5", "garbage")) {
            assertNull(MediaRangeResponse.prefixLength(206, range, "bytes 0-2/3"))
        }
        assertNull(MediaRangeResponse.prefixLength(200, "bytes=0-", "bytes 0-2/3"))
        for (content in listOf(null, "", "bytes -1-2/3", "bytes 999999999999999999999-2/3")) {
            assertNull(MediaRangeResponse.prefixLength(206, "bytes=0-", content))
        }
    }

    @Test
    fun webViewSkipPreservesTheActualPartialBody() {
        val bytes = byteArrayOf(11, 22, 33)
        val stream = RangePrefixInputStream(300000, ByteArrayInputStream(bytes))
        assertEquals(300003, stream.available())
        assertEquals(300000L, stream.skip(300000))
        assertEquals(3, stream.available())
        assertArrayEquals(bytes, stream.readBytes())
        assertEquals(-1, stream.read())
    }

    @Test
    fun offsetsPastTwoGiBDoNotOverflowOrAllocatePadding() {
        val offset = Int.MAX_VALUE.toLong() + 42
        val stream = RangePrefixInputStream(offset, ByteArrayInputStream(byteArrayOf(7)))
        assertEquals(0, stream.available())
        assertEquals(Int.MAX_VALUE.toLong(), stream.skip(offset))
        assertEquals(42L, stream.skip(42))
        assertEquals(7, stream.read())
    }

    @Test
    fun readsWithoutTheChromiumSkipStillReturnMediaAndCloseTheBody() {
        var closed = false
        val body = object : ByteArrayInputStream(byteArrayOf(1, 2)) {
            override fun close() { closed = true }
        }
        val stream = RangePrefixInputStream(Long.MAX_VALUE, body)
        assertEquals(0, stream.available())
        assertEquals(0L, stream.skip(-1))
        assertEquals(0L, stream.skip(0))
        assertEquals(1, stream.read())
        stream.close()
        assertTrue(closed)
    }

    @Test
    fun skippingAfterThePrefixDelegatesToBody() {
        val stream = RangePrefixInputStream(1, ByteArrayInputStream(byteArrayOf(1, 2)))
        assertEquals(1L, stream.skip(1))
        assertEquals(1L, stream.skip(1))
        assertEquals(2, stream.read())
    }
}
