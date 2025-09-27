use log::debug;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

use tauri::{Emitter, State};

use crate::RcloneState;

#[cfg(target_os = "macos")]
/// Checks for the presence of any compatible FUSE implementation on macOS.
/// Returns `Ok(detected_implementation_name)` if found, or `Err(` if none are found.
fn check_fuse_installed() -> bool {
    // Check for FUSE-T (the preferred implementation)
    let fuse_t_app_support = PathBuf::from("/Library/Application Support/fuse-t").exists();
    let fuse_t_framework = PathBuf::from("/Library/Frameworks/FuseT.framework").exists();
    let fuse_t_bin = PathBuf::from("/usr/local/bin/mount_fuse-t").exists();
    let fuse_t_exists = fuse_t_app_support || fuse_t_framework || fuse_t_bin;

    // Check for MacFUSE (a common alternative)
    let macfuse_pkg_receipt = PathBuf::from("/Library/Receipts/MacFUSE.pkg").exists();
    let macfuse_core = PathBuf::from("/Library/Filesystems/macfuse.fs").exists();
    let macfuse_bin = PathBuf::from("/usr/local/bin/mount_macfuse").exists();
    let macfuse_exists = macfuse_pkg_receipt || macfuse_core || macfuse_bin;

    match (fuse_t_exists, macfuse_exists) {
        (true, _) => {
            debug!("macOS: FUSE-T installation detected");
            true
        }
        (_, true) => {
            debug!("macOS: MacFUSE installation detected");
            // MacFUSE was found. We will consider the system OK for now
            // but might want to inform the user about preferred driver later.
            true
        }
        _ => {
            debug!("macOS: No compatible FUSE installation found (Checked for FUSE-T and MacFUSE)");
            false
        }
    }
}

#[cfg(target_os = "linux")]
fn check_mount_plugin_installed_linux() -> bool {
    // Linux does not require a mount plugin, always return true
    true
}

#[cfg(target_os = "windows")]
fn check_winfsp_installed() -> bool {
    // Check multiple potential installation paths
    let possible_paths = [
        "C:\\Program Files\\WinFsp",
        "C:\\Program Files (x86)\\WinFsp",
        // Also check for the driver files that indicate WinFsp is actually installed
        "C:\\Windows\\System32\\drivers\\winfsp.sys",
    ];

    let mut winfsp_exists = false;
    for path in &possible_paths {
        if PathBuf::from(path).exists() {
            winfsp_exists = true;
            debug!("Windows: WinFsp found at: {}", path);
            break;
        }
    }

    // Additional check: try to query WinFsp service status
    if !winfsp_exists {
        // Check if WinFsp service is installed (indicates proper installation)
        if let Ok(output) = std::process::Command::new("sc")
            .args(["query", "WinFsp.Launcher"])
            .output()
            && output.status.success()
        {
            let output_str = String::from_utf8_lossy(&output.stdout);
            if output_str.contains("WinFsp.Launcher") {
                winfsp_exists = true;
                debug!("Windows: WinFsp service found via sc query");
            }
        }
    }

    debug!("Windows: WinFsp installed: {}", winfsp_exists);
    winfsp_exists
}

/// Checks if the required mount plugin is installed for the current platform.
#[tauri::command]
pub fn check_mount_plugin_installed() -> bool {
    #[cfg(target_os = "macos")]
    {
        check_fuse_installed()
    }
    #[cfg(target_os = "linux")]
    {
        check_mount_plugin_installed_linux()
    }
    #[cfg(target_os = "windows")]
    {
        check_winfsp_installed()
    }
}

#[tauri::command]
pub async fn install_mount_plugin(
    window: tauri::Window,
    state: State<'_, RcloneState>,
) -> Result<String, String> {
    let download_path = std::env::temp_dir().join("rclone_temp");

    // Ensure download directory exists
    if let Err(e) = std::fs::create_dir_all(&download_path) {
        return Err(format!("Failed to create download directory: {e}"));
    }

    let (url, local_file, _install_command) = if cfg!(target_os = "macos") {
        (
            "https://github.com/macos-fuse-t/fuse-t/releases/download/1.0.44/fuse-t-macos-installer-1.0.44.pkg",
            download_path.join("fuse-t-installer.pkg"),
            format!(
                "sudo installer -pkg {} -target /",
                download_path.join("fuse-t-installer.pkg").display()
            ),
        )
    } else {
        (
            "https://github.com/winfsp/winfsp/releases/download/v2.0/winfsp-2.0.23075.msi",
            download_path.join("winfsp-installer.msi"),
            format!(
                "msiexec /i {} /quiet /norestart",
                download_path.join("winfsp-installer.msi").display()
            ),
        )
    };

    // Download the plugin
    if let Err(e) = fetch_and_save(state, url, &local_file).await {
        return Err(format!("Failed to download plugin: {e}"));
    }

    // Install the plugin
    let status = if cfg!(target_os = "macos") {
        std::process::Command::new("osascript")
            .args([
                "-e",
                &format!(
                    "do shell script \"installer -pkg '{}' -target /\" with administrator privileges",
                    local_file.to_str().unwrap()
                ),
            ])
            .status()
    } else {
        execute_as_admin_powershell(local_file.to_str().unwrap())
    };

    // Clean up the downloaded file
    let _ = std::fs::remove_file(&local_file);

    match status {
        Ok(exit_status) if exit_status.success() => {
            // Verify installation completed successfully
            let installation_verified = check_mount_plugin_installed();

            if installation_verified {
                window
                    .emit("mount_plugin_installed", ())
                    .map_err(|e| e.to_string())?;
                Ok("Mount plugin installed successfully".to_string())
            } else {
                Err("Installation appeared to succeed but plugin verification failed. You may need to restart the application.".to_string())
            }
        }
        Ok(exit_status) => Err(format!("Installation failed with exit code: {exit_status}")),
        Err(e) => Err(format!("Failed to execute installer: {e}")),
    }
}

fn execute_as_admin_powershell(msi_path: &str) -> std::io::Result<std::process::ExitStatus> {
    // Use Start-Process with -Wait to ensure we wait for completion
    std::process::Command::new("powershell")
        .args([
            "-Command",
            &format!(
                "Start-Process -FilePath 'msiexec' -ArgumentList '/i \"{}\" /qn /norestart' -Verb RunAs -Wait",
                msi_path.replace("'", "''")
            ),
        ])
        .status()
}

async fn fetch_and_save(
    state: State<'_, RcloneState>,
    url: &str,
    file_path: &PathBuf,
) -> Result<(), String> {
    let response = state
        .client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read bytes: {e}"))?;

    let mut file = fs::File::create(file_path).map_err(|e| format!("File creation error: {e}"))?;
    file.write_all(&bytes)
        .map_err(|e| format!("Failed to write file: {e}"))?;

    debug!("Downloaded and saved at {file_path:?}");
    Ok(())
}
