use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::time::sleep;

use crate::{
    core::automation::engine::get_next_run,
    rclone::{
        backend::{BackendError, BackendManager},
        state::automations::AutomationsCache,
    },
    utils::{
        app::notification::{AutomationStage, JobStage, NotificationEvent, notify},
        logging::log::log_operation,
        rclone::endpoints::{core, job},
        types::{
            jobs::{JobCache, JobInfo, JobStatus, JobType},
            logs::LogLevel,
            origin::Origin,
            state::RcloneState,
        },
    },
};

use super::common::redact_value;
use super::system::RcloneError;

const JOB_POLL_INTERVAL_MS: u64 = 500;
const MAX_CONSECUTIVE_ERRORS: u8 = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobMetadata {
    pub remote_name: String,
    pub job_type: JobType,
    pub source: Vec<String>,
    pub destination: String,
    pub profile: Option<String>,
    pub origin: Option<Origin>,
    pub group: Option<String>,
    pub no_cache: bool,
    /// True when the job was submitted with `DryRun: true` (no actual changes).
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub parent_job_id: Option<u64>,
}

impl JobMetadata {
    pub fn group_name(&self) -> String {
        let remote = self
            .remote_name
            .trim_end_matches(':')
            .trim_end_matches('/')
            .to_string();

        self.group.clone().unwrap_or_else(|| {
            let job_type_str = match self.job_type {
                JobType::CopyUrl => "copyurl".to_string(),
                _ => self.job_type.to_string(),
            };
            match &self.profile {
                Some(profile) => format!("{}/{}/{}", job_type_str, remote, profile),
                None => format!("{}/{}", job_type_str, remote),
            }
        })
    }

    fn resolved_origin(&self) -> Origin {
        self.origin.clone().unwrap_or(Origin::Internal)
    }

    fn create_job_stage<F>(&self, backend: String, stage_fn: F) -> NotificationEvent
    where
        F: FnOnce(
            String,
            String,
            Option<String>,
            JobType,
            Origin,
            Option<String>,
            Option<String>,
        ) -> JobStage,
    {
        NotificationEvent::Job(stage_fn(
            backend,
            self.remote_name.clone(),
            self.profile.clone(),
            self.job_type.clone(),
            self.resolved_origin(),
            Some(self.source.join(", ")),
            Some(self.destination.clone()),
        ))
    }

    pub fn started_event(&self, backend: String) -> NotificationEvent {
        self.create_job_stage(backend, |b, r, p, jt, o, s, d| JobStage::Started {
            backend: b,
            remote: r,
            profile: p,
            job_type: jt,
            origin: o,
            source: s,
            destination: d,
        })
    }

    pub fn completed_event(&self, backend: String) -> NotificationEvent {
        self.create_job_stage(backend, |b, r, p, jt, o, s, d| JobStage::Completed {
            backend: b,
            remote: r,
            profile: p,
            job_type: jt,
            origin: o,
            source: s,
            destination: d,
        })
    }

    pub fn failed_event(&self, backend: String, error_msg: &str) -> NotificationEvent {
        let error = error_msg.to_string();
        self.create_job_stage(backend, move |b, r, p, jt, o, s, d| JobStage::Failed {
            backend: b,
            remote: r,
            profile: p,
            job_type: jt,
            error,
            origin: o,
            source: s,
            destination: d,
        })
    }

    fn stopped_event(&self, backend: String) -> NotificationEvent {
        self.create_job_stage(backend, |b, r, p, jt, o, s, d| JobStage::Stopped {
            backend: b,
            remote: r,
            profile: p,
            job_type: jt,
            origin: o,
            source: s,
            destination: d,
        })
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SubmitJobOptions {
    pub wait_for_completion: bool,
}

pub async fn submit_job_with_options(
    app: AppHandle,
    endpoint: &str,
    payload: Value,
    metadata: JobMetadata,
    options: SubmitJobOptions,
) -> Result<(u64, Value, Option<String>), String> {
    let (jobid, backend_name, response_json, execute_id) =
        initialize_and_register_job(&app, endpoint, payload, metadata.clone()).await?;

    if options.wait_for_completion {
        monitor_job(backend_name, metadata, jobid, app.clone())
            .await
            .map_err(|e| e.to_string())?;
    } else {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = monitor_job(backend_name, metadata, jobid, app).await;
        });
    }

