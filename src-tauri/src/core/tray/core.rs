use log::info;
use tauri::{AppHandle, Manager};

use super::menu::create_tray_menu;
use crate::rclone::backend::BackendManager;

pub async fn update_tray_menu(app: AppHandle) -> tauri::Result<()> {
    let new_menu = create_tray_menu(&app).await?;

    // Check if there are active jobs/mounts/serves
    let backend_manager = app.state::<BackendManager>();
    let active_jobs = backend_manager.job_cache.get_active_jobs().await;
    let active_mounts = backend_manager.remote_cache.get_mounted_remotes().await;
    let active_serves = backend_manager.remote_cache.get_serves().await;

    let is_active = !active_jobs.is_empty();

    if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_menu(Some(new_menu))?;

        if let Ok(image) = super::icon::get_icon(is_active) {
            let _ = tray.set_icon(Some(image));
        }

        // Build composite tooltip
        let tooltip = {
            let mut parts = Vec::new();

            if !active_jobs.is_empty() {
                let count = active_jobs.len().to_string();
                parts.push(if active_jobs.len() > 1 {
                    crate::t!("tray.tooltipTasks", "count" => &count)
                } else {
                    crate::t!("tray.tooltipTask")
                });
            }

            if !active_mounts.is_empty() {
                let count = active_mounts.len().to_string();
                parts.push(if active_mounts.len() > 1 {
                    crate::t!("tray.tooltipMounts", "count" => &count)
                } else {
                    crate::t!("tray.tooltipMount")
                });
            }

            if !active_serves.is_empty() {
                let count = active_serves.len().to_string();
                parts.push(if active_serves.len() > 1 {
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
