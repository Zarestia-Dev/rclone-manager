use std::fmt;

/// Errors that can occur during engine operations
#[derive(Debug)]
pub enum EngineError {
    SpawnFailed(String),
    InvalidPath,
    KillFailed(String),
    PortCleanupFailed(String),
    ConfigValidationFailed(String),
    LockFailed(String),
    RestartFailed(String),
    CacheRefreshFailed(String),
    PasswordRequired,
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EngineError::SpawnFailed(msg) => write!(f, "Spawn failed: {msg}"),
            EngineError::InvalidPath => write!(f, "Invalid rclone path"),
            EngineError::KillFailed(msg) => write!(f, "Kill failed: {msg}"),
            EngineError::PortCleanupFailed(msg) => write!(f, "Port cleanup failed: {msg}"),
            EngineError::ConfigValidationFailed(msg) => {
                write!(f, "Config validation failed: {msg}")
            }
            EngineError::LockFailed(msg) => write!(f, "Lock acquisition failed: {msg}"),
            EngineError::RestartFailed(msg) => write!(f, "Restart failed: {msg}"),
            EngineError::CacheRefreshFailed(msg) => write!(f, "Cache refresh failed: {msg}"),
            EngineError::PasswordRequired => write!(f, "Configuration password required"),
        }
    }
}

impl std::error::Error for EngineError {}

pub type EngineResult<T> = Result<T, EngineError>;

// Convert to String for backward compatibility
impl From<EngineError> for String {
    fn from(e: EngineError) -> Self {
        e.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_engine_error_display() {
        assert_eq!(
            EngineError::SpawnFailed("test error".to_string()).to_string(),
            "Spawn failed: test error"
        );
        assert_eq!(EngineError::InvalidPath.to_string(), "Invalid rclone path");
        assert_eq!(
            EngineError::KillFailed("process gone".to_string()).to_string(),
            "Kill failed: process gone"
        );
        assert_eq!(
            EngineError::PortCleanupFailed("busy".to_string()).to_string(),
            "Port cleanup failed: busy"
        );
        assert_eq!(
            EngineError::ConfigValidationFailed("bad config".to_string()).to_string(),
            "Config validation failed: bad config"
        );
        assert_eq!(
            EngineError::LockFailed("timeout".to_string()).to_string(),
            "Lock acquisition failed: timeout"
        );
        assert_eq!(
            EngineError::RestartFailed("hung".to_string()).to_string(),
            "Restart failed: hung"
        );
        assert_eq!(
            EngineError::CacheRefreshFailed("network".to_string()).to_string(),
            "Cache refresh failed: network"
        );
        assert_eq!(
            EngineError::PasswordRequired.to_string(),
            "Configuration password required"
        );
    }

    #[test]
    fn test_engine_error_to_string_conversion() {
        let error = EngineError::SpawnFailed("conversion test".to_string());
        let string: String = error.into();
        assert_eq!(string, "Spawn failed: conversion test");
    }

    #[test]
    fn test_engine_error_is_error_trait() {
        // Verify EngineError implements std::error::Error
        fn assert_error<E: std::error::Error>() {}
        assert_error::<EngineError>();
    }
}
