use std::path::PathBuf;

use log::{debug, error, info};
use tauri::{AppHandle, Manager};

use crate::utils::rclone::util::RCLONE_EXECUTABLE;

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
        match crate::utils::process::command::Command::new(rclone_binary)
            .arg("--version")
            .output()
            .await
        {
            Ok(output) => Ok(output.status.success()),
            Err(e) => Err(crate::localized_error!(
                "backendErrors.rclone.executionFailed",
                "error" => e
            )),
        }
    } else {
        use crate::utils::types::events::RCLONE_ENGINE_PATH_ERROR;
        use tauri::Emitter;
        if let Err(e) = app.emit(RCLONE_ENGINE_PATH_ERROR, ()) {
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

    match which::which("rclone") {
        Ok(p) => {
            info!("Using system rclone at {}", p.display());
            p
        }
        Err(_) => {
            error!("rclone binary not found in PATH or at configured location");
            PathBuf::from("rclone")
        }
    }
}
