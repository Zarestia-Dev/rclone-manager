use crate::{
    core::{
        self, alerts::AlertHistoryCache, automation::engine::AutomationScheduler,
        initialization::initialization, paths::AppPaths,
    },
    rclone::{self, state::automations::AutomationsCache},
    utils::{
        context::Manager,
        types::{
            logs::LogCache,
            state::{RcApiEngine, RcloneState},
        },
    },
};
use std::sync::{Arc, atomic::AtomicBool};

pub(super) fn setup_context(
    app: &crate::utils::context::AppHandle,
    cli_args: crate::core::cli::CliArgs,
) -> Result<(), Box<dyn std::error::Error>> {
    let app_handle = app;

    let event_bridge = Arc::new(crate::core::bridge::EventBridge::new(1000));
    crate::core::bridge::init_event_bridge(event_bridge.clone());
    #[cfg(any(not(feature = "web-server"), feature = "tray"))]
    event_bridge.set_app_handle(app_handle.clone());
    app.manage(event_bridge.clone());

    let app_paths = AppPaths::setup(app_handle)?;

    #[cfg(target_os = "android")]
    {
        unsafe {
            std::env::set_var("HOME", &app_paths.config_dir);
            std::env::set_var("XDG_CONFIG_HOME", &app_paths.config_dir);
            std::env::set_var("XDG_CACHE_HOME", &app_paths.cache_dir);
            std::env::set_var("TMPDIR", &app_paths.cache_dir);
            std::env::set_var("TMP", &app_paths.cache_dir);
        }
    }

    // Clean up temporary file preview/viewer cache from previous sessions
    #[cfg(not(feature = "web-server"))]
    crate::utils::io::file_helper::cleanup_temp_views(app_handle);

    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        log::debug!("Creating main window on mobile");
        tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default()).build()?;
    }

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

    app.manage(crate::utils::types::updater::AppUpdaterState::default());
    #[cfg(not(feature = "librclone"))]
    app.manage(crate::utils::types::updater::RcloneUpdaterState::default());
    app.manage(crate::utils::types::provision::ProvisionState::default());

    #[cfg(all(
        feature = "desktop",
        not(any(target_os = "android", target_os = "ios"))
    ))]
    app.manage(crate::core::power::PowerInhibitorState::new());

    #[cfg(all(desktop, feature = "tray"))]
    app.manage(crate::core::tray::TrayMenuState::default());

    let history_cache = AlertHistoryCache::new(10000);
    app.manage(history_cache);

    let alert_cache = core::alerts::cache::AlertRuleCache::new(
        app.state::<core::settings::AppSettingsManager>().inner(),
    );
    app.manage(alert_cache);

    let app_handle_clone = app_handle.clone();
    crate::utils::spawn(async move {
        initialization(app_handle_clone).await;
    });

    #[cfg(all(
        feature = "tauri-plugin-deep-link",
        any(
            all(
                target_os = "linux",
                not(feature = "flatpak"),
                not(feature = "web-server")
            ),
            all(debug_assertions, windows)
        )
    ))]
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        app.deep_link().register_all()?;
    }

    #[cfg(feature = "web-server")]
    super::server::start(app, &cli_args, &event_bridge);

    #[cfg(all(desktop, not(feature = "web-server")))]
    if super::window::should_open_main_window(&cli_args.general) {
        log::debug!("Creating main window");
        crate::utils::app::builder::create_app_window(app.clone());
    }

    super::send_to::start(app, cli_args);

    #[cfg(all(target_os = "macos", feature = "native-tauri"))]
    crate::utils::app::platform::update_macos_dock_visibility(app);

    Ok(())
}
