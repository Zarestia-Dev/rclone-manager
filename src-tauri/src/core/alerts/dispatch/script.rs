use crate::core::alerts::{template::TemplateContext, types::ScriptAction};
use log::debug;
use std::time::Duration;
use tokio::process::Command;

/// Execute a user-defined script / binary, injecting alert context as
/// environment variables (`ALERT_TITLE`, `ALERT_BODY`, `ALERT_SEVERITY`, …).
///
/// Returns the exit status and truncated stdout/stderr in the error message
/// if the script fails.
pub async fn dispatch(action: &ScriptAction, ctx: &TemplateContext) -> Result<(), String> {
    if action.command.is_empty() {
        return Err(format!(
            "Script action '{}': command path is empty",
            action.name
        ));
    }

    let timeout = Duration::from_secs(action.timeout_secs.max(1));
    let env_map = ctx.to_env_map();

    let result = tokio::time::timeout(
        timeout,
        Command::new(&action.command)
            .args(&action.args)
            // Static env vars from action config
            .envs(&action.env_vars)
            // Dynamic ALERT_* vars from the event context
            .envs(&env_map)
            .output(),
    )
    .await
    .map_err(|_| {
        format!(
            "Script '{}' timed out after {}s",
            action.name, action.timeout_secs
        )
    })?
    .map_err(|e| format!("Script '{}' failed to spawn: {e}", action.name))?;

    if result.status.success() {
        debug!("⚡ Script '{}' completed successfully", action.name);
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&result.stderr);
        let code = result.status.code().unwrap_or(-1);

        Err(format!(
            "Script '{}' exited with code {code}. stderr: {}",
            action.name,
            stderr.chars().take(500).collect::<String>()
        ))
    }
}
