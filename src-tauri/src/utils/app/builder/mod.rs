#[cfg(feature = "tray")]
mod tray;
#[cfg(feature = "tray")]
pub use tray::setup_tray;

#[cfg(not(feature = "web-server"))]
pub mod window;
#[cfg(not(feature = "web-server"))]
pub use window::{create_app_window, present_main_window};
