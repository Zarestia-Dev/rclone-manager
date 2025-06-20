use chrono::Utc;
use log::{debug, error, info, warn};
use serde_json::{Map, Value, json};
use std::{
    collections::HashMap,
    process::{Child, Command, Stdio},
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State};
use tokio::net::TcpStream;
use tokio::{sync::Mutex, time::sleep};

use crate::{
    RcloneState,
    core::check_binaries::read_rclone_path,
    rclone::api::state::{ENGINE_STATE, JOB_CACHE, clear_remote_logs, get_cached_mounted_remotes},
    utils::{
        log::log_operation,
        types::{
            BandwidthLimitResponse, JobInfo, JobResponse, JobStatus, LogLevel, SENSITIVE_KEYS,
        },
    },
};

lazy_static::lazy_static! {
    static ref OAUTH_PROCESS: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
}

#[derive(Debug)]
pub enum RcloneError {
    RequestFailed(String),
    ParseError(String),
    JobError(String),
    // RemoteError(String),
    OAuthError(String),
    // IoError(String),
}

impl From<reqwest::Error> for RcloneError {
    fn from(err: reqwest::Error) -> Self {
        RcloneError::RequestFailed(err.to_string())
    }
}

impl From<serde_json::Error> for RcloneError {
    fn from(err: serde_json::Error) -> Self {
        RcloneError::ParseError(err.to_string())
    }
}

impl std::fmt::Display for RcloneError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RcloneError::RequestFailed(e) => write!(f, "Request failed: {}", e),
            RcloneError::ParseError(e) => write!(f, "Parse error: {}", e),
            RcloneError::JobError(e) => write!(f, "Job error: {}", e),
            // RcloneError::RemoteError(e) => write!(f, "Remote error: {}", e),
            RcloneError::OAuthError(e) => write!(f, "OAuth error: {}", e),
            // RcloneError::IoError(e) => write!(f, "IO error: {}", e),
        }
    }
}

