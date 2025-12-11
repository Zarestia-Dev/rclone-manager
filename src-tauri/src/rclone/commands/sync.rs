use log::debug;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use tauri::{AppHandle, State};

use crate::{
    rclone::state::engine::ENGINE_STATE,
    utils::{
        json_helpers::{get_string, json_to_hashmap, unwrap_nested_options},
        logging::log::log_operation,
        rclone::endpoints::{EndpointHelper, sync},
        types::all_types::{JobCache, LogLevel, RcloneState},
    },
};

use super::job::{JobMetadata, submit_job};

/// Parameters for starting a sync operation
#[derive(Debug, serde::Deserialize, serde::Serialize, Clone)]
pub struct SyncParams {
    pub remote_name: String,
    pub source: String,
    pub dest: String,
    pub sync_options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub backend_options: Option<HashMap<String, Value>>,
    pub profile: Option<String>,
}

impl SyncParams {
    /// Create SyncParams from settings JSON, returns None if invalid
    pub fn from_settings(remote_name: String, settings: &Value) -> Option<Self> {
        let sync_cfg = settings.get("syncConfig")?;

        let source = get_string(sync_cfg, &["source"]);
        let dest = get_string(sync_cfg, &["dest"]);

        // Validate required fields
        if source.is_empty() || dest.is_empty() {
            return None;
        }

        // Helper to resolve profile references
        let resolve_profile_options =
            |profile_name: Option<&str>, configs_key: &str| -> Option<HashMap<String, Value>> {
                if let Some(name) = profile_name {
                    if let Some(configs) = settings.get(configs_key).and_then(|v| v.as_array()) {
                        for config in configs {
                            if let Some(config_name) = config.get("name").and_then(|v| v.as_str()) {
                                if config_name == name {
                                    return json_to_hashmap(config.get("options"));
                                }
                            }
                        }
                    }
                }
                None
            };

        let filter_profile = sync_cfg.get("filterProfile").and_then(|v| v.as_str());
        let backend_profile = sync_cfg.get("backendProfile").and_then(|v| v.as_str());

        let filter_options = resolve_profile_options(filter_profile, "filterConfigs");
        let backend_options = resolve_profile_options(backend_profile, "backendConfigs");

        Some(Self {
            remote_name,
            source,
            dest,
            sync_options: json_to_hashmap(sync_cfg.get("options")),
            filter_options,
            backend_options,
            profile: Some(get_string(sync_cfg, &["name"])).filter(|s| !s.is_empty()),
        })
    }
}

/// Parameters for starting a copy operation
#[derive(Debug, serde::Deserialize, serde::Serialize, Clone)]
pub struct CopyParams {
    pub remote_name: String,
    pub source: String,
    pub dest: String,
    pub copy_options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub backend_options: Option<HashMap<String, Value>>,
    pub profile: Option<String>,
}

impl CopyParams {
    pub fn from_settings(remote_name: String, settings: &Value) -> Option<Self> {
        let copy_cfg = settings.get("copyConfig")?;

        let source = get_string(copy_cfg, &["source"]);
        let dest = get_string(copy_cfg, &["dest"]);

        if source.is_empty() || dest.is_empty() {
            return None;
        }

        let resolve_profile_options =
            |profile_name: Option<&str>, configs_key: &str| -> Option<HashMap<String, Value>> {
                if let Some(name) = profile_name {
                    if let Some(configs) = settings.get(configs_key).and_then(|v| v.as_array()) {
                        for config in configs {
                            if let Some(config_name) = config.get("name").and_then(|v| v.as_str()) {
                                if config_name == name {
                                    return json_to_hashmap(config.get("options"));
                                }
                            }
                        }
                    }
                }
                None
            };

        let filter_profile = copy_cfg.get("filterProfile").and_then(|v| v.as_str());
        let backend_profile = copy_cfg.get("backendProfile").and_then(|v| v.as_str());

        let filter_options = resolve_profile_options(filter_profile, "filterConfigs");
        let backend_options = resolve_profile_options(backend_profile, "backendConfigs");

        Some(Self {
            remote_name,
            source,
            dest,
            copy_options: json_to_hashmap(copy_cfg.get("options")),
            filter_options,
            backend_options,
            profile: Some(get_string(copy_cfg, &["name"])).filter(|s| !s.is_empty()),
        })
    }
}

/// Parameters for starting a bisync operation
#[derive(Debug, serde::Deserialize, serde::Serialize, Clone)]
pub struct BisyncParams {
    pub remote_name: String,
    pub source: String,
    pub dest: String,
    pub bisync_options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub backend_options: Option<HashMap<String, Value>>,
    pub profile: Option<String>,
}

