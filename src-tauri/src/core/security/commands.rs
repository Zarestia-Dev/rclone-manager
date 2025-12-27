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
// -----------------------------------------------------------------------------

/// Store the rclone config password securely
#[tauri::command]
pub async fn store_config_password(
    app: AppHandle,
    env_manager: State<'_, SafeEnvironmentManager>,
    manager: State<'_, rcman::SettingsManager<rcman::JsonStorage>>,
    password: String,
) -> Result<(), String> {
    info!("🔑 Storing rclone config password via rcman (Unified Storage)");

    // Access credential manager (requires keychain feature)
    let credentials = manager.inner().credentials().ok_or_else(|| {
        "Credential storage not available (keychain feature disabled)".to_string()
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
            if let Some(mut backend) = crate::rclone::backend::BACKEND_MANAGER.get("Local").await {
                backend.config_password = Some(password.clone());
                let _ = crate::rclone::backend::BACKEND_MANAGER
                    .update("Local", backend)
                    .await;
                debug!("📝 Updated in-memory Local backend config password");
            }

            info!("✅ Password stored successfully");
            Ok(())
        }
        Err(e) => {
            error!("❌ Failed to store password: {}", e);
            Err(format!("Failed to store password: {}", e))
        }
    }
}

/// Retrieve the stored rclone config password
#[tauri::command]
pub async fn get_config_password(
    manager: State<'_, rcman::SettingsManager<rcman::JsonStorage>>,
) -> Result<String, String> {
    debug!("🔍 Retrieving stored config password via rcman");

    let credentials = manager
        .inner()
        .credentials()
        .ok_or_else(|| "Credential storage not available".to_string())?;

    // Try Unified Key first (Standard)
    if let Ok(Some(password)) = credentials.get(LOCAL_BACKEND_KEY) {
        debug!("✅ Password retrieved successfully");
        return Ok(password);
    }

    debug!("ℹ️ No password stored");
    Err("No password stored".to_string())
}

/// Check if a config password is stored
#[tauri::command]
pub async fn has_stored_password(
    manager: State<'_, rcman::SettingsManager<rcman::JsonStorage>>,
) -> Result<bool, String> {
    debug!("🔍 Checking if password is stored via rcman");

    if let Some(credentials) = manager.inner().credentials() {
        // Check both keys
        Ok(credentials.exists(LOCAL_BACKEND_KEY))
    } else {
        Ok(false)
    }
}

/// Remove the stored config password
#[tauri::command]
pub async fn remove_config_password(
    env_manager: State<'_, SafeEnvironmentManager>,
    manager: State<'_, rcman::SettingsManager<rcman::JsonStorage>>,
) -> Result<(), String> {
    info!("🗑️ Removing stored config password via rcman");

    if let Some(credentials) = manager.inner().credentials() {
        // Remove key to ensure full cleanup
        let _ = credentials.remove(LOCAL_BACKEND_KEY);

        // Update BackendManager's Local instance in memory
        if let Some(mut backend) = crate::rclone::backend::BACKEND_MANAGER.get("Local").await {
            backend.config_password = None;
            let _ = crate::rclone::backend::BACKEND_MANAGER
                .update("Local", backend)
                .await;
            debug!("📝 Cleared in-memory Local backend config password");
        }

        // Clear environment variable using safe manager
        env_manager.clear_config_password();
        info!("✅ Password removed successfully");
        Ok(())
    } else {
        // If no credential manager, just clear env
        env_manager.clear_config_password();
        Ok(())
    }
}

// -----------------------------------------------------------------------------
// RCLONE ENCRYPTION/DECRYPTION
// -----------------------------------------------------------------------------

