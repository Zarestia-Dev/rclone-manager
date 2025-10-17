use log::{error, warn};
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::{
    AppHandle,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
};

use crate::rclone::state::{
    JOB_CACHE, get_cached_mounted_remotes, get_cached_remotes, get_settings,
};

static OLD_MAX_TRAY_ITEMS: AtomicUsize = AtomicUsize::new(0);

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

    fn to_action_label(&self) -> &'static str {
        match self {
            Self::Mount => "Mount",
            Self::Sync => "Start Sync",
            Self::Copy => "Start Copy",
            Self::Move => "Start Move",
            Self::Bisync => "Start BiSync",
        }
    }

    fn to_stop_label(&self) -> &'static str {
        match self {
            Self::Mount => "Unmount",
            Self::Sync => "Stop Sync",
            Self::Copy => "Stop Copy",
            Self::Move => "Stop Move",
            Self::Bisync => "Stop BiSync",
        }
    }

    fn to_menu_id(&self, remote: &str) -> String {
        match self {
            Self::Mount => format!("mount-{}", remote),
            Self::Sync => format!("sync-{}", remote),
            Self::Copy => format!("copy-{}", remote),
            Self::Move => format!("move-{}", remote),
            Self::Bisync => format!("bisync-{}", remote),
        }
    }

    fn to_stop_menu_id(&self, remote: &str) -> String {
        match self {
            Self::Mount => format!("unmount-{}", remote),
            Self::Sync => format!("stop_sync-{}", remote),
            Self::Copy => format!("stop_copy-{}", remote),
            Self::Move => format!("stop_move-{}", remote),
            Self::Bisync => format!("stop_bisync-{}", remote),
        }
    }
}

/// Get primary actions for a remote from settings, with defaults fallback
fn get_primary_actions_for_remote(settings: &serde_json::Value) -> Vec<PrimaryActionType> {
    // Try to get primary actions from settings
    if let Some(primary_actions) = settings.get("primaryActions")
        && let Some(actions_array) = primary_actions.as_array()
    {
        let mut actions = Vec::new();
        for action in actions_array {
            if let Some(action_str) = action.as_str()
                && let Some(action_type) = PrimaryActionType::from_string(action_str)
            {
                actions.push(action_type);
            }
        }
        if !actions.is_empty() {
            return actions;
        }
    }

    // Default primary actions if none configured: Mount + Sync + BiSync
    vec![
        PrimaryActionType::Mount,
        PrimaryActionType::Sync,
        PrimaryActionType::Bisync,
    ]
}

