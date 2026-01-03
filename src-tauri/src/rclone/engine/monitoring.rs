use log::debug;
use std::time::Duration;

use crate::rclone::backend::BACKEND_MANAGER;
use crate::utils::{
    rclone::endpoints::{EndpointHelper, core},
    types::all_types::RcApiEngine,
};

/// Duration constants for health checks
const API_HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
const API_READY_POLL_INTERVAL: Duration = Duration::from_millis(500);

impl RcApiEngine {
    /// Check if both the process is running AND the API is responding
    pub async fn is_api_healthy(&mut self) -> bool {
        // First check if process is still alive
        if !self.is_process_alive() {
            debug!("🔍 Process is not alive");
            return false;
        }

        self.check_api_response().await
    }

    /// Check if the process is still alive using native PID checking
    pub fn is_process_alive(&mut self) -> bool {
        if let Some(child) = &self.process {
            let pid = child.pid();

            #[cfg(unix)]
            {
                // Use kill -0 which works in Flatpak sandbox (inherits permissions)
                use std::process::Command;
                match Command::new("kill").args(["-0", &pid.to_string()]).output() {
                    Ok(output) => {
                        let alive = output.status.success();
                        if !alive {
                            debug!("🔍 Process {} is no longer running", pid);
                        }
                        alive
                    }
                    Err(_) => {
                        // If we can't check, assume alive and let API check verify
                        true
                    }
                }
            }

            #[cfg(windows)]
            {
                // On Windows, try to open the process with minimal access
                use std::process::Command;
                let output = Command::new("tasklist")
                    .args(["/FI", &format!("PID eq {}", pid), "/NH"])
                    .output();

                match output {
                    Ok(out) => {
                        let stdout = String::from_utf8_lossy(&out.stdout);
                        let alive = stdout.contains(&pid.to_string());
                        if !alive {
                            debug!("🔍 Process {} is no longer running", pid);
                        }
                        alive
                    }
                    Err(_) => {
                        // If we can't check, assume alive and let API check verify
                        true
                    }
                }
            }
        } else {
            debug!("🔍 No process found");
            false
        }
    }

    /// Check if the API is responding by making a simple request
    async fn check_api_response(&self) -> bool {
        Self::check_api_health().await
    }

    /// Check if the active backend's API is responding
    ///
    /// Returns true if the API returns a successful response or 401 Unauthorized
    /// (which means the API is running but requires auth).
    pub async fn check_api_health() -> bool {
        let backend = BACKEND_MANAGER.get_active().await;
        let url = EndpointHelper::build_url(&backend.api_url(), core::VERSION);

        let client = reqwest::Client::new();
        match client.post(&url).timeout(API_HEALTH_TIMEOUT).send().await {
            Ok(response) => {
                let status = response.status();
                // Treat 401 Unauthorized as healthy - it means the API is responding
                // but requires authentication (which we'll provide in actual requests)
                let is_healthy = status.is_success() || status == reqwest::StatusCode::UNAUTHORIZED;
                debug!(
                    "🔍 API health check: {} (status: {})",
                    if is_healthy { "healthy" } else { "unhealthy" },
                    status
                );
                is_healthy
            }
            Err(e) => {
                debug!("🔍 API health check failed: {e}");
                false
            }
        }
    }

    pub async fn wait_until_ready(&mut self, timeout_secs: u64) -> bool {
        let start = std::time::Instant::now();
        let timeout = Duration::from_secs(timeout_secs);

        debug!("🔍 Waiting for API to be ready (timeout: {timeout_secs}s)");

        while start.elapsed() < timeout {
            if self.is_api_healthy().await {
                debug!("✅ API is healthy and ready");
                return true;
            }
            tokio::time::sleep(API_READY_POLL_INTERVAL).await;
        }

        debug!("⏰ API health check timed out after {timeout_secs}s");
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_engine_process_alive_no_process() {
        let mut engine = RcApiEngine::default();
        assert!(!engine.is_process_alive());
    }

    #[tokio::test]
    async fn test_wait_until_ready_immediate_timeout() {
        let mut engine = RcApiEngine::default();
        // With no process and no API, should timeout quickly
        // Using 1 second timeout to keep test fast
        let start = std::time::Instant::now();
        let result = engine.wait_until_ready(1).await;
        let elapsed = start.elapsed();

        assert!(!result);
        // Should have waited approximately 1 second (with some margin)
        assert!(elapsed >= std::time::Duration::from_millis(800));
        assert!(elapsed <= std::time::Duration::from_millis(1500));
    }
}
