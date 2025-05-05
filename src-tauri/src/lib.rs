use core::{
    check_binaries::{is_7z_available, is_rclone_available},
    settings::settings::{analyze_backup_file, load_setting_value, restore_encrypted_settings},
};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, Once},
};

use log::{debug, error, info};
use rclone::api::{
    engine::RcApiEngine,
    state::{
        clear_errors_for_remote, clear_logs_for_remote, get_cached_mounted_remotes,
        get_remote_errors, get_remote_logs,
    },
};
use serde_json::json;
use tauri::{Emitter, Manager, Theme, WindowEvent};
use tauri_plugin_store::StoreBuilder;

use crate::{
    core::{
        event_listener::setup_event_listener,
        lifecycle::{shutdown::handle_shutdown, startup::handle_startup},
        settings::{
            settings::{
                backup_settings, delete_remote_settings, get_remote_settings, load_settings,
                reset_settings, restore_settings, save_remote_settings, save_settings,
                SettingsState,
            },
            settings_store::AppSettings,
        },
        tray::{
            actions::{
                handle_browse_remote, handle_delete_remote, handle_mount_remote,
                handle_unmount_remote, show_main_window,
            },
            tray::setup_tray,
        },
    },
    rclone::{
        api::{
            api_command::{
                create_remote, delete_remote, mount_remote, quit_rclone_oauth, start_copy,
                start_sync, unmount_all_remotes, unmount_remote, update_remote,
            },
            api_query::{
                get_all_remote_configs, get_disk_usage, get_mounted_remotes,
                get_oauth_supported_remotes, get_remote_config, get_remote_config_fields,
                get_remote_types, get_remotes,
            },
            flags::{
                get_copy_flags, get_filter_flags, get_global_flags, get_mount_flags,
                get_sync_flags, get_vfs_flags,
            },
            state::{get_cached_remotes, get_configs, get_settings, CACHE, RCLONE_STATE},
        },
        mount::{check_mount_plugin, install_mount_plugin},
    },
    utils::{
        file_helper::{get_file_location, get_folder_location, open_in_files},
        rclone::provision::provision_rclone,
    },
};

mod core;
mod rclone;
mod utils;

static INIT_LOGGER: Once = Once::new();

pub struct RcloneState {
    pub client: reqwest::Client,
}

use std::sync::RwLock;

#[derive(Clone)]
struct TrayEnabled(pub Arc<RwLock<bool>>);

#[tauri::command]
async fn set_theme(theme: String, window: tauri::Window) -> Result<(), String> {
    let current_theme = window.theme().unwrap_or(Theme::Light);
    let theme_enum = match theme.as_str() {
        "dark" => Theme::Dark,
        _ => Theme::Light,
    };
    if current_theme != theme_enum {
        window
            .set_theme(Some(theme_enum))
            .map_err(|e| format!("Failed to set theme: {}", e))?;
    }

    Ok(())
}

fn init_logging(enable_debug: bool) {
    INIT_LOGGER.call_once(|| {
        let mut builder = env_logger::Builder::new();
        builder.filter_level(if enable_debug {
            log::LevelFilter::Debug
        } else {
            log::LevelFilter::Info
        });
        builder.init();
    });
}

/// Initializes Rclone API and OAuth state, and launches the Rclone engine.
pub fn init_rclone_state(
    app_handle: &tauri::AppHandle,
    settings: &AppSettings,
) -> Result<(), String> {
    // Set API URL
    RCLONE_STATE
        .set_api(
            format!("http://127.0.0.1:{}", settings.core.rclone_api_port),
            settings.core.rclone_api_port,
        )
        .map_err(|e| format!("Failed to set Rclone API: {}", e))?;

    // Set OAuth URL
    RCLONE_STATE
        .set_oauth(
            format!("http://127.0.0.1:{}", settings.core.rclone_oauth_port),
            settings.core.rclone_oauth_port,
        )
        .map_err(|e| format!("Failed to set Rclone OAuth: {}", e))?;

    // Initialize Rclone engine
    let mut engine = RcApiEngine::lock_engine()?;
    engine.init(app_handle);

    info!("🔄 Rclone engine initialized");

    Ok(())
}

fn setup_config_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let config_dir = app_handle
        .path()
        .app_data_dir()
        .expect("Failed to get app data directory");

    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config directory: {}", e))?;

    Ok(config_dir)
}

