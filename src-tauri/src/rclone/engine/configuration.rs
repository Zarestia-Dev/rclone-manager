use log::{error, info, warn};
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    core::security::SafeEnvironmentManager,
    utils::types::{
        events::{EngineStatus, RCLONE_ENGINE_STATUS_CHANGED},
        state::RcApiEngine,
    },
};

#[cfg(not(feature = "librclone"))]
use crate::core::check_binaries::{MIN_RCLONE_VERSION, build_rclone_command};
use crate::rclone::backend::BackendManager;
#[cfg(feature = "librclone")]
use crate::utils::types::state::RcloneState;

use super::error::{EngineError, EngineResult};

impl RcApiEngine {
    pub async fn validate_config_before_start(&self, app: &AppHandle) -> EngineResult<()> {
        info!("Validating rclone configuration before engine start");

        let backend_manager = app.try_state::<BackendManager>().ok_or_else(|| {
            EngineError::ConfigValidationFailed("BackendManager not in state".to_string())
        })?;

        if !backend_manager.is_active_local().await {
            info!("Active backend is remote, skipping configuration validation");
            return Ok(());
        }

        #[cfg(not(feature = "librclone"))]
        {
            let rclone_binary = crate::core::check_binaries::read_rclone_binary(app);
            if !rclone_binary.exists() || !rclone_binary.is_file() {
                return Err(EngineError::RcloneNotFound);
            }

            match crate::core::check_binaries::get_rclone_version(&rclone_binary).await {
                Some(version) => {
                    if !crate::core::check_binaries::is_version_at_least(
                        &version,
                        MIN_RCLONE_VERSION,
                    ) {
                        return Err(EngineError::VersionTooOld {
                            version,
                            required: MIN_RCLONE_VERSION.to_string(),
                        });
                    }
                }
                None => {
                    return Err(EngineError::ConfigValidationFailed(crate::t!(
                        "backendErrors.rclone.executionFailed"
                    )));
                }
            }
        }

        let is_encrypted = match crate::core::security::is_config_encrypted(app.clone()).await {
            Ok(encrypted) => encrypted,
            Err(e) => {
                error!("Failed to check configuration encryption status: {e}");
                return Err(EngineError::ConfigValidationFailed(format!(
                    "Failed to check encryption: {e}"
                )));
            }
        };

        if !is_encrypted {
            info!("Configuration is not encrypted, validation successful");
            return Ok(());
        }

        info!("Configuration is encrypted, testing password");

        let env_vars = if let Some(env_manager) = app.try_state::<SafeEnvironmentManager>() {
            env_manager.get_env_vars()
        } else {
            warn!("SafeEnvironmentManager not available, using system environment");
            std::env::vars().collect()
        };

        if !env_vars.contains_key("RCLONE_CONFIG_PASS") {
            warn!("No password available for encrypted configuration");
            return Err(EngineError::PasswordRequired);
        }

        #[cfg(feature = "librclone")]
        {
            let password = env_vars
                .get("RCLONE_CONFIG_PASS")
                .cloned()
                .unwrap_or_default();

            let state = app.state::<RcloneState>();
            let payload = serde_json::json!({ "password": password });

            match state
                .transport
                .rpc("config/validatepassword", Some(&payload))
                .await
            {
                Ok(_) => {
                    info!("Rclone configuration and password validation successful (librclone)");
                    Ok(())
                }
                Err(e) => {
                    let err_str = e.to_string();
                    if err_str.contains("wrong password") || err_str.contains("decryption failed") {
                        error!("Wrong password for encrypted rclone configuration");
                        return Err(EngineError::WrongPassword);
                    }
                    if err_str.contains("not encrypted") {
                        info!("Config reported as not encrypted during validation — continuing");
                        return Ok(());
                    }
                    error!("Config validation failed: {err_str}");
                    Err(EngineError::ConfigValidationFailed(err_str))
                }
            }
        }

        #[cfg(not(feature = "librclone"))]
        {
            let backend_manager = app.state::<BackendManager>();
            let config_path_string =
                backend_manager.get_local_config_path().await.map_err(|e| {
                    EngineError::ConfigValidationFailed(format!("Local backend error: {e}"))
                })?;

            let output = build_rclone_command(app, None, config_path_string.as_deref(), None)
                .args(["listremotes", "--ask-password=false"])
                .envs(&env_vars)
                .output()
                .await
                .map_err(|e| {
                    EngineError::ConfigValidationFailed(format!(
                        "Failed to execute rclone command: {e}"
                    ))
                })?;

            let stderr = String::from_utf8_lossy(&output.stderr);

            if output.status.success() {
                info!("Rclone configuration and password validation successful");
                return Ok(());
            }

            if stderr
                .contains("unable to decrypt configuration and not allowed to ask for password")
                || stderr.contains("Couldn't decrypt configuration")
                || stderr.contains("most likely wrong password")
                || stderr.contains("unable to decrypt configuration")
            {
                error!("Wrong password for encrypted rclone configuration");
                return Err(EngineError::WrongPassword);
            }

            if stderr.contains("Failed to load config file") {
                let msg = format!("Failed to load rclone config file: {}", stderr.trim());
                error!("{msg}");
                return Err(EngineError::ConfigValidationFailed(msg));
            }

            warn!(
                "Unexpected rclone error, attempting to continue: {}",
                stderr.trim()
            );
            Ok(())
        }
    }

    pub async fn validate_config(&mut self, app: &AppHandle) -> bool {
        info!("Testing rclone configuration and password");

        match self.validate_config_before_start(app).await {
            Ok(()) => {
                info!("Rclone configuration and password are valid");
                self.clear_errors();
                true
            }
            Err(e) => {
                error!("Rclone configuration validation failed: {e}");
                self.apply_config_error(&e);
                let status: EngineStatus = (&self.phase).into();
                if let Err(emit_err) = app.emit(RCLONE_ENGINE_STATUS_CHANGED, status) {
                    error!("Failed to emit validation error event: {emit_err}");
                }
                false
            }
        }
    }
}

impl RcApiEngine {
    fn apply_config_error(&mut self, e: &EngineError) {
        match e {
            #[cfg(not(feature = "librclone"))]
            EngineError::RcloneNotFound | EngineError::InvalidPath => {
                self.mark_path_failed();
            }
            #[cfg(not(feature = "librclone"))]
            EngineError::VersionTooOld { version, required } => {
                self.mark_version_failed(version.clone(), required.clone());
            }
            EngineError::WrongPassword | EngineError::PasswordRequired => {
                self.mark_password_failed();
            }
            EngineError::RcAuthFailed(msg) => {
                self.mark_auth_failed(msg.clone());
            }
            other => {
                self.mark_other_failed(other.to_string());
            }
        }
    }
}
