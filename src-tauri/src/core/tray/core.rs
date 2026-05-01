use log::info;
use tauri::AppHandle;

use super::TraySnapshot;
use super::menu::create_tray_menu;

pub async fn update_tray_menu(app: AppHandle) -> tauri::Result<()> {
    let snapshot = TraySnapshot::fetch(&app).await?;
    let new_menu = create_tray_menu(&app, &snapshot).await?;

    let is_active = !snapshot.active_jobs.is_empty();

    if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_menu(Some(new_menu))?;

        if let Ok(image) = super::icon::get_icon(is_active) {
            let _ = tray.set_icon(Some(image));
        }

        // Build composite tooltip
        let tooltip = {
            let mut parts = Vec::new();

            if !snapshot.active_jobs.is_empty() {
                let count = snapshot.active_jobs.len().to_string();
                parts.push(if snapshot.active_jobs.len() > 1 {
                    crate::t!("tray.tooltipTasks", "count" => &count)
                } else {
                    crate::t!("tray.tooltipTask")
                });
            }

            if !snapshot.mounted_remotes.is_empty() {
                let count = snapshot.mounted_remotes.len().to_string();
                parts.push(if snapshot.mounted_remotes.len() > 1 {
                    crate::t!("tray.tooltipMounts", "count" => &count)
                } else {
                    crate::t!("tray.tooltipMount")
                });
            }

            if !snapshot.active_serves.is_empty() {
                let count = snapshot.active_serves.len().to_string();
                parts.push(if snapshot.active_serves.len() > 1 {
                    crate::t!("tray.tooltipServes", "count" => &count)
                } else {
                    crate::t!("tray.tooltipServe")
                });
            }

            if parts.is_empty() {
                crate::t!("tray.tooltipDefault")
            } else {
                format!(
                    "{} — {}",
                    crate::t!("tray.tooltipDefault"),
                    parts.join(" · ")
                )
            }
        };
        let _ = tray.set_tooltip(Some(tooltip));

        info!("✅ Tray menu and icon updated");
    } else {
        info!("⚠️ Tray menu update failed: Tray not found");
    }
    Ok(())
}
