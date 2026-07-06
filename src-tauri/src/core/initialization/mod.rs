/// Initialization submodules
pub mod apply_settings;
pub mod automation;
pub mod bootstrap;

use crate::core::lifecycle::startup::handle_startup;
use crate::core::settings::AppSettingsManager;
use crate::rclone::backend::BackendManager;
use crate::utils::types::events::{APP_EVENT, SYSTEM_SETTINGS_CHANGED};
use crate::utils::types::state::RcloneState;
use log::{debug, error, info};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

/// Handles async startup tasks using a phased approach
pub async fn initialization(app_handle: tauri::AppHandle) {
    debug!("Starting async startup tasks");

    if let Err(e) = async_core_setup(&app_handle).await {
        error!("Phase 0 Core Setup failed: {e}");
        let _ = app_handle.emit(
            APP_EVENT,
            json!({ "status": "startup_failed", "message": e.clone() }),
        );
        return;
    }

    if let Err(e) = bootstrap::init_all(&app_handle).await {
        error!("Phase 1 Bootstrap failed: {e}");
        let _ = app_handle.emit(
            APP_EVENT,
            json!({ "status": "startup_failed", "message": e.clone() }),
        );
        return;
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
    crate::core::lifecycle::auto_updater::init_auto_updater(app_handle.clone());

    info!("Phase 5: Applying runtime settings");
    let settings_manager = app_handle.state::<AppSettingsManager>();

    if let Ok(settings) = settings_manager.get_all() {
        apply_settings::apply_core_settings(&app_handle, &settings).await;

        #[cfg(feature = "tray")]
        {
            let cli_args = app_handle.state::<crate::core::cli::CliArgs>();
            let force_tray = cli_args.general.tray;
            if (settings.general.tray_enabled || force_tray)
                && let Err(e) = crate::utils::app::builder::setup_tray(app_handle.clone()).await
            {
                error!("Failed to setup tray: {e}");
            }
        }
    }

    info!("Phase 6: Running post-initialization tasks");
    handle_startup(app_handle.clone()).await;

    info!("Initialization complete");

    crate::rclone::engine::lifecycle::mark_startup_complete(&app_handle);
}

/// Fully refreshes all system components after settings change or restore.
#[tauri::command]
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

    use crate::core::security::SafeEnvironmentManager;
    if let Some(env_manager) = app_handle.try_state::<SafeEnvironmentManager>() {
        let _ = env_manager.init_with_stored_credentials(manager.inner());
    }

    initialize_caches(&app_handle).await?;

    let remote_names = backend_manager.remote_cache.get_remotes().await;
    let all_configs = crate::core::settings::remote::manager::get_all_remote_settings_sync(
        manager.inner(),
        &remote_names,
    );
    if let Err(e) = crate::core::automation::commands::reload_automations_from_configs(
        app_handle.clone(),
        all_configs,
    )
    .await
    {
        error!("Failed to reload automations: {e}");
    }

    apply_settings::apply_core_settings(&app_handle, &settings).await;

    #[cfg(feature = "tray")]
    {
        use crate::core::tray::core::update_tray_menu;
        let _ = update_tray_menu(app_handle.clone()).await;
    }

    app_handle
        .emit(
            SYSTEM_SETTINGS_CHANGED,
            crate::utils::types::events::SettingsChangeEvent {
                category: "*".to_string(),
                key: "*".to_string(),
                value: serde_json::Value::Null,
            },
        )
        .ok();

    info!("System successfully refreshed");
    Ok(())
}

/// Phase 3: Data - Hydrates caches and ensures defaults
async fn initialize_caches(app_handle: &AppHandle) -> Result<(), String> {
    info!("Phase 3: Refreshing caches...");

    let backend_manager = app_handle.state::<BackendManager>();
    if let Err(e) = backend_manager
        .remote_cache
        .refresh_all(app_handle.clone())
        .await
    {
        error!("Failed to refresh backend caches: {e}");
        return Err(e);
    }
    debug!("Refreshed backend caches");

    let manager = app_handle.state::<AppSettingsManager>();
    if let Err(e) = crate::core::alerts::seed::seed_defaults(manager.inner()) {
        error!("Failed to seed alert defaults: {e}");
    } else {
        let alert_cache = app_handle.state::<crate::core::alerts::cache::AlertRuleCache>();
        alert_cache.reload_rules(manager.inner()).await;
        alert_cache.reload_actions(manager.inner()).await;
        info!("Alert defaults seeded and cache reloaded");
    }

    Ok(())
}

/// Timeout for backend connectivity checks (10 seconds)
/// After this timeout, the app will fallback to Local backend
const BACKEND_CONNECTIVITY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Phase 2: Connectivity - Check if the active backend is reachable; fallback to Local if not.
/// Also spawns background checks for other backends.
async fn check_active_backend_connectivity(app_handle: &tauri::AppHandle) {
    let backend_manager = app_handle.state::<BackendManager>();

    let active_name = backend_manager.get_active_name().await;
    let transport = app_handle.state::<RcloneState>().transport.clone();

    if active_name == "Local" {
        info!(
            "Skipping redundant Local backend connectivity check (already verified during engine startup)"
        );
        backend_manager
            .set_runtime_status(
                "Local",
                crate::rclone::backend::runtime::RuntimeStatus::Connected,
            )
            .await;
    } else if let Err(e) = crate::rclone::backend::connectivity::ensure_connectivity(
        &backend_manager,
        &*transport,
        BACKEND_CONNECTIVITY_TIMEOUT,
    )
    .await
    {
        error!("Critical startup failure: {e}");
    }

    let app_handle_clone = app_handle.clone();
    tokio::spawn(async move {
        let backend_manager = app_handle_clone.state::<BackendManager>();
        let transport = app_handle_clone.state::<RcloneState>().transport.clone();
        crate::rclone::backend::connectivity::check_other_backends(&backend_manager, &*transport)
            .await;
    });
}

/// Phase 0: Core Setup - Initializes logging, i18n, security, and runs migrations asynchronously.
async fn async_core_setup(app_handle: &AppHandle) -> Result<(), String> {
    info!("Phase 0: Initializing core services...");

    let app_paths = crate::core::paths::AppPaths::from_app_handle(app_handle)?;
    let rcman_manager = app_handle.state::<AppSettingsManager>();

    #[cfg(desktop)]
    {
        crate::core::settings::migration::migrate_keyring_credentials(rcman_manager.inner());
    }

    let settings = rcman_manager
        .get_all()
        .map_err(|e| format!("Failed to load settings during Phase 0: {e}"))?;

    use crate::core::security::SafeEnvironmentManager;
    if let Some(env_manager) = app_handle.try_state::<SafeEnvironmentManager>() {
        debug!("Initializing environment manager credentials...");
        if let Err(e) = env_manager.init_with_stored_credentials(rcman_manager.inner()) {
            error!("Failed to initialize environment manager: {e}");
        }
    }

    crate::utils::i18n::init(app_paths.resource_dir);
    crate::utils::i18n::set_language(&settings.general.language);

    debug!("Initializing logging...");
    crate::utils::logging::log::init_logging(&settings.developer.log_level, app_handle.clone())
        .map_err(|e| format!("Failed to initialize logging: {e}"))?;

    info!("Phase 0 Core Setup complete");
    Ok(())
}
