//! Runtime information detection for rclone backends
//!
//! This module provides structures to store and manage runtime information
//! fetched from rclone's API endpoints, such as version, OS, architecture,
//! and connection status.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::utils::types::rclone::RcloneCoreVersion;

/// Connection status of an rclone backend
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(tag = "type", content = "message", rename_all = "camelCase")]
pub enum RuntimeStatus {
    /// Initial state, status not yet determined
    #[default]
    Unknown,
    /// Successfully connected to RC API
    Connected,
    /// Error connecting or communicating with backend
    Error(String),
}

/// Stores specific runtime properties detected from the rclone backend.
/// This includes environment details and the current connectivity status.
#[derive(Debug, Clone, Default)]
pub struct RuntimeInfo {
    /// Rclone version (e.g. "v1.66.0")
    pub version: Option<String>,
    /// OS (e.g. "linux", "windows")
    pub os: Option<String>,
    /// Architecture (e.g. "amd64", "arm64")
    ///
    /// Populated by `fetch_runtime_info` but currently not surfaced to the
    /// UI — kept for future diagnostics.
    pub arch: Option<String>,
    /// Go version (e.g. "go1.22.1")
    ///
    /// Populated by `fetch_runtime_info` but currently not surfaced to the
    /// UI — kept for future diagnostics.
    pub go_version: Option<String>,
    /// Process ID of rclone
    pub pid: Option<u32>,
    /// Full version response from Rclone
    pub core_version: Option<RcloneCoreVersion>,
    /// Config file path
    pub config_path: Option<PathBuf>,
    /// Connection status
    pub status: RuntimeStatus,
}

impl RuntimeInfo {
    /// Create a new empty `RuntimeInfo`
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a `RuntimeInfo` with error status
    pub fn with_error(error: impl Into<String>) -> Self {
        Self {
            status: RuntimeStatus::Error(error.into()),
            ..Default::default()
        }
    }

    /// Check if the backend is connected
    #[must_use]
    pub fn is_connected(&self) -> bool {
        matches!(self.status, RuntimeStatus::Connected)
    }

    /// Get error message if status is error
    #[must_use]
    pub fn error_message(&self) -> Option<String> {
        if let RuntimeStatus::Error(ref msg) = self.status {
            Some(msg.clone())
        } else {
            None
        }
    }

    /// Get architecture string if available
    #[must_use]
    pub fn arch(&self) -> Option<&str> {
        self.arch.as_deref()
    }

    /// Get Go version string if available
    #[must_use]
    pub fn go_version(&self) -> Option<&str> {
        self.go_version.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_runtime_info_new() {
        let info = RuntimeInfo::new();
        assert_eq!(info.status, RuntimeStatus::Unknown);
        assert!(info.version.is_none());
        assert!(info.os.is_none());
        assert!(info.arch().is_none());
        assert!(info.go_version().is_none());
    }

    #[test]
    fn test_runtime_info_with_error() {
        let info = RuntimeInfo::with_error("Connection timeout");
        assert!(matches!(info.status, RuntimeStatus::Error(_)));
        assert!(!info.is_connected());
        assert_eq!(info.error_message(), Some("Connection timeout".to_string()));
    }

    #[test]
    fn test_struct_fields() {
        let mut info = RuntimeInfo::new();
        info.version = Some("v1.66.0".to_string());
        info.os = Some("linux".to_string());
        info.arch = Some("amd64".to_string());
        info.go_version = Some("go1.22.1".to_string());

        assert_eq!(info.version, Some("v1.66.0".to_string()));
        assert_eq!(info.os, Some("linux".to_string()));
        assert_eq!(info.arch(), Some("amd64"));
        assert_eq!(info.go_version(), Some("go1.22.1"));
    }
}
