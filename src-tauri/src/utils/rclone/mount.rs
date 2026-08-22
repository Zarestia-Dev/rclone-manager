use crate::core::bridge;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use crate::utils::{
    github_client,
    rclone::downloader::stream_download_to_file,
    types::{
        events::MOUNT_PLUGIN_INSTALLED,
        provision::{ProvisionComponent, ProvisionStage, ProvisionState},
        state::RcloneState,
    },
};

#[cfg(target_os = "macos")]
fn check_fuse_installed() -> bool {
    use std::path::Path;

    let fuse_t = [
        "/Library/Application Support/fuse-t",
        "/Library/Frameworks/FuseT.framework",
        "/usr/local/bin/mount_fuse-t",
    ]
    .iter()
    .any(|p| Path::new(p).exists());

    let macfuse = [
        "/Library/Receipts/MacFUSE.pkg",
        "/Library/Filesystems/macfuse.fs",
        "/usr/local/bin/mount_macfuse",
    ]
    .iter()
    .any(|p| Path::new(p).exists());

    log::debug!("macOS: FUSE-T={fuse_t}, MacFUSE={macfuse}");
    fuse_t || macfuse
}

#[cfg(target_os = "windows")]
fn check_winfsp_installed() -> bool {
    use std::path::Path;

    if [
        "C:\\Program Files\\WinFsp",
        "C:\\Program Files (x86)\\WinFsp",
        "C:\\Windows\\System32\\drivers\\winfsp.sys",
    ]
    .iter()
    .any(|p| Path::new(p).exists())
    {
        log::debug!("Windows: WinFsp found via path");
        return true;
    }

    let via_service = std::process::Command::new("sc")
        .args(["query", "WinFsp.Launcher"])
        .output()
        .is_ok_and(|o| {
            o.status.success() && String::from_utf8_lossy(&o.stdout).contains("WinFsp.Launcher")
        });

    log::debug!("Windows: WinFsp service={via_service}");
    via_service
}

