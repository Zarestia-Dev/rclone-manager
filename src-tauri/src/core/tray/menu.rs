use crate::core::settings::AppSettingsManager;
use log::{error, warn};
use tauri::{
    AppHandle, Manager, Runtime,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
};

use crate::{
    rclone::state::cache::{
        get_cached_mounted_remotes, get_cached_remotes, get_cached_serves, get_settings,
    },
    t,
    utils::types::{
        jobs::{JobInfo, JobType},
        remotes::{MountedRemote, ServeInstance},
    },
};

use super::tray_action::TrayAction;

/// Job operation types for generic submenu handling
#[derive(Debug, Clone, Copy)]
enum JobOperationType {
    Sync,
    Copy,
    Move,
    Bisync,
}

impl JobOperationType {
    fn config_key(&self) -> &'static str {
        match self {
            Self::Sync => "syncConfigs",
            Self::Copy => "copyConfigs",
            Self::Move => "moveConfigs",
            Self::Bisync => "bisyncConfigs",
        }
    }

    fn job_type(&self) -> JobType {
        match self {
            Self::Sync => JobType::Sync,
            Self::Copy => JobType::Copy,
            Self::Move => JobType::Move,
            Self::Bisync => JobType::Bisync,
        }
    }

    fn tray_label_key(&self) -> &'static str {
        match self {
            Self::Sync => "tray.syncCount",
            Self::Copy => "tray.copyCount",
            Self::Move => "tray.moveCount",
            Self::Bisync => "tray.bisyncCount",
        }
    }

    fn tray_actions(&self, remote: String, profile: String) -> (TrayAction, TrayAction) {
        match self {
            Self::Sync => (
                TrayAction::SyncProfile(remote.clone(), profile.clone()),
                TrayAction::StopSyncProfile(remote, profile),
            ),
            Self::Copy => (
                TrayAction::CopyProfile(remote.clone(), profile.clone()),
                TrayAction::StopCopyProfile(remote, profile),
            ),
            Self::Move => (
                TrayAction::MoveProfile(remote.clone(), profile.clone()),
                TrayAction::StopMoveProfile(remote, profile),
            ),
            Self::Bisync => (
                TrayAction::BisyncProfile(remote.clone(), profile.clone()),
                TrayAction::StopBisyncProfile(remote, profile),
            ),
        }
    }
}

/// Generic helper to create submenu for job operations (sync/copy/move/bisync)
fn create_job_submenu<R: Runtime>(
    handle: &AppHandle<R>,
    remote: &str,
    settings: &serde_json::Value,
    active_jobs: &[JobInfo],
    operation: JobOperationType,
) -> tauri::Result<Submenu<R>> {
    let config_key = operation.config_key();
    let job_type = operation.job_type();

    let configs = settings
        .get(config_key)
        .and_then(|v| v.as_object())
        .filter(|configs| !configs.is_empty());

    let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<R>>> = vec![];

    if let Some(configs) = configs {
        for (profile_name, _config) in configs {
            let is_running = active_jobs.iter().any(|job| {
                job.remote_name == remote
                    && job.job_type == job_type
                    && job.profile.as_ref() == Some(profile_name)
            });

            let (start_action, stop_action) =
                operation.tray_actions(remote.to_string(), profile_name.clone());

            let (action_id, label) = if is_running {
                (
                    stop_action.to_id(),
                    format!("● {} ▸ {}", profile_name, t!("tray.stop")),
                )
            } else {
                (
                    start_action.to_id(),
                    format!("  {} ▸ {}", profile_name, t!("tray.start")),
                )
            };

            let item = MenuItem::with_id(handle, action_id, label, true, None::<&str>)?;
            items.push(Box::new(item));
        }
    } else {
        // No profiles configured - show default option
        let (start_action, _) = operation.tray_actions(remote.to_string(), "default".to_string());
        let default_label = format!("  {} ▸ {}", t!("tray.defaultProfile"), t!("tray.start"));
        let item = MenuItem::with_id(
            handle,
            start_action.to_id(),
            default_label,
            true,
            None::<&str>,
        )?;
        items.push(Box::new(item));
    }

    let profile_count = configs.map(|c| c.len()).unwrap_or(1);
    let active_count = active_jobs
        .iter()
        .filter(|job| job.remote_name == remote && job.job_type == job_type)
        .count();

    let submenu_label = t!(
        operation.tray_label_key(),
        "active" => &active_count.to_string(),
        "total" => &profile_count.to_string()
    );

    Submenu::with_items(
        handle,
        submenu_label,
        true,
        &items.iter().map(|item| item.as_ref()).collect::<Vec<_>>(),
    )
}

