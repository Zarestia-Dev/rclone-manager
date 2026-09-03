//! Types and data structures for the Flow workspace Workflow feature.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Node category in the visual DAG.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowNodeCategory {
    Trigger,
    Task,
    Logic,
    Action,
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub category: WorkflowNodeCategory,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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
    pub auto_start: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron_expression: Option<String>,
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
    #[must_use]
    pub fn is_autostart(&self) -> bool {
        self.auto_start || self.nodes.iter().any(|n| n.node_type == "app_start")
    }

    #[must_use]
    pub fn app_start_delay_seconds(&self) -> u64 {
        self.nodes
            .iter()
            .find(|n| n.node_type == "app_start")
            .map(|n| parse_delay_seconds(&n.config))
            .unwrap_or(0)
    }

    #[must_use]
    pub fn is_cron_enabled(&self) -> bool {
        self.cron_expression
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
            || self.nodes.iter().any(|n| {
                n.node_type == "cron"
                    && n.config
                        .get("cronExpression")
                        .and_then(Value::as_str)
                        .map(|s| !s.trim().is_empty())
                        .unwrap_or(false)
            })
    }

    #[must_use]
    pub fn effective_cron_expression(&self) -> Option<String> {
        if let Some(ref cron) = self.cron_expression
            && !cron.trim().is_empty()
        {
            return Some(cron.trim().to_string());
        }

        self.nodes.iter().find_map(|n| {
            if n.node_type == "cron" {
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
            if n.node_type != "watcher" {
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
            if n.node_type == "watcher" {
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
            .find(|n| n.node_type == "watcher")
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
            if n.node_type == "watcher" {
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
    pub auto_start: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron_expression: Option<String>,
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNodeStateEvent {
    pub workflow_id: String,
    pub node_id: String,
    pub state: WorkflowNodeExecutionState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
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
    fn test_workflow_definition_serde_roundtrip() {
        let wf = WorkflowDefinition {
            id: "wf-123".to_string(),
            name: "Test Workflow".to_string(),
            description: Some("Description".to_string()),
            nodes: vec![WorkflowNode {
                id: "n1".to_string(),
                node_type: "manual".to_string(),
                category: WorkflowNodeCategory::Trigger,
                title: "Manual Trigger".to_string(),
                subtitle: Some("Click to run".to_string()),
                icon: Some("play".to_string()),
                x: 100.0,
                y: 150.0,
                inputs: vec![],
                outputs: vec![WorkflowPort {
                    id: "out".to_string(),
                    name: "Out".to_string(),
                    port_type: WorkflowPortType::Out,
                    label: Some("Start".to_string()),
                    description: None,
                }],
                config: json!({"key": "val"}),
                state: Some(WorkflowNodeExecutionState::Idle),
                error_message: None,
                last_duration_ms: None,
                started_at: None,
                finished_at: None,
            }],
            edges: vec![],
            viewport: CanvasViewport {
                x: 0.0,
                y: 0.0,
                zoom: 1.0,
            },
            auto_start: true,
            cron_expression: Some("0 2 * * *".to_string()),
            created_at: Some("2026-08-28T10:00:00Z".to_string()),
            updated_at: Some("2026-08-28T10:00:00Z".to_string()),
            last_executed_at: None,
        };

        let json_str = serde_json::to_string(&wf).unwrap();
        assert!(json_str.contains("\"autoStart\":true"));
        assert!(json_str.contains("\"cronExpression\":\"0 2 * * *\""));
        assert!(
            json_str.contains("\"nodeType\":\"manual\"")
                || json_str.contains("\"type\":\"manual\"")
        );

        let deserialized: WorkflowDefinition = serde_json::from_str(&json_str).unwrap();
        assert_eq!(deserialized, wf);
        assert!(deserialized.is_autostart());
        assert!(deserialized.is_cron_enabled());
        assert_eq!(
            deserialized.effective_cron_expression(),
            Some("0 2 * * *".to_string())
        );
    }

    #[test]
    fn test_workflow_input_serde() {
        let input_json = json!({
            "name": "New Workflow",
            "nodes": [],
            "edges": [],
            "viewport": { "x": 0.0, "y": 0.0, "zoom": 1.0 },
            "autoStart": false
        });

        let input: WorkflowInput = serde_json::from_value(input_json).unwrap();
        assert_eq!(input.name, "New Workflow");
        assert!(input.id.is_none());
        assert!(!input.auto_start);
    }

    #[test]
    fn test_workflow_watcher_helpers() {
        let wf = WorkflowDefinition {
            id: "wf-watcher-1".to_string(),
            name: "Watcher Workflow".to_string(),
            description: None,
            nodes: vec![WorkflowNode {
                id: "node-watcher-1".to_string(),
                node_type: "watcher".to_string(),
                category: WorkflowNodeCategory::Trigger,
                title: "Folder Watcher".to_string(),
                subtitle: None,
                icon: None,
                x: 0.0,
                y: 0.0,
                inputs: vec![],
                outputs: vec![],
                config: json!({
                    "watchPaths": ["/tmp/watch_dir", "/tmp/watch_dir2"],
                    "globPattern": "*.pdf, !*.tmp",
                    "debounceSeconds": 10
                }),
                state: None,
                error_message: None,
                last_duration_ms: None,
                started_at: None,
                finished_at: None,
            }],
            edges: vec![],
            viewport: CanvasViewport::default(),
            auto_start: false,
            cron_expression: None,
            created_at: None,
            updated_at: None,
            last_executed_at: None,
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
            description: None,
            nodes: vec![WorkflowNode {
                id: "node-cron-1".to_string(),
                node_type: "cron".to_string(),
                category: WorkflowNodeCategory::Trigger,
                title: "Cron Schedule".to_string(),
                subtitle: None,
                icon: None,
                x: 0.0,
                y: 0.0,
                inputs: vec![],
                outputs: vec![],
                config: json!({
                    "cronExpression": "0 4 * * *"
                }),
                state: None,
                error_message: None,
                last_duration_ms: None,
                started_at: None,
                finished_at: None,
            }],
            edges: vec![],
            viewport: CanvasViewport::default(),
            auto_start: false,
            cron_expression: None,
            created_at: None,
            updated_at: None,
            last_executed_at: None,
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
                subtitle: None,
                icon: None,
                x: 0.0,
                y: 0.0,
                inputs: vec![],
                outputs: vec![],
                config: json!({
                    "cronExpression": "   "
                }),
                state: None,
                error_message: None,
                last_duration_ms: None,
                started_at: None,
                finished_at: None,
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
            description: None,
            nodes: vec![WorkflowNode {
                id: "node-start-1".to_string(),
                node_type: "app_start".to_string(),
                category: WorkflowNodeCategory::Trigger,
                title: "On App Launch".to_string(),
                subtitle: None,
                icon: None,
                x: 0.0,
                y: 0.0,
                inputs: vec![],
                outputs: vec![],
                config: json!({
                    "delaySeconds": 10
                }),
                state: None,
                error_message: None,
                last_duration_ms: None,
                started_at: None,
                finished_at: None,
            }],
            edges: vec![],
            viewport: CanvasViewport::default(),
            auto_start: false,
            cron_expression: None,
            created_at: None,
            updated_at: None,
            last_executed_at: None,
        };

        assert!(wf_with_app_start.is_autostart());
        assert_eq!(wf_with_app_start.app_start_delay_seconds(), 10);
    }
}
