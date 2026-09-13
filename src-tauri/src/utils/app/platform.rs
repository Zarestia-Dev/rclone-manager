use crate::core::bridge;

pub const APP_ID: &str = "io.github.zarestia_dev.rclone-manager";
pub const APP_ID_DEV: &str = "io.github.zarestia_dev.rclone-manager-dev";

#[bridge]
#[must_use]
pub fn get_build_type() -> Option<&'static str> {
    if cfg!(feature = "flatpak") {
        Some("flatpak")
    } else if cfg!(feature = "container") {
        Some("container")
    } else if cfg!(feature = "portable") {
        Some("portable")
    } else {
        None
    }
}

#[bridge]
#[must_use]
pub fn is_librclone() -> bool {
    cfg!(feature = "librclone")
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ActiveOperationsSummary {
    pub has_active_operations: bool,
    pub active_jobs_count: usize,
    pub active_mounts_count: usize,
    pub active_serves_count: usize,
}

pub async fn get_active_operations_summary(
    app: tauri::AppHandle,
) -> Result<ActiveOperationsSummary, String> {
    use tauri::Manager;
    let backend_manager = app.state::<crate::rclone::backend::BackendManager>();

    let active_jobs = backend_manager.job_cache.get_active_jobs().await;
    let active_mounts = backend_manager.remote_cache.get_mounted_remotes().await;
    let active_serves = backend_manager.remote_cache.get_serves().await;

    let active_jobs_count = active_jobs.len();
    let active_mounts_count = active_mounts.len();
    let active_serves_count = active_serves.len();

    let has_active_operations =
        active_jobs_count > 0 || active_mounts_count > 0 || active_serves_count > 0;

    Ok(ActiveOperationsSummary {
        has_active_operations,
        active_jobs_count,
        active_mounts_count,
        active_serves_count,
    })
}

#[bridge]
pub async fn request_app_exit(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
    use tauri::{Emitter, Manager};

    let summary = get_active_operations_summary(app.clone()).await?;

    if summary.has_active_operations {
        #[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        #[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
        let _ = app.emit(crate::utils::types::events::APP_EXIT_REQUESTED, summary);
    } else {
        crate::core::lifecycle::shutdown::handle_shutdown(app.clone()).await;
        app.exit(0);
    }

    Ok(())
}

#[bridge]
pub async fn relaunch_app(app: tauri::AppHandle) -> Result<(), String> {
    use crate::core::lifecycle::shutdown::handle_shutdown;
    handle_shutdown(app.clone()).await;
    app.restart();
}

#[cfg(all(target_os = "linux", feature = "flatpak"))]
pub async fn manage_flatpak_background_portal(enable: bool) -> Result<(), String> {
    use std::collections::HashMap;
    use zbus::zvariant::Value;
    use zbus::{Connection, Proxy};

    // Attempt to connect to the session DBus
    let connection = match Connection::session().await {
        Ok(c) => c,
        Err(e) => {
            log::error!("Failed to connect to session bus: {e}");
            return Err(e.to_string());
        }
    };

    // Create a proxy to the Desktop portal Background interface
    let proxy = match Proxy::new(
        &connection,
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.Background",
    )
    .await
    {
        Ok(p) => p,
        Err(e) => {
            log::error!("Failed to create Background portal proxy: {e}");
            return Err(e.to_string());
        }
    };

    // Prepare the options dictionary (a{sv})
    let mut options: HashMap<&str, Value> = HashMap::new();
    options.insert(
        "reason",
        Value::from("RClone Manager needs to run in the background to handle scheduled jobs and serve remotes."),
    );
    options.insert("autostart", Value::from(enable));
    options.insert("dbus-activatable", Value::from(false));

    let autostart_cmd: zbus::zvariant::Array = {
        use zbus::zvariant::{Array, Signature};
        let sig = Signature::try_from("s").expect("valid sig");
        let mut arr = Array::new(&sig);
        for token in &[env!("CARGO_PKG_NAME"), "--tray"] {
            arr.append(Value::from(*token))
                .expect("homogeneous string array");
        }
        arr
    };
    options.insert("commandline", Value::from(autostart_cmd));

    // Call RequestBackground(parent_window: String, options: a{sv}) -> (ObjectPath)
    // We pass an empty string for parent_window since we don't track the X11/Wayland window ID here.
    match proxy
        .call::<_, _, zbus::zvariant::OwnedObjectPath>("RequestBackground", &("", &options))
        .await
    {
        Ok(path) => {
            log::debug!(
                "Background portal request sent successfully. Request path: {}",
                path.as_str()
            );
            Ok(())
        }
        Err(e) => {
            log::error!("Background portal request failed: {e}");
            Err(e.to_string())
        }
    }
}

// // This one uses ashpd, same as the one above but I left it here as a comment. Maybe it will be useful for someone later.
// #[cfg(feature = "flatpak")]
// pub async fn manage_flatpak_background_portal(enable: bool) -> Result<(), String> {
//     use ashpd::desktop::background::Background;

//     let bin_name = env!("CARGO_PKG_NAME");
//     let commandline = [bin_name, "--tray"];

//     match Background::request()
//         .reason("RClone Manager needs to run in the background to handle scheduled jobs and serve remotes.")
//         .auto_start(enable)
//         .command(&commandline)
//         .dbus_activatable(false)
//         .send()
//         .await
//     {
//         Ok(request) => match request.response() {
//             Ok(_) => {
//                 log::debug!("Background portal request successful (autostart={})", enable);
//                 Ok(())
//             }
//             Err(e) => {
//                 log::error!("Background portal request denied: {e}");
//                 Err(format!("Background portal request denied: {e}"))
//             }
//         }
//         Err(e) => {
//             log::error!("Could not communicate with Background portal: {e}");
//             Err(format!("Could not communicate with Background portal: {e}"))
//         }
//     }
// }

#[cfg(target_os = "macos")]
pub fn update_macos_dock_visibility(app_handle: &tauri::AppHandle) {
    use tauri::Manager;
    let has_visible_windows = app_handle
        .webview_windows()
        .values()
        .any(|w| w.is_visible().unwrap_or(false));

    let policy = if has_visible_windows {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    };

    let _ = app_handle.set_activation_policy(policy);
}

#[bridge]
#[must_use]
pub fn is_updater_enabled() -> bool {
    cfg!(feature = "updater")
}

/// Applies WebKitGTK environment workarounds for known Linux NVIDIA rendering
/// failures (blank windows on X11, "Error 71" protocol errors on strict Wayland
/// compositors). See https://v2.tauri.app/develop/debug/linux-graphics/. Must run
/// before any webview is created: these variables are read by native libraries
/// during initialization. Only NVIDIA GPUs are affected; Mesa (Intel/AMD) users
/// keep the default rendering path untouched, and `GDK_BACKEND` is left alone so
/// sessions stay on their native backend.
#[cfg(all(desktop, target_os = "linux", not(feature = "web-server")))]
// Sound: invoked from main() single-threaded, before the async runtime spawns threads.
#[allow(clippy::disallowed_methods)]
pub fn apply_linux_graphics_quirks() {
    if !nvidia_gpu_present() {
        return;
    }

    // Sound: runs single-threaded in main before the runtime spawns any threads.
    unsafe {
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
        if std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE").is_err() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
    }
}

/// Returns true when an NVIDIA GPU is present (driver loaded or PCI vendor 0x10de).
#[cfg(all(desktop, target_os = "linux", not(feature = "web-server")))]
fn nvidia_gpu_present() -> bool {
    // NVIDIA driver loaded (proprietary or open kernel module).
    if std::path::Path::new("/proc/driver/nvidia/version").exists() {
        return true;
    }

    nvidia_vendor_in_drm_root(std::path::Path::new("/sys/class/drm"))
}

/// Returns true when any DRM card under `drm_root` has PCI vendor 0x10de (NVIDIA).
#[cfg(all(desktop, target_os = "linux", not(feature = "web-server")))]
fn nvidia_vendor_in_drm_root(drm_root: &std::path::Path) -> bool {
    let Ok(cards) = std::fs::read_dir(drm_root) else {
        return false;
    };

    cards.flatten().any(|entry| {
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            return false;
        };
        if !name.starts_with("card") || !name[4..].chars().all(|c| c.is_ascii_digit()) {
            return false;
        }

        std::fs::read_to_string(drm_root.join(name).join("device/vendor"))
            .is_ok_and(|vendor| vendor.trim() == "0x10de")
    })
}

