use core::{
    event_listener::setup_event_listener,
    lifecycle::{shutdown::handle_shutdown, startup::handle_startup},
    settings::{
        settings::{
            delete_remote_settings, get_remote_settings, load_settings, save_remote_settings,
            save_settings, SettingsState,
        },
        settings_store::AppSettings,
    },
    tray::{
        actions::{
            handle_browse_remote, handle_delete_remote, handle_mount_remote, handle_unmount_remote,
            show_main_window,
        },
        tray::setup_tray,
    },
};
use log::{debug, error, info};
use rclone::{
    api::{
        api_command::{create_remote, delete_remote, mount_remote, quit_rclone_oauth, unmount_all_remotes, unmount_remote, update_remote}, api_query::{get_all_remote_configs, get_disk_usage, get_mounted_remotes, get_oauth_supported_remotes, get_remote_config, get_remote_config_fields, get_remote_types, get_remotes}, engine::{ensure_rc_api_running, set_rclone_path}, flags::{
            get_copy_flags, get_filter_flags, get_global_flags, get_mount_flags, get_sync_flags,
            get_vfs_flags,
        }, state::{set_rclone_api_url_port, set_rclone_oauth_url_port}
    },
    mount::{check_mount_plugin, install_mount_plugin},
};
use reqwest::Client;
use serde_json::json;
use std::{
    process::Command,
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager, Theme, WindowEvent};
use tauri_plugin_http::reqwest;
use tauri_plugin_store::StoreBuilder;
use utils::{
    check_rclone::{check_rclone_installed, provision_rclone},
    file_helper::{get_folder_location, open_in_files},
};

mod core;
mod rclone;
mod utils;

pub struct RcloneState {
    pub client: Client,
}

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
            // ✅ Read command-line arguments
            let args: Vec<String> = std::env::args().collect();
            let start_with_tray = args.contains(&"--tray".to_string());

            let app_handle = app.handle();

            // Ensure set_rclone_path runs and finishes before proceeding
            if let Err(e) = set_rclone_path(app_handle.clone()) {
                error!("❌ Failed to set rclone path: {}", e);
                return Err(e.into());
            }

            let config_dir = app_handle
                .path()
                .app_data_dir()
                .expect("Failed to get app data directory");

            std::fs::create_dir_all(&config_dir).expect("Failed to create config directory");

            let store_path = config_dir.join("settings.json");
            let store = Arc::new(Mutex::new(
                StoreBuilder::new(app_handle, store_path)
                    .build()
                    .expect("Failed to create settings store"),
            ));

            let (update_sender, update_receiver) = tokio::sync::broadcast::channel::<()>(1);

            app.manage(SettingsState {
                store: store.clone(),
                config_dir: config_dir.clone(),
                update_sender,
            });

            let settings_json = tauri::async_runtime::block_on(load_settings(
                app.state::<SettingsState<tauri::Wry>>(),
            ))
            .unwrap_or_else(|_| json!({ "settings": AppSettings::default() }));

            let settings: AppSettings = serde_json::from_value(settings_json["settings"].clone())
                .unwrap_or_else(|_| AppSettings::default());

            init_logging(settings.experimental.debug_logging);
            set_rclone_oauth_url_port(settings.core.rclone_oauth_port);
            set_rclone_api_url_port(app_handle, settings.core.rclone_api_port);

            let app_handle_clone = app_handle.clone();
            ensure_rc_api_running(app_handle_clone);
            
            
            if settings.general.tray_enabled || start_with_tray {
                debug!("Tray is enabled");
                if let Err(e) = tauri::async_runtime::block_on(setup_tray(
                    app_handle.clone(),
                    settings.core.max_tray_items,
                )) {
                    error!("Failed to setup tray: {}", e);
                }
                
                if start_with_tray {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.hide();
                    }
                }
            } else {
                debug!("Tray is disabled");
            }
            
            tauri::async_runtime::spawn({
                let app_handle_clone = app_handle.clone();
                async move {
                    handle_startup(app_handle_clone).await;
                }
            });
            // ✅ Pass `update_receiver` to the event listener
            setup_event_listener(&app_handle, update_receiver);

            Ok(())
        })
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show_app" => show_main_window(app),
            "mount_all" => {
                let _ = app.emit("mount-all", ());
            }
            "unmount_all" => {
            let app_clone = app.clone();
            tauri::async_runtime::spawn(async move {
                let state = app_clone.state::<RcloneState>().clone();
                match unmount_all_remotes(app_clone.clone(), state).await {
                    Ok((success_count, total_count)) => {
                        info!("Unmounted {} remotes out of {}", success_count, total_count);
                    }
                    Err(e) => {
                        error!("Failed to unmount all remotes: {}", e);
                    }
                }
            });
            }
            "quit" => {
                let app_clone = app.clone();
                tauri::async_runtime::spawn(async move {
                    handle_shutdown(app_clone.clone()).await;
                    app_clone.exit(0);
                });
            }
            id if id.starts_with("mount-") => handle_mount_remote(app.clone(), id),
            id if id.starts_with("unmount-") => handle_unmount_remote(app.clone(), id),
            id if id.starts_with("browse-") => handle_browse_remote(app, id),
            id if id.starts_with("delete-") => handle_delete_remote(app.clone(), id),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            // Others
            open_in_files,
            get_folder_location,
            set_theme,
            check_rclone_installed,
            provision_rclone,
            // Rclone Command API
            get_all_remote_configs,
            get_disk_usage,
            get_remotes,
            get_remote_config,
            get_remote_types,
            get_oauth_supported_remotes,
            get_remote_config_fields,
            get_mounted_remotes,
            // Rclone Query API
            mount_remote,
            unmount_remote,
            create_remote,
            update_remote,
            delete_remote,
            quit_rclone_oauth,
            // Flags
            get_global_flags,
            get_copy_flags,
            get_sync_flags,
            get_filter_flags,
            get_vfs_flags,
            get_mount_flags,
            // Settings
            load_settings,
            save_settings,
            save_remote_settings,
            get_remote_settings,
            delete_remote_settings,
            // Check mount plugin
            check_mount_plugin,
            install_mount_plugin
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
