//! The notification node: sends through an alert action or the desktop.

use std::time::Instant;

use chrono::Utc;
use serde_json::{Value, json};

use crate::context::AppHandle;
use crate::services::flow::workflow::types::{
    NodeExecutionOutput, WorkflowDefinition, WorkflowNode,
};
use crate::utils::types::origin::Origin;

/// Executes a multi-channel notification workflow node and registers the outcome in AlertHistory.
pub(crate) async fn execute_notification_node(
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
        .map(str::to_owned)
        .unwrap_or_else(|| crate::t!("backendErrors.workflow.notificationDefaultMessage"));
    let step_label = crate::t!("backendErrors.workflow.notificationStep", "title" => node.title);
    let node_label = crate::t!("backendErrors.workflow.notificationNode", "title" => node.title);

    let severity_str = config
        .get("severity")
        .and_then(Value::as_str)
        .unwrap_or("info");

    let severity = match severity_str.to_lowercase().as_str() {
        "critical" | "error" => crate::services::alerts::types::AlertSeverity::Critical,
        "high" => crate::services::alerts::types::AlertSeverity::High,
        "average" => crate::services::alerts::types::AlertSeverity::Average,
        "warning" | "warn" => crate::services::alerts::types::AlertSeverity::Warning,
        _ => crate::services::alerts::types::AlertSeverity::Info,
    };

    let ctx = crate::services::alerts::template::TemplateContext {
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
        operation: step_label.clone(),
        origin: Origin::Flow,
        timestamp: Utc::now().to_rfc3339(),
        rule_id: format!("workflow-{}", workflow.id),
        rule_name: workflow.name.clone(),
        source: Some(node_label.clone()),
        destination: None,
    };

    let start_time = Instant::now();

    let alert_cache = app.try_state::<crate::services::alerts::cache::AlertRuleCache>();
    let dispatch_ctx = app.try_state::<crate::services::alerts::dispatch::DispatchContext>();

    let mut target_action: Option<crate::services::alerts::types::AlertAction> = None;

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
            serde_json::from_value::<crate::services::alerts::types::AlertAction>(clean_cfg).ok();
    }

    let (res, action_kind_name, action_name, act_id) = if let (Some(action), Some(ref d_ctx)) =
        (target_action, dispatch_ctx)
    {
        let k_name = action.kind_str().to_string();
        let a_name = action.common().name.clone();
        let a_id = action.common().id.clone();
        let client = if let crate::services::alerts::types::AlertAction::Webhook(ref w) = action {
            if w.tls_verify {
                &d_ctx.client
            } else {
                &d_ctx.insecure_client
            }
        } else {
            &d_ctx.client
        };
        let r = crate::services::alerts::engine::execute_action(app, &action, &ctx, client, d_ctx)
            .await;
        (r, k_name, a_name, a_id)
    } else {
        #[cfg(feature = "notifications")]
        let r = app.host().notify(&ctx);
        #[cfg(not(feature = "notifications"))]
        let r = {
            log::info!(
                "Workflow notification (headless): [{}] {}",
                ctx.title,
                ctx.body
            );
            Ok(())
        };
        (
            r,
            "os_toast".to_string(),
            crate::t!("backendErrors.workflow.desktopNotification"),
            "inline_os_toast".to_string(),
        )
    };

    let duration_ms = start_time.elapsed().as_millis() as u64;

    if let Some(history_cache) =
        app.try_state::<crate::services::alerts::cache::AlertHistoryCache>()
    {
        let action_res = crate::services::alerts::types::ActionResult {
            action_id: act_id,
            action_name,
            action_kind: action_kind_name.clone(),
            success: res.is_ok(),
            error: res.as_ref().err().cloned(),
            duration_ms,
        };

        let record = crate::services::alerts::types::AlertRecord {
            id: uuid::Uuid::new_v4().to_string(),
            rule_id: format!("workflow-{}", workflow.id),
            rule_name: workflow.name.clone(),
            event_kind: crate::services::alerts::types::AlertEventKind::Workflow,
            severity,
            title: title_override.to_string(),
            body: message_override.to_string(),
            remote: None,
            profile: Some(workflow.name.clone()),
            backend: Some("Workflow".to_string()),
            operation: Some(step_label),
            origin: Some(Origin::Flow),
            source: Some(node_label),
            destination: None,
            timestamp: Utc::now(),
            action_results: vec![action_res],
            acknowledged: false,
            ack_at: None,
        };

        history_cache.push(record).await;
    }

    match res {
        Ok(_) => Ok(NodeExecutionOutput::new(json!({
            "notified": true,
            "channel": action_kind_name,
            "durationMs": duration_ms,
        }))),
        Err(e) => Err(crate::localized_error!(
            "backendErrors.workflow.notificationFailed",
            "kind" => action_kind_name,
            "error" => e
        )),
    }
}
