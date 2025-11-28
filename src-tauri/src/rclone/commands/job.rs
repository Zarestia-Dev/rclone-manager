// Add these to job.rs

use chrono::Utc;
use log::{debug, error, info, warn};
use serde_json::{Value, json};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::time::sleep;

use crate::{
    RcloneState,
    core::scheduler::engine::get_next_run,
    rclone::state::{engine::ENGINE_STATE, scheduled_tasks::ScheduledTasksCache},
    utils::{
        logging::log::log_operation,
        rclone::endpoints::{EndpointHelper, core, job},
        types::{
            all_types::{JobCache, JobInfo, JobStatus, LogLevel},
            events::{JOB_CACHE_CHANGED, SCHEDULED_TASK_STOPPED},
        },
    },
};

use super::system::RcloneError;

/// Metadata required to start and track a job
#[derive(Debug, Clone)]
pub struct JobMetadata {
    pub remote_name: String,
    pub job_type: String,       // e.g., "sync", "mount", "serve"
    pub operation_name: String, // e.g., "Sync operation", "Start serve"
    pub source: String,
    pub destination: String,
}

/// Submit a LONG-RUNNING job (sync, copy, move, bisync)
/// Returns jobid immediately, monitors in background
pub async fn submit_job(
    app: AppHandle,
    client: reqwest::Client,
    url: String,
    payload: Value,
    metadata: JobMetadata,
) -> Result<(u64, Value), String> {
    let (jobid, response_json) = send_job_request(client.clone(), url, payload, &metadata).await?;

    // Add to cache
    let job_cache = app.state::<JobCache>();
    add_job_to_cache(job_cache, jobid, &metadata).await;

    // Monitor in background - don't wait
    let app_clone = app.clone();
    let meta_clone = metadata.clone();
    let client_clone = client.clone();

    tauri::async_runtime::spawn(async move {
        let _ = monitor_job(
            meta_clone.remote_name,
            &meta_clone.operation_name,
            jobid,
            app_clone,
            client_clone,
        )
        .await;
    });

    let _ = app.emit(JOB_CACHE_CHANGED, jobid);
    Ok((jobid, response_json))
}

/// Submit a SHORT-LIVED job (mount, serve)
/// Waits for completion and returns result
pub async fn submit_job_and_wait(
    app: AppHandle,
    client: reqwest::Client,
    url: String,
    payload: Value,
    metadata: JobMetadata,
) -> Result<(u64, Value), String> {
    let (jobid, response_json) = send_job_request(client.clone(), url, payload, &metadata).await?;

    // Add to cache
    let job_cache = app.state::<JobCache>();
    add_job_to_cache(job_cache, jobid, &metadata).await;

    // Monitor and WAIT for completion
    let result = monitor_job(
        metadata.remote_name.clone(),
        &metadata.operation_name,
        jobid,
        app.clone(),
        client,
    )
    .await;

    let _ = app.emit(JOB_CACHE_CHANGED, jobid);

    // Return error if job failed
    result.map_err(|e| e.to_string())?;

    Ok((jobid, response_json))
}

/// Internal: Send job request and parse response
async fn send_job_request(
    client: reqwest::Client,
    url: String,
    payload: Value,
    metadata: &JobMetadata,
) -> Result<(u64, Value), String> {
    let response = client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = response.status();
    let body_text = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = format!("HTTP {status}: {body_text}");
        log_operation(
            LogLevel::Error,
            Some(metadata.remote_name.clone()),
            Some(metadata.operation_name.clone()),
            format!("Failed to start {}: {error}", metadata.job_type),
            Some(json!({"response": body_text})),
        );
        return Err(error);
    }

    let response_json: Value =
        serde_json::from_str(&body_text).map_err(|e| format!("Failed to parse response: {e}"))?;

    // Extract Job ID (handles both numeric jobid and string id)
    let jobid = if let Some(id) = response_json.get("jobid").and_then(|v| v.as_u64()) {
        id
    } else if let Some(id_str) = response_json.get("id").and_then(|v| v.as_str()) {
        id_str.parse::<u64>().unwrap_or(0)
    } else {
        0
    };

    log_operation(
        LogLevel::Info,
        Some(metadata.remote_name.clone()),
        Some(metadata.operation_name.clone()),
        format!("{} started with ID {}", metadata.operation_name, jobid),
        Some(json!({"jobid": jobid})),
    );

    Ok((jobid, response_json))
}

