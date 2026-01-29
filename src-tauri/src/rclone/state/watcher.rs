use log::{debug, warn};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::time;

use crate::rclone::queries::{mount::get_mounted_remotes_internal, serve::list_serves_internal};
use crate::{
    rclone::backend::{BackendManager, types::Backend},
    utils::types::{
        core::RcloneState,
        remotes::{RemoteCache, ServeInstance},
    },
};

/// Global flag to control the mounted remote watcher
static WATCHER_RUNNING: AtomicBool = AtomicBool::new(false);

/// Global flag to control the serve watcher
static SERVE_WATCHER_RUNNING: AtomicBool = AtomicBool::new(false);

/// Core logic to check and reconcile mounted remotes for the active backend
async fn check_and_reconcile_mounts(
    app_handle: AppHandle,
    backend: Backend,
    cache: Arc<RemoteCache>,
    client: reqwest::Client,
) -> Result<(), String> {
    let api_url = backend.api_url();
    let api_mounts = match get_mounted_remotes_internal(&client, &backend).await {
        Ok(mounts) => mounts,
        Err(e) => {
            warn!(
                "🔍 Failed to get mounts from API ({}), skipping reconciliation: {e}",
                api_url
            );
            return Err(e);
        }
    };

    // Use reactive cache update - it will emit event only if changed
    let changed = cache
        .update_mounts_if_changed(api_mounts, &app_handle)
        .await;
    if changed {
        debug!("🔍 Mount cache updated via watcher for {}", api_url);
    }

    Ok(())
}

/// Background task that monitors mounted remotes
/// Spawns itself in a tokio task for consistency with serve watcher
pub fn start_mounted_remote_watcher(app_handle: AppHandle) {
    if WATCHER_RUNNING.swap(true, Ordering::SeqCst) {
        debug!("🔍 Mounted remote watcher already running");
        return;
    }

    tokio::spawn(async move {
        debug!("🔍 Starting mounted remote watcher");
        let mut interval = time::interval(Duration::from_secs(5));

        loop {
            interval.tick().await;
            if !WATCHER_RUNNING.load(Ordering::SeqCst) {
                debug!("🔍 Stopping mounted remote watcher");
                break;
            }

            let backend_manager = app_handle.state::<BackendManager>();
            let backend = backend_manager.get_active().await;
            let cache = backend_manager.remote_cache.clone();
            let client = app_handle.state::<RcloneState>().client.clone();

            if let Err(e) =
                check_and_reconcile_mounts(app_handle.clone(), backend, cache, client).await
            {
                debug!("🔍 Watcher failed to reconcile mounts: {e}");
            }
        }
    });
    debug!("✅ Mounted remote watcher started");
}

/// Stop the mounted remote watcher
pub fn stop_mounted_remote_watcher() {
    WATCHER_RUNNING.store(false, Ordering::SeqCst);
    debug!("🔍 Mounted remote watcher stop requested");
}

/// Force refresh mounted remotes
#[tauri::command]
pub async fn force_check_mounted_remotes(app_handle: AppHandle) -> Result<(), String> {
    debug!("🔍 Force checking mounted remotes");
    // Force check only checks active backend
    let backend_manager = app_handle.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let cache = backend_manager.remote_cache.clone();
    let client = app_handle.state::<RcloneState>().client.clone();

    check_and_reconcile_mounts(app_handle.clone(), backend, cache, client).await?;
    Ok(())
}

/// Helper to get running serves directly from the API
async fn get_serves_from_api(
    client: &reqwest::Client,
    backend: &Backend,
) -> Result<Vec<ServeInstance>, String> {
    use crate::rclone::queries::parse_serves_response;
    let api_response = list_serves_internal(client, backend).await?;
    Ok(parse_serves_response(&api_response))
}

/// Core logic to check and reconcile running serves
async fn check_and_reconcile_serves(
    app_handle: AppHandle,
    backend: Backend,
    cache: Arc<RemoteCache>,
    client: reqwest::Client,
) -> Result<(), String> {
    let api_url = backend.api_url();
    let api_serves = match get_serves_from_api(&client, &backend).await {
        Ok(serves) => serves,
        Err(e) => {
            warn!(
                "🔍 Failed to get serves from API ({}), skipping reconciliation: {e}",
                api_url
            );
            return Err(e);
        }
    };

    // Use reactive cache update - it will emit event only if changed
    let changed = cache
        .update_serves_if_changed(api_serves, &app_handle)
        .await;
    if changed {
        debug!("🔍 Serve cache updated via watcher for {}", api_url);
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
    let client = app_handle.state::<RcloneState>().client.clone();

    check_and_reconcile_serves(app_handle.clone(), backend, cache, client).await?;
    Ok(())
}

/// Start a background watcher that monitors running serves
pub fn start_serve_watcher(app_handle: AppHandle) {
    if SERVE_WATCHER_RUNNING.swap(true, Ordering::SeqCst) {
        debug!("🔍 Serve watcher already running");
        return;
    }

    tauri::async_runtime::spawn(async move {
        debug!("🔍 Starting serve watcher");
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(5));

        loop {
            interval.tick().await;

            if !SERVE_WATCHER_RUNNING.load(Ordering::SeqCst) {
                debug!("🔍 Stopping serve watcher");
                break;
            }

            let backend_manager = app_handle.state::<BackendManager>();
            let backend = backend_manager.get_active().await;
            let cache = backend_manager.remote_cache.clone();
            let client = app_handle.state::<RcloneState>().client.clone();

            if let Err(e) =
                check_and_reconcile_serves(app_handle.clone(), backend, cache, client).await
            {
                debug!("🔍 Watcher failed to reconcile serves: {e}");
            }
        }
    });
    debug!("✅ Serve watcher started");
}

/// Stop the serve watcher
pub fn stop_serve_watcher() {
    SERVE_WATCHER_RUNNING.store(false, Ordering::SeqCst);
    debug!("🔍 Serve watcher stop requested");
}