impl BisyncParams {
    pub fn from_settings(remote_name: String, settings: &Value) -> Option<Self> {
        let bisync_cfg = settings.get("bisyncConfig")?;

        let source = get_string(bisync_cfg, &["source"]);
        let dest = get_string(bisync_cfg, &["dest"]);

        if source.is_empty() || dest.is_empty() {
            return None;
        }

        let resolve_profile_options =
            |profile_name: Option<&str>, configs_key: &str| -> Option<HashMap<String, Value>> {
                if let Some(name) = profile_name {
                    if let Some(configs) = settings.get(configs_key).and_then(|v| v.as_array()) {
                        for config in configs {
                            if let Some(config_name) = config.get("name").and_then(|v| v.as_str()) {
                                if config_name == name {
                                    return json_to_hashmap(config.get("options"));
                                }
                            }
                        }
                    }
                }
                None
            };

        let filter_profile = bisync_cfg.get("filterProfile").and_then(|v| v.as_str());
        let backend_profile = bisync_cfg.get("backendProfile").and_then(|v| v.as_str());

        let filter_options = resolve_profile_options(filter_profile, "filterConfigs");
        let backend_options = resolve_profile_options(backend_profile, "backendConfigs");

        Some(Self {
            remote_name,
            source,
            dest,
            bisync_options: json_to_hashmap(bisync_cfg.get("options")),
            filter_options,
            backend_options,
            profile: Some(get_string(bisync_cfg, &["name"])).filter(|s| !s.is_empty()),
        })
    }
}

/// Parameters for starting a move operation
#[derive(Debug, serde::Deserialize, serde::Serialize, Clone)]
pub struct MoveParams {
    pub remote_name: String,
    pub source: String,
    pub dest: String,
    pub move_options: Option<HashMap<String, Value>>, // rclone move-specific options
    pub filter_options: Option<HashMap<String, Value>>, // filter options
    pub backend_options: Option<HashMap<String, Value>>, // backend options
    pub profile: Option<String>,
}

impl MoveParams {
    pub fn from_settings(remote_name: String, settings: &Value) -> Option<Self> {
        let move_cfg = settings.get("moveConfig")?;

        let source = get_string(move_cfg, &["source"]);
        let dest = get_string(move_cfg, &["dest"]);

        if source.is_empty() || dest.is_empty() {
            return None;
        }

        let resolve_profile_options =
            |profile_name: Option<&str>, configs_key: &str| -> Option<HashMap<String, Value>> {
                if let Some(name) = profile_name {
                    if let Some(configs) = settings.get(configs_key).and_then(|v| v.as_array()) {
                        for config in configs {
                            if let Some(config_name) = config.get("name").and_then(|v| v.as_str()) {
                                if config_name == name {
                                    return json_to_hashmap(config.get("options"));
                                }
                            }
                        }
                    }
                }
                None
            };

        let filter_profile = move_cfg.get("filterProfile").and_then(|v| v.as_str());
        let backend_profile = move_cfg.get("backendProfile").and_then(|v| v.as_str());

        let filter_options = resolve_profile_options(filter_profile, "filterConfigs");
        let backend_options = resolve_profile_options(backend_profile, "backendConfigs");

        Some(Self {
            remote_name,
            source,
            dest,
            move_options: json_to_hashmap(move_cfg.get("options")),
            filter_options,
            backend_options,
            profile: Some(get_string(move_cfg, &["name"])).filter(|s| !s.is_empty()),
        })
    }
}

// --- Helper for merging options ---
/// Merges main options and backend options into a single HashMap
/// Also unwraps any nested "options" keys from the frontend
fn merge_options(
    main_opts: Option<HashMap<String, Value>>,
    backend_opts: Option<HashMap<String, Value>>,
) -> HashMap<String, Value> {
    let main = main_opts.map(unwrap_nested_options);
    let backend = backend_opts.map(unwrap_nested_options);

    match (main, backend) {
        (Some(mut opts), Some(backend_unwrapped)) => {
            opts.extend(backend_unwrapped);
            opts
        }
        (Some(opts), None) => opts,
        (None, Some(backend_unwrapped)) => backend_unwrapped,
        (None, None) => HashMap::new(),
    }
}

// --- Tauri Commands ---

