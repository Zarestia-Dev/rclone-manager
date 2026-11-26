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
use crate::rclone::state::job_report::job_report;
use crate::utils::app::notification::JobStage;
use crate::utils::app::notification::NotificationEvent;
use crate::utils::app::notification::notify_job;
use crate::utils::logging::log::log_operation;
use crate::utils::types::jobs::JobCache;
use crate::utils::types::jobs::JobInfo;
use crate::utils::types::jobs::JobStatus;
use crate::utils::types::jobs::JobType;
use crate::utils::types::logs::LogLevel;
use crate::utils::types::origin::Origin;
use crate::utils::types::starter::{self, Starter};

use super::common::redact_value;
use super::job_parser::{JobOutcome, parse_job_response, resolve_job_outcome};

const JOB_POLL_INTERVAL_MS: u64 = 500;
/// The waits before the first polls of a job. A short job (a folder, a rename, a mount that starts
/// at once) is done within a few hundred milliseconds, so it should not wait a whole interval to be
/// noticed; a long one settles at `JOB_POLL_INTERVAL_MS`.
const JOB_FIRST_POLLS_MS: [u64; 4] = [50, 100, 200, 350];
/// The regular pace while no window shows the app (Android in the background, a window closed to
/// the tray): nothing on screen follows the progress, and the Android notification updates no
/// faster than this either. Each poll also fetches the transfer history, so this spares the CPU.
const JOB_HIDDEN_POLL_INTERVAL_MS: u64 = 2000;
const MAX_CONSECUTIVE_ERRORS: u8 = 3;

/// The wait after the `poll`th successful poll of a job (counting from 0).
fn poll_delay(poll: usize, visible: bool) -> Duration {
    let regular = if visible {
        JOB_POLL_INTERVAL_MS
    } else {
        JOB_HIDDEN_POLL_INTERVAL_MS
    };
    Duration::from_millis(JOB_FIRST_POLLS_MS.get(poll).copied().unwrap_or(regular))
}

