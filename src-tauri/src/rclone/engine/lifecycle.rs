use log::{debug, error, info, warn};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

// Timeout and interval constants
const API_READY_TIMEOUT_SECS: u64 = 10;
const MONITORING_INTERVAL_SECS: u64 = if cfg!(test) { 1 } else { 5 };

#[cfg(desktop)]
use crate::core::tray::core::update_tray_menu;

use crate::{
    core::{
        initialization::apply_core_settings, settings::operations::core::load_startup_settings,
    },
    rclone::backend::BACKEND_MANAGER,
    utils::types::{
        all_types::{RcApiEngine, RcloneState},
        events::{
            ENGINE_RESTARTED, RCLONE_ENGINE_ERROR, RCLONE_ENGINE_PASSWORD_ERROR,
            RCLONE_ENGINE_PATH_ERROR, RCLONE_ENGINE_READY,
        },
    },
};
use rcman::{JsonStorage, SettingsManager};

// Mobile no-op stub for update_tray_menu
#[cfg(not(desktop))]
async fn update_tray_menu(_app: AppHandle, _max_items: usize) -> Result<(), String> {
    Ok(())
}

// Use the cached version from core - no more block_on!
use super::core::is_active_backend_local;

impl RcApiEngine {
    pub async fn init(&mut self, app: &AppHandle) {
        let app_handle = app.clone();

        // Only start and monitor process for Local backends
        if is_active_backend_local() {
            // Test Config before starting
            if self.validate_config(app).await {
                start(self, app).await;
            } else {
                warn!("⚠️ Engine startup aborted due to configuration validation failure");
            }

            // Monitoring task for Local backend only (async, no blocking)
            tokio::spawn(async move {
                let mut interval =
                    tokio::time::interval(Duration::from_secs(MONITORING_INTERVAL_SECS));
                interval.tick().await; // Skip immediate first tick

                loop {
                    interval.tick().await;

                    // Check shutdown
                    if app_handle.state::<RcloneState>().is_shutting_down() {
                        break;
                    }

                    // Only monitor if we're still on a Local backend
                    if !is_active_backend_local() {
                        debug!("📡 Active backend is remote, skipping process monitoring");
                        continue;
                    }

                    {
                        use crate::utils::types::core::EngineState;
                        let engine_state = app_handle.state::<EngineState>();
                        let mut engine = engine_state.lock().await;

                        if engine.should_exit {
                            break;
                        }

                        if !engine.is_api_healthy().await && !engine.should_exit {
                            debug!("🔄 Rclone API not healthy, attempting restart...");
                            start(&mut engine, &app_handle).await;
                        }
                    }
                }

                info!("🛑 Engine monitoring task exiting.");
            });
        } else {
            // Remote backend: just refresh cache, no process management
            info!("📡 Active backend is remote, skipping local engine initialization");
            let app = app.clone();
            if let Err(e) = refresh_active_backend_cache(&app).await {
                error!("Failed to refresh remote backend cache: {e}");
            }
        }
    }

    pub async fn shutdown(&mut self) {
        info!("🛑 Shutting down Rclone engine...");
        self.should_exit = true;

        // Only stop process for Local backends
        if is_active_backend_local()
            && let Err(e) = stop(self).await
        {
            error!("Failed to stop engine cleanly: {e}");
        }

        // Clear any remaining state
        self.process = None;
        self.running = false;
    }
}

/// Refresh the cache for the active backend (works for both Local and Remote)
async fn refresh_active_backend_cache(app: &AppHandle) -> Result<(), String> {
    let client = app.state::<RcloneState>().client.clone();
    let backend = BACKEND_MANAGER.get_active().await;
    let cache = BACKEND_MANAGER.remote_cache.clone();

    cache.refresh_all(&client, &backend).await?;

    if let Err(e) = update_tray_menu(app.clone(), 0).await {
        error!("Failed to update tray menu: {e}");
    }

    Ok(())
}

