use chrono::Utc;
use log::{debug, error, info, warn};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};
use tokio::net::TcpStream;
use tokio::{sync::Mutex, time::sleep};

use crate::{
    core::check_binaries::read_rclone_path,
    rclone::api::state::{
        clear_logs_for_remote, get_cached_mounted_remotes, ActiveJob, RemoteError, RemoteLogEntry,
        ERROR_CACHE, JOB_CACHE, RCLONE_STATE,
    },
    RcloneState,
};

use super::state::SENSITIVE_KEYS;

lazy_static::lazy_static! {
    static ref OAUTH_PROCESS: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
}

fn redact_sensitive_values(params: &HashMap<String, Value>) -> Value {
    params
        .iter()
        .map(|(k, v)| {
            let value = if SENSITIVE_KEYS
                .iter()
                .any(|sk| k.to_lowercase().contains(sk))
            {
                json!("[RESTRICTED]")
            } else {
                v.clone()
            };
            (k.clone(), value)
        })
        .collect()
}

// Helper functions
async fn log_operation(
    level: &str,
    remote_name: Option<String>,
    message: String,
    context: Option<Value>,
) {
    ERROR_CACHE
        .add_log(RemoteLogEntry {
            timestamp: Utc::now(),
            remote_name,
            level: level.to_string(),
            message,
            context,
        })
        .await;
}

async fn log_error(
    remote_name: Option<String>,
    operation: &str,
    error: String,
    details: Option<Value>,
) -> RemoteError {
    let error_entry = RemoteError {
        timestamp: Utc::now(),
        remote_name: remote_name.clone().unwrap_or_default(),
        operation: operation.to_string(),
        error: error.clone(),
        details,
    };

    ERROR_CACHE.add_error(error_entry.clone()).await;
    log_operation(
        "error",
        remote_name,
        format!("{} failed: {}", operation, error),
        error_entry.details.clone(),
    )
    .await;
    error_entry
}

