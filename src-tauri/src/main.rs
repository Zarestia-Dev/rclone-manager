#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
fn main() {
    rclone_manager_lib::run();
}
// Test comment
