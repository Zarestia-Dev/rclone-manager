use std::fs;
use std::io::Write;
use std::path::PathBuf;

use tauri::State;

use crate::RcloneState;

#[cfg(target_os = "macos")]
fn needs_mount_plugin() -> bool {
    let has_fuse_t = PathBuf::from("/Library/Application Support/fuse-t").exists();
    let has_osx_fuse = PathBuf::from("/Library/Filesystems/macfuse.fs").exists();
    println!(
        "MacOS: hasFuseT: {}, hasOsxFuse: {}",
        has_fuse_t, has_osx_fuse
    );
    !has_fuse_t && !has_osx_fuse
}

#[cfg(target_os = "linux")]
fn needs_mount_plugin() -> bool {
    return false; // Linux does not require a mount plugin
}

#[cfg(target_os = "windows")]
fn needs_mount_plugin() -> bool {
    let has_winfsp = PathBuf::from("C:\\Program Files\\WinFsp").exists()
        || PathBuf::from("C:\\Program Files (x86)\\WinFsp").exists();
    println!("Windows: hasWinFsp: {}", has_winfsp);
    !has_winfsp
}

#[tauri::command]
pub fn check_mount_plugin() -> bool {
    needs_mount_plugin()
}

#[tauri::command]
pub async fn install_mount_plugin(state: State<'_, RcloneState>) -> Result<String, String> {
    let download_path = std::env::temp_dir().join("rclone_temp");

    let (url, local_file, _install_command) = if cfg!(target_os = "macos") {
        (
            "https://github.com/macos-fuse-t/fuse-t/releases/download/1.0.44/fuse-t-macos-installer-1.0.44.pkg",
            download_path.join("fuse-t-installer.pkg"),
            format!("sudo installer -pkg {} -target /", download_path.join("fuse-t-installer.pkg").display()),
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
        return Err(format!("Failed to download plugin: {}", e));
    }

    // Install the plugin
    let status = if cfg!(target_os = "macos") {
        std::process::Command::new("osascript")
            .arg("installer")
            .arg("-pkg")
            .arg(local_file.to_str().unwrap())
            .status()
    } else {
        std::process::Command::new("msiexec")
            .arg("/i")
            .arg(local_file.to_str().unwrap())
            .status()
    };

    match status {
        Ok(exit_status) if exit_status.success() => {
            Ok("Mount plugin installed successfully".to_string())
        }
        Ok(exit_status) => Err(format!(
            "Installation failed with exit code: {}",
            exit_status
        )),
        Err(e) => Err(format!("Failed to execute installer: {}", e)),
    }
}

async fn fetch_and_save(state: State<'_, RcloneState>, url: &str, file_path: &PathBuf) -> Result<(), String> {
    let response = state.client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read bytes: {}", e))?;

    let mut file =
        fs::File::create(file_path).map_err(|e| format!("File creation error: {}", e))?;
    file.write_all(&bytes)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    println!("Downloaded and saved at {:?}", file_path);
    Ok(())
}
