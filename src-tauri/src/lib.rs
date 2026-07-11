mod core;
mod rclone;
pub mod utils;

#[cfg(feature = "web-server")]
mod server;

use std::sync::{Arc, atomic::AtomicBool};

use clap::Parser;
use tauri::Manager;
#[cfg(not(feature = "web-server"))]
use tauri::WindowEvent;

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
use crate::rclone::state::automations::AutomationsCache;
use crate::{
    core::{
        alerts::AlertHistoryCache, automation::engine::AutomationScheduler,
        initialization::initialization, paths::AppPaths,
    },
    rclone::commands::upload::{UploadBatchParams, execute_upload_batch},
    utils::types::{
        logs::LogCache,
        state::{RcApiEngine, RcloneState},
    },
};

fn build_send_to_params(
    remote: String,
    path: Option<String>,
    sources: Vec<std::path::PathBuf>,
    cwd: Option<&std::path::Path>,
) -> UploadBatchParams {
    let local_paths = sources
        .into_iter()
        .map(|p| match cwd {
            Some(base) if p.is_relative() => base.join(p),
            _ => p,
        })
        .map(|p| p.to_string_lossy().to_string())
        .collect();

    UploadBatchParams {
        remote,
        path: path.unwrap_or_default(),
        local_paths,
        origin: Some(crate::utils::types::origin::Origin::FileManager),
        group: Some("send_to".to_string()),
        cleanup_dir: None,
        existing_jobid: None,
        no_cache: false,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cli_args: crate::core::cli::CliArgs = match crate::core::cli::CliArgs::try_parse() {
        Ok(args) => {
            if let Err(e) = args.validate() {
                eprintln!("Invalid CLI arguments: {e}");
                std::process::exit(1);
            }
            args
        }
        Err(e) => e.exit(),
    };

    let mut builder = tauri::Builder::default();
    builder = builder.manage(cli_args.clone());

    #[cfg(not(feature = "web-server"))]
    {
        builder = crate::utils::app::protocol::register_protocols(builder);
    }

    #[cfg(desktop)]
    {
        let si_builder = tauri_plugin_single_instance::Builder::new();

        #[cfg(target_os = "linux")]
        let si_builder = si_builder.dbus_id(if cfg!(debug_assertions) {
            crate::utils::app::platform::APP_ID_DEV
        } else {
            crate::utils::app::platform::APP_ID
        });

        builder = builder.plugin(
            si_builder
                .callback(|app: &tauri::AppHandle, argv, cwd| {
                    if let Ok(cli_args) = <crate::core::cli::CliArgs as clap::Parser>::try_parse_from(&argv) && let Some(remote) = cli_args.general.send_to_remote {
                            let path = cli_args.general.send_to_path;
                            let sources = cli_args.general.send_to_sources;
                            let app_handle_clone = app.clone();
                            let cwd_path = std::path::PathBuf::from(cwd);
                            tauri::async_runtime::spawn(async move {
                                let params = build_send_to_params(remote, path, sources, Some(&cwd_path));

                                log::info!(
                                    "Executing SendTo transfer in running instance: {:?} -> {}:{}",
                                    params.local_paths, params.remote, params.path
                                );
                                match execute_upload_batch(app_handle_clone, params).await {
                                    Ok(jobid) => {
                                        log::info!("SendTo transfer initiated successfully in running instance. Job ID: {jobid}");
                                    }
                                    Err(e) => {
                                        log::error!("SendTo transfer failed in running instance: {e}");
                                    }
                                }
                            });
                            return;
                    }

                    #[cfg(feature = "web-server")]
                    log::info!("Another instance attempted to run with args: {argv:?}");

                    #[cfg(not(feature = "web-server"))]
                    {
                        let app_clone = app.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_millis(100)).await;

                            let app_for_main = app_clone.clone();
                            let _ = app_clone.run_on_main_thread(move || {
                                if let Some(window) = app_for_main.get_webview_window("main") {
                                    log::info!(
                                        "Second instance detected, showing existing window"
                                    );
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                } else {
                                    log::info!(
                                        "Second instance detected, but window was destroyed. \
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

    #[cfg(feature = "updater")]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

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
                            log::debug!("Optimization Enabled: Destroying window to free RAM");
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

    #[cfg(all(desktop, not(feature = "flatpak")))]
    {
        builder = builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--tray"]),
        ));
    }

    builder = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init());

    #[cfg(feature = "desktop")]
    {
        builder = builder
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_shell::init())
            .plugin(tauri_plugin_clipboard_manager::init())
            .plugin(tauri_plugin_window_state::Builder::default().build());
    }

    builder = builder.setup(move |app| setup_app(app, cli_args.clone()));

    #[cfg(all(desktop, feature = "tray"))]
    {
        builder = builder.on_menu_event(|app, event| handle_tray_menu_event(app, &event));
    }

    #[cfg(not(feature = "web-server"))]
    {
        builder = builder.invoke_handler(crate::core::commands::dispatch_invoke);
    }

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    #[cfg(feature = "web-server")]
    {
        log::info!("Tauri event loop starting (Web Server Mode)");
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
                            use sysinfo::{ProcessesToUpdate, System};

                            let mut system = System::new();
                            system.refresh_processes(ProcessesToUpdate::All, true);
                            let my_pid = std::process::id();

                            for process in system.processes().values() {
                                let name = process.name().to_string_lossy();
                                if (name.contains("WebKitNetwork") || name.contains("WebKitWeb"))
                                    && process.parent().map(sysinfo::Pid::as_u32) == Some(my_pid)
                                {
                                    let _ = process.kill();
                                }
                            }
                        });
                    }
                }
            }
        });
    }
}

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

    app.manage(app_paths);
    app.manage(backend_manager);
    app.manage(env_manager);
    app.manage(rcman_manager);

    app.manage(tokio::sync::Mutex::new(RcApiEngine::default()));

    let transport: Arc<dyn crate::rclone::backend::RcloneTransport> = {
        log::info!("rclone transport: RoutingTransport (dynamic)");
        Arc::new(rclone::backend::routing_transport::RoutingTransport::new(
            app_handle.clone(),
        ))
    };

    app.manage(RcloneState {
        client: reqwest::Client::new(),
        transport,
        is_shutting_down: AtomicBool::new(false),
        #[cfg(not(feature = "librclone"))]
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

    #[cfg(feature = "updater")]
    app.manage(utils::types::updater::AppUpdaterState::default());
    #[cfg(feature = "updater")]
    app.manage(utils::types::updater::RcloneUpdaterState::default());

    #[cfg(all(desktop, feature = "tray"))]
    app.manage(crate::core::tray::TrayMenuState::default());

    let history_cache = AlertHistoryCache::new(10000);
    app.manage(history_cache);

    let alert_cache = core::alerts::cache::AlertRuleCache::new(
        app.state::<core::settings::AppSettingsManager>().inner(),
    );
    app.manage(alert_cache);

    let app_handle_clone = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        initialization(app_handle_clone).await;
    });

    #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        app.deep_link().register_all()?;
    }

    #[cfg(feature = "web-server")]
    {
        use crate::server::start_web_server;

        let web_handle = app.handle().clone();
        let args = cli_args.clone();

        log::info!(
            "Initializing Web Server on {}:{}...",
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
                        "Port {} is already in use — another instance may be running. \
                         Shutting down.",
                        args.headless.port
                    );
                } else {
                    log::error!("Web server failed to start: {e:#}");
                }
                web_handle.exit(1);
            }
        });
    }

    #[cfg(all(desktop, not(feature = "web-server"), feature = "tray"))]
    if !cli_args.general.tray && cli_args.general.send_to_remote.is_none() {
        log::debug!("Creating main window");
        utils::app::builder::create_app_window(app.handle().clone());
    }

    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        log::debug!("Creating main window on mobile");
        let _window =
            tauri::WebviewWindowBuilder::new(app.handle(), "main", tauri::WebviewUrl::default())
                .build()
                .expect("Failed to build mobile main window");
    }

    if cli_args.general.send_to_remote.is_some() {
        let app_handle_clone = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            let mut engine_ready = false;
            for _ in 0..100 {
                let status =
                    crate::rclone::engine::lifecycle::get_engine_status(&app_handle_clone).await;
                if status.running {
                    engine_ready = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }

            if !engine_ready {
                log::error!("SendTo failed: Rclone engine failed to start in time");
                app_handle_clone.exit(1);
                return;
            }

            if let Some(remote) = cli_args.general.send_to_remote {
                let path = cli_args.general.send_to_path;
                let sources = cli_args.general.send_to_sources;
                let params = build_send_to_params(remote, path, sources, None);

                log::info!(
                    "Executing SendTo transfer: {:?} -> {}:{}",
                    params.local_paths,
                    params.remote,
                    params.path
                );

                match execute_upload_batch(app_handle_clone.clone(), params).await {
                    Ok(jobid) => {
                        log::info!("SendTo transfer completed successfully. Job ID: {jobid}");
                    }
                    Err(e) => {
                        log::error!("SendTo transfer failed: {e}");
                    }
                }
            }
            app_handle_clone.exit(0);
        });
    }

    #[cfg(target_os = "macos")]
    crate::utils::app::platform::update_macos_dock_visibility(app.handle());

    Ok(())
}

