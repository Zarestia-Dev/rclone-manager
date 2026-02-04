use chrono::Utc;
use log::{error, info, warn};
use serde_json::{Value, json};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tokio::time::sleep;

use crate::{
    core::scheduler::engine::get_next_run,
    rclone::{backend::BackendManager, state::scheduled_tasks::ScheduledTasksCache},
    utils::{
        logging::log::log_operation,
        rclone::endpoints::{core, job},
        types::{
            core::RcloneState,
            jobs::{JobCache, JobInfo, JobResponse, JobStatus},
            logs::LogLevel,
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
    /// Stats group name for this job (format: "type/remote", e.g., "sync/gdrive")
    /// If not provided, will be auto-generated from job_type and remote_name
    pub group: Option<String>,
}

impl JobMetadata {
    /// Generate group name in OS-like format: type/remote or type/remote_profile
    /// Examples: "sync/gdrive", "sync/gdrive_daily", "mount/onedrive_work"
    pub fn group_name(&self) -> String {
        self.group.clone().unwrap_or_else(|| match &self.profile {
            Some(profile) => format!("{}/{}/{}", self.job_type, self.remote_name, profile),
            None => format!("{}/{}", self.job_type, self.remote_name),
        })
    }
}

/// Submit a LONG-RUNNING job (sync, copy, move, bisync)
/// Returns jobid immediately, monitors in background
pub async fn submit_job(
    app: AppHandle,
    client: reqwest::Client,
    request: reqwest::RequestBuilder,
    payload: Value,
    metadata: JobMetadata,
) -> Result<(u64, Value, Option<String>), String> {
    let (jobid, backend_name, response_json, execute_id) =
        initialize_and_register_job(&app, request, payload, &metadata).await?;

    // Monitor in background - don't wait
    let app_clone = app.clone();
    let meta_clone = metadata.clone();
    let client_clone = client.clone();

    tauri::async_runtime::spawn(async move {
        let _ = monitor_job(
            backend_name,
            meta_clone.remote_name,
            &meta_clone.operation_name,
            jobid,
            app_clone,
            client_clone,
        )
        .await;
    });

    Ok((jobid, response_json, execute_id))
}

/// Submit a SHORT-LIVED job (mount, serve)
/// Waits for completion and returns result
pub async fn submit_job_and_wait(
    app: AppHandle,
    client: reqwest::Client,
    request: reqwest::RequestBuilder,
    payload: Value,
    metadata: JobMetadata,
) -> Result<(u64, Value, Option<String>), String> {
    let (jobid, backend_name, response_json, execute_id) =
        initialize_and_register_job(&app, request, payload, &metadata).await?;

    // Monitor and WAIT for completion
    let result = monitor_job(
        backend_name,
        metadata.remote_name.clone(),
        &metadata.operation_name,
        jobid,
        app.clone(),
        client,
    )
    .await;

    // Return error if job failed
    result.map_err(|e| e.to_string())?;

    Ok((jobid, response_json, execute_id))
}

/// Helper: Sends request, gets active backend, and registers job in cache
async fn initialize_and_register_job(
    app: &AppHandle,
    request: reqwest::RequestBuilder,
    payload: Value,
    metadata: &JobMetadata,
) -> Result<(u64, String, Value, Option<String>), String> {
    let (jobid, response_json, execute_id) = send_job_request(request, payload, metadata).await?;

    // Determine active backend
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let backend_name = backend.name.clone();

    // Add to cache
    add_job_to_cache(
        &backend_manager.job_cache,
        jobid,
        metadata,
        &backend_name,
        execute_id.clone(),
        Some(app),
    )
    .await;

    Ok((jobid, backend_name, response_json, execute_id))
}

/// Internal: Send job request and parse response
/// Automatically injects _group parameter for stats grouping
async fn send_job_request(
    client_builder: reqwest::RequestBuilder,
    payload: Value,
    metadata: &JobMetadata,
) -> Result<(u64, Value, Option<String>), String> {
    // Inject _group parameter for stats grouping
    let mut payload = payload;
    if let Some(obj) = payload.as_object_mut()
        && !obj.contains_key("_group")
    {
        obj.insert("_group".to_string(), json!(metadata.group_name()));
    }

    let response = client_builder
        .json(&payload)
        .send()
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    let status = response.status();
    let body_text = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = crate::localized_error!("backendErrors.http.error", "status" => status, "body" => body_text);
        log_operation(
            LogLevel::Error,
            Some(metadata.remote_name.clone()),
            Some(metadata.operation_name.clone()),
            format!("Failed to start {}: {error}", metadata.job_type),
            Some(json!({"response": body_text})),
        );
        return Err(error);
    }

    let response_json: Value = serde_json::from_str(&body_text)
        .map_err(|e| crate::localized_error!("backendErrors.serve.parseFailed", "error" => e))?;

    // Try parsing as JobResponse, fallback to manual extraction if that fails
    let (jobid, execute_id) =
        if let Ok(resp) = serde_json::from_value::<JobResponse>(response_json.clone()) {
            (resp.jobid, resp.execute_id)
        } else {
            // Fallback: handles both numeric jobid and string id, and manual executeId
            let jid = if let Some(id) = response_json.get("jobid").and_then(|v| v.as_u64()) {
                id
            } else if let Some(id_str) = response_json.get("id").and_then(|v| v.as_str()) {
                id_str.parse::<u64>().unwrap_or(0)
            } else {
                0
            };
            let eid = response_json
                .get("executeId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            (jid, eid)
        };

    log_operation(
        LogLevel::Info,
        Some(metadata.remote_name.clone()),
        Some(metadata.operation_name.clone()),
        format!(
            "{} started with ID {} (ExecuteID: {:?})",
            metadata.operation_name, jobid, execute_id
        ),
        Some(json!({"jobid": jobid, "executeId": execute_id})),
    );

    Ok((jobid, response_json, execute_id))
}

/// Internal: Add job to cache (takes reference to JobCache)
/// Now also emits JOB_CACHE_CHANGED via the cache layer
async fn add_job_to_cache(
    job_cache: &JobCache,
    jobid: u64,
    metadata: &JobMetadata,
    backend_name: &str,
    execute_id: Option<String>,
    app: Option<&AppHandle>,
) {
    job_cache
        .add_job(
            JobInfo {
                jobid,
                job_type: metadata.job_type.clone(),
                remote_name: metadata.remote_name.clone(),
                source: metadata.source.clone(),
                destination: metadata.destination.clone(),
                start_time: Utc::now(),
                status: JobStatus::Running,
                stats: None,
                group: metadata.group_name(),
                profile: metadata.profile.clone(),
                source_ui: metadata.source_ui.clone(),
                backend_name: Some(backend_name.to_string()),
                execute_id,
            },
            app,
        )
        .await;
}

use crate::rclone::backend::types::Backend;

/// Poll a job until completion (for short-running operations without cache overhead)
pub async fn poll_job(
    jobid: u64,
    client: reqwest::Client,
    backend: Backend,
) -> Result<Value, String> {
    let job_status_url = backend.url_for(job::STATUS);
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
                    return Err(
                        crate::localized_error!("backendErrors.job.monitoringFailed", "error" => e),
                    );
                }
                warn!("Error checking job status: {e}");
            }
        }
        sleep(Duration::from_millis(200)).await;
    }
}

