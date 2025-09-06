use log::info;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::core::security::{CredentialStore, SafeEnvironmentManager};

/// Setup environment variables for rclone processes (main engine or OAuth)
pub fn setup_rclone_environment(
    app: &AppHandle,
    command: &mut std::process::Command,
    process_type: &str,
) -> Result<(), String> {
    // Try to get password from SafeEnvironmentManager first (GUI context)
    if let Some(env_manager) = app.try_state::<SafeEnvironmentManager>() {
        let env_vars = env_manager.get_env_vars();
        if !env_vars.is_empty() {
            info!(
                "🔑 Using environment manager password for {} process",
                process_type
            );
            for (key, value) in env_vars {
                command.env(key, value);
            }
            return Ok(());
        }
    }

    // Fallback to credential store if no password in environment manager
    let credential_store = CredentialStore::new();
    if let Ok(password) = credential_store.get_config_password() {
        info!(
            "🔑 Using stored rclone config password for {} process",
            process_type
        );
        command.env("RCLONE_CONFIG_PASS", password);
    } else {
        info!("ℹ️ No stored password found for {} process", process_type);
    }

    Ok(())
}

/// Create and configure a new rclone command with standard settings
pub fn create_rclone_command(
    rclone_path: &str,
    port: u16,
    app: &AppHandle,
    process_type: &str,
) -> Result<Command, String> {
    let mut command = Command::new(rclone_path);

    // Standard rclone daemon arguments
    command.args([
        "rcd",
        "--rc-no-auth",
        "--rc-serve",
        &format!("--rc-addr=127.0.0.1:{}", port),
    ]);

    // Configure stdio
    command.stdout(Stdio::null());
    command.stderr(Stdio::null());

    // Set up environment variables
    setup_rclone_environment(app, &mut command, process_type)?;

    // Windows-specific console window handling
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000 | 0x00200000);
    }

    Ok(command)
}
