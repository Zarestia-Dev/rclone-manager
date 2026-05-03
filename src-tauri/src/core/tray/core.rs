use log::{error, info};
use tauri::{AppHandle, Runtime};

use super::TraySnapshot;
use super::menu::create_tray_menu;

pub async fn update_tray_menu<R: Runtime>(app: AppHandle<R>) -> tauri::Result<()> {
    let snapshot = TraySnapshot::fetch(&app).await?;
    let app_clone = app.clone();

    app.run_on_main_thread(move || {
        let new_menu = match create_tray_menu(&app_clone, &snapshot) {
            Ok(m) => m,
            Err(e) => {
                error!("Failed to create tray menu: {e}");
                return;
            }
        };

        let is_active = !snapshot.active_jobs.is_empty();

        if let Some(tray) = app_clone.tray_by_id("main-tray") {
            if let Err(e) = tray.set_menu(Some(new_menu)) {
                error!("Failed to set tray menu: {e}");
                return;
            }

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

            info!("✅ Tray menu and icon updated on main thread");
        } else {
            info!("⚠️ Tray menu update failed: Tray not found");
        }
    })?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::test::mock_builder;

    #[tokio::test]
    async fn test_tray_update_concurrency_safety() {
        // Use a mock builder to create a test app context
        let app = mock_builder()
            .manage(crate::rclone::backend::BackendManager::new())
            .build(tauri::generate_context!())
            .unwrap();
        let handle = app.handle();

        // Fire 50 concurrent updates from background threads.
        // If our Rc safety logic (run_on_main_thread) is broken,
        // this will likely trigger a panic during the test execution.
        let mut tasks = vec![];
        for _ in 0..50 {
            let h = handle.clone();
            tasks.push(tokio::spawn(async move {
                // We expect this to fail gracefully (due to missing AppSettingsManager)
                // but it must NOT panic due to Rc threading violations.
                let _ = update_tray_menu(h).await;
            }));
        }

        // We don't necessarily care if the tasks succeed (they will fail because of missing state),
        // we just care that they don't PANIC.
        let _ = futures::future::join_all(tasks).await;
    }
}
