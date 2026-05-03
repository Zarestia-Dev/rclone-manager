use log::debug;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, command};

use crate::rclone::backend::BackendManager;
use crate::utils::rclone::endpoints::vfs;
use crate::utils::types::core::RcloneState;

use crate::utils::json_helpers::normalize_windows_path;

#[command]
pub async fn vfs_list(app: AppHandle) -> Result<Value, String> {
    let backend = app.state::<BackendManager>().get_active().await;
    let json = backend
        .post_json(&app.state::<RcloneState>().client, vfs::LIST, None)
        .await
        .map_err(|e| format!("Failed to fetch VFS list: {e}"))?;
    debug!("✅ VFS List: {json}");
    Ok(json)
}

#[command]
pub async fn vfs_forget(
    app: AppHandle,
    fs: Option<String>,
    file: Option<String>,
) -> Result<Value, String> {
    let backend = app.state::<BackendManager>().get_active().await;
    let mut payload = json!({});
    if let Some(f) = fs {
        payload["fs"] = Value::String(f);
    }
    if let Some(f) = file {
        payload["file"] = Value::String(f);
    }
    backend
        .post_json(
            &app.state::<RcloneState>().client,
            vfs::FORGET,
            Some(&payload),
        )
        .await
        .map_err(|e| format!("Failed to forget paths: {e}"))
}

#[command]
pub async fn vfs_refresh(
    app: AppHandle,
    fs: Option<String>,
    dir: Option<String>,
    recursive: bool,
) -> Result<Value, String> {
    let backend = app.state::<BackendManager>().get_active().await;
    let mut payload = json!({ "recursive": recursive });
    if let Some(f) = fs {
        payload["fs"] = Value::String(f);
    }
    if let Some(d) = dir {
        payload["dir"] = Value::String(d);
    }
    backend
        .post_json(
            &app.state::<RcloneState>().client,
            vfs::REFRESH,
            Some(&payload),
        )
        .await
        .map_err(|e| format!("Failed to refresh cache: {e}"))
}

#[command]
pub async fn vfs_stats(app: AppHandle, fs: Option<String>) -> Result<Value, String> {
    let backend = app.state::<BackendManager>().get_active().await;
    let mut payload = json!({});
    if let Some(f) = fs {
        payload["fs"] = Value::String(f);
    }

    #[allow(unused_mut)]
    let mut json = backend
        .post_json(
            &app.state::<RcloneState>().client,
            vfs::STATS,
            Some(&payload),
        )
        .await
        .map_err(|e| format!("Failed to fetch VFS stats: {e}"))?;

    if let Some(disk_cache) = json.get_mut("diskCache").and_then(|v| v.as_object_mut()) {
        for key in ["path", "pathMeta"] {
            if let Some(raw) = disk_cache.get(key).and_then(|v| v.as_str()) {
                let normalized = normalize_windows_path(raw);
                disk_cache.insert(key.to_string(), Value::String(normalized));
            }
        }
    }

    Ok(json)
}

#[command]
pub async fn vfs_poll_interval(
    app: AppHandle,
    fs: Option<String>,
    interval: Option<String>,
    timeout: Option<String>,
) -> Result<Value, String> {
    let backend = app.state::<BackendManager>().get_active().await;
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
    backend
        .post_json(
            &app.state::<RcloneState>().client,
            vfs::POLL_INTERVAL,
            Some(&payload),
        )
        .await
        .map_err(|e| format!("Failed to set/get poll interval: {e}"))
}

#[command]
pub async fn vfs_queue(app: AppHandle, fs: Option<String>) -> Result<Value, String> {
    let backend = app.state::<BackendManager>().get_active().await;
    let mut payload = json!({});
    if let Some(f) = fs {
        payload["fs"] = Value::String(f);
    }
    let json = backend
        .post_json(
            &app.state::<RcloneState>().client,
            vfs::QUEUE,
            Some(&payload),
        )
        .await
        .map_err(|e| format!("Failed to fetch VFS queue: {e}"))?;
    debug!("✅ VFS Queue: {json}");
    Ok(json)
}

#[command]
pub async fn vfs_queue_set_expiry(
    app: AppHandle,
    fs: Option<String>,
    id: u64,
    expiry: f64,
    relative: bool,
) -> Result<Value, String> {
    let backend = app.state::<BackendManager>().get_active().await;
    let mut payload = json!({ "id": id, "expiry": expiry, "relative": relative });
    if let Some(f) = fs {
        payload["fs"] = Value::String(f);
    }
    backend
        .post_json(
            &app.state::<RcloneState>().client,
            vfs::QUEUE_SET_EXPIRY,
            Some(&payload),
        )
        .await
        .map_err(|e| format!("Failed to set queue expiry: {e}"))
}
