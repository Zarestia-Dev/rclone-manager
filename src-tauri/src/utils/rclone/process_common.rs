use log::{error, info, warn};
use serde_json::json;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::core::security::CredentialStore;

/// Common password error patterns used by both main engine and OAuth processes
pub const PASSWORD_ERROR_PATTERNS: [&str; 6] = [
    "most likely wrong password",
    "Couldn't decrypt configuration",
    "Enter configuration password",
    "Failed to read line: EOF",
    "password required",
    "configuration is encrypted",
];

/// Check if a stderr line indicates a password error
pub fn is_password_error(line: &str) -> bool {
    let line_lower = line.to_lowercase();
    PASSWORD_ERROR_PATTERNS
        .iter()
        .any(|pattern| line_lower.contains(&pattern.to_lowercase()))
}

/// Setup environment variables for rclone processes (main engine or OAuth)
pub fn setup_rclone_environment(
    _app: &AppHandle,
    _command: &mut std::process::Command,
    process_type: &str,
) -> Result<(), String> {
    let credential_store = CredentialStore::new();

    if let Ok(_password) = credential_store.get_config_password() {
        info!(
            "🔑 Password found in keychain for {} — using RC runtime unlock, not env",
            process_type
        );
        // Do not set RCLONE_CONFIG_PASS. Unlock is handled via RC API at runtime.
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
    command.stderr(Stdio::piped()); // Capture stderr for monitoring

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

/// Monitor stderr for password errors and emit events
pub fn spawn_stderr_monitor(
    mut child: Child,
    app: AppHandle,
    event_name: &str,
    process_type: &str,
) -> Child {
    if let Some(stderr) = child.stderr.take() {
        let app_handle = app.clone();
        let event_name = event_name.to_string();
        let process_type = process_type.to_string();

        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            // Monitor behavior:
            // - Engine: monitor for the lifetime of the process (no timeout)
            // - Others (e.g., OAuth): monitor for a limited time to catch early startup issues
            let start_time = Instant::now();
            let monitor_timeout = if process_type == "Engine" {
                None
            } else {
                Some(Duration::from_secs(30))
            };

            for line in reader.lines().map_while(Result::ok) {
                if monitor_timeout.is_some_and(|timeout| start_time.elapsed() > timeout) {
                    info!(
                        "⏰ Stopping {} stderr monitoring after timeout",
                        process_type
                    );
                    break;
                }

                error!("🔍 Rclone {} stderr: {}", process_type, line);

                // Check for password errors
                if is_password_error(&line) {
                    error!("🔑 {} password error detected: {}", process_type, line);

                    // Clear the wrong password from storage
                    let credential_store = CredentialStore::new();
                    if let Err(e) = credential_store.remove_config_password() {
                        warn!("⚠️ Failed to clear wrong password from storage: {}", e);
                    } else {
                        info!("🧹 Cleared wrong password from storage");
                    }

                    // Clear from environment manager too
                    // Nothing to clear; runtime unlock is used instead

                    // Mark engine state if this is the main engine
                    if process_type == "Engine" {
                        use crate::utils::types::all_types::RcApiEngine;
                        if let Ok(mut engine) = RcApiEngine::lock_engine() {
                            engine.password_error_detected = true;
                            engine.running = false;
                        }
                    }

                    // Emit structured password error event to frontend
                    let _ = app_handle.emit(
                        &event_name,
                        json!({
                            "status": "error",
                            "message": line,
                            "error_type": "password_required",
                            "source": format!("{}_stderr_monitor", process_type.to_lowercase())
                        }),
                    );

                    break;
                }
            }
        });
    }

    child
}

/// Emit spawn error event
pub fn emit_spawn_error(app: &AppHandle, event_name: &str, error_msg: &str) {
    error!("❌ {}", error_msg);

    let _ = app.emit(
        event_name,
        json!({
            "status": "error",
            "message": error_msg,
            "error_type": "spawn_failed"
        }),
    );
}

/// Emit success event
pub fn emit_success(app: &AppHandle, event_name: &str, message: &str) {
    info!("✅ {}", message);

    let _ = app.emit(
        event_name,
        json!({
            "status": "success",
            "message": message,
            "error_type": null
        }),
    );
}

/// Emit timeout error event
pub fn emit_timeout_error(app: &AppHandle, event_name: &str, error_msg: &str) {
    error!("❌ {}", error_msg);

    let _ = app.emit(
        event_name,
        json!({
            "status": "error",
            "message": error_msg,
            "error_type": "startup_timeout"
        }),
    );
}
