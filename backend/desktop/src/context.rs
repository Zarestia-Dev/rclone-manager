//! Native handles access one shared backend context managed by Tauri.
use rclone_manager_core::context::AppHandle as CoreHandle;
pub use tauri::{AppHandle, Manager};
pub trait BackendContext<R: tauri::Runtime>: tauri::Manager<R> {
    fn backend(&self) -> &CoreHandle {
        self.state::<CoreHandle>().inner()
    }
}
impl<R: tauri::Runtime, M: tauri::Manager<R>> BackendContext<R> for M {}
