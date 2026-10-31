//! Tauri runtime shared by desktop, mobile, and the optional server tray.
mod plugins;
mod runtime;
#[cfg(not(target_os = "android"))]
pub(crate) mod setup;
pub use runtime::run;

#[cfg(not(feature = "web-server"))]
mod ipc;
#[cfg(not(feature = "web-server"))]
pub(crate) mod protocol;
#[cfg(not(feature = "web-server"))]
pub(crate) mod theme;
#[cfg(all(not(feature = "web-server"), desktop))]
mod window;

#[cfg(not(feature = "web-server"))]
pub(crate) mod events;
#[cfg(not(feature = "web-server"))]
pub(crate) mod files;

#[cfg(target_os = "android")]
pub(crate) mod android;

#[cfg(target_os = "macos")]
pub(crate) mod dock;

#[cfg(all(not(feature = "portable"), not(target_os = "android")))]
pub(crate) mod paths;

#[cfg(all(feature = "tauri-plugin-notification", not(target_os = "android")))]
pub(crate) mod notification;

#[cfg(feature = "updater")]
pub(crate) mod updater;

#[cfg(not(target_os = "android"))]
pub(crate) mod lifecycle;

#[cfg(not(target_os = "android"))]
pub(crate) mod host;
