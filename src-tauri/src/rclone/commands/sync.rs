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
}

/// Start a sync operation
#[tauri::command]
pub async fn start_sync(
    app: AppHandle,
    params: SyncParams,
    state: State<'_, RcloneState>,
) -> Result<u64, String> {
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
            "filters": params.filter_options.as_ref().map(|f| f.keys().collect::<Vec<_>>())
        })),
    )
    .await;

    // Construct the JSON body
    let mut body = Map::new();
    body.insert("srcFs".to_string(), Value::String(params.source.clone()));
    body.insert("dstFs".to_string(), Value::String(params.dest.clone()));
    body.insert(
        "createEmptySrcDirs".to_string(),
        Value::Bool(params.create_empty_src_dirs),
    );
    body.insert("_async".to_string(), Value::Bool(true));

    if let Some(opts) = params.sync_options {
        body.insert(
            "_config".to_string(),
            Value::Object(opts.into_iter().collect()),
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
}

#[tauri::command]
pub async fn start_copy(
    app: AppHandle,
    params: CopyParams,
    state: State<'_, RcloneState>,
) -> Result<u64, String> {
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
            "filters": params.filter_options.as_ref().map(|f| f.keys().collect::<Vec<_>>())
        })),
    )
    .await;

    let mut body = Map::new();
    body.insert("srcFs".to_string(), Value::String(params.source.clone()));
    body.insert("dstFs".to_string(), Value::String(params.dest.clone()));
    body.insert(
        "createEmptySrcDirs".to_string(),
        Value::Bool(params.create_empty_src_dirs),
    );
    body.insert("_async".to_string(), Value::Bool(true));

    if let Some(opts) = params.copy_options {
        body.insert(
            "_config".to_string(),
            Value::Object(opts.into_iter().collect()),
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
}

#[tauri::command]
pub async fn start_bisync(
    app: AppHandle,
    params: BisyncParams,
    state: State<'_, RcloneState>,
) -> Result<u64, String> {
    log_operation(
        LogLevel::Info,
        Some(params.remote_name.clone()),
        Some("Bisync operation".to_string()),
        format!(
            "Starting bisync between {} and {}",
            params.source, params.dest
        ),
        Some(json!({
            "source": params.source,
            "destination": params.dest,
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
            "filters": params.filter_options.as_ref().map(|f| f.keys().collect::<Vec<_>>())
        })),
    )
    .await;

    // Construct the JSON body
    let mut body = Map::new();
    body.insert("srcFs".to_string(), Value::String(params.source.clone()));
    body.insert("dstFs".to_string(), Value::String(params.dest.clone()));
    body.insert("_async".to_string(), Value::Bool(true));
    body.insert("resync".to_string(), Value::Bool(params.resync));
    body.insert(
        "createEmptySrcDirs".to_string(),
        Value::Bool(params.create_empty_src_dirs.unwrap_or(false)),
    );
    body.insert(
        "noCleanup".to_string(),
        Value::Bool(params.no_cleanup.unwrap_or(false)),
    );
    body.insert(
        "dryRun".to_string(),
        Value::Bool(params.dry_run.unwrap_or(false)),
    );
    body.insert(
        "checkAccess".to_string(),
        Value::Bool(params.check_access.unwrap_or(false)),
    );
    body.insert(
        "checkFilename".to_string(),
        params
            .check_filename
            .as_ref()
            .map_or(Value::Null, |s| Value::String(s.clone())),
    );
    body.insert(
        "maxDelete".to_string(),
        Value::Number(params.max_delete.unwrap_or(0).into()),
    );
    body.insert(
        "force".to_string(),
        Value::Bool(params.force.unwrap_or(false)),
    );
    body.insert(
        "checkSync".to_string(),
        params
            .check_sync
            .as_ref()
            .map_or(Value::Null, |s| Value::String(s.clone())),
    );
    body.insert(
        "filtersFile".to_string(),
        params
            .filters_file
            .as_ref()
            .map_or(Value::Null, |s| Value::String(s.clone())),
    );
    body.insert(
        "ignoreListingChecksum".to_string(),
        Value::Bool(params.ignore_listing_checksum.unwrap_or(false)),
    );
    body.insert(
        "resilient".to_string(),
        Value::Bool(params.resilient.unwrap_or(false)),
    );
    body.insert(
        "workDir".to_string(),
        params
            .workdir
            .as_ref()
            .map_or(Value::Null, |s| Value::String(s.clone())),
    );
    body.insert(
        "backupDir1".to_string(),
        params
            .backupdir1
            .as_ref()
            .map_or(Value::Null, |s| Value::String(s.clone())),
    );
    body.insert(
        "backupDir2".to_string(),
        params
            .backupdir2
            .as_ref()
            .map_or(Value::Null, |s| Value::String(s.clone())),
    );
    body.insert(
        "noCleanup".to_string(),
        Value::Bool(params.no_cleanup.unwrap_or(false)),
    );

    if let Some(opts) = params.bisync_options {
        body.insert(
            "_config".to_string(),
            Value::Object(opts.into_iter().collect()),
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
}

#[tauri::command]
pub async fn start_move(
    app: AppHandle,
    params: MoveParams,
    state: State<'_, RcloneState>,
) -> Result<u64, String> {
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
            "filters": params.filter_options.as_ref().map(|f| f.keys().collect::<Vec<_>>())
        })),
    )
    .await;
    let mut body = Map::new();
    body.insert("srcFs".to_string(), Value::String(params.source.clone()));
    body.insert("dstFs".to_string(), Value::String(params.dest.clone()));
    body.insert(
        "createEmptySrcDirs".to_string(),
        Value::Bool(params.create_empty_src_dirs),
    );
    body.insert(
        "deleteEmptySrcDirs".to_string(),
        Value::Bool(params.delete_empty_src_dirs),
    );
    body.insert("_async".to_string(), Value::Bool(true));
    if let Some(opts) = params.move_options {
        body.insert(
            "_config".to_string(),
            Value::Object(opts.into_iter().collect()),
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
