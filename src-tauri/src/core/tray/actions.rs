use log::{debug, error, info, warn};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use crate::{
    core::settings::remote::manager::save_remote_settings,
    rclone::{
        commands::{
            job::stop_job,
            mount::{MountParams, mount_remote, unmount_remote},
            serve::{ServeParams, start_serve, stop_all_serves, stop_serve},
            sync::{
                BisyncParams, CopyParams, MoveParams, SyncParams, start_bisync, start_copy,
                start_move, start_sync,
            },
        },
        state::scheduled_tasks::ScheduledTasksCache,
    },
    utils::{
        app::{builder::create_app_window, notification::send_notification},
        io::file_helper::get_folder_location,
        types::all_types::{JobCache, JobStatus, RcloneState, RemoteCache},
    },
};

use crate::core::scheduler::engine::CronScheduler;

fn notify(app: &AppHandle, title: &str, body: &str) {
    send_notification(app, title, body);
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

pub fn handle_mount_remote(app: AppHandle, remote_name: &str) {
    let app_clone = app.clone();
    let remote_name_clone = remote_name.to_string();
    tauri::async_runtime::spawn(async move {
        let cache = app_clone.state::<RemoteCache>();
        let settings_val = cache.get_settings().await;
        let settings = match settings_val.get(&remote_name_clone).cloned() {
            Some(s) => s,
            _ => {
                error!("🚨 Remote {remote_name_clone} not found in settings");
                return;
            }
        };

        let mut params = match MountParams::from_settings(remote_name_clone.clone(), &settings) {
            Some(p) => p,
            None => {
                error!("🚨 Mount configuration incomplete for {remote_name_clone}");
                notify(
                    &app_clone,
                    "Mount Failed",
                    &format!("Mount configuration incomplete for {remote_name_clone}"),
                );
                return;
            }
        };

        let mount_point = if !params.mount_point.is_empty() {
            params.mount_point.clone()
        } else {
            match prompt_mount_point(&app_clone, &remote_name_clone).await {
                Some(path) => path,
                _ => {
                    info!("❌ Mounting cancelled - no mount point selected");
                    return;
                }
            }
        };
        params.mount_point = mount_point.clone();

        let job_cache_state = app_clone.state::<JobCache>();

        match mount_remote(
            app_clone.clone(),
            job_cache_state,
            cache.clone(),
            params.clone(),
        )
        .await
        {
            Ok(_) => {
                info!("✅ Successfully mounted {remote_name_clone}");
                notify(
                    &app_clone,
                    "Mount Successful",
                    &format!(
                        "Successfully mounted {remote_name_clone}:{} at {}",
                        params.source, mount_point
                    ),
                );
                if settings
                    .get("mountConfig")
                    .and_then(|v| v.get("dest"))
                    .and_then(|v| v.as_str())
                    .is_none_or(|s| s.is_empty())
                {
                    let mut new_settings = settings.clone();
                    new_settings["mountConfig"]["dest"] = serde_json::Value::String(mount_point);
                    if let Err(e) = save_remote_settings(
                        remote_name_clone,
                        new_settings,
                        app_clone.state(),
                        app_clone.state::<ScheduledTasksCache>(),
                        app_clone.state::<CronScheduler>(),
                        app_clone.clone(),
                    )
                    .await
                    {
                        error!("🚨 Failed to save mount point: {e}");
                    }
                }
            }
            Err(e) => {
                error!("🚨 Failed to mount {remote_name_clone}: {e}");
                notify(
                    &app_clone,
                    "Mount Failed",
                    &format!("Failed to mount {remote_name_clone}: {e}"),
                );
            }
        }
    });
}

pub fn handle_unmount_remote(app: AppHandle, remote_name: &str) {
    let app_clone = app.clone();
    let remote = remote_name.to_string();
    tauri::async_runtime::spawn(async move {
        let cache = app_clone.state::<RemoteCache>();
        let remote_name = remote.to_string();
        let settings_val = cache.get_settings().await;
        // <-- Use cache
        let settings = settings_val.get(&remote).cloned().unwrap_or_else(|| {
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

pub fn handle_sync_remote(app: AppHandle, remote_name: &str) {
    let app_clone = app.clone();
    let remote_name_clone = remote_name.to_string();
    tauri::async_runtime::spawn(async move {
        let cache = app_clone.state::<RemoteCache>();
        let settings_val = cache.get_settings().await;
        let settings = match settings_val.get(&remote_name_clone).cloned() {
            Some(s) => s,
            _ => {
                error!("🚨 Remote {remote_name_clone} not found in settings");
                return;
            }
        };

        let params = match SyncParams::from_settings(remote_name_clone.clone(), &settings) {
            Some(p) => p,
            None => {
                error!("🚨 Sync configuration incomplete for {remote_name_clone}");
                notify(
                    &app_clone,
                    "Sync Failed",
                    &format!("Sync configuration incomplete for {remote_name_clone}"),
                );
                return;
            }
        };

        // Get managed state
        let job_cache = app_clone.state::<JobCache>();
        let rclone_state = app_clone.state::<RcloneState>();

        match start_sync(app_clone.clone(), job_cache, rclone_state, params).await {
            Ok(_) => {
                info!("✅ Started Sync for {remote_name_clone}");
                notify(
                    &app_clone,
                    "Sync Started",
                    &format!("Started Sync for {remote_name_clone}"),
                );
            }
            Err(e) => {
                error!("🚨 Failed to start Sync for {remote_name_clone}: {e}");
                notify(
                    &app_clone,
                    "Sync Failed",
                    &format!("Failed to start Sync for {remote_name_clone}: {e}"),
                );
            }
        }
    });
}

pub fn handle_copy_remote(app: AppHandle, remote_name: &str) {
    let app_clone = app.clone();
    let remote_name_clone = remote_name.to_string();
    tauri::async_runtime::spawn(async move {
        let cache = app_clone.state::<RemoteCache>();
        let settings_val = cache.get_settings().await;
        let settings = match settings_val.get(&remote_name_clone).cloned() {
            Some(s) => s,
            _ => {
                error!("🚨 Remote {remote_name_clone} not found in settings");
                return;
            }
        };

        let params = match CopyParams::from_settings(remote_name_clone.clone(), &settings) {
            Some(p) => p,
            None => {
                error!("🚨 Copy configuration incomplete for {remote_name_clone}");
                notify(
                    &app_clone,
                    "Copy Failed",
                    &format!("Copy configuration incomplete for {remote_name_clone}"),
                );
                return;
            }
        };

        let job_cache = app_clone.state::<JobCache>();
        let rclone_state = app_clone.state::<RcloneState>();

        match start_copy(app_clone.clone(), job_cache, rclone_state, params).await {
            Ok(_) => {
                info!("✅ Started Copy for {remote_name_clone}");
                notify(
                    &app_clone,
                    "Copy Started",
                    &format!("Started Copy for {remote_name_clone}"),
                );
            }
            Err(e) => {
                error!("🚨 Failed to start Copy for {remote_name_clone}: {e}");
                notify(
                    &app_clone,
                    "Copy Failed",
                    &format!("Failed to start Copy for {remote_name_clone}: {e}"),
                );
            }
        }
    });
}

pub fn handle_move_remote(app: AppHandle, remote_name: &str) {
    let app_clone = app.clone();
    let remote_name_clone = remote_name.to_string();
    tauri::async_runtime::spawn(async move {
        let cache = app_clone.state::<RemoteCache>();
        let settings_val = cache.get_settings().await;
        let settings = match settings_val.get(&remote_name_clone).cloned() {
            Some(s) => s,
            _ => {
                error!("🚨 Remote {remote_name_clone} not found in settings");
                return;
            }
        };

        let params = match MoveParams::from_settings(remote_name_clone.clone(), &settings) {
            Some(p) => p,
            None => {
                error!("🚨 Move configuration incomplete for {remote_name_clone}");
                notify(
                    &app_clone,
                    "Move Failed",
                    &format!("Move configuration incomplete for {remote_name_clone}"),
                );
                return;
            }
        };

        let job_cache = app_clone.state::<JobCache>();
        let rclone_state = app_clone.state::<RcloneState>();

        match start_move(app_clone.clone(), job_cache, rclone_state, params).await {
            Ok(_) => {
                info!("✅ Started Move for {remote_name_clone}");
                notify(
                    &app_clone,
                    "Move Started",
                    &format!("Started Move for {remote_name_clone}"),
                );
            }
            Err(e) => {
                error!("🚨 Failed to start Move for {remote_name_clone}: {e}");
                notify(
                    &app_clone,
                    "Move Failed",
                    &format!("Failed to start Move for {remote_name_clone}: {e}"),
                );
            }
        }
    });
}

pub fn handle_bisync_remote(app: AppHandle, remote_name: &str) {
    let app_clone = app.clone();
    let remote_name_clone = remote_name.to_string();
    tauri::async_runtime::spawn(async move {
        let cache = app_clone.state::<RemoteCache>();
        let settings_val = cache.get_settings().await;
        let settings = match settings_val.get(&remote_name_clone).cloned() {
            Some(s) => s,
            _ => {
                error!("🚨 Remote {remote_name_clone} not found in settings");
                return;
            }
        };

        let params = match BisyncParams::from_settings(remote_name_clone.clone(), &settings) {
            Some(p) => p,
            None => {
                error!("🚨 BiSync configuration incomplete for {remote_name_clone}");
                notify(
                    &app_clone,
                    "BiSync Failed",
                    &format!("BiSync configuration incomplete for {remote_name_clone}"),
                );
                return;
            }
        };

        let job_cache = app_clone.state::<JobCache>();
        let rclone_state = app_clone.state::<RcloneState>();

        match start_bisync(app_clone.clone(), job_cache, rclone_state, params).await {
            Ok(_) => {
                info!("✅ Started BiSync for {remote_name_clone}");
                notify(
                    &app_clone,
                    "BiSync Started",
                    &format!("Started BiSync for {remote_name_clone}"),
                );
            }
            Err(e) => {
                error!("🚨 Failed to start BiSync for {remote_name_clone}: {e}");
                notify(
                    &app_clone,
                    "BiSync Failed",
                    &format!("Failed to start BiSync for {remote_name_clone}: {e}"),
                );
            }
        }
    });
}

async fn handle_stop_job(
    app: AppHandle,
    id: String,
    prefix: &str,
    job_type: &str,
    action_name: &str,
) {
    let job_cache_state = app.state::<JobCache>();
    let remote_name = id.replace(prefix, "");

    if let Some(job) = job_cache_state.get_jobs().await.iter().find(|j| {
        j.remote_name == remote_name && j.job_type == job_type && j.status == JobStatus::Running
    }) {
        let scheduled_cache = app.state::<ScheduledTasksCache>();
        match stop_job(
            app.clone(),
            job_cache_state,
            scheduled_cache,
            job.jobid,
            remote_name.clone(),
            app.state(),
        )
        .await
        {
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

pub fn handle_stop_sync(app: AppHandle, remote_name: &str) {
    tauri::async_runtime::spawn(handle_stop_job(
        app,
        remote_name.to_string(),
        "stop_sync-",
        "sync",
        "Sync",
    ));
}
pub fn handle_stop_copy(app: AppHandle, remote_name: &str) {
    tauri::async_runtime::spawn(handle_stop_job(
        app,
        remote_name.to_string(),
        "stop_copy-",
        "copy",
        "Copy",
    ));
}
pub fn handle_stop_move(app: AppHandle, remote_name: &str) {
    tauri::async_runtime::spawn(handle_stop_job(
        app,
        remote_name.to_string(),
        "stop_move-",
        "move",
        "Move",
    ));
}
pub fn handle_stop_bisync(app: AppHandle, remote_name: &str) {
    tauri::async_runtime::spawn(handle_stop_job(
        app,
        remote_name.to_string(),
        "stop_bisync-",
        "bisync",
        "BiSync",
    ));
}
pub fn handle_stop_all_jobs(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let job_cache_state = app.state::<JobCache>();
        let active_jobs = job_cache_state.get_active_jobs().await;
        if active_jobs.is_empty() {
            return;
        }
        for job in active_jobs.clone() {
            let scheduled_cache = app.state::<ScheduledTasksCache>();
            match stop_job(
                app.clone(),
                job_cache_state.clone(),
                scheduled_cache,
                job.jobid,
                job.remote_name.clone(),
                app.state(),
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
        notify(
            &app,
            "All Jobs Stopped",
            &format!("Stopped {} active jobs", active_jobs.len()),
        );
    });
}
pub fn handle_browse_remote(app: &AppHandle, remote_name: &str) {
    let remote = remote_name.to_string();
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let cache = app_clone.state::<RemoteCache>();
        let settings_val = cache.get_settings().await;
        let settings = settings_val.get(&remote).cloned().unwrap_or_else(|| {
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

pub fn handle_start_serve(app: AppHandle, remote_name: &str) {
    let app_clone = app.clone();
    let remote_name_clone = remote_name.to_string();

    tauri::async_runtime::spawn(async move {
        let job_cache_state = app_clone.state::<JobCache>();
        let cache = app_clone.state::<RemoteCache>();
        let settings_val = cache.get_settings().await;
        let settings = match settings_val.get(&remote_name_clone).cloned() {
            Some(s) => s,
            _ => {
                error!("🚨 Remote {remote_name_clone} not found in settings");
                return;
            }
        };

        let params = match ServeParams::from_settings(remote_name_clone.clone(), &settings) {
            Some(p) => p,
            None => {
                error!("🚨 Serve configuration incomplete for {remote_name_clone}");
                notify(
                    &app_clone,
                    "Serve Failed",
                    &format!("Serve configuration incomplete for {remote_name_clone}"),
                );
                return;
            }
        };

        match start_serve(app_clone.clone(), job_cache_state.clone(), params).await {
            Ok(response) => {
                info!(
                    "✅ Started serve for {remote_name_clone} at {}",
                    response.addr
                );
                notify(
                    &app_clone,
                    "Serve Started",
                    &format!("Started serve for {remote_name_clone} at {}", response.addr),
                );
            }
            Err(e) => {
                error!("🚨 Failed to start serve for {remote_name_clone}: {e}");
                notify(
                    &app_clone,
                    "Serve Failed",
                    &format!("Failed to start serve for {remote_name_clone}: {e}"),
                );
            }
        }
    });
}

pub fn handle_stop_serve(app: AppHandle, serve_id: &str) {
    let app_clone = app.clone();
    let serve_id_clone = serve_id.to_string();

    tauri::async_runtime::spawn(async move {
        let cache = app_clone.state::<RemoteCache>();
        let all_serves = cache.get_serves().await; // <-- Use cache
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
            app_clone.state(),
        )
        .await
        {
            Ok(_) => {
                info!("🛑 Stopped serve {serve_id_clone} for {remote_name}");
                notify(
                    &app_clone,
                    "Serve Stopped",
                    &format!("Stopped serve for {remote_name}"),
                );
            }
            Err(e) => {
                error!("🚨 Failed to stop serve {serve_id_clone}: {e}");
                notify(
                    &app_clone,
                    "Stop Serve Failed",
                    &format!("Failed to stop serve for {remote_name}: {e}"),
                );
            }
        }
    });
}

pub fn handle_stop_all_serves(app: AppHandle) {
    info!("🛑 Stopping all active serves from tray action");
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        match stop_all_serves(app_clone.clone(), app_clone.state(), "menu".to_string()).await {
            Ok(_) => {
                info!("✅ All serves stopped successfully");
                notify(&app_clone, "All Serves Stopped", "All serves stopped");
            }
            Err(e) => {
                error!("🚨 Failed to stop all serves: {e}");
                notify(
                    &app_clone,
                    "Stop All Serves Failed",
                    &format!("Failed to stop serves: {e}"),
                );
            }
        }
    });
}
