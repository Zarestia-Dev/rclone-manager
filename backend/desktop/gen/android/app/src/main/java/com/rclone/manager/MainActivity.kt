package com.rclone.manager

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.provider.Settings
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONArray
import java.io.File
import java.io.FileOutputStream
import java.lang.ref.WeakReference
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** A safe file name for shared text, from the share's subject when it has one. */
internal fun sharedTextFileName(subject: String?): String {
  val base = subject.orEmpty()
    .replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), " ")
    .replace(Regex("\\s+"), " ")
    .trim()
    .trim('.')
    .take(100)
    .trim()
  return "${base.ifEmpty { "Shared text" }}.txt"
}

class MainActivity : TauriActivity() {

  companion object {
    @Volatile
    var sAppWebView: WebView? = null
    @Volatile
    var lastActivityId: Int = 0
    @Volatile
    private var current: WeakReference<MainActivity>? = null

    // Kept outside the activity: the page holds on to the bridge object it loaded with, which
    // keep-alive may have replaced with a newer activity since.
    private val pendingSharedPaths = mutableListOf<String>()
    private var pendingRoute: String? = null
    /** Set while the system picker of an upload is open, so a second request waits for it. */
    @Volatile
    private var uploadPickOpen = false
    private val shareExecutor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
      Thread(runnable, "ShareIntentHandler").apply { isDaemon = true }
    }

