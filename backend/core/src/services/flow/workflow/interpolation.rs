//! Workflow output references and recursive configuration interpolation.
use super::types::{WorkflowDefinition, WorkflowNode};
use serde_json::Value;
use std::borrow::Cow;
use std::collections::HashMap;

/// ASCII-case-insensitive comparison that ignores spaces, without allocating.
fn eq_ignoring_spaces(a: &str, b: &str) -> bool {
    let (mut a, mut b) = (
        a.chars().filter(|c| *c != ' '),
        b.chars().filter(|c| *c != ' '),
    );
    loop {
        match (a.next(), b.next()) {
            (None, None) => return true,
            (Some(x), Some(y)) if x.eq_ignore_ascii_case(&y) => {}
            _ => return false,
        }
    }
}

/// Resolves a nested JSON path on a Value, supporting array indexing and length.
fn resolve_nested_json_path(root: &Value, field_path: &str) -> Option<String> {
    if field_path.is_empty() {
        return Some(match root {
            Value::String(s) => s.clone(),
            Value::Object(_) | Value::Array(_) => {
                serde_json::to_string_pretty(root).unwrap_or_else(|_| root.to_string())
            }
            other => other.to_string(),
        });
    }

    // Normalize brackets: `items[0].name` -> `items.0.name`
    let normalized = field_path.replace('[', ".").replace(']', "");
    let mut current = root;

    for segment in normalized.split('.').filter(|s| !s.is_empty()) {
        match current {
            Value::Object(map) => {
                current = map.get(segment)?;
            }
            Value::Array(arr) => {
                if segment == "length" || segment == "count" {
                    return Some(arr.len().to_string());
                }
                let idx: usize = segment.parse().ok()?;
                current = arr.get(idx)?;
            }
            _ => return None,
        }
    }

    Some(match current {
        Value::String(s) => s.clone(),
        Value::Array(arr) => {
            if arr.iter().all(Value::is_string) {
                arr.iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            } else {
                serde_json::to_string_pretty(current).unwrap_or_else(|_| current.to_string())
            }
        }
        Value::Object(_) => {
            serde_json::to_string_pretty(current).unwrap_or_else(|_| current.to_string())
        }
        other => other.to_string(),
    })
}

/// Whether a token names the node before the current one: `prev` or `previous`, with or without a path.
fn is_previous_token(token: &str) -> bool {
    token == "prev"
        || token == "previous"
        || token.starts_with("prev.")
        || token.starts_with("previous.")
}

/// Splits `nodes.<id>.<path>`, `steps.<id>.<path>` or `nodes["Title"].<path>` into the
/// node it names (an id or a title) and the path inside its output.
fn split_node_token(token: &str) -> Option<(&str, &str)> {
    let raw_path = token
        .strip_prefix("nodes.")
        .or_else(|| token.strip_prefix("steps."))
        .or_else(|| token.strip_prefix("nodes["))
        .or_else(|| token.strip_prefix("steps["))?;

    if token.starts_with("nodes[") || token.starts_with("steps[") {
        let close_bracket = raw_path.find(']')?;
        let name = raw_path[..close_bracket].trim().trim_matches(['\'', '"']);
        let remaining = raw_path[close_bracket + 1..].trim_start_matches('.');
        Some((name, remaining))
    } else {
        let mut parts = raw_path.splitn(2, '.');
        let name = parts.next()?;
        Some((name, parts.next().unwrap_or("")))
    }
}

/// The node a token's identifier names: by id, else by title (ignoring case and spaces).
pub(crate) fn find_node<'a>(
    workflow: &'a WorkflowDefinition,
    identifier: &str,
) -> Option<&'a WorkflowNode> {
    workflow
        .nodes
        .iter()
        .find(|n| n.id == identifier || eq_ignoring_spaces(&n.title, identifier))
}

/// Where a `{{…}}` token in a node's settings reads from.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum TokenSource<'a> {
    /// `{{prev…}}`: the node before this one.
    Previous,
    /// `{{nodes.<id or title>…}}`: that node.
    Node(&'a str),
}

/// Every node output the settings read through a token, in order. Tokens of other
/// kinds (`{{profile}}` in an alert text) are not outputs and are not listed.
pub(crate) fn token_sources(config: &Value) -> Vec<TokenSource<'_>> {
    fn collect<'a>(value: &'a Value, found: &mut Vec<TokenSource<'a>>) {
        match value {
            Value::String(text) => {
                let mut rest = text.as_str();
                while let Some(start) = rest.find("{{") {
                    let after = &rest[start + 2..];
                    let Some(end) = after.find("}}") else { break };
                    let token = after[..end].trim();
                    if is_previous_token(token) {
                        found.push(TokenSource::Previous);
                    } else if let Some((node, _)) = split_node_token(token) {
                        found.push(TokenSource::Node(node));
                    }
                    rest = &after[end + 2..];
                }
            }
            Value::Object(map) => map.values().for_each(|v| collect(v, found)),
            Value::Array(items) => items.iter().for_each(|v| collect(v, found)),
            _ => {}
        }
    }
    let mut found = Vec::new();
    collect(config, &mut found);
    found
}

