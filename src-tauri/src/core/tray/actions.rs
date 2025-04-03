use log::{error, info};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use crate::{
    core::{settings::settings::get_remote_settings, tray::tray::update_tray_menu},
    rclone::api::api::{delete_remote, mount_remote, unmount_remote},
};

pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn handle_mount_remote<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let remote = id.replace("mount-", "");
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let remote_name = remote.to_string();
        let settings = get_remote_settings(remote_name.clone(), app_clone.state())
            .await
            .unwrap();
        let mount_options = settings.get("mount_options").unwrap().clone();
        let vfs_options = settings.get("vfs_options").unwrap().clone();
        let state = app_clone.state();
        let mount_point = mount_options.get("mount_point").unwrap().as_str().unwrap();

        let mount_options = mount_options
            .as_object()
            .map(|obj| obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect());
        let vfs_options = vfs_options
            .as_object()
            .map(|obj| obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect());
        match mount_remote(
            remote_name,
            mount_point.to_string(),
            mount_options,
            vfs_options,
            state,
        )
        .await
        {
            Ok(_) => {
                info!("Mounted {}", remote);
                update_tray_menu(&app_clone, 10).await.ok();
            }
            Err(err) => {
                error!("Failed to mount {}: {}", remote, err);
            }
        }
    });
}

pub fn handle_unmount_remote<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let remote = id.replace("unmount-", "");
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let settings = get_remote_settings(remote.to_string(), app_clone.state())
            .await
            .unwrap();
        let mount_point = settings
            .get("mount_options")
            .unwrap()
            .get("mount_point")
            .unwrap()
            .as_str()
            .unwrap();
        let state = app_clone.state();
        match unmount_remote(mount_point.to_string(), state).await {
            Ok(_) => {
                info!("Unmounted {}", remote);
                update_tray_menu(&app_clone, 10).await.ok();
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
        let settings = get_remote_settings(remote.to_string(), app_clone.state())
            .await
            .unwrap();
        let mount_point = settings
            .get("mount_options")
            .unwrap()
            .get("mount_point")
            .unwrap()
            .as_str()
            .unwrap();

        match app_clone.opener().open_path(mount_point, None::<&str>) {
            Ok(_) => {
                info!("Opened file manager for {}", remote);
                update_tray_menu(&app_clone, 10).await.ok();
            }
            Err(e) => {
                error!("Failed to open file manager for {}: {}", remote, e);
            }
        }
    });
}

pub fn handle_delete_remote<R: Runtime>(app: &AppHandle<R>, id: &str) {
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
                        match delete_remote(remote.clone(), state).await {
                            Ok(_) => {
                                info!("Deleted remote {}", remote);
                                update_tray_menu(&app_clone, 10).await.ok();
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
