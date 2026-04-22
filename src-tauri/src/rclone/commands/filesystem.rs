use log::{debug, warn};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::rclone::backend::BackendManager;
use crate::rclone::commands::job::JobMetadata;
use crate::utils::rclone::endpoints::operations;
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
    origin: Option<crate::utils::types::origin::Origin>,
    group: Option<String>,
) -> Result<(), String> {
    let state = app.state::<RcloneState>();
    debug!("📁 Creating directory: remote={} path={}", remote, path);

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let url = backend.url_for(operations::MKDIR);

    let payload = json!({
        "fs": remote.clone(),
        "remote": path.clone(),
        "_async": true,
    });
    let _ = crate::rclone::commands::job::submit_job_with_options(
        app.clone(),
        state.client.clone(),
        backend.inject_auth(state.client.clone().post(&url)),
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
    origin: Option<crate::utils::types::origin::Origin>,
    group: Option<String>,
) -> Result<(), String> {
    let state = app.state::<RcloneState>();
    let path_val = path.as_deref().unwrap_or("").to_string();
    debug!(
        "🧹 Cleanup remote trash: remote={} path={}",
        remote, path_val
    );

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let url = backend.url_for(operations::CLEANUP);

    // Build parameters dynamically: include `remote` only when provided
    let mut payload = serde_json::Map::new();
    payload.insert("fs".to_string(), json!(remote));
    if let Some(ref p) = path {
        payload.insert("remote".to_string(), json!(p));
    }
    payload.insert("_async".to_string(), json!(true));

    let _ = crate::rclone::commands::job::submit_job_with_options(
        app.clone(),
        state.client.clone(),
        backend.inject_auth(state.client.clone().post(&url)),
        json!(payload),
        JobMetadata {
            remote_name: remote.clone(),
            job_type: JobType::Cleanup,
            source: build_full_path(&remote, &path_val),
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

//This command also supports to download files inside remote to. Useful for downloading URLs directly to remote storage.
#[tauri::command]
pub async fn copy_url(
    app: AppHandle,
    remote: String,
    path: String,
    url_to_copy: String,
    auto_filename: bool,
    origin: Option<crate::utils::types::origin::Origin>,
    group: Option<String>,
) -> Result<(), String> {
    let state = app.state::<RcloneState>();
    debug!(
        "🔗 Copying URL: remote={}, path={}, url={}, auto_filename={}",
        remote, path, url_to_copy, auto_filename
    );

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let url = backend.url_for(operations::COPYURL);

    let payload = json!({
        "fs": remote.clone(),
        "remote": path.clone(),
        "url": url_to_copy.clone(),
        "autoFilename": auto_filename,
        "_async": true,
    });
    let _ = crate::rclone::commands::job::submit_job_with_options(
        app.clone(),
        state.client.clone(),
        backend.inject_auth(state.client.clone().post(&url)),
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
) -> Result<String, String> {
    debug!(
        "🧹 Removing empty directories: remote={} path={}",
        remote, path
    );

    let inputs = vec![json!({
        "_path": operations::RMDIRS,
        "fs": remote,
        "remote": path,
        "leaveRoot": true,
        "_async": true,
    })];

    crate::rclone::commands::job::submit_batch_job(
        app,
        inputs,
        None,
        origin,
        group,
        JobType::Rmdirs,
    )
    .await
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
    let num_items = items.len();
    debug!(
        "📦 Transferring {} items to {}:{} (mode={})",
        num_items, dst_remote, dst_path, mode
    );

    let mut inputs = Vec::new();
    for item in items {
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
                    "_path": "copy",
                    "is_dir": true,
                    "srcFs": src_full,
                    "dstFs": dst_full,
                    "createEmptySrcDirs": true,
                }));
            } else {
                inputs.push(json!({
                    "_path": "copy",
                    "is_dir": false,
                    "srcFs": item.remote,
                    "srcRemote": item.path,
                    "dstFs": dst_remote.clone(),
                    "dstRemote": dst_file,
                }));
            }
        } else {
            // mode == "move"
            if item.is_dir {
                inputs.push(json!({
                    "_path": "rename",
                    "is_dir": true,
                    "srcFs": src_full,
                    "dstFs": dst_full,
                    "createEmptySrcDirs": true,
                    "deleteEmptySrcDirs": true,
                }));
            } else {
                inputs.push(json!({
                    "_path": "rename",
                    "is_dir": false,
                    "srcFs": item.remote,
                    "srcRemote": item.path,
                    "dstFs": dst_remote.clone(),
                    "dstRemote": dst_file,
                }));
            }
        }
    }

    let job_type = if mode == "move" {
        JobType::Move
    } else {
        JobType::Copy
    };

    crate::rclone::commands::job::submit_batch_job(app, inputs, None, origin, group, job_type).await
}

