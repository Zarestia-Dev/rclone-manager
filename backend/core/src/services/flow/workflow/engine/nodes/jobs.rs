//! Jobs: waiting for rclone jobs, their outputs, Quick Runs and transfer operations.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use log::info;
use parking_lot::RwLock;
use serde_json::{Value, json};

use crate::context::AppHandle;
use crate::rclone::backend::{BackendManager, types::Backend};
use crate::rclone::commands::{
    common::parse_common_config, job::JobMetadata, sync::submit_transfer_batch,
};
use crate::rclone::state::job::JobPoll;
use crate::services::flow::workflow::engine::nodes::extract_node_op_config;
use crate::services::flow::workflow::engine::{
    RunContext,
    cancel::{CancelToken, sleep_unless_cancelled},
};
use crate::services::flow::workflow::types::{NodeExecutionOutput, WorkflowNode};
use crate::utils::format::format_file_size;
use crate::utils::types::{jobs::JobType, origin::Origin, remotes::OperationType};

/// Helper RAII guard ensuring a job ID is removed from the active jobs set upon exit.
struct ActiveJobGuard {
    pub(crate) active_jobs: Arc<RwLock<HashSet<u64>>>,
    pub(crate) job_id: u64,
}

impl Drop for ActiveJobGuard {
    fn drop(&mut self) {
        self.active_jobs.write().remove(&self.job_id);
    }
}

fn extract_string_list(val: Option<&Value>) -> Vec<String> {
    match val {
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect(),
        _ => Vec::new(),
    }
}

/// Most files listed per section of a check report.
const CHECK_REPORT_LIST_LIMIT: usize = 20;

/// Appends a report section: its heading, then the first files and how many were left out.
fn push_report_files(lines: &mut Vec<String>, heading: String, files: &[String]) {
    if files.is_empty() {
        return;
    }
    lines.push(format!("- **{heading}**:"));
    lines.extend(
        files
            .iter()
            .take(CHECK_REPORT_LIST_LIMIT)
            .map(|file| format!("  • {file}")),
    );
    if files.len() > CHECK_REPORT_LIST_LIMIT {
        lines.push(format!(
            "  • {}",
            crate::t!(
                "backendErrors.workflow.reportAndMore",
                "count" => files.len() - CHECK_REPORT_LIST_LIMIT
            )
        ));
    }
}