/// Internal: Add job to cache
async fn add_job_to_cache(job_cache: State<'_, JobCache>, jobid: u64, metadata: &JobMetadata) {
    job_cache
        .add_job(JobInfo {
            jobid,
            job_type: metadata.job_type.clone(),
            remote_name: metadata.remote_name.clone(),
            source: metadata.source.clone(),
            destination: metadata.destination.clone(),
            start_time: Utc::now(),
            status: JobStatus::Running,
            stats: None,
            group: format!("{}/{}", metadata.job_type, jobid),
        })
        .await;
}

pub async fn monitor_job(
    remote_name: String,
    operation: &str,
    jobid: u64,
    app: AppHandle,
    client: reqwest::Client,
) -> Result<(), RcloneError> {
    let job_cache = app.state::<JobCache>();
    let scheduled_tasks_cache = app.state::<ScheduledTasksCache>();

    let job_status_url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, job::STATUS);
    let stats_url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, core::STATS);

    info!("Starting monitoring for job {jobid} ({operation})");

    let mut consecutive_errors = 0;
    const MAX_CONSECUTIVE_ERRORS: u8 = 3;

    loop {
        // Check if job is still in cache and not stopped
        match job_cache.get_job(jobid).await {
            Some(job) if job.status == JobStatus::Stopped => {
                debug!("Job {jobid} was stopped, ending monitoring");
                return Ok(());
            }
            Some(_) => {} // Continue monitoring
            _ => {
                debug!("Job {jobid} removed from cache, stopping monitoring");
                return Ok(());
            }
        }

        // Get job status and stats in parallel
        let status_fut = client
            .post(&job_status_url)
            .json(&json!({ "jobid": jobid }))
            .send();

        let stats_fut = client
            .post(&stats_url)
            .json(&json!({ "jobid": jobid }))
            .send();

        match tokio::try_join!(status_fut, stats_fut) {
            Ok((status_response, stats_response)) => {
                consecutive_errors = 0;

                let status_body = status_response.text().await?;
                let stats_body = stats_response.text().await?;

                // Process stats
                if let Ok(stats) = serde_json::from_str::<Value>(&stats_body) {
                    job_cache
                        .update_job_stats(jobid, stats)
                        .await
                        .map_err(RcloneError::JobError)?;
                }

                // Process status
                match serde_json::from_str::<Value>(&status_body) {
                    Ok(job_status)
                        if job_status
                            .get("finished")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false) =>
                    {
                        return handle_job_completion(
                            jobid,
                            &remote_name,
                            operation,
                            job_status,
                            &app,
                            job_cache,
                            scheduled_tasks_cache,
                        )
                        .await;
                    }
                    _ => {}
                }
            }
            Err(e) => {
                consecutive_errors += 1;
                warn!(
                    "Error monitoring job {jobid} (attempt {consecutive_errors}/{MAX_CONSECUTIVE_ERRORS}): {e}",
                );

                if consecutive_errors >= MAX_CONSECUTIVE_ERRORS {
                    error!("Too many errors monitoring job {jobid}, giving up");
                    job_cache
                        .complete_job(jobid, false)
                        .await
                        .map_err(RcloneError::JobError)?;
                    app.emit(JOB_CACHE_CHANGED, jobid)
                        .map_err(|e| RcloneError::JobError(e.to_string()))?;
                    return Err(RcloneError::JobError(format!(
                        "Too many errors monitoring job {jobid}: {e}"
                    )));
                }
            }
        }

        sleep(Duration::from_secs(1)).await;
    }
}

