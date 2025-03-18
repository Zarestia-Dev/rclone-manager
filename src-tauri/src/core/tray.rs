use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime,
};

use crate::rclone::api::{get_remotes, RcloneState};

/// Function to create the system tray menu
pub async fn setup_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let handle = app.clone();
    let separator = PredefinedMenuItem::separator(&handle)?;

    // Base Menu Items
    let show_app_item = MenuItem::with_id(&handle, "show_app", "Show App", true, None::<&str>)?;
    let mount_all_item = MenuItem::with_id(&handle, "mount_all", "Mount All", true, None::<&str>)?;
    let unmount_all_item =
        MenuItem::with_id(&handle, "unmount_all", "Unmount All", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(&handle, "settings", "Settings", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(&handle, "quit", "Quit", true, None::<&str>)?;

    // Fetch dynamic remotes (you need a function for this)
    let rclone_state = app.state::<RcloneState>();
    let remotes = get_remotes(rclone_state).await; // Fetch from state or API

    let mut remote_menus = vec![];

    // Iterate over each remote name
    for remote in remotes.iter().flatten() {
        // Flatten to get individual remotes
        let mount_item = MenuItem::with_id(
            &handle,
            format!("mount-{}", remote),
            "Mount",
            true,
            None::<&str>,
        )?;
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
        let remove_item = MenuItem::with_id(
            &handle,
            format!("remove-{}", remote),
            "Remove",
            true,
            None::<&str>,
        )?;

        let remote_submenu = Submenu::with_items(
            &handle,
            remote,
            true,
            &[&mount_item, &unmount_item, &browse_item, &remove_item],
        )?;

        remote_menus.push(remote_submenu);
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
    menu_items.push(&settings_item);
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
            "settings" => {
                let _ = app.emit("open-settings", ());
            }
            "quit" => {
                app.exit(0);
            }
            id if id.starts_with("mount-") => {
                let remote = id.replace("mount-", "");
                let _ = app.emit("mount-remote", remote);
            }
            id if id.starts_with("unmount-") => {
                let remote = id.replace("unmount-", "");
                let _ = app.emit("unmount-remote", remote);
            }
            id if id.starts_with("browse-") => {
                let remote = id.replace("browse-", "");
                let _ = app.emit("browse-remote", remote);
            }
            id if id.starts_with("remove-") => {
                let remote = id.replace("remove-", "");
                let _ = app.emit("remove-remote", remote);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}
