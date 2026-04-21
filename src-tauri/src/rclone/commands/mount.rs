use log::{debug, info, warn};
use serde_json::{Value, json};
use std::collections::HashMap;
use tauri::{AppHandle, Manager};

use crate::{
    rclone::{backend::BackendManager, state::watcher::force_check_mounted_remotes},
    utils::{
        app::notification::{NotificationEvent, notify},
        json_helpers::unwrap_nested_options,
        logging::log::log_operation,
        rclone::endpoints::mount,
        types::{core::RcloneState, jobs::JobType, logs::LogLevel, remotes::ProfileParams},
    },
};

use super::common::{
    FromConfig, fs_value_with_runtime_overrides, parse_common_config, redact_sensitive_values,
};
use super::job::{JobMetadata, SubmitJobOptions, submit_job_with_options};

/// Parameters for mounting a remote filesystem
#[derive(Debug, serde::Deserialize, Clone)]
pub struct MountParams {
    pub remote_name: String,
    pub source: String,
    pub mount_point: String,
    pub mount_type: String,
    pub mount_options: Option<HashMap<String, Value>>,
    pub vfs_options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub backend_options: Option<HashMap<String, Value>>,
    pub runtime_remote_options: Option<HashMap<String, Value>>,
    pub profile: Option<String>,
    pub origin: Option<crate::utils::types::origin::Origin>,
    pub no_cache: Option<bool>,
}

/// Internal struct for Rclone API serialization
#[derive(serde::Serialize)]
struct RcloneMountBody {
    pub fs: Value,
    #[serde(rename = "mountPoint")]
    pub mount_point: String,
    #[serde(rename = "mountType", skip_serializing_if = "Option::is_none")]
    pub mount_type: Option<String>,
    #[serde(rename = "mountOpt", skip_serializing_if = "Option::is_none")]
    pub mount_options: Option<HashMap<String, Value>>,
    #[serde(rename = "vfsOpt", skip_serializing_if = "Option::is_none")]
    pub vfs_options: Option<HashMap<String, Value>>,
    #[serde(rename = "_async", skip_serializing_if = "Option::is_none")]
    pub async_flag: Option<bool>,
    #[serde(rename = "_config", skip_serializing_if = "Option::is_none")]
    pub config: Option<HashMap<String, Value>>,
    #[serde(rename = "_filter", skip_serializing_if = "Option::is_none")]
    pub filter: Option<HashMap<String, Value>>,
}

impl FromConfig for MountParams {
    fn from_config(remote_name: String, config: &Value, settings: &Value) -> Option<Self> {
        let common = parse_common_config(config, settings, &remote_name)?;

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
            runtime_remote_options: common.runtime_remote_options,
            profile: common.profile,
            origin: None,
            no_cache: None,
        })
    }
}

impl MountParams {
    pub fn to_rclone_body(&self) -> Value {
        // Flatten backend options
        let backend_opts = self.backend_options.clone().map(unwrap_nested_options);
        // Clean implementation detail: filter out empty/null values from backend options
        let final_backend_opts = backend_opts
            .map(|opts| {
                opts.into_iter()
                    .filter(|(_, v)| !v.is_null() && !matches!(v, Value::String(s) if s.is_empty()))
                    .collect()
            })
            .filter(|m: &HashMap<String, Value>| !m.is_empty());

        let body = RcloneMountBody {
            fs: fs_value_with_runtime_overrides(&self.source, self.runtime_remote_options.as_ref()),
            mount_point: self.mount_point.clone(),
            mount_type: if self.mount_type.is_empty() {
                None
            } else {
                Some(self.mount_type.clone())
            },
            mount_options: self.mount_options.clone(),
            vfs_options: self.vfs_options.clone().map(unwrap_nested_options),
            // Request async job so rclone returns a job id we can track
            async_flag: Some(true),
            config: final_backend_opts,
            filter: self.filter_options.clone().map(unwrap_nested_options),
        };

        serde_json::to_value(body).unwrap_or(json!({}))
    }
}

