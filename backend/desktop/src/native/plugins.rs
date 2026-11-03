//! Native plugin registration.
#[cfg(feature = "tauri-plugin-single-instance")]
use crate::context::BackendContext;
#[cfg(feature = "tauri-plugin-single-instance")]
use rclone_manager_core::app::send_to;

pub(super) fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    #[cfg(feature = "tauri-plugin-single-instance")]
    let builder = register_single_instance(builder);

    #[cfg(feature = "updater")]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(all(feature = "tauri-plugin-deep-link", not(feature = "web-server")))]
    let builder = builder.plugin(tauri_plugin_deep_link::init());

    #[cfg(autostart_plugin)]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        Some(vec!["--tray"]),
    ));

    #[cfg(feature = "tauri-plugin-notification")]
    let builder = builder.plugin(tauri_plugin_notification::init());

    #[cfg(feature = "tauri-plugin-opener")]
    let builder = builder.plugin(tauri_plugin_opener::init());

    #[cfg(not(feature = "web-server"))]
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_clipboard_manager::init());

    #[cfg(all(feature = "tauri-plugin-window-state", not(feature = "web-server")))]
    let builder = builder.plugin(
        tauri_plugin_window_state::Builder::default()
            .with_filter(remembers_window_state)
            .build(),
    );

    builder
}

#[cfg(feature = "tauri-plugin-single-instance")]
fn register_single_instance(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    let si_builder = tauri_plugin_single_instance::Builder::new();

    #[cfg(target_os = "linux")]
    let si_builder = si_builder.dbus_id(if cfg!(debug_assertions) {
        crate::app::APP_ID_DEV
    } else {
        crate::app::APP_ID
    });

    builder.plugin(
        si_builder
            .callback(|app: &crate::context::AppHandle, argv, cwd| {
                if let Ok(cli_args) = <crate::cli::CliArgs as clap::Parser>::try_parse_from(&argv)
                    && let Some(remote) = cli_args.general.send_to_remote
                {
                    let core = app.backend().clone();
                    let (path, sources) = (
                        cli_args.general.send_to_path,
                        cli_args.general.send_to_sources,
                    );
                    let cwd = std::path::PathBuf::from(cwd);
                    crate::utils::spawn(async move {
                        match send_to::execute(&core, remote, path, sources, Some(&cwd)).await {
                            Ok(jobid) => log::info!("SendTo transfer finished. Job ID: {jobid}"),
                            Err(e) => {
                                log::error!("SendTo transfer failed in running instance: {e}")
                            }
                        }
                    });
                    return;
                }

                #[cfg(all(feature = "web-server", feature = "tray"))]
                log::info!("Another instance attempted to run with args: {argv:?}");

                #[cfg(not(feature = "web-server"))]
                {
                    let app_clone = app.clone();
                    crate::utils::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

                        let app_for_main = app_clone.clone();
                        let _ = app_clone.run_on_main_thread(move || {
                            log::info!("Second instance detected, presenting main window");
                            crate::desktop::window::present_main_window(&app_for_main);
                        });
                    });
                }
            })
            .build(),
    )
}

/// Only long-lived windows keep their position and size. File-browser windows get a new
/// random label every time (so remembering them would grow the state file forever), and
/// dialogs are sized by their content.
#[cfg(all(feature = "tauri-plugin-window-state", not(feature = "web-server")))]
fn remembers_window_state(label: &str) -> bool {
    !label.starts_with("nautilus-") && !label.starts_with("dialog-")
}

#[cfg(test)]
mod tests {
    #[cfg(all(feature = "tauri-plugin-window-state", not(feature = "web-server")))]
    #[test]
    fn only_long_lived_windows_remember_their_state() {
        for label in ["main", "main-standalone", "flow", "nautilus"] {
            assert!(super::remembers_window_state(label), "{label}");
        }
        for label in [
            "nautilus-lx3k9a-001-ab12",
            "nautilus-gdrive",
            "dialog-settings",
        ] {
            assert!(!super::remembers_window_state(label), "{label}");
        }
    }
}
