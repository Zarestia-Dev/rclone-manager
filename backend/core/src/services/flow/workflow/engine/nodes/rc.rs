//! Direct rclone RC commands and remote cleanup.

use log::info;
use serde_json::{Value, json};

use crate::rclone::backend::routing_transport::RoutingTransport;
use crate::services::flow::workflow::engine::RunContext;
use crate::services::flow::workflow::engine::nodes::extract_node_op_config;
use crate::services::flow::workflow::types::NodeExecutionOutput;

/// Wraps an RC response with its status. The response is moved into `result`
/// rather than copied; its top-level fields are also exposed beside it, so
/// `{{nodes.<id>.<field>}}` keeps working, without replacing the envelope's own keys.
fn rc_command_envelope(command: &str, out: Value) -> Value {
    let mut envelope = serde_json::Map::new();
    envelope.insert("command".into(), json!(command));
    envelope.insert("success".into(), json!(true));
    envelope.insert("status".into(), json!("success"));
    envelope.insert(
        "json".into(),
        json!(serde_json::to_string_pretty(&out).unwrap_or_else(|_| out.to_string())),
    );
    if let Some(fields) = out.as_object() {
        for (key, value) in fields {
            if key != "result" {
                envelope.entry(key.clone()).or_insert_with(|| value.clone());
            }
        }
    }
    envelope.insert("result".into(), out);
    Value::Object(envelope)
}

/// Helper to extract and normalize Rclone RC command parameters.
/// Accepts either a JSON Object, a JSON String (which is parsed), or empty/None defaulting to `{}`.
pub(crate) fn parse_rc_params(params_val: Option<&Value>) -> Result<Value, String> {
    match params_val {
        Some(Value::Object(map)) => Ok(Value::Object(map.clone())),
        Some(Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                Ok(json!({}))
            } else {
                serde_json::from_str(trimmed)
                    .map_err(|e| crate::localized_error!("backendErrors.workflow.invalidRcParams", "error" => e))
            }
        }
        Some(val) if val.is_null() => Ok(json!({})),
        Some(other) => Ok(other.clone()),
        None => Ok(json!({})),
    }
}

/// Empties the trash of a remote (`operations/cleanup`).
pub(crate) async fn cleanup_node(
    ctx: &RunContext,
    config: &Value,
) -> Result<NodeExecutionOutput, String> {
    let RunContext {
        app,
        backend,
        cancel,
        dry_run,
        ..
    } = ctx;
    let op = extract_node_op_config(config);
    let path = op
        .config
        .get("path")
        .or_else(|| op.config.get("srcFs"))
        .and_then(Value::as_str)
        .unwrap_or_default();

    let fs = if op.remote.is_empty() {
        path.to_string()
    } else if path.is_empty() {
        format!("{}:", op.remote)
    } else {
        format!("{}:{path}", op.remote)
    };

    if *dry_run {
        info!("Dry-run simulation: skipping operations/cleanup on '{fs}'");
        return Ok(NodeExecutionOutput::new(json!({
            "cleaned": false,
            "dryRun": true,
            "fs": fs,
            "message": crate::t!("backendErrors.workflow.dryRunCleanup", "fs" => fs)
        })));
    }

    let transport = RoutingTransport::for_backend(app.clone(), backend.clone());
    let params = json!({ "fs": fs });
    let out = tokio::select! {
        res = transport.rpc("operations/cleanup", Some(&params)) => res.map_err(|e| {
            crate::localized_error!(
                "backendErrors.workflow.cleanupFailed",
                "fs" => fs,
                "error" => e
            )
        })?,
        () = cancel.cancelled() => {
            return Err(crate::localized_error!("backendErrors.workflow.cancelled"));
        }
    };

    Ok(NodeExecutionOutput::new(json!({
        "cleaned": true,
        "fs": fs,
        "result": out
    })))
}

/// Sends a direct rclone RC command.
pub(crate) async fn rc_command_node(
    ctx: &RunContext,
    config: &Value,
) -> Result<NodeExecutionOutput, String> {
    let command = config
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or("core/version");
    let params = parse_rc_params(config.get("params"))?;

    let transport = RoutingTransport::for_backend(ctx.app.clone(), ctx.backend.clone());
    let out = tokio::select! {
        res = transport.rpc(command, Some(&params)) => res.map_err(|e| {
            crate::localized_error!(
                "backendErrors.workflow.rcCommandFailed",
                "command" => command,
                "error" => e
            )
        })?,
        () = ctx.cancel.cancelled() => {
            return Err(crate::localized_error!("backendErrors.workflow.cancelled"));
        }
    };

    Ok(NodeExecutionOutput::new(rc_command_envelope(command, out)))
}

#[cfg(test)]
mod tests {

    use serde_json::json;

    use super::*;

    #[test]
    fn test_parse_rc_params() {
        // None or Null defaults to empty object
        assert_eq!(parse_rc_params(None).unwrap(), json!({}));
        assert_eq!(parse_rc_params(Some(&json!(null))).unwrap(), json!({}));

        // JSON Object is passed directly
        let obj = json!({ "fs": "remote:", "recursive": true });
        assert_eq!(parse_rc_params(Some(&obj)).unwrap(), obj);

        // Valid JSON string is parsed into an object
        let valid_str = json!("{\"fs\": \"myremote:\", \"dir\": \"backup\"}");
        assert_eq!(
            parse_rc_params(Some(&valid_str)).unwrap(),
            json!({ "fs": "myremote:", "dir": "backup" })
        );

        // Empty or whitespace string defaults to empty object
        assert_eq!(parse_rc_params(Some(&json!(""))).unwrap(), json!({}));
        assert_eq!(
            parse_rc_params(Some(&json!("   \n\t "))).unwrap(),
            json!({})
        );

        // Invalid JSON string returns an error
        let invalid_str = json!("{ not_valid_json }");
        let err = parse_rc_params(Some(&invalid_str)).unwrap_err();
        assert!(err.contains("backendErrors.workflow.invalidRcParams"));
    }

    #[test]
    fn the_rc_envelope_keeps_the_response_and_never_overrides_its_own_keys() {
        let envelope = rc_command_envelope(
            "core/stats",
            json!({"bytes": 5, "success": false, "status": "weird", "result": "inner"}),
        );
        assert_eq!(envelope["command"], "core/stats");
        assert_eq!(envelope["bytes"], 5);
        assert_eq!(envelope["success"], true);
        assert_eq!(envelope["status"], "success");
        assert_eq!(envelope["result"]["result"], "inner");
        assert!(envelope["json"].as_str().unwrap().contains("\"bytes\": 5"));

        let scalar = rc_command_envelope("core/pid", json!(42));
        assert_eq!(scalar["result"], 42);
    }
}
