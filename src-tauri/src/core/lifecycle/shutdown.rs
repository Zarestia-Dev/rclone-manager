
use log::{error, info, warn};
use tauri::{AppHandle, Manager};

use crate::{
    rclone::api::{api_command::unmount_all_remotes, engine::RcApiEngine},
    RcloneState,
};

/// Main entry point for handling shutdown tasks
pub async fn handle_shutdown(app_handle: AppHandle) {
    info!("🔴 Beginning shutdown sequence...");
    
    let rclone_state = app_handle.state::<RcloneState>();
    
    // Run cleanup tasks in parallel
    let unmount_result = unmount_all_remotes(app_handle.clone(), rclone_state, "shutdown").await;

    
    // Handle unmount results
    match unmount_result {
        Ok(info) => {
            info!("Unmounted all remotes successfully: {:?}", info);
        }
        Err(e) => {
            error!("Failed to unmount all remotes: {:?}", e);
            warn!("Some remotes may not have been unmounted properly.");
        }
    }

    
    let mut engine = RcApiEngine::lock_engine()
        .expect("Failed to acquire lock on RcApiEngine");
    engine.shutdown();
    
    info!("🛑 Shutdown sequence complete");
}