/// Start a sync operation
#[tauri::command]
pub async fn start_sync(
    app: AppHandle,
    _job_cache: State<'_, JobCache>, // Maintained for signature compatibility
    rclone_state: State<'_, RcloneState>,
    params: SyncParams,
) -> Result<u64, String> {
    debug!("Received start_sync params: {params:#?}");
    let operation_name = "Sync operation";
    log_operation(
        LogLevel::Info,
        Some(params.remote_name.clone()),
        Some(operation_name.to_string()),
        format!("Starting sync from {} to {}", params.source, params.dest),
        Some(json!({
            "source": params.source,
            "destination": params.dest,
            "sync_options": params.sync_options.as_ref().map(|o| o.keys().collect::<Vec<_>>()),
            "filters": params.filter_options.as_ref().map(|f| f.keys().collect::<Vec<_>>()),
            "backend_options": params.backend_options.as_ref().map(|b| b.keys().collect::<Vec<_>>())
        })),
    );

    // Construct the JSON body
    let mut body = Map::new();
    body.insert("srcFs".to_string(), Value::String(params.source.clone()));
    body.insert("dstFs".to_string(), Value::String(params.dest.clone()));
    body.insert("_async".to_string(), Value::Bool(true));

    let mut sync_opts = params.sync_options.unwrap_or_default();

    // Handle dedicated parameters that are top-level in the JSON payload
    if let Some(Value::Bool(true)) = sync_opts.remove("createEmptySrcDirs") {
        body.insert("createEmptySrcDirs".to_string(), Value::Bool(true));
    }

    // The remaining opts are generic flags for _config
    let config_map = merge_options(Some(sync_opts), params.backend_options);
    if !config_map.is_empty() {
        body.insert(
            "_config".to_string(),
            Value::Object(config_map.into_iter().collect()),
        );
    }

    if let Some(filters) = params.filter_options {
        let unwrapped_filters = unwrap_nested_options(filters);
        body.insert(
            "_filter".to_string(),
            Value::Object(unwrapped_filters.into_iter().collect()),
        );
    }

    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, sync::SYNC);

    let (jobid, _) = submit_job(
        app,
        rclone_state.client.clone(),
        url,
        Value::Object(body),
        JobMetadata {
            remote_name: params.remote_name,
            job_type: "sync".to_string(),
            operation_name: operation_name.to_string(),
            source: params.source,
            destination: params.dest,
            profile: params.profile.clone(),
        },
    )
    .await?;

    Ok(jobid)
}

#[tauri::command]
pub async fn start_copy(
    app: AppHandle,
    _job_cache: State<'_, JobCache>,
    rclone_state: State<'_, RcloneState>,
    params: CopyParams,
) -> Result<u64, String> {
    debug!("Received start_copy params: {params:#?}");
    let operation_name = "Copy operation";
    log_operation(
        LogLevel::Info,
        Some(params.remote_name.clone()),
        Some(operation_name.to_string()),
        format!("Starting copy from {} to {}", params.source, params.dest),
        Some(json!({
            "source": params.source,
            "destination": params.dest,
            "copy_options": params.copy_options.as_ref().map(|o| o.keys().collect::<Vec<_>>()),
            "filters": params.filter_options.as_ref().map(|f| f.keys().collect::<Vec<_>>()),
            "backend_options": params.backend_options.as_ref().map(|b| b.keys().collect::<Vec<_>>())
        })),
    );

    let mut body = Map::new();
    body.insert("srcFs".to_string(), Value::String(params.source.clone()));
    body.insert("dstFs".to_string(), Value::String(params.dest.clone()));
    body.insert("_async".to_string(), Value::Bool(true));

    let mut copy_opts = params.copy_options.unwrap_or_default();

    // Handle dedicated parameters
    if let Some(Value::Bool(true)) = copy_opts.remove("createEmptySrcDirs") {
        body.insert("createEmptySrcDirs".to_string(), Value::Bool(true));
    }

    let config_map = merge_options(Some(copy_opts), params.backend_options);
    if !config_map.is_empty() {
        body.insert(
            "_config".to_string(),
            Value::Object(config_map.into_iter().collect()),
        );
    }

    if let Some(filters) = params.filter_options {
        let unwrapped_filters = unwrap_nested_options(filters);
        body.insert(
            "_filter".to_string(),
            Value::Object(unwrapped_filters.into_iter().collect()),
        );
    }

    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, sync::COPY);

    let (jobid, _) = submit_job(
        app,
        rclone_state.client.clone(),
        url,
        Value::Object(body),
        JobMetadata {
            remote_name: params.remote_name,
            job_type: "copy".to_string(),
            operation_name: operation_name.to_string(),
            source: params.source,
            destination: params.dest,
            profile: params.profile.clone(),
        },
    )
    .await?;

    Ok(jobid)
}

