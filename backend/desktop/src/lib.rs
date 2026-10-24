//! Native Tauri application and optional server-tray composition.
pub(crate) use rclone_manager_core::{rclone, services, utils};
mod app;
mod context;
#[cfg(desktop)]
mod desktop;
mod native;
pub use native::run;

mod cli;
