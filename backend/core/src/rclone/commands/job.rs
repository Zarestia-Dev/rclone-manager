use crate::context::AppHandle;
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::time::sleep;

use crate::rclone::backend::BackendError;
use crate::rclone::backend::{
    BackendManager, RcloneTransport, routing_transport::RoutingTransport, types::Backend,
};
use crate::rclone::endpoints::core;
use crate::rclone::endpoints::job;
use crate::rclone::state::automations::AutomationsCache;
use crate::services::automation::engine::get_next_run;
use crate::utils::app::notification::AutomationStage;
use crate::utils::app::notification::JobStage;
use crate::utils::app::notification::NotificationEvent;
use crate::utils::app::notification::notify;
use crate::utils::logging::log::log_operation;
use crate::utils::types::jobs::JobCache;
use crate::utils::types::jobs::JobInfo;
use crate::utils::types::jobs::JobStatus;
use crate::utils::types::jobs::JobType;
use crate::utils::types::logs::LogLevel;
use crate::utils::types::origin::Origin;

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
    #[serde(default)]
    pub workflow_id: Option<String>,
    #[serde(default)]
    pub node_id: Option<String>,
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
            workflow_id: None,
            node_id: None,
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
    pub fn with_workflow_id(mut self, workflow_id: Option<String>) -> Self {
        self.workflow_id = workflow_id;
        self
    }

    #[must_use]
    pub fn with_node_id(mut self, node_id: Option<String>) -> Self {
        self.node_id = node_id;
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
            workflow_id: None,
            node_id: None,
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
            workflow_id: None,
            node_id: None,
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

#[derive(Debug, Clone, Default)]
pub struct SubmitJobOptions {
    /// Wait for completion and return the monitor's output.
    pub wait_for_completion: bool,
    /// Reuse the backend captured when resolving the operation's configuration.
    pub backend: Option<Backend>,
}

/// Result of submitting a job. Output is available only when completion was awaited.
#[derive(Debug)]
pub struct JobSubmission {
    pub job_id: u64,
    pub output: Option<Value>,
}

/// The backend, transport and cache are captured together before the first RPC.
/// A job keeps this ownership until completion, independently of UI selection.
struct JobContext {
    backend_name: String,
    transport: Arc<dyn RcloneTransport>,
    cache: Arc<JobCache>,
}

impl JobContext {
    async fn active(app: &AppHandle) -> Self {
        let manager = app.state::<BackendManager>();
        let backend = manager.get_active().await;
        Self::for_backend(app, backend)
    }

    fn for_backend(app: &AppHandle, backend: Backend) -> Self {
        let manager = app.state::<BackendManager>();
        Self {
            cache: manager.job_cache_for(&backend.name),
            backend_name: backend.name.clone(),
            transport: RoutingTransport::for_backend(app.clone(), backend),
        }
    }
}

pub async fn submit_job_with_options(
    app: AppHandle,
    endpoint: &str,
    payload: Value,
    mut metadata: JobMetadata,
    options: SubmitJobOptions,
) -> Result<JobSubmission, String> {
    let context = match options.backend {
        Some(backend) => JobContext::for_backend(&app, backend),
        None => JobContext::active(&app).await,
    };
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
    let jobid = send_job_request(
        &app,
        context.transport.as_ref(),
        endpoint,
        payload,
        &metadata,
    )
    .await?;

    if !metadata.no_cache {
        context
            .cache
            .create_job(jobid, metadata.clone(), context.backend_name.clone())
            .await;
        if metadata.job_type != JobType::Mount {
            notify(&app, metadata.started_event(context.backend_name.clone()));
        }
    }
    if let Some(execution) = metadata.execute_id.as_deref() {
        app.state::<AutomationsCache>()
            .bind_job_execution(&context.backend_name, execution, jobid)
            .await;
    }
    let output = if options.wait_for_completion {
        Some(
            monitor_job(context, metadata, jobid, app)
                .await
                .map_err(|error| error.to_string())?,
        )
    } else {
        crate::utils::spawn(async move {
            let _ = monitor_job(context, metadata, jobid, app).await;
        });
        None
    };
    Ok(JobSubmission {
        job_id: jobid,
        output,
    })
}

async fn send_job_request(
    app: &AppHandle,
    transport: &dyn RcloneTransport,
    endpoint: &str,
    payload: Value,
    metadata: &JobMetadata,
) -> Result<u64, String> {
    let mut payload = payload;
    let group = metadata.group_name();
    if endpoint == job::BATCH {
        if let Some(inputs) = payload.get_mut("inputs").and_then(Value::as_array_mut) {
            for input in inputs {
                super::common::ensure_group(input, &group);
            }
        }
    } else {
        super::common::ensure_group(&mut payload, &group);
    }

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

    Ok(jobid)
}

pub async fn get_jobs(app: AppHandle) -> Result<Vec<JobInfo>, String> {
    Ok(app
        .state::<BackendManager>()
        .job_cache()
        .await
        .get_jobs()
        .await)
}

pub async fn delete_job(app: AppHandle, jobid: u64) -> Result<(), String> {
    info!("Deleting job with ID: {jobid}");
    app.state::<BackendManager>()
        .job_cache()
        .await
        .delete_job(jobid, Some(&app))
        .await
}

async fn monitor_job(
    context: JobContext,
    metadata: JobMetadata,
    jobid: u64,
    app: AppHandle,
) -> Result<Value, RcloneError> {
    let transport = &context.transport;
    let job_cache = &context.cache;

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
                    &context,
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
                            &context,
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
                            &context,
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

async fn handle_job_completion(
    context: &JobContext,
    jobid: u64,
    metadata: &JobMetadata,
    job_status: Value,
    app: &AppHandle,
    last_stats: Option<Value>,
) -> Result<Value, RcloneError> {
    let outcome = resolve_job_outcome(&job_status, &metadata.job_type, &metadata.source);

    if !metadata.no_cache {
        persist_final_job_state(
            context,
            jobid,
            metadata,
            &outcome,
            last_stats,
            job_status.get("output"),
        )
        .await;
    } else {
        crate::rclone::state::job::spawn_stats_cleanup_by_group(
            context.transport.clone(),
            &metadata.group_name(),
        );
    }

    update_associated_automation(
        app,
        &context.backend_name,
        metadata.execute_id.as_deref(),
        &outcome,
    )
    .await?;

    dispatch_job_completion_effects(
        app,
        &context.backend_name,
        jobid,
        metadata,
        &outcome,
        &job_status,
    )?;

    if !outcome.success {
        return Err(RcloneError::JobError(outcome.error_msg.unwrap_or_else(|| crate::localized_error!("backendErrors.job.executionFailed", "error" => "Job stopped"))));
    }
    Ok(job_status.get("output").cloned().unwrap_or(json!({})))
}

async fn persist_final_job_state(
    context: &JobContext,
    jobid: u64,
    metadata: &JobMetadata,
    outcome: &JobOutcome,
    last_stats: Option<Value>,
    raw_output: Option<&Value>,
) {
    let job_cache = &context.cache;
    let mut final_stats =
        collect_final_stats(context.transport.as_ref(), metadata, last_stats).await;
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
        .complete_job(jobid, outcome.success, outcome.error_msg.clone())
        .await;
}

async fn update_associated_automation(
    app: &AppHandle,
    backend_name: &str,
    execute_id: Option<&str>,
    outcome: &JobOutcome,
) -> Result<(), RcloneError> {
    let Some(execute_id) = execute_id else {
        return Ok(());
    };
    let Some(automation) = app
        .state::<AutomationsCache>()
        .update_execution(backend_name, execute_id, |automation| {
            if outcome.success {
                automation.mark_success();
            } else if outcome.stopped {
                automation.mark_stopped();
            } else {
                automation.mark_failure(outcome.error_msg.clone().unwrap_or_default());
            }
            automation.next_run = automation
                .cron_expression
                .as_deref()
                .and_then(|expr| get_next_run(expr).ok());
        })
        .await
    else {
        return Ok(());
    };
    let event = if outcome.success {
        AutomationStage::Completed {
            backend: automation.backend_name.clone(),
            remote: automation.remote_name.clone(),
            profile: automation.profile_name.clone(),
            automation_name: automation.display_name(),
            automation_type: automation.automation_type,
        }
    } else if outcome.stopped {
        AutomationStage::Stopped {
            backend: automation.backend_name.clone(),
            remote: automation.remote_name.clone(),
            profile: automation.profile_name.clone(),
            automation_name: automation.display_name(),
            automation_type: automation.automation_type,
        }
    } else {
        AutomationStage::Failed {
            backend: automation.backend_name.clone(),
            remote: automation.remote_name.clone(),
            profile: automation.profile_name.clone(),
            automation_name: automation.display_name(),
            automation_type: automation.automation_type,
            error: outcome.error_msg.clone().unwrap_or_default(),
        }
    };
    notify(app, NotificationEvent::Automation(event));
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
    transport: &dyn RcloneTransport,
    metadata: &JobMetadata,
    last_stats: Option<Value>,
) -> Value {
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

pub async fn stop_job(app: AppHandle, jobid: u64, remote_name: String) -> Result<(), String> {
    let backend = app.state::<BackendManager>().get_active().await;
    stop_job_on_backend(app, backend, jobid, remote_name).await
}

pub(crate) async fn stop_job_on_backend(
    app: AppHandle,
    backend: Backend,
    jobid: u64,
    remote_name: String,
) -> Result<(), String> {
    let context = JobContext::for_backend(&app, backend);
    let transport = &context.transport;
    let job_cache = &context.cache;

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

    job_cache.stop_job(jobid).await.map_err(|e| e.clone())?;

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

pub async fn stop_jobs_by_group(app: AppHandle, group: String) -> Result<(), String> {
    let context = JobContext::active(&app).await;
    let transport = &context.transport;
    let job_cache = &context.cache;

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
            let _ = job_cache.stop_job(job.jobid).await;
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

pub async fn submit_batch_job(
    app: AppHandle,
    inputs: Vec<Value>,
    metadata: JobMetadata,
) -> Result<String, String> {
    submit_batch_job_with_options(app, inputs, metadata, SubmitJobOptions::default()).await
}

pub async fn submit_batch_job_with_options(
    app: AppHandle,
    inputs: Vec<Value>,
    metadata: JobMetadata,
    options: SubmitJobOptions,
) -> Result<String, String> {
    submit_job_with_options(
        app,
        job::BATCH,
        json!({ "_async": true, "inputs": inputs }),
        metadata,
        options,
    )
    .await
    .map(|submission| submission.job_id.to_string())
}

pub async fn register_preparing_job(
    app: crate::context::AppHandle,
    jobid: u64,
    remote: String,
    destination: String,
    total_files: usize,
    total_bytes: u64,
    origin: Option<Origin>,
) -> Result<(), String> {
    let backend_manager = app.state::<crate::rclone::backend::BackendManager>();
    let backend_name = backend_manager.get_active().await.name;
    let job_cache = backend_manager.job_cache_for(&backend_name);

    let metadata = JobMetadata::new(
        remote,
        JobType::Upload,
        vec!["preparing".to_string()],
        destination,
    )
    .with_origin(origin);

    job_cache.create_job(jobid, metadata, backend_name).await;

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

pub async fn update_job_stats(
    app: crate::context::AppHandle,
    jobid: u64,
    stats: Value,
) -> Result<(), String> {
    let backend_manager = app.state::<crate::rclone::backend::BackendManager>();
    backend_manager
        .job_cache()
        .await
        .update_job_stats(jobid, stats)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn run_backend_switch_during_submission(batch: bool, success: bool) {
        use crate::rclone::backend::types::Backend;
        use crate::services::settings::{AppSettingsManager, schema::AppSettings};
        use crate::utils::types::state::RcloneState;
        use std::sync::atomic::AtomicBool;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let directory = tempfile::tempdir().unwrap();
        let settings: AppSettingsManager = rcman::SettingsManager::builder("job-test", "1.0.0")
            .with_config_dir(directory.path())
            .with_schema::<AppSettings>()
            .with_sub_settings(rcman::SubSettingsConfig::new("remotes").with_profiles())
            .with_sub_settings(rcman::SubSettingsConfig::singlefile("backend").with_profiles())
            .build()
            .unwrap();
        let manager = BackendManager::new();
        manager
            .add(
                &settings,
                Backend::new_remote("A", "127.0.0.1", listener.local_addr().unwrap().port()),
                None,
                None,
            )
            .await
            .unwrap();
        // B must never receive a request. A connection attempt to port 0 fails the test.
        manager
            .add(
                &settings,
                Backend::new_remote("B", "127.0.0.1", 0),
                None,
                None,
            )
            .await
            .unwrap();
        manager.switch_to(&settings, "A").await.unwrap();
        let app = AppHandle::default();
        app.manage(manager);
        app.manage(settings);
        app.manage(AutomationsCache::new());
        app.manage(RcloneState {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
            transport: Arc::new(RoutingTransport::new(app.clone())),
            is_shutting_down: AtomicBool::new(false),
            poller_running: AtomicBool::new(false),
            poller_visible: AtomicBool::new(false),
            initial_startup: AtomicBool::new(false),
            updater_running: AtomicBool::new(false),
            initialization_lock: tokio::sync::Mutex::new(()),
            vault_operation_lock: tokio::sync::Mutex::new(()),
        });
        let manager = app.state::<BackendManager>();
        let automations = app.state::<AutomationsCache>();
        let remote: crate::utils::types::remotes::RemoteSettings = serde_json::from_value(json!({
            "syncConfigs": {"daily": {"app":{"cronEnabled":true,"cronExpression":"0 0 1 1 *"}, "rclone":{"srcFs":"gdrive:","dstFs":"/tmp/backup"}}}
        })).unwrap();
        app.state::<AppSettingsManager>()
            .sub_settings("remotes")
            .unwrap()
            .set("gdrive", &remote)
            .unwrap();
        let automation_id = automations
            .add_or_update_automation_for_remote("A", "gdrive", &remote)
            .await
            .unwrap()
            .added
            .remove(0)
            .id;
        let execution = automations
            .try_start_automation(&automation_id, "A", None)
            .await
            .unwrap()
            .unwrap()
            .execution_id;
        let metadata = make_meta(None, Some("daily")).with_execute_id(execution.clone());
        let b_cache = manager.job_cache_for("B");
        b_cache.create_job(7, metadata.clone(), "B".into()).await;
        b_cache
            .update_job_stats(7, json!({"bytes": 999}))
            .await
            .unwrap();

        let server_app = app.clone();
        let server = crate::utils::spawn(async move {
            let mut groups = Vec::new();
            let mut request_index = 0;
            while request_index < 5 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let (header_end, content_length) = loop {
                    let mut buffer = [0u8; 4096];
                    let count = stream.read(&mut buffer).await.unwrap();
                    assert_ne!(count, 0);
                    request.extend_from_slice(&buffer[..count]);
                    if let Some(index) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..index]);
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().unwrap())
                            })
                            .unwrap();
                        break (index + 4, length);
                    }
                };
                while request.len() < header_end + content_length {
                    let mut buffer = [0u8; 4096];
                    let count = stream.read(&mut buffer).await.unwrap();
                    assert_ne!(count, 0);
                    request.extend_from_slice(&buffer[..count]);
                }
                let headers = String::from_utf8_lossy(&request[..header_end]);
                let path = headers.split_whitespace().nth(1).unwrap();
                let body: Value = serde_json::from_slice(&request[header_end..]).unwrap();
                let response = if path == "/operations/stat" {
                    assert!(batch);
                    json!({"item": {"IsDir": true}})
                } else {
                    if request_index == 0 {
                        assert_eq!(path, "/core/stats-delete");
                        // Switch while job submission is in flight, before the job ID exists.
                        let manager = server_app.state::<BackendManager>();
                        let settings = server_app.state::<AppSettingsManager>();
                        manager.switch_to(settings.inner(), "B").await.unwrap();
                    }
                    groups.push(body.get("group").or_else(|| body.get("_group")).cloned());
                    let response = match request_index {
                        0 => json!({}),
                        1 => {
                            assert_eq!(path, if batch { "/job/batch" } else { "/sync/sync" });
                            json!({"jobid": 7})
                        }
                        2 => {
                            assert_eq!(path, "/job/batch");
                            json!({"results": [
                            {"finished": true, "success": success, "error": if success { "" } else { "transfer failed" }, "output": {"owner": "A"}},
                                {"bytes": 123}, {"transferred": []}
                            ]})
                        }
                        _ => match path {
                            "/core/stats" => json!({"bytes": 123}),
                            "/core/transferred" => json!({"transferred": []}),
                            _ => panic!("unexpected final RPC: {path}"),
                        },
                    };
                    request_index += 1;
                    response
                };
                let response = response.to_string();
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).as_bytes()).await.unwrap();
            }
            groups
        });

        let expected_status = if success {
            JobStatus::Completed
        } else {
            JobStatus::Failed
        };
        let a_cache = manager.job_cache_for("A");
        tokio::time::timeout(Duration::from_secs(5), async {
            if batch {
                assert_eq!(
                    super::super::sync::start_profile_batch(
                        app.clone(),
                        crate::utils::types::remotes::OperationType::Sync,
                        crate::utils::types::remotes::ProfileParams {
                            remote_name: "gdrive".into(),
                            profile_name: "daily".into(),
                            backend_name: Some("A".into()),
                            source: Some(Origin::Automation),
                            no_cache: None,
                            scoped_targets: None,
                            execute_id: execution.clone(),
                        },
                    )
                    .await
                    .unwrap(),
                    "7"
                );
            } else {
                let result = submit_job_with_options(
                    app.clone(),
                    "sync/sync",
                    json!({"_async": true}),
                    metadata,
                    SubmitJobOptions {
                        wait_for_completion: true,
                        ..Default::default()
                    },
                )
                .await;
                if success {
                    let submission = result.unwrap();
                    assert_eq!(submission.job_id, 7);
                    assert_eq!(submission.output.unwrap()["owner"], "A");
                } else {
                    assert!(result.is_err());
                }
            }
            let groups = server.await.unwrap();
            // The same group must be used for starting, polling and final stats.
            assert_eq!(groups[0], groups[3]);
            assert_eq!(groups[0], groups[4]);
            loop {
                if a_cache
                    .get_job(7)
                    .await
                    .is_some_and(|j| j.status == expected_status)
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("job did not finish on its original backend");
        assert_eq!(
            a_cache.get_job(7).await.unwrap().stats.unwrap()["bytes"],
            123
        );
        assert_eq!(a_cache.get_job(7).await.unwrap().execute_id, execution);
        let automation = automations.get_automation(&automation_id).await.unwrap();
        assert!(automation.current_job_id.is_none());
        assert!(automation.execution_id.is_none());
        assert_eq!(automation.success_count, u64::from(success));
        assert_eq!(automation.failure_count, u64::from(!success));
        let b_job = b_cache.get_job(7).await.unwrap();
        assert_eq!(b_job.status, JobStatus::Running);
        assert_eq!(b_job.stats.unwrap()["bytes"], 999);
        let settings = app.state::<AppSettingsManager>();
        manager.switch_to(settings.inner(), "A").await.unwrap();
        assert_eq!(
            manager.job_cache().await.get_job(7).await.unwrap().status,
            expected_status
        );
    }

    #[tokio::test]
    async fn single_job_keeps_backend_when_selection_changes_during_submission() {
        run_backend_switch_during_submission(false, true).await;
    }

    #[tokio::test]
    async fn awaited_job_failure_returns_error_after_backend_switch() {
        run_backend_switch_during_submission(false, false).await;
    }

    #[tokio::test]
    async fn profile_batch_failure_preserves_execution_and_backend() {
        run_backend_switch_during_submission(true, false).await;
    }

    #[tokio::test]
    async fn profile_batch_success_preserves_execution_and_backend() {
        run_backend_switch_during_submission(true, true).await;
    }

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
