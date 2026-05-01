use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::time::sleep;

use crate::{
    core::scheduler::engine::get_next_run,
    rclone::{backend::BackendManager, state::scheduled_tasks::ScheduledTasksCache},
    utils::{
        app::notification::{JobStage, NotificationEvent, TaskStage, notify},
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

const JOB_POLL_INTERVAL_MS: u64 = 500;
const MAX_CONSECUTIVE_ERRORS: u8 = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobMetadata {
    pub remote_name: String,
    pub job_type: JobType,
    pub source: String,
    pub destination: String,
    pub profile: Option<String>,
    pub origin: Option<Origin>,
    pub group: Option<String>,
    pub no_cache: bool,
}

impl JobMetadata {
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

    pub fn started_event(&self, backend: String) -> NotificationEvent {
        NotificationEvent::Job(JobStage::Started {
            backend,
            remote: self.remote_name.clone(),
            profile: self.profile.clone(),
            job_type: self.job_type.clone(),
            origin: self.resolved_origin(),
        })
    }

    pub fn completed_event(&self, backend: String) -> NotificationEvent {
        NotificationEvent::Job(JobStage::Completed {
            backend,
            remote: self.remote_name.clone(),
            profile: self.profile.clone(),
            job_type: self.job_type.clone(),
            origin: self.resolved_origin(),
        })
    }

    pub fn failed_event(&self, backend: String, error_msg: &str) -> NotificationEvent {
        NotificationEvent::Job(JobStage::Failed {
            backend,
            remote: self.remote_name.clone(),
            profile: self.profile.clone(),
            job_type: self.job_type.clone(),
            error: error_msg.to_string(),
            origin: self.resolved_origin(),
        })
    }

    fn stopped_event(&self, backend: String) -> NotificationEvent {
        NotificationEvent::Job(JobStage::Stopped {
            backend,
            remote: self.remote_name.clone(),
            profile: self.profile.clone(),
            job_type: self.job_type.clone(),
            origin: self.resolved_origin(),
        })
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
        initialize_and_register_job(&app, request, payload, metadata.clone()).await?;

    if options.wait_for_completion {
        monitor_job(backend_name, metadata, jobid, app.clone(), client.clone())
            .await
            .map_err(|e| e.to_string())?;
    } else {
        let app = app.clone();
        let client = client.clone();
        tauri::async_runtime::spawn(async move {
            let _ = monitor_job(backend_name, metadata, jobid, app, client).await;
        });
    }

    Ok((jobid, response_json, execute_id))
}

async fn initialize_and_register_job(
    app: &AppHandle,
    request: reqwest::RequestBuilder,
    payload: Value,
    metadata: JobMetadata,
) -> Result<(u64, String, Value, Option<String>), String> {
    let mut metadata = metadata;

    // Ensure unique group for ad-hoc jobs
    if metadata.group.is_none() && metadata.profile.is_none() {
        metadata.group = Some(format!(
            "{}_{}",
            metadata.group_name(),
            uuid::Uuid::new_v4().simple()
        ));
    }

    let (jobid, response_json, execute_id) = send_job_request(request, payload, &metadata).await?;

    let backend_manager = app.state::<BackendManager>();
    let backend_name = backend_manager.get_active().await.name;

    if !metadata.no_cache {
        add_job_to_cache(
            &backend_manager.job_cache,
            jobid,
            execute_id.clone(),
            &metadata,
            &backend_name,
            Some(app),
        )
        .await;
        if metadata.origin != Some(Origin::Scheduler) {
            notify(app, metadata.started_event(backend_name.clone()));
        }
    }

    Ok((jobid, backend_name, response_json, execute_id))
}

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
    execute_id: Option<String>,
    metadata: &JobMetadata,
    backend_name: &str,
    app: Option<&AppHandle>,
) {
    job_cache
        .create_job(
            jobid,
            execute_id,
            metadata.clone(),
            backend_name.to_string(),
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
        if !metadata.no_cache {
            let should_exit = job_cache
                .get_job(jobid)
                .await
                .is_none_or(|j| j.status == JobStatus::Stopped);

            if should_exit {
                info!("Monitoring for job {jobid} stopped: job removed or marked Stopped.");
                return handle_job_completion(
                    backend_name.clone(),
                    jobid,
                    &metadata,
                    json!({"finished": true, "success": false, "stopped": true}),
                    &app,
                    None,
                )
                .await;
            }
        }

        let stats_payload = if let Some(ref g) = metadata.group {
            json!({ "group": g })
        } else {
            json!({ "jobid": jobid })
        };

        let poll_result = if metadata.no_cache {
            backend
                .inject_auth(client.post(&job_status_url))
                .json(&json!({ "jobid": jobid }))
                .send()
                .await
                .map(|r| (r, None))
        } else {
            let status_req = backend
                .inject_auth(client.post(&job_status_url))
                .json(&json!({ "jobid": jobid }));

            let job_stats_req = backend
                .inject_auth(client.post(&stats_url))
                .json(&stats_payload);

            tokio::try_join!(status_req.send(), job_stats_req.send())
                .map(|(status_resp, stats_resp)| (status_resp, Some(stats_resp)))
        };

        match poll_result {
            Ok((status_resp, stats_resp_opt)) => {
                consecutive_errors = 0;

                if let Some(stats_resp) = stats_resp_opt
                    && let Ok(mut stats_val) = stats_resp.json::<Value>().await
                {
                    let transferred_req = backend
                        .inject_auth(client.post(
                            backend.url_for(crate::utils::rclone::endpoints::core::TRANSFERRED),
                        ))
                        .json(&stats_payload);

                    if let Ok(trans_resp) = transferred_req.send().await
                        && let Ok(trans_data) = trans_resp.json::<Value>().await
                        && let Some(obj) = stats_val.as_object_mut()
                    {
                        obj.insert(
                            "completed".to_string(),
                            trans_data.get("transferred").cloned().unwrap_or(json!([])),
                        );
                    }

                    let _ = job_cache.update_job_stats(jobid, stats_val).await;
                }

                if let Ok(job_status) = status_resp
                    .json::<crate::utils::types::jobs::JobStatusResponse>()
                    .await
                    && job_status.finished
                {
                    return handle_job_completion(
                        backend_name.clone(),
                        jobid,
                        &metadata,
                        serde_json::to_value(job_status).unwrap_or(json!({})),
                        &app,
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
    backend_name: String,
    jobid: u64,
    metadata: &JobMetadata,
    job_status: Value,
    app: &AppHandle,
    last_stats: Option<Value>,
) -> Result<Value, RcloneError> {
    let job_cache = &app.state::<BackendManager>().job_cache;
    let scheduled_tasks_cache = app.state::<ScheduledTasksCache>();
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
        let final_stats = collect_final_stats(app, metadata, last_stats).await;
        if !final_stats.is_null() && final_stats != json!({}) {
            let _ = job_cache.update_job_stats(jobid, final_stats).await;
        }

        spawn_stats_cleanup(app, metadata);

        let _ = job_cache
            .complete_job(
                jobid,
                success,
                (!error_msg.is_empty()).then(|| error_msg.clone()),
                if stopped { None } else { Some(app) },
            )
            .await;
    }

    if let Some(task) = task {
        let task_name = format!(
            "{}: {}-{}.{}",
            task.backend_name, task.remote_name, task.profile_name, task.id
        );

        info!("Job {jobid} associated with scheduled task '{task_name}', updating status.");

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

            notify(
                app,
                NotificationEvent::ScheduledTask(TaskStage::Completed {
                    backend: task.backend_name.clone(),
                    remote: task.remote_name.clone(),
                    profile: task.profile_name.clone(),
                    task_name: task.display_name(),
                    task_type: task.task_type.clone(),
                }),
            );
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

            notify(
                app,
                NotificationEvent::ScheduledTask(TaskStage::Failed {
                    backend: task.backend_name.clone(),
                    remote: task.remote_name.clone(),
                    profile: task.profile_name.clone(),
                    task_name: task.display_name(),
                    task_type: task.task_type.clone(),
                    error: error_msg.clone(),
                }),
            );
        }
    }

    if stopped {
        info!("{} Job {jobid} stopped by user.", metadata.job_type);
        if !metadata.no_cache && metadata.origin != Some(Origin::Scheduler) {
            notify(app, metadata.stopped_event(backend_name.clone()));
        }
        return Ok(job_status.get("output").cloned().unwrap_or(json!({})));
    }

    if !success {
        if !metadata.no_cache && metadata.origin != Some(Origin::Scheduler) {
            log_operation(
                LogLevel::Error,
                Some(metadata.remote_name.clone()),
                Some(metadata.job_type.to_string()),
                format!("{} Job {jobid} failed: {error_msg}", metadata.job_type),
                Some(json!({"jobid": jobid, "status": job_status})),
            );
            notify(app, metadata.failed_event(backend_name.clone(), &error_msg));
        }
        return Err(RcloneError::JobError(error_msg));
    }

    if !metadata.no_cache && metadata.origin != Some(Origin::Scheduler) {
        log_operation(
            LogLevel::Info,
            Some(metadata.remote_name.clone()),
            Some(metadata.job_type.to_string()),
            format!("{} Job {jobid} completed successfully", metadata.job_type),
            Some(json!({"jobid": jobid, "status": job_status})),
        );
        notify(app, metadata.completed_event(backend_name.clone()));
    }

    Ok(job_status.get("output").cloned().unwrap_or(json!({})))
}

async fn collect_final_stats(
    app: &AppHandle,
    metadata: &JobMetadata,
    last_stats: Option<Value>,
) -> Value {
    let backend = app.state::<BackendManager>().get_active().await;
    let client = &app.state::<RcloneState>().client;
    let group = metadata.group_name();

    let needs_stats_fetch = last_stats
        .as_ref()
        .is_none_or(|s| s.is_null() || s == &json!({}));

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

    let mut final_stats = if needs_stats_fetch {
        match stats_send_result {
            Some(resp) => resp.json::<Value>().await.unwrap_or(json!({})),
            None => json!({}),
        }
    } else {
        last_stats.unwrap_or(json!({}))
    };

    if let Ok(resp) = transferred_send_result
        && let Ok(data) = resp.json::<Value>().await
        && let Some(obj) = final_stats.as_object_mut()
    {
        obj.insert(
            "completed".to_string(),
            data.get("transferred").cloned().unwrap_or(json!([])),
        );
    }

    final_stats
}

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

    if status.is_success() {
        // accepted
    } else if status.as_u16() == 500 && body.contains("\"job not found\"") {
        log_operation(
            LogLevel::Warn,
            Some(remote_name.clone()),
            Some("Stop job".to_string()),
            format!("Job {jobid} not found in rclone, marking as stopped"),
            None,
        );
        warn!("Job {jobid} not found in rclone, marking as stopped.");
    } else {
        let error =
            crate::localized_error!("backendErrors.http.error", "status" => status, "body" => body);
        error!("Failed to stop job {jobid}: {error}");
        return Err(error);
    }

    job_cache
        .stop_job(jobid, Some(&app))
        .await
        .map_err(|e| e.clone())?;

    if let Some(task) = scheduled_tasks_cache
        .get_task_by_job_id(jobid.to_string())
        .await
    {
        let task_name = format!(
            "{}: {}-{}.{}",
            task.backend_name, task.remote_name, task.profile_name, task.id
        );
        info!("Job {jobid} associated with scheduled task '{task_name}', marking as stopped");
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

    info!("Stopped job {jobid}");
    Ok(())
}

#[tauri::command]
pub async fn stop_jobs_by_group(app: AppHandle, group: String) -> Result<(), String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let job_cache = &backend_manager.job_cache;
    let url = backend.url_for(job::STOPGROUP);

    info!("Stopping all jobs in group: {group}");

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
        error!("Failed to stop jobs in group {group}: {error}");
        return Err(error);
    }

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
    info!("All jobs in group '{group}' stopped");
    Ok(())
}

#[tauri::command]
pub async fn submit_batch_job(
    app: AppHandle,
    inputs: Vec<Value>,
    metadata: JobMetadata,
) -> Result<String, String> {
    let state = app.state::<RcloneState>();
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let url = backend.url_for(crate::utils::rclone::endpoints::job::BATCH);

    let mut metadata = metadata;
    let base_group = metadata.group_name();

    // For ad-hoc jobs (no explicit group and no profile), make the group unique
    // to prevent stats overlap in Rclone and the Operations Panel.
    let final_group = if metadata.group.is_none() && metadata.profile.is_none() {
        format!("{}_{}", base_group, uuid::Uuid::new_v4().simple())
    } else {
        base_group
    };

    metadata.group = Some(final_group.clone());
    let batch_group = final_group;

    let modified_inputs: Vec<Value> = inputs
        .into_iter()
        .map(|mut inp| {
            if let Some(obj) = inp.as_object_mut()
                && !obj.contains_key("_group")
            {
                obj.insert("_group".to_string(), json!(batch_group));
            }
            inp
        })
        .collect();

    let payload = json!({
        "_async": true,
        "inputs": modified_inputs,
    });

    let response = backend
        .inject_auth(state.client.post(&url))
        .json(&payload)
        .send()
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    let response_json: Value = response
        .json()
        .await
        .map_err(|e| crate::localized_error!("backendErrors.serve.parseFailed", "error" => e))?;

    let (jobid, execute_id) = parse_job_response(&response_json)?;

    if !metadata.no_cache {
        add_job_to_cache(
            &backend_manager.job_cache,
            jobid,
            execute_id.clone(),
            &metadata,
            &backend.name,
            Some(&app),
        )
        .await;

        if metadata.origin != Some(Origin::Scheduler) {
            notify(&app, metadata.started_event(backend.name.clone()));
        }
    }

    let client = state.client.clone();
    let backend_name = backend.name.clone();
    tauri::async_runtime::spawn(async move {
        let _ = monitor_job(backend_name, metadata, jobid, app, client).await;
    });

    Ok(jobid.to_string())
}

#[tauri::command]
pub async fn register_preparing_job(
    app: tauri::AppHandle,
    jobid: u64,
    remote: String,
    destination: String,
    total_files: usize,
    total_bytes: u64,
    origin: Option<Origin>,
) -> Result<(), String> {
    let backend_manager = app.state::<crate::rclone::backend::BackendManager>();
    let backend_name = backend_manager.get_active().await.name;
    let job_cache = &backend_manager.job_cache;

    let metadata = JobMetadata {
        remote_name: remote,
        job_type: JobType::Upload,
        source: "preparing".to_string(),
        destination,
        profile: None,
        origin,
        group: None,
        no_cache: false,
    };

    job_cache
        .create_job(jobid, None, metadata, backend_name, Some(&app))
        .await;

    let stats = json!({
        "totalBytes": total_bytes,
        "bytes": 0,
        "transfers": 0,
        "totalTransfers": total_files,
        "completed": [],
        "transferring": [],
        "preparing": true
    });

    job_cache.update_job_stats(jobid, stats).await.ok();
    Ok(())
}

#[tauri::command]
pub async fn update_job_stats(
    app: tauri::AppHandle,
    jobid: u64,
    stats: Value,
) -> Result<(), String> {
    let backend_manager = app.state::<crate::rclone::backend::BackendManager>();
    backend_manager
        .job_cache
        .update_job_stats(jobid, stats)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

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
        match meta.started_event("test-backend".to_string()) {
            NotificationEvent::Job(JobStage::Started {
                backend,
                remote,
                profile,
                job_type,
                origin,
            }) => {
                assert_eq!(backend, "test-backend");
                assert_eq!(remote, "gdrive:");
                assert_eq!(profile, Some("daily".to_string()));
                assert_eq!(job_type, JobType::Sync);
                assert_eq!(origin, Origin::FileManager);
            }
            _ => panic!("expected JobStage::Started"),
        }
    }

    #[test]
    fn test_completed_event_defaults_origin_to_system() {
        let meta = make_meta(None, None);
        match meta.completed_event("test-backend".to_string()) {
            NotificationEvent::Job(JobStage::Completed {
                backend,
                remote,
                profile,
                job_type,
                origin,
            }) => {
                assert_eq!(backend, "test-backend");
                assert_eq!(remote, "gdrive:");
                assert_eq!(profile, None);
                assert_eq!(job_type, JobType::Sync);
                assert_eq!(origin, Origin::Internal);
            }
            _ => panic!("expected JobStage::Completed"),
        }
    }

    #[test]
    fn test_failed_event_carries_error_message() {
        let meta = make_meta(None, Some("p"));
        match meta.failed_event("test-backend".to_string(), "disk full") {
            NotificationEvent::Job(JobStage::Failed {
                backend,
                remote,
                profile,
                job_type,
                error,
                origin,
            }) => {
                assert_eq!(backend, "test-backend");
                assert_eq!(remote, "gdrive:");
                assert_eq!(profile, Some("p".to_string()));
                assert_eq!(job_type, JobType::Sync);
                assert_eq!(error, "disk full");
                assert_eq!(origin, Origin::Internal);
            }
            _ => panic!("expected JobStage::Failed"),
        }
    }

    #[test]
    fn test_parse_job_response_numeric_and_execute() {
        let v = json!({"jobid": 123, "executeId": "exec-1"});
        let res = super::parse_job_response(&v).unwrap();
        assert_eq!(res.0, 123);
        assert_eq!(res.1, Some("exec-1".to_string()));
    }

    #[test]
    fn test_parse_job_response_string_id() {
        let v = json!({"id": "456"});
        let res = super::parse_job_response(&v).unwrap();
        assert_eq!(res.0, 456);
        assert_eq!(res.1, None);
    }

    #[test]
    fn test_parse_job_response_missing_id_returns_err() {
        let v = json!({"executeId": "no-job"});
        assert!(super::parse_job_response(&v).is_err());
    }
}
