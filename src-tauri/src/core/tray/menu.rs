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
    utils::types::all_types::ServeInstance,
};

use super::tray_action::TrayAction;

static OLD_MAX_TRAY_ITEMS: AtomicUsize = AtomicUsize::new(0);

/// Helper to create a submenu for mount profiles
fn create_mount_submenu<R: Runtime>(
    handle: &AppHandle<R>,
    remote: &str,
    settings: &serde_json::Value,
    mounted_remotes: &[crate::utils::types::all_types::MountedRemote],
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
            let is_mounted = mounted_remotes
                .iter()
                .any(|mounted| mounted.mount_point == mount_point);

            let (action_id, label) = if is_mounted {
                (
                    TrayAction::UnmountProfile(remote.to_string(), profile_name.clone()).to_id(),
                    format!("● {} ▸ Unmount", profile_name),
                )
            } else {
                (
                    TrayAction::MountProfile(remote.to_string(), profile_name.clone()).to_id(),
                    format!("  {} ▸ Mount", profile_name),
                )
            };

            let item = MenuItem::with_id(handle, action_id, label, true, None::<&str>)?;
            items.push(Box::new(item));
        }
    } else {
        // No profiles configured - show default option
        let action_id = TrayAction::MountProfile(remote.to_string(), "default".to_string()).to_id();
        let item = MenuItem::with_id(handle, action_id, "  default ▸ Mount", true, None::<&str>)?;
        items.push(Box::new(item));
    }

    let profile_count = mount_configs.map(|c| c.len()).unwrap_or(1);

    let submenu = Submenu::with_items(
        handle,
        format!("Mount [{}/{}]", active_count, profile_count),
        true,
        &items.iter().map(|item| item.as_ref()).collect::<Vec<_>>(),
    )?;

    Ok(submenu)
}

/// Helper to create a submenu for sync profiles
fn create_sync_submenu<R: Runtime>(
    handle: &AppHandle<R>,
    remote: &str,
    settings: &serde_json::Value,
    active_jobs: &[crate::utils::types::all_types::JobInfo],
) -> tauri::Result<Submenu<R>> {
    let sync_configs = settings
        .get("syncConfigs")
        .and_then(|v| v.as_object())
        .filter(|configs| !configs.is_empty());

    let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<R>>> = vec![];

    if let Some(configs) = sync_configs {
        for (profile_name, _config) in configs {
            let is_running = active_jobs.iter().any(|job| {
                job.remote_name == remote
                    && job.job_type == "sync"
                    && job.profile.as_ref() == Some(profile_name)
            });

            let (action_id, label) = if is_running {
                (
                    TrayAction::StopSyncProfile(remote.to_string(), profile_name.clone()).to_id(),
                    format!("● {} ▸ Stop", profile_name),
                )
            } else {
                (
                    TrayAction::SyncProfile(remote.to_string(), profile_name.clone()).to_id(),
                    format!("  {} ▸ Start", profile_name),
                )
            };

            let item = MenuItem::with_id(handle, action_id, label, true, None::<&str>)?;
            items.push(Box::new(item));
        }
    } else {
        let action_id = TrayAction::SyncProfile(remote.to_string(), "default".to_string()).to_id();
        let item = MenuItem::with_id(handle, action_id, "  default ▸ Start", true, None::<&str>)?;
        items.push(Box::new(item));
    }

    let profile_count = sync_configs.map(|c| c.len()).unwrap_or(1);
    let active_count = active_jobs
        .iter()
        .filter(|job| job.remote_name == remote && job.job_type == "sync")
        .count();

    let submenu = Submenu::with_items(
        handle,
        format!("Sync [{}/{}]", active_count, profile_count),
        true,
        &items.iter().map(|item| item.as_ref()).collect::<Vec<_>>(),
    )?;

    Ok(submenu)
}

