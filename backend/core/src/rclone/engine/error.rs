use std::fmt;

#[derive(Debug)]
pub enum EngineError {
    #[cfg(not(feature = "librclone"))]
    SpawnFailed(String),
    #[cfg(not(feature = "librclone"))]
    InvalidPath,
    ConfigValidationFailed(String),
    RestartFailed(String),
    PasswordRequired,
    #[cfg(not(feature = "librclone"))]
    RcloneNotFound,
    WrongPassword,
    #[cfg(not(feature = "librclone"))]
    VersionTooOld {
        version: String,
        required: String,
    },
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let msg = match self {
            #[cfg(not(feature = "librclone"))]
            Self::SpawnFailed(err) => {
                crate::localized_error!("backendErrors.rclone.spawnFailed", "error" => err)
            }
            #[cfg(not(feature = "librclone"))]
            Self::InvalidPath => crate::localized_error!("backendErrors.rclone.invalidPath"),
            Self::ConfigValidationFailed(err) => {
                crate::localized_error!("backendErrors.rclone.configValidationFailed", "error" => err)
            }
            Self::RestartFailed(err) => {
                crate::localized_error!("backendErrors.rclone.restartFailed", "error" => err)
            }
            Self::PasswordRequired => {
                crate::localized_error!("backendErrors.rclone.configEncrypted")
            }
            #[cfg(not(feature = "librclone"))]
            Self::RcloneNotFound => crate::localized_error!("backendErrors.rclone.binaryNotFound"),
            Self::WrongPassword => {
                crate::localized_error!("backendErrors.security.incorrectPassword")
            }
            #[cfg(not(feature = "librclone"))]
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
    fn engine_errors_preserve_localization_keys_and_parameters() {
        for (error, key, value) in [
            (
                EngineError::ConfigValidationFailed("bad config\n特殊".into()),
                "configValidationFailed",
                "bad config\n特殊",
            ),
            (
                EngineError::RestartFailed("hung".into()),
                "restartFailed",
                "hung",
            ),
        ] {
            let parsed: serde_json::Value = serde_json::from_str(&error.to_string()).unwrap();
            assert_eq!(parsed["key"], format!("backendErrors.rclone.{key}"));
            assert_eq!(parsed["params"]["error"], value);
        }
        assert_eq!(
            EngineError::PasswordRequired.to_string(),
            "backendErrors.rclone.configEncrypted"
        );
        assert_eq!(
            EngineError::WrongPassword.to_string(),
            "backendErrors.security.incorrectPassword"
        );
    }

    #[cfg(not(feature = "librclone"))]
    #[test]
    fn binary_engine_errors_preserve_spawn_path_and_version_details() {
        let spawn: serde_json::Value =
            serde_json::from_str(&EngineError::SpawnFailed("not executable".into()).to_string())
                .unwrap();
        assert_eq!(spawn["key"], "backendErrors.rclone.spawnFailed");
        assert_eq!(spawn["params"]["error"], "not executable");
        assert_eq!(
            EngineError::InvalidPath.to_string(),
            "backendErrors.rclone.invalidPath"
        );
        assert_eq!(
            EngineError::RcloneNotFound.to_string(),
            "backendErrors.rclone.binaryNotFound"
        );
        let version: serde_json::Value = serde_json::from_str(
            &EngineError::VersionTooOld {
                version: "1.0.0".into(),
                required: "1.2.0".into(),
            }
            .to_string(),
        )
        .unwrap();
        assert_eq!(version["key"], "backendErrors.rclone.versionTooOld");
        assert_eq!(version["params"]["version"], "1.0.0");
        assert_eq!(version["params"]["required"], "1.2.0");
    }
}
