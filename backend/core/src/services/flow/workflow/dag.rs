//! DAG (Directed Acyclic Graph) validation and cycle detection.

use std::collections::{HashMap, HashSet, VecDeque};

use super::interpolation::{TokenSource, find_node, token_sources};
use super::types::{WorkflowDefinition, WorkflowEdge, WorkflowNode, WorkflowValidationResult};

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

/// The errors of a wire attached to a port its node does not have. Such a wire is drawn
/// nowhere and is read as the node's success port, so it would fire when it should not.
fn missing_port_errors(workflow: &WorkflowDefinition, edge: &WorkflowEdge) -> Vec<String> {
    let node = |id: &str| workflow.nodes.iter().find(|n| n.id == id);
    let mut errors = Vec::new();
    if let Some(source) = node(&edge.source_node_id)
        && !source.outputs.iter().any(|p| p.id == edge.source_port_id)
    {
        errors.push(crate::localized_error!(
            "backendErrors.workflow.validationMissingPort",
            "title" => source.title,
            "port" => edge.source_port_id
        ));
    }
    if let Some(target) = node(&edge.target_node_id)
        && !target.inputs.iter().any(|p| p.id == edge.target_port_id)
    {
        errors.push(crate::localized_error!(
            "backendErrors.workflow.validationMissingPort",
            "title" => target.title,
            "port" => edge.target_port_id
        ));
    }
    errors
}

/// Warnings for settings that read the output of a node that has not run when the node does:
/// one that does not exist, one that does not lead into this node, or `prev` without a wire in.
/// Such a token is left as typed in the result, which is rarely meant.
fn unreachable_token_warnings(workflow: &WorkflowDefinition) -> Vec<String> {
    let mut sources: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in &workflow.edges {
        sources
            .entry(edge.target_node_id.as_str())
            .or_default()
            .push(edge.source_node_id.as_str());
    }

    let mut warnings = Vec::new();
    for node in &workflow.nodes {
        let mut ancestors: Option<HashSet<&str>> = None;
        for token in token_sources(&node.config) {
            let warning = match token {
                TokenSource::Previous if !sources.contains_key(node.id.as_str()) => {
                    Some(crate::localized_error!(
                        "backendErrors.workflow.validationPrevWithoutInput",
                        "title" => node.title
                    ))
                }
                TokenSource::Previous => None,
                TokenSource::Node(identifier) => match find_node(workflow, identifier) {
                    None => Some(crate::localized_error!(
                        "backendErrors.workflow.validationTokenUnknownNode",
                        "title" => node.title,
                        "node" => identifier
                    )),
                    Some(named) => {
                        let reaching =
                            ancestors.get_or_insert_with(|| ancestors_of(&sources, node));
                        (!reaching.contains(named.id.as_str())).then(|| {
                            crate::localized_error!(
                                "backendErrors.workflow.validationTokenNotUpstream",
                                "title" => node.title,
                                "node" => named.title
                            )
                        })
                    }
                },
            };
            if let Some(warning) = warning
                && !warnings.contains(&warning)
            {
                warnings.push(warning);
            }
        }
    }
    warnings
}

