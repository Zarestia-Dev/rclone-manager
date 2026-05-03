use log::debug;
use serde::{Deserialize, Serialize};
use serde_json::json;

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
            "Failed to read async job output ({status}): {body}"
        ));
    }

    let value: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Invalid job status payload: {e}"))?;

    Ok(value.get("output").cloned().unwrap_or_else(|| json!({})))
}

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
    id: String,
    name: String,
    label: String,
    show_name: bool,
    total_space: u64,
    available_space: u64,
    file_system: String,
    is_removable: bool,
    mount_point: String,
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
    let source = build_full_path(&remote, path.as_deref().unwrap_or(""));

    let data = run_fs_command_as_job(
        app,
        operations::FSINFO,
        json!(params),
        JobMetadata {
            remote_name: remote,
            job_type: JobType::Info,
            source,
            destination: String::new(),
            profile: None,
            origin,
            group,
            no_cache: true,
        },
    )
    .await?;

    let data = {
        let mut data = data;
        use crate::utils::json_helpers::normalize_windows_path;
        if let Some(root) = data.get_mut("Root")
            && let Some(root_str) = root.as_str()
        {
            *root = json!(normalize_windows_path(root_str));
        }
        data
    };

    Ok(data)
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
        let opt: serde_json::Map<String, serde_json::Value> =
            list_options.extra.into_iter().collect();
        params.insert("opt".to_string(), json!(opt));
    }

    run_fs_command_as_job(
        app,
        operations::LIST,
        json!(params),
        JobMetadata {
            remote_name: remote.clone(),
            job_type: JobType::List,
            source: build_full_path(&remote, path.as_deref().unwrap_or("")),
            destination: String::new(),
            profile: None,
            origin,
            group,
            no_cache: true,
        },
    )
    .await
}

#[tauri::command]
pub async fn get_local_drives(app: AppHandle) -> Result<Vec<LocalDrive>, String> {
    let state = app.state::<RcloneState>();
    use crate::utils::rclone::endpoints::core;
    use std::collections::HashMap;
    use sysinfo::Disks;

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    let response = backend
        .post_json(&state.client, core::DISKS, None)
        .await
        .map_err(|e| format!("❌ Failed to call {}: {e}", core::DISKS))?;

    let disks_paths = response
        .get("disks")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "Invalid core/disks response: missing 'disks' array".to_string())?;

    let home = std::env::var("HOME").ok();

    // Refresh disk information
    let sys_disks = Disks::new_with_refreshed_list();

    #[cfg(target_os = "linux")]
    let labels = {
        use std::process::Command;
        let mut map = HashMap::new();
        if let Ok(output) = Command::new("lsblk").args(["-no", "KNAME,LABEL"]).output() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let mut parts = line.splitn(2, |c: char| c.is_whitespace());
                if let (Some(kname), Some(label)) = (parts.next(), parts.next()) {
                    let label = label.trim();
                    if !label.is_empty() {
                        map.insert(format!("/dev/{}", kname), label.to_string());
                    }
                }
            }
        }
        map
    };

    let drives = disks_paths
        .iter()
        .filter_map(|value| value.as_str())
        .map(|path| {
            let normalized_path = {
                let mut p = path.to_string();
                // Normalize Windows drive letters (e.g., "C:") to root paths (e.g., "C:\")
                // This ensures rclone lists the root directory instead of the current working directory of the drive.
                if p.len() == 2
                    && p.ends_with(':')
                    && p.chars()
                        .next()
                        .map(|c| c.is_ascii_alphabetic())
                        .unwrap_or(false)
                {
                    p.push('\\');
                }
                p
            };

            // Find a matching disk in sysinfo by mount point
            let sys_disk = sys_disks.iter().find(|d| {
                let mp = d.mount_point().to_string_lossy();
                mp == normalized_path
                    || mp == format!("{normalized_path}/")
                    || format!("{mp}/") == format!("{normalized_path}/")
            });

            let folder_name = normalized_path
                .split(['/', '\\'])
                .next_back()
                .unwrap_or("")
                .to_string();

            let is_home = Some(normalized_path.as_str()) == home.as_deref()
                || (normalized_path.starts_with("C:\\Users\\")
                    && normalized_path.split('\\').count() == 3)
                || (normalized_path.starts_with("/Users/")
                    && normalized_path.split('/').count() == 3);

            let (label, show_name) = if is_home {
                ("titlebar.home".to_string(), false)
            } else if normalized_path == "/" || normalized_path == "C:\\" {
                ("nautilus.titles.fileSystem".to_string(), false)
            } else {
                let mut drive_label = None;
                if let Some(d) = sys_disk {
                    let name = d.name().to_string_lossy();
                    #[cfg(target_os = "linux")]
                    {
                        if let Some(l) = labels.get(name.as_ref()) {
                            drive_label = Some(l.clone());
                        }
                    }
                    #[cfg(not(target_os = "linux"))]
                    {
                        if !name.is_empty() && !name.starts_with("\\\\") {
                            drive_label = Some(name.into_owned());
                        }
                    }
                }

                if let Some(l) = drive_label {
                    (l, false)
                } else if normalized_path.starts_with(home.as_deref().unwrap_or(""))
                    && !folder_name.is_empty()
                {
                    (folder_name, false)
                } else if let Some(d) = sys_disk {
                    (d.name().to_string_lossy().into_owned(), false)
                } else if !folder_name.is_empty() {
                    (folder_name, false)
                } else {
                    ("nautilus.titles.localDisk".to_string(), false)
                }
            };

            let id = sys_disk
                .map(|d| d.name().to_string_lossy().into_owned())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| normalized_path.to_string());

            LocalDrive {
                id,
                name: normalized_path.to_string(),
                label,
                show_name,
                total_space: sys_disk.map(|d| d.total_space()).unwrap_or(0),
                available_space: sys_disk.map(|d| d.available_space()).unwrap_or(0),
                file_system: sys_disk
                    .map(|d| d.file_system().to_string_lossy().into_owned())
                    .unwrap_or_default(),
                is_removable: sys_disk.map(|d| d.is_removable()).unwrap_or(false),
                mount_point: normalized_path,
            }
        })
        .collect();

    Ok(drives)
}

