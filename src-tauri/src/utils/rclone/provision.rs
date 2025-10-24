use std::path::PathBuf;

use log::{debug, error, info};
use tauri::{Manager, State};

use crate::{
    core::{check_binaries::check_rclone_available, settings::operations::core::save_settings},
    utils::types::all_types::RcloneState,
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

    let install_path = match path {
        Some(p) => PathBuf::from(p),
        _none => app_handle
            .path()
            .app_data_dir()
            .expect("Failed to get app data directory"),
    };

    // check_rclone_available is now async, so we need to await it
    match check_rclone_available(app_handle.clone(), "").await {
        Ok(available) => {
            if available {
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
        }
        Err(e) => {
            error!("Error checking rclone availability: {e}");
            // Continue anyway - assume not available
        }
    }

    let os_name = match os {
        "macos" => "osx",
        "linux" => "linux",
        "windows" => "windows",
        _ => return Err("Unsupported OS.".into()),
    };

    let version = get_latest_rclone_version(&app_handle.state()).await?;

    let zip_bytes = download_rclone_zip(os_name, &arch, &version).await?;

    info!("Rclone version: {version}");
    // Save the downloaded zip bytes to a local file for debugging or reuse
    let temp_dir = std::env::temp_dir().join("rclone_temp");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp directory: {e}"))?;
    debug!("Temp directory created at {}", temp_dir.display());
    let zip_file_path = temp_dir.join(format!("rclone-{version}-{os_name}-{arch}.zip"));
    std::fs::write(&zip_file_path, &zip_bytes)
        .map_err(|e| format!("Failed to save rclone zip file locally: {e}"))?;
    info!(
        "Rclone zip file saved locally at {}",
        zip_file_path.display()
    );

    match verify_rclone_sha256(
        &temp_dir,
        &version,
        &format!("rclone-{version}-{os_name}-{arch}.zip"),
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
        .join(format!("rclone-{version}-{os_name}-{arch}"))
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

/// Get the latest rclone version from GitHub releases
pub async fn get_latest_rclone_version(state: &State<'_, RcloneState>) -> Result<String, String> {
    let url = "https://api.github.com/repos/rclone/rclone/releases/latest";

    let response = state
        .client
        .get(url)
        .header("User-Agent", "rclone-manager")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch latest version: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("GitHub API returned status: {}", response.status()));
    }

    let release_data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitHub response: {e}"))?;

    let tag_name = release_data
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or("No tag_name found in release data")?;

    Ok(tag_name.to_string())
}
