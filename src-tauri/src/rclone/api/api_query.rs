use log::{debug, error, info};
use serde_json::{Value, json};
use std::{collections::HashMap, process::Child, sync::Arc};
use tauri::State;
use tauri::command;

use crate::RcloneState;
use crate::rclone::api::state::ENGINE_STATE;
use crate::utils::types::{
    BandwidthLimitResponse, DiskUsage, ListOptions, MountedRemote, RcloneCoreVersion,
};

lazy_static::lazy_static! {
    static ref OAUTH_PROCESS: Arc<tokio::sync::Mutex<Option<Child>>> = Arc::new(tokio::sync::Mutex::new(None));
}

#[command]
pub async fn get_all_remote_configs(
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/config/dump", ENGINE_STATE.get_api().0);

    let response = state
        .client
        .post(url)
        .send()
        .await
        .map_err(|e| format!("❌ Failed to fetch remote configs: {}", e))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("❌ Failed to parse response: {}", e))?;

    Ok(json)
}

#[command]
pub async fn get_remotes(state: State<'_, RcloneState>) -> Result<Vec<String>, String> {
    let url = format!("{}/config/listremotes", ENGINE_STATE.get_api().0);
    debug!("📡 Fetching remotes from: {}", url);

    let response = state.client.post(url).send().await.map_err(|e| {
        error!("❌ Failed to fetch remotes: {}", e);
        format!("❌ Failed to fetch remotes: {}", e)
    })?;

    let json: Value = response.json().await.map_err(|e| {
        error!("❌ Failed to parse remotes response: {}", e);
        format!("❌ Failed to parse response: {}", e)
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

#[command]
pub async fn get_fs_info(
    state: State<'_, RcloneState>,
    remote_name: String,
) -> Result<Value, String> {
    let url = format!("{}/operations/fsinfo", ENGINE_STATE.get_api().0);

    let payload = json!({
        "fs": format!("{}:", remote_name)
    });

    let response = state
        .client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("❌ Failed to fetch fs info: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!(
            "❌ Rclone fsinfo returned error {}: {}",
            status, text
        ));
    }

    let json: Value = response
        .json()
        .await
        .map_err(|e| format!("❌ Failed to parse fsinfo response: {}", e))?;

    Ok(json)
}

/// Fetch remote config fields dynamically
#[command]
pub async fn get_remote_config_fields(
    remote_type: String,
    state: State<'_, RcloneState>,
) -> Result<Vec<Value>, String> {
    let url = format!("{}/config/providers", ENGINE_STATE.get_api().0);

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("❌ Failed to fetch remote config fields: {}", e))?;

    let json: Value = response
        .json()
        .await
        .map_err(|e| format!("❌ Failed to parse response: {}", e))?;

    if let Some(providers) = json.get("providers").and_then(|p| p.as_array()) {
        let fields = providers
            .iter()
            .find(|provider| provider.get("Name") == Some(&Value::String(remote_type.clone())))
            .and_then(|provider| provider.get("Options").cloned());

        match fields {
            Some(fields) => Ok(fields.as_array().cloned().unwrap_or_else(Vec::new)),
            _none => Err("❌ Remote type not found".to_string()),
        }
    } else {
        Err("❌ Invalid response format".to_string())
    }
}

#[command]
pub async fn get_remote_config(
    remote_name: String,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    let url = format!(
        "{}/config/get?name={}",
        ENGINE_STATE.get_api().0,
        remote_name
    );

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("❌ Failed to fetch remote config: {}", e))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("❌ Failed to parse response: {}", e))?;

    Ok(json)
}

#[tauri::command]
pub async fn get_mounted_remotes(
    state: State<'_, RcloneState>,
) -> Result<Vec<MountedRemote>, String> {
    let url = format!("{}/mount/listmounts", ENGINE_STATE.get_api().0);

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("❌ Failed to send request: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "❌ Failed to fetch mounted remotes: {:?}",
            response.text().await
        ));
    }

    let json: Value = response
        .json()
        .await
        .map_err(|e| format!("❌ Failed to parse response: {}", e))?;

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

