use log::{debug, error, info};
use std::thread;
use tauri::{AppHandle, Emitter, Manager};

use crate::{RcloneState, core::check_binaries::read_rclone_path, utils::types::RcApiEngine};

impl RcApiEngine {
    pub fn init(&mut self, app: &AppHandle) {
        if self.rclone_path.as_os_str().is_empty() {
            self.rclone_path = read_rclone_path(app);
        }

        let app_handle = app.clone();

        start(self, app);

        thread::spawn(move || {
            while !app_handle.state::<RcloneState>().is_shutting_down() {
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

                    if !engine.rclone_path.exists() {
                        engine.handle_invalid_path(&app_handle);
                        continue;
                    }

                    if !engine.is_api_healthy() && !engine.should_exit {
                        debug!("🔄 Rclone API not healthy, attempting restart...");
                        start(&mut engine, &app_handle);
                    }
                }

                thread::sleep(std::time::Duration::from_secs(5)); // Increased to reduce restart frequency
            }

            info!("🛑 Engine monitoring thread exiting.");
        });
    }

    pub fn shutdown(&mut self) {
        info!("🛑 Shutting down Rclone engine...");
        self.should_exit = true;

        // Stop any running process
        if let Err(e) = stop(self) {
            error!("Failed to stop engine cleanly: {e}");
        }

        // Clear any remaining state
        self.process = None;
        self.running = false;
    }
}

pub fn start(engine: &mut RcApiEngine, app: &AppHandle) {
    // First check if API is already healthy (avoid unnecessary restarts)
    if engine.is_api_healthy() {
        debug!("✅ API is already healthy, skipping restart");
        return;
    }

    // Clean up any existing processes first
    if engine.process.is_some() {
        debug!("⚠️ Rclone process already exists, stopping first...");
        if let Err(e) = stop(engine) {
            error!("Failed to stop Rclone process: {e}");
        }
    }

    // Emergency cleanup: kill all rclone processes
    if let Err(e) = RcApiEngine::kill_all_rclone_rcd() {
        error!("Failed to emergency cleanup: {e}");
    }

    // Kill any orphaned processes that might be holding the port
    if let Err(e) = engine.kill_port_processes() {
        error!("Failed to clean up port processes: {e}");
    }

    // Wait a bit more for port to be fully released
    std::thread::sleep(std::time::Duration::from_secs(3));

    match engine.spawn_process(app) {
        Ok(child) => {
            // Store the process immediately so health checks can find it
            engine.process = Some(child);

            // Use longer timeout for initial startup
            if engine.wait_until_ready(10) {
                engine.running = true;
                let port = engine.current_api_port;
                info!("✅ Rclone API started successfully on port {port}");
                if let Err(e) = app.emit("rclone_api_ready", ()) {
                    error!("Failed to emit ready event: {e}");
                }
            } else {
                error!("❌ Failed to start Rclone API within timeout.");
                // Clean up the failed process
                engine.process = None;
                engine.running = false;
                if let Err(e) = app.emit(
                    "rclone_engine_failed",
                    "Failed to start Rclone API".to_string(),
                ) {
                    error!("Failed to emit event: {e}");
                }
            }
        }
        Err(e) => {
            error!("❌ Failed to spawn Rclone process: {e}");
            if let Err(e) = app.emit(
                "rclone_engine_failed",
                "Failed to spawn Rclone process".to_string(),
            ) {
                error!("Failed to emit event: {e}");
            }
        }
    }
}

pub fn stop(engine: &mut RcApiEngine) -> Result<(), String> {
    engine.kill_process()
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
                    "engine_restarted",
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
                if let Err(emit_err) = app_handle.emit(
                    "engine_restart_failed",
                    serde_json::json!({
                        "reason": change_type,
                        "old_value": old_value,
                        "new_value": new_value,
                        "error": e
                    }),
                ) {
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
            engine.rclone_path = read_rclone_path(app);
        }
        "api_port" => {
            debug!("🔄 API port updated in ENGINE_STATE");
            // Port is already updated in ENGINE_STATE by the caller
        }
        "config_path" => {
            debug!("🔄 Config path updated in RcloneState");
            // Config path is already updated in RcloneState by the caller
        }
        _ => {
            debug!("🔄 Generic restart for {change_type}");
        }
    }

    // Step 3: Wait a moment for cleanup
    std::thread::sleep(std::time::Duration::from_millis(500));

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

// /// **Convenience function for async restart**
// /// Use this when you want to restart the engine from an async context
// pub async fn restart_for_config_change_async(
//     app: AppHandle,
//     change_type: &str,
//     old_value: &str,
//     new_value: &str,
// ) -> Result<(), String> {
//     let change_type = change_type.to_string();
//     let old_value = old_value.to_string();
//     let new_value = new_value.to_string();

//     tauri::async_runtime::spawn_blocking(move || {
//         restart_engine_blocking(&app, &change_type)
//     })
//     .await
//     .map_err(|e| format!("Failed to execute engine restart: {}", e))?
// }