#[tauri::command]
pub async fn start_bisync(
    app: AppHandle,
    _job_cache: State<'_, JobCache>,
    rclone_state: State<'_, RcloneState>,
    params: BisyncParams,
) -> Result<u64, String> {
    debug!("Received start_bisync params: {params:#?}");
    let operation_name = "Bisync operation";
    log_operation(
        LogLevel::Info,
        Some(params.remote_name.clone()),
        Some(operation_name.to_string()),
        format!(
            "Starting bisync between {} and {}",
            params.source, params.dest
        ),
        Some(json!({
            "source (path1)": params.source,
            "destination (path2)": params.dest,
            "bisync_options": params.bisync_options.as_ref().map(|o| o.keys().collect::<Vec<_>>()),
            "filters": params.filter_options.as_ref().map(|f| f.keys().collect::<Vec<_>>()),
            "backend_options": params.backend_options.as_ref().map(|b| b.keys().collect::<Vec<_>>())
        })),
    );

    // Construct the JSON body
    let mut body = Map::new();
    body.insert("path1".to_string(), Value::String(params.source.clone()));
    body.insert("path2".to_string(), Value::String(params.dest.clone()));
    body.insert("_async".to_string(), Value::Bool(true));

    let mut bisync_opts = params.bisync_options.unwrap_or_default();

    // Dedicated bisync parameters are top-level in the JSON payload.
    // We extract them from the options map, and the rest will be passed in _config.
    let dedicated_params = [
        "resync",
        "checkAccess",
        "checkFilename",
        "maxDelete",
        "force",
        "checkSync",
        "createEmptySrcDirs",
        "removeEmptyDirs",
        "filtersFile",
        "ignoreListingChecksum",
        "resilient",
        "workDir",
        "backupDir1",
        "backupDir2",
        "noCleanup",
        "dryRun",
    ];

    for key in dedicated_params {
        if let Some(value) = bisync_opts.remove(key) {
            body.insert(key.to_string(), value);
        }
    }

    let config_map = merge_options(Some(bisync_opts), params.backend_options);
    if !config_map.is_empty() {
        body.insert(
            "_config".to_string(),
            Value::Object(config_map.into_iter().collect()),
        );
    }

    if let Some(filters) = params.filter_options {
        let unwrapped_filters = unwrap_nested_options(filters);
        body.insert(
            "_filter".to_string(),
            Value::Object(unwrapped_filters.into_iter().collect()),
        );
    }

    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, sync::BISYNC);

    let (jobid, _) = submit_job(
        app,
        rclone_state.client.clone(),
        url,
        Value::Object(body),
        JobMetadata {
            remote_name: params.remote_name,
            job_type: "bisync".to_string(),
            operation_name: operation_name.to_string(),
            source: params.source,
            destination: params.dest,
            profile: params.profile.clone(),
        },
    )
    .await?;

    Ok(jobid)
}

#[tauri::command]
pub async fn start_move(
    app: AppHandle,
    _job_cache: State<'_, JobCache>,
    rclone_state: State<'_, RcloneState>,
    params: MoveParams,
) -> Result<u64, String> {
    debug!("Received start_move params: {params:#?}");
    let operation_name = "Move operation";
    log_operation(
        LogLevel::Info,
        Some(params.remote_name.clone()),
        Some(operation_name.to_string()),
        format!("Starting move from {} to {}", params.source, params.dest),
        Some(json!({
            "source": params.source,
            "destination": params.dest,
            "move_options": params.move_options.as_ref().map(|o| o.keys().collect::<Vec<_>>()),
            "filters": params.filter_options.as_ref().map(|f| f.keys().collect::<Vec<_>>()),
            "backend_options": params.backend_options.as_ref().map(|b| b.keys().collect::<Vec<_>>())
        })),
    );
    let mut body = Map::new();
    body.insert("srcFs".to_string(), Value::String(params.source.clone()));
    body.insert("dstFs".to_string(), Value::String(params.dest.clone()));
    body.insert("_async".to_string(), Value::Bool(true));

    let mut move_opts = params.move_options.unwrap_or_default();

    // Handle dedicated parameters
    if let Some(Value::Bool(true)) = move_opts.remove("createEmptySrcDirs") {
        body.insert("createEmptySrcDirs".to_string(), Value::Bool(true));
    }
    if let Some(Value::Bool(true)) = move_opts.remove("deleteEmptySrcDirs") {
        body.insert("deleteEmptySrcDirs".to_string(), Value::Bool(true));
    }

    let config_map = merge_options(Some(move_opts), params.backend_options);
    if !config_map.is_empty() {
        body.insert(
            "_config".to_string(),
            Value::Object(config_map.into_iter().collect()),
        );
    }

    if let Some(filters) = params.filter_options {
        let unwrapped_filters = unwrap_nested_options(filters);
        body.insert(
            "_filter".to_string(),
            Value::Object(unwrapped_filters.into_iter().collect()),
        );
    }

    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, sync::MOVE);

    let (jobid, _) = submit_job(
        app,
        rclone_state.client.clone(),
        url,
        Value::Object(body),
        JobMetadata {
            remote_name: params.remote_name,
            job_type: "move".to_string(),
            operation_name: operation_name.to_string(),
            source: params.source,
            destination: params.dest,
            profile: params.profile.clone(),
        },
    )
    .await?;

    Ok(jobid)
}
