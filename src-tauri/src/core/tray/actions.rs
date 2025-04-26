use std::collections::HashMap;

use log::{error, info};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use crate::rclone::api::{
    api_command::{delete_remote, mount_remote, unmount_remote},
    state::CACHE,
};

fn get_mount_point(settings: &serde_json::Value) -> String {
    let remote_name = settings
        .get("mount_options")
        .and_then(|v| v.get("remote_name"))
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");

    let default_mount_point = if cfg!(target_os = "windows") {
        format!("C:\\Documents\\Rclone\\{}", remote_name)
    } else {
        format!("/tmp/{}", remote_name)
    };

    settings
        .get("mount_options")
        .and_then(|v| v.get("mount_point"))
        .and_then(|v| v.as_str())
        .unwrap_or(&default_mount_point)
        .to_string()
}

pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        if let Ok(false) = window.is_visible() {
            let _ = window.eval("location.reload();");
        }
    }
}

pub fn handle_mount_remote(app: AppHandle, id: &str) {
    let remote = id.replace("mount-", "");
    let app_clone = app.clone();

    tauri::async_runtime::spawn(async move {
        let remote_name = remote.to_string();

        let settings_result = CACHE.settings.read().await;

        let settings_result = settings_result
            .get(&remote_name)
            .cloned()
            .unwrap_or_else(|| {
                error!("Remote {} not found in cached settings", remote_name);
                serde_json::Value::Null
            });

        // Gracefully handle optional values
        let mount_options = settings_result
            .get("mount_options")
            .and_then(|v| v.as_object())
            .map(|obj| {
                obj.iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect::<HashMap<_, _>>()
            });

        let vfs_options = settings_result
            .get("vfs_options")
            .and_then(|v| v.as_object())
            .map(|obj| {
                obj.iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect::<HashMap<_, _>>()
            });

        // Optional mount_point fallback (empty string or use remote_name)
        let mount_point = get_mount_point(&settings_result);

        let state = app_clone.state();

        match mount_remote(
            app_clone.clone(),
            remote_name.clone(),
            mount_point,
            mount_options,
            vfs_options,
            state,
        )
        .await
        {
            Ok(_) => {
                info!("✅ Mounted {}", remote_name);
            }
            Err(err) => {
                error!("❌ Failed to mount {}: {}", remote_name, err);
            }
        }
    });
}

pub fn handle_unmount_remote(app: AppHandle, id: &str) {
    let remote = id.replace("unmount-", "");
    let app_clone = app.clone();

    tauri::async_runtime::spawn(async move {
        let settings_result = CACHE.settings.read().await;
        let settings = settings_result.get(&remote).cloned().unwrap_or_else(|| {
            error!("Remote {} not found in cached settings", remote);
            serde_json::Value::Null
        });

        let mount_point = get_mount_point(&settings);
        let state = app_clone.state();
        match unmount_remote(app_clone.clone(), mount_point, state).await {
            Ok(_) => {
                info!("Unmounted {}", remote);
            }
            Err(err) => {
                error!("Failed to unmount {}: {}", remote, err);
            }
        }
    });
}

pub fn handle_browse_remote<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let remote = id.replace("browse-", "");
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let settings_result = CACHE.settings.read().await;
        let settings = settings_result.get(&remote).cloned().unwrap_or_else(|| {
            error!("Remote {} not found in cached settings", remote);
            serde_json::Value::Null
        });
        let mount_point = get_mount_point(&settings);

        match app_clone.opener().open_path(mount_point, None::<&str>) {
            Ok(_) => {
                info!("Opened file manager for {}", remote);
            }
            Err(e) => {
                error!("Failed to open file manager for {}: {}", remote, e);
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
                                info!("Deleted remote {}", remote);
                            }
                            Err(err) => {
                                error!("Failed to delete remote {}: {}", remote, err);
                            }
                        }
                    } else {
                        info!("Cancelled deletion of remote {}", remote);
                    }
                });
            });
    });
}
