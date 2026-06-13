// =============================================================================
// RCLONE MANAGER - MAIN LIBRARY ENTRY POINT
// =============================================================================

// =============================================================================
// STANDARD LIBRARY & EXTERNAL CRATES
// =============================================================================

use std::sync::atomic::AtomicBool;
use tauri::Manager;

use clap::Parser;
#[cfg(not(feature = "web-server"))]
use tauri::WindowEvent;

// =============================================================================
// INTERNAL MODULES
// =============================================================================
mod core;
mod rclone;
pub mod utils;

#[cfg(feature = "web-server")]
mod server;

// =============================================================================
// SHARED IMPORTS (Both modes)
// =============================================================================
use crate::rclone::state::automations::AutomationsCache;
use crate::{
    core::{
        alerts::AlertHistoryCache, automation::engine::AutomationScheduler,
        initialization::initialization, paths::AppPaths,
    },
    utils::types::{
        logs::LogCache,
        state::{RcApiEngine, RcloneState},
        updater::{AppUpdaterState, RcloneUpdaterState},
    },
};

// =============================================================================
// CONDITIONAL IMPORTS: Desktop Tray
// =============================================================================
#[cfg(all(desktop, feature = "tray", not(feature = "web-server")))]
use crate::core::tray::actions::handle_browse_remote;
#[cfg(all(desktop, feature = "tray"))]
use crate::core::tray::{
    actions::{
        handle_mount_profile, handle_serve_profile, handle_start_job_profile, handle_stop_all_jobs,
        handle_stop_job_profile, handle_stop_serve_profile, handle_unmount_profile,
    },
    tray_action::TrayAction,
};

