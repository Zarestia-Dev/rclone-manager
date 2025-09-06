use log::{debug, error, info};
use tauri::{AppHandle, Manager, Runtime};
use tokio::join;

use crate::rclone::{
    commands::{
        BisyncParams, MoveParams, mount_remote, start_bisync, start_copy, start_move, start_sync,
    },
    state::{get_cached_remotes, get_settings, start_mounted_remote_watcher},
};

/// Main entry point for handling startup tasks.
pub async fn handle_startup(app_handle: AppHandle) {
    info!("🚀 Checking startup options...");

    // Run all tasks in parallel
    let (remotes_result, _, _) = join!(
        initialize_remotes(),
        sync_all_remotes(&app_handle),
        copy_all_remotes(&app_handle)
    );

    // Process remotes after retrieval
    if let Ok(remotes) = remotes_result {
        for remote in remotes.iter() {
            handle_remote_startup(remote.to_string(), app_handle.clone()).await;
        }
    }

    // Start the mounted remote watcher for continuous monitoring
    info!("🔍 Starting mounted remote watcher...");
    tokio::spawn(start_mounted_remote_watcher(app_handle.clone()));
}

/// Fetches the list of available remotes.
async fn initialize_remotes() -> Result<Vec<String>, String> {
    let remotes = get_cached_remotes().await?;
    Ok(remotes)
}

