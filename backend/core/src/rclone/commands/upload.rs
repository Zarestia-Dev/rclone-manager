//! Custom upload commands for streaming and batch processing to rclone remotes.

use crate::context::AppHandle;
use crate::utils::types::jobs::JobCache;
use futures::StreamExt;
use log::debug;
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

use crate::rclone::backend::BackendManager;
use crate::rclone::backend::TransportKind;
use crate::rclone::backend::{routing_transport::RoutingTransport, types::Backend};
use crate::rclone::commands::filesystem::{
    FsItem, TransferMode, submit_transfer_job, transfer_inputs,
};
use crate::rclone::commands::job::{JobMetadata, SubmitJobOptions};
use crate::rclone::commands::sync::lookup_dry_run;
use crate::rclone::endpoints::operations;
use crate::services::settings::operations::templates::transfer_options;
use crate::utils::app::notification::notify;
use crate::utils::json_helpers::build_full_path;
use crate::utils::types::jobs::JobType;
use crate::utils::types::origin::Origin;
use crate::utils::types::remotes::OperationType;
use crate::utils::types::state::RcloneState;

#[derive(Debug, Clone, Deserialize)]
pub struct UploadBatchParams {
    #[serde(skip)]
    pub backend: Option<Backend>,
    pub remote: String,
    pub path: String,
    pub local_paths: Vec<String>,
    pub origin: Option<Origin>,
    pub group: Option<String>,
    /// The user template to transfer with: `None` for the file browser's default,
    /// empty for none.
    pub template: Option<String>,
}

// Upload jobs are local synthetic jobs, separate from rclone's job IDs.
fn next_upload_jobid() -> u64 {
    static LAST_ID: AtomicU64 = AtomicU64::new(0);
    let now = chrono::Utc::now().timestamp_millis() as u64;
    let previous = LAST_ID
        .try_update(Ordering::Relaxed, Ordering::Relaxed, |last| {
            Some(now.max(last + 1))
        })
        .expect("upload job ID update cannot fail");
    now.max(previous + 1)
}

/// One file of an upload, as the job's transfer lists show it.
struct UploadEntry<'a> {
    name: &'a str,
    src_fs: &'a str,
    dst_fs: &'a str,
    group: &'a str,
    started_at: chrono::DateTime<chrono::Utc>,
}

impl UploadEntry<'_> {
    fn transferring(&self, size: u64) -> serde_json::Value {
        json!({
            "name": self.name,
            "size": size,
            "bytes": 0,
            "srcFs": self.src_fs,
            "dstFs": self.dst_fs,
            "group": self.group,
        })
    }

    fn completed(&self, size: u64, bytes: u64, error: &str) -> serde_json::Value {
        json!({
            "name": self.name,
            "size": size,
            "bytes": bytes,
            "checked": false,
            "error": error,
            "started_at": self.started_at,
            "completed_at": chrono::Utc::now(),
            "srcFs": self.src_fs,
            "dstFs": self.dst_fs,
            "group": self.group,
        })
    }
}

struct UploadProgress {
    start_time: Instant,
    last_published: Option<Instant>,
    uploaded_bytes: u64,
    completed: Vec<serde_json::Value>,
    errors: Vec<String>,
    transferring: Vec<serde_json::Value>,
}

impl UploadProgress {
    fn new() -> Self {
        Self {
            start_time: Instant::now(),
            last_published: None,
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
        self.stats_with_history(total_bytes, total_files, usize::MAX)
    }

    fn progress_stats(
        &mut self,
        total_bytes: u64,
        total_files: usize,
    ) -> Option<serde_json::Value> {
        if self
            .last_published
            .is_some_and(|last| last.elapsed() < Duration::from_millis(250))
        {
            return None;
        }
        self.last_published = Some(Instant::now());
        Some(self.stats_with_history(total_bytes, total_files, 100))
    }

    fn stats_with_history(
        &self,
        total_bytes: u64,
        total_files: usize,
        history_limit: usize,
    ) -> serde_json::Value {
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
            "updatedDirs": 0,
            "transferTime": elapsed,
            "transferring": self.transferring,
            "transfers": self.completed.len() - self.errors.len(),
            "listed": total_files,
            "completed": &self.completed[self.completed.len().saturating_sub(history_limit)..],
        })
    }
}

