/// Initialization submodules
pub mod apply_settings;
pub mod connectivity;
pub mod scheduler;

use crate::core::settings::AppSettingsManager;
use crate::rclone::backend::BackendManager;
use crate::rclone::state::watcher::{start_mounted_remote_watcher, start_serve_watcher};
use crate::utils::types::core::{EngineState, RcloneState};
use log::{debug, error, info};
use tauri::Manager;

/// Initializes Rclone API and OAuth state (does not start engine)
pub async fn init_rclone_state(app_handle: &tauri::AppHandle) -> Result<(), String> {
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
    debug!("🚀 Starting async startup tasks");

    init_rclone_state(&app_handle)
        .await
        .map_err(|e| format!("Rclone initialization failed: {e}"))
        .unwrap();

    crate::core::event_listener::setup_event_listener(&app_handle);

    // Always initialize the engine – this starts the background monitoring loop
    // regardless of which backend is active. The engine process itself is only
    // started when Local is the active backend (RcApiEngine::init handles this
    // internally). Without this call the health-check loop never spawns, so
    // switching back to Local at runtime would leave the engine un-monitored.
    {
        let engine_state = app_handle.state::<EngineState>();
        let mut engine = engine_state.lock().await;

        if !engine.running && !engine.path_error && !engine.password_error {
            engine.init(&app_handle).await;
        }
    }

    // Step 1: Check connectivity FIRST to ensure backend is ready
    info!("🔍 Checking backend connectivity...");
    connectivity::check_active_backend_connectivity(&app_handle).await;

    // Step 2: Refresh caches (now that we know backend is reachable)
    info!("📊 Refreshing caches...");

    let backend_manager = app_handle.state::<BackendManager>();
    let client = app_handle.state::<RcloneState>().client.clone();

    match crate::rclone::backend::cache::refresh_active_backend(&backend_manager, &client).await {
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

    // Step 5: Start Auto Updater
    #[cfg(all(desktop, feature = "updater"))]
    crate::core::lifecycle::auto_updater::init_auto_updater(app_handle.clone());

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
