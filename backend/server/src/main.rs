// Started from the Start menu or at login, so a release opens no console window.
#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]
fn main() {
    rclone_manager_core::services::updates::binary::on_startup();
    let runtime = rclone_manager_core::utils::init_runtime();
    let _guard = runtime.enter();
    rclone_manager_server::run();
}
