use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use tokio::process::Child;

use crate::rclone::backend::RcloneTransport;

/// Core application state for Rclone operations.
pub struct RcloneState {
    /// Shared HTTP client for rclone API requests and file transfers.
    pub client: reqwest::Client,

    /// Routes rclone calls to HTTP or librclone for the active backend.
    pub transport: Arc<dyn RcloneTransport>,

    /// Cancelled once when the app starts shutting down. Delayed background
    /// work waits on it instead of polling a flag.
    pub shutdown: tokio_util::sync::CancellationToken,
    /// Flag indicating if the system poller is running
    pub poller_running: AtomicBool,
    /// Flag indicating if the system poller is visible
    pub poller_visible: AtomicBool,
    /// Flag indicating if the app is in initial startup phase
    pub initial_startup: AtomicBool,
    /// Serializes deferred startup without marking an unfinished startup complete.
    pub initialization_lock: tokio::sync::Mutex<()>,
    /// Prevents competing vault commands from rotating or removing keys concurrently.
    pub vault_operation_lock: tokio::sync::Mutex<()>,
    /// Flag indicating if the auto-updater is running
    pub updater_running: AtomicBool,
}

impl RcloneState {
    /// Idle state: no startup in progress and the poller hidden. Callers that
    /// need other flags use struct update syntax so new fields stay in one place.
    pub fn new(client: reqwest::Client, transport: Arc<dyn RcloneTransport>) -> Self {
        Self {
            client,
            transport,
            shutdown: tokio_util::sync::CancellationToken::new(),
            poller_running: AtomicBool::new(false),
            poller_visible: AtomicBool::new(false),
            initial_startup: AtomicBool::new(false),
            initialization_lock: tokio::sync::Mutex::new(()),
            vault_operation_lock: tokio::sync::Mutex::new(()),
            updater_running: AtomicBool::new(false),
        }
    }

    /// Check if the application is shutting down
    pub fn is_shutting_down(&self) -> bool {
        self.shutdown.is_cancelled()
    }

    /// Mark the application as shutting down and wake everything waiting on it
    pub fn set_shutting_down(&self) {
        self.shutdown.cancel();
    }

    /// Sleeps for `delay`. Returns `false` if shutdown began before or during the wait.
    pub async fn sleep_unless_shutdown(&self, delay: std::time::Duration) -> bool {
        sleep_unless_cancelled(&self.shutdown, delay).await
    }
}

async fn sleep_unless_cancelled(
    token: &tokio_util::sync::CancellationToken,
    delay: std::time::Duration,
) -> bool {
    tokio::select! {
        biased;
        () = token.cancelled() => false,
        () = tokio::time::sleep(delay) => true,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "phase", content = "detail", rename_all = "camelCase")]
pub enum EnginePhase {
    /// Just constructed or explicitly stopped; no engine process running.
    #[default]
    Stopped,
    /// `start()` has been called and the engine is spawning / waiting for
    /// the API to become ready.
    Starting,
    /// Engine is up and the API responds to `core/ping`.
    Running,
    /// Engine is up but a binary update is in progress; polls should pause.
    /// Only used on desktop (`not(feature = "librclone")`).
    #[cfg(not(feature = "librclone"))]
    Updating,
    /// `shutdown()` has been called; waiting for the child process to exit.
    Stopping,
    /// Cannot start: rclone binary not found / wrong path.
    #[cfg(not(feature = "librclone"))]
    FailedPath,
    /// Cannot start: rclone binary version is below the required minimum.
    #[cfg(not(feature = "librclone"))]
    FailedVersion { version: String, required: String },
    /// Cannot start: config password missing or wrong.
    FailedPassword,
    /// Cannot start: the RC API is reachable but rejected our credentials
    FailedAuth { message: String },
    /// Cannot start: local port is already in use by another process.
    #[cfg(not(feature = "librclone"))]
    FailedPort { port: u16, message: String },
    /// Cannot start: any other unrecoverable error.
    FailedOther { message: String },
}

