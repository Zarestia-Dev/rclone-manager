use crate::core::settings::AppSettingsManager;
use log::{error, info};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::{
    rclone::{
        backend::BackendManager,
        commands::{
            job::stop_job,
            mount::{mount_remote_profile, unmount_remote},
            serve::{start_serve_profile, stop_all_serves, stop_serve},
            sync::{
                start_bisync_profile, start_copy_profile, start_move_profile, start_sync_profile,
            },
        },
        state::scheduled_tasks::ScheduledTasksCache,
    },
    utils::{
        app::notification::send_notification,
        types::{jobs::JobStatus, remotes::ProfileParams},
    },
};

#[cfg(not(feature = "web-server"))]
pub fn show_main_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        info!("🪟 Showing main window");
        window.show().unwrap_or_else(|_| {
            error!("🚨 Failed to show main window");
        });
    } else {
        use crate::utils::app::builder::create_app_window;
        info!("⚠️ Main window not found. Building...");
        create_app_window(app, None);
    }
}

// ========== PROFILE-SPECIFIC HANDLERS ==========

/// Generic handler for starting job profiles (sync, copy, move, bisync)
/// Uses the profile-based functions that resolve options internally
async fn handle_start_job_profile(
    app: AppHandle,
    remote_name: String,
    profile_name: String,
    op_type: &str,
    op_name: &str,
) {
    let params = ProfileParams {
        remote_name: remote_name.clone(),
        profile_name: profile_name.clone(),
    };

    let result = match op_type {
        "sync" => start_sync_profile(app.clone(), params).await.map(|_| ()),
        "copy" => start_copy_profile(app.clone(), params).await.map(|_| ()),
        "move" => start_move_profile(app.clone(), params).await.map(|_| ()),
        "bisync" => start_bisync_profile(app.clone(), params).await.map(|_| ()),
        _ => Err(format!("Unknown operation type: {}", op_type)),
    };

    match result {
        Ok(_) => {
            info!(
                "✅ Started {} for {} profile '{}'",
                op_name, remote_name, profile_name
            );
        }
        Err(e) => {
            error!(
                "🚨 Failed to start {} for {} profile '{}': {}",
                op_name, remote_name, profile_name, e
            );
        }
    }
}

pub fn handle_mount_profile(app: AppHandle, remote_name: &str, profile_name: &str) {
    let app_clone = app.clone();
    let remote = remote_name.to_string();
    let profile = profile_name.to_string();

    tauri::async_runtime::spawn(async move {
        let params = ProfileParams {
            remote_name: remote.clone(),
            profile_name: profile.clone(),
        };

        match mount_remote_profile(app_clone.clone(), params).await {
            Ok(_) => {
                info!("✅ Mounted {} profile '{}'", remote, profile);
            }
            Err(e) => {
                error!("🚨 Failed to mount {} profile '{}': {}", remote, profile, e);
            }
        }
    });
}

