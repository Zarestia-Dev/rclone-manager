//! Types and data structures for the Flow workspace Workflow feature.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::utils::types::remotes::OperationType;

/// Node category in the visual DAG.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowNodeCategory {
    Trigger,
    #[default]
    Task,
    Logic,
    Action,
}

/// What a workflow node does, decoded from its stored `type` string.
///
/// Nodes keep the string so a workflow written by a newer version survives a
/// round trip; execution works on this enum so every kind is handled explicitly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeKind {
    Manual,
    ParallelFork,
    Cron,
    Watcher,
    JobEvent,
    AppStart,
    Join,
    Delay,
    ScheduleWait,
    Condition,
    Stop,
    Notification,
    ExecScript,
    LogAudit,
    SystemPower,
    RcCommand,
    Cleanup,
    QuickRun,
    Unmount,
    StopServe,
    /// Mount, serve and every transfer operation share their name with an [`OperationType`].
    Operation(OperationType),
    /// A type this version does not know.
    Unknown,
}

impl NodeKind {
    #[must_use]
    pub fn parse(node_type: &str) -> Self {
        match node_type {
            "manual" => Self::Manual,
            "parallel_fork" => Self::ParallelFork,
            "cron" => Self::Cron,
            "watcher" => Self::Watcher,
            "job_event" => Self::JobEvent,
            "app_start" => Self::AppStart,
            "join" => Self::Join,
            "delay" => Self::Delay,
            "schedule_wait" => Self::ScheduleWait,
            "condition" => Self::Condition,
            "stop" => Self::Stop,
            "notification" => Self::Notification,
            "exec_script" => Self::ExecScript,
            "log_audit" => Self::LogAudit,
            "system_power" => Self::SystemPower,
            "rc_command" => Self::RcCommand,
            "cleanup" => Self::Cleanup,
            "quick_run" => Self::QuickRun,
            "unmount" => Self::Unmount,
            "stop_serve" => Self::StopServe,
            other => OperationType::ALL
                .iter()
                .find(|operation| operation.as_str() == other)
                .map_or(Self::Unknown, |operation| Self::Operation(*operation)),
        }
    }

    #[must_use]
    pub fn category(self) -> WorkflowNodeCategory {
        match self {
            Self::Manual | Self::AppStart | Self::Cron | Self::Watcher | Self::JobEvent => {
                WorkflowNodeCategory::Trigger
            }
            Self::Delay | Self::ScheduleWait | Self::Join => WorkflowNodeCategory::Logic,
            Self::Notification => WorkflowNodeCategory::Action,
            _ => WorkflowNodeCategory::Task,
        }
    }
}

/// Resolves the canonical category for a given node type name, including
/// names from older or planned versions that are not executable here.
#[must_use]
pub fn category_for_node_type(node_type: &str) -> WorkflowNodeCategory {
    match node_type {
        "branch" | "filter" | "merge" | "retry" | "fork" | "loop" => WorkflowNodeCategory::Logic,
        "command" | "webhook" => WorkflowNodeCategory::Action,
        other => NodeKind::parse(other).category(),
    }
}

/// Port type on a workflow node.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowPortType {
    In,
    Out,
    Success,
    Failure,
    True,
    False,
}

/// A socket/port on a node.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPort {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub port_type: WorkflowPortType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Execution lifecycle state for an individual node.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowNodeExecutionState {
    Idle,
    Queued,
    Running,
    Success,
    Failed,
    Skipped,
}

/// Result output produced by a single node execution step.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeExecutionOutput {
    pub value: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

impl NodeExecutionOutput {
    #[must_use]
    pub fn new(value: Value) -> Self {
        Self {
            value,
            branch: None,
        }
    }

    #[must_use]
    pub fn branch(value: Value, branch: impl Into<String>) -> Self {
        Self {
            value,
            branch: Some(branch.into()),
        }
    }
}

/// A node in the visual DAG.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    #[serde(default)]
    pub category: WorkflowNodeCategory,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub inputs: Vec<WorkflowPort>,
    #[serde(default)]
    pub outputs: Vec<WorkflowPort>,
    #[serde(default)]
    pub config: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<WorkflowNodeExecutionState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
}

impl WorkflowNode {
    #[must_use]
    pub fn kind(&self) -> NodeKind {
        NodeKind::parse(&self.node_type)
    }

    #[must_use]
    pub fn resolved_category(&self) -> WorkflowNodeCategory {
        category_for_node_type(&self.node_type)
    }
}

