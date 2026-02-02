use log::info;
use tauri::AppHandle;

use super::menu::create_tray_menu;

pub async fn update_tray_menu(app: AppHandle) -> tauri::Result<()> {
    let new_menu = create_tray_menu(&app).await?;
    if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_menu(Some(new_menu))?;
        info!("✅ Tray menu updated");
    } else {
        info!("⚠️ Tray menu update failed: Tray not found");
    }
    Ok(())
}
