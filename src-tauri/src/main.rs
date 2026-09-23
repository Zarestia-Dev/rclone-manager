#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
fn main() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("rcman-worker")
        .build()
        .expect("Failed to initialize Tokio runtime");

    rclone_manager_lib::utils::init_runtime_handle(runtime.handle().clone());
    let _guard = runtime.enter();

    tauri::async_runtime::set(runtime.handle().clone());

    rclone_manager_lib::run();
}
