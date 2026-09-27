//! Native plugin registration.
#[cfg(feature = "tauri-plugin-single-instance")]
use super::send_to::build_send_to_params;
#[cfg(feature = "tauri-plugin-single-instance")]
use crate::rclone::commands::upload::execute_upload_batch;

pub(super) fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    #[cfg(feature = "tauri-plugin-single-instance")]
    let builder = register_single_instance(builder);

    #[cfg(feature = "updater")]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(all(feature = "tauri-plugin-deep-link", not(feature = "web-server")))]
    let builder = builder.plugin(tauri_plugin_deep_link::init());

    #[cfg(all(feature = "tauri-plugin-autostart", not(feature = "flatpak")))]
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
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());

    builder
}

#[cfg(feature = "tauri-plugin-single-instance")]
fn register_single_instance(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    let si_builder = tauri_plugin_single_instance::Builder::new();

    #[cfg(target_os = "linux")]
    let si_builder = si_builder.dbus_id(if cfg!(debug_assertions) {
        crate::utils::app::platform::APP_ID_DEV
    } else {
        crate::utils::app::platform::APP_ID
    });

    builder.plugin(
        si_builder
            .callback(|app: &crate::utils::context::AppHandle, argv, cwd| {
                if let Ok(cli_args) = <crate::core::cli::CliArgs as clap::Parser>::try_parse_from(&argv) && let Some(remote) = cli_args.general.send_to_remote {
                        let path = cli_args.general.send_to_path;
                        let sources = cli_args.general.send_to_sources;
                        let app_handle_clone = app.clone();
                        let cwd_path = std::path::PathBuf::from(cwd);
                        crate::utils::spawn(async move {
                            let params = build_send_to_params(remote, path, sources, Some(&cwd_path));

                            log::info!(
                                "Executing SendTo transfer in running instance: {:?} -> {}:{}",
                                params.local_paths, params.remote, params.path
                            );
                            match execute_upload_batch(app_handle_clone, params).await {
                                Ok(jobid) => {
                                    log::info!("SendTo transfer initiated successfully in running instance. Job ID: {jobid}");
                                }
                                Err(e) => {
                                    log::error!("SendTo transfer failed in running instance: {e}");
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
                            crate::utils::app::builder::present_main_window(&app_for_main);
                        });
                    });
                }
            })
            .build(),
    )
}