/// **Start the Rclone engine**
/// This is the main entry point for starting the background rcd process.
/// It handles:
/// 1. Checks if start is allowed (not paused)
/// 2. Cleans up existing/zombie processes
/// 3. Spawns the new process
/// 4. Waits for API readiness
/// 5. Triggers post-start setup (settings, cache refresh)
pub async fn start(engine: &mut RcApiEngine, app: &AppHandle) {
    // Only start process for Local backends
    if !is_active_backend_local() {
        debug!("📡 Active backend is remote, skipping process start");
        return;
    }

    // 1. Check if engine is blocked
    if let Some(reason) = engine.start_blocked_reason() {
        debug!("⏸️ Engine cannot start: {}", reason);
        emit_pause_error(app, reason);
        return;
    }

    // 2. Check if already healthy
    if engine.is_api_healthy().await {
        debug!("✅ API is already healthy, skipping restart");
        return;
    }

    // 3. Clean up existing state
    stop_existing_process(engine).await;

    // 4. Emergency cleanup of ports/zombies
    cleanup_environment(engine).await;

    // 5. Spawn and wait for readiness
    // Using direct async spawn instead of blocked helper
    match engine.spawn_process(app).await {
        Ok(child) => {
            engine.process = Some(child);

            // Wait for the API to be ready before declaring success
            if engine.wait_until_ready(API_READY_TIMEOUT_SECS).await {
                engine.running = true;
                let port = engine.current_api_port;
                info!("✅ Rclone API started successfully on port {port}");

                if let Err(e) = app.emit(RCLONE_ENGINE_READY, ()) {
                    error!("Failed to emit ready event: {e}");
                }

                // 6. Post-start setup (async)
                trigger_post_start_setup(app.clone());
            } else {
                error!("❌ Failed to start Rclone API within timeout.");
                engine.running = false;
                engine.process = None;
                let _ = stop(engine).await;

                handle_start_failure(engine, app, "Timeout waiting for API readiness".to_string());
            }
        }
        Err(e) => {
            handle_start_failure(engine, app, e.to_string());
        }
    }
}

/// Helper: Emit error events based on pause reason
fn emit_pause_error(app: &AppHandle, reason: super::core::PauseReason) {
    match reason {
        super::core::PauseReason::Password => {
            app.emit(RCLONE_ENGINE_PASSWORD_ERROR, ()).ok();
        }
        super::core::PauseReason::Path => {
            app.emit(RCLONE_ENGINE_PATH_ERROR, ()).ok();
        }
        super::core::PauseReason::Updating => {
            // No event for updating
        }
    }
}

/// Helper: Stop existing process in engine struct
async fn stop_existing_process(engine: &mut RcApiEngine) {
    if engine.process.is_some() {
        debug!("⚠️ Rclone process already exists, stopping first...");
        if let Err(e) = stop(engine).await {
            error!("Failed to stop Rclone process: {e}");
        }
    }
}

/// Helper: Clean up zombie processes on the API port
async fn cleanup_environment(engine: &RcApiEngine) {
    // Only kill processes on our specific port, not ALL rclone processes
    if let Err(e) = engine.kill_port_processes().await {
        error!("Failed to clean up port processes: {e}");
    }
}

/// Helper: Handle start failure
fn handle_start_failure(engine: &mut RcApiEngine, app: &AppHandle, e: String) {
    error!("❌ Failed to spawn Rclone process: {e}");
    if engine.path_error {
        if let Err(err) = app.emit(RCLONE_ENGINE_PATH_ERROR, ()) {
            error!("Failed to emit path_error event: {err}");
        }
    } else if engine.password_error {
        if let Err(err) = app.emit(RCLONE_ENGINE_PASSWORD_ERROR, ()) {
            error!("Failed to emit password_error event: {err}");
        }
    } else if let Err(err) = app.emit(RCLONE_ENGINE_ERROR, ()) {
        error!("Failed to emit event: {err}");
    }
}