/// Whether a window shows the app, as the frontend last said; visible when nothing said.
fn ui_visible(app: &AppHandle) -> bool {
    app.try_state::<crate::utils::types::state::RcloneState>()
        .is_none_or(|state| {
            state
                .poller_visible
                .load(std::sync::atomic::Ordering::Relaxed)
        })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobMetadata {
    pub remote_name: String,
    pub job_type: JobType,
    pub source: Vec<String>,
    pub destination: String,
    pub starter: Option<Starter>,
    pub origin: Option<Origin>,
    pub group: Option<String>,
    pub no_cache: bool,
    /// True when the job was submitted with `DryRun: true` (no actual changes).
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub parent_job_id: Option<u64>,
    #[serde(default)]
    pub execute_id: Option<String>,
    /// The names of the options a file browser transfer runs with, set in its dialog or
    /// as the file browser's default.
    #[serde(default)]
    pub transfer_options: Option<String>,
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
            starter: None,
            origin: None,
            group: None,
            no_cache: false,
            dry_run: false,
            parent_job_id: None,
            execute_id: None,
            transfer_options: None,
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
    pub fn with_starter(mut self, starter: Option<Starter>) -> Self {
        self.starter = starter;
        self
    }

    #[must_use]
    pub fn with_execute_id(mut self, execute_id: Option<String>) -> Self {
        self.execute_id = execute_id;
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
    pub fn with_transfer_options(mut self, transfer_options: Option<String>) -> Self {
        self.transfer_options = transfer_options;
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
        Self::new(remote_name, job_type, vec![source.into()], "")
            .with_origin(origin)
            .with_group(group)
            .with_no_cache(true)
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
        Self::new(remote_name, job_type, source, destination)
            .with_origin(origin)
            .with_group(group)
    }

    /// The profile that started the job, if it was a profile.
    pub fn profile_name(&self) -> Option<&str> {
        starter::profile_name(self.starter.as_ref())
    }

    pub fn group_name(&self) -> String {
        if let Some(group) = &self.group {
            return group.clone();
        }
        let remote = self.remote_name.trim_end_matches(':').trim_end_matches('/');
        match self.profile_name() {
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
        Origin::of_work(self.origin.as_ref(), self.starter.as_ref())
    }

    pub fn started_event(&self, backend: String) -> NotificationEvent {
        NotificationEvent::Job(JobStage::Started {
            backend,
            remote: self.remote_name.clone(),
            profile: self.profile_name().map(str::to_string),
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
            profile: self.profile_name().map(str::to_string),
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
            profile: self.profile_name().map(str::to_string),
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
            profile: self.profile_name().map(str::to_string),
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

/// What was sent to rclone to start a job. It stays in memory and is never written to disk (its
/// options can carry credentials), so a job of this session that failed or was stopped can run
/// again with [`retry_job`].
#[derive(Debug, Clone)]
pub struct JobRequest {
    endpoint: String,
    payload: Value,
    metadata: JobMetadata,
}

impl JobRequest {
    /// The request of a job that can run again as it was sent. A mount starts from its profile,
    /// and a Quick Run or a workflow node from its own view.
    fn for_retry(endpoint: &str, payload: &Value, metadata: &JobMetadata) -> Option<Self> {
        let retryable = !metadata.no_cache
            && metadata.job_type != JobType::Mount
            && matches!(metadata.starter, None | Some(Starter::Profile { .. }));
        retryable.then(|| {
            // A retry runs in a stats group of its own; the first run's group stays behind.
            let mut payload = payload.clone();
            if let Some(request) = payload.as_object_mut() {
                request.remove("_group");
            }
            if let Some(inputs) = payload.get_mut("inputs").and_then(Value::as_array_mut) {
                for input in inputs.iter_mut().filter_map(Value::as_object_mut) {
                    input.remove("_group");
                }
            }
            Self {
                endpoint: endpoint.to_owned(),
                payload,
                metadata: metadata.clone(),
            }
        })
    }

    /// What a retry sends after the job failed with `output`: of a batch, only the inputs rclone
    /// reported failed, with the batch's options; anything else whole.
    #[must_use]
    pub(crate) fn after_failure(&self, output: &Value) -> Self {
        let failed: Vec<Value> = match output.get("results") {
            Some(Value::Array(results)) if self.endpoint == job::BATCH => {
                results.iter().filter_map(failed_batch_input).collect()
            }
            _ => Vec::new(),
        };
        let mut retry = self.clone();
        if !failed.is_empty() {
            retry.payload["inputs"] = Value::Array(failed);
        }
        retry
    }
}

#[cfg(test)]
impl JobRequest {
    /// The request of an empty copy batch, for tests of the job cache.
    pub(crate) fn for_test(metadata: &JobMetadata) -> Arc<Self> {
        Arc::new(
            Self::for_retry(job::BATCH, &json!({ "inputs": [] }), metadata)
                .expect("a copy can be retried"),
        )
    }
}

/// A `job/batch` result of an input that failed, turned back into that input: rclone answers it
/// with the call's `path`, the `input` it ran with and the `error` as text (a successful sync's
/// output also has an `error` key, a list of files). The group is dropped, as in
/// [`JobRequest::for_retry`].
fn failed_batch_input(result: &Value) -> Option<Value> {
    result.get("error")?.as_str()?;
    let path = result.get("path")?.as_str()?;
    let mut input = result.get("input")?.as_object()?.clone();
    input.remove("_group");
    input.insert("_path".to_owned(), json!(path));
    Some(Value::Object(input))
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
    let request = JobRequest::for_retry(endpoint, &payload, &metadata).map(Arc::new);
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
            .create_job(
                jobid,
                metadata.clone(),
                context.backend_name.clone(),
                request,
            )
            .await;
        context.cache.prune_finished(Some(&app)).await;
    }
    let announced = match metadata.execute_id.as_deref() {
        Some(execution) => {
            app.state::<AutomationsCache>()
                .bind_job_execution(&context.backend_name, execution, jobid)
                .await
        }
        None => false,
    };
    if !metadata.no_cache && metadata.job_type != JobType::Mount {
        notify_job(
            &app,
            metadata.started_event(context.backend_name.clone()),
            announced,
        );
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
    // A job is started in the background; rclone answers at once with its id.
    if let Some(request) = payload.as_object_mut() {
        request.insert("_async".to_owned(), json!(true));
    }
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

/// Runs a job and waits for it to end: the output rclone returned, or why the job failed.
pub async fn run_job(
    app: AppHandle,
    endpoint: &str,
    payload: Value,
    metadata: JobMetadata,
    backend: Option<Backend>,
) -> Result<Value, String> {
    let submission = submit_job_with_options(
        app,
        endpoint,
        payload,
        metadata,
        SubmitJobOptions {
            wait_for_completion: true,
            backend,
        },
    )
    .await?;
    Ok(submission.output.unwrap_or_else(|| json!({})))
}

pub async fn get_jobs(app: AppHandle) -> Result<Vec<JobInfo>, String> {
    Ok(app
        .state::<BackendManager>()
        .job_cache()
        .await
        .get_jobs()
        .await)
}

/// A job's stats with the file rows the job lists leave out of a finished job, or `None` when
/// the job (that run of it, when `execute_id` is given) is gone.
pub async fn get_job_stats(
    app: AppHandle,
    jobid: u64,
    execute_id: Option<String>,
) -> Result<Option<Value>, String> {
    Ok(app
        .state::<BackendManager>()
        .job_cache()
        .await
        .job_stats(jobid, execute_id.as_deref())
        .await)
}

/// The file reports a finished sync, copy or move job kept, or `None` when it kept none.
pub async fn get_job_report(app: AppHandle, jobid: u64) -> Result<Option<Value>, String> {
    Ok(app
        .state::<BackendManager>()
        .job_cache()
        .await
        .get_job_report(jobid)
        .await
        .map(|report| (*report).clone()))
}

pub async fn delete_job(app: AppHandle, jobid: u64) -> Result<(), String> {
    info!("Deleting job with ID: {jobid}");
    app.state::<BackendManager>()
        .job_cache()
        .await
        .delete_job(jobid, Some(&app))
        .await
}

/// Runs a failed or stopped job of this session again, as a new job; returns its ID. A batch
/// that partly failed sends only its failed inputs again.
pub async fn retry_job(app: AppHandle, jobid: u64) -> Result<u64, String> {
    let job = app
        .state::<BackendManager>()
        .job_cache()
        .await
        .get_job(jobid)
        .await
        .ok_or_else(|| crate::localized_error!("backendErrors.job.notFound"))?;
    let request = job
        .request
        .filter(|_| matches!(job.status, JobStatus::Failed | JobStatus::Stopped))
        .ok_or_else(|| crate::localized_error!("backendErrors.job.notRetryable"))?;
    let JobRequest {
        endpoint,
        payload,
        mut metadata,
    } = (*request).clone();
    // A new execution with its own stats group, so its numbers do not mix with the first run.
    metadata.execute_id = None;
    metadata.group = None;
    info!("Retrying job {jobid} ({})", metadata.job_type);
    submit_job_with_options(
        app,
        &endpoint,
        payload,
        metadata,
        SubmitJobOptions::default(),
    )
    .await
    .map(|submission| submission.job_id)
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

/// One poll: the job's status, and its group's stats with the completed transfers when kept.
struct PolledJob {
    status: Value,
    stats: Option<Value>,
}

/// Takes the parts of a poll's batch response, after checking the job status in it.
fn split_poll(mut batch: Value) -> Result<PolledJob, String> {
    monitor_status(&batch)?;
    let results = batch
        .get_mut("results")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "Missing job status in batch response".to_string())?;
    let stats = match results.as_mut_slice() {
        [_, stats, history, ..]
            if stats.is_object()
                && stats
                    .get("status")
                    .and_then(Value::as_u64)
                    .is_none_or(|code| code < 400) =>
        {
            let mut stats = stats.take();
            if let Some(history) = history
                .get_mut("transferred")
                .map(Value::take)
                .filter(Value::is_array)
            {
                stats["completed"] = history;
            }
            Some(stats)
        }
        _ => None,
    };
    Ok(PolledJob {
        status: results[0].take(),
        stats,
    })
}

/// rclone forgot the job: it expired after finishing, or the engine restarted and numbers
/// its jobs from 1 again. Waiting longer cannot bring the result back.
fn job_is_gone(error: &str) -> bool {
    error.contains("job not found")
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
    let mut polls = 0usize;
    // The engine run that owns the job; a different one answering means the job id was reused.
    let mut engine_run: Option<String> = None;

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
            .and_then(split_poll);

        let mut wait = poll_delay(polls, ui_visible(&app));
        match poll_result {
            Ok(PolledJob { status, stats }) => {
                consecutive_errors = 0;
                if let Some(run) = status.get("executeId").and_then(Value::as_str) {
                    let first = engine_run.get_or_insert_with(|| run.to_owned());
                    if first != run {
                        return finish_lost_job(&context, jobid, &metadata, &app).await;
                    }
                }
                let finished = status["finished"] == true;
                let mut last_stats = None;
                if let Some(stats) = stats {
                    if finished {
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
                if finished {
                    return handle_job_completion(
                        &context, jobid, &metadata, status, &app, last_stats,
                    )
                    .await;
                }
            }
            Err(error) if job_is_gone(&error) => {
                warn!("Job {jobid} is no longer known to rclone: {error}");
                return finish_lost_job(&context, jobid, &metadata, &app).await;
            }
            Err(error) => {
                // A failing poll is retried at the regular pace: three quick failures in a row
                // would end the monitoring of a job that a short hiccup left running.
                wait = Duration::from_millis(JOB_POLL_INTERVAL_MS);
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

        polls += 1;
        sleep(wait).await;
    }
}

async fn finish_lost_job(
    context: &JobContext,
    jobid: u64,
    metadata: &JobMetadata,
    app: &AppHandle,
) -> Result<Value, String> {
    let error = crate::localized_error!("backendErrors.job.lost");
    handle_job_completion(
        context,
        jobid,
        metadata,
        json!({"finished": true, "success": false, "error": error}),
        app,
        None,
    )
    .await
}

async fn handle_job_completion(
    context: &JobContext,
    jobid: u64,
    metadata: &JobMetadata,
    mut job_status: Value,
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

    let announced = crate::services::automation::engine::finish_job_execution(
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
        announced,
    );

    match failure_message(&outcome) {
        Some(error) => Err(error),
        None => Ok(job_status
            .get_mut("output")
            .map_or_else(|| json!({}), Value::take)),
    }
}

/// What the waiter for a job receives when it did not succeed.
fn failure_message(outcome: &JobOutcome) -> Option<String> {
    if outcome.success {
        return None;
    }
    Some(outcome.error_msg.clone().unwrap_or_else(|| {
        if outcome.stopped {
            crate::localized_error!("backendErrors.job.stopped")
        } else {
            crate::localized_error!("backendErrors.job.failed")
        }
    }))
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
    let had_errors = !outcome.success
        || final_stats
            .get("errors")
            .and_then(Value::as_u64)
            .is_some_and(|errors| errors > 0);
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
            job_report(&metadata.job_type, raw_output, had_errors),
        )
        .await?;
    if !outcome.success
        && let Some(output) = raw_output
    {
        job_cache
            .narrow_retry_request(jobid, metadata.execute_id.as_deref(), output)
            .await?;
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
    announced_by_automation: bool,
) {
    let send = |event| notify_job(app, event, announced_by_automation);
    if outcome.stopped {
        info!("{} Job {jobid} stopped by user.", metadata.job_type);
        if !metadata.no_cache {
            send(metadata.stopped_event(backend_name.to_string()));
        }
        return;
    }

    if let Some(raw_err) = failure_message(outcome) {
        let error_for_notify = crate::rclone::engine::error_mapper::map_rclone_error(&raw_err)
            .unwrap_or_else(|| raw_err.clone());
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
            send(metadata.failed_event(backend_name.to_string(), &error_for_notify));
        }
        return;
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
            send(metadata.completed_event(backend_name.to_string()));
        }
    }
}

async fn collect_final_stats(
    transport: &dyn RcloneTransport,
    metadata: &JobMetadata,
    last_stats: Option<Value>,
) -> Value {
    let params = json!({ "group": metadata.group_name() });
    let (mut stats, transferred) = match last_stats {
        Some(stats) if stats.get("completed").is_some_and(Value::is_array) => return stats,
        Some(stats) if stats.as_object().is_some_and(|stats| !stats.is_empty()) => {
            let transferred = transport.rpc(core::TRANSFERRED, Some(&params)).await;
            (stats, transferred)
        }
        _ => {
            let (stats, transferred) = tokio::join!(
                transport.rpc(core::STATS, Some(&params)),
                transport.rpc(core::TRANSFERRED, Some(&params)),
            );
            (stats.unwrap_or_else(|_| json!({})), transferred)
        }
    };

    if let Ok(mut data) = transferred
        && let Some(history) = data.get_mut("transferred").map(Value::take)
        && history.is_array()
        && let Some(stats) = stats.as_object_mut()
    {
        stats.insert("completed".to_string(), history);
    }

    stats
}

pub async fn stop_job(app: AppHandle, jobid: u64) -> Result<(), String> {
    let backend = app.state::<BackendManager>().get_active().await;
    stop_job_on_backend(app, backend, jobid).await
}

/// Stop the running `job_type` job that `profile_name` started on `remote_name`.
pub async fn stop_job_profile(
    app: AppHandle,
    remote_name: String,
    profile_name: String,
    job_type: JobType,
) -> Result<(), String> {
    let backend = app.state::<BackendManager>().get_active().await;
    let running = app
        .state::<BackendManager>()
        .job_cache_for(&backend.name)
        .get_active_jobs()
        .await
        .into_iter()
        .find(|j| {
            j.remote_name == remote_name
                && j.job_type == job_type
                && starter::profile_name(j.starter.as_ref()) == Some(profile_name.as_str())
        })
        .ok_or_else(|| {
            crate::localized_error!(
                "backendErrors.job.profileNotRunning",
                "remote" => remote_name,
                "profile" => profile_name,
                "jobType" => job_type
            )
        })?;
    stop_job_on_backend(app, backend, running.jobid).await
}

pub(crate) async fn stop_job_on_backend(
    app: AppHandle,
    backend: Backend,
    jobid: u64,
) -> Result<(), String> {
    let context = JobContext::for_backend(&app, backend);
    let transport = &context.transport;
    let job_cache = &context.cache;

    // A job of this process ends itself, as stopped or as it had already ended.
    if job_cache.cancel_own_job(jobid).await? {
        return Ok(());
    }
    // The remote the operation log files the stop under.
    let remote_name = job_cache.get_job(jobid).await.map(|job| job.remote_name);

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
                remote_name.clone(),
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
        remote_name.clone(),
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

    let running: Vec<u64> = job_cache
        .get_active_jobs()
        .await
        .into_iter()
        .filter(|job| job.group == group)
        .map(|job| job.jobid)
        .collect();
    // A group the cache knows no job of can still hold rclone's (a file browser's list reads).
    let mut rclone_jobs = running.is_empty();
    for &jobid in &running {
        // A job of this process stops its own requests and ends itself.
        if !job_cache.cancel_own_job(jobid).await? {
            rclone_jobs = true;
        }
    }

    if rclone_jobs {
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

    // Also the jobs that joined the group meanwhile: rclone stopped them too.
    for job in job_cache.get_active_jobs().await {
        if job.group == group {
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

pub async fn submit_batch_job_with_options(
    app: AppHandle,
    inputs: Vec<Value>,
    metadata: JobMetadata,
    options: SubmitJobOptions,
) -> Result<u64, String> {
    submit_job_with_options(
        app,
        job::BATCH,
        json!({ "inputs": inputs }),
        metadata,
        options,
    )
    .await
    .map(|submission| submission.job_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn copy_batch() -> Value {
        json!({
            "_async": true,
            "_group": "copy/drive_first",
            "_config": {"Transfers": 2},
            "inputs": [
                {"_path": "operations/copyfile", "srcFs": "/home", "srcRemote": "a", "_group": "copy/drive_first"},
                {"_path": "operations/copyfile", "srcFs": "/home", "srcRemote": "b"},
                {"_path": "sync/copy", "srcFs": "/home/c", "dstFs": "drive:c"},
            ]
        })
    }

    #[test]
    fn a_request_is_kept_for_a_retry_without_the_first_runs_stats_group() {
        let metadata = JobMetadata::new("drive", JobType::Copy, vec![], "drive:");
        let request = JobRequest::for_retry(job::BATCH, &copy_batch(), &metadata).unwrap();
        assert!(request.payload.get("_group").is_none());
        assert!(request.payload["inputs"][0].get("_group").is_none());
        assert_eq!(request.payload["_config"], json!({"Transfers": 2}));
        assert_eq!(request.payload["inputs"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn mounts_quick_runs_workflow_nodes_and_uncached_calls_keep_no_request() {
        let payload = json!({});
        let base = JobMetadata::new("drive", JobType::Sync, vec![], "/home");
        let profile = base.clone().with_starter(Some(Starter::Profile {
            name: "daily".into(),
        }));
        assert!(JobRequest::for_retry(job::BATCH, &payload, &base).is_some());
        assert!(JobRequest::for_retry(job::BATCH, &payload, &profile).is_some());

        let mount = JobMetadata::new("drive", JobType::Mount, vec![], "/mnt");
        let quick_run = base.clone().with_starter(Some(Starter::QuickRun {
            id: "qr".into(),
            name: "Nightly".into(),
            workflow: None,
        }));
        let uncached = base.clone().with_no_cache(true);
        for metadata in [mount, quick_run, uncached] {
            assert!(JobRequest::for_retry(job::BATCH, &payload, &metadata).is_none());
        }
    }

    #[test]
    fn a_retry_of_a_batch_sends_only_the_inputs_rclone_reported_failed() {
        let metadata = JobMetadata::new("drive", JobType::Copy, vec![], "drive:");
        let request = JobRequest::for_retry(job::BATCH, &copy_batch(), &metadata).unwrap();
        let output = json!({"results": [
            {},
            {
                "error": "connection reset",
                "status": 500,
                "path": "operations/copyfile",
                "input": {"srcFs": "/home", "srcRemote": "b", "_group": "copy/drive_first"}
            },
            // A sync that ran lists the files it could not copy under `error`; it did not fail.
            {"error": [], "missingOnSrc": []},
        ]});
        let retry = request.after_failure(&output);
        assert_eq!(
            retry.payload["inputs"],
            json!([{"_path": "operations/copyfile", "srcFs": "/home", "srcRemote": "b"}])
        );
        assert_eq!(retry.payload["_config"], json!({"Transfers": 2}));
    }

    #[test]
    fn a_retry_sends_everything_again_when_rclone_named_no_failed_part() {
        let metadata = JobMetadata::new("drive", JobType::Copy, vec![], "drive:");
        let batch = JobRequest::for_retry(job::BATCH, &copy_batch(), &metadata).unwrap();
        for output in [json!({}), json!({"results": [{}, {}, {}]})] {
            let retry = batch.after_failure(&output);
            assert_eq!(retry.payload, batch.payload);
        }

        let sync = JobRequest::for_retry(
            crate::rclone::endpoints::sync::SYNC,
            &json!({"srcFs": "/a", "dstFs": "drive:a"}),
            &metadata,
        )
        .unwrap();
        let output = json!({"results": [{"error": "x", "path": "p", "input": {}}]});
        assert_eq!(sync.after_failure(&output).payload, sync.payload);
    }

    #[test]
    fn a_job_is_polled_quickly_at_first_and_then_at_the_regular_pace() {
        let waits = |visible| {
            (0..7)
                .map(|poll| poll_delay(poll, visible).as_millis() as u64)
                .collect::<Vec<_>>()
        };
        assert_eq!(waits(true), [50, 100, 200, 350, 500, 500, 500]);
        // A short job is noticed as fast with no window open; a long one is followed slower.
        assert_eq!(waits(false), [50, 100, 200, 350, 2000, 2000, 2000]);
        assert!(
            JOB_FIRST_POLLS_MS
                .iter()
                .all(|wait| *wait < JOB_POLL_INTERVAL_MS)
        );
    }

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
            .with_starter(Some(Starter::profile("daily")));
        let mut second = first.clone();
        first.prepare_execution();
        second.prepare_execution();
        assert_ne!(first.group_name(), second.group_name());
        assert_ne!(first.execute_id, second.execute_id);
        assert!(first.group_name().starts_with("sync/drive/daily_"));
        let prepared = first.group_name();
        first.prepare_execution();
        assert_eq!(first.group_name(), prepared);

        let quick_run = JobMetadata::new("drive:", JobType::Sync, vec![], "dst:")
            .with_starter(Some(Starter::quick_run("qr-1", "daily", None)));
        assert_eq!(quick_run.profile_name(), None);
        assert_eq!(quick_run.group_name(), "sync/drive");

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
        .with_starter(Some(Starter::profile("daily")))
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
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let directory = tempfile::tempdir().unwrap();
        let settings: AppSettingsManager = rcman::SettingsManager::builder("job-test", "1.0.0")
            .with_config_dir(directory.path())
            .with_schema::<AppSettings>()
            .with_sub_settings(rcman::SubSettingsConfig::new("remotes").with_profiles())
            .with_sub_settings(rcman::SubSettingsConfig::singlefile("backend").with_profiles())
            .with_sub_settings(rcman::SubSettingsConfig::singlefile("quick_runs").with_profiles())
            .with_sub_settings(rcman::SubSettingsConfig::singlefile("workflows").with_profiles())
            .build()
            .unwrap();
        let manager = BackendManager::new();
        manager
            .add(
                &settings,
                Backend::new_remote("A", "127.0.0.1", listener.local_addr().unwrap().port()),
                crate::rclone::backend::CopySources::default(),
            )
            .await
            .unwrap();
        // B must never receive a request. A connection attempt to port 0 fails the test.
        manager
            .add(
                &settings,
                Backend::new_remote("B", "127.0.0.1", 0),
                crate::rclone::backend::CopySources::default(),
            )
            .await
            .unwrap();
        manager.switch_to(&settings, "A").await.unwrap();
        let app = AppHandle::default();
        app.manage(manager);
        app.manage(settings);
        app.manage(AutomationsCache::new());
        app.manage(RcloneState::new(
            reqwest::Client::builder()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
            Arc::new(RoutingTransport::new(app.clone())),
        ));
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
            .try_start_automation(&automation_id, "A", None, true)
            .await
            .unwrap()
            .unwrap()
            .execution_id;
        let metadata = make_meta(None, Some("daily")).with_execute_id(execution.clone());
        let b_cache = manager.job_cache_for("B");
        b_cache
            .create_job(7, metadata.clone(), "B".into(), None)
            .await;
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
                            {"finished": true, "success": success, "error": if success { "" } else { "transfer failed" }, "output": if batch { json!({"owner": "A", "results": [{"combined": ["+ new.txt", "- old.txt"]}]}) } else { json!({"owner": "A", "combined": ["+ new.txt", "- old.txt"]}) }},
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
                    7
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
        // The reports rclone returned stay with the job on its own backend, whether it worked or not.
        let finished = a_cache.get_job(7).await.unwrap();
        assert_eq!(finished.report_counts.unwrap()["combined"], 2);
        assert_eq!(
            a_cache.get_job_report(7).await.unwrap()["combined"][1],
            "- old.txt"
        );
        assert!(b_cache.get_job_report(7).await.is_none());
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

    #[test]
    fn a_poll_is_split_without_losing_stats_or_history() {
        let batch = json!({"results": [
            {"finished": false, "executeId": "run-1"},
            {"bytes": 5},
            {"transferred": [{"name": "a.txt"}]},
        ]});
        let polled = split_poll(batch).unwrap();
        assert_eq!(polled.status["executeId"], "run-1");
        let stats = polled.stats.unwrap();
        assert_eq!(stats["bytes"], 5);
        assert_eq!(stats["completed"][0]["name"], "a.txt");

        // A failed stats call or a status-only poll keeps the status and drops the stats.
        let failed_stats = json!({"results": [
            {"finished": false},
            {"status": 500, "error": "no group"},
            {"transferred": []},
        ]});
        assert!(split_poll(failed_stats).unwrap().stats.is_none());
        let status_only = json!({"results": [{"finished": false}]});
        assert!(split_poll(status_only).unwrap().stats.is_none());
        // Without a history the stats come through as rclone returned them.
        let no_history =
            json!({"results": [{"finished": false}, {"bytes": 1}, {"transferred": "x"}]});
        let stats = split_poll(no_history).unwrap().stats.unwrap();
        assert!(stats.get("completed").is_none());
    }

    #[test]
    fn a_poll_with_a_missing_job_is_an_error_that_stops_the_monitor() {
        let batch = json!({"results": [{"status": 500, "error": "job not found"}]});
        let error = split_poll(batch).err().unwrap();
        assert!(job_is_gone(&error));
        assert!(!job_is_gone("connection refused"));
    }

    #[test]
    fn waiters_get_a_localized_error_for_stopped_and_failed_jobs() {
        let outcome = |success, stopped, error: Option<&str>| JobOutcome {
            success,
            stopped,
            error_msg: error.map(str::to_string),
            cryptcheck_output: None,
        };
        assert_eq!(failure_message(&outcome(true, false, None)), None);
        assert_eq!(
            failure_message(&outcome(false, false, Some("boom"))).as_deref(),
            Some("boom")
        );
        let stopped = failure_message(&outcome(false, true, None)).unwrap();
        assert!(stopped.contains("backendErrors.job.stopped"));
        let failed = failure_message(&outcome(false, false, None)).unwrap();
        assert!(failed.contains("backendErrors.job.failed"));
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
            .with_starter(profile.map(Starter::profile))
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