/// Helper to create a submenu for copy profiles
fn create_copy_submenu<R: Runtime>(
    handle: &AppHandle<R>,
    remote: &str,
    settings: &serde_json::Value,
    active_jobs: &[crate::utils::types::all_types::JobInfo],
) -> tauri::Result<Submenu<R>> {
    let copy_configs = settings
        .get("copyConfigs")
        .and_then(|v| v.as_object())
        .filter(|configs| !configs.is_empty());

    let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<R>>> = vec![];

    if let Some(configs) = copy_configs {
        for (profile_name, _config) in configs {
            let is_running = active_jobs.iter().any(|job| {
                job.remote_name == remote
                    && job.job_type == "copy"
                    && job.profile.as_ref() == Some(profile_name)
            });

            let (action_id, label) = if is_running {
                (
                    TrayAction::StopCopyProfile(remote.to_string(), profile_name.clone()).to_id(),
                    format!("● {} ▸ Stop", profile_name),
                )
            } else {
                (
                    TrayAction::CopyProfile(remote.to_string(), profile_name.clone()).to_id(),
                    format!("  {} ▸ Start", profile_name),
                )
            };

            let item = MenuItem::with_id(handle, action_id, label, true, None::<&str>)?;
            items.push(Box::new(item));
        }
    } else {
        let action_id = TrayAction::CopyProfile(remote.to_string(), "default".to_string()).to_id();
        let item = MenuItem::with_id(handle, action_id, "  default ▸ Start", true, None::<&str>)?;
        items.push(Box::new(item));
    }

    let profile_count = copy_configs.map(|c| c.len()).unwrap_or(1);
    let active_count = active_jobs
        .iter()
        .filter(|job| job.remote_name == remote && job.job_type == "copy")
        .count();

    let submenu = Submenu::with_items(
        handle,
        format!("Copy [{}/{}]", active_count, profile_count),
        true,
        &items.iter().map(|item| item.as_ref()).collect::<Vec<_>>(),
    )?;

    Ok(submenu)
}

/// Helper to create a submenu for move profiles
fn create_move_submenu<R: Runtime>(
    handle: &AppHandle<R>,
    remote: &str,
    settings: &serde_json::Value,
    active_jobs: &[crate::utils::types::all_types::JobInfo],
) -> tauri::Result<Submenu<R>> {
    let move_configs = settings
        .get("moveConfigs")
        .and_then(|v| v.as_object())
        .filter(|configs| !configs.is_empty());

    let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<R>>> = vec![];

    if let Some(configs) = move_configs {
        for (profile_name, _config) in configs {
            let is_running = active_jobs.iter().any(|job| {
                job.remote_name == remote
                    && job.job_type == "move"
                    && job.profile.as_ref() == Some(profile_name)
            });

            let (action_id, label) = if is_running {
                (
                    TrayAction::StopMoveProfile(remote.to_string(), profile_name.clone()).to_id(),
                    format!("● {} ▸ Stop", profile_name),
                )
            } else {
                (
                    TrayAction::MoveProfile(remote.to_string(), profile_name.clone()).to_id(),
                    format!("  {} ▸ Start", profile_name),
                )
            };

            let item = MenuItem::with_id(handle, action_id, label, true, None::<&str>)?;
            items.push(Box::new(item));
        }
    } else {
        let action_id = TrayAction::MoveProfile(remote.to_string(), "default".to_string()).to_id();
        let item = MenuItem::with_id(handle, action_id, "  default ▸ Start", true, None::<&str>)?;
        items.push(Box::new(item));
    }

    let profile_count = move_configs.map(|c| c.len()).unwrap_or(1);
    let active_count = active_jobs
        .iter()
        .filter(|job| job.remote_name == remote && job.job_type == "move")
        .count();

    let submenu = Submenu::with_items(
        handle,
        format!("Move [{}/{}]", active_count, profile_count),
        true,
        &items.iter().map(|item| item.as_ref()).collect::<Vec<_>>(),
    )?;

    Ok(submenu)
}

