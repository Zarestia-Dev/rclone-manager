use serde_json::{Map, Value, json};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use tauri::{AppHandle, Manager};
use tokio::sync::RwLock;
use tokio::try_join;

use crate::{
    rclone::backend::BackendManager,
    utils::{rclone::endpoints::options, types::core::RcloneState},
};

const OPTIONS_CACHE_TTL: Duration = Duration::from_secs(300);

#[derive(Clone)]
struct OptionsCacheEntry {
    backend_name: String,
    cached_at: Instant,
    payload: Value,
}

static OPTIONS_CACHE: Lazy<RwLock<Option<OptionsCacheEntry>>> = Lazy::new(|| RwLock::new(None));

// --- PRIVATE HELPERS ---

async fn fetch_options(
    client: &reqwest::Client,
    backend_manager: &BackendManager,
    endpoint: &str,
) -> Result<Value, String> {
    let backend = backend_manager.get_active().await;
    backend
        .post_json(client, endpoint, Some(&json!({})))
        .await
        .map_err(|e| format!("Failed to fetch options ({endpoint}): {e}"))
}

// --- DATA TRANSFORMATION LOGIC ---

fn merge_options(options_info: &mut Value, current_options: &Value) {
    let Some(info_map) = options_info.as_object_mut() else {
        return;
    };

    for (block_name, options_array) in info_map {
        let Some(options) = options_array.as_array_mut() else {
            continue;
        };

        for option in options {
            let Some(field_name) = option.get("FieldName").and_then(|v| v.as_str()) else {
                continue;
            };

            let mut current_val_node = &current_options[block_name];
            for part in field_name.split('.') {
                if current_val_node.is_null() {
                    break;
                }
                current_val_node = &current_val_node[part];
            }

            if !current_val_node.is_null()
                && let Some(obj) = option.as_object_mut()
            {
                obj.insert("Value".to_string(), current_val_node.clone());
                let value_str = match current_val_node {
                    Value::String(s) => s.clone(),
                    Value::Array(a) => a
                        .iter()
                        .filter_map(|v| v.as_str())
                        .collect::<Vec<_>>()
                        .join(", "),
                    Value::Bool(b) => b.to_string(),
                    Value::Number(n) => n.to_string(),
                    _ => String::new(),
                };
                obj.insert("ValueStr".to_string(), Value::String(value_str));
            }
        }
    }
}

/// Groups a flat options list into a nested object keyed by prefix (e.g. "HTTP", "Auth").
fn group_options(merged_info: &Value) -> Value {
    let mut result = Map::new();

    let Some(info_map) = merged_info.as_object() else {
        return Value::Object(result);
    };

    for (block_name, options_array) in info_map {
        let Some(options) = options_array.as_array() else {
            continue;
        };

        let mut block_groups: Map<String, Value> = Map::new();

        for option in options {
            let mut new_option = option.clone();

            let field_name = new_option
                .get("FieldName")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            let (group_name, simplified_field) = field_name.split_once('.').map_or_else(
                || ("General".to_string(), field_name.to_string()),
                |(g, f)| (g.to_string(), f.to_string()),
            );

            if let Some(obj) = new_option.as_object_mut() {
                obj.insert("FieldName".to_string(), Value::String(simplified_field));
            }

            block_groups
                .entry(group_name)
                .or_insert_with(|| Value::Array(vec![]))
                .as_array_mut()
                .unwrap()
                .push(new_option);
        }

        result.insert(block_name.clone(), Value::Object(block_groups));
    }
    Value::Object(result)
}

/// Strip the last dot-segment of a flag's FieldName (mutates in place).
fn simplify_field_names(flags: Vec<Value>) -> Vec<Value> {
    flags
        .into_iter()
        .map(|mut flag| {
            if let Some(field_name) = flag["FieldName"].as_str()
                && let Some(last) = field_name.split('.').next_back()
            {
                flag["FieldName"] = Value::String(last.to_string());
            }
            flag
        })
        .collect()
}

