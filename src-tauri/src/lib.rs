use core::{
    check_binaries::{is_7z_available, is_rclone_available, read_rclone_path},
    settings::settings::{analyze_backup_file, load_setting_value, restore_encrypted_settings},
    tray::actions::{
        handle_copy_remote, handle_stop_all_jobs, handle_stop_copy, handle_stop_sync,
        handle_sync_remote,
    },
};

use log::{debug, error, info};
use rclone::api::{
    api_command::{set_bandwidth_limit, stop_job},
    api_query::{get_bandwidth_limit, get_fs_info, get_remote_paths},
    state::{
        clear_remote_logs, get_cached_mounted_remotes, get_job_status,
        get_jobs, get_remote_logs
    },
};
use serde_json::json;
use tauri::{Manager, Theme, WindowEvent};
use tauri_plugin_store::StoreBuilder;
use utils::{
    builder::{create_app_window, setup_tray},
    log::init_logging,
    network::check_links,
};

use crate::{
    core::{
        event_listener::setup_event_listener,
        lifecycle::{shutdown::handle_shutdown, startup::handle_startup},
        settings::settings::{
            backup_settings, delete_remote_settings, get_remote_settings, load_settings,
            reset_settings, restore_settings, save_remote_settings, save_settings,
        },
        tray::actions::{
            handle_browse_remote, handle_delete_remote, handle_mount_remote, handle_unmount_remote,
            show_main_window,
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
                get_oauth_supported_remotes, get_rclone_info, get_remote_config,
                get_remote_config_fields, get_remote_types, get_remotes,
            },
            flags::{
                get_copy_flags, get_filter_flags, get_global_flags, get_mount_flags,
                get_sync_flags, get_vfs_flags,
            },
            state::{
                CACHE, ENGINE_STATE, get_active_jobs, get_cached_remotes, get_configs, get_settings,
            },
        },
        mount::{check_mount_plugin_installed, install_mount_plugin},
    },
    utils::{
        file_helper::{get_file_location, get_folder_location, open_in_files},
        rclone::provision::provision_rclone,
        types::{AppSettings, RcApiEngine, RcloneState, SettingsState},
    },
};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::Mutex;

mod core;
mod rclone;
mod utils;

impl RcloneState {
    pub fn is_shutting_down(&self) -> bool {
        self.is_shutting_down.load(Ordering::SeqCst)
    }

    pub fn set_shutting_down(&self) {
        self.is_shutting_down.store(true, Ordering::SeqCst);
    }
}

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

