use crate::{context::AppHandle, services::paths::AppPaths};
use log::info;
use std::path::PathBuf;

/// Get the directory containing the executable (for portable mode)
fn get_executable_directory() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|e| format!("Failed to get executable path: {e}"))?
        .parent()
        .map(std::path::Path::to_path_buf)
        .ok_or_else(|| "Failed to get executable directory".to_string())
}

pub(crate) fn resolve_paths(_app: &AppHandle) -> Result<AppPaths, String> {
    let exe_dir = get_executable_directory()?;

    let config_dir = exe_dir.join("config");
    let cache_dir = exe_dir.join("cache");
    let logs_dir = cache_dir.join("logs");

    info!("Running in PORTABLE mode");
    info!("Config directory: {}", config_dir.display());
    info!("Cache directory: {}", cache_dir.display());

    Ok(AppPaths {
        config_dir,
        cache_dir,
        logs_dir,
        resource_dir: exe_dir,
    })
}
