//! Runtime information detection for rclone backends
//!
//! This module provides extensible runtime information detection by fetching
//! ALL available properties from rclone's API endpoints and storing them in a
//! flexible HashMap structure. This means adding new runtime properties doesn't
//! require code changes - they're automatically available.

/// Extensible runtime information storage
///
/// Stores all runtime properties as a flat key-value map, allowing
/// automatic access to any property exposed by rclone's API without
/// requiring code changes when new properties are added.
/// Runtime information gathered from API
#[derive(Debug, Clone, Default)]
pub struct RuntimeInfo {
    /// Rclone version (e.g. "v1.66.0")
    pub version: Option<String>,
    /// OS (e.g. "linux", "windows")
    pub os: Option<String>,
    /// Architecture (e.g. "amd64", "arm64")
    pub arch: Option<String>,
    /// Go version (e.g. "go1.22.1")
    pub go_version: Option<String>,
    /// Config file path
    pub config_path: Option<String>,
    /// Connection status: "connected", "error:message", or empty
    pub status: String,
}

impl RuntimeInfo {
    /// Create a new empty RuntimeInfo
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a RuntimeInfo with error status
    pub fn with_error(error: impl Into<String>) -> Self {
        Self {
            status: format!("error:{}", error.into()),
            ..Default::default()
        }
    }

    /// Set connection status
    pub fn set_status(&mut self, status: impl Into<String>) {
        self.status = status.into();
    }

    // ============================================================================
    // Common property accessors (kept for compatibility)
    // ============================================================================

    pub fn version(&self) -> Option<String> {
        self.version.clone()
    }

    pub fn os(&self) -> Option<String> {
        self.os.clone()
    }

    pub fn config_path(&self) -> Option<String> {
        self.config_path.clone()
    }

    /// Check if the backend is connected
    pub fn is_connected(&self) -> bool {
        self.status == "connected"
    }

    /// Get error message if status is error
    pub fn error_message(&self) -> Option<String> {
        if self.status.starts_with("error:") {
            Some(self.status.trim_start_matches("error:").to_string())
        } else {
            None
        }
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_runtime_info_new() {
        let info = RuntimeInfo::new();
        assert_eq!(info.status, "");
        assert!(info.version.is_none());
        assert!(info.os.is_none());
    }

    #[test]
    fn test_runtime_info_connected() {
        let mut info = RuntimeInfo::new();
        info.set_status("connected");
        assert_eq!(info.status, "connected");
        assert!(info.is_connected());
    }

    #[test]
    fn test_runtime_info_error() {
        let info = RuntimeInfo::with_error("Connection timeout");
        assert!(info.status.starts_with("error:"));
        assert!(!info.is_connected());
        assert_eq!(info.error_message(), Some("Connection timeout".to_string()));
    }

    #[test]
    fn test_struct_fields() {
        let mut info = RuntimeInfo::new();
        info.version = Some("v1.66.0".to_string());
        info.os = Some("linux".to_string());
        info.arch = Some("amd64".to_string());

        assert_eq!(info.version(), Some("v1.66.0".to_string()));
        assert_eq!(info.os(), Some("linux".to_string()));
        assert_eq!(info.arch.as_deref(), Some("amd64"));
    }
}
