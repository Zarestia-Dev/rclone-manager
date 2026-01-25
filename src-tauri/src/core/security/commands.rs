use crate::core::settings::AppSettingsManager;
use crate::utils::types::events::RCLONE_PASSWORD_STORED;
use crate::{
    core::{check_binaries::build_rclone_command, security::SafeEnvironmentManager},
    rclone::commands::system::unlock_rclone_config,
};
use log::{debug, error, info, warn};
use tauri::{AppHandle, Emitter, Manager, State};

const LOCAL_BACKEND_KEY: &str = "backend:Local:config_password";

// -----------------------------------------------------------------------------
// PASSWORD MANAGEMENT (USING RCMAN CREDENTIALS)
// These functions require the keychain feature which is only available on desktop
// -----------------------------------------------------------------------------

/// Store the rclone config password securely
#[tauri::command]
#[cfg(desktop)]
pub async fn store_config_password(
    app: AppHandle,
    env_manager: State<'_, SafeEnvironmentManager>,
    manager: State<'_, AppSettingsManager>,
    password: String,
) -> Result<(), String> {
    info!("🔑 Storing rclone config password via rcman (Unified Storage)");

    // Access credential manager (requires keychain feature)
    let credentials = manager.inner().credentials().ok_or_else(|| {
        crate::localized_error!("backendErrors.security.credentialStorageUnavailable")
    })?;

    // Store using the standardized Local backend key
    match credentials.store(LOCAL_BACKEND_KEY, &password) {
        Ok(()) => {
            // Set environment variable for current session using safe manager
            env_manager.set_config_password(password.clone());

            // Emit event so OAuth can restart if needed
            if let Err(e) = app.emit(RCLONE_PASSWORD_STORED, ()) {
                error!("Failed to emit password_stored event: {e}");
            }

            // Update BackendManager's Local instance in memory
            use crate::rclone::backend::BackendManager;
            let backend_manager = app.state::<BackendManager>();
            if let Some(mut backend) = backend_manager.get("Local").await {
                backend.config_password = Some(password.clone());
                let _ = backend_manager
                    .update(manager.inner(), "Local", backend)
                    .await;
                debug!("📝 Updated in-memory Local backend config password");
            }

            info!("✅ Password stored successfully");
            Ok(())
        }
        Err(e) => {
            error!("❌ Failed to store password: {}", e);
            Err(crate::localized_error!("backendErrors.security.storeFailed", "error" => e))
        }
    }
}

/// Store config password (mobile fallback - not supported)
#[tauri::command]
#[cfg(not(desktop))]
pub async fn store_config_password(
    _app: AppHandle,
    _env_manager: State<'_, SafeEnvironmentManager>,
    _manager: State<'_, AppSettingsManager>,
    _password: String,
) -> Result<(), String> {
    Err(crate::localized_error!(
        "backendErrors.security.credentialStorageUnavailable"
    ))
}

/// Retrieve the stored rclone config password
#[tauri::command]
#[cfg(desktop)]
pub async fn get_config_password(manager: State<'_, AppSettingsManager>) -> Result<String, String> {
    debug!("🔍 Retrieving stored config password via rcman");

    let credentials = manager.inner().credentials().ok_or_else(|| {
        crate::localized_error!("backendErrors.security.credentialStorageUnavailable")
    })?;

    // Try Unified Key first (Standard)
    if let Ok(Some(password)) = credentials.get(LOCAL_BACKEND_KEY) {
        debug!("✅ Password retrieved successfully");
        return Ok(password);
    }

    debug!("ℹ️ No password stored");
    Err(crate::localized_error!(
        "backendErrors.security.noPasswordStored"
    ))
}

#[tauri::command]
#[cfg(not(desktop))]
pub async fn get_config_password(
    _manager: State<'_, AppSettingsManager>,
) -> Result<String, String> {
    Err(crate::localized_error!(
        "backendErrors.security.credentialStorageUnavailable"
    ))
}

/// Check if a config password is stored
#[tauri::command]
#[cfg(desktop)]
pub async fn has_stored_password(manager: State<'_, AppSettingsManager>) -> Result<bool, String> {
    debug!("🔍 Checking if password is stored via rcman");

    if let Some(credentials) = manager.inner().credentials() {
        Ok(credentials.exists(LOCAL_BACKEND_KEY))
    } else {
        Ok(false)
    }
}

#[tauri::command]
#[cfg(not(desktop))]
pub async fn has_stored_password(_manager: State<'_, AppSettingsManager>) -> Result<bool, String> {
    Ok(false)
}

