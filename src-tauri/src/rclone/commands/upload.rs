//! Custom upload commands for streaming and batch processing to rclone remotes.

use futures::StreamExt;
use log::debug;
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::rclone::backend::BackendManager;
use crate::rclone::commands::job::JobMetadata;
use crate::utils::app::notification::notify;
use crate::utils::rclone::endpoints::operations;
use crate::utils::rclone::util::build_full_path;
use crate::utils::types::{jobs::JobType, origin::Origin, state::RcloneState};

#[derive(Debug, Clone, Deserialize)]
pub struct UploadBatchParams {
    pub remote: String,
    pub path: String,
    pub local_paths: Vec<String>,
    pub origin: Option<Origin>,
    pub group: Option<String>,
    pub cleanup_dir: Option<std::path::PathBuf>,
    pub existing_jobid: Option<u64>,
    pub no_cache: bool,
}

struct UploadProgress {
    start_time: std::time::Instant,
    uploaded_bytes: u64,
    completed: Vec<serde_json::Value>,
    errors: Vec<String>,
    transferring: Vec<serde_json::Value>,
}

impl UploadProgress {
    fn new() -> Self {
        Self {
            start_time: std::time::Instant::now(),
            uploaded_bytes: 0,
            completed: Vec::new(),
            errors: Vec::new(),
            transferring: Vec::new(),
        }
    }

    fn remove_transferring(&mut self, filename: &str) {
        if let Some(pos) = self
            .transferring
            .iter()
            .position(|val| val.get("name").and_then(|n| n.as_str()) == Some(filename))
        {
            self.transferring.remove(pos);
        }
    }

    fn build_stats(&self, total_bytes: u64, total_files: usize) -> serde_json::Value {
        let elapsed = self.start_time.elapsed().as_secs_f64();
        let speed = if elapsed > 0.0 {
            self.uploaded_bytes as f64 / elapsed
        } else {
            0.0
        };
        let eta = if speed > 0.0 && total_bytes > self.uploaded_bytes {
            Some(((total_bytes - self.uploaded_bytes) as f64 / speed) as u64)
        } else {
            None
        };

        json!({
            "bytes": self.uploaded_bytes,
            "checks": 0,
            "deletedDirs": 0,
            "deletes": 0,
            "elapsedTime": elapsed,
            "errors": self.errors.len(),
            "eta": eta,
            "fatalError": false,
            "lastError": self.errors.last().cloned().unwrap_or_default(),
            "renames": 0,
            "retryError": false,
            "serverSideCopies": 0,
            "serverSideCopyBytes": 0,
            "serverSideMoveBytes": 0,
            "serverSideMoves": 0,
            "speed": speed,
            "totalBytes": total_bytes,
            "totalChecks": 0,
            "totalTransfers": total_files,
            "transferTime": elapsed,
            "transferring": self.transferring,
            "transfers": self.completed.len(),
            "listed": total_files,
            "completed": self.completed,
        })
    }
}

