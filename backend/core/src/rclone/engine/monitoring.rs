use crate::context::AppHandle;
use log::{debug, warn};
use std::time::Duration;

use crate::rclone::backend::transport::BackendError;
use crate::rclone::endpoints::core;
use crate::utils::types::state::{RcApiEngine, RcloneState};

const API_HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
const API_READY_POLL_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthStatus {
    Healthy,
    AuthRequired,
    Unreachable,
}

impl RcApiEngine {
    /// Check if the process is still alive using native PID checking.
    #[must_use]
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

    pub async fn wait_until_ready(
        &mut self,
        app: &AppHandle,
        timeout_secs: u64,
    ) -> Result<(), WaitReadyError> {
        let timeout = Duration::from_secs(timeout_secs);
        debug!("Waiting for API to be ready (timeout: {timeout_secs}s)");

        let check_future = async {
            loop {
                // Check if the spawned child process has exited (try_wait reaps status & handles zombies immediately)
                if let Some(child) = &mut self.process {
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            debug!("Child process exited with status: {status}");
                            return Err(WaitReadyError::ProcessDied);
                        }
                        Ok(None) => {}
                        Err(e) => {
                            debug!("Error checking child process status: {e}");
                            return Err(WaitReadyError::ProcessDied);
                        }
                    }
                } else if !self.is_process_alive() {
                    return Err(WaitReadyError::ProcessDied);
                }

                match Self::check_api_health_with_status(app).await {
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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitReadyError {
    RcAuthFailed,
    ProcessDied,
    Timeout,
}

impl std::fmt::Display for WaitReadyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RcAuthFailed => write!(f, "RC API rejected credentials (HTTP 401)"),
            Self::ProcessDied => write!(f, "Rclone process exited during startup"),
            Self::Timeout => write!(f, "Timed out waiting for RC API to become ready"),
        }
    }
}

impl std::error::Error for WaitReadyError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rclone::backend::{RcloneTransport, TransportKind};
    use parking_lot::Mutex;
    use serde_json::{Value, json};
    use std::sync::{Arc, atomic::AtomicBool};

    struct HealthTransport(Mutex<Option<Result<Value, BackendError>>>);

    #[async_trait::async_trait]
    impl RcloneTransport for HealthTransport {
        async fn kind(&self) -> TransportKind {
            TransportKind::HttpDaemon
        }

        async fn rpc(
            &self,
            endpoint: &str,
            payload: Option<&Value>,
        ) -> Result<Value, BackendError> {
            assert_eq!(endpoint, core::VERSION);
            assert!(payload.is_none());
            let response = self.0.lock().take();
            match response {
                Some(result) => result,
                None => std::future::pending().await,
            }
        }

        async fn read_file(
            &self,
            _remote: &str,
            _path: &str,
            _range: Option<(u64, Option<u64>)>,
        ) -> Result<Box<dyn tokio::io::AsyncRead + Unpin + Send>, BackendError> {
            panic!("health checks must not read files")
        }
    }

    fn app_with_response(response: Option<Result<Value, BackendError>>) -> AppHandle {
        let app = AppHandle::default();
        app.manage(RcloneState {
            client: reqwest::Client::new(),
            transport: Arc::new(HealthTransport(Mutex::new(response))),
            is_shutting_down: AtomicBool::new(false),
            poller_running: AtomicBool::new(false),
            poller_visible: AtomicBool::new(true),
            initial_startup: AtomicBool::new(false),
            initialization_lock: tokio::sync::Mutex::new(()),
            vault_operation_lock: tokio::sync::Mutex::new(()),
            updater_running: AtomicBool::new(false),
        });
        app
    }

    #[test]
    fn test_engine_process_alive_no_process() {
        let engine = RcApiEngine::default();
        assert!(!engine.is_process_alive());
    }

    #[tokio::test]
    async fn health_checks_classify_rpc_responses_and_transport_errors() {
        for (response, expected) in [
            (Ok(json!({"version": "v1.73.0"})), HealthStatus::Healthy),
            (Ok(Value::Null), HealthStatus::Healthy),
            (
                Err(BackendError::NotConnected("offline".into())),
                HealthStatus::Unreachable,
            ),
            (
                Err(BackendError::Timeout(API_HEALTH_TIMEOUT)),
                HealthStatus::Unreachable,
            ),
            (
                Err(BackendError::Other("connection failed".into())),
                HealthStatus::Unreachable,
            ),
        ] {
            let app = app_with_response(Some(response));
            assert_eq!(
                RcApiEngine::check_api_health_with_status(&app).await,
                expected
            );
        }

        for status in [401, 403, 404, 500] {
            let app = app_with_response(Some(Err(BackendError::Rpc {
                endpoint: core::VERSION.into(),
                status,
                message: "server response & 旅行".into(),
            })));
            let expected = if status == 401 || status == 403 {
                HealthStatus::AuthRequired
            } else {
                HealthStatus::Unreachable
            };
            assert_eq!(
                RcApiEngine::check_api_health_with_status(&app).await,
                expected
            );
        }
    }

    #[tokio::test]
    async fn health_check_times_out_when_the_transport_does_not_respond() {
        let app = app_with_response(None);
        let started = std::time::Instant::now();
        let status = tokio::time::timeout(
            API_HEALTH_TIMEOUT + Duration::from_secs(1),
            RcApiEngine::check_api_health_with_status(&app),
        )
        .await
        .expect("health check must enforce its timeout");
        assert_eq!(status, HealthStatus::Unreachable);
        assert!(started.elapsed() >= API_HEALTH_TIMEOUT);
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
