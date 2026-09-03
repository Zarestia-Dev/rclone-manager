//! Workflow DAG Execution Engine
//!
//! Orchestrates the server-side execution of visual workflows, managing
//! reactive dependency-driven node execution, concurrent branching,
//! real-time Tauri event streaming, subprocess cancellation, and inter-node data flow.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use chrono::Utc;
use log::{info, warn};
use parking_lot::RwLock;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use super::dag::validate_workflow;
use super::types::{
    NodeExecutionOutput, WorkflowDefinition, WorkflowEdge, WorkflowExecutionResult,
    WorkflowExecutionStateEvent, WorkflowNode, WorkflowNodeCategory, WorkflowNodeExecutionState,
    WorkflowNodeStateEvent, WorkflowPortType, WorkflowProgress, parse_delay_seconds,
};
use crate::core::settings::AppSettingsManager;
use crate::rclone::backend::BackendManager;
use crate::rclone::commands::{
    common::{FromConfig, is_directory, parse_common_config},
    job::{JobMetadata, SubmitJobOptions, submit_batch_job, submit_job_with_options},
    mount::{MountParams, mount_remote},
    serve::{ServeParams, start_serve},
    sync::GenericTransferParams,
};
use crate::utils::{
    app::notification::{NotificationEvent, WorkflowStage, notify},
    constants::SUB_WORKFLOWS,
    types::{
        events::{WORKFLOW_EXECUTION_STATE_CHANGED, WORKFLOW_NODE_STATE_CHANGED},
        jobs::{JobStatus, JobType},
        origin::Origin,
        remotes::OperationType,
        state::RcloneState,
    },
};

#[derive(Clone)]
struct ActiveWorkflowState {
    cancel_flag: Arc<AtomicBool>,
    cancel_tx: tokio::sync::watch::Sender<bool>,
    active_job_ids: Arc<RwLock<HashSet<u64>>>,
}

static ACTIVE_WORKFLOW_EXECUTIONS: once_cell::sync::Lazy<
    RwLock<HashMap<String, ActiveWorkflowState>>,
> = once_cell::sync::Lazy::new(|| RwLock::new(HashMap::new()));

/// Halts an actively executing workflow and terminates any underlying Rclone transfer jobs.
pub async fn stop_workflow(app: &AppHandle, workflow_id: &str) -> Result<(), String> {
    let state_opt = {
        let map = ACTIVE_WORKFLOW_EXECUTIONS.read();
        map.get(workflow_id).cloned()
    };

    if let Some(state) = state_opt {
        state.cancel_flag.store(true, Ordering::SeqCst);
        let _ = state.cancel_tx.send(true);
        info!("Workflow cancellation requested for: {workflow_id}");

        let active_jobs: Vec<u64> = state.active_job_ids.read().iter().copied().collect();
        let backend_manager = app.state::<BackendManager>();
        for job_id in active_jobs {
            info!("Stopping active Rclone job {job_id} associated with workflow '{workflow_id}'");
            let remote = backend_manager
                .job_cache
                .get_job(job_id)
                .await
                .map(|j| j.remote_name)
                .unwrap_or_default();
            let _ = crate::rclone::commands::job::stop_job(app.clone(), job_id, remote).await;
        }

        cleanup_workflow_resources(app, workflow_id).await;

        Ok(())
    } else {
        warn!("No active execution found for workflow: {workflow_id}");
        Ok(())
    }
}

/// Cleans up any lingering mount or serve resources spawned by the given workflow.
pub async fn cleanup_workflow_resources(app: &AppHandle, workflow_id: &str) {
    let backend_manager = app.state::<BackendManager>();
    let mounted = backend_manager.remote_cache.get_mounted_remotes().await;
    for m in mounted {
        if m.workflow_id.as_deref() == Some(workflow_id) {
            info!(
                "Unmounting mount '{}' spawned by workflow '{workflow_id}'",
                m.mount_point
            );
            let _ =
                crate::rclone::commands::mount::unmount_remote(app.clone(), m.mount_point, m.fs)
                    .await;
        }
    }

    let serves = backend_manager.remote_cache.get_serves().await;
    for s in serves {
        if s.workflow_id.as_deref() == Some(workflow_id) {
            info!(
                "Stopping serve '{}' spawned by workflow '{workflow_id}'",
                s.id
            );
            let remote_name = s
                .params
                .get("fs")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let _ =
                crate::rclone::commands::serve::stop_serve(app.clone(), s.id, remote_name).await;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EdgeState {
    Pending,
    Activated,
    Disabled,
}

#[derive(Debug, Clone, PartialEq)]
enum NodeStatus {
    Pending,
    Running,
    Completed(NodeExecutionOutput),
    Failed(String),
    Skipped,
}

struct NodeFinishedEvent {
    node_id: String,
    outcome: Result<NodeExecutionOutput, String>,
    duration_ms: u64,
}

/// Resolves token values like `{{nodes.<id>.<path>}}` or `{{steps.<id>.<path>}}`
fn resolve_token_value(token: &str, results: &HashMap<String, Value>) -> Option<String> {
    let path = token
        .strip_prefix("nodes.")
        .or_else(|| token.strip_prefix("steps."))?;
    let mut parts = path.splitn(2, '.');
    let node_id = parts.next()?;
    let field_path = parts.next().unwrap_or("");

    let node_val = results.get(node_id)?;
    if field_path.is_empty() {
        return Some(match node_val {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        });
    }

    let mut current = node_val;
    for segment in field_path.split('.') {
        match current {
            Value::Object(map) => {
                current = map.get(segment)?;
            }
            Value::Array(arr) => {
                let idx: usize = segment.parse().ok()?;
                current = arr.get(idx)?;
            }
            _ => return None,
        }
    }

    Some(match current {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    })
}

fn replace_workflow_tokens(input: &str, results: &HashMap<String, Value>) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;

    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after_start = &rest[start + 2..];
        if let Some(end) = after_start.find("}}") {
            let token = after_start[..end].trim();
            if let Some(val_str) = resolve_token_value(token, results) {
                out.push_str(&val_str);
            } else {
                out.push_str("{{");
                out.push_str(token);
                out.push_str("}}");
            }
            rest = &after_start[end + 2..];
        } else {
            out.push_str("{{");
            rest = after_start;
        }
    }
    out.push_str(rest);
    out
}

pub(crate) fn interpolate_node_config(config: &Value, results: &HashMap<String, Value>) -> Value {
    match config {
        Value::String(s) => {
            let mut resolved = s.clone();
            if resolved.contains("{{") && resolved.contains("}}") {
                resolved = replace_workflow_tokens(&resolved, results);
            }
            crate::utils::json_helpers::interpolate_value(&Value::String(resolved))
        }
        Value::Object(map) => {
            let mut new_map = serde_json::Map::with_capacity(map.len());
            for (k, v) in map {
                new_map.insert(k.clone(), interpolate_node_config(v, results));
            }
            Value::Object(new_map)
        }
        Value::Array(arr) => Value::Array(
            arr.iter()
                .map(|v| interpolate_node_config(v, results))
                .collect(),
        ),
        _ => config.clone(),
    }
}

/// Helper struct consolidating duplicate node config extraction logic.
struct NodeOpConfig<'a> {
    remote: &'a str,
    config: &'a Value,
    empty_settings: Value,
}

fn extract_node_op_config<'a>(config: &'a Value) -> NodeOpConfig<'a> {
    let remote = config
        .get("remoteName")
        .or_else(|| config.get("remote"))
        .and_then(Value::as_str)
        .unwrap_or_default();

    let op_config = config.get("config").unwrap_or(config);

    NodeOpConfig {
        remote,
        config: op_config,
        empty_settings: json!({}),
    }
}

pub(crate) fn build_archive_final_dest(source: &str, dest_base: &str, format: &str) -> String {
    let mut final_dest = dest_base.to_string();
    if !crate::rclone::commands::sync::has_archive_extension(&final_dest) {
        let clean_src = source.trim_end_matches(':');
        let folder_name = clean_src
            .split(['/', '\\', ':'])
            .rfind(|s| !s.is_empty())
            .unwrap_or("archive");
        let filename = format!("{}.{}", folder_name, format);
        if final_dest.ends_with(':') || final_dest.ends_with('/') || final_dest.ends_with('\\') {
            final_dest.push_str(&filename);
        } else {
            final_dest.push_str(&format!("/{filename}"));
        }
    }
    final_dest
}

/// Activates downstream nodes based on outcome and port types.
fn activate_outgoing_edges(
    node: &WorkflowNode,
    outcome: &Result<NodeExecutionOutput, String>,
    edges: &[WorkflowEdge],
    edge_states: &mut HashMap<String, EdgeState>,
) {
    let outgoing = edges.iter().filter(|e| e.source_node_id == node.id);

    for edge in outgoing {
        let port = node.outputs.iter().find(|p| p.id == edge.source_port_id);
        let port_type = port.map(|p| &p.port_type);

        let is_match = match outcome {
            Ok(output) => match &output.branch {
                Some(branch) => {
                    if branch == "true" {
                        matches!(
                            port_type,
                            Some(WorkflowPortType::True)
                                | Some(WorkflowPortType::Out)
                                | Some(WorkflowPortType::Success)
                                | None
                        )
                    } else if branch == "false" {
                        matches!(port_type, Some(WorkflowPortType::False))
                    } else {
                        port.map(|p| p.id == *branch || p.name == *branch)
                            .unwrap_or(false)
                    }
                }
                None => matches!(
                    port_type,
                    Some(WorkflowPortType::Success) | Some(WorkflowPortType::Out) | None
                ),
            },
            Err(_) => matches!(port_type, Some(WorkflowPortType::Failure)),
        };

        if is_match {
            edge_states.insert(edge.id.clone(), EdgeState::Activated);
        } else {
            edge_states.insert(edge.id.clone(), EdgeState::Disabled);
        }
    }
}

/// Helper RAII guard ensuring a job ID is removed from the active jobs set upon exit.
struct ActiveJobGuard {
    active_jobs: Arc<RwLock<HashSet<u64>>>,
    job_id: u64,
}

impl Drop for ActiveJobGuard {
    fn drop(&mut self) {
        self.active_jobs.write().remove(&self.job_id);
    }
}

/// Awaits an active Rclone job until it reaches a terminal state,
/// periodically checking the workflow cancellation flag.
async fn await_rclone_job(
    app: &AppHandle,
    job_id: u64,
    cancel_flag: &AtomicBool,
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
    active_jobs: &Arc<RwLock<HashSet<u64>>>,
    workflow_id: &str,
) -> Result<NodeExecutionOutput, String> {
    active_jobs.write().insert(job_id);
    let _guard = ActiveJobGuard {
        active_jobs: active_jobs.clone(),
        job_id,
    };

    let backend_manager = app.state::<BackendManager>();
    let job_cache = &backend_manager.job_cache;

    loop {
        if cancel_flag.load(Ordering::SeqCst) {
            info!("Workflow '{workflow_id}' cancelled; aborting job {job_id} in Rclone");
            let remote = job_cache
                .get_job(job_id)
                .await
                .map(|j| j.remote_name)
                .unwrap_or_default();
            let _ = crate::rclone::commands::job::stop_job(app.clone(), job_id, remote).await;
            return Err("Execution cancelled by user".to_string());
        }

        if let Some(job) = job_cache.get_job(job_id).await {
            match job.status {
                JobStatus::Completed => {
                    return Ok(NodeExecutionOutput::new(json!({
                        "jobId": job_id,
                        "success": true,
                        "stats": job.stats,
                    })));
                }
                JobStatus::Failed => {
                    let err = job.error.unwrap_or_else(|| format!("Job {job_id} failed"));
                    return Err(err);
                }
                JobStatus::Stopped => {
                    return Err(format!("Job {job_id} was stopped"));
                }
                JobStatus::Running => {
                    tokio::select! {
                        _ = cancel_rx.changed() => {
                            info!("Workflow '{workflow_id}' received cancel signal; aborting job {job_id} in Rclone");
                            let remote = job_cache
                                .get_job(job_id)
                                .await
                                .map(|j| j.remote_name)
                                .unwrap_or_default();
                            let _ = crate::rclone::commands::job::stop_job(app.clone(), job_id, remote).await;
                            return Err("Execution cancelled by user".to_string());
                        }
                        _ = tokio::time::sleep(tokio::time::Duration::from_millis(250)) => {}
                    }
                }
            }
        } else {
            return Ok(NodeExecutionOutput::new(json!({
                "jobId": job_id,
                "status": "completed"
            })));
        }
    }
}

/// Evaluates a 'stop' node, setting the cancellation flag on graceful stop or returning an error on failed status.
fn handle_stop_node(
    config: &Value,
    cancel_flag: &AtomicBool,
) -> Result<NodeExecutionOutput, String> {
    let status = config
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("success");

    let message = config
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Workflow stopped by node");

    if status == "failed" || status == "error" {
        Err(format!("Halted with error: {message}"))
    } else {
        cancel_flag.store(true, Ordering::SeqCst);
        Ok(NodeExecutionOutput::new(json!({
            "stopped": true,
            "message": message,
            "status": status
        })))
    }
}

