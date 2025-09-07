use std::collections::HashMap;

use log::{debug, error, info, warn};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use crate::{
    core::settings::remote::manager::save_remote_settings,
    rclone::{
        commands::{
            mount_remote, start_bisync, start_copy, start_move, start_sync, stop_job,
            unmount_remote,
        },
        state::{CACHE, JOB_CACHE},
    },
    utils::{
        app::builder::create_app_window, app::notification::send_notification,
        io::file_helper::get_folder_location, types::all_types::JobStatus,
    },
};

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
        info!("❌ User cancelled mount point selection for {remote_name}",);
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
        // Load settings with proper error handling
        let settings = match CACHE.settings.read().await.get(&remote_name).cloned() {
            Some(s) => s,
            _ => {
                error!("🚨 Remote {remote_name} not found in settings");
                return;
            }
        };

        // Extract mount options (from "mountConfig.options")
        let mount_options = settings
            .get("mountConfig")
            .and_then(|v| v.get("options"))
            .and_then(|v| v.as_object())
            .map(|obj| {
                obj.iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect::<HashMap<_, _>>()
            });

        // Extract VFS options (from "vfsConfig")
        let vfs_options = settings
            .get("vfsConfig")
            .and_then(|v| v.as_object())
            .map(|obj| {
                obj.iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect::<HashMap<_, _>>()
            });

        // Get or prompt for mount point
        let mount_point = match settings
            .get("mountConfig")
            .and_then(|v| v.get("dest"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            Some(existing) => existing.to_string(),
            _ => match prompt_mount_point(&app, &remote_name).await {
                Some(path) => path,
                _ => {
                    info!("❌ Mounting cancelled - no mount point selected");
                    return;
                }
            },
        };

        // Compose the remote path using remote_name and mountConfig.source
        let source = settings
            .get("mountConfig")
            .and_then(|v| v.get("source"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let mount_type = settings
            .get("mountConfig")
            .and_then(|v| v.get("type"))
            .and_then(|v| v.as_str())
            .unwrap_or("mount")
            .to_string();

        // Mount the remote
        let params = crate::rclone::commands::mount::MountParams {
            remote_name: remote_name.clone(),
            source: source.to_owned(),
            mount_point: mount_point.clone(),
            mount_type: mount_type.clone(),
            mount_options,
            vfs_options,
        };
        match mount_remote(app.clone(), params, app.state()).await {
            Ok(_) => {
                info!("✅ Successfully mounted {remote_name}");
                notify(
                    &app,
                    "Mount Successful",
                    &format!("Successfully mounted {remote_name}:{source} at {mount_point}"),
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
                error!("🚨 Failed to mount {remote_name}:{source}: {e}");
                notify(
                    &app,
                    "Mount Failed",
                    &format!("Failed to mount {remote_name}:{source}: {e}"),
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
    let remote_name = id.replace("sync-", "");
    tauri::async_runtime::spawn(async move {
        let settings = match CACHE.settings.read().await.get(&remote_name).cloned() {
            Some(s) => s,
            _ => {
                error!("🚨 Remote {remote_name} not found in settings");
                return;
            }
        };

        let sync_config = settings
            .get("syncConfig")
            .and_then(|v| v.as_object())
            .map(|obj| obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect());

        let filter_config = settings
            .get("filterConfig")
            .and_then(|v| v.as_object())
            .map(|obj| obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect());

        let source = settings
            .get("syncConfig")
            .and_then(|v| v.get("source"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let dest = settings
            .get("syncConfig")
            .and_then(|v| v.get("dest"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let create_empty_src_dirs = settings
            .get("syncConfig")
            .and_then(|v| v.get("createEmptySrcDirs"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if dest.is_empty() {
            error!("🚨 Sync configuration incomplete for {remote_name}");
            notify(
                &app,
                "Sync Failed",
                &format!("Sync configuration incomplete for {remote_name}"),
            );
            return;
        }

        let params = crate::rclone::commands::sync::SyncParams {
            remote_name: remote_name.clone(),
            source,
            dest,
            create_empty_src_dirs,
            sync_options: sync_config,
            filter_options: filter_config,
        };
        match start_sync(app.clone(), params, app.state()).await {
            Ok(jobid) => {
                info!("✅ Started sync for {remote_name} (Job ID: {jobid})");
                notify(
                    &app,
                    "Sync Started",
                    &format!("Started sync for {remote_name} (Job ID: {jobid})"),
                );
            }
            Err(e) => {
                error!("🚨 Failed to start sync for {remote_name}: {e}");
                notify(
                    &app,
                    "Sync Failed",
                    &format!("Failed to start sync for {remote_name}: {e}"),
                );
            }
        }
    });
}
pub fn handle_copy_remote(app: AppHandle, id: &str) {
    let remote_name = id.replace("copy-", "");
    tauri::async_runtime::spawn(async move {
        let settings = match CACHE.settings.read().await.get(&remote_name).cloned() {
            Some(s) => s,
            _ => {
                error!("🚨 Remote {remote_name} not found in settings");
                return;
            }
        };

        let copy_config = settings
            .get("copyConfig")
            .and_then(|v| v.as_object())
            .map(|obj| obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect());

        let filter_config = settings
            .get("filterConfig")
            .and_then(|v| v.as_object())
            .map(|obj| obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect());

        let source = settings
            .get("copyConfig")
            .and_then(|v| v.get("source"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let dest = settings
            .get("copyConfig")
            .and_then(|v| v.get("dest"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let create_empty_src_dirs = settings
            .get("copyConfig")
            .and_then(|v| v.get("createEmptySrcDirs"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if dest.is_empty() {
            error!("🚨 Copy configuration incomplete for {remote_name}");
            notify(
                &app,
                "Copy Failed",
                &format!("Copy configuration incomplete for {remote_name}"),
            );
            return;
        }

        let params = crate::rclone::commands::sync::CopyParams {
            remote_name: remote_name.clone(),
            source,
            dest,
            create_empty_src_dirs,
            copy_options: copy_config,
            filter_options: filter_config,
        };
        match start_copy(app.clone(), params, app.state()).await {
            Ok(jobid) => {
                info!("✅ Started copy for {remote_name} (Job ID: {jobid})");
                notify(
                    &app,
                    "Copy Started",
                    &format!("Started copy for {remote_name} (Job ID: {jobid})"),
                );
            }
            Err(e) => {
                error!("🚨 Failed to start copy for {remote_name}: {e}");
                notify(
                    &app,
                    "Copy Failed",
                    &format!("Failed to start copy for {remote_name}: {e}"),
                );
            }
        }
    });
}

pub fn handle_stop_sync(app: AppHandle, id: &str) {
    let remote_name = id.replace("stop_sync-", "");
    tauri::async_runtime::spawn(async move {
        if let Some(job) = JOB_CACHE.get_jobs().await.iter().find(|j| {
            j.remote_name == remote_name && j.job_type == "sync" && j.status == JobStatus::Running
        }) {
            match stop_job(app.clone(), job.jobid, remote_name.clone(), app.state()).await {
                Ok(_) => {
                    info!("🛑 Stopped sync job {} for {}", job.jobid, remote_name);
                    notify(
                        &app,
                        "Sync Stopped",
                        &format!("Stopped sync job for {remote_name}"),
                    );
                }
                Err(e) => {
                    error!("🚨 Failed to stop sync job {}: {}", job.jobid, e);
                    notify(
                        &app,
                        "Stop Sync Failed",
                        &format!("Failed to stop sync job for {remote_name}: {e}"),
                    );
                }
            }
        } else {
            error!("🚨 No active sync job found for {remote_name}");
            notify(
                &app,
                "Stop Sync Failed",
                &format!("No active sync job found for {remote_name}"),
            );
        }
    });
}

pub fn handle_stop_copy(app: AppHandle, id: &str) {
    let remote_name = id.replace("stop_copy-", "");
    tauri::async_runtime::spawn(async move {
        if let Some(job) = JOB_CACHE.get_jobs().await.iter().find(|j| {
            j.remote_name == remote_name && j.job_type == "copy" && j.status == JobStatus::Running
        }) {
            match stop_job(app.clone(), job.jobid, remote_name.clone(), app.state()).await {
                Ok(_) => {
                    info!("🛑 Stopped copy job {} for {}", job.jobid, remote_name);
                    notify(
                        &app,
                        "Copy Stopped",
                        &format!("Stopped copy job for {remote_name}"),
                    );
                }
                Err(e) => {
                    error!("🚨 Failed to stop copy job {}: {}", job.jobid, e);
                    notify(
                        &app,
                        "Stop Copy Failed",
                        &format!("Failed to stop copy job for {remote_name}: {e}"),
                    );
                }
            }
        } else {
            error!("🚨 No active copy job found for {remote_name}");
            notify(
                &app,
                "Stop Copy Failed",
                &format!("No active copy job found for {remote_name}"),
            );
        }
    });
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

// pub fn handle_delete_remote(app: AppHandle, id: &str) {
//     let remote = id.replace("delete-", "");
//     let app_clone = app.clone(); // Cloning the app
//     tauri::async_runtime::spawn(async move {
//         use tauri_plugin_dialog::DialogExt;
//         let _answer = app_clone
//             .dialog()
//             .message(format!(
//                 "Are you sure you want to delete the remote {}?",
//                 remote
//             ))
//             .title(format!("Delete Remote {}", remote))
//             .buttons(MessageDialogButtons::OkCancelCustom(
//                 "Yes, Delete".to_owned(),
//                 "Cancel".to_owned(),
//             ))
//             .kind(MessageDialogKind::Warning)
//             .show(move |result| {
//                 let remote = remote.clone();
//                 tauri::async_runtime::spawn(async move {
//                     if result {
//                         let state = app_clone.state();
//                         match delete_remote(app_clone.clone(), remote.clone(), state).await {
//                             Ok(_) => {
//                                 info!("🗑️ Deleted remote {}", remote);
//                                 notify(
//                                     &app_clone,
//                                     "Remote Deleted",
//                                     &format!("Successfully deleted remote {}", remote),
//                                 );
//                             }
//                             Err(err) => {
//                                 error!("🚨 Failed to delete remote {}: {}", remote, err);
//                                 notify(
//                                     &app_clone,
//                                     "Deletion Failed",
//                                     &format!("Failed to delete remote {}: {}", remote, err),
//                                 );
//                             }
//                         }
//                     } else {
//                         info!("❌ Cancelled deletion of remote {}", remote);
//                     }
//                 });
//             });
//     });
// }

pub fn handle_move_remote(app: AppHandle, id: &str) {
    let remote_name = id.replace("move-", "");
    tauri::async_runtime::spawn(async move {
        // Load settings with proper error handling
        let settings = match CACHE.settings.read().await.get(&remote_name).cloned() {
            Some(s) => s,
            _ => {
                error!("🚨 Remote {remote_name} not found in settings");
                return;
            }
        };

        // Extract move options and source/dest paths
        let move_config = settings.get("moveConfig").cloned().unwrap_or_default();
        let source_path = move_config
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let dest_path = move_config
            .get("dest")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        if source_path.is_empty() || dest_path.is_empty() {
            warn!("⚠️ Source or destination path is empty for move operation on {remote_name}");
            notify(
                &app,
                "Move Failed",
                &format!("Source or destination path is not configured for {remote_name}"),
            );
            return;
        }

        // Extract move options
        let move_options = move_config
            .get("options")
            .and_then(|v| v.as_object())
            .map(|obj| {
                obj.iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect::<HashMap<String, serde_json::Value>>()
            });

        let state = app.state();
        let move_params = crate::rclone::commands::MoveParams {
            source: source_path.clone(),
            dest: dest_path.clone(),
            remote_name: remote_name.clone(),
            create_empty_src_dirs: false,
            delete_empty_src_dirs: false,
            move_options,
            filter_options: None,
        };

        info!("🔄 Starting move for {remote_name}: {source_path} -> {dest_path}");
        match start_move(app.clone(), move_params, state).await {
            Ok(_) => {
                info!("✅ Move started for {remote_name}");
                notify(
                    &app,
                    "Move Started",
                    &format!("Move operation started for {remote_name}"),
                );
                CACHE.refresh_all(app).await;
            }
            Err(err) => {
                error!("🚨 Failed to start move for {remote_name}: {err}");
                notify(
                    &app,
                    "Move Failed",
                    &format!("Failed to start move for {remote_name}: {err}"),
                );
            }
        }
    });
}

pub fn handle_bisync_remote(app: AppHandle, id: &str) {
    let remote_name = id.replace("bisync-", "");
    tauri::async_runtime::spawn(async move {
        // Load settings with proper error handling
        let settings = match CACHE.settings.read().await.get(&remote_name).cloned() {
            Some(s) => s,
            _ => {
                error!("🚨 Remote {remote_name} not found in settings");
                return;
            }
        };

        // Extract bisync options and source/dest paths
        let bisync_config = settings.get("bisyncConfig").cloned().unwrap_or_default();
        let source_path = bisync_config
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let dest_path = bisync_config
            .get("dest")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        if source_path.is_empty() || dest_path.is_empty() {
            warn!("⚠️ Source or destination path is empty for bisync operation on {remote_name}");
            notify(
                &app,
                "BiSync Failed",
                &format!("Source or destination path is not configured for {remote_name}"),
            );
            return;
        }

        // Extract bisync options
        let bisync_options = bisync_config
            .get("options")
            .and_then(|v| v.as_object())
            .map(|obj| {
                obj.iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect::<HashMap<String, serde_json::Value>>()
            });

        let state = app.state();
        let bisync_params = crate::rclone::commands::BisyncParams {
            source: source_path.clone(),
            dest: dest_path.clone(),
            remote_name: remote_name.clone(),
            dry_run: Some(false),
            resync: false,
            check_access: Some(false),
            check_filename: None,
            max_delete: Some(0),
            force: Some(false),
            check_sync: None,
            create_empty_src_dirs: Some(false),
            remove_empty_dirs: Some(false),
            filters_file: None,
            ignore_listing_checksum: Some(false),
            resilient: Some(false),
            workdir: None,
            backupdir1: None,
            backupdir2: None,
            no_cleanup: Some(false),
            bisync_options,
            filter_options: None,
        };

        info!("🔄 Starting bisync for {remote_name}: {source_path} <-> {dest_path}");
        match start_bisync(app.clone(), bisync_params, state).await {
            Ok(_) => {
                info!("✅ BiSync started for {remote_name}");
                notify(
                    &app,
                    "BiSync Started",
                    &format!("BiSync operation started for {remote_name}"),
                );
                CACHE.refresh_all(app).await;
            }
            Err(err) => {
                error!("🚨 Failed to start bisync for {remote_name}: {err}");
                notify(
                    &app,
                    "BiSync Failed",
                    &format!("Failed to start bisync for {remote_name}: {err}"),
                );
            }
        }
    });
}

pub fn handle_stop_move(app: AppHandle, id: &str) {
    let remote_name = id.replace("stop_move-", "");
    tauri::async_runtime::spawn(async move {
        info!("⏹️ Stopping move for {remote_name}");

        let active_jobs = JOB_CACHE.get_active_jobs().await;
        if let Some(job) = active_jobs
            .iter()
            .find(|j| j.remote_name == remote_name && j.job_type == "move")
        {
            let state = app.state();
            match stop_job(app.clone(), job.jobid, "move".to_string(), state).await {
                Ok(_) => {
                    info!("✅ Move stopped for {remote_name}");
                    notify(
                        &app,
                        "Move Stopped",
                        &format!("Move stopped for {remote_name}"),
                    );
                    CACHE.refresh_all(app).await;
                }
                Err(err) => {
                    error!("🚨 Failed to stop move for {remote_name}: {err}");
                    notify(
                        &app,
                        "Stop Failed",
                        &format!("Failed to stop move for {remote_name}: {err}"),
                    );
                }
            }
        } else {
            warn!("⚠️ No active move job found for {remote_name}");
        }
    });
}

pub fn handle_stop_bisync(app: AppHandle, id: &str) {
    let remote_name = id.replace("stop_bisync-", "");
    tauri::async_runtime::spawn(async move {
        info!("⏹️ Stopping bisync for {remote_name}");

        let active_jobs = JOB_CACHE.get_active_jobs().await;
        if let Some(job) = active_jobs
            .iter()
            .find(|j| j.remote_name == remote_name && j.job_type == "bisync")
        {
            let state = app.state();
            match stop_job(app.clone(), job.jobid, "bisync".to_string(), state).await {
                Ok(_) => {
                    info!("✅ BiSync stopped for {remote_name}");
                    notify(
                        &app,
                        "BiSync Stopped",
                        &format!("BiSync stopped for {remote_name}"),
                    );
                    CACHE.refresh_all(app).await;
                }
                Err(err) => {
                    error!("🚨 Failed to stop bisync for {remote_name}: {err}");
                    notify(
                        &app,
                        "Stop Failed",
                        &format!("Failed to stop bisync for {remote_name}: {err}"),
                    );
                }
            }
        } else {
            warn!("⚠️ No active bisync job found for {remote_name}");
        }
    });
}