/// Helper: Trigger post-start actions (settings, cache)
fn trigger_post_start_setup(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Load and apply settings
        match load_startup_settings(&app.state::<SettingsManager<JsonStorage>>()) {
            Ok(settings) => {
                apply_core_settings(&app, &settings).await;

                // Clear errors (synchronous, but fast enough to not need blocking spawn)
                use crate::utils::types::core::EngineState;
                app.state::<EngineState>().lock().await.clear_errors();

                // Refresh caches
                refresh_caches_and_tray(&app).await;
            }
            Err(e) => {
                error!("Failed to load settings to apply after engine start: {}", e);
            }
        }
    });
}

async fn refresh_caches_and_tray(app: &AppHandle) {
    let client = app
        .state::<crate::utils::types::all_types::RcloneState>()
        .client
        .clone();
    let backend = crate::rclone::backend::BACKEND_MANAGER.get_active().await;
    let cache = crate::rclone::backend::BACKEND_MANAGER.remote_cache.clone();

    match cache.refresh_all(&client, &backend).await {
        Ok(_) => debug!("Caches refreshed successfully after engine ready"),
        Err(e) => error!("Failed to refresh caches: {e}"),
    }

    if let Err(e) = update_tray_menu(app.clone(), 0).await {
        error!("Failed to update tray menu: {e}");
    }
}

#[cfg(test)]
mod tests {
    use crate::rclone::engine::core::PauseReason;
    use crate::utils::types::core::RcApiEngine;

    #[test]
    fn test_start_blocked_reason_priority() {
        let mut engine = RcApiEngine::default();

        // No blocks
        assert!(engine.start_blocked_reason().is_none());

        // Updating takes priority
        engine.set_updating(true);
        engine.set_password_error(true);
        assert_eq!(engine.start_blocked_reason(), Some(PauseReason::Updating));

        // Password error next
        engine.set_updating(false);
        assert_eq!(engine.start_blocked_reason(), Some(PauseReason::Password));

        // Path error last
        engine.set_password_error(false);
        engine.set_path_error(true);
        assert_eq!(engine.start_blocked_reason(), Some(PauseReason::Path));
    }

    #[test]
    fn test_is_api_healthy_logic_stub() {
        // Since we can't easily mock the HTTP call in unit tests without a trait,
        // we at least verify the engine state behavior if we could control it.
        // For now, this serves as a placeholder for where we'd inject a mock API client.
        let engine = RcApiEngine::default();
        assert!(!engine.running);
    }
}

pub async fn stop(engine: &mut RcApiEngine) -> super::error::EngineResult<()> {
    engine.kill_process().await
}

/// **Restart engine due to configuration changes**
/// This function handles engine restarts when critical settings change:
/// - Rclone binary path
/// - API port
/// - OAuth port  
/// - Config file path
pub fn restart_for_config_change(
    app: &AppHandle,
    change_type: &str,
    old_value: &str,
    new_value: &str,
) -> super::error::EngineResult<()> {
    info!("🔄 Restarting engine due to {change_type} change: {old_value} → {new_value}");

    // Use spawn_blocking to avoid blocking the event loop
    let app_handle = app.clone();
    let change_type = change_type.to_string();
    let old_value = old_value.to_string();
    let new_value = new_value.to_string();

    tauri::async_runtime::spawn_blocking(move || {
        let result = restart_engine_blocking(&app_handle, &change_type);

        match result {
            Ok(_) => {
                info!("✅ Engine restarted successfully for {change_type} change");

                // Emit success event
                if let Err(e) = app_handle.emit(
                    ENGINE_RESTARTED,
                    serde_json::json!({
                        "reason": change_type,
                        "old_value": old_value,
                        "new_value": new_value,
                        "success": true
                    }),
                ) {
                    error!("Failed to emit engine restart success event: {e}");
                }
            }
            Err(e) => {
                error!("❌ Failed to restart engine for {change_type} change: {e}");

                // Emit failure event
                if let Err(emit_err) = app_handle.emit(RCLONE_ENGINE_ERROR, ()) {
                    error!("Failed to emit engine restart failure event: {emit_err}");
                }
            }
        }
    });

    Ok(())
}

