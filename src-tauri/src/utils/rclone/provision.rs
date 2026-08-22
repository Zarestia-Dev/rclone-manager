use std::path::PathBuf;

use log::{error, info};
use tauri::Manager;
use tokio_util::sync::CancellationToken;

use crate::{
    core::{bridge, paths::AppPaths, settings::operations::core::save_setting},
    utils::{
        github_client,
        rclone::downloader::stream_download_to_file,
        types::{
            provision::{ProvisionComponent, ProvisionStage, ProvisionState, ProvisionStatus},
            state::RcloneState,
        },
    },
};

use super::{
    extractor::extract_rclone_zip,
    util::{RCLONE_EXECUTABLE, get_arch, safe_copy_rclone, verify_rclone_sha256},
};

#[bridge]
pub async fn provision_rclone(
    app_handle: tauri::AppHandle,
    path: Option<String>,
) -> Result<String, String> {
    let os = std::env::consts::OS;
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
    info!("Rclone target version: {version}");

    let cancel_token = CancellationToken::new();
    let provision_state = app_handle.state::<ProvisionState>();
    let _token_guard = provision_state.set_rclone_token(cancel_token.clone());

    let temp_dir = std::env::temp_dir().join("rclone_temp");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp directory: {e}"))?;

    let zip_file_name = format!("rclone-{version}-{os_name}-{arch}.zip");
    let zip_file_path = temp_dir.join(&zip_file_name);
    let download_url =
        format!("https://downloads.rclone.org/{version}/rclone-{version}-{os_name}-{arch}.zip");

    let rclone_state = app_handle.state::<RcloneState>();
    if let Err(e) = stream_download_to_file(
        &app_handle,
        &rclone_state.client,
        &download_url,
        &zip_file_path,
        ProvisionComponent::Rclone,
        Some(cancel_token),
    )
    .await
    {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err(e);
    }

    let zip_len = std::fs::metadata(&zip_file_path)
        .map(|m| m.len())
        .unwrap_or(0);

    // Stage: Verifying
    provision_state.set_stage(
        &app_handle,
        ProvisionComponent::Rclone,
        ProvisionStage::Verifying,
        zip_len,
        None,
    );

    match verify_rclone_sha256(&temp_dir, &version, &zip_file_name).await {
        Ok(()) => info!("SHA256 hash verified"),
        Err(err) => {
            error!("SHA256 verification failed: {err}");
            let _ = std::fs::remove_dir_all(&temp_dir);
            provision_state.set_stage(
                &app_handle,
                ProvisionComponent::Rclone,
                ProvisionStage::Error,
                zip_len,
                Some(err.clone()),
            );
            return Err(err);
        }
    }

    // Stage: Extracting
    provision_state.set_stage(
        &app_handle,
        ProvisionComponent::Rclone,
        ProvisionStage::Extracting,
        zip_len,
        None,
    );

    let extract_path = temp_dir.join("rclone");
    if let Err(e) = extract_rclone_zip(&zip_file_path, &extract_path) {
        let _ = std::fs::remove_dir_all(&temp_dir);
        provision_state.set_stage(
            &app_handle,
            ProvisionComponent::Rclone,
            ProvisionStage::Error,
            zip_len,
            Some(e.clone()),
        );
        return Err(e);
    }
    let _ = std::fs::remove_file(&zip_file_path);

    let binary_name = RCLONE_EXECUTABLE;
    let extracted_path = extract_path
        .join(format!("rclone-{version}-{os_name}-{arch}"))
        .join(binary_name);

    if !extracted_path.exists() {
        let _ = std::fs::remove_dir_all(&temp_dir);
        let err = crate::localized_error!("backendErrors.rclone.binaryNotFound");
        provision_state.set_stage(
            &app_handle,
            ProvisionComponent::Rclone,
            ProvisionStage::Error,
            zip_len,
            Some(err.clone()),
        );
        return Err(err);
    }

    // Stage: Installing
    provision_state.set_stage(
        &app_handle,
        ProvisionComponent::Rclone,
        ProvisionStage::Installing,
        zip_len,
        None,
    );

    info!(
        "Rclone binary verified. Copying to {}...",
        install_dir.display()
    );

    if let Err(e) = safe_copy_rclone(&extracted_path, &install_dir, binary_name) {
        let _ = std::fs::remove_dir_all(&temp_dir);
        provision_state.set_stage(
            &app_handle,
            ProvisionComponent::Rclone,
            ProvisionStage::Error,
            zip_len,
            Some(e.clone()),
        );
        return Err(e);
    }

    // Clean up temporary extraction folder
    let _ = std::fs::remove_dir_all(&temp_dir);

    // Store the full path to the binary file, not the directory.
    let binary_path = install_dir.join(binary_name);
    let binary_path_str = binary_path
        .to_str()
        .ok_or_else(|| crate::localized_error!("backendErrors.rclone.binaryNotFound"))?;

    if let Err(e) = save_setting(
        app_handle.clone(),
        "core".to_string(),
        "rclone_binary".to_string(),
        serde_json::json!(binary_path_str),
    )
    .await
    {
        error!("Failed to save settings: {e}");
    }

    info!("Rclone installed at {}", binary_path.display());

    // Stage: Completed
    provision_state.set_stage(
        &app_handle,
        ProvisionComponent::Rclone,
        ProvisionStage::Completed,
        zip_len,
        None,
    );

    Ok(crate::localized_success!("backendSuccess.rclone.updated", "channel" => "stable"))
}

#[bridge]
pub async fn cancel_provision_rclone(app_handle: tauri::AppHandle) -> Result<(), String> {
    let provision_state = app_handle.state::<ProvisionState>();
    if provision_state.cancel_rclone() {
        info!("Cancelling rclone provisioning download");
    }
    Ok(())
}

#[bridge]
pub fn get_provision_status(app_handle: tauri::AppHandle) -> Result<ProvisionStatus, String> {
    let provision_state = app_handle.state::<ProvisionState>();
    Ok(provision_state.get_status())
}

/// Get the latest rclone version from GitHub releases.
pub async fn get_latest_rclone_version() -> Result<String, String> {
    let release = github_client::get_latest_release("rclone", "rclone")
        .await
        .map_err(|e| e.to_string())?;

    Ok(release.tag_name)
}
