use log::{debug, error, info};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    process::Child,
    sync::Arc,
};
use tauri::State;
use tauri::command;

use crate::RcloneState;

use super::state::RCLONE_STATE;


lazy_static::lazy_static! {
    static ref OAUTH_PROCESS: Arc<tokio::sync::Mutex<Option<Child>>> = Arc::new(tokio::sync::Mutex::new(None));
}

#[command]
pub async fn get_all_remote_configs(
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/config/dump", RCLONE_STATE.get_api().0);

    let response = state
        .client
        .post(url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch remote configs: {}", e))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    Ok(json)
}


#[command]
pub async fn get_remotes(state: State<'_, RcloneState>) -> Result<Vec<String>, String> {
    let url = format!("{}/config/listremotes", RCLONE_STATE.get_api().0);
    debug!("📡 Fetching remotes from: {}", url);

    let response = state.client.post(url).send().await.map_err(|e| {
        error!("❌ Failed to fetch remotes: {}", e);
        format!("Failed to fetch remotes: {}", e)
    })?;

    let json: Value = response.json().await.map_err(|e| {
        error!("❌ Failed to parse remotes response: {}", e);
        format!("Failed to parse response: {}", e)
    })?;

    let remotes: Vec<String> = json["remotes"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .map(|v| v.as_str().unwrap_or("").to_string())
        .collect();

    info!("✅ Successfully fetched {} remotes", remotes.len());
    debug!("📂 Remote List: {:?}", remotes);

    Ok(remotes)
}

/// Fetch remote config fields dynamically
#[command]
pub async fn get_remote_config_fields(
    remote_type: String,
    state: State<'_, RcloneState>,
) -> Result<Vec<Value>, String> {
    let url = format!("{}/config/providers", RCLONE_STATE.get_api().0);

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch remote config fields: {}", e))?;

    let json: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if let Some(providers) = json.get("providers").and_then(|p| p.as_array()) {
        let fields = providers
            .iter()
            .find(|provider| provider.get("Name") == Some(&Value::String(remote_type.clone())))
            .and_then(|provider| provider.get("Options").cloned());

        match fields {
            Some(fields) => Ok(fields.as_array().cloned().unwrap_or_else(Vec::new)),
            None => Err("Remote type not found".to_string()),
        }
    } else {
        Err("Invalid response format".to_string())
    }
}

#[command]
pub async fn get_remote_config(
    remote_name: String,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    let url = format!(
        "{}/config/get?name={}",
        RCLONE_STATE.get_api().0,
        remote_name
    );

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch remote config: {}", e))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    Ok(json)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MountedRemote {
    pub fs: String,
    pub mount_point: String,
}

#[tauri::command]
pub async fn get_mounted_remotes(
    state: State<'_, RcloneState>,
) -> Result<Vec<MountedRemote>, String> {
    let url = format!("{}/mount/listmounts", RCLONE_STATE.get_api().0);

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to fetch mounted remotes: {:?}",
            response.text().await
        ));
    }

    let json: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let mounts = json["mountPoints"]
        .as_array()
        .unwrap_or(&vec![]) // Default to an empty list if not found
        .iter()
        .filter_map(|mp| {
            Some(MountedRemote {
                fs: mp["Fs"].as_str()?.to_string(),
                mount_point: mp["MountPoint"].as_str()?.to_string(),
            })
        })
        .collect();

    debug!("📂 Mounted Remotes: {:?}", mounts);

    Ok(mounts)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DiskUsage {
    free: String,
    used: String,
    total: String,
}
#[command]
pub async fn get_disk_usage(
    remote_name: String,
    state: State<'_, RcloneState>,
) -> Result<DiskUsage, String> {
    let url = format!("{}/operations/about", RCLONE_STATE.get_api().0);

    let response = state
        .client
        .post(&url)
        .json(&json!({ "fs": format!("{}:", remote_name) }))
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;

    if !response.status().is_success() {
        let error_msg = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        return Err(format!("Failed to fetch disk usage: {}", error_msg));
    }

    let json_response: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let free = json_response["free"].as_u64().unwrap_or(0);
    let used = json_response["used"].as_u64().unwrap_or(0);
    let total = json_response["total"].as_u64().unwrap_or(0);

    Ok(DiskUsage {
        free: format_size(free),
        used: format_size(used),
        total: format_size(total),
    })
}

/// 📌 **Improved Formatting Function**
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

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct RemoteExample {
    pub value: String,
    pub help: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct RemoteOption {
    pub name: String,
    pub help: String,
    pub required: bool,
    pub value: Option<String>,
    pub r#type: Option<String>,

    #[serde(default)] // If missing, use default empty vector
    pub examples: Vec<RemoteExample>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct RemoteProvider {
    pub name: String,
    pub description: String,
    pub prefix: String,
    pub options: Vec<RemoteOption>,
}

/// ✅ Fetch remote providers (cached for reuse)
async fn fetch_remote_providers(
    state: &State<'_, RcloneState>,
) -> Result<HashMap<String, Vec<RemoteProvider>>, String> {
    let url = format!("{}/config/providers", RCLONE_STATE.get_api().0);

    let response = state
        .client
        .post(url)
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;

    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;
    let providers: HashMap<String, Vec<RemoteProvider>> =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse response: {}", e))?;

    Ok(providers)
}

/// ✅ Fetch all remote types
#[tauri::command]
pub async fn get_remote_types(
    state: State<'_, RcloneState>,
) -> Result<HashMap<String, Vec<RemoteProvider>>, String> {
    fetch_remote_providers(&state).await
}

/// ✅ Fetch only OAuth-supported remotes
#[tauri::command]
pub async fn get_oauth_supported_remotes(
    state: State<'_, RcloneState>,
) -> Result<Vec<String>, String> {
    let providers = fetch_remote_providers(&state).await?;

    // ✅ Extract OAuth-supported remotes
    let oauth_remotes: Vec<String> = providers
        .into_values()
        .flatten()
        .filter(|remote| {
            remote.options.iter().any(|opt| {
                opt.name == "token" && opt.help.contains("OAuth Access Token as a JSON blob.")
            })
        })
        .map(|remote| remote.name.clone()) // Clone the name string
        .collect();

    Ok(oauth_remotes)
}
