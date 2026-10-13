//! Centralized application paths - single source of truth
//!
//! This module provides a unified way to access application directories
//! (config, cache, logs) across the entire codebase. Supports both
//! standard and portable mode.

use crate::context::AppHandle;
use serde::Serialize;
use std::path::PathBuf;

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
    /// Host resource directory (native resources and development frontend assets)
    pub resource_dir: PathBuf,
}

impl AppPaths {
    /// Read the paths established during startup without resolving them again.
    pub fn from_app_handle(app: &AppHandle) -> Result<Self, String> {
        app.try_state::<Self>()
            .map(|paths| paths.inner().clone())
            .ok_or_else(|| "Application paths have not been initialized".to_string())
    }

    /// Setup application paths and ensure directories exist
    ///
    /// This is the main entry point for initializing paths during app startup.
    /// Registers paths only after directory creation succeeds.
    pub fn setup(app: &AppHandle) -> Result<Self, String> {
        if let Some(paths) = app.try_state::<Self>() {
            return Ok(paths.inner().clone());
        }
        let paths = app.host().resolve_paths(app)?;
        paths.ensure_dirs()?;
        app.manage(paths);
        Self::from_app_handle(app)
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

    /// Resolve the serve template, materializing it only when needed by rclone.
    pub fn serve_template_path(&self) -> Result<PathBuf, String> {
        self.template_path(
            "serve-template.html",
            include_bytes!("../../resources/serve-template.html"),
        )
    }

    /// Resolve the OAuth template, materializing it only when needed by rclone.
    pub fn oauth_template_path(&self) -> Result<PathBuf, String> {
        self.template_path(
            "oauth-template.html",
            include_bytes!("../../resources/oauth-template.html"),
        )
    }

    fn template_path(&self, filename: &str, content: &[u8]) -> Result<PathBuf, String> {
        #[cfg(debug_assertions)]
        {
            let _ = content;
            Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join(filename))
        }
        #[cfg(not(debug_assertions))]
        {
            self.materialize_template(filename, content)
                .map_err(|e| format!("Failed to prepare {filename}: {e}"))
        }
    }

    #[cfg(any(not(debug_assertions), test))]
    fn materialize_template(&self, filename: &str, content: &[u8]) -> std::io::Result<PathBuf> {
        use std::io::Write;
        let directory = self
            .cache_dir
            .join("templates")
            .join(env!("CARGO_PKG_VERSION"));
        std::fs::create_dir_all(&directory)?;
        let path = directory.join(filename);
        if std::fs::read(&path).is_ok_and(|existing| existing == content) {
            return Ok(path);
        }
        // Publish a complete file atomically, including on concurrent requests.
        let mut file = tempfile::NamedTempFile::new_in(&directory)?;
        file.write_all(content)?;
        file.persist(&path).map_err(|e| e.error)?;
        Ok(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct PathHost {
        paths: AppPaths,
        calls: std::sync::atomic::AtomicUsize,
    }

    #[async_trait::async_trait]
    impl crate::context::Host for PathHost {
        fn resolve_paths(&self, _app: &AppHandle) -> Result<AppPaths, String> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(self.paths.clone())
        }
        fn restart(&self, _app: &AppHandle) -> Result<(), String> {
            Err("Restart is not part of this test".into())
        }
    }

    fn test_context(root: &std::path::Path) -> (AppHandle, std::sync::Arc<PathHost>) {
        let host = std::sync::Arc::new(PathHost {
            paths: AppPaths {
                config_dir: root.join("data"),
                cache_dir: root.join("cache"),
                logs_dir: root.join("logs"),
                resource_dir: root.join("resources"),
            },
            calls: Default::default(),
        });
        (AppHandle::new(host.clone(), Default::default()), host)
    }

    #[test]
    fn reads_require_setup_and_never_resolve_paths() {
        let temp = tempfile::tempdir().unwrap();
        let (app, host) = test_context(temp.path());
        assert!(
            AppPaths::from_app_handle(&app)
                .unwrap_err()
                .contains("not been initialized")
        );
        assert_eq!(host.calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[test]
    fn setup_registers_paths_once_and_clones_read_the_same_directories() {
        let temp = tempfile::tempdir().unwrap();
        let (app, host) = test_context(temp.path());
        let paths = AppPaths::setup(&app).unwrap();
        assert!(paths.config_dir.is_dir());
        assert!(paths.cache_dir.is_dir());
        assert!(paths.get_app_log_dir().is_dir());
        assert!(paths.get_rclone_log_dir().is_dir());
        for context in [app.clone(), app] {
            let stored = AppPaths::from_app_handle(&context).unwrap();
            assert_eq!(stored.config_dir, paths.config_dir);
            assert_eq!(stored.cache_dir, paths.cache_dir);
            assert_eq!(stored.logs_dir, paths.logs_dir);
            assert_eq!(stored.resource_dir, paths.resource_dir);
            assert_eq!(
                AppPaths::setup(&context).unwrap().config_dir,
                paths.config_dir
            );
        }
        assert_eq!(host.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn failed_setup_does_not_publish_paths_and_can_be_retried() {
        let temp = tempfile::tempdir().unwrap();
        let (app, host) = test_context(temp.path());
        std::fs::write(&host.paths.config_dir, "occupied").unwrap();
        assert!(AppPaths::setup(&app).is_err());
        assert!(AppPaths::from_app_handle(&app).is_err());
        std::fs::remove_file(&host.paths.config_dir).unwrap();
        assert!(AppPaths::setup(&app).is_ok());
        assert_eq!(host.calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[test]
    fn templates_are_materialized_and_repaired_in_cache() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths {
            config_dir: temp.path().join("data"),
            cache_dir: temp.path().join("cache"),
            logs_dir: temp.path().join("logs"),
            resource_dir: temp.path().to_path_buf(),
        };
        for (name, bytes) in [
            (
                "oauth-template.html",
                include_bytes!("../../resources/oauth-template.html").as_slice(),
            ),
            (
                "serve-template.html",
                include_bytes!("../../resources/serve-template.html").as_slice(),
            ),
        ] {
            let path = paths.materialize_template(name, bytes).unwrap();
            assert!(path.starts_with(&paths.cache_dir));
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
            assert_eq!(paths.materialize_template(name, bytes).unwrap(), path);
            std::fs::write(&path, "stale contents").unwrap();
            paths.materialize_template(name, bytes).unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
            std::fs::remove_file(&path).unwrap();
            paths.materialize_template(name, bytes).unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
        std::fs::remove_dir_all(&paths.cache_dir).unwrap();
        std::fs::write(&paths.cache_dir, "not a directory").unwrap();
        assert!(
            paths
                .materialize_template("serve-template.html", b"template")
                .is_err()
        );
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
