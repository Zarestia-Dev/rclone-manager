/// Initialization submodules
pub mod apply_settings;
pub mod automation;
pub mod bootstrap;

use crate::context::AppHandle;
use crate::rclone::backend::BackendManager;
use crate::services::bridge;
use crate::services::lifecycle::startup::handle_startup;
use crate::services::security::SafeEnvironmentManager;
use crate::services::settings::AppSettingsManager;
use crate::utils::types::events::{APP_EVENT, SYSTEM_SETTINGS_CHANGED};
use crate::utils::types::state::RcloneState;
use log::{debug, error, info};
use serde_json::json;

/// Handles async startup tasks using a phased approach
pub async fn initialization(app_handle: crate::context::AppHandle) -> Result<(), String> {
    let state = app_handle.state::<RcloneState>();
    let _startup = state.initialization_lock.lock().await;
    if state.is_shutting_down()
        || !state
            .initial_startup
            .load(std::sync::atomic::Ordering::Acquire)
    {
        return Ok(());
    }
    debug!("Starting async startup tasks");

    let settings_manager = app_handle.state::<AppSettingsManager>();
    if settings_manager.is_locked() {
        info!(
            "Configuration vault is locked. Postponing background initialization until unlocked."
        );
        crate::utils::i18n::init();
        crate::utils::i18n::set_language(crate::utils::i18n::DEFAULT_LANG);
        crate::utils::logging::log::init_logging("info", app_handle.clone())?;
        return Ok(());
    }

    if let Err(e) = async_core_setup(&app_handle).await {
        error!("Phase 0 Core Setup failed: {e}");
        bridge::emit(
            APP_EVENT,
            json!({ "status": "startup_failed", "message": e.clone() }),
        );
        return Err(e);
    }

    if let Err(e) = bootstrap::init_all(&app_handle).await {
        error!("Phase 1 Bootstrap failed: {e}");
        bridge::emit(
            APP_EVENT,
            json!({ "status": "startup_failed", "message": e.clone() }),
        );
        return Err(e);
    }

    info!("Phase 2: Checking backend connectivity...");
    check_active_backend_connectivity(&app_handle).await;

    if let Err(e) = initialize_caches(&app_handle).await {
        error!("Phase 3 Data hydration failed: {e}");
    }

    info!("Phase 4: Starting services...");

    if let Err(e) = automation::initialize_automations(app_handle.clone()).await {
        error!("Failed to initialize automations: {e}");
    }

    #[cfg(feature = "updater")]
    crate::services::lifecycle::auto_updater::init_auto_updater(app_handle.clone());

    info!("Phase 5: Applying runtime settings");
    let settings_manager = app_handle.state::<AppSettingsManager>();

    if let Ok(settings) = settings_manager.get_all() {
        apply_settings::apply_core_settings(&app_handle, &settings).await;

        #[cfg(feature = "tray")]
        {
            if let Err(e) = app_handle.host().setup_tray().await {
                error!("Failed to setup tray: {e}");
            }
        }
    }

    info!("Phase 6: Running post-initialization tasks");
    handle_startup(app_handle.clone()).await;

    crate::rclone::engine::lifecycle::mark_startup_complete(&app_handle);

    info!("Initialization complete");
    if settings_manager.is_vault_enabled() {
        crate::services::settings::vault::emit_vault_state(settings_manager.inner(), "unlocked");
    }
    Ok(())
}

/// Fully refreshes all system components after settings change or restore.
pub async fn refresh_system(app_handle: AppHandle) -> Result<(), String> {
    info!("Initiating full system refresh...");

    let manager = app_handle.state::<AppSettingsManager>();

    manager.invalidate_cache();
    let settings = manager.get_all().map_err(|e| e.to_string())?;

    let backend_manager = app_handle.state::<BackendManager>();
    backend_manager
        .load_from_settings(manager.inner())
        .await
        .map_err(|e| format!("Failed to reload backends: {e}"))?;

    if let Some(env_manager) = app_handle.try_state::<SafeEnvironmentManager>() {
        let _ = env_manager.init_with_stored_credentials(manager.inner());
    }

    initialize_caches(&app_handle).await?;

    if let Err(e) =
        crate::services::automation::commands::reload_automations_from_configs(&app_handle).await
    {
        error!("Failed to reload automations: {e}");
    }

    crate::services::flow::quick_run::commands::sync_quick_run_automations(&app_handle).await?;

    apply_settings::apply_core_settings(&app_handle, &settings).await;

    bridge::emit(crate::utils::types::events::UPDATE_TRAY_MENU, ());

    bridge::emit(crate::utils::types::events::REMOTE_SETTINGS_CHANGED, ());
    bridge::emit(
        SYSTEM_SETTINGS_CHANGED,
        crate::utils::types::events::SettingsChangeEvent {
            category: "*".to_string(),
            key: "*".to_string(),
            value: serde_json::Value::Null,
        },
    );

    info!("System successfully refreshed");
    Ok(())
}

