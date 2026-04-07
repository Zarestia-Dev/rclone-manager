use log::debug;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::rclone::backend::BackendManager;
use crate::rclone::commands::job::{JobMetadata, submit_job};
use crate::utils::rclone::endpoints::{operations, sync};
use crate::utils::rclone::util::build_full_path;
use crate::utils::types::{core::RcloneState, jobs::JobType};

#[tauri::command]
pub async fn mkdir(
    app: AppHandle,
    remote: String,
    path: String,
    source: Option<String>,
    no_cache: Option<bool>,
) -> Result<u64, String> {
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

    let (jobid, _, _) = submit_job(
        app.clone(),
        state.client.clone(),
        backend.inject_auth(state.client.clone().post(&url)),
        payload,
        JobMetadata {
            remote_name: remote.clone(),
            job_type: JobType::Mkdir,
            operation_name: "Create Directory".to_string(),
            source: build_full_path(&remote, &path),
            destination: String::new(),
            profile: None,
            origin: source
                .as_deref()
                .map(crate::utils::types::origin::Origin::parse),
            group: None,
            no_cache: no_cache.unwrap_or(false),
        },
    )
    .await?;

    Ok(jobid)
}

#[tauri::command]
pub async fn cleanup(
    app: AppHandle,
    remote: String,
    path: Option<String>,
    source: Option<String>,
    no_cache: Option<bool>,
) -> Result<u64, String> {
    let state = app.state::<RcloneState>();
    let path_val = path.as_deref().unwrap_or("");
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

    let (jobid, _, _) = submit_job(
        app.clone(),
        state.client.clone(),
        backend.inject_auth(state.client.clone().post(&url)),
        json!(payload),
        JobMetadata {
            remote_name: remote.clone(),
            job_type: JobType::Cleanup,
            operation_name: "Cleanup".to_string(),
            source: build_full_path(&remote, path_val),
            destination: String::new(),
            profile: None,
            origin: source
                .as_deref()
                .map(crate::utils::types::origin::Origin::parse),
            group: None,
            no_cache: no_cache.unwrap_or(false),
        },
    )
    .await?;

    Ok(jobid)
}

//This command also supports to download files inside remote to. Useful for downloading URLs directly to remote storage.
#[tauri::command]
pub async fn copy_url(
    app: AppHandle,
    remote: String,
    path: String,
    url_to_copy: String,
    auto_filename: bool,
    source: Option<String>,
    no_cache: Option<bool>,
) -> Result<u64, String> {
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

    let (jobid, _, _) = submit_job(
        app.clone(),
        state.client.clone(),
        backend.inject_auth(state.client.clone().post(&url)),
        payload,
        JobMetadata {
            remote_name: remote.clone(),
            job_type: JobType::CopyUrl,
            operation_name: "Copy URL".to_string(),
            source: url_to_copy,
            destination: build_full_path(&remote, &path),
            profile: None,
            origin: source
                .as_deref()
                .map(crate::utils::types::origin::Origin::parse),
            group: None,
            no_cache: no_cache.unwrap_or(false),
        },
    )
    .await?;

    Ok(jobid)
}

#[tauri::command]
pub async fn delete_file(
    app: AppHandle,
    remote: String,
    path: String,
    source: Option<String>,
    no_cache: Option<bool>,
) -> Result<u64, String> {
    let state = app.state::<RcloneState>();
    debug!("🗑️ Deleting file: remote={} path={}", remote, path);

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let url = backend.url_for(operations::DELETEFILE);

    let payload = json!({
        "fs": remote.clone(),
        "remote": path.clone(),
        "_async": true,
    });

    let (jobid, _, _) = submit_job(
        app.clone(),
        state.client.clone(),
        backend.inject_auth(state.client.clone().post(&url)),
        payload,
        JobMetadata {
            remote_name: remote.clone(),
            job_type: JobType::DeleteFile,
            operation_name: "Delete File".to_string(),
            source: build_full_path(&remote, &path),
            destination: String::new(), // Deletion has no destination
            profile: None,
            origin: source
                .as_deref()
                .map(crate::utils::types::origin::Origin::parse),
            group: None,
            no_cache: no_cache.unwrap_or(false),
        },
    )
    .await?;

    Ok(jobid)
}

#[tauri::command]
pub async fn purge_directory(
    app: AppHandle,
    remote: String,
    path: String,
    source: Option<String>,
    no_cache: Option<bool>,
) -> Result<u64, String> {
    let state = app.state::<RcloneState>();
    debug!("🗑️ Purging directory: remote={} path={}", remote, path);

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let url = backend.url_for(operations::PURGE);

    let payload = json!({
        "fs": remote.clone(),
        "remote": path.clone(),
        "_async": true,
    });

    let (jobid, _, _) = submit_job(
        app.clone(),
        state.client.clone(),
        backend.inject_auth(state.client.clone().post(&url)),
        payload,
        JobMetadata {
            remote_name: remote.clone(),
            job_type: JobType::Purge,
            operation_name: "Purge".to_string(),
            source: build_full_path(&remote, &path),
            destination: String::new(),
            profile: None,
            origin: source
                .as_deref()
                .map(crate::utils::types::origin::Origin::parse),
            group: None,
            no_cache: no_cache.unwrap_or(false),
        },
    )
    .await?;

    Ok(jobid)
}

