use crate::services::paths::AppPaths;
use rclone_manager_core::context::AppHandle;
use std::path::PathBuf;

pub(crate) fn resolve_paths(app: &AppHandle) -> Result<AppPaths, String> {
    let args = app.state::<crate::services::cli::GeneralArgs>();
    let config_dir = args
        .data_dir
        .clone()
        .or_else(|| std::env::var_os("RCLONE_MANAGER_DATA_DIR").map(PathBuf::from))
        .or_else(|| dirs::data_dir().map(|base| base.join("com.rclone.manager.headless")))
        .ok_or("Cannot resolve application data directory; specify --data-dir")?;
    let cache_dir = args
        .cache_dir
        .clone()
        .or_else(|| std::env::var_os("RCLONE_MANAGER_CACHE_DIR").map(PathBuf::from))
        .or_else(|| dirs::cache_dir().map(|base| base.join("com.rclone.manager.headless")))
        .ok_or("Cannot resolve application cache directory; specify --cache-dir")?;
    let logs_dir = args
        .logs_dir
        .clone()
        .or_else(|| std::env::var_os("RCLONE_MANAGER_LOG_DIR").map(PathBuf::from))
        .unwrap_or_else(|| cache_dir.join("logs"));
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let exe_dir = executable
        .parent()
        .ok_or("Executable has no parent directory")?;
    Ok(AppPaths {
        config_dir,
        cache_dir,
        logs_dir,
        resource_dir: exe_dir.to_path_buf(),
    })
}
