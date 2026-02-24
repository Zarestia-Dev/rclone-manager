use log::debug;
use serde::Serialize;
use serde_json::json;
use tauri::State;

use crate::utils::{
    rclone::endpoints::operations,
    types::{
        core::{DiskUsage, RcloneState},
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
    params: serde_json::Map<String, serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let payload = json!(params);
    backend
        .post_json(&client, endpoint, Some(&payload))
        .await
        .map_err(|e| format!("❌ Failed to call {endpoint}: {e}"))
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
    show_name: bool,
}

#[tauri::command]
pub async fn get_fs_info(
    app: AppHandle,
    remote: String,
    path: Option<String>,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    debug!("ℹ️ Getting fs info for remote: {remote}, path: {path:?}");

    let params = create_fs_params(remote.clone(), path.clone());

    let result = run_fs_command(app, state.client.clone(), operations::FSINFO, params).await;

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
    options: Option<ListOptions>,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    debug!("📂 Listing remote paths for remote: {remote}, path: {path:?}");
    let mut params = create_fs_params(remote.clone(), path.clone());

    if let Some(list_options) = options {
        let mut opt = serde_json::Map::new();
        for (key, value) in list_options.extra {
            opt.insert(key, value);
        }
        params.insert("opt".to_string(), json!(opt));
    }

    run_fs_command(app, state.client.clone(), operations::LIST, params).await
}

#[tauri::command]
pub async fn get_local_drives(
    app: AppHandle,
    state: State<'_, RcloneState>,
) -> Result<Vec<LocalDrive>, String> {
    use crate::utils::rclone::endpoints::{core, operations};
    use futures::future::join_all;

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    // 1. Get remote OS
    let version_res = backend.post_json(&state.client, core::VERSION, None).await;

    let os = match version_res {
        Ok(v) => v
            .get("os")
            .and_then(|o| o.as_str())
            .unwrap_or("unknown")
            .to_string(),
        Err(_) => std::env::consts::OS.to_string(), // Fallback
    };

    let mut drives = Vec::new();

    if os == "windows" {
        let mut futures = Vec::new();
        // Probe A: through Z:
        for i in b'A'..=b'Z' {
            let drive_name = format!("{}:", i as char);
            let drive_path = format!("{}:\\", i as char);

            let app_clone = app.clone();
            let state_client = state.client.clone();
            let drive_name_clone = drive_name.clone();

            futures.push(async move {
                let params = create_fs_params(drive_path, None);
                let res = run_fs_command(app_clone, state_client, operations::ABOUT, params).await;
                if res.is_ok() {
                    Some(LocalDrive {
                        name: drive_name_clone,
                        label: "nautilus.titles.localDisk".to_string(),
                        show_name: true,
                    })
                } else {
                    None
                }
            });
        }

        let results = join_all(futures).await;
        for res in results.into_iter().flatten() {
            drives.push(res);
        }

        // Fallback if somehow none are detected
        if drives.is_empty() {
            drives.push(LocalDrive {
                name: "C:".to_string(),
                label: "nautilus.titles.localDisk".to_string(),
                show_name: true,
            });
        }
    } else {
        // Unix-like systems
        drives.push(LocalDrive {
            name: "/".to_string(),
            label: "nautilus.titles.fileSystem".to_string(),
            show_name: false,
        });

        // Attempt to get home dir. If it's local, we can use the environment.
        let home_path = if backend.is_local {
            std::env::var("HOME").ok()
        } else {
            None
        };

        if let Some(path) = home_path {
            drives.push(LocalDrive {
                name: path,
                label: "titlebar.home".to_string(),
                show_name: false,
            });
        }
    }

    Ok(drives)
}

/// Get disk usage (async by default)
#[tauri::command]
pub async fn get_disk_usage(
    app: AppHandle,
    remote: String,
    path: Option<String>,
    state: State<'_, RcloneState>,
) -> Result<DiskUsage, String> {
    // Delegate to get_about_remote (which is now async)
    let json = get_about_remote(app, remote.clone(), path.clone(), state).await?;

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
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    debug!("ℹ️ Getting about info for remote: {remote}, path: {path:?}");

    let params = create_fs_params(remote.clone(), path.clone());

    run_fs_command(app, state.client.clone(), operations::ABOUT, params).await
}

#[tauri::command]
pub async fn get_size(
    app: AppHandle,
    remote: String,
    path: Option<String>,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    debug!("📏 Getting size for remote: {remote}, path: {path:?}");

    let params = create_fs_params(remote.clone(), path.clone());

    run_fs_command(app, state.client.clone(), operations::SIZE, params).await
}

#[tauri::command]
pub async fn get_stat(
    app: AppHandle,
    remote: String,
    path: String,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    debug!("📊 Getting stats for remote: {remote}, path: {path}");

    // Convert (String, String) to (String, Option<String>) for helper
    let params = create_fs_params(remote.clone(), Some(path.clone()));

    run_fs_command(app, state.client.clone(), operations::STAT, params).await
}

/// Get hashsum for a path (file or directory)
/// Returns list of hashes
#[tauri::command]
pub async fn get_hashsum(
    app: AppHandle,
    remote: String,
    path: String,
    hash_type: String,
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

    run_fs_command(app, state.client.clone(), operations::HASHSUM, params).await
}

/// Get hashsum for a single file
/// Returns the hash of the file using the specified hash type
#[tauri::command]
pub async fn get_hashsum_file(
    app: AppHandle,
    remote: String,
    path: String,
    hash_type: String,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    debug!("🔐 Getting hashsum file for remote: {remote}, path: {path}, hash_type: {hash_type}");

    let mut params = create_fs_params(remote.clone(), Some(path.clone()));
    params.insert("hashType".to_string(), json!(hash_type));

    run_fs_command(app, state.client.clone(), operations::HASHSUMFILE, params).await
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
