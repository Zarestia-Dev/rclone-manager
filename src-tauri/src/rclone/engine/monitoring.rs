use std::time::Duration;
use log::debug;

use crate::{
    utils::{
        rclone::endpoints::{core, EndpointHelper},
        types::RcApiEngine,
    },
};

impl RcApiEngine {
    /// Check if both the process is running AND the API is responding
    pub fn is_api_healthy(&mut self) -> bool {
        // First check if process is still alive
        if !self.is_process_alive() {
            debug!("🔍 Process is not alive");
            return false;
        }
        
        // Then check if API is responding
        self.check_api_response()
    }
    
    /// Check if the process is still alive (without checking API)
    pub fn is_process_alive(&mut self) -> bool {
        if let Some(child) = &mut self.process {
            match child.try_wait() {
                Ok(Some(_)) => {
                    // Process has exited
                    debug!("🔍 Process has exited");
                    self.running = false;
                    false
                }
                Ok(_) => {
                    // Process is still running
                    true
                }
                Err(_) => {
                    debug!("🔍 Error checking process status");
                    false
                }
            }
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
                debug!("🔍 API health check: {} (status: {})", 
                       if is_healthy { "healthy" } else { "unhealthy" },
                       response.status());
                is_healthy
            }
            Err(e) => {
                debug!("🔍 API health check failed: {}", e);
                false
            }
        }
    }

    pub fn wait_until_ready(&mut self, timeout_secs: u64) -> bool {
        let start = std::time::Instant::now();
        let timeout = Duration::from_secs(timeout_secs);
        let poll = Duration::from_millis(500); // Increased poll interval

        debug!("🔍 Waiting for API to be ready (timeout: {}s)", timeout_secs);
        
        while start.elapsed() < timeout {
            if self.is_api_healthy() {
                debug!("✅ API is healthy and ready");
                return true;
            }
            std::thread::sleep(poll);
        }

        debug!("⏰ API health check timed out after {}s", timeout_secs);
        false
    }
}