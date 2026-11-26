package com.rclone.manager

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
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
    private const val WAKELOCK_TIMEOUT_MS = 60 * 60 * 1000L
    private const val WAKELOCK_RENEW_MS = 30 * 60 * 1000L
    private const val PREFS_NAME = "rclone_keepalive_prefs"
    private const val KEY_KEEPALIVE_ACTIVE = "keepalive_active"
    private const val KEY_RUNNING_JOBS = "running_jobs"
    private const val KEY_RUNNING_SERVES = "running_serves"
    // The "stopped by Android, tap to resume" notice of versions up to 0.3.6, cleared once.
    private const val LEGACY_RESTART_NOTIFICATION_ID = 4483

    const val ACTION_START = "com.rclone.manager.action.START_KEEPALIVE"
    // The start after a boot or an update, which also starts the backend: there is no activity.
    const val ACTION_BOOT = "com.rclone.manager.action.BOOT_KEEPALIVE"
    const val ACTION_STOP_JOBS = "com.rclone.manager.action.STOP_JOBS"

    // Keys of the system's Live Update (promoted ongoing notification) extras, which the
    // compat builder does not expose yet; older systems ignore them.
    private const val EXTRA_REQUEST_PROMOTED_ONGOING = "android.requestPromotedOngoing"
    private const val EXTRA_SHORT_CRITICAL_TEXT = "android.shortCriticalText"

    private val isKeepAliveRequested = AtomicBoolean(false)
    // The backend wants the service: keep-alive is on, or jobs, mounts or serves are running.
    private val isAppRequested = AtomicBoolean(false)
    private val isServiceRunning = AtomicBoolean(false)
    // Written by the backend's threads, read by the service on the main thread.
    @Volatile
    private var lastState: NotificationState? = null
    private var lastUpdateTime: Long = 0L
    private const val MIN_NOTIFICATION_INTERVAL_MS = 2000L
    private val mainHandler by lazy { Handler(Looper.getMainLooper()) }
    private var pendingUpdateRunnable: Runnable? = null
    // The counts last written to disk, so that only a change is written.
    @Volatile
    private var storedRunning = Pair(-1, -1)

    // The inputs of [needsWakeLocks].
    @Volatile
    private var runningJobs = 0
    @Volatile
    private var runningServes = 0
    @Volatile
    private var uploadsPending = false
    @Volatile
    private var watchPending = false
    // The backend started with the vault locked, so nothing runs until it is unlocked in the
    // app. A vault that locks later stops nothing and does not set this.
    @Volatile
    private var vaultLocked = false
    // The running service, whose locks follow the counts above. Main thread only.
    private var instance: RcloneKeepAliveService? = null

    fun isRunning(): Boolean = isServiceRunning.get()

    private fun hasDocumentWork(): Boolean =
      RcloneSafBridge.getActiveHandleCount() > 0 || uploadsPending

    private fun isNeeded(): Boolean = isAppRequested.get() || hasDocumentWork()

    /** Takes or releases the wake and Wi-Fi locks after one of the counts changed. */
    fun refreshLocks() {
      mainHandler.post { instance?.updateLocks() }
    }

    fun setVaultLocked(locked: Boolean) {
      if (vaultLocked == locked) return
      vaultLocked = locked
      if (isServiceRunning.get()) dispatchNotificationUpdate()
    }

    fun setWatchPending(pending: Boolean) {
      watchPending = pending
      refreshLocks()
    }

    /** Called while files written through the documents provider are still uploading. */
    fun setUploadsPending(pending: Boolean) {
      uploadsPending = pending
      refreshLocks()
    }

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

    // Also kept on disk: after the system kills the process, they tell what was lost. Mounts
    // are not counted: the documents provider keeps them and the backend restores them.
    private fun storeRunning(context: Context, jobs: Int, serves: Int) {
      if (Pair(jobs, serves) == storedRunning) return
      storedRunning = Pair(jobs, serves)
      try {
        // commit, not apply: a quit kills the process right after the counts drop to zero.
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
          .edit().putInt(KEY_RUNNING_JOBS, jobs).putInt(KEY_RUNNING_SERVES, serves).commit()
      } catch (e: Throwable) {
        Logger.error("Failed to store the running counts: ${e.message}")
      }
    }

    /** Called by the frontend; [forceKeepAlive] is the keep-alive setting. */
    fun startService(context: Context, forceKeepAlive: Boolean = false) {
      setKeepAliveRequested(context, forceKeepAlive)
      isAppRequested.set(true)
      launch(context)
    }

    /**
     * Called by the boot receiver. The service starts the backend, which then reports what is
     * running through [sync].
     */
    fun startAtBoot(context: Context) {
      isAppRequested.set(true)
      launch(context, ACTION_BOOT)
    }

    /**
     * Called by the backend whenever jobs, mounts, serves or the keep-alive setting change, and
     * every few seconds while jobs run: starts or stops the service and refreshes its
     * notification. [progress] is the line under the counts while jobs run; [percent] is -1
     * while rclone does not know how much they transfer.
     */
    fun sync(
      context: Context,
      keepAlive: Boolean,
      jobs: Int,
      mounts: Int,
      serves: Int,
      text: String,
      progress: String,
      percent: Int
    ) {
      storeRunning(context, jobs, serves)
      runningJobs = jobs
      runningServes = serves
      refreshLocks()
      val active = jobs + mounts + serves
      if (!keepAlive && active == 0) {
        stopService(context, true)
        return
      }
      if (!isServiceRunning.get() || !isAppRequested.get() || isKeepAliveRequested.get() != keepAlive) {
        startService(context, keepAlive)
      }
      updateNotification(
        NotificationState(
          context.getString(R.string.keepalive_title),
          text.ifBlank { context.getString(R.string.keepalive_text) },
          jobs,
          active,
          progress,
          percent
        )
      )
    }

    /** Keeps the process alive while the file manager streams a document. */
    fun startForDocuments(context: Context) {
      if (!isServiceRunning.get()) launch(context)
    }

    private fun launch(context: Context, startAction: String = ACTION_START) {
      try {
        Logger.info("RcloneKeepAliveService: Starting foreground service (keepAlive=${isKeepAliveRequested.get()})")
        val intent = Intent(context, RcloneKeepAliveService::class.java).apply {
          action = startAction
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
          // Nothing runs any more: a later restart must not report work from before.
          storeRunning(context, 0, 0)
          setKeepAliveRequested(context, false)
          isAppRequested.set(false)
          pendingUpdateRunnable?.let { mainHandler.removeCallbacks(it) }
          pendingUpdateRunnable = null
          lastState = null
          lastUpdateTime = 0L
        }

        if (!isServiceRunning.get() || isAppRequested.get()) {
          return
        }

        if (hasDocumentWork()) {
          Logger.info("RcloneKeepAliveService: Documents are open or uploading, keeping the service")
          updateNotification(
            NotificationState(
              context.getString(R.string.keepalive_title),
              documentText(context),
              0,
              0
            )
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

    private fun documentText(context: Context): String = context.getString(
      if (RcloneSafBridge.getActiveHandleCount() > 0) R.string.saf_keepalive_text else R.string.saf_upload_text
    )

    private fun updateNotification(state: NotificationState) {
      if (state == lastState) return
      if (!isServiceRunning.get()) return

      val now = SystemClock.elapsedRealtime()
      val elapsed = now - lastUpdateTime

      pendingUpdateRunnable?.let { mainHandler.removeCallbacks(it) }

      if (lastUpdateTime == 0L || elapsed >= MIN_NOTIFICATION_INTERVAL_MS) {
        lastUpdateTime = now
        lastState = state
        dispatchNotificationUpdate()
      } else {
        val delay = MIN_NOTIFICATION_INTERVAL_MS - elapsed
        val runnable = Runnable {
          if (!isServiceRunning.get()) return@Runnable
          lastUpdateTime = SystemClock.elapsedRealtime()
          lastState = state
          dispatchNotificationUpdate()
        }
        pendingUpdateRunnable = runnable
        mainHandler.postDelayed(runnable, delay)
      }
    }

    // Posts the notification again in place: restarting the service for every update would cost
    // a service start and a foreground promotion each time. A service still starting builds it
    // from [lastState] itself.
    private fun dispatchNotificationUpdate() {
      mainHandler.post { instance?.refreshNotification() }
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
    getSystemService(NotificationManager::class.java)?.cancel(LEGACY_RESTART_NOTIFICATION_ID)
    promoteToForeground()
    instance = this
    registerReceiver(screenOnReceiver, IntentFilter(Intent.ACTION_SCREEN_ON))
    updateLocks()
  }

  // Updates made while the screen is off would draw a notification nobody sees; the last one
  // is posted when the screen comes on.
  private var updateWaiting = false
  private val screenOnReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      if (updateWaiting) refreshNotification()
    }
  }

  private fun refreshNotification() {
    if (!isForeground) return
    if (getSystemService(PowerManager::class.java)?.isInteractive == false) {
      updateWaiting = true
      return
    }
    updateWaiting = false
    try {
      getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION_ID, buildNotification())
    } catch (e: Throwable) {
      Logger.error("RcloneKeepAliveService: notification update failed: ${e.message}")
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val action = intent?.action
    Logger.info("RcloneKeepAliveService: onStartCommand called (action=$action)")

    // startForegroundService() obliges every start to reach startForeground(), including the
    // ones that stop the service right away.
    if (!isForeground) {
      promoteToForeground()
    }

    // A null intent is the system restarting the service after it killed the process. With
    // keep-alive on, the backend starts again as after a boot and reports what is running.
    if (intent == null) {
      notifyInterruptedWork()
    }
    val restartedBySystem = intent == null && consumeKilledKeepAlive()
    if (restartedBySystem) {
      isAppRequested.set(true)
    }

    if (action == ACTION_STOP_JOBS) {
      RcloneSafBridge.stopAllJobs()
      return START_STICKY
    }

    if (action == ACTION_BOOT || restartedBySystem) {
      // Off the main thread: starting the backend reads the settings and sets up logging.
      Thread { RcloneSafBridge.startCore(applicationContext) }.start()
    }

    if (!isNeeded()) {
      Logger.info("RcloneKeepAliveService: Neither the app nor an open document needs the service, stopping")
      stopForegroundSafely()
      stopSelf()
      return START_NOT_STICKY
    }

    updateLocks()
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
      updateLocks()
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

  // Jobs live in the killed process, so the restarted backend cannot resume them.
  private fun notifyInterruptedWork() {
    val (jobs, serves) = try {
      val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      Pair(prefs.getInt(KEY_RUNNING_JOBS, 0), prefs.getInt(KEY_RUNNING_SERVES, 0))
    } catch (e: Throwable) {
      Logger.error("Failed to read the running counts: ${e.message}")
      Pair(0, 0)
    }
    storeRunning(this, 0, 0)
    val lines = interruptedWorkLines(
      jobs,
      serves,
      { resources.getQuantityString(R.plurals.jobs_interrupted, it, it) },
      { resources.getQuantityString(R.plurals.serves_stopped, it, it) },
      getString(R.string.autostart_restarts)
    )
    if (lines.isEmpty()) return
    RcloneNotifications.showAlert(this, getString(R.string.app_closed_title), lines.joinToString("\n"))
  }

  private fun updateLocks() {
    if (needsWakeLocks(runningJobs, runningServes, watchPending, hasDocumentWork())) {
      acquireLocks()
    } else {
      releaseLocks()
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

  private fun buildNotification(): Notification {
    val state = lastState
    val title = state?.title ?: getString(R.string.keepalive_title)
    val text = when {
      vaultLocked -> getString(R.string.keepalive_locked_text)
      state != null -> state.text
      hasDocumentWork() -> documentText(this)
      else -> getString(R.string.keepalive_text)
    }

    // While jobs run, the counts become the title and the progress the text under them.
    val working = !vaultLocked && state != null && state.jobs > 0
    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(if (working) text else title)
      .setContentText(if (working) state?.progress?.ifBlank { null } else text)
      .setSmallIcon(R.drawable.ic_notification)
      .setOnlyAlertOnce(true)
      .setContentIntent(RcloneNotifications.launchIntent(this))
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setOngoing(true)
      .addAction(0, getString(R.string.action_quit), quitPendingIntent())
    if (state != null && state.jobs > 0) {
      builder.addAction(0, getString(R.string.action_stop_jobs), stopJobsPendingIntent())
    }
    if (working && state != null) {
      builder.setProgress(100, state.percent.coerceAtLeast(0), state.percent < 0)
    }
    // A Live Update, shown as a status bar chip with how far the jobs are, or else the number
    // of running items. The system decides whether to promote it, and the user can turn that
    // off for the app.
    builder.extras.putBoolean(EXTRA_REQUEST_PROMOTED_ONGOING, true)
    val chip = state?.let { statusChipText(working, it.percent, it.active) }
    if (chip != null) {
      builder.extras.putString(EXTRA_SHORT_CRITICAL_TEXT, chip)
    }
    return builder.build()
  }

  // The dialog needs an activity, and a notification may only start one directly.
  private fun quitPendingIntent(): PendingIntent = PendingIntent.getActivity(
    this,
    1,
    Intent(this, QuitConfirmActivity::class.java),
    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
  )

  private fun stopJobsPendingIntent(): PendingIntent = PendingIntent.getService(
    this,
    2,
    Intent(this, RcloneKeepAliveService::class.java).setAction(ACTION_STOP_JOBS),
    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
  )

  private fun promoteToForeground() {
    try {
      val notification = buildNotification()
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
    lastState = null
    lastUpdateTime = 0L
    // A clean stop: nothing is running, and a later restart must not report old work.
    storeRunning(this, 0, 0)
    instance = null
    try {
      unregisterReceiver(screenOnReceiver)
    } catch (e: IllegalArgumentException) {
      Logger.error("RcloneKeepAliveService: screen receiver was not registered: ${e.message}")
    }
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

/**
 * Whether the device must stay awake: jobs and servers run, a folder watcher is about to start
 * its run, or another app has documents open or uploading. Keep-alive or a mount alone does not.
 */
internal fun needsWakeLocks(jobs: Int, serves: Int, watchPending: Boolean, documentWork: Boolean): Boolean =
  jobs > 0 || serves > 0 || watchPending || documentWork

/** The lines of the notice after a system kill; empty when nothing was lost. */
internal fun interruptedWorkLines(
  jobs: Int,
  serves: Int,
  jobsLine: (Int) -> String,
  servesLine: (Int) -> String,
  autostartLine: String
): List<String> = buildList {
  if (jobs > 0) add(jobsLine(jobs))
  if (serves > 0) {
    add(servesLine(serves))
    add(autostartLine)
  }
}

/** What the notification shows; [jobs] decides the stop action, [active] the status bar chip. */
private data class NotificationState(
  val title: String,
  val text: String,
  val jobs: Int,
  val active: Int,
  val progress: String = "",
  val percent: Int = -1
)

/** The status bar chip: how far running jobs are when that is known, else how many items run. */
internal fun statusChipText(working: Boolean, percent: Int, active: Int): String? = when {
  working && percent >= 0 -> "$percent%"
  active > 0 -> active.toString()
  else -> null
}
