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
    RcloneNotFound,
    WrongPassword,
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Helper to reduce boilerplate - directly write localized message
        let msg = match self {
            Self::SpawnFailed(err) => {
                crate::localized_error!("backendErrors.rclone.spawnFailed", "error" => err)
            }
            Self::InvalidPath => crate::localized_error!("backendErrors.rclone.invalidPath"),
            Self::KillFailed(err) => {
                crate::localized_error!("backendErrors.rclone.killFailed", "error" => err)
            }
            Self::PortCleanupFailed(err) => {
                crate::localized_error!("backendErrors.rclone.portCleanupFailed", "error" => err)
            }
            Self::ConfigValidationFailed(err) => {
                crate::localized_error!("backendErrors.rclone.configValidationFailed", "error" => err)
            }
            Self::LockFailed(err) => {
                crate::localized_error!("backendErrors.rclone.lockFailed", "error" => err)
            }
            Self::RestartFailed(err) => {
                crate::localized_error!("backendErrors.rclone.restartFailed", "error" => err)
            }
            Self::CacheRefreshFailed(err) => {
                crate::localized_error!("backendErrors.rclone.cacheRefreshFailed", "error" => err)
            }
            Self::PasswordRequired => {
                crate::localized_error!("backendErrors.rclone.configEncrypted")
            }
            Self::RcloneNotFound => crate::localized_error!("backendErrors.rclone.binaryNotFound"),
            Self::WrongPassword => {
                crate::localized_error!("backendErrors.security.incorrectPassword")
            }
        };
        write!(f, "{}", msg)
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
            "backendErrors.rclone.spawnFailed"
        );
        assert_eq!(
            EngineError::InvalidPath.to_string(),
            "backendErrors.rclone.invalidPath"
        );
        assert_eq!(
            EngineError::KillFailed("process gone".to_string()).to_string(),
            "backendErrors.rclone.killFailed"
        );
        assert_eq!(
            EngineError::PortCleanupFailed("busy".to_string()).to_string(),
            "backendErrors.rclone.portCleanupFailed"
        );
        assert_eq!(
            EngineError::ConfigValidationFailed("bad config".to_string()).to_string(),
            "backendErrors.rclone.configValidationFailed"
        );
        assert_eq!(
            EngineError::LockFailed("timeout".to_string()).to_string(),
            "backendErrors.rclone.lockFailed"
        );
        assert_eq!(
            EngineError::RestartFailed("hung".to_string()).to_string(),
            "backendErrors.rclone.restartFailed"
        );
        assert_eq!(
            EngineError::CacheRefreshFailed("network".to_string()).to_string(),
            "backendErrors.rclone.cacheRefreshFailed"
        );
        assert_eq!(
            EngineError::PasswordRequired.to_string(),
            "backendErrors.rclone.configEncrypted"
        );
    }

    #[test]
    fn test_engine_error_to_string_conversion() {
        let error = EngineError::SpawnFailed("conversion test".to_string());
        let string: String = error.into();
        assert_eq!(string, "backendErrors.rclone.spawnFailed");
    }

    #[test]
    fn test_engine_error_is_error_trait() {
        // Verify EngineError implements std::error::Error
        fn assert_error<E: std::error::Error>() {}
        assert_error::<EngineError>();
    }
}
