use log::{debug, error, info};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    core::automation::engine::AutomationScheduler,
    rclone::{
        backend::BackendManager,
        commands::{job::stop_job, mount::unmount_all_remotes, serve::stop_all_serves},
    },
    utils::types::{events::APP_EVENT, state::RcloneState},
};

#[cfg(not(feature = "librclone"))]
use crate::rclone::engine::core::{DEFAULT_API_PORT, DEFAULT_OAUTH_PORT};

/// Main entry point for the shutdown sequence.
pub async fn handle_shutdown(app_handle: AppHandle) {
    info!("Beginning shutdown sequence...");

    let scheduler_state = app_handle.state::<AutomationScheduler>();

    if let Some(watcher_manager) =
        app_handle.try_state::<crate::core::automation::watcher::WatcherManager>()
    {
        watcher_manager.stop_all().await;
    }

    // Run cleanup tasks concurrently with individual timeouts.
    let (unmount_result, stop_jobs_result, stop_serves_result) = tokio::join!(
        tokio::time::timeout(
            tokio::time::Duration::from_secs(5),
            unmount_all_remotes(
                app_handle.clone(),
                crate::rclone::commands::common::OperationContext::Shutdown,
            ),
        ),
        tokio::time::timeout(
            tokio::time::Duration::from_secs(5),
            stop_all_active_jobs(app_handle.clone()),
        ),
        tokio::time::timeout(
            tokio::time::Duration::from_secs(5),
            stop_all_serves(
                app_handle.clone(),
                crate::rclone::commands::common::OperationContext::Shutdown,
            ),
        ),
    );

    #[cfg(feature = "updater")]
    crate::core::lifecycle::auto_updater::stop_auto_updater(&app_handle);

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
    #[cfg(not(feature = "librclone"))]
    let engine_result = tokio::time::timeout(tokio::time::Duration::from_secs(3), async move {
        let engine_state = app_clone.state::<crate::utils::types::state::EngineState>();
        engine_state.lock().await.shutdown(&app_clone).await;
        Ok::<(), String>(())
    })
    .await;

    #[cfg(feature = "librclone")]
    let _ = tokio::time::timeout(tokio::time::Duration::from_secs(3), async move {
        let engine_state = app_clone.state::<crate::utils::types::state::EngineState>();
        engine_state.lock().await.shutdown(&app_clone).await;
        Ok::<(), String>(())
    })
    .await;

    #[cfg(not(feature = "librclone"))]
    {
        match engine_result {
            Ok(Ok(())) => info!("Engine shutdown completed."),
            Ok(Err(e)) => error!("Engine shutdown failed: {e}"),
            Err(_) => {
                error!("Engine shutdown timed out — force-killing rclone processes");
                if let Err(e) = crate::utils::process::process_manager::kill_all_rclone_processes(
                    DEFAULT_API_PORT,
                    DEFAULT_OAUTH_PORT,
                ) {
                    error!("Force kill failed: {e}");
                }
            }
        }

        // Kill the OAuth subprocess if it's still alive.
        let state = app_handle.state::<RcloneState>();
        if let Some(mut child) = state.oauth_process.lock().await.take() {
            info!("Killing OAuth process during shutdown");
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }

    // Clear the in-memory config password so late-spawned processes can't read it.
    if let Some(env_manager) =
        app_handle.try_state::<crate::core::security::SafeEnvironmentManager>()
    {
        env_manager.clear_config_password();
        debug!("Cleared RCLONE_CONFIG_PASS from SafeEnvironmentManager");
    }

    #[cfg(any(feature = "updater", not(feature = "librclone")))]
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
#[cfg(any(feature = "updater", not(feature = "librclone")))]
async fn apply_pending_updates(app_handle: &AppHandle) {
    // App self-update (requires the 'updater' Tauri feature).
    #[cfg(feature = "updater")]
    if let Some(state) = app_handle.try_state::<crate::utils::types::updater::AppUpdaterState>() {
        let staged: Option<(tauri_plugin_updater::Update, Vec<u8>)> = {
            let mut d = state.data.lock();
            if let (Some(u), Some(s)) = (d.pending_action.take(), d.signature.take()) {
                d.state = crate::utils::types::updater::UpdateState::Idle;
                Some((u, s))
            } else {
                None
            }
        };

        if let Some((update, sig)) = staged {
            info!("Applying staged app update...");
            if let Err(e) = update.install(sig) {
                error!("Failed to apply app update: {e}");
            }
        }
    }

    // Rclone update (binary swap — only available on desktop).
    #[cfg(not(feature = "librclone"))]
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
