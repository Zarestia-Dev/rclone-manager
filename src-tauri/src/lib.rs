use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use log::{debug, error, info};
use tauri::{Manager, Theme, WindowEvent};
use tauri_plugin_store::StoreBuilder;
use tokio::sync::Mutex;

mod core;
mod rclone;
mod utils;

use crate::{
    core::{
        check_binaries::{is_7z_available, is_rclone_available, read_rclone_path},
        event_listener::setup_event_listener,
        lifecycle::{shutdown::handle_shutdown, startup::handle_startup},
        settings::settings::{
            analyze_backup_file, backup_settings, delete_remote_settings, get_remote_settings,
            load_setting_value, load_settings, reset_settings, restore_encrypted_settings,
            restore_settings, save_remote_settings, save_settings,
        },
        tray::actions::{
            handle_browse_remote, handle_copy_remote, handle_delete_remote, handle_mount_remote,
            handle_stop_all_jobs, handle_stop_copy, handle_stop_sync, handle_sync_remote,
            handle_unmount_remote, show_main_window,
        },
    },
    rclone::{
        api::{
            api_command::{
                create_remote, delete_remote, mount_remote, quit_rclone_oauth, set_bandwidth_limit,
                start_copy, start_sync, stop_job, unmount_all_remotes, unmount_remote,
                update_remote,
            },
            api_query::{
                get_all_remote_configs, get_bandwidth_limit, get_core_stats, get_disk_usage, get_fs_info, get_memory_stats, get_mounted_remotes, get_oauth_supported_remotes, get_rclone_info, get_rclone_pid, get_remote_config, get_remote_config_fields, get_remote_paths, get_remote_types, get_remotes
            },
            flags::{
                get_copy_flags, get_filter_flags, get_global_flags, get_mount_flags,
                get_sync_flags, get_vfs_flags,
            },
            state::{
                clear_remote_logs, delete_job, get_active_jobs, get_cached_mounted_remotes, get_cached_remotes, get_configs, get_job_status, get_jobs, get_remote_logs, get_settings, CACHE, ENGINE_STATE
            },
        },
        mount::{check_mount_plugin_installed, install_mount_plugin},
    },
    utils::{
        builder::{create_app_window, setup_tray},
        file_helper::{get_file_location, get_folder_location, open_in_files},
        log::init_logging,
        network::{check_links, is_network_metered, kill_process, monitor_network_changes},
        rclone::provision::provision_rclone,
        types::{AppSettings, RcApiEngine, RcloneState, SettingsState},
    },
};

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
    let theme_enum = match theme.as_str() {
        "dark" => Theme::Dark,
        _ => Theme::Light,
    };

    if window.theme().unwrap_or(Theme::Light) != theme_enum {
        window
            .set_theme(Some(theme_enum))
            .map_err(|e| format!("Failed to set theme: {e}"))?;
    }

    Ok(())
}

/// Initializes Rclone API and OAuth state, and launches the Rclone engine.
fn init_rclone_state(app_handle: &tauri::AppHandle, settings: &AppSettings) -> Result<(), String> {
    let api_url = format!("http://127.0.0.1:{}", settings.core.rclone_api_port);
    let oauth_url = format!("http://127.0.0.1:{}", settings.core.rclone_oauth_port);

    ENGINE_STATE
        .set_api(api_url, settings.core.rclone_api_port)
        .map_err(|e| format!("Failed to set Rclone API: {e}"))?;

    ENGINE_STATE
        .set_oauth(oauth_url, settings.core.rclone_oauth_port)
        .map_err(|e| format!("Failed to set Rclone OAuth: {e}"))?;

    let mut engine = RcApiEngine::lock_engine()?;
    engine.init(app_handle);

    info!("🔄 Rclone engine initialized");
    Ok(())
}

fn setup_config_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let config_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config directory: {e}"))?;

    Ok(config_dir)
}

async fn async_startup(app_handle: tauri::AppHandle, settings: AppSettings) {
    debug!("🚀 Starting async startup tasks");

    setup_event_listener(&app_handle);

    CACHE.refresh_all(app_handle.clone()).await;
    debug!("🔄 Cache refreshed");

    if settings.general.tray_enabled {
        debug!("🧊 Setting up tray");
        if let Err(e) = setup_tray(app_handle.clone(), settings.core.max_tray_items).await {
            error!("Failed to setup tray: {e}");
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
            error!("Failed to set bandwidth limit: {e}");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
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
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                if let Err(e) = window.hide() {
                    error!("Failed to hide window: {e}");
                }

                let state = window.app_handle().state::<RcloneState>();
                if *state.tray_enabled.read().unwrap() {
                    api.prevent_close();
                } else {
                    api.prevent_close();
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
                    if let Err(e) = win.show() {
                        error!("Failed to show window: {e}");
                    }
                }
            }
            _ => {}
        })
        .setup(|app| {
            let app_handle = app.handle();
            let config_dir = setup_config_dir(&app_handle)?;
            let store_path = config_dir.join("settings.json");

            let store = Mutex::new(
                StoreBuilder::new(&app_handle.clone(), store_path)
                    .build()
                    .map_err(|e| format!("Failed to create settings store: {e}"))?,
            );

            app.manage(SettingsState { store, config_dir });

            // Load settings with better error handling
            let settings_json = tauri::async_runtime::block_on(load_settings(
                app.state::<SettingsState<tauri::Wry>>(),
            ))
            .map_err(|e| format!("Failed to load settings: {e}"))?;

            let settings: AppSettings = serde_json::from_value(settings_json["settings"].clone())
                .map_err(|e| format!("Failed to parse settings: {e}"))?;

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
                rclone_path: Arc::new(std::sync::RwLock::new(read_rclone_path(&app_handle))),
                restrict_mode: Arc::new(std::sync::RwLock::new(settings.general.restrict)),
            });

            init_logging(settings.experimental.debug_logging)
                .map_err(|e| format!("Failed to initialize logging: {e}"))?;

            init_rclone_state(&app_handle, &settings)
                .map_err(|e| format!("Rclone initialization failed: {e}"))?;

            // Async startup
            let app_handle_clone = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                async_startup(app_handle_clone.clone(), settings).await;
                handle_startup(app_handle_clone.clone()).await;
                monitor_network_changes(app_handle_clone).await;
            });

            // Only create window if not starting with tray
            if !std::env::args().any(|arg| arg == "--tray") {
                debug!("Creating main window");
                create_app_window(app.handle().clone());
            }

            Ok(())
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show_app" => show_main_window(app.clone()),
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
                        error!("Failed to unmount all remotes: {e}");
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
            id if id.starts_with("browse-") => handle_browse_remote(app, id),
            id if id.starts_with("delete-") => handle_delete_remote(app.clone(), id),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            // File operations
            open_in_files,
            get_folder_location,
            get_file_location,
            // UI
            set_theme,
            // Rclone operations
            provision_rclone,
            get_rclone_info,
            get_rclone_pid,
            kill_process,
            // Rclone Command API
            get_all_remote_configs,
            get_core_stats,
            get_fs_info,
            get_disk_usage,
            get_memory_stats,
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
            // Network
            check_links,
            is_network_metered,
            // Mount plugin
            check_mount_plugin_installed,
            install_mount_plugin,
            // Cache
            get_cached_remotes,
            get_configs,
            get_settings,
            get_cached_mounted_remotes,
            // Binaries
            is_rclone_available,
            is_7z_available,
            // Logs
            get_remote_logs,
            clear_remote_logs,
            // Jobs
            get_jobs,
            get_active_jobs,
            get_job_status,
            stop_job,
            delete_job,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
