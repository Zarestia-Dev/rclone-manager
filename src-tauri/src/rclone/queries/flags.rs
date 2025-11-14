use serde_json::{Map, Value, json};
use std::error::Error;
use tauri::{State, command};
use tokio::try_join;

use crate::{
    RcloneState,
    rclone::state::engine::ENGINE_STATE,
    utils::rclone::endpoints::{EndpointHelper, options},
};

// --- PRIVATE HELPERS ---
// These functions perform the raw API calls and are the foundation.

async fn fetch_all_options_info(
    state: State<'_, RcloneState>,
) -> Result<Value, Box<dyn Error + Send + Sync>> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, options::INFO);
    let response = state.client.post(&url).json(&json!({})).send().await?;
    if response.status().is_success() {
        Ok(response.json().await?)
    } else {
        Err(format!("Failed to fetch options info: {:?}", response.text().await?).into())
    }
}

async fn fetch_current_options(
    state: State<'_, RcloneState>,
) -> Result<Value, Box<dyn Error + Send + Sync>> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, options::INFO);
    let response = state.client.post(&url).json(&json!({})).send().await?;
    if response.status().is_success() {
        Ok(response.json().await?)
    } else {
        Err(format!(
            "Failed to fetch current options: {:?}",
            response.text().await?
        )
        .into())
    }
}

async fn fetch_option_blocks(
    state: State<'_, RcloneState>,
) -> Result<Value, Box<dyn Error + Send + Sync>> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, options::INFO);
    let response = state.client.post(&url).json(&json!({})).send().await?;
    if response.status().is_success() {
        Ok(response.json().await?)
    } else {
        Err(format!(
            "Failed to fetch option blocks: {:?}",
            response.text().await?
        )
        .into())
    }
}

// --- DATA TRANSFORMATION LOGIC ---
fn merge_options(options_info: &mut Value, current_options: &Value) {
    if let Some(info_map) = options_info.as_object_mut() {
        for (block_name, options_array) in info_map {
            if let Some(options) = options_array.as_array_mut() {
                for option in options {
                    if let Some(field_name) = option.get("FieldName").and_then(|v| v.as_str()) {
                        let parts: Vec<&str> = field_name.split('.').collect();
                        let mut current_val_node = &current_options[block_name];
                        for part in &parts {
                            if current_val_node.is_null() {
                                break;
                            }
                            current_val_node = &current_val_node[part];
                        }
                        if !current_val_node.is_null()
                            && let Some(option_obj) = option.as_object_mut()
                        {
                            option_obj.insert("Value".to_string(), current_val_node.clone());
                            let value_str = match current_val_node {
                                Value::String(s) => s.clone(),
                                Value::Array(a) => a
                                    .iter()
                                    .filter_map(|v| v.as_str())
                                    .collect::<Vec<&str>>()
                                    .join(", "),
                                Value::Bool(b) => b.to_string(),
                                Value::Number(n) => n.to_string(),
                                _ => String::new(),
                            };
                            option_obj.insert("ValueStr".to_string(), Value::String(value_str));
                        }
                    }
                }
            }
        }
    }
}

/// Transforms a flat list of options into a nested object grouped by prefixes (e.g., "HTTP", "Auth").
fn group_options(merged_info: &Value) -> Value {
    let mut final_grouped_data = Value::Object(Map::new());

    if let Some(info_map) = merged_info.as_object() {
        for (block_name, options_array) in info_map {
            let mut block_groups = Map::new();

            if let Some(options) = options_array.as_array() {
                for option in options {
                    let mut new_option = option.clone();

                    let field_name = new_option
                        .get("FieldName")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");

                    // Special handling for blocks like "rc" that have nested structures
                    let (group_name, simplified_field_name) =
                        if let Some((group, field)) = field_name.split_once('.') {
                            (group.to_string(), field.to_string())
                        } else {
                            // For fields without dots, use "General" group
                            ("General".to_string(), field_name.to_string())
                        };

                    // Update the FieldName to be simplified (without the group prefix)
                    if let Some(obj) = new_option.as_object_mut() {
                        obj.insert(
                            "FieldName".to_string(),
                            Value::String(simplified_field_name),
                        );
                    }

                    // Add to the appropriate group within this block
                    block_groups
                        .entry(group_name)
                        .or_insert_with(|| Value::Array(vec![]))
                        .as_array_mut()
                        .unwrap()
                        .push(new_option);
                }
            }

            // Insert the grouped options for this block
            final_grouped_data
                .as_object_mut()
                .unwrap()
                .insert(block_name.clone(), Value::Object(block_groups));
        }
    }
    final_grouped_data
}

// --- MASTER DATA COMMANDS ---
#[command]
pub async fn get_all_options_with_values(state: State<'_, RcloneState>) -> Result<Value, String> {
    let (mut options_info, current_options) = try_join!(
        fetch_all_options_info(state.clone()),
        fetch_current_options(state)
    )
    .map_err(|e| e.to_string())?;

    merge_options(&mut options_info, &current_options);
    Ok(options_info)
}

#[command]
pub async fn get_grouped_options_with_values(
    state: State<'_, RcloneState>,
) -> Result<Value, String> {
    let merged_flat_data = get_all_options_with_values(state).await?;
    let grouped_data = group_options(&merged_flat_data);
    Ok(grouped_data)
}