pub fn handle_unmount_profile(app: AppHandle, remote_name: &str, profile_name: &str) {
    let app_clone = app.clone();
    let remote = remote_name.to_string();
    let profile = profile_name.to_string();

    tauri::async_runtime::spawn(async move {
        let backend_manager = app_clone.state::<BackendManager>();
        // active backend check removed as get_active returns Backend directly
        // We can just rely on get_active or if logic requires checking if active...
        // But get_active returns the backend logic.
        // Wait, for unmount, we need remote cache.
        // We removed locks.
        let cache = &backend_manager.remote_cache;

        let manager = app_clone.state::<AppSettingsManager>();
        let remote_names = cache.get_remotes().await;
        let settings_val = crate::core::settings::remote::manager::get_all_remote_settings_sync(
            manager.inner(),
            &remote_names,
        );
        let settings = settings_val
            .get(&remote)
            .cloned()
            .unwrap_or(serde_json::Value::Null);

        let mount_point = settings
            .get("mountConfigs")
            .and_then(|v| v.as_object())
            .and_then(|configs| configs.get(&profile))
            .and_then(|config| config.get("dest"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        if mount_point.is_empty() {
            error!("❌ Mount point not found for profile '{}'", profile);
            send_notification(
                &app_clone,
                "notification.title.unmountFailed",
                &serde_json::json!({
                    "key": "notification.body.profileNotFound",
                    "params": {
                        "profile": profile
                    }
                })
                .to_string(),
            );
            return;
        }

        match unmount_remote(app_clone.clone(), mount_point.clone(), remote.clone()).await {
            Ok(_) => {
                info!("🛑 Unmounted {} profile '{}'", remote, profile);
            }
            Err(e) => {
                error!(
                    "🚨 Failed to unmount {} profile '{}': {}",
                    remote, profile, e
                );
            }
        }
    });
}

// Job profile handlers using generic function
pub fn handle_sync_profile(app: AppHandle, remote_name: &str, profile_name: &str) {
    let r = remote_name.to_string();
    let p = profile_name.to_string();
    tauri::async_runtime::spawn(handle_start_job_profile(app, r, p, "sync", "Sync"));
}

pub fn handle_copy_profile(app: AppHandle, remote_name: &str, profile_name: &str) {
    let r = remote_name.to_string();
    let p = profile_name.to_string();
    tauri::async_runtime::spawn(handle_start_job_profile(app, r, p, "copy", "Copy"));
}

pub fn handle_move_profile(app: AppHandle, remote_name: &str, profile_name: &str) {
    let r = remote_name.to_string();
    let p = profile_name.to_string();
    tauri::async_runtime::spawn(handle_start_job_profile(app, r, p, "move", "Move"));
}

pub fn handle_bisync_profile(app: AppHandle, remote_name: &str, profile_name: &str) {
    let r = remote_name.to_string();
    let p = profile_name.to_string();
    tauri::async_runtime::spawn(handle_start_job_profile(app, r, p, "bisync", "BiSync"));
}

/// Generic handler for stopping job profiles
async fn handle_stop_job_profile(
    app: AppHandle,
    remote_name: String,
    profile_name: String,
    job_type: &str,
    action_name: &str,
) {
    let backend_manager = app.state::<BackendManager>();

    let job_cache = backend_manager.job_cache.clone();

    // Filter logic same as before, but on backend-specific cache
    if let Some(job) = job_cache.get_jobs().await.iter().find(|j| {
        j.remote_name == remote_name
            && j.job_type == job_type
            && j.profile.as_ref() == Some(&profile_name)
            && j.status == JobStatus::Running
    }) {
        let scheduled_cache = app.state::<ScheduledTasksCache>();
        match stop_job(app.clone(), scheduled_cache, job.jobid, remote_name.clone()).await {
            Ok(_) => {
                info!(
                    "🛑 Stopped {} job {} for {} profile '{}'",
                    job_type, job.jobid, remote_name, profile_name
                );
            }
            Err(e) => {
                error!("🚨 Failed to stop {} job {}: {}", job_type, job.jobid, e);
            }
        }
    } else {
        error!(
            "🚨 No active {} job found for {} profile '{}'",
            job_type, remote_name, profile_name
        );
        send_notification(
            &app,
            "notification.title.operationFailed",
            &serde_json::json!({
                "key": "notification.body.noActiveJob",
                "params": {
                    "operation": action_name,
                    "remote": remote_name,
                    "profile": profile_name
                }
            })
            .to_string(),
        );
    }
}

pub fn handle_stop_sync_profile(app: AppHandle, remote_name: &str, profile_name: &str) {
    tauri::async_runtime::spawn(handle_stop_job_profile(
        app,
        remote_name.to_string(),
        profile_name.to_string(),
        "sync",
        "Sync",
    ));
}

pub fn handle_stop_copy_profile(app: AppHandle, remote_name: &str, profile_name: &str) {
    tauri::async_runtime::spawn(handle_stop_job_profile(
        app,
        remote_name.to_string(),
        profile_name.to_string(),
        "copy",
        "Copy",
    ));
}

pub fn handle_stop_move_profile(app: AppHandle, remote_name: &str, profile_name: &str) {
    tauri::async_runtime::spawn(handle_stop_job_profile(
        app,
        remote_name.to_string(),
        profile_name.to_string(),
        "move",
        "Move",
    ));
}

pub fn handle_stop_bisync_profile(app: AppHandle, remote_name: &str, profile_name: &str) {
    tauri::async_runtime::spawn(handle_stop_job_profile(
        app,
        remote_name.to_string(),
        profile_name.to_string(),
        "bisync",
        "BiSync",
    ));
}

pub fn handle_serve_profile(app: AppHandle, remote_name: &str, profile_name: &str) {
    let app_clone = app.clone();
    let remote = remote_name.to_string();
    let profile = profile_name.to_string();

    tauri::async_runtime::spawn(async move {
        let params = ProfileParams {
            remote_name: remote.clone(),
            profile_name: profile.clone(),
        };

        match start_serve_profile(app_clone.clone(), params).await {
            Ok(response) => {
                info!(
                    "✅ Started serve for {} profile '{}' at {}",
                    remote, profile, response.addr
                );
            }
            Err(e) => {
                error!(
                    "🚨 Failed to start serve for {} profile '{}': {}",
                    remote, profile, e
                );
            }
        }
    });
}

pub fn handle_stop_serve_profile(app: AppHandle, _remote_name: &str, serve_id: &str) {
    let app_clone = app.clone();
    let serve_id_clone = serve_id.to_string();

    tauri::async_runtime::spawn(async move {
        let backend_manager = app_clone.state::<BackendManager>();

        let cache = backend_manager.remote_cache.clone();

        let all_serves = cache.get_serves().await;
        let remote_name = all_serves
            .iter()
            .find(|s| s.id == serve_id_clone)
            .and_then(|s| s.params["fs"].as_str())
            .map(|fs| fs.split(':').next().unwrap_or("").to_string())
            .unwrap_or_else(|| "unknown_remote".to_string());

        match stop_serve(
            app_clone.clone(),
            serve_id_clone.clone(),
            remote_name.clone(),
        )
        .await
        {
            Ok(_) => {
                info!("🛑 Stopped serve {serve_id_clone} for {remote_name}");
            }
            Err(e) => {
                error!("🚨 Failed to stop serve {serve_id_clone}: {e}");
            }
        }
    });
}

// ========== GLOBAL ACTIONS ==========

pub fn handle_stop_all_jobs(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Stop all jobs across ALL backends
        // Stop all jobs across ALL backends -> Now just active job cache
        // Simplify to just job_cache
        let backend_manager = app.state::<BackendManager>();
        let job_cache = &backend_manager.job_cache;
        let active_jobs = job_cache.get_active_jobs().await;
        if !active_jobs.is_empty() {
            for job in active_jobs {
                let scheduled_cache = app.state::<ScheduledTasksCache>();
                match stop_job(
                    app.clone(),
                    scheduled_cache,
                    job.jobid,
                    job.remote_name.clone(),
                )
                .await
                {
                    Ok(_) => {
                        info!("🛑 Stopped job {}", job.jobid);
                    }
                    Err(e) => {
                        error!("🚨 Failed to stop job {}: {}", job.jobid, e);
                    }
                }
            }
        }
    });
}

