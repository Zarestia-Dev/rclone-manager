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

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActiveOperationsSummary {
    pub has_active_operations: bool,
    pub active_jobs_count: usize,
    pub active_mounts_count: usize,
    pub active_serves_count: usize,
}

static PENDING_APP_EXIT_SUMMARY: once_cell::sync::Lazy<
    parking_lot::Mutex<Option<ActiveOperationsSummary>>,
> = once_cell::sync::Lazy::new(|| parking_lot::Mutex::new(None));

pub fn set_pending_app_exit_summary(summary: ActiveOperationsSummary) {
    *PENDING_APP_EXIT_SUMMARY.lock() = Some(summary);
}

#[bridge]
#[must_use]
pub fn check_pending_app_exit() -> Option<ActiveOperationsSummary> {
    PENDING_APP_EXIT_SUMMARY.lock().take()
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
    #[cfg(all(
        desktop,
        not(feature = "web-server"),
        not(any(target_os = "android", target_os = "ios"))
    ))]
    use tauri::Manager;

    let summary = get_active_operations_summary(app.clone()).await?;

    if summary.has_active_operations {
        #[cfg(all(
            desktop,
            not(feature = "web-server"),
            not(any(target_os = "android", target_os = "ios"))
        ))]
        {
            if app.get_webview_window("main").is_none() {
                set_pending_app_exit_summary(summary.clone());
            }
            crate::utils::app::builder::present_main_window(&app);
            crate::core::bridge::emit(crate::utils::types::events::APP_EXIT_REQUESTED, summary);
        }
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
/// failures. Must run before any webview is created — these variables are read
/// by native libraries during initialization.
/// See https://v2.tauri.app/develop/debug/linux-graphics/.
///
/// # Session-aware logic
///
/// **X11**: Both `WEBKIT_DISABLE_DMABUF_RENDERER` and
/// `WEBKIT_DISABLE_COMPOSITING_MODE` are set to prevent blank windows and
/// "Error 71" protocol errors.
///
/// **Wayland + strict compositor (KWin/Plasma, Hyprland)**:
/// `WEBKIT_DISABLE_COMPOSITING_MODE` is set. These compositors strictly enforce
/// the explicit-sync protocol rule, and NVIDIA's `egl-wayland2` + GTK shared-memory
/// buffer path fails to set an acquire point, so the compositor drops the
/// connection (Error 71). Forcing software rendering sidesteps that path.
///
/// **Wayland + tolerant compositor (niri, etc.)**: No compositing quirk. Modern
/// drivers support DMABuf natively and these compositors accept the explicit-sync
/// path, so disabling compositing would only cause software-rendering lag.
///
/// **Wayland + NVIDIA < 515**: `WEBKIT_DISABLE_DMABUF_RENDERER` is additionally
/// set, as older drivers do not reliably support DMABuf on Wayland.
#[cfg(all(desktop, target_os = "linux", not(feature = "web-server")))]
// Sound: invoked from main() single-threaded, before the async runtime spawns threads.
#[allow(clippy::disallowed_methods)]
pub fn apply_linux_graphics_quirks() {
    if !nvidia_proprietary_driver_loaded() {
        return;
    }

    let wayland = is_wayland_session();

    // Sound: runs single-threaded in main before the runtime spawns any threads.
    unsafe {
        if wayland {
            // Strict compositors (KWin/Plasma, Hyprland) enforce the explicit-sync
            // protocol rule: NVIDIA's egl-wayland2 arms explicit sync on the EGL
            // surface, but GTK attaches a shared-memory buffer with no acquire
            // point, so the compositor drops the connection (Error 71). Forcing
            // software rendering sidesteps the EGL explicit-sync path entirely.
            if is_strict_wayland_compositor()
                && std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE").is_err()
            {
                std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
            }

            // Older drivers do not reliably support DMABuf on Wayland.
            let old_driver = nvidia_driver_version().map(|v| v < 515).unwrap_or(false);
            if old_driver && std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
                std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            }
        } else {
            // X11: disable both to prevent blank windows and Error 71 protocol errors.
            if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
                std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            }
            if std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE").is_err() {
                std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
            }
        }
    }
}

/// Returns true when the current session is running on Wayland.
///
/// Checks `XDG_SESSION_TYPE=wayland` (set by the login manager) and
/// `WAYLAND_DISPLAY` (set by the compositor). Either variable being present
/// indicates a Wayland session.
#[cfg(all(desktop, target_os = "linux", not(feature = "web-server")))]
fn is_wayland_session() -> bool {
    std::env::var("XDG_SESSION_TYPE").is_ok_and(|v| v.eq_ignore_ascii_case("wayland"))
        || std::env::var("WAYLAND_DISPLAY").is_ok()
}

