use log::debug;

use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::rclone::backend::BackendManager;
use crate::rclone::commands::job::JobMetadata;
use crate::utils::app::notification::notify;
use crate::utils::rclone::endpoints::{operations, sync};
use crate::utils::rclone::util::build_full_path;
use crate::utils::types::{core::RcloneState, jobs::JobType, origin::Origin};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsItem {
    pub remote: String,
    pub path: String,
    #[serde(default)]
    pub name: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameItem {
    pub remote: String,
    pub src_path: String,
    pub dst_path: String,
    pub is_dir: bool,
}

#[tauri::command]
pub async fn mkdir(
    app: AppHandle,
    remote: String,
    path: String,
    origin: Option<Origin>,
    group: Option<String>,
) -> Result<(), String> {
    let state = app.state::<RcloneState>();
    debug!("mkdir: remote={remote} path={path}");

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let url = backend.url_for(operations::MKDIR);

    let payload = json!({
        "fs": &remote,
        "remote": &path,
        "_async": true,
    });

    let _ = crate::rclone::commands::job::submit_job_with_options(
        app.clone(),
        state.client.clone(),
        backend.inject_auth(state.client.post(&url)),
        payload,
        JobMetadata {
            remote_name: remote.clone(),
            job_type: JobType::Mkdir,
            source: build_full_path(&remote, &path),
            destination: String::new(),
            profile: None,
            origin,
            group,
            no_cache: true,
        },
        crate::rclone::commands::job::SubmitJobOptions {
            wait_for_completion: true,
        },
    )
    .await?;

    Ok(())
}

#[tauri::command]
pub async fn cleanup(
    app: AppHandle,
    remote: String,
    path: Option<String>,
    origin: Option<Origin>,
    group: Option<String>,
) -> Result<(), String> {
    let state = app.state::<RcloneState>();
    let path_str = path.as_deref().unwrap_or("");
    debug!("cleanup: remote={remote} path={path_str}");

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let url = backend.url_for(operations::CLEANUP);

    let mut payload = serde_json::Map::new();
    payload.insert("fs".to_string(), json!(&remote));
    if let Some(ref p) = path {
        payload.insert("remote".to_string(), json!(p));
    }
    payload.insert("_async".to_string(), json!(true));

    let _ = crate::rclone::commands::job::submit_job_with_options(
        app.clone(),
        state.client.clone(),
        backend.inject_auth(state.client.post(&url)),
        json!(payload),
        JobMetadata {
            remote_name: remote.clone(),
            job_type: JobType::Cleanup,
            source: build_full_path(&remote, path_str),
            destination: String::new(),
            profile: None,
            origin,
            group,
            no_cache: true,
        },
        crate::rclone::commands::job::SubmitJobOptions {
            wait_for_completion: true,
        },
    )
    .await?;

    Ok(())
}

#[tauri::command]
pub async fn copy_url(
    app: AppHandle,
    remote: String,
    path: String,
    url_to_copy: String,
    auto_filename: bool,
    origin: Option<Origin>,
    group: Option<String>,
) -> Result<(), String> {
    let state = app.state::<RcloneState>();
    debug!("copy_url: remote={remote} path={path} url={url_to_copy}");

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let url = backend.url_for(operations::COPYURL);

    let payload = json!({
        "fs": &remote,
        "remote": &path,
        "url": &url_to_copy,
        "autoFilename": auto_filename,
        "_async": true,
    });

    let _ = crate::rclone::commands::job::submit_job_with_options(
        app.clone(),
        state.client.clone(),
        backend.inject_auth(state.client.post(&url)),
        payload,
        JobMetadata {
            remote_name: remote.clone(),
            job_type: JobType::CopyUrl,
            source: url_to_copy,
            destination: build_full_path(&remote, &path),
            profile: None,
            origin,
            group,
            no_cache: false,
        },
        crate::rclone::commands::job::SubmitJobOptions {
            wait_for_completion: true,
        },
    )
    .await?;

    Ok(())
}

#[tauri::command]
pub async fn remove_empty_dirs(
    app: AppHandle,
    remote: String,
    path: String,
    origin: Option<Origin>,
    group: Option<String>,
) -> Result<(), String> {
    let state = app.state::<RcloneState>();
    debug!("remove_empty_dirs: remote={remote} path={path}");

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let url = backend.url_for(operations::RMDIRS);

    let payload = json!({
        "fs": &remote,
        "remote": &path,
        "leaveRoot": true,
        "_async": true,
    });

    let _ = crate::rclone::commands::job::submit_job_with_options(
        app.clone(),
        state.client.clone(),
        backend.inject_auth(state.client.post(&url)),
        payload,
        JobMetadata {
            remote_name: remote.clone(),
            job_type: JobType::Rmdirs,
            source: build_full_path(&remote, &path),
            destination: String::new(),
            profile: None,
            origin,
            group,
            no_cache: true,
        },
        crate::rclone::commands::job::SubmitJobOptions {
            wait_for_completion: true,
        },
    )
    .await?;

    Ok(())
}

#[tauri::command]
pub async fn transfer(
    app: AppHandle,
    items: Vec<FsItem>,
    dst_remote: String,
    dst_path: String,
    mode: String,
    origin: Option<Origin>,
    group: Option<String>,
) -> Result<String, String> {
    debug!(
        "transfer: {} items to {dst_remote}:{dst_path} (mode={mode})",
        items.len()
    );

    let mut inputs = Vec::new();
    for item in &items {
        let dst_file = if dst_path.is_empty() {
            item.name.clone()
        } else {
            format!("{}/{}", dst_path.trim_end_matches('/'), item.name)
        };

        let src_full = build_full_path(&item.remote, &item.path);
        let dst_full = build_full_path(&dst_remote, &dst_file);

        if mode == "copy" {
            if item.is_dir {
                inputs.push(json!({
                    "_path": sync::COPY,
                    "srcFs": src_full,
                    "dstFs": dst_full,
                    "createEmptySrcDirs": true,
                }));
            } else {
                inputs.push(json!({
                    "_path": operations::COPYFILE,
                    "srcFs": item.remote,
                    "srcRemote": item.path,
                    "dstFs": dst_remote.clone(),
                    "dstRemote": dst_file,
                }));
            }
        } else if item.is_dir {
            inputs.push(json!({
                "_path": sync::MOVE,
                "srcFs": src_full,
                "dstFs": dst_full,
                "createEmptySrcDirs": true,
                "deleteEmptySrcDirs": true,
            }));
        } else {
            inputs.push(json!({
                "_path": operations::MOVEFILE,
                "srcFs": item.remote,
                "srcRemote": item.path,
                "dstFs": dst_remote.clone(),
                "dstRemote": dst_file,
            }));
        }
    }

    let job_type = if mode == "move" {
        JobType::Move
    } else {
        JobType::Copy
    };

    let (remote_name, source) = if items.len() == 1 {
        (items[0].remote.clone(), items[0].path.clone())
    } else {
        ("multiple".to_string(), format!("{} items", items.len()))
    };

    crate::rclone::commands::job::submit_batch_job(
        app,
        inputs,
        JobMetadata {
            remote_name,
            job_type,
            source,
            destination: format!("{}:{}", dst_remote, dst_path),
            profile: None,
            origin,
            group,
            no_cache: false,
        },
    )
    .await
}

#[tauri::command]
pub async fn delete(
    app: AppHandle,
    items: Vec<FsItem>,
    origin: Option<Origin>,
    group: Option<String>,
) -> Result<String, String> {
    debug!("delete: {} items", items.len());

    let mut inputs = Vec::new();
    for item in &items {
        let endpoint = if item.is_dir {
            operations::PURGE
        } else {
            operations::DELETEFILE
        };
        inputs.push(json!({ "_path": endpoint, "fs": item.remote, "remote": item.path }));
    }

    let (remote_name, source) = if items.len() == 1 {
        (items[0].remote.clone(), items[0].path.clone())
    } else {
        ("multiple".to_string(), format!("{} items", items.len()))
    };

    crate::rclone::commands::job::submit_batch_job(
        app,
        inputs,
        JobMetadata {
            remote_name,
            job_type: JobType::Delete,
            source,
            destination: "trash".to_string(),
            profile: None,
            origin,
            group,
            no_cache: false,
        },
    )
    .await
}

async fn discover_upload_entries(
    local_paths: &[String],
    remote_path: &str,
) -> Vec<(std::path::PathBuf, String)> {
    let mut entries = Vec::new();
    for raw in local_paths {
        let p = std::path::PathBuf::from(raw);
        if !p.exists() {
            continue;
        }

        let top_name = p
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        if p.is_file() {
            entries.push((p, remote_path.to_string()));
        } else if p.is_dir() {
            for entry in walkdir::WalkDir::new(&p)
                .min_depth(1)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file())
            {
                let rel = entry
                    .path()
                    .strip_prefix(&p)
                    .unwrap_or(entry.path())
                    .parent()
                    .unwrap_or(std::path::Path::new(""))
                    .to_string_lossy()
                    .to_string();
                let base = if remote_path.is_empty() {
                    top_name.clone()
                } else {
                    format!("{}/{}", remote_path.trim_end_matches('/'), top_name)
                };
                let remote_dir = if rel.is_empty() {
                    base
                } else {
                    format!("{}/{}", base, rel.replace('\\', "/"))
                };
                entries.push((entry.path().to_path_buf(), remote_dir));
            }
        }
    }
    entries
}

