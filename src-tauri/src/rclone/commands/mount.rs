use log::{debug, error, info, warn};
use serde_json::{Value, json};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{
    rclone::{
        commands::job::submit_job_and_wait,
        state::{engine::ENGINE_STATE, watcher::force_check_mounted_remotes},
    },
    utils::{
        json_helpers::{get_string, json_to_hashmap, unwrap_nested_options},
        logging::log::log_operation,
        rclone::endpoints::{EndpointHelper, mount},
        types::{
            all_types::{JobCache, LogLevel, RcloneState, RemoteCache},
            events::REMOTE_STATE_CHANGED,
        },
    },
};

use super::{job::JobMetadata, system::redact_sensitive_values};

/// Parameters for mounting a remote filesystem
#[derive(Debug, serde::Deserialize, serde::Serialize, Clone)]
pub struct MountParams {
    pub remote_name: String,
    pub source: String,
    pub mount_point: String,
    pub mount_type: String,
    pub mount_options: Option<HashMap<String, Value>>, // rc mount options
    pub vfs_options: Option<HashMap<String, Value>>,   // vfs options
    pub filter_options: Option<HashMap<String, Value>>, // filter options
    pub backend_options: Option<HashMap<String, Value>>, // backend options
}

impl MountParams {
    pub fn from_settings(remote_name: String, settings: &Value) -> Option<Self> {
        let mount_cfg = settings.get("mountConfig")?;

        let source = get_string(mount_cfg, &["source"]);
        let dest = get_string(mount_cfg, &["dest"]);

        if source.is_empty() || dest.is_empty() {
            return None;
        }

        Some(Self {
            remote_name,
            source,
            mount_point: dest,
            mount_type: mount_cfg
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("mount")
                .to_string(),
            mount_options: json_to_hashmap(mount_cfg.get("options")),
            vfs_options: json_to_hashmap(settings.get("vfsConfig").and_then(|v| v.get("options"))),
            filter_options: json_to_hashmap(
                settings.get("filterConfig").and_then(|v| v.get("options")),
            ),
            backend_options: json_to_hashmap(
                settings.get("backendConfig").and_then(|v| v.get("options")),
            ),
        })
    }

    pub fn should_auto_start(settings: &Value) -> bool {
        settings
            .get("mountConfig")
            .and_then(|v| v.get("autoStart"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }
}

/// Mount a remote filesystem
#[tauri::command]
pub async fn mount_remote(
    app: AppHandle,
    _job_cache: State<'_, JobCache>,
    cache: State<'_, RemoteCache>,
    params: MountParams,
) -> Result<(), String> {
    debug!("Received mount_remote params: {params:#?}");
    let mounted_remotes = cache.get_mounted_remotes().await;
    let state = app.state::<RcloneState>();

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
            .map(|opts| redact_sensitive_values(opts, &state.restrict_mode)),
        "filter_options": params
            .filter_options
            .as_ref()
            .map(|opts| redact_sensitive_values(opts, &state.restrict_mode)),
        "backend_options": params
            .backend_options
            .as_ref()
            .map(|opts| redact_sensitive_values(opts, &state.restrict_mode)),
    });

    log_operation(
        LogLevel::Info,
        Some(params.remote_name.clone()),
        Some("Mount remote".to_string()),
        format!("Attempting to mount at {}", params.mount_point),
        Some(log_context),
    );

    // Prepare payload
    let mut payload = json!({
        "fs": params.source,
        "mountPoint": params.mount_point,
        "_async": true,
    });

    debug!("Mount request payload: {payload:#?}");

    // Only include mountType if it's not an empty string
    if !params.mount_type.is_empty() {
        payload["mountType"] = json!(params.mount_type);
    }

    if let Some(opts) = params.mount_options.clone() {
        payload["mountOpt"] = json!(opts);
    }

    if let Some(opts) = params.vfs_options.clone() {
        let vfs_opts = unwrap_nested_options(opts);
        payload["vfsOpt"] = json!(vfs_opts);
    }

    if let Some(opts) = params.backend_options.clone() {
        let backend_opts = unwrap_nested_options(opts);
        let filtered_opts: HashMap<String, Value> = backend_opts
            .into_iter()
            .filter(|(_, v)| {
                !matches!(v, Value::Null) && !matches!(v, Value::String(s) if s.is_empty())
            })
            .collect();
        if !filtered_opts.is_empty() {
            payload["_config"] = json!(filtered_opts);
        }
    }

    if let Some(opts) = params.filter_options.clone() {
        let filter_opts = unwrap_nested_options(opts);
        payload["_filter"] = json!(filter_opts);
    }
    debug!("Final mount request payload: {payload:#?}");

    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, mount::MOUNT);

    let (_, _) = submit_job_and_wait(
        app.clone(),
        state.client.clone(),
        url,
        payload,
        JobMetadata {
            remote_name: params.remote_name.clone(),
            job_type: "mount".to_string(),
            operation_name: "Mount remote".to_string(),
            source: params.source.clone(),
            destination: params.mount_point.clone(),
        },
    )
    .await?;

    app.emit(REMOTE_STATE_CHANGED, &params.remote_name)
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
    );

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
            app.emit(REMOTE_STATE_CHANGED, &mount_point)
                .map_err(|e| format!("Failed to emit event: {e}"))?;
        }

        let error = format!("HTTP {status}: {body}");
        log_operation(
            LogLevel::Error,
            Some(remote_name.clone()),
            Some("Unmount remote".to_string()),
            error.clone(),
            Some(json!({"response": body})),
        );
        error!("❌ Failed to unmount {mount_point}: {error}");
        return Err(error);
    }

    log_operation(
        LogLevel::Info,
        Some(remote_name.clone()),
        Some("Unmount remote".to_string()),
        format!("Successfully unmounted {mount_point}"),
        None,
    );

    app.emit(REMOTE_STATE_CHANGED, &mount_point)
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
        app.emit(REMOTE_STATE_CHANGED, "all")
            .map_err(|e| format!("Failed to emit event: {e}"))?;

        // Force refresh mounted remotes after unmount all operation
        if let Err(e) = force_check_mounted_remotes(app).await {
            warn!("Failed to refresh mounted remotes after unmount all: {e}");
        }
    }

    info!("✅ All remotes unmounted successfully");

    Ok("✅ All remotes unmounted successfully".to_string())
}