    Ok((jobid, response_json, execute_id))
}

async fn initialize_and_register_job(
    app: &AppHandle,
    endpoint: &str,
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

    let (jobid, response_json, execute_id) =
        send_job_request(app, endpoint, payload, &metadata).await?;

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
        if metadata.job_type != JobType::Mount {
            notify(app, metadata.started_event(backend_name.clone()));
        }
    }

    Ok((jobid, backend_name, response_json, execute_id))
}

async fn send_job_request(
    app: &AppHandle,
    endpoint: &str,
    payload: Value,
    metadata: &JobMetadata,
) -> Result<(u64, Value, Option<String>), String> {
    let mut payload = payload;
    if let Some(obj) = payload.as_object_mut()
        && !obj.contains_key("_group")
    {
        obj.insert("_group".to_string(), json!(metadata.group_name()));
    }

    let transport = app.state::<RcloneState>().transport.clone();
    let response_json = transport
        .rpc(endpoint, Some(&payload))
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    let (jobid, execute_id) = parse_job_response(&response_json)?;

    let redacted_payload = redact_value(&payload, app);

    log_operation(
        LogLevel::Info,
        Some(metadata.remote_name.clone()),
        Some(metadata.job_type.to_string()),
        format!(
            "{} started with ID {} (ExecuteID: {:?})",
            metadata.job_type, jobid, execute_id
        ),
        Some(json!({
            "jobid": jobid,
            "executeId": execute_id,
            "arguments": redacted_payload,
        })),
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
    info!("Deleting job with ID: {jobid}");
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
) -> Result<Value, RcloneError> {
    let transport = app.state::<RcloneState>().transport.clone();
    let backend_manager = app.state::<BackendManager>();

    let job_cache = &backend_manager.job_cache;

    info!(
        "Starting monitoring for job {jobid} ({})",
        metadata.job_type
    );

    let mut consecutive_errors = 0u8;

    let mut inputs = vec![json!({ "_path": job::STATUS, "jobid": jobid })];
    if !metadata.no_cache {
        let group = metadata.group_name();
        inputs.push(json!({ "_path": core::STATS, "group": group }));
        inputs.push(json!({ "_path": core::TRANSFERRED, "group": group }));
    }

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

        let poll_result = transport
            .rpc(job::BATCH, Some(&json!({ "inputs": &inputs })))
            .await;

        match poll_result {
            Ok(batch_resp) => {
                consecutive_errors = 0;

                if let Some(results) = batch_resp["results"].as_array() {
                    if results.is_empty() {
                        warn!("Job {jobid} batch returned empty results array");
                        consecutive_errors += 1;
                        sleep(Duration::from_millis(JOB_POLL_INTERVAL_MS)).await;
                        continue;
                    }

                    let status_result = &results[0];

                    if status_result.is_null() {
                        warn!("Job {jobid} status result is null");
                        consecutive_errors += 1;
                        sleep(Duration::from_millis(JOB_POLL_INTERVAL_MS)).await;
                        continue;
                    }

                    if !metadata.no_cache && results.len() >= 3 {
                        let stats_result = &results[1];
                        let trans_result = &results[2];

                        if !stats_result.is_null() {
                            let mut stats_val = stats_result.clone();
                            if let Some(obj) = stats_val.as_object_mut() {
                                obj.insert(
                                    "completed".to_string(),
                                    trans_result
                                        .get("transferred")
                                        .cloned()
                                        .unwrap_or(json!([])),
                                );
                            }
                            let _ = job_cache.update_job_stats(jobid, stats_val).await;
                        }
                    }

                    if status_result["finished"].as_bool().unwrap_or(false) {
                        return handle_job_completion(
                            backend_name.clone(),
                            jobid,
                            &metadata,
                            status_result.clone(),
                            &app,
                            None,
                        )
                        .await;
                    }
                }
            }
            Err(e) => {
                consecutive_errors += 1;
                warn!(
                    "Job {jobid} monitor error ({consecutive_errors}/{MAX_CONSECUTIVE_ERRORS}): {e}"
                );

                if consecutive_errors >= MAX_CONSECUTIVE_ERRORS {
                    let error_msg =
                        format!("Monitoring failed after {MAX_CONSECUTIVE_ERRORS} attempts: {e}");

                    if !metadata.no_cache {
                        let dummy_status = json!({
                            "finished": true,
                            "success": false,
                            "error": error_msg
                        });
                        let _ = handle_job_completion(
                            backend_name.clone(),
                            jobid,
                            &metadata,
                            dummy_status,
                            &app,
                            None,
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
    let automations_cache = app.state::<AutomationsCache>();
    let mut success = job_status
        .get("success")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let stopped = job_status
        .get("stopped")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let mut error_msg = job_status
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    let mut cryptcheck_output = None;

    // Special handling for rclone jobs where rclone reports success: true
    // but individual items failed (batch) or the command failed (core/command).
    if success && let Some(output) = job_status.get("output") {
        if metadata.job_type == JobType::CryptCheck
            && let Some(result_str) = output.get("result").and_then(|v| v.as_str())
        {
            let parsed = parse_cryptcheck_output(result_str);
            let first_result = parsed
                .get("results")
                .and_then(|r| r.as_array())
                .and_then(|a| a.first());
            let check_success = first_result
                .and_then(|r| r.get("success"))
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let check_status = first_result
                .and_then(|r| r.get("status"))
                .and_then(Value::as_str)
                .unwrap_or("OK")
                .to_string();

            let has_parsed_issues = first_result
                .and_then(|r| r.get("differ"))
                .and_then(|a| a.as_array())
                .is_some_and(|a| !a.is_empty())
                || first_result
                    .and_then(|r| r.get("missingOnDst"))
                    .and_then(|a| a.as_array())
                    .is_some_and(|a| !a.is_empty())
                || first_result
                    .and_then(|r| r.get("missingOnSrc"))
                    .and_then(|a| a.as_array())
                    .is_some_and(|a| !a.is_empty())
                || first_result
                    .and_then(|r| r.get("error"))
                    .and_then(|a| a.as_array())
                    .is_some_and(|a| !a.is_empty());

            if has_parsed_issues {
                success = check_success;
                if !success {
                    error_msg = check_status;
                }
            } else if output
                .get("error")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                success = false;
                error_msg = result_str.trim().to_string();
            } else {
                success = true;
                error_msg = String::new();
            }
            cryptcheck_output = Some(parsed);
        }

        // 1. Check for operations/batch results
        if let Some(results) = output.get("results").and_then(|v| v.as_array()) {
            for res in results {
                let has_error = res.get("success").and_then(serde_json::Value::as_bool)
                    == Some(false)
                    || res
                        .get("status")
                        .and_then(serde_json::Value::as_i64)
                        .is_some_and(|s| s >= 400)
                    || res.get("error").is_some_and(|e| match e {
                        Value::Null => false,
                        Value::Bool(b) => *b,
                        Value::String(s) => !s.trim().is_empty(),
                        Value::Array(arr) => !arr.is_empty(),
                        Value::Object(obj) => !obj.is_empty(),
                        _ => true,
                    });

                if has_error {
                    success = false;
                    let err = if let Some(e) = res.get("error") {
                        let formatted = match e {
                            Value::String(s) => s.clone(),
                            Value::Array(arr) => arr
                                .iter()
                                .filter_map(|v| v.as_str())
                                .collect::<Vec<_>>()
                                .join(", "),
                            _ => e.to_string(),
                        };
                        if formatted.trim().is_empty() {
                            if metadata.job_type == JobType::Check {
                                res.get("status")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("Differences found")
                                    .to_string()
                            } else {
                                "Unknown error".to_string()
                            }
                        } else {
                            formatted
                        }
                    } else if metadata.job_type == JobType::Check {
                        res.get("status")
                            .and_then(|v| v.as_str())
                            .unwrap_or("Differences found")
                            .to_string()
                    } else {
                        "Unknown error".to_string()
                    };

                    if !err.is_empty() {
                        let source_str = metadata.source.join(", ");
                        let item_name = res
                            .get("input")
                            .and_then(|i| {
                                i.get("srcRemote")
                                    .or_else(|| i.get("remote"))
                                    .or_else(|| i.get("dstRemote"))
                                    .or_else(|| i.get("path1"))
                                    .or_else(|| i.get("path2"))
                            })
                            .and_then(|v| v.as_str())
                            .unwrap_or(&source_str);

                        let full_err = format!("{item_name}: {err}");
                        if error_msg.is_empty() {
                            error_msg = full_err;
                        } else if !error_msg.contains(&full_err) {
                            error_msg = format!("{error_msg}; {full_err}");
                        }
                    }
                }
            }
        }

        // 2. Check for individual command error (e.g. core/command)
        if success
            && output
                .get("error")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        {
            success = false;
            if let Some(result) = output.get("result").and_then(|v| v.as_str())
                && !result.trim().is_empty()
            {
                error_msg = result.trim().to_string();
            }
        }

        // 3. Check for check operation results (e.g. operations/check)
        if success && metadata.job_type == JobType::Check {
            let check_obj = if let Some(results) = output.get("results").and_then(|v| v.as_array())
            {
                results.first()
            } else {
                Some(output)
            };
            if let Some(check_obj) = check_obj
                && let Some(check_success) = check_obj
                    .get("success")
                    .and_then(serde_json::Value::as_bool)
                && !check_success
            {
                success = false;
                error_msg = check_obj
                    .get("status")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("Differences found")
                    .to_string();
            }
        }
    }

    let automation = automations_cache
        .get_automation_by_job_id(jobid.to_string())
        .await;
    let next_run = automation.as_ref().and_then(|t| {
        t.cron_expression
            .as_ref()
            .and_then(|expr| get_next_run(expr).ok())
    });

    if !metadata.no_cache {
        let mut final_stats = collect_final_stats(app, metadata, last_stats).await;
        if final_stats.is_null() || final_stats == serde_json::json!({}) {
            final_stats = serde_json::json!({});
        }
        if let Some(obj) = final_stats.as_object_mut() {
            if metadata.job_type == JobType::Check
                && let Some(output) = job_status.get("output")
            {
                obj.insert("checkOutput".to_string(), output.clone());
            } else if metadata.job_type == JobType::CryptCheck
                && let Some(parsed) = &cryptcheck_output
            {
                obj.insert("checkOutput".to_string(), parsed.clone());
            }
        }
        if !final_stats.is_null() && final_stats != serde_json::json!({}) {
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

    if let Some(automation) = automation {
        let automation_name = automation.log_name();

        info!("Job {jobid} associated with automation '{automation_name}', updating status.");

        if success {
            automations_cache
                .update_automation(
                    &automation.id,
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
                NotificationEvent::Automation(AutomationStage::Completed {
                    backend: automation.backend_name.clone(),
                    remote: automation.remote_name.clone(),
                    profile: automation.profile_name.clone(),
                    automation_name: automation.display_name(),
                    automation_type: automation.automation_type,
                }),
            );
        } else if stopped {
            automations_cache
                .update_automation(
                    &automation.id,
                    |t| {
                        t.mark_stopped();
                        t.next_run = next_run;
                    },
                    Some(app),
                )
                .await
                .map_err(RcloneError::JobError)?;

            notify(
                app,
                NotificationEvent::Automation(AutomationStage::Stopped {
                    backend: automation.backend_name.clone(),
                    remote: automation.remote_name.clone(),
                    profile: automation.profile_name.clone(),
                    automation_name: automation.display_name(),
                    automation_type: automation.automation_type,
                }),
            );
        } else {
            automations_cache
                .update_automation(
                    &automation.id,
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
                NotificationEvent::Automation(AutomationStage::Failed {
                    backend: automation.backend_name.clone(),
                    remote: automation.remote_name.clone(),
                    profile: automation.profile_name.clone(),
                    automation_name: automation.display_name(),
                    automation_type: automation.automation_type,
                    error: error_msg.clone(),
                }),
            );
        }
    }

    if stopped {
        info!("{} Job {jobid} stopped by user.", metadata.job_type);
        if !metadata.no_cache {
            notify(app, metadata.stopped_event(backend_name.clone()));
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
            notify(app, metadata.failed_event(backend_name.clone(), &error_msg));
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
        if metadata.job_type != JobType::Mount {
            notify(app, metadata.completed_event(backend_name.clone()));
        }
    }

    Ok(job_status.get("output").cloned().unwrap_or(json!({})))
}

async fn collect_final_stats(
    app: &AppHandle,
    metadata: &JobMetadata,
    last_stats: Option<Value>,
) -> Value {
    let transport = app.state::<RcloneState>().transport.clone();
    let group = metadata.group_name();

    let needs_stats_fetch = last_stats
        .as_ref()
        .is_none_or(|s| s.is_null() || s == &json!({}));

    let stats_fut = async {
        if needs_stats_fetch {
            transport
                .rpc(core::STATS, Some(&json!({ "group": group })))
                .await
                .ok()
        } else {
            None
        }
    };
    let transferred_params = json!({ "group": group });
    let transferred_fut = transport.rpc(core::TRANSFERRED, Some(&transferred_params));

    let (stats_result, transferred_result) = tokio::join!(stats_fut, transferred_fut);

    let mut final_stats = if needs_stats_fetch {
        stats_result.unwrap_or(json!({}))
    } else {
        last_stats.unwrap_or(json!({}))
    };

    if let Ok(data) = transferred_result
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
    let transport = app.state::<RcloneState>().transport.clone();
    let group = metadata.group_name();

    tauri::async_runtime::spawn(async move {
        let _ = transport
            .rpc(core::STATS_DELETE, Some(&json!({ "group": group })))
            .await;
    });
}

#[tauri::command]
pub async fn stop_job(app: AppHandle, jobid: u64, remote_name: String) -> Result<(), String> {
    let backend_manager = app.state::<BackendManager>();
    let transport = app.state::<RcloneState>().transport.clone();
    let job_cache = &backend_manager.job_cache;

    let stop_result = transport
        .rpc_with_timeout(
            job::STOP,
            Some(&json!({ "jobid": jobid })),
            Duration::from_secs(10),
        )
        .await;

    match stop_result {
        Ok(_) => {}
        Err(BackendError::Rpc {
            status: 500,
            message,
            ..
        }) if message.contains("job not found") => {
            log_operation(
                LogLevel::Warn,
                Some(remote_name.clone()),
                Some("Stop job".to_string()),
                format!("Job {jobid} not found in rclone, marking as stopped"),
                None,
            );
            warn!("Job {jobid} not found in rclone, marking as stopped.");
        }
        Err(e) => {
            let error = e.to_string();
            error!("Failed to stop job {jobid}: {error}");
            return Err(error);
        }
    }

    job_cache
        .stop_job(jobid, Some(&app))
        .await
        .map_err(|e| e.clone())?;

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
    let transport = app.state::<RcloneState>().transport.clone();
    let job_cache = &backend_manager.job_cache;

    info!("Stopping all jobs in group: {group}");

    let stop_result = transport
        .rpc_with_timeout(
            job::STOPGROUP,
            Some(&json!({ "group": group })),
            Duration::from_secs(10),
        )
        .await;

    match stop_result {
        Ok(_) => {}
        Err(BackendError::Rpc { ref message, .. }) if message.contains("no jobs in group") => {}
        Err(e) => {
            let error = e.to_string();
            error!("Failed to stop jobs in group {group}: {error}");
            return Err(error);
        }
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
    let backend_manager = app.state::<BackendManager>();
    let transport = app.state::<RcloneState>().transport.clone();

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

    let response_json: Value = transport
        .rpc(job::BATCH, Some(&payload))
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    let (jobid, execute_id) = parse_job_response(&response_json)?;

    let backend_name = backend_manager.get_active_name().await;

    if !metadata.no_cache {
        add_job_to_cache(
            &backend_manager.job_cache,
            jobid,
            execute_id.clone(),
            &metadata,
            &backend_name,
            Some(&app),
        )
        .await;

        let redacted_payload = redact_value(&payload, &app);
        log_operation(
            LogLevel::Info,
            Some(metadata.remote_name.clone()),
            Some(metadata.job_type.to_string()),
            format!(
                "{} started with ID {} (ExecuteID: {:?})",
                metadata.job_type, jobid, execute_id
            ),
            Some(redacted_payload),
        );

        notify(&app, metadata.started_event(backend_name.clone()));
    }

    let backend_name_for_monitor = backend_name;
    tauri::async_runtime::spawn(async move {
        let _ = monitor_job(backend_name_for_monitor, metadata, jobid, app).await;
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
        source: vec!["preparing".to_string()],
        destination,
        profile: None,
        origin,
        group: None,
        no_cache: false,
        dry_run: false,
        parent_job_id: None,
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

fn parse_cryptcheck_output(raw_result: &str) -> Value {
    let mut differ = Vec::new();
    let mut missing_on_dst = Vec::new();
    let mut missing_on_src = Vec::new();
    let mut error_list = Vec::new();
    let mut success = true;
    let mut status = "OK".to_string();

    for line in raw_result.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let is_error = line.contains("ERROR :") || line.contains("ERROR:");
        let is_notice = line.contains("NOTICE:") || line.contains("NOTICE :");

        if is_error {
            let pos = line
                .find("ERROR :")
                .map(|p| p + 7)
                .or_else(|| line.find("ERROR:").map(|p| p + 6));
            if let Some(start_idx) = pos {
                let rest = &line[start_idx..];
                if let Some(colon_pos) = rest.find(':') {
                    let path = rest[..colon_pos].trim().to_string();
                    let msg = rest[colon_pos + 1..].trim();

                    if msg.contains("file not in Encrypted drive") {
                        missing_on_dst.push(path);
                    } else if msg.contains("file not in") {
                        missing_on_src.push(path);
                    } else if msg.to_lowercase().contains("differ") {
                        differ.push(path);
                    } else {
                        error_list.push(format!("{}: {}", path, msg));
                    }
                }
            }
        } else if is_notice {
            let pos = line
                .find("NOTICE :")
                .map(|p| p + 8)
                .or_else(|| line.find("NOTICE:").map(|p| p + 7));
            if let Some(start_idx) = pos {
                let rest = &line[start_idx..];
                if rest.contains("Skipping undecryptable dir name") {
                    if let Some(colon_pos) = rest.find(':') {
                        let path = rest[..colon_pos].trim().to_string();
                        let msg = rest[colon_pos + 1..].trim();
                        error_list.push(format!("{}: {}", path, msg));
                    }
                } else if rest.contains("differences found")
                    || (status == "OK"
                        && (rest.contains("errors while checking")
                            || rest.contains("files missing")))
                {
                    status = rest.trim().to_string();
                    success = false;
                }
            }
        }
    }

    let has_issues = !differ.is_empty()
        || !missing_on_dst.is_empty()
        || !missing_on_src.is_empty()
        || !error_list.is_empty();
    if has_issues {
        success = false;
        if status == "OK" {
            let mut parts = Vec::new();
            if !differ.is_empty() {
                parts.push(format!("{} differences", differ.len()));
            }
            if !missing_on_dst.is_empty() {
                parts.push(format!("{} missing on destination", missing_on_dst.len()));
            }
            if !missing_on_src.is_empty() {
                parts.push(format!("{} missing on source", missing_on_src.len()));
            }
            if !error_list.is_empty() {
                parts.push(format!("{} errors", error_list.len()));
            }
            status = format!("{} found", parts.join(", "));
        }
    }

    json!({
        "results": [
            {
                "success": success,
                "status": status,
                "differ": differ,
                "missingOnDst": missing_on_dst,
                "missingOnSrc": missing_on_src,
                "error": error_list,
            }
        ]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_meta(origin: Option<Origin>, profile: Option<&str>) -> JobMetadata {
        JobMetadata {
            remote_name: "gdrive:".to_string(),
            job_type: JobType::Sync,
            source: vec!["src".to_string()],
            destination: "dst".to_string(),
            profile: profile.map(str::to_string),
            origin,
            group: None,
            no_cache: false,
            dry_run: false,
            parent_job_id: None,
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
                ..
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
                ..
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
                ..
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

    #[test]
    fn test_parse_cryptcheck_output() {
        let raw = r#"
2026/06/19 21:38:00 NOTICE: Atatürk Üniversitesi: Skipping undecryptable dir name: illegal base32 data at input byte 4
2026/06/19 21:38:00 ERROR : bookmarks_6_18_26.html: file not in Encrypted drive 'crypt:'
2026/06/19 21:38:00 ERROR : Atatürk Üniversitesi/BITIRMEPROJESI.docx: file not in Encrypted drive 'crypt:'
2026/06/19 21:38:00 ERROR : source_missing.txt: file not in local directory
2026/06/19 21:38:00 ERROR : diff_file.txt: hashes differ
2026/06/19 21:38:00 ERROR : read_err.txt: read error: permission denied
2026/06/19 21:38:00 NOTICE: Encrypted drive 'crypt:': 283 files missing
2026/06/19 21:38:00 NOTICE: Encrypted drive 'crypt:': 283 differences found
2026/06/19 21:38:00 NOTICE: Encrypted drive 'crypt:': 283 errors while checking
2026/06/19 21:38:00 NOTICE: Failed to cryptcheck with 283 errors: last error was: 283 differences found
"#;
        let parsed = super::parse_cryptcheck_output(raw);
        let first_res = &parsed["results"][0];
        assert_eq!(first_res["success"].as_bool(), Some(false));
        assert!(
            first_res["status"]
                .as_str()
                .unwrap()
                .contains("283 differences found")
        );

        let missing_dst = first_res["missingOnDst"].as_array().unwrap();
        assert_eq!(missing_dst.len(), 2);
        assert_eq!(missing_dst[0], "bookmarks_6_18_26.html");
        assert_eq!(missing_dst[1], "Atatürk Üniversitesi/BITIRMEPROJESI.docx");

        let missing_src = first_res["missingOnSrc"].as_array().unwrap();
        assert_eq!(missing_src.len(), 1);
        assert_eq!(missing_src[0], "source_missing.txt");

        let differ = first_res["differ"].as_array().unwrap();
        assert_eq!(differ.len(), 1);
        assert_eq!(differ[0], "diff_file.txt");

        let errors = first_res["error"].as_array().unwrap();
        assert_eq!(errors.len(), 2);
        assert_eq!(
            errors[0],
            "Atatürk Üniversitesi: Skipping undecryptable dir name: illegal base32 data at input byte 4"
        );
        assert_eq!(errors[1], "read_err.txt: read error: permission denied");
    }
}
