//! Native handles access one shared backend context managed by Tauri.
use rclone_manager_core::context::{AppHandle as CoreHandle, State};
pub use tauri::{AppHandle, Manager};
pub trait BackendContext<R: tauri::Runtime>: tauri::Manager<R> {
    fn backend(&self) -> &CoreHandle {
        self.state::<CoreHandle>().inner()
    }
    fn backend_state<T: Send + Sync + 'static>(&self) -> State<T> {
        self.backend().state()
    }
    #[cfg(desktop)]
    fn backend_try_state<T: Send + Sync + 'static>(&self) -> Option<State<T>> {
        self.backend().try_state()
    }
}
impl<R: tauri::Runtime, M: tauri::Manager<R>> BackendContext<R> for M {}