/// Remove the stored config password
#[tauri::command]
#[cfg(desktop)]
pub async fn remove_config_password(
    app: AppHandle,
    env_manager: State<'_, SafeEnvironmentManager>,
    manager: State<'_, AppSettingsManager>,
) -> Result<(), String> {
    info!("🗑️ Removing stored config password via rcman");

    if let Some(credentials) = manager.inner().credentials() {
        let _ = credentials.remove(LOCAL_BACKEND_KEY);

        use crate::rclone::backend::BackendManager;
        let backend_manager = app.state::<BackendManager>();

        if let Some(mut backend) = backend_manager.get("Local").await {
            backend.config_password = None;
            let _ = backend_manager
                .update(manager.inner(), "Local", backend)
                .await;
            debug!("📝 Cleared in-memory Local backend config password");
        }

        env_manager.clear_config_password();
        info!("✅ Password removed successfully");
        Ok(())
    } else {
        env_manager.clear_config_password();
        Ok(())
    }
}

#[tauri::command]
#[cfg(not(desktop))]
pub async fn remove_config_password(
    _app: AppHandle,
    env_manager: State<'_, SafeEnvironmentManager>,
    _manager: State<'_, AppSettingsManager>,
) -> Result<(), String> {
    env_manager.clear_config_password();
    Ok(())
}

// -----------------------------------------------------------------------------
// RCLONE ENCRYPTION/DECRYPTION
// -----------------------------------------------------------------------------

/// Test if a password is valid for rclone
#[tauri::command]
pub async fn validate_rclone_password(app: AppHandle, password: String) -> Result<(), String> {
    debug!("🔐 Testing rclone password");

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
        info!("✅ Password validation successful");
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        error!("❌ Password validation failed: {}", stderr);

        let error_msg = if stderr
            .contains("Couldn't decrypt configuration, most likely wrong password")
            || stderr.contains("unable to decrypt configuration")
            || stderr.contains("wrong password")
        {
            crate::localized_error!("backendErrors.security.incorrectPassword")
        } else {
            crate::localized_error!("backendErrors.security.rcloneError", "error" => stderr.trim())
        };

        Err(error_msg)
    }
}

/// Set the config password environment variable (for current session)
#[tauri::command]
pub async fn set_config_password_env(
    app: AppHandle,
    env_manager: State<'_, SafeEnvironmentManager>,
    password: String,
) -> Result<(), String> {
    debug!("🔧 Setting config password environment variable");

    env_manager.set_config_password(password);
    // Emit event so other parts (engine) can react
    if let Err(e) = app.emit(RCLONE_PASSWORD_STORED, ()) {
        error!("Failed to emit password_stored event: {e}");
    }

    debug!("✅ Environment variable set");
    Ok(())
}

/// Check if the rclone configuration is encrypted
/// Always runs a fresh check to detect external config changes
#[tauri::command]
pub async fn is_config_encrypted(app: AppHandle) -> Result<bool, String> {
    debug!("🔍 Checking if rclone config is encrypted");

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
        || (stderr.contains("Failed to load config file") && stderr.contains("unable to decrypt"));

    debug!(
        "{} Configuration is {}",
        if is_encrypted { "🔒" } else { "🔓" },
        if is_encrypted {
            "encrypted"
        } else {
            "not encrypted"
        }
    );

    Ok(is_encrypted)
}

/// Encrypt the rclone configuration with a password
#[tauri::command]
#[cfg(desktop)]
pub async fn encrypt_config(
    app: AppHandle,
    env_manager: State<'_, SafeEnvironmentManager>,
    manager: State<'_, AppSettingsManager>,
    password: String,
) -> Result<(), String> {
    info!("🔐 Encrypting rclone configuration (using password-command)");

    use crate::rclone::backend::BackendManager;
    let backend_manager = app.state::<BackendManager>();
    let config_path = backend_manager.get_local_config_path().await.map_err(
        |e| crate::localized_error!("backendErrors.rclone.executionFailed", "error" => e),
    )?;

    let rclone_command = build_rclone_command(&app, None, config_path.as_deref(), None);

    // Create a cross-platform command that outputs the password
    let password_command = if cfg!(windows) {
        format!(
            "powershell -Command \"Write-Host {} -NoNewline\"",
            password.replace("'", "''")
        )
    } else {
        format!("echo \"{}\"", password)
    };

    let output = rclone_command
        .args([
            "config",
            "encryption",
            "set",
            "--password-command",
            &password_command,
        ])
        .output()
        .await
        .map_err(
            |e| crate::localized_error!("backendErrors.rclone.executionFailed", "error" => e),
        )?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    debug!("📤 rclone config encryption set stdout: {}", stdout);
    debug!("📤 rclone config encryption set stderr: {}", stderr);

    if output.status.success()
        || stdout.contains("Password set")
        || stdout.contains("Your configuration is encrypted")
    {
        // Store the password securely after successful encryption using rcman
        if let Some(credentials) = manager.inner().credentials()
            && let Err(e) = credentials.store(LOCAL_BACKEND_KEY, &password)
        {
            warn!(
                "⚠️ Failed to store password after encryption via rcman: {}",
                e
            );
        } else {
            // Update BackendManager in memory
            if let Some(mut backend) = backend_manager.get("Local").await {
                backend.config_password = Some(password.clone());
                let _ = backend_manager
                    .update(manager.inner(), "Local", backend)
                    .await;
            }
        }

        // Set environment variable for current session
        env_manager.set_config_password(password.clone());
        // Ensure config is unlocked for current session
        unlock_rclone_config(app.clone(), password).await?;

        info!("✅ Configuration encrypted successfully");
        Ok(())
    } else {
        let err_detail = if !stderr.trim().is_empty() {
            stderr.to_string()
        } else {
            stdout.to_string()
        };
        Err(crate::localized_error!("backendErrors.security.encryptFailed", "error" => err_detail))
    }
}