pub struct UploadBatchParams {
    pub remote: String,
    pub path: String,
    pub local_paths: Vec<String>,
    pub origin: Option<Origin>,
    pub group: Option<String>,
    pub cleanup_dir: Option<std::path::PathBuf>,
    pub existing_jobid: Option<u64>,
}

pub async fn execute_upload_batch(
    app: AppHandle,
    params: UploadBatchParams,
) -> Result<String, String> {
    let UploadBatchParams {
        remote,
        path,
        local_paths,
        origin,
        group,
        cleanup_dir,
        existing_jobid,
    } = params;

    debug!(
        "execute_upload_batch: {} paths to {remote}:{path}",
        local_paths.len()
    );

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let client = app.state::<RcloneState>().client.clone();
    let job_cache = &backend_manager.job_cache;

    let file_entries = discover_upload_entries(&local_paths, &path).await;
    if file_entries.is_empty() {
        if let Some(dir) = cleanup_dir {
            let _ = tokio::fs::remove_dir_all(dir).await;
        }
        return Err("No valid files found to upload".to_string());
    }

    let total_bytes: u64 =
        futures::future::join_all(file_entries.iter().map(|(p, _)| tokio::fs::metadata(p)))
            .await
            .into_iter()
            .filter_map(|m| m.ok())
            .map(|m| m.len())
            .sum();

    let destination = build_full_path(&remote, &path);
    let jobid = existing_jobid
        .unwrap_or_else(|| chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0) as u64);
    let metadata = JobMetadata {
        remote_name: remote.clone(),
        job_type: JobType::Upload,
        source: "local paths".to_string(),
        destination,
        profile: None,
        origin: origin.clone(),
        group,
        no_cache: false,
    };

    if existing_jobid.is_none() {
        job_cache
            .create_job(
                jobid,
                None,
                metadata.clone(),
                backend.name.clone(),
                Some(&app),
            )
            .await;
    }

    if metadata.origin != Some(Origin::Scheduler) {
        notify(&app, metadata.started_event(backend.name.clone()));
    }

    let mut uploaded_bytes = 0u64;
    let mut completed = Vec::new();
    let mut errors = Vec::new();

    for (file_path, remote_dir) in file_entries {
        let filename = file_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let file = match tokio::fs::File::open(&file_path).await {
            Ok(f) => f,
            Err(e) => {
                errors.push(format!("Failed to open {filename}: {e}"));
                continue;
            }
        };

        let size = file.metadata().await.map(|m| m.len()).unwrap_or(0);
        let part = reqwest::multipart::Part::stream(reqwest::Body::wrap_stream(
            tokio_util::io::ReaderStream::new(file),
        ))
        .file_name(filename.clone())
        .mime_str("application/octet-stream")
        .map_err(|e| e.to_string())?;

        let resp = backend
            .inject_auth(
                client
                    .post(backend.url_for(operations::UPLOADFILE))
                    .query(&[("fs", &remote), ("remote", &remote_dir)]),
            )
            .multipart(reqwest::multipart::Form::new().part("file", part))
            .send()
            .await;

        match resp {
            Ok(r) if r.status().is_success() => {
                uploaded_bytes += size;
                completed.push(json!({ "name": filename, "size": size, "bytes": size, "completed_at": chrono::Utc::now() }));
                let _ = job_cache.update_job_stats(jobid, json!({ "totalBytes": total_bytes, "bytes": uploaded_bytes, "transfers": completed.len(), "totalTransfers": completed.len(), "completed": completed, "transferring": [] })).await;
            }
            Ok(r) => errors.push(format!("Upload failed for {filename}: {}", r.status())),
            Err(e) => errors.push(format!("Network error for {filename}: {e}")),
        }
    }

    let success = errors.is_empty();
    let error_msg = (!success).then(|| format!("{} failed: {}", errors.len(), errors.join("; ")));

    if metadata.origin != Some(Origin::Scheduler) {
        if success {
            notify(&app, metadata.completed_event(backend.name.clone()));
        } else if let Some(ref m) = error_msg {
            notify(&app, metadata.failed_event(backend.name.clone(), m));
        }
    }

    let _ = job_cache
        .complete_job(jobid, success, error_msg.clone(), Some(&app))
        .await;
    if let Some(dir) = cleanup_dir {
        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    error_msg.map_or(Ok(jobid.to_string()), Err)
}

