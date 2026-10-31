use crate::context::AppHandle;
use log::{debug, error, info};
use serde_json::json;

use crate::{
    rclone::{
        backend::BackendManager,
        commands::{job::stop_job_on_backend, mount::unmount_all_remotes, serve::stop_all_serves},
    },
    services::{automation::engine::AutomationScheduler, bridge},
    utils::types::{events::APP_EVENT, state::RcloneState},
};

/// Longest shutdown waits for in-flight initialization before tearing services down anyway.
const INITIALIZATION_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// Engine shutdown must outlast the graceful-exit wait, otherwise its forced kill is cut
/// off before it can run.
#[cfg(not(feature = "librclone"))]
const ENGINE_SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(
    crate::rclone::binaries::process_common::GRACEFUL_SHUTDOWN_TIMEOUT.as_secs() + 2,
);
#[cfg(feature = "librclone")]
const ENGINE_SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

#[derive(Default)]
struct ShutdownState(tokio::sync::OnceCell<()>);

impl ShutdownState {
    async fn run(&self, cleanup: impl std::future::Future<Output = ()>) {
        self.0.get_or_init(|| cleanup).await;
    }
}

/// Concurrent exit requests share one completed cleanup sequence.
pub async fn handle_shutdown(app_handle: AppHandle) {
    app_handle.manage(ShutdownState::default());
    let state = app_handle.state::<ShutdownState>();
    state.run(shutdown(app_handle)).await;
}

async fn shutdown(app_handle: AppHandle) {
    info!("Beginning shutdown sequence...");

    let runtime = app_handle.state::<RcloneState>();
    runtime.set_shutting_down();
    // Let in-flight initialization finish before tearing its services down. A slow
    // auto-start must not keep the app from exiting.
    let _startup =
        match tokio::time::timeout(INITIALIZATION_WAIT, runtime.initialization_lock.lock()).await {
            Ok(guard) => Some(guard),
            Err(_) => {
                error!("Initialization is still running; shutting down without waiting for it");
                None
            }
        };

    bridge::emit(
        APP_EVENT,
        json!({ "status": "shutting_down", "message": "Shutting down RClone Manager" }),
    );

    #[cfg(all(
        feature = "desktop",
        not(any(target_os = "android", target_os = "ios"))
    ))]
    if let Some(power_state) = app_handle.try_state::<crate::services::power::PowerInhibitorState>()
    {
        power_state.release().await;
    }

    let scheduler_state = app_handle.state::<AutomationScheduler>();

    if let Some(watcher_manager) =
        app_handle.try_state::<crate::services::automation::watcher::WatcherManager>()
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

    crate::services::lifecycle::auto_updater::stop_auto_updater(&app_handle);

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
    let engine_result = tokio::time::timeout(ENGINE_SHUTDOWN_TIMEOUT, async move {
        let engine_state = app_clone.state::<crate::utils::types::state::EngineState>();
        engine_state.lock().await.shutdown(&app_clone).await;
        Ok::<(), String>(())
    })
    .await;

    match engine_result {
        Ok(Ok(())) => info!("Engine shutdown completed."),
        Ok(Err(e)) => error!("Engine shutdown failed: {e}"),
        #[cfg(not(feature = "librclone"))]
        Err(_) => {
            error!("Engine shutdown timed out — force-killing rclone processes");
            // The engine's child always belongs to the Local backend, whichever one is active.
            let local = app_handle
                .state::<BackendManager>()
                .get(crate::utils::constants::LOCAL_BACKEND_NAME)
                .await;
            if let Some(local) = local
                && let Err(e) =
                    crate::utils::process::process_manager::kill_all_rclone_processes(local.port)
            {
                error!("Force kill failed: {e}");
            }
        }
        #[cfg(feature = "librclone")]
        Err(_) => {}
    }

    // Clear the in-memory config password so late-spawned processes can't read it.
    if let Some(env_manager) =
        app_handle.try_state::<crate::services::security::SafeEnvironmentManager>()
    {
        env_manager.clear_config_password();
        debug!("Cleared RCLONE_CONFIG_PASS from SafeEnvironmentManager");
    }

    // Clear temporary file preview/viewer cache files
    app_handle.host().cleanup();

    #[cfg(not(feature = "librclone"))]
    apply_pending_updates(&app_handle).await;
}

pub async fn shutdown_app(app: AppHandle) -> Result<(), String> {
    handle_shutdown(app.clone()).await;
    info!("Shutdown completed.");
    app.exit(0);
    Ok(())
}

/// Applies any staged updates (app or rclone) during shutdown.
#[cfg(not(feature = "librclone"))]
async fn apply_pending_updates(app_handle: &AppHandle) {
    // Rclone update (binary swap — only available on desktop).
    #[cfg(not(feature = "librclone"))]
    if let Err(e) =
        crate::rclone::binaries::updater::apply_rclone_update_if_staged(app_handle).await
    {
        error!("Failed to apply rclone update during shutdown: {e}");
    }
}

pub async fn stop_all_active_jobs(app: AppHandle) -> Result<(), String> {
    let manager = app.state::<BackendManager>();
    let mut tasks = Vec::new();
    for info in manager.list_all().await {
        let Some(backend) = manager.get(&info.name).await else {
            continue;
        };
        for job in manager.job_cache_for(&backend.name).get_active_jobs().await {
            let app = app.clone();
            let backend = backend.clone();
            tasks.push(crate::utils::spawn(async move {
                stop_job_on_backend(app, backend, job.jobid, job.remote_name).await
            }));
        }
    }

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

/// Stops every active job for a user request (tray or notification action) and says so.
pub async fn stop_all_active_jobs_with_notice(app: AppHandle) {
    use crate::utils::app::notification::{NotificationEvent, SystemStage, notify};
    match stop_all_active_jobs(app.clone()).await {
        Ok(()) => notify(&app, NotificationEvent::System(SystemStage::AllJobsStopped)),
        Err(e) => error!("Failed to stop all active jobs: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::ShutdownState;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn concurrent_and_later_requests_wait_for_one_cleanup() {
        let state = ShutdownState::default();
        let completed = AtomicUsize::new(0);
        let cleanup = || async {
            tokio::task::yield_now().await;
            completed.fetch_add(1, Ordering::SeqCst);
        };
        tokio::join!(state.run(cleanup()), async {
            state.run(cleanup()).await;
            assert_eq!(completed.load(Ordering::SeqCst), 1);
        });
        state.run(cleanup()).await;
        assert_eq!(completed.load(Ordering::SeqCst), 1);
    }
}
