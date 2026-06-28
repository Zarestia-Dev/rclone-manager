//! Custom upload commands for streaming and batch processing to rclone remotes.
//!
//! This module provides:
//! - `execute_upload_batch`: The core orchestrator for uploading a batch of files in parallel.
//! - `upload_local_drop_paths`: Tauri command for dropping local files into the app.
//! - `upload_file`: Tauri command for simple file upload directly from in-memory bytes.

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

/// Input parameters for batch upload execution.
#[derive(Debug, Clone, Deserialize)]
pub struct UploadBatchParams {
    /// Target rclone remote name (e.g., "drive").
    pub remote: String,
    /// Destination remote path inside the remote.
    pub path: String,
    /// List of absolute local file paths or directory paths to be discovered and uploaded.
    pub local_paths: Vec<String>,
    /// Origin UI panel or action context that triggered this upload.
    pub origin: Option<Origin>,
    /// Optional job group identifier.
    pub group: Option<String>,
    /// Optional local temporary folder path to be cleaned up/removed after batch completes.
    pub cleanup_dir: Option<std::path::PathBuf>,
    /// Existing job ID to report progress back to. If None, a new ID is generated.
    pub existing_jobid: Option<u64>,
    /// If true, disables UI notification broadcasts for job states.
    pub no_cache: bool,
}

/// Thread-safe tracker to monitor batch upload progress in real-time.
struct UploadProgress {
    /// Start time of the batch transfer.
    start_time: std::time::Instant,
    /// Total bytes successfully transferred.
    uploaded_bytes: u64,
    /// List of completed (or failed) transfer metadata representing final stats.
    completed: Vec<serde_json::Value>,
    /// Error messages encountered during batch execution.
    errors: Vec<String>,
    /// Metadata of files currently being uploaded in parallel.
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

    /// Removes a file from the active `transferring` array when it completes or fails.
    fn remove_transferring(&mut self, filename: &str) {
        if let Some(pos) = self
            .transferring
            .iter()
            .position(|val| val.get("name").and_then(|n| n.as_str()) == Some(filename))
        {
            self.transferring.remove(pos);
        }
    }

    /// Prepares a JSON payload representing standard rclone stats structure.
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
        })
    }
}

/// Discovers files within folders recursively, mapping their local path to their remote folder paths.
async fn discover_upload_entries(
    local_paths: &[String],
    remote_path: &str,
) -> Vec<(std::path::PathBuf, String)> {
    let remote_path = if remote_path == "/" { "" } else { remote_path };
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
                .filter_map(std::result::Result::ok)
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

/// Executes a batch upload, processing files in parallel with up to `4` concurrent streams.
///
/// Updates the job cache stats dynamically, broadcasting both `transferring` items
/// and standard/failed `completed` transfers in real-time.
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

    let file_entries = discover_upload_entries(&local_paths, &path).await;
    if file_entries.is_empty() {
        if let Some(dir) = cleanup_dir {
            let _ = tokio::fs::remove_dir_all(dir).await;
        }
        return Err("No valid files found to upload".to_string());
    }

    let total_files = file_entries.len();
    let total_bytes: u64 =
        futures::future::join_all(file_entries.iter().map(|(p, _)| tokio::fs::metadata(p)))
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
        .map(|(file_path, remote_dir)| {
            let backend = backend.clone();
            let client = client.clone();
            let remote = remote.clone();
            let progress = progress.clone();
            let job_cache = job_cache.clone();

            async move {
                let filename = file_path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();

                let file = match tokio::fs::File::open(&file_path).await {
                    Ok(f) => f,
                    Err(e) => {
                        let mut state = progress.lock().unwrap();
                        let err_msg = format!("Failed to open {filename}: {e}");
                        state.errors.push(err_msg.clone());
                        state.completed.push(json!({
                            "name": filename,
                            "size": 0,
                            "bytes": 0,
                            "error": err_msg,
                            "completed_at": chrono::Utc::now()
                        }));
                        let stats = state.build_stats(total_bytes, total_files);
                        let job_cache_clone = job_cache.clone();
                        tokio::spawn(async move {
                            let _ = job_cache_clone.update_job_stats(jobid, stats).await;
                        });
                        return;
                    }
                };

                let size = file.metadata().await.map(|m| m.len()).unwrap_or(0);

                // Add to transferring list
                {
                    let mut state = progress.lock().unwrap();
                    state
                        .transferring
                        .push(json!({ "name": filename.clone(), "size": size, "bytes": 0 }));
                    let stats = state.build_stats(total_bytes, total_files);
                    let job_cache_clone = job_cache.clone();
                    tokio::spawn(async move {
                        let _ = job_cache_clone.update_job_stats(jobid, stats).await;
                    });
                }

                let part_res = reqwest::multipart::Part::stream(reqwest::Body::from(file))
                    .file_name(filename.clone())
                    .mime_str("application/octet-stream");

                let part = match part_res {
                    Ok(p) => p,
                    Err(e) => {
                        let mut state = progress.lock().unwrap();
                        state.remove_transferring(&filename);
                        let err_msg = format!("Multipart error for {filename}: {e}");
                        state.errors.push(err_msg.clone());
                        state.completed.push(json!({
                            "name": filename,
                            "size": size,
                            "bytes": 0,
                            "error": err_msg,
                            "completed_at": chrono::Utc::now()
                        }));
                        let stats = state.build_stats(total_bytes, total_files);
                        let job_cache_clone = job_cache.clone();
                        tokio::spawn(async move {
                            let _ = job_cache_clone.update_job_stats(jobid, stats).await;
                        });
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
                        Err(format!(
                            "Upload failed for {filename}: {status} - {err_text}"
                        ))
                    }
                    Err(e) => Err(format!("Network error for {filename}: {e}")),
                };

                {
                    let mut state = progress.lock().unwrap();
                    state.remove_transferring(&filename);
                    match result {
                        Ok(uploaded_size) => {
                            state.uploaded_bytes += uploaded_size;
                            state.completed.push(json!({
                                "name": filename,
                                "size": uploaded_size,
                                "bytes": uploaded_size,
                                "completed_at": chrono::Utc::now()
                            }));
                        }
                        Err(err_msg) => {
                            state.errors.push(err_msg.clone());
                            state.completed.push(json!({
                                "name": filename,
                                "size": size,
                                "bytes": 0,
                                "error": err_msg,
                                "completed_at": chrono::Utc::now()
                            }));
                        }
                    }
                    let stats = state.build_stats(total_bytes, total_files);
                    let job_cache_clone = job_cache.clone();
                    tokio::spawn(async move {
                        let _ = job_cache_clone.update_job_stats(jobid, stats).await;
                    });
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

/// Tauri command to trigger batch uploads of local files or directories dropped into the app.
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

/// Tauri command to upload a single file directly from an in-memory byte buffer.
#[tauri::command]
pub async fn upload_file(
    app: AppHandle,
    remote: String,
    path: String,
    name: String,
    content: Vec<u8>,
) -> Result<String, String> {
    let state = app.state::<crate::utils::types::state::RcloneState>();
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    let client = &state.client;
    let remote_dir = if path.is_empty() {
        String::new()
    } else if path.ends_with('/') {
        path.clone()
    } else {
        format!("{path}/")
    };

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
            Err(format!("Upload failed: {status} - {err_text}"))
        }
        Err(e) => Err(format!("Network error: {e}")),
    }
}
