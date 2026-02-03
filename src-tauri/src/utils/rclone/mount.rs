//! Mount plugin detection and installation
//!
//! This module handles:
//! - Detecting mount plugins (WinFsp, FUSE-T, MacFUSE) on each platform
//! - Installing mount plugins with dynamic version fetching from GitHub
//! - Installing mount plugins with dynamic version fetching from GitHub

#[cfg(any(target_os = "macos", target_os = "windows"))]
use crate::utils::{
    github_client, types::core::RcloneState, types::events::MOUNT_PLUGIN_INSTALLED,
};

#[cfg(all(target_os = "linux", not(feature = "web-server")))]
use tauri::State;

#[cfg(all(target_os = "linux", not(feature = "web-server")))]
use crate::utils::types::core::RcloneState;

// =============================================================================
// MOUNT PLUGIN DETECTION
// =============================================================================

#[cfg(target_os = "macos")]
/// Checks for the presence of any compatible FUSE implementation on macOS.
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
            true
        }
        _ => {
            debug!("macOS: No compatible FUSE installation found");
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
    let possible_paths = [
        "C:\\Program Files\\WinFsp",
        "C:\\Program Files (x86)\\WinFsp",
        "C:\\Windows\\System32\\drivers\\winfsp.sys",
    ];

    for path in &possible_paths {
        if std::path::PathBuf::from(path).exists() {
            log::debug!("Windows: WinFsp found at: {}", path);
            return true;
        }
    }

    // Check WinFsp service as fallback
    if let Ok(output) = std::process::Command::new("sc")
        .args(["query", "WinFsp.Launcher"])
        .output()
        && output.status.success()
    {
        let output_str = String::from_utf8_lossy(&output.stdout);
        if output_str.contains("WinFsp.Launcher") {
            log::debug!("Windows: WinFsp service found via sc query");
            return true;
        }
    }

    log::debug!("Windows: WinFsp not installed");
    false
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
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        false
    }
}

// =============================================================================
// DYNAMIC VERSION FETCHING
// =============================================================================

/// Mount plugin info containing download URL and filename
#[cfg(any(target_os = "macos", target_os = "windows"))]
struct MountPluginInfo {
    download_url: String,
    filename: String,
}

/// Fetch the latest WinFsp release URL from GitHub
#[cfg(target_os = "windows")]
async fn get_latest_winfsp_url() -> Result<MountPluginInfo, String> {
    let release = github_client::get_latest_release("winfsp", "winfsp")
        .await
        .map_err(|e| format!("Failed to fetch WinFsp releases: {e}"))?;

    // Find the .msi asset
    let msi_asset = release
        .assets
        .iter()
        .find(|a| a.name.ends_with(".msi"))
        .ok_or("No .msi asset found in WinFsp release")?;

    log::info!("Found WinFsp version: {}", release.tag_name);

    Ok(MountPluginInfo {
        download_url: msi_asset.browser_download_url.clone(),
        filename: msi_asset.name.clone(),
    })
}

/// Fetch the latest FUSE-T release URL from GitHub
#[cfg(target_os = "macos")]
async fn get_latest_fuse_t_url() -> Result<MountPluginInfo, String> {
    let release = github_client::get_latest_release("macos-fuse-t", "fuse-t")
        .await
        .map_err(|e| format!("Failed to fetch FUSE-T releases: {e}"))?;

    // Find the .pkg asset (installer)
    let pkg_asset = release
        .assets
        .iter()
        .find(|a| a.name.ends_with(".pkg"))
        .ok_or("No .pkg asset found in FUSE-T release")?;

    log::info!("Found FUSE-T version: {}", release.tag_name);

    Ok(MountPluginInfo {
        download_url: pkg_asset.browser_download_url.clone(),
        filename: pkg_asset.name.clone(),
    })
}

// =============================================================================
// PLUGIN INSTALLATION
// =============================================================================

/// Install mount plugin - macOS version
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn install_mount_plugin(
    app_handle: AppHandle,
    state: State<'_, RcloneState>,
) -> Result<String, String> {
    let download_path = std::env::temp_dir().join("rclone_temp");
    std::fs::create_dir_all(&download_path)
        .map_err(|e| format!("Failed to create download directory: {e}"))?;

    let plugin_info = get_latest_fuse_t_url().await?;
    let local_file = download_path.join(&plugin_info.filename);

    log::info!(
        "Downloading mount plugin from: {}",
        plugin_info.download_url
    );
    fetch_and_save(&state, &plugin_info.download_url, &local_file).await?;
    log::info!("Downloaded to: {:?}", local_file);

    let result = install_with_elevation(&app_handle, &local_file).await;
    let _ = std::fs::remove_file(&local_file);

    match result {
        Ok(_) => {
            if check_mount_plugin_installed() {
                if let Some(window) = tauri::Manager::get_webview_window(&app_handle, "main") {
                    let _ = tauri::Emitter::emit(&window, MOUNT_PLUGIN_INSTALLED, ());
                }
                Ok("Mount plugin installed successfully".to_string())
            } else {
                Err(
                    "Installation succeeded but verification failed. Restart may be required."
                        .to_string(),
                )
            }
        }
        Err(e) => Err(e),
    }
}

