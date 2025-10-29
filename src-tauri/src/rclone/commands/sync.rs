use chrono::Utc;
use log::debug;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};

use crate::{
    RcloneState,
    rclone::state::{ENGINE_STATE, JOB_CACHE},
    utils::{
        logging::log::log_operation,
        rclone::endpoints::{EndpointHelper, sync},
        types::all_types::{JobInfo, JobResponse, JobStatus, LogLevel},
    },
};

use super::job::monitor_job;

/// Parameters for starting a sync operation
#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct SyncParams {
    pub remote_name: String,
    pub source: String,
    pub dest: String,
    pub create_empty_src_dirs: bool,
    pub sync_options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub backend_options: Option<HashMap<String, Value>>,
}

/// Start a sync operation
#[tauri::command]
pub async fn start_sync(
    app: AppHandle,
    params: SyncParams,
    state: State<'_, RcloneState>,
) -> Result<u64, String> {
    debug!("Received start_sync params: {params:#?}");
    log_operation(
        LogLevel::Info,
        Some(params.remote_name.clone()),
        Some("Sync operation".to_string()),
        format!("Starting sync from {} to {}", params.source, params.dest),
        Some(json!({
            "source": params.source,
            "destination": params.dest,
            "create_empty_src_dirs": params.create_empty_src_dirs,
            "sync_options": params.sync_options.as_ref().map(|o| o.keys().collect::<Vec<_>>()),
            "filters": params.filter_options.as_ref().map(|f| f.keys().collect::<Vec<_>>()),
            "backend_options": params.backend_options.as_ref().map(|b| b.keys().collect::<Vec<_>>())
        })),
    )
    .await;

    // Construct the JSON body
    let mut body = Map::new();
    body.insert("srcFs".to_string(), Value::String(params.source.clone()));
    body.insert("dstFs".to_string(), Value::String(params.dest.clone()));
    // Only include createEmptySrcDirs when true to avoid sending unnecessary false values
    if params.create_empty_src_dirs {
        body.insert("createEmptySrcDirs".to_string(), Value::Bool(true));
    }
    body.insert("_async".to_string(), Value::Bool(true));

    let config_map = match (params.sync_options, params.backend_options) {
        (Some(mut opts), Some(backend_opts)) => {
            opts.extend(backend_opts);
            opts
        }
        (Some(opts), None) => opts,
        (None, Some(backend_opts)) => backend_opts,
        (None, None) => HashMap::new(),
    };
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

    debug!("Sync request body: {body:#?}");

    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, sync::SYNC);

    let response = state
        .client
        .post(&url)
        .json(&Value::Object(body)) // send JSON body
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = response.status();
    let body_text = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = format!("HTTP {status}: {body_text}");
        log_operation(
            LogLevel::Error,
            Some(params.remote_name.clone()),
            Some("Sync operation".to_string()),
            "Failed to start sync job".to_string(),
            Some(json!({"response": body_text})),
        )
        .await;
        return Err(error);
    }

    let job: JobResponse =
        serde_json::from_str(&body_text).map_err(|e| format!("Failed to parse response: {e}"))?;

    log_operation(
        LogLevel::Info,
        Some(params.remote_name.clone()),
        Some("Sync operation".to_string()),
        format!("Sync job started with ID {}", job.jobid),
        Some(json!({"jobid": job.jobid})),
    )
    .await;

    let jobid = job.jobid;
    JOB_CACHE
        .add_job(JobInfo {
            jobid,
            job_type: "sync".to_string(),
            remote_name: params.remote_name.clone(),
            source: params.source.clone(),
            destination: params.dest.clone(),
            start_time: Utc::now(),
            status: JobStatus::Running,
            stats: None,
            group: format!("job/{jobid}"),
        })
        .await;

    // Start monitoring the job
    let app_clone = app.clone();
    let client = state.client.clone();
    let remote_name_clone = params.remote_name.clone();
    tauri::async_runtime::spawn(async move {
        let _ = monitor_job(
            remote_name_clone,
            "Sync operation",
            jobid,
            app_clone,
            client,
        )
        .await;
    });

    app.emit("job_cache_changed", jobid)
        .map_err(|e| format!("Failed to emit event: {e}"))?;
    Ok(job.jobid)
}

