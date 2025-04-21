use std::{path::PathBuf, process::Command};

use log::{error, info};
use serde_json::Value;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn is_7z_available() -> bool {
    which::which("7z").is_ok() || which::which("7za").is_ok()
}

#[tauri::command]
pub fn is_rclone_available(app: AppHandle) -> bool {
    // Try configured path if app is provided
    let rclone_path = read_rclone_path(&app);
    if rclone_path.exists() {
        // Try to launch rclone --version
        if Command::new(&rclone_path)
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            return true;
        }
    }

    // Fallback: check system PATH
    which::which("rclone").is_ok()
}

fn core_config_path(app: &AppHandle) -> PathBuf {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .expect("Failed to get app data dir");
    app_data_dir.join("core.json")
}

pub fn read_rclone_path(app: &AppHandle) -> PathBuf {
    let config_path = core_config_path(app);

    // Try to read the configured path
    let configured_path = match std::fs::read_to_string(&config_path) {
        Ok(contents) => {
            if let Ok(json) = serde_json::from_str::<Value>(&contents) {
                if let Some(path) = json["core_options"]["rclone_path"].as_str() {
                    if path == "system" {
                        PathBuf::from("rclone") // System-wide installation
                    } else {
                        let bin = if cfg!(windows) {
                            "rclone.exe"
                        } else {
                            "rclone"
                        };
                        PathBuf::from(path).join(bin)
                    }
                } else {
                    PathBuf::from("rclone") // Default to system-wide
                }
            } else {
                PathBuf::from("rclone") // Default to system-wide
            }
        }
        Err(_) => PathBuf::from("rclone"),
    };

    // Check if the configured path exists and is runnable
    if configured_path.exists()
        && Command::new(&configured_path)
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    {
        return configured_path;
    }

    // Fallback: try to find rclone in PATH
    match which::which("rclone") {
        Ok(system_path) => {
            info!(
                "🔄 Using system-installed rclone at {}",
                system_path.display()
            );
            system_path
        }
        Err(_) => {
            error!("❌ No valid Rclone binary found - neither configured path nor system rclone available");
            configured_path // Return the original path anyway (will fail later with proper error)
        }
    }
}