pub fn handle_browse_remote(app: &AppHandle, remote_name: &str) {
    let remote = remote_name.to_string();
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let backend_manager = app_clone.state::<BackendManager>();

        let cache = backend_manager.remote_cache.clone();

        let manager = app_clone.state::<AppSettingsManager>();
        let remote_names = cache.get_remotes().await;
        let settings_val = crate::core::settings::remote::manager::get_all_remote_settings_sync(
            manager.inner(),
            &remote_names,
        );
        let settings = settings_val.get(&remote).cloned().unwrap_or_else(|| {
            error!("🚨 Remote {remote} not found in cached settings");
            serde_json::Value::Null
        });

        // Try to get first mount point from mountConfigs (object-based)
        let mount_point = settings
            .get("mountConfigs")
            .and_then(|v| v.as_object())
            .and_then(|configs| configs.values().next())
            .and_then(|config| config.get("dest"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        match app_clone.opener().open_path(mount_point, None::<&str>) {
            Ok(_) => {
                info!("📂 Opened file manager for {remote}");
            }
            Err(e) => {
                error!("🚨 Failed to open file manager for {remote}: {e}");
            }
        }
    });
}

#[cfg(not(feature = "web-server"))]
pub fn handle_browse_in_app(app: &AppHandle, remote_name: &str) {
    info!("📂 Opening in-app browser for {}", remote_name);
    if let Some(window) = app.get_webview_window("main") {
        window.show().unwrap_or_else(|e| {
            error!("🚨 Failed to show main window: {e}");
        });
        if let Err(e) = tauri::Emitter::emit(
            app,
            crate::utils::types::events::OPEN_INTERNAL_ROUTE,
            remote_name,
        ) {
            error!("🚨 Failed to emit browse event: {e}");
        }
    } else {
        crate::utils::app::builder::create_app_window(app.clone(), Some(remote_name));
    }
}

pub fn handle_stop_all_serves(app: AppHandle) {
    info!("🛑 Stopping all active serves from tray action");
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        match stop_all_serves(app_clone.clone(), "menu".to_string()).await {
            Ok(_) => {
                info!("✅ All serves stopped successfully");
            }
            Err(e) => {
                error!("🚨 Failed to stop all serves: {e}");
            }
        }
    });
}
