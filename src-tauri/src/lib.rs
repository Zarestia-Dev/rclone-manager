use core::{
    event_listener::setup_event_listener,
    lifecycle::{shutdown::handle_shutdown, startup::handle_startup},
    settings::{
        settings::{
            backup_settings, delete_remote_settings, get_remote_settings, load_settings, reset_settings, restore_settings, save_remote_settings, save_settings, SettingsState
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
        api_command::{
            create_remote, delete_remote, mount_remote, quit_rclone_oauth, start_copy, start_sync,
            unmount_all_remotes, unmount_remote, update_remote,
        },
        api_query::{
            get_all_remote_configs, get_disk_usage, get_mounted_remotes,
            get_oauth_supported_remotes, get_remote_config, get_remote_config_fields,
            get_remote_types, get_remotes,
        },
        engine::ENGINE,
        flags::{
            get_copy_flags, get_filter_flags, get_global_flags, get_mount_flags, get_sync_flags,
            get_vfs_flags,
        },
        state::{get_cached_remotes, get_configs, get_settings, CACHE, RCLONE_STATE},
    },
    mount::{check_mount_plugin, install_mount_plugin},
};
use reqwest::Client;
use serde_json::json;
use std::sync::Once;
use std::{
    process::Command,
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager, Theme, WindowEvent};
use tauri_plugin_http::reqwest;
use tauri_plugin_store::StoreBuilder;
use utils::{file_helper::{get_file_location, get_folder_location, open_in_files}, rclone::provision::{check_rclone_installed, provision_rclone}};

mod core;
mod rclone;
mod utils;

static INIT_LOGGER: Once = Once::new();
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

/// Initializes Rclone API and OAuth state, and launches the Rclone engine.
///
/// Returns `Ok(())` if successful, or an `Err(String)` with failure reason.
pub fn init_rclone_state(
    app_handle: &tauri::AppHandle,
    settings: &AppSettings,
) -> Result<(), String> {
    // Set API URL
    RCLONE_STATE
        .set_api(
            format!("http://localhost:{}", settings.core.rclone_api_port),
            settings.core.rclone_api_port,
        )
        .map_err(|e| format!("Failed to set Rclone API: {}", e))?;

    // Set OAuth URL
    RCLONE_STATE
        .set_oauth(
            format!("http://localhost:{}", settings.core.rclone_oauth_port),
            settings.core.rclone_oauth_port,
        )
        .map_err(|e| format!("Failed to set Rclone OAuth: {}", e))?;

    // Init Rclone engine
    let mut engine = ENGINE.lock().unwrap();
    engine.init(app_handle); // still spawn the monitor thread
    
    if !engine.start_and_wait(app_handle, 5) {
        error!("🚨 Rclone API did not become ready in time!");
    } else {
        info!("✅ Rclone API is confirmed ready, continuing startup logic.");
        app_handle
            .emit("rclone-api-ready", ())
            .expect("Failed to emit rclone-api-ready event");
    }
    info!("✅ Rclone engine and state initialized");

    Ok(())
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
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if let Some(win) = window.app_handle().get_webview_window("main") {
                    let _ = win.hide();
                }
            }
            _ => {}
        }) // ✅ Prevent window close and hide instead
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
            let args: Vec<String> = std::env::args().collect();
            let start_with_tray = args.contains(&"--tray".to_string());

            // ────── CONFIG DIR & SETTINGS STORE ──────
            let config_dir = app_handle
                .path()
                .app_data_dir()
                .expect("Failed to get app data directory");
            std::fs::create_dir_all(&config_dir).expect("Failed to create config directory");

            let store_path = config_dir.join("settings.json");
            let store = Arc::new(Mutex::new(
                StoreBuilder::new(&app_handle.clone(), store_path)
                    .build()
                    .expect("Failed to create settings store"),
            ));

            app.manage(SettingsState {
                store: store.clone(),
                config_dir: config_dir.clone(),
            });

            // ────── LOAD SETTINGS ──────
            let settings_json = tauri::async_runtime::block_on(load_settings(
                app.state::<SettingsState<tauri::Wry>>(),
            ))
            .unwrap_or_else(|_| json!({ "settings": AppSettings::default() }));

            let settings: AppSettings = serde_json::from_value(settings_json["settings"].clone())
                .unwrap_or_else(|_| AppSettings::default());

            init_logging(settings.experimental.debug_logging);

            // ────── INIT RCLONE STATE + ENGINE ──────
            if let Err(e) = init_rclone_state(&app_handle, &settings) {
                error!("{}", e);
            }

            // ────── ASYNC STARTUP ──────
            let app_handle_clone = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                debug!("🚀 Starting async startup logic");

                CACHE.refresh_remote_list(app_handle_clone.clone()).await;

                CACHE
                    .refresh_remote_settings(app_handle_clone.clone())
                    .await;

                CACHE.refresh_remote_configs(app_handle_clone.clone()).await;

                handle_startup(app_handle_clone.clone()).await;

                if settings.general.tray_enabled || start_with_tray {
                    debug!("🧊 Tray is enabled, setting up...");

                    if let Err(e) =
                        setup_tray(app_handle_clone.clone(), settings.core.max_tray_items).await
                    {
                        error!("Failed to setup tray: {}", e);
                    }

                    if start_with_tray {
                        if let Some(win) = app_handle_clone.get_webview_window("main") {
                            let _ = win.hide();
                        }
                    }
                }

                // ✅ Now that everything is ready, start event listeners
                setup_event_listener(&app_handle_clone);
            });

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
                        Ok(info) => {
                            info!("Unmounted all remotes: {}", info);
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
            get_file_location,
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
            start_sync,
            start_copy,
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
            backup_settings,
            restore_settings,
            reset_settings,
            // Check mount plugin
            check_mount_plugin,
            install_mount_plugin,
            // Cache remotes
            get_cached_remotes,
            get_configs,
            get_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
