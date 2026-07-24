use log::{debug, warn};
use std::time::Duration;
use tauri::{AppHandle, Manager};

use crate::rclone::backend::transport::BackendError;
use crate::utils::rclone::endpoints::core;
use crate::utils::types::state::{RcApiEngine, RcloneState};

const API_HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(not(feature = "librclone"))]
const API_READY_POLL_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthStatus {
    Healthy,
    AuthRequired,
    Unreachable,
}

impl HealthStatus {
    #[must_use]
    pub fn is_healthy(self) -> bool {
        matches!(self, Self::Healthy)
    }

    #[must_use]
    pub fn is_auth_failure(self) -> bool {
        matches!(self, Self::AuthRequired)
    }
}

impl RcApiEngine {
    #[cfg(not(feature = "librclone"))]
    pub async fn probe_api_health(&self, app: &AppHandle) -> HealthStatus {
        Self::check_api_health_with_status(app).await
    }

    #[cfg(not(feature = "librclone"))]
    pub async fn is_api_healthy(&self, app: &AppHandle) -> bool {
        self.probe_api_health(app).await.is_healthy()
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
            debug!("No tracked child process (engine may still be running externally)");
            false
        }
    }

    pub async fn check_api_health_with_status(app: &AppHandle) -> HealthStatus {
        let transport = app.state::<RcloneState>().transport.clone();

        match transport
            .rpc_with_timeout(core::VERSION, None, API_HEALTH_TIMEOUT)
            .await
        {
            Ok(_) => {
                debug!("API health check: healthy");
                HealthStatus::Healthy
            }
            Err(BackendError::Rpc {
                status,
                ref message,
                endpoint: _,
            }) if status == 401 || status == 403 => {
                warn!("API health check: auth rejected (HTTP {status}): {message}");
                HealthStatus::AuthRequired
            }
            Err(e) => {
                debug!("API health check: unreachable ({e})");
                HealthStatus::Unreachable
            }
        }
    }

    #[cfg(not(feature = "librclone"))]
    pub async fn wait_until_ready(
        &self,
        app: &AppHandle,
        timeout_secs: u64,
    ) -> Result<(), WaitReadyError> {
        let timeout = Duration::from_secs(timeout_secs);
        debug!("Waiting for API to be ready (timeout: {timeout_secs}s)");

        let check_future = async {
            loop {
                if !self.is_process_alive() {
                    return Err(WaitReadyError::ProcessDied);
                }

                match self.probe_api_health(app).await {
                    HealthStatus::Healthy => return Ok(()),
                    HealthStatus::AuthRequired => {
                        return Err(WaitReadyError::RcAuthFailed);
                    }
                    HealthStatus::Unreachable => {
                        // Normal during startup — the rcd hasn't bound the
                        // port yet. Keep polling.
                        tokio::time::sleep(API_READY_POLL_INTERVAL).await;
                    }
                }
            }
        };

        match tokio::time::timeout(timeout, check_future).await {
            Ok(inner) => {
                debug!("API readiness probe finished: {inner:?}");
                inner
            }
            Err(_) => {
                debug!("API health check timed out after {timeout_secs}s");
                Err(WaitReadyError::Timeout)
            }
        }
    }
}

/// Why [`RcApiEngine::wait_until_ready`] gave up.
#[cfg(not(feature = "librclone"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitReadyError {
    RcAuthFailed,
    ProcessDied,
    Timeout,
}

#[cfg(not(feature = "librclone"))]
impl std::fmt::Display for WaitReadyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RcAuthFailed => write!(f, "RC API rejected credentials (HTTP 401)"),
            Self::ProcessDied => write!(f, "Rclone process exited during startup"),
            Self::Timeout => write!(f, "Timed out waiting for RC API to become ready"),
        }
    }
}

#[cfg(not(feature = "librclone"))]
impl std::error::Error for WaitReadyError {}

#[cfg(all(test, not(feature = "librclone")))]
mod tests {
    use super::*;

    #[test]
    fn test_engine_process_alive_no_process() {
        let engine = RcApiEngine::default();
        assert!(!engine.is_process_alive());
    }

    #[test]
    fn test_health_status_branches() {
        assert!(HealthStatus::Healthy.is_healthy());
        assert!(!HealthStatus::AuthRequired.is_healthy());
        assert!(!HealthStatus::Unreachable.is_healthy());

        assert!(HealthStatus::AuthRequired.is_auth_failure());
        assert!(!HealthStatus::Healthy.is_auth_failure());
        assert!(!HealthStatus::Unreachable.is_auth_failure());
    }

    #[test]
    fn test_wait_ready_error_display() {
        assert_eq!(
            WaitReadyError::RcAuthFailed.to_string(),
            "RC API rejected credentials (HTTP 401)"
        );
        assert_eq!(
            WaitReadyError::ProcessDied.to_string(),
            "Rclone process exited during startup"
        );
        assert_eq!(
            WaitReadyError::Timeout.to_string(),
            "Timed out waiting for RC API to become ready"
        );
    }
}
