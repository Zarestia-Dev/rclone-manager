#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
fn main() {
    rclone_manager_core::services::updates::binary::on_startup();
    rclone_manager_lib::prepare_environment();
    let runtime = rclone_manager_core::utils::init_runtime();
    let _guard = runtime.enter();

    tauri::async_runtime::set(runtime.handle().clone());

    rclone_manager_lib::run();
}