// =============================================================================
// MAIN ENTRY POINT
// =============================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // -------------------------------------------------------------------------
    // Parse CLI args
    // -------------------------------------------------------------------------
    let cli_args: crate::core::cli::CliArgs = match crate::core::cli::CliArgs::try_parse() {
        Ok(args) => {
            if let Err(e) = args.validate() {
                eprintln!("❌ Invalid CLI arguments: {e}");
                std::process::exit(1);
            }
            args
        }
        Err(e) => e.exit(),
    };

    // -------------------------------------------------------------------------
    // Initialize Tauri Builder
    // -------------------------------------------------------------------------
    let mut builder = tauri::Builder::default();

    builder = builder.manage(cli_args.clone());

    // -------------------------------------------------------------------------
    // Custom Protocols (Desktop)
    // -------------------------------------------------------------------------
    #[cfg(not(feature = "web-server"))]
    {
        builder = crate::utils::app::protocol::register_protocols(builder);
    }

    // -------------------------------------------------------------------------
    // Single Instance Plugin (Desktop)
    // -------------------------------------------------------------------------
    #[cfg(desktop)]
    {
        // The only platform difference is the D-Bus service ID required on Linux.
        // The callback itself is identical — deduplicate with a cfg inside the builder.
        let si_builder = tauri_plugin_single_instance::Builder::new();

        #[cfg(target_os = "linux")]
        let si_builder = si_builder.dbus_id(if cfg!(debug_assertions) {
            "io.github.zarestia_dev.rclone-manager-dev"
        } else {
            "io.github.zarestia_dev.rclone-manager"
        });

        builder = builder.plugin(
            si_builder
                .callback(|_app: &tauri::AppHandle, _, _| {
                    #[cfg(feature = "web-server")]
                    log::info!("Another instance attempted to run.");

                    #[cfg(not(feature = "web-server"))]
                    {
                        let app_clone = _app.clone();
                        tauri::async_runtime::spawn(async move {
                            // Give the second instance a moment to exit and release the IPC pipe
                            // to prevent a WebView/Windows focus deadlock.
                            tokio::time::sleep(std::time::Duration::from_millis(100)).await;

                            let app_for_main = app_clone.clone();
                            let _ = app_clone.run_on_main_thread(move || {
                                if let Some(window) = app_for_main.get_webview_window("main") {
                                    log::info!(
                                        "📢 Second instance detected, showing existing window"
                                    );
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                } else {
                                    log::info!(
                                        "📢 Second instance detected, but window was destroyed. \
                                         Recreating main window."
                                    );
                                    crate::utils::app::builder::create_app_window(
                                        app_for_main.clone(),
                                    );
                                    if let Some(window) = app_for_main.get_webview_window("main") {
                                        let _ = window.set_focus();
                                    }
                                }
                            });
                        });
                    }
                })
                .build(),
        );
    }

    // -------------------------------------------------------------------------
    // Updater Plugin (Desktop)
    // -------------------------------------------------------------------------
    #[cfg(desktop)]
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

                let destroy_on_close = app_handle
                    .try_state::<core::settings::AppSettingsManager>()
                    .and_then(|manager| {
                        manager
                            .get_all()
                            .ok()
                            .map(|s| s.developer.destroy_window_on_close)
                    })
                    .unwrap_or(false);

                #[cfg(feature = "tray")]
                let tray_enabled = app_handle
                    .try_state::<core::settings::AppSettingsManager>()
                    .and_then(|manager| manager.get_all().ok().map(|s| s.general.tray_enabled))
                    .unwrap_or(false);

                #[cfg(not(feature = "tray"))]
                let tray_enabled = false;

                if window.label() == "main" {
                    if tray_enabled {
                        if destroy_on_close {
                            log::debug!("♻️ Optimization Enabled: Destroying window to free RAM");
                        } else {
                            #[cfg(desktop)]
                            if let Err(e) = window.hide() {
                                log::error!("Failed to hide window: {e}");
                            }
                            api.prevent_close();
                        }
                        #[cfg(target_os = "macos")]
                        crate::utils::app::platform::update_macos_dock_visibility(app_handle);
                    } else {
                        api.prevent_close();
                        let window_ = window.clone();
                        tauri::async_runtime::spawn(async move {
                            window_
                                .app_handle()
                                .state::<RcloneState>()
                                .set_shutting_down();
                            let _ = core::lifecycle::shutdown::shutdown_app(
                                window_.app_handle().clone(),
                            )
                            .await;
                        });
                    }
                } else {
                    // Allow the OS to naturally destroy secondary windows like modals
                }
            }
            WindowEvent::Destroyed => {
                #[cfg(target_os = "macos")]
                crate::utils::app::platform::update_macos_dock_visibility(window.app_handle());
            }
            #[cfg(desktop)]
            WindowEvent::Focused(true) => {
                #[cfg(target_os = "macos")]
                crate::utils::app::platform::update_macos_dock_visibility(window.app_handle());
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
    // Core Plugins & Setup
    // -------------------------------------------------------------------------
    builder = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(feature = "desktop")]
    {
        builder = builder
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_shell::init())
            .plugin(tauri_plugin_clipboard_manager::init())
            .plugin(tauri_plugin_window_state::Builder::default().build());
    }

    builder = builder.setup(move |app| setup_app(app, cli_args.clone()));

    // -------------------------------------------------------------------------
    // Tray Menu Events (Desktop + Tray)
    // -------------------------------------------------------------------------
    #[cfg(all(desktop, feature = "tray"))]
    {
        builder = builder.on_menu_event(|app, event| handle_tray_menu_event(app, &event));
    }

    // -------------------------------------------------------------------------
    // Invoke Handler (Desktop mode only)
    // -------------------------------------------------------------------------
    #[cfg(not(feature = "web-server"))]
    {
        builder = builder.invoke_handler(crate::core::commands::dispatch_invoke);
    }

    // -------------------------------------------------------------------------
    // Build and Run
    // -------------------------------------------------------------------------
    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    #[cfg(feature = "web-server")]
    {
        log::info!("🎯 Tauri event loop starting (Web Server Mode)");
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
    cli_args: crate::core::cli::CliArgs,
) -> Result<(), Box<dyn std::error::Error>> {
    let app_handle = app.handle();

    let app_paths = AppPaths::setup(app_handle)?;

    let rcman_manager =
        crate::core::settings::manager::create_settings_manager(&app_paths.config_dir)?;

    use crate::core::security::SafeEnvironmentManager;
    let env_manager = SafeEnvironmentManager::new();

    use crate::rclone::backend::BackendManager;
    let backend_manager = BackendManager::new();

    // -------------------------------------------------------------------------
    // Manage App State
    // -------------------------------------------------------------------------
    app.manage(app_paths);
    app.manage(backend_manager);
    app.manage(env_manager);
    app.manage(rcman_manager);

    app.manage(tokio::sync::Mutex::new(RcApiEngine::default()));
    app.manage(RcloneState {
        client: reqwest::Client::new(),
        is_shutting_down: AtomicBool::new(false),
        oauth_process: tokio::sync::Mutex::new(None),
        poller_running: AtomicBool::new(false),
        poller_visible: AtomicBool::new(true),
        initial_startup: AtomicBool::new(true),
        updater_running: AtomicBool::new(false),
    });

    app.manage(LogCache::new(1000));
    app.manage(AutomationsCache::new());
    app.manage(AutomationScheduler::new());
    app.manage(crate::core::automation::watcher::WatcherManager::new());
    app.manage(core::alerts::dispatch::DispatchContext::new());

    app.manage(AppUpdaterState::default());
    app.manage(RcloneUpdaterState::default());
    #[cfg(all(desktop, feature = "tray"))]
    app.manage(crate::core::tray::TrayMenuState::default());

    let history_cache = AlertHistoryCache::new(10000);
    app.manage(history_cache);

    let alert_cache = core::alerts::cache::AlertRuleCache::new(
        app.state::<core::settings::AppSettingsManager>().inner(),
    );
    app.manage(alert_cache);

    // -------------------------------------------------------------------------
    // Async Initialization (Phased Flow)
    // -------------------------------------------------------------------------
    let app_handle_clone = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        initialization(app_handle_clone).await;
    });

    // -------------------------------------------------------------------------
    // Web Server Startup (web-server mode only)
    // -------------------------------------------------------------------------
    #[cfg(feature = "web-server")]
    {
        use crate::server::start_web_server;

        let web_handle = app.handle().clone();
        let args = cli_args.clone();

        log::info!(
            "🚀 Initializing Web Server on {}:{}...",
            args.headless.host,
            args.headless.port
        );

        tauri::async_runtime::spawn(async move {
            if let Err(e) = start_web_server(
                web_handle.clone(),
                args.headless.host.clone(),
                args.headless.port,
                args.auth_credentials(),
                args.headless.tls_cert.clone(),
                args.headless.tls_key.clone(),
            )
            .await
            {
                let msg = e.to_string();
                if msg.contains("address already in use")
                    || msg.contains("os error 98")
                    || msg.contains("os error 48")
                {
                    log::error!(
                        "❌ Port {} is already in use — another instance may be running. \
                         Shutting down.",
                        args.headless.port
                    );
                } else {
                    log::error!("❌ Web server failed to start: {e:#}");
                }
                web_handle.exit(1);
            }
        });
    }

    // -------------------------------------------------------------------------
    // Window Creation (Desktop, non-web-server)
    // -------------------------------------------------------------------------
    #[cfg(all(desktop, not(feature = "web-server"), feature = "tray"))]
    if !cli_args.general.tray {
        log::debug!("Creating main window");
        utils::app::builder::create_app_window(app.handle().clone());
    }

    #[cfg(target_os = "macos")]
    crate::utils::app::platform::update_macos_dock_visibility(app.handle());

    Ok(())
}

