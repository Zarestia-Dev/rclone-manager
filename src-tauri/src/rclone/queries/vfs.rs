use log::debug;
use serde_json::{Value, json};
use tauri::AppHandle;

use crate::utils::json_helpers::normalize_windows_path;
use crate::utils::rclone::endpoints::vfs;

#[tauri::command]
pub async fn vfs_list(app: AppHandle) -> Result<Value, String> {
    let json = crate::rclone::commands::common::transport(&app)
        .rpc(vfs::LIST, None)
        .await
        .map_err(|e| format!("Failed to fetch VFS list: {e}"))?;
    debug!("✅ VFS List: {json}");
    Ok(json)
}

#[tauri::command]
pub async fn vfs_forget(
    app: AppHandle,
    fs: Option<String>,
    file: Option<String>,
) -> Result<Value, String> {
    let mut payload = json!({});
    if let Some(f) = fs {
        payload["fs"] = Value::String(f);
    }
    if let Some(f) = file {
        payload["file"] = Value::String(f);
    }
    crate::rclone::commands::common::transport(&app)
        .rpc(vfs::FORGET, Some(&payload))
        .await
        .map_err(|e| format!("Failed to forget paths: {e}"))
}

#[tauri::command]
pub async fn vfs_refresh(
    app: AppHandle,
    fs: Option<String>,
    dir: Option<String>,
    recursive: bool,
) -> Result<Value, String> {
    let mut payload = json!({ "recursive": recursive });
    if let Some(f) = fs {
        payload["fs"] = Value::String(f);
    }
    if let Some(d) = dir {
        payload["dir"] = Value::String(d);
    }
    crate::rclone::commands::common::transport(&app)
        .rpc(vfs::REFRESH, Some(&payload))
        .await
        .map_err(|e| format!("Failed to refresh cache: {e}"))
}

#[tauri::command]
pub async fn vfs_stats(app: AppHandle, fs: Option<String>) -> Result<Value, String> {
    let mut payload = json!({});
    if let Some(f) = fs {
        payload["fs"] = Value::String(f);
    }

    let mut json = crate::rclone::commands::common::transport(&app)
        .rpc(vfs::STATS, Some(&payload))
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

#[tauri::command]
pub async fn vfs_poll_interval(
    app: AppHandle,
    fs: Option<String>,
    interval: Option<String>,
    timeout: Option<String>,
) -> Result<Value, String> {
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
    crate::rclone::commands::common::transport(&app)
        .rpc(vfs::POLL_INTERVAL, Some(&payload))
        .await
        .map_err(|e| format!("Failed to set/get poll interval: {e}"))
}

#[tauri::command]
pub async fn vfs_queue(app: AppHandle, fs: Option<String>) -> Result<Value, String> {
    let mut payload = json!({});
    if let Some(f) = fs {
        payload["fs"] = Value::String(f);
    }
    let json = crate::rclone::commands::common::transport(&app)
        .rpc(vfs::QUEUE, Some(&payload))
        .await
        .map_err(|e| format!("Failed to fetch VFS queue: {e}"))?;
    debug!("✅ VFS Queue: {json}");
    Ok(json)
}

#[tauri::command]
pub async fn vfs_queue_set_expiry(
    app: AppHandle,
    fs: Option<String>,
    id: u64,
    expiry: f64,
    relative: bool,
) -> Result<Value, String> {
    let mut payload = json!({ "id": id, "expiry": expiry, "relative": relative });
    if let Some(f) = fs {
        payload["fs"] = Value::String(f);
    }
    crate::rclone::commands::common::transport(&app)
        .rpc(vfs::QUEUE_SET_EXPIRY, Some(&payload))
        .await
        .map_err(|e| format!("Failed to set queue expiry: {e}"))
}