/// Start a copy operation
#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct CopyParams {
    pub remote_name: String,
    pub source: String,
    pub dest: String,
    pub create_empty_src_dirs: bool,
    pub copy_options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub backend_options: Option<HashMap<String, Value>>,
}

#[tauri::command]
pub async fn start_copy(
    app: AppHandle,
    params: CopyParams,
    state: State<'_, RcloneState>,
) -> Result<u64, String> {
    debug!("Received start_copy params: {params:#?}");
    log_operation(
        LogLevel::Info,
        Some(params.remote_name.clone()),
        Some("Copy operation".to_string()),
        format!("Starting copy from {} to {}", params.source, params.dest),
        Some(json!({
            "source": params.source,
            "destination": params.dest,
            "create_empty_src_dirs": params.create_empty_src_dirs,
            "copy_options": params.copy_options.as_ref().map(|o| o.keys().collect::<Vec<_>>()),
            "filters": params.filter_options.as_ref().map(|f| f.keys().collect::<Vec<_>>()),
            "backend_options": params.backend_options.as_ref().map(|b| b.keys().collect::<Vec<_>>())
        })),
    )
    .await;

    let mut body = Map::new();
    body.insert("srcFs".to_string(), Value::String(params.source.clone()));
    body.insert("dstFs".to_string(), Value::String(params.dest.clone()));
    // Only include createEmptySrcDirs when true
    if params.create_empty_src_dirs {
        body.insert("createEmptySrcDirs".to_string(), Value::Bool(true));
    }
    body.insert("_async".to_string(), Value::Bool(true));

    let config_map = match (params.copy_options, params.backend_options) {
        (Some(mut opts), Some(backend_opts)) => {
            opts.extend(backend_opts);
            opts
        }
        (Some(opts), None) => opts,
        (None, Some(backend_opts)) => backend_opts,
        (None, None) => HashMap::new(),
    };
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

    debug!("Copy request body: {body:#?}");

    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, sync::COPY);

    let response = state
        .client
        .post(&url)
        .json(&Value::Object(body)) // send JSON body
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = format!("HTTP {status}: {body}");
        log_operation(
            LogLevel::Error,
            Some(params.remote_name.clone()),
            Some("Copy operation".to_string()),
            "Failed to start copy job".to_string(),
            Some(json!({"response": body})),
        )
        .await;
        log::error!("❌ Failed to start copy job: {error}");
        return Err(error);
    }

    let job: JobResponse =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse response: {e}"))?;

    let jobid = job.jobid;
    JOB_CACHE
        .add_job(JobInfo {
            jobid,
            job_type: "copy".to_string(),
            remote_name: params.remote_name.clone(),
            source: params.source.clone(),
            destination: params.dest.clone(),
            start_time: Utc::now(),
            status: JobStatus::Running,
            stats: None,
            group: format!("job/{jobid}"),
        })
        .await;
    // Start monitoring the job
    let app_clone = app.clone();
    let client = state.client.clone();
    let remote_name_clone = params.remote_name.clone();
    tokio::spawn(async move {
        let _ = monitor_job(
            remote_name_clone,
            "Copy operation",
            jobid,
            app_clone,
            client,
        )
        .await;
    });

    log_operation(
        LogLevel::Info,
        Some(params.remote_name.clone()),
        Some("Copy operation".to_string()),
        format!("Copy job started with ID {jobid}"),
        Some(json!({"jobid": jobid})),
    )
    .await;

    app.emit("job_cache_changed", jobid)
        .map_err(|e| format!("Failed to emit event: {e}"))?;
    Ok(job.jobid)
}

/// Start a bisync operation
#[derive(Debug, serde::Deserialize, serde::Serialize)]
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

