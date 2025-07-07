use log::debug;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

use tauri::{Emitter, State};

use crate::RcloneState;

#[cfg(target_os = "macos")]
fn check_fuse_t_installed() -> bool {
    let fuse_t_exists = PathBuf::from("/Library/Application Support/fuse-t").exists();
    debug!("macOS: FUSE-T installed: {}", fuse_t_exists);
    fuse_t_exists
}

#[cfg(target_os = "linux")]
fn check_mount_plugin_installed_linux() -> bool {
    // Linux does not require a mount plugin, always return true
    true
}

#[cfg(target_os = "windows")]
fn check_winfsp_installed() -> bool {
    let winfsp_exists = PathBuf::from("C:\\Program Files\\WinFsp").exists()
        || PathBuf::from("C:\\Program Files (x86)\\WinFsp").exists();
    debug!("Windows: WinFsp installed: {}", winfsp_exists);
    winfsp_exists
}

/// Checks if the required mount plugin is installed for the current platform.
#[tauri::command]
pub fn check_mount_plugin_installed() -> bool {
    #[cfg(target_os = "macos")]
    {
        check_fuse_t_installed()
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

    match status {
        Ok(exit_status) if exit_status.success() => {
            window
                .emit("mount_plugin_installed", ())
                .map_err(|e| e.to_string())?;
            Ok("Mount plugin installed successfully".to_string())
        }
        Ok(exit_status) => Err(format!("Installation failed with exit code: {exit_status}")),
        Err(e) => Err(format!("Failed to execute installer: {e}")),
    }
}

fn execute_as_admin_powershell(msi_path: &str) -> std::io::Result<std::process::ExitStatus> {
    std::process::Command::new("powershell")
        .args([
            "-Command",
            &format!(
                "Start-Process -FilePath 'msiexec' -ArgumentList '/i \"{}\" /qn /norestart' -Verb RunAs",
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
