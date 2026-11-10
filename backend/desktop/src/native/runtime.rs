#[cfg(not(feature = "web-server"))]
use crate::context::BackendContext;
#[cfg(not(feature = "web-server"))]
use crate::utils::types::state::RcloneState;

/// XDG autostart entries launch right after `graphical-session.target`, which
/// can precede the compositor exposing its sockets (KDE Plasma session start
/// launches autostart units in the same second KWin picks its backend). GTK
/// initialization fails hard in that window (`tao` panics on `gtk::init`
/// failure), so wait for a display socket before building the Tauri app.
/// Bounded: at most ~60s, then proceed and let GTK report the real error.
#[cfg(all(desktop, target_os = "linux", not(feature = "web-server")))]
fn wait_for_display_ready() {
    if display_socket_ready() {
        return;
    }
    for _ in 0..120 {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if display_socket_ready() {
            return;
        }
    }
    log::warn!("No display socket appeared after 60s; starting anyway");
}

/// True when the session's Wayland socket or X display socket is reachable.
/// Honors explicit `GDK_BACKEND`/`WAYLAND_DISPLAY`/`DISPLAY` overrides the
/// same way GTK backend selection does.
#[cfg(all(desktop, target_os = "linux", not(feature = "web-server")))]
fn display_socket_ready() -> bool {
    display_socket_candidates(
        std::env::var("GDK_BACKEND").ok().as_deref(),
        std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
        std::env::var("DISPLAY").ok().as_deref(),
        std::env::var("XDG_RUNTIME_DIR").ok().as_deref(),
    )
    .iter()
    .any(|candidate| std::path::Path::new(candidate).exists())
}

/// Candidate socket paths for the configured display backend. Returns an
/// empty list when no backend can be resolved, so the caller starts anyway
/// instead of waiting out the full timeout on headless sessions.
#[cfg(all(desktop, target_os = "linux", not(feature = "web-server")))]
fn display_socket_candidates(
    gdk_backend: Option<&str>,
    wayland_display: Option<&str>,
    x_display: Option<&str>,
    runtime_dir: Option<&str>,
) -> Vec<std::path::PathBuf> {
    let backend = gdk_backend.and_then(|value| value.split(',').next());
    let prefer_wayland = match backend {
        Some(value) if value.eq_ignore_ascii_case("wayland") => true,
        Some(value) if value.eq_ignore_ascii_case("x11") => false,
        _ => wayland_display.is_some(),
    };
    if prefer_wayland {
        let display = wayland_display.unwrap_or("wayland-0");
        if display.starts_with('/') {
            return vec![std::path::PathBuf::from(display)];
        }
        return runtime_dir
            .map(|dir| std::path::PathBuf::from(dir).join(display))
            .into_iter()
            .collect();
    }
    let display = x_display.unwrap_or(":0");
    let number = display
        .trim_start_matches(':')
        .split('.')
        .next()
        .unwrap_or("0");
    vec![std::path::PathBuf::from(format!(
        "/tmp/.X11-unix/X{number}"
    ))]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(all(desktop, target_os = "linux", not(feature = "web-server")))]
    wait_for_display_ready();
    // WebKitGTK rendering workarounds (NVIDIA only) must be applied before any
    // webview is created; skipped in headless web-server and mobile builds.
    #[cfg(all(desktop, target_os = "linux", not(feature = "web-server")))]
    crate::desktop::graphics::apply_linux_graphics_quirks();
    let cli_args = match <crate::cli::CliArgs as clap::Parser>::try_parse() {
        Ok(args) => {
            if let Err(e) = args.validate() {
                eprintln!("Invalid CLI arguments: {e}");
                std::process::exit(1);
            }
            args
        }
        Err(e) => e.exit(),
    };

    let mut builder = super::plugins::register(tauri::Builder::default());

    #[cfg(not(feature = "web-server"))]
    {
        builder = crate::native::protocol::register_protocols(builder);
    }

    #[cfg(all(desktop, not(feature = "web-server")))]
    {
        builder = super::window::configure(builder);
    }

    builder = builder.setup(move |app| crate::app::setup_context(app.handle(), cli_args.clone()));

    #[cfg(all(desktop, feature = "tray"))]
    {
        builder = builder.on_menu_event(|app, event| {
            crate::desktop::tray::events::handle_tray_menu_event(app, &event)
        });
    }

    #[cfg(not(feature = "web-server"))]
    {
        builder = builder.invoke_handler(super::ipc::dispatch_invoke);
    }

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    #[cfg(feature = "web-server")]
    {
        log::info!("Tauri event loop starting (Web Server Mode)");
        app.run(|_app_handle, _event| {});
    }

    #[cfg(not(feature = "web-server"))]
    {
        app.run(|app_handle, event| {
            #[cfg(feature = "portable")]
            if matches!(&event, tauri::RunEvent::Ready) {
                let context =
                    tauri::Manager::state::<rclone_manager_core::context::AppHandle>(app_handle);
                if tauri::Manager::get_webview_window(app_handle, "main").is_some() {
                    crate::services::updates::health::require_frontend(context.inner());
                }
                crate::services::updates::health::host_ready(context.inner());
            }
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let state = app_handle.backend_state::<RcloneState>();
                if !state.is_shutting_down() {
                    api.prevent_exit();

                    #[cfg(target_os = "linux")]
                    {
                        std::thread::spawn(|| {
                            use sysinfo::{ProcessesToUpdate, System};

                            let mut system = System::new();
                            system.refresh_processes(ProcessesToUpdate::All, true);
                            let my_pid = std::process::id();

                            for process in system.processes().values() {
                                let name = process.name().to_string_lossy();
                                if (name.contains("WebKitNetwork") || name.contains("WebKitWeb"))
                                    && process.parent().map(sysinfo::Pid::as_u32) == Some(my_pid)
                                {
                                    let _ = process.kill();
                                }
                            }
                        });
                    }
                }
            }
        });
    }
}

