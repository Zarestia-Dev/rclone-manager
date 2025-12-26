use chrono::Utc;
use log::{debug, error, info, warn};
use serde_json::{Value, json};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::time::sleep;

use crate::{
    core::scheduler::engine::get_next_run,
    rclone::backend::BACKEND_MANAGER,
    rclone::state::scheduled_tasks::ScheduledTasksCache,
    utils::{
        logging::log::log_operation,
        rclone::endpoints::{EndpointHelper, core, job},
        types::{
            all_types::{JobCache, JobInfo, JobStatus, LogLevel, RcloneState},
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
    pub profile: Option<String>,
    /// Source UI that started this job (e.g., "nautilus", "dashboard", "scheduled")
    pub source_ui: Option<String>,
}

/// Submit a LONG-RUNNING job (sync, copy, move, bisync)
/// Returns jobid immediately, monitors in background
pub async fn submit_job(
    app: AppHandle,
    client: reqwest::Client,
    request: reqwest::RequestBuilder,
    payload: Value,
    metadata: JobMetadata,
) -> Result<(u64, Value), String> {
    let (jobid, response_json) = send_job_request(request, payload, &metadata).await?;

    // Determine active backend to associate job with
    let backend_name = if let Some(backend) = BACKEND_MANAGER.get_active().await {
        let backend = backend.read().await;
        // Add to cache
        add_job_to_cache(&backend.job_cache, jobid, &metadata, &backend.name).await;
        Some(backend.name.clone())
    } else {
        warn!(
            "Failed to get backend for remote '{}'. Job {} will not be cached.",
            metadata.remote_name, jobid
        );
        None
    };

    if let Some(bk_name) = backend_name {
        // Monitor in background - don't wait
        let app_clone = app.clone();
        let meta_clone = metadata.clone();
        let client_clone = client.clone();

        tauri::async_runtime::spawn(async move {
            let _ = monitor_job(
                bk_name,
                meta_clone.remote_name,
                &meta_clone.operation_name,
                jobid,
                app_clone,
                client_clone,
            )
            .await;
        });
    }

    let _ = app.emit(JOB_CACHE_CHANGED, jobid);
    Ok((jobid, response_json))
}

/// Submit a SHORT-LIVED job (mount, serve)
/// Waits for completion and returns result
pub async fn submit_job_and_wait(
    app: AppHandle,
    client: reqwest::Client,
    request: reqwest::RequestBuilder,
    payload: Value,
    metadata: JobMetadata,
) -> Result<(u64, Value), String> {
    let (jobid, response_json) = send_job_request(request, payload, &metadata).await?;

    // Determine active backend
    let backend_name = if let Some(backend) = BACKEND_MANAGER.get_active().await {
        let backend = backend.read().await;
        add_job_to_cache(&backend.job_cache, jobid, &metadata, &backend.name).await;
        Some(backend.name.clone())
    } else {
        warn!(
            "Failed to get backend for remote '{}'. Job {} will not be cached.",
            metadata.remote_name, jobid
        );
        None
    };

    if let Some(bk_name) = backend_name {
        // Monitor and WAIT for completion
        let result = monitor_job(
            bk_name,
            metadata.remote_name.clone(),
            &metadata.operation_name,
            jobid,
            app.clone(),
            client,
        )
        .await;

        // Return error if job failed
        result.map_err(|e| e.to_string())?;
    } else {
        warn!(
            "Not monitoring job {} because no backend context found.",
            jobid
        );
    }

    let _ = app.emit(JOB_CACHE_CHANGED, jobid);

    Ok((jobid, response_json))
}

/// Internal: Send job request and parse response
async fn send_job_request(
    client_builder: reqwest::RequestBuilder,
    payload: Value,
    metadata: &JobMetadata,
) -> Result<(u64, Value), String> {
    let response = client_builder
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

/// Internal: Add job to cache (takes reference to JobCache)
async fn add_job_to_cache(
    job_cache: &JobCache,
    jobid: u64,
    metadata: &JobMetadata,
    backend_name: &str,
) {
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
            profile: metadata.profile.clone(),
            source_ui: metadata.source_ui.clone(),
            backend_name: Some(backend_name.to_string()),
        })
        .await;
}

use crate::rclone::backend::types::RcloneBackend;

/// Poll a job until completion (for short-running operations without cache overhead)
pub async fn poll_job(
    jobid: u64,
    client: reqwest::Client,
    backend: RcloneBackend,
) -> Result<Value, String> {
    let api_url = backend.api_url();
    let job_status_url = EndpointHelper::build_url(&api_url, job::STATUS);
    let mut consecutive_errors = 0;
    const MAX_CONSECUTIVE_ERRORS: u8 = 3;

    loop {
        match backend
            .inject_auth(client.post(&job_status_url))
            .json(&json!({ "jobid": jobid }))
            .send()
            .await
        {
            Ok(response) => {
                let body = response.text().await.unwrap_or_default();
                match serde_json::from_str::<Value>(&body) {
                    Ok(job_status) => {
                        let finished = job_status
                            .get("finished")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);

                        if finished {
                            let success = job_status
                                .get("success")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);

                            if success {
                                return Ok(job_status
                                    .get("output")
                                    .cloned()
                                    .unwrap_or_else(|| json!({})));
                            } else {
                                let error = job_status
                                    .get("error")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("Operation failed")
                                    .to_string();
                                return Err(error);
                            }
                        }
                    }
                    Err(e) => warn!("Failed to parse job status: {e}"),
                }
            }
            Err(e) => {
                consecutive_errors += 1;
                if consecutive_errors >= MAX_CONSECUTIVE_ERRORS {
                    return Err(format!("Too many errors monitoring job: {e}"));
                }
                warn!("Error checking job status: {e}");
            }
        }
        sleep(Duration::from_millis(200)).await;
    }
}

