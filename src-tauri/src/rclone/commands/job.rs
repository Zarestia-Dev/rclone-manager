use chrono::Utc;
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tokio::time::sleep;

use crate::{
    core::scheduler::engine::get_next_run,
    rclone::{backend::BackendManager, state::scheduled_tasks::ScheduledTasksCache},
    utils::{
        app::notification::{NotificationEvent, notify},
        logging::log::log_operation,
        rclone::endpoints::{core, job},
        types::{
            core::RcloneState,
            jobs::{JobCache, JobInfo, JobStatus, JobType},
            logs::LogLevel,
            origin::Origin,
        },
    },
};

use super::system::RcloneError;

/// Poll interval for job status/stats requests (milliseconds).
/// Lower values make completion detection faster but increase API load.
const JOB_POLL_INTERVAL_MS: u64 = 500;

/// Maximum consecutive network errors before the monitoring loop gives up.
const MAX_CONSECUTIVE_ERRORS: u8 = 3;

/// Metadata required to start and track a job.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobMetadata {
    pub remote_name: String,
    pub job_type: JobType,
    pub source: String,
    pub destination: String,
    pub profile: Option<String>,
    /// Source that initiated this job.
    pub origin: Option<Origin>,
    /// Stats group name (`type/remote[/profile]`). Auto-generated when `None`.
    pub group: Option<String>,
    /// Skip `JobCache` insertion. Use for fire-and-forget ops to avoid memory bloat.
    pub no_cache: bool,
}

impl JobMetadata {
    /// Generate group name: `type/remote` or `type/remote/profile`.
    ///
    /// Examples: `"sync/gdrive"`, `"sync/gdrive/daily"`, `"mount/onedrive/work"`.
    pub fn group_name(&self) -> String {
        let remote = self
            .remote_name
            .trim_end_matches(':')
            .trim_end_matches('/')
            .to_string();

        self.group.clone().unwrap_or_else(|| match &self.profile {
            Some(profile) => format!("{}/{}/{}", self.job_type, remote, profile),
            None => format!("{}/{}", self.job_type, remote),
        })
    }

    fn resolved_origin(&self) -> Origin {
        self.origin.clone().unwrap_or(Origin::Internal)
    }

    // Notification event constructors.
    // Small helpers that build `NotificationEvent` values used by production
    // code and verified by unit tests to prevent divergence.

    fn started_event(&self) -> NotificationEvent {
        NotificationEvent::JobStarted {
            remote: self.remote_name.clone(),
            profile: self.profile.clone(),
            job_type: self.job_type.clone(),
            origin: self.resolved_origin(),
        }
    }

    fn completed_event(&self) -> NotificationEvent {
        NotificationEvent::JobCompleted {
            remote: self.remote_name.clone(),
            profile: self.profile.clone(),
            job_type: self.job_type.clone(),
            origin: self.resolved_origin(),
        }
    }

    fn failed_event(&self, error_msg: &str) -> NotificationEvent {
        NotificationEvent::JobFailed {
            remote: self.remote_name.clone(),
            profile: self.profile.clone(),
            job_type: self.job_type.clone(),
            error: error_msg.to_string(),
            origin: self.resolved_origin(),
        }
    }