pub async fn create_tray_menu<R: tauri::Runtime>(
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

    let mounted_remotes = match get_cached_mounted_remotes().await {
        Ok(remotes) => remotes,
        Err(err) => {
            error!("Failed to fetch mounted remotes: {err}");
            vec![]
        }
    };

    let active_jobs = JOB_CACHE.get_active_jobs().await;

    let mut remote_menus = vec![];

    let cached_settings = get_settings().await.unwrap_or_else(|_| {
        error!("Failed to fetch cached settings");
        serde_json::Value::Null
    });

    for remote in remotes.iter().take(max_tray_items) {
        let settings = cached_settings.get(remote).cloned();

        if let Some(settings) = settings {
            if settings
                .get("showOnTray")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                // Check mount status
                let is_mounted = mounted_remotes.iter().any(|mounted| {
                    let remote_name = remote.trim_end_matches(':');
                    let mounted_name = mounted.fs.trim_end_matches(':');
                    mounted_name == remote_name
                        || mounted_name == remote
                        || mounted_name.starts_with(&format!("{remote_name}/"))
                        || mounted_name.starts_with(&format!("{remote_name}:"))
                });

                // Get primary actions for this remote
                let primary_actions = get_primary_actions_for_remote(&settings);

                // Create status indicators
                let active_jobs_for_remote: Vec<_> = active_jobs
                    .iter()
                    .filter(|job| job.remote_name == *remote)
                    .collect();

                let job_status = CheckMenuItem::with_id(
                    &handle,
                    format!("job_status-{remote}"),
                    if active_jobs_for_remote.is_empty() {
                        "No active jobs".to_string()
                    } else {
                        let job_types: Vec<String> = active_jobs_for_remote
                            .iter()
                            .map(|job| job.job_type.clone())
                            .collect();
                        format!("{} in progress", job_types.join(" & "))
                    },
                    false,
                    !active_jobs_for_remote.is_empty(),
                    None::<&str>,
                )?;

                let mount_status = CheckMenuItem::with_id(
                    &handle,
                    format!("mount_status-{remote}"),
                    if is_mounted { "Mounted" } else { "Not Mounted" },
                    false,
                    is_mounted,
                    None::<&str>,
                )?;

                let mut submenu_items: Vec<Box<dyn tauri::menu::IsMenuItem<R>>> =
                    vec![Box::new(mount_status), Box::new(job_status)];

                submenu_items.push(Box::new(PredefinedMenuItem::separator(&handle)?));

                // Add primary action menu items (max 3)
                for action in primary_actions.iter().take(3) {
                    match action {
                        PrimaryActionType::Mount => {
                            if is_mounted {
                                let unmount_item = MenuItem::with_id(
                                    &handle,
                                    action.to_stop_menu_id(remote),
                                    action.to_stop_label(),
                                    true,
                                    None::<&str>,
                                )?;
                                submenu_items.push(Box::new(unmount_item));
                            } else {
                                let mount_item = MenuItem::with_id(
                                    &handle,
                                    action.to_menu_id(remote),
                                    action.to_action_label(),
                                    true,
                                    None::<&str>,
                                )?;
                                submenu_items.push(Box::new(mount_item));
                            }
                        }
                        _ => {
                            // Check if this job type is active
                            let job_type_str = match action {
                                PrimaryActionType::Sync => "sync",
                                PrimaryActionType::Copy => "copy",
                                PrimaryActionType::Move => "move",
                                PrimaryActionType::Bisync => "bisync",
                                _ => continue,
                            };

                            let has_active_job = active_jobs_for_remote
                                .iter()
                                .any(|job| job.job_type == job_type_str);

                            if has_active_job {
                                let stop_item = MenuItem::with_id(
                                    &handle,
                                    action.to_stop_menu_id(remote),
                                    action.to_stop_label(),
                                    true,
                                    None::<&str>,
                                )?;
                                submenu_items.push(Box::new(stop_item));
                            } else {
                                let start_item = MenuItem::with_id(
                                    &handle,
                                    action.to_menu_id(remote),
                                    action.to_action_label(),
                                    true,
                                    None::<&str>,
                                )?;
                                submenu_items.push(Box::new(start_item));
                            }
                        }
                    }
                }

                submenu_items.push(Box::new(PredefinedMenuItem::separator(&handle)?));

                // Common items (browse and delete)
                let browse_item = MenuItem::with_id(
                    &handle,
                    format!("browse-{remote}"),
                    "Browse",
                    is_mounted,
                    None::<&str>,
                )?;
                submenu_items.push(Box::new(browse_item));

                let name = if remote.len() > 20 {
                    format!("{}...", &remote[..17])
                } else {
                    remote.clone()
                };

                // Create status indicators for the menu title
                let indicators = format!(
                    "{}{}",
                    if is_mounted { "🗃️" } else { "" },
                    if !active_jobs_for_remote.is_empty() {
                        "🔄"
                    } else {
                        ""
                    }
                );

                let remote_submenu = Submenu::with_items(
                    &handle,
                    format!("{name} {indicators}"),
                    true,
                    &submenu_items
                        .iter()
                        .map(|item| item.as_ref())
                        .collect::<Vec<_>>(),
                )?;

                remote_menus.push(remote_submenu);
            }
        } else {
            warn!("No cached settings found for remote: {remote}");
        }
    }

    let mut menu_items: Vec<&dyn tauri::menu::IsMenuItem<R>> = vec![&show_app_item, &separator];

    if !remote_menus.is_empty() {
        menu_items.extend(
            remote_menus
                .iter()
                .map(|submenu| submenu as &dyn tauri::menu::IsMenuItem<R>),
        );
        menu_items.push(&separator);
        menu_items.push(&unmount_all_item);
        menu_items.push(&stop_all_jobs_item);
        menu_items.push(&separator);
    }

    menu_items.push(&quit_item);

    Menu::with_items(&handle, &menu_items)
}
