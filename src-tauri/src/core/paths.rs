//! Centralized application paths - single source of truth
//!
//! This module provides a unified way to access application directories
//! (config, cache, logs) across the entire codebase. Supports both
//! standard and portable mode.

use crate::utils::context::AppHandle;
#[cfg(feature = "portable")]
use log::info;
use serde::Serialize;
use std::path::PathBuf;

// Portable Mode Helpers

/// Get the directory containing the executable (for portable mode)
#[cfg(feature = "portable")]
fn get_executable_directory() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|e| format!("Failed to get executable path: {e}"))?
        .parent()
        .map(std::path::Path::to_path_buf)
        .ok_or_else(|| "Failed to get executable directory".to_string())
}

// AppPaths Struct

/// Centralized application paths
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
    /// Configuration directory (settings, remotes, etc.)
    pub config_dir: PathBuf,
    /// Cache directory (temporary files, thumbnails, etc.)
    pub cache_dir: PathBuf,
    /// Logs directory (application logs)
    pub logs_dir: PathBuf,
    /// Resource directory (i18n, assets)
    pub resource_dir: PathBuf,
}

impl AppPaths {
    /// Create `AppPaths` for portable mode
    ///
    /// Uses directories next to the executable.
    #[cfg(feature = "portable")]
    pub fn from_app_handle(_app: &AppHandle) -> Result<Self, String> {
        let exe_dir = get_executable_directory()?;

        let config_dir = exe_dir.join("config");
        let cache_dir = exe_dir.join("cache");
        let logs_dir = cache_dir.join("logs");

        info!("Running in PORTABLE mode");
        info!("Config directory: {}", config_dir.display());
        info!("Cache directory: {}", cache_dir.display());

        Ok(Self {
            config_dir,
            cache_dir,
            logs_dir,
            resource_dir: exe_dir,
        })
    }

