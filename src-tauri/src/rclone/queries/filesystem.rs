use log::debug;
use serde::Serialize;
use serde_json::json;
use tauri::State;

use crate::utils::{
    rclone::endpoints::operations,
    types::{
        core::{DiskUsage, RcloneState},
        jobs::JobType,
        remotes::ListOptions,
    },
};

use crate::rclone::backend::BackendManager;
use tauri::{AppHandle, Manager};

/// Helper to execute a filesystem command (gets backend, builds URL, runs op)
async fn run_fs_command(
    app: AppHandle,
    client: reqwest::Client,
    endpoint: &str,
    mut params: serde_json::Map<String, serde_json::Value>,
    metadata: crate::rclone::commands::job::JobMetadata,
) -> Result<serde_json::Value, String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let url = backend.url_for(endpoint);

    params.insert("_async".to_string(), json!(true));

    let request = backend.inject_auth(client.post(&url));
    let (_, response_json, _) = crate::rclone::commands::job::submit_job_and_wait(
        app,
        client,
        request,
        json!(params),
        metadata,
    )
    .await?;

    Ok(response_json)
}

/// Helper to create standard filesystem parameters
fn create_fs_params(
    remote: String,
    path: Option<String>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut params = serde_json::Map::new();
    params.insert("fs".to_string(), json!(remote));
    params.insert("remote".to_string(), json!(path));
    params
}

#[derive(Serialize, Clone)]
pub struct LocalDrive {
    name: String,
    label: String,
}

