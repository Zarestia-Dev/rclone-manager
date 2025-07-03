use std::thread;
use log::{debug, error, info};
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    core::check_binaries::read_rclone_path,
    utils::types::RcApiEngine,
    RcloneState,
};

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
                            error!("❗ Failed to acquire lock on RcApiEngine: {}", e);
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
            error!("Failed to stop engine cleanly: {}", e);
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
            error!("Failed to stop Rclone process: {}", e);
        }
    }
    
    // Emergency cleanup: kill all rclone processes
    if let Err(e) = RcApiEngine::kill_all_rclone_rcd() {
        error!("Failed to emergency cleanup: {}", e);
    }
    
    // Kill any orphaned processes that might be holding the port
    if let Err(e) = engine.kill_port_processes() {
        error!("Failed to clean up port processes: {}", e);
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
                info!("✅ Rclone API started successfully on port {}", port);
                if let Err(e) = app.emit("rclone_api_ready", ()) {
                    error!("Failed to emit ready event: {}", e);
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
                    error!("Failed to emit event: {}", e);
                }
            }
        }
        Err(e) => {
            error!("❌ Failed to spawn Rclone process: {}", e);
            if let Err(e) = app.emit(
                "rclone_engine_failed",
                "Failed to spawn Rclone process".to_string(),
            ) {
                error!("Failed to emit event: {}", e);
            }
        }
    }
}

pub fn stop(engine: &mut RcApiEngine) -> Result<(), String> {
    engine.kill_process()
}
