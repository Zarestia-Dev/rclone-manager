//! Per-run node/edge state and the edge activation rules.

use std::collections::{HashMap, VecDeque};

use serde_json::Value;

use crate::services::flow::workflow::types::{
    NodeExecutionOutput, NodeKind, WorkflowDefinition, WorkflowEdge, WorkflowNode,
    WorkflowNodeCategory, WorkflowNodeExecutionState, WorkflowNodeStateEvent, WorkflowPortType,
};
use crate::utils::types::events::WORKFLOW_NODE_STATE_CHANGED;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EdgeState {
    Pending,
    Activated,
    Disabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NodeStatus {
    Pending,
    Queued,
    Running,
    Succeeded,
    Failed,
    Skipped,
}

pub(crate) struct NodeFinishedEvent {
    pub(crate) node_idx: usize,
    pub(crate) outcome: Result<NodeExecutionOutput, String>,
    pub(crate) duration_ms: u64,
}

/// Node and edge lookups built once per run. Nodes and edges are addressed by
/// index so scheduling never clones or searches them.
pub(crate) struct RunGraph {
    /// Edge indices entering each node.
    incoming: Vec<Vec<usize>>,
    /// The edges leaving each node, as `(edge index, target node index)`.
    outgoing: Vec<Vec<(usize, usize)>>,
}

impl RunGraph {
    pub(crate) fn new(workflow: &WorkflowDefinition) -> Self {
        let index: HashMap<&str, usize> = workflow
            .nodes
            .iter()
            .enumerate()
            .map(|(idx, node)| (node.id.as_str(), idx))
            .collect();
        let mut incoming = vec![Vec::new(); workflow.nodes.len()];
        let mut outgoing = vec![Vec::new(); workflow.nodes.len()];
        // Validation rejects edges whose endpoints do not exist.
        for (edge_idx, edge) in workflow.edges.iter().enumerate() {
            if let (Some(&source), Some(&target)) = (
                index.get(edge.source_node_id.as_str()),
                index.get(edge.target_node_id.as_str()),
            ) {
                outgoing[source].push((edge_idx, target));
                incoming[target].push(edge_idx);
            }
        }
        Self { incoming, outgoing }
    }
}

/// What every node and edge of one run has resolved to so far, and which nodes may start.
pub(crate) struct RunState {
    nodes: Vec<NodeStatus>,
    edges: Vec<EdgeState>,
    ready: VecDeque<usize>,
    pub(crate) completed: usize,
    pub(crate) failed: usize,
    pub(crate) skipped: usize,
}

impl RunState {
    /// Triggers and nodes without inputs are ready from the start.
    pub(crate) fn new(graph: &RunGraph, workflow: &WorkflowDefinition) -> Self {
        let mut state = Self {
            nodes: vec![NodeStatus::Pending; workflow.nodes.len()],
            edges: vec![EdgeState::Pending; workflow.edges.len()],
            ready: VecDeque::new(),
            completed: 0,
            failed: 0,
            skipped: 0,
        };
        for (idx, node) in workflow.nodes.iter().enumerate() {
            if node.category == WorkflowNodeCategory::Trigger
                || node.resolved_category() == WorkflowNodeCategory::Trigger
                || graph.incoming[idx].is_empty()
            {
                state.queue(idx);
            }
        }
        state
    }

    fn queue(&mut self, idx: usize) {
        self.nodes[idx] = NodeStatus::Queued;
        self.ready.push_back(idx);
    }

    /// Takes the next node that may start and marks it running.
    pub(crate) fn start_next(&mut self) -> Option<usize> {
        let idx = self.ready.pop_front()?;
        self.nodes[idx] = NodeStatus::Running;
        Some(idx)
    }

    /// Nodes still waiting to start will not run.
    pub(crate) fn stop_scheduling(&mut self) {
        self.ready.clear();
    }

    /// Decides which outgoing edges of a finished node fire.
    pub(crate) fn activate_edges(
        &mut self,
        graph: &RunGraph,
        workflow: &WorkflowDefinition,
        idx: usize,
        outcome: &Result<NodeExecutionOutput, String>,
    ) {
        let node = &workflow.nodes[idx];
        for &(edge_idx, _) in &graph.outgoing[idx] {
            self.edges[edge_idx] = edge_activation(node, outcome, &workflow.edges[edge_idx]);
        }
    }

    pub(crate) fn succeeded(&mut self, idx: usize) {
        self.completed += 1;
        self.nodes[idx] = NodeStatus::Succeeded;
    }

    /// A node cut short because the run was cancelled is not a failure of the workflow.
    pub(crate) fn failed(&mut self, idx: usize, counts_as_failure: bool) {
        if counts_as_failure {
            self.failed += 1;
        }
        self.nodes[idx] = NodeStatus::Failed;
    }

    /// Queues the nodes downstream of `finished` whose inputs have all resolved, and
    /// skips those that no fired edge reaches (and everything only they lead to).
    pub(crate) fn queue_downstream(
        &mut self,
        graph: &RunGraph,
        workflow: &WorkflowDefinition,
        workflow_id: &str,
        finished: usize,
    ) {
        let mut pending: VecDeque<usize> = graph.outgoing[finished]
            .iter()
            .map(|&(_, target)| target)
            .collect();

        while let Some(candidate) = pending.pop_front() {
            if self.nodes[candidate] != NodeStatus::Pending {
                continue;
            }
            let incoming = &graph.incoming[candidate];
            if incoming
                .iter()
                .any(|&edge_idx| self.edges[edge_idx] == EdgeState::Pending)
            {
                continue;
            }

            let candidate_node = &workflow.nodes[candidate];
            let reached = incoming
                .iter()
                .any(|&edge_idx| self.edges[edge_idx] == EdgeState::Activated);
            let joins_always = candidate_node.kind() == NodeKind::Join
                && candidate_node
                    .config
                    .get("joinMode")
                    .and_then(Value::as_str)
                    == Some("always");

            if reached || joins_always {
                self.queue(candidate);
            } else {
                self.skip(workflow_id, candidate, candidate_node);
                for &(edge_idx, target) in &graph.outgoing[candidate] {
                    self.edges[edge_idx] = EdgeState::Disabled;
                    pending.push_back(target);
                }
            }
        }
    }

    /// Marks everything that never started as skipped, once the run is over.
    pub(crate) fn skip_unreached(&mut self, workflow: &WorkflowDefinition, workflow_id: &str) {
        for idx in 0..self.nodes.len() {
            if matches!(self.nodes[idx], NodeStatus::Pending | NodeStatus::Queued) {
                self.skip(workflow_id, idx, &workflow.nodes[idx]);
            }
        }
    }

    fn skip(&mut self, workflow_id: &str, idx: usize, node: &WorkflowNode) {
        self.skipped += 1;
        self.nodes[idx] = NodeStatus::Skipped;
        emit_node_state(
            workflow_id,
            &node.id,
            WorkflowNodeExecutionState::Skipped,
            None,
            Some(0),
            None,
        );
    }
}

/// Decides whether one outgoing edge fires, from the node outcome and the edge's port type.
fn edge_activation(
    node: &WorkflowNode,
    outcome: &Result<NodeExecutionOutput, String>,
    edge: &WorkflowEdge,
) -> EdgeState {
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
                } else if branch == "failure" {
                    matches!(port_type, Some(WorkflowPortType::Failure))
                        || port
                            .map(|p| p.id == "failure" || p.name == "failure")
                            .unwrap_or(false)
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
        EdgeState::Activated
    } else {
        EdgeState::Disabled
    }
}

