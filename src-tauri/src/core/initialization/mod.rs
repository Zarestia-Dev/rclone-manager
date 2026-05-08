/// Initialization submodules
pub mod apply_settings;
pub mod bootstrap;
pub mod scheduler;

use crate::core::cli::CliArgs;
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
    debug!("🚀 Starting async startup tasks");

    // Phase 0: Core Setup (Logging, i18n, Security, Migrations)
    // These were moved from synchronous setup_app to prevent UI blocking
    if let Err(e) = async_core_setup(&app_handle).await {
        error!("🔥 Phase 0 Core Setup failed: {e}");
        let _ = app_handle.emit(
            APP_EVENT,
            json!({ "status": "startup_failed", "message": e.to_string() }),
        );
        return;
    }

    // Phase 1: Bootstrap (State, Events, Environment, Engine, Alerts, Network)
    if let Err(e) = bootstrap::init_all(&app_handle).await {
        error!("🔥 Phase 1 Bootstrap failed: {e}");
        let _ = app_handle.emit(
            APP_EVENT,
            json!({ "status": "startup_failed", "message": e.to_string() }),
        );
        return;
    }

    // Phase 2: Connectivity (Health check & Fallback)
    info!("🔍 Phase 2: Checking backend connectivity...");
    check_active_backend_connectivity(&app_handle).await;

    // Phase 3: Data (Cache hydration & Defaults)
    if let Err(e) = initialize_caches(&app_handle).await {
        error!("⚠️ Phase 3 Data hydration failed: {e}");
    }

    // Phase 4: Services (Long-running logic)
    info!("⏰ Phase 4: Starting services...");

    // Scheduler
    if let Err(e) = scheduler::initialize_scheduler(app_handle.clone()).await {
        error!("❌ Failed to initialize cron scheduler: {e}");
    }

    // Auto Updater
    #[cfg(desktop)]
    crate::core::lifecycle::auto_updater::init_auto_updater(app_handle.clone());

    // Phase 5: Runtime Application
    info!("🎉 Phase 5: Applying runtime settings");
    let settings_manager = app_handle.state::<AppSettingsManager>();
    let cli_args = app_handle.state::<CliArgs>();

    if let Ok(settings) = settings_manager.get_all() {
        apply_settings::apply_core_settings(&app_handle, &settings).await;

        // Tray Setup (Moved from lib.rs)
        #[cfg(feature = "tray")]
        {
            let force_tray = cli_args.general.tray;
            if (settings.general.tray_enabled || force_tray)
                && let Err(e) = crate::utils::app::builder::setup_tray(app_handle.clone()).await
            {
                error!("Failed to setup tray: {e}");
            }
        }
    }

    // Phase 6: Post-Initialization Tasks
    info!("🚀 Phase 6: Running post-initialization tasks");
    handle_startup(app_handle.clone()).await;

    info!("🎉 Initialization complete");

    // Enable engine health monitoring now that startup is complete
    crate::rclone::engine::lifecycle::mark_startup_complete(&app_handle);
}

/// Fully refreshes all system components after settings change or restore.
#[tauri::command]
pub async fn refresh_system(app_handle: AppHandle) -> Result<(), String> {
    info!("🔄 Initiating full system refresh...");

    let manager = app_handle.state::<AppSettingsManager>();

    // Invalidate manager cache so it reads fresh from disk (essential after restore)
    manager.invalidate_cache();
    let settings = manager.get_all().map_err(|e| e.to_string())?;

    // Re-bootstrap (Reload Backends & Security Environment)
    // We don't call bootstrap::init_all because we don't want to re-setup event listeners
    let backend_manager = app_handle.state::<BackendManager>();
    backend_manager
        .load_from_settings(manager.inner())
        .await
        .map_err(|e| format!("Failed to reload backends: {e}"))?;

    use crate::core::security::SafeEnvironmentManager;
    if let Some(env_manager) = app_handle.try_state::<SafeEnvironmentManager>() {
        let _ = env_manager.init_with_stored_credentials(manager.inner());
    }

    // Refresh Caches (Remote Caches & Alerts)
    initialize_caches(&app_handle).await?;

    // Reload Scheduler (from remote configs)
    let remote_names = backend_manager.remote_cache.get_remotes().await;
    let all_configs = crate::core::settings::remote::manager::get_all_remote_settings_sync(
        manager.inner(),
        &remote_names,
    );
    if let Err(e) = crate::core::scheduler::commands::reload_scheduled_tasks_from_configs(
        app_handle.clone(),
        all_configs,
    )
    .await
    {
        error!("⚠️ Failed to reload scheduled tasks: {e}");
    }

    // Apply Core Settings (bandwidth limits, backend options, language, log level)
    apply_settings::apply_core_settings(&app_handle, &settings).await;

    // Tray update
    #[cfg(feature = "tray")]
    {
        use crate::core::tray::core::update_tray_menu;
        let _ = update_tray_menu(app_handle.clone()).await;
    }

    // Inform frontend to reload all settings
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

    info!("✅ System successfully refreshed");
    Ok(())
}

