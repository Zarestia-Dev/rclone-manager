//! Locate bundled or deployed frontend assets.
use log::info;
use rclone_manager_core::context::AppHandle;

pub(super) fn find_static_dir(app_handle: &AppHandle) -> Option<std::path::PathBuf> {
    let path = app_handle
        .state::<crate::services::paths::AppPaths>()
        .resource_dir
        .join("browser");

    if path.exists() {
        return Some(path);
    }

    let candidates = [
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../dist/rclone-manager/browser"),
        std::path::PathBuf::from("/usr/lib/rclone-manager-headless/browser"),
        std::path::PathBuf::from("dist/rclone-manager/browser"),
    ];

    for path in &candidates {
        if path.exists() {
            info!("📁 Static files: {}", path.display());
            return Some(path.clone());
        }
    }

    std::env::current_exe()
        .ok()
        .and_then(|exe| {
            exe.parent()
                .map(|p| p.join("../../../dist/rclone-manager/browser"))
        })
        .filter(|p| p.exists())
        .inspect(|p| info!("📁 Static files: {}", p.display()))
}
