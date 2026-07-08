use crate::utils::types::state::RcApiEngine;
use std::fmt;

pub const DEFAULT_API_PORT: u16 = 51900;
#[cfg(not(feature = "librclone"))]
pub const DEFAULT_OAUTH_PORT: u16 = 51901;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PauseReason {
    Password,
    #[cfg(not(feature = "librclone"))]
    Path,
    #[cfg(not(feature = "librclone"))]
    Version,
    #[cfg(not(feature = "librclone"))]
    Updating,
}

impl fmt::Display for PauseReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PauseReason::Password => write!(f, "Password Error"),
            #[cfg(not(feature = "librclone"))]
            PauseReason::Path => write!(f, "Path Error"),
            #[cfg(not(feature = "librclone"))]
            PauseReason::Version => write!(f, "Version Error"),
            #[cfg(not(feature = "librclone"))]
            PauseReason::Updating => write!(f, "Updating"),
        }
    }
}

impl Default for RcApiEngine {
    fn default() -> Self {
        Self {
            process: None,
            should_exit: false,
            password_error: false,
            running: false,
            #[cfg(not(feature = "librclone"))]
            updating: false,
            #[cfg(not(feature = "librclone"))]
            path_error: false,
            #[cfg(not(feature = "librclone"))]
            version_error: false,
            #[cfg(not(feature = "librclone"))]
            current_api_port: DEFAULT_API_PORT,
        }
    }
}

impl RcApiEngine {
    pub fn set_password_error(&mut self, error: bool) {
        self.password_error = error;
    }

    #[cfg(not(feature = "librclone"))]
    pub fn set_updating(&mut self, updating: bool) {
        self.updating = updating;
    }

    #[cfg(not(feature = "librclone"))]
    pub fn set_path_error(&mut self, error: bool) {
        self.path_error = error;
    }

    #[cfg(not(feature = "librclone"))]
    pub fn set_version_error(&mut self, error: bool) {
        self.version_error = error;
    }

    pub fn clear_errors(&mut self) {
        self.password_error = false;
        #[cfg(not(feature = "librclone"))]
        {
            self.path_error = false;
            self.version_error = false;
        }
    }

    #[must_use]
    pub fn start_blocked_reason(&self) -> Option<PauseReason> {
        #[cfg(feature = "librclone")]
        {
            if self.password_error {
                Some(PauseReason::Password)
            } else {
                None
            }
        }
        #[cfg(not(feature = "librclone"))]
        {
            if self.updating {
                Some(PauseReason::Updating)
            } else if self.password_error {
                Some(PauseReason::Password)
            } else if self.path_error {
                Some(PauseReason::Path)
            } else if self.version_error {
                Some(PauseReason::Version)
            } else {
                None
            }
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

        engine.password_error = true;
        assert_eq!(engine.start_blocked_reason(), Some(PauseReason::Password));
        engine.password_error = false;

        #[cfg(not(feature = "librclone"))]
        {
            engine.updating = true;
            assert_eq!(engine.start_blocked_reason(), Some(PauseReason::Updating));
            engine.updating = false;

            engine.path_error = true;
            assert_eq!(engine.start_blocked_reason(), Some(PauseReason::Path));
            engine.path_error = false;

            engine.version_error = true;
            assert_eq!(engine.start_blocked_reason(), Some(PauseReason::Version));
        }
    }
}
