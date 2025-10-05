use std::sync::{Arc, atomic::AtomicBool};

use log::{debug, error};
use tauri::{Manager, WindowEvent};
use tauri_plugin_store::StoreBuilder;
use tokio::sync::Mutex;

mod core;
mod rclone;
mod utils;

#[cfg(all(desktop, feature = "updater"))]
use crate::utils::app::updater::app_updates::{
    DownloadState, PendingUpdate, fetch_update, get_download_status, install_update,
};

use crate::{
    core::{
        check_binaries::{check_rclone_available, is_7z_available},
        initialization::{async_startup, init_rclone_state, setup_config_dir},
        lifecycle::{shutdown::handle_shutdown, startup::handle_startup},
        security::{
            change_config_password, clear_config_password_env, clear_encryption_cache,
            encrypt_config, get_cached_encryption_status, get_config_password,
            has_config_password_env, has_stored_password, is_config_encrypted,
            is_config_encrypted_cached, remove_config_password, set_config_password_env,
            store_config_password, unencrypt_config, validate_rclone_password,
        },
        settings::{
            backup::{
                backup_manager::{analyze_backup_file, backup_settings},
                restore_manager::{restore_encrypted_settings, restore_settings},
            },
            operations::core::{
                load_setting_value, load_settings, reset_setting, reset_settings, save_settings,
            },
            remote::manager::{delete_remote_settings, get_remote_settings, save_remote_settings},
        },
        tray::actions::{
            handle_bisync_remote, handle_browse_remote, handle_copy_remote, handle_mount_remote,
            handle_move_remote, handle_stop_all_jobs, handle_stop_bisync, handle_stop_copy,
            handle_stop_move, handle_stop_sync, handle_sync_remote, handle_unmount_remote,
            show_main_window,
        },
    },
    rclone::{
        commands::{
            continue_create_remote_interactive, create_remote, create_remote_interactive,
            delete_remote, mount_remote, quit_rclone_oauth, set_bandwidth_limit, start_bisync,
            start_copy, start_move, start_sync, stop_job, unmount_all_remotes, unmount_remote,
            update_remote,
        },
        queries::{
            flags::{
                get_copy_flags, get_filter_flags, get_global_flags, get_mount_flags,
                get_sync_flags, get_vfs_flags,
            },
            get_all_remote_configs, get_bandwidth_limit, get_completed_transfers, get_core_stats,
            get_core_stats_filtered, get_disk_usage, get_fs_info, get_job_stats, get_memory_stats,
            get_mount_types, get_mounted_remotes, get_oauth_supported_remotes, get_rclone_info,
            get_rclone_pid, get_remote_config, get_remote_config_fields, get_remote_paths,
            get_remote_types, get_remotes,
        },
        state::{
            clear_remote_logs, delete_job, force_check_mounted_remotes, get_active_jobs,
            get_cached_mounted_remotes, get_cached_remotes, get_configs, get_job_status, get_jobs,
            get_remote_logs, get_settings,
        },
    },
    utils::{
        app::{
            builder::create_app_window,
            platform::{are_updates_disabled, get_build_type},
            ui::set_theme,
        },
        io::{
            file_helper::{get_file_location, get_folder_location, open_in_files},
            network::{check_links, is_network_metered, monitor_network_changes},
            terminal::open_terminal_config,
        },
        logging::log::init_logging,
        process::process_manager::kill_process_by_pid,
        rclone::{
            mount::{check_mount_plugin_installed, install_mount_plugin},
            provision::provision_rclone,
            updater::{check_rclone_update, update_rclone},
        },
        types::all_types::{AppSettings, RcloneState, SettingsState},
    },
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    #[cfg(feature = "updater")]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
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
                let state = window.app_handle().state::<RcloneState>();
                if *state.tray_enabled.read().unwrap() {
                    if let Err(e) = window.hide() {
                        error!("Failed to hide window: {e}");
                    }
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
                if let Some(win) = window.app_handle().get_webview_window("main")
                    && let Err(e) = win.show()
                {
                    error!("Failed to show window: {e}");
                }
            }
            _ => {}
        })
        .setup(|app| {
            let app_handle = app.handle();
            let config_dir = setup_config_dir(app_handle)?;
            let store_path = config_dir.join("settings.json");

            let store = Mutex::new(
                StoreBuilder::new(&app_handle.clone(), store_path)
                    .build()
                    .map_err(|e| format!("Failed to create settings store: {e}"))?,
            );

            app.manage(SettingsState { store, config_dir });

            // Initialize SafeEnvironmentManager for secure password handling
            use crate::core::security::{CredentialStore, SafeEnvironmentManager};
            let env_manager = SafeEnvironmentManager::new();

            // Initialize CredentialStore once and manage as state
            let credential_store = CredentialStore::new();

            // Initialize with any stored credentials
            if let Err(e) = env_manager.init_with_stored_credentials(&credential_store) {
                error!("Failed to initialize environment manager with stored credentials: {e}");
            }

            app.manage(env_manager);
            app.manage(credential_store);

            // Load settings with better error handling
            let settings_json = tauri::async_runtime::block_on(load_settings(
                app.state::<SettingsState<tauri::Wry>>(),
            ))
            .map_err(|e| format!("Failed to load settings: {e}"))?;

            let settings: AppSettings = serde_json::from_value(settings_json["settings"].clone())
                .map_err(|e| format!("Failed to parse settings: {e}"))?;

            // Check if --tray argument is provided to override tray settings
            let force_tray = std::env::args().any(|arg| arg == "--tray");
            let tray_enabled = settings.general.tray_enabled || force_tray;

            app.manage(RcloneState {
                client: reqwest::Client::new(),
                rclone_config_file: Arc::new(std::sync::RwLock::new(
                    settings.core.rclone_config_file.clone(),
                )),
                tray_enabled: Arc::new(std::sync::RwLock::new(tray_enabled)),
                is_shutting_down: AtomicBool::new(false),
                notifications_enabled: Arc::new(std::sync::RwLock::new(
                    settings.general.notifications,
                )),
                rclone_path: Arc::new(std::sync::RwLock::new(
                    settings.core.rclone_path.clone().into(),
                )),
                restrict_mode: Arc::new(std::sync::RwLock::new(settings.general.restrict)),
                terminal_apps: Arc::new(std::sync::RwLock::new(
                    settings.core.terminal_apps.clone(),
                )),
            });

            #[cfg(all(desktop, feature = "updater"))]
            app.manage(PendingUpdate(std::sync::Mutex::new(None)));
            #[cfg(all(desktop, feature = "updater"))]
            app.manage(DownloadState::default());

            // Setup global shortcuts
            #[cfg(desktop)]
            {
                use crate::utils::shortcuts::handle_global_shortcut_event;
                use log::info;
                use tauri_plugin_global_shortcut::{
                    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
                };

                // Define shortcuts
                let ctrl_q_shortcut = Shortcut::new(Some(Modifiers::CONTROL), Code::KeyQ);

                // Setup global shortcut plugin with handler
                app_handle.plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, shortcut, event| {
                            if let ShortcutState::Pressed = event.state() {
                                handle_global_shortcut_event(app, *shortcut);
                            }
                        })
                        .build(),
                )?;

                // Register shortcuts
                match app_handle.global_shortcut().register(ctrl_q_shortcut) {
                    Ok(_) => info!("Successfully registered Ctrl+Q shortcut"),
                    Err(e) => error!("Failed to register Ctrl+Q shortcut: {e}"),
                }

                info!("🔗 Global shortcuts registered successfully");
            }

            init_logging(settings.experimental.debug_logging)
                .map_err(|e| format!("Failed to initialize logging: {e}"))?;

            init_rclone_state(app_handle, &settings)
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
            id if id.starts_with("move-") => handle_move_remote(app.clone(), id),
            id if id.starts_with("bisync-") => handle_bisync_remote(app.clone(), id),
            id if id.starts_with("stop_sync-") => handle_stop_sync(app.clone(), id),
            id if id.starts_with("stop_copy-") => handle_stop_copy(app.clone(), id),
            id if id.starts_with("stop_move-") => handle_stop_move(app.clone(), id),
            id if id.starts_with("stop_bisync-") => handle_stop_bisync(app.clone(), id),
            id if id.starts_with("browse-") => handle_browse_remote(app, id),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            // File operations
            open_in_files,
            get_folder_location,
            get_file_location,
            // UI
            set_theme,
            // Platform
            get_build_type,
            are_updates_disabled,
            // Rclone operations
            provision_rclone,
            get_rclone_info,
            get_rclone_pid,
            check_rclone_update,
            update_rclone,
            // get_rclone_update_info,
            kill_process_by_pid,
            // Rclone Command API
            get_all_remote_configs,
            get_core_stats,
            get_core_stats_filtered,
            get_completed_transfers,
            get_job_stats,
            get_fs_info,
            get_disk_usage,
            get_memory_stats,
            get_remotes,
            get_remote_config,
            get_remote_types,
            get_oauth_supported_remotes,
            get_remote_config_fields,
            get_mounted_remotes,
            set_bandwidth_limit,
            // Rclone Sync API
            start_sync,
            start_copy,
            start_bisync,
            start_move,
            // Rclone Query API
            mount_remote,
            unmount_remote,
            create_remote_interactive,
            continue_create_remote_interactive,
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
            reset_settings,
            reset_setting,
            // Remote Settings
            save_remote_settings,
            get_remote_settings,
            delete_remote_settings,
            backup_settings,
            analyze_backup_file,
            restore_encrypted_settings,
            restore_settings,
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
            check_rclone_available,
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
            // Mount
            force_check_mounted_remotes,
            get_mount_types,
            // Application control
            handle_shutdown,
            open_terminal_config,
            // Security & Password Management
            store_config_password,
            get_config_password,
            has_stored_password,
            remove_config_password,
            validate_rclone_password,
            is_config_encrypted,
            is_config_encrypted_cached,
            get_cached_encryption_status,
            clear_encryption_cache,
            encrypt_config,
            unencrypt_config,
            change_config_password,
            set_config_password_env,
            clear_config_password_env,
            has_config_password_env,
            #[cfg(all(desktop, feature = "updater"))]
            fetch_update,
            #[cfg(all(desktop, feature = "updater"))]
            get_download_status,
            #[cfg(all(desktop, feature = "updater"))]
            install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
