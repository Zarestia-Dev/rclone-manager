use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::time::sleep;

use crate::{
    core::{automation::engine::get_next_run, bridge},
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
use super::job_parser::{JobOutcome, parse_job_response, resolve_job_outcome};
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
    #[serde(default)]
    pub quick_run_id: Option<String>,
    #[serde(default)]
    pub execute_id: Option<String>,
}

impl JobMetadata {
    #[must_use]
    pub fn new(
        remote_name: impl Into<String>,
        job_type: JobType,
        source: Vec<String>,
        destination: impl Into<String>,
    ) -> Self {
        Self {
            remote_name: remote_name.into(),
            job_type,
            source,
            destination: destination.into(),
            profile: None,
            origin: None,
            group: None,
            no_cache: false,
            dry_run: false,
            parent_job_id: None,
            quick_run_id: None,
            execute_id: None,
        }
    }

    #[must_use]
    pub fn with_origin(mut self, origin: Option<Origin>) -> Self {
        self.origin = origin;
        self
    }

    #[must_use]
    pub fn with_group(mut self, group: Option<String>) -> Self {
        self.group = group;
        self
    }

    #[must_use]
    pub fn with_profile(mut self, profile: Option<String>) -> Self {
        self.profile = profile;
        self
    }

    #[must_use]
    pub fn with_execute_id(mut self, execute_id: Option<String>) -> Self {
        self.execute_id = execute_id;
        self
    }

    #[must_use]
    pub fn with_quick_run_id(mut self, quick_run_id: Option<String>) -> Self {
        self.quick_run_id = quick_run_id;
        self
    }

    #[must_use]
    pub fn with_dry_run(mut self, dry_run: bool) -> Self {
        self.dry_run = dry_run;
        self
    }

    #[must_use]
    pub fn with_no_cache(mut self, no_cache: bool) -> Self {
        self.no_cache = no_cache;
        self
    }

    #[must_use]
    pub fn with_parent_job_id(mut self, parent_job_id: Option<u64>) -> Self {
        self.parent_job_id = parent_job_id;
        self
    }

    #[must_use]
    pub fn for_query(
        remote_name: impl Into<String>,
        source: impl Into<String>,
        job_type: JobType,
        origin: Option<Origin>,
        group: Option<String>,
    ) -> Self {
        Self {
            remote_name: remote_name.into(),
            job_type,
            source: vec![source.into()],
            destination: String::new(),
            profile: None,
            origin,
            group,
            no_cache: true,
            dry_run: false,
            parent_job_id: None,
            quick_run_id: None,
            execute_id: None,
        }
    }

    /// Build a `JobMetadata` for a mutating operation (e.g. `mkdir`,
    /// `cleanup`, `copyurl`, `delete`).
    ///
    /// Like [`JobMetadata::for_query`] but with `no_cache: false` so the
    /// result is cached.
    #[must_use]
    pub fn for_mutation(
        remote_name: impl Into<String>,
        source: Vec<String>,
        destination: impl Into<String>,
        job_type: JobType,
        origin: Option<Origin>,
        group: Option<String>,
    ) -> Self {
        Self {
            remote_name: remote_name.into(),
            job_type,
            source,
            destination: destination.into(),
            profile: None,
            origin,
            group,
            no_cache: false,
            dry_run: false,
            parent_job_id: None,
            quick_run_id: None,
            execute_id: None,
        }
    }

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

    if metadata.execute_id.is_none() {
        metadata.execute_id = Some(uuid::Uuid::new_v4().to_string());
    }
    let execute_id = metadata.execute_id.clone();

    let (jobid, response_json) = send_job_request(app, endpoint, payload, &metadata).await?;

    let backend_manager = app.state::<BackendManager>();
    let backend_name = backend_manager.get_active().await.name;

