use log::debug;
use serde_json::{Value, json};
use tauri::{State, command};

use crate::rclone::state::engine::ENGINE_STATE;
use crate::utils::rclone::endpoints::{EndpointHelper, vfs};
use crate::utils::types::all_types::RcloneState;

/// List active VFSes.
#[command]
pub async fn vfs_list(state: State<'_, RcloneState>) -> Result<Value, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, vfs::LIST);
    debug!("🔍 Fetching VFS list from {url}");

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to fetch VFS list: {:?}",
            response.text().await
        ));
    }

    let json: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))?;

    debug!("✅ VFS List: {json}");
    Ok(json)
}

/// Forget files or directories in the directory cache.
#[command]
pub async fn vfs_forget(
    state: State<'_, RcloneState>,
    fs: Option<String>,
    file: Option<String>,
) -> Result<Value, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, vfs::FORGET);
    debug!("🗑️ Forgetting paths in VFS cache via {url}");

    let mut payload = json!({});

    if let Some(f) = fs {
        payload["fs"] = Value::String(f);
    }
    if let Some(f) = file {
        payload["file"] = Value::String(f);
    }

    let response = state
        .client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to forget paths: {:?}",
            response.text().await
        ));
    }

    let json: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))?;

    Ok(json)
}

/// Refresh the directory cache.
#[command]
pub async fn vfs_refresh(
    state: State<'_, RcloneState>,
    fs: Option<String>,
    dir: Option<String>,
    recursive: bool,
) -> Result<Value, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, vfs::REFRESH);
    debug!("🔄 Refreshing VFS cache via {url}");

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

    let response = state
        .client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to refresh cache: {:?}",
            response.text().await
        ));
    }

    let json: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))?;

    Ok(json)
}

/// Get stats for a VFS.
#[command]
pub async fn vfs_stats(state: State<'_, RcloneState>, fs: Option<String>) -> Result<Value, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, vfs::STATS);
    debug!("📊 Fetching VFS stats via {url}");

    let mut payload = json!({});
    if let Some(f) = fs {
        payload["fs"] = Value::String(f);
    }

    let response = state
        .client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to fetch VFS stats: {:?}",
            response.text().await
        ));
    }

    let json: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))?;

    Ok(json)
}

/// Get or update the value of the poll-interval option.
#[command]
pub async fn vfs_poll_interval(
    state: State<'_, RcloneState>,
    fs: Option<String>,
    interval: Option<String>,
    timeout: Option<String>,
) -> Result<Value, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, vfs::POLL_INTERVAL);
    debug!("⏱️ VFS poll interval via {url}");

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

    let response = state
        .client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to set/get poll interval: {:?}",
            response.text().await
        ));
    }

    let json: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))?;

    Ok(json)
}

/// Get VFS queue info
#[command]
pub async fn vfs_queue(state: State<'_, RcloneState>, fs: Option<String>) -> Result<Value, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, vfs::QUEUE);
    debug!("📥 Fetching VFS queue via {url}");

    let mut payload = json!({});
    if let Some(f) = fs {
        payload["fs"] = Value::String(f);
    }

    let response = state
        .client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to fetch VFS queue: {:?}",
            response.text().await
        ));
    }

    let json: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))?;

    debug!("✅ VFS Queue: {json}");

    Ok(json)
}

/// Set the expiry time for an item queued for upload
#[command]
pub async fn vfs_queue_set_expiry(
    state: State<'_, RcloneState>,
    fs: Option<String>,
    id: u64,
    expiry: f64,
    relative: bool,
) -> Result<Value, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, vfs::QUEUE_SET_EXPIRY);
    debug!("⏱️ Setting VFS queue expiry via {url}");

    let mut payload = json!({
        "id": id,
        "expiry": expiry,
        "relative": relative
    });
    if let Some(f) = fs {
        payload["fs"] = Value::String(f);
    }

    let response = state
        .client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to set queue expiry: {:?}",
            response.text().await
        ));
    }

    let json: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))?;

    Ok(json)
}