#[tauri::command]
pub async fn get_fs_info(
    app: AppHandle,
    remote: String,
    path: Option<String>,
    origin: Option<String>,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    debug!("ℹ️ Getting fs info for remote: {remote}, path: {path:?}");

    let params = create_fs_params(remote.clone(), path.clone());
    let metadata = crate::rclone::commands::job::JobMetadata {
        remote_name: remote,
        job_type: JobType::Info,
        operation_name: "FsInfo".to_string(),
        source: path.unwrap_or_default(),
        destination: String::new(),
        profile: None,
        origin,
        group: None,
        no_cache: true,
    };

    let result = run_fs_command(
        app,
        state.client.clone(),
        operations::FSINFO,
        params,
        metadata,
    )
    .await;

    match result {
        Ok(data) => {
            #[cfg(target_os = "windows")]
            {
                use crate::utils::json_helpers::normalize_windows_path;
                let mut data = data;
                if let Some(root) = data.get_mut("Root")
                    && let Some(root_str) = root.as_str()
                {
                    *root = json!(normalize_windows_path(root_str));
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
    app: AppHandle,
    remote: String,
    path: Option<String>,
    origin: Option<String>,
    options: Option<ListOptions>,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    let mut params = create_fs_params(remote.clone(), path.clone());

    if let Some(list_options) = options {
        let mut opt = serde_json::Map::new();
        for (key, value) in list_options.extra {
            opt.insert(key, value);
        }
        params.insert("opt".to_string(), json!(opt));
    }

    let metadata = crate::rclone::commands::job::JobMetadata {
        remote_name: remote,
        job_type: JobType::List,
        operation_name: "List".to_string(),
        source: path.unwrap_or_default(),
        destination: String::new(),
        profile: None,
        origin,
        group: None,
        no_cache: true,
    };

    run_fs_command(
        app,
        state.client.clone(),
        operations::LIST,
        params,
        metadata,
    )
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
    app: AppHandle,
    remote: String,
    path: Option<String>,
    origin: Option<String>,
    state: State<'_, RcloneState>,
) -> Result<DiskUsage, String> {
    // Delegate to get_about_remote (which is now async)
    let json = get_about_remote(app, remote.clone(), path.clone(), origin, state).await?;

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
    app: AppHandle,
    remote: String,
    path: Option<String>,
    origin: Option<String>,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    debug!("ℹ️ Getting about info for remote: {remote}, path: {path:?}");

    let params = create_fs_params(remote.clone(), path.clone());
    let metadata = crate::rclone::commands::job::JobMetadata {
        remote_name: remote,
        job_type: JobType::About,
        operation_name: "About".to_string(),
        source: path.unwrap_or_default(),
        destination: String::new(),
        profile: None,
        origin,
        group: None,
        no_cache: true,
    };

    run_fs_command(
        app,
        state.client.clone(),
        operations::ABOUT,
        params,
        metadata,
    )
    .await
}

#[tauri::command]
pub async fn get_size(
    app: AppHandle,
    remote: String,
    path: Option<String>,
    origin: Option<String>,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    debug!("📏 Getting size for remote: {remote}, path: {path:?}");

    let params = create_fs_params(remote.clone(), path.clone());
    let metadata = crate::rclone::commands::job::JobMetadata {
        remote_name: remote,
        job_type: JobType::Size,
        operation_name: "Size".to_string(),
        source: path.unwrap_or_default(),
        destination: String::new(),
        profile: None,
        origin,
        group: None,
        no_cache: true,
    };

    run_fs_command(
        app,
        state.client.clone(),
        operations::SIZE,
        params,
        metadata,
    )
    .await
}

#[tauri::command]
pub async fn get_stat(
    app: AppHandle,
    remote: String,
    path: String,
    origin: Option<String>,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    debug!("📊 Getting stats for remote: {remote}, path: {path}");

    // Convert (String, String) to (String, Option<String>) for helper
    let params = create_fs_params(remote.clone(), Some(path.clone()));
    let metadata = crate::rclone::commands::job::JobMetadata {
        remote_name: remote,
        job_type: JobType::Stat,
        operation_name: "Stat".to_string(),
        source: path,
        destination: String::new(),
        profile: None,
        origin,
        group: None,
        no_cache: true,
    };

    run_fs_command(
        app,
        state.client.clone(),
        operations::STAT,
        params,
        metadata,
    )
    .await
}

/// Get hashsum for a path (file or directory)
/// Returns list of hashes
#[tauri::command]
pub async fn get_hashsum(
    app: AppHandle,
    remote: String,
    path: String,
    hash_type: String,
    origin: Option<String>,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    debug!("🔐 Getting hashsum for remote: {remote}, path: {path}, hash_type: {hash_type}");

    let mut params = serde_json::Map::new();
    // For hashsum (bulk/directory), 'fs' points to the root of the listing
    let fs_with_path = if path.is_empty() {
        remote.clone()
    } else {
        // Ensure separation if needed, though usually remote includes ':'
        // and path is relative.
        format!("{}{}", remote, path)
    };
    params.insert("fs".to_string(), json!(fs_with_path));
    params.insert("hashType".to_string(), json!(hash_type));

    let metadata = crate::rclone::commands::job::JobMetadata {
        remote_name: remote,
        job_type: JobType::Hash,
        operation_name: "Hash".to_string(),
        source: path,
        destination: String::new(),
        profile: None,
        origin,
        group: None,
        no_cache: true,
    };

    run_fs_command(
        app,
        state.client.clone(),
        operations::HASHSUM,
        params,
        metadata,
    )
    .await
}

/// Get hashsum for a single file
/// Returns the hash of the file using the specified hash type
#[tauri::command]
pub async fn get_hashsum_file(
    app: AppHandle,
    remote: String,
    path: String,
    hash_type: String,
    origin: Option<String>,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    debug!("🔐 Getting hashsum file for remote: {remote}, path: {path}, hash_type: {hash_type}");

    let mut params = create_fs_params(remote.clone(), Some(path.clone()));
    params.insert("hashType".to_string(), json!(hash_type));

    // Default to true for download and base64 for consistency/safety if hash not supported?
    // The user didn't specify defaults, but 'download' is useful fallback.
    // However, sticking to bare minimum inputs is safer unless requested.

    let metadata = crate::rclone::commands::job::JobMetadata {
        remote_name: remote,
        job_type: JobType::Hash,
        operation_name: "HashsumFile".to_string(),
        source: path,
        destination: String::new(),
        profile: None,
        origin,
        group: None,
        no_cache: true,
    };

    run_fs_command(
        app,
        state.client.clone(),
        operations::HASHSUMFILE,
        params,
        metadata,
    )
    .await
}

/// Get or create a public link for a file or folder
/// Returns the public URL for sharing
#[tauri::command]
pub async fn get_public_link(
    app: AppHandle,
    remote: String,
    path: String,
    unlink: Option<bool>,
    expire: Option<String>,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    debug!(
        "🔗 Getting public link for remote: {remote}, path: {path}, expire: {expire:?}, unlink: {unlink:?}"
    );

    let mut params = create_fs_params(remote, Some(path));

    if let Some(should_unlink) = unlink {
        params.insert("unlink".to_string(), json!(should_unlink));
    }

    if let Some(expire) = expire {
        params.insert("expire".to_string(), json!(expire));
    }

    let client = state.client.clone();
    let params_value = json!(params);

    // This is NOT an async operation - it returns the URL directly
    let result = backend
        .post_json(&client, operations::PUBLICLINK, Some(&params_value))
        .await
        .map_err(|e| format!("❌ Failed to get public link: {e}"))?;

    Ok(result)
}