/// The ids of the nodes a path of wires leads from into `node`.
fn ancestors_of<'a>(
    sources: &HashMap<&'a str, Vec<&'a str>>,
    node: &'a WorkflowNode,
) -> HashSet<&'a str> {
    let mut seen = HashSet::new();
    let mut pending = vec![node.id.as_str()];
    while let Some(id) = pending.pop() {
        for &source in sources.get(id).into_iter().flatten() {
            if seen.insert(source) {
                pending.push(source);
            }
        }
    }
    seen
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
    let has_trigger = workflow.nodes.iter().any(WorkflowNode::is_trigger);
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
        errors.extend(missing_port_errors(workflow, edge));
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

    warnings.extend(unreachable_token_warnings(workflow));

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
            inputs: vec![WorkflowPort::new("in", WorkflowPortType::In)],
            outputs: vec![WorkflowPort::new("out", WorkflowPortType::Out)],
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

    fn workflow(nodes: Vec<WorkflowNode>, edges: Vec<WorkflowEdge>) -> WorkflowDefinition {
        WorkflowDefinition {
            id: "wf-check".to_string(),
            name: "Check".to_string(),
            nodes,
            edges,
            ..Default::default()
        }
    }

    fn with_config(mut node: WorkflowNode, config: serde_json::Value) -> WorkflowNode {
        node.config = config;
        node
    }

    #[test]
    fn a_wire_on_a_port_its_node_does_not_have_is_an_error() {
        let mut wf = workflow(
            vec![
                create_test_node("n1", "Trigger", WorkflowNodeCategory::Trigger),
                create_test_node("n2", "Task", WorkflowNodeCategory::Task),
            ],
            vec![create_test_edge("n1", "n2")],
        );
        wf.edges[0].source_port_id = "success".to_string();
        wf.edges[0].target_port_id = "gone".to_string();

        let result = validate_workflow(&wf);

        assert!(!result.valid);
        assert_eq!(result.errors.len(), 2);
        assert!(result.errors[0].contains("validationMissingPort"));
        assert!(result.errors[0].contains("success"));
        assert!(result.errors[1].contains("gone"));
    }

    #[test]
    fn a_wire_on_a_missing_node_reports_the_node_and_not_a_port_as_well() {
        let wf = workflow(
            vec![create_test_node(
                "n1",
                "Trigger",
                WorkflowNodeCategory::Trigger,
            )],
            vec![create_test_edge("n1", "ghost")],
        );

        let result = validate_workflow(&wf);

        assert_eq!(result.errors.len(), 1);
        assert!(result.errors[0].contains("validationMissingTarget"));
    }

    #[test]
    fn a_token_naming_a_node_that_leads_into_the_reader_is_not_warned_about() {
        // a -> b -> c; c reads a (far) and b (by title, ignoring case and spaces) and its own prev
        let wf = workflow(
            vec![
                create_test_node("a", "First", WorkflowNodeCategory::Trigger),
                create_test_node("b", "Second Step", WorkflowNodeCategory::Task),
                with_config(
                    create_test_node("c", "Third", WorkflowNodeCategory::Action),
                    serde_json::json!({
                        "message": "{{nodes.a.summary}} {{ nodes[\"second step\"].error }} {{prev.status}} {{profile}}"
                    }),
                ),
            ],
            vec![create_test_edge("a", "b"), create_test_edge("b", "c")],
        );

        let result = validate_workflow(&wf);

        assert!(result.valid);
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    }

    #[test]
    fn a_token_naming_a_node_that_does_not_lead_into_the_reader_is_a_warning() {
        // a -> c, and b is unconnected to c; d comes after c
        let wf = workflow(
            vec![
                create_test_node("a", "First", WorkflowNodeCategory::Trigger),
                create_test_node("b", "Other", WorkflowNodeCategory::Task),
                with_config(
                    create_test_node("c", "Third", WorkflowNodeCategory::Action),
                    serde_json::json!({
                        "title": "{{nodes.b.summary}}",
                        "message": "{{nodes.b.error}} {{nodes.d.error}} {{nodes.c.error}}"
                    }),
                ),
                create_test_node("d", "Later", WorkflowNodeCategory::Task),
            ],
            vec![create_test_edge("a", "c"), create_test_edge("c", "d")],
        );

        let result = validate_workflow(&wf);

        assert!(result.valid, "a token is a warning, not an error");
        let not_upstream: Vec<_> = result
            .warnings
            .iter()
            .filter(|w| w.contains("validationTokenNotUpstream"))
            .collect();
        // b once (named twice), d, and c itself
        assert_eq!(not_upstream.len(), 3, "{:?}", result.warnings);
    }

    #[test]
    fn a_token_naming_no_node_and_prev_without_an_input_are_warnings() {
        let wf = workflow(
            vec![with_config(
                create_test_node("a", "Lonely", WorkflowNodeCategory::Trigger),
                serde_json::json!({ "message": "{{nodes.nobody.x}} {{prev.y}}" }),
            )],
            vec![],
        );

        let result = validate_workflow(&wf);

        assert!(result.valid);
        assert!(
            result
                .warnings
                .iter()
                .any(|w| w.contains("validationTokenUnknownNode"))
        );
        assert!(
            result
                .warnings
                .iter()
                .any(|w| w.contains("validationPrevWithoutInput"))
        );
    }
}
