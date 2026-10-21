use std::collections::HashMap;

use crate::context::AppHandle;
use log::info;
use serde_json::{Value, json};

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

use crate::rclone::backend::{routing_transport::RoutingTransport, types::Backend};

use super::common::{CommonConfigParams, OperationContext, parse_common_config};

/// Parameters for mounting a remote filesystem
#[derive(Debug, serde::Deserialize, Clone)]
pub struct MountParams {
    #[serde(skip)]
    pub backend: Option<Backend>,
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
    pub quick_run_id: Option<String>,
    pub execute_id: Option<String>,
    pub workflow_id: Option<String>,
    pub node_id: Option<String>,
    pub no_cache: Option<bool>,
}

impl MountParams {
    pub fn from_config(
        remote_name: String,
        config: &Value,
        settings: &Value,
    ) -> Result<Self, String> {
        Self::from_common(remote_name, parse_common_config(config, settings)?)
    }

    pub fn from_common(remote_name: String, common: CommonConfigParams) -> Result<Self, String> {
        let rclone_config = &common.rclone_config;
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
            return Err(
                crate::localized_error!("backendErrors.rclone.invalidFlags", "error" => "Missing mountPoint"),
            );
        }

        Ok(Self {
            backend: None,
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
            quick_run_id: None,
            execute_id: None,
            workflow_id: None,
            node_id: None,
            no_cache: None,
        })
    }

    pub fn to_rclone_body(&self) -> Result<Value, String> {
        let mut builder = crate::rclone::commands::common::RclonePayloadBuilder::from_rclone_config(
            &self.rclone_config,
        );
        builder
            .insert("fs", self.source.as_str())
            .insert("mountPoint", self.mount_point.as_str())
            .insert("_async", true)
            .with_vfs_options(self.vfs_options.as_ref())
            .with_filter_options(self.filter_options.as_ref())
            .with_backend_options(self.backend_options.as_ref());
        builder.with_runtime_remote_options(self.runtime_remote_options.as_ref())?;
        Ok(builder.build())
    }
}

