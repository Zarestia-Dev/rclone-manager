use crate::rclone::state::watcher::{
    start_mounted_remote_watcher, start_serve_watcher, stop_mounted_remote_watcher,
    stop_serve_watcher,
};
use log::{debug, info};
use tauri::AppHandle;

/// Phase 4: Services - Starts background watchers
pub fn start_all_watchers(app_handle: &AppHandle) {
    info!("📡 Phase 4: Starting background watchers...");

    debug!("📡 Starting mounted remote watcher...");
    start_mounted_remote_watcher(app_handle.clone());

    debug!("📡 Starting serve watcher...");
    start_serve_watcher(app_handle.clone());

    info!("✅ All watchers started successfully");
}

/// Stop all active background watchers
pub fn stop_all_watchers() {
    info!("🛑 Stopping all background watchers...");
    stop_mounted_remote_watcher();
    stop_serve_watcher();
}
