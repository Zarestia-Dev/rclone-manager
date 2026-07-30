package com.rclone.manager

import android.content.res.AssetFileDescriptor
import android.database.Cursor
import android.database.MatrixCursor
import android.graphics.Point
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.HandlerThread
import android.os.OperationCanceledException
import android.os.ParcelFileDescriptor
import android.os.ProxyFileDescriptorCallback
import android.os.storage.StorageManager
import android.provider.DocumentsContract
import android.provider.DocumentsProvider
import android.webkit.MimeTypeMap
import org.json.JSONObject
import java.io.FileNotFoundException

class RcloneDocumentsProvider : DocumentsProvider() {

  companion object {
    private val DEFAULT_ROOT_PROJECTION: Array<String> = arrayOf(
      DocumentsContract.Root.COLUMN_ROOT_ID,
      DocumentsContract.Root.COLUMN_FLAGS,
      DocumentsContract.Root.COLUMN_ICON,
      DocumentsContract.Root.COLUMN_TITLE,
      DocumentsContract.Root.COLUMN_SUMMARY,
      DocumentsContract.Root.COLUMN_DOCUMENT_ID,
      DocumentsContract.Root.COLUMN_MIME_TYPES
    )

    private val DEFAULT_DOCUMENT_PROJECTION: Array<String> = arrayOf(
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_MIME_TYPE,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_LAST_MODIFIED,
      DocumentsContract.Document.COLUMN_FLAGS,
      DocumentsContract.Document.COLUMN_SIZE
    )

    // Predefined SAF Flag Masks
    private const val DIR_DEFAULT_FLAGS =
      DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE or
        DocumentsContract.Document.FLAG_SUPPORTS_DELETE or
        DocumentsContract.Document.FLAG_SUPPORTS_REMOVE or
        DocumentsContract.Document.FLAG_SUPPORTS_RENAME or
        DocumentsContract.Document.FLAG_SUPPORTS_COPY or
        DocumentsContract.Document.FLAG_SUPPORTS_MOVE

    private const val FILE_BASE_FLAGS =
      DocumentsContract.Document.FLAG_SUPPORTS_DELETE or
        DocumentsContract.Document.FLAG_SUPPORTS_REMOVE or
        DocumentsContract.Document.FLAG_SUPPORTS_RENAME or
        DocumentsContract.Document.FLAG_SUPPORTS_COPY or
        DocumentsContract.Document.FLAG_SUPPORTS_MOVE
  }

  private fun isReadOnlyTarget(info: JSONObject?): Boolean {
    return info?.optBoolean("IsReadOnly", false) == true || info?.optBoolean("ReadOnly", false) == true
  }

  private fun getDocumentFlags(isDir: Boolean, mimeType: String, isReadOnly: Boolean = false): Int {
    if (isDir) {
      return if (isReadOnly) {
        DocumentsContract.Document.FLAG_SUPPORTS_COPY
      } else {
        DIR_DEFAULT_FLAGS
      }
    }

    var flags = if (isReadOnly) DocumentsContract.Document.FLAG_SUPPORTS_COPY else FILE_BASE_FLAGS
    if (!isReadOnly) {
      flags = flags or DocumentsContract.Document.FLAG_SUPPORTS_WRITE
    }
    if (isThumbnailSupported(mimeType)) {
      flags = flags or DocumentsContract.Document.FLAG_SUPPORTS_THUMBNAIL
    }
    return flags
  }

  private inline fun <R> withParcelableException(block: () -> R): R {
    try {
      return block()
    } catch (e: Throwable) {
      when (e) {
        is SecurityException,
        is IllegalArgumentException,
        is NullPointerException,
        is IllegalStateException,
        is UnsupportedOperationException,
        is OperationCanceledException,
        is FileNotFoundException -> throw e
        else -> throw IllegalStateException(e.message ?: "Operation failed", e)
      }
    }
  }

