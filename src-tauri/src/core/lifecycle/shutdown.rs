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

    // Set the shutdown flag immediately to prevent new operations
    app_handle.state::<crate::RcloneState>().set_shutting_down();

    app_handle
        .emit("shutdown_sequence", ())
        .unwrap_or_else(|e| {
            error!("Failed to emit shutdown_sequence event: {e}");
        });

    // Get active jobs before shutdown
    let active_jobs = match get_active_jobs().await {
        Ok(jobs) => jobs,
        Err(e) => {
            error!("Failed to get active jobs: {e}");
            vec![]
        }
    };

    // If there are active jobs, notify UI
    if !active_jobs.is_empty() {
        let job_count = active_jobs.len();
        info!("⚠️ Stopping {job_count} active jobs during shutdown");

        if let Err(e) = app_handle.emit(
            "shutdown_jobs_notification",
            format!("Stopping {job_count} active jobs"),
        ) {
            error!("Failed to emit jobs notification: {e}");
        }
    }

    // Run cleanup tasks in parallel with individual timeouts
    let unmount_task = tokio::time::timeout(
        tokio::time::Duration::from_secs(5),
        unmount_all_remotes(
            app_handle.clone(),
            app_handle.state(),
            "shutdown".to_string(),
        ),
    );

    let stop_jobs_task = tokio::time::timeout(
        tokio::time::Duration::from_secs(5),
        stop_all_jobs(app_handle.clone()),
    );

    let (unmount_result, stop_jobs_result) = tokio::join!(unmount_task, stop_jobs_task);

    // Stop the mounted remote watcher
    info!("🔍 Stopping mounted remote watcher...");
    stop_mounted_remote_watcher();

    // // Unregister global shortcuts
    // #[cfg(desktop)]
    // {
    //     info!("⌨️ Unregistering global shortcuts...");
    //     if let Err(e) = unregister_global_shortcuts(&app_handle) {
    //         error!("Failed to unregister global shortcuts: {e}");
    //     }
    // }

    // Handle unmount results
    match unmount_result {
        Ok(Ok(info)) => info!("Unmounted all remotes successfully: {info:?}"),
        Ok(Err(e)) => {
            error!("Failed to unmount all remotes: {e}");
            warn!("Some remotes may not have been unmounted properly.");
        }
        Err(_) => {
            error!("Unmount operation timed out after 5 seconds");
            warn!("Some remotes may not have been unmounted properly.");
        }
    }

    // Handle job stopping results
    match stop_jobs_result {
        Ok(Ok(_)) => info!("All jobs stopped successfully"),
        Ok(Err(e)) => error!("Failed to stop all jobs: {e}"),
        Err(_) => error!("Job stopping operation timed out after 5 seconds"),
    }

    // Perform engine shutdown in a blocking task with timeout
    let engine_shutdown_task = tokio::time::timeout(
        tokio::time::Duration::from_secs(3),
        spawn_blocking(move || -> Result<(), String> {
            match ENGINE.lock() {
                Ok(mut engine) => {
                    info!("🔄 Shutting down engine gracefully...");
                    engine.shutdown();
                    Ok(())
                }
                Err(poisoned) => {
                    error!("Failed to acquire lock on RcApiEngine: {poisoned}");
                    let mut guard = poisoned.into_inner();
                    guard.shutdown();
                    Ok(())
                }
            }
        }),
    );

    match engine_shutdown_task.await {
        Ok(Ok(Ok(_))) => info!("Engine shutdown completed successfully."),
        Ok(Ok(Err(e))) => error!("Engine shutdown task failed: {e:?}"),
        Ok(Err(e)) => error!("Failed to spawn engine shutdown task: {e:?}"),
        Err(_) => {
            error!("Engine shutdown timed out after 3 seconds, forcing cleanup");
            // Force kill any remaining rclone processes as a last resort
            if let Err(e) = crate::utils::process::kill_all_rclone_processes() {
                error!("Failed to force kill rclone processes: {e}");
            }
        }
    }

    app_handle.exit(0);
}

/// Stop all active jobs
async fn stop_all_jobs(app: AppHandle) -> Result<(), String> {
    let active_jobs = get_active_jobs().await?;
    let mut errors = Vec::new();

    for job in active_jobs {
        if let Err(e) = stop_job(app.clone(), job.jobid, "".to_string(), app.state()).await {
            errors.push(format!("Job {}: {e}", job.jobid));
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join(", "))
    }
}