#[command]
pub async fn get_disk_usage(
    remote_name: String,
    state: State<'_, RcloneState>,
) -> Result<DiskUsage, String> {
    let url = format!("{}/operations/about", ENGINE_STATE.get_api().0);

    let client = state.client.clone();

    // First phase: 3 tries with 3s timeout
    let mut attempts = 3;
    let mut response = None;
    let mut last_err = None;

    while attempts > 0 {
        let request = client
            .post(&url)
            .json(&json!({ "fs": format!("{}:", remote_name) }))
            .timeout(std::time::Duration::from_secs(3));
        match request.try_clone().unwrap().send().await {
            Ok(res) => {
                response = Some(res);
                break;
            }
            Err(e) => {
                last_err = Some(e.to_string());
                attempts -= 1;
                if attempts > 0 {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
            }
        }
    }

    // If still no response, wait 5s and try 3 more times with 5s timeout
    if response.is_none() {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        let mut attempts2 = 3;
        while attempts2 > 0 {
            let request = client
                .post(&url)
                .json(&json!({ "fs": format!("{}:", remote_name) }))
                .timeout(std::time::Duration::from_secs(5));
            match request.try_clone().unwrap().send().await {
                Ok(res) => {
                    response = Some(res);
                    break;
                }
                Err(e) => {
                    last_err = Some(e.to_string());
                    attempts2 -= 1;
                    if attempts2 > 0 {
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    }
                }
            }
        }
    }

    let response = match response {
        Some(res) => res,
        None => {
            return Err(format!(
                "❌ Failed to send request after retries: {}",
                last_err.unwrap_or_else(|| "Unknown error".to_string())
            ));
        }
    };

    if !response.status().is_success() {
        let error_msg = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        return Err(format!("❌ Failed to fetch disk usage: {}", error_msg));
    }

    let json_response: Value = match response.json().await {
        Ok(json) => json,
        Err(e) => return Err(format!("❌ Failed to parse response: {}", e)),
    };

    // Extract values safely
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

/// ✅ Fetch remote providers (cached for reuse)
async fn fetch_remote_providers(
    state: &State<'_, RcloneState>,
) -> Result<HashMap<String, Vec<Value>>, String> {
    let url = format!("{}/config/providers", ENGINE_STATE.get_api().0);

    let response = state
        .client
        .post(url)
        .send()
        .await
        .map_err(|e| format!("❌ Failed to send request: {}", e))?;

    let body = response
        .text()
        .await
        .map_err(|e| format!("❌ Failed to read response: {}", e))?;
    let providers: HashMap<String, Vec<Value>> =
        serde_json::from_str(&body).map_err(|e| format!("❌ Failed to parse response: {}", e))?;

    Ok(providers)
}

/// ✅ Fetch all remote types
#[tauri::command]
pub async fn get_remote_types(
    state: State<'_, RcloneState>,
) -> Result<HashMap<String, Vec<Value>>, String> {
    fetch_remote_providers(&state).await
}

/// ✅ Fetch only OAuth-supported remotes
#[command]
pub async fn get_oauth_supported_remotes(
    state: State<'_, RcloneState>,
) -> Result<HashMap<String, Vec<Value>>, String> {
    let providers = fetch_remote_providers(&state).await?;

    // Extract all OAuth-supported remotes with their full information
    let mut oauth_remotes = HashMap::new();

    for (provider_type, remotes) in providers {
        let supported_remotes: Vec<Value> = remotes
            .into_iter()
            .filter(|remote| {
                remote
                    .get("Options")
                    .and_then(|options| options.as_array())
                    .map_or(false, |opts| {
                        opts.iter().any(|opt| {
                            opt.get("Name").and_then(|n| n.as_str()) == Some("token")
                                && opt.get("Help").and_then(|h| h.as_str()).map_or(false, |h| {
                                    h.contains("OAuth Access Token as a JSON blob")
                                })
                        })
                    })
            })
            .collect();

        if !supported_remotes.is_empty() {
            oauth_remotes.insert(provider_type, supported_remotes);
        }
    }

    Ok(oauth_remotes)
}

#[tauri::command]
pub async fn get_remote_paths(
    remote: String,
    path: Option<String>,
    options: Option<ListOptions>,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/operations/list", ENGINE_STATE.get_api().0);
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

    if let Some(opts) = options {
        for (key, value) in opts.extra {
            params.insert(key, value);
        }
    }

    let response = state
        .client
        .post(&url)
        .json(&params)
        .send()
        .await
        .map_err(|e| format!("❌ Failed to list path: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!(
            "❌ Rclone list returned error {}: {}",
            status, text
        ));
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("❌ Failed to parse list response: {}", e))?;

    Ok(json["list"].clone())
}

/// Get current bandwidth limit settings
#[tauri::command]
pub async fn get_bandwidth_limit(
    state: State<'_, RcloneState>,
) -> Result<BandwidthLimitResponse, String> {
    let url = format!("{}/core/bwlimit", ENGINE_STATE.get_api().0);

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = format!("HTTP {}: {}", status, body);
        return Err(error);
    }

    let response_data: BandwidthLimitResponse =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse response: {}", e))?;

    Ok(response_data)
}

#[tauri::command]
pub async fn get_rclone_info(state: State<'_, RcloneState>) -> Result<RcloneCoreVersion, String> {
    let url = format!("{}/core/version", ENGINE_STATE.get_api().0);

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to get Rclone version: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, body));
    }

    serde_json::from_str(&body).map_err(|e| format!("Failed to parse version info: {}", e))
}

