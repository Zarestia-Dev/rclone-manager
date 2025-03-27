
use log::{error, info};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime,
};
use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};

use crate::rclone::api::{delete_remote, get_remotes, mount_remote, unmount_remote, RcloneState};

use super::settings::get_remote_settings;

/// Function to create the system tray menu
pub async fn setup_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let handle = app.clone();
    let separator = PredefinedMenuItem::separator(&handle)?;

    // Base Menu Items
    let show_app_item = MenuItem::with_id(&handle, "show_app", "Show App", true, None::<&str>)?;
    let mount_all_item = MenuItem::with_id(&handle, "mount_all", "Mount All", true, None::<&str>)?;
    let unmount_all_item =
        MenuItem::with_id(&handle, "unmount_all", "Unmount All", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(&handle, "quit", "Quit", true, None::<&str>)?;

    // Fetch remotes
    let rclone_state = app.state::<RcloneState>();
    let remotes = get_remotes(rclone_state).await;

    let mut remote_menus = vec![];

    for remote in remotes.iter().flatten() {
        if let Ok(settings) = get_remote_settings(remote.to_string(), app.state()).await {
            if let Some(_show_in_tray) = settings.get("show_in_tray_menu").and_then(|v| v.as_bool())
            {
                let mut submenu_items: Vec<Box<dyn tauri::menu::IsMenuItem<R>>> = vec![];

                // Check if mount point exists and add mount options submenu
                if let Some(_mount_point) = settings
                    .get("mount_options")
                    .as_ref()
                    .and_then(|opts| opts.get("mount_point").and_then(|v| v.as_str()))
                {
                    let mount_item = MenuItem::with_id(
                        &handle,
                        format!("mount-{}", remote),
                        format!("Mount"),
                        true,
                        None::<&str>,
                    )?;
                    submenu_items.push(Box::new(mount_item));
                }

                let unmount_item = MenuItem::with_id(
                    &handle,
                    format!("unmount-{}", remote),
                    "Unmount",
                    true,
                    None::<&str>,
                )?;
                let browse_item = MenuItem::with_id(
                    &handle,
                    format!("browse-{}", remote),
                    "Browse",
                    true,
                    None::<&str>,
                )?;
                let delete_item = MenuItem::with_id(
                    &handle,
                    format!("delete-{}", remote),
                    "Delete",
                    true,
                    None::<&str>,
                )?;

                submenu_items.push(Box::new(unmount_item));
                submenu_items.push(Box::new(browse_item));
                submenu_items.push(Box::new(delete_item));

                let remote_submenu = Submenu::with_items(
                    &handle,
                    remote,
                    true,
                    &submenu_items
                        .iter()
                        .map(|item| item.as_ref())
                        .collect::<Vec<_>>(),
                )?;

                remote_menus.push(remote_submenu);
            }
        }
    }

    // Main Menu
    let mut menu_items: Vec<&dyn tauri::menu::IsMenuItem<R>> = remote_menus
        .iter()
        .map(|submenu| submenu as &dyn tauri::menu::IsMenuItem<R>)
        .collect();

    menu_items.push(&separator);
    menu_items.push(&show_app_item);
    menu_items.push(&mount_all_item);
    menu_items.push(&unmount_all_item);
    menu_items.push(&separator);
    menu_items.push(&quit_item);

    let menu = Menu::with_items(&handle, &menu_items)?;

    // Build Tray
    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .on_tray_icon_event(move |tray, event| {
            let app = tray.app_handle();
            match event {
                TrayIconEvent::Click { .. } => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                _ => {}
            }
        })
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show_app" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "mount_all" => {
                let _ = app.emit("mount-all", ());
            }
            "unmount_all" => {
                let _ = app.emit("unmount-all", ());
            }
            "quit" => {
                app.exit(0);
            }
            id if id.starts_with("mount-") => {
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
                        }
                        Err(err) => {
                            error!("Failed to mount {}: {}", remote, err);
                        }
                    }
                });
            }
            id if id.starts_with("unmount-") => {
                let remote = id.replace("unmount-", "");
                let app_clone = app.clone(); // Cloning the app

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

                    match unmount_remote(mount_point.to_string(), app_clone.state()).await {
                        Ok(_) => {
                            info!("Unmounted {}", remote);
                        }
                        Err(err) => {
                            error!("Failed to unmount {}: {}", remote, err);
                        }
                    }
                });
            }
            id if id.starts_with("browse-") => {
                let remote = id.replace("browse-", "");
                let _ = app.emit("browse-remote", remote);
            }
            id if id.starts_with("delete-") => {
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
                        .title("Delete Remote")
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
            _ => {}
        })
        .build(app)?;

    Ok(())
}
