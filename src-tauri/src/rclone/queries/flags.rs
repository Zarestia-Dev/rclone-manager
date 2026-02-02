use serde_json::{Map, Value, json};
use std::error::Error;
use tauri::command;
use tokio::try_join;

use crate::{
    rclone::backend::BackendManager,
    utils::{rclone::endpoints::options, types::core::RcloneState},
};
use tauri::AppHandle;
use tauri::Manager;

// --- PRIVATE HELPERS ---
// These functions perform the raw API calls and are the foundation.

async fn fetch_all_options_info(
    client: &reqwest::Client,
    backend_manager: &BackendManager,
) -> Result<Value, Box<dyn Error + Send + Sync>> {
    let backend = backend_manager.get_active().await;
    let json = backend
        .post_json(client, options::INFO, Some(&json!({})))
        .await
        .map_err(|e| format!("Failed to fetch options info: {e}"))?;
    Ok(json)
}

async fn fetch_current_options(
    client: &reqwest::Client,
    backend_manager: &BackendManager,
) -> Result<Value, Box<dyn Error + Send + Sync>> {
    let backend = backend_manager.get_active().await;
    let json = backend
        .post_json(client, options::GET, Some(&json!({})))
        .await
        .map_err(|e| format!("Failed to fetch current options: {e}"))?;
    Ok(json)
}

async fn fetch_option_blocks(
    client: &reqwest::Client,
    backend_manager: &BackendManager,
) -> Result<Value, Box<dyn Error + Send + Sync>> {
    let backend = backend_manager.get_active().await;
    let json = backend
        .post_json(client, options::BLOCKS, Some(&json!({})))
        .await
        .map_err(|e| format!("Failed to fetch option blocks: {e}"))?;
    Ok(json)
}

