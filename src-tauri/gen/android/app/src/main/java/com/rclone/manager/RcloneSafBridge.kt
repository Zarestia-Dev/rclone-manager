package com.rclone.manager

import android.content.Context
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.os.Build
import android.provider.DocumentsContract
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject

data class SafRootItem(
  val remoteName: String,
  val source: String,
  val mountPoint: String
)

object RcloneSafBridge {

  var appContext: Context? = null
  private var isLibraryLoaded = false

  fun loadNativeLibraries() {
    if (isLibraryLoaded) return
    try {
      System.loadLibrary("rclone")
    } catch (e: Throwable) {
      Logger.error("Failed to load librclone.so: ${e.message}")
    }
    try {
      System.loadLibrary("rclone_manager_lib")
      isLibraryLoaded = true
    } catch (e: Throwable) {
      Logger.error("Failed to load librclone_manager_lib.so: ${e.message}")
    }
  }

  private external fun nativeInitSaf(filesDir: String)
  private external fun nativeRpc(jsonPayload: String): String
  private external fun nativeVfsRead(handleId: Long, offset: Long, count: Int, byteArray: ByteArray): Int
  private external fun nativeVfsWrite(handleId: Long, offset: Long, count: Int, byteArray: ByteArray): Int

  private val activeHandleCount = java.util.concurrent.atomic.AtomicInteger(0)

  @JvmStatic
  fun ensureInitialized(context: Context) {
    try {
      loadNativeLibraries()
      if (!isLibraryLoaded) return
      appContext = context.applicationContext
      val configDirPath = context.filesDir.absolutePath
      nativeInitSaf(configDirPath)
      updateAppShortcuts(context)
    } catch (e: Throwable) {
      Logger.error("ensureInitialized error: ${e.message}")
    }
  }

  @JvmStatic
  fun notifyRootsChanged() {
    try {
      val ctx = appContext ?: return
      val rootsUri = DocumentsContract.buildRootsUri("${ctx.packageName}.documents")
      ctx.contentResolver.notifyChange(rootsUri, null)
      updateAppShortcuts(ctx)
    } catch (e: Exception) {
      Logger.error("notifyRootsChanged failed: ${e.message}")
    }
  }

  fun rpc(endpoint: String, params: JSONObject = JSONObject()): JSONObject {
    return try {
      loadNativeLibraries()
      if (!isLibraryLoaded) return JSONObject()
      params.put("_path", endpoint)
      val resStr = nativeRpc(params.toString())
      JSONObject(resStr)
    } catch (e: Throwable) {
      Logger.error("rpc $endpoint error: ${e.message}")
      JSONObject().put("error", e.message ?: "Unknown error")
    }
  }

  private const val PREFS_NAME = "rclone_saf_prefs"
  private const val KEY_MOUNTED_REMOTES = "mounted_remotes"

  private val safRootsList = mutableListOf<SafRootItem>()
  private var isMountedRemotesLoaded = false

  fun getSafSource(remoteName: String): String {
    val cleanName = remoteName.trim().trimEnd(':')
    synchronized(safRootsList) {
      val item = safRootsList.find { it.remoteName == cleanName }
      if (item != null && item.source.isNotEmpty()) {
        return item.source
      }
    }
    return if (cleanName.endsWith(':')) cleanName else "$cleanName:"
  }

  private fun loadMountedRemotesIfNeeded() {
    if (isMountedRemotesLoaded) return
    val ctx = appContext ?: return
    try {
      val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      val jsonStr = prefs.getString(KEY_MOUNTED_REMOTES, "[]") ?: "[]"
      updateMountedRemotesInternal(jsonStr, saveToPrefs = false)
    } catch (e: Exception) {
      Logger.error("loadMountedRemotesIfNeeded error: ${e.message}")
    }
  }

  @JvmStatic
  fun updateMountedRemotes(jsonPayload: String) {
    updateMountedRemotesInternal(jsonPayload, saveToPrefs = true)
  }