#[tauri::command]
pub async fn remove_empty_dirs(
    app: AppHandle,
    remote: String,
    path: String,
    source: Option<String>,
    no_cache: Option<bool>,
) -> Result<u64, String> {
    let state = app.state::<RcloneState>();
    debug!(
        "🧹 Removing empty directories: remote={} path={}",
        remote, path
    );

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let url = backend.url_for(operations::RMDIRS);

    let payload = json!({
        "fs": remote.clone(),
        "remote": path.clone(),
        "leaveRoot": true,
        "_async": true,
    });

    let (jobid, _, _) = submit_job(
        app.clone(),
        state.client.clone(),
        backend.inject_auth(state.client.clone().post(&url)),
        payload,
        JobMetadata {
            remote_name: remote.clone(),
            job_type: JobType::Rmdirs,
            operation_name: "Remove Empty Dirs".to_string(),
            source: build_full_path(&remote, &path),
            destination: String::new(),
            profile: None,
            origin: source
                .as_deref()
                .map(crate::utils::types::origin::Origin::parse),
            group: None,
            no_cache: no_cache.unwrap_or(false),
        },
    )
    .await?;

    Ok(jobid)
}

#[tauri::command]
pub async fn copy_file(
    app: AppHandle,
    src_remote: String,
    src_path: String,
    dst_remote: String,
    dst_path: String,
    source: Option<String>,
    no_cache: Option<bool>,
) -> Result<u64, String> {
    let state = app.state::<RcloneState>();
    debug!(
        "📄 Copying file: src_remote={} src_path={} dst_remote={} dst_path={}",
        src_remote, src_path, dst_remote, dst_path
    );

    let src_full = build_full_path(&src_remote, &src_path);
    let dst_full = build_full_path(&dst_remote, &dst_path);

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let url = backend.url_for(operations::COPYFILE);

    let payload = json!({
        "srcFs": src_remote.clone(),
        "srcRemote": src_path.clone(),
        "dstFs": dst_remote.clone(),
        "dstRemote": dst_path.clone(),
        "_async": true,
    });

    let (jobid, _, _) = submit_job(
        app.clone(),
        state.client.clone(),
        backend.inject_auth(state.client.clone().post(&url)),
        payload,
        JobMetadata {
            remote_name: src_remote.clone(),
            job_type: JobType::CopyFile,
            operation_name: "Copy File".to_string(),
            source: src_full,
            destination: dst_full,
            profile: None,
            origin: source
                .as_deref()
                .map(crate::utils::types::origin::Origin::parse),
            group: None,
            no_cache: no_cache.unwrap_or(false),
        },
    )
    .await?;

    Ok(jobid)
}

#[tauri::command]
pub async fn move_file(
    app: AppHandle,
    src_remote: String,
    src_path: String,
    dst_remote: String,
    dst_path: String,
    source: Option<String>,
    no_cache: Option<bool>,
) -> Result<u64, String> {
    let state = app.state::<RcloneState>();
    debug!(
        "📦 Moving file: src_remote={} src_path={} dst_remote={} dst_path={}",
        src_remote, src_path, dst_remote, dst_path
    );

    let src_full = build_full_path(&src_remote, &src_path);
    let dst_full = build_full_path(&dst_remote, &dst_path);

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let url = backend.url_for(operations::MOVEFILE);

    let payload = json!({
        "srcFs": src_remote.clone(),
        "srcRemote": src_path.clone(),
        "dstFs": dst_remote.clone(),
        "dstRemote": dst_path.clone(),
        "_async": true,
    });

    let (jobid, _, _) = submit_job(
        app.clone(),
        state.client.clone(),
        backend.inject_auth(state.client.clone().post(&url)),
        payload,
        JobMetadata {
            remote_name: src_remote.clone(),
            job_type: JobType::MoveFile,
            operation_name: "Move File".to_string(),
            source: src_full,
            destination: dst_full,
            profile: None,
            origin: source
                .as_deref()
                .map(crate::utils::types::origin::Origin::parse),
            group: None,
            no_cache: no_cache.unwrap_or(false),
        },
    )
    .await?;

    Ok(jobid)
}

