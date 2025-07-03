use serde_json::{json, Value};
use std::error::Error;
use tauri::{command, State};

use crate::{
    rclone::state::ENGINE_STATE,
    utils::rclone::endpoints::EndpointHelper,
    RcloneState,
};

async fn fetch_rclone_options(
    endpoint: &str,
    state: State<'_, RcloneState>,
) -> Result<Value, Box<dyn Error>> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, &format!("options/{}", endpoint));

    let response = state
        .client
        .post(&url)
        .json(&json!({})) // Empty JSON body
        .send()
        .await?;

    if response.status().is_success() {
        let json: Value = response.json().await?;
        Ok(json)
    } else {
        Err(format!("Failed to fetch data: {:?}", response.text().await?).into())
    }
}

/// Fetch all global flags
#[command]
pub async fn get_global_flags(state: State<'_, RcloneState>) -> Result<Value, String> {
    fetch_rclone_options("get", state)
        .await
        .map_err(|e| e.to_string())
}

/// Fetch copy flags
#[command]
pub async fn get_copy_flags(state: State<'_, RcloneState>) -> Result<Vec<Value>, String> {
    let json = fetch_rclone_options("info", state)
        .await
        .map_err(|e| e.to_string())?;
    let empty_vec = Vec::new();
    let main_flags = json["main"].as_array().unwrap_or(&empty_vec);

    let copy_flags: Vec<Value> = main_flags
        .iter()
        .filter(|flag| {
            if let Some(groups) = flag["Groups"].as_str() {
                groups.contains("Copy") || groups.contains("Performance")
            } else {
                false
            }
        })
        .cloned()
        .collect();

    Ok(copy_flags)
}

/// Fetch sync flags
#[command]
pub async fn get_sync_flags(state: State<'_, RcloneState>) -> Result<Vec<Value>, String> {
    let json = fetch_rclone_options("info", state)
        .await
        .map_err(|e| e.to_string())?;
    let empty_vec = Vec::new();
    let main_flags = json["main"].as_array().unwrap_or(&empty_vec);

    let sync_flags: Vec<Value> = main_flags
        .iter()
        .filter(|flag| {
            if let Some(groups) = flag["Groups"].as_str() {
                groups.contains("Copy") || groups.contains("Sync") || groups.contains("Performance")
            } else {
                false
            }
        })
        .cloned()
        .collect();

    Ok(sync_flags)
}

/// Fetch filter flags (excluding metadata)
#[command]
pub async fn get_filter_flags(state: State<'_, RcloneState>) -> Result<Vec<Value>, String> {
    let json = fetch_rclone_options("info", state)
        .await
        .map_err(|e| e.to_string())?;

    let filter_flags = json["filter"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter(|flag| {
            !flag["Groups"]
                .as_str() // Note: Changed from as_array() to as_str()
                .map(|groups| groups.contains("Metadata"))
                .unwrap_or(false)
        })
        .cloned()
        .collect();

    Ok(filter_flags)
}

/// Fetch VFS flags (excluding ignored flags)
#[command]
pub async fn get_vfs_flags(state: State<'_, RcloneState>) -> Result<Vec<Value>, String> {
    let json = fetch_rclone_options("info", state)
        .await
        .map_err(|e| e.to_string())?;
    let empty_vec = vec![];
    let vfs_flags = json["vfs"].as_array().unwrap_or(&empty_vec);

    let ignored_flags = vec!["NONE"];
    let filtered_flags: Vec<Value> = vfs_flags
        .iter()
        .filter(|flag| {
            let name = flag["Name"].as_str().unwrap_or("");
            !ignored_flags.contains(&name)
        })
        .cloned()
        .collect();

    Ok(filtered_flags)
}

/// Fetch mount flags (excluding specific ignored flags)
#[command]
pub async fn get_mount_flags(state: State<'_, RcloneState>) -> Result<Vec<Value>, String> {
    let json = fetch_rclone_options("info", state)
        .await
        .map_err(|e| e.to_string())?;
    let empty_vec = vec![];
    let mount_flags = json["mount"].as_array().unwrap_or(&empty_vec);

    let ignored_flags = vec!["debug_fuse", "daemon", "daemon_timeout"];
    let filtered_flags: Vec<Value> = mount_flags
        .iter()
        .filter(|flag| {
            let name = flag["Name"].as_str().unwrap_or("");
            !ignored_flags.contains(&name)
        })
        .cloned()
        .collect();

    Ok(filtered_flags)
}