#[cfg(all(test, desktop, target_os = "linux", not(feature = "web-server")))]
mod graphics_quirks_tests {
    use super::nvidia_vendor_in_drm_root;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rclone-manager-nvidia-test-{}-{}",
            name,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Creates a fake DRM card with the given PCI vendor ID (e.g. "0x10de").
    fn write_fake_card(drm_root: &std::path::Path, name: &str, vendor: &str) {
        let device_path = drm_root.join(name).join("device");
        std::fs::create_dir_all(&device_path).unwrap();
        std::fs::write(device_path.join("vendor"), vendor).unwrap();
    }

    #[test]
    fn nvidia_card_detected_by_vendor() {
        let dir = temp_dir("nvidia");
        write_fake_card(&dir, "card0", "0x10de");
        assert!(nvidia_vendor_in_drm_root(&dir));
    }

    #[test]
    fn non_nvidia_cards_ignored() {
        let dir = temp_dir("other_vendors");
        write_fake_card(&dir, "card0", "0x8086"); // Intel
        write_fake_card(&dir, "card1", "0x1002"); // AMD
        assert!(!nvidia_vendor_in_drm_root(&dir));
    }

    #[test]
    fn nvidia_detected_among_other_cards() {
        let dir = temp_dir("mixed");
        write_fake_card(&dir, "card0", "0x8086"); // Intel iGPU
        write_fake_card(&dir, "card1", "0x10de"); // NVIDIA dGPU
        assert!(nvidia_vendor_in_drm_root(&dir));
    }

    #[test]
    fn non_card_entries_ignored() {
        let dir = temp_dir("non_cards");
        write_fake_card(&dir, "card0", "0x8086");
        std::fs::write(dir.join("card0-video-D0"), "noise").unwrap();
        assert!(!nvidia_vendor_in_drm_root(&dir));
    }

    #[test]
    fn empty_or_missing_dir_is_false() {
        let dir = temp_dir("empty");
        assert!(!nvidia_vendor_in_drm_root(&dir));
        assert!(!nvidia_vendor_in_drm_root(std::path::Path::new(
            "/nonexistent/drm/root"
        )));
    }
}
