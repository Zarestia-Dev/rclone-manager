use log::{debug, error, info};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, async_runtime::spawn_blocking};

use crate::{
    rclone::{
        backend::BACKEND_MANAGER,
        commands::{job::stop_job, mount::unmount_all_remotes, serve::stop_all_serves},
        engine::core::ENGINE,
        state::watcher::{stop_mounted_remote_watcher, stop_serve_watcher},
    },
    utils::{
        process::process_manager::kill_all_rclone_processes,
        types::{all_types::RcloneState, events::APP_EVENT},
    },
};

use crate::core::scheduler::engine::CronScheduler;
use crate::rclone::state::scheduled_tasks::ScheduledTasksCache;
// removed global JobCache/RemoteCache imports

/// Main entry point for handling shutdown tasks
#[tauri::command]
pub async fn handle_shutdown(app_handle: AppHandle) {
    info!("🔴 Beginning shutdown sequence...");
    app_handle.state::<RcloneState>().set_shutting_down();

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

    let scheduler_state = app_handle.state::<CronScheduler>();

    // Iterate all backends to count active jobs/serves (for logging)
    let backend_names = BACKEND_MANAGER.list_names().await;
    let mut job_count = 0;
    let mut serve_count = 0;

    for name in &backend_names {
        if let Some(backend) = BACKEND_MANAGER.get(name).await {
            let guard = backend.read().await;
            job_count += guard.job_cache.get_active_jobs().await.len();
            serve_count += guard.remote_cache.get_serves().await.len();
        }
    }

    if job_count > 0 {
        info!("⚠️ Stopping {job_count} active jobs during shutdown");
    }
    if serve_count > 0 {
        info!("⚠️ Stopping {serve_count} active serves during shutdown");
    }

    // Stop everything across all backends
    // We launch tasks for all backends in parallel? Or sequential?
    // Sequential for safety for now.

    // Unmount all remotes (using global helper which currently only handles active - TODO: fix unmount_all_remotes to handle all)
    // Actually, we can loop backends here if we had a per-backend unmount_all command.
    // For now call the command, but really we should iterate.
    // Since unmount_all_remotes uses active backend, this is partial.
    // But fixing unmount_all_remotes is separate.
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
        stop_all_jobs_all_backends(app_handle.clone()),
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
    stop_serve_watcher();

    info!("⏰ Stopping cron scheduler...");
    match scheduler_state.stop().await {
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

    app_handle.exit(0);
}

async fn stop_all_jobs_all_backends(app: AppHandle) -> Result<(), String> {
    let backend_names = BACKEND_MANAGER.list_names().await;
    let mut errors = Vec::new();
    let scheduled_cache = app.state::<ScheduledTasksCache>();

    for name in backend_names {
        if let Some(backend) = BACKEND_MANAGER.get(&name).await {
            let guard = backend.read().await;
            let job_cache = guard.job_cache.clone();
            let active_jobs = job_cache.get_active_jobs().await;
            drop(guard); // drop lock before async calls

            for job in active_jobs {
                if let Err(e) = stop_job(
                    app.clone(),
                    scheduled_cache.clone(),
                    job.jobid,
                    job.remote_name.clone(),
                    app.state(),
                )
                .await
                {
                    errors.push(format!("Job {} ({}): {e}", job.jobid, name));
                }
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join(", "))
    }
}
