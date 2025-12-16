use log::debug;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use tauri::{AppHandle, Manager, State};

use crate::{
    rclone::state::engine::ENGINE_STATE,
    utils::{
        json_helpers::{
            get_string, json_to_hashmap, resolve_profile_options, unwrap_nested_options,
        },
        logging::log::log_operation,
        rclone::endpoints::{EndpointHelper, sync},
        types::all_types::{JobCache, LogLevel, ProfileParams, RcloneState},
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
    /// Create SyncParams from a profile config and settings
    pub fn from_config(remote_name: String, config: &Value, settings: &Value) -> Option<Self> {
        let source = get_string(config, &["source"]);
        let dest = get_string(config, &["dest"]);

        if source.is_empty() || dest.is_empty() {
            return None;
        }

        let filter_profile = config.get("filterProfile").and_then(|v| v.as_str());
        let backend_profile = config.get("backendProfile").and_then(|v| v.as_str());

        let filter_options = resolve_profile_options(settings, filter_profile, "filterConfigs");
        let backend_options = resolve_profile_options(settings, backend_profile, "backendConfigs");

        Some(Self {
            remote_name,
            source,
            dest,
            sync_options: json_to_hashmap(config.get("options")),
            filter_options,
            backend_options,
            profile: Some(get_string(config, &["name"])).filter(|s| !s.is_empty()),
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
    /// Create CopyParams from a profile config and settings
    pub fn from_config(remote_name: String, config: &Value, settings: &Value) -> Option<Self> {
        let source = get_string(config, &["source"]);
        let dest = get_string(config, &["dest"]);

        if source.is_empty() || dest.is_empty() {
            return None;
        }

        let filter_profile = config.get("filterProfile").and_then(|v| v.as_str());
        let backend_profile = config.get("backendProfile").and_then(|v| v.as_str());

        let filter_options = resolve_profile_options(settings, filter_profile, "filterConfigs");
        let backend_options = resolve_profile_options(settings, backend_profile, "backendConfigs");

        Some(Self {
            remote_name,
            source,
            dest,
            copy_options: json_to_hashmap(config.get("options")),
            filter_options,
            backend_options,
            profile: Some(get_string(config, &["name"])).filter(|s| !s.is_empty()),
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
    /// Create BisyncParams from a profile config and settings
    pub fn from_config(remote_name: String, config: &Value, settings: &Value) -> Option<Self> {
        let source = get_string(config, &["source"]);
        let dest = get_string(config, &["dest"]);

        if source.is_empty() || dest.is_empty() {
            return None;
        }

        let filter_profile = config.get("filterProfile").and_then(|v| v.as_str());
        let backend_profile = config.get("backendProfile").and_then(|v| v.as_str());

        let filter_options = resolve_profile_options(settings, filter_profile, "filterConfigs");
        let backend_options = resolve_profile_options(settings, backend_profile, "backendConfigs");

        Some(Self {
            remote_name,
            source,
            dest,
            bisync_options: json_to_hashmap(config.get("options")),
            filter_options,
            backend_options,
            profile: Some(get_string(config, &["name"])).filter(|s| !s.is_empty()),
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
    /// Create MoveParams from a profile config and settings
    pub fn from_config(remote_name: String, config: &Value, settings: &Value) -> Option<Self> {
        let source = get_string(config, &["source"]);
        let dest = get_string(config, &["dest"]);

        if source.is_empty() || dest.is_empty() {
            return None;
        }

        let filter_profile = config.get("filterProfile").and_then(|v| v.as_str());
        let backend_profile = config.get("backendProfile").and_then(|v| v.as_str());

        let filter_options = resolve_profile_options(settings, filter_profile, "filterConfigs");
        let backend_options = resolve_profile_options(settings, backend_profile, "backendConfigs");

        Some(Self {
            remote_name,
            source,
            dest,
            move_options: json_to_hashmap(config.get("options")),
            filter_options,
            backend_options,
            profile: Some(get_string(config, &["name"])).filter(|s| !s.is_empty()),
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

// --- Core Functions ---

/// Start a sync operation
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

/// Start a copy operation
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

/// Start a bisync operation
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

/// Start a move operation
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

// ============================================================================
// PROFILE-BASED COMMANDS
// These commands accept only (remote_name, profile_name) and resolve all
// options internally from cached settings. This is the preferred API for
// frontend usage as it ensures consistency with tray actions.
// ============================================================================

use crate::utils::types::all_types::RemoteCache;

/// Start a sync operation using a named profile
/// Resolves all options (sync, filter, backend) from cached settings
#[tauri::command]
pub async fn start_sync_profile(
    app: AppHandle,
    job_cache: State<'_, JobCache>,
    rclone_state: State<'_, RcloneState>,
    params: ProfileParams,
) -> Result<u64, String> {
    let cache = app.state::<RemoteCache>();
    let settings_map = cache.get_settings().await;

    let settings = settings_map
        .get(&params.remote_name)
        .ok_or_else(|| format!("Remote '{}' not found in settings", params.remote_name))?;

    let sync_configs = settings
        .get("syncConfigs")
        .and_then(|v| v.as_object())
        .ok_or_else(|| format!("No syncConfigs found for '{}'", params.remote_name))?;

    let config = sync_configs
        .get(&params.profile_name)
        .ok_or_else(|| format!("Sync profile '{}' not found", params.profile_name))?;

    let mut sync_params = SyncParams::from_config(params.remote_name.clone(), config, settings)
        .ok_or_else(|| {
            format!(
                "Sync configuration incomplete for profile '{}'",
                params.profile_name
            )
        })?;

    // Ensure profile is set from the function parameter, not the config object
    sync_params.profile = Some(params.profile_name.clone());

    start_sync(app, job_cache, rclone_state, sync_params).await
}

/// Start a copy operation using a named profile
#[tauri::command]
pub async fn start_copy_profile(
    app: AppHandle,
    job_cache: State<'_, JobCache>,
    rclone_state: State<'_, RcloneState>,
    params: ProfileParams,
) -> Result<u64, String> {
    let cache = app.state::<RemoteCache>();
    let settings_map = cache.get_settings().await;

    let settings = settings_map
        .get(&params.remote_name)
        .ok_or_else(|| format!("Remote '{}' not found in settings", params.remote_name))?;

    let copy_configs = settings
        .get("copyConfigs")
        .and_then(|v| v.as_object())
        .ok_or_else(|| format!("No copyConfigs found for '{}'", params.remote_name))?;

    let config = copy_configs
        .get(&params.profile_name)
        .ok_or_else(|| format!("Copy profile '{}' not found", params.profile_name))?;

    let mut copy_params = CopyParams::from_config(params.remote_name.clone(), config, settings)
        .ok_or_else(|| {
            format!(
                "Copy configuration incomplete for profile '{}'",
                params.profile_name
            )
        })?;

    // Ensure profile is set from the function parameter, not the config object
    copy_params.profile = Some(params.profile_name.clone());

    start_copy(app, job_cache, rclone_state, copy_params).await
}

/// Start a bisync operation using a named profile
#[tauri::command]
pub async fn start_bisync_profile(
    app: AppHandle,
    job_cache: State<'_, JobCache>,
    rclone_state: State<'_, RcloneState>,
    params: ProfileParams,
) -> Result<u64, String> {
    let cache = app.state::<RemoteCache>();
    let settings_map = cache.get_settings().await;

    let settings = settings_map
        .get(&params.remote_name)
        .ok_or_else(|| format!("Remote '{}' not found in settings", params.remote_name))?;

    let bisync_configs = settings
        .get("bisyncConfigs")
        .and_then(|v| v.as_object())
        .ok_or_else(|| format!("No bisyncConfigs found for '{}'", params.remote_name))?;

    let config = bisync_configs
        .get(&params.profile_name)
        .ok_or_else(|| format!("Bisync profile '{}' not found", params.profile_name))?;

    let mut bisync_params = BisyncParams::from_config(params.remote_name.clone(), config, settings)
        .ok_or_else(|| {
            format!(
                "Bisync configuration incomplete for profile '{}'",
                params.profile_name
            )
        })?;

    // Ensure profile is set from the function parameter, not the config object
    bisync_params.profile = Some(params.profile_name.clone());

    start_bisync(app, job_cache, rclone_state, bisync_params).await
}

/// Start a move operation using a named profile
#[tauri::command]
pub async fn start_move_profile(
    app: AppHandle,
    job_cache: State<'_, JobCache>,
    rclone_state: State<'_, RcloneState>,
    params: ProfileParams,
) -> Result<u64, String> {
    let cache = app.state::<RemoteCache>();
    let settings_map = cache.get_settings().await;

    let settings = settings_map
        .get(&params.remote_name)
        .ok_or_else(|| format!("Remote '{}' not found in settings", params.remote_name))?;

    let move_configs = settings
        .get("moveConfigs")
        .and_then(|v| v.as_object())
        .ok_or_else(|| format!("No moveConfigs found for '{}'", params.remote_name))?;

    let config = move_configs
        .get(&params.profile_name)
        .ok_or_else(|| format!("Move profile '{}' not found", params.profile_name))?;

    let mut move_params = MoveParams::from_config(params.remote_name.clone(), config, settings)
        .ok_or_else(|| {
            format!(
                "Move configuration incomplete for profile '{}'",
                params.profile_name
            )
        })?;

    // Ensure profile is set from the function parameter, not the config object
    move_params.profile = Some(params.profile_name.clone());

    start_move(app, job_cache, rclone_state, move_params).await
}
