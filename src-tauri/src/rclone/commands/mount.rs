use chrono::Utc;
use log::{debug, error, info, warn};
use serde_json::{Value, json};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};

use crate::{
    RcloneState,
    rclone::state::{
        ENGINE_STATE, JOB_CACHE, force_check_mounted_remotes, get_cached_mounted_remotes,
    },
    utils::{
        logging::log::log_operation,
        rclone::endpoints::{EndpointHelper, mount},
        types::all_types::{JobInfo, JobResponse, JobStatus, LogLevel},
    },
};

use super::{job::monitor_job, system::redact_sensitive_values};

/// Parameters for mounting a remote filesystem
#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct MountParams {
    pub remote_name: String,
    pub source: String,
    pub mount_point: String,
    pub mount_type: String,
    pub mount_options: Option<HashMap<String, Value>>, // rc mount options
    pub vfs_options: Option<HashMap<String, Value>>,   // vfs options
}

/// Mount a remote filesystem
#[tauri::command]
pub async fn mount_remote(
    app: AppHandle,
    params: MountParams,
    state: State<'_, RcloneState>,
) -> Result<(), String> {
    let mounted_remotes = get_cached_mounted_remotes().await?;

    // Check if mount point is in use
    if let Some(existing) = mounted_remotes
        .iter()
        .find(|m| m.mount_point == params.mount_point)
    {
        let error_msg = format!(
            "Mount point {} is already in use by remote {}",
            params.mount_point, existing.fs
        );
        warn!("{error_msg}");
        return Err(error_msg);
    }

    // Check if remote is already mounted
    if mounted_remotes.iter().any(|m| m.fs == params.remote_name) {
        info!("Remote {} already mounted", params.remote_name);
        return Ok(());
    }

    // Prepare logging context
    let log_context = json!({
        "mount_point": params.mount_point,
        "remote_name": params.remote_name,
        "mount_type": params.mount_type,
        "mount_options": params
            .mount_options
            .as_ref()
            .map(|opts| redact_sensitive_values(opts, &state.restrict_mode)),
        "vfs_options": params
            .vfs_options
            .as_ref()
            .map(|opts| redact_sensitive_values(opts, &state.restrict_mode))
    });

    log_operation(
        LogLevel::Info,
        Some(params.remote_name.clone()),
        Some("Mount remote".to_string()),
        format!("Attempting to mount at {}", params.mount_point),
        Some(log_context),
    )
    .await;

    // Prepare payload
    let mut payload = json!({
        "fs": params.source,
        "mountPoint": params.mount_point,
        "mountType": params.mount_type,
        "_async": true,
    });

    debug!("Mount request payload: {payload:#?}");

    if let Some(opts) = params.mount_options.clone() {
        payload["mountOpt"] = json!(opts);
    }

    if let Some(opts) = params.vfs_options.clone() {
        payload["vfsOpt"] = json!(opts);
    }

    // Make the request
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, mount::MOUNT);
    let response = state
        .client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            let error = format!("Mount request failed: {e}");
            // Clone error for use in both places
            let error_for_log = error.clone();
            // Spawn an async task to log the error since we can't await here
            let remote_name_clone = params.remote_name.clone();
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
        let error = format!("HTTP {status}: {body}");
        log_operation(
            LogLevel::Error,
            Some(params.remote_name.clone()),
            Some("Mount remote".to_string()),
            format!("Failed to mount remote: {error}"),
            Some(json!({"response": body})),
        )
        .await;
        return Err(error);
    }

    let job_response: JobResponse =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse response: {e}"))?;

    log_operation(
        LogLevel::Info,
        Some(params.remote_name.clone()),
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
            remote_name: params.remote_name.clone(),
            source: params.source.clone(),
            destination: params.mount_point.clone(),
            start_time: Utc::now(),
            status: JobStatus::Running,
            stats: None,
            group: format!("job/{jobid}"),
        })
        .await;

    // Start monitoring
    let app_clone = app.clone();
    let remote_name_clone = params.remote_name.clone();
    let client = state.client.clone();
    if let Err(e) = monitor_job(remote_name_clone, "Mount remote", jobid, app_clone, client).await {
        error!("Job {jobid} returned an error: {e}");
        return Err(e.to_string());
    }

    app.emit("remote_state_changed", &params.remote_name)
        .map_err(|e| format!("Failed to emit event: {e}"))?;

    // Force refresh mounted remotes after mount operation
    if let Err(e) = force_check_mounted_remotes(app).await {
        warn!("Failed to refresh mounted remotes after mount: {e}");
    }

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
        format!("Attempting to unmount {mount_point}"),
        None,
    )
    .await;

    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, mount::UNMOUNT);
    let payload = json!({ "mountPoint": mount_point });

    let response = state
        .client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        if status.as_u16() == 500 && body.contains("\"mount not found\"") {
            warn!("🚨 Mount not found for {mount_point}, updating mount cache",);
            // Update the cached mounted remotes
            app.emit("remote_state_changed", &mount_point)
                .map_err(|e| format!("Failed to emit event: {e}"))?;
        }

        let error = format!("HTTP {status}: {body}");
        log_operation(
            LogLevel::Error,
            Some(remote_name.clone()),
            Some("Unmount remote".to_string()),
            error.clone(),
            Some(json!({"response": body})),
        )
        .await;
        error!("❌ Failed to unmount {mount_point}: {error}");
        return Err(error);
    }

    log_operation(
        LogLevel::Info,
        Some(remote_name.clone()),
        Some("Unmount remote".to_string()),
        format!("Successfully unmounted {mount_point}"),
        None,
    )
    .await;

    app.emit("remote_state_changed", &mount_point)
        .map_err(|e| format!("Failed to emit event: {e}"))?;

    // Force refresh mounted remotes after unmount operation
    if let Err(e) = force_check_mounted_remotes(app).await {
        warn!("Failed to refresh mounted remotes after unmount: {e}");
    }

    Ok(format!("Successfully unmounted {mount_point}"))
}

/// Unmount all remotes
#[tauri::command]
pub async fn unmount_all_remotes(
    app: AppHandle,
    state: State<'_, RcloneState>,
    context: String,
) -> Result<String, String> {
    info!("🗑️ Unmounting all remotes");

    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, mount::UNMOUNTALL);

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error = format!("HTTP {status}: {body}");
        error!("❌ Failed to unmount all remotes: {error}");
        return Err(error);
    }

    if context != "shutdown" {
        app.emit("remote_state_changed", "all")
            .map_err(|e| format!("Failed to emit event: {e}"))?;

        // Force refresh mounted remotes after unmount all operation
        if let Err(e) = force_check_mounted_remotes(app).await {
            warn!("Failed to refresh mounted remotes after unmount all: {e}");
        }
    }

    info!("✅ All remotes unmounted successfully");

    Ok("✅ All remotes unmounted successfully".to_string())
}
