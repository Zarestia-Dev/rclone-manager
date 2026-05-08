use std::sync::atomic::AtomicBool;
use tokio::process::Child;

/// Core application state for Rclone operations.
pub struct RcloneState {
    /// HTTP client for rclone API calls
    pub client: reqwest::Client,
    /// Flag indicating the app is shutting down
    pub is_shutting_down: AtomicBool,
    /// OAuth process state for interactive remote creation
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
    pub updating: bool,
    pub path_error: bool,
    pub password_error: bool,
    pub current_api_port: u16,
}

/// Thread-safe, async-friendly managed state for the engine
pub type EngineState = tokio::sync::Mutex<RcApiEngine>;
