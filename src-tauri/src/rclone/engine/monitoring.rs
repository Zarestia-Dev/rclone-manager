use log::debug;
use std::time::Duration;
use tauri::{AppHandle, Manager};

use crate::utils::rclone::endpoints::core;
use crate::utils::types::state::{RcApiEngine, RcloneState};

const API_HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(not(feature = "librclone"))]
const API_READY_POLL_INTERVAL: Duration = Duration::from_millis(500);

impl RcApiEngine {
    /// Check if both the process is running AND the API is responding.
    #[cfg(not(feature = "librclone"))]
    pub async fn is_api_healthy(&self, app: &AppHandle) -> bool {
        if !self.is_process_alive() {
            debug!("Process is not alive");
            return false;
        }
        Self::check_api_health(app).await
    }

    /// Check if the process is still alive using native PID checking.
    #[must_use]
    #[cfg(not(feature = "librclone"))]
    pub fn is_process_alive(&self) -> bool {
        if let Some(child) = &self.process {
            if let Some(pid) = child.id() {
                let alive = crate::utils::process::process_manager::is_process_alive(pid);
                if !alive {
                    debug!("Process {pid} is no longer running");
                }
                alive
            } else {
                debug!("Process has no PID");
                false
            }
        } else {
            debug!("No process found");
            false
        }
    }

    /// Check if the active backend's API is responding.
    pub async fn check_api_health(app: &AppHandle) -> bool {
        let transport = app.state::<RcloneState>().transport.clone();

        match transport
            .rpc_with_timeout(core::VERSION, None, API_HEALTH_TIMEOUT)
            .await
        {
            Ok(_) => {
                debug!("API health check: healthy");
                true
            }
            Err(e) => {
                debug!("API health check failed: {e}");
                false
            }
        }
    }

    #[cfg(not(feature = "librclone"))]
    pub async fn wait_until_ready(&self, app: &AppHandle, timeout_secs: u64) -> bool {
        let timeout = Duration::from_secs(timeout_secs);
        debug!("Waiting for API to be ready (timeout: {timeout_secs}s)");

        let check_future = async {
            loop {
                if self.is_api_healthy(app).await {
                    return true;
                }
                tokio::time::sleep(API_READY_POLL_INTERVAL).await;
            }
        };

        if tokio::time::timeout(timeout, check_future).await.is_ok() {
            debug!("API is healthy and ready");
            true
        } else {
            debug!("API health check timed out after {timeout_secs}s");
            false
        }
    }
}

#[cfg(all(test, not(feature = "librclone")))]
mod tests {
    use super::*;

    #[test]
    fn test_engine_process_alive_no_process() {
        let engine = RcApiEngine::default();
        assert!(!engine.is_process_alive());
    }
}
