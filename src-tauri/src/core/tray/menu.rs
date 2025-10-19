use log::{error, warn};
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::{
    AppHandle, Runtime,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
};

use crate::rclone::state::{
    JOB_CACHE, get_cached_mounted_remotes, get_cached_remotes, get_settings,
};

static OLD_MAX_TRAY_ITEMS: AtomicUsize = AtomicUsize::new(0);
const MAX_PRIMARY_ACTIONS: usize = 3;

/// Represents available primary action types for tray menu
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

    fn to_menu_id(&self, remote: &str) -> String {
        format!("{}-{}", self.job_type_str().unwrap_or("mount"), remote)
    }

    fn to_stop_menu_id(&self, remote: &str) -> String {
        let action = match self {
            Self::Mount => "unmount".to_string(),
            _ => self
                .job_type_str()
                .map_or_else(|| "".to_string(), |s| format!("stop_{}", s)),
        };
        format!("{}-{}", action, remote)
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

/// Get primary actions for a remote from settings, with defaults fallback
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

    // Default primary actions if none are configured
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
    let unmount_all_item =
        MenuItem::with_id(&handle, "unmount_all", "Unmount All", true, None::<&str>)?;
    let stop_all_jobs_item = MenuItem::with_id(
        &handle,
        "stop_all_jobs",
        "Stop All Jobs",
        true,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(&handle, "quit", "Quit", true, None::<&str>)?;

    let remotes = get_cached_remotes().await.unwrap_or_else(|err| {
        error!("Failed to fetch cached remotes: {err}");
        vec![]
    });

    let mounted_remotes = get_cached_mounted_remotes().await.unwrap_or_else(|err| {
        error!("Failed to fetch mounted remotes: {err}");
        vec![]
    });

    let active_jobs = JOB_CACHE.get_active_jobs().await;

    let mut remote_menus = vec![];

    let cached_settings = get_settings().await.unwrap_or_else(|_| {
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

    for remote_str in remotes_to_show {
        let remote = remote_str.to_string();
        if let Some(settings) = cached_settings.get(&remote).cloned() {
            // Check mount status by comparing the remote name against mounted fs paths
            let is_mounted = mounted_remotes.iter().any(|mounted| {
                let remote_name = remote.trim_end_matches(':');
                let mounted_name = mounted.fs.trim_end_matches(':');
                mounted_name == remote_name || mounted_name.starts_with(&format!("{remote_name}:"))
            });

            let active_jobs_for_remote: Vec<_> = active_jobs
                .iter()
                .filter(|job| job.remote_name == remote)
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
            submenu_items.push(Box::new(PredefinedMenuItem::separator(&handle)?));

            // Add primary action menu items
            let primary_actions = get_primary_actions_for_remote(&settings);
            for action in primary_actions.iter().take(MAX_PRIMARY_ACTIONS) {
                if let Some(job_type_str) = action.job_type_str() {
                    let has_active_job = active_jobs_for_remote
                        .iter()
                        .any(|j| j.job_type == job_type_str);
                    let item = if has_active_job {
                        MenuItem::with_id(
                            &handle,
                            action.to_stop_menu_id(&remote),
                            action.stop_label(),
                            true,
                            None::<&str>,
                        )?
                    } else {
                        MenuItem::with_id(
                            &handle,
                            action.to_menu_id(&remote),
                            action.action_label(),
                            true,
                            None::<&str>,
                        )?
                    };
                    submenu_items.push(Box::new(item));
                } else if *action == PrimaryActionType::Mount {
                    let item = if is_mounted {
                        MenuItem::with_id(
                            &handle,
                            action.to_stop_menu_id(&remote),
                            action.stop_label(),
                            true,
                            None::<&str>,
                        )?
                    } else {
                        MenuItem::with_id(
                            &handle,
                            action.to_menu_id(&remote),
                            action.action_label(),
                            true,
                            None::<&str>,
                        )?
                    };
                    submenu_items.push(Box::new(item));
                }
            }

            submenu_items.push(Box::new(PredefinedMenuItem::separator(&handle)?));

            // Add common items (e.g., Browse)
            let browse_item = MenuItem::with_id(
                &handle,
                format!("browse-{}", remote),
                "Browse",
                is_mounted,
                None::<&str>,
            )?;
            submenu_items.push(Box::new(browse_item));

            // --- Submenu Creation (Now happens only ONCE per remote) ---
            let name = if remote.len() > 20 {
                format!("{}...", &remote[..17])
            } else {
                remote.clone()
            };

            let indicators = format!(
                "{}{}",
                if is_mounted { "🗃️ " } else { "" },
                if !active_jobs_for_remote.is_empty() {
                    "🔄"
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
    let mut menu_items: Vec<&dyn tauri::menu::IsMenuItem<R>> = vec![&show_app_item, &separator];

    if !remote_menus.is_empty() {
        for submenu in &remote_menus {
            menu_items.push(submenu);
        }
        menu_items.push(&separator);
        menu_items.push(&unmount_all_item);
        menu_items.push(&stop_all_jobs_item);
        menu_items.push(&separator);
    }

    menu_items.push(&quit_item);
    Menu::with_items(&handle, &menu_items)
}
