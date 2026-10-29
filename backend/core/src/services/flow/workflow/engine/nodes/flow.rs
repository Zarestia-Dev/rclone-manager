//! Flow control: triggers, stop, join, condition, delay and schedule waits.

use std::collections::HashMap;
use std::time::Duration;

use chrono::Utc;
use log::info;
use serde_json::{Value, json};

use crate::services::flow::workflow::engine::cancel::{CancelToken, sleep_unless_cancelled};
use crate::services::flow::workflow::types::{
    NodeExecutionOutput, NodeKind, WorkflowDefinition, WorkflowEdge, WorkflowNode,
    parse_delay_seconds,
};

/// Evaluates a 'stop' node. A graceful stop reports `stopped: true`; the run then
/// starts no further nodes but lets those already running finish.
pub(crate) fn handle_stop_node(config: &Value) -> Result<NodeExecutionOutput, String> {
    let status = config
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("success");

    let message = config
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| crate::t!("backendErrors.workflow.stopDefaultMessage"));

    if status == "failed" || status == "error" {
        Err(crate::localized_error!(
            "backendErrors.workflow.haltedWithError",
            "message" => message
        ))
    } else {
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
                return Err(crate::localized_error!(
                    "backendErrors.workflow.joinNoneSucceeded"
                ));
            }
        }
        "always" => {
            // Always proceeds regardless of branch success count
        }
        _ => {
            // "all_success" is the default
            if successful_count < total_branches {
                return Err(crate::localized_error!(
                    "backendErrors.workflow.joinPartial",
                    "successful" => successful_count,
                    "total" => total_branches
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
fn evaluate_condition(operator: &str, left: &str, right: &str) -> Result<bool, String> {
    Ok(match operator {
        "equals" => left == right,
        "not_equals" => left != right,
        "contains" => left.contains(right),
        "not_contains" => !left.contains(right),
        "starts_with" => left.starts_with(right),
        "ends_with" => left.ends_with(right),
        "truthy" => !left.trim().is_empty() && left != "0" && left != "false",
        "is_empty" => left.trim().is_empty(),
        "greater_than" => {
            let l: f64 = left.trim().parse().unwrap_or(0.0);
            let r: f64 = right.trim().parse().unwrap_or(0.0);
            l > r
        }
        "greater_or_equal" | "gte" => {
            let l: f64 = left.trim().parse().unwrap_or(0.0);
            let r: f64 = right.trim().parse().unwrap_or(0.0);
            l >= r
        }
        "less_than" => {
            let l: f64 = left.trim().parse().unwrap_or(0.0);
            let r: f64 = right.trim().parse().unwrap_or(0.0);
            l < r
        }
        "less_or_equal" | "lte" => {
            let l: f64 = left.trim().parse().unwrap_or(0.0);
            let r: f64 = right.trim().parse().unwrap_or(0.0);
            l <= r
        }
        "array_not_empty" => {
            let trimmed = left.trim();
            if trimmed.starts_with('[') && trimmed.ends_with(']') {
                serde_json::from_str::<Value>(trimmed)
                    .map(|v| v.as_array().map(|a| !a.is_empty()).unwrap_or(false))
                    .unwrap_or(!trimmed.is_empty())
            } else {
                !trimmed.is_empty() && trimmed != "0" && trimmed != "false"
            }
        }
        "array_is_empty" => {
            let trimmed = left.trim();
            if trimmed.starts_with('[') && trimmed.ends_with(']') {
                serde_json::from_str::<Value>(trimmed)
                    .map(|v| v.as_array().map(|a| a.is_empty()).unwrap_or(true))
                    .unwrap_or(trimmed.len() <= 2)
            } else {
                trimmed.is_empty() || trimmed == "[]"
            }
        }
        unknown => {
            return Err(crate::localized_error!(
                "backendErrors.workflow.unknownOperator",
                "operator" => unknown
            ));
        }
    })
}

/// Evaluates a condition, asking the filesystem without blocking the runtime.
async fn condition_holds(operator: &str, left: &str, right: &str) -> Result<bool, String> {
    if operator == "file_exists" {
        return Ok(tokio::fs::try_exists(left).await.unwrap_or(false));
    }
    evaluate_condition(operator, left, right)
}

/// Resolves the delay duration in seconds from the node configuration,
/// using the `delaySeconds` key in integer, float, or string representations.
fn resolve_delay_seconds(config: &Value) -> u64 {
    let parse_u64 = |val: Option<&Value>| -> Option<u64> {
        val.and_then(Value::as_u64)
            .or_else(|| val.and_then(Value::as_f64).map(|f| f.max(0.0) as u64))
            .or_else(|| {
                val.and_then(Value::as_str)
                    .and_then(|s| s.parse::<u64>().ok())
            })
    };

    parse_u64(config.get("delaySeconds")).unwrap_or(5)
}

/// Executes a 'delay' node by pausing execution for the resolved duration.
pub(crate) async fn execute_delay_node(
    config: &Value,
    cancel: &CancelToken,
) -> Result<NodeExecutionOutput, String> {
    let seconds = resolve_delay_seconds(config);

    if seconds > 0 && !sleep_unless_cancelled(cancel, Duration::from_secs(seconds)).await {
        return Err(crate::localized_error!("backendErrors.workflow.cancelled"));
    }

    Ok(NodeExecutionOutput::new(
        json!({ "waitedSeconds": seconds }),
    ))
}

/// Executes a 'schedule_wait' logic node.
/// Pauses workflow execution until the next occurrence of the configured cron schedule.
/// Respects dry_run simulation, process cancellation, and emits execution metrics.
/// Longest sleep between wall-clock checks of a schedule wait.
const SCHEDULE_RECHECK: Duration = Duration::from_secs(30);

pub(crate) async fn execute_schedule_wait_node(
    config: &Value,
    cancel: &CancelToken,
    dry_run: bool,
) -> Result<NodeExecutionOutput, String> {
    let cron_expr = config
        .get("cronExpression")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("0 2 * * *");

    let next_run = crate::services::automation::engine::get_next_run(cron_expr).map_err(|e| {
        crate::localized_error!(
            "backendErrors.workflow.invalidSchedule",
            "cron" => cron_expr,
            "error" => e
        )
    })?;

    let now = Utc::now();
    let wait_seconds = (next_run - now).num_seconds().max(0);

    if dry_run {
        info!(
            "Workflow dry_run enabled; simulating schedule wait for cron '{cron_expr}' (target: {next_run}, would wait {wait_seconds}s)"
        );
        return Ok(NodeExecutionOutput::new(json!({
            "simulated": true,
            "dryRun": true,
            "cronExpression": cron_expr,
            "targetTime": next_run.to_rfc3339(),
            "waitedSeconds": 0
        })));
    }

    let start_time = Utc::now();
    // The wall clock is rechecked periodically: a monotonic timer can fall behind
    // it while the machine is suspended.
    while let Ok(remaining) = (next_run - Utc::now()).to_std() {
        if remaining.is_zero() {
            break;
        }
        if !sleep_unless_cancelled(cancel, remaining.min(SCHEDULE_RECHECK)).await {
            return Err(crate::localized_error!("backendErrors.workflow.cancelled"));
        }
    }

    let actual_waited = (Utc::now() - start_time).num_seconds().max(0);

    Ok(NodeExecutionOutput::new(json!({
        "cronExpression": cron_expr,
        "targetTime": next_run.to_rfc3339(),
        "waitedSeconds": actual_waited,
        "resumedAt": Utc::now().to_rfc3339()
    })))
}

/// Executes an 'app_start' trigger node.
/// Pauses execution if `delaySeconds` is configured and not in dry_run mode,
/// periodically checking the cancellation flag to ensure prompt responsiveness.
pub(crate) async fn handle_app_start_node(
    config: &Value,
    cancel: &CancelToken,
    dry_run: bool,
) -> Result<NodeExecutionOutput, String> {
    let delay = parse_delay_seconds(config);

    if delay > 0 && !dry_run && !sleep_unless_cancelled(cancel, Duration::from_secs(delay)).await {
        return Err(crate::localized_error!("backendErrors.workflow.cancelled"));
    }

    Ok(NodeExecutionOutput::new(json!({
        "autoStarted": true,
        "waitedDelay": if dry_run { 0 } else { delay },
        "timestamp": Utc::now().to_rfc3339()
    })))
}

/// What a trigger or fork node reports when it fires. They only open the way for the nodes after them.
pub(crate) fn trigger_output(kind: NodeKind, config: &Value) -> NodeExecutionOutput {
    let timestamp = Utc::now().to_rfc3339();
    NodeExecutionOutput::new(match kind {
        NodeKind::Cron => json!({
            "passed": true,
            "cronExpression": config
                .get("cronExpression")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            "timestamp": timestamp
        }),
        NodeKind::Watcher => json!({
            "passed": true,
            "watchPaths": config.get("watchPaths").cloned().unwrap_or_else(|| json!([])),
            "globPattern": config
                .get("globPattern")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            "debounceSeconds": config
                .get("debounceSeconds")
                .and_then(Value::as_u64)
                .unwrap_or(5),
            "timestamp": timestamp
        }),
        NodeKind::JobEvent => json!({
            "passed": true,
            "targetProfileId": config
                .get("targetProfileId")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            "eventState": config
                .get("eventState")
                .and_then(Value::as_str)
                .unwrap_or("any"),
            "timestamp": timestamp
        }),
        _ => json!({ "passed": true, "timestamp": timestamp }),
    })
}

/// Evaluates a 'condition' node and picks the `true` or `false` branch.
pub(crate) async fn condition_node(config: &Value) -> Result<NodeExecutionOutput, String> {
    let operator = config
        .get("operator")
        .and_then(Value::as_str)
        .unwrap_or("equals");
    let mut left = config
        .get("leftValue")
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut right = config
        .get("rightValue")
        .and_then(Value::as_str)
        .unwrap_or("");

    // A reference that could not be resolved reads as empty.
    if left.starts_with("{{") && left.ends_with("}}") {
        left = "";
    }
    if right.starts_with("{{") && right.ends_with("}}") {
        right = "";
    }

    let is_true = condition_holds(operator, left, right).await?;

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

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::{Value, json};

    use super::*;

    use crate::services::flow::workflow::types::*;

    #[test]
    fn a_watcher_node_reports_its_settings_and_defaults() {
        let output = trigger_output(
            NodeKind::Watcher,
            &json!({
                "watchPaths": ["/home/test/folder"],
                "globPattern": "*.log",
                "debounceSeconds": 3
            }),
        );
        assert_eq!(output.value["passed"], true);
        assert_eq!(output.value["watchPaths"][0], "/home/test/folder");
        assert_eq!(output.value["globPattern"], "*.log");
        assert_eq!(output.value["debounceSeconds"], 3);

        let defaults = trigger_output(NodeKind::Watcher, &json!({}));
        assert_eq!(defaults.value["watchPaths"], json!([]));
        assert_eq!(defaults.value["debounceSeconds"], 5);
    }

    #[test]
    fn triggers_report_their_own_settings_and_forks_only_pass() {
        let cron = trigger_output(NodeKind::Cron, &json!({"cronExpression": "0 2 * * *"}));
        assert_eq!(cron.value["cronExpression"], "0 2 * * *");
        let event = trigger_output(NodeKind::JobEvent, &json!({"targetProfileId": "Backup"}));
        assert_eq!(event.value["targetProfileId"], "Backup");
        assert_eq!(event.value["eventState"], "any");
        let fork = trigger_output(NodeKind::ParallelFork, &json!({"ignored": true}));
        assert_eq!(fork.value["passed"], true);
        assert!(fork.value.get("ignored").is_none());
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
            let is_true = evaluate_condition(op, left, right).unwrap();
            assert_eq!(
                is_true, expected,
                "Operator '{op}' with left='{left}', right='{right}' failed"
            );
        }
    }

    #[tokio::test]
    async fn file_exists_asks_the_filesystem_without_blocking_the_runtime() {
        let cargo_toml = concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml");
        assert!(
            condition_holds("file_exists", cargo_toml, "")
                .await
                .unwrap()
        );
        assert!(
            !condition_holds("file_exists", "/nonexistent/path/to/file_12345.xyz", "")
                .await
                .unwrap()
        );
        // Other operators behave exactly as before.
        assert!(condition_holds("equals", "a", "a").await.unwrap());
        assert!(condition_holds("nonsense", "a", "a").await.is_err());
    }

    #[test]
    fn test_stop_node_graceful_halt() {
        let config = json!({
            "status": "success",
            "message": "Workflow stopped intentionally"
        });

        let out = handle_stop_node(&config).expect("Stop node should return Ok output");

        assert_eq!(
            out.value.get("stopped").and_then(Value::as_bool),
            Some(true)
        );

        let fail_config = json!({
            "status": "failed",
            "message": "Critical condition reached"
        });
        let err = handle_stop_node(&fail_config)
            .expect_err("Stop node with failed status must return error");
        assert!(err.contains("Critical condition reached"));
    }

    #[test]
    fn a_stop_node_without_a_message_uses_the_translated_default() {
        let out = handle_stop_node(&json!({})).unwrap();
        assert_eq!(out.value["message"], "Workflow stopped by node");
        let provided = handle_stop_node(&json!({"message": "Done early"})).unwrap();
        assert_eq!(provided.value["message"], "Done early");
    }

    fn create_test_join_node(id: &str, config: Value) -> WorkflowNode {
        WorkflowNode {
            id: id.to_string(),
            node_type: "join".to_string(),
            category: WorkflowNodeCategory::Logic,
            title: "Join Branches".to_string(),
            config,
            ..Default::default()
        }
    }

    fn create_test_join_workflow(
        node: WorkflowNode,
        edges: Vec<WorkflowEdge>,
    ) -> WorkflowDefinition {
        WorkflowDefinition {
            id: "wf-1".to_string(),
            name: "Test Flow".to_string(),
            nodes: vec![node],
            edges,
            ..Default::default()
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

        assert!(err.contains("backendErrors.workflow.joinPartial"));
        assert!(err.contains(r#""successful":"1""#) && err.contains(r#""total":"2""#));
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
        assert!(err_any.contains("backendErrors.workflow.joinNoneSucceeded"));

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
    fn test_resolve_delay_seconds() {
        // Defaults to 5 seconds if config is empty or missing 'delaySeconds' key
        assert_eq!(resolve_delay_seconds(&json!({})), 5);

        // Numeric delaySeconds
        assert_eq!(resolve_delay_seconds(&json!({ "delaySeconds": 10 })), 10);
        assert_eq!(resolve_delay_seconds(&json!({ "delaySeconds": 0 })), 0);

        // String delaySeconds
        assert_eq!(resolve_delay_seconds(&json!({ "delaySeconds": "15" })), 15);

        // Float delaySeconds
        assert_eq!(resolve_delay_seconds(&json!({ "delaySeconds": 20.0 })), 20);
    }

    #[tokio::test]
    async fn test_execute_delay_node_zero_seconds() {
        let cancel = CancelToken::new();
        let config = json!({ "delaySeconds": 0 });
        let result = execute_delay_node(&config, &cancel).await;
        let output = result.expect("Zero delay should succeed immediately");
        assert_eq!(
            output.value.get("waitedSeconds").and_then(Value::as_u64),
            Some(0)
        );
    }

    #[tokio::test]
    async fn test_execute_delay_node_cancelled() {
        let cancel = CancelToken::new();
        cancel.cancel();
        let config = json!({ "seconds": 10 });
        let result = execute_delay_node(&config, &cancel).await;
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            "backendErrors.workflow.cancelled".to_string()
        );
    }

    #[tokio::test]
    async fn test_execute_schedule_wait_dry_run() {
        let cancel = CancelToken::new();
        let config = json!({ "cronExpression": "0 2 * * *" });
        let result = execute_schedule_wait_node(&config, &cancel, true).await;
        let output = result.expect("Dry run should succeed immediately");
        assert_eq!(
            output.value.get("simulated").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            output.value.get("dryRun").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            output.value.get("waitedSeconds").and_then(Value::as_u64),
            Some(0)
        );
        assert_eq!(
            output.value.get("cronExpression").and_then(Value::as_str),
            Some("0 2 * * *")
        );
        assert!(output.value.get("targetTime").is_some());
    }

    #[tokio::test]
    async fn test_execute_schedule_wait_invalid_cron() {
        let cancel = CancelToken::new();
        let config = json!({ "cronExpression": "invalid cron syntax" });
        let result = execute_schedule_wait_node(&config, &cancel, false).await;
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .contains("backendErrors.workflow.invalidSchedule")
        );
    }

    #[tokio::test]
    async fn test_execute_schedule_wait_cancelled() {
        let cancel = CancelToken::new();
        cancel.cancel();
        let config = json!({ "cronExpression": "0 2 * * *" });
        let result = execute_schedule_wait_node(&config, &cancel, false).await;
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            "backendErrors.workflow.cancelled".to_string()
        );
    }

    #[tokio::test]
    async fn test_app_start_node_execution() {
        let cancel = CancelToken::new();

        // 1. Zero delay executes immediately
        let config_zero = json!({ "delaySeconds": 0 });
        let out = handle_app_start_node(&config_zero, &cancel, false)
            .await
            .unwrap();
        assert_eq!(out.value["autoStarted"], true);
        assert_eq!(out.value["waitedDelay"], 0);

        // 2. Dry run skips delay
        let config_delayed = json!({ "delaySeconds": 60 });
        let out_dry = handle_app_start_node(&config_delayed, &cancel, true)
            .await
            .unwrap();
        assert_eq!(out_dry.value["autoStarted"], true);
        assert_eq!(out_dry.value["waitedDelay"], 0);

        // 3. Cancelled execution returns error
        cancel.cancel();
        let err = handle_app_start_node(&config_delayed, &cancel, false)
            .await
            .unwrap_err();
        assert_eq!(err, "backendErrors.workflow.cancelled");
    }

    #[test]
    fn test_evaluate_condition_extended_operators() {
        // GTE / LTE
        assert!(evaluate_condition("greater_or_equal", "10", "10").unwrap());
        assert!(evaluate_condition("greater_or_equal", "15", "10").unwrap());
        assert!(!evaluate_condition("greater_or_equal", "5", "10").unwrap());

        assert!(evaluate_condition("less_or_equal", "10", "10").unwrap());
        assert!(evaluate_condition("less_or_equal", "5", "10").unwrap());
        assert!(!evaluate_condition("less_or_equal", "15", "10").unwrap());

        // Starts with / Ends with
        assert!(evaluate_condition("starts_with", "remote:backup/data", "remote:").unwrap());
        assert!(!evaluate_condition("starts_with", "local/data", "remote:").unwrap());
        assert!(evaluate_condition("ends_with", "file.log", ".log").unwrap());
        assert!(!evaluate_condition("ends_with", "file.txt", ".log").unwrap());

        // Array operators
        assert!(
            evaluate_condition("array_not_empty", "[\"file1.txt\", \"file2.txt\"]", "").unwrap()
        );
        assert!(!evaluate_condition("array_not_empty", "[]", "").unwrap());
        assert!(evaluate_condition("array_is_empty", "[]", "").unwrap());
        assert!(!evaluate_condition("array_is_empty", "[\"file1.txt\"]", "").unwrap());
    }

    #[tokio::test]
    async fn an_enormous_delay_stays_cancellable_instead_of_overflowing() {
        let cancelled = CancelToken::new();
        cancelled.cancel();
        let config = json!({"delaySeconds": u64::MAX});
        assert!(execute_delay_node(&config, &cancelled).await.is_err());
        assert!(
            handle_app_start_node(&config, &cancelled, false)
                .await
                .is_err()
        );
    }

    #[test]
    fn an_unknown_condition_operator_is_an_error_not_an_equality_check() {
        let error = evaluate_condition("equal", "a", "a").unwrap_err();
        assert!(error.contains("backendErrors.workflow.unknownOperator"));
        assert!(error.contains(r#""operator":"equal""#));
    }
}
