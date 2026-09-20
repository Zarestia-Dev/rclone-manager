package com.rclone.manager

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.provider.DocumentsContract
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class MainActivity : TauriActivity() {

  // Reference to the WebView so we can evaluateJavascript from non-UI callbacks
  private var appWebView: WebView? = null

  private val shareExecutor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "ShareIntentHandler").apply { isDaemon = true }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    val isNightMode = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES
    val windowInsetsController = WindowCompat.getInsetsController(window, window.decorView)
    windowInsetsController.isAppearanceLightStatusBars = !isNightMode
    windowInsetsController.isAppearanceLightNavigationBars = !isNightMode

    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val webView = appWebView
        if (webView != null && webView.canGoBack()) {
          webView.goBack()
        } else {
          moveTaskToBack(true)
        }
      }
    })

    RcloneSafBridge.ensureInitialized(applicationContext)

    // Extract bundled assets to cache directory if first launch or app update
    extractAssetsIfNeeded()

    // Request permissions and clean up temporary cache directories only on clean cold start
    if (savedInstanceState == null) {
      requestAppPermissions()
      cleanupTempDirs()
    }

    super.onCreate(savedInstanceState)

    handleShareIntent(intent)
    handleOpenSystemFilesIntent(intent)
    handleRouteIntent(intent)
  }

  // Queued data for cold start handover to Angular
  private val pendingSharedPaths = mutableListOf<String>()
  private var pendingRoute: String? = null
  @Volatile private var isFrontendReady = false

  override fun onDestroy() {
    appWebView?.removeJavascriptInterface("__rclone__")
    appWebView = null
    shareExecutor.shutdown()
    super.onDestroy()
  }

  private fun cleanupTempDirs() {
    try {
      File(cacheDir, "temp_views").deleteRecursively()
      File(cacheDir, "shared_files").deleteRecursively()
    } catch (e: Exception) {
      e.printStackTrace()
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handleShareIntent(intent)
    handleOpenSystemFilesIntent(intent)
    handleRouteIntent(intent)
  }

  private fun handleRouteIntent(intent: Intent?) {
    if (intent == null) return
    val route = intent.getStringExtra("route") ?: return
    intent.removeExtra("route")
    if (route.isNotEmpty()) {
      synchronized(pendingSharedPaths) {
        pendingRoute = route
      }
      notifyNavigateRoute(route)
    }
  }

  private fun notifyNavigateRoute(route: String) {
    val escaped = route.replace("\\", "\\\\").replace("\"", "\\\"")
    val js = "window.dispatchEvent(new CustomEvent('android-navigate-route',{detail:{route:\"$escaped\"}}))"
    appWebView?.post { appWebView?.evaluateJavascript(js, null) }
  }

  private fun handleOpenSystemFilesIntent(intent: Intent?) {
    if (intent == null) return
    if (intent.action == "com.rclone.manager.OPEN_SYSTEM_FILES") {
      val remoteName = intent.getStringExtra("remote") ?: return
      intent.action = null
      openSystemFileBrowserWithCallback(remoteName) {
        moveTaskToBack(true)
      }
    }
  }

  /**
   * Called by WryActivity when the WebView is created.
   * We register our @JavascriptInterface bridge here as `window.__rclone__`.
   */
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    appWebView = webView
    webView.addJavascriptInterface(this, "__rclone__")
  }

  // ---------------------------------------------------------------------------
  // Share Receiver
  // ---------------------------------------------------------------------------

  /**
   * Handles incoming ACTION_SEND / ACTION_SEND_MULTIPLE intents from other apps.
   * Copies the shared content to app cache asynchronously and notifies Angular via a CustomEvent or queue.
   */
  private fun handleShareIntent(intent: Intent?) {
    val action = intent?.action ?: return
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return

    val uris = mutableListOf<Uri>()

    // 1. Check EXTRA_STREAM (compat across all Android versions)
    if (action == Intent.ACTION_SEND) {
      val uri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
      } else {
        @Suppress("DEPRECATION")
        intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
      }
      if (uri != null) {
        uris.add(uri)
      } else {
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)
        if (text != null) {
          intent.action = null
          notifyShareText(text)
          return
        }
      }
    } else if (action == Intent.ACTION_SEND_MULTIPLE) {
      val list = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
      } else {
        @Suppress("DEPRECATION")
        intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
      }
      if (list != null) uris.addAll(list)
    }

    // 2. Also check ClipData (modern Android 10+ standard used by Google Photos, Samsung Gallery, etc.)
    val clipData = intent.clipData
    if (clipData != null) {
      for (i in 0 until clipData.itemCount) {
        val itemUri = clipData.getItemAt(i).uri
        if (itemUri != null && !uris.contains(itemUri)) {
          uris.add(itemUri)
        }
      }
    }

    // Clear intent action so activity re-creations (e.g. rotation) don't re-trigger
    intent.action = null

    // Run file copying in background executor to prevent UI thread lock / ANR on large files
    shareExecutor.execute {
      val paths = uris.mapNotNull { resolveContentUri(it) }
      if (paths.isNotEmpty()) {
        synchronized(pendingSharedPaths) {
          pendingSharedPaths.addAll(paths)
        }
        notifyShareFiles(paths)
      }
    }
  }

  /**
   * Copies a content:// URI into the app-private cache and returns the absolute path.
   */
  private fun resolveContentUri(uri: Uri): String? {
    var destFile: File? = null
    return try {
      contentResolver.openInputStream(uri)?.use { input ->
        val rawName = getFileNameFromUri(uri) ?: "shared_file"
        val cleanName = File(rawName).name.ifBlank { "shared_file" }
        val destDir = File(cacheDir, "shared_files").also { it.mkdirs() }
        val target = getUniqueDestinationFile(destDir, cleanName)
        destFile = target
        FileOutputStream(target).use { output -> input.copyTo(output) }
        target.absolutePath
      }
    } catch (e: Exception) {
      destFile?.delete()
      Logger.error("resolveContentUri failed: ${e.message}")
      null
    }
  }

  private fun getUniqueDestinationFile(destDir: File, fileName: String): File {
    val file = File(destDir, fileName)
    if (!file.exists()) return file

    val dotIndex = fileName.lastIndexOf('.')
    val name = if (dotIndex > 0) fileName.substring(0, dotIndex) else fileName
    val ext = if (dotIndex > 0) fileName.substring(dotIndex) else ""
    return File(destDir, "${name}_${System.nanoTime()}$ext")
  }

  private fun getFileNameFromUri(uri: Uri): String? {
    var name: String? = null
    if (uri.scheme == "content") {
      contentResolver.query(uri, null, null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
          val col = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
          if (col >= 0) name = cursor.getString(col)
        }
      }
    }
    return name ?: uri.lastPathSegment?.substringAfterLast('/')
  }

  /** Dispatches `android-share-files` CustomEvent to Angular with a list of local paths. */
  private fun notifyShareFiles(paths: List<String>) {
    val escaped = paths.joinToString(",") { "\"${it.replace("\\", "\\\\").replace("\"", "\\\"")}\"" }
    val js = "window.dispatchEvent(new CustomEvent('android-share-files',{detail:{paths:[$escaped]}}))"
    appWebView?.post { appWebView?.evaluateJavascript(js, null) }
  }

  /** Dispatches `android-share-text` CustomEvent to Angular with shared text. */
  private fun notifyShareText(text: String) {
    val escaped = text.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n")
    val js = "window.dispatchEvent(new CustomEvent('android-share-text',{detail:{text:\"$escaped\"}}))"
    appWebView?.post { appWebView?.evaluateJavascript(js, null) }
  }

  // ---------------------------------------------------------------------------
  // JS Bridge — called from Angular as window.__rclone__.<method>()
  // ---------------------------------------------------------------------------

  /**
   * Retrieves pending shared file paths queued during cold start,
   * returning them as a JSON array string and clearing the queue.
   */
  @JavascriptInterface
  fun getPendingSharedFiles(): String {
    isFrontendReady = true
    synchronized(pendingSharedPaths) {
      if (pendingSharedPaths.isEmpty()) return "[]"
      val escaped = pendingSharedPaths.joinToString(",") { "\"${it.replace("\\", "\\\\").replace("\"", "\\\"")}\"" }
      pendingSharedPaths.clear()
      return "[$escaped]"
    }
  }

  /**
   * Retrieves pending route queued during cold start (e.g. from App Shortcut),
   * returning the route string and clearing the pending route.
   */
  @JavascriptInterface
  fun getPendingRoute(): String {
    isFrontendReady = true
    synchronized(pendingSharedPaths) {
      val route = pendingRoute ?: return ""
      pendingRoute = null
      return route
    }
  }

  /**
   * Cleans up the temporary shared_files cache directory.
   * Called when Angular cancels the pending share.
   */
  @JavascriptInterface
  fun clearSharedFiles() {
    synchronized(pendingSharedPaths) {
      pendingSharedPaths.clear()
    }
    try {
      File(cacheDir, "shared_files").deleteRecursively()
    } catch (e: Exception) {
      Logger.error("clearSharedFiles failed: ${e.message}")
    }
  }

  /**
   * Signals that Angular has mounted and registered listeners.
   */
  @JavascriptInterface
  fun notifyFrontendReady() {
    isFrontendReady = true
  }

  /**
   * Sets the status bar and navigation bar icon appearance (light vs dark icons).
   * @param isDark true if the app is currently displaying a dark theme, false for light theme.
   */
  @JavascriptInterface
  fun setSystemTheme(isDark: Boolean) {
    runOnUiThread {
      val windowInsetsController = WindowCompat.getInsetsController(window, window.decorView)
      windowInsetsController.isAppearanceLightStatusBars = !isDark
      windowInsetsController.isAppearanceLightNavigationBars = !isDark
    }
  }

  @JavascriptInterface
  fun isBatteryOptimizationIgnored(): Boolean {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
      return pm?.isIgnoringBatteryOptimizations(packageName) ?: true
    }
    return true
  }

  @JavascriptInterface
  fun requestIgnoreBatteryOptimizations() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      try {
        val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
        if (pm != null && !pm.isIgnoringBatteryOptimizations(packageName)) {
          val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = Uri.parse("package:$packageName")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          }
          startActivity(intent)
        }
      } catch (e: Exception) {
        Logger.error("requestIgnoreBatteryOptimizations failed: ${e.message}")
      }
    }
  }

  /**
   * Opens a local file in its default handler using a FileProvider content:// URI.
   * Avoids FileUriExposedException (Android 7+) that `file://` URIs cause.
   */
  @JavascriptInterface
  fun openLocalFile(absolutePath: String) {
    try {
      val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", File(absolutePath))
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, getMimeType(absolutePath))
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      startActivity(intent)
    } catch (e: Exception) {
      Logger.error("openLocalFile failed: ${e.message}")
    }
  }

  @JavascriptInterface
  fun openSystemFileBrowser(remoteName: String) {
    openSystemFileBrowserWithCallback(remoteName, null)
  }

  fun openSystemFileBrowserWithCallback(remoteName: String, onComplete: (() -> Unit)? = null) {
    runOnUiThread {
      try {
        val authority = "$packageName.documents"
        val rootUri = if (remoteName.isNotBlank()) {
          DocumentsContract.buildRootUri(authority, remoteName)
        } else {
          DocumentsContract.buildRootsUri(authority)
        }

        val intent = Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(rootUri, DocumentsContract.Root.MIME_TYPE_ITEM)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        if (intent.resolveActivity(packageManager) != null) {
          startActivity(intent)
        } else {
          val browseIntent = Intent("android.provider.action.BROWSE").apply {
            data = rootUri
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
          }
          startActivity(browseIntent)
        }
        onComplete?.invoke()
      } catch (e: Exception) {
        Logger.error("openSystemFileBrowser error: ${e.message}")
      }
    }
  }


  /**
   * Opens the Android share sheet for a locally cached file.
   * Angular calls this after Rust streams the remote file to app cache.
   */
  @JavascriptInterface
  fun shareFile(absolutePath: String) {
    try {
      val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", File(absolutePath))
      val chooser = Intent.createChooser(
        Intent(Intent.ACTION_SEND).apply {
          type = getMimeType(absolutePath)
          putExtra(Intent.EXTRA_STREAM, uri)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        },
        null
      ).apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
      startActivity(chooser)
    } catch (e: Exception) {
      Logger.error("shareFile failed: ${e.message}")
    }
  }

  private fun getMimeType(path: String): String {
    val ext = path.substringAfterLast('.', "").lowercase()
    if (ext.isEmpty()) return "*/*"
    return android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "*/*"
  }

  // ---------------------------------------------------------------------------
  // Storage permission & asset helpers (unchanged from original)
  // ---------------------------------------------------------------------------

  private fun requestAppPermissions() {
    val runtimePermissions = mutableListOf<String>()

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
        runtimePermissions.add(android.Manifest.permission.POST_NOTIFICATIONS)
      }
    }

    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      if (checkSelfPermission(android.Manifest.permission.READ_EXTERNAL_STORAGE) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
        runtimePermissions.add(android.Manifest.permission.READ_EXTERNAL_STORAGE)
      }
      if (checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
        runtimePermissions.add(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
      }
    }

    if (runtimePermissions.isNotEmpty()) {
      requestPermissions(runtimePermissions.toTypedArray(), 100)
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      if (!Environment.isExternalStorageManager()) {
        try {
          val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
            data = Uri.parse("package:$packageName")
          }
          startActivity(intent)
        } catch (e: Exception) {
          try {
            startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
          } catch (ex: Exception) {
            Logger.error("Failed to open storage settings: ${ex.message}")
          }
        }
      }
    }
  }

  private fun extractAssetsIfNeeded() {
    val destDir = File(cacheDir, "resources")
    val versionFile = File(destDir, ".version")
    val currentVersion = BuildConfig.VERSION_CODE.toString()

    if (versionFile.exists() && versionFile.readText().trim() == currentVersion && File(destDir, "i18n").exists()) {
      return
    }

    try {
      copyAssetsDir("i18n", destDir)
      copyAssetFile("serve-template.html", File(destDir, "serve-template.html"))
      copyAssetFile("oauth-template.html", File(destDir, "oauth-template.html"))
      versionFile.writeText(currentVersion)
    } catch (e: Exception) {
      Logger.error("extractAssetsIfNeeded error: ${e.message}")
    }
  }

  private fun copyAssetsDir(assetDirPath: String, destDir: File) {
    try {
      val list = assets.list(assetDirPath) ?: return
      if (list.isEmpty()) {
        copyAssetFile(assetDirPath, File(destDir, assetDirPath))
      } else {
        File(destDir, assetDirPath).also { if (!it.exists()) it.mkdirs() }
        for (asset in list) {
          copyAssetsDir(if (assetDirPath.isEmpty()) asset else "$assetDirPath/$asset", destDir)
        }
      }
    } catch (e: Exception) {
      Logger.error("copyAssetsDir error: ${e.message}")
    }
  }

  private fun copyAssetFile(assetPath: String, destFile: File) {
    try {
      assets.open(assetPath).use { input ->
        destFile.parentFile?.mkdirs()
        FileOutputStream(destFile).use { output -> input.copyTo(output) }
      }
    } catch (e: Exception) {
      Logger.error("copyAssetFile error for $assetPath: ${e.message}")
    }
  }
}