#[cfg(all(desktop, feature = "tray"))]
fn handle_tray_menu_event(app: &tauri::AppHandle, event: &tauri::menu::MenuEvent) {
    if let Some(action) = TrayAction::from_id(event.id.as_ref()) {
        dispatch_tray_action(app, action);
    }
}

#[cfg(all(desktop, feature = "tray"))]
fn dispatch_tray_action(app: &tauri::AppHandle, action: TrayAction) {
    use crate::utils::types::remotes::OperationType;

    #[cfg(feature = "web-server")]
    use tauri_plugin_opener::OpenerExt;

    match action {
        TrayAction::StartProfile(op, remote, profile) => match op {
            OperationType::Mount => {
                handle_mount_profile(app.clone(), &remote, &profile);
            }
            OperationType::Serve => {
                handle_serve_profile(app.clone(), &remote, &profile);
            }
            op if op.is_transfer() => {
                handle_start_job_profile(app.clone(), &remote, &profile, op);
            }
            _ => {}
        },
        TrayAction::StopProfile(op, remote, profile) => match op {
            OperationType::Mount => {
                handle_unmount_profile(app.clone(), &remote, &profile);
            }
            OperationType::Serve => {
                handle_stop_serve_profile(app.clone(), &profile);
            }
            op if op.is_transfer() => {
                if let Some(job_type) = op.as_job_type() {
                    handle_stop_job_profile(app.clone(), &remote, &profile, job_type);
                }
            }
            _ => {}
        },
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
