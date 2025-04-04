use log::{debug, error, info, warn};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::Duration,
};
use tauri::State;
use tauri::{command, Emitter};
use tokio::time::sleep;

use crate::{
    rclone::api::{engine::RCLONE_PATH, state::get_rclone_oauth_port_global},
    RcloneState,
};

use super::{api_query::get_mounted_remotes, state::get_rclone_api_url_global};

lazy_static::lazy_static! {
    static ref OAUTH_PROCESS: Arc<tokio::sync::Mutex<Option<Child>>> = Arc::new(tokio::sync::Mutex::new(None));
}

#[tauri::command]
pub async fn create_remote(
    app: tauri::AppHandle,
    name: String,
    parameters: serde_json::Value,
    state: State<'_, RcloneState>,
) -> Result<(), String> {
    let remote_type = parameters
        .get("type")
        .and_then(|v| v.as_str())
        .ok_or("Missing remote type")?;

    // ✅ Acquire the lock first
    {
        let guard = OAUTH_PROCESS.lock().await;
        if guard.is_some() {
            info!("🔴 Stopping existing OAuth authentication process...");
            drop(guard); // ✅ Release the lock here
            quit_rclone_oauth().await?; // ✅ Call quit AFTER releasing the lock
        }
    } // ✅ Guard is dropped when this scope ends

    // ✅ Start a new Rclone instance
    let rclone_path = {
        let rclone_path = RCLONE_PATH.read().unwrap();
        if rclone_path.is_empty() {
            return Err("Rclone path is not set.".into());
        }
        rclone_path.clone()
    };

    let rclone_process = Command::new(rclone_path)
        .args([
            "rcd",
            "--rc-no-auth",
            "--rc-serve",
            "--rc-addr",
            &format!("localhost:{}", get_rclone_oauth_port_global()),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start separate Rclone instance: {}", e))?;

    debug!("Started Rclone process with PID: {:?}", rclone_process.id());
    // ✅ Lock again and store the new process
    {
        let mut guard = OAUTH_PROCESS.lock().await;
        *guard = Some(rclone_process);
    }

    // ✅ Give Rclone a moment to start
    sleep(Duration::from_secs(2)).await;

    let client = &state.client;
    let body = serde_json::json!({
        "name": name,
        "type": remote_type,
        "parameters": parameters
    });

    let url = format!(
        "http://localhost:{}/config/create",
        get_rclone_oauth_port_global()
    );

    let response = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;

    let response_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    // ✅ Detect OAuth errors
    if response_text.contains("failed to get oauth token") {
        return Err(
            "OAuth authentication was not completed. Please authenticate in the browser."
                .to_string(),
        );
    }
    if response_text.contains("bind: address already in use") {
        return Err("OAuth authentication failed because the port is already in use.".to_string());
    }
    if response_text.contains("couldn't find type field in config") {
        return Err("Configuration update failed due to a missing type field.".to_string());
    }

    app.emit("remote_state_changed", &name).ok();
    info!("✅ Remote created successfully: {}", name);
    Ok(())
}

#[tauri::command]
pub async fn quit_rclone_oauth() -> Result<(), String> {
    debug!("🔄 Attempting to quit Rclone OAuth process...");

    let mut guard = OAUTH_PROCESS.lock().await;
    if guard.is_none() {
        warn!("⚠️ No active Rclone OAuth process found.");
        return Err("No active Rclone OAuth process found.".to_string());
    }

    let client = reqwest::Client::new();
    let url = format!(
        "http://localhost:{}/core/quit",
        get_rclone_oauth_port_global()
    );

    info!("📡 Sending quit request to Rclone OAuth process...");
    if let Err(e) = client.post(url).send().await {
        error!("❌ Failed to send quit request: {}", e);
    }

    if let Some(mut process) = guard.take() {
        match process.wait() {
            Ok(status) => info!("✅ Rclone OAuth process exited with status: {:?}", status),
            Err(_) => {
                warn!("⚠️ Rclone OAuth process still running. Attempting to kill...");
                if let Err(kill_err) = process.kill() {
                    error!("💀 Failed to force-kill process: {}", kill_err);
                    return Err(format!(
                        "Failed to terminate Rclone OAuth process: {}",
                        kill_err
                    ));
                } else {
                    info!("💀 Successfully killed Rclone OAuth process.");
                }
            }
        }
    }

    debug!("✅ Rclone OAuth process cleanup complete.");
    Ok(())
}


/// Update an existing remote
#[command]
pub async fn update_remote(
    app: tauri::AppHandle,
    name: String,
    parameters: HashMap<String, serde_json::Value>,
    state: State<'_, RcloneState>,
) -> Result<(), String> {
    let body = serde_json::json!({ "name": name, "parameters": parameters });
    let url = format!("{}/config/update", get_rclone_api_url_global());

    state
        .client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    app.emit("remote_state_changed", name).ok();
    Ok(())
}

/// Delete a remote
#[command]
pub async fn delete_remote(
    app: tauri::AppHandle,
    name: String,
    state: State<'_, RcloneState>,
) -> Result<(), String> {
    state
        .client
        .post(format!(
            "{}/config/delete?name={}",
            get_rclone_api_url_global(),
            name
        ))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    app.emit("remote_state_changed", name).ok();
    Ok(())
}

///  Operations (Mount/Unmount etc)

#[command]
pub async fn mount_remote(
    app: tauri::AppHandle,
    remote_name: String,
    mount_point: String,
    mount_options: Option<HashMap<String, serde_json::Value>>,
    vfs_options: Option<HashMap<String, serde_json::Value>>,
    state: State<'_, RcloneState>,
) -> Result<(), String> {
    let client = &state.client;

    // 🔍 Step 1: Get mounted remotes
    let mounted_remotes = get_mounted_remotes(state.clone())
        .await
        .unwrap_or_else(|e| {
            log::error!("Failed to fetch mounted remotes: {}", e);
            vec![] // If we fail to fetch, assume no mounts (fail-safe)
        });

    let formatted_remote = if remote_name.ends_with(':') {
        remote_name.clone()
    } else {
        format!("{}:", remote_name)
    };

    // 🔎 Step 2: Check if the remote is already mounted
    if mounted_remotes.iter().any(|m| m.fs == formatted_remote) {
        log::info!(
            "✅ Remote {} is already mounted, skipping request.",
            formatted_remote
        );
        return Ok(()); // Exit early if already mounted
    }

    let url = format!("{}/mount/mount", get_rclone_api_url_global());

    // Build JSON payload
    let mut payload = json!({
        "fs": formatted_remote,
        "mountPoint": mount_point,
        "_async": true,  // 🚀 Make this request async
    });

    // Add mount options if provided
    if let Some(mount_opts) = mount_options {
        payload["mountOpt"] = json!(mount_opts);
    }

    // Add VFS options if provided
    if let Some(vfs_opts) = vfs_options {
        payload["vfsOpt"] = json!(vfs_opts
            .into_iter()
            .map(|(key, value)| {
                match value {
                    Value::String(s) if s.is_empty() => (key, Value::Bool(false)), // Convert empty strings to false
                    other => (key, other),
                }
            })
            .collect::<serde_json::Map<_, _>>());
    }

    // 🚀 Step 3: Send HTTP POST request to mount the remote
    let response = client
        .post(url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;

    // Parse response
    let status = response.status();
    let body = response
        .text()
        .await
        .unwrap_or_else(|_| "No response body".to_string());

    if status.is_success() {
        debug!("✅ Mount request successful: {}", body);
        app.emit("remote_state_changed", remote_name).ok();
        Ok(())
    } else {
        Err(format!(
            "❌ Mount request failed: {} (HTTP {})",
            body, status
        ))
    }
}

#[command]
pub async fn unmount_remote(
    app: tauri::AppHandle,
    mount_point: String,
    state: State<'_, RcloneState>,
) -> Result<String, String> {
    let mount_point = mount_point.trim();
    if mount_point.is_empty() {
        return Err("Empty mount point provided".to_string());
    }

    let url = format!("{}/mount/unmount", get_rclone_api_url_global());
    let params = serde_json::json!({ "mountPoint": mount_point });

    debug!("Attempting to unmount: {}", mount_point);

    let response = state
        .client
        .post(&url)
        .json(&params)
        .send()
        .await
        .map_err(|e| {
            error!("Network error unmounting {}: {}", mount_point, e);
            format!("Failed to connect to rclone API: {}", e)
        })?;

    if response.status().is_success() {
        info!("Successfully unmounted {}", mount_point);
        app.emit("remote_state_changed", mount_point).ok();
        Ok(format!("Successfully unmounted {}", mount_point))
    } else {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        error!("Failed to unmount {}: {} - {}", mount_point, status, body);
        Err(format!("Rclone API error: {} - {}", status, body))
    }
}

/// Unmounts all currently mounted remotes using rclone's API.
pub async fn unmount_all_remotes(
    app: tauri::AppHandle,
    state: tauri::State<'_, RcloneState>,
) -> Result<(usize, usize), String> {
    // Step 1: Get the list of mounted remotes
    let mounts = match get_mounted_remotes(state.clone()).await {
        Ok(mounts) => mounts,
        Err(e) => {
            error!("Failed to list mounts: {}", e);
            return Err(format!("Could not retrieve mount list: {}", e));
        }
    };

    let total_mounts = mounts.len();
    if total_mounts == 0 {
        debug!("No mounts found to unmount");
        return Ok((0, 0));
    }

    info!("Found {} mounts to unmount", total_mounts);

    // Step 2: Unmount each one with proper error handling
    let mut success_count = 0;
    let mut errors = Vec::new();

    for mount in mounts {
        let mount_point = mount.mount_point.clone();
        debug!("Unmounting {}", mount_point);

        match unmount_remote(app.clone(), mount_point.clone(), state.clone()).await {
            Ok(_) => {
                success_count += 1;
                info!("Successfully unmounted {}", mount_point);
            }
            Err(e) => {
                error!("Failed to unmount {}: {}", mount_point, e);
                errors.push((mount_point, e));
            }
        }
    }
    // Step 3: Verify all mounts were successfully unmounted
    if !errors.is_empty() {
        let error_msg = errors
            .iter()
            .map(|(mp, e)| format!("{}: {}", mp, e))
            .collect::<Vec<_>>()
            .join(", ");

        warn!("Failed to unmount some remotes: {}", error_msg);

        if success_count == 0 {
            return Err(format!("Failed to unmount any mounts: {}", error_msg));
        }

        return Ok((success_count, total_mounts));
    }

    Ok((success_count, total_mounts))
}