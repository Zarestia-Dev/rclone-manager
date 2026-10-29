//! Local actions: scripts, audit log entries and system power.

use chrono::Utc;
use log::info;
use serde_json::{Value, json};

use crate::services::flow::workflow::engine::cancel::CancelToken;
use crate::services::flow::workflow::types::{NodeExecutionOutput, WorkflowDefinition};

/// Executes a local shell command or script node ('exec_script') using the cross-platform Command wrapper.
/// Respects dry_run simulation, working directory, process cancellation, and failOnError.
pub(crate) async fn handle_exec_script_node(
    config: &Value,
    cancel: &CancelToken,
    dry_run: bool,
) -> Result<NodeExecutionOutput, String> {
    let command = config
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| crate::localized_error!("backendErrors.workflow.missingCommand"))?;

    let args = config
        .get("args")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");

    let fail_on_error = config
        .get("failOnError")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let working_dir = config
        .get("workingDir")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let full_cmd = if args.is_empty() {
        command.to_string()
    } else {
        format!("{command} {args}")
    };

    if dry_run {
        info!("Workflow dry_run enabled; simulating exec_script: '{full_cmd}'");
        return Ok(NodeExecutionOutput::new(json!({
            "exitCode": 0,
            "stdout": crate::t!("backendErrors.workflow.dryRunScript", "command" => full_cmd),
            "stderr": "",
            "success": true,
            "dryRun": true,
            "simulated": true
        })));
    }

    if cancel.is_cancelled() {
        return Err(crate::localized_error!("backendErrors.workflow.cancelled"));
    }

    let mut cmd = if cfg!(target_os = "windows") {
        crate::utils::process::command::Command::new("cmd").args(["/C", &full_cmd])
    } else {
        crate::utils::process::command::Command::new("sh").args(["-c", &full_cmd])
    };

    if let Some(dir) = working_dir {
        cmd = cmd.current_dir(dir);
    }

    let output = tokio::select! {
        res = cmd.output() => {
            res.map_err(|e| {
                crate::localized_error!(
                    "backendErrors.workflow.spawnFailed",
                    "command" => command,
                    "error" => e
                )
            })?
        }
        () = cancel.cancelled() => {
            return Err(crate::localized_error!("backendErrors.workflow.cancelled"));
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let exit_code = output.status.code().unwrap_or(-1);
    let is_success = output.status.success();

    let trimmed_stdout = stdout.trim().to_string();
    let trimmed_stderr = stderr.trim().to_string();
    let primary_output = if !trimmed_stdout.is_empty() {
        trimmed_stdout
    } else {
        trimmed_stderr
    };

    let summary = if is_success {
        crate::t!("backendErrors.workflow.scriptCompleted", "code" => exit_code)
    } else {
        crate::t!(
            "backendErrors.workflow.scriptFailed",
            "code" => exit_code,
            "stderr" => stderr
        )
    };

    let result_json = json!({
        "exitCode": exit_code,
        "stdout": stdout,
        "stderr": stderr,
        "output": primary_output,
        "summary": summary,
        "success": is_success,
        "status": if is_success { "success" } else { "failed" },
    });

    if !is_success && fail_on_error {
        return Err(crate::localized_error!(
            "backendErrors.workflow.commandFailed",
            "code" => exit_code,
            "stderr" => stderr
        ));
    }

    Ok(NodeExecutionOutput::new(result_json))
}

/// Writes a line to the application log on behalf of the workflow.
pub(crate) fn log_audit_node(workflow: &WorkflowDefinition, config: &Value) -> NodeExecutionOutput {
    let message = config
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| crate::t!("backendErrors.workflow.auditDefaultMessage"));

    let severity = config
        .get("severity")
        .and_then(Value::as_str)
        .unwrap_or("info");

    match severity {
        "error" => log::error!("[Workflow Audit] [{}] {message}", workflow.name),
        "warn" | "warning" => log::warn!("[Workflow Audit] [{}] {message}", workflow.name),
        _ => log::info!("[Workflow Audit] [{}] {message}", workflow.name),
    }

    NodeExecutionOutput::new(json!({
        "logged": true,
        "message": message,
        "severity": severity,
        "timestamp": Utc::now().to_rfc3339()
    }))
}

/// Sleeps, shuts down or locks the system.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) async fn system_power_node(
    config: &Value,
    dry_run: bool,
) -> Result<NodeExecutionOutput, String> {
    let action = config
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("sleep");

    info!("System power action requested: {action} (dry_run: {dry_run})");

    if dry_run {
        info!("Dry-run simulation: skipping actual system power action '{action}'");
        return Ok(NodeExecutionOutput::new(json!({
            "powerAction": action,
            "executed": false,
            "dryRun": true,
            "message": crate::t!("backendErrors.workflow.dryRunPower", "action" => action)
        })));
    }

    crate::services::power::actions::execute_system_power_internal(action)
        .await
        .map_err(|e| {
            crate::localized_error!(
                "backendErrors.workflow.systemPowerFailed",
                "action" => action,
                "error" => e
            )
        })?;

    Ok(NodeExecutionOutput::new(json!({
        "powerAction": action,
        "executed": true
    })))
}

#[cfg(test)]
mod tests {

    use serde_json::json;

    use super::*;

    #[tokio::test]
    async fn test_exec_script_dry_run() {
        let config = json!({
            "command": "rm -rf /critical/data",
            "args": "--no-preserve-root",
            "failOnError": true
        });
        let cancel = CancelToken::new();

        let result = handle_exec_script_node(&config, &cancel, true)
            .await
            .expect("dry-run should succeed safely");

        assert_eq!(result.value["dryRun"], true);
        assert_eq!(result.value["simulated"], true);
        assert_eq!(result.value["exitCode"], 0);
        assert_eq!(result.value["success"], true);
        let stdout = result.value["stdout"].as_str().unwrap();
        assert!(stdout.contains(
            "[dry_run] Simulated execution of: rm -rf /critical/data --no-preserve-root"
        ));
    }

    #[tokio::test]
    async fn test_exec_script_missing_command() {
        let config = json!({ "command": "   ", "args": "-a" });
        let cancel = CancelToken::new();

        let result = handle_exec_script_node(&config, &cancel, false).await;
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .contains("backendErrors.workflow.missingCommand")
        );
    }

    #[tokio::test]
    async fn test_exec_script_success() {
        let config = json!({
            "command": "echo",
            "args": "hello_from_test"
        });
        let cancel = CancelToken::new();

        let result = handle_exec_script_node(&config, &cancel, false)
            .await
            .expect("echo command should succeed");

        assert_eq!(result.value["exitCode"], 0);
        assert_eq!(result.value["success"], true);
        let stdout = result.value["stdout"].as_str().unwrap();
        assert!(stdout.contains("hello_from_test"));
    }

    #[tokio::test]
    async fn test_exec_script_fail_on_error_true() {
        let config = json!({
            "command": "exit 42",
            "failOnError": true
        });
        let cancel = CancelToken::new();

        let result = handle_exec_script_node(&config, &cancel, false).await;
        assert!(result.is_err());
        let err_msg = result.unwrap_err();
        assert!(err_msg.contains("backendErrors.workflow.commandFailed"));
    }

    #[tokio::test]
    async fn test_exec_script_fail_on_error_false() {
        let config = json!({
            "command": "exit 42",
            "failOnError": false
        });
        let cancel = CancelToken::new();

        let result = handle_exec_script_node(&config, &cancel, false)
            .await
            .expect("should not error when failOnError is false");

        assert_eq!(result.value["success"], false);
        assert_ne!(result.value["exitCode"], 0);
    }
}
