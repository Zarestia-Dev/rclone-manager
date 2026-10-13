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
// Sound: invoked from main() single-threaded, before the async runtime spawns threads.
#[allow(clippy::disallowed_methods)]
pub fn apply_linux_graphics_quirks() {
    if !nvidia_proprietary_driver_loaded() {
        return;
    }

    let wayland = is_wayland_session(
        std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
        std::env::var("WAYLAND_DISPLAY").is_ok(),
    );

    // Sound: runs single-threaded in main before the runtime spawns any threads.
    unsafe {
        if wayland {
            // Strict compositors (KWin/Plasma, Hyprland) enforce the explicit-sync
            // protocol rule: NVIDIA's egl-wayland2 arms explicit sync on the EGL
            // surface, but GTK attaches a shared-memory buffer with no acquire
            // point, so the compositor drops the connection (Error 71). Forcing
            // software rendering sidesteps the EGL explicit-sync path entirely.
            if ["XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP"]
                .iter()
                .filter_map(|key| std::env::var(key).ok())
                .any(|value| is_strict_wayland_compositor(&value))
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
fn is_wayland_session(session_type: Option<&str>, has_wayland_display: bool) -> bool {
    session_type.is_some_and(|v| v.eq_ignore_ascii_case("wayland")) || has_wayland_display
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
fn is_strict_wayland_compositor(value: &str) -> bool {
    value.split(':').any(|entry| {
        matches!(
            entry.trim().to_ascii_lowercase().as_str(),
            "kde" | "plasma" | "hyprland"
        )
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
fn nvidia_proprietary_driver_loaded() -> bool {
    std::path::Path::new("/proc/driver/nvidia/version").exists()
}

#[cfg(test)]
mod graphics_quirks_tests {
    use super::{is_strict_wayland_compositor, is_wayland_session};

    #[test]
    fn compositor_detection_handles_lists_case_and_empty_values() {
        for value in ["KDE", "plasma", "Hyprland", "GNOME:KDE", " gnome : PLASMA "] {
            assert!(is_strict_wayland_compositor(value), "{value}");
        }
        for value in ["", "GNOME", "ubuntu", "niri", "not-kde"] {
            assert!(!is_strict_wayland_compositor(value), "{value}");
        }
    }

    #[test]
    fn wayland_detection_accepts_either_environment_indicator() {
        assert!(is_wayland_session(Some("wayland"), false));
        assert!(is_wayland_session(Some("WAYLAND"), false));
        assert!(is_wayland_session(None, true));
        assert!(is_wayland_session(Some("x11"), true));
        assert!(!is_wayland_session(Some("x11"), false));
        assert!(!is_wayland_session(Some(""), false));
        assert!(!is_wayland_session(None, false));
    }
}
