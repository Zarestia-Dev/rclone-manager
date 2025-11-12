pub mod app;
pub mod io;
pub mod json_helpers;
pub mod logging;
pub mod process;
pub mod rclone;
pub mod types;
// Shortcuts not working on linux wayland, so moved to frontend
// Check this issue for more details:
// https://github.com/tauri-apps/global-hotkey/issues/28
pub mod shortcuts;