async fn ensure_oauth_process(app: &AppHandle) -> Result<(), String> {
    let mut guard = OAUTH_PROCESS.lock().await;
    let port = RCLONE_STATE.get_oauth().1;

    // Check if process is already running (in memory or port open)
    let mut process_running = guard.is_some();
    if !process_running {
        let addr = format!("127.0.0.1:{}", port);
        if TcpStream::connect(&addr).await.is_ok() {
            process_running = true;
            warn!(
                "⚠️ Rclone OAuth process already running (port {} in use)",
                port
            );
        }
    } else {
        warn!("⚠️ Rclone OAuth process already running (tracked in memory)");
    }

    // Only start a new process if not already running
    if !process_running {
        let rclone_path = read_rclone_path(app);
        let mut oauth_app = Command::new(&rclone_path);
        oauth_app // Use oauth_app instead of Command::new(rclone_path)
            .args([
                "rcd",
                "--rc-no-auth",
                "--rc-serve",
                "--rc-addr",
                &format!("127.0.0.1:{}", port),
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        // This is a workaround for Windows to avoid showing a console window
        // when starting the Rclone process.
        // It uses the CREATE_NO_WINDOW and DETACHED_PROCESS flags.
        // But it may not work in all cases. Like when app build for terminal
        // and not for GUI. Rclone may still try to open a console window.
        // You can see the flashing of the console window when starting the app.
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            oauth_app.creation_flags(0x08000000 | 0x00200000);
        }

        let process = oauth_app.spawn().map_err(|e| {
            format!(
                "Failed to start Rclone OAuth process: {}. Ensure Rclone is installed and in PATH.",
                e
            )
        })?;

        *guard = Some(process);
        sleep(Duration::from_secs(2)).await; // Wait for process to start
    }
    Ok(())
}

/// Create a new remote configuration
#[tauri::command]
pub async fn create_remote(
    app: AppHandle,
    name: String,
    parameters: Value,
    state: State<'_, RcloneState>,
) -> Result<(), String> {
    let remote_type = parameters
        .get("type")
        .and_then(|v| v.as_str())
        .ok_or("Missing remote type")?;

    // Enhanced logging with parameter values
    let params_map: HashMap<String, Value> = parameters
        .as_object()
        .ok_or("Parameters must be an object")?
        .clone()
        .into_iter()
        .collect();
    let params_obj = redact_sensitive_values(&params_map);

    log_operation(
        "info",
        Some(name.clone()),
        "Creating new remote".to_string(),
        Some(json!({
            "type": remote_type,
            "parameters": params_obj
        })),
    )
    .await;

    // Handle OAuth process
    ensure_oauth_process(&app).await?;

    let body = json!({
        "name": name,
        "type": remote_type,
        "parameters": parameters
    });

    let url = format!(
        "http://127.0.0.1:{}/config/create",
        RCLONE_STATE.get_oauth().1
    );

    let response = state
        .client
        .post(&url)
        .timeout(Duration::from_secs(30))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    println!("Response: {}", body);

    if !status.is_success() {
        let error = if body.contains("failed to get oauth token") {
            "OAuth authentication failed or was not completed".to_string()
        } else if body.contains("bind: address already in use") {
            format!("Port {} already in use", RCLONE_STATE.get_oauth().1)
        } else {
            format!("HTTP {}: {}", status, body)
        };

        let _ = log_error(
            Some(name.clone()),
            "create_remote",
            error.clone(),
            Some(json!({"response": body})),
        )
        .await;

        return Err(error);
    }

    log_operation(
        "info",
        Some(name.clone()),
        "Remote created successfully".to_string(),
        None,
    )
    .await;

    app.emit("remote_presence_changed", &name)
        .map_err(|e| format!("Failed to emit event: {}", e))?;

    Ok(())
}

/// Update an existing remote configuration
#[tauri::command]
pub async fn update_remote(
    app: AppHandle,
    name: String,
    parameters: HashMap<String, Value>,
    state: State<'_, RcloneState>,
) -> Result<(), String> {
    let remote_type = parameters
        .get("type")
        .and_then(|v| v.as_str())
        .ok_or("Missing remote type")?;

    // Enhanced logging with parameter values
    let params_obj = redact_sensitive_values(&parameters);

    log_operation(
        "info",
        Some(name.clone()),
        "Updating remote".to_string(),
        Some(json!({
            "type": remote_type,
            "parameters": params_obj
        })),
    )
    .await;

    ensure_oauth_process(&app).await?;

    let url = format!(
        "http://127.0.0.1:{}/config/update",
        RCLONE_STATE.get_oauth().1
    );
    let body = json!({ "name": name, "parameters": parameters });

    let response = state
        .client
        .post(&url)
        .timeout(Duration::from_secs(30))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = format!("HTTP {}: {}", status, body);
        let _ = log_error(
            Some(name.clone()),
            "update_remote",
            error.clone(),
            Some(json!({"response": body})),
        )
        .await;
        return Err(error);
    }

    log_operation(
        "info",
        Some(name.clone()),
        "Remote updated successfully".to_string(),
        None,
    )
    .await;

    app.emit("remote_presence_changed", &name)
        .map_err(|e| format!("Failed to emit event: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn delete_remote(
    app: AppHandle,
    name: String,
    state: State<'_, RcloneState>,
) -> Result<(), String> {
    info!("🗑️ Deleting remote: {}", name);

    let url = format!("{}/config/delete", RCLONE_STATE.get_api().0);

    let response = state
        .client
        .post(&url)
        .query(&[("name", &name)])
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let error = format!("HTTP {}: {}", status, body);
        error!("❌ Failed to delete remote: {}", error);
        return Err(error);
    }

    // Emit two events:
    // 1. The standard presence changed event
    app.emit("remote_presence_changed", &name)
        .map_err(|e| format!("Failed to emit event: {}", e))?;

    // 2. A new specific event for deletion
    app.emit("remote_deleted", &name)
        .map_err(|e| format!("Failed to emit event: {}", e))?;

    clear_logs_for_remote(name.clone())
        .await
        .unwrap_or_default();
    info!("✅ Remote {} deleted successfully", name);
    Ok(())
}

/// Mount a remote filesystem
#[tauri::command]
pub async fn mount_remote(
    app: AppHandle,
    remote_name: String,
    mount_point: String,
    mount_options: Option<HashMap<String, Value>>,
    vfs_options: Option<HashMap<String, Value>>,
    state: State<'_, RcloneState>,
) -> Result<(), String> {
    if mount_point.trim().is_empty() {
        return Err("Mount point cannot be empty".to_string());
    }

    let mounted_remotes = get_cached_mounted_remotes().await?;
    // Check if the mount point is already in use
    if mounted_remotes.iter().any(|m| m.mount_point == mount_point) {
        let error_msg = format!(
            "Mount point {} is already in use by remote {}",
            mount_point,
            mounted_remotes
                .iter()
                .find(|m| m.mount_point == mount_point)
                .map(|m| m.fs.clone())
                .unwrap_or_default()
        );
        warn!("{}", error_msg);
        return Err(error_msg);
    }

    // Check if the remote is already mounted (by name)
    if mounted_remotes.iter().any(|m| m.fs == remote_name) {
        info!("Remote {} already mounted", remote_name);
        return Ok(());
    }

    // Enhanced logging with values
    let mut log_context = json!({
        "mount_point": mount_point,
        "remote_name": remote_name
    });

    if let Some(opts) = &mount_options {
        log_context["mount_options"] = redact_sensitive_values(opts);
    }

    if let Some(opts) = &vfs_options {
        log_context["vfs_options"] = redact_sensitive_values(opts);
    }

    log_operation(
        "info",
        Some(remote_name.clone()),
        format!("Attempting to mount at {}", mount_point),
        Some(log_context),
    )
    .await;

    let mut payload = json!({
        "fs": remote_name,
        "mountPoint": mount_point,
        "_async": true,
    });

    if let Some(opts) = mount_options {
        payload["mountOpt"] = json!(opts);
    }

    if let Some(opts) = vfs_options {
        payload["vfsOpt"] = json!(opts);
    }

    let url = format!("{}/mount/mount", RCLONE_STATE.get_api().0);

    let response = state
        .client
        .post(&url)
        .timeout(Duration::from_secs(30))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = format!("HTTP {}: {}", status, body);
        let _ = log_error(
            Some(remote_name.clone()),
            "mount_remote",
            error.clone(),
            Some(json!({"response": body})),
        )
        .await;
        return Err(error);
    }

    let jobid: Option<u64> = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| v.get("jobid").and_then(|id| id.as_u64()));

    if let Some(jobid) = jobid {
        let job_status_url = format!("{}/job/status", RCLONE_STATE.get_api().0);

        loop {
            let res = state
                .client
                .post(&job_status_url)
                .json(&json!({ "jobid": jobid }))
                .timeout(Duration::from_secs(10))
                .send()
                .await
                .map_err(|e| format!("Failed to query job status: {}", e))?;

            let status = res.status();
            let body = res
                .text()
                .await
                .map_err(|e| format!("Failed to read response: {}", e))?;

            if status == 500 && body.contains("job not found") {
                break;
            }

            if !status.is_success() {
                let error = format!("HTTP {}: {}", status, body);
                let _ = log_error(
                    Some(remote_name.clone()),
                    "mount_remote",
                    error.clone(),
                    Some(json!({"jobid": jobid, "response": body})),
                )
                .await;
                return Err(error);
            }

            let job: Value = serde_json::from_str(&body)
                .map_err(|e| format!("Failed to parse response: {}", e))?;

            if job
                .get("finished")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                if job
                    .get("success")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                {
                    log_operation(
                        "info",
                        Some(remote_name.clone()),
                        format!("Successfully mounted at {}", mount_point),
                        None,
                    )
                    .await;
                    break;
                } else {
                    let error = job
                        .get("error")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Unknown error")
                        .to_string();

                    let _ = log_error(
                        Some(remote_name.clone()),
                        "mount_remote",
                        error.clone(),
                        Some(json!({"jobid": jobid, "response": body})),
                    )
                    .await;
                    return Err(error);
                }
            }

            sleep(Duration::from_millis(500)).await;
        }
    }

    app.emit("remote_state_changed", &remote_name)
        .map_err(|e| format!("Failed to emit event: {}", e))?;

    Ok(())
}