/// A directed edge connecting two ports.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowEdge {
    pub id: String,
    pub source_node_id: String,
    pub source_port_id: String,
    pub target_node_id: String,
    pub target_port_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_active: Option<bool>,
}

/// Canvas viewport pan/zoom state.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CanvasViewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

impl Default for CanvasViewport {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            zoom: 1.0,
        }
    }
}

/// A complete, persistent workflow definition.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDefinition {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub nodes: Vec<WorkflowNode>,
    #[serde(default)]
    pub edges: Vec<WorkflowEdge>,
    #[serde(default)]
    pub viewport: CanvasViewport,
    #[serde(default)]
    pub show_on_tray: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_executed_at: Option<String>,
}

/// Helper to extract `delaySeconds` from a node's configuration object,
/// supporting both numeric and string representations.
#[must_use]
pub fn parse_delay_seconds(config: &Value) -> u64 {
    config
        .get("delaySeconds")
        .and_then(Value::as_u64)
        .or_else(|| {
            config
                .get("delaySeconds")
                .and_then(Value::as_str)
                .and_then(|s| s.parse::<u64>().ok())
        })
        .unwrap_or(0)
}

impl WorkflowDefinition {
    /// Whether a finishing job can start this workflow.
    #[must_use]
    pub fn has_job_event_trigger(&self) -> bool {
        self.nodes
            .iter()
            .any(|node| node.kind() == NodeKind::JobEvent)
    }

    #[must_use]
    pub fn is_autostart(&self) -> bool {
        self.nodes.iter().any(|n| n.kind() == NodeKind::AppStart)
    }

    #[must_use]
    pub fn is_cron_enabled(&self) -> bool {
        self.effective_cron_expression().is_some()
    }

    #[must_use]
    pub fn effective_cron_expression(&self) -> Option<String> {
        self.nodes.iter().find_map(|n| {
            if n.kind() == NodeKind::Cron {
                n.config
                    .get("cronExpression")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(String::from)
            } else {
                None
            }
        })
    }

    #[must_use]
    pub fn is_watch_enabled(&self) -> bool {
        self.nodes.iter().any(|n| {
            if n.kind() != NodeKind::Watcher {
                return false;
            }
            if let Some(paths) = n.config.get("watchPaths").and_then(Value::as_array) {
                paths
                    .iter()
                    .any(|p| p.as_str().map(|s| !s.trim().is_empty()).unwrap_or(false))
            } else if let Some(path) = n.config.get("watchPath").and_then(Value::as_str) {
                !path.trim().is_empty()
            } else {
                false
            }
        })
    }

    #[must_use]
    pub fn watcher_paths(&self) -> Vec<String> {
        let mut result = Vec::new();
        for n in &self.nodes {
            if n.kind() == NodeKind::Watcher {
                if let Some(paths) = n.config.get("watchPaths").and_then(Value::as_array) {
                    for p in paths {
                        if let Some(s) = p.as_str() {
                            let trimmed = s.trim();
                            if !trimmed.is_empty() && !result.contains(&trimmed.to_string()) {
                                result.push(trimmed.to_string());
                            }
                        }
                    }
                } else if let Some(path) = n.config.get("watchPath").and_then(Value::as_str) {
                    let trimmed = path.trim();
                    if !trimmed.is_empty() && !result.contains(&trimmed.to_string()) {
                        result.push(trimmed.to_string());
                    }
                }
            }
        }
        result
    }

    #[must_use]
    pub fn watcher_debounce_seconds(&self) -> u64 {
        self.nodes
            .iter()
            .find(|n| n.kind() == NodeKind::Watcher)
            .and_then(|n| {
                n.config
                    .get("debounceSeconds")
                    .and_then(Value::as_u64)
                    .or_else(|| {
                        n.config
                            .get("debounceSeconds")
                            .and_then(Value::as_str)
                            .and_then(|s| s.parse::<u64>().ok())
                    })
            })
            .unwrap_or(5)
    }

    #[must_use]
    pub fn watcher_glob_pattern(&self) -> Option<String> {
        self.nodes.iter().find_map(|n| {
            if n.kind() == NodeKind::Watcher {
                n.config
                    .get("globPattern")
                    .and_then(Value::as_str)
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
            } else {
                None
            }
        })
    }
}

