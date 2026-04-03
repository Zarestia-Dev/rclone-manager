use log::debug;
use serde::Serialize;
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

#[tauri::command]
pub async fn upload_local_drop_paths(
    app: AppHandle,
    remote: String,
    path: String,
    local_paths: Vec<String>,
) -> Result<LocalDropUploadResult, String> {
    use reqwest::multipart;
    use std::collections::HashSet;
    use std::path::PathBuf;
    use walkdir::WalkDir;

    let state = app.state::<RcloneState>();
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    let upload_url = backend.url_for(operations::UPLOADFILE);
    let mkdir_url = backend.url_for(operations::MKDIR);

    let mut created_directories = HashSet::new();
    let mut uploaded = 0usize;
    let mut failed = Vec::new();

    for raw_path in local_paths {
        let root = PathBuf::from(&raw_path);
        if !root.exists() {
            failed.push(raw_path);
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
                let rel = relative_unix_path(rel_path);
                if rel.is_empty() {
                    continue;
                }

                if entry.file_type().is_dir() {
                    let remote_dir = join_remote_path(&path, &rel);
                    if remote_dir.is_empty() || created_directories.contains(&remote_dir) {
                        continue;
                    }

                    let response = backend
                        .inject_auth(state.client.post(&mkdir_url))
                        .json(&json!({ "fs": remote.clone(), "remote": remote_dir }))
                        .send()
                        .await
                        .map_err(|e| format!("Failed to create directory: {}", e))?;

                    if response.status().is_success() {
                        created_directories.insert(remote_dir);
                    }
                    continue;
                }

                let target_full = join_remote_path(&path, &rel);
                let (remote_dir, filename) = match target_full.rsplit_once('/') {
                    Some((dir, name)) => (dir.to_string(), name.to_string()),
                    None => (String::new(), target_full),
                };

                if filename.trim().is_empty() {
                    failed.push(current.display().to_string());
                    continue;
                }

                if !remote_dir.is_empty() && !created_directories.contains(&remote_dir) {
                    let mkdir_response = backend
                        .inject_auth(state.client.post(&mkdir_url))
                        .json(&json!({ "fs": remote.clone(), "remote": remote_dir }))
                        .send()
                        .await
                        .map_err(|e| format!("Failed to create directory: {}", e))?;

                    if mkdir_response.status().is_success() {
                        created_directories.insert(remote_dir.clone());
                    }
                }

                let bytes = match tokio::fs::read(current).await {
                    Ok(content) => content,
                    Err(_) => {
                        failed.push(current.display().to_string());
                        continue;
                    }
                };

                let part = multipart::Part::bytes(bytes)
                    .file_name(filename)
                    .mime_str("application/octet-stream")
                    .map_err(|e| e.to_string())?;
                let form = multipart::Form::new().part("file", part);

                let response = backend
                    .inject_auth(
                        state
                            .client
                            .post(&upload_url)
                            .query(&[("fs", &remote), ("remote", &remote_dir)]),
                    )
                    .multipart(form)
                    .send()
                    .await
                    .map_err(|e| format!("Failed to send upload request: {}", e))?;

                if response.status().is_success() {
                    uploaded += 1;
                } else {
                    failed.push(current.display().to_string());
                }
            }
            continue;
        }

        let file_name = root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if file_name.trim().is_empty() {
            failed.push(root.display().to_string());
            continue;
        }

        let bytes = match tokio::fs::read(&root).await {
            Ok(content) => content,
            Err(_) => {
                failed.push(root.display().to_string());
                continue;
            }
        };

        let part = multipart::Part::bytes(bytes)
            .file_name(file_name)
            .mime_str("application/octet-stream")
            .map_err(|e| e.to_string())?;
        let form = multipart::Form::new().part("file", part);

        let response = backend
            .inject_auth(
                state
                    .client
                    .post(&upload_url)
                    .query(&[("fs", &remote), ("remote", &path)]),
            )
            .multipart(form)
            .send()
            .await
            .map_err(|e| format!("Failed to send upload request: {}", e))?;

        if response.status().is_success() {
            uploaded += 1;
        } else {
            failed.push(root.display().to_string());
        }
    }

    Ok(LocalDropUploadResult { uploaded, failed })
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
