pub mod builder;
pub mod file_helper;
pub mod log;
pub mod network;
pub mod notification;
pub mod process;
pub mod rclone;
pub mod types;
// Shortcuts not working on linux wayland, so moved to frontend
// Check this issue for more details:
// https://github.com/tauri-apps/global-hotkey/issues/28
// pub mod shortcuts;