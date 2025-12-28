use log::{debug, error, info};
use std::thread;
use tauri::{AppHandle, Emitter, Manager};

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
    pub fn init(&mut self, app: &AppHandle) {
        let app_handle = app.clone();

        // Only start and monitor process for Local backends
        if is_active_backend_local() {
            // Test Config before starting
            if self.validate_config_sync(app) {
                start(self, app);
            }

            // Monitoring thread for Local backend only
            thread::spawn(move || {
                while !app_handle.state::<RcloneState>().is_shutting_down() {
                    // Only monitor if we're still on a Local backend
                    if !is_active_backend_local() {
                        debug!("📡 Active backend is remote, skipping process monitoring");
                        thread::sleep(std::time::Duration::from_secs(5));
                        continue;
                    }

                    {
                        let mut engine = match RcApiEngine::lock_engine() {
                            Ok(engine) => engine,
                            Err(e) => {
                                error!("❗ Failed to acquire lock on RcApiEngine: {e}");
                                break;
                            }
                        };

                        if engine.should_exit {
                            break;
                        }

                        if !engine.is_api_healthy() && !engine.should_exit {
                            debug!("🔄 Rclone API not healthy, attempting restart...");
                            start(&mut engine, &app_handle);
                        }
                    }

                    thread::sleep(std::time::Duration::from_secs(5));
                }

                info!("🛑 Engine monitoring thread exiting.");
            });
        } else {
            // Remote backend: just refresh cache, no process management
            info!("📡 Active backend is remote, skipping local engine initialization");
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = refresh_active_backend_cache(&app).await {
                    error!("Failed to refresh remote backend cache: {e}");
                }
            });
        }
    }

    pub fn shutdown(&mut self) {
        info!("� Shutting down Rclone engine...");
        self.should_exit = true;

        // Only stop process for Local backends
        if is_active_backend_local()
            && let Err(e) = stop(self)
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
pub fn start(engine: &mut RcApiEngine, app: &AppHandle) {
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
    if engine.is_api_healthy() {
        debug!("✅ API is already healthy, skipping restart");
        return;
    }

    // 3. Clean up existing state
    stop_existing_process(engine);

    // 4. Emergency cleanup of ports/zombies
    cleanup_environment(engine);

    // 5. Spawn and wait for readiness
    match spawn_and_wait(engine, app) {
        Ok(child) => {
            engine.process = Some(child);

            // Wait for the API to be ready before declaring success
            if engine.wait_until_ready(10) {
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
                let _ = stop(engine);

                handle_start_failure(engine, app, "Timeout waiting for API readiness".to_string());
            }
        }
        Err(e) => {
            handle_start_failure(engine, app, e);
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
fn stop_existing_process(engine: &mut RcApiEngine) {
    if engine.process.is_some() {
        debug!("⚠️ Rclone process already exists, stopping first...");
        if let Err(e) = stop(engine) {
            error!("Failed to stop Rclone process: {e}");
        }
    }
}

/// Helper: Clean up zombie processes on the API port
fn cleanup_environment(engine: &RcApiEngine) {
    // Only kill processes on our specific port, not ALL rclone processes
    if let Err(e) = engine.kill_port_processes() {
        error!("Failed to clean up port processes: {e}");
    }
}

/// Helper: Spawn process and return the child handle
fn spawn_and_wait(
    engine: &mut RcApiEngine,
    app: &AppHandle,
) -> Result<tauri_plugin_shell::process::CommandChild, String> {
    tauri::async_runtime::block_on(engine.spawn_process(app)).map_err(|e| e.to_string())
}

/// Helper: Handle start failure
fn handle_start_failure(engine: &mut RcApiEngine, app: &AppHandle, e: String) {
    error!("❌ Failed to spawn Rclone process: {e}");
    if engine.path_error {
        if let Err(err) = app.emit(RCLONE_ENGINE_PATH_ERROR, ()) {
            error!("Failed to emit path_error event: {err}");
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
                let _ = RcApiEngine::with_lock(|engine| engine.clear_errors());

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

pub fn stop(engine: &mut RcApiEngine) -> Result<(), String> {
    engine.kill_process().map_err(|e| e.to_string())
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
) -> Result<(), String> {
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
fn restart_engine_blocking(app: &AppHandle, change_type: &str) -> Result<(), String> {
    let mut engine =
        RcApiEngine::lock_engine().map_err(|e| format!("Failed to acquire engine lock: {e}"))?;

    // Step 1: Stop the current engine
    debug!("🛑 Stopping current engine for {change_type} change...");
    if let Err(e) = stop(&mut engine) {
        error!("Failed to stop engine cleanly: {e}");
        // Continue anyway - we'll try to force kill
    }

    // Step 2: Update engine state based on change type
    match change_type {
        "rclone_path" => {
            debug!("🔄 Updating rclone path...");
            // Validate the new configured rclone path before attempting to start
            let configured_path = crate::core::check_binaries::read_rclone_path(app);

            // Use blocking call since we're in a blocking context
            let check_result = tauri::async_runtime::block_on(
                crate::core::check_binaries::check_rclone_available(app.clone(), ""),
            );

            match check_result {
                Ok(available) => {
                    if !available {
                        error!(
                            "❌ Configured rclone path is invalid: {}",
                            configured_path.display()
                        );
                        engine.set_path_error(true);
                        // Inform the frontend about the path error
                        if let Err(e) = app.emit(RCLONE_ENGINE_PATH_ERROR, ()) {
                            error!("Failed to emit path_error event: {e}");
                        }
                        return Err(format!(
                            "Configured rclone path is invalid: {}",
                            configured_path.display()
                        ));
                    } else {
                        engine.set_path_error(false);
                    }
                }
                Err(e) => {
                    error!("❌ Error checking rclone availability: {}", e);
                    engine.set_path_error(true);
                    if let Err(emit_err) = app.emit(RCLONE_ENGINE_PATH_ERROR, ()) {
                        error!("Failed to emit path_error event: {emit_err}");
                    }
                    return Err(e);
                }
            }
        }
        "api_port" => {
            debug!("🔄 API port updated in BACKEND_MANAGER");
            // Port is already updated in BACKEND_MANAGER by the caller
        }
        "rclone_config_file" => {
            debug!("🔄 Config file updated in RcloneState");
            engine.validate_config_sync(app);
        }
        _ => {
            debug!("🔄 Generic restart for {change_type}");
        }
    }

    // Step 4: Start the engine with new configuration
    debug!("🚀 Starting engine with new configuration...");
    start(&mut engine, app);

    // Step 5: Verify the restart was successful
    if engine.running {
        info!("✅ Engine restart completed successfully");
        Ok(())
    } else {
        Err("Engine failed to start after restart".to_string())
    }
}