/// Handles startup logic for an individual remote.
async fn handle_remote_startup(remote_name: String, app_handle: AppHandle) {
    let settings_result = get_settings().await;
    let settings = settings_result
        .ok()
        .and_then(|settings| settings.get(&remote_name).cloned())
        .unwrap_or_else(|| {
            error!("Remote {remote_name} not found in cached settings");
            serde_json::Value::Null
        });

    let mount_options = settings.get("mountConfig").cloned();
    let vfs_options = settings.get("vfsConfig").cloned();
    let sync_config = settings.get("syncConfig").cloned();
    let move_config = settings.get("moveConfig").cloned();
    let bisync_config = settings.get("bisyncConfig").cloned();
    let copy_config = settings.get("copyConfig").cloned();
    let filter_options = settings.get("filterConfig").cloned();

    // Handle auto-mount if configured
    if let Some(auto_mount) = mount_options
        .as_ref()
        .and_then(|opts| opts.get("autoStart").and_then(|v| v.as_bool()))
    {
        if auto_mount {
            let mount_point = mount_options
                .as_ref()
                .and_then(|opts| opts.get("dest").and_then(|v| v.as_str()))
                .map(|s| s.to_string());

            let source = mount_options
                .as_ref()
                .and_then(|opts| opts.get("source").and_then(|v| v.as_str()))
                .map(|s| s.to_string())
                .unwrap_or_default(); // Default to empty string if no source

            let mount_type = mount_options
                .as_ref()
                .and_then(|opts| opts.get("type").and_then(|v| v.as_str()))
                .map(|s| s.to_string())
                .unwrap_or_else(|| "mount".to_string()); // Default to "mount" if not specified

            if let Some(dest) = mount_point {
                spawn_mount_task(
                    remote_name.clone(),
                    source,
                    mount_type,
                    dest,
                    mount_options,
                    vfs_options,
                    app_handle.clone(),
                );
            } else {
                error!("❌ Mount configuration incomplete for {remote_name}");
            }
        } else {
            debug!("Skipping mount for {remote_name}: autoStart is not true");
        }
    }

    // Handle auto-sync if configured
    if let Some(auto_sync) = sync_config
        .as_ref()
        .and_then(|opts| opts.get("autoStart").and_then(|v| v.as_bool()))
    {
        if auto_sync {
            let source = sync_config
                .as_ref()
                .and_then(|opts| opts.get("source").and_then(|v| v.as_str()))
                .map(|s| s.to_string());

            let create_empty_src_dirs = sync_config
                .as_ref()
                .and_then(|opts| opts.get("createEmptySrcDirs").and_then(|v| v.as_bool()))
                .unwrap_or(false);

            let dest_path = sync_config
                .as_ref()
                .and_then(|opts| opts.get("dest").and_then(|v| v.as_str()))
                .map(|s| s.to_string());

            let sync_options = sync_config
                .as_ref()
                .and_then(|opts| opts.get("options").cloned());

            if let Some(dest) = dest_path {
                let source = source.unwrap_or_default(); // Default to empty string if no source

                spawn_sync_task(
                    remote_name.clone(),
                    source,
                    dest,
                    create_empty_src_dirs,
                    sync_options,
                    filter_options.clone(),
                    app_handle.clone(),
                );
            } else {
                error!("❌ Sync configuration incomplete for {remote_name}");
            }
        } else {
            debug!("Skipping sync for {remote_name}: autoStart is not true");
        }
    }

    // Handle auto-copy if configured
    if let Some(auto_copy) = copy_config
        .as_ref()
        .and_then(|opts| opts.get("autoStart").and_then(|v| v.as_bool()))
    {
        if auto_copy {
            let source = copy_config
                .as_ref()
                .and_then(|opts| opts.get("source").and_then(|v| v.as_str()))
                .map(|s| s.to_string());

            let dest_path = copy_config
                .as_ref()
                .and_then(|opts| opts.get("dest").and_then(|v| v.as_str()))
                .map(|s| s.to_string());

            let create_empty_src_dirs = copy_config
                .as_ref()
                .and_then(|opts| opts.get("createEmptySrcDirs").and_then(|v| v.as_bool()))
                .unwrap_or(false);

            let copy_options = copy_config
                .as_ref()
                .and_then(|opts| opts.get("options").cloned());

            if let Some(dest) = dest_path {
                let source = source.unwrap_or_default(); // Default to empty string if no source

                spawn_copy_task(
                    remote_name.clone(),
                    source,
                    dest,
                    create_empty_src_dirs,
                    copy_options,
                    filter_options.clone(),
                    app_handle.clone(),
                );
            } else {
                error!("❌ Copy configuration incomplete for {remote_name}");
            }
        } else {
            debug!("Skipping copy for {remote_name}: autoStart is not true");
        }
    }

    // Handle Auto-Move if configured
    if let Some(auto_move) = move_config
        .as_ref()
        .and_then(|opts| opts.get("autoStart").and_then(|v| v.as_bool()))
    {
        if auto_move {
            let source = move_config
                .as_ref()
                .and_then(|opts| opts.get("source").and_then(|v| v.as_str()))
                .map(|s| s.to_string());
            let dest_path = move_config
                .as_ref()
                .and_then(|opts| opts.get("dest").and_then(|v| v.as_str()))
                .map(|s| s.to_string());
            let create_empty_src_dirs = move_config
                .as_ref()
                .and_then(|opts| opts.get("createEmptySrcDirs").and_then(|v| v.as_bool()))
                .unwrap_or(false);
            let delete_empty_src_dirs = move_config
                .as_ref()
                .and_then(|opts| opts.get("deleteEmptySrcDirs").and_then(|v| v.as_bool()))
                .unwrap_or(false);
            let move_options = move_config
                .as_ref()
                .and_then(|opts| opts.get("options").cloned())
                .and_then(|o| o.as_object().cloned())
                .map(|map| map.into_iter().collect());

            let filter_options_map = filter_options
                .as_ref()
                .and_then(|o| o.as_object().cloned())
                .map(|map| map.into_iter().collect());

            if let Some(dest) = dest_path {
                let source = source.unwrap_or_default(); // Default to empty string if no source

                let params = MoveParams {
                    remote_name: remote_name.clone(),
                    source,
                    dest: dest.clone(),
                    create_empty_src_dirs,
                    delete_empty_src_dirs,
                    move_options,
                    filter_options: filter_options_map,
                };

                spawn_move_task(params, app_handle.clone());
            } else {
                error!("❌ Move configuration incomplete for {remote_name}");
            }
        } else {
            debug!("Skipping move for {remote_name}: autoStart is not true");
        }
    }

    // Handle auto-bisync if configured
    if let Some(auto_bisync) = bisync_config
        .as_ref()
        .and_then(|opts| opts.get("autoStart").and_then(|v| v.as_bool()))
    {
        if auto_bisync {
            let source = bisync_config
                .as_ref()
                .and_then(|opts| opts.get("source").and_then(|v| v.as_str()))
                .map(|s| s.to_string());
            let dest_path = bisync_config
                .as_ref()
                .and_then(|opts| opts.get("dest").and_then(|v| v.as_str()))
                .map(|s| s.to_string());
            let dry_run = bisync_config
                .as_ref()
                .and_then(|opts| opts.get("dryRun").and_then(|v| v.as_bool()))
                .unwrap_or(false);
            let resync = bisync_config
                .as_ref()
                .and_then(|opts| opts.get("resync").and_then(|v| v.as_bool()))
                .unwrap_or(false);
            let check_access = bisync_config
                .as_ref()
                .and_then(|opts| opts.get("checkAccess").and_then(|v| v.as_bool()))
                .unwrap_or(false);
            let check_filename = bisync_config
                .as_ref()
                .and_then(|opts| opts.get("checkFilename").and_then(|v| v.as_str()))
                .map(|s| s.to_string());
            let max_delete = bisync_config
                .as_ref()
                .and_then(|opts| opts.get("maxDelete").and_then(|v| v.as_u64()))
                .unwrap_or(0) as i64;
            let force = bisync_config
                .as_ref()
                .and_then(|opts| opts.get("force").and_then(|v| v.as_bool()))
                .unwrap_or(false);
            let check_sync = bisync_config
                .as_ref()
                .and_then(|opts| opts.get("checkSync"))
                .and_then(|v| {
                    if let Some(b) = v.as_bool() {
                        Some(if b {
                            "true".to_string()
                        } else {
                            "false".to_string()
                        })
                    } else {
                        v.as_str().map(|s| s.to_string())
                    }
                });
            let create_empty_src_dirs = bisync_config
                .as_ref()
                .and_then(|opts| opts.get("createEmptySrcDirs").and_then(|v| v.as_bool()))
                .unwrap_or(false);
            let remove_empty_dirs = bisync_config
                .as_ref()
                .and_then(|opts| opts.get("removeEmptyDirs").and_then(|v| v.as_bool()))
                .unwrap_or(false);
            let filters_file = bisync_config
                .as_ref()
                .and_then(|opts| opts.get("filtersFile").and_then(|v| v.as_str()))
                .map(|s| s.to_string());
            let ignore_listing_checksum = bisync_config
                .as_ref()
                .and_then(|opts| opts.get("ignoreListingChecksum").and_then(|v| v.as_bool()))
                .unwrap_or(false);
            let resilient = bisync_config
                .as_ref()
                .and_then(|opts| opts.get("resilient").and_then(|v| v.as_bool()))
                .unwrap_or(false);
            let workdir = bisync_config
                .as_ref()
                .and_then(|opts| opts.get("workdir").and_then(|v| v.as_str()))
                .map(|s| s.to_string());
            let backupdir1 = bisync_config
                .as_ref()
                .and_then(|opts| opts.get("backupdir1").and_then(|v| v.as_str()))
                .map(|s| s.to_string());
            let backupdir2 = bisync_config
                .as_ref()
                .and_then(|opts| opts.get("backupdir2").and_then(|v| v.as_str()))
                .map(|s| s.to_string());
            let no_cleanup = bisync_config
                .as_ref()
                .and_then(|opts| opts.get("noCleanup").and_then(|v| v.as_bool()))
                .unwrap_or(false);
            let bisync_options = bisync_config
                .as_ref()
                .and_then(|opts| opts.get("options").cloned())
                .and_then(|o| o.as_object().cloned())
                .map(|map| map.into_iter().collect());

            let filter_options_map = filter_options
                .as_ref()
                .and_then(|o| o.as_object().cloned())
                .map(|map| map.into_iter().collect());

            if let Some(dest) = dest_path {
                let source = source.unwrap_or_default();

                let params = BisyncParams {
                    remote_name: remote_name.clone(),
                    source,
                    dest,
                    dry_run: Some(dry_run),
                    resync,
                    check_access: Some(check_access),
                    check_filename,
                    max_delete: Some(max_delete),
                    force: Some(force),
                    check_sync,
                    create_empty_src_dirs: Some(create_empty_src_dirs),
                    remove_empty_dirs: Some(remove_empty_dirs),
                    filters_file,
                    ignore_listing_checksum: Some(ignore_listing_checksum),
                    resilient: Some(resilient),
                    workdir,
                    backupdir1,
                    backupdir2,
                    no_cleanup: Some(no_cleanup),
                    bisync_options,
                    filter_options: filter_options_map,
                };

                spawn_bisync_task(params, app_handle.clone());
            } else {
                error!("❌ Bisync configuration incomplete for {remote_name}");
            }
        } else {
            debug!("Skipping bisync for {remote_name}: autoStart is not true");
        }
    }
}