#[tauri::command]
pub async fn copy_dir(
    app: AppHandle,
    src_remote: String,
    src_path: String,
    dst_remote: String,
    dst_path: String,
    source: Option<String>,
    no_cache: Option<bool>,
) -> Result<u64, String> {
    let state = app.state::<RcloneState>();
    debug!(
        "📁 Copying directory: src_remote={} src_path={} dst_remote={} dst_path={}",
        src_remote, src_path, dst_remote, dst_path
    );

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let url = backend.url_for(sync::COPY);

    let src_fs = build_full_path(&src_remote, &src_path);
    let dst_fs = build_full_path(&dst_remote, &dst_path);

    let payload = json!({
        "srcFs": src_fs,
        "dstFs": dst_fs,
        "createEmptySrcDirs": true,
        "_async": true,
    });

    let (jobid, _, _) = submit_job(
        app.clone(),
        state.client.clone(),
        backend.inject_auth(state.client.clone().post(&url)),
        payload,
        JobMetadata {
            remote_name: src_remote.clone(),
            job_type: JobType::CopyDir,
            operation_name: "Copy Directory".to_string(),
            source: src_fs.clone(),
            destination: dst_fs.clone(),
            profile: None,
            origin: source
                .as_deref()
                .map(crate::utils::types::origin::Origin::parse),
            group: None,
            no_cache: no_cache.unwrap_or(false),
        },
    )
    .await?;

    Ok(jobid)
}

