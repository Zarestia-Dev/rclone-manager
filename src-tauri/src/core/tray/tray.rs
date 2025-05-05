use log::info;
use tauri::{
    image::Image, tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent}, AppHandle, Emitter, Manager
};

use super::menu::create_tray_menu;

pub async fn setup_tray(
    app: AppHandle,
    max_tray_items: usize,
) -> tauri::Result<()> {
    let mut old_max_tray_items = 0;

    let max_tray_items = if max_tray_items == 0 {
        old_max_tray_items
    } else {
        old_max_tray_items = max_tray_items;
        old_max_tray_items
    };

    let app_clone = app.clone();

    let tray_menu = create_tray_menu(&app_clone, max_tray_items).await?;

    TrayIconBuilder::with_id("main")
        .icon(Image::from_bytes(include_bytes!(
            "../../../icons/rclone_symbolic.png"
        ))?)
        .tooltip("RClone Manager")
        .menu(&tray_menu)
        .on_tray_icon_event(move |tray, event| {
            let app = tray.app_handle();

            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => {
                    // Show the main window on left click
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                _ => {}
            }
        })
        .build(&app_clone)?;

    app.emit("tray_menu_updated", ())?;
    Ok(())
}


pub async fn update_tray_menu(
    app: AppHandle,
    max_tray_items: usize,
) -> tauri::Result<()> {
    let new_menu = create_tray_menu(&app, max_tray_items).await?;
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_menu(Some(new_menu))?;
        info!("✅ Tray menu updated");
    } else {
        info!("⚠️ Tray menu update failed: Tray not found");
    }
    Ok(())
}
