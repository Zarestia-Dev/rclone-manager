use log::{debug, error, info};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    rclone::{
        commands::{job::stop_job, mount::unmount_all_remotes, serve::stop_all_serves},
        state::watcher::{stop_mounted_remote_watcher, stop_serve_watcher},
    },
    utils::{
        process::process_manager::kill_all_rclone_processes,
        types::{core::RcloneState, events::APP_EVENT},
    },
};

use crate::core::scheduler::engine::CronScheduler;
use crate::rclone::state::scheduled_tasks::ScheduledTasksCache;

/// Main entry point for handling shutdown tasks
pub async fn handle_shutdown(app_handle: AppHandle) {
    info!("🔴 Beginning shutdown sequence...");

    let scheduler_state = app_handle.state::<CronScheduler>();

    // Unmount all remotes (using global helper which currently only handles active)
    let unmount_task = tokio::time::timeout(
        tokio::time::Duration::from_secs(5),
        unmount_all_remotes(app_handle.clone(), "shutdown".to_string()),
    );

    let stop_jobs_task = tokio::time::timeout(
        tokio::time::Duration::from_secs(5),
        stop_all_active_jobs(app_handle.clone()),
    );

    let stop_serves_task = tokio::time::timeout(
        tokio::time::Duration::from_secs(5),
        stop_all_serves(app_handle.clone(), "shutdown".to_string()),
    );

    let (unmount_result, stop_jobs_result, stop_serves_result) =
        tokio::join!(unmount_task, stop_jobs_task, stop_serves_task);

    info!("🔍 Stopping mounted remote watcher...");
    stop_mounted_remote_watcher();
    info!("🔍 Stopping serve watcher...");
    stop_serve_watcher();

    info!("🛑 Stopping auto updater...");
    #[cfg(all(desktop, feature = "updater"))]
    crate::core::lifecycle::auto_updater::stop_auto_updater();

    info!("⏰ Stopping cron scheduler...");
    match scheduler_state.stop().await {
        Ok(()) => info!("✅ Cron scheduler stopped successfully"),
        Err(e) => error!("❌ Failed to stop cron scheduler: {e}"),
    }

    match unmount_result {
        Ok(Ok(info)) => info!("Unmounted remotes: {info:?}"),
        Ok(Err(e)) => {
            error!("Failed to unmount remotes: {e}");
        }
        Err(_) => {
            error!("Unmount operation timed out");
        }
    }
    match stop_jobs_result {
        Ok(Ok(_)) => info!("✅ All jobs stopped successfully"),
        Ok(Err(e)) => error!("❌ Failed to stop all jobs: {e}"),
        Err(_) => error!("❌ Job stopping operation timed out"),
    }
    match stop_serves_result {
        Ok(Ok(_)) => info!("✅ All serves stopped successfully"),
        Ok(Err(e)) => error!("❌ Failed to stop all serves: {e}"),
        Err(_) => error!("❌ Serve stopping operation timed out"),
    }

    // Perform engine shutdown with timeout
    let app_handle_clone = app_handle.clone();
    let engine_shutdown_task =
        tokio::time::timeout(tokio::time::Duration::from_secs(3), async move {
            use crate::utils::types::core::EngineState;
            let engine_state = app_handle_clone.state::<EngineState>();
            let mut engine = engine_state.lock().await;
            engine.shutdown(&app_handle_clone).await;
            Ok::<(), String>(())
        });

    match engine_shutdown_task.await {
        Ok(Ok(_)) => info!("Engine shutdown completed successfully."),
        Ok(Err(e)) => error!("Engine shutdown task failed: {e:?}"),
        Err(_) => {
            error!("Engine shutdown timed out after 3 seconds, forcing cleanup");
            // Force kill any remaining rclone processes on OUR managed ports as a last resort
            if let Err(e) = kill_all_rclone_processes(51900, 51901) {
                error!("Failed to force kill rclone processes: {e}");
            }
        }
    }

    // Clear any in-memory config password (RCLONE_CONFIG_PASS) from our safe
    // environment manager so it isn't leaked into future processes.
    // Note: this is technically unnecessary because SafeEnvironmentManager
    // lives in-process and will be dropped when the application exits, but
    // we keep the explicit clear as a defensive measure — it documents intent
    // and ensures no accidental late spawns during shutdown can read the
    // secret. Do NOT remove the stored password from keyring here; that is
    // managed separately by user actions.
    if let Some(env_manager) =
        app_handle.try_state::<crate::core::security::SafeEnvironmentManager>()
    {
        info!("🧹 Clearing in-memory RCLONE_CONFIG_PASS from SafeEnvironmentManager");
        env_manager.clear_config_password();
    } else {
        debug!("SafeEnvironmentManager not available in app state during shutdown");
    }

    apply_pending_updates_on_shutdown(&app_handle).await;
}

