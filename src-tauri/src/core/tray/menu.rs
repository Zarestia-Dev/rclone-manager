use crate::core::settings::AppSettingsManager;
use tauri::{
    AppHandle, Manager, Runtime,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
};

use crate::t;

use super::tray_action::TrayAction;
use super::{TrayProfileSummary, TraySnapshot};

/// Configuration for creating a profile-based submenu.
struct ProfileSubmenuConfig {
    label_key: &'static str,
    start_label_key: &'static str,
    stop_label_key: &'static str,
}

/// Build a generic submenu for profile-based operations (mount, sync, serve, etc.).
fn create_profile_submenu<R: Runtime, F1, F2>(
    handle: &AppHandle<R>,
    remote: &str,
    profiles: &[TrayProfileSummary],
    config: ProfileSubmenuConfig,
    start_action: F1,
    stop_action: F2,
) -> tauri::Result<Submenu<R>>
where
    F1: Fn(String, String) -> TrayAction,
    F2: Fn(String, String) -> TrayAction,
{
    let items = profiles
        .iter()
        .map(|p| {
            let action = if p.is_active {
                stop_action(remote.to_string(), p.name.clone())
            } else {
                start_action(remote.to_string(), p.name.clone())
            };
            let label = if p.is_active {
                format!("● {} ▸ {}", p.name, t!(config.stop_label_key))
            } else {
                format!("  {} ▸ {}", p.name, t!(config.start_label_key))
            };
            MenuItem::with_id(handle, action.to_id(), label, true, None::<&str>)
                .map(|i| Box::new(i) as Box<dyn tauri::menu::IsMenuItem<R>>)
        })
        .collect::<tauri::Result<Vec<_>>>()?;

    let active = profiles.iter().filter(|p| p.is_active).count();
    let label = t!(config.label_key, "active" => &active.to_string(), "total" => &profiles.len().to_string());
    submenu_from_items(handle, label, !profiles.is_empty(), &items)
}

/// Thin wrapper to avoid repeating the `.iter().map(AsRef::as_ref).collect()` pattern.
fn submenu_from_items<R: Runtime>(
    handle: &AppHandle<R>,
    label: impl AsRef<str>,
    enabled: bool,
    items: &[Box<dyn tauri::menu::IsMenuItem<R>>],
) -> tauri::Result<Submenu<R>> {
    let refs: Vec<&dyn tauri::menu::IsMenuItem<R>> =
        items.iter().map(std::convert::AsRef::as_ref).collect();
    Submenu::with_items(handle, label, enabled, &refs)
}

