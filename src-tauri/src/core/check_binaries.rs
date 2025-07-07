use std::{path::PathBuf, process::Command};

use log::{debug, error, info};
use tauri::{AppHandle, Manager};

use crate::utils::types::RcloneState;

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

pub fn read_rclone_path(app: &AppHandle) -> PathBuf {
    // Get the rclone path from app state
    let rclone_state = app.state::<RcloneState>();
    let rclone_path = rclone_state.rclone_path.read().unwrap().clone();
    debug!("🔄 Reading rclone path: {}", rclone_path.to_string_lossy());

    // First try the configured path
    if rclone_path.to_string_lossy() != "system" {
        let bin = if cfg!(windows) {
            "rclone.exe"
        } else {
            "rclone"
        };
        let configured_path = rclone_path.join(bin);

        if configured_path.exists() {
            debug!(
                "🔄 Using configured rclone at {}",
                configured_path.display()
            );
            return configured_path;
        }
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
            error!(
                "❌ No valid Rclone binary found - neither configured path nor system rclone available"
            );
            PathBuf::from("rclone") // Return generic path (will fail later with proper error)
        }
    }
}