#[tauri::command]
pub async fn shutdown_app(app: AppHandle) -> Result<(), String> {
    app.state::<RcloneState>().set_shutting_down();

    let _ = app.emit(
        APP_EVENT,
        json!({
            "status": "shutting_down",
            "message": "Shutting down RClone Manager"
        }),
    );

    handle_shutdown(app.clone()).await;
    info!("✅ Shutdown completed successfully");

    app.exit(0);
    Ok(())
}

async fn apply_pending_updates_on_shutdown(app_handle: &AppHandle) {
    #[cfg(all(desktop, feature = "updater"))]
    {
        use crate::utils::types::updater::AppUpdaterState;

        if let Some(updater_state) = app_handle.try_state::<AppUpdaterState>() {
            let mut pending = match updater_state.pending_action.lock() {
                Ok(lock) => lock,
                Err(e) => {
                    error!("Failed to lock pending app update during shutdown: {e}");
                    return;
                }
            };

            let mut signature = match updater_state.signature.lock() {
                Ok(lock) => lock,
                Err(e) => {
                    error!("Failed to lock app update signature during shutdown: {e}");
                    return;
                }
            };

            if let (Some(update), Some(sig)) = (pending.take(), signature.take()) {
                info!("Applying pending app update during shutdown...");
                if let Err(e) = update.install(sig) {
                    error!("Failed to apply app update during shutdown: {e}");
                }
            }
        }
    }

    use crate::utils::types::updater::RcloneUpdaterState;
    if let Some(rclone_updater_state) = app_handle.try_state::<RcloneUpdaterState>() {
        let has_pending = match rclone_updater_state.pending_version.lock() {
            Ok(pending_version) => pending_version.is_some(),
            Err(e) => {
                error!("Failed to lock pending rclone update version during shutdown: {e}");
                false
            }
        };

        if has_pending {
            info!("Applying pending rclone update during shutdown...");
            if let Err(e) =
                crate::utils::rclone::updater::activate_pending_rclone_update(app_handle).await
            {
                error!("Failed to apply rclone update during shutdown: {e}");
            }
        }
    }
}

async fn stop_all_active_jobs(app: AppHandle) -> Result<(), String> {
    use crate::rclone::backend::BackendManager;
    let backend_manager = app.state::<BackendManager>();
    let job_cache = &backend_manager.job_cache;
    let active_jobs = job_cache.get_active_jobs().await;

    if active_jobs.is_empty() {
        return Ok(());
    }

    let mut tasks = Vec::new();

    for job in active_jobs {
        let app_clone = app.clone();
        let remote_name = job.remote_name.clone();
        let jobid = job.jobid;

        tasks.push(tokio::spawn(async move {
            let scheduled_cache = app_clone.state::<ScheduledTasksCache>();
            let app_to_stop = app_clone.clone();
            stop_job(app_to_stop, scheduled_cache, jobid, remote_name).await
        }));
    }

    let results = futures::future::join_all(tasks).await;
    let mut errors = Vec::new();

    for result in results {
        match result {
            Ok(Err(e)) => errors.push(e),
            Err(e) => errors.push(format!("Task panic/failed: {e}")),
            Ok(Ok(_)) => {}
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join(", "))
    }
}
