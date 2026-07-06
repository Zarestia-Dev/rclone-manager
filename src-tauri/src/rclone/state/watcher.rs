use std::sync::Arc;

use log::{debug, warn};
use tauri::{AppHandle, Manager};

use crate::rclone::backend::{BackendManager, types::Backend};
use crate::rclone::queries::{get_mounted_remotes, list_serves};
use crate::utils::types::remotes::RemoteCache;

/// Core logic to check and reconcile mounted remotes for the active backend
async fn check_and_reconcile_mounts(
    app_handle: AppHandle,
    backend: Backend,
    cache: Arc<RemoteCache>,
) -> Result<(), String> {
    let api_url = backend.api_url();
    let api_mounts = match get_mounted_remotes(app_handle.clone()).await {
        Ok(mounts) => mounts,
        Err(e) => {
            warn!("🔍 Failed to get mounts from API ({api_url}), skipping reconciliation: {e}");
            return Err(e);
        }
    };

    // Use reactive cache update - it will emit event only if changed
    let changed = cache
        .update_mounts_if_changed(api_mounts, &app_handle)
        .await;
    if changed {
        debug!("🔍 Mount cache updated via watcher for {api_url}");
    }

    Ok(())
}

/// Force refresh mounted remotes
#[tauri::command]
pub async fn force_check_mounted_remotes(app_handle: AppHandle) -> Result<(), String> {
    debug!("🔍 Force checking mounted remotes");
    // Force check only checks active backend
    let backend_manager = app_handle.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let cache = backend_manager.remote_cache.clone();

    check_and_reconcile_mounts(app_handle.clone(), backend, cache).await?;
    Ok(())
}

/// Core logic to check and reconcile running serves
async fn check_and_reconcile_serves(
    app_handle: AppHandle,
    backend: Backend,
    cache: Arc<RemoteCache>,
) -> Result<(), String> {
    let api_url = backend.api_url();
    let api_serves = match list_serves(app_handle.clone()).await {
        Ok(serves) => serves,
        Err(e) => {
            warn!("🔍 Failed to get serves from API ({api_url}), skipping reconciliation: {e}");
            return Err(e);
        }
    };

    // Use reactive cache update - it will emit event only if changed
    let changed = cache
        .update_serves_if_changed(api_serves, &app_handle)
        .await;
    if changed {
        debug!("🔍 Serve cache updated via watcher for {api_url}");
    }

    Ok(())
}

/// Force refresh serves
#[tauri::command]
pub async fn force_check_serves(app_handle: AppHandle) -> Result<(), String> {
    debug!("🔍 Force checking running serves");
    let backend_manager = app_handle.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let cache = backend_manager.remote_cache.clone();

    check_and_reconcile_serves(app_handle.clone(), backend, cache).await?;
    Ok(())
}
