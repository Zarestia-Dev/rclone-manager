//! Custom upload commands for streaming and batch processing to rclone remotes.

use crate::context::AppHandle;
use futures::{StreamExt, TryStreamExt};
use log::debug;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;

use crate::rclone::backend::BackendManager;
use crate::rclone::backend::TransportKind;
use crate::rclone::backend::{routing_transport::RoutingTransport, types::Backend};
use crate::rclone::commands::filesystem::{
    ExistingFiles, FsItem, TransferMode, TransferOptions, refuse_transfer_into_itself,
    submit_transfer_job, transfer_inputs, transfer_options,
};
use crate::rclone::commands::job::{JobMetadata, SubmitJobOptions};
use crate::rclone::commands::own_job::{FileCopy, OwnJob};
use crate::rclone::endpoints::operations;
use crate::utils::json_helpers::build_full_path;
use crate::utils::types::jobs::JobType;
use crate::utils::types::origin::Origin;
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
    /// The options to transfer with, as the transfer dialog sets them; `None` for the
    /// file browser's default.
    pub options: Option<serde_json::Value>,
    /// How a picked file or folder lands where one of the same name exists, by its name.
    #[serde(default)]
    pub targets: HashMap<String, UploadTarget>,
}

/// How a picked file or folder lands where the destination holds one of the same name, as the
/// file browser's conflict dialog decided. A picked path without one lands under its own name.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadTarget {
    /// The name it gets instead of its own, so both are kept.
    #[serde(default)]
    pub name: Option<String>,
    /// For a folder merged into one of the same name: what happens to the files of the same name
    /// there.
    #[serde(default)]
    pub existing_files: ExistingFiles,
}

/// The name a picked path lands under and what it does with the files of the same name there.
fn target_of<'a>(
    targets: &'a HashMap<String, UploadTarget>,
    own_name: &'a str,
) -> (&'a str, ExistingFiles) {
    targets
        .get(own_name)
        .map_or((own_name, ExistingFiles::Replace), |target| {
            (
                target.name.as_deref().unwrap_or(own_name),
                target.existing_files,
            )
        })
}

/// Whether a file streamed into a merged folder replaces the one of the same name there. Keeping
/// the newer of the two follows rclone's `--update`: the file there stays when it is newer, and
/// at the same time (within a second) when it has the same size. A time either side does not
/// know leaves the decision to the sizes.
fn replaces_existing(
    policy: ExistingFiles,
    incoming: (Option<chrono::DateTime<chrono::Utc>>, u64),
    there: (Option<chrono::DateTime<chrono::Utc>>, u64),
) -> bool {
    match policy {
        ExistingFiles::Replace => true,
        ExistingFiles::Keep => false,
        ExistingFiles::Newer => match (incoming.0, there.0) {
            (Some(incoming_time), Some(there_time)) => {
                let difference = incoming_time - there_time;
                if difference.abs() <= chrono::TimeDelta::seconds(1) {
                    incoming.1 != there.1
                } else {
                    difference > chrono::TimeDelta::zero()
                }
            }
            _ => incoming.1 != there.1,
        },
    }
}

/// Files and folders on the engine's own disk as transfer items: a file is copied
/// from its folder, a folder as a whole, each under the name its target gives it.
async fn local_upload_items(
    local_paths: &[String],
    targets: &HashMap<String, UploadTarget>,
) -> Result<Vec<FsItem>, String> {
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
        let (target_name, existing_files) = target_of(targets, &name);
        let target_name = target_name.to_owned();
        items.push(if metadata.is_dir() {
            FsItem {
                remote: raw.clone(),
                path: String::new(),
                name: target_name,
                is_dir: true,
                existing_files,
            }
        } else {
            FsItem {
                remote: path
                    .parent()
                    .map(|parent| parent.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                path: name,
                name: target_name,
                is_dir: false,
                existing_files,
            }
        });
    }
    Ok(items)
}

