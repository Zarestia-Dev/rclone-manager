use log::{error, warn};
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::{
    AppHandle, Manager, Runtime,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
};

use crate::{
    rclone::state::cache::{
        get_cached_mounted_remotes, get_cached_remotes, get_cached_serves, get_settings,
    },
    utils::types::all_types::{JobCache, ServeInstance},
};

use super::tray_action::TrayAction;

static OLD_MAX_TRAY_ITEMS: AtomicUsize = AtomicUsize::new(0);
const MAX_PRIMARY_ACTIONS: usize = 3;

#[derive(Debug, Clone, PartialEq)]
enum PrimaryActionType {
    Mount,
    Sync,
    Copy,
    Move,
    Bisync,
}
impl PrimaryActionType {
    fn from_string(s: &str) -> Option<Self> {
        match s {
            "mount" => Some(Self::Mount),
            "sync" => Some(Self::Sync),
            "copy" => Some(Self::Copy),
            "move" => Some(Self::Move),
            "bisync" => Some(Self::Bisync),
            _ => None,
        }
    }
    fn action_label(&self) -> &'static str {
        match self {
            Self::Mount => "Mount",
            Self::Sync => "Start Sync",
            Self::Copy => "Start Copy",
            Self::Move => "Start Move",
            Self::Bisync => "Start BiSync",
        }
    }
    fn stop_label(&self) -> &'static str {
        match self {
            Self::Mount => "Unmount",
            Self::Sync => "Stop Sync",
            Self::Copy => "Stop Copy",
            Self::Move => "Stop Move",
            Self::Bisync => "Stop BiSync",
        }
    }
    fn to_action(&self, remote: &str) -> TrayAction {
        match self {
            Self::Mount => TrayAction::Mount(remote.to_string()),
            Self::Sync => TrayAction::Sync(remote.to_string()),
            Self::Copy => TrayAction::Copy(remote.to_string()),
            Self::Move => TrayAction::Move(remote.to_string()),
            Self::Bisync => TrayAction::Bisync(remote.to_string()),
        }
    }
    fn to_stop_action(&self, remote: &str) -> TrayAction {
        match self {
            Self::Mount => TrayAction::Unmount(remote.to_string()),
            Self::Sync => TrayAction::StopSync(remote.to_string()),
            Self::Copy => TrayAction::StopCopy(remote.to_string()),
            Self::Move => TrayAction::StopMove(remote.to_string()),
            Self::Bisync => TrayAction::StopBisync(remote.to_string()),
        }
    }
    fn job_type_str(&self) -> Option<&'static str> {
        match self {
            Self::Sync => Some("sync"),
            Self::Copy => Some("copy"),
            Self::Move => Some("move"),
            Self::Bisync => Some("bisync"),
            Self::Mount => None,
        }
    }
}
fn get_primary_actions_for_remote(settings: &serde_json::Value) -> Vec<PrimaryActionType> {
    if let Some(actions_array) = settings.get("primaryActions").and_then(|v| v.as_array()) {
        let actions: Vec<PrimaryActionType> = actions_array
            .iter()
            .filter_map(|v| v.as_str())
            .filter_map(PrimaryActionType::from_string)
            .collect();
        if !actions.is_empty() {
            return actions;
        }
    }
    vec![
        PrimaryActionType::Mount,
        PrimaryActionType::Sync,
        PrimaryActionType::Bisync,
    ]
}

