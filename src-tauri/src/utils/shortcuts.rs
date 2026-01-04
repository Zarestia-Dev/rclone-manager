#![cfg(all(desktop, not(feature = "web-server")))]

use log::{debug, error};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

use crate::{core::lifecycle::shutdown::handle_shutdown, utils::types::core::RcloneState};

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

    let quit_shortcut = Shortcut::new(Some(Modifiers::CONTROL), Code::KeyQ);

    if let Err(e) = app.global_shortcut().unregister(quit_shortcut) {
        error!("Failed to unregister Ctrl+Q shortcut: {e}");
    }

    debug!("Global shortcuts cleanup completed");
    Ok(())
}
