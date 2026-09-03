//! DAG (Directed Acyclic Graph) validation and cycle detection.

use std::collections::{HashMap, HashSet, VecDeque};

use super::types::{
    WorkflowDefinition, WorkflowEdge, WorkflowNode, WorkflowNodeCategory, WorkflowValidationResult,
};

/// Detects whether the graph formed by `nodes` and `edges` contains cycles.
/// Uses Kahn's algorithm (indegree reduction).
#[must_use]
pub fn has_cycles(nodes: &[WorkflowNode], edges: &[WorkflowEdge]) -> bool {
    if nodes.is_empty() {
        return false;
    }

    let node_ids: HashSet<&str> = nodes.iter().map(|n| n.id.as_str()).collect();

    // Calculate in-degree for each node
    let mut in_degree: HashMap<&str, usize> = HashMap::with_capacity(nodes.len());
    let mut adjacency: HashMap<&str, Vec<&str>> = HashMap::with_capacity(nodes.len());

    for node in nodes {
        in_degree.insert(node.id.as_str(), 0);
        adjacency.insert(node.id.as_str(), Vec::new());
    }

    for edge in edges {
        let src = edge.source_node_id.as_str();
        let tgt = edge.target_node_id.as_str();

        // Self loop is immediate cycle
        if src == tgt {
            return true;
        }

        if node_ids.contains(src) && node_ids.contains(tgt) {
            if let Some(entry) = in_degree.get_mut(tgt) {
                *entry += 1;
            }
            if let Some(entry) = adjacency.get_mut(src) {
                entry.push(tgt);
            }
        }
    }

    let mut queue: VecDeque<&str> = VecDeque::new();
    for (&node_id, &deg) in &in_degree {
        if deg == 0 {
            queue.push_back(node_id);
        }
    }

    let mut visited_count = 0;
    while let Some(node_id) = queue.pop_front() {
        visited_count += 1;

        if let Some(neighbors) = adjacency.get(node_id) {
            for &neighbor in neighbors {
                if let Some(deg) = in_degree.get_mut(neighbor) {
                    *deg -= 1;
                    if *deg == 0 {
                        queue.push_back(neighbor);
                    }
                }
            }
        }
    }

    visited_count < nodes.len()
}