/// Unmount a remote filesystem
#[tauri::command]
pub async fn unmount_remote(
    app: AppHandle,
    mount_point: String,
    remote_name: String,
    state: State<'_, RcloneState>,
) -> Result<String, String> {
    if mount_point.trim().is_empty() {
        return Err("Mount point cannot be empty".to_string());
    }

    log_operation(
        "info",
        Some(remote_name.clone()),
        format!("Attempting to unmount {}", mount_point),
        None,
    )
    .await;

    let url = format!("{}/mount/unmount", RCLONE_STATE.get_api().0);
    let payload = json!({ "mountPoint": mount_point });

    let response = state
        .client
        .post(&url)
        .timeout(Duration::from_secs(10))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        if status.as_u16() == 500 && body.contains("\"mount not found\"") {
            warn!(
                "🚨 Mount not found for {}, updating mount cache",
                mount_point
            );
            // Update the cached mounted remotes
            app.emit("remote_state_changed", &mount_point)
                .map_err(|e| format!("Failed to emit event: {}", e))?;
        }

        let error = format!("HTTP {}: {}", status, body);
        let _ = log_error(
            Some(remote_name.clone()),
            "unmount_remote",
            error.clone(),
            Some(json!({"response": body})),
        )
        .await;

        return Err(error);
    }

    log_operation(
        "info",
        Some(remote_name.clone()),
        format!("Successfully unmounted {}", mount_point),
        None,
    )
    .await;

    app.emit("remote_state_changed", &mount_point)
        .map_err(|e| format!("Failed to emit event: {}", e))?;

    Ok(format!("Successfully unmounted {}", mount_point))
}

