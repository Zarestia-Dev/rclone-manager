use log::debug;
use serde_json::json;
use tauri::{AppHandle, State};

use crate::rclone::backend::BACKEND_MANAGER;
use crate::rclone::commands::job::{JobMetadata, submit_job};
use crate::utils::rclone::endpoints::operations;
use crate::utils::types::core::RcloneState;

#[tauri::command]
pub async fn mkdir(
    remote: String,
    path: String,
    state: State<'_, RcloneState>,
) -> Result<(), String> {
    debug!("📁 Creating directory: remote={} path={}", remote, path);

    let backend = BACKEND_MANAGER.get_active().await;
    let params = json!({ "fs": remote, "remote": path });
    backend
        .post_json(&state.client, operations::MKDIR, Some(&params))
        .await
        .map_err(|e| format!("❌ Failed to create directory: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn cleanup(
    remote: String,
    path: Option<String>,
    state: State<'_, RcloneState>,
) -> Result<(), String> {
    debug!(
        "🧹 Cleanup remote trash: remote={} path={}",
        remote,
        path.as_deref().unwrap_or("")
    );

    let backend = BACKEND_MANAGER.get_active().await;

    // Build parameters dynamically: include `remote` only when provided
    let mut params = serde_json::Map::new();
    params.insert("fs".to_string(), json!(remote));
    if let Some(p) = path {
        params.insert("remote".to_string(), json!(p));
    }

    backend
        .post_json(&state.client, operations::CLEANUP, Some(&json!(params)))
        .await
        .map_err(|e| format!("❌ Failed to cleanup remote: {e}"))?;

    Ok(())
}

//This command also supports to download files inside remote to. Useful for downloading URLs directly to remote storage.
#[tauri::command]
pub async fn copy_url(
    app: AppHandle,
    state: State<'_, RcloneState>,
    remote: String,
    path: String,
    url_to_copy: String,
    auto_filename: bool,
) -> Result<u64, String> {
    debug!(
        "🔗 Copying URL: remote={}, path={}, url={}, auto_filename={}",
        remote, path, url_to_copy, auto_filename
    );

    let backend = BACKEND_MANAGER.get_active().await;
    let url = backend.url_for(operations::COPYURL);

    let payload = json!({
        "fs": remote.clone(),
        "remote": path.clone(),
        "url": url_to_copy.clone(),
        "autoFilename": auto_filename,
        "_async": true,
    });

    let (jobid, _) = submit_job(
        app,
        state.client.clone(),
        backend.inject_auth(state.client.clone().post(&url)),
        payload,
        JobMetadata {
            remote_name: remote,
            job_type: "copy_url".to_string(),
            operation_name: "Copy from URL".to_string(),
            source: url_to_copy,
            destination: path,
            profile: None,
            source_ui: Some("nautilus".to_string()),
        },
    )
    .await?;

    Ok(jobid)
}
