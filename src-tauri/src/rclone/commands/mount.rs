use std::collections::HashMap;

use log::info;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::{
    rclone::{backend::BackendManager, state::watcher::refresh_mounts_quietly},
    utils::{
        app::notification::{MountStage, NotificationEvent, notify},
        logging::log::log_operation,
        types::{
            logs::LogLevel,
            remotes::{OperationType, ProfileParams},
        },
    },
};

use super::common::{FromConfig, OperationContext, parse_common_config};

/// Parameters for mounting a remote filesystem
#[derive(Debug, serde::Deserialize, Clone)]
pub struct MountParams {
    pub remote_name: String,
    pub source: String,
    pub mount_point: String,
    pub mount_type: String,
    pub rclone_config: Value,
    pub vfs_options: Option<HashMap<String, Value>>,
    pub filter_options: Option<HashMap<String, Value>>,
    pub backend_options: Option<HashMap<String, Value>>,
    pub runtime_remote_options: Option<HashMap<String, Value>>,
    pub profile: Option<String>,
    pub origin: Option<crate::utils::types::origin::Origin>,
    pub no_cache: Option<bool>,
}

impl FromConfig for MountParams {
    fn from_config(remote_name: String, config: &Value, settings: &Value) -> Option<Self> {
        let common = parse_common_config(config, settings)?;
        let rclone_config = config.get("rclone").unwrap_or(config);
        let mount_type = rclone_config
            .get("mountType")
            .and_then(|v| v.as_str())
            .unwrap_or("mount")
            .to_string();

        #[cfg(not(target_os = "android"))]
        let mount_point = common.dest.clone();

        #[cfg(target_os = "android")]
        let mount_point = if mount_type == "saf" {
            format!("saf://{remote_name}")
        } else {
            common.dest.clone()
        };

        if mount_point.is_empty() {
            return None;
        }

        Some(Self {
            remote_name,
            source: common.first_source(),
            mount_point,
            mount_type,
            rclone_config: common.rclone_config.clone(),
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
        let mut body = serde_json::Map::new();

        if let Value::Object(map) = &self.rclone_config {
            let mut legacy_mount = serde_json::Map::new();
            let mut legacy_config = serde_json::Map::new();

            for (k, v) in map {
                if crate::utils::json_helpers::is_path_key(k) {
                    continue;
                }
                if crate::utils::json_helpers::is_flat_option_key(k) {
                    body.insert(k.clone(), v.clone());
                } else if k == "mountOpt" && v.is_object() {
                    if let Some(opts) = v.as_object() {
                        legacy_mount.extend(opts.clone());
                    }
                } else if k == "_config" && v.is_object() {
                    if let Some(opts) = v.as_object() {
                        legacy_config.extend(opts.clone());
                    }
                } else {
                    legacy_config.insert(k.clone(), v.clone());
                }
            }

            if !legacy_mount.is_empty() {
                body.insert("mountOpt".to_string(), Value::Object(legacy_mount));
            }
            if !legacy_config.is_empty() {
                body.insert("_config".to_string(), Value::Object(legacy_config));
            }
        }

        // 1. Inject runtime remote overrides directly into body as flat flags and set mountPoint
        body.insert("fs".to_string(), json!(self.source));
        body.insert("mountPoint".to_string(), json!(self.mount_point));
        if let Some(opts) = self.runtime_remote_options.as_ref() {
            for (k, v) in opts {
                if !body.contains_key(k) {
                    body.insert(k.clone(), v.clone());
                }
            }
        }

        // 2. Merge resolved profile blocks if they exist and are non-empty
        if let Some(vfs_opts) = &self.vfs_options {
            let val = serde_json::to_value(vfs_opts).unwrap_or_default();
            if val.as_object().is_some_and(|o| !o.is_empty()) {
                body.insert("vfsOpt".to_string(), val);
            }
        }
        if let Some(filter_opts) = &self.filter_options {
            let val = serde_json::to_value(filter_opts).unwrap_or_default();
            if val.as_object().is_some_and(|o| !o.is_empty()) {
                body.insert("_filter".to_string(), val);
            }
        }
        if let Some(backend_opts) = &self.backend_options {
            let final_backend = crate::rclone::commands::common::filter_empty_options(backend_opts);
            if !final_backend.is_empty() {
                let mut config_map = body
                    .get("_config")
                    .and_then(|v| v.as_object())
                    .cloned()
                    .unwrap_or_default();
                for (k, v) in final_backend {
                    config_map.entry(k).or_insert(v);
                }
                if !config_map.is_empty() {
                    body.insert("_config".to_string(), Value::Object(config_map));
                }
            }
        }

        // 3. Mark it async
        body.insert("_async".to_string(), json!(true));

        Value::Object(body)
    }
}

/// Mount a remote filesystem (not exposed as Tauri command - use `mount_remote_profile`)
pub async fn mount_remote(app: AppHandle, params: MountParams) -> Result<(), String> {
    let backend_manager = app.state::<BackendManager>();
    let cache = &backend_manager.remote_cache;

    #[cfg(target_os = "android")]
    if params.mount_type == "saf" {
        let payload = params.to_rclone_body();
        let mount_point = params.mount_point;

        log_operation(
            LogLevel::Info,
            Some(params.remote_name.clone()),
            Some("Mount SAF remote".to_string()),
            format!(
                "Attempting to mount SAF at {mount_point} (type: {})",
                params.mount_type
            ),
            Some(json!({
                "mount_point": mount_point,
                "remote_name": params.remote_name,
                "mount_type": params.mount_type,
                "payload": payload,
            })),
        );

        let mounted_remote = crate::utils::types::remotes::MountedRemote {
            fs: params.source.clone(),
            mount_point: mount_point.clone(),
            profile: params.profile.clone(),
        };

        let mut current_mounts = cache.get_mounted_remotes().await;
        current_mounts.retain(|m| m.mount_point != mount_point);
        current_mounts.push(mounted_remote);
        cache.update_mounts_if_changed(current_mounts, &app).await;
        cache
            .store_mount_profile(&mount_point, params.profile.clone())
            .await;

        crate::rclone::backend::saf_bridge::notify_roots_changed();

        let backend_name = backend_manager.get_active_name().await;
        notify(
            &app,
            NotificationEvent::Mount(MountStage::Succeeded {
                backend: backend_name,
                remote: params.remote_name.clone(),
                profile: params.profile.clone(),
                mount_point: mount_point.clone(),
            }),
        );

        return Ok(());
    }

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
        log::warn!("{error_msg}");
        return Err(error_msg);
    }

    let payload = params.to_rclone_body();

    let log_context = json!({
        "mount_point": params.mount_point,
        "remote_name": params.remote_name,
        "mount_type": params.mount_type,
        "arguments": super::common::redact_value(&payload, &app),
    });

    log_operation(
        LogLevel::Info,
        Some(params.remote_name.clone()),
        Some("Mount remote".to_string()),
        format!("Attempting to mount at {}", params.mount_point),
        Some(log_context),
    );

    // Create job metadata
    let metadata = super::job::JobMetadata {
        remote_name: params.remote_name.clone(),
        job_type: crate::utils::types::jobs::JobType::Mount,
        source: vec![params.source.clone()],
        destination: params.mount_point.clone(),
        profile: params.profile.clone(),
        origin: params.origin.clone(),
        group: None,
        no_cache: params.no_cache.unwrap_or(false),
        dry_run: false,
        parent_job_id: None,
    };

    // Submit as a job and wait for completion for mount operations.
    let _ = super::job::submit_job_with_options(
        app.clone(),
        crate::utils::rclone::endpoints::mount::MOUNT,
        payload,
        metadata,
        super::job::SubmitJobOptions {
            wait_for_completion: true,
        },
    )
    .await?;

    // Refresh first so the entry exists in cache, then attach the profile to it.
    refresh_mounts_quietly(&app).await;
    cache
        .store_mount_profile(&params.mount_point, params.profile.clone())
        .await;

    let backend_name = backend_manager.get_active_name().await;
    notify(
        &app,
        NotificationEvent::Mount(MountStage::Succeeded {
            backend: backend_name,
            remote: params.remote_name.clone(),
            profile: params.profile.clone(),
            mount_point: params.mount_point.clone(),
        }),
    );

    Ok(())
}

/// Unmount a remote filesystem
#[tauri::command]
pub async fn unmount_remote(
    app: AppHandle,
    mount_point: String,
    remote_name: String,
) -> Result<String, String> {
    let backend_manager = app.state::<BackendManager>();

    if mount_point.trim().is_empty() {
        let error_msg = crate::localized_error!("backendErrors.mount.pointEmpty");
        log_operation(
            LogLevel::Error,
            Some(remote_name.clone()),
            Some("Unmount remote".to_string()),
            format!("Failed to unmount: {error_msg}"),
            None,
        );
        notify(
            &app,
            NotificationEvent::Mount(MountStage::Failed {
                backend: backend_manager.get_active_name().await,
                remote: remote_name.clone(),
                profile: None,
                error: error_msg.clone(),
            }),
        );
        return Err(error_msg);
    }

    #[cfg(target_os = "android")]
    if mount_point.starts_with("saf://") {
        let profile = backend_manager
            .remote_cache
            .get_mount_by_point(&mount_point)
            .await
            .and_then(|m| m.profile)
            .unwrap_or_default();

        let mut current_mounts = backend_manager.remote_cache.get_mounted_remotes().await;
        current_mounts.retain(|m| {
            m.mount_point != mount_point && m.fs != remote_name && m.fs != format!("{remote_name}:")
        });
        backend_manager
            .remote_cache
            .update_mounts_if_changed(current_mounts, &app)
            .await;

        crate::rclone::backend::saf_bridge::notify_roots_changed();

        let backend_name = backend_manager.get_active_name().await;
        notify(
            &app,
            NotificationEvent::Mount(MountStage::UnmountSucceeded {
                backend: backend_name,
                remote: remote_name.clone(),
                profile: Some(profile),
            }),
        );

        refresh_mounts_quietly(&app).await;

        return Ok(crate::localized_success!(
            "backendSuccess.mount.unmounted",
            "mountPoint" => &mount_point
        ));
    }

    let transport = app
        .state::<crate::utils::types::state::RcloneState>()
        .transport
        .clone();
    let payload = json!({ "mountPoint": mount_point });

    log_operation(
        LogLevel::Info,
        Some(remote_name.clone()),
        Some("Unmount remote".to_string()),
        format!("Attempting to unmount {mount_point}"),
        None,
    );

    let profile = backend_manager
        .remote_cache
        .get_mount_by_point(&mount_point)
        .await
        .and_then(|m| m.profile)
        .unwrap_or_default();

    let backend_name_for_err = backend_manager.get_active_name().await;

    let _ = transport
        .rpc(
            crate::utils::rclone::endpoints::mount::UNMOUNT,
            Some(&payload),
        )
        .await
        .map_err(|e| {
            let error_msg = crate::localized_error!("backendErrors.request.failed", "error" => e);
            log_operation(
                LogLevel::Error,
                Some(remote_name.clone()),
                Some("Unmount remote".to_string()),
                format!("Failed to unmount {mount_point}: {error_msg}"),
                None,
            );
            notify(
                &app,
                NotificationEvent::Mount(MountStage::Failed {
                    backend: backend_name_for_err.clone(),
                    remote: remote_name.clone(),
                    profile: Some(profile.clone()),
                    error: e.to_string(),
                }),
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

    let backend_name = backend_manager.get_active_name().await;
    notify(
        &app,
        NotificationEvent::Mount(MountStage::UnmountSucceeded {
            backend: backend_name,
            remote: remote_name.clone(),
            profile: Some(profile.clone()),
        }),
    );

    refresh_mounts_quietly(&app).await;

    Ok(crate::localized_success!(
        "backendSuccess.mount.unmounted",
        "mountPoint" => &mount_point
    ))
}

/// Unmount all remotes
#[tauri::command]
pub async fn unmount_all_remotes(
    app: AppHandle,
    context: OperationContext,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        info!("🗑️ Unmounting all SAF remotes");
        let backend_manager = app.state::<BackendManager>();
        backend_manager
            .remote_cache
            .update_mounts_if_changed(vec![], &app)
            .await;
        crate::rclone::backend::saf_bridge::notify_roots_changed();
        if !context.is_shutdown() {
            refresh_mounts_quietly(&app).await;
        }
        notify(&app, NotificationEvent::Mount(MountStage::AllUnmounted));
        return Ok(crate::localized_success!(
            "backendSuccess.mount.allUnmounted"
        ));
    }

    #[cfg(not(target_os = "android"))]
    {
        let transport = app
            .state::<crate::utils::types::state::RcloneState>()
            .transport
            .clone();
        info!("🗑️ Unmounting all remotes");

        let _ = transport
            .rpc(crate::utils::rclone::endpoints::mount::UNMOUNTALL, None)
            .await
            .map_err(|e| {
                let error_msg =
                    crate::localized_error!("backendErrors.request.failed", "error" => e);
                log_operation(
                    LogLevel::Error,
                    None,
                    Some("Unmount all remotes".to_string()),
                    format!("Failed to unmount all remotes: {error_msg}"),
                    None,
                );
                error_msg
            })?;

        if !context.is_shutdown() {
            refresh_mounts_quietly(&app).await;
            notify(&app, NotificationEvent::Mount(MountStage::AllUnmounted));
        }

        info!("✅ All remotes unmounted successfully");

        Ok(crate::localized_success!(
            "backendSuccess.mount.allUnmounted"
        ))
    }
}

/// Mount a remote using a named profile
/// Resolves all options (mount, vfs, filter, backend) from cached settings
#[tauri::command]
pub async fn mount_remote_profile(app: AppHandle, params: ProfileParams) -> Result<(), String> {
    let (config, settings) = match crate::rclone::commands::common::resolve_profile_settings(
        &app,
        &params.remote_name,
        &params.profile_name,
        OperationType::Mount.config_key(),
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            notify(
                &app,
                NotificationEvent::Mount(MountStage::Failed {
                    backend: app.state::<BackendManager>().get_active_name().await,
                    remote: params.remote_name.clone(),
                    profile: Some(params.profile_name.clone()),
                    error: e.clone(),
                }),
            );
            return Err(e);
        }
    };

    let mut mount_params =
        if let Some(p) = MountParams::from_config(params.remote_name.clone(), &config, &settings) {
            p
        } else {
            let error_msg = crate::localized_error!(
                "backendErrors.mount.configIncomplete",
                "profile" => &params.profile_name
            );
            notify(
                &app,
                NotificationEvent::Mount(MountStage::Failed {
                    backend: app.state::<BackendManager>().get_active_name().await,
                    remote: params.remote_name.clone(),
                    profile: Some(params.profile_name.clone()),
                    error: error_msg.clone(),
                }),
            );
            return Err(error_msg);
        };

    // Ensure profile is set from the function parameter, not the config object
    mount_params.profile = Some(params.profile_name.clone());
    mount_params.origin = params.source;
    mount_params.no_cache = params.no_cache;

    mount_remote(app, mount_params).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_mount_params_from_config() {
        let config = json!({
            "app": {
                "vfsProfile": "vfs_writes",
                "filterProfile": "my_filters",
                "backendProfile": "my_backend"
            },
            "rclone": {
                "fs": "pCloud:backups",
                "mountPoint": "/mnt/pcloud",
                "mountType": "cmount",
                "mountOpt": {
                    "read-only": true
                }
            }
        });

        let settings = json!({
            "vfsConfigs": {
                "vfs_writes": {
                    "vfs-cache-mode": "writes"
                }
            },
            "filterConfigs": {
                "my_filters": {
                    "exclude": ".*"
                }
            },
            "backendConfigs": {
                "my_backend": {
                    "chunk-size": "10M"
                }
            }
        });

        let params = MountParams::from_config("pCloud".to_string(), &config, &settings).unwrap();
        assert_eq!(params.remote_name, "pCloud");
        assert_eq!(params.source, "pCloud:backups");
        assert_eq!(params.mount_point, "/mnt/pcloud");
        assert_eq!(params.mount_type, "cmount");
        assert!(params.vfs_options.is_some());
        assert_eq!(
            params.vfs_options.unwrap().get("vfs-cache-mode").unwrap(),
            "writes"
        );
    }

    #[test]
    fn test_mount_to_rclone_body() {
        let params = MountParams {
            remote_name: "pCloud".to_string(),
            source: "pCloud:backups".to_string(),
            mount_point: "/mnt/pcloud".to_string(),
            mount_type: "cmount".to_string(),
            rclone_config: json!({
                "mountType": "cmount",
                "mountOpt": {
                    "read-only": true
                }
            }),
            vfs_options: Some(HashMap::from([(
                "vfs-cache-mode".to_string(),
                json!("writes"),
            )])),
            filter_options: Some(HashMap::from([("exclude".to_string(), json!(".*"))])),
            backend_options: Some(HashMap::from([("chunk-size".to_string(), json!("10M"))])),
            runtime_remote_options: None,
            profile: Some("my_profile".to_string()),
            origin: None,
            no_cache: None,
        };

        let body = params.to_rclone_body();
        let obj = body.as_object().unwrap();

        assert_eq!(obj.get("fs").unwrap(), "pCloud:backups");
        assert_eq!(obj.get("_async").unwrap(), &json!(true));

        let vfs_opt = obj.get("vfsOpt").unwrap().as_object().unwrap();
        assert_eq!(vfs_opt.get("vfs-cache-mode").unwrap(), "writes");

        let filter = obj.get("_filter").unwrap().as_object().unwrap();
        assert_eq!(filter.get("exclude").unwrap(), ".*");

        let config = obj.get("_config").unwrap().as_object().unwrap();
        assert_eq!(config.get("chunk-size").unwrap(), "10M");
    }
}