/// Initializes Rclone API and OAuth state, and launches the Rclone engine.
pub fn init_rclone_state(
    app_handle: &tauri::AppHandle,
    settings: &AppSettings,
) -> Result<(), String> {
    // Set API URL
    ENGINE_STATE
        .set_api(
            format!("http://127.0.0.1:{}", settings.core.rclone_api_port),
            settings.core.rclone_api_port,
        )
        .map_err(|e| format!("Failed to set Rclone API: {}", e))?;

    // Set OAuth URL
    ENGINE_STATE
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

    if !settings.core.bandwidth_limit.is_empty() {
        debug!(
            "🌐 Setting bandwidth limit: {}",
            settings.core.bandwidth_limit
        );
        let rclone_state = app_handle.state::<RcloneState>();
        if let Err(e) = set_bandwidth_limit(
            app_handle.clone(),
            Some(settings.core.bandwidth_limit.clone()),
            rclone_state,
        )
        .await
        {
            error!("Failed to set bandwidth limit: {}", e);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app.clone());
        }))
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
                window.hide().unwrap_or_else(|e| {
                    eprintln!("Failed to hide window: {}", e);
                });
                if *window
                    .app_handle()
                    .state::<RcloneState>()
                    .tray_enabled
                    .clone()
                    .read()
                    .unwrap()
                {
                    api.prevent_close();
                } else {
                    let window_ = window.clone();
                    tauri::async_runtime::spawn(async move {
                        window_
                            .app_handle()
                            .state::<RcloneState>()
                            .set_shutting_down();
                        handle_shutdown(window_.app_handle().clone()).await;
                    });
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
        .setup(|app| {
            let app_handle = app.handle();

            let config_dir = setup_config_dir(&app_handle)?;
            let store_path = config_dir.join("settings.json");

            // ────── CONFIG DIR & SETTINGS STORE ──────
            let store = Mutex::new(
                StoreBuilder::new(&app_handle.clone(), store_path)
                    .build()
                    .map_err(|e| format!("Failed to create settings store: {}", e))?,
            );

            app.manage(SettingsState { store, config_dir });

            // ────── LOAD SETTINGS ──────
            let settings_json = tauri::async_runtime::block_on(load_settings(
                app.state::<SettingsState<tauri::Wry>>(),
            ))
            .unwrap_or_else(|_| json!({ "settings": AppSettings::default() }));

            let settings: AppSettings = serde_json::from_value(settings_json["settings"].clone())
                .unwrap_or_else(|_| AppSettings::default());

            let rclone_path = read_rclone_path(&app_handle);

            app.manage(RcloneState {
                client: reqwest::Client::new(),
                config_path: Arc::new(std::sync::RwLock::new(
                    settings.core.rclone_config_path.clone(),
                )),
                tray_enabled: Arc::new(std::sync::RwLock::new(settings.general.tray_enabled)),
                is_shutting_down: AtomicBool::new(false),
                notifications_enabled: Arc::new(std::sync::RwLock::new(
                    settings.general.notifications,
                )),
                rclone_path: Arc::new(std::sync::RwLock::new(rclone_path)),
                restrict_mode: Arc::new(std::sync::RwLock::new(settings.general.restrict)),
            });

            // ────── INIT LOGGING ──────
            if let Err(e) = init_logging(settings.experimental.debug_logging) {
                error!("Failed to initialize logging: {}", e);
            }

            // ────── INIT RCLONE STATE + ENGINE ──────
            if let Err(e) = init_rclone_state(&app_handle, &settings) {
                error!("Rclone initialization failed: {}", e);
            }

            // ────── ASYNC STARTUP ──────
            let app_handle_clone = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                async_startup(app_handle_clone.clone(), settings).await;
                handle_startup(app_handle_clone).await;
            });

            let args = std::env::args().collect::<Vec<_>>();
            let start_with_tray = args.contains(&"--tray".to_string());
            if !start_with_tray {
                debug!("Creating main window");
                create_app_window(app.handle().clone());
            }

            Ok(())
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show_app" => show_main_window(app.clone()),
            // "mount_all" => handle_mount_all_remotes(app.clone()),
            "stop_all_jobs" => handle_stop_all_jobs(app.clone()),
            "unmount_all" => {
                let app_clone = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = unmount_all_remotes(
                        app_clone.clone(),
                        app_clone.state(),
                        "menu".to_string(),
                    )
                    .await
                    {
                        error!("Failed to unmount all remotes: {}", e);
                    }
                });
            }
            "quit" => {
                let app_clone = app.clone();
                tauri::async_runtime::spawn(async move {
                    app_clone.state::<RcloneState>().set_shutting_down();
                    handle_shutdown(app_clone).await;
                });
            }
            id if id.starts_with("mount-") => handle_mount_remote(app.clone(), id),
            id if id.starts_with("unmount-") => handle_unmount_remote(app.clone(), id),
            id if id.starts_with("sync-") => handle_sync_remote(app.clone(), id),
            id if id.starts_with("copy-") => handle_copy_remote(app.clone(), id),
            id if id.starts_with("stop_sync-") => handle_stop_sync(app.clone(), id),
            id if id.starts_with("stop_copy-") => handle_stop_copy(app.clone(), id),
            id if id.starts_with("browse-") => handle_browse_remote(&app, id),
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
            get_rclone_info,
            // Rclone Command API
            get_all_remote_configs,
            get_fs_info,
            get_disk_usage,
            get_remotes,
            get_remote_config,
            get_remote_types,
            get_oauth_supported_remotes,
            get_remote_config_fields,
            get_mounted_remotes,
            start_sync,
            start_copy,
            set_bandwidth_limit,
            // Rclone Query API
            mount_remote,
            unmount_remote,
            create_remote,
            update_remote,
            delete_remote,
            quit_rclone_oauth,
            get_remote_paths,
            get_bandwidth_limit,
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
            check_links,
            // Check mount plugin
            check_mount_plugin_installed,
            install_mount_plugin,
            // Cache remotes
            get_cached_remotes,
            get_configs,
            get_settings,
            get_cached_mounted_remotes,
            // Check binaries
            is_rclone_available,
            is_7z_available,
            // Logs
            get_remote_logs,
            clear_remote_logs,
            // Jobs Cache
            get_jobs,
            get_active_jobs,
            get_job_status,
            stop_job
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
