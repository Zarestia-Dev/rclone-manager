use log::debug;
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
            origin: source,
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
            origin: source,
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
            origin: source,
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
            origin: source,
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
            origin: source,
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
            origin: source,
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
            origin: source,
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
            origin: source,
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
            origin: source,
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
            origin: source,
            group: None,
            no_cache: no_cache.unwrap_or(false),
        },
    )
    .await?;

    Ok(jobid)
}
