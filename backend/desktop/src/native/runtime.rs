#[cfg(not(feature = "web-server"))]
use crate::context::BackendContext;
#[cfg(not(feature = "web-server"))]
use crate::utils::types::state::RcloneState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
