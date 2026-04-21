use std::path::PathBuf;

use log::{debug, error, info};
use tauri::Manager;

use crate::{
    core::{paths::AppPaths, settings::operations::core::save_setting},
    utils::github_client,
};

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

    let install_dir = match path {
        Some(p) => PathBuf::from(p),
        None => AppPaths::from_app_handle(&app_handle)?.config_dir,
    };

    let os_name = match os {
        "macos" => "osx",
        "linux" => "linux",
        "windows" => "windows",
        _ => {
            return Err(crate::localized_error!(
                "backendErrors.rclone.unsupportedOS"
            ));
        }
    };

    let version = get_latest_rclone_version().await?;
    let zip_bytes = download_rclone_zip(os_name, &arch, &version).await?;

    info!("Rclone version: {version}");

    let temp_dir = std::env::temp_dir().join("rclone_temp");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp directory: {e}"))?;

    let zip_file_name = format!("rclone-{version}-{os_name}-{arch}.zip");
    let zip_file_path = temp_dir.join(&zip_file_name);
    std::fs::write(&zip_file_path, &zip_bytes)
        .map_err(|e| format!("Failed to save rclone zip: {e}"))?;

    debug!("Rclone zip saved at {}", zip_file_path.display());

    match verify_rclone_sha256(&temp_dir, &version, &zip_file_name).await {
        Ok(_) => info!("SHA256 hash verified"),
        Err(err) => {
            error!("SHA256 verification failed: {err}");
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
        .join(format!("rclone-{version}-{os_name}-{arch}"))
        .join(binary_name);

    if !extracted_path.exists() {
        return Err(crate::localized_error!(
            "backendErrors.rclone.binaryNotFound"
        ));
    }

    info!(
        "Rclone binary verified. Copying to {}...",
        install_dir.display()
    );

    safe_copy_rclone(&extracted_path, &install_dir, binary_name)?;

    // Store the full path to the binary file, not the directory.
    let binary_path = install_dir.join(binary_name);
    let binary_path_str = binary_path
        .to_str()
        .ok_or_else(|| crate::localized_error!("backendErrors.rclone.binaryNotFound"))?;

    if let Err(e) = save_setting(
        "core".to_string(),
        "rclone_binary".to_string(),
        serde_json::json!(binary_path_str),
        app_handle.state(),
        app_handle.clone(),
    )
    .await
    {
        error!("Failed to save settings: {e}");
    }

    info!("Rclone installed at {}", binary_path.display());

    Ok(crate::localized_success!("backendSuccess.rclone.updated", "channel" => "stable"))
}

/// Get the latest rclone version from GitHub releases.
pub async fn get_latest_rclone_version() -> Result<String, String> {
    let release = github_client::get_latest_release("rclone", "rclone")
        .await
        .map_err(|e| e.to_string())?;

    Ok(release.tag_name)
}
