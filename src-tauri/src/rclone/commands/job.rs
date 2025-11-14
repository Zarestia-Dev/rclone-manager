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
            all_types::{JobCache, JobStatus, LogLevel},
            events::{JOB_CACHE_CHANGED, SCHEDULED_TASK_STOPPED},
        },
    },
};

use super::system::RcloneError;

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
                consecutive_errors = 0; // Reset error counter on success

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
                        // --- Pass *all* required state to the completion handler ---
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
    scheduled_tasks_cache: State<'_, ScheduledTasksCache>, // <-- Accept this state
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

    // Calculate next run BEFORE any updates
    let next_run = if let Some(ref t) = task {
        get_next_run(&t.cron_expression).ok()
    } else {
        None
    };

    // Update job cache
    job_cache
        .complete_job(jobid, success)
        .await
        .map_err(RcloneError::JobError)?;

    // Update task cache if this was a scheduled task
    if let Some(task) = task {
        info!(
            "Job {} was associated with scheduled task '{}', updating task status.",
            jobid, task.name
        );

        if success {
            scheduled_tasks_cache // <-- Use injected state
                .update_task(&task.id, |t| {
                    t.mark_success();
                    t.next_run = next_run;
                })
                .await
                .map_err(|e| RcloneError::JobError(e))?; // Don't ignore errors
        } else {
            scheduled_tasks_cache // <-- Use injected state
                .update_task(&task.id, |t| {
                    t.mark_failure(error_msg.clone());
                    t.next_run = next_run;
                })
                .await
                .map_err(|e| RcloneError::JobError(e))?;
        }
    }

    // Emit event AFTER all state updates
    app.emit(JOB_CACHE_CHANGED, jobid)
        .map_err(|e| RcloneError::JobError(e.to_string()))?;

    // Log and return result
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
    scheduled_tasks_cache: State<'_, ScheduledTasksCache>, // <-- Inject state
    jobid: u64,
    remote_name: String,
    state: State<'_, RcloneState>,
) -> Result<(), String> {
    // First try to stop via API, THEN update cache
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
        // Job already gone
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
        // Real error
        let error = format!("HTTP {status}: {body}");
        error!("❌ Failed to stop job {jobid}: {error}");
        return Err(error);
    };

    if job_stopped {
        // NOW mark as stopped in cache
        job_cache.stop_job(jobid).await.map_err(|e| e.to_string())?;

        // Check if it was a scheduled task
        if let Some(task) = scheduled_tasks_cache.get_task_by_job_id(jobid).await {
            info!(
                "🛑 Job {} was associated with scheduled task '{}', marking task as stopped",
                jobid, task.name
            );

            scheduled_tasks_cache // <-- Use injected state
                .update_task(&task.id, |t| {
                    t.mark_stopped();
                })
                .await
                .map_err(|e| format!("Failed to update task state: {}", e))?;

            // Emit event to notify frontend
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