// --- DATA TRANSFORMATION LOGIC ---
fn merge_options(options_info: &mut Value, current_options: &Value) {
    let info_map = match options_info.as_object_mut() {
        Some(map) => map,
        None => return,
    };

    for (block_name, options_array) in info_map {
        let options = match options_array.as_array_mut() {
            Some(opts) => opts,
            None => continue,
        };

        for option in options {
            let field_name = match option.get("FieldName").and_then(|v| v.as_str()) {
                Some(name) => name,
                None => continue,
            };

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

/// Transforms a flat list of options into a nested object grouped by prefixes (e.g., "HTTP", "Auth").
fn group_options(merged_info: &Value) -> Value {
    let mut final_grouped_data = Map::new();

    let info_map = match merged_info.as_object() {
        Some(map) => map,
        None => return Value::Object(final_grouped_data),
    };

    for (block_name, options_array) in info_map {
        let options = match options_array.as_array() {
            Some(opts) => opts,
            None => continue,
        };

        let mut block_groups = Map::new();

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

        // Insert the grouped options for this block
        final_grouped_data.insert(block_name.clone(), Value::Object(block_groups));
    }
    Value::Object(final_grouped_data)
}

// --- MASTER DATA COMMANDS ---

#[command]
pub async fn get_all_options_with_values(app: AppHandle) -> Result<Value, String> {
    let backend_manager = app.state::<BackendManager>();
    let state = app.state::<RcloneState>();
    let (mut options_info, current_options) = try_join!(
        fetch_all_options_info(&state.client, &backend_manager),
        fetch_current_options(&state.client, &backend_manager)
    )
    .map_err(|e| e.to_string())?;

    merge_options(&mut options_info, &current_options);
    Ok(options_info)
}

#[command]
pub async fn get_grouped_options_with_values(app: AppHandle) -> Result<Value, String> {
    let merged_flat_data = get_all_options_with_values(app).await?;
    let grouped_data = group_options(&merged_flat_data);
    Ok(grouped_data)
}

// --- GENERAL & FLAG-SPECIFIC COMMANDS ---
#[command]
pub async fn get_option_blocks(app: AppHandle) -> Result<Value, String> {
    let backend_manager = app.state::<BackendManager>();
    fetch_option_blocks(&app.state::<RcloneState>().client, &backend_manager)
        .await
        .map_err(|e| e.to_string())
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
    app: AppHandle,
    category: String,
    filter_groups: Option<Vec<String>>,
    exclude_flags: Option<Vec<String>>,
) -> Result<Vec<Value>, String> {
    let merged_json = get_all_options_with_values(app).await?;
    Ok(get_flags_by_category_internal(
        &merged_json,
        &category,
        filter_groups,
        exclude_flags,
    ))
}

#[command]
pub async fn get_copy_flags(app: AppHandle) -> Result<Vec<Value>, String> {
    let merged_json = get_all_options_with_values(app).await?;
    Ok(get_flags_by_category_internal(
        &merged_json,
        "main",
        Some(vec!["Copy".to_string(), "Performance".to_string()]),
        None,
    ))
}

#[command]
pub async fn get_sync_flags(app: AppHandle) -> Result<Vec<Value>, String> {
    let merged_json = get_all_options_with_values(app).await?;
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
pub async fn get_filter_flags(app: AppHandle) -> Result<Vec<Value>, String> {
    let merged_json = get_all_options_with_values(app).await?;
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
pub async fn get_backend_flags(app: AppHandle) -> Result<Vec<Value>, String> {
    let merged_json = get_all_options_with_values(app).await?;
    let main_flags = get_flags_by_category_internal(&merged_json, "main", None, None);

    let mut backend_flags: Vec<Value> = main_flags
        .into_iter()
        .filter(|flag| {
            if let Some(groups) = flag["Groups"].as_str() {
                // Exclude groups handled by specific queries
                if ["Filter", "Mount", "VFS", "RC", "WebDAV"]
                    .iter()
                    .any(|g| groups.contains(g))
                {
                    return false;
                }

                return [
                    "Performance",
                    "Listing",
                    "Networking",
                    "Check",
                    "Config",
                    "Sync",
                    "Copy",
                    "Logging",
                    "Debugging",
                    "Metadata",
                    "Important",
                ]
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
pub async fn get_vfs_flags(app: AppHandle) -> Result<Vec<Value>, String> {
    let merged_json = get_all_options_with_values(app).await?;
    Ok(get_flags_by_category_internal(
        &merged_json,
        "vfs",
        None,
        Some(vec!["NONE".to_string()]),
    ))
}

#[command]
pub async fn get_mount_flags(app: AppHandle) -> Result<Vec<Value>, String> {
    let merged_json = get_all_options_with_values(app).await?;
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

#[command]
pub async fn get_move_flags(app: AppHandle) -> Result<Vec<Value>, String> {
    let merged_json = get_all_options_with_values(app).await?;
    // Move largely shares the same main groups as copy; expose Copy + Performance flags
    Ok(get_flags_by_category_internal(
        &merged_json,
        "main",
        Some(vec!["Copy".to_string(), "Performance".to_string()]),
        None,
    ))
}

#[command]
pub async fn get_bisync_flags(app: AppHandle) -> Result<Vec<Value>, String> {
    let merged_json = get_all_options_with_values(app).await?;
    // Bisync needs a mix of Sync and Copy related flags; include Performance as well
    Ok(get_flags_by_category_internal(
        &merged_json,
        "main",
        Some(vec![
            "Sync".to_string(),
            "Copy".to_string(),
            "Performance".to_string(),
        ]),
        None,
    ))
}

/// Get flags/options for a specific serve type
/// If no serve_type is provided, defaults to "http"
#[command]
pub async fn get_serve_flags(
    app: AppHandle,
    serve_type: Option<String>,
) -> Result<Vec<Value>, String> {
    let serve_type = serve_type.unwrap_or_else(|| "http".to_string());
    let merged_json = get_all_options_with_values(app).await?;
    let flags = get_flags_by_category_internal(&merged_json, &serve_type, None, None);

    // Simplify FieldName to only the part after the last dot
    let modified_flags: Vec<Value> = flags
        .into_iter()
        .map(|mut flag| {
            if let Some(field_name) = flag["FieldName"].as_str()
                && let Some(last_part) = field_name.split('.').next_back()
            {
                flag["FieldName"] = Value::String(last_part.to_string());
            }
            flag
        })
        .collect();

    Ok(modified_flags)
}

// --- DATA MUTATION COMMAND ---

/// Saves a single RClone option value by building a nested JSON payload.
#[command]
pub async fn set_rclone_option(
    app: AppHandle,
    block_name: String,
    option_name: String,
    value: Value,
) -> Result<Value, String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let parts: Vec<&str> = option_name.split('.').collect();
    let nested_value = parts
        .iter()
        .rev()
        .fold(value, |acc, &part| json!({ part: acc }));
    let payload = json!({ block_name.clone(): nested_value });

    let json = backend
        .post_json(
            &app.state::<RcloneState>().client,
            options::SET,
            Some(&payload),
        )
        .await
        .map_err(|e| {
            format!(
                "Failed to set option '{}' in block '{}': {}",
                option_name, block_name, e
            )
        })?;

    Ok(json)
}