/// Evaluates a 'join' node, synchronizing parallel branches according to the configured joinMode.
pub(crate) fn handle_join_node(
    node: &WorkflowNode,
    workflow: &WorkflowDefinition,
    config: &Value,
    results: &HashMap<String, Value>,
) -> Result<NodeExecutionOutput, String> {
    let join_mode = config
        .get("joinMode")
        .and_then(Value::as_str)
        .unwrap_or("all_success");

    let incoming_edges: Vec<&WorkflowEdge> = workflow
        .edges
        .iter()
        .filter(|e| e.target_node_id == node.id)
        .collect();

    let mut branches_summary = serde_json::Map::new();
    let mut successful_count = 0;
    let total_branches = incoming_edges.len();

    for edge in &incoming_edges {
        let port_id = &edge.target_port_id;
        let src_id = &edge.source_node_id;
        if let Some(src_res) = results.get(src_id) {
            successful_count += 1;
            branches_summary.insert(
                port_id.clone(),
                json!({
                    "sourceNodeId": src_id,
                    "success": true,
                    "output": src_res
                }),
            );
        } else {
            branches_summary.insert(
                port_id.clone(),
                json!({
                    "sourceNodeId": src_id,
                    "success": false
                }),
            );
        }
    }

    match join_mode {
        "any_success" => {
            if successful_count == 0 && total_branches > 0 {
                return Err(
                    "Join barrier failed: none of the incoming branches succeeded".to_string(),
                );
            }
        }
        "always" => {
            // Always proceeds regardless of branch success count
        }
        _ => {
            // "all_success" is the default
            if successful_count < total_branches {
                return Err(format!(
                    "Join barrier failed: only {successful_count} of {total_branches} incoming branches succeeded"
                ));
            }
        }
    }

    Ok(NodeExecutionOutput::new(json!({
        "passed": true,
        "joinMode": join_mode,
        "totalBranches": total_branches,
        "successfulBranches": successful_count,
        "branches": branches_summary,
        "timestamp": Utc::now().to_rfc3339()
    })))
}

/// Evaluates a binary or unary condition comparing left and right values.
pub(crate) fn evaluate_condition(operator: &str, left: &str, right: &str) -> bool {
    match operator {
        "equals" => left == right,
        "not_equals" => left != right,
        "contains" => left.contains(right),
        "not_contains" => !left.contains(right),
        "truthy" => !left.trim().is_empty() && left != "0" && left != "false",
        "is_empty" => left.trim().is_empty(),
        "file_exists" => std::path::Path::new(left).exists(),
        "greater_than" => {
            let l: f64 = left.trim().parse().unwrap_or(0.0);
            let r: f64 = right.trim().parse().unwrap_or(0.0);
            l > r
        }
        "less_than" => {
            let l: f64 = left.trim().parse().unwrap_or(0.0);
            let r: f64 = right.trim().parse().unwrap_or(0.0);
            l < r
        }
        _ => left == right,
    }
}

/// Resolves a string value first from an upstream node's execution results, or falls back to the current node's config.
fn resolve_target_or_config(
    target_node_id: &str,
    node_results: &HashMap<String, Value>,
    config: &Value,
    primary_keys: &[&str],
    fallback_keys: &[&str],
) -> String {
    if !target_node_id.is_empty()
        && let Some(target_result) = node_results.get(target_node_id)
    {
        for key in primary_keys {
            if let Some(val) = target_result.get(*key).and_then(Value::as_str)
                && !val.is_empty()
            {
                return val.to_string();
            }
        }
    }

    for key in fallback_keys {
        if let Some(val) = config.get(*key).and_then(Value::as_str)
            && !val.is_empty()
        {
            return val.to_string();
        }
    }

    String::new()
}

/// Helper to extract and normalize Rclone RC command parameters.
/// Accepts either a JSON Object, a JSON String (which is parsed), or empty/None defaulting to `{}`.
pub(crate) fn parse_rc_params(params_val: Option<&Value>) -> Result<Value, String> {
    match params_val {
        Some(Value::Object(map)) => Ok(Value::Object(map.clone())),
        Some(Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                Ok(json!({}))
            } else {
                serde_json::from_str(trimmed)
                    .map_err(|e| format!("Invalid JSON in RC command params: {e}"))
            }
        }
        Some(val) if val.is_null() => Ok(json!({})),
        Some(other) => Ok(other.clone()),
        None => Ok(json!({})),
    }
}

/// Resolves the delay duration in seconds from the node configuration,
/// using the `seconds` key in integer, float, or string representations.
pub(crate) fn resolve_delay_seconds(config: &Value) -> u64 {
    let parse_u64 = |val: Option<&Value>| -> Option<u64> {
        val.and_then(Value::as_u64)
            .or_else(|| val.and_then(Value::as_f64).map(|f| f.max(0.0) as u64))
            .or_else(|| {
                val.and_then(Value::as_str)
                    .and_then(|s| s.parse::<u64>().ok())
            })
    };

    parse_u64(config.get("seconds")).unwrap_or(5)
}

/// Executes a 'delay' node by pausing execution for the resolved duration,
/// periodically checking the cancellation flag to ensure prompt responsiveness.
pub(crate) async fn execute_delay_node(
    config: &Value,
    cancel_flag: &AtomicBool,
) -> Result<NodeExecutionOutput, String> {
    let seconds = resolve_delay_seconds(config);

    if seconds > 0 {
        let sleep_step = 100;
        let total_steps = (seconds * 1000) / sleep_step;

        for _ in 0..total_steps {
            if cancel_flag.load(Ordering::SeqCst) {
                return Err("Execution cancelled during delay".to_string());
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(sleep_step)).await;
        }
    }

    Ok(NodeExecutionOutput::new(
        json!({ "waitedSeconds": seconds }),
    ))
}

/// Executes an 'app_start' trigger node.
/// Pauses execution if `delaySeconds` is configured and not in dry_run mode,
/// periodically checking the cancellation flag to ensure prompt responsiveness.
pub(crate) async fn handle_app_start_node(
    config: &Value,
    cancel_flag: &AtomicBool,
    dry_run: bool,
) -> Result<NodeExecutionOutput, String> {
    let delay = parse_delay_seconds(config);

    if delay > 0 && !dry_run {
        let sleep_step = 100;
        let total_steps = (delay * 1000) / sleep_step;
        for _ in 0..total_steps {
            if cancel_flag.load(Ordering::SeqCst) {
                return Err("Execution cancelled during app_start delay".to_string());
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(sleep_step)).await;
        }
    }

    Ok(NodeExecutionOutput::new(json!({
        "autoStarted": true,
        "waitedDelay": if dry_run { 0 } else { delay },
        "timestamp": Utc::now().to_rfc3339()
    })))
}

