use log::debug;
use serde_json::Value;
use std::collections::HashMap;
use tauri::{State, command};

use crate::RcloneState;
use crate::rclone::state::ENGINE_STATE;
use crate::utils::rclone::endpoints::{EndpointHelper, config};

#[command]
pub async fn get_all_remote_configs(
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, config::DUMP);

    let response = state
        .client
        .post(url)
        .send()
        .await
        .map_err(|e| format!("❌ Failed to fetch remote configs: {e}"))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("❌ Failed to parse response: {e}"))?;

    Ok(json)
}

#[command]
pub async fn get_remotes(state: State<'_, RcloneState>) -> Result<Vec<String>, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, config::LISTREMOTES);
    debug!("📡 Fetching remotes from: {url}");

    let response = state.client.post(url).send().await.map_err(|e| {
        log::error!("❌ Failed to fetch remotes: {e}");
        format!("❌ Failed to fetch remotes: {e}")
    })?;

    let json: Value = response.json().await.map_err(|e| {
        log::error!("❌ Failed to parse remotes response: {e}");
        format!("❌ Failed to parse response: {e}")
    })?;

    let remotes: Vec<String> = json["remotes"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|r| r.as_str())
        .map(|s| s.to_string())
        .collect();

    debug!("📡 Found {} remotes: {:?}", remotes.len(), remotes);
    Ok(remotes)
}

#[tauri::command]
pub async fn get_remote_config_fields(
    remote_type: String,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, config::GET);

    let response = state
        .client
        .post(&url)
        .query(&[("name", &remote_type)])
        .send()
        .await
        .map_err(|e| format!("❌ Failed to fetch remote config fields: {e}"))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("❌ Failed to parse response: {e}"))?;

    Ok(json)
}

#[tauri::command]
pub async fn get_remote_config(
    remote_name: String,
    state: State<'_, RcloneState>,
) -> Result<serde_json::Value, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, config::GET);

    let response = state
        .client
        .post(&url)
        .query(&[("name", &remote_name)])
        .send()
        .await
        .map_err(|e| format!("❌ Failed to fetch remote config: {e}"))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("❌ Failed to parse response: {e}"))?;

    Ok(json)
}

/// ✅ Fetch remote providers (cached for reuse)
async fn fetch_remote_providers(
    state: &State<'_, RcloneState>,
) -> Result<HashMap<String, Vec<Value>>, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, config::PROVIDERS);

    let response = state
        .client
        .post(url)
        .send()
        .await
        .map_err(|e| format!("❌ Failed to send request: {e}"))?;

    let body = response
        .text()
        .await
        .map_err(|e| format!("❌ Failed to read response: {e}"))?;
    let providers: HashMap<String, Vec<Value>> =
        serde_json::from_str(&body).map_err(|e| format!("❌ Failed to parse response: {e}"))?;

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
                    .is_some_and(|opts| {
                        opts.iter().any(|opt| {
                            opt.get("Name").and_then(|n| n.as_str()) == Some("token")
                                && opt.get("Help").and_then(|h| h.as_str()).is_some_and(|h| {
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
