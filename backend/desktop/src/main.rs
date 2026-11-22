#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
fn main() {
    #[cfg(feature = "portable")]
    rclone_manager_core::services::updates::binary::run_helper_if_requested(
        rclone_manager_core::services::updates::ArtifactKind::Portable,
    );
    // The same condition as the update policy: a build bundled as an AppImage,
    // started by the AppImage runtime.
    #[cfg(all(feature = "updater", not(feature = "portable"), target_os = "linux"))]
    if std::env::var_os("APPIMAGE").is_some()
        && matches!(
            tauri::utils::platform::bundle_type(),
            Some(tauri::utils::config::BundleType::AppImage)
        )
    {
        rclone_manager_core::services::updates::binary::run_helper_if_requested(
            rclone_manager_core::services::updates::ArtifactKind::Appimage,
        );
    }
    rclone_manager_lib::prepare_environment();
    let runtime = rclone_manager_core::utils::init_runtime();
    let _guard = runtime.enter();

    tauri::async_runtime::set(runtime.handle().clone());

    rclone_manager_lib::run();
}