#[tauri::command]
pub async fn delete(
    app: AppHandle,
    items: Vec<FsItem>,
    origin: Option<Origin>,
    group: Option<String>,
) -> Result<String, String> {
    let num_items = items.len();
    debug!("🗑️ Deleting {} items", num_items);

    let mut inputs = Vec::new();
    for item in items {
        inputs.push(json!({
            "_path": "delete",
            "is_dir": item.is_dir,
            "fs": item.remote,
            "remote": item.path,
        }));
    }

    crate::rclone::commands::job::submit_batch_job(
        app,
        inputs,
        None,
        origin,
        group,
        JobType::Delete,
    )
    .await
}

#[tauri::command]
pub async fn upload_file(
    app: AppHandle,
    remote: String,
    path: String,
    filename: String,
    content: String,
) -> Result<String, String> {
    use crate::utils::rclone::endpoints::operations;
    use reqwest::multipart;

    let state = app.state::<RcloneState>();
    debug!(
        "⬆️ Uploading file: remote={} path={} filename={}",
        remote, path, filename
    );

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let url = backend.url_for(operations::UPLOADFILE);

    let part = multipart::Part::text(content)
        .file_name(filename.clone())
        .mime_str("text/plain")
        .map_err(|e| e.to_string())?;

    let form = multipart::Form::new().part("file", part);

    let response = backend
        .inject_auth(
            state
                .client
                .post(&url)
                .query(&[("fs", &remote), ("remote", &path)]),
        )
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Failed to send upload request: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!("Upload failed ({}): {}", status, body));
    }

    Ok("Upload successful".to_string())
}

