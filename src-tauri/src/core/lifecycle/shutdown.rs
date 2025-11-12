use log::{debug, error, info, warn};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
// CHANGED: Removed spawn_blocking
// use tokio::task::spawn_blocking;

use crate::{
    core::scheduler::commands::SCHEDULER,
    rclone::{
        commands::{job::stop_job, mount::unmount_all_remotes, serve::stop_all_serves},
        state::{job::get_active_jobs, watcher::stop_mounted_remote_watcher},
    },
    utils::{
        process::process_manager::kill_all_rclone_processes,
        types::{all_types::RcApiEngine, events::APP_EVENT},
    },
};

#[tauri::command]
pub async fn handle_shutdown(app_handle: AppHandle) {
    info!("🔴 Beginning shutdown sequence...");

    app_handle.state::<crate::RcloneState>().set_shutting_down();

    app_handle
        .emit(
            APP_EVENT,
            json!({
                "status": "shutting_down",
                "message": "Shutting down RClone Manager"
            }),
        )
        .unwrap_or_else(|e| {
            error!("Failed to emit an app_event: {e}");
        });

    // ... (rest of the job/serve shutdown logic is unchanged) ...
    let active_jobs = match get_active_jobs().await {
        Ok(jobs) => jobs,
        Err(e) => {
            error!("Failed to get active jobs: {e}");
            vec![]
        }
    };
    let active_serves = crate::rclone::state::cache::CACHE.get_serves().await;
    if !active_jobs.is_empty() {
        let job_count = active_jobs.len();
        info!("⚠️ Stopping {job_count} active jobs during shutdown");
    }
    if !active_serves.is_empty() {
        let serve_count = active_serves.len();
        info!("⚠️ Stopping {serve_count} active serves during shutdown");
    }
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
    let stop_serves_task = tokio::time::timeout(
        tokio::time::Duration::from_secs(5),
        stop_all_serves(
            app_handle.clone(),
            app_handle.state(),
            "shutdown".to_string(),
        ),
    );
    let (unmount_result, stop_jobs_result, stop_serves_result) =
        tokio::join!(unmount_task, stop_jobs_task, stop_serves_task);

    info!("🔍 Stopping mounted remote watcher...");
    stop_mounted_remote_watcher();
    info!("🔍 Stopping serve watcher...");
    crate::rclone::state::watcher::stop_serve_watcher();

    info!("⏰ Stopping cron scheduler...");
    let scheduler_stop_task = async {
        let mut scheduler = SCHEDULER.write().await;
        scheduler.stop().await
    };
    match scheduler_stop_task.await {
        Ok(()) => info!("✅ Cron scheduler stopped successfully"),
        Err(e) => error!("❌ Failed to stop cron scheduler: {e}"),
    }

    #[cfg(desktop)]
    {
        if app_handle
            .try_state::<tauri_plugin_global_shortcut::GlobalShortcut<tauri::Wry>>()
            .is_some()
        {
            use crate::utils::shortcuts::unregister_global_shortcuts;
            info!("⌨️ Unregistering global shortcuts...");
            if let Err(e) = unregister_global_shortcuts(&app_handle) {
                error!("Failed to unregister global shortcuts: {e}");
            }
        } else {
            debug!("Global shortcut plugin not available, skipping unregister");
        }
    }

    // ... (rest of the job/serve result handling is unchanged) ...
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
    match stop_jobs_result {
        Ok(Ok(_)) => info!("✅ All jobs stopped successfully"),
        Ok(Err(e)) => error!("❌ Failed to stop all jobs: {e}"),
        Err(_) => error!("❌ Job stopping operation timed out after 5 seconds"),
    }
    match stop_serves_result {
        Ok(Ok(_)) => info!("✅ All serves stopped successfully"),
        Ok(Err(e)) => error!("❌ Failed to stop all serves: {e}"),
        Err(_) => error!("❌ Serve stopping operation timed out after 5 seconds"),
    }

    // CHANGED: Replaced spawn_blocking with a simple async block
    let engine_shutdown_task =
        tokio::time::timeout(tokio::time::Duration::from_secs(3), async move {
            info!("🔄 Shutting down engine gracefully...");
            // Await the async lock and async shutdown
            let mut engine = RcApiEngine::lock_engine().await;
            engine.shutdown().await;
            Ok::<(), String>(())
        });

    match engine_shutdown_task.await {
        Ok(Ok(_)) => info!("Engine shutdown completed successfully."),
        Ok(Err(e)) => error!("Engine shutdown task failed: {e:?}"), // This shouldn't happen with the new async block
        Err(_) => {
            error!("Engine shutdown timed out after 3 seconds, forcing cleanup");
            if let Err(e) = kill_all_rclone_processes() {
                error!("Failed to force kill rclone processes: {e}");
            }
        }
    }

    if let Some(env_manager) =
        app_handle.try_state::<crate::core::security::SafeEnvironmentManager>()
    {
        info!("🧹 Clearing in-memory RCLONE_CONFIG_PASS from SafeEnvironmentManager");
        env_manager.clear_config_password();
    } else {
        debug!("SafeEnvironmentManager not available in app state during shutdown");
    }

    app_handle.exit(0);
}

// ... (stop_all_jobs function is unchanged) ...
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
