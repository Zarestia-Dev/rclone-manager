use crate::utils::types::all_types::RcloneState;
use std::sync::atomic::Ordering;

impl RcloneState {
    /// Check if the application is shutting down
    pub fn is_shutting_down(&self) -> bool {
        self.is_shutting_down.load(Ordering::SeqCst)
    }

    /// Set the application shutdown flag
    pub fn set_shutting_down(&self) {
        self.is_shutting_down.store(true, Ordering::SeqCst);
    }
}
