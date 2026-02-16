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
        app::notification::{Notification, send_notification_typed},
        logging::log::log_operation,
        rclone::endpoints::{core, job},
        types::{
            core::RcloneState,
            jobs::{JobCache, JobInfo, JobResponse, JobStatus, JobType},
            logs::LogLevel,
        },
    },
};

use super::system::RcloneError;

/// Poll interval for job status/stat requests (milliseconds).
/// Lower values make job completion detection faster but increase API load.
const JOB_POLL_INTERVAL_MS: u64 = 200;

/// Metadata required to start and track a job
use crate::utils::types::origin::Origin;
#[derive(Debug, Clone)]

pub struct JobMetadata {
    pub remote_name: String,
    pub job_type: JobType,
    pub operation_name: String,
    pub source: String,
    pub destination: String,
    pub profile: Option<String>,
    /// Source UI that started this job (e.g., "nautilus", "dashboard", "scheduled")
    pub origin: Option<Origin>,
    /// Stats group name for this job (format: "type/remote", e.g., "sync/gdrive")
    /// If not provided, will be auto-generated from job_type and remote_name
    pub group: Option<String>,
    /// Whether to skip adding this job to the global JobCache (avoids memory bloat for fire-and-forget jobs)
    pub no_cache: bool,
}

impl JobMetadata {
    /// Generate group name in OS-like format: type/remote or type/remote/profile
    /// Examples: "sync/gdrive", "sync/gdrive/daily", "mount/onedrive/work"
    pub fn group_name(&self) -> String {
        // Normalize remote name: remove trailing ':' (rclone style) and any trailing '/'
        let remote = self
            .remote_name
            .trim_end_matches(':')
            .trim_end_matches('/')
            .to_string();

        self.group.clone().unwrap_or_else(|| match &self.profile {
            Some(profile) => format!("{}/{}/{}", self.job_type.as_str(), remote, profile),
            None => format!("{}/{}", self.job_type.as_str(), remote),
        })
    }
}

// -----------------------------------------------------------------------------
// Notification builders for job lifecycle (kept small & pure for easy testing)
// -----------------------------------------------------------------------------
fn job_started_notification(metadata: &JobMetadata) -> Notification {
    Notification::localized(
        "notification.title.operationStarted",
        "notification.body.started",
        Some(vec![
            ("operation", metadata.operation_name.as_str()),
            ("remote", metadata.remote_name.as_str()),
            ("profile", metadata.profile.as_deref().unwrap_or("")),
        ]),
        None,
        Some(LogLevel::Info),
    )
}

fn job_completed_notification(metadata: &JobMetadata) -> Notification {
    Notification::localized(
        "notification.title.operationComplete",
        "notification.body.complete",
        Some(vec![
            ("operation", metadata.operation_name.as_str()),
            ("remote", metadata.remote_name.as_str()),
            ("profile", metadata.profile.as_deref().unwrap_or("")),
        ]),
        None,
        Some(LogLevel::Info),
    )
}

fn job_failed_notification(metadata: &JobMetadata, error_msg: &str) -> Notification {
    Notification::localized(
        "notification.title.operationFailed",
        "notification.body.failed",
        Some(vec![
            ("operation", metadata.operation_name.as_str()),
            ("remote", metadata.remote_name.as_str()),
            ("profile", metadata.profile.as_deref().unwrap_or("")),
            ("error", error_msg),
        ]),
        None,
        Some(LogLevel::Error),
    )
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SubmitJobOptions {
    pub wait_for_completion: bool,
}

pub async fn submit_job(
    app: AppHandle,
    client: reqwest::Client,
    request: reqwest::RequestBuilder,
    payload: Value,
    metadata: JobMetadata,
) -> Result<(u64, Value, Option<String>), String> {
    submit_job_with_options(
        app,
        client,
        request,
        payload,
        metadata,
        SubmitJobOptions::default(),
    )
    .await
}

pub async fn submit_job_with_options(
    app: AppHandle,
    client: reqwest::Client,
    request: reqwest::RequestBuilder,
    payload: Value,
    metadata: JobMetadata,
    options: SubmitJobOptions,
) -> Result<(u64, Value, Option<String>), String> {
    let (jobid, backend_name, response_json, execute_id) =
        initialize_and_register_job(&app, request, payload, &metadata).await?;

    if options.wait_for_completion {
        monitor_job(backend_name, metadata, jobid, app.clone(), client.clone())
            .await
            .map_err(|e| e.to_string())?;
    } else {
        let app_clone = app.clone();
        let client_clone = client.clone();
        tauri::async_runtime::spawn(async move {
            let _ = monitor_job(
                backend_name,
                metadata.clone(), // Pass full metadata
                jobid,
                app_clone,
                client_clone,
            )
            .await;
        });
    }

    Ok((jobid, response_json, execute_id))
}

async fn initialize_and_register_job(
    app: &AppHandle,
    request: reqwest::RequestBuilder,
    payload: Value,
    metadata: &JobMetadata,
) -> Result<(u64, String, Value, Option<String>), String> {
    let (jobid, response_json, execute_id) = send_job_request(request, payload, metadata).await?;

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let backend_name = backend.name.clone();

    if !metadata.no_cache {
        add_job_to_cache(
            &backend_manager.job_cache,
            jobid,
            metadata,
            &backend_name,
            execute_id.clone(),
            Some(app),
        )
        .await;
    }

    send_notification_typed(
        app,
        job_started_notification(metadata),
        metadata.origin.clone(),
    );

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
            format!("Failed to start {}: {error}", metadata.job_type.as_str()),
            Some(json!({"response": body_text})),
        );
        return Err(error);
    }

    let response_json: Value = serde_json::from_str(&body_text)
        .map_err(|e| crate::localized_error!("backendErrors.serve.parseFailed", "error" => e))?;

    // Extract jobid / executeId from response (strict — error if missing)
    let (jobid, execute_id) = parse_job_response(&response_json)?;

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