/// Resolves token values like `{{prev.<path>}}`, `{{nodes.<id>.<path>}}`,
/// `{{nodes["Title"].<path>}}`, or `{{steps.<id>.<path>}}`.
fn resolve_token_value(
    token: &str,
    results: &HashMap<String, Value>,
    workflow: Option<&WorkflowDefinition>,
    current_node_id: Option<&str>,
) -> Option<String> {
    let trimmed = token.trim();

    // 1. Handle `prev.<path>` or `previous.<path>`
    if is_previous_token(trimmed) {
        let field_path = trimmed
            .strip_prefix("prev.")
            .or_else(|| trimmed.strip_prefix("previous."))
            .unwrap_or("");

        if let (Some(wf), Some(curr_id)) = (workflow, current_node_id) {
            let prev_val = wf
                .edges
                .iter()
                .filter(|e| e.target_node_id == curr_id)
                .find_map(|e| results.get(&e.source_node_id));

            if let Some(val) = prev_val {
                return resolve_nested_json_path(val, field_path);
            }
        }
        return None;
    }

    // 2. Handle `nodes.<id/title>.<path>` or `steps.<id/title>.<path>`
    let (node_identifier, field_path) = split_node_token(trimmed)?;

    // Try direct ID lookup first
    if let Some(node_val) = results.get(node_identifier) {
        return resolve_nested_json_path(node_val, field_path);
    }

    // Fall back to title lookup if workflow definition is present
    if let Some(node) = workflow.and_then(|wf| find_node(wf, node_identifier))
        && let Some(node_val) = results.get(&node.id)
    {
        return resolve_nested_json_path(node_val, field_path);
    }

    None
}

