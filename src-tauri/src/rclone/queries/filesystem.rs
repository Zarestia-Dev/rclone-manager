use log::{debug, error};
use serde::Serialize;
use serde_json::json;
use std::path::PathBuf;
use tauri::State;

use crate::RcloneState;
use crate::rclone::state::engine::ENGINE_STATE;
use crate::utils::{
    rclone::endpoints::{EndpointHelper, operations},
    types::all_types::{DiskUsage, ListOptions},
};

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
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, operations::FSINFO);

    let fs_path = if remote.is_empty() {
        path.unwrap_or_default()
    } else {
        let fs_name = if remote.ends_with(':') {
            remote
        } else {
            format!("{remote}:")
        };
        match path {
            Some(p) if !p.is_empty() => format!("{fs_name}{p}"),
            _ => fs_name,
        }
    };

    let params = json!({ "fs": fs_path });

    let response = state
        .client
        .post(&url)
        .json(&params)
        .send()
        .await
        .map_err(|e| format!("❌ Failed to get fs info: {e}"))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("❌ Failed to parse response: {e}"))?;

    Ok(json)
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
    let (fs_name, remote_param) = if remote.is_empty() {
        ("/".to_string(), path.unwrap_or_default())
    } else {
        let fs = if remote.ends_with(':') {
            remote
        } else {
            format!("{remote}:")
        };
        (fs, path.unwrap_or_default())
    };
    params.insert("fs".to_string(), serde_json::Value::String(fs_name));
    params.insert(
        "remote".to_string(),
        serde_json::Value::String(remote_param),
    );

    let mut opt = serde_json::Map::new();
    opt.insert("metadata".to_string(), json!(true));

    if let Some(list_options) = options {
        for (key, value) in list_options.extra {
            opt.insert(key, value);
        }
    }
    params.insert("opt".to_string(), json!(opt));

    let response = state
        .client
        .post(&url)
        .json(&serde_json::Value::Object(params))
        .send()
        .await
        .map_err(|e| format!("❌ Failed to list remote paths: {e}"))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("❌ Failed to parse response: {e}"))?;

    Ok(json)
}

#[tauri::command]
pub async fn search_remote_files(
    remote: String,
    query: String,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, "core/command");
    debug!("🔍 Searching remote files: remote={remote}, query={query}");

    // Resolve path:
    // 1. If remote is empty or "Local", use User Home Dir (safer than /)
    // 2. Otherwise use the remote name.
    let fs_name = if remote.is_empty() || remote == "Local" {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("/"))
            .to_string_lossy()
            .to_string()
    } else if remote.ends_with(':') {
        remote
    } else {
        format!("{remote}:")
    };

    let params = json!({
        "command": "lsjson",
        "arg": [
            fs_name,
            "-R",
            "--files-only",
            "--no-modtime",
            "--no-mimetype",
            "--ignore-errors", // [FIX] Skip permission denied errors
            "--include",
            format!("*{}*", query)
        ],
        "opt": {}
    });

    let response = state
        .client
        .post(&url)
        .json(&params)
        .send()
        .await
        .map_err(|e| format!("❌ Failed to execute search: {e}"))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("❌ Failed to parse search response: {e}"))?;

    // [FIX] Prioritize returning data if "result" is a list, ignoring "error": true flags
    // that might be triggered by non-fatal permission errors.
    if let Some(result_array) = json.get("result").and_then(|r| r.as_array()) {
        return Ok(json!({ "list": result_array }));
    }

    // Only return empty list if there is an error AND no result list
    if let Some(is_error) = json.get("error") {
        let has_error = is_error.as_bool().unwrap_or(false) || is_error.as_str().is_some();

        if has_error {
            let error_msg = json
                .get("result")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error");
            error!("❌ Rclone search error: {}", error_msg);
            return Ok(json!({ "list": [] }));
        }
    }

    // Default fallback
    Ok(json!({ "list": [] }))
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
    Ok(vec![LocalDrive {
        name: "Local".to_string(),
        label: "Local Filesystem".to_string(),
    }])
}

#[tauri::command]
pub async fn get_disk_usage(
    remote: String,
    path: Option<String>,
    state: State<'_, RcloneState>,
) -> Result<DiskUsage, String> {
    // Delegate the HTTP request to `get_about_remote` and convert its result
    let json = get_about_remote(remote.clone(), path.clone(), state).await?;

    // Extract usage information
    let total = json["total"].as_i64().unwrap_or(0);
    let used = json["used"].as_i64().unwrap_or(0);
    let free = json["free"].as_i64().unwrap_or(0);

    // Compute fs_path string for logging (mirror logic from get_about_remote)
    let fs_path = if remote.is_empty() {
        path.unwrap_or_else(|| "/".to_string())
    } else {
        let fs_name = if remote.ends_with(':') {
            remote
        } else {
            format!("{remote}:")
        };
        match path {
            Some(p) if !p.is_empty() => format!("{fs_name}{p}"),
            _ => fs_name,
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

    let fs_path = if remote.is_empty() {
        path.unwrap_or_default()
    } else {
        let fs_name = if remote.ends_with(':') {
            remote
        } else {
            format!("{remote}:")
        };
        match path {
            Some(p) if !p.is_empty() => format!("{fs_name}{p}"),
            _ => fs_name,
        }
    };

    let params = json!({ "fs": fs_path, });

    let response = state
        .client
        .post(&url)
        .json(&params)
        .send()
        .await
        .map_err(|e| format!("❌ Failed to get about info: {e}"))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("❌ Failed to parse response: {e}"))?;

    Ok(json)
}

#[tauri::command]
pub async fn get_size(
    remote: String,
    path: Option<String>,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, operations::SIZE);
    debug!("📏 Getting size for remote: {remote}, path: {path:?}");

    let fs_path = if remote.is_empty() {
        path.unwrap_or_default()
    } else {
        let fs_name = if remote.ends_with(':') {
            remote
        } else {
            format!("{remote}:")
        };
        match path {
            Some(p) if !p.is_empty() => format!("{fs_name}{p}"),
            _ => fs_name,
        }
    };

    let params = json!({ "fs": fs_path });

    let response = state
        .client
        .post(&url)
        .json(&params)
        .send()
        .await
        .map_err(|e| format!("❌ Failed to get size: {e}"))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("❌ Failed to parse response: {e}"))?;

    Ok(json)
}

#[tauri::command]
pub async fn get_stat(
    remote: String,
    path: String,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, operations::STAT);
    debug!("📊 Getting stats for remote: {remote}, path: {path}");

    let fs_name = if remote.is_empty() || remote == "Local" {
        "/".to_string()
    } else if remote.ends_with(':') {
        remote.clone()
    } else {
        format!("{remote}:")
    };

    let params = json!({ "fs": fs_name, "remote": path });

    let response = state
        .client
        .post(&url)
        .json(&params)
        .send()
        .await
        .map_err(|e| format!("❌ Failed to get stat: {e}"))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("❌ Failed to parse response: {e}"))?;

    Ok(json)
}
