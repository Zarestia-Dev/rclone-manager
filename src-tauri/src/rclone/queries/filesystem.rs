use log::debug;
use serde::Serialize;
use serde_json::json;
use tauri::State;

use crate::utils::types::all_types::RcloneState;
use crate::utils::{
    rclone::endpoints::{EndpointHelper, operations},
    types::all_types::{DiskUsage, JobResponse, ListOptions},
};

use crate::rclone::backend::BACKEND_MANAGER;
use crate::rclone::commands::job::poll_job;

/// Helper to execute an async filesystem operation
async fn execute_fs_op(
    url: String,
    params: serde_json::Value,
    client: reqwest::Client,
    backend: crate::rclone::backend::types::Backend,
) -> Result<serde_json::Value, String> {
    let response = backend
        .inject_auth(client.post(&url))
        .json(&params)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let job: JobResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))?;

    poll_job(job.jobid, client, backend).await
}

/// Helper to execute a filesystem command (gets backend, builds URL, runs op)
async fn run_fs_command(
    client: reqwest::Client,
    endpoint: &str,
    mut params: serde_json::Map<String, serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let backend = BACKEND_MANAGER.get_active().await;
    let url = EndpointHelper::build_url(&backend.api_url(), endpoint);

    params.insert("_async".to_string(), json!(true));

    execute_fs_op(url, json!(params), client, backend).await
}

#[derive(Serialize, Clone)]
pub struct LocalDrive {
    name: String,
    label: String,
}

