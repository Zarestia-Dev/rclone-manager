
use std::sync::atomic::Ordering;

use log::{debug, error, info, warn};
use tauri::{AppHandle, Manager};

use crate::{
    rclone::api::{ api_command::unmount_all_remotes, engine::{stop_rc_api, RC_PROCESS, SHOULD_EXIT}},
    RcloneState,
};

/// Main entry point for handling shutdown tasks
pub async fn handle_shutdown(app_handle: AppHandle) {
    info!("🔴 Beginning shutdown sequence...");
    
    let rclone_state = app_handle.state::<RcloneState>();
    
    // Run cleanup tasks in parallel
    let unmount_result = unmount_all_remotes(app_handle.clone(), rclone_state).await;

    
    // Handle unmount results
    match unmount_result {
        Ok((success, total)) if success == total => {
            info!("✅ Successfully unmounted all {} remotes", total);
        }
        Ok((success, total)) => {
            warn!("⚠️ Only unmounted {}/{} remotes", success, total);
        }
        Err(e) => {
            error!("❌ Failed to unmount remotes: {}", e);
        }
    }

    {
        SHOULD_EXIT.store(true, Ordering::SeqCst);
        let mut process_guard = RC_PROCESS.lock().unwrap();
        stop_rc_api(&mut process_guard);
    }
    
    info!("🛑 Shutdown sequence complete");
}