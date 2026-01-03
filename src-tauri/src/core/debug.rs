//! Debug commands for troubleshooting and developer tools
//!
//! These commands are available via Tauri's invoke system for desktop mode.

use serde::Serialize;
use tauri::AppHandle;

use crate::core::paths::get_app_paths;

/// Debug information response
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugInfo {
    pub logs_dir: String,
    pub config_dir: String,
    pub cache_dir: String,
    pub build_type: Option<String>,
    pub is_debug: bool,
    pub app_version: String,
    pub platform: String,
    pub arch: String,
}

/// Get debug information (paths, versions, build info)
#[tauri::command]
pub fn get_debug_info(app: AppHandle) -> Result<DebugInfo, String> {
    // Get paths from centralized AppPaths
    let paths = get_app_paths(&app)?;

    // Get build info
    let build_type = crate::utils::app::platform::get_build_type().map(|s| s.to_string());
    let is_debug = cfg!(debug_assertions);
    let app_version = app.package_info().version.to_string();

    Ok(DebugInfo {
        logs_dir: paths.logs_dir.to_string_lossy().to_string(),
        config_dir: paths.config_dir.to_string_lossy().to_string(),
        cache_dir: paths.cache_dir.to_string_lossy().to_string(),
        build_type,
        is_debug,
        app_version,
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    })
}

/// Open WebView developer tools
#[tauri::command]
#[cfg(not(feature = "web-server"))]
pub fn open_devtools(app: AppHandle) -> Result<String, String> {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        window.open_devtools();
        log::debug!("🔧 Opened DevTools");
        Ok("DevTools opened".to_string())
    } else {
        Err("Main window not found".to_string())
    }
}
