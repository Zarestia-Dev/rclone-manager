// =============================================================================
// RCLONE MANAGER - MAIN LIBRARY ENTRY POINT
// =============================================================================

// =============================================================================
// STANDARD LIBRARY & EXTERNAL CRATES
// =============================================================================
use log::{debug, error, info};
use rcman::JsonSettingsManager;
use std::sync::atomic::AtomicBool;
use tauri::Manager;

#[cfg(feature = "web-server")]
use clap::Parser;
#[cfg(not(feature = "web-server"))]
use tauri::WindowEvent;

// =============================================================================
// INTERNAL MODULES
// =============================================================================
mod core;
mod rclone;
mod utils;

#[cfg(feature = "web-server")]
mod server;

// =============================================================================
// SHARED IMPORTS (Both modes)
// =============================================================================
use crate::rclone::state::scheduled_tasks::ScheduledTasksCache;
use crate::utils::logging::log::init_logging;
use crate::{
    core::{
        initialization::{init_rclone_state, initialization},
        lifecycle::{shutdown::handle_shutdown, startup::handle_startup},
        paths::AppPaths,
        scheduler::engine::CronScheduler,
        settings::operations::core::load_startup_settings,
    },
    utils::types::{
        core::{RcApiEngine, RcloneState},
        logs::LogCache,
    },
};

// =============================================================================
// CONDITIONAL IMPORTS: Updater
// =============================================================================
#[cfg(all(desktop, feature = "updater"))]
use crate::utils::app::updater::app_updates::{DownloadState, PendingUpdate};

// =============================================================================
// CONDITIONAL IMPORTS: Desktop Tray
// =============================================================================
#[cfg(desktop)]
use crate::core::tray::{
    actions::{
        handle_bisync_profile, handle_browse_remote, handle_copy_profile, handle_mount_profile,
        handle_move_profile, handle_serve_profile, handle_stop_all_jobs, handle_stop_all_serves,
        handle_stop_bisync_profile, handle_stop_copy_profile, handle_stop_move_profile,
        handle_stop_serve_profile, handle_stop_sync_profile, handle_sync_profile,
        handle_unmount_profile,
    },
    tray_action::TrayAction,
};

#[cfg(all(desktop, not(feature = "web-server")))]
use crate::utils::app::builder::create_app_window;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::utils::io::network::monitor_network_changes;

