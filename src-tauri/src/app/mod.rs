//! Application composition: shared services and target-specific runtime adapters.
mod send_to;
mod setup;

#[cfg(feature = "native-tauri")]
mod native;
#[cfg(feature = "native-tauri")]
pub use native::run;

#[cfg(not(feature = "native-tauri"))]
mod headless;
#[cfg(not(feature = "native-tauri"))]
pub use headless::run;

#[cfg(all(desktop, feature = "tray"))]
mod tray;

#[cfg(feature = "native-tauri")]
mod plugins;
#[cfg(all(feature = "native-tauri", not(feature = "web-server")))]
mod window;

#[cfg(feature = "web-server")]
mod server;
