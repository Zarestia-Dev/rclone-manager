//! Application state access. Native builds use Tauri; servers own their state and lifecycle.
#[cfg(feature = "native-tauri")]
pub use tauri::{AppHandle, Manager, State};

#[cfg(not(feature = "native-tauri"))]
pub use headless::{AppHandle, Manager, State};

#[cfg(not(feature = "native-tauri"))]
mod headless;
