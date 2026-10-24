//! Desktop window and optional tray integration (also available to the web host).
#[cfg(feature = "tray")]
pub(crate) mod tray;
#[cfg(not(feature = "web-server"))]
pub(crate) mod window;

#[cfg(not(feature = "web-server"))]
pub(crate) mod debug;

#[cfg(any(
    feature = "tauri-plugin-autostart",
    all(target_os = "linux", feature = "flatpak")
))]
pub(crate) mod autostart;
#[cfg(all(target_os = "linux", not(feature = "web-server")))]
pub(crate) mod graphics;

#[cfg(feature = "portable")]
pub(crate) mod paths;