/// Mount a remote filesystem (not exposed as Tauri command - use mount_remote_profile)
pub async fn mount_remote(app: AppHandle, params: MountParams) -> Result<(), String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let cache = &backend_manager.remote_cache;

    let mounted_remotes = cache.get_mounted_remotes().await;
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

    let log_context = json!({
        "mount_point": params.mount_point,
        "remote_name": params.remote_name,
        "mount_type": params.mount_type,
        "options": redact_sensitive_values(&params.mount_options.clone().unwrap_or_default(), &app),
    });

    log_operation(
        LogLevel::Info,
        Some(params.remote_name.clone()),
        Some("Mount remote".to_string()),
        format!("Attempting to mount at {}", params.mount_point),
        Some(log_context),
    );

    let state = app.state::<RcloneState>();
    let url = backend.url_for(mount::MOUNT);
    let payload = params.to_rclone_body();
    let client = state.client.clone();

    // Build request like sync does
    let request = backend.inject_auth(client.post(&url));

    // Create job metadata
    let metadata = JobMetadata {
        remote_name: params.remote_name.clone(),
        job_type: JobType::Mount,
        operation_name: "Mount remote".to_string(),
        source: params.source.clone(),
        destination: params.mount_point.clone(),
        profile: params.profile.clone(),
        origin: params.origin.clone(),
        group: None,
        no_cache: params.no_cache.unwrap_or(false),
    };

    // Submit as a job and wait for completion for mount operations.
    let _ = submit_job_with_options(
        app.clone(),
        client,
        request,
        payload,
        metadata,
        SubmitJobOptions {
            wait_for_completion: true,
        },
    )
    .await?;

    // Refresh first so the entry exists in cache, then attach the profile to it.
    if let Err(e) = force_check_mounted_remotes(app.clone()).await {
        warn!("Failed to refresh mounted remotes: {e}");
    }
    cache
        .store_mount_profile(&params.mount_point, params.profile.clone())
        .await;

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

    // Get profile from cache before unmounting for notification
    let profile = backend_manager
        .remote_cache
        .get_mount_profile(&mount_point)
        .await
        .unwrap_or_default();

    let _ = backend
        .post_json(&state.client, mount::UNMOUNT, Some(&payload))
        .await
        .map_err(|e| {
            let error_msg = crate::localized_error!("backendErrors.request.failed", "error" => &e);
            notify(
                &app,
                NotificationEvent::MountFailed {
                    mount_point: mount_point.clone(),
                    error: e.to_string(),
                },
            );
            error_msg
        })?;

    log_operation(
        LogLevel::Info,
        Some(remote_name.clone()),
        Some("Unmount remote".to_string()),
        format!("Successfully unmounted {mount_point}"),
        None,
    );

    notify(
        &app,
        NotificationEvent::UnmountSucceeded {
            remote: remote_name.clone(),
            profile,
            origin: crate::utils::types::origin::Origin::Dashboard,
        },
    );

    if let Err(e) = force_check_mounted_remotes(app.clone()).await {
        warn!("Failed to refresh mounted remotes: {e}");
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

    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    // Check current mounted remotes first.
    let mounted = backend_manager.remote_cache.get_mounted_remotes().await;
    if mounted.is_empty() || context == "shutdown" {
        debug!("No mounted remotes to unmount — skipping API call");
        // Refresh cache for UI consistency (unless during shutdown)
        if context != "shutdown" {
            if let Err(e) = force_check_mounted_remotes(app.clone()).await {
                warn!("Failed to refresh mounted remotes: {e}");
            } // Inform the user that there's nothing to do
            notify(&app, NotificationEvent::NothingToUnmount);
        }
        // Silent no-op during shutdown
        return Ok(crate::localized_success!(
            "backendSuccess.mount.allUnmounted"
        ));
    }

    let _ = backend
        .post_json(&state.client, mount::UNMOUNTALL, None)
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))?;

    if context != "shutdown"
        && let Err(e) = force_check_mounted_remotes(app.clone()).await
    {
        warn!("Failed to refresh mounted remotes: {e}");
    }

    info!("✅ All remotes unmounted successfully");

    notify(&app, NotificationEvent::AllUnmounted);

    Ok(crate::localized_success!(
        "backendSuccess.mount.allUnmounted"
    ))
}

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
    mount_params.origin = params.origin;
    mount_params.no_cache = params.no_cache;

    mount_remote(app, mount_params).await
}