// Registration follows the upload future's lifetime, including cancellation/panic.
struct UploadRegistration {
    cache: Arc<JobCache>,
    id: u64,
    token: CancellationToken,
    result: tokio::sync::watch::Sender<Option<Result<(), String>>>,
}

impl Drop for UploadRegistration {
    fn drop(&mut self) {
        self.token.cancel();
        self.result.send_if_modified(|result| {
            if result.is_none() {
                *result = Some(Err("Upload ended without confirming cancellation".into()));
                true
            } else {
                false
            }
        });
        self.cache.uploads.lock().remove(&self.id);
    }
}

/// Files and folders on the engine's own disk as transfer items: a file is copied
/// from its folder, a folder as a whole.
async fn local_upload_items(local_paths: &[String]) -> Result<Vec<FsItem>, String> {
    let mut items = Vec::with_capacity(local_paths.len());
    for raw in local_paths {
        let path = std::path::Path::new(raw);
        let metadata = tokio::fs::metadata(path).await.map_err(|e| {
            crate::localized_error!("backendErrors.request.failed", "error" => format!("{}: {e}", path.display()))
        })?;
        let name = path
            .file_name()
            .ok_or_else(|| crate::localized_error!("backendErrors.upload.invalidPath"))?
            .to_string_lossy()
            .into_owned();
        items.push(if metadata.is_dir() {
            FsItem {
                remote: raw.clone(),
                path: String::new(),
                name,
                is_dir: true,
            }
        } else {
            FsItem {
                remote: path
                    .parent()
                    .map(|parent| parent.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                path: name.clone(),
                name,
                is_dir: false,
            }
        });
    }
    Ok(items)
}

struct UploadDiscoveryResult {
    file_entries: Vec<(std::path::PathBuf, String, String)>,
    empty_dir_remotes: Vec<String>,
}

/// Discovers files and empty directories within folders recursively.
/// Runs in a blocking thread to prevent UI freezes on large directories.
async fn discover_upload_entries(
    local_paths: Vec<String>,
    remote_path: String,
) -> Result<UploadDiscoveryResult, String> {
    crate::utils::spawn_blocking(move || {
        let remote_path = if remote_path == "/" { "" } else { &remote_path };
        let mut file_entries = Vec::new();
        let mut empty_dirs = Vec::new();

        for raw in &local_paths {
            let p = std::path::PathBuf::from(raw);
            let metadata = std::fs::metadata(&p).map_err(|e| {
                crate::localized_error!("backendErrors.request.failed", "error" => format!("{}: {e}", p.display()))
            })?;

            let parent = p.parent().unwrap_or(&p);
            let top_name = p
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            if metadata.is_file() {
                let rel_name = p
                    .strip_prefix(parent)
                    .unwrap_or(&p)
                    .to_string_lossy()
                    .to_string();
                file_entries.push((p, remote_path.to_string(), rel_name));
            } else if metadata.is_dir() {
                let mut all_dirs: std::collections::HashSet<std::path::PathBuf> =
                    std::collections::HashSet::new();
                let mut dirs_with_files: std::collections::HashSet<std::path::PathBuf> =
                    std::collections::HashSet::new();

                all_dirs.insert(p.clone());

                for entry in walkdir::WalkDir::new(&p).min_depth(1) {
                    let entry = entry.map_err(|e| {
                        crate::localized_error!("backendErrors.request.failed", "error" => e.to_string())
                    })?;
                    let file_path = entry.path().to_path_buf();
                    if entry.file_type().is_dir() {
                        all_dirs.insert(file_path);
                    } else if entry.file_type().is_file() {
                        let mut curr = file_path.parent();
                        while let Some(dir) = curr {
                            dirs_with_files.insert(dir.to_path_buf());
                            if dir == p {
                                break;
                            }
                            curr = dir.parent();
                        }

                        let rel_name = file_path
                            .strip_prefix(parent)
                            .unwrap_or(&file_path)
                            .to_string_lossy()
                            .to_string()
                            .replace('\\', "/");

                        let rel = file_path
                            .strip_prefix(&p)
                            .unwrap_or(&file_path)
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
                        file_entries.push((file_path, remote_dir, rel_name));
                    }
                }

                for dir in all_dirs {
                    if !dirs_with_files.contains(&dir) {
                        let rel = dir
                            .strip_prefix(&p)
                            .unwrap_or(&dir)
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
                        empty_dirs.push(remote_dir);
                    }
                }
            }
        }
        Ok(UploadDiscoveryResult {
            file_entries,
            empty_dir_remotes: empty_dirs,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn execute_upload_batch(
    app: AppHandle,
    params: UploadBatchParams,
) -> Result<String, String> {
    let UploadBatchParams {
        backend,
        remote,
        path,
        local_paths,
        origin,
        group,
        template,
    } = params;
    if local_paths.is_empty() {
        return Err(crate::localized_error!("backendErrors.upload.noFiles"));
    }

    let path = if path == "/" { String::new() } else { path };
    let mut remote = remote;
    if !remote.is_empty()
        && !remote.ends_with(':')
        && !remote.contains('/')
        && !remote.contains('\\')
    {
        remote.push(':');
    }

    debug!(
        "execute_upload_batch: {} paths to {remote}:{path}",
        local_paths.len()
    );

    let backend_manager = app.state::<BackendManager>();
    let backend = match backend {
        Some(backend) => backend,
        None => backend_manager.get_active().await,
    };
    let transport = RoutingTransport::for_backend(app.clone(), backend.clone());
    let destination = build_full_path(&remote, &path);
    let mut metadata = JobMetadata::new(
        remote.clone(),
        JobType::Upload,
        local_paths.clone(),
        destination,
    )
    .with_origin(origin)
    .with_group(group);
    let options = transfer_options(&app, template, TransferMode::Copy).await;

    // An engine on this machine reads the files itself, as one rclone job like any
    // copy. Only an engine elsewhere cannot see them and needs their bytes sent.
    if backend.is_local || matches!(transport.kind().await, TransportKind::Librclone) {
        let items = local_upload_items(&local_paths).await?;
        return submit_transfer_job(
            app,
            transfer_inputs(&items, &remote, &path, TransferMode::Copy),
            options,
            metadata,
            SubmitJobOptions {
                wait_for_completion: true,
                backend: Some(backend),
            },
        )
        .await;
    }
    // rclone reads the options of an upload from its query, as flat names or as
    // `_config` and `_filter` in JSON.
    let option_query = upload_query(&options.options);
    metadata = metadata
        .with_dry_run(lookup_dry_run(
            &serde_json::Value::Object(options.options),
            None,
            OperationType::Copy,
        ))
        .with_template(options.template);

    let client = app.state::<RcloneState>().client.clone();
    let job_cache = backend_manager.job_cache_for(&backend.name);

    let discovery = discover_upload_entries(local_paths, path).await?;

    for remote_dir in &discovery.empty_dir_remotes {
        let payload = json!({ "fs": &remote, "remote": remote_dir });
        transport
            .rpc(operations::MKDIR, Some(&payload))
            .await
            .map_err(|e| {
                crate::localized_error!("backendErrors.request.failed", "error" => e.to_string())
            })?;
    }

    let file_entries = discovery.file_entries;
    if file_entries.is_empty() {
        return Ok("0".to_string());
    }

    let total_files = file_entries.len();
    let mut total_bytes = 0;
    for (file_path, _, _) in &file_entries {
        total_bytes += tokio::fs::metadata(file_path).await.map_err(|e| {
            crate::localized_error!("backendErrors.request.failed", "error" => format!("{}: {e}", file_path.display()))
        })?.len();
    }

    let jobid = next_upload_jobid();
    metadata.prepare_execution();
    let group_name = metadata.group_name();
    let cancellation = CancellationToken::new();
    let (cancel_result, cancel_receiver) = tokio::sync::watch::channel(None);
    {
        let mut uploads = job_cache.uploads.lock();
        if uploads.contains_key(&jobid) {
            return Err(
                crate::localized_error!("backendErrors.request.failed", "error" => "Upload job already running"),
            );
        }
        uploads.insert(
            jobid,
            crate::utils::types::jobs::UploadCancellation {
                token: cancellation.clone(),
                result: cancel_receiver,
            },
        );
    }
    let _registration = UploadRegistration {
        cache: job_cache.clone(),
        id: jobid,
        token: cancellation.clone(),
        result: cancel_result.clone(),
    };

    job_cache
        .create_job(jobid, metadata.clone(), backend.name.clone())
        .await;
    job_cache.prune_finished(Some(&app)).await;
    notify(&app, metadata.started_event(backend.name.clone()));

    let progress = Arc::new(Mutex::new(UploadProgress::new()));

    let mut stream = futures::stream::iter(file_entries)
        .map(|(file_path, remote_dir, rel_name)| {
            let backend = backend.clone();
            let client = client.clone();
            let remote = remote.clone();
            let progress = progress.clone();
            let job_cache = job_cache.clone();
            let group_name = group_name.clone();
            let cancellation = cancellation.clone();
            let option_query = option_query.clone();

            async move {
                if cancellation.is_cancelled() {
                    return;
                }
                let filename = rel_name;
                let started_at = chrono::Utc::now();
                let src_fs = file_path
                    .parent()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default();
                let dst_fs = build_full_path(&remote, &remote_dir);
                let entry = UploadEntry {
                    name: &filename,
                    src_fs: &src_fs,
                    dst_fs: &dst_fs,
                    group: &group_name,
                    started_at,
                };

                let file = match tokio::fs::File::open(&file_path).await {
                    Ok(f) => f,
                    Err(e) => {
                        // Build JSON outside the lock to minimize contention.
                        let err_msg = format!("Failed to open {filename}: {e}");
                        let completed_entry = entry.completed(0, 0, &err_msg);
                        let stats = {
                            let mut state = progress.lock();
                            state.errors.push(err_msg);
                            state.completed.push(completed_entry);
                            state.progress_stats(total_bytes, total_files)
                        };
                        if let Some(stats) = stats {
                            let _ = job_cache.update_job_stats(jobid, stats).await;
                        }
                        return;
                    }
                };

                let size = file.metadata().await.map(|m| m.len()).unwrap_or(0);

                {
                    // Build JSON outside the lock to minimize contention.
                    let transferring_entry = entry.transferring(size);
                    let stats = {
                        let mut state = progress.lock();
                        state.transferring.push(transferring_entry);
                        state.progress_stats(total_bytes, total_files)
                    };
                    if let Some(stats) = stats {
                        let _ = job_cache.update_job_stats(jobid, stats).await;
                    }
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
                        // Build JSON outside the lock to minimize contention.
                        let err_msg = format!("Multipart error for {filename}: {e}");
                        let completed_entry = entry.completed(size, 0, &err_msg);
                        let stats = {
                            let mut state = progress.lock();
                            state.remove_transferring(&filename);
                            state.errors.push(err_msg);
                            state.completed.push(completed_entry);
                            state.progress_stats(total_bytes, total_files)
                        };
                        if let Some(stats) = stats {
                            let _ = job_cache.update_job_stats(jobid, stats).await;
                        }
                        return;
                    }
                };

                let request = backend
                    .inject_auth(
                        client
                            .post(backend.url_for(operations::UPLOADFILE))
                            .query(&[("fs", &remote), ("remote", &remote_dir)])
                            .query(&option_query),
                    )
                    .multipart(reqwest::multipart::Form::new().part("file", part))
                    .send();
                let resp = tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return,
                    result = request => result,
                };

                let result = match resp {
                    Ok(r) if r.status().is_success() => Ok(size),
                    Ok(r) => {
                        let status = r.status();
                        let err_text = tokio::select! {
                            biased;
                            _ = cancellation.cancelled() => return,
                            text = r.text() => text.unwrap_or_default(),
                        };
                        let err_msg = parse_rclone_error(&err_text);
                        Err(format!(
                            "Upload failed for {filename}: {status} - {err_msg}"
                        ))
                    }
                    Err(e) => Err(format!("Network error for {filename}: {e}")),
                };

                {
                    // Build JSON outside the lock to minimize contention.
                    let completed_entry = match &result {
                        Ok(uploaded_size) => entry.completed(*uploaded_size, *uploaded_size, ""),
                        Err(err_msg) => entry.completed(size, 0, err_msg),
                    };
                    let stats = {
                        let mut state = progress.lock();
                        state.remove_transferring(&filename);
                        match result {
                            Ok(uploaded_size) => {
                                state.uploaded_bytes += uploaded_size;
                                state.completed.push(completed_entry);
                            }
                            Err(err_msg) => {
                                state.errors.push(err_msg);
                                state.completed.push(completed_entry);
                            }
                        }
                        state.progress_stats(total_bytes, total_files)
                    };
                    if let Some(stats) = stats {
                        let _ = job_cache.update_job_stats(jobid, stats).await;
                    }
                }
            }
        })
        .buffer_unordered(4);

    while stream.next().await.is_some() {}
    drop(stream);
    let stats = {
        let mut state = progress.lock();
        state.transferring.clear();
        state.build_stats(total_bytes, total_files)
    };
    let _ = job_cache.update_job_stats(jobid, stats).await;
    if cancellation.is_cancelled() {
        job_cache.stop_job(jobid).await?;
        cancel_result.send_replace(Some(Ok(())));
        notify(&app, metadata.stopped_event(backend.name.clone()));
        return Err(crate::localized_error!("backendErrors.job.stopped"));
    }

    let (success, error_msg) = {
        let state = progress.lock();
        let success = state.errors.is_empty();
        let error_msg = (!success)
            .then(|| format!("{} failed: {}", state.errors.len(), state.errors.join("; ")));
        (success, error_msg)
    };

    let final_status = job_cache
        .complete_job(jobid, success, error_msg.clone())
        .await?;
    if final_status == crate::utils::types::jobs::JobStatus::Stopped {
        notify(&app, metadata.stopped_event(backend.name.clone()));
        return Err(crate::localized_error!("backendErrors.job.stopped"));
    }
    if success {
        notify(&app, metadata.completed_event(backend.name.clone()));
    } else if let Some(ref m) = error_msg {
        notify(&app, metadata.failed_event(backend.name.clone(), m));
    }

    error_msg.map_or(Ok(jobid.to_string()), Err)
}

pub async fn upload_local_drop_paths(
    app: AppHandle,
    remote: String,
    path: String,
    local_paths: Vec<String>,
    origin: Option<Origin>,
    group: Option<String>,
    template: Option<String>,
) -> Result<String, String> {
    execute_upload_batch(
        app,
        UploadBatchParams {
            backend: None,
            remote,
            path,
            local_paths,
            origin,
            group,
            template,
        },
    )
    .await
}

/// Options as query parameters: a text as it is, anything else as JSON.
fn upload_query(options: &serde_json::Map<String, serde_json::Value>) -> Vec<(String, String)> {
    options
        .iter()
        .map(|(key, value)| {
            let value = match value {
                serde_json::Value::String(text) => text.clone(),
                other => other.to_string(),
            };
            (key.clone(), value)
        })
        .collect()
}

pub async fn upload_file(
    app: AppHandle,
    remote: String,
    path: String,
    name: String,
    content: Vec<u8>,
) -> Result<String, String> {
    let state = app.state::<crate::utils::types::state::RcloneState>();
    let backend = app.state::<BackendManager>().get_active().await;
    let transport = RoutingTransport::for_backend(app.clone(), backend.clone());
    let remote_dir = if path.is_empty() {
        String::new()
    } else if path.ends_with('/') {
        path.clone()
    } else {
        format!("{path}/")
    };

    match transport.kind().await {
        // Desktop: use reqwest::multipart to stream the file bytes directly.
        TransportKind::HttpDaemon => {
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
        // Mobile (librclone): the rc protocol doesn't accept multipart bodies via JSON RPC.
        // Write the bytes to a temp file, then use operations/copyfile to copy
        // from the local temp file to the destination remote.
        TransportKind::Librclone => {
            let dst_remote = if remote_dir.is_empty() {
                name.clone()
            } else {
                format!("{remote_dir}{name}")
            };

            let tmp = tempfile::Builder::new()
                .prefix("rclone_upload_")
                .tempfile()
                .map_err(|e| format!("Failed to create temp file: {e}"))?;

            tokio::fs::write(tmp.path(), &content)
                .await
                .map_err(|e| format!("Failed to write temp file: {e}"))?;

            let tmp_parent = tmp
                .path()
                .parent()
                .ok_or_else(|| "Invalid temp file parent directory".to_string())?;

            let tmp_filename = tmp
                .path()
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| "Invalid temp filename".to_string())?;

            let src_fs = tmp_parent.to_string_lossy().to_string();
            let dst_fs = if remote.is_empty() || remote == ":" {
                "".to_string()
            } else if remote.ends_with(':') || remote.contains('/') || remote.contains('\\') {
                remote.clone()
            } else {
                format!("{remote}:")
            };

            let payload = json!({
                "srcFs": src_fs,
                "srcRemote": tmp_filename,
                "dstFs": dst_fs,
                "dstRemote": &dst_remote,
            });

            transport
                .rpc(operations::COPYFILE, Some(&payload))
                .await
                .map_err(|e| format!("Upload failed: {e}"))?;

            // Temp file is auto-cleaned when `tmp` drops.
            Ok("File uploaded successfully".to_string())
        }
    }
}

fn parse_rclone_error(err_text: &str) -> String {
    serde_json::from_str::<serde_json::Value>(err_text)
        .ok()
        .and_then(|val| val.get("error").and_then(|e| e.as_str()).map(String::from))
        .unwrap_or_else(|| err_text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn local_files_are_copied_from_their_folder_and_folders_whole() {
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path().join("özel klasör");
        let file = temp.path().join("report..txt");
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(&file, "x").unwrap();
        let folder_raw = folder.to_string_lossy().into_owned();
        let items = local_upload_items(&[folder_raw.clone(), file.to_string_lossy().into_owned()])
            .await
            .unwrap();
        assert_eq!(
            (
                items[0].remote.as_str(),
                items[0].path.as_str(),
                items[0].name.as_str(),
                items[0].is_dir
            ),
            (folder_raw.as_str(), "", "özel klasör", true)
        );
        assert_eq!(
            (
                items[1].remote.as_str(),
                items[1].path.as_str(),
                items[1].name.as_str(),
                items[1].is_dir
            ),
            (
                temp.path().to_string_lossy().as_ref(),
                "report..txt",
                "report..txt",
                false
            )
        );
        // The folder lands under its own name, created first so an empty one arrives.
        let inputs = transfer_inputs(&items, "drive:", "target", TransferMode::Copy);
        assert_eq!(inputs[0]["remote"], "target/özel klasör");
        assert_eq!(inputs[1]["srcFs"], folder_raw.as_str());
        assert_eq!(inputs[1]["dstFs"], "drive:target/özel klasör");
        assert_eq!(inputs[2]["dstRemote"], "target/report..txt");
    }

    #[test]
    fn upload_options_travel_in_the_query_as_rclone_reads_them() {
        let options = serde_json::json!({
            "checksum": true,
            "low_level_retries": 20,
            "max_transfer": "1G",
            "_config": {"LowLevelRetries": 20},
        });
        let mut query = upload_query(options.as_object().unwrap());
        query.sort();
        assert_eq!(
            query,
            [
                ("_config", r#"{"LowLevelRetries":20}"#),
                ("checksum", "true"),
                ("low_level_retries", "20"),
                ("max_transfer", "1G"),
            ]
            .map(|(key, value)| (key.to_string(), value.to_string()))
        );
    }

    #[tokio::test]
    async fn local_items_refuse_missing_sources_and_nameless_roots() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("missing").to_string_lossy().into_owned();
        assert!(local_upload_items(&[missing]).await.is_err());
        let root = if cfg!(windows) { "C:\\" } else { "/" };
        assert!(
            local_upload_items(&[root.into()])
                .await
                .unwrap_err()
                .contains("backendErrors.upload.invalidPath")
        );
    }

    #[tokio::test]
    async fn cancellation_waits_for_confirmation_and_propagates_failure() {
        for result in [Ok(()), Err("stop denied".to_string())] {
            let cache = Arc::new(JobCache::new());
            let token = CancellationToken::new();
            let (sender, receiver) = tokio::sync::watch::channel(None);
            cache.uploads.lock().insert(
                7,
                crate::utils::types::jobs::UploadCancellation {
                    token: token.clone(),
                    result: receiver,
                },
            );
            let waiting = cache.cancel_upload(7);
            tokio::pin!(waiting);
            tokio::select! {
                result = &mut waiting => panic!("Cancellation returned before confirmation: {result:?}"),
                _ = token.cancelled() => {},
            }
            sender.send_replace(Some(result.clone()));
            assert_eq!(waiting.await, result.map(|()| true));
        }
        assert!(!JobCache::new().cancel_upload(99).await.unwrap());
    }

    #[tokio::test]
    async fn discovers_nested_files_and_empty_directories() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("folder");
        std::fs::create_dir_all(root.join("nested")).unwrap();
        std::fs::create_dir_all(root.join("empty/child")).unwrap();
        std::fs::write(root.join("nested/özel..txt"), "data").unwrap();
        let discovery =
            discover_upload_entries(vec![root.to_string_lossy().into_owned()], "target/".into())
                .await
                .unwrap();
        assert_eq!(
            discovery.file_entries,
            vec![(
                root.join("nested/özel..txt"),
                "target/folder/nested".into(),
                "folder/nested/özel..txt".into()
            )]
        );
        let mut dirs = discovery.empty_dir_remotes;
        dirs.sort();
        assert_eq!(dirs, ["target/folder/empty", "target/folder/empty/child"]);
    }

    #[tokio::test]
    async fn missing_source_fails_instead_of_reporting_success() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("missing").to_string_lossy().into_owned();
        assert!(
            discover_upload_entries(vec![missing], String::new())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn single_file_and_empty_input_preserve_root_destination() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("file.txt");
        std::fs::write(&file, "").unwrap();
        let result = discover_upload_entries(vec![file.to_string_lossy().into_owned()], "/".into())
            .await
            .unwrap();
        assert_eq!(
            result.file_entries,
            vec![(file, String::new(), "file.txt".into())]
        );
        assert!(result.empty_dir_remotes.is_empty());
        let result = discover_upload_entries(vec![], String::new())
            .await
            .unwrap();
        assert!(result.file_entries.is_empty());
        assert!(result.empty_dir_remotes.is_empty());
    }
    #[test]
    fn concurrent_uploads_have_distinct_javascript_safe_job_ids() {
        let mut ids = std::thread::scope(|scope| {
            let workers: Vec<_> = (0..4)
                .map(|_| scope.spawn(|| (0..100).map(|_| next_upload_jobid()).collect::<Vec<_>>()))
                .collect();
            workers
                .into_iter()
                .flat_map(|worker| worker.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert!(ids.iter().all(|id| *id < (1_u64 << 53)));
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 400);
    }
    #[test]
    fn stats_count_successful_transfers_separately_from_failed_files() {
        let mut progress = UploadProgress::new();
        progress.completed.push(json!({"name": "ok", "bytes": 10}));
        progress
            .completed
            .push(json!({"name": "failed", "bytes": 0}));
        progress.errors.push("failed".into());
        progress.uploaded_bytes = 10;
        let stats = progress.build_stats(20, 2);
        assert_eq!(stats["transfers"], 1);
        assert_eq!(stats["errors"], 1);
        assert_eq!(stats["bytes"], 10);
        assert_eq!(stats["totalTransfers"], 2);
        assert_eq!(stats["completed"].as_array().unwrap().len(), 2);
    }
}