/// Phase 3: Data - Hydrates caches and ensures defaults
async fn initialize_caches(app_handle: &AppHandle) -> Result<(), String> {
    info!("Phase 3: Refreshing caches...");

    let backend_manager = app_handle.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    if let Err(e) = backend_manager
        .remote_cache_for(&backend.name)
        .refresh_all(app_handle.clone(), &backend)
        .await
    {
        error!("Failed to refresh backend caches: {e}");
        return Err(e);
    }
    debug!("Refreshed backend caches");

    let manager = app_handle.state::<AppSettingsManager>();
    #[cfg(feature = "notifications")]
    if let Err(e) = crate::services::alerts::seed::seed_defaults(manager.inner()) {
        error!("Failed to seed alert defaults: {e}");
    }

    let alert_cache = app_handle.state::<crate::services::alerts::cache::AlertRuleCache>();
    alert_cache.reload_rules(manager.inner()).await;
    alert_cache.reload_actions(manager.inner()).await;
    debug!("Alert rules and actions loaded");

    Ok(())
}

const BACKEND_CONNECTIVITY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

async fn check_active_backend_connectivity(app_handle: &crate::context::AppHandle) {
    let backend_manager = app_handle.state::<BackendManager>();

    let active_name = backend_manager.get_active_name().await;

    if crate::rclone::backend::types::Backend::is_local_name(&active_name) {
        info!(
            "Skipping redundant Local backend connectivity check (already verified during engine startup)"
        );
        backend_manager
            .set_runtime_status(
                crate::utils::constants::LOCAL_BACKEND_NAME,
                crate::rclone::backend::runtime::RuntimeStatus::Connected,
            )
            .await;
    } else {
        info!(
            "Active backend '{active_name}' is remote — spawning connectivity probe in background so UI can load immediately"
        );
        let app_clone = app_handle.clone();
        crate::utils::spawn(async move {
            let backend_manager = app_clone.state::<BackendManager>();
            let transport = app_clone.state::<RcloneState>().transport.clone();
            if let Err(e) = crate::rclone::backend::connectivity::ensure_connectivity(
                &backend_manager,
                &*transport,
                BACKEND_CONNECTIVITY_TIMEOUT,
            )
            .await
            {
                error!("Remote backend connectivity check failed: {e}");
                // Status is already set to Error(_) inside ensure_connectivity.
            } else {
                info!("Remote backend connectivity check completed");
            }
        });
    }

    let app_handle_clone = app_handle.clone();
    crate::utils::spawn(async move {
        let backend_manager = app_handle_clone.state::<BackendManager>();
        let transport = app_handle_clone.state::<RcloneState>().transport.clone();
        crate::rclone::backend::connectivity::check_other_backends(&backend_manager, &*transport)
            .await;
    });
}

/// Phase 0: Core Setup - Initializes logging, i18n, and security.
async fn async_core_setup(app_handle: &AppHandle) -> Result<(), String> {
    info!("Phase 0: Initializing core services...");

    let rcman_manager = app_handle.state::<AppSettingsManager>();

    let settings = rcman_manager
        .get_all()
        .map_err(|e| format!("Failed to load settings during Phase 0: {e}"))?;

    if let Some(env_manager) = app_handle.try_state::<SafeEnvironmentManager>() {
        debug!("Initializing environment manager credentials...");
        if let Err(e) = env_manager.init_with_stored_credentials(rcman_manager.inner()) {
            error!("Failed to initialize environment manager: {e}");
        }
    }
    crate::utils::i18n::init();
    crate::utils::i18n::set_language(&settings.general.language);

    debug!("Initializing logging...");
    crate::utils::logging::log::init_logging(&settings.developer.log_level, app_handle.clone())
        .map_err(|e| format!("Failed to initialize logging: {e}"))?;

    info!("Phase 0 Core Setup complete");
    Ok(())
}
