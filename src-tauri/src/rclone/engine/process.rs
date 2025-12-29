use log::{debug, error, info};
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_shell::process::CommandChild;

use crate::utils::{
    process::process_manager::kill_processes_on_port,
    rclone::{
        endpoints::{EndpointHelper, core},
        process_common::create_rclone_command,
    },
    types::all_types::RcApiEngine,
};

use super::error::{EngineError, EngineResult};

/// Graceful shutdown constants
const GRACEFUL_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_GRACEFUL_SHUTDOWN_ITERATIONS: usize = 20;
const GRACEFUL_SHUTDOWN_CHECK_INTERVAL: Duration = Duration::from_millis(100);

impl RcApiEngine {
    pub async fn spawn_process(&mut self, app: &AppHandle) -> EngineResult<CommandChild> {
        let backend = crate::rclone::backend::BACKEND_MANAGER.get_active().await;
        let port = backend.port;

        self.current_api_port = port;

        let engine_app_result = create_rclone_command(port, app, "main_engine")
            .await
            .map_err(|e| {
                error!("❌ Failed to create engine command: {e}");
                if e.contains("Configuration is encrypted and no password provided") {
                    EngineError::PasswordRequired
                } else {
                    EngineError::SpawnFailed(e)
                }
            });

        let engine_app = match engine_app_result {
            Ok(cmd) => cmd,
            Err(e) => {
                if let EngineError::PasswordRequired = e {
                    self.set_password_error(true);
                }
                return Err(e);
            }
        };

        match engine_app.spawn() {
            Ok((_rx, child)) => {
                info!("✅ Rclone process spawned successfully");
                self.set_path_error(false);
                Ok(child)
            }
            Err(e) => {
                error!("❌ Failed to spawn Rclone process: {e}");
                let err_text = e.to_string();

                // Specific check for missing password in encrypted config
                if err_text.contains("Configuration is encrypted and no password provided") {
                    self.set_password_error(true);
                    return Err(EngineError::PasswordRequired);
                }

                let is_path_error = err_text.contains("No such file or directory")
                    || err_text.contains("os error 2");
                self.set_path_error(is_path_error);

                if is_path_error {
                    Err(EngineError::InvalidPath)
                } else {
                    Err(EngineError::SpawnFailed(err_text))
                }
            }
        }
    }

    pub async fn kill_process(&mut self) -> EngineResult<()> {
        if let Some(child) = self.process.take() {
            let pid = child.pid();

            // 1. Attempt graceful shutdown
            if self.running {
                info!("🔄 Attempting graceful shutdown...");

                let quit_url = EndpointHelper::build_url(
                    &format!("http://127.0.0.1:{}", self.current_api_port),
                    core::QUIT,
                );

                let _ = reqwest::Client::new()
                    .post(&quit_url)
                    .timeout(GRACEFUL_SHUTDOWN_TIMEOUT)
                    .send()
                    .await;

                // Poll for process exit (up to 2 seconds, checking every 100ms)
                for _ in 0..MAX_GRACEFUL_SHUTDOWN_ITERATIONS {
                    // Use kill -0 for Flatpak compatibility
                    if let Ok(output) = tokio::process::Command::new("kill")
                        .args(["-0", &pid.to_string()])
                        .output()
                        .await
                        && !output.status.success()
                    {
                        info!("✅ Process terminated gracefully");
                        self.running = false;
                        return Ok(());
                    }
                    tokio::time::sleep(GRACEFUL_SHUTDOWN_CHECK_INTERVAL).await;
                }
                debug!("⚠️ Graceful shutdown timed out, force killing...");
            }

            // 2. Force kill the process
            info!("🛑 Force killing process...");
            if let Err(e) = child.kill() {
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
        let mut engine = RcApiEngine::default();
        engine.running = true; // Even if marked running

        // Should succeed when there's no process
        let result = engine.kill_process().await;
        assert!(result.is_ok());
        assert!(!engine.running); // running should be set to false
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