/// Helper to create a submenu for mount profiles
fn create_mount_submenu<R: Runtime>(
    handle: &AppHandle<R>,
    remote: &str,
    settings: &serde_json::Value,
    mounted_remotes: &[MountedRemote],
    active_count: usize,
) -> tauri::Result<Submenu<R>> {
    let mount_configs = settings
        .get("mountConfigs")
        .and_then(|v| v.as_object())
        .filter(|configs| !configs.is_empty());

    let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<R>>> = vec![];

    if let Some(configs) = mount_configs {
        // Show configured profiles
        for (profile_name, config) in configs {
            let mount_point = config.get("dest").and_then(|v| v.as_str()).unwrap_or("");

            // Check if this specific mount profile is mounted
            let is_mounted = mounted_remotes.iter().any(|mounted| {
                mounted.mount_point == mount_point
                    && mounted.profile.as_deref() == Some(profile_name)
            });

            let (action_id, label) = if is_mounted {
                (
                    TrayAction::UnmountProfile(remote.to_string(), profile_name.clone()).to_id(),
                    format!("● {} ▸ {}", profile_name, t!("tray.unmount")),
                )
            } else {
                (
                    TrayAction::MountProfile(remote.to_string(), profile_name.clone()).to_id(),
                    format!("  {} ▸ {}", profile_name, t!("tray.mount")),
                )
            };

            let item = MenuItem::with_id(handle, action_id, label, true, None::<&str>)?;
            items.push(Box::new(item));
        }
    } else {
        // No profiles configured - show default option
        let action_id = TrayAction::MountProfile(remote.to_string(), "default".to_string()).to_id();
        let default_label = format!("  {} ▸ {}", t!("tray.defaultProfile"), t!("tray.mount"));
        let item = MenuItem::with_id(handle, action_id, default_label, true, None::<&str>)?;
        items.push(Box::new(item));
    }

    let profile_count = mount_configs.map(|c| c.len()).unwrap_or(1);

    let submenu_label = t!("tray.mountCount", "active" => &active_count.to_string(), "total" => &profile_count.to_string());
    let submenu = Submenu::with_items(
        handle,
        submenu_label,
        true,
        &items.iter().map(|item| item.as_ref()).collect::<Vec<_>>(),
    )?;

    Ok(submenu)
}

/// Helper to create a submenu for serve profiles
fn create_serve_submenu<R: Runtime>(
    handle: &AppHandle<R>,
    remote: &str,
    settings: &serde_json::Value,
    all_serves: &[ServeInstance],
    active_count: usize,
) -> tauri::Result<Submenu<R>> {
    let serve_configs = settings
        .get("serveConfigs")
        .and_then(|v| v.as_object())
        .filter(|configs| !configs.is_empty());

    let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<R>>> = vec![];
    let remote_fs_prefix = format!("{}:", remote);

    if let Some(configs) = serve_configs {
        for (profile_name, _config) in configs {
            // Check if this profile has an active serve
            // Match by profile name in the serve's metadata
            let active_serve = all_serves.iter().find(|serve| {
                let fs = serve.params["fs"].as_str().unwrap_or("");
                let serve_profile = serve.profile.as_deref().unwrap_or("");

                (fs.starts_with(&remote_fs_prefix) || fs == remote) && serve_profile == profile_name
            });

            let (action_id, label) = if let Some(serve) = active_serve {
                let serve_type = serve.params["type"].as_str().unwrap_or("serve");
                (
                    TrayAction::StopServeProfile(remote.to_string(), serve.id.clone()).to_id(),
                    format!("● {} ({}) ▸ {}", profile_name, serve_type, t!("tray.stop")),
                )
            } else {
                (
                    TrayAction::ServeProfile(remote.to_string(), profile_name.clone()).to_id(),
                    format!("  {} ▸ {}", profile_name, t!("tray.start")),
                )
            };

            let item = MenuItem::with_id(handle, action_id, label, true, None::<&str>)?;
            items.push(Box::new(item));
        }
    } else {
        let action_id = TrayAction::ServeProfile(remote.to_string(), "default".to_string()).to_id();
        let default_label = format!("  {} ▸ {}", t!("tray.defaultProfile"), t!("tray.start"));
        let item = MenuItem::with_id(handle, action_id, default_label, true, None::<&str>)?;
        items.push(Box::new(item));
    }

    let profile_count = serve_configs.map(|c| c.len()).unwrap_or(1);

    let submenu_label = t!("tray.serveCount", "active" => &active_count.to_string(), "total" => &profile_count.to_string());
    let submenu = Submenu::with_items(
        handle,
        submenu_label,
        true,
        &items.iter().map(|item| item.as_ref()).collect::<Vec<_>>(),
    )?;

    Ok(submenu)
}