/// Unmount all remotes
#[tauri::command]
pub async fn unmount_all_remotes(
    app: AppHandle,
    state: State<'_, RcloneState>,
    context: String,
) -> Result<String, String> {
    info!("🗑️ Unmounting all remotes");

    let url = format!("{}/mount/unmountall", RCLONE_STATE.get_api().0);

    let response = state
        .client
        .post(&url)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = format!("HTTP {}: {}", status, body);
        error!("❌ Failed to unmount all remotes: {}", error);
        return Err(error);
    }

    if context != "shutdown" {
        app.emit("remote_state_changed", "all")
            .map_err(|e| format!("Failed to emit event: {}", e))?;
    }

    info!("✅ All remotes unmounted successfully");

    Ok("✅ All remotes unmounted successfully".to_string())
}

/// Start a sync operation
#[tauri::command]
pub async fn start_sync(
    app: AppHandle,
    source: String,
    dest: String,
    sync_options: Option<HashMap<String, Value>>,
    filter_options: Option<HashMap<String, Value>>,
    state: State<'_, RcloneState>,
) -> Result<u64, String> {
    use serde_json::{Map, Value};

    log_operation(
        "info",
        None,
        format!("Starting sync from {} to {}", source, dest),
        Some(json!({
            "options": sync_options.as_ref().map(|o| o.keys().collect::<Vec<_>>()),
            "filters": filter_options.as_ref().map(|f| f.keys().collect::<Vec<_>>())
        })),
    )
    .await;

    // Construct the JSON body
    let mut body = Map::new();
    body.insert("srcFs".to_string(), Value::String(source.clone()));
    body.insert("dstFs".to_string(), Value::String(dest.clone()));
    body.insert("_async".to_string(), Value::Bool(true));

    if let Some(opts) = sync_options {
        body.insert(
            "_config".to_string(),
            Value::Object(opts.into_iter().collect()),
        );
    }

    if let Some(filters) = filter_options {
        body.insert(
            "_filter".to_string(),
            Value::Object(filters.into_iter().collect()),
        );
    }

    debug!("Sync request body: {:#?}", body);

    let url = format!("{}/sync/sync", RCLONE_STATE.get_api().0);

    let response = state
        .client
        .post(&url)
        .json(&Value::Object(body)) // send JSON body
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let body_text = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = format!("HTTP {}: {}", status, body_text);
        let _ = log_error(
            None,
            "start_sync",
            error.clone(),
            Some(json!({"response": body_text})),
        )
        .await;
        return Err(error);
    }

    #[derive(serde::Deserialize)]
    struct JobResponse {
        jobid: u64,
    }

    let job: JobResponse =
        serde_json::from_str(&body_text).map_err(|e| format!("Failed to parse response: {}", e))?;

    log_operation(
        "info",
        None,
        format!("Sync job started with ID {}", job.jobid),
        Some(json!({"jobid": job.jobid})),
    )
    .await;

    let jobid = job.jobid;
    JOB_CACHE
        .add_job(ActiveJob {
            jobid,
            job_type: "sync".to_string(),
            remote_name: source.split(':').next().unwrap_or("").to_string(),
            source: source.clone(),
            destination: dest.clone(),
            start_time: Utc::now(),
            status: "running".to_string(),
            stats: None,
        })
        .await;

    // Start monitoring the job
    let app_clone = app.clone();
    let client = state.client.clone();
    tauri::async_runtime::spawn(async move {
        monitor_job(jobid, app_clone, client).await;
    });

    app.emit("sync_job_started", &job.jobid)
        .map_err(|e| format!("Failed to emit event: {}", e))?;

    Ok(job.jobid)
}

