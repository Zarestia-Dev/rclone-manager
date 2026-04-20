use log::debug;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::State;

use crate::rclone::commands::job::{JobMetadata, SubmitJobOptions, submit_job_with_options};
use crate::utils::{
    rclone::endpoints::operations,
    rclone::util::build_full_path,
    types::{
        core::{DiskUsage, RcloneState},
        jobs::{JobStatus, JobType},
        remotes::ListOptions,
    },
};

use crate::rclone::backend::BackendManager;
use tauri::{AppHandle, Manager};

async fn run_fs_command_as_job(
    app: AppHandle,
    endpoint: &str,
    mut payload: serde_json::Value,
    metadata: JobMetadata,
) -> Result<serde_json::Value, String> {
    use crate::utils::rclone::endpoints::job as job_endpoints;

    let state = app.state::<RcloneState>();
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let url = backend.url_for(endpoint);

    if let Some(obj) = payload.as_object_mut() {
        obj.insert("_async".to_string(), json!(true));
    }

    let (jobid, _, _) = submit_job_with_options(
        app.clone(),
        state.client.clone(),
        backend.inject_auth(state.client.clone().post(&url)),
        payload,
        metadata,
        SubmitJobOptions {
            wait_for_completion: true,
        },
    )
    .await?;

    if let Some(job) = backend_manager.job_cache.get_job(jobid).await
        && job.status == JobStatus::Stopped
    {
        return Err("Operation cancelled".to_string());
    }

    let status_url = backend.url_for(job_endpoints::STATUS);
    let response = backend
        .inject_auth(state.client.clone().post(&status_url))
        .json(&json!({ "jobid": jobid }))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch async job status: {e}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "Failed to read async job output ({}): {}",
            status, body
        ));
    }

    let value: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Invalid job status payload: {e}"))?;

    Ok(value.get("output").cloned().unwrap_or_else(|| json!({})))
}

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

#[derive(Debug, Deserialize)]
pub struct PublicLinkParams {
    pub unlink: Option<bool>,
    pub expire: Option<String>,
}

#[tauri::command]
pub async fn get_fs_info(
    app: AppHandle,
    remote: String,
    path: Option<String>,
    origin: Option<crate::utils::types::origin::Origin>,
    group: Option<String>,
) -> Result<serde_json::Value, String> {
    debug!("ℹ️ Getting fs info for remote: {remote}, path: {path:?}");

    let params = create_fs_params(remote.clone(), path.clone());

    let result = run_fs_command_as_job(
        app,
        operations::FSINFO,
        json!(params),
        JobMetadata {
            remote_name: remote.clone(),
            job_type: JobType::Info,
            operation_name: "Get FS Info".to_string(),
            source: build_full_path(&remote, path.as_deref().unwrap_or("")),
            destination: String::new(),
            profile: None,
            origin: origin.clone(),
            group,
            no_cache: true,
        },
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
    options: Option<ListOptions>,
    origin: Option<crate::utils::types::origin::Origin>,
    group: Option<String>,
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

    run_fs_command_as_job(
        app,
        operations::LIST,
        json!(params),
        JobMetadata {
            remote_name: remote.clone(),
            job_type: JobType::List,
            operation_name: "List Remote Paths".to_string(),
            source: build_full_path(&remote, path.as_deref().unwrap_or("")),
            destination: String::new(),
            profile: None,
            origin: origin.clone(),
            group,
            no_cache: true,
        },
    )
    .await
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
            let drive_path = format!("{}:\\", i as char);

            let app_clone = app.clone();
            let state_client = state.client.clone();

            let drive_path_for_closure = drive_path.clone();

            futures.push(async move {
                let params = create_fs_params(drive_path_for_closure.clone(), None);
                match run_fs_command(app_clone, state_client, operations::ABOUT, params).await {
                    Ok(_) => Some(LocalDrive {
                        name: drive_path_for_closure,
                        label: "nautilus.titles.localDisk".to_string(),
                        show_name: true,
                    }),
                    Err(_) => None,
                }
            });
        }

        let results = join_all(futures).await;
        drives.extend(results.into_iter().flatten());

        // Fallback if somehow none are detected
        if drives.is_empty() {
            drives.push(LocalDrive {
                name: "C:\\".to_string(),
                label: "nautilus.titles.localDisk".to_string(),
                show_name: true,
            });
        }
    } else {
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

        // Unix-like systems
        drives.push(LocalDrive {
            name: "/".to_string(),
            label: "nautilus.titles.fileSystem".to_string(),
            show_name: false,
        });
    }

    Ok(drives)
}

