use crate::utils::types::state::{EnginePhase, RcApiEngine};

pub const DEFAULT_API_PORT: u16 = 51900;
#[cfg(not(feature = "librclone"))]
pub const DEFAULT_OAUTH_PORT: u16 = 51901;

#[cfg(not(feature = "librclone"))]
impl Default for RcApiEngine {
    fn default() -> Self {
        Self {
            phase: EnginePhase::default(),
            process: None,
            current_api_port: DEFAULT_API_PORT,
        }
    }
}

impl RcApiEngine {
    /// Mark the engine as currently running and operational.
    pub fn mark_running(&mut self) {
        self.phase = EnginePhase::Running;
    }

    /// Mark the engine as stopped (no process running).
    pub fn mark_stopped(&mut self) {
        self.phase = EnginePhase::Stopped;
    }

    /// Mark the engine as shutting down.
    pub fn mark_stopping(&mut self) {
        self.phase = EnginePhase::Stopping;
    }

    /// Mark the engine as starting.
    pub fn mark_starting(&mut self) {
        self.phase = EnginePhase::Starting;
    }

    #[cfg(not(feature = "librclone"))]
    pub fn set_updating(&mut self, updating: bool) {
        if updating {
            self.phase = EnginePhase::Updating;
        } else if matches!(self.phase, EnginePhase::Updating) {
            self.phase = EnginePhase::Stopped;
        }
    }

    /// Mark the engine as having a password-related failure.
    pub fn mark_password_failed(&mut self) {
        self.phase = EnginePhase::FailedPassword;
    }

    /// Mark the engine as having a binary-path failure (desktop only).
    #[cfg(not(feature = "librclone"))]
    pub fn mark_path_failed(&mut self) {
        self.phase = EnginePhase::FailedPath;
    }

    /// Mark the engine as having a version-too-old failure (desktop only).
    #[cfg(not(feature = "librclone"))]
    pub fn mark_version_failed(&mut self, version: String, required: String) {
        self.phase = EnginePhase::FailedVersion { version, required };
    }

    /// Mark the engine as having an unspecified failure.
    pub fn mark_other_failed(&mut self, message: String) {
        self.phase = EnginePhase::FailedOther { message };
    }

    pub fn clear_errors(&mut self) {
        if self.phase.is_failed() {
            self.phase = EnginePhase::Stopped;
        }
    }

    #[must_use]
    pub fn is_running(&self) -> bool {
        self.phase.is_operational()
    }

    #[must_use]
    pub fn start_block_reason(&self) -> Option<&EnginePhase> {
        self.phase.start_block_reason()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_start_block_reason() {
        let mut engine = RcApiEngine::default();
        assert!(engine.start_block_reason().is_none());

        engine.mark_password_failed();
        assert!(matches!(
            engine.start_block_reason(),
            Some(EnginePhase::FailedPassword)
        ));

        #[cfg(not(feature = "librclone"))]
        {
            engine.clear_errors();
            engine.set_updating(true);
            assert!(matches!(
                engine.start_block_reason(),
                Some(EnginePhase::Updating)
            ));

            engine.clear_errors();
            engine.mark_path_failed();
            assert!(matches!(
                engine.start_block_reason(),
                Some(EnginePhase::FailedPath)
            ));

            engine.clear_errors();
            engine.mark_version_failed("1.50".into(), "1.70".into());
            assert!(matches!(
                engine.start_block_reason(),
                Some(EnginePhase::FailedVersion { .. })
            ));
        }
    }

    #[test]
    fn test_phase_transitions() {
        let mut engine = RcApiEngine::default();
        assert!(matches!(engine.phase, EnginePhase::Stopped));
        assert!(!engine.is_running());

        engine.mark_starting();
        assert!(matches!(engine.phase, EnginePhase::Starting));
        assert!(!engine.is_running()); // Starting is not yet operational

        engine.mark_running();
        assert!(matches!(engine.phase, EnginePhase::Running));
        assert!(engine.is_running());

        engine.mark_stopping();
        assert!(matches!(engine.phase, EnginePhase::Stopping));
        assert!(!engine.is_running());

        engine.mark_stopped();
        assert!(matches!(engine.phase, EnginePhase::Stopped));
        assert!(!engine.is_running());
    }

    #[test]
    fn test_clear_errors_only_clears_failed_states() {
        let mut engine = RcApiEngine::default();
        engine.mark_running();
        engine.clear_errors();
        assert!(matches!(engine.phase, EnginePhase::Running));

        engine.mark_password_failed();
        engine.clear_errors();
        assert!(matches!(engine.phase, EnginePhase::Stopped));
    }
}
