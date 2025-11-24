use chrono::Utc;
use log::{debug, error, warn};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};

use crate::{
    RcloneState,
    rclone::state::engine::ENGINE_STATE,
    utils::{
        json_helpers::{get_string, json_to_hashmap},
        logging::log::log_operation,
        rclone::endpoints::{EndpointHelper, sync},
        types::{
            all_types::{JobCache, JobInfo, JobResponse, JobStatus, LogLevel},
            events::JOB_CACHE_CHANGED,
        },
    },
};

use super::job::monitor_job;

// --- Internal Helper Function ---
#[allow(clippy::too_many_arguments)]
async fn start_sync_like_job(
    app: AppHandle,
    job_cache: State<'_, JobCache>,
    state: State<'_, RcloneState>,
    remote_name: String,
    source: String,
    dest: String,
    job_type: &'static str,
    operation_name: &'static str,
    endpoint: &'static str,
    payload_body: Map<String, Value>,
) -> Result<u64, String> {
    debug!(
        "Calling start_sync_like_job for {}: {} -> {}",
        operation_name, source, dest
    );

    if job_cache.is_job_running(&remote_name, job_type).await {
        let err_msg = format!(
            "A '{}' job for remote '{}' is already in progress.",
            job_type, remote_name
        );
        warn!("{}", err_msg);
        return Err(err_msg);
    }

    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, endpoint);

    let response = state
        .client
        .post(&url)
        .json(&Value::Object(payload_body))
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = response.status();
    let body_text = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = format!("HTTP {status}: {body_text}");
        log_operation(
            LogLevel::Error,
            Some(remote_name.clone()),
            Some(operation_name.to_string()),
            format!("Failed to start {job_type} job"),
            Some(json!({"response": body_text})),
        );
        error!("❌ Failed to start {job_type} job: {error}");
        return Err(error);
    }

    let job: JobResponse =
        serde_json::from_str(&body_text).map_err(|e| format!("Failed to parse response: {e}"))?;

    let jobid = job.jobid;
    log_operation(
        LogLevel::Info,
        Some(remote_name.clone()),
        Some(operation_name.to_string()),
        format!("{operation_name} job started with ID {jobid}"),
        Some(json!({"jobid": jobid})),
    );

    job_cache
        .add_job(JobInfo {
            jobid,
            job_type: job_type.to_string(),
            remote_name: remote_name.clone(),
            source: source.clone(),
            destination: dest.clone(),
            start_time: Utc::now(),
            status: JobStatus::Running,
            stats: None,
            group: format!("job/{jobid}"),
        })
        .await;

    // Start monitoring the job in a background task
    let app_clone = app.clone();
    let client = state.client.clone();
    tauri::async_runtime::spawn(async move {
        let _ = monitor_job(remote_name, operation_name, jobid, app_clone, client).await;
    });

    app.emit(JOB_CACHE_CHANGED, jobid)
        .map_err(|e| format!("Failed to emit event: {e}"))?;
    Ok(jobid)
}

/// Parameters for starting a sync operation
#[derive(Debug, serde::Deserialize, serde::Serialize, Clone)]
pub struct SyncParams {
    pub remote_name: String,
    pub source: String,
    pub dest: String,
    pub sync_options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub backend_options: Option<HashMap<String, Value>>,
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

