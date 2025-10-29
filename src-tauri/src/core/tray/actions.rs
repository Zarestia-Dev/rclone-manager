use log::{debug, error, info, warn};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use crate::{
    core::{
        config_extractor::{
            BisyncConfig, CopyConfig, IsValid, MountConfig, MoveConfig, SyncConfig,
        },
        settings::remote::manager::save_remote_settings,
        spawn_helpers::{spawn_bisync, spawn_copy, spawn_mount, spawn_move, spawn_sync},
    },
    rclone::{
        commands::{stop_job, unmount_remote},
        state::{CACHE, JOB_CACHE},
    },
    utils::{
        app::{builder::create_app_window, notification::send_notification},
        io::file_helper::get_folder_location,
        types::all_types::JobStatus,
    },
};

fn notify(app: &AppHandle, title: &str, body: &str) {
    send_notification(app, title, body);
}

type PostSuccess = fn(AppHandle) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>;

async fn handle_job_action<T, C, E, F, Fut>(
    app: AppHandle,
    id: String,
    id_prefix: &str,
    action_name: &str,
    config_from_settings: E,
    spawn_job: F,
    post_success: Option<PostSuccess>,
) where
    E: Fn(&serde_json::Value) -> C + Send + Sync + 'static,
    C: IsValid + Send + Sync + Clone + 'static,
    T: Send + 'static,
    F: Fn(String, C, AppHandle) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<T, String>> + Send,
{
    let remote_name = id.replace(id_prefix, "");
    let settings = match CACHE.settings.read().await.get(&remote_name).cloned() {
        Some(s) => s,
        _ => {
            error!("🚨 Remote {remote_name} not found in settings");
            return;
        }
    };

    let config = config_from_settings(&settings);
    if !config.is_valid() {
        error!("🚨 {action_name} configuration incomplete for {remote_name}");
        notify(
            &app,
            &format!("{action_name} Failed"),
            &format!("{action_name} configuration incomplete for {remote_name}"),
        );
        return;
    }

    match spawn_job(remote_name.clone(), config, app.clone()).await {
        Ok(_) => {
            info!("✅ Started {action_name} for {remote_name}");
            notify(
                &app,
                &format!("{action_name} Started"),
                &format!("Started {action_name} for {remote_name}"),
            );
            if let Some(post) = post_success {
                post(app.clone()).await;
            }
        }
        Err(e) => {
            error!("🚨 Failed to start {action_name} for {remote_name}: {e}");
            notify(
                &app,
                &format!("{action_name} Failed"),
                &format!("Failed to start {action_name} for {remote_name}: {e}"),
            );
        }
    }
}

async fn handle_stop_job(
    app: AppHandle,
    id: String,
    prefix: &str,
    job_type: &str,
    action_name: &str,
) {
    let remote_name = id.replace(prefix, "");
    if let Some(job) = JOB_CACHE.get_jobs().await.iter().find(|j| {
        j.remote_name == remote_name && j.job_type == job_type && j.status == JobStatus::Running
    }) {
        match stop_job(app.clone(), job.jobid, remote_name.clone(), app.state()).await {
            Ok(_) => {
                info!(
                    "🛑 Stopped {} job {} for {}",
                    job_type, job.jobid, remote_name
                );
                notify(
                    &app,
                    &format!("{} Stopped", action_name),
                    &format!("Stopped {} job for {}", job_type, remote_name),
                );
            }
            Err(e) => {
                error!("🚨 Failed to stop {} job {}: {}", job_type, job.jobid, e);
                notify(
                    &app,
                    &format!("Stop {} Failed", action_name),
                    &format!("Failed to stop {} job for {}: {}", job_type, remote_name, e),
                );
            }
        }
    } else {
        error!("🚨 No active {} job found for {}", job_type, remote_name);
        notify(
            &app,
            &format!("Stop {} Failed", action_name),
            &format!("No active {} job found for {}", job_type, remote_name),
        );
    }
}

