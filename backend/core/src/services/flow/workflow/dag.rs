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

        if in_degree.contains_key(src) && in_degree.contains_key(tgt) {
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
        errors.push(crate::localized_error!(
            "backendErrors.workflow.validationNoNodes"
        ));
        return WorkflowValidationResult {
            valid: false,
            errors,
            warnings,
        };
    }

    let node_ids: HashSet<&str> = workflow.nodes.iter().map(|n| n.id.as_str()).collect();

    // Check unique node IDs
    if node_ids.len() < workflow.nodes.len() {
        errors.push(crate::localized_error!(
            "backendErrors.workflow.validationDuplicateIds"
        ));
    }

    // Check trigger node existence
    let has_trigger = workflow.nodes.iter().any(|n| {
        n.category == WorkflowNodeCategory::Trigger
            || n.resolved_category() == WorkflowNodeCategory::Trigger
    });
    if !has_trigger {
        warnings.push(crate::localized_error!(
            "backendErrors.workflow.validationNoTrigger"
        ));
    }

    // Validate edge references
    for edge in &workflow.edges {
        if !node_ids.contains(edge.source_node_id.as_str()) {
            errors.push(crate::localized_error!(
                "backendErrors.workflow.validationMissingSource",
                "id" => edge.source_node_id
            ));
        }
        if !node_ids.contains(edge.target_node_id.as_str()) {
            errors.push(crate::localized_error!(
                "backendErrors.workflow.validationMissingTarget",
                "id" => edge.target_node_id
            ));
        }
        if edge.source_node_id == edge.target_node_id {
            errors.push(crate::localized_error!(
                "backendErrors.workflow.validationSelfLoop",
                "id" => edge.source_node_id
            ));
        }
    }

    // Check for cycles
    if has_cycles(&workflow.nodes, &workflow.edges) {
        errors.push(crate::localized_error!(
            "backendErrors.workflow.validationCycle"
        ));
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
                warnings.push(crate::localized_error!(
                    "backendErrors.workflow.validationDisconnected",
                    "title" => node.title
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
    use crate::services::flow::workflow::types::*;

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
            ..Default::default()
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
    fn cycle_detection_ignores_edges_to_missing_nodes() {
        let nodes = vec![
            create_test_node("n1", "Start", WorkflowNodeCategory::Trigger),
            create_test_node("n2", "Task", WorkflowNodeCategory::Task),
        ];
        let mut edges = vec![
            create_test_edge("n1", "missing"),
            create_test_edge("missing", "n1"),
            create_test_edge("n2", "n1"),
        ];
        assert!(!has_cycles(&nodes, &edges));
        edges.push(create_test_edge("n1", "n2"));
        assert!(has_cycles(&nodes, &edges));
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
            show_on_tray: false,
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
            show_on_tray: false,
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
                .any(|e| e.contains("backendErrors.workflow.validationCycle"))
        );
    }

    #[test]
    fn validation_messages_name_the_offending_nodes() {
        let node = |id: &str, title: &str| WorkflowNode {
            id: id.into(),
            title: title.into(),
            ..Default::default()
        };
        let edge = |id: &str, from: &str, to: &str| WorkflowEdge {
            id: id.into(),
            source_node_id: from.into(),
            source_port_id: "out".into(),
            target_node_id: to.into(),
            target_port_id: "in".into(),
            is_active: None,
        };
        let workflow = WorkflowDefinition {
            id: "wf-messages".into(),
            nodes: vec![
                node("a", "Alpha"),
                node("b", "Beta"),
                node("loner", "Loner"),
            ],
            edges: vec![
                edge("e1", "a", "ghost"),
                edge("e2", "phantom", "b"),
                edge("e3", "b", "b"),
            ],
            ..Default::default()
        };

        let result = validate_workflow(&workflow);
        assert!(!result.valid);
        assert!(
            result
                .errors
                .contains(&crate::localized_error!("backendErrors.workflow.validationMissingTarget", "id" => "ghost"))
        );
        assert!(
            result
                .errors
                .contains(&crate::localized_error!("backendErrors.workflow.validationMissingSource", "id" => "phantom"))
        );
        assert!(result.errors.contains(
            &crate::localized_error!("backendErrors.workflow.validationSelfLoop", "id" => "b")
        ));
        assert!(
            result
                .warnings
                .contains(&crate::localized_error!("backendErrors.workflow.validationDisconnected", "title" => "Loner"))
        );
        assert!(result.warnings.contains(&crate::localized_error!(
            "backendErrors.workflow.validationNoTrigger"
        )));
    }
}