// --- MASTER DATA COMMANDS ---

pub async fn get_all_options_with_values(app: AppHandle) -> Result<Value, String> {
    let backend_manager = app.state::<BackendManager>();
    let state = app.state::<RcloneState>();
    let active_name = backend_manager.get_active().await.name.clone();

    {
        let cache = OPTIONS_CACHE.read().await;
        if let Some(entry) = cache.as_ref()
            && entry.backend_name == active_name
            && entry.cached_at.elapsed() < OPTIONS_CACHE_TTL
        {
            return Ok(entry.payload.clone());
        }
    }

    let (mut options_info, current_options) = try_join!(
        fetch_options(&state.client, &backend_manager, options::INFO),
        fetch_options(&state.client, &backend_manager, options::GET),
    )?;

    merge_options(&mut options_info, &current_options);

    *OPTIONS_CACHE.write().await = Some(OptionsCacheEntry {
        backend_name: active_name,
        cached_at: Instant::now(),
        payload: options_info.clone(),
    });

    Ok(options_info)
}

#[tauri::command]
pub async fn get_grouped_options_with_values(app: AppHandle) -> Result<Value, String> {
    get_all_options_with_values(app)
        .await
        .map(|data| group_options(&data))
}

#[tauri::command]
pub async fn get_option_blocks(app: AppHandle) -> Result<Value, String> {
    let backend_manager = app.state::<BackendManager>();
    fetch_options(
        &app.state::<RcloneState>().client,
        &backend_manager,
        options::BLOCKS,
    )
    .await
}

fn get_flags_by_category_internal(
    merged_json: &Value,
    category: &str,
    filter_groups: Option<&[&str]>,
    exclude_flags: Option<&[&str]>,
) -> Vec<Value> {
    let empty = vec![];
    merged_json[category]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter(|flag| {
            if let Some(excludes) = exclude_flags
                && let Some(name) = flag["Name"].as_str()
                && excludes.contains(&name)
            {
                return false;
            }
            if let Some(groups_filter) = filter_groups {
                return flag["Groups"]
                    .as_str()
                    .is_some_and(|g| groups_filter.iter().any(|f| g.contains(f)));
            }
            true
        })
        .cloned()
        .collect()
}

#[tauri::command]
pub async fn get_flags_by_category(
    app: AppHandle,
    category: String,
    filter_groups: Option<Vec<String>>,
    exclude_flags: Option<Vec<String>>,
) -> Result<Vec<Value>, String> {
    let merged_json = get_all_options_with_values(app).await?;
    let fg: Option<Vec<&str>> = filter_groups
        .as_ref()
        .map(|v| v.iter().map(|s| s.as_str()).collect());
    let ef: Option<Vec<&str>> = exclude_flags
        .as_ref()
        .map(|v| v.iter().map(|s| s.as_str()).collect());
    Ok(get_flags_by_category_internal(
        &merged_json,
        &category,
        fg.as_deref(),
        ef.as_deref(),
    ))
}

#[tauri::command]
pub async fn get_copy_flags(app: AppHandle) -> Result<Vec<Value>, String> {
    let merged_json = get_all_options_with_values(app).await?;
    Ok(get_flags_by_category_internal(
        &merged_json,
        "main",
        Some(&["Copy", "Performance"]),
        None,
    ))
}

// get_move_flags has the same groups as get_copy_flags — delegates to it via shared impl
#[tauri::command]
pub async fn get_move_flags(app: AppHandle) -> Result<Vec<Value>, String> {
    get_copy_flags(app).await
}

#[tauri::command]
pub async fn get_sync_flags(app: AppHandle) -> Result<Vec<Value>, String> {
    let merged_json = get_all_options_with_values(app).await?;
    Ok(get_flags_by_category_internal(
        &merged_json,
        "main",
        Some(&["Copy", "Sync", "Performance"]),
        None,
    ))
}

