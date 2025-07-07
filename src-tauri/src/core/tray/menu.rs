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
    // let mount_all_item = MenuItem::with_id(&handle, "mount_all", "Mount All", true, None::<&str>)?;
    let unmount_all_item =
        MenuItem::with_id(&handle, "unmount_all", "Unmount All", true, None::<&str>)?;
    // let sync_all_item = MenuItem::with_id(&handle, "sync_all", "Sync All", true, None::<&str>)?;
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

                // Check job status - separate sync and copy jobs
                let active_sync_job = active_jobs
                    .iter()
                    .find(|job| job.remote_name == *remote && job.job_type == "sync");
                let active_copy_job = active_jobs
                    .iter()
                    .find(|job| job.remote_name == *remote && job.job_type == "copy");

                let job_status = CheckMenuItem::with_id(
                    &handle,
                    format!("job_status-{remote}"),
                    match (active_sync_job, active_copy_job) {
                        (Some(_), Some(_)) => "Sync & Copy in progress".to_string(),
                        (Some(_), _) => "Sync in progress".to_string(),
                        (_, Some(_)) => "Copy in progress".to_string(),
                        _ => "No active jobs".to_string(),
                    },
                    false,
                    active_sync_job.is_some() || active_copy_job.is_some(),
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

                // Mount/Unmount items
                if is_mounted {
                    let unmount_item = MenuItem::with_id(
                        &handle,
                        format!("unmount-{remote}"),
                        "Unmount",
                        true,
                        None::<&str>,
                    )?;
                    submenu_items.push(Box::new(unmount_item));
                } else {
                    let mount_item = MenuItem::with_id(
                        &handle,
                        format!("mount-{remote}"),
                        "Mount",
                        true,
                        None::<&str>,
                    )?;
                    submenu_items.push(Box::new(mount_item));
                }

                if active_sync_job.is_some() {
                    let stop_sync_item = MenuItem::with_id(
                        &handle,
                        format!("stop_sync-{remote}"),
                        "Stop Sync",
                        true,
                        None::<&str>,
                    )?;
                    submenu_items.push(Box::new(stop_sync_item));
                }

                if active_copy_job.is_some() {
                    let stop_copy_item = MenuItem::with_id(
                        &handle,
                        format!("stop_copy-{remote}"),
                        "Stop Copy",
                        true,
                        None::<&str>,
                    )?;
                    submenu_items.push(Box::new(stop_copy_item));
                }

                if active_sync_job.is_none() {
                    let sync_item = MenuItem::with_id(
                        &handle,
                        format!("sync-{remote}"),
                        "Start Sync",
                        true,
                        None::<&str>,
                    )?;
                    submenu_items.push(Box::new(sync_item));
                }

                if active_copy_job.is_none() {
                    let copy_item = MenuItem::with_id(
                        &handle,
                        format!("copy-{remote}"),
                        "Start Copy",
                        true,
                        None::<&str>,
                    )?;
                    submenu_items.push(Box::new(copy_item));
                }

                submenu_items.push(Box::new(PredefinedMenuItem::separator(&handle)?));

                // Common items
                let browse_item = MenuItem::with_id(
                    &handle,
                    format!("browse-{remote}"),
                    "Browse",
                    is_mounted,
                    None::<&str>,
                )?;
                let delete_item = MenuItem::with_id(
                    &handle,
                    format!("delete-{remote}"),
                    "Delete",
                    true,
                    None::<&str>,
                )?;

                submenu_items.push(Box::new(browse_item));
                submenu_items.push(Box::new(delete_item));

                let name = if remote.len() > 20 {
                    format!("{}...", &remote[..17])
                } else {
                    remote.clone()
                };

                let indicators = format!(
                    "{}{}{}",
                    if is_mounted { "🖴" } else { "" },
                    if active_sync_job.is_some() {
                        "🔄"
                    } else {
                        ""
                    },
                    if active_copy_job.is_some() {
                        "📦"
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
        // menu_items.push(&mount_all_item);
        menu_items.push(&unmount_all_item);
        // menu_items.push(&sync_all_item);
        menu_items.push(&stop_all_jobs_item);
        menu_items.push(&separator);
    }

    menu_items.push(&quit_item);

    Menu::with_items(&handle, &menu_items)
}
