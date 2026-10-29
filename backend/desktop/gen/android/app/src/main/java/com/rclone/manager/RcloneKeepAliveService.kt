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
    private const val RESTART_NOTIFICATION_ID = 4483
    private const val WAKELOCK_TIMEOUT_MS = 60 * 60 * 1000L
    private const val WAKELOCK_RENEW_MS = 30 * 60 * 1000L
    private const val PREFS_NAME = "rclone_keepalive_prefs"
    private const val KEY_KEEPALIVE_ACTIVE = "keepalive_active"

    const val ACTION_START = "com.rclone.manager.action.START_KEEPALIVE"
    const val ACTION_UPDATE_NOTIFICATION = "com.rclone.manager.action.UPDATE_NOTIFICATION"
    const val EXTRA_TITLE = "extra_title"
    const val EXTRA_TEXT = "extra_text"

    private val isKeepAliveRequested = AtomicBoolean(false)
    // The frontend wants the service: keep-alive is on, or jobs, mounts or serves are running.
    private val isAppRequested = AtomicBoolean(false)
    private val isServiceRunning = AtomicBoolean(false)
    private var lastTitle: String? = null
    private var lastText: String? = null
    private var lastUpdateTime: Long = 0L
    private const val MIN_NOTIFICATION_INTERVAL_MS = 2000L
    private val mainHandler by lazy { Handler(Looper.getMainLooper()) }
    private var pendingUpdateRunnable: Runnable? = null

    fun isRunning(): Boolean = isServiceRunning.get()

    private fun isNeeded(): Boolean =
      isAppRequested.get() || RcloneSafBridge.getActiveHandleCount() > 0

    // The request is also kept on disk: a process the system killed restarts this service
    // without it, and only the stored copy tells that keep-alive was running.
    private fun setKeepAliveRequested(context: Context, requested: Boolean) {
      isKeepAliveRequested.set(requested)
      try {
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
          .edit().putBoolean(KEY_KEEPALIVE_ACTIVE, requested).apply()
      } catch (e: Throwable) {
        Logger.error("Failed to store keep-alive state: ${e.message}")
      }
    }

    /** Called by the frontend; [forceKeepAlive] is the keep-alive setting. */
    fun startService(context: Context, forceKeepAlive: Boolean = false) {
      setKeepAliveRequested(context, forceKeepAlive)
      isAppRequested.set(true)
      launch(context)
    }

    /** Keeps the process alive while the file manager streams a document. */
    fun startForDocuments(context: Context) {
      if (!isServiceRunning.get()) launch(context)
    }

    private fun launch(context: Context) {
      try {
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

    /**
     * [force] means the frontend no longer needs the service; without it the last document was
     * closed, which must not stop a service the frontend still uses.
     */
    fun stopService(context: Context, force: Boolean = true) {
      try {
        if (force) {
          setKeepAliveRequested(context, false)
          isAppRequested.set(false)
          pendingUpdateRunnable?.let { mainHandler.removeCallbacks(it) }
          pendingUpdateRunnable = null
          lastTitle = null
          lastText = null
          lastUpdateTime = 0L
        }

        if (!isServiceRunning.get() || isAppRequested.get()) {
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

  // The timeout only bounds a lock whose owner died; renewing it keeps a live service awake.
  private val renewWakeLock = object : Runnable {
    override fun run() {
      if (wakeLock == null) return
      try {
        wakeLock?.acquire(WAKELOCK_TIMEOUT_MS)
      } catch (e: Throwable) {
        Logger.error("Failed to renew wakeLock: ${e.message}")
      }
      mainHandler.postDelayed(this, WAKELOCK_RENEW_MS)
    }
  }

  override fun onCreate() {
    super.onCreate()
    Logger.info("RcloneKeepAliveService: onCreate called")
    isServiceRunning.set(true)
    createNotificationChannel()
    getSystemService(NotificationManager::class.java)?.cancel(RESTART_NOTIFICATION_ID)
    promoteToForeground()
    acquireLocks()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val action = intent?.action
    Logger.info("RcloneKeepAliveService: onStartCommand called (action=$action)")

    // startForegroundService() obliges every start to reach startForeground(), including the
    // ones that stop the service right away.
    if (!isForeground) {
      promoteToForeground()
    }

    // A null intent is the system restarting the service after it killed the process. The
    // backend and WebView are gone and cannot start without the activity.
    if (intent == null && consumeKilledKeepAlive()) {
      notifyStoppedBySystem()
    }

    if (action == ACTION_UPDATE_NOTIFICATION) {
      val title = intent.getStringExtra(EXTRA_TITLE)
      val text = intent.getStringExtra(EXTRA_TEXT)
      if (!title.isNullOrBlank() || !text.isNullOrBlank()) {
        promoteToForeground(title, text)
        return START_STICKY
      }
    }

    if (!isNeeded()) {
      Logger.info("RcloneKeepAliveService: Neither the app nor an open document needs the service, stopping")
      stopForegroundSafely()
      stopSelf()
      return START_NOT_STICKY
    }

    acquireLocks()
    return START_STICKY
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    super.onTaskRemoved(rootIntent)
    Logger.info("RcloneKeepAliveService: onTaskRemoved triggered (app swiped from recent apps)")
    // The activity keeps the Rust window while this service runs, so stopping here would leave
    // the backend without its foreground service; the frontend stops it once its work is done.
    if (isNeeded()) {
      Logger.info("RcloneKeepAliveService: Still needed, preserving background process and locks")
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

  private fun consumeKilledKeepAlive(): Boolean {
    if (isKeepAliveRequested.get()) return false
    return try {
      val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      val killed = prefs.getBoolean(KEY_KEEPALIVE_ACTIVE, false)
      if (killed) prefs.edit().putBoolean(KEY_KEEPALIVE_ACTIVE, false).apply()
      killed
    } catch (e: Throwable) {
      Logger.error("Failed to read keep-alive state: ${e.message}")
      false
    }
  }

  private fun notifyStoppedBySystem() {
    try {
      val notification = NotificationCompat.Builder(this, CHANNEL_ID)
        .setContentTitle(getString(R.string.keepalive_title))
        .setContentText(getString(R.string.keepalive_stopped_text))
        .setSmallIcon(R.drawable.ic_notification)
        .setContentIntent(launchPendingIntent())
        .setAutoCancel(true)
        .build()
      getSystemService(NotificationManager::class.java)?.notify(RESTART_NOTIFICATION_ID, notification)
    } catch (e: Throwable) {
      Logger.error("Failed to post the stopped-by-system notification: ${e.message}")
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
        wakeLock?.acquire(WAKELOCK_TIMEOUT_MS)
      }
      mainHandler.removeCallbacks(renewWakeLock)
      mainHandler.postDelayed(renewWakeLock, WAKELOCK_RENEW_MS)
    } catch (e: Throwable) {
      Logger.error("Failed to acquire wakeLock: ${e.message}")
    }

    try {
      if (wifiLock == null) {
        val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        // On Android 10 to 13 a low-latency lock only holds in the foreground with the screen on,
        // so it does nothing for background transfers; Android 14 maps this mode to low latency,
        // which from then on also holds in the background.
        @Suppress("DEPRECATION")
        val mode = WifiManager.WIFI_MODE_FULL_HIGH_PERF
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
    mainHandler.removeCallbacks(renewWakeLock)
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

  private fun launchPendingIntent(): PendingIntent {
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
    return PendingIntent.getActivity(this, 0, launchIntent, pendingFlags)
  }

  private fun buildNotification(customTitle: String? = null, customText: String? = null): Notification {
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
      .setContentIntent(launchPendingIntent())
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setOngoing(true)
      .build()
  }

  private fun promoteToForeground(customTitle: String? = null, customText: String? = null) {
    try {
      val notification = buildNotification(customTitle, customText)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        // dataSync is capped at 6h per 24h on Android 15+ and the system crashes the app once
        // the service outlives it; specialUse has no such limit.
        startForeground(
          NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
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
