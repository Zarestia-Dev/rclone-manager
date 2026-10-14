package com.rclone.manager

import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.InputStream

/**
 * Android WebView skips the requested offset even when a 206 body is already sliced.
 * Backport of the approach in https://github.com/tauri-apps/wry/pull/1865.
 * Remove together with the Gradle hook when Tauri includes that fix.
 */
object MediaRangeResponse {
    private val singleRange = Regex("""bytes=\d+-\d*""")
    private val contentRange = Regex("""bytes (\d+)-\d+/(?:\d+|\*)""")

    fun wrap(request: WebResourceRequest, response: WebResourceResponse?) {
        if (response == null) return
        val prefix = prefixLength(
            response.statusCode,
            request.requestHeaders.header("Range"),
            response.responseHeaders?.header("Content-Range")
        ) ?: return
        val body = response.data ?: return
        response.data = RangePrefixInputStream(prefix, body)
    }

    internal fun prefixLength(status: Int, range: String?, content: String?): Long? {
        if (status != 206 || range == null || !singleRange.matches(range.trim())) return null
        return contentRange.matchEntire(content?.trim() ?: "")
            ?.groupValues?.get(1)?.toLongOrNull()
    }

    private fun Map<String, String>.header(name: String): String? =
        entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value
}

/** A virtual, skippable prefix: no padding allocation, reads always return real media. */
internal class RangePrefixInputStream(
    private var prefixRemaining: Long,
    private val body: InputStream
) : InputStream() {
    override fun available(): Int {
        val available = body.available()
        // Chromium uses Int32 for range verification. Zero disables that check for
        // offsets beyond 2 GiB; it still skips and reads the stream (upstream workaround).
        return if (prefixRemaining > Int.MAX_VALUE.toLong() - available) 0
        else (prefixRemaining + available).toInt()
    }

    override fun skip(n: Long): Long {
        if (n <= 0) return 0
        if (prefixRemaining == 0L) return body.skip(n)
        // Chromium also reads each skip result as Int32 and loops as necessary.
        val skipped = minOf(n, prefixRemaining, Int.MAX_VALUE.toLong())
        prefixRemaining -= skipped
        return skipped
    }

    override fun read(): Int = body.read()
    override fun read(bytes: ByteArray, offset: Int, length: Int): Int =
        body.read(bytes, offset, length)
    override fun close() = body.close()
}