#[tauri::command]
#[cfg(not(desktop))]
pub async fn encrypt_config(
    _app: AppHandle,
    _env_manager: State<'_, SafeEnvironmentManager>,
    _manager: State<'_, AppSettingsManager>,
    _password: String,
) -> Result<(), String> {
    Err(crate::localized_error!(
        "backendErrors.security.encryptionUnavailable"
    ))
}

/// Unencrypt (decrypt) the rclone configuration
#[tauri::command]
#[cfg(desktop)]
pub async fn unencrypt_config(
    app: AppHandle,
    env_manager: State<'_, SafeEnvironmentManager>,
    manager: State<'_, AppSettingsManager>,
    password: String,
) -> Result<(), String> {
    info!("🔓 Unencrypting rclone configuration");

    use crate::rclone::backend::BackendManager;
    let backend_manager = app.state::<BackendManager>();
    let config_path = backend_manager.get_local_config_path().await.map_err(
        |e| crate::localized_error!("backendErrors.rclone.executionFailed", "error" => e),
    )?;

    let rclone_command = build_rclone_command(&app, None, config_path.as_deref(), None);

    let password_command = if cfg!(windows) {
        format!(
            "powershell -Command \"Write-Host {} -NoNewline\"",
            password.replace("'", "''")
        )
    } else {
        format!("echo \"{}\"", password)
    };

    let output = rclone_command
        .args([
            "config",
            "encryption",
            "remove",
            "--password-command",
            &password_command,
        ])
        .output()
        .await
        .map_err(
            |e| crate::localized_error!("backendErrors.rclone.executionFailed", "error" => e),
        )?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if output.status.success()
        || stdout.contains("Your configuration is not encrypted")
        || stderr.contains("config file is NOT encrypted")
    {
        // Remove stored password since config is no longer encrypted
        if let Some(credentials) = manager.inner().credentials() {
            let _ = credentials.remove(LOCAL_BACKEND_KEY);

            // Update BackendManager in memory
            if let Some(mut backend) = backend_manager.get("Local").await {
                backend.config_password = None;
                let _ = backend_manager
                    .update(manager.inner(), "Local", backend)
                    .await;
            }
        }

        env_manager.clear_config_password();
        info!("✅ Configuration unencrypted successfully");
        Ok(())
    } else {
        let err_detail = if !stderr.trim().is_empty() {
            stderr.to_string()
        } else {
            stdout.to_string()
        };
        Err(crate::localized_error!("backendErrors.security.decryptFailed", "error" => err_detail))
    }
}

#[tauri::command]
#[cfg(not(desktop))]
pub async fn unencrypt_config(
    _app: AppHandle,
    _env_manager: State<'_, SafeEnvironmentManager>,
    _manager: State<'_, AppSettingsManager>,
    _password: String,
) -> Result<(), String> {
    Err(crate::localized_error!(
        "backendErrors.security.decryptionUnavailable"
    ))
}

/// Change the rclone configuration password
#[tauri::command]
#[cfg(desktop)]
pub async fn change_config_password(
    app: AppHandle,
    env_manager: State<'_, SafeEnvironmentManager>,
    manager: State<'_, AppSettingsManager>,
    current_password: String,
    new_password: String,
) -> Result<(), String> {
    info!("🔄 Changing rclone configuration password");

    // Step 1: Remove encryption with current password
    debug!("🔓 Step 1: Removing current encryption");
    unencrypt_config(
        app.clone(),
        env_manager.clone(),
        manager.clone(),
        current_password,
    )
    .await
    .map_err(|e| crate::localized_error!("backendErrors.security.decryptFailed", "error" => e))?;

    // Step 2: Encrypt with new password
    debug!("🔒 Step 2: Encrypting with new password");
    encrypt_config(
        app.clone(),
        env_manager.clone(),
        manager.clone(),
        new_password.clone(),
    )
    .await
    .map_err(|e| crate::localized_error!("backendErrors.security.encryptFailed", "error" => e))?;

    // Explicitly update stored password
    // (encrypt_config does this, but being explicit doesn't hurt)

    // Update environment variable for current session
    env_manager.set_config_password(new_password.clone());

    info!("✅ Configuration password changed successfully");
    Ok(())
}

#[tauri::command]
#[cfg(not(desktop))]
pub async fn change_config_password(
    _app: AppHandle,
    _env_manager: State<'_, SafeEnvironmentManager>,
    _manager: State<'_, AppSettingsManager>,
    _current_password: String,
    _new_password: String,
) -> Result<(), String> {
    Err(crate::localized_error!(
        "backendErrors.security.passwordChangeUnavailable"
    ))
}