#[tauri::command]
pub async fn start_bisync(
    app: AppHandle,
    params: BisyncParams,
    state: State<'_, RcloneState>,
) -> Result<u64, String> {
    debug!("Received start_bisync params: {params:#?}");
    log_operation(
        LogLevel::Info,
        Some(params.remote_name.clone()),
        Some("Bisync operation".to_string()),
        format!(
            "Starting bisync between {} and {}",
            params.source, params.dest
        ),
        Some(json!({
            "source (path1)": params.source,
            "destination (path2)": params.dest,
            "dry_run": params.dry_run,
            "resync": params.resync,
            "check_access": params.check_access,
            "check_filename": params.check_filename,
            "max_delete": params.max_delete,
            "force": params.force,
            "check_sync": params.check_sync,
            "create_empty_src_dirs": params.create_empty_src_dirs,
            "remove_empty_dirs": params.remove_empty_dirs,
            "filters_file": params.filters_file,
            "ignore_listing_checksum": params.ignore_listing_checksum,
            "resilient": params.resilient,
            "workdir": params.workdir,
            "backupdir1": params.backupdir1,
            "backupdir2": params.backupdir2,
            "no_cleanup": params.no_cleanup,
            "bisync_options": params.bisync_options.as_ref().map(|o| o.keys().collect::<Vec<_>>()),
            "filters": params.filter_options.as_ref().map(|f| f.keys().collect::<Vec<_>>()),
            "backend_options": params.backend_options.as_ref().map(|b| b.keys().collect::<Vec<_>>())
        })),
    )
    .await;

    // Construct the JSON body
    let mut body = Map::new();
    body.insert("path1".to_string(), Value::String(params.source.clone()));
    body.insert("path2".to_string(), Value::String(params.dest.clone()));
    body.insert("_async".to_string(), Value::Bool(true));

    // Required/non-optional boolean (resync) remains explicit
    body.insert("resync".to_string(), Value::Bool(params.resync));

    // Insert optional fields only when provided by the caller.
    if let Some(create) = params.create_empty_src_dirs {
        body.insert("createEmptySrcDirs".to_string(), Value::Bool(create));
    }

    if let Some(no_cleanup) = params.no_cleanup {
        body.insert("noCleanup".to_string(), Value::Bool(no_cleanup));
    }

    if let Some(dry_run) = params.dry_run {
        body.insert("dryRun".to_string(), Value::Bool(dry_run));
    }

    if let Some(check_access) = params.check_access {
        body.insert("checkAccess".to_string(), Value::Bool(check_access));
    }

    if let Some(check_filename) = params.check_filename {
        body.insert("checkFilename".to_string(), Value::String(check_filename));
    }

    if let Some(max_delete) = params.max_delete {
        body.insert("maxDelete".to_string(), Value::Number(max_delete.into()));
    }

    if let Some(force) = params.force {
        body.insert("force".to_string(), Value::Bool(force));
    }

    if let Some(check_sync) = params.check_sync {
        body.insert("checkSync".to_string(), Value::String(check_sync));
    }

    if let Some(filters_file) = params.filters_file {
        body.insert("filtersFile".to_string(), Value::String(filters_file));
    }

    if let Some(ignore_listing_checksum) = params.ignore_listing_checksum {
        body.insert(
            "ignoreListingChecksum".to_string(),
            Value::Bool(ignore_listing_checksum),
        );
    }

    if let Some(resilient) = params.resilient {
        body.insert("resilient".to_string(), Value::Bool(resilient));
    }

    if let Some(workdir) = params.workdir {
        body.insert("workDir".to_string(), Value::String(workdir));
    }

    if let Some(backupdir1) = params.backupdir1 {
        body.insert("backupDir1".to_string(), Value::String(backupdir1));
    }

    if let Some(backupdir2) = params.backupdir2 {
        body.insert("backupDir2".to_string(), Value::String(backupdir2));
    }

    let config_map = match (params.bisync_options, params.backend_options) {
        (Some(mut opts), Some(backend_opts)) => {
            opts.extend(backend_opts);
            opts
        }
        (Some(opts), None) => opts,
        (None, Some(backend_opts)) => backend_opts,
        (None, None) => HashMap::new(),
    };
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

    debug!("Bisync request body: {body:#?}");

    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, sync::BISYNC);

    let response = state
        .client
        .post(&url)
        .json(&Value::Object(body))
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = response.status();
    let body_text = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = format!("HTTP {status}: {body_text}");
        log_operation(
            LogLevel::Error,
            Some(params.remote_name.clone()),
            Some("Bisync operation".to_string()),
            "Failed to start bisync job".to_string(),
            Some(json!({"response": body_text})),
        )
        .await;
        return Err(error);
    }

    let job: JobResponse =
        serde_json::from_str(&body_text).map_err(|e| format!("Failed to parse response: {e}"))?;

    log_operation(
        LogLevel::Info,
        Some(params.remote_name.clone()),
        Some("Bisync operation".to_string()),
        format!("Bisync job started with ID {}", job.jobid),
        Some(json!({"jobid": job.jobid})),
    )
    .await;

    let jobid = job.jobid;
    JOB_CACHE
        .add_job(JobInfo {
            jobid,
            job_type: "bisync".to_string(),
            remote_name: params.remote_name.clone(),
            source: params.source.clone(),
            destination: params.dest.clone(),
            start_time: Utc::now(),
            status: JobStatus::Running,
            stats: None,
            group: format!("job/{jobid}"),
        })
        .await;

    // Start monitoring the job
    let app_clone = app.clone();
    let client = state.client.clone();
    let remote_name_clone = params.remote_name.clone();
    tauri::async_runtime::spawn(async move {
        let _ = monitor_job(
            remote_name_clone,
            "Bisync operation",
            jobid,
            app_clone,
            client,
        )
        .await;
    });

    app.emit("job_cache_changed", jobid)
        .map_err(|e| format!("Failed to emit event: {e}"))?;
    Ok(job.jobid)
}

