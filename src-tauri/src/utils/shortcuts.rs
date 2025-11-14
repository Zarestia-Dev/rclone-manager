use log::{debug, error};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

use crate::{RcloneState, core::lifecycle::shutdown::handle_shutdown};

/// Handle global shortcut events
pub fn handle_global_shortcut_event(app: &AppHandle, shortcut: Shortcut) {
    match (shortcut.mods, shortcut.key) {
        // Ctrl+Q - Quit application
        (mods, Code::KeyQ)
            if mods.contains(Modifiers::CONTROL) && !mods.contains(Modifiers::SHIFT) =>
        {
            debug!("Global shortcut triggered: Quit application");
            let app_clone = app.clone();
            tauri::async_runtime::spawn(async move {
                app_clone.state::<RcloneState>().set_shutting_down();
                handle_shutdown(app_clone).await;
            });
        }

        // // Ctrl+Shift+M - Force check mounted remotes
        // (mods, Code::KeyM)
        //     if mods.contains(Modifiers::CONTROL) && mods.contains(Modifiers::SHIFT) =>
        // {
        //     debug!("Global shortcut triggered: Force check mounted remotes");

        //     // Notify UI about the action only if refresh is successful
        //     let app_clone = app.clone();
        //     tauri::async_runtime::spawn(async move {
        //         match CACHE.refresh_mounted_remotes(app_clone.clone()).await {
        //             Ok(_) => {
        //                 if let Err(e) = app_clone.emit("notify_ui", "Refreshed mounted remotes") {
        //                     error!("Failed to emit notify_ui event: {e}");
        //                 }
        //                 if let Err(e) = app_clone.emit("mount_state_changed", ()) {
        //                     error!("Failed to emit mount_state_changed event: {e}");
        //                 }
        //             }
        //             Err(e) => {
        //                 error!("Failed to refresh mounted remotes: {e}");
        //             }
        //         }
        //     });
        // }
        _ => {
            debug!(
                "Unhandled global shortcut: {:?} + {:?}",
                shortcut.mods, shortcut.key
            );
        }
    }
}

/// Unregister all global shortcuts during shutdown
pub fn unregister_global_shortcuts(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    debug!("Unregistering global shortcuts");

    // Create shortcuts to unregister
    let quit_shortcut = Shortcut::new(Some(Modifiers::CONTROL), Code::KeyQ);
    let force_check_shortcut =
        Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyM);

    // Unregister them
    if let Err(e) = app.global_shortcut().unregister(quit_shortcut) {
        error!("Failed to unregister Ctrl+Q shortcut: {e}");
    }
    if let Err(e) = app.global_shortcut().unregister(force_check_shortcut) {
        error!("Failed to unregister Ctrl+Shift+M shortcut: {e}");
    }
    debug!("Global shortcuts cleanup completed");
    Ok(())
}
