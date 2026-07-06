use crate::core::settings::AppSettingsManager;
use crate::utils::types::events::RCLONE_PASSWORD_STORED;
use crate::{
    core::{check_binaries::build_rclone_command, security::SafeEnvironmentManager},
    rclone::commands::system::unlock_rclone_config,
};
use log::{debug, error, info, warn};
use tauri::{AppHandle, Emitter, Manager};

fn update_local_config_password(
    manager: &AppSettingsManager,
    password: Option<&str>,
) -> Result<(), String> {
    let connections = manager
        .sub_settings("connections")
        .map_err(|e| format!("Failed to access connections settings: {e}"))?;

    connections
        .set_field("Local", "config_password", &password.unwrap_or_default())
        .map_err(|e| format!("Failed to update Local config password: {e}"))
}

#[tauri::command]
pub async fn store_config_password(app: AppHandle, password: String) -> Result<(), String> {
    info!("Storing rclone config password");

    let manager = app.state::<AppSettingsManager>();
    let env_manager = app.state::<SafeEnvironmentManager>();

    update_local_config_password(manager.inner(), Some(&password))
        .map_err(|e| crate::localized_error!("backendErrors.security.storeFailed", "error" => e))?;

    env_manager.set_config_password(password.clone());

    if let Err(e) = app.emit(RCLONE_PASSWORD_STORED, ()) {
        error!("Failed to emit password_stored event: {e}");
    }

    use crate::rclone::backend::BackendManager;
    let backend_manager = app.state::<BackendManager>();
    if let Some(mut backend) = backend_manager.get("Local").await {
        backend.config_password = Some(password.clone());
        let _ = backend_manager
            .update(manager.inner(), "Local", backend)
            .await;
        debug!("Updated in-memory Local backend config password");
    }

    info!("Password stored successfully");
    Ok(())
}

#[tauri::command]
pub async fn get_config_password(app: AppHandle) -> Result<String, String> {
    let manager = app.state::<AppSettingsManager>();
    let connections = manager
        .inner()
        .sub_settings("connections")
        .map_err(|e| format!("Failed to access connections settings: {e}"))?;

    if let Ok(local) = connections.get_value("Local")
        && let Some(password) = local.get("config_password").and_then(|v| v.as_str())
        && !password.is_empty()
    {
        return Ok(password.to_string());
    }

    Err(crate::localized_error!(
        "backendErrors.security.noPasswordStored"
    ))
}

#[tauri::command]
pub async fn has_stored_password(app: AppHandle) -> Result<bool, String> {
    let manager = app.state::<AppSettingsManager>();
    let connections = manager
        .inner()
        .sub_settings("connections")
        .map_err(|e| format!("Failed to access connections settings: {e}"))?;

    if let Ok(local) = connections.get_value("Local") {
        let has_password = local
            .get("config_password")
            .and_then(|v| v.as_str())
            .is_some_and(|v| !v.is_empty());
        return Ok(has_password);
    }

    Ok(false)
}

#[tauri::command]
pub async fn remove_config_password(app: AppHandle) -> Result<(), String> {
    info!("Removing stored config password");

    let manager = app.state::<AppSettingsManager>();
    let env_manager = app.state::<SafeEnvironmentManager>();

    update_local_config_password(manager.inner(), None)
        .map_err(|e| format!("Failed to clear config password: {e}"))?;

    use crate::rclone::backend::BackendManager;
    let backend_manager = app.state::<BackendManager>();
    if let Some(mut backend) = backend_manager.get("Local").await {
        backend.config_password = None;
        let _ = backend_manager
            .update(manager.inner(), "Local", backend)
            .await;
    }

    env_manager.clear_config_password();
    info!("Password removed successfully");
    Ok(())
}

