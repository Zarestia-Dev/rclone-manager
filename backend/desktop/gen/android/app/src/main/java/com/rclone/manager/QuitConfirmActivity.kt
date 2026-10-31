package com.rclone.manager

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.dialog.MaterialAlertDialogBuilder

/** Asks before the notification's quit action ends the app; it shows only the dialog. */
class QuitConfirmActivity : AppCompatActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    MaterialAlertDialogBuilder(this)
      .setTitle(R.string.quit_confirm_title)
      .setMessage(R.string.quit_confirm_message)
      .setPositiveButton(R.string.action_quit) { _, _ -> RcloneSafBridge.quitApp() }
      .setNegativeButton(R.string.action_cancel, null)
      .setOnDismissListener { finish() }
      .show()
  }
}