#[cfg(all(test, desktop, target_os = "linux", not(feature = "web-server")))]
mod display_readiness_tests {
    use super::display_socket_candidates;
    use std::path::PathBuf;

    #[test]
    fn wayland_display_resolves_inside_runtime_dir() {
        assert_eq!(
            display_socket_candidates(None, Some("wayland-1"), None, Some("/run/user/1000")),
            vec![PathBuf::from("/run/user/1000/wayland-1")]
        );
    }

    #[test]
    fn absolute_wayland_display_is_used_verbatim() {
        assert_eq!(
            display_socket_candidates(None, Some("/tmp/custom-wl"), None, Some("/run/user/1000")),
            vec![PathBuf::from("/tmp/custom-wl")]
        );
    }

    #[test]
    fn explicit_gdk_backend_overrides_session_env() {
        assert_eq!(
            display_socket_candidates(
                Some("x11"),
                Some("wayland-1"),
                Some(":1"),
                Some("/run/user/1000")
            ),
            vec![PathBuf::from("/tmp/.X11-unix/X1")]
        );
        assert_eq!(
            display_socket_candidates(Some("wayland"), None, Some(":0"), Some("/run/user/1000")),
            vec![PathBuf::from("/run/user/1000/wayland-0")]
        );
    }

    #[test]
    fn x_display_number_parses_screen_suffix() {
        assert_eq!(
            display_socket_candidates(None, None, Some(":2.0"), None),
            vec![PathBuf::from("/tmp/.X11-unix/X2")]
        );
    }

    #[test]
    fn no_session_env_falls_back_to_x0_without_waiting() {
        assert_eq!(
            display_socket_candidates(None, None, None, None),
            vec![PathBuf::from("/tmp/.X11-unix/X0")]
        );
    }
}