/// Spawns an async task to mount a remote.
fn spawn_mount_task(
    remote_name: String,
    source: String,
    mount_point: String,
    mount_type: String,
    mount_options: Option<serde_json::Value>,
    vfs_options: Option<serde_json::Value>,
    app_handle: AppHandle,
) {
    let app_clone = app_handle.clone();
    let mount_options_clone = mount_options
        .as_ref()
        .and_then(|o| o.as_object().cloned())
        .map(|map| map.into_iter().collect());

    let vfs_options_clone = vfs_options
        .as_ref()
        .and_then(|o| o.as_object().cloned())
        .map(|map| map.into_iter().collect());

    tauri::async_runtime::spawn(async move {
        let params = crate::rclone::commands::mount::MountParams {
            remote_name: remote_name.clone(),
            source: source.clone(),
            mount_point,
            mount_type: mount_type.clone(),
            mount_options: mount_options_clone,
            vfs_options: vfs_options_clone,
        };
        match mount_remote(app_clone.clone(), params, app_clone.state()).await {
            Ok(_) => {
                info!("✅ Mounted {remote_name}:{source}");
            }
            Err(err) => error!("❌ Failed to mount {remote_name}:{source}: {err}",),
        }
    });
}

/// Spawns an async task to sync a remote.
fn spawn_sync_task(
    remote_name: String,
    source: String,
    dest_path: String,
    create_empty_src_dirs: bool,
    sync_config: Option<serde_json::Value>,
    filter_options: Option<serde_json::Value>,
    app_handle: AppHandle,
) {
    let app_clone = app_handle.clone();
    let sync_config_map = sync_config
        .as_ref()
        .and_then(|o| o.as_object().cloned())
        .map(|map| map.into_iter().collect());

    let filter_options_map = filter_options
        .as_ref()
        .and_then(|o| o.as_object().cloned())
        .map(|map| map.into_iter().collect());

    tauri::async_runtime::spawn(async move {
        let params = crate::rclone::commands::sync::SyncParams {
            remote_name: remote_name.clone(),
            source: source.clone(),
            dest: dest_path,
            create_empty_src_dirs,
            sync_options: sync_config_map,
            filter_options: filter_options_map,
        };
        match start_sync(app_clone.clone(), params, app_clone.state()).await {
            Ok(_) => {
                info!("✅ Synced {remote_name}:{source}");
            }
            Err(err) => error!("❌ Failed to sync {remote_name}:{source}: {err}",),
        }
    });
}

