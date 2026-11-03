use crate::context::BackendContext;
use std::sync::atomic::Ordering;

use log::{debug, error};
use tauri::{AppHandle, Runtime};

use super::icon::TrayIconKind;
use super::menu::{MenuPlan, create_tray_menu_from_plan};
use super::{TrayMenuState, TraySnapshot};
use crate::services::settings::AppSettingsManager;

/// Updates the full tray menu, tooltip, and icon.
/// Coalesces rapid concurrent triggers into at most 1 in-flight and 1 trailing update.
pub async fn update_tray_menu<R: Runtime>(app: AppHandle<R>) -> tauri::Result<()> {
    if app.tray_by_id("main-tray").is_none() {
        return Ok(());
    }

    let state = app.backend_state::<TrayMenuState>();
    // A tray that was asked for (by the setting or by `--tray`) keeps refreshing; one that
    // was switched off stays as it is.
    if !state.requested_visible.load(Ordering::SeqCst) {
        return Ok(());
    }

    // A running update re-checks the flag before it finishes, so a request that finds
    // the lock taken only has to raise it.
    state.has_pending.store(true, Ordering::SeqCst);
    loop {
        let Ok(guard) = state.update_lock.try_lock() else {
            return Ok(());
        };
        while state.has_pending.swap(false, Ordering::SeqCst) {
            perform_update_tray_menu(&app, &state).await?;
        }
        // Release before the last check so a trigger arriving now cannot be lost.
        drop(guard);
        if !state.has_pending.load(Ordering::SeqCst) {
            return Ok(());
        }
    }
}

pub(super) fn locked_tray_visuals(state: &TrayMenuState) -> (MenuPlan, String, TrayIconKind) {
    let icon = state
        .visuals()
        .icon
        .unwrap_or(TrayIconKind::ColorNormal)
        .inactive();
    (
        MenuPlan::locked(),
        rclone_manager_core::t!("tray.tooltipDefault"),
        icon,
    )
}

/// The plan, tooltip and icon the tray should show now.
pub(super) async fn build_tray_visuals<R: Runtime>(
    app: &AppHandle<R>,
    state: &TrayMenuState,
    settings_manager: &AppSettingsManager,
) -> tauri::Result<(MenuPlan, String, TrayIconKind)> {
    if crate::services::settings::access::is_locked(app.backend()) {
        return Ok(locked_tray_visuals(state));
    }

    let settings = settings_manager
        .get_all()
        .map_err(|e| tauri::Error::Io(std::io::Error::other(e.to_string())))?;

    let snapshot = TraySnapshot::fetch(app).await?;
    if crate::services::settings::access::is_locked(app.backend()) {
        return Ok(locked_tray_visuals(state));
    }

    Ok((
        MenuPlan::build(&snapshot, settings.core.max_tray_items),
        build_tooltip(&snapshot),
        TrayIconKind::resolve(
            !snapshot.active_jobs.is_empty(),
            &settings.general.tray_icon_theme,
        ),
    ))
}

async fn perform_update_tray_menu<R: Runtime>(
    app: &AppHandle<R>,
    state: &TrayMenuState,
) -> tauri::Result<()> {
    let settings_manager = app.backend_state::<AppSettingsManager>();
    let (plan, tooltip, icon_kind) = build_tray_visuals(app, state, &settings_manager).await?;

    let app_clone = app.clone();
    app.run_on_main_thread(move || {
        if let Err(error) = apply_tray_visuals(&app_clone, plan, tooltip, icon_kind) {
            error!("Failed to apply tray visuals: {error}");
        }
    })?;

    Ok(())
}

/// Checked at delivery time: a queued update may outlive the unlocked session.
pub(super) fn deliverable_visuals<R: Runtime>(
    app: &AppHandle<R>,
    state: &TrayMenuState,
    visuals: (MenuPlan, String, TrayIconKind),
) -> (MenuPlan, String, TrayIconKind) {
    if crate::services::settings::access::is_locked(app.backend()) {
        locked_tray_visuals(state)
    } else {
        visuals
    }
}

