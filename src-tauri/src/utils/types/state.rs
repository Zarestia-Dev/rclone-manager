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

pub struct RcApiEngine {
    pub process: Option<Child>,
    pub should_exit: bool,
    pub running: bool,
    pub password_error: bool,
    #[cfg(not(feature = "librclone"))]
    pub updating: bool,
    #[cfg(not(feature = "librclone"))]
    pub path_error: bool,
    #[cfg(not(feature = "librclone"))]
    pub version_error: bool,
    #[cfg(not(feature = "librclone"))]
    pub current_api_port: u16,
}

/// Thread-safe, async-friendly managed state for the engine
pub type EngineState = tokio::sync::Mutex<RcApiEngine>;