async fn prompt_mount_point(app: &AppHandle, remote_name: &str) -> Option<String> {
    let response = app
        .dialog()
        .message(format!(
            "No mount point specified for '{remote_name}'. Would you like to select one now?"
        ))
        .title("Mount Point Required")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Yes, Select".to_owned(),
            "Cancel".to_owned(),
        ))
        .kind(MessageDialogKind::Warning)
        .blocking_show();

    if !response {
        info!("❌ User cancelled mount point selection for {remote_name}");
        return None;
    }

    match get_folder_location(app.clone(), false).await {
        Ok(Some(path)) if !path.is_empty() => {
            info!("📁 Selected mount point for {remote_name}: {path}");
            Some(path)
        }
        Ok(Some(_)) => {
            info!("⚠️ User selected an empty folder path for {remote_name}");
            None
        }
        Ok(none) => {
            info!("❌ User didn't select a folder for {remote_name}");
            none
        }
        Err(err) => {
            error!("🚨 Error selecting folder for {remote_name}: {err}");
            None
        }
    }
}

fn get_mount_point(settings: &serde_json::Value) -> String {
    settings
        .get("mountConfig")
        .and_then(|v| v.get("dest"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

pub fn show_main_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        debug!("🪟 Showing main window");
        window.show().unwrap_or_else(|_| {
            error!("🚨 Failed to show main window");
        });
    } else {
        warn!("⚠️ Main window not found. Building...");
        create_app_window(app);
    }
}

pub fn handle_mount_remote(app: AppHandle, id: &str) {
    let remote_name = id.replace("mount-", "");
    tauri::async_runtime::spawn(async move {
        let settings = match CACHE.settings.read().await.get(&remote_name).cloned() {
            Some(s) => s,
            _ => {
                error!("🚨 Remote {remote_name} not found in settings");
                return;
            }
        };

        let cfg = MountConfig::from_settings(&settings);

        let mount_point = if !cfg.dest.is_empty() {
            cfg.dest.clone()
        } else {
            match prompt_mount_point(&app, &remote_name).await {
                Some(path) => path,
                _ => {
                    info!("❌ Mounting cancelled - no mount point selected");
                    return;
                }
            }
        };

        match spawn_mount(
            remote_name.clone(),
            cfg.clone(),
            Some(mount_point.clone()),
            app.clone(),
        )
        .await
        {
            Ok(_) => {
                info!("✅ Successfully mounted {remote_name}");
                notify(
                    &app,
                    "Mount Successful",
                    &format!(
                        "Successfully mounted {remote_name}:{} at {}",
                        cfg.source, mount_point
                    ),
                );
                // Save the mount point if it was newly selected
                if settings
                    .get("mountConfig")
                    .and_then(|v| v.get("dest"))
                    .and_then(|v| v.as_str())
                    .is_none()
                {
                    let mut new_settings = settings.clone();
                    new_settings["mountConfig"]["dest"] = serde_json::Value::String(mount_point);
                    if let Err(e) =
                        save_remote_settings(remote_name, new_settings, app.state(), app.clone())
                            .await
                    {
                        error!("🚨 Failed to save mount point: {e}");
                    }
                }
            }
            Err(e) => {
                error!("🚨 Failed to mount {remote_name}: {e}");
                notify(
                    &app,
                    "Mount Failed",
                    &format!("Failed to mount {remote_name}: {e}"),
                );
            }
        }
    });
}

pub fn handle_unmount_remote(app: AppHandle, id: &str) {
    let remote = id.replace("unmount-", "");
    let app_clone = app.clone();

    tauri::async_runtime::spawn(async move {
        let remote_name = remote.to_string();
        let settings_result = CACHE.settings.read().await;
        let settings = settings_result.get(&remote).cloned().unwrap_or_else(|| {
            error!("🚨 Remote {remote} not found in cached settings");
            serde_json::Value::Null
        });

        let mount_point = get_mount_point(&settings);
        let state = app_clone.state();
        match unmount_remote(app_clone.clone(), mount_point, remote_name, state).await {
            Ok(_) => {
                info!("🛑 Unmounted {remote}");
                notify(
                    &app_clone,
                    "Unmount Successful",
                    &format!("Successfully unmounted {remote}"),
                );
            }
            Err(err) => {
                error!("🚨 Failed to unmount {remote}: {err}");
                notify(
                    &app_clone,
                    "Unmount Failed",
                    &format!("Failed to unmount {remote}: {err}"),
                );
            }
        }
    });
}

pub fn handle_sync_remote(app: AppHandle, id: &str) {
    tauri::async_runtime::spawn(handle_job_action(
        app,
        id.to_string(),
        "sync-",
        "Sync",
        SyncConfig::from_settings,
        spawn_sync,
        None,
    ));
}

pub fn handle_copy_remote(app: AppHandle, id: &str) {
    tauri::async_runtime::spawn(handle_job_action(
        app,
        id.to_string(),
        "copy-",
        "Copy",
        CopyConfig::from_settings,
        spawn_copy,
        None,
    ));
}

pub fn handle_move_remote(app: AppHandle, id: &str) {
    tauri::async_runtime::spawn(handle_job_action(
        app,
        id.to_string(),
        "move-",
        "Move",
        MoveConfig::from_settings,
        spawn_move,
        Some(|app| Box::pin(CACHE.refresh_all(app))),
    ));
}

pub fn handle_bisync_remote(app: AppHandle, id: &str) {
    tauri::async_runtime::spawn(handle_job_action(
        app,
        id.to_string(),
        "bisync-",
        "BiSync",
        BisyncConfig::from_settings,
        spawn_bisync, // Assumes spawn_bisync is updated to return a Job ID
        Some(|app| Box::pin(CACHE.refresh_all(app))),
    ));
}

pub fn handle_stop_sync(app: AppHandle, id: &str) {
    tauri::async_runtime::spawn(handle_stop_job(
        app,
        id.to_string(),
        "stop_sync-",
        "sync",
        "Sync",
    ));
}

pub fn handle_stop_copy(app: AppHandle, id: &str) {
    tauri::async_runtime::spawn(handle_stop_job(
        app,
        id.to_string(),
        "stop_copy-",
        "copy",
        "Copy",
    ));
}

pub fn handle_stop_move(app: AppHandle, id: &str) {
    tauri::async_runtime::spawn(handle_stop_job(
        app,
        id.to_string(),
        "stop_move-",
        "move",
        "Move",
    ));
}

pub fn handle_stop_bisync(app: AppHandle, id: &str) {
    tauri::async_runtime::spawn(handle_stop_job(
        app,
        id.to_string(),
        "stop_bisync-",
        "bisync",
        "BiSync",
    ));
}

pub fn handle_stop_all_jobs(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let active_jobs = JOB_CACHE.get_jobs().await;
        if active_jobs.is_empty() {
            return;
        }
        for job in active_jobs.clone() {
            match stop_job(app.clone(), job.jobid, job.remote_name.clone(), app.state()).await {
                Ok(_) => {
                    info!("🛑 Stopped job {}", job.jobid);
                }
                Err(e) => {
                    error!("🚨 Failed to stop job {}: {}", job.jobid, e);
                }
            }
        }
        notify(
            &app,
            "All Jobs Stopped",
            &format!("Stopped {} active jobs", active_jobs.len()),
        );
    });
}

pub fn handle_browse_remote(app: &AppHandle, id: &str) {
    let remote = id.replace("browse-", "");
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let settings_result = CACHE.settings.read().await;
        let settings = settings_result.get(&remote).cloned().unwrap_or_else(|| {
            error!("🚨 Remote {remote} not found in cached settings");
            serde_json::Value::Null
        });
        let mount_point = get_mount_point(&settings);

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
