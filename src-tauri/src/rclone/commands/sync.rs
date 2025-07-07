use chrono::Utc;
use log::debug;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};

use crate::{
    RcloneState,
    rclone::state::{ENGINE_STATE, JOB_CACHE},
    utils::{
        log::log_operation,
        rclone::endpoints::{EndpointHelper, sync},
        types::{JobInfo, JobResponse, JobStatus, LogLevel},
    },
};

use super::job::monitor_job;

/// Start a sync operation
#[tauri::command]
pub async fn start_sync(
    app: AppHandle,
    remote_name: String,
    source: String,
    dest: String,
    sync_options: Option<HashMap<String, Value>>,
    filter_options: Option<HashMap<String, Value>>,
    state: State<'_, RcloneState>,
) -> Result<u64, String> {
    log_operation(
        LogLevel::Info,
        Some(remote_name.clone()),
        Some("Sync operation".to_string()),
        format!("Starting sync from {source} to {dest}"),
        Some(json!({
            "source": source,
            "destination": dest,
            "sync_options": sync_options.as_ref().map(|o| o.keys().collect::<Vec<_>>()),
            "filters": filter_options.as_ref().map(|f| f.keys().collect::<Vec<_>>())
        })),
    )
    .await;

    // Construct the JSON body
    let mut body = Map::new();
    body.insert("srcFs".to_string(), Value::String(source.clone()));
    body.insert("dstFs".to_string(), Value::String(dest.clone()));
    body.insert("_async".to_string(), Value::Bool(true));

    if let Some(opts) = sync_options {
        body.insert(
            "_config".to_string(),
            Value::Object(opts.into_iter().collect()),
        );
    }

    if let Some(filters) = filter_options {
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
            Some(remote_name.clone()),
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
        Some(remote_name.clone()),
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
            remote_name: remote_name.clone(),
            source: source.clone(),
            destination: dest.clone(),
            start_time: Utc::now(),
            status: JobStatus::Running,
            stats: None,
            group: format!("job/{jobid}"),
        })
        .await;

    // Start monitoring the job
    let app_clone = app.clone();
    let client = state.client.clone();
    let remote_name_clone = remote_name.clone();
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
#[tauri::command]
pub async fn start_copy(
    app: AppHandle,
    remote_name: String,
    source: String,
    dest: String,
    copy_options: Option<HashMap<String, Value>>,
    filter_options: Option<HashMap<String, Value>>,
    state: State<'_, RcloneState>,
) -> Result<u64, String> {
    log_operation(
        LogLevel::Info,
        Some(remote_name.clone()),
        Some("Copy operation".to_string()),
        format!("Starting copy from {source} to {dest}"),
        Some(json!({
            "source": source,
            "destination": dest,
            "copy_options": copy_options.as_ref().map(|o| o.keys().collect::<Vec<_>>()),
            "filters": filter_options.as_ref().map(|f| f.keys().collect::<Vec<_>>())
        })),
    )
    .await;

    let mut body = Map::new();
    body.insert("srcFs".to_string(), Value::String(source.clone()));
    body.insert("dstFs".to_string(), Value::String(dest.clone()));
    body.insert("_async".to_string(), Value::Bool(true));

    if let Some(opts) = copy_options {
        body.insert(
            "_config".to_string(),
            Value::Object(opts.into_iter().collect()),
        );
    }

    if let Some(filters) = filter_options {
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
            Some(remote_name.clone()),
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
            remote_name: remote_name.clone(),
            source: source.clone(),
            destination: dest.clone(),
            start_time: Utc::now(),
            status: JobStatus::Running,
            stats: None,
            group: format!("job/{jobid}"),
        })
        .await;
    // Start monitoring the job
    let app_clone = app.clone();
    let client = state.client.clone();
    let remote_name_clone = remote_name.clone();
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
        Some(remote_name.clone()),
        Some("Copy operation".to_string()),
        format!("Copy job started with ID {jobid}"),
        Some(json!({"jobid": jobid})),
    )
    .await;

    app.emit("job_cache_changed", jobid)
        .map_err(|e| format!("Failed to emit event: {e}"))?;
    Ok(job.jobid)
}