    fn stopped_event(&self) -> NotificationEvent {
        NotificationEvent::JobStopped {
            remote: self.remote_name.clone(),
            profile: self.profile.clone(),
            job_type: self.job_type.clone(),
            origin: self.resolved_origin(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SubmitJobOptions {
    pub wait_for_completion: bool,
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
            let _ = monitor_job(backend_name, metadata, jobid, app_clone, client_clone).await;
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
    let backend_name = backend_manager.get_active().await.name;

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
        notify(app, metadata.started_event());
    }

    Ok((jobid, backend_name, response_json, execute_id))
}

/// Send a job request and parse the response.
///
/// Injects `_group` into the payload so rclone attributes stats to the right
/// group from the moment the job starts.
async fn send_job_request(
    client_builder: reqwest::RequestBuilder,
    payload: Value,
    metadata: &JobMetadata,
) -> Result<(u64, Value, Option<String>), String> {
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
            Some(metadata.job_type.to_string()),
            format!("Failed to start {}: {error}", metadata.job_type),
            Some(json!({"response": body_text})),
        );
        return Err(error);
    }

    let response_json: Value = serde_json::from_str(&body_text)
        .map_err(|e| crate::localized_error!("backendErrors.serve.parseFailed", "error" => e))?;

    let (jobid, execute_id) = parse_job_response(&response_json)?;

    log_operation(
        LogLevel::Info,
        Some(metadata.remote_name.clone()),
        Some(metadata.job_type.to_string()),
        format!(
            "{} started with ID {} (ExecuteID: {:?})",
            metadata.job_type, jobid, execute_id
        ),
        Some(json!({"jobid": jobid, "executeId": execute_id})),
    );

    Ok((jobid, response_json, execute_id))
}

/// Extract `jobid` and `executeId` from a rclone job response.
///
/// Handles both the canonical shape (`{"jobid": 42}`) and the legacy string-id
/// fallback (`{"id": "42"}`). Extracts fields by reference — no full `Value` clone.
fn parse_job_response(response_json: &Value) -> Result<(u64, Option<String>), String> {
    let jobid = response_json
        .get("jobid")
        .and_then(serde_json::Value::as_u64)
        .or_else(|| {
            response_json
                .get("id")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<u64>().ok())
        })
        .ok_or_else(|| {
            crate::localized_error!(
                "backendErrors.serve.parseFailed",
                "error" => "missing job id in response"
            )
        })?;

    let execute_id = response_json
        .get("executeId")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    Ok((jobid, execute_id))
}

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
                end_time: None,
                status: JobStatus::Running,
                error: None,
                stats: None,
                uploaded_files: Vec::new(),
                group: metadata.group_name(),
                profile: metadata.profile.clone(),
                origin: metadata.origin.clone(),
                backend_name: backend_name.to_string(),
                execute_id,
                parent_batch_id: None,
            },
            app,
        )
        .await;
}

#[tauri::command]
pub async fn get_jobs(app: AppHandle) -> Result<Vec<JobInfo>, String> {
    Ok(app.state::<BackendManager>().job_cache.get_jobs().await)
}

#[tauri::command]
pub async fn delete_job(app: AppHandle, jobid: u64) -> Result<(), String> {
    app.state::<BackendManager>()
        .job_cache
        .delete_job(jobid, Some(&app))
        .await
}

#[tauri::command]
pub async fn get_job_status(app: AppHandle, jobid: u64) -> Result<Option<JobInfo>, String> {
    Ok(app.state::<BackendManager>().job_cache.get_job(jobid).await)
}