    /// Create `AppPaths` for standard mode
    ///
    /// Uses system directories via Tauri's path resolver.
    #[cfg(all(not(feature = "portable"), feature = "native-tauri"))]
    pub fn from_app_handle(app: &AppHandle) -> Result<Self, String> {
        use crate::utils::context::Manager;
        let cli_args = app.state::<crate::core::cli::CliArgs>();

        // Get cache directory (CLI > ENV > DEFAULT)
        let cache_dir = if let Some(cli_path) = &cli_args.general.cache_dir {
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
        let config_dir = if let Some(cli_path) = &cli_args.general.data_dir {
            cli_path.clone()
        } else if let ok_path @ Some(_) =
            std::env::var_os("RCLONE_MANAGER_DATA_DIR").map(PathBuf::from)
        {
            ok_path.unwrap()
        } else {
            app.path()
                .app_data_dir()
                .map_err(|e| format!("Failed to get config directory: {e}"))?
        };

        // Get logs directory (CLI > ENV > DEFAULT_NATIVE)
        let logs_dir = if let Some(cli_path) = &cli_args.general.logs_dir {
            cli_path.clone()
        } else if let ok_path @ Some(_) =
            std::env::var_os("RCLONE_MANAGER_LOG_DIR").map(PathBuf::from)
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

        Ok(Self {
            config_dir,
            cache_dir,
            logs_dir,
            resource_dir,
        })
    }

    #[cfg(not(feature = "native-tauri"))]
    pub fn from_app_handle(app: &AppHandle) -> Result<Self, String> {
        use crate::utils::context::Manager;
        let args = app.state::<crate::core::cli::CliArgs>();
        let config_dir = args
            .general
            .data_dir
            .clone()
            .or_else(|| std::env::var_os("RCLONE_MANAGER_DATA_DIR").map(PathBuf::from))
            .or_else(|| dirs::data_dir().map(|base| base.join("com.rclone.manager.headless")))
            .ok_or("Cannot resolve application data directory; specify --data-dir")?;
        let cache_dir = args
            .general
            .cache_dir
            .clone()
            .or_else(|| std::env::var_os("RCLONE_MANAGER_CACHE_DIR").map(PathBuf::from))
            .or_else(|| dirs::cache_dir().map(|base| base.join("com.rclone.manager.headless")))
            .ok_or("Cannot resolve application cache directory; specify --cache-dir")?;
        let logs_dir = args
            .general
            .logs_dir
            .clone()
            .or_else(|| std::env::var_os("RCLONE_MANAGER_LOG_DIR").map(PathBuf::from))
            .unwrap_or_else(|| cache_dir.join("logs"));
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let exe_dir = executable
            .parent()
            .ok_or("Executable has no parent directory")?;
        let resource_dir = [
            exe_dir.to_path_buf(),
            exe_dir.join("../Resources"),
            PathBuf::from("/usr/lib/RClone Manager Headless"),
            PathBuf::from("/usr/lib/rclone-manager-headless"),
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources"),
        ]
        .into_iter()
        .find(|path| path.join("i18n").is_dir())
        .unwrap_or_else(|| exe_dir.to_path_buf());
        Ok(Self {
            config_dir,
            cache_dir,
            logs_dir,
            resource_dir,
        })
    }

    /// Setup application paths and ensure directories exist
    ///
    /// This is the main entry point for initializing paths during app startup.
    /// Returns the config directory path for backwards compatibility.
    /// Setup application paths and ensure directories exist
    ///
    /// This is the main entry point for initializing paths during app startup.
    /// Returns the complete `AppPaths` struct.
    pub fn setup(app: &AppHandle) -> Result<Self, String> {
        let paths = Self::from_app_handle(app)?;
        paths.ensure_dirs()?;
        Ok(paths)
    }

    /// Ensure all directories exist
    pub fn ensure_dirs(&self) -> Result<(), String> {
        std::fs::create_dir_all(&self.config_dir)
            .map_err(|e| format!("Failed to create config directory: {e}"))?;
        std::fs::create_dir_all(&self.cache_dir)
            .map_err(|e| format!("Failed to create cache directory: {e}"))?;
        std::fs::create_dir_all(&self.logs_dir)
            .map_err(|e| format!("Failed to create logs directory: {e}"))?;
        // Create log subdirectories
        std::fs::create_dir_all(self.get_app_log_dir())
            .map_err(|e| format!("Failed to create app log directory: {e}"))?;
        std::fs::create_dir_all(self.get_rclone_log_dir())
            .map_err(|e| format!("Failed to create rclone log directory: {e}"))?;
        Ok(())
    }

    /// Get the rclone-manager log directory path
    pub fn get_app_log_dir(&self) -> PathBuf {
        self.logs_dir.join("rclone-manager")
    }

    /// Get the rclone process log directory path
    pub fn get_rclone_log_dir(&self) -> PathBuf {
        self.logs_dir.join("rclone")
    }

    /// Get the path to the bundled serve template
    pub fn serve_template_path(&self) -> PathBuf {
        self.resource_dir.join("serve-template.html")
    }

    /// Get the path to the bundled OAuth template
    pub fn oauth_template_path(&self) -> PathBuf {
        self.resource_dir.join("oauth-template.html")
    }
}

#[cfg(all(test, not(feature = "native-tauri")))]
mod tests {
    use super::*;
    use crate::{core::cli::CliArgs, utils::context::Manager};
    use clap::Parser;

    #[test]
    fn headless_paths_respect_cli_overrides_and_create_directories() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data with spaces");
        let cache = temp.path().join("cache");
        let logs = temp.path().join("logs");
        let args = CliArgs::try_parse_from([
            "server",
            "--data-dir",
            data.to_str().unwrap(),
            "--cache-dir",
            cache.to_str().unwrap(),
            "--logs-dir",
            logs.to_str().unwrap(),
        ])
        .unwrap();
        let app = AppHandle::default();
        app.manage(args);
        let paths = AppPaths::setup(&app).unwrap();
        assert_eq!(paths.config_dir, data);
        assert_eq!(paths.cache_dir, cache);
        assert_eq!(paths.logs_dir, logs);
        assert!(data.is_dir());
        assert!(paths.get_app_log_dir().is_dir());
        assert!(paths.get_rclone_log_dir().is_dir());
    }

    #[test]
    fn directory_creation_errors_are_reported() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("file");
        std::fs::write(&file, "occupied").unwrap();
        let paths = AppPaths {
            config_dir: file,
            cache_dir: temp.path().join("cache"),
            logs_dir: temp.path().join("logs"),
            resource_dir: temp.path().to_path_buf(),
        };
        assert!(
            paths
                .ensure_dirs()
                .unwrap_err()
                .contains("Failed to create config directory")
        );
    }
}
