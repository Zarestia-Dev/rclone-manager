use crate::core::settings::AppSettingsManager;
use tauri::{
    AppHandle, Manager, Runtime,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
};

use crate::t;

use super::tray_action::TrayAction;
use super::{TrayProfileSummary, TraySnapshot};

/// Build a submenu for a transfer-type operation (sync / copy / move / bisync).
fn create_job_submenu<R: Runtime>(
    handle: &AppHandle<R>,
    remote: &str,
    profiles: &[TrayProfileSummary],
    label_key: &str,
    start_action: impl Fn(String, String) -> TrayAction,
    stop_action: impl Fn(String, String) -> TrayAction,
) -> tauri::Result<Submenu<R>> {
    let items = profiles
        .iter()
        .map(|p| {
            let action = if p.is_active {
                stop_action(remote.to_string(), p.name.clone())
            } else {
                start_action(remote.to_string(), p.name.clone())
            };
            let label = if p.is_active {
                format!("● {} ▸ {}", p.name, t!("tray.stop"))
            } else {
                format!("  {} ▸ {}", p.name, t!("tray.start"))
            };
            MenuItem::with_id(handle, action.to_id(), label, true, None::<&str>)
                .map(|i| Box::new(i) as Box<dyn tauri::menu::IsMenuItem<R>>)
        })
        .collect::<tauri::Result<Vec<_>>>()?;

    let active = profiles.iter().filter(|p| p.is_active).count();
    let label =
        t!(label_key, "active" => &active.to_string(), "total" => &profiles.len().to_string());
    submenu_from_items(handle, label, !profiles.is_empty(), &items)
}

fn create_mount_submenu<R: Runtime>(
    handle: &AppHandle<R>,
    remote: &str,
    profiles: &[TrayProfileSummary],
) -> tauri::Result<Submenu<R>> {
    let items = profiles
        .iter()
        .map(|p| {
            let action = if p.is_active {
                TrayAction::UnmountProfile(remote.to_string(), p.name.clone())
            } else {
                TrayAction::MountProfile(remote.to_string(), p.name.clone())
            };
            let label = if p.is_active {
                format!("● {} ▸ {}", p.name, t!("tray.unmount"))
            } else {
                format!("  {} ▸ {}", p.name, t!("tray.mount"))
            };
            MenuItem::with_id(handle, action.to_id(), label, true, None::<&str>)
                .map(|i| Box::new(i) as Box<dyn tauri::menu::IsMenuItem<R>>)
        })
        .collect::<tauri::Result<Vec<_>>>()?;

    let active = profiles.iter().filter(|p| p.is_active).count();
    let label = t!("tray.mountCount", "active" => &active.to_string(), "total" => &profiles.len().to_string());
    submenu_from_items(handle, label, !profiles.is_empty(), &items)
}

fn create_serve_submenu<R: Runtime>(
    handle: &AppHandle<R>,
    remote: &str,
    profiles: &[TrayProfileSummary],
) -> tauri::Result<Submenu<R>> {
    let items = profiles
        .iter()
        .map(|p| {
            let action = if p.is_active {
                TrayAction::StopServeProfile(remote.to_string(), p.name.clone())
            } else {
                TrayAction::ServeProfile(remote.to_string(), p.name.clone())
            };
            let label = if p.is_active {
                format!("● {} ▸ {}", p.name, t!("tray.stop"))
            } else {
                format!("  {} ▸ {}", p.name, t!("tray.start"))
            };
            MenuItem::with_id(handle, action.to_id(), label, true, None::<&str>)
                .map(|i| Box::new(i) as Box<dyn tauri::menu::IsMenuItem<R>>)
        })
        .collect::<tauri::Result<Vec<_>>>()?;

    let active = profiles.iter().filter(|p| p.is_active).count();
    let label = t!("tray.serveCount", "active" => &active.to_string(), "total" => &profiles.len().to_string());
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

pub async fn create_tray_menu<R: Runtime>(
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
    let show_app_item = MenuItem::with_id(app, "show_app", t!("tray.showApp"), true, None::<&str>)?;

    #[cfg(feature = "web-server")]
    let open_web_ui_item =
        MenuItem::with_id(app, "open_web_ui", t!("tray.openWebUI"), true, None::<&str>)?;

    let open_file_browser_item = MenuItem::with_id(
        app,
        TrayAction::OpenFileBrowser.to_id(),
        t!("tray.openFileBrowser"),
        true,
        None::<&str>,
    )?;
    let unmount_all_item = MenuItem::with_id(
        app,
        "unmount_all",
        t!("tray.unmountAll"),
        true,
        None::<&str>,
    )?;
    let stop_all_jobs_item = MenuItem::with_id(
        app,
        "stop_all_jobs",
        t!("tray.stopAllJobs"),
        true,
        None::<&str>,
    )?;
    let stop_all_serves_item = MenuItem::with_id(
        app,
        "stop_all_serves",
        t!("tray.stopAllServes"),
        true,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(app, "quit", t!("tray.quit"), true, None::<&str>)?;

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
                "mount" => Box::new(create_mount_submenu(
                    app,
                    remote,
                    &remote_summary.mount_profiles,
                )?),
                "sync" => Box::new(create_job_submenu(
                    app,
                    remote,
                    &remote_summary.sync_profiles,
                    "tray.syncCount",
                    TrayAction::SyncProfile,
                    TrayAction::StopSyncProfile,
                )?),
                "copy" => Box::new(create_job_submenu(
                    app,
                    remote,
                    &remote_summary.copy_profiles,
                    "tray.copyCount",
                    TrayAction::CopyProfile,
                    TrayAction::StopCopyProfile,
                )?),
                "move" => Box::new(create_job_submenu(
                    app,
                    remote,
                    &remote_summary.move_profiles,
                    "tray.moveCount",
                    TrayAction::MoveProfile,
                    TrayAction::StopMoveProfile,
                )?),
                "bisync" => Box::new(create_job_submenu(
                    app,
                    remote,
                    &remote_summary.bisync_profiles,
                    "tray.bisyncCount",
                    TrayAction::BisyncProfile,
                    TrayAction::StopBisyncProfile,
                )?),
                "serve" => Box::new(create_serve_submenu(
                    app,
                    remote,
                    &remote_summary.serve_profiles,
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
