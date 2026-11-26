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

  @Test fun theStatusChipShowsHowFarJobsAreWhenThatIsKnown() {
    assertEquals("42%", statusChipText(working = true, percent = 42, active = 3))
    assertEquals("0%", statusChipText(working = true, percent = 0, active = 1))
    // rclone does not know the size yet: the number of running items, as before.
    assertEquals("3", statusChipText(working = true, percent = -1, active = 3))
    // Only mounts or servers run.
    assertEquals("2", statusChipText(working = false, percent = 50, active = 2))
    assertEquals(null, statusChipText(working = false, percent = -1, active = 0))
  }
}
