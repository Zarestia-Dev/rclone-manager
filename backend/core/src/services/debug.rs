//! Debug commands for troubleshooting and developer tools
//!
//! These commands are available via both desktop and headless modes.

use crate::context::AppHandle;
use serde::Serialize;

use crate::services::paths::AppPaths;

/// Debug information response
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugInfo {
    pub logs_dir: String,
    pub config_dir: String,
    pub cache_dir: String,
    pub mode: String,
    pub app_version: String,
    pub platform: String,
    pub arch: String,
}

/// Get debug information (paths, versions, build info)
pub fn get_debug_info(app: AppHandle) -> Result<DebugInfo, String> {
    // Get paths from centralized AppPaths
    let paths = AppPaths::from_app_handle(&app)?;

    let app_version = env!("CARGO_PKG_VERSION").to_string();

    Ok(DebugInfo {
        logs_dir: paths.logs_dir.to_string_lossy().to_string(),
        config_dir: paths.config_dir.to_string_lossy().to_string(),
        cache_dir: paths.cache_dir.to_string_lossy().to_string(),
        mode: app.product().mode.to_string(),
        app_version,
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    })
}
