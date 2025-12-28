use log::error;
use once_cell::sync::Lazy;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use crate::utils::types::all_types::RcApiEngine;

/// Default port for the rclone API
pub const DEFAULT_API_PORT: u16 = 51900;

pub static ENGINE: Lazy<Arc<Mutex<RcApiEngine>>> =
    Lazy::new(|| Arc::new(Mutex::new(RcApiEngine::default())));

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

use std::fmt;

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
            config_encrypted: None,
        }
    }
}

impl RcApiEngine {
    pub fn lock_engine() -> Result<std::sync::MutexGuard<'static, RcApiEngine>, String> {
        match ENGINE.lock() {
            Ok(guard) => Ok(guard),
            Err(poisoned) => {
                error!("❗ Engine mutex poisoned. Recovering...");
                Ok(poisoned.into_inner())
            }
        }
    }

    /// Execute a closure with the engine lock
    pub fn with_lock<F, R>(f: F) -> Result<R, String>
    where
        F: FnOnce(&mut RcApiEngine) -> R,
    {
        let mut engine = Self::lock_engine()?;
        Ok(f(&mut engine))
    }

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

    /// Check why engine cannot start, if blocked
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

    // -------------------------------------------------------------------------
    // Encryption cache
    // -------------------------------------------------------------------------

    pub fn get_encryption_cached() -> Option<bool> {
        Self::lock_engine().ok().and_then(|e| e.config_encrypted)
    }

    pub fn set_encryption_cached(encrypted: bool) {
        if let Ok(mut engine) = Self::lock_engine() {
            engine.config_encrypted = Some(encrypted);
        }
    }

    pub fn clear_encryption_cache() {
        if let Ok(mut engine) = Self::lock_engine() {
            engine.config_encrypted = None;
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

    #[test]
    fn test_lock_engine() {
        assert!(RcApiEngine::lock_engine().is_ok());
    }

    #[test]
    fn test_with_lock() {
        let result = RcApiEngine::with_lock(|e| {
            e.password_error = true;
            42
        });
        assert_eq!(result.unwrap(), 42);
        let _ = RcApiEngine::with_lock(|e| e.password_error = false);
    }

    #[test]
    fn test_encryption_cache() {
        RcApiEngine::clear_encryption_cache();
        RcApiEngine::set_encryption_cached(true);
        assert_eq!(RcApiEngine::get_encryption_cached(), Some(true));
        RcApiEngine::clear_encryption_cache();
    }
}