/// Performs a comprehensive structural validation of a workflow graph.
#[must_use]
pub fn validate_workflow(workflow: &WorkflowDefinition) -> WorkflowValidationResult {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    if workflow.nodes.is_empty() {
        errors.push("Workflow must have at least one node".to_string());
        return WorkflowValidationResult {
            valid: false,
            errors,
            warnings,
        };
    }

    let node_ids: HashSet<&str> = workflow.nodes.iter().map(|n| n.id.as_str()).collect();

    // Check unique node IDs
    if node_ids.len() < workflow.nodes.len() {
        errors.push("Workflow contains duplicate node IDs".to_string());
    }

    // Check trigger node existence
    let has_trigger = workflow
        .nodes
        .iter()
        .any(|n| n.category == WorkflowNodeCategory::Trigger);
    if !has_trigger {
        warnings.push("Workflow has no trigger node (can only be run manually)".to_string());
    }

    // Validate edge references
    for edge in &workflow.edges {
        if !node_ids.contains(edge.source_node_id.as_str()) {
            errors.push(format!(
                "Edge references non-existent source node: {}",
                edge.source_node_id
            ));
        }
        if !node_ids.contains(edge.target_node_id.as_str()) {
            errors.push(format!(
                "Edge references non-existent target node: {}",
                edge.target_node_id
            ));
        }
        if edge.source_node_id == edge.target_node_id {
            errors.push(format!(
                "Node cannot connect to itself (self-loop): {}",
                edge.source_node_id
            ));
        }
    }

    // Check for cycles
    if has_cycles(&workflow.nodes, &workflow.edges) {
        errors.push("Graph contains cyclic dependencies (workflows must be DAGs)".to_string());
    }

    // Check for disconnected task nodes
    if workflow.nodes.len() > 1 {
        let connected_nodes: HashSet<&str> = workflow
            .edges
            .iter()
            .flat_map(|e| [e.source_node_id.as_str(), e.target_node_id.as_str()])
            .collect();

        for node in &workflow.nodes {
            if !connected_nodes.contains(node.id.as_str()) {
                warnings.push(format!(
                    "Node '{}' is disconnected from the workflow",
                    node.title
                ));
            }
        }
    }

    let valid = errors.is_empty();
    WorkflowValidationResult {
        valid,
        errors,
        warnings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::flow::workflow::types::*;
    use serde_json::json;

    fn create_test_node(id: &str, title: &str, category: WorkflowNodeCategory) -> WorkflowNode {
        WorkflowNode {
            id: id.to_string(),
            node_type: match category {
                WorkflowNodeCategory::Trigger => "manual".to_string(),
                WorkflowNodeCategory::Task => "sync".to_string(),
                WorkflowNodeCategory::Logic => "condition".to_string(),
                WorkflowNodeCategory::Action => "notification".to_string(),
            },
            category,
            title: title.to_string(),
            subtitle: None,
            icon: None,
            x: 0.0,
            y: 0.0,
            inputs: vec![],
            outputs: vec![],
            config: json!({}),
            state: None,
            error_message: None,
            last_duration_ms: None,
            started_at: None,
            finished_at: None,
        }
    }

    fn create_test_edge(src: &str, tgt: &str) -> WorkflowEdge {
        WorkflowEdge {
            id: format!("e-{src}-{tgt}"),
            source_node_id: src.to_string(),
            source_port_id: "out".to_string(),
            target_node_id: tgt.to_string(),
            target_port_id: "in".to_string(),
            is_active: None,
        }
    }

    #[test]
    fn test_empty_graph() {
        assert!(!has_cycles(&[], &[]));
    }

    #[test]
    fn test_single_node() {
        let nodes = vec![create_test_node(
            "n1",
            "Trigger",
            WorkflowNodeCategory::Trigger,
        )];
        assert!(!has_cycles(&nodes, &[]));
    }

    #[test]
    fn test_linear_chain() {
        let nodes = vec![
            create_test_node("n1", "Trigger", WorkflowNodeCategory::Trigger),
            create_test_node("n2", "Sync", WorkflowNodeCategory::Task),
            create_test_node("n3", "Notify", WorkflowNodeCategory::Action),
        ];
        let edges = vec![create_test_edge("n1", "n2"), create_test_edge("n2", "n3")];

        assert!(!has_cycles(&nodes, &edges));
    }

    #[test]
    fn test_diamond_dag() {
        // n1 -> n2, n1 -> n3, n2 -> n4, n3 -> n4
        let nodes = vec![
            create_test_node("n1", "Start", WorkflowNodeCategory::Trigger),
            create_test_node("n2", "Task A", WorkflowNodeCategory::Task),
            create_test_node("n3", "Task B", WorkflowNodeCategory::Task),
            create_test_node("n4", "Join", WorkflowNodeCategory::Action),
        ];
        let edges = vec![
            create_test_edge("n1", "n2"),
            create_test_edge("n1", "n3"),
            create_test_edge("n2", "n4"),
            create_test_edge("n3", "n4"),
        ];

        assert!(!has_cycles(&nodes, &edges));
    }

    #[test]
    fn test_cycle_detection() {
        // n1 -> n2 -> n3 -> n1
        let nodes = vec![
            create_test_node("n1", "A", WorkflowNodeCategory::Task),
            create_test_node("n2", "B", WorkflowNodeCategory::Task),
            create_test_node("n3", "C", WorkflowNodeCategory::Task),
        ];
        let edges = vec![
            create_test_edge("n1", "n2"),
            create_test_edge("n2", "n3"),
            create_test_edge("n3", "n1"),
        ];

        assert!(has_cycles(&nodes, &edges));
    }

    #[test]
    fn test_self_loop() {
        let nodes = vec![create_test_node(
            "n1",
            "Self Loop",
            WorkflowNodeCategory::Task,
        )];
        let edges = vec![create_test_edge("n1", "n1")];

        assert!(has_cycles(&nodes, &edges));
    }

    #[test]
    fn test_validate_workflow() {
        let wf = WorkflowDefinition {
            id: "wf-val".to_string(),
            name: "Valid DAG".to_string(),
            description: None,
            nodes: vec![
                create_test_node("n1", "Trigger", WorkflowNodeCategory::Trigger),
                create_test_node("n2", "Task", WorkflowNodeCategory::Task),
            ],
            edges: vec![create_test_edge("n1", "n2")],
            viewport: CanvasViewport::default(),
            auto_start: false,
            cron_expression: None,
            created_at: None,
            updated_at: None,
            last_executed_at: None,
        };

        let result = validate_workflow(&wf);
        assert!(result.valid);
        assert!(result.errors.is_empty());
    }

    #[test]
    fn test_validate_workflow_with_cycle() {
        let wf = WorkflowDefinition {
            id: "wf-cyclic".to_string(),
            name: "Cyclic DAG".to_string(),
            description: None,
            nodes: vec![
                create_test_node("n1", "A", WorkflowNodeCategory::Task),
                create_test_node("n2", "B", WorkflowNodeCategory::Task),
            ],
            edges: vec![create_test_edge("n1", "n2"), create_test_edge("n2", "n1")],
            viewport: CanvasViewport::default(),
            auto_start: false,
            cron_expression: None,
            created_at: None,
            updated_at: None,
            last_executed_at: None,
        };

        let result = validate_workflow(&wf);
        assert!(!result.valid);
        assert!(
            result
                .errors
                .iter()
                .any(|e| e.contains("cyclic dependencies"))
        );
    }
}
