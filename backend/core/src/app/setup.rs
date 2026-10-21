use crate::{
    rclone::{self, state::automations::AutomationsCache},
    services::{
        self, alerts::AlertHistoryCache, automation::engine::AutomationScheduler,
        initialization::initialization, paths::AppPaths,
    },
    utils::types::{
        logs::LogCache,
        state::{RcApiEngine, RcloneState},
    },
};
use std::sync::{Arc, atomic::AtomicBool};

pub fn setup_context(
    app: &crate::context::AppHandle,
    event_sink: Option<Arc<dyn crate::services::bridge::event::EventSink>>,
) -> Result<(), Box<dyn std::error::Error>> {
    let app_handle = app;
    #[cfg(feature = "updater")]
    app.manage(services::updates::health::StartupHealth::default());

    let event_bridge = Arc::new(crate::services::bridge::EventBridge::new(1000, event_sink));
    crate::services::bridge::init_event_bridge(event_bridge.clone());
    app.manage(event_bridge.clone());

    let app_paths = AppPaths::setup(app_handle)?;

    #[cfg(feature = "librclone")]
    rclone::backend::rclone_ffi::configure_default_paths(
        &app_paths.config_dir.join("rclone.conf"),
        &app_paths.cache_dir,
    )?;

    app.host().prepare(app, &app_paths)?;

    let rcman_manager =
        crate::services::settings::manager::create_settings_manager(&app_paths.config_dir)?;

    let access = Arc::new(services::settings::access::VaultAccess::new(
        &app_paths.config_dir,
        &rcman_manager,
    )?);
    event_bridge.set_frontend_access(access.clone());
    app.manage(access.clone());
    let vault_app = app_handle.clone();
    rcman_manager.events().on_vault_event(move |event| {
        if matches!(
            event,
            rcman::vault::VaultEvent::Locked | rcman::vault::VaultEvent::AutoLocked
        ) {
            access.lock();
            services::settings::vault::emit_vault_state(&vault_app, &event.to_string());
            if matches!(event, rcman::vault::VaultEvent::AutoLocked) {
                let app = vault_app.clone();
                // The callback can run inside a cache read; avoid re-entering it.
                crate::utils::spawn_blocking(move || {
                    if let Some(manager) = app.try_state::<services::settings::AppSettingsManager>()
                    {
                        manager.invalidate_cache();
                    }
                });
            }
        }
    });

    use crate::services::security::SafeEnvironmentManager;
    let env_manager = SafeEnvironmentManager::new();

    use crate::rclone::backend::BackendManager;
    let backend_manager = BackendManager::new();

    app.manage(backend_manager);
    app.manage(env_manager);
    let backup_provider =
        services::settings::backup::rclone_config_provider::RcloneConfigProvider::default();
    rcman_manager.register_external_provider(Box::new(backup_provider.clone()));
    app.manage(backup_provider);
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
        initialization_lock: tokio::sync::Mutex::new(()),
        vault_operation_lock: tokio::sync::Mutex::new(()),
        updater_running: AtomicBool::new(false),
    });

    app.manage(LogCache::new(1000));
    app.manage(AutomationsCache::new());
    app.manage(services::automation::runtime::RuntimeTasks::default());
    app.manage(AutomationScheduler::new());
    app.manage(crate::services::automation::watcher::WatcherManager::new());
    app.manage(services::alerts::dispatch::DispatchContext::new());

    app.manage(crate::utils::types::updater::AppUpdaterState::default());
    #[cfg(not(feature = "librclone"))]
    app.manage(crate::utils::types::updater::RcloneUpdaterState::default());
    app.manage(crate::utils::types::provision::ProvisionState::default());

    #[cfg(all(
        feature = "desktop",
        not(any(target_os = "android", target_os = "ios"))
    ))]
    app.manage(crate::services::power::PowerInhibitorState::new());

    let history_cache = AlertHistoryCache::new(10000);
    app.manage(history_cache);

    let alert_cache = services::alerts::cache::AlertRuleCache::new(
        app.state::<services::settings::AppSettingsManager>()
            .inner(),
    );
    app.manage(alert_cache);

    let app_handle_clone = app_handle.clone();
    crate::utils::spawn(async move {
        if let Err(error) = initialization(app_handle_clone).await {
            log::error!("Application initialization failed: {error}");
        }
    });

    Ok(())
}