fn replace_workflow_tokens(
    input: &str,
    results: &HashMap<String, Value>,
    workflow: Option<&WorkflowDefinition>,
    current_node_id: Option<&str>,
) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;

    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after_start = &rest[start + 2..];
        if let Some(end) = after_start.find("}}") {
            let token = after_start[..end].trim();
            if let Some(val_str) = resolve_token_value(token, results, workflow, current_node_id) {
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

pub(crate) fn interpolate_node_config_with_context(
    config: &Value,
    results: &HashMap<String, Value>,
    workflow: Option<&WorkflowDefinition>,
    current_node_id: Option<&str>,
) -> Value {
    match config {
        Value::String(s) => {
            let resolved = if s.contains("{{") && s.contains("}}") {
                Cow::Owned(replace_workflow_tokens(
                    s,
                    results,
                    workflow,
                    current_node_id,
                ))
            } else {
                Cow::Borrowed(s.as_str())
            };
            Value::String(
                match crate::utils::json_helpers::interpolate_shell_commands(&resolved) {
                    Cow::Owned(interpolated) => interpolated,
                    Cow::Borrowed(_) => resolved.into_owned(),
                },
            )
        }
        Value::Object(map) => {
            let mut new_map = serde_json::Map::with_capacity(map.len());
            for (k, v) in map {
                new_map.insert(
                    k.clone(),
                    interpolate_node_config_with_context(v, results, workflow, current_node_id),
                );
            }
            Value::Object(new_map)
        }
        Value::Array(arr) => Value::Array(
            arr.iter()
                .map(|v| {
                    interpolate_node_config_with_context(v, results, workflow, current_node_id)
                })
                .collect(),
        ),
        _ => config.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::super::types::{WorkflowEdge, WorkflowNode, WorkflowNodeCategory};
    use super::*;
    use serde_json::json;
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
        let replaced = replace_workflow_tokens(input_str, &results, None, None);

        assert_eq!(
            replaced,
            "File backup_2026.tar.gz finished with code 0, transfers: 42"
        );

        // Test unmapped token remains intact
        let unmapped =
            replace_workflow_tokens("Unknown: {{nodes.nonexistent.val}}", &results, None, None);
        assert_eq!(unmapped, "Unknown: {{nodes.nonexistent.val}}");

        // Test recursive JSON structure interpolation
        let config_obj = json!({
            "message": "Archive {{nodes.step1.stdout}} ready",
            "nested": {
                "bytes": "{{nodes.step1.stats.bytes}}"
            }
        });

        let interpolated = interpolate_node_config_with_context(&config_obj, &results, None, None);
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
    fn test_resolve_token_value_with_prev_and_title() {
        let wf = WorkflowDefinition {
            id: "wf-1".to_string(),
            name: "Test Flow".to_string(),
            nodes: vec![
                WorkflowNode {
                    id: "node-check-1".to_string(),
                    node_type: "check".to_string(),
                    category: WorkflowNodeCategory::Task,
                    title: "Check Remote".to_string(),
                    ..Default::default()
                },
                WorkflowNode {
                    id: "node-notify-1".to_string(),
                    node_type: "notification".to_string(),
                    category: WorkflowNodeCategory::Action,
                    title: "Send Notification".to_string(),
                    x: 100.0,
                    ..Default::default()
                },
            ],
            edges: vec![WorkflowEdge {
                id: "edge-1".to_string(),
                source_node_id: "node-check-1".to_string(),
                source_port_id: "success".to_string(),
                target_node_id: "node-notify-1".to_string(),
                target_port_id: "in".to_string(),
                is_active: Some(true),
            }],
            ..Default::default()
        };

        let mut results = HashMap::new();
        results.insert(
            "node-check-1".to_string(),
            json!({
                "hasDifferences": true,
                "differCount": 2,
                "summary": "Check found 2 differences",
                "differ": ["fileA.txt", "fileB.txt"],
                "report": "### Check Report\n- fileA.txt\n- fileB.txt",
                "stats": {
                    "bytes": 2048,
                    "errors": 0
                }
            }),
        );

        // 1. Resolve via prev
        let prev_summary =
            resolve_token_value("prev.summary", &results, Some(&wf), Some("node-notify-1"));
        assert_eq!(prev_summary, Some("Check found 2 differences".to_string()));

        let prev_differ_count = resolve_token_value(
            "prev.differCount",
            &results,
            Some(&wf),
            Some("node-notify-1"),
        );
        assert_eq!(prev_differ_count, Some("2".to_string()));

        let prev_differ_len = resolve_token_value(
            "prev.differ.length",
            &results,
            Some(&wf),
            Some("node-notify-1"),
        );
        assert_eq!(prev_differ_len, Some("2".to_string()));

        let prev_first_file =
            resolve_token_value("prev.differ[0]", &results, Some(&wf), Some("node-notify-1"));
        assert_eq!(prev_first_file, Some("fileA.txt".to_string()));

        // 2. Resolve via node title
        let title_summary = resolve_token_value(
            "nodes[\"Check Remote\"].summary",
            &results,
            Some(&wf),
            Some("node-notify-1"),
        );
        assert_eq!(title_summary, Some("Check found 2 differences".to_string()));

        // 3. String replacement with multiple tokens
        let template = "Alert: {{prev.summary}} | First: {{prev.differ[0]}}";
        let replaced =
            replace_workflow_tokens(template, &results, Some(&wf), Some("node-notify-1"));
        assert_eq!(
            replaced,
            "Alert: Check found 2 differences | First: fileA.txt"
        );
    }

    #[test]
    fn title_references_ignore_case_and_spaces_without_matching_other_titles() {
        assert!(eq_ignoring_spaces("My Backup Step", "mybackupstep"));
        assert!(eq_ignoring_spaces("Sync", "SYNC"));
        assert!(!eq_ignoring_spaces("Sync", "Syncs"));
        assert!(!eq_ignoring_spaces("Sync a", "Sync b"));
        assert!(eq_ignoring_spaces("", "  "));
    }

    #[test]
    fn plain_and_templated_strings_both_get_macros_resolved_once() {
        let results = HashMap::from([("n1".to_string(), json!({"name": "$(os)"}))]);
        let config = json!({
            "plain": "no braces here",
            "templated": "value: {{nodes.n1.name}}",
            "macro": "host-$(os)",
            "list": ["{{nodes.n1.name}}", 7, true],
        });

        let resolved = interpolate_node_config_with_context(&config, &results, None, None);
        assert_eq!(resolved["plain"], "no braces here");
        assert_eq!(resolved["macro"], format!("host-{}", std::env::consts::OS));
        // A referenced value that itself looks like a macro is resolved by the macro pass.
        assert_eq!(
            resolved["templated"],
            format!("value: {}", std::env::consts::OS)
        );
        assert_eq!(resolved["list"][1], 7);
        assert_eq!(resolved["list"][2], true);
    }

    #[test]
    fn token_sources_lists_every_output_a_setting_reads_and_nothing_else() {
        let config = json!({
            "message": "{{prev.status}} and {{ nodes.a.x }} {{profile}} {{nodes[\"My Node\"].y}}",
            "nested": { "list": ["{{steps.b.z}}", "no token", "{{ previous }}"] },
            "number": 3,
            "broken": "{{nodes.c.x"
        });

        let mut found = token_sources(&config);
        found.sort_by_key(|s| format!("{s:?}"));

        assert_eq!(
            found,
            vec![
                TokenSource::Node("My Node"),
                TokenSource::Node("a"),
                TokenSource::Node("b"),
                TokenSource::Previous,
                TokenSource::Previous,
            ]
        );
    }
}