#[tauri::command]
pub async fn get_disk_usage(
    app: AppHandle,
    remote: String,
    path: Option<String>,
    origin: Option<crate::utils::types::origin::Origin>,
    group: Option<String>,
) -> Result<DiskUsage, String> {
    let json = get_about_remote(app, remote.clone(), path.clone(), origin, group).await?;

    let total = json["total"].as_i64().unwrap_or(0);
    let used = json["used"].as_i64().unwrap_or(0);
    let free = json["free"].as_i64().unwrap_or(0);

    let fs_path = build_full_path(&remote, path.as_deref().unwrap_or(""));
    debug!("💾 Disk Usage for {fs_path}: total={total} used={used} free={free}");

    Ok(DiskUsage { free, used, total })
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
    let source = build_full_path(&remote, path.as_deref().unwrap_or(""));

    run_fs_command_as_job(
        app,
        operations::ABOUT,
        json!(params),
        JobMetadata {
            remote_name: remote,
            job_type: JobType::About,
            source,
            destination: String::new(),
            profile: None,
            origin,
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

    let fs_with_path = build_full_path(&remote, path.as_deref().unwrap_or(""));
    let mut params = serde_json::Map::new();
    params.insert("fs".to_string(), json!(fs_with_path));

    run_fs_command_as_job(
        app,
        operations::SIZE,
        json!(params),
        JobMetadata {
            remote_name: remote,
            job_type: JobType::Size,
            source: fs_with_path,
            destination: String::new(),
            profile: None,
            origin,
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

    let params = create_fs_params(remote.clone(), Some(path.clone()));

    run_fs_command_as_job(
        app,
        operations::STAT,
        json!(params),
        JobMetadata {
            remote_name: remote.clone(),
            job_type: JobType::Stat,
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

    let fs_with_path = build_full_path(&remote, &path);
    let mut params = serde_json::Map::new();
    params.insert("fs".to_string(), json!(fs_with_path));
    params.insert("hashType".to_string(), json!(hash_type));

    run_fs_command_as_job(
        app,
        operations::HASHSUM,
        json!(params),
        JobMetadata {
            remote_name: remote,
            job_type: JobType::Hash,
            source: fs_with_path,
            destination: String::new(),
            profile: None,
            origin,
            group,
            no_cache: true,
        },
    )
    .await
}

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

#[tauri::command]
pub async fn get_public_link(
    app: AppHandle,
    remote: String,
    path: String,
    options: Option<PublicLinkParams>,
    origin: Option<crate::utils::types::origin::Origin>,
    group: Option<String>,
) -> Result<serde_json::Value, String> {
    debug!("🔗 Getting public link for remote: {remote}, path: {path}, options: {options:?}");

    let mut params = create_fs_params(remote.clone(), Some(path.clone()));

    if let Some(opts) = options {
        if let Some(unlink) = opts.unlink {
            params.insert("unlink".to_string(), json!(unlink));
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
