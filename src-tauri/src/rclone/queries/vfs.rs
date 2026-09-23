use log::debug;
use serde_json::{Value, json};
use tauri::AppHandle;

use crate::core::bridge;
use crate::utils::json_helpers::normalize_windows_path;
use crate::utils::rclone::endpoints::vfs;

#[bridge]
pub async fn vfs_list(app: AppHandle) -> Result<Value, String> {
    let json = crate::rclone::commands::common::transport(&app)
        .rpc(vfs::LIST, None)
        .await
        .map_err(|e| format!("Failed to fetch VFS list: {e}"))?;
    debug!("✅ VFS List: {json}");
    Ok(json)
}

#[bridge]
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

pub(crate) fn build_vfs_refresh_payload(
    fs: Option<String>,
    dir: Option<String>,
    recursive: bool,
) -> Value {
    let mut payload = json!({ "recursive": recursive.to_string() });
    if let Some(f) = fs.filter(|s| !s.trim().is_empty()) {
        payload["fs"] = Value::String(f);
    }
    if let Some(d) = dir.filter(|s| !s.trim().is_empty()) {
        payload["dir"] = Value::String(d);
    }
    payload
}

#[bridge]
pub async fn vfs_refresh(
    app: AppHandle,
    fs: Option<String>,
    dir: Option<String>,
    recursive: bool,
) -> Result<Value, String> {
    let payload = build_vfs_refresh_payload(fs, dir, recursive);
    crate::rclone::commands::common::transport(&app)
        .rpc(vfs::REFRESH, Some(&payload))
        .await
        .map_err(|e| format!("Failed to refresh cache: {e}"))
}

#[bridge]
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
                disk_cache.insert(key.to_string(), Value::String(normalized.to_string()));
            }
        }
    }

    Ok(json)
}

#[bridge]
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

#[bridge]
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

#[bridge]
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_vfs_refresh_payload_string_recursive_and_empty_filtering() {
        let p1 = build_vfs_refresh_payload(Some("Dropbox:".into()), None, true);
        assert_eq!(p1["recursive"], "true");
        assert_eq!(p1["fs"], "Dropbox:");
        assert!(p1.get("dir").is_none());

        let p2 = build_vfs_refresh_payload(Some("Dropbox:".into()), Some("".into()), false);
        assert_eq!(p2["recursive"], "false");
        assert_eq!(p2["fs"], "Dropbox:");
        assert!(p2.get("dir").is_none());

        let p3 = build_vfs_refresh_payload(None, Some("photos/2026".into()), true);
        assert_eq!(p3["recursive"], "true");
        assert_eq!(p3["dir"], "photos/2026");
        assert!(p3.get("fs").is_none());
    }
}