#[tauri::command]
pub async fn get_fs_info(
    remote: String,
    path: Option<String>,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    debug!("ℹ️ Getting fs info for remote: {remote}, path: {path:?}");

    let mut params = serde_json::Map::new();
    params.insert("fs".to_string(), json!(remote));
    params.insert("remote".to_string(), json!(path));

    let result = run_fs_command(state.client.clone(), operations::FSINFO, params).await;

    match result {
        Ok(data) => {
            #[cfg(target_os = "windows")]
            {
                use crate::utils::json_helpers::normalize_windows_path;
                let mut data = data;
                if let Some(root) = data.get_mut("Root") {
                    if let Some(root_str) = root.as_str() {
                        *root = json!(normalize_windows_path(root_str));
                    }
                }
                Ok(data)
            }
            #[cfg(not(target_os = "windows"))]
            Ok(data)
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn get_remote_paths(
    remote: String,
    path: Option<String>,
    options: Option<ListOptions>,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    let mut params = serde_json::Map::new();
    params.insert("fs".to_string(), json!(remote));
    params.insert("remote".to_string(), json!(path));

    let mut opt = serde_json::Map::new();
    if let Some(list_options) = options {
        for (key, value) in list_options.extra {
            opt.insert(key, value);
        }
    }
    params.insert("opt".to_string(), json!(opt));

    run_fs_command(state.client.clone(), operations::LIST, params).await
}

#[cfg(windows)]
#[tauri::command]
pub async fn get_local_drives() -> Result<Vec<LocalDrive>, String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetVolumeInformationW;

    let mut drives = Vec::new();

    for i in b'A'..=b'Z' {
        let drive_name = format!("{}:\\", i as char);
        if std::path::Path::new(&drive_name).exists() {
            let wide_drive_name: Vec<u16> = OsStr::new(&drive_name)
                .encode_wide()
                .chain(Some(0))
                .collect();

            let mut volume_name = [0u16; 256];
            let mut fs_name_buf = [0u16; 256];
            let result = unsafe {
                GetVolumeInformationW(
                    wide_drive_name.as_ptr(),
                    volume_name.as_mut_ptr(),
                    volume_name.len() as u32,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    fs_name_buf.as_mut_ptr(),
                    fs_name_buf.len() as u32,
                )
            };

            if result != 0 {
                let fs_len = fs_name_buf
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(fs_name_buf.len());
                let fs_name = String::from_utf16_lossy(&fs_name_buf[..fs_len]);
                if fs_name.contains("FUSE") {
                    continue;
                }

                let len = volume_name
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(volume_name.len());
                let label = String::from_utf16_lossy(&volume_name[..len]);

                drives.push(LocalDrive {
                    name: format!("{}:", i as char),
                    label: if label.is_empty() {
                        "Local Disk".to_string()
                    } else {
                        label
                    },
                });
            }
        }
    }
    Ok(drives)
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn get_local_drives() -> Result<Vec<LocalDrive>, String> {
    use std::env;
    let mut drives = Vec::new();

    // Add Home directory if available
    if let Ok(home) = env::var("HOME") {
        drives.push(LocalDrive {
            name: home,
            label: "Home".to_string(),
        });
    }

    // Add root filesystem
    drives.push(LocalDrive {
        name: "/".to_string(),
        label: "File System".to_string(),
    });

    Ok(drives)
}

/// Get disk usage (async by default)
#[tauri::command]
pub async fn get_disk_usage(
    remote: String,
    path: Option<String>,
    state: State<'_, RcloneState>,
) -> Result<DiskUsage, String> {
    // Delegate to get_about_remote (which is now async)
    let json = get_about_remote(remote.clone(), path.clone(), state).await?;

    // Extract usage information
    let total = json["total"].as_i64().unwrap_or(0);
    let used = json["used"].as_i64().unwrap_or(0);
    let free = json["free"].as_i64().unwrap_or(0);

    // Compute fs_path string for logging
    let fs_path = if remote.is_empty() {
        path.unwrap_or_else(|| "/".to_string())
    } else {
        match path {
            Some(p) if !p.is_empty() => format!("{remote}{p}"),
            _ => remote,
        }
    };

    let disk_usage = DiskUsage { total, used, free };

    debug!("💾 Disk Usage for {fs_path}: {disk_usage:?}");
    Ok(disk_usage)
}

#[tauri::command]
pub async fn get_about_remote(
    remote: String,
    path: Option<String>,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    debug!("ℹ️ Getting about info for remote: {remote}, path: {path:?}");

    let mut params = serde_json::Map::new();
    params.insert("fs".to_string(), json!(remote));
    params.insert("remote".to_string(), json!(path));

    run_fs_command(state.client.clone(), operations::ABOUT, params).await
}

#[tauri::command]
pub async fn get_size(
    remote: String,
    path: Option<String>,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    debug!("📏 Getting size for remote: {remote}, path: {path:?}");

    let mut params = serde_json::Map::new();
    params.insert("fs".to_string(), json!(remote));
    params.insert("remote".to_string(), json!(path));

    run_fs_command(state.client.clone(), operations::SIZE, params).await
}

#[tauri::command]
pub async fn get_stat(
    remote: String,
    path: String,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    debug!("📊 Getting stats for remote: {remote}, path: {path}");

    let mut params = serde_json::Map::new();
    params.insert("fs".to_string(), json!(remote));
    params.insert("remote".to_string(), json!(path));

    run_fs_command(state.client.clone(), operations::STAT, params).await
}

/// Get hashsum for a file
/// Returns the hash of the file using the specified hash type
#[tauri::command]
pub async fn get_hashsum(
    remote: String,
    path: String,
    hash_type: String,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    debug!("🔐 Getting hashsum for remote: {remote}, path: {path}, hash_type: {hash_type}");

    let mut params = serde_json::Map::new();
    // For single file hash, we need to include the filename in fs path
    // e.g., fs="remote:path/to/file.txt"
    let fs_with_path = if path.is_empty() {
        remote.clone()
    } else {
        format!("{}{}", remote, path)
    };
    params.insert("fs".to_string(), json!(fs_with_path));
    params.insert("hashType".to_string(), json!(hash_type));

    run_fs_command(state.client.clone(), operations::HASHSUM, params).await
}

/// Get or create a public link for a file or folder
/// Returns the public URL for sharing
#[tauri::command]
pub async fn get_public_link(
    remote: String,
    path: String,
    unlink: Option<bool>,
    expire: Option<String>,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    let backend = BACKEND_MANAGER.get_active().await;
    let url = EndpointHelper::build_url(&backend.api_url(), operations::PUBLICLINK);
    debug!(
        "🔗 Getting public link for remote: {remote}, path: {path}, expire: {expire:?}, unlink: {unlink:?}"
    );

    let mut params = serde_json::Map::new();
    params.insert("fs".to_string(), json!(remote));
    params.insert("remote".to_string(), json!(path));

    if let Some(should_unlink) = unlink {
        params.insert("unlink".to_string(), json!(should_unlink));
    }

    if let Some(expire) = expire {
        params.insert("expire".to_string(), json!(expire));
    }

    let client = state.client.clone();
    let url_clone = url.clone();
    let params_value = json!(params);

    // This is NOT an async operation - it returns the URL directly
    let response = backend
        .inject_auth(client.post(&url_clone))
        .json(&params_value)
        .send()
        .await
        .map_err(|e| format!("❌ Failed to get public link: {e}"))?;

    let result: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("❌ Failed to parse response: {e}"))?;

    Ok(result)
}

#[tauri::command]
pub fn convert_file_src(_app_handle: tauri::AppHandle, path: String) -> Result<String, String> {
    // Convert the file path to an asset protocol URL
    // This uses Tauri's built-in asset protocol to serve local files to the webview
    // The asset protocol must be enabled in tauri.conf.json under app.security.assetProtocol
    //
    // Implementation based on: https://github.com/tauri-apps/tauri/issues/12022
    // Until Tauri provides a built-in Rust API, this manual implementation is required

    // Different platforms use different base URLs for the asset protocol
    #[cfg(any(windows, target_os = "android"))]
    let base = "http://asset.localhost/";
    #[cfg(not(any(windows, target_os = "android")))]
    let base = "asset://localhost/";

    // Canonicalize the path to resolve symlinks and relative paths
    let canonical_path = dunce::canonicalize(&path)
        .map_err(|e| format!("Failed to canonicalize path '{}': {}", path, e))?;

    // URL encode the path to handle special characters
    let lossy_path = canonical_path.to_string_lossy();
    let encoded = urlencoding::encode(&lossy_path);

    // Build the final asset protocol URL
    let url = format!("{}{}", base, encoded);

    debug!("🔗 Converted file path to asset URL: {} -> {}", path, url);
    Ok(url)
}
