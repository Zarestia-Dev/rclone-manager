package com.rclone.manager

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.annotation.Keep
import androidx.core.content.FileProvider
import java.io.File
import java.security.MessageDigest

internal data class UpdatePackageIdentity(
  val packageName: String,
  val versionCode: Long,
  val signers: Set<String>
)

internal fun validUpdatePackage(installed: UpdatePackageIdentity, candidate: UpdatePackageIdentity): Boolean =
  installed.packageName == candidate.packageName &&
    candidate.versionCode > installed.versionCode &&
    installed.signers.isNotEmpty() && installed.signers == candidate.signers

@Keep
object RcloneAppUpdater {
  /** Called only after Rust verifies the publisher's artifact signature. */
  @Suppress("DEPRECATION")
  fun install(context: Context, path: String): Int {
    return try {
      val file = File(path).canonicalFile
      val cache = context.cacheDir.canonicalFile
      if (!file.toPath().startsWith(cache.toPath()) || file.extension != "apk" || !file.isFile) return -1
      val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
      val candidate = context.packageManager.getPackageArchiveInfo(file.path, flags) ?: return -1
      val installed = context.packageManager.getPackageInfo(context.packageName, flags)
      if (!validUpdatePackage(identity(installed), identity(candidate))) return -1
      if (Build.VERSION.SDK_INT >= 26 && !context.packageManager.canRequestPackageInstalls()) {
        context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")).apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        })
        return 1
      }
      val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
      context.startActivity(Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      })
      0
    } catch (error: Exception) {
      Logger.error("APK update could not be opened: ${error.message}")
      -1
    }
  }

  @Suppress("DEPRECATION")
  private fun identity(info: PackageInfo): UpdatePackageIdentity {
    val certificates = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
    val signers = certificates.orEmpty().map { signature ->
      MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).joinToString("") { "%02x".format(it) }
    }.toSet()
    val version = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
    return UpdatePackageIdentity(info.packageName, version, signers)
  }
}