#[tauri::command]
pub async fn validate_rclone_password(app: AppHandle, password: String) -> Result<(), String> {
    if password.trim().is_empty() {
        return Err(crate::localized_error!(
            "backendErrors.security.passwordEmpty"
        ));
    }

    use crate::rclone::backend::BackendManager;
    let backend_manager = app.state::<BackendManager>();
    let config_path = backend_manager.get_local_config_path().await.map_err(
        |e| crate::localized_error!("backendErrors.rclone.executionFailed", "error" => e),
    )?;

    let output = build_rclone_command(&app, None, config_path.as_deref(), None)
        .args(["listremotes", "--ask-password=false"])
        .env("RCLONE_CONFIG_PASS", &password)
        .output()
        .await
        .map_err(
            |e| crate::localized_error!("backendErrors.rclone.executionFailed", "error" => e),
        )?;

    if output.status.success() {
        info!("Password validation successful");
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    error!("Password validation failed: {stderr}");

    let error_msg = if stderr.contains("Couldn't decrypt configuration, most likely wrong password")
        || stderr.contains("unable to decrypt configuration")
        || stderr.contains("wrong password")
    {
        crate::localized_error!("backendErrors.security.incorrectPassword")
    } else {
        crate::localized_error!("backendErrors.security.rcloneError", "error" => stderr.trim())
    };

    Err(error_msg)
}

#[tauri::command]
pub async fn set_config_password_env(app: AppHandle, password: String) -> Result<(), String> {
    let env_manager = app.state::<SafeEnvironmentManager>();
    env_manager.set_config_password(password);

    if let Err(e) = app.emit(RCLONE_PASSWORD_STORED, ()) {
        error!("Failed to emit password_stored event: {e}");
    }

    Ok(())
}

#[tauri::command]
pub async fn is_config_encrypted(app: AppHandle) -> Result<bool, String> {
    #[cfg(feature = "librclone")]
    {
        use crate::utils::types::state::RcloneState;
        let state = app.state::<RcloneState>();
        match state.transport.rpc("config/isencrypted", None).await {
            Ok(res) => {
                let is_encrypted = res
                    .get("encrypted")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                debug!("Configuration encryption status: {is_encrypted}");
                Ok(is_encrypted)
            }
            Err(e) => {
                let err_str = e.to_string();
                error!("Failed to check encryption status via librclone: {err_str}");
                Err(err_str)
            }
        }
    }
    #[cfg(not(feature = "librclone"))]
    {
        use crate::rclone::backend::BackendManager;
        let backend_manager = app.state::<BackendManager>();
        let config_path = backend_manager.get_local_config_path().await.map_err(
            |e| crate::localized_error!("backendErrors.rclone.executionFailed", "error" => e),
        )?;

        let output = build_rclone_command(&app, None, config_path.as_deref(), None)
            .args(["listremotes", "--ask-password=false"])
            .output()
            .await
            .map_err(
                |e| crate::localized_error!("backendErrors.rclone.executionFailed", "error" => e),
            )?;

        let stderr = String::from_utf8_lossy(&output.stderr);

        let is_encrypted = stderr
            .contains("unable to decrypt configuration and not allowed to ask for password")
            || (stderr.contains("Failed to load config file")
                && stderr.contains("unable to decrypt"));

        debug!(
            "Configuration is {}",
            if is_encrypted {
                "encrypted"
            } else {
                "not encrypted"
            }
        );

        Ok(is_encrypted)
    }
}

async fn run_encryption_command(
    app: &AppHandle,
    action: &str,
    password: &str,
) -> Result<(String, String), String> {
    use crate::rclone::backend::BackendManager;
    let backend_manager = app.state::<BackendManager>();
    let config_path = backend_manager.get_local_config_path().await.map_err(
        |e| crate::localized_error!("backendErrors.rclone.executionFailed", "error" => e),
    )?;

    let password_command = if cfg!(windows) {
        format!(
            "powershell -Command \"Write-Host {} -NoNewline\"",
            password.replace('\'', "''")
        )
    } else {
        format!("echo \"{password}\"")
    };

    let output = build_rclone_command(app, None, config_path.as_deref(), None)
        .args([
            "config",
            "encryption",
            action,
            "--password-command",
            &password_command,
        ])
        .output()
        .await
        .map_err(
            |e| crate::localized_error!("backendErrors.rclone.executionFailed", "error" => e),
        )?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    let success = output.status.success()
        || (action == "set"
            && (stdout.contains("Password set")
                || stdout.contains("Your configuration is encrypted")))
        || (action == "remove"
            && (stdout.contains("Your configuration is not encrypted")
                || stderr.contains("config file is NOT encrypted")));

    if success {
        return Ok((stdout, stderr));
    }

    let err_detail = if stderr.trim().is_empty() {
        stdout
    } else {
        stderr
    };
    let l10n_key = if action == "set" {
        "backendErrors.security.encryptFailed"
    } else {
        "backendErrors.security.decryptFailed"
    };

    Err(crate::localized_error!(l10n_key, "error" => err_detail))
}

#[tauri::command]
pub async fn encrypt_config(app: AppHandle, password: String) -> Result<(), String> {
    info!("Encrypting rclone configuration");

    run_encryption_command(&app, "set", &password).await?;

    let manager = app.state::<AppSettingsManager>();
    let env_manager = app.state::<SafeEnvironmentManager>();

    if let Err(e) = update_local_config_password(manager.inner(), Some(&password)) {
        warn!("Failed to store password after encryption: {e}");
    } else {
        use crate::rclone::backend::BackendManager;
        let backend_manager = app.state::<BackendManager>();
        if let Some(mut backend) = backend_manager.get("Local").await {
            backend.config_password = Some(password.clone());
            let _ = backend_manager
                .update(manager.inner(), "Local", backend)
                .await;
        }
    }

    env_manager.set_config_password(password.clone());
    unlock_rclone_config(app.clone(), password).await?;

    info!("Configuration encrypted successfully");
    Ok(())
}

#[tauri::command]
pub async fn unencrypt_config(app: AppHandle, password: String) -> Result<(), String> {
    info!("Unencrypting rclone configuration");

    run_encryption_command(&app, "remove", &password).await?;

    let manager = app.state::<AppSettingsManager>();
    let env_manager = app.state::<SafeEnvironmentManager>();

    if let Err(e) = update_local_config_password(manager.inner(), None) {
        warn!("Failed to remove stored config password: {e}");
    }

    use crate::rclone::backend::BackendManager;
    let backend_manager = app.state::<BackendManager>();
    if let Some(mut backend) = backend_manager.get("Local").await {
        backend.config_password = None;
        let _ = backend_manager
            .update(manager.inner(), "Local", backend)
            .await;
    }

    env_manager.clear_config_password();
    info!("Configuration unencrypted successfully");
    Ok(())
}

#[tauri::command]
pub async fn change_config_password(
    app: AppHandle,
    current_password: String,
    new_password: String,
) -> Result<(), String> {
    info!("Changing rclone configuration password");

    unencrypt_config(app.clone(), current_password)
        .await
        .map_err(
            |e| crate::localized_error!("backendErrors.security.decryptFailed", "error" => e),
        )?;

    encrypt_config(app.clone(), new_password).await.map_err(
        |e| crate::localized_error!("backendErrors.security.encryptFailed", "error" => e),
    )?;

    info!("Configuration password changed successfully");
    Ok(())
}