        Some(Self {
            remote_name,
            source,
            dest,
            sync_options: json_to_hashmap(sync_cfg.get("options")),
            filter_options: json_to_hashmap(settings.get("filterConfig")),
            backend_options: json_to_hashmap(settings.get("backendConfig")),
        })
    }

    /// Check if the auto-start flag is enabled
    pub fn should_auto_start(settings: &Value) -> bool {
        settings
            .get("syncConfig")
            .and_then(|v| v.get("autoStart"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
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
}

impl CopyParams {
    pub fn from_settings(remote_name: String, settings: &Value) -> Option<Self> {
        let copy_cfg = settings.get("copyConfig")?;

        let source = get_string(copy_cfg, &["source"]);
        let dest = get_string(copy_cfg, &["dest"]);

        if source.is_empty() || dest.is_empty() {
            return None;
        }

        Some(Self {
            remote_name,
            source,
            dest,
            copy_options: json_to_hashmap(copy_cfg.get("options")),
            filter_options: json_to_hashmap(settings.get("filterConfig")),
            backend_options: json_to_hashmap(settings.get("backendConfig")),
        })
    }

    pub fn should_auto_start(settings: &Value) -> bool {
        settings
            .get("copyConfig")
            .and_then(|v| v.get("autoStart"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
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
}

impl BisyncParams {
    pub fn from_settings(remote_name: String, settings: &Value) -> Option<Self> {
        let bisync_cfg = settings.get("bisyncConfig")?;

        let source = get_string(bisync_cfg, &["source"]);
        let dest = get_string(bisync_cfg, &["dest"]);

        if source.is_empty() || dest.is_empty() {
            return None;
        }

        Some(Self {
            remote_name,
            source,
            dest,
            bisync_options: json_to_hashmap(bisync_cfg.get("options")),
            filter_options: json_to_hashmap(settings.get("filterConfig")),
            backend_options: json_to_hashmap(settings.get("backendConfig")),
        })
    }

    pub fn should_auto_start(settings: &Value) -> bool {
        settings
            .get("bisyncConfig")
            .and_then(|v| v.get("autoStart"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
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
}

impl MoveParams {
    pub fn from_settings(remote_name: String, settings: &Value) -> Option<Self> {
        let move_cfg = settings.get("moveConfig")?;

        let source = get_string(move_cfg, &["source"]);
        let dest = get_string(move_cfg, &["dest"]);

        if source.is_empty() || dest.is_empty() {
            return None;
        }

        Some(Self {
            remote_name,
            source,
            dest,
            move_options: json_to_hashmap(move_cfg.get("options")),
            filter_options: json_to_hashmap(settings.get("filterConfig")),
            backend_options: json_to_hashmap(settings.get("backendConfig")),
        })
    }

    pub fn should_auto_start(settings: &Value) -> bool {
        settings
            .get("moveConfig")
            .and_then(|v| v.get("autoStart"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }
}

// --- Helper for merging options ---
/// Merges main options and backend options into a single HashMap
fn merge_options(
    main_opts: Option<HashMap<String, Value>>,
    backend_opts: Option<HashMap<String, Value>>,
) -> HashMap<String, Value> {
    match (main_opts, backend_opts) {
        (Some(mut opts), Some(backend)) => {
            opts.extend(backend);
            opts
        }
        (Some(opts), None) => opts,
        (None, Some(backend)) => backend,
        (None, None) => HashMap::new(),
    }
}

// --- Tauri Commands ---

/// Start a sync operation
#[tauri::command]
pub async fn start_sync(
    app: AppHandle,
    job_cache: State<'_, JobCache>,
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
        body.insert(
            "_filter".to_string(),
            Value::Object(filters.into_iter().collect()),
        );
    }

    start_sync_like_job(
        app.clone(),
        job_cache,
        rclone_state,
        params.remote_name,
        params.source,
        params.dest,
        "sync",
        operation_name,
        sync::SYNC,
        body,
    )
    .await
}

#[tauri::command]
pub async fn start_copy(
    app: AppHandle,
    job_cache: State<'_, JobCache>,
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
        body.insert(
            "_filter".to_string(),
            Value::Object(filters.into_iter().collect()),
        );
    }

    start_sync_like_job(
        app,
        job_cache,
        rclone_state,
        params.remote_name,
        params.source,
        params.dest,
        "copy",
        operation_name,
        sync::COPY,
        body,
    )
    .await
}

#[tauri::command]
pub async fn start_bisync(
    app: AppHandle,
    job_cache: State<'_, JobCache>,
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
        body.insert(
            "_filter".to_string(),
            Value::Object(filters.into_iter().collect()),
        );
    }

    start_sync_like_job(
        app,
        job_cache,
        rclone_state,
        params.remote_name,
        params.source,
        params.dest,
        "bisync",
        operation_name,
        sync::BISYNC,
        body,
    )
    .await
}

#[tauri::command]
pub async fn start_move(
    app: AppHandle,
    job_cache: State<'_, JobCache>,
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
        body.insert(
            "_filter".to_string(),
            Value::Object(filters.into_iter().collect()),
        );
    }

    start_sync_like_job(
        app,
        job_cache,
        rclone_state,
        params.remote_name,
        params.source,
        params.dest,
        "move",
        operation_name,
        sync::MOVE,
        body,
    )
    .await
}