/// Discovers files within folders recursively.
/// Runs in a blocking thread to prevent UI freezes on large directories.
async fn discover_upload_entries(
    local_paths: Vec<String>,
    remote_path: String,
) -> Result<Vec<(std::path::PathBuf, String, String)>, String> {
    tokio::task::spawn_blocking(move || {
        let remote_path = if remote_path == "/" { "" } else { &remote_path };
        let mut entries = Vec::new();
        for raw in &local_paths {
            let p = std::path::PathBuf::from(raw);
            if !p.exists() {
                continue;
            }

            let parent = p.parent().unwrap_or(&p);
            let top_name = p
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            if p.is_file() {
                let rel_name = p
                    .strip_prefix(parent)
                    .unwrap_or(&p)
                    .to_string_lossy()
                    .to_string();
                entries.push((p, remote_path.to_string(), rel_name));
            } else if p.is_dir() {
                for entry in walkdir::WalkDir::new(&p)
                    .min_depth(1)
                    .into_iter()
                    .filter_map(std::result::Result::ok)
                    .filter(|e| e.file_type().is_file())
                {
                    let file_path = entry.path();
                    let rel_name = file_path
                        .strip_prefix(parent)
                        .unwrap_or(file_path)
                        .to_string_lossy()
                        .to_string()
                        .replace('\\', "/");

                    let rel = file_path
                        .strip_prefix(&p)
                        .unwrap_or(file_path)
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
                    entries.push((file_path.to_path_buf(), remote_dir, rel_name));
                }
            }
        }
        Ok(entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

// TODO: Phase 3 — migrate multipart upload to transport (needs streaming trait method)
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
        no_cache,
    } = params;

    let mut remote = remote;
    if !remote.ends_with(':') && !remote.contains('/') && !remote.contains('\\') {
        remote.push(':');
    }

    debug!(
        "execute_upload_batch: {} paths to {remote}:{path}",
        local_paths.len()
    );

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let client = app.state::<RcloneState>().client.clone();
    let job_cache = &backend_manager.job_cache;

    let file_entries = discover_upload_entries(local_paths.clone(), path.clone()).await?;
    if file_entries.is_empty() {
        if let Some(dir) = cleanup_dir {
            let _ = tokio::fs::remove_dir_all(dir).await;
        }
        return Err("No valid files found to upload".to_string());
    }

    let total_files = file_entries.len();
    let total_bytes: u64 =
        futures::future::join_all(file_entries.iter().map(|(p, _, _)| tokio::fs::metadata(p)))
            .await
            .into_iter()
            .filter_map(std::result::Result::ok)
            .map(|m| m.len())
            .sum();

    let destination = build_full_path(&remote, &path);
    let jobid = existing_jobid.unwrap_or_else(|| chrono::Utc::now().timestamp_millis() as u64);
    let metadata = JobMetadata {
        remote_name: remote.clone(),
        job_type: JobType::Upload,
        source: local_paths.clone(),
        destination,
        profile: None,
        origin: origin.clone(),
        group,
        no_cache,
        dry_run: false,
        parent_job_id: None,
    };

    let group_name = metadata.group_name();

    if existing_jobid.is_none() {
        let execute_id = Some(uuid::Uuid::new_v4().to_string());
        job_cache
            .create_job(
                jobid,
                execute_id,
                metadata.clone(),
                backend.name.clone(),
                Some(&app),
            )
            .await;
    }

    if !metadata.no_cache {
        notify(&app, metadata.started_event(backend.name.clone()));
    }

    let progress = Arc::new(Mutex::new(UploadProgress::new()));

    let mut stream = futures::stream::iter(file_entries)
        .map(|(file_path, remote_dir, rel_name)| {
            let backend = backend.clone();
            let client = client.clone();
            let remote = remote.clone();
            let progress = progress.clone();
            let job_cache = job_cache.clone();
            let group_name = group_name.clone();

            async move {
                let filename = rel_name;
                let started_at = chrono::Utc::now();
                let src_fs = file_path
                    .parent()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default();
                let dst_fs = build_full_path(&remote, &remote_dir);

                let file = match tokio::fs::File::open(&file_path).await {
                    Ok(f) => f,
                    Err(e) => {
                        let stats = {
                            let mut state = progress.lock().unwrap();
                            let err_msg = format!("Failed to open {filename}: {e}");
                            state.errors.push(err_msg.clone());
                            state.completed.push(json!({
                                "name": filename,
                                "size": 0,
                                "bytes": 0,
                                "checked": false,
                                "error": err_msg,
                                "started_at": started_at,
                                "completed_at": chrono::Utc::now(),
                                "srcFs": src_fs,
                                "dstFs": dst_fs,
                                "group": group_name,
                            }));
                            state.build_stats(total_bytes, total_files)
                        };
                        let _ = job_cache.update_job_stats(jobid, stats).await;
                        return;
                    }
                };

                let size = file.metadata().await.map(|m| m.len()).unwrap_or(0);

                {
                    let stats = {
                        let mut state = progress.lock().unwrap();
                        state.transferring.push(json!({
                            "name": filename.clone(),
                            "size": size,
                            "bytes": 0,
                            "srcFs": src_fs.clone(),
                            "dstFs": dst_fs.clone(),
                            "group": group_name.clone(),
                        }));
                        state.build_stats(total_bytes, total_files)
                    };
                    let _ = job_cache.update_job_stats(jobid, stats).await;
                }

                let base_filename = file_path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();

                let part_res = reqwest::multipart::Part::stream(reqwest::Body::from(file))
                    .file_name(base_filename)
                    .mime_str("application/octet-stream");

                let part = match part_res {
                    Ok(p) => p,
                    Err(e) => {
                        let stats = {
                            let mut state = progress.lock().unwrap();
                            state.remove_transferring(&filename);
                            let err_msg = format!("Multipart error for {filename}: {e}");
                            state.errors.push(err_msg.clone());
                            state.completed.push(json!({
                                "name": filename,
                                "size": size,
                                "bytes": 0,
                                "checked": false,
                                "error": err_msg,
                                "started_at": started_at,
                                "completed_at": chrono::Utc::now(),
                                "srcFs": src_fs,
                                "dstFs": dst_fs,
                                "group": group_name,
                            }));
                            state.build_stats(total_bytes, total_files)
                        };
                        let _ = job_cache.update_job_stats(jobid, stats).await;
                        return;
                    }
                };

                let resp = backend
                    .inject_auth(
                        client
                            .post(backend.url_for(operations::UPLOADFILE))
                            .query(&[("fs", &remote), ("remote", &remote_dir)]),
                    )
                    .multipart(reqwest::multipart::Form::new().part("file", part))
                    .send()
                    .await;

                let result = match resp {
                    Ok(r) if r.status().is_success() => Ok(size),
                    Ok(r) => {
                        let status = r.status();
                        let err_text = r.text().await.unwrap_or_default();
                        let err_msg = parse_rclone_error(&err_text);
                        Err(format!(
                            "Upload failed for {filename}: {status} - {err_msg}"
                        ))
                    }
                    Err(e) => Err(format!("Network error for {filename}: {e}")),
                };

                {
                    let stats = {
                        let mut state = progress.lock().unwrap();
                        state.remove_transferring(&filename);
                        match result {
                            Ok(uploaded_size) => {
                                state.uploaded_bytes += uploaded_size;
                                state.completed.push(json!({
                                    "name": filename,
                                    "size": uploaded_size,
                                    "bytes": uploaded_size,
                                    "checked": false,
                                    "error": "",
                                    "started_at": started_at,
                                    "completed_at": chrono::Utc::now(),
                                    "srcFs": src_fs,
                                    "dstFs": dst_fs,
                                    "group": group_name,
                                }));
                            }
                            Err(err_msg) => {
                                state.errors.push(err_msg.clone());
                                state.completed.push(json!({
                                    "name": filename,
                                    "size": size,
                                    "bytes": 0,
                                    "checked": false,
                                    "error": err_msg,
                                    "started_at": started_at,
                                    "completed_at": chrono::Utc::now(),
                                    "srcFs": src_fs,
                                    "dstFs": dst_fs,
                                    "group": group_name,
                                }));
                            }
                        }
                        state.build_stats(total_bytes, total_files)
                    };
                    let _ = job_cache.update_job_stats(jobid, stats).await;
                }
            }
        })
        .buffer_unordered(4);

    while stream.next().await.is_some() {}

    let (success, error_msg) = {
        let state = progress.lock().unwrap();
        let success = state.errors.is_empty();
        let error_msg = (!success)
            .then(|| format!("{} failed: {}", state.errors.len(), state.errors.join("; ")));
        (success, error_msg)
    };

    let stats = {
        let state = progress.lock().unwrap();
        state.build_stats(total_bytes, total_files)
    };
    let _ = job_cache.update_job_stats(jobid, stats).await;

    if !metadata.no_cache {
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
            no_cache: false,
        },
    )
    .await
}

#[tauri::command]
// TODO: Phase 3 — migrate multipart upload to transport (needs streaming trait method).
// For now, upload_file branches on transport.kind(): desktop uses reqwest::multipart,
// mobile (librclone) uses operations/copyfile from a temp file.
pub async fn upload_file(
    app: AppHandle,
    remote: String,
    path: String,
    name: String,
    content: Vec<u8>,
) -> Result<String, String> {
    use crate::rclone::backend::TransportKind;

    let state = app.state::<crate::utils::types::state::RcloneState>();
    let transport = state.transport.clone();
    let remote_dir = if path.is_empty() {
        String::new()
    } else if path.ends_with('/') {
        path.clone()
    } else {
        format!("{path}/")
    };

    match transport.kind() {
        // Desktop: use reqwest::multipart to stream the file bytes directly.
        TransportKind::HttpDaemon => {
            let backend_manager = app.state::<BackendManager>();
            let backend = backend_manager.get_active().await;
            let client = &state.client;

            let part = reqwest::multipart::Part::bytes(content)
                .file_name(name.clone())
                .mime_str("application/octet-stream")
                .map_err(|e: reqwest::Error| e.to_string())?;

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
                Ok(r) if r.status().is_success() => Ok("File uploaded successfully".to_string()),
                Ok(r) => {
                    let status = r.status();
                    let err_text = r.text().await.unwrap_or_default();
                    let err_msg = parse_rclone_error(&err_text);
                    Err(format!("Upload failed: {status} - {err_msg}"))
                }
                Err(e) => Err(format!("Network error: {e}")),
            }
        }
        // Mobile (librclone): the rc protocol doesn't accept multipart bodies.
        // Write the bytes to a temp file, then use operations/copyfile to copy
        // from the local temp file to the destination remote.
        TransportKind::Librclone => {
            use base64::Engine;
            // For small files (< 16 MB), base64-encode into the JSON body of
            // operations/uploadfile directly. This avoids the temp-file dance.
            // For larger files, fall back to temp file + operations/copyfile.
            const BASE64_THRESHOLD: usize = 16 * 1024 * 1024;

            let dst_remote = if remote_dir.is_empty() {
                name.clone()
            } else {
                format!("{remote_dir}{name}")
            };

            if content.len() < BASE64_THRESHOLD {
                let b64 = base64::engine::general_purpose::STANDARD.encode(&content);
                let payload = json!({
                    "fs": &remote,
                    "remote": &dst_remote,
                    "file": b64,
                });
                transport
                    .rpc(operations::UPLOADFILE, Some(&payload))
                    .await
                    .map_err(|e| format!("Upload failed: {e}"))?;
                Ok("File uploaded successfully".to_string())
            } else {
                // Temp-file path: copyfile from ":file:<tmp>" to "<remote>:<dst>".
                let tmp = tempfile::NamedTempFile::new()
                    .map_err(|e| format!("Failed to create temp file: {e}"))?;
                tokio::fs::write(tmp.path(), &content)
                    .await
                    .map_err(|e| format!("Failed to write temp file: {e}"))?;
                let src_fs = format!(":file:{}", tmp.path().display());
                let dst_fs = format!("{remote}:");
                let payload = json!({
                    "srcFs": src_fs,
                    "srcRemote": tmp.path().file_name().and_then(|n| n.to_str()).unwrap_or("tmp"),
                    "dstFs": dst_fs,
                    "dstRemote": &dst_remote,
                });
                transport
                    .rpc(operations::COPYFILE, Some(&payload))
                    .await
                    .map_err(|e| format!("Upload (copyfile) failed: {e}"))?;
                // Temp file is auto-cleaned when `tmp` drops.
                Ok("File uploaded successfully".to_string())
            }
        }
    }
}

fn parse_rclone_error(err_text: &str) -> String {
    serde_json::from_str::<serde_json::Value>(err_text)
        .ok()
        .and_then(|val| val.get("error").and_then(|e| e.as_str()).map(String::from))
        .unwrap_or_else(|| err_text.to_string())
}
