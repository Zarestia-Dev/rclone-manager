use std::sync::atomic::Ordering;

use log::{debug, error};
use tauri::{AppHandle, Manager, Runtime};

use super::icon::TrayIconKind;
use super::menu::{MenuPlan, create_tray_menu_from_plan};
use super::{TrayMenuState, TraySnapshot};
use crate::core::settings::AppSettingsManager;

/// Updates the full tray menu, tooltip, and icon.
/// Coalesces rapid concurrent triggers into at most 1 in-flight and 1 trailing update.
pub async fn update_tray_menu<R: Runtime>(app: AppHandle<R>) -> tauri::Result<()> {
    if app.tray_by_id("main-tray").is_none() {
        return Ok(());
    }

    let state = app.state::<TrayMenuState>();

    // Try to acquire the update lock. If another update is in-flight, mark pending and return immediately.
    let _guard = match state.update_lock.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            state.has_pending.store(true, Ordering::SeqCst);
            match state.update_lock.try_lock() {
                Ok(guard) => guard,
                Err(_) => return Ok(()),
            }
        }
    };

    loop {
        perform_update_tray_menu(&app, &state).await?;
        if !state.has_pending.swap(false, Ordering::SeqCst) {
            break;
        }
    }

    Ok(())
}

async fn perform_update_tray_menu<R: Runtime>(
    app: &AppHandle<R>,
    state: &TrayMenuState,
) -> tauri::Result<()> {
    let settings_manager = app.state::<AppSettingsManager>();
    let settings = settings_manager
        .get_all()
        .map_err(|e| tauri::Error::Io(std::io::Error::other(e.to_string())))?;

    if !settings.general.tray_enabled {
        return Ok(());
    }

    let snapshot = TraySnapshot::fetch(app).await?;

    let is_active = !snapshot.active_jobs.is_empty();
    let tooltip = build_tooltip(&snapshot);
    let max_tray_items = settings.core.max_tray_items;

    let plan = MenuPlan::build(&snapshot, max_tray_items);
    let icon_kind = TrayIconKind::resolve(is_active, &settings.general.tray_icon_theme);

    let (plan_changed, tooltip_changed, icon_changed) = state
        .cache
        .lock()
        .unwrap()
        .diff_and_update(&plan, &tooltip, icon_kind);

    if !plan_changed && !tooltip_changed && !icon_changed {
        return Ok(());
    }

    let icon = if icon_changed {
        Some(icon_kind.to_image())
    } else {
        None
    };

    let plan_to_set = if plan_changed { Some(plan) } else { None };
    let tooltip_to_set = if tooltip_changed { Some(tooltip) } else { None };

    let app_clone = app.clone();
    app.run_on_main_thread(move || {
        let Some(tray) = app_clone.tray_by_id("main-tray") else {
            debug!("Tray menu update skipped: tray not found");
            return;
        };

        if let Some(ref plan) = plan_to_set {
            match create_tray_menu_from_plan(&app_clone, plan) {
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
        }

        if let Some(image) = icon
            && let Err(e) = tray.set_icon(Some(image))
        {
            error!("Failed to set tray icon: {e}");
        }

        if let Some(tooltip) = tooltip_to_set
            && let Err(e) = tray.set_tooltip(Some(tooltip))
        {
            error!("Failed to set tray tooltip: {e}");
        }

        debug!(
            "Tray visuals updated on main thread (plan_changed={plan_changed}, icon_changed={icon_changed}, tooltip_changed={tooltip_changed})"
        );
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
            tasks.push(crate::utils::spawn(
                async move { update_tray_menu(h).await },
            ));
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