/// Test if a password is valid for rclone
#[tauri::command]
pub async fn validate_rclone_password(app: AppHandle, password: String) -> Result<(), String> {
    debug!("🔐 Testing rclone password");

    if password.trim().is_empty() {
        return Err("Password cannot be empty".to_string());
    }

    let output = build_rclone_command(&app, None, None, None)
        .args(["listremotes", "--ask-password=false"])
        .env("RCLONE_CONFIG_PASS", &password)
        .output()
        .await
        .map_err(|e| format!("Failed to execute rclone: {}", e))?;

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
            "Incorrect password for rclone configuration".to_string()
        } else {
            format!("Rclone error: {}", stderr.trim())
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

/// Clear the config password environment variable
#[tauri::command]
pub async fn clear_config_password_env(
    env_manager: State<'_, SafeEnvironmentManager>,
) -> Result<(), String> {
    debug!("🧹 Clearing config password environment variable");
    env_manager.clear_config_password();
    debug!("✅ Environment variable cleared");
    Ok(())
}

/// Check if config password environment variable is set
#[tauri::command]
pub async fn has_config_password_env(
    env_manager: State<'_, SafeEnvironmentManager>,
) -> Result<bool, String> {
    debug!("🔍 Checking config password environment variable");
    Ok(env_manager.has_config_password())
}

/// Check if the rclone configuration is encrypted
/// Get cached encryption status if available (faster, no I/O)
#[tauri::command]
pub fn get_cached_encryption_status() -> Option<bool> {
    use crate::utils::rclone::process_common::get_cached_encryption_status;
    debug!("⚡ Getting cached encryption status");
    get_cached_encryption_status()
}

/// Clear cached encryption status (e.g., when config changes)
#[tauri::command]
pub fn clear_encryption_cache() {
    use crate::utils::rclone::process_common::clear_encryption_cache;
    debug!("🗑️ Clearing encryption cache");
    clear_encryption_cache();
}

/// Check if config is encrypted (with caching for performance)
#[tauri::command]
pub async fn is_config_encrypted_cached(app: AppHandle) -> Result<bool, String> {
    use crate::utils::rclone::process_common::get_cached_encryption_status;

    debug!("🚀 Checking config encryption with cache");

    if let Some(cached_status) = get_cached_encryption_status() {
        debug!("Using cached encryption status: {}", cached_status);
        return Ok(cached_status);
    }

    debug!("No cached status found, performing full encryption check");
    is_config_encrypted(app).await
}

#[tauri::command]
pub async fn is_config_encrypted(app: AppHandle) -> Result<bool, String> {
    debug!("🔍 Checking if rclone config is encrypted");

    let output = build_rclone_command(&app, None, None, None)
        .args(["listremotes", "--ask-password=false"])
        .output()
        .await
        .map_err(|e| format!("Failed to execute rclone: {e}"))?;

    let stderr = String::from_utf8_lossy(&output.stderr);

    let is_encrypted =
        stderr.contains("unable to decrypt configuration and not allowed to ask for password");

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
pub async fn encrypt_config(
    app: AppHandle,
    env_manager: State<'_, SafeEnvironmentManager>,
    manager: State<'_, rcman::SettingsManager<rcman::JsonStorage>>,
    password: String,
) -> Result<(), String> {
    info!("🔐 Encrypting rclone configuration (using password-command)");

    let rclone_command = build_rclone_command(&app, None, None, None);

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
        .map_err(|e| format!("Failed to execute rclone config encryption set: {e}"))?;

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
            if let Some(mut backend) = crate::rclone::backend::BACKEND_MANAGER.get("Local").await {
                backend.config_password = Some(password.clone());
                let _ = crate::rclone::backend::BACKEND_MANAGER
                    .update("Local", backend)
                    .await;
            }
        }

        // Set environment variable for current session
        env_manager.set_config_password(password.clone());
        // Ensure config is unlocked for current session
        unlock_rclone_config(app.clone(), password, app.state()).await?;

        info!("✅ Configuration encrypted successfully");
        Ok(())
    } else {
        error!("❌ Failed to encrypt configuration");
        Err(format!(
            "Failed to encrypt configuration: {}",
            if !stderr.trim().is_empty() {
                stderr
            } else {
                stdout
            }
        ))
    }
}

/// Unencrypt (decrypt) the rclone configuration
#[tauri::command]
pub async fn unencrypt_config(
    app: AppHandle,
    env_manager: State<'_, SafeEnvironmentManager>,
    manager: State<'_, rcman::SettingsManager<rcman::JsonStorage>>,
    password: String,
) -> Result<(), String> {
    info!("🔓 Unencrypting rclone configuration");

    let rclone_command = build_rclone_command(&app, None, None, None);

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
        .map_err(|e| format!("Failed to execute rclone config encryption remove: {e}"))?;

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
            if let Some(mut backend) = crate::rclone::backend::BACKEND_MANAGER.get("Local").await {
                backend.config_password = None;
                let _ = crate::rclone::backend::BACKEND_MANAGER
                    .update("Local", backend)
                    .await;
            }
        }

        env_manager.clear_config_password();
        info!("✅ Configuration unencrypted successfully");
        Ok(())
    } else {
        error!("❌ Failed to unencrypt configuration");
        Err(format!(
            "Failed to unencrypt configuration: {}",
            if !stderr.trim().is_empty() {
                stderr
            } else {
                stdout
            }
        ))
    }
}

/// Change the rclone configuration password
#[tauri::command]
pub async fn change_config_password(
    app: AppHandle,
    env_manager: State<'_, SafeEnvironmentManager>,
    manager: State<'_, rcman::SettingsManager<rcman::JsonStorage>>,
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
    .map_err(|e| format!("Failed to remove current encryption: {e}"))?;

    // Step 2: Encrypt with new password
    debug!("🔒 Step 2: Encrypting with new password");
    encrypt_config(
        app.clone(),
        env_manager.clone(),
        manager.clone(),
        new_password.clone(),
    )
    .await
    .map_err(|e| format!("Failed to encrypt with new password: {e}"))?;

    // Explicitly update stored password
    // (encrypt_config does this, but being explicit doesn't hurt)

    // Update environment variable for current session
    env_manager.set_config_password(new_password.clone());

    info!("✅ Configuration password changed successfully");
    Ok(())
}
