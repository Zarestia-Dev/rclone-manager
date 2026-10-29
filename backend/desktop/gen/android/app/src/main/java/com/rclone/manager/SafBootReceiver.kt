package com.rclone.manager

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class SafBootReceiver : BroadcastReceiver() {

  override fun onReceive(context: Context?, intent: Intent?) {
    if (context == null || intent == null) return
    val action = intent.action ?: return

    if (action == Intent.ACTION_BOOT_COMPLETED || action == Intent.ACTION_MY_PACKAGE_REPLACED) {
      try {
        Logger.info("SafBootReceiver: System boot/update event received ($action)")
        // Loading the native libraries here would start the Go runtime with nothing to run;
        // the documents provider loads them when it is first used.
        RcloneSafBridge.updateAppShortcuts(context.applicationContext)
      } catch (e: Exception) {
        Logger.error("SafBootReceiver error: ${e.message}")
      }
    }
  }
}
