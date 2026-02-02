use log::debug;
use std::time::Duration;

use crate::rclone::backend::BackendManager;
use crate::utils::rclone::endpoints::core;
use crate::utils::types::core::RcApiEngine;

/// Duration constants for health checks
const API_HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
const API_READY_POLL_INTERVAL: Duration = Duration::from_millis(500);

impl RcApiEngine {
    /// Check if both the process is running AND the API is responding
    pub async fn is_api_healthy(
        &mut self,
        client: &reqwest::Client,
        backend_manager: &BackendManager,
    ) -> bool {
        // First check if process is still alive
        if !self.is_process_alive() {
            debug!("🔍 Process is not alive");
            return false;
        }

        self.check_api_response(client, backend_manager).await
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
    async fn check_api_response(
        &self,
        client: &reqwest::Client,
        backend_manager: &BackendManager,
    ) -> bool {
        Self::check_api_health(client, backend_manager).await
    }

    /// Check if the active backend's API is responding
    ///
    /// Returns true if the API returns a successful response.
    pub async fn check_api_health(
        client: &reqwest::Client,
        backend_manager: &BackendManager,
    ) -> bool {
        let backend = backend_manager.get_active().await;
        let endpoint = core::VERSION;

        match backend
            .make_request(
                client,
                reqwest::Method::POST,
                endpoint,
                None,
                Some(API_HEALTH_TIMEOUT),
            )
            .await
        {
            Ok(_) => {
                debug!("🔍 API health check: healthy");
                true
            }
            Err(e) => {
                debug!("🔍 API health check failed: {e}");
                false
            }
        }
    }

    pub async fn wait_until_ready(
        &mut self,
        client: &reqwest::Client,
        backend_manager: &BackendManager,
        timeout_secs: u64,
    ) -> bool {
        let timeout = Duration::from_secs(timeout_secs);
        debug!("🔍 Waiting for API to be ready (timeout: {timeout_secs}s)");

        let check_future = async {
            loop {
                if self.is_api_healthy(client, backend_manager).await {
                    return true;
                }
                tokio::time::sleep(API_READY_POLL_INTERVAL).await;
            }
        };

        match tokio::time::timeout(timeout, check_future).await {
            Ok(_) => {
                debug!("✅ API is healthy and ready");
                true
            }
            Err(_) => {
                debug!("⏰ API health check timed out after {timeout_secs}s");
                false
            }
        }
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
}
