fn main() {
    let runtime = rclone_manager_core::utils::init_runtime();
    let _guard = runtime.enter();
    rclone_manager_server::run();
}