#[cfg(not(feature = "web-server"))]
#[tauri::command]
pub async fn get_jobs(app: AppHandle) -> Result<Vec<JobInfo>, String> {
    let backend_manager = app.state::<BackendManager>();
    Ok(backend_manager.job_cache.get_jobs().await)
}

#[cfg(not(feature = "web-server"))]
#[tauri::command]
pub async fn delete_job(app: AppHandle, jobid: u64) -> Result<(), String> {
    let backend_manager = app.state::<BackendManager>();
    backend_manager
        .job_cache
        .delete_job(jobid, Some(&app))
        .await
}

#[cfg(not(feature = "web-server"))]
#[tauri::command]
pub async fn get_job_status(app: AppHandle, jobid: u64) -> Result<Option<JobInfo>, String> {
    let backend_manager = app.state::<BackendManager>();
    Ok(backend_manager.job_cache.get_job(jobid).await)
}

#[cfg(not(feature = "web-server"))]
#[tauri::command]
pub async fn get_active_jobs(app: AppHandle) -> Result<Vec<JobInfo>, String> {
    let backend_manager = app.state::<BackendManager>();
    Ok(backend_manager.job_cache.get_active_jobs().await)
}

#[cfg(not(feature = "web-server"))]
#[tauri::command]
pub async fn get_jobs_by_source(app: AppHandle, source: String) -> Result<Vec<JobInfo>, String> {
    let backend_manager = app.state::<BackendManager>();
    Ok(backend_manager.job_cache.get_jobs_by_source(&source).await)
}

