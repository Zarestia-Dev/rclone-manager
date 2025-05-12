use log::info;
use tauri::AppHandle;

use super::menu::create_tray_menu;
use std::sync::{Arc, RwLock};

#[derive(Clone)]
pub struct TrayEnabled {
    pub enabled: Arc<RwLock<bool>>,
}

pub async fn update_tray_menu(
    app: AppHandle,
    max_tray_items: usize,
) -> tauri::Result<()> {
    let new_menu = create_tray_menu(&app, max_tray_items).await?;
    if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_menu(Some(new_menu))?;
        info!("✅ Tray menu updated");
    } else {
        info!("⚠️ Tray menu update failed: Tray not found");
    }
    Ok(())
}
