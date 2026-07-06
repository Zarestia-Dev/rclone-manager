use std::path::PathBuf;

use log::{debug, error, info};
use tauri::{AppHandle, Emitter, Manager};

use crate::utils::rclone::util::RCLONE_EXECUTABLE;
use crate::utils::types::events::{EngineStatus, RCLONE_ENGINE_STATUS_CHANGED};

pub const MIN_RCLONE_VERSION: &str = "1.70.0";

fn resolve_rclone_binary(app: &AppHandle, override_path: Option<&std::path::Path>) -> PathBuf {
    if let Some(path) = override_path
        .filter(|p| !p.to_string_lossy().is_empty() && *p != std::path::Path::new("system"))
    {
        let path = PathBuf::from(path);
        if !path.to_string_lossy().ends_with(RCLONE_EXECUTABLE) {
            return path.join(RCLONE_EXECUTABLE);
        }
        return path;
    }
    read_rclone_binary(app)
}

pub async fn get_rclone_version(rclone_binary: &std::path::Path) -> Option<String> {
    match crate::utils::process::command::Command::new(rclone_binary)
        .arg("version")
        .output()
        .await
    {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            stdout.lines().next().and_then(|line| {
                line.split_whitespace()
                    .nth(1)
                    .map(|v| v.trim_start_matches('v').to_string())
            })
        }
        _ => None,
    }
}

pub fn is_version_at_least(current: &str, required: &str) -> bool {
    let parse_parts = |v: &str| -> Vec<u32> {
        let main_part = v.split(['-', '+', '_']).next().unwrap_or(v);
        main_part
            .split('.')
            .map(|s| s.parse::<u32>().unwrap_or(0))
            .collect()
    };

    let curr_parts = parse_parts(current);
    let req_parts = parse_parts(required);

    for i in 0..std::cmp::max(curr_parts.len(), req_parts.len()) {
        let curr = curr_parts.get(i).copied().unwrap_or(0);
        let req = req_parts.get(i).copied().unwrap_or(0);
        if curr > req {
            return true;
        }
        if curr < req {
            return false;
        }
    }
    true
}

#[tauri::command]
pub async fn check_rclone_available(app: AppHandle, path: String) -> Result<bool, String> {
    let rclone_binary = resolve_rclone_binary(
        &app,
        if path.is_empty() {
            None
        } else {
            Some(std::path::Path::new(&path))
        },
    );
    debug!("Checking rclone at: {}", rclone_binary.display());

    if rclone_binary.exists() && rclone_binary.is_file() {
        match get_rclone_version(&rclone_binary).await {
            Some(version) => {
                if is_version_at_least(&version, MIN_RCLONE_VERSION) {
                    Ok(true)
                } else {
                    Err(crate::localized_error!(
                        "backendErrors.rclone.versionTooOld",
                        "version" => version,
                        "required" => MIN_RCLONE_VERSION
                    ))
                }
            }
            None => Err(crate::localized_error!(
                "backendErrors.rclone.executionFailed",
                "error" => "Could not determine rclone version"
            )),
        }
    } else {
        if let Err(e) = app.emit(RCLONE_ENGINE_STATUS_CHANGED, EngineStatus::PathError) {
            error!("Failed to emit path error event: {e}");
        }
        Err(crate::localized_error!(
            "backendErrors.rclone.notFound",
            "path" => rclone_binary.display()
        ))
    }
}

pub fn build_rclone_command(
    app: &AppHandle,
    bin_override: Option<&str>,
    config_override: Option<&std::path::Path>,
    args: Option<&[&str]>,
) -> crate::utils::process::command::Command {
    let binary_path = resolve_rclone_binary(app, bin_override.map(std::path::Path::new));
    let mut cmd = crate::utils::process::command::Command::new(binary_path);

    if let Some(cfg) = config_override.filter(|c| !c.to_string_lossy().is_empty()) {
        cmd = cmd.arg("--config").arg(cfg);
    }
    if let Some(a) = args.filter(|a| !a.is_empty()) {
        cmd = cmd.args(a);
    }

    cmd
}

/// Read the configured rclone binary path.
///
/// `core.rclone_binary` stores the **full path to the rclone binary file**.
/// The special value `"system"` means: search the system PATH.
pub fn read_rclone_binary(app: &AppHandle) -> PathBuf {
    let configured: PathBuf = app
        .try_state::<crate::core::settings::AppSettingsManager>()
        .and_then(|m| {
            m.inner()
                .get::<String>("core.rclone_binary")
                .ok()
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| PathBuf::from("system"));

    debug!("Configured rclone binary: {}", configured.to_string_lossy());

    let configured = if configured.to_string_lossy() != "system"
        && !configured.to_string_lossy().is_empty()
        && !configured.to_string_lossy().ends_with(RCLONE_EXECUTABLE)
    {
        configured.join(RCLONE_EXECUTABLE)
    } else {
        configured
    };

    if configured.to_string_lossy() != "system" && configured.is_file() {
        return configured;
    }

    if let Ok(p) = which::which("rclone") {
        info!("Using system rclone at {}", p.display());
        p
    } else {
        error!("rclone binary not found in PATH or at configured location");
        PathBuf::from("rclone")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_version_at_least() {
        assert!(is_version_at_least("1.70.0", "1.70.0"));
        assert!(is_version_at_least("1.70.1", "1.70.0"));
        assert!(is_version_at_least("1.71.0", "1.70.0"));
        assert!(is_version_at_least("1.70.0-DEV", "1.70.0"));
        assert!(!is_version_at_least("1.69.9", "1.70.0"));
        assert!(!is_version_at_least("1.66.0", "1.70.0"));
    }
}
