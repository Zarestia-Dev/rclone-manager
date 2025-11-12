use log::debug;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::time::sleep;

use crate::utils::{
    rclone::endpoints::{EndpointHelper, core},
    types::all_types::{RcApiEngine, RcloneState},
};

impl RcApiEngine {
    pub async fn is_api_healthy(&mut self, app: &AppHandle) -> bool {
        if !self.is_process_alive() {
            debug!("🔍 Process is not alive");
            return false;
        }

        self.check_api_response(app).await
    }

    pub fn is_process_alive(&mut self) -> bool {
        if let Some(_child) = &mut self.process {
            true
        } else {
            debug!("🔍 No process found");
            false
        }
    }

    async fn check_api_response(&self, app: &AppHandle) -> bool {
        let base_url = format!("http://127.0.0.1:{}", self.current_api_port);
        let url = EndpointHelper::build_url(&base_url, core::VERSION);

        let client = &app.state::<RcloneState>().client;

        match client
            .post(&url)
            .timeout(Duration::from_secs(2))
            .send()
            .await
        {
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

    pub async fn wait_until_ready(&mut self, app: &AppHandle, timeout_secs: u64) -> bool {
        let start = std::time::Instant::now();
        let timeout = Duration::from_secs(timeout_secs);
        let poll = Duration::from_millis(500);

        debug!("🔍 Waiting for API to be ready (timeout: {timeout_secs}s)");

        while start.elapsed() < timeout {
            if self.is_api_healthy(app).await {
                debug!("✅ API is healthy and ready");
                return true;
            }
            sleep(poll).await;
        }

        debug!("⏰ API health check timed out after {timeout_secs}s");
        false
    }
}
