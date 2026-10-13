package com.rclone.manager

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import java.util.concurrent.atomic.AtomicBoolean

class RcloneKeepAliveService : Service() {

  companion object {
    private const val NOTIFICATION_ID = 4482
    private const val CHANNEL_ID = "rclone_saf_keepalive"
    private const val WAKELOCK_TAG = "rclone:saf_keepalive_wakelock"
    private const val WIFILOCK_TAG = "rclone:saf_keepalive_wifilock"

    const val ACTION_START = "com.rclone.manager.action.START_KEEPALIVE"
    const val ACTION_STOP = "com.rclone.manager.action.STOP_KEEPALIVE"
    const val ACTION_UPDATE_NOTIFICATION = "com.rclone.manager.action.UPDATE_NOTIFICATION"
    const val EXTRA_TITLE = "extra_title"
    const val EXTRA_TEXT = "extra_text"
    const val EXTRA_FORCE = "extra_force"

    private val isKeepAliveRequested = AtomicBoolean(false)
    private val isServiceRunning = AtomicBoolean(false)
    private var lastTitle: String? = null
    private var lastText: String? = null
    private var lastUpdateTime: Long = 0L
    private const val MIN_NOTIFICATION_INTERVAL_MS = 2000L
    private val mainHandler by lazy { Handler(Looper.getMainLooper()) }
    private var pendingUpdateRunnable: Runnable? = null

    fun isRunning(): Boolean = isServiceRunning.get()

    fun isKeepAliveEnabled(): Boolean = isKeepAliveRequested.get()

    fun startService(context: Context, forceKeepAlive: Boolean = false) {
      try {
        isKeepAliveRequested.set(forceKeepAlive)
        Logger.info("RcloneKeepAliveService: Starting foreground service (keepAlive=${isKeepAliveRequested.get()})")
        val intent = Intent(context, RcloneKeepAliveService::class.java).apply {
          action = ACTION_START
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
      } catch (e: Throwable) {
        Logger.error("Failed to start RcloneKeepAliveService: ${e.message}")
      }
    }

    fun stopService(context: Context, force: Boolean = true) {
      try {
        if (force) {
          isKeepAliveRequested.set(false)
        }
        pendingUpdateRunnable?.let { mainHandler.removeCallbacks(it) }
        pendingUpdateRunnable = null
        lastTitle = null
        lastText = null
        lastUpdateTime = 0L

        if (!isServiceRunning.get()) {
          return
        }

        val hasActiveHandles = RcloneSafBridge.getActiveHandleCount() > 0
        if (hasActiveHandles) {
          Logger.info("RcloneKeepAliveService: Active SAF handles exist, maintaining service for streaming")
          updateNotification(
            context,
            context.getString(R.string.saf_keepalive_title),
            context.getString(R.string.saf_keepalive_text)
          )
          return
        }

        Logger.info("RcloneKeepAliveService: Stopping foreground service cleanly")
        val intent = Intent(context, RcloneKeepAliveService::class.java)
        context.stopService(intent)
      } catch (e: Throwable) {
        Logger.error("Failed to stop RcloneKeepAliveService: ${e.message}")
      }
    }

    fun updateNotification(context: Context, title: String, text: String) {
      if (title == lastTitle && text == lastText) return
      if (!isServiceRunning.get()) return

      val appContext = context.applicationContext
      val now = SystemClock.elapsedRealtime()
      val elapsed = now - lastUpdateTime

      pendingUpdateRunnable?.let { mainHandler.removeCallbacks(it) }

      if (lastUpdateTime == 0L || elapsed >= MIN_NOTIFICATION_INTERVAL_MS) {
        lastUpdateTime = now
        lastTitle = title
        lastText = text
        dispatchNotificationUpdate(appContext, title, text)
      } else {
        val delay = MIN_NOTIFICATION_INTERVAL_MS - elapsed
        val runnable = Runnable {
          if (!isServiceRunning.get()) return@Runnable
          lastUpdateTime = SystemClock.elapsedRealtime()
          lastTitle = title
          lastText = text
          dispatchNotificationUpdate(appContext, title, text)
        }
        pendingUpdateRunnable = runnable
        mainHandler.postDelayed(runnable, delay)
      }
    }

    private fun dispatchNotificationUpdate(context: Context, title: String, text: String) {
      try {
        val intent = Intent(context, RcloneKeepAliveService::class.java).apply {
          action = ACTION_UPDATE_NOTIFICATION
          putExtra(EXTRA_TITLE, title)
          putExtra(EXTRA_TEXT, text)
        }
        context.startService(intent)
      } catch (e: Throwable) {
        Logger.error("Failed to send notification update to RcloneKeepAliveService: ${e.message}")
      }
    }
  }

  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null
  private var isForeground = false

  override fun onCreate() {
    super.onCreate()
    Logger.info("RcloneKeepAliveService: onCreate called")
    isServiceRunning.set(true)
    createNotificationChannel()
    promoteToForeground()
    acquireLocks()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val action = intent?.action
    Logger.info("RcloneKeepAliveService: onStartCommand called (action=$action)")

    if (action == ACTION_STOP) {
      val force = intent.getBooleanExtra(EXTRA_FORCE, true)
      if (force) {
        isKeepAliveRequested.set(false)
      }
      if (!isKeepAliveRequested.get() && RcloneSafBridge.getActiveHandleCount() <= 0) {
        Logger.info("RcloneKeepAliveService: Stopping service as requested and no active handles exist")
        stopForegroundSafely()
        stopSelf()
        return START_NOT_STICKY
      }
    }

    if (action == ACTION_UPDATE_NOTIFICATION) {
      val title = intent.getStringExtra(EXTRA_TITLE)
      val text = intent.getStringExtra(EXTRA_TEXT)
      if (!title.isNullOrBlank() || !text.isNullOrBlank()) {
        promoteToForeground(title, text)
        return START_STICKY
      }
    }

    val hasActiveHandles = RcloneSafBridge.getActiveHandleCount() > 0
    val keepAliveActive = isKeepAliveRequested.get()

    if (!hasActiveHandles && !keepAliveActive) {
      Logger.info("RcloneKeepAliveService: No active handles and keep-alive disabled, stopping immediately")
      stopForegroundSafely()
      stopSelf()
      return START_NOT_STICKY
    }

    if (!isForeground) {
      promoteToForeground()
    }
    acquireLocks()
    return START_STICKY
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    super.onTaskRemoved(rootIntent)
    Logger.info("RcloneKeepAliveService: onTaskRemoved triggered (app swiped from recent apps)")
    if (isKeepAliveRequested.get() || RcloneSafBridge.getActiveHandleCount() > 0) {
      Logger.info("RcloneKeepAliveService: Keep-alive active, preserving background process and locks")
      if (!isForeground) {
        promoteToForeground()
      }
      acquireLocks()
    } else {
      Logger.info("RcloneKeepAliveService: Keep-alive inactive on task removal, stopping service")
      stopForegroundSafely()
      stopSelf()
    }
  }

  private fun acquireLocks() {
    if (wakeLock?.isHeld == true && wifiLock?.isHeld == true) {
      return
    }
    try {
      if (wakeLock == null) {
        val powerManager = getSystemService(Context.POWER_SERVICE) as? PowerManager
        wakeLock = powerManager?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKELOCK_TAG)?.apply {
          setReferenceCounted(false)
        }
      }
      if (wakeLock?.isHeld == false) {
        wakeLock?.acquire(60 * 60 * 1000L /* 60 minutes timeout */)
      }
    } catch (e: Throwable) {
      Logger.error("Failed to acquire wakeLock: ${e.message}")
    }

    try {
      if (wifiLock == null) {
        val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          WifiManager.WIFI_MODE_FULL_LOW_LATENCY
        } else {
          @Suppress("DEPRECATION")
          WifiManager.WIFI_MODE_FULL_HIGH_PERF
        }
        wifiLock = wifiManager?.createWifiLock(mode, WIFILOCK_TAG)?.apply {
          setReferenceCounted(false)
        }
      }
      if (wifiLock?.isHeld == false) {
        wifiLock?.acquire()
      }
    } catch (e: Throwable) {
      Logger.error("Failed to acquire wifiLock: ${e.message}")
    }
  }

  private fun releaseLocks() {
    try {
      if (wakeLock?.isHeld == true) {
        wakeLock?.release()
      }
      wakeLock = null
    } catch (e: Throwable) {
      Logger.error("Failed to release wakeLock: ${e.message}")
    }

    try {
      if (wifiLock?.isHeld == true) {
        wifiLock?.release()
      }
      wifiLock = null
    } catch (e: Throwable) {
      Logger.error("Failed to release wifiLock: ${e.message}")
    }
  }

  private fun buildNotification(customTitle: String? = null, customText: String? = null): Notification {
    val launchIntent = (packageManager.getLaunchIntentForPackage(packageName) ?: Intent(this, MainActivity::class.java)).apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      if (MainActivity.lastActivityId != 0) {
        putExtra("__wryActivityId", MainActivity.lastActivityId)
      }
    }
    val pendingFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    } else {
      PendingIntent.FLAG_UPDATE_CURRENT
    }
    val contentPendingIntent = PendingIntent.getActivity(this, 0, launchIntent, pendingFlags)

    val hasSaf = RcloneSafBridge.getActiveHandleCount() > 0
    val title = customTitle ?: lastTitle ?: if (hasSaf) {
      getString(R.string.saf_keepalive_title)
    } else {
      getString(R.string.keepalive_title)
    }
    val text = customText ?: lastText ?: if (hasSaf) {
      getString(R.string.saf_keepalive_text)
    } else {
      getString(R.string.keepalive_text)
    }

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(text)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentIntent(contentPendingIntent)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setOngoing(true)
      .build()
  }

  private fun promoteToForeground(customTitle: String? = null, customText: String? = null) {
    try {
      val notification = buildNotification(customTitle, customText)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        startForeground(
          NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE or ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        )
      } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(
          NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        )
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
      isForeground = true
    } catch (e: Throwable) {
      Logger.error("RcloneKeepAliveService promoteToForeground failed: ${e.message}")
    }
  }

  private fun stopForegroundSafely() {
    isForeground = false
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
  }

  override fun onDestroy() {
    Logger.info("RcloneKeepAliveService: onDestroy called")
    isServiceRunning.set(false)
    pendingUpdateRunnable?.let { mainHandler.removeCallbacks(it) }
    pendingUpdateRunnable = null
    lastTitle = null
    lastText = null
    lastUpdateTime = 0L
    stopForegroundSafely()
    releaseLocks()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        getString(R.string.keepalive_channel_name),
        NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = getString(R.string.keepalive_channel_desc)
      }
      val manager = getSystemService(NotificationManager::class.java)
      manager?.createNotificationChannel(channel)
    }
  }
}