fn spawn_copy_task(
    remote_name: String,
    source: String,
    dest_path: String,
    create_empty_src_dirs: bool,
    copy_config: Option<serde_json::Value>,
    filter_options: Option<serde_json::Value>,
    app_handle: AppHandle,
) {
    let app_clone = app_handle.clone();
    let copy_config_map = copy_config
        .as_ref()
        .and_then(|o| o.as_object().cloned())
        .map(|map| map.into_iter().collect());

    let filter_options_map = filter_options
        .as_ref()
        .and_then(|o| o.as_object().cloned())
        .map(|map| map.into_iter().collect());

    tauri::async_runtime::spawn(async move {
        let params = crate::rclone::commands::sync::CopyParams {
            remote_name: remote_name.clone(),
            source: source.clone(),
            dest: dest_path,
            create_empty_src_dirs,
            copy_options: copy_config_map,
            filter_options: filter_options_map,
        };
        match start_copy(app_clone.clone(), params, app_clone.state()).await {
            Ok(jobid) => {
                info!("✅ Started copy for {remote_name}:{source} (Job ID: {jobid})",);
            }
            Err(err) => error!("❌ Failed to copy {remote_name}:{source}: {err}",),
        }
    });
}

fn spawn_move_task(params: MoveParams, app_handle: AppHandle) {
    let app_clone = app_handle.clone();
    let remote_name = params.remote_name.clone();
    let source = params.source.clone();
    let dest_path = params.dest.clone();
    let create_empty_src_dirs = params.create_empty_src_dirs;
    let delete_empty_src_dirs = params.delete_empty_src_dirs;
    let move_config_map = params.move_options.clone();
    let filter_options_map = params.filter_options.clone();

    tauri::async_runtime::spawn(async move {
        let params = MoveParams {
            remote_name: remote_name.clone(),
            source: source.clone(),
            dest: dest_path,
            create_empty_src_dirs,
            delete_empty_src_dirs,
            move_options: move_config_map,
            filter_options: filter_options_map,
        };
        match start_move(app_clone.clone(), params, app_clone.state()).await {
            Ok(jobid) => {
                info!("✅ Started move for {remote_name}:{source} (Job ID: {jobid})",);
            }
            Err(err) => error!("❌ Failed to move {remote_name}:{source}: {err}",),
        }
    });
}

