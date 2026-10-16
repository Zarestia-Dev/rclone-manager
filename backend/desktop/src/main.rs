#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
fn main() {
    #[cfg(feature = "portable")]
    if rclone_manager_core::services::updates::binary::run_helper_if_requested("portable") {
        return;
    }
    let runtime = rclone_manager_core::utils::init_runtime();
    let _guard = runtime.enter();

    tauri::async_runtime::set(runtime.handle().clone());

    rclone_manager_lib::run();
}
