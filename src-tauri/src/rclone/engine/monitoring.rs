use log::debug;
use std::time::Duration;

use crate::utils::{
    rclone::endpoints::{EndpointHelper, core},
    types::all_types::RcApiEngine,
};

impl RcApiEngine {
    /// Check if both the process is running AND the API is responding
    pub fn is_api_healthy(&mut self) -> bool {
        // First check if process is still alive
        if !self.is_process_alive() {
            debug!("🔍 Process is not alive");
            return false;
        }

        self.check_api_response()
    }

    /// Check if the process is still alive (without checking API)
    pub fn is_process_alive(&mut self) -> bool {
        if let Some(_child) = &mut self.process {
            // FIX: CommandChild has no sync try_wait. The most reliable way to check
            // if it's "alive" from a synchronous context is to assume it is if the
            // handle exists and let the API check confirm it. For a more robust check,
            // you would need to use the async CommandEvent receiver or check the PID.
            // For now, we return true and let the API health check do the real work.
            true
        } else {
            debug!("🔍 No process found");
            false
        }
    }

    /// Check if the API is responding by making a simple request
    fn check_api_response(&self) -> bool {
        let base_url = format!("http://127.0.0.1:{}", self.current_api_port);
        let url = EndpointHelper::build_url(&base_url, core::VERSION);

        // Use blocking client for synchronous check
        let client = reqwest::blocking::Client::new();
        match client.post(&url).timeout(Duration::from_secs(2)).send() {
            Ok(response) => {
                let is_healthy = response.status().is_success();
                debug!(
                    "🔍 API health check: {} (status: {})",
                    if is_healthy { "healthy" } else { "unhealthy" },
                    response.status()
                );
                is_healthy
            }
            Err(e) => {
                debug!("🔍 API health check failed: {e}");
                false
            }
        }
    }

    pub fn wait_until_ready(&mut self, timeout_secs: u64) -> bool {
        let start = std::time::Instant::now();
        let timeout = Duration::from_secs(timeout_secs);
        let poll = Duration::from_millis(500);

        debug!("🔍 Waiting for API to be ready (timeout: {timeout_secs}s)");

        while start.elapsed() < timeout {
            if self.is_api_healthy() {
                debug!("✅ API is healthy and ready");
                return true;
            }
            std::thread::sleep(poll);
        }

        debug!("⏰ API health check timed out after {timeout_secs}s");
        false
    }
}