pub async fn handle_job_completion(
    jobid: u64,
    remote_name: &str,
    operation: &str,
    job_status: Value,
    app: &AppHandle,
    job_cache: State<'_, JobCache>,
    scheduled_tasks_cache: State<'_, ScheduledTasksCache>,
) -> Result<(), RcloneError> {
    let success = job_status
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let error_msg = job_status
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    let task = scheduled_tasks_cache.get_task_by_job_id(jobid).await;

    let next_run = if let Some(ref t) = task {
        get_next_run(&t.cron_expression).ok()
    } else {
        None
    };

    job_cache
        .complete_job(jobid, success)
        .await
        .map_err(RcloneError::JobError)?;

    if let Some(task) = task {
        info!(
            "Job {} was associated with scheduled task '{}', updating task status.",
            jobid, task.name
        );

        if success {
            scheduled_tasks_cache
                .update_task(&task.id, |t| {
                    t.mark_success();
                    t.next_run = next_run;
                })
                .await
                .map_err(RcloneError::JobError)?;
        } else {
            scheduled_tasks_cache
                .update_task(&task.id, |t| {
                    t.mark_failure(error_msg.clone());
                    t.next_run = next_run;
                })
                .await
                .map_err(RcloneError::JobError)?;
        }
    }

    app.emit(JOB_CACHE_CHANGED, jobid)
        .map_err(|e| RcloneError::JobError(e.to_string()))?;

    if !error_msg.is_empty() {
        log_operation(
            LogLevel::Error,
            Some(remote_name.to_string()),
            Some(operation.to_string()),
            format!("{operation} Job {jobid} failed: {error_msg}"),
            Some(json!({"jobid": jobid, "status": job_status})),
        );
        Err(RcloneError::JobError(error_msg))
    } else if success {
        log_operation(
            LogLevel::Info,
            Some(remote_name.to_string()),
            Some(operation.to_string()),
            format!("{operation} Job {jobid} completed successfully"),
            Some(json!({"jobid": jobid, "status": job_status})),
        );
        Ok(())
    } else {
        log_operation(
            LogLevel::Warn,
            Some(remote_name.to_string()),
            Some(operation.to_string()),
            format!("{operation} Job {jobid} completed without success but no error message"),
            Some(json!({"jobid": jobid, "status": job_status})),
        );
        Err(RcloneError::JobError(
            "Job completed without success".to_string(),
        ))
    }
}

/// Stop a running job
#[tauri::command]
pub async fn stop_job(
    app: AppHandle,
    job_cache: State<'_, JobCache>,
    scheduled_tasks_cache: State<'_, ScheduledTasksCache>,
    jobid: u64,
    remote_name: String,
    state: State<'_, RcloneState>,
) -> Result<(), String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, job::STOP);
    let payload = json!({ "jobid": jobid });

    let response = state
        .client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    let job_stopped = if status.is_success() {
        true
    } else if status.as_u16() == 500 && body.contains("\"job not found\"") {
        log_operation(
            LogLevel::Warn,
            Some(remote_name.clone()),
            Some("Stop job".to_string()),
            format!("Job {jobid} not found in rclone, marking as stopped"),
            None,
        );
        warn!("Job {jobid} not found in rclone, marking as stopped.");
        true
    } else {
        let error = format!("HTTP {status}: {body}");
        error!("❌ Failed to stop job {jobid}: {error}");
        return Err(error);
    };

    if job_stopped {
        job_cache.stop_job(jobid).await.map_err(|e| e.to_string())?;

        if let Some(task) = scheduled_tasks_cache.get_task_by_job_id(jobid).await {
            info!(
                "🛑 Job {} was associated with scheduled task '{}', marking task as stopped",
                jobid, task.name
            );

            scheduled_tasks_cache
                .update_task(&task.id, |t| {
                    t.mark_stopped();
                })
                .await
                .map_err(|e| format!("Failed to update task state: {}", e))?;

            let _ = app.emit(
                SCHEDULED_TASK_STOPPED,
                serde_json::json!({
                    "taskId": task.id,
                    "jobId": jobid,
                }),
            );
        }

        log_operation(
            LogLevel::Info,
            Some(remote_name.clone()),
            Some("Stop job".to_string()),
            format!("Job {jobid} stopped successfully"),
            None,
        );

        app.emit(JOB_CACHE_CHANGED, jobid)
            .map_err(|e| format!("Failed to emit event: {e}"))?;

        info!("✅ Stopped job {jobid}");
    }

    Ok(())
}