    if !metadata.no_cache {
        add_job_to_cache(
            &backend_manager.job_cache,
            jobid,
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
) -> Result<(u64, Value), String> {
    let mut payload = payload;
    let group = metadata.group_name();
    crate::rclone::commands::common::ensure_group(&mut payload, &group);

    let transport = crate::rclone::commands::common::transport(app);
    let _ = transport
        .rpc(core::STATS_DELETE, Some(&json!({ "group": group })))
        .await;

    let response_json = transport
        .rpc(endpoint, Some(&payload))
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    let jobid = parse_job_response(&response_json)?;

    let redacted_payload = redact_value(&payload, app);

    log_operation(
        LogLevel::Info,
        Some(metadata.remote_name.clone()),
        Some(metadata.job_type.to_string()),
        format!(
            "{} started with ID {} (ExecuteID: {:?})",
            metadata.job_type, jobid, metadata.execute_id
        ),
        Some(json!({
            "jobid": jobid,
            "executeId": metadata.execute_id,
            "arguments": redacted_payload,
        })),
    );

    Ok((jobid, response_json))
}

async fn add_job_to_cache(
    job_cache: &JobCache,
    jobid: u64,
    metadata: &JobMetadata,
    backend_name: &str,
    app: Option<&AppHandle>,
) {
    job_cache
        .create_job(jobid, metadata.clone(), backend_name.to_string(), app)
        .await;
}

#[bridge]
pub async fn get_jobs(app: AppHandle) -> Result<Vec<JobInfo>, String> {
    Ok(app.state::<BackendManager>().job_cache.get_jobs().await)
}

#[bridge]
pub async fn delete_job(app: AppHandle, jobid: u64) -> Result<(), String> {
    info!("Deleting job with ID: {jobid}");
    app.state::<BackendManager>()
        .job_cache
        .delete_job(jobid, Some(&app))
        .await
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
    let outcome = resolve_job_outcome(&job_status, &metadata.job_type, &metadata.source);

    if !metadata.no_cache {
        persist_final_job_state(
            app,
            jobid,
            metadata,
            &outcome,
            last_stats,
            job_status.get("output"),
        )
        .await;
    } else {
        spawn_stats_cleanup(app, metadata);
    }

    update_associated_automation(app, jobid, &outcome).await?;

    dispatch_job_completion_effects(app, &backend_name, jobid, metadata, &outcome, &job_status)?;

    Ok(job_status.get("output").cloned().unwrap_or(json!({})))
}

async fn persist_final_job_state(
    app: &AppHandle,
    jobid: u64,
    metadata: &JobMetadata,
    outcome: &JobOutcome,
    last_stats: Option<Value>,
    raw_output: Option<&Value>,
) {
    let job_cache = &app.state::<BackendManager>().job_cache;
    let mut final_stats = collect_final_stats(app, metadata, last_stats).await;
    if final_stats.is_null() || final_stats == json!({}) {
        final_stats = json!({});
    }
    if let Some(obj) = final_stats.as_object_mut() {
        if metadata.job_type == JobType::Check
            && let Some(output) = raw_output
        {
            obj.insert("checkOutput".to_string(), output.clone());
        } else if metadata.job_type == JobType::CryptCheck
            && let Some(parsed) = &outcome.cryptcheck_output
        {
            obj.insert("checkOutput".to_string(), parsed.clone());
        }
    }
    if !final_stats.is_null() && final_stats != json!({}) {
        let _ = job_cache.update_job_stats(jobid, final_stats).await;
    }

    let _ = job_cache
        .complete_job(
            jobid,
            outcome.success,
            outcome.error_msg.clone(),
            if outcome.stopped { None } else { Some(app) },
        )
        .await;
}

async fn update_associated_automation(
    app: &AppHandle,
    jobid: u64,
    outcome: &JobOutcome,
) -> Result<(), RcloneError> {
    let automations_cache = app.state::<AutomationsCache>();
    let automation = automations_cache
        .get_automation_by_job_id(jobid.to_string())
        .await;

    let Some(automation) = automation else {
        return Ok(());
    };

    let next_run = automation
        .cron_expression
        .as_ref()
        .and_then(|expr| get_next_run(expr).ok());
    let automation_name = automation.log_name();
    info!("Job {jobid} associated with automation '{automation_name}', updating status.");

    if outcome.success {
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
    } else if outcome.stopped {
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
        let err = outcome.error_msg.clone().unwrap_or_default();
        automations_cache
            .update_automation(
                &automation.id,
                |t| {
                    t.mark_failure(err.clone());
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
                error: err,
            }),
        );
    }

    Ok(())
}

fn dispatch_job_completion_effects(
    app: &AppHandle,
    backend_name: &str,
    jobid: u64,
    metadata: &JobMetadata,
    outcome: &JobOutcome,
    job_status: &Value,
) -> Result<(), RcloneError> {
    if outcome.stopped {
        info!("{} Job {jobid} stopped by user.", metadata.job_type);
        if !metadata.no_cache {
            notify(app, metadata.stopped_event(backend_name.to_string()));
        }
        return Ok(());
    }

    if !outcome.success {
        let raw_err = outcome.error_msg.as_deref().unwrap_or("Job failed");
        let error_for_notify = crate::rclone::engine::error_mapper::map_rclone_error(raw_err)
            .unwrap_or_else(|| raw_err.to_string());
        if !metadata.no_cache {
            log_operation(
                LogLevel::Error,
                Some(metadata.remote_name.clone()),
                Some(metadata.job_type.to_string()),
                format!("{} Job {jobid} failed: {raw_err}", metadata.job_type),
                Some(json!({"jobid": jobid, "status": job_status})),
            );
            notify(
                app,
                metadata.failed_event(backend_name.to_string(), &error_for_notify),
            );
        }
        return Err(RcloneError::JobError(raw_err.to_string()));
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
            notify(app, metadata.completed_event(backend_name.to_string()));
        }
    }

    Ok(())
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
    crate::rclone::state::job::spawn_stats_cleanup_by_group(app, &metadata.group_name());
}

#[bridge]
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

#[bridge]
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

#[bridge]
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
            crate::rclone::commands::common::ensure_group(&mut inp, &batch_group);
            inp
        })
        .collect();

    let payload = json!({
        "_async": true,
        "inputs": modified_inputs,
    });

    let _ = transport
        .rpc(core::STATS_DELETE, Some(&json!({ "group": &batch_group })))
        .await;

    let response_json: Value = transport
        .rpc(job::BATCH, Some(&payload))
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    if metadata.execute_id.is_none() {
        metadata.execute_id = Some(uuid::Uuid::new_v4().to_string());
    }
    let execute_id = metadata.execute_id.clone();

    let jobid = parse_job_response(&response_json)?;

    let backend_name = backend_manager.get_active_name().await;

    if !metadata.no_cache {
        add_job_to_cache(
            &backend_manager.job_cache,
            jobid,
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

#[bridge]
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

    let metadata = JobMetadata::new(
        remote,
        JobType::Upload,
        vec!["preparing".to_string()],
        destination,
    )
    .with_origin(origin);

    job_cache
        .create_job(jobid, metadata, backend_name, Some(&app))
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

#[bridge]
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
        JobMetadata::new("gdrive:", JobType::Sync, vec!["src".to_string()], "dst")
            .with_origin(origin)
            .with_profile(profile.map(str::to_string))
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
}