#[tauri::command]
pub async fn get_active_jobs(app: AppHandle) -> Result<Vec<JobInfo>, String> {
    Ok(app
        .state::<BackendManager>()
        .job_cache
        .get_active_jobs()
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

    let backend = backend_manager
        .get(&backend_name)
        .await
        .ok_or_else(|| RcloneError::ConfigError(format!("Backend '{backend_name}' not found")))?;

    let job_cache = &backend_manager.job_cache;
    let job_status_url = backend.url_for(job::STATUS);
    let stats_url = backend.url_for(core::STATS);

    info!(
        "Starting monitoring for job {jobid} ({})",
        metadata.job_type
    );

    let mut consecutive_errors = 0u8;

    loop {
        // Exit early if the job was manually stopped or evicted from the cache.
        // Skipped for no_cache jobs — they have no cache entry to inspect.
        if !metadata.no_cache {
            let should_exit = job_cache
                .get_job(jobid)
                .await
                .is_none_or(|j| j.status == JobStatus::Stopped);

            if should_exit {
                info!("Monitoring for job {jobid} stopped: job removed or marked Stopped.");
                return handle_job_completion(
                    jobid,
                    &metadata,
                    json!({"finished": true, "success": false, "stopped": true}),
                    &app,
                    job_cache,
                    scheduled_tasks_cache,
                    None,
                )
                .await;
            }
        }

        // For no_cache jobs, fetching stats on every tick wastes a round-trip
        // because the result is immediately discarded. Only pay for it when
        // caching is on and the response will actually be stored.
        let poll_result = if metadata.no_cache {
            backend
                .inject_auth(client.post(&job_status_url))
                .json(&json!({ "jobid": jobid }))
                .send()
                .await
                .map(|r| (r, None))
        } else {
            // Build both request builders *before* the join so neither holds a
            // borrow on `backend` across the await points inside tokio::join!.
            let status_req = backend
                .inject_auth(client.post(&job_status_url))
                .json(&json!({ "jobid": jobid }));
            let job_stats_req = backend
                .inject_auth(client.post(&stats_url))
                .json(&json!({ "jobid": jobid }));

            tokio::try_join!(status_req.send(), job_stats_req.send())
                .map(|(status_resp, stats_resp)| (status_resp, Some(stats_resp)))
        };

        match poll_result {
            Ok((status_resp, stats_resp_opt)) => {
                consecutive_errors = 0;

                let status_body = status_resp.text().await.unwrap_or_default();

                if let Some(stats_resp) = stats_resp_opt {
                    let job_stats_body = stats_resp.text().await.unwrap_or_default();
                    if let Ok(stats) = serde_json::from_str::<Value>(&job_stats_body) {
                        let _ = job_cache.update_job_stats(jobid, stats).await;
                    }
                }

                if let Ok(job_status) = serde_json::from_str::<Value>(&status_body)
                    && job_status
                        .get("finished")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false)
                {
                    return handle_job_completion(
                        jobid,
                        &metadata,
                        job_status,
                        &app,
                        job_cache,
                        scheduled_tasks_cache,
                        None,
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
                        let _ = job_cache
                            .complete_job(
                                jobid,
                                false,
                                Some(format!(
                                    "Monitoring failed after {MAX_CONSECUTIVE_ERRORS} attempts"
                                )),
                                Some(&app),
                            )
                            .await;
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
    last_stats: Option<Value>,
) -> Result<Value, RcloneError> {
    let success = job_status
        .get("success")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let stopped = job_status
        .get("stopped")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let error_msg = job_status
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    let task = scheduled_tasks_cache
        .get_task_by_job_id(jobid.to_string())
        .await;
    let next_run = task
        .as_ref()
        .and_then(|t| get_next_run(&t.cron_expression).ok());

    if !metadata.no_cache {
        // Collect final stats (stats + completed-transfers, parallelised).
        let final_stats = collect_final_stats(app, metadata, last_stats).await;
        if !final_stats.is_null() && final_stats != json!({}) {
            let _ = job_cache.update_job_stats(jobid, final_stats).await;
        }

        // Fire-and-forget cleanup: deleting the rclone stats group is pure
        // server-side housekeeping. Blocking the return path for it is wrong.
        spawn_stats_cleanup(app, metadata);

        // Mark the job terminal. The `?` propagates a cache error without hiding it.
        let updated_job = job_cache
            .complete_job(
                jobid,
                success,
                (!error_msg.is_empty()).then(|| error_msg.clone()),
                Some(app),
            )
            .await
            .map_err(RcloneError::JobError)?;

        if let Some(batch_id) = &updated_job.parent_batch_id {
            let _ = job_cache
                .update_batch_job(
                    batch_id,
                    |batch| {
                        if success {
                            batch.completed_jobs += 1;
                        } else {
                            batch.failed_jobs += 1;
                        }
                        if batch.completed_jobs + batch.failed_jobs >= batch.total_jobs {
                            batch.status = if batch.failed_jobs > 0 {
                                JobStatus::Failed
                            } else {
                                JobStatus::Completed
                            };
                            batch.end_time = Some(chrono::Utc::now());
                        }
                    },
                    Some(app),
                )
                .await;
        }
    }

    // Update the associated scheduled task when this job was triggered by one.
    if let Some(task) = task {
        info!(
            "Job {jobid} was associated with scheduled task '{}', updating status.",
            task.name
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

    if stopped {
        info!("{} Job {jobid} stopped by user.", metadata.job_type);
        if !metadata.no_cache {
            notify(app, metadata.stopped_event());
        }
        return Ok(job_status.get("output").cloned().unwrap_or(json!({})));
    }

    if !success {
        if !metadata.no_cache {
            log_operation(
                LogLevel::Error,
                Some(metadata.remote_name.clone()),
                Some(metadata.job_type.to_string()),
                format!("{} Job {jobid} failed: {error_msg}", metadata.job_type),
                Some(json!({"jobid": jobid, "status": job_status})),
            );
            notify(app, metadata.failed_event(&error_msg));
        }
        return Err(RcloneError::JobError(error_msg));
    }

    if !metadata.no_cache {
        log_operation(
            LogLevel::Info,
            Some(metadata.remote_name.clone()),
            Some(metadata.job_type.to_string()),
            format!("{} Job {jobid} completed successfully", metadata.job_type),
            Some(json!({"jobid": jobid, "status": job_status})),
        );
        notify(app, metadata.completed_event());
    }

    Ok(job_status.get("output").cloned().unwrap_or(json!({})))
}

/// Fetch the final stats snapshot and completed-transfer list for a finished job.
///
/// The two API calls are independent; `tokio::join!` runs them in parallel.
/// The caller owns the result and decides whether to persist it.
async fn collect_final_stats(
    app: &AppHandle,
    metadata: &JobMetadata,
    last_stats: Option<Value>,
) -> Value {
    let backend = app.state::<BackendManager>().get_active().await;
    let client = &app.state::<RcloneState>().client;
    let group = metadata.group_name();

    // Skip the stats re-fetch when the last poll already gave us something
    // useful — saves a round-trip on fast-completing jobs.
    let needs_stats_fetch = last_stats
        .as_ref()
        .is_none_or(|s| s.is_null() || s == &json!({}));

    // Build all request builders *before* the join. RequestBuilder does not
    // borrow from Backend after construction, so this is borrow-safe.
    let stats_req = needs_stats_fetch.then(|| {
        backend
            .inject_auth(client.post(backend.url_for(core::STATS)))
            .json(&json!({ "group": group }))
    });
    let transferred_req = backend
        .inject_auth(client.post(backend.url_for(core::TRANSFERRED)))
        .json(&json!({ "group": group }));

    let (stats_send_result, transferred_send_result) = tokio::join!(
        async {
            match stats_req {
                Some(req) => req.send().await.ok(),
                None => None,
            }
        },
        transferred_req.send()
    );

    // Resolve the base stats blob.
    let mut final_stats = if needs_stats_fetch {
        match stats_send_result {
            Some(resp) => resp.json::<Value>().await.unwrap_or(json!({})),
            None => json!({}),
        }
    } else {
        last_stats.unwrap_or(json!({}))
    };

    // Inject the completed-transfers list so the frontend can render a
    // per-file summary without issuing a separate API call.
    if let Ok(resp) = transferred_send_result
        && let Ok(data) = resp.json::<Value>().await
    {
        info!("Completed transfers for group '{group}': {data}");
        if let Some(obj) = final_stats.as_object_mut() {
            obj.insert(
                "completed".to_string(),
                data.get("transferred").cloned().unwrap_or(json!([])),
            );
        }
    }

    final_stats
}

/// Spawn a background task that deletes the rclone stats group.
///
/// Deletion is pure server-side housekeeping. The caller must not block for
/// it — the job is already marked terminal by the time this runs.
fn spawn_stats_cleanup(app: &AppHandle, metadata: &JobMetadata) {
    let client = app.state::<RcloneState>().client.clone();
    let group = metadata.group_name();
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        let backend = app.state::<BackendManager>().get_active().await;
        let delete_url = backend.url_for(core::STATS_DELETE);
        let _ = backend
            .inject_auth(client.post(&delete_url))
            .json(&json!({ "group": group }))
            .send()
            .await;
    });
}

/// Stop a running job.
#[tauri::command]
pub async fn stop_job(app: AppHandle, jobid: u64, remote_name: String) -> Result<(), String> {
    let scheduled_tasks_cache = app.state::<ScheduledTasksCache>();
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let job_cache = &backend_manager.job_cache;
    let url = backend.url_for(job::STOP);

    let response = backend
        .inject_auth(app.state::<RcloneState>().client.post(&url))
        .json(&json!({ "jobid": jobid }))
        .send()
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    // "job not found" from rclone means it already cleaned up on its end.
    // We still mark our cache entry as stopped so the UI stays consistent.
    let rclone_accepted = if status.is_success() {
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

    if rclone_accepted {
        job_cache
            .stop_job(jobid, Some(&app))
            .await
            .map_err(|e| e.clone())?;

        if let Some(task) = scheduled_tasks_cache
            .get_task_by_job_id(jobid.to_string())
            .await
        {
            info!(
                "🛑 Job {} was associated with scheduled task '{}', marking task as stopped",
                jobid, task.name
            );
            scheduled_tasks_cache
                .update_task(
                    &task.id,
                    crate::utils::types::scheduled_task::ScheduledTask::mark_stopped,
                    Some(&app),
                )
                .await
                .map_err(|e| format!("Failed to update task state: {e}"))?;
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

/// Stop all running jobs in a group.
///
/// Group name format: `"type/remote[/profile]"` — e.g. `"sync/gdrive/default"`.
#[tauri::command]
pub async fn stop_jobs_by_group(app: AppHandle, group: String) -> Result<(), String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let job_cache = &backend_manager.job_cache;
    let url = backend.url_for(job::STOPGROUP);

    info!("🛑 Stopping all jobs in group: {group}");

    let response = backend
        .inject_auth(app.state::<RcloneState>().client.post(&url))
        .json(&json!({ "group": group }))
        .send()
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() && !body.contains("no jobs in group") {
        let error =
            crate::localized_error!("backendErrors.http.error", "status" => status, "body" => body);
        error!("❌ Failed to stop jobs in group {group}: {error}");
        return Err(error);
    }

    // Mirror the rclone stop in our local cache.
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
        format!("All jobs in group '{group}' stopped"),
        None,
    );

    info!("✅ All jobs in group '{group}' stopped");
    Ok(())
}

/// Submit a batch of job requests to run concurrently.
#[tauri::command]
pub async fn submit_batch_job(
    app: AppHandle,
    inputs: Vec<Value>,
    metadata_list: Option<Vec<JobMetadata>>,
    origin: Option<Origin>,
    group: Option<String>,
    job_type: JobType,
) -> Result<String, String> {
    let state = app.state::<RcloneState>();
    let num_inputs = inputs.len();
    log::debug!("📦 Submitting batch job with {num_inputs} inputs");

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let url = backend.url_for(crate::utils::rclone::endpoints::job::BATCH);

    let mut modified_inputs = Vec::new();
    let batch_id = uuid::Uuid::new_v4().to_string();
    let batch_group = group.clone().unwrap_or_else(|| format!("batch/{batch_id}"));

    for input in inputs {
        let mut inp = input.clone();
        if let Some(obj) = inp.as_object_mut() {
            if !obj.contains_key("_group") {
                obj.insert("_group".to_string(), json!(batch_group.clone()));
            }
            obj.insert("_async".to_string(), json!(true));
        }
        modified_inputs.push(inp);
    }

    let payload = json!({
        "inputs": modified_inputs,
    });

    let response = backend
        .inject_auth(state.client.post(&url))
        .json(&payload)
        .send()
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    let status = response.status();
    let body_text = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = crate::localized_error!("backendErrors.http.error", "status" => status, "body" => body_text);
        return Err(error);
    }

    let response_json: Value = serde_json::from_str(&body_text)
        .map_err(|e| crate::localized_error!("backendErrors.serve.parseFailed", "error" => e))?;

    let batch_master = crate::utils::types::jobs::BatchMasterJob {
        batch_id: batch_id.clone(),
        job_type: job_type.clone(),
        total_jobs: num_inputs,
        completed_jobs: 0,
        failed_jobs: 0,
        start_time: chrono::Utc::now(),
        end_time: None,
        status: JobStatus::Running,
        origin: origin.clone(),
        group: Some(batch_group.clone()),
    };

    backend_manager
        .job_cache
        .add_batch_job(batch_master, Some(&app))
        .await;

    if let Some(results) = response_json.get("results").and_then(|r| r.as_array()) {
        for (i, res) in results.iter().enumerate() {
            if let Ok((jobid, execute_id)) = parse_job_response(res) {
                let input_val = modified_inputs.get(i).unwrap();
                let _path_str = input_val
                    .get("_path")
                    .and_then(|p| p.as_str())
                    .unwrap_or("unknown");

                let mut metadata = if let Some(ref list) = metadata_list {
                    list.get(i).cloned().unwrap_or_else(|| JobMetadata {
                        remote_name: "batch".to_string(),
                        job_type: job_type.clone(),
                        source: String::new(),
                        destination: String::new(),
                        profile: None,
                        origin: origin.clone(),
                        group: Some(batch_group.clone()),
                        no_cache: false,
                    })
                } else {
                    JobMetadata {
                        remote_name: "batch".to_string(),
                        job_type: job_type.clone(),
                        source: String::new(),
                        destination: String::new(),
                        profile: None,
                        origin: origin.clone(),
                        group: Some(batch_group.clone()),
                        no_cache: false,
                    }
                };

                // Ensure the group is set correctly for batch tracking
                metadata.group = Some(batch_group.clone());

                let backend_name = backend.name.clone();

                backend_manager
                    .job_cache
                    .add_job(
                        JobInfo {
                            jobid,
                            job_type: metadata.job_type.clone(),
                            remote_name: metadata.remote_name.clone(),
                            source: metadata.source.clone(),
                            destination: metadata.destination.clone(),
                            start_time: chrono::Utc::now(),
                            end_time: None,
                            status: JobStatus::Running,
                            error: None,
                            stats: None,
                            uploaded_files: Vec::new(),
                            group: batch_group.clone(),
                            profile: metadata.profile.clone(),
                            origin: metadata.origin.clone(),
                            backend_name: backend_name.clone(),
                            execute_id: execute_id.clone(),
                            parent_batch_id: Some(batch_id.clone()),
                        },
                        Some(&app),
                    )
                    .await;

                let app_clone = app.clone();
                let client_clone = state.client.clone();

                tauri::async_runtime::spawn(async move {
                    let _ =
                        monitor_job(backend_name, metadata, jobid, app_clone, client_clone).await;
                });
            }
        }
    }

    Ok(batch_id)
}

// Tests for JobMetadata and NotificationEvent constructors.

#[cfg(test)]
mod tests {
    use super::*;

    // JobMetadata::group_name tests

    #[test]
    fn test_group_name_generation() {
        let meta = JobMetadata {
            remote_name: "gdrive:".to_string(),
            job_type: JobType::Sync,
            source: "src".to_string(),
            destination: "dst".to_string(),
            profile: None,
            origin: None,
            group: None,
            no_cache: false,
        };
        assert_eq!(meta.group_name(), "sync/gdrive");
    }

    #[test]
    fn test_group_name_with_profile() {
        let meta = JobMetadata {
            remote_name: "gdrive:".to_string(),
            job_type: JobType::Sync,
            source: "src".to_string(),
            destination: "dst".to_string(),
            profile: Some("daily".to_string()),
            origin: None,
            group: None,
            no_cache: false,
        };
        assert_eq!(meta.group_name(), "sync/gdrive/daily");
    }

    #[test]
    fn test_custom_group_name_takes_precedence() {
        let meta = JobMetadata {
            remote_name: "gdrive:".to_string(),
            job_type: JobType::Sync,
            source: "src".to_string(),
            destination: "dst".to_string(),
            profile: None,
            origin: None,
            group: Some("custom/group".to_string()),
            no_cache: true,
        };
        assert_eq!(meta.group_name(), "custom/group");
    }

    #[test]
    fn test_group_name_different_job_types() {
        let cases = [
            (JobType::Sync, "gdrive:", "sync/gdrive"),
            (JobType::Copy, "onedrive:", "copy/onedrive"),
            (JobType::Move, "dropbox:", "move/dropbox"),
            (JobType::Bisync, "box:", "bisync/box"),
            (JobType::Mount, "s3:", "mount/s3"),
            (JobType::Serve, "local:", "serve/local"),
            (JobType::CopyUrl, "remote:", "copy_url/remote"),
        ];
        for (job_type, remote_name, expected) in cases {
            let meta = JobMetadata {
                remote_name: remote_name.to_string(),
                job_type: job_type.clone(),
                source: "src".to_string(),
                destination: "dst".to_string(),
                profile: None,
                origin: None,
                group: None,
                no_cache: false,
            };
            assert_eq!(meta.group_name(), expected, "Failed for {:?}", job_type);
        }
    }

    // Notification event methods
    // These tests verify the NotificationEvent constructors used by production.

    fn make_meta(origin: Option<Origin>, profile: Option<&str>) -> JobMetadata {
        JobMetadata {
            remote_name: "gdrive:".to_string(),
            job_type: JobType::Sync,
            source: "src".to_string(),
            destination: "dst".to_string(),
            profile: profile.map(str::to_string),
            origin,
            group: None,
            no_cache: false,
        }
    }

    #[test]
    fn test_started_event() {
        let meta = make_meta(Some(Origin::FileManager), Some("daily"));
        match meta.started_event() {
            NotificationEvent::JobStarted {
                remote,
                profile,
                job_type,
                origin,
            } => {
                assert_eq!(remote, "gdrive:");
                assert_eq!(profile, Some("daily".to_string()));
                assert_eq!(job_type, JobType::Sync);
                assert_eq!(origin, Origin::FileManager);
            }
            _ => panic!("expected JobStarted"),
        }
    }

    #[test]
    fn test_completed_event_defaults_origin_to_system() {
        let meta = make_meta(None, None);
        match meta.completed_event() {
            NotificationEvent::JobCompleted {
                remote,
                profile,
                job_type,
                origin,
            } => {
                assert_eq!(remote, "gdrive:");
                assert_eq!(profile, None);
                assert_eq!(job_type, JobType::Sync);
                assert_eq!(origin, Origin::Internal);
            }
            _ => panic!("expected JobCompleted"),
        }
    }

    #[test]
    fn test_failed_event_carries_error_message() {
        let meta = make_meta(None, Some("p"));
        match meta.failed_event("disk full") {
            NotificationEvent::JobFailed {
                remote,
                profile,
                job_type,
                error,
                origin,
            } => {
                assert_eq!(remote, "gdrive:");
                assert_eq!(profile, Some("p".to_string()));
                assert_eq!(job_type, JobType::Sync);
                assert_eq!(error, "disk full");
                assert_eq!(origin, Origin::Internal);
            }
            _ => panic!("expected JobFailed"),
        }
    }

    // parse_job_response tests

    #[test]
    fn test_parse_job_response_canonical() {
        let v = json!({ "jobid": 123u64, "executeId": "exec-1" });
        let (id, eid) = parse_job_response(&v).unwrap();
        assert_eq!(id, 123);
        assert_eq!(eid, Some("exec-1".to_string()));
    }

    #[test]
    fn test_parse_job_response_numeric_jobid_no_execute_id() {
        let v = json!({ "jobid": 99u64 });
        let (id, eid) = parse_job_response(&v).unwrap();
        assert_eq!(id, 99);
        assert_eq!(eid, None);
    }

    #[test]
    fn test_parse_job_response_legacy_string_id() {
        let v = json!({ "id": "42", "executeId": "e42" });
        let (id, eid) = parse_job_response(&v).unwrap();
        assert_eq!(id, 42);
        assert_eq!(eid, Some("e42".to_string()));
    }

    #[test]
    fn test_parse_job_response_missing_jobid_is_err() {
        assert!(parse_job_response(&json!({})).is_err());
    }
}
