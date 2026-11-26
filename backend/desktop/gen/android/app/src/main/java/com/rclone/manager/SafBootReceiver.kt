package com.rclone.manager

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.PowerManager

class SafBootReceiver : BroadcastReceiver() {

  companion object {
    const val ACTION_SCHEDULE_WAKEUP = "com.rclone.manager.action.SCHEDULE_WAKEUP"
    private const val SCHEDULE_WAKELOCK_TAG = "rclone:schedule_wakeup"
    private const val SCHEDULE_WAKELOCK_MS = 60_000L
  }

  override fun onReceive(context: Context?, intent: Intent?) {
    if (context == null || intent == null) return
    val action = intent.action ?: return

    // The alarm keeps the device awake only during onReceive. The scheduler checks its clock
    // every half second, so a short lock lets it start the run, whose job then holds the
    // service's own lock. Without the service the backend is not running.
    if (action == ACTION_SCHEDULE_WAKEUP) {
      if (RcloneKeepAliveService.isRunning()) {
        try {
          (context.getSystemService(Context.POWER_SERVICE) as? PowerManager)
            ?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, SCHEDULE_WAKELOCK_TAG)
            ?.acquire(SCHEDULE_WAKELOCK_MS)
        } catch (e: Throwable) {
          Logger.error("Failed to wake for a scheduled run: ${e.message}")
        }
      }
      return
    }

    if (action == Intent.ACTION_BOOT_COMPLETED || action == Intent.ACTION_MY_PACKAGE_REPLACED) {
      try {
        Logger.info("SafBootReceiver: System boot/update event received ($action)")
        // Loading the native libraries here would start the Go runtime with nothing to run;
        // the documents provider loads them when it is first used.
        RcloneSafBridge.updateAppShortcuts(context.applicationContext)
        if (RcloneSafBridge.isStartOnBootEnabled(context)) {
          RcloneKeepAliveService.startAtBoot(context.applicationContext)
        }
      } catch (e: Exception) {
        Logger.error("SafBootReceiver error: ${e.message}")
      }
    }
  }
}
