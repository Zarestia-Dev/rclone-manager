use std::sync::{Arc, atomic::AtomicBool};

#[cfg(not(feature = "web-server"))]
use log::debug;
use log::{error, info};

#[cfg(feature = "web-server")]
use clap::Parser;
use tauri::Manager;
#[cfg(not(feature = "web-server"))]
use tauri::WindowEvent;
use tauri_plugin_store::StoreBuilder;
use tokio::sync::Mutex;

mod core;
mod rclone;
mod utils;

/// RClone Manager - Headless Web Server Mode
#[cfg(feature = "web-server")]
#[derive(Parser, Debug)]
#[command(name = "rclone-manager")]
#[command(about = "RClone Manager headless web server", long_about = None)]
struct CliArgs {
    /// Host address to bind to
    #[arg(
        short = 'H',
        long,
        env = "RCLONE_MANAGER_HOST",
        default_value = "0.0.0.0"
    )]
    host: String,

    /// Port to listen on
    #[arg(short, long, env = "RCLONE_MANAGER_PORT", default_value = "8080")]
    port: u16,

    /// Username for Basic Authentication (optional)
    #[arg(short, long, env = "RCLONE_MANAGER_USER")]
    user: Option<String>,

    /// Password for Basic Authentication (required if user is set)
    #[arg(long, env = "RCLONE_MANAGER_PASS")]
    pass: Option<String>,

    /// Path to TLS certificate file (optional)
    #[arg(long, env = "RCLONE_MANAGER_TLS_CERT")]
    tls_cert: Option<std::path::PathBuf>,

    /// Path to TLS key file (optional)
    #[arg(long, env = "RCLONE_MANAGER_TLS_KEY")]
    tls_key: Option<std::path::PathBuf>,
}

#[cfg(feature = "updater")]
use crate::utils::app::updater::app_updates::{DownloadState, PendingUpdate};
#[cfg(feature = "updater")]
use crate::utils::app::updater::app_updates::{fetch_update, get_download_status, install_update};