#[bridge]
pub fn check_mount_plugin_installed() -> bool {
    #[cfg(target_os = "macos")]
    {
        check_fuse_installed()
    }
    #[cfg(target_os = "windows")]
    {
        check_winfsp_installed()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        true
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
struct MountPluginInfo {
    download_url: String,
    filename: String,
}

#[cfg(target_os = "windows")]
async fn get_latest_winfsp_url() -> Result<MountPluginInfo, String> {
    let release = github_client::get_latest_release("winfsp", "winfsp")
        .await
        .map_err(|e| format!("Failed to fetch WinFsp releases: {e}"))?;

    let asset = release
        .assets
        .iter()
        .find(|a| a.name.ends_with(".msi"))
        .ok_or("No .msi asset in WinFsp release")?;

    log::info!("WinFsp {}", release.tag_name);
    Ok(MountPluginInfo {
        download_url: asset.browser_download_url.clone(),
        filename: asset.name.clone(),
    })
}

#[cfg(target_os = "macos")]
async fn get_latest_fuse_t_url() -> Result<MountPluginInfo, String> {
    let release = github_client::get_latest_release("macos-fuse-t", "fuse-t")
        .await
        .map_err(|e| format!("Failed to fetch FUSE-T releases: {e}"))?;

    let asset = release
        .assets
        .iter()
        .find(|a| a.name.ends_with(".pkg"))
        .ok_or("No .pkg asset in FUSE-T release")?;

    log::info!("FUSE-T {}", release.tag_name);
    Ok(MountPluginInfo {
        download_url: asset.browser_download_url.clone(),
        filename: asset.name.clone(),
    })
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn run_install(
    app_handle: &tauri::AppHandle,
    info: MountPluginInfo,
) -> Result<String, String> {
    use tauri::{Emitter, Manager};
    use tokio_util::sync::CancellationToken;

    let cancel_token = CancellationToken::new();
    let provision_state = app_handle.state::<ProvisionState>();
    let _token_guard = provision_state.set_mount_plugin_token(cancel_token.clone());

    let state = app_handle.state::<RcloneState>();
    let tmp = std::env::temp_dir().join("rclone_temp");
    std::fs::create_dir_all(&tmp).map_err(|e| format!("Failed to create temp dir: {e}"))?;

    let local_file = tmp.join(&info.filename);
    log::info!("Downloading {}", info.download_url);

    stream_download_to_file(
        app_handle,
        &state.client,
        &info.download_url,
        &local_file,
        ProvisionComponent::MountPlugin,
        Some(cancel_token),
    )
    .await?;

    let file_len = std::fs::metadata(&local_file).map(|m| m.len()).unwrap_or(0);

    // Stage: Installing
    provision_state.set_stage(
        app_handle,
        ProvisionComponent::MountPlugin,
        ProvisionStage::Installing,
        file_len,
        None,
    );

    let result = install_with_elevation(&local_file).await;
    let _ = std::fs::remove_file(&local_file);
    if let Err(e) = result {
        provision_state.set_stage(
            app_handle,
            ProvisionComponent::MountPlugin,
            ProvisionStage::Error,
            file_len,
            Some(e.clone()),
        );
        return Err(e);
    }

    for attempt in 1..=5 {
        if check_mount_plugin_installed() {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.emit(MOUNT_PLUGIN_INSTALLED, ());
            }
            provision_state.set_stage(
                app_handle,
                ProvisionComponent::MountPlugin,
                ProvisionStage::Completed,
                file_len,
                None,
            );
            return Ok(crate::localized_success!(
                "backendSuccess.rclone.mountPluginInstalled"
            ));
        }
        log::debug!("Post-install verification {attempt}/5 failed, retrying in 1s...");
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }

    let err = crate::localized_error!("backendErrors.rclone.mountPluginVerificationFailed");
    provision_state.set_stage(
        app_handle,
        ProvisionComponent::MountPlugin,
        ProvisionStage::Error,
        file_len,
        Some(err.clone()),
    );
    Err(err)
}

#[cfg(target_os = "macos")]
#[bridge]
pub async fn install_mount_plugin(app_handle: tauri::AppHandle) -> Result<String, String> {
    run_install(&app_handle, get_latest_fuse_t_url().await?).await
}

#[cfg(target_os = "windows")]
#[bridge]
pub async fn install_mount_plugin(app_handle: tauri::AppHandle) -> Result<String, String> {
    run_install(&app_handle, get_latest_winfsp_url().await?).await
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[bridge]
pub async fn install_mount_plugin(_app_handle: tauri::AppHandle) -> Result<String, String> {
    Err(crate::localized_error!(
        "backendErrors.rclone.unsupportedPlatform"
    ))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[bridge]
pub async fn cancel_mount_plugin_install(app_handle: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let provision_state = app_handle.state::<ProvisionState>();
    if provision_state.cancel_mount_plugin() {
        log::info!("Cancelling mount plugin download");
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[bridge]
pub async fn cancel_mount_plugin_install(_app_handle: tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn install_with_elevation(file_path: &std::path::Path) -> Result<(), String> {
    let path_str = file_path.to_str().ok_or("Invalid UTF-8 in file path")?;

    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "do shell script \"installer -pkg '{}' -target /\" with administrator privileges",
            path_str.replace("'", "'\\''")
        );
        let output = crate::utils::process::command::Command::new("osascript")
            .args(["-e", &script])
            .output()
            .await
            .map_err(|e| format!("Failed to run installer: {e}"))?;

        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "Installation failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ))
        }
    }

    #[cfg(target_os = "windows")]
    {
        let ps_command = format!(
            "Start-Process -FilePath 'msiexec' -ArgumentList '/i \"{}\" /qn /norestart' -Verb RunAs -Wait -WindowStyle Hidden",
            path_str.replace("'", "''")
        );
        let args = [
            "-NoProfile",
            "-NonInteractive",
            "-NoLogo",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &ps_command,
        ];

        // Try pwsh (PowerShell 7+), fall back to the legacy inbox powershell.exe
        let output = match crate::utils::process::command::Command::new("pwsh")
            .args(args)
            .output()
            .await
        {
            Ok(out) => out,
            Err(_) => {
                log::debug!("pwsh unavailable, falling back to powershell.exe");
                crate::utils::process::command::Command::new("powershell")
                    .args(args)
                    .output()
                    .await
                    .map_err(|e| format!("Failed to run installer: {e}"))?
            }
        };

        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "Installation failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_check_mount_plugin_installed_no_panic() {
        let _ = check_mount_plugin_installed();
    }

    #[test]
    fn test_windows_path_escaping() {
        assert_eq!(
            "C:\\Users\\test\\file.msi".replace("'", "''"),
            "C:\\Users\\test\\file.msi"
        );
        assert_eq!(
            "C:\\it's here\\file.msi".replace("'", "''"),
            "C:\\it''s here\\file.msi"
        );
    }

    #[test]
    fn test_macos_path_escaping() {
        assert_eq!(
            "/tmp/fuse-t's-installer.pkg".replace("'", "'\\''"),
            "/tmp/fuse-t'\\''s-installer.pkg"
        );
    }
}
