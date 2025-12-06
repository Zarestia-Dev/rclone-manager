use log::debug;
use serde::Serialize;
use serde_json::json;
use tauri::State;

use crate::rclone::state::engine::ENGINE_STATE;
use crate::utils::async_operations::execute_async_operation;
use crate::utils::types::all_types::RcloneState;
use crate::utils::{
    rclone::endpoints::{EndpointHelper, operations},
    types::all_types::{DiskUsage, JobResponse, ListOptions},
};

#[derive(Serialize, Clone)]
pub struct LocalDrive {
    name: String,
    label: String,
    fs_type: String,
}

#[tauri::command]
pub async fn get_fs_info(
    remote: String,
    path: Option<String>,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, operations::FSINFO);
    debug!("ℹ️ Getting fs info for remote: {remote}, path: {path:?}");

    let mut params = serde_json::Map::new();
    params.insert("fs".to_string(), json!(remote));
    params.insert("remote".to_string(), json!(path));
    params.insert("_async".to_string(), json!(true));

    let client = state.client.clone();
    let client_for_monitor = client.clone();
    let url_clone = url.clone();
    let params_value = json!(params);

    let result = execute_async_operation("Get fs info", client_for_monitor, || async move {
        let response = client
            .post(&url_clone)
            .json(&params_value)
            .send()
            .await
            .map_err(|e| format!("❌ Failed to get fs info: {e}"))?;

        let job: JobResponse = response
            .json()
            .await
            .map_err(|e| format!("❌ Failed to parse response: {e}"))?;

        Ok(job.jobid)
    })
    .await;

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
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, operations::LIST);
    debug!("📂 Listing remote paths: remote={remote}, path={path:?}, options={options:?}");

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
    params.insert("_async".to_string(), json!(true));

    let client = state.client.clone();
    let client_for_monitor = client.clone();
    let url_clone = url.clone();
    let params_value = json!(params);

    execute_async_operation("List remote paths", client_for_monitor, || async move {
        let response = client
            .post(&url_clone)
            .json(&params_value)
            .send()
            .await
            .map_err(|e| format!("❌ Failed to list remote paths: {e}"))?;

        let job: JobResponse = response
            .json()
            .await
            .map_err(|e| format!("❌ Failed to parse response: {e}"))?;

        Ok(job.jobid)
    })
    .await
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
                    fs_type: "local".to_string(),
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
            fs_type: "local".to_string(),
            label: "Home".to_string(),
        });
    }

    // Add root filesystem
    drives.push(LocalDrive {
        name: "/".to_string(),
        fs_type: "local".to_string(),
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
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, operations::ABOUT);
    debug!("ℹ️ Getting about info for remote: {remote}, path: {path:?}");

    let mut params = serde_json::Map::new();
    params.insert("fs".to_string(), json!(remote));
    params.insert("remote".to_string(), json!(path));
    params.insert("_async".to_string(), json!(true));

    let client = state.client.clone();
    let client_for_monitor = client.clone();
    let url_clone = url.clone();
    let params_value = json!(params);

    execute_async_operation("Get about info", client_for_monitor, || async move {
        let response = client
            .post(&url_clone)
            .json(&params_value)
            .send()
            .await
            .map_err(|e| format!("❌ Failed to get about info: {e}"))?;

        let job: JobResponse = response
            .json()
            .await
            .map_err(|e| format!("❌ Failed to parse response: {e}"))?;

        Ok(job.jobid)
    })
    .await
}

#[tauri::command]
pub async fn get_size(
    remote: String,
    path: Option<String>,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, operations::SIZE);
    debug!("📏 Getting size for remote: {remote}, path: {path:?}");

    let mut params = serde_json::Map::new();
    params.insert("fs".to_string(), json!(remote));
    params.insert("remote".to_string(), json!(path));
    params.insert("_async".to_string(), json!(true));

    let client = state.client.clone();
    let client_for_monitor = client.clone();
    let url_clone = url.clone();
    let params_value = json!(params);

    execute_async_operation("Get size", client_for_monitor, || async move {
        let response = client
            .post(&url_clone)
            .json(&params_value)
            .send()
            .await
            .map_err(|e| format!("❌ Failed to get size: {e}"))?;

        let job: JobResponse = response
            .json()
            .await
            .map_err(|e| format!("❌ Failed to parse response: {e}"))?;

        Ok(job.jobid)
    })
    .await
}

#[tauri::command]
pub async fn get_stat(
    remote: String,
    path: String,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, operations::STAT);
    debug!("📊 Getting stats for remote: {remote}, path: {path}");

    let mut params = serde_json::Map::new();
    params.insert("fs".to_string(), json!(remote));
    params.insert("remote".to_string(), json!(path));
    params.insert("_async".to_string(), json!(true));

    let client = state.client.clone();
    let client_for_monitor = client.clone();
    let url_clone = url.clone();
    let params_value = json!(params);

    execute_async_operation("Get stat", client_for_monitor, || async move {
        let response = client
            .post(&url_clone)
            .json(&params_value)
            .send()
            .await
            .map_err(|e| format!("❌ Failed to get stat: {e}"))?;

        let job: JobResponse = response
            .json()
            .await
            .map_err(|e| format!("❌ Failed to parse response: {e}"))?;

        Ok(job.jobid)
    })
    .await
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