  private fun updateMountedRemotesInternal(jsonPayload: String, saveToPrefs: Boolean) {
    try {
      val arr = JSONArray(jsonPayload)
      val newRoots = mutableListOf<SafRootItem>()
      for (i in 0 until arr.length()) {
        val item = arr.opt(i)
        if (item is JSONObject) {
          val fs = item.optString("fs", "").trim()
          val mountPoint = item.optString("mount_point", "").trim()
          val remoteName = if (mountPoint.startsWith("saf://")) {
            mountPoint.substringAfter("saf://")
          } else {
            fs.substringBefore(':')
          }
          if (remoteName.isNotEmpty()) {
            val source = if (fs.isNotEmpty()) fs else "$remoteName:"
            newRoots.add(SafRootItem(remoteName = remoteName, source = source, mountPoint = if (mountPoint.isNotEmpty()) mountPoint else "saf://$remoteName"))
          }
        } else if (item is String) {
          val name = item.trim().trimEnd(':')
          if (name.isNotEmpty()) {
            newRoots.add(SafRootItem(remoteName = name, source = "$name:", mountPoint = "saf://$name"))
          }
        }
      }
      synchronized(safRootsList) {
        safRootsList.clear()
        safRootsList.addAll(newRoots)
      }
      isMountedRemotesLoaded = true

      if (saveToPrefs) {
        appContext?.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)?.edit()?.apply {
          putString(KEY_MOUNTED_REMOTES, jsonPayload)
          apply()
        }
      }

      Logger.info("updateMountedRemotes: active mounted remotes = $safRootsList")
      notifyRootsChanged()
    } catch (e: Exception) {
      Logger.error("updateMountedRemotes error: ${e.message}")
    }
  }

  fun getSafRoots(): List<SafRootItem> {
    return try {
      loadMountedRemotesIfNeeded()
      synchronized(safRootsList) {
        safRootsList.toList()
      }
    } catch (e: Throwable) {
      Logger.error("getSafRoots error: ${e.message}")
      emptyList()
    }
  }

  fun listDirectory(remote: String, path: String): JSONArray {
    val fs = getSafSource(remote)
    val params = JSONObject().put("fs", fs).put("remote", path)
    val res = rpc("vfs/stream/list", params)

    if (res.has("list")) {
      return res.optJSONArray("list") ?: JSONArray()
    }

    val fallback = rpc("operations/list", params)
    return fallback.optJSONArray("list") ?: JSONArray()
  }

  fun getFileInfo(remote: String, path: String): JSONObject? {
    val fs = getSafSource(remote)
    val params = JSONObject().put("fs", fs).put("remote", path)
    val res = rpc("vfs/stream/stat", params)

    if (res.has("item")) {
      return res.optJSONObject("item")
    }

    val fallback = rpc("operations/stat", params)
    return if (fallback.has("item")) fallback.optJSONObject("item") else if (fallback.has("Path")) fallback else null
  }

  fun openVfsFile(remote: String, path: String, mode: String): JSONObject? {
    val fs = getSafSource(remote)
    val params = JSONObject().put("fs", fs).put("remote", path).put("mode", mode)
    val res = rpc("vfs/stream/open", params)
    if (res.has("handle_id")) {
      if (activeHandleCount.incrementAndGet() > 0) {
        appContext?.let { RcloneKeepAliveService.startService(it) }
      }
      return res
    }
    return null
  }

  fun readVfsFile(handleId: Long, offset: Long, count: Int, destination: ByteArray): Int {
    if (isLibraryLoaded) {
      val n = nativeVfsRead(handleId, offset, count, destination)
      if (n >= 0) return n
    }
    return 0
  }

  fun writeVfsFile(handleId: Long, offset: Long, source: ByteArray, count: Int): Int {
    if (isLibraryLoaded) {
      val n = nativeVfsWrite(handleId, offset, count, source)
      if (n >= 0) return n
    }
    return 0
  }

  fun closeVfsFile(handleId: Long): Boolean {
    val params = JSONObject().put("handle_id", handleId)
    val res = rpc("vfs/stream/close", params)
    if (activeHandleCount.decrementAndGet() <= 0) {
      activeHandleCount.set(0)
      appContext?.let { RcloneKeepAliveService.stopService(it) }
    }
    return res.optBoolean("success", true)
  }

  fun createDirectory(remote: String, path: String): Boolean {
    val fs = getSafSource(remote)
    val params = JSONObject().put("fs", fs).put("remote", path)
    val res = rpc("operations/mkdir", params)
    return !res.has("error")
  }

  fun deleteItem(remote: String, path: String, isDir: Boolean): Boolean {
    val fs = getSafSource(remote)
    val endpoint = if (isDir) "operations/purge" else "operations/deletefile"
    val params = JSONObject().put("fs", fs).put("remote", path)
    val res = rpc(endpoint, params)
    return !res.has("error")
  }

  fun renameItem(remote: String, srcPath: String, dstPath: String, isDir: Boolean): Boolean {
    val fs = getSafSource(remote)
    val endpoint = if (isDir) "sync/move" else "operations/movefile"
    val params = if (isDir) {
      JSONObject()
        .put("srcFs", if (srcPath.isEmpty()) fs else "$fs/$srcPath")
        .put("dstFs", if (dstPath.isEmpty()) fs else "$fs/$dstPath")
        .put("createEmptySrcDirs", true)
        .put("deleteEmptySrcDirs", true)
    } else {
      JSONObject()
        .put("srcFs", fs)
        .put("srcRemote", srcPath)
        .put("dstFs", fs)
        .put("dstRemote", dstPath)
    }
    val res = rpc(endpoint, params)
    return !res.has("error")
  }

  fun copyItem(
    srcRemoteName: String,
    srcPath: String,
    dstRemoteName: String,
    dstPath: String,
    isDir: Boolean
  ): Boolean {
    val srcFs = getSafSource(srcRemoteName)
    val dstFs = getSafSource(dstRemoteName)
    val endpoint = if (isDir) "sync/copy" else "operations/copyfile"
    val params = if (isDir) {
      JSONObject()
        .put("srcFs", if (srcPath.isEmpty()) srcFs else "$srcFs/$srcPath")
        .put("dstFs", if (dstPath.isEmpty()) dstFs else "$dstFs/$dstPath")
    } else {
      JSONObject()
        .put("srcFs", srcFs)
        .put("srcRemote", srcPath)
        .put("dstFs", dstFs)
        .put("dstRemote", dstPath)
    }
    val res = rpc(endpoint, params)
    return !res.has("error")
  }

  fun moveItemAcrossRemotes(
    srcRemoteName: String,
    srcPath: String,
    dstRemoteName: String,
    dstPath: String,
    isDir: Boolean
  ): Boolean {
    val srcFs = getSafSource(srcRemoteName)
    val dstFs = getSafSource(dstRemoteName)
    val endpoint = if (isDir) "sync/move" else "operations/movefile"
    val params = if (isDir) {
      JSONObject()
        .put("srcFs", if (srcPath.isEmpty()) srcFs else "$srcFs/$srcPath")
        .put("dstFs", if (dstPath.isEmpty()) dstFs else "$dstFs/$dstPath")
        .put("deleteEmptySrcDirs", true)
    } else {
      JSONObject()
        .put("srcFs", srcFs)
        .put("srcRemote", srcPath)
        .put("dstFs", dstFs)
        .put("dstRemote", dstPath)
    }
    val res = rpc(endpoint, params)
    return !res.has("error")
  }

  fun searchFiles(remote: String, query: String): JSONArray {
    val qClean = query.trim()
    if (qClean.isEmpty() || qClean.length < 2) {
      return JSONArray()
    }

    val fs = getSafSource(remote)
    val params = JSONObject()
      .put("fs", fs)
      .put("remote", "")
    val opt = JSONObject()
      .put("recurse", true)
      .put("maxDepth", 3)
    params.put("opt", opt)

    val res = rpc("operations/list", params)
    val allList = res.optJSONArray("list") ?: JSONArray()
    val filtered = JSONArray()
    val qLower = qClean.lowercase()

    for (i in 0 until allList.length()) {
      val item = allList.optJSONObject(i) ?: continue
      val name = item.optString("Name", "")
      if (name.lowercase().contains(qLower)) {
        filtered.put(item)
        if (filtered.length() >= 100) break
      }
    }
    return filtered
  }

  fun updateAppShortcuts(context: Context) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N_MR1) {
      try {
        val shortcutManager = context.getSystemService(ShortcutManager::class.java) ?: return
        val roots = getSafRoots()
        val shortcuts = mutableListOf<ShortcutInfo>()
        val authority = "${context.packageName}.documents"

        val nautilusIntent = Intent(context, MainActivity::class.java).apply {
          action = Intent.ACTION_VIEW
          putExtra("route", "nautilus")
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }

        val nautilusShortcut = ShortcutInfo.Builder(context, "shortcut_nautilus")
          .setShortLabel("File Manager")
          .setLongLabel("Open File Manager")
          .setIcon(Icon.createWithResource(context, R.drawable.ic_folder_manager))
          .setIntent(nautilusIntent)
          .setRank(0)
          .build()

        shortcuts.add(nautilusShortcut)

        for ((index, root) in roots.take(3).withIndex()) {
          val rootUri = DocumentsContract.buildRootUri(authority, root.remoteName)
          val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(rootUri, "vnd.android.document/root")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
          }

          val shortcut = ShortcutInfo.Builder(context, "saf_remote_${root.remoteName}")
            .setShortLabel(root.remoteName)
            .setLongLabel("Open ${root.remoteName}")
            .setIcon(Icon.createWithResource(context, R.mipmap.ic_launcher))
            .setIntent(intent)
            .setRank(index + 1)
            .build()

          shortcuts.add(shortcut)
        }

        shortcutManager.dynamicShortcuts = shortcuts
      } catch (e: Exception) {
        Logger.error("updateAppShortcuts error: ${e.message}")
      }
    }
  }

  @JvmStatic
  fun openSafRemote(remoteName: String): Boolean {
    val ctx = appContext ?: return false
    return try {
      val authority = "${ctx.packageName}.documents"
      val rootUri = DocumentsContract.buildRootUri(authority, remoteName)
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(rootUri, DocumentsContract.Root.MIME_TYPE_ITEM)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      ctx.startActivity(intent)
      true
    } catch (e: Exception) {
      Logger.error("openSafRemote failed: ${e.message}")
      false
    }
  }
}