/// Phase 3: Data - Hydrates caches and ensures defaults
async fn initialize_caches(app_handle: &AppHandle) -> Result<(), String> {
    info!("📊 Phase 3: Refreshing caches...");

    // 1. Refresh Remote Caches (remotes, configs, mounts, serves)
    let backend_manager = app_handle.state::<BackendManager>();
    if let Err(e) = backend_manager
        .remote_cache
        .refresh_all(app_handle.clone())
        .await
    {
        error!("❌ Failed to refresh backend caches: {e}");
        return Err(e);
    }
    debug!("✅ Refreshed backend caches");

    // 2. Seed default values (alerts, etc.)
    let manager = app_handle.state::<AppSettingsManager>();
    if let Err(e) = crate::core::alerts::seed::seed_defaults(manager.inner()) {
        error!("⚠️ Failed to seed alert defaults: {e}");
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

    // Skip redundant check for Local backend since engine already waits for API readiness
    let active_name = backend_manager.get_active_name().await;
    let client = app_handle.state::<RcloneState>().client.clone();

    if active_name == "Local" {
        info!(
            "⏭️ Skipping redundant Local backend connectivity check (already verified during engine startup)"
        );
        backend_manager
            .set_runtime_status(
                "Local",
                crate::rclone::backend::runtime::RuntimeStatus::Connected,
            )
            .await;
    } else {
        // For remote backends, check connectivity with automatic fallback
        if let Err(e) = crate::rclone::backend::connectivity::ensure_connectivity_or_fallback(
            &backend_manager,
            &client,
            BACKEND_CONNECTIVITY_TIMEOUT,
        )
        .await
        {
            error!("🔥 Critical startup failure: {e}");
        }
    }

    // Spawn background task to check other backends (non-blocking)
    let app_handle_clone = app_handle.clone();
    tokio::spawn(async move {
        let backend_manager = app_handle_clone.state::<BackendManager>();
        let client = app_handle_clone.state::<RcloneState>().client.clone();
        crate::rclone::backend::connectivity::check_other_backends(&backend_manager, &client).await;
    });
}

/// Phase 0: Core Setup - Initializes logging, i18n, security, and runs migrations asynchronously.
async fn async_core_setup(app_handle: &AppHandle) -> Result<(), String> {
    info!("⚙️ Phase 0: Initializing core services...");

    let app_paths = crate::core::paths::AppPaths::from_app_handle(app_handle)?;
    let rcman_manager = app_handle.state::<AppSettingsManager>();

    // 1. Run Keyring Migrations (Keyring access - SLOW)
    #[cfg(desktop)]
    {
        debug!("🔐 Running keyring migrations...");
        crate::core::settings::migration::migrate_keyring_credentials(rcman_manager.inner());
    }

    // 2. Load Settings (Disk I/O)
    let settings = rcman_manager
        .get_all()
        .map_err(|e| format!("Failed to load settings during Phase 0: {e}"))?;

    // 3. Initialize Environment Manager (Keyring access - SLOW)
    use crate::core::security::SafeEnvironmentManager;
    if let Some(env_manager) = app_handle.try_state::<SafeEnvironmentManager>() {
        debug!("🔐 Initializing environment manager credentials...");
        if let Err(e) = env_manager.init_with_stored_credentials(rcman_manager.inner()) {
            error!("Failed to initialize environment manager: {e}");
        }
    }

    // 4. Initialize Backend i18n (Disk I/O)
    debug!("🌐 Initializing i18n...");
    crate::utils::i18n::init(app_paths.resource_dir);
    crate::utils::i18n::set_language(&settings.general.language);

    // 5. Initialize Logging (Disk I/O)
    debug!("📝 Initializing logging...");
    crate::utils::logging::log::init_logging(&settings.developer.log_level, app_handle.clone())
        .map_err(|e| format!("Failed to initialize logging: {e}"))?;

    info!("✅ Phase 0 Core Setup complete");
    Ok(())
}
