use log::debug;
use serde_json::{Value, json};
use tauri::command;

use crate::rclone::backend::BackendManager;
use crate::utils::rclone::endpoints::vfs;
use crate::utils::types::core::RcloneState;
use tauri::{AppHandle, Manager};

/// List active VFSes.
#[command]
pub async fn vfs_list(app: AppHandle) -> Result<Value, String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let state = app.state::<RcloneState>();
    let json = backend
        .post_json(&state.client, vfs::LIST, None)
        .await
        .map_err(|e| format!("Failed to fetch VFS list: {e}"))?;

    debug!("✅ VFS List: {json}");
    Ok(json)
}

/// Forget files or directories in the directory cache.
#[command]
pub async fn vfs_forget(
    app: AppHandle,
    fs: Option<String>,
    file: Option<String>,
) -> Result<Value, String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let mut payload = json!({});

    if let Some(f) = fs {
        payload["fs"] = Value::String(f);
    }
    if let Some(f) = file {
        payload["file"] = Value::String(f);
    }

    let state = app.state::<RcloneState>();
    let json = backend
        .post_json(&state.client, vfs::FORGET, Some(&payload))
        .await
        .map_err(|e| format!("Failed to forget paths: {e}"))?;

    Ok(json)
}

/// Refresh the directory cache.
#[command]
pub async fn vfs_refresh(
    app: AppHandle,
    fs: Option<String>,
    dir: Option<String>,
    recursive: bool,
) -> Result<Value, String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let recursive_str = if recursive { "true" } else { "false" };
    let mut payload = json!({
        "recursive": recursive_str
    });

    if let Some(f) = fs {
        payload["fs"] = Value::String(f);
    }
    if let Some(d) = dir {
        payload["dir"] = Value::String(d);
    }

    let state = app.state::<RcloneState>();
    let json = backend
        .post_json(&state.client, vfs::REFRESH, Some(&payload))
        .await
        .map_err(|e| format!("Failed to refresh cache: {e}"))?;

    Ok(json)
}

/// Get stats for a VFS.
#[command]
pub async fn vfs_stats(app: AppHandle, fs: Option<String>) -> Result<Value, String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let mut payload = json!({});
    if let Some(f) = fs {
        payload["fs"] = Value::String(f);
    }

    let state = app.state::<RcloneState>();
    let json = backend
        .post_json(&state.client, vfs::STATS, Some(&payload))
        .await
        .map_err(|e| format!("Failed to fetch VFS stats: {e}"))?;

    Ok(json)
}

/// Get or update the value of the poll-interval option.
#[command]
pub async fn vfs_poll_interval(
    app: AppHandle,
    fs: Option<String>,
    interval: Option<String>,
    timeout: Option<String>,
) -> Result<Value, String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let mut payload = json!({});
    if let Some(f) = fs {
        payload["fs"] = Value::String(f);
    }
    if let Some(i) = interval {
        payload["interval"] = Value::String(i);
    }
    if let Some(t) = timeout {
        payload["timeout"] = Value::String(t);
    }

    let state = app.state::<RcloneState>();
    let json = backend
        .post_json(&state.client, vfs::POLL_INTERVAL, Some(&payload))
        .await
        .map_err(|e| format!("Failed to set/get poll interval: {e}"))?;

    Ok(json)
}

/// Get VFS queue info
#[command]
pub async fn vfs_queue(app: AppHandle, fs: Option<String>) -> Result<Value, String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let mut payload = json!({});
    if let Some(f) = fs {
        payload["fs"] = Value::String(f);
    }

    let state = app.state::<RcloneState>();
    let json = backend
        .post_json(&state.client, vfs::QUEUE, Some(&payload))
        .await
        .map_err(|e| format!("Failed to fetch VFS queue: {e}"))?;

    debug!("✅ VFS Queue: {json}");

    Ok(json)
}

/// Set the expiry time for an item queued for upload
#[command]
pub async fn vfs_queue_set_expiry(
    app: AppHandle,
    fs: Option<String>,
    id: u64,
    expiry: f64,
    relative: bool,
) -> Result<Value, String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let mut payload = json!({
        "id": id,
        "expiry": expiry,
        "relative": relative
    });
    if let Some(f) = fs {
        payload["fs"] = Value::String(f);
    }

    let state = app.state::<RcloneState>();
    let json = backend
        .post_json(&state.client, vfs::QUEUE_SET_EXPIRY, Some(&payload))
        .await
        .map_err(|e| format!("Failed to set queue expiry: {e}"))?;

    Ok(json)
}
