use crate::core::alerts::{
    dispatch::run_with_retry, template::TemplateContext, types::ScriptAction,
};
use log::debug;
use std::time::Duration;
use tokio::process::Command;

/// Execute a user-defined script / binary, injecting alert context as
/// environment variables (`ALERT_TITLE`, `ALERT_BODY`, `ALERT_SEVERITY`, …).
pub async fn dispatch(action: &ScriptAction, ctx: &TemplateContext) -> Result<(), String> {
    if action.command.is_empty() {
        return Err(format!(
            "Script action '{}': command path is empty",
            action.common.name
        ));
    }

    let timeout = Duration::from_secs(action.timeout_secs.max(1));
    let env_map = ctx.to_env_map();

    run_with_retry(
        &format!("Script '{}'", action.common.name),
        action.retry_count,
        || {
            let env_map = env_map.clone();
            async move {
                let result = tokio::time::timeout(
                    timeout,
                    Command::new(&action.command)
                        .args(&action.args)
                        .envs(&action.env_vars)
                        .envs(&env_map)
                        .output(),
                )
                .await;

                match result {
                    Ok(Ok(output)) => {
                        if output.status.success() {
                            debug!("⚡ Script '{}' completed successfully", action.common.name);
                            Ok(())
                        } else {
                            let stderr = String::from_utf8_lossy(&output.stderr);
                            let code = output.status.code().unwrap_or(-1);
                            Err(format!(
                                "Exited with code {code}. stderr: {}",
                                stderr.chars().take(500).collect::<String>()
                            ))
                        }
                    }
                    Ok(Err(e)) => Err(format!("Failed to spawn: {e}")),
                    Err(_) => Err(format!("Timed out after {}s", action.timeout_secs)),
                }
            }
        },
    )
    .await
}