/// A picked local file or folder as the file browser's conflict dialog compares it with what
/// the destination holds.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPathInfo {
    pub name: String,
    pub is_dir: bool,
    /// Zero for a folder.
    pub size: u64,
    /// RFC 3339, when the system keeps one.
    pub mod_time: Option<String>,
}

/// The name, kind, size and modification time of each picked local path, in order.
pub async fn local_path_info(paths: Vec<String>) -> Result<Vec<LocalPathInfo>, String> {
    let mut infos = Vec::with_capacity(paths.len());
    for raw in paths {
        let path = std::path::Path::new(&raw);
        let metadata = tokio::fs::metadata(path).await.map_err(|e| {
            crate::localized_error!("backendErrors.request.failed", "error" => format!("{}: {e}", path.display()))
        })?;
        let name = path
            .file_name()
            .ok_or_else(|| crate::localized_error!("backendErrors.upload.invalidPath"))?
            .to_string_lossy()
            .into_owned();
        infos.push(LocalPathInfo {
            name,
            is_dir: metadata.is_dir(),
            size: if metadata.is_dir() { 0 } else { metadata.len() },
            mod_time: metadata
                .modified()
                .ok()
                .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339()),
        });
    }
    Ok(infos)
}

/// A file to stream to the destination.
struct UploadFile {
    path: std::path::PathBuf,
    /// The folder it goes to, relative to the destination remote.
    remote_dir: String,
    /// Its name there.
    name: String,
    /// Where it sits under the picked paths, as progress and errors name it.
    rel_name: String,
    /// The destination folder it is merged into, if it keeps some of the files there.
    merged_into: Option<String>,
    /// What it does with a file of the same name there.
    existing_files: ExistingFiles,
    size: u64,
    modified: Option<chrono::DateTime<chrono::Utc>>,
}

struct UploadDiscoveryResult {
    file_entries: Vec<UploadFile>,
    empty_dir_remotes: Vec<String>,
}

