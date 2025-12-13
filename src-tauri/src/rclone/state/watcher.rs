use log::{debug, warn};
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::time;

use crate::rclone::queries::{list_serves, mount::get_mounted_remotes};
use crate::utils::types::all_types::{RcloneState, RemoteCache};
use crate::utils::types::{
    all_types::{MountedRemote, ServeInstance},
    events::{REMOTE_STATE_CHANGED, SERVE_STATE_CHANGED},
};

/// Global flag to control the mounted remote watcher
static WATCHER_RUNNING: AtomicBool = AtomicBool::new(false);

/// Global flag to control the serve watcher
static SERVE_WATCHER_RUNNING: AtomicBool = AtomicBool::new(false);

/// Helper to get mounted remotes directly from the API
async fn get_mounted_remotes_from_api(
    app_handle: &AppHandle,
) -> Result<Vec<MountedRemote>, String> {
    let state: State<RcloneState> = app_handle.state();
    get_mounted_remotes(state).await
}

/// Helper to find differences between two lists of mounts
fn find_mount_changes(previous: &[MountedRemote], current: &[MountedRemote]) -> Vec<MountedRemote> {
    previous
        .iter()
        .filter(|prev_remote| {
            !current.iter().any(|curr_remote| {
                curr_remote.fs == prev_remote.fs
                    && curr_remote.mount_point == prev_remote.mount_point
            })
        })
        .cloned()
        .collect()
}

/// Core logic to check and reconcile mounted remotes
async fn check_and_reconcile_mounts(app_handle: AppHandle) -> Result<(), String> {
    let cache = app_handle.state::<RemoteCache>();

    let cached_mounts = cache.get_mounted_remotes().await;
    let api_mounts = match get_mounted_remotes_from_api(&app_handle).await {
        Ok(mounts) => mounts,
        Err(e) => {
            warn!("🔍 Failed to get mounts from API, skipping reconciliation: {e}");
            return Err(e);
        }
    };

    let unmounted_remotes = find_mount_changes(&cached_mounts, &api_mounts);
    let newly_mounted = find_mount_changes(&api_mounts, &cached_mounts);

    if unmounted_remotes.is_empty() && newly_mounted.is_empty() {
        return Ok(()); // No changes
    }

    debug!("🔍 Detected mount changes - updating cache");
    cache.refresh_mounted_remotes(app_handle.clone()).await?;

    // Emit events for unmounted remotes
    for remote in unmounted_remotes {
        let event_payload = json!({
            "fs": remote.fs,
            "mount_point": remote.mount_point,
            "reason": "externally_unmounted"
        });
        if let Err(e) = app_handle.emit(REMOTE_STATE_CHANGED, &event_payload) {
            warn!("⚠️ Failed to emit remote_state_changed event: {e}");
        }
    }

    // Emit events for newly mounted remotes
    for remote in newly_mounted {
        let event_payload = json!({
            "fs": remote.fs,
            "mount_point": remote.mount_point,
            "reason": "externally_mounted"
        });
        if let Err(e) = app_handle.emit(REMOTE_STATE_CHANGED, &event_payload) {
            warn!("⚠️ Failed to emit remote_state_changed event: {e}");
        }
    }

    Ok(())
}

/// Background task that monitors mounted remotes
pub async fn start_mounted_remote_watcher(app_handle: AppHandle) {
    if WATCHER_RUNNING.swap(true, Ordering::SeqCst) {
        debug!("🔍 Mounted remote watcher already running");
        return;
    }
    let mut interval = time::interval(Duration::from_secs(5));

    loop {
        interval.tick().await;
        if !WATCHER_RUNNING.load(Ordering::SeqCst) {
            debug!("🔍 Stopping mounted remote watcher");
            break;
        }

        let cache = app_handle.state::<RemoteCache>();

        // **Optimization**: Skip monitoring if cache is empty
        if cache.get_mounted_remotes().await.is_empty() {
            debug!("🔍 No mounted remotes in cache, skipping API check");
            continue;
        }

        // Call the new helper function
        if let Err(e) = check_and_reconcile_mounts(app_handle.clone()).await {
            debug!("🔍 Watcher failed to reconcile mounts: {e}");
        }
    }
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
    check_and_reconcile_mounts(app_handle).await
}

/// Helper to get running serves from the API
async fn get_serves_from_api(app_handle: &AppHandle) -> Result<Vec<ServeInstance>, String> {
    let api_response = list_serves(app_handle.state::<RcloneState>()).await?;
    let api_serves: Vec<ServeInstance> = api_response
        .get("list")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let id = item.get("id")?.as_str()?.to_string();
                    let addr = item.get("addr")?.as_str()?.to_string();
                    let params = item.get("params")?.clone();

                    Some(ServeInstance {
                        id,
                        addr,
                        params,
                        profile: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(api_serves)
}

/// Core logic to check and reconcile running serves
async fn check_and_reconcile_serves(app_handle: AppHandle) -> Result<(), String> {
    let cache = app_handle.state::<RemoteCache>();

    let cached_serves = cache.get_serves().await;
    let api_serves = match get_serves_from_api(&app_handle).await {
        Ok(serves) => serves,
        Err(e) => {
            warn!("🔍 Failed to get serves from API, skipping reconciliation: {e}");
            return Err(e);
        }
    };

    let stopped_serves: Vec<ServeInstance> = cached_serves
        .iter()
        .filter(|cached| !api_serves.iter().any(|api| api.id == cached.id))
        .cloned()
        .collect();

    let new_serves: Vec<ServeInstance> = api_serves
        .iter()
        .filter(|api| !cached_serves.iter().any(|cached| cached.id == api.id))
        .cloned()
        .collect();

    if stopped_serves.is_empty() && new_serves.is_empty() {
        return Ok(()); // No changes
    }

    debug!("🔍 Detected serve changes - updating cache");
    // --- Use managed state ---
    cache.refresh_serves(app_handle.clone()).await?;

    // Emit events for stopped serves
    for serve in stopped_serves {
        let fs = serve
            .params
            .get("fs")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let serve_type = serve
            .params
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let event_payload = json!({
            "id": serve.id,
            "fs": fs,
            "type": serve_type,
            "reason": "externally_stopped"
        });
        if let Err(e) = app_handle.emit(SERVE_STATE_CHANGED, &event_payload) {
            warn!("⚠️ Failed to emit serve_state_changed event: {e}");
        }
    }

    // Emit events for new serves
    for serve in new_serves {
        let fs = serve
            .params
            .get("fs")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let serve_type = serve
            .params
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let event_payload = json!({
            "id": serve.id,
            "fs": fs,
            "type": serve_type,
            "addr": serve.addr,
            "reason": "externally_started"
        });
        if let Err(e) = app_handle.emit(SERVE_STATE_CHANGED, &event_payload) {
            warn!("⚠️ Failed to emit serve_state_changed event: {e}");
        }
    }

    Ok(())
}

/// Force refresh serves
#[tauri::command]
pub async fn force_check_serves(app_handle: AppHandle) -> Result<(), String> {
    debug!("🔍 Force checking running serves");
    check_and_reconcile_serves(app_handle).await
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

            let cache = app_handle.state::<RemoteCache>();

            if cache.get_serves().await.is_empty() {
                debug!("🔍 No serves in cache, skipping API check");
                continue;
            }

            // Call the new helper function
            if let Err(e) = check_and_reconcile_serves(app_handle.clone()).await {
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