/// Returns true when running on a Wayland compositor that strictly enforces the
/// explicit-sync protocol rule (KWin/Plasma, Hyprland).
///
/// These compositors reject surfaces that use explicit sync without setting an
/// acquire point. NVIDIA's `egl-wayland2` implementation arms explicit sync on
/// the EGL surface, but GTK then attaches a shared-memory buffer with no acquire
/// point, causing the compositor to drop the connection (Error 71).
///
/// Detection relies on `XDG_CURRENT_DESKTOP` and `XDG_SESSION_DESKTOP`, which the
/// desktop environment sets in the user session environment.
#[cfg(all(desktop, target_os = "linux", not(feature = "web-server")))]
fn is_strict_wayland_compositor() -> bool {
    ["XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP"]
        .iter()
        .filter_map(|key| std::env::var(key).ok())
        .any(|value| {
            value.split(':').any(|entry| {
                let entry = entry.trim().to_ascii_lowercase();
                entry == "kde" || entry == "plasma" || entry == "hyprland"
            })
        })
}

/// Returns the major version number of the loaded NVIDIA driver, parsed from
/// `/proc/driver/nvidia/version`.
///
/// Returns `None` if the version file is absent, unreadable, or unparseable.
///
/// # Example line format
/// ```text
/// NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  515.43.04  Release Build ...
/// ```
#[cfg(all(desktop, target_os = "linux", not(feature = "web-server")))]
fn nvidia_driver_version() -> Option<u32> {
    let content = std::fs::read_to_string("/proc/driver/nvidia/version").ok()?;
    // The version token looks like "515.43.04" — take the major part.
    content.split_whitespace().find_map(|token| {
        let major = token.split('.').next()?;
        major.parse::<u32>().ok().filter(|&v| v > 100)
    })
}

/// Returns true when the NVIDIA proprietary or open kernel module driver is
/// actively loaded in the running kernel.
///
/// Detection is based solely on `/proc/driver/nvidia/version`, which is created
/// by the NVIDIA kernel module (`nvidia.ko`) on load — both the proprietary driver
/// and NVIDIA's officially open-sourced kernel module create this file.
///
/// **Nouveau** (the community reverse-engineered driver) does **not** create this
/// file, so this function correctly returns `false` for Nouveau users, avoiding
/// unnecessary WebKit rendering quirks that would degrade performance.
#[cfg(all(desktop, target_os = "linux", not(feature = "web-server")))]
fn nvidia_proprietary_driver_loaded() -> bool {
    std::path::Path::new("/proc/driver/nvidia/version").exists()
}

#[cfg(all(test, desktop, target_os = "linux", not(feature = "web-server")))]
mod graphics_quirks_tests {
    use super::{is_strict_wayland_compositor, is_wayland_session};

    #[test]
    fn strict_compositor_detected_for_kde() {
        let prev_current = std::env::var("XDG_CURRENT_DESKTOP").ok();
        let prev_session = std::env::var("XDG_SESSION_DESKTOP").ok();
        unsafe { std::env::remove_var("XDG_CURRENT_DESKTOP") };
        unsafe { std::env::remove_var("XDG_SESSION_DESKTOP") };

        unsafe { std::env::set_var("XDG_CURRENT_DESKTOP", "KDE") };
        assert!(
            is_strict_wayland_compositor(),
            "KDE should be detected as a strict compositor"
        );

        unsafe { std::env::set_var("XDG_SESSION_DESKTOP", "plasma") };
        assert!(
            is_strict_wayland_compositor(),
            "plasma (via XDG_SESSION_DESKTOP) should be detected"
        );

        // Restore.
        match prev_current {
            Some(v) => unsafe { std::env::set_var("XDG_CURRENT_DESKTOP", v) },
            None => unsafe { std::env::remove_var("XDG_CURRENT_DESKTOP") },
        }
        match prev_session {
            Some(v) => unsafe { std::env::set_var("XDG_SESSION_DESKTOP", v) },
            None => unsafe { std::env::remove_var("XDG_SESSION_DESKTOP") },
        }
    }

    #[test]
    fn strict_compositor_detected_for_hyprland() {
        let prev_current = std::env::var("XDG_CURRENT_DESKTOP").ok();
        let prev_session = std::env::var("XDG_SESSION_DESKTOP").ok();
        unsafe { std::env::remove_var("XDG_CURRENT_DESKTOP") };
        unsafe { std::env::remove_var("XDG_SESSION_DESKTOP") };

        unsafe { std::env::set_var("XDG_CURRENT_DESKTOP", "Hyprland") };
        assert!(
            is_strict_wayland_compositor(),
            "Hyprland should be detected as a strict compositor"
        );

        // Restore.
        match prev_current {
            Some(v) => unsafe { std::env::set_var("XDG_CURRENT_DESKTOP", v) },
            None => unsafe { std::env::remove_var("XDG_CURRENT_DESKTOP") },
        }
        match prev_session {
            Some(v) => unsafe { std::env::set_var("XDG_SESSION_DESKTOP", v) },
            None => unsafe { std::env::remove_var("XDG_SESSION_DESKTOP") },
        }
    }

