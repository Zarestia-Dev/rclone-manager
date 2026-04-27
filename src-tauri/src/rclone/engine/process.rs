use log::{debug, error, info};
use std::time::Duration;
use tauri::{AppHandle, Manager};

use crate::utils::types::core::{ProcessKind, RcApiEngine};
use crate::utils::{
    process::process_manager::kill_processes_on_port,
    rclone::{endpoints::core, process_common::build_rclone_process_command},
};

use super::error::{EngineError, EngineResult};

const GRACEFUL_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_GRACEFUL_SHUTDOWN_ITERATIONS: usize = 10;
const GRACEFUL_SHUTDOWN_CHECK_INTERVAL: Duration = Duration::from_millis(500);

impl RcApiEngine {
    pub async fn spawn_process(&mut self, app: &AppHandle) -> EngineResult<tokio::process::Child> {
        use crate::rclone::backend::BackendManager;
        let backend_manager = app.state::<BackendManager>();
        let backend = backend_manager.get_active().await;

        self.current_api_port = backend.port;

        let engine_cmd = match build_rclone_process_command(app, ProcessKind::Engine).await {
            Ok(cmd) => cmd,
            Err(e) => {
                error!("Failed to create engine command: {e}");
                if let EngineError::PasswordRequired = e {
                    self.set_password_error(true);
                }
                return Err(e);
            }
        };

        match engine_cmd.spawn() {
            Ok(child) => {
                info!("Rclone process spawned successfully");
                self.set_path_error(false);
                Ok(child)
            }
            Err(e) => {
                error!("Failed to spawn Rclone process: {e}");
                let err_text = e.to_string();
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

    pub async fn kill_process(&mut self, app: &AppHandle) -> EngineResult<()> {
        if let Some(mut child) = self.process.take() {
            let pid = child.id();

            if self.running
                && let Some(pid_val) = pid
            {
                info!("Attempting graceful shutdown for PID {pid_val}...");

                use crate::rclone::backend::BackendManager;
                let backend_manager = app.state::<BackendManager>();
                let backend = backend_manager.get_active().await;
                let quit_url = backend.url_for(core::QUIT);

                let _ = reqwest::Client::new()
                    .post(&quit_url)
                    .timeout(GRACEFUL_SHUTDOWN_TIMEOUT)
                    .send()
                    .await;

                #[cfg(unix)]
                for _ in 0..MAX_GRACEFUL_SHUTDOWN_ITERATIONS {
                    if let Ok(output) = tokio::process::Command::new("kill")
                        .args(["-0", &pid_val.to_string()])
                        .output()
                        .await
                        && !output.status.success()
                    {
                        info!("Process terminated gracefully");
                        let _ = child.wait().await;
                        self.running = false;
                        return Ok(());
                    }
                    tokio::time::sleep(GRACEFUL_SHUTDOWN_CHECK_INTERVAL).await;
                }

                #[cfg(windows)]
                {
                    let total_wait = GRACEFUL_SHUTDOWN_CHECK_INTERVAL
                        .saturating_mul(MAX_GRACEFUL_SHUTDOWN_ITERATIONS as u32);
                    let deadline = tokio::time::Instant::now() + total_wait;

                    loop {
                        if !crate::utils::process::process_manager::is_process_alive(pid_val) {
                            info!("Process terminated gracefully");
                            let _ = child.wait().await;
                            self.running = false;
                            return Ok(());
                        }
                        if tokio::time::Instant::now() >= deadline {
                            break;
                        }
                        tokio::time::sleep(GRACEFUL_SHUTDOWN_CHECK_INTERVAL).await;
                    }
                }

                debug!("Graceful shutdown timed out, force killing...");
            }

            info!("Force killing process...");
            if let Err(e) = child.kill().await {
                let error_msg = format!("Failed to kill process: {e}");
                error!("{error_msg}");
                return Err(EngineError::KillFailed(error_msg));
            }
            // Reap the child after a forced kill too.
            let _ = child.wait().await;
            info!("Process terminated");
        }

        self.running = false;
        Ok(())
    }

    pub fn kill_port_processes(&self) -> EngineResult<()> {
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
        assert_eq!(GRACEFUL_SHUTDOWN_TIMEOUT, Duration::from_secs(5));
        assert_eq!(MAX_GRACEFUL_SHUTDOWN_ITERATIONS, 10);
        assert_eq!(GRACEFUL_SHUTDOWN_CHECK_INTERVAL, Duration::from_millis(500));

        let total_poll_time = MAX_GRACEFUL_SHUTDOWN_ITERATIONS as u64
            * GRACEFUL_SHUTDOWN_CHECK_INTERVAL.as_millis() as u64;
        assert_eq!(total_poll_time, 5000);
    }

    #[tokio::test]
    async fn test_kill_process_no_process() {
        let mut engine = RcApiEngine {
            running: true,
            ..Default::default()
        };
        engine.running = false;
    }

    #[tokio::test]
    async fn test_kill_port_processes_default_port() {
        let engine = RcApiEngine::default();
        assert_eq!(engine.current_api_port, DEFAULT_API_PORT);
        let _ = engine.kill_port_processes();
    }
}
