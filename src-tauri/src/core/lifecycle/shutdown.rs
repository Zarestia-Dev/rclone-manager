use log::{debug, error, info};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    core::initialization::watchers::stop_all_watchers,
    rclone::backend::BackendManager,
    rclone::{
        commands::{job::stop_job, mount::unmount_all_remotes, serve::stop_all_serves},
        engine::core::{DEFAULT_API_PORT, DEFAULT_OAUTH_PORT},
    },
    utils::{
        process::process_manager::kill_all_rclone_processes,
        types::{core::RcloneState, events::APP_EVENT, updater::AppUpdaterState},
    },
};

use crate::core::scheduler::engine::CronScheduler;

/// Main entry point for the shutdown sequence.
pub async fn handle_shutdown(app_handle: AppHandle) {
    info!("Beginning shutdown sequence...");

    let scheduler_state = app_handle.state::<CronScheduler>();

    // Run cleanup tasks concurrently with individual timeouts.
    let (unmount_result, stop_jobs_result, stop_serves_result) = tokio::join!(
        tokio::time::timeout(
            tokio::time::Duration::from_secs(5),
            unmount_all_remotes(app_handle.clone(), "shutdown".to_string()),
        ),
        tokio::time::timeout(
            tokio::time::Duration::from_secs(5),
            stop_all_active_jobs(app_handle.clone()),
        ),
        tokio::time::timeout(
            tokio::time::Duration::from_secs(5),
            stop_all_serves(app_handle.clone(), "shutdown".to_string()),
        ),
    );

    stop_all_watchers();

    #[cfg(desktop)]
    crate::core::lifecycle::auto_updater::stop_auto_updater();

    match scheduler_state.stop().await {
        Ok(()) => info!("Cron scheduler stopped."),
        Err(e) => error!("Failed to stop cron scheduler: {e}"),
    }

    if let Ok(Err(e)) = unmount_result {
        error!("Failed to unmount remotes: {e}");
    } else if unmount_result.is_err() {
        error!("Unmount operation timed out");
    }

    if let Ok(Err(e)) = stop_jobs_result {
        error!("Failed to stop all jobs: {e}");
    } else if stop_jobs_result.is_err() {
        error!("Job stopping timed out");
    }

    if let Ok(Err(e)) = stop_serves_result {
        error!("Failed to stop all serves: {e}");
    } else if stop_serves_result.is_err() {
        error!("Serve stopping timed out");
    }

    // Shut down the rclone engine with a hard timeout.
    let app_clone = app_handle.clone();
    let engine_result = tokio::time::timeout(tokio::time::Duration::from_secs(3), async move {
        let engine_state = app_clone.state::<crate::utils::types::core::EngineState>();
        engine_state.lock().await.shutdown(&app_clone).await;
        Ok::<(), String>(())
    })
    .await;

    match engine_result {
        Ok(Ok(())) => info!("Engine shutdown completed."),
        Ok(Err(e)) => error!("Engine shutdown failed: {e}"),
        Err(_) => {
            error!("Engine shutdown timed out — force-killing rclone processes");
            if let Err(e) = kill_all_rclone_processes(DEFAULT_API_PORT, DEFAULT_OAUTH_PORT) {
                error!("Force kill failed: {e}");
            }
        }
    }

    // Clear the in-memory config password so late-spawned processes can't read it.
    if let Some(env_manager) =
        app_handle.try_state::<crate::core::security::SafeEnvironmentManager>()
    {
        env_manager.clear_config_password();
        debug!("Cleared RCLONE_CONFIG_PASS from SafeEnvironmentManager");
    }

    apply_pending_updates(&app_handle).await;
}

#[tauri::command]
pub async fn shutdown_app(app: AppHandle) -> Result<(), String> {
    app.state::<RcloneState>().set_shutting_down();

    let _ = app.emit(
        APP_EVENT,
        json!({ "status": "shutting_down", "message": "Shutting down RClone Manager" }),
    );

    handle_shutdown(app.clone()).await;
    info!("Shutdown completed.");
    app.exit(0);
    Ok(())
}

/// Applies any staged updates (app or rclone) during shutdown.
async fn apply_pending_updates(app_handle: &AppHandle) {
    // App self-update (requires the 'updater' Tauri feature).
    #[cfg(desktop)]
    {
        if let Some(state) = app_handle.try_state::<AppUpdaterState>() {
            let staged = state.with_data(|d| {
                if let (Some(u), Some(s)) = (d.pending_action.take(), d.signature.take()) {
                    Some((u, s))
                } else {
                    None
                }
            });

            if let Some((update, sig)) = staged {
                info!("Applying staged app update...");
                if let Err(e) = update.install(sig) {
                    error!("Failed to apply app update: {e}");
                }
            }
        }
    }

    // Rclone update (binary swap — always available, not feature-gated).
    if let Err(e) = crate::utils::rclone::updater::apply_rclone_update_if_staged(app_handle).await {
        error!("Failed to apply rclone update during shutdown: {e}");
    }
}

async fn stop_all_active_jobs(app: AppHandle) -> Result<(), String> {
    let active_jobs = app
        .state::<BackendManager>()
        .job_cache
        .get_active_jobs()
        .await;

    if active_jobs.is_empty() {
        return Ok(());
    }

    let tasks: Vec<_> = active_jobs
        .into_iter()
        .map(|job| {
            let app = app.clone();
            tokio::spawn(async move { stop_job(app.clone(), job.jobid, job.remote_name).await })
        })
        .collect();

    let errors: Vec<String> = futures::future::join_all(tasks)
        .await
        .into_iter()
        .filter_map(|r| match r {
            Ok(Err(e)) => Some(e),
            Err(e) => Some(format!("Task panicked: {e}")),
            Ok(Ok(())) => None,
        })
        .collect();

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join(", "))
    }
}
