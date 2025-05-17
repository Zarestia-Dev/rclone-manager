use std::collections::HashMap;

use log::{debug, error, info, warn};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use crate::{
    core::settings::settings::save_remote_settings,
    rclone::api::{
        api_command::{delete_remote, mount_remote, unmount_remote},
        state::CACHE,
    },
    utils::{
        builder::create_app_window, file_helper::get_folder_location,
        notification::NotificationService,
    },
};

fn notify(app: &AppHandle, title: &str, body: &str) {
    let notifier = app.state::<NotificationService>();
    notifier.send(app, title, body);
}

async fn prompt_mount_point(app: &AppHandle, remote_name: &str) -> Option<String> {
    let response = app
        .dialog()
        .message(format!(
            "No mount point specified for '{}'. Would you like to select one now?",
            remote_name
        ))
        .title("Mount Point Required")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Yes, Select".to_owned(),
            "Cancel".to_owned(),
        ))
        .kind(MessageDialogKind::Warning)
        .blocking_show();

    if !response {
        info!(
            "❌ User cancelled mount point selection for {}",
            remote_name
        );
        return None;
    }

    match get_folder_location(app.clone(), false).await {
        Ok(Some(path)) if !path.is_empty() => {
            info!("📁 Selected mount point for {}: {}", remote_name, path);
            Some(path)
        }
        Ok(Some(_)) => {
            info!("⚠️ User selected an empty folder path for {}", remote_name);
            None
        }
        Ok(None) => {
            info!("❌ User didn't select a folder for {}", remote_name);
            None
        }
        Err(err) => {
            error!("🚨 Error selecting folder for {}: {}", remote_name, err);
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
            None => {
                error!("🚨 Remote {} not found in settings", remote_name);
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
            None => match prompt_mount_point(&app, &remote_name).await {
                Some(path) => path,
                None => {
                    info!("❌ Mounting cancelled - no mount point selected");
                    return;
                }
            },
        };

        // Compose the remote path using remote_name and mountConfig.source
        let remote_path = match settings
            .get("mountConfig")
            .and_then(|v| v.get("source"))
            .and_then(|v| v.as_str())
        {
            Some(source) if !source.is_empty() => format!("{}:{}", remote_name, source),
            _ => format!("{}:", remote_name),
        };

        // Mount the remote
        match mount_remote(
            app.clone(),
            remote_path.clone(),
            mount_point.clone(),
            mount_options,
            vfs_options,
            app.state(),
        )
        .await
        {
            Ok(_) => {
                info!("✅ Successfully mounted {}", remote_path);
                notify(
                    &app,
                    "Mount Successful",
                    &format!("Successfully mounted {} at {}", remote_path, mount_point),
                );
                // Save the mount point if it was newly selected
                if settings
                    .get("mountConfig")
                    .and_then(|v| v.get("dest"))
                    .and_then(|v| v.as_str())
                    .is_none()
                {
                    let mut new_settings = settings.clone();
                    new_settings["mountConfig"]["dest"] =
                        serde_json::Value::String(mount_point);
                    if let Err(e) =
                        save_remote_settings(remote_name, new_settings, app.state(), app.clone())
                            .await
                    {
                        error!("🚨 Failed to save mount point: {}", e);
                    }
                }
            }
            Err(e) => {
                error!("🚨 Failed to mount {}: {}", remote_path, e);
                notify(
                    &app,
                    "Mount Failed",
                    &format!("Failed to mount {}: {}", remote_path, e),
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
            error!("🚨 Remote {} not found in cached settings", remote);
            serde_json::Value::Null
        });

        let mount_point = get_mount_point(&settings);
        let state = app_clone.state();
        match unmount_remote(app_clone.clone(), mount_point, remote_name, state).await {
            Ok(_) => {
                info!("🛑 Unmounted {}", remote);
                notify(
                    &app_clone,
                    "Unmount Successful",
                    &format!("Successfully unmounted {}", remote),
                );
            }
            Err(err) => {
                error!("🚨 Failed to unmount {}: {}", remote, err);
                notify(
                    &app_clone,
                    "Unmount Failed",
                    &format!("Failed to unmount {}: {}", remote, err),
                );
            }
        }
    });
}

pub fn handle_browse_remote(app: &AppHandle, id: &str) {
    let remote = id.replace("browse-", "");
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let settings_result = CACHE.settings.read().await;
        let settings = settings_result.get(&remote).cloned().unwrap_or_else(|| {
            error!("🚨 Remote {} not found in cached settings", remote);
            serde_json::Value::Null
        });
        let mount_point = get_mount_point(&settings);

        match app_clone.opener().open_path(mount_point, None::<&str>) {
            Ok(_) => {
                info!("📂 Opened file manager for {}", remote);
            }
            Err(e) => {
                error!("🚨 Failed to open file manager for {}: {}", remote, e);
            }
        }
    });
}

pub fn handle_delete_remote(app: AppHandle, id: &str) {
    let remote = id.replace("delete-", "");
    let app_clone = app.clone(); // Cloning the app
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_dialog::DialogExt;
        let _answer = app_clone
            .dialog()
            .message(format!(
                "Are you sure you want to delete the remote {}?",
                remote
            ))
            .title(format!("Delete Remote {}", remote))
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Yes, Delete".to_owned(),
                "Cancel".to_owned(),
            ))
            .kind(MessageDialogKind::Warning)
            .show(move |result| {
                let remote = remote.clone();
                tauri::async_runtime::spawn(async move {
                    if result {
                        let state = app_clone.state();
                        match delete_remote(app_clone.clone(), remote.clone(), state).await {
                            Ok(_) => {
                                info!("🗑️ Deleted remote {}", remote);
                                notify(
                                    &app_clone,
                                    "Remote Deleted",
                                    &format!("Successfully deleted remote {}", remote),
                                );
                            }
                            Err(err) => {
                                error!("🚨 Failed to delete remote {}: {}", remote, err);
                                notify(
                                    &app_clone,
                                    "Deletion Failed",
                                    &format!("Failed to delete remote {}: {}", remote, err),
                                );
                            }
                        }
                    } else {
                        info!("❌ Cancelled deletion of remote {}", remote);
                    }
                });
            });
    });
}