pub(crate) fn emit_node_state(
    workflow_id: &str,
    node_id: &str,
    state: WorkflowNodeExecutionState,
    error_message: Option<&str>,
    duration_ms: Option<u64>,
    output: Option<&Value>,
) {
    crate::services::bridge::emit(
        WORKFLOW_NODE_STATE_CHANGED,
        WorkflowNodeStateEvent {
            workflow_id,
            node_id,
            state,
            error_message,
            duration_ms,
            output,
        },
    );
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::json;

    use super::*;

    use crate::services::flow::workflow::types::*;

    /// Mirrors the old edge-by-edge activation for focused tests.
    fn activate_outgoing_edges(
        node: &WorkflowNode,
        outcome: &Result<NodeExecutionOutput, String>,
        edges: &[WorkflowEdge],
        states: &mut HashMap<String, EdgeState>,
    ) {
        for edge in edges.iter().filter(|e| e.source_node_id == node.id) {
            states.insert(edge.id.clone(), edge_activation(node, outcome, edge));
        }
    }

    #[test]
    fn test_activate_outgoing_edges_branching() {
        let node = WorkflowNode {
            id: "node-1".to_string(),
            node_type: "condition".to_string(),
            category: WorkflowNodeCategory::Logic,
            title: "Check Condition".to_string(),
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
            ..Default::default()
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
            ..Default::default()
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

        // Also verify that Ok with branch: failure activates failure port by port_type
        let mut states_branch_fail = HashMap::new();
        let branch_fail_outcome = Ok(NodeExecutionOutput {
            value: json!({"success": false}),
            branch: Some("failure".to_string()),
        });
        activate_outgoing_edges(
            &task_node,
            &branch_fail_outcome,
            &task_edges,
            &mut states_branch_fail,
        );
        assert_eq!(states_branch_fail.get("te-ok"), Some(&EdgeState::Disabled));
        assert_eq!(
            states_branch_fail.get("te-fail"),
            Some(&EdgeState::Activated)
        );
    }

    #[test]
    fn test_parallel_fork_dynamic_branches_activation() {
        let fork_node = WorkflowNode {
            id: "node-fork".to_string(),
            node_type: "parallel_fork".to_string(),
            category: WorkflowNodeCategory::Logic,
            title: "Parallel Split".to_string(),
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
            ..Default::default()
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

    fn port(id: &str, port_type: WorkflowPortType) -> WorkflowPort {
        WorkflowPort {
            id: id.into(),
            name: id.into(),
            port_type,
            label: None,
            description: None,
        }
    }

    fn node(id: &str, node_type: &str, outputs: Vec<WorkflowPort>) -> WorkflowNode {
        WorkflowNode {
            id: id.into(),
            node_type: node_type.into(),
            outputs,
            ..Default::default()
        }
    }

    fn edge(id: &str, from: &str, port_id: &str, to: &str) -> WorkflowEdge {
        WorkflowEdge {
            id: id.into(),
            source_node_id: from.into(),
            source_port_id: port_id.into(),
            target_node_id: to.into(),
            target_port_id: "in".into(),
            is_active: None,
        }
    }

    fn ok(branch: Option<&str>) -> Result<NodeExecutionOutput, String> {
        Ok(match branch {
            Some(branch) => NodeExecutionOutput::branch(json!({}), branch),
            None => NodeExecutionOutput::new(json!({})),
        })
    }

    #[test]
    fn a_diamond_starts_with_its_trigger_and_joins_only_when_both_branches_resolved() {
        let workflow = WorkflowDefinition {
            nodes: vec![
                node("a", "manual", vec![]),
                node("b", "log_audit", vec![]),
                node("c", "log_audit", vec![]),
                node("d", "log_audit", vec![]),
            ],
            edges: vec![
                edge("ab", "a", "out", "b"),
                edge("ac", "a", "out", "c"),
                edge("bd", "b", "out", "d"),
                edge("cd", "c", "out", "d"),
            ],
            ..Default::default()
        };
        let graph = RunGraph::new(&workflow);
        let mut state = RunState::new(&graph, &workflow);

        assert_eq!(state.start_next(), Some(0));
        assert_eq!(state.start_next(), None);

        state.activate_edges(&graph, &workflow, 0, &ok(None));
        state.succeeded(0);
        state.queue_downstream(&graph, &workflow, "wf", 0);
        assert_eq!(state.start_next(), Some(1));
        assert_eq!(state.start_next(), Some(2));

        state.activate_edges(&graph, &workflow, 1, &ok(None));
        state.succeeded(1);
        state.queue_downstream(&graph, &workflow, "wf", 1);
        assert_eq!(state.start_next(), None, "d still waits for c");

        state.activate_edges(&graph, &workflow, 2, &ok(None));
        state.succeeded(2);
        state.queue_downstream(&graph, &workflow, "wf", 2);
        assert_eq!(state.start_next(), Some(3));
        assert_eq!((state.completed, state.failed, state.skipped), (3, 0, 0));
    }

    #[test]
    fn a_branch_not_taken_skips_what_only_it_leads_to_unless_a_join_always_runs() {
        let mut join = node("join", "join", vec![]);
        join.config = json!({"joinMode": "always"});
        let workflow = WorkflowDefinition {
            nodes: vec![
                node(
                    "if",
                    "condition",
                    vec![
                        port("true", WorkflowPortType::True),
                        port("false", WorkflowPortType::False),
                    ],
                ),
                node("yes", "log_audit", vec![]),
                node("no", "log_audit", vec![]),
                node("after-no", "log_audit", vec![]),
                join,
            ],
            edges: vec![
                edge("e1", "if", "true", "yes"),
                edge("e2", "if", "false", "no"),
                edge("e3", "no", "out", "after-no"),
                edge("e4", "after-no", "out", "join"),
            ],
            ..Default::default()
        };
        let graph = RunGraph::new(&workflow);
        let mut state = RunState::new(&graph, &workflow);
        assert_eq!(state.start_next(), Some(0));

        state.activate_edges(&graph, &workflow, 0, &ok(Some("true")));
        state.succeeded(0);
        state.queue_downstream(&graph, &workflow, "wf", 0);

        assert_eq!(state.start_next(), Some(1), "the taken branch runs");
        assert_eq!(
            state.start_next(),
            Some(4),
            "an always-join runs regardless"
        );
        assert_eq!(state.start_next(), None);
        // `no` and `after-no` were reached only through the branch that was not taken.
        assert_eq!(state.skipped, 2);
    }

    #[test]
    fn nodes_that_never_started_are_skipped_when_the_run_ends() {
        let workflow = WorkflowDefinition {
            nodes: vec![node("a", "manual", vec![]), node("b", "log_audit", vec![])],
            edges: vec![edge("ab", "a", "out", "b")],
            ..Default::default()
        };
        let graph = RunGraph::new(&workflow);
        let mut state = RunState::new(&graph, &workflow);
        state.start_next();
        state.failed(0, false);
        state.skip_unreached(&workflow, "wf");
        assert_eq!((state.completed, state.failed, state.skipped), (0, 0, 1));
    }
}
