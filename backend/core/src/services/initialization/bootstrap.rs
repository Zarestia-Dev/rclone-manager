use crate::context::AppHandle;
use crate::rclone::backend::BackendManager;
use crate::services::settings::AppSettingsManager;
use log::{debug, error, info};

/// Phase 1: Bootstrap - Initializes basic state, event listeners, and environment
pub async fn init_all(app_handle: &AppHandle) -> Result<(), String> {
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
    init_engine(app_handle).await?;

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
    // Hidden dependency: These states must be managed in app/setup.rs before this is called
    let backend_manager = app_handle.try_state::<BackendManager>().ok_or_else(|| {
        "BackendManager not found in managed state. Ensure it is managed before initialization."
            .to_string()
    })?;
    let settings_state = app_handle
        .try_state::<AppSettingsManager>()
        .ok_or_else(|| {
            "AppSettingsManager not found in managed state. Ensure it is managed before initialization."
                .to_string()
        })?;

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
async fn init_engine(app_handle: &AppHandle) -> Result<(), String> {
    use crate::utils::types::state::EngineState;

    // Hidden dependency: EngineState must be managed in app/setup.rs before this is called
    let engine_state = app_handle.try_state::<EngineState>().ok_or_else(|| {
        "EngineState not found in managed state. Ensure it is managed before initialization."
            .to_string()
    })?;
    let mut engine = engine_state.lock().await;

    let is_blocked = engine.start_block_reason().is_some();
    if !engine.is_running() && !is_blocked {
        engine.init(app_handle).await;
    }

    drop(engine);
    crate::rclone::engine::poller::start_system_poller(app_handle.clone());

    Ok(())
}
