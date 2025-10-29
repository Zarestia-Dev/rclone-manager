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

    // /// Check if the application is updating
    // pub fn is_updating(&self) -> bool {
    //     self.is_updating.load(Ordering::SeqCst)
    // }

    // /// Set the application updating flag
    // pub fn set_updating(&self, updating: bool) {
    //     self.is_updating.store(updating, Ordering::SeqCst);
    // }

    // /// Check if the application is starting
    // pub fn is_starting(&self) -> bool {
    //     self.is_starting.load(Ordering::SeqCst)
    // }

    // /// Set the application starting flag
    // pub fn set_starting(&self, starting: bool) {
    //     self.is_starting.store(starting, Ordering::SeqCst);
    // }
}
