use std::path::PathBuf;

use log::{debug, error, info};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

/// Internal helper that borrows the `AppHandle` so Rust call-sites don't need to clone it.
/// Returns Ok(true) if rclone is available, Ok(false) if not found.
/// Emits RCLONE_ENGINE_PATH_ERROR event when binary is missing.
#[tauri::command]
pub async fn check_rclone_available(app: AppHandle, path: &str) -> Result<bool, String> {
    check_rclone_available_internal(&app, path, true).await
}

/// Internal version that optionally emits events
async fn check_rclone_available_internal(
    app: &AppHandle,
    path: &str,
    emit_event: bool,
) -> Result<bool, String> {
    let rclone_path = if !path.is_empty() {
        // Use the explicit path if provided
        get_rclone_binary_path(&PathBuf::from(path))
    } else {
        // Read the configured path from app state
        read_rclone_path(app)
    };

    debug!(
        "Checking rclone availability at path: {}",
        rclone_path.display()
    );

    // Check if the path exists and can execute --version
    if rclone_path.exists() {
        match app
            .shell()
            .command(rclone_path.to_string_lossy().to_string())
            .arg("--version")
            .output()
            .await
        {
            Ok(output) => Ok(output.status.success()),
            Err(e) => Err(format!("Failed to execute rclone: {}", e)),
        }
    } else {
        if emit_event {
            use crate::utils::types::events::RCLONE_ENGINE_PATH_ERROR;
            use tauri::Emitter;

            if let Err(e) = app.emit(RCLONE_ENGINE_PATH_ERROR, ()) {
                error!("Failed to emit path error event: {e}");
            }
        }
        Err(format!(
            "Rclone binary not found at {}",
            rclone_path.display()
        ))
    }
}

pub fn build_rclone_command(
    app: &AppHandle,
    bin_override: Option<&str>,
    config_override: Option<&str>,
    args: Option<&[&str]>,
) -> tauri_plugin_shell::process::Command {
    // Determine binary path
    let binary_path = if let Some(b) = bin_override {
        if !b.is_empty() {
            get_rclone_binary_path(&PathBuf::from(b))
        } else {
            read_rclone_path(app)
        }
    } else {
        read_rclone_path(app)
    };

    let mut cmd = app
        .shell()
        .command(binary_path.to_string_lossy().to_string());

    // Determine config file: explicit override takes precedence, otherwise use
    // the application settings' rclone_config_file (if set).
    if let Some(cfg) = config_override {
        if !cfg.is_empty() {
            cmd = cmd.arg("--config").arg(cfg);
        }
    } else {
        // Read from settings manager which caches internally
        let cfg: String = app
            .try_state::<rcman::JsonSettingsManager>()
            .and_then(|manager| manager.inner().get("core.rclone_config_file").ok())
            .unwrap_or_default();
        if !cfg.is_empty() {
            cmd = cmd.arg("--config").arg(cfg);
        }
    }

    // Append any remaining args
    if let Some(a) = args
        && !a.is_empty()
    {
        cmd = cmd.args(a);
    }

    cmd
}

pub fn get_rclone_binary_path(base_path: &std::path::Path) -> PathBuf {
    let bin = if cfg!(windows) {
        "rclone.exe"
    } else {
        "rclone"
    };
    base_path.join(bin)
}

pub fn read_rclone_path(app: &AppHandle) -> PathBuf {
    // Read from settings manager which caches internally
    let configured_base_path: PathBuf = app
        .try_state::<rcman::JsonSettingsManager>()
        .and_then(|manager| {
            manager
                .inner()
                .get::<String>("core.rclone_path")
                .ok()
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| PathBuf::from("system"));

    debug!(
        "🔄 Reading configured rclone base path: {}",
        configured_base_path.to_string_lossy()
    );

    // 1. **PRIORITY**: Check for a valid, user-configured rclone binary.
    // We only proceed if the path is not the special "system" keyword.
    if configured_base_path.to_string_lossy() != "system" {
        let configured_binary_path = get_rclone_binary_path(&configured_base_path);

        // If the binary exists at the configured path, we use it immediately.
        if configured_binary_path.exists() {
            debug!(
                "✅ Using user-configured rclone binary at {}",
                configured_binary_path.display()
            );
            return configured_binary_path;
        } else {
            debug!(
                "⚠️ Configured rclone binary not found at {}. Falling back to system PATH.",
                configured_binary_path.display()
            );
        }
    }

    // 2. **FALLBACK**: If no valid configured path was found, search the system PATH.
    debug!("🔍 Searching for rclone in system PATH...");
    match which::which("rclone") {
        Ok(system_path) => {
            info!(
                "✅ Found and using system-installed rclone at {}",
                system_path.display()
            );
            system_path
        }
        Err(_) => {
            error!(
                "❌ Rclone binary not found. Neither the configured path is valid nor is it in the system PATH."
            );
            // Return a generic path. The subsequent command execution will fail with a clearer error to the user.
            PathBuf::from("rclone")
        }
    }
}
