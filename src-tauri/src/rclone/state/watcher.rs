use log::{debug, error, warn};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::time;

use super::cache::CACHE;
use crate::RcloneState;
use crate::rclone::queries::mount::get_mounted_remotes;
use crate::utils::types::all_types::MountedRemote;

/// Global flag to control the mounted remote watcher
static WATCHER_RUNNING: AtomicBool = AtomicBool::new(false);

/// Background task that monitors mounted remotes for changes
///
/// This task runs continuously and checks if any mounted remotes have been
/// unmounted externally (outside of the app). If a remote is detected as
/// unmounted, it updates the cache and emits an event to notify the frontend.
pub async fn start_mounted_remote_watcher(app_handle: AppHandle) {
    // Prevent multiple watchers from running
    if WATCHER_RUNNING.swap(true, Ordering::SeqCst) {
        debug!("🔍 Mounted remote watcher already running");
        return;
    }
    let mut interval = time::interval(Duration::from_secs(5)); // Check every 5 seconds
    let mut last_known_mounts: Vec<MountedRemote> = Vec::new();

    loop {
        interval.tick().await;

        // Check if we should stop the watcher
        if !WATCHER_RUNNING.load(Ordering::SeqCst) {
            debug!("🔍 Stopping mounted remote watcher");
            break;
        }

        // **Optimization**: Skip monitoring if cache is empty (no remotes configured)
        let cached_remotes = CACHE.get_mounted_remotes().await;
        if cached_remotes.is_empty() && last_known_mounts.is_empty() {
            debug!("🔍 No remotes in cache, skipping API check");
            continue;
        }

        debug!("🔍 Checking mounted remotes...");

        // Get current mounted remotes from the live API using existing function
        let current_mounts = match get_mounted_remotes_from_api(&app_handle).await {
            Ok(mounts) => mounts,
            Err(e) => {
                debug!("� Failed to get mounted remotes from API: {e}");
                // Fall back to cache if API is not available
                cached_remotes
            }
        };

        // If this is the first run, just store the current state
        if last_known_mounts.is_empty() {
            last_known_mounts = current_mounts;
            continue;
        }

        // Check for changes: both unmounted and newly mounted remotes
        let unmounted_remotes = find_unmounted_remotes(&last_known_mounts, &current_mounts);
        let newly_mounted_remotes = find_unmounted_remotes(&current_mounts, &last_known_mounts);

        // Handle unmounted remotes
        if !unmounted_remotes.is_empty() {
            debug!("🔍 Detected unmounted remotes: {unmounted_remotes:?}");

            // Refresh the cache to get the latest state
            if let Err(e) = CACHE.refresh_mounted_remotes(app_handle.clone()).await {
                error!("❌ Failed to refresh mounted remotes cache: {e}");
                continue;
            }

            // Emit events for each unmounted remote
            for remote in &unmounted_remotes {
                let event_payload = serde_json::json!({
                    "fs": remote.fs,
                    "mount_point": remote.mount_point,
                    "reason": "externally_unmounted"
                });

                if let Err(e) = app_handle.emit("remote_state_changed", &event_payload) {
                    warn!("⚠️ Failed to emit remote_state_changed event: {e}");
                }

                debug!(
                    "📡 Emitted remote_state_changed event for unmounted: {}",
                    remote.fs
                );
            }
        }

        // Handle newly mounted remotes
        if !newly_mounted_remotes.is_empty() {
            debug!("🔍 Detected newly mounted remotes: {newly_mounted_remotes:?}");

            // Refresh the cache to get the latest state
            if let Err(e) = CACHE.refresh_mounted_remotes(app_handle.clone()).await {
                error!("❌ Failed to refresh mounted remotes cache: {e}");
                continue;
            }

            // Emit events for each newly mounted remote
            for remote in &newly_mounted_remotes {
                let event_payload = serde_json::json!({
                    "fs": remote.fs,
                    "mount_point": remote.mount_point,
                    "reason": "externally_mounted"
                });

                if let Err(e) = app_handle.emit("remote_state_changed", &event_payload) {
                    warn!("⚠️ Failed to emit remote_state_changed event: {e}");
                }

                debug!(
                    "📡 Emitted remote_state_changed event for mounted: {}",
                    remote.fs
                );
            }
        }

        // Update last known state with current mounts
        last_known_mounts = current_mounts;
    }
}

/// Get mounted remotes from API using the existing function
async fn get_mounted_remotes_from_api(
    app_handle: &AppHandle,
) -> Result<Vec<MountedRemote>, String> {
    let state: State<RcloneState> = app_handle.state();
    get_mounted_remotes(state).await
}

/// Stop the mounted remote watcher
pub fn stop_mounted_remote_watcher() {
    WATCHER_RUNNING.store(false, Ordering::SeqCst);
    debug!("🔍 Mounted remote watcher stop requested");
}

/// Find remotes that were previously mounted but are no longer mounted
fn find_unmounted_remotes(
    previous: &[MountedRemote],
    current: &[MountedRemote],
) -> Vec<MountedRemote> {
    previous
        .iter()
        .filter(|prev_remote| {
            // Check if this remote is still in the current list
            !current.iter().any(|curr_remote| {
                curr_remote.fs == prev_remote.fs
                    && curr_remote.mount_point == prev_remote.mount_point
            })
        })
        .cloned()
        .collect()
}

/// Force refresh mounted remotes and check for changes
/// This can be called manually when needed, for example after mount operations
#[tauri::command]
pub async fn force_check_mounted_remotes(app_handle: AppHandle) -> Result<(), String> {
    debug!("🔍 Force checking mounted remotes");

    // Get current state from cache
    let cached_mounts = CACHE.get_mounted_remotes().await.to_vec();

    // Get current state from live API using existing function
    let api_mounts = get_mounted_remotes_from_api(&app_handle).await?;

    // Check for changes between cache and API
    let unmounted_remotes = find_unmounted_remotes(&cached_mounts, &api_mounts);
    let newly_mounted = find_unmounted_remotes(&api_mounts, &cached_mounts);

    // If there are differences, update the cache
    if !unmounted_remotes.is_empty() || !newly_mounted.is_empty() {
        debug!("🔍 Detected mount changes - updating cache");
        CACHE.refresh_mounted_remotes(app_handle.clone()).await?;
    }

    // Emit events for unmounted remotes
    for remote in unmounted_remotes {
        let event_payload = serde_json::json!({
            "fs": remote.fs,
            "mount_point": remote.mount_point,
            "reason": "externally_unmounted"
        });

        if let Err(e) = app_handle.emit("remote_state_changed", &event_payload) {
            warn!("⚠️ Failed to emit remote_state_changed event: {e}");
        }

        debug!(
            "📡 Emitted remote_state_changed event for unmounted: {}",
            remote.fs
        );
    }

    // Emit events for newly mounted remotes
    for remote in newly_mounted {
        let event_payload = serde_json::json!({
            "fs": remote.fs,
            "mount_point": remote.mount_point,
            "reason": "externally_mounted"
        });

        if let Err(e) = app_handle.emit("remote_state_changed", &event_payload) {
            warn!("⚠️ Failed to emit remote_state_changed event: {e}");
        }

        debug!(
            "📡 Emitted remote_state_changed event for mounted: {}",
            remote.fs
        );
    }

    Ok(())
}
