use std::path::PathBuf;

use log::{debug, error, info};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

use crate::utils::types::all_types::RcloneState;

#[tauri::command]
pub fn is_7z_available() -> bool {
    // Check standard executable names in PATH
    if which::which("7z").is_ok()
        || which::which("7za").is_ok()
        || which::which("7z.exe").is_ok()
        || which::which("7za.exe").is_ok()
    {
        return true;
    }

    // Windows-specific checks
    #[cfg(target_os = "windows")]
    {
        use shellexpand;
        use std::path::Path;

        // Check common installation paths
        let common_paths = [
            // Program Files locations
            "C:\\Program Files\\7-Zip\\7z.exe",
            "C:\\Program Files (x86)\\7-Zip\\7z.exe",
            // Portable/Scoop/chocolatey install locations
            "C:\\tools\\7zip\\7z.exe",
            "~\\scoop\\apps\\7zip\\current\\7z.exe",
            "~\\AppData\\Local\\Programs\\7-Zip\\7z.exe",
        ];

        for path in common_paths.iter() {
            let expanded_path = shellexpand::tilde(path).to_string();
            if Path::new(&expanded_path).exists() {
                return true;
            }

            // // Check registry for install location
            // if let Ok(install_path) = get_7zip_path_from_registry() {
            //     if Path::new(&install_path).exists() {
            //         return true;
            //     }
            // }
        }
    }

    false
}

// #[cfg(target_os = "windows")]
// fn get_7zip_path_from_registry() -> Result<String, Box<dyn std::error::Error>> {
//     use winreg::enums::*;
//     use winreg::RegKey;

//     let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
//     let path = hklm.open_subkey("SOFTWARE\\7-Zip")?
//         .get_value::<String, _>("Path")?;

//     Ok(format!("{}\\7z.exe", path))
// }

/// Internal helper that borrows the `AppHandle` so Rust call-sites don't need to clone it.
#[tauri::command]
pub async fn check_rclone_available(app: AppHandle, path: &str) -> Result<bool, String> {
    let rclone_path = if !path.is_empty() {
        // Use the explicit path if provided
        get_rclone_binary_path(&PathBuf::from(path))
    } else {
        // Read the configured path from app state
        read_rclone_path(&app)
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
    // the application state's configured rclone_config_file (if set).
    if let Some(cfg) = config_override {
        if !cfg.is_empty() {
            cmd = cmd.arg("--config").arg(cfg);
        }
    } else {
        let rclone_state = app.state::<RcloneState>();
        let cfg = rclone_state.rclone_config_file.read().unwrap().clone();
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
    let rclone_state = app.state::<RcloneState>();
    let configured_base_path = rclone_state.rclone_path.read().unwrap().clone();
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