#[tauri::command]
pub async fn move_dir(
    app: AppHandle,
    src_remote: String,
    src_path: String,
    dst_remote: String,
    dst_path: String,
    source: Option<String>,
    no_cache: Option<bool>,
) -> Result<u64, String> {
    let state = app.state::<RcloneState>();
    debug!(
        "📂 Moving directory: src_remote={} src_path={} dst_remote={} dst_path={}",
        src_remote, src_path, dst_remote, dst_path
    );

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let url = backend.url_for(sync::MOVE);

    let src_fs = build_full_path(&src_remote, &src_path);
    let dst_fs = build_full_path(&dst_remote, &dst_path);

    let payload = json!({
        "srcFs": src_fs,
        "dstFs": dst_fs,
        "createEmptySrcDirs": true,
        "deleteEmptySrcDirs": true,
        "_async": true,
    });

    let (jobid, _, _) = submit_job(
        app.clone(),
        state.client.clone(),
        backend.inject_auth(state.client.clone().post(&url)),
        payload,
        JobMetadata {
            remote_name: src_remote.clone(),
            job_type: JobType::MoveDir,
            operation_name: "Move Directory".to_string(),
            source: src_fs.clone(),
            destination: dst_fs.clone(),
            profile: None,
            origin: source
                .as_deref()
                .map(crate::utils::types::origin::Origin::parse),
            group: None,
            no_cache: no_cache.unwrap_or(false),
        },
    )
    .await?;

    Ok(jobid)
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

#[derive(Serialize)]
pub struct LocalDropUploadResult {
    pub uploaded: usize,
    pub failed: Vec<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct LocalDropUploadFile {
    pub relative_path: String,
    pub filename: String,
    pub content: Vec<u8>,
}

enum LocalDropUploadEntrySource {
    Bytes(Vec<u8>),
    Path(std::path::PathBuf),
}

struct LocalDropUploadEntry {
    relative_path: String,
    filename: String,
    size: usize,
    source: LocalDropUploadEntrySource,
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

async fn next_upload_job_id(job_cache: &crate::utils::types::jobs::JobCache) -> u64 {
    job_cache
        .get_jobs()
        .await
        .into_iter()
        .map(|job| job.jobid)
        .max()
        .unwrap_or(0)
        .saturating_add(1)
}

async fn create_upload_job(
    app: &AppHandle,
    remote: &str,
    path: &str,
    source: Option<String>,
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
                status: crate::utils::types::jobs::JobStatus::Running,
                error: None,
                stats: Some(stats),
                uploaded_files: Vec::new(),
                group: format!("upload/{remote_name}"),
                profile: None,
                execute_id: None,
                origin: source
                    .as_deref()
                    .map(crate::utils::types::origin::Origin::parse),
                backend_name: Some(backend_manager.get_active().await.name.clone()),
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

async fn upload_local_drop_entries(
    app: &AppHandle,
    remote: String,
    path: String,
    entries: Vec<LocalDropUploadEntry>,
    source: Option<String>,
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

    let total_bytes = entries.iter().map(|entry| entry.size).sum::<usize>();
    let total_transfers = entries.len();
    let jobid =
        create_upload_job(app, &remote, &path, source, total_bytes, total_transfers).await?;
    let start = Instant::now();

    let mut created_directories = HashSet::new();
    let mut uploaded = 0usize;
    let mut failed = Vec::new();
    let mut transferred_bytes = 0usize;

    for entry in entries {
        if job_cache
            .get_job(jobid)
            .await
            .is_some_and(|job| job.status == crate::utils::types::jobs::JobStatus::Stopped)
        {
            return Ok(LocalDropUploadResult { uploaded, failed });
        }

        let destination = join_remote_path(&path, &entry.relative_path);
        let (directory, filename) = split_remote_directory(&destination);

        if !directory.is_empty() && !created_directories.contains(&directory) {
            let mkdir_response = backend
                .inject_auth(state.client.post(&mkdir_url))
                .json(&json!({ "fs": remote.clone(), "remote": directory }))
                .send()
                .await
                .map_err(|e| format!("Failed to create directory: {}", e))?;

            if mkdir_response.status().is_success() {
                created_directories.insert(directory.clone());
            }
        }

        let bytes = match entry.source {
            LocalDropUploadEntrySource::Bytes(content) => content,
            LocalDropUploadEntrySource::Path(ref path_buf) => match tokio::fs::read(path_buf).await
            {
                Ok(content) => content,
                Err(_) => {
                    failed.push(path_buf.display().to_string());
                    continue;
                }
            },
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
        .complete_job(jobid, success, final_error.clone(), Some(app))
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
                if !entry.file_type().is_file() {
                    continue;
                }

                let current = entry.path();
                let rel_path = if let Some(parent) = &base_parent {
                    current.strip_prefix(parent).unwrap_or(current)
                } else {
                    current
                };
                let relative_path = relative_unix_path(rel_path);
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
    source: Option<String>,
) -> Result<LocalDropUploadResult, String> {
    let entries = collect_upload_entries_from_paths(local_paths).await?;
    upload_local_drop_entries(&app, remote, path, entries, source).await
}

#[tauri::command]
pub async fn upload_local_drop_files(
    app: AppHandle,
    remote: String,
    path: String,
    files: Vec<LocalDropUploadFile>,
    source: Option<String>,
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

    upload_local_drop_entries(&app, remote, path, entries, source).await
}

#[tauri::command]
pub async fn rename_file(
    app: AppHandle,
    remote: String,
    src_path: String,
    dst_path: String,
    source: Option<String>,
    no_cache: Option<bool>,
) -> Result<u64, String> {
    let state = app.state::<RcloneState>();
    debug!(
        "🖊️ Renaming file: remote={} src_path={} dst_path={}",
        remote, src_path, dst_path
    );

    let src_full = build_full_path(&remote, &src_path);
    let dst_full = build_full_path(&remote, &dst_path);

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let url = backend.url_for(operations::MOVEFILE);

    let payload = json!({
        "srcFs": remote.clone(),
        "srcRemote": src_path.clone(),
        "dstFs": remote.clone(),
        "dstRemote": dst_path.clone(),
        "_async": true,
    });

    let (jobid, _, _) = submit_job(
        app.clone(),
        state.client.clone(),
        backend.inject_auth(state.client.clone().post(&url)),
        payload,
        JobMetadata {
            remote_name: remote.clone(),
            job_type: JobType::RenameFile,
            operation_name: "Rename File".to_string(),
            source: src_full,
            destination: dst_full,
            profile: None,
            origin: source
                .as_deref()
                .map(crate::utils::types::origin::Origin::parse),
            group: None,
            no_cache: no_cache.unwrap_or(false),
        },
    )
    .await?;

    Ok(jobid)
}

#[tauri::command]
pub async fn rename_dir(
    app: AppHandle,
    remote: String,
    src_path: String,
    dst_path: String,
    source: Option<String>,
    no_cache: Option<bool>,
) -> Result<u64, String> {
    let state = app.state::<RcloneState>();
    debug!(
        "🖊️ Renaming directory: remote={} src_path={} dst_path={}",
        remote, src_path, dst_path
    );

    let src_full = build_full_path(&remote, &src_path);
    let dst_full = build_full_path(&remote, &dst_path);

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let url = backend.url_for(sync::MOVE);

    // For sync/move (directories), fs means the root of the copy
    let payload = json!({
        "srcFs": src_full.clone(),
        "dstFs": dst_full.clone(),
        "createEmptySrcDirs": true,
        "deleteEmptySrcDirs": true,
        "_async": true,
    });

    let (jobid, _, _) = submit_job(
        app.clone(),
        state.client.clone(),
        backend.inject_auth(state.client.clone().post(&url)),
        payload,
        JobMetadata {
            remote_name: remote.clone(),
            job_type: JobType::RenameDir,
            operation_name: "Rename Directory".to_string(),
            source: src_full.clone(),
            destination: dst_full.clone(),
            profile: None,
            origin: source
                .as_deref()
                .map(crate::utils::types::origin::Origin::parse),
            group: None,
            no_cache: no_cache.unwrap_or(false),
        },
    )
    .await?;

    Ok(jobid)
}