/// Install mount plugin - Windows version
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn install_mount_plugin(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, RcloneState>,
) -> Result<String, String> {
    let download_path = std::env::temp_dir().join("rclone_temp");
    std::fs::create_dir_all(&download_path)
        .map_err(|e| format!("Failed to create download directory: {e}"))?;

    let plugin_info = get_latest_winfsp_url().await?;
    let local_file = download_path.join(&plugin_info.filename);

    log::info!(
        "Downloading mount plugin from: {}",
        plugin_info.download_url
    );
    fetch_and_save(&state, &plugin_info.download_url, &local_file).await?;
    log::info!("Downloaded to: {:?}", local_file);

    let result = install_with_elevation(&local_file).await;
    let _ = std::fs::remove_file(&local_file);

    match result {
        Ok(_) => {
            if check_mount_plugin_installed() {
                if let Some(window) = tauri::Manager::get_webview_window(&app_handle, "main") {
                    let _ = tauri::Emitter::emit(&window, MOUNT_PLUGIN_INSTALLED, ());
                }
                Ok("Mount plugin installed successfully".to_string())
            } else {
                Err(
                    "Installation succeeded but verification failed. Restart may be required."
                        .to_string(),
                )
            }
        }
        Err(e) => Err(e),
    }
}

/// Install mount plugin - Linux version (no-op)
#[cfg(all(target_os = "linux", not(feature = "web-server")))]
#[tauri::command]
pub async fn install_mount_plugin(_state: State<'_, RcloneState>) -> Result<String, String> {
    Ok("Linux does not require a mount plugin".to_string())
}

/// Install mount plugin - unsupported platforms
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
#[tauri::command]
pub async fn install_mount_plugin() -> Result<String, String> {
    Err(crate::localized_error!(
        "backendErrors.rclone.unsupportedPlatform"
    ))
}

/// Install the plugin with admin elevation using local Command wrapper
#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn install_with_elevation(file_path: &std::path::Path) -> Result<(), String> {
    let file_path_str = file_path.to_str().ok_or("Invalid UTF-8 in file path")?;

    #[cfg(target_os = "macos")]
    {
        // Use osascript for admin elevation (shows password prompt)
        let script = format!(
            "do shell script \"installer -pkg '{}' -target /\" with administrator privileges",
            file_path_str.replace("'", "'\\''")
        );

        let output = crate::utils::process::Command::new("osascript")
            .args(["-e", &script])
            .output()
            .await
            .map_err(|e| format!("Failed to execute installer: {e}"))?;

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("Installation failed: {stderr}"))
        }
    }

    #[cfg(target_os = "windows")]
    {
        // Use PowerShell Start-Process with -Verb RunAs for UAC elevation
        // The -WindowStyle Hidden hides the PowerShell window
        let ps_command = format!(
            "Start-Process -FilePath 'msiexec' -ArgumentList '/i \"{}\" /qn /norestart' -Verb RunAs -Wait -WindowStyle Hidden",
            file_path_str.replace("'", "''")
        );

        let output = crate::utils::process::command::Command::new("powershell")
            .args(["-WindowStyle", "Hidden", "-Command", &ps_command])
            .output()
            .await
            .map_err(|e| format!("Failed to execute installer: {e}"))?;

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("Installation failed: {stderr}"))
        }
    }
}

/// Download a file and save it to disk
#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn fetch_and_save(
    state: &tauri::State<'_, RcloneState>,
    url: &str,
    file_path: &std::path::PathBuf,
) -> Result<(), String> {
    let response = state
        .client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download failed with status: {}",
            response.status()
        ));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read bytes: {e}"))?;

    let mut file =
        std::fs::File::create(file_path).map_err(|e| format!("File creation error: {e}"))?;

    std::io::Write::write_all(&mut file, &bytes)
        .map_err(|e| format!("Failed to write file: {e}"))?;

    log::debug!("Downloaded and saved at {:?}", file_path);
    Ok(())
}

// =============================================================================
// TESTS
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------------
    // check_mount_plugin_installed tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_check_mount_plugin_returns_bool() {
        // Just verify it returns a bool without panicking
        let _result = check_mount_plugin_installed(); // Just verify no panic
    }

    // -------------------------------------------------------------------------
    // MountPluginInfo tests
    // -------------------------------------------------------------------------

    #[test]
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    fn test_mount_plugin_info_struct() {
        let info = MountPluginInfo {
            download_url: "https://example.com/plugin.msi".to_string(),
            filename: "plugin.msi".to_string(),
        };

        assert!(info.download_url.contains("example.com"));
        assert!(info.filename.ends_with(".msi"));
    }

    // -------------------------------------------------------------------------
    // URL parsing tests (for asset detection logic)
    // -------------------------------------------------------------------------

    #[test]
    fn test_msi_detection() {
        let filenames = ["winfsp-2.0.msi", "winfsp-2.0.exe", "winfsp-2.0.zip"];
        let msi_file = filenames.iter().find(|f| f.ends_with(".msi"));
        assert_eq!(msi_file, Some(&"winfsp-2.0.msi"));
    }

    #[test]
    fn test_pkg_detection() {
        let filenames = ["fuse-t-1.0.pkg", "fuse-t-1.0.dmg", "fuse-t-1.0.tar.gz"];
        let pkg_file = filenames.iter().find(|f| f.ends_with(".pkg"));
        assert_eq!(pkg_file, Some(&"fuse-t-1.0.pkg"));
    }

    // -------------------------------------------------------------------------
    // Path escaping tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_windows_path_escaping() {
        let path = "C:\\Users\\test\\file.msi";
        let escaped = path.replace("'", "''");
        assert_eq!(escaped, "C:\\Users\\test\\file.msi"); // No single quotes to escape
    }

    #[test]
    fn test_macos_path_escaping() {
        let path = "/tmp/fuse-t's-installer.pkg";
        let escaped = path.replace("'", "'\\''");
        assert_eq!(escaped, "/tmp/fuse-t'\\''s-installer.pkg");
    }

    #[test]
    fn test_path_with_spaces() {
        let path = "/tmp/my plugin installer.pkg";
        // The path should work as-is since we quote it in the command
        assert!(path.contains(" "));
    }
}
