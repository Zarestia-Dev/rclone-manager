use crate::{
    core::{
        check_binaries::build_rclone_command,
        security::{CredentialStore, SafeEnvironmentManager},
    },
    rclone::commands::unlock_rclone_config,
};
use log::{debug, error, info, warn};
use tauri::{AppHandle, Emitter, Manager, State};

/// Store the rclone config password securely
#[tauri::command]
pub async fn store_config_password(
    app: AppHandle,
    env_manager: State<'_, SafeEnvironmentManager>,
    credential_store: State<'_, CredentialStore>,
    password: String,
) -> Result<(), String> {
    info!("🔑 Storing rclone config password");

    match credential_store.store_config_password(&password) {
        Ok(()) => {
            // Set environment variable for current session using safe manager
            env_manager.set_config_password(password.clone());

            // Emit event so OAuth can restart if needed
            if let Err(e) = app.emit(
                "rclone_engine",
                serde_json::json!({ "status": "password_stored" }),
            ) {
                error!("Failed to emit password_stored event: {e}");
            }

            info!("✅ Password stored successfully");
            Ok(())
        }
        Err(e) => {
            error!("❌ Failed to store password: {:?}", e);
            Err(format!("Failed to store password: {:?}", e))
        }
    }
}

/// Retrieve the stored rclone config password
#[tauri::command]
pub async fn get_config_password(
    credential_store: State<'_, CredentialStore>,
) -> Result<String, String> {
    debug!("🔍 Retrieving stored config password");

    match credential_store.get_config_password() {
        Ok(password) => {
            debug!("✅ Password retrieved successfully");
            Ok(password)
        }
        Err(keyring::Error::NoEntry) => {
            debug!("ℹ️ No password stored");
            Err("No password stored".to_string())
        }
        Err(e) => {
            error!("❌ Failed to retrieve password: {:?}", e);
            Err(format!("Failed to retrieve password: {:?}", e))
        }
    }
}

/// Check if a config password is stored
#[tauri::command]
pub async fn has_stored_password(
    credential_store: State<'_, CredentialStore>,
) -> Result<bool, String> {
    debug!("🔍 Checking if password is stored");

    Ok(credential_store.has_config_password())
}

/// Remove the stored config password
#[tauri::command]
pub async fn remove_config_password(
    env_manager: State<'_, SafeEnvironmentManager>,
    credential_store: State<'_, CredentialStore>,
) -> Result<(), String> {
    info!("🗑️ Removing stored config password");

    match credential_store.remove_config_password() {
        Ok(()) => {
            // Clear environment variable using safe manager
            env_manager.clear_config_password();

            info!("✅ Password removed successfully");
            Ok(())
        }
        Err(e) => {
            error!("❌ Failed to remove password: {:?}", e);
            Err(format!("Failed to remove password: {:?}", e))
        }
    }
}

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
    // Emit event so other parts (engine) can react and clear any
    // startup password error state.
    if let Err(e) = app.emit(
        "rclone_engine",
        serde_json::json!({ "status": "password_stored" }),
    ) {
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

    // First try to get cached status
    if let Some(cached_status) = get_cached_encryption_status() {
        debug!("Using cached encryption status: {}", cached_status);
        return Ok(cached_status);
    }

    // If not cached, fall back to full check
    debug!("No cached status found, performing full encryption check");
    is_config_encrypted(app).await
}