/// Stop a running job
#[tauri::command]
pub async fn stop_job(jobid: u64, state: State<'_, RcloneState>) -> Result<(), String> {
    let url = format!("{}/job/stop", RCLONE_STATE.get_api().0);
    let payload = json!({ "jobid": jobid });

    let response = state
        .client
        .post(&url)
        .timeout(Duration::from_secs(10))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = format!("HTTP {}: {}", status, body);
        error!("❌ Failed to stop job {}: {}", jobid, error);
        return Err(error);
    }

    // Remove job from cache after stopping
    JOB_CACHE.remove_job(jobid).await.ok();

    info!("✅ Stopped job {}", jobid);
    Ok(())
}

/// Start a copy operation
#[tauri::command]
pub async fn start_copy(
    app: AppHandle,
    source: String,
    dest: String,
    copy_options: Option<HashMap<String, Value>>,
    filter_options: Option<HashMap<String, Value>>,
    state: State<'_, RcloneState>,
) -> Result<String, String> {
    log_operation(
        "info",
        None,
        format!("Starting copy from {} to {}", source, dest),
        Some(json!({
            "options": copy_options.as_ref().map(|o| o.keys().collect::<Vec<_>>()),
            "filters": filter_options.as_ref().map(|f| f.keys().collect::<Vec<_>>())
        })),
    )
    .await;

    let mut query = vec![
        ("srcFs", source),
        ("dstFs", dest),
        ("_async", "true".to_string()),
    ];

    if let Some(opts) = copy_options {
        query.push((
            "_config",
            serde_json::to_string(&opts).map_err(|e| e.to_string())?,
        ));
    }

    if let Some(filters) = filter_options {
        query.push((
            "_filter",
            serde_json::to_string(&filters).map_err(|e| e.to_string())?,
        ));
    }

    let url = format!("{}/sync/copy", RCLONE_STATE.get_api().0);
    let query_str = serde_urlencoded::to_string(&query).map_err(|e| e.to_string())?;

    let response = state
        .client
        .post(&url)
        .query(&[("", &query_str)])
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = format!("HTTP {}: {}", status, body);
        let _ = log_error(
            None,
            "start_copy",
            error.clone(),
            Some(json!({"response": body})),
        )
        .await;
        return Err(error);
    }

    #[derive(serde::Deserialize)]
    struct JobResponse {
        jobid: String,
    }

    let job: JobResponse =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse response: {}", e))?;

    log_operation(
        "info",
        None,
        format!("Copy job started with ID {}", job.jobid),
        Some(json!({"jobid": job.jobid})),
    )
    .await;

    app.emit("copy_job_started", &job.jobid)
        .map_err(|e| format!("Failed to emit event: {}", e))?;

    Ok(job.jobid)
}

