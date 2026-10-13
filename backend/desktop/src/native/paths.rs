use crate::context::BackendContext;
use crate::{context::AppHandle, services::paths::AppPaths};
use std::path::PathBuf;
use tauri::Manager;

pub(crate) fn resolve_paths(app: &AppHandle) -> Result<AppPaths, String> {
    let cli_args = app.backend_state::<crate::services::cli::GeneralArgs>();

    // Get cache directory (CLI > ENV > DEFAULT)
    let cache_dir = if let Some(cli_path) = &cli_args.cache_dir {
        cli_path.clone()
    } else if let ok_path @ Some(_) =
        std::env::var_os("RCLONE_MANAGER_CACHE_DIR").map(PathBuf::from)
    {
        ok_path.unwrap()
    } else {
        app.path()
            .app_cache_dir()
            .map_err(|e| format!("Failed to get cache directory: {e}"))?
    };

    // Get config directory (CLI > ENV > DEFAULT)
    let config_dir = if let Some(cli_path) = &cli_args.data_dir {
        cli_path.clone()
    } else if let ok_path @ Some(_) = std::env::var_os("RCLONE_MANAGER_DATA_DIR").map(PathBuf::from)
    {
        ok_path.unwrap()
    } else {
        app.path()
            .app_data_dir()
            .map_err(|e| format!("Failed to get config directory: {e}"))?
    };

    // Get logs directory (CLI > ENV > DEFAULT_NATIVE)
    let logs_dir = if let Some(cli_path) = &cli_args.logs_dir {
        cli_path.clone()
    } else if let ok_path @ Some(_) = std::env::var_os("RCLONE_MANAGER_LOG_DIR").map(PathBuf::from)
    {
        ok_path.unwrap()
    } else {
        // macOS has a dedicated ~/Library/Logs directory.
        // Linux/Windows often bundle logs in data or cache; we prefer cache/logs
        // to keep the configuration directory clean (as per user request).
        #[cfg(target_os = "macos")]
        let res = app.path().app_log_dir();
        #[cfg(not(target_os = "macos"))]
        let res = app.path().app_cache_dir().map(|p| p.join("logs"));

        res.unwrap_or_else(|_| cache_dir.join("logs"))
    };

    // Resource directory (fallback to cache/resources for mobile)
    let resource_dir = tauri::Manager::path(app)
        .resource_dir()
        .ok()
        .filter(|p| p.exists())
        .unwrap_or_else(|| cache_dir.join("resources"));

    Ok(AppPaths {
        config_dir,
        cache_dir,
        logs_dir,
        resource_dir,
    })
}