impl EnginePhase {
    #[must_use]
    pub fn is_operational(&self) -> bool {
        match self {
            Self::Running => true,
            #[cfg(not(feature = "librclone"))]
            Self::Updating => true,
            _ => false,
        }
    }

    #[must_use]
    pub fn start_block_reason(&self) -> Option<&Self> {
        if self.is_failed() { Some(self) } else { None }
    }

    /// True if the engine is shutting down or already stopped.
    #[must_use]
    pub fn is_shutting_down(&self) -> bool {
        matches!(self, Self::Stopping | Self::Stopped)
    }

    #[must_use]
    pub fn is_failed(&self) -> bool {
        match self {
            #[cfg(not(feature = "librclone"))]
            Self::FailedPath
            | Self::FailedVersion { .. }
            | Self::FailedPort { .. }
            | Self::Updating => true,
            Self::FailedPassword | Self::FailedAuth { .. } | Self::FailedOther { .. } => true,
            _ => false,
        }
    }

    #[must_use]
    pub fn is_auth_failure(&self) -> bool {
        matches!(self, Self::FailedPassword | Self::FailedAuth { .. })
    }
}

impl std::fmt::Display for EnginePhase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Stopped => write!(f, "Stopped"),
            Self::Starting => write!(f, "Starting"),
            Self::Running => write!(f, "Running"),
            #[cfg(not(feature = "librclone"))]
            Self::Updating => write!(f, "Updating"),
            Self::Stopping => write!(f, "Stopping"),
            #[cfg(not(feature = "librclone"))]
            Self::FailedPath => write!(f, "Path Error"),
            #[cfg(not(feature = "librclone"))]
            Self::FailedVersion { version, required } => {
                write!(f, "Version Error ({version} < {required})")
            }
            Self::FailedPassword => write!(f, "Password Error"),
            Self::FailedAuth { message } => write!(f, "Auth Error: {message}"),
            #[cfg(not(feature = "librclone"))]
            Self::FailedPort { port, message } => write!(f, "Port Error ({port}): {message}"),
            Self::FailedOther { message } => write!(f, "Error: {message}"),
        }
    }
}

#[cfg_attr(feature = "librclone", derive(Default))]
pub struct RcApiEngine {
    pub phase: EnginePhase,
    pub process: Option<Child>,
    /// Backend that `process` was spawned for. The active backend can change while the
    /// child keeps running, so shutdown must not address its quit request to the active one.
    #[cfg(not(feature = "librclone"))]
    pub process_backend: Option<String>,
    #[cfg(not(feature = "librclone"))]
    pub current_api_port: u16,
}

/// Thread-safe, async-friendly managed state for the engine
pub type EngineState = tokio::sync::Mutex<RcApiEngine>;

#[cfg(test)]
mod shutdown_tests {
    use super::*;
    use std::time::Duration;

    fn token_after(delay: Duration) -> tokio_util::sync::CancellationToken {
        let token = tokio_util::sync::CancellationToken::new();
        let cancel = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            cancel.cancel();
        });
        token
    }

    #[tokio::test]
    async fn a_zero_delay_completes_unless_shutdown_already_began() {
        let token = tokio_util::sync::CancellationToken::new();
        assert!(sleep_unless_cancelled(&token, Duration::ZERO).await);

        token.cancel();
        assert!(!sleep_unless_cancelled(&token, Duration::ZERO).await);
    }

    #[tokio::test]
    async fn waits_for_the_full_delay_when_not_cancelled() {
        let token = tokio_util::sync::CancellationToken::new();
        let start = std::time::Instant::now();
        assert!(sleep_unless_cancelled(&token, Duration::from_millis(60)).await);
        assert!(start.elapsed() >= Duration::from_millis(60));
    }

    #[tokio::test]
    async fn shutdown_during_the_wait_ends_it_immediately() {
        let token = token_after(Duration::from_millis(20));
        let start = std::time::Instant::now();
        assert!(!sleep_unless_cancelled(&token, Duration::from_secs(30)).await);
        assert!(start.elapsed() < Duration::from_secs(5));
    }
}
