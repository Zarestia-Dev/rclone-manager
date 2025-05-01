use chrono::Utc;
use log::{debug, error, info, warn};
use serde_json::json;
use serde_urlencoded;
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
    core::check_binaries::read_rclone_path,
    rclone::api::state::{
        get_cached_mounted_remotes, RemoteError, RemoteLogEntry, ERROR_CACHE, RCLONE_STATE,
    },
    RcloneState,
};

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
    let rclone_path = read_rclone_path(&app);

    let rclone_process = Command::new(rclone_path)
        .args([
            "rcd",
            "--rc-no-auth",
            "--rc-serve",
            "--rc-addr",
            &format!("127.0.0.1:{}", RCLONE_STATE.get_oauth().1),
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
        RCLONE_STATE.get_oauth().1
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

    app.emit("remote_presence_changed", &name).ok();
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
    let url = format!("http://localhost:{}/core/quit", RCLONE_STATE.get_oauth().1);

    info!("📡 Sending quit request to Rclone OAuth process...");
    if let Err(e) = client.post(&url).send().await {
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
    let url = format!("{}/config/update", RCLONE_STATE.get_api().0);

    state
        .client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    app.emit("remote_presence_changed", name).ok();
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
            RCLONE_STATE.get_api().0,
            name
        ))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    app.emit("remote_presence_changed", name).ok();
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
    ERROR_CACHE
        .add_log(RemoteLogEntry {
            timestamp: Utc::now(),
            remote_name: Some(remote_name.clone()),
            level: "info".to_string(),
            message: format!("Attempting to mount remote at {}", mount_point),
            context: None,
        })
        .await;

    let client = &state.client;

    // 🔍 Step 1: Get mounted remotes
    let mounted_remotes = get_cached_mounted_remotes().await?;

    debug!("Current mounted remotes: {:?}", mounted_remotes);

    let formatted_remote = if remote_name.ends_with(':') {
        remote_name.clone()
    } else {
        format!("{}:", remote_name)
    };

    // 🔎 Step 2: Check if the remote is already mounted
    if mounted_remotes.iter().any(|m| m.fs == formatted_remote) {
        log::info!(
            "✅ Remote {} is already mounted (cached), skipping request.",
            formatted_remote
        );
        return Ok(()); // Skip remount
    }

    let url = format!("{}/mount/mount", RCLONE_STATE.get_api().0);

    // Build JSON payload
    let mut payload = json!({
        "fs": formatted_remote,
        "mountPoint": mount_point,
        "_async": true,  // 🚀 Make this request async
    });

    // Add mount options if provided
    if let Some(mount_opts) = mount_options {
        debug!("Mount options: {:?}", mount_opts);
        payload["mountOpt"] = json!(mount_opts);
        debug!("Mount options JSON: {}", payload["mountOpt"]);
    }

    // Add VFS options if provided
    if let Some(vfs_opts) = vfs_options {
        if !vfs_opts.is_empty() {
            debug!("VFS options: {:?}", vfs_opts);
            payload["vfsOpt"] = json!(vfs_opts);
            debug!("VFS options JSON: {}", payload["vfsOpt"]);
        }
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

        let jobid: Option<u64> = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("jobid").and_then(|id| id.as_u64()));

        if let Some(jobid) = jobid {
            debug!("📦 Waiting for job {} to complete...", jobid);

            let job_status_url = format!("{}/job/status", RCLONE_STATE.get_api().0);

            loop {
                let res = client
                    .post(&job_status_url)
                    .json(&json!({ "jobid": jobid }))
                    .send()
                    .await
                    .map_err(|e| format!("Failed to query job status: {}", e))?;

                let status = res.status();
                let body = res
                    .text()
                    .await
                    .map_err(|e| format!("Failed to read job status response: {}", e))?;

                if status == 500 && body.contains("job not found") {
                    // Treat as already completed (maybe quick and expired)
                    debug!("⚠️ Job {} not found, assuming it finished quickly.", jobid);
                    break;
                }

                if !status.is_success() {
                    return Err(format!("Job status error (HTTP {}): {}", status, body));
                }

                let job: serde_json::Value = serde_json::from_str(&body).map_err(|e| {
                    format!("Failed to parse job status JSON: {}\nBody: {}", e, body)
                })?;

                let finished = job
                    .get("finished")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let success = job
                    .get("success")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                if finished {
                    if success {
                        ERROR_CACHE
                            .add_log(RemoteLogEntry {
                                timestamp: Utc::now(),
                                remote_name: Some(remote_name.clone()),
                                level: "info".to_string(),
                                message: format!("Successfully mounted remote at {}", mount_point),
                                context: None,
                            })
                            .await;
                        debug!("✅ Job {} finished successfully.", jobid);
                        break;
                    } else {
                        // Improved error extraction
                        let error_message = extract_rclone_error(&body);

                        // Create a more detailed log entry
                        ERROR_CACHE
                            .add_log(RemoteLogEntry {
                                timestamp: Utc::now(),
                                remote_name: Some(remote_name.clone()),
                                level: "error".to_string(),
                                message: format!("Mount failed: {}", error_message), // Use the extracted error message
                                context: Some(json!({
                                    "job_id": jobid,
                                    "response": body
                                })),
                            })
                            .await;

                        let error = RemoteError {
                            timestamp: Utc::now(),
                            remote_name: remote_name.clone(),
                            operation: "mount".to_string(),
                            error: error_message.clone(),
                            details: Some(json!({
                                "mount_point": mount_point,
                                "job_id": jobid,
                                "response": body
                            })),
                        };

                        ERROR_CACHE.add_error(error.clone()).await;

                        debug!("❌ Job {} failed: {}", jobid, error_message);
                        return Err(error_message);
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        } // ✅ Now emit, after the remote is actually mounted

        app.emit("remote_state_changed", remote_name).ok();
        Ok(())
    } else {
        let error_message = extract_rclone_error(&body);
        let error = RemoteError {
            timestamp: Utc::now(),
            remote_name: remote_name.clone(),
            operation: "mount".to_string(),
            error: format!("Mount request failed (HTTP {}): {}", status, body),
            details: Some(json!({
                "mount_point": mount_point,
                "status": status.as_u16(),
                "response": body
            })),
        };
        ERROR_CACHE.add_error(error).await;
        ERROR_CACHE
            .add_log(RemoteLogEntry {
                timestamp: Utc::now(),
                remote_name: Some(remote_name.clone()),
                level: "error".to_string(),
                message: error_message.clone(),
                context: Some(json!({"response": body})),
            })
            .await;
        Err(error_message)
    }
}

#[command]
pub async fn unmount_remote(
    app: tauri::AppHandle,
    mount_point: String,
    remote_name: String,
    state: State<'_, RcloneState>,
) -> Result<String, String> {
    let mount_point = mount_point.trim();
    if mount_point.is_empty() {
        return Err("Empty mount point provided".to_string());
    }
    if mount_point.is_empty() {
        let error = "Empty mount point provided".to_string();
        ERROR_CACHE
            .add_log(RemoteLogEntry {
                timestamp: Utc::now(),
                remote_name: Some(remote_name.clone()),
                level: "error".to_string(),
                message: error.clone(),
                context: None,
            })
            .await;
        return Err(error);
    }

    // Log unmount attempt
    ERROR_CACHE
        .add_log(RemoteLogEntry {
            timestamp: Utc::now(),
            remote_name: Some(remote_name.clone()),
            level: "info".to_string(),
            message: format!("Attempting to unmount: {}", mount_point),
            context: None,
        })
        .await;

    let url = format!("{}/mount/unmount", RCLONE_STATE.get_api().0);
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

    app.emit("remote_state_changed", mount_point).ok();
    if response.status().is_success() {
        ERROR_CACHE
            .add_log(RemoteLogEntry {
                timestamp: Utc::now(),
                remote_name: Some(remote_name.clone()),
                level: "info".to_string(),
                message: format!("Successfully unmounted {}", mount_point),
                context: None,
            })
            .await;
        info!("Successfully unmounted {}", mount_point);
        Ok(format!("Successfully unmounted {}", mount_point))
    } else {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let error_message = extract_rclone_error(&body);
        let error = RemoteError {
            timestamp: Utc::now(),
            remote_name: remote_name.clone(),
            operation: "unmount".to_string(),
            error: format!("Failed to unmount {}: HTTP {}", mount_point, status),
            details: Some(json!({
                "status": status.as_u16(),
                "response": body
            })),
        };

        ERROR_CACHE.add_error(error).await;

        ERROR_CACHE
            .add_log(RemoteLogEntry {
                timestamp: Utc::now(),
                remote_name: Some(remote_name.clone()),
                level: "error".to_string(),
                message: error_message.clone(),
                context: Some(json!({"response": body})),
            })
            .await;
        error!("{}", error_message.clone());
        Err(error_message)
    }
}

/// Unmounts all currently mounted remotes using rclone's API.
pub async fn unmount_all_remotes(
    app: tauri::AppHandle,
    state: tauri::State<'_, RcloneState>,
    state_name: &str,
) -> Result<String, String> {
    let url = format!("{}/mount/unmountall", RCLONE_STATE.get_api().0);
    let params = serde_json::json!({});
    debug!("Attempting to unmount all remotes");
    let response = state
        .client
        .post(&url)
        .json(&params)
        .send()
        .await
        .map_err(|e| {
            error!("Network error unmounting all remotes: {}", e);
            format!("Failed to connect to rclone API: {}", e)
        })?;

    if state_name != "shutdown" {
        app.emit("remote_state_changed", "all").ok();
    }
    if response.status().is_success() {
        info!("Successfully unmounted all remotes");
        Ok("Successfully unmounted all remotes".to_string())
    } else {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        error!("Failed to unmount all remotes: {} - {}", status, body);
        Err(format!("Rclone API error: {} - {}", status, body))
    }
}

#[derive(Debug, serde::Deserialize)]
struct SyncJobResponse {
    jobid: String,
}

#[command]
pub async fn start_sync(
    source: &str,
    dest: &str,
    sync_options: Option<HashMap<String, serde_json::Value>>,
    filter_options: Option<HashMap<String, serde_json::Value>>,
    state: State<'_, RcloneState>,
) -> Result<String, String> {
    let mut query_params = vec![
        ("srcFs", source.to_string()),
        ("dstFs", dest.to_string()),
        ("_async", "true".to_string()),
    ];

    if let Some(sync_opts) = sync_options {
        query_params.push((
            "_config",
            serde_json::to_string(&sync_opts).map_err(|e| e.to_string())?,
        ));
    }

    if let Some(filter_opts) = filter_options {
        query_params.push((
            "_filter",
            serde_json::to_string(&filter_opts).map_err(|e| e.to_string())?,
        ));
    }

    let query_string = serde_urlencoded::to_string(query_params);
    let query_string = query_string.map_err(|e| e.to_string())?;
    let url = format!("{}/sync/sync?{}", RCLONE_STATE.get_api().0, query_string);

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())? // fails if response is not 2xx
        .json::<SyncJobResponse>()
        .await
        .map_err(|e| e.to_string())?;

    Ok(response.jobid)
}

#[derive(Debug, serde::Deserialize)]
struct CopyJobResponse {
    jobid: String,
}

#[command]
pub async fn start_copy(
    source: &str,
    dest: &str,
    copy_options: Option<HashMap<String, serde_json::Value>>,
    filter_options: Option<HashMap<String, serde_json::Value>>,
    state: State<'_, RcloneState>,
) -> Result<String, String> {
    let mut query_params = vec![
        ("srcFs", source.to_string()),
        ("dstFs", dest.to_string()),
        ("_async", "true".to_string()),
    ];

    if let Some(copy_opts) = copy_options {
        query_params.push((
            "_config",
            serde_json::to_string(&copy_opts).map_err(|e| e.to_string())?,
        ));
    }

    if let Some(filter_opts) = filter_options {
        query_params.push((
            "_filter",
            serde_json::to_string(&filter_opts).map_err(|e| e.to_string())?,
        ));
    }

    let query_string = serde_urlencoded::to_string(query_params).map_err(|e| e.to_string())?;
    let url = format!("{}/sync/copy?{}", RCLONE_STATE.get_api().0, query_string);

    let response = state
        .client
        .post(&url)
        // If you want to add auth headers:
        // .header("Authorization", "Bearer <token>")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())? // ensures non-2xx errors are caught
        .json::<CopyJobResponse>()
        .await
        .map_err(|e| e.to_string())?;

    Ok(response.jobid)
}

fn extract_rclone_error(response_body: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(response_body) {
        Ok(json) => {
            json.get("error")
                .and_then(|err| err.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    debug!("No error field in response");
                    response_body.to_string()
                })
        }
        Err(_) => {
            debug!("Failed to parse response as JSON");
            response_body.to_string()
        }
    }
}