async fn async_startup(app_handle: tauri::AppHandle, settings: AppSettings) {
    debug!("🚀 Starting async startup tasks");

    setup_event_listener(&app_handle);

    let app_handle1 = app_handle.clone();
    let app_handle2 = app_handle.clone();
    let app_handle3 = app_handle.clone();
    let app_handle4 = app_handle.clone();

    let _refresh = tokio::join!(
        CACHE.refresh_remote_list(app_handle1),
        CACHE.refresh_remote_settings(app_handle2),
        CACHE.refresh_remote_configs(app_handle3),
        CACHE.refresh_mounted_remotes(app_handle4),
    );

    if settings.general.tray_enabled {
        debug!("🧊 Setting up tray");
        if let Err(e) = setup_tray(app_handle.clone(), settings.core.max_tray_items).await {
            error!("Failed to setup tray: {}", e);
        }
    }

    handle_startup(app_handle.clone()).await;
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
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .on_window_event(move |window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                let tray_enabled_arc = window.app_handle().state::<TrayEnabled>().0.clone();
                if let Ok(tray_enabled) = tray_enabled_arc.clone().read() {
                    if *tray_enabled {
                        api.prevent_close();
                        if let Some(win) = window.app_handle().get_webview_window("main") {
                            win.hide().unwrap_or_else(|e| {
                                eprintln!("Failed to hide window: {}", e);
                            });
                            win.eval("document.body.innerHTML = '';")
                                .unwrap_or_else(|e| {
                                    eprintln!("Failed to clear window content: {}", e);
                                });
                        }
                    } else {
                        window.hide().unwrap_or_else(|e| {
                            eprintln!("Failed to hide window: {}", e);
                        });
                        tauri::async_runtime::block_on(handle_shutdown(
                            window.app_handle().clone(),
                        ));
                        window.app_handle().exit(0);
                    }
                } else {
                    eprintln!("Failed to read tray_enabled state");
                }
            }
            WindowEvent::Focused(true) => {
                if let Some(win) = window.app_handle().get_webview_window("main") {
                    win.show().unwrap_or_else(|e| {
                        eprintln!("Failed to show window: {}", e);
                    });
                }
            }
            _ => {}
        })
        .manage(RcloneState {
            client: reqwest::Client::new(),
        })
        .setup(|app| {
            let app_handle = app.handle();
            let args = std::env::args().collect::<Vec<_>>();
            let start_with_tray = args.contains(&"--tray".to_string());

            // ────── Hide main window if started with tray ──────
            if start_with_tray {
                if let Some(win) = app_handle.get_webview_window("main") {
                    let _ = win.hide();
                }
            }

            let config_dir = setup_config_dir(&app_handle)?;
            let store_path = config_dir.join("settings.json");

            // ────── CONFIG DIR & SETTINGS STORE ──────
            let store = Arc::new(Mutex::new(
                StoreBuilder::new(app_handle, store_path)
                    .build()
                    .map_err(|e| format!("Failed to create settings store: {}", e))?,
            ));

            app.manage(SettingsState {
                store: store.clone(),
                config_dir,
            });

            // ────── LOAD SETTINGS ──────
            let settings_json = tauri::async_runtime::block_on(load_settings(
                app.state::<SettingsState<tauri::Wry>>(),
            ))
            .unwrap_or_else(|_| json!({ "settings": AppSettings::default() }));

            let settings: AppSettings = serde_json::from_value(settings_json["settings"].clone())
                .unwrap_or_else(|_| AppSettings::default());

            let tray_enabled = Arc::new(RwLock::new(settings.general.tray_enabled));
            app.manage(TrayEnabled(tray_enabled.clone()));

            // ────── INIT LOGGING ──────
            init_logging(settings.experimental.debug_logging);

            // ────── INIT RCLONE STATE + ENGINE ──────
            if let Err(e) = init_rclone_state(&app_handle, &settings) {
                error!("Rclone initialization failed: {}", e);
            }

            // ────── ASYNC STARTUP ──────
            let app_handle_clone = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                async_startup(app_handle_clone, settings).await;
            });

            Ok(())
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show_app" => show_main_window(app),
            "mount_all" => app.emit("mount-all", ()).unwrap(),
            "unmount_all" => {
                let app_clone = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) =
                        unmount_all_remotes(app_clone.clone(), app_clone.state(), "menu".to_string()).await
                    {
                        error!("Failed to unmount all remotes: {}", e);
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
            load_setting_value,
            save_settings,
            save_remote_settings,
            get_remote_settings,
            delete_remote_settings,
            backup_settings,
            analyze_backup_file,
            restore_encrypted_settings,
            restore_settings,
            reset_settings,
            // Check mount plugin
            check_mount_plugin,
            install_mount_plugin,
            // Cache remotes
            get_cached_remotes,
            get_configs,
            get_settings,
            get_cached_mounted_remotes,
            // Check binaries
            is_rclone_available,
            is_7z_available,
            // Logs and errors
            get_remote_errors,
            get_remote_logs,
            clear_errors_for_remote,
            clear_logs_for_remote,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
