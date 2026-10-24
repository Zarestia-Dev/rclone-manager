//! Tauri runtime shared by desktop, mobile, and the optional server tray.
mod plugins;
mod runtime;
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

#[cfg(target_os = "macos")]
pub(crate) mod dock;

#[cfg(not(feature = "portable"))]
pub(crate) mod paths;

#[cfg(feature = "tauri-plugin-notification")]
pub(crate) mod notification;

#[cfg(feature = "updater")]
pub(crate) mod updater;

pub(crate) mod lifecycle;

pub(crate) mod host;
