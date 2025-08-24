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
    pub bisync_options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub resync: bool,
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
            "path1": params.source,
            "path2": params.dest,
            "bisync_options": params.bisync_options.as_ref().map(|o| o.keys().collect::<Vec<_>>()),
            "filters": params.filter_options.as_ref().map(|f| f.keys().collect::<Vec<_>>()),
            "resync": params.resync
        })),
    )
    .await;

    // Construct the JSON body
    let mut body = Map::new();
    body.insert("path1".to_string(), Value::String(params.source.clone()));
    body.insert("path2".to_string(), Value::String(params.dest.clone()));
    body.insert("_async".to_string(), Value::Bool(true));
    body.insert("resync".to_string(), Value::Bool(params.resync));

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
