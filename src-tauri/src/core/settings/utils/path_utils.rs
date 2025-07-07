use crate::RcloneState;
use log::debug;
use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Manager};

/// **Path Utilities for Settings**
///
/// This module contains utility functions for path manipulation and
/// path-related operations used throughout the settings system.
/// **Get the rclone config file path**
///
/// This function queries rclone to determine the location of its configuration file.
/// It uses the rclone binary to get the exact path where the config file is located.
pub fn get_rclone_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let rclone_state = app.state::<RcloneState>();
    let rclone_path = rclone_state.rclone_path.read().unwrap().clone();

    let output = Command::new(&rclone_path)
        .arg("config")
        .arg("file")
        .output()
        .map_err(|e| format!("Failed to execute rclone: {e}"))?;

    debug!("Rclone config output: {output:?}");
    if !output.status.success() {
        return Err("Failed to get rclone config path".to_string());
    }

    let stdout =
        String::from_utf8(output.stdout).map_err(|e| format!("Invalid output from rclone: {e}"))?;

    let path_str = stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .ok_or("Could not parse rclone config path")?
        .trim()
        .to_string();

    debug!("Rclone config path: {path_str}");
    Ok(PathBuf::from(path_str))
}
