use std::fmt;

//Librclone mode we don't use rclone binary so we don't use all error types. This is why allow dead code is used here.
#[derive(Debug)]
#[allow(dead_code)]
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
    RcAuthFailed(String),
    RcloneNotFound,
    WrongPassword,
    VersionTooOld { version: String, required: String },
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
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
            Self::RcAuthFailed(err) => {
                crate::localized_error!("backendErrors.rclone.rcAuthFailed", "error" => err)
            }
            Self::RcloneNotFound => crate::localized_error!("backendErrors.rclone.binaryNotFound"),
            Self::WrongPassword => {
                crate::localized_error!("backendErrors.security.incorrectPassword")
            }
            Self::VersionTooOld { version, required } => {
                crate::localized_error!(
                    "backendErrors.rclone.versionTooOld",
                    "version" => version,
                    "required" => required
                )
            }
        };
        write!(f, "{msg}")
    }
}

impl std::error::Error for EngineError {}

pub type EngineResult<T> = Result<T, EngineError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_engine_error_display() {
        let spawn_err: serde_json::Value =
            serde_json::from_str(&EngineError::SpawnFailed("test error".to_string()).to_string())
                .unwrap();
        assert_eq!(spawn_err["key"], "backendErrors.rclone.spawnFailed");
        assert_eq!(spawn_err["params"]["error"], "test error");

        assert_eq!(
            EngineError::InvalidPath.to_string(),
            "backendErrors.rclone.invalidPath"
        );

        let kill_err: serde_json::Value =
            serde_json::from_str(&EngineError::KillFailed("process gone".to_string()).to_string())
                .unwrap();
        assert_eq!(kill_err["key"], "backendErrors.rclone.killFailed");
        assert_eq!(kill_err["params"]["error"], "process gone");

        let port_err: serde_json::Value =
            serde_json::from_str(&EngineError::PortCleanupFailed("busy".to_string()).to_string())
                .unwrap();
        assert_eq!(port_err["key"], "backendErrors.rclone.portCleanupFailed");
        assert_eq!(port_err["params"]["error"], "busy");

        let config_err: serde_json::Value = serde_json::from_str(
            &EngineError::ConfigValidationFailed("bad config".to_string()).to_string(),
        )
        .unwrap();
        assert_eq!(
            config_err["key"],
            "backendErrors.rclone.configValidationFailed"
        );
        assert_eq!(config_err["params"]["error"], "bad config");

        let lock_err: serde_json::Value =
            serde_json::from_str(&EngineError::LockFailed("timeout".to_string()).to_string())
                .unwrap();
        assert_eq!(lock_err["key"], "backendErrors.rclone.lockFailed");
        assert_eq!(lock_err["params"]["error"], "timeout");

        let restart_err: serde_json::Value =
            serde_json::from_str(&EngineError::RestartFailed("hung".to_string()).to_string())
                .unwrap();
        assert_eq!(restart_err["key"], "backendErrors.rclone.restartFailed");
        assert_eq!(restart_err["params"]["error"], "hung");

        let cache_err: serde_json::Value = serde_json::from_str(
            &EngineError::CacheRefreshFailed("network".to_string()).to_string(),
        )
        .unwrap();
        assert_eq!(cache_err["key"], "backendErrors.rclone.cacheRefreshFailed");
        assert_eq!(cache_err["params"]["error"], "network");

        assert_eq!(
            EngineError::PasswordRequired.to_string(),
            "backendErrors.rclone.configEncrypted"
        );
    }

    #[test]
    fn test_engine_error_to_string_conversion() {
        let error = EngineError::SpawnFailed("conversion test".to_string());
        let string = error.to_string();
        let parsed: serde_json::Value = serde_json::from_str(&string).unwrap();
        assert_eq!(parsed["key"], "backendErrors.rclone.spawnFailed");
        assert_eq!(parsed["params"]["error"], "conversion test");
    }

    #[test]
    fn test_engine_error_is_error_trait() {
        fn assert_error<E: std::error::Error>() {}
        assert_error::<EngineError>();
    }
}
