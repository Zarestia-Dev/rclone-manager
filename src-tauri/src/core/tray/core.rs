use log::{error, info};
use tauri::{AppHandle, Manager, Runtime};

use super::TrayMenuState;
use super::TraySnapshot;
use super::menu::{MenuPlan, create_tray_menu_from_plan};
use crate::core::settings::AppSettingsManager;

pub async fn update_tray_menu<R: Runtime>(app: AppHandle<R>) -> tauri::Result<()> {
    if app.tray_by_id("main-tray").is_none() {
        return Ok(());
    }

    let settings_manager = app.state::<AppSettingsManager>();
    let settings = settings_manager
        .get_all()
        .map_err(|e| tauri::Error::Io(std::io::Error::other(e.to_string())))?;

    if !settings.general.tray_enabled {
        return Ok(());
    }

    let snapshot = TraySnapshot::fetch(&app).await?;
    let is_active = !snapshot.active_jobs.is_empty();
    let tooltip = build_tooltip(&snapshot);
    let max_tray_items = settings.core.max_tray_items;

    let plan = MenuPlan::build(&snapshot, max_tray_items);

    {
        let state = app.state::<TrayMenuState>();
        let mut last = state.last_plan.lock().unwrap();
        if last.as_ref() == Some(&plan) {
            return Ok(());
        }
        *last = Some(plan.clone());
    }

    let icon = super::icon::get_icon(is_active).ok();

    let app_clone = app.clone();
    app.run_on_main_thread(move || {
        let Some(tray) = app_clone.tray_by_id("main-tray") else {
            info!("Tray menu update failed: tray not found");
            return;
        };

        match create_tray_menu_from_plan(&app_clone, &plan) {
            Ok(menu) => {
                if let Err(e) = tray.set_menu(Some(menu)) {
                    error!("Failed to set tray menu: {e}");
                    return;
                }
            }
            Err(e) => {
                error!("Failed to build tray menu: {e}");
            }
        }

        if let Some(image) = icon {
            let _ = tray.set_icon(Some(image));
        }

        let _ = tray.set_tooltip(Some(tooltip));
        info!("Tray menu and icon updated on main thread");
    })?;

    Ok(())
}

fn build_tooltip(snapshot: &TraySnapshot) -> String {
    let mut parts: Vec<String> = Vec::new();

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
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::test::mock_builder;

    #[tokio::test]
    async fn test_tray_update_concurrency_safety() {
        use crate::core::settings::schema::AppSettings;

        let temp_dir = tempfile::TempDir::new().unwrap();
        let config = rcman::SettingsConfig::builder("test-app", "1.0.0")
            .with_config_dir(temp_dir.path())
            .with_schema::<AppSettings>()
            .build();
        let settings_manager = rcman::SettingsManager::new(config).unwrap();
        settings_manager
            .register_sub_settings(rcman::SubSettingsConfig::singlefile("remotes"))
            .unwrap();

        let app = mock_builder()
            .manage(crate::rclone::backend::BackendManager::new())
            .manage(settings_manager)
            .manage(TrayMenuState::default())
            .build(tauri::generate_context!())
            .unwrap();
        let handle = app.handle();

        let mut tasks = vec![];
        for _ in 0..50 {
            let h = handle.clone();
            tasks.push(tokio::spawn(async move { update_tray_menu(h).await }));
        }

        let results = futures::future::join_all(tasks).await;
        for (i, res) in results.into_iter().enumerate() {
            let task_res = res.unwrap_or_else(|e| {
                if e.is_panic() {
                    panic!("Task {i} panicked!");
                } else {
                    panic!("Task {i} failed to join: {e:?}");
                }
            });
            assert!(
                task_res.is_ok(),
                "Task {i} returned error: {:?}",
                task_res.err()
            );
        }
    }
}