/// Get disk usage (async by default)
#[tauri::command]
pub async fn get_disk_usage(
    app: AppHandle,
    remote: String,
    path: Option<String>,
    origin: Option<crate::utils::types::origin::Origin>,
    group: Option<String>,
) -> Result<DiskUsage, String> {
    // Delegate to get_about_remote (which is now async)
    let json = get_about_remote(app, remote.clone(), path.clone(), origin, group).await?;

    // Extract usage information
    let total = json["total"].as_i64().unwrap_or(0);
    let used = json["used"].as_i64().unwrap_or(0);
    let free = json["free"].as_i64().unwrap_or(0);

    // Compute fs_path string for logging
    let fs_path = match path.as_deref() {
        Some(p) if !p.is_empty() => {
            if remote.is_empty() {
                p.to_string()
            } else {
                format!("{remote}{p}")
            }
        }
        _ => {
            if remote.is_empty() {
                "/".to_string()
            } else {
                remote
            }
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
    origin: Option<crate::utils::types::origin::Origin>,
    group: Option<String>,
) -> Result<serde_json::Value, String> {
    debug!("ℹ️ Getting about info for remote: {remote}, path: {path:?}");

    let params = create_fs_params(remote.clone(), path.clone());

    run_fs_command_as_job(
        app,
        operations::ABOUT,
        json!(params),
        JobMetadata {
            remote_name: remote.clone(),
            job_type: JobType::About,
            operation_name: "Get About".to_string(),
            source: build_full_path(&remote, path.as_deref().unwrap_or("")),
            destination: String::new(),
            profile: None,
            origin: origin.clone(),
            group,
            no_cache: true,
        },
    )
    .await
}

#[tauri::command]
pub async fn get_size(
    app: AppHandle,
    remote: String,
    path: Option<String>,
    origin: Option<crate::utils::types::origin::Origin>,
    group: Option<String>,
) -> Result<serde_json::Value, String> {
    debug!("📏 Getting size for remote: {remote}, path: {path:?}");

    let mut params = serde_json::Map::new();
    let fs_with_path = if let Some(p) = path {
        if p.is_empty() {
            remote.clone()
        } else if remote.ends_with('/') || remote.ends_with(':') {
            format!("{}{}", remote, p)
        } else {
            format!("{}/{}", remote, p)
        }
    } else {
        remote.clone()
    };
    params.insert("fs".to_string(), json!(fs_with_path));

    run_fs_command_as_job(
        app,
        operations::SIZE,
        json!(params),
        JobMetadata {
            remote_name: remote.clone(),
            job_type: JobType::Size,
            operation_name: "Calculate Size".to_string(),
            source: fs_with_path,
            destination: String::new(),
            profile: None,
            origin: origin.clone(),
            group,
            no_cache: true,
        },
    )
    .await
}

#[tauri::command]
pub async fn get_stat(
    app: AppHandle,
    remote: String,
    path: String,
    origin: Option<crate::utils::types::origin::Origin>,
    group: Option<String>,
) -> Result<serde_json::Value, String> {
    debug!("📊 Getting stats for remote: {remote}, path: {path}");

    // Convert (String, String) to (String, Option<String>) for helper
    let params = create_fs_params(remote.clone(), Some(path.clone()));

    run_fs_command_as_job(
        app,
        operations::STAT,
        json!(params),
        JobMetadata {
            remote_name: remote.clone(),
            job_type: JobType::Stat,
            operation_name: "Get Stat".to_string(),
            source: build_full_path(&remote, &path),
            destination: String::new(),
            profile: None,
            origin: origin.clone(),
            group,
            no_cache: true,
        },
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
    origin: Option<crate::utils::types::origin::Origin>,
    group: Option<String>,
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

    run_fs_command_as_job(
        app,
        operations::HASHSUM,
        json!(params),
        JobMetadata {
            remote_name: remote.clone(),
            job_type: JobType::Hash,
            operation_name: "Calculate Hashsum".to_string(),
            source: fs_with_path,
            destination: String::new(),
            profile: None,
            origin: origin.clone(),
            group,
            no_cache: true,
        },
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
    origin: Option<crate::utils::types::origin::Origin>,
    group: Option<String>,
) -> Result<serde_json::Value, String> {
    debug!("🔐 Getting hashsum file for remote: {remote}, path: {path}, hash_type: {hash_type}");

    let mut params = create_fs_params(remote.clone(), Some(path.clone()));
    params.insert("hashType".to_string(), json!(hash_type));

    run_fs_command_as_job(
        app,
        operations::HASHSUMFILE,
        json!(params),
        JobMetadata {
            remote_name: remote.clone(),
            job_type: JobType::Hash,
            operation_name: "Calculate File Hash".to_string(),
            source: build_full_path(&remote, &path),
            destination: String::new(),
            profile: None,
            origin: origin.clone(),
            group,
            no_cache: true,
        },
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
    options: Option<PublicLinkParams>,
    origin: Option<crate::utils::types::origin::Origin>,
    group: Option<String>,
) -> Result<serde_json::Value, String> {
    debug!("🔗 Getting public link for remote: {remote}, path: {path}, options: {options:?}",);

    let mut params = create_fs_params(remote.clone(), Some(path.clone()));

    if let Some(opts) = options {
        if let Some(should_unlink) = opts.unlink {
            params.insert("unlink".to_string(), json!(should_unlink));
        }
        if let Some(expire) = opts.expire {
            params.insert("expire".to_string(), json!(expire));
        }
    }

    run_fs_command_as_job(
        app,
        operations::PUBLICLINK,
        json!(params),
        JobMetadata {
            remote_name: remote.clone(),
            job_type: JobType::Info,
            operation_name: "Get Public Link".to_string(),
            source: build_full_path(&remote, &path),
            destination: String::new(),
            profile: None,
            origin,
            group,
            no_cache: true,
        },
    )
    .await
}
