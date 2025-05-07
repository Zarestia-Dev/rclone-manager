use log::{error, info, warn};
use tauri::{AppHandle, Manager};
use tokio::task::spawn_blocking;

use crate::{
    rclone::api::{api_command::unmount_all_remotes, engine::ENGINE},
    RcloneState,
};

/// Main entry point for handling shutdown tasks
pub async fn handle_shutdown(app_handle: AppHandle) {
    info!("🔴 Beginning shutdown sequence...");
    
    let rclone_state = app_handle.state::<RcloneState>();
    
    // Run cleanup tasks in parallel
    let unmount_result = unmount_all_remotes(app_handle.clone(), rclone_state, "shutdown".to_string()).await;

    // Handle unmount results
    match unmount_result {
        Ok(info) => info!("Unmounted all remotes successfully: {:?}", info),
        Err(e) => {
            error!("Failed to unmount all remotes: {:?}", e);
            warn!("Some remotes may not have been unmounted properly.");
        }
    }

    // Perform engine shutdown in a blocking task
    let result = spawn_blocking(move || {
        match ENGINE.lock() {
             Ok(mut engine) => engine.shutdown(),
             Err(poisoned) => {
                    error!("Failed to acquire lock on RcApiEngine: {}", poisoned);
                 let mut guard = poisoned.into_inner();
                    guard.shutdown();
             }
             }
        }).await;
    if let Err(e) = result {
        error!("Failed to shutdown engine: {:?}", e);
    } else {
        info!("Engine shutdown completed successfully.");
    }

    app_handle.exit(0);
}