// =============================================================================
// TRAY MENU EVENT HANDLER
// =============================================================================

#[cfg(all(desktop, feature = "tray"))]
fn handle_tray_menu_event(app: &tauri::AppHandle, event: &tauri::menu::MenuEvent) {
    if let Some(action) = TrayAction::from_id(event.id.as_ref()) {
        dispatch_tray_action(app, action);
    }
}

#[cfg(all(desktop, feature = "tray"))]
fn dispatch_tray_action(app: &tauri::AppHandle, action: TrayAction) {
    use crate::rclone::commands::sync::TransferType;
    use crate::utils::types::jobs::JobType;

    #[cfg(feature = "web-server")]
    use tauri_plugin_opener::OpenerExt;

    match action {
        TrayAction::MountProfile(remote, profile) => {
            handle_mount_profile(app.clone(), &remote, &profile);
        }
        TrayAction::UnmountProfile(remote, profile) => {
            handle_unmount_profile(app.clone(), &remote, &profile);
        }
        TrayAction::SyncProfile(remote, profile) => {
            handle_start_job_profile(app.clone(), &remote, &profile, TransferType::Sync);
        }
        TrayAction::StopSyncProfile(remote, profile) => {
            handle_stop_job_profile(app.clone(), &remote, &profile, JobType::Sync);
        }
        TrayAction::CopyProfile(remote, profile) => {
            handle_start_job_profile(app.clone(), &remote, &profile, TransferType::Copy);
        }
        TrayAction::StopCopyProfile(remote, profile) => {
            handle_stop_job_profile(app.clone(), &remote, &profile, JobType::Copy);
        }
        TrayAction::MoveProfile(remote, profile) => {
            handle_start_job_profile(app.clone(), &remote, &profile, TransferType::Move);
        }
        TrayAction::StopMoveProfile(remote, profile) => {
            handle_stop_job_profile(app.clone(), &remote, &profile, JobType::Move);
        }
        TrayAction::BisyncProfile(remote, profile) => {
            handle_start_job_profile(app.clone(), &remote, &profile, TransferType::Bisync);
        }
        TrayAction::StopBisyncProfile(remote, profile) => {
            handle_stop_job_profile(app.clone(), &remote, &profile, JobType::Bisync);
        }
        TrayAction::ServeProfile(remote, profile) => {
            handle_serve_profile(app.clone(), &remote, &profile);
        }
        TrayAction::StopServeProfile(_remote, serve_id) => {
            handle_stop_serve_profile(app.clone(), &serve_id);
        }
        TrayAction::Browse(_remote) => {
            #[cfg(not(feature = "web-server"))]
            handle_browse_remote(app, &_remote);
        }
        TrayAction::BrowseInApp(remote) => {
            #[cfg(not(feature = "web-server"))]
            core::tray::actions::handle_browse_in_app(app, Some(&remote));

            #[cfg(feature = "web-server")]
            {
                let url = web_ui_url(app, &format!("/nautilus/{}", urlencoding::encode(&remote)));
                if let Err(e) = app.opener().open_url(&url, None::<&str>) {
                    log::error!("Failed to open web UI for browsing: {e}");
                }
            }
        }
        TrayAction::UnmountAll => {
            let app_clone = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = rclone::commands::mount::unmount_all_remotes(
                    app_clone.clone(),
                    rclone::commands::common::OperationContext::Normal,
                )
                .await
                {
                    log::error!("Failed to unmount all remotes: {e}");
                }
            });
        }
        TrayAction::StopAllJobs => handle_stop_all_jobs(app.clone()),
        TrayAction::StopAllServes => {
            let app_clone = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = rclone::commands::serve::stop_all_serves(
                    app_clone.clone(),
                    rclone::commands::common::OperationContext::Normal,
                )
                .await
                {
                    log::error!("Failed to stop all serves: {e}");
                }
            });
        }
        TrayAction::OpenFileBrowser => {
            #[cfg(not(feature = "web-server"))]
            core::tray::actions::handle_browse_in_app(app, None);

            #[cfg(feature = "web-server")]
            {
                let url = web_ui_url(app, "/nautilus");
                if let Err(e) = app.opener().open_url(&url, None::<&str>) {
                    log::error!("Failed to open web UI for file browser: {e}");
                }
            }
        }
        TrayAction::ShowApp => {
            #[cfg(not(feature = "web-server"))]
            core::tray::actions::show_main_window(app.clone());
        }
        TrayAction::OpenWebUI => {
            #[cfg(feature = "web-server")]
            {
                let url = web_ui_url(app, "");
                if let Err(e) = app.opener().open_url(&url, None::<&str>) {
                    log::error!("Failed to open web UI: {e}");
                }
            }
        }
        TrayAction::Quit => {
            let app_clone = app.clone();
            tauri::async_runtime::spawn(async move {
                app_clone.state::<RcloneState>().set_shutting_down();
                let _ = core::lifecycle::shutdown::shutdown_app(app_clone).await;
            });
        }
    }
}

/// Build the web UI URL for a given path, resolving 0.0.0.0 to loopback.
///
/// Used by tray actions to open the web interface in the system browser.
#[cfg(all(feature = "web-server", feature = "tray"))]
fn web_ui_url(app: &tauri::AppHandle, path: &str) -> String {
    let args = app.state::<crate::core::cli::CliArgs>();
    let host = if args.headless.host == "0.0.0.0" {
        "127.0.0.1"
    } else {
        &args.headless.host
    };
    let scheme = if args.headless.tls_cert.is_some() {
        "https"
    } else {
        "http"
    };
    format!("{scheme}://{host}:{}{path}", args.headless.port)
}
