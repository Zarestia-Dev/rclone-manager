use log::{error, info, warn};
use tauri::{AppHandle, Emitter, Manager};
use tokio::task::spawn_blocking;

use crate::rclone::{
    commands::{stop_job, unmount_all_remotes},
    engine::ENGINE,
    state::{get_active_jobs, stop_mounted_remote_watcher},
};
// use crate::utils::shortcuts::unregister_global_shortcuts;

/// Main entry point for handling shutdown tasks
#[tauri::command]
pub async fn handle_shutdown(app_handle: AppHandle) {
    info!("🔴 Beginning shutdown sequence...");
    app_handle
        .emit("shutdown_sequence", ())
        .unwrap_or_else(|e| {
            error!("Failed to emit shutdown_sequence event: {}", e);
        });

    // Get active jobs before shutdown
    let active_jobs = match get_active_jobs().await {
        Ok(jobs) => jobs,
        Err(e) => {
            error!("Failed to get active jobs: {}", e);
            vec![]
        }
    };

    // If there are active jobs, notify UI
    if !active_jobs.is_empty() {
        let job_count = active_jobs.len();
        info!("⚠️ Stopping {} active jobs during shutdown", job_count);

        if let Err(e) = app_handle.emit(
            "shutdown_jobs_notification",
            format!("Stopping {} active jobs", job_count),
        ) {
            error!("Failed to emit jobs notification: {}", e);
        }
    }

    // Run cleanup tasks in parallel
    let (unmount_result, stop_jobs_result) = tokio::join!(
        unmount_all_remotes(
            app_handle.clone(),
            app_handle.state(),
            "shutdown".to_string()
        ),
        stop_all_jobs(app_handle.clone())
    );

    // Stop the mounted remote watcher
    info!("🔍 Stopping mounted remote watcher...");
    stop_mounted_remote_watcher();

    // // Unregister global shortcuts
    // #[cfg(desktop)]
    // {
    //     info!("⌨️ Unregistering global shortcuts...");
    //     if let Err(e) = unregister_global_shortcuts(&app_handle) {
    //         error!("Failed to unregister global shortcuts: {}", e);
    //     }
    // }

    // Handle unmount results
    match unmount_result {
        Ok(info) => info!("Unmounted all remotes successfully: {:?}", info),
        Err(e) => {
            error!("Failed to unmount all remotes: {:?}", e);
            warn!("Some remotes may not have been unmounted properly.");
        }
    }

    // Handle job stopping results
    if let Err(e) = stop_jobs_result {
        error!("Failed to stop all jobs: {}", e);
    }

    // Perform engine shutdown in a blocking task
    let result = spawn_blocking(move || match ENGINE.lock() {
        Ok(mut engine) => engine.shutdown(),
        Err(poisoned) => {
            error!("Failed to acquire lock on RcApiEngine: {}", poisoned);
            let mut guard = poisoned.into_inner();
            guard.shutdown();
        }
    })
    .await;

    if let Err(e) = result {
        error!("Failed to shutdown engine: {:?}", e);
    } else {
        info!("Engine shutdown completed successfully.");
    }

    app_handle.exit(0);
}

/// Stop all active jobs
async fn stop_all_jobs(app: AppHandle) -> Result<(), String> {
    let active_jobs = get_active_jobs().await?;
    let mut errors = Vec::new();

    for job in active_jobs {
        if let Err(e) = stop_job(app.clone(), job.jobid, "".to_string(), app.state()).await {
            errors.push(format!("Job {}: {}", job.jobid, e));
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join(", "))
    }
}
