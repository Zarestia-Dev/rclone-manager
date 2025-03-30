use core::{
    settings::{
        delete_remote_settings, get_remote_settings, load_settings, save_remote_settings,
        save_settings, SettingsState,
    },
    settings_store::AppSettings,
    tray::{
        actions::{
            handle_browse_remote, handle_delete_remote, handle_mount_remote, handle_unmount_remote,
            show_main_window,
        },
        tray::{setup_tray, update_tray_menu},
    },
};
use log::{debug, error, info};
use rclone::api::{
    create_remote, delete_remote, ensure_rc_api_running, get_all_remote_configs, get_copy_flags,
    get_disk_usage, get_filter_flags, get_global_flags, get_mount_flags, get_mounted_remotes,
    get_oauth_supported_remotes, get_remote_config, get_remote_config_fields, get_remote_types,
    get_remotes, get_sync_flags, get_vfs_flags, list_mounts, mount_remote, quit_rclone_oauth,
    unmount_remote, update_remote, RcloneState,
};
use reqwest::Client;
use serde_json::json;
use std::{
    process::Command,
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager, Theme, WindowEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_http::reqwest;
use tauri_plugin_store::StoreBuilder;
use utils::{
    check_rclone::{check_rclone_installed, provision_rclone},
    file_helper::{get_folder_location, open_in_files},
    startup::handle_startup,
};

mod core;
mod rclone;
mod utils;

#[tauri::command]
fn set_theme(theme: String, window: tauri::Window) {
    let theme = match theme.as_str() {
        "dark" => Theme::Dark,
        _ => Theme::Light,
    };
    window.set_theme(Some(theme)).expect("Failed to set theme");
}

use std::sync::Once;
static INIT_LOGGER: Once = Once::new();

fn init_logging(enable_debug: bool) {
    INIT_LOGGER.call_once(|| {
        let mut builder = env_logger::Builder::new();
        if enable_debug {
            builder.filter_level(log::LevelFilter::Debug);
        }
        builder.init();
    });
}

fn lower_webview_priority() {
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("cmd")
            .args(&[
                "/C",
                "wmic process where name='WebView2.exe' CALL setpriority 64",
            ])
            .output();
    }

    #[cfg(target_os = "linux")]
    {
        let _ = Command::new("renice")
            .args(&["-n", "19", "-p", &std::process::id().to_string()])
            .output();

        info!("Lowered WebView2 process priority");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--tray"]),
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        // .on_window_event(|window, event| match event {
        //     tauri::WindowEvent::CloseRequested { api, .. } => {
        //         api.prevent_close();
        //         if let Some(win) = window.app_handle().get_webview_window("main") {
        //             let _ = win.hide();
        //         }
        //     }
        //     _ => {}
        // }) // ✅ Prevent window close and hide instead
        // .on_window_event(|window, event| match event {
        //     WindowEvent::CloseRequested { api, .. } => {
        //         api.prevent_close();
        //         api.prevent_close();
        //         if let Some(win) = window.app_handle().get_webview_window("main") {
        //             let _ = win.hide();
        //             let _ = win.eval("document.body.innerHTML = '';"); // ✅ Clear UI content to free memory
        //         }
        //     }
        //     WindowEvent::Focused(false) => {
        //         if let Some(win) = window.app_handle().get_webview_window("main") {
        //             let _ = win.eval("document.body.innerHTML = '';"); // ✅ Clear UI when unfocused
        //         }
        //     }
        //     WindowEvent::Focused(true) => {
        //         if let Some(win) = window.app_handle().get_webview_window("main") {
        //             let _ = win.eval("location.reload();"); // ✅ Reload UI when refocused
        //         }
        //     }
        //     _ => {}
        // }) // ✅ Clear UI content when window is hidden
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if let Some(win) = window.app_handle().get_webview_window("main") {
                    let _ = win.hide();
                    lower_webview_priority(); // ✅ Reduce WebView CPU usage
                }
            }
            WindowEvent::Focused(true) => {
                if let Some(win) = window.app_handle().get_webview_window("main") {
                    let _ = win.show();
                }
            }
            _ => {}
        }) // ✅ Hide window on close and show on focus
        .manage(RcloneState {
            client: Client::new(),
        })
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_handle = app.handle();

            // ✅ Read command-line arguments
            let args: Vec<String> = std::env::args().collect();
            let start_with_tray = args.contains(&"--tray".to_string());

            // ✅ Get app's data directory
            let config_dir = app_handle
                .path()
                .app_data_dir()
                .expect("Failed to get app data directory");

            if config_dir.exists() && !config_dir.is_dir() {
                std::fs::remove_file(&config_dir)
                    .expect("Failed to remove file blocking directory creation");
            }
            std::fs::create_dir_all(&config_dir).expect("Failed to create config directory");

            // ✅ Define the path for settings.json
            let store_path = config_dir.join("settings.json");

            debug!("Store path: {:?}", store_path);

            // ✅ Create settings store
            let store = Arc::new(Mutex::new(
                StoreBuilder::new(app_handle, store_path)
                    .build()
                    .expect("Failed to create settings store"),
            ));

            // ✅ Create broadcast channel for settings updates
            let (update_sender, mut update_receiver) = tokio::sync::broadcast::channel::<()>(1);

            // ✅ Register `SettingsState`
            app.manage(SettingsState {
                store: store.clone(),
                config_dir: config_dir.clone(),
                update_sender,
            });

            // ✅ Load settings
            let settings_json = tauri::async_runtime::block_on(load_settings(
                app.state::<SettingsState<tauri::Wry>>(),
            ))
            .unwrap_or_else(|err| {
                error!("Failed to load settings: {}", err);
                json!({ "settings": AppSettings::default() })
            });

            let settings: AppSettings = serde_json::from_value(settings_json["settings"].clone())
                .unwrap_or_else(|_| {
                    error!("Failed to parse settings, using default");
                    AppSettings::default()
                });

            info!("Settings loaded: {:?}", settings);

            // ✅ Initialize logging
            init_logging(settings.experimental.debug_logging);
            info!("Logging initialized");
            debug!("Debug logging enabled");

            let rc_process = Arc::new(Mutex::new(None));
            ensure_rc_api_running(rc_process.clone(), settings.core.rclone_api_port);

            let app_handle_clone = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                handle_startup(&app_handle_clone).await;
            });


            // ✅ Handle `--tray` argument OR `start_on_startup` setting
            if settings.general.start_on_startup {
                // Get the autostart manager
                let autostart_manager = app.autolaunch();
                // Enable autostart
                let _ = autostart_manager.enable();

                // Check enable state
                debug!(
                    "registered for autostart? {}",
                    autostart_manager.is_enabled().unwrap()
                );
            } else if !settings.general.start_on_startup {
                // Get the autostart manager
                let autostart_manager = app.autolaunch();
                // Disable autostart
                let _ = autostart_manager.disable();

                // Check enable state
                debug!(
                    "registered for autostart? {}",
                    autostart_manager.is_enabled().unwrap()
                );
            }

            // ✅ Handle tray_enabled
            if settings.general.tray_enabled {
                debug!("Tray is enabled");
                if let Err(e) = tauri::async_runtime::block_on(setup_tray(
                    &app_handle,
                    settings.core.max_tray_items,
                )) {
                    error!("Failed to setup tray: {}", e);
                }
            } else {
                debug!("Tray is disabled");
            }

            // ✅ Background task to listen for settings changes
            let app_handle_clone = app_handle.clone();
            let rc_process_clone = rc_process.clone();

            tauri::async_runtime::spawn(async move {
                while update_receiver.recv().await.is_ok() {
                    debug!("🔄 Detected settings change, applying updates...");

                    let settings_json =
                        load_settings(app_handle_clone.state::<SettingsState<tauri::Wry>>())
                            .await
                            .unwrap_or_else(|_| json!({ "settings": AppSettings::default() }));

                    let settings: AppSettings =
                        serde_json::from_value(settings_json["settings"].clone())
                            .unwrap_or_else(|_| AppSettings::default());

                    // ✅ Update logging dynamically
                    init_logging(settings.experimental.debug_logging);
                    debug!("Updated debug logging");

                    // ✅ Restart Rclone API if port changed
                    // ensure_rc_api_running(rc_process_clone.clone(), settings.core.rclone_api_port);
                    // debug!("Updated Rclone API Port");

                    // ✅ Handle window visibility
                    // if settings.general.start_on_startup {
                    //     if let Some(win) = app_handle_clone.get_webview_window("main") {
                    //         let _ = win.hide();
                    //     }
                    // } else {
                    //     if let Some(win) = app_handle_clone.get_webview_window("main") {
                    //         let _ = win.show();
                    //     }
                    // }


                    // ✅ Handle autostart
                    let autostart_manager = app_handle_clone.autolaunch();
                    if settings.general.start_on_startup {
                        let _ = autostart_manager.enable();
                    } else {
                        let _ = autostart_manager.disable();
                    }
                    debug!(
                        "Autostart enabled: {}",
                        autostart_manager.is_enabled().unwrap()
                    );

                    // ✅ Handle tray visibility
                    if settings.general.tray_enabled {
                        if let Some(tray) = app_handle_clone.tray_by_id("main") {
                            if let Err(e) = tray.set_visible(true) {
                                error!("Failed to set tray visibility: {}", e);
                            }
                        } else {
                            let _ =
                                setup_tray(&app_handle_clone, settings.core.max_tray_items).await;
                            debug!("Tray setup successfully");
                        }
                    } else {
                        if let Some(tray) = app_handle_clone.tray_by_id("main") {
                            if let Err(e) = tray.set_visible(false) {
                                error!("Failed to set tray visibility: {}", e);
                            }
                        }
                        debug!("Tray hidden successfully");
                    }

                    if settings.core.max_tray_items > 0 {
                        if let Err(e) =
                            update_tray_menu(&app_handle_clone, settings.core.max_tray_items).await
                        {
                            error!("Failed to update tray menu: {}", e);
                        }
                    }
                }
            });

            if start_with_tray {
                debug!("Starting with tray");
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.hide();
                }
            }

            Ok(())
        })
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show_app" => show_main_window(app),
            "mount_all" => {
                let _ = app.emit("mount-all", ());
            }
            "unmount_all" => {
                let _ = app.emit("unmount-all", ());
            }
            "quit" => {
                app.exit(0);
            }
            id if id.starts_with("mount-") => handle_mount_remote(app, id),
            id if id.starts_with("unmount-") => handle_unmount_remote(app, id),
            id if id.starts_with("browse-") => handle_browse_remote(app, id),
            id if id.starts_with("delete-") => handle_delete_remote(app, id),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            set_theme,
            check_rclone_installed,
            provision_rclone,
            get_all_remote_configs,
            get_disk_usage,
            list_mounts,
            mount_remote,
            unmount_remote,
            get_remotes,
            get_remote_config,
            get_remote_types,
            get_oauth_supported_remotes,
            get_remote_config_fields,
            create_remote,
            update_remote,
            delete_remote,
            delete_remote_settings,
            quit_rclone_oauth,
            get_global_flags,
            get_copy_flags,
            get_sync_flags,
            get_filter_flags,
            get_vfs_flags,
            get_mount_flags,
            get_mounted_remotes,
            open_in_files,
            get_folder_location,
            load_settings,
            save_settings,
            save_remote_settings,
            get_remote_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
