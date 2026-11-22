package com.rclone.manager

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RcloneKeepAliveServiceTest {
  @Test fun idleKeepAliveAndMountsLetTheDeviceSleep() {
    assertFalse(needsWakeLocks(jobs = 0, serves = 0, watchPending = false, documentWork = false))
  }

  @Test fun anyRunningWorkKeepsTheDeviceAwake() {
    assertTrue(needsWakeLocks(jobs = 1, serves = 0, watchPending = false, documentWork = false))
    assertTrue(needsWakeLocks(jobs = 0, serves = 2, watchPending = false, documentWork = false))
    assertTrue(needsWakeLocks(jobs = 0, serves = 0, watchPending = true, documentWork = false))
    assertTrue(needsWakeLocks(jobs = 0, serves = 0, watchPending = false, documentWork = true))
  }

  private fun lines(jobs: Int, serves: Int) =
    interruptedWorkLines(jobs, serves, { "jobs $it" }, { "serves $it" }, "autostart")

  @Test fun nothingLostMeansNoNotice() {
    assertEquals(emptyList<String>(), lines(0, 0))
  }

  @Test fun jobsAloneNeedNoAutostartNote() {
    assertEquals(listOf("jobs 3"), lines(3, 0))
  }

  @Test fun stoppedServersMentionTheirAutostart() {
    assertEquals(listOf("serves 1", "autostart"), lines(0, 1))
    assertEquals(listOf("jobs 2", "serves 1", "autostart"), lines(2, 1))
  }
}
