use crate::core::settings::AppSettingsManager;
use crate::rclone::backend::BackendManager;
use log::{debug, error, info};
use tauri::{AppHandle, Manager};

/// Phase 1: Bootstrap - Initializes basic state, event listeners, and environment
pub async fn init_all(app_handle: &AppHandle) -> Result<(), String> {
    debug!("🚀 Phase 1: Bootstrapping core state");

    // Initialize Rclone State (Backend Manager)
    init_rclone_state(app_handle).await?;

    // Apply any pending rclone updates before starting the engine
    let _ = crate::utils::rclone::updater::apply_rclone_update_if_staged(app_handle).await;

    // Initialize Alert Engine Worker
    crate::core::alerts::engine::init(app_handle.clone());

    // Setup Event Listeners
    crate::core::event_listener::setup_event_listener(app_handle);

    // Initialize Engine (Background monitoring loop)
    init_engine(app_handle).await?;

    // Monitor Network Changes (Background task)
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let handle = app_handle.clone();
        tauri::async_runtime::spawn(async move {
            crate::utils::io::network::monitor_network_changes(handle).await;
        });
    }

    Ok(())
}

/// Initializes Rclone API and OAuth state (does not start engine)
async fn init_rclone_state(app_handle: &AppHandle) -> Result<(), String> {
    // Hidden dependency: These states must be managed in lib.rs before this is called
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

    // Hidden dependency: EngineState must be managed in lib.rs before this is called
    let engine_state = app_handle.try_state::<EngineState>().ok_or_else(|| {
        "EngineState not found in managed state. Ensure it is managed before initialization."
            .to_string()
    })?;
    let mut engine = engine_state.lock().await;

    if !engine.running && !engine.path_error && !engine.password_error {
        engine.init(app_handle).await;
    }

    Ok(())
}