// --- GENERAL & FLAG-SPECIFIC COMMANDS ---
#[command]
pub async fn get_option_blocks(state: State<'_, RcloneState>) -> Result<Value, String> {
    fetch_option_blocks(state).await.map_err(|e| e.to_string())
}

fn get_flags_by_category_internal(
    merged_json: &Value,
    category: &str,
    filter_groups: Option<Vec<String>>,
    exclude_flags: Option<Vec<String>>,
) -> Vec<Value> {
    let empty_vec = vec![];
    let category_flags = merged_json[category].as_array().unwrap_or(&empty_vec);

    category_flags
        .iter()
        .filter(|flag| {
            if let Some(ref excludes) = exclude_flags
                && let Some(name) = flag["Name"].as_str()
                && excludes.contains(&name.to_string())
            {
                return false;
            }

            if let Some(ref groups_filter) = filter_groups {
                if let Some(groups) = flag["Groups"].as_str() {
                    return groups_filter.iter().any(|g| groups.contains(g));
                }
                return false;
            }
            true
        })
        .cloned()
        .collect()
}

#[command]
pub async fn get_flags_by_category(
    state: State<'_, RcloneState>,
    category: String,
    filter_groups: Option<Vec<String>>,
    exclude_flags: Option<Vec<String>>,
) -> Result<Vec<Value>, String> {
    let merged_json = get_all_options_with_values(state).await?;
    Ok(get_flags_by_category_internal(
        &merged_json,
        &category,
        filter_groups,
        exclude_flags,
    ))
}

#[command]
pub async fn get_copy_flags(state: State<'_, RcloneState>) -> Result<Vec<Value>, String> {
    let merged_json = get_all_options_with_values(state).await?;
    Ok(get_flags_by_category_internal(
        &merged_json,
        "main",
        Some(vec!["Copy".to_string(), "Performance".to_string()]),
        None,
    ))
}

#[command]
pub async fn get_sync_flags(state: State<'_, RcloneState>) -> Result<Vec<Value>, String> {
    let merged_json = get_all_options_with_values(state).await?;
    Ok(get_flags_by_category_internal(
        &merged_json,
        "main",
        Some(vec![
            "Copy".to_string(),
            "Sync".to_string(),
            "Performance".to_string(),
        ]),
        None,
    ))
}

#[command]
pub async fn get_filter_flags(state: State<'_, RcloneState>) -> Result<Vec<Value>, String> {
    let merged_json = get_all_options_with_values(state).await?;
    let filter_flags = get_flags_by_category_internal(&merged_json, "filter", None, None);

    let filtered: Vec<Value> = filter_flags
        .into_iter()
        .filter(|flag| {
            !flag["Groups"]
                .as_str()
                .map(|g| g.contains("Metadata"))
                .unwrap_or(false)
        })
        .map(|mut flag| {
            if let Some(field_name) = flag["FieldName"].as_str()
                && let Some(last_part) = field_name.split('.').next_back()
            {
                flag["FieldName"] = Value::String(last_part.to_string());
            }
            flag
        })
        .collect();
    Ok(filtered)
}

#[command]
pub async fn get_backend_flags(state: State<'_, RcloneState>) -> Result<Vec<Value>, String> {
    let merged_json = get_all_options_with_values(state).await?;
    let main_flags = get_flags_by_category_internal(&merged_json, "main", None, None);

    let mut backend_flags: Vec<Value> = main_flags
        .into_iter()
        .filter(|flag| {
            let name = flag["Name"].as_str().unwrap_or("");
            if name == "use_server_modtime" {
                return true;
            }
            if let Some(groups) = flag["Groups"].as_str() {
                return ["Performance", "Listing", "Networking", "Check"]
                    .iter()
                    .any(|g| groups.contains(g));
            }
            false
        })
        .collect();

    backend_flags.sort_by(|a, b| {
        a["Name"]
            .as_str()
            .unwrap_or("")
            .cmp(b["Name"].as_str().unwrap_or(""))
    });
    Ok(backend_flags)
}

#[command]
pub async fn get_vfs_flags(state: State<'_, RcloneState>) -> Result<Vec<Value>, String> {
    let merged_json = get_all_options_with_values(state).await?;
    Ok(get_flags_by_category_internal(
        &merged_json,
        "vfs",
        None,
        Some(vec!["NONE".to_string()]),
    ))
}

#[command]
pub async fn get_mount_flags(state: State<'_, RcloneState>) -> Result<Vec<Value>, String> {
    let merged_json = get_all_options_with_values(state).await?;
    Ok(get_flags_by_category_internal(
        &merged_json,
        "mount",
        None,
        Some(vec![
            "debug_fuse".to_string(),
            "daemon".to_string(),
            "daemon_timeout".to_string(),
        ]),
    ))
}

// --- DATA MUTATION COMMAND ---

/// Saves a single RClone option value by building a nested JSON payload.
#[command]
pub async fn set_rclone_option(
    state: State<'_, RcloneState>,
    block_name: String,
    option_name: String,
    value: Value,
) -> Result<Value, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, options::INFO);
    let parts: Vec<&str> = option_name.split('.').collect();
    let nested_value = parts
        .iter()
        .rev()
        .fold(value, |acc, &part| json!({ part: acc }));
    let payload = json!({ block_name.clone(): nested_value });

    let response = state
        .client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;

    if response.status().is_success() {
        Ok(response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?)
    } else {
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        Err(format!(
            "Failed to set option '{}' in block '{}': {}",
            option_name, block_name, error_text
        ))
    }
}
