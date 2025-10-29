use log::{error, info};
use tauri::{AppHandle, Manager};

use crate::core::config_extractor::{
    BisyncConfig, CopyConfig, MountConfig, MoveConfig, SyncConfig,
};
use crate::rclone::commands::{
    BisyncParams, CopyParams, MountParams, MoveParams, SyncParams, mount_remote, start_bisync,
    start_copy, start_move, start_sync,
};

/// Result type for spawn operations
pub type SpawnResult<T> = Result<T, String>;

/// Spawn a mount task and return the operation status. Builds MountParams from the extractor.
pub async fn spawn_mount(
    remote_name: String,
    cfg: MountConfig,
    override_mount_point: Option<String>,
    app: AppHandle,
) -> SpawnResult<()> {
    let app_clone = app.clone();
    let source = cfg.source.clone();

    let mount_point = override_mount_point.filter(|s| !s.is_empty()).or_else(|| {
        if cfg.dest.is_empty() {
            None
        } else {
            Some(cfg.dest.clone())
        }
    });

    let mount_point = match mount_point {
        Some(mp) if !mp.is_empty() => mp,
        _ => {
            let msg = format!(
                "Missing mount point for remote '{}' (no override and cfg.dest empty)",
                remote_name
            );
            error!("❌ {msg}");
            return Err(msg);
        }
    };

    let params = MountParams {
        remote_name: remote_name.clone(),
        source: cfg.source.clone(),
        mount_point,
        mount_type: cfg.mount_type.clone(),
        mount_options: cfg.mount_options,
        vfs_options: cfg.vfs_options,
        filter_options: cfg.filter_options,
        backend_options: cfg.backend_options,
    };

    match mount_remote(app_clone.clone(), params, app_clone.state()).await {
        Ok(_) => {
            info!("✅ Mounted {remote_name}:{source}");
            Ok(())
        }
        Err(err) => {
            error!("❌ Failed to mount {remote_name}:{source}: {err}");
            Err(err)
        }
    }
}

/// Spawn a sync task and return the job ID. Builds SyncParams from the extractor.
pub async fn spawn_sync(remote_name: String, cfg: SyncConfig, app: AppHandle) -> SpawnResult<u64> {
    let app_clone = app.clone();
    let source = cfg.source.clone();

    let params = SyncParams {
        remote_name: remote_name.clone(),
        source: cfg.source.clone(),
        dest: cfg.dest.clone(),
        create_empty_src_dirs: cfg.create_empty_src_dirs,
        sync_options: cfg.sync_options,
        filter_options: cfg.filter_options,
        backend_options: cfg.backend_options,
    };

    match start_sync(app_clone.clone(), params, app_clone.state()).await {
        Ok(jobid) => {
            info!("✅ Started sync for {remote_name}:{source} (Job ID: {jobid})");
            Ok(jobid)
        }
        Err(err) => {
            error!("❌ Failed to sync {remote_name}:{source}: {err}");
            Err(err)
        }
    }
}

/// Spawn a copy task and return the job ID. Builds CopyParams from the extractor.
pub async fn spawn_copy(remote_name: String, cfg: CopyConfig, app: AppHandle) -> SpawnResult<u64> {
    let app_clone = app.clone();
    let source = cfg.source.clone();

    let params = CopyParams {
        remote_name: remote_name.clone(),
        source: cfg.source.clone(),
        dest: cfg.dest.clone(),
        create_empty_src_dirs: cfg.create_empty_src_dirs,
        copy_options: cfg.copy_options,
        filter_options: cfg.filter_options,
        backend_options: cfg.backend_options,
    };

    match start_copy(app_clone.clone(), params, app_clone.state()).await {
        Ok(jobid) => {
            info!("✅ Started copy for {remote_name}:{source} (Job ID: {jobid})");
            Ok(jobid)
        }
        Err(err) => {
            error!("❌ Failed to copy {remote_name}:{source}: {err}");
            Err(err)
        }
    }
}

/// Spawn a move task and return the job ID. Builds MoveParams from the extractor.
pub async fn spawn_move(remote_name: String, cfg: MoveConfig, app: AppHandle) -> SpawnResult<u64> {
    let app_clone = app.clone();
    let source = cfg.source.clone();

    let params = MoveParams {
        remote_name: remote_name.clone(),
        source: cfg.source.clone(),
        dest: cfg.dest.clone(),
        create_empty_src_dirs: cfg.create_empty_src_dirs,
        delete_empty_src_dirs: cfg.delete_empty_src_dirs,
        move_options: cfg.move_options,
        filter_options: cfg.filter_options,
        backend_options: cfg.backend_options,
    };

    match start_move(app_clone.clone(), params, app_clone.state()).await {
        Ok(jobid) => {
            info!("✅ Started move for {remote_name}:{source} (Job ID: {jobid})");
            Ok(jobid)
        }
        Err(err) => {
            error!("❌ Failed to move {remote_name}:{source}: {err}");
            Err(err)
        }
    }
}

/// Spawn a bisync task and return the operation status. Builds BisyncParams from the extractor.
pub async fn spawn_bisync(
    remote_name: String,
    cfg: BisyncConfig,
    app: AppHandle,
) -> SpawnResult<u64> {
    let app_clone = app.clone();
    let source = cfg.source.clone();

    let params = BisyncParams {
        remote_name: remote_name.clone(),
        source: cfg.source.clone(),
        dest: cfg.dest.clone(),
        dry_run: Some(cfg.dry_run),
        resync: cfg.resync,
        check_access: Some(cfg.check_access),
        check_filename: cfg.check_filename.clone(),
        max_delete: Some(cfg.max_delete),
        force: Some(cfg.force),
        check_sync: cfg.check_sync.clone(),
        create_empty_src_dirs: Some(cfg.create_empty_src_dirs),
        remove_empty_dirs: Some(cfg.remove_empty_dirs),
        filters_file: cfg.filters_file.clone(),
        ignore_listing_checksum: Some(cfg.ignore_listing_checksum),
        resilient: Some(cfg.resilient),
        workdir: cfg.workdir.clone(),
        backupdir1: cfg.backupdir1.clone(),
        backupdir2: cfg.backupdir2.clone(),
        no_cleanup: Some(cfg.no_cleanup),
        bisync_options: cfg.bisync_options,
        filter_options: cfg.filter_options,
        backend_options: cfg.backend_options,
    };

    match start_bisync(app_clone.clone(), params, app_clone.state()).await {
        Ok(jobid) => {
            info!("✅ Bisynced {remote_name}:{source}");
            Ok(jobid)
        }
        Err(err) => {
            error!("❌ Failed to bisync {remote_name}:{source}: {err}");
            Err(err)
        }
    }
}
