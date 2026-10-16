fn main() {
    if rclone_manager_core::services::updates::binary::run_helper_if_requested("server") {
        return;
    }
    let runtime = rclone_manager_core::utils::init_runtime();
    let _guard = runtime.enter();
    rclone_manager_server::run();
}
