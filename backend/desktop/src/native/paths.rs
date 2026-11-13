use crate::context::BackendContext;
use crate::{context::AppHandle, services::paths::AppPaths};
use std::path::PathBuf;
use tauri::Manager;

/// A directory chosen explicitly: the CLI argument wins over the environment variable.
fn explicit_dir(cli: Option<&PathBuf>, env_var: &str) -> Option<PathBuf> {
    cli.cloned().or_else(|| {
        std::env::var_os(env_var)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    })
}

pub(crate) fn resolve_paths(app: &AppHandle) -> Result<AppPaths, String> {
    let cli_args = app.backend_state::<crate::services::cli::GeneralArgs>();

    let cache_dir = match explicit_dir(cli_args.cache_dir.as_ref(), "RCLONE_MANAGER_CACHE_DIR") {
        Some(dir) => dir,
        None => app
            .path()
            .app_cache_dir()
            .map_err(|e| format!("Failed to get cache directory: {e}"))?,
    };

    let config_dir = match explicit_dir(cli_args.data_dir.as_ref(), "RCLONE_MANAGER_DATA_DIR") {
        Some(dir) => dir,
        None => app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to get config directory: {e}"))?,
    };

    // macOS has a dedicated ~/Library/Logs directory. Elsewhere logs live in cache/logs
    // to keep the configuration directory clean.
    let logs_dir = explicit_dir(cli_args.logs_dir.as_ref(), "RCLONE_MANAGER_LOG_DIR")
        .unwrap_or_else(|| {
            #[cfg(target_os = "macos")]
            let default = app.path().app_log_dir();
            #[cfg(not(target_os = "macos"))]
            let default = app.path().app_cache_dir().map(|p| p.join("logs"));
            default.unwrap_or_else(|_| cache_dir.join("logs"))
        });

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
