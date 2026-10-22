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
        if let Some(group) = &self.group {
            return group.clone();
        }
        let remote = self.remote_name.trim_end_matches(':').trim_end_matches('/');
        match &self.profile {
            Some(profile) => format!("{}/{}/{}", self.job_type, remote, profile),
            None => format!("{}/{}", self.job_type, remote),
        }
    }

    /// A stats group belongs to one execution unless the caller explicitly shares it.
    pub(crate) fn prepare_execution(&mut self) {
        if self.execute_id.is_none() {
            self.execute_id = Some(uuid::Uuid::new_v4().to_string());
        }
        if self.group.is_none() {
            self.group = Some(format!(
                "{}_{}",
                self.group_name(),
                uuid::Uuid::new_v4().simple()
            ));
        }
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
            source: Some(self.source.join(", ")),
            destination: Some(self.destination.clone()),
        })
    }

    pub fn completed_event(&self, backend: String) -> NotificationEvent {
        NotificationEvent::Job(JobStage::Completed {
            backend,
            remote: self.remote_name.clone(),
            profile: self.profile.clone(),
            job_type: self.job_type.clone(),
            origin: self.resolved_origin(),
            source: Some(self.source.join(", ")),
            destination: Some(self.destination.clone()),
        })
    }

    pub fn failed_event(&self, backend: String, error_msg: &str) -> NotificationEvent {
        NotificationEvent::Job(JobStage::Failed {
            backend,
            remote: self.remote_name.clone(),
            profile: self.profile.clone(),
            job_type: self.job_type.clone(),
            origin: self.resolved_origin(),
            source: Some(self.source.join(", ")),
            destination: Some(self.destination.clone()),
            error: error_msg.to_string(),
        })
    }

    pub(crate) fn stopped_event(&self, backend: String) -> NotificationEvent {
        NotificationEvent::Job(JobStage::Stopped {
            backend,
            remote: self.remote_name.clone(),
            profile: self.profile.clone(),
            job_type: self.job_type.clone(),
            origin: self.resolved_origin(),
            source: Some(self.source.join(", ")),
            destination: Some(self.destination.clone()),
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
    metadata.prepare_execution();
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
                .map_err(|error| {
                    crate::rclone::engine::error_mapper::map_or_wrap_job_error(&error)
                })?,
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
    super::common::ensure_group(&mut payload, &group);
    if endpoint == job::BATCH
        && let Some(inputs) = payload.get_mut("inputs").and_then(Value::as_array_mut)
    {
        for input in inputs {
            super::common::ensure_group(input, &group);
        }
    }

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

/// A successful batch HTTP response may still contain an RC error for job/status.
fn monitor_status(batch: &Value) -> Result<&Value, String> {
    let status = batch
        .get("results")
        .and_then(Value::as_array)
        .and_then(|results| results.first())
        .filter(|value| value.is_object())
        .ok_or_else(|| "Missing job status in batch response".to_string())?;
    if let Some(error) = status
        .get("error")
        .and_then(Value::as_str)
        .filter(|error| !error.is_empty())
    {
        // Finished jobs carry their own failure; the completion handler must see it.
        if status.get("finished").and_then(Value::as_bool) != Some(true) {
            return Err(error.into());
        }
    }
    if status
        .get("status")
        .and_then(Value::as_u64)
        .is_some_and(|code| code >= 400)
    {
        return Err(status
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Job status request failed")
            .into());
    }
    let finished = status
        .get("finished")
        .and_then(Value::as_bool)
        .ok_or_else(|| "Invalid job status response".to_string())?;
    if finished && status.get("success").and_then(Value::as_bool).is_none() {
        return Err("Missing job completion outcome".into());
    }
    Ok(status)
}

async fn monitor_job(
    context: JobContext,
    metadata: JobMetadata,
    jobid: u64,
    app: AppHandle,
) -> Result<Value, String> {
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
            let status = job_cache
                .get_execution_status(jobid, metadata.execute_id.as_deref())
                .await;

            if status.is_none_or(|status| status == JobStatus::Stopped) {
                info!("Monitoring for job {jobid} stopped: execution removed or marked Stopped.");
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
            .await
            .map_err(|error| error.to_string())
            .and_then(|batch| {
                let status = monitor_status(&batch)?.clone();
                Ok((status, batch))
            });

        match poll_result {
            Ok((status, batch)) => {
                consecutive_errors = 0;
                let mut last_stats = None;
                if !metadata.no_cache
                    && let Some(results) = batch["results"].as_array()
                    && results.len() >= 3
                    && results[1].is_object()
                    && results[1]
                        .get("status")
                        .and_then(Value::as_u64)
                        .is_none_or(|code| code < 400)
                {
                    let mut stats = results[1].clone();
                    if let Some(history) = results[2]
                        .get("transferred")
                        .filter(|value| value.is_array())
                    {
                        stats["completed"] = history.clone();
                    }
                    if status["finished"] == true {
                        last_stats = Some(stats);
                    } else if job_cache
                        .update_job_stats_for_execution(
                            jobid,
                            metadata.execute_id.as_deref(),
                            stats,
                        )
                        .await
                        .is_err()
                    {
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
                if status["finished"] == true {
                    return handle_job_completion(
                        &context, jobid, &metadata, status, &app, last_stats,
                    )
                    .await;
                }
            }
            Err(error) => {
                consecutive_errors += 1;
                warn!(
                    "Job {jobid} monitor error ({consecutive_errors}/{MAX_CONSECUTIVE_ERRORS}): {error}"
                );
                if consecutive_errors >= MAX_CONSECUTIVE_ERRORS {
                    let message = crate::localized_error!("backendErrors.job.monitoringFailed", "error" => error);
                    return handle_job_completion(
                        &context,
                        jobid,
                        &metadata,
                        json!({"finished": true, "success": false, "error": message}),
                        &app,
                        None,
                    )
                    .await;
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
) -> Result<Value, String> {
    let outcome = resolve_job_outcome(&job_status, &metadata.job_type, &metadata.source);

    if !metadata.no_cache {
        if let Err(error) = persist_final_job_state(
            context,
            jobid,
            metadata,
            &outcome,
            last_stats,
            job_status.get("output"),
        )
        .await
        {
            log::debug!("Job {jobid} final state no longer belongs in the cache: {error}");
        }
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
    .await;

    dispatch_job_completion_effects(
        app,
        &context.backend_name,
        jobid,
        metadata,
        &outcome,
        &job_status,
    )?;

    if !outcome.success {
        return Err(outcome.error_msg.unwrap_or_else(|| crate::localized_error!("backendErrors.job.executionFailed", "error" => "Job stopped")));
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
) -> Result<(), String> {
    let job_cache = &context.cache;
    let mut final_stats =
        collect_final_stats(context.transport.as_ref(), metadata, last_stats).await;
    if !final_stats.is_object() {
        final_stats = json!({});
    }
    let check_output = match &metadata.job_type {
        JobType::Check => raw_output,
        JobType::CryptCheck => outcome.cryptcheck_output.as_ref(),
        _ => None,
    };
    if let (Some(obj), Some(output)) = (final_stats.as_object_mut(), check_output) {
        obj.insert("checkOutput".to_string(), output.clone());
    }
    job_cache
        .complete_job_for_execution(
            jobid,
            metadata.execute_id.as_deref(),
            outcome.success,
            outcome.error_msg.clone(),
            final_stats
                .as_object()
                .is_some_and(|stats| !stats.is_empty())
                .then_some(final_stats),
        )
        .await?;
    Ok(())
}

async fn update_associated_automation(
    app: &AppHandle,
    backend_name: &str,
    execute_id: Option<&str>,
    outcome: &JobOutcome,
) {
    let Some(execute_id) = execute_id else {
        return;
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
        return;
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
}

fn dispatch_job_completion_effects(
    app: &AppHandle,
    backend_name: &str,
    jobid: u64,
    metadata: &JobMetadata,
    outcome: &JobOutcome,
    job_status: &Value,
) -> Result<(), String> {
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
                Some(redact_value(
                    &json!({"jobid": jobid, "status": job_status}),
                    app,
                )),
            );
            notify(
                app,
                metadata.failed_event(backend_name.to_string(), &error_for_notify),
            );
        }
        return Err(raw_err.to_string());
    }

    if !metadata.no_cache {
        log_operation(
            LogLevel::Info,
            Some(metadata.remote_name.clone()),
            Some(metadata.job_type.to_string()),
            format!("{} Job {jobid} completed successfully", metadata.job_type),
            Some(redact_value(
                &json!({"jobid": jobid, "status": job_status}),
                app,
            )),
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
    let last_stats = match last_stats {
        Some(stats) if stats.get("completed").is_some_and(Value::is_array) => return stats,
        other => other,
    };
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
        && let Some(history) = data.get("transferred").filter(|value| value.is_array())
        && let Some(obj) = final_stats.as_object_mut()
    {
        obj.insert("completed".to_string(), history.clone());
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

    if job_cache.cancel_upload(jobid).await? {
        return job_cache.stop_job(jobid).await;
    }

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

    job_cache.stop_job(jobid).await?;

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

    let mut cancelled_upload = false;
    let mut has_native_jobs = false;
    for job in job_cache.get_active_jobs().await {
        if job.group == group {
            if job_cache.cancel_upload(job.jobid).await? {
                cancelled_upload = true;
                job_cache.stop_job(job.jobid).await?;
            } else {
                has_native_jobs = true;
            }
        }
    }

    // Synthetic uploads cancel their own requests and underlying copy jobs.
    if !cancelled_upload || has_native_jobs {
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

    #[test]
    fn monitor_validates_inner_rc_status_and_completion_fields() {
        for batch in [
            json!({}),
            json!({"results": []}),
            json!({"results": [null]}),
            json!({"results": [{"status": 500, "error": "job not found"}]}),
            json!({"results": [{"finished": true}]}),
            json!({"results": [{"finished": "yes"}]}),
        ] {
            assert!(monitor_status(&batch).is_err(), "{batch}");
        }
        for status in [
            json!({"finished": false}),
            json!({"finished": true, "success": false, "error": "copy failed"}),
            json!({"finished": true, "success": true, "error": ""}),
        ] {
            assert_eq!(
                monitor_status(&json!({"results": [status.clone()]})).unwrap(),
                &status
            );
        }
    }

    #[test]
    fn automatic_stats_groups_are_isolated_and_explicit_groups_are_preserved() {
        let copy_url = JobMetadata::new("drive:", JobType::CopyUrl, vec![], "dst:");
        assert_eq!(copy_url.group_name(), "copyurl/drive");
        let mut first = JobMetadata::new("drive", JobType::Sync, vec!["src:".into()], "dst:")
            .with_profile(Some("daily".into()));
        let mut second = first.clone();
        first.prepare_execution();
        second.prepare_execution();
        assert_ne!(first.group_name(), second.group_name());
        assert_ne!(first.execute_id, second.execute_id);
        assert!(first.group_name().starts_with("sync/drive/daily_"));
        let prepared = first.group_name();
        first.prepare_execution();
        assert_eq!(first.group_name(), prepared);

        let mut explicit = second.with_group(Some("shared".into()));
        let execution = explicit.execute_id.clone();
        explicit.prepare_execution();
        assert_eq!(explicit.group_name(), "shared");
        assert_eq!(explicit.execute_id, execution);
    }

    #[test]
    fn notifications_preserve_job_identity_and_operation_fields() {
        let metadata = JobMetadata::new(
            "drive",
            JobType::Copy,
            vec!["src:a".into(), "src:b".into()],
            "dst:",
        )
        .with_profile(Some("daily".into()))
        .with_origin(Some(Origin::Dashboard));
        for event in [
            metadata.started_event("backend".into()),
            metadata.completed_event("backend".into()),
            metadata.failed_event("backend".into(), "failure"),
            metadata.stopped_event("backend".into()),
        ] {
            let json = serde_json::to_value(event).unwrap().to_string();
            for value in ["backend", "drive", "daily", "src:a, src:b", "dst:"] {
                assert!(json.contains(value), "{json}");
            }
        }
    }

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
            while request_index < 2 {
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
                            .unwrap_or(0);
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
                let body: Value = if content_length == 0 {
                    json!({})
                } else {
                    serde_json::from_slice(&request[header_end..]).unwrap()
                };
                let response = if path == "/core/version" {
                    json!({"os": "linux"})
                } else if path == "/operations/stat" {
                    assert!(batch);
                    json!({"item": {"IsDir": true}})
                } else {
                    if request_index == 0 {
                        // Switch while job submission is in flight, before the job ID exists.
                        let manager = server_app.state::<BackendManager>();
                        let settings = server_app.state::<AppSettingsManager>();
                        manager.switch_to(settings.inner(), "B").await.unwrap();
                    }
                    let group = body.get("_group").or_else(|| {
                        body["inputs"]
                            .as_array()
                            .and_then(|inputs| inputs.iter().find_map(|input| input.get("group")))
                    });
                    groups.push(group.cloned());
                    let response = match request_index {
                        0 => {
                            assert_eq!(path, if batch { "/job/batch" } else { "/sync/sync" });
                            assert!(
                                body["_group"]
                                    .as_str()
                                    .is_some_and(|group| !group.is_empty())
                            );
                            if batch {
                                for input in body["inputs"].as_array().unwrap() {
                                    assert_eq!(input["_group"], body["_group"]);
                                }
                            }
                            json!({"jobid": 7})
                        }
                        1 => {
                            assert_eq!(path, "/job/batch");
                            json!({"results": [
                            {"finished": true, "success": success, "error": if success { "" } else { "transfer failed" }, "output": {"owner": "A"}},
                                {"bytes": 123}, {"transferred": []}
                            ]})
                        }
                        _ => panic!("unexpected extra RPC: {path}"),
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
            // Submission and polling must use the same execution group.
            assert_eq!(groups[0], groups[1]);
            assert_eq!(groups.len(), 2);
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
