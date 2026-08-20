#![cfg(not(feature = "web-server"))]
use std::sync::atomic::{AtomicBool, Ordering};

use crate::core::bridge;

static SYSTEM_THEME_IS_DARK: AtomicBool = AtomicBool::new(true);

/// Set the application theme
#[bridge]
pub async fn set_theme(
    system_is_dark: Option<bool>,
    #[allow(unused_variables)] window: tauri::Window,
) -> Result<(), String> {
    if let Some(is_dark) = system_is_dark {
        SYSTEM_THEME_IS_DARK.store(is_dark, Ordering::Relaxed);
    }

    #[cfg(feature = "tray")]
    {
        use tauri::Manager;
        let app = window.app_handle().clone();
        tauri::async_runtime::spawn(async move {
            let _ = crate::core::tray::core::update_tray_menu(app).await;
        });
    }

    Ok(())
}

#[must_use]
pub fn is_system_dark() -> bool {
    SYSTEM_THEME_IS_DARK.load(Ordering::Relaxed)
}