/// Helper to create a submenu for bisync profiles
fn create_bisync_submenu<R: Runtime>(
    handle: &AppHandle<R>,
    remote: &str,
    settings: &serde_json::Value,
    active_jobs: &[crate::utils::types::all_types::JobInfo],
) -> tauri::Result<Submenu<R>> {
    let bisync_configs = settings
        .get("bisyncConfigs")
        .and_then(|v| v.as_object())
        .filter(|configs| !configs.is_empty());

    let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<R>>> = vec![];

    if let Some(configs) = bisync_configs {
        for (profile_name, _config) in configs {
            let is_running = active_jobs.iter().any(|job| {
                job.remote_name == remote
                    && job.job_type == "bisync"
                    && job.profile.as_ref() == Some(profile_name)
            });

            let (action_id, label) = if is_running {
                (
                    TrayAction::StopBisyncProfile(remote.to_string(), profile_name.clone()).to_id(),
                    format!("● {} ▸ Stop", profile_name),
                )
            } else {
                (
                    TrayAction::BisyncProfile(remote.to_string(), profile_name.clone()).to_id(),
                    format!("  {} ▸ Start", profile_name),
                )
            };

            let item = MenuItem::with_id(handle, action_id, label, true, None::<&str>)?;
            items.push(Box::new(item));
        }
    } else {
        let action_id =
            TrayAction::BisyncProfile(remote.to_string(), "default".to_string()).to_id();
        let item = MenuItem::with_id(handle, action_id, "  default ▸ Start", true, None::<&str>)?;
        items.push(Box::new(item));
    }

    let profile_count = bisync_configs.map(|c| c.len()).unwrap_or(1);
    let active_count = active_jobs
        .iter()
        .filter(|job| job.remote_name == remote && job.job_type == "bisync")
        .count();

    let submenu = Submenu::with_items(
        handle,
        format!("BiSync [{}/{}]", active_count, profile_count),
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
                let serve_profile = serve
                    .params
                    .get("profile")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                (fs.starts_with(&remote_fs_prefix) || fs == remote) && serve_profile == profile_name
            });

            let (action_id, label) = if let Some(serve) = active_serve {
                let serve_type = serve.params["type"].as_str().unwrap_or("serve");
                (
                    TrayAction::StopServeProfile(remote.to_string(), serve.id.clone()).to_id(),
                    format!("● {} ({}) ▸ Stop", profile_name, serve_type),
                )
            } else {
                (
                    TrayAction::ServeProfile(remote.to_string(), profile_name.clone()).to_id(),
                    format!("  {} ▸ Start", profile_name),
                )
            };

            let item = MenuItem::with_id(handle, action_id, label, true, None::<&str>)?;
            items.push(Box::new(item));
        }
    } else {
        let action_id = TrayAction::ServeProfile(remote.to_string(), "default".to_string()).to_id();
        let item = MenuItem::with_id(handle, action_id, "  default ▸ Start", true, None::<&str>)?;
        items.push(Box::new(item));
    }

    let profile_count = serve_configs.map(|c| c.len()).unwrap_or(1);

    let submenu = Submenu::with_items(
        handle,
        format!("Serve [{}/{}]", active_count, profile_count),
        true,
        &items.iter().map(|item| item.as_ref()).collect::<Vec<_>>(),
    )?;

    Ok(submenu)
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
    let stop_all_serves_item = MenuItem::with_id(
        &handle,
        "stop_all_serves",
        "Stop All Serves",
        true,
        None::<&str>,
    )?;

    let quit_item = MenuItem::with_id(&handle, "quit", "Quit", true, None::<&str>)?;

    // --- Get state from app handle ---

    let remotes = get_cached_remotes().await.unwrap_or_else(|err| {
        error!("Failed to fetch cached remotes: {err}");
        vec![]
    });
    let mounted_remotes = get_cached_mounted_remotes().await.unwrap_or_else(|err| {
        error!("Failed to fetch mounted remotes: {err}");
        vec![]
    });
    let all_serves = get_cached_serves().await.unwrap_or_else(|err| {
        error!("Failed to fetch cached serves: {err}");
        vec![]
    });

    let active_jobs =
        if let Some(backend) = crate::rclone::backend::BACKEND_MANAGER.get_active().await {
            backend.read().await.job_cache.get_active_jobs().await
        } else {
            Vec::new()
        };

    let cached_settings = get_settings(app.state::<rcman::SettingsManager<rcman::JsonStorage>>())
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

            // Filter active jobs for this remote (exclude mount and serve)
            let active_jobs_for_remote: Vec<_> = active_jobs
                .iter()
                .filter(|job| {
                    job.remote_name == remote && job.job_type != "serve" && job.job_type != "mount"
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
                format!(
                    "Jobs [{}/{}]",
                    active_jobs_for_remote.len(),
                    total_job_profiles
                )
            } else {
                "Jobs [—]".to_string()
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
                        let sync_submenu =
                            create_sync_submenu(&handle, &remote, &settings, &active_jobs)?;
                        submenu_items.push(Box::new(sync_submenu));
                    }
                    "copy" => {
                        let copy_submenu =
                            create_copy_submenu(&handle, &remote, &settings, &active_jobs)?;
                        submenu_items.push(Box::new(copy_submenu));
                    }
                    "move" => {
                        let move_submenu =
                            create_move_submenu(&handle, &remote, &settings, &active_jobs)?;
                        submenu_items.push(Box::new(move_submenu));
                    }
                    "bisync" => {
                        let bisync_submenu =
                            create_bisync_submenu(&handle, &remote, &settings, &active_jobs)?;
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
                    MenuItem::with_id(&handle, browse_id, "Browse", true, None::<&str>)?;
                submenu_items.push(Box::new(browse_item));
            } else {
                // Not mounted: show "Browse (In App)" to open in-app file browser
                let browse_in_app_id = TrayAction::BrowseInApp(remote.clone()).to_id();
                let browse_in_app_item = MenuItem::with_id(
                    &handle,
                    browse_in_app_id,
                    "Browse (In App)",
                    true,
                    None::<&str>,
                )?;
                submenu_items.push(Box::new(browse_in_app_item));
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
    let mut menu_items: Vec<&dyn tauri::menu::IsMenuItem<R>> = vec![&show_app_item, &separator];

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