#[tauri::command]
pub async fn upload_file_bytes(
    app: AppHandle,
    remote: String,
    path: String,
    filename: String,
    content: Vec<u8>,
) -> Result<String, String> {
    use crate::utils::rclone::endpoints::operations;
    use reqwest::multipart;

    let state = app.state::<RcloneState>();
    debug!(
        "⬆️ Uploading file bytes: remote={} path={} filename={} size={} bytes",
        remote,
        path,
        filename,
        content.len()
    );

    if filename.trim().is_empty() {
        return Err("Filename cannot be empty".to_string());
    }

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let url = backend.url_for(operations::UPLOADFILE);

    let part = multipart::Part::bytes(content)
        .file_name(filename.clone())
        .mime_str("application/octet-stream")
        .map_err(|e| e.to_string())?;

    let form = multipart::Form::new().part("file", part);

    let response = backend
        .inject_auth(
            state
                .client
                .post(&url)
                .query(&[("fs", &remote), ("remote", &path)]),
        )
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Failed to send upload request: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!("Upload failed ({}): {}", status, body));
    }

    Ok("Upload successful".to_string())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDropUploadResult {
    pub uploaded: usize,
    pub failed: Vec<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDropUploadFile {
    pub relative_path: String,
    pub filename: String,
    pub content: Vec<u8>,
}

#[derive(Debug, Clone)]
pub enum LocalDropUploadEntrySource {
    Bytes(Vec<u8>),
    Path(std::path::PathBuf),
    Directory,
}

pub struct LocalDropUploadEntry {
    pub relative_path: String,
    pub filename: String,
    pub size: usize,
    pub source: LocalDropUploadEntrySource,
}

fn join_remote_path(base: &str, relative: &str) -> String {
    let base = base.trim_matches('/');
    let relative = relative.trim_matches('/');

    if base.is_empty() {
        return relative.to_string();
    }
    if relative.is_empty() {
        return base.to_string();
    }

    format!("{base}/{relative}")
}

fn relative_unix_path(path: &std::path::Path) -> String {
    use std::path::Component;

    path.components()
        .filter_map(|c| match c {
            Component::Normal(name) => Some(name.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn build_upload_stats(
    transferred_bytes: usize,
    total_bytes: usize,
    completed_transfers: usize,
    total_transfers: usize,
    elapsed_secs: f64,
    current: Option<(&str, usize)>,
    remote: &str,
) -> serde_json::Value {
    let safe_elapsed = elapsed_secs.max(0.001);
    let speed = if transferred_bytes > 0 {
        transferred_bytes as f64 / safe_elapsed
    } else {
        0.0
    };
    let remaining_bytes = total_bytes.saturating_sub(transferred_bytes);
    let eta = if speed > 0.0 {
        (remaining_bytes as f64 / speed).ceil()
    } else {
        0.0
    };

    let transferring = current.map(|(name, size)| {
        json!([
            {
                "bytes": size,
                "dstFs": remote,
                "eta": eta,
                "group": format!("upload/{}", remote.trim_end_matches(':').trim_end_matches('/')),
                "name": name,
                "percentage": 100.0,
                "size": size,
                "speed": speed,
                "speedAvg": speed,
                "srcFs": "local",
            }
        ])
    });

    json!({
        "bytes": transferred_bytes,
        "checks": 0,
        "deletedDirs": 0,
        "deletes": 0,
        "elapsedTime": elapsed_secs,
        "errors": 0,
        "eta": eta,
        "fatalError": false,
        "lastError": "",
        "renames": 0,
        "retryError": false,
        "serverSideCopies": 0,
        "serverSideCopyBytes": 0,
        "serverSideMoveBytes": 0,
        "serverSideMoves": 0,
        "speed": speed,
        "totalBytes": total_bytes,
        "totalChecks": 0,
        "totalTransfers": total_transfers,
        "transferTime": elapsed_secs,
        "transferring": transferring.unwrap_or_else(|| json!([])),
        "transfers": completed_transfers,
    })
}

static UPLOAD_JOB_COUNTER: AtomicU64 = AtomicU64::new(0);

async fn next_upload_job_id(job_cache: &crate::utils::types::jobs::JobCache) -> u64 {
    // Lazy-initialize from the current cache max so we never collide with
    // rclone-assigned job IDs already in the cache.
    if UPLOAD_JOB_COUNTER.load(Ordering::Acquire) == 0 {
        let max = job_cache
            .get_jobs()
            .await
            .into_iter()
            .map(|job| job.jobid)
            .max()
            .unwrap_or(0)
            .saturating_add(1)
            .max(1); // never stays at 0

        // CAS: only the first winner writes; all subsequent callers skip.
        let _ = UPLOAD_JOB_COUNTER.compare_exchange(0, max, Ordering::Release, Ordering::Relaxed);
    }
    // Always unique — even if two callers race through initialization.
    UPLOAD_JOB_COUNTER.fetch_add(1, Ordering::SeqCst)
}

async fn create_upload_job(
    app: &AppHandle,
    remote: &str,
    path: &str,
    origin: Option<crate::utils::types::origin::Origin>,
    total_bytes: usize,
    total_transfers: usize,
) -> Result<u64, String> {
    use chrono::Utc;

    let backend_manager = app.state::<BackendManager>();
    let job_cache = &backend_manager.job_cache;
    let jobid = next_upload_job_id(job_cache).await;
    let remote_root = build_full_path(remote, path);
    let remote_name = remote
        .trim_end_matches(':')
        .trim_end_matches('/')
        .to_string();
    let stats = build_upload_stats(0, total_bytes, 0, total_transfers, 0.0, None, remote);

    job_cache
        .add_job(
            crate::utils::types::jobs::JobInfo {
                jobid,
                job_type: crate::utils::types::jobs::JobType::Upload,
                remote_name: remote.to_string(),
                source: remote_root.clone(),
                destination: "Upload batch".to_string(),
                start_time: Utc::now(),
                end_time: None,
                status: crate::utils::types::jobs::JobStatus::Running,
                error: None,
                stats: Some(stats),
                uploaded_files: Vec::new(),
                group: format!("upload/{remote_name}"),
                profile: None,
                execute_id: None,
                origin,
                backend_name: backend_manager.get_active().await.name.clone(),
                parent_batch_id: None,
            },
            Some(app),
        )
        .await;

    Ok(jobid)
}

fn split_remote_directory(path: &str) -> (String, String) {
    match path.rsplit_once('/') {
        Some((dir, name)) => (dir.to_string(), name.to_string()),
        None => (String::new(), path.to_string()),
    }
}

pub async fn upload_local_drop_entries(
    app: &AppHandle,
    remote: String,
    path: String,
    entries: Vec<LocalDropUploadEntry>,
    origin: Option<crate::utils::types::origin::Origin>,
) -> Result<LocalDropUploadResult, String> {
    use reqwest::multipart;
    use std::collections::HashSet;
    use std::time::Instant;

    let state = app.state::<RcloneState>();
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    let upload_url = backend.url_for(operations::UPLOADFILE);
    let mkdir_url = backend.url_for(operations::MKDIR);
    let job_cache = &backend_manager.job_cache;

    let total_bytes = entries.iter().map(|e| e.size).sum::<usize>();
    let total_transfers = entries.len();
    let jobid =
        create_upload_job(app, &remote, &path, origin, total_bytes, total_transfers).await?;
    let start = Instant::now();

    let mut created_directories: HashSet<String> = HashSet::new();
    let mut seen_paths: HashSet<String> = HashSet::new();
    let mut uploaded = 0usize;
    let mut failed: Vec<String> = Vec::new();
    let mut transferred_bytes = 0usize;

    for entry in entries {
        // Stop if the job was externally cancelled.
        if job_cache
            .get_job(jobid)
            .await
            .is_some_and(|job| job.status == crate::utils::types::jobs::JobStatus::Stopped)
        {
            return Ok(LocalDropUploadResult { uploaded, failed });
        }

        // ── NEW: deduplicate by relative_path ────────────────────────────────
        if !seen_paths.insert(entry.relative_path.clone()) {
            warn!(
                "⬆️ Skipping duplicate upload entry: {}",
                entry.relative_path
            );
            continue;
        }

        let destination = join_remote_path(&path, &entry.relative_path);

        // Handle explicit empty-directory entries.
        if matches!(entry.source, LocalDropUploadEntrySource::Directory) {
            if !destination.is_empty() && !created_directories.contains(&destination) {
                let mkdir_response = backend
                    .inject_auth(state.client.post(&mkdir_url))
                    .json(&serde_json::json!({ "fs": remote.clone(), "remote": destination }))
                    .send()
                    .await
                    .map_err(|e| format!("Failed to create directory: {}", e))?;

                if mkdir_response.status().is_success() {
                    created_directories.insert(destination.clone());
                    uploaded += 1;

                    let elapsed = start.elapsed().as_secs_f64();
                    let stats = build_upload_stats(
                        transferred_bytes,
                        total_bytes,
                        uploaded,
                        total_transfers,
                        elapsed,
                        Some((&entry.relative_path, 0)),
                        &remote,
                    );
                    let _ = job_cache
                        .update_job(
                            jobid,
                            |job| {
                                job.stats = Some(stats);
                                job.uploaded_files.push(destination);
                            },
                            Some(app),
                        )
                        .await;
                } else {
                    failed.push(entry.relative_path.clone());
                }
            }
            continue;
        }

        let (directory, filename) = split_remote_directory(&destination);

        // Ensure parent directory exists (idempotent, tracked in HashSet).
        if !directory.is_empty() && !created_directories.contains(&directory) {
            let mkdir_response = backend
                .inject_auth(state.client.post(&mkdir_url))
                .json(&serde_json::json!({ "fs": remote.clone(), "remote": directory }))
                .send()
                .await
                .map_err(|e| format!("Failed to create directory: {}", e))?;

            if mkdir_response.status().is_success() {
                created_directories.insert(directory.clone());
            }
        }

        let bytes = match entry.source {
            LocalDropUploadEntrySource::Bytes(content) => content,
            LocalDropUploadEntrySource::Path(ref path_buf) => {
                match tokio::fs::read(path_buf).await {
                    Ok(content) => content,
                    Err(_) => {
                        failed.push(path_buf.display().to_string());
                        continue;
                    }
                }
            }
            LocalDropUploadEntrySource::Directory => unreachable!(),
        };

        let part = multipart::Part::bytes(bytes)
            .file_name(filename.clone())
            .mime_str("application/octet-stream")
            .map_err(|e| e.to_string())?;
        let form = multipart::Form::new().part("file", part);

        let response = backend
            .inject_auth(
                state
                    .client
                    .post(&upload_url)
                    .query(&[("fs", &remote), ("remote", &directory)]),
            )
            .multipart(form)
            .send()
            .await
            .map_err(|e| format!("Failed to send upload request: {}", e))?;

        if response.status().is_success() {
            uploaded += 1;
            transferred_bytes += entry.size;

            let elapsed = start.elapsed().as_secs_f64();
            let stats = build_upload_stats(
                transferred_bytes,
                total_bytes,
                uploaded,
                total_transfers,
                elapsed,
                Some((entry.filename.as_str(), entry.size)),
                &remote,
            );
            let uploaded_file = destination.clone();
            let _ = job_cache
                .update_job(
                    jobid,
                    |job| {
                        job.stats = Some(stats);
                        job.uploaded_files.push(uploaded_file);
                    },
                    Some(app),
                )
                .await;
        } else {
            failed.push(entry.relative_path.clone());
        }
    }

    let success = failed.is_empty();
    let final_error = if success {
        None
    } else {
        Some(format!("{} file(s) failed to upload", failed.len()))
    };

    let _ = job_cache
        .complete_job(jobid, success, final_error, Some(app))
        .await;

    Ok(LocalDropUploadResult { uploaded, failed })
}

async fn collect_upload_entries_from_paths(
    local_paths: Vec<String>,
) -> Result<Vec<LocalDropUploadEntry>, String> {
    use std::path::PathBuf;
    use walkdir::WalkDir;

    let mut entries = Vec::new();

    for raw_path in local_paths {
        let root = PathBuf::from(&raw_path);
        if !root.exists() {
            continue;
        }

        let base_parent = root.parent().map(|p| p.to_path_buf());

        if root.is_dir() {
            for entry in WalkDir::new(&root).into_iter().filter_map(Result::ok) {
                let current = entry.path();
                let rel_path = if let Some(parent) = &base_parent {
                    current.strip_prefix(parent).unwrap_or(current)
                } else {
                    current
                };
                let relative_path = relative_unix_path(rel_path);

                if entry.file_type().is_dir() {
                    let is_empty = std::fs::read_dir(current)
                        .map(|mut i| i.next().is_none())
                        .unwrap_or(false);

                    if is_empty && !relative_path.is_empty() {
                        entries.push(LocalDropUploadEntry {
                            relative_path,
                            filename: String::new(),
                            size: 0,
                            source: LocalDropUploadEntrySource::Directory,
                        });
                    }
                    continue;
                }

                if !entry.file_type().is_file() {
                    continue;
                }

                if relative_path.is_empty() {
                    continue;
                }

                let filename = current
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                if filename.trim().is_empty() {
                    continue;
                }

                let size = entry.metadata().map_err(|e| e.to_string())?.len() as usize;
                entries.push(LocalDropUploadEntry {
                    relative_path,
                    filename,
                    size,
                    source: LocalDropUploadEntrySource::Path(current.to_path_buf()),
                });
            }
            continue;
        }

        let filename = root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if filename.trim().is_empty() {
            continue;
        }

        let size = root.metadata().map_err(|e| e.to_string())?.len() as usize;
        entries.push(LocalDropUploadEntry {
            relative_path: filename.clone(),
            filename,
            size,
            source: LocalDropUploadEntrySource::Path(root),
        });
    }

    Ok(entries)
}

#[tauri::command]
pub async fn upload_local_drop_paths(
    app: AppHandle,
    remote: String,
    path: String,
    local_paths: Vec<String>,
    origin: Option<crate::utils::types::origin::Origin>,
) -> Result<LocalDropUploadResult, String> {
    let entries = collect_upload_entries_from_paths(local_paths).await?;
    upload_local_drop_entries(&app, remote, path, entries, origin).await
}

#[tauri::command]
pub async fn upload_local_drop_files(
    app: AppHandle,
    remote: String,
    path: String,
    files: Vec<LocalDropUploadFile>,
    origin: Option<crate::utils::types::origin::Origin>,
) -> Result<LocalDropUploadResult, String> {
    let entries = files
        .into_iter()
        .map(|file| LocalDropUploadEntry {
            relative_path: file.relative_path,
            filename: file.filename,
            size: file.content.len(),
            source: LocalDropUploadEntrySource::Bytes(file.content),
        })
        .collect();

    upload_local_drop_entries(&app, remote, path, entries, origin).await
}

#[tauri::command]
pub async fn rename(
    app: AppHandle,
    items: Vec<RenameItem>,
    origin: Option<crate::utils::types::origin::Origin>,
    group: Option<String>,
) -> Result<String, String> {
    let num_items = items.len();
    debug!("🖊️ Renaming {} items", num_items);

    let mut inputs = Vec::new();
    for item in items {
        let src_full = build_full_path(&item.remote, &item.src_path);
        let dst_full = build_full_path(&item.remote, &item.dst_path);

        if item.is_dir {
            inputs.push(json!({
                "_path": "rename",
                "is_dir": true,
                "srcFs": src_full,
                "dstFs": dst_full,
                "createEmptySrcDirs": true,
                "deleteEmptySrcDirs": true,
            }));
        } else {
            inputs.push(json!({
                "_path": "rename",
                "is_dir": false,
                "srcFs": item.remote,
                "srcRemote": item.src_path,
                "dstFs": item.remote,
                "dstRemote": item.dst_path,
            }));
        }
    }

    crate::rclone::commands::job::submit_batch_job(
        app,
        inputs,
        None,
        origin,
        group,
        JobType::Rename,
    )
    .await
}
