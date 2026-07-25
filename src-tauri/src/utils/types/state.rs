use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use tokio::process::Child;

use crate::rclone::backend::RcloneTransport;

/// Core application state for Rclone operations.
pub struct RcloneState {
    /// HTTP client for rclone API calls.
    ///
    /// On the HTTP transport (desktop), this is used by [`RcHttpBackend`] and
    /// by a few remaining direct-HTTP call sites (connectivity checks, file
    /// streaming in the protocol handler, OAuth helper, multipart upload).
    /// On the librclone transport (mobile), this field is unused by rclone
    /// calls but may still be needed for non-rclone HTTP (alerts dispatch,
    /// github_client) — those callers should get their own client rather
    /// than reaching into `RcloneState`.
    pub client: reqwest::Client,

    /// The rclone transport — the single entry point for all rc calls.
    ///
    /// Constructed once in `setup_app` based on the `librclone` feature:
    /// - `#[cfg(not(feature = "librclone"))]` → `Arc::new(RcHttpBackend::new(app))`
    /// - `#[cfg(feature = "librclone")]` → `Arc::new(RcloneLibBackend::new())` (Phase 3)
    ///
    /// Held as `Arc<dyn RcloneTransport>` so callers don't know the concrete type.
    pub transport: Arc<dyn RcloneTransport>,

    /// Flag indicating the app is shutting down
    pub is_shutting_down: AtomicBool,
    /// OAuth process state for interactive remote creation
    #[cfg(not(feature = "librclone"))]
    pub oauth_process: tokio::sync::Mutex<Option<Child>>,
    /// Flag indicating if the system poller is running
    pub poller_running: AtomicBool,
    /// Flag indicating if the system poller is visible
    pub poller_visible: AtomicBool,
    /// Flag indicating if the app is in initial startup phase
    pub initial_startup: AtomicBool,
    /// Flag indicating if the auto-updater is running
    pub updater_running: AtomicBool,
}

impl RcloneState {
    /// Check if the application is shutting down
    pub fn is_shutting_down(&self) -> bool {
        self.is_shutting_down
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Set the application shutdown flag
    pub fn set_shutting_down(&self) {
        self.is_shutting_down
            .store(true, std::sync::atomic::Ordering::SeqCst);
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
            Self::FailedPath | Self::FailedVersion { .. } | Self::Updating => true,
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
            Self::FailedOther { message } => write!(f, "Error: {message}"),
        }
    }
}

#[cfg_attr(feature = "librclone", derive(Default))]
pub struct RcApiEngine {
    pub phase: EnginePhase,
    pub process: Option<Child>,
    #[cfg(not(feature = "librclone"))]
    pub current_api_port: u16,
}

/// Thread-safe, async-friendly managed state for the engine
pub type EngineState = tokio::sync::Mutex<RcApiEngine>;