fn spawn_bisync_task(params: BisyncParams, app_handle: AppHandle) {
    let app_clone = app_handle.clone();
    let remote_name = params.remote_name.clone();
    let source = params.source.clone();

    tauri::async_runtime::spawn(async move {
        match start_bisync(app_clone.clone(), params, app_clone.state()).await {
            Ok(_) => {
                info!("✅ Bisynced {remote_name}:{source}");
            }
            Err(err) => error!("❌ Failed to bisync {remote_name}:{source}: {err}",),
        }
    });
}

/// Runs sync jobs for all remotes.
async fn sync_all_remotes<R: Runtime>(_app_handle: &AppHandle<R>) -> Result<(), String> {
    info!("🔄 Starting remote sync tasks...");

    // Get all remotes and their settings
    let remotes = get_cached_remotes().await?;
    let settings = get_settings().await.map_err(|e| e.to_string())?;

    for remote in remotes {
        if let Some(remote_settings) = settings.get(&remote)
            && let Some(sync_config) = remote_settings.get("syncConfig")
            && let Some(auto_sync) = sync_config.get("autoStart").and_then(|v| v.as_bool())
            && auto_sync
        {
            info!("🔄 Starting sync for remote: {remote}");
            // The actual sync will be handled in handle_remote_startup
        }
    }

    Ok(())
}

async fn copy_all_remotes<R: Runtime>(_app_handle: &AppHandle<R>) -> Result<(), String> {
    info!("📋 Starting remote copy tasks...");

    // Get all remotes and their settings
    let remotes = get_cached_remotes().await?;
    let settings = get_settings().await.map_err(|e| e.to_string())?;

    for remote in remotes {
        if let Some(remote_settings) = settings.get(&remote)
            && let Some(copy_config) = remote_settings.get("copyConfig")
            && let Some(auto_copy) = copy_config.get("autoStart").and_then(|v| v.as_bool())
            && auto_copy
        {
            info!("📋 Starting copy for remote: {remote}");
            // The actual copy will be handled in handle_remote_startup
        }
    }

    Ok(())
}
