package com.rclone.manager

import org.junit.Assert.assertEquals
import org.junit.Test

class MainActivityTest {
  @Test fun namesSharedTextAfterTheSubject() {
    assertEquals("Meeting notes.txt", sharedTextFileName("Meeting notes"))
  }

  @Test fun fallsBackWithoutAUsableSubject() {
    assertEquals("Shared text.txt", sharedTextFileName(null))
    assertEquals("Shared text.txt", sharedTextFileName("  "))
    assertEquals("Shared text.txt", sharedTextFileName("..."))
  }

  @Test fun removesPathAndReservedCharacters() {
    assertEquals("a b c d e.txt", sharedTextFileName("a/b\\c:d\ne"))
    assertEquals("x y.txt", sharedTextFileName("x*?\"<>|y"))
    assertEquals("etc passwd.txt", sharedTextFileName("../etc/passwd"))
  }

  @Test fun limitsTheLength() {
    assertEquals("a".repeat(100) + ".txt", sharedTextFileName("a".repeat(300)))
  }
}
