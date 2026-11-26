//! The tray, shared by every host that shows one: what it shows, when it refreshes,
//! what its entries do, and the native icon itself ([`native`]). Hosts only run the
//! native calls on their UI thread and route menu clicks to [`actions::handle_menu_id`].
pub mod action;
pub mod actions;
pub mod icon;
pub mod menu;
pub mod native;
pub mod snapshot;

use crate::context::AppHandle;
use crate::services::settings::AppSettingsManager;
use icon::TrayIconKind;
use menu::MenuPlan;
use snapshot::TraySnapshot;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;

/// The menu, tooltip and icon the tray should show.
pub type TrayVisuals = (MenuPlan, String, TrayIconKind);

#[derive(Default, Clone, Debug, PartialEq)]
pub struct TrayVisualCache {
    pub plan: Option<MenuPlan>,
    pub tooltip: Option<String>,
    pub icon: Option<TrayIconKind>,
}

impl TrayVisualCache {
    /// Compare with the last successfully applied native visuals without committing changes.
    pub fn diff(
        &self,
        new_plan: &MenuPlan,
        new_tooltip: &str,
        new_icon: TrayIconKind,
    ) -> (bool, bool, bool) {
        (
            self.plan.as_ref() != Some(new_plan),
            self.tooltip.as_deref() != Some(new_tooltip),
            self.icon != Some(new_icon),
        )
    }
}

/// A host that can show a tray manages this before startup; on any other host the
/// tray functions do nothing.
#[derive(Default)]
pub struct TrayMenuState {
    visuals: Mutex<TrayVisualCache>,
    pub update_lock: tokio::sync::Mutex<()>,
    pub has_pending: AtomicBool,
    /// Native visibility stays available while vault-protected settings are locked.
    pub visible: AtomicBool,
    /// Latest visibility request, including while asynchronous setup is pending.
    pub requested_visible: AtomicBool,
    /// Whether the native tray exists. It lives on the UI thread; this is the
    /// answer for every other thread.
    pub built: AtomicBool,
}

impl TrayMenuState {
    /// What the native tray currently shows. It is plain data, so a lock poisoned by a
    /// panic elsewhere is still safe to use and must not take the tray down with it.
    pub fn visuals(&self) -> std::sync::MutexGuard<'_, TrayVisualCache> {
        self.visuals
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Whether the interface the tray opens is the web UI in a browser.
pub(crate) fn web_ui(app: &AppHandle) -> bool {
    app.product().mode == "headless"
}

fn locked_tray_visuals(app: &AppHandle, state: &TrayMenuState) -> TrayVisuals {
    let icon = state
        .visuals()
        .icon
        .unwrap_or(TrayIconKind::ColorNormal)
        .inactive();
    (
        MenuPlan::locked(web_ui(app)),
        crate::t!("tray.tooltipDefault"),
        icon,
    )
}

/// The plan, tooltip and icon the tray should show now.
pub async fn build_tray_visuals(app: &AppHandle) -> Result<TrayVisuals, String> {
    let state = app.state::<TrayMenuState>();
    if crate::services::settings::access::is_locked(app) {
        return Ok(locked_tray_visuals(app, &state));
    }

    let settings = app
        .state::<AppSettingsManager>()
        .get_all()
        .map_err(|e| e.to_string())?;

    let snapshot = TraySnapshot::fetch(app).await;
    if crate::services::settings::access::is_locked(app) {
        return Ok(locked_tray_visuals(app, &state));
    }

    Ok((
        MenuPlan::build(&snapshot, settings.core.max_tray_items, web_ui(app)),
        build_tooltip(&snapshot),
        TrayIconKind::resolve(
            !snapshot.active_jobs.is_empty(),
            &settings.general.tray_icon_theme,
            app.host().is_system_dark(),
        ),
    ))
}

/// Checked at delivery time: a queued update may outlive the unlocked session.
pub fn deliverable_visuals(
    app: &AppHandle,
    state: &TrayMenuState,
    visuals: TrayVisuals,
) -> TrayVisuals {
    if crate::services::settings::access::is_locked(app) {
        locked_tray_visuals(app, state)
    } else {
        visuals
    }
}

/// The tray translates its own texts without plural forms, so each count is a
/// `Label: {{count}}` text.
fn build_tooltip(snapshot: &TraySnapshot) -> String {
    let parts: Vec<String> = [
        ("tray.tooltipTasks", snapshot.active_jobs.len()),
        ("tray.tooltipMounts", snapshot.mounted_remotes.len()),
        ("tray.tooltipServes", snapshot.active_serves.len()),
    ]
    .into_iter()
    .filter(|(_, count)| *count > 0)
    .map(|(key, count)| crate::t!(key, "count" => count))
    .collect();

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
        let app = AppHandle::default();
        app.manage(manager);
        app.manage(access.clone());
        access.lock();
        app.manage(TrayMenuState::default());
        assert!(!app.state::<AppSettingsManager>().is_locked());

        let (plan, tooltip, _) = build_tray_visuals(&app).await.unwrap();
        assert_eq!(plan, MenuPlan::locked(false));
        assert_eq!(tooltip, crate::t!("tray.tooltipDefault"));
    }

    fn cached_visuals() -> TrayVisualCache {
        TrayVisualCache {
            plan: Some(MenuPlan { items: vec![] }),
            tooltip: Some("Tooltip".into()),
            icon: Some(TrayIconKind::ColorNormal),
        }
    }

    #[test]
    fn initial_visuals_require_all_native_updates() {
        let cache = TrayVisualCache::default();
        assert_eq!(
            cache.diff(
                &MenuPlan { items: vec![] },
                "Tooltip",
                TrayIconKind::ColorNormal
            ),
            (true, true, true)
        );
        assert_eq!(cache, TrayVisualCache::default());
    }

    #[test]
    fn unchanged_visuals_do_not_require_native_updates() {
        let cache = cached_visuals();
        assert_eq!(
            cache.diff(
                &MenuPlan { items: vec![] },
                "Tooltip",
                TrayIconKind::ColorNormal
            ),
            (false, false, false)
        );
    }

    #[test]
    fn failed_or_unapplied_plan_changes_remain_pending() {
        let cache = cached_visuals();
        let plan = MenuPlan {
            items: vec![menu::MenuItemKind::Separator],
        };
        for _ in 0..2 {
            assert_eq!(
                cache.diff(&plan, "Tooltip", TrayIconKind::ColorNormal),
                (true, false, false)
            );
        }
        assert_eq!(cache, cached_visuals());
    }

    #[test]
    fn tooltip_and_icon_changes_are_independent() {
        let cache = cached_visuals();
        let plan = MenuPlan { items: vec![] };
        assert_eq!(
            cache.diff(&plan, "Changed", TrayIconKind::ColorNormal),
            (false, true, false)
        );
        assert_eq!(
            cache.diff(&plan, "Tooltip", TrayIconKind::ColorActive),
            (false, false, true)
        );
    }
}