fn apply_tray_visuals<R: Runtime>(
    app: &AppHandle<R>,
    plan: MenuPlan,
    tooltip: String,
    icon_kind: TrayIconKind,
) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id("main-tray") else {
        debug!("Tray menu update skipped: tray not found");
        return Ok(());
    };
    let state = app.backend_state::<TrayMenuState>();
    let (plan, tooltip, icon_kind) = deliverable_visuals(app, &state, (plan, tooltip, icon_kind));
    let (plan_changed, tooltip_changed, icon_changed) =
        state.visuals().diff(&plan, &tooltip, icon_kind);
    if !plan_changed && !tooltip_changed && !icon_changed {
        return Ok(());
    }

    // Commit each successful change so a later failure cannot leave the cache stale.
    if plan_changed {
        tray.set_menu(Some(create_tray_menu_from_plan(app, &plan)?))?;
        state.visuals().plan = Some(plan);
    }
    if icon_changed {
        tray.set_icon(Some(icon_kind.to_image()))?;
        state.visuals().icon = Some(icon_kind);
    }
    if tooltip_changed {
        tray.set_tooltip(Some(&tooltip))?;
        state.visuals().tooltip = Some(tooltip);
    }
    Ok(())
}

fn build_tooltip(snapshot: &TraySnapshot) -> String {
    let mut parts: Vec<String> = Vec::new();

    if !snapshot.active_jobs.is_empty() {
        let count = snapshot.active_jobs.len().to_string();
        parts.push(if snapshot.active_jobs.len() > 1 {
            rclone_manager_core::t!("tray.tooltipTasks", "count" => &count)
        } else {
            rclone_manager_core::t!("tray.tooltipTask")
        });
    }

    if !snapshot.mounted_remotes.is_empty() {
        let count = snapshot.mounted_remotes.len().to_string();
        parts.push(if snapshot.mounted_remotes.len() > 1 {
            rclone_manager_core::t!("tray.tooltipMounts", "count" => &count)
        } else {
            rclone_manager_core::t!("tray.tooltipMount")
        });
    }

    if !snapshot.active_serves.is_empty() {
        let count = snapshot.active_serves.len().to_string();
        parts.push(if snapshot.active_serves.len() > 1 {
            rclone_manager_core::t!("tray.tooltipServes", "count" => &count)
        } else {
            rclone_manager_core::t!("tray.tooltipServe")
        });
    }

    if parts.is_empty() {
        rclone_manager_core::t!("tray.tooltipDefault")
    } else {
        format!(
            "{} — {}",
            rclone_manager_core::t!("tray.tooltipDefault"),
            parts.join(" · ")
        )
    }
}

#[cfg(all(test, feature = "tauri-test"))]
mod tests {
    use super::*;
    use tauri::test::mock_builder;

    #[tokio::test]
    async fn interface_lock_hides_tray_data_before_the_storage_key_is_dropped() {
        use crate::services::settings::access::VaultAccess;
        use std::sync::Arc;

        let directory = tempfile::tempdir().unwrap();
        let manager = rcman::SettingsManager::builder("native-vault-test", "1")
            .with_config_dir(directory.path())
            .with_schema::<crate::services::settings::schema::AppSettings>()
            .build()
            .unwrap();
        let access = Arc::new(VaultAccess::new(directory.path(), &manager).unwrap());
        let backend = rclone_manager_core::context::AppHandle::default();
        backend.manage(manager);
        backend.manage(access.clone());
        access.lock();
        let app = mock_builder()
            .manage(backend)
            .build(tauri::generate_context!())
            .unwrap();
        let manager = app.backend_state::<AppSettingsManager>();
        assert!(!manager.is_locked());

        let state = TrayMenuState::default();
        let (plan, tooltip, _) = build_tray_visuals(app.handle(), &state, &manager)
            .await
            .unwrap();
        assert_eq!(plan, MenuPlan::locked());
        assert_eq!(tooltip, rclone_manager_core::t!("tray.tooltipDefault"));
    }

    #[tokio::test]
    async fn concurrent_updates_without_a_tray_need_no_backend_state() {
        let app = mock_builder().build(tauri::generate_context!()).unwrap();
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
