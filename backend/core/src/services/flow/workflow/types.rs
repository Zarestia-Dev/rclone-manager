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
    /// Translation key of the label; `label` is the fallback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_key: Option<String>,
    /// Values for the placeholders of `label_key`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_params: Option<serde_json::Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[cfg(test)]
impl WorkflowPort {
    /// A port with nothing but what a wire needs, for tests.
    pub(crate) fn new(id: &str, port_type: WorkflowPortType) -> Self {
        Self {
            id: id.into(),
            name: id.into(),
            port_type,
            label: None,
            label_key: None,
            label_params: None,
            description: None,
        }
    }
}

/// Execution lifecycle state for an individual node.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
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

    /// Whether the node starts a run, by its stored category or by what its type says.
    #[must_use]
    pub fn is_trigger(&self) -> bool {
        self.category == WorkflowNodeCategory::Trigger
            || self.kind().category() == WorkflowNodeCategory::Trigger
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

/// Reads a non-negative whole number from a node setting stored as an integer,
/// a float or a numeric string.
#[must_use]
pub fn config_u64(config: &Value, key: &str) -> Option<u64> {
    let value = config.get(key)?;
    value
        .as_u64()
        .or_else(|| value.as_f64().map(|float| float.max(0.0) as u64))
        .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
}

/// Helper to extract `delaySeconds` from a node's configuration object,
/// supporting numeric and string representations.
#[must_use]
pub fn parse_delay_seconds(config: &Value) -> u64 {
    config_u64(config, "delaySeconds").unwrap_or(0)
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
        !self.watcher_paths().is_empty()
    }

    /// The distinct, non-empty paths of every watcher node, from `watchPaths` or the older `watchPath`.
    #[must_use]
    pub fn watcher_paths(&self) -> Vec<String> {
        let mut result: Vec<String> = Vec::new();
        for node in self.nodes.iter().filter(|n| n.kind() == NodeKind::Watcher) {
            let configured: Vec<&str> =
                if let Some(paths) = node.config.get("watchPaths").and_then(Value::as_array) {
                    paths.iter().filter_map(Value::as_str).collect()
                } else {
                    node.config
                        .get("watchPath")
                        .and_then(Value::as_str)
                        .into_iter()
                        .collect()
                };
            for path in configured.into_iter().map(str::trim) {
                if !path.is_empty() && !result.iter().any(|known| known == path) {
                    result.push(path.to_string());
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
            .and_then(|n| config_u64(&n.config, "debounceSeconds"))
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

/// Node execution state transition of one run.
///
/// `run_id` and `seq` order the events of a run: a view that loaded a snapshot of
/// the run ignores every event the snapshot already contains.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNodeStateEvent {
    pub workflow_id: String,
    pub run_id: String,
    pub seq: u64,
    /// RFC 3339, millisecond precision.
    pub at: String,
    pub node_id: String,
    pub state: WorkflowNodeExecutionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Left out of the history a snapshot carries; the snapshot lists the latest output of each node.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
}

/// Progress details for live workflow execution.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowProgress {
    pub total: usize,
    pub completed: usize,
    pub current_step_title: String,
}

/// Where a run is. `Started` and `Running` are live; the rest end the run.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowExecutionState {
    Started,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl WorkflowExecutionState {
    #[must_use]
    pub fn is_live(self) -> bool {
        matches!(self, Self::Started | Self::Running)
    }
}

/// Workflow-level state transition of one run.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowExecutionStateEvent {
    pub workflow_id: String,
    pub run_id: String,
    pub seq: u64,
    /// RFC 3339, millisecond precision.
    pub at: String,
    pub state: WorkflowExecutionState,
    pub dry_run: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<WorkflowProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_port_keeps_its_label_key_and_params_when_stored() {
        let stored = json!({
            "id": "in3",
            "name": "In 3",
            "type": "in",
            "label": "In 3",
            "labelKey": "flow.workflow.ports.inN",
            "labelParams": { "n": 3 }
        });
        let port: WorkflowPort = serde_json::from_value(stored.clone()).unwrap();
        assert_eq!(port.label_key.as_deref(), Some("flow.workflow.ports.inN"));
        assert_eq!(serde_json::to_value(&port).unwrap(), stored);

        // Ports stored before these fields existed still load and stay as they were.
        let old = json!({ "id": "out", "name": "Out", "type": "out" });
        let port: WorkflowPort = serde_json::from_value(old.clone()).unwrap();
        assert!(port.label_key.is_none() && port.label_params.is_none());
        assert_eq!(serde_json::to_value(&port).unwrap(), old);
    }

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
            ("cron", Trigger),
            ("delay", Logic),
            ("join", Logic),
            ("schedule_wait", Logic),
            ("notification", Action),
            ("condition", Task),
            ("stop", Task),
            ("sync", Task),
            ("unheard_of", Task),
        ] {
            assert_eq!(NodeKind::parse(name).category(), category, "{name}");
        }
    }

    #[test]
    fn a_node_is_a_trigger_by_its_stored_category_or_by_its_type() {
        let node = |node_type: &str, category| WorkflowNode {
            node_type: node_type.into(),
            category,
            ..Default::default()
        };
        assert!(node("cron", WorkflowNodeCategory::Task).is_trigger());
        assert!(node("from_a_newer_version", WorkflowNodeCategory::Trigger).is_trigger());
        assert!(!node("sync", WorkflowNodeCategory::Task).is_trigger());
        assert!(!node("from_a_newer_version", WorkflowNodeCategory::Action).is_trigger());
    }
}