/// Discovers files and empty directories within folders recursively.
/// Runs in a blocking thread to prevent UI freezes on large directories.
async fn discover_upload_entries(
    local_paths: Vec<String>,
    remote_path: String,
    targets: HashMap<String, UploadTarget>,
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
            let own_name = p
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let (top_name, existing_files) = target_of(&targets, &own_name);
            let top_name = top_name.to_owned();

            if metadata.is_file() {
                file_entries.push(UploadFile {
                    remote_dir: remote_path.to_string(),
                    name: top_name,
                    rel_name: own_name,
                    merged_into: None,
                    existing_files: ExistingFiles::Replace,
                    size: metadata.len(),
                    modified: metadata.modified().ok().map(Into::into),
                    path: p,
                });
            } else if metadata.is_dir() {
                let base = if remote_path.is_empty() {
                    top_name.clone()
                } else {
                    format!("{}/{}", remote_path.trim_end_matches('/'), top_name)
                };
                let merged_into =
                    (existing_files != ExistingFiles::Replace).then(|| base.clone());
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
                        let remote_dir = if rel.is_empty() {
                            base.clone()
                        } else {
                            format!("{}/{}", base, rel.replace('\\', "/"))
                        };
                        let file_metadata = entry.metadata().ok();
                        file_entries.push(UploadFile {
                            remote_dir,
                            name: entry.file_name().to_string_lossy().into_owned(),
                            rel_name,
                            merged_into: merged_into.clone(),
                            existing_files,
                            size: file_metadata.as_ref().map_or(0, std::fs::Metadata::len),
                            modified: file_metadata
                                .and_then(|metadata| metadata.modified().ok())
                                .map(Into::into),
                            path: file_path,
                        });
                    }
                }

                for dir in all_dirs {
                    if !dirs_with_files.contains(&dir) {
                        let rel = dir
                            .strip_prefix(&p)
                            .unwrap_or(&dir)
                            .to_string_lossy()
                            .to_string();
                        empty_dirs.push(if rel.is_empty() {
                            base.clone()
                        } else {
                            format!("{}/{}", base, rel.replace('\\', "/"))
                        });
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
) -> Result<u64, String> {
    let UploadBatchParams {
        backend,
        remote,
        path,
        local_paths,
        origin,
        group,
        options,
        targets,
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
    let options = transfer_options(&app, options, TransferMode::Copy);

    // An engine on this machine reads the files itself, as one rclone job like any
    // copy. Only an engine elsewhere cannot see them and needs their bytes sent.
    if backend.is_local || matches!(transport.kind().await, TransportKind::Librclone) {
        let items = local_upload_items(&local_paths, &targets).await?;
        refuse_transfer_into_itself(&items, &remote, &path)?;
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
    // Each file goes to `operations/uploadfile`, which writes it as it streams (`Rcat`):
    // copy options and filters are never read there and backend options hardly at all,
    // so none are sent and the job does not list them. The destination's own options
    // apply, as part of its name.
    let options = TransferOptions {
        remotes: options.remotes,
        ..TransferOptions::default()
    };
    let fs = options
        .apply_remotes(serde_json::Map::from_iter([(
            "fs".to_string(),
            json!(remote),
        )]))?
        .remove("fs")
        .and_then(|fs| fs.as_str().map(str::to_owned))
        .unwrap_or_else(|| remote.clone());
    metadata = metadata.with_transfer_options(options.summary());

    let client = app.state::<RcloneState>().client.clone();

    let discovery = discover_upload_entries(local_paths, path, targets).await?;

    for remote_dir in &discovery.empty_dir_remotes {
        let payload = json!({ "fs": &fs, "remote": remote_dir });
        transport
            .rpc(operations::MKDIR, Some(&payload))
            .await
            .map_err(|e| {
                crate::localized_error!("backendErrors.request.failed", "error" => e.to_string())
            })?;
    }

    let mut file_entries = discovery.file_entries;
    // A folder merged into one of the same name that keeps some of the files there: one listing
    // of that folder finds them, and the files that would not replace them are left out. Only
    // keeping the newer file needs the times, which some remotes read file by file.
    let merged: HashMap<String, ExistingFiles> = file_entries
        .iter()
        .filter_map(|file| Some((file.merged_into.clone()?, file.existing_files)))
        .collect();
    let mut existing = HashMap::new();
    for (dir, policy) in merged {
        let listing = transport
            .rpc(
                operations::LIST,
                Some(&json!({
                    "fs": &fs,
                    "remote": &dir,
                    "opt": {
                        "recurse": true,
                        "filesOnly": true,
                        "noModTime": policy != ExistingFiles::Newer,
                        "noMimeType": true,
                    },
                })),
            )
            .await
            .map_err(|e| {
                crate::localized_error!("backendErrors.request.failed", "error" => e.to_string())
            })?;
        existing.extend(
            listing["list"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|entry| {
                    let modified = entry["ModTime"]
                        .as_str()
                        .and_then(|time| chrono::DateTime::parse_from_rfc3339(time).ok())
                        .map(Into::into);
                    let size = entry["Size"].as_u64().unwrap_or(0);
                    Some((
                        format!("{dir}/{}", entry["Path"].as_str()?),
                        (modified, size),
                    ))
                }),
        );
    }
    file_entries.retain(|file| {
        file.merged_into.is_none()
            || existing
                .get(&format!("{}/{}", file.remote_dir, file.name))
                .is_none_or(|there| {
                    replaces_existing(file.existing_files, (file.modified, file.size), *there)
                })
    });
    if file_entries.is_empty() {
        return Ok(0);
    }

    let total_bytes = file_entries.iter().map(|file| file.size).sum();
    let job = OwnJob::start(
        &app,
        &backend.name,
        metadata,
        false,
        total_bytes,
        file_entries.len(),
    )
    .await;
    let jobid = job.id();
    let target = StreamTarget {
        backend: &backend,
        client: &client,
        remote: &remote,
        fs: &fs,
    };
    job.run(
        futures::stream::iter(file_entries)
            .for_each_concurrent(4, |file| stream_file(&job, &target, file)),
    )
    .await;
    let failed = job.failed_files();
    let error = (failed > 0)
        .then(|| crate::localized_error!("backendErrors.upload.filesFailed", "count" => failed));
    job.finish(error).await.map(|()| jobid)
}

/// Where a streamed upload sends its files.
struct StreamTarget<'a> {
    backend: &'a Backend,
    client: &'a reqwest::Client,
    remote: &'a str,
    /// The destination as `operations/uploadfile` takes it, with its options.
    fs: &'a str,
}

/// Sends one file to `operations/uploadfile`, counting its bytes as they leave, and lists it as
/// done or failed. A file the user stopped is left unsent.
async fn stream_file(job: &OwnJob, target: &StreamTarget<'_>, file: UploadFile) {
    let stop = job.cancellation();
    if stop.is_cancelled() {
        return;
    }
    let transfer = job.begin(FileCopy {
        name: file.rel_name,
        src_fs: file
            .path
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned())
            .unwrap_or_default(),
        dst_fs: build_full_path(target.remote, &file.remote_dir),
        size: file.size,
    });
    let result = async {
        // The row names the file; an error is the system's own.
        let reader = tokio::fs::File::open(&file.path)
            .await
            .map_err(|e| e.to_string())?;
        let counter = transfer.clone();
        let body = tokio_util::io::ReaderStream::new(reader)
            .inspect_ok(move |chunk| counter.add_bytes(chunk.len() as u64));
        let part = reqwest::multipart::Part::stream(reqwest::Body::wrap_stream(body))
            .file_name(file.name)
            .mime_str("application/octet-stream")
            .map_err(|e| e.to_string())?;
        let request = target
            .backend
            .inject_auth(
                target
                    .client
                    .post(target.backend.url_for(operations::UPLOADFILE))
                    .query(&[("fs", target.fs), ("remote", &file.remote_dir)]),
            )
            .multipart(reqwest::multipart::Form::new().part("file", part))
            .send();
        let stopped = || crate::localized_error!("backendErrors.job.stopped");
        let response = tokio::select! {
            biased;
            () = stop.cancelled() => return Err(stopped()),
            response = request => response.map_err(|e| e.to_string())?,
        };
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        let text = tokio::select! {
            biased;
            () = stop.cancelled() => return Err(stopped()),
            text = response.text() => text.unwrap_or_default(),
        };
        let message = parse_rclone_error(&text);
        Err(if message.trim().is_empty() {
            status.to_string()
        } else {
            message
        })
    }
    .await;
    job.end(&transfer, result);
}

#[allow(clippy::too_many_arguments)]
pub async fn upload_local_drop_paths(
    app: AppHandle,
    remote: String,
    path: String,
    local_paths: Vec<String>,
    origin: Option<Origin>,
    group: Option<String>,
    options: Option<serde_json::Value>,
    targets: Option<HashMap<String, UploadTarget>>,
) -> Result<u64, String> {
    execute_upload_batch(
        app,
        UploadBatchParams {
            backend: None,
            remote,
            path,
            local_paths,
            origin,
            group,
            options,
            targets: targets.unwrap_or_default(),
        },
    )
    .await
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
    use crate::utils::types::jobs::JobCache;
    use std::sync::Arc;
    use tokio_util::sync::CancellationToken;

    type FileFields = (std::path::PathBuf, String, String, String, Option<String>);

    /// Where each discovered file goes, for comparing whole lists.
    fn files(discovery: &UploadDiscoveryResult) -> Vec<FileFields> {
        discovery
            .file_entries
            .iter()
            .map(|file| {
                (
                    file.path.clone(),
                    file.remote_dir.clone(),
                    file.name.clone(),
                    file.rel_name.clone(),
                    file.merged_into.clone(),
                )
            })
            .collect()
    }

    #[tokio::test]
    async fn a_picked_path_lands_under_the_name_and_merge_its_conflict_got() {
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path().join("docs");
        let file = temp.path().join("a.txt");
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(folder.join("b.txt"), "b").unwrap();
        std::fs::write(&file, "a").unwrap();
        let paths = vec![
            folder.to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
        ];
        let targets = HashMap::from([
            (
                "docs".to_owned(),
                UploadTarget {
                    name: None,
                    existing_files: ExistingFiles::Newer,
                },
            ),
            (
                "a.txt".to_owned(),
                UploadTarget {
                    name: Some("a (2).txt".into()),
                    existing_files: ExistingFiles::Replace,
                },
            ),
        ]);

        let discovery = discover_upload_entries(paths.clone(), "in".into(), targets.clone())
            .await
            .unwrap();
        let mut found = files(&discovery);
        found.sort();
        assert_eq!(
            found,
            [
                (
                    file,
                    "in".to_owned(),
                    "a (2).txt".to_owned(),
                    "a.txt".to_owned(),
                    None
                ),
                (
                    folder.join("b.txt"),
                    "in/docs".to_owned(),
                    "b.txt".to_owned(),
                    "docs/b.txt".to_owned(),
                    Some("in/docs".to_owned())
                ),
            ]
        );

        let merged = discovery
            .file_entries
            .iter()
            .find(|file| file.merged_into.is_some())
            .unwrap();
        assert_eq!(
            (merged.existing_files, merged.size),
            (ExistingFiles::Newer, 1)
        );
        assert!(merged.modified.is_some());

        let items = local_upload_items(&paths, &targets).await.unwrap();
        assert_eq!(
            (items[0].name.as_str(), items[0].existing_files),
            ("docs", ExistingFiles::Newer)
        );
        assert_eq!(
            (
                items[1].path.as_str(),
                items[1].name.as_str(),
                items[1].existing_files
            ),
            ("a.txt", "a (2).txt", ExistingFiles::Replace)
        );
    }

    #[test]
    fn a_merged_file_replaces_the_one_there_as_its_choice_says() {
        let time = |seconds: i64| chrono::DateTime::from_timestamp(seconds, 0);
        let (old, new) = (time(1_000), time(2_000));
        assert!(replaces_existing(
            ExistingFiles::Replace,
            (old, 1),
            (new, 1)
        ));
        assert!(!replaces_existing(ExistingFiles::Keep, (new, 2), (old, 1)));
        // Keeping the newer one: by time, and by size at the same time.
        assert!(replaces_existing(ExistingFiles::Newer, (new, 1), (old, 1)));
        assert!(!replaces_existing(ExistingFiles::Newer, (old, 1), (new, 1)));
        assert!(!replaces_existing(
            ExistingFiles::Newer,
            (old, 5),
            (time(1_001), 5)
        ));
        assert!(replaces_existing(
            ExistingFiles::Newer,
            (old, 5),
            (time(1_001), 6)
        ));
        // Without a time to compare, only a different size replaces it.
        assert!(!replaces_existing(
            ExistingFiles::Newer,
            (None, 5),
            (new, 5)
        ));
        assert!(replaces_existing(ExistingFiles::Newer, (new, 5), (None, 6)));
    }

    #[tokio::test]
    async fn local_files_are_copied_from_their_folder_and_folders_whole() {
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path().join("özel klasör");
        let file = temp.path().join("report..txt");
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(&file, "x").unwrap();
        let folder_raw = folder.to_string_lossy().into_owned();
        let items = local_upload_items(
            &[folder_raw.clone(), file.to_string_lossy().into_owned()],
            &HashMap::new(),
        )
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
        // A file is named from its folder, so the job's row points at where it landed.
        assert_eq!(inputs[2]["srcFs"], temp.path().to_string_lossy().as_ref());
        assert_eq!(inputs[2]["srcRemote"], "report..txt");
        assert_eq!(inputs[2]["dstFs"], "drive:target");
        assert_eq!(inputs[2]["dstRemote"], "report..txt");
    }

    #[tokio::test]
    async fn local_items_refuse_missing_sources_and_nameless_roots() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("missing").to_string_lossy().into_owned();
        assert!(
            local_upload_items(&[missing], &HashMap::new())
                .await
                .is_err()
        );
        let root = if cfg!(windows) { "C:\\" } else { "/" };
        assert!(
            local_upload_items(&[root.into()], &HashMap::new())
                .await
                .unwrap_err()
                .contains("backendErrors.upload.invalidPath")
        );
    }

    #[tokio::test]
    async fn local_path_info_names_kinds_and_sizes_each_path_in_order() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("rapor (1).txt");
        std::fs::write(&file, b"12345").unwrap();
        let folder = temp.path().join("Fotoğraflar");
        std::fs::create_dir(&folder).unwrap();
        let infos = local_path_info(vec![
            folder.to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
        ])
        .await
        .unwrap();
        assert_eq!(infos[0].name, "Fotoğraflar");
        assert!(infos[0].is_dir);
        assert_eq!(infos[0].size, 0);
        assert_eq!(infos[1].name, "rapor (1).txt");
        assert!(!infos[1].is_dir);
        assert_eq!(infos[1].size, 5);
        assert!(
            chrono::DateTime::parse_from_rfc3339(infos[1].mod_time.as_deref().unwrap()).is_ok()
        );

        let missing = temp.path().join("missing").to_string_lossy().into_owned();
        assert!(local_path_info(vec![missing]).await.is_err());
        let root = if cfg!(windows) { "C:\\" } else { "/" };
        assert!(
            local_path_info(vec![root.into()])
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
            cache.own_jobs.lock().insert(
                7,
                crate::utils::types::jobs::OwnJobCancellation {
                    token: token.clone(),
                    result: receiver,
                },
            );
            let waiting = cache.cancel_own_job(7);
            tokio::pin!(waiting);
            tokio::select! {
                result = &mut waiting => panic!("Cancellation returned before confirmation: {result:?}"),
                _ = token.cancelled() => {},
            }
            sender.send_replace(Some(result.clone()));
            assert_eq!(waiting.await, result.map(|()| true));
        }
        assert!(!JobCache::new().cancel_own_job(99).await.unwrap());
    }

    #[tokio::test]
    async fn discovers_nested_files_and_empty_directories() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("folder");
        std::fs::create_dir_all(root.join("nested")).unwrap();
        std::fs::create_dir_all(root.join("empty/child")).unwrap();
        std::fs::write(root.join("nested/özel..txt"), "data").unwrap();
        let discovery = discover_upload_entries(
            vec![root.to_string_lossy().into_owned()],
            "target/".into(),
            HashMap::new(),
        )
        .await
        .unwrap();
        assert_eq!(
            files(&discovery),
            [(
                root.join("nested/özel..txt"),
                "target/folder/nested".to_owned(),
                "özel..txt".to_owned(),
                "folder/nested/özel..txt".to_owned(),
                None
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
            discover_upload_entries(vec![missing], String::new(), HashMap::new())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn single_file_and_empty_input_preserve_root_destination() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("file.txt");
        std::fs::write(&file, "").unwrap();
        let result = discover_upload_entries(
            vec![file.to_string_lossy().into_owned()],
            "/".into(),
            HashMap::new(),
        )
        .await
        .unwrap();
        assert_eq!(
            files(&result),
            [(
                file,
                String::new(),
                "file.txt".to_owned(),
                "file.txt".to_owned(),
                None
            )]
        );
        assert!(result.empty_dir_remotes.is_empty());
        let result = discover_upload_entries(vec![], String::new(), HashMap::new())
            .await
            .unwrap();
        assert!(result.file_entries.is_empty());
        assert!(result.empty_dir_remotes.is_empty());
    }
}
