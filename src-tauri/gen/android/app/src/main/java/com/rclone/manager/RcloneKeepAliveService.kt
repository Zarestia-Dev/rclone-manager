package com.rclone.manager

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

class RcloneKeepAliveService : Service() {

  companion object {
    private const val NOTIFICATION_ID = 4482
    private const val CHANNEL_ID = "rclone_saf_keepalive"

    fun startService(context: Context) {
      try {
        Logger.info("RcloneKeepAliveService: Starting foreground service")
        val intent = Intent(context, RcloneKeepAliveService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
      } catch (e: Throwable) {
        Logger.error("Failed to start RcloneKeepAliveService: ${e.message}")
      }
    }

    fun stopService(context: Context) {
      try {
        Logger.info("RcloneKeepAliveService: Stopping foreground service")
        val intent = Intent(context, RcloneKeepAliveService::class.java)
        context.stopService(intent)
      } catch (e: Throwable) {
        Logger.error("Failed to stop RcloneKeepAliveService: ${e.message}")
      }
    }
  }

  override fun onCreate() {
    super.onCreate()
    Logger.info("RcloneKeepAliveService: onCreate called")
    promoteToForeground()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    Logger.info("RcloneKeepAliveService: onStartCommand called")
    promoteToForeground()
    return START_STICKY
  }

  private fun promoteToForeground() {
    try {
      createNotificationChannel()
      val notification = NotificationCompat.Builder(this, CHANNEL_ID)
        .setContentTitle(getString(R.string.saf_keepalive_title))
        .setContentText(getString(R.string.saf_keepalive_text))
        .setSmallIcon(R.drawable.ic_notification)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setOngoing(true)
        .build()

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(
          NOTIFICATION_ID,
          notification,
          android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        )
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (e: Throwable) {
      Logger.error("RcloneKeepAliveService promoteToForeground failed: ${e.message}")
    }
  }

  override fun onDestroy() {
    Logger.info("RcloneKeepAliveService: onDestroy called")
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        getString(R.string.saf_keepalive_channel_name),
        NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = getString(R.string.saf_keepalive_channel_desc)
      }
      val manager = getSystemService(NotificationManager::class.java)
      manager?.createNotificationChannel(channel)
    }
  }
}
