#[cfg(not(target_os = "macos"))]
mod autostart;
mod instance;
mod lifecycle;
mod paths;
pub mod runtime;
#[cfg(not(target_os = "macos"))]
mod tray;

/// The name of the app this server replaced (RClone Manager Headless, 0.3.6 and
/// older). Its start-at-login and Send To entries are moved on start.
#[cfg(not(target_os = "macos"))]
const LEGACY_NAME: &str = "RClone Manager Headless";