/// Parse job response helper used by send_job_request
fn parse_job_response(response_json: &Value) -> Result<(u64, Option<String>), String> {
    // First try to parse into the canonical JobResponse
    if let Ok(resp) = serde_json::from_value::<JobResponse>(response_json.clone()) {
        return Ok((resp.jobid, resp.execute_id));
    }

    // Fallback: allow numeric `jobid` or string `id`
    let jid_opt = response_json
        .get("jobid")
        .and_then(|v| v.as_u64())
        .or_else(|| {
            response_json
                .get("id")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<u64>().ok())
        });

    if let Some(jid) = jid_opt {
        let eid = response_json
            .get("executeId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        Ok((jid, eid))
    } else {
        Err(
            crate::localized_error!("backendErrors.serve.parseFailed", "error" => "missing job id in response"),
        )
    }
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
                origin: metadata.origin.clone(),
                backend_name: Some(backend_name.to_string()),
                execute_id,
            },
            app,
        )
        .await;
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
        .rename_profile(&remote_name, &old_name, &new_name, Some(&app))
        .await)
}

pub async fn monitor_job(
    backend_name: String,
    metadata: JobMetadata,
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

    info!(
        "Starting monitoring for job {jobid} ({})",
        metadata.operation_name
    );

    let mut consecutive_errors = 0;
    const MAX_CONSECUTIVE_ERRORS: u8 = 3;

    loop {
        // Stop if removed or explicitly stopped in cache (SKIP check if no_cache is true)
        if !metadata.no_cache {
            if let Some(job) = job_cache.get_job(jobid).await {
                if job.status == JobStatus::Stopped {
                    return Ok(json!({}));
                }
            } else {
                return Ok(json!({}));
            }
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

                // Update Stats if valid (and caching enabled)
                if !metadata.no_cache
                    && let Ok(stats) = serde_json::from_str::<Value>(&stats_body)
                {
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
                        &metadata,
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
                    if !metadata.no_cache {
                        let _ = job_cache.complete_job(jobid, false, Some(&app)).await;
                    }
                    return Err(RcloneError::JobError(
                        crate::localized_error!("backendErrors.job.monitoringFailed", "error" => e),
                    ));
                }
            }
        }
        sleep(Duration::from_millis(JOB_POLL_INTERVAL_MS)).await;
    }
}