#[tauri::command]
pub async fn get_bisync_flags(app: AppHandle) -> Result<Vec<Value>, String> {
    get_sync_flags(app).await
}

#[tauri::command]
pub async fn get_filter_flags(app: AppHandle) -> Result<Vec<Value>, String> {
    let merged_json = get_all_options_with_values(app).await?;
    let flags = get_flags_by_category_internal(&merged_json, "filter", None, None);
    let filtered = flags
        .into_iter()
        .filter(|flag| {
            !flag["Groups"]
                .as_str()
                .is_some_and(|g| g.contains("Metadata"))
        })
        .collect();
    Ok(simplify_field_names(filtered))
}

#[tauri::command]
pub async fn get_backend_flags(app: AppHandle) -> Result<Vec<Value>, String> {
    let merged_json = get_all_options_with_values(app).await?;
    let mut flags: Vec<Value> = get_flags_by_category_internal(&merged_json, "main", None, None)
        .into_iter()
        .filter(|flag| {
            let Some(groups) = flag["Groups"].as_str() else {
                return false;
            };
            if ["Filter", "Mount", "VFS", "RC", "WebDAV"]
                .iter()
                .any(|g| groups.contains(g))
            {
                return false;
            }
            [
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
            .any(|g| groups.contains(g))
        })
        .collect();

    flags.sort_by_key(|f| f["Name"].as_str().unwrap_or("").to_string());
    Ok(flags)
}

#[tauri::command]
pub async fn get_vfs_flags(app: AppHandle) -> Result<Vec<Value>, String> {
    let merged_json = get_all_options_with_values(app).await?;
    Ok(get_flags_by_category_internal(
        &merged_json,
        "vfs",
        None,
        Some(&["NONE"]),
    ))
}

#[tauri::command]
pub async fn get_mount_flags(app: AppHandle) -> Result<Vec<Value>, String> {
    let merged_json = get_all_options_with_values(app).await?;
    Ok(get_flags_by_category_internal(
        &merged_json,
        "mount",
        None,
        Some(&["debug_fuse", "daemon", "daemon_timeout"]),
    ))
}

/// Get flags for a specific serve type (defaults to "http").
#[tauri::command]
pub async fn get_serve_flags(
    app: AppHandle,
    serve_type: Option<String>,
) -> Result<Vec<Value>, String> {
    let serve_type = serve_type.as_deref().unwrap_or("http");
    let merged_json = get_all_options_with_values(app).await?;
    let flags = get_flags_by_category_internal(&merged_json, serve_type, None, None);
    Ok(simplify_field_names(flags))
}

// --- DATA MUTATION COMMANDS ---

/// Set a single rclone option, building a nested payload from a dotted name.
#[tauri::command]
pub async fn set_rclone_option(
    app: AppHandle,
    block_name: String,
    option_name: String,
    value: Value,
) -> Result<Value, String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    let nested_value = option_name
        .split('.')
        .rev()
        .fold(value, |acc, part| json!({ part: acc }));
    let payload = json!({ block_name.clone(): nested_value });

    backend
        .post_json(
            &app.state::<RcloneState>().client,
            options::SET,
            Some(&payload),
        )
        .await
        .map_err(|e| format!("Failed to set option '{option_name}' in block '{block_name}': {e}"))
}

/// Set multiple rclone options at once.
/// Expected payload: `{ "main": { "LogLevel": "DEBUG" }, "vfs": { "CacheMode": "full" } }`
#[tauri::command]
pub async fn set_rclone_options_bulk(app: AppHandle, payload: Value) -> Result<Value, String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    backend
        .post_json(
            &app.state::<RcloneState>().client,
            options::SET,
            Some(&payload),
        )
        .await
        .map_err(|e| format!("Failed to set bulk options: {e}"))
}
