/// Applies the existing NVIDIA Wayland workarounds before WebKitGTK starts.
/// Explicit environment overrides (including "0") always take precedence.
///
/// X11 uses WebKitGTK defaults. Disabling compositing there can cause partial
/// repainting after the WebKitGTK 2.54 upgrade; see issue #316. NVIDIA module
/// presence alone does not identify the GPU actually rendering the webview.
/// Keep workarounds scoped to their affected paths rather than disabling both
/// DMABUF and compositing for every NVIDIA system.
/// See https://v2.tauri.app/develop/debug/linux-graphics/.
// Sound: invoked from main() single-threaded, before the async runtime spawns threads.
#[allow(clippy::disallowed_methods)]
pub fn apply_linux_graphics_quirks() {
    if !nvidia_proprietary_driver_loaded() {
        return;
    }

    let wayland = is_wayland_session(
        std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
        std::env::var("WAYLAND_DISPLAY").is_ok(),
        std::env::var("GDK_BACKEND").ok().as_deref(),
    );
    let strict_compositor = ["XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP"]
        .iter()
        .filter_map(|key| std::env::var(key).ok())
        .any(|value| is_strict_wayland_compositor(&value));

    for key in webkit_workarounds(wayland, strict_compositor, nvidia_driver_version()) {
        if std::env::var_os(key).is_none() {
            // SAFETY: runs single-threaded before GTK and the async runtime start.
            unsafe { std::env::set_var(key, "1") };
        }
    }
}

/// Selects overrides without mutating the environment, so the platform policy
/// can be regression-tested independently of the host GPU and display server.
fn webkit_workarounds(
    wayland: bool,
    strict_compositor: bool,
    driver_major: Option<u32>,
) -> &'static [&'static str] {
    if !wayland {
        return &[];
    }

    // Retain the existing Wayland behavior: compositing off for the explicit-sync
    // failure on KWin/Hyprland, DMABUF off only for drivers older than 515.
    match (strict_compositor, driver_major.is_some_and(|v| v < 515)) {
        (true, true) => &[
            "WEBKIT_DISABLE_COMPOSITING_MODE",
            "WEBKIT_DISABLE_DMABUF_RENDERER",
        ],
        (true, false) => &["WEBKIT_DISABLE_COMPOSITING_MODE"],
        (false, true) => &["WEBKIT_DISABLE_DMABUF_RENDERER"],
        (false, false) => &[],
    }
}

/// An explicit single GDK backend takes precedence over the login session.
/// In particular, GDK_BACKEND=x11 can select XWayland in a Wayland session.
/// Otherwise, respect XDG_SESSION_TYPE and use WAYLAND_DISPLAY only as fallback.
/// Backend preference lists cannot identify which backend GTK will select.
fn is_wayland_session(
    session_type: Option<&str>,
    has_wayland_display: bool,
    gdk_backend: Option<&str>,
) -> bool {
    match gdk_backend {
        Some("x11") => return false,
        Some("wayland") => return true,
        _ => {}
    }
    match session_type {
        Some(value) if value.eq_ignore_ascii_case("x11") => false,
        Some(value) if value.eq_ignore_ascii_case("wayland") => true,
        _ => has_wayland_display,
    }
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
    use super::{is_strict_wayland_compositor, is_wayland_session, webkit_workarounds};

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
    fn display_detection_respects_explicit_backend_and_session() {
        for (session, display, backend, expected) in [
            (Some("wayland"), false, None, true),
            (Some("WAYLAND"), false, None, true),
            (None, true, None, true),
            (Some("x11"), true, None, false),
            (Some("X11"), false, None, false),
            (Some(""), false, None, false),
            (None, false, None, false),
            (Some("wayland"), true, Some("x11"), false),
            (Some("x11"), false, Some("wayland"), true),
            (Some("wayland"), true, Some("x11,wayland"), true),
            (Some("x11"), false, Some(""), false),
        ] {
            assert_eq!(
                is_wayland_session(session, display, backend),
                expected,
                "session={session:?}, display={display}, backend={backend:?}"
            );
        }
    }

    #[test]
    fn x11_never_forces_a_renderer_even_with_old_nvidia_and_kde() {
        for strict in [false, true] {
            for driver in [None, Some(470), Some(514), Some(515), Some(580)] {
                assert!(webkit_workarounds(false, strict, driver).is_empty());
            }
        }
    }

    #[test]
    fn wayland_retains_existing_workarounds_and_driver_boundary() {
        for driver in [None, Some(515), Some(580)] {
            assert!(webkit_workarounds(true, false, driver).is_empty());
            assert_eq!(
                webkit_workarounds(true, true, driver),
                &["WEBKIT_DISABLE_COMPOSITING_MODE"]
            );
        }
        for driver in [Some(470), Some(514)] {
            assert_eq!(
                webkit_workarounds(true, false, driver),
                &["WEBKIT_DISABLE_DMABUF_RENDERER"]
            );
            assert_eq!(
                webkit_workarounds(true, true, driver),
                &[
                    "WEBKIT_DISABLE_COMPOSITING_MODE",
                    "WEBKIT_DISABLE_DMABUF_RENDERER"
                ]
            );
        }
    }
}