/// Start a move operation
#[derive(Debug, serde::Deserialize, serde::Serialize)]
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

#[tauri::command]
pub async fn start_move(
    app: AppHandle,
    params: MoveParams,
    state: State<'_, RcloneState>,
) -> Result<u64, String> {
    debug!("Received start_move params: {params:#?}");
    log_operation(
        LogLevel::Info,
        Some(params.remote_name.clone()),
        Some("Move operation".to_string()),
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
    )
    .await;
    let mut body = Map::new();
    body.insert("srcFs".to_string(), Value::String(params.source.clone()));
    body.insert("dstFs".to_string(), Value::String(params.dest.clone()));
    // Include optional booleans only when true
    if params.create_empty_src_dirs {
        body.insert("createEmptySrcDirs".to_string(), Value::Bool(true));
    }
    if params.delete_empty_src_dirs {
        body.insert("deleteEmptySrcDirs".to_string(), Value::Bool(true));
    }
    body.insert("_async".to_string(), Value::Bool(true));

    let config_map = match (params.move_options, params.backend_options) {
        (Some(mut opts), Some(backend_opts)) => {
            opts.extend(backend_opts);
            opts
        }
        (Some(opts), None) => opts,
        (None, Some(backend_opts)) => backend_opts,
        (None, None) => HashMap::new(),
    };
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
    debug!("Move request body: {body:#?}");
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, sync::MOVE);
    let response = state
        .client
        .post(&url)
        .json(&Value::Object(body)) // send JSON body
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let error = format!("HTTP {status}: {body}");
        log_operation(
            LogLevel::Error,
            Some(params.remote_name.clone()),
            Some("Move operation".to_string()),
            "Failed to start move job".to_string(),
            Some(json!({"response": body})),
        )
        .await;
        return Err(error);
    }
    let job: JobResponse =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse response: {e}"))?;
    let jobid = job.jobid;
    JOB_CACHE
        .add_job(JobInfo {
            jobid,
            job_type: "move".to_string(),
            remote_name: params.remote_name.clone(),
            source: params.source.clone(),
            destination: params.dest.clone(),
            start_time: Utc::now(),
            status: JobStatus::Running,
            stats: None,
            group: format!("job/{jobid}"),
        })
        .await;
    // Start monitoring the job
    let app_clone = app.clone();
    let client = state.client.clone();
    let remote_name_clone = params.remote_name.clone();
    tauri::async_runtime::spawn(async move {
        let _ = monitor_job(
            remote_name_clone,
            "Move operation",
            jobid,
            app_clone,
            client,
        )
        .await;
    });
    log_operation(
        LogLevel::Info,
        Some(params.remote_name.clone()),
        Some("Move operation".to_string()),
        format!("Move job started with ID {jobid}"),
        Some(json!({"jobid": jobid})),
    )
    .await;
    app.emit("job_cache_changed", jobid)
        .map_err(|e| format!("Failed to emit event: {e}"))?;
    Ok(job.jobid)
}
