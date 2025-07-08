use log::{debug, error, info, warn};
use serde_json::{Value, json};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::time::sleep;

use crate::{
    RcloneState,
    rclone::state::{ENGINE_STATE, JOB_CACHE},
    utils::{
        logging::log::log_operation,
        rclone::endpoints::{EndpointHelper, core, job},
        types::all_types::{JobStatus, LogLevel},
    },
};

use super::oauth::RcloneError;

pub async fn monitor_job(
    remote_name: String,
    operation: &str,
    jobid: u64,
    app: AppHandle,
    client: reqwest::Client,
) -> Result<(), RcloneError> {
    let job_status_url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, job::STATUS);
    let stats_url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, core::STATS);

    info!("Starting monitoring for job {jobid} ({operation})");

    let mut consecutive_errors = 0;
    const MAX_CONSECUTIVE_ERRORS: u8 = 3;

    loop {
        // Check if job is still in cache and not stopped
        match JOB_CACHE.get_job(jobid).await {
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
                    JOB_CACHE
                        .update_job_stats(jobid, stats)
                        .await
                        .map_err(RcloneError::JobError)?;
                }

                // Process status
                if let Ok(job_status) = serde_json::from_str::<Value>(&status_body) {
                    if job_status
                        .get("finished")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                    {
                        return handle_job_completion(
                            jobid,
                            &remote_name,
                            operation,
                            job_status,
                            &app,
                        )
                        .await;
                    }
                }
            }
            Err(e) => {
                consecutive_errors += 1;
                warn!(
                    "Error monitoring job {jobid} (attempt {consecutive_errors}/{MAX_CONSECUTIVE_ERRORS}): {e}",
                );

                if consecutive_errors >= MAX_CONSECUTIVE_ERRORS {
                    error!("Too many errors monitoring job {jobid}, giving up");
                    JOB_CACHE
                        .complete_job(jobid, false)
                        .await
                        .map_err(RcloneError::JobError)?;
                    app.emit("job_cache_changed", jobid)
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

    JOB_CACHE
        .complete_job(jobid, success)
        .await
        .map_err(RcloneError::JobError)?;
    app.emit("job_cache_changed", jobid)
        .map_err(|e| RcloneError::JobError(e.to_string()))?;

    if !error_msg.is_empty() {
        log_operation(
            LogLevel::Error,
            Some(remote_name.to_string()),
            Some(operation.to_string()),
            format!("{operation} Job {jobid} failed: {error_msg}"),
            Some(json!({"jobid": jobid, "status": job_status})),
        )
        .await;
        Err(RcloneError::JobError(error_msg))
    } else if success {
        log_operation(
            LogLevel::Info,
            Some(remote_name.to_string()),
            Some(operation.to_string()),
            format!("{operation} Job {jobid} completed successfully"),
            Some(json!({"jobid": jobid, "status": job_status})),
        )
        .await;
        Ok(())
    } else {
        log_operation(
            LogLevel::Warn,
            Some(remote_name.to_string()),
            Some(operation.to_string()),
            format!("{operation} Job {jobid} completed without success but no error message"),
            Some(json!({"jobid": jobid, "status": job_status})),
        )
        .await;
        Err(RcloneError::JobError(
            "Job completed without success".to_string(),
        ))
    }
}

/// Stop a running job
#[tauri::command]
pub async fn stop_job(
    app: AppHandle,
    jobid: u64,
    remote_name: String,
    state: State<'_, RcloneState>,
) -> Result<(), String> {
    // First mark the job as stopped in the cache
    JOB_CACHE.stop_job(jobid).await.map_err(|e| e.to_string())?;

    // Then try to stop it via API
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

    if !status.is_success() {
        // If job not found, we've already marked it as stopped
        if status.as_u16() == 500 && body.contains("\"job not found\"") {
            log_operation(
                LogLevel::Warn,
                Some(remote_name.clone()),
                Some("Stop job".to_string()),
                format!("Job {jobid} not found, tagged as stopped"),
                None,
            )
            .await;
            warn!("Job {jobid} not found, tagged as stopped.");
        } else {
            let error = format!("HTTP {status}: {body}");
            error!("❌ Failed to stop job {jobid}: {error}");
            return Err(error);
        }
    }

    log_operation(
        LogLevel::Info,
        Some(remote_name.clone()),
        Some("Stop job".to_string()),
        format!("Job {jobid} stopped successfully"),
        None,
    )
    .await;

    app.emit("job_cache_changed", jobid)
        .map_err(|e| format!("Failed to emit event: {e}"))?;

    info!("✅ Stopped job {jobid}");
    Ok(())
}
