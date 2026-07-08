use serde_json::{Map, Value, json};
use std::sync::Arc;

use tauri::{AppHandle, Manager};
use tokio::try_join;

use crate::{
    rclone::backend::{BackendManager, RcloneTransport},
    utils::rclone::endpoints::options,
};

// ---------------------------------------------------------------------------
// GROUP TAXONOMY
//
// rclone assigns each flag in `options/info` a `Groups` field like
// "Copy,Check" or "Networking". These constants define the canonical sets
// for each profile so there is a single source of truth.
//
// Source of truth: https://rclone.org/flags/
//
// KEY DESIGN RULE — every flag belongs to exactly one UI panel:
//
//   COPY panel    → Groups that rclone docs list under "Copy Options"
//   SYNC panel    → COPY + Groups that rclone docs list under "Sync Options"
//   FILTER panel  → "Filter" group from the `filter` block + main "Filter" group
//   BACKEND panel → everything else that is global / daemon-level
//
// The `Performance` group (checkers, transfers, buffer_size) is intentionally
// kept OUT of COPY/SYNC. Those flags are global daemon settings — they appear
// under the "Performance" section on the global flags page, NOT under the per-
// command "Copy Options" or "Sync Options" sections. Including them in both
// panels was the original source of duplication.
// ---------------------------------------------------------------------------

/// Groups that belong to the global backend / daemon settings panel.
///
/// Includes `Performance` (checkers, transfers, `buffer_size`) because those
/// are global concurrency knobs, not per-operation flags.
/// Includes `Important` (`dry_run`, interactive) so they appear as global
/// defaults even though they also show up on operation panels via `Config`.
const BACKEND_INCLUDE: &[&str] = &[
    "Performance", // checkers, transfers, buffer_size
    "Networking",  // bwlimit, timeout, tpslimit, contimeout, …
    "Config",      // retries, ask_password, human_readable, …
    "Logging",     // log_level, stats_*, progress, …
    "Debugging",   // dump
    "Listing",     // fast_list, default_time
    "Important",   // dry_run, interactive (global defaults)
    "Metadata",    // metadata_mapper
];

/// Groups that are hard-excluded from the backend panel regardless of
/// `BACKEND_INCLUDE`. Prevents operation-specific flags from leaking in.
const BACKEND_EXCLUDE: &[&str] = &["Copy", "Sync", "Filter", "Mount", "VFS", "RC", "WebDAV"];

/// Groups for copy (and move) operations.
///
/// Matches the "Copy Options" section in `rclone copy --help` /
/// <https://rclone.org/commands/rclone_copy/#copy-options>
///
/// NOTE: `Performance` is intentionally absent. `checkers/transfers/buffer_size`
/// are global daemon settings; they must not double-appear here.
const COPY_GROUPS: &[&str] = &["Copy"];

/// Groups for sync operations — a superset of copy.
///
/// Matches "Copy Options" + "Sync Options" in `rclone sync --help` /
/// <https://rclone.org/commands/rclone_sync/#sync-options>
///
/// NOTE: `Performance` is intentionally absent — same reason as `COPY_GROUPS`.
const SYNC_GROUPS: &[&str] = &["Copy", "Sync"];

/// Groups for check operations.
///
/// Matches the "Check Options" section in `rclone check --help` /
/// <https://rclone.org/commands/rclone_check/#check-options>
const CHECK_GROUPS: &[&str] = &["Check"];

/// Returns the flag's groups as a `Vec<&str>`, trimmed.
fn flag_groups(flag: &Value) -> Vec<&str> {
    flag["Groups"]
        .as_str()
        .map(|s| s.split(',').map(str::trim).collect())
        .unwrap_or_default()
}

/// True if any of the flag's groups appear in `set`.
fn flag_has_any_group(flag: &Value, set: &[&str]) -> bool {
    let groups = flag_groups(flag);
    groups.iter().any(|g| set.contains(g))
}

// ---------------------------------------------------------------------------
// PRIVATE HELPERS
// ---------------------------------------------------------------------------

async fn fetch_options(
    transport: &Arc<dyn RcloneTransport>,
    endpoint: &str,
) -> Result<Value, String> {
    transport
        .rpc(endpoint, Some(&json!({})))
        .await
        .map_err(|e| format!("Failed to fetch options ({endpoint}): {e}"))
}

// ---------------------------------------------------------------------------
// DATA TRANSFORMATION
// ---------------------------------------------------------------------------

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

            // Walk the dotted path into current_options[block_name]
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

/// Groups a flat options list into a nested object keyed by prefix
/// (e.g. "HTTP", "Auth") derived from the first segment of `FieldName`.
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

/// Strips the leading dot-segments of every flag's `FieldName`, keeping only
/// the final component (mutates via iterator map).
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

// ---------------------------------------------------------------------------
// MASTER DATA COMMANDS
// ---------------------------------------------------------------------------