async fn monitor_job(jobid: u64, app: AppHandle, client: reqwest::Client) {
    let job_status_url = format!("{}/job/status", RCLONE_STATE.get_api().0);
    let stats_url = format!("{}/core/stats", RCLONE_STATE.get_api().0);

    loop {
        // Check job status
        let status_res = client
            .post(&job_status_url)
            .json(&json!({ "jobid": jobid }))
            .timeout(Duration::from_secs(10))
            .send()
            .await;

        // Get stats
        let stats_res = client
            .post(&stats_url)
            .json(&json!({ "jobid": jobid }))
            .timeout(Duration::from_secs(10))
            .send()
            .await;

        if let Some(job) = JOB_CACHE.get_job(jobid).await {
            if job.status == "stopped" {
                break;
            }
        }

        match (status_res, stats_res) {
            (Ok(status_response), Ok(stats_response)) => {
                let status = status_response.status();
                let status_body = status_response.text().await.unwrap_or_default();

                let stats_body = stats_response.text().await.unwrap_or_default();

                if !status.is_success() {
                    if status == 500 && status_body.contains("job not found") {
                        // Job completed or failed
                        let job_completed = JOB_CACHE
                            .get_job(jobid)
                            .await
                            .map(|j| j.status == "completed" || j.status == "failed")
                            .unwrap_or(true);

                        if job_completed {
                            break;
                        }
                    }
                    continue;
                }

                // Update job stats in cache
                if let Ok(stats) = serde_json::from_str::<Value>(&stats_body) {
                    let _ = JOB_CACHE.update_job_stats(jobid, stats).await;
                }

                // Emit update to frontend
                let _ = app.emit(
                    "job_update",
                    json!({
                        "jobid": jobid,
                        "status": status_body,
                        "stats": stats_body
                    }),
                );

                // Check if job is finished
                let job_status: Value = match serde_json::from_str(&status_body) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                if job_status
                    .get("finished")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                {
                    let success = job_status
                        .get("success")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let _ = JOB_CACHE.complete_job(jobid, success).await;
                    let _ = app.emit(
                        "job_completed",
                        json!({
                            "jobid": jobid,
                            "success": success
                        }),
                    );
                    break;
                }
            }
            _ => {}
        }

        sleep(Duration::from_secs(1)).await;
    }
}

/// Clean up OAuth process
#[tauri::command]
pub async fn quit_rclone_oauth(state: State<'_, RcloneState>) -> Result<(), String> {
    info!("🛑 Quitting Rclone OAuth process");

    let mut guard = OAUTH_PROCESS.lock().await;
    let port = RCLONE_STATE.get_oauth().1;
    let mut found_process = false;

    // Check if process is tracked in memory
    if guard.is_some() {
        found_process = true;
    } else {
        // Try to connect to the port to see if something is running
        let addr = format!("127.0.0.1:{}", port);
        if TcpStream::connect(&addr).await.is_ok() {
            found_process = true;
        }
    }

    if !found_process {
        warn!("⚠️ No active Rclone OAuth process found (not in memory, port not open)");
        return Ok(());
    }

    let url = format!("http://127.0.0.1:{}/core/quit", port);

    if let Err(e) = state.client.post(&url).send().await {
        warn!("⚠️ Failed to send quit request: {}", e);
    }

    if let Some(mut process) = guard.take() {
        match process.wait() {
            Ok(status) => {
                info!("✅ Rclone OAuth process exited with status: {:?}", status);
            }
            Err(_) => {
                if let Err(e) = process.kill() {
                    error!("❌ Failed to kill process: {}", e);
                    return Err(format!("Failed to kill process: {}", e));
                }
                info!("💀 Forcefully killed Rclone OAuth process");
            }
        }
    } else {
        // If not tracked, just wait a bit for the process to exit after /core/quit
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }

    info!("✅ Rclone OAuth process quit successfully");
    Ok(())
}
