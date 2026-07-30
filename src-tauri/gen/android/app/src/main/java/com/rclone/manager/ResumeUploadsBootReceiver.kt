package com.rclone.manager

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class ResumeUploadsBootReceiver : BroadcastReceiver() {

  override fun onReceive(context: Context?, intent: Intent?) {
    if (context == null || intent == null) return
    val action = intent.action ?: return

    if (action == Intent.ACTION_BOOT_COMPLETED || action == Intent.ACTION_MY_PACKAGE_REPLACED) {
      try {
        Logger.info("ResumeUploadsBootReceiver: System boot/update event received ($action)")
        RcloneSafBridge.ensureInitialized(context.applicationContext)
      } catch (e: Exception) {
        Logger.error("ResumeUploadsBootReceiver error: ${e.message}")
      }
    }
  }
}
