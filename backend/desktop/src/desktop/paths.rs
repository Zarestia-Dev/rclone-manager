use crate::{context::AppHandle, services::paths::AppPaths};
use log::info;
use rclone_manager_core::utils::app::paths::installation_directory;
use std::path::Path;

fn paths_for_executable(executable: &Path) -> Result<AppPaths, String> {
    let directory = installation_directory(executable).map_err(|error| error.to_string())?;
    let cache_dir = directory.join("cache");
    Ok(AppPaths {
        config_dir: directory.join("config"),
        logs_dir: cache_dir.join("logs"),
        cache_dir,
        resource_dir: directory.to_path_buf(),
    })
}

pub(crate) fn resolve_paths(_app: &AppHandle) -> Result<AppPaths, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("Failed to get executable path: {error}"))?;
    let paths = paths_for_executable(&executable)?;
    info!("Running in PORTABLE mode");
    info!("Config directory: {}", paths.config_dir.display());
    info!("Cache directory: {}", paths.cache_dir.display());
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_bundle_data_lives_beside_the_bundle_and_survives_replacement() {
        for executable in [
            "/portable/RCloneManager",
            "/portable/RCloneManager.exe",
            "/portable/RClone Manager.app/Contents/MacOS/rclone-manager",
        ] {
            let paths = paths_for_executable(Path::new(executable)).unwrap();
            assert_eq!(paths.config_dir, Path::new("/portable/config"));
            assert_eq!(paths.cache_dir, Path::new("/portable/cache"));
            assert_eq!(paths.logs_dir, Path::new("/portable/cache/logs"));
            assert_eq!(paths.resource_dir, Path::new("/portable"));
        }
        assert!(paths_for_executable(Path::new("/")).is_err());
    }
}