    #[test]
    fn tolerant_compositor_not_detected_as_strict() {
        let prev_current = std::env::var("XDG_CURRENT_DESKTOP").ok();
        let prev_session = std::env::var("XDG_SESSION_DESKTOP").ok();
        unsafe { std::env::remove_var("XDG_CURRENT_DESKTOP") };
        unsafe { std::env::remove_var("XDG_SESSION_DESKTOP") };

        unsafe { std::env::set_var("XDG_CURRENT_DESKTOP", "GNOME") };
        unsafe { std::env::set_var("XDG_SESSION_DESKTOP", "ubuntu") };
        assert!(
            !is_strict_wayland_compositor(),
            "GNOME/Ubuntu should not be detected as strict"
        );

        // Restore.
        match prev_current {
            Some(v) => unsafe { std::env::set_var("XDG_CURRENT_DESKTOP", v) },
            None => unsafe { std::env::remove_var("XDG_CURRENT_DESKTOP") },
        }
        match prev_session {
            Some(v) => unsafe { std::env::set_var("XDG_SESSION_DESKTOP", v) },
            None => unsafe { std::env::remove_var("XDG_SESSION_DESKTOP") },
        }
    }

    #[test]
    fn strict_compositor_handles_colon_separated_desktops() {
        let prev_current = std::env::var("XDG_CURRENT_DESKTOP").ok();
        unsafe { std::env::remove_var("XDG_SESSION_DESKTOP") };

        unsafe { std::env::set_var("XDG_CURRENT_DESKTOP", "GNOME:KDE") };
        assert!(
            is_strict_wayland_compositor(),
            "KDE in a colon-separated list should be detected"
        );

        // Restore.
        match prev_current {
            Some(v) => unsafe { std::env::set_var("XDG_CURRENT_DESKTOP", v) },
            None => unsafe { std::env::remove_var("XDG_CURRENT_DESKTOP") },
        }
        unsafe { std::env::remove_var("XDG_SESSION_DESKTOP") };
    }

    #[test]
    fn wayland_detected_via_xdg_session_type() {
        let prev_xdg = std::env::var("XDG_SESSION_TYPE").ok();
        // Remove WAYLAND_DISPLAY so only XDG_SESSION_TYPE is in effect.
        let prev_wd = std::env::var("WAYLAND_DISPLAY").ok();
        unsafe { std::env::remove_var("WAYLAND_DISPLAY") };

        unsafe { std::env::set_var("XDG_SESSION_TYPE", "wayland") };
        assert!(
            is_wayland_session(),
            "should detect wayland via XDG_SESSION_TYPE"
        );

        unsafe { std::env::set_var("XDG_SESSION_TYPE", "x11") };
        assert!(
            !is_wayland_session(),
            "x11 session should not be detected as wayland"
        );

        // Restore.
        match prev_xdg {
            Some(v) => unsafe { std::env::set_var("XDG_SESSION_TYPE", v) },
            None => unsafe { std::env::remove_var("XDG_SESSION_TYPE") },
        }
        match prev_wd {
            Some(v) => unsafe { std::env::set_var("WAYLAND_DISPLAY", v) },
            None => unsafe { std::env::remove_var("WAYLAND_DISPLAY") },
        }
    }

    #[test]
    fn wayland_detected_via_wayland_display() {
        let prev_wd = std::env::var("WAYLAND_DISPLAY").ok();
        let prev_xdg = std::env::var("XDG_SESSION_TYPE").ok();
        // Ensure XDG_SESSION_TYPE doesn't interfere.
        unsafe { std::env::remove_var("XDG_SESSION_TYPE") };

        unsafe { std::env::set_var("WAYLAND_DISPLAY", "wayland-0") };
        assert!(
            is_wayland_session(),
            "should detect wayland via WAYLAND_DISPLAY"
        );

        unsafe { std::env::remove_var("WAYLAND_DISPLAY") };
        assert!(!is_wayland_session(), "no Wayland vars → not wayland");

        // Restore.
        match prev_wd {
            Some(v) => unsafe { std::env::set_var("WAYLAND_DISPLAY", v) },
            None => unsafe { std::env::remove_var("WAYLAND_DISPLAY") },
        }
        match prev_xdg {
            Some(v) => unsafe { std::env::set_var("XDG_SESSION_TYPE", v) },
            None => unsafe { std::env::remove_var("XDG_SESSION_TYPE") },
        }
    }
}
