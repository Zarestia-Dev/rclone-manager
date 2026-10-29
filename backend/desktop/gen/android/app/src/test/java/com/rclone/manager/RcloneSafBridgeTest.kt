package com.rclone.manager

import org.junit.Assert.assertEquals
import org.junit.Test

class RcloneSafBridgeTest {
  @Test fun wrapsPlainQueries() {
    assertEquals("*holiday*", containsGlob("holiday"))
    assertEquals("*IMG 2024.jpg*", containsGlob("IMG 2024.jpg"))
  }

  @Test fun escapesGlobCharacters() {
    assertEquals("*a\\*b\\?c*", containsGlob("a*b?c"))
    assertEquals("*\\[draft\\] \\{v2\\}*", containsGlob("[draft] {v2}"))
    assertEquals("*back\\\\slash*", containsGlob("back\\slash"))
  }
}