pub async fn create_tray_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    // Read max_tray_items from settings
    let max_tray_items = app
        .state::<AppSettingsManager>()
        .get_value("core.max_tray_items")
        .ok()
        .and_then(|v| v.as_u64())
        .unwrap_or(5) as usize;

    let handle = app.clone();
    let separator = PredefinedMenuItem::separator(&handle)?;
    #[cfg(not(feature = "web-server"))]
    let show_app_item =
        MenuItem::with_id(&handle, "show_app", t!("tray.showApp"), true, None::<&str>)?;

    #[cfg(feature = "web-server")]
    let open_web_ui_item = MenuItem::with_id(
        &handle,
        "open_web_ui",
        t!("tray.openWebUI"),
        true,
        None::<&str>,
    )?;

    let unmount_all_item = MenuItem::with_id(
        &handle,
        "unmount_all",
        t!("tray.unmountAll"),
        true,
        None::<&str>,
    )?;
    let stop_all_jobs_item = MenuItem::with_id(
        &handle,
        "stop_all_jobs",
        t!("tray.stopAllJobs"),
        true,
        None::<&str>,
    )?;
    let stop_all_serves_item = MenuItem::with_id(
        &handle,
        "stop_all_serves",
        t!("tray.stopAllServes"),
        true,
        None::<&str>,
    )?;

    let quit_item = MenuItem::with_id(&handle, "quit", t!("tray.quit"), true, None::<&str>)?;

    // --- Get state from app handle ---

    let remotes = get_cached_remotes(app.clone()).await.unwrap_or_else(|err| {
        error!("Failed to fetch cached remotes: {err}");
        vec![]
    });
    let mounted_remotes = get_cached_mounted_remotes(app.clone())
        .await
        .unwrap_or_else(|err| {
            error!("Failed to fetch mounted remotes: {err}");
            vec![]
        });
    let all_serves = get_cached_serves(app.clone()).await.unwrap_or_else(|err| {
        error!("Failed to fetch cached serves: {err}");
        vec![]
    });

    use crate::rclone::backend::BackendManager;
    let backend_manager = app.state::<BackendManager>();
    let active_jobs = backend_manager.job_cache.get_active_jobs().await;

    let cached_settings = get_settings(app.clone(), app.state::<AppSettingsManager>())
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
            // Count profiles for this remote (for job aggregation)
            let sync_count = settings
                .get("syncConfigs")
                .and_then(|v| v.as_object())
                .map(|a| a.len())
                .unwrap_or(0);
            let copy_count = settings
                .get("copyConfigs")
                .and_then(|v| v.as_object())
                .map(|a| a.len())
                .unwrap_or(0);
            let move_count = settings
                .get("moveConfigs")
                .and_then(|v| v.as_object())
                .map(|a| a.len())
                .unwrap_or(0);
            let bisync_count = settings
                .get("bisyncConfigs")
                .and_then(|v| v.as_object())
                .map(|a| a.len())
                .unwrap_or(0);

            // Count active mounts for this remote
            let active_mount_count = mounted_remotes
                .iter()
                .filter(|mounted| {
                    let remote_name = remote.trim_end_matches(':');
                    let mounted_name = mounted.fs.trim_end_matches(':');
                    mounted_name == remote_name
                        || mounted_name.starts_with(&format!("{remote_name}:"))
                })
                .count();

            // Filter active jobs for this remote (exclude meta jobs, mount, and serve)
            let active_jobs_for_remote: Vec<_> = active_jobs
                .iter()
                .filter(|job| {
                    let is_meta = matches!(
                        job.job_type,
                        JobType::List
                            | JobType::Info
                            | JobType::About
                            | JobType::Size
                            | JobType::Stat
                            | JobType::Hash
                    );
                    job.remote_name == remote
                        && !is_meta
                        && job.job_type != JobType::Serve
                        && job.job_type != JobType::Mount
                })
                .collect();

            let total_job_profiles = sync_count + copy_count + move_count + bisync_count;

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

            // Add job status indicator (aggregates sync, copy, move, bisync)
            let job_status_text = if total_job_profiles > 0 {
                t!("tray.jobsCount", "active" => &active_jobs_for_remote.len().to_string(), "total" => &total_job_profiles.to_string())
            } else {
                t!("tray.jobsNone")
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

            // Get primary actions for this remote (default to all if not set)
            let primary_actions = settings
                .get("primaryActions")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect::<Vec<String>>()
                })
                .unwrap_or_else(|| {
                    // Default primary actions if not set
                    vec![
                        "mount".to_string(),
                        "sync".to_string(),
                        "bisync".to_string(),
                    ]
                });

            // Add operation-specific submenus based on primaryActions
            for action in &primary_actions {
                match action.as_str() {
                    "mount" => {
                        let mount_submenu = create_mount_submenu(
                            &handle,
                            &remote,
                            &settings,
                            &mounted_remotes,
                            active_mount_count,
                        )?;
                        submenu_items.push(Box::new(mount_submenu));
                    }
                    "sync" => {
                        let sync_submenu = create_job_submenu(
                            &handle,
                            &remote,
                            &settings,
                            &active_jobs,
                            JobOperationType::Sync,
                        )?;
                        submenu_items.push(Box::new(sync_submenu));
                    }
                    "copy" => {
                        let copy_submenu = create_job_submenu(
                            &handle,
                            &remote,
                            &settings,
                            &active_jobs,
                            JobOperationType::Copy,
                        )?;
                        submenu_items.push(Box::new(copy_submenu));
                    }
                    "move" => {
                        let move_submenu = create_job_submenu(
                            &handle,
                            &remote,
                            &settings,
                            &active_jobs,
                            JobOperationType::Move,
                        )?;
                        submenu_items.push(Box::new(move_submenu));
                    }
                    "bisync" => {
                        let bisync_submenu = create_job_submenu(
                            &handle,
                            &remote,
                            &settings,
                            &active_jobs,
                            JobOperationType::Bisync,
                        )?;
                        submenu_items.push(Box::new(bisync_submenu));
                    }
                    "serve" => {
                        let serve_submenu = create_serve_submenu(
                            &handle,
                            &remote,
                            &settings,
                            &all_serves,
                            active_serves_for_remote.len(),
                        )?;
                        submenu_items.push(Box::new(serve_submenu));
                    }
                    _ => {} // Ignore unknown action types
                }
            }

            submenu_items.push(Box::new(PredefinedMenuItem::separator(&handle)?));

            // Show appropriate browse option based on mount status
            if active_mount_count > 0 {
                // Mounted: show "Browse" to open in native file manager
                let browse_id = TrayAction::Browse(remote.clone()).to_id();
                let browse_item =
                    MenuItem::with_id(&handle, browse_id, t!("tray.browse"), true, None::<&str>)?;
                submenu_items.push(Box::new(browse_item));
            } else {
                // Not mounted: show "Browse (In App)" to open in-app file browser
                #[cfg(not(feature = "web-server"))]
                {
                    let browse_in_app_id = TrayAction::BrowseInApp(remote.clone()).to_id();
                    let browse_in_app_item = MenuItem::with_id(
                        &handle,
                        browse_in_app_id,
                        t!("tray.browseInApp"),
                        true,
                        None::<&str>,
                    )?;
                    submenu_items.push(Box::new(browse_in_app_item));
                }
            }

            let name = if remote.len() > 20 {
                format!("{}...", &remote[..17])
            } else {
                remote.clone()
            };

            let indicators = format!(
                "{}{}{}",
                if active_mount_count > 0 {
                    "🗃️ "
                } else {
                    ""
                },
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
    let mut menu_items: Vec<&dyn tauri::menu::IsMenuItem<R>> = vec![];

    #[cfg(not(feature = "web-server"))]
    {
        menu_items.push(&show_app_item);
        menu_items.push(&separator);
    }
    #[cfg(feature = "web-server")]
    {
        menu_items.push(&open_web_ui_item);
        menu_items.push(&separator);
    }

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