pub async fn get_all_options_with_values(app: AppHandle) -> Result<Value, String> {
    let backend_manager = app.state::<BackendManager>();
    let transport = crate::rclone::commands::common::transport(&app);
    let active_name = backend_manager.get_active().await.name.clone();

    if let Some(payload) = backend_manager.options_cache.get(&active_name).await {
        return Ok(payload);
    }

    let (mut options_info, current_options) = try_join!(
        fetch_options(&transport, options::INFO),
        fetch_options(&transport, options::GET),
    )?;

    merge_options(&mut options_info, &current_options);

    backend_manager
        .options_cache
        .set(active_name, options_info.clone())
        .await;

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
    let transport = crate::rclone::commands::common::transport(&app);
    fetch_options(&transport, options::BLOCKS).await
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
            // Group allow-list (uses exact comma-split matching)
            if let Some(allowed) = filter_groups {
                return flag_has_any_group(flag, allowed);
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
        .map(|v| v.iter().map(std::string::String::as_str).collect());
    let ef: Option<Vec<&str>> = exclude_flags
        .as_ref()
        .map(|v| v.iter().map(std::string::String::as_str).collect());
    Ok(get_flags_by_category_internal(
        &merged_json,
        &category,
        fg.as_deref(),
        ef.as_deref(),
    ))
}

/// Unified flag fetcher for all operation types.
/// Maps each operation to the correct rclone flag groups it supports.
#[tauri::command]
pub async fn get_operation_flags(app: AppHandle, operation: String) -> Result<Vec<Value>, String> {
    match operation.as_str() {
        // Copy group: copy, move
        "copy" | "move" => {
            let merged = get_all_options_with_values(app).await?;
            Ok(get_flags_by_category_internal(
                &merged,
                "main",
                Some(COPY_GROUPS),
                None,
            ))
        }
        // Copy + Sync groups: sync, bisync
        "sync" | "bisync" => {
            let merged = get_all_options_with_values(app).await?;
            Ok(get_flags_by_category_internal(
                &merged,
                "main",
                Some(SYNC_GROUPS),
                None,
            ))
        }
        // Check group: check
        "check" => {
            let merged = get_all_options_with_values(app).await?;
            Ok(get_flags_by_category_internal(
                &merged,
                "main",
                Some(CHECK_GROUPS),
                None,
            ))
        }
        // These operations have only static/frontend-defined flags
        "delete" | "copyurl" | "archivecreate" | "cryptcheck" => Ok(vec![]),

        _ => Err(format!("Unknown operation type for flags: {operation}")),
    }
}

#[tauri::command]
pub async fn get_filter_flags(app: AppHandle) -> Result<Vec<Value>, String> {
    let merged_json = get_all_options_with_values(app).await?;

    // Source 1: dedicated filter block, minus Metadata-tagged entries.
    let filter_block: Vec<Value> =
        get_flags_by_category_internal(&merged_json, "filter", None, None)
            .into_iter()
            .filter(|flag| !flag_has_any_group(flag, &["Metadata"]))
            .collect();

    // Source 2: main flags in the "Filter" group (e.g. --max-depth).
    let main_filter: Vec<Value> =
        get_flags_by_category_internal(&merged_json, "main", Some(&["Filter"]), None);

    let combined = [filter_block, main_filter].concat();
    Ok(simplify_field_names(combined))
}

/// Backend / global daemon flags.
///
/// These are settings that apply to the rclone process as a whole, regardless
/// of which operation is running. Includes Performance (checkers, transfers,
/// `buffer_size`), Networking, Config, Logging, Debugging, Listing, and Metadata.
///
/// Flags that carry a Copy or Sync group are explicitly excluded so that
/// operation-specific options never appear here.
#[tauri::command]
pub async fn get_backend_flags(app: AppHandle) -> Result<Vec<Value>, String> {
    let merged_json = get_all_options_with_values(app).await?;
    let mut flags: Vec<Value> = get_flags_by_category_internal(&merged_json, "main", None, None)
        .into_iter()
        .filter(|flag| {
            // Hard exclusions — never show operation-specific flags in backend.
            if flag_has_any_group(flag, BACKEND_EXCLUDE) {
                return false;
            }
            // Only include recognised global/backend groups.
            flag_has_any_group(flag, BACKEND_INCLUDE)
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

/// Set a single rclone option, building a nested JSON payload from a dotted
/// option name (e.g. "HTTP.ListenAddr" → `{ "HTTP": { "ListenAddr": value } }`).
#[tauri::command]
pub async fn set_rclone_option(
    app: AppHandle,
    block_name: String,
    option_name: String,
    value: Value,
) -> Result<Value, String> {
    let nested_value = option_name
        .split('.')
        .rev()
        .fold(value, |acc, part| json!({ part: acc }));
    let payload = json!({ block_name.clone(): nested_value });

    crate::rclone::commands::common::transport(&app)
        .rpc(options::SET, Some(&payload))
        .await
        .map_err(|e| format!("Failed to set option '{option_name}' in block '{block_name}': {e}"))
}

/// Set multiple rclone options in one call.
/// Expected payload shape: `{ "main": { "LogLevel": "DEBUG" }, "vfs": { "CacheMode": "full" } }`
#[tauri::command]
pub async fn set_rclone_options_bulk(app: AppHandle, payload: Value) -> Result<Value, String> {
    crate::rclone::commands::common::transport(&app)
        .rpc(options::SET, Some(&payload))
        .await
        .map_err(|e| format!("Failed to set bulk options: {e}"))
}
