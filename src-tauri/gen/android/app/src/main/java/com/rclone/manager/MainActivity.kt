package com.rclone.manager

import android.os.Bundle
import android.os.Build
import android.os.Environment
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.enableEdgeToEdge
import java.io.File
import java.io.FileOutputStream

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    
    // Request storage permissions
    requestStoragePermission()
    
    // Copy bundled assets to cache directory so Rust std::fs can access them
    val destDir = File(cacheDir, "resources")
    copyAssetsDir("i18n", destDir)
    copyAssetFile("serve-template.html", File(destDir, "serve-template.html"))
    copyAssetFile("oauth-template.html", File(destDir, "oauth-template.html"))
    
    super.onCreate(savedInstanceState)
  }

  private fun requestStoragePermission() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      if (!Environment.isExternalStorageManager()) {
        try {
          val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION)
          intent.data = Uri.parse("package:" + packageName)
          startActivity(intent)
        } catch (e: Exception) {
          try {
            val intent = Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
            startActivity(intent)
          } catch (ex: Exception) {
            ex.printStackTrace()
          }
        }
      }
    } else {
      val permissions = arrayOf(
        android.Manifest.permission.READ_EXTERNAL_STORAGE,
        android.Manifest.permission.WRITE_EXTERNAL_STORAGE
      )
      requestPermissions(permissions, 100)
    }
  }

  private fun copyAssetsDir(assetDirPath: String, destDir: File) {
    try {
      val assetsList = assets.list(assetDirPath) ?: return
      if (assetsList.isEmpty()) {
        // It's a file
        copyAssetFile(assetDirPath, File(destDir, assetDirPath))
      } else {
        // It's a directory
        val dir = File(destDir, assetDirPath)
        if (!dir.exists()) {
          dir.mkdirs()
        }
        for (asset in assetsList) {
          val subAssetPath = if (assetDirPath.isEmpty()) asset else "$assetDirPath/$asset"
          copyAssetsDir(subAssetPath, destDir)
        }
      }
    } catch (e: Exception) {
      e.printStackTrace()
    }
  }

  private fun copyAssetFile(assetPath: String, destFile: File) {
    try {
      assets.open(assetPath).use { input ->
        destFile.parentFile?.mkdirs()
        FileOutputStream(destFile).use { output ->
          input.copyTo(output)
        }
      }
    } catch (e: Exception) {
      e.printStackTrace()
    }
  }
}
