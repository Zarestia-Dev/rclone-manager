use crate::utils::types::core::RcApiEngine;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};

/// Default port for the rclone API
pub const DEFAULT_API_PORT: u16 = 51900;

/// Cached flag: is the active backend local?
static ACTIVE_IS_LOCAL: AtomicBool = AtomicBool::new(true);

/// Check if active backend is local (fast, no async)
pub fn is_active_backend_local() -> bool {
    ACTIVE_IS_LOCAL.load(Ordering::Relaxed)
}

/// Set the active backend local flag (call when switching backends)
pub fn set_active_is_local(is_local: bool) {
    ACTIVE_IS_LOCAL.store(is_local, Ordering::Relaxed);
}

/// Why the engine cannot start
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PauseReason {
    Password,
    Path,
    Updating,
}

impl std::fmt::Display for PauseReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PauseReason::Password => write!(f, "Password Error"),
            PauseReason::Path => write!(f, "Path Error"),
            PauseReason::Updating => write!(f, "Updating"),
        }
    }
}

impl Default for RcApiEngine {
    fn default() -> Self {
        Self {
            process: None,
            should_exit: false,
            running: false,
            updating: false,
            path_error: false,
            password_error: false,
            current_api_port: DEFAULT_API_PORT,
        }
    }
}

impl RcApiEngine {
    // -------------------------------------------------------------------------
    // State setters
    // -------------------------------------------------------------------------

    pub fn set_updating(&mut self, updating: bool) {
        self.updating = updating;
    }

    pub fn set_path_error(&mut self, error: bool) {
        self.path_error = error;
    }

    pub fn set_password_error(&mut self, error: bool) {
        self.password_error = error;
    }

    pub fn clear_errors(&mut self) {
        self.path_error = false;
        self.password_error = false;
    }

    pub fn start_blocked_reason(&self) -> Option<PauseReason> {
        if self.updating {
            Some(PauseReason::Updating)
        } else if self.password_error {
            Some(PauseReason::Password)
        } else if self.path_error {
            Some(PauseReason::Path)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_start_blocked_reason() {
        let mut engine = RcApiEngine::default();
        assert!(engine.start_blocked_reason().is_none());

        engine.updating = true;
        assert_eq!(engine.start_blocked_reason(), Some(PauseReason::Updating));

        engine.updating = false;
        engine.password_error = true;
        assert_eq!(engine.start_blocked_reason(), Some(PauseReason::Password));

        engine.password_error = false;
        engine.path_error = true;
        assert_eq!(engine.start_blocked_reason(), Some(PauseReason::Path));
    }

    #[test]
    fn test_active_is_local() {
        set_active_is_local(false);
        assert!(!is_active_backend_local());
        set_active_is_local(true);
        assert!(is_active_backend_local());
    }
}
