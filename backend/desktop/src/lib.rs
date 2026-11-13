//! Native Tauri application and optional server-tray composition.
pub(crate) use rclone_manager_core::{rclone, services, utils};
mod app;
mod cli;
mod context;
#[cfg(desktop)]
mod desktop;
mod native;
pub use native::run;

/// Process-wide setup that must run before any thread (including the async runtime)
/// exists, because it changes the environment.
pub fn prepare_environment() {
    // WebKitGTK rendering workarounds (NVIDIA only) apply before any webview is created;
    // skipped in headless web-server and mobile builds.
    #[cfg(all(desktop, target_os = "linux", not(feature = "web-server")))]
    desktop::graphics::apply_linux_graphics_quirks();
}
