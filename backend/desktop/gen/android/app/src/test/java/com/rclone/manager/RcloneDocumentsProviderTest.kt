package com.rclone.manager

import android.os.ParcelFileDescriptor
import org.junit.Assert.assertEquals
import org.junit.Test

class RcloneDocumentsProviderTest {
  private val read = ParcelFileDescriptor.MODE_READ_ONLY
  private val write = ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_CREATE
  private val readWrite = ParcelFileDescriptor.MODE_READ_WRITE or ParcelFileDescriptor.MODE_CREATE

  @Test fun readsOpenReadOnly() {
    assertEquals("r", vfsOpenMode(read))
  }

  @Test fun truncatingWritesTruncate() {
    // ParcelFileDescriptor.parseMode gives "w" and "wt" the truncate flag, and "rwt" as well.
    assertEquals("rwt", vfsOpenMode(write or ParcelFileDescriptor.MODE_TRUNCATE))
    assertEquals("rwt", vfsOpenMode(readWrite or ParcelFileDescriptor.MODE_TRUNCATE))
  }

  @Test fun nonTruncatingWritesKeepContent() {
    assertEquals("rw", vfsOpenMode(readWrite))
    assertEquals("rw", vfsOpenMode(write or ParcelFileDescriptor.MODE_APPEND))
  }

  @Test fun numbersFilesBeforeTheExtension() {
    assertEquals("photo (1).jpg", numberedName("photo.jpg", isDir = false, n = 1))
    assertEquals("archive.tar (2).gz", numberedName("archive.tar.gz", isDir = false, n = 2))
  }

  @Test fun numbersNamesWithoutAnExtensionAsAWhole() {
    assertEquals("README (1)", numberedName("README", isDir = false, n = 1))
    assertEquals(".hidden (1)", numberedName(".hidden", isDir = false, n = 1))
    assertEquals("my.folder (3)", numberedName("my.folder", isDir = true, n = 3))
  }
}