pub async fn create_tray_menu<R: Runtime>(
    app: &AppHandle<R>,
    max_tray_items: usize,
) -> tauri::Result<Menu<R>> {
    let max_tray_items = if max_tray_items == 0 {
        OLD_MAX_TRAY_ITEMS.load(Ordering::Relaxed)
    } else {
        OLD_MAX_TRAY_ITEMS.store(max_tray_items, Ordering::Relaxed);
        max_tray_items
    };

    let handle = app.clone();
    let separator = PredefinedMenuItem::separator(&handle)?;
    let show_app_item = MenuItem::with_id(&handle, "show_app", "Show App", true, None::<&str>)?;
    let show_nautilus_item = MenuItem::with_id(
        &handle,
        "show_nautilus",
        "Show Nautilus",
        true,
        None::<&str>,
    )?;

    let unmount_all_item =
        MenuItem::with_id(&handle, "unmount_all", "Unmount All", true, None::<&str>)?;
    let stop_all_jobs_item = MenuItem::with_id(
        &handle,
        "stop_all_jobs",
        "Stop All Jobs",
        true,
        None::<&str>,
    )?;
    let stop_all_serves_item = MenuItem::with_id(
        &handle,
        "stop_all_serves",
        "Stop All Serves",
        true,
        None::<&str>,
    )?;

    let quit_item = MenuItem::with_id(&handle, "quit", "Quit", true, None::<&str>)?;

    // --- Get state from app handle ---
    let job_cache = app.state::<JobCache>();

    let remotes = get_cached_remotes(app.state::<crate::utils::types::all_types::RemoteCache>())
        .await
        .unwrap_or_else(|err| {
            error!("Failed to fetch cached remotes: {err}");
            vec![]
        });
    let mounted_remotes =
        get_cached_mounted_remotes(app.state::<crate::utils::types::all_types::RemoteCache>())
            .await
            .unwrap_or_else(|err| {
                error!("Failed to fetch mounted remotes: {err}");
                vec![]
            });
    let all_serves = get_cached_serves(app.state::<crate::utils::types::all_types::RemoteCache>())
        .await
        .unwrap_or_else(|err| {
            error!("Failed to fetch cached serves: {err}");
            vec![]
        });
    // --- Use injected job_cache state ---
    let active_jobs = job_cache.get_active_jobs().await;

    let cached_settings = get_settings(app.state::<crate::utils::types::all_types::RemoteCache>())
        .await
        .unwrap_or_else(|_| {
            error!("Failed to fetch cached settings");
            serde_json::Value::Null
        });

    let remotes_to_show = remotes
        .iter()
        .filter(|&remote| {
            cached_settings
                .get(remote)
                .and_then(|s| s.get("showOnTray"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        })
        .take(max_tray_items);

    let mut remote_menus = vec![];
    for remote_str in remotes_to_show {
        let remote = remote_str.to_string();
        if let Some(settings) = cached_settings.get(&remote).cloned() {
            let is_mounted = mounted_remotes.iter().any(|mounted| {
                let remote_name = remote.trim_end_matches(':');
                let mounted_name = mounted.fs.trim_end_matches(':');
                mounted_name == remote_name || mounted_name.starts_with(&format!("{remote_name}:"))
            });
            // Filter out serve and mount jobs - they have their own status indicators
            let active_jobs_for_remote: Vec<_> = active_jobs
                .iter()
                .filter(|job| {
                    job.remote_name == remote && job.job_type != "serve" && job.job_type != "mount"
                })
                .collect();
            let remote_fs_prefix = format!("{}:", remote);
            let active_serves_for_remote: Vec<&ServeInstance> = all_serves
                .iter()
                .filter(|serve| {
                    let fs = serve.params["fs"].as_str().unwrap_or("");
                    fs.starts_with(&remote_fs_prefix) || fs == remote
                })
                .collect();

            // -- Build the submenu items for this remote --
            let mut submenu_items: Vec<Box<dyn tauri::menu::IsMenuItem<R>>> = vec![];

            // Add status indicators
            let mount_status = CheckMenuItem::with_id(
                &handle,
                format!("mount_status-{}", remote),
                if is_mounted { "Mounted" } else { "Not Mounted" },
                false,
                is_mounted,
                None::<&str>,
            )?;
            submenu_items.push(Box::new(mount_status));
            let job_status_text = if active_jobs_for_remote.is_empty() {
                "No active jobs".to_string()
            } else {
                let job_types: Vec<String> = active_jobs_for_remote
                    .iter()
                    .map(|job| job.job_type.clone())
                    .collect();
                format!("{} in progress", job_types.join(" & "))
            };
            let job_status = CheckMenuItem::with_id(
                &handle,
                format!("job_status-{}", remote),
                job_status_text,
                false,
                !active_jobs_for_remote.is_empty(),
                None::<&str>,
            )?;
            submenu_items.push(Box::new(job_status));
            let serve_status = CheckMenuItem::with_id(
                &handle,
                format!("serve_status-{}", remote),
                format!("{} active serves", active_serves_for_remote.len()),
                false,
                !active_serves_for_remote.is_empty(),
                None::<&str>,
            )?;
            submenu_items.push(Box::new(serve_status));
            submenu_items.push(Box::new(PredefinedMenuItem::separator(&handle)?));

            // Add primary action menu items
            let primary_actions = get_primary_actions_for_remote(&settings);
            for action in primary_actions.iter().take(MAX_PRIMARY_ACTIONS) {
                if let Some(job_type_str) = action.job_type_str() {
                    let has_active_job = active_jobs_for_remote
                        .iter()
                        .any(|j| j.job_type == job_type_str);
                    let item = if has_active_job {
                        let action_id = action.to_stop_action(&remote).to_id();
                        MenuItem::with_id(
                            &handle,
                            action_id,
                            action.stop_label(),
                            true,
                            None::<&str>,
                        )?
                    } else {
                        let action_id = action.to_action(&remote).to_id();
                        MenuItem::with_id(
                            &handle,
                            action_id,
                            action.action_label(),
                            true,
                            None::<&str>,
                        )?
                    };
                    submenu_items.push(Box::new(item));
                } else if *action == PrimaryActionType::Mount {
                    let item = if is_mounted {
                        let action_id = action.to_stop_action(&remote).to_id();
                        MenuItem::with_id(
                            &handle,
                            action_id,
                            action.stop_label(),
                            true,
                            None::<&str>,
                        )?
                    } else {
                        let action_id = action.to_action(&remote).to_id();
                        MenuItem::with_id(
                            &handle,
                            action_id,
                            action.action_label(),
                            true,
                            None::<&str>,
                        )?
                    };
                    submenu_items.push(Box::new(item));
                }
            }

            submenu_items.push(Box::new(PredefinedMenuItem::separator(&handle)?));

            let mut serve_submenu_items: Vec<Box<dyn tauri::menu::IsMenuItem<R>>> = vec![];
            let start_serve_id = TrayAction::Serve(remote.clone()).to_id();
            let start_serve_item =
                MenuItem::with_id(&handle, start_serve_id, "Start Serve", true, None::<&str>)?;
            serve_submenu_items.push(Box::new(start_serve_item));

            if !active_serves_for_remote.is_empty() {
                serve_submenu_items.push(Box::new(PredefinedMenuItem::separator(&handle)?));
                for serve in active_serves_for_remote.clone() {
                    let serve_type = serve.params["type"].as_str().unwrap_or("serve");
                    let stop_serve_id = TrayAction::StopServe(serve.id.clone()).to_id();
                    let item = MenuItem::with_id(
                        &handle,
                        stop_serve_id,
                        format!("Stop {} ({})", serve_type, serve.addr),
                        true,
                        None::<&str>,
                    )?;
                    serve_submenu_items.push(Box::new(item));
                }
            }
            let serve_submenu = Submenu::with_items(
                &handle,
                "Serves",
                true,
                &serve_submenu_items
                    .iter()
                    .map(|item| item.as_ref())
                    .collect::<Vec<_>>(),
            )?;
            submenu_items.push(Box::new(serve_submenu));

            let browse_id = TrayAction::Browse(remote.clone()).to_id();
            let browse_item =
                MenuItem::with_id(&handle, browse_id, "Browse", is_mounted, None::<&str>)?;
            submenu_items.push(Box::new(browse_item));

            let name = if remote.len() > 20 {
                format!("{}...", &remote[..17])
            } else {
                remote.clone()
            };

            let indicators = format!(
                "{}{}{}",
                if is_mounted { "🗃️ " } else { "" },
                if !active_jobs_for_remote.is_empty() {
                    "🔄 "
                } else {
                    ""
                },
                if !active_serves_for_remote.is_empty() {
                    "📡"
                } else {
                    ""
                }
            );

            let remote_submenu = Submenu::with_items(
                &handle,
                format!("{name} {indicators}").trim(),
                true,
                &submenu_items
                    .iter()
                    .map(|item| item.as_ref())
                    .collect::<Vec<_>>(),
            )?;
            remote_menus.push(remote_submenu);
        } else {
            warn!("No cached settings found for remote: {}", remote);
        }
    }

    // -- Assemble the final tray menu --
    let mut menu_items: Vec<&dyn tauri::menu::IsMenuItem<R>> =
        vec![&show_app_item, &show_nautilus_item, &separator];

    if !remote_menus.is_empty() {
        for submenu in &remote_menus {
            menu_items.push(submenu);
        }
        menu_items.push(&separator);
        menu_items.push(&unmount_all_item);
        menu_items.push(&stop_all_jobs_item);
        menu_items.push(&stop_all_serves_item);
        menu_items.push(&separator);
    }

    menu_items.push(&quit_item);
    Menu::with_items(&handle, &menu_items)
}
