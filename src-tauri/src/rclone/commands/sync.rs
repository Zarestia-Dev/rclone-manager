use chrono::Utc;
use log::{debug, error, warn};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};

use crate::{
    RcloneState,
    rclone::state::engine::ENGINE_STATE,
    utils::{
        json_helpers::{get_bool, get_string, json_to_hashmap},
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
    pub create_empty_src_dirs: bool,
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
            create_empty_src_dirs: get_bool(sync_cfg, &["createEmptySrcDirs"], false),
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
    pub create_empty_src_dirs: bool,
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
            create_empty_src_dirs: get_bool(copy_cfg, &["createEmptySrcDirs"], false),
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
    pub dry_run: Option<bool>,
    pub resync: bool,
    pub check_access: Option<bool>,
    pub check_filename: Option<String>,
    pub max_delete: Option<i64>,
    pub force: Option<bool>,
    pub check_sync: Option<String>, // "true", "false", or "only"
    pub create_empty_src_dirs: Option<bool>,
    pub remove_empty_dirs: Option<bool>,
    pub filters_file: Option<String>,
    pub ignore_listing_checksum: Option<bool>,
    pub resilient: Option<bool>,
    pub workdir: Option<String>,
    pub backupdir1: Option<String>,
    pub backupdir2: Option<String>,
    pub no_cleanup: Option<bool>,
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
            dry_run: Some(get_bool(bisync_cfg, &["dryRun"], false)),
            resync: get_bool(bisync_cfg, &["resync"], false),
            check_access: Some(get_bool(bisync_cfg, &["checkAccess"], false)),
            check_filename: bisync_cfg
                .get("checkFilename")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            max_delete: Some(
                bisync_cfg
                    .get("maxDelete")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
            ),
            force: Some(get_bool(bisync_cfg, &["force"], false)),
            check_sync: bisync_cfg.get("checkSync").and_then(|v| {
                if let Some(b) = v.as_bool() {
                    Some(if b {
                        "true".to_string()
                    } else {
                        "false".to_string()
                    })
                } else {
                    v.as_str().map(|s| s.to_string())
                }
            }),
            create_empty_src_dirs: Some(get_bool(bisync_cfg, &["createEmptySrcDirs"], false)),
            remove_empty_dirs: Some(get_bool(bisync_cfg, &["removeEmptyDirs"], false)),
            filters_file: bisync_cfg
                .get("filtersFile")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            ignore_listing_checksum: Some(get_bool(bisync_cfg, &["ignoreListingChecksum"], false)),
            resilient: Some(get_bool(bisync_cfg, &["resilient"], false)),
            workdir: bisync_cfg
                .get("workdir")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            backupdir1: bisync_cfg
                .get("backupdir1")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            backupdir2: bisync_cfg
                .get("backupdir2")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            no_cleanup: Some(get_bool(bisync_cfg, &["noCleanup"], false)),
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
    pub create_empty_src_dirs: bool,
    pub delete_empty_src_dirs: bool,
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
            create_empty_src_dirs: get_bool(move_cfg, &["createEmptySrcDirs"], false),
            delete_empty_src_dirs: get_bool(move_cfg, &["deleteEmptySrcDirs"], false),
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
            "create_empty_src_dirs": params.create_empty_src_dirs,
            "sync_options": params.sync_options.as_ref().map(|o| o.keys().collect::<Vec<_>>()),
            "filters": params.filter_options.as_ref().map(|f| f.keys().collect::<Vec<_>>()),
            "backend_options": params.backend_options.as_ref().map(|b| b.keys().collect::<Vec<_>>())
        })),
    );

    // Construct the JSON body
    let mut body = Map::new();
    body.insert("srcFs".to_string(), Value::String(params.source.clone()));
    body.insert("dstFs".to_string(), Value::String(params.dest.clone()));
    if params.create_empty_src_dirs {
        body.insert("createEmptySrcDirs".to_string(), Value::Bool(true));
    }
    body.insert("_async".to_string(), Value::Bool(true));

    let config_map = merge_options(params.sync_options, params.backend_options);
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
            "create_empty_src_dirs": params.create_empty_src_dirs,
            "copy_options": params.copy_options.as_ref().map(|o| o.keys().collect::<Vec<_>>()),
            "filters": params.filter_options.as_ref().map(|f| f.keys().collect::<Vec<_>>()),
            "backend_options": params.backend_options.as_ref().map(|b| b.keys().collect::<Vec<_>>())
        })),
    );

    let mut body = Map::new();
    body.insert("srcFs".to_string(), Value::String(params.source.clone()));
    body.insert("dstFs".to_string(), Value::String(params.dest.clone()));
    if params.create_empty_src_dirs {
        body.insert("createEmptySrcDirs".to_string(), Value::Bool(true));
    }
    body.insert("_async".to_string(), Value::Bool(true));

    let config_map = merge_options(params.copy_options, params.backend_options);
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
            "resync": params.resync,
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
    body.insert("resync".to_string(), Value::Bool(params.resync));

    // Insert optional fields
    if let Some(v) = params.create_empty_src_dirs {
        body.insert("createEmptySrcDirs".to_string(), Value::Bool(v));
    }
    if let Some(v) = params.no_cleanup {
        body.insert("noCleanup".to_string(), Value::Bool(v));
    }
    if let Some(v) = params.dry_run {
        body.insert("dryRun".to_string(), Value::Bool(v));
    }
    if let Some(v) = params.check_access {
        body.insert("checkAccess".to_string(), Value::Bool(v));
    }
    if let Some(v) = params.check_filename {
        body.insert("checkFilename".to_string(), Value::String(v));
    }
    if let Some(v) = params.max_delete {
        body.insert("maxDelete".to_string(), Value::Number(v.into()));
    }
    if let Some(v) = params.force {
        body.insert("force".to_string(), Value::Bool(v));
    }
    if let Some(v) = params.check_sync {
        body.insert("checkSync".to_string(), Value::String(v));
    }
    if let Some(v) = params.filters_file {
        body.insert("filtersFile".to_string(), Value::String(v));
    }
    if let Some(v) = params.ignore_listing_checksum {
        body.insert("ignoreListingChecksum".to_string(), Value::Bool(v));
    }
    if let Some(v) = params.resilient {
        body.insert("resilient".to_string(), Value::Bool(v));
    }
    if let Some(v) = params.workdir {
        body.insert("workDir".to_string(), Value::String(v));
    }
    if let Some(v) = params.backupdir1 {
        body.insert("backupDir1".to_string(), Value::String(v));
    }
    if let Some(v) = params.backupdir2 {
        body.insert("backupDir2".to_string(), Value::String(v));
    }

    let config_map = merge_options(params.bisync_options, params.backend_options);
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
            "create_empty_src_dirs": params.create_empty_src_dirs,
            "delete_empty_src_dirs": params.delete_empty_src_dirs,
            "move_options": params.move_options.as_ref().map(|o| o.keys().collect::<Vec<_>>()),
            "filters": params.filter_options.as_ref().map(|f| f.keys().collect::<Vec<_>>()),
            "backend_options": params.backend_options.as_ref().map(|b| b.keys().collect::<Vec<_>>())
        })),
    );
    let mut body = Map::new();
    body.insert("srcFs".to_string(), Value::String(params.source.clone()));
    body.insert("dstFs".to_string(), Value::String(params.dest.clone()));
    if params.create_empty_src_dirs {
        body.insert("createEmptySrcDirs".to_string(), Value::Bool(true));
    }
    if params.delete_empty_src_dirs {
        body.insert("deleteEmptySrcDirs".to_string(), Value::Bool(true));
    }
    body.insert("_async".to_string(), Value::Bool(true));

    let config_map = merge_options(params.move_options, params.backend_options);
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
