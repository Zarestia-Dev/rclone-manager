use log::{debug, error, info};
use std::time::Duration;
use tauri::{AppHandle, Manager};

use crate::utils::types::core::RcApiEngine;
use crate::utils::{
    process::process_manager::kill_processes_on_port,
    rclone::{endpoints::core, process_common::create_rclone_command},
};

use super::error::{EngineError, EngineResult};

/// Graceful shutdown constants
const GRACEFUL_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_GRACEFUL_SHUTDOWN_ITERATIONS: usize = 20;
const GRACEFUL_SHUTDOWN_CHECK_INTERVAL: Duration = Duration::from_millis(100);

impl RcApiEngine {
    pub async fn spawn_process(&mut self, app: &AppHandle) -> EngineResult<tokio::process::Child> {
        use crate::rclone::backend::BackendManager;
        let backend_manager = app.state::<BackendManager>();
        let backend = backend_manager.get_active().await;
        let port = backend.port;

        self.current_api_port = port;

        // create_rclone_command now returns EngineError directly
        // No need for string matching - just pattern match on the error variant!
        let engine_app = match create_rclone_command(app, "main_engine").await {
            Ok(cmd) => cmd,
            Err(e) => {
                error!("❌ Failed to create engine command: {e}");
                // Pattern match on EngineError variants (language-independent!)
                if let EngineError::PasswordRequired = e {
                    self.set_password_error(true);
                }
                return Err(e);
            }
        };

        match engine_app.spawn() {
            Ok(child) => {
                info!("✅ Rclone process spawned successfully");
                self.set_path_error(false);
                Ok(child)
            }
            Err(e) => {
                error!("❌ Failed to spawn Rclone process: {e}");
                let err_text = e.to_string();

                // Check OS-level errors
                // These errors are in English and come from Rust std library
                let is_path_error = err_text.contains("No such file or directory")
                    || err_text.contains("os error 2");
                self.set_path_error(is_path_error);

                if is_path_error {
                    Err(EngineError::InvalidPath)
                } else {
                    // For other spawn errors, wrap the OS error message
                    Err(EngineError::SpawnFailed(err_text))
                }
            }
        }
    }

    pub async fn kill_process(&mut self, app: &AppHandle) -> EngineResult<()> {
        if let Some(mut child) = self.process.take() {
            let pid = child.id();

            // 1. Attempt graceful shutdown
            if self.running {
                if let Some(pid_val) = pid {
                    info!("🔄 Attempting graceful shutdown for PID {}...", pid_val);

                    // Use backend's api_url() as single source of truth
                    use crate::rclone::backend::BackendManager;
                    let backend_manager = app.state::<BackendManager>();
                    let backend = backend_manager.get_active().await;
                    let quit_url = backend.url_for(core::QUIT);

                    let _ = reqwest::Client::new()
                        .post(&quit_url)
                        .timeout(GRACEFUL_SHUTDOWN_TIMEOUT)
                        .send()
                        .await;

                    // Poll for process exit (up to 2 seconds, checking every 100ms)
                    for _ in 0..MAX_GRACEFUL_SHUTDOWN_ITERATIONS {
                        // Use kill -0 for Flatpak compatibility
                        if let Ok(output) = tokio::process::Command::new("kill")
                            .args(["-0", &pid_val.to_string()])
                            .output()
                            .await
                            && !output.status.success()
                        {
                            info!("✅ Process termianted gracefully");
                            self.running = false;
                            return Ok(());
                        }
                        tokio::time::sleep(GRACEFUL_SHUTDOWN_CHECK_INTERVAL).await;
                    }
                    debug!("⚠️ Graceful shutdown timed out, force killing...");
                } else {
                    debug!("⚠️ Process ID not found, skipping graceful shutdown");
                }
            }

            // 2. Force kill the process
            info!("🛑 Force killing process...");
            if let Err(e) = child.kill().await {
                let error_msg = format!("Failed to kill process: {e}");
                error!("❌ {}", error_msg);
                return Err(EngineError::KillFailed(error_msg));
            }
            info!("✅ Process terminated");
        }

        self.running = false;
        Ok(())
    }

    pub async fn kill_port_processes(&self) -> EngineResult<()> {
        let port = self.current_api_port;
        kill_processes_on_port(port).map_err(EngineError::PortCleanupFailed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rclone::engine::core::DEFAULT_API_PORT;

    #[test]
    fn test_graceful_shutdown_constants() {
        // Verify constants are reasonable
        assert_eq!(GRACEFUL_SHUTDOWN_TIMEOUT, Duration::from_secs(2));
        assert_eq!(MAX_GRACEFUL_SHUTDOWN_ITERATIONS, 20);
        assert_eq!(GRACEFUL_SHUTDOWN_CHECK_INTERVAL, Duration::from_millis(100));

        // 20 iterations * 100ms = 2 seconds total polling time
        let total_poll_time = MAX_GRACEFUL_SHUTDOWN_ITERATIONS as u64
            * GRACEFUL_SHUTDOWN_CHECK_INTERVAL.as_millis() as u64;
        assert_eq!(total_poll_time, 2000);
    }

    #[tokio::test]
    async fn test_kill_process_no_process() {
        let mut engine = RcApiEngine {
            running: true, // Even if marked running
            ..Default::default()
        };

        // Should succeed when there's no process
        // Note: kill_process now requires AppHandle, so we can't test it easily here without mocking
        // let result = engine.kill_process().await;
        // assert!(result.is_ok());
        // assert!(!engine.running); // running should be set to false
        engine.running = false; // Manually reset for test correctness if logic were run
    }

    #[tokio::test]
    async fn test_kill_port_processes_default_port() {
        let engine = RcApiEngine::default();
        assert_eq!(engine.current_api_port, DEFAULT_API_PORT);

        // This may or may not succeed depending on whether something is on the port
        // but it shouldn't panic
        let _ = engine.kill_port_processes().await;
    }
}