use crate::{
    core::{
        check_binaries::check_rclone_available,
        initialization::{init_rclone_state, initialization, setup_config_dir},
        lifecycle::{shutdown::handle_shutdown, startup::handle_startup},
        scheduler::{
            commands::{
                clear_all_scheduled_tasks, reload_scheduled_tasks, toggle_scheduled_task,
                validate_cron,
            },
            engine::CronScheduler,
        },
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
                restore_manager::restore_settings,
            },
            operations::core::{
                load_settings, load_startup_settings, reset_setting, reset_settings, save_setting,
            },
            rclone_backend::{
                get_rclone_backend_store_path, load_rclone_backend_options,
                remove_rclone_backend_option, reset_rclone_backend_options,
                save_rclone_backend_option, save_rclone_backend_options,
            },
            remote::manager::{delete_remote_settings, get_remote_settings, save_remote_settings},
        },
        tray::{
            actions::{
                handle_bisync_profile, handle_browse_in_app, handle_browse_remote,
                handle_copy_profile, handle_mount_profile, handle_move_profile,
                handle_serve_profile, handle_stop_all_jobs, handle_stop_all_serves,
                handle_stop_bisync_profile, handle_stop_copy_profile, handle_stop_move_profile,
                handle_stop_serve_profile, handle_stop_sync_profile, handle_sync_profile,
                handle_unmount_profile, show_main_window,
            },
            tray_action::TrayAction,
        },
    },
    rclone::{
        commands::{
            filesystem::{cleanup, copy_url, mkdir},
            job::stop_job,
            mount::{mount_remote_profile, unmount_all_remotes, unmount_remote},
            remote::{
                continue_create_remote_interactive, create_remote, create_remote_interactive,
                delete_remote, update_remote,
            },
            serve::{start_serve_profile, stop_all_serves, stop_serve},
            sync::{
                start_bisync_profile, start_copy_profile, start_move_profile, start_sync_profile,
            },
            system::{quit_rclone_oauth, set_bandwidth_limit},
        },
        queries::{
            convert_file_src,
            flags::{
                get_backend_flags, get_bisync_flags, get_copy_flags, get_filter_flags,
                get_flags_by_category, get_grouped_options_with_values, get_mount_flags,
                get_move_flags, get_option_blocks, get_serve_flags, get_sync_flags, get_vfs_flags,
                set_rclone_option,
            },
            get_about_remote, get_all_remote_configs, get_bandwidth_limit, get_completed_transfers,
            get_core_stats, get_core_stats_filtered, get_disk_usage, get_fs_info, get_local_drives,
            get_memory_stats, get_mount_types, get_mounted_remotes, get_oauth_supported_remotes,
            get_rclone_info, get_rclone_pid, get_remote_config, get_remote_paths, get_remote_types,
            get_remotes, get_serve_types, get_size, get_stat, list_serves, vfs_forget, vfs_list,
            vfs_poll_interval, vfs_queue, vfs_queue_set_expiry, vfs_refresh, vfs_stats,
        },
        state::{
            cache::{
                get_cached_mounted_remotes, get_cached_remotes, get_cached_serves, get_configs,
                get_settings, rename_mount_profile_in_cache, rename_serve_profile_in_cache,
            },
            engine::get_rclone_rc_url,
            job::{delete_job, get_active_jobs, get_job_status, get_jobs, rename_profile_in_cache},
            log::{clear_remote_logs, get_remote_logs},
            scheduled_tasks::{
                ScheduledTasksCache, get_scheduled_task, get_scheduled_tasks,
                get_scheduled_tasks_stats, reload_scheduled_tasks_from_configs,
            },
            watcher::{force_check_mounted_remotes, force_check_serves},
        },
    },
    utils::{
        app::{
            builder::create_app_window,
            platform::{are_updates_disabled, get_build_type, relaunch_app},
            ui::{get_system_theme, set_theme},
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
        types::{
            all_types::{JobCache, LogCache, RcloneState, RemoteCache},
            settings::SettingsState,
        },
    },
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Parse CLI args early when running in web-server mode so `--help`/`--version`
    // are handled before performing heavy initialization (rclone, stores, etc.).
    #[cfg(feature = "web-server")]
    let cli_args = CliArgs::parse();

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_shell::init());

    #[cfg(feature = "updater")]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    // 1. CONDITIONAL WINDOW EVENTS (Desktop Only)
    // We modify the builder variable directly here before the final chain
    #[cfg(not(feature = "web-server"))]
    {
        builder = builder.on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                let state = window.app_handle().state::<RcloneState>();

                let tray_enabled = match state.tray_enabled.read() {
                    Ok(enabled) => *enabled,
                    Err(_) => false,
                };

                let destroy_on_close = match state.destroy_window_on_close.read() {
                    Ok(enabled) => *enabled,
                    Err(_) => false,
                };

                if tray_enabled {
                    if destroy_on_close {
                        debug!("♻️ Optimization Enabled: Destroying window to free RAM");
                    } else {
                        if let Err(e) = window.hide() {
                            error!("Failed to hide window: {e}");
                        }
                        api.prevent_close();
                    }
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
        });
    }

    // 2. SETUP PLUGINS & HANDLERS
    #[cfg(not(feature = "flatpak"))]
    {
        builder = builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--tray"]),
        ));
    }

    builder = builder
        .plugin(tauri_plugin_single_instance::init(|_app, _, _| {
            #[cfg(feature = "web-server")]
            info!("Another instance attempted to run.");

            #[cfg(not(feature = "web-server"))]
            show_main_window(_app.clone());
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let app_handle = app.handle();
            let config_dir = setup_config_dir(app_handle)?;
            let store_path = config_dir.join("settings.json");

            let store = Mutex::new(
                StoreBuilder::new(&app_handle.clone(), store_path)
                    .build()
                    .map_err(|e| format!("Failed to create settings store: {e}"))?,
            );

            app.manage(SettingsState {
                store,
                config_dir: config_dir.clone(),
            });

            use crate::core::settings::rclone_backend::RCloneBackendStore;
            let rclone_backend_store = RCloneBackendStore::new(app_handle, &config_dir)
                .map_err(|e| format!("Failed to initialize RClone backend store: {e}"))?;
            app.manage(rclone_backend_store);

            use crate::core::security::{CredentialStore, SafeEnvironmentManager};
            let env_manager = SafeEnvironmentManager::new();
            let credential_store = CredentialStore::new();

            if let Err(e) = env_manager.init_with_stored_credentials(&credential_store) {
                error!("Failed to initialize environment manager with stored credentials: {e}");
            }

            app.manage(env_manager);
            app.manage(credential_store);

            let settings = load_startup_settings(&app.state::<SettingsState<tauri::Wry>>())
                .map_err(|e| format!("Failed to load startup settings: {e}"))?;

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
                destroy_window_on_close: Arc::new(std::sync::RwLock::new(
                    settings.developer.destroy_window_on_close,
                )),
                is_restart_required: AtomicBool::new(false),
                is_update_in_progress: AtomicBool::new(false),
                oauth_process: tokio::sync::Mutex::new(None),
            });

            app.manage(JobCache::new());
            app.manage(LogCache::new(1000));
            app.manage(ScheduledTasksCache::new());
            app.manage(CronScheduler::new());
            app.manage(RemoteCache::new());

            #[cfg(feature = "updater")]
            app.manage(PendingUpdate(std::sync::Mutex::new(None)));
            #[cfg(feature = "updater")]
            app.manage(DownloadState::default());

            // CONDITIONAL SHORTCUTS: Only if NOT running web server
            #[cfg(all(desktop, not(feature = "web-server")))]
            {
                use crate::utils::shortcuts::handle_global_shortcut_event;
                use log::info;
                use tauri_plugin_global_shortcut::{
                    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
                };

                let ctrl_q_shortcut = Shortcut::new(Some(Modifiers::CONTROL), Code::KeyQ);

                app_handle.plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, shortcut, event| {
                            if let ShortcutState::Pressed = event.state() {
                                handle_global_shortcut_event(app, *shortcut);
                            }
                        })
                        .build(),
                )?;

                match app_handle.global_shortcut().register(ctrl_q_shortcut) {
                    Ok(_) => info!("Successfully registered Ctrl+Q shortcut"),
                    Err(e) => error!("Failed to register Ctrl+Q shortcut: {e}"),
                }

                info!("🔗 Global shortcuts registered successfully");
            }

            init_logging(settings.developer.debug_logging, app_handle.clone())
                .map_err(|e| format!("Failed to initialize logging: {e}"))?;

            init_rclone_state(app_handle, &settings)
                .map_err(|e| format!("Rclone initialization failed: {e}"))?;

            let app_handle_clone = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                initialization(app_handle_clone.clone(), settings).await;
                handle_startup(app_handle_clone.clone()).await;
                monitor_network_changes(app_handle_clone).await;
            });

            // --- WEB SERVER STARTUP ---
            // Configuration via CLI arguments or environment variables:
            //   Command line options:
            //     -H, --host <HOST>           Host address to bind to [default: 0.0.0.0]
            //     -p, --port <PORT>           Port to listen on [default: 8080]
            //     -u, --user <USER>           Username for Basic Authentication
            //         --pass <PASS>           Password for Basic Authentication
            //         --tls-cert <PATH>       Path to TLS certificate file
            //         --tls-key <PATH>        Path to TLS key file
            //
            //   Environment variables (same names):
            //     RCLONE_MANAGER_HOST, RCLONE_MANAGER_PORT, RCLONE_MANAGER_USER,
            //     RCLONE_MANAGER_PASS, RCLONE_MANAGER_TLS_CERT, RCLONE_MANAGER_TLS_KEY
            //
            // Example usage:
            //   rclone-manager --port 3000
            //   rclone-manager -u admin --pass secret
            //   RCLONE_MANAGER_PORT=3000 rclone-manager
            #[cfg(feature = "web-server")]
            {
                use crate::core::server::start_web_server;

                let web_handle = app.handle().clone();
                let args = cli_args;

                info!(
                    "🚀 Initializing Web Server on {}:{}...",
                    args.host, args.port
                );
                if args.user.is_some() {
                    info!("🔐 Basic authentication enabled");
                }
                if args.tls_cert.is_some() && args.tls_key.is_some() {
                    info!("🔒 TLS/HTTPS enabled");
                }

                tauri::async_runtime::spawn(async move {
                    if let Err(e) = start_web_server(
                        web_handle,
                        args.host,
                        args.port,
                        args.user.zip(args.pass),
                        args.tls_cert,
                        args.tls_key,
                    )
                    .await
                    {
                        error!("❌ Web server failed to start: {e}");
                    }
                });
            }

            // --- WINDOW CREATION (Desktop Only) ---
            #[cfg(not(feature = "web-server"))]
            if !std::env::args().any(|arg| arg == "--tray") {
                debug!("Creating main window");
                create_app_window(app.handle().clone(), None);
            }

            Ok(())
        })
        .on_menu_event(|app, event| {
            if let Some(action) = TrayAction::from_id(event.id.as_ref()) {
                match action {
                    TrayAction::MountProfile(remote, profile) => {
                        handle_mount_profile(app.clone(), &remote, &profile)
                    }
                    TrayAction::UnmountProfile(remote, profile) => {
                        handle_unmount_profile(app.clone(), &remote, &profile)
                    }
                    TrayAction::SyncProfile(remote, profile) => {
                        handle_sync_profile(app.clone(), &remote, &profile)
                    }
                    TrayAction::StopSyncProfile(remote, profile) => {
                        handle_stop_sync_profile(app.clone(), &remote, &profile)
                    }
                    TrayAction::CopyProfile(remote, profile) => {
                        handle_copy_profile(app.clone(), &remote, &profile)
                    }
                    TrayAction::StopCopyProfile(remote, profile) => {
                        handle_stop_copy_profile(app.clone(), &remote, &profile)
                    }
                    TrayAction::MoveProfile(remote, profile) => {
                        handle_move_profile(app.clone(), &remote, &profile)
                    }
                    TrayAction::StopMoveProfile(remote, profile) => {
                        handle_stop_move_profile(app.clone(), &remote, &profile)
                    }
                    TrayAction::BisyncProfile(remote, profile) => {
                        handle_bisync_profile(app.clone(), &remote, &profile)
                    }
                    TrayAction::StopBisyncProfile(remote, profile) => {
                        handle_stop_bisync_profile(app.clone(), &remote, &profile)
                    }
                    TrayAction::ServeProfile(remote, profile) => {
                        handle_serve_profile(app.clone(), &remote, &profile)
                    }
                    TrayAction::StopServeProfile(remote, serve_id) => {
                        handle_stop_serve_profile(app.clone(), &remote, &serve_id)
                    }
                    TrayAction::Browse(remote) => handle_browse_remote(app, &remote),
                    TrayAction::BrowseInApp(remote) => handle_browse_in_app(app, &remote),
                }
                return;
            }

            match event.id.as_ref() {
                "show_app" => show_main_window(app.clone()),
                "stop_all_jobs" => handle_stop_all_jobs(app.clone()),
                "stop_all_serves" => handle_stop_all_serves(app.clone()),
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
                _ => {}
            }
        });

    // 3. CONDITIONAL INVOKE HANDLER (Desktop Only)
    // Only register IPC handlers when running in desktop mode with UI
    #[cfg(not(feature = "web-server"))]
    {
        builder = builder.invoke_handler(tauri::generate_handler![
            // File operations
            open_in_files,
            get_folder_location,
            get_file_location,
            // UI
            set_theme,
            get_system_theme,
            get_rclone_rc_url,
            // Platform
            get_build_type,
            are_updates_disabled,
            relaunch_app,
            // Rclone operations
            provision_rclone,
            get_rclone_info,
            get_rclone_pid,
            check_rclone_update,
            update_rclone,
            kill_process_by_pid,
            // Rclone Command API
            get_all_remote_configs,
            get_core_stats,
            get_core_stats_filtered,
            get_completed_transfers,
            get_fs_info,
            get_disk_usage,
            get_about_remote,
            get_size,
            get_stat,
            get_memory_stats,
            get_remotes,
            get_remote_config,
            get_remote_types,
            get_oauth_supported_remotes,
            get_mounted_remotes,
            set_bandwidth_limit,
            // Rclone Sync API
            start_sync_profile,
            start_copy_profile,
            start_bisync_profile,
            start_move_profile,
            // Rclone Mount API
            mount_remote_profile,
            unmount_remote,
            unmount_all_remotes,
            get_mount_types,
            // VFS Commands
            vfs_forget,
            vfs_list,
            vfs_poll_interval,
            vfs_refresh,
            vfs_stats,
            vfs_queue,
            vfs_queue_set_expiry,
            // Serve API
            start_serve_profile,
            stop_serve,
            stop_all_serves,
            get_serve_types,
            get_serve_flags,
            list_serves,
            // Remote management
            create_remote_interactive,
            continue_create_remote_interactive,
            create_remote,
            update_remote,
            delete_remote,
            quit_rclone_oauth,
            get_remote_paths,
            // Filesystem commands
            mkdir,
            cleanup,
            copy_url,
            convert_file_src,
            get_local_drives,
            get_bandwidth_limit,
            // Flags
            get_option_blocks,
            get_flags_by_category,
            get_copy_flags,
            get_sync_flags,
            get_bisync_flags,
            get_move_flags,
            get_filter_flags,
            get_vfs_flags,
            get_mount_flags,
            get_backend_flags,
            get_grouped_options_with_values,
            set_rclone_option,
            // Settings
            load_settings,
            save_setting,
            reset_settings,
            reset_setting,
            // RClone Backend Settings
            load_rclone_backend_options,
            save_rclone_backend_options,
            save_rclone_backend_option,
            reset_rclone_backend_options,
            get_rclone_backend_store_path,
            remove_rclone_backend_option,
            // Remote Settings
            save_remote_settings,
            get_remote_settings,
            delete_remote_settings,
            backup_settings,
            analyze_backup_file,
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
            get_cached_serves,
            rename_mount_profile_in_cache,
            rename_serve_profile_in_cache,
            // Binaries
            check_rclone_available,
            // Logs
            get_remote_logs,
            clear_remote_logs,
            // Jobs
            get_jobs,
            get_active_jobs,
            get_job_status,
            stop_job,
            delete_job,
            rename_profile_in_cache,
            // Scheduled Tasks (Now require state)
            get_scheduled_tasks,
            get_scheduled_task,
            get_scheduled_tasks_stats,
            toggle_scheduled_task,
            validate_cron,
            reload_scheduled_tasks,
            reload_scheduled_tasks_from_configs,
            clear_all_scheduled_tasks,
            // Mount
            force_check_mounted_remotes,
            force_check_serves,
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
            #[cfg(feature = "updater")]
            fetch_update,
            #[cfg(feature = "updater")]
            get_download_status,
            #[cfg(feature = "updater")]
            install_update,
        ]);
    }

    // 4. BUILD AND RUN
    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    #[cfg(feature = "web-server")]
    {
        // Headless Loop: Keeps running until Ctrl+C or kill signal, ignoring window logic
        info!("🎯 Tauri event loop starting (Web Server Mode)");
        app.run(|_app_handle, _event| {});
    }

    #[cfg(not(feature = "web-server"))]
    {
        // Desktop Loop: Handles exit requests triggered by window events
        app.run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                // If tray is enabled, we generally prevent exit unless explicitly shutting down
                let state = app_handle.state::<RcloneState>();
                if !state.is_shutting_down() {
                    api.prevent_exit();

                    #[cfg(target_os = "linux")]
                    {
                        std::thread::spawn(|| {
                            std::thread::sleep(std::time::Duration::from_millis(1000));
                            utils::process::process_manager::cleanup_webkit_zombies();
                        });
                    }
                }
            }
        });
    }
}
