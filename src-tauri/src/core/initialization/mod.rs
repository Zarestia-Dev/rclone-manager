/// Initialization submodules
pub mod apply_settings;
pub mod connectivity;
pub mod scheduler;

use crate::core::settings::AppSettingsManager;
use crate::rclone::state::watcher::{start_mounted_remote_watcher, start_serve_watcher};
use log::{debug, error, info};
use tauri::Manager;

/// Initializes Rclone API and OAuth state (does not start engine)
pub async fn init_rclone_state(app_handle: &tauri::AppHandle) -> Result<(), String> {
    use crate::rclone::backend::BackendManager;

    // Load persistent connections
    let backend_manager = app_handle.state::<BackendManager>();
    let settings_state = app_handle.state::<AppSettingsManager>();

    if let Err(e) = backend_manager
        .load_from_settings(settings_state.inner())
        .await
    {
        error!("Failed to load persistent connections: {e}");
    }

    // Don't start engine here - will be started lazily when needed
    info!("🔄 Rclone engine state initialized (not started)");
    Ok(())
}

/// Handles async startup tasks
pub async fn initialization(app_handle: tauri::AppHandle) {
    use crate::rclone::engine::core::is_active_backend_local;
    use crate::utils::types::core::EngineState;

    debug!("🚀 Starting async startup tasks");

    init_rclone_state(&app_handle)
        .await
        .map_err(|e| format!("Rclone initialization failed: {e}"))
        .unwrap();

    crate::core::event_listener::setup_event_listener(&app_handle);

    // Lazy engine initialization - only start if Local backend is active
    if is_active_backend_local() {
        let engine_state = app_handle.state::<EngineState>();
        let mut engine = engine_state.lock().await;

        // Only init if not already running and no errors
        if !engine.running && !engine.path_error && !engine.password_error {
            info!("🚀 Starting Local engine (lazy init)...");
            engine.init(&app_handle).await;
        }

        // Check if initialization failed
        if engine.path_error || engine.password_error {
            info!(
                "⚠️ Engine is in error state, skipping backend connectivity checks and cache refresh"
            );
            crate::rclone::engine::lifecycle::mark_startup_complete();
            return;
        }
    } else {
        info!("📡 Remote backend is active, skipping Local engine initialization");
    }

    // Step 1: Check connectivity FIRST to ensure backend is ready
    info!("🔍 Checking backend connectivity...");
    connectivity::check_active_backend_connectivity(&app_handle).await;

    // Step 2: Refresh caches (now that we know backend is reachable)
    info!("📊 Refreshing caches...");
    use crate::rclone::backend::BackendManager;
    use crate::utils::types::core::RcloneState;

    let backend_manager = app_handle.state::<BackendManager>();
    let client = app_handle.state::<RcloneState>().client.clone();

    match backend_manager.refresh_active_backend(&client).await {
        Ok(_) => info!("✅ Caches refreshed successfully"),
        Err(e) => error!("❌ Failed to refresh caches: {e}"),
    }

    // Step 3: Initialize and start scheduler with loaded config
    info!("⏰ Initializing cron scheduler...");
    match scheduler::initialize_scheduler(app_handle.clone()).await {
        Ok(_) => {
            info!("✅ Cron scheduler initialized and started successfully");
        }
        Err(e) => {
            error!("❌ Failed to initialize cron scheduler: {}", e);
        }
    }

    // Step 4: Start watchers (both spawn internally for consistency)
    info!("📡 Starting mounted remote watcher...");
    start_mounted_remote_watcher(app_handle.clone());

    info!("📡 Starting serve watcher...");
    start_serve_watcher(app_handle.clone());

    info!("🎉 Initialization complete");

    // Enable engine health monitoring now that startup is complete
    crate::rclone::engine::lifecycle::mark_startup_complete();
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_module_structure() {
        // Verify modules are accessible
        // This is a compile-time check
    }

    // TODO: Add integration tests for full initialization flow
    // - Test initialization with Local backend
    // - Test initialization with Remote backend
    // - Test initialization with engine errors
    // - Test scheduler initialization
    // - Test watcher startup
}