/// Rename a profile in all cached running jobs
#[cfg(not(feature = "web-server"))]
#[tauri::command]
pub async fn rename_profile_in_cache(
    app: AppHandle,
    remote_name: String,
    old_name: String,
    new_name: String,
) -> Result<usize, String> {
    let backend_manager = app.state::<BackendManager>();
    Ok(backend_manager
        .job_cache
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
) -> Result<Value, RcloneError> {
    let scheduled_tasks_cache = app.state::<ScheduledTasksCache>();
    let backend_manager = app.state::<BackendManager>();

    // Get backend for API calls
    let backend = backend_manager
        .get(&backend_name)
        .await
        .ok_or_else(|| RcloneError::ConfigError(format!("Backend '{}' not found", backend_name)))?;

    let job_cache = &backend_manager.job_cache;
    let job_status_url = backend.url_for(job::STATUS);
    let stats_url = backend.url_for(core::STATS);

    info!("Starting monitoring for job {jobid} ({operation})");

    let mut consecutive_errors = 0;
    const MAX_CONSECUTIVE_ERRORS: u8 = 3;

    loop {
        // Stop if removed or explicitly stopped in cache
        match job_cache.get_job(jobid).await {
            Some(job) if job.status == JobStatus::Stopped => return Ok(json!({})),
            None => return Ok(json!({})),
            _ => {}
        }

        // Parallel fetch of status and stats
        let status_req = backend
            .inject_auth(client.post(&job_status_url))
            .json(&json!({ "jobid": jobid }))
            .send();

        let stats_req = backend
            .inject_auth(client.post(&stats_url))
            .json(&json!({ "jobid": jobid }))
            .send();

        match tokio::try_join!(status_req, stats_req) {
            Ok((status_resp, stats_resp)) => {
                consecutive_errors = 0;
                let status_body = status_resp.text().await.unwrap_or_default();
                let stats_body = stats_resp.text().await.unwrap_or_default();

                // Update Stats if valid
                if let Ok(stats) = serde_json::from_str::<Value>(&stats_body) {
                    let _ = job_cache.update_job_stats(jobid, stats).await;
                }

                // Check Completion
                if let Ok(job_status) = serde_json::from_str::<Value>(&status_body)
                    && job_status
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
                        job_cache,
                        scheduled_tasks_cache,
                    )
                    .await;
                }
            }
            Err(e) => {
                consecutive_errors += 1;
                warn!(
                    "Job {jobid} monitor error ({consecutive_errors}/{MAX_CONSECUTIVE_ERRORS}): {e}"
                );

                if consecutive_errors >= MAX_CONSECUTIVE_ERRORS {
                    let _ = job_cache.complete_job(jobid, false, Some(&app)).await;
                    return Err(RcloneError::JobError(
                        crate::localized_error!("backendErrors.job.monitoringFailed", "error" => e),
                    ));
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
) -> Result<Value, RcloneError> {
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
        .complete_job(jobid, success, Some(app))
        .await
        .map_err(RcloneError::JobError)?;

    if let Some(task) = task {
        info!(
            "Job {} was associated with scheduled task '{}', updating task status.",
            jobid, task.name
        );

        if success {
            scheduled_tasks_cache
                .update_task(
                    &task.id,
                    |t| {
                        t.mark_success();
                        t.next_run = next_run;
                    },
                    Some(app),
                )
                .await
                .map_err(RcloneError::JobError)?;
        } else {
            scheduled_tasks_cache
                .update_task(
                    &task.id,
                    |t| {
                        t.mark_failure(error_msg.clone());
                        t.next_run = next_run;
                    },
                    Some(app),
                )
                .await
                .map_err(RcloneError::JobError)?;
        }
    }

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
        Ok(job_status.get("output").cloned().unwrap_or(json!({})))
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
    scheduled_tasks_cache: State<'_, ScheduledTasksCache>,
    jobid: u64,
    remote_name: String,
) -> Result<(), String> {
    // Use active backend (in simplified architecture, there's only one job cache)
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let job_cache = &backend_manager.job_cache;
    let url = backend.url_for(job::STOP);
    let payload = json!({ "jobid": jobid });

    let response = backend
        .inject_auth(app.state::<RcloneState>().client.post(&url))
        .json(&payload)
        .send()
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

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
        let error =
            crate::localized_error!("backendErrors.http.error", "status" => status, "body" => body);
        error!("❌ Failed to stop job {jobid}: {error}");
        return Err(error);
    };

    if job_stopped {
        job_cache
            .stop_job(jobid, Some(&app))
            .await
            .map_err(|e| e.to_string())?;

        if let Some(task) = scheduled_tasks_cache.get_task_by_job_id(jobid).await {
            info!(
                "🛑 Job {} was associated with scheduled task '{}', marking task as stopped",
                jobid, task.name
            );

            scheduled_tasks_cache
                .update_task(
                    &task.id,
                    |t| {
                        t.mark_stopped();
                    },
                    Some(&app),
                )
                .await
                .map_err(|e| format!("Failed to update task state: {}", e))?;
        }

        log_operation(
            LogLevel::Info,
            Some(remote_name.clone()),
            Some("Stop job".to_string()),
            format!("Job {jobid} stopped successfully"),
            None,
        );

        info!("✅ Stopped job {jobid}");
    }

    Ok(())
}

/// Stop all running jobs in a group
/// Group name format: "type/remote/mount" (e.g., "sync/gdrive/default", "mount/onedrive/my-mount")
#[tauri::command]
pub async fn stop_jobs_by_group(app: AppHandle, group: String) -> Result<(), String> {
    use crate::utils::rclone::endpoints::job;

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let job_cache = &backend_manager.job_cache;
    let url = backend.url_for(job::STOPGROUP);
    let payload = json!({ "group": group });

    info!("🛑 Stopping all jobs in group: {}", group);

    let response = backend
        .inject_auth(app.state::<RcloneState>().client.post(&url))
        .json(&payload)
        .send()
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() && !body.contains("no jobs in group") {
        let error =
            crate::localized_error!("backendErrors.http.error", "status" => status, "body" => body);
        error!("❌ Failed to stop jobs in group {}: {}", group, error);
        return Err(error);
    }

    // Also update our local job cache - stop all jobs matching this group
    let jobs = job_cache.get_jobs().await;
    for job in jobs {
        if job.group == group && job.status == JobStatus::Running {
            let _ = job_cache.stop_job(job.jobid, Some(&app)).await;
        }
    }

    log_operation(
        LogLevel::Info,
        None,
        Some("Stop job group".to_string()),
        format!("All jobs in group '{}' stopped", group),
        None,
    );

    info!("✅ All jobs in group '{}' stopped", group);
    Ok(())
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Test that group_name generates correct format from job_type and remote_name
    #[test]
    fn test_group_name_generation() {
        let meta = JobMetadata {
            remote_name: "gdrive:".to_string(),
            job_type: "sync".to_string(),
            operation_name: "Sync".to_string(),
            source: "src".to_string(),
            destination: "dst".to_string(),
            profile: None,
            source_ui: None,
            group: None,
        };

        assert_eq!(meta.group_name(), "sync/gdrive");
    }

    /// Test that group_name includes profile if present
    #[test]
    fn test_group_name_with_profile() {
        let meta = JobMetadata {
            remote_name: "gdrive:".to_string(),
            job_type: "sync".to_string(),
            operation_name: "Sync".to_string(),
            source: "src".to_string(),
            destination: "dst".to_string(),
            profile: Some("daily".to_string()),
            source_ui: None,
            group: None,
        };

        assert_eq!(meta.group_name(), "sync/gdrive/daily");
    }

    /// Test custom group name takes precedence over auto-generation
    #[test]
    fn test_custom_group_name() {
        let meta = JobMetadata {
            remote_name: "gdrive:".to_string(),
            job_type: "sync".to_string(),
            operation_name: "Sync".to_string(),
            source: "src".to_string(),
            destination: "dst".to_string(),
            profile: None,
            source_ui: None,
            group: Some("custom/group".to_string()),
        };

        assert_eq!(meta.group_name(), "custom/group");
    }

    /// Test different job types produce correct group names
    #[test]
    fn test_group_name_different_job_types() {
        let test_cases = vec![
            ("sync", "gdrive:", "sync/gdrive"),
            ("copy", "onedrive:", "copy/onedrive"),
            ("move", "dropbox:", "move/dropbox"),
            ("bisync", "box:", "bisync/box"),
            ("mount", "s3:", "mount/s3"),
            ("serve", "local:", "serve/local"),
            ("copy_url", "remote:", "copy_url/remote"),
        ];

        for (job_type, remote_name, expected) in test_cases {
            let meta = JobMetadata {
                remote_name: remote_name.to_string(),
                job_type: job_type.to_string(),
                operation_name: "Test".to_string(),
                source: "src".to_string(),
                destination: "dst".to_string(),
                profile: None,
                source_ui: None,
                group: None,
            };
            assert_eq!(
                meta.group_name(),
                expected,
                "Failed for job_type: {}",
                job_type
            );
        }
    }
}