fn redact_sensitive_values(
    params: &HashMap<String, Value>,
    restrict_mode: &Arc<RwLock<bool>>,
) -> Value {
    params
        .iter()
        .map(|(k, v)| {
            let value = if *restrict_mode.read().unwrap()
                && SENSITIVE_KEYS
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

async fn ensure_oauth_process(app: &AppHandle) -> Result<(), RcloneError> {
    let mut guard = OAUTH_PROCESS.lock().await;
    let port = ENGINE_STATE.get_oauth().1;

    // Check if process is already running (in memory or port open)
    let mut process_running = guard.is_some();
    if !process_running {
        let addr = format!("127.0.0.1:{}", port);
        match TcpStream::connect(&addr).await {
            Ok(_) => {
                process_running = true;
                warn!(
                    "Rclone OAuth process already running (port {} in use)",
                    port
                );
            }
            Err(_) => {
                debug!("No existing OAuth process detected on port {}", port);
            }
        }
    }

    if process_running {
        return Ok(());
    }

    // Start new process
    let rclone_path = read_rclone_path(app);

    let mut oauth_app = Command::new(&rclone_path);
    oauth_app
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
        RcloneError::OAuthError(format!(
            "Failed to start Rclone OAuth process: {}. Ensure Rclone is installed and in PATH.",
            e
        ))
    })?;

    *guard = Some(process);

    // Wait for process to start with timeout
    let start_time = Instant::now();
    let timeout = Duration::from_secs(5);

    while start_time.elapsed() < timeout {
        if TcpStream::connect(&format!("127.0.0.1:{}", port))
            .await
            .is_ok()
        {
            info!("OAuth process started successfully on port {}", port);
            return Ok(());
        }
        sleep(Duration::from_millis(100)).await;
    }

    Err(RcloneError::OAuthError(format!(
        "Timeout waiting for OAuth process to start on port {}",
        port
    )))
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
    let params_obj = redact_sensitive_values(&params_map, &state.restrict_mode);

    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some("New remote creation".to_string()),
        "Creating new remote".to_string(),
        Some(json!({
            "type": remote_type,
            "parameters": params_obj
        })),
    )
    .await;

    // Handle OAuth process
    ensure_oauth_process(&app)
        .await
        .map_err(|e| e.to_string())?;

    let body = json!({
        "name": name,
        "type": remote_type,
        "parameters": parameters
    });

    let url = format!(
        "http://127.0.0.1:{}/config/create",
        ENGINE_STATE.get_oauth().1
    );

    let response = state
        .client
        .post(&url)
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
            format!("Port {} already in use", ENGINE_STATE.get_oauth().1)
        } else {
            format!("HTTP {}: {}", status, body)
        };

        log_operation(
            LogLevel::Error,
            Some(name.clone()),
            Some("New remote creation".to_string()),
            "Failed to create remote".to_string(),
            Some(json!({"response": body})),
        )
        .await;

        return Err(error);
    }

    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some("New remote creation".to_string()),
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
    let params_obj = redact_sensitive_values(&parameters, &state.restrict_mode);

    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some("Remote update".to_string()),
        "Updating remote".to_string(),
        Some(json!({
            "type": remote_type,
            "parameters": params_obj
        })),
    )
    .await;

    ensure_oauth_process(&app)
        .await
        .map_err(|e| e.to_string())?;

    let url = format!(
        "http://127.0.0.1:{}/config/update",
        ENGINE_STATE.get_oauth().1
    );
    let body = json!({ "name": name, "parameters": parameters });

    let response = state
        .client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = format!("HTTP {}: {}", status, body);
        log_operation(
            LogLevel::Error,
            Some(name.clone()),
            Some("Remote update".to_string()),
            "Failed to update remote".to_string(),
            Some(json!({"response": body})),
        )
        .await;
        return Err(error);
    }

    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some("Remote update".to_string()),
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

    let url = format!("{}/config/delete", ENGINE_STATE.get_api().0);

    let response = state
        .client
        .post(&url)
        .query(&[("name", &name)])
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

    clear_remote_logs(Some(name.clone()))
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
    source: String,
    mount_point: String,
    mount_options: Option<HashMap<String, Value>>,
    vfs_options: Option<HashMap<String, Value>>,
    state: State<'_, RcloneState>,
) -> Result<(), String> {
    let mounted_remotes = get_cached_mounted_remotes().await?;

    // Check if mount point is in use
    if let Some(existing) = mounted_remotes
        .iter()
        .find(|m| m.mount_point == mount_point)
    {
        let error_msg = format!(
            "Mount point {} is already in use by remote {}",
            mount_point, existing.fs
        );
        warn!("{}", error_msg);
        return Err(error_msg);
    }

    // Check if remote is already mounted
    if mounted_remotes.iter().any(|m| m.fs == remote_name) {
        info!("Remote {} already mounted", remote_name);
        return Ok(());
    }

    // Prepare logging context
    let log_context = json!({
        "mount_point": mount_point,
        "remote_name": remote_name,
        "mount_options": mount_options.as_ref().map(|opts| redact_sensitive_values(opts, &state.restrict_mode)),
        "vfs_options": vfs_options.as_ref().map(|opts| redact_sensitive_values(opts, &state.restrict_mode))
    });

    log_operation(
        LogLevel::Info,
        Some(remote_name.clone()),
        Some("Mount remote".to_string()),
        format!("Attempting to mount at {}", mount_point),
        Some(log_context),
    )
    .await;

    // Prepare payload
    let mut payload = json!({
        "fs": source,
        "mountPoint": mount_point,
        "_async": true,
    });

    debug!("Mount request payload: {:#?}", payload);

    if let Some(opts) = mount_options {
        payload["mountOpt"] = json!(opts);
    }

    if let Some(opts) = vfs_options {
        payload["vfsOpt"] = json!(opts);
    }

    // Make the request
    let url = format!("{}/mount/mount", ENGINE_STATE.get_api().0);
    let response = state
        .client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            let error = format!("Mount request failed: {}", e);
            // Clone error for use in both places
            let error_for_log = error.clone();
            // Spawn an async task to log the error since we can't await here
            let remote_name_clone = remote_name.clone();
            let payload_clone = payload.clone();
            tauri::async_runtime::spawn(async move {
                log_operation(
                    LogLevel::Error,
                    Some(remote_name_clone),
                    Some("Mount remote".to_string()),
                    error_for_log,
                    Some(json!({"payload": payload_clone})),
                )
                .await;
            });
            error
        })?;

    // Handle response
    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = format!("HTTP {}: {}", status, body);
        log_operation(
            LogLevel::Error,
            Some(remote_name.clone()),
            Some("Mount remote".to_string()),
            format!("Failed to mount remote: {}", error),
            Some(json!({"response": body})),
        )
        .await;
        return Err(error);
    }

    let job_response: JobResponse =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse response: {}", e))?;

    log_operation(
        LogLevel::Info,
        Some(remote_name.clone()),
        Some("Mount remote".to_string()),
        format!("Mount job started with ID {}", job_response.jobid),
        Some(json!({"jobid": job_response.jobid})),
    )
    .await;

    // Extract job ID and monitor the job
    let jobid = job_response.jobid;
    // Add to job cache
    JOB_CACHE
        .add_job(JobInfo {
            jobid,
            job_type: "mount".to_string(),
            remote_name: remote_name.clone(),
            source: source.clone(),
            destination: mount_point.clone(),
            start_time: Utc::now(),
            status: JobStatus::Running,
            stats: None,
            group: format!("job/{}", jobid),
        })
        .await;

    // Start monitoring
    let app_clone = app.clone();
    let remote_name_clone = remote_name.clone();
    let client = state.client.clone();
    if let Err(e) = monitor_job(remote_name_clone, "Mount remote", jobid, app_clone, client).await {
        error!("Job {} returned an error: {}", jobid, e);
        return Err(e.to_string());
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
        LogLevel::Info,
        Some(remote_name.clone()),
        Some("Unmount remote".to_string()),
        format!("Attempting to unmount {}", mount_point),
        None,
    )
    .await;

    let url = format!("{}/mount/unmount", ENGINE_STATE.get_api().0);
    let payload = json!({ "mountPoint": mount_point });

    let response = state
        .client
        .post(&url)
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
        log_operation(
            LogLevel::Error,
            Some(remote_name.clone()),
            Some("Unmount remote".to_string()),
            error.clone(),
            Some(json!({"response": body})),
        )
        .await;
        error!("❌ Failed to unmount {}: {}", mount_point, error);
        return Err(error);
    }

    log_operation(
        LogLevel::Info,
        Some(remote_name.clone()),
        Some("Unmount remote".to_string()),
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

    let url = format!("{}/mount/unmountall", ENGINE_STATE.get_api().0);

    let response = state
        .client
        .post(&url)
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
    remote_name: String,
    source: String,
    dest: String,
    sync_options: Option<HashMap<String, Value>>,
    filter_options: Option<HashMap<String, Value>>,
    state: State<'_, RcloneState>,
) -> Result<u64, String> {
    log_operation(
        LogLevel::Info,
        Some(remote_name.clone()),
        Some("Sync operation".to_string()),
        format!("Starting sync from {} to {}", source, dest),
        Some(json!({
            "source": source,
            "destination": dest,
            "sync_options": sync_options.as_ref().map(|o| o.keys().collect::<Vec<_>>()),
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

    let url = format!("{}/sync/sync", ENGINE_STATE.get_api().0);

    let response = state
        .client
        .post(&url)
        .json(&Value::Object(body)) // send JSON body
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let body_text = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = format!("HTTP {}: {}", status, body_text);
        log_operation(
            LogLevel::Error,
            Some(remote_name.clone()),
            Some("Sync operation".to_string()),
            "Failed to start sync job".to_string(),
            Some(json!({"response": body_text})),
        )
        .await;
        return Err(error);
    }

    let job: JobResponse =
        serde_json::from_str(&body_text).map_err(|e| format!("Failed to parse response: {}", e))?;

    log_operation(
        LogLevel::Info,
        Some(remote_name.clone()),
        Some("Sync operation".to_string()),
        format!("Sync job started with ID {}", job.jobid),
        Some(json!({"jobid": job.jobid})),
    )
    .await;

    let jobid = job.jobid;
    JOB_CACHE
        .add_job(JobInfo {
            jobid,
            job_type: "sync".to_string(),
            remote_name: remote_name.clone(),
            source: source.clone(),
            destination: dest.clone(),
            start_time: Utc::now(),
            status: JobStatus::Running,
            stats: None,
            group: format!("job/{}", jobid), // Add this line
        })
        .await;

    // Start monitoring the job
    let app_clone = app.clone();
    let client = state.client.clone();
    let remote_name_clone = remote_name.clone();
    tauri::async_runtime::spawn(async move {
        let _ = monitor_job(
            remote_name_clone,
            "Sync operation",
            jobid,
            app_clone,
            client,
        )
        .await;
    });

    app.emit("job_cache_changed", jobid)
        .map_err(|e| format!("Failed to emit event: {}", e))?;
    Ok(job.jobid)
}

/// Stop a running job
#[tauri::command]
pub async fn stop_job(
    app: AppHandle,
    jobid: u64,
    remote_name: String,
    state: State<'_, RcloneState>,
) -> Result<(), String> {
    // First mark the job as stopped in the cache
    JOB_CACHE.stop_job(jobid).await.map_err(|e| e.to_string())?;

    // Then try to stop it via API
    let url = format!("{}/job/stop", ENGINE_STATE.get_api().0);
    let payload = json!({ "jobid": jobid });

    let response = state
        .client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        // If job not found, we've already marked it as stopped
        if status.as_u16() == 500 && body.contains("\"job not found\"") {
            log_operation(
                LogLevel::Warn,
                Some(remote_name.clone()),
                Some("Stop job".to_string()),
                format!("Job {} not found, tagged as stopped", jobid),
                None,
            )
            .await;
            warn!("Job {} not found, tagged as stopped.", jobid);
        } else {
            let error = format!("HTTP {}: {}", status, body);
            error!("❌ Failed to stop job {}: {}", jobid, error);
            return Err(error);
        }
    }

    log_operation(
        LogLevel::Info,
        Some(remote_name.clone()),
        Some("Stop job".to_string()),
        format!("Job {} stopped successfully", jobid),
        None,
    )
    .await;

    app.emit("job_cache_changed", jobid)
        .map_err(|e| format!("Failed to emit event: {}", e))?;

    info!("✅ Stopped job {}", jobid);
    Ok(())
}

/// Start a copy operation
#[tauri::command]
pub async fn start_copy(
    app: AppHandle,
    remote_name: String,
    source: String,
    dest: String,
    copy_options: Option<HashMap<String, Value>>,
    filter_options: Option<HashMap<String, Value>>,
    state: State<'_, RcloneState>,
) -> Result<u64, String> {
    log_operation(
        LogLevel::Info,
        Some(remote_name.clone()),
        Some("Copy operation".to_string()),
        format!("Starting copy from {} to {}", source, dest),
        Some(json!({
            "source": source,
            "destination": dest,
            "copy_options": copy_options.as_ref().map(|o| o.keys().collect::<Vec<_>>()),
            "filters": filter_options.as_ref().map(|f| f.keys().collect::<Vec<_>>())
        })),
    )
    .await;

    let mut body = Map::new();
    body.insert("srcFs".to_string(), Value::String(source.clone()));
    body.insert("dstFs".to_string(), Value::String(dest.clone()));
    body.insert("_async".to_string(), Value::Bool(true));

    if let Some(opts) = copy_options {
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

    debug!("Copy request body: {:#?}", body);

    let url = format!("{}/sync/copy", ENGINE_STATE.get_api().0);

    let response = state
        .client
        .post(&url)
        .json(&Value::Object(body)) // send JSON body
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = format!("HTTP {}: {}", status, body);
        log_operation(
            LogLevel::Error,
            Some(remote_name.clone()),
            Some("Copy operation".to_string()),
            "Failed to start copy job".to_string(),
            Some(json!({"response": body})),
        )
        .await;
        error!("❌ Failed to start copy job: {}", error);
        return Err(error);
    }

    let job: JobResponse =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse response: {}", e))?;

    let jobid = job.jobid.clone();
    JOB_CACHE
        .add_job(JobInfo {
            jobid,
            job_type: "copy".to_string(),
            remote_name: remote_name.clone(),
            source: source.clone(),
            destination: dest.clone(),
            start_time: Utc::now(),
            status: JobStatus::Running,
            stats: None,
            group: format!("job/{}", jobid), // Add this line
        })
        .await;
    // Start monitoring the job
    let app_clone = app.clone();
    let client = state.client.clone();
    let remote_name_clone = remote_name.clone();
    tokio::spawn(async move {
        let _ = monitor_job(
            remote_name_clone,
            "Copy operation",
            jobid,
            app_clone,
            client,
        )
        .await;
    });

    log_operation(
        LogLevel::Info,
        Some(remote_name.clone()),
        Some("Copy operation".to_string()),
        format!("Copy job started with ID {}", jobid),
        Some(json!({"jobid": jobid})),
    )
    .await;

    app.emit("job_cache_changed", jobid.clone())
        .map_err(|e| format!("Failed to emit event: {}", e))?;
    Ok(job.jobid)
}

async fn monitor_job(
    remote_name: String,
    operation: &str,
    jobid: u64,
    app: AppHandle,
    client: reqwest::Client,
) -> Result<(), RcloneError> {
    let job_status_url = format!("{}/job/status", ENGINE_STATE.get_api().0);
    let stats_url = format!("{}/core/stats", ENGINE_STATE.get_api().0);

    info!("Starting monitoring for job {} ({})", jobid, operation);

    let mut consecutive_errors = 0;
    const MAX_CONSECUTIVE_ERRORS: u8 = 3;

    loop {
        // Check if job is still in cache and not stopped
        match JOB_CACHE.get_job(jobid).await {
            Some(job) if job.status == JobStatus::Stopped => {
                debug!("Job {} was stopped, ending monitoring", jobid);
                return Ok(());
            }
            None => {
                debug!("Job {} removed from cache, stopping monitoring", jobid);
                return Ok(());
            }
            _ => {} // Continue monitoring
        }

        // Get job status and stats in parallel
        let status_fut = client
            .post(&job_status_url)
            .json(&json!({ "jobid": jobid }))
            .send();

        let stats_fut = client
            .post(&stats_url)
            .json(&json!({ "jobid": jobid }))
            .send();

        match tokio::try_join!(status_fut, stats_fut) {
            Ok((status_response, stats_response)) => {
                consecutive_errors = 0; // Reset error counter on success

                let status_body = status_response.text().await?;
                let stats_body = stats_response.text().await?;

                // Process stats
                if let Ok(stats) = serde_json::from_str::<Value>(&stats_body) {
                    JOB_CACHE
                        .update_job_stats(jobid, stats)
                        .await
                        .map_err(RcloneError::JobError)?;
                }

                // Process status
                if let Ok(job_status) = serde_json::from_str::<Value>(&status_body) {
                    if job_status
                        .get("finished")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                    {
                        return handle_job_completion(
                            jobid,
                            &remote_name,
                            operation,
                            job_status,
                            &app,
                        )
                        .await;
                    }
                }
            }
            Err(e) => {
                consecutive_errors += 1;
                warn!(
                    "Error monitoring job {} (attempt {}/{}): {}",
                    jobid, consecutive_errors, MAX_CONSECUTIVE_ERRORS, e
                );

                if consecutive_errors >= MAX_CONSECUTIVE_ERRORS {
                    error!("Too many errors monitoring job {}, giving up", jobid);
                    JOB_CACHE
                        .complete_job(jobid, false)
                        .await
                        .map_err(RcloneError::JobError)?;
                    app.emit("job_cache_changed", jobid)
                        .map_err(|e| RcloneError::JobError(e.to_string()))?;
                    return Err(RcloneError::JobError(format!(
                        "Too many errors monitoring job {}: {}",
                        jobid, e
                    )));
                }
            }
        }

        sleep(Duration::from_secs(1)).await;
    }
}

async fn handle_job_completion(
    jobid: u64,
    remote_name: &str,
    operation: &str,
    job_status: Value,
    app: &AppHandle,
) -> Result<(), RcloneError> {
    let success = job_status
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let error_msg = job_status
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    JOB_CACHE
        .complete_job(jobid, success)
        .await
        .map_err(RcloneError::JobError)?;
    app.emit("job_cache_changed", jobid)
        .map_err(|e| RcloneError::JobError(e.to_string()))?;

    if !error_msg.is_empty() {
        log_operation(
            LogLevel::Error,
            Some(remote_name.to_string()),
            Some(operation.to_string()),
            format!("{} Job {} failed: {}", operation, jobid, error_msg),
            Some(json!({"jobid": jobid, "status": job_status})),
        )
        .await;
        return Err(RcloneError::JobError(error_msg));
    } else if success {
        log_operation(
            LogLevel::Info,
            Some(remote_name.to_string()),
            Some(operation.to_string()),
            format!("{} Job {} completed successfully", operation, jobid),
            Some(json!({"jobid": jobid, "status": job_status})),
        )
        .await;
        Ok(())
    } else {
        log_operation(
            LogLevel::Warn,
            Some(remote_name.to_string()),
            Some(operation.to_string()),
            format!(
                "{} Job {} completed without success but no error message",
                operation, jobid
            ),
            Some(json!({"jobid": jobid, "status": job_status})),
        )
        .await;
        Err(RcloneError::JobError(
            "Job completed without success".to_string(),
        ))
    }
}

/// Clean up OAuth process
#[tauri::command]
pub async fn quit_rclone_oauth(state: State<'_, RcloneState>) -> Result<(), String> {
    info!("🛑 Quitting Rclone OAuth process");

    let mut guard = OAUTH_PROCESS.lock().await;
    let port = ENGINE_STATE.get_oauth().1;
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

#[tauri::command]
pub async fn set_bandwidth_limit(
    _app: AppHandle,
    rate: Option<String>,
    state: State<'_, RcloneState>,
) -> Result<BandwidthLimitResponse, String> {
    let rate_value = match rate {
        Some(ref s) if s.trim().is_empty() => "off".to_string(),
        Some(s) => s,
        None => "off".to_string(),
    };

    let url = format!("{}/core/bwlimit", ENGINE_STATE.get_api().0);
    let payload = json!({ "rate": rate_value });

    let response = state
        .client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = format!("HTTP {}: {}", status, body);
        return Err(error);
    }

    let response_data: BandwidthLimitResponse =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse response: {}", e))?;

    debug!("🪢 Bandwidth limit set: {:?}", response_data);
    Ok(response_data)
}