    /**
     * Tauri's plugins keep the activity they were loaded with, which keep-alive may have
     * replaced since, so its own finish would miss the activity hosting the window.
     */
    fun finishForQuit() {
      current?.get()?.let { activity -> activity.runOnUiThread { activity.finishAndRemoveTask() } }
    }
  }

  // Reference to the WebView so we can evaluateJavascript from non-UI callbacks
  private var appWebView: WebView? = null

  // The system pickers of an upload. With an engine on another computer, the app's file browser
  // lists that computer's disk, so the files of this device are chosen here instead.
  private val pickUploadFilesLauncher =
    registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
      copyUploadPick(uris.size) { uris.mapNotNull { resolveContentUri(it) } }
    }
  private val pickUploadFolderLauncher =
    registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { tree ->
      copyUploadPick(if (tree == null) 0 else 1) { tree?.let { copyDocumentTree(it) }.orEmpty() }
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
          if (RcloneKeepAliveService.isRunning()) {
            moveTaskToBack(true)
          } else {
            finish()
          }
        }
      }
    })

    RcloneSafBridge.ensureInitialized(applicationContext)

    // Request permissions and clean up temporary cache directories only on clean cold start
    if (savedInstanceState == null) {
      requestAppPermissions()
      cleanupTempDirs()
    }

    super.onCreate(savedInstanceState)
    current = WeakReference(this)

    val cached = sAppWebView
    if (cached != null) {
      // The Rust window outlived its activity; report its id so tao and wry keep addressing it.
      id = lastActivityId
      Logger.info("MainActivity: Re-attaching cached WebView to newly created Activity")
      (cached.parent as? ViewGroup)?.removeView(cached)
      setContentView(cached)
      appWebView = cached
      cached.addJavascriptInterface(this, "__rclone__")
      cached.onResume()
      cached.resumeTimers()
    }
    lastActivityId = id

    handleShareIntent(intent)
    handleOpenSystemFilesIntent(intent)
    handleRouteIntent(intent)
  }

  // While keep-alive runs, the Rust window and WebView outlive this activity so the backend
  // keeps serving; tao and wry only keep them when the destruction looks like a config change.
  private fun preservesRustWindow(): Boolean =
    !RcloneSafBridge.quitRequested && RcloneKeepAliveService.isRunning()

  override fun isChangingConfigurations(): Boolean {
    if (preservesRustWindow()) {
      return true
    }
    return super.isChangingConfigurations()
  }

  override fun onPause() {
    super.onPause()
    // Hides the page, which fires visibilitychange and slows the status polling, without
    // pausing JavaScript. Wry only does this for the WebView it created, not for one that
    // keep-alive carried over from an earlier activity.
    appWebView?.onPause()
    // Work the page started must not stall while the service keeps the process alive.
    if (!RcloneKeepAliveService.isRunning()) {
      appWebView?.pauseTimers()
    }
  }

  override fun onResume() {
    super.onResume()
    appWebView?.onResume()
    appWebView?.resumeTimers()
  }

  override fun onDestroy() {
    if (current?.get() === this) current = null
    appWebView?.removeJavascriptInterface("__rclone__")
    if (preservesRustWindow()) {
      Logger.info("MainActivity: Keep-alive active, detaching WebView but preserving in memory")
      (appWebView?.parent as? ViewGroup)?.removeView(appWebView)
      appWebView = null
      super.onDestroy()
      return
    }
    appWebView = null
    sAppWebView = null
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
    dispatchPageEvent("android-navigate-route", "{route:\"$escaped\"}")
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
    sAppWebView = webView
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
          // Shared text arrives as a text file, which can be uploaded like any shared file.
          val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)
          shareExecutor.execute { queueSharedFiles(listOfNotNull(saveSharedText(text, subject))) }
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
    shareExecutor.execute { queueSharedFiles(uris.mapNotNull { resolveContentUri(it) }) }
  }

  private fun queueSharedFiles(paths: List<String>) {
    if (paths.isEmpty()) return
    synchronized(pendingSharedPaths) {
      pendingSharedPaths.addAll(paths)
    }
    notifyShareFiles(paths)
  }

  private fun saveSharedText(text: String, subject: String?): String? {
    return try {
      val name = sharedTextFileName(subject)
      val target = getUniqueDestinationFile(sharedFilesDir(), name)
      target.writeText(text)
      target.absolutePath
    } catch (e: Exception) {
      Logger.error("saveSharedText failed: ${e.message}")
      null
    }
  }

  /**
   * Copies a content:// URI into the app-private cache and returns the absolute path. The copy
   * keeps the modification time the provider reports, which an upload carries to the remote.
   */
  private fun resolveContentUri(uri: Uri): String? {
    var destFile: File? = null
    return try {
      contentResolver.openInputStream(uri)?.use { input ->
        val (rawName, modified) = queryDocumentInfo(uri)
        val cleanName = File(rawName ?: "shared_file").name.ifBlank { "shared_file" }
        val target = getUniqueDestinationFile(sharedFilesDir(), cleanName)
        destFile = target
        FileOutputStream(target).use { output -> input.copyTo(output) }
        modified?.let { target.setLastModified(it) }
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

  /** The name and modification time (milliseconds) a provider reports for a URI, when it does. */
  private fun queryDocumentInfo(uri: Uri): Pair<String?, Long?> {
    var name: String? = null
    var modified: Long? = null
    if (uri.scheme == "content") {
      contentResolver.query(uri, null, null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
          val nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (nameColumn >= 0) name = cursor.getString(nameColumn)
          // Documents report milliseconds; media shared from a gallery reports seconds.
          val documentColumn = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
          val mediaColumn = cursor.getColumnIndex(MediaStore.MediaColumns.DATE_MODIFIED)
          modified = when {
            documentColumn >= 0 && !cursor.isNull(documentColumn) -> cursor.getLong(documentColumn)
            mediaColumn >= 0 && !cursor.isNull(mediaColumn) -> cursor.getLong(mediaColumn) * 1000
            else -> null
          }?.takeIf { it > 0 }
        }
      }
    }
    return (name ?: uri.lastPathSegment?.substringAfterLast('/')) to modified
  }

  /**
   * Copies the `picked` items the user chose for an upload into the share cache on the share
   * thread. The page hears first that copying started, then which copies exist and how many of
   * the picked items failed. Nothing picked (the picker was closed) ends at once.
   */
  private fun copyUploadPick(picked: Int, copy: () -> List<String>) {
    uploadPickOpen = false
    if (picked == 0) {
      notifyUploadPick("{stage:\"done\",paths:[],failed:0}")
      return
    }
    notifyUploadPick("{stage:\"copying\",count:$picked}")
    shareExecutor.execute {
      val paths = try {
        copy()
      } catch (e: Exception) {
        Logger.error("Copying picked upload files failed: ${e.message}")
        emptyList()
      }
      notifyUploadPick("{stage:\"done\",paths:${JSONArray(paths)},failed:${picked - paths.size}}")
    }
  }

  /**
   * Copies a picked folder with its subfolders, empty ones included, into the share cache.
   * Nothing of it remains when any of its files cannot be copied.
   */
  private fun copyDocumentTree(tree: Uri): List<String> {
    val rootId = DocumentsContract.getTreeDocumentId(tree)
    val rootName = safeDocumentName(queryDocumentInfo(DocumentsContract.buildDocumentUriUsingTree(tree, rootId)).first)
      ?: safeDocumentName(rootId.substringAfterLast(':').substringAfterLast('/'))
      ?: "folder"
    val target = getUniqueDestinationFile(sharedFilesDir(), rootName)
    return try {
      copyDocumentChildren(tree, rootId, target)
      listOf(target.absolutePath)
    } catch (e: Exception) {
      Logger.error("copyDocumentTree failed: ${e.message}")
      target.deleteRecursively()
      emptyList()
    }
  }

  private fun copyDocumentChildren(tree: Uri, parentId: String, target: File) {
    if (!target.mkdirs() && !target.isDirectory) throw java.io.IOException("Cannot create ${target.name}")
    val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId)
    val columns = arrayOf(
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_MIME_TYPE,
      DocumentsContract.Document.COLUMN_LAST_MODIFIED,
    )
    data class Child(val id: String, val name: String, val isDir: Boolean, val modified: Long?)
    val entries = mutableListOf<Child>()
    contentResolver.query(children, columns, null, null, null)?.use { cursor ->
      while (cursor.moveToNext()) {
        val id = cursor.getString(0) ?: continue
        val name = safeDocumentName(cursor.getString(1)) ?: continue
        val isDir = cursor.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR
        val modified = if (cursor.isNull(3)) null else cursor.getLong(3).takeIf { it > 0 }
        entries.add(Child(id, name, isDir, modified))
      }
    } ?: throw java.io.IOException("Cannot list ${target.name}")
    for (entry in entries) {
      val child = File(target, entry.name)
      if (entry.isDir) {
        copyDocumentChildren(tree, entry.id, child)
      } else {
        val uri = DocumentsContract.buildDocumentUriUsingTree(tree, entry.id)
        val input = contentResolver.openInputStream(uri)
          ?: throw java.io.IOException("Cannot open ${entry.name}")
        input.use { source -> FileOutputStream(child).use { output -> source.copyTo(output) } }
        // The upload carries the file's own modification time, not the copy's.
        entry.modified?.let { child.setLastModified(it) }
      }
    }
  }

  /** A provider's display name as one file name, or null for none that can be one. */
  private fun safeDocumentName(name: String?): String? =
    name?.let { File(it).name }?.takeIf { it.isNotBlank() && it != "." && it != ".." }

  private fun notifyUploadPick(detail: String) {
    dispatchPageEvent("android-upload-picked", detail)
  }

  /** Dispatches `android-share-files` CustomEvent to Angular with a list of local paths. */
  private fun notifyShareFiles(paths: List<String>) {
    dispatchPageEvent("android-share-files", "{paths:${JSONArray(paths)}}")
  }

  /** Dispatches the CustomEvent `name` to the page; `detail` is a JavaScript expression. */
  private fun dispatchPageEvent(name: String, detail: String) {
    val js = "window.dispatchEvent(new CustomEvent('$name',{detail:$detail}))"
    appWebView?.post { appWebView?.evaluateJavascript(js, null) }
  }

  /** The cache folder shared and picked files are copied into, created when missing. */
  private fun sharedFilesDir(): File = File(cacheDir, "shared_files").also { it.mkdirs() }

  // ---------------------------------------------------------------------------
  // JS Bridge — called from Angular as window.__rclone__.<method>()
  // ---------------------------------------------------------------------------

  /**
   * Retrieves pending shared file paths queued during cold start,
   * returning them as a JSON array string and clearing the queue.
   */
  @JavascriptInterface
  fun getPendingSharedFiles(): String {
    synchronized(pendingSharedPaths) {
      if (pendingSharedPaths.isEmpty()) return "[]"
      val json = JSONArray(pendingSharedPaths).toString()
      pendingSharedPaths.clear()
      return json
    }
  }

  /**
   * Retrieves pending route queued during cold start (e.g. from App Shortcut),
   * returning the route string and clearing the pending route.
   */
  @JavascriptInterface
  fun getPendingRoute(): String {
    synchronized(pendingSharedPaths) {
      val route = pendingRoute ?: return ""
      pendingRoute = null
      return route
    }
  }

  /**
   * Opens the system picker for files (or one folder) of this device to upload, whichever engine
   * runs: it needs no storage permission and reaches every document provider. The page hears
   * `android-upload-picked` events: `copying` once the user chose, then `done` with the paths of
   * the copies, which it removes with [clearSharedFiles]. Returns false while a picker is open.
   */
  @JavascriptInterface
  fun pickUploadFiles(folder: Boolean): Boolean {
    val activity = current?.get() ?: this
    if (uploadPickOpen) return false
    uploadPickOpen = true
    activity.runOnUiThread {
      try {
        if (folder) activity.pickUploadFolderLauncher.launch(null)
        else activity.pickUploadFilesLauncher.launch(arrayOf("*/*"))
      } catch (e: Exception) {
        Logger.error("Cannot open the upload picker: ${e.message}")
        uploadPickOpen = false
        activity.notifyUploadPick("{stage:\"done\",paths:[],failed:0}")
      }
    }
    return true
  }

  /** Removes only the cached files and folders acknowledged or cancelled by Angular. */
  @JavascriptInterface
  fun clearSharedFiles(pathsJson: String) {
    val paths = try {
      val json = JSONArray(pathsJson)
      (0 until json.length()).map { json.getString(it) }
    } catch (e: Exception) {
      Logger.error("Invalid shared file cleanup request: ${e.message}")
      return
    }
    shareExecutor.execute {
      try {
        val root = File(cacheDir, "shared_files").canonicalFile
        for (path in paths) {
          val file = File(path).canonicalFile
          if (file.parentFile == root) file.deleteRecursively()
        }
        synchronized(pendingSharedPaths) {
          pendingSharedPaths.removeAll(paths.toSet())
        }
      } catch (e: Exception) {
        Logger.error("clearSharedFiles failed: ${e.message}")
      }
    }
  }

  /**
   * Sets the status bar and navigation bar icon appearance (light vs dark icons).
   * @param isDark true if the app is currently displaying a dark theme, false for light theme.
   */
  @JavascriptInterface
  fun setSystemTheme(isDark: Boolean) {
    val activity = current?.get() ?: this
    activity.runOnUiThread {
      val windowInsetsController = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
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

  @JavascriptInterface
  fun isAllFilesAccessGranted(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.R || Environment.isExternalStorageManager()

  @JavascriptInterface
  fun requestAllFilesAccess() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
    try {
      startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
        data = Uri.parse("package:$packageName")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      })
    } catch (e: Exception) {
      try {
        // Some devices only offer the list of all apps.
        startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      } catch (ex: Exception) {
        Logger.error("Failed to open all files access settings: ${ex.message}")
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
    // All files access on Android 11+ is asked for from a banner (requestAllFilesAccess) instead
    // of opening the system settings on every start until it is granted.
  }
}