#[tauri::command]
pub async fn get_rclone_pid(state: State<'_, RcloneState>) -> Result<Option<u32>, String> {
    let url = format!("{}/core/pid", ENGINE_STATE.get_api().0);
    match state.client.post(&url).send().await {
        Ok(resp) => {
            debug!("📡 Querying rclone /core/pid: {}", url);
            debug!("rclone /core/pid response status: {}", resp.status());
            if resp.status().is_success() {
                match resp.json::<serde_json::Value>().await {
                    Ok(json) => Ok(json.get("pid").and_then(|v| v.as_u64()).map(|v| v as u32)),
                    Err(e) => {
                        debug!("Failed to parse /core/pid response: {}", e);
                        Err(format!("Failed to parse /core/pid response: {}", e))
                    }
                }
            } else {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                debug!("rclone /core/pid returned non-success status");
                Err(format!(
                    "rclone /core/pid returned non-success status: {}: {}",
                    status, body
                ))
            }
        }
        Err(e) => {
            debug!("Failed to query /core/pid: {}", e);
            Err(format!("Failed to query /core/pid: {}", e))
        }
    }
}

/// Get RClone memory statistics
#[tauri::command]
pub async fn get_memory_stats(state: State<'_, RcloneState>) -> Result<serde_json::Value, String> {
    let url = format!("{}/core/memstats", ENGINE_STATE.get_api().0);

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to get memory stats: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, body));
    }

    serde_json::from_str(&body).map_err(|e| format!("Failed to parse memory stats: {}", e))
}

/// Get RClone core statistics  
#[tauri::command]
pub async fn get_core_stats(state: State<'_, RcloneState>) -> Result<serde_json::Value, String> {
    let url = format!("{}/core/stats", ENGINE_STATE.get_api().0);

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to get core stats: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, body));
    }

    serde_json::from_str(&body).map_err(|e| format!("Failed to parse core stats: {}", e))
}

/// Get RClone core statistics filtered by group/job
#[tauri::command]
pub async fn get_core_stats_filtered(
    state: State<'_, RcloneState>,
    // remote_name: Option<String>,
    jobid: Option<u64>,
    group: Option<String>,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/core/stats", ENGINE_STATE.get_api().0);
    
    let mut payload = json!({});
    
    if let Some(group) = group {
        payload["group"] = json!(group);
        debug!("📊 Getting core stats for group: {}", group);
    } else if let Some(jobid) = jobid {
        let group_name = format!("job/{}", jobid);
        payload["group"] = json!(group_name);
        debug!("📊 Getting core stats for job: {}", jobid);
    } else {
        debug!("📊 Getting global core stats");
    }

    debug!("📡 Requesting core stats from: {} with payload: {}", url, payload);

    let response = state
        .client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            error!("❌ Failed to get filtered core stats: {}", e);
            format!("Failed to get filtered core stats: {}", e)
        })?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        error!("❌ HTTP error getting core stats: {} - {}", status, body);
        return Err(format!("HTTP {}: {}", status, body));
    }

    debug!("✅ Core stats response: {}", body);
    serde_json::from_str(&body).map_err(|e| {
        error!("❌ Failed to parse filtered core stats: {}", e);
        format!("Failed to parse filtered core stats: {}", e)
    })
}

/// Get completed transfers using core/transferred API
#[tauri::command]
pub async fn get_completed_transfers(
    state: State<'_, RcloneState>,
    group: Option<String>,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/core/transferred", ENGINE_STATE.get_api().0);
    
    let mut payload = json!({});
    if let Some(group) = group {
        payload["group"] = json!(group);
        debug!("📋 Getting completed transfers for group: {}", group);
    } else {
        debug!("📋 Getting all completed transfers");
    }

    debug!("📡 Requesting completed transfers from: {} with payload: {}", url, payload);

    let response = state
        .client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            error!("❌ Failed to get completed transfers: {}", e);
            format!("Failed to get completed transfers: {}", e)
        })?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        error!("❌ HTTP error getting completed transfers: {} - {}", status, body);
        return Err(format!("HTTP {}: {}", status, body));
    }

    debug!("✅ Completed transfers response: {}", body);
    serde_json::from_str(&body).map_err(|e| {
        error!("❌ Failed to parse completed transfers: {}", e);
        format!("Failed to parse completed transfers: {}", e)
    })
}

/// Get job stats with optional group filtering
#[tauri::command]
pub async fn get_job_stats(
    state: State<'_, RcloneState>,
    jobid: u64,
    group: Option<String>,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/core/stats", ENGINE_STATE.get_api().0);
    
    let mut payload = json!({ "jobid": jobid });
    if let Some(group) = group {
        payload["group"] = json!(group);
    }

    let response = state
        .client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to get job stats: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, body));
    }

    serde_json::from_str(&body).map_err(|e| format!("Failed to parse job stats: {}", e))
}
