use crate::context::AppHandle;
use crate::rclone::backend::BackendManager;
use crate::services::settings::AppSettingsManager;
use log::{debug, error, info};

/// Lets a retried startup skip the bootstrap an earlier attempt already completed.
/// Managed by `setup_context`.
#[derive(Default)]
pub(crate) struct BootstrapState(tokio::sync::OnceCell<()>);

impl BootstrapState {
    async fn run(
        &self,
        setup: impl std::future::Future<Output = Result<(), String>>,
    ) -> Result<(), String> {
        self.0.get_or_try_init(|| setup).await.copied()
    }
}

/// Phase 1: Bootstrap - Initializes basic state, event listeners, and environment
pub async fn init_all(app_handle: &AppHandle) -> Result<(), String> {
    app_handle
        .state::<BootstrapState>()
        .run(bootstrap(app_handle))
        .await
}

async fn bootstrap(app_handle: &AppHandle) -> Result<(), String> {
    debug!("🚀 Phase 1: Bootstrapping core state");

    // Initialize Rclone State (Backend Manager)
    init_rclone_state(app_handle).await?;

    // Apply any pending rclone updates before starting the engine
    #[cfg(not(feature = "librclone"))]
    let _ = crate::rclone::binaries::updater::apply_rclone_update_if_staged(app_handle).await;

    // Initialize Alert Engine Worker
    crate::services::alerts::engine::init(app_handle.clone());

    // Setup Event Listeners
    crate::services::event_listener::setup_event_listener(app_handle);

    // Initialize Engine (Background monitoring loop)
    init_engine(app_handle).await;

    // Initialize native system theme detection
    app_handle.host().init_theme();

    // Monitor Network Changes (Background task)
    #[cfg(not(target_os = "ios"))]
    {
        crate::utils::spawn(async move {
            crate::utils::io::network::monitor_network_changes().await;
        });
    }

    // Monitor OS Theme Changes (Background task)
    app_handle.host().monitor_theme();

    Ok(())
}

/// Initializes Rclone API and OAuth state (does not start engine)
async fn init_rclone_state(app_handle: &AppHandle) -> Result<(), String> {
    let backend_manager = app_handle.state::<BackendManager>();
    let settings_state = app_handle.state::<AppSettingsManager>();

    if let Err(e) = backend_manager
        .load_from_settings(settings_state.inner())
        .await
    {
        error!("Failed to load persistent connections: {e}");
        return Err(format!("Failed to load persistent connections: {e}"));
    }

    info!("🔄 Rclone engine state initialized");
    Ok(())
}

/// Initialize the engine monitoring loop
async fn init_engine(app_handle: &AppHandle) {
    use crate::utils::types::state::EngineState;

    let engine_state = app_handle.state::<EngineState>();
    let mut engine = engine_state.lock().await;

    let is_blocked = engine.start_block_reason().is_some();
    if !engine.is_running() && !is_blocked {
        engine.init(app_handle).await;
    }

    drop(engine);
    crate::rclone::engine::poller::start_system_poller(app_handle.clone());
}

#[cfg(test)]
mod tests {
    use super::BootstrapState;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn concurrent_and_later_startup_attempts_share_successful_bootstrap() {
        let state = BootstrapState::default();
        let observers = AtomicUsize::new(0);
        let setup = || async {
            tokio::task::yield_now().await;
            observers.fetch_add(1, Ordering::SeqCst);
            Ok(())
        };
        let (first, second) = tokio::join!(state.run(setup()), state.run(setup()));
        first.unwrap();
        second.unwrap();
        state.run(setup()).await.unwrap();
        assert_eq!(observers.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn failed_bootstrap_can_retry_without_marking_services_initialized() {
        let state = BootstrapState::default();
        assert!(
            state
                .run(async { Err("engine unavailable".into()) })
                .await
                .is_err()
        );
        assert!(state.0.get().is_none());
        state.run(async { Ok(()) }).await.unwrap();
        assert!(state.0.get().is_some());
    }

    #[tokio::test]
    async fn cancelled_bootstrap_does_not_prevent_the_next_attempt() {
        let state = std::sync::Arc::new(BootstrapState::default());
        let entered = std::sync::Arc::new(tokio::sync::Notify::new());
        let task_state = state.clone();
        let task_entered = entered.clone();
        let attempt = crate::utils::spawn(async move {
            task_state
                .run(async {
                    task_entered.notify_one();
                    std::future::pending::<Result<(), String>>().await
                })
                .await
        });
        entered.notified().await;
        attempt.abort();
        assert!(attempt.await.unwrap_err().is_cancelled());
        state.run(async { Ok(()) }).await.unwrap();
        assert!(state.0.get().is_some());
    }
}
