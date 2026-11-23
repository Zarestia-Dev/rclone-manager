//! Tauri runtime shared by desktop, mobile, and the optional server tray.
mod plugins;
mod runtime;
#[cfg(not(target_os = "android"))]
pub(crate) mod setup;
pub use runtime::run;

mod ipc;
#[cfg(all(feature = "desktop", target_os = "linux"))]
mod portal;
pub(crate) mod protocol;
pub(crate) mod theme;
#[cfg(desktop)]
mod window;

pub(crate) mod events;
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
pub(crate) mod host;