/// Mount a remote filesystem (not exposed as Tauri command - use `mount_remote_profile`)
pub async fn mount_remote(app: AppHandle, params: MountParams) -> Result<(), String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = match &params.backend {
        Some(backend) => backend.clone(),
        None => backend_manager.get_active().await,
    };
    let cache = backend_manager.remote_cache_for(&backend.name);

    #[cfg(target_os = "android")]
    if params.mount_type == "saf" {
        let payload = params.to_rclone_body()?;
        let mount_point = params.mount_point.clone();

        log_operation(
            LogLevel::Info,
            Some(params.remote_name.clone()),
            Some("Mount SAF remote".to_string()),
            format!(
                "Attempting to mount SAF at {mount_point} (type: {})",
                params.mount_type
            ),
            Some(json!({
                "mount_point": &mount_point,
                "remote_name": &params.remote_name,
                "mount_type": &params.mount_type,
                "payload": super::common::redact_value(&payload, &app),
            })),
        );

        let transport = RoutingTransport::for_backend(app.clone(), backend.clone());
        if let Err(e) = transport.rpc("vfs/stream/mount", Some(&payload)).await {
            let error_msg = format!("Failed to initialize SAF VFS stream: {e}");
            log_operation(
                LogLevel::Error,
                Some(params.remote_name.clone()),
                Some("Mount SAF remote failed".to_string()),
                error_msg.clone(),
                None,
            );
            return Err(error_msg);
        }

        let mounted_remote = crate::utils::types::remotes::MountedRemote {
            fs: params.source.clone(),
            mount_point: mount_point.clone(),
            profile: params.profile.clone(),
            quick_run_id: params.quick_run_id.clone(),
            execute_id: params.execute_id.clone(),
            origin: params.origin.clone(),
            workflow_id: params.workflow_id.clone(),
            node_id: params.node_id.clone(),
        };

        cache.preseed_mount_metadata(mounted_remote).await;

        let backend_name = backend.name.clone();
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

    let payload = params.to_rclone_body()?;

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
    let metadata = super::job::JobMetadata::new(
        params.remote_name.clone(),
        crate::utils::types::jobs::JobType::Mount,
        vec![params.source.clone()],
        params.mount_point.clone(),
    )
    .with_profile(params.profile.clone())
    .with_origin(params.origin.clone())
    .with_no_cache(params.no_cache.unwrap_or(false))
    .with_quick_run_id(params.quick_run_id.clone())
    .with_execute_id(params.execute_id.clone())
    .with_workflow_id(params.workflow_id.clone())
    .with_node_id(params.node_id.clone());

    // Submit as a job and wait for completion for mount operations.
    let _ = super::job::submit_job_with_options(
        app.clone(),
        crate::rclone::endpoints::mount::MOUNT,
        payload,
        metadata,
        super::job::SubmitJobOptions {
            wait_for_completion: true,
            backend: Some(backend.clone()),
        },
    )
    .await?;

    // Pre-seed metadata so the reconciliation attaches profile / quick_run_id atomically
    cache
        .preseed_mount_metadata(crate::utils::types::remotes::MountedRemote {
            fs: params.source.clone(),
            mount_point: params.mount_point.clone(),
            profile: params.profile.clone(),
            quick_run_id: params.quick_run_id.clone(),
            origin: params.origin.clone(),
            execute_id: params.execute_id.clone(),
            workflow_id: params.workflow_id.clone(),
            node_id: params.node_id.clone(),
        })
        .await;
    refresh_mounts_quietly(&app, &backend).await;

    let backend_name = backend.name.clone();
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
pub async fn unmount_remote(
    app: AppHandle,
    mount_point: String,
    remote_name: String,
) -> Result<String, String> {
    let backend = app.state::<BackendManager>().get_active().await;
    unmount_remote_on_backend(app, backend, mount_point, remote_name).await
}

pub(crate) async fn unmount_remote_on_backend(
    app: AppHandle,
    backend: Backend,
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
            NotificationEvent::Mount(MountStage::UnmountFailed {
                backend: backend.name.clone(),
                remote: remote_name.clone(),
                profile: None,
                error: error_msg.clone(),
            }),
        );
        return Err(error_msg);
    }

    #[cfg(target_os = "android")]
    if mount_point.starts_with("saf://") {
        let mounted_entry = backend_manager
            .remote_cache_for(&backend.name)
            .get_mount_by_point(&mount_point)
            .await;
        let profile = mounted_entry
            .as_ref()
            .and_then(|m| m.profile.clone())
            .filter(|p| !p.trim().is_empty());
        let fs_name = mounted_entry
            .as_ref()
            .map(|m| m.fs.clone())
            .unwrap_or_else(|| {
                if remote_name.ends_with(':') {
                    remote_name.clone()
                } else {
                    format!("{remote_name}:")
                }
            });

        let mut current_mounts = backend_manager
            .remote_cache_for(&backend.name)
            .get_mounted_remotes()
            .await;
        current_mounts
            .retain(|m| m.mount_point != mount_point && m.fs != remote_name && m.fs != fs_name);
        backend_manager
            .remote_cache_for(&backend.name)
            .update_mounts_if_changed(current_mounts)
            .await;

        let transport = RoutingTransport::for_backend(app.clone(), backend.clone());
        let _ = transport
            .rpc("vfs/stream/unmount", Some(&json!({ "fs": fs_name })))
            .await;

        let backend_name = backend.name.clone();
        notify(
            &app,
            NotificationEvent::Mount(MountStage::UnmountSucceeded {
                backend: backend_name,
                remote: remote_name.clone(),
                profile,
            }),
        );

        refresh_mounts_quietly(&app, &backend).await;

        return Ok(crate::localized_success!(
            "backendSuccess.mount.unmounted",
            "mountPoint" => &mount_point
        ));
    }

    let transport = RoutingTransport::for_backend(app.clone(), backend.clone());
    let payload = json!({ "mountPoint": mount_point });

    log_operation(
        LogLevel::Info,
        Some(remote_name.clone()),
        Some("Unmount remote".to_string()),
        format!("Attempting to unmount {mount_point}"),
        None,
    );

    let profile = backend_manager
        .remote_cache_for(&backend.name)
        .get_mount_by_point(&mount_point)
        .await
        .and_then(|m| m.profile)
        .filter(|p| !p.trim().is_empty());

    let backend_name_for_err = backend.name.clone();

    if let Err(e) = transport
        .rpc(crate::rclone::endpoints::mount::UNMOUNT, Some(&payload))
        .await
    {
        let raw_err = e.to_string();
        let error_msg = crate::rclone::engine::error_mapper::map_rclone_error(&raw_err)
            .unwrap_or_else(
                || crate::localized_error!("backendErrors.request.failed", "error" => &raw_err),
            );

        log_operation(
            LogLevel::Error,
            Some(remote_name.clone()),
            Some("Unmount remote".to_string()),
            format!("Failed to unmount {mount_point}: {error_msg}"),
            None,
        );
        notify(
            &app,
            NotificationEvent::Mount(MountStage::UnmountFailed {
                backend: backend_name_for_err,
                remote: remote_name.clone(),
                profile: profile.clone(),
                error: error_msg.clone(),
            }),
        );
        refresh_mounts_quietly(&app, &backend).await;
        return Err(error_msg);
    }

    log_operation(
        LogLevel::Info,
        Some(remote_name.clone()),
        Some("Unmount remote".to_string()),
        format!("Successfully unmounted {mount_point}"),
        None,
    );

    let backend_name = backend.name.clone();
    notify(
        &app,
        NotificationEvent::Mount(MountStage::UnmountSucceeded {
            backend: backend_name,
            remote: remote_name.clone(),
            profile,
        }),
    );

    refresh_mounts_quietly(&app, &backend).await;

    Ok(crate::localized_success!(
        "backendSuccess.mount.unmounted",
        "mountPoint" => &mount_point
    ))
}