/// Input payload sent from frontend when creating or updating a workflow.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub nodes: Vec<WorkflowNode>,
    #[serde(default)]
    pub edges: Vec<WorkflowEdge>,
    #[serde(default)]
    pub viewport: CanvasViewport,
    #[serde(default)]
    pub show_on_tray: bool,
}

/// Execution result returned by `execute_workflow`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowExecutionResult {
    pub workflow_id: String,
    pub success: bool,
    pub total_nodes: usize,
    pub completed_nodes: usize,
    pub failed_nodes: usize,
    pub skipped_nodes: usize,
    pub duration_ms: u64,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Validation result returned by `validate_workflow`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowValidationResult {
    pub valid: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

/// Tauri event payload for node execution state transitions.
///
/// Borrows its fields: node outputs can be large and are already held by the run.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNodeStateEvent<'a> {
    pub workflow_id: &'a str,
    pub node_id: &'a str,
    pub state: WorkflowNodeExecutionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<&'a Value>,
}

/// Progress details for live workflow execution.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowProgress {
    pub total: usize,
    pub completed: usize,
    pub current_step_title: String,
}

/// Tauri event payload for workflow-level state updates.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowExecutionStateEvent {
    pub workflow_id: String,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<WorkflowProgress>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_workflow_definition_serde() {
        let wf = WorkflowDefinition {
            id: "wf-test-1".to_string(),
            name: "Test Workflow".to_string(),
            description: Some("Description".to_string()),
            nodes: vec![WorkflowNode {
                id: "node-1".to_string(),
                node_type: "manual".to_string(),
                category: WorkflowNodeCategory::Trigger,
                title: "Manual Trigger".to_string(),
                x: 100.0,
                y: 100.0,
                ..Default::default()
            }],
            edges: vec![],
            viewport: CanvasViewport {
                x: 0.0,
                y: 0.0,
                zoom: 1.0,
            },
            created_at: Some("2026-08-28T10:00:00Z".to_string()),
            updated_at: Some("2026-08-28T10:00:00Z".to_string()),
            ..Default::default()
        };

        let json_str = serde_json::to_string(&wf).unwrap();
        assert!(!json_str.contains("\"autoStart\""));
        assert!(!json_str.contains("\"cronExpression\""));
        assert!(!json_str.contains("\"icon\""));
        assert!(
            json_str.contains("\"nodeType\":\"manual\"")
                || json_str.contains("\"type\":\"manual\"")
        );

        let deserialized: WorkflowDefinition = serde_json::from_str(&json_str).unwrap();
        assert_eq!(deserialized, wf);
        assert!(!deserialized.is_autostart());
        assert!(!deserialized.is_cron_enabled());
        assert_eq!(deserialized.effective_cron_expression(), None);
    }

    #[test]
    fn test_workflow_input_serde() {
        let input_json = json!({
            "name": "New Workflow",
            "nodes": [],
            "edges": [],
            "viewport": { "x": 0.0, "y": 0.0, "zoom": 1.0 }
        });

        let input: WorkflowInput = serde_json::from_value(input_json).unwrap();
        assert_eq!(input.name, "New Workflow");
        assert!(input.id.is_none());
    }

    #[test]
    fn test_workflow_watcher_helpers() {
        let wf = WorkflowDefinition {
            id: "wf-watcher-1".to_string(),
            name: "Watcher Workflow".to_string(),
            nodes: vec![WorkflowNode {
                id: "node-watcher-1".to_string(),
                node_type: "watcher".to_string(),
                category: WorkflowNodeCategory::Trigger,
                title: "Folder Watcher".to_string(),
                config: json!({
                    "watchPaths": ["/tmp/watch_dir", "/tmp/watch_dir2"],
                    "globPattern": "*.pdf, !*.tmp",
                    "debounceSeconds": 10
                }),
                ..Default::default()
            }],
            ..Default::default()
        };

        assert!(wf.is_watch_enabled());
        assert_eq!(
            wf.watcher_paths(),
            vec!["/tmp/watch_dir".to_string(), "/tmp/watch_dir2".to_string()]
        );
        assert_eq!(wf.watcher_debounce_seconds(), 10);
        assert_eq!(wf.watcher_glob_pattern(), Some("*.pdf, !*.tmp".to_string()));
    }

    #[test]
    fn test_workflow_cron_from_node_helpers() {
        let wf = WorkflowDefinition {
            id: "wf-cron-1".to_string(),
            name: "Cron Workflow".to_string(),
            nodes: vec![WorkflowNode {
                id: "node-cron-1".to_string(),
                node_type: "cron".to_string(),
                category: WorkflowNodeCategory::Trigger,
                title: "Cron Schedule".to_string(),
                config: json!({
                    "cronExpression": "0 4 * * *"
                }),
                ..Default::default()
            }],
            ..Default::default()
        };

        assert!(wf.is_cron_enabled());
        assert_eq!(
            wf.effective_cron_expression(),
            Some("0 4 * * *".to_string())
        );

        let wf_whitespace = WorkflowDefinition {
            nodes: vec![WorkflowNode {
                id: "node-cron-2".to_string(),
                node_type: "cron".to_string(),
                category: WorkflowNodeCategory::Trigger,
                title: "Cron Schedule".to_string(),
                config: json!({
                    "cronExpression": "   "
                }),
                ..Default::default()
            }],
            ..wf
        };

        assert!(!wf_whitespace.is_cron_enabled());
        assert_eq!(wf_whitespace.effective_cron_expression(), None);
    }

    #[test]
    fn test_app_start_delay_helpers() {
        assert_eq!(parse_delay_seconds(&json!({})), 0);
        assert_eq!(parse_delay_seconds(&json!({ "delaySeconds": 15 })), 15);
        assert_eq!(parse_delay_seconds(&json!({ "delaySeconds": "30" })), 30);
        assert_eq!(
            parse_delay_seconds(&json!({ "delaySeconds": "invalid" })),
            0
        );

        let wf_with_app_start = WorkflowDefinition {
            id: "wf-app-start-1".to_string(),
            name: "App Start Workflow".to_string(),
            nodes: vec![WorkflowNode {
                id: "node-start-1".to_string(),
                node_type: "app_start".to_string(),
                category: WorkflowNodeCategory::Trigger,
                title: "On App Launch".to_string(),
                config: json!({
                    "delaySeconds": 10
                }),
                ..Default::default()
            }],
            ..Default::default()
        };

        assert!(wf_with_app_start.is_autostart());
    }

    #[test]
    fn test_category_for_node_type_helper() {
        assert_eq!(
            category_for_node_type("manual"),
            WorkflowNodeCategory::Trigger
        );
        assert_eq!(
            category_for_node_type("cron"),
            WorkflowNodeCategory::Trigger
        );
        assert_eq!(category_for_node_type("sync"), WorkflowNodeCategory::Task);
        assert_eq!(
            category_for_node_type("branch"),
            WorkflowNodeCategory::Logic
        );
        assert_eq!(
            category_for_node_type("schedule_wait"),
            WorkflowNodeCategory::Logic
        );
        assert_eq!(
            category_for_node_type("notification"),
            WorkflowNodeCategory::Action
        );
    }

    #[test]
    fn node_kinds_cover_every_executable_type_and_leave_the_rest_unknown() {
        for (name, kind) in [
            ("manual", NodeKind::Manual),
            ("parallel_fork", NodeKind::ParallelFork),
            ("job_event", NodeKind::JobEvent),
            ("schedule_wait", NodeKind::ScheduleWait),
            ("exec_script", NodeKind::ExecScript),
            ("stop_serve", NodeKind::StopServe),
            ("mount", NodeKind::Operation(OperationType::Mount)),
            ("serve", NodeKind::Operation(OperationType::Serve)),
            ("cryptcheck", NodeKind::Operation(OperationType::Cryptcheck)),
            ("webhook", NodeKind::Unknown),
            ("", NodeKind::Unknown),
            ("Sync", NodeKind::Unknown),
        ] {
            assert_eq!(NodeKind::parse(name), kind, "{name}");
        }
        for operation in OperationType::ALL {
            assert_eq!(
                NodeKind::parse(operation.as_str()),
                NodeKind::Operation(*operation)
            );
        }
    }

    #[test]
    fn categories_keep_their_established_mapping() {
        use WorkflowNodeCategory::{Action, Logic, Task, Trigger};
        for (name, category) in [
            ("manual", Trigger),
            ("job_event", Trigger),
            ("delay", Logic),
            ("join", Logic),
            ("loop", Logic),
            ("notification", Action),
            ("webhook", Action),
            ("condition", Task),
            ("stop", Task),
            ("sync", Task),
            ("unheard_of", Task),
        ] {
            assert_eq!(category_for_node_type(name), category, "{name}");
        }
    }
}
