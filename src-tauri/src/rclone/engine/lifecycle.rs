use log::{debug, error, info, warn};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

// Startup flag to prevent premature health checks
static INITIAL_STARTUP: AtomicBool = AtomicBool::new(true);

use crate::rclone::backend::BackendManager;

/// Mark initial startup as complete to enable health monitoring
pub fn mark_startup_complete() {
    INITIAL_STARTUP.store(false, Ordering::Relaxed);
    debug!("✅ Initial startup complete, health monitoring enabled");
}

// Timeout and interval constants
const API_READY_TIMEOUT_SECS: u64 = 10;
const MONITORING_INTERVAL_SECS: u64 = if cfg!(test) { 1 } else { 5 };

use crate::utils::types::logs::LogLevel;
use crate::utils::types::origin::Origin;
use crate::utils::{
    app::notification::{Notification, send_notification_typed},
    types::{
        core::{RcApiEngine, RcloneState},
        events::{
            ENGINE_RESTARTED, RCLONE_ENGINE_ERROR, RCLONE_ENGINE_PASSWORD_ERROR,
            RCLONE_ENGINE_PATH_ERROR, RCLONE_ENGINE_READY,
        },
    },
};

// Mobile no-op stub for update_tray_menu
#[cfg(not(desktop))]
async fn update_tray_menu(_app: AppHandle) -> Result<(), String> {
    Ok(())
}

// Use the cached version from core - no more block_on!
use super::core::is_active_backend_local;

/// Spawn background monitoring loop for engine health checks
///
/// This loop runs continuously and:
/// - Checks if the app is shutting down
/// - Skips monitoring when remote backend is active
/// - Performs health checks on Local backend
/// - Automatically restarts unhealthy engines
fn spawn_monitoring_loop(app_handle: AppHandle) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(MONITORING_INTERVAL_SECS));
        interval.tick().await; // Skip immediate first tick

        loop {
            interval.tick().await;

            // Check shutdown
            if app_handle.state::<RcloneState>().is_shutting_down() {
                break;
            }

            // Skip if remote backend is active
            if !is_active_backend_local() {
                continue;
            }

            // Local backend: ensure engine is healthy
            {
                use crate::utils::types::core::EngineState;
                let engine_state = app_handle.state::<EngineState>();
                let mut engine = engine_state.lock().await;

                if engine.should_exit {
                    break;
                }

                // Skip health check during initial startup to prevent premature restarts
                if INITIAL_STARTUP.load(Ordering::Relaxed) {
                    debug!("⏭️ Skipping health check during initial startup");
                    continue;
                }

                let client = app_handle.state::<RcloneState>().client.clone();
                let backend_manager = app_handle.state::<BackendManager>();
                if !engine.is_api_healthy(&client, &backend_manager).await && !engine.should_exit {
                    debug!("🔄 Rclone API not healthy, attempting restart...");
                    start(&mut engine, &app_handle).await;
                }
            }
        }

        info!("🛑 Engine monitoring task exiting.");
    });
}

impl RcApiEngine {
    pub async fn init(&mut self, app: &AppHandle) {
        let app_handle = app.clone();

        // Start engine only if Local backend is active
        if is_active_backend_local() {
            if self.validate_config(app).await {
                start(self, app).await;
            } else {
                warn!("⚠️ Engine startup aborted due to configuration validation failure");
            }
        } else {
            // Remote backend: skip local engine initialization
            // Note: Cache keys are refreshed in core/initialization.rs with proper timeout handling
            // We should NOT do it here as this function is running in a blocking context during startup
            info!("📡 Active backend is remote, skipping local engine initialization");
        }

        // Start background monitoring loop
        spawn_monitoring_loop(app_handle);
    }

