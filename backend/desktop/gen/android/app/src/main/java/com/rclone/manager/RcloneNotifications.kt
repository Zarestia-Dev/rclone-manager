package com.rclone.manager

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import java.util.concurrent.atomic.AtomicInteger

/** Notifications shared by the foreground service and the alerts the backend raises. */
object RcloneNotifications {
  private const val ALERT_CHANNEL_ID = "rclone_alerts"
  private val nextAlertId = AtomicInteger(5000)
  @Volatile
  private var alertChannelCreated = false

  fun launchIntent(context: Context): PendingIntent {
    val launchIntent = (context.packageManager.getLaunchIntentForPackage(context.packageName)
      ?: Intent(context, MainActivity::class.java)).apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      if (MainActivity.lastActivityId != 0) {
        putExtra("__wryActivityId", MainActivity.lastActivityId)
      }
    }
    return PendingIntent.getActivity(
      context, 0, launchIntent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )
  }

  /** Posts an alert from the backend. It works without an activity, e.g. after a boot start. */
  fun showAlert(context: Context, title: String, body: String) {
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !alertChannelCreated) {
      alertChannelCreated = true
      manager.createNotificationChannel(
        NotificationChannel(
          ALERT_CHANNEL_ID,
          context.getString(R.string.alerts_channel_name),
          NotificationManager.IMPORTANCE_DEFAULT
        )
      )
    }
    val notification = NotificationCompat.Builder(context, ALERT_CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setSmallIcon(R.drawable.ic_notification)
      .setContentIntent(launchIntent(context))
      .setAutoCancel(true)
      .build()
    manager.notify(nextAlertId.getAndIncrement(), notification)
  }
}