  private fun parseModTime(modTimeStr: String?): Long {
    if (modTimeStr.isNullOrEmpty()) return System.currentTimeMillis()
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        try {
          java.time.Instant.parse(modTimeStr).toEpochMilli()
        } catch (_: Exception) {
          java.time.OffsetDateTime.parse(modTimeStr).toInstant().toEpochMilli()
        }
      } else {
        System.currentTimeMillis()
      }
    } catch (_: Exception) {
      System.currentTimeMillis()
    }
  }

  private fun getAuthority(): String {
    val pkg = context?.packageName ?: "com.rclone.manager"
    return "$pkg.documents"
  }

  override fun onCreate(): Boolean {
    context?.let { RcloneSafBridge.ensureInitialized(it.applicationContext) }
    return true
  }

  private fun ensureInit() {
    context?.let { RcloneSafBridge.ensureInitialized(it.applicationContext) }
  }

  override fun queryRoots(projection: Array<out String>?): Cursor = withParcelableException {
    ensureInit()
    val authority = getAuthority()
    val result = MatrixCursor(projection ?: DEFAULT_ROOT_PROJECTION)
    try {
      result.setNotificationUri(context?.contentResolver, DocumentsContract.buildRootsUri(authority))
    } catch (_: Exception) {}
    val roots = RcloneSafBridge.getSafRoots()

    for (root in roots) {
      val row = result.newRow()
      val docId = "${root.remoteName}:/"
      row.add(DocumentsContract.Root.COLUMN_ROOT_ID, root.remoteName)
      row.add(
        DocumentsContract.Root.COLUMN_FLAGS,
        DocumentsContract.Root.FLAG_SUPPORTS_CREATE or
          DocumentsContract.Root.FLAG_SUPPORTS_SEARCH or
          DocumentsContract.Root.FLAG_SUPPORTS_IS_CHILD
      )
      row.add(DocumentsContract.Root.COLUMN_ICON, R.mipmap.ic_launcher)
      row.add(DocumentsContract.Root.COLUMN_TITLE, root.remoteName)
      row.add(DocumentsContract.Root.COLUMN_SUMMARY, root.source)
      row.add(DocumentsContract.Root.COLUMN_DOCUMENT_ID, docId)
      row.add(DocumentsContract.Root.COLUMN_MIME_TYPES, "*/*")
    }

    return result
  }

  override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor = withParcelableException {
    ensureInit()
    val authority = getAuthority()
    val result = MatrixCursor(projection ?: DEFAULT_DOCUMENT_PROJECTION)
    try {
      result.setNotificationUri(context?.contentResolver, DocumentsContract.buildDocumentUri(authority, documentId))
    } catch (_: Exception) {}
    val (remote, path) = parseDocId(documentId)

    if (path.isEmpty() || path == "/") {
      val row = result.newRow()
      row.add(DocumentsContract.Document.COLUMN_DOCUMENT_ID, documentId)
      row.add(DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.MIME_TYPE_DIR)
      row.add(DocumentsContract.Document.COLUMN_DISPLAY_NAME, remote)
      row.add(DocumentsContract.Document.COLUMN_LAST_MODIFIED, System.currentTimeMillis())
      row.add(DocumentsContract.Document.COLUMN_FLAGS, DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE)
      row.add(DocumentsContract.Document.COLUMN_SIZE, 0L)
      return result
    }

    val info = RcloneSafBridge.getFileInfo(remote, path)
    val row = result.newRow()
    val isDir = info?.optBoolean("IsDir", false) ?: false
    val name = info?.optString("Name")?.ifEmpty { path.substringAfterLast('/') } ?: path.substringAfterLast('/')
    val size = info?.optLong("Size", 0L) ?: 0L
    val modTime = parseModTime(info?.optString("ModTime"))
    val mimeType = if (isDir) {
      DocumentsContract.Document.MIME_TYPE_DIR
    } else {
      val rawMime = info?.optString("MimeType", "") ?: ""
      if (rawMime.isNotEmpty()) rawMime else getMimeTypeFromPath(name)
    }

    val isReadOnly = isReadOnlyTarget(info)
    val flags = getDocumentFlags(isDir, mimeType, isReadOnly)

    row.add(DocumentsContract.Document.COLUMN_DOCUMENT_ID, documentId)
    row.add(DocumentsContract.Document.COLUMN_MIME_TYPE, mimeType)
    row.add(DocumentsContract.Document.COLUMN_DISPLAY_NAME, name)
    row.add(DocumentsContract.Document.COLUMN_LAST_MODIFIED, modTime)
    row.add(DocumentsContract.Document.COLUMN_FLAGS, flags)
    row.add(DocumentsContract.Document.COLUMN_SIZE, size)

    return result
  }

  override fun queryChildDocuments(
    parentDocumentId: String,
    projection: Array<out String>?,
    sortOrder: String?
  ): Cursor = withParcelableException {
    ensureInit()
    val authority = getAuthority()
    val result = MatrixCursor(projection ?: DEFAULT_DOCUMENT_PROJECTION)
    try {
      result.setNotificationUri(context?.contentResolver, DocumentsContract.buildChildDocumentsUri(authority, parentDocumentId))
    } catch (_: Exception) {}
    val (remote, path) = parseDocId(parentDocumentId)

    val list = RcloneSafBridge.listDirectory(remote, path)
    for (i in 0 until list.length()) {
      val item = list.optJSONObject(i) ?: continue
      val isDir = item.optBoolean("IsDir", false)
      val name = item.optString("Name", "")
      val itemPath = item.optString("Path", name)
      val size = item.optLong("Size", 0L)
      val modTime = parseModTime(item.optString("ModTime"))
      val docId = "$remote:/$itemPath"

      val rawMime = item.optString("MimeType", "")
      val mimeType = if (isDir) {
        DocumentsContract.Document.MIME_TYPE_DIR
      } else {
        if (rawMime.isNotEmpty()) rawMime else getMimeTypeFromPath(name)
      }

      val isReadOnly = isReadOnlyTarget(item)
      val flags = getDocumentFlags(isDir, mimeType, isReadOnly)

      val row = result.newRow()
      row.add(DocumentsContract.Document.COLUMN_DOCUMENT_ID, docId)
      row.add(DocumentsContract.Document.COLUMN_MIME_TYPE, mimeType)
      row.add(DocumentsContract.Document.COLUMN_DISPLAY_NAME, name)
      row.add(DocumentsContract.Document.COLUMN_LAST_MODIFIED, modTime)
      row.add(DocumentsContract.Document.COLUMN_FLAGS, flags)
      row.add(DocumentsContract.Document.COLUMN_SIZE, size)
    }

    return result
  }

  override fun isChildDocument(parentDocumentId: String, documentId: String): Boolean = withParcelableException {
    val (parentRemote, parentPath) = parseDocId(parentDocumentId)
    val (docRemote, docPath) = parseDocId(documentId)

    if (parentRemote != docRemote) return false
    val cleanParent = parentPath.trim('/')
    val cleanDoc = docPath.trim('/')

    if (cleanParent.isEmpty()) return true
    return cleanDoc.startsWith("$cleanParent/")
  }

  override fun copyDocument(sourceDocumentId: String, targetParentDocumentId: String): String = withParcelableException {
    ensureInit()
    val (srcRemote, srcPath) = parseDocId(sourceDocumentId)
    val (dstRemote, dstParentPath) = parseDocId(targetParentDocumentId)
    val fileName = srcPath.substringAfterLast('/')
    val dstPath = if (dstParentPath.isEmpty() || dstParentPath == "/") fileName else "${dstParentPath.trimEnd('/')}/$fileName"

    val info = RcloneSafBridge.getFileInfo(srcRemote, srcPath)
    val isDir = info?.optBoolean("IsDir", false) ?: srcPath.endsWith('/')

    val success = RcloneSafBridge.copyItem(srcRemote, srcPath, dstRemote, dstPath, isDir)
    if (!success) throw FileNotFoundException("Failed to copy document $sourceDocumentId to $targetParentDocumentId")

    val newDocId = "$dstRemote:/$dstPath"
    notifyParentChanged(targetParentDocumentId)
    return newDocId
  }

  override fun moveDocument(
    sourceDocumentId: String,
    sourceParentDocumentId: String,
    targetParentDocumentId: String
  ): String = withParcelableException {
    ensureInit()
    val (srcRemote, srcPath) = parseDocId(sourceDocumentId)
    val (dstRemote, dstParentPath) = parseDocId(targetParentDocumentId)
    val fileName = srcPath.substringAfterLast('/')
    val dstPath = if (dstParentPath.isEmpty() || dstParentPath == "/") fileName else "${dstParentPath.trimEnd('/')}/$fileName"

    val info = RcloneSafBridge.getFileInfo(srcRemote, srcPath)
    val isDir = info?.optBoolean("IsDir", false) ?: srcPath.endsWith('/')

    val success = RcloneSafBridge.moveItemAcrossRemotes(srcRemote, srcPath, dstRemote, dstPath, isDir)
    if (!success) throw FileNotFoundException("Failed to move document $sourceDocumentId to $targetParentDocumentId")

    val newDocId = "$dstRemote:/$dstPath"
    notifyParentChanged(sourceParentDocumentId)
    notifyParentChanged(targetParentDocumentId)
    return newDocId
  }

  override fun findDocumentPath(
    parentDocumentId: String?,
    childDocumentId: String
  ): DocumentsContract.Path? = withParcelableException {
    val (remote, path) = parseDocId(childDocumentId)
    val pathSegments = mutableListOf<String>()
    pathSegments.add("$remote:/")

    val parts = path.trim('/').split('/')
    var current = ""
    for (part in parts) {
      if (part.isEmpty()) continue
      current = if (current.isEmpty()) part else "$current/$part"
      pathSegments.add("$remote:/$current")
    }

    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      DocumentsContract.Path(remote, pathSegments)
    } else {
      null
    }
  }

  override fun querySearchDocuments(
    rootId: String,
    query: String,
    projection: Array<out String>?
  ): Cursor = withParcelableException {
    ensureInit()
    val authority = getAuthority()
    val result = MatrixCursor(projection ?: DEFAULT_DOCUMENT_PROJECTION)
    try {
      result.setNotificationUri(context?.contentResolver, DocumentsContract.buildSearchDocumentsUri(authority, rootId, query))
    } catch (_: Exception) {}
    val items = RcloneSafBridge.searchFiles(rootId, query)

    for (i in 0 until items.length()) {
      val item = items.optJSONObject(i) ?: continue
      val isDir = item.optBoolean("IsDir", false)
      val name = item.optString("Name", "")
      val itemPath = item.optString("Path", name)
      val size = item.optLong("Size", 0L)
      val modTime = parseModTime(item.optString("ModTime"))
      val docId = "$rootId:/$itemPath"

      val rawMime = item.optString("MimeType", "")
      val mimeType = if (isDir) {
        DocumentsContract.Document.MIME_TYPE_DIR
      } else {
        if (rawMime.isNotEmpty()) rawMime else getMimeTypeFromPath(name)
      }

      val isReadOnly = isReadOnlyTarget(item)
      val flags = getDocumentFlags(isDir, mimeType, isReadOnly)

      val row = result.newRow()
      row.add(DocumentsContract.Document.COLUMN_DOCUMENT_ID, docId)
      row.add(DocumentsContract.Document.COLUMN_MIME_TYPE, mimeType)
      row.add(DocumentsContract.Document.COLUMN_DISPLAY_NAME, name)
      row.add(DocumentsContract.Document.COLUMN_LAST_MODIFIED, modTime)
      row.add(DocumentsContract.Document.COLUMN_FLAGS, flags)
      row.add(DocumentsContract.Document.COLUMN_SIZE, size)
    }

    return result
  }

  override fun createDocument(
    parentDocumentId: String,
    mimeType: String,
    displayName: String
  ): String = withParcelableException {
    ensureInit()
    val (remote, parentPath) = parseDocId(parentDocumentId)
    val childPath = if (parentPath.isEmpty() || parentPath == "/") {
      displayName
    } else {
      "${parentPath.trimEnd('/')}/$displayName"
    }

    if (mimeType == DocumentsContract.Document.MIME_TYPE_DIR) {
      val success = RcloneSafBridge.createDirectory(remote, childPath)
      if (!success) throw FileNotFoundException("Failed to create dir $childPath")
    } else {
      val openRes = RcloneSafBridge.openVfsFile(remote, childPath, "w")
        ?: throw FileNotFoundException("Failed to create file $childPath")
      val handleId = openRes.optLong("handle_id", -1L)
      if (handleId != -1L) {
        RcloneSafBridge.closeVfsFile(handleId)
      }
    }

    val newDocId = "$remote:/$childPath"
    notifyParentChanged(parentDocumentId)
    return newDocId
  }

  override fun deleteDocument(documentId: String): Unit = withParcelableException {
    ensureInit()
    val (remote, path) = parseDocId(documentId)
    val info = RcloneSafBridge.getFileInfo(remote, path)
    if (info == null && path.isNotEmpty()) {
      // File/folder is already deleted or not found. Treat as success.
      val parentPath = path.substringBeforeLast('/', "")
      val parentDocId = if (parentPath.isEmpty()) "$remote:/" else "$remote:/$parentPath"
      notifyParentChanged(parentDocId)
      return@withParcelableException
    }

    val isDir = info?.optBoolean("IsDir", false) ?: path.endsWith('/')

    val success = RcloneSafBridge.deleteItem(remote, path, isDir)
    if (!success) {
      val checkAgain = RcloneSafBridge.getFileInfo(remote, path)
      if (checkAgain != null) {
        throw FileNotFoundException("Failed to delete $documentId")
      }
    }

    val parentPath = path.substringBeforeLast('/', "")
    val parentDocId = if (parentPath.isEmpty()) "$remote:/" else "$remote:/$parentPath"
    notifyParentChanged(parentDocId)
  }

  override fun removeDocument(documentId: String, parentDocumentId: String): Unit = withParcelableException {
    deleteDocument(documentId)
    try {
      val authority = getAuthority()
      val documentUri = DocumentsContract.buildDocumentUri(authority, documentId)
      context?.revokeUriPermission(
        documentUri,
        android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION
      )
    } catch (e: Exception) {
      // Ignore permission revocation errors
    }
  }

  override fun renameDocument(documentId: String, displayName: String): String = withParcelableException {
    ensureInit()
    val (remote, path) = parseDocId(documentId)
    val parentPath = path.substringBeforeLast('/', "")
    val newPath = if (parentPath.isEmpty()) displayName else "$parentPath/$displayName"

    val info = RcloneSafBridge.getFileInfo(remote, path)
    val isDir = info?.optBoolean("IsDir", false) ?: path.endsWith('/')

    val success = RcloneSafBridge.renameItem(remote, path, newPath, isDir)
    if (!success) throw FileNotFoundException("Failed to rename $documentId")

    val newDocId = "$remote:/$newPath"
    val parentDocId = if (parentPath.isEmpty()) "$remote:/" else "$remote:/$parentPath"
    notifyParentChanged(parentDocId)
    return newDocId
  }

  override fun openDocument(
    documentId: String,
    mode: String,
    signal: CancellationSignal?
  ): ParcelFileDescriptor = withParcelableException {
    signal?.throwIfCanceled()
    ensureInit()
    val (remote, path) = parseDocId(documentId)
    val isWrite = mode.contains("w") || mode.contains("W") || mode.contains("a") || mode.contains("A")
    val modeStr = if (isWrite) "rw" else "r"

    val handleInfo = RcloneSafBridge.openVfsFile(remote, path, modeStr)
      ?: throw FileNotFoundException("Could not open document $documentId")

    val handleId = handleInfo.optLong("handle_id", -1L)
    val fileSize = handleInfo.optLong("size", 0L)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val storageManager = context?.getSystemService(StorageManager::class.java)
      if (storageManager != null) {
        val ioThread = HandlerThread("RcloneProxyFdThread-$handleId").apply { start() }
        val handler = Handler(ioThread.looper)
        val pfdMode = ParcelFileDescriptor.parseMode(mode)
        val callback = object : ProxyFileDescriptorCallback() {
          override fun onGetSize(): Long {
            signal?.throwIfCanceled()
            return fileSize
          }

          override fun onRead(offset: Long, size: Int, data: ByteArray): Int {
            signal?.throwIfCanceled()
            return RcloneSafBridge.readVfsFile(handleId, offset, size, data)
          }

          override fun onWrite(offset: Long, size: Int, data: ByteArray): Int {
            signal?.throwIfCanceled()
            return RcloneSafBridge.writeVfsFile(handleId, offset, data, size)
          }

          override fun onFsync() {
            // Handled automatically on close
          }

          override fun onRelease() {
            Thread {
              try {
                RcloneSafBridge.closeVfsFile(handleId)
              } finally {
                ioThread.quit()
              }
            }.start()
          }
        }

        signal?.setOnCancelListener {
          Thread {
            try {
              RcloneSafBridge.closeVfsFile(handleId)
            } finally {
              ioThread.quit()
            }
          }.start()
        }

        try {
          return storageManager.openProxyFileDescriptor(pfdMode, callback, handler)
        } catch (e: Exception) {
          RcloneSafBridge.closeVfsFile(handleId)
          ioThread.quit()
          throw FileNotFoundException("Failed to open proxy file descriptor for $documentId: ${e.message}")
        }
      }
    }

    RcloneSafBridge.closeVfsFile(handleId)
    throw FileNotFoundException("Unsupported Android API version for SAF streaming proxy")
  }

  override fun openDocumentThumbnail(
    documentId: String,
    sizeHint: Point?,
    signal: CancellationSignal?
  ): AssetFileDescriptor? = withParcelableException {
    signal?.throwIfCanceled()
    val (remote, path) = parseDocId(documentId)
    val info = RcloneSafBridge.getFileInfo(remote, path)
    val name = info?.optString("Name")?.ifEmpty { path.substringAfterLast('/') } ?: path.substringAfterLast('/')
    val mimeType = info?.optString("MimeType")?.ifEmpty { getMimeTypeFromPath(name) } ?: getMimeTypeFromPath(name)

    if (!isThumbnailSupported(mimeType)) {
      return null
    }

    return try {
      val pfd = openDocument(documentId, "r", signal)
      AssetFileDescriptor(pfd, 0, AssetFileDescriptor.UNKNOWN_LENGTH)
    } catch (e: Exception) {
      null
    }
  }

  private fun isThumbnailSupported(mimeType: String): Boolean {
    return mimeType.startsWith("image/") ||
      mimeType.startsWith("video/") ||
      mimeType.startsWith("audio/") ||
      mimeType == "application/pdf"
  }

  private fun notifyParentChanged(parentDocumentId: String) {
    try {
      val ctx = context ?: return
      val parentUri = DocumentsContract.buildChildDocumentsUri(getAuthority(), parentDocumentId)
      ctx.contentResolver.notifyChange(parentUri, null)
    } catch (e: Exception) {
      // Ignore notification errors
    }
  }

  private fun parseDocId(documentId: String): Pair<String, String> {
    val parts = documentId.split(":/", limit = 2)
    val remote = parts.getOrNull(0) ?: ""
    val path = parts.getOrNull(1) ?: ""
    return Pair(remote, path)
  }

  private fun getMimeTypeFromPath(name: String): String {
    val ext = name.substringAfterLast('.', "").lowercase()
    if (ext.isEmpty()) return "application/octet-stream"
    return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
  }
}
