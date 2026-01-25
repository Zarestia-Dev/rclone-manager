use log::{debug, info, warn};
use serde_json::{Value, json};
use std::collections::HashMap;
use tauri::{AppHandle, Manager};

use crate::{
    rclone::{commands::job::submit_job_and_wait, state::watcher::force_check_mounted_remotes},
    utils::{
        json_helpers::unwrap_nested_options,
        logging::log::log_operation,
        rclone::endpoints::mount,
        types::{core::RcloneState, logs::LogLevel, remotes::ProfileParams},
    },
};

use super::common::{FromConfig, parse_common_config, redact_sensitive_values};
use super::job::JobMetadata;

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
    pub profile: Option<String>,
}

impl FromConfig for MountParams {
    fn from_config(remote_name: String, config: &Value, settings: &Value) -> Option<Self> {
        let common = parse_common_config(config, settings)?;

        Some(Self {
            remote_name,
            source: common.source,
            mount_point: common.dest,
            mount_type: config
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("mount")
                .to_string(),
            mount_options: common.options,
            vfs_options: common.vfs_options,
            filter_options: common.filter_options,
            backend_options: common.backend_options,
            profile: common.profile,
        })
    }
}

impl MountParams {
    pub fn to_rclone_body(&self) -> Value {
        let mut payload = json!({
            "fs": self.source,
            "mountPoint": self.mount_point,
            "_async": true,
        });

        if !self.mount_type.is_empty() {
            payload["mountType"] = json!(self.mount_type);
        }

        if let Some(opts) = &self.mount_options {
            payload["mountOpt"] = json!(opts);
        }

        if let Some(opts) = self.vfs_options.clone() {
            let vfs_opts = unwrap_nested_options(opts);
            payload["vfsOpt"] = json!(vfs_opts);
        }

        if let Some(opts) = self.backend_options.clone() {
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

        if let Some(opts) = self.filter_options.clone() {
            let filter_opts = unwrap_nested_options(opts);
            payload["_filter"] = json!(filter_opts);
        }

        payload
    }
}

/// Mount a remote filesystem (not exposed as Tauri command - use mount_remote_profile)
pub async fn mount_remote(app: AppHandle, params: MountParams) -> Result<(), String> {
    debug!("Received mount_remote params: {params:#?}");
    // Get active backend
    use crate::rclone::backend::BackendManager;
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let cache = &backend_manager.remote_cache;

    let mounted_remotes = cache.get_mounted_remotes().await;
    let state = app.state::<RcloneState>();

    // Check if mount point is in use
    if let Some(existing) = mounted_remotes
        .iter()
        .find(|m| m.mount_point == params.mount_point)
    {
        let error_msg = crate::localized_error!(
            "backendErrors.mount.alreadyInUse",
            "mountPoint" => &params.mount_point,
            "remote" => &existing.fs
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
        "mount_options": params.mount_options.as_ref().map(|opts| redact_sensitive_values(opts, &app)),
        "vfs_options": params.vfs_options.as_ref().map(|opts| redact_sensitive_values(opts, &app)),
        "filter_options": params.filter_options.as_ref().map(|opts| redact_sensitive_values(opts, &app)),
        "backend_options": params.backend_options.as_ref().map(|opts| redact_sensitive_values(opts, &app)),
    });

    log_operation(
        LogLevel::Info,
        Some(params.remote_name.clone()),
        Some("Mount remote".to_string()),
        format!("Attempting to mount at {}", params.mount_point),
        Some(log_context),
    );

    // Prepare payload
    let payload = params.to_rclone_body();

    debug!("Mount request payload: {payload:#?}");

    let url = backend.url_for(mount::MOUNT);

    let (_, _) = submit_job_and_wait(
        app.clone(),
        state.client.clone(),
        backend.inject_auth(state.client.post(&url)),
        payload,
        JobMetadata {
            remote_name: params.remote_name.clone(),
            job_type: "mount".to_string(),
            operation_name: "Mount remote".to_string(),
            source: params.source.clone(),
            destination: params.mount_point.clone(),
            profile: params.profile.clone(),
            source_ui: None,
        },
    )
    .await?;

    // Store the profile mapping for this mount point
    cache
        .store_mount_profile(&params.mount_point, params.profile.clone())
        .await;

    // Force refresh - this will update cache and emit event if changed
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
) -> Result<String, String> {
    let state = app.state::<RcloneState>();
    use crate::rclone::backend::BackendManager;
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    let payload = json!({ "mountPoint": mount_point });
    if mount_point.trim().is_empty() {
        return Err(crate::localized_error!("backendErrors.mount.pointEmpty"));
    }

    log_operation(
        LogLevel::Info,
        Some(remote_name.clone()),
        Some("Unmount remote".to_string()),
        format!("Attempting to unmount {mount_point}"),
        None,
    );

    let _ = backend
        .post_json(&state.client, mount::UNMOUNT, Some(&payload))
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    log_operation(
        LogLevel::Info,
        Some(remote_name.clone()),
        Some("Unmount remote".to_string()),
        format!("Successfully unmounted {mount_point}"),
        None,
    );

    // Force refresh - this will update cache and emit event if changed
    if let Err(e) = force_check_mounted_remotes(app).await {
        warn!("Failed to refresh mounted remotes after unmount: {e}");
    }

    Ok(crate::localized_success!(
        "backendSuccess.mount.unmounted",
        "mountPoint" => &mount_point
    ))
}

/// Unmount all remotes
#[tauri::command]
pub async fn unmount_all_remotes(app: AppHandle, context: String) -> Result<String, String> {
    let state = app.state::<RcloneState>();
    info!("🗑️ Unmounting all remotes");

    use crate::rclone::backend::BackendManager;
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    let _ = backend
        .post_json(&state.client, mount::UNMOUNTALL, None)
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    if context != "shutdown" {
        // Force refresh - this will update cache and emit event if changed
        if let Err(e) = force_check_mounted_remotes(app).await {
            warn!("Failed to refresh mounted remotes after unmount all: {e}");
        }
    }

    info!("✅ All remotes unmounted successfully");

    Ok(crate::localized_success!(
        "backendSuccess.mount.allUnmounted"
    ))
}

// ============================================================================
// PROFILE-BASED COMMAND
// ============================================================================

/// Mount a remote using a named profile
/// Resolves all options (mount, vfs, filter, backend) from cached settings
#[tauri::command]
pub async fn mount_remote_profile(app: AppHandle, params: ProfileParams) -> Result<(), String> {
    let (config, settings) = crate::rclone::commands::common::resolve_profile_settings(
        &app,
        &params.remote_name,
        &params.profile_name,
        "mountConfigs",
    )
    .await?;

    let mut mount_params = MountParams::from_config(params.remote_name.clone(), &config, &settings)
        .ok_or_else(|| {
            crate::localized_error!(
                "backendErrors.mount.configIncomplete",
                "profile" => &params.profile_name
            )
        })?;

    // Ensure profile is set from the function parameter, not the config object
    mount_params.profile = Some(params.profile_name.clone());

    mount_remote(app, mount_params).await
}