/// Normalizes Rclone JobInfo stats into a rich, structured execution output.
fn build_job_execution_output(
    mut job: crate::utils::types::jobs::JobInfo,
    is_success: bool,
    error_msg: Option<&str>,
) -> Value {
    let stats = job.stats.as_ref();
    let bytes = stats
        .and_then(|s| s.get("bytes"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let total_bytes = stats
        .and_then(|s| s.get("totalBytes"))
        .and_then(Value::as_u64)
        .unwrap_or(bytes);
    let transfers = stats
        .and_then(|s| s.get("transfers"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let total_transfers = stats
        .and_then(|s| s.get("totalTransfers"))
        .and_then(Value::as_u64)
        .unwrap_or(transfers);
    let errors = stats
        .and_then(|s| s.get("errors"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let checks = stats
        .and_then(|s| s.get("checks"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let speed = stats
        .and_then(|s| s.get("speed"))
        .and_then(Value::as_f64)
        .map(|f| f.max(0.0) as u64)
        .unwrap_or(0);

    let is_check = matches!(job.job_type, JobType::Check | JobType::CryptCheck);

    let check_obj = stats.and_then(|s| s.get("checkOutput")).or(stats);

    let differ = check_obj
        .and_then(|c| c.get("differ"))
        .map(|v| extract_string_list(Some(v)))
        .unwrap_or_default();
    let missing_on_dst = check_obj
        .and_then(|c| c.get("missingOnDst"))
        .map(|v| extract_string_list(Some(v)))
        .unwrap_or_default();
    let missing_on_src = check_obj
        .and_then(|c| c.get("missingOnSrc"))
        .map(|v| extract_string_list(Some(v)))
        .unwrap_or_default();
    let matched = check_obj
        .and_then(|c| c.get("match"))
        .map(|v| extract_string_list(Some(v)))
        .unwrap_or_default();
    let check_errors = check_obj
        .and_then(|c| c.get("error"))
        .map(|v| extract_string_list(Some(v)))
        .unwrap_or_default();

    let differ_count = differ.len();
    let missing_dst_count = missing_on_dst.len();
    let missing_src_count = missing_on_src.len();
    let match_count = if !matched.is_empty() {
        matched.len()
    } else {
        checks as usize
    };
    let error_count = check_errors.len().max(errors as usize);
    let has_differences = differ_count > 0 || missing_dst_count > 0 || missing_src_count > 0;

    let summary = if is_check {
        if has_differences {
            let total_diff = differ_count + missing_dst_count + missing_src_count;
            crate::t!(
                "backendErrors.workflow.summaryCheckDifferences",
                "total" => total_diff,
                "differ" => differ_count,
                "dst" => missing_dst_count,
                "src" => missing_src_count
            )
        } else if error_count > 0 {
            crate::t!("backendErrors.workflow.summaryCheckErrors", "count" => error_count)
        } else {
            crate::t!("backendErrors.workflow.summaryCheckPassed", "count" => match_count)
        }
    } else if is_success {
        if transfers > 0 || bytes > 0 {
            crate::t!(
                "backendErrors.workflow.summaryTransferred",
                "transfers" => transfers,
                "size" => format_file_size(bytes),
                "errors" => errors
            )
        } else {
            crate::t!("backendErrors.workflow.summaryNothingTransferred", "errors" => errors)
        }
    } else {
        let reason = error_msg
            .map(str::to_owned)
            .unwrap_or_else(|| crate::t!("backendErrors.workflow.unknownError"));
        crate::t!("backendErrors.workflow.summaryJobFailed", "error" => reason)
    };

    let mut out = json!({
        "jobId": job.jobid,
        "jobType": job.job_type.to_string(),
        "success": is_success,
        "status": if is_success { "success" } else { "failed" },
        "bytes": bytes,
        "bytesFormatted": format_file_size(bytes),
        "totalBytes": total_bytes,
        "totalBytesFormatted": format_file_size(total_bytes),
        "transfers": transfers,
        "totalTransfers": total_transfers,
        "errors": errors,
        "checks": checks,
        "speed": speed,
        "speedFormatted": format!("{}/s", format_file_size(speed)),
        "summary": summary,
        "stats": job.stats.take().unwrap_or_else(|| json!({})),
    });

    if is_check {
        let status_label = crate::t!("backendErrors.workflow.reportStatus");
        let mut report_lines = vec![format!(
            "### {}",
            crate::t!("backendErrors.workflow.reportTitle")
        )];
        if has_differences {
            let total_diff = differ_count + missing_dst_count + missing_src_count;
            report_lines.push(format!(
                "- **{status_label}**: {}",
                crate::t!("backendErrors.workflow.reportStatusDifferences", "count" => total_diff)
            ));
            if match_count > 0 {
                report_lines.push(format!(
                    "- **{}**: {match_count}",
                    crate::t!("backendErrors.workflow.reportMatchedFiles")
                ));
            }
            push_report_files(
                &mut report_lines,
                crate::t!("backendErrors.workflow.reportDiffering", "count" => differ_count),
                &differ,
            );
            push_report_files(
                &mut report_lines,
                crate::t!(
                    "backendErrors.workflow.reportMissingOnDestination",
                    "count" => missing_dst_count
                ),
                &missing_on_dst,
            );
            push_report_files(
                &mut report_lines,
                crate::t!(
                    "backendErrors.workflow.reportMissingOnSource",
                    "count" => missing_src_count
                ),
                &missing_on_src,
            );
        } else if error_count > 0 {
            report_lines.push(format!(
                "- **{status_label}**: {}",
                crate::t!("backendErrors.workflow.reportStatusErrors", "count" => error_count)
            ));
        } else {
            report_lines.push(format!(
                "- **{status_label}**: {}",
                crate::t!("backendErrors.workflow.reportStatusMatched", "count" => match_count)
            ));
        }
        let report = report_lines.join("\n");

        if let Some(obj) = out.as_object_mut() {
            obj.insert("hasDifferences".to_string(), json!(has_differences));
            obj.insert("differCount".to_string(), json!(differ_count));
            obj.insert("missingOnDstCount".to_string(), json!(missing_dst_count));
            obj.insert("missingOnSrcCount".to_string(), json!(missing_src_count));
            obj.insert("matchCount".to_string(), json!(match_count));
            obj.insert("errorCount".to_string(), json!(error_count));
            obj.insert("differ".to_string(), json!(differ));
            obj.insert("missingOnDst".to_string(), json!(missing_on_dst));
            obj.insert("missingOnSrc".to_string(), json!(missing_on_src));
            obj.insert("report".to_string(), json!(report));
        }
    }

    if let (Some(err), Some(obj)) = (error_msg, out.as_object_mut()) {
        obj.insert("error".to_string(), json!(err));
        obj.insert("errorMessage".to_string(), json!(err));
    }

    out
}

/// How often a running job is checked.
const JOB_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Awaits an active Rclone job until it reaches a terminal state or the run is cancelled.
async fn await_rclone_job(
    app: &AppHandle,
    backend: &Backend,
    job_id: u64,
    cancel: &CancelToken,
    active_jobs: &Arc<RwLock<HashSet<u64>>>,
    workflow_id: &str,
) -> Result<NodeExecutionOutput, String> {
    active_jobs.write().insert(job_id);
    let _guard = ActiveJobGuard {
        active_jobs: active_jobs.clone(),
        job_id,
    };

    let backend_manager = app.state::<BackendManager>();
    let job_cache = backend_manager.job_cache_for(&backend.name);

    loop {
        if cancel.is_cancelled() {
            info!("Workflow '{workflow_id}' cancelled; aborting job {job_id} in Rclone");
            let remote = job_cache
                .get_job(job_id)
                .await
                .map(|j| j.remote_name)
                .unwrap_or_default();
            let _ = crate::rclone::commands::job::stop_job_on_backend(
                app.clone(),
                backend.clone(),
                job_id,
                remote,
            )
            .await;
            return Err(crate::localized_error!("backendErrors.workflow.cancelled"));
        }

        match job_cache.poll_job(job_id).await {
            JobPoll::Missing => {
                return Err(crate::localized_error!(
                    "backendErrors.workflow.jobUntracked",
                    "id" => job_id
                ));
            }
            JobPoll::Running => {
                sleep_unless_cancelled(cancel, JOB_POLL_INTERVAL).await;
            }
            JobPoll::Completed(job) => {
                return Ok(NodeExecutionOutput::new(build_job_execution_output(
                    *job, true, None,
                )));
            }
            JobPoll::Failed(job) => return Ok(failed_job_output(job_id, *job)),
            JobPoll::Stopped => {
                return Err(crate::localized_error!(
                    "backendErrors.workflow.jobStopped",
                    "id" => job_id
                ));
            }
        }
    }
}

/// The output of a job that ended in failure: it flows on the `failure` branch.
fn failed_job_output(job_id: u64, job: crate::utils::types::jobs::JobInfo) -> NodeExecutionOutput {
    let err = job
        .error
        .clone()
        .unwrap_or_else(|| crate::t!("backendErrors.workflow.jobFailed", "id" => job_id));
    NodeExecutionOutput {
        value: build_job_execution_output(job, false, Some(&err)),
        branch: Some("failure".to_string()),
    }
}

/// The preset a 'quick_run' node points at.
pub(crate) fn quick_run_id(config: &Value) -> Result<&str, String> {
    config
        .get("quickRunId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| crate::localized_error!("backendErrors.workflow.missingQuickRunId"))
}

/// Runs a Quick Run preset and waits for the job it starts.
pub(crate) async fn quick_run_node(
    ctx: &RunContext,
    node: &WorkflowNode,
    config: &Value,
) -> Result<NodeExecutionOutput, String> {
    let RunContext {
        app,
        backend,
        cancel,
        active_jobs,
        ..
    } = ctx;
    let workflow = &ctx.snapshot.definition;
    let qr_id = quick_run_id(config)?;

    let qr = match ctx.snapshot.quick_runs.get(qr_id) {
        Some(qr) => qr.clone(),
        None => crate::services::automation::runtime::quick_run(app, qr_id)?,
    };
    if ctx.dry_run {
        info!(
            "Workflow dry_run enabled; simulating Quick Run '{}' ({:?})",
            qr.name, qr.operation_type
        );
        return Ok(NodeExecutionOutput::new(json!({
            "simulated": true,
            "dryRun": true,
            "quickRunId": qr_id,
            "name": qr.name,
            "operationType": qr.operation_type,
            "remoteName": qr.remote_name,
        })));
    }

    let res = crate::services::flow::quick_run::commands::start_quick_run_snapshot(
        app.clone(),
        backend.clone(),
        qr,
        Some(workflow.id.clone()),
        Some(node.id.clone()),
        None,
    )
    .await?;

    if let Some(job_id) = res.job_id {
        await_rclone_job(app, backend, job_id, cancel, active_jobs, &workflow.id).await
    } else {
        Ok(NodeExecutionOutput::new(
            serde_json::to_value(res).unwrap_or(json!({"started": true})),
        ))
    }
}

/// Runs one of the transfer operations (sync, copy, move, bisync, check, ...) and waits for its job.
pub(crate) async fn transfer_node(
    ctx: &RunContext,
    node: &WorkflowNode,
    config: &Value,
    op_type: OperationType,
) -> Result<NodeExecutionOutput, String> {
    let RunContext {
        app,
        backend,
        cancel,
        active_jobs,
        dry_run,
        ..
    } = ctx;
    let workflow = &ctx.snapshot.definition;
    let op = extract_node_op_config(config);
    let common = parse_common_config(op.config, &op.empty_settings)?;

    let dest_resolved = if !op.remote.is_empty() && !common.dest.contains(':') {
        if common.dest.is_empty() {
            format!("{}:", op.remote)
        } else {
            format!("{}:{}", op.remote, common.dest)
        }
    } else {
        common.dest.clone()
    };

    let target_pairs: Vec<(String, String)> = common
        .source
        .iter()
        .map(|s| (s.clone(), dest_resolved.clone()))
        .collect();

    let metadata = JobMetadata::new(
        op.remote.to_string(),
        op_type.as_job_type().unwrap_or(JobType::Sync),
        common.source.clone(),
        dest_resolved,
    )
    .with_origin(Some(Origin::Flow))
    .with_workflow_id(Some(workflow.id.clone()))
    .with_node_id(Some(node.id.clone()))
    .with_dry_run(*dry_run);

    let job_id_str = submit_transfer_batch(
        app.clone(),
        backend.clone(),
        op_type,
        target_pairs,
        &common,
        *dry_run,
        metadata,
    )
    .await?;

    let job_id = job_id_str.parse::<u64>().map_err(
        |e| crate::localized_error!("backendErrors.workflow.invalidJobId", "error" => e),
    )?;

    await_rclone_job(app, backend, job_id, cancel, active_jobs, &workflow.id).await
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::sync::Arc;

    use chrono::Utc;
    use parking_lot::RwLock;
    use serde_json::{Value, json};

    use super::*;
    use crate::context::AppHandle;
    use crate::rclone::backend::{BackendManager, types::Backend};
    use crate::rclone::commands::job::JobMetadata;

    use crate::utils::types::jobs::{JobStatus, JobType};

    fn check_job(job_type: JobType, stats: Value) -> crate::utils::types::jobs::JobInfo {
        crate::utils::types::jobs::JobInfo {
            stats_revision: 0,
            jobid: 5,
            job_type,
            remote_name: "drive:".to_string(),
            source: vec!["/local".to_string()],
            destination: "drive:backup".to_string(),
            start_time: Utc::now(),
            end_time: Some(Utc::now()),
            status: JobStatus::Completed,
            error: None,
            stats: Some(stats),
            group: "job-5".to_string(),
            profile: None,
            execute_id: None,
            quick_run_id: None,
            origin: None,
            backend_name: "local".to_string(),
            dry_run: false,
            parent_job_id: None,
            workflow_id: None,
            node_id: None,
        }
    }

    #[test]
    fn a_quick_run_node_needs_an_id_and_trims_it() {
        for config in [
            json!({ "quickRunId": "" }),
            json!({ "quickRunId": "   \t\n  " }),
            json!({}),
        ] {
            let error = quick_run_id(&config).unwrap_err();
            assert!(
                error.contains("backendErrors.workflow.missingQuickRunId"),
                "{error}"
            );
        }
        assert_eq!(
            quick_run_id(&json!({ "quickRunId": "  qr-backup-01  " })).unwrap(),
            "qr-backup-01"
        );
    }

    #[tokio::test]
    async fn workflow_wait_reads_the_owning_backends_job_even_when_another_is_selected() {
        let app = AppHandle::default();
        app.manage(BackendManager::new());
        let manager = app.state::<BackendManager>();
        let backend = Backend::new_remote("workflow-owner", "127.0.0.1", 0);
        let owner = manager.job_cache_for(&backend.name);
        let metadata =
            JobMetadata::new("drive", JobType::Copy, vec!["source".into()], "destination");
        owner
            .create_job(7, metadata.clone(), backend.name.clone())
            .await;
        owner
            .update_job_stats(7, json!({"bytes": 123}))
            .await
            .unwrap();
        owner.complete_job(7, true, None).await.unwrap();
        let selected = manager.job_cache().await;
        selected.create_job(7, metadata, "Local".into()).await;
        let active_jobs = Arc::new(RwLock::new(HashSet::new()));

        let output = await_rclone_job(
            &app,
            &backend,
            7,
            &CancelToken::new(),
            &active_jobs,
            "workflow",
        )
        .await
        .unwrap();
        assert_eq!(output.value["bytes"], 123);
        assert_eq!(
            selected.get_job(7).await.unwrap().status,
            JobStatus::Running
        );
        assert!(active_jobs.read().is_empty());
    }

    #[test]
    fn test_active_job_guard_cleanup() {
        let active_jobs = Arc::new(RwLock::new(HashSet::new()));
        active_jobs.write().insert(12345);
        assert!(active_jobs.read().contains(&12345));

        {
            let _guard = ActiveJobGuard {
                active_jobs: active_jobs.clone(),
                job_id: 12345,
            };
            assert!(active_jobs.read().contains(&12345));
        }

        assert!(!active_jobs.read().contains(&12345));
    }

    #[test]
    fn test_dry_run_job_metadata_propagation() {
        let dry_run = true;

        let metadata = JobMetadata::new(
            "test_remote".to_string(),
            crate::utils::types::jobs::JobType::Sync,
            vec!["src:".to_string()],
            "dst:".to_string(),
        )
        .with_workflow_id(Some("wf-123".to_string()))
        .with_node_id(Some("node-456".to_string()))
        .with_dry_run(dry_run);

        assert_eq!(metadata.workflow_id.as_deref(), Some("wf-123"));
        assert_eq!(metadata.node_id.as_deref(), Some("node-456"));
        assert!(metadata.dry_run);
    }

    #[test]
    fn test_workflow_bisync_and_transfer_dry_run_payload_generation() {
        let dry_run = true;

        // 1. Bisync payload verification: GenericTransferParams automatically injects
        // both modern flat dryRun/dry_run and legacy _config.DryRun without manual map mutations
        let bisync_params = crate::rclone::commands::sync::GenericTransferParams {
            source: "remote:path1".to_string(),
            dest: "local:/path2".to_string(),
            rclone_config: json!({
                "resync": true
            }),
            filter_options: None,
            backend_options: None,
            runtime_remote_options: None,
            transfer_type: OperationType::Bisync,
            is_dir: true,
            dry_run: Some(dry_run),
        };

        let bisync_body = bisync_params
            .to_rclone_body(false)
            .expect("Bisync body generation must succeed");
        let bisync_obj = bisync_body
            .as_object()
            .expect("Payload must be a JSON object");

        assert_eq!(
            bisync_obj.get("path1").and_then(Value::as_str),
            Some("remote:path1")
        );
        assert_eq!(
            bisync_obj.get("path2").and_then(Value::as_str),
            Some("local:/path2")
        );
        assert_eq!(
            bisync_obj.get("dryRun").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            bisync_obj.get("dry_run").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            bisync_obj.get("resync").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            bisync_obj
                .get("_config")
                .and_then(|c| c.get("DryRun"))
                .and_then(Value::as_bool),
            Some(true)
        );

        // 2. Standard Sync payload verification
        let sync_params = crate::rclone::commands::sync::GenericTransferParams {
            source: "src:".to_string(),
            dest: "dst:".to_string(),
            rclone_config: json!({}),
            filter_options: None,
            backend_options: None,
            runtime_remote_options: None,
            transfer_type: OperationType::Sync,
            is_dir: true,
            dry_run: Some(dry_run),
        };

        let sync_body = sync_params
            .to_rclone_body(false)
            .expect("Sync body generation must succeed");
        let sync_obj = sync_body
            .as_object()
            .expect("Payload must be a JSON object");

        assert_eq!(sync_obj.get("srcFs").and_then(Value::as_str), Some("src:"));
        assert_eq!(sync_obj.get("dstFs").and_then(Value::as_str), Some("dst:"));
        assert_eq!(sync_obj.get("dryRun").and_then(Value::as_bool), Some(true));
        assert_eq!(sync_obj.get("dry_run").and_then(Value::as_bool), Some(true));
        assert_eq!(
            sync_obj
                .get("_config")
                .and_then(|c| c.get("DryRun"))
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn test_build_job_execution_output_normalization() {
        let job = crate::utils::types::jobs::JobInfo {
            stats_revision: 0,
            jobid: 99,
            job_type: JobType::Check,
            remote_name: "drive:".to_string(),
            source: vec!["/local".to_string()],
            destination: "drive:backup".to_string(),
            start_time: Utc::now(),
            end_time: Some(Utc::now()),
            status: JobStatus::Completed,
            error: None,
            stats: Some(json!({
                "bytes": 1048576,
                "totalBytes": 1048576,
                "transfers": 0,
                "checks": 10,
                "errors": 0,
                "speed": 0.0,
                "checkOutput": {
                    "differ": ["diff1.txt"],
                    "missingOnDst": ["new.txt"],
                    "match": ["matched.txt"]
                }
            })),
            group: "job-99".to_string(),
            profile: None,
            execute_id: None,
            quick_run_id: None,
            origin: None,
            backend_name: "local".to_string(),
            dry_run: false,
            parent_job_id: None,
            workflow_id: None,
            node_id: None,
        };

        let output = build_job_execution_output(job.clone(), true, None);
        assert_eq!(output["jobId"], 99);
        assert_eq!(output["hasDifferences"], true);
        assert_eq!(output["differCount"], 1);
        assert_eq!(output["missingOnDstCount"], 1);
        assert_eq!(output["matchCount"], 1);
        assert_eq!(output["bytesFormatted"], "1.00 MiB");
        assert!(output["report"].as_str().unwrap().contains("diff1.txt"));
        assert!(
            output["summary"]
                .as_str()
                .unwrap()
                .contains("2 difference(s)")
        );
    }

    #[tokio::test]
    async fn a_job_missing_from_the_cache_is_not_reported_as_success() {
        let app = AppHandle::default();
        app.manage(BackendManager::new());
        let backend = Backend::new_remote("untracked-owner", "127.0.0.1", 0);
        let error = await_rclone_job(
            &app,
            &backend,
            404,
            &CancelToken::new(),
            &Arc::new(RwLock::new(HashSet::new())),
            "workflow",
        )
        .await
        .unwrap_err();
        assert!(
            error.contains("backendErrors.workflow.jobUntracked"),
            "{error}"
        );
    }

    #[test]
    fn check_reports_and_summaries_are_rendered_from_translations_and_trimmed_to_a_limit() {
        let many: Vec<String> = (0..25).map(|n| format!("file{n}.txt")).collect();
        let job = check_job(
            JobType::Check,
            json!({"checks": 3, "checkOutput": {"differ": many, "missingOnSrc": ["gone.txt"]}}),
        );
        let output = build_job_execution_output(job, true, None);

        assert_eq!(
            output["summary"],
            "Check found 26 difference(s): 25 differ, 0 missing on destination, 1 missing on source."
        );
        let report = output["report"].as_str().unwrap();
        assert!(report.starts_with("### Check Report\n"), "{report}");
        assert!(report.contains("- **Status**: Differences detected (26 file(s))"));
        assert!(report.contains("- **Differing Files (25)**:"));
        assert_eq!(report.matches("  • file").count(), CHECK_REPORT_LIST_LIMIT);
        assert!(report.contains("  • ... and 5 more"));
        assert!(report.contains("- **Missing on Source (1)**:\n  • gone.txt"));
        assert!(!report.contains("Missing on Destination"));

        let clean =
            build_job_execution_output(check_job(JobType::Check, json!({"checks": 4})), true, None);
        assert_eq!(
            clean["summary"],
            "Check passed: all 4 file(s) matched with 0 differences."
        );
        assert!(
            clean["report"]
                .as_str()
                .unwrap()
                .contains("All 4 file(s) matched identically (0 differences).")
        );
    }

    #[test]
    fn transfer_summaries_cover_success_nothing_and_failure() {
        let sync = |stats: Value, ok: bool, error: Option<&str>| {
            build_job_execution_output(check_job(JobType::Sync, stats), ok, error)["summary"]
                .as_str()
                .unwrap()
                .to_string()
        };
        assert_eq!(
            sync(json!({"bytes": 2048, "transfers": 2}), true, None),
            "2 file(s) (2.00 KiB) transferred successfully, 0 error(s)."
        );
        assert_eq!(
            sync(json!({}), true, None),
            "Transfer completed successfully (0 files transferred, 0 errors)."
        );
        assert_eq!(
            sync(json!({}), false, Some("disk full")),
            "Job failed: disk full"
        );
        assert_eq!(sync(json!({}), false, None), "Job failed: Unknown error");
    }
}
