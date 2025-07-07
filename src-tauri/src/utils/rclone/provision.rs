use std::path::PathBuf;

use log::{debug, error, info};
use tauri::Manager;

use crate::core::{check_binaries::is_rclone_available, settings::operations::core::save_settings};

use super::{
    downloader::download_rclone_zip,
    extractor::extract_rclone_zip,
    util::{get_arch, safe_copy_rclone, verify_rclone_sha256},
};

#[tauri::command]
pub async fn provision_rclone(
    app_handle: tauri::AppHandle,
    path: Option<String>,
) -> Result<String, String> {
    let os = tauri_plugin_os::platform();
    let arch = get_arch();

    let install_path = match path {
        Some(p) => PathBuf::from(p),
        _none => app_handle
            .path()
            .app_data_dir()
            .expect("Failed to get app data directory"),
    };

    if is_rclone_available(app_handle.clone()) {
        if let Err(e) = save_settings(
            app_handle.state(),
            serde_json::json!({
                "core": {
                    "rclone_path": "system"
                }
            }),
            app_handle.clone(),
        )
        .await
        {
            error!("Failed to save settings: {e}");
        }
        return Ok("Rclone already installed system-wide.".into());
    }

    let os_name = match os {
        "macos" => "osx",
        "linux" => "linux",
        "windows" => "windows",
        _ => return Err("Unsupported OS.".into()),
    };

    let (version, zip_bytes) = download_rclone_zip(os_name, &arch).await?;

    info!("Rclone version: {version}");
    // Save the downloaded zip bytes to a local file for debugging or reuse
    let temp_dir = std::env::temp_dir().join("rclone_temp");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp directory: {e}"))?;
    debug!("Temp directory created at {}", temp_dir.display());
    let zip_file_path = temp_dir.join(format!("rclone-v{version}-{os_name}-{arch}.zip"));
    std::fs::write(&zip_file_path, &zip_bytes)
        .map_err(|e| format!("Failed to save rclone zip file locally: {e}"))?;
    info!(
        "Rclone zip file saved locally at {}",
        zip_file_path.display()
    );

    match verify_rclone_sha256(
        &temp_dir,
        &version,
        &format!("rclone-v{version}-{os_name}-{arch}.zip"),
    )
    .await
    {
        Ok(_) => info!("SHA256 hash matches ✅"),
        Err(err) => {
            error!("SHA256 verification failed ❌: {err}");
            return Err(err);
        }
    }

    extract_rclone_zip(&zip_bytes, &temp_dir)?;

    let binary_name = if os == "windows" {
        "rclone.exe"
    } else {
        "rclone"
    };
    let extracted_path = temp_dir
        .join("rclone")
        .join(format!("rclone-v{version}-{os_name}-{arch}"))
        .join(binary_name);

    if !extracted_path.exists() {
        return Err("Rclone binary not found.".into());
    }

    info!("Rclone binary verified successfully. Proceeding to copy...");

    safe_copy_rclone(&extracted_path, &install_path, binary_name)?;

    info!(
        "Rclone installed successfully at {}",
        install_path.display()
    );
    // 🔥 Emit the event so frontend updates
    if let Err(e) = save_settings(
        app_handle.state(),
        serde_json::json!({
            "core": {
                "rclone_path": install_path.to_str().unwrap()
            }
        }),
        app_handle.clone(),
    )
    .await
    {
        error!("Failed to save settings: {e}");
    }

    Ok(format!("Rclone installed in {}", install_path.display()))
}