pub async fn handle_job_completion(
    jobid: u64,
    metadata: &JobMetadata,
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

    // Update cache if enabled
    if !metadata.no_cache {
        Some(
            job_cache
                .complete_job(jobid, success, Some(app))
                .await
                .map_err(RcloneError::JobError)?,
        )
    } else {
        None
    };

    let _profile = metadata.profile.clone().unwrap_or_default();
    let remote_name = &metadata.remote_name;
    let operation = &metadata.operation_name;

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

        send_notification_typed(
            app,
            job_failed_notification(metadata, &error_msg),
            metadata.origin.clone(),
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

        send_notification_typed(
            app,
            job_completed_notification(metadata),
            metadata.origin.clone(),
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

        let stopped_profile = job_cache
            .get_job(jobid)
            .await
            .and_then(|j| j.profile)
            .unwrap_or_default();
        send_notification_typed(
            &app,
            Notification::localized(
                "notification.title.operationStopped",
                "notification.body.stopped",
                Some(vec![
                    ("operation", "Job"),
                    ("remote", remote_name.as_str()),
                    ("profile", stopped_profile.as_str()),
                ]),
                None,
                Some(LogLevel::Info),
            ),
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
            job_type: JobType::Sync,
            operation_name: "Sync".to_string(),
            source: "src".to_string(),
            destination: "dst".to_string(),
            profile: None,
            origin: None,
            group: None,
            no_cache: false,
        };

        assert_eq!(meta.group_name(), "sync/gdrive");
    }

    /// Test that group_name includes profile if present
    #[test]
    fn test_group_name_with_profile() {
        let meta = JobMetadata {
            remote_name: "gdrive:".to_string(),
            job_type: JobType::Sync,
            operation_name: "Sync".to_string(),
            source: "src".to_string(),
            destination: "dst".to_string(),
            profile: Some("daily".to_string()),
            origin: None,
            group: None,
            no_cache: false,
        };

        assert_eq!(meta.group_name(), "sync/gdrive/daily");
    }

    /// Test custom group name takes precedence over auto-generation
    #[test]
    fn test_custom_group_name() {
        let meta = JobMetadata {
            remote_name: "gdrive:".to_string(),
            job_type: JobType::Sync,
            operation_name: "Sync".to_string(),
            source: "src".to_string(),
            destination: "dst".to_string(),
            profile: None,
            origin: None,
            group: Some("custom/group".to_string()),
            no_cache: true,
        };

        assert_eq!(meta.group_name(), "custom/group");
    }

    /// Test different job types produce correct group names
    #[test]
    fn test_group_name_different_job_types() {
        let test_cases = vec![
            (JobType::Sync, "gdrive:", "sync/gdrive"),
            (JobType::Copy, "onedrive:", "copy/onedrive"),
            (JobType::Move, "dropbox:", "move/dropbox"),
            (JobType::Bisync, "box:", "bisync/box"),
            (JobType::Mount, "s3:", "mount/s3"),
            (JobType::Serve, "local:", "serve/local"),
            (JobType::CopyUrl, "remote:", "copy_url/remote"),
        ];

        for (job_type, remote_name, expected) in test_cases {
            let meta = JobMetadata {
                remote_name: remote_name.to_string(),
                job_type: job_type.clone(),
                operation_name: "Test".to_string(),
                source: "src".to_string(),
                destination: "dst".to_string(),
                profile: None,
                origin: None,
                group: None,
                no_cache: false,
            };
            assert_eq!(
                meta.group_name(),
                expected,
                "Failed for job_type: {}",
                job_type
            );
        }
    }

    // ---------- parse_job_response tests ----------

    #[test]
    fn test_parse_job_response_from_struct() {
        let v = json!({ "jobid": 123u64, "executeId": "exec-1" });
        let res = parse_job_response(&v).unwrap();
        assert_eq!(res.0, 123);
        assert_eq!(res.1, Some("exec-1".to_string()));
    }

    #[test]
    fn test_parse_job_response_jobid_number() {
        let v = json!({ "jobid": 99u64 });
        let res = parse_job_response(&v).unwrap();
        assert_eq!(res.0, 99);
        assert_eq!(res.1, None);
    }

    #[test]
    fn test_parse_job_response_id_string() {
        let v = json!({ "id": "42", "executeId": "e42" });
        let res = parse_job_response(&v).unwrap();
        assert_eq!(res.0, 42);
        assert_eq!(res.1, Some("e42".to_string()));
    }

    #[test]
    fn test_parse_job_response_missing_jobid() {
        let v = json!({});
        assert!(parse_job_response(&v).is_err());
    }

    // -------------------------
    // Notification builder tests
    // -------------------------

    #[test]
    fn test_job_started_notification_builder() {
        use crate::utils::types::origin::Origin;

        let meta = JobMetadata {
            remote_name: "gdrive:".to_string(),
            job_type: JobType::Sync,
            operation_name: "Sync".to_string(),
            source: "src".to_string(),
            destination: "dst".to_string(),
            profile: Some("daily".to_string()),
            origin: Some(Origin::Nautilus),
            group: None,
            no_cache: false,
        };

        let n = job_started_notification(&meta);

        match n.title {
            crate::utils::app::notification::Text::Localized { key, params } => {
                assert_eq!(key, "notification.title.operationStarted");
                let map = params.expect("params present");
                assert_eq!(map.get("operation").map(|s| s.as_str()), Some("Sync"));
                assert_eq!(map.get("remote").map(|s| s.as_str()), Some("gdrive:"));
                assert_eq!(map.get("profile").map(|s| s.as_str()), Some("daily"));
            }
            _ => panic!("expected localized title"),
        }

        match n.body {
            crate::utils::app::notification::Text::Localized { key, params } => {
                assert_eq!(key, "notification.body.started");
                let map = params.expect("params present");
                assert_eq!(map.get("operation").map(|s| s.as_str()), Some("Sync"));
                assert_eq!(map.get("remote").map(|s| s.as_str()), Some("gdrive:"));
                assert_eq!(map.get("profile").map(|s| s.as_str()), Some("daily"));
            }
            _ => panic!("expected localized body"),
        }

        assert_eq!(n.level, Some(crate::utils::types::logs::LogLevel::Info));
    }

    #[test]
    fn test_job_completed_notification_builder() {
        let meta = JobMetadata {
            remote_name: "onedrive:".to_string(),
            job_type: JobType::Copy,
            operation_name: "Copy".to_string(),
            source: "a".to_string(),
            destination: "b".to_string(),
            profile: None,
            origin: None,
            group: None,
            no_cache: false,
        };

        let n = job_completed_notification(&meta);

        match n.title {
            crate::utils::app::notification::Text::Localized { key, params } => {
                assert_eq!(key, "notification.title.operationComplete");
                let map = params.expect("params present");
                assert_eq!(map.get("operation").map(|s| s.as_str()), Some("Copy"));
                assert_eq!(map.get("remote").map(|s| s.as_str()), Some("onedrive:"));
                // profile should be empty string when None
                assert_eq!(map.get("profile").map(|s| s.as_str()), Some(""));
            }
            _ => panic!("expected localized title"),
        }

        match n.body {
            crate::utils::app::notification::Text::Localized { key, params } => {
                assert_eq!(key, "notification.body.complete");
                let map = params.expect("params present");
                assert_eq!(map.get("operation").map(|s| s.as_str()), Some("Copy"));
                assert_eq!(map.get("remote").map(|s| s.as_str()), Some("onedrive:"));
            }
            _ => panic!("expected localized body"),
        }

        assert_eq!(n.level, Some(crate::utils::types::logs::LogLevel::Info));
    }

    #[test]
    fn test_job_failed_notification_builder_includes_error() {
        let meta = JobMetadata {
            remote_name: "dropbox:".to_string(),
            job_type: JobType::Move,
            operation_name: "Move".to_string(),
            source: "x".to_string(),
            destination: "y".to_string(),
            profile: Some("p".to_string()),
            origin: None,
            group: None,
            no_cache: false,
        };

        let n = job_failed_notification(&meta, "disk full");

        match n.body {
            crate::utils::app::notification::Text::Localized { key, params } => {
                assert_eq!(key, "notification.body.failed");
                let map = params.expect("params present");
                assert_eq!(map.get("error").map(|s| s.as_str()), Some("disk full"));
                assert_eq!(map.get("operation").map(|s| s.as_str()), Some("Move"));
                assert_eq!(map.get("remote").map(|s| s.as_str()), Some("dropbox:"));
            }
            _ => panic!("expected localized body"),
        }

        assert_eq!(n.level, Some(crate::utils::types::logs::LogLevel::Error));
    }

    #[test]
    fn test_job_notification_suppression_for_dashboard_origin() {
        use crate::utils::types::origin::Origin;

        let meta_dashboard = JobMetadata {
            remote_name: "gdrive:".to_string(),
            job_type: JobType::Sync,
            operation_name: "Sync".to_string(),
            source: "src".to_string(),
            destination: "dst".to_string(),
            profile: None,
            origin: Some(Origin::Dashboard),
            group: None,
            no_cache: false,
        };

        // Dashboard-origin job notifications should be suppressed when the app is focused
        assert!(crate::utils::app::notification::should_suppress(
            true,
            meta_dashboard.origin.as_ref()
        ));

        let meta_scheduled = JobMetadata {
            origin: Some(Origin::Scheduled),
            ..meta_dashboard.clone()
        };

        // Scheduled-origin job notifications should NOT be suppressed
        assert!(!crate::utils::app::notification::should_suppress(
            true,
            meta_scheduled.origin.as_ref()
        ));
    }
}