pub fn create_tray_menu<R: Runtime>(
    app: &AppHandle<R>,
    snapshot: &TraySnapshot,
) -> tauri::Result<Menu<R>> {
    let settings_manager = app.state::<AppSettingsManager>();
    let settings = settings_manager
        .get_all()
        .map_err(|e| tauri::Error::Io(std::io::Error::other(e.to_string())))?;
    let max_tray_items = settings.core.max_tray_items;

    let separator = PredefinedMenuItem::separator(app)?;

    #[cfg(not(feature = "web-server"))]
    let show_app_item = MenuItem::with_id(
        app,
        TrayAction::ShowApp.to_id(),
        t!("tray.showApp"),
        true,
        None::<&str>,
    )?;

    #[cfg(feature = "web-server")]
    let open_web_ui_item = MenuItem::with_id(
        app,
        TrayAction::OpenWebUI.to_id(),
        t!("tray.openWebUI"),
        true,
        None::<&str>,
    )?;

    let open_file_browser_item = MenuItem::with_id(
        app,
        TrayAction::OpenFileBrowser.to_id(),
        t!("tray.openFileBrowser"),
        true,
        None::<&str>,
    )?;
    let unmount_all_item = MenuItem::with_id(
        app,
        TrayAction::UnmountAll.to_id(),
        t!("tray.unmountAll"),
        true,
        None::<&str>,
    )?;
    let stop_all_jobs_item = MenuItem::with_id(
        app,
        TrayAction::StopAllJobs.to_id(),
        t!("tray.stopAllJobs"),
        true,
        None::<&str>,
    )?;
    let stop_all_serves_item = MenuItem::with_id(
        app,
        TrayAction::StopAllServes.to_id(),
        t!("tray.stopAllServes"),
        true,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(
        app,
        TrayAction::Quit.to_id(),
        t!("tray.quit"),
        true,
        None::<&str>,
    )?;

    let mut remote_menus: Vec<Submenu<R>> = vec![];

    for remote_summary in snapshot
        .remotes
        .iter()
        .filter(|r| r.show_on_tray)
        .take(max_tray_items)
    {
        let remote = &remote_summary.name;
        let mut submenu_items: Vec<Box<dyn tauri::menu::IsMenuItem<R>>> = vec![];

        let active_jobs_count = snapshot
            .active_jobs
            .iter()
            .filter(|j| j.remote_name == *remote)
            .count();

        let total_job_profiles = remote_summary.sync_profiles.len()
            + remote_summary.copy_profiles.len()
            + remote_summary.move_profiles.len()
            + remote_summary.bisync_profiles.len();

        let job_status_text = if total_job_profiles > 0 {
            t!("tray.jobsCount", "active" => &active_jobs_count.to_string(), "total" => &total_job_profiles.to_string())
        } else {
            t!("tray.jobsNone")
        };

        submenu_items.push(Box::new(CheckMenuItem::with_id(
            app,
            format!("status__{remote}"),
            job_status_text,
            false,
            active_jobs_count > 0,
            None::<&str>,
        )?));
        submenu_items.push(Box::new(PredefinedMenuItem::separator(app)?));

        for action in &remote_summary.primary_actions {
            let item: Box<dyn tauri::menu::IsMenuItem<R>> = match action.as_str() {
                "mount" => Box::new(create_profile_submenu(
                    app,
                    remote,
                    &remote_summary.mount_profiles,
                    ProfileSubmenuConfig {
                        label_key: "tray.mountCount",
                        start_label_key: "tray.mount",
                        stop_label_key: "tray.unmount",
                    },
                    TrayAction::MountProfile,
                    TrayAction::UnmountProfile,
                )?),
                "sync" => Box::new(create_profile_submenu(
                    app,
                    remote,
                    &remote_summary.sync_profiles,
                    ProfileSubmenuConfig {
                        label_key: "tray.syncCount",
                        start_label_key: "tray.start",
                        stop_label_key: "tray.stop",
                    },
                    TrayAction::SyncProfile,
                    TrayAction::StopSyncProfile,
                )?),
                "copy" => Box::new(create_profile_submenu(
                    app,
                    remote,
                    &remote_summary.copy_profiles,
                    ProfileSubmenuConfig {
                        label_key: "tray.copyCount",
                        start_label_key: "tray.start",
                        stop_label_key: "tray.stop",
                    },
                    TrayAction::CopyProfile,
                    TrayAction::StopCopyProfile,
                )?),
                "move" => Box::new(create_profile_submenu(
                    app,
                    remote,
                    &remote_summary.move_profiles,
                    ProfileSubmenuConfig {
                        label_key: "tray.moveCount",
                        start_label_key: "tray.start",
                        stop_label_key: "tray.stop",
                    },
                    TrayAction::MoveProfile,
                    TrayAction::StopMoveProfile,
                )?),
                "bisync" => Box::new(create_profile_submenu(
                    app,
                    remote,
                    &remote_summary.bisync_profiles,
                    ProfileSubmenuConfig {
                        label_key: "tray.bisyncCount",
                        start_label_key: "tray.start",
                        stop_label_key: "tray.stop",
                    },
                    TrayAction::BisyncProfile,
                    TrayAction::StopBisyncProfile,
                )?),
                "serve" => Box::new(create_profile_submenu(
                    app,
                    remote,
                    &remote_summary.serve_profiles,
                    ProfileSubmenuConfig {
                        label_key: "tray.serveCount",
                        start_label_key: "tray.start",
                        stop_label_key: "tray.stop",
                    },
                    TrayAction::ServeProfile,
                    TrayAction::StopServeProfile,
                )?),
                _ => continue,
            };
            submenu_items.push(item);
        }

        submenu_items.push(Box::new(PredefinedMenuItem::separator(app)?));

        let is_mounted = remote_summary.mount_profiles.iter().any(|p| p.is_active);
        let is_serving = remote_summary.serve_profiles.iter().any(|p| p.is_active);

        let (browse_id, browse_label) = if is_mounted {
            (
                TrayAction::Browse(remote.clone()).to_id(),
                t!("tray.browse"),
            )
        } else {
            (
                TrayAction::BrowseInApp(remote.clone()).to_id(),
                t!("tray.browseInApp"),
            )
        };
        submenu_items.push(Box::new(MenuItem::with_id(
            app,
            browse_id,
            browse_label,
            true,
            None::<&str>,
        )?));

        // Truncate long remote names and append state indicators.
        let display_name = if remote.len() > 20 {
            format!("{}...", &remote[..17])
        } else {
            remote.clone()
        };
        let indicators = [
            is_mounted.then_some("🗃️"),
            (active_jobs_count > 0).then_some("🔄"),
            is_serving.then_some("📡"),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");

        let submenu_label = if indicators.is_empty() {
            display_name
        } else {
            format!("{display_name} {indicators}")
        };

        remote_menus.push(submenu_from_items(
            app,
            submenu_label,
            true,
            &submenu_items,
        )?);
    }

    let mut menu_items: Vec<&dyn tauri::menu::IsMenuItem<R>> = vec![];

    #[cfg(not(feature = "web-server"))]
    {
        menu_items.push(&show_app_item);
        menu_items.push(&open_file_browser_item);
        menu_items.push(&separator);
    }
    #[cfg(feature = "web-server")]
    {
        menu_items.push(&open_web_ui_item);
        menu_items.push(&open_file_browser_item);
        menu_items.push(&separator);
    }

    if !remote_menus.is_empty() {
        for sm in &remote_menus {
            menu_items.push(sm);
        }
        menu_items.push(&separator);
        menu_items.push(&unmount_all_item);
        menu_items.push(&stop_all_jobs_item);
        menu_items.push(&stop_all_serves_item);
        menu_items.push(&separator);
    }

    menu_items.push(&quit_item);
    Menu::with_items(app, &menu_items)
}
