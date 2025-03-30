use log::info;
use tauri::{
    image::Image,
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

use super::menu::create_tray_menu;

pub async fn setup_tray<R: Runtime>(
    app: &AppHandle<R>,
    max_tray_items: usize,
) -> tauri::Result<()> {
    let tray_menu = create_tray_menu(app, max_tray_items).await?;

    TrayIconBuilder::with_id("main")
        .icon(Image::from_bytes(include_bytes!(
            "../../../icons/rclone_symbolic.png"
        ))?)
        .menu(&tray_menu)
        .on_tray_icon_event(move |tray, event| {
            let app = tray.app_handle();
            if let TrayIconEvent::Click { .. } = event {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}

pub async fn update_tray_menu<R: Runtime>(
    app: &AppHandle<R>,
    max_tray_items: usize,
) -> tauri::Result<()> {
    let new_menu = create_tray_menu(app, max_tray_items).await?;
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_menu(Some(new_menu))?;
        info!("✅ Tray menu updated");
    } else {
        info!("⚠️ Tray menu update failed: Tray not found");
    }
    Ok(())
}