#[tauri::command]
pub async fn upload_local_drop_paths(
    app: AppHandle,
    remote: String,
    path: String,
    local_paths: Vec<String>,
    origin: Option<Origin>,
    group: Option<String>,
) -> Result<String, String> {
    execute_upload_batch(
        app,
        UploadBatchParams {
            remote,
            path,
            local_paths,
            origin,
            group,
            cleanup_dir: None,
            existing_jobid: None,
        },
    )
    .await
}

#[tauri::command]
pub async fn rename(
    app: AppHandle,
    items: Vec<RenameItem>,
    origin: Option<Origin>,
    group: Option<String>,
) -> Result<String, String> {
    debug!("rename: {} items", items.len());

    let mut inputs = Vec::new();
    for item in &items {
        let src_full = build_full_path(&item.remote, &item.src_path);
        let dst_full = build_full_path(&item.remote, &item.dst_path);

        if item.is_dir {
            inputs.push(json!({
                "_path": sync::MOVE,
                "srcFs": src_full,
                "dstFs": dst_full,
                "createEmptySrcDirs": true,
                "deleteEmptySrcDirs": true,
            }));
        } else {
            inputs.push(json!({
                "_path": operations::MOVEFILE,
                "srcFs": item.remote,
                "srcRemote": item.src_path,
                "dstFs": item.remote,
                "dstRemote": item.dst_path,
            }));
        }
    }

    let (remote_name, source) = if items.len() == 1 {
        (items[0].remote.clone(), items[0].src_path.clone())
    } else {
        ("multiple".to_string(), format!("{} items", items.len()))
    };

    crate::rclone::commands::job::submit_batch_job(
        app,
        inputs,
        JobMetadata {
            remote_name,
            job_type: JobType::Rename,
            source,
            destination: "multiple items".to_string(),
            profile: None,
            origin,
            group,
            no_cache: false,
        },
    )
    .await
}
