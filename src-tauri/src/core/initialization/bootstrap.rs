use crate::core::security::SafeEnvironmentManager;
use crate::core::settings::AppSettingsManager;
use crate::rclone::backend::BackendManager;
use log::{debug, error, info};
use tauri::{AppHandle, Manager};

/// Phase 1: Bootstrap - Initializes basic state, event listeners, and environment
pub async fn init_all(app_handle: &AppHandle) -> Result<(), String> {
    debug!("🚀 Phase 1: Bootstrapping core state");

    // 1. Initialize Rclone State (Backend Manager)
    init_rclone_state(app_handle).await?;

    // 2. Initialize Security Environment
    init_security_environment(app_handle)?;

    // 3. Initialize Alert Engine Worker
    crate::core::alerts::engine::init();

    // 4. Setup Event Listeners
    crate::core::event_listener::setup_event_listener(app_handle);

    // 5. Initialize Engine (Background monitoring loop)
    init_engine(app_handle).await;

    // 6. Monitor Network Changes (Background task)
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

/// Initialize the SafeEnvironmentManager with stored credentials
fn init_security_environment(app_handle: &AppHandle) -> Result<(), String> {
    if let Some(env_manager) = app_handle.try_state::<SafeEnvironmentManager>() {
        let settings_state = app_handle.state::<AppSettingsManager>();
        if let Err(e) = env_manager.init_with_stored_credentials(settings_state.inner()) {
            error!("⚠️ Failed to initialize environment manager: {e}");
        }
    }
    Ok(())
}

/// Initialize the engine monitoring loop
async fn init_engine(app_handle: &AppHandle) {
    use crate::utils::types::core::EngineState;

    let engine_state = app_handle.state::<EngineState>();
    let mut engine = engine_state.lock().await;

    if !engine.running && !engine.path_error && !engine.password_error {
        engine.init(app_handle).await;
    }
}