/// **Blocking version of engine restart**
/// This function does the actual restart work and blocks until completion
fn restart_engine_blocking(app: &AppHandle, change_type: &str) -> super::error::EngineResult<()> {
    use super::error::EngineError;
    use crate::utils::types::core::EngineState;

    let engine_state = app.state::<EngineState>();
    let mut engine = engine_state.blocking_lock();

    // Step 1: Stop the current engine
    debug!("🛑 Stopping current engine for {change_type} change...");
    if let Err(e) = tauri::async_runtime::block_on(stop(&mut engine)) {
        error!("Failed to stop engine cleanly: {e}");
        // Continue anyway - we'll try to force kill
    }

    // Step 2: Handle change-specific configuration updates
    handle_restart_change_type(&mut engine, app, change_type)?;

    // Step 3: Validate configuration (including password) before starting
    if !tauri::async_runtime::block_on(engine.validate_config(app)) {
        error!("❌ Configuration validation failed during restart");
        return Err(EngineError::ConfigValidationFailed(
            "Configuration validation failed".to_string(),
        ));
    }

    // Step 4: Start the engine with new configuration
    debug!("🚀 Starting engine with new configuration...");
    tauri::async_runtime::block_on(async {
        start(&mut engine, app).await;
    });

    // Step 4: Verify the restart was successful
    if engine.running {
        info!("✅ Engine restart completed successfully");
        Ok(())
    } else {
        Err(EngineError::RestartFailed(
            "Engine failed to start after restart".to_string(),
        ))
    }
}

/// Handle configuration-specific updates during engine restart
fn handle_restart_change_type(
    engine: &mut RcApiEngine,
    app: &AppHandle,
    change_type: &str,
) -> super::error::EngineResult<()> {
    match change_type {
        "rclone_path" => validate_rclone_path_change(engine, app),
        "api_port" => {
            debug!("🔄 API port updated in BACKEND_MANAGER");
            Ok(())
        }
        "rclone_config_file" => {
            debug!("🔄 Config file updated in RcloneState");
            Ok(())
        }
        _ => {
            debug!("🔄 Generic restart for {change_type}");
            Ok(())
        }
    }
}

/// Validate rclone path change and update engine state
fn validate_rclone_path_change(
    engine: &mut RcApiEngine,
    app: &AppHandle,
) -> super::error::EngineResult<()> {
    use super::error::EngineError;

    debug!("🔄 Updating rclone path...");
    let configured_path = crate::core::check_binaries::read_rclone_path(app);

    // Use blocking call since we're in a blocking context
    let check_result = tauri::async_runtime::block_on(
        crate::core::check_binaries::check_rclone_available(app.clone(), ""),
    );

    match check_result {
        Ok(true) => {
            engine.set_path_error(false);
            Ok(())
        }
        Ok(false) => {
            error!(
                "❌ Configured rclone path is invalid: {}",
                configured_path.display()
            );
            engine.set_path_error(true);
            if let Err(e) = app.emit(RCLONE_ENGINE_PATH_ERROR, ()) {
                error!("Failed to emit path_error event: {e}");
            }
            Err(EngineError::ConfigValidationFailed(format!(
                "Configured rclone path is invalid: {}",
                configured_path.display()
            )))
        }
        Err(e) => {
            error!("❌ Error checking rclone availability: {}", e);
            engine.set_path_error(true);
            if let Err(emit_err) = app.emit(RCLONE_ENGINE_PATH_ERROR, ()) {
                error!("Failed to emit path_error event: {emit_err}");
            }
            Err(EngineError::ConfigValidationFailed(e))
        }
    }
}