#[tauri::command]
pub async fn is_config_encrypted(app: AppHandle) -> Result<bool, String> {
    debug!("🔍 Checking if rclone config is encrypted");

    // Don't use env_clear() as it removes PATH and prevents rclone from finding
    // system utilities like getent. The SafeEnvironmentManager only sets
    // RCLONE_CONFIG_PASS when explicitly configured, so we can safely inherit
    // the parent process environment here.
    let output = build_rclone_command(&app, None, None, None)
        .args(["listremotes", "--ask-password=false"])
        .output()
        .await
        .map_err(|e| format!("Failed to execute rclone: {e}"))?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    debug!("🔍 rclone stderr: {}", stderr.trim());

    // Encrypted if we get the specific decryption error message
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
    credential_store: State<'_, CredentialStore>,
    password: String,
) -> Result<(), String> {
    info!("🔐 Encrypting rclone configuration (using password-command)");

    let rclone_command = build_rclone_command(&app, None, None, None);

    // Create a cross-platform command that outputs the password
    let password_command = if cfg!(windows) {
        // Windows: Use PowerShell Write-Host with -NoNewline to avoid extra newlines
        format!(
            "powershell -Command \"Write-Host {} -NoNewline\"",
            password.replace("'", "''")
        )
    } else {
        // Unix/Linux: Use printf to avoid newlines and quote issues (no quotes)
        format!("echo \"{}\"", password)
    };

    // Use --password-command to avoid stdin password prompt issues
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
        // Store the password securely after successful encryption
        if let Err(e) = credential_store.store_config_password(&password) {
            warn!("⚠️ Failed to store password after encryption: {:?}", e);
        }

        // Set environment variable for current session using safe manager
        env_manager.set_config_password(password.clone());
        // Ensure config is unlocked for current session
        unlock_rclone_config(app.clone(), password, app.state()).await?;

        info!("✅ Configuration encrypted successfully");
        Ok(())
    } else {
        error!(
            "❌ Failed to encrypt configuration - stdout: {}, stderr: {}",
            stdout, stderr
        );
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
    password: String,
) -> Result<(), String> {
    info!("🔓 Unencrypting rclone configuration (using password-command)");

    let rclone_command = build_rclone_command(&app, None, None, None);

    // Create a cross-platform password command
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

    debug!("📤 rclone unencrypt stdout: {}", stdout);
    debug!("📤 rclone unencrypt stderr: {}", stderr);

    if output.status.success()
        || stdout.contains("Your configuration is not encrypted")
        || stderr.contains("config file is NOT encrypted")
    {
        // Remove stored password since config is no longer encrypted
        let credential_store = CredentialStore::new();
        if let Err(e) = credential_store.remove_config_password() {
            warn!(
                "⚠️ Failed to remove stored password after unencryption: {:?}",
                e
            );
        }

        // Clear environment variable using safe manager
        env_manager.clear_config_password();

        info!("✅ Configuration unencrypted successfully");
        Ok(())
    } else {
        error!(
            "❌ Failed to unencrypt configuration - stdout: {}, stderr: {}",
            stdout, stderr
        );
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

/// Change the rclone configuration password (using simple two-step approach)
#[tauri::command]
pub async fn change_config_password(
    app: AppHandle,
    env_manager: State<'_, SafeEnvironmentManager>,
    credential_store: State<'_, CredentialStore>,
    current_password: String,
    new_password: String,
) -> Result<(), String> {
    info!("🔄 Changing rclone configuration password (two-step approach)");

    // Step 1: Remove encryption with current password
    debug!("🔓 Step 1: Removing current encryption");
    unencrypt_config(app.clone(), env_manager.clone(), current_password)
        .await
        .map_err(|e| format!("Failed to remove current encryption: {}", e))?;

    // Step 2: Encrypt with new password
    debug!("🔒 Step 2: Encrypting with new password");
    encrypt_config(
        app.clone(),
        env_manager.clone(),
        credential_store.clone(),
        new_password.clone(),
    )
    .await
    .map_err(|e| format!("Failed to encrypt with new password: {}", e))?;

    // Update stored password with new password
    if let Err(e) = credential_store.store_config_password(&new_password) {
        warn!("⚠️ Failed to store new password: {:?}", e);
    }

    // Update environment variable for current session using safe manager
    env_manager.set_config_password(new_password.clone());

    info!("✅ Configuration password changed successfully");
    Ok(())
}
