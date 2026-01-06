//! Centralized application paths - single source of truth
//!
//! This module provides a unified way to access application directories
//! (config, cache, logs) across the entire codebase. Supports both
//! standard and portable mode.

#[cfg(feature = "portable")]
use log::info;
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

// ============================================================================
// Portable Mode Helpers
// ============================================================================

/// Get the directory containing the executable (for portable mode)
#[cfg(feature = "portable")]
fn get_executable_directory() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|e| format!("Failed to get executable path: {e}"))?
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "Failed to get executable directory".to_string())
}

// ============================================================================
// AppPaths Struct
// ============================================================================

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
}

impl AppPaths {
    /// Create AppPaths for portable mode
    ///
    /// Uses directories next to the executable.
    #[cfg(feature = "portable")]
    pub fn from_app_handle(_app: &AppHandle) -> Result<Self, String> {
        let exe_dir = get_executable_directory()?;

        let config_dir = exe_dir.join("config");
        let cache_dir = exe_dir.join("cache");
        let logs_dir = cache_dir.join("logs");

        info!("📦 Running in PORTABLE mode");
        info!("📁 Config directory: {}", config_dir.display());
        info!("📁 Cache directory: {}", cache_dir.display());

        Ok(Self {
            config_dir,
            cache_dir,
            logs_dir,
        })
    }

    /// Create AppPaths for standard mode
    ///
    /// Uses system directories via Tauri's path resolver.
    #[cfg(not(feature = "portable"))]
    pub fn from_app_handle(app: &AppHandle) -> Result<Self, String> {
        // Get cache directory
        let cache_dir = app
            .path()
            .app_cache_dir()
            .map_err(|e| format!("Failed to get cache directory: {}", e))?;

        // Get config directory (app data)
        let config_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to get config directory: {}", e))?;

        // Logs are stored in cache/logs
        let logs_dir = config_dir.join("logs");

        Ok(Self {
            config_dir,
            cache_dir,
            logs_dir,
        })
    }

    /// Setup application paths and ensure directories exist
    ///
    /// This is the main entry point for initializing paths during app startup.
    /// Returns the config directory path for backwards compatibility.
    pub fn setup(app: &AppHandle) -> Result<PathBuf, String> {
        let paths = Self::from_app_handle(app)?;
        paths.ensure_dirs()?;
        Ok(paths.config_dir)
    }

    /// Ensure all directories exist
    pub fn ensure_dirs(&self) -> Result<(), String> {
        std::fs::create_dir_all(&self.config_dir)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
        std::fs::create_dir_all(&self.cache_dir)
            .map_err(|e| format!("Failed to create cache directory: {}", e))?;
        std::fs::create_dir_all(&self.logs_dir)
            .map_err(|e| format!("Failed to create logs directory: {}", e))?;
        Ok(())
    }
}

/// Get AppPaths from a Tauri AppHandle
///
/// Convenience function for common usage pattern.
pub fn get_app_paths(app: &AppHandle) -> Result<AppPaths, String> {
    AppPaths::from_app_handle(app)
}
