use crate::services::paths::AppPaths;
use rclone_manager_core::context::AppHandle;

/// `GeneralArgs` already folds in the `RCLONE_MANAGER_*_DIR` environment variables.
pub(crate) fn resolve_paths(app: &AppHandle) -> Result<AppPaths, String> {
    let args = app.state::<crate::services::cli::GeneralArgs>();
    let config_dir = args
        .data_dir
        .clone()
        .or_else(|| dirs::data_dir().map(|base| base.join("com.rclone.manager.headless")))
        .ok_or("Cannot resolve application data directory; specify --data-dir")?;
    let cache_dir = args
        .cache_dir
        .clone()
        .or_else(|| dirs::cache_dir().map(|base| base.join("com.rclone.manager.headless")))
        .ok_or("Cannot resolve application cache directory; specify --cache-dir")?;
    let logs_dir = args
        .logs_dir
        .clone()
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
