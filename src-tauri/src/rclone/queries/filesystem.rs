use log::debug;
use serde_json::json;
use tauri::State;

use crate::rclone::state::ENGINE_STATE;
use crate::utils::{
    rclone::endpoints::{operations, EndpointHelper},
    types::{DiskUsage, ListOptions},
};
use crate::RcloneState;

#[tauri::command]
pub async fn get_fs_info(
    remote: String,
    path: Option<String>,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, operations::FSINFO);

    let fs_name = if remote.ends_with(':') {
        remote
    } else {
        format!("{}:", remote)
    };

    let fs_path = match path {
        Some(p) if !p.is_empty() => format!("{}{}", fs_name, p),
        _ => fs_name,
    };

    let params = json!({ "fs": fs_path });

    let response = state
        .client
        .post(&url)
        .json(&params)
        .send()
        .await
        .map_err(|e| format!("❌ Failed to get fs info: {}", e))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("❌ Failed to parse response: {}", e))?;

    Ok(json)
}

#[tauri::command]
pub async fn get_remote_paths(
    remote: String,
    path: Option<String>,
    options: Option<ListOptions>,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, operations::LIST);
    debug!(
        "📂 Listing remote paths: remote={}, path={:?}, options={:?}",
        remote, path, options
    );
    let mut params = serde_json::Map::new();
    // Ensure remote name ends with colon for proper rclone format
    let fs_name = if remote.ends_with(':') {
        remote
    } else {
        format!("{}:", remote)
    };
    params.insert("fs".to_string(), serde_json::Value::String(fs_name));
    params.insert(
        "remote".to_string(),
        serde_json::Value::String(path.unwrap_or_default()),
    );

    // Apply additional options if provided
    if let Some(list_options) = options {
        for (key, value) in list_options.extra {
            params.insert(key, value);
        }
    }

    let response = state
        .client
        .post(&url)
        .json(&serde_json::Value::Object(params))
        .send()
        .await
        .map_err(|e| format!("❌ Failed to list remote paths: {}", e))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("❌ Failed to parse response: {}", e))?;

    Ok(json)
}

#[tauri::command]
pub async fn get_disk_usage(
    remote: String,
    path: Option<String>,
    state: State<'_, RcloneState>,
) -> Result<DiskUsage, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, operations::ABOUT);

    let fs_name = if remote.ends_with(':') {
        remote
    } else {
        format!("{}:", remote)
    };

    let fs_path = match path {
        Some(p) if !p.is_empty() => format!("{}{}", fs_name, p),
        _ => fs_name,
    };

    let params = json!({ "fs": fs_path });

    let response = state
        .client
        .post(&url)
        .json(&params)
        .send()
        .await
        .map_err(|e| format!("❌ Failed to get disk usage: {}", e))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("❌ Failed to parse response: {}", e))?;

    // Extract usage information
    let total = json["total"].as_u64();
    let used = json["used"].as_u64();
    let free = json["free"].as_u64();

    let disk_usage = DiskUsage {
        total: total.map(|t| format_size(t)).unwrap_or_default(),
        used: used.map(|u| format_size(u)).unwrap_or_default(),
        free: free.map(|f| format_size(f)).unwrap_or_default(),
    };

    debug!("💾 Disk Usage for {}: {:?}", fs_path, disk_usage);
    Ok(disk_usage)
}

fn format_size(bytes: u64) -> String {
    let sizes = ["B", "KB", "MB", "GB", "TB"];
    let mut size = bytes as f64;
    let mut i = 0;

    while size >= 1024.0 && i < sizes.len() - 1 {
        size /= 1024.0;
        i += 1;
    }

    format!("{:.2} {}", size, sizes[i])
}