// =============================================================================
// MAIN ENTRY POINT
// =============================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // -------------------------------------------------------------------------
    // Parse CLI args (web-server mode only)
    // -------------------------------------------------------------------------
    #[cfg(feature = "web-server")]
    let cli_args = crate::core::cli::CliArgs::parse();

    // -------------------------------------------------------------------------
    // Initialize Tauri Builder
    // -------------------------------------------------------------------------
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_shell::init());

    // -------------------------------------------------------------------------
    // Updater Plugin (Desktop + Updater feature)
    // -------------------------------------------------------------------------
    #[cfg(all(desktop, feature = "updater"))]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    // -------------------------------------------------------------------------
    // Window Events (Desktop only, not web-server)
    // -------------------------------------------------------------------------
    #[cfg(not(feature = "web-server"))]
    {
        builder = builder.on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                let app_handle = window.app_handle();

                // Read settings from JsonSettingsManager which caches internally
                let (tray_enabled, destroy_on_close) = app_handle
                    .try_state::<rcman::JsonSettingsManager>()
                    .and_then(|manager| {
                        manager
                            .inner()
                            .settings::<crate::core::settings::schema::AppSettings>()
                            .ok()
                            .map(|s| (s.general.tray_enabled, s.developer.destroy_window_on_close))
                    })
                    .unwrap_or((false, false));

                if tray_enabled {
                    if destroy_on_close {
                        debug!("♻️ Optimization Enabled: Destroying window to free RAM");
                    } else {
                        #[cfg(desktop)]
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
            #[cfg(desktop)]
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

    // -------------------------------------------------------------------------
    // Autostart Plugin (Desktop, non-Flatpak)
    // -------------------------------------------------------------------------
    #[cfg(all(desktop, not(feature = "flatpak")))]
    {
        builder = builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--tray"]),
        ));
    }

    // -------------------------------------------------------------------------
    // Single Instance Plugin (Desktop)
    // -------------------------------------------------------------------------
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|_app, _, _| {
            #[cfg(feature = "web-server")]
            info!("Another instance attempted to run.");

            #[cfg(not(feature = "web-server"))]
            core::tray::actions::show_main_window(_app.clone());
        }));
    }

    // -------------------------------------------------------------------------
    // Core Plugins & Setup
    // -------------------------------------------------------------------------
    builder = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            setup_app(
                app,
                #[cfg(feature = "web-server")]
                cli_args,
            )
        });

    // -------------------------------------------------------------------------
    // Tray Menu Events (Desktop)
    // -------------------------------------------------------------------------
    #[cfg(desktop)]
    {
        builder = builder.on_menu_event(handle_tray_menu_event);
    }

    // -------------------------------------------------------------------------
    // Invoke Handler (Desktop mode only)
    // -------------------------------------------------------------------------
    #[cfg(not(feature = "web-server"))]
    {
        builder = builder.invoke_handler(generate_invoke_handler!());
    }

    // -------------------------------------------------------------------------
    // Build and Run
    // -------------------------------------------------------------------------
    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    #[cfg(feature = "web-server")]
    {
        info!("🎯 Tauri event loop starting (Web Server Mode)");
        app.run(|_app_handle, _event| {});
    }

    #[cfg(not(feature = "web-server"))]
    {
        app.run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
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

// =============================================================================
// SETUP FUNCTION
// =============================================================================

fn setup_app(
    app: &mut tauri::App,
    #[cfg(feature = "web-server")] cli_args: crate::core::cli::CliArgs,
) -> Result<(), Box<dyn std::error::Error>> {
    let app_handle = app.handle();
    let config_dir = AppPaths::setup(app_handle)?;

    // -------------------------------------------------------------------------
    // Initialize rcman Settings Manager
    // -------------------------------------------------------------------------
    let rcman_manager: JsonSettingsManager =
        rcman::SettingsManager::builder(env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"))
            .config_dir(&config_dir)
            .with_credentials()
            .with_migrator(|mut value: serde_json::Value| {
                if let Some(root) = value.as_object_mut()
                    && let Some(app_settings) = root.remove("app_settings")
                {
                    log::info!("found legacy app_settings, flattening to root");
                    if let Some(app_settings_obj) = app_settings.as_object() {
                        for (k, v) in app_settings_obj {
                            if !root.contains_key(k) {
                                root.insert(k.clone(), v.clone());
                            }
                        }
                    }
                }
                value
            })
            .with_sub_settings(
                rcman::SubSettingsConfig::new("remotes").with_migrator(
                    crate::core::settings::remote::manager::migrate_to_multi_profile,
                ),
            )
            .with_sub_settings(
                rcman::SubSettingsConfig::new("backend")
                    .single_file()
                    .with_migrator(|mut value: serde_json::Value| {
                        if let Some(root) = value.as_object_mut()
                            && let Some(backend_settings) = root.remove("backend")
                        {
                            log::info!("found legacy backend settings, flattening to root");
                            if let Some(backend_obj) = backend_settings.as_object() {
                                for (k, v) in backend_obj {
                                    if !root.contains_key(k) {
                                        root.insert(k.clone(), v.clone());
                                    }
                                }
                            }
                        }
                        value
                    }),
            )
            .with_sub_settings(rcman::SubSettingsConfig::new("connections").single_file())
            .build()
            .map_err(|e| format!("Failed to create rcman settings manager: {e}"))?;

    // -------------------------------------------------------------------------
    // Load Settings & Initialize State
    // -------------------------------------------------------------------------
    let settings = load_startup_settings(&rcman_manager)
        .map_err(|e| format!("Failed to load startup settings: {e}"))?;

    use crate::core::security::SafeEnvironmentManager;
    let env_manager = SafeEnvironmentManager::new();

    if let Err(e) = env_manager.init_with_stored_credentials(&rcman_manager) {
        error!("Failed to initialize environment manager with stored credentials: {e}");
    }

    // -------------------------------------------------------------------------
    // Initialize Backend i18n (before managing rcman_manager)
    // -------------------------------------------------------------------------
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        crate::utils::i18n::init(resource_dir);

        // Set initial language from settings
        if let Ok(lang) = rcman_manager.get::<String>("general.language") {
            crate::utils::i18n::set_language(&lang);
        }
    }

    // -------------------------------------------------------------------------
    // Manage App State
    // -------------------------------------------------------------------------
    app.manage(tokio::sync::Mutex::new(RcApiEngine::default()));
    app.manage(rcman_manager);
    app.manage(env_manager);

    // Note: Settings like tray_enabled, notifications_enabled, restrict_mode,
    // rclone_path are now read from JsonSettingsManager
    app.manage(RcloneState {
        client: reqwest::Client::new(),
        is_shutting_down: AtomicBool::new(false),
        is_restart_required: AtomicBool::new(false),
        is_update_in_progress: AtomicBool::new(false),
        oauth_process: tokio::sync::Mutex::new(None),
    });

    app.manage(LogCache::new(1000));
    app.manage(ScheduledTasksCache::new());
    app.manage(CronScheduler::new());

    #[cfg(all(desktop, feature = "updater"))]
    app.manage(PendingUpdate(std::sync::Mutex::new(None)));
    #[cfg(all(desktop, feature = "updater"))]
    app.manage(DownloadState::default());

    // -------------------------------------------------------------------------
    // Global Shortcuts (Desktop, non-web-server)
    // -------------------------------------------------------------------------
    #[cfg(all(desktop, not(feature = "web-server")))]
    {
        use crate::utils::shortcuts::handle_global_shortcut_event;
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

    // -------------------------------------------------------------------------
    // Initialize Logging & Rclone
    // -------------------------------------------------------------------------
    init_logging(
        &settings.developer.log_level,
        app_handle.clone(),
        &config_dir,
    )
    .map_err(|e| format!("Failed to initialize logging: {e}"))?;

    init_rclone_state(app_handle).map_err(|e| format!("Rclone initialization failed: {e}"))?;

    // -------------------------------------------------------------------------
    // Async Initialization
    // -------------------------------------------------------------------------
    let app_handle_clone = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        initialization(app_handle_clone.clone()).await;
        let force_tray = std::env::args().any(|arg| arg == "--tray");
        if settings.general.tray_enabled || force_tray {
            if force_tray {
                debug!("🧊 Setting up tray (forced by --tray argument)");
            } else {
                debug!("🧊 Setting up tray (enabled in settings)");
            }
            if let Err(e) = utils::app::builder::setup_tray(
                app_handle_clone.clone(),
                settings.core.max_tray_items,
            )
            .await
            {
                error!("Failed to setup tray: {e}");
            }
        }

        handle_startup(app_handle_clone.clone()).await;

        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        monitor_network_changes(app_handle_clone).await;
    });

    // -------------------------------------------------------------------------
    // Web Server Startup (web-server mode only)
    // -------------------------------------------------------------------------
    #[cfg(feature = "web-server")]
    {
        use crate::server::start_web_server;

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

    // -------------------------------------------------------------------------
    // Window Creation (Desktop, non-web-server)
    // -------------------------------------------------------------------------
    #[cfg(all(desktop, not(feature = "web-server")))]
    if !std::env::args().any(|arg| arg == "--tray") {
        debug!("Creating main window");
        create_app_window(app.handle().clone(), None);
    }

    Ok(())
}

// =============================================================================
// TRAY MENU EVENT HANDLER
// =============================================================================

#[cfg(desktop)]
fn handle_tray_menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    use crate::rclone::commands::mount::unmount_all_remotes;

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
            #[cfg(not(feature = "web-server"))]
            TrayAction::BrowseInApp(remote) => {
                core::tray::actions::handle_browse_in_app(app, &remote)
            }
            TrayAction::UnmountAll => {
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
            TrayAction::StopAllJobs => handle_stop_all_jobs(app.clone()),
            TrayAction::StopAllServes => handle_stop_all_serves(app.clone()),
        }
        return;
    }

    match event.id.as_ref() {
        #[cfg(not(feature = "web-server"))]
        "show_app" => core::tray::actions::show_main_window(app.clone()),
        "quit" => {
            let app_clone = app.clone();
            tauri::async_runtime::spawn(async move {
                app_clone.state::<RcloneState>().set_shutting_down();
                handle_shutdown(app_clone).await;
            });
        }
        _ => {}
    }
}