/// Unmount all remotes
pub async fn unmount_all_remotes(
    app: AppHandle,
    context: OperationContext,
) -> Result<String, String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    #[cfg(target_os = "android")]
    if backend.is_local {
        info!("🗑️ Unmounting all SAF remotes");
        let mounted = backend_manager
            .remote_cache_for(&backend.name)
            .get_mounted_remotes()
            .await;
        let transport = RoutingTransport::for_backend(app.clone(), backend.clone());
        for m in &mounted {
            let _ = transport
                .rpc("vfs/stream/unmount", Some(&json!({ "fs": &m.fs })))
                .await;
        }
        backend_manager
            .remote_cache_for(&backend.name)
            .update_mounts_if_changed(vec![])
            .await;
        crate::rclone::backend::saf_bridge::notify_roots_changed();
        if !context.is_shutdown() {
            refresh_mounts_quietly(&app, &backend).await;
        }
        notify(&app, NotificationEvent::Mount(MountStage::AllUnmounted));
        return Ok(crate::localized_success!(
            "backendSuccess.mount.allUnmounted"
        ));
    }

    {
        let transport = RoutingTransport::for_backend(app.clone(), backend.clone());
        info!("🗑️ Unmounting all remotes");

        let _ = transport
            .rpc(crate::rclone::endpoints::mount::UNMOUNTALL, None)
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
            refresh_mounts_quietly(&app, &backend).await;
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
pub async fn mount_remote_profile(app: AppHandle, params: ProfileParams) -> Result<(), String> {
    let resolved = match crate::rclone::commands::common::resolve_profile_settings(
        &app,
        &params.remote_name,
        &params.profile_name,
        OperationType::Mount,
        params.backend_name.as_deref(),
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
        match MountParams::from_common(params.remote_name.clone(), resolved.params) {
            Ok(p) => p,
            Err(error_msg) => {
                notify(
                    &app,
                    NotificationEvent::Mount(MountStage::Failed {
                        backend: resolved.backend.name.clone(),
                        remote: params.remote_name.clone(),
                        profile: Some(params.profile_name.clone()),
                        error: error_msg.clone(),
                    }),
                );
                return Err(error_msg);
            }
        };

    // Ensure profile is set from the function parameter, not the config object
    mount_params.backend = Some(resolved.backend);
    mount_params.profile = Some(params.profile_name.clone());
    mount_params.origin = params
        .source
        .or(Some(crate::utils::types::origin::Origin::Dashboard));
    mount_params.quick_run_id = None;
    mount_params.execute_id = Some(uuid::Uuid::new_v4().to_string());
    mount_params.no_cache = params.no_cache;

    mount_remote(app, mount_params).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn saved_mount_with_empty_default_helper_profiles_builds_payload() {
        let saved: crate::utils::types::remotes::RemoteSettings = serde_json::from_value(json!({
            "mountConfigs": {"Default": {
                "app": {"vfsProfile": "Default", "filterProfile": "Default", "backendProfile": "Default", "runtimeRemoteProfile": "Default"},
                "rclone": {"fs": "dropbox:", "mountPoint": "/mnt/dropbox"}
            }}
        })).unwrap();
        let settings = serde_json::to_value(saved).unwrap();
        let config = &settings["mountConfigs"]["Default"];
        let params = MountParams::from_config("dropbox".into(), config, &settings).unwrap();
        assert!(params.vfs_options.is_none());
        assert!(params.filter_options.is_none());
        assert!(params.backend_options.is_none());
        assert!(params.runtime_remote_options.is_none());
        let body = params.to_rclone_body().unwrap();
        assert_eq!(body["fs"], "dropbox:");
        assert_eq!(body["mountPoint"], "/mnt/dropbox");
    }

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
            backend: None,
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
            vfs_options: Some(HashMap::from([
                ("vfs-cache-mode".to_string(), json!("writes")),
                ("CacheMode".to_string(), json!("full")),
            ])),
            filter_options: Some(HashMap::from([
                ("exclude".to_string(), json!(".*")),
                ("ExcludeRule".to_string(), json!(["*.bak"])),
            ])),
            backend_options: Some(HashMap::from([
                ("chunk-size".to_string(), json!("10M")),
                ("AutoConfirm".to_string(), json!(true)),
            ])),
            runtime_remote_options: None,
            profile: Some("my_profile".to_string()),
            quick_run_id: None,
            execute_id: None,
            origin: None,
            workflow_id: None,
            node_id: None,
            no_cache: None,
        };

        let body = params.to_rclone_body().unwrap();
        let obj = body.as_object().unwrap();

        assert_eq!(obj.get("fs").unwrap(), "pCloud:backups");
        assert_eq!(obj.get("_async").unwrap(), &json!(true));

        // Flat lowercase keys placed directly at top-level body (normalized)
        assert_eq!(obj.get("vfs_cache_mode").unwrap(), "writes");
        assert_eq!(obj.get("exclude").unwrap(), ".*");
        assert_eq!(obj.get("chunk_size").unwrap(), "10M");

        // PascalCase nested options placed into their respective blocks
        let vfs_opt = obj.get("vfsOpt").unwrap().as_object().unwrap();
        assert_eq!(vfs_opt.get("CacheMode").unwrap(), "full");

        let filter = obj.get("_filter").unwrap().as_object().unwrap();
        assert_eq!(filter.get("ExcludeRule").unwrap(), &json!(["*.bak"]));

        let config = obj.get("_config").unwrap().as_object().unwrap();
        assert_eq!(config.get("AutoConfirm").unwrap(), &json!(true));
    }
}