// ============================================================================
// TAURI COMMANDS (MOVED FROM STATE)
// ============================================================================

#[tauri::command]
pub async fn get_jobs() -> Result<Vec<JobInfo>, String> {
    let backend = BACKEND_MANAGER
        .get_active()
        .await
        .ok_or("No active backend".to_string())?;
    let job_cache = &backend.read().await.job_cache;
    Ok(job_cache.get_jobs().await)
}

#[tauri::command]
pub async fn delete_job(jobid: u64) -> Result<(), String> {
    let backend = BACKEND_MANAGER
        .get_active()
        .await
        .ok_or("No active backend".to_string())?;
    let job_cache = &backend.read().await.job_cache;
    job_cache.delete_job(jobid).await
}

#[tauri::command]
pub async fn get_job_status(jobid: u64) -> Result<Option<JobInfo>, String> {
    let backend = BACKEND_MANAGER
        .get_active()
        .await
        .ok_or("No active backend".to_string())?;
    let job_cache = &backend.read().await.job_cache;
    Ok(job_cache.get_job(jobid).await)
}

#[tauri::command]
pub async fn get_active_jobs() -> Result<Vec<JobInfo>, String> {
    let backend = BACKEND_MANAGER
        .get_active()
        .await
        .ok_or("No active backend".to_string())?;
    let job_cache = &backend.read().await.job_cache;
    Ok(job_cache.get_active_jobs().await)
}

#[tauri::command]
pub async fn get_jobs_by_source(source: String) -> Result<Vec<JobInfo>, String> {
    let backend = BACKEND_MANAGER
        .get_active()
        .await
        .ok_or("No active backend".to_string())?;
    let job_cache = &backend.read().await.job_cache;
    Ok(job_cache.get_jobs_by_source(&source).await)
}

/// Rename a profile in all cached running jobs
#[tauri::command]
pub async fn rename_profile_in_cache(
    remote_name: String,
    old_name: String,
    new_name: String,
) -> Result<usize, String> {
    let backend = BACKEND_MANAGER
        .get_active()
        .await
        .ok_or("No active backend".to_string())?;
    let job_cache = &backend.read().await.job_cache;
    Ok(job_cache
        .rename_profile(&remote_name, &old_name, &new_name)
        .await)
}

pub async fn monitor_job(
    backend_name: String,
    remote_name: String, // Used for logging
    operation: &str,
    jobid: u64,
    app: AppHandle,
    client: reqwest::Client,
) -> Result<(), RcloneError> {
    let scheduled_tasks_cache = app.state::<ScheduledTasksCache>();

    // Get API URL and JobCache from backend (using backend_name)
    let (backend_copy, job_cache) = if let Some(backend) = BACKEND_MANAGER.get(&backend_name).await
    {
        let backend = backend.read().await;
        (
            backend.clone(),
            backend.job_cache.clone(), // Clone Arc
        )
    } else {
        return Err(RcloneError::ConfigError(format!(
            "Backend '{}' not found",
            backend_name
        )));
    };

    let job_status_url = EndpointHelper::build_url(&backend_copy.api_url(), job::STATUS);
    let stats_url = EndpointHelper::build_url(&backend_copy.api_url(), core::STATS);

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
        let status_fut = backend_copy
            .inject_auth(client.post(&job_status_url))
            .json(&json!({ "jobid": jobid }))
            .send();

        let stats_fut = backend_copy
            .inject_auth(client.post(&stats_url))
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
                            &job_cache,
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
    job_cache: &JobCache,
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
/// Stop a running job
#[tauri::command]
pub async fn stop_job(
    app: AppHandle,
    scheduled_tasks_cache: State<'_, ScheduledTasksCache>,
    jobid: u64,
    remote_name: String,
    state: State<'_, RcloneState>,
) -> Result<(), String> {
    // Find the backend that owns this job
    let mut target_backend = None;
    let names = BACKEND_MANAGER.list_names().await;

    for name in names {
        if let Some(backend) = BACKEND_MANAGER.get(&name).await {
            let job_cache = backend.read().await.job_cache.clone();
            if job_cache.get_job(jobid).await.is_some() {
                target_backend = Some(backend);
                break;
            }
        }
    }

    // Use found backend, or fallback to active if not found in any cache
    let backend = if let Some(b) = target_backend {
        b
    } else {
        debug!(
            "Job {} not found in any backend cache, falling back to active backend",
            jobid
        );
        BACKEND_MANAGER
            .get_active()
            .await
            .ok_or_else(|| format!("Job {} not found and no active backend", jobid))?
    };

    let backend_guard = backend.read().await;
    let job_cache = &backend_guard.job_cache;
    let url = EndpointHelper::build_url(&backend_guard.api_url(), job::STOP);
    let payload = json!({ "jobid": jobid });

    let response = backend_guard
        .inject_auth(state.client.post(&url))
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