/// Executes a local shell command or script node ('exec_script') using the cross-platform Command wrapper.
/// Respects dry_run simulation, working directory, process cancellation, and failOnError.
pub(crate) async fn handle_exec_script_node(
    config: &Value,
    cancel_flag: &AtomicBool,
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
    dry_run: bool,
) -> Result<NodeExecutionOutput, String> {
    let command = config
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Missing 'command' in exec_script node config".to_string())?;

    let args = config
        .get("args")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");

    let fail_on_error = config
        .get("failOnError")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let working_dir = config
        .get("workingDir")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let full_cmd = if args.is_empty() {
        command.to_string()
    } else {
        format!("{command} {args}")
    };

    if dry_run {
        info!("Workflow dry_run enabled; simulating exec_script: '{full_cmd}'");
        return Ok(NodeExecutionOutput::new(json!({
            "exitCode": 0,
            "stdout": format!("[dry_run] Simulated execution of: {full_cmd}"),
            "stderr": "",
            "success": true,
            "dryRun": true,
            "simulated": true
        })));
    }

    if cancel_flag.load(Ordering::SeqCst) {
        return Err("Execution cancelled before running script".to_string());
    }

    let mut cmd = if cfg!(target_os = "windows") {
        crate::utils::process::command::Command::new("cmd").args(["/C", &full_cmd])
    } else {
        crate::utils::process::command::Command::new("sh").args(["-c", &full_cmd])
    };

    if let Some(dir) = working_dir {
        cmd = cmd.current_dir(dir);
    }

    let output = tokio::select! {
        res = cmd.output() => {
            res.map_err(|e| format!("Failed to spawn command '{command}': {e}"))?
        }
        _ = cancel_rx.changed() => {
            return Err("Execution cancelled while running script".to_string());
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let exit_code = output.status.code().unwrap_or(-1);

    if !output.status.success() && fail_on_error {
        return Err(format!("Command exited with code {exit_code}: {stderr}"));
    }

    Ok(NodeExecutionOutput::new(json!({
        "exitCode": exit_code,
        "stdout": stdout,
        "stderr": stderr,
        "success": output.status.success()
    })))
}

/// Dispatches an individual node's execution based on type and interpolated config.
#[allow(clippy::too_many_arguments)]
async fn execute_single_node(
    app: &AppHandle,
    node: &WorkflowNode,
    workflow: &WorkflowDefinition,
    cancel_flag: &AtomicBool,
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
    active_jobs: &Arc<RwLock<HashSet<u64>>>,
    node_results: &Arc<RwLock<HashMap<String, Value>>>,
    dry_run: bool,
) -> Result<NodeExecutionOutput, String> {
    if cancel_flag.load(Ordering::SeqCst) {
        return Err("Execution cancelled".to_string());
    }

    let interpolated_config = {
        let results = node_results.read();
        interpolate_node_config(&node.config, &results)
    };
    let config = &interpolated_config;

    match node.node_type.as_str() {
        // Trigger nodes and flow control structural nodes complete immediately
        "manual" | "parallel_fork" => Ok(NodeExecutionOutput::new(json!({
            "passed": true,
            "timestamp": Utc::now().to_rfc3339()
        }))),

        // Cron Schedule Trigger
        "cron" => {
            let cron_expr = config
                .get("cronExpression")
                .and_then(Value::as_str)
                .unwrap_or_default();

            Ok(NodeExecutionOutput::new(json!({
                "passed": true,
                "cronExpression": cron_expr,
                "timestamp": Utc::now().to_rfc3339()
            })))
        }

        // Folder Watcher Trigger
        "watcher" => {
            let watch_paths = config
                .get("watchPaths")
                .cloned()
                .unwrap_or_else(|| json!([]));
            let glob_pattern = config
                .get("globPattern")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let debounce_seconds = config
                .get("debounceSeconds")
                .and_then(Value::as_u64)
                .unwrap_or(5);

            Ok(NodeExecutionOutput::new(json!({
                "passed": true,
                "watchPaths": watch_paths,
                "globPattern": glob_pattern,
                "debounceSeconds": debounce_seconds,
                "timestamp": Utc::now().to_rfc3339()
            })))
        }

        // Job Finish Event Trigger
        "job_event" => {
            let target = config
                .get("targetProfileId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let event_state = config
                .get("eventState")
                .and_then(Value::as_str)
                .unwrap_or("any");

            Ok(NodeExecutionOutput::new(json!({
                "passed": true,
                "targetProfileId": target,
                "eventState": event_state,
                "timestamp": Utc::now().to_rfc3339()
            })))
        }

        // Join Branches node: synchronizes parallel branches based on joinMode policy
        "join" => {
            let results = node_results.read();
            handle_join_node(node, workflow, config, &results)
        }

        // Auto Start Trigger (runs on app boot / manual execution)
        "app_start" => handle_app_start_node(config, cancel_flag, dry_run).await,

        // Delay timer
        "delay" => execute_delay_node(config, cancel_flag).await,

        // Notification Node (Multi-Channel: Action Reference or Inline Configuration)
        "notification" => execute_notification_node(app, node, workflow, config).await,

        // Condition evaluation (clean branching without false error generation)
        "condition" => {
            let operator = config
                .get("operator")
                .and_then(Value::as_str)
                .unwrap_or("equals");
            let left = config
                .get("leftValue")
                .and_then(Value::as_str)
                .unwrap_or("");
            let right = config
                .get("rightValue")
                .and_then(Value::as_str)
                .unwrap_or("");

            let is_true = evaluate_condition(operator, left, right);

            let branch = if is_true { "true" } else { "false" };
            Ok(NodeExecutionOutput::branch(
                json!({
                    "conditionMet": is_true,
                    "branch": branch,
                    "operator": operator,
                    "left": left,
                    "right": right
                }),
                branch,
            ))
        }

        // Quick Run preset integration
        "quick_run" => {
            let qr_id = config
                .get("quickRunId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    "Missing or empty 'quickRunId' in quick_run node config".to_string()
                })?;

            if dry_run {
                let manager = app.state::<AppSettingsManager>();
                let qr = crate::core::flow::quick_run::commands::get_quick_run(&manager, qr_id)?
                    .ok_or_else(|| format!("Quick run '{qr_id}' not found"))?;

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

            let res = crate::core::flow::quick_run::commands::start_quick_run(
                app.clone(),
                qr_id.to_string(),
            )
            .await?;

            if let Some(job_id) = res.job_id {
                await_rclone_job(
                    app,
                    job_id,
                    cancel_flag,
                    cancel_rx.clone(),
                    active_jobs,
                    &workflow.id,
                )
                .await
            } else {
                Ok(NodeExecutionOutput::new(
                    serde_json::to_value(res).unwrap_or(json!({"started": true})),
                ))
            }
        }

        // Rclone cleanup (empty trash on remote)
        "cleanup" => {
            let op = extract_node_op_config(config);
            let path = op
                .config
                .get("path")
                .or_else(|| op.config.get("srcFs"))
                .and_then(Value::as_str)
                .unwrap_or_default();

            let fs = if op.remote.is_empty() {
                path.to_string()
            } else if path.is_empty() {
                format!("{}:", op.remote)
            } else {
                format!("{}:{path}", op.remote)
            };

            if dry_run {
                info!("Dry-run simulation: skipping operations/cleanup on '{fs}'");
                return Ok(NodeExecutionOutput::new(json!({
                    "cleaned": false,
                    "dryRun": true,
                    "fs": fs,
                    "message": format!("Dry run simulation: cleanup skipped on '{fs}'")
                })));
            }

            let state = app.state::<RcloneState>();
            let params = json!({ "fs": fs });
            let rpc_fut = state.transport.rpc("operations/cleanup", Some(&params));
            let out = tokio::select! {
                res = rpc_fut => res.map_err(|e| format!("Cleanup failed on '{fs}': {e}"))?,
                _ = cancel_rx.changed() => return Err(format!("Workflow cancelled during cleanup on '{fs}'")),
            };

            Ok(NodeExecutionOutput::new(json!({
                "cleaned": true,
                "fs": fs,
                "result": out
            })))
        }

        // Local script / shell command execution (Non-blocking async with process cleanup)
        "exec_script" => handle_exec_script_node(config, cancel_flag, cancel_rx, dry_run).await,

        // Early termination node
        "stop" => handle_stop_node(config, cancel_flag),

        // System power management (sleep, shutdown, lock)
        "system_power" => {
            let action = config
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("sleep");

            info!("System power action requested: {action} (dry_run: {dry_run})");

            if dry_run {
                info!("Dry-run simulation: skipping actual system power action '{action}'");
                return Ok(NodeExecutionOutput::new(json!({
                    "powerAction": action,
                    "executed": false,
                    "dryRun": true,
                    "message": format!("Dry run simulation: power action '{action}' skipped")
                })));
            }

            crate::core::power::execute_system_power(action)
                .await
                .map_err(|e| format!("Failed to execute system power action '{action}': {e}"))?;

            Ok(NodeExecutionOutput::new(json!({
                "powerAction": action,
                "executed": true
            })))
        }

        // Custom Audit Log node
        "log_audit" => {
            let message = config
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Audit log entry");

            let severity = config
                .get("severity")
                .and_then(Value::as_str)
                .unwrap_or("info");

            match severity {
                "error" => log::error!("[Workflow Audit] [{}] {message}", workflow.name),
                "warn" | "warning" => log::warn!("[Workflow Audit] [{}] {message}", workflow.name),
                _ => log::info!("[Workflow Audit] [{}] {message}", workflow.name),
            }

            Ok(NodeExecutionOutput::new(json!({
                "logged": true,
                "message": message,
                "severity": severity,
                "timestamp": Utc::now().to_rfc3339()
            })))
        }

        // Remote mount operation
        "mount" => {
            let op = extract_node_op_config(config);
            let mut mount_params =
                MountParams::from_config(op.remote.to_string(), op.config, &op.empty_settings)
                    .ok_or_else(|| "Incomplete mount configuration".to_string())?;

            mount_params.origin = Some(Origin::Flow);
            mount_params.workflow_id = Some(workflow.id.clone());
            mount_params.node_id = Some(node.id.clone());
            mount_params.execute_id = Some(workflow.id.clone());

            let backend_manager = app.state::<BackendManager>();
            let is_already_mounted = {
                let mounted = backend_manager.remote_cache.mounted.read().await;
                mounted.iter().any(|m| {
                    (m.workflow_id.as_deref() == Some(&workflow.id)
                        && m.node_id.as_deref() == Some(&node.id))
                        || (!mount_params.mount_point.is_empty()
                            && m.mount_point == mount_params.mount_point)
                })
            };

            if is_already_mounted {
                info!(
                    "Remote '{}' or mount point '{}' is already mounted for node '{}'. Continuing workflow.",
                    op.remote, mount_params.mount_point, node.id
                );
                Ok(NodeExecutionOutput::new(json!({
                    "mounted": true,
                    "alreadyMounted": true,
                    "mountPoint": mount_params.mount_point,
                    "remote": op.remote,
                    "nodeId": node.id,
                    "workflowId": workflow.id
                })))
            } else {
                mount_remote(app.clone(), mount_params.clone()).await?;
                Ok(NodeExecutionOutput::new(json!({
                    "mounted": true,
                    "mountPoint": mount_params.mount_point,
                    "remote": op.remote,
                    "nodeId": node.id,
                    "workflowId": workflow.id
                })))
            }
        }

        // Remote unmount operation
        "unmount" => {
            let target_node_id = config
                .get("targetNodeId")
                .and_then(Value::as_str)
                .unwrap_or_default();

            let (mount_point, remote_name) = {
                let results = node_results.read();
                let mp = resolve_target_or_config(
                    target_node_id,
                    &results,
                    config,
                    &["mountPoint"],
                    &["mountPoint"],
                );
                let rem = resolve_target_or_config(
                    target_node_id,
                    &results,
                    config,
                    &["remote", "remoteName"],
                    &["remoteName", "remote"],
                );
                (mp, rem)
            };

            if mount_point.is_empty() {
                return Err("Missing 'mountPoint' in unmount node config and target node produced no mount point".to_string());
            }

            crate::rclone::commands::mount::unmount_remote(
                app.clone(),
                mount_point.to_string(),
                remote_name.to_string(),
            )
            .await?;

            Ok(NodeExecutionOutput::new(json!({
                "unmounted": true,
                "mountPoint": mount_point,
                "targetNodeId": target_node_id
            })))
        }

        // Remote serve operation
        "serve" => {
            let op = extract_node_op_config(config);
            let mut serve_params =
                ServeParams::from_config(op.remote.to_string(), op.config, &op.empty_settings)
                    .ok_or_else(|| "Incomplete serve configuration".to_string())?;

            serve_params.origin = Some(Origin::Flow);
            serve_params.workflow_id = Some(workflow.id.clone());
            serve_params.node_id = Some(node.id.clone());
            serve_params.execute_id = Some(workflow.id.clone());

            let backend_manager = app.state::<BackendManager>();
            let existing_serve = {
                let serves = backend_manager.remote_cache.serves.read().await;
                serves
                    .iter()
                    .find(|s| {
                        s.workflow_id.as_deref() == Some(&workflow.id)
                            && s.node_id.as_deref() == Some(&node.id)
                    })
                    .cloned()
            };

            if let Some(s) = existing_serve {
                let addr = s
                    .params
                    .get("addr")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&s.addr)
                    .to_string();
                info!(
                    "Remote '{}' is already being served for node '{}' (id: {}). Continuing workflow.",
                    op.remote, node.id, s.id
                );
                Ok(NodeExecutionOutput::new(json!({
                    "served": true,
                    "alreadyServing": true,
                    "id": s.id,
                    "addr": addr,
                    "remote": op.remote,
                    "nodeId": node.id,
                    "workflowId": workflow.id
                })))
            } else {
                let serve_res = start_serve(app.clone(), serve_params).await?;
                Ok(NodeExecutionOutput::new(json!({
                    "served": true,
                    "id": serve_res.id,
                    "addr": serve_res.addr,
                    "remote": op.remote,
                    "nodeId": node.id,
                    "workflowId": workflow.id
                })))
            }
        }

        // Remote serve stop operation
        "stop_serve" => {
            let target_node_id = config
                .get("targetNodeId")
                .and_then(Value::as_str)
                .unwrap_or_default();

            let (server_id, remote_name) = {
                let results = node_results.read();
                let sid = resolve_target_or_config(
                    target_node_id,
                    &results,
                    config,
                    &["id", "serverId"],
                    &["serverId", "id"],
                );
                let rem = resolve_target_or_config(
                    target_node_id,
                    &results,
                    config,
                    &["remote", "remoteName"],
                    &["remoteName", "remote"],
                );
                (sid, rem)
            };

            if !server_id.is_empty() {
                crate::rclone::commands::serve::stop_serve(
                    app.clone(),
                    server_id.to_string(),
                    remote_name.to_string(),
                )
                .await?;
                Ok(NodeExecutionOutput::new(json!({
                    "stopped": true,
                    "serverId": server_id,
                    "targetNodeId": target_node_id
                })))
            } else if !remote_name.is_empty() {
                let backend_manager = app.state::<BackendManager>();
                let serves = backend_manager.remote_cache.serves.read().await.clone();
                let matching_serves: Vec<_> = serves
                    .into_iter()
                    .filter(|s| {
                        let fs = s
                            .params
                            .get("fs")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        fs.starts_with(&format!("{remote_name}:")) || fs == remote_name
                    })
                    .collect();

                if matching_serves.is_empty() {
                    info!("No active serves found for remote '{remote_name}' to stop");
                    Ok(NodeExecutionOutput::new(json!({
                        "stopped": true,
                        "remoteName": remote_name,
                        "count": 0
                    })))
                } else {
                    let mut stopped_count = 0;
                    for serve in matching_serves {
                        if let Err(e) = crate::rclone::commands::serve::stop_serve(
                            app.clone(),
                            serve.id.clone(),
                            remote_name.to_string(),
                        )
                        .await
                        {
                            warn!("Failed stopping serve {} during workflow: {e}", serve.id);
                        } else {
                            stopped_count += 1;
                        }
                    }
                    Ok(NodeExecutionOutput::new(json!({
                        "stopped": true,
                        "remoteName": remote_name,
                        "count": stopped_count
                    })))
                }
            } else {
                Err("Missing both 'targetNodeId'/'serverId' and 'remoteName' in stop_serve node config".to_string())
            }
        }

        // Direct Rclone RC command
        "rc_command" => {
            let command = config
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or("core/version");

            let params = parse_rc_params(config.get("params"))?;

            let state = app.state::<RcloneState>();
            let rpc_fut = state.transport.rpc(command, Some(&params));
            let out = tokio::select! {
                res = rpc_fut => res.map_err(|e| format!("RC command '{command}' failed: {e}"))?,
                _ = cancel_rx.changed() => return Err(format!("Workflow cancelled during RC command '{command}'")),
            };

            Ok(NodeExecutionOutput::new(out))
        }

        // Archive create transfer
        "archivecreate" => {
            let op = extract_node_op_config(config);
            let common = parse_common_config(op.config, &op.empty_settings).ok_or_else(|| {
                format!("Incomplete archive create config for node '{}'", node.title)
            })?;

            let source = common
                .source
                .first()
                .cloned()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| {
                    format!(
                        "No source specified for archive create node '{}'",
                        node.title
                    )
                })?;

            let dest_base =
                if !op.remote.is_empty() && !common.dest.is_empty() && !common.dest.contains(':') {
                    format!("{}:{}", op.remote, common.dest)
                } else {
                    common.dest.clone()
                };

            if dest_base.trim().is_empty() {
                return Err(format!(
                    "No destination specified for archive create node '{}'",
                    node.title
                ));
            }

            let format = if let Value::Object(map) = &common.rclone_config {
                map.get("format").and_then(|v| v.as_str()).unwrap_or("zip")
            } else {
                "zip"
            };

            let final_dest = build_archive_final_dest(&source, &dest_base, format);

            let backend_manager = app.state::<BackendManager>();
            let backend = backend_manager.get_active().await;

            let (endpoint, payload) = if backend.is_librclone_local() {
                let mut p = json!({
                    "action": "create",
                    "src": source,
                    "dst": final_dest,
                    "_async": true,
                });
                p["format"] = json!(format);
                if let Value::Object(map) = &common.rclone_config {
                    if let Some(pr) = map
                        .get("prefix")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                    {
                        p["prefix"] = json!(pr);
                    }
                    if let Some(fp) = map
                        .get("fullPath")
                        .or_else(|| map.get("full_path"))
                        .and_then(|v| v.as_bool())
                    {
                        p["full_path"] = json!(fp);
                    }
                    if let Some(inc) = map.get("include") {
                        p["include"] = inc.clone();
                    }
                }
                (crate::utils::rclone::endpoints::operations::ARCHIVE, p)
            } else {
                let mut args = vec!["create".to_string(), source.clone(), final_dest.clone()];
                args.push(format!("--format={format}"));
                if let Value::Object(map) = &common.rclone_config {
                    if let Some(pr) = map
                        .get("prefix")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                    {
                        args.push(format!("--prefix={pr}"));
                    }
                    if map
                        .get("fullPath")
                        .or_else(|| map.get("full_path"))
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                    {
                        args.push("--full-path".to_string());
                    }
                    if let Some(Value::Array(arr)) = map.get("include") {
                        for item in arr {
                            if let Some(s) = item.as_str() {
                                args.push(format!("--include={s}"));
                            }
                        }
                    }
                }
                if dry_run {
                    args.push("--dry-run".to_string());
                }
                let os = backend_manager.get_runtime_os(&backend.name).await;
                (
                    crate::utils::rclone::endpoints::core::COMMAND,
                    backend.build_core_command_payload("archive", args, true, os),
                )
            };

            let metadata = JobMetadata::new(
                op.remote.to_string(),
                JobType::ArchiveCreate,
                vec![source.clone()],
                final_dest.clone(),
            )
            .with_origin(Some(Origin::Flow))
            .with_workflow_id(Some(workflow.id.clone()))
            .with_node_id(Some(node.id.clone()))
            .with_dry_run(dry_run)
            .with_execute_id(Some(uuid::Uuid::new_v4().to_string()));

            let (job_id, _, _) = submit_job_with_options(
                app.clone(),
                endpoint,
                payload,
                metadata,
                SubmitJobOptions {
                    wait_for_completion: false,
                },
            )
            .await?;

            await_rclone_job(
                app,
                job_id,
                cancel_flag,
                cancel_rx.clone(),
                active_jobs,
                &workflow.id,
            )
            .await
        }

        // Sync, Copy, Move, Bisync, Check, Delete, Copyurl, Cryptcheck transfers
        "sync" | "copy" | "move" | "bisync" | "check" | "delete" | "copyurl" | "cryptcheck" => {
            let op_type = match node.node_type.as_str() {
                "copy" => OperationType::Copy,
                "move" => OperationType::Move,
                "bisync" => OperationType::Bisync,
                "check" => OperationType::Check,
                "delete" => OperationType::Delete,
                "copyurl" => OperationType::Copyurl,
                "cryptcheck" => OperationType::Cryptcheck,
                _ => OperationType::Sync,
            };

            let op = extract_node_op_config(config);
            let common = parse_common_config(op.config, &op.empty_settings)
                .ok_or_else(|| format!("Incomplete transfer config for node '{}'", node.title))?;

            let mut backend_opts = common.backend_options.unwrap_or_default();
            if dry_run {
                backend_opts.insert("DryRun".to_string(), json!(true));
            }

            let dest_resolved = if !op.remote.is_empty() && !common.dest.contains(':') {
                if common.dest.is_empty() {
                    format!("{}:", op.remote)
                } else {
                    format!("{}:{}", op.remote, common.dest)
                }
            } else {
                common.dest.clone()
            };

            let mut inputs = Vec::new();
            for source in &common.source {
                let is_dir = if op_type == OperationType::Copyurl {
                    false
                } else {
                    is_directory(app, source, common.runtime_remote_options.as_ref())
                        .await
                        .unwrap_or(true)
                };

                let body = GenericTransferParams {
                    source: source.clone(),
                    dest: dest_resolved.clone(),
                    rclone_config: common.rclone_config.clone(),
                    filter_options: common.filter_options.clone(),
                    backend_options: Some(backend_opts.clone()),
                    runtime_remote_options: common.runtime_remote_options.clone(),
                    transfer_type: op_type,
                    is_dir,
                }
                .to_rclone_body()
                .map_err(|e| format!("Transfer body error: {e}"))?;

                inputs.push(body);
            }

            let metadata = JobMetadata::new(
                op.remote.to_string(),
                op_type.as_job_type().unwrap_or(JobType::Sync),
                common.source.clone(),
                dest_resolved,
            )
            .with_origin(Some(Origin::Flow))
            .with_workflow_id(Some(workflow.id.clone()))
            .with_node_id(Some(node.id.clone()))
            .with_dry_run(dry_run);

            let job_id_str = submit_batch_job(app.clone(), inputs, metadata).await?;
            let job_id = job_id_str
                .parse::<u64>()
                .map_err(|e| format!("Invalid job ID returned by batch submission: {e}"))?;

            await_rclone_job(
                app,
                job_id,
                cancel_flag,
                cancel_rx.clone(),
                active_jobs,
                &workflow.id,
            )
            .await
        }

        unknown => {
            warn!("Unknown workflow node type: {unknown}");
            Ok(NodeExecutionOutput::new(json!({
                "executed": true,
                "unknownType": unknown
            })))
        }
    }
}

/// Executes a multi-channel notification workflow node and registers the outcome in AlertHistory.
async fn execute_notification_node(
    app: &AppHandle,
    node: &WorkflowNode,
    workflow: &WorkflowDefinition,
    config: &Value,
) -> Result<NodeExecutionOutput, String> {
    let action_id = config
        .get("actionId")
        .or_else(|| config.get("action_id"))
        .and_then(Value::as_str)
        .unwrap_or("");

    let title_override = config
        .get("title")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&node.title);

    let message_override = config
        .get("message")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("Workflow notification triggered");

    let severity_str = config
        .get("severity")
        .and_then(Value::as_str)
        .unwrap_or("info");

    let severity = match severity_str.to_lowercase().as_str() {
        "critical" | "error" => crate::core::alerts::types::AlertSeverity::Critical,
        "high" => crate::core::alerts::types::AlertSeverity::High,
        "average" => crate::core::alerts::types::AlertSeverity::Average,
        "warning" | "warn" => crate::core::alerts::types::AlertSeverity::Warning,
        _ => crate::core::alerts::types::AlertSeverity::Info,
    };

    let ctx = crate::core::alerts::template::TemplateContext {
        title: title_override.to_string(),
        body: message_override.to_string(),
        severity: severity.as_str().to_string(),
        severity_code: severity.as_code(),
        event_kind: "workflow".to_string(),
        remote: config
            .get("remote")
            .or_else(|| config.get("remoteName"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        profile: workflow.name.clone(),
        backend: "Workflow".to_string(),
        operation: format!("Workflow Step: {}", node.title),
        origin: Origin::Flow,
        timestamp: Utc::now().to_rfc3339(),
        rule_id: format!("workflow-{}", workflow.id),
        rule_name: workflow.name.clone(),
        source: Some(format!("Node: {}", node.title)),
        destination: None,
    };

    let start_time = Instant::now();

    let alert_cache = app.try_state::<crate::core::alerts::cache::AlertRuleCache>();
    let dispatch_ctx = app.try_state::<crate::core::alerts::dispatch::DispatchContext>();

    let mut target_action: Option<crate::core::alerts::types::AlertAction> = None;

    if let Some(cache) = alert_cache.as_ref().filter(|_| !action_id.is_empty()) {
        let all_actions = cache.get_actions().await;
        target_action = all_actions.into_iter().find(|a| a.common().id == action_id);
    }

    if target_action.is_none()
        && (config.get("kind").is_some() || config.get("actionKind").is_some())
    {
        let mut clean_cfg = config.clone();
        if let Some(obj) = clean_cfg.as_object_mut() {
            if let Some(k) = obj.get("actionKind").cloned() {
                obj.insert("kind".to_string(), k);
            }
            if !obj.contains_key("id") {
                obj.insert("id".to_string(), Value::String(node.id.clone()));
            }
            if !obj.contains_key("name") {
                obj.insert("name".to_string(), Value::String(node.title.clone()));
            }
            if !obj.contains_key("enabled") {
                obj.insert("enabled".to_string(), Value::Bool(true));
            }
        }
        target_action =
            serde_json::from_value::<crate::core::alerts::types::AlertAction>(clean_cfg).ok();
    }

    let (res, action_kind_name, action_name, act_id) =
        if let (Some(action), Some(ref d_ctx)) = (target_action, dispatch_ctx) {
            let k_name = action.kind_str().to_string();
            let a_name = action.common().name.clone();
            let a_id = action.common().id.clone();
            let client = if let crate::core::alerts::types::AlertAction::Webhook(ref w) = action {
                if w.tls_verify {
                    &d_ctx.client
                } else {
                    &d_ctx.insecure_client
                }
            } else {
                &d_ctx.client
            };
            let r = crate::core::alerts::engine::execute_action(app, &action, &ctx, client, d_ctx)
                .await;
            (r, k_name, a_name, a_id)
        } else {
            #[cfg(feature = "tauri-plugin-notification")]
            let r = crate::core::alerts::dispatch::os_toast::dispatch(app, &ctx);
            #[cfg(not(feature = "tauri-plugin-notification"))]
            let r = {
                info!(
                    "Workflow notification (headless): [{}] {}",
                    ctx.title, ctx.body
                );
                Ok(())
            };
            (
                r,
                "os_toast".to_string(),
                "Desktop Notification".to_string(),
                "inline_os_toast".to_string(),
            )
        };

    let duration_ms = start_time.elapsed().as_millis() as u64;

    if let Some(history_cache) = app.try_state::<crate::core::alerts::cache::AlertHistoryCache>() {
        let action_res = crate::core::alerts::types::ActionResult {
            action_id: act_id,
            action_name,
            action_kind: action_kind_name.clone(),
            success: res.is_ok(),
            error: res.as_ref().err().cloned(),
            duration_ms,
        };

        let record = crate::core::alerts::types::AlertRecord {
            id: uuid::Uuid::new_v4().to_string(),
            rule_id: format!("workflow-{}", workflow.id),
            rule_name: workflow.name.clone(),
            event_kind: crate::core::alerts::types::AlertEventKind::Workflow,
            severity,
            title: title_override.to_string(),
            body: message_override.to_string(),
            remote: None,
            profile: Some(workflow.name.clone()),
            backend: Some("Workflow".to_string()),
            operation: Some(format!("Workflow Step: {}", node.title)),
            origin: Some(Origin::Flow),
            source: Some(format!("Node: {}", node.title)),
            destination: None,
            timestamp: Utc::now(),
            action_results: vec![action_res],
            acknowledged: false,
            ack_at: None,
        };

        history_cache.push(record, Some(app)).await;
    }

    match res {
        Ok(_) => Ok(NodeExecutionOutput::new(json!({
            "notified": true,
            "channel": action_kind_name,
            "durationMs": duration_ms,
        }))),
        Err(e) => Err(format!("Notification error ({action_kind_name}): {e}")),
    }
}

/// Executes a workflow by ID from storage using dynamic, dependency-driven DAG scheduling.
pub async fn execute_workflow(
    app: AppHandle,
    workflow_id: String,
    dry_run: bool,
) -> Result<WorkflowExecutionResult, String> {
    let manager = app.state::<AppSettingsManager>();
    let sub = manager
        .sub_settings(SUB_WORKFLOWS)
        .map_err(|e| e.to_string())?;

    let mut workflow: WorkflowDefinition = sub
        .get(&workflow_id)
        .map_err(|e| format!("Workflow '{workflow_id}' not found: {e}"))?;

    info!(
        "Starting execution of workflow: {} ({workflow_id}, dry_run: {dry_run})",
        workflow.name
    );

    let val_res = validate_workflow(&workflow);
    if !val_res.valid {
        let err_msg = val_res.errors.join("; ");
        let _ = app.emit(
            WORKFLOW_EXECUTION_STATE_CHANGED,
            WorkflowExecutionStateEvent {
                workflow_id: workflow_id.clone(),
                state: "failed".to_string(),
                progress: None,
                message: Some(err_msg.clone()),
            },
        );
        return Err(format!("Validation failed: {err_msg}"));
    }

    let cancel_flag = Arc::new(AtomicBool::new(false));
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    let active_job_ids = Arc::new(RwLock::new(HashSet::new()));
    {
        ACTIVE_WORKFLOW_EXECUTIONS.write().insert(
            workflow_id.clone(),
            ActiveWorkflowState {
                cancel_flag: cancel_flag.clone(),
                cancel_tx,
                active_job_ids: active_job_ids.clone(),
            },
        );
    }

    let start_instant = Instant::now();
    let total_nodes = workflow.nodes.len();
    let mut completed_nodes = 0;
    let mut failed_nodes = 0;
    let mut skipped_nodes = 0;

    let _ = app.emit(
        WORKFLOW_EXECUTION_STATE_CHANGED,
        WorkflowExecutionStateEvent {
            workflow_id: workflow_id.clone(),
            state: "started".to_string(),
            progress: Some(WorkflowProgress {
                total: total_nodes,
                completed: 0,
                current_step_title: "Initializing".to_string(),
            }),
            message: Some(format!("Workflow '{}' started", workflow.name)),
        },
    );

    notify(
        &app,
        NotificationEvent::Workflow(WorkflowStage::Started {
            workflow_id: workflow_id.clone(),
            workflow_name: workflow.name.clone(),
            origin: Origin::Flow,
        }),
    );

    // Pre-index nodes
    let node_map: Arc<HashMap<String, WorkflowNode>> = Arc::new(
        workflow
            .nodes
            .iter()
            .map(|n| (n.id.clone(), n.clone()))
            .collect(),
    );

    // Pre-index incoming and outgoing edges
    let mut incoming_edges: HashMap<String, Vec<WorkflowEdge>> = HashMap::new();
    let mut outgoing_edges: HashMap<String, Vec<WorkflowEdge>> = HashMap::new();

    for edge in &workflow.edges {
        incoming_edges
            .entry(edge.target_node_id.clone())
            .or_default()
            .push(edge.clone());
        outgoing_edges
            .entry(edge.source_node_id.clone())
            .or_default()
            .push(edge.clone());
    }

    let mut node_statuses: HashMap<String, NodeStatus> = workflow
        .nodes
        .iter()
        .map(|n| (n.id.clone(), NodeStatus::Pending))
        .collect();

    let mut edge_states: HashMap<String, EdgeState> = workflow
        .edges
        .iter()
        .map(|e| (e.id.clone(), EdgeState::Pending))
        .collect();

    let node_results = Arc::new(RwLock::new(HashMap::new()));
    let (tx, mut rx) = tokio::sync::mpsc::channel::<NodeFinishedEvent>(total_nodes.max(1));

    let mut ready_queue: VecDeque<String> = VecDeque::new();
    let mut active_running_count = 0;

    // Trigger or root nodes (no incoming edges) are initially runnable
    for node in &workflow.nodes {
        let has_incoming = incoming_edges
            .get(&node.id)
            .map(|e| !e.is_empty())
            .unwrap_or(false);
        if node.category == WorkflowNodeCategory::Trigger || !has_incoming {
            ready_queue.push_back(node.id.clone());
        }
    }

    loop {
        // 1. Spawn all currently ready nodes (if not cancelled)
        let is_cancelled = cancel_flag.load(Ordering::SeqCst);
        if !is_cancelled {
            while let Some(node_id) = ready_queue.pop_front() {
                if let Some(node) = node_map.get(&node_id) {
                    node_statuses.insert(node_id.clone(), NodeStatus::Running);

                    let _ = app.emit(
                        WORKFLOW_NODE_STATE_CHANGED,
                        WorkflowNodeStateEvent {
                            workflow_id: workflow_id.clone(),
                            node_id: node_id.clone(),
                            state: WorkflowNodeExecutionState::Running,
                            error_message: None,
                            duration_ms: None,
                        },
                    );

                    active_running_count += 1;

                    let app_clone = app.clone();
                    let node_clone = node.clone();
                    let wf_clone = workflow.clone();
                    let cancel_clone = cancel_flag.clone();
                    let cancel_rx_clone = cancel_rx.clone();
                    let active_jobs_clone = active_job_ids.clone();
                    let results_clone = node_results.clone();
                    let tx_clone = tx.clone();

                    tokio::spawn(async move {
                        let node_start = Instant::now();
                        let outcome = execute_single_node(
                            &app_clone,
                            &node_clone,
                            &wf_clone,
                            &cancel_clone,
                            cancel_rx_clone,
                            &active_jobs_clone,
                            &results_clone,
                            dry_run,
                        )
                        .await;
                        let duration_ms = node_start.elapsed().as_millis() as u64;

                        let _ = tx_clone
                            .send(NodeFinishedEvent {
                                node_id: node_clone.id,
                                outcome,
                                duration_ms,
                            })
                            .await;
                    });
                }
            }
        } else {
            ready_queue.clear();
        }

        // If no tasks are running and nothing is queued, we are done
        if active_running_count == 0 {
            break;
        }

        // Emit current running progress
        let running_titles = node_statuses
            .iter()
            .filter(|(_, s)| matches!(s, NodeStatus::Running))
            .filter_map(|(id, _)| node_map.get(id).map(|n| n.title.as_str()))
            .collect::<Vec<_>>()
            .join(", ");

        let _ = app.emit(
            WORKFLOW_EXECUTION_STATE_CHANGED,
            WorkflowExecutionStateEvent {
                workflow_id: workflow_id.clone(),
                state: "running".to_string(),
                progress: Some(WorkflowProgress {
                    total: total_nodes,
                    completed: completed_nodes,
                    current_step_title: if running_titles.is_empty() {
                        "Processing".to_string()
                    } else {
                        running_titles
                    },
                }),
                message: None,
            },
        );

        // Await next node completion
        let Some(finished) = rx.recv().await else {
            break;
        };
        active_running_count -= 1;

        let node_id = finished.node_id;

        if let Some(node) = node_map.get(&node_id) {
            activate_outgoing_edges(node, &finished.outcome, &workflow.edges, &mut edge_states);
        }

        match finished.outcome {
            Ok(ref output) => {
                completed_nodes += 1;
                node_statuses.insert(node_id.clone(), NodeStatus::Completed(output.clone()));
                node_results
                    .write()
                    .insert(node_id.clone(), output.value.clone());

                if output.value.get("stopped").and_then(Value::as_bool) == Some(true) {
                    info!(
                        "Workflow received graceful stop from node '{node_id}'. Halting remaining DAG execution."
                    );
                    cancel_flag.store(true, Ordering::SeqCst);
                }

                let _ = app.emit(
                    WORKFLOW_NODE_STATE_CHANGED,
                    WorkflowNodeStateEvent {
                        workflow_id: workflow_id.clone(),
                        node_id: node_id.clone(),
                        state: WorkflowNodeExecutionState::Success,
                        error_message: None,
                        duration_ms: Some(finished.duration_ms),
                    },
                );
            }
            Err(ref err) => {
                failed_nodes += 1;
                node_statuses.insert(node_id.clone(), NodeStatus::Failed(err.clone()));

                let _ = app.emit(
                    WORKFLOW_NODE_STATE_CHANGED,
                    WorkflowNodeStateEvent {
                        workflow_id: workflow_id.clone(),
                        node_id: node_id.clone(),
                        state: WorkflowNodeExecutionState::Failed,
                        error_message: Some(err.clone()),
                        duration_ms: Some(finished.duration_ms),
                    },
                );
            }
        }

        // If not cancelled, evaluate downstream nodes
        if !cancel_flag.load(Ordering::SeqCst) {
            let mut eval_queue = VecDeque::new();
            if let Some(out_edges) = outgoing_edges.get(&node_id) {
                for e in out_edges {
                    eval_queue.push_back(e.target_node_id.clone());
                }
            }

            while let Some(candidate_id) = eval_queue.pop_front() {
                if node_statuses.get(&candidate_id) != Some(&NodeStatus::Pending) {
                    continue;
                }

                let in_edges = incoming_edges
                    .get(&candidate_id)
                    .cloned()
                    .unwrap_or_default();
                let all_resolved = in_edges
                    .iter()
                    .all(|e| edge_states.get(&e.id) != Some(&EdgeState::Pending));

                if all_resolved {
                    let has_active = in_edges
                        .iter()
                        .any(|e| edge_states.get(&e.id) == Some(&EdgeState::Activated));

                    let is_join = node_map
                        .get(&candidate_id)
                        .map(|n| n.node_type.as_str() == "join")
                        .unwrap_or(false);

                    let should_run = if is_join {
                        let join_mode = node_map
                            .get(&candidate_id)
                            .and_then(|n| n.config.get("joinMode"))
                            .and_then(Value::as_str)
                            .unwrap_or("all_success");
                        if join_mode == "always" {
                            true
                        } else {
                            has_active
                        }
                    } else {
                        has_active
                    };

                    if should_run {
                        if !ready_queue.contains(&candidate_id) {
                            ready_queue.push_back(candidate_id);
                        }
                    } else {
                        // All incoming edges are disabled -> skip candidate node
                        skipped_nodes += 1;
                        node_statuses.insert(candidate_id.clone(), NodeStatus::Skipped);

                        let _ = app.emit(
                            WORKFLOW_NODE_STATE_CHANGED,
                            WorkflowNodeStateEvent {
                                workflow_id: workflow_id.clone(),
                                node_id: candidate_id.clone(),
                                state: WorkflowNodeExecutionState::Skipped,
                                error_message: None,
                                duration_ms: Some(0),
                            },
                        );

                        // Disable all outgoing edges of candidate
                        if let Some(out_edges) = outgoing_edges.get(&candidate_id) {
                            for out_edge in out_edges {
                                edge_states.insert(out_edge.id.clone(), EdgeState::Disabled);
                                eval_queue.push_back(out_edge.target_node_id.clone());
                            }
                        }
                    }
                }
            }
        }
    }

    // Any remaining Pending nodes marked Skipped
    for (id, status) in node_statuses.iter_mut() {
        if *status == NodeStatus::Pending {
            *status = NodeStatus::Skipped;
            skipped_nodes += 1;
            let _ = app.emit(
                WORKFLOW_NODE_STATE_CHANGED,
                WorkflowNodeStateEvent {
                    workflow_id: workflow_id.clone(),
                    node_id: id.clone(),
                    state: WorkflowNodeExecutionState::Skipped,
                    error_message: None,
                    duration_ms: Some(0),
                },
            );
        }
    }

    // Cleanup active execution tracker
    {
        ACTIVE_WORKFLOW_EXECUTIONS.write().remove(&workflow_id);
    }

    let is_cancelled = cancel_flag.load(Ordering::SeqCst);
    let total_duration_ms = start_instant.elapsed().as_millis() as u64;

    let has_graceful_stop = node_statuses.values().any(|s| {
        matches!(s, NodeStatus::Completed(out) if out.value.get("stopped").and_then(Value::as_bool) == Some(true))
    });

    let overall_success = (!is_cancelled || has_graceful_stop) && failed_nodes == 0;

    workflow.last_executed_at = Some(Utc::now().to_rfc3339());
    let _ = sub.set(&workflow.id, &workflow);

    let final_state = if is_cancelled && !has_graceful_stop {
        "cancelled"
    } else if overall_success {
        "completed"
    } else {
        "failed"
    };

    let _ = app.emit(
        WORKFLOW_EXECUTION_STATE_CHANGED,
        WorkflowExecutionStateEvent {
            workflow_id: workflow_id.clone(),
            state: final_state.to_string(),
            progress: Some(WorkflowProgress {
                total: total_nodes,
                completed: completed_nodes,
                current_step_title: "Finished".to_string(),
            }),
            message: Some(if is_cancelled && !has_graceful_stop {
                "Workflow execution was stopped by user".to_string()
            } else if has_graceful_stop {
                format!("Workflow '{}' completed via stop node", workflow.name)
            } else if overall_success {
                if dry_run {
                    format!(
                        "Workflow '{}' completed successfully (Simulation)",
                        workflow.name
                    )
                } else {
                    format!("Workflow '{}' completed successfully", workflow.name)
                }
            } else {
                format!(
                    "Workflow '{}' finished with {failed_nodes} failed step(s)",
                    workflow.name
                )
            }),
        },
    );

    if failed_nodes > 0 {
        // Clean up any orphan mounts or serves left behind by the failed workflow execution
        cleanup_workflow_resources(&app, &workflow_id).await;

        notify(
            &app,
            NotificationEvent::Workflow(WorkflowStage::Failed {
                workflow_id: workflow_id.clone(),
                workflow_name: workflow.name.clone(),
                error: format!("{failed_nodes} step(s) failed"),
                failed_node_title: None,
                origin: Origin::Flow,
            }),
        );
    } else if is_cancelled && !has_graceful_stop {
        notify(
            &app,
            NotificationEvent::Workflow(WorkflowStage::Stopped {
                workflow_id: workflow_id.clone(),
                workflow_name: workflow.name.clone(),
                origin: Origin::Flow,
            }),
        );
    } else {
        notify(
            &app,
            NotificationEvent::Workflow(WorkflowStage::Completed {
                workflow_id: workflow_id.clone(),
                workflow_name: workflow.name.clone(),
                duration_ms: total_duration_ms,
                origin: Origin::Flow,
            }),
        );
    }

    Ok(WorkflowExecutionResult {
        workflow_id,
        success: overall_success,
        total_nodes,
        completed_nodes,
        failed_nodes,
        skipped_nodes,
        duration_ms: total_duration_ms,
        dry_run,
        error: if failed_nodes > 0 {
            Some(format!("{failed_nodes} step(s) failed"))
        } else if is_cancelled && !has_graceful_stop {
            Some("Workflow execution cancelled".to_string())
        } else {
            None
        },
    })
}

// ── Job Event Trigger Support ───────────────────────────────────────────────

static TRIGGERED_JOB_FINISH_EVENTS: once_cell::sync::Lazy<parking_lot::RwLock<HashSet<u64>>> =
    once_cell::sync::Lazy::new(|| parking_lot::RwLock::new(HashSet::new()));

/// Helper function that checks whether a `job_event` node configuration matches a finished job.
#[must_use]
pub fn job_event_matches_job(
    node_config: &Value,
    job: &crate::utils::types::jobs::JobInfo,
    quick_runs: &[crate::core::flow::quick_run::types::QuickRun],
) -> bool {
    let target = node_config
        .get("targetProfileId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();

    // Empty target means no profile configured to monitor
    if target.is_empty() {
        return false;
    }

    let event_state = node_config
        .get("eventState")
        .and_then(Value::as_str)
        .unwrap_or("any");

    let state_matches = match event_state {
        "success" => job.status == JobStatus::Completed,
        "failed" => job.status == JobStatus::Failed,
        _ => true,
    };

    if !state_matches {
        return false;
    }

    // 1. job.profile matches target (case-insensitive)
    let profile_matches = job
        .profile
        .as_deref()
        .is_some_and(|p| p.eq_ignore_ascii_case(target));

    // 2. job.quick_run_id matches target directly
    let qr_id_matches = job.quick_run_id.as_deref().is_some_and(|q| q == target);

    // 3. Quick Run name matches target (case-insensitive)
    let qr_name_matches = if let Some(ref q_id) = job.quick_run_id {
        quick_runs
            .iter()
            .any(|qr| qr.id == *q_id && qr.name.eq_ignore_ascii_case(target))
    } else {
        false
    };

    // 4. Remote name matches target (case-insensitive)
    let remote_matches = job.remote_name.eq_ignore_ascii_case(target);

    profile_matches || qr_id_matches || qr_name_matches || remote_matches
}

/// Evaluates all registered workflows and executes those matching a completed job event.
pub async fn trigger_workflows_for_job_finish(
    app: &AppHandle,
    job: &crate::utils::types::jobs::JobInfo,
) {
    if !job.status.is_finished() {
        return;
    }

    // Deduplicate: each finished job ID should only trigger matching workflows once
    {
        let mut set = TRIGGERED_JOB_FINISH_EVENTS.write();
        if set.contains(&job.jobid) {
            return;
        }
        if set.len() > 2000 {
            set.clear();
        }
        set.insert(job.jobid);
    }

    let manager = app.state::<AppSettingsManager>();
    let workflows = match crate::core::flow::workflow::commands::get_all_workflows_sync(&manager) {
        Ok(w) => w,
        Err(e) => {
            log::warn!("Failed to retrieve workflows for job event evaluation: {e}");
            return;
        }
    };

    let quick_runs = crate::core::flow::quick_run::commands::get_all_quick_runs_sync(&manager)
        .unwrap_or_default();

    for wf in workflows {
        // Prevent infinite self-trigger loops: if the finished job was started by this workflow, skip it
        if let Some(ref wf_origin_id) = job.workflow_id
            && *wf_origin_id == wf.id
        {
            continue;
        }

        // Skip if workflow is already actively executing
        {
            let active = ACTIVE_WORKFLOW_EXECUTIONS.read();
            if active.contains_key(&wf.id) {
                continue;
            }
        }

        let is_match = wf.nodes.iter().any(|node| {
            node.node_type == "job_event" && job_event_matches_job(&node.config, job, &quick_runs)
        });

        if is_match {
            info!(
                "🎯 Job {} finished (status: {:?}), auto-triggering workflow '{}' ({}) via job_event",
                job.jobid, job.status, wf.name, wf.id
            );
            let app_clone = app.clone();
            let wf_id = wf.id.clone();
            tokio::spawn(async move {
                if let Err(e) = crate::core::flow::workflow::commands::execute_workflow(
                    app_clone,
                    wf_id.clone(),
                    None,
                )
                .await
                {
                    log::error!("Failed to execute workflow '{wf_id}' triggered by job event: {e}");
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::flow::workflow::types::*;

    #[test]
    fn test_activate_outgoing_edges_branching() {
        let node = WorkflowNode {
            id: "node-1".to_string(),
            node_type: "condition".to_string(),
            category: WorkflowNodeCategory::Logic,
            title: "Check Condition".to_string(),
            subtitle: None,
            icon: None,
            x: 0.0,
            y: 0.0,
            inputs: vec![],
            outputs: vec![
                WorkflowPort {
                    id: "true".to_string(),
                    name: "True".to_string(),
                    port_type: WorkflowPortType::True,
                    label: None,
                    description: None,
                },
                WorkflowPort {
                    id: "false".to_string(),
                    name: "False".to_string(),
                    port_type: WorkflowPortType::False,
                    label: None,
                    description: None,
                },
            ],
            config: json!({}),
            state: None,
            error_message: None,
            last_duration_ms: None,
            started_at: None,
            finished_at: None,
        };

        let edges = vec![
            WorkflowEdge {
                id: "e1".to_string(),
                source_node_id: "node-1".to_string(),
                source_port_id: "true".to_string(),
                target_node_id: "node-true".to_string(),
                target_port_id: "in".to_string(),
                is_active: None,
            },
            WorkflowEdge {
                id: "e2".to_string(),
                source_node_id: "node-1".to_string(),
                source_port_id: "false".to_string(),
                target_node_id: "node-false".to_string(),
                target_port_id: "in".to_string(),
                is_active: None,
            },
        ];

        // 1. When condition branch is "true":
        let mut states_true = HashMap::new();
        let outcome_true = Ok(NodeExecutionOutput::branch(json!({}), "true"));
        activate_outgoing_edges(&node, &outcome_true, &edges, &mut states_true);

        assert_eq!(states_true.get("e1"), Some(&EdgeState::Activated));
        assert_eq!(states_true.get("e2"), Some(&EdgeState::Disabled));

        // 2. When condition branch is "false":
        let mut states_false = HashMap::new();
        let outcome_false = Ok(NodeExecutionOutput::branch(json!({}), "false"));
        activate_outgoing_edges(&node, &outcome_false, &edges, &mut states_false);

        assert_eq!(states_false.get("e1"), Some(&EdgeState::Disabled));
        assert_eq!(states_false.get("e2"), Some(&EdgeState::Activated));

        // 3. When a task node fails (Err):
        let task_node = WorkflowNode {
            id: "task-1".to_string(),
            node_type: "sync".to_string(),
            category: WorkflowNodeCategory::Task,
            title: "Sync".to_string(),
            subtitle: None,
            icon: None,
            x: 0.0,
            y: 0.0,
            inputs: vec![],
            outputs: vec![
                WorkflowPort {
                    id: "success".to_string(),
                    name: "Success".to_string(),
                    port_type: WorkflowPortType::Success,
                    label: None,
                    description: None,
                },
                WorkflowPort {
                    id: "failure".to_string(),
                    name: "Failure".to_string(),
                    port_type: WorkflowPortType::Failure,
                    label: None,
                    description: None,
                },
            ],
            config: json!({}),
            state: None,
            error_message: None,
            last_duration_ms: None,
            started_at: None,
            finished_at: None,
        };

        let task_edges = vec![
            WorkflowEdge {
                id: "te-ok".to_string(),
                source_node_id: "task-1".to_string(),
                source_port_id: "success".to_string(),
                target_node_id: "node-ok".to_string(),
                target_port_id: "in".to_string(),
                is_active: None,
            },
            WorkflowEdge {
                id: "te-fail".to_string(),
                source_node_id: "task-1".to_string(),
                source_port_id: "failure".to_string(),
                target_node_id: "node-fail".to_string(),
                target_port_id: "in".to_string(),
                is_active: None,
            },
        ];

        let mut states_task_err = HashMap::new();
        let task_err = Err("Network timeout".to_string());
        activate_outgoing_edges(&task_node, &task_err, &task_edges, &mut states_task_err);

        assert_eq!(states_task_err.get("te-ok"), Some(&EdgeState::Disabled));
        assert_eq!(states_task_err.get("te-fail"), Some(&EdgeState::Activated));
    }

    #[test]
    fn test_condition_evaluation_logic() {
        let test_cases = vec![
            ("equals", "hello", "hello", true),
            ("equals", "hello", "world", false),
            ("not_equals", "a", "b", true),
            ("contains", "filename.pdf", ".pdf", true),
            ("not_contains", "filename.pdf", ".txt", true),
            ("greater_than", "15.5", "10.0", true),
            ("greater_than", "5", "10", false),
            ("less_than", "2", "8", true),
            ("truthy", "yes", "", true),
            ("truthy", "0", "", false),
            ("truthy", "", "", false),
            ("is_empty", "  ", "", true),
            ("is_empty", "not empty", "", false),
        ];

        for (op, left, right, expected) in test_cases {
            let is_true = evaluate_condition(op, left, right);
            assert_eq!(
                is_true, expected,
                "Operator '{op}' with left='{left}', right='{right}' failed"
            );
        }

        // Test file_exists
        let cargo_toml = concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml");
        assert!(evaluate_condition("file_exists", cargo_toml, ""));
        assert!(!evaluate_condition(
            "file_exists",
            "/nonexistent/path/to/file_12345.xyz",
            ""
        ));
    }

    #[test]
    fn test_variable_interpolation_and_token_replacement() {
        let mut results = HashMap::new();
        results.insert(
            "step1".to_string(),
            json!({
                "stdout": "backup_2026.tar.gz",
                "exitCode": 0,
                "stats": {
                    "bytes": 1048576,
                    "transfers": 42
                }
            }),
        );

        let input_str = "File {{nodes.step1.stdout}} finished with code {{nodes.step1.exitCode}}, transfers: {{nodes.step1.stats.transfers}}";
        let replaced = replace_workflow_tokens(input_str, &results);

        assert_eq!(
            replaced,
            "File backup_2026.tar.gz finished with code 0, transfers: 42"
        );

        // Test unmapped token remains intact
        let unmapped = replace_workflow_tokens("Unknown: {{nodes.nonexistent.val}}", &results);
        assert_eq!(unmapped, "Unknown: {{nodes.nonexistent.val}}");

        // Test recursive JSON structure interpolation
        let config_obj = json!({
            "message": "Archive {{nodes.step1.stdout}} ready",
            "nested": {
                "bytes": "{{nodes.step1.stats.bytes}}"
            }
        });

        let interpolated = interpolate_node_config(&config_obj, &results);
        assert_eq!(
            interpolated.get("message").and_then(Value::as_str),
            Some("Archive backup_2026.tar.gz ready")
        );
        assert_eq!(
            interpolated
                .get("nested")
                .and_then(|n| n.get("bytes"))
                .and_then(Value::as_str),
            Some("1048576")
        );
    }

    #[test]
    fn test_workflow_operation_node_config_parsing() {
        use crate::rclone::commands::common::parse_common_config;
        use crate::rclone::commands::mount::MountParams;

        let structured_mount = json!({
            "remoteName": "drive",
            "config": {
                "app": { "autoStart": false, "showOnTray": true },
                "rclone": {
                    "fs": "drive:",
                    "mountPoint": "/home/user/drive",
                    "vfs_cache_mode": "full"
                }
            }
        });

        let op = extract_node_op_config(&structured_mount);
        let mount_params =
            MountParams::from_config(op.remote.to_string(), op.config, &op.empty_settings)
                .expect("Failed to parse mount params");

        assert_eq!(mount_params.remote_name, "drive");
        assert_eq!(mount_params.mount_point, "/home/user/drive");
        assert_eq!(mount_params.source, "drive:");

        let body = mount_params.to_rclone_body();
        assert_eq!(body.get("fs").and_then(Value::as_str), Some("drive:"));
        assert_eq!(
            body.get("mountPoint").and_then(Value::as_str),
            Some("/home/user/drive")
        );
        assert!(body.get("remote").is_none());
        assert!(body.get("remoteName").is_none());

        let structured_sync = json!({
            "remoteName": "drive",
            "config": {
                "app": { "autoStart": false },
                "rclone": {
                    "srcFs": "drive:",
                    "dstFs": "/home/user/backup",
                    "transfers": 4
                }
            }
        });

        let sync_op = extract_node_op_config(&structured_sync);
        let common = parse_common_config(sync_op.config, &sync_op.empty_settings)
            .expect("Failed to parse transfer config");

        assert_eq!(sync_op.remote, "drive");
        assert_eq!(common.source, vec!["drive:".to_string()]);
        assert_eq!(common.dest, "/home/user/backup".to_string());

        let structured_cryptcheck = json!({
            "remoteName": "secret-crypt",
            "config": {
                "rclone": {
                    "srcFs": "/local/data",
                    "dstFs": "encrypted_folder"
                }
            }
        });

        let crypt_op = extract_node_op_config(&structured_cryptcheck);
        let crypt_common = parse_common_config(crypt_op.config, &crypt_op.empty_settings)
            .expect("Failed to parse cryptcheck transfer config");

        assert_eq!(crypt_op.remote, "secret-crypt");
        assert_eq!(crypt_common.source, vec!["/local/data".to_string()]);
        assert_eq!(crypt_common.dest, "encrypted_folder".to_string());

        let dest_resolved = if !crypt_op.remote.is_empty()
            && !crypt_common.dest.is_empty()
            && !crypt_common.dest.contains(':')
        {
            format!("{}:{}", crypt_op.remote, crypt_common.dest)
        } else {
            crypt_common.dest.clone()
        };
        assert_eq!(dest_resolved, "secret-crypt:encrypted_folder");

        let structured_copyurl = json!({
            "remoteName": "backup-drive",
            "config": {
                "rclone": {
                    "url": "https://example.com/archive.zip",
                    "dstFs": "incoming",
                    "autoFilename": true
                }
            }
        });

        let copyurl_op = extract_node_op_config(&structured_copyurl);
        let copyurl_common = parse_common_config(copyurl_op.config, &copyurl_op.empty_settings)
            .expect("Failed to parse copyurl transfer config");

        assert_eq!(copyurl_op.remote, "backup-drive");
        assert_eq!(
            copyurl_common.source,
            vec!["https://example.com/archive.zip".to_string()]
        );
        assert_eq!(copyurl_common.dest, "incoming".to_string());

        let copyurl_dest_resolved =
            if !copyurl_op.remote.is_empty() && !copyurl_common.dest.contains(':') {
                if copyurl_common.dest.is_empty() {
                    format!("{}:", copyurl_op.remote)
                } else {
                    format!("{}:{}", copyurl_op.remote, copyurl_common.dest)
                }
            } else {
                copyurl_common.dest.clone()
            };
        assert_eq!(copyurl_dest_resolved, "backup-drive:incoming");

        let copyurl_body = crate::rclone::commands::sync::GenericTransferParams {
            source: copyurl_common.source[0].clone(),
            dest: copyurl_dest_resolved,
            rclone_config: copyurl_common.rclone_config.clone(),
            filter_options: copyurl_common.filter_options.clone(),
            backend_options: None,
            runtime_remote_options: copyurl_common.runtime_remote_options.clone(),
            transfer_type: OperationType::Copyurl,
            is_dir: false,
        }
        .to_rclone_body()
        .expect("Failed to generate copyurl rclone body");

        assert_eq!(
            copyurl_body.get("url").unwrap(),
            "https://example.com/archive.zip"
        );
        assert_eq!(copyurl_body.get("fs").unwrap(), "backup-drive:");
        assert_eq!(copyurl_body.get("remote").unwrap(), "incoming");
        assert_eq!(copyurl_body.get("autoFilename").unwrap(), true);
        assert_eq!(
            copyurl_body.get("_path").unwrap(),
            crate::utils::rclone::endpoints::operations::COPYURL
        );
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
    fn test_target_node_id_resolution_for_unmount_and_stop_serve() {
        let mut results = HashMap::new();
        results.insert(
            "node_mount_1".to_string(),
            json!({
                "mounted": true,
                "mountPoint": "/mnt/cloud",
                "remote": "gdrive",
                "nodeId": "node_mount_1"
            }),
        );
        results.insert(
            "node_serve_1".to_string(),
            json!({
                "served": true,
                "id": "http-123",
                "addr": "127.0.0.1:8080",
                "remote": "dropbox",
                "nodeId": "node_serve_1"
            }),
        );

        // Verify unmount resolution from node_mount_1
        let unmount_target = "node_mount_1";
        let target_result = results
            .get(unmount_target)
            .expect("Target mount node exists");
        let mount_point = target_result
            .get("mountPoint")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let remote = target_result
            .get("remote")
            .and_then(Value::as_str)
            .unwrap_or_default();
        assert_eq!(mount_point, "/mnt/cloud");
        assert_eq!(remote, "gdrive");

        // Verify stop_serve resolution from node_serve_1
        let serve_target = "node_serve_1";
        let target_serve = results.get(serve_target).expect("Target serve node exists");
        let server_id = target_serve
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let serve_remote = target_serve
            .get("remote")
            .and_then(Value::as_str)
            .unwrap_or_default();
        assert_eq!(server_id, "http-123");
        assert_eq!(serve_remote, "dropbox");
    }

    #[test]
    fn test_stop_node_graceful_halt() {
        let cancel_flag = AtomicBool::new(false);
        let config = json!({
            "status": "success",
            "message": "Workflow stopped intentionally"
        });

        let out =
            handle_stop_node(&config, &cancel_flag).expect("Stop node should return Ok output");

        assert_eq!(
            out.value.get("stopped").and_then(Value::as_bool),
            Some(true)
        );
        assert!(
            cancel_flag.load(Ordering::SeqCst),
            "Stop node must set cancel_flag to true"
        );

        let fail_config = json!({
            "status": "failed",
            "message": "Critical condition reached"
        });
        let err = handle_stop_node(&fail_config, &cancel_flag)
            .expect_err("Stop node with failed status must return error");
        assert!(err.contains("Critical condition reached"));
    }

    #[test]
    fn test_dry_run_job_metadata_propagation() {
        let mut backend_opts = HashMap::new();
        let dry_run = true;
        if dry_run {
            backend_opts.insert("DryRun".to_string(), json!(true));
        }

        assert_eq!(backend_opts.get("DryRun"), Some(&json!(true)));

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
    fn test_resolve_target_or_config_helper() {
        let mut results = HashMap::new();
        results.insert(
            "node-mount".to_string(),
            json!({
                "mountPoint": "/mnt/drive",
                "remote": "gdrive"
            }),
        );

        let config = json!({
            "targetNodeId": "node-mount",
            "mountPoint": "/fallback/drive",
            "remoteName": "fallback-remote"
        });

        // 1. Upstream node result matches
        let mp = resolve_target_or_config(
            "node-mount",
            &results,
            &config,
            &["mountPoint"],
            &["mountPoint"],
        );
        let rem = resolve_target_or_config(
            "node-mount",
            &results,
            &config,
            &["remote", "remoteName"],
            &["remoteName", "remote"],
        );
        assert_eq!(mp, "/mnt/drive");
        assert_eq!(rem, "gdrive");

        // 2. Upstream node missing -> fallback to config
        let mp_fallback = resolve_target_or_config(
            "node-nonexistent",
            &results,
            &config,
            &["mountPoint"],
            &["mountPoint"],
        );
        assert_eq!(mp_fallback, "/fallback/drive");

        // 3. No target id -> fallback to config
        let rem_fallback = resolve_target_or_config(
            "",
            &results,
            &config,
            &["remote", "remoteName"],
            &["remoteName", "remote"],
        );
        assert_eq!(rem_fallback, "fallback-remote");
    }

    #[tokio::test]
    async fn test_system_power_dry_run_simulation() {
        let dry_run = true;
        let config = json!({ "action": "sleep" });
        let action = config
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("sleep");

        let result = if dry_run {
            Ok(NodeExecutionOutput::new(json!({
                "powerAction": action,
                "executed": false,
                "dryRun": true,
                "message": format!("Dry run simulation: power action '{action}' skipped")
            })))
        } else {
            crate::core::power::execute_system_power(action)
                .await
                .map(|_| {
                    NodeExecutionOutput::new(json!({ "powerAction": action, "executed": true }))
                })
        };

        let output = result.expect("Dry run system power node should succeed");
        assert_eq!(
            output.value.get("powerAction").and_then(Value::as_str),
            Some("sleep")
        );
        assert_eq!(
            output.value.get("executed").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            output.value.get("dryRun").and_then(Value::as_bool),
            Some(true)
        );
    }

    fn create_test_join_node(id: &str, config: Value) -> WorkflowNode {
        WorkflowNode {
            id: id.to_string(),
            node_type: "join".to_string(),
            category: WorkflowNodeCategory::Logic,
            title: "Join Branches".to_string(),
            subtitle: None,
            icon: None,
            x: 0.0,
            y: 0.0,
            inputs: vec![],
            outputs: vec![],
            config,
            state: None,
            error_message: None,
            last_duration_ms: None,
            started_at: None,
            finished_at: None,
        }
    }

    fn create_test_join_workflow(
        node: WorkflowNode,
        edges: Vec<WorkflowEdge>,
    ) -> WorkflowDefinition {
        WorkflowDefinition {
            id: "wf-1".to_string(),
            name: "Test Flow".to_string(),
            description: None,
            nodes: vec![node],
            edges,
            viewport: CanvasViewport::default(),
            auto_start: false,
            cron_expression: None,
            created_at: None,
            updated_at: None,
            last_executed_at: None,
        }
    }

    fn create_test_join_edge(id: &str, src: &str, port: &str) -> WorkflowEdge {
        WorkflowEdge {
            id: id.to_string(),
            source_node_id: src.to_string(),
            source_port_id: "out".to_string(),
            target_node_id: "node-join".to_string(),
            target_port_id: port.to_string(),
            is_active: None,
        }
    }

    #[test]
    fn test_join_node_all_success_ok() {
        let node = create_test_join_node("node-join", json!({ "joinMode": "all_success" }));
        let workflow = create_test_join_workflow(
            node.clone(),
            vec![
                create_test_join_edge("e1", "node-a", "in1"),
                create_test_join_edge("e2", "node-b", "in2"),
            ],
        );

        let mut results = HashMap::new();
        results.insert("node-a".to_string(), json!({ "transferred": 10 }));
        results.insert("node-b".to_string(), json!({ "transferred": 20 }));

        let config = json!({ "joinMode": "all_success" });
        let out = handle_join_node(&node, &workflow, &config, &results)
            .expect("join should succeed when all branches succeed");

        assert_eq!(out.value.get("passed").and_then(Value::as_bool), Some(true));
        assert_eq!(
            out.value.get("totalBranches").and_then(Value::as_u64),
            Some(2)
        );
        assert_eq!(
            out.value.get("successfulBranches").and_then(Value::as_u64),
            Some(2)
        );
        assert_eq!(
            out.value
                .pointer("/branches/in1/success")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            out.value
                .pointer("/branches/in2/success")
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn test_join_node_all_success_fails_when_branch_fails() {
        let node = create_test_join_node("node-join", json!({ "joinMode": "all_success" }));
        let workflow = create_test_join_workflow(
            node.clone(),
            vec![
                create_test_join_edge("e1", "node-a", "in1"),
                create_test_join_edge("e2", "node-b", "in2"),
            ],
        );

        let mut results = HashMap::new();
        // Only node-a succeeded; node-b failed and is not in results
        results.insert("node-a".to_string(), json!({ "transferred": 10 }));

        let config = json!({ "joinMode": "all_success" });
        let err = handle_join_node(&node, &workflow, &config, &results)
            .expect_err("join with all_success must fail when a branch fails");

        assert!(err.contains("Join barrier failed: only 1 of 2 incoming branches succeeded"));
    }

    #[test]
    fn test_join_node_any_success_and_always_modes() {
        let node = create_test_join_node("node-join", json!({}));
        let workflow = create_test_join_workflow(
            node.clone(),
            vec![
                create_test_join_edge("e1", "node-a", "in1"),
                create_test_join_edge("e2", "node-b", "in2"),
            ],
        );

        let mut results = HashMap::new();
        results.insert("node-a".to_string(), json!({ "transferred": 10 }));

        // 1. any_success succeeds when 1 of 2 branches succeeded
        let config_any = json!({ "joinMode": "any_success" });
        let out_any = handle_join_node(&node, &workflow, &config_any, &results)
            .expect("join with any_success should succeed when 1 branch succeeds");
        assert_eq!(
            out_any
                .value
                .get("successfulBranches")
                .and_then(Value::as_u64),
            Some(1)
        );

        // 2. any_success fails when 0 branches succeeded
        let empty_results = HashMap::new();
        let err_any = handle_join_node(&node, &workflow, &config_any, &empty_results)
            .expect_err("join with any_success should fail when 0 branches succeed");
        assert!(err_any.contains("none of the incoming branches succeeded"));

        // 3. always succeeds even when 0 branches succeeded
        let config_always = json!({ "joinMode": "always" });
        let out_always = handle_join_node(&node, &workflow, &config_always, &empty_results)
            .expect("join with always should succeed even when 0 branches succeed");
        assert_eq!(
            out_always
                .value
                .get("successfulBranches")
                .and_then(Value::as_u64),
            Some(0)
        );
    }

    #[test]
    fn test_parallel_fork_dynamic_branches_activation() {
        let fork_node = WorkflowNode {
            id: "node-fork".to_string(),
            node_type: "parallel_fork".to_string(),
            category: WorkflowNodeCategory::Logic,
            title: "Parallel Split".to_string(),
            subtitle: None,
            icon: None,
            x: 0.0,
            y: 0.0,
            inputs: vec![WorkflowPort {
                id: "in".to_string(),
                name: "In".to_string(),
                port_type: WorkflowPortType::In,
                label: None,
                description: None,
            }],
            outputs: vec![
                WorkflowPort {
                    id: "branch1".to_string(),
                    name: "Branch 1".to_string(),
                    port_type: WorkflowPortType::Out,
                    label: None,
                    description: None,
                },
                WorkflowPort {
                    id: "branch2".to_string(),
                    name: "Branch 2".to_string(),
                    port_type: WorkflowPortType::Out,
                    label: None,
                    description: None,
                },
                WorkflowPort {
                    id: "branch3".to_string(),
                    name: "Branch 3".to_string(),
                    port_type: WorkflowPortType::Out,
                    label: None,
                    description: None,
                },
            ],
            config: json!({}),
            state: None,
            error_message: None,
            last_duration_ms: None,
            started_at: None,
            finished_at: None,
        };

        let edges = vec![
            WorkflowEdge {
                id: "e1".to_string(),
                source_node_id: "node-fork".to_string(),
                source_port_id: "branch1".to_string(),
                target_node_id: "node-task-1".to_string(),
                target_port_id: "in".to_string(),
                is_active: None,
            },
            WorkflowEdge {
                id: "e2".to_string(),
                source_node_id: "node-fork".to_string(),
                source_port_id: "branch2".to_string(),
                target_node_id: "node-task-2".to_string(),
                target_port_id: "in".to_string(),
                is_active: None,
            },
            WorkflowEdge {
                id: "e3".to_string(),
                source_node_id: "node-fork".to_string(),
                source_port_id: "branch3".to_string(),
                target_node_id: "node-task-3".to_string(),
                target_port_id: "in".to_string(),
                is_active: None,
            },
        ];

        let mut edge_states = HashMap::new();
        edge_states.insert("e1".to_string(), EdgeState::Pending);
        edge_states.insert("e2".to_string(), EdgeState::Pending);
        edge_states.insert("e3".to_string(), EdgeState::Pending);

        let outcome = Ok(NodeExecutionOutput::new(json!({
            "passed": true,
            "timestamp": "2026-09-02T12:00:00Z"
        })));

        activate_outgoing_edges(&fork_node, &outcome, &edges, &mut edge_states);

        assert_eq!(edge_states.get("e1"), Some(&EdgeState::Activated));
        assert_eq!(edge_states.get("e2"), Some(&EdgeState::Activated));
        assert_eq!(edge_states.get("e3"), Some(&EdgeState::Activated));
    }

    #[test]
    fn test_resolve_delay_seconds() {
        // Defaults to 5 seconds if config is empty or missing 'seconds' key
        assert_eq!(resolve_delay_seconds(&json!({})), 5);

        // Numeric seconds
        assert_eq!(resolve_delay_seconds(&json!({ "seconds": 10 })), 10);
        assert_eq!(resolve_delay_seconds(&json!({ "seconds": 0 })), 0);

        // String seconds
        assert_eq!(resolve_delay_seconds(&json!({ "seconds": "15" })), 15);

        // Float seconds
        assert_eq!(resolve_delay_seconds(&json!({ "seconds": 20.0 })), 20);
    }

    #[tokio::test]
    async fn test_execute_delay_node_zero_seconds() {
        let cancel_flag = AtomicBool::new(false);
        let config = json!({ "seconds": 0 });
        let result = execute_delay_node(&config, &cancel_flag).await;
        let output = result.expect("Zero delay should succeed immediately");
        assert_eq!(
            output.value.get("waitedSeconds").and_then(Value::as_u64),
            Some(0)
        );
    }

    #[tokio::test]
    async fn test_execute_delay_node_cancelled() {
        let cancel_flag = AtomicBool::new(true);
        let config = json!({ "seconds": 10 });
        let result = execute_delay_node(&config, &cancel_flag).await;
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            "Execution cancelled during delay".to_string()
        );
    }

    #[test]
    fn test_parse_rc_params() {
        // None or Null defaults to empty object
        assert_eq!(parse_rc_params(None).unwrap(), json!({}));
        assert_eq!(parse_rc_params(Some(&json!(null))).unwrap(), json!({}));

        // JSON Object is passed directly
        let obj = json!({ "fs": "remote:", "recursive": true });
        assert_eq!(parse_rc_params(Some(&obj)).unwrap(), obj);

        // Valid JSON string is parsed into an object
        let valid_str = json!("{\"fs\": \"myremote:\", \"dir\": \"backup\"}");
        assert_eq!(
            parse_rc_params(Some(&valid_str)).unwrap(),
            json!({ "fs": "myremote:", "dir": "backup" })
        );

        // Empty or whitespace string defaults to empty object
        assert_eq!(parse_rc_params(Some(&json!(""))).unwrap(), json!({}));
        assert_eq!(
            parse_rc_params(Some(&json!("   \n\t "))).unwrap(),
            json!({})
        );

        // Invalid JSON string returns an error
        let invalid_str = json!("{ not_valid_json }");
        let err = parse_rc_params(Some(&invalid_str)).unwrap_err();
        assert!(err.contains("Invalid JSON in RC command params"));
    }

    #[test]
    fn test_quick_run_config_validation() {
        let empty_config = json!({ "quickRunId": "" });
        let id_res = empty_config
            .get("quickRunId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "Missing or empty 'quickRunId' in quick_run node config".to_string());
        assert!(id_res.is_err());

        let whitespace_config = json!({ "quickRunId": "   \t\n  " });
        let id_res2 = whitespace_config
            .get("quickRunId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "Missing or empty 'quickRunId' in quick_run node config".to_string());
        assert!(id_res2.is_err());

        let missing_config = json!({});
        let id_res3 = missing_config
            .get("quickRunId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "Missing or empty 'quickRunId' in quick_run node config".to_string());
        assert!(id_res3.is_err());

        let valid_config = json!({ "quickRunId": "  qr-backup-01  " });
        let id_res4 = valid_config
            .get("quickRunId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "Missing or empty 'quickRunId' in quick_run node config".to_string());
        assert_eq!(id_res4.unwrap(), "qr-backup-01");
    }

    #[tokio::test]
    async fn test_exec_script_dry_run() {
        let config = json!({
            "command": "rm -rf /critical/data",
            "args": "--no-preserve-root",
            "failOnError": true
        });
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);

        let result = handle_exec_script_node(&config, &cancel_flag, cancel_rx, true)
            .await
            .expect("dry-run should succeed safely");

        assert_eq!(result.value["dryRun"], true);
        assert_eq!(result.value["simulated"], true);
        assert_eq!(result.value["exitCode"], 0);
        assert_eq!(result.value["success"], true);
        let stdout = result.value["stdout"].as_str().unwrap();
        assert!(stdout.contains(
            "[dry_run] Simulated execution of: rm -rf /critical/data --no-preserve-root"
        ));
    }

    #[tokio::test]
    async fn test_exec_script_missing_command() {
        let config = json!({ "command": "   ", "args": "-a" });
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);

        let result = handle_exec_script_node(&config, &cancel_flag, cancel_rx, false).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Missing 'command'"));
    }

    #[tokio::test]
    async fn test_exec_script_success() {
        let config = json!({
            "command": "echo",
            "args": "hello_from_test"
        });
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);

        let result = handle_exec_script_node(&config, &cancel_flag, cancel_rx, false)
            .await
            .expect("echo command should succeed");

        assert_eq!(result.value["exitCode"], 0);
        assert_eq!(result.value["success"], true);
        let stdout = result.value["stdout"].as_str().unwrap();
        assert!(stdout.contains("hello_from_test"));
    }

    #[tokio::test]
    async fn test_exec_script_fail_on_error_true() {
        let config = json!({
            "command": "exit 42",
            "failOnError": true
        });
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);

        let result = handle_exec_script_node(&config, &cancel_flag, cancel_rx, false).await;
        assert!(result.is_err());
        let err_msg = result.unwrap_err();
        assert!(err_msg.contains("Command exited with code"));
    }

    #[tokio::test]
    async fn test_exec_script_fail_on_error_false() {
        let config = json!({
            "command": "exit 42",
            "failOnError": false
        });
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);

        let result = handle_exec_script_node(&config, &cancel_flag, cancel_rx, false)
            .await
            .expect("should not error when failOnError is false");

        assert_eq!(result.value["success"], false);
        assert_ne!(result.value["exitCode"], 0);
    }

    #[test]
    fn test_job_event_matches_job_cases() {
        use crate::core::flow::quick_run::types::QuickRun;
        use crate::utils::types::jobs::JobInfo;

        let mock_job =
            |status: JobStatus, profile: Option<&str>, qr_id: Option<&str>, remote: &str| JobInfo {
                jobid: 101,
                execute_id: None,
                quick_run_id: qr_id.map(String::from),
                job_type: JobType::Sync,
                remote_name: remote.to_string(),
                source: vec!["src".to_string()],
                destination: "dst".to_string(),
                start_time: Utc::now(),
                end_time: Some(Utc::now()),
                status,
                error: None,
                stats: None,
                group: "test-group".to_string(),
                profile: profile.map(String::from),
                origin: None,
                backend_name: "local".to_string(),
                dry_run: false,
                parent_job_id: None,
                workflow_id: None,
                node_id: None,
            };

        let quick_runs = vec![QuickRun {
            id: "qr-1".to_string(),
            name: "Nightly Sync".to_string(),
            description: None,
            operation_type: OperationType::Sync,
            remote_name: "remote1:".to_string(),
            config: json!({}),
        }];

        // 1. Matches profile with eventState 'any'
        let job1 = mock_job(JobStatus::Completed, Some("daily-backup"), None, "remote1:");
        let cfg1 = json!({ "targetProfileId": "daily-backup", "eventState": "any" });
        assert!(job_event_matches_job(&cfg1, &job1, &quick_runs));

        // 2. Case-insensitive profile match
        let cfg1_case = json!({ "targetProfileId": "Daily-Backup", "eventState": "any" });
        assert!(job_event_matches_job(&cfg1_case, &job1, &quick_runs));

        // 3. Status filter: 'success' matches Completed, rejects Failed
        let cfg_success = json!({ "targetProfileId": "daily-backup", "eventState": "success" });
        assert!(job_event_matches_job(&cfg_success, &job1, &quick_runs));

        let job_failed = mock_job(JobStatus::Failed, Some("daily-backup"), None, "remote1:");
        assert!(!job_event_matches_job(
            &cfg_success,
            &job_failed,
            &quick_runs
        ));

        // 4. Status filter: 'failed' matches Failed, rejects Completed
        let cfg_failed = json!({ "targetProfileId": "daily-backup", "eventState": "failed" });
        assert!(job_event_matches_job(&cfg_failed, &job_failed, &quick_runs));
        assert!(!job_event_matches_job(&cfg_failed, &job1, &quick_runs));

        // 5. Matches Quick Run by ID
        let job_qr = mock_job(JobStatus::Completed, None, Some("qr-1"), "remote1:");
        let cfg_qr_id = json!({ "targetProfileId": "qr-1", "eventState": "any" });
        assert!(job_event_matches_job(&cfg_qr_id, &job_qr, &quick_runs));

        // 6. Matches Quick Run by Name
        let cfg_qr_name = json!({ "targetProfileId": "Nightly Sync", "eventState": "any" });
        assert!(job_event_matches_job(&cfg_qr_name, &job_qr, &quick_runs));

        // 7. Matches Remote name
        let cfg_remote = json!({ "targetProfileId": "remote1:", "eventState": "any" });
        assert!(job_event_matches_job(&cfg_remote, &job1, &quick_runs));

        // 8. Empty targetProfileId should never match
        let cfg_empty = json!({ "targetProfileId": "", "eventState": "any" });
        assert!(!job_event_matches_job(&cfg_empty, &job1, &quick_runs));

        // 9. Mismatched profile
        let cfg_mismatch = json!({ "targetProfileId": "other-profile", "eventState": "any" });
        assert!(!job_event_matches_job(&cfg_mismatch, &job1, &quick_runs));
    }

    #[test]
    fn test_watcher_node_execution_output() {
        let node = WorkflowNode {
            id: "node-watcher".to_string(),
            node_type: "watcher".to_string(),
            category: WorkflowNodeCategory::Trigger,
            title: "Local Watcher".to_string(),
            subtitle: None,
            icon: None,
            x: 0.0,
            y: 0.0,
            inputs: vec![],
            outputs: vec![],
            config: json!({
                "watchPaths": ["/home/test/folder"],
                "globPattern": "*.log",
                "debounceSeconds": 3
            }),
            state: None,
            error_message: None,
            last_duration_ms: None,
            started_at: None,
            finished_at: None,
        };

        let res = match node.node_type.as_str() {
            "watcher" => {
                let watch_paths = node
                    .config
                    .get("watchPaths")
                    .cloned()
                    .unwrap_or_else(|| json!([]));
                let glob_pattern = node
                    .config
                    .get("globPattern")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let debounce_seconds = node
                    .config
                    .get("debounceSeconds")
                    .and_then(Value::as_u64)
                    .unwrap_or(5);
                Ok(NodeExecutionOutput::new(json!({
                    "passed": true,
                    "watchPaths": watch_paths,
                    "globPattern": glob_pattern,
                    "debounceSeconds": debounce_seconds,
                    "timestamp": Utc::now().to_rfc3339()
                })))
            }
            _ => Err("unexpected".to_string()),
        };

        let output = res.unwrap();
        assert_eq!(output.value["passed"], true);
        assert_eq!(output.value["watchPaths"][0], "/home/test/folder");
        assert_eq!(output.value["globPattern"], "*.log");
        assert_eq!(output.value["debounceSeconds"], 3);
    }

    #[tokio::test]
    async fn test_app_start_node_execution() {
        let cancel_flag = Arc::new(AtomicBool::new(false));

        // 1. Zero delay executes immediately
        let config_zero = json!({ "delaySeconds": 0 });
        let out = handle_app_start_node(&config_zero, &cancel_flag, false)
            .await
            .unwrap();
        assert_eq!(out.value["autoStarted"], true);
        assert_eq!(out.value["waitedDelay"], 0);

        // 2. Dry run skips delay
        let config_delayed = json!({ "delaySeconds": 60 });
        let out_dry = handle_app_start_node(&config_delayed, &cancel_flag, true)
            .await
            .unwrap();
        assert_eq!(out_dry.value["autoStarted"], true);
        assert_eq!(out_dry.value["waitedDelay"], 0);

        // 3. Cancelled execution returns error
        cancel_flag.store(true, Ordering::SeqCst);
        let err = handle_app_start_node(&config_delayed, &cancel_flag, false)
            .await
            .unwrap_err();
        assert!(err.contains("cancelled during app_start delay"));
    }

    #[test]
    fn test_build_archive_final_dest() {
        // 1. With existing archive extension, keeps as is
        assert_eq!(
            build_archive_final_dest("/home/user/docs", "remote:backups/myarchive.zip", "zip"),
            "remote:backups/myarchive.zip"
        );
        assert_eq!(
            build_archive_final_dest(
                "/home/user/docs",
                "remote:backups/myarchive.tar.gz",
                "tar.gz"
            ),
            "remote:backups/myarchive.tar.gz"
        );

        // 2. Trailing slash / folder destination, appends folder_name.format
        assert_eq!(
            build_archive_final_dest("/home/user/myfolder", "remote:backups/", "zip"),
            "remote:backups/myfolder.zip"
        );
        assert_eq!(
            build_archive_final_dest("gdrive:photos", "local:/backup", "tar"),
            "local:/backup/photos.tar"
        );

        // 3. Trailing colon
        assert_eq!(
            build_archive_final_dest("/home/user/data", "gdrive:", "zip"),
            "gdrive:data.zip"
        );
    }
}