    pub async fn shutdown(&mut self, app: &AppHandle) {
        info!("🛑 Shutting down Rclone engine...");
        self.should_exit = true;

        // Only stop process for Local backends
        if is_active_backend_local()
            && let Err(e) = self.kill_process(app).await
        {
            error!("Failed to stop engine cleanly: {e}");
        }

        // Clear any remaining state
        self.process = None;
        self.running = false;
    }
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
        return;
    }

    // 2. Check if already healthy
    let client = app.state::<RcloneState>().client.clone();
    let backend_manager = app.state::<BackendManager>();
    if engine.is_api_healthy(&client, &backend_manager).await {
        debug!("✅ API is already healthy, skipping restart");
        return;
    }

    // 3. Stop existing process if running
    if engine.process.is_some() {
        debug!("⚠️ Rclone process already exists, stopping first...");
        if let Err(e) = engine.kill_process(app).await {
            error!("Failed to stop Rclone process: {e}");
        }
    }

    // 4. Clean up any processes using the rclone port
    if let Err(e) = engine.kill_port_processes().await {
        error!("Failed to clean up port processes: {e}");
    }

    // 5. Spawn and wait for readiness
    // Using direct async spawn instead of blocked helper
    match engine.spawn_process(app).await {
        Ok(child) => {
            engine.process = Some(child);

            // Wait for the API to be ready before declaring success
            if engine
                .wait_until_ready(&client, &backend_manager, API_READY_TIMEOUT_SECS)
                .await
            {
                engine.running = true;
                let port = engine.current_api_port;
                info!("✅ Rclone API started successfully on port {port}");

                if let Err(e) = app.emit(RCLONE_ENGINE_READY, ()) {
                    error!("Failed to emit ready event: {e}");
                }

                // 6. Post-start setup (async)
                super::post_start::trigger_post_start_setup(app.clone());
            } else {
                error!("❌ Failed to start Rclone API within timeout.");
                engine.running = false;
                engine.process = None;
                let _ = engine.kill_process(app).await;

                handle_start_failure(engine, app, "Timeout waiting for API readiness".to_string());
            }
        }
        Err(e) => {
            handle_start_failure(engine, app, e.to_string());
        }
    }
}

/// Helper: Handle start failure
fn handle_start_failure(engine: &mut RcApiEngine, app: &AppHandle, e: String) {
    error!("❌ Failed to spawn Rclone process: {e}");
    debug!(
        "🔍 Error flags - path_error: {}, password_error: {}",
        engine.path_error, engine.password_error
    );

    if engine.path_error {
        debug!("📍 Emitting RCLONE_ENGINE_PATH_ERROR");
        if let Err(err) = app.emit(RCLONE_ENGINE_PATH_ERROR, ()) {
            error!("Failed to emit path_error event: {err}");
        }
        send_notification_typed(
            app,
            Notification::localized(
                "notification.title.engineError",
                "notification.body.enginePathError",
                None,
                None,
                Some(LogLevel::Error),
            ),
            Some(Origin::System),
        );
    } else if engine.password_error {
        debug!("🔑 Emitting RCLONE_ENGINE_PASSWORD_ERROR");
        if let Err(err) = app.emit(RCLONE_ENGINE_PASSWORD_ERROR, ()) {
            error!("Failed to emit password_error event: {err}");
        }
        send_notification_typed(
            app,
            Notification::localized(
                "notification.title.engineError",
                "notification.body.enginePasswordError",
                None,
                None,
                Some(LogLevel::Error),
            ),
            Some(Origin::System),
        );
    } else {
        debug!("⚠️ Emitting generic RCLONE_ENGINE_ERROR (this should be rare!)");
        if let Err(err) = app.emit(RCLONE_ENGINE_ERROR, ()) {
            error!("Failed to emit event: {err}");
        }
    }
}

#[allow(clippy::items_after_test_module)]
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

                send_notification_typed(
                    &app_handle,
                    Notification::localized(
                        "notification.title.engineRestarted",
                        "notification.body.engineRestartedSuccess",
                        Some(vec![("reason", &change_type)]),
                        None,
                        Some(LogLevel::Info),
                    ),
                    Some(Origin::System),
                );
            }
            Err(e) => {
                error!("❌ Failed to restart engine for {change_type} change: {e}");

                // Emit failure event
                if let Err(emit_err) = app_handle.emit(RCLONE_ENGINE_ERROR, ()) {
                    error!("Failed to emit engine restart failure event: {emit_err}");
                }

                send_notification_typed(
                    &app_handle,
                    Notification::localized(
                        "notification.title.engineError",
                        "notification.body.engineRestartedFailed",
                        Some(vec![("reason", &change_type)]),
                        None,
                        Some(LogLevel::Error),
                    ),
                    Some(Origin::System),
                );
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
    if let Err(e) = tauri::async_runtime::block_on(engine.kill_process(app)) {
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
            debug!("🔄 API port updated in BackendManager");
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
