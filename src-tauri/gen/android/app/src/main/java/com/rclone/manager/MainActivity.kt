package com.rclone.manager

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream

class MainActivity : TauriActivity() {

  // Reference to the WebView so we can evaluateJavascript from non-UI callbacks
  private var appWebView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    requestStoragePermission()

    // Copy bundled assets to cache directory so Rust std::fs can access them
    val destDir = File(cacheDir, "resources")
    copyAssetsDir("i18n", destDir)
    copyAssetFile("serve-template.html", File(destDir, "serve-template.html"))
    copyAssetFile("oauth-template.html", File(destDir, "oauth-template.html"))

    // Clean up temporary cache directories from previous sessions
    cleanupTempDirs()

    super.onCreate(savedInstanceState)

    // Handle incoming share intent (Share Receiver) — app was cold-started via share
    handleShareIntent(intent)
  }

  override fun onDestroy() {
    super.onDestroy()
    cleanupTempDirs()
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
    // App was already running; new share intent arrived
    handleShareIntent(intent)
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
   * Copies the shared content to app cache and notifies Angular via a CustomEvent.
   */
  private fun handleShareIntent(intent: Intent?) {
    val action = intent?.action ?: return

    val uris = mutableListOf<Uri>()
    when (action) {
      Intent.ACTION_SEND -> {
        val uri = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
        if (uri != null) {
          uris.add(uri)
        } else {
          val text = intent.getStringExtra(Intent.EXTRA_TEXT)
          if (text != null) { notifyShareText(text); return }
        }
      }
      Intent.ACTION_SEND_MULTIPLE -> {
        val list = intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
        if (list != null) uris.addAll(list)
      }
      else -> return
    }

    if (uris.isEmpty()) return
    val paths = uris.mapNotNull { resolveContentUri(it) }
    if (paths.isNotEmpty()) notifyShareFiles(paths)
  }

  /**
   * Copies a content:// URI into the app-private cache and returns the absolute path.
   */
  private fun resolveContentUri(uri: Uri): String? {
    return try {
      contentResolver.openInputStream(uri)?.use { input ->
        val fileName = getFileNameFromUri(uri) ?: "shared_file"
        val destDir = File(cacheDir, "shared_files").also { it.mkdirs() }
        val destFile = File(destDir, fileName)
        FileOutputStream(destFile).use { output -> input.copyTo(output) }
        destFile.absolutePath
      }
    } catch (e: Exception) {
      Logger.error("resolveContentUri failed: ${e.message}")
      null
    }
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
    val escaped = paths.joinToString(",") { "\"${it.replace("\"", "\\\"")}\"" }
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

  private fun getMimeType(path: String): String = when (path.substringAfterLast('.', "").lowercase()) {
    "pdf"  -> "application/pdf"
    "jpg", "jpeg" -> "image/jpeg"
    "png"  -> "image/png"
    "gif"  -> "image/gif"
    "webp" -> "image/webp"
    "mp4"  -> "video/mp4"
    "mp3"  -> "audio/mpeg"
    "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    "doc"  -> "application/msword"
    "xlsx" -> "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    "pptx" -> "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    "zip"  -> "application/zip"
    "txt"  -> "text/plain"
    else   -> "*/*"
  }

  // ---------------------------------------------------------------------------
  // Storage permission & asset helpers (unchanged from original)
  // ---------------------------------------------------------------------------

  private fun requestStoragePermission() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      if (!Environment.isExternalStorageManager()) {
        try {
          val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION)
          intent.data = Uri.parse("package:$packageName")
          startActivity(intent)
        } catch (e: Exception) {
          try {
            startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
          } catch (ex: Exception) {
            ex.printStackTrace()
          }
        }
      }
    } else {
      requestPermissions(arrayOf(
        android.Manifest.permission.READ_EXTERNAL_STORAGE,
        android.Manifest.permission.WRITE_EXTERNAL_STORAGE
      ), 100)
    }
  }

  private fun copyAssetsDir(assetDirPath: String, destDir: File) {
    try {
      val list = assets.list(assetDirPath) ?: return
      if (list.isEmpty()) {
        copyAssetFile(assetDirPath, File(destDir, assetDirPath))
      } else {
        val dir = File(destDir, assetDirPath).also { if (!it.exists()) it.mkdirs() }
        for (asset in list) {
          copyAssetsDir(if (assetDirPath.isEmpty()) asset else "$assetDirPath/$asset", destDir)
        }
      }
    } catch (e: Exception) { e.printStackTrace() }
  }

  private fun copyAssetFile(assetPath: String, destFile: File) {
    try {
      assets.open(assetPath).use { input ->
        destFile.parentFile?.mkdirs()
        FileOutputStream(destFile).use { output -> input.copyTo(output) }
      }
    } catch (e: Exception) { e.printStackTrace() }
  }
}
